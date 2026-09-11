"""Explicit, one-shot live relay smoke. Sends only the fixed harmless prompt."""
import json
import time
import urllib.request
import uuid
from pathlib import Path

root=Path(__file__).resolve().parents[1]
base=(root/'local-state/public-url.txt').read_text().strip()
values=dict(line.split('=',1) for line in (root/'.dev.vars').read_text().splitlines() if '=' in line)
token=''
def call(path,data=None):
    headers={'Content-Type':'application/json','Origin':'https://yjr24300180030.github.io'}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,headers=headers)
    with urllib.request.urlopen(req,timeout=20) as response:return json.load(response)

token=call('/api/login',{'code':values['INVITE_CODE']})['token']
print('Authenticated public relay:',call('/api/status'),flush=True)
cid=call('/api/conversations',{})['id']
for prompt,expected in [
    ('连接测试：请仅回复 BRIDGE_OK，不需要解释。','BRIDGE_OK'),
    ('追问测试：请把你上一条回复的英文原样重复一遍，再加上 _FOLLOWUP，只输出这一行。','BRIDGE_OK_FOLLOWUP'),
]:
    job=call('/api/conversations/'+cid+'/messages',{'text':prompt,'key':str(uuid.uuid4())})['id']
    print('Sent once:',job,flush=True)
    for _ in range(60):
        messages=call('/api/conversations/'+cid+'/messages')['messages']
        current=next(m for m in messages if m['id']==job)
        print(current['status'], 'answer_chars='+str(len(current['answer'])),flush=True)
        if current['status'] in ('complete','failed'):
            print(json.dumps({k:current[k] for k in ('status','answer','error')},ensure_ascii=False),flush=True)
            if current['status']!='complete' or expected not in current['answer']:raise SystemExit(1)
            break
        time.sleep(3)
    else:raise SystemExit('Still pending; not resent. Check dedicated Chrome tab.')
print('PASS: live public relay and conversation follow-up',flush=True)
