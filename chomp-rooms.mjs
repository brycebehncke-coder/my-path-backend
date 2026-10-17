import { randomBytes } from 'node:crypto';

export const CHOMP_RULESET = Object.freeze({protocol:6,id:'chomp-team-v2',catalog:2,maximumSkin:39,competitiveJoinSeconds:30});
const LEGACY_RULESET=Object.freeze({...CHOMP_RULESET,protocol:5,id:'chomp-quarter-v1'});
const rulesFor=protocol=>protocol===6?CHOMP_RULESET:protocol===5?LEGACY_RULESET:null;

// Private and public, short-lived playtest relay. The host phone owns the simulation.
// No accounts, wallet, database, billing, or other game state is accessed.
export function createChompRooms({ now = Date.now, maxRooms = 4 } = {}) {
  const rooms = new Map(), attempts = new Map(), queue = new Map(), admissions = new Map();
  const admissionLifetime=120000, maximumAdmissions=256;
  const modes=["ocean","king","deathmatch","team"], interval=30000;
  const nextStart=()=>Math.floor(now()/interval)*interval+interval;
  const reply = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const cleanName = value => Array.from(String(value ?? 'Player').replace(/[\x00-\x1f\x7f]/g, '').trim()).slice(0, 16).join('') || 'Player';
  const expire = () => {
    for (const [code, room] of rooms) {
      if(room.protocol===6&&room.finalizedAt!=null) {
        if(now()-room.finalizedAt>60000||room.players.size===0)rooms.delete(code);
        continue;
      }
      if (now() - room.hostSeen > 12000 || now() - room.created > 3600000) { rooms.delete(code); continue; }
      for (const [token, player] of room.players) if (player.slot !== 0 && now() - player.seen > 12000) removePlayer(room,token);
    }
    for (const [requestID, entry] of admissions) if(now()-entry.created>admissionLifetime)admissions.delete(requestID);
    for (const [token, entry] of queue) if(now()-entry.seen>12000)queue.delete(token);
    for (const [ip, entry] of attempts) if (now() - entry.start > 60000) attempts.delete(ip);
  };
  function validateSnapshot(s, protocol, ruleset) {
    if(protocol>=5 && (ruleset!==rulesFor(protocol)?.id || s?.ruleset!==ruleset))return false;
    if (!s || s.protocol !== protocol || !Number.isFinite(s.elapsed) || !Array.isArray(s.fish) || s.fish.length !== (protocol>=4&&s.mode!=='ocean'?24:protocol>=2?65:29) || !Array.isArray(s.food) || s.food.length > (protocol>=3?2400:protocol===2?6000:1800) || !Array.isArray(s.circles) || s.circles.length > 12) return false;
    if (!s.surface || !Array.isArray(s.surface.displacement) || s.surface.displacement.length !== (protocol>=4&&s.mode!=='ocean'?(protocol>=5?(protocol===6&&s.mode==='team'?305:431):609):860) || !Array.isArray(s.surface.velocity) || s.surface.velocity.length !== s.surface.displacement.length) return false;
    const finite = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e12;
    for (let i=0;i<s.fish.length;i++) {
      const f=s.fish[i];
      if (f.id !== i || !f.position || !finite(f.position.x) || !finite(f.position.y) || !Number.isSafeInteger(f.mass) || f.mass<0 || !Number.isSafeInteger(f.capacity) || f.capacity<f.mass || f.capacity>100000000 || typeof f.name!=='string' || f.name.length>32) return false;
    }
    if(protocol>=2) {
      if(!Array.isArray(s.mines) || s.mines.length>40 || !s.mines.every(m=>Number.isSafeInteger(m.id)&&m.position&&finite(m.position.x)&&finite(m.position.y)))return false;
      if(!s.food.every(f=>Array.isArray(f)&&f.length===5&&f.every(Number.isSafeInteger)&&f[3]>0&&f[3]<=100000000&&f[4]>=0&&f[4]<=(protocol>=3?8:6)))return false;
    }
    if(protocol>=3 && (!['ocean','king','deathmatch','team'].includes(s.mode)||!Array.isArray(s.crownTimes)||s.crownTimes.length!==s.fish.length||!s.crownTimes.every(n=>finite(n)&&n>=0&&n<=181)||s.roundResult!=null&&(typeof s.roundResult!=='string'||s.roundResult.length>64)))return false;
    if(protocol>=5) {
      if(s.elapsed<0 || s.elapsed>3600 || !s.surface.displacement.every(finite) || !s.surface.velocity.every(finite))return false;
      if(!s.fish.every(f=>Number.isSafeInteger(f.skinID)&&f.skinID>=0&&f.skinID<=CHOMP_RULESET.maximumSkin))return false;
    }
    if(protocol===6 && (!s.fish.every(f=>Number.isSafeInteger(f.kills)&&f.kills>=0&&f.kills<=100000&&Number.isSafeInteger(f.deaths)&&f.deaths>=0&&f.deaths<=100000)||!validMatchStats(s.matchStats,s.fish.length,s.mode)))return false;
    if(protocol===6&&!s.matchStats.filter(r=>r.connected).every(r=>s.fish[r.slot].kills===r.kills&&s.fish[r.slot].deaths===r.deaths&&s.fish[r.slot].name===r.name))return false;
    return true;
  }
  function validMatchStats(stats,count,mode) {
    if(!Array.isArray(stats)||stats.length<count||stats.length>128)return false;
    const ids=new Set(),active=new Set();
    for(const row of stats) {
      if(!row||typeof row.participantID!=='string'||!row.participantID.length||row.participantID.length>128||ids.has(row.participantID)||!Number.isSafeInteger(row.slot)||row.slot<0||row.slot>=count||row.team!==row.slot%2||typeof row.name!=='string'||!row.name.length||Array.from(row.name).length>16||typeof row.connected!=='boolean'||typeof row.isBot!=='boolean'||![row.kills,row.deaths].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100000))return false;
      ids.add(row.participantID);
      if(row.connected){if(active.has(row.slot))return false;active.add(row.slot);}
    }
    const totals=[0,1].map(team=>stats.filter(r=>r.team===team).reduce((a,r)=>({kills:a.kills+r.kills,deaths:a.deaths+r.deaths}),{kills:0,deaths:0}));
    return mode==='team'?totals[0].kills<=totals[1].deaths&&totals[1].kills<=totals[0].deaths:totals[0].kills+totals[1].kills<=totals[0].deaths+totals[1].deaths;
  }
  function monotonicMatchStats(previous,next) {
    if(!previous)return true;
    const rows=new Map(next.map(r=>[r.participantID,r]));
    return previous.every(old=>{const value=rows.get(old.participantID);return value&&value.slot===old.slot&&value.team===old.team&&value.isBot===old.isBot&&value.name===old.name&&value.kills>=old.kills&&value.deaths>=old.deaths&&(!value.connected||old.connected);});
  }
  function matchClock(room) {return room.protocol===6&&room.mode!=='ocean'?{serverTime:now(),startsAt:room.created,endsAt:room.created+180000}:null;}
  function finalizeDeadline(room) {
    const s=room.snapshot;if(room.protocol!==6||room.mode==='ocean'||!s||s.roundResult!=null)return;
    const scores=[0,1].map(team=>s.matchStats.filter(r=>r.team===team).reduce((sum,r)=>sum+r.kills,0));
    if(now()<room.created+180000 && !(room.mode==='team'&&Math.max(...scores)>=25))return;
    if(room.mode==='team')s.roundResult=scores[0]===scores[1]?'DRAW':scores[0]>scores[1]?'BLUE TEAM WINS':'RED TEAM WINS';
    else if(room.mode==='deathmatch') {
      const best=Math.max(...s.matchStats.map(r=>r.kills)),winners=s.matchStats.filter(r=>r.kills===best);
      s.roundResult=winners.length===1?`${winners[0].name.toUpperCase()} WINS`:'DRAW';
    } else {
      const best=Math.max(...s.crownTimes),winners=s.fish.filter((_,i)=>s.crownTimes[i]===best);
      s.roundResult=winners.length===1?`${winners[0].name.toUpperCase()} WINS`:'DRAW';
    }
    room.snapshot=outwardSnapshot(room);room.finalizedAt=now();room.revision++;
  }
  function newRoom(protocol,mode,ruleset=null,isPublic=false) {
    let code;do {code=randomBytes(5).toString('hex').toUpperCase();}while(rooms.has(code));
    const room={protocol,mode,ruleset,isPublic,created:now(),hostSeen:now(),worldAdvancedAt:now(),players:new Map(),history:new Map(),retirements:0,finalizedAt:null,snapshot:null,revision:0};rooms.set(code,room);return {code,room};
  }
  function addPlayer(code,room,name,skin) {
    const used=new Set([...room.players.values()].map(p=>p.slot));let slot=0;while(used.has(slot))slot++;
    if(slot>=4||room.protocol===6&&room.finalizedAt!=null)return null;
    // Reserve space both for the replaced bot and this guest's eventual
    // disconnected row. Old clients retain their exact admission behavior.
    if(room.protocol===6 && slot!==0 && room.retirements+2+[...room.players.values()].filter(p=>p.slot!==0).length>128-(room.mode==='ocean'?65:24))return null;
    const token=randomBytes(32).toString('base64url');
    const identity=randomBytes(8).toString('hex'),displayName=cleanName(name);
    if(room.protocol===6){room.history.set(identity,{slot,name:displayName});if(slot!==0)room.retirements++;}
    room.players.set(token,{slot,identity,name:displayName,skin:room.protocol>=5?skin:Math.max(0,Math.min(31,Math.floor(Number(skin)||0))),seen:now(),lastExchange:0,input:{x:0,y:0,boost:0,chomp:0}});
    return {code,token,slot,protocol:room.protocol,mode:room.mode,...(room.protocol>=5?{ruleset:room.ruleset}:{}),...(room.protocol===6?{team:slot%2,spawnIndex:Math.floor(slot/2),...(matchClock(room)?{matchClock:matchClock(room)}:{})}:{})};
  }
  function removePlayer(room,token) {
    const p=room?.players.get(token);if(!p)return;
    if(room.protocol===6&&p.slot!==0)room.retirements++;
    room.players.delete(token);
  }
  function outwardSnapshot(room) {
    const s=room.snapshot;if(!s||room.protocol!==6||room.finalizedAt!=null)return s;
    const current=new Map([...room.players.values()].map(p=>[p.slot,p.identity]));
    return {...s,matchStats:s.matchStats.map(row=>({...row,connected:row.connected&&(row.isBot?!current.has(row.slot):current.get(row.slot)===row.participantID)}))};
  }
  function leavePlayer(code,room,token) {
    const player=room?.players.get(token);if(!player)return;
    if(player.slot===0 && !(room.protocol===6&&room.finalizedAt!=null))rooms.delete(code);
    else removePlayer(room,token);
    if(room.protocol===6&&room.finalizedAt!=null&&room.players.size===0)rooms.delete(code);
  }
  function validIdentities(room,stats) {
    return stats.every(row=>row.isBot?new RegExp(`^bot:${row.slot}(?::[1-9][0-9]*)?$`).test(row.participantID):room.history.get(row.participantID)?.slot===row.slot&&room.history.get(row.participantID)?.name===row.name);
  }
  function settleQueue() {
    for(const mode of modes) {
      const waiting=[...queue.values()].filter(e=>e.mode===mode&&!e.ticket);
      if(!waiting.length||waiting[0].startsAt>now())continue;
      if(rooms.size>=maxRooms) {for(const e of waiting){e.startsAt=nextStart();e.capacityWait=true;}continue;}
      const {code,room}=newRoom(4,mode);
      for(const e of waiting){e.ticket=addPlayer(code,room,e.name,e.skin);e.seen=now();}
    }
  }
  function lobbyState() {
    return {serverTime:now(),intervalSeconds:interval/1000,modes:modes.map(mode=>{
      const waiting=[...queue.values()].filter(e=>e.mode===mode&&!e.ticket);
      return {mode,startsAt:waiting[0]?.startsAt??nextStart(),queued:waiting.length,capacity:4,capacityWait:waiting.some(e=>e.capacityWait)};
    })};
  }
  function queueState(token,e) {return {...lobbyState(),queueToken:token,mode:e.mode,ticket:e.ticket??null};}
  const validRequestID=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  const validConfigured=b=>rulesFor(b.protocol)&&b.ruleset===rulesFor(b.protocol).id&&Number.isSafeInteger(b.skin)&&b.skin>=0&&b.skin<=CHOMP_RULESET.maximumSkin;
  function admissionTicketActive(e) {
    return !!e.ticket && rooms.get(e.ticket.code)?.players.has(e.ticket.token);
  }
  function publicOpen(room,mode,protocol=5,ruleset=LEGACY_RULESET.id) {
    if(!room.isPublic || room.protocol!==protocol || room.ruleset!==ruleset || room.mode!==mode || room.players.size>=4 || room.snapshot?.roundResult!=null)return false;
    if(room.protocol===6&&room.retirements+2+[...room.players.values()].filter(p=>p.slot!==0).length>128-(room.mode==='ocean'?65:24))return false;
    // Do not send a new guest to a host whose world stopped advancing.
    if(now()-room.worldAdvancedAt>3000)return false;
    // No late entry into a competitive round: both host elapsed time and wall time count.
    return mode==='ocean' || Math.max((now()-room.created)/1000,room.snapshot?.elapsed??0)<CHOMP_RULESET.competitiveJoinSeconds;
  }
  function immediateState(protocol=5,ruleset=LEGACY_RULESET.id) {
    return {serverTime:now(),intervalSeconds:0,modes:modes.map(mode=>({mode,startsAt:now(),queued:0,capacity:4,capacityWait:rooms.size>=maxRooms&&![...rooms.values()].some(r=>publicOpen(r,mode,protocol,ruleset)),humans:[...rooms.values()].filter(r=>r.isPublic&&r.protocol>=5&&r.mode===mode).reduce((sum,r)=>sum+r.players.size,0)}))};
  }
  function admissionState(e) {return {...immediateState(e.ticket.protocol,e.ticket.ruleset),queueToken:e.token,mode:e.mode,ticket:e.ticket};}
  function cancelAdmission(e) {
    if(e.ticket){const room=rooms.get(e.ticket.code);leavePlayer(e.ticket.code,room,e.ticket.token);}
    e.canceled=true;
  }
  function limited(req) {
    const ip=req.socket.remoteAddress||'unknown',entry=attempts.get(ip)||{start:now(),count:0};
    if(entry.count++>=60||(!attempts.has(ip)&&attempts.size>=1024))return true;
    attempts.set(ip,entry);return false;
  }
  async function body(req) {
    const chunks=[];let size=0;
    for await (const chunk of req) { size+=chunk.length;if(size>786432) throw new Error('Request too large');chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return async function chompRooms(req,res) {
    const path=new URL(req.url || '/', 'http://localhost').pathname;
    if (!path.startsWith('/v1/chomp/')) return false;
    expire();settleQueue();
    if (path==='/v1/chomp/health' && req.method==='GET') {reply(res,200,{ok:true,protocol:4,compatibleProtocols:[1,2,3,4,5,6],latestProtocol:6,mode:'private-hosted-playtest',maxPlayers:4});return true;}
    if(path==='/v1/chomp/capabilities'&&req.method==='GET'){reply(res,200,{protocols:[1,2,3,4,5,6],rulesets:[LEGACY_RULESET.id,CHOMP_RULESET.id],catalog:CHOMP_RULESET.catalog,maximumSkin:CHOMP_RULESET.maximumSkin,immediatePublic:true,maxPlayers:4,maxRooms,competitiveJoinSeconds:CHOMP_RULESET.competitiveJoinSeconds});return true;}
    if(path==='/v1/chomp/matches'&&req.method==='GET'){reply(res,200,immediateState());return true;}
    if(path==='/v1/chomp/lobbies'&&req.method==='GET'){reply(res,200,lobbyState());return true;}
    if (req.method!=='POST') {reply(res,405,{error:'Use POST.'});return true;}
    try {
      const b=await body(req);
      if (!b || Array.isArray(b) || typeof b!=='object') throw new Error('Invalid request');
      expire();
      if(path==='/v1/chomp/match' || path.startsWith('/v1/chomp/match/')) {
        if(path==='/v1/chomp/match/cancel') {
          // A random request UUID is a cancellation capability, even before the reply arrives.
          if(!validRequestID(b.requestID)){reply(res,400,{error:'Invalid admission request.'});return true;}
          const key=b.requestID.toLowerCase(),existing=admissions.get(key);
          if(existing)cancelAdmission(existing);
          else {
            if(limited(req)||admissions.size>=maximumAdmissions){reply(res,429,{error:'Please wait before trying again.'});return true;}
            admissions.set(key,{created:now(),canceled:true});
          }
          reply(res,200,{ok:true});return true;
        }
        if(path==='/v1/chomp/match') {
          if(!validConfigured(b)||!modes.includes(b.mode)||!validRequestID(b.requestID)){reply(res,409,{error:'This ruleset or skin catalog is not supported. Update the game.'});return true;}
          const key=b.requestID.toLowerCase(),existing=admissions.get(key);
          if(existing) {
            if(existing.canceled||!admissionTicketActive(existing)){reply(res,410,{error:'This admission ended. Tap a mode to start again.'});return true;}
            if(existing.mode!==b.mode||existing.name!==cleanName(b.name)||existing.skin!==b.skin||existing.ticket.protocol!==b.protocol||existing.ticket.ruleset!==b.ruleset){reply(res,409,{error:'Admission request changed. Start a new request.'});return true;}
            reply(res,200,admissionState(existing));return true;
          }
          if(limited(req)||admissions.size>=maximumAdmissions){reply(res,429,{error:'Please wait before trying again.'});return true;}
          let found=[...rooms].find(([,room])=>publicOpen(room,b.mode,b.protocol,b.ruleset));
          if(!found) {
            if(rooms.size>=maxRooms){reply(res,503,{error:'Online rooms are full. Retry or choose Play with bots.'});return true;}
            const made=newRoom(b.protocol,b.mode,b.ruleset,true);found=[made.code,made.room];
          }
          const [code,room]=found,ticket=addPlayer(code,room,b.name,b.skin);
          if(!ticket){reply(res,409,{error:'That room filled. Try again.'});return true;}
          const entry={created:now(),token:randomBytes(32).toString('base64url'),mode:b.mode,name:cleanName(b.name),skin:b.skin,ticket,canceled:false};
          admissions.set(key,entry);reply(res,200,admissionState(entry));return true;
        }
        const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];
        const entry=token?[...admissions.values()].find(e=>e.token===token):null;
        if(path==='/v1/chomp/match/leave') {if(entry)cancelAdmission(entry);reply(res,200,{ok:true});return true;}
        if(path!=='/v1/chomp/match/status'){reply(res,404,{error:'Unknown admission action.'});return true;}
        if(!entry||entry.canceled||!admissionTicketActive(entry)){reply(res,410,{error:'This admission ended. Tap a mode to start again.'});return true;}
        reply(res,200,admissionState(entry));return true;
      }
      if(path==='/v1/chomp/queue' || path.startsWith('/v1/chomp/queue/')) {
        const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];
        if(path==='/v1/chomp/queue') {
          if(b.protocol!==4||!modes.includes(b.mode)||!/^[-a-f0-9]{36}$/i.test(b.requestID||'')){reply(res,400,{error:'Update the game and try again.'});return true;}
          const existing=[...queue].find(([,e])=>e.requestID===b.requestID);
          if(existing){existing[1].seen=now();reply(res,200,queueState(...existing));return true;}
          const ip=req.socket.remoteAddress||'unknown',entry=attempts.get(ip)||{start:now(),count:0};
          if(entry.count++>=60||(!attempts.has(ip)&&attempts.size>=1024)){reply(res,429,{error:'Please wait before joining again.'});return true;}attempts.set(ip,entry);
          const waiting=[...queue.values()].filter(e=>e.mode===b.mode&&!e.ticket);
          if(waiting.length>=4||queue.size>=64){reply(res,409,{error:'This next game is full. Try another mode or wait for the next start.'});return true;}
          const key=randomBytes(32).toString('base64url'),e={requestID:b.requestID,mode:b.mode,name:cleanName(b.name),skin:b.skin,seen:now(),startsAt:waiting[0]?.startsAt??nextStart(),capacityWait:false};
          queue.set(key,e);reply(res,200,queueState(key,e));return true;
        }
        const e=queue.get(token);
        if(path==='/v1/chomp/queue/leave') {
          if(e?.ticket){const room=rooms.get(e.ticket.code);leavePlayer(e.ticket.code,room,e.ticket.token);}
          queue.delete(token);reply(res,200,{ok:true});return true;
        }
        if(path!=='/v1/chomp/queue/status'){reply(res,404,{error:'Unknown queue action.'});return true;}
        if(!e){reply(res,410,{error:'You left the queue. Join the next game when ready.'});return true;}
        if(e.ticket&&!rooms.has(e.ticket.code)){queue.delete(token);reply(res,410,{error:'The host left before the game started. Join the next game.'});return true;}
        e.seen=now();reply(res,200,queueState(token,e));return true;
      }
      if (path==='/v1/chomp/rooms'  || path==='/v1/chomp/join') {
        const ip=req.socket.remoteAddress || 'unknown';
        const entry=attempts.get(ip) || {start:now(),count:0};
        if (entry.count++>=60 || (!attempts.has(ip) && attempts.size>=1024)) {reply(res,429,{error:'Please wait before trying another room.'});return true;}
        attempts.set(ip,entry);
        if (![1,2,3,4,5,6].includes(b.protocol)) {reply(res,409,{error:'Update chomp chomp.io on both phones.'});return true;}
        if(b.protocol>=5 && (!validConfigured(b)||!modes.includes(b.mode))){reply(res,409,{error:'This ruleset or skin catalog is not supported. Update the game.'});return true;}
        let room,code;
        if (path==='/v1/chomp/rooms' ) {
          if (rooms.size>=maxRooms) {reply(res,503,{error:'Test rooms are full. Try again shortly.'});return true;}
          ({code,room}=newRoom(b.protocol,b.protocol>=3&&modes.includes(b.mode)?b.mode:'ocean',b.protocol>=5?b.ruleset:null));
        } else {code=String(b.code||'').toUpperCase();room=rooms.get(code);}
        if (!room) {reply(res,404,{error:'That room has closed. Ask the host for a new code.'});return true;}
        if(room.protocol!==b.protocol || b.protocol>=5&&room.ruleset!==b.ruleset) {reply(res,409,{error:"Update chomp chomp.io on both phones before joining this room."});return true;}
        if(room.protocol===6 && (room.finalizedAt!=null || room.mode!=='ocean'&&now()>=room.created+180000)) {finalizeDeadline(room);reply(res,409,{error:'That match has finished. Start a new match.'});return true;}
        const ticket=addPlayer(code,room,b.name,b.skin);
        if(!ticket){reply(res,409,{error:'This room already has four players.'});return true;}
        reply(res,200,ticket);return true;
      }
      const code=String(b.code||'').toUpperCase(),room=rooms.get(code);
      const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1],player=room?.players.get(token);
      if (!room || !player) {reply(res,410,{error:'Room disconnected. Return to the menu and join again.'});return true;}
      if (path==='/v1/chomp/leave') {leavePlayer(code,room,token);reply(res,200,{ok:true});return true;}
      if(path!=='/v1/chomp/exchange') {reply(res,404,{error:'Unknown room action.'});return true;}
      finalizeDeadline(room);
      if(now()-player.lastExchange<65) {reply(res,429,{error:'Updates are arriving too quickly.'});return true;}
      player.lastExchange=now();player.seen=now();
      const input=b.input || {};
      for (const k of ['x','y','boost','chomp']) if(typeof input[k]!=='number' || !Number.isFinite(input[k])) throw new Error('Invalid controls');
      if(Math.abs(input.x)>1 || Math.abs(input.y)>1 || !Number.isSafeInteger(input.boost) || !Number.isSafeInteger(input.chomp) || input.boost<0 || input.chomp<0 || input.boost>1e9 || input.chomp>1e9) throw new Error('Invalid controls');
      // Lost/repeated packets cannot replay an ability; host consumes monotonic counters once.
      player.input={x:input.x,y:input.y,boost:Math.max(player.input.boost,input.boost),chomp:Math.max(player.input.chomp,input.chomp)};
      if(player.slot===0) {
        room.hostSeen=now();
        if(b.snapshot) {
          if(!validateSnapshot(b.snapshot,room.protocol,room.ruleset)||(room.protocol>=3&&b.snapshot.mode!==room.mode)||room.protocol===6&&!validIdentities(room,b.snapshot.matchStats))throw new Error('Invalid world snapshot');
          // After the deadline, retain the last accepted combat ledger. A
          // packet already in flight can complete without reopening the match.
          if(!(room.protocol===6&&room.snapshot?.roundResult!=null)) {
            if(room.protocol===6) {
              if(room.snapshot && b.snapshot.elapsed<room.snapshot.elapsed || !monotonicMatchStats(room.snapshot?.matchStats,b.snapshot.matchStats))throw new Error('Reversed match state');
              if(room.mode==='team') {
                const scores=[0,1].map(team=>b.snapshot.matchStats.filter(r=>r.team===team).reduce((sum,r)=>sum+r.kills,0));
                b.snapshot.roundResult=now()>=room.created+180000||Math.max(...scores)>=25?(scores[0]===scores[1]?'DRAW':scores[0]>scores[1]?'BLUE TEAM WINS':'RED TEAM WINS'):null;
              }
            }
            if(!room.snapshot||b.snapshot.elapsed>room.snapshot.elapsed)room.worldAdvancedAt=now();room.snapshot=b.snapshot;room.revision++;
          }
          finalizeDeadline(room);
          if(room.protocol===6&&room.snapshot?.roundResult!=null&&room.finalizedAt==null){room.snapshot=outwardSnapshot(room);room.finalizedAt=now();}
        }
      } else if(b.snapshot) {reply(res,403,{error:'Only the host can send the world.'});return true;}
      const players=[...room.players.values()].map(p=>({slot:p.slot,identity:p.identity,name:p.name,skin:p.skin,...(room.protocol===6?{team:p.slot%2,spawnIndex:Math.floor(p.slot/2)}:{}),input:now()-p.seen>1200?{...p.input,x:0,y:0}:p.input}));
      reply(res,200,{revision:room.revision,players,snapshot:player.slot===0&&!(room.protocol===6&&room.snapshot?.roundResult!=null)?null:outwardSnapshot(room),...(matchClock(room)?{matchClock:matchClock(room)}:{}),...(room.protocol===6?{roundResult:room.snapshot?.roundResult??null}:{})});return true;
    } catch(error) {reply(res,400,{error:'Invalid or oversized room request.'});return true;}
  };
}
