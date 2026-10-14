/* ============ 剧库 · 主界面逻辑（推荐 / 分类 / 搜索 / 继续观看 / 分页） ============ */
(function () {
  'use strict';

  const JK = window.JK, Store = window.JKStore;
  const $ = s => document.querySelector(s);

  const FALLBACK_NAV = [
    { key: 'rec', name: '推荐', t: 37, icon: '🔥', sub: [] },
    {
      key: 'short', name: '短剧', t: 37, icon: '🎭',
      sub: [
        { t: 37, name: '全部' }, { t: 45, name: '反转爽剧' }, { t: 46, name: '言情总裁' },
        { t: 47, name: '现代都市' }, { t: 48, name: '古装仙侠' }, { t: 43, name: '重生民国' },
        { t: 44, name: '穿越现代' }, { t: 49, name: '悬疑烧脑' }
      ]
    },
    { key: 'tv', name: '连续剧', t: 2, icon: '📺', sub: [{ t: 2, name: '全部' }] },
    { key: 'anime', name: '动漫', t: 4, icon: '🌸', sub: [{ t: 4, name: '全部' }] }
  ];

  const state = {
    nav: FALLBACK_NAV,
    key: (Store.settings().cat || 'rec'),
    t: 37,
    pg: 1,
    kw: '',
    list: [],
    pagecount: 1,
    total: 0,
    loading: false,
    reqSeq: 0
  };

  const curNav = () => state.nav.find(n => n.key === state.key) || state.nav[0];

  // ---------------------------------------------------- 侧栏
  function loadNav() {
    // 手机端用打包进来的常量表，桌面端才去问服务端
    if (window.JkApi && JkApi.NAV && JkApi.NAV.length) {
      state.nav = JkApi.NAV;
      return Promise.resolve();
    }
    return fetch('/api/juku-nav').then(r => r.json())
      .then(j => { if (j.ok && j.nav && j.nav.length) state.nav = j.nav; })
      .catch(() => {});
  }

  function renderNav() {
    $('#jkNav').innerHTML = state.nav.map(n =>
      '<button class="jk-nav' + (n.key === state.key ? ' on' : '') + '" data-key="' + n.key + '">' +
      '<span class="ico">' + (n.icon || '🎬') + '</span>' + JK.esc(n.name) +
      '<span class="cnt" data-cnt="' + n.key + '"></span></button>'
    ).join('');
  }

  function updateNavCount(total) {
    const el = document.querySelector('[data-cnt="' + state.key + '"]');
    if (el) el.textContent = total ? total.toLocaleString() : '';
  }

  function setNav(key) {
    const n = state.nav.find(x => x.key === key);
    if (!n) return;
    state.key = key;
    state.t = n.t;
    state.pg = 1;
    state.kw = '';
    $('#jkKw').value = '';
    $('#jkH1').textContent = n.name;
    Store.setSettings({ cat: key });
    renderNav();
    renderCats();
    loadPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------------------------------------------------- 分类 chips
  function renderCats() {
    const n = curNav();
    const box = $('#jkCats');
    const subs = n.sub || [];
    if (subs.length <= 1) { box.innerHTML = ''; return; }
    box.innerHTML = subs.map(s =>
      '<button class="dj-cat' + (Number(s.t) === Number(state.t) ? ' active' : '') + '" data-t="' + s.t + '">' + JK.esc(s.name) + '</button>'
    ).join('');
  }

  function subName() {
    const n = curNav();
    const s = (n.sub || []).find(x => Number(x.t) === Number(state.t));
    return s ? s.name : n.name;
  }

  // ---------------------------------------------------- 列表 / 搜索
  function renderSkeleton() {
    $('#jkGrid').innerHTML = new Array(12).fill(
      '<div class="jk-skel"><div class="ph"></div><div class="ln" style="width:70%"></div><div class="ln" style="width:45%"></div></div>'
    ).join('');
  }

  async function loadPage() {
    const seq = ++state.reqSeq;
    state.loading = true;
    renderSkeleton();
    $('#jkPager').innerHTML = '';
    $('#jkSub').textContent = state.kw ? '搜索中…（扫描当前分类页面）' : '加载中…';
    const btn = $('#jkSearchBtn');
    if (btn) btn.disabled = true;

    try {
      if (state.kw) await doSearch(); else await doList();
    } catch (e) {
      if (seq !== state.reqSeq) return;
      $('#jkGrid').innerHTML =
        '<div class="dj-empty">加载失败：' + JK.esc(e.message || '网络错误') +
        '<br><br><button class="jk-abtn primary" onclick="location.reload()">重新加载</button></div>';
      $('#jkSub').textContent = '加载失败';
    } finally {
      if (seq === state.reqSeq) state.loading = false;
      if (btn) btn.disabled = false;
    }
  }

  async function doList() {
    const r = window.JkApi
      ? await JkApi.list(state.t, state.pg)
      : await fetch('/api/juku-list?' + JK.qs({ t: state.t, pg: state.pg })).then(x => x.json());
    if (!r.ok) throw new Error(r.error || '接口错误');
    state.list = r.list || [];
    state.pagecount = r.pagecount || 1;
    state.total = r.total || 0;
    state.pg = r.page || state.pg;
    $('#jkH1').textContent = curNav().name;
    $('#jkSub').innerHTML = subName() + ' · 共 <b>' + state.total.toLocaleString() + '</b> 部 · 第 ' + state.pg + ' / ' + state.pagecount + ' 页' +
      (r.cached ? ' <span style="opacity:.6">· 缓存</span>' : '');
    updateNavCount(state.total);
    renderGrid();
    renderPager();
    loadCovers();
  }

  async function doSearch() {
    const r = window.JkApi
      ? await JkApi.search(state.t, state.kw, 15)
      : await fetch('/api/juku-search?' + JK.qs({ t: state.t, kw: state.kw, pages: 15 })).then(x => x.json());
    if (!r.ok) throw new Error(r.error || '搜索失败');
    state.list = r.list || [];
    state.pagecount = 1;
    state.total = state.list.length;
    $('#jkH1').textContent = '搜索：' + state.kw;
    $('#jkSub').innerHTML = '在「' + subName() + '」前 ' + (r.scanned || 0) + ' 部中匹配到 <b>' + state.list.length + '</b> 部' +
      (state.list.length >= 120 ? '（只显示前 120 条）' : '');
    renderGrid();
    renderPager();
    loadCovers();
  }

  // ---------------------------------------------------- 卡片
  function cardHtml(item) {
    const rec = Store.historyGet(item.id);
    const pct = rec && rec.duration ? Math.min(100, Math.round((rec.time / rec.duration) * 100)) : 0;
    const typeTag = (item.type && item.type !== '短剧大全' && item.type !== '连续剧')
      ? '<span class="jk-src-tag">' + JK.esc(item.type) + '</span>' : '';
    const tag = rec
      ? '<span class="jk-watch-tag">看到 ' + JK.esc(rec.epTitle || ('第 ' + ((rec.epIndex || 0) + 1) + ' 集')) + '</span>'
      : typeTag;
    return '<a class="dj-card" href="detail.html?' + JK.qs({ id: item.id, title: item.title }) + '">' +
      '<div class="poster">' +
        '<img data-cover="' + item.id + '" src="' + JK.fallbackCover(item.title) + '" alt="' + JK.esc(item.title) + '" loading="lazy">' +
        '<div class="play-mask">▶</div>' + tag +
        (item.remarks ? '<span class="ep-tag">' + JK.esc(item.remarks) + '</span>' : '') +
        (pct > 0 ? '<div class="jk-prog-tag"><i style="width:' + pct + '%"></i></div>' : '') +
      '</div>' +
      '<div class="dj-name">' + JK.esc(item.title) + '</div></a>';
  }

  function renderGrid() {
    const grid = $('#jkGrid');
    if (!state.list.length) {
      grid.innerHTML = state.kw
        ? '<div class="dj-empty">没搜到「' + JK.esc(state.kw) + '」，换个词试试（源站关了搜索接口，这里只能扫当前分类的最新 300 部）</div>'
        : '<div class="dj-empty">这个分类暂时没有数据</div>';
      return;
    }
    grid.innerHTML = state.list.map(cardHtml).join('');
  }

  // 批量补封面（每批 20 个，拿到一批就上屏一批）
  async function loadCovers() {
    const ids = state.list.map(x => x.id);
    if (!ids.length) return;
    const seq = state.reqSeq;
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      let map = null;
      try {
        const r = window.JkApi
          ? await JkApi.covers(batch)
          : await fetch('/api/juku-covers?ids=' + batch.join(',')).then(x => x.json());
        if (r.ok) map = r.covers;
      } catch (e) { /* 封面拿不到就用兜底图 */ }
      if (seq !== state.reqSeq) return;
      if (map) applyCovers(map);
    }
  }

  function applyCovers(map) {
    Object.keys(map).forEach(id => {
      const pic = map[id];
      if (!pic) return;
      const img = document.querySelector('[data-cover="' + id + '"]');
      if (img && !img.dataset.done) {
        img.dataset.done = '1';
        img.src = pic;
        img.onerror = () => { img.dataset.done = ''; img.src = JK.fallbackCover(img.alt); };
      }
    });
  }

  // ---------------------------------------------------- 分页
  function renderPager() {
    const box = $('#jkPager');
    if (state.kw) {
      box.innerHTML = '<button class="jk-pg" data-act="clear">← 返回列表</button>' +
        '<span class="jk-pg-info">搜索结果 ' + state.list.length + ' 部</span>';
      return;
    }
    const m = state.pagecount, c = state.pg;
    if (!m || m <= 1) { box.innerHTML = ''; return; }
    const set = [1, m, c - 2, c - 1, c, c + 1, c + 2].filter(p => p >= 1 && p <= m);
    const nums = Array.from(new Set(set)).sort((a, b) => a - b);
    let html = '<button class="jk-pg" data-pg="' + (c - 1) + '"' + (c <= 1 ? ' disabled' : '') + '>‹ 上一页</button>';
    let prev = 0;
    nums.forEach(p => {
      if (p - prev > 1) html += '<span class="jk-pg-info">…</span>';
      html += '<button class="jk-pg' + (p === c ? ' on' : '') + '" data-pg="' + p + '">' + p + '</button>';
      prev = p;
    });
    html += '<button class="jk-pg" data-pg="' + (c + 1) + '"' + (c >= m ? ' disabled' : '') + '>下一页 ›</button>';
    html += '<span class="jk-pg-info">共 ' + m + ' 页</span>';
    html += '<input class="jk-pg-jump" id="jkJump" type="number" min="1" max="' + m + '" placeholder="页码">';
    html += '<button class="jk-pg" data-act="jump">跳转</button>';
    box.innerHTML = html;
  }

  // ---------------------------------------------------- 继续观看
  function renderContinue() {
    const box = $('#jkContinue');
    if (!box) return;
    const all = Store.historyAll().slice(0, 8);
    if (!all.length) {
      box.innerHTML = '<div style="font-size:12px;color:var(--text-3);padding:2px 8px 6px;line-height:1.7">还没有观看记录<br>点开任意一部就开始记</div>';
      return;
    }
    box.innerHTML = all.map(r => {
      const pct = r.duration ? Math.min(100, Math.round((r.time / r.duration) * 100)) : 0;
      const ph = r.cover
        ? '<img src="' + JK.esc(r.cover) + '" alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'">'
        : '<div class="ph">' + JK.esc((r.title || '剧').slice(0, 1)) + '</div>';
      return '<a class="jk-cc" href="detail.html?' + JK.qs({ id: r.id, title: r.title }) + '" title="继续观看">' +
        ph +
        '<div class="jk-cc-b">' +
          '<div class="jk-cc-t">' + JK.esc(r.title || '') + '</div>' +
          '<div class="jk-cc-s">' + JK.esc(r.epTitle || '') + (r.time ? ' · ' + JK.fmtTime(r.time) + (r.duration ? ' / ' + JK.fmtTime(r.duration) : '') : '') + '</div>' +
          '<div class="jk-cc-bar"><i style="width:' + pct + '%"></i></div>' +
        '</div></a>';
    }).join('');
  }

  // ---------------------------------------------------- 设置
  // 弹层实现在 jk-core.js 的 JK.openSettings()，剧库页 / 播放页共用同一份
  function openSettings() { JK.openSettings(); }

  // ---------------------------------------------------- 事件
  function bind() {
    $('#jkNav').addEventListener('click', e => {
      const b = e.target.closest('.jk-nav');
      if (b) setNav(b.dataset.key);
    });

    $('#jkCats').addEventListener('click', e => {
      const b = e.target.closest('.dj-cat');
      if (!b) return;
      state.t = Number(b.dataset.t);
      state.pg = 1;
      renderCats();
      loadPage();
    });

    $('#jkPager').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'clear') {
        state.kw = '';
        $('#jkKw').value = '';
        state.pg = 1;
        loadPage();
        return;
      }
      if (b.dataset.act === 'jump') {
        const inp = $('#jkJump');
        const p = Math.max(1, Math.min(state.pagecount, parseInt(inp.value, 10) || 1));
        state.pg = p;
        loadPage();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const p = parseInt(b.dataset.pg, 10);
      if (!p || p < 1 || p > state.pagecount || p === state.pg) return;
      state.pg = p;
      loadPage();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    $('#jkPager').addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.id === 'jkJump') {
        e.preventDefault();
        const p = Math.max(1, Math.min(state.pagecount, parseInt(e.target.value, 10) || 1));
        state.pg = p;
        loadPage();
      }
    });

    $('#jkSearchForm').addEventListener('submit', e => {
      e.preventDefault();
      const kw = $('#jkKw').value.trim();
      state.kw = kw;
      state.pg = 1;
      if (!kw) { $('#jkH1').textContent = curNav().name; }
      loadPage();
    });

    $('#jkSettingsBtn').addEventListener('click', openSettings);

    document.addEventListener('jk:history', () => {
      renderContinue();
      if (state.list.length) renderGrid();
    });
  }

  // ---------------------------------------------------- 启动
  function init() {
    if (!state.nav.some(n => n.key === state.key)) state.key = 'rec';
    $('#jkH1').textContent = curNav().name;
    renderNav();
    renderCats();
    renderContinue();
    bind();

    loadNav().then(() => {
      if (!state.nav.some(n => n.key === state.key)) state.key = 'rec';
      const n = curNav();
      state.t = n.t;
      renderNav();
      renderCats();
      $('#jkH1').textContent = n.name;
      loadPage();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
