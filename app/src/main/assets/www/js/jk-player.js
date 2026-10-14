/* ============ 剧库 · 自定义播放器 ============
 * 从零实现的播放器（不依赖原生 controls），能力：
 *   - 中央暂停/播放按钮（暂停时显示，点击即播）
 *   - 控制栏：播放/暂停、时间、进度条（含缓冲显示、点击/拖动跳转）、音量、倍速、下一集、画中画、全屏
 *   - 手势：单击画面 播放/暂停 · 双击 全屏 · 上下滑 调音量 · 左右滑 快退/快进 5 秒
 *   - 滚轮调音量；键盘 空格/←→/↑↓/M/F
 *   - 倍速播放保持音调（preservesPitch）
 *   - 直连失败自动回退本机代理（/proxy?url=）
 */
(function () {
  'use strict';

  const JK = window.JK;
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const HLS_CDNS = [
    // 打包在 APK 里的那份，优先用：离线可用、不受 CDN 波动影响
    'lib/hls.min.js',
    'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js',
    'https://unpkg.com/hls.js@1.5.13/dist/hls.min.js'
  ];
  let hlsPromise = null;

  function loadHls() {
    if (window.Hls) return Promise.resolve();
    if (hlsPromise) return hlsPromise;
    hlsPromise = new Promise((resolve, reject) => {
      let i = 0;
      const next = () => {
        if (i >= HLS_CDNS.length) return reject(new Error('hls.js 加载失败'));
        const s = document.createElement('script');
        s.src = HLS_CDNS[i++];
        s.onload = () => (window.Hls ? resolve() : next());
        s.onerror = next;
        document.head.appendChild(s);
      };
      next();
    });
    return hlsPromise;
  }

  const I = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>',
    next: '<path d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z"/>',
    prev: '<path d="M6 6h2v12H6zm3.5 6L18 18V6z"/>',
    vol: '<path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>',
    mute: '<path d="M3 10v4h4l5 4V6L7 10H3zm18.5-.5L20 8l-2.5 2.5L15 8l-1.5 1.5L16 12l-2.5 2.5L15 16l2.5-2.5L20 16l1.5-1.5L19 12z"/>',
    full: '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>',
    exit: '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>',
    pip: '<path d="M19 11h-8v6h8v-6zm4 8V4.98A1.99 1.99 0 0 0 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/>'
  };
  const svg = d => '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';

  const TPL = `
<div class="jkp" data-jkp tabindex="0">
  <video class="jkp-video" data-video playsinline preload="auto" webkit-playsinline></video>
  <div class="jkp-spin" data-loading hidden><span class="jkp-ring"></span><span data-loading-txt>正在解析播放地址…</span></div>
  <div class="jkp-err" data-err hidden>
    <div class="jkp-err-ico">🎬</div>
    <div class="jkp-err-t" data-err-t>无法播放</div>
    <div class="jkp-err-s" data-err-s></div>
    <button class="jkp-btn" data-act="retry">重新加载</button>
  </div>
  <div class="jkp-center" data-center hidden>
    <span class="jkp-center-ico" data-center-ico>${svg(I.play)}</span>
    <span class="jkp-center-tip" data-center-tip>播放</span>
  </div>
  <div class="jkp-hud" data-hud hidden></div>
  <div class="jkp-bar" data-bar>
    <div class="jkp-prog" data-prog>
      <div class="jkp-buf" data-buf></div>
      <div class="jkp-fill" data-fill></div>
      <div class="jkp-dot" data-dot></div>
      <div class="jkp-tip" data-tip hidden></div>
    </div>
    <div class="jkp-ctrl">
      <button class="jkp-ic" data-act="play" data-ico="play" title="播放 / 暂停（空格）">${svg(I.play)}</button>
      <span class="jkp-time"><b data-cur>00:00</b> / <i data-dur>00:00</i></span>
      <div class="jkp-vol" data-volwrap>
        <button class="jkp-ic" data-act="mute" data-ico="vol" title="静音（M）">${svg(I.vol)}</button>
        <div class="jkp-volbar" data-volbar><div class="jkp-volfill" data-volfill></div></div>
      </div>
      <span class="jkp-gap"></span>
      <button class="jkp-txt" data-act="rate" title="倍速播放">1.0x</button>
      <button class="jkp-ic" data-act="next" title="下一集">${svg(I.next)}</button>
      <button class="jkp-ic" data-act="pip" title="画中画">${svg(I.pip)}</button>
      <button class="jkp-ic" data-act="full" data-ico="full" title="全屏（F）">${svg(I.full)}</button>
    </div>
    <ul class="jkp-menu" data-menu hidden></ul>
  </div>
</div>`;

  function JkPlayer(opt) {
    this.opt = Object.assign({
      mount: null,
      autoplay: true,
      startTime: 0,
      onEnded: null,
      onProgress: null,
      onPlayState: null,
      onNext: null,
      hasNext: false
    }, opt || {});
    this.host = typeof this.opt.mount === 'string'
      ? document.querySelector(this.opt.mount)
      : this.opt.mount;
    this.rawUrl = '';
    this.hls = null;
    this.dragging = false;
    this.pendingStart = 0;
    this.hideTimer = null;
    this.hudTimer = null;
    this.lastSave = 0;
    this.destroyed = false;

    const st = window.JKStore.settings();
    this.rate = RATES.indexOf(Number(st.rate)) >= 0 ? Number(st.rate) : 1;
    this.vol = typeof st.volume === 'number' ? st.volume : 0.8;
    this.muted = !!st.muted;

    this.build();
    this.bind();
    this.applyVolume();
    this.applyRate(this.rate, true);
  }

  JkPlayer.prototype.build = function () {
    this.host.innerHTML = TPL;
    const q = s => this.host.querySelector(s);
    this.el = q('[data-jkp]');
    this.video = q('[data-video]');
    this.$ = {
      loading: q('[data-loading]'), loadingTxt: q('[data-loading-txt]'),
      err: q('[data-err]'), errT: q('[data-err-t]'), errS: q('[data-err-s]'),
      center: q('[data-center]'), centerIco: q('[data-center-ico]'), centerTip: q('[data-center-tip]'),
      hud: q('[data-hud]'), bar: q('[data-bar]'),
      prog: q('[data-prog]'), buf: q('[data-buf]'), fill: q('[data-fill]'), dot: q('[data-dot]'), tip: q('[data-tip]'),
      cur: q('[data-cur]'), dur: q('[data-dur]'),
      volwrap: q('[data-volwrap]'), volbar: q('[data-volbar]'), volfill: q('[data-volfill]'),
      menu: q('[data-menu]'),
      btnPlay: q('[data-act="play"]'), btnMute: q('[data-act="mute"]'),
      btnRate: q('[data-act="rate"]'), btnNext: q('[data-act="next"]'),
      btnPip: q('[data-act="pip"]'), btnFull: q('[data-act="full"]')
    };
    this.$btnIco = { play: q('[data-ico="play"]'), vol: q('[data-ico="vol"]'), full: q('[data-ico="full"]') };
    this.$btnNext = this.$.btnNext;
    this.renderRateMenu();
  };

  // ------------------------------------------------ 事件绑定
  JkPlayer.prototype.bind = function () {
    const v = this.video, self = this;

    // ---- video 事件
    v.addEventListener('loadedmetadata', () => {
      this.syncAspect();
      this.$.dur.textContent = JK.fmtTime(v.duration);
      if (this.pendingStart > 0.5 && isFinite(v.duration)) {
        try { v.currentTime = Math.min(this.pendingStart, Math.max(0, v.duration - 2)); } catch (e) {}
      }
      this.pendingStart = 0;
    });
    v.addEventListener('durationchange', () => { this.$.dur.textContent = JK.fmtTime(v.duration); });
    v.addEventListener('timeupdate', () => { this.tick(); this.maybeSave(); });
    v.addEventListener('progress', () => this.tickBuffer());
    v.addEventListener('play', () => { this.setPlaying(true); this.autoHide(); });
    v.addEventListener('pause', () => { this.setPlaying(false); this.showBar(); });
    v.addEventListener('waiting', () => this.$.loading && this.showLoading('缓冲中…'));
    v.addEventListener('canplay', () => this.hideLoading());
    v.addEventListener('playing', () => { this.hideLoading(); });
    v.addEventListener('volumechange', () => this.syncVolumeIcon());
    v.addEventListener('ended', () => {
      this.setPlaying(false);
      this.showCenter();
      if (typeof this.opt.onEnded === 'function') this.opt.onEnded();
    });

    // ---- 控制栏按钮
    this.$.bar.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      e.stopPropagation();
      const act = b.getAttribute('data-act');
      if (act === 'play') this.toggle();
      else if (act === 'mute') this.toggleMute();
      else if (act === 'rate') this.toggleRateMenu();
      else if (act === 'next') { if (typeof this.opt.onNext === 'function') this.opt.onNext(); }
      else if (act === 'pip') this.togglePip();
      else if (act === 'full') this.toggleFullscreen();
      else if (act === 'retry') { if (typeof this.opt.onRetry === 'function') this.opt.onRetry(); }
    });

    // ---- 进度条
    const ratio = e => {
      const r = this.$.prog.getBoundingClientRect();
      return JK.clamp((e.clientX - r.left) / r.width, 0, 1);
    };
    this.$.prog.addEventListener('pointerdown', e => {
      if (!isFinite(v.duration) || v.duration <= 0) return;
      this.dragging = true;
      this.$.prog.classList.add('drag');
      try { this.$.prog.setPointerCapture(e.pointerId); } catch (er) {}
      this.previewSeek(ratio(e));
      e.stopPropagation();
    });
    this.$.prog.addEventListener('pointermove', e => {
      if (this.dragging) { this.previewSeek(ratio(e)); return; }
      const r = ratio(e);
      if (isFinite(v.duration) && v.duration > 0) {
        this.$.tip.hidden = false;
        this.$.tip.textContent = JK.fmtTime(r * v.duration);
        this.$.tip.style.left = (r * 100) + '%';
      }
    });
    this.$.prog.addEventListener('pointerup', e => {
      if (!this.dragging) return;
      this.dragging = false;
      this.$.prog.classList.remove('drag');
      this.doSeek(ratio(e) * v.duration);
      this.lastStep = null;
      this.$.tip.hidden = true;
      this.autoHide();
    });
    this.$.prog.addEventListener('pointerleave', () => { this.$.tip.hidden = true; });

    // ---- 音量条
    const vratio = e => {
      const r = this.$.volbar.getBoundingClientRect();
      return JK.clamp((e.clientX - r.left) / r.width, 0, 1);
    };
    this.$.volbar.addEventListener('pointerdown', e => {
      this.volDragging = true;
      try { this.$.volbar.setPointerCapture(e.pointerId); } catch (er) {}
      this.setVolume(vratio(e));
      e.stopPropagation();
    });
    this.$.volbar.addEventListener('pointermove', e => { if (this.volDragging) this.setVolume(vratio(e)); });
    this.$.volbar.addEventListener('pointerup', () => { this.volDragging = false; });

    // ---- 滚轮调音量
    this.el.addEventListener('wheel', e => {
      if (e.target.closest('.jkp-menu')) return;
      e.preventDefault();
      this.setVolume(this.video.muted ? 0 : this.video.volume, e.deltaY < 0 ? 0.05 : -0.05);
    }, { passive: false });

    // ---- 鼠标移动显示控制栏
    this.el.addEventListener('mousemove', () => { this.showBar(); this.autoHide(); });
    this.el.addEventListener('mouseleave', () => { if (!this.video.paused) this.hideBar(); });

    // ---- 手势 / 单击 / 双击
    this.bindGestures();

    // 中央大按钮（暂停时的那颗播放键）
    this.$.center.addEventListener('click', e => {
      e.stopPropagation();
      this.toggle();
    });

    // ---- 全屏状态
    document.addEventListener('fullscreenchange', () => this.syncFullIcon());
    document.addEventListener('webkitfullscreenchange', () => this.syncFullIcon());

    // ---- 键盘
    this.onKey = e => {
      if (this.destroyed || !this.el.isConnected) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      const k = e.key;
      if (k === ' ' || k === 'Spacebar') { e.preventDefault(); this.toggle(); }
      else if (k === 'ArrowLeft') { e.preventDefault(); this.nudge(-5); }
      else if (k === 'ArrowRight') { e.preventDefault(); this.nudge(5); }
      else if (k === 'ArrowUp') { e.preventDefault(); this.setVolume(this.video.volume, 0.05); }
      else if (k === 'ArrowDown') { e.preventDefault(); this.setVolume(this.video.volume, -0.05); }
      else if (k === 'm' || k === 'M') { this.toggleMute(); }
      else if (k === 'f' || k === 'F') { this.toggleFullscreen(); }
    };
    document.addEventListener('keydown', this.onKey);
  };

  JkPlayer.prototype.bindGestures = function () {
    const v = this.video, self = this;
    let p0 = null, moved = false, mode = null, lastTap = 0, tapTimer = null;

    this.el.addEventListener('pointerdown', e => {
      if (e.target.closest('.jkp-bar') || e.target.closest('.jkp-err') || e.target.closest('.jkp-center')) return;
      p0 = { x: e.clientX, y: e.clientY, vol: v.muted ? 0 : v.volume, time: v.currentTime };
      moved = false; mode = null;
      try { this.el.setPointerCapture(e.pointerId); } catch (er) {}
    });

    this.el.addEventListener('pointermove', e => {
      if (!p0) return;
      const dx = e.clientX - p0.x, dy = e.clientY - p0.y;
      if (!mode) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        mode = Math.abs(dx) > Math.abs(dy) ? 'seek' : 'volume';
        moved = true;
      }
      if (mode === 'volume') {
        const nv = JK.clamp(p0.vol - dy / 220, 0, 1);
        this.setVolume(nv, undefined, true);
        this.hud((nv <= 0.001 ? '🔇 ' : '🔊 ') + '音量 ' + Math.round(nv * 100) + '%');
      } else {
        if (!isFinite(v.duration) || v.duration <= 0) return;
        const steps = Math.trunc(dx / 56);           // 每滑 56px 记一档（=5 秒）
        const target = JK.clamp(p0.time + steps * 5, 0, v.duration);
        this.lastStep = target;
        this.hud((steps >= 0 ? '⏩ 快进 ' : '⏪ 快退 ') + (steps >= 0 ? '+' : '') + (steps * 5) + '秒  ·  ' + JK.fmtTime(target));
      }
    });

    const finish = e => {
      if (!p0) return;
      if (mode === 'seek' && typeof this.lastStep === 'number') this.doSeek(this.lastStep);
      this.lastStep = null;
      const wasTap = !moved;
      p0 = null;

      if (!wasTap) { this.hideHud(); return; }
      const now = Date.now();
      if (now - lastTap < 280) {
        clearTimeout(tapTimer);
        lastTap = 0;
        this.toggleFullscreen();
      } else {
        lastTap = now;
        tapTimer = setTimeout(() => {
          // 单击画面 = 播放/暂停
          this.toggle();
        }, 200);
      }
    };
    this.el.addEventListener('pointerup', finish);
    this.el.addEventListener('pointercancel', () => { p0 = null; mode = null; this.hideHud(); });
  };

  // ------------------------------------------------ 视图状态
  JkPlayer.prototype.setPlaying = function (playing) {
    const ico = playing ? I.pause : I.play;
    this.$.btnPlay.innerHTML = svg(ico);
    this.$.centerIco.innerHTML = svg(ico);
    this.$.centerTip.textContent = playing ? '暂停' : '播放';
    if (playing) this.$.center.hidden = true; else this.showCenter();
    if (typeof this.opt.onPlayState === 'function') this.opt.onPlayState(playing);
  };

  JkPlayer.prototype.showCenter = function () { if (!this.$) return; this.$.center.hidden = false; };
  JkPlayer.prototype.showBar = function () {
    if (!this.$) return;
    this.el.classList.remove('hidebar');
  };
  JkPlayer.prototype.hideBar = function () { if (this.$) this.el.classList.add('hidebar'); };
  JkPlayer.prototype.autoHide = function () {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.video.paused && !this.dragging && !this.volDragging) this.hideBar();
    }, 3200);
  };

  JkPlayer.prototype.hud = function (text) {
    if (!this.$) return;
    this.$.hud.hidden = false;
    this.$.hud.textContent = text;
    clearTimeout(this.hudTimer);
    this.hudTimer = setTimeout(() => this.hideHud(), 900);
  };
  JkPlayer.prototype.hideHud = function () { if (this.$) this.$.hud.hidden = true; };

  JkPlayer.prototype.showLoading = function (txt) {
    if (!this.$) return;
    if (txt) this.$.loadingTxt.textContent = txt;
    this.$.loading.hidden = false;
    this.$.err.hidden = true;
  };
  JkPlayer.prototype.hideLoading = function () { if (this.$) this.$.loading.hidden = true; };

  JkPlayer.prototype.showError = function (t, s) {
    if (!this.$) return;
    this.hideLoading();
    this.$.errT.textContent = t || '无法播放';
    this.$.errS.textContent = s || '';
    this.$.err.hidden = false;
    this.$.center.hidden = true;
  };

  // ------------------------------------------------ 播放控制
  JkPlayer.prototype.load = function (url, o) {
    o = o || {};
    if (!this.video) return;
    this.rawUrl = url;
    this.pendingStart = Number(o.startTime || this.opt.startTime || 0) || 0;
    this.opt.autoplay = o.autoplay === undefined ? true : !!o.autoplay;
    this.showLoading('正在解析播放地址…');
    this.loadSource(url, true);
  };

  JkPlayer.prototype.reload = function () {
    if (this.rawUrl) this.load(this.rawUrl, { startTime: this.video.currentTime });
  };

  JkPlayer.prototype.loadSource = function (url, useProxy) {
    const self = this;
    // 默认经 /proxy：
    //   - 在 APK 里由原生拦截层接管，页面与接口同源，CORS 根本碰不到；
    //   - 在桌面/预览里由 server.js 的 handleProxy 接管；
    //   - Referer 也由代理统一补（源站防盗链只看这一项）。
    // 直连留作最后兜底：代理整条挂掉时还有一线机会。
    const viaProxy = useProxy !== false;
    const src = viaProxy ? ('/proxy?url=' + encodeURIComponent(url)) : url;
    this.teardown();
    const v = this.video;
    const start = this.pendingStart || 0;
    this.pendingStart = 0;

    loadHls().then(() => {
      if (window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls({
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 30,        // 目标缓冲 30 秒，起播更快
          maxMaxBufferLength: 60,     // 上限 60 秒，避免一口气拉太多分片
          backBufferLength: 30,
          startFragPrefetch: true,
          abrEwmaDefaultEstimate: 800000,
          fragLoadingTimeOut: 20000,
          manifestLoadingTimeOut: 15000
        });
        self.hls = hls;
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          self.hideLoading();
          if (start > 0.5) { try { v.currentTime = start; } catch (e) {} }
          v.playbackRate = self.rate;
          if (self.opt.autoplay) v.play().catch(() => self.showCenter());
          self.syncFullIcon();
        });
        hls.on(window.Hls.Events.ERROR, (evt, data) => {
          if (!data.fatal) return;
          if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError(); } catch (e) {} return; }
          if (viaProxy) { self.loadSource(url, false); }
          else { self.showError('播放失败', '播放源可能已失效，试试下一集'); }
        });
        hls.loadSource(src);
        hls.attachMedia(v);
      } else {
        v.src = src;
        v.onloadedmetadata = () => {
          self.hideLoading();
          if (start > 0.5) { try { v.currentTime = start; } catch (e) {} }
          v.playbackRate = self.rate;
          if (self.opt.autoplay) v.play().catch(() => self.showCenter());
        };
        v.onerror = () => {
          if (viaProxy) self.loadSource(url, false);
          else self.showError('播放失败', '播放源可能已失效，试试下一集');
        };
      }
    }).catch(() => this.showError('播放组件加载失败', '请检查网络后重试'));
  };

  JkPlayer.prototype.teardown = function () {
    const v = this.video;
    if (!v) return;
    try { v.pause(); } catch (e) {}
    if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
    v.removeAttribute('src');
    try { v.load(); } catch (e) {}
  };

  JkPlayer.prototype.toggle = function () {
    const v = this.video;
    if (this.$.err && !this.$.err.hidden) {
      if (typeof this.opt.onRetry === 'function') this.opt.onRetry();
      return;
    }
    if (v.paused) v.play().catch(() => this.showCenter());
    else v.pause();
  };

  JkPlayer.prototype.doSeek = function (t) {
    const v = this.video;
    if (!isFinite(v.duration) || v.duration <= 0) return;
    v.currentTime = JK.clamp(t, 0, v.duration);
    this.tick();
    this.maybeSave(true);
  };

  JkPlayer.prototype.previewSeek = function (ratio) {
    const v = this.video;
    if (!isFinite(v.duration) || v.duration <= 0) return;
    const t = ratio * v.duration;
    this.$.fill.style.width = (ratio * 100) + '%';
    this.$.dot.style.left = (ratio * 100) + '%';
    this.$.cur.textContent = JK.fmtTime(t);
    this.$.tip.hidden = false;
    this.$.tip.textContent = JK.fmtTime(t);
    this.$.tip.style.left = (ratio * 100) + '%';
    this.lastStep = t;
  };

  JkPlayer.prototype.nudge = function (sec) {
    const v = this.video;
    this.doSeek(v.currentTime + sec);
    this.hud((sec > 0 ? '⏩ +' : '⏪ ') + sec + '秒');
  };

  JkPlayer.prototype.setVolume = function (v, delta, quiet) {
    const video = this.video;
    let nv;
    if (typeof delta === 'number' && v === undefined) nv = video.volume + delta;   // 相对
    else if (typeof v === 'number') nv = v;                                        // 绝对
    else nv = video.volume;
    nv = JK.clamp(nv, 0, 1);
    video.volume = nv;
    video.muted = nv <= 0.001;
    this.vol = nv;
    this.syncVolumeIcon();
    if (!quiet) window.JKStore.setSettings({ volume: nv, muted: video.muted });
  };

  JkPlayer.prototype.toggleMute = function () {
    const video = this.video;
    video.muted = !video.muted;
    if (!video.muted && video.volume <= 0.01) video.volume = 0.5;
    this.syncVolumeIcon();
    this.hud(video.muted ? '🔇 已静音' : '🔊 音量 ' + Math.round(video.volume * 100) + '%');
    window.JKStore.setSettings({ volume: video.volume, muted: video.muted });
  };

  JkPlayer.prototype.applyVolume = function () {
    const video = this.video;
    video.volume = JK.clamp(this.vol, 0, 1);
    video.muted = this.muted;
    this.syncVolumeIcon();
  };

  JkPlayer.prototype.syncVolumeIcon = function () {
    if (!this.$) return;
    const video = this.video;
    const eff = video.muted ? 0 : video.volume;
    this.$.volfill.style.width = (eff * 100) + '%';
    this.$.btnMute.innerHTML = svg(eff <= 0.01 ? I.mute : I.vol);
  };

  JkPlayer.prototype.applyRate = function (r, silent) {
    this.rate = r;
    const v = this.video;
    v.playbackRate = r;
    // 保持音调（不同浏览器写法不同）
    try { v.preservesPitch = true; } catch (e) {}
    try { v.webkitPreservesPitch = true; } catch (e) {}
    try { v.mozPreservesPitch = true; } catch (e) {}
    if (this.$.btnRate) this.$.btnRate.textContent = (r === 1 ? '倍速' : r + 'x');
    if (this.$.menu) {
      Array.prototype.forEach.call(this.$.menu.children, li => {
        li.classList.toggle('on', Number(li.dataset.r) === r);
      });
    }
    if (!silent) {
      window.JKStore.setSettings({ rate: r });
      this.hud('倍速 ' + r + 'x');
    }
  };

  JkPlayer.prototype.renderRateMenu = function () {
    const self = this;
    this.$.menu.innerHTML = RATES.map(r =>
      '<li data-r="' + r + '"><span>' + (r === 1 ? '正常 (1.0x)' : r + 'x') + '</span><i>' + (r === 1 ? '' : '保持音调') + '</i></li>'
    ).join('');
    this.$.menu.addEventListener('click', e => {
      const li = e.target.closest('li[data-r]');
      if (!li) return;
      e.stopPropagation();
      self.applyRate(Number(li.dataset.r));
      self.$.menu.hidden = true;
    });
    document.addEventListener('click', () => { if (self.$.menu) self.$.menu.hidden = true; });
  };

  JkPlayer.prototype.toggleRateMenu = function () { this.$.menu.hidden = !this.$.menu.hidden; };

  JkPlayer.prototype.togglePip = function () {
    const v = this.video;
    try {
      if (document.pictureInPictureElement) document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled) v.requestPictureInPicture();
      else JK.toast('当前环境不支持画中画');
    } catch (e) { JK.toast('画中画不可用'); }
  };

  JkPlayer.prototype.toggleFullscreen = function () {
    const el = this.el;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const fn = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fn) fn.call(el).catch(() => {});
    }
  };

  JkPlayer.prototype.syncFullIcon = function () {
    if (!this.$.btnFull) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    this.$.btnFull.innerHTML = svg(fs ? I.exit : I.full);
  };

  // 竖屏短剧：把播放框改成竖的，别让画面缩在 16:9 中间一条黑边里
  JkPlayer.prototype.syncAspect = function () {
    const v = this.video;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    this.el.classList.toggle('portrait', v.videoHeight > v.videoWidth * 1.05);
  };

  // ------------------------------------------------ 进度刷新
  JkPlayer.prototype.tick = function () {
    const v = this.video;
    if (!this.$ || this.destroyed) return;
    const d = isFinite(v.duration) ? v.duration : 0;
    const r = d > 0 ? v.currentTime / d : 0;
    if (!this.dragging) {
      this.$.fill.style.width = (r * 100) + '%';
      this.$.dot.style.left = (r * 100) + '%';
      this.$.cur.textContent = JK.fmtTime(v.currentTime);
    }
    this.$.dur.textContent = d > 0 ? JK.fmtTime(d) : '00:00';
    this.tickBuffer();
  };

  JkPlayer.prototype.tickBuffer = function () {
    const v = this.video;
    if (!this.$ || !v.buffered || !v.buffered.length) return;
    const d = isFinite(v.duration) ? v.duration : 0;
    if (d <= 0) return;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
    }
    this.$.buf.style.width = JK.clamp(end / d, 0, 1) * 100 + '%';
  };

  JkPlayer.prototype.maybeSave = function (force) {
    const now = Date.now();
    if (!force && now - this.lastSave < 2000) return;
    this.lastSave = now;
    const v = this.video;
    if (typeof this.opt.onProgress === 'function') {
      this.opt.onProgress(v.currentTime, isFinite(v.duration) ? v.duration : 0);
    }
  };

  JkPlayer.prototype.setHasNext = function (has) {
    this.opt.hasNext = !!has;
    if (this.$btnNext) this.$btnNext.style.display = has ? '' : 'none';
  };

  JkPlayer.prototype.destroy = function () {
    this.destroyed = true;
    clearTimeout(this.hideTimer);
    document.removeEventListener('keydown', this.onKey);
    this.teardown();
    if (this.host) this.host.innerHTML = '';
  };

  window.JkPlayer = JkPlayer;
  window.JkPlayer.loadHls = loadHls;
})();
