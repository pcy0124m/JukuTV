# -*- coding: utf-8 -*-
"""手机版剧库自检：先在 390x844 的移动视口里把整条链路跑一遍，再上真机。

前置：node server.js 8000 与 python tools/apk-preview.py 8010 都在跑。

注意：源站有多个 CDN 节点，个别节点会整段超时（vodcnd15 就挂过），
所以播放环节用「挑一个可达的剧」来验证链路，而不是死磕列表第一张。
"""
import os
import sys

from playwright.sync_api import sync_playwright

CHROME = (r'C:\Users\Administrator\AppData\Local\ms-playwright'
          r'\chromium_headless_shell-1223\chrome-headless-shell-win64\chrome-headless-shell.exe')
BASE = 'http://127.0.0.1:8010'
OUT = os.path.abspath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'shots', 'apk'))

# 已知至少有一个节点可达的剧，按顺序试
CANDIDATES = ['86162', '70135', '144891', '96088']

errors = []


def note(tag, text):
    print('%-6s %s' % (tag, text))


def stat_of(pg):
    return pg.evaluate("""() => {
      const v = document.querySelector('.jkp-video');
      return {
        ready: v ? v.readyState : -1,
        time: v ? Math.round(v.currentTime) : -1,
        dur: v ? Math.round(v.duration || 0) : -1,
        w: v ? v.videoWidth : 0,
        h: v ? v.videoHeight : 0,
        title: (document.querySelector('#wTitle') || {}).textContent || ''
      };
    }""")


def run():
    with sync_playwright() as p:
        b = p.chromium.launch(
            headless=True, executable_path=CHROME,
            args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(
            viewport={'width': 390, 'height': 844},
            device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = ctx.new_page()

        pg.on('console', lambda m: errors.append('[console] %s' % m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append('[pageerror] %s' % e))

        # ---------- 1. 列表页 ----------
        pg.goto(BASE + '/index.html', wait_until='domcontentloaded')
        pg.wait_for_selector('.dj-card', timeout=60000)
        pg.wait_for_timeout(9000)

        s = pg.evaluate("""() => {
          const imgs = Array.from(document.querySelectorAll('.dj-card img'));
          const tabbar = document.querySelector('.m-tabbar');
          const sec = document.getElementById('mContinue');
          const live = document.getElementById('jkLiveBtn');
          const gear = document.getElementById('jkSettingsBtn');
          return {
            cards: document.querySelectorAll('.dj-card').length,
            covers: imgs.filter(i => i.naturalWidth > 0).length,
            tabs: document.querySelectorAll('.m-tabs .jk-nav').length,
            hasLive: !!live,
            hasGear: !!gear,
            gearTop: gear ? Math.round(gear.getBoundingClientRect().top) : -1,
            liveW: live ? Math.round(live.getBoundingClientRect().width) : -1,
            tabBottom: tabbar ? Math.round(window.innerHeight - tabbar.getBoundingClientRect().bottom) : -1,
            overflowX: document.documentElement.scrollWidth - window.innerWidth,
            continueHidden: sec ? sec.hidden : null,
            sub: (document.querySelector('#jkSub') || {}).textContent || ''
          };
        }""")
        note('列表', '卡片 %d 张，封面 %d 张' % (s['cards'], s['covers']))
        note('列表', '底部 tab %d 个 | %s' % (s['tabs'], s['sub']))
        note('入口', '直播按钮 %s（宽 %dpx）| 顶部设置按钮 %s（y=%d）' % (
            '在' if s['hasLive'] else '缺', s['liveW'],
            '在' if s['hasGear'] else '缺', s['gearTop']))
        note('布局', '底栏贴底 %dpx，横向溢出 %dpx' % (s['tabBottom'], s['overflowX']))
        note('布局', '空「继续观看」已收起：%s' % ('是' if s['continueHidden'] else '否'))
        pg.screenshot(path=os.path.join(OUT, '1_list.png'))

        # ---------- 1b. 直播入口在网页里应有降级提示 ----------
        # 浏览器预演里没有 JKShell 桥，点它不该白点 —— 应弹「要装成 APK」的提示
        pg.locator('#jkLiveBtn').click()
        pg.wait_for_timeout(600)
        tip = pg.evaluate("""() => {
          const t = document.querySelector('.jk-toast');
          return t ? t.textContent : null;
        }""")
        if tip and 'APK' in tip:
            note('入口', '无桥时降级提示正常：%s' % tip)
        else:
            note('入口', '降级提示未出现（toast=%r）' % tip)
            errors.append('[live] 直播入口在无桥环境下没有给出降级提示')

        # ---------- 2. 点卡片能进播放页 ----------
        pg.locator('.dj-card').first.click()
        pg.wait_for_url('**/detail.html*', timeout=20000)
        pg.wait_for_selector('.jkp-video', timeout=30000)
        note('跳转', '卡片 -> %s' % pg.url.split('/')[-1][:60])

        # ---------- 3. 切分类 ----------
        pg.goto(BASE + '/index.html', wait_until='domcontentloaded')
        pg.wait_for_selector('.dj-card', timeout=30000)
        pg.locator('.m-tabs .jk-nav').nth(1).click()
        pg.wait_for_timeout(6000)
        chips = pg.locator('.dj-cat').count()
        note('分类', '切到短剧 -> %s' % pg.inner_text('#jkSub'))
        note('分类', '二级分类 %d 个' % chips)
        if chips > 2:
            pg.locator('.dj-cat').nth(2).click()
            pg.wait_for_timeout(5000)
            note('分类', '点子分类 -> %s' % pg.inner_text('#jkSub'))
        pg.screenshot(path=os.path.join(OUT, '2_cat.png'))

        # ---------- 4. 播放链路（挑可达的源）----------
        picked = None
        for cid in CANDIDATES:
            pg.goto(BASE + '/detail.html?id=' + cid, wait_until='domcontentloaded')
            try:
                pg.wait_for_selector('.jkp-video', timeout=25000)
            except Exception:
                continue
            pg.wait_for_timeout(16000)
            st = stat_of(pg)
            if st['ready'] >= 3 and st['dur'] > 0:
                picked = (cid, st)
                break
            note('播放', '%s 未起播（readyState=%s）' % (cid, st['ready']))

        if picked:
            cid, st = picked
            note('播放', 'id=%s「%s」readyState=%s 位置=%ss 时长=%ss 画面=%sx%s' % (
                cid, st['title'], st['ready'], st['time'], st['dur'], st['w'], st['h']))
            pg.screenshot(path=os.path.join(OUT, '3_play.png'))
        else:
            note('播放', '所有候选源都没起播 —— 大概率是源站 CDN 节点的问题')
            pg.screenshot(path=os.path.join(OUT, '3_play.png'))

        # ---------- 5. 往下滚，看选集与简介 ----------
        pg.evaluate("window.scrollTo(0, window.innerHeight * 1.05)")
        pg.wait_for_timeout(900)
        pg.screenshot(path=os.path.join(OUT, '4_eps.png'))
        note('布局', '播放页横向溢出 %dpx' % pg.evaluate(
            "document.documentElement.scrollWidth - window.innerWidth"))

        b.close()


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    run()
    print()
    if errors:
        print('=== 前端报错 %d 条 ===' % len(errors))
        for e in errors[:20]:
            print('  ' + e)
        sys.exit(1)
    print('=== 无前端报错 ===')
