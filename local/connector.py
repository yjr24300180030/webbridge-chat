"""Mac connector: pulls jobs, operates dedicated WebBridge tabs, uploads answers.

Standard library only. One process / one in-flight job, with durable send journal.
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from bridge import Bridge


def normalized(s):
    return ' '.join(s.split())


def fingerprint(text):
    return hashlib.sha256(normalized(text).encode()).hexdigest()


def persistent_chat_path(path):
    # ChatGPT briefly uses /c/WEB:<uuid> before assigning a durable conversation.
    return bool(re.search(r'/c/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',path,re.I))


def project_id(url):
    match=re.search(r'/g/(g-p-[0-9a-f]+)(?:[-/]|$)',urllib.parse.urlsplit(url).path)
    return match[1] if match else None


class Relay:
    def __init__(self, config, bridge, db):
        self.config, self.bridge, self.db = config, bridge, db
        self.connector = config['connector_id']
        db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,url TEXT,prompt_hash TEXT,count INTEGER)')
        db.execute('CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY,stage TEXT,command TEXT)')
        db.commit()

    def call(self, path, payload):
        req = urllib.request.Request(self.config['relay_url'].rstrip('/')+path,
            data=json.dumps(dict(payload, connector=self.connector)).encode(),
            headers={'Content-Type':'application/json','Authorization':'Bearer '+self.config['connector_token']})
        with urllib.request.urlopen(req, timeout=12) as response:
            return json.load(response)

    def update(self, job, status='running', answer=None, error=None):
        payload={'job':job['id'],'lease':job['lease_token'],'status':status}
        if answer is not None:payload['answer']=answer
        if error is not None:payload['error']=error[:500]
        return self.call('/api/connector/update',payload)

    def page(self, session):
        candidates=[p for p in self.bridge.snapshots() if p.get('relaySession')==session and p.get('alive')]
        if len(candidates)>1:raise RuntimeError('此会话有重复页面，请关闭重复页后再继续')
        return candidates[0] if candidates else None

    def open_page(self, job, saved):
        p=self.page(job['conversation'])
        if p:return p
        target=saved[0] if saved else self.config['target_url']
        url=urllib.parse.urlsplit(target)
        if url.scheme!='https' or url.hostname!='chatgpt.com':raise RuntimeError('本机目标 URL 必须为 chatgpt.com')
        target=urllib.parse.urlunsplit((url.scheme,url.netloc,url.path,url.query,'bridge-chat='+job['conversation']))
        subprocess.run(['open','-a','Google Chrome',target],check=True,timeout=10)
        deadline=time.monotonic()+40
        while time.monotonic()<deadline:
            self.update(job)
            p=self.page(job['conversation'])
            if p and p.get('hasEditor'):return p
            time.sleep(2)
        raise RuntimeError('专用网页未连接。请安装 Bridge Chat 油猴脚本并保持 Chrome 登录')

    def process(self, job):
        if self.db.execute('SELECT id FROM journal WHERE id=?',(job['id'],)).fetchone():
            raise RuntimeError('请求曾在本机处理，投递状态需要人工检查；不会重复发送')
        self.db.execute('INSERT INTO journal VALUES(?,?,?)',(job['id'],'claimed',None));self.db.commit()
        saved=self.db.execute('SELECT url,prompt_hash,count FROM sessions WHERE id=?',(job['conversation'],)).fetchone()
        p=self.open_page(job,saved)
        target_project=project_id(self.config.get('target_url',''))
        if not saved and target_project and project_id(p.get('url',''))!=target_project:
            raise RuntimeError('新对话未进入指定 Project，拒绝发送')
        if p.get('isGenerating') or p.get('busy') or p.get('editorText','').strip():raise RuntimeError('此页面正在使用，请稍后再试')
        if saved:
            if urllib.parse.urlsplit(p['url']).path!=urllib.parse.urlsplit(saved[0]).path:raise RuntimeError('会话页面已切换，拒绝发送到其他对话')
            if fingerprint(p.get('lastUser',''))!=saved[1] or p.get('assistantCount')!=saved[2]:raise RuntimeError('原会话已被手动修改，请在网页中新建对话')
        elif p.get('userCount',0) or p.get('assistantCount',0):raise RuntimeError('新会话必须使用空白页面')
        before=p.get('assistantCount',0);before_users=p.get('userCount',0);pid=p['page_id'];expected=fingerprint(job['prompt'])
        # Intent is durable before command enqueue. A crash can fail a request, never resend it.
        self.db.execute('UPDATE journal SET stage=? WHERE id=?',('sending',job['id']));self.db.commit()
        command=self.bridge.send(pid,job['prompt'])
        self.db.execute('UPDATE journal SET command=? WHERE id=?',(command,job['id']));self.db.commit()
        started=time.monotonic();confirmed=False;stable_since=None;previous='';next_update=0;missing_since=None;initial_path=urllib.parse.urlsplit(p['url']).path;bound_path=initial_path if saved else None
        while time.monotonic()-started < self.config.get('job_timeout',1500):
            t=time.monotonic();p=self.page(job['conversation'])
            if t>=next_update:self.update(job);next_update=t+8
            if not p:
                missing_since=missing_since or t
                if t-missing_since>60:raise RuntimeError('浏览器已断开，投递状态未知；未自动重发')
                time.sleep(1);continue
            missing_since=None
            path=urllib.parse.urlsplit(p['url']).path
            if bound_path and path!=bound_path:raise RuntimeError('生成期间会话页面已切换')
            if not saved and persistent_chat_path(path) and bound_path is None:bound_path=path
            if p.get('lastCommand')==command and p.get('commandError'):raise RuntimeError(p['commandError'])
            if p.get('userCount',0)>before_users and fingerprint(p.get('lastUser',''))==expected:confirmed=True
            if p.get('userCount',0)>before_users and fingerprint(p.get('lastUser',''))!=expected:raise RuntimeError('页面消息与当前请求不匹配')
            if not confirmed:
                if t-started>35:raise RuntimeError('消息投递未确认，请检查本机页面；未自动重发')
                time.sleep(1);continue
            if p.get('answerTruncated'):raise RuntimeError('回答超过长度上限，请在本机查看完整结果')
            answer=p.get('lastAssistant','') if p.get('assistantCount',0)>before else ''
            errors=['error in message stream','message delivery timed out','something went wrong','too many requests','rate limit','请求过多']
            if answer and any(e in answer.lower() for e in errors) and not p.get('isGenerating'):
                raise RuntimeError('ChatGPT 页面返回错误，请在本机处理后继续')
            if answer!=previous:
                self.update(job,answer=answer);previous=answer;stable_since=t
            if answer.strip() and not p.get('isGenerating') and not p.get('busy') and stable_since is not None and t-stable_since>=3:
                if not bound_path or not persistent_chat_path(bound_path):raise RuntimeError('未确认独立对话地址')
                self.db.execute('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)',(job['conversation'],p['url'],expected,p['assistantCount']))
                self.db.execute('UPDATE journal SET stage=? WHERE id=?',('complete',job['id']));self.db.commit()
                # Terminal uploads are idempotent. Retrying this upload never resends a prompt.
                for attempt in range(3):
                    try:return self.update(job,'complete',answer=answer)
                    except urllib.error.URLError:
                        if attempt==2:raise
                        time.sleep(2)
            time.sleep(1)
        raise RuntimeError('回答等待超时；未自动重发')

    def run(self):
        print('本机连接器已启动。等待网页消息。',flush=True)
        while True:
            job=None
            try:
                # Once installed, an idle dedicated tab proves the browser bridge is available.
                ready=any(p.get('alive') and p.get('hasEditor') for p in self.bridge.snapshots())
                result=self.call('/api/connector/claim',{'ready':ready})
                job=result.get('job')
                if job:self.process(job)
            except KeyboardInterrupt:raise
            except Exception as e:
                # Never print credentials, prompts, responses or full request URLs.
                message=str(e) if isinstance(e,RuntimeError) else '本机与消息服务连接失败'
                print(message,flush=True)
                if job:
                    try:self.update(job,'failed',error=message)
                    except Exception:pass
            time.sleep(2)


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--config',default='local-state/config.json');args=ap.parse_args()
    path=Path(args.config).resolve();config=json.loads(path.read_text())
    lock=open(path.parent/'connector.lock','w')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise SystemExit('已有连接器正在运行')
    bridge=Bridge(config['bridge_token'],config.get('bridge_port',5011));bridge.start()
    db=sqlite3.connect(path.parent/'connector.sqlite');os.chmod(path.parent/'connector.sqlite',0o600)
    Relay(config,bridge,db).run()


if __name__=='__main__':main()
