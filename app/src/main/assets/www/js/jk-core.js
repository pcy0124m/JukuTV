/* ============ 剧库 · 公共层（工具 + 本地存储） ============ */
(function () {
  'use strict';

  // ------------------------------------------------ 工具
  const JK = {};

  JK.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  JK.fmtTime = function (sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = n => (n < 10 ? '0' + n : '' + n);
    return h ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  };

  JK.qs = function (obj) {
    return Object.keys(obj)
      .filter(k => obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
      .map(k => k + '=' + encodeURIComponent(obj[k]))
      .join('&');
  };

  JK.clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };

  JK.debounce = function (fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  };

  JK.toast = function (msg, ms) {
    let el = document.getElementById('jkToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'jkToast';
      el.className = 'jk-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
  };

  // 封面兜底图：渐变 + 剧名首字
  JK.fallbackCover = function (title) {
    const t = (title || '剧').slice(0, 1);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#3b2b6b"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>' +
      '<rect width="300" height="400" fill="url(#g)"/>' +
      '<text x="150" y="215" text-anchor="middle" font-size="120" font-family="sans-serif" font-weight="700" fill="rgba(255,255,255,.92)">' + t + '</text>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  };

  window.JK = JK;

  // ------------------------------------------------ 存储
  const HKEY = 'jk_history_v1';
  const SKEY = 'jk_settings_v1';
  const MAX_HISTORY = 80;

  const DEFAULT_SETTINGS = {
    autoNext: true,      // 自动连播下一集
    resume: true,        // 从上次观看位置继续
    saveHistory: true,   // 记录观看进度
    rate: 1,             // 上次使用的倍速
    volume: 0.8,
    muted: false,
    cat: 'rec'           // 上次停留的分类
  };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return (v === null || v === undefined) ? fallback : v;
    } catch (e) { return fallback; }
  }

  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  function settings() { return Object.assign({}, DEFAULT_SETTINGS, read(SKEY, {})); }
  function setSettings(patch) {
    const next = Object.assign(settings(), patch);
    write(SKEY, next);
    document.dispatchEvent(new CustomEvent('jk:settings', { detail: next }));
    return next;
  }

  function historyAll() {
    const h = read(HKEY, {});
    return Object.keys(h).map(k => h[k])
      .filter(x => x && x.id)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function historyGet(id) { return read(HKEY, {})[String(id)] || null; }

  function historySave(rec) {
    if (!rec || !rec.id) return;
    if (!settings().saveHistory) return;
    const h = read(HKEY, {});
    h[rec.id] = Object.assign({}, h[rec.id] || {}, rec, { updatedAt: Date.now() });
    const all = Object.keys(h).map(k => h[k]);
    if (all.length > MAX_HISTORY) {
      all.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
        .slice(0, all.length - MAX_HISTORY)
        .forEach(x => { delete h[x.id]; });
    }
    write(HKEY, h);
    document.dispatchEvent(new CustomEvent('jk:history'));
  }

  function historyRemove(id) {
    const h = read(HKEY, {});
    delete h[String(id)];
    write(HKEY, h);
    document.dispatchEvent(new CustomEvent('jk:history'));
  }

  function historyClear() {
    write(HKEY, {});
    document.dispatchEvent(new CustomEvent('jk:history'));
  }

  window.JKStore = {
    settings, setSettings, DEFAULT_SETTINGS,
    historyAll, historyGet, historySave, historyRemove, historyClear
  };

  // ------------------------------------------------ 播放设置弹层（剧库页 / 播放页共用）
  JK.openSettings = function () {
    const s = settings();
    const mask = document.createElement('div');
    mask.className = 'jk-mask';

    function row(k, t, d) {
      return '<div class="jk-row"><div><div class="jk-row-t">' + t + '</div><div class="jk-row-d">' + d + '</div></div>' +
        '<button class="jk-sw' + (s[k] ? ' on' : '') + '" data-k="' + k + '" aria-label="' + t + '"></button></div>';
    }

    mask.innerHTML =
      '<div class="jk-modal">' +
      '<h3>播放设置</h3>' +
      '<div class="desc">改完立即生效，播放页也会跟着走</div>' +
      row('autoNext', '自动连播下一集', '一集播完自动接下一集') +
      row('resume', '记住播放位置', '下次打开从上次的位置继续播') +
      row('saveHistory', '记录观看历史', '关闭后不再写入「继续观看」') +
      '<div class="jk-row"><div><div class="jk-row-t">手势 / 快捷键</div>' +
      '<div class="jk-kbd">' +
      '<b>空格</b>播放 / 暂停<br>' +
      '<b>← →</b>快退 / 快进 5 秒<br>' +
      '<b>↑ ↓</b>音量加减<br>' +
      '<b>F / M</b>全屏 / 静音<br>' +
      '<b>上下滑</b>调音量<br>' +
      '<b>左右滑</b>快退 / 快进 5 秒<br>' +
      '<b>双击</b>全屏 · <b>滚轮</b>调音量' +
      '</div></div></div>' +
      '<div class="jk-modal-foot">' +
      '<button class="jk-abtn danger" data-act="clear">清空观看记录</button>' +
      '<button class="jk-abtn primary" data-act="close">知道了</button>' +
      '</div></div>';

    document.body.appendChild(mask);
    mask.addEventListener('click', ev => {
      const sw = ev.target.closest('.jk-sw');
      if (sw) {
        const k = sw.dataset.k;
        const next = !settings()[k];
        setSettings({ [k]: next });
        sw.classList.toggle('on', next);
        JK.toast((next ? '已开启' : '已关闭') + '：' + sw.getAttribute('aria-label'));
        return;
      }
      if (ev.target.closest('[data-act="close"]')) { mask.remove(); return; }
      if (ev.target.closest('[data-act="clear"]')) {
        if (confirm('确定清空全部观看记录吗？此操作不可撤销。')) {
          historyClear();
          JK.toast('已清空观看记录');
        }
        return;
      }
      if (ev.target === mask) mask.remove();
    });
  };
})();
