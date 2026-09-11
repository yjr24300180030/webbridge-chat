"""GitHub Pages frontend + authenticated local gateway over a temporary HTTPS tunnel."""
import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

root=Path(__file__).resolve().parents[1]
ap=argparse.ArgumentParser();ap.add_argument('--publish',action='store_true',help='Update GitHub Pages API URL using this repository origin');args=ap.parse_args()
os.chdir(root)
subprocess.run([sys.executable,'scripts/setup.py'],check=True)
local=root/'local-state';lock=open(local/'launcher.lock','w')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:raise SystemExit('网站服务已在运行')
(local/'launcher.pid').write_text(str(os.getpid()))
cloudflared=shutil.which('cloudflared') or str(Path.home()/'.local/bin/cloudflared')
node=shutil.which('node') or '/opt/homebrew/bin/node'
processes=[];logs=[]
def launch(command,name,env=None):
    log=open(local/(name+'.log'),'a');logs.append(log)
    p=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,env=env);processes.append(p);return p
def stop(*_):raise KeyboardInterrupt
signal.signal(signal.SIGTERM,stop)
try:
    origin=''
    git=subprocess.run(['git','remote','get-url','origin'],capture_output=True,text=True)
    m=re.search(r'github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$',git.stdout.strip())
    if m:origin=f'https://{m[1]}.github.io'
    env=dict(os.environ,ALLOWED_ORIGIN=origin)
    gateway=launch([node,'scripts/serve.mjs'],'gateway',env)
    for _ in range(40):
        try:
            urllib.request.urlopen('http://127.0.0.1:8787/',timeout=1).close();break
        except Exception:
            if gateway.poll() is not None:raise RuntimeError('消息服务启动失败，请查看 local-state/gateway.log')
            time.sleep(.5)
    else:raise RuntimeError('消息服务启动超时')
    # A fresh file prevents parsing an old tunnel address.
    (local/'tunnel.log').write_text('')
    tunnel=launch([cloudflared,'tunnel','--no-autoupdate','--url','http://127.0.0.1:8787','--protocol','http2'],'tunnel')
    public_url=None
    for _ in range(90):
        found=re.search(r'https://[a-z0-9-]+\.trycloudflare\.com',(local/'tunnel.log').read_text())
        if found:public_url=found[0];break
        if tunnel.poll() is not None:raise RuntimeError('HTTPS 隧道启动失败')
        time.sleep(1)
    if not public_url:raise RuntimeError('未获得 HTTPS 地址，请检查网络')
    (local/'public-url.txt').write_text(public_url+'\n')
    (root/'public/config.js').write_text('// Public API origin only. No secrets.\nwindow.BRIDGE_API = '+json.dumps(public_url)+';\n')
    if args.publish:
        subprocess.run(['git','add','public/config.js'],check=True)
        dirty=subprocess.run(['git','diff','--cached','--quiet']).returncode
        if dirty:
            subprocess.run(['git','commit','-m','Update local relay endpoint'],check=True)
            subprocess.run(['git','push','origin','main'],check=True)
    connector=launch([sys.executable,'local/connector.py'],'connector')
    print(f'消息入口：{public_url}',flush=True)
    if m:print(f'GitHub 网页：https://{m[1]}.github.io/{m[2]}/',flush=True)
    print('安装与邀请码：local-state/ACCESS.md。保持此进程、Chrome 与电脑运行。',flush=True)
    while True:
        for p in processes:
            if p.poll() is not None:raise RuntimeError('子服务退出，已停止整条链路，请检查 local-state 日志')
        time.sleep(2)
except KeyboardInterrupt:
    print('已停止网站本机服务。',flush=True)
finally:
    for p in reversed(processes):
        if p.poll() is None:p.terminate()
    for p in processes:
        try:p.wait(timeout=5)
        except subprocess.TimeoutExpired:p.kill()
    for log in logs:log.close()
    (local/'launcher.pid').unlink(missing_ok=True)
