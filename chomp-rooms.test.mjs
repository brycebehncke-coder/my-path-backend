import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createChompRooms} from './chomp-rooms.mjs';

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
  assert.deepEqual(capability.protocols,[1,2,3,4,5,6,7,8]);assert.ok(capability.rulesets.includes('chomp-quarter-v1'));assert.equal(capability.maximumSkin,42);assert.equal(capability.immediatePublic,true);
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
