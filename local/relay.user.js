// ==UserScript==
// @name         Bridge Chat · Private Relay
// @namespace    bridge-chat-relay
// @version      0.1.0
// @description  Connect only dedicated Bridge Chat tabs to your local computer.
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==
(() => {
 'use strict';
 if(window.top!==window.self)return;
 const match=location.hash.match(/^#bridge-chat=([0-9a-f-]{36})$/);
 if(match)window.name='relay_'+match[1];
 if(!/^relay_[0-9a-f-]{36}$/.test(window.name))return;
 const session=window.name.slice(6), pid=window.name+'_'+crypto.randomUUID().slice(0,8);
 const BASE='http://127.0.0.1:__BRIDGE_PORT__',TOKEN='__BRIDGE_TOKEN__';
 let busy=false,commandError='',lastCommand=null;
 const badge=document.createElement('div');badge.textContent='Bridge Chat · 连接中';
 badge.style.cssText='position:fixed;bottom:12px;right:12px;z-index:999999;background:#183e37;color:#fff;padding:8px 13px;border-radius:20px;font:12px system-ui;pointer-events:none';document.body.append(badge);
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 function api(path,data){return new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'POST',url:BASE+path,headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN},data:JSON.stringify({page_id:pid,...data}),timeout:8000,onload:r=>{try{if(r.status!==200)throw new Error('Bridge disconnected');resolve(JSON.parse(r.responseText));}catch(e){reject(e);}},onerror:()=>reject(new Error('Bridge offline')),ontimeout:()=>reject(new Error('Bridge timeout'))}));}
 const editor=()=>document.querySelector('#prompt-textarea')||document.querySelector('[contenteditable="true"][role="textbox"]')||document.querySelector('textarea[name="prompt-textarea"]');
 const visible=e=>!!e && !!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
 function generating(){return [...document.querySelectorAll('button[data-testid="stop-button"],button[aria-label="Stop answering"],button[aria-label="Stop streaming"],button[aria-label="Stop"],button[aria-label="停止"],button[aria-label="停止生成"]')].some(visible);}
 function snapshot(){
  const users=[...document.querySelectorAll('[data-message-author-role="user"]')], assistants=[...document.querySelectorAll('[data-message-author-role="assistant"]')],last=assistants.at(-1);
  const text=e=>e?.innerText?.trim()||'';const lastText=text(last?.querySelector('.markdown')||last);
  return {relaySession:session,url:location.href,hasEditor:!!editor(),editorText:editor()?.value||editor()?.innerText||'',userCount:users.length,assistantCount:assistants.length,lastUser:text(users.at(-1)),lastAssistant:lastText.slice(0,120000),answerTruncated:lastText.length>120000,isGenerating:generating(),busy,commandError,lastCommand};
 }
 async function execute(cmd){
  busy=true;commandError='';lastCommand=cmd.id;
  try{
   if(cmd.cmd!=='send'||typeof cmd.text!=='string')throw new Error('Invalid command');
   const ed=editor();if(!ed)throw new Error('找不到输入框，请检查登录状态');
   if(generating()||(ed.value||ed.innerText||'').trim())throw new Error('页面正在使用中');
   const before=snapshot();ed.focus();
   if(ed.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ed,cmd.text);ed.dispatchEvent(new Event('input',{bubbles:true}));}
   else{document.execCommand('selectAll',false);document.execCommand('insertText',false,cmd.text);}
   let button;for(let i=0;i<20;i++){button=[...document.querySelectorAll('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send"],button[aria-label="发送"],button[aria-label="发送提示"]')].find(b=>visible(b)&&!b.disabled);if(button)break;await sleep(250);}
   if(!button)throw new Error('找不到发送按钮，请更新页面适配');
   button.click();let accepted=false;const deadline=Date.now()+25*60*1000;
   while(Date.now()<deadline){await sleep(1000);const s=snapshot();if(s.userCount>before.userCount)accepted=true;if(accepted&&s.assistantCount>before.assistantCount&&!s.isGenerating){await sleep(2000);if(!generating())return;}if(!accepted&&Date.now()>deadline-25*60*1000+30000)throw new Error('消息投递未确认');}
   throw new Error('生成等待超时');
  }catch(e){commandError=e.message;}finally{busy=false;await api('/result',{result:{id:cmd.id,ok:!commandError,error:commandError}}).catch(()=>{});}
 }
 async function loop(){while(true){try{const cmd=await api('/poll',{snapshot:snapshot()});badge.textContent=busy?'Bridge Chat · 正在回答':'Bridge Chat · 已连接';if(cmd.cmd&&!busy)void execute(cmd);}catch{badge.textContent='Bridge Chat · 等待本机连接';}await sleep(1000);}}
 void loop();
})();
