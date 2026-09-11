"""Isolated WebBridge transport for explicitly tagged Relay tabs only."""
import hmac
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Bridge:
    def __init__(self, token, port=5011):
        self.token, self.port = token, port
        self.pages = {}
        self.lock = threading.Lock()

    def snapshots(self):
        with self.lock:
            return [dict(p['snapshot'], page_id=pid, alive=time.time()-p['seen'] < 20)
                    for pid, p in self.pages.items() if p.get('snapshot')]

    def send(self, pid, text):
        with self.lock:
            page = self.pages.get(pid)
            if not page or time.time()-page['seen'] >= 20:
                raise RuntimeError('浏览器页面已断开')
            if page.get('command') or page['snapshot'].get('isGenerating') or page['snapshot'].get('busy'):
                raise RuntimeError('浏览器页面正在处理另一条消息')
            command = {'id': uuid.uuid4().hex, 'cmd': 'send', 'text': text, 'expires': time.time()+25}
            page['command'] = command
            return command['id']

    def start(self):
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, data, status=200, content_type='application/json'):
                raw = data.encode() if isinstance(data, str) else json.dumps(data, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(raw)))
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if hmac.compare_digest(self.path, f'/install/{bridge.token}.user.js'):
                    script = (Path(__file__).parent / 'relay.user.js').read_text()
                    script = script.replace('__BRIDGE_TOKEN__', bridge.token).replace('__BRIDGE_PORT__', str(bridge.port))
                    return self.reply(script, content_type='application/javascript; charset=utf-8')
                self.reply({'error':'Not found'},404)

            def do_POST(self):
                if not hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+bridge.token):
                    return self.reply({'error':'Unauthorized'},401)
                try:
                    n = int(self.headers.get('Content-Length',0))
                    if not 0 < n <= 600000:
                        return self.reply({'error':'Invalid length'},413)
                    b = json.loads(self.rfile.read(n))
                    pid = b.get('page_id','')
                    if not isinstance(pid,str) or not pid.startswith('relay_') or len(pid)>140:
                        return self.reply({'error':'Invalid page'},400)
                    with bridge.lock:
                        if self.path == '/poll':
                            snap = b.get('snapshot')
                            if not isinstance(snap,dict) or not isinstance(snap.get('relaySession'),str):
                                return self.reply({'error':'Relay tab required'},400)
                            page = bridge.pages.setdefault(pid, {'command':None})
                            page.update(snapshot=snap, seen=time.time())
                            cmd = page.get('command')
                            if cmd and not snap.get('busy'):
                                page['command'] = None
                                if cmd['expires'] > time.time():
                                    return self.reply(cmd)
                            return self.reply({})
                        if self.path == '/result':
                            page = bridge.pages.get(pid)
                            if page:
                                page['result'] = b.get('result',{})
                            return self.reply({'ok':True})
                    self.reply({'error':'Not found'},404)
                except (ValueError,KeyError,TypeError):
                    self.reply({'error':'Invalid request'},400)

        self.server = ThreadingHTTPServer(('127.0.0.1', self.port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

