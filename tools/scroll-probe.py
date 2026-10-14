# -*- coding: utf-8 -*-
"""滚动体检：用**真实触摸手势**验证页面能不能纵向滚动。

为什么非要真手势：
  window.scrollTo 走的是「脚本滚动」，跟手指滑动不是一条路径。
  浏览器上有个经典故障 —— body 因为 overflow-x 非 visible 被计算成滚动容器，
  它自身高度等于内容、根本滚不动，手指滑动全被它吃掉，脚本 scrollTo 却照样好使。
  也就是说：只测脚本滚动，这个 bug 一定漏网。

两个必须绕开的坑（都是实测踩出来的）：
  1. html 上有 scroll-behavior: smooth，scrollTo 之后同步读 scrollY 永远是 0，
     那是动画没跑完，不是滚不动。
  2. Playwright 自带的 chrome-headless-shell 发不出触摸事件 ——
     Input.synthesizeScrollGesture 和 Input.dispatchTouchEvent 都当没发生过。
     必须用完整内核（channel='msedge'）。改方案前先跑 tools/scroll-control.py 对照，
     那个脚本会用一个「必然能滚的空白长页」验证探针本身好不好使。

前置：node server.js 8000 与 python tools/apk-preview.py 8010 都在跑。
用法：python tools/scroll-probe.py
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8010'

# 截图里量出来的那档放最前面（宽屏/模拟器），后面是手机竖屏、手机横屏
VIEWPORTS = [
    ('宽屏 1280x720', 1280, 720, 1),
    ('手机竖屏 393x851', 393, 851, 2.75),
    ('手机横屏 851x393', 851, 393, 2.75),
]

PAGES = [
    ('剧库列表', '/index.html', '.dj-card'),
    ('播放页', '/detail.html?id=86162', '.jkp-video'),
]

INFO = """() => {
  const d = document.documentElement;
  return {
    innerH: window.innerHeight,
    docH: d.scrollHeight,
    scrollTop: Math.round(d.scrollTop),
    bodyScrollTop: Math.round(document.body.scrollTop),
    htmlOverflow: getComputedStyle(d).overflowX + '/' + getComputedStyle(d).overflowY,
    bodyOverflow: getComputedStyle(document.body).overflowX + '/' + getComputedStyle(document.body).overflowY,
    cards: document.querySelectorAll('.dj-card').length
  };
}"""

# 找一个「手指放上去能被页面接住」的起点：
# 从上往下扫，跳过所有祖先里有 touch-action: none 的地方（播放器就是这种，
# 它要接管手势做音量/快进，手指落上去不滚页是它的设计，不是 bug）。
# 真实用户也是这么干的 —— 在下方内容区滑动，而不是死磕视频画面。
PICK_START = """(need) => {
  const w = window.innerWidth, h = window.innerHeight;
  const x = Math.round(w / 2);
  function blocked(y) {
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.documentElement) {
      if (getComputedStyle(el).touchAction === 'none') return el;
      el = el.parentElement;
    }
    return null;
  }
  for (let y = Math.round(h * 0.92); y > Math.round(h * 0.55); y -= 8) {
    if (!blocked(y)) return { y: y, blocked: null };
  }
  return { y: Math.round(h * 0.92), blocked: (blocked(Math.round(h * 0.92)) || {}).className || '?' };
}"""

bad = []


def swipe(cdp, x, y, dy, steps=14):
    """一串真实触摸事件模拟手指滑动。dy < 0 = 内容往上滚。"""
    cdp.send('Input.dispatchTouchEvent', {
        'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
    for i in range(1, steps + 1):
        cdp.send('Input.dispatchTouchEvent', {
            'type': 'touchMove',
            'touchPoints': [{'x': x, 'y': y + dy * i / steps}]})
        time.sleep(0.02)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


def check(browser, label, w, h, dpr, page_label, path, wait_sel):
    ctx = browser.new_context(viewport={'width': w, 'height': h},
                              device_scale_factor=dpr, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    cdp = ctx.new_cdp_session(pg)

    pg.goto(BASE + path, wait_until='domcontentloaded')
    try:
        pg.wait_for_selector(wait_sel, timeout=45000)
    except Exception:
        pass
    pg.wait_for_timeout(6000)

    s0 = pg.evaluate(INFO)
    need = s0['docH'] - s0['innerH']

    print('--- %s / %s ---' % (label, page_label))
    print('  视口高 %d / 文档高 %d / 需要滚动 %d' % (s0['innerH'], s0['docH'], need))
    print('  html overflow=%s   body overflow=%s' % (s0['htmlOverflow'], s0['bodyOverflow']))

    # 起点要选在「页面接得住手指」的地方，绕开 touch-action: none 的播放器
    start = pg.evaluate(PICK_START, need)
    x = w // 2
    y = int(start['y'])
    if start['blocked']:
        print('  ⚠ 从 0.55h 到 0.92h 都被 touch-action:none 挡住了（%s）' % start['blocked'])
    else:
        print('  手势起点 y=%d（此处不归播放器管）' % y)

    # 手指往上划两次
    swipe(cdp, x, y, -int(h * 0.50))
    pg.wait_for_timeout(800)
    s1 = pg.evaluate(INFO)
    swipe(cdp, x, y, -int(h * 0.50))
    pg.wait_for_timeout(800)
    s2 = pg.evaluate(INFO)

    print('  第一次手势后 scrollTop=%d（body 自身 %d）' % (s1['scrollTop'], s1['bodyScrollTop']))
    print('  第二次手势后 scrollTop=%d' % s2['scrollTop'])

    if need > 10 and s2['scrollTop'] < 50:
        bad.append('%s / %s：内容高 %dpx 但手势划不动（scrollTop=%d）'
                   % (label, page_label, need, s2['scrollTop']))
        print('  >>> 判定：滑不动 ❌')
    elif need <= 10:
        print('  >>> 判定：这一档本来就不需要滚动')
    else:
        print('  >>> 判定：能滚 ✓（划了 %d px）' % s2['scrollTop'])
    ctx.close()


def main():
    with sync_playwright() as p:
        # 必须用完整内核：chrome-headless-shell 发不出触摸事件
        b = p.chromium.launch(channel='msedge', headless=True,
                              args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        for label, w, h, dpr in VIEWPORTS:
            for page_label, path, sel in PAGES:
                check(b, label, w, h, dpr, page_label, path, sel)
            print()
        b.close()

    if bad:
        print('=== 滑不动的组合 %d 个 ===' % len(bad))
        for x in bad:
            print('  ' + x)
        sys.exit(1)
    print('=== 各视口 / 各页面 触摸纵向滚动均正常 ===')


if __name__ == '__main__':
    main()
