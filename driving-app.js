/* ═══════════════════════════════════════════════════════════════════════════
   ATEC 운행일지 — 웹
   ---------------------------------------------------------------------------
   ★ 원칙
     1) 돈에 관한 계산은 서버(supabase/functions/monthly-report/index.ts)를 한 줄씩
        대조해서 옮긴다. 옮긴 자리마다 서버 몇 행인지 적는다. 한쪽을 고치면 둘 다 고친다.
     2) 쓰기는 전부 Edge Function 을 거친다. 웹에는 trips UPDATE 권한이 없다.
     3) 읽기는 RLS 가 가른다. 화면에서 다시 거르지 않는다 —
        서버가 준 것이 곧 이 사람이 볼 수 있는 것이다.
   ═══════════════════════════════════════════════════════════════════════════ */
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
      if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v);
    } catch (e) { return null; }
  }
  function me() { try { return JSON.parse(ss(K_ME) || 'null'); } catch (e) { return null; } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ic(name, size) { return '<svg width="' + (size || 16) + '" height="' + (size || 16) + '" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
  function n0(n) { return n == null ? '—' : Math.round(Number(n)).toLocaleString('ko-KR'); }
  function won(n) { return n == null ? '—' : '₩' + Math.round(Number(n)).toLocaleString('ko-KR'); }
  function km(n) { return n == null ? '—' : (Math.round(Number(n) * 10) / 10).toLocaleString('ko-KR'); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function kd(ms) { return new Date(Number(ms) + KST); }
  function md(ms) { var d = kd(ms); return pad(d.getUTCMonth() + 1) + '.' + pad(d.getUTCDate()); }
  function hm(ms) { var d = kd(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
  function ymd(ms) { var d = kd(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function initials(name) {
    var s = String(name || '').trim();
    return s ? (s.length <= 2 ? s : s.slice(-2)) : '—';
  }

  function toast(msg, bad) {
    var t = $('toast'); t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    // 경고가 붙은 긴 문장은 읽을 시간을 더 준다.
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = ''; }, msg.length > 40 ? 6000 : 3400);
  }
  /** 성공했는데 경고가 딸린 경우 — 성공을 먼저 말하고 경고를 잇는다.
   *  예전에는 빨간 경고만 떠서 "상신이 실패했나?" 로 읽혔다. */
  function toastOk(msg, warning) {
    toast(warning ? msg + ' — ' + warning : msg, !!warning);
  }

  /* ══════════════════ 통신 ══════════════════ */
  function api(path, opt) {
    opt = opt || {};
    var h = opt.headers || {};
    h.apikey = KEY;
    h.Authorization = 'Bearer ' + (ss(K_AT) || KEY);
    if (opt.body && !h['Content-Type']) h['Content-Type'] = 'application/json';
    opt.headers = h;
    return fetch(SB + path, opt);
  }
  /** 401/403 이면 토큰을 한 번 갱신하고 다시 시도한다. */
  function apiRetry(path, opt) {
    return api(path, opt).then(function (r) {
      if (r.status !== 401 && r.status !== 403) return r;
      var rt = ss(K_RT);
      if (!rt) return r;
      return fetch(SB + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt })
      }).then(function (rr) { return rr.ok ? rr.json() : null; })
        .then(function (j) {
          if (!j || !j.access_token) return r;
          ss(K_AT, j.access_token); ss(K_RT, j.refresh_token || rt);
          return api(path, opt);
        }).catch(function () { return r; });
    });
  }
  /** 1000행씩 끊어 전부 가져온다. PostgREST 기본 상한이 1000이라 반드시 페이지를 돈다. */
  /** 세션이 끊겼다는 표시. 빈 배열과 구별해야 "0건"을 정상으로 보여 주지 않는다. */
  function AuthGone() { this.authGone = true; }
  function fetchAll(path) {
    var acc = [];
    function page(off) {
      return apiRetry(path + (path.indexOf('?') < 0 ? '?' : '&') + 'offset=' + off + '&limit=1000')
        .then(function (r) {
          // ★ 401/403 을 []로 바꾸면 본인 기록이 사라진 것처럼 보인다.
          //   갱신까지 실패한 것이므로 로그인 화면으로 돌려보내야 한다.
          if (r.status === 401 || r.status === 403) throw new AuthGone();
          return r.ok ? r.json() : [];
        })
        .then(function (a) {
          if (!Array.isArray(a)) return acc;
          acc = acc.concat(a);
          if (a.length < 1000 || off > 40000) return acc;
          return page(off + 1000);
        });
    }
    return page(0);
  }

  /* ══════════════════ 마감주기 ══════════════════
     서버 index.ts 226~229행:
       const m = k.getUTCMonth();                  // ★ 0-based
       startMs = Date.UTC(y, m - 1, 21) - KST;     // 전월 21일
       endMs   = Date.UTC(y, m,     21) - KST;     // 당월 21일(배타)
     여기서 m 은 1-based('9월분')이므로 한 칸씩 더 뺀다.
     ★ 처음에 이 한 칸을 빠뜨려 마감주기가 통째로 한 달 밀렸다(09.21~10.20).
       '9월분' = 08.21 ~ 09.20 이다. 여기가 틀리면 모든 숫자가 틀어진다.     */
  function cycleRange(y, m) {
    return {
      lo: Date.UTC(y, m - 2, 21, 0, 0, 0) - KST,
      hi: Date.UTC(y, m - 1, 21, 0, 0, 0) - KST
    };
  }
  function cycleSpan(y, m) {
    var r = cycleRange(y, m), s = kd(r.lo), e = kd(r.hi - 1);
    return pad(s.getUTCMonth() + 1) + '.' + pad(s.getUTCDate()) + ' – ' +
      pad(e.getUTCMonth() + 1) + '.' + pad(e.getUTCDate());
  }
  function cycleName(y, m) { return y + '년 ' + m + '월분'; }
  /** 오늘이 속한 마감주기. 21일 이전이면 이번 달분, 21일부터는 다음 달분. */
  function currentCycle() {
    var d = kd(Date.now()), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    if (d.getUTCDate() >= 21) { m += 1; if (m > 12) { m = 1; y += 1; } }
    return { y: y, m: m };
  }

  /* ══════════════════ 분기·지역·유류단가 ══════════════════
     서버 index.ts 47~66행(region) · 107~119행(quarterOf) 을 그대로 옮긴 것.
     ★ 예전에 눈대중으로 옮겨 3분기를 2분기로 계산한 적이 있다(194원 vs 191원).
       반드시 app_config.quarter_bounds 를 읽어서 쓴다. 상수를 박지 않는다.  */
  var QBOUNDS = [[3, 21], [6, 21], [9, 21], [12, 21]];   // 서버 index.ts 72행과 동일
  function setQuarterBounds(csv) {
    // ★ 반드시 기본값으로 되돌린 뒤 적용한다(서버 index.ts 60~61행과 동일).
    //   안 되돌리면 주기를 바꿔 다시 읽었을 때 앞의 경계가 남아 금액이 갈린다.
    QBOUNDS = [[3, 21], [6, 21], [9, 21], [12, 21]];
    if (!csv) return;
    try {
      var parts = String(csv).split(',');
      if (parts.length !== 4) return;
      var out = parts.map(function (p) {
        var mm = p.trim().split('-');
        if (mm.length !== 2 || !/^\d{1,2}$/.test(mm[0]) || !/^\d{1,2}$/.test(mm[1])) throw 0;
        var a = +mm[0], b = +mm[1];
        if (a < 1 || a > 12 || b < 1 || b > 31) throw 0;
        return [a, b];
      });
      for (var i = 1; i < 4; i++) {
        var cur = out[i][0] * 100 + out[i][1], prev = out[i - 1][0] * 100 + out[i - 1][1];
        if (i === 3 ? cur < prev : cur <= prev) throw 0;
      }
      QBOUNDS = out;
    } catch (e) { /* 형식 오류 — 기본값 유지 (서버와 같은 태도) */ }
  }
  function quarterOf(ms) {
    var d = kd(ms), y = d.getUTCFullYear();
    var v = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    var b = QBOUNDS, f = function (p) { return p[0] * 100 + p[1]; };
    if (v < f(b[0])) return { y: y, q: 1 };
    if (v < f(b[1])) return { y: y, q: 2 };
    if (v < f(b[2])) return { y: y, q: 3 };
    return { y: y, q: 4 };   // 4분기 = 시작일~12/31. 다음해로 안 넘긴다.
  }
  var OTHER_SIDO = ['부산', '대구', '광주', '대전', '울산', '세종', '강원', '충청', '충북', '충남',
    '전라', '전북', '전남', '경상', '경북', '경남', '제주'];
  function region(addr, lat, lng) {
    var a = String(addr || '').replace(/^\s+/, '');
    if (a.indexOf('대한민국') === 0) a = a.slice(4).replace(/^\s+/, '');
    if (a.indexOf('서울') === 0 || a.indexOf('경기') === 0 || a.indexOf('인천') === 0) return '수도권';
    for (var i = 0; i < OTHER_SIDO.length; i++) if (a.indexOf(OTHER_SIDO[i]) === 0) return '지방';
    lat = Number(lat) || 0; lng = Number(lng) || 0;
    // ★ 경도 상한 127.5 — 앱(FuelRegion.kt · Models.swift)·서버와 같은 값이어야 한다.
    //   강원 영서(춘천 ~127.7 · 원주 ~127.9)가 수도권으로 잡히던 것을 좁힌 값이다.
    if (lat !== 0 && lng !== 0 && lat >= 37.0 && lat <= 38.3 && lng >= 126.0 && lng <= 127.5) return '수도권';
    return '지방';
  }
  var BUSINESS = '일반업무';   // 서버 index.ts 25행. 비용 정산 대상은 이것뿐이다.
  var RATES = {}, RATE_MISS = {};
  /** 단가가 등록 안 됐을 때 쓰는 기본 단가. 서버 index.ts 24행(FUEL_DEFAULT)과 같아야 한다.
   *  여기만 0 이면 웹은 0원, 월간리포트는 159원이 되어 같은 달 금액이 갈린다. */
  var FUEL_DEFAULT = 159;
  function fuelRate(addr, ms, lat, lng) {
    var qq = quarterOf(ms);
    var key = qq.y + '-' + qq.q + '-' + region(addr, lat, lng);
    var v = RATES[key];
    if (v == null) { RATE_MISS[key] = (RATE_MISS[key] || 0) + 1; return FUEL_DEFAULT; }
    return v;
  }
  /** 서버 index.ts 388~394행: 반올림한 도착계기 − 반올림한 출발계기, 음수면 0.
      소수 그대로 빼면 표의 계기판과 금액이 어긋난다 — 그래서 반올림이 먼저다. */
  function odoKm(t) {
    return Math.max(0, Math.round(Number(t.end_odometer) || 0) - Math.round(Number(t.start_odometer) || 0));
  }
  function tripFuel(t) {
    if ((t.purpose || '') !== BUSINESS) return 0;
    return odoKm(t) * fuelRate(t.start_address || '', Number(t.start_time), t.start_lat, t.start_lng);
  }

  /* ══════════════════ 상태 ══════════════════ */
  var ME = null, VIEW = 'close', CYC = currentCycle();
  // ALL_* = 서버(RLS)가 내려준 전부. 일반 직원이면 어차피 본인 것뿐이다.
  // TRIPS·EVID = 지금 열려 있는 화면이 쓰는 범위. applyScope() 가 채운다.
  var ALL_TRIPS = [], ALL_EVID = [];
  var TRIPS = [], USERS = {}, VEHICLES = [], EVID = [], EDUV = [], EDUP = [], EDUT = [];
  var APPR = [], LINES = {}, PEOPLE = {};   // 결재 건 · 부서별 기본 결재선 · 사람 목록(이름·부서·직급)
  var LOADED = false, LOADING = false, AUDIT = null;
  var LOAD_SEQ = 0;      // 늦게 도착한 응답을 버리기 위한 표
  /** driving-account 가 알려 주는 것 — 권한 관리를 할 수 있는 계정인가.
   *  마스터 계정 이름을 웹에 적어 두지 않으려고 서버에 물어본다. */
  var ACCT = { can_manage_admin: false };
  var LOAD_ERR = '';     // 적재 실패 사유(스켈레톤에 갇히지 않게 화면에 남긴다)
  var FILT = { chip: 'all', who: '', car: '', q: '' };
  /**
   * 인쇄에 담을 운행목적. 앱 내보내기 창과 같다 — 기본은 '업무만'.
   * 앱 MainScreen.kt 366~369행: expBiz=true, expCom=false, expPer=false.
   * 같은 화면에 "차량일지 제출 시에는 '업무' 운행내역만 선택하세요" 안내가 있다.
   */
  var PRINT_PURPOSES = ['일반업무'];
  var DRAFT = null;                   // 상신 창에서 편집 중인 결재선

  /* ══════════════════ 로그인 ══════════════════ */
  function loginErr(msg) {
    $('lmsgT').textContent = msg; $('lmsg').hidden = false;
  }
  function doLogin() {
    var b = $('loginBtn');
    var u = $('u').value.trim(), p = $('p').value;
    if (!u || !p) { loginErr('아이디와 비밀번호를 입력해 주세요.'); return; }
    b.disabled = true; b.textContent = '확인하는 중…'; $('lmsg').hidden = true;
    fetch(SB + '/functions/v1/driving-auth', {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        b.disabled = false; b.textContent = '로그인';
        if (!res.ok || !res.j || !res.j.ok) { loginErr((res.j && res.j.error) || '로그인에 실패했습니다.'); return; }
        ss(K_AT, res.j.access_token); ss(K_RT, res.j.refresh_token);
        ss(K_ME, JSON.stringify(res.j.profile));
        $('p').value = '';
        enter();
      }).catch(function () {
        b.disabled = false; b.textContent = '로그인';
        loginErr('서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      });
  }

  /** 저장된 프로필은 로그인 시점의 사본이다. 권한이 바뀌었을 수 있으니 매번 다시 읽는다. */
  /** 지금 토큰의 사용자 id(JWT sub). 서명을 검증하는 게 아니라 조회 조건에만 쓴다. */
  function myUid() {
    try {
      var t = ss(K_AT) || '';
      var p = t.split('.')[1];
      if (!p) return '';
      var s = decodeURIComponent(escape(atob(p.replace(/-/g, '+').replace(/_/g, '/'))));
      return JSON.parse(s).sub || '';
    } catch (e) { return ''; }
  }
  function syncProfile() {
    // ★ 필터 없이 첫 행을 읽으면, 여러 profiles 행이 보이는 계정에서 남의 권한과
    //   이름을 내 것으로 덮어쓴다. 반드시 내 id 로 못 박는다.
    var uid = myUid();
    if (!uid) return Promise.resolve();
    return apiRetry('/rest/v1/profiles?select=perms,status,name&id=eq.' + encodeURIComponent(uid) + '&limit=1')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        var p = rows && rows[0], m = me();
        if (!p || !m) return;
        m.perms = Array.isArray(p.perms) ? p.perms : [];
        m.is_admin = m.perms.indexOf('driving_admin') >= 0;
        if (p.name) m.name = p.name;
        ss(K_ME, JSON.stringify(m));
      }).catch(function () { });
  }

  function enter() {
    if (!me()) return;
    $('login').style.display = 'none';
    $('app').style.display = 'block';
    buildCycleSelect();
    // 권한 관리 메뉴를 보일지 서버에 물어본다. 실패해도 화면은 정상 동작한다.
    api('/functions/v1/driving-account', { method: 'POST', body: JSON.stringify({ action: 'whoami' }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (a) {
        if (a && a.ok) {
          ACCT = a;
          document.body.classList.toggle('is-master', !!a.can_manage_admin);
          if (LOADED) render();
        }
      }).catch(function () { });
    syncProfile().then(function () {
      ME = me();
      var nm = ME.name || ME.username || '';
      $('uName').textContent = nm;
      $('uAv').textContent = initials(nm);
      $('uAv').className = 'uav' + (ME.is_admin ? ' is-admin-av' : '');
      $('uMeta').textContent = [ME.dept, ME.position].filter(Boolean).join(' · ') || (ME.is_admin ? '관리자' : '');
      document.body.classList.toggle('is-admin', !!ME.is_admin);
      loadAll();
    });
  }

  function buildCycleSelect() {
    var c = currentCycle(), sel = $('selCycle'), out = '';
    for (var i = 0; i < 13; i++) {
      var y = c.y, m = c.m - i;
      while (m <= 0) { m += 12; y -= 1; }
      out += '<option value="' + y + '-' + m + '">' + cycleName(y, m) + ' (' + cycleSpan(y, m) + ')</option>';
    }
    sel.innerHTML = out;
    sel.value = CYC.y + '-' + CYC.m;
    paintCycle();
  }
  function paintCycle() {
    // 연도는 .yr 로 감싼다 — 좁은 화면에서 접어 한 줄을 지키기 위해서다.
    $('cycleTxt').innerHTML = '<span class="yr">' + CYC.y + '년 </span>' + CYC.m + '월분';
    $('cycleTag').textContent = cycleSpan(CYC.y, CYC.m);
  }

  /* ══════════════════ 데이터 적재 ══════════════════ */
  function loadAll() {
    // ★ 예전에는 로딩 중이면 그냥 돌아갔다. 주기를 빠르게 두 번 바꾸면 두 번째
    //   요청이 버려져 옛 주기 데이터가 새 주기 이름으로 그려졌다. 이제는 표를
    //   달아 두고, 늦게 도착한 응답을 버린다.
    var seq = ++LOAD_SEQ;
    LOADING = true; LOADED = false; AUDIT = null; LOAD_ERR = '';
    render();
    // 주기가 바뀌면 필터·하이패스 대조 결과는 의미가 없다. 같이 비운다.
    //   (필터는 남는데 셀렉트는 '전체'로 보여 "왜 표가 비었는지" 알 수 없었다.
    //    하이패스는 옛 주기 운행 객체를 가리킨 채 남아 반영 결과가 안 보였다.)
    FILT.who = ''; FILT.car = ''; FILT.q = ''; FILT.chip = 'all';
    HP = { groups: [], batch: '', busy: false, note: '' };
    var r = cycleRange(CYC.y, CYC.m);
    var COLS = 'id,username,plate_no,start_time,end_time,distance_km,purpose,' +
      'start_address,end_address,visit_place,start_odometer,end_odometer,start_lat,start_lng,' +
      'toll_cost,toll_status,toll_source,toll_revision,parking_cost,is_manual,' +
      'overspeed_count,rapid_accel_count,rapid_decel_count,max_speed_kmh,' +
      // ★ 이 셋이 빠지면 점수가 실제보다 높게 나온다(앱 SafetyScore 와 갈린다).
      'school_zone_overspeed_count,sustained_overspeed_count,harsh_corner_count';

    Promise.all([
      fetchAll('/rest/v1/trips?select=' + COLS + '&deleted_at=is.null' +
        '&start_time=gte.' + r.lo + '&start_time=lt.' + r.hi + '&order=start_time.desc'),
      fetchAll('/rest/v1/app_users?select=username,name,dept,position,is_admin,plate_no,company_name,vehicle_type'),
      fetchAll('/rest/v1/app_vehicles?select=*'),
      fetchAll('/rest/v1/evidences?select=id,username,vehicle_plate,date_millis,category,amount,memo,photo_path'),
      fetchAll('/rest/v1/edu_videos?deleted=eq.false&select=*&order=month.desc,id.asc'),
      fetchAll('/rest/v1/edu_progress?select=*'),
      fetchAll('/rest/v1/edu_targets?select=*'),
      fetchAll('/rest/v1/fuel_rates?select=year,quarter,region,price'),
      apiRetry('/rest/v1/app_config?id=eq.1&select=quarter_bounds').then(function (x) { return x.ok ? x.json() : []; }),
      // RLS 가 걸러 준다 — 본인 것 · 내가 결재자인 것 · 관리자는 전부.
      fetchAll('/rest/v1/driving_approvals?select=*&order=submitted_at.desc'),
      fetchAll('/rest/v1/driving_approval_lines?select=*'),
      // 결재자를 고르려면 사람 목록이 필요하다. app_users 는 본인만 보이므로 뷰를 쓴다.
      fetchAll('/rest/v1/v_driving_people?select=*&order=name.asc')
    ]).then(function (out) {
      // ★ 반드시 아무것도 대입하기 전에 버린다. 예전에는 아래 대입이 전부 끝난 뒤에
      //   가드가 있어서, 늦게 온 응답이 데이터는 덮어쓰고 다시 그리기만 건너뛰었다.
      //   그러면 머리띠는 8월분인데 숫자는 9월분인 화면이 된다(21일 마감에 서버가
      //   느려질 때 정확히 터지는 조건).
      if (seq !== LOAD_SEQ) return;
      ALL_TRIPS = out[0] || [];
      USERS = {}; (out[1] || []).forEach(function (u) { USERS[u.username] = u; });
      VEHICLES = out[2] || [];
      ALL_EVID = out[3] || [];
      EDUV = out[4] || []; EDUP = out[5] || []; EDUT = out[6] || [];
      RATES = {}; RATE_MISS = {};
      (out[7] || []).forEach(function (x) { RATES[x.year + '-' + x.quarter + '-' + x.region] = Number(x.price); });
      var cfg = (out[8] || [])[0];
      if (cfg) setQuarterBounds(cfg.quarter_bounds);
      APPR = out[9] || [];
      LINES = {}; (out[10] || []).forEach(function (l) { LINES[l.dept] = l; });
      PEOPLE = {}; (out[11] || []).forEach(function (p) { PEOPLE[p.username] = p; });
      LOADED = true; LOADING = false; AUDIT = null;
      applyScope();
      paintPills();
      render();
    }).catch(function (e) {
      if (seq !== LOAD_SEQ) return;
      LOADING = false;
      if (e && e.authGone) {
        toast('로그인이 만료되었습니다. 다시 로그인해 주세요.', true);
        setTimeout(signOut, 900);
        return;
      }
      // 스켈레톤에 갇히지 않게 다시 그린다 — 다시 시도할 수단도 화면에 남긴다.
      LOAD_ERR = '데이터를 불러오지 못했습니다.';
      render();
      toast(LOAD_ERR, true);
      console.error(e);
    });
  }

  /* ══════════════════ 점검 ══════════════════
     "AI 검사" 같은 마법이 아니다. 실제로 사고가 났던 유형만 넣는다.
     2026-09 감사에서 잡힌 것: 계기판 대역 도약(양준범 175,500km),
     차량 혼선(김규태·김은수 18건), 통행료 미확정, 0km 운행.            */
  function isUnknownToll(t) {
    return t.toll_cost == null || t.toll_status === 'UNKNOWN' || t.toll_status === 'PENDING';
  }
  /** 지금 화면 범위의 점검 결과(캐시). 화면이 바뀌면 go() 가 캐시를 비운다. */
  function audit() {
    if (AUDIT) return AUDIT;
    AUDIT = auditOf(TRIPS);
    return AUDIT;
  }
  /** 임의의 운행 목록을 점검한다. 뱃지는 화면 범위와 무관하게 '내 것'으로 세야 한다. */
  function auditOf(LIST) {
    var byPerson = {};
    LIST.forEach(function (t) { (byPerson[t.username] = byPerson[t.username] || []).push(t); });

    // ① 계기판 도약 — 같은 사람·같은 차에서 1,000km 이상 튀는 지점
    var jump = [];
    Object.keys(byPerson).forEach(function (u) {
      var byCar = {};
      byPerson[u].forEach(function (t) { (byCar[t.plate_no] = byCar[t.plate_no] || []).push(t); });
      Object.keys(byCar).forEach(function (pl) {
        var rows = byCar[pl].slice().sort(function (a, b) { return a.start_time - b.start_time; });
        var prev = null;
        rows.forEach(function (t) {
          if (prev != null && t.start_odometer != null &&
            Math.abs(Number(t.start_odometer) - prev) >= 1000) jump.push(t);
          if (t.end_odometer != null) prev = Number(t.end_odometer);
        });
      });
    });

    // ② 차량 혼선 — 한 번호판을 두 사람 이상이 쓰는 경우
    var byCarAll = {};
    LIST.forEach(function (t) { (byCarAll[t.plate_no] = byCarAll[t.plate_no] || {})[t.username] = 1; });
    var shared = Object.keys(byCarAll).filter(function (p) { return Object.keys(byCarAll[p]).length > 1; });
    var sharedRows = LIST.filter(function (t) { return shared.indexOf(t.plate_no) >= 0; });

    // ③ 통행료 미확정 (업무용만 — 정산 대상)
    var unk = LIST.filter(function (t) { return (t.purpose || '') === BUSINESS && isUnknownToll(t); });

    // ④ 0km 운행
    var zero = LIST.filter(function (t) { return (Number(t.distance_km) || 0) <= 0; });

    // ⑤ 시간이 겹치는 운행 (같은 사람, 자동기록끼리)
    var overlap = [];
    Object.keys(byPerson).forEach(function (u) {
      var rows = byPerson[u].filter(function (t) { return !t.is_manual && t.end_time; })
        .sort(function (a, b) { return a.start_time - b.start_time; });
      for (var i = 1; i < rows.length; i++) {
        if (Number(rows[i].start_time) < Number(rows[i - 1].end_time)) overlap.push(rows[i]);
      }
    });

    // ⑥ 운행목적 미선택 — 비용 집계에서 통째로 빠진다
    var nopurp = LIST.filter(function (t) {
      var p = t.purpose || '';
      return p !== BUSINESS && p !== '출퇴근' && p !== '비업무용';
    });

    // ⑦ 유류단가 미등록 — 금액이 0으로 새는 지점 (총액 계산 후에 채워진다)
    LIST.forEach(tripFuel);
    var missKeys = Object.keys(RATE_MISS);

    // ★ 전역 캐시(AUDIT)를 여기서 건드리지 않는다. 뱃지가 부를 때 관리 화면의
    //   점검 결과를 개인 것으로 덮어써 버린다. 결과를 돌려주기만 한다.
    return [
      { k: 'jump', sev: 'bad', ico: 'gauge', t: '계기판이 크게 튄 곳', rows: jump, n: jump.length,
        d: '같은 사람이 같은 차에서 1,000km 넘게 건너뛰었습니다. 차를 바꿨거나 숫자를 잘못 넣은 것입니다.' },
      { k: 'shared', sev: 'bad', ico: 'car', t: '한 차를 두 사람이 쓴 번호판', rows: sharedRows, n: shared.length,
        d: shared.length ? shared.join(' · ') + ' — 번호판을 잘못 고르면 남의 차 기록이 됩니다.' : '없습니다.' },
      { k: 'nopurp', sev: 'bad', ico: 'alert', t: '운행목적 미선택', rows: nopurp, n: nopurp.length,
        d: '목적이 비어 있으면 업무용으로 안 잡혀 비용 정산에서 통째로 빠집니다.' },
      { k: 'rate', sev: 'bad', ico: 'won', t: '유류단가 미등록', rows: [], n: missKeys.length,
        d: missKeys.length ? missKeys.join(' · ') + ' 단가가 없어 유류비가 0원으로 계산됩니다.' : '없습니다.' },
      { k: 'unk', sev: 'warn', ico: 'ticket', t: '통행료 미확정', rows: unk, n: unk.length,
        d: '정산에서 0원으로 잡혀 회사가 덜 내주게 됩니다. 하이패스 대조나 직접 입력으로 채워 주세요.' },
      { k: 'overlap', sev: 'warn', ico: 'list', t: '시간이 겹치는 운행', rows: overlap, n: overlap.length,
        d: '같은 사람이 같은 시간에 두 건을 기록했습니다.' },
      { k: 'zero', sev: 'warn', ico: 'list', t: '0km 운행', rows: zero, n: zero.length,
        d: '거리가 0인 기록입니다. 잘못 눌렀거나 바로 껐을 때 생깁니다.' }
    ];

  }
  function flaggedIds() {
    var s = {};
    audit().forEach(function (f) {
      if (f.sev !== 'bad') return;
      (f.rows || []).forEach(function (t) { s[t.id] = 1; });
    });
    return s;
  }

  /* ══════════════════ 집계 ══════════════════ */
  function totals(rows) {
    var o = { n: rows.length, km: 0, bizKm: 0, fuel: 0, toll: 0, park: 0, unk: 0, manual: 0 };
    rows.forEach(function (t) {
      var d = Number(t.distance_km) || 0;
      o.km += d;
      if (t.is_manual) o.manual++;
      if ((t.purpose || '') !== BUSINESS) return;
      o.bizKm += d;
      o.fuel += tripFuel(t);
      if (isUnknownToll(t)) o.unk++;
      o.toll += Number(t.toll_cost) || 0;
      o.park += Number(t.parking_cost) || 0;
    });
    o.cost = o.fuel + o.toll + o.park;
    return o;
  }

  /**
   * 메뉴 뱃지. **항상 본인 기준**이어야 한다 — 개인 메뉴에 붙은 숫자이기 때문이다.
   * 예전에는 현재 화면 범위(TRIPS·EVID)를 써서, 관리 화면에 있는 동안 저장하거나
   * 주기를 다시 고르면 전사 숫자가 박히고 개인 화면으로 돌아와도 안 돌아왔다.
   */
  function paintPills() {
    var mine = myName();
    var myTrips = ALL_TRIPS.filter(function (t) { return t.username === mine; });
    var A = auditOf(myTrips);
    var bad = A.filter(function (f) { return f.sev === 'bad'; }).reduce(function (s, f) { return s + f.n; }, 0);
    var warn = A.filter(function (f) { return f.sev === 'warn'; }).reduce(function (s, f) { return s + f.n; }, 0);
    var r = cycleRange(CYC.y, CYC.m);
    var myEvid = ALL_EVID.filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === mine && d >= r.lo && d < r.hi;
    });
    set('pTrips', myTrips.length, false);
    set('pCheck', bad || warn, bad > 0);
    set('pEvid', myEvid.length, false);
    set('pToll', myTrips.filter(function (t) {
      return isUnknownToll(t) && (t.purpose || '') === BUSINESS;
    }).length, false);
    set('pEdu', eduTodo(), eduTodo() > 0);
    set('pInbox', inbox().length, inbox().length > 0);
    function set(id, v, hot) {
      var el = $(id); if (!el) return;
      el.hidden = !v;
      el.textContent = v > 999 ? '999+' : n0(v);
      el.className = 'pill' + (hot ? ' hot' : '');
    }
  }
  function evidOfCycle() {
    var r = cycleRange(CYC.y, CYC.m);
    return EVID.filter(function (e) { var d = Number(e.date_millis); return d >= r.lo && d < r.hi; });
  }
  function eduMonthKey() {
    // 서버 index.ts 245행: 마감일이 속한 달 = 교육 회차 키. 보고 있는 주기를 따른다.
    return CYC.y + '-' + pad(CYC.m);
  }
  function myName() { return (ME && (ME.username || ME.app_username)) || ''; }
  function eduTodo() {
    if (!ME) return 0;
    var key = eduMonthKey(), mine = myName();
    // ★ 의무 대상(edu_targets)이 아니면 숫자를 띄우지 않는다. 예전에는 뱃지가
    //   빨갛게 뜨는데 들어가 보면 "의무 대상이 아닙니다" 라고만 적혀 있었다.
    var amTarget = EDUT.some(function (t) { return t.month === key && t.username === mine; });
    if (!amTarget) return 0;
    var vids = EDUV.filter(function (v) { return v.month === key; });
    if (!vids.length) return 0;
    var done = {};
    EDUP.forEach(function (p) { if (p.username === mine && p.completed_at) done[p.video_id] = 1; });
    return vids.filter(function (v) { return !done[v.id]; }).length;
  }

  /* ══════════════════ 안전운전 점수 ══════════════════
     앱 util/SafetyScore.kt 를 그대로 옮긴 것이다. 한쪽을 고치면 앱(Kotlin/Swift)도
     같이 고쳐야 한다 — 같은 사람의 점수가 앱과 웹에서 다르면 아무도 안 믿는다.

       과속 −3 · 보호구역 과속 −5 · 급가속 −3 · 급감속 −5 · 급회전 −3
       지속과속 −2/회(운행당 상한 −10)
       야간(KST 22~06시 출발)은 상한 적용 뒤 합계 ×1.5. 0~100 으로 자른다.

     ★ 수기 운행은 평가하지 않는다(2026-07-27 정책, AppRepository 1473행).
       GPS 기록이 없어 위반이 0으로 잡히고, 그대로 두면 점수가 부풀려진다. */
  var SAFE_GRADES = [[90, '안전', 'ok'], [80, '양호', 'ok'], [70, '주의', 'warn'], [0, '위험', 'bad']];

  function safeScore(t) {
    var z = function (v) { return Math.max(0, Number(v) || 0); };
    var sus = Math.min(z(t.sustained_overspeed_count) * 2, 10);
    var p = z(t.overspeed_count) * 3 + z(t.school_zone_overspeed_count) * 5 +
      z(t.rapid_accel_count) * 3 + z(t.rapid_decel_count) * 5 +
      z(t.harsh_corner_count) * 3 + sus;
    if (isNightTrip(t.start_time)) p = Math.round(p * 1.5);
    return Math.max(0, Math.min(100, 100 - p));
  }
  /** 야간 판정은 기기 시간대가 아니라 한국시간 고정 — 앱·서버와 같은 기준. */
  function isNightTrip(ms) { var h = kd(Number(ms)).getUTCHours(); return h >= 22 || h < 6; }
  /** 거리 가중 평균. 짧은 운행이 과대 반영되지 않게 한다(최소 1km). */
  function safeAvg(pairs) {
    if (!pairs.length) return -1;
    var a = 0, b = 0;
    pairs.forEach(function (x) { var w = Math.max(x[1], 1); a += x[0] * w; b += w; });
    return b > 0 ? Math.round(a / b) : 0;
  }
  function safeGrade(s) {
    for (var i = 0; i < SAFE_GRADES.length; i++) if (s >= SAFE_GRADES[i][0]) return SAFE_GRADES[i];
    return SAFE_GRADES[SAFE_GRADES.length - 1];
  }
  function safeEvents(t) {
    var z = function (v) { return Math.max(0, Number(v) || 0); };
    return z(t.overspeed_count) + z(t.school_zone_overspeed_count) + z(t.rapid_accel_count) +
      z(t.rapid_decel_count) + z(t.harsh_corner_count) + z(t.sustained_overspeed_count);
  }
  /** 그 사람의 이번 주기 안전 요약. 자동 기록만 본다. */
  function safeOf(list) {
    var auto = list.filter(function (t) { return !t.is_manual; });
    var pairs = auto.map(function (t) { return [safeScore(t), Number(t.distance_km) || 0]; });
    var o = {
      n: auto.length, manual: list.length - auto.length,
      km: auto.reduce(function (a, t) { return a + (Number(t.distance_km) || 0); }, 0),
      score: safeAvg(pairs), rows: auto,
      over: 0, school: 0, accel: 0, decel: 0, corner: 0, sustained: 0, maxSpeed: 0
    };
    auto.forEach(function (t) {
      o.over += Math.max(0, Number(t.overspeed_count) || 0);
      o.school += Math.max(0, Number(t.school_zone_overspeed_count) || 0);
      o.accel += Math.max(0, Number(t.rapid_accel_count) || 0);
      o.decel += Math.max(0, Number(t.rapid_decel_count) || 0);
      o.corner += Math.max(0, Number(t.harsh_corner_count) || 0);
      o.sustained += Math.max(0, Number(t.sustained_overspeed_count) || 0);
      o.maxSpeed = Math.max(o.maxSpeed, Number(t.max_speed_kmh) || 0);
    });
    o.events = o.over + o.school + o.accel + o.decel + o.corner + o.sustained;
    o.per100 = o.km >= 1 ? o.events / (o.km / 100) : o.events;
    return o;
  }

  function viewSafety() {
    if (!LOADED) return head(scopeTitle('안전운전')) + skeleton();
    var h = head(scopeTitle('안전운전'),
      esc(cycleName(CYC.y, CYC.m)) + ' · ' + esc(cycleSpan(CYC.y, CYC.m)));

    if (!isAll()) {
      var s = safeOf(TRIPS);
      if (s.score < 0) {
        return h + blank('평가할 운행이 없습니다.',
          '안전운전 점수는 앱이 <b>자동으로 기록한</b> 운행만 봅니다. ' +
          '수기로 넣은 운행은 GPS 기록이 없어 평가하지 않습니다.', 'gauge');
      }
      var g = safeGrade(s.score);
      h += '<div class="hero fade">' +
        '<div class="eyebrow"><span class="dot' + (g[2] === 'ok' ? ' ok' : '') + '"></span>' +
        esc(cycleName(CYC.y, CYC.m)) + ' 안전운전</div>' +
        '<p class="verdict' + (g[2] === 'ok' ? ' clean' : '') + '"><em>' + n0(s.score) + '점</em> · ' +
        g[1] + '</p>' +
        '<div class="facts">' +
        fact('평가한 운행', n0(s.n) + '<small>건</small>', n0(Math.round(s.km)) + ' km') +
        fact('위험 운전', n0(s.events) + '<small>회</small>', '100km당 ' + s.per100.toFixed(1) + '회') +
        fact('최고 속도', n0(s.maxSpeed) + '<small>km/h</small>', '') +
        fact('수기 운행', n0(s.manual) + '<small>건</small>', '평가 제외') +
        '</div></div>';
      h += sect('무엇이 깎였나', null, '', safeBreak(s));
      h += sect('점수가 낮은 운행', null, '', safeTripTable(s.rows.slice()
        .sort(function (a, b) { return safeScore(a) - safeScore(b); }).slice(0, 20)));
      h += safeRuleNote();
      return h;
    }

    // ── 전체 ──
    var byU = {};
    TRIPS.forEach(function (t) { (byU[t.username] = byU[t.username] || []).push(t); });
    var rows = Object.keys(byU).map(function (u) {
      var x = safeOf(byU[u]); x.u = u; return x;
    }).filter(function (x) { return x.score >= 0; })
      .sort(function (a, b) { return a.score - b.score; });
    var dist = {};
    rows.forEach(function (x) { var g2 = safeGrade(x.score)[1]; dist[g2] = (dist[g2] || 0) + 1; });
    var all = [];
    rows.forEach(function (x) { x.rows.forEach(function (t) { all.push([safeScore(t), Number(t.distance_km) || 0]); }); });

    var gAll = safeGrade(safeAvg(all));
    h += '<div class="hero fade">' +
      '<div class="eyebrow"><span class="dot' + (gAll[2] === 'ok' ? ' ok' : '') + '"></span>' +
      esc(cycleName(CYC.y, CYC.m)) + ' 전체 안전운전</div>' +
      '<p class="verdict' + (gAll[2] === 'ok' ? ' clean' : '') + '">평균 <em>' + n0(safeAvg(all)) +
      '점</em> · ' + gAll[1] + '</p>' +
      '<div class="facts">' +
      fact('평가 대상', n0(rows.length) + '<small>명</small>', '자동 기록이 있는 사람') +
      fact('주의 이하', n0((dist['주의'] || 0) + (dist['위험'] || 0)) + '<small>명</small>', '70점 미만은 위험') +
      fact('위험 운전', n0(rows.reduce(function (a, x) { return a + x.events; }, 0)) + '<small>회</small>', '') +
      fact('등급', Object.keys(dist).map(function (k) { return k + ' ' + dist[k]; }).join(' · '), '') +
      '</div></div>';

    h += sect('직원별', rows.length + '명', '',
      '<div class="panel"><div class="scroll tall" data-rows><table><thead><tr>' +
      '<th>이름</th><th>소속</th><th class="n">점수</th><th>등급</th>' +
      '<th class="n">운행</th><th class="n">거리</th><th class="n">과속</th>' +
      '<th class="n">급가속</th><th class="n">급감속</th><th class="n">100km당</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (x) {
        var u = USERS[x.u] || {}, g3 = safeGrade(x.score);
        return '<tr class="clk" tabindex="0" data-person="' + esc(x.u) + '"' +
          (x.score < 80 ? ' class="flagged"' : '') + '>' +
          '<td><span class="lead">' + esc(u.name || x.u) + '</span></td>' +
          '<td class="dim">' + esc(u.dept || '—') + '</td>' +
          '<td class="n total">' + n0(x.score) + '</td>' +
          '<td><span class="st ' + g3[2] + '">' + g3[1] + '</span></td>' +
          '<td class="n">' + n0(x.n) + '</td>' +
          '<td class="n">' + n0(Math.round(x.km)) + '</td>' +
          '<td class="n' + (x.over ? ' unk' : ' dim') + '">' + (x.over || '—') + '</td>' +
          '<td class="n' + (x.accel ? '' : ' dim') + '">' + (x.accel || '—') + '</td>' +
          '<td class="n' + (x.decel ? ' unk' : ' dim') + '">' + (x.decel || '—') + '</td>' +
          '<td class="n dim">' + x.per100.toFixed(1) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>');
    h += safeRuleNote();
    return h;

    function fact(k, v, sub, alert) {
      return '<div class="fact"><div class="k">' + esc(k) + '</div>' +
        '<div class="v' + (alert ? ' alert' : '') + '">' + v + '</div>' +
        '<div class="sub">' + esc(sub || '') + '</div></div>';
    }
  }

  function safeBreak(s) {
    var items = [
      ['과속', s.over, 3], ['어린이보호구역 과속', s.school, 5], ['급가속', s.accel, 3],
      ['급감속', s.decel, 5], ['급회전', s.corner, 3], ['지속과속', s.sustained, 2]
    ].filter(function (x) { return x[1] > 0; });
    if (!items.length) {
      return '<div class="panel" style="padding:22px 20px;text-align:center;color:var(--ink-3)">' +
        '위험 운전이 한 번도 없었습니다.</div>';
    }
    return '<div class="panel"><table class="kv"><tbody>' +
      items.map(function (x) {
        return '<tr><th>' + esc(x[0]) + '</th><td><b>' + n0(x[1]) + '회</b>' +
          '<span class="dim"> · 1회당 −' + x[2] + '점</span></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function safeTripTable(rows) {
    if (!rows.length) return blank('평가한 운행이 없습니다.', null, 'list');
    return '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>날짜</th><th class="n">점수</th><th>구간</th><th class="n">과속</th>' +
      '<th class="n">급가감속</th><th class="n">최고</th></tr></thead><tbody>' +
      rows.map(function (t) {
        var sc = safeScore(t), g = safeGrade(sc);
        return '<tr class="clk" tabindex="0" data-trip="' + esc(t.id) + '">' +
          '<td><span class="lead">' + md(t.start_time) + '</span> <span class="dim">' +
          hm(t.start_time) + (isNightTrip(t.start_time) ? ' 야간' : '') + '</span></td>' +
          '<td class="n total">' + n0(sc) + ' <span class="st ' + g[2] + '">' + g[1] + '</span></td>' +
          '<td class="dim">' + esc(dong(t.start_address)) + ' → ' + esc(dong(t.end_address)) + '</td>' +
          '<td class="n">' + (Number(t.overspeed_count) || 0) + '</td>' +
          '<td class="n">' + ((Number(t.rapid_accel_count) || 0) + (Number(t.rapid_decel_count) || 0)) + '</td>' +
          '<td class="n dim">' + n0(t.max_speed_kmh) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function safeRuleNote() {
    return '<section class="sect"><div class="panel" style="padding:18px 20px;font-size:12.5px;' +
      'line-height:1.95;color:var(--ink-3)">' +
      '<b style="color:var(--ink-2)">100점에서 깎습니다.</b> ' +
      '과속 −3 · 어린이보호구역 과속 −5 · 급가속 −3 · 급감속 −5 · 급회전 −3 · ' +
      '지속과속 −2(운행당 −10까지)<br>' +
      '밤 10시~새벽 6시에 출발한 운행은 깎인 점수를 <b>1.5배</b>로 칩니다.<br>' +
      '여러 운행의 평균은 <b>주행거리로 가중</b>합니다 — 짧은 운행이 과대 반영되지 않게 합니다.<br>' +
      '<b style="color:var(--ink-2)">수기로 넣은 운행은 평가하지 않습니다</b> — GPS 기록이 없어 ' +
      '위반이 0으로 잡히면 점수가 부풀려집니다.<br>' +
      '앱과 같은 식을 씁니다 — 두 숫자가 다르면 버그입니다.' +
      '</div></section>';
  }

  /* ══════════════════ 통행료 채우기 ══════════════════
     자동계산이 못 정한 것을 사람이 채우는 자리다.
     한 건씩 치게 하면 1인당 35건이라 아무도 안 한다(2026-09 실측: 52% 미확정).
     그래서 **같은 구간끼리 묶어** 한 번에 처리한다. 실제로 구로↔가산 왕복처럼
     시내 구간이 뭉쳐 있어, 묶음 하나에 '없음' 을 누르면 수십 건이 정리된다. */
  var FILLS = {};                   // 구간키 → 정한 값(숫자) 또는 0

  function viewTollFill() {
    if (!LOADED) return head('통행료 채우기') + skeleton();
    var mine = myName();
    var rows = TRIPS.filter(function (t) {
      return t.username === mine && isUnknownToll(t) && (t.purpose || '') === BUSINESS;
    });
    var h = head('통행료 채우기', rows.length
      ? n0(rows.length) + '건이 비어 있습니다'
      : '비어 있는 통행료가 없습니다');

    if (!rows.length) {
      return h + blank('채울 것이 없습니다.',
        '자동계산과 하이패스 대조로 모두 정해졌습니다.', 'check');
    }

    // 구간별로 묶는다. 같은 구간을 전에 사람이 확정한 적이 있으면 그 금액을 권한다.
    var g = {}, order = [];
    rows.forEach(function (t) {
      var k = dong(t.start_address) + ' → ' + dong(t.end_address);
      if (!g[k]) { g[k] = { key: k, rows: [], hint: null }; order.push(k); }
      g[k].rows.push(t);
    });
    // 이력: 같은 사람·같은 구간에서 사람이 확정했던 금액
    var hist = {};
    TRIPS.forEach(function (t) {
      if (t.username !== mine || isUnknownToll(t)) return;
      var k = dong(t.start_address) + ' → ' + dong(t.end_address);
      (hist[k] = hist[k] || []).push(Number(t.toll_cost) || 0);
    });
    order.forEach(function (k) {
      var v = hist[k];
      if (!v || !v.length) return;
      // 가장 자주 나온 금액을 권한다.
      var cnt = {}, best = null;
      v.forEach(function (x) { cnt[x] = (cnt[x] || 0) + 1; if (best === null || cnt[x] > cnt[best]) best = x; });
      g[k].hint = Number(best);
    });
    order.sort(function (a, b) { return g[b].rows.length - g[a].rows.length; });

    var done = 0, sum = 0;
    order.forEach(function (k) {
      if (FILLS[k] == null) return;
      done += g[k].rows.length; sum += FILLS[k] * g[k].rows.length;
    });

    h += '<section class="sect"><div class="panel" style="padding:16px 20px;font-size:12.5px;' +
      'line-height:1.9;color:var(--ink-3)">' +
      '같은 구간끼리 묶었습니다. <b style="color:var(--ink-2)">시내 운행처럼 요금소를 안 지난 구간은 ' +
      '「없음」</b>을 누르시면 그 구간 전체가 한 번에 정리됩니다.<br>' +
      '전에 정하신 금액이 있으면 회색으로 적어 두었습니다 — 눌러서 그대로 쓰실 수 있습니다.<br>' +
      '<b style="color:var(--ink-2)">업무용 운행만</b> 보입니다. 출퇴근·비업무용은 정산과 제출 서류에 ' +
      '들어가지 않아 채우실 필요가 없습니다.' +
      '</div></section>';

    h += '<section class="sect"><div class="hpact" style="border-radius:var(--r-lg);' +
      'border:1px solid var(--line);background:var(--surface);padding:12px 16px">' +
      '<span class="dim" id="tfSum">정한 것 <b>' + n0(done) + '</b> / ' + n0(rows.length) + '건' +
      (sum ? ' · 합계 ' + won(sum) : '') + '</span>' +
      '<button class="btn" id="tfAllFree">남은 것 전부 「없음」</button>' +
      '<button class="btn pri" id="tfSave"' + (done ? '' : ' disabled') + '>' +
      n0(done) + '건 저장</button></div></section>';

    h += '<div class="panel"><div class="scroll tall" data-rows><table><thead><tr>' +
      '<th>구간</th><th class="n">건수</th><th>날짜</th><th class="n">통행료</th>' +
      '</tr></thead><tbody>' +
      order.map(function (k, i) {
        var x = g[k], v = FILLS[k];
        var days = x.rows.slice(0, 5).map(function (t) { return md(t.start_time); }).join(', ') +
          (x.rows.length > 5 ? ' 외 ' + (x.rows.length - 5) + '일' : '');
        return '<tr' + (v != null ? ' class="tfdone"' : '') + '>' +
          '<td><span class="lead">' + esc(k) + '</span></td>' +
          '<td class="n lead">' + n0(x.rows.length) + '</td>' +
          '<td class="dim">' + esc(days) + '</td>' +
          '<td class="n" style="white-space:nowrap">' +
          '<button class="btn sm" data-tffree="' + i + '">없음</button> ' +
          '<input class="inp num" data-tfamt="' + i + '" inputmode="numeric" style="width:92px" ' +
          'placeholder="' + (x.hint != null ? n0(x.hint) : '원') + '" value="' +
          (v != null && v > 0 ? n0(v) : '') + '">' +
          (x.hint != null ? ' <button class="btn sm" data-tfhint="' + i + '" ' +
            'title="전에 정하신 금액 — 눌러서 그대로 씁니다">' +
            (x.hint === 0 ? '없음' : n0(x.hint) + '원') + '</button>' : '') +
          '</td></tr>';
      }).join('') + '</tbody></table></div></div>';

    // 지금 화면의 묶음을 이벤트에서 쓰려고 담아 둔다.
    TF_GROUPS = order.map(function (k) { return g[k]; });
    return h;
  }
  var TF_GROUPS = [];

  /** 묶음의 금액칸을 읽어 FILLS 에 반영한다(입력 도중에도 호출된다). */
  function tfRead() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tfamt]'), function (el) {
      var i = +el.dataset.tfamt, k = TF_GROUPS[i] && TF_GROUPS[i].key;
      if (!k) return;
      var s = String(el.value || '').replace(/[^\d]/g, '');
      if (s === '') { if (FILLS[k] !== 0) delete FILLS[k]; return; }
      FILLS[k] = Number(s);
    });
  }

  /** 남은 것을 전부 0원으로 확정하기 전에 무슨 뜻인지 보여 준다.
   *  자동계산은 이미 '요금소 미통과' 가 확실한 건을 0원으로 확정해 둔다.
   *  여기 남은 것은 자동으로 못 정한 것이라, 무턱대고 0원을 찍으면 실제로
   *  지난 통행료만큼 회사가 덜 지급한다. */
  function openAllFree() {
    tfRead();
    var left = 0, groups = 0;
    TF_GROUPS.forEach(function (x) {
      if (FILLS[x.key] != null) return;
      left += x.rows.length; groups++;
    });
    if (!left) { toast('남은 것이 없습니다.'); return; }
    $('pTitle').textContent = '남은 것 전부 「없음」';
    $('pSub').textContent = n0(groups) + '개 구간 · ' + n0(left) + '건';
    $('pBody').innerHTML =
      '<div class="anote">남은 <b>' + n0(left) + '건</b>을 <b>통행료 없음(0원)</b>으로 확정합니다.</div>' +
      '<div class="form"><div class="frow"><div class="fbody">' +
      '<div class="fhint">자동계산은 요금소를 안 지난 것이 <b>확실한</b> 운행을 이미 0원으로 ' +
      '확정해 둡니다. 여기 남은 것은 자동으로 못 정한 운행이라, 실제로 요금소를 지난 것이 ' +
      '섞여 있으면 <b>그만큼 회사가 덜 지급</b>합니다.<br>' +
      '요금소를 지난 운행이 있으면 취소하고 그 구간만 금액을 넣어 주십시오.</div>' +
      '</div></div></div>';
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnAllFreeGo">' + n0(left) + '건 없음으로</button>';
    $('panel').classList.add('open');
  }

  function tfSave() {
    tfRead();
    var items = [], n = 0;
    TF_GROUPS.forEach(function (x) {
      var v = FILLS[x.key];
      if (v == null) return;
      x.rows.forEach(function (t) { items.push({ id: t.id, amount: v }); n++; });
    });
    if (!items.length) { toast('정한 것이 없습니다.', true); return; }
    if (items.length > 500) { toast('한 번에 500건까지만 저장됩니다. 나눠서 저장해 주세요.', true); return; }
    var btn = $('tfSave'); btn.disabled = true; btn.textContent = '저장 중…';
    api('/functions/v1/toll-apply', {
      method: 'POST',
      body: JSON.stringify({ mode: 'manual', batch: '웹 통행료 채우기 ' + CYCKEY(), items: items })
    }).then(function (r) { return r.json().then(function (x) { return { ok: r.ok, j: x }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = n0(n) + '건 저장';
        if (!res.ok || !res.j || !res.j.ok) {
          toast((res.j && res.j.error) || '저장하지 못했습니다.', true); return;
        }
        var skipped = res.j.skipped || [];
        FILLS = {};
        AUDIT = null;
        loadAll();                       // 서버 값을 다시 받아 화면을 맞춘다
        toastOk(n0(res.j.applied || items.length) + '건 저장했습니다.',
          skipped.length ? skipped.length + '건은 건너뛰었습니다 (' + skipped[0].why + ')' : null);
      }).catch(function () {
        btn.disabled = false; btn.textContent = n0(n) + '건 저장';
        toast('저장하지 못했습니다.', true);
      });
  }

  /* ══════════════════ 내 계정 ══════════════════ */
  function viewAccount() {
    var u = personOf(myName());
    var h = head('내 계정', esc(u.name || myName()));
    h += sect('내 정보', null, '',
      '<div class="panel"><table class="kv"><tbody>' +
      kv('아이디', esc(myName())) +
      kv('이름', esc(u.name || '—')) +
      kv('소속', esc([u.company_name, u.dept].filter(Boolean).join(' ') || '—')) +
      kv('직급', esc(u.position || '—')) +
      kv('차량번호', esc(u.plate_no || '—')) +
      kv('차 종', esc(u.vehicle_type || '—')) +
      kv('운행일지 관리자', ME.is_admin ? '예' : '아니오') +
      '</tbody></table></div>');

    h += sect('비밀번호 바꾸기', null, '',
      '<div class="panel" style="padding:20px"><div class="form">' +
      frow('현재 비밀번호', '<input class="inp" type="password" id="pwCur" autocomplete="current-password">') +
      frow('새 비밀번호', '<input class="inp" type="password" id="pwNew" autocomplete="new-password">',
        '4자 이상. <b>앱과 웹이 같은 비밀번호</b>를 씁니다 — 바꾸면 앱에서도 새 것으로 들어가셔야 합니다.') +
      frow('새 비밀번호 확인', '<input class="inp" type="password" id="pwNew2" autocomplete="new-password">') +
      '</div><div style="margin-top:14px;text-align:right">' +
      '<button class="btn pri" id="btnPwSave">비밀번호 바꾸기</button></div></div>');
    return h;

    function kv(k, v) { return '<tr><th>' + k + '</th><td>' + v + '</td></tr>'; }
    function frow(label, body, hint) {
      return '<div class="frow"><label class="flab">' + label + '</label><div class="fbody">' + body +
        (hint ? '<div class="fhint">' + hint + '</div>' : '') + '</div></div>';
    }
  }

  function savePassword() {
    var cur = ($('pwCur') || {}).value || '';
    var a = ($('pwNew') || {}).value || '', b2 = ($('pwNew2') || {}).value || '';
    if (!cur) { toast('현재 비밀번호를 넣어 주세요.', true); return; }
    if (a.length < 4) { toast('새 비밀번호는 4자 이상이어야 합니다.', true); return; }
    if (a !== b2) { toast('새 비밀번호 확인이 다릅니다.', true); return; }
    if (a === cur) { toast('지금 쓰시는 것과 다른 비밀번호를 넣어 주세요.', true); return; }
    var btn = $('btnPwSave'); btn.disabled = true; btn.textContent = '바꾸는 중…';
    api('/functions/v1/driving-account', {
      method: 'POST', body: JSON.stringify({ action: 'change_password', current: cur, next: a })
    }).then(function (r) { return r.json().then(function (x) { return { ok: r.ok, j: x }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = '비밀번호 바꾸기';
        if (!res.ok || !res.j || !res.j.ok) {
          toast((res.j && res.j.error) || '바꾸지 못했습니다.', true); return;
        }
        ['pwCur', 'pwNew', 'pwNew2'].forEach(function (id) { if ($(id)) $(id).value = ''; });
        toast(res.j.message || '비밀번호를 바꿨습니다.');
      }).catch(function () {
        btn.disabled = false; btn.textContent = '비밀번호 바꾸기';
        toast('바꾸지 못했습니다.', true);
      });
  }

  /* ══════════════════ 권한 관리 (마스터 계정만) ══════════════════ */
  function viewPerm() {
    if (!LOADED) return head('권한 관리') + skeleton();
    var list = Object.keys(USERS).sort(function (a, b) {
      var x = USERS[a], y = USERS[b];
      return (y.is_admin ? 1 : 0) - (x.is_admin ? 1 : 0) ||
        nameOf(a).localeCompare(nameOf(b), 'ko');
    });
    var admins = list.filter(function (u) { return USERS[u].is_admin; }).length;
    var h = head('권한 관리', list.length + '명 · 관리자 ' + admins + '명');
    h += '<section class="sect"><div class="panel" style="padding:16px 20px;font-size:12.5px;' +
      'line-height:1.9;color:var(--ink-3)">' +
      '<b style="color:var(--ink-2)">운행일지 관리자</b>는 전 직원의 운행·정산·증빙을 보고, ' +
      '계기판을 고칠 수 있습니다.<br>' +
      '바꿀 때마다 <b>본인 비밀번호</b>를 한 번 더 확인합니다 — 자리를 비운 사이 남이 ' +
      '권한을 주는 일을 막기 위해서입니다.</div></section>';
    h += sect('직원', list.length + '명', '',
      '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>이름</th><th>아이디</th><th>소속</th><th>권한</th><th></th></tr></thead><tbody>' +
      list.map(function (u) {
        var x = USERS[u];
        return '<tr>' +
          '<td><span class="lead">' + esc(x.name || u) + '</span></td>' +
          '<td class="dim">' + esc(u) + '</td>' +
          '<td class="dim">' + esc(x.dept || '—') + '</td>' +
          '<td>' + (x.is_admin ? '<span class="st bad">관리자</span>' : '<span class="dim">일반</span>') + '</td>' +
          '<td class="n" style="white-space:nowrap">' +
          // 마스터 계정 자신은 바꿀 수 없다(서버 RPC 가 거부한다). 버튼을 아예 안 보인다.
          (u === myName()
            ? '<span class="dim">본인 계정</span>'
            : '<button class="btn sm" data-perm="' + esc(u) + '" data-on="' + (x.is_admin ? '0' : '1') + '">' +
              (x.is_admin ? '관리자 해제' : '관리자 지정') + '</button> ' +
              '<button class="btn sm" data-pwreset="' + esc(u) + '">비밀번호 초기화</button>') +
          '</td></tr>';
      }).join('') + '</tbody></table></div></div>');
    return h;
  }

  /** 권한·비밀번호를 바꾸기 전에 본인 비밀번호를 확인받는 창. */
  function openPermConfirm(kind, target, enabled) {
    var nm = nameOf(target);
    $('pTitle').textContent = kind === 'admin'
      ? (enabled ? '관리자 지정' : '관리자 해제') : '비밀번호 초기화';
    $('pSub').textContent = nm + ' (' + target + ')';
    var body = '<div class="form">';
    if (kind === 'pw') {
      body += '<div class="frow"><label class="flab">새 비밀번호</label><div class="fbody">' +
        '<input class="inp" type="text" id="rsNew" autocomplete="off" placeholder="4자 이상">' +
        '<div class="fhint">본인에게 직접 알려 주셔야 합니다. ' +
        '<b>앱과 웹이 같은 비밀번호</b>를 씁니다.</div></div></div>';
    } else {
      body += '<div class="anote">' + esc(nm) + ' 님을 <b>' +
        (enabled ? '운행일지 관리자로 지정' : '관리자에서 해제') + '</b>합니다.' +
        (enabled ? ' 전 직원의 운행·정산·증빙을 보게 되고 계기판을 고칠 수 있습니다.' : '') +
        '</div>';
    }
    body += '<div class="frow"><label class="flab">본인 비밀번호</label><div class="fbody">' +
      '<input class="inp" type="password" id="rsMine" autocomplete="current-password">' +
      '<div class="fhint">지금 로그인한 <b>' + esc(myName()) + '</b> 계정의 비밀번호입니다.</div>' +
      '</div></div></div>';
    $('pBody').innerHTML = body;
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnPermGo" data-kind="' + kind + '" data-target="' + esc(target) +
      '" data-on="' + (enabled ? '1' : '0') + '">확인</button>';
    $('panel').classList.add('open');
  }

  function runPerm(kind, target, enabled) {
    var mine = ($('rsMine') || {}).value || '';
    if (!mine) { toast('본인 비밀번호를 넣어 주세요.', true); return; }
    var payload = { action: kind === 'admin' ? 'set_admin' : 'reset_password', target: target, password: mine };
    if (kind === 'admin') payload.enabled = enabled;
    else {
      var np = ($('rsNew') || {}).value || '';
      if (np.length < 4) { toast('새 비밀번호는 4자 이상이어야 합니다.', true); return; }
      payload.next = np;
    }
    var btn = $('btnPermGo'); btn.disabled = true; btn.textContent = '처리 중…';
    api('/functions/v1/driving-account', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (x) { return { ok: r.ok, j: x }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = '확인';
        if (!res.ok || !res.j || !res.j.ok) {
          toast((res.j && res.j.error) || '처리하지 못했습니다.', true); return;
        }
        if (kind === 'admin' && USERS[target]) USERS[target].is_admin = enabled;
        closePanel(); render();
        toast(res.j.message || '처리했습니다.');
      }).catch(function () {
        btn.disabled = false; btn.textContent = '확인';
        toast('처리하지 못했습니다.', true);
      });
  }

  /* ══════════════════ 결재 ══════════════════
     결재 단위는 사람 × 마감주기. 운행 건별로 결재하지 않는다.
     결재선은 부서 기본선을 자동으로 채워 주되 잠그지 않는다 — 빼고 더할 수 있다.  */
  var CYCKEY = function () { return CYC.y + '-' + pad(CYC.m); };
  var BOXES = ['담당', '팀장', '실장', '사업부장', '대표이사'];

  function myAppr(cycle) {
    var k = cycle || CYCKEY(), mine = myName();
    return APPR.filter(function (a) { return a.username === mine && a.cycle === k; })[0] || null;
  }
  /** 내 차례인 결재 건. 관리자라도 결재선에 없으면 안 나온다(대결 불가). */
  function inbox() {
    var mine = myName();
    return APPR.filter(function (a) {
      if (a.status !== 'submitted') return false;
      var cur = (a.steps || []).filter(function (s) { return s.seq === a.cur_seq; })[0];
      return cur && cur.approver === mine;
    });
  }
  /** 마지막으로 상신했던 결재선을 기억한다 — 부서 기본선보다 우선한다. */
  function lastSteps() {
    var mine = myName();
    var past = APPR.filter(function (a) {
      return a.username === mine && a.cycle !== CYCKEY() && (a.steps || []).length;
    }).sort(function (a, b) { return (b.submitted_at || '').localeCompare(a.submitted_at || ''); })[0];
    return past ? past.steps.map(function (s) { return { approver: s.approver, box: s.box }; }) : null;
  }
  /** 부서 기본선 → 본인 위치 아래는 잘라낸다. pick 자리는 고르라고 비워 둔다. */
  function defaultSteps() {
    var remembered = lastSteps();
    if (remembered) return remembered;
    var me2 = personOf(myName());
    var line = LINES[me2.dept];
    if (!line || !Array.isArray(line.steps)) return [];
    var out = line.steps.map(function (s) {
      return { approver: s.approver || '', box: s.box || '', pick: s.pick || '', candidates: s.candidates || [] };
    });
    // 사다리에서 본인을 찾으면 그 다음부터가 결재선이다.
    var at = -1;
    out.forEach(function (s, i) { if (s.approver === myName()) at = i; });
    return at >= 0 ? out.slice(at + 1) : out;
  }

  function apprStatusText(a) {
    if (!a) return { t: '아직 상신하지 않았습니다', cls: '' };
    if (a.status === 'approved') return { t: '결재 완료', cls: 'ok' };
    if (a.status === 'rejected') {
      var r = (a.steps || []).filter(function (s) { return s.result === 'rejected'; })[0];
      return { t: '반려 — ' + ((r && r.name) || '') + (r && r.comment ? ' · ' + r.comment : ''), cls: 'bad' };
    }
    if (a.status === 'withdrawn') return { t: '회수했습니다', cls: '' };
    var cur = (a.steps || []).filter(function (s) { return s.seq === a.cur_seq; })[0];
    if (!cur) return { t: '결재중', cls: 'warn' };
    // 내 차례면 3인칭으로 부르지 않는다. 눌러야 할 사람에게 눌러야 한다고 말해야 한다.
    if (cur.approver === myName()) return { t: '내 차례입니다', cls: 'bad' };
    return { t: (cur.name || cur.approver) + ' 님 결재중', cls: 'warn' };
  }

  /** 진행 막대 — 상신자부터 마지막 결재자까지. */
  function apprTrack(a) {
    if (!a || !(a.steps || []).length) return '';
    var h = '<div class="aprog"><span class="anode done">' + ic('check', 12) + '</span>' +
      '<span class="alabel">' + esc(nameOf(a.username)) + '</span>';
    a.steps.forEach(function (s) {
      var st = s.result === 'approved' ? 'done'
        : s.result === 'rejected' ? 'bad'
          : (a.status === 'submitted' && s.seq === a.cur_seq) ? 'now' : 'wait';
      h += '<span class="aline ' + (st === 'done' ? 'done' : '') + '"></span>' +
        '<span class="anode ' + st + '">' +
        (st === 'done' ? ic('check', 12) : st === 'bad' ? '!' : s.seq) + '</span>' +
        '<span class="alabel' + (st === 'wait' ? ' wait' : '') + '">' + esc(s.name || s.approver) +
        (s.box ? '<em>' + esc(s.box) + '</em>' : '') + '</span>';
    });
    return h + '</div>';
  }

  /* ── 상신 창 ── */
  function openSubmit() {
    var a = myAppr();
    if (a && (a.status === 'submitted' || a.status === 'approved')) {
      toast(a.status === 'approved' ? '이미 결재가 끝났습니다.' : '이미 상신했습니다.', true); return;
    }
    DRAFT = (a && a.status === 'rejected' && (a.steps || []).length)
      ? a.steps.map(function (s) { return { approver: s.approver, box: s.box }; })
      : defaultSteps();
    renderSubmit();
  }
  /** 결재자 찾기 입력에 지금 쳐 놓은 글자. 창을 다시 그려도 남는다. */
  var APPR_Q = '';

  /** 이름·아이디·부서·직급 어디에든 걸리면 후보로 본다. 이미 넣은 사람과 본인은 뺀다. */
  function apprCandidates() {
    var q = APPR_Q.trim().toLowerCase();
    var used = DRAFT.map(function (s) { return s.approver; }).filter(Boolean);
    var list = Object.keys(PEOPLE).filter(function (u) {
      return u !== myName() && used.indexOf(u) < 0;
    });
    if (q) {
      list = list.filter(function (u) {
        var p = personOf(u);
        return [nameOf(u), u, p.dept || '', p.position || ''].join(' ').toLowerCase().indexOf(q) >= 0;
      });
    }
    return list.sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b), 'ko'); });
  }

  function apprCandHtml() {
    var all = apprCandidates();
    if (!all.length) {
      return '<div class="acnone">' +
        (APPR_Q.trim() ? '「' + esc(APPR_Q.trim()) + '」 로 찾히는 사람이 없습니다.'
          : '더 넣을 사람이 없습니다.') + '</div>';
    }
    var show = all.slice(0, 8);
    return show.map(function (u, i) {
      var p = personOf(u);
      return '<button class="acand-i' + (i === 0 ? ' top' : '') + '" data-addappr="' + esc(u) + '">' +
        '<b>' + esc(nameOf(u)) + '</b>' +
        '<span>' + esc([p.dept, p.position].filter(Boolean).join(' · ') || u) + '</span>' +
        (i === 0 ? '<span class="acent">Enter</span>' : '') + '</button>';
    }).join('') +
      (all.length > show.length
        ? '<div class="acnone">그 밖에 ' + n0(all.length - show.length) + '명 — 더 쳐서 좁혀 주세요.</div>'
        : '');
  }

  function addApprover(u) {
    if (!u || DRAFT.length >= 4) return;
    if (DRAFT.some(function (s) { return s.approver === u; })) return;
    DRAFT.push({ approver: u, box: BOXES[Math.min(DRAFT.length + 1, BOXES.length - 1)] });
    APPR_Q = '';                       // 다음 사람을 바로 칠 수 있게 비운다
    renderSubmit();
    var box = $('apprQ');
    if (box) box.focus();
  }

  function renderSubmit() {
    // ★ 관리자는 TRIPS 에 전 직원 운행이 들어 있다. 예전에는 그 합계를 그대로
    //   보여 줘서 "1,842건 · ₩12,400,000" 같은 회사 전체 숫자가 자기 결재 금액인
    //   양 보였다. 서버가 굳히는 snapshot 은 본인 것이므로 화면만 거짓말했다.
    var T = totals(TRIPS.filter(function (t) { return t.username === myName(); }));
    var pickable = Object.keys(PEOPLE).filter(function (u) { return u !== myName(); })
      .sort(function (x, y) { return nameOf(x).localeCompare(nameOf(y), 'ko'); });

    $('pTitle').textContent = cycleName(CYC.y, CYC.m) + ' 결재 상신';
    $('pSub').textContent = cycleSpan(CYC.y, CYC.m) + ' · ' + n0(T.n) + '건 · ' + won(T.cost);

    var h = '<div class="aline-list">';
    h += '<div class="arow"><span class="aseq me">본</span>' +
      '<span class="awho"><b>' + esc(ME.name || myName()) + '</b><span>' +
      esc([personOf(myName()).dept, personOf(myName()).position].filter(Boolean).join(' · ')) +
      '</span></span><span class="abox">담당</span></div>';

    DRAFT.forEach(function (s, i) {
      var u = personOf(s.approver);
      h += '<div class="arow"><span class="aseq">' + (i + 1) + '</span><span class="awho">';
      if (s.pick && !s.approver) {
        h += '<select class="apick" data-idx="' + i + '"><option value="">— ' + esc(s.pick) + ' 고르기 —</option>' +
          (s.candidates || []).map(function (c) {
            return '<option value="' + esc(c) + '">' + esc(nameOf(c)) + ' · ' + esc(personOf(c).position || '') + '</option>';
          }).join('') + '</select>';
      } else {
        h += '<b>' + esc(u.name || s.approver) + '</b><span>' +
          esc([u.dept, u.position].filter(Boolean).join(' · ')) + '</span>';
      }
      h += '</span><select class="abox" data-box="' + i + '">' +
        BOXES.slice(1).map(function (b) {
          return '<option value="' + esc(b) + '"' + (s.box === b ? ' selected' : '') + '>' + esc(b) + '</option>';
        }).join('') + '</select>' +
        '<button class="iconbtn sm" data-del="' + i + '" aria-label="빼기">' + ic('close', 14) + '</button></div>';
    });
    h += '</div>';

    if (DRAFT.length < 4) {
      // ★ 예전에는 61명짜리 <select> 였다. 마감일에 그 목록을 훑어 고르는 것은
      //   할 짓이 아니다. 이름을 두어 글자만 쳐도 좁혀지게 바꿨다.
      //   부서·직급으로도 찾힌다("광역", "팀장").
      h += '<div class="aadd">' +
        '<input id="apprQ" autocomplete="off" placeholder="결재자 이름을 쓰세요 (예: ' +
        esc(nameOf(pickable[0] || '')) + ')" value="' + esc(APPR_Q) + '">' +
        '<div class="acand" id="apprCand">' + apprCandHtml() + '</div></div>';
    }

    var warn = [];
    if (T.unk) warn.push('통행료 미확정 ' + n0(T.unk) + '건이 0원으로 올라갑니다');
    var A = audit().filter(function (f) { return f.sev === 'bad' && f.n > 0; });
    if (A.length) warn.push('점검에서 ' + A.reduce(function (s, f) { return s + f.n; }, 0) + '건이 걸려 있습니다');
    if (warn.length) {
      h += '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(warn.join(' · ')) + '</span></div>';
    }
    h += '<div class="anote">상신하면 <b>이 시점의 숫자가 그대로 고정</b>됩니다. ' +
      '결재가 끝나면 이 기간의 운행은 <b>고칠 수 없습니다.</b></div>';

    $('pBody').innerHTML = h;
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnSubmitAppr">상신</button>';
    $('panel').classList.add('open');
  }

  function callAppr(payload, okMsg) {
    return apiRetry('/functions/v1/approval-act', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j || !res.j.ok) {
          toast((res.j && res.j.error) || '처리하지 못했습니다.', true); return false;
        }
        toastOk(res.j.message || okMsg || '처리했습니다.', res.j.warning);
        closePanel();
        return fetchAll('/rest/v1/driving_approvals?select=*&order=submitted_at.desc')
          .then(function (rows) { APPR = rows || []; paintPills(); render(); return true; });
      }).catch(function () { toast('서버에 연결하지 못했습니다.', true); return false; });
  }

  /* ── 결재함 ── */
  function viewInbox() {
    if (!LOADED) return head('결재함') + skeleton();
    var mine = inbox();
    // ★ 결재함은 개인 화면이다. 관리자는 APPR 에 전 직원 결재건이 들어 있어,
    //   거르지 않으면 남의 결재 진행상황과 금액이 '그 밖의 건' 으로 나열됐다.
    //   내가 올린 것과 내가 결재선에 든 것만 남긴다.
    var meNow = myName();
    var others = APPR.filter(function (a) {
      if (mine.indexOf(a) >= 0) return false;
      if (a.username === meNow) return true;
      return (a.steps || []).some(function (s) { return s && s.approver === meNow; });
    });

    var h = head('결재함', mine.length ? '내 차례 ' + mine.length + '건' : '내 차례인 건이 없습니다');
    if (mine.length) {
      h += sect('내 차례', mine.length + '건', '', '<div class="panel">' + mine.map(apprCard).join('') + '</div>');
    } else {
      h += blank('결재할 것이 없습니다.', '다른 분 차례이거나 아직 상신되지 않았습니다.', 'check');
    }
    if (others.length) {
      h += sect('그 밖의 건', others.length + '건', '',
        '<div class="panel">' + others.slice(0, 40).map(apprCard).join('') + '</div>');
    }
    return h;
  }
  function apprCard(a) {
    var st = apprStatusText(a);
    var s = a.snapshot || {};
    var canAct = inbox().indexOf(a) >= 0;
    var canWithdraw = a.username === myName() && a.status === 'submitted' &&
      !(a.steps || []).some(function (x) { return x.result; });
    return '<div class="acard">' +
      '<div class="ahd"><b>' + esc(nameOf(a.username)) + '</b>' +
      '<span class="acyc">' + esc(a.cycle) + '분</span>' +
      '<span class="st ' + st.cls + '">' + esc(st.t) + '</span>' +
      '<span style="flex:1"></span>' +
      (s.trips != null ? '<span class="asum">' + n0(s.trips) + '건 · ' + km(s.km) + ' km · ' + won(s.cost) + '</span>' : '') +
      '</div>' +
      apprTrack(a) +
      (canAct || canWithdraw
        ? '<div class="aact">' +
          (canWithdraw ? '<button class="btn sm" data-appr="withdraw" data-id="' + a.id + '">회수</button>' : '') +
          (canAct ? '<button class="btn sm" data-appr="reject" data-id="' + a.id + '">반려</button>' +
            '<button class="btn pri sm" data-appr="approve" data-id="' + a.id + '">승인</button>' : '') +
          '</div>'
        : '') +
      '</div>';
  }

  /* ══════════════════ 공통 조각 ══════════════════ */
  function head(title, sub) {
    return '<div class="phead"><h1>' + esc(title) + '</h1>' +
      (sub ? '<p>' + sub + '</p>' : '') + '</div>';
  }
  function sect(title, cnt, right, body) {
    return '<section class="sect"><div class="hd"><h2>' + esc(title) + '</h2>' +
      (cnt ? '<span class="cnt">' + cnt + '</span>' : '') +
      '<div class="sp"></div>' + (right || '') + '</div>' + body + '</section>';
  }
  function blank(title, desc, icon) {
    return '<div class="panel"><div class="blank"><div class="ico">' + ic(icon || 'list', 21) + '</div>' +
      '<div class="t">' + esc(title) + '</div>' +
      (desc ? '<div class="d">' + esc(desc) + '</div>' : '') + '</div></div>';
  }
  function skeleton() {
    var rows = '';
    for (var i = 0; i < 7; i++) {
      rows += '<tr><td colspan="6"><div class="sk" style="width:' + (48 + (i * 13) % 44) + '%"></div></td></tr>';
    }
    return '<div class="hero"><div class="sk" style="width:120px;height:11px"></div>' +
      '<div class="sk" style="width:60%;height:26px;margin-top:16px"></div>' +
      '<div class="sk" style="width:100%;height:5px;margin-top:22px"></div></div>' +
      '<div class="panel"><table><tbody>' + rows + '</tbody></table></div>';
  }
  /** 이름 조회. app_users 는 RLS 로 본인만 보이므로 사람 목록(뷰)을 함께 본다. */
  function nameOf(u) { var x = USERS[u] || PEOPLE[u]; return (x && x.name) || u || '—'; }
  function personOf(u) { return USERS[u] || PEOPLE[u] || {}; }
  /** 다시 그린 뒤 같은 요소로 포커스를 돌려준다(셀렉트를 키보드로 넘길 때 필요). */
  function renderKeepFocus(id) {
    render();
    var el = $(id);
    if (el) el.focus();
  }
  /** 하이패스 대조 — 고른 건수·합계와 확정 버튼만 제자리에서 고쳐 쓴다. */
  function paintHpCount() {
    HP.groups.forEach(function (g, gi) {
      var picked = (g.matched || []).filter(function (m) { return m.pick; });
      var sum = picked.reduce(function (a, m) { return a + (Number(m.amount) || 0); }, 0);
      var lab = $('hpSum' + gi);
      if (lab) lab.innerHTML = '선택 <b>' + n0(picked.length) + '건</b> · 합계 ' + won(sum);
      var btn = document.querySelector('[data-hpapply="' + gi + '"]');
      if (btn) { btn.disabled = !picked.length; btn.textContent = n0(picked.length) + '건 확정하기'; }
    });
  }
  /** 입력칸에 넣을 계기판 값. 비어 있으면 빈 문자열(n0 은 '—' 를 돌려준다). */
  function odoVal(v) { return v == null ? '' : n0(v); }
  /** 그 사람이 이번 주기에 몬 차량번호 목록. 등록 차량을 앞에 둔다. */
  function carsOf(u) {
    var out = [];
    TRIPS.forEach(function (t) {
      if (t.username === u && t.plate_no && out.indexOf(t.plate_no) < 0) out.push(t.plate_no);
    });
    var reg = personOf(u).plate_no;
    if (reg && out.indexOf(reg) < 0) out.unshift(reg);
    return out;
  }
  /** 지금 보고 있는 마감주기가 그 사람 기준으로 결재 완료됐는가. */
  function cycleApproved(u) {
    return APPR.some(function (a) {
      return a.username === u && a.cycle === CYCKEY() && a.status === 'approved';
    });
  }
  /** 그 사람의 가장 최근 운행 — 계기판 기본값에 쓴다. */
  function lastTripOf(u) {
    return TRIPS.filter(function (t) { return t.username === u; })
      .sort(function (a, b) { return b.start_time - a.start_time; })[0];
  }
  /** 사람이 확정한 금액은 진하게, 기계가 계산한 추정치는 흐리게.
      점·뱃지를 붙이지 않고 색 하나로 구분한다 — 표에 점이 늘어나면 숫자가 안 읽힌다. */
  function tollCell(t) {
    if (isUnknownToll(t)) return '<span class="st warn">미확정</span>';
    if (Number(t.toll_cost) === 0) return '<span class="st dim">면제</span>';
    // 사람이 정한 값 판정은 hipass.js 의 bySource() 하나만 쓴다. 여기서 따로
    //   적으면 '기사 …' · '사용자 입력' 같은 값이 빠져 표의 진하게/흐리게가 뒤집힌다.
    var human = window.Hipass && window.Hipass.bySource
      ? window.Hipass.bySource(t.toll_source) === 'person'
      : (t.toll_source === '하이패스 영수증' || t.toll_source === '웹 직접 입력');
    return '<span' + (human ? ' class="lead"' : ' class="dim"') +
      ' title="' + esc(t.toll_source || '자동 계산') + '">' + n0(t.toll_cost) + '</span>';
  }
  function purposeCell(p) {
    if (p === BUSINESS) return '<span class="kind biz">업무</span>';
    if (p === '출퇴근') return '<span class="kind">출퇴근</span>';
    if (p === '비업무용') return '<span class="kind">비업무</span>';
    return '<span class="st bad">미선택</span>';
  }

  /* ══════════════════ 마감 현황 ══════════════════ */
  function viewClose() {
    if (!LOADED) return head(isAll() ? '전체 마감 현황' : '마감 현황') + skeleton();
    var T = totals(TRIPS), A = audit();
    var bads = A.filter(function (f) { return f.sev === 'bad' && f.n > 0; });
    var badN = bads.reduce(function (s, f) { return s + f.n; }, 0);
    var r = cycleRange(CYC.y, CYC.m), now = Date.now();
    var pct = Math.max(0, Math.min(100, Math.round((now - r.lo) / (r.hi - r.lo) * 100)));
    var days = Math.ceil((r.hi - now) / 86400e3);
    var closed = now >= r.hi;

    // 한 문장의 판정 — 숫자 네 개보다 이게 먼저다
    var verdict, clean = '';
    if (badN) {
      verdict = '손봐야 할 기록이 <em>' + n0(badN) + '건</em> 있습니다';
    } else if (T.unk) {
      verdict = '통행료 <em>' + n0(T.unk) + '건</em>만 채우면 끝납니다';
    } else if (!T.n) {
      verdict = '아직 기록된 운행이 없습니다'; clean = ' clean';
    } else {
      verdict = '<em>손볼 것이 없습니다</em>'; clean = ' clean';
    }

    var h = head(isAll() ? '전체 마감 현황' : '마감 현황',
      isAll() ? '전체 직원 ' + Object.keys(USERS).length + '명' : esc(ME.name || ''));

    h += '<div class="hero fade">' +
      '<div class="eyebrow"><span class="dot"></span>' + esc(cycleName(CYC.y, CYC.m)) +
      ' · ' + esc(cycleSpan(CYC.y, CYC.m)) + '</div>' +
      '<p class="verdict' + clean + '">' + verdict + '</p>' +
      '<div class="track' + (closed ? ' done' : '') + '"><i style="width:' + pct + '%"></i></div>' +
      '<div class="facts">' +
      fact('마감', closed ? '종료' : (days <= 0 ? '오늘' : days + '<small>일 남음</small>'),
        closed ? esc(cycleSpan(CYC.y, CYC.m)) + ' 종료' : pct + '% 지남') +
      fact('운행', n0(T.n) + '<small>건</small>', km(T.km) + ' km' + (T.manual ? ' · 수기 ' + n0(T.manual) : '')) +
      fact('업무용 비용', won(T.cost), '유류 ' + won(T.fuel) + ' · 통행 ' + won(T.toll)) +
      fact('통행료 미확정', n0(T.unk) + '<small>건</small>', T.unk ? '정산에서 0원으로 잡힙니다' : '전부 확정', T.unk > 0) +
      '</div></div>';

    // 결재 — 히어로 바로 아래. 이 주기가 지금 어디까지 갔는지가 제일 궁금하다.
    h += apprStrip();

    // 점검 요약 — 문제가 있을 때만, 있으면 크게
    if (badN || T.unk) {
      var list = A.filter(function (f) { return f.n > 0; }).slice(0, 4);
      h += sect('바로 봐야 할 것', null,
        '<button class="btn sm" data-v="' + (isAll() ? 'a_check' : 'check') + '">전체 점검 ' +
          ic('chev', 13) + '</button>',
        '<div class="panel">' + list.map(issueRow).join('') + '</div>');
    }

    if (isAll()) {
      var byU = {};
      TRIPS.forEach(function (t) { (byU[t.username] = byU[t.username] || []).push(t); });
      var rows = Object.keys(byU).map(function (u) { var x = totals(byU[u]); x.u = u; return x; })
        .sort(function (a, b) { return b.cost - a.cost; });
      h += sect('직원별 요약', rows.length + '명', '', personTable(rows));
    } else {
      h += sect('최근 운행', null,
        '<button class="btn sm" data-v="trips">전체 보기 ' + ic('chev', 13) + '</button>',
        tripTable(TRIPS.slice(0, 8), { compact: true }));
    }
    return h;

    function fact(k, v, sub, alert) {
      return '<div class="fact"><div class="k">' + esc(k) + '</div>' +
        '<div class="v' + (alert ? ' alert' : '') + '">' + v + '</div>' +
        '<div class="sub">' + esc(sub || '') + '</div></div>';
    }
  }

  /** 마감 현황의 결재 띠. 상태에 따라 버튼이 달라진다. */
  function apprStrip() {
    var a = myAppr(), st = apprStatusText(a);
    var canWithdraw = a && a.status === 'submitted' &&
      !(a.steps || []).some(function (x) { return x.result; });
    var btn = '';
    if (!a || a.status === 'rejected' || a.status === 'withdrawn') {
      btn = '<button class="btn pri sm" id="btnOpenSubmit">' +
        (a && a.status === 'rejected' ? '다시 상신' : (isAll() ? '내 것 결재 상신' : '결재 상신')) +
        '</button>';
    } else if (a.status === 'approved') {
      btn = '<button class="btn sm" id="btnApprPdf">' + ic('dl', 13) + '인쇄용 PDF</button>';
    } else if (canWithdraw) {
      btn = '<button class="btn sm" data-appr="withdraw" data-id="' + a.id + '">회수</button>';
    }
    return '<section class="sect" style="margin-top:16px"><div class="astrip">' +
      '<div class="ahd"><span class="st ' + st.cls + '">' + esc(st.t) + '</span>' +
      '<span style="flex:1"></span>' + btn + '</div>' +
      (a ? apprTrack(a) : '<div class="anote" style="margin-top:0">' +
        '결재선은 부서 기본선이 자동으로 채워집니다. 빼거나 더하실 수 있습니다.</div>') +
      '</div></section>';
  }

  function issueRow(f) {
    var clickable = f.rows && f.rows.length;
    return '<button class="issue sv-' + f.sev + '"' + (clickable ? ' data-issue="' + f.k + '"' : ' disabled') + '>' +
      '<span class="ico">' + ic(f.ico, 17) + '</span>' +
      '<span class="bd"><span class="t">' + esc(f.t) + '</span>' +
      '<span class="d">' + esc(f.d) + '</span></span>' +
      '<span class="amt">' + n0(f.n) + '</span>' +
      (clickable ? '<span class="go">' + ic('chev', 15) + '</span>' : '<span style="width:15px"></span>') +
      '</button>';
  }

  function personTable(rows) {
    if (!rows.length) return blank('집계할 운행이 없습니다.', null, 'users');
    var h = '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>이름</th><th>소속</th><th class="n">운행</th><th class="n">거리</th>' +
      '<th class="n">유류비</th><th class="n">통행료</th><th class="n">주차</th>' +
      '<th class="n">합계</th><th class="n">미확정</th>' +
      (isAll() ? '<th></th>' : '') + '</tr></thead><tbody>';
    rows.forEach(function (x) {
      var u = USERS[x.u] || {};
      h += '<tr class="clk" tabindex="0" data-person="' + esc(x.u) + '">' +
        '<td><span class="lead">' + esc(u.name || x.u) + '</span></td>' +
        '<td class="dim">' + esc(u.dept || '—') + '</td>' +
        '<td class="n">' + n0(x.n) + '</td>' +
        '<td class="n">' + km(x.km) + '</td>' +
        '<td class="n">' + n0(x.fuel) + '</td>' +
        '<td class="n">' + n0(x.toll) + '</td>' +
        '<td class="n">' + (x.park ? n0(x.park) : '—') + '</td>' +
        '<td class="n total">' + n0(x.cost) + '</td>' +
        '<td class="n ' + (x.unk ? 'unk' : 'dim') + '">' + (x.unk ? n0(x.unk) : '—') + '</td>' +
        (isAll()
          ? '<td class="n"><button class="btn sm" data-print="' + esc(x.u) + '" ' +
            'title="' + esc(u.name || x.u) + ' 님 운행기록부 인쇄">' + ic('receipt', 13) + '인쇄</button></td>'
          : '') + '</tr>';
    });
    return h + '</tbody></table></div></div>';
  }

  /* ══════════════════ 운행일지 ══════════════════ */
  function tripTable(rows, opt) {
    opt = opt || {};
    if (!rows.length) {
      // 필터를 안 걸었는데 '필터를 바꿔 보세요' 라고 하면 사용자가 헤맨다.
      var on = [];
      if (FILT.who) on.push(nameOf(FILT.who) + ' 님');
      if (FILT.car) on.push(FILT.car);
      if (FILT.q) on.push('"' + FILT.q + '" 검색');
      if (FILT.chip && FILT.chip !== 'all') on.push('점검 항목');
      return blank(
        on.length ? on.join(' · ') + ' 조건에 맞는 운행이 없습니다.' : '이 기간에 운행 기록이 없습니다.',
        on.length ? '아래 전체 보기로 조건을 풀 수 있습니다.' : null, 'list') +
        (on.length ? '<div style="text-align:center;margin-top:-10px;padding-bottom:18px">' +
          '<button class="btn sm" id="btnClearFilt">전체 보기</button></div>' : '');
    }
    var flags = flaggedIds();
    var showWho = isAll() && !opt.compact;
    var h = '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>날짜</th>' + (showWho ? '<th>이름</th>' : '') + '<th>목적</th><th>차량</th>' +
      '<th class="n">거리</th>' + (opt.compact ? '' : '<th class="n">계기판</th>') +
      '<th class="n">통행료</th>' + (opt.compact ? '' : '<th class="n">주차</th>') +
      '<th>방문처</th></tr></thead><tbody>';
    rows.forEach(function (t) {
      var place = t.visit_place || t.end_address || '';
      h += '<tr class="clk' + (flags[t.id] ? ' flagged' : '') + '" data-trip="' + t.id + '">' +
        '<td><span class="lead">' + md(t.start_time) + '</span> <span class="dim">' + hm(t.start_time) + '</span>' +
        (t.is_manual ? ' <span class="kind">수기</span>' : '') + '</td>' +
        (showWho ? '<td>' + esc(nameOf(t.username)) + '</td>' : '') +
        '<td>' + purposeCell(t.purpose) + '</td>' +
        '<td>' + esc(t.plate_no || '—') + '</td>' +
        '<td class="n">' + km(t.distance_km) + '</td>' +
        (opt.compact ? '' : '<td class="n dim">' + n0(t.start_odometer) + ' → ' + n0(t.end_odometer) + '</td>') +
        '<td class="n">' + tollCell(t) + '</td>' +
        (opt.compact ? '' : '<td class="n">' + (t.parking_cost ? n0(t.parking_cost) : '—') + '</td>') +
        '<td class="el" title="' + esc(place) + '">' + esc(place) + '</td></tr>';
    });
    return h + '</tbody></table></div></div>';
  }

  function filtered() {
    var A = audit(), ids = {};
    A.forEach(function (f) { ids[f.k] = {}; (f.rows || []).forEach(function (t) { ids[f.k][t.id] = 1; }); });
    return TRIPS.filter(function (t) {
      if (FILT.who && t.username !== FILT.who) return false;
      if (FILT.car && t.plate_no !== FILT.car) return false;
      if (FILT.q) {
        var s = (t.visit_place || '') + ' ' + (t.end_address || '') + ' ' + (t.start_address || '') +
          ' ' + nameOf(t.username) + ' ' + (t.plate_no || '');
        if (s.toLowerCase().indexOf(FILT.q.toLowerCase()) < 0) return false;
      }
      if (FILT.chip === 'all') return true;
      if (FILT.chip === 'manual') return !!t.is_manual;
      if (FILT.chip === 'commute') return t.purpose === '출퇴근';
      return !!(ids[FILT.chip] && ids[FILT.chip][t.id]);
    });
  }

  function viewTrips() {
    if (!LOADED) return head(scopeTitle('운행일지')) + skeleton();
    var A = audit();
    // 칩 숫자는 '지금 걸린 사람·차량' 안에서 센다(검색어·칩 자신은 빼고).
    var base = TRIPS.filter(function (t) {
      if (FILT.who && t.username !== FILT.who) return false;
      if (FILT.car && t.plate_no !== FILT.car) return false;
      return true;
    });
    var inBase = {}; base.forEach(function (t) { inBase[t.id] = 1; });
    var c = {};
    A.forEach(function (f) {
      c[f.k] = (f.rows || []).filter(function (t) { return inBase[t.id]; }).length;
    });
    var rows = filtered(), t2 = totals(rows);

    // 누구/어느 차로 좁혀 놓았는지 제목에 드러낸다. 그 상태로 인쇄·CSV 를
    // 누르는 실수를 줄인다.
    var narrowed = [];
    if (FILT.who) narrowed.push(nameOf(FILT.who));
    if (FILT.car) narrowed.push(FILT.car);
    var h = head(scopeTitle('운행일지') + (narrowed.length ? ' — ' + narrowed.join(' · ') : ''),
      esc(cycleName(CYC.y, CYC.m)) + ' · ' + esc(cycleSpan(CYC.y, CYC.m)));

    h += '<div class="bar">';
    if (isAll()) {
      // ★ 지금 걸린 사람은 운행이 0건이어도 목록에 남겨야 한다. 안 그러면 셀렉트가
      //   '사람 전체' 로 보이는데 표는 비어 있고, 같은 항목 재선택은 change 가 안 나서
      //   다른 메뉴로 나갔다 오는 수밖에 없었다.
      var us = Object.keys(USERS).filter(function (u) {
        return u === FILT.who || TRIPS.some(function (t) { return t.username === u; });
      }).sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b), 'ko'); });
      h += '<label class="field">' + ic('users', 14) + '<select id="selWho"><option value="">사람 전체</option>' +
        us.map(function (u) {
          return '<option value="' + esc(u) + '"' + (FILT.who === u ? ' selected' : '') + '>' + esc(nameOf(u)) + '</option>';
        }).join('') + '</select></label>';
    }
    var cars = [];
    TRIPS.forEach(function (t) { if (t.plate_no && cars.indexOf(t.plate_no) < 0) cars.push(t.plate_no); });
    cars.sort();
    h += '<label class="field">' + ic('car', 14) + '<select id="selCar"><option value="">차량 전체</option>' +
      cars.map(function (x) {
        return '<option value="' + esc(x) + '"' + (FILT.car === x ? ' selected' : '') + '>' + esc(x) + '</option>';
      }).join('') + '</select></label>';
    h += '<label class="field">' + ic('search', 14) +
      '<input id="qBox" placeholder="방문처·주소·이름" value="' + esc(FILT.q) + '"></label>';
    h += '<div class="sp" style="flex:1"></div>';
    h += '<button class="btn sm" id="btnAddTrip">＋ 운행 추가</button>';
    h += '<button class="btn sm" id="btnCsv">' + ic('dl', 13) + '엑셀</button>';
    h += '</div>';

    h += '<div class="bar"><div class="seg">' +
      seg('all', '전체', base.length) +
      seg('unk', '통행료 미확정', c.unk, 1) +
      seg('jump', '계기판 튐', c.jump) +
      seg('nopurp', '목적 미선택', c.nopurp) +
      seg('overlap', '시간 겹침', c.overlap) +
      seg('zero', '0km', c.zero) +
      seg('manual', '수기', base.filter(function (t) { return t.is_manual; }).length) +
      seg('commute', '출퇴근', base.filter(function (t) { return t.purpose === '출퇴근'; }).length) +
      '</div></div>';

    h += sect(n0(rows.length) + '건', km(t2.km) + ' km · 업무용 ' + won(t2.cost), '', tripTable(rows));
    return h;

    function seg(k, label, n, warnish) {
      if (!n && k !== 'all') return '';
      return '<button data-chip="' + k + '" class="' + (FILT.chip === k ? 'on' : '') +
        (warnish ? ' warnish' : '') + '">' + esc(label) +
        (n ? '<span class="c">' + n0(n) + '</span>' : '') + '</button>';
    }
  }

  /* ══════════════════ 기록 점검 ══════════════════ */
  function viewCheck() {
    if (!LOADED) return head(scopeTitle('기록 점검')) + skeleton();
    var A = audit();
    var found = A.filter(function (f) { return f.n > 0; });
    var okOnes = A.filter(function (f) { return f.n === 0; });

    var h = head(scopeTitle('기록 점검'), esc(cycleName(CYC.y, CYC.m)) + ' · 실제로 사고가 났던 유형만 봅니다');

    if (!found.length) {
      h += '<div class="hero fade"><div class="eyebrow"><span class="dot" style="background:var(--ok)"></span>점검 완료</div>' +
        '<p class="verdict clean"><em>이번 주기는 손볼 것이 없습니다</em></p>' +
        '<div class="facts"><div class="fact"><div class="k">검사 항목</div><div class="v">' +
        A.length + '<small>가지</small></div><div class="sub">전부 이상 없음</div></div></div></div>';
    } else {
      h += sect('발견된 것', found.length + '가지', '',
        '<div class="panel">' + found.map(issueRow).join('') + '</div>');
    }
    if (okOnes.length) {
      h += sect('이상 없음', okOnes.length + '가지', '',
        '<div class="panel">' + okOnes.map(function (f) {
          return '<div class="issue sv-ok" style="cursor:default">' +
            '<span class="ico">' + ic('check', 16) + '</span>' +
            '<span class="bd"><span class="t">' + esc(f.t) + '</span></span>' +
            '<span class="amt" style="color:var(--ok)">0</span><span style="width:15px"></span></div>';
        }).join('') + '</div>');
    }

    h += sect('점검 기준', null, '',
      '<div class="panel" style="padding:18px 20px;font-size:12.5px;line-height:1.95;color:var(--ink-3)">' +
      '<b style="color:var(--ink-2)">계기판이 크게 튄 곳</b> — 같은 사람·같은 차에서 1,000km 이상 벌어진 지점. ' +
      '2026년 9월 감사에서 175,500km 오타가 이렇게 잡혔습니다.<br>' +
      '<b style="color:var(--ink-2)">한 차를 두 사람이</b> — 번호판을 잘못 고르면 남의 차 기록이 됩니다. 18건이 이렇게 섞였었습니다.<br>' +
      '<b style="color:var(--ink-2)">운행목적 미선택</b> · <b style="color:var(--ink-2)">유류단가 미등록</b> — 둘 다 금액이 조용히 0원이 됩니다.<br>' +
      '<b style="color:var(--ink-2)">통행료 미확정</b> — 정산에서 0원으로 잡혀 회사가 덜 내주게 됩니다.</div>');
    return h;
  }

  /* ══════════════════ 증빙 ══════════════════ */
  function viewEvid() {
    if (!LOADED) return head(scopeTitle('증빙')) + skeleton();
    var rows = evidOfCycle().sort(function (a, b) { return b.date_millis - a.date_millis; });
    var h = head(scopeTitle('증빙'), esc(cycleName(CYC.y, CYC.m)) + ' · 앱에서 올린 영수증');
    if (!rows.length) return h + blank('등록된 영수증이 없습니다.', '앱의 증빙 화면에서 올리시면 여기에 모입니다.', 'receipt');

    var sum = rows.reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0);
    var byCat = {};
    rows.forEach(function (e) { var c = e.category || '기타'; byCat[c] = (byCat[c] || 0) + (Number(e.amount) || 0); });

    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>영수증 합계</div>' +
      '<p class="verdict">' + won(sum) + '</p><div class="facts">' +
      Object.keys(byCat).map(function (c) {
        return '<div class="fact"><div class="k">' + esc(c) + '</div><div class="v">' + won(byCat[c]) + '</div></div>';
      }).join('') + '</div></div>';

    h += sect('내역', rows.length + '건', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>날짜</th>' + (isAll() ? '<th>이름</th>' : '') + '<th>구분</th><th>차량</th>' +
      '<th class="n">금액</th><th>메모</th><th></th></tr></thead><tbody>' +
      rows.map(function (e) {
        return '<tr><td><span class="lead">' + md(e.date_millis) + '</span></td>' +
          (isAll() ? '<td>' + esc(nameOf(e.username)) + '</td>' : '') +
          '<td><span class="kind">' + esc(e.category || '기타') + '</span></td>' +
          '<td class="dim">' + esc(e.vehicle_plate || '—') + '</td>' +
          '<td class="n total">' + n0(e.amount) + '</td>' +
          '<td class="el" title="' + esc(e.memo || '') + '">' + esc(e.memo || '') + '</td>' +
          '<td class="n">' + (e.photo_path
            ? '<a class="btn sm" target="_blank" rel="noopener" href="' +
              esc(SB + '/storage/v1/object/public/evidence/' + e.photo_path) + '">사진</a>'
            : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>');
    return h;
  }

  /* ══════════════════ 안전교육 ══════════════════ */
  function viewEdu() {
    if (!LOADED) return head('안전교육') + skeleton();
    var key = eduMonthKey(), mine = myName();
    var myProg = {};
    EDUP.forEach(function (p) { if (p.username === mine) myProg[p.video_id] = p; });
    var round = EDUV.filter(function (v) { return v.month === key; });
    var done = round.filter(function (v) { return myProg[v.id] && myProg[v.id].completed_at; }).length;
    var amTarget = EDUT.some(function (t) { return t.month === key && t.username === mine; });

    var h = head('안전교육', esc(key) + ' 회차');
    var verdict = !round.length ? '이번 회차 영상이 아직 없습니다'
      : done >= round.length ? '<em>이수를 마치셨습니다</em>'
        : amTarget ? '아직 <em>' + (round.length - done) + '편</em> 남았습니다'
          : '의무 대상이 아닙니다';
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"' +
      (done >= round.length && round.length ? ' style="background:var(--ok)"' : '') + '></span>' +
      esc(key) + ' 회차</div>' +
      '<p class="verdict' + (done >= round.length ? ' clean' : '') + '">' + verdict + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">내 이수</div><div class="v">' + done +
      '<small> / ' + round.length + '</small></div><div class="sub">' +
      (amTarget ? '의무 대상입니다' : '의무 대상 아님') + '</div></div>' +
      '<div class="fact"><div class="k">전체 영상</div><div class="v">' + EDUV.length +
      '<small>편</small></div></div></div></div>';

    h += sect('영상', EDUV.length + '편', '', EDUV.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>회차</th><th>제목</th><th>내 진도</th><th class="n"></th></tr></thead><tbody>' +
      EDUV.map(function (v) {
        var p = myProg[v.id];
        var st = p && p.completed_at ? '<span class="st ok">이수</span>'
          : p ? '<span class="st warn">' + (p.progress_pct || 0) + '%</span>'
            : '<span class="st dim">미시청</span>';
        return '<tr><td class="dim">' + esc(v.month) + '</td>' +
          '<td><span class="lead">' + esc(v.title) + '</span>' +
          (v.description ? '<div class="dim" style="font-size:11.5px">' + esc(v.description) + '</div>' : '') + '</td>' +
          '<td>' + st + '</td>' +
          '<td class="n"><a class="btn sm" target="_blank" rel="noopener" href="https://www.youtube.com/watch?v=' +
          esc(v.youtube_id) + '">' + ic('play', 12) + '보기</a></td></tr>';
      }).join('') + '</tbody></table></div></div>' : blank('등록된 영상이 없습니다.', null, 'play'));

    h += '<section class="sect"><div class="panel" style="padding:16px 20px;display:flex;gap:12px;align-items:flex-start">' +
      '<span style="color:var(--warn);margin-top:2px">' + ic('alert', 16) + '</span>' +
      '<div style="font-size:12.5px;color:var(--ink-3);line-height:1.75">' +
      '<b style="color:var(--ink-2)">여기서는 보기만 됩니다.</b> 웹 시청을 이수로 인정하려면 서버가 시청 구간을 ' +
      '검증해야 하는데 아직 만들지 않았습니다. <b style="color:var(--ink-2)">이수는 앱에서 해 주세요.</b>' +
      '</div></div></section>';
    return h;
  }

  /* ══════════════════ 정산 ══════════════════ */
  function viewSettle() {
    if (!LOADED) return head(scopeTitle('정산')) + skeleton();
    var T = totals(TRIPS);
    var byU = {};
    TRIPS.forEach(function (t) { (byU[t.username] = byU[t.username] || []).push(t); });
    var rows = Object.keys(byU).map(function (u) { var x = totals(byU[u]); x.u = u; return x; })
      .sort(function (a, b) { return b.cost - a.cost; });

    var h = head(scopeTitle('정산'), esc(cycleName(CYC.y, CYC.m)) + ' · ' + esc(cycleSpan(CYC.y, CYC.m)));

    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>업무용 비용 합계</div>' +
      '<p class="verdict">' + won(T.cost) + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">유류비</div><div class="v">' + won(T.fuel) +
      '</div><div class="sub">업무거리 ' + km(T.bizKm) + ' km</div></div>' +
      '<div class="fact"><div class="k">통행료</div><div class="v">' + won(T.toll) +
      '</div><div class="sub">' + (T.unk ? '미확정 ' + n0(T.unk) + '건 제외' : '전부 확정') + '</div></div>' +
      '<div class="fact"><div class="k">주차비</div><div class="v">' + won(T.park) + '</div></div>' +
      '</div></div>';

    if (T.unk) {
      h += '<section class="sect"><button class="issue sv-warn" data-issue="unk" style="border-radius:var(--r-lg);border:1px solid var(--line);background:var(--surface)">' +
        '<span class="ico">' + ic('ticket', 17) + '</span>' +
        '<span class="bd"><span class="t">통행료 미확정 ' + n0(T.unk) + '건이 0원으로 계산됐습니다</span>' +
        '<span class="d">채우면 합계가 올라갑니다. 하이패스 대조나 직접 입력으로 확정해 주세요.</span></span>' +
        '<span class="go">' + ic('chev', 15) + '</span></button></section>';
    }

    h += sect(isAll() ? '직원별' : '내 내역', rows.length + (isAll() ? '명' : '건'),
      '<button class="btn sm" data-print="' + esc(myName()) + '">' + ic('receipt', 13) +
        (isAll() ? '내 것 인쇄' : '인쇄용 출력') + '</button>' +
      '<button class="btn sm" id="btnCsv">' + ic('dl', 13) + 'CSV</button>', personTable(rows));

    h += sect('산정 기준', null, '',
      '<div class="panel" style="padding:18px 20px;font-size:12.5px;line-height:1.95;color:var(--ink-3)">' +
      '업무용(<b style="color:var(--ink-2)">' + BUSINESS + '</b>) 운행만 집계합니다.<br>' +
      '유류비 = 분기 기준단가 × (반올림한 도착계기 − 반올림한 출발계기)<br>' +
      '분기 경계 ' + esc(QBOUNDS.map(function (b) { return pad(b[0]) + '-' + pad(b[1]); }).join(' · ')) + '<br>' +
      '<b style="color:var(--ink-2)">서버 월간리포트와 같은 식</b>을 씁니다 — 두 숫자가 다르면 버그입니다.</div>');
    return h;
  }

  /* ══════════════════ 인쇄용 출력 ══════════════════
     운행기록부 + 영수증 4종을 한 번에 인쇄한다(브라우저의 'PDF로 저장' 이 곧 한 권).

     ★ 왜 서버에서 PDF 를 만들지 않는가
       서버에서 만들려면 한글 글꼴을 PDF 안에 심어야 한다(5MB 급). 함수가 무거워지고
       글꼴이 조금만 어긋나도 글자가 깨진다. 게다가 영수증 282장을 서버가 내려받아
       다시 넣어야 한다. 브라우저는 한글 글꼴도, 사진도 이미 갖고 있다.
       그래서 화면을 인쇄 규격(A4)으로 짜고 브라우저에 맡긴다 — 미리보기도 공짜다.  */

  /** 사내 양식 결재란. 배정 안 된 칸은 빗금으로 지운다. */
  var FORM_BOXES = ['담당', '팀장', '실장', '사업부장', '대표이사'];
  /** 기본지급액 — 사내 양식 수식 그대로(ExcelExporter.kt 291행). */
  function basePay(km) {
    if (km <= 499) return 0;
    if (km <= 999) return 70000;
    if (km <= 1499) return 90000;
    if (km <= 1999) return 110000;
    if (km <= 2499) return 130000;
    return 150000;
  }
  /** 주소에서 동/읍/면/가/리 까지만 남긴다 — 앱 Format.dong 과 같은 규칙. */
  function dong(addr) {
    if (!addr) return '';
    var cleaned = String(addr).replace(/,/g, ' ').trim().replace(/\s+/g, ' ');
    var parts = cleaned.split(' '), out = [];
    for (var i = 0; i < parts.length; i++) {
      out.push(parts[i]);
      if (/[동읍면가리]$/.test(parts[i])) return out.join(' ');
    }
    var out2 = [];
    for (var j = 0; j < parts.length; j++) {
      if (/^\d/.test(parts[j])) break;
      out2.push(parts[j]);
    }
    return out2.length ? out2.join(' ') : cleaned;
  }

  /* ── 운행기록부 한 장 ────────────────────────────────────────────────
     ★ 앱 ExcelExporter.kt 와 '완전히 같은 값'이 나와야 한다.
       이 문서는 monthly-report(경영진 리포트)와 규칙이 다르다 —
       리포트는 업무용만 집계하지만, 운행기록부는 **목적과 무관하게 모든 행**을 계산한다.
       처음에 리포트 규칙으로 만들었다가 전부 뜯어고쳤다(2026-09-15).

     앱과 맞춘 것 (ExcelExporter.kt 근거 행)
       · 운행일자    yyyy-MM-dd                         (Format.date, dateFmt 35행)
       · 출발/도착   FuelCost.odo() = 반올림             (327~337행)
       · 운행거리    H − G (각각 반올림한 뒤 뺀다)        (338행, FuelCost 주석)
       · 유류비      MAX(0, 운행거리) × 그 운행의 단가    (347행) ← 목적 무관
       · 주차비      운행 주차비 + 그날 첫 행에만 영수증  (349~355행)
       · 통행료      tollAmountForExport + 영수증         (357행, TollCharge.kt 126행)
       · 금액합계    SUM(유류+주차+통행)                  (359행) ← 목적 무관
       · 근거자료만 있는 날은 별도 행                     (363~377행)
       · 합계 행 '운행 내역 합계' / 총계 행 '당월 차량운행비 총계' (383~412행)
       · 단가가 두 종류 이상이면 지역별 분해 행           (223~240행)                */

  /** 앱 FuelCost.odo — 반올림. 버림·올림을 쓰면 계기판 원장과 어긋난다. */
  function odoInt(v) {
    var n = Number(v);
    return (!isFinite(n)) ? 0 : Math.round(n);
  }
  /** 앱 TollCharge.tollAmountForExport — 확정 상태면 금액+영수증, 미확정이면 영수증만(0이면 빈칸). */
  var TOLL_MAX = 200000;                 // TollCharge.MAX_AMOUNT 와 같아야 한다
  /**
   * 앱 TollCharge.tollAmountForExport 와 같은 값을 낸다.
   *
   * ★ 앱은 상태와 금액이 규약을 어기면(예: UNKNOWN 인데 금액이 있음) 객체를 만들지 못하고
   *   TollCharge.legacy(금액) 로 되돌린 뒤 내보낸다(TripEntity.kt 79~91행).
   *   웹에 그 단계가 없어, 상태·금액이 손상된 옛 기록에서 앱과 다른 값이 나왔다.
   *   9월분 실데이터에는 그런 조합이 없지만 과거 회차·다른 기기 병합분에는 생길 수 있다.
   */
  function tollForExport(t, evAmount) {
    var ev = Math.max(0, Number(evAmount) || 0);
    var st = t.toll_status;
    var amt = t.toll_cost == null ? null : Number(t.toll_cost);
    if (amt != null && !isFinite(amt)) amt = null;

    // 앱의 require() 와 같은 검사. 어기면 legacy 로 되돌린다.
    var ok =
      (st === 'UNKNOWN' || st === 'PENDING') ? amt === null
      : st === 'CHARGED' ? (amt !== null && amt >= 1 && amt <= TOLL_MAX)
      : st === 'FREE_CONFIRMED' ? amt === 0
      : st === 'MANUAL' ? (amt !== null && amt >= 0 && amt <= TOLL_MAX)
      : false;                               // 알 수 없는 상태도 legacy 로
    if (!ok) {
      if (amt != null && amt > 0) { st = 'MANUAL'; amt = Math.min(amt, TOLL_MAX); }
      else { st = 'UNKNOWN'; amt = null; }
    }
    // UNKNOWN·PENDING 은 비워 두고, 근거가 있는 0원만 실제 0 으로 내보낸다.
    if (st === 'UNKNOWN' || st === 'PENDING') return ev > 0 ? ev : null;
    return (amt || 0) + ev;
  }
  /** 그 운행에 적용되는 유류 단가(원/km). 지역·분기로 고른다. */
  function rateOf(t) {
    var v = RATES[rateKeyOf(t)];
    return v != null ? v : FUEL_DEFAULT;
  }
  function rateKeyOf(t) {
    var q = quarterOf(Number(t.start_time));
    return q.y + '-' + q.q + '-' + region(t.start_address || '', t.start_lat, t.start_lng);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  인쇄 — 앱 ExcelExporter.exportRange 와 같은 양식
  //  ---------------------------------------------------------------------
  //  ★ 앱은 '차량 1대 = 1장'이다(MainViewModel.exportRange 가 vehicleId 로
  //    조회한다). 웹도 사람이 아니라 차량으로 나눈다. 한 회차에 두 대를 몬
  //    사람은 두 장이 나온다. 영수증 금액도 그 차량 것만 더한다.
  //  ★ 찍는 기간이 마감주기(전월21~당월20)라 달력월이 아니다 → 앱의
  //    export(월) 가 아니라 exportRange(임의기간) 쪽 문구를 쓴다.
  //  한 곳을 고치면 ExcelExporter.kt / .swift 도 같이 고쳐야 한다.
  // ═══════════════════════════════════════════════════════════════════════
  function buildPrint(who) {
    var mine = who || myName();
    var u = personOf(mine);
    var r = cycleRange(CYC.y, CYC.m);
    var a = APPR.filter(function (x) { return x.username === mine && x.cycle === CYCKEY(); })[0];

    // ★ 목적을 먼저 거른다. 앱도 거른 목록을 넘기므로, 차량 분리·영수증 합산·
    //   근거자료 행·합계가 모두 거른 뒤 기준이 된다.
    var all = TRIPS.filter(function (t) {
      return t.username === mine && PRINT_PURPOSES.indexOf(t.purpose || '') >= 0;
    });
    // 차량별로 나눈다. 순서는 그 차의 첫 운행 시각.
    var byPlate = {}, plates = [];
    all.forEach(function (t) {
      var p = t.plate_no || '';
      if (!byPlate[p]) { byPlate[p] = []; plates.push(p); }
      byPlate[p].push(t);
    });
    if (!plates.length) { plates = [u.plate_no || '']; byPlate[plates[0]] = []; }
    plates.sort(function (x, y) {
      return minStart(byPlate[x]) - minStart(byPlate[y]);
    });

    var h = '';
    plates.forEach(function (p) { h += printSheet(mine, u, p, byPlate[p], r, a); });
    h += printEvidencePages(mine, u, r);
    return h;
  }

  function minStart(list) {
    return list.reduce(function (m, t) {
      var v = Number(t.start_time) || 0;
      return m == null || v < m ? v : m;
    }, null) || 0;
  }

  /** 운행기록부 한 장 = 차량 한 대. 앱 ExcelExporter.buildSheetXml 과 같은 순서로 만든다. */
  function printSheet(mine, u, plate, list, r, a) {
    // 앱 188행: 같은 날이면 계기판 순, 그 다음 시각 순.
    var rows = list.slice().sort(function (x, y) {
      return dayNo(x.start_time) - dayNo(y.start_time)
        || odoInt(x.start_odometer) - odoInt(y.start_odometer)
        || x.start_time - y.start_time;
    });
    var veh = VEHICLES.filter(function (v) {
      return v.username === mine && (v.plate_no || '') === plate;
    })[0] || {};

    // ── 근거자료(영수증) 금액을 날짜별로 모은다 (앱 196~215행) ──
    //    앱은 그 차량 것만 본다(evidenceForRange(vehicleId)). 웹은 차량번호로 맞춘다.
    // 이 사람이 이번 회차에 차를 한 대만 썼다면, 차량번호가 빈 영수증도 그 차 것으로 본다.
    // (차량을 지웠다 복원하면 번호판이 비어 저장된다. 앱도 같은 예외를 둔다 —
    //  안 두면 그 금액이 기록부에서 통째로 사라진다.)
    var onlyOneCar = (function () {
      var seen = {};
      TRIPS.forEach(function (t) { if (t.username === mine && t.plate_no) seen[t.plate_no] = 1; });
      return Object.keys(seen).length <= 1;
    })();
    var evPark = {}, evToll = {};
    EVID.forEach(function (e) {
      var d = Number(e.date_millis);
      if (e.username !== mine || !(d >= r.lo && d < r.hi)) return;
      var ep = (e.vehicle_plate || '');
      if (ep !== plate && !(ep === '' && onlyOneCar)) return;
      if (!(Number(e.amount) > 0)) return;
      var k = ymd(d);
      if (e.category === '주차') evPark[k] = (evPark[k] || 0) + Number(e.amount);
      if (e.category === '통행료') evToll[k] = (evToll[k] || 0) + Number(e.amount);
    });
    var tripDates = {};
    rows.forEach(function (t) { tripDates[ymd(t.start_time)] = 1; });
    // 운행이 하나도 없는 날의 영수증은 붙일 행이 없어 증발한다 → 별도 행으로 남긴다(앱 363~377행).
    var orphan = Object.keys(evPark).concat(Object.keys(evToll))
      .filter(function (d, i, arr) { return arr.indexOf(d) === i && !tripDates[d]; }).sort();

    // ── 행을 만들면서 합계를 함께 낸다 ──
    var seen = {}, body = '';
    var sumKm = 0, sumFuel = 0, sumPark = 0, sumToll = 0, sumAll = 0;
    var partMap = {};                     // 지역·단가별 분해

    rows.forEach(function (t) {
      var g = odoInt(t.start_odometer), hh = odoInt(t.end_odometer);
      var dist = hh - g;                                   // 앱 I열 = H−G (음수도 그대로)
      var rate = rateOf(t);
      var fuel = Math.max(0, dist) * rate;                 // 앱 J열 = MAX(0,I)×단가. 목적 무관.
      var day = ymd(t.start_time);
      var first = !seen[day]; seen[day] = 1;               // 그날 첫 운행 행에만 영수증을 붙인다
      var exP = first ? (evPark[day] || 0) : 0;
      var exT = first ? (evToll[day] || 0) : 0;
      var park = (Number(t.parking_cost) || 0) + exP;
      var toll = tollForExport(t, exT);
      var total = fuel + park + (toll || 0);               // 앱 M열 = SUM(J:L)

      sumKm += dist; sumFuel += fuel; sumPark += park;
      sumToll += (toll || 0); sumAll += total;
      if (rate > 0 && dist > 0) {
        var rg = region(t.start_address || '', t.start_lat, t.start_lng);
        var key = rg + '|' + rate;
        var pp = partMap[key] = partMap[key] || { region: rg, rate: rate, km: 0, amount: 0 };
        pp.km += dist; pp.amount += fuel;
      }

      body += '<tr>' +
        '<td>' + day + '</td>' +
        '<td>' + esc(dong(t.start_address)) + '</td>' +
        '<td>' + esc(dong(t.end_address)) + '</td>' +
        '<td>' + esc(t.visit_place || '') + '</td>' +
        '<td>' + esc(t.purpose || '') + '</td>' +
        '<td>' + (t.is_manual ? '수기' : '자동') + '</td>' +
        '<td class="n">' + n0(g) + '</td>' +
        '<td class="n">' + n0(hh) + '</td>' +
        '<td class="n">' + n0(dist) + '</td>' +
        // 앱은 수식 결과에 #,##0 서식이라 0 도 '0' 으로 찍힌다. 빈 칸으로 두면 안 된다.
        '<td class="n">' + n0(fuel) + '</td>' +
        '<td class="n">' + (park > 0 ? n0(park) : '') + '</td>' +
        '<td class="n">' + (toll == null ? '' : n0(toll)) + '</td>' +
        '<td class="n">' + n0(total) + '</td></tr>';
    });

    orphan.forEach(function (d) {
      var p = evPark[d] || 0, tl = evToll[d] || 0, total = p + tl;
      sumPark += p; sumToll += tl; sumAll += total;
      body += '<tr><td>' + d + '</td><td></td><td></td><td></td>' +
        '<td>근거자료</td><td>영수증</td><td></td><td></td><td></td><td></td>' +
        '<td class="n">' + (p > 0 ? n0(p) : '') + '</td>' +
        '<td class="n">' + (tl > 0 ? n0(tl) : '') + '</td>' +
        '<td class="n">' + (total ? n0(total) : '') + '</td></tr>';
    });
    if (!body) body = '<tr>' + new Array(14).join('<td>&nbsp;</td>') + '</tr>';

    // 단가가 한 종류뿐이면 합계와 같은 값이라 분해 행을 넣지 않는다(앱 238행)
    var parts = Object.keys(partMap).map(function (k) { return partMap[k]; })
      .sort(function (x, y) {
        return (x.region === '수도권' ? 0 : 1) - (y.region === '수도권' ? 0 : 1) || x.rate - y.rate;
      });
    if (parts.length < 2) parts = [];

    // ── 결재란 ── (칸 배정은 결재선을 따르고, 해당 없는 칸은 빗금)
    var boxMap = { 담당: { name: u.name || mine, at: a && a.submitted_at } };
    ((a && a.steps) || []).forEach(function (s) {
      if (s.box && FORM_BOXES.indexOf(s.box) > 0) {
        // ★ 승인한 칸에만 이름·날짜를 찍는다.
        //   아직 결재 안 했거나 반려한 사람의 이름을 찍으면 서명처럼 보여
        //   사내 결재 문서가 위조로 오해된다(2026-09-15 지적). 그 칸은 비워서
        //   앱 엑셀처럼 도장을 찍을 수 있게 둔다.
        boxMap[s.box] = (s.result === 'approved')
          ? { name: s.name || s.approver, at: s.acted_at }
          : { name: '', at: null };
      }
    });

    var h = '<section class="psheet">';
    h += '<h1 class="ptitle">차량운행내역기록부</h1>';
    h += '<p class="psub">' + esc(periodLabel()) + '</p>';      // 앱 Row 2
    h += '<div class="phead"><table class="pinfo"><tbody>' +
      pinfo('부 서', esc([u.company_name, u.dept].filter(Boolean).join(' ').trim())) +
      pinfo('성 명', esc(u.name || mine)) +
      pinfo('차량번호', esc(plate)) +
      // 앱 255행: 차량 레코드 우선, 비어 있으면 프로필 값.
      pinfo('차 종', esc(veh.vehicle_type || u.vehicle_type || '')) +
      '</tbody></table>' +
      '<table class="pappr"><tbody><tr><th rowspan="2" class="plabel">결<br>재</th>' +
      FORM_BOXES.map(function (b) { return '<th>' + b + '</th>'; }).join('') + '</tr><tr>' +
      FORM_BOXES.map(function (b) {
        var v = boxMap[b];
        if (!v) return '<td class="pslash"></td>';
        return '<td class="psign">' + esc(v.name) +
          (v.at ? '<span>' + md(Date.parse(v.at)) + '</span>' : '') + '</td>';
      }).join('') + '</tr></tbody></table></div>';

    h += '<table class="psum"><tbody><tr>' +
      '<th>총 운행거리(Km)</th><td class="n">' + n0(sumKm) + '</td>' +
      '<th>기본지급액(원)</th><td class="n">' + n0(basePay(sumKm)) + '</td>' +
      '<th>■ 유류 기준단가</th><td class="n">' + esc(fuelLabel()) + '</td>' +
      '</tr></tbody></table>';

    h += '<table class="plog"><thead><tr>' +
      ['운행일자', '출발지역', '도착지역', '방문처', '업무<br>구분', '입력<br>구분',
        '출발시<br>키로수', '도착시<br>키로수', '운행거리<br>(km)', '유류비', '주차비', '통행료', '금액합계']
        .map(function (x) { return '<th>' + x + '</th>'; }).join('') + '</tr></thead><tbody>' +
      body + '</tbody><tfoot>';

    h += '<tr class="ptot"><th colspan="8">운행 내역 합계</th>' +
      '<td class="n">' + n0(sumKm) + '</td><td class="n">' + n0(sumFuel) + '</td>' +
      '<td class="n">' + n0(sumPark) + '</td><td class="n">' + n0(sumToll) + '</td>' +
      '<td class="n">' + n0(sumAll) + '</td></tr>';
    parts.forEach(function (p) {
      h += '<tr class="ppart"><th colspan="8">└&nbsp; ' + esc(p.region) + ' 출발 &nbsp;×&nbsp; ' +
        n0(p.rate) + '원/km</th>' +
        '<td class="n">' + n0(p.km) + '</td><td class="n">' + n0(p.amount) + '</td>' +
        '<td></td><td></td><td></td></tr>';
    });
    h += '<tr class="pgrand"><th colspan="12">당월 차량운행비 총계</th>' +
      '<td class="n">' + n0(sumAll) + '</td></tr>';
    h += '</tfoot></table></section>';
    return h;
  }

  /** 영수증 사진 — 앱 엑셀에는 없는 웹 추가분(기록부 양식 자체는 건드리지 않는다). */
  function printEvidencePages(mine, u, r) {
    var evid = EVID.filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === mine && d >= r.lo && d < r.hi && e.photo_path;
    }).sort(function (x, y) { return x.date_millis - y.date_millis; });
    var h = '';
    ['계기판', '주유', '주차', '통행료'].forEach(function (cat) {
      var list = evid.filter(function (e) { return (e.category || '') === cat; });
      if (!list.length) return;
      var one = cat === '계기판', per = one ? 1 : 4;
      for (var i = 0; i < list.length; i += per) {
        var page = list.slice(i, i + per);
        var s = page.reduce(function (acc, e) { return acc + (Number(e.amount) || 0); }, 0);
        h += '<section class="psheet"><div class="prhead">' +
          '<b>' + esc(cat) + '</b>' +
          '<span>' + esc(u.name || mine) + ' · ' + esc(cycleName(CYC.y, CYC.m)) + '</span>' +
          '<span class="pg">' + (Math.floor(i / per) + 1) + ' / ' + Math.ceil(list.length / per) + '</span>' +
          (one ? '' : '<span class="psum2">합계 ' + won(s) + '</span>') + '</div>' +
          '<div class="prgrid' + (one ? ' one' : '') + '">' +
          page.map(function (e) {
            return '<figure><img loading="eager" src="' +
              esc(SB + '/storage/v1/object/public/evidence/' + e.photo_path) + '" alt="">' +
              '<figcaption>' + md(e.date_millis) +
              (e.amount ? ' · ' + won(e.amount) : '') +
              (e.vehicle_plate ? ' · ' + esc(e.vehicle_plate) : '') +
              (e.memo ? ' · ' + esc(e.memo) : '') + '</figcaption></figure>';
          }).join('') + '</div></section>';
      }
    });
    return h;
  }

  /** KST 기준 며칠째인가 — 앱 188행의 정렬 키와 같은 식. */
  function dayNo(ms) { return Math.floor((Number(ms) + 9 * 3600e3) / 86400e3); }

  /**
   * 앱 ExcelExporter.exportRange 103행: "(기간 : yyyy-MM-dd ~ yyyy-MM-dd)"
   * 끝날짜는 포함이므로 회차 끝(hi)에서 하루를 뺀 날이다.
   */
  function periodLabel() {
    var r = cycleRange(CYC.y, CYC.m);
    return '(기간 : ' + ymd(r.lo) + ' ~ ' + ymd(r.hi - 1) + ')';
  }

  function pinfo(k, v) { return '<tr><th>' + k + '</th><td>' + v + '</td></tr>'; }

  /**
   * 앱 ExcelExporter.exportRange 106~110행과 같은 문구.
   *   같은 분기 + 단가 둘 다 등록 → "수도권 191·지방 192원"
   *   같은 분기 + 미등록       → "2026 3분기 기준"
   *   분기가 걸치면            → "기간 분기·지역별 적용"
   */
  function fuelLabel() {
    var r = cycleRange(CYC.y, CYC.m);
    var s = quarterOf(r.lo), e = quarterOf(r.hi - 1);
    if (s.y !== e.y || s.q !== e.q) return '기간 분기·지역별 적용';
    var m = RATES[s.y + '-' + s.q + '-수도권'], l = RATES[s.y + '-' + s.q + '-지방'];
    if (m != null && l != null) return '수도권 ' + m + '·지방 ' + l + '원';
    return s.y + ' ' + s.q + '분기 기준';
  }

  /** 인쇄 전에 담을 운행목적을 고르게 한다. 앱 내보내기 창과 같은 자리다. */
  function doPrint(who) {
    if (!LOADED) { toast('아직 불러오는 중입니다.'); return; }
    // 개인 화면에서는 본인 것만 뽑는다. 남의 이름으로 부르면 운행은 없어도
    // 머리 정보(이름·부서·차량)가 찍히므로 여기서 막는다.
    if (who && who !== myName() && !isAll()) {
      toast('다른 분 운행기록부는 관리 › 전체 정산에서 뽑을 수 있습니다.', true);
      return;
    }
    var target = who || myName();
    $('pTitle').textContent = '운행기록부 인쇄';
    $('pSub').textContent = nameOf(target) + ' · ' + cycleName(CYC.y, CYC.m) + ' · ' + cycleSpan(CYC.y, CYC.m);
    $('pBody').innerHTML =
      '<div class="form"><div class="frow"><label class="flab">담을 운행</label><div class="fbody">' +
      '<div class="radios">' + PURPOSES.map(function (p) {
        return '<label class="radio"><input type="checkbox" name="ppurp" value="' + esc(p) + '"' +
          (PRINT_PURPOSES.indexOf(p) >= 0 ? ' checked' : '') + '><span>' + esc(p) + '</span></label>';
      }).join('') + '</div>' +
      '<div class="fhint">차량일지를 <b>제출</b>하실 때는 <b>일반업무</b>만 고르십시오. ' +
      '앱에서 엑셀로 내려받을 때와 같은 기준입니다.</div>' +
      '</div></div></div>' +
      '<div class="anote">운행기록부 뒤에 <b>영수증 사진</b>이 함께 붙습니다. ' +
      '브라우저 인쇄 창에서 <b>PDF로 저장</b>을 고르시면 파일로 남길 수 있습니다.</div>';
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnPrintGo" data-who="' + esc(target) + '">인쇄</button>';
    $('panel').classList.add('open');
  }

  /** 고른 목적으로 실제 인쇄물을 만들어 인쇄 창을 연다. */
  function runPrint(who) {
    var picked = Array.prototype.slice
      .call(document.querySelectorAll('input[name="ppurp"]:checked'))
      .map(function (x) { return x.value; });
    if (!picked.length) { toast('담을 운행을 한 가지 이상 고르세요.', true); return; }
    PRINT_PURPOSES = picked;
    closePanel();
    var host = $('printArea');
    host.innerHTML = buildPrint(who);
    if (!host.querySelector('table.plog tbody tr td:not(:empty)')) {
      toast('고르신 목적에 해당하는 운행이 없습니다.', true); return;
    }
    var imgs = Array.prototype.slice.call(host.querySelectorAll('img'));
    var left = imgs.length;
    toast(left ? '영수증 ' + left + '장을 불러오는 중입니다…' : '인쇄 창을 엽니다…');
    if (!left) { setTimeout(function () { window.print(); }, 120); return; }
    // 사진이 다 뜬 뒤에 인쇄해야 빈 칸으로 찍히지 않는다.
    var fire = function () { if (--left <= 0) setTimeout(function () { window.print(); }, 200); };
    imgs.forEach(function (im) {
      if (im.complete) { fire(); return; }
      im.addEventListener('load', fire, { once: true });
      im.addEventListener('error', function () { im.style.display = 'none'; fire(); }, { once: true });
    });
    setTimeout(function () { if (left > 0) { left = 0; window.print(); } }, 15000);   // 그래도 안 뜨면 그냥 연다
  }

  function downloadCsv() {
    var head2 = ['날짜', '시각', '이름', '소속', '차량', '목적', '출발지', '도착지', '방문처',
      '출발계기판', '도착계기판', '거리km', '유류비', '통행료', '통행료상태', '주차비', '입력방식'];
    var lines = [head2.join(',')];
    // 화면에서 좁혀 놓은 그대로 내보낸다. 예전에는 12건으로 좁혀 놓고 눌러도
    //   1,800건이 나왔다.
    filtered().slice().sort(function (a, b) { return a.start_time - b.start_time; }).forEach(function (t) {
      var u = USERS[t.username] || {};
      var row = [ymd(t.start_time), hm(t.start_time), u.name || t.username, u.dept || '',
        t.plate_no || '', t.purpose || '', t.start_address || '', t.end_address || '', t.visit_place || '',
        t.start_odometer, t.end_odometer, t.distance_km,
        Math.round(tripFuel(t)), t.toll_cost == null ? '' : t.toll_cost,
        isUnknownToll(t) ? '미확정' : '확정', t.parking_cost == null ? '' : t.parking_cost,
        t.is_manual ? '수기' : '자동'];
      lines.push(row.map(function (v) {
        var s = String(v == null ? '' : v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','));
    });
    // 엑셀이 UTF-8 을 알아보게 BOM 을 붙인다. 없으면 한글이 깨진다.
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ATEC_운행일지_' + CYC.y + '-' + pad(CYC.m) + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('CSV 를 내려받았습니다.');
  }

  /* ══════════════════ 관리 화면 ══════════════════ */
  function viewPeople() {
    if (!LOADED) return head('직원 현황') + skeleton();
    var list = Object.keys(USERS).map(function (u) { return USERS[u]; })
      .sort(function (a, b) {
        return (a.dept || '힣').localeCompare(b.dept || '힣', 'ko') ||
          (a.name || '').localeCompare(b.name || '', 'ko');
      });
    var byU = {};
    TRIPS.forEach(function (t) { (byU[t.username] = byU[t.username] || []).push(t); });
    var idle = list.filter(function (u) { return !(byU[u.username] || []).length; }).length;

    var h = head('직원 현황', list.length + '명 · ' + esc(cycleName(CYC.y, CYC.m)));
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>이번 주기</div>' +
      '<p class="verdict">' + (idle ? '<em>' + idle + '명</em>이 한 건도 기록하지 않았습니다' : '<em>전원 기록</em>했습니다') + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">등록 인원</div><div class="v">' + list.length + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">기록 있음</div><div class="v">' + (list.length - idle) + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">기록 없음</div><div class="v' + (idle ? ' alert' : '') + '">' + idle + '<small>명</small></div></div>' +
      '</div></div>';

    h += sect('명단', list.length + '명', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>이름</th><th>소속</th><th>직급</th><th>차량</th><th class="n">운행</th>' +
      '<th class="n">거리</th><th class="n">비용</th><th></th></tr></thead><tbody>' +
      list.map(function (u) {
        var x = totals(byU[u.username] || []);
        return '<tr class="clk" tabindex="0" data-person="' + esc(u.username) + '">' +
          '<td><span class="lead">' + esc(u.name || u.username) + '</span>' +
          '<div class="dim" style="font-size:11px">' + esc(u.username) + '</div></td>' +
          '<td>' + esc(u.dept || '—') + '</td><td class="dim">' + esc(u.position || '—') + '</td>' +
          '<td class="dim">' + esc(u.plate_no || '—') + '</td>' +
          '<td class="n' + (x.n ? '' : ' dim') + '">' + n0(x.n) + '</td>' +
          '<td class="n">' + (x.km ? km(x.km) : '—') + '</td>' +
          '<td class="n total">' + (x.cost ? n0(x.cost) : '—') + '</td>' +
          '<td>' + (u.is_admin ? '<span class="st bad">관리자</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>');
    return h;
  }

  function viewCars() {
    if (!LOADED) return head('차량') + skeleton();
    var used = {};
    TRIPS.forEach(function (t) {
      var v = used[t.plate_no] = used[t.plate_no] || { n: 0, km: 0, users: {}, min: Infinity, max: -Infinity };
      v.n++; v.km += Number(t.distance_km) || 0; v.users[t.username] = 1;
      if (t.start_odometer != null) { v.min = Math.min(v.min, +t.start_odometer); v.max = Math.max(v.max, +t.end_odometer); }
    });
    var plates = Object.keys(used).sort();
    var problem = plates.filter(function (p) {
      return Object.keys(used[p].users).length > 1 || (isFinite(used[p].min) && used[p].max - used[p].min > 10000);
    });

    var h = head('차량', plates.length + '대 운행 · ' + esc(cycleName(CYC.y, CYC.m)));
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"' +
      (problem.length ? '' : ' style="background:var(--ok)"') + '></span>차량 배정</div>' +
      '<p class="verdict' + (problem.length ? '' : ' clean') + '">' +
      (problem.length ? '<em>' + problem.length + '대</em>에 이상이 있습니다' : '<em>이상 없습니다</em>') + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">운행한 차량</div><div class="v">' + plates.length + '<small>대</small></div></div>' +
      '<div class="fact"><div class="k">등록된 차량</div><div class="v">' + VEHICLES.length + '<small>대</small></div></div>' +
      '</div></div>';

    h += sect('이번 주기에 운행된 차량', plates.length + '대', '',
      plates.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
        '<th>번호판</th><th>사용자</th><th class="n">운행</th><th class="n">거리</th>' +
        '<th class="n">계기판</th><th>비고</th></tr></thead><tbody>' +
        plates.map(function (p) {
          var v = used[p], us = Object.keys(v.users);
          var multi = us.length > 1, wide = isFinite(v.min) && (v.max - v.min) > 10000;
          return '<tr class="clk' + (multi || wide ? ' flagged' : '') + '" data-car="' + esc(p) + '">' +
            '<td><span class="lead">' + esc(p) + '</span></td>' +
            '<td>' + esc(us.map(nameOf).join(', ')) + '</td>' +
            '<td class="n">' + n0(v.n) + '</td><td class="n">' + km(v.km) + '</td>' +
            '<td class="n dim">' + (isFinite(v.min) ? n0(v.min) + ' – ' + n0(v.max) : '—') + '</td>' +
            '<td>' + (multi ? '<span class="st bad">사용자 ' + us.length + '명</span> ' : '') +
            (wide ? '<span class="st bad">계기판 폭 ' + n0(v.max - v.min) + 'km</span>' : '') +
            (!multi && !wide ? '<span class="st dim">정상</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>' : blank('운행 기록이 없습니다.', null, 'car'));

    if (VEHICLES.length) {
      h += sect('등록된 차량', VEHICLES.length + '대', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
        '<th>번호판</th><th>사용자</th><th>차종</th><th class="n">누적 km</th></tr></thead><tbody>' +
        VEHICLES.slice().sort(function (a, b) { return (a.plate_no || '').localeCompare(b.plate_no || ''); })
          .map(function (v) {
            return '<tr><td><span class="lead">' + esc(v.plate_no) + '</span></td>' +
              '<td>' + esc(nameOf(v.username)) + '</td>' +
              '<td class="dim">' + esc(v.vehicle_type || '—') + '</td>' +
              '<td class="n">' + n0(v.cumulative_km) + '</td></tr>';
          }).join('') + '</tbody></table></div></div>');
    }
    return h;
  }

  function viewEduAdm() {
    if (!LOADED) return head('교육 관리') + skeleton();
    var key = eduMonthKey();
    var tg = EDUT.filter(function (t) { return t.month === key; });
    var vids = EDUV.filter(function (v) { return v.month === key; });
    var doneBy = {};
    EDUP.forEach(function (p) {
      if (!p.completed_at) return;
      var v = EDUV.filter(function (x) { return x.id === p.video_id; })[0];
      if (v && v.month === key) doneBy[p.username] = (doneBy[p.username] || 0) + 1;
    });
    // 영상을 아직 안 올린 회차에서는 이수 여부를 따질 수 없다. 예전에는
    //   full=0 이 되어 "12명이 아직 안 들었습니다" 라는 거짓 경보가 났다.
    var full = tg.filter(function (t) { return vids.length > 0 && (doneBy[t.username] || 0) >= vids.length; }).length;
    var left = vids.length ? tg.length - full : 0;

    var h = head('교육 관리', esc(key) + ' 회차');
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"' +
      (left ? '' : ' style="background:var(--ok)"') + '></span>' + esc(key) + ' 회차 이수</div>' +
      '<p class="verdict' + (left ? '' : ' clean') + '">' +
      (!tg.length ? '의무 대상자가 아직 없습니다'
        : left ? '<em>' + left + '명</em>이 아직 안 들었습니다' : '<em>전원 이수</em>했습니다') + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">의무 대상</div><div class="v">' + tg.length + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">이수 완료</div><div class="v">' + full + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">이번 회차 영상</div><div class="v">' + vids.length + '<small>편</small></div></div>' +
      '</div></div>';

    if (!tg.length) return h + blank('대상자 명단이 없습니다.', '앱 교육 관리에서 회차를 시작하면 만들어집니다.', 'cap');

    h += sect('대상자', tg.length + '명', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>이름</th><th>소속</th><th class="n">안전점수</th><th class="n">운행</th><th>이수</th></tr></thead><tbody>' +
      tg.slice().sort(function (a, b) { return (doneBy[a.username] || 0) - (doneBy[b.username] || 0); })
        .map(function (t) {
          var u = USERS[t.username] || {}, d = doneBy[t.username] || 0;
          var ok = vids.length > 0 && d >= vids.length;
          return '<tr' + (ok ? '' : ' class="flagged"') + '>' +
            '<td><span class="lead">' + esc(u.name || t.username) + '</span></td>' +
            '<td class="dim">' + esc(u.dept || '—') + '</td>' +
            '<td class="n">' + (t.avg_score == null ? '—' : n0(t.avg_score)) + '</td>' +
            '<td class="n">' + n0(t.trip_count) + '</td>' +
            '<td>' + (ok ? '<span class="st ok">완료</span>'
              : '<span class="st warn">' + d + ' / ' + vids.length + '</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>');
    return h;
  }

  /* ══════════════════ 하이패스 대조 ══════════════════
     한국도로공사 영수증 PDF 를 읽어 통행료를 확정한다.
     ★ 사람이 직접 정한 값은 기본으로 덮지 않는다 — 관리자가 눈으로 보고 고른다.
       (서버 보호 트리거 old_by_person 과 같은 기준. hipass.js bySource 참고) */
  var HP = { groups: [], batch: '', busy: false, note: '' };

  function viewHipass() {
    if (!LOADED) return head(isAll() ? '하이패스 대조 (전체)' : '하이패스 대조') + skeleton();
    var h = head(isAll() ? '하이패스 대조 (전체)' : '하이패스 대조',
      isAll() ? '영수증 PDF 를 읽어 전 직원 통행료를 확정합니다'
              : '영수증 PDF 를 읽어 내 통행료를 확정합니다');

    var T = totals(TRIPS);
    if (LOADED && T.unk) {
      h += '<div class="hpnote">' + ic('ticket', 16) +
        '<span>이번 주기에 <b>통행료 미확정 ' + n0(T.unk) + '건</b>이 있습니다. ' +
        '채우지 않으면 정산에서 0원으로 잡힙니다.</span></div>';
    }

    h += '<div class="drop" id="hpDrop">' +
      '<div class="dico">' + ic('receipt', 22) + '</div>' +
      '<div class="dt">영수증 PDF 를 여기에 끌어다 놓으세요</div>' +
      '<div class="dd">한국도로공사 하이패스 이용내역 · 여러 개도 됩니다</div>' +
      '<label class="btn" style="margin-top:14px">파일 고르기' +
      '<input type="file" id="hpFile" accept="application/pdf,.pdf" multiple hidden></label>' +
      '</div>';

    if (HP.note) h += '<div class="hpnote warn">' + ic('alert', 16) + '<span>' + esc(HP.note) + '</span></div>';
    if (!HP.groups.length) return h;

    HP.groups.forEach(function (g, gi) {
      var picked = (g.matched || []).filter(function (e) { return e.pick; });
      var sum = picked.reduce(function (s, e) { return s + e.sum; }, 0);

      h += '<section class="sect"><div class="hd">' +
        '<h2>카드 ' + esc(g.card4 || '?') + '</h2>' +
        '<span class="cnt">' + n0((g.records || []).length) + '건 · ' +
        won((g.records || []).reduce(function (s, r) { return s + (r.amount || 0); }, 0)) + '</span>' +
        '<div class="sp"></div>' +
        '<select class="field" style="height:30px" data-hpcar="' + gi + '">' +
        '<option value="">— 차량 고르기 —</option>' +
        (g.candidates || []).map(function (c) {
          var v = (g.vote || []).filter(function (x) { return x.plate === c; })[0];
          return '<option value="' + esc(c) + '"' + (g.plate === c ? ' selected' : '') + '>' +
            esc(c) + (v ? ' (' + v.n + '건 일치)' : '') + '</option>';
        }).join('') + '</select></div>';

      if (!g.plate) {
        h += blank('차량을 골라 주세요.', '어느 차의 카드인지 정해야 운행과 맞출 수 있습니다.', 'car');
      } else if (!(g.matched || []).length) {
        h += blank('맞는 운행이 없습니다.', '통과 시각이 이 차량의 운행 시간 안에 들지 않습니다.', 'ticket');
      } else {
        h += '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
          '<th style="width:36px"><input type="checkbox" data-hpall="' + gi + '"></th>' +
          '<th>운행</th><th>지금 값</th><th class="n">영수증</th><th class="n">차이</th><th>영수증 내역</th>' +
          '</tr></thead><tbody>';
        g.matched.forEach(function (e, ei) {
          var t = e.trip;
          var now = e.kind === 'new' ? '<span class="st warn">미확정</span>'
            : (e.who === 'person'
              ? '<span class="st bad">사람이 정함 ' + n0(t.toll_cost) + '</span>'
              : '<span class="dim">자동 ' + n0(t.toll_cost) + '</span>');
          var diff = e.diff == null ? '<span class="dim">—</span>'
            : e.diff === 0 ? '<span class="st ok">같음</span>'
              : '<b style="color:' + (e.diff > 0 ? 'var(--ok)' : 'var(--red)') + '">' +
                (e.diff > 0 ? '+' : '') + n0(e.diff) + '</b>';
          h += '<tr class="' + (e.kind === 'diff-person' ? 'flagged' : '') + '">' +
            '<td><input type="checkbox" data-hppick="' + gi + '.' + ei + '"' + (e.pick ? ' checked' : '') + '></td>' +
            '<td><span class="lead">' + md(t.start_time) + '</span> <span class="dim">' +
            hm(t.start_time) + '–' + (t.end_time ? hm(t.end_time) : '') + '</span>' +
            (isAll() ? ' <span class="dim">' + esc(nameOf(t.username)) + '</span>' : '') + '</td>' +
            '<td>' + now + '</td>' +
            '<td class="n lead">' + n0(e.sum) + '</td>' +
            '<td class="n">' + diff + '</td>' +
            '<td class="el dim" title="' + esc(e.lines.map(function (r) {
              return r.atText + ' ' + r.office + ' ' + n0(r.amount);
            }).join(' / ')) + '">' +
            esc(e.lines.map(function (r) { return r.office + ' ' + n0(r.amount); }).join(' · ')) + '</td></tr>';
        });
        h += '</tbody></table></div></div>';

        if ((g.unmatched || []).length) {
          h += '<details class="hpun"><summary>맞는 운행을 못 찾은 기록 ' +
            n0(g.unmatched.length) + '건</summary><div class="hpunb">' +
            g.unmatched.slice(0, 60).map(function (r) {
              return '<div><span class="mono">' + esc(r.atText) + '</span> ' +
                esc(r.office || '') + ' <b>' + n0(r.amount) + '</b></div>';
            }).join('') +
            '<p class="fhint">그 시각에 이 차량의 운행 기록이 없습니다. 운행을 먼저 넣으면 맞춰집니다.</p>' +
            '</div></details>';
        }

        h += '<div class="hpact">' +
          '<span class="dim" id="hpSum' + gi + '">선택 <b>' + n0(picked.length) + '건</b> · 합계 ' + won(sum) + '</span>' +
          '<button class="btn pri" data-hpapply="' + gi + '"' + (picked.length ? '' : ' disabled') + '>' +
          n0(picked.length) + '건 확정하기</button></div>';
      }
      h += '</section>';
    });
    return h;
  }

  function hpFiles(files) {
    // ★ 운행을 다 못 받은 상태로 대조하면 "맞는 운행이 없습니다" 가 되고,
    //   로드가 끝나도 다시 맞추지 않아 PDF 를 또 올려야 했다.
    if (!LOADED) { toast('운행을 불러오는 중입니다. 잠시 뒤에 올려 주세요.'); return; }
    if (!files || !files.length) return;
    if (!window.Hipass) { toast('영수증 해독기를 불러오지 못했습니다.', true); return; }
    HP.busy = true; HP.note = 'PDF 를 읽는 중입니다…'; render();
    var recs = [], done = 0, bad = 0;
    Array.prototype.forEach.call(files, function (f) {
      f.arrayBuffer().then(function (buf) {
        return window.Hipass.parsePdf(buf);
      }).then(function (rs) {
        recs = recs.concat(rs || []);
      }).catch(function (e) { bad++; console.error(f.name, e); })
        .then(function () {
          if (++done < files.length) return;
          HP.busy = false;
          if (!recs.length) {
            HP.note = bad ? '읽지 못한 파일이 있습니다. 한국도로공사 이용내역 PDF 가 맞는지 확인해 주세요.'
              : '영수증에서 통행 기록을 찾지 못했습니다.';
            HP.groups = []; render(); return;
          }
          HP.groups = window.Hipass.match(recs, TRIPS);
          HP.batch = 'web-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
          HP.note = n0(recs.length) + '건을 읽었습니다.' + (bad ? ' (읽지 못한 파일 ' + bad + '개)' : '');
          render();
        });
    });
  }

  function hpApply(gi) {
    var g = HP.groups[gi]; if (!g) return;
    var picked = (g.matched || []).filter(function (e) { return e.pick; });
    if (!picked.length) return;
    var over = picked.filter(function (e) { return e.who === 'person' && e.kind === 'diff-person'; });
    if (over.length && !window.confirm(
      '사람이 직접 정한 값 ' + over.length + '건을 영수증 금액으로 덮습니다.\n계속하시겠습니까?')) return;

    var items = picked.map(function (e) {
      return {
        id: e.trip.id, amount: e.sum,
        note: '카드 ' + (g.card4 || '?') + ' · ' + (g.plate || ''),
        lines: e.lines.map(function (r) {
          return { at: r.atText, office: r.office, amount: r.amount, page: r.page };
        }),
      };
    });

    toast('반영 중입니다…');
    apiRetry('/functions/v1/toll-apply', {
      method: 'POST', body: JSON.stringify({ items: items, batch: HP.batch })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j || !res.j.ok) { toast((res.j && res.j.error) || '반영하지 못했습니다.', true); return; }
        // 서버가 되읽어 준 값으로 화면을 맞춘다 — 트리거가 바꿔치기했을 수 있다.
        (res.j.rows || []).forEach(function (row) {
          var t = ALL_TRIPS.filter(function (x) { return x.id === row.id; })[0];
          if (t) { t.toll_cost = row.toll_cost; t.toll_status = row.toll_status; t.toll_source = row.toll_source; }
        });
        AUDIT = null;
        var skipped = (res.j.skipped || []);
        if (res.j.warning) toast(res.j.warning, true);
        else if (skipped.length) toast(res.j.applied + '건 반영 · ' + skipped.length + '건 건너뜀 (' +
          skipped[0].why + ')', true);   // toast 는 textContent — esc 를 씌우면 &quot; 가 그대로 보인다
        else toast(res.j.applied + '건 확정했습니다.');
        // 남은 것만 다시 계산
        window.Hipass.assign(g, TRIPS);
        paintPills(); render();
      }).catch(function () { toast('서버에 연결하지 못했습니다.', true); });
  }

  /* ══════════════════ 상세 패널 ══════════════════ */
  function openTrip(id) {
    var t = TRIPS.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!t) return;
    var u = USERS[t.username] || {};
    $('pTitle').textContent = md(t.start_time) + ' ' + hm(t.start_time) +
      (t.end_time ? ' – ' + hm(t.end_time) : '');
    $('pSub').textContent = (u.name || t.username) + ' · ' + (t.plate_no || '');
    var qq = quarterOf(t.start_time);
    var kv = [
      ['운행목적', purposeCell(t.purpose)],
      ['출발지', esc(t.start_address || '—')],
      ['도착지', esc(t.end_address || '—')],
      ['방문처', esc(t.visit_place || '—')],
      ['계기판', '<b>' + n0(t.start_odometer) + ' → ' + n0(t.end_odometer) + '</b> <span class="dim">(' + n0(odoKm(t)) + ' km)</span>'],
      ['주행거리', '<b>' + km(t.distance_km) + ' km</b>'],
      ['유류비', '<b>' + won(tripFuel(t)) + '</b><div class="dim" style="font-size:11.5px">' +
        esc(region(t.start_address, t.start_lat, t.start_lng)) + ' · ' + qq.y + '년 ' + qq.q + '분기 단가</div>'],
      ['통행료', tollCell(t) + (t.toll_source ? '<div class="dim" style="font-size:11.5px">' + esc(t.toll_source) + '</div>' : '')],
      ['주차비', t.parking_cost ? '<b>' + won(t.parking_cost) + '</b>' : '—'],
      ['입력', t.is_manual ? '수기 입력' : '자동 기록'],
      ['안전', '과속 ' + n0(t.overspeed_count) + ' · 급가속 ' + n0(t.rapid_accel_count) +
        ' · 급감속 ' + n0(t.rapid_decel_count) + ' · 최고 ' + n0(t.max_speed_kmh) + 'km/h']
    ];
    $('pBody').innerHTML = kv.map(function (r) {
      return '<div class="kv"><div class="k">' + r[0] + '</div><div class="v">' + r[1] + '</div></div>';
    }).join('');
    var locked = apprLocked(t);
    $('pFoot').innerHTML = locked
      ? '<span class="dim" style="font-size:12px;flex:1">결재가 끝난 기간이라 고칠 수 없습니다</span>' +
        '<button class="btn" data-close>닫기</button>'
      : '<span style="flex:1"></span><button class="btn" data-close>닫기</button>' +
        '<button class="btn pri" data-edit="' + t.id + '">고치기</button>';
    $('panel').classList.add('open');
  }

  /** 이 운행이 속한 마감주기가 결재 완료됐나. 서버(trip-edit)도 같은 판정을 한다. */
  function apprLocked(t) {
    var d = kd(Number(t.start_time)), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    if (d.getUTCDate() >= 21) { m += 1; if (m > 12) { m = 1; y += 1; } }
    var key = y + '-' + pad(m);
    return APPR.some(function (a) {
      return a.username === t.username && a.cycle === key && a.status === 'approved';
    });
  }

  /* ══════════════════ 운행 고치기 ══════════════════
     서버 trip-edit 의 규칙을 그대로 옮긴다 — 화면에서 먼저 걸러 주되
     최종 판정은 서버가 한다(여기서 통과해도 서버가 거부할 수 있다).        */
  var PURPOSES = ['일반업무', '출퇴근', '비업무용'];
  function openEdit(id) {
    var t = TRIPS.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!t) return;
    if (apprLocked(t)) { toast('결재가 끝난 기간이라 고칠 수 없습니다.', true); return; }
    var canOdo = !!(ME && ME.is_admin);           // 계기판은 관리자만 (서버 trip-edit 133행)

    $('pTitle').textContent = md(t.start_time) + ' ' + hm(t.start_time) + ' 고치기';
    $('pSub').textContent = esc(nameOf(t.username)) + ' · ' + esc(t.plate_no || '');

    var h = '<div class="form">';
    h += fld('운행목적', '<div class="radios">' + PURPOSES.map(function (p) {
      return '<label class="radio"><input type="radio" name="ePurpose" value="' + esc(p) + '"' +
        ((t.purpose || '') === p ? ' checked' : '') + '><span>' + esc(p) + '</span></label>';
    }).join('') + '</div>',
      (t.purpose || '') === '일반업무' ? '업무용만 비용으로 집계됩니다' : '업무용이 아니면 비용에서 빠집니다');

    h += fld('방문처', '<input class="inp" id="eVisit" maxlength="120" value="' + esc(t.visit_place || '') + '">');
    h += fld('주차비', '<input class="inp num" id="ePark" inputmode="numeric" placeholder="없으면 비워 두세요" value="' +
      (t.parking_cost == null ? '' : n0(t.parking_cost)) + '"><span class="unit">원</span>', '0 ~ 300,000원');

    h += fld('통행료',
      '<div class="radios"><label class="radio"><input type="radio" name="eToll" value="amount"' +
      (isUnknownToll(t) ? '' : ' checked') + '><span>금액 입력</span></label>' +
      '<label class="radio"><input type="radio" name="eToll" value="unknown"' +
      (isUnknownToll(t) ? ' checked' : '') + '><span>모름</span></label></div>' +
      '<div style="margin-top:9px"><input class="inp num" id="eToll" inputmode="numeric" value="' +
      (isUnknownToll(t) ? '' : n0(t.toll_cost)) + '"><span class="unit">원</span></div>',
      '0 ~ 200,000원 · 0 을 넣으면 <b>면제</b>로 기록됩니다');

    if (canOdo) {
      h += fld('계기판 <span class="only">관리자</span>',
        // n0(null) 은 '—' 다. 그걸 칸에 박아 두면 목적만 바꿔도 저장이 막힌다.
        '<input class="inp num" id="eOdoS" inputmode="numeric" value="' + odoVal(t.start_odometer) + '">' +
        '<span class="arrowto">→</span>' +
        '<input class="inp num" id="eOdoE" inputmode="numeric" value="' + n0(t.end_odometer) + '">',
        '고치면 <b>주행거리도 같이 바뀝니다</b>. 한 번에 3,000km 를 넘을 수 없습니다.');
    }
    h += '</div>';
    h += '<div class="anote">고친 내용은 <b>서버가 다시 검사</b>합니다. ' +
      '통행료를 고치면 <b>사람이 정한 값</b>으로 기록돼 자동 계산이 덮어쓰지 않습니다.</div>';

    $('pBody').innerHTML = h;
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-trip="' + t.id + '">취소</button>' +
      '<button class="btn pri" id="btnSaveTrip" data-id="' + t.id + '">저장</button>';
    $('panel').classList.add('open');

    function fld(label, body, hint) {
      return '<div class="frow"><label class="flab">' + label + '</label>' +
        '<div class="fbody">' + body +
        (hint ? '<div class="fhint">' + hint + '</div>' : '') + '</div></div>';
    }
  }

  /* ══════════════════ 운행 추가 ══════════════════
     빠진 운행을 채워 넣는다. 서버가 계기판 연속성을 그 자리에서 검사하고,
     앞뒤와 1,000km 이상 벌어지면 되물어본다(양준범 175,500km 같은 사고 방지). */
  function openCreate(who) {
    // ★ 관리자가 "누구 운행"을 바꾸면 차량 목록과 계기판 기본값도 그 사람 것이어야
    //   한다. 예전에는 늘 본인 것이라, 그대로 넣기를 누르면 남의 차·남의 계기판으로
    //   저장됐다 — 점검 화면이 잡으려는 바로 그 사고를 이 화면이 만들었다.
    var mine = who || myName();
    var myCars = carsOf(mine);
    var last = lastTripOf(mine);

    var r = cycleRange(CYC.y, CYC.m);
    var d = kd(Math.min(Date.now(), r.hi - 1));
    var dstr = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());

    if (cycleApproved(mine)) {
      toast(nameOf(mine) + ' 님의 ' + cycleName(CYC.y, CYC.m) + ' 은 결재가 끝나 넣을 수 없습니다.', true);
      return;
    }
    $('pTitle').textContent = '운행 추가';
    $('pSub').textContent = cycleName(CYC.y, CYC.m) + ' · ' + cycleSpan(CYC.y, CYC.m);

    var h = '<div class="form">';
    if (ME.is_admin && isAll()) {
      var us = Object.keys(PEOPLE).sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b), 'ko'); });
      h += fld('누구 운행', '<select class="inp" id="cWho">' + us.map(function (u) {
        return '<option value="' + esc(u) + '"' + (u === mine ? ' selected' : '') + '>' +
          esc(nameOf(u)) + ' · ' + esc(personOf(u).dept || '') + '</option>';
      }).join('') + '</select>', '관리자는 다른 분 운행도 넣을 수 있습니다');
    }
    h += fld('차량번호', myCars.length
      ? '<select class="inp" id="cPlate">' + myCars.map(function (c) {
          return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
        }).join('') + '<option value="__etc__">직접 입력…</option></select>' +
        '<input class="inp" id="cPlateEtc" placeholder="차량번호" style="margin-top:8px" hidden>'
      : '<input class="inp" id="cPlateEtc" placeholder="예) 190호5283">');
    h += fld('날짜', '<input class="inp" type="date" id="cDate" value="' + dstr + '" min="' +
      ymd(r.lo) + '" max="' + ymd(r.hi - 1) + '">', '이번 마감주기 안에서만 넣을 수 있습니다');
    h += fld('시각', '<input class="inp num" type="time" id="cFrom" value="09:00" style="width:112px">' +
      '<span class="arrowto">→</span>' +
      '<input class="inp num" type="time" id="cTo" value="09:30" style="width:112px">',
      '도착 시각을 넣으면 나중에 <b>하이패스 영수증과 맞춰볼 수 있습니다</b>');
    h += fld('운행목적', '<div class="radios">' + PURPOSES.map(function (p) {
      return '<label class="radio"><input type="radio" name="cPurpose" value="' + esc(p) + '"' +
        (p === '일반업무' ? ' checked' : '') + '><span>' + esc(p) + '</span></label>';
    }).join('') + '</div>');
    h += fld('계기판',
      '<input class="inp num" id="cOdoS" inputmode="numeric" placeholder="출발" value="' +
      (last && last.end_odometer != null ? n0(last.end_odometer) : '') + '">' +
      '<span class="arrowto">→</span>' +
      '<input class="inp num" id="cOdoE" inputmode="numeric" placeholder="도착">',
      '앞뒤 운행과 <b>1,000km 이상 벌어지면 서버가 되물어봅니다</b>');
    h += fld('방문처', '<input class="inp" id="cVisit" maxlength="120" placeholder="선택">');
    h += fld('주차비', '<input class="inp num" id="cPark" inputmode="numeric" placeholder="없으면 비움">' +
      '<span class="unit">원</span>');
    h += fld('통행료',
      '<div class="radios"><label class="radio"><input type="radio" name="cToll" value="unknown" checked>' +
      '<span>모름</span></label><label class="radio"><input type="radio" name="cToll" value="amount">' +
      '<span>금액 입력</span></label></div>' +
      '<div style="margin-top:9px"><input class="inp num" id="cToll" inputmode="numeric" placeholder="0">' +
      '<span class="unit">원</span></div>');
    h += '</div>';
    h += '<div class="anote">수기로 넣은 운행은 <b>수기</b> 표시가 붙습니다. ' +
      '주행거리는 계기판 차이로 자동 계산됩니다.</div>';

    $('pBody').innerHTML = h;
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnCreateTrip">넣기</button>';
    $('panel').classList.add('open');
    // 사람을 바꾸면 그 사람의 차량·계기판으로 폼을 다시 연다.
    var whoSel = $('cWho');
    if (whoSel) whoSel.addEventListener('change', function () { openCreate(this.value); });

    function fld(label, body, hint) {
      return '<div class="frow"><label class="flab">' + label + '</label><div class="fbody">' + body +
        (hint ? '<div class="fhint">' + hint + '</div>' : '') + '</div></div>';
    }
  }

  function createTrip(force) {
    var num = function (el) {
      var v = String((el && el.value) || '').replace(/[^\d]/g, '');
      return v === '' ? null : Number(v);
    };
    var plateSel = $('cPlate'), plateEtc = $('cPlateEtc');
    var plate = (plateSel && plateSel.value !== '__etc__') ? plateSel.value
      : (plateEtc ? plateEtc.value.trim() : '');
    if (!plate) { toast('차량번호를 넣어 주세요.', true); return; }

    var date = $('cDate').value, from = $('cFrom').value, to = $('cTo').value;
    if (!date || !from) { toast('날짜와 출발 시각을 넣어 주세요.', true); return; }
    var toMs = function (dd, tt) {
      var p1 = dd.split('-').map(Number), p2 = tt.split(':').map(Number);
      return Date.UTC(p1[0], p1[1] - 1, p1[2], p2[0] || 0, p2[1] || 0) - KST;   // 입력값은 KST
    };
    var startMs = toMs(date, from);
    var endMs = to ? toMs(date, to) : startMs;
    if (endMs < startMs) endMs += 86400e3;   // 자정을 넘긴 운행

    var so = num($('cOdoS')), eo = num($('cOdoE'));
    if (so == null || eo == null) { toast('계기판 값을 넣어 주세요.', true); return; }
    if (eo < so) { toast('도착 계기판이 출발보다 작습니다.', true); return; }
    if (eo - so > 3000) { toast('한 운행에 3,000km 를 넘을 수 없습니다.', true); return; }

    var tollMode = (document.querySelector('input[name="cToll"]:checked') || {}).value;
    var payload = {
      username: $('cWho') ? $('cWho').value : undefined,
      plate_no: plate, start_time: startMs, end_time: endMs,
      purpose: (document.querySelector('input[name="cPurpose"]:checked') || {}).value,
      start_odometer: so, end_odometer: eo,
      visit_place: $('cVisit').value.trim(),
      parking_cost: num($('cPark')),
      toll: tollMode === 'amount' ? { mode: 'amount', amount: num($('cToll')) || 0 } : { mode: 'unknown' },
      force: !!force,
    };

    var btn = $('btnCreateTrip'); if (btn) { btn.disabled = true; btn.textContent = '넣는 중…'; }
    apiRetry('/functions/v1/trip-create', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (btn) { btn.disabled = false; btn.textContent = '넣기'; }
        if (!res.ok || !res.j || !res.j.ok) {
          var j = res.j || {};
          // 계기판이 크게 벌어졌을 때만 되물어본다. 그 외 오류는 그대로 보여 준다.
          if (j.needConfirm && window.confirm(j.error + '\n\n그래도 이대로 넣으시겠습니까?')) {
            createTrip(true); return;
          }
          toast(j.error || '넣지 못했습니다.', true); return;
        }
        if (res.j.row) {
          // 서버는 start_time 내림차순으로 준다. 맨 앞에 꽂으면 08.22 가 08.21 위에 붙는다.
          ALL_TRIPS.push(res.j.row);
          ALL_TRIPS.sort(function (a, b) { return b.start_time - a.start_time; });
          applyScope();
        }
        AUDIT = null;
        toastOk('운행을 넣었습니다.', res.j.warning);
        closePanel(); paintPills(); render();
      }).catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = '넣기'; }
        toast('서버에 연결하지 못했습니다.', true);
      });
  }

  function saveTrip(id) {
    var t = TRIPS.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!t) return;
    // ★ 예전에는 '-' 를 남겨 둬서 "-" 나 "12-34" 가 NaN 이 됐다. NaN 은 모든
    //   범위 검사를 빠져나가고 JSON.stringify 가 null 로 바꿔 값이 조용히 지워졌다.
    var num = function (el) {
      var v = String((el && el.value) || '').replace(/[^\d]/g, '');
      return v === '' ? null : Number(v);
    };
    var patch = {};

    var p = document.querySelector('input[name="ePurpose"]:checked');
    if (p && p.value !== (t.purpose || '')) patch.purpose = p.value;

    var vis = $('eVisit').value.trim().slice(0, 120);
    if (vis !== (t.visit_place || '')) patch.visit_place = vis;

    var park = num($('ePark'));
    if (park !== (t.parking_cost == null ? null : Number(t.parking_cost))) {
      if (park != null && (park < 0 || park > 300000)) { toast('주차비는 0 ~ 300,000원 사이여야 합니다.', true); return; }
      patch.parking_cost = park;
    }

    var mode = (document.querySelector('input[name="eToll"]:checked') || {}).value;
    if (mode === 'unknown') {
      if (!isUnknownToll(t)) patch.toll = { mode: 'unknown' };
    } else {
      var amt = num($('eToll'));
      if (amt == null) { toast('통행료 금액을 넣거나 "모름"을 고르세요.', true); return; }
      if (amt < 0 || amt > 200000) { toast('통행료는 0 ~ 200,000원 사이여야 합니다.', true); return; }
      if (isUnknownToll(t) || amt !== Number(t.toll_cost)) patch.toll = { mode: 'amount', amount: amt };
    }

    if (ME && ME.is_admin && $('eOdoS')) {
      var so = num($('eOdoS')), eo = num($('eOdoE'));
      if (so == null || eo == null) { toast('계기판 값을 넣어 주세요.', true); return; }
      if (eo < so) { toast('도착 계기판이 출발보다 작습니다.', true); return; }
      if (eo - so > 3000) { toast('한 운행에 3,000km 를 넘을 수 없습니다.', true); return; }
      if (so !== Math.round(Number(t.start_odometer)) || eo !== Math.round(Number(t.end_odometer))) {
        patch.start_odometer = so; patch.end_odometer = eo;
      }
    }

    if (!Object.keys(patch).length) { toast('바뀐 내용이 없습니다.'); closePanel(); return; }

    var btn = $('btnSaveTrip'); btn.disabled = true; btn.textContent = '저장 중…';
    apiRetry('/functions/v1/trip-edit', { method: 'POST', body: JSON.stringify({ id: Number(id), patch: patch }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = '저장';
        if (!res.ok || !res.j || !res.j.ok) { toast((res.j && res.j.error) || '저장하지 못했습니다.', true); return; }
        // 서버가 되돌려 준 값으로 갈아끼운다 — 트리거가 값을 바꿨을 수 있다.
        var row = res.j.row || {};
        Object.keys(row).forEach(function (k) { if (k !== 'id') t[k] = row[k]; });
        AUDIT = null;
        toastOk((res.j.changed || []).join('·') + ' 고쳤습니다.', res.j.warning);
        closePanel(); paintPills(); render();
      }).catch(function () {
        btn.disabled = false; btn.textContent = '저장';
        toast('서버에 연결하지 못했습니다.', true);
      });
  }

  function closePanel() { $('panel').classList.remove('open'); }

  /* ══════════════════ 라우팅 ══════════════════ */
  // 개인 화면과 관리 화면이 같은 함수를 쓰고 범위만 다르다.
  // 관리 화면 키는 전부 'a_' 로 시작한다(전사 = all).
  var VIEWS = {
    close: viewClose, trips: viewTrips, check: viewCheck, evid: viewEvid, edu: viewEdu,
    hipass: viewHipass, settle: viewSettle, inbox: viewInbox,
    a_close: viewClose, a_trips: viewTrips, a_check: viewCheck, a_evid: viewEvid,
    a_hipass: viewHipass, a_settle: viewSettle,
    people: viewPeople, cars: viewCars, eduadm: viewEduAdm,
    account: viewAccount, perm: viewPerm, tollfill: viewTollFill,
    safety: viewSafety, a_safety: viewSafety
  };
  /** 관리자만 열 수 있는 화면. */
  var ADMIN_VIEWS = ['a_close', 'a_trips', 'a_check', 'a_evid', 'a_hipass', 'a_settle',
    'people', 'cars', 'eduadm', 'perm', 'a_safety'];
  /** 지금 화면이 전사 범위인가. 화면 안에서 '이름 칸을 보일까' 같은 판단에 쓴다. */
  function isAll() { return ADMIN_VIEWS.indexOf(VIEW) >= 0; }
  /** 같은 화면을 개인/전사로 쓰므로 제목으로 범위를 드러낸다. */
  function scopeTitle(t) { return isAll() ? '전체 ' + t : t; }
  /** 지금 화면 범위에 맞게 TRIPS·EVID 를 채운다. */
  function applyScope() {
    if (isAll()) { TRIPS = ALL_TRIPS; EVID = ALL_EVID; return; }
    var me = myName();
    TRIPS = ALL_TRIPS.filter(function (t) { return t.username === me; });
    EVID = ALL_EVID.filter(function (e) { return e.username === me; });
  }
  function render() {
    // 적재가 실패했으면 스켈레톤 대신 사유와 다시 시도 버튼을 보여 준다.
    $('inner').innerHTML = LOAD_ERR
      ? '<section class="sect"><div class="panel" style="padding:34px 24px;text-align:center">' +
        '<div style="font-weight:700;margin-bottom:6px">' + esc(LOAD_ERR) + '</div>' +
        '<div class="dim" style="margin-bottom:16px">잠시 뒤 다시 시도해 주세요.</div>' +
        '<button class="btn pri" id="btnRetryLoad">다시 불러오기</button></div></section>'
      : (VIEWS[VIEW] || viewClose)();
    Array.prototype.forEach.call($('nav').querySelectorAll('[data-v]'), function (a) {
      a.classList.toggle('on', a.dataset.v === VIEW);
    });
    var rt = $('btnRetryLoad');
    if (rt) rt.addEventListener('click', function () { LOAD_ERR = ''; loadAll(); });
    var cf = $('btnClearFilt');
    if (cf) cf.addEventListener('click', function () {
      FILT.who = ''; FILT.car = ''; FILT.q = ''; FILT.chip = 'all'; render();
    });
    // 드롭존은 화면을 다시 그릴 때마다 새로 생기므로 그때마다 연결한다.
    var dz = $('hpDrop');
    if (dz) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        dz.addEventListener(ev, function (e2) { e2.preventDefault(); dz.classList.add('over'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dz.addEventListener(ev, function (e2) { e2.preventDefault(); dz.classList.remove('over'); });
      });
      dz.addEventListener('drop', function (e2) { hpFiles(e2.dataTransfer && e2.dataTransfer.files); });
    }
    // 행이 많은 표만 자체 스크롤 + 머리글 고정. 짧은 표까지 가두면 답답하다.
    Array.prototype.forEach.call($('inner').querySelectorAll('.scroll[data-rows]'), function (w) {
      var n = w.querySelectorAll('tbody tr').length;
      w.classList.toggle('tall', n > 22);
    });
  }
  function go(v) {
    if (!VIEWS[v]) return;
    // 관리 화면은 관리자만. 주소를 직접 만져도 못 들어간다(서버 RLS 가 이중으로 막는다).
    if (ADMIN_VIEWS.indexOf(v) >= 0 && !(ME && ME.is_admin)) return;
    // 권한 관리는 관리자 중에서도 마스터 계정만(서버 RPC 가 그렇게 못 박혀 있다).
    if (v === 'perm' && !ACCT.can_manage_admin) return;
    VIEW = v;
    AUDIT = null;                 // 점검 결과는 범위가 바뀌면 다시 내야 한다
    FILT.who = ''; FILT.car = ''; FILT.q = ''; FILT.chip = 'all';
    // ★ 하이패스 대조 결과도 반드시 버린다. 안 버리면 관리 화면에서 맞춰 둔
    //   남의 운행이 개인 화면에 그대로 남고(이름 칸은 사라져 남의 것인 줄도 모른다),
    //   '확정하기' 를 누르면 남의 운행에 통행료가 써진다.
    HP = { groups: [], batch: '', busy: false, note: '' };
    FILLS = {};                   // 채우던 통행료도 화면이 바뀌면 의미가 없다
    applyScope();
    document.body.classList.remove('nav-open');
    render();
    window.scrollTo({ top: 0 });
  }

  /* ══════════════════ 이벤트 ══════════════════ */
  document.addEventListener('click', function (e) {
    var el;
    if (e.target.closest('[data-close]')) { closePanel(); return; }
    if ((el = e.target.closest('[data-v]'))) { go(el.dataset.v); return; }
    if ((el = e.target.closest('[data-chip]'))) { FILT.chip = el.dataset.chip; render(); return; }
    if ((el = e.target.closest('[data-issue]'))) {
      // go() 가 필터를 비우므로 반드시 go() **뒤에** 넣어야 한다. 예전에는 앞에 넣어
      // 필터가 날아갔고, 화면도 개인 운행일지로 못 박혀 있어 전체 점검에서 누르면
      // 보러 간 건이 한 건도 안 보였다.
      var issue = el.dataset.issue;
      go(isAll() ? 'a_trips' : 'trips');
      FILT.chip = issue; FILT.who = '';
      render(); return;
    }
    if ((el = e.target.closest('[data-edit]'))) { openEdit(el.dataset.edit); return; }
    if (e.target.closest('#btnSaveTrip')) { saveTrip(e.target.closest('#btnSaveTrip').dataset.id); return; }
    if (e.target.closest('#btnAddTrip')) { openCreate(); return; }
    /* ── 하이패스 대조 ── */
    if ((el = e.target.closest('[data-hpapply]'))) { hpApply(+el.dataset.hpapply); return; }
    if (e.target.matches('[data-hpall]')) {
      var gi = +e.target.dataset.hpall, on = e.target.checked;
      (HP.groups[gi].matched || []).forEach(function (x) { x.pick = on; });
      render(); return;
    }
    if (e.target.matches('[data-hppick]')) {
      var p = e.target.dataset.hppick.split('.');
      HP.groups[+p[0]].matched[+p[1]].pick = e.target.checked;
      // ★ render() 를 부르지 않는다. 화면을 통째로 갈아끼우면 표가 맨 위로 튀고
      //   포커스와 펼쳐 둔 목록이 사라진다. 바뀐 숫자만 고쳐 쓴다.
      paintHpCount();
      return;
    }

    if (e.target.closest('#btnCreateTrip')) { createTrip(false); return; }
    if ((el = e.target.closest('[data-trip]'))) { openTrip(el.dataset.trip); return; }
    // ★ 인쇄 버튼은 직원 행(data-person) 안에 들어 있다. 같은 핸들러 안에서
    //   행 검사가 먼저 돌면 인쇄 대신 화면 이동이 일어난다(stopPropagation 은
    //   같은 리스너 안에서는 소용이 없다). 반드시 행보다 먼저 본다.
    if ((el = e.target.closest('[data-print]'))) { doPrint(el.dataset.print || undefined); return; }
    if ((el = e.target.closest('[data-person]'))) {
      // 지금 보고 있는 범위 안에서 이동한다. 개인 화면에서 눌렀는데 전사 목록으로
      // 튀면 안 되고, 일반 직원에게 아무 일도 안 일어나는 죽은 클릭이어도 안 된다.
      go(isAll() ? 'a_trips' : 'trips');
      FILT.who = el.dataset.person; FILT.chip = 'all';
      render(); return;
    }
    if ((el = e.target.closest('[data-car]'))) {
      // 차량 목록은 관리 화면에만 있다. 개인 운행일지로 보내면 내 차가 아니라 빈 표가 된다.
      var car = el.dataset.car;
      go(isAll() ? 'a_trips' : 'trips');
      FILT.car = car; FILT.chip = 'all';
      render(); return;
    }
    if (e.target.closest('#btnCsv')) { downloadCsv(); return; }
    if ((el = e.target.closest('#btnPrintGo'))) { runPrint(el.dataset.who); return; }
    if (e.target.closest('#btnPwSave')) { savePassword(); return; }
    if ((el = e.target.closest('[data-addappr]'))) { addApprover(el.dataset.addappr); return; }
    if ((el = e.target.closest('[data-tffree]'))) {
      tfRead();
      var gf = TF_GROUPS[+el.dataset.tffree]; if (gf) FILLS[gf.key] = 0;
      render(); return;
    }
    if ((el = e.target.closest('[data-tfhint]'))) {
      tfRead();
      var gh = TF_GROUPS[+el.dataset.tfhint]; if (gh) FILLS[gh.key] = gh.hint;
      render(); return;
    }
    if (e.target.closest('#tfAllFree')) { openAllFree(); return; }
    if (e.target.closest('#btnAllFreeGo')) {
      TF_GROUPS.forEach(function (x) { if (FILLS[x.key] == null) FILLS[x.key] = 0; });
      closePanel(); render(); return;
    }
    if (e.target.closest('#tfSave')) { tfSave(); return; }
    if ((el = e.target.closest('[data-perm]'))) {
      openPermConfirm('admin', el.dataset.perm, el.dataset.on === '1'); return;
    }
    if ((el = e.target.closest('[data-pwreset]'))) {
      openPermConfirm('pw', el.dataset.pwreset, false); return;
    }
    if ((el = e.target.closest('#btnPermGo'))) {
      runPerm(el.dataset.kind, el.dataset.target, el.dataset.on === '1'); return;
    }
    if (e.target.closest('#burger')) { document.body.classList.toggle('nav-open'); return; }
    // 내 프로필 버튼은 개인 자리다 — 관리 화면으로 보내지 않는다(직원 현황은 관리 메뉴에 있다).
    if (e.target.closest('#uBtn')) { go('close'); return; }

    /* ── 결재 ── */
    if (e.target.closest('#btnOpenSubmit')) { openSubmit(); return; }
    if (e.target.closest('#btnApprPdf')) { doPrint(); return; }
    if ((el = e.target.closest('[data-del]'))) {
      DRAFT.splice(+el.dataset.del, 1); renderSubmit(); return;
    }
    if (e.target.closest('#btnSubmitAppr')) {
      var bad = DRAFT.filter(function (s) { return !s.approver; });
      if (!DRAFT.length) { toast('결재자를 한 명 이상 지정해 주세요.', true); return; }
      if (bad.length) { toast('아직 고르지 않은 결재자가 있습니다.', true); return; }
      callAppr({
        action: 'submit', cycle: CYCKEY(),
        steps: DRAFT.map(function (s) { return { approver: s.approver, box: s.box }; })
      }, '상신했습니다.');
      return;
    }
    if ((el = e.target.closest('[data-appr]'))) {
      var act = el.dataset.appr, id = +el.dataset.id;
      if (act === 'reject') {
        var why = window.prompt('반려 사유를 적어 주세요. 상신자에게 그대로 전달됩니다.');
        if (why == null) return;
        if (!why.trim()) { toast('반려 사유가 필요합니다.', true); return; }
        callAppr({ action: 'reject', id: id, comment: why.trim() });
      } else if (act === 'withdraw') {
        if (!window.confirm('상신을 회수하시겠습니까? 결재선은 그대로 남습니다.')) return;
        callAppr({ action: 'withdraw', id: id });
      } else {
        callAppr({ action: 'approve', id: id });
      }
      return;
    }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'selCycle') {
      var v = e.target.value.split('-');
      CYC = { y: +v[0], m: +v[1] };
      paintCycle(); loadAll(); return;
    }
    if (e.target.id === 'selWho') { FILT.who = e.target.value; renderKeepFocus('selWho'); return; }
    if (e.target.id === 'selCar') { FILT.car = e.target.value; renderKeepFocus('selCar'); return; }
    if (e.target.id === 'hpFile') { hpFiles(e.target.files); return; }
    if (e.target.dataset && e.target.dataset.hpcar !== undefined) {
      var g = HP.groups[+e.target.dataset.hpcar];
      g.plate = e.target.value || null;
      window.Hipass.assign(g, TRIPS);
      render(); return;
    }
    if (e.target.id === 'cPlate') {
      var etc = $('cPlateEtc'); if (etc) etc.hidden = e.target.value !== '__etc__';
      if (etc && !etc.hidden) etc.focus();
      return;
    }
    // ── 상신 창 ──
    if (e.target.classList.contains('apick')) {
      DRAFT[+e.target.dataset.idx].approver = e.target.value;
      renderSubmit(); return;
    }
    if (e.target.dataset && e.target.dataset.box !== undefined) {
      DRAFT[+e.target.dataset.box].box = e.target.value; return;
    }
  });
  // ★ IME 조합 중에는 다시 그리지 않는다. 조합 버퍼는 포커스를 되돌려도
  //   복원할 수 없어, 천천히 치는 사람은 글자가 깨진다.
  var IME = false;
  document.addEventListener('compositionstart', function (e) {
    if (e.target.id === 'qBox') { IME = true; clearTimeout(window.__q); }
  });
  document.addEventListener('compositionend', function (e) {
    if (e.target.id !== 'qBox') return;
    IME = false;
    FILT.q = e.target.value;
    queueSearch(e.target);
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'apprQ') {
      // 창 전체를 다시 그리면 커서가 튀고 한글 조합이 끊긴다 — 후보 목록만 바꾼다.
      APPR_Q = e.target.value;
      var cand = $('apprCand');
      if (cand) cand.innerHTML = apprCandHtml();
      return;
    }
    if (e.target.dataset && e.target.dataset.tfamt !== undefined) {
      // 표를 다시 그리면 커서가 튄다 — 요약 줄과 저장 버튼만 고쳐 쓴다.
      tfRead();
      var d2 = 0, s2 = 0, tot = 0;
      TF_GROUPS.forEach(function (x) {
        tot += x.rows.length;
        if (FILLS[x.key] == null) return;
        d2 += x.rows.length; s2 += FILLS[x.key] * x.rows.length;
      });
      var lab = $('tfSum');
      if (lab) lab.innerHTML = '정한 것 <b>' + n0(d2) + '</b> / ' + n0(tot) + '건' + (s2 ? ' · 합계 ' + won(s2) : '');
      var sb = $('tfSave');
      if (sb) { sb.disabled = !d2; sb.textContent = n0(d2) + '건 저장'; }
      return;
    }
    if (e.target.id !== 'qBox') return;
    FILT.q = e.target.value;
    if (IME) return;                       // 조합이 끝나면 compositionend 가 부른다
    queueSearch(e.target);
  });
  function queueSearch(box) {
    clearTimeout(window.__q);
    window.__q = setTimeout(function () {
      var pos = box.selectionStart;
      render();
      var b = $('qBox'); if (b) { b.focus(); b.setSelectionRange(pos, pos); }
    }, 200);
  }
  document.addEventListener('keydown', function (e) {
    // tabindex 만 주면 눌리지 않는다 — Enter·Space 를 클릭으로 바꿔 준다.
    if ((e.key === 'Enter' || e.key === ' ') &&
        e.target.matches && e.target.matches('[data-v],tr.clk,[data-person],[data-car]')) {
      e.preventDefault(); e.target.click(); return;
    }
    if (e.key === 'Escape') { closePanel(); document.body.classList.remove('nav-open'); }
    if (e.key === 'Enter' && (e.target.id === 'u' || e.target.id === 'p')) doLogin();
    // 결재자 찾기 — Enter 로 맨 위 후보를 넣는다.
    if (e.key === 'Enter' && e.target.id === 'apprQ') {
      e.preventDefault();
      var top = apprCandidates()[0];
      if (top) addApprover(top);
      return;
    }
    // '/' 로 검색창에 바로 간다
    if (e.key === '/' && VIEW === 'trips' && document.activeElement.tagName !== 'INPUT') {
      var b = $('qBox'); if (b) { e.preventDefault(); b.focus(); b.select(); }
    }
  });
  $('loginBtn').addEventListener('click', doLogin);
  function signOut() {
    ss(K_AT, null); ss(K_RT, null); ss(K_ME, null);
    location.reload();
  }
  $('logoutBtn').addEventListener('click', signOut);

  /* ── 검증용 이음매 ──────────────────────────────────────────────
     실데이터 하네스(_realstub.js)가 깔렸을 때만 인쇄 생성기를 밖으로 낸다.
     배포본에는 __VERIFY__ 가 없으므로 아무 일도 하지 않는다. */
  if (window.__VERIFY__) { window.__buildPrint = buildPrint; window.__state = function () { return { TRIPS: TRIPS, EVID: EVID, VEHICLES: VEHICLES, USERS: USERS, RATES: RATES, CYC: CYC }; }; }

  /* ══════════════════ 시작 ══════════════════ */
  if (ss(K_AT) && me()) enter();
})();
