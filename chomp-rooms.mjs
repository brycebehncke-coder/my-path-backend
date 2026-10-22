import { randomBytes } from 'node:crypto';

export const CHOMP_RULESET = Object.freeze({protocol:6,id:'chomp-team-v2',catalog:2,maximumSkin:39,competitiveJoinSeconds:30});
const LEGACY_RULESET=Object.freeze({...CHOMP_RULESET,protocol:5,id:'chomp-quarter-v1'});
export const SWIM_RULESET=Object.freeze({...CHOMP_RULESET,protocol:7,id:'chomp-swim-v3'});
export const CLAW_RULESET=Object.freeze({...SWIM_RULESET,protocol:8,id:'chomp-claws-v4',catalog:3,maximumSkin:42});
export const ELIMINATION_RULESET=Object.freeze({...CLAW_RULESET,protocol:9,id:'chomp-elimination-v5'});
export const ENDLESS_RULESET=Object.freeze({...ELIMINATION_RULESET,protocol:10,id:'chomp-endless-v6'});
export const OCEAN_RULESET=Object.freeze({...ENDLESS_RULESET,protocol:11,id:'chomp-ocean-v7'});
export const SCHOOL_RULESET=Object.freeze({...OCEAN_RULESET,protocol:12,id:'chomp-school-v8',catalog:4,maximumSkin:43});
const rulesFor=protocol=>protocol===12?SCHOOL_RULESET:protocol===11?OCEAN_RULESET:protocol===10?ENDLESS_RULESET:protocol===9?ELIMINATION_RULESET:protocol===8?CLAW_RULESET:protocol===7?SWIM_RULESET:protocol===6?CHOMP_RULESET:protocol===5?LEGACY_RULESET:null;
const endlessKing=value=>([10,11,12].includes(value.protocol))&&value.mode==='king';
const timedRoom=room=>room.protocol>=6&&room.mode!=='ocean'&&!endlessKing(room);

// Protocol12 is isolated from all legacy rooms. Fixed IDs mirror ChompPlant.
export const schoolPlantSites=()=>Array.from({length:Math.floor(768*Math.sqrt(5)*Math.sqrt(2)/7)+1},(_,id)=>{
  const noise=Number(((BigInt(id)*73856093n)^(4n*19349663n))%101n);
  return {id,noise,delay:30+noise%15};
}).filter(p=>p.noise%4<=1).slice(0,256);
const schoolSites=schoolPlantSites();
function validPixelRows(body) {
  if(!body||!Number.isSafeInteger(body.count)||body.count<0||body.count>100000000||!body.rows||Array.isArray(body.rows)||typeof body.rows!=='object')return false;
  let count=0,segments=0;const rows=Object.entries(body.rows);if(rows.length>40001)return false;
  for(const [key,spans] of rows) {
    const y=Number(key);if(!Number.isSafeInteger(y)||String(y)!==key||Math.abs(y)>20000||!Array.isArray(spans)||!spans.length)return false;
    let previous=-20002;
    for(const span of spans) {
      if(!Array.isArray(span)||span.length!==2||!span.every(Number.isSafeInteger)||span[0]<-20000||span[1]>20000||span[1]<span[0]||span[0]<=previous+1)return false;
      count+=span[1]-span[0]+1;previous=span[1];if(++segments>100000||count>100000000)return false;
    }
  }
  return count===body.count;
}
function subsetPixels(body,template) {
  return Object.entries(body.rows).every(([y,spans])=>spans.every(([lo,hi])=>(template.rows[y]||[]).some(([a,b])=>a<=lo&&b>=hi)));
}
export function validSchoolWorld(s) {
  if(!s||!Array.isArray(s.fish)||s.fish.length>65||!Number.isFinite(s.elapsed)||s.elapsed<0)return false;
  const sites=s.mode==='ocean'?schoolSites:[];
  if(!Array.isArray(s.plants)||s.plants.length!==sites.length||!s.plants.every((p,i)=>p&&p.id===sites[i].id&&Number.isFinite(p.readyAt)&&p.readyAt>=0&&p.readyAt<=s.elapsed+sites[i].delay&&Number.isSafeInteger(p.harvests)&&p.harvests>=0&&p.harvests<=1000000&&(p.harvests>0||p.readyAt===0)))return false;
  for(const f of s.fish) {
    if(!f||!validPixelRows(f.pixels)||!validPixelRows(f.template)||f.mass!==f.pixels.count||f.capacity!==f.template.count||!subsetPixels(f.pixels,f.template)||f.schoolMemberIndex!=null)return false;
    if(f.skinID!==43) {if(f.school!=null)return false;continue;}
    if(!Array.isArray(f.school)||f.school.length!==12||!Number.isSafeInteger(f.gridLength)||f.gridLength<=0||f.gridLength>=20000)return false;
    let mass=0,capacity=0,living=false,extent=0.48;
    for(let i=0;i<12;i++) {
      const member=f.school[i],b=member?.body;
      if(!b||b.school!=null||b.schoolMemberIndex!==i||b.skinID!==0||b.id!==f.id||!Number.isSafeInteger(b.mass)||b.mass<0||!Number.isSafeInteger(b.capacity)||b.capacity<b.mass||b.capacity>8333334||!validPixelRows(b.pixels)||!validPixelRows(b.template)||b.pixels.count!==b.mass||b.template.count!==b.capacity||!subsetPixels(b.pixels,b.template))return false;
      if(![b.gridLength,b.gridHeight].every(n=>Number.isSafeInteger(n)&&n>0&&n<20000)||!b.position||![b.position.x,b.position.y,b.heading,b.occupiedRadius,b.pivot?.x,b.pivot?.y,b.velocity?.x,b.velocity?.y,b.protection,b.peaceTime,b.repairAccumulator,b.growthCredit].every(Number.isFinite)||Math.abs(b.heading)>Math.PI||b.occupiedRadius<=0||b.respawnTime!==0||b.kills!==0||b.deaths!==0||typeof b.headPresent!=='boolean')return false;
      const offset=Math.hypot(b.position.x,b.position.y);
      if(offset>f.gridLength*0.48*1.6+Math.hypot(b.gridLength,b.gridHeight)*0.48*2+0.001)return false;
      if(member.targetID!=null&&(!Number.isSafeInteger(member.targetID)||member.targetID<0||member.targetID>=s.fish.length||member.targetID===f.id||s.mode==='team'&&member.targetID%2===f.id%2))return false;
      const alive=b.mass>0&&b.headPresent;
      living ||= alive;if(alive)extent=Math.max(extent,offset+b.occupiedRadius);
      mass+=b.mass;capacity+=b.capacity;
    }
    if(mass!==f.mass||capacity!==f.capacity||f.headPresent!==living||!Number.isFinite(f.occupiedRadius)||Math.abs(f.occupiedRadius-extent)>0.001)return false;
  }
  return true;
}
function validPlantTransition(previous,next) {
  return next.plants.every((plant,i)=>{
    const old=previous.plants[i];
    if(plant.harvests===old.harvests)return plant.readyAt===old.readyAt;
    const count=plant.harvests-old.harvests,delay=schoolSites[i]?.delay;
    return count>0&&delay!=null&&plant.readyAt>old.readyAt&&next.elapsed>=old.readyAt&&count<=1+Math.floor((next.elapsed-old.readyAt)/delay);
  });
}

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
      if(room.protocol>=6&&room.finalizedAt!=null) {
        if(now()-room.finalizedAt>60000||room.players.size===0)rooms.delete(code);
        continue;
      }
      if (now() - room.hostSeen > 12000 || !endlessKing(room)&&now() - room.created > 3600000) { rooms.delete(code); continue; }
      for (const [token, player] of room.players) if (player.slot !== 0 && now() - player.seen > 12000) removePlayer(room,token);
    }
    for (const [requestID, entry] of admissions) if(now()-entry.created>admissionLifetime)admissions.delete(requestID);
    for (const [token, entry] of queue) if(now()-entry.seen>12000)queue.delete(token);
    for (const [ip, entry] of attempts) if (now() - entry.start > 60000) attempts.delete(ip);
  };
  function validateSnapshot(s, protocol, ruleset) {
    if(protocol>=5 && (ruleset!==rulesFor(protocol)?.id || s?.ruleset!==ruleset))return false;
    if (!s || s.protocol !== protocol || !Number.isFinite(s.elapsed) || !Array.isArray(s.fish) || s.fish.length !== (protocol>=4&&s.mode!=='ocean'?24:protocol>=2?65:29) || !Array.isArray(s.food) || s.food.length > (protocol>=3?2400:protocol===2?6000:1800) || !Array.isArray(s.circles) || s.circles.length > 12) return false;
    if (!s.surface || !Array.isArray(s.surface.displacement) || s.surface.displacement.length !== (protocol>=4&&s.mode!=='ocean'?(protocol>=5?(protocol>=6&&s.mode==='team'?305:431):609):protocol>=11?1216:860) || !Array.isArray(s.surface.velocity) || s.surface.velocity.length !== s.surface.displacement.length) return false;
    const finite = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e12;
    for (let i=0;i<s.fish.length;i++) {
      const f=s.fish[i];
      if (f.id !== i || !f.position || !finite(f.position.x) || !finite(f.position.y) || !Number.isSafeInteger(f.mass) || f.mass<0 || !Number.isSafeInteger(f.capacity) || f.capacity<f.mass || f.capacity>100000000 || typeof f.name!=='string' || f.name.length>32) return false;
    }
    if(protocol>=2) {
      if(!Array.isArray(s.mines) || s.mines.length>40 || !s.mines.every(m=>Number.isSafeInteger(m.id)&&m.position&&finite(m.position.x)&&finite(m.position.y)))return false;
      if(!s.food.every(f=>Array.isArray(f)&&f.length===5&&f.every(Number.isSafeInteger)&&f[3]>0&&f[3]<=100000000&&f[4]>=0&&f[4]<=(protocol>=3?8:6)))return false;
    }
    if(protocol>=3 && (!['ocean','king','deathmatch','team'].includes(s.mode)||!Array.isArray(s.crownTimes)||s.crownTimes.length!==s.fish.length||!s.crownTimes.every(n=>finite(n)&&n>=0&&n<=(endlessKing(s)?s.elapsed+0.1:181))||s.roundResult!=null&&(typeof s.roundResult!=='string'||s.roundResult.length>64)))return false;
    if(protocol>=5) {
      if(s.elapsed<0 || (endlessKing(s)?!finite(s.elapsed):s.elapsed>3600) || !s.surface.displacement.every(finite) || !s.surface.velocity.every(finite))return false;
      if(!s.fish.every(f=>Number.isSafeInteger(f.skinID)&&f.skinID>=0&&f.skinID<=rulesFor(protocol).maximumSkin))return false;
    }
    if(protocol>=9) {
      if(!s.fish.every(f=>allowedSkin(protocol,f.skinID,s.mode)&&typeof f.headPresent==='boolean'&&Number.isFinite(f.respawnTime)&&f.respawnTime>=0))return false;
      if(s.mode==='team' && (!s.fish.every(f=>f.deaths<=1)||!Array.isArray(s.matchStats)))return false;
      if(s.mode==='team' && s.fish.some(f=>s.matchStats.filter(r=>r.slot===f.id).reduce((n,r)=>n+r.deaths,0)>1))return false;
    }
    if(protocol>=8 && !s.fish.every(f=>f.clawAngle==null || Number.isFinite(f.clawAngle)&&Math.abs(f.clawAngle)<=Math.PI))return false;
    if(protocol>=6 && (!s.fish.every(f=>Number.isSafeInteger(f.kills)&&f.kills>=0&&f.kills<=100000&&Number.isSafeInteger(f.deaths)&&f.deaths>=0&&f.deaths<=100000)||!validMatchStats(s.matchStats,s.fish.length,s.mode)))return false;
    if(protocol>=6&&!s.matchStats.filter(r=>r.connected).every(r=>s.fish[r.slot].kills===r.kills&&s.fish[r.slot].deaths===r.deaths&&s.fish[r.slot].name===r.name))return false;
    if([10,11,12].includes(protocol)) {
      if(!s.fish.every(f=>finite(f.growthCredit)&&f.growthCredit>=0&&f.growthCredit<=1+100000000/4096+1/8192+1))return false;
      if(Object.hasOwn(s,'bestCrownTimes'))return false; // Personal bests are device-only.
      if(endlessKing(s)) {
        const holder=crownHolder(s);
        if(s.roundResult!=null||!s.crownTimes.every((n,i)=>i===holder||n===0))return false;
      } else if(s.crownTimes.some(n=>n!==0))return false;
    }
    if(protocol===12 && !validSchoolWorld(s))return false;
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
  const living=f=>f.mass>0 && f.headPresent===true && f.respawnTime===0;
  function crownHolder(s) {
    let holder=null;
    for(const f of s.fish)if(living(f)&&(holder===null||f.mass>s.fish[holder].mass||f.mass===s.fish[holder].mass&&f.id<holder))holder=f.id;
    return holder;
  }
  function validCrownTransition(previous,next) {
    if(!previous)return true;
    const delta=next.elapsed-previous.elapsed,tolerance=0.1;
    if(delta<0)return false;
    const before=new Map(previous.matchStats.filter(r=>r.connected).map(r=>[r.slot,r.participantID]));
    const after=new Map(next.matchStats.filter(r=>r.connected).map(r=>[r.slot,r.participantID]));
    const oldHolder=crownHolder(previous);
    return next.fish.every((f,i)=>{
      const same=before.has(i)&&before.get(i)===after.get(i);
      const oldCurrent=same&&oldHolder===i?previous.crownTimes[i]:0;
      const sameLife=same&&f.deaths===previous.fish[i].deaths;
      return next.crownTimes[i]<=(sameLife?oldCurrent:0)+delta+tolerance;
    });
  }
  function eliminationResult(s,deadline) {
    const alive=[0,1].map(team=>s.fish.filter(f=>f.id%2===team&&living(f)).length);
    if(alive[0]===0&&alive[1]===0)return 'DRAW';
    if(alive[0]>0&&alive[1]>0&&!deadline)return null;
    const scores=alive[0]===alive[1]&&deadline? [0,1].map(team=>s.matchStats.filter(r=>r.team===team).reduce((n,r)=>n+r.kills,0)):alive;
    return scores[0]===scores[1]?'DRAW':scores[0]>scores[1]?'BLUE TEAM WINS':'RED TEAM WINS';
  }
  function matchClock(room) {return timedRoom(room)?{serverTime:now(),startsAt:room.created,endsAt:room.created+180000}:null;}
  function finalizeDeadline(room) {
    const s=room.snapshot;if(!timedRoom(room)||!s||s.roundResult!=null)return;
    if(room.protocol>=9&&room.mode==='team') {
      const result=eliminationResult(s,now()>=room.created+180000);if(result==null)return;
      s.roundResult=result;room.snapshot=outwardSnapshot(room);room.finalizedAt=now();room.revision++;return;
    }
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
    const used=new Set([...room.players.values()].map(p=>p.slot));let slot=0;while(slot<4&&(used.has(slot)||room.protocol>=9&&room.mode==='team'&&room.snapshot&&!living(room.snapshot.fish[slot])))slot++;
    if(slot>=4||room.protocol>=6&&room.finalizedAt!=null)return null;
    // Reserve space both for the replaced bot and this guest's eventual
    // disconnected row. Old clients retain their exact admission behavior.
    if(room.protocol>=6 && slot!==0 && room.retirements+2+[...room.players.values()].filter(p=>p.slot!==0).length>128-(room.mode==='ocean'?65:24))return null;
    const token=randomBytes(32).toString('base64url');
    const identity=randomBytes(8).toString('hex'),displayName=cleanName(name);
    if(room.protocol>=6){room.history.set(identity,{slot,name:displayName});if(slot!==0)room.retirements++;}
    room.players.set(token,{slot,identity,name:displayName,skin:room.protocol>=5?skin:Math.max(0,Math.min(31,Math.floor(Number(skin)||0))),seen:now(),lastExchange:0,input:{x:0,y:0,boost:0,chomp:0,...(room.protocol>=8?{chompAngle:0,chompLife:0}:{})}});
    return {code,token,slot,protocol:room.protocol,mode:room.mode,...(room.protocol>=5?{ruleset:room.ruleset}:{}),...(room.protocol>=6?{team:slot%2,spawnIndex:Math.floor(slot/2),...(matchClock(room)?{matchClock:matchClock(room)}:{})}:{})};
  }
  function removePlayer(room,token) {
    const p=room?.players.get(token);if(!p)return;
    if(room.protocol>=6&&p.slot!==0)room.retirements++;
    room.players.delete(token);
  }
  function outwardSnapshot(room) {
    const s=room.snapshot;if(!s||room.protocol<6||room.finalizedAt!=null)return s;
    const current=new Map([...room.players.values()].map(p=>[p.slot,p.identity]));
    return {...s,matchStats:s.matchStats.map(row=>({...row,connected:row.connected&&(row.isBot?!current.has(row.slot):current.get(row.slot)===row.participantID)}))};
  }
  function leavePlayer(code,room,token) {
    const player=room?.players.get(token);if(!player)return;
    if(player.slot===0 && !(room.protocol>=6&&room.finalizedAt!=null))rooms.delete(code);
    else removePlayer(room,token);
    if(room.protocol>=6&&room.finalizedAt!=null&&room.players.size===0)rooms.delete(code);
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
  const allowedSkin=(protocol,skin,mode)=>Number.isSafeInteger(skin)&&skin>=0&&skin<=rulesFor(protocol)?.maximumSkin&&(protocol<9||mode==='ocean'||skin<40||skin===43);
  const validConfigured=b=>rulesFor(b.protocol)&&b.ruleset===rulesFor(b.protocol).id&&allowedSkin(b.protocol,b.skin,b.mode);
  function admissionTicketActive(e) {
    return !!e.ticket && rooms.get(e.ticket.code)?.players.has(e.ticket.token);
  }
  function publicOpen(room,mode,protocol=5,ruleset=LEGACY_RULESET.id) {
    if(!room.isPublic || room.protocol!==protocol || room.ruleset!==ruleset || room.mode!==mode || room.players.size>=4 || room.snapshot?.roundResult!=null)return false;
    if(room.protocol>=9&&room.mode==='team'&&room.snapshot){const used=new Set([...room.players.values()].map(p=>p.slot));if(![0,1,2,3].some(slot=>!used.has(slot)&&living(room.snapshot.fish[slot])))return false;}
    if(room.protocol>=6&&room.retirements+2+[...room.players.values()].filter(p=>p.slot!==0).length>128-(room.mode==='ocean'?65:24))return false;
    // Do not send a new guest to a host whose world stopped advancing.
    if(now()-room.worldAdvancedAt>3000)return false;
    // No late entry into a competitive round: both host elapsed time and wall time count.
    return mode==='ocean' || endlessKing(room) || Math.max((now()-room.created)/1000,room.snapshot?.elapsed??0)<CHOMP_RULESET.competitiveJoinSeconds;
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
    if (path==='/v1/chomp/health' && req.method==='GET') {reply(res,200,{ok:true,protocol:4,compatibleProtocols:[1,2,3,4,5,6,7,8,9,10,11,12],latestProtocol:12,mode:'private-hosted-playtest',maxPlayers:4});return true;}
    if(path==='/v1/chomp/capabilities'&&req.method==='GET'){reply(res,200,{protocols:[1,2,3,4,5,6,7,8,9,10,11,12],rulesets:[LEGACY_RULESET.id,CHOMP_RULESET.id,SWIM_RULESET.id,CLAW_RULESET.id,ELIMINATION_RULESET.id,ENDLESS_RULESET.id,OCEAN_RULESET.id,SCHOOL_RULESET.id],catalog:CHOMP_RULESET.catalog,catalogs:[2,3,4],maximumSkin:SCHOOL_RULESET.maximumSkin,immediatePublic:true,maxPlayers:4,maxRooms,competitiveJoinSeconds:CHOMP_RULESET.competitiveJoinSeconds,endlessKingProtocols:[10,11,12]});return true;}
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
        if (![1,2,3,4,5,6,7,8,9,10,11,12].includes(b.protocol)) {reply(res,409,{error:'Update chomp chomp.io on both phones.'});return true;}
        if(b.protocol>=5 && (!validConfigured(b)||!modes.includes(b.mode))){reply(res,409,{error:'This ruleset or skin catalog is not supported. Update the game.'});return true;}
        let room,code;
        if (path==='/v1/chomp/rooms' ) {
          if (rooms.size>=maxRooms) {reply(res,503,{error:'Test rooms are full. Try again shortly.'});return true;}
          ({code,room}=newRoom(b.protocol,b.protocol>=3&&modes.includes(b.mode)?b.mode:'ocean',b.protocol>=5?b.ruleset:null));
        } else {code=String(b.code||'').toUpperCase();room=rooms.get(code);}
        if (!room) {reply(res,404,{error:'That room has closed. Ask the host for a new code.'});return true;}
        if(room.protocol!==b.protocol || b.protocol>=5&&room.ruleset!==b.ruleset) {reply(res,409,{error:"Update chomp chomp.io on both phones before joining this room."});return true;}
        if(room.protocol>=9&&!allowedSkin(room.protocol,b.skin,room.mode)){reply(res,409,{error:'Crabs are available in Ocean only.'});return true;}
        if(room.protocol>=6 && (room.finalizedAt!=null || timedRoom(room)&&now()>=room.created+180000)) {finalizeDeadline(room);reply(res,409,{error:'That match has finished. Start a new match.'});return true;}
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
      if(room.protocol>=8 && (input.chompAngle!=null && (!Number.isFinite(input.chompAngle)||Math.abs(input.chompAngle)>Math.PI) || room.protocol>=8 && input.chompLife!=null && (!Number.isSafeInteger(input.chompLife)||input.chompLife<0||input.chompLife>100000)))throw new Error('Invalid claw controls');
      if(room.protocol>=8 && player.skin>=40 && input.chomp>player.input.chomp && (input.chompAngle==null||input.chompLife==null))throw new Error('Missing claw release');
      // Lost/repeated packets cannot replay an ability; host consumes monotonic counters once.
      const clawEvent=room.protocol>=8 ? (input.chomp>player.input.chomp ? {chompAngle:input.chompAngle??0,chompLife:input.chompLife??0}:{chompAngle:player.input.chompAngle,chompLife:player.input.chompLife}):{};
      player.input={x:input.x,y:input.y,boost:Math.max(player.input.boost,input.boost),chomp:Math.max(player.input.chomp,input.chomp),...clawEvent};
      if(player.slot===0) {
        room.hostSeen=now();
        if(b.snapshot) {
          if(!validateSnapshot(b.snapshot,room.protocol,room.ruleset)||(room.protocol>=3&&b.snapshot.mode!==room.mode)||room.protocol>=6&&!validIdentities(room,b.snapshot.matchStats))throw new Error('Invalid world snapshot');
          // After the deadline, retain the last accepted combat ledger. A
          // packet already in flight can complete without reopening the match.
          if(!(room.protocol>=6&&room.snapshot?.roundResult!=null)) {
            if(room.protocol>=6) {
              if(room.snapshot && b.snapshot.elapsed<room.snapshot.elapsed || !monotonicMatchStats(room.snapshot?.matchStats,b.snapshot.matchStats))throw new Error('Reversed match state');
              if(room.protocol===12&&room.snapshot&&!validPlantTransition(room.snapshot,b.snapshot))throw new Error('Reversed plant state');
              if(endlessKing(room)&&!validCrownTransition(room.snapshot,b.snapshot))throw new Error('Invalid crown transition');
              if(room.protocol>=9&&room.mode==='team') {
                if(room.snapshot && room.snapshot.fish.some((f,i)=>!living(f)&&living(b.snapshot.fish[i])))throw new Error('Eliminated slots cannot respawn');
                b.snapshot.roundResult=eliminationResult(b.snapshot,now()>=room.created+180000);
              } else if(room.mode==='team') {
                const scores=[0,1].map(team=>b.snapshot.matchStats.filter(r=>r.team===team).reduce((sum,r)=>sum+r.kills,0));
                b.snapshot.roundResult=now()>=room.created+180000||Math.max(...scores)>=25?(scores[0]===scores[1]?'DRAW':scores[0]>scores[1]?'BLUE TEAM WINS':'RED TEAM WINS'):null;
              }
            }
            if(!room.snapshot||b.snapshot.elapsed>room.snapshot.elapsed)room.worldAdvancedAt=now();room.snapshot=b.snapshot;room.revision++;
          }
          finalizeDeadline(room);
          if(room.protocol>=6&&room.snapshot?.roundResult!=null&&room.finalizedAt==null){room.snapshot=outwardSnapshot(room);room.finalizedAt=now();}
        }
      } else if(b.snapshot) {reply(res,403,{error:'Only the host can send the world.'});return true;}
      const players=[...room.players.values()].map(p=>({slot:p.slot,identity:p.identity,name:p.name,skin:p.skin,...(room.protocol>=6?{team:p.slot%2,spawnIndex:Math.floor(p.slot/2)}:{}),input:now()-p.seen>1200?{...p.input,x:0,y:0}:p.input}));
      reply(res,200,{revision:room.revision,players,snapshot:player.slot===0&&!(room.protocol>=6&&room.snapshot?.roundResult!=null)?null:outwardSnapshot(room),...(matchClock(room)?{matchClock:matchClock(room)}:{}),...(room.protocol>=6?{roundResult:room.snapshot?.roundResult??null}:{})});return true;
    } catch(error) {reply(res,400,{error:'Invalid or oversized room request.'});return true;}
  };
}
