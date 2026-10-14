# -*- coding: utf-8 -*-
"""本地预演 APK 里的手机版网页。

静态资源直接来自 app/src/main/assets/www，和打进 APK 的是同一份。
/proxy 转发给 8000 端口上的桌面版 server.js —— 在 APK 里这个角色由 Kotlin
拦截层扮演，两者行为对齐，所以这里测出来的结果对 APK 有参考价值。

用法：
    node server.js 8000          # 另开一个终端，桌面版服务
    python tools/apk-preview.py 8010
"""
import http.server
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..',
    'app', 'src', 'main', 'assets', 'www'))
UPSTREAM = 'http://127.0.0.1:8000'

KEEP = ('content-type', 'content-length', 'content-range', 'accept-ranges')


class Handler(http.server.SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path.startswith('/proxy'):
            return self.forward()
        return super().do_GET()

    def forward(self):
        headers = {}
        rng = self.headers.get('Range')
        if rng:
            headers['Range'] = rng
        try:
            req = urllib.request.Request(UPSTREAM + self.path, headers=headers)
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read()
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() in KEEP:
                        self.send_header(k, v)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            try:
                self.wfile.write(str(e).encode('utf-8'))
            except Exception:
                pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8010
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('preview http://127.0.0.1:%d -> %s' % (port, ROOT))
    srv.serve_forever()


if __name__ == '__main__':
    main()
