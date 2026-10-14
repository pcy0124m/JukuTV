/**
 * 剧库数据层 · 浏览器版
 *
 * 桌面版这份逻辑跑在 Node 里（lib/juku.js），用 http/https 直连源站。
 * 搬到手机后没法起 Node，所以整份改写为 fetch；跨域和防盗链交给壳的拦截层处理，
 * 这里只需要把所有上游地址包成 /proxy?url=... —— 页面和 /proxy 同源，
 * 浏览器那套 CORS 规则根本不参与。
 *
 * 缓存策略：
 *   列表   内存 5 分钟（翻页来回切不重复请求）
 *   封面   内存
 *   详情   内存 + localStorage（详情几乎不变，LRU 留最近 80 部，防写爆）
 */
(function () {
  'use strict';

  var API = 'https://dbzy.tv/api.php/provide/vod/';
  var LIST_TTL = 5 * 60 * 1000;
  var D_PREFIX = 'jk.d.';
  var D_INDEX = 'jk.d.index';
  var D_MAX = 80;
  var BATCH = 20;

  var NAV = [
    { key: 'rec', name: '推荐', t: 37, icon: '🔥', sub: [] },
    {
      key: 'short', name: '短剧', t: 37, icon: '🎭',
      sub: [
        { t: 37, name: '全部' },
        { t: 45, name: '反转爽剧' },
        { t: 46, name: '言情总裁' },
        { t: 47, name: '现代都市' },
        { t: 48, name: '古装仙侠' },
        { t: 43, name: '重生民国' },
        { t: 44, name: '穿越现代' },
        { t: 49, name: '悬疑烧脑' }
      ]
    },
    { key: 'tv', name: '连续剧', t: 2, icon: '📺', sub: [{ t: 2, name: '全部' }] },
    { key: 'anime', name: '动漫', t: 4, icon: '🌸', sub: [{ t: 4, name: '全部' }] }
  ];

  /* ---------------------------------------------------------------- 网络 */

  function proxyUrl(u) {
    return '/proxy?url=' + encodeURIComponent(u);
  }

  function getText(url, timeoutMs) {
    var ms = timeoutMs || 15000;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, ms);

    return fetch(proxyUrl(url), ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('源站返回 ' + r.status);
        return r.text();
      })
      .catch(function (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') throw new Error('源站超时');
        throw e;
      });
  }

  function api(params, timeoutMs) {
    var qs = Object.keys(params)
      .filter(function (k) {
        var v = params[k];
        return v !== undefined && v !== null && v !== '';
      })
      .map(function (k) {
        return k + '=' + encodeURIComponent(params[k]);
      })
      .join('&');

    return getText(API + '?' + qs, timeoutMs).then(function (txt) {
      var j;
      try {
        j = JSON.parse(txt);
      } catch (e) {
        throw new Error('源站返回非 JSON');
      }
      if (j.code !== 1) throw new Error(j.msg || '源站接口错误');
      return j;
    });
  }

  /* ---------------------------------------------------------------- 缓存 */

  var listCache = Object.create(null);
  var coverCache = Object.create(null);
  var detailCache = Object.create(null);

  function lcGet(k) {
    var hit = listCache[k];
    if (hit && Date.now() - hit.ts < LIST_TTL) return hit.data;
    return null;
  }

  function lcSet(k, data) {
    listCache[k] = { ts: Date.now(), data: data };
  }

  function lsGet(id) {
    if (detailCache[id]) return detailCache[id];
    try {
      var raw = localStorage.getItem(D_PREFIX + id);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (d && d.episodes && d.episodes.length) {
        detailCache[id] = d;
        return d;
      }
    } catch (e) {
    }
    return null;
  }

  function lsSet(id, data) {
    detailCache[id] = data;
    try {
      localStorage.setItem(D_PREFIX + id, JSON.stringify(data));
      var idx = [];
      try {
        idx = JSON.parse(localStorage.getItem(D_INDEX) || '[]');
      } catch (e) {
        idx = [];
      }
      idx = idx.filter(function (x) {
        return x !== id;
      });
      idx.push(id);
      while (idx.length > D_MAX) {
        localStorage.removeItem(D_PREFIX + idx.shift());
      }
      localStorage.setItem(D_INDEX, JSON.stringify(idx));
    } catch (e) {
      // 配额写满就算了，内存里还有一份
    }
  }

  /* ---------------------------------------------------------------- 列表 */

  function mapItem(x) {
    return {
      id: String(x.vod_id),
      title: (x.vod_name || '').trim(),
      type: x.type_name || '',
      typeId: x.type_id,
      remarks: (x.vod_remarks || '').trim(),
      time: (x.vod_time || '').slice(0, 10)
    };
  }

  function list(t, pg) {
    t = parseInt(t, 10) || 37;
    pg = Math.max(1, parseInt(pg, 10) || 1);
    var key = t + ':' + pg;
    var hit = lcGet(key);
    if (hit) {
      return Promise.resolve({
        ok: true, cached: true, t: t, page: hit.page,
        pagecount: hit.pagecount, total: hit.total, list: hit.list
      });
    }
    return api({ ac: 'list', t: t, pg: pg }).then(function (j) {
      var data = {
        page: j.page || pg,
        pagecount: j.pagecount || 1,
        total: j.total || 0,
        list: (j.list || []).map(mapItem)
      };
      lcSet(key, data);
      return {
        ok: true, cached: false, t: t, page: data.page,
        pagecount: data.pagecount, total: data.total, list: data.list
      };
    });
  }

  /* ---------------------------------------------------------------- 封面 */

  function covers(ids) {
    var want = (ids || []).map(String).filter(Boolean);
    var out = {};
    var miss = [];
    want.forEach(function (id) {
      if (coverCache[id] !== undefined) out[id] = coverCache[id];
      else miss.push(id);
    });
    if (!miss.length) return Promise.resolve({ ok: true, covers: out });

    var jobs = [];
    for (var i = 0; i < miss.length; i += BATCH) {
      (function (batch) {
        jobs.push(
          api({ ac: 'detail', ids: batch.join(',') })
            .then(function (j) {
              (j.list || []).forEach(function (x) {
                var key = String(x.vod_id);
                var pic = x.vod_pic || '';
                coverCache[key] = pic;
                out[key] = pic;
              });
            })
            .catch(function () {
              batch.forEach(function (id) {
                out[id] = '';
              });
            })
        );
      })(miss.slice(i, i + BATCH));
    }

    return Promise.all(jobs).then(function () {
      miss.forEach(function (id) {
        if (coverCache[id] === undefined) coverCache[id] = '';
        if (!out[id]) out[id] = '';
      });
      return { ok: true, covers: out };
    });
  }

  /* ---------------------------------------------------------------- 详情 */

  function stripHtml(html) {
    return String(html)
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  /**
   * vod_play_url -> 集列表
   * 组间 $$$ 分隔（多线路），组内 # 分隔集，集内 $ 分隔「集名$地址」
   */
  function parseEpisodes(playUrl, playFrom) {
    var groups = String(playUrl || '').split('$$$');
    var froms = String(playFrom || '').split(/\$\$\$|,/);
    var gi = 0;
    for (var i = 0; i < groups.length; i++) {
      if (/\.m3u8/i.test(groups[i])) {
        gi = i;
        break;
      }
    }
    var eps = [];
    var parts = (groups[gi] || '').split('#');
    parts.forEach(function (seg, i) {
      if (!seg) return;
      var idx = seg.indexOf('$');
      var title, url;
      if (idx >= 0) {
        title = seg.slice(0, idx).trim();
        url = seg.slice(idx + 1).trim();
      } else {
        url = seg.trim();
        title = '';
      }
      if (!url || !/\.m3u8/i.test(url)) return;
      eps.push({ title: title || ('第' + (i + 1) + '集'), url: url, index: eps.length });
    });
    return { episodes: eps, line: froms[gi] || '' };
  }

  function detail(id, refresh) {
    id = String(id);
    if (!refresh) {
      var hit = lsGet(id);
      if (hit) return Promise.resolve(Object.assign({ ok: true, cached: true }, hit));
    }
    return api({ ac: 'detail', ids: id }, 20000).then(function (j) {
      var x = (j.list || [])[0];
      if (!x) throw new Error('源站没有这部片');
      var parsed = parseEpisodes(x.vod_play_url, x.vod_play_from);
      var data = {
        id: String(x.vod_id),
        title: (x.vod_name || '').trim(),
        pic: x.vod_pic || '',
        type: x.vod_class || x.type_name || '',
        area: x.vod_area || '',
        year: x.vod_year || '',
        remarks: (x.vod_remarks || '').trim(),
        actor: (x.vod_actor || '').trim(),
        director: (x.vod_director || '').trim(),
        score: x.vod_score || '',
        intro: stripHtml(x.vod_blurb || x.vod_content || ''),
        line: parsed.line,
        episodes: parsed.episodes,
        updatedAt: Date.now()
      };
      if (data.pic) coverCache[id] = data.pic;
      if (data.episodes.length) lsSet(id, data);
      return Object.assign({ ok: true, cached: false }, data);
    });
  }

  /* ---------------------------------------------------------------- 搜索 */

  /* 官方搜索接口被封（code 1002），只能并发翻页 + 标题过滤 */
  function search(t, kw, pages) {
    kw = String(kw || '').trim();
    if (!kw) return Promise.resolve({ ok: true, kw: '', scanned: 0, list: [] });

    t = parseInt(t, 10) || 37;
    var maxPages = Math.min(20, Math.max(1, parseInt(pages, 10) || 8));
    var key = 'search:' + t + ':' + kw + ':' + maxPages;
    var hit = lcGet(key);
    if (hit) return Promise.resolve(Object.assign({ ok: true, cached: true }, hit));

    var jobs = [];
    for (var p = 1; p <= maxPages; p++) jobs.push(list(t, p));

    return Promise.all(jobs.map(function (p) {
      return p.then(function (v) {
        return { ok: true, list: v.list || [] };
      }).catch(function () {
        return { ok: false, list: [] };
      });
    })).then(function (results) {
      var low = kw.toLowerCase();
      var seen = Object.create(null);
      var hits = [];
      var okPages = 0;
      results.forEach(function (r) {
        if (!r.ok) return;
        okPages++;
        r.list.forEach(function (it) {
          if (seen[it.id]) return;
          var title = (it.title || '').toLowerCase();
          var type = (it.type || '').toLowerCase();
          if (title.indexOf(low) >= 0 || type.indexOf(low) >= 0) {
            seen[it.id] = 1;
            hits.push(it);
          }
        });
      });
      var data = { kw: kw, t: t, scanned: okPages * 20, list: hits.slice(0, 120) };
      lcSet(key, data);
      return Object.assign({ ok: true, cached: false }, data);
    });
  }

  /* ---------------------------------------------------------------- 导出 */

  window.JkApi = {
    NAV: NAV,
    API: API,
    proxyUrl: proxyUrl,
    list: list,
    covers: covers,
    detail: detail,
    search: search,
    parseEpisodes: parseEpisodes,
    stripHtml: stripHtml
  };
})();
