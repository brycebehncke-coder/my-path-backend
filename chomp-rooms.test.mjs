import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createChompRooms,validSchoolWorld,schoolPlantSites,reefPlantSites,reefPlantCells} from './chomp-rooms.mjs';

async function fixture(fn,options={}) {
  const handle=createChompRooms(options);
  const server=createServer(async(req,res)=>{if(!await handle(req,res)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body,token)=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  try {await fn(call);} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
}
const join={name:'Nemo',skin:31,protocol:1},input={x:1,y:0,boost:0,chomp:0};
const world=()=>({protocol:1,elapsed:0,fish:Array.from({length:29},(_,id)=>({id,name:'Fish',position:{x:10,y:20},mass:64,capacity:64})),food:[],circles:[],surface:{displacement:Array(860).fill(0),velocity:Array(860).fill(0)}});
test('private rooms carry two players, input and exact host snapshots',async()=>{
 let time=100000;await fixture(async call=>{
  assert.equal((await call('/v1/chomp/health')).body.protocol,4);
  const host=(await call('/v1/chomp/rooms',join)).body;
  const guest=(await call('/v1/chomp/join',{...join,name:'Coral',code:host.code})).body;
  assert.equal(guest.slot,1);assert.notEqual(host.token,guest.token);
  const snapshot=world();snapshot.fish[1].position.x=31;
  const sent=await call('/v1/chomp/exchange',{code:host.code,input,snapshot},host.token);
  assert.equal(sent.status,200);assert.equal(sent.body.players.length,2);assert.equal(sent.body.snapshot,null);
  const got=await call('/v1/chomp/exchange',{code:host.code,input:{...input,x:-1,chomp:1}},guest.token);
  assert.deepEqual(got.body.snapshot,snapshot);
  time+=130;
  const controls=await call('/v1/chomp/exchange',{code:host.code,input},host.token);
  assert.equal(controls.body.players.find(p=>p.slot===1).input.chomp,1);
  assert.equal(controls.body.players.find(p=>p.slot===1).input.x,-1);
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input},'wrong')).status,410);
  time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot},guest.token)).status,403);
  assert.equal((await call('/v1/chomp/leave',{code:host.code},host.token)).status,200);
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input},guest.token)).status,410);
 },{now:()=>time});
});
test('four-player limit, room cap, wrong code, version and invalid controls',async()=>{
 let time=200000;await fixture(async call=>{
  assert.equal((await call('/v1/chomp/rooms',{...join,protocol:0})).status,409);
  assert.equal((await call('/v1/chomp/join',{...join,code:'WRONG'})).status,404);
  const host=(await call('/v1/chomp/rooms',join)).body;
  for(let i=1;i<4;i++)assert.equal((await call('/v1/chomp/join',{...join,code:host.code})).body.slot,i);
  assert.equal((await call('/v1/chomp/join',{...join,code:host.code})).status,409);
  assert.equal((await call('/v1/chomp/rooms',join)).status,503);
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input:{...input,x:2}},host.token)).status,400);
  time+=130;
  const invalid=world();invalid.fish[0].capacity=-1;
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:invalid},host.token)).status,400);
 },{maxRooms:1,now:()=>time});
});
test('idle controls stop and host disconnect expires the room',async()=>{
 let time=300000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',join)).body,g=(await call('/v1/chomp/join',{...join,code:h.code})).body;
  await call('/v1/chomp/exchange',{code:h.code,input},g.token);time+=1500;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token);
  assert.equal(r.body.players.find(p=>p.slot===g.slot).input.x,0);
  time+=12001;assert.equal((await call('/v1/chomp/join',{...join,code:h.code})).status,404);
 },{now:()=>time});
});
test('request and admission limits bound memory',async()=>{
 await fixture(async call=>{
  assert.equal((await call('/v1/chomp/rooms',{...join,padding:'x'.repeat(786432)})).status,400);
  let status=0;for(let i=0;i<65;i++)status=(await call('/v1/chomp/join',{...join,code:'BAD'})).status;
  assert.equal(status,429);
 });
});

test('protocol 2 dense ocean and hazards relay without breaking old rooms',async()=>{
 let time=400000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',{...join,protocol:2})).body;
  assert.equal((await call('/v1/chomp/join',{...join,code:h.code})).status,409);
  const g=(await call('/v1/chomp/join',{...join,protocol:2,code:h.code})).body;
  const snapshot={...world(),protocol:2,fish:Array.from({length:65},(_,id)=>({...world().fish[0],id})),food:Array.from({length:6000},(_,id)=>[id,5000,20000,1,6]),mines:[{id:0,position:{x:20,y:20}}]};
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot},h.token)).status,200);
  const received=await call('/v1/chomp/exchange',{code:h.code,input},g.token);
  assert.equal(received.body.snapshot.mines.length,1);assert.equal(received.body.snapshot.food.length,6000);
  time+=200;snapshot.mines=Array(41).fill(snapshot.mines[0]);
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot},h.token)).status,400);
  const old=(await call('/v1/chomp/rooms',join)).body;
  assert.equal((await call('/v1/chomp/exchange',{code:old.code,input,snapshot:world()},old.token)).status,200);
 },{now:()=>time});
});

test('protocol 3 preserves modes, teams, respawns, crowns and brown food in rooms',async()=>{
 let time=400000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',{...join,protocol:3,mode:'team'})).body;
  assert.equal(h.mode,'team');const g=(await call('/v1/chomp/join',{...join,protocol:3,mode:'king',code:h.code})).body;assert.equal(g.mode,'team');
  const snapshot={...world(),protocol:3,fish:Array.from({length:65},(_,id)=>({...world().fish[0],id})),food:[[1,5000,20000,1,7],[2,6000,20000,1,8]],mines:[],mode:'team',crownTimes:Array(65).fill(0),roundResult:null};
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot},h.token)).status,200);
  const received=await call('/v1/chomp/exchange',{code:h.code,input},g.token);assert.equal(received.body.snapshot.mode,'team');assert.equal(received.body.snapshot.food[0][4],7);
  time+=200;snapshot.mode='king';assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot},h.token)).status,400);
  snapshot.mode='team';time+=200;snapshot.crownTimes[0]=999;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot},h.token)).status,400);
  assert.equal((await call('/v1/chomp/join',{...join,protocol:2,code:h.code})).status,409);
 },{now:()=>time});
});

const queueJoin=(mode='king',i=1)=>({name:'Queued '+i,skin:i,protocol:4,mode,requestID:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`});
const newWorld=(mode='king')=>({...world(),protocol:4,mode,fish:Array.from({length:mode==='ocean'?65:24},(_,id)=>({...world().fish[0],id})),food:[],mines:[],crownTimes:Array(mode==='ocean'?65:24).fill(0),roundResult:null,surface:{displacement:Array(mode==='ocean'?860:609).fill(0),velocity:Array(mode==='ocean'?860:609).fill(0)}});
test('real queued counts and one shared deadline admit two people into the same mode and room',async()=>{
 let time=119000;await fixture(async call=>{
  const before=(await call('/v1/chomp/lobbies')).body;assert.equal(before.modes.length,4);assert.ok(before.modes.every(m=>m.queued===0&&m.startsAt===120000));
  const a=(await call('/v1/chomp/queue',queueJoin())).body,b=(await call('/v1/chomp/queue',queueJoin('king',2))).body;
  assert.equal((await call('/v1/chomp/queue',queueJoin())).body.queueToken,a.queueToken,'idempotent join');
  assert.equal(b.modes.find(m=>m.mode==='king').queued,2);assert.equal(b.ticket,null);
  const state=(await call('/v1/chomp/lobbies')).body;assert.equal(JSON.stringify(state).includes(a.queueToken),false);
  time=120001;
  const ha=(await call('/v1/chomp/queue/status',{},a.queueToken)).body,hb=(await call('/v1/chomp/queue/status',{},b.queueToken)).body;
  assert.equal(ha.ticket.code,hb.ticket.code);assert.equal(ha.ticket.slot,0);assert.equal(hb.ticket.slot,1);assert.equal(ha.ticket.mode,'king');
  assert.equal(ha.modes.find(m=>m.mode==='king').queued,0);assert.equal(ha.modes[0].startsAt,150000);
  assert.equal((await call('/v1/chomp/exchange',{code:ha.ticket.code,input,snapshot:newWorld()},ha.ticket.token)).status,200);
  assert.equal((await call('/v1/chomp/exchange',{code:hb.ticket.code,input},hb.ticket.token)).body.snapshot.fish.length,24);
 },{now:()=>time});
});
test('cancel, stale participants, invalid credentials and separate modes never inflate counts',async()=>{
 let time=100000;await fixture(async call=>{
  const a=(await call('/v1/chomp/queue',queueJoin())).body;
  assert.equal((await call('/v1/chomp/queue/status',{},'wrong')).status,410);
  const b=(await call('/v1/chomp/queue',queueJoin('team',2))).body;
  await call('/v1/chomp/queue/leave',{},a.queueToken);
  assert.equal((await call('/v1/chomp/lobbies')).body.modes.find(m=>m.mode==='king').queued,0);
  time+=12001;assert.equal((await call('/v1/chomp/queue/status',{},b.queueToken)).status,410);
  assert.ok((await call('/v1/chomp/lobbies')).body.modes.every(m=>m.queued===0));
  assert.equal((await call('/v1/chomp/queue',{...queueJoin(),protocol:3})).status,400);
  assert.equal((await call('/v1/chomp/queue',{...queueJoin(),mode:'wrong'})).status,400);
 },{now:()=>time});
});
test('queue capacities and busy server defer actual starts without inventing rooms',async()=>{
 let time=119000;await fixture(async call=>{
  const host=(await call('/v1/chomp/rooms',{...join,protocol:4})).body;
  const queued=[];for(let i=0;i<4;i++)queued.push((await call('/v1/chomp/queue',queueJoin('deathmatch',i+1))).body);
  assert.equal((await call('/v1/chomp/queue',queueJoin('deathmatch',9))).status,409);
  time=120001;const waiting=(await call('/v1/chomp/queue/status',{},queued[0].queueToken)).body;
  assert.equal(waiting.ticket,null);assert.equal(waiting.modes.find(m=>m.mode==='deathmatch').startsAt,150000);assert.equal(waiting.modes.find(m=>m.mode==='deathmatch').capacityWait,true);
  await call('/v1/chomp/leave',{code:host.code},host.token);
  // Keep only the first queue participant present until the next real start.
  for(time=125000;time<150000;time+=5000)await call('/v1/chomp/queue/status',{},queued[0].queueToken);
  const admitted=(await call('/v1/chomp/queue/status',{},queued[0].queueToken)).body;assert.equal(admitted.ticket.slot,0);
  assert.equal((await call('/v1/chomp/queue/leave',{},queued[0].queueToken)).status,200);
  assert.equal((await call('/v1/chomp/exchange',{code:admitted.ticket.code,input},admitted.ticket.token)).status,410);
 },{now:()=>time,maxRooms:1});
});
test('protocol four uses the selected map population and wave width while old clients remain separate',async()=>{
 let time=200000;await fixture(async call=>{
  for(const mode of ['ocean','king','deathmatch','team']) {
   const h=(await call('/v1/chomp/rooms',{...join,protocol:4,mode})).body;
   assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:newWorld(mode)},h.token)).status,200);
   time+=100;const bad=newWorld(mode);bad.surface.displacement.pop();assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:bad},h.token)).status,400);
   time+=100;const badCount=newWorld(mode);badCount.fish.pop();assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:badCount},h.token)).status,400);
   assert.equal((await call('/v1/chomp/join',{...join,protocol:3,code:h.code})).status,409);
   await call('/v1/chomp/leave',{code:h.code},h.token);
  }
 },{now:()=>time});
});

// Additive v5 fixtures. The protocol 1–4 fixtures above retain their original values.
const immediateJoin=(mode='king',i=1)=>({...queueJoin(mode,i),protocol:5,ruleset:'chomp-quarter-v1',skin:39});
const quarterWorld=(mode='king')=>({...newWorld(mode),protocol:5,ruleset:'chomp-quarter-v1',fish:newWorld(mode).fish.map(f=>({...f,skinID:39})),surface:{displacement:Array(mode==='ocean'?860:431).fill(0),velocity:Array(mode==='ocean'?860:431).fill(0)}});

test('v5 capability and immediate public admission need no countdown or human minimum',async()=>{
 let time=119000;await fixture(async call=>{
  const capability=(await call('/v1/chomp/capabilities')).body;
  assert.deepEqual(capability.protocols,[1,2,3,4,5,6,7,8,9,10,11,12,13]);assert.ok(capability.rulesets.includes('chomp-quarter-v1'));assert.equal(capability.maximumSkin,43);assert.equal(capability.immediatePublic,true);
  const a=(await call('/v1/chomp/match',immediateJoin())).body;
  assert.equal(a.intervalSeconds,0);assert.ok(a.ticket);assert.equal(a.ticket.slot,0);assert.equal(a.ticket.ruleset,'chomp-quarter-v1');
  assert.equal(a.modes.find(m=>m.mode==='king').humans,1,'only a real person is counted; the host simulates the remaining fish as bots');
  assert.ok(a.modes.every(m=>m.queued===0));
  const repeat=(await call('/v1/chomp/match',immediateJoin())).body;
  assert.deepEqual(repeat.ticket,a.ticket);assert.equal(repeat.queueToken,a.queueToken);
  const guest=(await call('/v1/chomp/match',immediateJoin('king',2))).body;
  assert.equal(guest.ticket.code,a.ticket.code);assert.equal(guest.ticket.slot,1);
  assert.equal(guest.modes.find(m=>m.mode==='king').humans,2);
  assert.equal((await call('/v1/chomp/exchange',{code:a.ticket.code,input,snapshot:quarterWorld()},a.ticket.token)).status,200);
  const remote=await call('/v1/chomp/exchange',{code:guest.ticket.code,input},guest.ticket.token);
  assert.equal(remote.body.snapshot.fish.length,24);assert.equal(remote.body.snapshot.surface.displacement.length,431);
  assert.equal(remote.body.players.length,2);assert.equal(new Set(remote.body.players.map(p=>p.identity)).size,2);
  const legacy=(await call('/v1/chomp/lobbies')).body;assert.equal(legacy.intervalSeconds,30);assert.ok(legacy.modes.every(m=>m.queued===0));
 },{now:()=>time});
});

test('v5 public routing isolates private rooms and modes and enforces four-human and shared room caps',async()=>{
 let time=200000;await fixture(async call=>{
  const privateRoom=(await call('/v1/chomp/rooms',immediateJoin())).body;
  const requests=[];for(let i=1;i<=4;i++)requests.push((await call('/v1/chomp/match',immediateJoin('king',i))).body);
  assert.notEqual(requests[0].ticket.code,privateRoom.code);assert.deepEqual(requests.map(r=>r.ticket.slot),[0,1,2,3]);
  assert.ok(requests.every(r=>r.ticket.code===requests[0].ticket.code));
  assert.equal((await call('/v1/chomp/match',immediateJoin('king',5))).status,503);
  assert.equal((await call('/v1/chomp/match',immediateJoin('team',6))).status,503);
  assert.equal((await call('/v1/chomp/matches')).body.modes.find(m=>m.mode==='king').capacityWait,true);
  await call('/v1/chomp/match/leave',{},requests[2].queueToken);
  const replacement=(await call('/v1/chomp/match',immediateJoin('king',7))).body;
  assert.equal(replacement.ticket.code,requests[0].ticket.code);assert.equal(replacement.ticket.slot,2);
  await call('/v1/chomp/leave',{code:privateRoom.code},privateRoom.token);
  const team=(await call('/v1/chomp/match',immediateJoin('team',8))).body;
  assert.notEqual(team.ticket.code,replacement.ticket.code);assert.equal(team.ticket.mode,'team');
 },{now:()=>time,maxRooms:2});
});

test('v5 canceled, lost-response and changed requests cannot admit duplicate players',async()=>{
 let time=100000;await fixture(async call=>{
  const request=immediateJoin(),a=(await call('/v1/chomp/match',request)).body;
  assert.equal((await call('/v1/chomp/match',{...request,mode:'team'})).status,409);
  assert.equal((await call('/v1/chomp/match',{...request,skin:38})).status,409);
  assert.equal((await call('/v1/chomp/match/status',{},'wrong')).status,410);
  // Caller knows its UUID even when the admission reply is lost.
  assert.equal((await call('/v1/chomp/match/cancel',{requestID:request.requestID})).status,200);
  assert.equal((await call('/v1/chomp/match/cancel',{requestID:request.requestID})).status,200);
  assert.equal((await call('/v1/chomp/match',request)).status,410);
  assert.equal((await call('/v1/chomp/exchange',{code:a.ticket.code,input},a.ticket.token)).status,410);
  const raced=immediateJoin('king',2);
  await call('/v1/chomp/match/cancel',{requestID:raced.requestID});
  assert.equal((await call('/v1/chomp/match',raced)).status,410,'cancel-before-admit leaves a bounded tombstone');
  const next=(await call('/v1/chomp/match',immediateJoin('king',3))).body;
  await call('/v1/chomp/match/leave',{},next.queueToken);await call('/v1/chomp/match/leave',{},next.queueToken);
  assert.equal((await call('/v1/chomp/match/status',{},next.queueToken)).status,410);
 },{now:()=>time,maxRooms:1});
});

test('v5 room expiry and slot replacement expose a new occupant identity to guests',async()=>{
 let time=100000;await fixture(async call=>{
  const host=(await call('/v1/chomp/match',immediateJoin())).body;
  const guest=(await call('/v1/chomp/match',immediateJoin('king',2))).body;
  const first=await call('/v1/chomp/exchange',{code:host.ticket.code,input,snapshot:quarterWorld()},host.ticket.token);
  const oldIdentity=first.body.players.find(p=>p.slot===1).identity;
  time+=7000;await call('/v1/chomp/exchange',{code:host.ticket.code,input},host.ticket.token);
  time+=6000;
  const advancing=quarterWorld();advancing.elapsed=13;await call('/v1/chomp/exchange',{code:host.ticket.code,input,snapshot:advancing},host.ticket.token);
  const next=(await call('/v1/chomp/match',immediateJoin('king',3))).body;
  assert.equal(next.ticket.slot,1);assert.equal(next.ticket.code,host.ticket.code);
  const roster=await call('/v1/chomp/exchange',{code:host.ticket.code,input},next.ticket.token);
  assert.notEqual(roster.body.players.find(p=>p.slot===1).identity,oldIdentity);
  assert.equal((await call('/v1/chomp/match/status',{},guest.queueToken)).status,410);
  time+=12001;
  assert.equal((await call('/v1/chomp/match/status',{},host.queueToken)).status,410);
  assert.equal((await call('/v1/chomp/match',immediateJoin())).status,410,'expired admission does not silently reopen');
 },{now:()=>time});
});

test('competitive admission closes at 30 seconds or a result while Ocean remains joinable',async()=>{
 let time=100000;await fixture(async call=>{
  const host=(await call('/v1/chomp/match',immediateJoin())).body;
  const ended=quarterWorld();ended.roundResult='Coral wins';
  await call('/v1/chomp/exchange',{code:host.ticket.code,input,snapshot:ended},host.ticket.token);
  assert.equal((await call('/v1/chomp/match',immediateJoin('king',2))).status,503);
  await call('/v1/chomp/match/leave',{},host.queueToken);
  const round=(await call('/v1/chomp/match',immediateJoin('team',3))).body;
  const snapshot=quarterWorld('team');snapshot.elapsed=30;
  await call('/v1/chomp/exchange',{code:round.ticket.code,input,snapshot},round.ticket.token);
  assert.equal((await call('/v1/chomp/match',immediateJoin('team',4))).status,503);
  await call('/v1/chomp/match/leave',{},round.queueToken);
  const wall=(await call('/v1/chomp/match',immediateJoin('deathmatch',5))).body;
  for(let i=0;i<3;i++){time+=10000;const slow=quarterWorld('deathmatch');slow.elapsed=i+1;await call('/v1/chomp/exchange',{code:wall.ticket.code,input,snapshot:slow},wall.ticket.token);}
  assert.equal((await call('/v1/chomp/match',immediateJoin('deathmatch',6))).status,503,'wall time also closes a slowly advancing host round');
  await call('/v1/chomp/match/leave',{},wall.queueToken);
  const ocean=(await call('/v1/chomp/match',immediateJoin('ocean',7))).body;
  const ongoing=quarterWorld('ocean');ongoing.elapsed=60;
  await call('/v1/chomp/exchange',{code:ocean.ticket.code,input,snapshot:ongoing},ocean.ticket.token);
  const joined=(await call('/v1/chomp/match',immediateJoin('ocean',8))).body;
  assert.equal(joined.ticket.code,ocean.ticket.code);assert.equal(joined.ticket.slot,1);
 },{now:()=>time,maxRooms:1});
});

test('v5 validates exact ruleset, mode, wave geometry, skin catalog and finite wave state',async()=>{
 let time=100000;await fixture(async call=>{
  assert.equal((await call('/v1/chomp/match',{...immediateJoin(),ruleset:'unknown'})).status,409);
  assert.equal((await call('/v1/chomp/rooms',{...immediateJoin(),skin:40})).status,409);
  assert.equal((await call('/v1/chomp/rooms',{...immediateJoin(),skin:-1})).status,409);
  assert.equal((await call('/v1/chomp/rooms',{...immediateJoin(),skin:1.5})).status,409);
  for(const mode of ['ocean','king','deathmatch','team']) {
   const host=(await call('/v1/chomp/rooms',immediateJoin(mode))).body;
   assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:quarterWorld(mode)},host.token)).status,200);
   assert.equal((await call('/v1/chomp/join',{...join,protocol:4,code:host.code})).status,409);
   for(const mutate of [s=>{s.ruleset='other'},s=>{s.protocol=4},s=>{s.mode=mode==='ocean'?'king':'ocean'},s=>{s.surface.displacement=Array(609).fill(0);s.surface.velocity=Array(609).fill(0)},s=>{s.surface.velocity[0]=null},s=>{s.fish[0].skinID=40}]) {
    time+=100;const snapshot=quarterWorld(mode);mutate(snapshot);
    assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot},host.token)).status,400);
   }
   await call('/v1/chomp/leave',{code:host.code},host.token);
  }
  const old=(await call('/v1/chomp/rooms',{...join,protocol:4,mode:'king'})).body;
  assert.equal((await call('/v1/chomp/join',{...immediateJoin(),code:old.code})).status,409);
  assert.equal((await call('/v1/chomp/exchange',{code:old.code,input,snapshot:newWorld()},old.token)).status,200,'unchanged 609-wave legacy room remains valid');
 },{now:()=>time});
});


test('public admission does not place newcomers into a frozen host world',async()=>{
 let time=100000;await fixture(async call=>{
  const host=(await call('/v1/chomp/match',immediateJoin('ocean'))).body;
  await call('/v1/chomp/exchange',{code:host.ticket.code,input,snapshot:quarterWorld('ocean')},host.ticket.token);
  time+=3001;
  await call('/v1/chomp/exchange',{code:host.ticket.code,input},host.ticket.token);
  assert.equal((await call('/v1/chomp/match',immediateJoin('ocean',2))).status,503,'presence alone does not make a stopped world playable');
  time+=100;const resumed=quarterWorld('ocean');resumed.elapsed=1;
  await call('/v1/chomp/exchange',{code:host.ticket.code,input,snapshot:resumed},host.ticket.token);
  assert.equal((await call('/v1/chomp/match',immediateJoin('ocean',3))).body.ticket.code,host.ticket.code);
 },{now:()=>time,maxRooms:1});
});

// Build20 protocol6 retains protocol1–5 tests above unchanged except capability superset.
const teamJoin=(mode='team',i=1)=>({...immediateJoin(mode,i),protocol:6,ruleset:'chomp-team-v2'});
const tacticalWorld=(roster,mode='team')=>{
 const s={...quarterWorld(mode),protocol:6,ruleset:'chomp-team-v2'};
 s.surface={displacement:Array(mode==='ocean'?860:mode==='team'?305:431).fill(0),velocity:Array(mode==='ocean'?860:mode==='team'?305:431).fill(0)};
 s.fish=s.fish.map(f=>({...f,name:roster.find(p=>p.slot===f.id)?.name??f.name,kills:0,deaths:0}));
 s.matchStats=s.fish.map(f=>{const p=roster.find(p=>p.slot===f.id);return {participantID:p?.identity??`bot:${f.id}`,slot:f.id,name:p?.name??f.name,team:f.id%2,kills:0,deaths:0,connected:true,isBot:!p};});
 return s;
};
const recordKill=(s,killer,victim)=>{s.matchStats.find(r=>r.slot===killer&&r.connected).kills++;s.matchStats.find(r=>r.slot===victim&&r.connected).deaths++;s.fish[killer].kills++;s.fish[victim].deaths++;};

test('v6 isolates public/private rooms from v5 and assigns mirrored team seats and one server clock',async()=>{
 let time=100000;await fixture(async call=>{
  const v5=(await call('/v1/chomp/match',immediateJoin('team',1))).body;
  const host=(await call('/v1/chomp/match',teamJoin('team',2))).body;
  assert.notEqual(v5.ticket.code,host.ticket.code);assert.equal(host.ticket.team,0);assert.equal(host.ticket.spawnIndex,0);
  assert.deepEqual(host.ticket.matchClock,{serverTime:100000,startsAt:100000,endsAt:280000});
  const people=[host.ticket];for(let n=3;n<=5;n++)people.push((await call('/v1/chomp/match',teamJoin('team',n))).body.ticket);
  assert.deepEqual(people.map(p=>[p.slot,p.team,p.spawnIndex]),[[0,0,0],[1,1,0],[2,0,1],[3,1,1]]);
  assert.equal((await call('/v1/chomp/join',{...immediateJoin('team',7),code:host.ticket.code})).status,409);
  const roster=await call('/v1/chomp/exchange',{code:host.ticket.code,input},host.ticket.token);
  assert.equal(roster.status,200);assert.ok(roster.body.players.every(p=>p.team===p.slot%2&&p.spawnIndex===Math.floor(p.slot/2)));
  time+=100;const s=tacticalWorld(roster.body.players);s.elapsed=0.1;
  assert.equal((await call('/v1/chomp/exchange',{code:host.ticket.code,input,snapshot:s},host.ticket.token)).status,200);
  const guest=await call('/v1/chomp/exchange',{code:host.ticket.code,input},people[1].token);
  assert.deepEqual(guest.body.snapshot,s);assert.equal(guest.body.matchClock.endsAt,280000);
  assert.equal((await call('/v1/chomp/match',teamJoin('team',2))).body.ticket.matchClock.endsAt,280000,'idempotent admission never restarts deadline');
 },{now:()=>time,maxRooms:3});
});

test('v6 validates exact per-mode waves, deaths, identity ledger, bounds and team attribution',async()=>{
 let time=100000;await fixture(async call=>{
  for(const mode of ['ocean','king','deathmatch','team']) {
   const h=(await call('/v1/chomp/rooms',teamJoin(mode))).body;
   const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token);time+=100;
   const s=tacticalWorld(r.body.players,mode);assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
   for(const mutate of [s=>delete s.matchStats,s=>s.matchStats[1].team=0,s=>s.matchStats[1].kills=-1,s=>s.matchStats[1].deaths=100001,s=>s.matchStats.push({...s.matchStats[0]}),s=>s.matchStats[0].participantID='forged-human',s=>s.matchStats[0].name='Impostor',s=>s.matchStats[1].participantID='bot:2',s=>s.fish[0].deaths=-1,s=>s.surface.displacement.pop(),s=>s.matchStats[2].kills=1]) {
    time+=100;const bad=structuredClone(s);mutate(bad);
    assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:bad},h.token)).status,400);
   }
   await call('/v1/chomp/leave',{code:h.code},h.token);
  }
 },{now:()=>time});
});

test('v6 duplicate packets do not double count; ledger totals never decrease or lose retired players',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin())).body;
  const g=(await call('/v1/chomp/join',{...teamJoin(),name:'Guest',code:h.code})).body;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
  recordKill(s,0,1);s.elapsed=1;time+=100;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  time+=100;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  const received=(await call('/v1/chomp/exchange',{code:h.code,input},g.token)).body.snapshot;
  assert.equal(received.matchStats.find(r=>r.slot===0).kills,1);
  time+=100;const reversed=structuredClone(s);reversed.matchStats[0].kills=0;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:reversed},h.token)).status,400);
  await call('/v1/chomp/leave',{code:h.code},g.token);
  time+=100;const retired=structuredClone(s);retired.elapsed=2;retired.matchStats[1].connected=false;retired.fish[1]={...retired.fish[1],name:'Replacement',kills:0,deaths:0};retired.matchStats.push({participantID:'bot:1:1',slot:1,name:'Replacement',team:1,kills:0,deaths:0,connected:true,isBot:true});
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:retired},h.token)).status,200);
  time+=100;const dropped=structuredClone(retired);dropped.matchStats.splice(1,1);
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:dropped},h.token)).status,400);
  const replacement=(await call('/v1/chomp/join',{...teamJoin(),name:'New Guest',code:h.code})).body;
  assert.equal(replacement.slot,1);assert.equal(replacement.matchClock.endsAt,h.matchClock.endsAt);
  const nextRoster=(await call('/v1/chomp/exchange',{code:h.code,input},replacement.token)).body.players;
  assert.notEqual(nextRoster.find(p=>p.slot===1).identity,r.body.players.find(p=>p.slot===1).identity);
  const outward=(await call('/v1/chomp/exchange',{code:h.code,input},h.token));
  // Rate limiting is still real; the identity/ledger checks never bypass it.
  assert.equal(outward.status,429);
 },{now:()=>time});
});

test('v6 score target derives result from ledger and freezes exact final world for host and guest',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin())).body,g=(await call('/v1/chomp/join',{...teamJoin(),code:h.code})).body;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
  s.roundResult='RED TEAM WINS';time+=100;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).body.roundResult,null,'premature forged result cannot end match');
  for(let n=0;n<25;n++)recordKill(s,0,1);s.elapsed=12;time+=100;
  const ended=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);
  assert.equal(ended.body.roundResult,'BLUE TEAM WINS');assert.equal(ended.body.snapshot.matchStats[0].kills,25);
  const guest=await call('/v1/chomp/exchange',{code:h.code,input},g.token);assert.deepEqual(guest.body.snapshot,ended.body.snapshot);
  time+=100;recordKill(s,1,0);s.elapsed=13;
  const frozen=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);
  assert.equal(frozen.status,200);assert.deepEqual(frozen.body.snapshot,ended.body.snapshot);
 },{now:()=>time});
});

test('v6 deadline finalizes win loss or draw from last accepted combat; reconnect never resets time',async()=>{
 for(const winner of [null,0,1]) {
  let time=100000;await fixture(async call=>{
   const h=(await call('/v1/chomp/rooms',teamJoin())).body,g=(await call('/v1/chomp/join',{...teamJoin(),code:h.code})).body;
   const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
   if(winner!==null)recordKill(s,winner,1-winner);
   for(let n=1;n<18;n++){time=100000+n*10000;s.elapsed=n*10;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);await call('/v1/chomp/exchange',{code:h.code,input},g.token);}
   time=280001;const ended=await call('/v1/chomp/exchange',{code:h.code,input},h.token);
   assert.equal(ended.body.roundResult,winner===null?'DRAW':winner===0?'BLUE TEAM WINS':'RED TEAM WINS');
   assert.equal(ended.body.matchClock.endsAt,280000);assert.equal(ended.body.snapshot.elapsed,170);
   const peer=await call('/v1/chomp/exchange',{code:h.code,input},g.token);assert.deepEqual(peer.body.snapshot,ended.body.snapshot);
   time+=100;const reconnect=await call('/v1/chomp/exchange',{code:h.code,input},g.token);assert.equal(reconnect.body.matchClock.endsAt,280000);
  },{now:()=>time});
 }
});

test('v6 disconnect normalization does not mutate frozen combat or let a replacement inherit kills',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin())).body,g=(await call('/v1/chomp/join',{...teamJoin(),code:h.code})).body;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
  recordKill(s,1,0);time+=100;await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);
  await call('/v1/chomp/leave',{code:h.code},g.token);
  const replacement=(await call('/v1/chomp/join',{...teamJoin(),code:h.code,name:'New'},h.token)).body;
  const stale=await call('/v1/chomp/exchange',{code:h.code,input},replacement.token);
  assert.equal(stale.body.snapshot.matchStats[1].connected,false);assert.equal(stale.body.snapshot.matchStats[1].kills,1);
  assert.equal(stale.body.snapshot.matchStats.some(row=>row.participantID===stale.body.players.find(p=>p.slot===1).identity),false,'new identity has no inherited ledger');
 },{now:()=>time});
});

test('v6 public late admission closes on wall time and a new request never reuses a v5 room',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/match',teamJoin())).body;
  for(let n=1;n<=3;n++){time+=10000;await call('/v1/chomp/exchange',{code:h.ticket.code,input},h.ticket.token);}
  assert.equal((await call('/v1/chomp/match',teamJoin('team',2))).status,503);
  assert.equal((await call('/v1/chomp/match',immediateJoin('team',3))).status,503);
 },{now:()=>time,maxRooms:1});
});

test('v6 historical row budget reserves disconnect replacements and keeps identity history bounded',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin('ocean'))).body;
  // 31 arrivals + 31 departures consume62 retired rows; reserve prevents64.
  for(let n=0;n<31;n++) {
   time+=2500;await call('/v1/chomp/exchange',{code:h.code,input},h.token);
   const g=await call('/v1/chomp/join',{...teamJoin('ocean'),code:h.code});assert.equal(g.status,200);
   assert.equal((await call('/v1/chomp/leave',{code:h.code},g.body.token)).status,200);
  }
  assert.equal((await call('/v1/chomp/join',{...teamJoin('ocean'),code:h.code})).status,409);
 },{now:()=>time});
});

test('v6 final world survives host leave for pending guests then expires within60seconds',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin())).body,g=(await call('/v1/chomp/join',{...teamJoin(),code:h.code})).body;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
  for(let n=0;n<25;n++)recordKill(s,0,1);time+=100;
  const final=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);
  assert.equal(final.body.roundResult,'BLUE TEAM WINS');
  await call('/v1/chomp/leave',{code:h.code},h.token);time+=13000;
  const delayed=await call('/v1/chomp/exchange',{code:h.code,input},g.token);
  assert.equal(delayed.status,200);assert.deepEqual(delayed.body.snapshot,final.body.snapshot);
  assert.equal((await call('/v1/chomp/join',{...teamJoin(),code:h.code})).status,409,'ended room cannot acquire a new host');
  time=160101;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input},g.token)).status,410);
  const legacy=(await call('/v1/chomp/rooms',immediateJoin())).body,oldGuest=(await call('/v1/chomp/join',{...immediateJoin(),code:legacy.code})).body;
  await call('/v1/chomp/leave',{code:legacy.code},legacy.token);
  assert.equal((await call('/v1/chomp/exchange',{code:legacy.code,input},oldGuest.token)).status,410,'legacy host leave still closes immediately');
 },{now:()=>time});
});

test('v6 private admission cannot bypass elapsed deadline before first final exchange',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin())).body;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
  for(let n=1;n<18;n++){time=100000+n*10000;s.elapsed=n*10;await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);}
  time=280001;const denied=await call('/v1/chomp/join',{...teamJoin(),code:h.code,name:'Too late'});
  assert.equal(denied.status,409);
  const final=await call('/v1/chomp/exchange',{code:h.code,input},h.token);
  assert.equal(final.body.players.length,1);assert.equal(final.body.snapshot.matchStats.length,24);assert.equal(final.body.roundResult,'DRAW');
 },{now:()=>time});
});

// Run the full identity/deadline/result regression set against isolated v7 too.
{
const teamJoin=(mode='team',i=1)=>({...immediateJoin(mode,i),protocol:7,ruleset:'chomp-swim-v3'});
const tacticalWorld=(roster,mode='team')=>{
 const s={...quarterWorld(mode),protocol:7,ruleset:'chomp-swim-v3'};
 s.surface={displacement:Array(mode==='ocean'?860:mode==='team'?305:431).fill(0),velocity:Array(mode==='ocean'?860:mode==='team'?305:431).fill(0)};
 s.fish=s.fish.map(f=>({...f,name:roster.find(p=>p.slot===f.id)?.name??f.name,kills:0,deaths:0}));
 s.matchStats=s.fish.map(f=>{const p=roster.find(p=>p.slot===f.id);return {participantID:p?.identity??`bot:${f.id}`,slot:f.id,name:p?.name??f.name,team:f.id%2,kills:0,deaths:0,connected:true,isBot:!p};});
 return s;
};
const recordKill=(s,killer,victim)=>{s.matchStats.find(r=>r.slot===killer&&r.connected).kills++;s.matchStats.find(r=>r.slot===victim&&r.connected).deaths++;s.fish[killer].kills++;s.fish[victim].deaths++;};

test('v7 isolates public/private rooms from v5 and assigns mirrored team seats and one server clock',async()=>{
 let time=100000;await fixture(async call=>{
  const v5=(await call('/v1/chomp/match',immediateJoin('team',1))).body;
  const host=(await call('/v1/chomp/match',teamJoin('team',2))).body;
  assert.notEqual(v5.ticket.code,host.ticket.code);assert.equal(host.ticket.team,0);assert.equal(host.ticket.spawnIndex,0);
  assert.deepEqual(host.ticket.matchClock,{serverTime:100000,startsAt:100000,endsAt:280000});
  const people=[host.ticket];for(let n=3;n<=5;n++)people.push((await call('/v1/chomp/match',teamJoin('team',n))).body.ticket);
  assert.deepEqual(people.map(p=>[p.slot,p.team,p.spawnIndex]),[[0,0,0],[1,1,0],[2,0,1],[3,1,1]]);
  assert.equal((await call('/v1/chomp/join',{...immediateJoin('team',7),code:host.ticket.code})).status,409);
  const roster=await call('/v1/chomp/exchange',{code:host.ticket.code,input},host.ticket.token);
  assert.equal(roster.status,200);assert.ok(roster.body.players.every(p=>p.team===p.slot%2&&p.spawnIndex===Math.floor(p.slot/2)));
  time+=100;const s=tacticalWorld(roster.body.players);s.elapsed=0.1;
  assert.equal((await call('/v1/chomp/exchange',{code:host.ticket.code,input,snapshot:s},host.ticket.token)).status,200);
  const guest=await call('/v1/chomp/exchange',{code:host.ticket.code,input},people[1].token);
  assert.deepEqual(guest.body.snapshot,s);assert.equal(guest.body.matchClock.endsAt,280000);
  assert.equal((await call('/v1/chomp/match',teamJoin('team',2))).body.ticket.matchClock.endsAt,280000,'idempotent admission never restarts deadline');
 },{now:()=>time,maxRooms:3});
});

test('v7 validates exact per-mode waves, deaths, identity ledger, bounds and team attribution',async()=>{
 let time=100000;await fixture(async call=>{
  for(const mode of ['ocean','king','deathmatch','team']) {
   const h=(await call('/v1/chomp/rooms',teamJoin(mode))).body;
   const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token);time+=100;
   const s=tacticalWorld(r.body.players,mode);assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
   for(const mutate of [s=>delete s.matchStats,s=>s.matchStats[1].team=0,s=>s.matchStats[1].kills=-1,s=>s.matchStats[1].deaths=100001,s=>s.matchStats.push({...s.matchStats[0]}),s=>s.matchStats[0].participantID='forged-human',s=>s.matchStats[0].name='Impostor',s=>s.matchStats[1].participantID='bot:2',s=>s.fish[0].deaths=-1,s=>s.surface.displacement.pop(),s=>s.matchStats[2].kills=1]) {
    time+=100;const bad=structuredClone(s);mutate(bad);
    assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:bad},h.token)).status,400);
   }
   await call('/v1/chomp/leave',{code:h.code},h.token);
  }
 },{now:()=>time});
});

test('v7 duplicate packets do not double count; ledger totals never decrease or lose retired players',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin())).body;
  const g=(await call('/v1/chomp/join',{...teamJoin(),name:'Guest',code:h.code})).body;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
  recordKill(s,0,1);s.elapsed=1;time+=100;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  time+=100;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  const received=(await call('/v1/chomp/exchange',{code:h.code,input},g.token)).body.snapshot;
  assert.equal(received.matchStats.find(r=>r.slot===0).kills,1);
  time+=100;const reversed=structuredClone(s);reversed.matchStats[0].kills=0;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:reversed},h.token)).status,400);
  await call('/v1/chomp/leave',{code:h.code},g.token);
  time+=100;const retired=structuredClone(s);retired.elapsed=2;retired.matchStats[1].connected=false;retired.fish[1]={...retired.fish[1],name:'Replacement',kills:0,deaths:0};retired.matchStats.push({participantID:'bot:1:1',slot:1,name:'Replacement',team:1,kills:0,deaths:0,connected:true,isBot:true});
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:retired},h.token)).status,200);
  time+=100;const dropped=structuredClone(retired);dropped.matchStats.splice(1,1);
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:dropped},h.token)).status,400);
  const replacement=(await call('/v1/chomp/join',{...teamJoin(),name:'New Guest',code:h.code})).body;
  assert.equal(replacement.slot,1);assert.equal(replacement.matchClock.endsAt,h.matchClock.endsAt);
  const nextRoster=(await call('/v1/chomp/exchange',{code:h.code,input},replacement.token)).body.players;
  assert.notEqual(nextRoster.find(p=>p.slot===1).identity,r.body.players.find(p=>p.slot===1).identity);
  const outward=(await call('/v1/chomp/exchange',{code:h.code,input},h.token));
  // Rate limiting is still real; the identity/ledger checks never bypass it.
  assert.equal(outward.status,429);
 },{now:()=>time});
});

test('v7 score target derives result from ledger and freezes exact final world for host and guest',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin())).body,g=(await call('/v1/chomp/join',{...teamJoin(),code:h.code})).body;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
  s.roundResult='RED TEAM WINS';time+=100;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).body.roundResult,null,'premature forged result cannot end match');
  for(let n=0;n<25;n++)recordKill(s,0,1);s.elapsed=12;time+=100;
  const ended=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);
  assert.equal(ended.body.roundResult,'BLUE TEAM WINS');assert.equal(ended.body.snapshot.matchStats[0].kills,25);
  const guest=await call('/v1/chomp/exchange',{code:h.code,input},g.token);assert.deepEqual(guest.body.snapshot,ended.body.snapshot);
  time+=100;recordKill(s,1,0);s.elapsed=13;
  const frozen=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);
  assert.equal(frozen.status,200);assert.deepEqual(frozen.body.snapshot,ended.body.snapshot);
 },{now:()=>time});
});

test('v7 deadline finalizes win loss or draw from last accepted combat; reconnect never resets time',async()=>{
 for(const winner of [null,0,1]) {
  let time=100000;await fixture(async call=>{
   const h=(await call('/v1/chomp/rooms',teamJoin())).body,g=(await call('/v1/chomp/join',{...teamJoin(),code:h.code})).body;
   const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
   if(winner!==null)recordKill(s,winner,1-winner);
   for(let n=1;n<18;n++){time=100000+n*10000;s.elapsed=n*10;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);await call('/v1/chomp/exchange',{code:h.code,input},g.token);}
   time=280001;const ended=await call('/v1/chomp/exchange',{code:h.code,input},h.token);
   assert.equal(ended.body.roundResult,winner===null?'DRAW':winner===0?'BLUE TEAM WINS':'RED TEAM WINS');
   assert.equal(ended.body.matchClock.endsAt,280000);assert.equal(ended.body.snapshot.elapsed,170);
   const peer=await call('/v1/chomp/exchange',{code:h.code,input},g.token);assert.deepEqual(peer.body.snapshot,ended.body.snapshot);
   time+=100;const reconnect=await call('/v1/chomp/exchange',{code:h.code,input},g.token);assert.equal(reconnect.body.matchClock.endsAt,280000);
  },{now:()=>time});
 }
});

test('v7 disconnect normalization does not mutate frozen combat or let a replacement inherit kills',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin())).body,g=(await call('/v1/chomp/join',{...teamJoin(),code:h.code})).body;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
  recordKill(s,1,0);time+=100;await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);
  await call('/v1/chomp/leave',{code:h.code},g.token);
  const replacement=(await call('/v1/chomp/join',{...teamJoin(),code:h.code,name:'New'},h.token)).body;
  const stale=await call('/v1/chomp/exchange',{code:h.code,input},replacement.token);
  assert.equal(stale.body.snapshot.matchStats[1].connected,false);assert.equal(stale.body.snapshot.matchStats[1].kills,1);
  assert.equal(stale.body.snapshot.matchStats.some(row=>row.participantID===stale.body.players.find(p=>p.slot===1).identity),false,'new identity has no inherited ledger');
 },{now:()=>time});
});

test('v7 public late admission closes on wall time and a new request never reuses a v5 room',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/match',teamJoin())).body;
  for(let n=1;n<=3;n++){time+=10000;await call('/v1/chomp/exchange',{code:h.ticket.code,input},h.ticket.token);}
  assert.equal((await call('/v1/chomp/match',teamJoin('team',2))).status,503);
  assert.equal((await call('/v1/chomp/match',immediateJoin('team',3))).status,503);
 },{now:()=>time,maxRooms:1});
});

test('v7 historical row budget reserves disconnect replacements and keeps identity history bounded',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin('ocean'))).body;
  // 31 arrivals + 31 departures consume62 retired rows; reserve prevents64.
  for(let n=0;n<31;n++) {
   time+=2500;await call('/v1/chomp/exchange',{code:h.code,input},h.token);
   const g=await call('/v1/chomp/join',{...teamJoin('ocean'),code:h.code});assert.equal(g.status,200);
   assert.equal((await call('/v1/chomp/leave',{code:h.code},g.body.token)).status,200);
  }
  assert.equal((await call('/v1/chomp/join',{...teamJoin('ocean'),code:h.code})).status,409);
 },{now:()=>time});
});

test('v7 final world survives host leave for pending guests then expires within60seconds',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin())).body,g=(await call('/v1/chomp/join',{...teamJoin(),code:h.code})).body;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
  for(let n=0;n<25;n++)recordKill(s,0,1);time+=100;
  const final=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);
  assert.equal(final.body.roundResult,'BLUE TEAM WINS');
  await call('/v1/chomp/leave',{code:h.code},h.token);time+=13000;
  const delayed=await call('/v1/chomp/exchange',{code:h.code,input},g.token);
  assert.equal(delayed.status,200);assert.deepEqual(delayed.body.snapshot,final.body.snapshot);
  assert.equal((await call('/v1/chomp/join',{...teamJoin(),code:h.code})).status,409,'ended room cannot acquire a new host');
  time=160101;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input},g.token)).status,410);
  const legacy=(await call('/v1/chomp/rooms',immediateJoin())).body,oldGuest=(await call('/v1/chomp/join',{...immediateJoin(),code:legacy.code})).body;
  await call('/v1/chomp/leave',{code:legacy.code},legacy.token);
  assert.equal((await call('/v1/chomp/exchange',{code:legacy.code,input},oldGuest.token)).status,410,'legacy host leave still closes immediately');
 },{now:()=>time});
});

test('v7 private admission cannot bypass elapsed deadline before first final exchange',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',teamJoin())).body;
  const r=await call('/v1/chomp/exchange',{code:h.code,input},h.token),s=tacticalWorld(r.body.players);
  for(let n=1;n<18;n++){time=100000+n*10000;s.elapsed=n*10;await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);}
  time=280001;const denied=await call('/v1/chomp/join',{...teamJoin(),code:h.code,name:'Too late'});
  assert.equal(denied.status,409);
  const final=await call('/v1/chomp/exchange',{code:h.code,input},h.token);
  assert.equal(final.body.players.length,1);assert.equal(final.body.snapshot.matchStats.length,24);assert.equal(final.body.roundResult,'DRAW');
 },{now:()=>time});
});

}

test('v7 isolates both public and private pacing from v6 in every mode',async()=>{
 for(const mode of ['ocean','king','deathmatch','team']) {
  let time=100000;await fixture(async call=>{
   const legacy=(await call('/v1/chomp/match',teamJoin(mode,1))).body.ticket;
   const fast={...teamJoin(mode,2),protocol:7,ruleset:'chomp-swim-v3'};
   const current=(await call('/v1/chomp/match',fast)).body.ticket;
   assert.notEqual(current.code,legacy.code);assert.equal(current.protocol,7);
   assert.equal((await call('/v1/chomp/join',{...fast,code:legacy.code})).status,409);
   assert.equal((await call('/v1/chomp/join',{...teamJoin(mode,3),code:current.code})).status,409);
   const peer=(await call('/v1/chomp/match',{...fast,requestID:teamJoin(mode,4).requestID})).body.ticket;
   assert.equal(peer.code,current.code);
   const roster=(await call('/v1/chomp/exchange',{code:current.code,input},current.token)).body.players;
   const snapshot={...tacticalWorld(roster,mode),protocol:7,ruleset:'chomp-swim-v3'};
   snapshot.fish[0].position={x:300,y:200};snapshot.fish[0].velocity={x:20.125,y:0};
   time+=130;
   assert.equal((await call('/v1/chomp/exchange',{code:current.code,input,snapshot},current.token)).status,200);
   const received=(await call('/v1/chomp/exchange',{code:current.code,input},peer.token)).body.snapshot;
   assert.deepEqual(received,snapshot,'relay retains actual host position/velocity');
   time+=130;
   assert.equal((await call('/v1/chomp/exchange',{code:current.code,input,snapshot:{...snapshot,protocol:6,ruleset:'chomp-team-v2'}},current.token)).status,400);
  },{now:()=>time});
 }
});

test('v8 crab releases retain angle/life, reject malformed events and isolate legacy catalogs',async()=>{
 for(const mode of ['ocean','king','deathmatch','team']) {
  let time=100000;await fixture(async call=>{
   const cfg={...teamJoin(mode,70),protocol:8,ruleset:'chomp-claws-v4',skin:40};
   const host=(await call('/v1/chomp/rooms',cfg)).body;
   const guest=(await call('/v1/chomp/join',{...cfg,skin:42,code:host.code})).body;
   assert.equal(host.protocol,8);assert.equal(guest.slot,1);
   assert.equal((await call('/v1/chomp/join',{...cfg,protocol:7,ruleset:'chomp-swim-v3',skin:0,code:host.code})).status,409);
   assert.equal((await call('/v1/chomp/rooms',{...cfg,protocol:7,ruleset:'chomp-swim-v3'})).status,409);
   const release={...input,chomp:1,chompAngle:-Math.PI/2,chompLife:2};
   assert.equal((await call('/v1/chomp/exchange',{code:host.code,input:release},guest.token)).status,200);
   time+=130;
   // A duplicate/older counter must never overwrite the angle belonging to the accepted bite.
   assert.equal((await call('/v1/chomp/exchange',{code:host.code,input:{...release,chomp:0,chompAngle:Math.PI,chompLife:3}},guest.token)).status,200);
   const echoed=(await call('/v1/chomp/exchange',{code:host.code,input},host.token)).body.players.find(p=>p.slot===1).input;
   assert.equal(echoed.chomp,1);assert.equal(echoed.chompAngle,-Math.PI/2);assert.equal(echoed.chompLife,2);
   for(const bad of [{...release,chomp:2,chompAngle:9},{...release,chomp:2,chompLife:-1},{...input,chomp:2}]) {
    time+=130;assert.equal((await call('/v1/chomp/exchange',{code:host.code,input:bad},guest.token)).status,400);
   }
   time+=130;
   const roster=(await call('/v1/chomp/exchange',{code:host.code,input},host.token)).body.players;
   const snapshot={...tacticalWorld(roster,mode),protocol:8,ruleset:'chomp-claws-v4'};
   snapshot.fish[0].skinID=40;snapshot.fish[0].clawAngle=Math.PI;snapshot.fish[1].skinID=42;snapshot.fish[1].clawAngle=-Math.PI/2;
   time+=130;assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot},host.token)).status,200);
   const received=(await call('/v1/chomp/exchange',{code:host.code,input:release},guest.token)).body.snapshot;
   assert.equal(received.fish[0].clawAngle,Math.PI);assert.equal(received.fish[1].skinID,42);
  },{now:()=>time});
 }
});

const eliminationJoin=(mode='team',i=1)=>({...teamJoin(mode,i),protocol:9,ruleset:'chomp-elimination-v5'});
const eliminationWorld=(roster,mode='team')=>{
 const s={...tacticalWorld(roster,mode),protocol:9,ruleset:'chomp-elimination-v5'};
 s.fish=s.fish.map(f=>({...f,headPresent:true,respawnTime:0}));return s;
};
const eliminate=(s,killer,victim)=>{recordKill(s,killer,victim);Object.assign(s.fish[victim],{mass:0,headPresent:false,respawnTime:3.5});};
test('v9 rejects competitive crabs at public/private admission and actual room join, preserving v8',async()=>{
 for(const mode of ['king','deathmatch','team'])await fixture(async call=>{
  const cfg=eliminationJoin(mode);
  for(const skin of [40,41,42]) {
   assert.equal((await call('/v1/chomp/rooms',{...cfg,skin})).status,409);
   assert.equal((await call('/v1/chomp/match',{...cfg,skin})).status,409);
  }
  const host=(await call('/v1/chomp/rooms',{...cfg,skin:39})).body;
  assert.equal((await call('/v1/chomp/join',{...cfg,mode:'ocean',skin:40,code:host.code})).status,409,'claimed Ocean mode cannot bypass real room');
  const ocean=(await call('/v1/chomp/rooms',{...eliminationJoin('ocean'),skin:42})).body;
  assert.equal(ocean.protocol,9);
  const old=(await call('/v1/chomp/rooms',{...cfg,protocol:8,ruleset:'chomp-claws-v4',skin:42})).body;
  assert.equal(old.protocol,8,'old competitive crab rooms remain compatible');
 });
});
test('v9 elimination ends immediately and retained final survives host departure',async()=>{
 let time=100000;await fixture(async call=>{
  const host=(await call('/v1/chomp/rooms',eliminationJoin())).body;
  const guest=(await call('/v1/chomp/join',{...eliminationJoin(),code:host.code,name:'Guest'})).body;
  const roster=(await call('/v1/chomp/exchange',{code:host.code,input},host.token)).body.players;
  const s=eliminationWorld(roster);s.elapsed=1;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:s},host.token)).status,200);
  for(let id=1;id<24;id+=2)eliminate(s,0,id);
  s.elapsed=2;s.roundResult='RED TEAM WINS';time+=130;
  const final=await call('/v1/chomp/exchange',{code:host.code,input,snapshot:s},host.token);
  assert.equal(final.status,200);assert.equal(final.body.roundResult,'BLUE TEAM WINS','relay derives result from living slots');
  assert.equal(final.body.snapshot.fish[0].kills,12,'no 25-kill prerequisite');
  await call('/v1/chomp/leave',{code:host.code},host.token);time+=13000;
  const retained=await call('/v1/chomp/exchange',{code:host.code,input},guest.token);
  assert.equal(retained.status,200);assert.equal(retained.body.roundResult,'BLUE TEAM WINS');
 },{now:()=>time});
});
test('v9 rejects resurrection and multiple deaths without corrupting accepted world',async()=>{
 let time=100000;await fixture(async call=>{
  const host=(await call('/v1/chomp/rooms',eliminationJoin())).body;
  const roster=(await call('/v1/chomp/exchange',{code:host.code,input},host.token)).body.players;
  const s=eliminationWorld(roster);eliminate(s,0,1);s.elapsed=1;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:s},host.token)).status,200);
  const revived=structuredClone(s);Object.assign(revived.fish[1],{mass:64,headPresent:true,respawnTime:0});revived.elapsed=2;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:revived},host.token)).status,400);
  const twice=structuredClone(s);recordKill(twice,0,1);twice.elapsed=2;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:twice},host.token)).status,400);
  const crab=structuredClone(s);crab.fish[2].skinID=40;crab.elapsed=2;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:crab},host.token)).status,400);
  s.elapsed=2;time+=130;assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:s},host.token)).status,200);
 },{now:()=>time});
});
test('v9 timeout ranks survivors before kills; v8 retains kill-target rules',async()=>{
 let time=100000;await fixture(async call=>{
  const host=(await call('/v1/chomp/rooms',eliminationJoin())).body;
  const roster=(await call('/v1/chomp/exchange',{code:host.code,input},host.token)).body.players;
  const s=eliminationWorld(roster);eliminate(s,0,1);
  for(let n=1;n<=18;n++){time=100000+n*10000;s.elapsed=n*10;const r=await call('/v1/chomp/exchange',{code:host.code,input,snapshot:s},host.token);assert.equal(r.status,200);if(n===18)assert.equal(r.body.roundResult,'BLUE TEAM WINS');}
 },{now:()=>time});
});
test('v9 admission skips an eliminated open seat without resetting the match',async()=>{
 let time=100000;await fixture(async call=>{
  const host=(await call('/v1/chomp/rooms',eliminationJoin())).body;
  const roster=(await call('/v1/chomp/exchange',{code:host.code,input},host.token)).body.players;
  const s=eliminationWorld(roster);eliminate(s,0,1);s.elapsed=1;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:s},host.token)).status,200);
  const guest=await call('/v1/chomp/join',{...eliminationJoin(),code:host.code,name:'Late'});
  assert.equal(guest.status,200);assert.equal(guest.body.slot,2,'slot1 remains eliminated');
  assert.equal(guest.body.matchClock.endsAt,280000,'admission does not restart the clock');
 },{now:()=>time});
});
test('v9 simultaneous elimination is a draw and malformed life fields are rejected',async()=>{
 let time=100000;await fixture(async call=>{
  const host=(await call('/v1/chomp/rooms',eliminationJoin())).body;
  const roster=(await call('/v1/chomp/exchange',{code:host.code,input},host.token)).body.players;
  const s=eliminationWorld(roster);
  for(const field of [{headPresent:1},{respawnTime:-1},{respawnTime:null},{deaths:2}]){
   const bad=structuredClone(s);Object.assign(bad.fish[2],field);time+=130;
   assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:bad},host.token)).status,400);
  }
  for(const f of s.fish){f.mass=0;f.headPresent=false;f.respawnTime=3.5;f.deaths=1;s.matchStats.find(r=>r.slot===f.id).deaths=1;}
  s.elapsed=1;time+=130;const result=await call('/v1/chomp/exchange',{code:host.code,input,snapshot:s},host.token);
  assert.equal(result.status,200);assert.equal(result.body.roundResult,'DRAW');
 },{now:()=>time});
});
test('v9 public matching avoids rooms with no living available admission seats',async()=>{
 let time=100000;await fixture(async call=>{
  const host=(await call('/v1/chomp/match',eliminationJoin('team',91))).body.ticket;
  const roster=(await call('/v1/chomp/exchange',{code:host.code,input},host.token)).body.players;
  const s=eliminationWorld(roster);eliminate(s,0,1);eliminate(s,1,2);eliminate(s,0,3);s.elapsed=1;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:host.code,input,snapshot:s},host.token)).status,200);
  assert.equal((await call('/v1/chomp/join',{...eliminationJoin(),code:host.code})).status,409);
  const next=(await call('/v1/chomp/match',eliminationJoin('team',92))).body.ticket;
  assert.notEqual(next.code,host.code);assert.equal(next.slot,0);
 },{now:()=>time});
});

// Generation 10 candidate specifications: authored, not executed during the source-only hold.
const endlessJoin=(mode='king',i=1)=>({...teamJoin(mode,i),protocol:10,ruleset:'chomp-endless-v6'});
const endlessWorld=(roster,mode='king')=>{
 const s={...eliminationWorld(roster,mode),protocol:10,ruleset:'chomp-endless-v6'};
 s.fish=s.fish.map(f=>({...f,growthCredit:0}));return s;
};
test('v10 King stays open after two hours; late admission, cancellation and stale host retain limits',async()=>{
 let time=100000;await fixture(async call=>{
  const caps=(await call('/v1/chomp/capabilities')).body;
  assert.ok(caps.rulesets.includes('chomp-endless-v6'));assert.deepEqual(caps.endlessKingProtocols,[10,11,12,13]);
  const admitted=await call('/v1/chomp/match',endlessJoin());assert.equal(admitted.status,200);
  const h=admitted.body.ticket;assert.equal(h.matchClock,undefined);
  const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
  const s=endlessWorld(roster);
  for(let n=1;n<=721;n++){
   time+=10000;s.elapsed=n*10;s.crownTimes[0]=s.elapsed;
   const sent=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);
   assert.equal(sent.status,200);assert.equal(sent.body.roundResult,null);assert.equal(sent.body.matchClock,undefined);
  }
  const g=await call('/v1/chomp/match',endlessJoin('king',2));assert.equal(g.status,200);assert.equal(g.body.ticket.code,h.code);
  const got=await call('/v1/chomp/exchange',{code:h.code,input},g.body.ticket.token);
  assert.equal(got.body.snapshot.crownTimes[0],7210);assert.equal(got.body.matchClock,undefined);
  assert.equal((await call('/v1/chomp/join',{...eliminationJoin('king'),code:h.code})).status,409);
  assert.equal((await call('/v1/chomp/match/cancel',{requestID:endlessJoin('king',2).requestID})).status,200);
  assert.equal((await call('/v1/chomp/match',endlessJoin('king',2))).status,410);
  assert.equal((await call('/v1/chomp/join',{...endlessJoin(),code:h.code})).status,200);
  time+=12001;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input},h.token)).status,410);
 },{now:()=>time,maxRooms:1});
});
test('v10 rejects invalid current possession, growth credit and personal-best fields without overwriting the world',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',endlessJoin())).body;
  const g=(await call('/v1/chomp/join',{...endlessJoin(),name:'Guest',code:h.code})).body;
  const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
  const s=endlessWorld(roster);s.elapsed=10;s.crownTimes[0]=10;
  time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  for(const mutate of [x=>x.roundResult='WIN',x=>x.bestCrownTimes=x.crownTimes.slice(),x=>x.crownTimes[0]=100,
   x=>x.crownTimes[1]=1,x=>x.crownTimes[0]=null,
   x=>x.fish[0].growthCredit=-1,x=>x.fish[0].growthCredit=25000,x=>delete x.fish[0].growthCredit]){
   const bad=structuredClone(s);bad.elapsed=11;mutate(bad);time+=130;
   assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:bad},h.token)).status,400);
  }
  const got=await call('/v1/chomp/exchange',{code:h.code,input},g.token);
  assert.equal(got.body.snapshot.elapsed,10);assert.equal(got.body.snapshot.crownTimes[0],10);assert.equal(Object.hasOwn(got.body.snapshot,'bestCrownTimes'),false);
  // Slot 1 becomes larger; the old current possession resets. No best is relayed.
  s.elapsed=11;s.fish[1].mass=100;s.fish[1].capacity=100;s.crownTimes[0]=0;s.crownTimes[1]=0;
  time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  s.elapsed=12;s.crownTimes[1]=1;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
 },{now:()=>time});
});
test('v10 timed modes retain deadlines, elimination result, no revival and Ocean-only crabs',async()=>{
 for(const mode of ['team','deathmatch']){
  let time=100000;await fixture(async call=>{
   assert.equal((await call('/v1/chomp/rooms',{...endlessJoin(mode),skin:40})).status,409);
   const h=(await call('/v1/chomp/rooms',endlessJoin(mode))).body;assert.equal(h.matchClock.endsAt,280000);
   const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
   const s=endlessWorld(roster,mode);eliminate(s,0,1);s.elapsed=1;time+=130;
   assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
   if(mode==='team'){
    const revived=structuredClone(s);Object.assign(revived.fish[1],{mass:64,headPresent:true,respawnTime:0});revived.elapsed=2;time+=130;
    assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:revived},h.token)).status,400);
   }
   for(let n=1;n<=18;n++){
    time=100000+n*10000;s.elapsed=n*10;
    const r=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);assert.equal(r.status,200);
    if(n===18)assert.equal(r.body.roundResult,mode==='team'?'BLUE TEAM WINS':s.fish[0].name.toUpperCase()+' WINS');
   }
   assert.equal((await call('/v1/chomp/join',{...endlessJoin(mode),code:h.code})).status,409);
  },{now:()=>time});
 }
});
test('v9 King still finalizes at 180 seconds and rejects new streak semantics',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',eliminationJoin('king'))).body;
  const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
  const s=eliminationWorld(roster,'king');s.crownTimes[0]=50;
  for(let n=1;n<=18;n++){
   time=100000+n*10000;s.elapsed=n*10;
   const r=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);assert.equal(r.status,200);
   if(n===18){assert.equal(r.body.matchClock.endsAt,280000);assert.equal(r.body.roundResult,s.fish[0].name.toUpperCase()+' WINS');}
  }
  assert.equal((await call('/v1/chomp/join',{...endlessJoin(),code:h.code})).status,409);
 },{now:()=>time});
});
test('v10 King retirement capacity refuses extra guests without ending its host',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',endlessJoin())).body;
  let accepted=0,refused=false;
  for(let i=0;i<60;i++){
   time+=2000;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input},h.token)).status,200);
   const guest=await call('/v1/chomp/join',{...endlessJoin(),code:h.code});
   if(guest.status===409){refused=true;break;}
   assert.equal(guest.status,200);accepted++;
   await call('/v1/chomp/leave',{code:h.code},guest.body.token);
  }
  assert.ok(refused);assert.ok(accepted<=52);time+=130;
  const active=await call('/v1/chomp/exchange',{code:h.code,input},h.token);
  assert.equal(active.status,200);assert.equal(active.body.roundResult,null);assert.equal(active.body.players.length,1);
 },{now:()=>time,maxRooms:1});
});
test('v10 replaced seat cannot inherit previous occupant current possession',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',endlessJoin())).body;
  const a=(await call('/v1/chomp/join',{...endlessJoin(),code:h.code,name:'First'})).body;
  const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
  const s=endlessWorld(roster);s.elapsed=20;s.fish[1].mass=100;s.fish[1].capacity=100;s.crownTimes[1]=20;
  time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  await call('/v1/chomp/leave',{code:h.code},a.token);
  const b=(await call('/v1/chomp/join',{...endlessJoin(),code:h.code,name:'Second'})).body;assert.equal(b.slot,1);
  time+=130;const newRoster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
  const newPerson=newRoster.find(p=>p.slot===1),oldRow=s.matchStats.find(r=>r.slot===1&&r.connected);
  oldRow.connected=false;s.matchStats.push({...oldRow,participantID:newPerson.identity,name:newPerson.name,connected:true,kills:0,deaths:0});
  Object.assign(s.fish[1],{name:newPerson.name,mass:100,capacity:100,kills:0,deaths:0});s.elapsed=21;s.crownTimes[1]=20;
  time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,400,'inherited current possession rejected');
  s.crownTimes[1]=0;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  const received=await call('/v1/chomp/exchange',{code:h.code,input},b.token);
  assert.equal(received.body.snapshot.crownTimes[1],0);assert.equal(received.body.snapshot.matchStats.filter(r=>r.slot===1).length,2);
 },{now:()=>time});
});

const expandedJoin=(mode='ocean',i=1)=>({...endlessJoin(mode,i),protocol:11,ruleset:'chomp-ocean-v7'});
const expandedWorld=(roster,mode='ocean')=>{
 const s={...endlessWorld(roster,mode),protocol:11,ruleset:'chomp-ocean-v7'};
 if(mode==='ocean')s.surface={displacement:Array(1216).fill(0),velocity:Array(1216).fill(0)};
 return s;
};
test('v11 larger Ocean exchanges exact host state and rejects legacy geometry without damaging the accepted state',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',expandedJoin())).body;
  const g=(await call('/v1/chomp/join',{...expandedJoin(),code:h.code,name:'Guest'})).body;
  assert.equal((await call('/v1/chomp/join',{...endlessJoin('ocean'),code:h.code})).status,409);
  const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
  const s=expandedWorld(roster);s.elapsed=1;s.fish[0].position={x:2300,y:1500};s.food=[[1,2300000,1500000,1,6]];
  time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  for(const mutate of [x=>x.surface.displacement=Array(860).fill(0),x=>x.surface.velocity=Array(860).fill(0),x=>x.protocol=10,x=>x.ruleset='chomp-endless-v6',x=>x.fish[0].growthCredit=-1]){
   const bad=structuredClone(s);bad.elapsed=2;mutate(bad);time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:bad},h.token)).status,400);
  }
  const received=(await call('/v1/chomp/exchange',{code:h.code,input},g.token)).body.snapshot;assert.deepEqual(received,s);
  const old=(await call('/v1/chomp/rooms',endlessJoin('ocean',9))).body;
  assert.equal((await call('/v1/chomp/join',{...expandedJoin(),code:old.code})).status,409);
  const oldRoster=(await call('/v1/chomp/exchange',{code:old.code,input},old.token)).body.players;
  const legacy=endlessWorld(oldRoster,'ocean');legacy.elapsed=1;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:old.code,input,snapshot:legacy},old.token)).status,200);
 },{now:()=>time});
});
test('v11 public admission separates generations and cancel only removes its owned seat',async()=>{
 let time=100000;await fixture(async call=>{
  const a=(await call('/v1/chomp/match',endlessJoin('ocean',11))).body.ticket;
  const b=(await call('/v1/chomp/match',expandedJoin('ocean',12))).body.ticket;assert.notEqual(a.code,b.code);
  const c=(await call('/v1/chomp/match',expandedJoin('ocean',13))).body.ticket;assert.equal(c.code,b.code);
  assert.equal((await call('/v1/chomp/match/cancel',{requestID:expandedJoin('ocean',13).requestID})).status,200);
  time+=130;assert.equal((await call('/v1/chomp/exchange',{code:a.code,input},a.token)).status,200);assert.equal((await call('/v1/chomp/exchange',{code:b.code,input},b.token)).status,200);
 },{now:()=>time});
});
test('v11 endless King survives two hours and keeps personal records off the wire',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',expandedJoin('king'))).body;assert.equal(h.matchClock,undefined);
  const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
  const s=expandedWorld(roster,'king');
  for(let i=1;i<=721;i++){time+=10000;s.elapsed=i*10;s.crownTimes[0]=s.elapsed;const v=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);assert.equal(v.status,200);assert.equal(v.body.roundResult,null);assert.equal(v.body.matchClock,undefined);}
  const bad=structuredClone(s);bad.bestCrownTimes=s.crownTimes.slice();time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:bad},h.token)).status,400);
  assert.equal((await call('/v1/chomp/join',{...expandedJoin('king',2),code:h.code})).status,200);
 },{now:()=>time});
});
test('v11 competitive dimensions and elimination remain unchanged',async()=>{
 for(const mode of ['deathmatch','team']){let time=100000;await fixture(async call=>{
  assert.equal((await call('/v1/chomp/rooms',{...expandedJoin(mode),skin:40})).status,409);
  const h=(await call('/v1/chomp/rooms',expandedJoin(mode))).body;assert.equal(h.matchClock.endsAt,280000);
  const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;const s=expandedWorld(roster,mode);eliminate(s,0,1);s.elapsed=1;
  time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  if(mode==='team'){const revived=structuredClone(s);Object.assign(revived.fish[1],{mass:64,headPresent:true,respawnTime:0});revived.elapsed=2;time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:revived},h.token)).status,400);}
  for(let i=1;i<=18;i++){time=100000+i*10000;s.elapsed=i*10;const v=await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token);assert.equal(v.status,200);if(i===18)assert.ok(v.body.roundResult);}
 },{now:()=>time});}
});

// Protocol12 source specifications; not executed during the source-only phase.
const schoolJoin=(mode='ocean',i=1)=>({...expandedJoin(mode,i),protocol:12,ruleset:'chomp-school-v8',skin:43});
const rows=(count)=>({count,rows:count?{'0':[[0,count-1]]}:{}});
function schoolWorld(roster,mode='ocean') {
 const s={...expandedWorld(roster,mode),protocol:12,ruleset:'chomp-school-v8',plants:mode==='ocean'?schoolPlantSites().map(({id})=>({id,readyAt:0,harvests:0})):[]};
 for(const f of s.fish)Object.assign(f,{pixels:rows(f.mass),template:rows(f.capacity)});
 const owner=s.fish[0];Object.assign(owner,{skinID:43,mass:120,capacity:120,gridLength:20,pixels:rows(120),template:rows(120),headPresent:true,occupiedRadius:7});
 owner.school=Array.from({length:12},(_,i)=>({body:{id:owner.id,name:owner.name,skinID:0,schoolMemberIndex:i,mass:10,capacity:10,pixels:rows(10),template:rows(10),position:{x:0,y:0},heading:0,gridLength:10,gridHeight:1,pivot:{x:0,y:0},velocity:{x:0,y:0},occupiedRadius:7,headPresent:true,respawnTime:0,protection:0,peaceTime:0,repairAccumulator:0,growthCredit:0,kills:0,deaths:0}}));
 return s;
}
test('v12 schools and plant state round-trip while v11 stays isolated',async()=>{
 let time=100000;await fixture(async call=>{
  const h=(await call('/v1/chomp/rooms',schoolJoin())).body;
  assert.equal((await call('/v1/chomp/join',{...expandedJoin(),code:h.code})).status,409);
  const g=(await call('/v1/chomp/join',{...schoolJoin(),code:h.code,name:'Guest'})).body;
  const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
  const s=schoolWorld(roster);s.elapsed=1;
  assert.equal(validSchoolWorld(s),true);time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
  assert.deepEqual((await call('/v1/chomp/exchange',{code:h.code,input},g.token)).body.snapshot,s);
  for(const mutate of [x=>x.fish[0].school.pop(),x=>x.fish[0].school.push(x.fish[0].school[0]),x=>x.fish[0].school[0].body.school=[],x=>x.fish[0].school[0].body.mass++,x=>x.fish[0].school[0].body.position.x=10000,x=>x.fish[0].school[0].targetID=0,x=>x.fish[0].school[0].body.pixels.rows['0']=[[0,9],[8,9]],x=>x.plants[0].id++,x=>x.plants[0].readyAt=1000,x=>x.plants.push(x.plants[0]),x=>delete x.plants]) {
   const bad=structuredClone(s);bad.elapsed=2;mutate(bad);time+=130;
   assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:bad},h.token)).status,400);
   assert.deepEqual((await call('/v1/chomp/exchange',{code:h.code,input},g.token)).body.snapshot,s,'rejection must retain the whole previous state');
  }
  const harvested=structuredClone(s);harvested.elapsed=2;harvested.plants[0].harvests=1;harvested.plants[0].readyAt=2+schoolPlantSites()[0].delay;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:harvested},h.token)).status,200);
  const rewind=structuredClone(s);rewind.elapsed=3;time+=130;
  assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:rewind},h.token)).status,400);
 },{now:()=>time});
});
test('v12 school joins competitive games but cannot target allies or self',async()=>{
 for(const mode of ['team','deathmatch','king']) {
  let time=100000;await fixture(async call=>{
   const admitted=await call('/v1/chomp/rooms',schoolJoin(mode));assert.equal(admitted.status,200);const h=admitted.body;
   assert.equal((await call('/v1/chomp/rooms',{...schoolJoin(mode,8),skin:40})).status,409);
   const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
   const s=schoolWorld(roster,mode);s.elapsed=1;if(mode==='king')s.crownTimes=s.crownTimes.map(()=>0);
   s.fish[0].school[0].targetID=1;time+=130;
   assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
   for(const target of mode==='team'?[0,2,24]:[0,24]) {
    const bad=structuredClone(s);bad.elapsed=2;bad.fish[0].school[0].targetID=target;time+=130;
    assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:bad},h.token)).status,400);
   }
  },{now:()=>time});
 }
});

test('real Swift school snapshots match relay representation and bounds',{skip:!process.env.CHOMP_SCHOOL_FIXTURE_DIR},async()=>{
 const {readFile}=await import('node:fs/promises');const {join}=await import('node:path');
 for(const mode of ['ocean','king','deathmatch','team']) {
  const raw=await readFile(join(process.env.CHOMP_SCHOOL_FIXTURE_DIR,'school-'+mode+'.json'),'utf8');
  assert.ok(Buffer.byteLength(raw)<750000);assert.equal(validSchoolWorld(JSON.parse(raw)),true,mode+' Swift Codable rows, member budgets and plant IDs');
 }
});

// Only room identities change here: body rows, member offsets, plants and all
// gameplay fields are the actual Swift encoder output from four large schools.
test('real Swift four-school worlds survive full local HTTP exchange in every mode',{skip:!process.env.CHOMP_SCHOOL_FIXTURE_DIR},async()=>{
 const {readFile}=await import('node:fs/promises');const {join}=await import('node:path');
 for(const mode of ['ocean','king','deathmatch','team']) {
  const s=JSON.parse(await readFile(join(process.env.CHOMP_SCHOOL_FIXTURE_DIR,'school-'+mode+'.json'),'utf8'));
  const currentJoin={...schoolJoin(mode),protocol:s.protocol,ruleset:s.ruleset};
  let time=100000;
  await fixture(async call=>{
   const admitted=await call('/v1/chomp/rooms',{...currentJoin,name:s.fish[0].name});assert.equal(admitted.status,200);const h=admitted.body;
   const guests=[];
   for(let i=1;i<4;i++) {const joined=await call('/v1/chomp/join',{...currentJoin,name:s.fish[i].name,code:h.code});assert.equal(joined.status,200);guests.push(joined.body);}
   const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
   for(const row of s.matchStats) {const p=roster.find(p=>p.slot===row.slot);if(p)Object.assign(row,{participantID:p.identity,isBot:false});}
   const body={code:h.code,input,snapshot:s};assert.ok(Buffer.byteLength(JSON.stringify(body))<786432);
   time+=130;assert.equal((await call('/v1/chomp/exchange',body,h.token)).status,200,mode+' accepts exact Swift geometry');
   // The team referee explicitly encodes its unfinished result as null (Swift omits nil).
   const expected=mode==='team'?{...s,roundResult:null}:s;
   for(const g of guests) {const received=await call('/v1/chomp/exchange',{code:h.code,input},g.token);assert.equal(received.status,200);assert.deepEqual(received.body.snapshot,expected);}
   // An oversized request cannot replace the previously accepted world.
   time+=130;assert.equal((await call('/v1/chomp/exchange',{...body,padding:'x'.repeat(786432)},h.token)).status,400);
   time+=130;assert.deepEqual((await call('/v1/chomp/exchange',{code:h.code,input},guests[0].token)).body.snapshot,expected);
  },{now:()=>time});
 }
});

test('v13 isolates fish-only rooms and round-trips individual plant cells in every mode',async()=>{
 for(const mode of ['ocean','king','deathmatch','team']) {
  let time=100000;
  await fixture(async call=>{
   const cfg={...schoolJoin(mode),protocol:13,ruleset:'chomp-reef-v9'};
   for(const skin of [40,41,42])assert.equal((await call('/v1/chomp/rooms',{...cfg,skin})).status,409);
   const h=(await call('/v1/chomp/rooms',cfg)).body;
   assert.equal((await call('/v1/chomp/join',{...schoolJoin(mode),code:h.code})).status,409);
   const g=(await call('/v1/chomp/join',{...cfg,code:h.code,name:'Guest'})).body;
   const roster=(await call('/v1/chomp/exchange',{code:h.code,input},h.token)).body.players;
   const s={...schoolWorld(roster,mode),protocol:13,ruleset:'chomp-reef-v9',elapsed:1,plants:reefPlantSites(mode).map(({id})=>({id,readyAt:0,harvests:0,eaten:[]}))};
   const site=reefPlantSites(mode)[0];assert.ok(site.cells>10);assert.equal(reefPlantCells(site.noise).length,site.cells);
   s.plants[0]={id:site.id,readyAt:1+site.delay,harvests:1,eaten:[0]};
   time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:s},h.token)).status,200);
   const accepted=(await call('/v1/chomp/exchange',{code:h.code,input},g.token)).body.snapshot;
   assert.deepEqual(accepted.plants[0].eaten,[0]);assert.equal(accepted.plants.length,reefPlantSites(mode).length);
   for(const mutate of [x=>x.plants[0].eaten=[0,0],x=>x.plants[0].eaten=[-1],x=>x.plants[0].eaten=[site.cells],x=>x.plants[0].eaten=[],x=>{x.plants[0].eaten=[1];x.plants[0].harvests++},x=>x.fish[1].skinID=40]) {
    const bad=structuredClone(s);bad.elapsed=2;mutate(bad);time+=130;
    assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:bad},h.token)).status,400);
    assert.deepEqual((await call('/v1/chomp/exchange',{code:h.code,input},g.token)).body.snapshot,accepted);
   }
   const next=structuredClone(s);next.elapsed=2;next.plants[0].eaten=[0,1];next.plants[0].harvests=2;next.plants[0].readyAt=2+site.delay;
   time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:next},h.token)).status,200);
   const regrown=structuredClone(next);regrown.elapsed=next.plants[0].readyAt;regrown.plants[0].eaten=[2];regrown.plants[0].harvests++;regrown.plants[0].readyAt=regrown.elapsed+site.delay;
   time+=130;assert.equal((await call('/v1/chomp/exchange',{code:h.code,input,snapshot:regrown},h.token)).status,200);
  },{now:()=>time});
 }
});

 test('Swift and relay use identical reef cell ordering and geometry',{skip:!process.env.CHOMP_SCHOOL_FIXTURE_DIR},async()=>{
 const {readFile}=await import('node:fs/promises');const {join}=await import('node:path');
 const shapes=JSON.parse(await readFile(join(process.env.CHOMP_SCHOOL_FIXTURE_DIR,'reef-geometry.json'),'utf8'));
 assert.ok(shapes.length>100);
 for(const shape of shapes)assert.deepEqual(reefPlantCells(shape.noise),shape.cells,'plant '+shape.id+' noise '+shape.noise);
});
