import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';

const PREFIX = '/v1/jackpot/';
const METHODS = new Map([['config','GET'],['account','GET'],['auth/challenge','POST'],
  ['auth/complete','POST'],['auth/logout','POST'],['auth/apple/callback','POST'],['auth/apple/exchange','POST'],['account/delete','POST'],['command','POST'],
  ['account/legacy-status','POST'],['account/migrate-legacy','POST'],['native/acquire','POST'],['native/checkpoint','POST'],['native/release','POST']]);
const digest = body => createHash('sha256').update(body).digest('hex');
export function bridgeSignature(secret,{timestamp,method,path,authorization='',clientKey,body}) {
  return createHmac('sha256',secret).update(JSON.stringify(['jackpot-bridge-v1',timestamp,method,path,authorization,clientKey,digest(body)])).digest('hex');
}

/** Isolated, default-off route. Age Up routes, credentials and wallet are untouched. */
export function createJackpotGateway({env=process.env,fetcher=fetch,clock=Date.now,timeoutMs=8_000}={}) {
  let inFlight=0;
  return async function jackpotGateway(req,res) {
    const url = new URL(req.url || '/', 'https://gateway.invalid');
    if (!url.pathname.startsWith(PREFIX)) return false;
    const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
    const send=(status,payload)=>{res.writeHead(status,headers);res.end(JSON.stringify(payload));return true;};
    const origin=req.headers.origin;
    const allowedOrigin=env.JACKPOT_WEBSITE_ORIGIN || 'https://behnckemobilegames.com';
    const appleCallback=url.pathname===PREFIX+'auth/apple/callback';
    // Apple's form_post is a navigation, not an expansion of API CORS. It has
    // no session cookie; stored unpredictable state + signed nonce bind proof.
    if (origin && origin !== (appleCallback ? 'https://appleid.apple.com' : allowedOrigin)) return send(403,{error:{code:'ORIGIN_NOT_ALLOWED'}});
    if (origin && !appleCallback) headers['Access-Control-Allow-Origin']=origin;
    const method=METHODS.get(url.pathname.slice(PREFIX.length));
    if (!method || url.search) return send(404,{error:{code:'NOT_FOUND'}});
    if (req.method==='OPTIONS') {
      headers['Access-Control-Allow-Methods']=method;
      headers['Access-Control-Allow-Headers']='Authorization, Content-Type';
      headers['Access-Control-Max-Age']='600';
      res.writeHead(204,headers);res.end();return true;
    }
    if (method!==req.method) return send(405,{error:{code:'METHOD_NOT_ALLOWED'}});
    if (env.JACKPOT_SHARED_ACCOUNTS_ENABLED!=='true') return send(503,{available:false,reason:'ACCOUNTS_NOT_ENABLED'});
    let upstream;
    try {
      upstream=new URL(env.JACKPOT_WORKER_ORIGIN);
      if (upstream.protocol!=='https:' || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname!=='/') throw Error();
      if (typeof env.JACKPOT_BRIDGE_SECRET!=='string' || env.JACKPOT_BRIDGE_SECRET.length<32) throw Error();
    } catch {return send(503,{error:{code:'ACCOUNTS_NOT_CONFIGURED'}});}
    if (inFlight>=24) return send(503,{error:{code:'ACCOUNTS_BUSY'}});
    // Only authenticated native checkpoints need the bounded full save envelope.
    // Every other route retains the small request limit.
    const bodyLimit=url.pathname===PREFIX+'native/checkpoint'?160_000:24_000;
    if (Number(req.headers['content-length'] || 0)>bodyLimit) return send(413,{error:{code:'REQUEST_TOO_LARGE'}});
    inFlight+=1;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    const deadline=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}));
    try {
      const chunks=[];let bytes=0;
      // The separate body deadline prevents slow clients from retaining the
      // small gateway concurrency budget indefinitely.
      let raw=await Promise.race([(async()=>{for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>bodyLimit)throw Error('body-limit');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks).toString('utf8');})(),
        deadline]);
      const contentType=(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
      if (appleCallback) {
        if (contentType!=='application/x-www-form-urlencoded') return send(415,{error:{code:'FORM_REQUIRED'}});
        const form=new URLSearchParams(raw);
        if (req.headers.authorization || [...form.keys()].some(key=>!['state','code','error'].includes(key))
          || ['state','code','error'].some(key=>form.getAll(key).length>1)
          || !/^[A-Za-z0-9_-]{43}$/.test(form.get('state') || '')) return send(400,{error:{code:'INVALID_APPLE_CALLBACK'}});
        if (form.has('error')) {
          // No reflection of provider data or user-controlled redirect target.
          res.writeHead(303,{'Location':new URL('/games/jackpot-inc/play/?signin=apple-cancelled',allowedOrigin).href,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return true;
        }
        if (!form.get('code')) return send(400,{error:{code:'INVALID_APPLE_CALLBACK'}});
        raw=JSON.stringify({flowId:form.get('state'),code:form.get('code')});
      } else if (method==='POST' && contentType!=='application/json') return send(415,{error:{code:'JSON_REQUIRED'}});
      const authorization=req.headers.authorization || '';
      if (authorization && !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) return send(401,{error:{code:'SIGN_IN_REQUIRED'}});
      // Trust no caller-supplied bridge headers. Rate key has no raw address and
      // never authenticates a user; all identity comes from provider proofs.
      // Render's edge supplies CF-Connecting-IP. Only honor it on Render;
      // local/direct deployments cannot spoof this via a request header.
      const edgeIP=env.RENDER==='true' && typeof req.headers['cf-connecting-ip']==='string'
        && isIP(req.headers['cf-connecting-ip']) ? req.headers['cf-connecting-ip'] : req.socket?.remoteAddress || 'unknown';
      const clientKey=createHmac('sha256',env.JACKPOT_BRIDGE_SECRET).update(edgeIP).digest('hex');
      const timestamp=String(clock());
      const signature=bridgeSignature(env.JACKPOT_BRIDGE_SECRET,{timestamp,method,path:url.pathname,authorization,clientKey,body:raw});
      const response=await Promise.race([fetcher(new URL(url.pathname,upstream),{method,redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json','Authorization':authorization,'x-jackpot-time':timestamp,'x-jackpot-client':clientKey,'x-jackpot-signature':signature},
        ...(method==='POST'?{body:raw}:{})}),deadline]);
      // Never proxy Set-Cookie, Location, arbitrary headers, or HTML upstream.
      const payload=await Promise.race([response.json(),deadline]);
      if (appleCallback) {
        const result=response.status===200 && payload.received===true ? 'apple-return' : 'apple-failed';
        res.writeHead(303,{'Location':new URL(`/games/jackpot-inc/play/?signin=${result}`,allowedOrigin).href,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return true;
      }
      return send(response.status,payload);
    } catch(error) {return send(error.message==='body-limit'?413:503,{error:{code:error.message==='body-limit'?'REQUEST_TOO_LARGE':'ACCOUNTS_TEMPORARILY_UNAVAILABLE'}});}
    finally {clearTimeout(timer);inFlight-=1;}
  };
}
