/* ============ 剧库 · 播放页（选集 / 自动连播 / 续播） ============ */
(function () {
  'use strict';

  const JK = window.JK, Store = window.JKStore;
  const $ = s => document.querySelector(s);

  const params = new URLSearchParams(location.search);
  const vid = (params.get('id') || '').trim();
  const titleHint = decodeURIComponent(params.get('title') || '');

  let detail = null;
  let eps = [];
  let cur = 0;
  let player = null;

  // ------------------------------------------------------------ 初始化
  async function init() {
    bindButtons();
    syncAutoNext();
    $('#rateNow').textContent = fmtRate(Store.settings().rate);
    $('#wTitle').textContent = titleHint || '加载中…';
    document.title = (titleHint || '剧库') + ' · 播放';

    if (!vid) { fail('缺少剧集 ID', '请从剧库列表点进来'); return; }

    try {
      const r = window.JkApi
        ? await JkApi.detail(vid)
        : await fetch('/api/juku-detail?' + JK.qs({ id: vid })).then(x => x.json());
      if (!r.ok) throw new Error(r.error || '详情获取失败');
      detail = r;
      eps = r.episodes || [];
      renderDetail();
      if (!eps.length) {
        fail('这部暂时没有可播放的地址', '源站可能还没更新完整，先去剧库换一部');
        return;
      }
      const s = pickStart();
      play(s.ep, { startTime: s.time, autoplay: true });
    } catch (e) {
      fail('加载失败', e.message || '请检查本机服务是否在运行');
    }
  }

  // 决定从哪一集、哪个时间点开始
  function pickStart() {
    const rec = Store.historyGet(vid);
    const resume = Store.settings().resume;
    if (!rec) return { ep: 0, time: 0 };
    let ep = Math.max(0, Math.min(rec.epIndex || 0, eps.length - 1));
    let time = resume ? (rec.time || 0) : 0;
    // 上集已经看完了 → 直接进下一集开头
    const finished = rec.duration > 0 && (rec.time || 0) >= rec.duration - 3;
    if (finished && ep < eps.length - 1) { ep += 1; time = 0; }
    return { ep, time };
  }

  // ------------------------------------------------------------ 播放
  function play(idx, o) {
    o = o || {};
    idx = Math.max(0, Math.min(eps.length - 1, idx));
    if (!eps.length) return;
    if (player && eps[cur]) save(true);      // 切集前先落一次进度
    cur = idx;

    const ep = eps[cur];
    const name = detail ? detail.title : titleHint;
    $('#wTitle').textContent = name || '播放';
    $('#wMeta').textContent = '第 ' + (cur + 1) + ' / ' + eps.length + ' 集 · ' + ep.title;
    document.title = (name || '剧库') + ' · ' + ep.title;
    history.replaceState(null, '', location.pathname + '?' + JK.qs({ id: vid, title: name, ep: cur + 1 }));

    renderEps();

    if (!player) {
      player = new window.JkPlayer({
        mount: '#playerMount',
        autoplay: o.autoplay !== false,
        onEnded: onEnded,
        onProgress: (t, d) => save(false, t, d),
        onNext: next,
        onRetry: () => play(cur, { autoplay: true })
      });
    }
    player.setHasNext(cur < eps.length - 1);
    player.load(ep.url, { startTime: o.startTime || 0, autoplay: o.autoplay !== false });
  }

  function next() {
    if (cur < eps.length - 1) play(cur + 1, { autoplay: true });
    else JK.toast('已经是最后一集了');
  }

  function onEnded() {
    save(true);
    if (cur < eps.length - 1) {
      if (Store.settings().autoNext) {
        JK.toast('自动播放下一集…');
        setTimeout(() => play(cur + 1, { autoplay: true }), 700);
      } else {
        JK.toast('本集播完，「自动连播」已关闭');
      }
    } else {
      JK.toast('已经是最后一集了');
    }
  }

  // ------------------------------------------------------------ 进度存档
  function save(force, t, d) {
    if (!detail || !player || !player.video) return;
    const v = player.video;
    const tt = typeof t === 'number' ? t : v.currentTime;
    const dd = typeof d === 'number' ? d : (isFinite(v.duration) ? v.duration : 0);
    if (!force && !tt) return;
    if (!rawEps(cur)) return;
    Store.historySave({
      id: vid,
      title: detail.title,
      cover: detail.pic,
      type: detail.type || '',
      epIndex: cur,
      epTitle: rawEps(cur).title,
      epCount: eps.length,
      time: tt || 0,
      duration: dd || 0
    });
  }
  const rawEps = i => eps[i] || null;

  // ------------------------------------------------------------ 渲染
  function renderDetail() {
    $('#wTitle').textContent = detail.title || titleHint;
    const cover = detail.pic || JK.fallbackCover(detail.title);
    const img = $('#wCover');
    img.src = cover;
    img.onerror = () => { img.src = JK.fallbackCover(detail.title); img.onerror = null; };

    const tags = [detail.type, detail.year, detail.area, detail.remarks].filter(Boolean);
    $('#wTags').innerHTML = tags.map(t => '<span>' + JK.esc(t) + '</span>').join('');

    const info = [];
    if (detail.actor) info.push('主演：' + detail.actor);
    if (detail.director) info.push('导演：' + detail.director);
    if (detail.episodes && detail.episodes.length) info.push('共 ' + detail.episodes.length + ' 集');
    $('#wInfo').innerHTML = info.map(x => JK.esc(x)).join('<br>');

    $('#wIntro').textContent = detail.intro || '暂无简介';
  }

  function epLabel(title, i) {
    const s = String(title || '');
    const m = s.match(/第?\s*(\d+)\s*集?/);
    if (m) return m[1];
    if (/全集/.test(s)) return '全集';
    if (/正片|完整/.test(s)) return '正片';
    if (/预告/.test(s)) return '预告';
    return String(i + 1);
  }

  function renderEps() {
    $('#epCount').textContent = eps.length ? '共 ' + eps.length + ' 集' : '';
    $('#wEps').innerHTML = eps.map((e, i) =>
      '<button class="jk-ep' + (i === cur ? ' on' : '') + (i < cur ? ' played' : '') + '" data-i="' + i + '" title="' + JK.esc(e.title) + '">' +
      JK.esc(epLabel(e.title, i)) + '</button>'
    ).join('');
  }

  function syncAutoNext() {
    const on = Store.settings().autoNext;
    const b = $('#btnAutoNext');
    if (!b) return;
    b.classList.toggle('on', on);
    $('#autoNextIco').textContent = on ? '🔁' : '⏸';
    $('#autoNextTxt').textContent = on ? '自动连播 开' : '自动连播 关';
  }

  function fmtRate(r) {
    r = Number(r) || 1;
    return (Math.round(r * 100) / 100) + 'x';
  }

  function fail(t, s) {
    $('#playerMount').innerHTML =
      '<div class="jkp" style="aspect-ratio:16/9"><div class="jkp-err">' +
      '<div class="jkp-err-ico">🎬</div>' +
      '<div class="jkp-err-t">' + JK.esc(t) + '</div>' +
      '<div class="jkp-err-s">' + JK.esc(s || '') + '</div>' +
      '<a class="jkp-btn" href="index.html" style="text-decoration:none">← 回剧库换一部</a>' +
      '</div></div>';
    $('#wMeta').textContent = '';
    $('#wEps').innerHTML = '<div style="font-size:12.5px;color:var(--text-3);padding:6px 2px">没有可播放的集</div>';
    $('#wIntro').textContent = s || '';
  }

  // ------------------------------------------------------------ 事件
  function bindButtons() {
    $('#wEps').addEventListener('click', e => {
      const b = e.target.closest('.jk-ep');
      if (!b) return;
      const i = parseInt(b.dataset.i, 10);
      if (i === cur) { if (player) player.toggle(); return; }
      play(i, { autoplay: true });
    });

    $('#btnAutoNext').addEventListener('click', () => {
      const next2 = !Store.settings().autoNext;
      Store.setSettings({ autoNext: next2 });
      syncAutoNext();
      JK.toast(next2 ? '已开启自动连播' : '已关闭自动连播');
    });

    $('#btnResume').addEventListener('click', () => {
      const rec = Store.historyGet(vid);
      if (!rec || !rec.time) { JK.toast('还没有观看记录'); return; }
      if (!player) { play(rec.epIndex || 0, { startTime: rec.time, autoplay: true }); return; }
      if ((rec.epIndex || 0) !== cur) { play(rec.epIndex || 0, { startTime: rec.time, autoplay: true }); return; }
      player.doSeek(rec.time);
      JK.toast('已跳到上次位置 ' + JK.fmtTime(rec.time));
    });

    const RATES = [1, 1.25, 1.5, 2, 0.75, 0.5];
    $('#btnRate').addEventListener('click', () => {
      if (!player) return;
      const i = RATES.indexOf(Number(Store.settings().rate));
      const r = RATES[(i + 1) % RATES.length];
      player.applyRate(r);
      $('#rateNow').textContent = fmtRate(r);
    });

    $('#btnFull').addEventListener('click', () => { if (player) player.toggleFullscreen(); });
    $('#btnReload').addEventListener('click', () => { if (player) player.reload(); });
    $('#btnSetting').addEventListener('click', () => JK.openSettings());

    document.addEventListener('jk:settings', e => {
      syncAutoNext();
      $('#rateNow').textContent = fmtRate(e.detail.rate);
    });

    window.addEventListener('beforeunload', () => save(true));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
