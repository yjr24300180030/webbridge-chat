const $=s=>document.querySelector(s);
const api=(window.BRIDGE_API||location.origin).replace(/\/$/,'');
let token=localStorage.getItem('bridge-session')||'',current=null,conversations=[],busy=false,polling=false;
let sending=false, retryKey=null, retryText=null, lastRender='';
async function request(path,method='GET',data){
 const res=await fetch(api+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data===undefined?undefined:JSON.stringify(data)});
 const result=await res.json();if(!res.ok){if(res.status===401 && path!=='/api/login'){token='';localStorage.removeItem('bridge-session');showLogin();}throw new Error(result.error||'请求失败');}return result;
}
function showLogin(){if(!$('#login').open)$('#login').showModal();}
$('#login').addEventListener('cancel',e=>e.preventDefault());
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;$('#login-error').textContent='';try{const r=await request('/api/login','POST',{code:$('#invite').value});token=r.token;localStorage.setItem('bridge-session',token);$('#invite').value='';$('#login').close();await refreshConversations();await poll();}catch(err){$('#login-error').textContent=err.message==='Failed to fetch'?'暂时连接不到服务，请稍后重试。':err.message;}finally{button.disabled=false;}});
$('#logout').onclick=()=>{localStorage.removeItem('bridge-session');token='';current=null;conversations=[];$('#messages').replaceChildren();$('#conversations').replaceChildren();$('#welcome').hidden=false;showLogin();};
$('#menu').onclick=()=>$('#sidebar').classList.toggle('open');
function renderConversations(){
 const nav=$('#conversations');nav.replaceChildren();$('#conversation-count').textContent=conversations.length;
 if(!conversations.length){const p=document.createElement('p');p.className='empty-list';p.textContent='还没有对话，开始第一场吧。';nav.append(p);}
 for(const c of conversations){const b=document.createElement('button');b.className='conversation'+(c.id===current?' selected':'');b.textContent=c.title;b.title=c.title;b.onclick=()=>select(c.id);nav.append(b);}
 $('#chat-title').textContent=conversations.find(c=>c.id===current)?.title||'新对话';
}
async function refreshConversations(){conversations=(await request('/api/conversations')).conversations;renderConversations();}
async function select(cid){current=cid;lastRender='';busy=false;$('#messages').replaceChildren();$('#sidebar').classList.remove('open');$('#welcome').hidden=true;renderConversations();await refreshMessages();}
$('#new-chat').onclick=()=>{current=null;lastRender='';retryKey=null;retryText=null;busy=false;$('#messages').replaceChildren();$('#welcome').hidden=false;$('#notice').textContent='';$('#sidebar').classList.remove('open');renderConversations();setSend();$('#prompt').focus();};
function renderText(container,text){
 // All remote text is rendered as text nodes, including HTML and code fences.
 const chunks=text.split(/```[^\n]*\n|```/g);
 for(let i=0;i<chunks.length;i++){if(!chunks[i])continue;const el=document.createElement(i%2?'pre':'p');el.textContent=chunks[i];container.append(el);}
}
async function refreshMessages(){
 if(!current)return;const selected=current;
 const data=await request(`/api/conversations/${selected}/messages`);if(current!==selected)return;
 busy=data.messages.some(j=>['queued','running'].includes(j.status));setSend();
 const signature=JSON.stringify(data.messages);if(signature===lastRender)return;lastRender=signature;
 const area=$('#scroll-area'),nearBottom=area.scrollHeight-area.scrollTop-area.clientHeight<100;const messages=$('#messages');messages.replaceChildren();$('#welcome').hidden=data.messages.length>0;
 for(const j of data.messages){const turn=document.createElement('article');turn.className='turn';const user=document.createElement('div');user.className='user-message';user.textContent=j.prompt;turn.append(user);
  const label=document.createElement('div');label.className='answer-label';const mark=document.createElement('span');mark.textContent='渡';label.append(mark,document.createTextNode('BRIDGE'));turn.append(label);
  const answer=document.createElement('div');answer.className='answer';if(j.answer)renderText(answer,j.answer);
  if(['queued','running'].includes(j.status)){const status=document.createElement('div');status.className='pending';status.textContent=j.status==='queued'?'已收到，等待连接…':'正在思考…';answer.append(status);}
  if(j.status==='failed'){const err=document.createElement('div');err.className='error';err.textContent=j.error||'这次回答未完成，请稍后再试。';answer.append(err);}
  turn.append(answer);if(j.answer){const copy=document.createElement('button');copy.className='copy';copy.textContent='复制回答';copy.onclick=async()=>{try{await navigator.clipboard.writeText(j.answer);copy.textContent='已复制';}catch{copy.textContent='复制失败';}};turn.append(copy);}messages.append(turn);
 }
 if(nearBottom)area.scrollTop=area.scrollHeight;
}
function setSend(){$('#send').disabled=busy||sending||!$('#prompt').value.trim();$('#input-hint').textContent=busy?'回答正在生成，完成后可以继续对话':'Enter 发送 · Shift + Enter 换行';}
$('#prompt').addEventListener('input',()=>{const el=$('#prompt');el.style.height='auto';el.style.height=Math.min(170,el.scrollHeight)+'px';setSend();});
$('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!$('#send').disabled)$('#composer').requestSubmit();}});
document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{$('#prompt').value=b.dataset.prompt;$('#prompt').dispatchEvent(new Event('input'));$('#prompt').focus();});
$('#composer').addEventListener('submit',async e=>{e.preventDefault();if(sending||busy)return;const text=$('#prompt').value.trim();if(!text)return;sending=true;setSend();$('#notice').textContent='';
 try{if(!current){current=(await request('/api/conversations','POST',{})).id;await refreshConversations();}if(retryText!==text){retryText=text;retryKey=crypto.randomUUID();}await request(`/api/conversations/${current}/messages`,'POST',{text,key:retryKey});retryKey=null;retryText=null;$('#prompt').value='';$('#prompt').style.height='auto';await refreshConversations();await refreshMessages();$('#scroll-area').scrollTop=$('#scroll-area').scrollHeight;}
 catch(err){$('#notice').textContent=err.message==='Failed to fetch'?'网络连接中断。内容已保留，重新发送会检查是否已经收到。':err.message;}finally{sending=false;setSend();}
});
async function poll(){if(!token||polling)return;polling=true;try{const s=await request('/api/status');$('#service-status').classList.toggle('online',s.online);$('#service-status span').textContent=s.online?'服务在线':'暂时离线 · 可排队';await refreshMessages();}catch{$('#service-status').classList.remove('online');$('#service-status span').textContent='连接暂时中断';}finally{polling=false;}}
setInterval(poll,2000);setSend();if(token){refreshConversations().then(poll).catch(()=>showLogin());}else showLogin();
