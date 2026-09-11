"""Generate local credentials once; never print secrets to a public log."""
import json
import os
import secrets
import uuid
from pathlib import Path

root=Path(__file__).resolve().parents[1]
local=root/'local-state'
local.mkdir(mode=0o700,exist_ok=True)
path=root/'.dev.vars'
if not path.exists():
    values={'INVITE_CODE':secrets.token_urlsafe(18),'SESSION_SECRET':secrets.token_urlsafe(32),'CONNECTOR_TOKEN':secrets.token_urlsafe(32)}
    fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f:f.write(''.join(f'{k}={v}\n' for k,v in values.items()))
else:
    values=dict(line.split('=',1) for line in path.read_text().splitlines() if '=' in line and not line.startswith('#'))
config=local/'config.json'
if not config.exists():
    cfg={'relay_url':'http://127.0.0.1:8787','connector_token':values['CONNECTOR_TOKEN'],'connector_id':str(uuid.uuid4()),'bridge_token':secrets.token_urlsafe(32),'bridge_port':5011,'target_url':'https://chatgpt.com/','job_timeout':1500}
    fd=os.open(config,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as f:json.dump(cfg,f,indent=2)
cfg=json.loads(config.read_text())
installer=f"http://127.0.0.1:{cfg['bridge_port']}/install/{cfg['bridge_token']}.user.js"
instructions=f'''# Bridge Chat 本机凭证（不要上传 GitHub）

网站邀请码：{values['INVITE_CODE']}

## 安装一次
1. Chrome 安装并启用 Tampermonkey。
2. 本机服务运行时，用 Chrome 打开以下链接，安装 Bridge Chat 专用脚本：
   {installer}
3. Chrome 若提示需要“允许用户脚本”或开发者模式，在扩展设置中开启。
4. 打开以下专用待机页，登录 ChatGPT。右下角应显示 Bridge Chat 已连接：
   https://chatgpt.com/#bridge-chat=00000000-0000-0000-0000-000000000000
5. 在网站上输入邀请码即可开始。外部用户不需要安装脚本。

每个网页会话会自动在 Chrome 中打开独立页面。已有个人对话不会被选中。
以后运行：python3 scripts/launch.py --publish
停止：向运行中的 launch.py 发送 Ctrl+C，或使用 local-state/launcher.pid 停止对应进程。
'''
secret_doc=local/'ACCESS.md'
fd=os.open(secret_doc,os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as f:f.write(instructions)
print('本机配置已准备：local-state/ACCESS.md（内含邀请码及安装链接）')
