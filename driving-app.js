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
    var t = $('toast');
    // 오류는 화면낭독기가 하던 말을 끊고 바로 읽게 한다(alert). 그 밖의 알림은 차례를 기다린다(status).
    t.setAttribute('role', bad ? 'alert' : 'status');
    t.textContent = msg;
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
    // ★ 토큰이 없으면 절대 anon 키로 내려가지 않는다. anon 은 앱 경로라 정책이
    //   통째로 열려 있어, 그리로 쓰면 잠금·본인 제한이 전부 사라진 채 '성공' 한다.
    //   401 을 돌려주면 apiRetry 가 refresh 를 시도하고, 그것도 안 되면 그대로 실패한다.
    var at = ss(K_AT);
    if (!at) {
      return Promise.resolve(new Response('{"error":"로그인이 풀렸습니다. 다시 로그인해 주세요."}',
        { status: 401, headers: { 'Content-Type': 'application/json' } }));
    }
    h.Authorization = 'Bearer ' + at;
    if (opt.body && !h['Content-Type']) h['Content-Type'] = 'application/json';
    opt.headers = h;
    return fetch(SB + path, opt);
  }
  /** 401 이면 토큰을 한 번 갱신하고 다시 시도한다.
   *  ★ 403 은 다시 보내지 않는다(2026-09-29 검증로봇). 만료된 토큰은 PostgREST·함수 게이트웨이
   *    모두 401 을 주고, 403 은 "권한 없음·비밀번호 불일치" 같은 **판정 결과**다. 403 에도 재전송하면
   *    비밀번호를 한 번 틀린 것이 서버에서 두 번 실행돼 실패 횟수가 2씩 올라가고(앱 로그인과
   *    공유하는 카운터), 웹에서 5번 틀리면 앱까지 10분 잠겼다. */
  function apiRetry(path, opt) {
    return api(path, opt).then(function (r) {
      if (r.status !== 401) return r;
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
          // ★ 그 밖의 오류(5xx 등)도 빈 목록으로 바꾸지 않는다. 21일 마감 때 요청 12개 중 하나만
          //   500 이어도 "운행이 없습니다" 가 뜨고, 단가표가 실패하면 전부 기본 159원으로
          //   계산됐다(2026-09-23 검증로봇). 호출부가 '불러오지 못했습니다' 로 보여 준다.
          if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path.split('?')[0]);
          return r.json();
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
  var APPR = [], PEOPLE = {};               // 결재 건 · 사람 목록(이름·부서·직급)
  var ORG = [];                             // 조직도(driving_org) — 결재선을 짜는 사람 목록
  /** 확장 모듈(drv-*.js)이 얹는 것들. 파일 끝의 '확장 모듈 이음매'에서 채운다. */
  var EXT = { apprExtra: null, wantSummaries: null, beforeSubmit: null, sumText: null, onCycle: [], dirty: [] };
  var LOADED = false, LOADING = false, AUDIT = null;
  var LOAD_SEQ = 0;      // 늦게 도착한 응답을 버리기 위한 표
  /** driving-account 가 알려 주는 것 — 권한 관리를 할 수 있는 계정인가.
   *  마스터 계정 이름을 웹에 적어 두지 않으려고 서버에 물어본다. */
  var ACCT = { can_manage_admin: false };
  var LOAD_ERR = '';     // 적재 실패 사유(스켈레톤에 갇히지 않게 화면에 남긴다)
  // 목적은 처음부터 「일반업무」로 좁혀 둔다(2026-10-07 사용자 — 정산·결재 대상이 업무 운행이다). 「목적 전체」로 바꿀 수 있다.
  var FILT = { chip: 'all', who: '', car: '', q: '', purp: '일반업무' };
  /**
   * 조회 범위 — 여러 주기를 한꺼번에 볼 때만 값이 있다({from:{y,m}, to:{y,m}}). 평소에는 null(= CYC 한 주기).
   * ★ 조회 전용이다. 상신·결재 문서·통행료 채우기·증빙 올리기는 언제나 CYC 한 주기만 다룬다.
   *   여러 주기 합계는 "운행마다 그 운행의 단가로 계산한 것의 합"이라 주기별 합계를 더한 값과 같다
   *   (새 계산식을 만들지 않는다).
   */
  var RANGE = null;
  /** 화면 안에서 날짜로 더 좁히기('YYYY-MM-DD', 한국시간). 조회 범위 안에서만 뜻이 있다. */
  var DATEF = { from: '', to: '' };
  /** 표 정렬 상태. 키 = 표 이름, 값 = '열:방향'(방향 1 오름 · -1 내림). 비어 있으면 그 표의 기본 순서. */
  var SORTS = {};
  /** 긴 표는 나눠 그린다. 키 = 표 이름, 값 = 지금 보이는 줄 수. */
  var PAGES = {};
  var PAGE_SIZE = 300;
  /** 표마다의 기본 정렬('열:방향') — sortRows 가 적어 둔다. 기본 열을 처음 누르면 뒤집으려고 필요하다. */
  var SORT_DEF = {};
  var SORT_FOCUS = '';
  /**
   * 인쇄에 담을 운행목적. 앱 내보내기 창과 같다 — 기본은 '업무만'.
   * 앱 MainScreen.kt 366~369행: expBiz=true, expCom=false, expPer=false.
   * 같은 화면에 "차량일지 제출 시에는 '업무' 운행내역만 선택하세요" 안내가 있다.
   */
  var PRINT_PURPOSES = ['일반업무'];
  var DRAFT = null;                   // 상신 창에서 편집 중인 결재선
  /** 진행 중인 상신(검증 → 상신). 창을 닫으면 token 이 지워져 뒤따르던 상신이 멈춘다. */
  var SUBMIT = { token: null, send: null };
  /** 결재 확인 창에서 결재 문서·검증 결과를 열면 같은 패널을 덮어쓴다 — 돌아올 곳을 적어 둔다. */
  var APPR_BACK = null;

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
        if (!res.ok || !res.j || !res.j.ok) {
          var msg = (res.j && res.j.error) || '로그인에 실패했습니다.';
          // ★ 같은 사이트의 다른 도구(통합관제 등)에 저장된 **이메일**을 브라우저가 이 칸에 자동으로
          //   채워, 앱 아이디 대신 이메일로 로그인하다 막히는 일이 실제로 있었다(2026-09-23).
          //   앱 아이디에 '@' 가 들어간 사람도 있어 막지는 않고, 실패했을 때만 짚어 준다.
          if (u.indexOf('@') > 0) msg += ' — 이메일이 아니라 앱에서 쓰는 아이디를 넣으셨는지 확인해 주세요.';
          loginErr(msg); return;
        }
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
    // 들어올 때의 주소를 잡아 둔다. 프로필이 먼저 오면 주소를 마감 현황으로 고쳐 쓰므로,
    // 뒤늦게 온 whoami 가 그 주소를 읽으면 '권한 관리로 가려던 것'을 알 수 없다.
    var want0 = readHash();
    // 권한 관리 메뉴를 보일지 서버에 물어본다. 실패해도 화면은 정상 동작한다.
    apiRetry('/functions/v1/driving-account', { method: 'POST', body: JSON.stringify({ action: 'whoami' }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (a) {
        if (a && a.ok) {
          ACCT = a;
          document.body.classList.toggle('is-master', !!a.can_manage_admin);
          // 주소가 권한 관리 화면이었으면 이제 들어갈 수 있다(프로필이 먼저 오면 마감 현황으로 떨어졌다).
          if (want0 && want0.view === 'perm' && VIEW !== 'perm' && a.can_manage_admin && ME) {
            want0 = null;                // 한 번만 — 그 뒤로는 사용자가 고른 화면을 따른다
            VIEW = 'perm'; applyScope(); writeHash();
          }
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
      // 새로고침해도 보던 화면·기간으로 돌아온다(주소의 # 뒤).
      var h0 = readHash();
      if (h0) applyHash(h0);
      // 경로·질의를 함께 적는다 — '#…' 만 넘기면 <base> 가 있는 쪽에서는 그 기준으로 풀려 경로가 바뀐다.
      try { history.replaceState(null, '', location.pathname + location.search + hashOf()); } catch (e) { }
      loadAll();
    });
  }

  /* ══════════════════ 기간 고르기 ══════════════════
     머리띠 가운데의 ◀ [기간] ▶ 와 그 아래 펼침 창.
       · 한 주기  : 마감 작업을 하는 평소 상태. ◀ ▶ 와 [ ] 키로 한 주기씩 넘긴다.
       · 여러 주기: 조회 전용(RANGE). 최근 3·6주기, 올해, 작년, 직접 지정.
     주기 목록에는 그 주기의 내 결재 상태를 같이 보여 준다 — 어느 달을 안 올렸는지
     드롭다운을 훑지 않아도 보이게.                                          */
  function addCycle(c, n) {
    var y = c.y, m = c.m + n;
    while (m > 12) { m -= 12; y += 1; }
    while (m <= 0) { m += 12; y -= 1; }
    return { y: y, m: m };
  }
  function cmpCycle(a, b) { return (a.y * 12 + a.m) - (b.y * 12 + b.m); }
  function buildCycleSelect() { paintCycle(); }
  function paintCycle() {
    // 연도는 .yr 로 감싼다 — 좁은 화면에서 접어 한 줄을 지키기 위해서다.
    if (RANGE) {
      var a = RANGE.from, b = RANGE.to;
      $('cycleTxt').innerHTML = '<span class="yr">' + a.y + '년 </span>' + a.m + '월분 – ' +
        (a.y === b.y ? '' : '<span class="yr">' + b.y + '년 </span>') + b.m + '월분';
      $('cycleTag').textContent = cyclesInView().length + '주기 · 조회 전용';
    } else {
      $('cycleTxt').innerHTML = '<span class="yr">' + CYC.y + '년 </span>' + CYC.m + '월분';
      $('cycleTag').textContent = cycleSpan(CYC.y, CYC.m);
    }
    var cur = currentCycle();
    var last = RANGE ? RANGE.to : CYC;
    $('cycNext').disabled = cmpCycle(last, cur) >= 0;
    $('cycleBox').classList.toggle('multi', !!RANGE);
    $('cycleBox').classList.toggle('past', !RANGE && cmpCycle(CYC, cur) < 0);
  }
  /** 내 결재 상태 한 마디(주기 목록에 붙인다). */
  function myApprTag(key) {
    var a = myAppr(key);
    if (!a) return '';
    var m = { approved: ['결재 완료', 'ok'], submitted: ['결재 중', 'warn'], rejected: ['반려', 'bad'], withdrawn: ['회수', 'dim'] }[a.status];
    return m ? '<span class="st ' + m[1] + '">' + m[0] + '</span>' : '';
  }
  function paintCyclePop() {
    var cur = currentCycle(), h = '';
    var q = function (label, attr, on) {
      return '<button class="cpq' + (on ? ' on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" ' + attr + '>' + label + '</button>';
    };
    var isR = function (from, to) {
      return RANGE && cmpCycle(RANGE.from, from) === 0 && cmpCycle(RANGE.to, to) === 0;
    };
    var prev = addCycle(cur, -1), y1 = { y: cur.y, m: 1 };
    h += '<div class="cp-sec">빠른 선택</div><div class="cp-quick">' +
      q('이번 주기', 'data-cyc="' + cur.y + '-' + cur.m + '"', !RANGE && cmpCycle(CYC, cur) === 0) +
      q('지난 주기', 'data-cyc="' + prev.y + '-' + prev.m + '"', !RANGE && cmpCycle(CYC, prev) === 0) +
      q('최근 3주기', 'data-range="' + cycKey(addCycle(cur, -2)) + '~' + cycKey(cur) + '"', isR(addCycle(cur, -2), cur)) +
      q('최근 6주기', 'data-range="' + cycKey(addCycle(cur, -5)) + '~' + cycKey(cur) + '"', isR(addCycle(cur, -5), cur)) +
      (cur.m > 1 ? q(cur.y + '년 전체', 'data-range="' + cycKey(y1) + '~' + cycKey(cur) + '"', isR(y1, cur)) : '') +
      q((cur.y - 1) + '년 전체', 'data-range="' + (cur.y - 1) + '-01~' + (cur.y - 1) + '-12"',
        isR({ y: cur.y - 1, m: 1 }, { y: cur.y - 1, m: 12 })) +
      '</div>';
    // 주기 목록 — 최근 24개. 오래된 것은 '직접 지정'으로 간다.
    // 목록은 그냥 버튼들이다. listbox/option 역할을 주면 화살표 키로 움직여야 하는데 그렇게 만들지 않았다 —
    // 역할만 붙이면 화면낭독기 사용자가 쓸 수 없는 목록이 된다. 지금 고른 것은 aria-current 로 알린다.
    h += '<div class="cp-sec" id="cpListLab">주기 고르기</div><div class="cp-list" role="group" aria-labelledby="cpListLab">';
    var opts = '';
    for (var i = 0; i < 24; i++) {
      var c = addCycle(cur, -i), on = !RANGE && cmpCycle(CYC, c) === 0;
      h += '<button class="cpi' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-cyc="' + c.y + '-' + c.m + '">' +
        '<b>' + c.y + '년 ' + c.m + '월분</b><span class="dim">' + cycleSpan(c.y, c.m) + '</span>' +
        (i === 0 ? '<span class="kind">이번</span>' : '') + '<span style="flex:1"></span>' + myApprTag(cycKey(c)) + '</button>';
    }
    h += '</div>';
    for (var k = 0; k < 36; k++) {
      var c2 = addCycle(cur, -k);
      opts += '<option value="' + cycKey(c2) + '">' + c2.y + '년 ' + c2.m + '월분</option>';
    }
    var f0 = RANGE ? cycKey(RANGE.from) : cycKey(addCycle(CYC, -2)), t0 = RANGE ? cycKey(RANGE.to) : cycKey(CYC);
    h += '<div class="cp-sec">여러 주기 직접 지정 <small>조회 전용</small></div>' +
      '<div class="cp-range"><select id="cpFrom" aria-label="시작 주기">' + opts.replace('value="' + f0 + '"', 'value="' + f0 + '" selected') +
      '</select><span class="dim">부터</span><select id="cpTo" aria-label="끝 주기">' +
      opts.replace('value="' + t0 + '"', 'value="' + t0 + '" selected') +
      '</select><span class="dim">까지</span><button class="btn sm pri" id="cpGo">보기</button></div>' +
      '<div class="cp-note">여러 주기를 볼 때는 조회만 됩니다. 상신·결재 문서·통행료 채우기·영수증 올리기는 한 주기를 골라서 합니다. ' +
      '<span class="kbd">[</span> <span class="kbd">]</span> 키로 앞뒤 주기로 넘깁니다.</div>';
    $('cycPop').innerHTML = h;
  }
  function openCyclePop(open) {
    var pop = $('cycPop');
    if (open === undefined) open = pop.hidden;
    var was = !pop.hidden;
    // 닫을 때 포커스가 창 안에 있었으면 연 버튼으로 돌려준다 — 감춰진 곳에 남으면 키보드로 쓰던 자리를 잃는다.
    var inside = was && !open && pop.contains(document.activeElement);
    if (open) paintCyclePop();
    pop.hidden = !open;
    $('cycBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      // 열면 지금 고른 주기(없으면 첫 빠른 선택)로 포커스를 옮긴다. Tab 을 스무 번 누르지 않아도 된다.
      var on = pop.querySelector('.cpi.on') || pop.querySelector('.cpq.on') || pop.querySelector('.cpq');
      if (on) { on.scrollIntoView({ block: 'nearest' }); try { on.focus({ preventScroll: true }); } catch (e) { } }
    } else if (inside) {
      try { $('cycBtn').focus(); } catch (e) { }
    }
  }
  function parseCyc(s) {
    var v = String(s || '').split('-');
    var y = +v[0], m = +v[1];
    return (y >= 2020 && y <= 2100 && m >= 1 && m <= 12) ? { y: y, m: m } : null;
  }
  /**
   * 기간을 바꾼다. p = { cyc:{y,m} } 또는 { range:{from,to} }.
   * 한 주기짜리 범위는 그냥 한 주기로 본다. 앞뒤가 바뀐 범위는 바로잡는다. 최대 36주기.
   */
  function setPeriod(p, opt) {
    // ★ 통행료 채우기에 쳐 둔 값은 기간이 바뀌면 사라진다. 40칸을 말없이 날리지 않는다.
    if (!(opt && opt.silent) && unsavedFills()) {
      openCyclePop(false);
      toast('저장하지 않은 통행료 ' + n0(unsavedFills()) + '구간이 있습니다. 「통행료 채우기」에서 먼저 저장해 주세요.', true);
      return;
    }
    var cur = currentCycle();
    if (p.range) {
      var a = p.range.from, b = p.range.to;
      if (cmpCycle(a, b) > 0) { var t = a; a = b; b = t; }
      if (cmpCycle(b, cur) > 0) b = cur;
      if (cmpCycle(a, b) > 0) a = b;
      if (cmpCycle(b, a) > 35) a = addCycle(b, -35);
      if (cmpCycle(a, b) === 0) { RANGE = null; CYC = b; }
      else { RANGE = { from: a, to: b }; CYC = b; }
    } else {
      RANGE = null; CYC = p.cyc;
    }
    FILLS = {};                          // 주기가 바뀌면 구간 키가 의미를 잃는다 — 여기서만 버린다(바꾸기 전에 unsavedFills 로 막는다)
    DATEF = { from: '', to: '' }; PAGES = {};
    EXT.onCycle.forEach(function (fn) { try { fn(); } catch (e) { } });
    openCyclePop(false);
    paintCycle();
    if (!(opt && opt.silent)) { writeHash(); loadAll({ soft: true }); }
  }
  /**
   * 통행료 채우기에 쳐 놓고 아직 저장하지 않은 구간 수.
   * ★ '지금도 저장할 수 있는' 구간만 센다. 상신해서 잠겼거나 그 구간이 다른 길(하이패스 확정·운행 고치기)로
   *   이미 정해졌으면 저장할 화면이 없다 — 그것까지 세면 기간을 영영 못 바꾼다(2026-10-02 재검증).
   */
  function unsavedFills() {
    if (isMulti() || !ME || cycleLocked(myName())) return 0;
    var live = {}, mine = myName();
    ALL_TRIPS.forEach(function (t) {
      if (t.username === mine && isUnknownToll(t) && (t.purpose || '') === BUSINESS) {
        live[dong(t.start_address) + ' → ' + dong(t.end_address)] = 1;
      }
    });
    return Object.keys(FILLS).filter(function (k) { return FILLS[k] != null && live[k]; }).length;
  }
  function stepCycle(n) {
    if (RANGE) {
      if (n > 0 && cmpCycle(RANGE.to, currentCycle()) >= 0) return;
      setPeriod({ range: { from: addCycle(RANGE.from, n), to: addCycle(RANGE.to, n) } });
    }
    else {
      var c = addCycle(CYC, n);
      if (cmpCycle(c, currentCycle()) > 0) return;
      setPeriod({ cyc: c });
    }
  }

  /* ── 주소(#)에 보던 화면·기간을 남긴다 — 새로고침·뒤로가기를 해도 제자리로 온다 ── */
  var HASH_LOCK = false;
  function hashOf() {
    return '#/' + VIEW + '/' + (RANGE ? cycKey(RANGE.from) + '~' + cycKey(RANGE.to) : cycKey(CYC));
  }
  function writeHash() {
    var h = hashOf();
    if (location.hash === h) return;
    HASH_LOCK = true;
    try { location.hash = h; } catch (e) { }
    setTimeout(function () { HASH_LOCK = false; }, 0);
  }
  /** 주소에서 화면·기간을 읽는다. 못 읽으면 null. */
  function readHash() {
    var m = /^#\/([a-z_]+)(?:\/(\d{4}-\d{1,2})(?:~(\d{4}-\d{1,2}))?)?$/.exec(location.hash || '');
    if (!m) return null;
    var a = m[2] ? parseCyc(m[2]) : null, b = m[3] ? parseCyc(m[3]) : null;
    return { view: m[1], a: a, b: b };
  }

  /* ══════════════════ 데이터 적재 ══════════════════
     · 운행은 조회 범위만 받는다(범위가 여러 주기면 그만큼).
     · 나머지(사람·차량·증빙·결재·단가…)는 기간과 무관하다 — 기간만 바꿀 때(soft)는 받은 지
       3분 안이면 다시 받지 않는다. 그래서 ◀ ▶ 로 넘기는 것이 빨라졌다.
     · 저장·올리기 뒤에 부르는 loadAll() 은 늘 전부 새로 받는다(캐시를 버린다).                */
  var TRIP_CACHE = {};                   // 'scope|lo|hi' → { rows, at }
  var STATIC_AT = 0, CACHE_MS = 180000;
  var LOADED_ALL = false;                // 지금 운행 목록이 전 직원 것인가(관리자가 여러 주기를 볼 때는 본인 것만 받는다)
  function loadAll(opt) {
    // ★ 예전에는 로딩 중이면 그냥 돌아갔다. 주기를 빠르게 두 번 바꾸면 두 번째
    //   요청이 버려져 옛 주기 데이터가 새 주기 이름으로 그려졌다. 이제는 표를
    //   달아 두고, 늦게 도착한 응답을 버린다.
    var soft = !!(opt && opt.soft);
    var seq = ++LOAD_SEQ;
    LOADING = true; LOADED = false; AUDIT = null; LOAD_ERR = '';
    if (!soft) { TRIP_CACHE = {}; STATIC_AT = 0; }
    render();
    // 기간이 바뀌면 필터·하이패스 대조 결과는 의미가 없다. 같이 비운다.
    //   (필터는 남는데 셀렉트는 '전체'로 보여 "왜 표가 비었는지" 알 수 없었다.
    //    하이패스는 옛 주기 운행 객체를 가리킨 채 남아 반영 결과가 안 보였다.)
    //   저장·올리기 뒤의 다시 받기(soft 아님)는 같은 기간이므로 좁혀 둔 것을 지킨다.
    if (soft) { FILT.who = ''; FILT.car = ''; FILT.q = ''; FILT.chip = 'all'; FILT.purp = BUSINESS; }
    HP = { groups: [], batch: '', busy: false, note: '' };
    // FILLS 는 여기서 안 버린다. loadAll 은 저장·증빙 올리기 뒤에도 돌기 때문에,
    // 여기서 비우면 증빙 한 장 올리고 온 사이에 30칸이 사라진다. 기간을 바꿀 때(setPeriod)만 비운다.
    // 내 서명(상신 전 문서의 담당 칸에 찍는다). 한 번만 받는다.
    if (MYSIGN === undefined) loadMySign();
    loadStep();
    var r = viewRange();
    var COLS = 'id,username,plate_no,start_time,end_time,distance_km,purpose,' +
      'start_address,end_address,visit_place,start_odometer,end_odometer,start_lat,start_lng,' +
      'toll_cost,toll_status,toll_source,toll_revision,parking_cost,is_manual,' +
      'overspeed_count,rapid_accel_count,rapid_decel_count,max_speed_kmh,' +
      // ★ 이 셋이 빠지면 점수가 실제보다 높게 나온다(앱 SafetyScore 와 갈린다).
      'school_zone_overspeed_count,sustained_overspeed_count,harsh_corner_count';

    // 관리자가 개인 화면에서 여러 주기를 보면 본인 것만 받는다. 전 직원 1년치는 수만 건이다.
    var wantAll = !(ME && ME.is_admin && isMulti() && !isAll());
    var ck = (wantAll ? 'all' : 'me') + '|' + r.lo + '|' + r.hi;
    var hit = TRIP_CACHE[ck];
    var tripsP = (soft && hit && Date.now() - hit.at < CACHE_MS)
      ? Promise.resolve(hit.rows)
      : fetchAll('/rest/v1/trips?select=' + COLS + '&deleted_at=is.null' +
        (wantAll ? '' : '&username=eq.' + encodeURIComponent(myName())) +
        // id 를 둘째 정렬 키로 — 출발시각이 같은 운행(수기 기본 09:00)이 1000행 경계에 걸리면
        // 한 건이 빠지거나 두 번 들어왔다. 서버(approval-act)도 같은 이유로 id 를 넣어 두었다.
        '&start_time=gte.' + r.lo + '&start_time=lt.' + r.hi + '&order=start_time.desc,id.desc')
        .then(function (rows) { TRIP_CACHE[ck] = { rows: rows || [], at: Date.now() }; return rows; });

    var fresh = soft && STATIC_AT && Date.now() - STATIC_AT < CACHE_MS;
    var staticP = fresh ? Promise.resolve(null) : Promise.all([
      fetchAll('/rest/v1/app_users?select=username,name,dept,position,is_admin,plate_no,company_name,vehicle_type,signup_status,uses_driving'),
      fetchAll('/rest/v1/app_vehicles?select=*'),
      fetchAll('/rest/v1/evidences?select=id,username,vehicle_plate,date_millis,category,amount,memo,photo_path,scan_path,trip_id&order=id.asc'),
      fetchAll('/rest/v1/edu_videos?deleted=eq.false&select=*&order=month.desc,id.asc'),
      fetchAll('/rest/v1/edu_progress?select=*'),
      fetchAll('/rest/v1/edu_targets?select=*'),
      fetchAll('/rest/v1/fuel_rates?select=year,quarter,region,price'),
      apiRetry('/rest/v1/app_config?id=eq.1&select=quarter_bounds').then(function (x) { return x.ok ? x.json() : []; }),
      // RLS 가 걸러 준다 — 본인 것 · 내가 결재자인 것 · 관리자는 전부.
      fetchAll('/rest/v1/driving_approvals?select=*&order=submitted_at.desc'),
      // ※ 부서별 결재선(driving_approval_lines)은 더 읽지 않는다 — 결재선은 상신자가 직접 고른다(2026-10-02).
      // 결재자를 고르려면 사람 목록이 필요하다. app_users 는 본인만 보이므로 뷰를 쓴다.
      fetchAll('/rest/v1/v_driving_people?select=*&order=name.asc'),
      // 조직도(사람 명단 — 관리 화면). 내려간 사람(active=false)은 받지 않는다.
      fetchAll('/rest/v1/driving_org?select=*&active=eq.true&order=sort.asc,id.asc')
    ]);

    Promise.all([tripsP, staticP]).then(function (both) {
      // ★ 반드시 아무것도 대입하기 전에 버린다. 예전에는 아래 대입이 전부 끝난 뒤에
      //   가드가 있어서, 늦게 온 응답이 데이터는 덮어쓰고 다시 그리기만 건너뛰었다.
      //   그러면 머리띠는 8월분인데 숫자는 9월분인 화면이 된다(21일 마감에 서버가
      //   느려질 때 정확히 터지는 조건).
      if (seq !== LOAD_SEQ) return;
      var out = both[1];
      ALL_TRIPS = both[0] || [];
      LOADED_ALL = wantAll;
      // fetchAll 은 41,000행에서 멈춘다. 닿았으면 잘렸다는 것을 숨기지 않는다.
      if (ALL_TRIPS.length >= 41000) toast('운행이 너무 많아 일부만 불러왔습니다. 기간을 줄여 주세요.', true);
      if (out) {
        // 업무 결재 포털 가입 대기·거절 계정은 직원으로 치지 않는다(가입 신청은 「권한 관리」에 따로 나온다).
        USERS = {}; (out[0] || []).forEach(function (u) { if (!u.signup_status || u.signup_status === 'active') USERS[u.username] = u; });
        VEHICLES = out[1] || [];
        ALL_EVID = out[2] || [];
        EDUV = out[3] || []; EDUP = out[4] || []; EDUT = out[5] || [];
        RATES = {};
        (out[6] || []).forEach(function (x) { RATES[x.year + '-' + x.quarter + '-' + x.region] = Number(x.price); });
        var cfg = (out[7] || [])[0];
        if (cfg) setQuarterBounds(cfg.quarter_bounds);
        APPR = out[8] || [];
        PEOPLE = {}; (out[9] || []).forEach(function (p) { PEOPLE[p.username] = p; });
        ORG = out[10] || [];
        STATIC_AT = Date.now();
      }
      RATE_MISS = {};
      LOADED = true; LOADING = false; AUDIT = null;
      // 받는 사이에 관리 화면으로 옮겨 갔는데 본인 것만 받아 왔으면, 전 직원 것으로 다시 받는다.
      if (isAll() && !LOADED_ALL) { loadAll({ soft: true }); return; }
      applyScope();
      paintPills();
      paintCycle();
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
     2026-09 감사에서 잡힌 것: 계기판 대역 도약(한 직원 175,500km 오타),
     차량 혼선(두 직원 18건), 통행료 미확정, 0km 운행.                  */
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

    // ⑦ 유류단가 미등록 — 기본 단가로 계산되는 지점.
    //   ★ 이 목록(LIST) 안에서만 센다. 예전에는 전역 RATE_MISS 를 읽어서, 관리자가 전체 화면을
    //     한 번 보고 오면 남의 운행에서 생긴 미등록 단가가 내 점검에 빨갛게 떴다.
    var miss = {};
    LIST.forEach(function (t) {
      if ((t.purpose || '') !== BUSINESS) return;
      var k = rateKeyOf(t);
      if (RATES[k] == null) miss[k] = 1;
    });
    var missKeys = Object.keys(miss);

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
        d: missKeys.length ? missKeys.join(' · ') + ' 단가가 없어 기본 단가 159원/km 로 계산됩니다. 실제 단가와 다를 수 있으니 등록해 주세요.' : '없습니다.' },
      { k: 'unk', sev: 'warn', ico: 'ticket', t: '통행료 미확정', rows: unk, n: unk.length,
        d: '정산에서 0원으로 잡혀 회사가 덜 내주게 됩니다. 「통행료 채우기」에서 구간별로 한 번에 정리하실 수 있습니다.' },
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
  /**
   * 비용 합계. 운행에 적힌 금액에 **영수증(주차·통행료) 금액을 더한다** — 앱 엑셀·임원 리포트와
   * 같은 규칙(2026-09-29). 예전에는 운행만 더해서, 이 화면의 합계가 같은 화면에서 내려받는
   * 엑셀과 달랐다. 운행 목록 표의 소계처럼 '표에 있는 운행만' 원하면 opt.tripsOnly.
   * ※ 영수증은 목적이 없어 목적과 무관하게 더한다(엑셀도 운행 없는 날의 영수증을 행으로 남긴다).
   */
  function totals(rows, opt) {
    var o = { n: rows.length, km: 0, bizKm: 0, fuel: 0, toll: 0, park: 0, unk: 0, manual: 0, evPark: 0, evToll: 0, evN: 0 };
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
    if (!(opt && opt.tripsOnly)) {
      var users = {};
      rows.forEach(function (t) { users[t.username] = 1; });
      // 운행이 한 건도 없어도 영수증만 올린 사람이 있다(opt.who). 예전에는 그 금액이 화면 합계에서
      // 빠지고 인쇄물에는 '근거자료' 행으로 나와, 같은 사람의 두 숫자가 달랐다.
      if (opt && opt.who) users[opt.who] = 1;
      // 전체(관리) 합계는 사람을 가리지 않는다 — 운행 없이 영수증만 올린 사람의 금액이 본인 화면에는 있고
      // 전체 합계에는 없었다(opt.allUsers).
      var any = !!(opt && opt.allUsers);
      var r = (opt && opt.range) || viewRange();
      EVID.forEach(function (e) {
        if (!any && !users[e.username]) return;
        var d = Number(e.date_millis);
        if (!(d >= r.lo && d < r.hi)) return;
        var a = Number(e.amount);
        if (!(a > 0)) return;
        if (e.category === '주차') { o.park += a; o.evPark += a; o.evN++; }
        else if (e.category === '통행료') { o.toll += a; o.evToll += a; o.evN++; }
      });
    }
    o.cost = o.fuel + o.toll + o.park;
    return o;
  }

  /**
   * 메뉴 뱃지. **항상 본인 기준**이어야 한다 — 개인 메뉴에 붙은 숫자이기 때문이다.
   * 예전에는 현재 화면 범위(TRIPS·EVID)를 써서, 관리 화면에 있는 동안 저장하거나
   * 주기를 다시 고르면 전사 숫자가 박히고 개인 화면으로 돌아와도 안 돌아왔다.
   */
  /**
   * 마감 단계 1~5 의 상태 — 본인 · 지금 보는 주기(A안, 2026-10-02). 메뉴 동그라미와 홈 막대가 같이 쓴다.
   *   1 운행 기록 : 기록 점검에서 고칠 것(통행료 미확정·유류단가 미등록은 뺀다 — 앞은 2단계, 뒤는 관리자 몫)
   *   2 통행료   : 업무 운행의 통행료 미확정
   *   3 영수증   : 금액은 있는데 사진이 없는 영수증
   *   4 검증·상신 / 5 정산·엑셀 : 결재 상태
   * 상신 전에는 고칠 것이 남은 첫 단계가 '지금 할 일'(now), 그 앞은 완료(done), 뒤는 남음(todo).
   * 같은 미확정 통행료가 1단계와 2단계에 두 번 세어지지 않게 한다(검증로봇: "할 일이 10건처럼 보인다").
   */
  /* ── 마감 단계 진행 위치 (2026-10-06) ──
     예전에는 고칠 것이 없으면 누르지 않아도 ✓ 가 붙어 단계가 저절로 넘어갔다("누르지도 않았는데 영수증까지 가 있다").
     이제는 모두 ① 운행 기록에서 시작해 「다음 단계」를 눌러야 넘어가고, 「이전 단계」로 되돌아갈 수 있다.
     위치는 서버 driving_step_progress(본인 것만)에 둔다 — PC 를 바꿔도 같다. 못 읽으면 ①. */
  var STEP_P = {}, STEP_ASKED = {};
  // 통행료는 영수증 단계 안으로 합쳤다(2026-10-06 사용자 요청) — 영수증 안에서 주차 → 통행료 → 주유 → 계기판 순서.
  var STEP_NAMES = ['운행 기록', '영수증·통행료', '검증·상신', '정산·엑셀'];
  var STEP_VIEW = ['trips', 'evid', 'verify', 'settle'];
  var STEP_OF = { trips: 1, check: 1, evid: 2, tollfill: 2, hipass: 2, verify: 3, settle: 4 };
  /* ── 영수증 단계 안의 순서 ── */
  var EV_SUBS = ['주차', '통행료', '주유', '계기판'];
  var EV_SUB_DESC = {
    '주차': '주차 영수증을 올립니다. 운행에 주차비를 이미 적었다면 같은 결제를 또 올리지 마세요(두 번 더해집니다).',
    '통행료': '통행료는 하이패스 이용내역 PDF로 한 번에 맞추거나, 구간별로 직접 채웁니다. 현금·카드 영수증이 있으면 올립니다.',
    '주유': '주유 영수증은 증빙용입니다. 유류비는 거리 × 단가로 따로 계산됩니다.',
    '계기판': '월초·월말 계기판 사진을 올립니다. 운행 기록의 계기판 숫자와 맞는지 확인하는 데 씁니다.'
  };
  var EVSUB_FX = '';
  function evSub() { var v = 0; try { v = +sessionStorage.getItem('drv.evsub.' + CYCKEY()) || 0; } catch (e) { } return Math.max(0, Math.min(3, v)); }
  /** 이 주기에서 영수증 차례를 어디까지 지나왔는가(0~3). 3 이면 계기판까지 왔다 — 3단계로 넘어갈 수 있다. */
  function evSubMax() { var v = 0; try { v = +localStorage.getItem('drv.evsubmax.' + myName() + '.' + CYCKEY()) || 0; } catch (e) { } return Math.max(evSub(), Math.min(3, v)); }
  function setEvSub(i, fx) {
    i = Math.max(0, Math.min(3, i));
    try { sessionStorage.setItem('drv.evsub.' + CYCKEY(), String(i)); } catch (e) { }
    try { if (i > evSubMax()) localStorage.setItem('drv.evsubmax.' + myName() + '.' + CYCKEY(), String(i)); } catch (e) { }
    EVSUB_FX = fx || '';
    EVF.cat = EV_SUBS[i]; EVF.touched = false;
  }
  /** 영수증 화면 위 — 주차 → 통행료 → 주유 → 계기판 차례와 지금 차례의 할 일. */
  function evSubHtml(by, unk) {
    var cur = evSub(), name = EV_SUBS[cur];
    var steps = '<div class="evsubs" role="list">' + EV_SUBS.map(function (c, i) {
      var st = i < cur ? 'done' : i === cur ? 'now' : '';
      var n = (by[c] || {}).n || 0;
      return '<button role="listitem" class="evs ' + st + '" data-evsub="' + i + '"' + (st === 'now' ? ' aria-current="step"' : '') + '>' +
        '<i>' + (st === 'done' ? '✓' : i + 1) + '</i><b>' + esc(c) + '</b><span>' + n0(n) + '건</span></button>' +
        (i < 3 ? '<span class="evsarrow" aria-hidden="true">›</span>' : '');
    }).join('') + '</div>';
    var body = '<div class="evsubcard' + (EVSUB_FX ? ' stepfx ' + EVSUB_FX : '') + '">' +
      '<div class="evsh"><span class="evsn">' + (cur + 1) + ' / 4</span><b>' + esc(name) + '</b>' +
      '<span class="dim">' + esc(EV_SUB_DESC[name]) + '</span></div>';
    if (name === '통행료') {
      body += '<div class="tollpick">' +
        '<button class="tchoice" data-v="hipass"><span class="tci">' + ic('receipt', 20) + '</span><b>하이패스 PDF로 대조</b>' +
        '<span>한국도로공사 이용내역 PDF를 올리면 운행과 자동으로 맞춥니다. <em>가장 정확합니다</em></span></button>' +
        '<button class="tchoice" data-v="tollfill"><span class="tci">' + ic('ticket', 20) + '</span><b>통행료 직접 채우기' +
        (unk ? ' <span class="pill hot" style="display:inline-grid;margin-left:4px">' + n0(unk) + '</span>' : '') + '</b>' +
        '<span>' + (unk ? '아직 정해지지 않은 업무 운행 ' + n0(unk) + '건을 구간별로 한 번에 채웁니다.' : '미확정 통행료가 없습니다. 확인만 하시면 됩니다.') + '</span></button>' +
        '</div>';
    }
    // 주차·통행료: 날짜로 운행에 안 맞는 영수증을 본인이 운행을 골라 직접 잇는다(2026-10-07).
    var canLink = (name === '주차' || name === '통행료') && !cycleLocked(myName()) && !isMulti();
    var unm = canLink ? evUnmatched(name).length : 0;
    if (unm) {
      body += '<div class="hpnote warn" style="margin-top:12px">' + ic('alert', 15) + '<span><b>' + esc(name) + ' 영수증 ' + n0(unm) +
        '건</b>이 날짜로 맞는 운행을 찾지 못했습니다(수기 운행 시각이 다르거나 자정을 넘긴 결제 등). 「운행에 직접 맞추기」로 어느 운행의 영수증인지 골라 주세요.</span></div>';
    }
    body += evMatchHtml(name);
    body += '<div class="evsact">' +
      (cycleLocked(myName()) || isMulti() ? '' : '<button class="btn" data-evupcat="' + esc(name) + '">' + ic('receipt', 13) + esc(name) + ' 영수증 올리기</button>') +
      (canLink ? '<button class="btn' + (unm ? ' pri' : '') + '" data-evlink="' + esc(name) + '">' + ic('scan', 13) + '운행에 직접 맞추기' + (unm ? ' (' + n0(unm) + ')' : '') + '</button>' : '') +
      '<span style="flex:1"></span>' +
      (cur > 0 ? '<button class="btn" data-evsubmove="-1">← ' + esc(EV_SUBS[cur - 1]) + '</button>' : '') +
      (cur < 3 ? '<button class="btn pri cta" data-evsubmove="1">다음: ' + esc(EV_SUBS[cur + 1]) + ' →</button>'
        : (stepNow() === 2 && !cycleLocked(myName()) && !isMulti()
          ? '<button class="btn pri cta" data-stepmove="1" data-from="2">다음: 3 검증·상신 →</button>'
          : '<span class="dim" style="font-size:12.5px">마지막 차례입니다.</span>')) +
      '</div></div>';
    EVSUB_FX = '';
    return '<section class="sect">' + steps + body + '</section>';
  }
  /* ── 영수증 차례마다 「맞춰보기」(2026-10-07) ──
     서버 검증(driving-verify.ts R06·R10·R11·A02·A05)과 같은 기준을 그 자리에서 보여 준다.
       · 주차·통행료: 엑셀에 들어가는 금액(운행에 적은 금액 + 영수증)이 영수증과 같아야 한다.
         통행료 중 자동 계산·하이패스 PDF 대조·기사 확인분은 영수증 없이 인정한다.
       · 주유: 주유 영수증 합계 ≥ 청구 유류비(업무 거리 × 단가).
       · 계기판: 계기판 사진 숫자 ≥ 운행일지 최종 km.
     사진에서 읽은 숫자(AI)는 「검증하기」를 한 번 돌려야 생긴다(evidence_ai). 없으면 그렇게 안내한다. */
  var AIR = {}, AIR_ASKED = {};
  function loadAiReads() {
    var k = myName() + '|' + CYCKEY();
    if (AIR_ASKED[k] || !myName()) return;
    AIR_ASKED[k] = 1;
    apiRetry('/rest/v1/evidence_ai?select=evidence_id,photo_path,result&username=eq.' + encodeURIComponent(myName()))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        (rows || []).forEach(function (x) { AIR[x.evidence_id] = x; });
        if (VIEW === 'evid' && !$('panel').classList.contains('open')) render();
      }).catch(function () { delete AIR_ASKED[k]; });
  }
  /** 이 영수증 사진에서 AI 가 읽은 결과(사진이 바뀌었으면 없음으로). */
  function aiOf(e) { var x = AIR[e.id]; return x && x.photo_path === e.photo_path ? (x.result || {}) : null; }
  /** 통행료 금액과 영수증이 필요한가 — 서버 tollOf 와 같다. */
  function tollNeed(t) {
    var st = t.toll_status, amt = t.toll_cost == null ? null : Number(t.toll_cost);
    if (amt != null && !isFinite(amt)) amt = null;
    var ok = (st === 'UNKNOWN' || st === 'PENDING') ? amt === null
      : st === 'CHARGED' ? (amt !== null && amt >= 1 && amt <= TOLL_MAX)
      : st === 'FREE_CONFIRMED' ? amt === 0
      : st === 'MANUAL' ? (amt !== null && amt >= 0 && amt <= TOLL_MAX) : false;
    if (!ok) { if (amt != null && amt > 0) { st = 'MANUAL'; amt = Math.min(amt, TOLL_MAX); } else { st = 'UNKNOWN'; amt = null; } }
    if (st === 'UNKNOWN' || st === 'PENDING') return { a: 0, manual: false, hp: false };
    var src = t.toll_source || '';
    return { a: amt || 0, manual: st === 'MANUAL' && !(src === '하이패스 영수증' || src.indexOf('기사 확인') === 0), hp: src === '하이패스 영수증' };
  }
  function evMatchHtml(cat) {
    var me = myName(), r = cycleRange(CYC.y, CYC.m);
    loadAiReads();
    var biz = ALL_TRIPS.filter(function (t) {
      return t.username === me && !t.deleted_at && (t.purpose || '') === BUSINESS && t.start_time >= r.lo && t.start_time < r.hi;
    });
    var evs = ALL_EVID.filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === me && e.category === cat && d >= r.lo && d < r.hi;
    });
    var DOW = ['일', '월', '화', '수', '목', '금', '토'];
    var dn = function (k) { var p = k.split('-'); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); return (+p[1]) + '/' + (+p[2]) + '(' + DOW[d.getUTCDay()] + ')'; };
    var ok = function (t) { return '<span class="mres ok">' + ic('check', 12) + esc(t) + '</span>'; };
    var bad = function (t) { return '<span class="mres bad">' + esc(t) + '</span>'; };
    var box = function (good, headline, sub, table) {
      return '<div class="mbox ' + (good ? 'good' : 'bad') + '"><div class="mhead"><span class="mmark">' + (good ? '✓' : '!') + '</span>' +
        '<div><b>' + headline + '</b>' + (sub ? '<div class="msub">' + sub + '</div>' : '') + '</div></div>' + (table || '') + '</div>';
    };
    var won = function (v) { return n0(v) + '원'; };

    if (cat === '주차' || cat === '통행료') {
      var days = {};
      var slot = function (k) { return days[k] || (days[k] = { T: 0, A: 0, R: 0, rs: [], ts: [], hit: {} }); };
      biz.forEach(function (t) {
        var k = ymd(t.start_time);
        slot(k).ts.push(t);
        if (cat === '주차' ? Number(t.parking_cost) > 0 : tollNeed(t).manual && tollNeed(t).a > 0) slot(k).hit[t.id] = 1;
        if (cat === '주차') { var p = Number(t.parking_cost) || 0; if (p > 0) slot(k).T += p; }
        else { var tl = tollNeed(t); if (tl.a > 0) { if (tl.manual) slot(k).T += tl.a; else slot(k).A += tl.a; } }
      });
      evs.forEach(function (e) {
        var a = Number(e.amount) || 0; if (a <= 0) return;
        var s = slot(evDay(e, r)); s.R += a; s.rs.push(e);
        var lt = linkedTrip(e, r); if (lt) s.hit[lt.id] = 1;
      });
      // 그날 어느 운행인지 — 시각 · 방문처. 금액을 적었거나 영수증을 맞춘 운행을 먼저, 없으면 그날 업무 운행.
      var tripsTxt = function (d) {
        var ts = d.ts.slice().sort(function (a, b) { return a.start_time - b.start_time; });
        var pick = ts.filter(function (t) { return d.hit[t.id]; });
        if (!pick.length) pick = ts;
        if (!pick.length) return '<span class="dim">그날 업무 운행 없음</span>';
        var show = pick.slice(0, 3).map(function (t) {
          return '<div class="mtrip"><span class="mt">' + esc(hm(t.start_time)) + '</span>' + esc(t.visit_place || placeShort(t.end_address) || '방문처 없음') +
            (d.hit[t.id] && cat === '주차' && Number(t.parking_cost) > 0 ? ' <span class="dim">· 주차비 ' + n0(t.parking_cost) + '</span>' : '') + '</div>';
        }).join('');
        return show + (pick.length > 3 ? '<div class="dim">외 ' + (pick.length - 3) + '건</div>' : '');
      };
      var keys = Object.keys(days).filter(function (k) { var d = days[k]; return d.T || d.R; }).sort();
      var nBad = 0, xl = 0, pr = 0, auto = 0;
      Object.keys(days).forEach(function (k) { auto += days[k].A; });
      var rows = keys.map(function (k) {
        var d = days[k], excel = d.T + d.R, res, aiNote = [];
        d.rs.forEach(function (e) {
          var ai = aiOf(e);
          if (ai && ai.amount != null && isFinite(Number(ai.amount)) && Math.round(Number(ai.amount)) !== Number(e.amount))
            aiNote.push('사진엔 ' + won(Math.round(Number(ai.amount))) + ' (입력 ' + won(e.amount) + ')');
        });
        if (d.T > 0 && !d.R) res = bad('영수증 없음');
        else if (d.T > 0 && d.R) res = bad('두 번 더해짐');
        else if (aiNote.length) res = bad('사진 금액과 다름');
        else res = ok('일치');
        if (d.T > 0 || aiNote.length) nBad++;
        xl += excel; pr += d.R;
        return '<tr' + (d.T > 0 || aiNote.length ? ' class="flagged"' : '') + '><td style="white-space:nowrap">' + esc(dn(k)) + '</td>' +
          '<td class="mtrips">' + tripsTxt(d) + '</td>' +
          '<td class="n">' + (d.T ? won(d.T) : '<span class="dim">—</span>') + '</td>' +
          '<td class="n">' + (d.R ? won(d.R) + (d.rs.length > 1 ? ' <span class="dim">(' + d.rs.length + '장)</span>' : '') : '<span class="dim">없음</span>') +
            (aiNote.length ? '<div class="mai">' + esc(aiNote.join(', ')) + '</div>' : '') + '</td>' +
          '<td class="n"><b>' + won(excel) + '</b></td><td>' + res + '</td></tr>';
      }).join('');
      var word = cat === '주차' ? '주차비' : '직접 넣은 통행료';
      var table = keys.length ? '<div class="scroll"><table class="mtable"><thead><tr><th>날짜</th><th>운행 (시각 · 방문처)</th><th class="n">운행에 적은 ' + (cat === '주차' ? '주차비' : '통행료') + '</th>' +
        '<th class="n">영수증</th><th class="n">엑셀에 들어가는 금액</th><th>결과</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '';
      var autoNote = cat === '통행료' && auto > 0 ? ' 자동 계산·하이패스로 맞춘 통행료 ' + won(auto) + '은 영수증 없이 인정됩니다.' : '';
      if (!keys.length) return box(true, cat === '주차' ? '주차비·주차 영수증이 없습니다' : '영수증이 필요한 통행료가 없습니다', autoNote.trim(), '');
      return box(!nBad,
        nBad ? '맞지 않는 날이 <em>' + n0(nBad) + '일</em> 있습니다' : '엑셀 금액과 영수증이 모두 맞습니다',
        '엑셀 ' + (cat === '주차' ? '주차비' : '통행료(영수증 대상)') + ' ' + won(xl) + ' · 영수증 ' + won(pr) + '.' +
          (nBad ? ' 운행에 ' + word + '를 적었다면 영수증을 올리고 운행 쪽 금액은 지워 주세요(엑셀은 둘을 더합니다). 영수증이 없으면 금액을 지워야 합니다.' : '') + autoNote,
        table);
    }
    if (cat === '주유') {
      var claim = Math.round(biz.reduce(function (a, t) { return a + tripFuel(t); }, 0));
      var paidEv = evs.filter(function (e) { return (Number(e.amount) || 0) > 0; });
      var paid = paidEv.reduce(function (a, e) { return a + (Number(e.amount) || 0); }, 0);
      var kmSum = biz.reduce(function (a, t) { return a + odoKm(t); }, 0);
      var good = claim <= paid + 1;
      var tbl = '<div class="mcompare"><div><span>주유 영수증 합계</span><b>' + won(paid) + '</b><i>' + n0(paidEv.length) + '장</i></div>' +
        '<div class="mop">' + (good ? '≥' : '<') + '</div>' +
        '<div><span>엑셀 청구 유류비</span><b>' + won(claim) + '</b><i>업무 ' + n0(kmSum) + 'km × 단가</i></div></div>';
      if (!claim && !paid) return box(true, '업무 운행 유류비가 없습니다', '', '');
      return box(good, good ? '주유 영수증이 청구 유류비보다 많습니다 — 정상' : '청구 유류비가 주유 영수증보다 <em>' + won(claim - paid) + '</em> 많습니다',
        good ? '실제로 넣은 기름값(영수증) 안에서 업무 유류비를 청구합니다.' : '빠진 주유 영수증을 올리거나 운행 거리·목적을 확인해 주세요.', tbl);
    }
    if (cat === '계기판') {
      var plates = [];
      biz.forEach(function (t) { if (t.end_odometer != null) { var p = t.plate_no || ''; if (plates.indexOf(p) < 0) plates.push(p); } });
      if (!plates.length) return box(true, '이번 주기에 업무 운행이 없습니다', '', '');
      var shots = evs.filter(function (e) { return (e.photo_path || '') !== ''; });
      var plateOf = function (e) { return e.vehicle_plate || (plates.length === 1 ? plates[0] : null); };
      var anyBad = 0, needRun = 0;
      var rowsO = plates.map(function (p) {
        var mine = shots.filter(function (e) { return plateOf(e) === p; });
        var carT = biz.filter(function (t) { return (t.plate_no || '') === p; });
        var lastEnd = carT.reduce(function (a, t) { return Math.max(a, Math.round(Number(t.end_odometer) || 0)); }, 0);
        if (!mine.length) { anyBad++; return '<tr class="flagged"><td>' + esc(p || '차량 미지정') + '</td><td class="n">' + n0(lastEnd) + 'km</td><td class="n"><span class="dim">사진 없음</span></td><td>' + bad('사진을 올려 주세요') + '</td></tr>'; }
        var hit = null;
        mine.forEach(function (e) { var ai = aiOf(e); if (ai && ai.odometer_km != null && isFinite(Number(ai.odometer_km)) && (!hit || Number(e.date_millis) > Number(hit.e.date_millis))) hit = { e: e, v: Math.round(Number(ai.odometer_km)) }; });
        if (!hit) { needRun++; return '<tr><td>' + esc(p || '차량 미지정') + '</td><td class="n">' + n0(lastEnd) + 'km</td><td class="n"><span class="dim">아직 안 읽음</span></td><td><span class="mres">「검증하기」 때 읽습니다</span></td></tr>'; }
        var dk = ymd(Number(hit.e.date_millis)), fin = -1;
        carT.forEach(function (t) {
          var d = ymd(t.start_time), x = d < dk ? t.end_odometer : d === dk ? t.start_odometer : null;
          if (x != null) fin = Math.max(fin, Math.round(Number(x)));
        });
        var after = carT.filter(function (t) { return ymd(t.start_time) > dk; }).length;
        var diff = hit.v - fin, res;
        if (fin < 0) res = '<span class="mres">비교할 운행 없음</span>';
        else if (diff < -1000) { anyBad++; res = bad('사진 숫자 확인 필요'); }
        else if (diff < -3) { anyBad++; res = bad('운행일지가 더 큼'); }
        else res = ok('정상 (사진 ≥ 운행일지)');
        if (after) { anyBad++; res += ' ' + bad('사진 뒤 운행 ' + after + '건 — 다시 찍어 주세요'); }
        return '<tr' + (diff < -3 || after ? ' class="flagged"' : '') + '><td>' + esc(p || '차량 미지정') + '<div class="dim">' + esc(dn(dk)) + ' 사진</div></td>' +
          '<td class="n">' + (fin >= 0 ? n0(fin) + 'km' : '—') + '</td><td class="n"><b>' + n0(hit.v) + 'km</b></td><td>' + res + '</td></tr>';
      }).join('');
      var tblO = '<div class="scroll"><table class="mtable"><thead><tr><th>차량</th><th class="n">운행일지 최종 km</th><th class="n">계기판 사진 km</th><th>결과</th></tr></thead><tbody>' + rowsO + '</tbody></table></div>';
      return box(!anyBad && !needRun,
        anyBad ? '맞지 않는 차가 <em>' + n0(anyBad) + '건</em> 있습니다' : needRun ? '사진 숫자를 아직 읽지 않았습니다' : '계기판 사진이 운행일지 최종 km 와 같거나 큽니다 — 정상',
        '계기판 사진 숫자가 운행일지 마지막 km 와 <b>같거나 커야</b> 합니다(사진 찍고 조금 더 달린 것은 정상).' +
          (needRun ? ' 사진의 숫자는 3단계 「검증하기」를 누르면 AI 가 읽어 여기에도 나옵니다.' : ''),
        tblO);
    }
    return '';
  }
  function stepNow() { return STEP_P[CYCKEY()] || 1; }
  function loadStep() {
    var k = CYCKEY();
    if (isMulti() || STEP_ASKED[k] || !myName()) return;
    STEP_ASKED[k] = 1;
    apiRetry('/rest/v1/driving_step_progress?select=step&username=eq.' + encodeURIComponent(myName()) + '&cycle=eq.' + k)
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        STEP_P[k] = rows && rows[0] ? Number(rows[0].step) || 1 : 1;
        paintPills(); if (k === CYCKEY() && !$('panel').classList.contains('open')) render();
      }).catch(function () { delete STEP_ASKED[k]; });
  }
  function saveStep(n) {
    var k = CYCKEY();
    STEP_P[k] = n;
    apiRetry('/rest/v1/driving_step_progress?on_conflict=username,cycle', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ username: myName(), cycle: k, step: n, updated_at: new Date().toISOString() })
    }).then(function (r) { if (!r.ok) toast('단계 위치를 저장하지 못했습니다(이 화면에서는 그대로 보입니다).', true); })
      .catch(function () { });
  }
  /** 다음·이전 단계로. dir = +1 | -1, from = 지금 보고 있는 단계(1~5). 화면이 그 방향으로 밀려 들어온다. */
  function moveStep(from, dir) {
    var to = from + dir;
    if (to < 1 || to > 5) return;
    var p = stepNow();
    // 다음: 진행 위치를 앞으로(뒤로 끌어내리지 않는다). 이전: 지금 단계를 다시 열어 그 뒤는 안 한 것으로.
    if (dir > 0) saveStep(Math.max(p, Math.min(to, 3)));
    if (to === 2) setEvSub(dir > 0 ? 0 : 3);       // 영수증 단계에 들어오면 앞으로 올 땐 주차부터, 되돌아올 땐 계기판부터
    // ★ 이전 단계로 갈 때만 진행 위치를 그 단계로 되돌린다. 예전에는 위 if 와 else 로 묶여 2단계로 돌아갈 때
    //   저장이 빠졌고(새로 고치면 다시 3단계), 앞으로 갈 때도 뒤로 끌어내릴 수 있었다(2026-10-06 검증로봇 2).
    if (dir < 0 && p >= from) saveStep(to);
    STEP_FX = dir > 0 ? 'fwd' : 'back';
    go(STEP_VIEW[to - 1]);
    paintPills();                      // 메뉴 동그라미도 바로 바꾼다(톡 튀는 효과)
    toast(dir > 0 ? (to + ' ' + STEP_NAMES[to - 1] + ' 단계로 넘어갔습니다.') : (to + ' ' + STEP_NAMES[to - 1] + ' 단계로 돌아왔습니다. 고친 뒤 다시 「다음 단계」를 눌러 주세요.'));
  }
  var STEP_FX = '';
  function stepInfo() {
    var mine = myName(), r = viewRange();
    var my = ALL_TRIPS.filter(function (t) { return t.username === mine; });
    var fix = 0, fixBad = 0, kmSum = 0;
    auditOf(my).forEach(function (f) {
      if (f.k === 'unk' || f.k === 'rate') return;
      fix += f.n; if (f.sev === 'bad') fixBad += f.n;
    });
    my.forEach(function (t) { kmSum += Number(t.distance_km) || 0; });
    var unk = my.filter(function (t) { return isUnknownToll(t) && (t.purpose || '') === BUSINESS; }).length;
    var ev = ALL_EVID.filter(function (e) { var d = Number(e.date_millis); return e.username === mine && d >= r.lo && d < r.hi; });
    var noPhoto = ev.filter(function (e) { return Number(e.amount) > 0 && !e.photo_path; }).length;
    var a = myAppr(), st = a ? a.status : '';
    var sent = st === 'submitted' || st === 'approved';
    var steps = [
      { v: 'trips', t: '운행 기록', n: fixBad,
        sub: !my.length ? '운행 없음' : fixBad ? '고칠 것 ' + n0(fixBad) + '건'
          : fix ? '확인 ' + n0(fix) + '건 · ' + n0(my.length) + '건' : n0(my.length) + '건 · ' + km(kmSum) + ' km' },
      { v: 'evid', t: '영수증·통행료', n: unk,
        sub: (ev.length ? '영수증 ' + n0(ev.length) + '장' : '영수증 없음') + (unk ? ' · 통행료 미확정 ' + n0(unk) : '') },
      { v: 'verify', t: '검증·상신', n: 0,
        sub: st === 'approved' ? '결재 완료' : st === 'submitted' ? '결재 중' : st === 'rejected' ? '반려됨 — 다시 상신' : '아직 안 함' },
      { v: 'settle', t: '정산·엑셀', n: 0, sub: st === 'approved' ? '받을 수 있음' : '결재 후' }
    ];
    var cur = -1;
    if (sent) {
      steps.forEach(function (x, i) { x.state = st === 'approved' || i < 3 ? 'done' : 'todo'; });
    } else {
      // 사람이 진행한 위치를 따른다(① 부터). 상신 전에는 ④ 검증·상신까지만.
      cur = Math.min(stepNow(), 3) - 1;
      steps.forEach(function (x, j) { x.state = j < cur ? 'done' : j === cur ? 'now' : 'todo'; });
    }
    return { steps: steps, cur: cur, sent: sent, status: st, trips: my, ev: ev, unk: unk, fix: fix, fixBad: fixBad, noPhoto: noPhoto };
  }
  function paintPills() {
    var S = stepInfo();
    set('pCheck', S.fix, S.fixBad > 0);
    set('pEvid', S.noPhoto, false);
    set('pToll', S.unk, false);
    // 단계 동그라미 — 여러 주기를 함께 볼 때는 상태가 없다(번호만).
    S.steps.forEach(function (x, i) {
      var el = $('sn' + (i + 1)); if (!el) return;
      var stt = isMulti() ? '' : x.state;
      var was = el.className;
      el.className = 'stepn' + (stt ? ' ' + stt : '') + (was && was !== 'stepn' && was.indexOf(stt || '§') < 0 ? ' pop' : '');
      el.textContent = stt === 'done' ? '✓' : String(i + 1);
      // 지금 할 단계는 메뉴 줄 전체가 깜빡이며 눈에 띄게(2026-10-06).
      if (el.parentNode && el.parentNode.classList) el.parentNode.classList.toggle('isnow', stt === 'now');
    });
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
    var r = viewRange();
    return EVID.filter(function (e) { var d = Number(e.date_millis); return d >= r.lo && d < r.hi; });
  }
  function eduMonthKey() {
    // ★ 교육 회차 키 = 시청 기간이 **시작하는 달**(앱 EduMonth.key: 21일 이후면 이번 달, 20일까지는 전달).
    //   보고 있는 정산 주기 CYC 는 **끝나는 달**로 부르므로(9/21~10/20 = 10월분) 한 달을 뺀다.
    //   예전에는 CYC 를 그대로 써서 웹이 앱보다 한 회차 앞을 보여 주고, 의무 대상자에게 '대상 아님'이라 했다.
    var c = addCycle(CYC, -1);
    return c.y + '-' + pad(c.m);
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
      esc(viewName()) + ' · ' + esc(viewSpan()));

    if (!isAll()) {
      var s = safeOf(TRIPS);
      if (s.score < 0) {
        // blank() 는 설명을 esc() 하므로 태그를 넣으면 '<b>' 가 글자로 보인다 — 평문으로 쓴다.
        return h + blank('평가할 운행이 없습니다.',
          '안전운전 점수는 앱이 자동으로 기록한 운행만 봅니다. ' +
          '수기로 넣은 운행은 GPS 기록이 없어 평가하지 않습니다.', 'gauge');
      }
      var g = safeGrade(s.score);
      h += '<div class="hero fade">' +
        '<div class="eyebrow"><span class="dot' + (g[2] === 'ok' ? ' ok' : '') + '"></span>' +
        esc(viewName()) + ' 안전운전</div>' +
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
      esc(viewName()) + ' 전체 안전운전</div>' +
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
      '<th>소속</th><th>이름</th><th class="n">점수</th><th>등급</th>' +
      '<th class="n">운행</th><th class="n">거리</th><th class="n">과속</th>' +
      '<th class="n">급가속</th><th class="n">급감속</th><th class="n">100km당</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (x) {
        var u = USERS[x.u] || {}, g3 = safeGrade(x.score);
        return '<tr class="clk' + (x.score < 80 ? ' flagged' : '') +
          '" tabindex="0" data-person="' + esc(x.u) + '">' +
          orgCell(x.u) + '<td><span class="lead">' + esc(u.name || x.u) + '</span></td>' +
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
      '<th>날짜</th><th class="n">점수</th><th>구간</th><th>방문처</th><th class="n">과속</th>' +
      '<th class="n">급가감속</th><th class="n">최고</th></tr></thead><tbody>' +
      rows.map(function (t) {
        var sc = safeScore(t), g = safeGrade(sc);
        // 운행일지 표와 같은 규칙 — 방문처가 비면 도착지로 대신한다.
        var place = t.visit_place || t.end_address || '';
        return '<tr class="clk" tabindex="0" data-trip="' + esc(t.id) + '">' +
          '<td><span class="lead">' + md(t.start_time) + '</span> <span class="dim">' +
          hm(t.start_time) + (isNightTrip(t.start_time) ? ' 야간' : '') + '</span></td>' +
          '<td class="n total">' + n0(sc) + ' <span class="st ' + g[2] + '">' + g[1] + '</span></td>' +
          '<td class="dim">' + esc(dong(t.start_address)) + ' → ' + esc(dong(t.end_address)) + '</td>' +
          '<td class="el" title="' + esc(place) + '">' + esc(place) + '</td>' +
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
      '앱의 안전운전 점수와 같은 식으로 계산합니다. 앱과 다르게 나오면 알려 주세요.' +
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
    if (isMulti()) return singleOnly('통행료 채우기', '통행료 채우기');
    var mine = myName();
    var rows = TRIPS.filter(function (t) {
      return t.username === mine && isUnknownToll(t) && (t.purpose || '') === BUSINESS;
    });
    var h = head('통행료 채우기', rows.length
      ? n0(rows.length) + '건이 비어 있습니다'
      : '비어 있는 통행료가 없습니다');

    // ★ 결재가 끝난 주기는 서버가 통행료도 막는다. 채우게 두면 전부 채운 뒤
    //   저장에서야 '결재가 끝난 기간' 으로 다 튕긴다 — 먼저 말한다.
    if (rows.length && cycleLocked(mine)) {
      return h + lockedNote(lockTitle(mine),
        '비어 있는 ' + n0(rows.length) + '건은 정산에 0원으로 들어갔습니다. ' + lockHow(mine));
    }

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
      // 사람이 정한 값 판정은 hipass.js 의 bySource() 하나만 쓴다(운행일지 표의 '확정' 표시와 같은 기준).
      var human = window.Hipass && window.Hipass.bySource
        ? window.Hipass.bySource(t.toll_source) === 'person'
        : (t.toll_source === '하이패스 영수증' || t.toll_source === '웹 직접 입력');
      if (!human) return;
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
      '전에 정하신 금액이 있으면 「지난번 N원」 버튼이 붙어 있습니다 — 누르면 그대로 들어갑니다.<br>' +
      '잘못 눌렀으면 칸을 비우세요. 비운 줄은 \'아직 안 정함\' 으로 돌아갑니다.<br>' +
      '<b style="color:var(--ink-2)">업무용 운행만</b> 보입니다. 출퇴근·비업무용은 정산과 제출 서류에 ' +
      '들어가지 않아 채우실 필요가 없습니다.' +
      '<div style="margin-top:12px">한국도로공사 <b style="color:var(--ink-2)">하이패스 이용내역 PDF</b> 가 ' +
      '있으면 한 번에 확정됩니다. ' +
      '<button class="btn sm" data-v="hipass" style="margin-left:4px">하이패스 대조 ' + ic('chev', 13) +
      '</button></div>' +
      '</div></section>';

    h += '<section class="sect"><div class="hpact" style="border-radius:var(--r-lg);' +
      'border:1px solid var(--line);background:var(--surface);padding:12px 16px">' +
      '<span class="dim" id="tfSum">정한 것 <b>' + n0(done) + '</b> / ' + n0(rows.length) + '건' +
      (sum ? ' · 합계 ' + won(sum) : '') + '</span>' +
      '<button class="btn" id="tfAllFree">남은 것 전부 「없음」</button>' +
      '<button class="btn' + (done ? ' pri' : '') + '" id="tfSave"' +
      (done ? '' : ' disabled') + '>' + n0(done) + '건 저장</button></div></section>';

    h += '<div class="panel"><div class="scroll tall" data-rows><table><thead><tr>' +
      '<th>구간</th><th>방문처</th><th class="n">건수</th><th>날짜</th><th class="n">통행료</th>' +
      '</tr></thead><tbody>' +
      order.map(function (k, i) {
        var x = g[k], v = FILLS[k];
        var days = x.rows.slice(0, 5).map(function (t) { return md(t.start_time); }).join(', ') +
          (x.rows.length > 5 ? ' 외 ' + (x.rows.length - 5) + '일' : '');
        // 묶음 안의 방문처를 모은다. 같은 구간이라도 간 곳이 여럿일 수 있다.
        var pl = [];
        x.rows.forEach(function (t) {
          var v = (t.visit_place || '').trim();
          if (v && pl.indexOf(v) < 0) pl.push(v);
        });
        var place = pl.length ? pl.slice(0, 3).join(', ') + (pl.length > 3 ? ' 외 ' + (pl.length - 3) : '') : '—';
        return '<tr' + (v != null ? ' class="tfdone"' : '') + '>' +
          '<td><span class="lead">' + esc(k) + '</span></td>' +
          '<td class="el' + (pl.length ? '' : ' dim') + '" title="' + esc(pl.join(', ')) + '">' +
          esc(place) + '</td>' +
          '<td class="n lead">' + n0(x.rows.length) + '</td>' +
          '<td class="dim">' + esc(days) + '</td>' +
          '<td class="n" style="white-space:nowrap">' +
          '<button class="btn sm" data-tffree="' + i + '" aria-label="' + esc(k) + ' 통행료 없음">없음</button> ' +
          '<input class="inp num" data-tfamt="' + i + '" inputmode="numeric" style="width:92px" ' +
          'placeholder="원" aria-label="' + esc(k) + ' 통행료 금액" value="' +
          // 정한 줄은 0원도 숫자로 보여 준다 — 어디까지 했는지 눈에 보이게.
          (v == null ? '' : n0(v)) + '">' +
          (x.hint ? ' <button class="btn sm" data-tfhint="' + i + '" ' +
            'title="전에 정하신 금액 — 눌러서 그대로 씁니다">지난번 ' +
            n0(x.hint) + '원</button>' : '') +
          '</td></tr>';
      }).join('') + '</tbody></table></div></div>';

    // 지금 화면의 묶음을 이벤트에서 쓰려고 담아 둔다.
    TF_GROUPS = order.map(function (k) { return g[k]; });
    return h;
  }
  var TF_GROUPS = [];

  /** 한 줄만 제자리에서 고쳐 그린다 — 스크롤과 포커스를 지키려고. */
  function tfPaintRow(i) {
    var g = TF_GROUPS[i]; if (!g) return;
    var v = FILLS[g.key];
    var input = document.querySelector('[data-tfamt="' + i + '"]');
    // 정한 줄은 0원도 숫자로 보여 준다 — 어디까지 했는지 눈에 보이게.
    if (input) input.value = (v == null) ? '' : n0(v);
    var tr = input && input.closest('tr');
    if (tr) tr.className = (v == null) ? '' : 'tfdone';
  }

  /** 요약 줄과 저장 버튼만 고쳐 쓴다. */
  function tfPaintSum() {
    var done = 0, sum = 0, tot = 0;
    TF_GROUPS.forEach(function (x) {
      tot += x.rows.length;
      if (FILLS[x.key] == null) return;
      done += x.rows.length; sum += FILLS[x.key] * x.rows.length;
    });
    var lab = $('tfSum');
    if (lab) lab.innerHTML = '정한 것 <b>' + n0(done) + '</b> / ' + n0(tot) + '건' +
      (sum ? ' · 합계 ' + won(sum) : '');
    var sb = $('tfSave');
    if (sb) {
      sb.disabled = !done;
      sb.textContent = n0(done) + '건 저장';
      // 못 누르는 버튼이 주 버튼처럼 보이면 안 눌린 게 고장으로 읽힌다.
      sb.className = 'btn' + (done ? ' pri' : '');
    }
  }

  /** 묶음의 금액칸을 읽어 FILLS 에 반영한다(입력 도중에도 호출된다). */
  function tfRead() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tfamt]'), function (el) {
      var i = +el.dataset.tfamt, k = TF_GROUPS[i] && TF_GROUPS[i].key;
      if (!k) return;
      var s = String(el.value || '').replace(/[^\d]/g, '');
      // 0원도 칸에 '0' 으로 적히므로, 빈 칸은 이제 '아직 안 정함' 이 맞다.
      // (예전에는 0을 빈 칸으로 그려서, 지우면 0이 되살아나 되돌릴 수가 없었다.)
      if (s === '') { delete FILLS[k]; return; }
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
      '<button class="btn pri" id="btnAllFreeGo">' + n0(left) + '건 없음으로 표시</button>';
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
    apiRetry('/functions/v1/toll-apply', {
      method: 'POST',
      body: JSON.stringify({ mode: 'manual', batch: '웹 통행료 채우기 ' + CYCKEY(), items: items })
    }).then(function (r) { return r.json().then(function (x) { return { ok: r.ok, j: x }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = n0(n) + '건 저장';
        if (!res.ok || !res.j || !res.j.ok) {
          toast((res.j && res.j.error) || '저장하지 못했습니다.', true); return;
        }
        var skipped = res.j.skipped || [];
        // ★ applied 가 0 이면 한 건도 안 써진 것이다. 예전에는 '0 || items.length' 라
        //   47건 저장했다고 띄우고 FILLS 까지 비워, 거짓말에 더해 친 값도 날렸다.
        var applied = Number(res.j.applied) || 0;
        if (!applied) {
          toast(skipped.length
            ? '한 건도 저장되지 않았습니다 — ' + skipped[0].why
            : '한 건도 저장되지 않았습니다.', true);
          return;                        // 친 값은 그대로 둔다
        }
        // 건너뛴 운행이 있는 구간의 값은 남긴다 — 부분 성공 뒤 다시 저장할 수 있게.
        var skipIds = {};
        skipped.forEach(function (x) { skipIds[x.id] = 1; });
        TF_GROUPS.forEach(function (x) {
          if (FILLS[x.key] == null) return;
          if (!x.rows.some(function (t) { return skipIds[t.id]; })) delete FILLS[x.key];
        });
        AUDIT = null;
        loadAll();                       // 서버 값을 다시 받아 화면을 맞춘다
        toastOk(n0(applied) + '건 저장했습니다.',
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

    h += sect('결재 서명', null, '', signPanel());

    h += sect('비밀번호 바꾸기', null, '',
      '<div class="panel" style="padding:20px"><div class="form">' +
      frow('현재 비밀번호', '<input class="inp pw" type="password" id="pwCur" autocomplete="current-password">') +
      frow('새 비밀번호', '<input class="inp pw" type="password" id="pwNew" autocomplete="new-password">',
        '4자 이상. <b>앱과 웹이 같은 비밀번호</b>를 씁니다 — 바꾸면 앱에서도 새 것으로 들어가셔야 합니다.') +
      frow('새 비밀번호 확인', '<input class="inp pw" type="password" id="pwNew2" autocomplete="new-password">') +
      '</div><div style="margin-top:14px;text-align:right">' +
      '<button class="btn pri" id="btnPwSave">비밀번호 바꾸기</button></div></div>');
    return h;

    function kv(k, v) { return '<tr><th>' + k + '</th><td>' + v + '</td></tr>'; }
    function frow(label, body, hint) {
      var m = /id="([^"]+)"/.exec(body);     // 라벨을 칸에 잇는다 — 보조기기가 어느 칸인지 읽는다
      return '<div class="frow"><label class="flab"' + (m ? ' for="' + m[1] + '"' : '') + '>' + label +
        '</label><div class="fbody">' + body +
        (hint ? '<div class="fhint">' + hint + '</div>' : '') + '</div></div>';
    }
  }

  /** 「내 계정」의 결재 서명 칸. 지금 서명(또는 기본 도장)을 보이고, 파일을 올리거나 기본 도장으로 되돌린다. */
  function signPanel() {
    if (MYSIGN === undefined) { loadMySign().then(render); }
    var nm = personOf(myName()).name || myName();
    var cur = MYSIGN && MYSIGN.image ? MYSIGN.image : stampPng(nm);
    var shown = SIGN_DRAFT || cur;
    return '<div class="panel" style="padding:20px"><div class="signrow">' +
      '<div class="signbox"><img id="signPreview" alt="결재 서명" src="' + shown + '"></div>' +
      '<div class="signtx">' +
      (SIGN_DRAFT
        ? '<b>이 서명으로 저장할까요?</b><div class="fhint">흰 배경은 투명하게 바꾸고 여백은 잘라 냈습니다.</div>' +
          '<div class="signbtn"><button class="btn pri" id="btnSignSave">이 서명으로 저장</button> ' +
          '<button class="btn" id="btnSignCancel">취소</button></div>'
        : '<b>' + (MYSIGN && MYSIGN.image ? '올린 서명을 쓰고 있습니다' : '기본 도장(이름)을 쓰고 있습니다') + '</b>' +
          '<div class="fhint">상신·승인하면 결재란에 이 그림과 날짜가 찍힙니다. 서명·도장 파일(JPG·PNG·PDF)을 올리면 그것으로 바뀝니다. ' +
          '바꿔도 <b>이미 결재된 문서는 그대로</b>입니다.</div>' +
          '<div class="signbtn"><label class="btn" for="signFile">' + ic('stamp') + '서명·도장 파일 올리기</label>' +
          '<input type="file" id="signFile" accept="image/png,image/jpeg,application/pdf,.pdf" hidden> ' +
          (MYSIGN && MYSIGN.image ? '<button class="btn" id="btnSignReset">기본 도장으로 되돌리기</button>' : '') +
          '</div>') +
      '</div></div></div>';
  }
  /** 고른 파일(JPG·PNG·PDF 첫 쪽) → 흰 배경을 투명하게, 여백을 잘라, 최대 360×180 PNG. */
  function fileToSign(file) {
    var isPdf = /pdf$/i.test(file.type || '') || /\.pdf$/i.test(file.name || '');
    var src = isPdf
      ? loadPdfJs().then(function (pdfjs) {
          return file.arrayBuffer().then(function (buf) { return pdfjs.getDocument({ data: buf }).promise; })
            .then(function (d) { return d.getPage(1); })
            .then(function (pg) {
              var vp = pg.getViewport({ scale: 2 }), cv = document.createElement('canvas');
              cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
              var g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
              return pg.render({ canvasContext: g, viewport: vp }).promise.then(function () { return cv; });
            });
        })
      : new Promise(function (ok, no) {
          var url = URL.createObjectURL(file), im = new Image();
          im.onload = function () {
            var k = Math.min(1, 2400 / Math.max(im.naturalWidth, im.naturalHeight));
            var cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(im.naturalWidth * k)); cv.height = Math.max(1, Math.round(im.naturalHeight * k));
            var g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
            g.drawImage(im, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); ok(cv);
          };
          im.onerror = function () { URL.revokeObjectURL(url); no(new Error('그림 파일을 읽지 못했습니다')); };
          im.src = url;
        });
    return src.then(function (cv) {
      var W = cv.width, H = cv.height, g = cv.getContext('2d'), img = g.getImageData(0, 0, W, H), d = img.data;
      var x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4, lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (d[i + 3] < 20 || lum > 215) { d[i + 3] = 0; continue; }
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 < 0) throw new Error('파일에서 서명을 찾지 못했습니다(흰 바탕만 있습니다)');
      g.putImageData(img, 0, 0);
      var pad = 4, cw = x1 - x0 + 1 + pad * 2, ch = y1 - y0 + 1 + pad * 2;
      var k = Math.min(1, 360 / cw, 180 / ch);
      var out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(cw * k)); out.height = Math.max(1, Math.round(ch * k));
      out.getContext('2d').drawImage(cv, x0 - pad, y0 - pad, cw, ch, 0, 0, out.width, out.height);
      var png = out.toDataURL('image/png');
      if (png.length > 390000) throw new Error('서명 그림이 너무 복잡합니다. 서명만 잘라서 올려 주세요');
      return png;
    });
  }
  function saveSign(image) {
    var b = $('btnSignSave') || $('btnSignReset'); if (b) b.disabled = true;
    return apiRetry('/rest/v1/driving_signatures', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ username: myName(), image: image })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (rows) {
      if (!rows || !rows[0]) { if (b) b.disabled = false; toast('서명을 저장하지 못했습니다. 잠시 뒤에 다시 해 주세요.', true); return; }
      MYSIGN = rows[0]; SIGNS[MYSIGN.id] = MYSIGN.image || ''; SIGN_DRAFT = null;
      toast(image ? '서명을 저장했습니다. 이제부터 상신·승인하는 문서에 찍힙니다.' : '기본 도장으로 되돌렸습니다.');
      render();
    }).catch(function () { if (b) b.disabled = false; toast('서명을 저장하지 못했습니다.', true); });
  }

  function savePassword() {
    var cur = ($('pwCur') || {}).value || '';
    var a = ($('pwNew') || {}).value || '', b2 = ($('pwNew2') || {}).value || '';
    if (!cur) { toast('현재 비밀번호를 넣어 주세요.', true); return; }
    if (a.length < 4) { toast('새 비밀번호는 4자 이상이어야 합니다.', true); return; }
    if (a !== b2) { toast('새 비밀번호 확인이 다릅니다.', true); return; }
    if (a === cur) { toast('지금 쓰시는 것과 다른 비밀번호를 넣어 주세요.', true); return; }
    var btn = $('btnPwSave'); btn.disabled = true; btn.textContent = '바꾸는 중…';
    apiRetry('/functions/v1/driving-account', {
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
  /* ── 업무 결재 포털(work.html) 가입 신청 — 승인·거절 (2026-10-02, 10-06 보강) ──
     승인하면 그 아이디로 포털·운행일지 웹·앱에 로그인할 수 있다. 승인·거절 모두 본인 비밀번호를 다시 묻는다.
     ★ 조직도에는 자동으로 잇지 않는다 — 신청서의 회사 메일은 본인 확인이 안 된 값이라, 남의 메일로 가입해
       결재자 자리를 가로챌 수 있었다(2026-10-06 검증로봇). 결재자로 쓰려면 관리자가 「조직도」에서 직접 잇는다. */
  var SIGNUPS = null, SIGNUP_BUSY = '';
  function loadSignups() {
    return apiRetry('/functions/v1/driving-account', { method: 'POST', body: JSON.stringify({ action: 'signups' }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) { SIGNUPS = res.ok && res.j && res.j.list ? res.j.list : []; if (VIEW === 'perm') render(); })
      .catch(function () { SIGNUPS = []; });
  }
  function signupSect() {
    if (SIGNUPS === null) { loadSignups(); return ''; }
    if (!SIGNUPS.length) return '';
    return sect('가입 신청', SIGNUPS.length + '건', '',
      '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>이름</th><th>아이디</th><th>부서 · 직급</th><th>회사 메일</th><th>운행일지</th><th>신청</th><th></th></tr></thead><tbody>' +
      SIGNUPS.map(function (x) {
        var busy = SIGNUP_BUSY === x.username;
        return '<tr><td><span class="lead">' + esc(x.name || '') + '</span></td>' +
          '<td class="mono">' + esc(x.username) + '</td>' +
          '<td class="dim">' + esc([x.dept, x.position].filter(Boolean).join(' · ') || '—') + '</td>' +
          '<td class="dim">' + esc(x.email || '—') + '</td>' +
          '<td class="dim">' + (x.uses_driving === false ? '안 씀(결재만)' : '씀') + '</td>' +
          '<td class="dim">' + (x.signup_at ? md(Date.parse(x.signup_at)) : '—') + '</td>' +
          '<td class="n" style="white-space:nowrap">' +
          '<button class="btn sm pri" data-signup="' + esc(x.username) + '" data-ok="1"' + (busy ? ' disabled' : '') + '>승인</button> ' +
          '<button class="btn sm" data-signup="' + esc(x.username) + '" data-ok="0"' + (busy ? ' disabled' : '') + '>거절</button></td></tr>';
      }).join('') + '</tbody></table></div></div>' +
      '<div class="anote">업무 결재 포털에서 들어온 신청입니다. 승인하면 그 아이디로 포털·운행일지 웹·앱에 로그인할 수 있습니다. ' +
      '적힌 회사 메일은 <b>본인 확인이 안 된 값</b>입니다. 승인할 때 <b>조직도의 누구인지</b> 고르면 바로 결재자로 고를 수 있게 됩니다.</div>');
  }
  /** 가입 승인 때 이을 조직도 후보 — 아직 계정이 안 이어진 사람. 이름이 같은 사람을 맨 앞에. */
  function signupOrgOptions(x) {
    var free = ORG.filter(function (o) { return !o.username; });
    var nm = String(x.name || '').replace(/\s/g, '');
    var same = free.filter(function (o) { return String(o.name || '').replace(/\s/g, '') === nm; });
    var rest = free.filter(function (o) { return same.indexOf(o) < 0; })
      .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ko'); });
    // 동명이인을 가릴 수 있게 본부부터 적는다(2026-10-07 검증로봇 R9 — 본부 직속 줄은 이름만 보였다).
    var lab = function (o) { return o.name + ' · ' + [o.division, o.team, o.unit].filter(Boolean).join(' › ') + (o.role ? ' · ' + o.role : o.rank ? ' · ' + o.rank : ''); };
    var opt = function (o) { return '<option value="' + o.id + '">' + esc(lab(o)) + '</option>'; };
    // ★ 미리 고르지 않는다(검증로봇 R6·2차) — 이름은 물론 회사 메일(아이디@atecmobility.com)도 추측하기 쉬워,
    //   아직 가입 안 한 결재자로 꾸민 신청을 관리자가 그대로 승인하면 그 결재자 자리를 넘겨줄 수 있었다.
    //   이름이 같은 사람은 맨 위에 보여 주기만 하고, 본인 확인 뒤 관리자가 직접 고른다.
    return {
      def: '',
      html: '<option value="">잇지 않음 — 나중에 「조직도」에서 잇기</option>' +
        '<option value="new">조직도에 새로 추가</option>' +
        (same.length ? '<optgroup label="이름이 같은 사람">' + same.map(opt).join('') + '</optgroup>' : '') +
        (rest.length ? '<optgroup label="계정이 안 이어진 조직도 사람">' + rest.map(opt).join('') + '</optgroup>' : '')
    };
  }
  /** 승인·거절 확인 창 — 누구를 어떻게 하는지 보여 주고 본인 비밀번호를 받는다. */
  function openSignupConfirm(u, ok) {
    var x = (SIGNUPS || []).filter(function (r) { return r.username === u; })[0] || { username: u };
    $('pTitle').textContent = ok ? '가입 승인' : '가입 거절';
    $('pSub').textContent = (x.name || '') + ' (' + u + ')';
    var oo = ok ? signupOrgOptions(x) : null;
    $('pBody').innerHTML = '<div class="form"><div class="anote">' + esc(x.name || u) + ' 님의 가입 신청을 <b>' +
      (ok ? '승인' : '거절') + '</b>합니다.' +
      (ok ? ' 승인하면 이 아이디로 포털·운행일지 웹·앱에 로그인할 수 있습니다.' +
          (x.uses_driving === false ? ' <b>운행일지를 안 쓰는 분</b>이라 운행일지에서는 결재함만 보입니다.' : '')
        : ' 거절하면 이 아이디로는 로그인할 수 없고, 적어 낸 차량번호는 비웁니다.') + '</div>' +
      // ★ 결재자로 고를 수 있게 하려면 조직도에 이어야 한다(결재자 = 조직도에 있고 계정이 이어진 사람, 2026-10-02 결정).
      //   관리자가 본인 확인 뒤 직접 고른다 — 이름만 같다고 자동으로 잇지 않는다(가로채기 방지, 10/6 검증로봇).
      (ok ? '<div class="frow"><label class="flab" for="suOrg">조직도</label><div class="fbody">' +
        '<select class="inp" id="suOrg">' + oo.html + '</select>' +
        '<div class="fhint">이으면 <b>결재자로 고를 수 있게</b> 됩니다. 본인이 맞는지 확인하고 고르세요.</div>' +
        '<div id="suOrgNew" class="form" style="margin-top:10px" hidden>' +
        '<div class="frow"><label class="flab" for="suDiv">본부</label><div class="fbody"><input class="inp" id="suDiv" maxlength="60" placeholder="예) 버스사업본부"></div></div>' +
        '<div class="frow"><label class="flab" for="suTeam">팀</label><div class="fbody"><input class="inp" id="suTeam" maxlength="60" value="' + esc(x.dept || '') + '"></div></div>' +
        '<div class="frow"><label class="flab" for="suRole">직책</label><div class="fbody"><input class="inp" id="suRole" maxlength="30" placeholder="예) 팀장 · 센터장 (결재란에 찍힘)"></div></div>' +
        '<div class="frow"><label class="flab" for="suRank">직급</label><div class="fbody"><input class="inp" id="suRank" maxlength="30" value="' + esc(x.position || '') + '"></div></div>' +
        // 팀즈 결재 알림이 이 주소로 간다 — 신청서의 메일은 본인 확인이 안 된 값이라 관리자가 보고 확정한다(R9).
        '<div class="frow"><label class="flab" for="suOMail">알림 메일</label><div class="fbody"><input class="inp" id="suOMail" maxlength="80" value="' + esc(x.email || '') + '" placeholder="아이디@atecmobility.com">' +
        '<div class="fhint">팀즈 결재 알림이 이 주소로 갑니다. <b>본인 회사 메일이 맞는지</b> 확인하세요. 모르면 비워 두세요.</div></div></div>' +
        '</div></div></div>' : '') +
      '<div class="frow"><label class="flab" for="suMine">본인 비밀번호</label><div class="fbody">' +
      '<input class="inp" type="password" id="suMine" autocomplete="current-password">' +
      '<div class="fhint">지금 로그인한 <b>' + esc(myName()) + '</b> 계정의 비밀번호입니다.</div></div></div></div>';
    $('pFoot').innerHTML = '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnSignupGo" data-u="' + esc(u) + '" data-ok="' + (ok ? '1' : '0') + '">' + (ok ? '승인' : '거절') + '</button>';
    $('panel').classList.add('open');
    if (ok) {
      var sel = $('suOrg');
      var showNew = function () { $('suOrgNew').hidden = sel.value !== 'new'; };
      sel.value = oo.def; showNew();
      sel.addEventListener('change', showNew);
    }
    var f = $('suMine'); if (f) f.focus();
  }
  function decideSignup(u, ok) {
    var mine = ($('suMine') || {}).value || '';
    if (!mine) { toast('본인 비밀번호를 넣어 주세요.', true); return; }
    // 조직도 잇기(승인일 때만) — 승인 뒤에 쓴다. 새로 추가면 본부는 꼭 받는다(조직도 칸 규칙).
    var x = (SIGNUPS || []).filter(function (r) { return r.username === u; })[0] || { username: u };
    var orgPick = ok && $('suOrg') ? $('suOrg').value : '';
    var newOrg = null;
    if (orgPick === 'new') {
      var tv = function (id) { return (($(id) || {}).value || '').trim(); };
      newOrg = { division: tv('suDiv'), team: tv('suTeam'), role: tv('suRole'), rank: tv('suRank'), email: tv('suOMail').toLowerCase() };
      if (newOrg.email && !/^[a-z0-9._-]+@atecmobility\.com$/.test(newOrg.email)) { toast('알림 메일은 @atecmobility.com 주소만 됩니다. 모르면 비워 두세요.', true); $('suOMail').focus(); return; }
      if (!newOrg.division) { toast('조직도에 새로 넣으려면 본부를 넣어 주세요.', true); $('suDiv').focus(); return; }
    }
    var go = $('btnSignupGo'); if (go) go.disabled = true;
    SIGNUP_BUSY = u;
    apiRetry('/functions/v1/driving-account', { method: 'POST', body: JSON.stringify({ action: 'decide_signup', target: u, ok: ok, password: mine }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        SIGNUP_BUSY = '';
        if (go) go.disabled = false;
        if (!res.ok || !res.j || !res.j.ok) { toast((res.j && res.j.error) || '처리하지 못했습니다.', true); return; }
        var done = res.j.message || '처리했습니다.';
        closePanel();
        SIGNUPS = null;
        if (!ok) { toast(done); render(); return; }
        return linkSignupOrg(u, x, orgPick, newOrg).then(function (msg) {
          if (msg) toast(done + ' ' + msg, /못했/.test(msg)); else toast(done);
          loadAll();                     // 승인한 사람이 직원 목록·조직도·결재자 후보에 바로 보이게
        });
      }).catch(function () { SIGNUP_BUSY = ''; if (go) go.disabled = false; toast('처리하지 못했습니다.', true); });
  }
  /** 승인한 계정을 조직도에 잇는다 — 이미 계정이 이어진 줄은 건드리지 않는다(username=is.null 조건). */
  function linkSignupOrg(u, x, pick, newOrg) {
    if (!pick) return Promise.resolve('');
    // 이미 조직도 어딘가에 이어진 계정이면 또 잇지 않는다(한 사람이 두 줄 — R9).
    if (ORG.some(function (o) { return o.username === u; })) return Promise.resolve('이 계정은 이미 조직도에 이어져 있어 그대로 두었습니다.');
    var now = new Date().toISOString();
    var req;
    if (pick === 'new') {
      var same = ORG.filter(function (o) { return o.division === newOrg.division && (o.team || '') === newOrg.team && !o.unit; });
      req = apiRetry('/rest/v1/driving_org', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ name: x.name || u, division: newOrg.division, team: newOrg.team, unit: '',
          rank: newOrg.rank, role: newOrg.role, duty: '', username: u,
          // 팀즈 결재 알림은 회사 메일로만 간다 — 다른 도메인이면 비워 둔다
          email: newOrg.email || null,             // 관리자가 승인 창에서 확인한 주소만
          sort: same.reduce(function (m, o) { return Math.max(m, o.sort || 0); }, 0) + 1,
          updated_by: myName(), updated_at: now })
      });
    } else {
      req = apiRetry('/rest/v1/driving_org?id=eq.' + encodeURIComponent(pick) + '&username=is.null', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ username: u, updated_by: myName(), updated_at: now })
      });
    }
    return req.then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        return rows && rows.length ? '조직도에 이었습니다 — 이제 결재자로 고를 수 있습니다.'
          : pick === 'new'
            ? '조직도에 새로 넣지 못했습니다. 「조직도」에서 직접 추가해 주세요.'
            : '조직도에는 잇지 못했습니다(이미 다른 계정이 이어졌을 수 있습니다). 「조직도」에서 직접 이어 주세요.';
      }).catch(function () { return '조직도에는 잇지 못했습니다. 「조직도」에서 직접 이어 주세요.'; });
  }
  function viewPerm() {
    if (!LOADED) return head('권한 관리') + skeleton();
    var list = Object.keys(USERS).sort(function (a, b) {
      var x = USERS[a], y = USERS[b];
      return (y.is_admin ? 1 : 0) - (x.is_admin ? 1 : 0) ||
        nameOf(a).localeCompare(nameOf(b), 'ko');
    });
    var admins = list.filter(function (u) { return USERS[u].is_admin; }).length;
    var MGRS = ACCT.managers || [], master = !!ACCT.is_master;
    var h = head('권한 관리', list.length + '명 · 관리자 ' + admins + '명 · 권한 주는 관리자 ' + MGRS.length + '명');
    h += '<section class="sect"><div class="panel" style="padding:16px 20px;font-size:12.5px;' +
      'line-height:1.9;color:var(--ink-3)">' +
      '<b style="color:var(--ink-2)">운행일지 관리자</b>는 전 직원의 운행·정산·증빙을 보고, ' +
      '계기판을 고칠 수 있습니다.<br>' +
      '바꿀 때마다 <b>본인 비밀번호</b>를 한 번 더 확인합니다 — 자리를 비운 사이 남이 ' +
      '권한을 주는 일을 막기 위해서입니다.<br>' +
      '<b style="color:var(--ink-2)">권한 주는 관리자</b>는 마스터 계정이 지정합니다. 이 화면에서 다른 직원을 관리자로 ' +
      '지정·해제하고 비밀번호를 초기화할 수 있습니다(마스터 계정과 다른 권한 주는 관리자는 바꿀 수 없습니다).</div></section>';
    h += signupSect();
    h += sect('직원', list.length + '명', '',
      '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>이름</th><th>아이디</th><th>소속</th><th>권한</th><th></th></tr></thead><tbody>' +
      list.map(function (u) {
        var x = USERS[u];
        return '<tr>' +
          '<td><span class="lead">' + esc(x.name || u) + '</span></td>' +
          '<td class="dim">' + esc(u) + '</td>' +
          '<td class="dim">' + esc(x.dept || '—') + '</td>' +
          '<td>' + (u === ACCT.master ? '<span class="st bad">마스터</span>'
            : MGRS.indexOf(u) >= 0 ? '<span class="st bad">권한 주는 관리자</span>'
            : x.is_admin ? '<span class="st bad">관리자</span>' : '<span class="dim">일반</span>') + '</td>' +
          '<td class="n" style="white-space:nowrap">' +
          // 본인 · 마스터 · (마스터가 아니면) 다른 권한 주는 관리자는 바꿀 수 없다(서버가 거부한다). 버튼을 아예 안 보인다.
          (u === myName() ? '<span class="dim">본인 계정</span>'
            : u === ACCT.master || (!master && MGRS.indexOf(u) >= 0) ? '<span class="dim">바꿀 수 없음</span>'
            : '<button class="btn sm" data-perm="' + esc(u) + '" data-on="' + (x.is_admin ? '0' : '1') + '">' +
              (x.is_admin ? '관리자 해제' : '관리자 지정') + '</button> ' +
              (master ? '<button class="btn sm" data-permmgr="' + esc(u) + '" data-on="' + (MGRS.indexOf(u) >= 0 ? '0' : '1') + '">' +
                (MGRS.indexOf(u) >= 0 ? '권한 주기 해제' : '권한 주기 허용') + '</button> ' : '') +
              '<button class="btn sm" data-pwreset="' + esc(u) + '">비밀번호 초기화</button>') +
          '</td></tr>';
      }).join('') + '</tbody></table></div></div>');
    return h;
  }

  /** 권한·비밀번호를 바꾸기 전에 본인 비밀번호를 확인받는 창. */
  function openPermConfirm(kind, target, enabled) {
    var nm = nameOf(target);
    $('pTitle').textContent = kind === 'admin' ? (enabled ? '관리자 지정' : '관리자 해제')
      : kind === 'mgr' ? (enabled ? '권한 주기 허용' : '권한 주기 해제') : '비밀번호 초기화';
    $('pSub').textContent = nm + ' (' + target + ')';
    var body = '<div class="form">';
    if (kind === 'pw') {
      body += '<div class="frow"><label class="flab">새 비밀번호</label><div class="fbody">' +
        '<input class="inp" type="text" id="rsNew" autocomplete="off" placeholder="4자 이상">' +
        '<div class="fhint">본인에게 직접 알려 주셔야 합니다. ' +
        '<b>앱과 웹이 같은 비밀번호</b>를 씁니다.</div></div></div>';
    } else if (kind === 'mgr') {
      body += '<div class="anote">' + esc(nm) + ' 님을 <b>' +
        (enabled ? '권한 주는 관리자로 지정' : '권한 주는 관리자에서 해제') + '</b>합니다.' +
        (enabled ? ' 운행일지 관리자도 함께 켜지고, 「권한 관리」에서 다른 직원을 관리자로 지정·해제하고 비밀번호를 초기화할 수 있게 됩니다.'
          : ' 운행일지 관리자 권한은 그대로 남습니다.') + '</div>';
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
    var payload = { action: kind === 'admin' ? 'set_admin' : kind === 'mgr' ? 'set_manager' : 'reset_password', target: target, password: mine };
    if (kind === 'admin' || kind === 'mgr') payload.enabled = enabled;
    else {
      var np = ($('rsNew') || {}).value || '';
      if (np.length < 4) { toast('새 비밀번호는 4자 이상이어야 합니다.', true); return; }
      payload.next = np;
    }
    var btn = $('btnPermGo'); btn.disabled = true; btn.textContent = '처리 중…';
    apiRetry('/functions/v1/driving-account', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (x) { return { ok: r.ok, j: x }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = '확인';
        if (!res.ok || !res.j || !res.j.ok) {
          toast((res.j && res.j.error) || '처리하지 못했습니다.', true); return;
        }
        if (kind === 'admin' && USERS[target]) USERS[target].is_admin = enabled;
        if (kind === 'mgr') {
          var ml = (ACCT.managers || []).filter(function (x) { return x !== target; });
          if (enabled) { ml.push(target); if (USERS[target]) USERS[target].is_admin = true; }
          ACCT.managers = ml;
        }
        closePanel(); render();
        toast(res.j.message || '처리했습니다.');
      }).catch(function () {
        btn.disabled = false; btn.textContent = '확인';
        toast('처리하지 못했습니다.', true);
      });
  }

  /* ══════════════════ 결재 ══════════════════
     결재 단위는 사람 × 마감주기. 운행 건별로 결재하지 않는다.
     결재선은 조직도에서 자동으로 채워 주되 잠그지 않는다 — 빼고 더할 수 있다.  */
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
  /**
   * 내가 지난번에 올렸던 결재선 — 「지난번 결재선 불러오기」 버튼이 쓴다.
   * 이번 주기에 반려·회수된 건이 있으면 그것, 없으면 다른 주기에 가장 최근 상신한 것.
   * 계정이 없어진 사람·본인은 뺀다. 없으면 null.
   *
   * ★ 결재선은 **상신자가 직접 이름을 넣어 고른다**(2026-10-02 사용자 결정 —
   *   "이름만 넣어 주면 결재하는 사람이 알아서 지정할 수 있게, 딱 누구다 이렇게 넣지 말고").
   *   부서별 고정 결재선·조직도 자동 결재선으로 미리 채우지 않는다. 상신 창은 빈 칸으로 열린다.
   */
  function previousSteps() {
    var mine = myName(), cur = myAppr();
    var past = (cur && (cur.status === 'rejected' || cur.status === 'withdrawn') && (cur.steps || []).length) ? cur
      : APPR.filter(function (a) {
        return a.username === mine && a.cycle !== CYCKEY() && (a.steps || []).length;
      }).sort(function (a, b) { return (b.submitted_at || '').localeCompare(a.submitted_at || ''); })[0];
    if (!past) return null;
    // 버튼에 적는 것과 실제로 불러오는 것이 같아야 한다 — 지금 규칙(칸마다 한 명 · 한 사람은 한 칸 ·
    // 결재할 수 있는 사람)으로 미리 걸러 둔다. 예전 화면에서 만든 결재선은 칸이 겹치거나 비어 있을 수 있다.
    var seenB = {}, seenU = {};
    var out = past.steps.filter(function (s) {
      if (!s.approver || s.approver === mine || !canApprove(s.approver)) return false;
      if (APPR_BOXES.indexOf(s.box) < 0 || seenB[s.box]) return false;
      seenB[s.box] = 1; return true;
    }).map(function (s) { return { approver: s.approver, box: s.box }; })
      .sort(function (x, y) { return APPR_BOXES.indexOf(x.box) - APPR_BOXES.indexOf(y.box); });
    return out.length ? out : null;
  }
  /**
   * 결재자로 고를 수 있는 사람 — 조직도에 올라 있고(내리지 않음) 앱 계정이 연결된 사람.
   * 앱 계정은 누구나 만들 수 있어, 아무 계정이나 고르게 두면 가짜 계정을 결재자로 넣어 스스로 승인할 수 있다
   * (2026-10-02 검증로봇 · 사용자 결정). 서버(approval-act)도 같은 규칙으로 거부한다.
   * 후보 관리는 관리 › 조직도에서: 사람 추가 · 앱 계정 잇기 · 목록에서 내리기.
   */
  /** 조직도에서 이 계정의 행(결재자 고르기에 소속·직급·직책을 보인다). */
  function orgOf(u) {
    for (var i = 0; i < ORG.length; i++) if (ORG[i].username === u && ORG[i].active !== false) return ORG[i];
    return null;
  }
  function orgLabel(u) {
    var o = orgOf(u), p = personOf(u);
    if (!o) return [p.dept, p.position].filter(Boolean).join(' · ');
    return [[o.team, o.unit].filter(Boolean).join(' ') || o.division, o.rank, o.role].filter(Boolean).join(' · ');
  }
  function canApprove(u) {
    return !!PEOPLE[u] && ORG.some(function (o) { return o.username === u && o.active !== false; });
  }

  /* ══════════════════ 관리 화면 공통 — 소속(사업부 › 팀 › 파트·센터)으로 좁히고 묶기 (2026-10-07) ══════════════════
     조직도(driving_org)가 정본이다. 조직도에 안 이어진 계정은 가입 때 적은 부서(dept)를 조직도의 팀·파트 이름과
     맞춰 본다. 고른 범위(ORGF)는 관리 화면 전부에 같이 걸린다 — 한 번 「광역교통지원팀」을 고르면 운행일지·영수증·
     정산·검증·결재 완료가 모두 그 팀만 보인다. */
  var ORGF = (function () { try { var v = JSON.parse(sessionStorage.getItem('drv.orgf') || '{}'); return { div: v.div || '', team: v.team || '', unit: v.unit || '' }; } catch (e) { return { div: '', team: '', unit: '' }; } })();
  function saveOrgF() { try { sessionStorage.setItem('drv.orgf', JSON.stringify(ORGF)); } catch (e) { } }
  var ORGP = { n: -1, map: {} };
  function orgPath(u) {
    if (ORGP.n !== ORG.length) ORGP = { n: ORG.length, map: {} };
    if (ORGP.map[u]) return ORGP.map[u];
    var o = orgOf(u), p;
    if (o) p = { div: o.division || '', team: o.team || '', unit: o.unit || '' };
    else {
      var d = String(personOf(u).dept || '').trim(), hit = null;
      for (var i = 0; d && i < ORG.length && !hit; i++) {
        var x = ORG[i];
        if (x.unit && x.unit === d) hit = { div: x.division || '', team: x.team || '', unit: x.unit };
        else if (x.team && x.team === d) hit = { div: x.division || '', team: x.team, unit: '' };
        else if (!x.team && x.division === d) hit = { div: x.division, team: '', unit: '' };
      }
      p = hit || { div: '', team: d, unit: '' };
    }
    return (ORGP.map[u] = p);
  }
  function orgFilterOn() { return !!(ORGF.div || ORGF.team || ORGF.unit); }
  function orgMatch(u) {
    if (!orgFilterOn()) return true;
    var p = orgPath(u);
    return (!ORGF.div || (ORGF.div === '-' ? !p.div : p.div === ORGF.div)) && (!ORGF.team || p.team === ORGF.team) && (!ORGF.unit || p.unit === ORGF.unit);
  }
  /** 조직도 순서(사업부·팀이 처음 나오는 줄). 조직도에 없는 소속은 뒤로. */
  function orgRank(p) {
    for (var i = 0; i < ORG.length; i++) if ((ORG[i].division || '') === p.div && (ORG[i].team || '') === p.team) return i;
    for (var j = 0; j < ORG.length; j++) if ((ORG[j].division || '') === p.div) return 5000 + j;
    return 9999;
  }
  function orgName(p) { return p.team || p.div || '소속 미지정'; }
  /** 긴 목록(운행·영수증)의 사람 칸 — 소속을 앞에, 이름을 굵게. */
  function whoCell(u) {
    var p = orgPath(u), o = [orgName(p), p.unit].filter(Boolean).join(' · ');
    return '<td class="whoc"><span class="wo">' + esc(o) + '</span><b>' + esc(nameOf(u)) + '</b></td>';
  }
  /** 표의 첫 칸 — 팀(굵게) 아래 사업부·파트. */
  function orgCell(u, inGroup) {
    // 팀 묶음 안에서는 팀 이름이 묶음 줄에 있으니 파트·센터만 보인다.
    if (inGroup) { var q = orgPath(u); return '<td class="orgc">' + (q.unit ? '<b>' + esc(q.unit) + '</b>' : '<span>팀 직속</span>') + '</td>'; }
    var p = orgPath(u), sub = [p.team ? p.div : '', p.unit].filter(Boolean).join(' · ');
    return '<td class="orgc"><b>' + esc(orgName(p)) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</td>';
  }
  /** items 를 팀(사업부+팀)으로 묶는다. getU(item) = 계정. 묶음 안의 순서는 들어온 순서 그대로. */
  function orgGroups(items, getU, byUnit) {
    var by = {}, out = [];
    items.forEach(function (it) {
      var p = orgPath(getU(it)), k = p.div + '|' + p.team;
      if (!by[k]) { by[k] = { k: k, p: p, rank: orgRank(p), list: [] }; out.push(by[k]); }
      by[k].list.push(it);
    });
    // byUnit: 묶음 안을 파트·센터 이름순으로(같은 파트끼리 붙게). 아니면 들어온 순서(예: 금액 큰 순) 그대로.
    if (byUnit) out.forEach(function (g) {
      g.list = g.list.map(function (it, i) { return { it: it, i: i, k: orgPath(getU(it)).unit || '￿' }; })
        .sort(function (a, b) { return a.k.localeCompare(b.k, 'ko') || a.i - b.i; }).map(function (x) { return x.it; });
    });
    return out.sort(function (a, b) { return a.rank - b.rank || orgName(a.p).localeCompare(orgName(b.p), 'ko'); });
  }
  /** 묶음 제목 줄. right = 오른쪽에 붙일 합계 등. */
  function orgGroupRow(g, cols, right) {
    return '<tr class="ogrp"><td colspan="' + cols + '"><div><b>' + esc(orgName(g.p)) + '</b>' +
      (g.p.team && g.p.div ? '<span class="od">' + esc(g.p.div) + '</span>' : '') +
      '<span class="on">' + n0(g.list.length) + '명</span>' + (right ? '<span class="or">' + right + '</span>' : '') + '</div></td></tr>';
  }
  /** 관리 화면 위 「보는 범위」 줄 — 사업부 › 팀 › 파트·센터. 고를 수 있는 값은 지금 자료에 있는 사람 기준. */
  function orgBarHtml() {
    var r = viewRange(), seen = {};
    ALL_TRIPS.forEach(function (t) { if (t.start_time >= r.lo && t.start_time < r.hi) seen[t.username] = 1; });
    var us = Object.keys(seen);
    var cnt = function (f) { var c = {}; us.forEach(function (u) { var p = orgPath(u); if (f(p)) { var v = f(p); c[v] = (c[v] || 0) + 1; } }); return c; };
    var divs = cnt(function (p) { return p.div || '-'; });
    var inDiv = function (p) { return !ORGF.div || (ORGF.div === '-' ? !p.div : p.div === ORGF.div); };
    var teams = cnt(function (p) { return inDiv(p) ? p.team : ''; });
    var units = cnt(function (p) { return inDiv(p) && (!ORGF.team || p.team === ORGF.team) ? p.unit : ''; });
    var opt = function (obj, cur, all) {
      var ks = Object.keys(obj).sort(function (a, b) { return a.localeCompare(b, 'ko'); });
      return '<option value="">' + all + '</option>' + ks.map(function (k) {
        return '<option value="' + esc(k) + '"' + (cur === k ? ' selected' : '') + '>' + esc(k === '-' ? '소속 미지정' : k) + ' (' + obj[k] + '명)</option>';
      }).join('');
    };
    var shown = us.filter(orgMatch).length;
    return '<div class="orgbar' + (orgFilterOn() ? ' on' : '') + '" role="group" aria-label="보는 범위">' +
      '<span class="obl">' + ic('users', 14) + '보는 범위</span>' +
      '<label class="osel"><span>사업부</span><select id="ofDiv">' + opt(divs, ORGF.div, '전체') + '</select></label>' +
      '<span class="oarr" aria-hidden="true">›</span>' +
      '<label class="osel"><span>팀</span><select id="ofTeam"' + (Object.keys(teams).length ? '' : ' disabled') + '>' + opt(teams, ORGF.team, '전체') + '</select></label>' +
      '<span class="oarr" aria-hidden="true">›</span>' +
      '<label class="osel"><span>파트·센터</span><select id="ofUnit"' + (Object.keys(units).length ? '' : ' disabled') + '>' + opt(units, ORGF.unit, '전체') + '</select></label>' +
      '<span class="ocnt">운행한 사람 <b>' + n0(shown) + '</b>' + (orgFilterOn() ? ' / ' + n0(us.length) : '') + '명</span>' +
      (orgFilterOn() ? '<button class="btn sm" id="ofClear">' + ic('close', 12) + '범위 지우기</button>' : '') +
      '</div>';
  }
  /** 사업부 값 '-' = 사업부가 비어 있는 사람(소속 미지정). */
  function setOrgF(which, v) {
    if (which === 'div') ORGF = { div: v, team: '', unit: '' };
    else if (which === 'team') { ORGF.team = v; ORGF.unit = ''; }
    else ORGF.unit = v;
    saveOrgF();
  }

  function apprStatusText(a) {
    if (!a) return { t: '아직 상신하지 않았습니다', cls: '' };
    if (a.status === 'approved') return { t: '결재 완료', cls: 'ok' };
    if (a.status === 'rejected' && reopenInfo(a)) {
      var ro = reopenInfo(a);
      return { t: '정정 중 — 관리자(' + nameOf(ro.reopened_by) + ')' + (ro.reopen_reason ? ' · ' + ro.reopen_reason : '') + ' — 고친 뒤 다시 상신하세요', cls: 'bad' };
    }
    if (a.status === 'rejected') {
      var r = (a.steps || []).filter(function (s) { return s.result === 'rejected'; })[0];
      // 관리자 권한 반려는 그 칸의 결재자가 한 것이 아니다 — 이름을 바꿔 적는다.
      var who = r && r.forced_by ? '관리자(' + nameOf(r.forced_by) + ')' : ((r && r.name) || '');
      return { t: '반려 — ' + who + (r && r.comment ? ' · ' + r.comment : ''), cls: 'bad' };
    }
    if (a.status === 'withdrawn') return { t: '회수했습니다', cls: '' };
    var cur = (a.steps || []).filter(function (s) { return s.seq === a.cur_seq; })[0];
    if (!cur) return { t: '결재 중', cls: 'warn' };
    // 내 차례면 3인칭으로 부르지 않는다. 눌러야 할 사람에게 눌러야 한다고 말해야 한다.
    if (cur.approver === myName()) return { t: '내 차례입니다', cls: 'bad' };
    return { t: (cur.name || cur.approver) + ' 님 결재 중', cls: 'warn' };
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
    if (isMulti()) { toast('상신은 한 주기씩 합니다. 위 기간에서 주기를 하나 골라 주세요.', true); return; }
    var a = myAppr();
    if (a && (a.status === 'submitted' || a.status === 'approved')) {
      toast(a.status === 'approved' ? '이미 결재가 끝났습니다.' : '이미 상신했습니다.', true); return;
    }
    // 빈 칸으로 연다 — 결재받을 분은 상신자가 이름을 넣어 고른다. 지난번 것은 버튼으로 불러온다.
    // 이 주기에 넣다 만 결재선이 있으면 되살린다 — 창을 닫거나 「검증 결과 보기」로 나갔다 와도 다시 넣지 않게.
    DRAFT = (DRAFT_KEEP[CYCKEY()] || []).slice();
    APPR_Q = '';
    APPR_BOX = DRAFT.length ? nextEmptyBox(APPR_BOXES[0]) : APPR_BOXES[0];           // 「팀장」 칸부터 — 바로 이름을 칠 수 있게
    renderSubmit();
    var box = $('apprQ'); if (box) box.focus();
  }
  /** 결재자 찾기 입력에 지금 쳐 놓은 글자. 창을 다시 그려도 남는다. */
  var APPR_Q = '';

  /** 이름·아이디·부서·직급 어디에든 걸리면 후보로 본다. 이미 넣은 사람과 본인은 뺀다. */
  function apprCandidates() {
    var q = APPR_Q.trim().toLowerCase();
    var used = DRAFT.map(function (s) { return s.approver; }).filter(Boolean);
    var list = Object.keys(PEOPLE).filter(function (u) {
      // 이미 다른 칸에 넣은 분도 다시 고를 수 있다(겸직). 후보에 '이미 ○○ 칸'이라고 적어 준다.
      return u !== myName() && canApprove(u);
    });
    if (q) {
      list = list.filter(function (u) {
        var p = personOf(u);
        var o = orgOf(u) || {};
        return [nameOf(u), u, p.dept || '', p.position || '', o.division || '', o.team || '', o.unit || '', o.rank || '', o.role || '']
          .join(' ').toLowerCase().indexOf(q) >= 0;
      });
    }
    return list.sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b), 'ko'); });
  }

  function apprCandHtml() {
    var all = apprCandidates();
    if (!all.length) {
      return '<div class="acnone">' +
        (APPR_Q.trim() ? '「' + esc(APPR_Q.trim()) + '」 로 찾히는 사람이 없습니다.'
          : '더 넣을 사람이 없습니다.') +
        '<br><span style="font-size:11.5px">결재자는 조직도에 올라 있고 앱 계정이 연결된 분만 찾힙니다. 없으면 관리자에게 조직도 등록을 요청하세요.</span></div>';
    }
    var show = all.slice(0, 8);
    return show.map(function (u, i) {
      var p = personOf(u);
      return '<button class="acand-i' + (i === 0 ? ' top' : '') + '" data-addappr="' + esc(u) + '">' +
        '<b>' + esc(nameOf(u)) + '</b>' +
        '<span>' + esc(orgLabel(u) || u) + '</span>' +
        (function () {
          var at = DRAFT.filter(function (d) { return d.approver === u; }).map(function (d) { return d.box; });
          return at.length ? '<span class="st warn" style="margin-left:6px">이미 ' + esc(at.join('·')) + ' 칸</span>' : '';
        })() +
        (i === 0 && APPR_Q.trim() ? '<span class="acent">Enter</span>' : '') + '</button>';
    }).join('') +
      (all.length > show.length
        ? '<div class="acnone">그 밖에 ' + n0(all.length - show.length) + '명 — 더 쳐서 좁혀 주세요.</div>'
        : '');
  }

  /* ── 결재란 칸 고르기 ──
     상신 창은 운행기록부의 결재란 모양(담당 · 팀장 · 실장 · 사업부장 · 대표이사) 그대로 보여 준다.
     상신자가 칸을 누르고 이름을 넣어 그 칸의 결재자를 고른다. 비워 둔 칸은 빗금(/)으로 찍히고 건너뛴다.
     결재는 왼쪽 칸부터 채워진 칸 차례로 진행된다(DRAFT 는 늘 칸 순서로 정렬해 둔다).
     (2026-10-02 사용자 결정 — "결재란 화면은 그대로 있고 본인이 선택해서 이름 넣는 방식, 건너뛰면 / 처리") */
  var APPR_BOXES = BOXES.slice(1);       // 팀장 · 실장 · 사업부장 · 대표이사 (담당 = 상신자 본인)
  var APPR_BOX = '';                     // 지금 이름을 넣을 칸
  function draftAt(box) { return DRAFT.filter(function (s) { return s.box === box; })[0] || null; }
  /** 칸 순서로 정렬하고, 한 칸에 한 명 · 한 사람은 한 칸만 남긴다. */
  function tidyDraft() {
    var seenBox = {}, seenU = {};
    DRAFT = DRAFT.filter(function (s) {
      // 같은 분을 여러 칸에 넣을 수 있다(2026-10-06) — 한 칸에 한 분만 지킨다.
      if (!s.approver || APPR_BOXES.indexOf(s.box) < 0 || seenBox[s.box]) return false;
      seenBox[s.box] = 1; return true;
    }).sort(function (x, y) { return APPR_BOXES.indexOf(x.box) - APPR_BOXES.indexOf(y.box); });
  }
  /** 다음에 넣을 칸 — 지금 칸 오른쪽의 첫 빈칸, 없으면 왼쪽부터 첫 빈칸, 다 찼으면 ''. */
  function nextEmptyBox(from) {
    var i0 = Math.max(0, APPR_BOXES.indexOf(from));
    var order = APPR_BOXES.slice(i0).concat(APPR_BOXES.slice(0, i0));
    return order.filter(function (b) { return !draftAt(b); })[0] || '';
  }
  function addApprover(u) {
    if (!u || u === myName()) return;
    var box = APPR_BOX || nextEmptyBox(APPR_BOXES[0]);
    if (!box) { toast('칸이 다 찼습니다. 바꿀 칸의 × 를 눌러 비운 뒤 넣어 주세요.', true); return; }
    // 같은 분이 다른 칸에 있어도 그대로 둔다(한 분이 여러 칸을 맡을 수 있다). 이 칸에 있던 분만 바꾼다.
    DRAFT = DRAFT.filter(function (s) { return s.box !== box; });
    DRAFT.push({ approver: u, box: box });
    tidyDraft();
    APPR_Q = '';                       // 다음 사람을 바로 칠 수 있게 비운다
    APPR_BOX = nextEmptyBox(box);
    renderSubmit();
    var q = $('apprQ');
    if (q) q.focus();
  }

  /** 주기별로 넣다 만 결재선(상신 창을 닫아도 남는다, 상신하면 비운다). */
  var DRAFT_KEEP = {};
  function renderSubmit() {
    // 창을 다시 그리면 돌고 있던 '검증 뒤 상신'은 무효다 — 화면의 버튼은 다시 「상신」으로 돌아가 있다.
    SUBMIT.token = null; SUBMIT.send = null;
    tidyDraft();
    DRAFT_KEEP[CYCKEY()] = DRAFT.slice();
    if (APPR_BOX && draftAt(APPR_BOX)) APPR_BOX = '';
    // ★ 관리자는 TRIPS 에 전 직원 운행이 들어 있다. 예전에는 그 합계를 그대로
    //   보여 줘서 "1,842건 · ₩12,400,000" 같은 회사 전체 숫자가 자기 결재 금액인
    //   양 보였다. 서버가 굳히는 snapshot 은 본인 것이므로 화면만 거짓말했다.
    var T = totals(TRIPS.filter(function (t) { return t.username === myName(); }), { who: myName() });

    $('pTitle').textContent = cycleName(CYC.y, CYC.m) + ' 결재 상신';
    $('pSub').textContent = cycleSpan(CYC.y, CYC.m) + ' · ' + n0(T.n) + '건 · ' + won(T.cost);

    // ── 결재란: 운행기록부에 찍히는 모양 그대로 ──
    var me0 = personOf(myName());
    var h = '<div class="agrid" role="group" aria-label="결재란">' +
      '<div class="ag-lab" aria-hidden="true">결<br>재</div>' +
      '<div class="ag-cell me"><div class="ag-h">담당</div><div class="ag-b"><b>' + esc(ME.name || myName()) + '</b>' +
      '<small>' + esc(me0.position || '본인') + '</small></div></div>';
    APPR_BOXES.forEach(function (b) {
      var s = draftAt(b), on = APPR_BOX === b;
      if (s) {
        var u = personOf(s.approver);
        h += '<div class="ag-cell set' + (on ? ' on' : '') + '"><div class="ag-h">' + esc(b) + '</div>' +
          '<div class="ag-b"><b>' + esc(u.name || s.approver) + '</b><small>' + esc(u.position || '') + '</small>' +
          '<button class="ag-x" data-agclr="' + esc(b) + '" aria-label="' + esc(b) + ' 칸 비우기">' + ic('close', 11) + '</button></div></div>';
      } else {
        h += '<button class="ag-cell empty' + (on ? ' on' : '') + '" data-agbox="' + esc(b) + '" aria-pressed="' + (on ? 'true' : 'false') + '" ' +
          'aria-label="' + esc(b) + ' 칸 — 비어 있음(건너뜀). 눌러서 이름 넣기">' +
          '<span class="ag-h">' + esc(b) + '</span><span class="ag-b"><span class="ag-pick">' + (on ? '이름 입력' : '눌러서 넣기') + '</span></span></button>';
      }
    });
    h += '</div>';
    // 결재 순서 — 채워진 칸을 왼쪽부터.
    h += '<div class="ag-order">' + (DRAFT.length
      ? '결재 순서: ' + DRAFT.map(function (s, i) { return (i + 1) + '. ' + esc(nameOf(s.approver)) + '(' + esc(s.box) + ')'; }).join(' → ')
      : '아직 넣은 분이 없습니다. 결재받을 칸을 누르고 이름을 넣어 주세요.') + '</div>';

    // 이름 넣기 — 고른 칸에 들어간다.
    if (APPR_BOX) {
      // ★ 예전에는 61명짜리 <select> 였다. 마감일에 그 목록을 훑어 고르는 것은
      //   할 짓이 아니다. 이름을 두어 글자만 쳐도 좁혀지게 바꿨다.
      //   부서·직급으로도 찾힌다("광역", "팀장").
      h += '<div class="aadd">' +
        '<input id="apprQ" autocomplete="off" aria-label="' + esc(APPR_BOX) + ' 칸에 넣을 분 찾기" placeholder="「' + esc(APPR_BOX) +
        '」 칸에 넣을 분의 이름을 쓰세요" value="' + esc(APPR_Q) + '">' +
        '<div class="acand" id="apprCand">' + apprCandHtml() + '</div></div>';
    }

    var prev = previousSteps();
    if (prev && !DRAFT.length) {
      h += '<div style="margin-top:10px"><button class="btn sm" id="btnPrevLine">' + ic('list', 13) + '지난번 결재선 불러오기 — ' +
        esc(prev.map(function (s) { return nameOf(s.approver) + '(' + s.box + ')'; }).join(' → ')) + '</button></div>';
    }
    h += '<div class="anote" style="margin-top:10px">결재받을 <b>칸을 누르고 이름</b>을 넣으세요. <b>비워 둔 칸은 빗금(/)</b>으로 찍히고 건너뜁니다. ' +
      '결재는 왼쪽 칸부터 차례로 진행됩니다.</div>';

    var warn = [];
    if (T.unk) warn.push('통행료 미확정 ' + n0(T.unk) + '건이 0원으로 올라갑니다');
    // ★ 상신은 **내 운행**을 올리는 것이다. audit() 는 지금 화면 범위(관리자면 전 직원)를 봐서,
    //   '전체 마감 현황 → 내 것 결재 상신' 에서 회사 전체 건수가 경고로 떴다(2026-09-23 검증로봇).
    //   합계를 본인 것으로 고친 것(paintPills)과 같은 규칙.
    var mineU = myName();
    var A = auditOf(ALL_TRIPS.filter(function (t) { return t.username === mineU; }))
      .filter(function (f) { return f.sev === 'bad' && f.n > 0; });
    if (A.length) warn.push('점검에서 ' + A.reduce(function (s, f) { return s + f.n; }, 0) + '건이 걸려 있습니다');
    if (warn.length) {
      h += '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(warn.join(' · ')) + '</span></div>';
    }
    h += '<div class="anote">상신하면 <b>지금 자료가 그대로 저장</b>되고, 결재자는 그 자료를 봅니다. ' +
      '상신 뒤에는 이 주기의 운행·영수증을 <b>고칠 수 없습니다</b> — 고치려면 「회수」하세요. ' +
      '상신을 누르면 먼저 검증을 돌리고, 맞지 않는 곳이 있으면 올리기 전에 한 번 보여 드립니다.</div>';

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
        toastOk((res.j.message || okMsg || '처리했습니다.') +
          (res.j.verify && EXT.sumText ? ' 검증: ' + EXT.sumText(res.j.verify) : ''), res.j.warning);
        closePanel();
        TRIP_CACHE = {};                   // 잠금 상태가 바뀌었다 — 다른 주기 캐시도 믿지 않는다
        // 처리는 이미 끝났다. 뒤이은 목록 재조회가 실패해도 '연결 실패' 로 오인시키지 않는다 —
        // 그러면 사용자가 상신을 다시 눌러 헷갈린다. 전체를 다시 불러오게 한다.
        return fetchAll('/rest/v1/driving_approvals?select=*&order=submitted_at.desc')
          .then(function (rows) { APPR = rows || []; paintPills(); render(); return true; })
          .catch(function (e) {
            if (e && e.authGone) { toast('로그인이 만료되었습니다. 다시 로그인해 주세요.', true); setTimeout(signOut, 900); return true; }
            toast('처리는 됐습니다. 목록을 다시 불러옵니다.'); loadAll(); return true;
          });
      }).catch(function () { toast('서버에 연결하지 못했습니다.', true); return false; });
  }

  /**
   * 승인·반려·회수 확인 창. 결재자는 여기서 금액 요약·검증 결과를 보고, 결재 문서(PDF)를 열어 본 뒤 누른다.
   * 예전에는 카드의 [승인]이 한 번 클릭으로 확정됐고 내역을 볼 길이 없었다.
   */
  function openApprAct(act, id) {
    var a = APPR.filter(function (x) { return x.id === id; })[0];
    if (!a) { toast('결재 건을 찾지 못했습니다. 새로고침해 주세요.', true); return; }
    var s = a.snapshot || {}, cy = String(a.cycle || '').split('-');
    var cname = cy.length === 2 ? cycleName(+cy[0], +cy[1]) : a.cycle;
    var kv = function (k, v) { return '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; };
    var sumHtml = s.trips != null
      ? kv('운행', '<b>' + n0(s.trips) + '건</b> · ' + km(s.km) + ' km (업무 ' + km(s.biz_km) + ' km)') +
        kv('유류비', won(s.fuel)) +
        kv('통행료', won(s.toll) + (s.toll_unknown ? ' <span class="st warn">미확정 ' + n0(s.toll_unknown) + '건은 0원</span>' : '') +
          (s.ev_toll ? ' <span class="dim">영수증 ' + won(s.ev_toll) + ' 포함</span>' : '')) +
        kv('주차비', won(s.parking) + (s.ev_parking ? ' <span class="dim">영수증 ' + won(s.ev_parking) + ' 포함</span>' : '')) +
        kv('합계', '<b style="font-size:15px">' + won(s.cost) + '</b>') +
        ((s.rate_miss || []).length ? kv('주의', '<span class="st bad">유류단가 미등록 — 기본 단가 159원/km 로 계산</span>') : '')
      : '';
    APPR_BACK = null;
    var title = act === 'approve' ? '승인' : act === 'reject' ? '반려' : act === 'force_reject' ? '관리자 반려'
      : act === 'reopen' ? '정정 열기' : '상신 회수';
    var body = '';
    if (act === 'withdraw') {
      body = '<div class="anote" style="margin-top:0">상신을 회수합니다. 결재선은 그대로 남고, <b>이 주기의 운행·영수증을 다시 고칠 수 있게</b> 됩니다. ' +
        '고친 뒤 다시 상신하면 그때의 자료로 새로 고정됩니다.</div>' + apprTrack(a);
    } else {
      body = sumHtml + apprTrack(a) + (EXT.apprExtra ? EXT.apprExtra(a) : '') +
        '<div class="frow" style="border:0;padding-bottom:0"><label class="flab" for="apprWhy">' +
        (act === 'approve' ? '의견' : act === 'reopen' ? '정정 사유' : '반려 사유') + '</label><div class="fbody">' +
        '<textarea class="inp" id="apprWhy" rows="3" maxlength="500" placeholder="' +
        (act === 'approve' ? '선택 — 남기면 상신자가 볼 수 있습니다.' : '무엇을 고쳐야 하는지 적어 주세요. 상신자에게 그대로 전달됩니다.') +
        '"></textarea></div></div>' +
        '<div class="anote">' + (act === 'approve'
          ? '승인하면 결재란에 <b>이름과 날짜</b>가 찍힙니다. 위 금액과 검증 결과는 <b>상신 때 저장된 값</b>입니다. ' +
            '마지막 결재자가 승인하면 결재 완료본을 받을 수 있습니다.'
          : act === 'reopen'
            ? '결재가 끝난 건을 <b>정정하도록 다시 엽니다</b>. 잠금이 풀려 상신자가 고친 뒤 다시 상신하고, 결재선을 처음부터 다시 탑니다. ' +
              '지금의 결재 완료본(결재선·금액·문서)은 <b>이력에 그대로 남습니다</b>. 누가 왜 열었는지도 기록됩니다.'
          : act === 'force_reject'
            ? '결재자가 자리에 없어 결재가 멈췄을 때 쓰는 <b>관리자 권한 반려</b>입니다. 승인을 대신할 수는 없습니다. ' +
              '반려하면 이 주기의 잠금이 풀려 상신자가 고쳐서 다시 올릴 수 있고, 누가 반려했는지 기록에 남습니다.'
            : '반려하면 상신자가 자료를 고쳐 다시 올릴 수 있습니다.') + '</div>';
    }
    openPanel(nameOf(a.username) + ' · ' + title, cname,
      body,
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnApprGo" data-act="' + esc(act) + '" data-id="' + a.id + '">' +
      (act === 'approve' ? '승인' : act === 'withdraw' ? '회수' : act === 'reopen' ? '정정으로 열기' : '반려') + '</button>');
    if (act !== 'approve' && $('apprWhy')) $('apprWhy').focus();
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

    // 예전에는 40건에서 말없이 잘랐다(건수는 전체로 적어 놓고). 이제는 상태로 좁히고, 넘치면 넘친다고 말한다.
    var st = INBOX_F;
    var shown = others.filter(function (a) { return st === 'all' || a.status === st; });
    var CAP = 80;
    // 카드에 붙는 검증 요약·결재 문서 버튼은 고정본에서 온다 — 보이는 건만 한 번에 물어본다.
    if (EXT.wantSummaries) {
      EXT.wantSummaries(mine.concat(shown.slice(0, CAP)).map(function (a) { return a.id; }));
    }

    var h = head('결재함', mine.length ? '내 차례 ' + mine.length + '건' : '내 차례인 건이 없습니다');
    if (mine.length) {
      h += sect('내 차례', mine.length + '건', '', '<div class="panel">' + mine.map(apprCard).join('') + '</div>');
    } else {
      h += blank('결재할 것이 없습니다.', '다른 분 차례이거나 아직 상신되지 않았습니다.', 'check');
    }
    if (others.length) {
      var cnt = function (k) { return others.filter(function (a) { return a.status === k; }).length; };
      var chips = '<div class="seg">' +
        [['all', '전체', others.length], ['submitted', '결재 중', cnt('submitted')], ['approved', '완료', cnt('approved')],
          ['rejected', '반려', cnt('rejected')], ['withdrawn', '회수', cnt('withdrawn')]]
          .filter(function (c) { return c[0] === 'all' || c[2] > 0; })
          .map(function (c) {
            return '<button class="' + (st === c[0] ? 'on' : '') + '" aria-pressed="' + (st === c[0] ? 'true' : 'false') + '" data-inboxf="' + c[0] + '">' + c[1] +
              ' <span class="c">' + n0(c[2]) + '</span></button>';
          }).join('') + '</div>';
      h += sect('그 밖의 건', shown.length + '건', chips,
        '<div class="panel">' + (shown.length ? shown.slice(0, CAP).map(apprCard).join('')
          : '<div class="blank"><div class="t">해당하는 건이 없습니다.</div></div>') + '</div>' +
        (shown.length > CAP ? '<div class="fhint" style="margin-top:8px">최근 ' + CAP + '건만 보입니다. 위에서 상태로 좁혀 보세요(전체 ' +
          n0(shown.length) + '건).</div>' : ''));
    }
    return h;
  }
  /** 결재 완료 건을 정정으로 다시 열 수 있는가 — 운행일지 관리자만(서버 approval-act 'reopen' 도 같은 판정). */
  function canReopen(a) { return !!(ME && ME.is_admin && a && a.status === 'approved'); }
  /** 결재 건 상태 이력에서 '정정 열기'가 있었으면 그 단계(누가·왜). */
  function reopenInfo(a) {
    return (a && (a.steps || []).filter(function (x) { return x.reopened_by; })[0]) || null;
  }
  /** 결재함 '그 밖의 건' 상태 필터. */
  var INBOX_F = 'all';
  function apprCard(a) {
    var st = apprStatusText(a);
    var s = a.snapshot || {};
    var canAct = inbox().indexOf(a) >= 0;
    var canWithdraw = a.username === myName() && a.status === 'submitted' &&
      !(a.steps || []).some(function (x) { return x.result; });
    var cy = String(a.cycle || '').split('-');
    return '<div class="acard">' +
      '<div class="ahd"><b>' + esc(nameOf(a.username)) + '</b>' +
      // 다른 화면과 같은 이름으로 부른다("2026-09분" → "2026년 9월분").
      '<span class="acyc">' + esc(cy.length === 2 ? cycleName(+cy[0], +cy[1]) : a.cycle + '분') + '</span>' +
      '<span class="st ' + st.cls + '">' + esc(st.t) + '</span>' +
      '<span style="flex:1"></span>' +
      (s.trips != null ? '<span class="asum">' + n0(s.trips) + '건 · ' + km(s.km) + ' km · ' + won(s.cost) + '</span>' : '') +
      '</div>' +
      apprTrack(a) +
      // 검증 요약 · 결재 문서(고정본) — drv-verify.js 가 채운다.
      (EXT.apprExtra ? EXT.apprExtra(a) : '') +
      (canAct || canWithdraw || canReopen(a)
        ? '<div class="aact">' +
          (canReopen(a) ? '<button class="btn sm" data-appr="reopen" data-id="' + a.id + '">정정 열기</button>' : '') +
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
  /** 끌어다 놓기 연결. 화면·패널을 다시 그릴 때마다 새로 붙인다. */
  function bindDrop(dz, onFiles) {
    if (!dz || dz.__bound) return;
    dz.__bound = 1;
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e2) { e2.preventDefault(); dz.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e2) { e2.preventDefault(); dz.classList.remove('over'); });
    });
    dz.addEventListener('drop', function (e2) {
      onFiles(e2.dataTransfer && e2.dataTransfer.files);
    });
  }

  function renderKeepFocus(id) {
    render();
    var el = $(id);
    if (el) el.focus();
  }
  /**
   * 좁히기 줄은 그대로 두고 그 아래(#belowF: 칩·표)와 제목만 다시 그린다.
   * 날짜 칸을 치는 동안 입력 칸이 사라지면 안 되기 때문이다. #belowF 가 없는 화면이면 통째로 그린다.
   */
  function paintBelow() {
    var live = $('belowF');
    if (!live) { render(); return; }
    var tmp = document.createElement('div');
    tmp.innerHTML = (VIEWS[VIEW] || viewClose)();
    var fresh = tmp.querySelector('#belowF');
    if (!fresh) { render(); return; }
    live.innerHTML = fresh.innerHTML;
    var h1 = $('inner').querySelector('.phead'), h2 = tmp.querySelector('.phead');
    if (h1 && h2) h1.innerHTML = h2.innerHTML;
    // #belowF 밖에 있지만 조건에 따라 바뀌는 조각(건수 등)은 data-live 이름으로 짝지어 고쳐 쓴다.
    Array.prototype.forEach.call(tmp.querySelectorAll('[data-live]'), function (n2) {
      var n1 = $('inner').querySelector('[data-live="' + n2.getAttribute('data-live') + '"]');
      if (n1) n1.innerHTML = n2.innerHTML;
    });
    // 날짜 줄: 입력 칸은 건드리지 않고 테두리 표시·빠른 칩·지우기 버튼만 맞춘다.
    var d1 = $('inner').querySelector('.dfil'), d2 = tmp.querySelector('.dfil');
    if (d1 && d2) {
      d1.className = d2.className;
      Array.prototype.forEach.call(d1.querySelectorAll('.qd'), function (n) { n.remove(); });
      Array.prototype.forEach.call(d2.querySelectorAll('.qd'), function (n) { d1.appendChild(n); });
    }
    afterPaint();
  }
  /** 화면을 그린 뒤 늘 하는 일(전체·부분 그리기 공통). */
  function afterPaint() {
    var cf = $('btnClearFilt');
    if (cf) cf.addEventListener('click', function () { clearFilters(); render(); });
    // 행이 많은 표만 자체 스크롤 + 머리글 고정. 짧은 표까지 가두면 답답하다.
    Array.prototype.forEach.call($('inner').querySelectorAll('.scroll[data-rows]'), function (w) {
      var n = w.querySelectorAll('tbody tr').length;
      w.classList.toggle('tall', n > 22);
    });
  }
  /** 하이패스 대조 — 고른 건수·합계와 확정 버튼만 제자리에서 고쳐 쓴다. */
  function paintHpCount() {
    HP.groups.forEach(function (g, gi) {
      var picked = (g.matched || []).filter(function (m) { return m.pick; });
      // ★ 금액은 m.sum 이다. 예전에는 m.amount 를 더해서(그런 필드가 없다)
      //   체크를 아무리 해도 합계가 늘 ₩0 으로 보였다.
      var sum = picked.reduce(function (a, m) { return a + (Number(m.sum) || 0); }, 0);
      var todo = (g.matched || []).filter(function (m) { return !hpDone(m); });
      var lab = $('hpSum' + gi);
      if (lab) lab.innerHTML = '남은 것 <b>' + n0(todo.length) + '건</b> · ' +
        '선택 <b>' + n0(picked.length) + '건</b> · 합계 ' + won(sum);
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
  /** 결재가 끝나 못 고치는 화면에 쓰는 안내. 할 수 없는 일을 시키지 않으려고 둔다. */
  function lockedNote(title, body) {
    return '<div class="panel" style="padding:30px 26px;text-align:center">' +
      '<div style="color:var(--ok);margin-bottom:10px">' + ic('check', 22) + '</div>' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:8px">' + esc(title) + '</div>' +
      '<div class="dim" style="font-size:13px;line-height:1.8;max-width:430px;margin:0 auto">' +
      body + '</div>' +
      '<div style="margin-top:16px"><button class="btn sm" data-v="close">「이번 달 마감」에서 결재 문서 받기 ' +
      ic('chev', 13) + '</button></div></div>';
  }

  /** 지금 보고 있는 마감주기가 그 사람 기준으로 결재 완료됐는가. */
  function cycleApproved(u) {
    return APPR.some(function (a) {
      return a.username === u && a.cycle === CYCKEY() && a.status === 'approved';
    });
  }
  /**
   * 지금 보고 있는 마감주기를 그 사람이 고칠 수 없는가 — 결재 중이거나 끝났으면 잠긴다.
   * 서버(driving_cycle_locked)와 같은 기준이다. 2026-10-01 부터 상신한 순간 잠긴다:
   * 결재자가 보는 내용과 실제 자료가 어긋나면 안 되기 때문이다. 고치려면 회수한다.
   */
  function cycleLocked(u) {
    return APPR.some(function (a) {
      return a.username === u && a.cycle === CYCKEY() && (a.status === 'submitted' || a.status === 'approved');
    });
  }
  /** 잠긴 까닭을 한 마디로. '결재가 끝나' / '결재 중이라' */
  function lockWhy(u) { return cycleApproved(u) ? '결재가 끝나' : '결재 중이라'; }
  function lockTitle(u) {
    return cycleName(CYC.y, CYC.m) + (cycleApproved(u) ? ' 결재가 끝났습니다' : ' 결재 중입니다');
  }
  /** 잠겼을 때 무엇을 하면 되는지. */
  function lockHow(u) {
    if (cycleApproved(u)) return '결재가 끝나 확정됐습니다. 정정이 필요하면 관리자에게 문의해 주세요.';
    var a = APPR.filter(function (x) { return x.username === u && x.cycle === CYCKEY() && x.status === 'submitted'; })[0];
    return a ? withdrawHow(a) : '고치시려면 「이번 달 마감」에서 <b>회수</b>한 뒤 수정해 다시 상신하세요.';
  }
  /**
   * 결재 중인 건을 고치려면 무엇을 해야 하는지. 아무도 승인하지 않았으면 회수, 한 분이라도 승인했으면
   * 회수가 막히므로 '지금 차례인 분에게 반려를 요청'(그분만 반려할 수 있다).
   */
  function withdrawHow(a) {
    var anyDone = (a.steps || []).some(function (x) { return x.result; });
    if (!anyDone) return '고치시려면 「이번 달 마감」에서 <b>회수</b>한 뒤 수정해 다시 상신하세요.';
    var cur = (a.steps || []).filter(function (x) { return x.seq === a.cur_seq; })[0];
    return '이미 승인한 분이 있어 회수할 수 없습니다. 고치시려면 지금 차례인 <b>' +
      esc(cur ? (cur.name || nameOf(cur.approver)) : '결재자') + '</b> 님에게 반려를 요청해 주세요.';
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

  /* ══════════════════ 기간 요약 (여러 주기를 볼 때의 마감 현황) ══════════════════
     달마다 얼마였는지 한 줄씩. 합계는 '주기별 합계를 더한 값'으로만 정의한다 — 새 계산식이 없다.
     줄을 누르면 그 주기로 간다(거기서 상신·결재 문서·통행료 채우기를 한다).             */
  function viewPeriod() {
    var all = isAll(), mine = myName();
    var cs = cyclesInView().slice().reverse();
    var rows = cs.map(function (c) {
      var r = cycleRange(c.y, c.m), key = cycKey(c);
      var list = TRIPS.filter(function (t) { var s = Number(t.start_time); return s >= r.lo && s < r.hi; });
      var T = totals(list, { range: r, who: all ? null : mine, allUsers: all });
      var ap = APPR.filter(function (a) { return a.cycle === key && (all || a.username === mine); });
      return { c: c, key: key, T: T, ap: ap };
    });
    var sum = { n: 0, km: 0, fuel: 0, toll: 0, park: 0, cost: 0, unk: 0 };
    rows.forEach(function (x) {
      ['n', 'km', 'fuel', 'toll', 'park', 'cost', 'unk'].forEach(function (k) { sum[k] += x.T[k]; });
    });
    var maxCost = rows.reduce(function (m, x) { return Math.max(m, x.T.cost); }, 0);
    var withData = rows.filter(function (x) { return x.T.n || x.T.cost; }).length;

    var h = head(all ? '전체 기간 요약' : '기간 요약',
      esc(viewName()) + ' · ' + esc(viewSpan()) + ' · <b>조회 전용</b>');
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>' + n0(rows.length) + '주기 합계' +
      (all ? ' · 전 직원' : '') + '</div>' +
      '<p class="verdict">업무용 비용 <em>' + won(sum.cost) + '</em></p><div class="facts">' +
      fact('운행', n0(sum.n) + '<small>건</small>', km(sum.km) + ' km') +
      fact('유류비', won(sum.fuel), '거리 × 분기·지역 단가') +
      fact('통행료 · 주차', won(sum.toll + sum.park), '통행 ' + won(sum.toll) + ' · 주차 ' + won(sum.park)) +
      fact('주기 평균', won(withData ? sum.cost / withData : 0), '운행이 있는 ' + n0(withData) + '주기 기준') +
      '</div></div>';

    h += sect('주기별', rows.length + '주기', '',
      '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>주기</th><th>기간</th><th class="n">운행</th><th class="n">거리</th><th class="n">유류비</th>' +
      '<th class="n">통행료</th><th class="n">주차</th><th class="n">합계</th><th style="width:16%"></th>' +
      '<th class="n">미확정</th><th>결재</th></tr></thead><tbody>' +
      rows.map(function (x) {
        var T = x.T, pct = maxCost ? Math.round(T.cost / maxCost * 100) : 0;
        var apr;
        if (all) {
          var done = x.ap.filter(function (a) { return a.status === 'approved'; }).length;
          var ing = x.ap.filter(function (a) { return a.status === 'submitted'; }).length;
          apr = (done || ing) ? '<span class="dim">완료 ' + n0(done) + (ing ? ' · 결재 중 ' + n0(ing) : '') + '</span>' : '<span class="dim">—</span>';
        } else {
          apr = myApprTag(x.key) || (T.n ? '<span class="st dim">미상신</span>' : '<span class="dim">—</span>');
        }
        return '<tr class="clk" tabindex="0" data-cyc="' + x.c.y + '-' + x.c.m + '" title="' + esc(cycleName(x.c.y, x.c.m)) + ' 로 가기">' +
          '<td><span class="lead">' + x.c.y + '년 ' + x.c.m + '월분</span></td>' +
          '<td class="dim">' + esc(cycleSpan(x.c.y, x.c.m)) + '</td>' +
          '<td class="n">' + n0(T.n) + '</td><td class="n">' + km(T.km) + '</td>' +
          '<td class="n">' + n0(T.fuel) + '</td><td class="n">' + n0(T.toll) + '</td>' +
          '<td class="n">' + (T.park ? n0(T.park) : '—') + '</td>' +
          '<td class="n total">' + n0(T.cost) + '</td>' +
          '<td><span class="tbar"><i style="width:' + pct + '%"></i></span></td>' +
          '<td class="n ' + (T.unk ? 'unk' : 'dim') + '">' + (T.unk ? n0(T.unk) : '—') + '</td>' +
          '<td>' + apr + '</td></tr>';
      }).join('') + '</tbody><tfoot><tr><td colspan="2">합계</td><td class="n">' + n0(sum.n) + '</td><td class="n">' + km(sum.km) +
      '</td><td class="n">' + n0(sum.fuel) + '</td><td class="n">' + n0(sum.toll) + '</td><td class="n">' +
      (sum.park ? n0(sum.park) : '—') + '</td><td class="n total">' + n0(sum.cost) + '</td><td></td><td class="n">' +
      (sum.unk ? n0(sum.unk) : '—') + '</td><td></td></tr></tfoot></table></div></div>');

    h += '<div class="anote">합계는 <b>주기별 합계를 그대로 더한 값</b>입니다. 주기를 누르면 그 주기로 가서 ' +
      '상신·결재 문서·통행료 채우기를 할 수 있습니다. 통행료 미확정은 0원으로 잡혀 있습니다.</div>';
    return h;

    function fact(k, v, sub) {
      return '<div class="fact"><div class="k">' + esc(k) + '</div><div class="v">' + v +
        '</div><div class="sub">' + esc(sub || '') + '</div></div>';
    }
  }

  /** 이번 주기에 업무 운행했는데 계기판 사진이 없는 차량(번호판 목록). 서버 검증 R12 와 같은 기준. */
  function odoPhotoMissing() {
    var me = myName(), r = cycleRange(CYC.y, CYC.m);
    var plates = [];
    TRIPS.forEach(function (t) {
      if (t.username !== me || t.purpose !== BUSINESS || t.end_odometer == null) return;
      var p = t.plate_no || '';
      if (plates.indexOf(p) < 0) plates.push(p);
    });
    if (!plates.length) return [];
    var shots = EVID.filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === me && e.category === '계기판' && (e.photo_path || '') !== '' && d >= r.lo && d < r.hi;
    });
    var plateOf = function (e) { return e.vehicle_plate || (plates.length === 1 ? plates[0] : null); };
    return plates.filter(function (p) { return !shots.some(function (e) { return plateOf(e) === p; }); });
  }

  /* ══════════════════ 마감 현황 ══════════════════ */
  function viewClose() {
    if (!LOADED) return head(isAll() ? '전체 마감 현황' : '이번 달 마감') + skeleton();
    if (isMulti()) return viewPeriod();
    var T = totals(TRIPS, isAll() ? { allUsers: true } : { who: myName() }), A = audit();
    var bads = A.filter(function (f) { return f.sev === 'bad' && f.n > 0; });
    var badN = bads.reduce(function (s, f) { return s + f.n; }, 0);
    var r = cycleRange(CYC.y, CYC.m), now = Date.now();
    var pct = Math.max(0, Math.min(100, Math.round((now - r.lo) / (r.hi - r.lo) * 100)));
    var days = Math.ceil((r.hi - now) / 86400e3);
    var closed = now >= r.hi;

    // 한 문장의 판정 — 숫자 네 개보다 이게 먼저다
    var verdict, clean = '';
    // 결재 중이거나 끝났으면 고칠 수도 채울 수도 없다 — 손보라고 시키지 않는다.
    var approved = !isAll() && cycleLocked(myName());
    var notSent = !isAll() && !myAppr();
    if (approved) {
      // 끝난 것(초록)과 결재 중(주황)은 다른 상태다 — 같은 색이면 '다 됐다'로 읽는다.
      if (cycleApproved(myName())) { verdict = '<em>결재가 끝났습니다</em>'; clean = ' clean'; }
      else { verdict = '<em>결재 중입니다</em>'; clean = ' wait'; }
    } else if (badN) {
      verdict = '손봐야 할 기록이 <em>' + n0(badN) + '건</em> 있습니다';
    } else if (T.unk) {
      verdict = '통행료 <em>' + n0(T.unk) + '건</em>을 채운 뒤 상신하면 끝납니다';
    } else if (!T.n) {
      verdict = '아직 기록된 운행이 없습니다'; clean = ' clean';
    } else {
      verdict = notSent && closed ? '<em>손볼 것이 없습니다</em> — 상신하세요' : '<em>손볼 것이 없습니다</em>'; clean = ' clean';
    }

    var h = head(isAll() ? '전체 마감 현황' : cmpCycle(CYC, currentCycle()) === 0 ? '이번 달 마감' : cycleName(CYC.y, CYC.m) + ' 마감',
      isAll() ? '전체 직원 ' + Object.keys(USERS).filter(function (u) { return USERS[u].uses_driving !== false; }).length + '명' : esc(ME.name || ''));

    // 21일이 지나 들어오면 새 주기가 먼저 뜬다. 지난달분을 아직 안 올렸으면 그것부터 알려 준다.
    var pp = prevPending();
    if (pp) {
      h += '<div class="hpnote warn">' + ic('alert', 16) + '<span><b>' + esc(cycleName(pp.cyc.y, pp.cyc.m)) + '(' +
        esc(cycleSpan(pp.cyc.y, pp.cyc.m)) + ')</b>을 ' +
        (pp.a && pp.a.status === 'rejected' ? '반려받은 뒤 아직 다시 상신하지 않았습니다.'
          : pp.a && pp.a.status === 'withdrawn' ? '회수한 뒤 아직 다시 상신하지 않았습니다.' : '아직 상신하지 않았습니다.') +
        '</span><button class="btn sm" data-cyc="' + pp.cyc.y + '-' + pp.cyc.m + '">' + pp.cyc.m + '월분 마감하기</button>' +
        '<button class="iconbtn" data-prevx="' + esc(pp.key) + '" aria-label="이 안내 닫기" title="이 안내 닫기">' + ic('close', 14) + '</button></div>';
    }

    // ★ 계기판 사진 안내(2026-10-07) — 이번 주기에 업무 운행한 차의 계기판 사진이 서버에 없으면 미리 알린다.
    //   검증 R12 와 같은 기준(번호판 없는 사진은 차가 한 대일 때만 그 차로 본다). 앱에서 찍어 올렸으면 뜨지 않는다.
    if (!isAll() && !cycleLocked(myName())) {
      var miss = odoPhotoMissing();
      if (miss.length) {
        h += '<div class="hpnote warn">' + ic('gauge', 16) + '<span><b>계기판 사진</b>이 아직 없습니다' +
          (miss.length > 1 || miss[0] ? ' (' + esc(miss.map(function (p) { return p || '차량 미지정'; }).join(', ')) + ')' : '') +
          '. 이번 주기 <b>마지막 운행을 마친 뒤</b> 계기판을 찍어 앱이나 웹 「영수증 › 계기판」에 올려 주세요 — 검증에서 운행일지 최종 km 와 대조합니다.</span>' +
          '<button class="btn sm" data-odoshot="1">계기판 사진 올리기</button></div>';
      }
    }

    if (!isAll()) return h + homeA(T, A, badN, approved, closed, days);
    h += '<div class="hero fade">' +
      '<div class="eyebrow"><span class="dot' + (clean === ' clean' ? ' ok' : '') + '"></span>' + esc(cycleName(CYC.y, CYC.m)) +
      ' · ' + esc(cycleSpan(CYC.y, CYC.m)) + '</div>' +
      '<p class="verdict' + clean + '">' + verdict + '</p>' +
      '<div class="track' + (closed ? ' done' : '') + '"><i style="width:' + pct + '%"></i></div>' +
      '<div class="facts">' +
      fact('마감', closed ? '종료' : (days <= 0 ? '오늘' : days + '<small>일 남음</small>'),
        closed ? esc(cycleSpan(CYC.y, CYC.m)) + ' 종료' : pct + '% 지남') +
      fact('운행', n0(T.n) + '<small>건</small>', km(T.km) + ' km' + (T.manual ? ' · 수기 ' + n0(T.manual) : '')) +
      fact('업무용 비용', won(T.cost), '유류 ' + won(T.fuel) + ' · 통행 ' + won(T.toll)) +
      // 잠긴 뒤에는 채울 수 없다 — 빨갛게 '여기를 보라'고 하지 않고, 어떻게 올라갔는지만 적는다.
      fact('통행료 미확정', n0(T.unk) + '<small>건</small>',
        T.unk ? (approved ? '0원으로 상신됨' : '정산에서 0원으로 잡힙니다') : '전부 확정', T.unk > 0 && !approved) +
      '</div></div>';

    // 결재 — 히어로 바로 아래. 이 주기가 지금 어디까지 갔는지가 제일 궁금하다.
    h += apprStrip();

    // 점검 요약 — 문제가 있을 때만, 있으면 크게.
    //  결재가 끝났으면 어차피 못 고치니 시키지 않는다.
    if ((badN || T.unk) && !approved) {
      var list = A.filter(function (f) { return f.n > 0; }).slice(0, 4);
      h += sect('바로 봐야 할 것', null,
        '<button class="btn sm" data-v="' + (isAll() ? 'a_check' : 'check') + '">전체 점검 ' +
          ic('chev', 13) + '</button>',
        '<div class="panel">' + list.map(issueRow).join('') + '</div>');
    }

    if (isAll()) {
      var rows = perPersonTotals();
      h += sect(ORGF.team ? '파트·센터별' : '팀별', null, '', teamCards(rows));
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

  /**
   * A안 홈(본인). 위: 마감 5단계 막대(누르면 그 단계로) + '지금 할 일' 한 문장과 큰 버튼 하나.
   * 가운데: 비용(유류·통행료·주차 — 영수증 포함이라고 밝힘) · 운행 · 내가 결재할 것.
   * 아래: 결재 띠 → 바로 봐야 할 것(있을 때만) → 최근 운행 5건.
   */
  function homeA(T, A, badN, approved, closed, days) {
    var S = stepInfo(), st = S.status, cur = S.cur;
    var big = function (v, t) { return '<button class="btn pri big" data-v="' + v + '">' + esc(t) + ' →</button>'; };
    var sub = function (v, t) { return '<button class="btn" data-v="' + v + '">' + esc(t) + '</button>'; };
    var verdict, desc = '', btns = '', clean = '';
    if (st === 'approved') {
      verdict = '<em>결재가 끝났습니다</em>'; clean = ' clean';
      desc = '「정산·엑셀」에서 운행기록부를 받을 수 있습니다.'; btns = big('settle', '정산·엑셀 받기');
    } else if (st === 'submitted') {
      verdict = '<em>결재 중입니다</em>'; clean = ' wait';
      desc = '결재 차례가 된 분께 팀즈로 알림이 갑니다. 결재 중에는 이 주기의 기록을 고칠 수 없습니다.';
    } else if (cur === 0 && !S.trips.length && !S.ev.length) {
      verdict = '아직 기록된 운행이 없습니다'; clean = ' clean';
      desc = '앱에서 운행을 기록하면 여기에 모입니다.';
    } else if (cur === 0) {
      verdict = S.fixBad ? '운행 기록 <em>' + n0(S.fixBad) + '건</em>을 먼저 손보세요' : '<em>① 운행 기록</em>을 확인하세요';
      desc = S.fixBad ? '계기판이 튀거나 목적이 비어 있으면 비용이 틀리게 잡힙니다. 고친 뒤 「다음 단계」를 누르세요.'
        : '운행 ' + n0(S.trips.length) + '건이 맞는지 보고, 맨 아래 「다음 단계」를 누르세요.';
      btns = S.fixBad ? big('check', '기록 ' + n0(S.fixBad) + '건 고치기') + sub('trips', '운행일지 보기') : big('trips', '운행 기록 확인하기');
    } else if (cur === 1) {
      verdict = '<em>② 영수증·통행료</em>를 차례대로 정리하세요';
      desc = '주차 → 통행료 → 주유 → 계기판 순서로 하나씩 확인합니다.' +
        (S.unk ? ' 통행료 미확정 ' + n0(S.unk) + '건은 「통행료」 차례에서 하이패스 대조나 직접 채우기로 정리합니다.' : '') +
        (S.noPhoto ? ' 사진 없는 영수증 ' + n0(S.noPhoto) + '건이 있습니다(앱에서 사진을 붙일 수 있습니다).' : '');
      btns = big('evid', '영수증·통행료 정리하기');
    } else {
      verdict = st === 'rejected' ? '반려됐습니다 — 고쳐서 <em>다시 상신</em>하세요' : '<em>기록이 정리됐습니다</em> — 검증하고 상신하세요';
      desc = closed ? 'AI 가 영수증 사진과 입력값을 맞춰 본 뒤 결재선을 골라 상신합니다.'
        : '주기 중에도 상신할 수 있습니다. 상신하면 이 주기의 기록은 고칠 수 없습니다.';
      if (S.noPhoto) desc += ' 사진이 없는 영수증 ' + n0(S.noPhoto) + '건은 결재 문서에 빈 칸으로 나갑니다(앱에서 사진을 붙일 수 있습니다).';
      btns = big('verify', '검증하고 상신하기');
    }
    var when = closed ? '마감 종료' : days <= 0 ? '오늘 마감' : '마감까지 ' + days + '일';
    var h = '<div class="hero fade"><div class="eyebrow"><span class="dot' + (st === 'approved' ? ' ok' : '') + '"></span>' +
      esc(cycleName(CYC.y, CYC.m)) + ' · ' + esc(cycleSpan(CYC.y, CYC.m)) + ' · ' + esc(when) + '</div>' +
      '<div class="steps">' + S.steps.map(function (x, i) {
        // 상신한 뒤의 1~3단계는 '완료'가 아니라 '상신됨' — 남은 것이 있었으면 그대로(0원 등) 올라간 것이다.
        var lab = (i + 1) + ' ' + x.t + (x.state === 'done' ? (S.sent && i < 2 ? ' · 상신됨' : ' · 완료') : x.state === 'now' ? ' · 지금 할 일' : '');
        return '<button class="stp ' + x.state + '" data-v="' + x.v + '"' + (x.state === 'now' ? ' aria-current="step"' : '') +
          '><i></i><b>' + esc(lab) + '</b><span>' + esc(x.sub) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="nowrow"><div style="flex:1;min-width:0">' + (btns ? '<div class="nk">지금 할 일</div>' : '') +
      '<p class="verdict' + clean + '">' + verdict + '</p>' + (desc ? '<div class="nd">' + esc(desc) + '</div>' : '') + '</div>' +
      (btns ? '<div class="nowbtns">' + btns + '</div>' : '') + '</div></div>';

    var ib = inbox();
    var monthOf = function (c) { var p = String(c || '').split('-'); return p.length === 2 ? (+p[1]) + '월분' : String(c || ''); };
    h += '<div class="cards3">' +
      '<div class="cardx"><div class="k">' + (closed ? '업무용 비용' : '업무용 비용 (지금까지)') + '</div><div class="v">' + won(T.cost) + '</div><div class="rows">' +
        '<div><span>유류</span><b>' + won(T.fuel) + '</b></div>' +
        '<div><span>통행료' + (T.evToll ? ' (영수증 포함)' : '') + '</span><b>' + won(T.toll) + '</b></div>' +
        '<div><span>주차' + (T.evPark ? ' (영수증 포함)' : '') + '</span><b>' + won(T.park) + '</b></div></div></div>' +
      '<div class="cardx"><div class="k">운행</div><div class="v">' + n0(T.n) + '<small>건</small></div><div class="rows">' +
        '<div><span>거리</span><b>' + km(T.km) + ' km</b></div><div><span>업무용</span><b>' + km(T.bizKm) + ' km</b></div>' +
        (T.manual ? '<div><span>수기 입력</span><b>' + n0(T.manual) + '건</b></div>' : '') + '</div></div>' +
      '<div class="cardx"><div class="k">내가 결재할 것</div><div class="v' + (ib.length ? ' hot' : '') + '">' + n0(ib.length) + '<small>건</small></div>' +
        (ib.length
          ? '<div class="rows">' + ib.slice(0, 2).map(function (a) {
              return '<div><span>' + esc(nameOf(a.username)) + ' · ' + esc(monthOf(a.cycle)) + '</span><b>' + won((a.snapshot || {}).cost) + '</b></div>';
            }).join('') + '</div><button class="lk" data-v="inbox">결재함 열기 →</button>'
          : '<div class="rows"><div><span>지금 차례인 결재가 없습니다</span></div></div>') + '</div>' +
      '</div>';

    h += apprStrip();
    // 통행료 미확정은 위 '지금 할 일'·2단계가 말한다 — 여기서 또 세지 않는다.
    var others = A.filter(function (f) { return f.n > 0 && f.k !== 'unk'; });
    if (others.length && !approved) {
      var list = others.slice(0, 4);
      h += sect('바로 봐야 할 것', null,
        '<button class="btn sm" data-v="check">기록 점검 전체 ' + ic('chev', 13) + '</button>',
        '<div class="panel">' + list.map(issueRow).join('') + '</div>');
    }
    h += sect('최근 운행', null, '<button class="btn sm" data-v="trips">운행 기록 전체 ' + ic('chev', 13) + '</button>',
      tripTable(TRIPS.slice(0, 5), { compact: true }));
    return h;
  }

  /**
   * 직전 주기에 내 운행이 있는데 아직 상신(또는 재상신)하지 않았으면 { cyc, a, key }, 아니면 null.
   * 이번 주기의 개인 마감 현황에서만 본다. 운행이 있는지는 한 번만 가볍게 물어본다(한 줄만 받는다).
   */
  var PREV_HAS = {};
  function prevPending() {
    var cur = currentCycle();
    if (isAll() || isMulti() || cmpCycle(CYC, cur) !== 0) return null;
    var pv = addCycle(cur, -1), key = cycKey(pv), a = myAppr(key);
    if (a && (a.status === 'submitted' || a.status === 'approved')) return null;
    var k = myName() + '|' + key;
    try { if (localStorage.getItem('drv.prevx') === k) return null; } catch (e) { }
    if (PREV_HAS[k] === undefined) {
      PREV_HAS[k] = null;
      var r = cycleRange(pv.y, pv.m);
      apiRetry('/rest/v1/trips?select=id&deleted_at=is.null&username=eq.' + encodeURIComponent(myName()) +
        '&start_time=gte.' + r.lo + '&start_time=lt.' + r.hi + '&limit=1')
        .then(function (x) { return x.ok ? x.json() : Promise.reject(new Error('HTTP ' + x.status)); })
        .then(function (rows) {
          PREV_HAS[k] = !!(rows && rows.length);
          if (PREV_HAS[k] && VIEW === 'close' && LOADED) render();
        })
        .catch(function () { delete PREV_HAS[k]; });      // 다음에 이 화면을 그릴 때 다시 물어본다
    }
    return PREV_HAS[k] ? { cyc: pv, a: a, key: k } : null;
  }

  /** 마감 현황의 결재 띠. 상태에 따라 버튼이 달라진다. */
  function apprStrip() {
    var a = myAppr(), st = apprStatusText(a);
    var canWithdraw = a && a.status === 'submitted' &&
      !(a.steps || []).some(function (x) { return x.result; });
    // 단계마다 '지금 받을 수 있는 문서'가 다르다.
    //   상신 전        : 지금 자료로 만든 미리보기(쪽마다 「미결재」)
    //   결재 중·완료   : 상신할 때 고정한 자료로 만든 결재 문서 — 버튼은 apprExtra 가 단다
    var btn = '';
    if (!a || a.status === 'rejected' || a.status === 'withdrawn') {
      btn = '<button class="btn sm" data-pdf="">' + ic('dl', 13) + 'PDF 미리보기</button>' +
        '<button class="btn sm" id="btnOpenSubmit" title="검증 없이 바로 결재선을 골라 상신합니다">' +
        (a && a.status === 'rejected' ? '바로 다시 상신' : (isAll() ? '내 것 결재 상신' : '바로 상신')) +
        '</button>';
    } else if (canWithdraw) {
      btn = '<button class="btn sm" data-appr="withdraw" data-id="' + a.id + '">회수</button>';
    }
    var locked = a && (a.status === 'submitted' || a.status === 'approved');
    if (locked && EXT.wantSummaries) EXT.wantSummaries([a.id]);
    return '<section class="sect" style="margin-top:16px"><div class="astrip">' +
      '<div class="ahd"><span class="st ' + st.cls + '">' + esc(st.t) + '</span>' +
      '<span style="flex:1"></span>' + btn + '</div>' +
      (a ? apprTrack(a) : '<div class="anote" style="margin-top:0">' +
        '결재선은 상신할 때 결재받을 분의 이름을 넣어 직접 고릅니다. 지난번 결재선을 불러올 수도 있습니다.</div>') +
      (locked && EXT.apprExtra ? EXT.apprExtra(a) : '') +
      (a && a.status === 'submitted' ? '<div class="anote">결재 중에는 이 주기의 운행·영수증을 고칠 수 없습니다. ' +
        withdrawHow(a) + '</div>' : '') +
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

  /** 사람별 합계(비용 큰 순). 운행이 없어도 정산에 들어가는 영수증이 있으면 한 줄로 나온다 — 줄의 합이 위 합계와 같아야 한다. */
  function perPersonTotals() {
    var byU = {};
    TRIPS.forEach(function (t) { (byU[t.username] = byU[t.username] || []).push(t); });
    evidOfCycle().forEach(function (e) {
      if (Number(e.amount) > 0 && (e.category === '주차' || e.category === '통행료') && !byU[e.username]) byU[e.username] = [];
    });
    return Object.keys(byU).map(function (u) { var x = totals(byU[u], { who: u }); x.u = u; return x; })
      .sort(function (a, b) { return b.cost - a.cost; });
  }

  /** 팀별 합계 카드(관리) — 누르면 그 팀으로 좁힌다. 팀을 이미 골랐으면 파트·센터별로. */
  function teamCards(rows) {
    if (!isAll() || !rows.length) return '';
    var byUnit = !!ORGF.team, by = {}, out = [];
    rows.forEach(function (x) {
      var p = orgPath(x.u), k = byUnit ? (p.unit || '(파트 없음)') : p.div + '|' + p.team;
      if (!by[k]) { by[k] = { k: k, p: p, label: byUnit ? (p.unit || '팀 직속') : orgName(p), sub: byUnit ? orgName(p) : p.div, rank: orgRank(p), n: 0, cost: 0, unk: 0, trips: 0 }; out.push(by[k]); }
      var g = by[k]; g.n++; g.cost += x.cost || 0; g.unk += x.unk || 0; g.trips += x.n || 0;
    });
    if (out.length < 2 && !byUnit) return '';
    var max = out.reduce(function (a, g) { return Math.max(a, g.cost); }, 1);
    out.sort(function (a, b) { return b.cost - a.cost; });
    return '<div class="tcards">' + out.map(function (g) {
      var attr = byUnit ? (g.p.unit ? ' data-orgunit="' + esc(g.p.unit) + '"' : '') : ' data-orgteam="' + esc(g.p.div + '|' + g.p.team) + '"';
      return '<button class="tcard"' + attr + (attr ? '' : ' disabled') + '><span class="tl">' + esc(g.label) + '</span>' +
        '<span class="ts">' + esc(g.sub || '') + '</span>' +
        '<span class="tv">' + won(g.cost) + '</span>' +
        '<span class="tbar"><i style="width:' + Math.max(3, Math.round(g.cost / max * 100)) + '%"></i></span>' +
        '<span class="tm">' + n0(g.n) + '명 · 운행 ' + n0(g.trips) + '건' + (g.unk ? ' · <em>미확정 ' + n0(g.unk) + '</em>' : '') + '</span></button>';
    }).join('') + '</div>';
  }
  /** 직원별 금액 표. 관리 화면에서는 소속을 맨 앞에 두고 팀별로 묶어 팀 합계를 붙인다(2026-10-07). */
  function personTable(rows) {
    if (!rows.length) return blank('집계할 운행이 없습니다.', null, 'users');
    var all = isAll(), cols = all ? 11 : 9;
    var h = '<div class="panel"><div class="scroll tall" data-rows><table class="ptable"><thead><tr>' +
      (all ? '<th>파트·센터</th>' : '') + '<th>이름</th>' + (all ? '' : '<th>소속</th>') + '<th class="n">운행</th><th class="n">거리(km)</th>' +
      '<th class="n">유류비</th><th class="n">통행료</th><th class="n">주차</th>' +
      '<th class="n">합계</th><th class="n">통행료 미확정</th>' +
      (all ? '<th></th>' : '') + '</tr></thead><tbody>';
    var row = function (x) {
      var u = USERS[x.u] || {};
      return '<tr class="clk" tabindex="0" data-person="' + esc(x.u) + '">' +
        (all ? orgCell(x.u, true) : '') +
        '<td><span class="lead">' + esc(u.name || x.u) + '</span></td>' +
        (all ? '' : '<td class="dim">' + esc(u.dept || '—') + '</td>') +
        '<td class="n">' + n0(x.n) + '</td>' +
        '<td class="n">' + km(x.km) + '</td>' +
        '<td class="n">' + n0(x.fuel) + '</td>' +
        '<td class="n">' + n0(x.toll) + '</td>' +
        '<td class="n">' + (x.park ? n0(x.park) : '—') + '</td>' +
        '<td class="n total">' + n0(x.cost) + '</td>' +
        '<td class="n ' + (x.unk ? 'unk' : 'dim') + '">' + (x.unk ? n0(x.unk) + '건' : '—') + '</td>' +
        (all
          ? '<td class="n"><button class="btn sm" data-print="' + esc(x.u) + '" ' +
            'title="' + esc(u.name || x.u) + ' 님 운행기록부 인쇄">' + ic('receipt', 13) + '인쇄</button></td>'
          : '') + '</tr>';
    };
    var sum = function (list, k) { return list.reduce(function (a, x) { return a + (Number(x[k]) || 0); }, 0); };
    if (all) {
      orgGroups(rows, function (x) { return x.u; }).forEach(function (g) {
        h += orgGroupRow(g, cols, '운행 ' + n0(sum(g.list, 'n')) + '건 · 합계 <b>' + won(sum(g.list, 'cost')) + '</b>' +
          (sum(g.list, 'unk') ? ' · <span class="unk">미확정 ' + n0(sum(g.list, 'unk')) + '건</span>' : ''));
        g.list.forEach(function (x) { h += row(x); });
      });
      h += '</tbody><tfoot><tr><td colspan="2">' + n0(rows.length) + '명 합계</td>' +
        '<td class="n">' + n0(sum(rows, 'n')) + '</td><td class="n">' + km(sum(rows, 'km')) + '</td>' +
        '<td class="n">' + n0(sum(rows, 'fuel')) + '</td><td class="n">' + n0(sum(rows, 'toll')) + '</td>' +
        '<td class="n">' + n0(sum(rows, 'park')) + '</td><td class="n total">' + n0(sum(rows, 'cost')) + '</td>' +
        '<td class="n">' + (sum(rows, 'unk') ? n0(sum(rows, 'unk')) + '건' : '—') + '</td><td></td></tr></tfoot>';
      return h + '</table></div></div>';
    }
    rows.forEach(function (x) { h += row(x); });
    return h + '</tbody></table></div></div>';
  }

  /* ══════════════════ 좁히기 공통 (기간 · 날짜 · 정렬 · 나눠 보기) ══════════════════ */
  /** 여러 주기를 보고 있는가. */
  function isMulti() { return !!RANGE; }
  /** 지금 화면이 보는 기간(ms). 한 주기면 그 주기, 여러 주기면 처음~끝. */
  function viewRange() {
    if (!RANGE) return cycleRange(CYC.y, CYC.m);
    return { lo: cycleRange(RANGE.from.y, RANGE.from.m).lo, hi: cycleRange(RANGE.to.y, RANGE.to.m).hi };
  }
  /** 조회 범위에 든 주기들(오래된 것부터). 한 주기면 그것 하나. */
  function cyclesInView() {
    if (!RANGE) return [{ y: CYC.y, m: CYC.m }];
    var out = [], y = RANGE.from.y, m = RANGE.from.m;
    for (var i = 0; i < 60; i++) {
      out.push({ y: y, m: m });
      if (y === RANGE.to.y && m === RANGE.to.m) break;
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }
  function cycKey(c) { return c.y + '-' + pad(c.m); }
  /** 그 시각이 속한 주기. 21일부터 다음 달분. */
  function cycleOfMs(ms) {
    var d = kd(ms), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    if (d.getUTCDate() >= 21) { m += 1; if (m > 12) { m = 1; y += 1; } }
    return { y: y, m: m };
  }
  /** 머리띠·제목에 쓰는 기간 이름. "2026년 9월분" / "2026년 4월분 – 9월분". */
  function viewName() {
    if (!RANGE) return cycleName(CYC.y, CYC.m);
    var a = RANGE.from, b = RANGE.to;
    return a.y + '년 ' + a.m + '월분 – ' + (a.y === b.y ? '' : b.y + '년 ') + b.m + '월분';
  }
  function viewSpan() {
    if (!RANGE) return cycleSpan(CYC.y, CYC.m);
    var r = viewRange();
    return ymd(r.lo).slice(2).replace(/-/g, '.') + ' – ' + ymd(r.hi - 1).slice(2).replace(/-/g, '.');
  }
  /** 여러 주기를 볼 때 한 주기 전용 화면에 띄우는 안내. */
  function singleOnly(title, what) {
    var cs = cyclesInView().slice().reverse().slice(0, 6);
    return head(title, esc(viewName())) +
      '<div class="panel" style="padding:30px 26px;text-align:center">' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:8px">' + esc(what) + '은 한 주기씩 합니다</div>' +
      '<div class="dim" style="font-size:13px;line-height:1.8;max-width:460px;margin:0 auto 16px">' +
      '지금은 여러 주기를 함께 보고 있습니다(조회 전용). 어느 주기를 다룰지 골라 주세요.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">' +
      cs.map(function (c) {
        return '<button class="btn sm" data-cyc="' + c.y + '-' + c.m + '">' + esc(cycleName(c.y, c.m)) + '</button>';
      }).join('') + '</div></div>';
  }

  function dateFilterOn() { var f = dateBounds(); return !!(f.from || f.to); }
  /** 걸려 있는 날짜 범위(앞뒤가 바뀌었으면 바로잡고, 치는 중인 '0002-…' 같은 값은 없는 것으로 본다). */
  function dateBounds() {
    var ok = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && s >= '2000-01-01' ? s : ''; };
    var a = ok(DATEF.from), b = ok(DATEF.to);
    if (a && b && a > b) { var t = a; a = b; b = t; }
    return { from: a, to: b };
  }
  function inDateFilter(ms) {
    var f = dateBounds();
    if (!f.from && !f.to) return true;
    var d = ymd(ms);
    return (!f.from || d >= f.from) && (!f.to || d <= f.to);
  }
  /** 날짜 좁히기 줄. 조회 범위 밖 날짜는 고를 수 없다. */
  function dateFilterHtml() {
    var r = viewRange(), lo = ymd(r.lo), hi = ymd(r.hi - 1);
    var now = Date.now(), quick = '';
    // 오늘이 조회 범위 안일 때만 '이번 주'·'지난 주' 가 뜻이 있다.
    if (now >= r.lo && now < r.hi + 7 * 86400e3) {
      var d = kd(now), dow = (d.getUTCDay() + 6) % 7;            // 월요일 = 0
      var mon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) - KST;
      var clip = function (a, b) {
        var f = ymd(Math.max(a, r.lo)), t = ymd(Math.min(b, r.hi - 1));
        return f <= t ? [f, t] : null;
      };
      var q = [['이번 주', clip(mon, mon + 6 * 86400e3)], ['지난 주', clip(mon - 7 * 86400e3, mon - 86400e3)]];
      quick = q.filter(function (x) { return x[1]; }).map(function (x) {
        var on = DATEF.from === x[1][0] && DATEF.to === x[1][1];
        return '<button class="qd' + (on ? ' on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') +
          '" data-dq="' + x[1][0] + ',' + x[1][1] + '">' + x[0] + '</button>';
      }).join('');
    }
    return '<div class="dfil' + (dateFilterOn() ? ' on' : '') + '">' + ic('cal', 14) +
      '<input type="date" id="dfFrom" aria-label="시작 날짜" value="' + esc(DATEF.from) + '" min="' + lo + '" max="' + hi + '">' +
      '<span class="dim">–</span>' +
      '<input type="date" id="dfTo" aria-label="끝 날짜" value="' + esc(DATEF.to) + '" min="' + lo + '" max="' + hi + '">' +
      quick +
      (dateFilterOn() ? '<button class="qd x" data-dq="," aria-label="날짜 조건 지우기" title="날짜 조건 지우기">' + ic('close', 12) + '</button>' : '') +
      '</div>';
  }
  /** 사람 고르기(관리 화면). 지금 고른 사람은 목록에 없어도 남긴다. */
  function whoSelectHtml(usernames) {
    var seen = {};
    usernames.forEach(function (u) { seen[u] = 1; });
    if (FILT.who) seen[FILT.who] = 1;
    var key = function (u) { var p = orgPath(u); return orgRank(p) + '|' + orgName(p) + '|' + nameOf(u); };
    var us = Object.keys(seen).filter(function (u) { return u === FILT.who || orgMatch(u); })
      .sort(function (a, b) { var ka = key(a), kb = key(b); return (orgRank(orgPath(a)) - orgRank(orgPath(b))) || ka.localeCompare(kb, 'ko'); });
    // 팀별로 묶어 고른다(같은 이름도 소속으로 가린다).
    var html = '', cur = null;
    us.forEach(function (u) {
      var g = orgName(orgPath(u));
      if (g !== cur) { html += (cur !== null ? '</optgroup>' : '') + '<optgroup label="' + esc(g) + '">'; cur = g; }
      html += '<option value="' + esc(u) + '"' + (FILT.who === u ? ' selected' : '') + '>' + esc(nameOf(u)) + '</option>';
    });
    if (cur !== null) html += '</optgroup>';
    return '<label class="field">' + ic('users', 14) + '<select id="selWho" aria-label="사람"><option value="">사람 전체</option>' +
      html + '</select></label>';
  }
  /**
   * 표 정렬. getters = { 열이름: 행 → 값 }. 상태(SORTS[group])가 비어 있으면 기본(defKey, defDir).
   * 글자는 가나다순, 숫자는 크기순. 값이 같으면 원래 순서를 지킨다.
   */
  function sortRows(rows, group, getters, defKey, defDir) {
    SORT_DEF[group] = defKey + ':' + defDir;
    var st = String(SORTS[group] || '').split(':');
    var key = getters[st[0]] ? st[0] : defKey, dir = getters[st[0]] ? (+st[1] || 1) : defDir;
    var get = getters[key];
    if (!get) return rows;
    return rows.map(function (r, i) { return { r: r, i: i, v: get(r) }; }).sort(function (a, b) {
      var x = a.v, y = b.v, c;
      if (typeof x === 'string' || typeof y === 'string') c = String(x || '').localeCompare(String(y || ''), 'ko');
      else c = (Number(x) || 0) - (Number(y) || 0);
      return c * dir || a.i - b.i;
    }).map(function (x) { return x.r; });
  }
  /** 정렬되는 열 머리. dir0 = 처음 눌렀을 때 방향(숫자·날짜는 큰 것부터 -1, 글자는 1). */
  function thSort(label, key, group, dir0, numeric) {
    var st = String(SORTS[group] || SORT_DEF[group] || '').split(':');
    var on = st[0] === key, dir = on ? (+st[1] || 1) : 0;
    // 열 머리(th)는 그대로 두고 그 안에 진짜 버튼을 넣는다. th 에 role="button" 을 주면 '열 머리' 역할이
    // 지워져 aria-sort(정렬 상태)를 읽어 주지 않는다.
    return '<th class="srt' + (numeric ? ' n' : '') + (on ? ' on' : '') + '"' +
      (on ? ' aria-sort="' + (dir > 0 ? 'ascending' : 'descending') + '"' : '') + '>' +
      '<button type="button" data-sort="' + group + ':' + key + ':' + (dir0 || 1) + '">' + esc(label) +
      '<span class="ar" aria-hidden="true">' + (on ? (dir > 0 ? '▲' : '▼') : '') + '</span></button></th>';
  }
  /** 긴 표를 나눠 그린다 — 보이는 줄 수와 '더 보기' 줄. */
  function pageOf(group, total) {
    var n = Math.min(total, PAGES[group] || PAGE_SIZE);
    return {
      n: n,
      more: total > n ? '<div class="more"><button class="btn sm" data-more="' + group + '">' +
        n0(Math.min(PAGE_SIZE, total - n)) + '줄 더 보기</button><span class="dim">' +
        n0(n) + ' / ' + n0(total) + '줄</span><button class="btn sm" data-more="' + group + ':all">전부 보기</button></div>' : ''
    };
  }

  /* ══════════════════ 운행일지 ══════════════════ */
  function tripTable(rows, opt) {
    opt = opt || {};
    if (!rows.length) {
      // 필터를 안 걸었는데 '필터를 바꿔 보세요' 라고 하면 사용자가 헤맨다.
      var on = [];
      if (FILT.who) on.push(nameOf(FILT.who) + ' 님');
      if (FILT.car) on.push(FILT.car);
      if (FILT.purp) on.push(FILT.purp === '-' ? '목적 미선택' : FILT.purp);
      if (dateFilterOn()) on.push('날짜 조건');
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
    // 열 머리를 눌러 정렬한다(마감 현황의 '최근 운행' 처럼 줄인 표는 고정 순서).
    var g = opt.compact ? '' : 'tr';
    var th = function (label, key, dir0, num) {
      return g ? thSort(label, key, g, dir0, num) : '<th' + (num ? ' class="n"' : '') + '>' + label + '</th>';
    };
    if (g) {
      rows = sortRows(rows, g, {
        date: function (t) { return Number(t.start_time); },
        who: function (t) { var p = orgPath(t.username); return p.div + '|' + p.team + '|' + p.unit + '|' + nameOf(t.username); },
        purp: function (t) { return t.purpose || ''; },
        car: function (t) { return t.plate_no || ''; },
        dist: function (t) { return Number(t.distance_km) || 0; },
        odo: function (t) { return Number(t.start_odometer) || 0; },
        toll: function (t) { return Number(t.toll_cost) || 0; },
        park: function (t) { return Number(t.parking_cost) || 0; },
        place: function (t) { return t.visit_place || t.end_address || ''; }
      }, 'date', -1);
    }
    var pg = g ? pageOf(g, rows.length) : { n: rows.length, more: '' };
    var h = '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      th('날짜', 'date', -1) + (showWho ? th('소속 · 이름', 'who', 1) : '') + th('목적', 'purp', 1) + th('차량', 'car', 1) +
      th('거리', 'dist', -1, true) + (opt.compact ? '' : th('계기판', 'odo', -1, true)) +
      th('통행료', 'toll', -1, true) + (opt.compact ? '' : th('주차', 'park', -1, true)) +
      th('방문처', 'place', 1) + '</tr></thead><tbody>';
    rows.slice(0, pg.n).forEach(function (t) {
      var place = t.visit_place || t.end_address || '';
      h += '<tr class="clk' + (flags[t.id] ? ' flagged' : '') + '" tabindex="0" data-trip="' + t.id + '">' +
        // 여러 해를 함께 볼 때는 연도가 없으면 어느 해인지 알 수 없다.
        '<td><span class="lead">' + (isMulti() ? ymd(t.start_time).slice(2).replace(/-/g, '.') : md(t.start_time)) +
        '</span> <span class="dim">' + hm(t.start_time) + '</span>' +
        (t.is_manual ? ' <span class="kind">수기</span>' : '') + '</td>' +
        (showWho ? whoCell(t.username) : '') +
        '<td>' + purposeCell(t.purpose) + '</td>' +
        '<td>' + esc(t.plate_no || '—') + '</td>' +
        '<td class="n">' + km(t.distance_km) + '</td>' +
        (opt.compact ? '' : '<td class="n dim">' + n0(t.start_odometer) + ' → ' + n0(t.end_odometer) + '</td>') +
        '<td class="n">' + tollCell(t) + '</td>' +
        (opt.compact ? '' : '<td class="n">' + (t.parking_cost ? n0(t.parking_cost) : '—') + '</td>') +
        '<td class="el" title="' + esc(place) + '">' + esc(place) + '</td></tr>';
    });
    return h + '</tbody></table></div>' + pg.more + '</div>';
  }

  /** 사람·차량·목적·날짜까지만 건 것(검색어·점검 칩은 뺀 것). 칩 숫자를 이 안에서 센다. */
  function baseFiltered() {
    return TRIPS.filter(function (t) {
      if (FILT.who && t.username !== FILT.who) return false;
      if (FILT.car && t.plate_no !== FILT.car) return false;
      if (FILT.purp && (FILT.purp === '-' ? !!(t.purpose || '') : t.purpose !== FILT.purp)) return false;
      return inDateFilter(t.start_time);
    });
  }
  function filtered() {
    var A = audit(), ids = {};
    A.forEach(function (f) { ids[f.k] = {}; (f.rows || []).forEach(function (t) { ids[f.k][t.id] = 1; }); });
    var q = FILT.q.trim().toLowerCase();
    return baseFiltered().filter(function (t) {
      if (q) {
        var s = (t.visit_place || '') + ' ' + (t.end_address || '') + ' ' + (t.start_address || '') +
          ' ' + nameOf(t.username) + ' ' + (t.plate_no || '');
        if (s.toLowerCase().indexOf(q) < 0) return false;
      }
      if (FILT.chip === 'all') return true;
      if (FILT.chip === 'manual') return !!t.is_manual;
      if (FILT.chip === 'commute') return t.purpose === '출퇴근';
      return !!(ids[FILT.chip] && ids[FILT.chip][t.id]);
    });
  }
  /** 지금 걸려 있는 조건을 사람이 읽는 말로(제목·파일 이름·안내에 쓴다). */
  function filterWords() {
    var w = [];
    if (FILT.who) w.push(nameOf(FILT.who));
    if (FILT.car) w.push(FILT.car);
    if (FILT.purp) w.push(FILT.purp === '-' ? '목적 미선택' : FILT.purp);
    var df = dateBounds(), sm = function (s) { return s.slice(5).replace('-', '.'); };
    if (df.from && df.to) w.push(sm(df.from) + '–' + sm(df.to));
    else if (df.from) w.push(sm(df.from) + '부터');
    else if (df.to) w.push(sm(df.to) + '까지');
    return w;
  }

  function viewTrips() {
    if (!LOADED) return head(scopeTitle('운행일지')) + skeleton();
    var A = audit();
    // 칩 숫자는 '지금 걸린 사람·차량·목적·날짜' 안에서 센다(검색어·칩 자신은 빼고).
    var base = baseFiltered();
    var inBase = {}; base.forEach(function (t) { inBase[t.id] = 1; });
    var c = {};
    A.forEach(function (f) {
      c[f.k] = (f.rows || []).filter(function (t) { return inBase[t.id]; }).length;
    });
    var rows = filtered(), t2 = totals(rows, { tripsOnly: true });   // 표에 보이는 운행만의 소계

    // 무엇으로 좁혀 놓았는지 제목에 드러낸다. 그 상태로 CSV 를 누르는 실수를 줄인다.
    var narrowed = filterWords();
    var h = head(scopeTitle('운행일지') + (narrowed.length ? ' — ' + narrowed.join(' · ') : ''),
      esc(viewName()) + ' · ' + esc(viewSpan()) + (isMulti() ? ' · <b>조회 전용</b>' : ''));

    h += '<div class="bar">';
    if (isAll()) {
      // ★ 지금 걸린 사람은 운행이 0건이어도 목록에 남겨야 한다. 안 그러면 셀렉트가
      //   '사람 전체' 로 보이는데 표는 비어 있고, 같은 항목 재선택은 change 가 안 나서
      //   다른 메뉴로 나갔다 오는 수밖에 없었다.
      var seenU = {};
      TRIPS.forEach(function (t) { seenU[t.username] = 1; });
      h += whoSelectHtml(Object.keys(seenU));
    }
    var cars = [];
    TRIPS.forEach(function (t) { if (t.plate_no && cars.indexOf(t.plate_no) < 0) cars.push(t.plate_no); });
    if (FILT.car && cars.indexOf(FILT.car) < 0) cars.push(FILT.car);
    cars.sort();
    h += '<label class="field">' + ic('car', 14) + '<select id="selCar" aria-label="차량"><option value="">차량 전체</option>' +
      cars.map(function (x) {
        return '<option value="' + esc(x) + '"' + (FILT.car === x ? ' selected' : '') + '>' + esc(x) + '</option>';
      }).join('') + '</select></label>';
    h += '<label class="field">' + ic('list', 14) + '<select id="selPurp" aria-label="운행 목적">' +
      [['', '목적 전체']].concat(PURPOSES.map(function (p) { return [p, p]; })).concat([['-', '미선택']]).map(function (p) {
        return '<option value="' + esc(p[0]) + '"' + (FILT.purp === p[0] ? ' selected' : '') + '>' + esc(p[1]) + '</option>';
      }).join('') + '</select></label>';
    h += dateFilterHtml();
    h += '<label class="field">' + ic('search', 14) +
      '<input id="qBox" aria-label="운행 찾기" placeholder="방문처·주소·이름  ( / )" value="' + esc(FILT.q) + '"></label>';
    h += '<div class="sp" style="flex:1"></div>';
    if (!isMulti()) h += '<button class="btn sm" id="btnAddTrip">＋ 운행 추가</button>';
    // 예전 이름은 「엑셀」이었는데 받는 것은 CSV 목록이다. 양식 엑셀(운행기록부)은 정산 화면에 있다.
    h += '<button class="btn sm" id="btnCsv" title="지금 보이는 목록을 CSV 로 받습니다(양식 엑셀은 정산·엑셀 화면)">' +
      ic('dl', 13) + '목록 CSV</button>';
    h += '</div>';

    h += '<div id="belowF"><div class="bar"><div class="seg">' +
      seg('all', '전체', base.length) +
      seg('unk', '통행료 미확정', c.unk, 1) +
      seg('jump', '계기판 튐', c.jump) +
      seg('nopurp', '목적 미선택', c.nopurp) +
      seg('overlap', '시간 겹침', c.overlap) +
      seg('zero', '0km', c.zero) +
      seg('manual', '수기', base.filter(function (t) { return t.is_manual; }).length) +
      seg('commute', '출퇴근', base.filter(function (t) { return t.purpose === '출퇴근'; }).length) +
      '</div></div>';

    h += sect(n0(rows.length) + '건', km(t2.km) + ' km · 업무용 운행분 ' + won(t2.cost) + ' (영수증 제외)', '', tripTable(rows)) + '</div>';
    return h;

    function seg(k, label, n, warnish) {
      // 고른 칩은 건수가 0이어도 남긴다 — 사라지면 왜 표가 비었는지 알 수 없다.
      if (!n && k !== 'all' && FILT.chip !== k) return '';
      return '<button data-chip="' + k + '" aria-pressed="' + (FILT.chip === k ? 'true' : 'false') + '" class="' + (FILT.chip === k ? 'on' : '') +
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

    var h = head(scopeTitle('기록 점검'), esc(viewName()) + ' · 실제로 사고가 났던 유형만 봅니다');

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
      '<b style="color:var(--ink-2)">운행목적 미선택</b> — 업무용으로 안 잡혀 금액이 조용히 0원이 됩니다.<br>' +
      '<b style="color:var(--ink-2)">유류단가 미등록</b> — 기본 단가 159원/km 로 계산돼 실제와 어긋납니다.<br>' +
      '<b style="color:var(--ink-2)">통행료 미확정</b> — 정산에서 0원으로 잡혀 회사가 덜 내주게 됩니다.</div>');
    return h;
  }

  /* ══════════════════ 증빙 ══════════════════ */
  function viewEvid() {
    if (!LOADED) return head(scopeTitle('영수증')) + skeleton();
    var all = evidOfCycle();
    // 전체(관리) 화면은 여러 사람이 섞여 있다 — 잠금은 사람마다 다르므로 줄 단위로 본다.
    var mine = myName();
    var locked = !isAll() && !isMulti() && cycleLocked(mine);
    var h = head(scopeTitle(isAll() ? '영수증' : '영수증·통행료'), esc(viewName()) +
      ' · 앱에서 올린 것과 여기서 올린 것이 함께 모입니다');
    var stepMode = !isAll() && !isMulti();
    var unkMine = stepMode ? ALL_TRIPS.filter(function (t) { return t.username === mine && (t.purpose || '') === BUSINESS && isUnknownToll(t); }).length : 0;
    var byAll = {};
    all.forEach(function (e) { var c = e.category || '기타'; byAll[c] = byAll[c] || { n: 0 }; byAll[c].n++; });
    // 사람이 구분 칸(전체·주차…)을 직접 고르기 전에는 지금 차례의 구분으로 좁혀 보인다.
    if (stepMode && !EVF.touched) EVF.cat = EV_SUBS[evSub()];
    if (stepMode) h += evSubHtml(byAll, unkMine);

    // 스캐너로 뜬 영수증을 올리는 자리. 잠긴 주기는 서버가 막으므로
    // 버튼도 두지 않는다 — 올리게 해 놓고 저장에서 튕기면 안 된다.
    var upBtn = (isMulti() || cycleLocked(mine)) ? '' :
      '<button class="btn pri sm" id="btnEvUp">' + ic('receipt', 13) + '영수증 올리기</button>';

    if (!all.length) {
      return h + (locked
        ? blank('등록된 영수증이 없습니다.', cycleName(CYC.y, CYC.m) + ' — ' + lockWhy(mine) + ' 더 올릴 수 없습니다.', 'receipt')
        : '<div class="panel"><div class="blank"><div class="ico">' + ic('receipt', 21) + '</div>' +
          '<div class="t">등록된 영수증이 없습니다.</div>' +
          '<div class="d">앱에서 올리시거나 여기서 사진·스캔 PDF 를 올리시면 여기에 모입니다.<br>' +
          'A4 에 여러 장 붙여 스캔한 것도 그대로 올리면 됩니다.</div>' +
          '<div style="margin-top:16px"><button class="btn pri" id="btnEvUp">' + ic('receipt', 14) +
          '영수증 올리기</button></div></div></div>');
    }

    // ── 합계: 정산에 들어가는 것(주차·통행료)과 참고(주유)를 나눈다 ──
    //   예전에는 주유·계기판까지 한 숫자로 더해 "영수증 합계"라고 보여 줘서
    //   그 금액이 전부 정산되는 것처럼 읽혔다. 주유비는 거리×단가로 따로 계산한다.
    var by = {};
    all.forEach(function (e) {
      var c = e.category || '기타';
      by[c] = by[c] || { n: 0, sum: 0 };
      by[c].n++; by[c].sum += Number(e.amount) || 0;
    });
    var settle = ((by['주차'] || {}).sum || 0) + ((by['통행료'] || {}).sum || 0);
    var fct = function (k, v, sub) {
      return '<div class="fact"><div class="k">' + esc(k) + '</div><div class="v">' + v +
        '</div><div class="sub">' + esc(sub || '') + '</div></div>';
    };
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>정산에 들어가는 영수증</div>' +
      '<p class="verdict">' + won(settle) + '</p><div class="facts">' +
      fct('주차', won((by['주차'] || {}).sum || 0), n0((by['주차'] || {}).n || 0) + '건 · 정산에 더해집니다') +
      fct('통행료', won((by['통행료'] || {}).sum || 0), n0((by['통행료'] || {}).n || 0) + '건 · 정산에 더해집니다') +
      fct('주유', won((by['주유'] || {}).sum || 0), n0((by['주유'] || {}).n || 0) + '건 · 증빙용(유류비는 거리×단가)') +
      fct('계기판', n0((by['계기판'] || {}).n || 0) + '<small>장</small>', '운행 계기판 확인용') +
      '</div></div>';

    if (locked) h += '<div class="hpnote">' + ic('check', 16) + '<span><b>' + esc(lockTitle(mine)) +
      '.</b> 영수증을 더 올리거나 지울 수 없습니다. ' + lockHow(mine) + '</span></div>';

    // ── 좁히기: 구분 · 날짜 · 사람 ──
    var cats = ['all', '주차', '통행료', '주유', '계기판'];
    Object.keys(by).forEach(function (c) { if (cats.indexOf(c) < 0) cats.push(c); });
    var rows = all.filter(function (e) {
      if (EVF.cat !== 'all' && (e.category || '기타') !== EVF.cat) return false;
      if (isAll() && FILT.who && e.username !== FILT.who) return false;
      return inDateFilter(e.date_millis);
    });
    rows = sortRows(rows, "ev", {
      date: function (e) { return Number(e.date_millis); },
      who: function (e) { var p = orgPath(e.username); return p.div + '|' + p.team + '|' + p.unit + '|' + nameOf(e.username); },
      cat: function (e) { return e.category || ''; },
      amount: function (e) { return Number(e.amount) || 0; }
    }, 'date', -1);

    var bar = '<div class="fbar"><div class="seg">' + cats.map(function (c) {
      var n = c === 'all' ? all.length : (by[c] || {}).n || 0;
      return '<button class="' + (EVF.cat === c ? 'on' : '') + '" aria-pressed="' + (EVF.cat === c ? 'true' : 'false') +
        '" data-evcat="' + esc(c) + '">' +
        esc(c === 'all' ? '전체' : c) + ' <span class="c">' + n0(n) + '</span></button>';
    }).join('') + '</div>' + dateFilterHtml() +
      (isAll() ? whoSelectHtml(all.map(function (e) { return e.username; })) : '') + '</div>';

    var sumShown = rows.reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0);
    // 날짜 칸을 치는 동안 입력 칸을 갈아 끼우지 않게, 날짜에 따라 바뀌는 곳(건수 · 표)만 따로 표시해 둔다(paintBelow).
    h += sect('내역', '<span data-live="evcnt">' + (rows.length === all.length ? rows.length + '건' : rows.length + ' / ' + all.length + '건') + '</span>', upBtn,
      bar + '<div id="belowF">' + (rows.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      thSort('날짜', 'date', 'ev', -1) + (isAll() ? thSort('소속 · 이름', 'who', 'ev', 1) : '') +
      thSort('구분', 'cat', 'ev', 1) + '<th>차량</th>' +
      thSort('금액', 'amount', 'ev', -1, true) + '<th>메모</th><th></th></tr></thead><tbody>' +
      rows.map(function (e) {
        var canDel = e.username === mine && !evLocked(e);
        return '<tr><td><span class="lead">' + md(e.date_millis) + '</span></td>' +
          (isAll() ? whoCell(e.username) : '') +
          '<td><span class="kind">' + esc(e.category || '기타') + '</span></td>' +
          '<td class="dim">' + esc(e.vehicle_plate || '—') + '</td>' +
          '<td class="n total">' + n0(e.amount) + '</td>' +
          '<td class="el" title="' + esc(e.memo || '') + '">' + esc(e.memo || '') + '</td>' +
          '<td class="n" style="white-space:nowrap">' + (e.photo_path
            ? '<a class="btn sm" target="_blank" rel="noopener" href="' + esc(photoUrl(e.photo_path)) + '">사진</a>'
            : '<span class="dim" style="font-size:11.5px">사진 없음</span>') +
          (e.scan_path ? ' <a class="btn sm" target="_blank" rel="noopener" title="스캔한 A4 원본" href="' +
            esc(photoUrl(e.scan_path)) + '">원본</a>' : '') +
          // 잘못 올린 것을 못 지우면 정산 금액이 부풀어 오른 채로 남는다.
          (canDel ? ' <button class="btn sm" data-evdel="' + esc(e.id) + '">지우기</button>' : '') +
          '</td></tr>';
      }).join('') + '</tbody><tfoot><tr><td colspan="' + (isAll() ? 4 : 3) + '">보이는 ' + n0(rows.length) +
      '건 합계</td><td class="n total">' + n0(sumShown) + '</td><td colspan="2"></td></tr></tfoot></table></div></div>'
        : '<div class="panel"><div class="blank"><div class="t">조건에 맞는 영수증이 없습니다.</div>' +
          '<div style="margin-top:12px"><button class="btn sm" data-fclear>조건 지우기</button></div></div></div>') + '</div>');
    return h;
  }
  /** 증빙 화면의 좁히기 상태(구분). 날짜는 DATEF, 정렬은 SORTS.ev 를 쓴다. */
  var EVF = { cat: 'all' };
  function photoUrl(path) {
    return SB + '/storage/v1/object/public/evidence/' + String(path).split('/').map(encodeURIComponent).join('/');
  }


  /* ══════════════════ 증빙 올리기 ══════════════════
     스캐너가 뱉는 것은 대개 PDF 인데, 영수증은 결재 서류에 <img> 로 그대로
     박히므로 PDF 를 그냥 저장하면 그 자리가 빈다. 그래서 **올리는 시점에
     장마다 JPEG 로 바꿔서** 저장한다(vendor/pdf.min.js · Mozilla · Apache-2.0).

     ★ pdf.js 워커는 반드시 같은 출처여야 한다.
       cdnjs 에서 바로 부르면 브라우저가 교차출처 Worker 를 막고 메인 스레드
       폴백으로 넘어간다. vendor/ 에 직접 두는 이유다.
     ★ 탭을 다른 데로 옮기면 렌더가 멈춘다(브라우저가 숨은 탭의 rAF 를 멈춘다).
       돌아오면 이어서 돈다 — 그래서 진행 상황을 글로 보여 준다. */
  /* pages = 올린 장(사진 한 장 또는 PDF 한 쪽) · items = 영수증 줄. 한 장에 줄이 여럿일 수 있다
     (A4 에 여러 장 붙여 스캔한 경우). 줄마다 it.page 로 자기 장을 가리킨다.                  */
  var EVUP = { busy: false, items: [], pages: [], sent: false };
  /** 서버로 올리는 중인가. EVUP 은 창을 열 때마다 새 객체가 되므로 따로 둔다 — 올리는 중에 창을 다시 열면 안 된다. */
  var EV_SENDING = false;
  /** AI 판독을 쓸 수 있는가(서버에 키가 있는가). 한 번 물어보고 기억한다. */
  var AI_ON = null;
  function askAi() {
    if (AI_ON != null) return Promise.resolve(AI_ON);
    return apiRetry('/functions/v1/driving-verify', { method: 'POST', body: JSON.stringify({ op: 'status' }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { AI_ON = !!(j && j.ai); return AI_ON; })
      .catch(function () { return false; });
  }
  function evFreeUrls() {
    EVUP.pages.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); });
    EVUP.items.forEach(function (it) { if (it.crop && it.crop.url) URL.revokeObjectURL(it.crop.url); });
  }

  /** Gemini 반짝임(같은 색감의 모양 — 공식 로고 파일 아님). 그라데이션 id 는 부를 때마다 새로. */
  var GEMSVG_N = 0;
  function gemSvg(size, cls) {
    var id = 'gsv' + (++GEMSVG_N);
    return '<svg class="gemico' + (cls ? ' ' + cls : '') + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4C8DF6"/>' +
      '<stop offset=".55" stop-color="#9B72CB"/><stop offset="1" stop-color="#D96570"/></linearGradient></defs>' +
      '<path fill="url(#' + id + ')" d="M12 1.5c.6 5.6 4.9 9.9 10.5 10.5-5.6.6-9.9 4.9-10.5 10.5C11.4 16.9 7.1 12.6 1.5 12 7.1 11.4 11.4 7.1 12 1.5z"/></svg>';
  }
  function gemTag(t) { return '<span class="gem">' + gemSvg(12) + esc(t || 'Gemini') + '</span>'; }
  function openEvUpload(defCat) {
    if (isMulti()) { toast('영수증은 한 주기씩 올립니다. 위 기간에서 주기를 하나 골라 주세요.', true); return; }
    if (cycleLocked(myName())) { toast(lockWhy(myName()) + ' 이 주기에는 올릴 수 없습니다.', true); return; }
    // 올리는 중에 뒤로가기로 창이 닫혔을 수 있다. 그 사이 새 창을 열면 돌고 있는 올리기가 새 목록을 건드린다.
    if (EV_SENDING) { toast('앞서 누른 영수증을 아직 올리는 중입니다. 끝난 뒤 다시 열어 주세요.'); return; }
    evFreeUrls();
    EVUP = { busy: false, items: [], pages: [], sent: false, defCat: EV_CATS.indexOf(defCat) >= 0 ? defCat : '' };
    var r = cycleRange(CYC.y, CYC.m);
    var my = personOf(myName());
    var cars = myPlates();
    $('pTitle').textContent = '영수증 올리기';
    $('pSub').textContent = cycleName(CYC.y, CYC.m) + ' · ' + cycleSpan(CYC.y, CYC.m);
    $('pBody').innerHTML =
      '<div class="drop gemdrop" id="evDrop" style="margin:0 0 14px">' +
      '<div class="gemorb">' + gemSvg(28) + '</div>' +
      '<div class="gemchip">' + gemSvg(12) + 'Gemini AI 판독</div>' +
      '<div class="dt">영수증을 올리면 <b class="gemtxt">Gemini</b> 가 구분·날짜·금액을 읽어 드립니다</div>' +
      '<div class="dd">JPG · PNG · PDF · 여러 장도 됩니다. PC 에서는 여기에 끌어다 놓아도 됩니다<br>' +
      '<b>A4 에 여러 장 붙여 스캔한 것도 그대로</b> 올리세요 — 영수증마다 한 줄씩 나눠 적습니다</div>' +
      '<label class="btn" style="margin-top:14px">파일 고르기' +
      '<input type="file" id="evFile" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" multiple class="sr"></label>' +
      '</div>' +
      '<div class="form" style="margin-top:0"><div class="frow">' +
      '<label class="flab" for="evCar">차량</label><div class="fbody">' +
      (cars.length
        ? '<select class="inp" id="evCar" style="max-width:200px">' +
          cars.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('') + '</select>'
        : '<input class="inp" id="evCar" style="max-width:200px" placeholder="예) 12가3456" value="' +
          esc(my.plate_no || '') + '">') +
      '<div class="fhint">올리는 것 전부에 같이 붙습니다</div></div></div></div>' +
      '<div id="evList"></div>' +
      '<div id="evNote" class="fhint" style="margin-top:10px"></div>' +
      '<div id="evAiNote" class="fhint"></div>';
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn" id="evFill" hidden>빈 칸에 첫 줄 구분·날짜 넣기</button>' +
      '<button class="btn pri" id="btnEvGo" disabled>올리기</button>';
    $('panel').classList.add('open');
    $('panel').classList.add('wide');          // 줄마다 사진·구분·날짜·금액·메모가 들어간다 — 좁으면 표가 잘린다
    EVUP.lo = r.lo; EVUP.hi = r.hi;
    bindDrop($('evDrop'), evAddFiles);
    askAi().then(function (on) {
      var el = $('evAiNote');
      if (el) el.innerHTML = on
        ? gemTag('Gemini AI') + ' 가 사진에서 <b>구분·날짜·금액</b>을 읽어 미리 채워 드립니다. 틀릴 수 있으니 <b>올리기 전에 꼭 확인</b>해 주세요.'
        : 'AI 판독이 꺼져 있어 구분·날짜·금액을 직접 넣습니다. 한 장에 영수증이 여럿이면 줄 끝의 <b>＋</b> 로 줄을 늘리세요.';
    });
  }

  /** 내가 이번 주기에 쓴 차량 번호. 없으면 등록 차량. */
  function myPlates() {
    var mine = myName(), seen = {};
    ALL_TRIPS.forEach(function (t) { if (t.username === mine && t.plate_no) seen[t.plate_no] = (seen[t.plate_no] || 0) + 1; });
    VEHICLES.forEach(function (v) { if (v.username === mine && v.plate_no && !seen[v.plate_no]) seen[v.plate_no] = 0; });
    // ★ 많이 몬 차가 맨 앞(= 올리기 창의 기본값). 예전에는 가나다순이라, 차를 두 대 등록한 사람이
    //   손대지 않으면 안 몬 차 번호로 영수증이 저장됐다 — 그러면 기록부의 그 차 장에 안 붙는다.
    return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || a.localeCompare(b); });
  }

  function evNote(msg) { var el = $('evNote'); if (el) el.innerHTML = msg; }

  /** pdf.js(4.10.38, ESM)를 쓸 때만 불러온다. 워커는 같은 출처여야 한다.
   *  3.11 은 CVE-2024-4367(악성 PDF 의 폰트로 JS 실행)에 걸려 올렸다. */
  function loadPdfJs() {
    if (window.__pdfjs) return window.__pdfjs;
    // import() 는 'vendor/…' 같은 상대 지정자를 못 푼다("Failed to resolve module
    // specifier") — 문서 기준 절대 URL 로 만들어 넘긴다. 워커도 같은 방식.
    var base = function (p) { return new URL(p, document.baseURI).href; };
    window.__pdfjs = new Function('u', 'return import(u)')(base('vendor/pdf.min.mjs'))
      .then(function (m) {
        m.GlobalWorkerOptions.workerSrc = base('vendor/pdf.worker.min.mjs');
        return m;
      }, function (e) { console.error('pdf.js 로드 실패:', e); window.__pdfjs = null; throw new Error('pdfjs'); });
    return window.__pdfjs;
  }

  function canvasToJpeg(cv) {
    return new Promise(function (ok) { cv.toBlob(function (b) { ok(b); }, 'image/jpeg', 0.88); });
  }

  /** 파일 하나 → JPEG Blob 목록. PDF 는 장마다, 사진은 한 장(크면 줄여서). */
  function fileToJpegs(file, onStep) {
    var isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
    if (!isPdf) return shrinkImage(file).then(function (b) { return [b]; });
    return loadPdfJs().then(function (pdfjs) {
      return file.arrayBuffer().then(function (buf) {
        // isEvalSupported:false — 폰트 글리프를 new Function 으로 컴파일하지 않는다.
        // 메일로 받은 영수증 PDF 는 '외부 파일' 이다(CVE-2024-4367 의 완화책).
        return pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
      });
    }).then(function (doc) {
      if (doc.numPages > 30) { doc.destroy(); throw new Error('toomany'); }
      var out = [], chain = Promise.resolve();
      for (var i = 1; i <= doc.numPages; i++) {
        (function (n) {
          chain = chain.then(function () {
            if (onStep) onStep(n, doc.numPages);
            return doc.getPage(n).then(function (page) {
              // 영수증 글씨가 읽혀야 하므로 가로 1600px 쯤으로 맞춘다.
              var v1 = page.getViewport({ scale: 1 });
              var sc = Math.min(3, Math.max(1, 1600 / v1.width));
              var vp = page.getViewport({ scale: sc });
              var cv = document.createElement('canvas');
              cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
              var cx = cv.getContext('2d');
              cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
              return page.render({ canvasContext: cx, viewport: vp }).promise
                .then(function () { return canvasToJpeg(cv); })
                .then(function (b) { out.push(b); });
            });
          });
        })(i);
      }
      return chain.then(function () { doc.destroy(); return out; },
        function (e) { doc.destroy(); throw e; });
    });
  }

  function shrinkImage(file) {
    return new Promise(function (ok, no) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var max = 2000;
        // JPEG 이 아니면 크기와 무관하게 캔버스를 거쳐 JPEG 으로 만든다 — 경로도 헤더도 .jpg 다.
        if (file.type === 'image/jpeg' && img.width <= max && img.height <= max && file.size <= 4e6) {
          ok(file); return;
        }
        var sc = Math.min(1, max / Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
        var cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
        cx.drawImage(img, 0, 0, cv.width, cv.height);
        canvasToJpeg(cv).then(ok);
      };
      img.onerror = function () { URL.revokeObjectURL(url); no(new Error('image')); };
      img.src = url;
    });
  }

  var EV_CATS = ['주유', '주차', '통행료', '계기판'];
  var KIND_CAT = { fuel: '주유', parking: '주차', toll: '통행료', odometer: '계기판' };

  /** 고른 파일들을 장(page)으로 만들고, 장마다 줄을 하나 놓는다. PDF 는 쪽마다 한 장. */
  function evAddFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length || EVUP.busy) return;
    var tooBig = list.filter(function (f) { return f.size > 30e6; });
    if (tooBig.length) { evNote('<b style="color:var(--red)">30MB 가 넘는 파일이 있습니다: ' +
      esc(tooBig[0].name) + '</b>'); return; }

    evRead();                      // ★ 다시 그리기 전에 쳐 둔 값을 지킨다(안 부르면 금액이 다 날아갔다)
    EVUP.busy = true;
    // 읽는 중에 창을 닫았다 다시 열면 EVUP 이 새 객체가 된다 — 옛 읽기가 새 목록에 장을 끼워 넣지 않게 붙잡아 둔다.
    var session = EVUP;
    var live = function () { return EVUP === session; };
    var fresh = [];                // 이번에 새로 들어온 장
    var chain = Promise.resolve();
    list.forEach(function (file) {
      chain = chain.then(function () {
        if (!live()) return;
        evNote('<b>' + esc(file.name) + '</b> 읽는 중…');
        return fileToJpegs(file, function (n, total) {
          if (!live()) return;
          evNote('<b>' + esc(file.name) + '</b> ' + n + ' / ' + total + '쪽 바꾸는 중…' +
            (total > 3 ? ' <span class="dim">(다른 탭으로 가시면 잠시 멈추고, 돌아오시면 이어집니다)</span>' : ''));
        }).then(function (blobs) {
          if (!live()) return;
          blobs.forEach(function (b, i) {
            var pi = EVUP.pages.length;
            EVUP.pages.push({
              blob: b, url: URL.createObjectURL(b), ai: '',
              name: file.name + (blobs.length > 1 ? ' (' + (i + 1) + '/' + blobs.length + '쪽)' : '')
            });
            EVUP.items.push(evBlankItem(pi));
            fresh.push(pi);
          });
        });
      });
    });
    chain.then(function () {
      session.busy = false;
      if (!live()) return;
      evNote(''); paintEvList();
      return askAi().then(function (on) { if (on && fresh.length && live()) evScanPages(fresh); });
    }).catch(function (e) {
      session.busy = false;
      if (!live()) return;
      paintEvList();
      var m = String((e && e.message) || '');
      evNote('<b style="color:var(--red)">' + esc(
        m === 'pdfjs' ? 'PDF 를 읽는 도구를 불러오지 못했습니다. 사진으로 올려 주세요.'
          : m === 'toomany' ? 'PDF 가 30장을 넘습니다. 나눠서 올려 주세요.'
            : m === 'image' ? '이미지를 읽지 못했습니다. 다른 파일로 해 보세요.'
              : '읽지 못했습니다: ' + m) + '</b>');
    });
  }
  /** 빈 줄 하나. 날짜는 오늘(보는 주기 밖이면 주기 안으로 당긴다 — 미래 주기를 보며 올리면 전부 튕겼다).
   *  ★ 구분은 비워 둔다. 예전 기본값 '주유' 는 주차 영수증을 안 바꾸고 올리면 정산에서 빠지게 했다. */
  function evBlankItem(pi) {
    return { page: pi, cat: EVUP.defCat || '', amt: '', memo: '', hint: '', crop: null, ai: false,
      date: ymd(Math.max(EVUP.lo, Math.min(Date.now(), EVUP.hi - 1))) };
  }

  function blobToB64(blob) {
    return new Promise(function (ok, no) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result || ''); ok(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = function () { no(new Error('read')); };
      fr.readAsDataURL(blob);
    });
  }
  /** 장에서 영수증 한 건이 있는 자리만 오려 낸다. box = [ymin, xmin, ymax, xmax] (0~1000). 가장자리에 여유를 둔다. */
  function evCrop(pageUrl, box) {
    return new Promise(function (ok) {
      var img = new Image();
      img.onload = function () {
        var W = img.naturalWidth, H = img.naturalHeight, pad = 0.025;
        var x0 = Math.max(0, (box[1] / 1000 - pad) * W), y0 = Math.max(0, (box[0] / 1000 - pad) * H);
        var x1 = Math.min(W, (box[3] / 1000 + pad) * W), y1 = Math.min(H, (box[2] / 1000 + pad) * H);
        var w = Math.round(x1 - x0), h = Math.round(y1 - y0);
        if (w < 40 || h < 40) { ok(null); return; }
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
        cx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
        cv.toBlob(function (b) { ok(b ? { blob: b, url: URL.createObjectURL(b) } : null); }, 'image/jpeg', 0.9);
      };
      img.onerror = function () { ok(null); };
      img.src = pageUrl;
    });
  }
  /**
   * 새로 들어온 장들을 AI 에게 한 장씩 보여 주고, 찾은 영수증마다 줄을 만든다.
   * AI 가 못 읽거나 서버가 막으면 그 장은 그냥 손으로 넣는 줄로 남는다(올리기를 막지 않는다).
   */
  function evScanPages(idxs) {
    var session = EVUP;            // 창을 닫았다 다시 열면 EVUP 이 새 객체가 된다 — 옛 응답은 버린다
    idxs.forEach(function (pi) { if (EVUP.pages[pi]) EVUP.pages[pi].ai = 'run'; });
    evRead(); paintEvList();
    var stop = false, swapped = false;
    return idxs.reduce(function (chain, pi) {
      return chain.then(function () {
        var pg = session.pages[pi];
        if (EVUP !== session || !pg || pg.ai !== 'run') return;
        if (stop) { pg.ai = ''; return; }
        return blobToB64(pg.blob).then(function (b64) {
          return apiRetry('/functions/v1/driving-verify', { method: 'POST', body: JSON.stringify({ op: 'scan', image: b64 }) });
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok || !j || j.error) {
              // 하루 상한·AI 한도에 닿으면 남은 장은 더 보내지 않는다.
              if (r.status === 429) stop = true;
              throw new Error((j && j.error) || ('HTTP ' + r.status));
            }
            return j.receipts || [];
          });
        }).then(function (recs) {
          if (EVUP !== session || pg.ai !== 'run') return;
          recs = recs.filter(function (x) { return x && x.kind !== 'unreadable' || recs.length === 1; });
          if (!recs.length) { pg.ai = 'none'; return; }
          var many = recs.length > 1;
          return Promise.all(recs.map(function (x) {
            return (many && x.box_2d) ? evCrop(pg.url, x.box_2d) : Promise.resolve(null);
          })).then(function (crops) {
            if (EVUP !== session || pg.ai !== 'run') return;
            evRead();
            var rows = recs.map(function (x, k) {
              var it = evBlankItem(pi);
              it.ai = true; it.crop = crops[k];
              it.cat = KIND_CAT[x.kind] || EVUP.defCat || '';
              var hint = [];
              if (x.merchant) { it.memo = String(x.merchant).slice(0, 60); }
              if (x.date) {
                var ms = Date.parse(x.date + 'T00:00:00+09:00');
                if (isFinite(ms) && ms >= EVUP.lo && ms < EVUP.hi) it.date = x.date;
                else {
                  // ★ 기본 날짜(오늘)로 두면 8월 영수증이 10월분 정산에 그대로 들어간다. 비워서 사람이 정하게 한다.
                  it.date = '';
                  hint.push('사진의 날짜가 ' + x.date + ' 입니다 — ' + cycleName(CYC.y, CYC.m) + '(' + cycleSpan(CYC.y, CYC.m) +
                    ') 영수증이 아니면 이 줄을 빼 주세요');
                }
              } else { it.date = ''; hint.push('날짜를 읽지 못했습니다 — 직접 넣어 주세요'); }
              if (x.kind === 'odometer') {
                if (x.odometer_km != null) hint.push('계기판 ' + n0(x.odometer_km) + ' km');
              } else if (x.amount != null) it.amt = String(x.amount);
              else hint.push('금액을 읽지 못했습니다');
              if (x.legible === false) hint.push('글자가 흐립니다 — 직접 확인해 주세요');
              it.hint = hint.join(' · ');
              return it;
            });
            // 이 장의 (손대지 못하게 막아 둔) 빈 줄을 AI 가 찾은 줄들로 바꾼다.
            var at = -1;
            session.items = session.items.filter(function (it, i) {
              if (it.page === pi) { if (at < 0) at = i; return false; }
              return true;
            });
            Array.prototype.splice.apply(session.items, [at < 0 ? session.items.length : at, 0].concat(rows));
            pg.ai = 'done';
            swapped = true;
          });
        }).catch(function (e) {
          if (EVUP !== session) return;
          pg.ai = 'fail';
          console.error('AI 판독 실패:', e && e.message);
          evNote('<span class="dim">AI 가 읽지 못한 장이 있습니다(' + esc(String((e && e.message) || '').slice(0, 60)) +
            '). 그 줄은 직접 넣어 주세요.</span>');
        }).then(function () {
          if (EVUP !== session) return;
          // ★ 줄을 갈아 끼웠으면 evRead 를 부르지 않는다 — 화면은 아직 옛 줄 번호라, 뒤 줄의 값이
          //   앞으로 당겨진 줄에 덮어써진다(검증로봇 재현: 통행료 2,000원 줄이 다른 파일 값으로 바뀜).
          if (!swapped) evRead();
          swapped = false;
          paintEvList();
        });
      });
    }, Promise.resolve()).then(function () {
      // 한도에 닿아 건너뛴 장이 '읽는 중'으로 남지 않게 마지막에 한 번 더 그린다.
      if (EVUP === session) { evRead(); paintEvList(); }
    });
  }

  /** 지금 표에 쳐 넣은 값을 EVUP.items 에 담는다(다시 그리기 전에 부른다). */
  function evRead() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-evrow]'), function (tr) {
      var i = +tr.dataset.evrow, it = EVUP.items[i];
      if (!it) return;
      var g = function (sel) { var el = tr.querySelector(sel); return el ? el.value : null; };
      var c = g('[data-evcatsel]'); if (c != null) it.cat = c;
      var d = g('[data-evdate]'); if (d != null) it.date = d;
      var a = g('[data-evamt]'); if (a != null) it.amt = String(a).replace(/[^\d]/g, '');
      var m = g('[data-evmemo]'); if (m != null) it.memo = m;
    });
  }

  function paintEvList() {
    var box = $('evList'); if (!box) return;
    var n = EVUP.items.length;
    var running = EVUP.pages.filter(function (p) { return p.ai === 'run'; }).length;
    var b = $('btnEvGo'), f = $('evFill');
    if (!n) {
      box.innerHTML = '';
      if (b) { b.disabled = true; b.classList.remove('gembtn', 'running'); b.textContent = '올리기'; }
      if (f) f.hidden = true;
      return;
    }
    // 장마다 몇 번째 장인지(①②…) — 같은 장에서 나온 줄이 한눈에 묶여 보이게.
    var perPage = {};
    EVUP.items.forEach(function (it) { perPage[it.page] = (perPage[it.page] || 0) + 1; });
    var pageNo = {}, seq = 0;
    EVUP.items.forEach(function (it) { if (pageNo[it.page] == null) pageNo[it.page] = ++seq; });
    var prevPage = -1;

    box.innerHTML = '<div class="panel"><div class="scroll" data-rows style="max-height:46vh">' +
      '<table class="evup"><thead><tr><th style="width:64px">사진</th><th>구분</th><th>날짜</th>' +
      '<th class="n">금액</th><th>메모</th><th></th></tr></thead><tbody>' +
      EVUP.items.map(function (it, i) {
        var pg = EVUP.pages[it.page] || {}, first = it.page !== prevPage;
        prevPage = it.page;
        var src = (it.crop && it.crop.url) || pg.url;
        var thumb = '<a href="' + src + '" target="_blank" rel="noopener" aria-label="' + (i + 1) + '번째 줄 사진 크게 보기" title="크게 보기 — ' + esc(pg.name || '') + '">' +
          '<img src="' + src + '" alt=""></a>' +
          (perPage[it.page] > 1 ? '<span class="pgno" title="같은 장에서 나온 영수증">' + pageNo[it.page] + '장</span>' : '');
        if (pg.ai === 'run') {
          return '<tr data-evrow="' + i + '" class="evwait' + (first ? ' pgfirst' : '') + '"><td class="evth">' + thumb + '</td>' +
            '<td colspan="4"><div class="gemread">' + gemSvg(16, 'spinning') + '<span><b class="gemtxt">Gemini</b> 가 이 장에서 영수증을 읽는 중…</span>' +
            '<i class="gemshim"></i><i class="gemshim s2"></i></div></td>' +
            '<td class="n"><button class="btn sm" data-evskip="' + it.page + '">직접 입력</button></td></tr>';
        }
        return '<tr data-evrow="' + i + '" class="' + (first ? 'pgfirst' : '') + (it.ai ? ' evai' : '') + '">' +
          '<td class="evth">' + thumb + '</td>' +
          '<td><select class="inp' + (it.cat ? '' : ' need') + '" data-evcatsel style="width:108px" aria-label="' + (i + 1) + '번째 구분">' +
          '<option value="">구분 고르기</option>' +
          EV_CATS.map(function (c) {
            return '<option value="' + c + '"' + (it.cat === c ? ' selected' : '') + '>' + c + '</option>';
          }).join('') + '</select></td>' +
          '<td><input class="inp' + (it.date ? '' : ' need') + '" type="date" data-evdate style="width:148px" value="' + esc(it.date) +
          '" min="' + ymd(EVUP.lo) + '" max="' + ymd(EVUP.hi - 1) + '" aria-label="' + (i + 1) + '번째 날짜"></td>' +
          '<td class="n"><input class="inp num" data-evamt inputmode="numeric" style="width:100px" ' +
          'placeholder="원" aria-label="' + (i + 1) + '번째 금액" value="' + esc(it.amt ? n0(it.amt) : '') + '"></td>' +
          '<td><input class="inp" data-evmemo maxlength="60" style="width:100%" placeholder="선택" value="' +
          esc(it.memo) + '" aria-label="' + (i + 1) + '번째 메모">' +
          (it.hint ? '<div class="evhint">' + (it.ai ? gemTag() + ' ' : '') + esc(it.hint) + '</div>'
            : (it.ai ? '<div class="evhint ok">' + gemTag() + ' 가 채웠습니다 — 사진과 맞는지 확인해 주세요</div>' : '')) + '</td>' +
          '<td class="n" style="white-space:nowrap">' +
          '<button class="btn sm" data-evadd="' + i + '" title="이 장에 영수증이 더 있으면 줄을 늘립니다" aria-label="같은 장에 줄 추가">＋</button> ' +
          '<button class="btn sm" data-evrm="' + i + '">빼기</button></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div style="padding:10px 14px;font-size:12px;color:var(--ink-3)">' +
      n0(EVUP.pages.filter(function (p, pi) { return perPage[pi]; }).length) + '장 · 영수증 ' + n0(n) + '건' +
      (running ? ' · <b class="gemtxt">Gemini 가 ' + n0(running) + '장을 읽는 중</b>' : '') + '</div></div>';
    if (b) {
      b.disabled = running > 0;
      // 읽는 동안은 Gemini 색으로 돌며 빛이 지나간다(검증 버튼과 같은 모양).
      b.classList.toggle('gembtn', running > 0); b.classList.toggle('running', running > 0);
      b.innerHTML = running ? gemSvg(16) + '<span class="gl">Gemini 가 읽는 중…</span>' : esc(n0(n) + '건 올리기');
    }
    // 채울 빈 칸이 있을 때만 보인다.
    if (f) f.hidden = n < 2 || running > 0 || !EVUP.items.some(function (x, i) { return i && (!x.cat || (!x.date && !x.ai)); });
  }

  function runEvUpload() {
    if (EVUP.busy) { toast('아직 파일을 읽는 중입니다. 잠시만 기다려 주세요.'); return; }
    if (EVUP.pages.some(function (p) { return p.ai === 'run'; })) { toast('AI 가 아직 읽는 중입니다. 기다리거나 「직접 입력」을 눌러 주세요.'); return; }
    if (!EVUP.items.length) { toast('올릴 파일을 골라 주세요.', true); return; }
    evRead();
    var car = String(($('evCar') || {}).value || '').trim();
    var mine = myName();

    // 다 보내기 전에 값을 먼저 본다 — 절반 올리고 튕기면 수습이 어렵다.
    for (var i = 0; i < EVUP.items.length; i++) {
      var it = EVUP.items[i];
      var bad = function (msg, sel) {
        toast((i + 1) + '번째 줄' + msg, true);
        var el = document.querySelector('[data-evrow="' + i + '"] ' + sel);
        if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
      };
      if (EV_CATS.indexOf(it.cat) < 0) { bad('의 구분을 골라 주세요.', '[data-evcatsel]'); return; }
      var ms = Date.parse(it.date + 'T00:00:00+09:00');
      if (!isFinite(ms)) { bad('의 날짜를 골라 주세요.', '[data-evdate]'); return; }
      if (ms < EVUP.lo || ms >= EVUP.hi) {
        bad(' 날짜가 ' + cycleName(CYC.y, CYC.m) + '(' + cycleSpan(CYC.y, CYC.m) + ') 밖입니다.', '[data-evdate]'); return;
      }
      var amt = Number(it.amt || 0);
      if (!isFinite(amt) || amt < 0 || amt > 5000000) { bad('의 금액이 범위를 벗어났습니다.', '[data-evamt]'); return; }
      if (!amt && it.cat !== '계기판') { bad('의 금액을 넣어 주세요. 계기판 사진만 0원이어도 됩니다.', '[data-evamt]'); return; }
      it.ms = ms; it.amtN = Math.round(amt);
    }

    EVUP.busy = true; EV_SENDING = true;
    var btn = $('btnEvGo'); if (btn) { btn.disabled = true; btn.textContent = '올리는 중…'; }
    var total = EVUP.items.length, done = 0;
    var base = Date.now();
    // 한 장에 영수증이 둘 이상이면 그 장(A4 원본)을 따로 한 번 올리고, 줄마다 scan_path 로 가리킨다.
    // 결재 문서에는 원본 한 장이 통째로 실린다.
    var perPage = {};
    EVUP.items.forEach(function (x) { perPage[x.page] = (perPage[x.page] || 0) + 1; });
    EVUP.pages.forEach(function (p, pi) { if (perPage[pi] > 1) p.multi = true; });
    var upload = function (path, blob, label) {
      return apiRetry('/storage/v1/object/evidence/' + path, {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob
      }).then(function (up) {
        if (!up.ok) return up.text().then(function (t) { throw new Error(label + ': ' + (t || up.status)); });
      });
    };

    EVUP.items.reduce(function (chain, it, i) {
      return chain.then(function () {
        evNote((done + 1) + ' / ' + total + '건 올리는 중…');
        var pg = EVUP.pages[it.page];
        var key = base + i;                        // client_key(bigint) · 경로에도 쓴다
        var path = mine + '/' + key + '.jpg';
        var scanP = Promise.resolve();
        if (pg.multi && !pg.scanPath) {
          var sp = mine + '/scan/' + key + '.jpg';
          scanP = upload(sp, pg.blob, (i + 1) + '번째 원본').then(function () { pg.scanPath = sp; });
        }
        return scanP.then(function () {
          return upload(path, (it.crop && it.crop.blob) || pg.blob, (i + 1) + '번째 파일');
        }).then(function () {
          return apiRetry('/rest/v1/evidences', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              username: mine, client_key: key, vehicle_plate: car,
              date_millis: it.ms, category: it.cat, amount: it.amtN,
              // ★ captured_at 을 0 으로 두면 앱의 사진 정리(cleanupEvidenceServer,
              //   captured_at < cutoff)가 웹에서 올린 사진을 다음 동기화에 바로 지운다.
              memo: it.memo, captured_at: Date.now(), photo_path: path,
              scan_path: pg.multi ? pg.scanPath : null
            })
          }).then(function (ins) {
            if (!ins.ok) return ins.text().then(function (t) {
              // 파일만 올라간 채로 두지 않는다(다시 누르면 새 키로 또 올라가 파일이 둘이 된다).
              return apiRetry('/storage/v1/object/evidence/' + path, { method: 'DELETE' })
                .catch(function () {})
                .then(function () { throw new Error((i + 1) + '번째 기록: ' + (t || ins.status)); });
            });
            done++;
          });
        });
      });
    }, Promise.resolve()).then(function () {
      EVUP.busy = false; EVUP.sent = true; EV_SENDING = false;
      evFreeUrls();
      EVUP.items = []; EVUP.pages = [];
      closePanel();
      toastOk('영수증 ' + n0(done) + '건을 올렸습니다.');
      AUDIT = null; loadAll();
    }).catch(function (e) {
      EVUP.busy = false; EV_SENDING = false;
      if (btn) { btn.disabled = false; }
      // 이미 올라간 것은 목록에서 빼고 화면에도 바로 반영한다 — 안 그러면 '안 올라갔나'
      // 하고 다시 올려 겹친다.
      EVUP.items.splice(0, done);
      paintEvList();
      if (done) { AUDIT = null; loadAll(); }
      evNote('<b style="color:var(--red)">' + esc(done
        ? done + '건까지 올렸습니다. ' + (total - done) + '건이 남았습니다 — ' + evWhy(e)
        : '올리지 못했습니다 — ' + evWhy(e)) + '</b>');
    });
  }

  /** 서버 원문 대신 사람이 할 수 있는 말로. 원문은 콘솔에 남긴다. */
  function evWhy(e) {
    var m = String((e && e.message) || '');
    console.error('증빙 올리기 실패:', m);
    if (/413|too large/i.test(m)) return '파일이 너무 큽니다. 사진을 줄여서 다시 올려 주세요.';
    if (/401|403|jwt|로그인/i.test(m)) return '로그인이 풀렸습니다. 다시 로그인한 뒤 올려 주세요.';
    if (/409|duplicate/i.test(m)) return '같은 파일이 이미 올라가 있습니다. 목록을 다시 확인해 주세요.';
    return '잠시 뒤 「올리기」를 다시 눌러 주세요.';
  }

  function evDelete(id) {
    var e = EVID.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!e) return;
    $('pTitle').textContent = '영수증 지우기';
    $('pSub').textContent = md(e.date_millis) + ' · ' + (e.category || '') +
      (e.amount ? ' · ' + won(e.amount) : '');
    $('pBody').innerHTML = '<div class="anote">이 영수증을 지웁니다. 되돌릴 수 없습니다.</div>' +
      (e.photo_path ? '<div class="form"><div class="frow"><div class="fbody">' +
        '<img src="' + esc(SB + '/storage/v1/object/public/evidence/' + e.photo_path) + '" ' +
        'style="max-width:100%;border-radius:var(--r-sm);border:1px solid var(--line)" alt=""></div></div></div>' : '');
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnEvDelGo" data-id="' + esc(e.id) + '">지우기</button>';
    $('panel').classList.add('open');
  }

  function runEvDelete(id) {
    var e = EVID.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!e) return;
    var btn = $('btnEvDelGo'); if (btn) { btn.disabled = true; btn.textContent = '지우는 중…'; }
    // 기록을 먼저 지운다. 파일만 남는 것이 기록만 남는 것보다 덜 위험하다.
    // 지운 줄을 돌려받아 실제로 지워졌는지 본다 — 서버 규칙이 막으면 0줄이 지워져도 200 이 와서
    // "지웠습니다"라고 거짓으로 말했다(2026-10-06 검증로봇 2: 다른 탭에서 상신한 직후 등).
    apiRetry('/rest/v1/evidences?id=eq.' + encodeURIComponent(e.id),
      { method: 'DELETE', headers: { Prefer: 'return=representation' } })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.status); });
        return r.json().then(function (rows) {
          if (!Array.isArray(rows) || !rows.length) {
            throw new Error('지워지지 않았습니다. 이 주기가 상신됐거나 권한이 없을 수 있습니다 — 새로 고침 후 다시 확인해 주세요');
          }
        });
      })
      .then(function () {
        // A4 스캔 원본은 여러 영수증이 함께 가리킨다. 이 줄이 마지막이었으면 원본도 지운다 —
        // 안 그러면 잘못 올린 A4 한 장이 화면에서 지울 길 없이 남는다(버킷이 공개라 주소로 열린다).
        var scanLeft = e.scan_path && ALL_EVID.some(function (x) {
          return x.scan_path === e.scan_path && String(x.id) !== String(e.id);
        });
        var scanP = (e.scan_path && !scanLeft)
          ? apiRetry('/storage/v1/object/evidence/' + e.scan_path, { method: 'DELETE' })
            .then(function (r3) { return r3.ok; }, function () { return false; })
          : Promise.resolve(true);
        if (!e.photo_path) return scanP;
        // 앱이 올린 파일은 anon 경로라 웹 권한으로 못 지울 수 있다. 결과를 보고 말한다.
        return apiRetry('/storage/v1/object/evidence/' + e.photo_path, { method: 'DELETE' })
          .then(function (r2) { return r2.ok; }, function () { return false; })
          .then(function (ok1) { return scanP.then(function (ok2) { return ok1 && ok2; }); });
      })
      .then(function (fileGone) {
        closePanel(); AUDIT = null; loadAll();
        toastOk('지웠습니다.', fileGone ? null : '기록은 지웠지만 사진 파일은 남았습니다.');
      })
      .catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = '지우기'; }
        var m = err && String(err.message || '');
        toast(m.indexOf('지워지지 않았습니다') === 0 ? m : '지우지 못했습니다. 잠시 뒤 다시 해 보세요.', true);
      });
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

    var h = head('안전교육', esc(key) + ' 회차 · 시청 기간 ' + esc(cycleSpan(CYC.y, CYC.m)));
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
    var T = totals(TRIPS, isAll() ? { allUsers: true } : { who: myName() });
    var rows = perPersonTotals();

    var h = head(scopeTitle('정산'), esc(viewName()) + ' · ' + esc(viewSpan()) + (isMulti() ? ' · <b>조회 전용</b>' : ''));

    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>업무용 비용 합계</div>' +
      '<p class="verdict">' + won(T.cost) + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">유류비</div><div class="v">' + won(T.fuel) +
      '</div><div class="sub">업무거리 ' + km(T.bizKm) + ' km</div></div>' +
      '<div class="fact"><div class="k">통행료</div><div class="v">' + won(T.toll) +
      '</div><div class="sub">' + (T.unk ? '미확정 ' + n0(T.unk) + '건 제외' : '전부 확정') +
      (T.evToll ? ' · 영수증 ' + won(T.evToll) + ' 포함' : '') + '</div></div>' +
      '<div class="fact"><div class="k">주차비</div><div class="v">' + won(T.park) + '</div>' +
      (T.evPark ? '<div class="sub">영수증 ' + won(T.evPark) + ' 포함</div>' : '') + '</div>' +
      '</div></div>';

    if (T.unk) {
      h += '<section class="sect"><button class="issue sv-warn" data-issue="unk" style="border-radius:var(--r-lg);border:1px solid var(--line);background:var(--surface)">' +
        '<span class="ico">' + ic('ticket', 17) + '</span>' +
        '<span class="bd"><span class="t">통행료 미확정 ' + n0(T.unk) + '건이 0원으로 계산됐습니다</span>' +
        '<span class="d">채우면 합계가 올라갑니다. 통행료 채우기에서 한 번에 정리하실 수 있습니다.</span></span>' +
        '<span class="go">' + ic('chev', 15) + '</span></button></section>';
    }

    if (isAll()) { var tc = teamCards(rows); if (tc) h += sect(ORGF.team ? '파트·센터별' : '팀별', null, '', tc); }
    // 개인 범위에서 rows 는 사람 목록(늘 1명)이다. 건수는 운행 수로 적는다.
    h += sect(isAll() ? '직원별' : '내 정산',
      isAll() ? rows.length + '명' : '운행 ' + n0(T.n) + '건',
      // 버튼 이름을 받는 것 그대로 부른다(예전 「인쇄용 출력」은 엑셀 창을 열었다).
      (isMulti() ? '' : '<button class="btn sm" data-print="' + esc(myName()) + '">' + ic('receipt', 13) +
        (isAll() ? '내 운행기록부' : '운행기록부 (엑셀 · PDF)') + '</button>') +
      '<button class="btn sm" id="btnCsv" title="운행 목록을 CSV 로 받습니다">' + ic('dl', 13) + '목록 CSV</button>', personTable(rows));

    h += sect('산정 기준', null, '',
      '<div class="panel" style="padding:18px 20px;font-size:12.5px;line-height:1.95;color:var(--ink-3)">' +
      '업무용(<b style="color:var(--ink-2)">' + BUSINESS + '</b>) 운행만 집계합니다.<br>' +
      '유류비 = 분기 기준단가 × (반올림한 도착계기 − 반올림한 출발계기)<br>' +
      '분기 경계 ' + esc(QBOUNDS.map(function (b) { return pad(b[0]) + '-' + pad(b[1]); }).join(' · ')) + '<br>' +
      '<b style="color:var(--ink-2)">회사 월간 리포트와 같은 식</b>으로 계산합니다. 리포트와 다르면 알려 주세요.</div>');
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
    var pick = evidBySheet(mine, plates, r);
    plates.forEach(function (p, i) { h += printSheet(mine, u, p, byPlate[p], r, a, pick[i]); });
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
  function printSheet(mine, u, plate, list, r, a, pick) {
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
    //    어느 영수증이 이 장에 실리는지는 부르는 쪽이 evidBySheet() 로 한 번에 정해 넘긴다(pick).
    //    장마다 따로 판단하면 같은 영수증이 두 장에 실리거나 어느 장에도 안 실린다.
    var evPark = {}, evToll = {};
    EVID.forEach(function (e) {
      var d = Number(e.date_millis);
      if (e.username !== mine || !(d >= r.lo && d < r.hi)) return;
      if (!pick || !pick[e.id]) return;
      if (!(Number(e.amount) > 0)) return;
      var k = evDay(e, r);                               // 운행에 이은 영수증은 그 운행의 날로
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
    // ★ 승인한 칸에만 서명·날짜를 찍는다(boxesOf).
    //   아직 결재 안 했거나 반려한 사람의 이름을 찍으면 서명처럼 보여
    //   사내 결재 문서가 위조로 오해된다(2026-09-15 지적). 그 칸은 비워서
    //   앱 엑셀처럼 도장을 찍을 수 있게 둔다.
    var boxMap = boxesOf(a, u, mine);
    var signIds = Object.keys(boxMap).map(function (k) { return boxMap[k].signId; })
      .filter(function (id) { return id && SIGNS[id] === undefined && !SIGN_ASKED[id]; });
    if (signIds.length) loadSigns(signIds).then(render);

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
        var sg = signOf(v);
        return '<td class="psign">' + (sg ? '<img class="pstamp" alt="' + esc(v.name) + '" src="' + sg + '">' : esc(v.name)) +
          (v.date ? '<span>' + esc(v.date) + '</span>' : '') + '</td>';
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

  /* ══════════════════ 엑셀 내려받기 ══════════════════
     ★ 제출 서류는 **앱이 내보내는 엑셀이 기준**이다. 인쇄물이 아니다.
       직원이 받아서 계기판을 고치면 운행거리(=H−G) → 유류비(=MAX(0,I)×단가) →
       금액합계(=SUM(J:L)) → 하단 SUM 까지 수식으로 따라 바뀌어야 한다.
       양식(열 폭·병합·서식·결재란)도 xlsx.js 가 앱 ExcelExporter.kt 를 그대로 옮겼다. */

  /** 차량 한 대치 엑셀 한 장을 만든다. 앱 exportRange 와 같은 순서·같은 규칙. */
  function sheetDataFor(mine, u, plate, list, r, pick) {
    // 앱 188행: 같은 날이면 계기판 순, 그 다음 시각 순.
    var rows = list.slice().sort(function (x, y) {
      return dayNo(x.start_time) - dayNo(y.start_time)
        || odoInt(x.start_odometer) - odoInt(y.start_odometer)
        || x.start_time - y.start_time;
    });
    var veh = VEHICLES.filter(function (v) {
      return v.username === mine && (v.plate_no || '') === plate;
    })[0] || {};

    // 영수증 금액 — 이 장에 실을 영수증은 부르는 쪽이 evidBySheet() 로 한 번에 정해 넘긴다(pick).
    var evPark = {}, evToll = {};
    EVID.forEach(function (e) {
      var d = Number(e.date_millis);
      if (e.username !== mine || !(d >= r.lo && d < r.hi)) return;
      if (!pick || !pick[e.id]) return;
      if (!(Number(e.amount) > 0)) return;
      var k = evDay(e, r);                               // 운행에 이은 영수증은 그 운행의 날로
      if (e.category === '주차') evPark[k] = (evPark[k] || 0) + Number(e.amount);
      if (e.category === '통행료') evToll[k] = (evToll[k] || 0) + Number(e.amount);
    });
    var tripDates = {};
    rows.forEach(function (t) { tripDates[ymd(t.start_time)] = 1; });
    var orphanDates = Object.keys(evPark).concat(Object.keys(evToll))
      .filter(function (d, i, arr) { return arr.indexOf(d) === i && !tripDates[d]; }).sort();

    var seen = {}, out = [], partMap = {};
    rows.forEach(function (t) {
      var g = odoInt(t.start_odometer), hh = odoInt(t.end_odometer);
      var rate = rateOf(t);
      var day = ymd(t.start_time);
      var first = !seen[day]; seen[day] = 1;
      var park = (Number(t.parking_cost) || 0) + (first ? (evPark[day] || 0) : 0);
      var toll = tollForExport(t, first ? (evToll[day] || 0) : 0);
      out.push({
        date: day, start: dong(t.start_address), end: dong(t.end_address),
        visit: t.visit_place || '', purpose: t.purpose || '', manual: !!t.is_manual,
        odoS: g, odoE: hh, rate: rate, parking: park, toll: toll
      });
      // 지역별 분해 — FuelCost.km 규칙(역행이면 0)을 그대로 쓴다.
      var km = Math.max(0, hh - g);
      var rg = region(t.start_address || '', t.start_lat, t.start_lng);
      var key = rg + '-' + rate;
      var p = partMap[key] = partMap[key] || { region: rg, rate: rate, km: 0, amount: 0 };
      p.km += km; p.amount += km * Math.max(rate, 0);
    });
    var orphans = orphanDates.map(function (d) {
      return { date: d, parking: evPark[d] || 0, toll: evToll[d] || 0 };
    });
    var parts = Object.keys(partMap).map(function (k) { return partMap[k]; })
      .filter(function (p) { return p.km > 0; })
      .sort(function (x, y) {
        return (x.region === '수도권' ? 0 : 1) - (y.region === '수도권' ? 0 : 1) || x.rate - y.rate;
      });
    if (parts.length < 2) parts = [];

    return {
      dept: [u.company_name, u.dept].filter(Boolean).join(' ').trim(),
      name: u.name || mine,
      plateNo: plate,
      // 앱 255행: 차량 레코드 우선, 비어 있으면 프로필 값.
      vehicleType: veh.vehicle_type || u.vehicle_type || '',
      periodLabel: periodLabel(),
      quarterLabel: fuelLabel(),
      rows: out, orphans: orphans, parts: parts
    };
  }

  /** 엑셀 파일을 만들어 내려받는다. 차량이 여러 대면 대수만큼 파일이 나온다(앱과 같다). */
  function downloadXlsx(who) {
    if (!LOADED) { toast('아직 불러오는 중입니다.'); return; }
    var mine = who || myName();
    if (who && who !== myName() && !isAll()) {
      toast('다른 분 운행기록부는 관리 › 전체 정산에서 뽑을 수 있습니다.', true);
      return;
    }
    if (!window.Xlsx) { toast('엑셀 모듈을 불러오지 못했습니다. 새로고침해 주세요.', true); return; }

    // ★ 파일은 xlsxFiles() 하나로만 만든다. 예전에는 여기에 같은 일을 하는 코드가 따로 있어,
    //   '번호판이 장과 안 맞는 영수증' 수정이 결재 문서 엑셀에만 들어가고 이 버튼에는 빠졌다(2026-10-02 재검증).
    var files = xlsxFiles(mine);
    if (!files.length) { toast('고르신 목적에 해당하는 운행·영수증이 없습니다.', true); return; }
    files.forEach(function (f, i) {
      // 여러 장이면 브라우저가 한꺼번에 받는 것을 막을 수 있어 조금씩 띄운다.
      setTimeout(function () { saveBlob(f.bytes, f.name); }, i * 400);
    });
    var warn = sheetSumWarn(files, expectCost(mine));
    if (warn) toast(warn, true);
    else toast(files.length > 1 ? '엑셀 ' + files.length + '개를 내려받습니다(차량별로 한 장씩).' : '엑셀을 내려받습니다.');
  }
  /** 화면 합계(= 서버 집계 규칙)로 본 그 사람의 이번 주기 금액. 일반업무만 담을 때만 견줄 수 있다 — 아니면 null. */
  function expectCost(mine) {
    if (PRINT_PURPOSES.length !== 1 || PRINT_PURPOSES[0] !== BUSINESS) return null;
    return Math.round(totals(TRIPS.filter(function (t) { return t.username === mine; }), { who: mine }).cost);
  }
  /** 장별 총계의 합이 기대 금액과 다르면 알릴 말을, 같으면(또는 견줄 수 없으면) '' 를 돌려준다. */
  function sheetSumWarn(files, expect) {
    if (expect == null || !isFinite(Number(expect))) return '';
    var sum = 0, known = true;
    files.forEach(function (f) { if (f.sum == null) known = false; else sum += f.sum; });
    if (!known || Math.abs(Math.round(sum) - Math.round(Number(expect))) <= 1) return '';
    return '문서 총계 ' + won(sum) + ' 가 집계 금액 ' + won(expect) + ' 과 ' +
      n0(Math.abs(Math.round(sum) - Math.round(Number(expect)))) + '원 다릅니다. 관리자에게 알려 주세요.';
  }

  function saveBlob(bytes, filename) {
    var blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
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
    if (isMulti()) { toast('운행기록부는 한 주기씩 만듭니다. 위 기간에서 주기를 하나 골라 주세요.', true); return; }
    // 개인 화면에서는 본인 것만 뽑는다. 남의 이름으로 부르면 운행은 없어도
    // 머리 정보(이름·부서·차량)가 찍히므로 여기서 막는다.
    if (who && who !== myName() && !isAll()) {
      toast('다른 분 운행기록부는 관리 › 전체 정산에서 뽑을 수 있습니다.', true);
      return;
    }
    var target = who || myName();
    // 결재 중이거나 끝난 주기는 '고정본'이 정본이다 — 상신할 때 서버가 굳힌 자료로만 만든다.
    var ap = apprOf(target, CYCKEY());
    if (ap && (ap.status === 'submitted' || ap.status === 'approved')) {
      var done = ap.status === 'approved';
      openPanel(done ? '결재 완료본' : '결재 문서',
        nameOf(target) + ' · ' + cycleName(CYC.y, CYC.m) + ' · ' + cycleSpan(CYC.y, CYC.m),
        '<div class="hpnote" style="margin-top:0">' + ic('check', 16) + '<span><b>' +
        (done ? '결재가 끝났습니다.' : '결재 중입니다.') + '</b> 상신할 때 저장한 자료로 문서를 만듭니다. ' +
        '언제 받아도 같은 내용이 나옵니다.</span></div>' + apprTrack(ap) +
        '<div class="anote"><b>PDF</b> — 운행기록부(결재란 포함) · 검증 결과 · 영수증 사진이 한 권으로 나옵니다' +
        (done ? '.' : '. 결재가 끝나기 전에는 쪽마다 「결재 중」이 찍힙니다.') + '<br>' +
        '<b>엑셀</b> — 앱에서 받는 것과 같은 양식입니다(차량별로 한 장씩). 업무(일반업무) 운행만 담깁니다.</div>',
        '<span style="flex:1"></span><button class="btn" data-close>닫기</button>' +
        '<button class="btn" data-fzxlsx="' + ap.id + '">' + ic('dl', 14) + (done ? '결재 완료본 엑셀' : '결재 문서 엑셀') + '</button>' +
        '<button class="btn pri" data-fzpdf="' + ap.id + '">' + ic('dl', 14) + (done ? '결재 완료본 PDF' : '결재 문서 PDF') + '</button>');
      return;
    }
    $('pTitle').textContent = '운행기록부';
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
      '<div class="anote"><b>엑셀</b> — 앱에서 내려받는 것과 같은 파일입니다. ' +
      '받아서 계기판을 고치시면 운행거리·유류비·합계가 <b>수식으로 따라 바뀝니다</b>. ' +
      '차량을 두 대 이상 모셨으면 <b>차량별로 한 장씩</b> 나옵니다.<br>' +
      '<b>PDF 미리보기</b> — 운행기록부 · 검증 결과 · 영수증 사진이 한 권으로 나옵니다. ' +
      '아직 상신 전이라 쪽마다 <b>「미리보기」</b>가 찍힙니다. 결재가 끝나면 같은 자리에서 <b>결재 완료본</b>을 받습니다.</div>';
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn" data-pdf="' + esc(target) + '">' + ic('dl', 14) + 'PDF 미리보기</button>' +
      '<button class="btn pri" id="btnXlsxGo" data-who="' + esc(target) + '">' + ic('dl', 14) + '엑셀 내려받기</button>';
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
    // 빈 자리 표시 행은 &nbsp; 로 채워져 있어 :not(:empty) 로는 안 걸린다. 실제 글자로 본다.
    //    (앱은 이런 경우 파일 자체를 만들지 않는다 — MainViewModel 368행)
    var anyRow = Array.prototype.some.call(
      host.querySelectorAll('table.plog tbody tr td'),
      // 공백·줄바꿈·&nbsp;(U+00A0) 를 지우고 남는 글자가 있는지 본다.
      //  ※ 예전에는 백슬래시가 빠져 [s+NBSP] 였다 — 영문 s 를 지우고 일반 공백은 남겼다.
      function (td) { return td.textContent.replace(/[\s\u00a0]/g, '') !== ''; });
    if (!anyRow) { toast('고르신 목적에 해당하는 운행이 없습니다.', true); return; }
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
    a.download = 'ATEC_운행일지_' + (RANGE ? cycKey(RANGE.from) + '~' + cycKey(RANGE.to) : cycKey(CYC)) +
      (filterWords().length ? '_' + filterWords().join('_').replace(/[\\/:*?"<>|\s]+/g, '') : '') + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('CSV 를 내려받았습니다.');
  }

  /* ══════════════════ 관리 화면 ══════════════════ */
  function viewPeople() {
    if (!LOADED) return head('직원 현황') + skeleton();
    // 결재만 하는 계정(운행일지 안 씀)은 운행자 현황·미운행 인원에서 뺀다(2026-10-07).
    var list = Object.keys(USERS).map(function (u) { return USERS[u]; })
      .filter(function (u) { return u.uses_driving !== false; })
      .sort(function (a, b) {
        return (a.dept || '힣').localeCompare(b.dept || '힣', 'ko') ||
          (a.name || '').localeCompare(b.name || '', 'ko');
      });
    var byU = {};
    TRIPS.forEach(function (t) { (byU[t.username] = byU[t.username] || []).push(t); });
    var idle = list.filter(function (u) { return !(byU[u.username] || []).length; }).length;

    var h = head('직원 현황', list.length + '명 · ' + esc(viewName()));
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>이번 주기</div>' +
      '<p class="verdict">' + (idle ? '<em>' + idle + '명</em>이 한 건도 기록하지 않았습니다' : '<em>전원 기록</em>했습니다') + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">등록 인원</div><div class="v">' + list.length + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">기록 있음</div><div class="v">' + (list.length - idle) + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">기록 없음</div><div class="v' + (idle ? ' alert' : '') + '">' + idle + '<small>명</small></div></div>' +
      '</div></div>';

    h += sect('명단', list.length + '명', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>파트·센터</th><th>이름</th><th>직급</th><th>차량</th><th class="n">운행</th>' +
      '<th class="n">거리</th><th class="n">비용</th><th></th></tr></thead><tbody>' +
      orgGroups(list, function (u) { return u.username; }, true).map(function (g) {
        var gi = g.list.filter(function (u) { return !(byU[u.username] || []).length; }).length;
        return orgGroupRow(g, 8, gi ? '<span class="unk">기록 없음 ' + n0(gi) + '명</span>' : '전원 기록') + g.list.map(peopleRow).join('');
      }).join('') + '</tbody></table></div></div>');
    return h;
    function peopleRow(u) {
      return (function () {
        var x = totals(byU[u.username] || [], { who: u.username });   // 영수증만 있는 사람도 금액이 나온다(다른 화면과 같은 기준)
        return '<tr class="clk" tabindex="0" data-person="' + esc(u.username) + '">' + orgCell(u.username, true) +
          '<td><span class="lead">' + esc(u.name || u.username) + '</span>' +
          '<div class="dim" style="font-size:11px">' + esc(u.username) + '</div></td>' +
          '<td class="dim">' + esc(u.position || '—') + '</td>' +
          '<td class="dim">' + esc(u.plate_no || '—') + '</td>' +
          '<td class="n' + (x.n ? '' : ' dim') + '">' + n0(x.n) + '</td>' +
          '<td class="n">' + (x.km ? km(x.km) : '—') + '</td>' +
          '<td class="n total">' + (x.cost ? n0(x.cost) : '—') + '</td>' +
          '<td>' + (u.is_admin ? '<span class="st bad">관리자</span>' : '') + '</td></tr>';
      })();
    }
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

    var h = head('차량', plates.length + '대 운행 · ' + esc(viewName()));
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
          return '<tr class="clk' + (multi || wide ? ' flagged' : '') + '" tabindex="0" data-car="' + esc(p) + '">' +
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
      '<th>소속</th><th>이름</th><th class="n">안전점수</th><th class="n">운행</th><th>이수</th></tr></thead><tbody>' +
      tg.slice().sort(function (a, b) { return (doneBy[a.username] || 0) - (doneBy[b.username] || 0); })
        .map(function (t) {
          var u = USERS[t.username] || {}, d = doneBy[t.username] || 0;
          var ok = vids.length > 0 && d >= vids.length;
          return '<tr' + (ok ? '' : ' class="flagged"') + '>' +
            orgCell(t.username) + '<td><span class="lead">' + esc(u.name || t.username) + '</span></td>' +
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
    if (isMulti()) return singleOnly(isAll() ? '하이패스 대조 (전체)' : '하이패스 대조', '하이패스 대조');

    // ★ 개인 화면에서 내 주기가 결재 완료면 서버가 전부 튕긴다. 먼저 말한다.
    //   (전체 화면은 사람마다 다르므로 묶음 줄에서 따로 표시한다.)
    if (!isAll() && cycleLocked(myName())) {
      return h + lockedNote(lockTitle(myName()),
        '이 주기의 통행료는 바꿀 수 없습니다. 영수증을 올려도 서버가 모두 되돌립니다. ' + lockHow(myName()));
    }

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
      '<input type="file" id="hpFile" accept="application/pdf,.pdf" multiple class="sr"></label>' +
      '</div>';

    if (HP.note) h += '<div class="hpnote' + (HP.noteBad ? ' warn' : '') + '">' +
      ic(HP.noteBad ? 'alert' : 'check', 16) + '<span>' + esc(HP.note) + '</span></div>';
    if (!HP.groups.length) return h;

    HP.groups.forEach(function (g, gi) {
      var picked = (g.matched || []).filter(function (e) { return e.pick; });
      var sum = picked.reduce(function (s, e) { return s + e.sum; }, 0);
      // ★ 값이 이미 영수증과 같은 줄은 손댈 것이 없다. 표에서 빼고 접어 둔다.
      //   안 빼면 확정해도 표가 그대로라 아무 일도 안 일어난 것처럼 보인다.
      var todo = (g.matched || []).filter(function (e) { return !hpDone(e); });
      var done = (g.matched || []).filter(hpDone);

      h += '<section class="sect" data-hpcard="' + gi + '"><div class="hd">' +
        '<h2>카드 ' + esc(g.card4 || '?') + '</h2>' +
        '<span class="cnt">' + n0((g.records || []).length) + '건 · ' +
        won((g.records || []).reduce(function (s, r) { return s + (r.amount || 0); }, 0)) +
        (done.length ? ' · <b style="color:var(--ok)">' + n0(done.length) + '건 확정됨</b>' : '') + '</span>' +
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
      } else if (!todo.length) {
        // 전부 맞은 상태. 여기서 표를 그대로 두면 '아직 할 일이 있다' 로 읽힌다.
        h += '<div class="panel"><div class="blank"><div class="ico" style="color:var(--ok)">' +
          ic('check', 21) + '</div><div class="t">이 카드는 다 확정됐습니다.</div>' +
          '<div class="d">' + n0(done.length) + '건 모두 영수증 금액과 같습니다.</div></div></div>';
      } else {
        h += '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
          '<th style="width:36px"><input type="checkbox" data-hpall="' + gi + '"' +
          (todo.length && todo.every(function (x) { return x.pick || x.locked; }) ? ' checked' : '') +
          ' aria-label="이 카드의 운행 전부 고르기"></th>' +
          '<th>운행</th><th>지금 값</th><th class="n">영수증</th><th class="n">차이</th><th>영수증 내역</th>' +
          '</tr></thead><tbody>';
        todo.forEach(function (e) {
          var ei = g.matched.indexOf(e);          // 체크박스 키는 원래 자리를 쓴다
          var t = e.trip;
          var now = e.kind === 'new' ? '<span class="st warn">미확정</span>'
            : (e.who === 'person'
              ? '<span class="st bad">직접 넣은 ' + n0(t.toll_cost) + '</span>'
              : '<span class="dim">자동 ' + n0(t.toll_cost) + '</span>');
          var diff = e.diff == null ? '<span class="dim">—</span>'
            : e.diff === 0 ? '<span class="st ok">같음</span>'
              : '<b style="color:' + (e.diff > 0 ? 'var(--ok)' : 'var(--red)') + '">' +
                (e.diff > 0 ? '+' : '') + n0(e.diff) + '</b>';
          h += '<tr class="' + (e.kind === 'diff-person' ? 'flagged' : '') + '">' +
            '<td><input type="checkbox" data-hppick="' + gi + '.' + ei + '"' +
            (e.pick ? ' checked' : '') +
            (e.locked ? ' disabled title="결재가 끝난 운행이라 바꿀 수 없습니다"' : '') + '></td>' +
            '<td><span class="lead">' + md(t.start_time) + '</span> <span class="dim">' +
            hm(t.start_time) + '–' + (t.end_time ? hm(t.end_time) : '') + '</span>' +
            (isAll() ? ' <span class="dim">' + esc(nameOf(t.username)) + '</span>' : '') + '</td>' +
            '<td>' + (e.locked ? '<span class="st ok">결재 완료</span>' : now) + '</td>' +
            '<td class="n lead">' + n0(e.sum) + '</td>' +
            '<td class="n">' + diff + '</td>' +
            '<td class="el dim" title="' + esc(e.lines.map(function (r) {
              return r.atText + ' ' + r.office + ' ' + n0(r.amount);
            }).join(' / ')) + '">' +
            esc(e.lines.map(function (r) { return r.office + ' ' + n0(r.amount); }).join(' · ')) + '</td></tr>';
        });
        h += '</tbody></table></div></div>';

        if (done.length) {
          h += '<details class="hpun"><summary>이미 확정된 ' + n0(done.length) +
            '건 — 영수증과 같아 손댈 것 없음</summary><div class="hpunb">' +
            done.slice(0, 60).map(function (e) {
              return '<div><span class="mono">' + md(e.trip.start_time) + ' ' + hm(e.trip.start_time) +
                '</span> ' + esc(dong(e.trip.start_address)) + ' → ' + esc(dong(e.trip.end_address)) +
                ' <b>' + n0(e.sum) + '</b></div>';
            }).join('') + '</div></details>';
        }

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
          '<span class="dim" id="hpSum' + gi + '">남은 것 <b>' + n0(todo.length) + '건</b> · ' +
          '선택 <b>' + n0(picked.length) + '건</b> · 합계 ' + won(sum) + '</span>' +
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
            HP.noteBad = true;
            HP.note = bad ? '읽지 못한 파일이 있습니다. 한국도로공사 이용내역 PDF 가 맞는지 확인해 주세요.'
              : '영수증에서 통행 기록을 찾지 못했습니다.';
            HP.groups = []; render(); return;
          }
          HP.groups = hpMarkLocked(window.Hipass.match(recs, TRIPS));
          HP.batch = 'web-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
          HP.noteBad = !!bad;
          HP.note = n0(recs.length) + '건을 읽었습니다.' + (bad ? ' (읽지 못한 파일 ' + bad + '개)' : '');
          render();
        });
    });
  }

  /** 결재가 끝난 운행에는 표시를 달고 선택을 풀어 둔다. 서버가 되돌리기 때문이다. */
  function hpMarkLocked(groups) {
    (groups || []).forEach(function (g) {
      (g.matched || []).forEach(function (e) {
        e.locked = apprLocked(e.trip);
        if (e.locked) e.pick = false;
      });
    });
    return groups;
  }

  function hpApply(gi, force) {
    var g = HP.groups[gi]; if (!g) return;
    var picked = (g.matched || []).filter(function (e) { return e.pick && !e.locked; });
    if (!picked.length) {
      // 예전에는 말없이 돌아갔다 — 왜 아무 일도 안 일어나는지 알 수가 없었다.
      var anyLocked = (g.matched || []).some(function (e) { return e.locked; });
      toast(anyLocked ? '고르신 것이 없습니다. 결재가 끝난 운행은 바꿀 수 없습니다.'
                      : '확정할 운행을 골라 주세요.', true);
      return;
    }
    var over = picked.filter(function (e) { return e.who === 'person' && e.kind === 'diff-person'; });
    if (over.length && !force) {
      // 브라우저 기본 confirm 대신 다른 확인(전부 없음·지우기)과 같은 패널을 쓴다.
      $('pTitle').textContent = '직접 넣은 값을 덮습니다';
      $('pSub').textContent = n0(over.length) + '건';
      $('pBody').innerHTML = '<div class="anote">영수증 금액으로 바꿉니다. 앱이나 웹에서 직접 넣으신 값은 사라집니다.</div>';
      $('pFoot').innerHTML = '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
        '<button class="btn pri" id="btnHpOverGo" data-gi="' + gi + '">' + n0(over.length) + '건 덮어쓰기</button>';
      $('panel').classList.add('open');
      return;
    }
    var hbtn = document.querySelector('[data-hpapply="' + gi + '"]');
    if (hbtn) { hbtn.disabled = true; hbtn.textContent = '확정 중…'; }

    var items = picked.map(function (e) {
      return {
        id: e.trip.id, amount: e.sum,
        note: '카드 ' + (g.card4 || '?') + ' · ' + (g.plate || ''),
        lines: e.lines.map(function (r) {
          return { at: r.atText, office: r.office, amount: r.amount, page: r.page };
        }),
      };
    });

    toast('확정 중입니다…');
    apiRetry('/functions/v1/toll-apply', {
      method: 'POST', body: JSON.stringify({ items: items, batch: HP.batch })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j || !res.j.ok) {
          if (hbtn) { hbtn.disabled = false; hbtn.textContent = n0(picked.length) + '건 확정하기'; }
          toast((res.j && res.j.error) || '확정하지 못했습니다.', true); return;
        }
        // 서버가 되읽어 준 값으로 화면을 맞춘다 — 트리거가 바꿔치기했을 수 있다.
        (res.j.rows || []).forEach(function (row) {
          var t = ALL_TRIPS.filter(function (x) { return x.id === row.id; })[0];
          if (t) { t.toll_cost = row.toll_cost; t.toll_status = row.toll_status; t.toll_source = row.toll_source; }
        });
        AUDIT = null;
        TRIP_CACHE = {};
        var skipped = (res.j.skipped || []);
        var applied = Number(res.j.applied) || 0;
        if (res.j.warning) toast(res.j.warning, true);
        // ★ 0건이면 '반영했다' 로 읽히면 안 된다. 왜 못 했는지를 앞세운다.
        else if (!applied) toast(skipped.length
          ? '한 건도 확정되지 않았습니다 — ' + skipped[0].why
          : '한 건도 확정되지 않았습니다.', true);
        else if (skipped.length) toast(applied + '건 확정 · ' + skipped.length + '건은 건너뛰었습니다 (' +
          skipped[0].why + ')', true);   // toast 는 textContent — esc 를 씌우면 &quot; 가 그대로 보인다
        else toast(applied + '건 확정했습니다.');
        // 남은 것만 다시 계산
        hpMarkLocked([window.Hipass.assign(g, TRIPS)]);
        paintPills(); render();
        // 통째로 다시 그리면 스크롤이 맨 위로 간다 — 눌렀던 카드로 돌려놓는다.
        var card = document.querySelector('[data-hpcard="' + gi + '"]');
        if (card) card.scrollIntoView({ block: 'start' });
      }).catch(function () {
        if (hbtn) { hbtn.disabled = false; hbtn.textContent = n0(picked.length) + '건 확정하기'; }
        toast('서버에 연결하지 못했습니다.', true);
      });
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
    // 여러 주기를 함께 볼 때는 '조회 전용'이라고 해 놓았다 — 고치려면 그 달을 열게 한다.
    var tc = cycleOfMs(Number(t.start_time));
    $('pFoot').innerHTML = locked
      ? '<span class="dim" style="font-size:12px;flex:1">결재 중이거나 끝난 기간이라 고칠 수 없습니다</span>' +
        '<button class="btn" data-close>닫기</button>'
      : isMulti()
        ? '<span class="dim" style="font-size:12px;flex:1">여러 주기를 함께 볼 때는 조회만 됩니다</span>' +
          '<button class="btn" data-close>닫기</button>' +
          '<button class="btn pri" data-cyc="' + tc.y + '-' + tc.m + '">' + tc.m + '월분 열어 고치기</button>'
        : '<span style="flex:1"></span><button class="btn" data-close>닫기</button>' +
          '<button class="btn pri" data-edit="' + t.id + '">고치기</button>';
    $('panel').classList.add('open');
  }

  /** 그 사람의 그 시각이 속한 마감주기가 잠겼나(결재 중이거나 끝남). 서버 driving_cycle_locked 와 같은 판정. */
  function lockedAt(u, ms) {
    var key = cycKey(cycleOfMs(Number(ms)));
    return APPR.some(function (a) {
      return a.username === u && a.cycle === key && (a.status === 'submitted' || a.status === 'approved');
    });
  }
  /** 이 운행을 고칠 수 없는가. 서버(trip-edit)도 같은 판정을 한다. */
  function apprLocked(t) { return lockedAt(t.username, t.start_time); }
  /** 하이패스 대조에서 더 할 일이 없는 줄 — 이미 하이패스로 맞췄거나, 금액은 같은데 결재가 잠겨 바꿀 수 없는 것(2026-10-07). */
  function hpDone(e) { return e.kind === 'same' || (e.kind === 'confirm' && apprLocked(e.trip)); }
  /** 이 증빙을 지울 수 없는가. */
  function evLocked(e) { return lockedAt(e.username, e.date_millis); }

  /* ══════════════════ 운행 고치기 ══════════════════
     서버 trip-edit 의 규칙을 그대로 옮긴다 — 화면에서 먼저 걸러 주되
     최종 판정은 서버가 한다(여기서 통과해도 서버가 거부할 수 있다).        */
  var PURPOSES = ['일반업무', '출퇴근', '비업무용'];
  function openEdit(id) {
    var t = TRIPS.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!t) return;
    if (apprLocked(t)) { toast('결재 중이거나 끝난 기간이라 고칠 수 없습니다. 「이번 달 마감」에서 고치는 방법을 확인해 주세요.', true); return; }
    // 계기판: 본인 운행·관리자(2026-10-07 — 직원도 계기판 사진과 맞춰 직접 고친다. 서버 trip-edit 와 같은 규칙)
    var canOdo = !!(ME && (ME.is_admin || t.username === myName()));

    $('pTitle').textContent = md(t.start_time) + ' ' + hm(t.start_time) + ' 고치기';
    $('pSub').textContent = nameOf(t.username) + ' · ' + (t.plate_no || '');

    var h = '<div class="form">';
    h += fld('운행목적', '<div class="radios">' + PURPOSES.map(function (p) {
      return '<label class="radio"><input type="radio" name="ePurpose" value="' + esc(p) + '"' +
        ((t.purpose || '') === p ? ' checked' : '') + '><span>' + esc(p) + '</span></label>';
    }).join('') + '</div>',
      (t.purpose || '') === '일반업무' ? '업무용만 비용으로 집계됩니다' : '업무용이 아니면 비용에서 빠집니다');

    h += fld('방문처', '<input class="inp" id="eVisit" maxlength="120" value="' + esc(t.visit_place || '') + '">');
    h += fld('주차비', '<input class="inp num" id="ePark" inputmode="numeric" placeholder="없으면 비워 두세요" value="' +
      (t.parking_cost == null ? '' : n0(t.parking_cost)) + '"><span class="unit">원</span>',
      '0 ~ 300,000원 · 증빙이 없거나 그날 주차 영수증으로 대신할 때는 <b>비워</b> 두세요');

    h += fld('통행료',
      '<div class="radios"><label class="radio"><input type="radio" name="eToll" value="amount"' +
      (isUnknownToll(t) ? '' : ' checked') + '><span>금액 입력</span></label>' +
      '<label class="radio"><input type="radio" name="eToll" value="unknown"' +
      (isUnknownToll(t) ? ' checked' : '') + '><span>모름</span></label></div>' +
      '<div style="margin-top:9px"><input class="inp num" id="eToll" inputmode="numeric" value="' +
      (isUnknownToll(t) ? '' : n0(t.toll_cost)) + '"><span class="unit">원</span></div>',
      '0 ~ 200,000원 · 통행료를 <b>지우려면 0</b>을 넣으세요(증빙이 없거나, 그날 영수증 금액으로 대신할 때)');

    if (canOdo) {
      h += fld('계기판',
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
     앞뒤와 1,000km 이상 벌어지면 되물어본다(175,500km 오타 같은 사고 방지). */
  /* ══════════════════ 운행 추가 (2026-10-07 개편 — 앱 수기 입력과 같은 흐름) ══════════════════
     · 출발지·도착지: 카카오 장소 검색(건물 이름·주소)으로 고른다 — 좌표가 남아 유류단가 지역·거리 계산에 쓰인다.
     · 그날 운행이 있으면 「어디에 넣을지」(몇 번째)를 고른다. 시각은 그 자리로 정해지고(앱 TripSlot 과 같은 규칙),
       출발 계기판은 앞 운행의 도착값, 도착 계기판은 도로 거리로 자동으로 채운다(고칠 수 있다).
     · 도착이 다음 운행 출발보다 크면 이후 운행 계기판을 밀어 올린다(서버가 몇 건·몇 km 인지 되묻는다).
     · 방문처·주차비·통행료는 반드시 고르거나 적어야 넣을 수 있다.                                         */
  var CF = null;   // 운행 추가 창의 상태
  var CF_STEP = 60000, CF_DAY = 86400000;

  /** 그 날·그 차의 운행(시각 순). */
  function cfDayTrips() {
    if (!CF || !CF.date || !CF.plate) return [];
    var s = Date.parse(CF.date + 'T00:00:00+09:00'), e = s + CF_DAY;
    return ALL_TRIPS.filter(function (t) {
      return t.username === CF.who && (t.plate_no || '') === CF.plate && !t.deleted_at && t.start_time >= s && t.start_time < e;
    }).sort(function (a, b) { return a.start_time - b.start_time; });
  }
  /** 앱 TripSlot.computeStart 와 같은 규칙 — 고른 자리를 시각으로 옮긴다. */
  function cfStart(dayTrips, pos) {
    var dayS = Date.parse(CF.date + 'T00:00:00+09:00'), maxT = dayS + CF_DAY - 1;
    if (!dayTrips.length) return dayS + 9 * 3600000;          // 빈 날은 09:00(사람이 고칠 수 있다)
    var prev = pos > 0 ? dayTrips[pos - 1] : null, next = dayTrips[pos] || null;
    var ts = prev ? Math.max(prev.start_time, prev.end_time || 0) + CF_STEP : next ? next.start_time - CF_STEP : dayS + 5 * CF_STEP;
    if (ts > maxT) { var lower = prev ? prev.start_time : dayS; ts = lower + Math.floor((maxT - lower + 1) / 2); if (ts <= lower) ts = lower + 1; }
    ts = Math.max(ts, dayS);
    if (next && ts >= next.start_time) ts = prev ? Math.floor((prev.start_time + next.start_time) / 2) : Math.floor((dayS + next.start_time) / 2);
    if (prev && ts <= prev.start_time) ts = prev.start_time + 1;
    var used = {}; dayTrips.forEach(function (t) { used[t.start_time] = 1; });
    var g = 0; while (used[ts] && g < 60000) { ts++; g++; }
    return ts;
  }
  /** 이 사람·이 차량의 운행 중 ms 보다 앞선 마지막 운행. */
  function cfPrevTrip(ms) {
    var best = null;
    ALL_TRIPS.forEach(function (t) {
      if (t.username !== CF.who || (t.plate_no || '') !== CF.plate || t.deleted_at || t.start_time >= ms) return;
      if (!best || t.start_time > best.start_time) best = t;
    });
    return best;
  }
  var hhmmOf = function (ms) { var d = new Date(Number(ms) + KST); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
  var placeShort = function (a) { return String(a || '').split(' ').slice(-2).join(' '); };

  function openCreate(who) {
    var mine = who || myName();
    var myCars = carsOf(mine);
    var r = viewRange();
    var dstr = ymd(Math.min(Date.now(), r.hi - 1));
    var minD = ymd(cycleRange(addCycle(currentCycle(), -3).y, addCycle(currentCycle(), -3).m).lo);
    var maxD = ymd(Date.now());
    if (dstr < minD) dstr = minD;
    CF = { who: mine, plate: myCars[0] || '', date: dstr, pos: null, from: null, to: null, route: null, odoTouched: false, timeTouched: false };

    $('pTitle').textContent = '운행 추가';
    $('pSub').textContent = nameOf(mine);
    var h = '<div class="form cform">';
    if (ME.is_admin && isAll()) {
      var us = Object.keys(PEOPLE).sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b), 'ko'); });
      h += fld('누구 운행', '<select class="inp" id="cWho">' + us.map(function (u) {
        return '<option value="' + esc(u) + '"' + (u === mine ? ' selected' : '') + '>' + esc(nameOf(u)) + ' · ' + esc(personOf(u).dept || '') + '</option>';
      }).join('') + '</select>', '관리자는 다른 분 운행도 넣을 수 있습니다');
    }
    h += fld('차량번호', myCars.length
      ? '<select class="inp" id="cPlate">' + myCars.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('') + '</select>'
      : '<input class="inp" id="cPlateEtc" placeholder="예) 12가3456">');
    h += fld('날짜 <em class="req">*</em>', '<input class="inp" type="date" id="cDate" value="' + dstr + '" min="' + minD + '" max="' + maxD + '">', '<span id="cDateHint"></span>');
    h += '<div id="cPosRow"></div>';
    h += fld('출발지 <em class="req">*</em>', placeBox('cFrom', '건물 이름·주소로 찾기 (예: 서울버스 본사)'), '<span id="cFromHint">목록에서 골라 주세요 — 수도권·지방 유류단가를 가릅니다</span>');
    h += fld('도착지 <em class="req">*</em>', placeBox('cTo', '건물 이름·주소로 찾기'), '<span id="cToHint">목록에서 고르면 도로 거리로 도착 계기판을 채웁니다</span>');
    h += fld('계기판 <em class="req">*</em>',
      '<input class="inp num" id="cOdoS" inputmode="numeric" placeholder="출발">' +
      '<span class="arrowto">→</span>' +
      '<input class="inp num" id="cOdoE" inputmode="numeric" placeholder="도착">',
      '<span id="cOdoHint">출발은 앞 운행의 도착값, 도착은 도로 거리로 자동으로 채웁니다(고칠 수 있습니다)</span>');
    h += fld('시각', '<input class="inp num" type="time" id="cFromT" style="width:150px">' +
      '<span class="arrowto">→</span><input class="inp num" type="time" id="cToT" style="width:150px">',
      '고른 자리에 맞춰 자동으로 정해집니다. 도착 시각이 있으면 나중에 <b>하이패스 영수증과 맞춰볼 수 있습니다</b>');
    h += fld('운행목적', '<div class="radios">' + PURPOSES.map(function (p) {
      return '<label class="radio"><input type="radio" name="cPurpose" value="' + esc(p) + '"' + (p === '일반업무' ? ' checked' : '') + '><span>' + esc(p) + '</span></label>';
    }).join('') + '</div>');
    h += fld('방문처 <em class="req">*</em>', '<input class="inp" id="cVisit" maxlength="120" placeholder="예) 서울버스 본사">', '도착지를 고르면 그 이름으로 채웁니다');
    h += fld('주차비 <em class="req">*</em>',
      '<div class="radios"><label class="radio"><input type="radio" name="cParkM" value="none"><span>없음</span></label>' +
      '<label class="radio"><input type="radio" name="cParkM" value="amount"><span>있음</span></label></div>' +
      '<div style="margin-top:9px" id="cParkBox" hidden><input class="inp num" id="cPark" inputmode="numeric" placeholder="금액"><span class="unit">원</span></div>',
      '주차비가 있으면 영수증도 올려 주세요(검증에서 확인합니다)');
    h += fld('통행료 <em class="req">*</em>',
      '<div class="radios"><label class="radio"><input type="radio" name="cToll" value="none"><span>없음</span></label>' +
      '<label class="radio"><input type="radio" name="cToll" value="amount"><span>금액 입력</span></label>' +
      '<label class="radio"><input type="radio" name="cToll" value="unknown"><span>모름</span></label></div>' +
      '<div style="margin-top:9px" id="cTollBox" hidden><input class="inp num" id="cToll" inputmode="numeric" placeholder="0"><span class="unit">원</span></div>',
      '<span id="cTollHint">「모름」은 나중에 자동 계산·하이패스 대조로 채웁니다</span>');
    h += '</div><div class="anote">수기로 넣은 운행은 <b>수기</b> 표시가 붙습니다. 주행거리는 계기판 차이로 계산됩니다.</div>';

    $('pBody').innerHTML = h;
    $('pFoot').innerHTML = '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnCreateTrip">넣기</button>';
    $('panel').classList.add('open');

    var whoSel = $('cWho'); if (whoSel) whoSel.addEventListener('change', function () { openCreate(this.value); });
    if ($('cPlate')) $('cPlate').addEventListener('change', function () { CF.plate = this.value; cfRefresh(true); });
    if ($('cPlateEtc')) $('cPlateEtc').addEventListener('input', function () { CF.plate = this.value.trim(); cfRefresh(true); });
    $('cDate').addEventListener('change', function () { CF.date = this.value; CF.pos = null; cfRefresh(true); });
    $('cOdoS').addEventListener('input', function () { CF.odoTouched = true; });
    $('cOdoE').addEventListener('input', function () { CF.odoTouched = true; });
    $('cFromT').addEventListener('input', function () { CF.timeTouched = true; });
    $('cToT').addEventListener('input', function () { CF.timeTouched = true; });
    document.querySelectorAll('input[name="cParkM"]').forEach(function (x) { x.addEventListener('change', function () { $('cParkBox').hidden = this.value !== 'amount'; if (this.value === 'amount') $('cPark').focus(); }); });
    document.querySelectorAll('input[name="cToll"]').forEach(function (x) { x.addEventListener('change', function () { $('cTollBox').hidden = this.value !== 'amount'; if (this.value === 'amount') $('cToll').focus(); }); });
    wirePlace('cFrom', function (p) { CF.from = p; cfRoute(); });
    wirePlace('cTo', function (p) { CF.to = p; if (p && !$('cVisit').value.trim()) $('cVisit').value = p.name; cfRoute(); });
    cfRefresh(true);

    function fld(label, body, hint) {
      return '<div class="frow"><label class="flab">' + label + '</label><div class="fbody">' + body +
        (hint ? '<div class="fhint">' + hint + '</div>' : '') + '</div></div>';
    }
  }
  function placeBox(id, ph) {
    return '<div class="placebox"><input class="inp" id="' + id + 'Q" autocomplete="off" maxlength="60" placeholder="' + esc(ph) + '">' +
      '<div class="placelist" id="' + id + 'L" role="listbox" hidden></div></div>';
  }
  /** 장소 검색 칸 — 글자를 치면 잠깐 뒤에 찾고, 목록에서 고르면 좌표까지 정해진다. 다시 치면 고른 것이 풀린다. */
  function wirePlace(id, onPick) {
    var q = $(id + 'Q'), list = $(id + 'L'), timer = null, seq = 0, items = [];
    var show = function (arr, msg) {
      items = arr || [];
      list.innerHTML = msg ? '<div class="placemsg">' + esc(msg) + '</div>' : items.map(function (p, i) {
        return '<button type="button" class="placeitem" data-pi="' + i + '"><b>' + esc(p.name) + '</b><span>' + esc(p.addr) + '</span></button>';
      }).join('');
      list.hidden = !msg && !items.length;
    };
    q.addEventListener('input', function () {
      if (q.dataset.picked) { delete q.dataset.picked; onPick(null); }
      clearTimeout(timer);
      var v = q.value.trim();
      if (v.length < 2) { show([]); return; }
      timer = setTimeout(function () {
        var my = ++seq;
        show([], '찾는 중…');
        apiRetry('/functions/v1/trip-geo', { method: 'POST', body: JSON.stringify({ action: 'search', q: v }) })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (my !== seq) return; if (!j || !j.ok) { show([], (j && j.error) || '찾지 못했습니다'); return; } show(j.list, j.list.length ? '' : '찾는 곳이 없습니다 — 다른 이름이나 주소로 찾아 보세요'); })
          .catch(function () { if (my === seq) show([], '서버에 연결하지 못했습니다'); });
      }, 350);
    });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-pi]'); if (!b) return;
      var p = items[+b.dataset.pi]; if (!p) return;
      q.value = p.name + (p.addr ? ' · ' + p.addr : ''); q.dataset.picked = '1';
      show([]); onPick(p);
    });
    q.addEventListener('blur', function () { setTimeout(function () { show([]); }, 200); });
  }
  /** 날짜·차량·자리가 바뀌면 자리 목록·시각·출발 계기판을 다시 맞춘다. */
  function cfRefresh(resetPos) {
    var hint = $('cDateHint');
    var ms = Date.parse((CF.date || '') + 'T12:00:00+09:00');
    var lk = isFinite(ms) && lockedAt(CF.who, ms);
    if (hint) {
      if (!isFinite(ms)) hint.textContent = '날짜를 골라 주세요';
      else { var c = cycleOfMs(ms); hint.innerHTML = '<b>' + esc(cycleName(c.y, c.m)) + '</b>(' + esc(cycleSpan(c.y, c.m)) + ')에 들어갑니다' + (lk ? ' — <b style="color:var(--red)">결재 중이거나 끝난 주기라 넣을 수 없습니다</b>' : ''); }
    }
    var btn = $('btnCreateTrip'); if (btn) btn.disabled = !!lk;
    var day = cfDayTrips();
    if (resetPos || CF.pos == null || CF.pos > day.length) CF.pos = day.length;
    // 그날 운행이 있으면 어디에 넣을지 고른다(겹치는 운행 사이 자리)
    var row = $('cPosRow');
    if (row) {
      row.innerHTML = day.length ? '<div class="frow"><label class="flab">넣을 자리 <em class="req">*</em></label><div class="fbody">' +
        '<select class="inp" id="cPos">' + [0].concat(day.map(function (_, i) { return i + 1; })).map(function (i) {
          var lab = i === 0 ? '맨 앞 — ' + hhmmOf(day[0].start_time) + ' 운행 전'
            : hhmmOf(day[i - 1].start_time) + ' 운행(' + esc(placeShort(day[i - 1].end_address) || day[i - 1].visit_place || day[i - 1].purpose || '') + ' 도착) 다음';
          return '<option value="' + i + '"' + (i === CF.pos ? ' selected' : '') + '>' + lab + '</option>';
        }).join('') + '</select><div class="fhint">이 날 운행이 ' + day.length + '건 있습니다. 어느 운행 앞뒤인지 고르면 시각·계기판이 그 자리에 맞춰집니다.</div></div></div>' : '';
      var ps = $('cPos'); if (ps) ps.addEventListener('change', function () { CF.pos = +this.value; cfRefresh(false); });
    }
    if (!isFinite(ms)) return;
    var st = cfStart(day, CF.pos);
    if (!CF.timeTouched) {
      $('cFromT').value = hhmmOf(st);
      $('cToT').value = hhmmOf(st + Math.max(1, (CF.route && CF.route.min) || 30) * 60000);
    }
    // 출발 계기판 = 그 자리 앞 운행의 도착값(그날 맨 앞이면 그날 첫 운행의 출발값)
    if (!CF.odoTouched) {
      var prev = CF.pos > 0 ? day[CF.pos - 1] : (day.length ? null : cfPrevTrip(st));
      var so = prev ? Math.round(Number(prev.end_odometer)) : day.length ? Math.round(Number(day[0].start_odometer)) : null;
      if (so != null && isFinite(so)) $('cOdoS').value = n0(so); else $('cOdoS').value = '';
      // 출발지 기본값 = 앞 운행의 도착지(좌표가 있으면 고른 것으로)
      if (!CF.from && prev && prev.end_address && prev.end_lat && prev.end_lng && !$('cFromQ').value) {
        CF.from = { name: placeShort(prev.end_address), addr: prev.end_address, lat: Number(prev.end_lat), lng: Number(prev.end_lng) };
        $('cFromQ').value = CF.from.name + ' · ' + CF.from.addr; $('cFromQ').dataset.picked = '1';
      }
      cfFillEnd();
    }
  }
  function cfFillEnd() {
    if (CF.odoTouched || !CF.route || CF.route.km == null) return;
    var so = Number(String($('cOdoS').value || '').replace(/[^\d]/g, ''));
    if (!so && so !== 0) return;
    $('cOdoE').value = n0(Math.round(so + CF.route.km));
  }
  /** 출발·도착을 모두 골랐으면 도로 거리·예상 시간·예상 통행료를 받아 채운다. */
  function cfRoute() {
    CF.route = null;
    var hint = $('cOdoHint');
    if (!CF.from || !CF.to) { if (hint) hint.textContent = '출발은 앞 운행의 도착값, 도착은 도로 거리로 자동으로 채웁니다(고칠 수 있습니다)'; return; }
    if (hint) hint.textContent = '도로 거리를 계산하는 중…';
    apiRetry('/functions/v1/trip-geo', { method: 'POST', body: JSON.stringify({ action: 'route', from: { lat: CF.from.lat, lng: CF.from.lng }, to: { lat: CF.to.lat, lng: CF.to.lng } }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || j.km == null) { if (hint) hint.textContent = (j && (j.error || j.note)) || '거리를 계산하지 못했습니다 — 도착 계기판을 직접 넣어 주세요'; return; }
        CF.route = j;
        if (hint) hint.innerHTML = '도로 거리 <b>' + j.km + 'km</b> · 약 ' + j.min + '분 기준으로 채웠습니다(고칠 수 있습니다)';
        cfFillEnd();
        if (!CF.timeTouched) cfRefresh(false);
        var th = $('cTollHint');
        if (th) th.innerHTML = j.toll > 0
          ? '카카오 길찾기 예상 통행료 <b>' + n0(j.toll) + '원</b> <button type="button" class="btn sm" id="cTollUse">이 금액 넣기</button>'
          : '길찾기 경로에는 통행료가 없습니다';
        var u = $('cTollUse');
        if (u) u.addEventListener('click', function () {
          var rb = document.querySelector('input[name="cToll"][value="amount"]'); rb.checked = true;
          $('cTollBox').hidden = false; $('cToll').value = String(j.toll);
        });
      }).catch(function () { if (hint) hint.textContent = '거리를 계산하지 못했습니다 — 도착 계기판을 직접 넣어 주세요'; });
  }

  function createTrip(force, shift) {
    var num = function (el) { var v = String((el && el.value) || '').replace(/[^\d]/g, ''); return v === '' ? null : Number(v); };
    var plate = $('cPlate') ? $('cPlate').value : ($('cPlateEtc') ? $('cPlateEtc').value.trim() : '');
    if (!plate) { toast('차량번호를 넣어 주세요.', true); return; }
    var date = $('cDate').value;
    if (!date) { toast('날짜를 골라 주세요.', true); $('cDate').focus(); return; }
    if (!CF.from) { toast('출발지를 검색해서 목록에서 골라 주세요.', true); $('cFromQ').focus(); return; }
    if (!CF.to) { toast('도착지를 검색해서 목록에서 골라 주세요.', true); $('cToQ').focus(); return; }
    var from = $('cFromT').value, to = $('cToT').value;
    if (!from) { toast('출발 시각을 넣어 주세요.', true); return; }
    var toMs = function (dd, tt) { var p1 = dd.split('-').map(Number), p2 = tt.split(':').map(Number); return Date.UTC(p1[0], p1[1] - 1, p1[2], p2[0] || 0, p2[1] || 0) - KST; };
    // 자리로 정한 시각을 그대로 쓴다(분 단위 표시라 같은 분이면 자리 순서가 흐트러지지 않게 원래 값을 쓴다).
    var day = cfDayTrips(), auto = cfStart(day, CF.pos);
    var startMs = (!CF.timeTouched && hhmmOf(auto) === from) ? auto : toMs(date, from);
    var endMs = to ? toMs(date, to) : startMs;
    if (endMs < startMs) endMs += 86400e3;
    var so = num($('cOdoS')), eo = num($('cOdoE'));
    if (so == null || eo == null) { toast('계기판 값을 넣어 주세요.', true); return; }
    if (eo < so) { toast('도착 계기판이 출발보다 작습니다.', true); return; }
    if (eo - so > 3000) { toast('한 운행에 3,000km 를 넘을 수 없습니다.', true); return; }
    var visit = $('cVisit').value.trim();
    if (!visit) { toast('방문처를 넣어 주세요.', true); $('cVisit').focus(); return; }
    var parkM = (document.querySelector('input[name="cParkM"]:checked') || {}).value;
    if (!parkM) { toast('주차비 「없음」 또는 「있음」을 골라 주세요.', true); return; }
    var park = parkM === 'amount' ? num($('cPark')) : null;
    if (parkM === 'amount' && !(park > 0)) { toast('주차비 금액을 넣어 주세요.', true); $('cPark').focus(); return; }
    var tollMode = (document.querySelector('input[name="cToll"]:checked') || {}).value;
    if (!tollMode) { toast('통행료 「없음」·「금액 입력」·「모름」 중 하나를 골라 주세요.', true); return; }
    var tollAmt = tollMode === 'amount' ? num($('cToll')) : null;
    if (tollMode === 'amount' && !(tollAmt > 0)) { toast('통행료 금액을 넣어 주세요(없으면 「없음」).', true); $('cToll').focus(); return; }

    var payload = {
      username: $('cWho') ? $('cWho').value : undefined,
      plate_no: plate, start_time: startMs, end_time: endMs,
      purpose: (document.querySelector('input[name="cPurpose"]:checked') || {}).value,
      start_odometer: so, end_odometer: eo,
      start_address: CF.from.addr || CF.from.name, end_address: CF.to.addr || CF.to.name,
      start_lat: CF.from.lat, start_lng: CF.from.lng, end_lat: CF.to.lat, end_lng: CF.to.lng,
      visit_place: visit,
      parking_cost: park,
      toll: tollMode === 'amount' ? { mode: 'amount', amount: tollAmt } : tollMode === 'none' ? { mode: 'amount', amount: 0 } : { mode: 'unknown' },
      force: !!force, shift: !!shift,
    };
    var btn = $('btnCreateTrip'); if (btn) { btn.disabled = true; btn.textContent = '넣는 중…'; }
    apiRetry('/functions/v1/trip-create', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (btn) { btn.disabled = false; btn.textContent = '넣기'; }
        if (!res.ok || !res.j || !res.j.ok) {
          var j = res.j || {};
          // 뒤 운행과 겹치면 이후 운행을 밀어 올릴지 되묻는다(앱과 같은 동작)
          if (j.needShift && window.confirm(j.error + '\n\n이 운행을 넣고 이후 운행의 계기판을 밀어 올릴까요?')) { createTrip(force, true); return; }
          if (j.needConfirm && window.confirm(j.error + '\n\n그래도 이대로 넣으시겠습니까?')) { createTrip(true, shift); return; }
          if (!j.needShift) toast(j.error || '넣지 못했습니다.', true);
          return;
        }
        var note = '운행을 넣었습니다.' + (res.j.shifted ? ' 이후 운행 ' + res.j.shifted + '건의 계기판을 +' + n0(res.j.shiftKm) + 'km 밀었습니다.' : '');
        TRIP_CACHE = {};
        AUDIT = null;
        toastOk(note, res.j.warning);
        closePanel();
        loadAll();                            // 밀린 운행까지 서버 값으로 다시 받는다
      }).catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = '넣기'; }
        toast('서버에 연결하지 못했습니다.', true);
      });
  }

  function saveTrip(id, force) {
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

    if ($('eOdoS')) {                                    // 칸은 고칠 수 있는 사람(본인·관리자)에게만 그려진다
      var so = num($('eOdoS')), eo = num($('eOdoE'));
      var so0 = t.start_odometer == null ? null : Math.round(Number(t.start_odometer));
      var eo0 = t.end_odometer == null ? null : Math.round(Number(t.end_odometer));
      // ★ 계기판은 **바뀌었을 때만** 검사한다. 예전에는 늘 검사해서, 계기판이 비어 있는
      //   운행은 관리자가 목적만 고쳐도 '계기판 값을 넣어 주세요' 에서 막혔다(2026-09-23 검증로봇).
      if (so !== so0 || eo !== eo0) {
        if (so == null || eo == null) { toast('계기판 값을 넣어 주세요.', true); return; }
        if (eo < so) { toast('도착 계기판이 출발보다 작습니다.', true); return; }
        if (eo - so > 3000) { toast('한 운행에 3,000km 를 넘을 수 없습니다.', true); return; }
        patch.start_odometer = so; patch.end_odometer = eo;
      }
    }
    // 서버가 앞뒤 운행과 크게 벌어졌다고 되물은 뒤 '그래도 저장' 을 고른 경우.
    if (force) patch.force = true;

    if (!Object.keys(patch).length) { toast('바뀐 내용이 없습니다.'); closePanel(); return; }

    var btn = $('btnSaveTrip'); btn.disabled = true; btn.textContent = '저장 중…';
    apiRetry('/functions/v1/trip-edit', { method: 'POST', body: JSON.stringify({ id: Number(id), patch: patch }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = '저장';
        if (!res.ok || !res.j || !res.j.ok) {
          var j = res.j || {};
          // ★ 계기판이 앞뒤 운행과 크게 벌어지면 서버가 needConfirm 으로 되묻는다(createTrip 과 같다).
          //   예전에는 되물을 창이 없어, 한 사람의 여러 건이 줄줄이 틀린 경우(9/14 정정 때처럼)
          //   어느 건을 고쳐도 아직 틀린 이웃과 벌어져 전부 막혔다.
          if (j.needConfirm && window.confirm(j.error + '\n\n그래도 이대로 저장하시겠습니까?')) {
            saveTrip(id, true); return;
          }
          toast(j.error || '저장하지 못했습니다.', true); return;
        }
        // 서버가 되돌려 준 값으로 갈아끼운다 — 트리거가 값을 바꿨을 수 있다.
        var row = res.j.row || {};
        Object.keys(row).forEach(function (k) { if (k !== 'id') t[k] = row[k]; });
        AUDIT = null;
        TRIP_CACHE = {};                     // 다른 기간으로 갔다 왔을 때 고치기 전 값이 나오지 않게
        toastOk((res.j.changed || []).join('·') + ' 고쳤습니다.', res.j.warning);
        closePanel(); paintPills(); render();
      }).catch(function () {
        btn.disabled = false; btn.textContent = '저장';
        toast('서버에 연결하지 못했습니다.', true);
      });
  }

  var PANEL_FROM = null;                 // 패널을 연 버튼 — 닫을 때 그리로 돌려준다
  var CLOSE_ASK = null;                  // 닫기 전에 되묻는 동안 원래 아랫줄을 잠깐 맡아 둔다
  /** 패널에 쳐 넣은 것이 있는가 — 영수증 줄을 만들어 뒀거나, 운행 추가 칸을 채웠거나. */
  function panelDirty() {
    if (!$('panel').classList.contains('open')) return false;
    if ($('evDrop') && EVUP.items.length && !EVUP.sent) return true;
    if ($('btnCreateTrip')) {
      return ['cOdoE', 'cVisit', 'cPark', 'cToll'].some(function (id) {
        var el = $(id); return el && String(el.value || '').trim() !== '';
      });
    }
    if ($('apprWhy') && String($('apprWhy').value || '').trim()) return true;
    if (APPR_BACK && APPR_BACK.why.trim()) return true;       // 결재 문서를 보러 간 사이 — 적던 의견이 있다
    // 확장 모듈의 창(결재선·사람 고치기) — 실제로 바꾼 것이 있을 때만 되묻는다.
    if (EXT.dirty.some(function (fn) { try { return !!fn(); } catch (e) { return false; } })) return true;
    if (EVUP.busy) return true;                               // 영수증을 올리는 중
    return false;
  }
  /** 닫기 버튼·가림막·Esc 가 부른다. 쳐 넣은 것이 있으면 버리기 전에 한 번 묻는다.
   *  (예전에는 가림막을 스치기만 해도 영수증 10줄 금액이 사라졌다.) */
  function askClose() {
    // 서버로 올리는 중에는 닫지 못한다(절반만 올라간 채 목록을 잃는다). 파일을 읽는 중(PDF → 장)이면 닫을 수 있다 —
    // 읽기가 멈췄을 때 빠져나갈 길이 있어야 한다. 아래 panelDirty 가 되묻는다.
    if (EV_SENDING && $('evDrop')) { toast('영수증을 올리는 중입니다. 끝날 때까지 기다려 주세요.'); return; }
    if (!panelDirty()) { closePanel(); return; }
    // 창을 다시 그린 쪽(운행 추가의 '누구 운행' 등)이 되묻는 줄을 지웠을 수 있다 — 떠 있을 때만 '묻는 중'이다.
    if (CLOSE_ASK != null && $('btnKeep')) return;
    CLOSE_ASK = $('pFoot').innerHTML;
    $('pFoot').innerHTML = '<span class="dim" style="flex:1;font-size:12.5px">입력한 내용이 사라집니다. 닫을까요?</span>' +
      '<button class="btn" id="btnKeep">계속 입력</button><button class="btn pri" id="btnDiscard">버리고 닫기</button>';
    var k = $('btnKeep'); if (k) k.focus();
  }
  function closePanel() {
    CLOSE_ASK = null; APPR_BACK = null; SUBMIT.token = null; SUBMIT.send = null;
    if (!$('panel').classList.contains('open')) { PANEL_FROM = null; return; }
    // 영수증 올리기 창을 닫으면 그 목록은 끝난 것이다. 돌고 있던 파일 읽기·AI 판독이 닫힌 창을 위해 계속 돌지 않게
    // 목록을 새 객체로 바꾼다(읽기·판독은 자기 목록이 바뀐 것을 보고 멈춘다). 서버로 올리는 중이면 건드리지 않는다.
    if ($('evDrop') && !EV_SENDING) { evFreeUrls(); EVUP = { busy: false, items: [], pages: [], sent: false }; }
    $('panel').classList.remove('open');
    $('panel').classList.remove('wide');
    // 안 돌려주면 포커스가 <body> 로 떨어져 키보드로 쓰던 자리를 잃는다.
    if (PANEL_FROM && document.contains(PANEL_FROM)) { try { PANEL_FROM.focus(); } catch (e) {} }
    PANEL_FROM = null;
  }
  /* ── 창을 열면 포커스를 창 안으로 ──
     창은 여러 곳에서 열린다(openPanel 을 거치지 않는 창이 더 많다). 그래서 여는 쪽을 하나하나 고치지 않고
     '열림' 자체를 지켜본다. 여는 쪽이 이미 입력 칸에 포커스를 줬으면(반려 사유 등) 건드리지 않는다.
     Tab 이 창 밖(가려진 화면)으로 새지 않게 하는 것은 아래 keydown 이 한다. */
  (function () {
    var panel = $('panel'), sheet = $('pSheet');
    if (!panel || !sheet || !window.MutationObserver) return;
    var wasOpen = false;
    new MutationObserver(function () {
      var open = panel.classList.contains('open');
      if (open && !wasOpen && !sheet.contains(document.activeElement)) {
        try { sheet.focus({ preventScroll: true }); } catch (e) { }
      }
      wasOpen = open;
    }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  })();
  /** 창 안에서 Tab 으로 갈 수 있는 것들(보이는 것만). */
  function panelFocusables() {
    var sh = $('pSheet');
    if (!sh) return [];
    return Array.prototype.filter.call(
      sh.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'),
      function (n) { return !n.disabled && n.offsetParent !== null; });
  }

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
    if (isAll()) {
      // 관리 화면은 「보는 범위」(사업부·팀·파트)로 좁힌다 — 합계·점검·표가 모두 그 범위로 나온다.
      if (orgFilterOn() && ORGBAR_VIEWS.indexOf(VIEW) >= 0) {
        TRIPS = ALL_TRIPS.filter(function (t) { return orgMatch(t.username); });
        EVID = ALL_EVID.filter(function (e) { return orgMatch(e.username); });
      } else { TRIPS = ALL_TRIPS; EVID = ALL_EVID; }
      return;
    }
    var me = myName();
    TRIPS = ALL_TRIPS.filter(function (t) { return t.username === me; });
    EVID = ALL_EVID.filter(function (e) { return e.username === me; });
  }
  /** 「보는 범위」 줄을 얹는 관리 화면. */
  var ORGBAR_VIEWS = ['a_close', 'a_trips', 'a_check', 'a_evid', 'a_settle', 'a_safety', 'a_verify', 'a_final'];
  /* ── A안: 한 단계로 묶인 화면 사이의 탭, 단계 화면 맨 아래 '다음 단계' ── */
  var TAB_OF = { trips: 'rec', check: 'rec', a_trips: 'arec', a_check: 'arec', a_evid: 'arec', hipass: 'toll', tollfill: 'toll' };
  var TAB_SET = {
    rec: [['trips', '운행일지'], ['check', '기록 점검']],
    arec: [['a_trips', '운행일지'], ['a_check', '기록 점검'], ['a_evid', '영수증']],
    toll: [['evid', '← 영수증 차례로'], ['tollfill', '통행료 직접 채우기'], ['hipass', '하이패스 PDF 대조']]
  };
  var NEXT_OF = {
    trips: ['tollfill', '2 통행료로'], check: ['tollfill', '2 통행료로'],
    hipass: ['evid', '3 영수증으로'], tollfill: ['evid', '3 영수증으로'], evid: ['verify', '4 검증·상신으로']
  };
  function stepChrome(html) {
    var g = TAB_OF[VIEW];
    if (g && !isMulti()) {
      var tabs = '<nav class="vtabs" aria-label="이 단계의 화면">' + TAB_SET[g].map(function (x) {
        var on = x[0] === VIEW;
        return '<button type="button"' + (on ? ' aria-current="page"' : '') + ' class="' + (on ? 'on' : '') +
          '" data-v="' + x[0] + '">' + esc(x[1]) + '</button>';
      }).join('') + '</nav>';
      var i = html.indexOf('<div class="phead">'), j = i >= 0 ? html.indexOf('</div>', i) : -1;
      html = j >= 0 ? html.slice(0, j + 6) + tabs + html.slice(j + 6) : tabs + html;
    }
    if (ORGBAR_VIEWS.indexOf(VIEW) >= 0) {
      var oi = html.indexOf('<div class="phead">'), oj = oi >= 0 ? html.indexOf('</div>', oi) : -1;
      var at = oj >= 0 ? oj + 6 : 0;
      if (html.indexOf('<nav class="vtabs"', at) === at) at = html.indexOf('</nav>', at) + 6;   // 탭 줄 바로 아래
      html = html.slice(0, at) + orgBarHtml() + html.slice(at);
    }
    var sn = STEP_OF[VIEW];
    if (sn && sn <= 3 && !isAll() && !isMulti() && !cycleLocked(myName())) {
      var S = stepInfo(), p = Math.min(stepNow(), 3);
      var here = S.steps[sn - 1];
      var note = sn < p ? '<b>이미 지난 단계</b>입니다. 고친 뒤 「다음 단계」로 다시 넘어가세요.'
        : sn > p ? '앞 단계부터 진행해 주세요 — 지금은 <b>' + p + ' ' + esc(STEP_NAMES[p - 1]) + '</b> 단계입니다.'
        : here && here.n > 0 ? '이 단계에 남은 일: <b>' + esc(here.sub) + '</b> — 그래도 다음 단계로 갈 수 있습니다.'
        : '이 단계를 마쳤으면 <b>다음 단계</b>로 넘어가세요. 잘못 넘어갔으면 「이전 단계」로 돌아오면 됩니다.';
      html += '<div class="nextstep"><span class="stepbadge">' + sn + '</span><span class="t">' + note + '</span>' +
        // 아직 오지 않은 단계에서는 건너뛰지 못하게 — 지금 단계로 가는 버튼 하나만.
        (sn > p ? '<button class="btn pri" data-v="' + STEP_VIEW[p - 1] + '">' + p + ' ' + esc(STEP_NAMES[p - 1]) + '(지금 단계)로 →</button>' : '') +
        (sn > p ? '' : sn > 1 ? '<button class="btn" data-stepmove="-1" data-from="' + sn + '">← ' + (sn - 1) + ' ' + esc(STEP_NAMES[sn - 2]) + '</button>' : '') +
        // ★ 2단계(영수증·통행료)는 주차 → 통행료 → 주유 → 계기판 차례를 끝까지 지나야 3단계로 넘어간다(2026-10-07 사용자).
        //   맨 아래 버튼으로 바로 건너뛸 수 있어 헷갈렸다. 이미 지난 단계(sn < p)에서 돌아와 고치는 중이면 막지 않는다.
        (sn === 2 && sn === p && evSubMax() < 3
          ? '<span class="dim" style="font-size:12.5px">주차 → 통행료 → 주유 → 계기판을 차례로 마치면 3 검증·상신으로 넘어갈 수 있습니다.</span>'
          : sn < 3 && sn <= p ? '<button class="btn pri' + (sn === p ? ' cta' : '') + '" data-stepmove="1" data-from="' + sn + '">' +
            (sn + 1) + ' ' + esc(STEP_NAMES[sn]) + ' →</button>' : '') + '</div>';
    }
    // 단계를 옮겨 온 직후면 그 방향으로 밀려 들어오는 효과
    if (STEP_FX) { html = '<div class="stepfx ' + STEP_FX + '">' + html + '</div>'; STEP_FX = ''; }
    return html;
  }
  /** 관리 묶음은 평소 접어 둔다. 관리 화면에 있거나 펼쳐 둔 적이 있으면 편다. */
  var ADM_OPEN = (function () { try { return localStorage.getItem('drv.admopen') === '1'; } catch (e) { return false; } })();
  var ADM_CLICK_VIEW = '';      // 관리 화면에서 직접 접었으면 그 화면에 있는 동안은 접힌 채로 둔다
  function syncAdm() {
    var list = $('admList'), tog = $('admTog');
    if (!list || !tog) return;
    var open = ADM_OPEN || (!!list.querySelector('[data-v="' + VIEW + '"]') && ADM_CLICK_VIEW !== VIEW);
    list.classList.toggle('fold', !open);
    tog.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  /** 운행일지를 안 쓰고 결재만 하는 사람인가(2026-10-07, 포털 가입 때 고름). 관리자는 늘 전부 본다. */
  function noDriving() {
    if (!ME || ME.is_admin) return false;
    var u = USERS[myName()];
    return ME.uses_driving === false || !!(u && u.uses_driving === false);
  }
  var NODRV_VIEWS = ['inbox', 'account'];      // 결재만 하는 사람이 들어갈 수 있는 화면

  function render() {
    // 결재만 하는 사람은 결재함·내 계정만 — 다른 화면 주소로 와도 결재함으로 돌린다.
    var nd = noDriving();
    document.body.classList.toggle('nodrv', nd);
    if (nd && NODRV_VIEWS.indexOf(VIEW) < 0) { VIEW = 'inbox'; applyScope(); writeHash(); }
    // 적재가 실패했으면 스켈레톤 대신 사유와 다시 시도 버튼을 보여 준다.
    $('inner').innerHTML = LOAD_ERR
      ? '<section class="sect"><div class="panel" style="padding:34px 24px;text-align:center">' +
        '<div style="font-weight:700;margin-bottom:6px">' + esc(LOAD_ERR) + '</div>' +
        '<div class="dim" style="margin-bottom:16px">잠시 뒤 다시 시도해 주세요.</div>' +
        '<button class="btn pri" id="btnRetryLoad">다시 불러오기</button></div></section>'
      : (LOADED ? stepChrome((VIEWS[VIEW] || viewClose)()) : (VIEWS[VIEW] || viewClose)());
    Array.prototype.forEach.call($('nav').querySelectorAll('[data-v]'), function (a) {
      // 같은 단계로 묶인 화면(data-alt)에 있어도 그 단계 메뉴에 불이 들어온다.
      var on = a.dataset.v === VIEW || (a.dataset.alt || '').split(',').indexOf(VIEW) >= 0;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    syncAdm();
    var rt = $('btnRetryLoad');
    if (rt) rt.addEventListener('click', function () { LOAD_ERR = ''; loadAll(); });
    // 드롭존은 화면을 다시 그릴 때마다 새로 생기므로 그때마다 연결한다.
    bindDrop($('hpDrop'), hpFiles);
    afterPaint();
    // 정렬 머리를 눌러 다시 그렸으면 그 머리로 포커스를 돌려준다(키보드로 누르던 자리를 잃지 않게).
    if (SORT_FOCUS) {
      var sf = $('inner').querySelector('[data-sort="' + SORT_FOCUS + '"]');
      SORT_FOCUS = '';
      if (sf) { try { sf.focus(); } catch (e) { } }
    }
  }
  function go(v) {
    if (!VIEWS[v]) return;
    // 관리 화면은 관리자만. 주소를 직접 만져도 못 들어간다(서버 RLS 가 이중으로 막는다).
    if (ADMIN_VIEWS.indexOf(v) >= 0 && !(ME && ME.is_admin)) return;
    // 권한 관리는 관리자 중에서도 마스터 계정만(서버 RPC 가 그렇게 못 박혀 있다).
    if (v === 'perm' && !ACCT.can_manage_admin) return;
    if (noDriving() && NODRV_VIEWS.indexOf(v) < 0) v = 'inbox';
    VIEW = v;
    AUDIT = null;                 // 점검 결과는 범위가 바뀌면 다시 내야 한다
    clearFilters();
    if (v === 'evid' && !isMulti()) { EVF.cat = EV_SUBS[evSub()]; EVF.touched = false; }   // 영수증·통행료 단계: 지금 차례의 구분부터
    // ★ 하이패스 대조 결과도 반드시 버린다. 안 버리면 관리 화면에서 맞춰 둔
    //   남의 운행이 개인 화면에 그대로 남고(이름 칸은 사라져 남의 것인 줄도 모른다),
    //   '확정하기' 를 누르면 남의 운행에 통행료가 써진다.
    HP = { groups: [], batch: '', busy: false, note: '' };
    // ★ FILLS 는 여기서 버리지 않는다. 손으로 친 값이라, 하이패스를 잠깐 보러
    //   갔다는 이유로 40칸을 날리면 안 된다. 주기가 바뀔 때만 버린다(loadAll).
    applyScope();
    document.body.classList.remove('nav-open');
    writeHash();
    // 관리자가 개인 화면에서 여러 주기를 보다가(본인 것만 받아 둔 상태) 관리 화면으로 오면 전 직원 것을 받는다.
    if (LOADED && isAll() && !LOADED_ALL) { loadAll({ soft: true }); window.scrollTo({ top: 0 }); return; }
    render();
    window.scrollTo({ top: 0 });
  }
  /** 좁혀 둔 것을 전부 푼다(사람·차량·목적·검색·점검 칩·날짜·증빙 구분·나눠 보기). */
  function clearFilters() {
    FILT.who = ''; FILT.car = ''; FILT.q = ''; FILT.chip = 'all'; FILT.purp = BUSINESS;
    DATEF = { from: '', to: '' }; EVF.cat = 'all'; PAGES = {};
  }
  /** 주소(#)에 적힌 화면·기간으로 맞춘다. 기간이 바뀌었으면 true. */
  function applyHash(h) {
    var changed = false;
    var want = h.a ? (h.b && cmpCycle(h.a, h.b) !== 0 ? cycKey(h.a) + '~' + cycKey(h.b) : cycKey(h.a)) : '';
    if (h.a && want !== hashOf().split('/')[2]) {
      var before = hashOf().split('/')[2];
      if (h.b) setPeriod({ range: { from: h.a, to: h.b } }, { silent: true });
      else setPeriod({ cyc: h.a }, { silent: true });
      // 앞날의 주기를 주소에 적어 와도 이번 주기까지만 간다.
      if (!RANGE && cmpCycle(CYC, currentCycle()) > 0) setPeriod({ cyc: currentCycle() }, { silent: true });
      changed = hashOf().split('/')[2] !== before;
    }
    var v = h.view;
    if (VIEWS[v] && !(ADMIN_VIEWS.indexOf(v) >= 0 && !(ME && ME.is_admin)) && !(v === 'perm' && !ACCT.can_manage_admin)) {
      if (VIEW !== v) {
        VIEW = v; AUDIT = null; clearFilters();
        // go() 와 같은 이유 — 관리 화면에서 맞춰 둔 남의 대조 결과가 개인 화면에 남으면 안 된다.
        HP = { groups: [], batch: '', busy: false, note: '' };
      }
    }
    return changed;
  }
  window.addEventListener('hashchange', function () {
    // 뒤로·앞으로 가기. 우리가 방금 쓴 주소면 아무것도 하지 않는다.
    if (HASH_LOCK || !ME || location.hash === hashOf()) return;
    var h = readHash();
    if (!h) return;
    // 뒤로 가기로 기간이 바뀌는 경우도 같은 보호를 한다(주소만 제자리로 돌려놓는다).
    var target = h.a ? (h.b ? cycKey(h.a) + '~' + cycKey(h.b) : cycKey(h.a)) : '';
    if (target && target !== hashOf().split('/')[2] && unsavedFills()) {
      writeHash();
      toast('저장하지 않은 통행료 ' + n0(unsavedFills()) + '구간이 있습니다. 먼저 저장해 주세요.', true);
      return;
    }
    closePanel();
    if (applyHash(h)) { loadAll({ soft: true }); return; }
    applyScope();
    if (LOADED && isAll() && !LOADED_ALL) { loadAll({ soft: true }); return; }
    render();
  });

  // 새로고침·탭 닫기 — 쳐 놓은 것이 있으면 브라우저가 한 번 묻게 한다.
  window.addEventListener('beforeunload', function (e) {
    if (unsavedFills() || panelDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ══════════════════ 이벤트 ══════════════════ */
  document.addEventListener('click', function (e) {
    var el;
    // 패널이 닫혀 있을 때 누른 것이 곧 '연 버튼' 이다(닫을 때 포커스를 돌려준다).
    if (!$('panel').classList.contains('open')) {
      PANEL_FROM = e.target.closest('button,a,[tabindex],tr.clk') || null;
    }
    if (e.target.closest('#btnKeep')) {
      if (CLOSE_ASK != null) { $('pFoot').innerHTML = CLOSE_ASK; CLOSE_ASK = null; }
      // 되묻는 사이에 AI 판독이 끝났으면 올리기 버튼이 옛 상태('읽는 중…')로 되살아난다 — 다시 맞춘다.
      if ($('evDrop')) paintEvList();
      return;
    }
    if (e.target.closest('#btnDiscard')) { closePanel(); return; }
    if (e.target.closest('[data-close]')) { askClose(); return; }
    /* ── 기간 고르기 ── */
    if (e.target.closest('#cycBtn')) { openCyclePop(); return; }
    if (e.target.closest('#cycPrev')) { stepCycle(-1); return; }
    if (e.target.closest('#cycNext')) { stepCycle(1); return; }
    if (e.target.closest('#cpGo')) {
      var cf0 = parseCyc($('cpFrom').value), ct0 = parseCyc($('cpTo').value);
      if (cf0 && ct0) setPeriod({ range: { from: cf0, to: ct0 } });
      return;
    }
    if ((el = e.target.closest('[data-cyc]'))) {
      var c1 = parseCyc(el.dataset.cyc);
      // 창 안의 버튼(운행 상세의 'N월분 열어 고치기')에서 왔으면 창을 닫고 넘어간다.
      if (c1 && el.closest('#panel')) closePanel();
      if (c1) setPeriod({ cyc: c1 });
      return;
    }
    if ((el = e.target.closest('[data-prevx]'))) {
      // '지난달분 아직 상신 전' 안내를 이 브라우저에서 접는다(종이로 이미 낸 달일 수 있다).
      try { localStorage.setItem('drv.prevx', el.dataset.prevx); } catch (e2) { }
      render(); return;
    }
    if ((el = e.target.closest('[data-range]'))) {
      var rp = el.dataset.range.split('~'), ra = parseCyc(rp[0]), rb = parseCyc(rp[1]);
      if (ra && rb) setPeriod({ range: { from: ra, to: rb } });
      return;
    }
    // 펼침 창 바깥을 누르면 닫는다(누른 것은 그대로 처리한다).
    if (!$('cycPop').hidden && !e.target.closest('#cycleBox')) openCyclePop(false);
    /* ── 좁히기 · 정렬 · 나눠 보기 ── */
    if ((el = e.target.closest('[data-sort]'))) {
      var sp = el.dataset.sort.split(':'), sc = String(SORTS[sp[0]] || SORT_DEF[sp[0]] || '').split(':');
      SORTS[sp[0]] = sp[1] + ':' + (sc[0] === sp[1] ? -(+sc[1] || 1) : (+sp[2] || 1));
      SORT_FOCUS = el.dataset.sort;
      render(); return;
    }
    if ((el = e.target.closest('[data-more]'))) {
      var mp = el.dataset.more.split(':');
      PAGES[mp[0]] = mp[1] === 'all' ? 1e9 : (PAGES[mp[0]] || PAGE_SIZE) + PAGE_SIZE;
      render(); return;
    }
    if ((el = e.target.closest('[data-dq]'))) {
      var dq = el.dataset.dq.split(',');
      DATEF = { from: dq[0] || '', to: dq[1] || '' }; PAGES = {};
      render(); return;
    }
    if ((el = e.target.closest('[data-evcat]'))) { EVF.cat = el.dataset.evcat; EVF.touched = true; render(); return; }
    if (e.target.closest('[data-fclear]')) { clearFilters(); render(); return; }
    if ((el = e.target.closest('[data-inboxf]'))) { INBOX_F = el.dataset.inboxf; render(); return; }
    // PDF 미리보기 — 창에서 고른 목적을 먼저 반영한다. PDF 는 이어서 drv-verify.js 가 만든다.
    if (e.target.closest('[data-pdf]')) {
      if (document.querySelector('#panel.open input[name="ppurp"]')) {
        var pk = Array.prototype.slice.call(document.querySelectorAll('input[name="ppurp"]:checked'))
          .map(function (x) { return x.value; });
        if (!pk.length) { toast('담을 운행을 한 가지 이상 고르세요.', true); e.stopImmediatePropagation(); return; }
        PRINT_PURPOSES = pk;
      } else {
        PRINT_PURPOSES = [BUSINESS];
      }
    }
    if ((el = e.target.closest('[data-v]'))) { go(el.dataset.v); return; }
    if ((el = e.target.closest('[data-chip]'))) { FILT.chip = el.dataset.chip; render(); return; }
    if ((el = e.target.closest('[data-issue]'))) {
      // go() 가 필터를 비우므로 반드시 go() **뒤에** 넣어야 한다. 예전에는 앞에 넣어
      // 필터가 날아갔고, 화면도 개인 운행일지로 못 박혀 있어 전체 점검에서 누르면
      // 보러 간 건이 한 건도 안 보였다.
      var issue = el.dataset.issue;
      // 미확정 통행료는 한 건씩 여는 운행일지가 아니라 구간별로 묶어 채우는 화면으로.
      if (issue === 'unk' && !isAll()) { go('tollfill'); return; }
      go(isAll() ? 'a_trips' : 'trips');
      FILT.chip = issue; FILT.who = ''; FILT.purp = '';   // 점검 항목은 목적과 관계없이 다 보인다
      render(); return;
    }
    if ((el = e.target.closest('[data-edit]'))) { openEdit(el.dataset.edit); return; }
    if (e.target.closest('#btnSaveTrip')) { saveTrip(e.target.closest('#btnSaveTrip').dataset.id); return; }
    if (e.target.closest('#btnAddTrip')) { openCreate(); return; }
    /* ── 하이패스 대조 ── */
    if ((el = e.target.closest('[data-hpapply]'))) { hpApply(+el.dataset.hpapply); return; }
    if ((el = e.target.closest('#btnHpOverGo'))) { closePanel(); hpApply(+el.dataset.gi, true); return; }
    if (e.target.matches('[data-hpall]')) {
      var gi = +e.target.dataset.hpall, on = e.target.checked;
      // 접어 둔(이미 같은) 줄은 표에 없으니 건드리지 않는다. 안 그러면 "남은 것 3건 ·
      // 선택 7건" 처럼 보이는 것보다 많이 잡히고, 같은 값을 서버에 다시 쓴다.
      (HP.groups[gi].matched || []).forEach(function (x) {
        if (!x.locked && x.kind !== 'same') x.pick = on;
      });
      render(); return;
    }
    if (e.target.matches('[data-hppick]')) {
      var p = e.target.dataset.hppick.split('.');
      var ent = HP.groups[+p[0]].matched[+p[1]];
      if (ent.locked) { e.target.checked = false; return; }
      ent.pick = e.target.checked;
      // ★ render() 를 부르지 않는다. 화면을 통째로 갈아끼우면 표가 맨 위로 튀고
      //   포커스와 펼쳐 둔 목록이 사라진다. 바뀐 숫자만 고쳐 쓴다.
      paintHpCount();
      return;
    }

    if (e.target.closest('#btnCreateTrip')) { createTrip(false); return; }
    if (e.target.closest('[data-odoshot]')) { setEvSub(3); go('evid'); return; }   // 영수증 › 계기판 차례로 바로
    if ((el = e.target.closest('[data-evlink]'))) { openEvLink(el.dataset.evlink); return; }
    if (e.target.closest('#btnEvLinkSave')) { saveEvLink(); return; }
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
    if (e.target.closest('#btnEvUp')) { openEvUpload(VIEW === 'evid' ? EV_SUBS[evSub()] : ''); return; }
    if ((el = e.target.closest('[data-evupcat]'))) { openEvUpload(el.dataset.evupcat); return; }
    if ((el = e.target.closest('[data-evsub]'))) {
      var ni = +el.dataset.evsub, ci = evSub();
      setEvSub(ni, ni > ci ? 'fwd' : ni < ci ? 'back' : ''); render(); return;
    }
    if ((el = e.target.closest('[data-evsubmove]'))) {
      var d = +el.dataset.evsubmove, ti = evSub() + d;
      setEvSub(ti, d > 0 ? 'fwd' : 'back');
      toast(d > 0 ? (ti + 1) + '/4 ' + EV_SUBS[ti] + ' 차례입니다.' : (ti + 1) + '/4 ' + EV_SUBS[ti] + ' 차례로 돌아왔습니다.');
      render(); return;
    }
    if (e.target.closest('#btnEvGo')) { runEvUpload(); return; }
    if ((el = e.target.closest('[data-evrm]'))) {
      if (EVUP.busy) return;
      evRead();                                   // 다시 그리기 전에 쳐 넣은 값을 지킨다
      var rm = EVUP.items.splice(+el.dataset.evrm, 1)[0];
      if (rm && rm.crop && rm.crop.url) URL.revokeObjectURL(rm.crop.url);
      paintEvList(); return;
    }
    if ((el = e.target.closest('[data-evadd]'))) {
      // 같은 장에 영수증이 더 있을 때 — 바로 아래에 같은 장을 가리키는 빈 줄을 놓는다.
      if (EVUP.busy) return;
      evRead();
      var ai0 = +el.dataset.evadd, src0 = EVUP.items[ai0];
      if (src0) {
        var nu = evBlankItem(src0.page);
        nu.cat = src0.cat; nu.date = src0.date;
        EVUP.items.splice(ai0 + 1, 0, nu);
        paintEvList();
        var ne = document.querySelector('[data-evrow="' + (ai0 + 1) + '"] [data-evamt]');
        if (ne) ne.focus();
      }
      return;
    }
    if ((el = e.target.closest('[data-evskip]'))) {
      // AI 를 기다리지 않고 직접 넣는다(늦게 온 AI 답은 버려진다).
      var sp0 = EVUP.pages[+el.dataset.evskip];
      if (sp0) sp0.ai = '';
      evRead(); paintEvList(); return;
    }
    if (e.target.closest('#evFill')) {
      // 스캔 10장이면 구분·날짜가 대개 같다. 첫 줄 값을 아래로 내려 준다.
      evRead();
      var f0 = EVUP.items[0];
      if (f0) {
        // ★ 금액은 복사하지 않는다. 영수증마다 다른데 복사해 두면 못 고친 채로
        //   올라가 그 금액이 그대로 정산에 들어간다. 구분·날짜만 내린다.
        // ★ 빈 칸만 채운다. AI 가 주차·주유로 나눠 읽어 둔 것을 한 번에 덮으면 주유 5만 원이 주차로 바뀌어 정산에 더해진다.
        var filled = 0;
        EVUP.items.forEach(function (x, i) {
          if (!i) return;
          if (!x.cat && f0.cat) { x.cat = f0.cat; filled++; }
          // ★ AI 가 일부러 비운 날짜(사진 날짜가 주기 밖이거나 못 읽음)는 채우지 않는다 — 사람이 정해야 한다.
          //   채워 버리면 7월 영수증이 9월분 정산에 들어간다.
          if (!x.date && f0.date && !x.ai) { x.date = f0.date; filled++; }
        });
        paintEvList();
        toast(filled ? '비어 있던 구분·날짜를 첫 줄 값으로 채웠습니다.' : '채울 빈 칸이 없습니다.');
      }
      return;
    }
    if ((el = e.target.closest('[data-evdel]'))) { evDelete(el.dataset.evdel); return; }
    if ((el = e.target.closest('#btnEvDelGo'))) { runEvDelete(el.dataset.id); return; }
    if (e.target.closest('#btnCsv')) { downloadCsv(); return; }
    if ((el = e.target.closest('#btnXlsxGo'))) {
      // 고른 목적을 먼저 반영한 뒤 엑셀을 만든다.
      var picked = Array.prototype.slice
        .call(document.querySelectorAll('input[name="ppurp"]:checked'))
        .map(function (x) { return x.value; });
      if (!picked.length) { toast('담을 운행을 한 가지 이상 고르세요.', true); return; }
      PRINT_PURPOSES = picked;
      var who = el.dataset.who;
      closePanel();
      downloadXlsx(who);
      return;
    }
    if ((el = e.target.closest('#btnPrintPaper'))) { runPrint(el.dataset.who); return; }
    if (e.target.closest('#btnPwSave')) { savePassword(); return; }
    if (e.target.closest('#btnSignSave')) { if (SIGN_DRAFT) saveSign(SIGN_DRAFT); return; }
    if (e.target.closest('#btnSignCancel')) { SIGN_DRAFT = null; render(); return; }
    if (e.target.closest('#btnSignReset')) { saveSign(null); return; }
    if ((el = e.target.closest('[data-addappr]'))) { addApprover(el.dataset.addappr); return; }
    // ★ render() 를 부르지 않는다. 표를 다시 그리면 스크롤이 맨 위로 튀어
    //   47줄짜리를 채우려면 매번 다시 내려가야 했다(하이패스 쪽과 같은 이유).
    if ((el = e.target.closest('[data-tffree]'))) {
      tfRead();
      var i1 = +el.dataset.tffree, gf = TF_GROUPS[i1];
      if (gf) { FILLS[gf.key] = 0; tfPaintRow(i1); tfPaintSum(); }
      return;
    }
    if ((el = e.target.closest('[data-tfhint]'))) {
      tfRead();
      var i2 = +el.dataset.tfhint, gh = TF_GROUPS[i2];
      if (gh) { FILLS[gh.key] = gh.hint; tfPaintRow(i2); tfPaintSum(); }
      return;
    }
    if (e.target.closest('#tfAllFree')) { openAllFree(); return; }
    if (e.target.closest('#btnAllFreeGo')) {
      var marked = 0, doneNow = 0;
      TF_GROUPS.forEach(function (x) {
        if (FILLS[x.key] == null) { FILLS[x.key] = 0; marked += x.rows.length; }
        doneNow += x.rows.length;
      });
      closePanel(); render();              // 전부 바뀌므로 이때는 다시 그린다
      // 패널 버튼이 완료형이라 '끝났다' 로 읽힌다 — 아직 저장 전임을 말한다.
      toast(n0(marked) + '건을 없음으로 표시했습니다. 아래 「' + n0(doneNow) + '건 저장」을 눌러야 저장됩니다.');
      return;
    }
    if (e.target.closest('#tfSave')) { tfSave(); return; }
    if ((el = e.target.closest('[data-perm]'))) {
      openPermConfirm('admin', el.dataset.perm, el.dataset.on === '1'); return;
    }
    if ((el = e.target.closest('[data-pwreset]'))) {
      openPermConfirm('pw', el.dataset.pwreset, false); return;
    }
    if ((el = e.target.closest('[data-signup]'))) { openSignupConfirm(el.dataset.signup, el.dataset.ok === '1'); return; }
    if ((el = e.target.closest('#btnSignupGo'))) { decideSignup(el.dataset.u, el.dataset.ok === '1'); return; }
    if ((el = e.target.closest('[data-permmgr]'))) {
      openPermConfirm('mgr', el.dataset.permmgr, el.dataset.on === '1'); return;
    }
    if ((el = e.target.closest('#btnPermGo'))) {
      runPerm(el.dataset.kind, el.dataset.target, el.dataset.on === '1'); return;
    }
    if (e.target.closest('#burger')) { document.body.classList.toggle('nav-open'); return; }
    // 내 프로필 버튼은 개인 자리다 — 관리 화면으로 보내지 않는다(직원 현황은 관리 메뉴에 있다).
    if (e.target.closest('#uBtn')) { go('account'); return; }
    if ((el = e.target.closest('[data-stepmove]'))) { moveStep(+el.dataset.from, +el.dataset.stepmove); return; }
    if (e.target.closest('#admTog')) {
      ADM_OPEN = $('admList').classList.contains('fold'); ADM_CLICK_VIEW = ADM_OPEN ? '' : VIEW;
      try { localStorage.setItem('drv.admopen', ADM_OPEN ? '1' : '0'); } catch (er) { }
      syncAdm(); return;
    }

    /* ── 결재 ── */
    if (e.target.closest('#btnOpenSubmit')) { openSubmit(); return; }
    if ((el = e.target.closest('[data-orgteam]'))) {
      var tp = el.dataset.orgteam.split('|'); ORGF = { div: tp[0] || '-', team: tp[1] || '', unit: '' }; saveOrgF();
      PAGES = {}; AUDIT = null; applyScope(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return;
    }
    if ((el = e.target.closest('[data-orgunit]'))) { ORGF.unit = el.dataset.orgunit; saveOrgF(); PAGES = {}; AUDIT = null; applyScope(); render(); return; }
    if (e.target.closest('#ofClear')) { ORGF = { div: '', team: '', unit: '' }; saveOrgF(); PAGES = {}; AUDIT = null; applyScope(); render(); return; }
    if (e.target.closest('#btnPrevLine')) {
      var pv = previousSteps();
      if (pv) { DRAFT = pv.slice(); APPR_Q = ''; APPR_BOX = ''; renderSubmit(); }
      return;
    }
    if (e.target.closest('#btnApprPdf')) { doPrint(); return; }
    // 결재란 칸 — 빈칸을 누르면 그 칸에 넣을 이름을 받는다. × 는 그 칸을 비운다(빗금 · 건너뜀).
    if ((el = e.target.closest('[data-agbox]'))) {
      APPR_BOX = el.dataset.agbox; APPR_Q = ''; renderSubmit();
      var qb = $('apprQ'); if (qb) qb.focus();
      return;
    }
    if ((el = e.target.closest('[data-agclr]'))) {
      var cb = el.dataset.agclr;
      DRAFT = DRAFT.filter(function (s) { return s.box !== cb; });
      APPR_BOX = cb; APPR_Q = ''; renderSubmit();
      var qc = $('apprQ'); if (qc) qc.focus();
      return;
    }
    if (e.target.closest('#btnSubmitAppr')) {
      var bad = DRAFT.filter(function (s) { return !s.approver; });
      if (!DRAFT.length) { toast('결재받을 분을 한 칸 이상 넣어 주세요.', true); return; }
      if (bad.length) { toast('아직 고르지 않은 결재자가 있습니다.', true); return; }
      var sb = $('btnSubmitAppr');
      if (sb.disabled) return;
      // ★ 주기(21일~20일)가 끝나기 전이면 한 번 묻는다 — 상신하면 그 뒤 운행·영수증은 결재 문서에 들어가지 않는다
      //   (2026-10-02 사용자 결정: 막지 않고 되묻고 허용). 「그래도 상신」 을 누르면 data-early 로 다시 들어온다.
      var rEnd = cycleRange(CYC.y, CYC.m).hi;
      if (Date.now() < rEnd && !sb.dataset.early) {
        var endD = md(rEnd - 1);
        $('pFoot').innerHTML = '<span class="st warn" style="flex:1;white-space:normal">아직 주기 중입니다(' + esc(endD) +
          '까지). 지금 상신하면 이후 운행·영수증은 결재 문서에 들어가지 않습니다. 그래도 상신할까요?</span>' +
          '<button class="btn" data-close>취소</button>' +
          '<button class="btn pri" id="btnSubmitAppr" data-early="1">그래도 상신</button>';
        return;
      }
      sb.disabled = true; sb.textContent = '검증하는 중…';
      var cyc0 = CYCKEY();
      // 창을 닫거나(취소·Esc) 결재선을 고쳐 창을 다시 그리면 이 표가 바뀐다 —
      // 검증이 끝난 뒤에, 다시 누르지도 않았는데 말없이 상신되지 않게.
      var token = SUBMIT.token = {};
      var alive = function () { return SUBMIT.token === token && $('panel').classList.contains('open'); };
      // 창이 닫혔을 때만 '취소했다'고 말한다. 결재선을 고쳐 다시 그린 것이면 화면에 「상신」 버튼이 돌아와 있다.
      var gone = function () { if (!$('panel').classList.contains('open')) toast('상신을 취소했습니다.'); };
      var send = function () {
        if (!alive()) { gone(); return; }
        // ★ 결재선은 보내는 순간의 화면에서 읽는다. 누른 순간에 만들어 두면, '그대로 상신할까요?' 가 떠 있는 동안
        //   결재란 칸을 바꿔도 옛 결재선으로 올라간다(2026-10-02 재검증).
        if (!DRAFT.length || DRAFT.some(function (s) { return !s.approver; })) {
          toast('결재선을 다시 확인해 주세요.', true); renderSubmit(); return;
        }
        var payload = {
          action: 'submit', cycle: cyc0,
          steps: DRAFT.map(function (s) { return { approver: s.approver, box: s.box }; })
        };
        var b = $('btnSubmitAnyway') || sb;
        if (document.contains(b)) { b.disabled = true; b.textContent = '상신하는 중…'; }
        callAppr(payload, '상신했습니다.').then(function (ok) {
          // 상신되면 그 주기는 잠긴다 — 통행료 채우기에 쳐 둔 값은 더 저장할 수 없다.
          if (ok) { FILLS = {}; delete DRAFT_KEEP[cyc0]; }
          if (!ok && document.contains(b)) { b.disabled = false; b.textContent = b.id === 'btnSubmitAnyway' ? '그대로 상신' : '상신'; }
        });
      };
      SUBMIT.send = send;
      // 검증·사진 판독이 실패해도 상신은 한다(불일치는 표시만 — 2026-10-01 결정).
      // 다만 '맞지 않는 곳'이 있으면 잠기기 전에 한 번 보여 준다 — 상신 뒤에 알면 회수해야 한다.
      (EXT.beforeSubmit
        ? EXT.beforeSubmit(function (t) { if (alive() && document.contains(sb)) sb.textContent = t + '…'; })
        : Promise.resolve(null)).then(function (sum) {
        if (!alive()) { gone(); return; }
        if (sum && sum.bad > 0) {
          $('pFoot').innerHTML = '<span class="st bad" style="flex:1;white-space:normal">검증에서 맞지 않는 곳이 ' +
            n0(sum.bad) + '건 있습니다. 그대로 상신할까요?</span>' +
            '<button class="btn" data-close>취소</button>' +
            '<button class="btn" id="btnSeeVerify">검증 결과 보기</button>' +
            '<button class="btn pri" id="btnSubmitAnyway">그대로 상신</button>';
          return;
        }
        send();
      }, send);
      return;
    }
    if (e.target.closest('#btnSubmitAnyway')) { if (SUBMIT.send) SUBMIT.send(); return; }
    if (e.target.closest('#btnSeeVerify')) { closePanel(); go('verify'); return; }
    if (e.target.closest('#btnBackAppr')) {
      var bk = APPR_BACK; APPR_BACK = null;
      if (bk) { openApprAct(bk.act, bk.id); if ($('apprWhy')) $('apprWhy').value = bk.why; }
      return;
    }
    if ((el = e.target.closest('[data-appr]'))) { openApprAct(el.dataset.appr, +el.dataset.id); return; }
    if ((el = e.target.closest('#btnApprGo'))) {
      var act = el.dataset.act, id = +el.dataset.id;
      var why = String(($('apprWhy') || {}).value || '').trim();
      if ((act === 'reject' || act === 'force_reject' || act === 'reopen') && !why) {
        toast(act === 'reopen' ? '정정 사유를 적어 주세요.' : '반려 사유를 적어 주세요.', true); if ($('apprWhy')) $('apprWhy').focus(); return;
      }
      if (el.disabled) return;
      el.disabled = true;
      var p2 = { action: act, id: id };
      if (why && act !== 'withdraw') p2.comment = why;
      callAppr(p2).then(function (ok) { if (!ok && document.contains(el)) el.disabled = false; });
      return;
    }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'signFile') {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 20e6) { toast('파일이 너무 큽니다(20MB 이하).', true); return; }
      toast('서명을 읽는 중…');
      fileToSign(f).then(function (png) { SIGN_DRAFT = png; render(); },
        function (err) { toast((err && err.message) || '서명을 읽지 못했습니다.', true); });
      return;
    }
    if (e.target.id === 'ofDiv' || e.target.id === 'ofTeam' || e.target.id === 'ofUnit') {
      setOrgF(e.target.id === 'ofDiv' ? 'div' : e.target.id === 'ofTeam' ? 'team' : 'unit', e.target.value);
      FILT.who = ''; PAGES = {}; AUDIT = null; applyScope(); renderKeepFocus(e.target.id); return;
    }
    if (e.target.id === 'selWho') { FILT.who = e.target.value; PAGES = {}; renderKeepFocus('selWho'); return; }
    if (e.target.id === 'selPurp') { FILT.purp = e.target.value; PAGES = {}; renderKeepFocus('selPurp'); return; }
    if (e.target.id === 'dfFrom' || e.target.id === 'dfTo') {
      var dv = e.target.value || '';
      if (e.target.id === 'dfFrom') DATEF.from = dv; else DATEF.to = dv;
      PAGES = {};
      // ★ 화면 전체를 다시 그리지 않는다. 날짜를 키보드로 치면 칸(연·월·일)마다 change 가 나는데,
      //   입력 칸을 갈아 끼우면 포커스가 첫 칸으로 돌아가 칠 수가 없다. 그 아래만 다시 그린다.
      paintBelow(); return;
    }
    if (e.target.id === 'selCar') { FILT.car = e.target.value; renderKeepFocus('selCar'); return; }
    if (e.target.id === 'hpFile') { hpFiles(e.target.files); return; }
    if (e.target.id === 'evFile') { evAddFiles(e.target.files); e.target.value = ''; return; }
    if (e.target.dataset && e.target.dataset.hpcar !== undefined) {
      var g = HP.groups[+e.target.dataset.hpcar];   // 아래에서 재배분 후 잠금 표시를 다시 단다
      g.plate = e.target.value || null;
      hpMarkLocked([window.Hipass.assign(g, TRIPS)]);
      render(); return;
    }
    if (e.target.id === 'cPlate') {
      var etc = $('cPlateEtc'); if (etc) etc.hidden = e.target.value !== '__etc__';
      if (etc && !etc.hidden) etc.focus();
      return;
    }
    // ── 상신 창 ──
  });
  // 날짜 좁히기: 끝을 시작보다 앞으로 넣으면 조건은 바로잡아 걸리는데(dateBounds) 칸에는 거꾸로 남는다.
  // 치는 도중에 칸 값을 바꾸면 방해가 되므로, 칸을 떠날 때 보이는 순서를 맞춘다.
  document.addEventListener('focusout', function (e) {
    if (e.target.id !== 'dfFrom' && e.target.id !== 'dfTo') return;
    var b = dateBounds();
    if (b.from && b.to && DATEF.from > DATEF.to) {
      DATEF = { from: b.from, to: b.to };
      var f1 = $('dfFrom'), t1 = $('dfTo');
      if (f1) f1.value = b.from;
      if (t1) t1.value = b.to;
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
      // 표를 다시 그리면 커서가 튄다 — 그 줄 표시와 요약 줄만 고쳐 쓴다.
      tfRead();
      var tr2 = e.target.closest('tr');
      var g2 = TF_GROUPS[+e.target.dataset.tfamt];
      if (tr2) tr2.className = (g2 && FILLS[g2.key] != null) ? 'tfdone' : '';
      tfPaintSum();
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
    // 창이 열려 있으면 Tab 은 창 안에서만 돈다. 가려진 뒤 화면으로 새면 어디에 있는지 알 수 없다.
    if (e.key === 'Tab' && $('panel').classList.contains('open')) {
      var fs = panelFocusables(), sh = $('pSheet'), cur = document.activeElement;
      if (fs.length) {
        var first = fs[0], last = fs[fs.length - 1];
        if (!sh.contains(cur) || cur === sh) {
          // 창에 막 들어왔다 — 머리의 닫기 버튼보다 본문·아랫줄의 첫 칸이 먼저다.
          var inBody = fs.filter(function (n) { return $('pBody').contains(n) || $('pFoot').contains(n); })[0];
          e.preventDefault(); (e.shiftKey ? last : (inBody || first)).focus(); return;
        }
        if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); return; }
        if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); return; }
      }
    }
    // tabindex 만 주면 눌리지 않는다 — Enter·Space 를 클릭으로 바꿔 준다.
    if ((e.key === 'Enter' || e.key === ' ') &&
        e.target.matches && e.target.matches('a[data-v],tr.clk,tr[data-person],tr[data-car]')) {
      e.preventDefault(); e.target.click(); return;
    }
    if (e.key === 'Escape') {
      if (!$('cycPop').hidden) { openCyclePop(false); return; }
      askClose(); document.body.classList.remove('nav-open');
    }
    // [ ] 로 앞뒤 주기 — 글자를 치는 중이거나 창이 열려 있으면 건드리지 않는다.
    if ((e.key === '[' || e.key === ']') && ME && !e.ctrlKey && !e.metaKey && !e.altKey &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '') &&
        !$('panel').classList.contains('open')) {
      e.preventDefault(); stepCycle(e.key === '[' ? -1 : 1); return;
    }
    if (e.key === 'Enter' && (e.target.id === 'u' || e.target.id === 'p')) doLogin();
    if (e.key === 'Enter' && /^pw(Cur|New|New2)$/.test(e.target.id)) { e.preventDefault(); savePassword(); return; }
    // 결재자 찾기 — Enter 로 맨 위 후보를 넣는다.
    if (e.key === 'Enter' && e.target.id === 'apprQ') {
      e.preventDefault();
      // ★ 한글 조합을 끝내는 Enter(맥은 신호가 두 번 온다)와 빈 검색어 Enter 는 무시한다 —
      //   예전에는 아무것도 안 친 채 Enter 를 누르면 가나다순 첫 직원이 결재자로 들어갔다.
      if (e.isComposing || e.keyCode === 229 || !APPR_Q.trim()) return;
      var top = apprCandidates()[0];
      if (top) addApprover(top);
      return;
    }
    // '/' 로 검색창에 바로 간다
    if (e.key === '/' && (VIEW === 'trips' || VIEW === 'a_trips') && !$('panel').classList.contains('open') &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      var b = $('qBox'); if (b) { e.preventDefault(); b.focus(); b.select(); }
    }
  });
  $('loginBtn').addEventListener('click', doLogin);
  /** 로그인은 업무 결재 포털(work.html)에서 한다(2026-10-06). next = 로그인 뒤 돌아올 운행일지 화면(#/…). */
  function toPortal(next) {
    var n = /^#\/[A-Za-z0-9_\/~-]*$/.test(next || '') ? next : '';   // ~ = 기간 범위 주소(2026-08~2026-10)
    location.replace('work.html' + (n ? '?next=' + encodeURIComponent(n) : ''));
  }
  function signOut(e) {
    // 서버의 갱신 토큰도 끊는다(2026-10-06). 응답을 기다리지 않는다.
    var at = ss(K_AT);
    if (at) { try { fetch(SB + '/auth/v1/logout?scope=local', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + at }, keepalive: true }).catch(function () { }); } catch (e) { } }
    ss(K_AT, null); ss(K_RT, null); ss(K_ME, null);
    // 직접 로그아웃이면 포털 첫 화면, 로그인이 만료된 것이면 다시 로그인한 뒤 보던 화면으로 돌아오게.
    toPortal(e && e.type === 'click' ? '' : location.hash);
  }
  $('logoutBtn').addEventListener('click', signOut);

  /* ══════════════════ 결재 문서(PDF·엑셀) 재료 ══════════════════
     PDF 는 sheetpdf.js 가 그린다. 여기서는 '무엇을 그릴지'만 만든다 —
     기록부 모델은 엑셀과 같은 sheetDataFor() 를 그대로 쓴다(금액 규칙을 다시 짜지 않는다). */

  /** 그 사람·그 주기의 결재 건. */
  function apprOf(u, cyc) {
    return APPR.filter(function (a) { return a.username === u && a.cycle === cyc; })[0] || null;
  }
  /** 결재란 — printSheet 와 같은 규칙. 승인한 칸에만 이름·날짜를 찍는다(안 한 칸은 비움, 없는 칸은 빗금). */
  /* ══════════════════ 결재 서명 (2026-10-02) ══════════════════
     기본은 이름으로 그린 빨간 원형 도장. 「내 계정」에서 서명·도장 파일(jpg·png·pdf)을 올리면 그것을 쓴다.
     서버(approval-act)가 상신·승인하는 순간의 서명 행 id 를 결재 건에 적는다(snapshot.sign_id, steps[].sign_id)
     — 나중에 서명을 바꿔도 이미 결재된 문서는 그대로다. id 가 없으면(기본 도장·예전 건) 이름 도장. */
  var SIGNS = {};          // 서명 행 id → PNG data URL ('' = 받았는데 비어 있음)
  var SIGN_ASKED = {};     // 받으러 간 id — 같은 id 를 두 번 받지 않는다
  var STAMPS = {};         // 이름 → 도장 PNG data URL
  var MYSIGN;              // 내 마지막 서명 행 { id, image } · null = 없음 · undefined = 아직 안 받음
  var SIGN_DRAFT = null;   // 올리기 전 미리보기 PNG

  /** 이름 도장 — 빨간 원 안에 흰 글씨(성명 + '인'). 세 글자면 「김윤/수인」 두 줄. */
  function stampPng(name) {
    name = String(name || '').replace(/\s+/g, '');
    if (!name) return '';
    if (STAMPS[name]) return STAMPS[name];
    var ch = Array.from(name), lines;
    if (ch.length <= 2) lines = [ch.join(''), '인'];
    else if (ch.length === 3) lines = [ch[0] + ch[1], ch[2] + '인'];
    else if (ch.length === 4) lines = [ch[0] + ch[1], ch[2] + ch[3], '인'];
    else lines = [ch.slice(0, Math.ceil(ch.length / 2)).join(''), ch.slice(Math.ceil(ch.length / 2)).join('') + '인'];
    var S = 240, cv = document.createElement('canvas'); cv.width = cv.height = S;
    var g = cv.getContext('2d');
    g.fillStyle = '#E2353B';
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); g.fill();
    var widest = lines.reduce(function (m, l) { return Math.max(m, Array.from(l).length); }, 1);
    var fs = Math.floor(Math.min(S * 0.62 / widest, S * (lines.length > 2 ? 0.25 : 0.33)));
    g.fillStyle = '#FFFFFF'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '700 ' + fs + 'px "Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif';
    var lh = fs * 1.02, y0 = S / 2 - lh * (lines.length - 1) / 2 + fs * 0.04;
    lines.forEach(function (l, i) { g.fillText(l, S / 2, y0 + i * lh); });
    return (STAMPS[name] = cv.toDataURL('image/png'));
  }
  /** 서명 행들을 받아 둔다(이미 받았거나 받으러 간 것은 건너뜀). */
  function loadSigns(ids) {
    var need = (ids || []).filter(function (id) { return id && SIGNS[id] === undefined && !SIGN_ASKED[id]; });
    if (!need.length) return Promise.resolve();
    need.forEach(function (id) { SIGN_ASKED[id] = 1; });
    return fetchAll('/rest/v1/driving_signatures?select=id,image&id=in.(' + need.join(',') + ')')
      .then(function (rows) {
        (rows || []).forEach(function (r) { SIGNS[r.id] = r.image || ''; });
        need.forEach(function (id) { if (SIGNS[id] === undefined) SIGNS[id] = ''; });
      }).catch(function () { need.forEach(function (id) { delete SIGN_ASKED[id]; }); });
  }
  function loadMySign() {
    if (!myName()) return Promise.resolve();
    return apiRetry('/rest/v1/driving_signatures?select=id,image&username=eq.' + encodeURIComponent(myName()) +
      '&order=id.desc&limit=1').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (!rows) return;
        MYSIGN = rows[0] || null;
        if (MYSIGN) SIGNS[MYSIGN.id] = MYSIGN.image || '';
      }).catch(function () { });
  }
  /** 결재란 한 칸에 찍을 그림. 올린 서명이 있으면 그것, 아니면 이름 도장. */
  function signOf(v) {
    if (!v || !v.name) return '';
    return (v.signId && SIGNS[v.signId]) || stampPng(v.name);
  }
  /** 문서 재료(pdfDocFor)의 결재란 칸마다 서명 그림을 채운다 — PDF 를 만들기 직전에 부른다. */
  function fillSigns(doc) {
    var ids = [];
    (doc && doc.sheets || []).forEach(function (sh) {
      Object.keys(sh.boxes || {}).forEach(function (k) { var v = sh.boxes[k]; if (v && v.signId) ids.push(v.signId); });
    });
    return loadSigns(ids).then(function () {
      (doc && doc.sheets || []).forEach(function (sh) {
        Object.keys(sh.boxes || {}).forEach(function (k) { var v = sh.boxes[k]; if (v) v.sign = signOf(v); });
      });
      return doc;
    });
  }

  function boxesOf(a, u, mine) {
    var at = a && a.submitted_at ? Date.parse(a.submitted_at) : NaN;
    // 담당 칸: 상신된 건이면 상신 때 서명, 상신 전 미리보기면 지금 내 서명.
    var live = !a || a.status === 'withdrawn' || a.status === 'rejected';
    var mySign = live && mine === myName() && MYSIGN && MYSIGN.image ? MYSIGN.id : null;
    var b = { 담당: { name: u.name || mine, date: isFinite(at) ? md(at) : '',
      signId: live ? mySign : ((a.snapshot || {}).sign_id || null) } };
    ((a && a.steps) || []).forEach(function (s) {
      if (s.box && FORM_BOXES.indexOf(s.box) > 0) {
        var t = s.acted_at ? Date.parse(s.acted_at) : NaN;
        b[s.box] = s.result === 'approved'
          ? { name: s.name || s.approver, date: isFinite(t) ? md(t) : '', signId: s.sign_id || null }
          : { name: '', date: '' };
      }
    });
    return b;
  }
  /**
   * 정산 영수증(주차·통행료, 0원 초과)을 어느 장에 실을지 **한 번에** 정한다. 돌려주는 값: 장 순서대로 [{ 증빙 id: 1 }].
   * 기록부는 차량별로 장을 나눈다. 화면 합계와 서버의 결재 금액은 번호판과 무관하게 영수증을 더하므로,
   * 번호판을 잘못 골랐거나(안 몬 차·표기 차이) 비워 둔 영수증도 문서 어딘가에는 반드시 실려야 한다
   * (2026-10-01 검증로봇: 결재 카드 13,910원 / 결재 문서 1,910원).
   * ※ 앱 엑셀은 아직 이런 영수증을 빼고 만든다. 앱도 같이 고쳐야 한다(다음 앱 버전).
   *   · 번호판이 그 장과 정확히 같으면 그 장
   *   · 그 밖(다른 번호판 · 표기 차이 · 빈칸)은 첫 장
   * 모든 영수증이 정확히 한 장에 실린다. 예전에는 장마다 따로 판단해(번호판이 같거나, 등록 차량이 1대 이하이고
   * 번호판이 비었으면) 빈 번호판 영수증이 모든 장에 실려 두 번 더해질 수 있었다(2026-10-02 재검증:
   * 등록 1대 · 운행 번호판 2개 · 빈 영수증 7,000원 → 화면 14,640 / 문서 21,640).
   */
  /**
   * 영수증이 직접 이어진 운행(2026-10-07 — 「주차비·통행료 직접 맞추기」). 이어진 운행이 같은 사람·같은 마감주기에
   * 살아 있을 때만 쓴다. 없으면 null(영수증 날짜로 맞춘다). 서버 검증(driving-verify.ts dayOf)과 같은 규칙.
   */
  function linkedTrip(e, r) {
    if (!e || e.trip_id == null || (e.category !== '주차' && e.category !== '통행료')) return null;
    var id = String(e.trip_id), t = null;
    for (var i = 0; i < TRIPS.length; i++) { if (String(TRIPS[i].id) === id) { t = TRIPS[i]; break; } }
    if (!t || t.username !== e.username || t.deleted_at) return null;
    var ts = Number(t.start_time);
    if (r && !(ts >= r.lo && ts < r.hi)) return null;
    return t;
  }
  /** 영수증이 엑셀에서 붙는 날 — 이어진 운행이 있으면 그 운행의 날, 아니면 영수증 날짜. */
  function evDay(e, r) { var t = linkedTrip(e, r); return ymd(t ? t.start_time : Number(e.date_millis)); }
  /** 이번 주기 내 영수증(구분 cat) 중 붙는 날에 업무 운행이 없는 것 — 날짜로 운행을 못 찾은 영수증. */
  function evUnmatched(cat) {
    var me = myName(), r = cycleRange(CYC.y, CYC.m), days = {};
    TRIPS.forEach(function (t) { if (t.username === me && t.purpose === BUSINESS && !t.deleted_at) days[ymd(t.start_time)] = 1; });
    return EVID.filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === me && e.category === cat && Number(e.amount) > 0 && d >= r.lo && d < r.hi && !days[evDay(e, r)];
    });
  }
  /** 「운행에 직접 맞추기」 창 — 이번 주기 내 영수증(주차·통행료)마다 어느 운행 것인지 고른다. */
  function openEvLink(cat) {
    var me = myName(), r = cycleRange(CYC.y, CYC.m);
    var evs = EVID.filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === me && e.category === cat && Number(e.amount) > 0 && d >= r.lo && d < r.hi;
    }).sort(function (a, b) { return a.date_millis - b.date_millis; });
    var trips = TRIPS.filter(function (t) { return t.username === me && !t.deleted_at && t.start_time >= r.lo && t.start_time < r.hi; })
      .sort(function (a, b) { return a.start_time - b.start_time; });
    if (!evs.length) { toast('이번 주기에 올린 ' + cat + ' 영수증이 없습니다.'); return; }
    var bad = {}; evUnmatched(cat).forEach(function (e) { bad[e.id] = 1; });
    // 주소 끝 번지(488-3)만으로는 어디인지 모른다 — 동·읍·면·리 이름(없으면 도로명)을 쓴다. 「서울 강남구 역삼동 488-3」 → 역삼동
    var area = function (a) {
      var w = String(a || '').trim().split(/\s+/).filter(Boolean), i;
      for (i = w.length - 1; i >= 0; i--) if (/(동|읍|면|리|가)$/.test(w[i]) && !/^\d/.test(w[i])) return w[i];
      for (i = w.length - 1; i >= 0; i--) if (/(로|길)$/.test(w[i]) && !/^\d/.test(w[i])) return w[i];
      return w.slice(-2).join(' ');
    };
    var DOW = ['일', '월', '화', '수', '목', '금', '토'];
    var dayName = function (ms) { var d = kd(ms); return (d.getUTCMonth() + 1) + '월 ' + d.getUTCDate() + '일(' + DOW[d.getUTCDay()] + ')'; };
    var tripLabel = function (t) {
      var from = area(t.start_address), to = area(t.end_address);
      var km = Number(t.end_odometer) - Number(t.start_odometer);
      var parts = [hm(t.start_time) + (t.end_time ? '~' + hm(t.end_time) : '')];
      parts.push(t.visit_place ? '방문처 ' + t.visit_place : '방문처 없음');
      if (from || to) parts.push((from || '?') + ' → ' + (to || '?'));
      if (km > 0 && km < 2000) parts.push(n0(km) + 'km');
      if (t.purpose && t.purpose !== BUSINESS) parts.push(t.purpose);
      return parts.join('  ·  ');
    };
    // 같은 날 운행끼리 날짜 제목 아래 묶는다.
    var groups = [];
    trips.forEach(function (t) {
      var k = ymd(t.start_time), g = groups[groups.length - 1];
      if (!g || g.k !== k) groups.push(g = { k: k, ms: t.start_time, list: [] });
      g.list.push(t);
    });
    var rows = evs.map(function (e) {
      var opts = '<option value="">자동 — 영수증 날짜(' + esc(dayName(e.date_millis)) + ') 운행에 붙이기</option>' + groups.map(function (g) {
        return '<optgroup label="' + esc(dayName(g.ms) + (g.k === ymd(e.date_millis) ? '  ← 영수증과 같은 날' : '')) + '">' + g.list.map(function (t) {
          return '<option value="' + t.id + '"' + (String(e.trip_id || '') === String(t.id) ? ' selected' : '') + '>' + esc(tripLabel(t)) + '</option>';
        }).join('') + '</optgroup>';
      }).join('');
      return '<tr' + (bad[e.id] ? ' class="flagged"' : '') + '><td style="white-space:nowrap"><span class="lead">' + esc(dayName(e.date_millis)) + '</span>' +
        (hm(e.date_millis) !== '00:00' ? ' <span class="dim">' + esc(hm(e.date_millis)) + '</span>' : '') + (bad[e.id] ? '<div><span class="st warn">맞는 운행 없음</span></div>' : '') + '</td>' +
        '<td class="n" style="white-space:nowrap">' + n0(e.amount) + '원</td>' +
        '<td style="width:100%"><select class="inp" data-evlinksel="' + e.id + '" data-was="' + esc(String(e.trip_id || '')) + '" style="min-width:260px">' + opts + '</select></td></tr>';
    }).join('');
    openPanel(cat + ' 영수증을 운행에 맞추기', cycleName(CYC.y, CYC.m) + ' · ' + n0(evs.length) + '건',
      '<div class="anote" style="margin-top:0">영수증은 보통 <b>같은 날 운행</b>에 자동으로 붙습니다. 수기 운행의 시각이 다르거나 ' +
      '자정을 넘겨 결제해 날짜가 안 맞으면, 여기서 <b>어느 운행의 영수증인지</b> 골라 주세요. 엑셀·검증이 고른 운행의 날로 맞춥니다. ' +
      '영수증 날짜는 바뀌지 않습니다.</div>' +
      '<div class="panel" style="margin-top:12px"><div class="scroll"><table><thead><tr><th>영수증 날짜</th><th class="n">금액</th><th>운행</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnEvLinkSave">저장</button>', true);
  }
  function saveEvLink() {
    var sels = [].slice.call(document.querySelectorAll('[data-evlinksel]')).filter(function (s) { return s.value !== s.dataset.was; });
    if (!sels.length) { toast('바뀐 내용이 없습니다.'); closePanel(); return; }
    var btn = $('btnEvLinkSave'); if (btn) { btn.disabled = true; btn.textContent = '저장하는 중…'; }
    var fail = 0;
    var one = function (i) {
      if (i >= sels.length) return Promise.resolve();
      var s = sels[i];
      return apiRetry('/rest/v1/evidences?id=eq.' + encodeURIComponent(s.dataset.evlinksel), {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ trip_id: s.value ? Number(s.value) : null })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) { if (!rows || !rows.length) fail++; }, function () { fail++; })
        .then(function () { return one(i + 1); });
    };
    one(0).then(function () {
      closePanel();
      toast(fail ? (sels.length - fail) + '건 저장, ' + fail + '건은 저장하지 못했습니다(결재 중이거나 다른 주기 운행일 수 있습니다).'
        : sels.length + '건을 맞췄습니다.', !!fail);
      loadAll();
    });
  }
  function evidBySheet(mine, plates, r) {
    var out = plates.map(function () { return {}; });
    if (!plates.length) return out;
    EVID.forEach(function (e) {
      var d = Number(e.date_millis);
      if (e.username !== mine || !(d >= r.lo && d < r.hi) || !(Number(e.amount) > 0)) return;
      if (e.category !== '주차' && e.category !== '통행료') return;
      var lt = linkedTrip(e, r);                          // 운행에 이었으면 그 운행의 차량 장에 싣는다
      var i = plates.indexOf(lt ? (lt.plate_no || '') : (e.vehicle_plate || ''));
      out[i < 0 ? 0 : i][e.id] = 1;
    });
    return out;
  }
  /** 그 사람에게 이 기간에 정산에 들어가는 영수증(주차·통행료)이 있는가. */
  function hasSettleEvid(mine, r) {
    return EVID.some(function (e) {
      var d = Number(e.date_millis);
      return e.username === mine && d >= r.lo && d < r.hi && Number(e.amount) > 0 &&
        (e.category === '주차' || e.category === '통행료');
    });
  }
  /** 차량별로 묶는다(차량 1대 = 1장). 순서는 그 차의 첫 운행 시각. */
  function platesOf(list, fallback) {
    var byPlate = {}, plates = [];
    list.forEach(function (t) {
      var p = t.plate_no || '';
      if (!byPlate[p]) { byPlate[p] = []; plates.push(p); }
      byPlate[p].push(t);
    });
    plates.sort(function (x, y) { return minStart(byPlate[x]) - minStart(byPlate[y]); });
    if (!plates.length && fallback != null) { plates = [fallback]; byPlate[fallback] = []; }
    return { plates: plates, by: byPlate };
  }
  /**
   * PDF 한 권의 재료. 지금 전역(TRIPS·EVID·RATES·CYC)에서 만든다.
   * 고정본으로 만들 때는 withFrozen() 안에서 부른다.
   */
  function pdfDocFor(who, a) {
    var mine = who || myName(), u = personOf(mine), r = cycleRange(CYC.y, CYC.m);
    var all = TRIPS.filter(function (t) {
      return t.username === mine && PRINT_PURPOSES.indexOf(t.purpose || '') >= 0;
    });
    var g = platesOf(all, u.plate_no || '');
    var boxes = boxesOf(a, u, mine);
    var pick = evidBySheet(mine, g.plates, r);
    var sheets = g.plates.map(function (p, i) {
      var d = sheetDataFor(mine, u, p, g.by[p], r, pick[i]);
      d.boxes = boxes;
      return d;
    });
    var evid = EVID.filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === mine && d >= r.lo && d < r.hi && e.photo_path;
    }).sort(function (x, y) { return x.date_millis - y.date_millis || x.id - y.id; });
    // 스캔 원본이 있는 영수증은 그 장을 통째로(한 장에 한 쪽), 나머지는 낱장 사진으로.
    var scans = [], scanAt = {}, photos = [];
    evid.forEach(function (e) {
      var row = { category: e.category || '기타', date: md(e.date_millis), amount: Number(e.amount) || 0,
        plate: e.vehicle_plate || '', memo: e.memo || '' };
      if (e.scan_path) {
        if (scanAt[e.scan_path] == null) { scanAt[e.scan_path] = scans.length; scans.push({ path: e.scan_path, items: [] }); }
        scans[scanAt[e.scan_path]].items.push(row);
      } else { row.path = e.photo_path; photos.push(row); }
    });
    var hasRow = sheets.some(function (s) { return s.rows.length || s.orphans.length; });
    return { sheets: sheets, scans: scans, photos: photos, any: hasRow || scans.length > 0 || photos.length > 0 };
  }
  /** 엑셀 파일들(차량별 1개). 지금 전역에서 만든다 — downloadXlsx 와 같은 규칙·같은 파일 이름. */
  function xlsxFiles(who) {
    if (!window.Xlsx) return [];
    var mine = who || myName(), u = personOf(mine), r = cycleRange(CYC.y, CYC.m);
    var all = TRIPS.filter(function (t) {
      return t.username === mine && PRINT_PURPOSES.indexOf(t.purpose || '') >= 0;
    });
    // 운행이 없어도 영수증(주차·통행료)만 있으면 근거자료 행만 든 한 장을 만든다 — PDF 와 같은 내용이어야 한다.
    var g = platesOf(all, hasSettleEvid(mine, r) ? (u.plate_no || '') : null);
    var pick = evidBySheet(mine, g.plates, r);
    return g.plates.map(function (plate, i) {
      var safe = String(plate).replace(/[^0-9A-Za-z가-힣]/g, '') || '차량';
      var data = sheetDataFor(mine, u, plate, g.by[plate], r, pick[i]);
      return {
        name: 'ATEC Driving 운행일지_' + safe + '_' + ymd(r.lo) + '_' + ymd(r.hi - 1) + '.xlsx',
        bytes: window.Xlsx.build(data),
        // 이 장의 총계(엑셀 수식과 같은 식) — 받는 쪽이 장별 합을 집계 금액과 견준다.
        sum: window.SheetPdf ? window.SheetPdf.sheetTotals(data).t.all : null
      };
    });
  }
  /**
   * 고정본(상신 시점에 서버가 굳힌 자료)으로 전역을 잠깐 바꿔 놓고 fn 을 돌린다.
   * 기록부·엑셀을 만드는 함수들이 전역을 읽기 때문이다. fn 은 반드시 동기 함수여야 한다 —
   * 기다리는 동안 화면이 고정본을 자기 자료로 알고 그리면 안 된다.
   * 결재 문서는 '일반업무'만 담는다(제출 기준 · 서버 집계와 같은 범위).
   */
  function withFrozen(fz, fn) {
    var u = (fz.user && fz.user.username) || '';
    var keep = { T: TRIPS, E: EVID, V: VEHICLES, R: RATES, M: RATE_MISS, C: CYC, Q: QBOUNDS, P: PRINT_PURPOSES,
      hadU: Object.prototype.hasOwnProperty.call(USERS, u), U: USERS[u] };
    try {
      TRIPS = fz.trips || []; EVID = fz.evidences || []; VEHICLES = fz.vehicles || [];
      RATES = {}; RATE_MISS = {};
      (fz.rates || []).forEach(function (x) { RATES[x.year + '-' + x.quarter + '-' + x.region] = Number(x.price); });
      setQuarterBounds(fz.quarter_bounds);
      var c = String(fz.cycle || '').split('-');
      CYC = { y: +c[0], m: +c[1] };
      if (fz.user) USERS[u] = fz.user;
      PRINT_PURPOSES = [BUSINESS];
      return fn();
    } finally {
      TRIPS = keep.T; EVID = keep.E; VEHICLES = keep.V; RATES = keep.R; RATE_MISS = keep.M;
      CYC = keep.C; QBOUNDS = keep.Q; PRINT_PURPOSES = keep.P;
      if (keep.hadU) USERS[u] = keep.U; else delete USERS[u];
    }
  }
  /** 옆 패널을 연다(제목·부제는 글자 그대로, 본문·아랫줄은 HTML). */
  function openPanel(title, sub, bodyHtml, footHtml, wide) {
    CLOSE_ASK = null;
    // 결재 확인 창 위에 다른 내용(결재 문서·검증 결과)을 띄우는 것이면 돌아올 곳과 적던 의견을 맡아 둔다.
    var go0 = $('btnApprGo');
    if (go0 && $('panel').classList.contains('open')) {
      APPR_BACK = { act: go0.dataset.act, id: +go0.dataset.id, why: String(($('apprWhy') || {}).value || '') };
    }
    $('panel').classList.toggle('wide', !!wide);
    $('pTitle').textContent = title || '';
    $('pSub').textContent = sub || '';
    $('pBody').innerHTML = bodyHtml || '';
    $('pFoot').innerHTML = backBtn() + (footHtml || '');
    $('panel').classList.add('open');
  }
  /** 결재 확인 창에서 넘어온 화면이면 '돌아가기' 버튼. 아니면 빈 글. */
  function backBtn() {
    return APPR_BACK ? '<button class="btn" id="btnBackAppr">← 결재 화면으로</button>' : '';
  }

  /* ══════════════════ 확장 모듈 이음매 ══════════════════
     drv-*.js 가 window.DrvExtQ 에 올려 둔 것을 여기서 붙인다. 화면(view)을 더하고,
     결재 카드에 끼울 조각과 상신 직전에 돌릴 일을 받는다. 없으면 없는 대로 돈다. */
  (function () {
    var C = {
      $: $, SB: SB, esc: esc, ic: ic, n0: n0, won: won, km: km, pad: pad, md: md, hm: hm, ymd: ymd,
      toast: toast, toastOk: toastOk, apiRetry: apiRetry, fetchAll: fetchAll,
      head: head, sect: sect, blank: blank, skeleton: skeleton,
      nameOf: nameOf, personOf: personOf, myName: myName,
      orgCell: orgCell, orgGroups: orgGroups, orgGroupRow: orgGroupRow, orgMatch: orgMatch, orgPath: orgPath, orgName: orgName, myAppr: myAppr, apprOf: apprOf,
      cycleRange: cycleRange, cycleName: cycleName, cycleSpan: cycleSpan,
      render: render, go: go, loadAll: loadAll, closePanel: closePanel, openPanel: openPanel, backBtn: backBtn,
      pdfDocFor: pdfDocFor, fillSigns: fillSigns, openEdit: openEdit, photoUrl: photoUrl, evLocked: evLocked, xlsxFiles: xlsxFiles, withFrozen: withFrozen, saveBlob: saveBlob,
      isAll: isAll, isMulti: isMulti, singleOnly: singleOnly, BOXES: BOXES,
      state: function () {
        return {
          ME: ME, VIEW: VIEW, CYC: CYC, CYCKEY: CYCKEY(), LOADED: LOADED,
          TRIPS: TRIPS, ALL_TRIPS: ALL_TRIPS, EVID: EVID, ALL_EVID: ALL_EVID,
          USERS: USERS, PEOPLE: PEOPLE, APPR: APPR, ORG: ORG, ACCT: ACCT
        };
      },
      // 목적을 고르는 창 없이 문서를 만들 때는 늘 일반업무만 담는다(지난번에 고른 체크박스를 따르지 않는다).
      bizOnly: function () { PRINT_PURPOSES = [BUSINESS]; },
      expectCost: expectCost, sheetSumWarn: sheetSumWarn,
      setOrg: function (rows) { ORG = rows || []; }
    };
    (window.DrvExtQ || []).forEach(function (make) {
      var x;
      try { x = make(C) || {}; } catch (e) { console.error('확장 모듈을 붙이지 못했습니다:', e); return; }
      Object.keys(x.views || {}).forEach(function (k) { VIEWS[k] = x.views[k]; });
      (x.admin || []).forEach(function (k) { if (ADMIN_VIEWS.indexOf(k) < 0) ADMIN_VIEWS.push(k); });
      ['apprExtra', 'wantSummaries', 'beforeSubmit', 'sumText'].forEach(function (k) { if (x[k]) EXT[k] = x[k]; });
      if (x.onCycle) EXT.onCycle.push(x.onCycle);
      if (x.dirty) EXT.dirty.push(x.dirty);
    });
  })();

  /* ── 검증용 이음매 ──────────────────────────────────────────────
     실데이터 하네스(_realstub.js)가 깔렸을 때만 인쇄 생성기를 밖으로 낸다.
     배포본에는 __VERIFY__ 가 없으므로 아무 일도 하지 않는다. */
  if (window.__VERIFY__) {
    window.__buildPrint = buildPrint;
    window.__pdfDocFor = pdfDocFor; window.__totals = totals; window.__withFrozen = withFrozen;
    window.__state = function () { return { TRIPS: TRIPS, EVID: EVID, VEHICLES: VEHICLES, USERS: USERS, RATES: RATES, CYC: CYC }; };
    // 하이패스는 실제 영수증 PDF 없이는 재현이 안 된다. 대조 결과를 직접 넣어
    // '확정' 뒤에 화면이 바뀌는지 확인할 수 있게 열어 둔다(검증용).
    window.__hp = function (g) {
      if (g) { HP.groups = hpMarkLocked(g); HP.batch = 'verify'; render(); }
      return HP;
    };
    window.__hpApply = hpApply;
  }

  /* ══════════════════ 시작 ══════════════════ */
  // 로그인 전이면 업무 결재 포털로 보낸다(보던 주소는 로그인 뒤 돌아오게). ?direct=1 이면 예전 로그인 화면을 쓴다.
  if (ss(K_AT) && me()) enter();
  else if (!window.__VERIFY__ && !/[?&]direct=1/.test(location.search)) toPortal(location.hash);
  else document.body.classList.add('showlogin');
})();
