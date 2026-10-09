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
  assert.equal((await call('/v1/chomp/health')).body.protocol,3);
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
