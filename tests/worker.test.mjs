import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
let mf,db,token,other;
const secret='a-secret-long-enough-for-the-tests-000';
async function call(path,method='GET',body,auth=token){const res=await mf.dispatchFetch('http://localhost'+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json()};}
before(async()=>{
 const built=await build({entryPoints:['src/worker.ts'],bundle:true,format:'esm',write:false});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-08-01',d1Databases:['DB'],bindings:{INVITE_CODE:secret,SESSION_SECRET:secret,CONNECTOR_TOKEN:secret,DAILY_LIMIT:'30',ALLOWED_ORIGIN:''}}));
 db=await mf.getD1Database('DB');await db.batch(readFileSync('migrations/0001.sql','utf8').split(';').map(x=>x.trim()).filter(Boolean).map(x=>db.prepare(x)));
 token=(await call('/api/login','POST',{code:secret},null)).data.token;
 other=(await call('/api/login','POST',{code:secret},null)).data.token;
});
after(async()=>{await mf.dispose();});
test('private conversations, idempotent send, lease ownership and full answer roundtrip',async()=>{
 assert.equal((await call('/api/conversations','GET',undefined,null)).status,401);
 const cid=(await call('/api/conversations','POST',{})).data.id;
 assert.equal((await call(`/api/conversations/${cid}/messages`,'GET',undefined,other)).status,404);
 const send=()=>call(`/api/conversations/${cid}/messages`,'POST',{text:'hello',key:'unique-request-1'});
 const [a,b]=await Promise.all([send(),send()]);assert.equal(a.data.id,b.data.id);
 assert.equal((await call(`/api/conversations/${cid}/messages`,'POST',{text:'next',key:'unique-request-2'})).status,409);
 const claim=()=>call('/api/connector/claim','POST',{connector:'mac',ready:true},secret);
 const claims=await Promise.all([claim(),claim()]);const jobs=claims.map(r=>r.data.job).filter(Boolean);assert.equal(jobs.length,1);const job=jobs[0];
 assert.equal((await call('/api/connector/update','POST',{connector:'mac',job:job.id,lease:'wrong',status:'complete',answer:'bad'},secret)).status,409);
 const answer='完整回答 '.repeat(1000), payload={connector:'mac',job:job.id,lease:job.lease_token,status:'complete',answer};
 assert.equal((await call('/api/connector/update','POST',payload,secret)).status,200);
 assert.equal((await call('/api/connector/update','POST',payload,secret)).status,200);
 const messages=(await call(`/api/conversations/${cid}/messages`)).data.messages;assert.equal(messages.length,1);assert.equal(messages[0].answer,answer);assert.equal(messages[0].status,'complete');
});
test('expired delivery is failed, not claimed again',async()=>{
 const cid=(await call('/api/conversations','POST',{})).data.id;
 await call(`/api/conversations/${cid}/messages`,'POST',{text:'test',key:'expiry-request-1'});
 const job=(await call('/api/connector/claim','POST',{connector:'mac',ready:true},secret)).data.job;
 await db.prepare('UPDATE jobs SET lease_until=0 WHERE id=?').bind(job.id).run();
 assert.equal((await call('/api/connector/claim','POST',{connector:'mac',ready:true},secret)).data.job,null);
 assert.equal((await call(`/api/conversations/${cid}/messages`)).data.messages[0].status,'failed');
});
test('invalid origins, forged token and connector privileges are rejected',async()=>{
 const res=await mf.dispatchFetch('http://localhost/api/conversations',{headers:{Origin:'https://evil.example',Authorization:'Bearer '+token}});assert.equal(res.status,403);
 assert.equal((await call('/api/conversations','GET',undefined,token+'x')).status,401);
 assert.equal((await call('/api/connector/claim','POST',{connector:'mac',ready:true})).status,401);
 assert.equal((await call('/api/login','POST',{code:'wrong'},null)).status,401);
});
