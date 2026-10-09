import { randomBytes } from 'node:crypto';

// Private, short-lived playtest relay. The host phone owns the simulation.
// No accounts, wallet, database, billing, or other game state is accessed.
export function createChompRooms({ now = Date.now, maxRooms = 4 } = {}) {
  const rooms = new Map(), attempts = new Map();
  const reply = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const cleanName = value => String(value ?? 'Player').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 16) || 'Player';
  const expire = () => {
    for (const [code, room] of rooms) {
      if (now() - room.hostSeen > 12000 || now() - room.created > 3600000) { rooms.delete(code); continue; }
      for (const [token, player] of room.players) if (player.slot !== 0 && now() - player.seen > 12000) room.players.delete(token);
    }
    for (const [ip, entry] of attempts) if (now() - entry.start > 60000) attempts.delete(ip);
  };
  function validateSnapshot(s, protocol) {
    if (!s || s.protocol !== protocol || !Number.isFinite(s.elapsed) || !Array.isArray(s.fish) || s.fish.length !== (protocol>=2?65:29) || !Array.isArray(s.food) || s.food.length > (protocol===3?2400:protocol===2?6000:1800) || !Array.isArray(s.circles) || s.circles.length > 12) return false;
    if (!s.surface || !Array.isArray(s.surface.displacement) || s.surface.displacement.length !== 860 || !Array.isArray(s.surface.velocity) || s.surface.velocity.length !== 860) return false;
    const finite = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e12;
    for (let i=0;i<s.fish.length;i++) {
      const f=s.fish[i];
      if (f.id !== i || !f.position || !finite(f.position.x) || !finite(f.position.y) || !Number.isSafeInteger(f.mass) || f.mass<0 || !Number.isSafeInteger(f.capacity) || f.capacity<f.mass || f.capacity>100000000 || typeof f.name!=='string' || f.name.length>32) return false;
    }
    if(protocol>=2) {
      if(!Array.isArray(s.mines) || s.mines.length>40 || !s.mines.every(m=>Number.isSafeInteger(m.id)&&m.position&&finite(m.position.x)&&finite(m.position.y)))return false;
      if(!s.food.every(f=>Array.isArray(f)&&f.length===5&&f.every(Number.isSafeInteger)&&f[3]>0&&f[3]<=100000000&&f[4]>=0&&f[4]<=(protocol===3?8:6)))return false;
    }
    if(protocol===3 && (!['ocean','king','deathmatch','team'].includes(s.mode)||!Array.isArray(s.crownTimes)||s.crownTimes.length!==65||!s.crownTimes.every(n=>finite(n)&&n>=0&&n<=181)||s.roundResult!=null&&(typeof s.roundResult!=='string'||s.roundResult.length>64)))return false;
    return true;
  }
  async function body(req) {
    const chunks=[];let size=0;
    for await (const chunk of req) { size+=chunk.length;if(size>786432) throw new Error('Request too large');chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return async function chompRooms(req,res) {
    const path=new URL(req.url || '/', 'http://localhost').pathname;
    if (!path.startsWith('/v1/chomp/')) return false;
    expire();
    if (path==='/v1/chomp/health' && req.method==='GET') {reply(res,200,{ok:true,protocol:3,compatibleProtocols:[1,2,3],mode:'private-hosted-playtest',maxPlayers:4});return true;}
    if (req.method!=='POST') {reply(res,405,{error:'Use POST.'});return true;}
    try {
      const b=await body(req);
      if (!b || Array.isArray(b) || typeof b!=='object') throw new Error('Invalid request');
      if (path==='/v1/chomp/rooms' || path==='/v1/chomp/join') {
        const ip=req.socket.remoteAddress || 'unknown';
        const entry=attempts.get(ip) || {start:now(),count:0};
        if (entry.count++>=60 || (!attempts.has(ip) && attempts.size>=1024)) {reply(res,429,{error:'Please wait before trying another room.'});return true;}
        attempts.set(ip,entry);
        if (![1,2,3].includes(b.protocol)) {reply(res,409,{error:'Update chomp chomp.io on both phones.'});return true;}
        let room,code;
        if (path==='/v1/chomp/rooms') {
          if (rooms.size>=maxRooms) {reply(res,503,{error:'Test rooms are full. Try again shortly.'});return true;}
          do {code=randomBytes(5).toString('hex').toUpperCase();} while(rooms.has(code));
          room={protocol:b.protocol,mode:b.protocol===3&&["ocean","king","deathmatch","team"].includes(b.mode)?b.mode:"ocean",created:now(),hostSeen:now(),players:new Map(),snapshot:null,revision:0};rooms.set(code,room);
        } else {code=String(b.code||'').toUpperCase();room=rooms.get(code);}
        if (!room) {reply(res,404,{error:'That room has closed. Ask the host for a new code.'});return true;}
        if(room.protocol!==b.protocol) {reply(res,409,{error:"Update chomp chomp.io on both phones before joining this room."});return true;}
        const used=new Set([...room.players.values()].map(p=>p.slot));let slot=0;while(used.has(slot))slot++;
        if(slot>=4) {reply(res,409,{error:'This room already has four players.'});return true;}
        const token=randomBytes(32).toString('base64url');
        room.players.set(token,{slot,identity:randomBytes(8).toString("hex"),name:cleanName(b.name),skin:Math.max(0,Math.min(31,Math.floor(Number(b.skin)||0))),seen:now(),lastExchange:0,input:{x:0,y:0,boost:0,chomp:0}});
        reply(res,200,{code,token,slot,protocol:room.protocol,mode:room.mode});return true;
      }
      const code=String(b.code||'').toUpperCase(),room=rooms.get(code);
      const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1],player=room?.players.get(token);
      if (!room || !player) {reply(res,410,{error:'Room disconnected. Return to the menu and join again.'});return true;}
      if (path==='/v1/chomp/leave') {if(player.slot===0)rooms.delete(code);else room.players.delete(token);reply(res,200,{ok:true});return true;}
      if(path!=='/v1/chomp/exchange') {reply(res,404,{error:'Unknown room action.'});return true;}
      if(now()-player.lastExchange<65) {reply(res,429,{error:'Updates are arriving too quickly.'});return true;}
      player.lastExchange=now();player.seen=now();
      const input=b.input || {};
      for (const k of ['x','y','boost','chomp']) if(typeof input[k]!=='number' || !Number.isFinite(input[k])) throw new Error('Invalid controls');
      if(Math.abs(input.x)>1 || Math.abs(input.y)>1 || !Number.isSafeInteger(input.boost) || !Number.isSafeInteger(input.chomp) || input.boost<0 || input.chomp<0 || input.boost>1e9 || input.chomp>1e9) throw new Error('Invalid controls');
      // Lost/repeated packets cannot replay an ability; host consumes monotonic counters once.
      player.input={x:input.x,y:input.y,boost:Math.max(player.input.boost,input.boost),chomp:Math.max(player.input.chomp,input.chomp)};
      if(player.slot===0) {
        room.hostSeen=now();
        if(b.snapshot) {if(!validateSnapshot(b.snapshot,room.protocol)||(room.protocol===3&&b.snapshot.mode!==room.mode))throw new Error('Invalid world snapshot');room.snapshot=b.snapshot;room.revision++;}
      } else if(b.snapshot) {reply(res,403,{error:'Only the host can send the world.'});return true;}
      const players=[...room.players.values()].map(p=>({slot:p.slot,identity:p.identity,name:p.name,skin:p.skin,input:now()-p.seen>1200?{...p.input,x:0,y:0}:p.input}));
      reply(res,200,{revision:room.revision,players,snapshot:player.slot===0?null:room.snapshot});return true;
    } catch(error) {reply(res,400,{error:'Invalid or oversized room request.'});return true;}
  };
}
