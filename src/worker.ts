interface Env {
 DB: D1Database; ASSETS: Fetcher; INVITE_CODE: string; SESSION_SECRET: string;
 CONNECTOR_TOKEN: string; ALLOWED_ORIGIN: string; DAILY_LIMIT: string;
}
type Job = {id:string; conversation:string; prompt:string; status:string; answer:string; error:string|null; created:number};
const json = (data: unknown, status=200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
class ApiError extends Error {constructor(public status:number, message:string){super(message);}}
const now = () => Math.floor(Date.now()/1000);
const id = () => crypto.randomUUID();
function check(value: unknown, status:number, message:string): asserts value {if(!value) throw new ApiError(status,message);}
async function digest(value:string) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
async function equal(a:string,b:string) {return await digest(a)===await digest(b);}
async function sign(payload:string,secret:string) {
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(payload)))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
async function owner(req:Request,env:Env) {
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer /,'');
 const [uid,expiry,sig]=token.split('.');
 check(uid && /^\d+$/.test(expiry||'') && Number(expiry)>now() && sig,401,'请先输入邀请码');
 check(await equal(sig,await sign(`${uid}.${expiry}`,env.SESSION_SECRET)),401,'登录已失效');
 check(await env.DB.prepare('SELECT id FROM visitors WHERE id=?').bind(uid).first(),401,'登录已失效');
 return uid;
}
async function body(req:Request) {
 check(Number(req.headers.get('Content-Length')||0)<=300000,413,'内容过长');
 const reader=req.body?.getReader(); check(reader,400,'缺少内容');
 let size=0; const chunks:Uint8Array[]=[];
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>300000){await reader.cancel();throw new ApiError(413,'内容过长');}chunks.push(value);}
 const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder().decode(raw));}catch{throw new ApiError(400,'无效 JSON');}
}
async function mine(env:Env,uid:string,cid:string) {check(await env.DB.prepare('SELECT id FROM conversations WHERE id=? AND owner=?').bind(cid,uid).first(),404,'会话不存在');}
async function route(req:Request,env:Env):Promise<Response> {
 const url=new URL(req.url), path=url.pathname, method=req.method;
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(req);
 check(env.INVITE_CODE?.length>=16 && env.SESSION_SECRET?.length>=32 && env.CONNECTOR_TOKEN?.length>=32,503,'服务尚未配置');
 if(path.startsWith('/api/connector/')){
  check(await equal(req.headers.get('Authorization')||'',`Bearer ${env.CONNECTOR_TOKEN}`),401,'Unauthorized');
  check(method==='POST',405,'Method not allowed');const b=await body(req);
  check(typeof b.connector==='string' && /^[\w-]{1,80}$/.test(b.connector),400,'Invalid connector');
  const t=now();
  if(path==='/api/connector/claim'){
   await env.DB.prepare('INSERT INTO connectors(id,seen,ready) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET seen=excluded.seen,ready=excluded.ready').bind(b.connector,t,b.ready===true?1:0).run();
   // Expired deliveries are terminal: never submit an uncertain prompt twice.
   await env.DB.prepare("UPDATE jobs SET status='failed',error='电脑连接中断，投递状态未知；请检查后再发起新请求',updated=? WHERE status='running' AND lease_until<?").bind(t,t).run();
   if(b.ready!==true)return json({job:null});
   const lease=id();
   const job=await env.DB.prepare("UPDATE jobs SET status='running',lease_token=?,lease_until=?,connector=?,updated=? WHERE id=(SELECT id FROM jobs WHERE status='queued' ORDER BY created,rowid LIMIT 1) AND status='queued' RETURNING id,conversation,prompt,lease_token").bind(lease,t+120,b.connector,t).first();
   return json({job});
  }
  if(path==='/api/connector/update'){
   check(['running','complete','failed'].includes(b.status),400,'Invalid status');
   check(typeof b.job==='string' && typeof b.lease==='string',400,'Invalid job');
   check(b.answer===undefined || (typeof b.answer==='string' && b.answer.length<=120000),413,'Answer too long');
   check(b.error===undefined || (typeof b.error==='string' && b.error.length<=500),400,'Invalid error');
   check(b.status!=='complete' || (typeof b.answer==='string' && b.answer.trim()),400,'Empty answer');
   const updated=await env.DB.prepare('UPDATE jobs SET status=?,answer=COALESCE(?,answer),error=?,updated=?,lease_until=? WHERE id=? AND lease_token=? AND connector=? AND status=\'running\' AND lease_until>=? RETURNING id').bind(b.status,b.answer??null,b.error??null,t,t+120,b.job,b.lease,b.connector,t).first();
   if(!updated){
    const duplicate=await env.DB.prepare('SELECT status,answer,error FROM jobs WHERE id=? AND lease_token=? AND connector=?').bind(b.job,b.lease,b.connector).first<{status:string;answer:string;error:string|null}>();
    check(duplicate && duplicate.status===b.status && b.status!=='running' && duplicate.answer===(b.answer??'') && duplicate.error===(b.error??null),409,'Lease expired or request already finished');
   }
   await env.DB.prepare('UPDATE connectors SET seen=?,ready=1 WHERE id=?').bind(t,b.connector).run();
   return json({ok:true});
  }
  throw new ApiError(404,'Not found');
 }
 if(path==='/api/login' && method==='POST'){
  const t=now(), key=await digest(`${req.headers.get('CF-Connecting-IP')||'local'}:${Math.floor(t/600)}`);
  const rate=await env.DB.prepare('INSERT INTO login_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key,t+600).first<{count:number}>();
  check(rate && rate.count<=15,429,'尝试过于频繁，请稍后再试');
  const b=await body(req);check(typeof b.code==='string' && await equal(b.code,env.INVITE_CODE),401,'邀请码不正确');
  const uid=id(), expiry=t+30*86400;await env.DB.prepare('INSERT INTO visitors VALUES(?,?)').bind(uid,t).run();
  await env.DB.prepare('DELETE FROM login_limits WHERE expires<?').bind(t).run();
  const payload=`${uid}.${expiry}`;return json({token:`${payload}.${await sign(payload,env.SESSION_SECRET)}`});
 }
 const uid=await owner(req,env);
 if(path==='/api/status' && method==='GET'){
  const c=await env.DB.prepare('SELECT seen,ready FROM connectors ORDER BY seen DESC LIMIT 1').first<{seen:number;ready:number}>();
  return json({online:!!c && c.seen>now()-30 && c.ready===1});
 }
 if(path==='/api/conversations' && method==='GET')return json({conversations:(await env.DB.prepare('SELECT id,title,created FROM conversations WHERE owner=? ORDER BY created DESC,rowid DESC LIMIT 100').bind(uid).all()).results});
 if(path==='/api/conversations' && method==='POST'){
  const n=await env.DB.prepare('SELECT COUNT(*) n FROM conversations WHERE owner=?').bind(uid).first<{n:number}>();check(n && n.n<100,429,'最多保留 100 个会话');
  const cid=id();await env.DB.prepare('INSERT INTO conversations VALUES(?,?,?,?)').bind(cid,uid,'新对话',now()).run();return json({id:cid},201);
 }
 const match=path.match(/^\/api\/conversations\/([\w-]+)\/messages$/);
 if(match){const cid=match[1];await mine(env,uid,cid);
  if(method==='GET')return json({messages:(await env.DB.prepare('SELECT id,prompt,answer,status,error,created FROM jobs WHERE conversation=? AND owner=? ORDER BY created,rowid').bind(cid,uid).all()).results});
  if(method==='POST'){
   const b=await body(req);check(typeof b.text==='string' && b.text.trim().length>0 && b.text.length<=16000,400,'请输入 1–16000 字的消息');
   check(typeof b.key==='string' && /^[\w-]{8,80}$/.test(b.key),400,'缺少请求标识');
   const existing=await env.DB.prepare('SELECT id,conversation,prompt FROM jobs WHERE owner=? AND client_key=?').bind(uid,b.key).first<Job>();
   if(existing){check(existing.conversation===cid && existing.prompt===b.text.trim(),409,'请求标识冲突');return json({id:existing.id});}
   const jid=id(),t=now(),limit=Math.min(200,Math.max(1,Number(env.DAILY_LIMIT)||30));
   try{
    const added=await env.DB.prepare("INSERT INTO jobs(id,conversation,owner,prompt,created,updated,client_key) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM jobs WHERE owner=? AND created>?)<? AND (SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running'))<100 RETURNING id").bind(jid,cid,uid,b.text.trim(),t,t,b.key,uid,t-86400,limit).first();
    check(added,429,'今日额度已用完，或队列已满');
   }catch(e){if(e instanceof ApiError)throw e;const duplicate=await env.DB.prepare('SELECT id,conversation,prompt FROM jobs WHERE owner=? AND client_key=?').bind(uid,b.key).first<Job>();if(duplicate && duplicate.conversation===cid && duplicate.prompt===b.text.trim())return json({id:duplicate.id});throw new ApiError(409,'上一条消息还在处理中');}
   await env.DB.prepare("UPDATE conversations SET title=? WHERE id=? AND title='新对话'").bind(b.text.trim().slice(0,40),cid).run();
   return json({id:jid},202);
  }
 }
 throw new ApiError(404,'Not found');
}
export default {async fetch(req:Request,env:Env):Promise<Response>{
 const origin=req.headers.get('Origin'),url=new URL(req.url);
 const allowed=!origin || origin===url.origin || origin===env.ALLOWED_ORIGIN;
 if(!allowed && url.pathname.startsWith('/api/'))return json({error:'Origin not allowed'},403);
 let res:Response;
 try{res=req.method==='OPTIONS'?new Response(null,{status:204}):await route(req,env);}catch(e){res=e instanceof ApiError?json({error:e.message},e.status):json({error:'服务暂时不可用'},500);}
 res=new Response(res.body,res);
 if(origin && allowed){res.headers.set('Access-Control-Allow-Origin',origin);res.headers.set('Vary','Origin');res.headers.set('Access-Control-Allow-Headers','Content-Type, Authorization');res.headers.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');}
 res.headers.set('X-Content-Type-Options','nosniff');res.headers.set('Referrer-Policy','no-referrer');res.headers.set('X-Frame-Options','DENY');
 res.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https: http://127.0.0.1:8787; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
 return res;
}};
