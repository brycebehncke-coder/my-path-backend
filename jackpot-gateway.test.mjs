import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {createJackpotGateway,bridgeSignature} from './jackpot-gateway.mjs';
const at=Date.parse('2026-09-29T12:00:00Z');
const env={JACKPOT_SHARED_ACCOUNTS_ENABLED:'true',JACKPOT_BRIDGE_SECRET:'s'.repeat(48),JACKPOT_WORKER_ORIGIN:'https://jackpot.example/',JACKPOT_WEBSITE_ORIGIN:'https://behnckemobilegames.com'};
async function call(gateway,{path='/v1/jackpot/config',method='GET',headers={},body=''}={}) {
  const req=Readable.from([body]);Object.assign(req,{url:path,method,headers,socket:{remoteAddress:'127.0.0.1'}});
  let response;const res={writeHead(status,h){response={status,headers:h};},end(data){response.body=data?JSON.parse(data):null;}};
  const handled=await gateway(req,res);return {handled,...response};
}
test('Age Up paths remain unhandled, and Jackpot is off by default',async()=>{
  const gate=createJackpotGateway({env:{},fetcher:()=>{throw Error('should not fetch');}});
  assert.equal((await call(gate,{path:'/v1/chat/completions',method:'POST'})).handled,false);
  assert.equal((await call(gate)).status,503);
});
test('Apple form callback is signed, strips code from redirect, and does not broaden CORS',async()=>{
  let sent;
  const gate=createJackpotGateway({env,clock:()=>at,fetcher:async(_url,init)=>{sent=init;return Response.json({received:true});}});
  const args={path:'/v1/jackpot/auth/apple/callback',method:'POST',headers:{origin:'https://appleid.apple.com','content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({state:'x'.repeat(43),code:'secret-code'}).toString()};
  const result=await call(gate,args);assert.equal(result.status,303);
  assert.equal(result.headers.Location,env.JACKPOT_WEBSITE_ORIGIN+'/games/jackpot-inc/play/?signin=apple-return');
  assert.equal(result.headers['Access-Control-Allow-Origin'],undefined);assert(!JSON.stringify(result).includes('secret-code'));
  assert.deepEqual(JSON.parse(sent.body),{flowId:'x'.repeat(43),code:'secret-code'});
  assert.equal((await call(gate,{...args,headers:{...args.headers,origin:'https://evil.example'}})).status,403);
  assert.equal((await call(gate,{...args,body:args.body+'&state=duplicate'})).status,400);
  assert.equal((await call(gate,{...args,body:args.body+'&redirect=https://evil.example'})).status,400);
  assert.equal((await call(gate,{...args,path:'/v1/jackpot/command'})).status,403);
});
test('forwards only approved paths, signs token/body, and strips upstream cookies',async()=>{
  let sent;
  const gate=createJackpotGateway({env,clock:()=>at,fetcher:async(url,init)=>{sent={url,init};return Response.json({balance:'123'},{headers:{'Set-Cookie':'bad=cookie'}});}});
  const body=JSON.stringify({command:{type:'refresh'}});const authorization='Bearer '+'b'.repeat(43);
  const r=await call(gate,{path:'/v1/jackpot/command',method:'POST',body,headers:{origin:env.JACKPOT_WEBSITE_ORIGIN,'content-type':'application/json',authorization,'x-jackpot-signature':'attacker'}});
  assert.equal(r.status,200);assert.equal(sent.url.href,'https://jackpot.example/v1/jackpot/command');
  assert.equal(r.headers['Access-Control-Allow-Origin'],env.JACKPOT_WEBSITE_ORIGIN);assert.equal(r.headers['Set-Cookie'],undefined);
  assert.equal(sent.init.headers['x-jackpot-signature'],bridgeSignature(env.JACKPOT_BRIDGE_SECRET,{timestamp:String(at),method:'POST',path:'/v1/jackpot/command',authorization,clientKey:sent.init.headers['x-jackpot-client'],body}));
  assert.equal(sent.init.redirect,'error');
});
test('blocks cross-origin, unexpected routes, methods, query parameters and malformed authorization',async()=>{
  const gate=createJackpotGateway({env,fetcher:()=>{throw Error('must not forward');}});
  for(const [args,status] of [[{headers:{origin:'https://evil.example'}},403],[{path:'/v1/jackpot/admin'},404],[{path:'/v1/jackpot/config?url=https://evil.example'},404],[{method:'POST'},405],[{headers:{authorization:'Bearer invalid'}},401]]) {
    assert.equal((await call(gate,args)).status,status);
  }
});
test('rejects oversized JSON and unsigned form requests before forwarding',async()=>{
  const gate=createJackpotGateway({env,fetcher:()=>{throw Error('must not forward');}});
  assert.equal((await call(gate,{path:'/v1/jackpot/command',method:'POST',body:'x'.repeat(24_001)})).status,413);
  assert.equal((await call(gate,{path:'/v1/jackpot/command',method:'POST',body:'{}',headers:{'content-type':'text/plain'}})).status,415);
});
test('preflight is restricted to the one website and the exact method',async()=>{
  const gate=createJackpotGateway({env});
  const result=await call(gate,{path:'/v1/jackpot/command',method:'OPTIONS',headers:{origin:env.JACKPOT_WEBSITE_ORIGIN}});
  assert.equal(result.status,204);assert.equal(result.headers['Access-Control-Allow-Methods'],'POST');
  assert.equal(result.headers['Access-Control-Allow-Credentials'],undefined);
});
test('native save limit is isolated to its exact authenticated upstream route',async()=>{
  let forwarded=0;
  const gate=createJackpotGateway({env,fetcher:async()=>{forwarded++;return Response.json({ok:true});}});
  const args={method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+'n'.repeat(43)},body:JSON.stringify({save:'x'.repeat(30_000)})};
  assert.equal((await call(gate,{...args,path:'/v1/jackpot/native/checkpoint'})).status,200);
  for(const route of ['command','native/acquire','native/release','account/migrate-legacy'])
    assert.equal((await call(gate,{...args,path:'/v1/jackpot/'+route})).status,413);
  assert.equal((await call(gate,{...args,path:'/v1/jackpot/native/checkpoint',body:'x'.repeat(160_001)})).status,413);
  assert.equal(forwarded,1);
});
test('separate Render clients have distinct auth buckets; direct clients cannot forge them',async()=>{
  async function clientKeys(render){const keys=[];const gate=createJackpotGateway({env:{...env,RENDER:render},fetcher:async(_url,init)=>{keys.push(init.headers['x-jackpot-client']);return Response.json({});}});
    for(const ip of ['192.0.2.1','192.0.2.2']) await call(gate,{headers:{'cf-connecting-ip':ip}});return keys;}
  const remote=await clientKeys('true');assert.notEqual(...remote);
  const local=await clientKeys('false');assert.equal(...local);
});
test('actual HTTP server routes requests without changing unrelated service paths',async()=>{
  const gate=createJackpotGateway({env,fetcher:async()=>Response.json({available:true})});
  const server=createServer(async(req,res)=>{if(await gate(req,res))return;res.end('Age Up unchanged');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const base=`http://127.0.0.1:${server.address().port}`;
    assert.equal(await (await fetch(base+'/')).text(),'Age Up unchanged');
    assert.deepEqual(await (await fetch(base+'/v1/jackpot/config')).json(),{available:true});
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('stalled upstream headers and JSON release the concurrency slot after the deadline',async()=>{
  for(const stall of ['headers','json']) {
    let stuck=true;
    const gate=createJackpotGateway({env,timeoutMs:15,fetcher:async()=>{
      if(!stuck)return Response.json({recovered:true});
      if(stall==='headers')return new Promise(()=>{});
      return {status:200,json:()=>new Promise(()=>{})};
    }});
    assert.equal((await call(gate)).status,503);
    stuck=false;
    assert.deepEqual((await call(gate)).body,{recovered:true});
  }
});
