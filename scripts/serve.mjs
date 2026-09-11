import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const vars={};
for(const line of readFileSync(resolve(root,'.dev.vars'),'utf8').split('\n')){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m)vars[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');}
for(const key of ['INVITE_CODE','SESSION_SECRET','CONNECTOR_TOKEN'])if(!vars[key])throw new Error(`Missing ${key} in .dev.vars`);
mkdirSync(resolve(root,'dist'),{recursive:true});
await build({entryPoints:[resolve(root,'src/worker.ts')],bundle:true,format:'esm',outfile:resolve(root,'dist/worker.mjs'),platform:'browser',target:'es2022'});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:resolve(root,'dist/worker.mjs'),compatibilityDate:'2026-08-01',host:'127.0.0.1',port:0,
 bindings:{...vars,ALLOWED_ORIGIN:process.env.ALLOWED_ORIGIN||vars.ALLOWED_ORIGIN||'',DAILY_LIMIT:'30'},
 d1Databases:{DB:'relay-db'},resourcePersistencePath:resolve(root,'local-state/data'),
 assets:{directory:resolve(root,'public'),binding:'ASSETS',routerConfig:{has_user_worker:true},assetConfig:{html_handling:'auto-trailing-slash'}}}));
const db=await mf.getD1Database('DB');
const exists=await db.prepare("SELECT name FROM sqlite_master WHERE name='jobs'").first();
if(!exists){const sql=readFileSync(resolve(root,'migrations/0001.sql'),'utf8');await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
await mf.ready;
// Expose only the application, never Miniflare's development/control endpoints.
const server=createServer(async(req,res)=>{
 try{
  const path=(req.url||'/').split('?')[0];
  if(!path.startsWith('/api/') && !['/','/index.html','/style.css','/app.js','/config.js'].includes(path)){res.writeHead(404);res.end('Not found');return;}
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>300000){res.writeHead(413);res.end('Too large');return;}chunks.push(chunk);}
  const headers=new Headers();for(const [k,v] of Object.entries(req.headers)){if(v && k!=='host')headers.set(k,Array.isArray(v)?v.join(','):v);}
  const origin=(req.headers['x-forwarded-proto']==='https'?'https':'http')+'://'+(req.headers.host||'127.0.0.1');
  const response=await mf.dispatchFetch(origin+(req.url||'/'),{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'服务暂时不可用'}));}
});
server.listen(Number(process.env.PORT||8787),'127.0.0.1',()=>console.log('Relay gateway ready: http://127.0.0.1:8787'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{server.close();await mf.dispose();process.exit(0);});
