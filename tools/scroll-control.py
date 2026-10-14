# -*- coding: utf-8 -*-
"""对照实验：拿一个必然能滚的长页面，验证「触摸探针」到底好不好使。

教训：CDP 的 Input.synthesizeScrollGesture 在 headless 里发不出真实触摸，
连一个必然能滚的页面都划不动 —— 直接拿它去测被测页面，只会得到假警报。
所以改成用 Input.dispatchTouchEvent 自己搓一串 touchStart / touchMove / touchEnd。

不先跑这个对照，就没法判断后面 scroll-probe.py 报的「滑不动」是真问题还是尺子坏。

用法：python tools/scroll-control.py
"""
import http.server
import os
import socketserver
import threading
import time

from playwright.sync_api import sync_playwright

CHROME = (r'C:\Users\Administrator\AppData\Local\ms-playwright'
          r'\chromium_headless_shell-1223\chrome-headless-shell-win64\chrome-headless-shell.exe')
ROOT = os.path.abspath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'shots', 'scrollctl'))
PORT = 8099


def swipe(cdp, x, y, dy, steps=12):
    """发一串真实触摸事件模拟手指滑动。dy < 0 = 内容往上滚。"""
    cdp.send('Input.dispatchTouchEvent', {
        'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
    for i in range(1, steps + 1):
        cdp.send('Input.dispatchTouchEvent', {
            'type': 'touchMove',
            'touchPoints': [{'x': x, 'y': y + dy * i / steps}]})
        time.sleep(0.016)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


def main():
    os.makedirs(ROOT, exist_ok=True)

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=ROOT, **kw)

        def log_message(self, *a):
            pass

    srv = socketserver.TCPServer(('127.0.0.1', PORT), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    ok = 0
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=['--no-sandbox'])
        for label, w, h in (('1280x720', 1280, 720), ('393x851', 393, 851)):
            ctx = b.new_context(viewport={'width': w, 'height': h},
                                is_mobile=True, has_touch=True)
            pg = ctx.new_page()
            cdp = ctx.new_cdp_session(pg)
            pg.goto('http://127.0.0.1:%d/tall.html' % PORT, wait_until='domcontentloaded')
            pg.wait_for_timeout(500)
            before = pg.evaluate('() => document.documentElement.scrollTop')
            swipe(cdp, w // 2, int(h * 0.7), -int(h * 0.5))
            pg.wait_for_timeout(700)
            after = pg.evaluate('() => document.documentElement.scrollTop')
            good = after > 50
            ok += 1 if good else 0
            print('对照 %-9s 划之前=%d 划之后=%d  =>  %s' % (
                label, before, after, '触摸探针有效 ✓' if good else '仍然无效 ✗'))
            ctx.close()
        b.close()
    srv.shutdown()

    print()
    if ok == 2:
        print('探针有效 —— 可以拿 scroll-probe.py 的结论当真。')
    else:
        print('探针还是发不出触摸，结论不可信。')
    raise SystemExit(0 if ok == 2 else 1)


if __name__ == '__main__':
    main()
