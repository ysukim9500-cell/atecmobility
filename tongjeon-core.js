/* ============================================================================
 *  통전망 — 공용 모듈
 *  Supabase 호출 래퍼, 마스터 캐시, 탭 전환, 상세 시트, 공통 유틸.
 *  화면별 로직은 tongjeon-dash / -faults / -stock / -master 가 담당한다.
 * ========================================================================== */
window.TJ = (function () {
  'use strict';

  var SB = null, ME = null, CUR = 'dash';
  var cache = {};

  /* ── 요청 ──────────────────────────────────────────────────────────── */
  function api(path, opts) {
    return AtecAuth.authFetch(SB + '/rest/v1/' + path, opts || {});
  }
  /** 조회 → 배열. 실패하면 빈 배열과 함께 토스트 */
  function select(path) {
    return api(path).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ' ' + t.slice(0, 160)); });
      return r.json();
    });
  }
  /** 서버가 한 번에 1,000행까지만 주므로, 다 받을 때까지 이어서 요청한다 */
  function selectAll(path, pageSize) {
    var size = pageSize || 1000, out = [];
    function step(from) {
      return api(path, { headers: { 'Range': from + '-' + (from + size - 1) } }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ' ' + t.slice(0, 160)); });
        return r.json().then(function (rows) {
          out = out.concat(rows);
          if (rows.length < size) return out;
          return step(from + size);
        });
      });
    }
    return step(0);
  }

  /** 전체 건수만 (Range 0-0 + count=exact) */
  function count(path) {
    return api(path, { headers: { 'Prefer': 'count=exact', 'Range': '0-0' } }).then(function (r) {
      var cr = r.headers.get('content-range') || '';
      var m = cr.match(/\/(\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    });
  }
  function insert(table, rows, extra) {
    return api(table + (extra || ''), {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(rows)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(msgOf(r.status, t)); });
      return r.json();
    });
  }
  function update(table, filter, patch) {
    return api(table + '?' + filter, {
      method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify(patch)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(msgOf(r.status, t)); });
      return true;
    });
  }
  function remove(table, filter) {
    return api(table + '?' + filter, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(msgOf(r.status, t)); });
        return true;
      });
  }
  /** 서버 거부를 사람이 읽을 수 있는 말로 */
  function msgOf(status, text) {
    if (status === 401 || status === 403) return '권한이 없습니다. 관리자에게 문의하세요.';
    if (/violates row-level security/i.test(text)) return '권한이 없습니다. 관리자만 할 수 있는 작업입니다.';
    if (/duplicate key/i.test(text)) return '이미 등록된 값입니다.';
    return '요청 실패 (' + status + ')';
  }

  /* ── 마스터 캐시 ───────────────────────────────────────────────────── */
  function master(key, path) {
    if (cache[key]) return Promise.resolve(cache[key]);
    return selectAll(path).then(function (rows) { cache[key] = rows; return rows; });
  }
  function clearCache(key) { if (key) delete cache[key]; else cache = {}; }

  var M = {
    terminals: function () { return master('terminals', 'tj_terminals?select=id,name,region,kinds,active&order=name'); },
    parts: function () { return master('parts', 'tj_parts?select=id,name,category,low_stock_threshold&order=name'); },
    orgs: function () { return master('orgs', 'tj_orgs?select=id,name,has_stock&order=name'); }
  };
  /** id → 이름 조회표 */
  function indexBy(rows, key) {
    var m = {};
    (rows || []).forEach(function (r) { m[r[key]] = r; });
    return m;
  }

  /* ── 유틸 ──────────────────────────────────────────────────────────── */
  function num(n) { return (n == null ? 0 : n).toLocaleString('ko-KR'); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function monthStart() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01'; }
  function daysBetween(a, b) {
    if (!a || !b) return null;
    return Math.round((new Date(b) - new Date(a)) / 86400000);
  }
  function statusChip(s) {
    var cls = { '완료': 'chip-done', '진행중': 'chip-prog', '접수': 'chip-new', '보류': 'chip-hold' }[s] || 'chip-hold';
    return '<span class="chip ' + cls + '">' + esc(s) + '</span>';
  }
  function toast(text, ok) {
    var t = document.getElementById('tj-toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'tj-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%) translateY(10px);z-index:99999;' +
        'padding:13px 24px;border-radius:13px;font-weight:800;font-size:15px;color:#fff;' +
        'box-shadow:0 14px 36px -8px rgba(0,0,0,.5);opacity:0;transition:opacity .25s,transform .25s;' +
        'pointer-events:none;max-width:90vw;text-align:center';
      document.body.appendChild(t);
    }
    t.style.background = (ok === false) ? '#dc2626' : '#0D9488';
    t.textContent = text;
    requestAnimationFrame(function () { t.style.opacity = '1'; t.style.transform = 'translateX(-50%) translateY(0)'; });
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(10px)'; }, 2600);
  }
  function isMobile() { return document.documentElement.classList.contains('is-mobile'); }

  /* ── 상세·더보기 시트 ──────────────────────────────────────────────── */
  function openSheet(title, bodyHtml, actions) {
    document.getElementById('tj-sheet-title').textContent = title;
    document.getElementById('tj-sheet-body').innerHTML = bodyHtml;
    var a = document.getElementById('tj-sheet-actions');
    a.innerHTML = actions || '';
    document.getElementById('tj-sheet').classList.add('open');
    document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    document.getElementById('tj-sheet').classList.remove('open');
    document.documentElement.style.overflow = ''; document.body.style.overflow = '';
  }
  function detailRows(pairs) {
    return pairs.filter(function (p) { return p[1] !== null && p[1] !== undefined && p[1] !== ''; })
      .map(function (p) {
        return '<div class="drow"><span class="dl">' + esc(p[0]) + '</span><span class="dv">' + (p[2] ? p[1] : esc(p[1])) + '</span></div>';
      }).join('');
  }
  function openMore() {
    var items = [
      ['repairs', '수리 관리', '<path d="M14.7 6.3a4 4 0 0 0 5 5L15 16l-3 3-4-4 3-3 3.7-5.7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'],
      ['equip', '장비 현황', '<rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/>'],
      ['terminals', '터미널 명부', '<path d="M12 21s7-5.3 7-11a7 7 0 1 0-14 0c0 5.7 7 11 7 11Z" stroke="currentColor" stroke-width="1.8"/>']
    ];
    openSheet('더보기', items.map(function (it) {
      return '<button class="more-item" onclick="TJ.closeSheet();TJ.tab(\'' + it[0] + '\')">' +
        '<svg viewBox="0 0 24 24" fill="none">' + it[2] + '</svg>' + it[1] +
        '<span style="margin-left:auto;color:#C7CAD6">›</span></button>';
    }).join(''), '');
  }

  /* ── 탭 ────────────────────────────────────────────────────────────── */
  var RENDER = {};
  function registerTab(name, fn) { RENDER[name] = fn; }
  function tab(name) {
    CUR = name;
    var btns = document.querySelectorAll('#tj-tabs .rtab');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].dataset.tab === name);
    ['dash', 'faults', 'stock', 'repairs', 'equip', 'terminals'].forEach(function (t) {
      document.getElementById('tab-' + t).classList.toggle('hidden', t !== name);
    });
    if (RENDER[name]) {
      try { RENDER[name](); } catch (e) { console.error(name, e); toast('화면을 여는 중 문제가 생겼습니다.', false); }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ── 시작 ──────────────────────────────────────────────────────────── */
  function boot(profile) {
    SB = AtecAuth.SB_URL;
    ME = profile;

    document.getElementById('tj-user').innerHTML =
      '<span class="font-semibold">' + esc(profile.name) + '</span>' +
      (profile.role === 'admin' ? '<span class="text-[10px] bg-amber-300 text-amber-900 font-bold rounded px-1.5 py-0.5">관리자</span>' : '') +
      '<a href="index.html" class="ml-1 text-[11px] underline decoration-white/40">포털</a>' +
      '<button onclick="TJ.logout()" class="ml-1 text-[11px] underline decoration-white/40">로그아웃</button>';

    document.querySelectorAll('#tj-tabs .rtab[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { tab(b.dataset.tab); });
    });
    document.getElementById('tj-sheet').addEventListener('click', function (e) {
      if (e.target.id === 'tj-sheet') closeSheet();
    });

    // 마스터를 미리 받아두고 헤더 요약을 채운다
    Promise.all([M.terminals(), M.parts(), M.orgs()])
      .then(function () { return Promise.all([count('tj_faults?select=id'), count('tj_faults?select=id&status=in.(접수,진행중)')]); })
      .then(function (c) {
        document.getElementById('tj-meta').innerHTML =
          '<div class="font-bold">장애 ' + num(c[0]) + '건 · 터미널 ' + num(cache.terminals.length) + '개</div>' +
          '<div class="text-teal-100/80 mt-0.5">미처리 ' + num(c[1]) + '건</div>';
        tab('dash');
      })
      .catch(function (e) {
        console.error(e);
        document.getElementById('tj-meta').innerHTML = '<div class="font-bold">데이터를 불러오지 못했습니다</div>';
        toast('데이터를 불러오지 못했습니다. 새로고침해 주세요.', false);
      });
  }

  function logout() { AtecAuth.logout(); location.href = 'index.html'; }

  return {
    boot: boot, logout: logout, tab: tab, registerTab: registerTab,
    me: function () { return ME; },
    isAdmin: function () { return !!(ME && ME.role === 'admin'); },
    isMobile: isMobile,
    api: api, select: select, selectAll: selectAll, count: count, insert: insert, update: update, remove: remove,
    master: M, clearCache: clearCache, indexBy: indexBy,
    num: num, esc: esc, today: today, monthStart: monthStart, daysBetween: daysBetween,
    statusChip: statusChip, toast: toast,
    openSheet: openSheet, closeSheet: closeSheet, detailRows: detailRows, openMore: openMore
  };
})();
