/* ═══════════════════════════════════════════════════════════════════════════
 *  ATEC Driving — 운행일지 웹
 *
 *  화면
 *    마감 현황 · 운행일지(수정 포함) · 하이패스 대조 · 정산
 *
 *  권한
 *    화면에서 감추는 건 편의일 뿐이고, 실제 차단은 서버가 한다.
 *    조회는 RLS(trips_web_read), 쓰기는 Edge Function(trip-edit / toll-apply)만 통한다.
 *  ═════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var SB = 'https://eiyksjcqntenmetmhmij.supabase.co';
  // publishable(anon) 키 — 공개돼도 되는 값이다. 권한은 로그인 토큰과 RLS 가 정한다.
  var KEY = 'sb_publishable_9xO2pBxLIpMvxbFmQPw1hQ_qtHN5Rm5';
  var K_AT = 'drv_at', K_RT = 'drv_rt', K_ME = 'drv_me';
  var KST = 9 * 3600e3;

  var $ = function (id) { return document.getElementById(id); };
  function ss(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      if (v === null) return sessionStorage.removeItem(k);
      return sessionStorage.setItem(k, v);
    } catch (e) { return null; }
  }
  function me() { try { return JSON.parse(ss(K_ME) || 'null'); } catch (e) { return null; } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function won(n) { return n == null ? '—' : Number(n).toLocaleString('ko-KR'); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function hhmm(ms) { var d = new Date(ms + KST); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
  function md(ms) {
    var d = new Date(ms + KST), w = '일월화수목금토'[d.getUTCDay()];
    return pad(d.getUTCMonth() + 1) + '.' + pad(d.getUTCDate()) + '(' + w + ')';
  }

  /* ── 마감주기: 전월 21일 00:00 ~ 당월 21일 00:00 (KST, 끝 배타) ── */
  function cycleOf(y, m) {
    return { start: Date.UTC(y, m - 1, 21) - KST, end: Date.UTC(y, m, 21) - KST };
  }
  function cycleName(y, m) {
    var c = cycleOf(y, m), a = new Date(c.start + KST), b = new Date(c.end + KST - 1);
    return y + '년 ' + m + '월 마감분 · ' + pad(a.getUTCMonth() + 1) + '.' + pad(a.getUTCDate()) +
      ' ~ ' + pad(b.getUTCMonth() + 1) + '.' + pad(b.getUTCDate());
  }
  function currentCycle() {
    var k = new Date(Date.now() + KST), y = k.getUTCFullYear(), m = k.getUTCMonth() + 1;
    if (k.getUTCDate() < 21) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
    return { y: y, m: m };
  }

  /* ── 요청 ── */
  function api(path, opt) {
    opt = opt || {};
    var h = Object.assign({ apikey: KEY, 'Content-Type': 'application/json' }, opt.headers || {});
    h.Authorization = 'Bearer ' + (ss(K_AT) || KEY);
    return fetch(SB + path, Object.assign({}, opt, { headers: h }));
  }
  function refresh() {
    var rt = ss(K_RT); if (!rt) return Promise.resolve(false);
    return fetch(SB + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt })
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.access_token) return false;
        ss(K_AT, j.access_token); if (j.refresh_token) ss(K_RT, j.refresh_token);
        return true;
      }).catch(function () { return false; });
  }
  /** 401 이면 토큰을 한 번 갱신하고 다시 시도한다. */
  function apiRetry(path, opt) {
    return api(path, opt).then(function (r) {
      if (r.status !== 401) return r;
      return refresh().then(function (ok) { return ok ? api(path, opt) : r; });
    });
  }
  function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'toast'; }, 3600);
  }

  /* ═══════════════ 로그인 ═══════════════ */
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var b = $('loginBtn'), u = $('u').value.trim(), p = $('p').value;
    if (!u || !p) return;
    $('lmsg').classList.remove('show');
    b.disabled = true; b.innerHTML = '<span class="spin"></span> 확인 중…';
    fetch(SB + '/functions/v1/driving-auth', {
      method: 'POST',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        b.disabled = false; b.textContent = '로그인';
        if (!res.ok || !res.j || !res.j.ok) {
          var m = $('lmsg');
          m.textContent = (res.j && res.j.error) || '로그인에 실패했습니다';
          m.classList.add('show'); return;
        }
        ss(K_AT, res.j.access_token); ss(K_RT, res.j.refresh_token);
        ss(K_ME, JSON.stringify(res.j.profile));
        $('p').value = '';
        enter();
      }).catch(function () {
        b.disabled = false; b.textContent = '로그인';
        var m = $('lmsg'); m.textContent = '서버에 연결하지 못했습니다.'; m.classList.add('show');
      });
  });
  $('logoutBtn').addEventListener('click', function () {
    ss(K_AT, null); ss(K_RT, null); ss(K_ME, null);
    $('app').style.display = 'none'; $('login').style.display = 'grid';
  });

  /* ═══════════════ 상태 ═══════════════ */
  var ME = null, TRIPS = [], CYC = null, VIEW = 'close';
  var GROUPS = [], HP_TRIPS = [], BATCH = '';

  /** 저장된 프로필은 로그인 시점의 사본이다. 권한이 바뀌었을 수 있으니 매번 다시 읽는다. */
  function syncProfile() {
    return apiRetry('/rest/v1/profiles?select=perms,status,name&limit=1')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        var p = rows && rows[0]; if (!p) return;
        var m = me(); if (!m) return;
        m.perms = Array.isArray(p.perms) ? p.perms : [];
        m.is_admin = m.perms.indexOf('driving_admin') >= 0;
        if (p.name) m.name = p.name;
        ss(K_ME, JSON.stringify(m));
      }).catch(function () {});
  }

  function enter() {
    if (!me()) return;
    $('login').style.display = 'none';
    $('app').style.display = 'flex';

    var sel = $('fCycle'); sel.innerHTML = '';
    var c = currentCycle();
    for (var i = 0; i < 12; i++) {
      var y = c.y, m = c.m - i;
      while (m <= 0) { m += 12; y -= 1; }
      var o = document.createElement('option');
      o.value = y + '-' + m; o.textContent = cycleName(y, m);
      sel.appendChild(o);
    }
    sel.addEventListener('change', load);

    syncProfile().then(function () {
      ME = me();
      $('whoName').textContent = ME.name || ME.username;
      $('whoMeta').textContent = [ME.position, ME.dept].filter(Boolean).join(' · ') +
        (ME.is_admin ? ' · 관리자' : '');
      document.body.classList.toggle('is-admin', !!ME.is_admin);
      bindDrop();
      load();
    });
  }

  /* ═══════════════ 화면 전환 ═══════════════ */
  $('nav').addEventListener('click', function (e) {
    var a = e.target.closest('[data-v]'); if (!a) return;
    show(a.dataset.v);
  });
  document.addEventListener('click', function (e) {
    var g = e.target.closest('[data-go]'); if (!g) return;
    if (e.target.closest('button,select,input,a')) return;
    show(g.dataset.go);
    if (g.dataset.filter) { $('fState').value = g.dataset.filter; renderTrips(); }
  });
  function show(v) {
    VIEW = v;
    ['close', 'trips', 'hipass', 'settle'].forEach(function (k) {
      var el = $('view_' + k); if (el) el.style.display = (k === v ? 'block' : 'none');
    });
    Array.prototype.forEach.call($('nav').querySelectorAll('[data-v]'), function (x) {
      x.classList.toggle('on', x.dataset.v === v);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ═══════════════ 데이터 ═══════════════ */
  var COLS = 'id,username,plate_no,start_time,end_time,distance_km,purpose,' +
    'start_address,end_address,visit_place,start_odometer,end_odometer,' +
    'toll_cost,toll_status,toll_source,toll_revision,parking_cost,is_manual';

  function fetchRange(lo, hi) {
    var acc = [];
    function page(off) {
      return apiRetry('/rest/v1/trips?select=' + COLS +
        '&deleted_at=is.null&start_time=gte.' + lo + '&start_time=lt.' + hi +
        '&order=start_time.desc&offset=' + off + '&limit=1000')
        .then(function (r) {
          if (r.status === 401) throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.');
          if (!r.ok) throw new Error('불러오지 못했습니다 (' + r.status + ')');
          return r.json();
        }).then(function (rows) {
          acc = acc.concat(rows || []);
          if ((rows || []).length < 1000 || off >= 9000) return acc;
          return page(off + 1000);
        });
    }
    return page(0);
  }

  function load() {
    $('busy').style.display = 'block';
    var v = $('fCycle').value.split('-');
    CYC = cycleOf(+v[0], +v[1]);
    CYC.label = $('fCycle').selectedOptions[0].textContent;
    fetchRange(CYC.start, CYC.end).then(function (rows) {
      TRIPS = rows;
      // 차량 목록
      var vs = {}; TRIPS.forEach(function (t) { if (t.plate_no) vs[t.plate_no] = 1; });
      var sv = $('fVeh');
      sv.innerHTML = '<option value="">전체 차량 (' + Object.keys(vs).length + ')</option>';
      Object.keys(vs).sort().forEach(function (p) {
        var o = document.createElement('option'); o.value = p; o.textContent = p; sv.appendChild(o);
      });
      renderClose(); renderTrips(); renderSettle();
      $('busy').style.display = 'none';
    }).catch(function (e) {
      $('busy').style.display = 'none';
      toast(e.message, true);
    });
  }

  /* ── 점검 규칙 ── */
  function isUnknownToll(t) { return t.toll_status === 'UNKNOWN' || t.toll_status === 'PENDING' || t.toll_cost == null; }
  function isBiz(t) { return t.purpose !== '비업무용'; }
  function odoBreaks() {
    // 차량별로 시간순 정렬해 앞 운행 도착 ≠ 다음 출발이면 표시
    var byV = {};
    TRIPS.forEach(function (t) { (byV[t.plate_no] = byV[t.plate_no] || []).push(t); });
    var out = [];
    Object.keys(byV).forEach(function (p) {
      var arr = byV[p].slice().sort(function (a, b) { return a.start_time - b.start_time; });
      for (var i = 1; i < arr.length; i++) {
        var prev = arr[i - 1], cur = arr[i];
        if (prev.end_odometer == null || cur.start_odometer == null) continue;
        if (Number(cur.start_odometer) !== Number(prev.end_odometer)) out.push({ trip: cur, prev: prev });
      }
    });
    return out;
  }

  /* ═══════════════ ① 마감 현황 ═══════════════ */
  function renderClose() {
    var unk = TRIPS.filter(isUnknownToll);
    var noPurpose = TRIPS.filter(function (t) { return !t.purpose; });
    var breaks = odoBreaks();
    var tollSum = 0, parkSum = 0, dist = 0;
    TRIPS.forEach(function (t) {
      dist += Number(t.distance_km || 0);
      if (t.toll_cost != null) tollSum += Number(t.toll_cost);
      if (t.parking_cost != null) parkSum += Number(t.parking_cost);
    });

    $('cLabel').textContent = CYC.label + (ME.is_admin ? ' · 전체' : ' · 본인 운행만');
    $('kTrips').innerHTML = TRIPS.length + '<small>건</small>';
    $('kDist').innerHTML = Math.round(dist).toLocaleString('ko-KR') + '<small>km</small>';
    $('kToll').innerHTML = won(tollSum) + '<small>원</small>';
    $('kPark').innerHTML = won(parkSum) + '<small>원</small>';
    $('kUnk').innerHTML = unk.length + '<small>건</small>';
    $('kUnk').parentNode.classList.toggle('alert', unk.length > 0);

    var items = [
      { key: '통행료', bad: unk.length, desc: '금액을 정하지 않은 운행', filter: 'unknown' },
      { key: '운행목적', bad: noPurpose.length, desc: '목적이 비어 있는 운행', filter: 'nopurpose' },
      { key: '계기판', bad: breaks.length, desc: '앞 운행 도착값과 이어지지 않음', filter: 'odo' }
    ];
    $('chk').innerHTML = items.map(function (it) {
      return '<li data-go="trips" data-filter="' + it.filter + '">' +
        '<span class="pill ' + (it.bad ? 'bad' : 'ok') + '">' + (it.bad ? '미완' : '완료') + '</span>' +
        '<span class="nm">' + it.key + '</span>' +
        '<span class="ds">' + it.desc + '</span>' +
        '<span class="vl' + (it.bad ? ' bad' : '') + '">' + (it.bad ? it.bad + '건' : '이상 없음') + '</span>' +
        '</li>';
    }).join('');

    var left = items.reduce(function (a, b) { return a + b.bad; }, 0);
    $('closeState').innerHTML = left
      ? '<span class="pill bad">처리할 것 ' + left + '건</span>'
      : '<span class="pill ok">모두 정리됨</span>';

    // 차량별 요약
    var byV = {};
    TRIPS.forEach(function (t) {
      var v = byV[t.plate_no] = byV[t.plate_no] || { n: 0, km: 0, toll: 0, unk: 0 };
      v.n++; v.km += Number(t.distance_km || 0);
      if (t.toll_cost != null) v.toll += Number(t.toll_cost);
      if (isUnknownToll(t)) v.unk++;
    });
    var rows = Object.keys(byV).sort(function (a, b) { return byV[b].n - byV[a].n; }).slice(0, 12);
    $('vehRows').innerHTML = rows.length ? rows.map(function (p) {
      var v = byV[p];
      return '<tr><td>' + esc(p) + '</td><td class="num">' + v.n + '</td>' +
        '<td class="num">' + Math.round(v.km).toLocaleString('ko-KR') + 'km</td>' +
        '<td class="num">' + won(v.toll) + '</td>' +
        '<td class="num">' + (v.unk ? '<span class="pill bad">' + v.unk + '</span>' : '—') + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="empty">운행 기록이 없습니다</td></tr>';
  }

  /* ═══════════════ ② 운행일지 ═══════════════ */
  $('fVeh').addEventListener('change', renderTrips);
  $('fState').addEventListener('change', renderTrips);
  $('fWho').addEventListener('input', renderTrips);

  function filtered() {
    var veh = $('fVeh').value, st = $('fState').value, who = $('fWho').value.trim().toLowerCase();
    var breaks = {}; odoBreaks().forEach(function (b) { breaks[b.trip.id] = b.prev; });
    return TRIPS.filter(function (t) {
      if (veh && t.plate_no !== veh) return false;
      if (who && String(t.username || '').toLowerCase().indexOf(who) < 0) return false;
      if (st === 'unknown' && !isUnknownToll(t)) return false;
      if (st === 'nopurpose' && t.purpose) return false;
      if (st === 'odo' && !breaks[t.id]) return false;
      if (st === 'manual' && !t.is_manual) return false;
      if (st === 'weekend') {
        var d = new Date(t.start_time + KST), h = d.getUTCHours(), w = d.getUTCDay();
        if (!(w === 0 || w === 6 || h >= 22 || h < 6)) return false;
      }
      return true;
    }).map(function (t) { t._odoPrev = breaks[t.id] || null; return t; });
  }

  function tollCell(t) {
    if (isUnknownToll(t)) return '<span class="pill bad">미확정</span>';
    var cls = Hipass.bySource(t.toll_source) === 'person' ? 'ok' : 'mute';
    return '<span class="pill ' + cls + '">' + won(t.toll_cost) + '</span>';
  }

  function renderTrips() {
    var list = filtered();
    $('tCount').textContent = list.length === TRIPS.length
      ? TRIPS.length + '건' : list.length + ' / ' + TRIPS.length + '건';
    $('tLabel').textContent = CYC ? CYC.label : '';
    if (!list.length) {
      $('tRows').innerHTML = '<tr><td colspan="13" class="empty">해당하는 운행이 없습니다</td></tr>';
      return;
    }
    $('tRows').innerHTML = list.map(function (t) {
      var route = [t.start_address, t.end_address].filter(Boolean).join(' → ') || '—';
      return '<tr data-id="' + t.id + '">' +
        '<td>' + md(t.start_time) + '</td>' +
        '<td>' + (t.purpose ? esc(t.purpose) : '<span class="pill bad">비어 있음</span>') + '</td>' +
        '<td>' + esc(t.plate_no || '—') + (t.is_manual ? ' <span class="tagx">수기</span>' : '') + '</td>' +
        '<td class="admin-only">' + esc(t.username || '') + '</td>' +
        '<td class="num">' + (t.distance_km == null ? '—' : Math.round(t.distance_km) + 'km') + '</td>' +
        '<td>' + hhmm(t.start_time) + '~' + (t.end_time ? hhmm(t.end_time) : '') + '</td>' +
        '<td class="wrap">' + esc(route) + '</td>' +
        '<td>' + (t.visit_place ? esc(t.visit_place) : '<span class="mut">—</span>') + '</td>' +
        '<td class="num">' + (t.end_odometer == null ? '—' : Number(t.end_odometer).toLocaleString('ko-KR')) +
          (t._odoPrev ? ' <span class="pill warn" title="앞 운행 도착 ' + t._odoPrev.end_odometer + '">불연속</span>' : '') + '</td>' +
        '<td class="num">' + tollCell(t) + '</td>' +
        '<td class="num">' + (t.parking_cost ? won(t.parking_cost) : '<span class="mut">—</span>') + '</td>' +
        '<td class="src">' + esc(t.toll_source || '—') + '</td>' +
        '<td><button class="btn sm" data-edit="' + t.id + '">고치기</button></td>' +
        '</tr>';
    }).join('');
  }

  /* ── 수정 패널 ── */
  $('tRows').addEventListener('click', function (e) {
    var b = e.target.closest('[data-edit]'); if (!b) return;
    openEdit(+b.dataset.edit);
  });
  function openEdit(id) {
    var t = TRIPS.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    $('eTitle').textContent = md(t.start_time) + ' ' + hhmm(t.start_time) + ' · ' + (t.plate_no || '');
    $('eSub').textContent = [t.username, t.start_address, t.end_address].filter(Boolean).join(' · ');
    $('ePurpose').value = t.purpose || '';
    $('eVisit').value = t.visit_place || '';
    $('eToll').value = isUnknownToll(t) ? '' : String(t.toll_cost);
    $('eTollNow').textContent = isUnknownToll(t) ? '지금: 미확정'
      : '지금: ' + won(t.toll_cost) + '원 · ' + (t.toll_source || '근거 없음');
    $('ePark').value = t.parking_cost == null ? '' : String(t.parking_cost);
    $('eOdoS').value = t.start_odometer == null ? '' : String(t.start_odometer);
    $('eOdoE').value = t.end_odometer == null ? '' : String(t.end_odometer);
    $('eOdoHint').textContent = t._odoPrev
      ? '앞 운행 도착값은 ' + Number(t._odoPrev.end_odometer).toLocaleString('ko-KR') + ' 입니다'
      : '';
    $('edit').dataset.id = String(id);
    $('edit').classList.add('open');
  }
  function closeEdit() { $('edit').classList.remove('open'); }
  $('eClose').addEventListener('click', closeEdit);
  $('eCancel').addEventListener('click', closeEdit);
  $('eBackdrop').addEventListener('click', closeEdit);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeEdit(); });

  $('eUnknown').addEventListener('click', function () { $('eToll').value = ''; });

  $('eSave').addEventListener('click', function () {
    var id = +$('edit').dataset.id;
    var t = TRIPS.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    var patch = {};

    var p = $('ePurpose').value;
    if (p && p !== (t.purpose || '')) patch.purpose = p;

    var v = $('eVisit').value.trim();
    if (v !== (t.visit_place || '')) patch.visit_place = v;

    var pk = $('ePark').value.trim();
    var pkNow = t.parking_cost == null ? '' : String(t.parking_cost);
    if (pk !== pkNow) {
      if (pk === '') patch.parking_cost = null;
      else {
        var pn = Number(pk);
        if (!Number.isInteger(pn) || pn < 0 || pn > 300000) return toast('주차비는 0 ~ 300,000원 사이여야 합니다', true);
        patch.parking_cost = pn;
      }
    }

    var tl = $('eToll').value.trim();
    var tlNow = isUnknownToll(t) ? '' : String(t.toll_cost);
    if (tl !== tlNow) {
      if (tl === '') patch.toll = { mode: 'unknown' };
      else {
        var tn = Number(tl);
        if (!Number.isInteger(tn) || tn < 0 || tn > 200000) return toast('통행료는 0 ~ 200,000원 사이여야 합니다', true);
        patch.toll = { mode: 'amount', amount: tn };
      }
    }

    if (ME.is_admin) {
      var os = $('eOdoS').value.trim(), oe = $('eOdoE').value.trim();
      var osNow = t.start_odometer == null ? '' : String(t.start_odometer);
      var oeNow = t.end_odometer == null ? '' : String(t.end_odometer);
      if (os !== osNow || oe !== oeNow) {
        if (os === '' || oe === '') return toast('계기판은 출발·도착을 모두 넣어 주세요', true);
        patch.start_odometer = Number(os); patch.end_odometer = Number(oe);
      }
    }

    if (!Object.keys(patch).length) { closeEdit(); return; }

    var b = $('eSave'); b.disabled = true; b.innerHTML = '<span class="spin"></span> 저장 중…';
    apiRetry('/functions/v1/trip-edit', { method: 'POST', body: JSON.stringify({ id: id, patch: patch }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        b.disabled = false; b.textContent = '저장';
        if (!res.ok || !res.j || !res.j.ok) return toast((res.j && res.j.error) || '저장에 실패했습니다', true);
        // 서버가 돌려준 실제 값으로 목록을 갱신한다(트리거가 값을 바꿨을 수 있다).
        var row = res.j.row || {};
        Object.keys(row).forEach(function (k) { if (k !== 'id') t[k] = row[k]; });
        renderClose(); renderTrips(); renderSettle();
        closeEdit();
        toast(res.j.warning || (res.j.changed.join(' · ') + ' 저장했습니다'), !!res.j.warning);
      }).catch(function () {
        b.disabled = false; b.textContent = '저장';
        toast('서버에 연결하지 못했습니다', true);
      });
  });

  /* ═══════════════ ③ 하이패스 ═══════════════ */
  function bindDrop() {
    var d = $('drop'), i = $('pdf');
    if (!d || d._bound) return; d._bound = true;
    ['dragenter', 'dragover'].forEach(function (ev) {
      d.addEventListener(ev, function (e) { e.preventDefault(); d.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      d.addEventListener(ev, function (e) { e.preventDefault(); d.classList.remove('over'); });
    });
    d.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });
    i.addEventListener('change', function () { handleFiles(i.files); i.value = ''; });
  }

  function handleFiles(files) {
    if (!files || !files.length) return;
    $('hpBusy').style.display = 'block'; $('hpResult').innerHTML = '';
    var names = [];
    Promise.all(Array.prototype.map.call(files, function (f) {
      names.push(f.name);
      return f.arrayBuffer().then(function (b) { return Hipass.parsePdf(b); });
    })).then(function (lists) {
      var recs = [].concat.apply([], lists);
      BATCH = names.join(', ');
      if (!recs.length) throw new Error('영수증을 하나도 찾지 못했습니다.');
      // 화면에 걸린 마감분과 무관하게, 영수증이 덮는 기간의 운행을 따로 받아 맞춘다.
      var lo = Math.min.apply(null, recs.map(function (r) { return r.at; })) - 864e5;
      var hi = Math.max.apply(null, recs.map(function (r) { return r.at; })) + 864e5;
      return fetchRange(lo, hi).then(function (trips) {
        HP_TRIPS = trips;
        GROUPS = Hipass.match(recs, trips);
        renderHipass(lo, hi, trips.length);
      });
    }).catch(function (e) {
      $('hpResult').innerHTML = '<div class="res bad">' + esc(e.message || '읽지 못했습니다') + '</div>';
    }).then(function () { $('hpBusy').style.display = 'none'; });
  }

  var KIND_LABEL = {
    'new': { t: '미확정 → 확정', c: 'info' },
    'diff': { t: '자동계산과 다름', c: 'bad' },
    'diff-person': { t: '사람이 정한 값과 다름', c: 'warn' },
    'same': { t: '지금 값과 같음', c: 'ok' }
  };

  function renderHipass(lo, hi, nTrips) {
    if (lo) {
      $('hpSub').innerHTML = '영수증 기간 <b>' + md(lo + 864e5) + ' ~ ' + md(hi - 864e5) +
        '</b> 의 운행 ' + nTrips + '건과 대조했습니다 · 위 마감분 선택과 무관하게 맞춥니다';
    }
    var k = { read: 0, hit: 0, same: 0, diff: 0, person: 0, neu: 0, miss: 0 };
    GROUPS.forEach(function (g) {
      k.read += g.records.length; k.miss += g.unmatched.length;
      g.matched.forEach(function (e) {
        k.hit += e.lines.length;
        if (e.kind === 'same') k.same++;
        else if (e.kind === 'diff') k.diff++;
        else if (e.kind === 'diff-person') k.person++;
        else k.neu++;
      });
    });
    $('hRead').innerHTML = k.read + '<small>건</small>';
    $('hHit').innerHTML = k.hit + '<small>건</small>';
    $('hSame').innerHTML = k.same + '<small>건</small>';
    $('hDiff').innerHTML = k.diff + '<small>건</small>';
    $('hPerson').innerHTML = k.person + '<small>건</small>';
    $('hNew').innerHTML = k.neu + '<small>건</small>';
    $('hMiss').innerHTML = k.miss + '<small>건</small>';
    $('hpKpis').style.display = 'flex';

    $('hpGroups').innerHTML = GROUPS.map(function (g, gi) {
      var opts = g.candidates.map(function (p) {
        return '<option value="' + esc(p) + '"' + (p === g.plate ? ' selected' : '') + '>' + esc(p) + '</option>';
      }).join('');
      var vote = g.vote.length
        ? g.vote.slice(0, 2).map(function (v) { return esc(v.plate) + ' ' + v.n + '표'; }).join(' · ')
        : '맞는 운행이 없습니다';

      var items = g.matched.map(function (e, ii) {
        var L = KIND_LABEL[e.kind] || KIND_LABEL.same;
        var money = e.kind === 'new'
          ? '<b class="new">' + won(e.sum) + '원</b>'
          : e.kind === 'same'
            ? '<span>' + won(e.sum) + '원</span>'
            : '<span class="old">' + won(e.trip.toll_cost) + '</span> → <b class="new">' + won(e.sum) +
              '원</b> <span class="dl">' + (e.diff > 0 ? '+' : '') + won(e.diff) + '</span>';
        var lines = e.lines.map(function (r) {
          return '<span>' + esc(r.atText.slice(5)) + ' · ' + won(r.amount) + '원 · ' + esc(r.office) + '</span>';
        }).join('');
        var warn = e.kind === 'diff-person'
          ? '<div class="pwarn">이 금액은 <b>사람이 직접 정한 값</b>입니다(' + esc(e.trip.toll_source || '') +
            '). 영수증으로 바꾸시려면 직접 체크해 주세요.</div>' : '';
        return '<label class="item ' + e.kind + '">' +
          '<input type="checkbox" data-g="' + gi + '" data-i="' + ii + '"' + (e.pick ? ' checked' : '') + '>' +
          '<span class="body"><span class="hd">' +
            '<span class="d">' + md(e.trip.start_time) + ' ' + hhmm(e.trip.start_time) + '~' +
              (e.trip.end_time ? hhmm(e.trip.end_time) : '') + '</span>' +
            '<span class="pill ' + L.c + '">' + L.t + '</span>' +
            '<span class="money">' + money + '</span></span>' +
            '<span class="lines">' + lines + '</span>' + warn +
          '</span></label>';
      }).join('');

      var miss = g.unmatched.length
        ? '<div class="item"><span class="body"><span class="hd">' +
          '<span class="d" style="color:var(--warn)">붙일 운행이 없는 영수증 ' + g.unmatched.length + '건</span>' +
          '<span class="pill warn">일지 누락이거나 다른 차량 카드</span></span><span class="lines">' +
          g.unmatched.slice(0, 10).map(function (r) {
            return '<span>' + esc(r.atText.slice(5)) + ' · ' + won(r.amount) + '원 · ' + esc(r.office) + '</span>';
          }).join('') +
          (g.unmatched.length > 10 ? '<span>외 ' + (g.unmatched.length - 10) + '건</span>' : '') +
          '</span></span></div>' : '';

      return '<div class="grp"><div class="gh">' +
        '<span class="t">카드 ****' + esc(g.card4) + '</span>' +
        '<span class="pill mute">' + g.records.length + '건</span>' +
        '<span class="vote">' + vote + '</span><span class="sp"></span>' +
        '<span class="lbl">차량</span><select class="f" data-plate="' + gi + '">' + opts + '</select>' +
        '</div>' +
        (items || '<div class="item"><span class="body mut">이 차량으로는 맞는 운행이 없습니다. 위에서 차량을 바꿔 보세요.</span></div>') +
        miss + '</div>';
    }).join('') + (GROUPS.length ? bar() : '');
    bindHp();
  }
  function bar() {
    return '<div class="applybar">' +
      '<button class="btn sm" id="hpAll">전부 선택</button>' +
      '<button class="btn sm" id="hpNone">전부 해제</button>' +
      '<span class="sp"></span><span id="hpCount" class="mut"></span>' +
      '<button class="btn pri" id="hpApply">선택한 것 반영</button></div>';
  }
  function bindHp() {
    Array.prototype.forEach.call($('hpGroups').querySelectorAll('select[data-plate]'), function (sel) {
      sel.addEventListener('change', function () {
        var g = GROUPS[+sel.dataset.plate];
        g.plate = sel.value;
        Hipass.assign(g, HP_TRIPS.length ? HP_TRIPS : TRIPS);
        renderHipass();
      });
    });
    $('hpGroups').addEventListener('change', function (e) {
      var c = e.target.closest('input[type=checkbox]'); if (!c) return;
      GROUPS[+c.dataset.g].matched[+c.dataset.i].pick = c.checked;
      count();
    });
    var a = $('hpAll'), n = $('hpNone'), p = $('hpApply');
    if (a) a.addEventListener('click', function () { setAll(true); });
    if (n) n.addEventListener('click', function () { setAll(false); });
    if (p) p.addEventListener('click', applyHp);
    count();
  }
  function setAll(v) {
    GROUPS.forEach(function (g) { g.matched.forEach(function (e) { e.pick = v; }); });
    Array.prototype.forEach.call($('hpGroups').querySelectorAll('input[type=checkbox]'),
      function (c) { c.checked = v; });
    count();
  }
  function picked() {
    var out = [];
    GROUPS.forEach(function (g) {
      g.matched.forEach(function (e) {
        if (!e.pick) return;
        out.push({
          id: e.trip.id, amount: e.sum,
          note: '카드 ****' + g.card4 + ' · ' + g.plate,
          lines: e.lines.map(function (r) {
            return { at: r.atText, amount: r.amount, office: r.office, entry: r.entryOffice };
          })
        });
      });
    });
    return out;
  }
  function count() {
    var n = picked().length, c = $('hpCount'), b = $('hpApply');
    if (c) c.textContent = n ? n + '건 선택됨' : '선택된 것이 없습니다';
    if (b) b.disabled = !n;
  }
  function applyHp() {
    var items = picked(); if (!items.length) return;
    var b = $('hpApply'); b.disabled = true; b.innerHTML = '<span class="spin"></span> 반영 중…';
    apiRetry('/functions/v1/toll-apply', { method: 'POST', body: JSON.stringify({ items: items, batch: BATCH }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        b.disabled = false; b.textContent = '선택한 것 반영';
        if (!res.ok || !res.j || !res.j.ok) {
          $('hpResult').innerHTML = '<div class="res bad">' + esc((res.j && res.j.error) || '반영에 실패했습니다') + '</div>';
          return;
        }
        var msg = res.j.applied + '건을 반영했습니다.';
        if (res.j.skipped && res.j.skipped.length) msg += ' 건너뛴 것 ' + res.j.skipped.length + '건.';
        if (res.j.warning) msg += ' ⚠ ' + res.j.warning;
        $('hpResult').innerHTML = '<div class="res' + (res.j.warning ? ' bad' : '') + '">' + esc(msg) + '</div>';
        GROUPS = []; $('hpGroups').innerHTML = ''; $('hpKpis').style.display = 'none';
        toast(msg, !!res.j.warning);
        load();
      }).catch(function () {
        b.disabled = false; b.textContent = '선택한 것 반영';
        $('hpResult').innerHTML = '<div class="res bad">서버에 연결하지 못했습니다.</div>';
      });
  }

  /* ═══════════════ ④ 정산 ═══════════════ */
  function renderSettle() {
    var by = {};
    TRIPS.forEach(function (t) {
      if (!isBiz(t)) return;                    // 비업무용은 비용에서 뺀다
      var u = by[t.username] = by[t.username] || { n: 0, km: 0, toll: 0, park: 0, unk: 0 };
      u.n++; u.km += Number(t.distance_km || 0);
      if (t.toll_cost != null) u.toll += Number(t.toll_cost);
      if (t.parking_cost != null) u.park += Number(t.parking_cost);
      if (isUnknownToll(t)) u.unk++;
    });
    var keys = Object.keys(by).sort(function (a, b) { return by[b].km - by[a].km; });
    var T = { n: 0, km: 0, toll: 0, park: 0, unk: 0 };
    keys.forEach(function (k) {
      T.n += by[k].n; T.km += by[k].km; T.toll += by[k].toll; T.park += by[k].park; T.unk += by[k].unk;
    });
    $('sLabel').textContent = CYC.label + ' · 업무용 운행만';
    $('sRows').innerHTML = keys.length ? keys.map(function (k) {
      var u = by[k];
      return '<tr><td>' + esc(k) + '</td>' +
        '<td class="num">' + u.n + '</td>' +
        '<td class="num">' + Math.round(u.km).toLocaleString('ko-KR') + 'km</td>' +
        '<td class="num">' + won(u.toll) + '</td>' +
        '<td class="num">' + won(u.park) + '</td>' +
        '<td class="num"><b>' + won(u.toll + u.park) + '</b></td>' +
        '<td class="num">' + (u.unk ? '<span class="pill bad">' + u.unk + '</span>' : '—') + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty">업무용 운행이 없습니다</td></tr>';
    $('sFoot').innerHTML = keys.length
      ? '<tr><td><b>합계</b></td><td class="num"><b>' + T.n + '</b></td>' +
        '<td class="num"><b>' + Math.round(T.km).toLocaleString('ko-KR') + 'km</b></td>' +
        '<td class="num"><b>' + won(T.toll) + '</b></td><td class="num"><b>' + won(T.park) + '</b></td>' +
        '<td class="num"><b>' + won(T.toll + T.park) + '</b></td>' +
        '<td class="num">' + (T.unk ? '<b class="bad">' + T.unk + '</b>' : '—') + '</td></tr>' : '';
    $('sNote').style.display = T.unk ? 'block' : 'none';
    $('sNoteN').textContent = T.unk;

    // CSV 내려받기
    $('sCsv').onclick = function () {
      var rows = [['오너드라이버', '운행', '주행거리(km)', '통행료', '주차비', '합계', '통행료 미확정']];
      keys.forEach(function (k) {
        var u = by[k];
        rows.push([k, u.n, Math.round(u.km), u.toll, u.park, u.toll + u.park, u.unk]);
      });
      var csv = '﻿' + rows.map(function (r) { return r.join(','); }).join('\r\n');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = 'ATEC_정산_' + $('fCycle').value + '.csv';
      a.click(); URL.revokeObjectURL(a.href);
    };
  }

  /* 새로고침해도 세션이 남아 있으면 바로 들어간다 */
  if (ss(K_AT) && me()) enter();
})();
