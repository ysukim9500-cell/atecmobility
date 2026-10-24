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
  // 마감 기간 엔진(cycle-rules.js, 2026-10-20 연말 마감 설정) — 이 브라우저에 두었던 서버 설정을 먼저 쓴다(처음이면 기본 = 지금 규칙).
  var CR = window.CycleRules;
  if (!CR) { console.error('[기간] cycle-rules.js 를 driving-app.js 보다 먼저 실어야 합니다'); return; }
  CR.boot();

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
  /** 결재 건 요약(고정본 snapshot)의 운행 — 금액은 업무 운행만이라 업무를 먼저(2026-10-20, 마감 화면 「업무 운행 N건(전체 M건)」과 같은 말).
   *  고정본에 업무 운행 건수(biz_trips)가 없으면(지금 서버) 업무 거리와 전체 건수만 — 없는 수를 지어내지 않는다. */
  function snapTrips(s) {
    if (!s || s.trips == null) return '';
    if (s.biz_km == null) return '운행 ' + n0(s.trips) + '건 · ' + km(s.km) + ' km';
    if (s.biz_trips != null) return '업무 운행 ' + n0(s.biz_trips) + '건 · ' + km(s.biz_km) + ' km' + (+s.biz_trips !== +s.trips ? ' (전체 ' + n0(s.trips) + '건)' : '');
    return '업무 운행 ' + km(s.biz_km) + ' km (전체 ' + n0(s.trips) + '건)';
  }
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
    // 옆 창이 열려 있으면 창 아랫줄(단추) 위로 띄운다(2026-10-20 AU6-L8 — 폰에서 토스트가 창의 단추를 6초까지 가렸다).
    var pn = $('panel'), pf = pn && pn.classList.contains('open') ? $('pFoot') : null, pr = pf && pf.getBoundingClientRect();
    t.style.bottom = pr && pr.height ? Math.max(30, Math.round(window.innerHeight - pr.top + 12)) + 'px' : '';
    t.className = 'show' + (bad ? ' bad' : '');
    // 경고가 붙은 긴 문장은 읽을 시간을 더 준다.
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = ''; }, msg.length > 40 ? 6000 : 3400);
  }
  /** 성공했는데 경고가 딸린 경우 — 성공을 먼저 말하고 경고를 잇는다.
   *  예전에는 빨간 경고만 떠서 "상신이 실패했나?" 로 읽혔다. 두 문장은 줄표 대신 마침표로 잇는다(2026-10-24 해요체). */
  function toastOk(msg, warning) {
    toast(warning ? endDot(msg) + ' ' + warning : msg, !!warning);
  }
  /** 서버 문구 끝에 마침표가 없으면 붙인다 — 뒤에 다른 문장을 이을 때 「승인했습니다 검증: …」처럼 붙어 읽혔다(2026-10-16 3차). */
  function endDot(s) {
    s = String(s == null ? '' : s).replace(/\s+$/, '');
    return !s || /[.!?…]$/.test(s) ? s : s + '.';
  }
  /** 불러오기 실패 화면 아랫줄 — 오류에 맞는 다음 할 일. 로그인 만료·권한 없음에 「잠시 후 다시」는 맞지 않았다(2026-10-24 검수).
   *  오류 글이 이미 할 일(「…주세요.」)로 끝나면 빈 글. 개인경비·법인카드 화면도 C.retryHint 로 같이 쓴다. */
  function retryHint(err) {
    var s = String(err == null ? '' : err).trim();
    if (/주세요\.?$/.test(s)) return '';
    return /만료/.test(s) ? '다시 로그인해 주세요.' : /권한/.test(s) ? '관리자에게 문의해 주세요.' : '잠시 후 다시 해 주세요.';
  }
  /** 개인경비·법인카드 잠금 오류(EXPENSE_LOCKED·CARD_LOCKED) 때 할 일 — 그 기간 결재 상태에 맞게(2026-10-24 검수).
   *  예전엔 늘 「먼저 회수해 주세요」라 결재가 끝났거나 이미 승인한 결재자가 있어 회수할 수 없을 때도 회수하라고 했다. 운행일지 lockHow 와 같은 갈래. */
  function lockSay(a) {
    if (a && a.status === 'approved') return '결재가 끝난 기간이라 고칠 수 없어요. 정정이 필요하면 관리자에게 문의해 주세요.';
    if (a && a.status === 'submitted') return (a.steps || []).some(function (x) { return x.result; })
      ? '결재 중인 기간이라 고칠 수 없어요. 이미 승인한 결재자가 있어 회수할 수 없어요. 고치려면 지금 차례인 결재자에게 반려를 요청하세요.'
      : '결재 중인 기간이라 고칠 수 없어요. 고치려면 회수한 뒤 다시 상신하세요.';
    return '결재 중이거나 결재가 끝난 기간이라 고칠 수 없어요. 고치려면 먼저 회수해 주세요.';
  }
  /** 금액·계기판 칸 읽기(2026-10-20 AU2 #9) — 숫자와 세 자리마다 쉼표만 받는다(앞뒤 빈칸·전각 숫자는 괜찮다).
   *  빈칸 = null. 다른 글자(소수점·음수 기호·「원」·「만」·띄어 쓴 두 수·자리가 틀린 쉼표)가 섞이면 NaN — 예전처럼 숫자 밖의 글자를
   *  말없이 지워 「1,100.5」→11,005 · 「3000원 2장」→30,002 · 「-5,000」→5,000 · 「1만2천」→12 로 저장하지 않는다.
   *  「11,000」「11000」→ 11000 · 「1,100.5」「-5,000」「3000원」「11,00」→ NaN. 개인경비(drv-expense.js)도 C.numIn 으로 같이 쓴다. */
  function numIn(v) {
    var s = String(v == null ? '' : v).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/，/g, ',').trim();
    if (s === '') return null;
    return /^\d+$/.test(s) || /^\d{1,3}(,\d{3})+$/.test(s) ? Number(s.replace(/,/g, '')) : NaN;
  }
  var NUM_BAD = '숫자만 넣어 주세요. 쉼표는 세 자리마다 넣어요(예: 11,000)';
  /** 숫자 칸 표시 — 못 읽는 글이면 빨간 테두리(need)·aria-invalid, 고치면 푼다(이 함수가 단 표시만). 읽은 값(numIn)을 돌려준다. */
  function numMark(el) {
    if (!el) return null;
    var v = numIn(el.value), bad = typeof v === 'number' && isNaN(v);
    if (bad) { el.classList.add('need'); el.setAttribute('aria-invalid', 'true'); el.dataset.numbad = '1'; el.title = NUM_BAD + '.'; }
    else if (el.dataset.numbad) { el.classList.remove('need'); el.removeAttribute('aria-invalid'); delete el.dataset.numbad; el.removeAttribute('title'); }
    return v;
  }
  /** 숫자 칸이 못 읽는 글이면 표시하고 알린 뒤 그 칸으로 — 막았으면 true. what = 「주차비」처럼 칸 이름. */
  function numStop(el, what) {
    var v = numMark(el);
    if (!(typeof v === 'number' && isNaN(v))) return false;
    toast((what ? what + '에는 ' : '') + NUM_BAD + '.', true);
    try { el.focus(); el.scrollIntoView({ block: 'nearest' }); } catch (e) { }
    return true;
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
      return Promise.resolve(new Response(JSON.stringify({ error: '로그인이 만료됐어요. 다시 로그인해 주세요.' }),
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
  /** 권한이 없다는 표시(403) — 로그인은 살아 있다. 로그인 만료로 보고 로그아웃시키지 않는다(2026-10-20 AU2 #17). */
  function NoPerm() { this.noPerm = true; this.message = '권한이 없어요'; }
  var NO_PERM_MSG = '이 자료를 볼 권한이 없어요. 관리자에게 문의해 주세요.';
  function fetchAll(path) {
    var acc = [];
    function page(off) {
      return apiRetry(path + (path.indexOf('?') < 0 ? '?' : '&') + 'offset=' + off + '&limit=1000')
        .then(function (r) {
          // ★ 401 을 []로 바꾸면 본인 기록이 사라진 것처럼 보인다.
          //   갱신까지 실패한 것이므로 로그인 화면으로 돌려보내야 한다.
          if (r.status === 401) throw new AuthGone();
          // 403 은 「권한 없음」이라는 판정이다(토큰 만료는 401). 예전에는 401 과 같이 로그아웃시켰다 — 앱 키 권한을 회수할 때
          //   한 표만 막혀도 전원이 「로그인이 만료되었습니다」로 튕길 뻔했다(2026-10-20 AU2 #17). 빈 목록으로도 바꾸지 않는다.
          if (r.status === 403) throw new NoPerm();
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
       '9월분' = 08.21 ~ 09.20 이다. 여기가 틀리면 모든 숫자가 틀어진다.
     2026-10-20 연말 마감 설정: 기간 계산은 엔진 CR(cycle-rules.js — 서버 _shared/cycle-rules.ts · DB cycle_key_of 와 같은 규칙)로 모았다.
       기간 c 는 그대로 {y, m} — 12월 추가 기간(「12월분 2차」)만 {y, m: 12, x: 'b'}. 관리자가 설정하지 않으면 위 식과 하루도 다르지 않다.
       아래 함수는 c 를 받는다(cycleRange(CYC)). 옛 꼴 (y, m) 도 받지만, 추가 기간을 보는 중에 그렇게 부르면 x 가 빠지므로 [기간] 오류를 낸다. */
  /** 갈래 글자(d·x·c) → 엔진 kind. */
  function kindOfMode(m) { return m === 'x' ? 'expense' : m === 'c' ? 'card' : 'driving'; }
  /** 그 화면의 기간 kind — 개인경비·법인카드 화면이면 그 갈래, 그 밖(함께 쓰는 화면 포함)은 운행일지(curCyc·defCyc 와 같은 뜻). */
  function kindOfView(v) { var p = periodOf(v || VIEW); return p ? kindOfMode(p.mode) : 'driving'; }
  /** 그 화면에 보이는 기간 규칙의 kind — 함께 쓰는 화면(결재함)은 들어온 갈래의 규칙(paintCycle 의 범위 글자와 같은 뜻). ◀ ▶·목록·추가 기간 확인에 쓴다. */
  function kindShown(v) {
    v = v || VIEW;
    var p = periodOf(v) || ((SHARED_VIEWS || []).indexOf(v) >= 0 ? periodOfMode(NAV_MODE) : null);
    return p ? kindOfMode(p.mode) : 'driving';
  }
  /** 엔진 기간 P → c. 없으면 {y: NaN, m: NaN}(옛 식이 틀린 입력에 내던 값). */
  function toC(P) { return !P ? { y: NaN, m: NaN } : P.x ? { y: P.y, m: P.m, x: P.x } : { y: P.y, m: P.m }; }
  /** c 의 그 갈래 기간(엔진 P) — 그 갈래에 없는 추가 기간이면 그 달(12월분). 틀린 c 면 null. */
  function perOf(c, kind) {
    kind = kind || 'driving';
    return CR.byKey(kind, c) || (c && c.x ? CR.byKey(kind, { y: c.y, m: c.m }) : null);
  }
  /** 옛 꼴 (y, m) 을 c 로 — 추가 기간을 보는 중에 그 꼴로 부르면 x 가 빠진다: [기간] 오류(하네스가 콘솔 오류로 센다). */
  function argC(a, b, fn) {
    if (a && typeof a === 'object') return a;
    if (CYC && CYC.x && +a === CYC.y && +b === CYC.m) console.error('[기간] ' + fn + '(y, m) 로 불러 추가 기간(' + cycKey(CYC) + ')이 빠졌습니다 — ' + fn + '(c) 로 불러 주세요');
    return { y: Number(a), m: Number(b) };
  }
  /** withFrozen 동안 고정본에 굳힌 운행일지 기간 범위({key, lo, hi} ms — 서버 frozenData.range). 그 뒤 기간 설정이 바뀌어도 문서는 상신 때 범위로. */
  var FROZEN_RANGE = null;
  function frozenHit(c, kind) { return !!(FROZEN_RANGE && (kind || 'driving') === 'driving' && cycKey(c) === FROZEN_RANGE.key); }
  /** 기간 c 의 [lo, hi) ms — kind 가 없으면 운행일지. 없는 기간이면 NaN(옛 식과 같다). */
  function cycleRange(c, kind) {
    var obj = !!(c && typeof c === 'object'), cc = argC(c, kind, 'cycleRange'), k = obj ? kind : 'driving';
    if (frozenHit(cc, k)) return { lo: FROZEN_RANGE.lo, hi: FROZEN_RANGE.hi };
    var P = perOf(cc, k);
    return P ? { lo: P.loMs, hi: P.endMs } : { lo: NaN, hi: NaN };
  }
  /** '09.21 – 10.20'(끝날 포함) — kind 가 없으면 운행일지. */
  function cycleSpan(c, kind) {
    var obj = !!(c && typeof c === 'object'), cc = argC(c, kind, 'cycleSpan'), k = obj ? kind : 'driving';
    if (frozenHit(cc, k)) return md(FROZEN_RANGE.lo) + ' – ' + md(FROZEN_RANGE.hi - 1);
    var P = perOf(cc, k);
    return P ? CR.span(P) : 'NaN.NaN – NaN.NaN';
  }
  /** '2026년 9월분' · '2026년 12월분 2차' — 이름은 키로 정해진다(갈래와 무관). */
  function cycleName(c, m) {
    if (c && typeof c === 'object') return CR.name(c);
    argC(c, m, 'cycleName');
    return c + '년 ' + m + '월분';
  }
  /** 오늘이 속한 마감주기(운행일지). 21일 이전이면 이번 달분, 21일부터는 다음 달분 — 연말 설정이 있으면 그 기간. */
  function currentCycle() { return toC(CR.current('driving')); }
  /* ── 마감 뒤 며칠(2026-10-20 사용자 「마감일 기준 5일 동안은 띄워줘. 바로 11월로 가지 말고」) ──
     기간이 끝난 뒤 GRACE_DAYS 일 동안은 처음 여는 기간(오른쪽 위)을 방금 끝난 기간으로 둔다 — 세 시스템 모두.
     ★ 「처음 보이는 기간」만 바꾼다. 오늘 운행·영수증이 들어갈 기간 · 잠금 · ▶ 로 갈 수 있는 끝(= 오늘이 든 기간)은
       그대로 currentCycle()/curCyc() 이다. 운행일지 10월분(09.21~10.20)은 10.25 까지, 개인경비 10월분(09.20~10.19)은 10.24 까지,
       법인카드 10월분은 11.05 까지 먼저 열린다. 날은 모두 한국시간 달력 날짜로 센다. */
  var GRACE_DAYS = 5;        // 기본값(호환용) — 실제 값은 서버 설정 CR.graceDays()(2026-10-20 연말 마감)
  /** 기간이 끝난 뒤 며칠째인가(마지막 날 다음 날 = 1, KST 날짜). 아직 안 끝났으면 0 이하. */
  function daysPast(r, now) { return dayNo(now) - dayNo(r.hi - 1); }
  /** cur(오늘이 든 기간) 바로 앞 기간이 끝난 지 CR.graceDays() 일 안이면 그 기간, 아니면 null. range = 그 갈래의 범위 함수(cycleRange · 모듈 period.range) — 갈래를 가리는 데만 쓴다. */
  function graceCyc(cur, range) {
    if (!range) return null;
    var kind = 'driving';
    EXT.periods.forEach(function (x) { if (x.range === range) kind = kindOfMode(x.mode); });
    var p = CR.prev(perOf(cur, kind)), d = p ? CR.daysPast(p, Date.now()) : 0;
    return d >= 1 && d <= CR.graceDays() ? toC(p) : null;
  }
  /** 운행일지를 처음 열 때 보일 기간 — 마감 뒤 CR.graceDays() 일 동안은 방금 끝난 기간, 그 밖에는 오늘이 든 기간. */
  function defaultCycle() { return toC(CR.defaultPeriod('driving')); }

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
  var ME = null, VIEW = 'close', CYC = defaultCycle();
  // ALL_* = 서버(RLS)가 내려준 전부. 일반 직원이면 어차피 본인 것뿐이다.
  // TRIPS·EVID = 지금 열려 있는 화면이 쓰는 범위. applyScope() 가 채운다.
  var ALL_TRIPS = [], ALL_EVID = [];
  var TRIPS = [], USERS = {}, VEHICLES = [], EVID = [], EDUV = [], EDUP = [], EDUT = [];
  var APPR = [], PEOPLE = {};               // 결재 건 · 사람 목록(이름·부서·직급)
  var ORG = [];                             // 조직도(driving_org) — 결재선을 짜는 사람 목록
  // 관리자가 사람마다 지정한 결재선(driving_line_override, 2026-10-14) — { 상신자 아이디: 행 }. 표가 없으면 LINE_OV_OK = false.
  var LINE_OV = {}, LINE_OV_OK = false;
  /** 확장 모듈(drv-*.js)이 얹는 것들. 파일 끝의 '확장 모듈 이음매'에서 채운다. */
  var EXT = { apprExtra: null, wantSummaries: null, beforeSubmit: null, sumText: null, previewBytes: null, onCycle: [], dirty: [], onGo: [],
    // 2026-10-07 개인경비 — 다른 결재 문서(kinds)·다른 기간 규칙(periods)·같이 받을 자료(load)·「보는 범위」 사람(orgUsers)
    // 2026-10-09 법인카드 — 기간 규칙이 둘이 되어 목록으로(개인경비 20~19일 'x' · 법인카드 1일~말일 'c'). 규칙마다 mode.
    kinds: {}, periods: [], load: [], orgUsers: null };
  /** 그 화면의 기간 규칙(확장 모듈) — 없으면 null(운행일지 21~20일). */
  function periodOf(v) {
    for (var i = 0; i < EXT.periods.length; i++) if (EXT.periods[i].views.indexOf(v) >= 0) return EXT.periods[i];
    return null;
  }
  /** 갈래('x'·'c')의 기간 규칙 — 운행일지 갈래('d')나 모르는 갈래는 null. */
  function periodOfMode(m) {
    for (var i = 0; i < EXT.periods.length; i++) if (EXT.periods[i].mode === m) return EXT.periods[i];
    return null;
  }
  /** 지금 화면이 다른 기간 규칙을 쓰는가 — 그 규칙, 아니면 null. */
  function pv() { return periodOf(VIEW); }
  /** 지금 화면 기준 '이번 주기'. 개인경비 화면은 20일에, 법인카드 화면은 1일에 넘어간다. */
  function curCyc(view) {
    return toC(CR.current(kindOfView(view)));
  }
  /** 그 화면을 처음 열 때(주소에 기간이 없을 때) 보일 기간 — 마감 뒤 GRACE_DAYS 일 동안은 방금 끝난 기간(2026-10-20).
   *  ▶ 의 끝·잠금·새 기록이 들어갈 기간은 여전히 curCyc() 다. */
  function defCyc(view) {
    return toC(CR.defaultPeriod(kindOfView(view)));
  }
  /** 지금 보는 기간 c 가 「마감 뒤 며칠」 기간인가(오늘이 든 기간 바로 앞 + 끝난 지 GRACE_DAYS 일 안). */
  function inGrace(c, view) {
    return !RANGE && cmpCycle(c, curCyc(view)) < 0 && cmpCycle(c, defCyc(view)) === 0;
  }
  /** 그 화면이 다른 기간 규칙(개인경비·법인카드)을 쓰는가(2026-10-08). */
  function usesXPeriod(v) { return !!periodOf(v); }
  /** v 로 옮겨 갈 때 지금과 같은 기간 규칙인가 — 함께 쓰는 화면(결재함 등)에 있으면 지금 갈래의 규칙으로 본다(2026-10-09). */
  function samePeriod(v) {
    var from = SHARED_VIEWS.indexOf(VIEW) >= 0 ? periodOfMode(NAV_MODE) : periodOf(VIEW);
    return from === periodOf(v);
  }
  /** 다른 화면으로 옮겨 갈 때 확장 모듈에 알린다(검증 화면은 들어올 때마다 ① 검증하기부터). */
  function notifyGo(v, prev) {
    FINQ = {};                     // 결재 완료 출력 이름 찾기 — 화면을 옮기면 비운다(2026-10-23)
    EXT.onGo.forEach(function (f) { try { f(v, prev); } catch (e) { } });
  }
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
  /** 상신 창 「의견」에 적던 글 — 기간(종류:기간)마다. 결재선을 고쳐 창을 다시 그려도 그대로, 상신되면 지운다(2026-10-21).
   *  SUB_NOTE_PREV[열쇠] = 이번 기간에 반려·회수된 건의 의견을 불러와 채웠다(안내 한 줄). */
  var SUB_NOTE = {}, SUB_NOTE_PREV = {};
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
          var msg = (res.j && res.j.error) || '로그인하지 못했어요.';
          // ★ 같은 사이트의 다른 도구(통합관제 등)에 저장된 **이메일**을 브라우저가 이 칸에 자동으로
          //   채워, 앱 아이디 대신 이메일로 로그인하다 막히는 일이 실제로 있었다(2026-09-23).
          //   앱 아이디에 '@' 가 들어간 사람도 있어 막지는 않고, 실패했을 때만 짚어 준다.
          if (u.indexOf('@') > 0) msg = endDot(msg) + ' 이메일이 아니라 앱에서 쓰는 아이디를 넣었는지 확인해 주세요.';
          loginErr(msg); return;
        }
        ss(K_AT, res.j.access_token); ss(K_RT, res.j.refresh_token);
        ss(K_ME, JSON.stringify(res.j.profile));
        $('p').value = '';
        enter();
      }).catch(function () {
        b.disabled = false; b.textContent = '로그인';
        loginErr('서버에 연결하지 못했어요. 잠시 후 다시 해 주세요.');
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
          // 주소가 권한 관리 화면이었으면 이제 들어갈 수 있다(프로필이 먼저 오면 마감 현황으로 떨어졌다). 마감 기간 설정(cycset)도 같은 사람만(2026-10-20).
          if (want0 && (want0.view === 'perm' || (want0.view === 'cycset' && VIEWS.cycset)) && VIEW !== want0.view && a.can_manage_admin && ME) {
            VIEW = want0.view; want0 = null;   // 한 번만 — 그 뒤로는 사용자가 고른 화면을 따른다
            applyScope(); writeHash();
          }
          if (LOADED) render();
        }
      }).catch(function () { });
    // 서버 기간 설정(app_config.cycle_rules, 2026-10-20 연말 마감) — 프로필과 나란히 받고 최대 2.5초 기다린다(보통 프로필보다 먼저 온다).
    //   select=* — 칸이 아직 없는 서버여도 400 이 나지 않게. 못 받으면 이 브라우저에 두었던 값(처음이면 기본 = 지금 규칙).
    var rules0 = JSON.stringify(CR.raw()), booted = false;
    var rulesP = apiRetry('/rest/v1/app_config?id=eq.1&select=*')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) { if (rows && rows[0] && CR.set(rows[0].cycle_rules) && booted) rulesChanged(); })
      .catch(function () { });
    Promise.all([syncProfile(), Promise.race([rulesP, new Promise(function (ok) { setTimeout(ok, 2500); })])]).then(function () {
      booted = true;
      ME = me();
      var nm = ME.name || ME.username || '';
      $('uName').textContent = nm;
      $('uAv').textContent = initials(nm);
      $('uAv').className = 'uav' + (ME.is_admin ? ' is-admin-av' : '');
      $('uMeta').textContent = [ME.dept, ME.position].filter(Boolean).join(' · ') || (ME.is_admin ? '관리자' : '');
      document.body.classList.toggle('is-admin', !!ME.is_admin);
      // 새로고침해도 보던 화면·기간으로 돌아온다(주소의 # 뒤).
      var h0 = readHash();
      // 기다리는 사이 서버 기간 설정이 바뀌었으면 처음 보일 기간을 새 규칙으로(주소에 기간이 있으면 그것 — applyHash)
      if (JSON.stringify(CR.raw()) !== rules0 && !(h0 && h0.a)) CYC = defCyc(VIEW);
      if (h0) applyHash(h0);
      // 경로·질의를 함께 적는다 — '#…' 만 넘기면 <base> 가 있는 쪽에서는 그 기준으로 풀려 경로가 바뀐다.
      try { history.replaceState(null, '', location.pathname + location.search + hashOf()); } catch (e) { }
      loadAll();
      noteLoad();                  // 알림 읽음 상태(서버 notice_seen — 없으면 브라우저 저장소)
    });
  }

  /* ══════════════════ 기간 고르기 ══════════════════
     머리띠 가운데의 ◀ [기간] ▶ 와 그 아래 펼침 창.
       · 한 주기  : 마감 작업을 하는 평소 상태. ◀ ▶ 와 [ ] 키로 한 주기씩 넘긴다.
       · 여러 주기: 조회 전용(RANGE). 최근 3·6주기, 올해, 작년, 직접 지정.
     주기 목록에는 그 주기의 내 결재 상태를 같이 보여 준다 — 어느 달을 안 올렸는지
     드롭다운을 훑지 않아도 보이게.                                          */
  /** c 에서 n 기간 옮긴 c(한 칸 = 한 기간 — 추가 기간도 한 칸). kind 가 없으면 지금 화면에 보이는 규칙(설정이 없으면 달 셈 그대로). */
  function addCycle(c, n, kind) { return CR.step(kind || kindShown(), c, n); }
  function cmpCycle(a, b) { return CR.ord(a) - CR.ord(b); }
  function buildCycleSelect() { paintCycle(); }
  function paintCycle() {
    // 연도는 .yr 로 감싼다 — 좁은 화면에서 접어 한 줄을 지키기 위해서다.
    if (RANGE) {
      var a = RANGE.from, b = RANGE.to;
      $('cycleTxt').innerHTML = '<span class="yr">' + a.y + '년 </span>' + CR.short(a) + ' – ' +
        (a.y === b.y ? '' : '<span class="yr">' + b.y + '년 </span>') + CR.short(b);
      $('cycleTag').textContent = cyclesInView().length + '개 기간 · 조회 전용';
    } else {
      $('cycleTxt').innerHTML = '<span class="yr">' + CYC.y + '년 </span>' + CR.short(CYC);
      // 개인경비 화면은 20일~19일 — 같은 달 이름에 그 범위를 보인다(「09.20 – 10.19 · 이번 기간」).
      // 결재함 같은 공용 화면은 들어온 갈래의 범위를 보인다(2026-10-15: 개인경비 결재함 위에 운행일지 09.21–10.20 이 보여 헷갈렸다). 글자만 — 자료 범위는 그대로.
      var P0 = pv() || ((SHARED_VIEWS || []).indexOf(VIEW) >= 0 ? periodOfMode(NAV_MODE) : null);
      $('cycleTag').textContent = cycleSpan(CYC, P0 ? kindOfMode(P0.mode) : 'driving');
    }
    $('cycleBox').classList.toggle('xper', !!pv());          // 「· 이번 기간」(CSS) — 개인경비 화면
    var cur = curCyc();
    var last = RANGE ? RANGE.to : CYC;
    $('cycNext').disabled = cmpCycle(last, cur) >= 0;
    $('cycleBox').classList.toggle('multi', !!RANGE);
    // 마감 뒤 며칠(GRACE_DAYS) 동안의 방금 끝난 기간은 「지난 기간」(노랑)이 아니라 「마감 중」(2026-10-20)
    var gr = inGrace(CYC);
    $('cycleBox').classList.toggle('past', !RANGE && cmpCycle(CYC, cur) < 0 && !gr);
    $('cycleBox').classList.toggle('grace', gr);
    // 기간이 바뀌면 한 번 반짝 — 화면 전체가 다른 기간으로 바뀌었다는 것을 눈에 띄게.
    var sig = RANGE ? 'r' + cycKey(RANGE.from) + '~' + cycKey(RANGE.to) : 'c' + cycKey(CYC);
    if (CYC_SIG && CYC_SIG !== sig) {
      var bx = $('cycleBox'); bx.classList.remove('flash'); void bx.offsetWidth; bx.classList.add('flash');
      setTimeout(function () { bx.classList.remove('flash'); }, 1200);
    }
    CYC_SIG = sig;
  }
  var CYC_SIG = '';
  /** 이번 주기가 아닌 기간을 보고 있으면 모든 화면 맨 위에 띠 — 일지·영수증·정산이 모두 그 기간 기준이다. */
  function cycleBand() {
    var cur = currentCycle();
    // 기간 단추를 숨기는 화면(내 계정·조직도·권한 관리·교육 관리·안전교육)에는 「지난 기간」 띠도 달지 않는다(2026-10-16 3차).
    if (NOCYC_VIEWS.indexOf(VIEW) >= 0) return '';
    if (!RANGE && inGrace(CYC)) return graceBand();
    if (pv() && !RANGE) return pv().band ? pv().band() : '';
    if (RANGE) {
      // 닫는 </b> 는 esc 밖에(2026-10-24 검수 — 안에 있어 「</b>」가 글자로 보이고 뒤 문장까지 굵었다)
      return '<div class="cycband multi">' + ic('cal', 15) + '<span><b>' + esc(cycleName(RANGE.from) + ' – ' + cycleName(RANGE.to)) + '</b>' +
        ' (' + cyclesInView().length + '개 기간)을 한꺼번에 보고 있어요. 조회만 하고 고칠 수는 없어요.</span>' +
        '<button class="btn sm" data-cyc="' + cycKey(cur) + '">' + CR.short(cur) + (cur.x ? '로' : '으로') + ' →</button></div>';
    }
    if (cmpCycle(CYC, cur) < 0) {
      return '<div class="cycband">' + ic('cal', 15) + '<span>지금 <b>' + cycleName(CYC) + ' (' + esc(cycleSpan(CYC)) + ') · 지난 기간</b>을 보고 있어요. ' +
        '운행일지, 영수증, 정산 모두 이 기간 기준이에요.</span>' +
        '<button class="btn sm" data-cyc="' + cycKey(cur) + '">' + CR.short(cur) + (cur.x ? '로' : '으로') + ' →</button></div>';
    }
    return '';
  }
  /** 마감 뒤 며칠(GRACE_DAYS) 동안 방금 끝난 기간을 볼 때의 띠 — 「지난 기간」 대신 마감 안내(2026-10-20, 세 시스템 같은 띠).
   *  본인 화면에서 아직 상신 전(또는 반려·회수)이면 「지금 상신해 주세요」, 결재 중·완료면 그 상태만. 관리 화면은 안내만. */
  function graceBand() {
    var P = pv(), cur = curCyc(), key = cycKey(CYC);
    var r = cycleRange(CYC, kindOfView()), span = cycleSpan(CYC, kindOfView());
    var st = isAll() ? '' : P ? (P.status ? P.status(key) : '') : ((myAppr(key) || {}).status || '');
    var say = isAll() ? '아직 상신하지 않은 사람은 지금 상신하면 돼요.'
      : st === 'approved' ? '결재가 끝났어요.' : st === 'submitted' ? '결재 중이에요.'
      : st === 'rejected' ? '반려됐어요. 고쳐서 다시 상신해 주세요.'
      : '아직 상신 전이면 지금 상신해 주세요.';
    return '<div class="cycband grace" data-graceband>' + ic('cal', 15) + '<span><b>' + cycleName(CYC) + ' (' + esc(span) + ') · ' +
      esc(dueText(r, Date.now())) + '</b>. ' + say + '</span>' +
      '<button class="btn sm" data-cyc="' + cycKey(cur) + '">' + CR.short(cur) + ' 보기 →</button></div>';
  }
  /** 내 결재 상태 한 마디(주기 목록에 붙인다). */
  function myApprTag(key) {
    var a = myAppr(key);
    if (!a) return '';
    var m = { approved: ['결재 완료', 'ok'], submitted: ['결재 중', 'warn'], rejected: ['반려', 'bad'], withdrawn: ['회수', 'dim'] }[a.status];
    return m ? '<span class="st ' + m[1] + '">' + m[0] + '</span>' : '';
  }
  function paintCyclePop() {
    var cur = curCyc(), h = '', P1 = pv(), K1 = kindOfView();
    var spanOf = function (c) { return cycleSpan(c, K1); };
    var tagOf = function (k) { return P1 && P1.tag ? P1.tag(k) : myApprTag(k); };
    var q = function (label, attr, on) {
      return '<button class="cpq' + (on ? ' on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" ' + attr + '>' + label + '</button>';
    };
    var isR = function (from, to) {
      return RANGE && cmpCycle(RANGE.from, from) === 0 && cmpCycle(RANGE.to, to) === 0;
    };
    // 「작년 전체」 끝 = 작년 마지막 기간(연말 추가 기간이 있으면 그것, 2026-10-20)
    var prev = addCycle(cur, -1), y1 = { y: cur.y, m: 1 }, ly = toC(CR.lastOfYear(kindShown(), cur.y - 1));
    h += '<div class="cp-sec">빠른 선택</div><div class="cp-quick">' +
      q('이번 기간', 'data-cyc="' + cycKey(cur) + '"', !RANGE && cmpCycle(CYC, cur) === 0) +
      q('지난 기간', 'data-cyc="' + cycKey(prev) + '"', !RANGE && cmpCycle(CYC, prev) === 0) +
      q('최근 3개 기간','data-range="' + cycKey(addCycle(cur, -2)) + '~' + cycKey(cur) + '"', isR(addCycle(cur, -2), cur)) +
      q('최근 6개 기간','data-range="' + cycKey(addCycle(cur, -5)) + '~' + cycKey(cur) + '"', isR(addCycle(cur, -5), cur)) +
      (cur.m > 1 ? q(cur.y + '년 전체', 'data-range="' + cycKey(y1) + '~' + cycKey(cur) + '"', isR(y1, cur)) : '') +
      q((cur.y - 1) + '년 전체', 'data-range="' + (cur.y - 1) + '-01~' + cycKey(ly) + '"',
        isR({ y: cur.y - 1, m: 1 }, ly)) +
      '</div>';
    // 주기 목록 — 최근 24개. 오래된 것은 '직접 지정'으로 간다.
    // 목록은 그냥 버튼들이다. listbox/option 역할을 주면 화살표 키로 움직여야 하는데 그렇게 만들지 않았다 —
    // 역할만 붙이면 화면낭독기 사용자가 쓸 수 없는 목록이 된다. 지금 고른 것은 aria-current 로 알린다.
    h += '<div class="cp-sec" id="cpListLab">기간 고르기</div><div class="cp-list" role="group" aria-labelledby="cpListLab">';
    var opts = '';
    for (var i = 0; i < 24; i++) {
      var c = addCycle(cur, -i), on = !RANGE && cmpCycle(CYC, c) === 0;
      h += '<button class="cpi' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-cyc="' + cycKey(c) + '">' +
        '<b>' + cycleName(c) + '</b><span class="dim">' + spanOf(c) + '</span>' +
        (i === 0 ? '<span class="kind">이번</span>' : i === 1 && inGrace(c) ? '<span class="kind">마감 중</span>' : '') + '<span style="flex:1"></span>' + tagOf(cycKey(c)) + '</button>';
    }
    h += '</div>';
    for (var k = 0; k < 36; k++) {
      var c2 = addCycle(cur, -k);
      opts += '<option value="' + cycKey(c2) + '">' + cycleName(c2) + '</option>';
    }
    var f0 = RANGE ? cycKey(RANGE.from) : cycKey(addCycle(CYC, -2)), t0 = RANGE ? cycKey(RANGE.to) : cycKey(CYC);
    h += '<div class="cp-sec">여러 기간 직접 지정<small>조회 전용</small></div>' +
      '<div class="cp-range"><select id="cpFrom" aria-label="시작 기간">' + opts.replace('value="' + f0 + '"', 'value="' + f0 + '" selected') +
      '</select><span class="dim">부터</span><select id="cpTo" aria-label="끝 기간">' +
      opts.replace('value="' + t0 + '"', 'value="' + t0 + '" selected') +
      '</select><span class="dim">까지</span><button class="btn sm pri" id="cpGo">보기</button></div>' +
      // 「통행료 채우기」 화면은 없앴다(2026-10-15 — 통행료는 영수증으로). 모든 갈래가 같은 안내.
      '<div class="cp-note">여러 기간을 볼 때는 조회만 할 수 있어요. 상신, 결재 문서, 영수증 올리기는 한 기간을 골라서 하세요. ' +
      '<span class="kbdhint"><span class="kbd">[</span> <span class="kbd">]</span> 키로 앞뒤 기간으로 넘어가요.</span></div>';
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
  /** 'YYYY-M' · 'YYYY-MM' · 'YYYY-12b'(추가 기간, 2026-10-20) → c, 못 읽으면 null(해 2020~2100). */
  function parseCyc(s) { return CR.parse(String(s || '')); }
  /**
   * 기간을 바꾼다. p = { cyc:{y,m} } 또는 { range:{from,to} }.
   * 한 주기짜리 범위는 그냥 한 주기로 본다. 앞뒤가 바뀐 범위는 바로잡는다. 최대 36주기.
   */
  function setPeriod(p, opt) {
    // ★ 통행료 채우기에 쳐 둔 값은 기간이 바뀌면 사라진다. 40칸을 말없이 날리지 않는다.
    if (!(opt && opt.silent) && unsavedFills()) {
      openCyclePop(false);
      toast('저장하지 않은 통행료가 ' + n0(unsavedFills()) + '구간 있어요. ‘통행료 채우기’에서 먼저 저장해 주세요.', true);
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
    FINQ = {};                           // 결재 완료 출력 이름 찾기 — 기간을 바꾸면 비운다(2026-10-23)
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
      if (cmpCycle(c, curCyc()) > 0) return;
      setPeriod({ cyc: c });
    }
  }
  /** 보던 기간이 그 화면 갈래에 없는 추가 기간(…-12b)이면 그 달로(2026-10-20 연말 마감 — 추가 기간은 갈래마다 따로 둔다). 고쳤으면 true. */
  function fixX(v) {
    var k = kindShown(v), bad = function (c) { return !!(c && c.x && !CR.byKey(k, c)); };
    var mo = function (c) { return bad(c) ? { y: c.y, m: c.m } : c; };
    if (!bad(CYC) && !(RANGE && (bad(RANGE.from) || bad(RANGE.to)))) return false;
    if (RANGE) { RANGE = { from: mo(RANGE.from), to: mo(RANGE.to) }; CYC = RANGE.to; } else CYC = mo(CYC);
    return true;
  }
  /** 서버 기간 설정이 바뀐 뒤(늦게 받았을 때·관리 화면에서 저장한 뒤) — 기간을 확인하고 새 범위로 다시 받는다. */
  function rulesChanged() {
    if (fixX()) writeHash();
    paintCycle();
    loadAll({ soft: true });
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
    var m = /^#\/([a-z_]+)(?:\/(\d{4}-\d{1,2}b?)(?:~(\d{4}-\d{1,2}b?))?)?$/.exec(location.hash || '');
    if (!m) return null;
    var a = m[2] ? parseCyc(m[2]) : null, b = m[3] ? parseCyc(m[3]) : null;
    return { view: OLD_VIEWS[m[1]] || m[1], a: a, b: b };          // 예전 관리 화면 주소는 「현황」으로
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
      // toll_hipass: 하이패스 이용내역 PDF 로 맞춘 금액(금액 규칙 v3 하이패스 몫 — 운행 금액을 고쳐도 남는다, 2026-10-17)
      'toll_cost,toll_status,toll_source,toll_revision,toll_hipass,parking_cost,is_manual,' +
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

    // 확장 모듈(개인경비)이 같이 받을 것 — 실패해도 운행일지 적재는 그대로 끝나게 모듈 안에서 삼킨다.
    var extP = Promise.all(EXT.load.map(function (fn) {
      try { return Promise.resolve(fn(soft)).catch(function (e) { console.error(e); }); } catch (e) { return null; }
    }));
    var fresh = soft && STATIC_AT && Date.now() - STATIC_AT < CACHE_MS;
    // ★ 1000행씩 나눠 받는 읽기는 모두 겹치지 않는 열쇠로 정렬한다(2026-10-20 AU2 #16) — 정렬이 없거나 같은 값이 있으면
    //   페이지 경계에서 한 줄이 빠지거나 두 번 들어올 수 있다(지금은 1000행 미만이라 안 났다).
    var staticP = fresh ? Promise.resolve(null) : Promise.all([
      fetchAll('/rest/v1/app_users?select=username,name,dept,position,is_admin,plate_no,company_name,vehicle_type,signup_status,uses_driving&order=username.asc'),
      fetchAll('/rest/v1/app_vehicles?select=*&order=id.asc'),
      fetchAll('/rest/v1/evidences?select=id,username,vehicle_plate,date_millis,category,amount,memo,photo_path,scan_path,trip_id&order=id.asc'),
      fetchAll('/rest/v1/edu_videos?deleted=eq.false&select=*&order=month.desc,id.asc'),
      fetchAll('/rest/v1/edu_progress?select=*&order=username.asc,video_id.asc'),
      fetchAll('/rest/v1/edu_targets?select=*&order=month.asc,username.asc'),
      fetchAll('/rest/v1/fuel_rates?select=year,quarter,region,price&order=year.asc,quarter.asc,region.asc'),
      // 분기 경계 + 기간 설정(cycle_rules, 2026-10-20) — select=*: 칸 하나가 없는 서버여도 분기 경계까지 못 받는 일이 없게
      apiRetry('/rest/v1/app_config?id=eq.1&select=*').then(function (x) { return x.ok ? x.json() : []; }),
      // RLS 가 걸러 준다 — 본인 것 · 내가 결재자인 것 · 관리자는 전부.
      fetchAll('/rest/v1/driving_approvals?select=*&order=submitted_at.desc,id.desc'),
      // ※ 부서별 결재선(driving_approval_lines)은 더 읽지 않는다 — 결재선은 상신자가 직접 고른다(2026-10-02).
      // 결재자를 고르려면 사람 목록이 필요하다. app_users 는 본인만 보이므로 뷰를 쓴다.
      fetchAll('/rest/v1/v_driving_people?select=*&order=name.asc,username.asc'),
      // 조직도(사람 명단 — 관리 화면). 내려간 사람(active=false)은 받지 않는다.
      fetchAll('/rest/v1/driving_org?select=*&active=eq.true&order=sort.asc,id.asc'),
      // 관리자가 지정한 결재선(2026-10-14). 표가 아직 없거나 못 받아도 화면은 멈추지 않는다(자동 결재선만 쓴다).
      fetchLineOv()
    ]);

    Promise.all([tripsP, staticP, extP]).then(function (both) {
      // ★ 반드시 아무것도 대입하기 전에 버린다. 예전에는 아래 대입이 전부 끝난 뒤에
      //   가드가 있어서, 늦게 온 응답이 데이터는 덮어쓰고 다시 그리기만 건너뛰었다.
      //   그러면 머리띠는 8월분인데 숫자는 9월분인 화면이 된다(21일 마감에 서버가
      //   느려질 때 정확히 터지는 조건).
      if (seq !== LOAD_SEQ) return;
      var out = both[1];
      ALL_TRIPS = both[0] || [];
      LOADED_ALL = wantAll;
      // fetchAll 은 41,000행에서 멈춘다. 닿았으면 잘렸다는 것을 숨기지 않는다.
      if (ALL_TRIPS.length >= 41000) toast('운행이 너무 많아 일부만 불러왔어요. 기간을 줄여 주세요.', true);
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
        var rulesNew = !!(cfg && CR.set(cfg.cycle_rules));      // 서버 기간 설정이 바뀌었나(2026-10-20 연말 마감)
        APPR = out[8] || [];
        PEOPLE = {}; (out[9] || []).forEach(function (p) { PEOPLE[p.username] = p; });
        ORG = out[10] || [];
        setLineOv(out[11]);
        STATIC_AT = Date.now();
      }
      RATE_MISS = {};
      // 기간 설정이 바뀌었으면 이 응답의 운행은 옛 범위다 — 기간을 확인하고 새 범위로 한 번 더 받는다(늦게 온 이 응답은 LOAD_SEQ 가 버린다)
      if (rulesNew) { rulesChanged(); return; }
      LOADED = true; LOADING = false; AUDIT = null;
      // 받는 사이에 관리 화면으로 옮겨 갔는데 본인 것만 받아 왔으면, 전 직원 것으로 다시 받는다.
      if (isAll() && !LOADED_ALL) { loadAll({ soft: true }); return; }
      applyScope();
      paintPills();
      paintCycle();
      render();
      // 안전교육 이번 회차 내 대상 여부 스냅샷(앱 MainScreen 의 eduEnsureSelfTarget 과 같다, 2026-10-14).
      eduEnsureSelf();
    }).catch(function (e) {
      if (seq !== LOAD_SEQ) return;
      LOADING = false;
      if (e && e.authGone) {
        toast('로그인이 만료됐어요. 다시 로그인해 주세요.', true);
        setTimeout(signOut, 900);
        return;
      }
      // 스켈레톤에 갇히지 않게 다시 그린다 — 다시 시도할 수단도 화면에 남긴다.
      //   403(권한 없음)은 로그인을 끊지 않고 「권한이 없어요」로(2026-10-20 AU2 #17).
      LOAD_ERR = e && e.noPerm ? NO_PERM_MSG : '데이터를 불러오지 못했어요.';
      render();
      toast(LOAD_ERR, true);
      if (e && e.noPerm) console.warn('권한 없음(403) — 로그인은 그대로 둡니다'); else console.error(e);
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
        d: '같은 사람이 같은 차에서 1,000km 넘게 건너뛰었어요. 차를 바꿨거나 숫자를 잘못 넣은 경우예요.' },
      { k: 'shared', sev: 'bad', ico: 'car', t: '한 차를 두 사람이 쓴 번호판', rows: sharedRows, n: shared.length,
        d: shared.length ? shared.join(' · ') + '. 번호판을 잘못 고르면 남의 차 기록이 돼요.' : '없어요.' },
      { k: 'nopurp', sev: 'bad', ico: 'alert', t: '운행목적 미선택', rows: nopurp, n: nopurp.length,
        d: '목적이 비어 있으면 업무용으로 잡히지 않아 비용 정산에서 빠져요.' },
      { k: 'rate', sev: 'bad', ico: 'won', t: '유류단가 미등록', rows: [], n: missKeys.length,
        d: missKeys.length ? missKeys.join(' · ') + ' 단가가 없어 기본 단가 159원/km로 계산해요. 실제 단가와 다를 수 있으니 등록해 주세요.' : '없어요.' },
      { k: 'unk', sev: 'warn', ico: 'ticket', t: '통행료 미확정', rows: unk, n: unk.length,
        d: '지금은 통행료가 0원으로 계산돼요. 통행료를 냈으면 ‘영수증·통행료’ 단계에서 영수증을 올려 주세요. 그날 운행 금액이 없으면 영수증 금액으로 정산해요.' },
      { k: 'overlap', sev: 'warn', ico: 'list', t: '시간이 겹치는 운행', rows: overlap, n: overlap.length,
        d: '같은 사람이 같은 시간에 두 건을 기록했어요.' },
      { k: 'zero', sev: 'warn', ico: 'list', t: '0km 운행', rows: zero, n: zero.length,
        d: '거리가 0인 기록이에요. 잘못 눌렀거나 바로 껐을 때 생겨요.' }
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
   * 비용 합계. 주차비·통행료는 **금액 규칙 v3**(docs/money-rule-v3.md · money-rule.js)로 센다 — 엑셀·PDF·
   * 2단계 맞춰보기·결재 요약과 같은 계산 하나(moneyOf). 하루·구분마다: 운행 금액이 있으면 운행 금액(영수증은
   * 대조만), 없으면 그날 영수증 금액, 그날 업무 운행이 없으면 영수증을 뺀다. 예전(v2)에는 운행 금액 + 영수증을
   * 더해 같은 결제가 두 번 들어갔다(9/29 하이패스 500 + 영수증 500 = 1,000원).
   * 운행 목록 표의 소계처럼 '표에 있는 운행만' 원하면 opt.tripsOnly(운행에 적힌 금액 그대로).
   * evPark·evToll = 영수증으로 채운 금액(「영수증 ₩X 포함」) · evN = 그 영수증 장수 · noTripN·noTrip = 정산에서 뺀 영수증.
   */
  function totals(rows, opt) {
    var o = { n: rows.length, biz: 0, km: 0, bizKm: 0, fuel: 0, toll: 0, park: 0, unk: 0, manual: 0, evPark: 0, evToll: 0, evN: 0, noTripN: 0, noTrip: 0 };
    rows.forEach(function (t) {
      var d = Number(t.distance_km) || 0;
      o.km += d;
      if (t.is_manual) o.manual++;
      if ((t.purpose || '') !== BUSINESS) return;
      o.biz++;
      o.bizKm += d;
      o.fuel += tripFuel(t);
      if (isUnknownToll(t)) o.unk++;
      if (opt && opt.tripsOnly) {
        o.toll += Number(t.toll_cost) || 0;
        o.park += Number(t.parking_cost) || 0;
      }
    });
    if (!(opt && opt.tripsOnly)) {
      var users = {};
      rows.forEach(function (t) { users[t.username] = 1; });
      // 운행이 한 건도 없어도 영수증만 올린 사람이 있다(opt.who) — v3 에서는 모두 「운행 없는 영수증」(정산 제외)으로 센다.
      if (opt && opt.who) users[opt.who] = 1;
      var r = (opt && opt.range) || viewRange();
      if (opt && opt.allUsers) EVID.forEach(function (e) { var d = Number(e.date_millis); if (d >= r.lo && d < r.hi) users[e.username] = 1; });
      Object.keys(users).forEach(function (u) {
        var M = moneyOf(u, r, rows);
        var P = M['주차'].sum, L = M['통행료'].sum;
        o.park += P.settle; o.toll += L.settle;
        o.evPark += P.fill; o.evToll += L.fill; o.evN += P.fillN + L.fillN;
        o.noTripN += P.noTripN + L.noTripN; o.noTrip += P.noTrip + L.noTrip;
      });
    }
    o.cost = o.fuel + o.toll + o.park;
    return o;
  }
  /**
   * 한 사람·한 기간의 주차비·통행료 v3 결과(money-rule.js). 운행은 trips0(없으면 TRIPS), 영수증은 evid0(없으면 EVID)에서
   * 그 사람·그 기간 것만 고른다. 영수증의 trip_id 는 그 목록에 있는 운행일 때만 쓴다(linkedTrip·서버 dayOf 와 같다).
   * 정산 합계·엑셀·PDF·2단계 표·영수증 적기가 모두 이 함수를 부른다 — 따로 세지 않는다.
   */
  function moneyOf(u, r, trips0, evid0) {
    var trips = (trips0 || TRIPS).filter(function (t) {
      var s = Number(t.start_time);
      return t.username === u && !t.deleted_at && s >= r.lo && s < r.hi;
    });
    var ev = (evid0 || EVID).filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === u && d >= r.lo && d < r.hi;
    });
    return window.MoneyRule.compute({ trips: trips, evid: ev, toll: function (t) { return tollNeed(t).a; }, day: ymd });
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
    // 웹 8차(2026-10-17 「직원들이 잘 모를 것 같은데… 좀 쉽게」) — 맨 위 한 줄은 할 일만
    '주차': '주차비를 낸 날마다 주차 영수증 사진을 하나씩 올려 주세요. 운행에 주차비를 적지 않은 날은 영수증 금액이 그 운행에 들어가요.',
    '통행료': '통행료를 낸 날마다 증빙이 하나 있으면 돼요. 영수증 사진이나 하이패스 이용내역 PDF(한 달치)를 올려 주세요.',
    '주유': '주유 영수증은 증빙용이에요. 유류비는 거리 × 단가로 따로 계산해요.',
    '계기판': '월초·월말 계기판 사진을 올려 주세요. 운행 기록의 계기판 숫자와 비교해요.'
  };
  var EVSUB_FX = '';
  // 지금 차례도 사람마다(2026-10-21 — 같은 탭에서 다른 사람으로 들어오면 앞사람의 차례(계기판 등)에서 열리고 3단계로 넘어갈 수 있었다. evsubmax 와 같은 열쇠 모양)
  function evSubKey() { return 'drv.evsub.' + myName() + '.' + CYCKEY(); }
  function evSub() { var v = 0; try { v = +sessionStorage.getItem(evSubKey()) || 0; } catch (e) { } return Math.max(0, Math.min(3, v)); }
  /** 이 주기에서 영수증 차례를 어디까지 지나왔는가(0~3). 3 이면 계기판까지 왔다 — 3단계로 넘어갈 수 있다. */
  function evSubMax() { var v = 0; try { v = +localStorage.getItem('drv.evsubmax.' + myName() + '.' + CYCKEY()) || 0; } catch (e) { } return Math.max(evSub(), Math.min(3, v)); }
  function setEvSub(i, fx) {
    i = Math.max(0, Math.min(3, i));
    try { sessionStorage.setItem(evSubKey(), String(i)); } catch (e) { }
    try { if (i > evSubMax()) localStorage.setItem('drv.evsubmax.' + myName() + '.' + CYCKEY(), String(i)); } catch (e) { }
    EVSUB_FX = fx || '';
    EVF.cat = EV_SUBS[i]; EVF.touched = false;
  }
  /** 차례를 옮긴 뒤(「다음: 주유 →」 등) 새 차례 머리가 보이게 올린다 — 아래 단추를 누르면 화면이 그대로라 머리가 위로 잘려 있었다(2026-10-16 3차). */
  function evSubTop() {
    var go1 = function () {
      var el = document.querySelector('.evsubs'); if (!el) return;
      var hd = document.querySelector('header.top'), hb = hd ? hd.getBoundingClientRect().bottom : 0;
      var top = el.getBoundingClientRect().top;
      if (top < hb + 4 || top > window.innerHeight * 0.5) window.scrollTo({ top: Math.max(0, window.scrollY + top - hb - 12), behavior: (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') });
    };
    if (window.requestAnimationFrame) requestAnimationFrame(go1); else setTimeout(go1, 0);
  }
  /** 하이패스 대조·통행료 직접 채우기를 마치고 영수증 › 2/4 통행료 차례로 돌아온다 — 거기서 금액을 보고 「다음: 주유」. */
  function tollBack(msg) {
    setEvSub(EV_SUBS.indexOf('통행료'), 'back');
    go('evid');
    if (msg) toast(msg);
  }
  /** 내 이 기간이 결재 중·결재 완료라 영수증을 올리거나 고칠 수 없는가(여러 기간 보기는 따로 막는다). */
  function myCycLocked() { return !isMulti() && !!myName() && cycleLocked(myName()); }
  /** 영수증 차례마다 확인할 것 수(탭의 「확인 N」, 2026-10-20 디자인 v2) — 마감 화면 남은 일(closeTasks)과 같은 기준.
   *  주차·통행료 = 영수증 없음·금액 다름·운행 없는 날·두 번 정산 의심인 날 · 주유 = 영수증이 청구 유류비보다 적음 · 계기판 = 사진 없는 차.
   *  결재 중·완료 기간은 고칠 수 없으니 세지 않는다. */
  function evNeed() {
    var me = myName(), out = {};
    if (!me || isMulti() || myCycLocked()) return out;
    var r = cycleRange(CYC), M = moneyOf(me, r, ALL_TRIPS, ALL_EVID);
    // 같은 금액 영수증 확인을 기다리는 날(2026-10-21 통행료 버그 2 — 맞춰보기 표 그 줄 「확인」)도 센다
    var dupD = dupFillDays(M).filter(function (x) { return x.ask.length && x.d.show; });
    ['주차', '통행료'].forEach(function (c) {
      out[c] = M[c].days.filter(function (d) { return d.show && (d.st === 'no_receipt' || d.st === 'mismatch' || d.st === 'no_trip' || d.twice); }).length +
        dupD.filter(function (x) { return x.cat === c; }).length;
    });
    var biz = ALL_TRIPS.filter(function (t) { return t.username === me && !t.deleted_at && (t.purpose || '') === BUSINESS && t.start_time >= r.lo && t.start_time < r.hi; });
    var claim = Math.round(biz.reduce(function (a, t) { return a + tripFuel(t); }, 0));
    var paid = ALL_EVID.filter(function (e) { var d = Number(e.date_millis); return e.username === me && e.category === '주유' && d >= r.lo && d < r.hi; })
      .reduce(function (a, e) { return a + (Number(e.amount) || 0); }, 0);
    out['주유'] = claim > paid + 1 ? 1 : 0;
    out['계기판'] = odoPhotoMissing().length;
    return out;
  }
  /** 「올리기」 카드 아래 금액 설명(2026-10-20 디자인 v2, P_Evid) — 정산에 들어가는 금액과 올린 영수증 합계(마감 화면·2단계 표와 같은 계산 moneyOf).
   *  ★ 표시 이름 data-evamtbox — data-evamt 는 영수증 올리기 창의 금액 칸이다(같은 이름이면 [data-evamt] 로 칸을 찾는 곳이 이 상자를 집는다, 2026-10-20 통합 검증). */
  function evAmtHtml(cat) {
    var me = myName(); if (!me) return '';
    var MC = moneyOf(me, cycleRange(CYC), ALL_TRIPS, ALL_EVID)[cat], MS = MC.sum;
    var word = cat === '주차' ? '주차비' : '통행료', H = MC.days.reduce(function (a, d) { return a + (d.H || 0); }, 0);
    return '<div class="evamt" data-evamtbox><dl class="cdl"><dt><b>정산에 들어가는 ' + word + '</b></dt><dd><b>' + n0(MS.settle) + '원</b></dd>' +
      '<dt>올린 ' + cat + ' 영수증</dt><dd>' + n0(MS.R) + '원</dd>' + (H ? '<dt>하이패스 이용내역</dt><dd>' + n0(H) + '원</dd>' : '') + '</dl>' +
      '<p>운행 금액이 있는 날은 운행 금액으로 정산하고 영수증 금액은 더하지 않아요. 운행이 없는 날의 영수증은 정산에서 빠져요.</p></div>';
  }
  /** 영수증 화면 위 — 주차 → 통행료 → 주유 → 계기판 차례와 지금 차례의 할 일. */
  function evSubHtml(by, unk) {
    var cur = evSub(), name = EV_SUBS[cur];
    // 지나온 차례라도 영수증 없음·금액 다름·운행 없는 영수증이 남았으면 「✓」 대신 「!」(2026-10-16 3차 — 결재 요약 「✓ 통행료 모두 확정」과 같은 원칙)
    var left = {};
    if (cur > 0 && myName()) {
      var MM = moneyOf(myName(), cycleRange(CYC), ALL_TRIPS, ALL_EVID);
      ['주차', '통행료'].forEach(function (c) {
        left[c] = ((MM[c] || {}).days || []).filter(function (d) { return d.show && (d.st === 'no_receipt' || d.st === 'mismatch' || d.st === 'no_trip'); }).length;
      });
    }
    // 차례마다 확인할 것 수 — 탭의 「확인 N」(2026-10-20 디자인 v2, P_Evid). 마감 화면 남은 일과 같은 기준(evNeed)
    var need = evNeed();
    var steps = '<div class="evsubs" role="list">' + EV_SUBS.map(function (c, i) {
      var st = i < cur ? 'done' : i === cur ? 'now' : '';
      var n = (by[c] || {}).n || 0, lf = st === 'done' && left[c] > 0;
      return '<button role="listitem" class="evs ' + st + (lf ? ' left' : '') + '" data-evsub="' + i + '"' + (st === 'now' ? ' aria-current="step"' : '') +
        (lf ? ' title="확인할 날이 ' + n0(left[c]) + '일 남았어요"' : '') + '>' +
        '<i>' + (lf ? '!' : st === 'done' ? '✓' : i + 1) + '</i><b>' + esc(c) + '</b><span>' + n0(n) + '장</span>' +
        (need[c] ? '<em class="evq" title="확인할 것 ' + n0(need[c]) + '">확인 ' + n0(need[c]) + '</em>' : '') + '</button>' +
        (i < 3 ? '<span class="evsarrow" aria-hidden="true">›</span>' : '');
    }).join('') + '</div>';
    var body = '<div class="evsubcard' + (EVSUB_FX ? ' stepfx ' + EVSUB_FX : '') + '">' +
      '<div class="evsh"><span class="evsn">' + (cur + 1) + ' / 4</span><b>' + esc(name) + '</b>' +
      // 결재 중·결재 완료 기간은 「올리세요」 대신 올릴 수 없다는 말(2026-10-19 마지막 검증 — 잠긴 기간에도 할 일 문구가 나왔다)
      '<span class="dim">' + esc(myCycLocked() ? lockWhy(myName()) + ' 이 기간에는 영수증을 올리거나 지울 수 없어요. 아래 내용은 확인만 하세요.' : EV_SUB_DESC[name]) + '</span>' +
      // 올린 영수증 표(「내역」)는 화면 맨 아래라 지우려는 분이 한참 내려가며 찾았다 — 바로 가는 단추(2026-10-19 로봇 넷 중 셋)
      //   계기판은 영수증이 아니라 사진(2026-10-20 V3 다듬기 — 「계기판 영수증 1건」)
      ((by[name] || {}).n ? '<button type="button" class="btn sm evjump" data-evjump>' + (name === '계기판' ? '계기판 사진 ' + n0(by[name].n) + '장' : esc(name) + ' 영수증 ' + n0(by[name].n) + '건') + ' 보기·지우기 ↓</button>' : '') +
      '</div>';
    // 공지 띠는 이번 달 마감 화면에만(2026-10-19 웹 사용성 1차 — 같은 띠가 두 화면에 나오던 것)
    var canUp = !cycleLocked(myName()) && !isMulti();
    // 웹 8차(2026-10-17 사용자 「직원들이 잘 모를 것 같은데… 좀 쉽게 할 수 없나?」) — 주차·통행료는 할 일을 맨 위 단추로.
    //   통행료: 같은 크기 단추 둘(영수증 사진 · 하이패스 이용내역 PDF — 둘 중 하나면 된다). 하이패스 단추는 바로 파일을 고르고
    //   하이패스 화면에서 읽은 결과·「확정하기」를 보인다(예전 「하이패스 PDF로 대조」 작은 단추 → 빈 화면 → 파일 고르기).
    //   「다른 운행에 붙이기」 큰 단추는 내리고, 운행 없는 날 줄에만 작은 「다른 운행에 붙이기」(아래 evMatchHtml).
    // 2026-10-20 디자인 v2(P_Evid): 차례 카드 = 왼쪽 날짜별 확인(main) · 오른쪽 「올리기」 카드(side — 끌어 놓기 · 하이패스 PDF · 금액 설명). 좁으면 올리기가 위.
    //   빨간 단추는 하나 — 이 차례에 확인할 것이 남았으면 올리기 단추, 없으면 「다음」 단추.
    //   아직 1단계 차례(evAhead — 맨 아래 「1단계로 가기」가 빨강)면 올리기 단추도 빨갛게 하지 않는다.
    //   그 빨간 단추가 이 화면에서 깜빡이는 하나(cta — 「확인 N」이 있어도 올리기 단추가 깜빡인다, 2026-10-20 V3 U1)
    var side = '', main = '', hot = !!need[name] && !evAhead();
    if ((name === '주차' || name === '통행료') && canUp) {
      side += '<div class="evpick' + (name === '통행료' ? ' two' : '') + '">' +
        '<div class="evpk" data-evdrop="' + esc(name) + '"><span class="ico" aria-hidden="true">' + ic('upload', 24) + '</span><b>영수증 사진·PDF를 여기에 끌어 놓으세요</b>' +
          '<button class="btn' + (hot ? ' pri cta' : '') + '" data-evupcat="' + esc(name) + '">' + ic('receipt', 15) +
          (name === '통행료' ? '영수증 사진 올리기' : '주차 영수증 올리기') + '</button>' +
          '<span class="dim">' + (name === '통행료' ? '통행료 영수증 사진이나 PDF를 여러 장 한 번에 올려도 돼요.' : '영수증 사진이나 PDF를 여러 장 한 번에 올려도 돼요.') + '</span></div>' +
        (name === '통행료'
          ? '<div class="evpk"><b>하이패스 이용내역 PDF</b><label class="btn" data-hpquick>' + ic('ticket', 15) + '하이패스 이용내역 PDF 올리기' +
              '<input type="file" id="hpQuick" accept="application/pdf,.pdf" multiple class="sr"></label>' +
              '<span class="dim">한국도로공사 하이패스 누리집 › 이용내역에서 PDF로 다운로드한 한 달치 파일이에요. 통과 시각으로 운행을 찾아 그날 통행료 증빙이 돼요. 하이패스로 낸 통행료는 영수증 사진을 따로 올리지 않아도 되고, 올려도 한 번만 계산해요. 하이패스 홈페이지의 영수증 출력 화면을 PDF로 저장한 파일도 돼요.</span></div>'
          : '') +
        '</div>' + evAmtHtml(name);
    }
    if (name === '통행료') {
      // 통행료 미확정 — 자동 계산이 안 된 업무 운행(예전 「통행료 채우기」 화면 대신 한 줄로, 2026-10-15)
      //   2026-10-16 6차: 「모름」 운행은 맞춰보기 표(그날 금액·영수증이 있는 날만)에 줄이 없어 「운행을 눌러」 고칠 곳이 안 보였다 —
      //   그 운행들을 여기 단추로 바로 보인다(누르면 운행 고치기 창). 결재 중·완료 기간은 고칠 수 없다고만 적는다.
      if (unk.length) {
        var unkLock = cycleLocked(myName());
        var unkSorted = unk.slice().sort(function (x, y) { return x.start_time - y.start_time; });
        // 통행료 맞추기 제안(2026-10-21 사용자 결정 「제안 + 한 번 눌러 확정」 — toll-suggest.js): 맨 위 한 줄 「… 제안: 없음 X건 · 금액 Y건 [제안 보기·맞추기]」.
        //   정산 규칙은 그대로 — 창에서 고른 줄만 운행 고치기와 같은 길(trip-edit)로 적는다. 결재 중·완료 기간은 제안하지 않는다.
        //   ★ 단추는 빨강(.pri)이 아니다 — 이 차례 카드의 빨간 단추는 하나(올리기 또는 「다음」, 2026-10-20 디자인 v2)
        var SGn = unkLock ? null : tollSugPlan();
        var sugLine = SGn && SGn.n.unk ? '<span class="tsline" data-tollsug><span class="tsl"><b>통행료 미확정 ' + n0(unk.length) + '건</b>. 영수증·하이패스로 맞춘 제안: ' +
          '없음 ' + n0(SGn.n.none) + '건 · 금액 ' + n0(SGn.n.amount) + '건' + (SGn.n.pick ? ' · 직접 고르기 ' + n0(SGn.n.pick) + '건' : '') +
          (SGn.n.auto ? ' · 영수증으로 채움 ' + n0(SGn.n.auto) + '건' : '') + '</span>' +
          '<button type="button" class="btn sm tsopen" data-tollsugopen>' + ic('check', 13) + '제안 보기·맞추기</button></span>' : '';
        main += '<div class="hpnote' + (sugLine ? ' tsnote' : '') + '" data-tollunk style="margin-top:12px">' + ic('ticket', 15) + '<span>' +
          (sugLine || '<b>통행료 미확정 ' + n0(unk.length) + '건</b>. ') +
          (unkLock ? lockWhy(myName()) + ' 고칠 수 없어요. 이 운행들의 통행료는 0원으로 정산돼요.'
            : (sugLine ? '<span class="tsrest">' : '') + '자동 계산이 안 된 업무 운행이에요. 통행료를 냈으면 영수증 사진이나 하이패스 이용내역 PDF를 올려 주세요. 영수증 금액은 그날 통행료 금액이 적힌 운행이 없을 때만 정산에 들어가요. ' +
              '안 냈으면 아래 운행을 눌러 통행료를 ‘없음’으로 고쳐 주세요.' + (sugLine ? '</span>' : '') +
              '<span class="unklist">' + unkSorted.slice(0, 12).map(function (t) {
                return '<button type="button" class="btn sm" data-edit="' + t.id + '" title="이 운행 고치기">' + esc(md(t.start_time) + ' ' + hm(t.start_time)) +
                  ' · ' + esc(t.visit_place || placeShort(t.end_address) || '방문처 없음') + '</button>';
              }).join('') + (unkSorted.length > 12 ? '<span class="dim">외 ' + n0(unkSorted.length - 12) + '건은 1단계 운행 기록에서 확인하세요.</span>' : '') + '</span>') +
          '</span></div>';
      }
    }
    // 주차·통행료: 날짜로 운행에 안 맞는 영수증을 본인이 운행을 골라 직접 잇는다(2026-10-07) — 웹 8차부터 그 줄의 「다른 운행에 붙이기」(evMatchHtml).
    // 「운행 없는 영수증」 경고는 따로 띠를 두지 않고 맞춰보기 맨 위 한 줄 요약에 넣는다(2026-10-15 2차 —
    //   경고 띠와 초록 「모두 맞습니다」가 같은 영수증에 함께 보이던 것 정리).
    main += evMatchHtml(name);
    // 같은 창(openEvUpload)을 여는 단추는 이 카드 하나 — 내역 머리 「영수증 올리기」는 뺐다(2026-10-15 2차 「똑같은 내용 아니야? 버튼??」).
    //   계기판은 검증 화면(drv-verify.js)과 같은 이름 「계기판 사진 올리기」. 2026-10-20: 오른쪽 「올리기」 카드(끌어 놓기)로 옮겼다.
    var upHere = canUp && name !== '주차' && name !== '통행료';       // 주차·통행료는 위 「할 일」 단추(웹 8차)
    if (upHere) side += '<div class="evpick"><div class="evpk" data-evdrop="' + esc(name) + '"><span class="ico" aria-hidden="true">' + ic('upload', 24) + '</span>' +
      '<b>' + (name === '계기판' ? '계기판 사진을' : esc(name) + ' 영수증을') + ' 여기에 끌어 놓으세요</b>' +
      '<button class="btn' + (hot ? ' pri cta' : '') + '" data-evupcat="' + esc(name) + '">' + ic('receipt', 13) +
      (name === '계기판' ? '계기판 사진 올리기' : esc(name) + ' 영수증 올리기') + '</button></div></div>';
    // ★ <aside> 를 쓰지 않는다 — 왼쪽 메뉴(aside#nav)용 aside{…} 규칙(폭 248·고정·폰에서 숨김)이 그대로 걸린다
    body += '<div class="evcols"><div class="evmain">' + main + '</div>' + (side ? '<div class="evside" role="group" aria-label="올리기">' + side + '</div>' : '') + '</div>';
    var nextCls = hot ? 'btn' : 'btn pri cta';
    body += '<div class="evsact">' +
      '<span style="flex:1"></span>' +
      (cur > 0 ? '<button class="btn" data-evsubmove="-1">← ' + esc(EV_SUBS[cur - 1]) + '</button>' : '') +
      // 아직 1단계 차례인데 영수증 화면을 먼저 열었으면 카드의 「다음: … →」는 숨긴다 — 맨 아래 「지금은 1단계 차례 → 1단계로」와
      //   서로 다른 길을 가리켰다(2026-10-19 웹 사용성 1차). 위 차례 칩으로는 그대로 오갈 수 있다.
      (evAhead() ? ''
        : cur < 3 ? '<button class="' + nextCls + '" data-evsubmove="1">다음: ' + esc(EV_SUBS[cur + 1]) + ' →</button>'
        : (stepNow() === 2 && !cycleLocked(myName()) && !isMulti()
          ? '<button class="' + nextCls + '" data-stepmove="1" data-from="2">다음: 3 검증·상신 →</button>'
          : '<span class="dim" style="font-size:13px">영수증 단계의 마지막 차례예요.</span>')) +
      '</div></div>';
    EVSUB_FX = '';
    return '<section class="sect">' + steps + body + '</section>';
  }
  /* ── 영수증 차례마다 「맞춰보기」(2026-10-07) ──
     서버 검증(driving-verify.ts R06·R10·R13·R11·A02·A05)과 같은 기준을 그 자리에서 보여 준다.
       · 주차·통행료: 금액 규칙 v3(money-rule.js) — 하루마다 운행 금액 ↔ 영수증. 정산에는 운행 금액이 들어가고
         (영수증은 대조만), 운행 금액이 없는 날만 영수증 금액이 들어간다. 출처(자동·하이패스·직접)는 가리지 않는다.
       · 주유: 주유 영수증 합계 ≥ 청구 유류비(업무 거리 × 단가).
       · 계기판: 계기판 사진 숫자 ≥ 운행일지 최종 km.
     사진에서 읽은 숫자(AI)는 「검증하기」를 한 번 돌려야 생긴다(evidence_ai). 없으면 그렇게 안내한다. */
  var AIR = {}, AIR_ASKED = {}, AIR_DONE = {};
  /** 주차·통행료 맞춰보기 표를 접어 둘지(구분마다 — 기본은 접음, 2026-10-15 2차). false 면 펼침. */
  var MFOLD = {};
  function loadAiReads() {
    var k = myName() + '|' + CYCKEY();
    if (AIR_ASKED[k] || !myName()) return;
    AIR_ASKED[k] = 1;
    apiRetry('/rest/v1/evidence_ai?select=evidence_id,photo_path,result&username=eq.' + encodeURIComponent(myName()))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        (rows || []).forEach(function (x) { AIR[x.evidence_id] = x; });
        AIR_DONE[k] = 1;
        if (VIEW === 'evid' && !$('panel').classList.contains('open')) render();
      }).catch(function () { delete AIR_ASKED[k]; AIR_DONE[k] = 1; });
  }
  /** 사진 판독(evidence_ai)을 한 번 받아 봤는가(받았거나 못 받았거나) — 영수증 적기가 같은 금액 영수증의 시각(원본 장 판독)을 보기 전에 기다린다(2026-10-21). */
  function airReady() { return !!AIR_DONE[myName() + '|' + CYCKEY()]; }
  /** 이 영수증 사진에서 AI 가 읽은 결과(사진이 바뀌었으면 없음으로). */
  function aiOf(e) {
    var x = AIR[e.id];
    if (!x || x.photo_path !== e.photo_path) return null;
    var r = x.result || {};
    if (r.legible === false || r.kind === 'unreadable' || r.kind === 'other') return null;   // 서버도 금액·km 비교에서 뺀다
    return r;
  }
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
    var me = myName(), r = cycleRange(CYC);
    loadAiReads();
    var biz = ALL_TRIPS.filter(function (t) {
      return t.username === me && !t.deleted_at && (t.purpose || '') === BUSINESS && t.start_time >= r.lo && t.start_time < r.hi;
    });
    var evs = ALL_EVID.filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === me && e.category === cat && d >= r.lo && d < r.hi;
    });
    var DOW = ['일', '월', '화', '수', '목', '금', '토'];
    var dn = function (k) { var p = k.split('-'); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); return p[1] + '.' + p[2] + '(' + DOW[d.getUTCDay()] + ')'; };
    var ok = function (t) { return '<span class="mres ok">' + ic('check', 12) + esc(t) + '</span>'; };
    var bad = function (t) { return '<span class="mres bad">' + esc(t) + '</span>'; };
    var box = function (good, headline, sub, table) {
      return '<div class="mbox ' + (good ? 'good' : 'bad') + '"><div class="mhead"><span class="mmark">' + (good ? '✓' : '!') + '</span>' +
        '<div><b>' + headline + '</b>' + (sub ? '<div class="msub">' + sub + '</div>' : '') + '</div></div>' + (table || '') + '</div>';
    };
    var won = function (v) { return n0(v) + '원'; };

    if (cat === '주차' || cat === '통행료') {
      // 금액 규칙 v3(2026-10-15 사용자) — 정산·엑셀·PDF·결재 금액과 같은 계산(moneyOf → money-rule.js) 하나를 그대로 보인다.
      var MM0 = moneyOf(me, r, ALL_TRIPS, ALL_EVID), MC = MM0[cat], MS = MC.sum;
      // 기간 경계에 걸친 이은 영수증 — 금액은 그대로, 문구만(2026-10-17 사용자). 이 구분 것만.
      var XL0 = xlinkOf(me, r), XL = { here: XL0.here.filter(function (x) { return x.e.category === cat; }), there: XL0.there.filter(function (x) { return x.e.category === cat; }) };
      var xlHtml = !(XL.here.length + XL.there.length) ? '' :
        '<div class="hpnote warn" data-xlink style="margin-top:10px">' + ic('alert', 15) + '<span><b>기간 경계에 걸친 영수증 ' + n0(XL.here.length + XL.there.length) + '장</b>. ' +
        '영수증 날짜와 연결한 운행의 기간이 달라요. 금액은 그대로 두었으니 직접 확인해 주세요.' +
        XL.here.concat(XL.there).slice(0, 5).map(function (x) { return '<span class="xlitem">' + esc(x.say) + '</span>'; }).join('') +
        (XL.here.length + XL.there.length > 5 ? '<span class="xlitem dim">외 ' + n0(XL.here.length + XL.there.length - 5) + '장</span>' : '') + '</span></div>';
      var word = cat === '주차' ? '주차비' : '통행료', isToll = cat === '통행료';
      var warnR = function (t) { return '<span class="mres warn">' + esc(t) + '</span>'; };
      // 통행료 맞추기 제안(2026-10-21 — toll-suggest.js) — 금액 다름인 날에 「모름」 운행이 있으면(그날 다른 운행에 금액이 있어 영수증이 채우지 못한 운행)
      //   그 줄 안내 「이 날 모름 운행 HH:MM 에 금액을 넣으세요(제안 X원)」 · 고치기·줄 누르기 = 그 운행 · 자세히 보기에 영수증 지우기 권유 없음(서버 R10 과 같은 글자).
      //   결재 중·완료 기간·모듈 없음이면 예전 그대로(SG 없음).
      var SG = isToll ? tollSugPlan(MM0) : null;
      var sgOf = function (d) { var g = SG && d.st === 'mismatch' && SG.days[d.day]; return g && g.unk.length ? g : null; };
      var sgTrip = function (g) { var it = g.items.filter(function (x) { return x.kind === 'amount'; })[0] || g.items[0]; return it ? it.trip : g.unk[0]; };
      // 운행 없는 날 영수증 → 그 줄에만 작은 「다른 운행에 붙이기」(웹 8차 — 예전 큰 「다른 운행에 붙이기」 단추)
      var canLink = !cycleLocked(me) && !isMulti();
      // 그날 업무 운행 — 시각 · 방문처 · 그 운행의 금액. 줄마다 눌러서 그 운행 고치기 창(수기로 고치기).
      // 영수증 칸 — 하이패스 이용내역(그 자체가 증빙, 2026-10-15)과 올린 영수증을 한 덩이로 읽히게(웹 8차):
      //   「하이패스 500원 (+ 같은 영수증 사진)」 · 「하이패스 500원 + 영수증 700원」 · 「1,100원 (2장)」 · 「없음」
      var rcpt = function (d) {
        var U = d.R - (d.D || 0);
        if (d.H) return '하이패스 ' + won(d.H) + (U ? ' + 영수증 ' + won(U) : '') + (d.D ? ' <span class="dim">(+ 같은 영수증 사진)</span>' : '');
        return d.R ? won(d.R) + (d.ev.length > 1 ? ' <span class="dim">(' + d.ev.length + '장)</span>' : '') : '<span class="dim">없음</span>';
      };
      var tripsTxt = function (d) {
        if (!d.trips.length) return '<span class="dim">그날 업무 운행 없음</span>';
        // 금액 다름인 날의 「모름」 운행도 보인다(2026-10-21 — 금액을 넣을 곳이 그 운행인데 줄에 없었다)
        var g = sgOf(d), isUnkHere = function (t) { return !!g && g.unk.some(function (u) { return String(u.id) === String(t.id); }); };
        var pick = d.trips.filter(function (t) { return d.amt[t.id] > 0 || d.fill[t.id] > 0 || isUnkHere(t); });
        if (!pick.length) pick = d.trips;
        var show = pick.slice(0, 3).map(function (t) {
          var a = d.amt[t.id] || 0, f = d.fill[t.id] || 0;
          return '<button type="button" class="mtrip" data-edit="' + t.id + '" title="이 운행 고치기"><span class="mt">' + esc(hm(t.start_time)) + '</span>' +
            '<span class="mp">' + esc(t.visit_place || placeShort(t.end_address) || '방문처 없음') + '</span>' +
            (a ? ' <span class="dim">· ' + word + ' ' + n0(a) + '</span>' : f ? ' <span class="dim">· 영수증 ' + n0(f) + (DUPD[d.day] ? ' 넣을 차례(확인 전)' : ' 넣음') + '</span>'
              : isUnkHere(t) ? ' <span class="dim mtunk">· 통행료 모름</span>' : '') + '</button>';
        }).join('');
        return show + (pick.length > 3 ? '<div class="dim">외 ' + (pick.length - 3) + '건</div>' : '');
      };
      var nBad = 0, nNoTrip = 0, nOld = 0, nOk = 0, nTwice = 0, nAi = 0, nDupF = 0;
      // 같은 금액 영수증(2026-10-21 통행료 버그 2) — 영수증으로 채울 날인데 시각으로 못 가른 같은 금액 묶음이 있으면 영수증 적기가 적지 않고 묻는다.
      //   그 줄: 결과 「같은 금액 영수증 N장 — 확인」 + 줄 끝 「확인」(확인 창 openDupFill). 결재 중·완료 기간은 예전 그대로(적지도 묻지도 않는다).
      var DUPD = {};
      if (canLink) MC.days.forEach(function (d) {
        if (d.st !== 'filled' || d.twice) return;
        var g = window.MoneyRule.sameAmt(d.ev, evTimeOf).filter(function (x) { return !x.sep; });
        if (g.length) DUPD[d.day] = g;
      });
      // 다음 날 날짜로 올라온 전날 영수증 — 두 번 정산 의심(2026-10-20 사용자 결정 ② · money-rule.js d.twice = 서버 R14). 자동으로 옮기지 않고 그 줄에 안내만.
      var twMd = function (d) { return d.twice.prev.slice(5).replace('-', '.'); };
      var twTxt = function (d) {
        return canLink ? '전날(' + twMd(d) + ') 운행 영수증이면 ‘다른 운행에 붙이기’로 전날 운행에 연결해 주세요. 그대로 두면 두 번 정산될 수 있어요.'
          : '전날(' + twMd(d) + ') 운행 영수증일 수 있어요. 그대로 두면 두 번 정산될 수 있어요.';
      };
      var rows = MC.days.map(function (d) {
        var aiNote = [];
        d.ev.forEach(function (e) {
          // 한 장에 여러 영수증을 찍어 올린 줄(원본 scan_path)은 오려 낸 사진이 어긋나거나 장 전체라 사진 금액을 대조하지 않는다
          //   (2026-10-21 직원 10월분 사례 — 입력은 원본과 같은데 「사진엔 1,000원(입력 1,900원)」).
          //   서버는 이제 원본 장을 한 번 읽어 검증할 때마다 그때 입력값으로 줄마다 짝지어 대조한다(driving-verify.ts 원본 장 짝짓기 — 원본에
          //   없는 줄은 A11, 같은 영수증 두 줄은 A06). evidence_ai 에 남은 줄마다 값은 읽을 때 짝지은 것이라 줄을 고친 뒤엔 낡을 수 있어,
          //   여기서는 그대로 건너뛰고 검증 화면(A11·A06)이 알린다.
          if (e.scan_path) return;
          var ai = aiOf(e);
          if (ai && ai.amount != null && isFinite(Number(ai.amount)) && Math.round(Number(ai.amount)) !== Number(e.amount))
            aiNote.push('사진엔 ' + won(Math.round(Number(ai.amount))) + ' (입력 ' + won(e.amount) + ')');
        });
        // 「10월분부터」(2026-10-15 추가 결정) — 09-21 전 날은 금액만 보이고 결과(영수증 없음·금액 다름·운행 없는 영수증)는 내지 않는다
        if (!d.show) aiNote = [];
        // 결과 글은 할 일이 보이게(웹 8차, 2026-10-17 「직원이 쉽게」)
        //   금액 다름 + 「모름」 운행 + 증빙이 남는 날(2026-10-21) — 「금액 다름 — 이 날 모름 운행 HH:MM 에 금액을 넣으세요(제안 X원)」
        var sgd = sgOf(d), sgGo = !!(sgd && sgd.diff > 0);
        var dupG = d.show ? DUPD[d.day] || [] : [], dupN = dupG.reduce(function (s, g) { return s + g.ev.length; }, 0);
        var res = !d.show ? '<span class="dim">10월분 전이라 확인하지 않아요.</span>'
          : d.st === 'no_receipt' ? bad(myCycLocked() ? '영수증 없음' : isToll ? '영수증 없음. 사진이나 하이패스 PDF를 올려 주세요.' : '영수증 없음. 영수증 사진을 올려 주세요.')
          : d.st === 'mismatch' ? bad(sgGo ? '금액 다름. ' + endDot(window.TollSuggest.rowSay(sgd)) :'금액 다름. 운행 금액이나 영수증을 확인해 주세요.')
          : d.st === 'no_trip' ? warnR('운행 없는 날. 정산에서 빠져요.')
          : d.st === 'filled' && d.twice ? warnR('두 번 정산 의심') +
            '<div class="mtw" data-twice="' + esc(d.twice.prev) + '">' + esc(twTxt(d)) + '</div>'
          : dupG.length ? warnR('같은 금액 영수증 ' + n0(dupN) + '장. 확인해 주세요.') +
            '<div class="mtw" data-dupday="' + esc(d.day) + '">' + esc('같은 영수증을 두 번 올렸는지, 실제로 여러 번 냈는지(왕복 등) ‘확인’에서 골라 주세요. 고르기 전까지는 운행 ' + word + '를 비워 두고 영수증 합계로 정산해요.') + '</div>'
          : d.st === 'filled' ? ok('맞음 · 영수증 금액을 넣음')
          : ok('맞음');
        if (aiNote.length) res += ' ' + bad('사진 금액과 다름');
        if (d.st === 'no_trip' && d.show) XL.here.forEach(function (x) {
          if (d.ev.indexOf(x.e) >= 0) res += '<div class="mxl" title="' + esc(x.say) + '">' + esc(md(x.t.start_time)) + ' 운행(' + CR.short(cycleOfMs(Number(x.t.start_time))) + ')에 이음 · 어느 기간에도 정산 안 됨</div>';
        });
        var isBad = d.show && (d.st === 'no_receipt' || d.st === 'mismatch' || aiNote.length > 0);
        if (isBad) nBad++;
        if (isBad && d.st !== 'no_receipt' && d.st !== 'mismatch') nAi++;     // 사진에서 읽은 금액만 다른 날(한 줄 안내용, 2026-10-20)
        if (d.show && d.st === 'no_trip') nNoTrip++;
        if (!d.show) nOld++;
        var isTwice = d.show && d.st === 'filled' && !!d.twice;
        if (isTwice) nTwice++;
        var isDupF = dupG.length > 0;
        if (isDupF) nDupF++;
        if (d.show && (d.st === 'match' || d.st === 'filled') && !aiNote.length && !isTwice && !isDupF) nOk++;
        // 줄을 누르면 여는 운행 — 「모름」 운행에 금액을 넣으라고 하는 날은 그 운행(제안이 있는 운행 먼저), 아니면 예전대로
        var tgt = sgGo ? sgTrip(sgd) : d.target;
        var flag = isBad || (d.show && d.st === 'no_trip') || isTwice || isDupF;
        // 줄 끝 단추(2026-10-20 디자인 v2, P_Evid) — 영수증 없음 → 올리기(영수증 올리기 창) · 금액 다름 → 고치기(그 운행 고치기 창) ·
        //   운행 없는 날·두 번 정산 의심 → 「다른 운행에 붙이기」(예전엔 결과 칸 안 — 같은 단추를 줄 끝으로 옮김). 결재 중·완료 기간은 없다.
        var linkB = function (id) { return '<button type="button" class="btn sm mlinkb" data-evlink="' + esc(cat) + '" data-evlinkid="' + esc(String(id)) + '">다른 운행에 붙이기</button>'; };
        var act = !d.show || !canLink ? ''
          : d.st === 'no_receipt' ? '<button type="button" class="btn sm" data-evupcat="' + esc(cat) + '">' + ic('upload', 13) + '올리기</button>'
          : d.st === 'mismatch' && tgt ? '<button type="button" class="btn sm" data-edit="' + tgt.id + '">' + ic('edit', 13) + '고치기</button>'
          : d.st === 'no_trip' && d.ev.length ? linkB(d.ev[0].id)
          : d.st === 'filled' && d.twice && d.twice.ev.length ? linkB(d.twice.ev[0].id)
          : isDupF ? '<button type="button" class="btn sm" data-dupfill="' + esc(cat + '|' + d.day) + '">' + ic('check', 13) + '확인</button>' : '';
        return '<tr class="' + (flag ? 'flagged' : 'mok') + (tgt ? ' mclick' : '') + '"' +
          (tgt ? ' data-edit="' + tgt.id + '" title="눌러서 이 날 운행 고치기"' : '') + ' data-mday="' + esc(d.day) + '" data-mst="' + esc(d.st) + '">' +
          '<td style="white-space:nowrap">' + esc(dn(d.day)) + '</td>' +
          '<td class="mtrips">' + tripsTxt(d) + '</td>' +
          '<td class="n" data-l="운행 금액">' + (d.T ? won(d.T) : '<span class="dim">없음</span>') + '</td>' +
          '<td class="n" data-l="영수증">' + rcpt(d) +
            (aiNote.length ? '<div class="mai">' + esc(aiNote.join(', ')) + '</div>' : '') + '</td>' +
          '<td class="n" data-l="정산 금액"><b>' + won(d.settle) + '</b></td><td>' + res + '</td><td class="mact">' + act + '</td></tr>';
      }).join('');
      if (!MC.days.length) return box(true, cat === '주차' ? '주차비·주차 영수증이 없어요' : '통행료·통행료 영수증이 없어요', '', '') + xlHtml;
      // ── 한 줄 요약 + 「자세히 보기」(2026-10-15 2차 「영수증 한 번에 맞추기」) ──
      //   칸 많은 표는 접어 두고, 문제 있는 날(영수증 없음·금액 다름·운행 없는 영수증)만 펼쳐 보인다.
      var fold = MFOLD[cat] !== false, nFlag = nBad + nNoTrip + nTwice + nDupF;
      var fillTrips = Object.keys(MC.byTrip).filter(function (id) { return MC.byTrip[id].fill > 0; }).length;
      var parts = [];
      if (fillTrips) parts.push('영수증 금액을 넣은 운행 <em>' + n0(fillTrips) + '건</em>');
      if (nBad) parts.push('확인할 날 <em>' + n0(nBad) + '일</em>');
      if (MS.noTripShowN) parts.push('운행 없는 날 영수증 <em>' + n0(MS.noTripShowN) + '장</em>(정산에서 빠짐)');
      if (nTwice) parts.push('두 번 정산 의심 <em>' + n0(nTwice) + '일</em>');
      if (nDupF) parts.push('같은 금액 영수증 확인 <em>' + n0(nDupF) + '일</em>');
      if (!nBad && !MS.noTripShowN && !nTwice && !nDupF) parts.push(fillTrips ? '나머지는 모두 맞아요' : (isToll ? '통행료 증빙이 모두 맞아요' : '주차비 영수증이 모두 맞아요'));
      // 할 일 — 동사로(웹 8차)
      var how = [];
      if (MS.none) how.push(isToll ? '영수증이 없는 날은 영수증 사진이나 하이패스 이용내역 PDF를 올려 주세요. 실제로 안 냈으면 그 줄을 눌러 통행료를 ‘없음’으로 고쳐 주세요'
        : '영수증이 없는 날은 영수증 사진을 올려 주세요. 실제로 안 냈으면 그 줄을 눌러 주차비를 ‘없음’으로 고쳐 주세요');
      if (MS.diff) how.push('금액이 다른 날은 운행 금액과 증빙(하이패스 이용내역·영수증)이 달라요. 줄을 눌러 운행을 고치거나 내역에서 영수증을 고쳐 주세요. 고치기 전까지는 운행 금액으로 정산해요');
      // 금액 다름인 날 — 하루 단위 차이와 상황만(2026-10-19 버그 사냥 B2·B7·B8). 특정 운행 금액(「X원으로 고쳐」)은 제안하지 않는다 —
      //   그대로 따르면 두 번 정산될 수 있다. 문구는 money-rule.js adviceOf(서버 driving-verify R10 과 같은 글자).
      //   그날 「모름」 운행이 있으면(2026-10-21) toll-suggest.js unkTips — 영수증 지우기 권유 없이 「모름 운행에 금액을」(서버 R10 과 같은 글자) + 제안 금액.
      MC.days.filter(function (d) { return d.show && d.st === 'mismatch'; }).slice(0, 3).forEach(function (d) {
        var a = window.MoneyRule.adviceOf(d, cat);
        if (!a) return;
        var g = sgOf(d), tips = g ? window.TollSuggest.unkTips(a.tips, g.unk.map(function (t) { return hm(t.start_time); }), d.gap ? d.gap.diff : 0) : a.tips;
        var sug = g && g.diff > 0 ? g.items.filter(function (x) { return x.kind === 'amount'; }).map(function (x) { return hm(x.trip.start_time) + ' ' + won(x.amount); }) : [];
        how.push(dn(d.day) + ' ' + a.head + ': ' + tips.join(' / ') + (sug.length ? '. 제안: ' + sug.join(' · ') + '. ‘제안 보기·맞추기’에서 한 번에 넣을 수 있어요' : ''));
      });
      if (nNoTrip) how.push('운행 없는 날의 영수증은 정산에서 빠져요. 다른 날 운행의 영수증이면 그 줄의 ‘다른 운행에 붙이기’를 누르고, 그날 운행이 빠졌으면 1단계에서 운행을 넣고, 잘못 올렸으면 내역에서 지워 주세요');
      if (nTwice) how.push('두 번 정산 의심인 날은 영수증 금액이 전날 운행 금액과 같아요. 그대로 두면 전날 운행 금액과 이 영수증이 둘 다 정산돼요. 전날 운행 영수증을 다음 날 날짜로 올렸으면 그 줄의 ‘다른 운행에 붙이기’로 전날 운행에 연결해 주세요. ' +
        '그날 운행 영수증이 맞으면 줄을 눌러 그 운행의 ' + word + '를 적어 주세요. 그러면 이 표시가 없어져요');
      if (nDupF) how.push('운행에 ' + word + '를 적지 않아 영수증 금액이 들어갈 날인데 같은 금액 영수증이 여러 장이면, 그 줄의 ‘확인’에서 골라 주세요. ' +
        '실제로 여러 번 냈으면(왕복 등) 합계 적기, 같은 영수증을 두 번 올렸으면 한 번만 적기를 고르면 돼요. 겹친 영수증은 내역에서 지워 주세요');
      // 결재 중·결재 완료 기간 — 고칠 수 없으니 할 일 대신 한 줄(2026-10-19 마지막 검증)
      //   할 일은 상태에 맞게(lockHow — 결재 완료면 관리자에게 정정 문의, 결재 중이면 회수·반려 요청). 끝 마침표는 아래 join 이 붙인다
      if (myCycLocked() && how.length) how = [lockWhy(me) + ' 이 기간에는 영수증·운행을 고칠 수 없어요. ' + lockHow(me).replace(/\.$/, '')];
      var rule = '증빙이 있는 날은 ‘맞음’이에요. 정산에는 <b>운행 금액</b>이 들어가고, 영수증은 맞는지 확인만 해요. ' +
        '운행에 ' + word + '를 적지 않은 날은 <b>영수증 금액</b>이 그 운행에 들어가요.' +
        (isToll ? ' 하이패스 이용내역 PDF로 맞춘 통행료는 그 자체가 증빙이라, 같은 금액의 영수증 사진을 또 올려도 한 번만 계산해요.' : '') +
        ' 줄을 누르면 그 운행을 고칠 수 있어요.' +
        (nOld ? ' 10월분(09.21) 전 날은 확인하지 않아요. 금액은 똑같이 계산해요.' : '');
      // 한 줄 안내 + 「자세히 보기」(2026-10-20 디자인 v2 P_Evid) — 접혀 있으면 할 일 글(.mhow)은 숨기고 갈래별 수만 한 줄로 보인다.
      //   「자세히 보기 (N일)」로 펼치면 예전처럼 할 일 글 + 규칙 + 모든 날. 결재 중·완료 기간 한 줄(고칠 수 없음)은 늘 보인다.
      var line = [];
      if (MS.none) line.push('영수증 없음 ' + n0(MS.none) + '일');
      if (MS.diff) line.push('금액 다름 ' + n0(MS.diff) + '일');
      if (nAi) line.push('사진 금액과 다름 ' + n0(nAi) + '일');
      if (MS.noTripShowN) line.push('운행 없는 날 영수증 ' + n0(MS.noTripShowN) + '장');
      if (nTwice) line.push('두 번 정산 의심 ' + n0(nTwice) + '일');
      if (nDupF) line.push('같은 금액 영수증 ' + n0(nDupF) + '일');
      var hideHow = fold && line.length > 0 && !myCycLocked();
      var lineHtml = hideHow ? '<div class="mhl">' + line.join(' · ') + (canLink ? '. 줄마다 있는 버튼으로 바로 처리하세요. 설명은 ‘자세히 보기’에 있어요.' : '') + '</div>' : '';
      var foldBtn = '<button type="button" class="btn sm mfoldb" data-mfold="' + esc(cat) + '" aria-expanded="' + (fold ? 'false' : 'true') + '">' +
        (fold ? '자세히 보기 (' + n0(MC.days.length) + '일)' : '접기') + '</button>';
      var table = '<div class="scroll"' + (fold && !nFlag ? ' hidden' : '') + '><table class="mtable mday' + (fold ? ' fold' : '') + '"><thead><tr><th>날짜</th><th>운행 (시각 · 방문처)</th><th class="n">운행 금액</th>' +
        '<th class="n">영수증</th><th class="n">정산에 들어가는 금액</th><th>결과</th><th><span class="sr">할 일</span></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        // 접어 둔 표에서 맞는 날이 사라진 것처럼 보이지 않게(2026-10-17 모르는 로봇 — 「10.02 가 표에서 사라졌다」)
        (fold && nFlag && nOk ? '<div class="dim mfoldnote">맞는 날 ' + n0(nOk) + '일은 접어 두었어요. ‘자세히 보기’를 누르면 보여요.</div>' : '');
      return box(!nBad && !nNoTrip && !nTwice && !nDupF, parts.join(' · '),
        // 올린 영수증 합이 정산과 왜 다른지 한 마디(2026-10-17 모르는 로봇 「영수증 7,500원인데 정산 4,400원 — 잘못 들어간 줄」)
        '정산 ' + word + ' <b>' + won(MS.settle) + '</b> · 운행 금액 ' + won(MS.T) +
          // 하이패스 이용내역으로 맞춘 금액도 증빙으로 보이게(모르는 로봇 3회차 — 「올린 영수증 1,100원」만 보여 나머지가 증빙 없는 것처럼 읽혔다)
          (function () { var h = MC.days.reduce(function (x, d) { return x + (d.H || 0); }, 0); return h ? ' · 하이패스 ' + won(h) : ''; })() +
          ' · 올린 영수증 ' + won(MS.R) +
          (function () {
            var why = [];
            if (MS.fill) why.push(won(MS.fill) + '은 운행에 넣음');
            if (MS.noTrip) why.push('운행 없는 날 ' + won(MS.noTrip) + '은 빠짐');
            var dupAmt = MC.days.reduce(function (a, d) { return a + (d.D || 0); }, 0);
            if (dupAmt) why.push('하이패스와 같은 통행료 ' + won(dupAmt) + '은 한 번만 셈');
            return why.length ? ' (' + why.join(' · ') + ')' : '';
          })() + lineHtml +
          (how.length ? '<div class="mhow"' + (hideHow ? ' hidden' : '') + '>' + how.join('. ') + '.</div>' : '') +
          (fold ? '' : '<div class="mrule">' + rule + '</div>') +
          // 「자세히 보기」는 안내 글 아래 한 줄 — 문장 사이에 끼면 그 줄만 단추 높이로 벌어졌다(2026-10-24 다듬기 2단계)
          '<div class="mfoldrow">' + foldBtn + '</div>',
        table) + xlHtml;
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
      if (!claim && !paid) return box(true, '업무 운행 유류비가 없어요', '', '');
      return box(good, good ? '주유 영수증이 청구 유류비보다 많아서 정상이에요' : '청구 유류비가 주유 영수증보다 <em>' + won(claim - paid) + '</em> 많아요',
        good ? '업무 유류비는 실제로 넣은 기름값(영수증) 안에서 청구해요.' : '빠진 주유 영수증을 올리거나 운행 거리·목적을 확인해 주세요.', tbl);
    }
    if (cat === '계기판') {
      var plates = [];
      biz.forEach(function (t) { if (t.end_odometer != null) { var p = t.plate_no || ''; if (plates.indexOf(p) < 0) plates.push(p); } });
      if (!plates.length) return box(true, '이번 기간에 업무 운행이 없어요', '', '');
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
        if (!hit) { needRun++; return '<tr><td>' + esc(p || '차량 미지정') + '</td><td class="n">' + n0(lastEnd) + 'km</td><td class="n"><span class="dim">아직 안 읽음</span></td><td><span class="mres">검증할 때 읽어요</span></td></tr>'; }
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
        if (after) { anyBad++; res += ' ' + bad('사진을 찍은 뒤 운행이 ' + after + '건 있어요. 다시 찍어 주세요.'); }
        return '<tr' + (diff < -3 || after ? ' class="flagged"' : '') + '><td>' + esc(p || '차량 미지정') + '<div class="dim">' + esc(dn(dk)) + ' 사진</div></td>' +
          '<td class="n">' + (fin >= 0 ? n0(fin) + 'km' : '—') + '</td><td class="n"><b>' + n0(hit.v) + 'km</b></td><td>' + res + '</td></tr>';
      }).join('');
      var tblO = '<div class="scroll"><table class="mtable"><thead><tr><th>차량</th><th class="n">운행일지 최종 km</th><th class="n">계기판 사진 km</th><th>결과</th></tr></thead><tbody>' + rowsO + '</tbody></table></div>';
      return box(!anyBad && !needRun,
        anyBad ? '맞지 않는 차가 <em>' + n0(anyBad) + '건</em> 있어요' : needRun ? '사진 숫자를 아직 읽지 않았어요' : '계기판 사진이 운행일지 최종 km와 같거나 커서 정상이에요',
        '계기판 사진 숫자가 운행일지 마지막 km와 <b>같거나 커야</b> 해요. 사진을 찍고 조금 더 달린 것은 괜찮아요.' +
          (needRun ? ' 사진의 숫자는 3단계에서 검증하면 AI가 읽어 여기에도 보여요.' : ''),
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
    }).then(function (r) { if (!r.ok) toast('단계 위치를 저장하지 못했어요. 이 화면에서는 그대로 보여요.', true); })
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
    toast(dir > 0 ? (to + ' ' + STEP_NAMES[to - 1] + ' 단계로 넘어갔어요.') : (to + ' ' + STEP_NAMES[to - 1] + ' 단계로 돌아왔어요. 고친 뒤 ‘다음 단계’를 다시 눌러 주세요.'));
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
          // 「지금 할 일 · 6건」이 할 일 6개로 읽혔다(2026-10-19 로봇) — 「운행 6건」
          : fix ? '확인 ' + n0(fix) + '건 · 운행 ' + n0(my.length) + '건' : '운행 ' + n0(my.length) + '건 · ' + km(kmSum) + ' km' },
      { v: 'evid', t: '영수증·통행료', n: unk,
        sub: (ev.length ? '영수증 ' + n0(ev.length) + '장' : '영수증 없음') + (unk ? ' · 통행료 미확정 ' + n0(unk) : '') },
      { v: 'verify', t: '검증·상신', n: 0,
        sub: st === 'approved' ? '결재 완료' : st === 'submitted' ? '상신함' : st === 'rejected' ? '반려됨 · 다시 상신' : '아직 안 함' },
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
    // 메뉴 옆 숫자가 무엇을 세는지 — 마우스를 올리면 보이고(title) 화면 읽기에도 읽힌다(2026-10-16 5차: 「2 영수증·통행료」 옆 회색 「1」이 무엇인지 몰랐다).
    // 상신한 기간(결재 중·완료)은 고칠 수 없다 — 고칠 것을 세는 숫자(확인할 것·사진 없는 영수증·통행료 미확정)는 내지 않는다
    //   (2026-10-16 6차 통행료 미확정 → 2026-10-17 7차 사용자 「숨기자」: 나머지도 같게). 반려·회수된 기간은 고칠 수 있으니 그대로 보인다.
    //   결재함·안전교육 숫자는 기간 잠금과 상관없어 그대로.
    set('pCheck', S.sent ? 0 : S.fix, S.fixBad > 0, function (n) { return '운행 기록에서 확인할 것 ' + n0(n) + '건' + (S.fixBad ? '(고칠 것 ' + n0(S.fixBad) + '건)' : ''); });
    set('pEvid', S.sent ? 0 : S.noPhoto, false, function (n) { return '사진 없는 영수증 ' + n0(n) + '장'; });
    set('pToll', S.sent ? 0 : S.unk, false, function (n) { return '통행료 미확정 업무 운행 ' + n0(n) + '건. ‘영수증·통행료’ 단계의 통행료에서 운행을 눌러 정해 주세요.'; });
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
    set('pEdu', eduTodo(), eduTodo() > 0, function (n) { return '이번 회차에 볼 안전교육 영상 ' + n0(n) + '편'; });
    paintInboxPill();
    paintBell();
    function set(id, v, hot, what) {
      var el = $(id); if (!el) return;
      el.hidden = !v;
      el.textContent = v > 999 ? '999+' : n0(v);
      el.className = 'pill' + (hot ? ' hot' : '');
      if (what) pillSay(el, v ? what(v) : '');
    }
  }
  /** 메뉴 숫자 딱지의 뜻 — title(마우스) + 화면 읽기용 숨은 글(딱지 숫자 자체는 읽지 않는다). 딱지 글자(숫자)는 그대로 둔다. */
  function pillSay(el, say) {
    el.title = say || '';
    el.setAttribute('aria-hidden', 'true');
    var sr = document.getElementById(el.id + 'Sr');
    if (!sr && el.parentNode) { sr = document.createElement('span'); sr.className = 'sr'; sr.id = el.id + 'Sr'; el.parentNode.insertBefore(sr, el.nextSibling); }
    if (sr) sr.textContent = say ? ' (' + say + ')' : '';
  }
  function evidOfCycle() {
    var r = viewRange();
    return EVID.filter(function (e) { var d = Number(e.date_millis); return d >= r.lo && d < r.hi; });
  }
  /* ── 안전교육 회차·의무 — 앱 edu/EduModels.kt(EduMonth)·EduLogic.kt 를 그대로 옮긴 것(2026-10-14) ──
     회차 키 "YYYY-MM" = 시청 기간이 **시작하는 달**. 21일에 열리고 다음 달 20일이 마감(KST).
     예: 회차 2026-09 = 평가 8/21~9/20 내역 → 시청 9/21~10/20.
     ★ 보고 있는 정산 기간(CYC)이 아니라 **지금 시각**으로 정한다 — 앱과 같다. 예전 웹은 CYC 에서 한 달을 빼서
       지난 기간을 보고 있으면 지난 회차가 '이번 회차' 로 나왔다.
     한쪽을 고치면 앱(Kotlin·Swift)도 같이 고친다 — 같은 사람의 의무·진도가 앱과 웹에서 다르면 안 된다. */
  var EDU_START_DAY = 21;          // 앱 EduMonth.CYCLE_START_DAY
  var EDU_THRESHOLD = 80;          // 앱 EDU_TARGET_THRESHOLD — 직전 평가기간 평균이 이보다 낮으면 의무 대상
  function eduKeyAt(ms) {
    var d = kd(ms), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    if (d.getUTCDate() < EDU_START_DAY) { m--; if (m < 1) { m = 12; y--; } }
    return y + '-' + pad(m);
  }
  function eduNowKey() { return eduKeyAt(Date.now()); }
  function eduYm(month) { var p = String(month || '').split('-'); return { y: +p[0], m: +p[1] }; }
  /** 이번 회차의 평가 [시작, 끝) = 전달 21일 00:00 ~ 회차달 21일 00:00 (KST). 앱 EduMonth.prevRange. */
  function eduPrevRange(nowMs) {
    var c = eduYm(eduKeyAt(nowMs));
    return { lo: Date.UTC(c.y, c.m - 2, EDU_START_DAY) - KST, hi: Date.UTC(c.y, c.m - 1, EDU_START_DAY) - KST };
  }
  /** 마감 라벨 = 다음 달 20일(예: 회차 2026-08 → "9/20"). */
  function eduDeadlineLabel(month) { var c = eduYm(month); return (c.m % 12 + 1) + '/' + (EDU_START_DAY - 1); }
  /** 공개일 라벨(예: 회차 2026-09 → "9/21"). */
  function eduOpenLabel(month) { return eduYm(month).m + '/' + EDU_START_DAY; }
  /** 공개된 회차인가 — 회차 키는 글자 순서가 시간 순서와 같다. */
  function eduIsOpen(month, nowMs) { return String(month) <= eduKeyAt(nowMs == null ? Date.now() : nowMs); }
  /** 마감 카운트다운: "D-3" / "D-DAY" / 지나면 "지연 5일". */
  function eduDday(month, nowMs) {
    var c = eduYm(month), t = kd(nowMs == null ? Date.now() : nowMs);
    var dl = Date.UTC(c.y, c.m, EDU_START_DAY - 1), today = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    var d = Math.round((dl - today) / 864e5);
    return d > 0 ? 'D-' + d : d === 0 ? 'D-DAY' : '지연 ' + (-d) + '일';
  }
  /** 그 사람의 영상별 진도(%) — video_id → progress_pct. */
  function eduPctOf(user) {
    var m = {};
    EDUP.forEach(function (p) { if (p.username === user) m[p.video_id] = Number(p.progress_pct) || 0; });
    return m;
  }
  /** 그 사람이 의무 대상으로 지정된 회차들(month → true). */
  function eduTargetMonths(user) {
    var m = {};
    EDUT.forEach(function (t) { if (t.username === user) m[t.month] = true; });
    return m;
  }
  /** 의무 영상 = 대상으로 지정된 모든 회차의 영상 중 진도 100 미만(이월은 이 정의로 저절로 된다).
   *  삭제 영상 제외. 회차 오름차순 → id 오름차순(오래된 의무 먼저). 앱 EduLogic.obligations. */
  function eduObligations(months, pct) {
    return EDUV.filter(function (v) { return !v.deleted && months[v.month] && (pct[v.id] || 0) < 100; })
      .sort(function (a, b) { return a.month < b.month ? -1 : a.month > b.month ? 1 : (Number(a.id) - Number(b.id)); });
  }
  /** 그 회차 수료 — 그 회차 영상 전부 100%. 영상 0개면 true(의무 없음). 앱 EduLogic.monthCompleted. */
  function eduMonthDone(month, pct) {
    return EDUV.filter(function (v) { return !v.deleted && v.month === month; })
      .every(function (v) { return (pct[v.id] || 0) >= 100; });
  }
  function myName() { return (ME && (ME.username || ME.app_username)) || ''; }
  /** 「본인 비밀번호」 칸 바로 앞에 두는 숨은 아이디 칸(2026-10-16 4차).
   *  이것이 없으면 크롬 비밀번호 관리자가 창 안의 다른 글 칸(직원에게 줄 새 비밀번호·본부 등)을 아이디로 알고,
   *  창이 닫힌 뒤 화면을 옮기면 「로그인 성공」으로 보고 비밀번호 저장·유출 경고 창을 띄웠다. 그 창이 떠 있는 동안
   *  화면의 단추가 모두 반응하지 않았다(검증로봇: 비밀번호 초기화 → 조직도). 아이디를 알려 주면 이미 로그인한 계정으로 본다. */
  function mineUserField() {
    return '<input type="text" name="username" autocomplete="username" value="' + esc(myName()) + '" hidden readonly tabindex="-1" aria-hidden="true">';
  }
  /** 메뉴 숫자 = 앱 홈 배너의 의무 건수(이월 포함). 의무 대상이 아니면 0. */
  function eduTodo() {
    if (!ME) return 0;
    var me = myName();
    return eduObligations(eduTargetMonths(me), eduPctOf(me)).length;
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

  var SAFE_ALL = false;          // 안전운전 「전체 보기」(2026-10-19)
  function viewSafety() {
    if (!LOADED) return head(scopeTitle('안전운전')) + skeleton();
    var h = head(scopeTitle('안전운전'),
      esc(viewName()) + ' · ' + esc(viewSpan()));

    if (!isAll()) {
      var s = safeOf(TRIPS);
      if (s.score < 0) {
        // blank() 는 설명을 esc() 하므로 태그를 넣으면 '<b>' 가 글자로 보인다 — 평문으로 쓴다.
        return h + blank('평가할 운행이 없어요.',
          '안전운전 점수는 앱이 자동으로 기록한 운행만 평가해요. ' +
          '수기로 넣은 운행은 GPS 기록이 없어 평가하지 않아요.', 'gauge');
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
      // 「점수가 낮은 운행」인데 100점까지 다 나왔다 — 90점 미만만, 「전체 보기」로 모두(2026-10-19 웹 사용성 1차)
      var sorted = s.rows.slice().sort(function (a, b) { return safeScore(a) - safeScore(b); });
      var low = sorted.filter(function (t) { return safeScore(t) < 90; });
      var list = SAFE_ALL ? sorted : low.slice(0, 20);
      var allBtn = sorted.length > list.length || SAFE_ALL
        ? '<button class="btn sm" data-safeall="' + (SAFE_ALL ? 0 : 1) + '">' + (SAFE_ALL ? '90점 미만만 보기' : '전체 보기 (' + n0(sorted.length) + '건)') + '</button>' : '';
      h += sect(SAFE_ALL ? '평가한 운행 전체' : '점수가 낮은 운행', SAFE_ALL ? n0(sorted.length) + '건 · 낮은 순' : '90점 미만 ' + n0(low.length) + '건', allBtn,
        list.length ? safeTripTable(list)
          : '<div class="panel" style="padding:16px 20px;color:var(--ink-600)">90점 미만인 운행이 없어요.</div>');
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
        '위험 운전이 한 번도 없었어요.</div>';
    }
    return '<div class="panel"><table class="kv"><tbody>' +
      items.map(function (x) {
        return '<tr><th>' + esc(x[0]) + '</th><td><b>' + n0(x[1]) + '회</b>' +
          '<span class="dim"> · 1회당 −' + x[2] + '점</span></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function safeTripTable(rows) {
    if (!rows.length) return blank('평가한 운행이 없어요.', null, 'list');
    return '<div class="panel"><div class="scroll" data-rows><table class="mc"><thead><tr>' +
      '<th>날짜</th><th class="n">점수</th><th>구간</th><th>방문처</th><th class="n">과속</th>' +
      '<th class="n">급가감속</th><th class="n">최고</th></tr></thead><tbody>' +
      rows.map(function (t) {
        var sc = safeScore(t), g = safeGrade(sc);
        // 운행일지 표와 같은 규칙 — 방문처가 비면 도착지로 대신한다.
        var place = t.visit_place || t.end_address || '';
        return '<tr class="clk" tabindex="0" data-trip="' + esc(t.id) + '">' +
          '<td class="m1"><span class="lead">' + md(t.start_time) + '</span> <span class="dim">' +
          hm(t.start_time) + (isNightTrip(t.start_time) ? ' 야간' : '') + '</span></td>' +
          '<td class="n total mr">' + n0(sc) + ' <span class="st ' + g[2] + '">' + g[1] + '</span></td>' +
          '<td class="dim m2">' + esc(dong(t.start_address)) + ' → ' + esc(dong(t.end_address)) + '</td>' +
          '<td class="el mx" title="' + esc(place) + '">' + esc(place) + '</td>' +
          '<td class="n" data-l="과속">' + (Number(t.overspeed_count) || 0) + '</td>' +
          '<td class="n" data-l="급가감속">' + ((Number(t.rapid_accel_count) || 0) + (Number(t.rapid_decel_count) || 0)) + '</td>' +
          '<td class="n dim" data-l="최고" data-u="km/h">' + n0(t.max_speed_kmh) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function safeRuleNote() {
    return '<section class="sect"><div class="panel" style="padding:18px 20px;font-size:13px;' +
      'line-height:1.7;color:var(--ink-3)">' +
      '<b style="color:var(--ink-2)">100점에서 깎아요.</b> ' +
      '과속 −3 · 어린이보호구역 과속 −5 · 급가속 −3 · 급감속 −5 · 급회전 −3 · ' +
      '지속과속 −2(운행당 −10까지)<br>' +
      '밤 10시~새벽 6시에 출발한 운행은 깎인 점수를 <b>1.5배</b>로 계산해요.<br>' +
      '여러 운행의 평균은 <b>주행거리로 가중</b>해서, 짧은 운행이 너무 크게 반영되지 않아요.<br>' +
      '<b style="color:var(--ink-2)">수기로 넣은 운행은 평가하지 않아요.</b> GPS 기록이 없으면 ' +
      '위반이 0으로 잡혀 점수가 부풀려져요.<br>' +
      '앱의 안전운전 점수와 같은 식으로 계산해요. 앱과 다르게 나오면 알려 주세요.' +
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
      ? n0(rows.length) + '건이 비어 있어요'
      : '비어 있는 통행료가 없어요');

    // ★ 결재가 끝난 주기는 서버가 통행료도 막는다. 채우게 두면 전부 채운 뒤
    //   저장에서야 '결재가 끝난 기간' 으로 다 튕긴다 — 먼저 말한다.
    if (rows.length && cycleLocked(mine)) {
      return h + lockedNote(lockTitle(mine),
        '비어 있는 ' + n0(rows.length) + '건은 정산에 0원으로 들어갔어요. ' + lockHow(mine));
    }

    if (!rows.length) {
      return h + blank('채울 통행료가 없어요.',
        '자동 계산과 하이패스 비교로 모두 정해졌어요.', 'check');
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

    h += '<section class="sect"><div class="panel" style="padding:16px 20px;font-size:13px;' +
      'line-height:1.7;color:var(--ink-3)">' +
      '같은 구간끼리 묶었어요. <b style="color:var(--ink-2)">시내 운행처럼 요금소를 지나지 않은 구간은 ' +
      '‘없음’</b>을 누르면 그 구간 전체가 한 번에 정리돼요.<br>' +
      '전에 정한 금액은 ‘지난번 N원’ 버튼을 누르면 그대로 들어가요.<br>' +
      '잘못 눌렀으면 칸을 비우세요. 비운 줄은 아직 안 정한 상태로 돌아가요.<br>' +
      '<b style="color:var(--ink-2)">업무용 운행만</b> 보여요. 출퇴근·비업무용은 정산과 제출 서류에 ' +
      '들어가지 않아 채우지 않아도 돼요.' +
      '<div style="margin-top:12px">한국도로공사 <b style="color:var(--ink-2)">하이패스 이용내역 PDF</b>가 ' +
      '있으면 한 번에 확정돼요. ' +
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
            'title="전에 정한 금액을 그대로 넣어요">지난번 ' +
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

  /** 묶음의 금액칸을 읽어 FILLS 에 반영한다(입력 도중에도 호출된다). 못 읽는 글이 든 칸 목록을 돌려준다. */
  function tfRead() {
    var bad = [];
    Array.prototype.forEach.call(document.querySelectorAll('[data-tfamt]'), function (el) {
      var i = +el.dataset.tfamt, k = TF_GROUPS[i] && TF_GROUPS[i].key;
      if (!k) return;
      var v = numIn(el.value);
      // 0원도 칸에 '0' 으로 적히므로, 빈 칸은 이제 '아직 안 정함' 이 맞다.
      // (예전에는 0을 빈 칸으로 그려서, 지우면 0이 되살아나 되돌릴 수가 없었다.)
      // 숫자·쉼표 밖의 글자가 든 칸은 정하지 않은 것으로 두고 저장 때 막는다(2026-10-20 AU2 #9 — 예전엔 글자를 지운 숫자로 정했다).
      if (v === null || isNaN(v)) { delete FILLS[k]; if (v !== null) bad.push(el); return; }
      FILLS[k] = v;
    });
    return bad;
  }

  /** 남은 것을 전부 0원으로 확정하기 전에 무슨 뜻인지 보여 준다.
   *  자동계산은 이미 '요금소 미통과' 가 확실한 건을 0원으로 확정해 둔다.
   *  여기 남은 것은 자동으로 못 정한 것이라, 무턱대고 0원을 찍으면 실제로
   *  지난 통행료만큼 회사가 덜 지급한다. */
  function openAllFree() {
    var tfBad = tfRead();
    if (tfBad.length) { numStop(tfBad[0], '통행료 금액'); return; }     // 못 읽는 글을 친 칸을 「없음」으로 덮지 않게 먼저 고치게 한다
    var left = 0, groups = 0;
    TF_GROUPS.forEach(function (x) {
      if (FILLS[x.key] != null) return;
      left += x.rows.length; groups++;
    });
    if (!left) { toast('남은 것이 없어요.'); return; }
    $('pTitle').textContent = '남은 것 전부 「없음」';
    $('pSub').textContent = n0(groups) + '개 구간 · ' + n0(left) + '건';
    $('pBody').innerHTML =
      '<div class="anote">남은 <b>' + n0(left) + '건</b>을 <b>통행료 없음(0원)</b>으로 확정할까요?</div>' +
      '<div class="form"><div class="frow"><div class="fbody">' +
      '<div class="fhint">자동 계산으로 정하지 못한 운행이라, 요금소를 지난 운행이 ' +
      '섞여 있으면 <b>그 통행료만큼 덜 받아요</b>.<br>' +
      '요금소를 지난 운행이 있으면 취소하고 그 구간만 금액을 넣어 주세요.</div>' +
      '</div></div></div>';
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnAllFreeGo">' + n0(left) + '건 없음으로 표시</button>';
    $('panel').classList.add('open');
  }

  function tfSave() {
    var tfBad = tfRead();
    if (tfBad.length) { numStop(tfBad[0], '통행료 금액'); return; }
    var items = [], n = 0;
    TF_GROUPS.forEach(function (x) {
      var v = FILLS[x.key];
      if (v == null) return;
      x.rows.forEach(function (t) { items.push({ id: t.id, amount: v }); n++; });
    });
    if (!items.length) { toast('정한 것이 없어요.', true); return; }
    if (items.length > 500) { toast('한 번에 500건까지 저장할 수 있어요. 나눠서 저장해 주세요.', true); return; }
    var btn = $('tfSave'); btn.disabled = true; btn.textContent = '저장 중…';
    apiRetry('/functions/v1/toll-apply', {
      method: 'POST',
      body: JSON.stringify({ mode: 'manual', batch: '웹 통행료 채우기 ' + CYCKEY(), items: items })
    }).then(function (r) { return r.json().then(function (x) { return { ok: r.ok, j: x }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = n0(n) + '건 저장';
        if (!res.ok || !res.j || !res.j.ok) {
          toast((res.j && res.j.error) || '저장하지 못했어요.', true); return;
        }
        var skipped = res.j.skipped || [];
        // ★ applied 가 0 이면 한 건도 안 써진 것이다. 예전에는 '0 || items.length' 라
        //   47건 저장했다고 띄우고 FILLS 까지 비워, 거짓말에 더해 친 값도 날렸다.
        var applied = Number(res.j.applied) || 0;
        if (!applied) {
          toast(skipped.length
            ? '한 건도 저장하지 못했어요. 이유: ' + endDot(skipped[0].why)
            : '한 건도 저장하지 못했어요.', true);
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
        // 다 저장됐으면 영수증 › 통행료 차례로 돌아간다(2026-10-14 사용자 — 「채운 다음은 통행료 칸에 반영된 화면으로」).
        if (!skipped.length && !isMulti()) { tollBack(n0(applied) + '건을 저장해 통행료에 반영했어요.'); return; }
        toastOk(n0(applied) + '건 저장했어요.',
          skipped.length ? skipped.length + '건은 건너뛰었어요. 이유: ' + endDot(skipped[0].why) : null);
      }).catch(function () {
        btn.disabled = false; btn.textContent = n0(n) + '건 저장';
        toast('저장하지 못했어요.', true);
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
      // 관리자에게만(2026-10-19 — 직원에게 「아니오」 줄은 뜻이 없었다)
      (ME.is_admin ? kv('운행일지 관리자', '예') : '') +
      // 2026-10-07 — 업무용 차량을 운전하는가(운행일지 씀/안 씀). 바꾸는 것은 관리자가 「권한 관리」에서 한다.
      kv('차량 운전', (usesDriving(myName())
        ? '<b>운전해요.</b> <span class="dim">운행일지와 개인경비를 모두 써요.</span>'
        : '<b>운전하지 않아요.</b> <span class="dim">개인경비 지출결의와 결재만 써요.</span>') +
        '<div class="fhint">바뀌면 관리자에게 알려 주세요. 바꿔 드려요.</div>') +
      '</tbody></table></div>');

    h += sect('결재 서명', null, '', signPanel());

    h += sect('비밀번호 바꾸기', null, '',
      // 창 안의 폼과 달리 칸(panel) 맨 위라 위 구분선이 빈 줄처럼 보였다(2026-10-19) — 뺀다
      '<div class="panel" style="padding:8px 20px 20px"><div class="form" style="border-top:0;margin-top:0">' +
      frow('현재 비밀번호', mineUserField() + '<input class="inp pw" type="password" id="pwCur" autocomplete="current-password">') +
      frow('새 비밀번호', '<input class="inp pw" type="password" id="pwNew" autocomplete="new-password">',
        '4자 이상 입력해 주세요. <b>앱과 웹은 같은 비밀번호</b>를 써서, 바꾸면 앱에서도 새 비밀번호로 로그인해야 해요.') +
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
    var cur = MYSIGN && MYSIGN.image && signUrlOk(MYSIGN.image) ? MYSIGN.image : stampPng(nm);
    var shown = SIGN_DRAFT || cur;
    return '<div class="panel" style="padding:20px"><div class="signrow">' +
      '<div class="signbox"><img id="signPreview" alt="결재 서명" src="' + esc(shown) + '"></div>' +
      '<div class="signtx">' +
      (SIGN_DRAFT
        ? '<b>이 서명으로 저장할까요?</b><div class="fhint">흰 배경은 투명하게 바꾸고 여백은 잘라 냈어요.</div>' +
          '<div class="signbtn"><button class="btn pri" id="btnSignSave">이 서명으로 저장</button> ' +
          '<button class="btn" id="btnSignCancel">취소</button></div>'
        : '<b>' + (MYSIGN && MYSIGN.image ? '올린 서명을 쓰고 있어요' : '기본 도장(이름)을 쓰고 있어요') + '</b>' +
          '<div class="fhint">상신·승인하면 결재란에 이 그림과 날짜가 찍혀요. 서명·도장 파일(JPG, PNG, PDF)을 올려 바꿔도 ' +
          '<b>이미 결재된 문서는 그대로</b>예요.</div>' +
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
          im.onerror = function () { URL.revokeObjectURL(url); no(new Error('그림 파일을 읽지 못했어요.')); };
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
      if (x1 < 0) throw new Error('파일에서 서명을 찾지 못했어요. 흰 바탕만 있는 파일이에요.');
      g.putImageData(img, 0, 0);
      var pad = 4, cw = x1 - x0 + 1 + pad * 2, ch = y1 - y0 + 1 + pad * 2;
      var k = Math.min(1, 360 / cw, 180 / ch);
      var out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(cw * k)); out.height = Math.max(1, Math.round(ch * k));
      out.getContext('2d').drawImage(cv, x0 - pad, y0 - pad, cw, ch, 0, 0, out.width, out.height);
      var png = out.toDataURL('image/png');
      if (png.length > 390000) throw new Error('서명 그림이 너무 복잡해요. 서명만 잘라서 올려 주세요.');
      return png;
    });
  }
  function saveSign(image) {
    var b = $('btnSignSave') || $('btnSignReset'); if (b) b.disabled = true;
    return apiRetry('/rest/v1/driving_signatures', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ username: myName(), image: image })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (rows) {
      if (!rows || !rows[0]) { if (b) b.disabled = false; toast('서명을 저장하지 못했어요. 잠시 후 다시 해 주세요.', true); return; }
      MYSIGN = rows[0]; SIGNS[MYSIGN.id] = MYSIGN.image || ''; SIGN_DRAFT = null;
      toast(image ? '서명을 저장했어요. 이후 상신·승인하는 문서에 쓰여요.' : '기본 도장으로 되돌렸어요.');
      render();
    }).catch(function () { if (b) b.disabled = false; toast('서명을 저장하지 못했어요.', true); });
  }

  function savePassword() {
    var cur = ($('pwCur') || {}).value || '';
    var a = ($('pwNew') || {}).value || '', b2 = ($('pwNew2') || {}).value || '';
    if (!cur) { toast('현재 비밀번호를 넣어 주세요.', true); return; }
    if (a.length < 4) { toast('새 비밀번호는 4자 이상 입력해 주세요.', true); return; }
    if (a !== b2) { toast('새 비밀번호 확인이 달라요.', true); return; }
    if (a === cur) { toast('지금 쓰는 것과 다른 비밀번호를 넣어 주세요.', true); return; }
    var btn = $('btnPwSave'); btn.disabled = true; btn.textContent = '바꾸는 중…';
    apiRetry('/functions/v1/driving-account', {
      method: 'POST', body: JSON.stringify({ action: 'change_password', current: cur, next: a })
    }).then(function (r) { return r.json().then(function (x) { return { ok: r.ok, j: x }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = '비밀번호 바꾸기';
        if (!res.ok || !res.j || !res.j.ok) {
          toast((res.j && res.j.error) || '바꾸지 못했어요.', true); return;
        }
        ['pwCur', 'pwNew', 'pwNew2'].forEach(function (id) { if ($(id)) $(id).value = ''; });
        toast(res.j.message || '비밀번호를 바꿨어요.');
      }).catch(function () {
        btn.disabled = false; btn.textContent = '비밀번호 바꾸기';
        toast('바꾸지 못했어요.', true);
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
      '<div class="panel"><div class="scroll" data-rows><table class="rcard"><thead><tr>' +
      '<th>이름</th><th>아이디</th><th>부서 · 직급</th><th>회사 메일</th><th>업무용 차량</th><th>신청</th><th></th></tr></thead><tbody>' +
      SIGNUPS.map(function (x) {
        var busy = SIGNUP_BUSY === x.username;
        return '<tr><td><span class="lead">' + esc(x.name || '') + '</span></td>' +
          '<td class="mono">' + esc(x.username) + '</td>' +
          '<td class="dim">' + esc([x.dept, x.position].filter(Boolean).join(' · ') || '—') + '</td>' +
          '<td class="dim">' + esc(x.email || '—') + '</td>' +
          '<td class="dim">' + (x.uses_driving === false ? '운전 안 함(개인경비·결재만)' : '운전함') + '</td>' +
          '<td class="dim">' + (x.signup_at ? md(Date.parse(x.signup_at)) : '—') + '</td>' +
          '<td class="n ract" style="white-space:nowrap">' +
          '<button class="btn sm pri" data-signup="' + esc(x.username) + '" data-ok="1"' + (busy ? ' disabled' : '') + '>승인</button> ' +
          '<button class="btn sm" data-signup="' + esc(x.username) + '" data-ok="0"' + (busy ? ' disabled' : '') + '>거절</button></td></tr>';
      }).join('') + '</tbody></table></div></div>' +
      '<div class="anote">업무 결재 포털에서 들어온 신청으로, 승인하면 그 아이디로 포털, 운행일지 웹, 앱에 로그인할 수 있어요. ' +
      '적힌 회사 메일은 <b>본인 확인 전</b>이에요. 승인할 때 <b>조직도의 누구인지</b> 고르면 바로 결재자로 고를 수 있어요.</div>');
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
    // 창 맨 위 구분선은 머리 줄 밑줄과 겹쳐 빈 줄처럼 보였다(내 계정과 같게 뺀다, 2026-10-19)
    $('pBody').innerHTML = '<div class="form" style="border-top:0;margin-top:0"><div class="anote">' + esc(x.name || u) + ' 님의 가입 신청을 <b>' +
      (ok ? '승인' : '거절') + '</b>할까요?' +
      (ok ? ' 승인하면 이 아이디로 포털, 운행일지 웹, 앱에 로그인할 수 있어요.' +
          (x.uses_driving === false ? ' <b>업무용 차량을 운전하지 않는 분</b>이라 개인경비·결재함만 보여요.' : '')
        : ' 거절하면 이 아이디로는 로그인할 수 없고, 적어 낸 차량번호는 비워요.') + '</div>' +
      // ★ 결재자로 고를 수 있게 하려면 조직도에 이어야 한다(결재자 = 조직도에 있고 계정이 이어진 사람, 2026-10-02 결정).
      //   관리자가 본인 확인 뒤 직접 고른다 — 이름만 같다고 자동으로 잇지 않는다(가로채기 방지, 10/6 검증로봇).
      (ok ? '<div class="frow"><label class="flab" for="suOrg">조직도</label><div class="fbody">' +
        '<select class="inp" id="suOrg">' + oo.html + '</select>' +
        '<div class="fhint">조직도에 연결하면 <b>결재자로 고를 수 있어요</b>. 본인이 맞는지 확인하고 고르세요.</div>' +
        '<div id="suOrgNew" class="form" style="margin-top:10px" hidden>' +
        '<div class="frow"><label class="flab" for="suDiv">본부</label><div class="fbody"><input class="inp" id="suDiv" maxlength="60" placeholder="예) 버스사업본부"></div></div>' +
        '<div class="frow"><label class="flab" for="suTeam">팀</label><div class="fbody"><input class="inp" id="suTeam" maxlength="60" value="' + esc(x.dept || '') + '"></div></div>' +
        '<div class="frow"><label class="flab" for="suRole">직책</label><div class="fbody"><input class="inp" id="suRole" maxlength="30" placeholder="예) 팀장 · 센터장 (결재란에 찍힘)"></div></div>' +
        '<div class="frow"><label class="flab" for="suRank">직급</label><div class="fbody"><input class="inp" id="suRank" maxlength="30" value="' + esc(x.position || '') + '"></div></div>' +
        // 팀즈 결재 알림이 이 주소로 간다 — 신청서의 메일은 본인 확인이 안 된 값이라 관리자가 보고 확정한다(R9).
        '<div class="frow"><label class="flab" for="suOMail">알림 메일</label><div class="fbody"><input class="inp" id="suOMail" maxlength="80" value="' + esc(x.email || '') + '" placeholder="아이디@atecmobility.com">' +
        '<div class="fhint">팀즈 결재 알림이 이 주소로 가요. <b>본인 회사 메일이 맞는지</b> 확인하고, 모르면 비워 두세요.</div></div></div>' +
        '</div></div></div>' : '') +
      '<div class="frow"><label class="flab" for="suMine">본인 비밀번호</label><div class="fbody">' +
      mineUserField() + '<input class="inp" type="password" id="suMine" autocomplete="current-password">' +
      '<div class="fhint">지금 로그인한 <b>' + esc(myName()) + '</b> 계정의 비밀번호를 입력해 주세요.</div></div></div></div>';
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
      if (newOrg.email && !/^[a-z0-9._-]+@atecmobility\.com$/.test(newOrg.email)) { toast('알림 메일은 @atecmobility.com 주소만 쓸 수 있어요. 모르면 비워 두세요.', true); $('suOMail').focus(); return; }
      if (!newOrg.division) { toast('조직도에 새로 넣으려면 본부를 넣어 주세요.', true); $('suDiv').focus(); return; }
    }
    var go = $('btnSignupGo'); if (go) go.disabled = true;
    SIGNUP_BUSY = u;
    apiRetry('/functions/v1/driving-account', { method: 'POST', body: JSON.stringify({ action: 'decide_signup', target: u, ok: ok, password: mine }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        SIGNUP_BUSY = '';
        if (go) go.disabled = false;
        if (!res.ok || !res.j || !res.j.ok) { toast((res.j && res.j.error) || '처리하지 못했어요.', true); return; }
        var done = endDot(res.j.message || '처리했어요.');
        closePanel();
        SIGNUPS = null;
        if (!ok) { toast(done); render(); return; }
        return linkSignupOrg(u, x, orgPick, newOrg).then(function (msg) {
          if (msg) toast(done + ' ' + msg, /못했/.test(msg)); else toast(done);
          loadAll();                     // 승인한 사람이 직원 목록·조직도·결재자 후보에 바로 보이게
        });
      }).catch(function () { SIGNUP_BUSY = ''; if (go) go.disabled = false; toast('처리하지 못했어요.', true); });
  }
  /** 승인한 계정을 조직도에 잇는다 — 이미 계정이 이어진 줄은 건드리지 않는다(username=is.null 조건). */
  function linkSignupOrg(u, x, pick, newOrg) {
    if (!pick) return Promise.resolve('');
    // 이미 조직도 어딘가에 이어진 계정이면 또 잇지 않는다(한 사람이 두 줄 — R9).
    if (ORG.some(function (o) { return o.username === u; })) return Promise.resolve('이 계정은 이미 조직도에 연결돼 있어 그대로 두었어요.');
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
        return rows && rows.length ? '조직도에 연결했어요. 이제 결재자로 고를 수 있어요.'
          : pick === 'new'
            ? '조직도에 새로 넣지 못했어요. ‘조직도’에서 직접 추가해 주세요.'
            : '조직도에 연결하지 못했어요. 이미 다른 계정이 연결됐을 수 있으니 ‘조직도’에서 직접 연결해 주세요.';
      }).catch(function () { return '조직도에 연결하지 못했어요. ‘조직도’에서 직접 연결해 주세요.'; });
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
    h += '<section class="sect"><div class="panel" style="padding:16px 20px;font-size:13px;' +
      'line-height:1.7;color:var(--ink-3)">' +
      '<b style="color:var(--ink-2)">운행일지 관리자</b>는 전 직원의 운행, 정산, 증빙을 보고 ' +
      '계기판을 고칠 수 있어요.<br>' +
      '자리를 비운 사이 다른 사람이 권한을 주지 못하도록, 바꿀 때마다 <b>본인 비밀번호</b>를 ' +
      '한 번 더 확인해요.<br>' +
      '<b style="color:var(--ink-2)">권한 주는 관리자</b>는 마스터 계정이 지정해요. 이 화면에서 다른 직원을 관리자로 ' +
      '지정·해제하고 비밀번호를 초기화할 수 있어요. 마스터 계정이나 다른 ‘권한 주는 관리자’ 계정은 권한도 비밀번호도 바꿀 수 없어요.</div></section>';
    h += signupSect();
    // 찾기·거르기(2026-10-07) — 치는 즉시 표가 좁혀진다(다시 그리지 않고 줄만 감춤 → 한글 조합이 안 끊긴다).
    var roleOf = function (u) {
      return u === ACCT.master ? 'mst' : MGRS.indexOf(u) >= 0 ? 'mgr' : USERS[u].is_admin ? 'adm' : 'usr';
    };
    var cntR = function (r) { return list.filter(function (u) { var k = roleOf(u); return r === 'adm' ? k !== 'usr' : k === r; }).length; };
    var bar = '<div class="permbar">' +
      '<label class="field permq">' + ic('search', 15) +
      '<input id="permQ" autocomplete="off" placeholder="이름 · 아이디 · 소속(팀·센터·사업부)으로 찾기" value="' + esc(PERMQ) + '" aria-label="직원 찾기">' +
      '<button class="permx" id="permX" aria-label="찾기 지우기"' + (PERMQ ? '' : ' hidden') + '>' + ic('close', 12) + '</button></label>' +
      '<div class="seg">' + [['', '전체', list.length], ['adm', '관리자', cntR('adm')], ['usr', '일반', cntR('usr')]].map(function (c) {
        return '<button class="' + (PERMF === c[0] ? 'on' : '') + '" data-permf="' + c[0] + '" aria-pressed="' + (PERMF === c[0]) + '">' +
          c[1] + ' <span class="c">' + n0(c[2]) + '</span></button>';
      }).join('') + '</div>' +
      '<span class="permcnt" id="permCnt"></span></div>';
    h += sect('직원', '<span id="permN">' + list.length + '명</span>', '', bar +
      '<div class="panel"><div class="scroll tall" data-rows><table id="permT" class="rcard"><thead><tr>' +
      '<th>이름</th><th>아이디</th><th>소속</th><th>권한</th><th>업무용 차량</th><th></th></tr></thead><tbody>' +
      list.map(function (u) {
        var x = USERS[u], op = orgPath(u), oo = orgOf(u) || {};
        var hay = [x.name || '', u, x.dept || '', op.div, op.team, op.unit, oo.rank || '', oo.role || '', x.position || ''].join(' ').toLowerCase();
        return '<tr data-pq="' + esc(hay) + '" data-pr="' + roleOf(u) + '">' +
          '<td><span class="lead" data-pt="' + esc(x.name || u) + '">' + esc(x.name || u) + '</span></td>' +
          '<td class="dim" data-pt="' + esc(u) + '">' + esc(u) + '</td>' +
          (function () {
            // 소속 칸도 찾은 글자에 형광펜이 들어가게 data-pt 를 단다(orgCell 과 같은 모양).
            var a = orgName(op), b = [op.team ? op.div : '', op.unit].filter(Boolean).join(' · ');
            return '<td class="orgc"><b data-pt="' + esc(a) + '">' + esc(a) + '</b>' + (b ? '<span data-pt="' + esc(b) + '">' + esc(b) + '</span>' : '') + '</td>';
          })() +
          '<td>' + (u === ACCT.master ? '<span class="st bad">마스터</span>'
            : MGRS.indexOf(u) >= 0 ? '<span class="st bad">권한 주는 관리자</span>'
            : x.is_admin ? '<span class="st bad">관리자</span>' : '<span class="dim">일반</span>') + '</td>' +
          // 운전함 / 운전 안 함(개인경비·결재만) — 바꾸기는 줄 끝 「⋯」 메뉴에(2026-10-19 사용성 2차 #14).
          '<td style="white-space:nowrap">' + (x.uses_driving === false ? '<span class="st dim">운전 안 함</span>' : '<span class="st ok">운전함</span>') + '</td>' +
          '<td class="n ract" style="white-space:nowrap">' +
          // 본인 · 마스터 · (마스터가 아니면) 다른 권한 주는 관리자는 권한·비밀번호를 바꿀 수 없다(서버가 거부한다). 그 항목을 아예 안 보인다.
          (function () {
            var fixed = u === myName() ? '본인 계정' : u === ACCT.master || (!master && MGRS.indexOf(u) >= 0) ? '바꿀 수 없음' : '';
            var it = [];
            if (!fixed) {
              it.push(['data-perm="' + esc(u) + '" data-on="' + (x.is_admin ? '0' : '1') + '"', x.is_admin ? '관리자 해제' : '관리자 지정']);
              if (master) it.push(['data-permmgr="' + esc(u) + '" data-on="' + (MGRS.indexOf(u) >= 0 ? '0' : '1') + '"', MGRS.indexOf(u) >= 0 ? '권한 주기 해제' : '권한 주기 허용']);
              it.push(['data-pwreset="' + esc(u) + '"', '비밀번호 초기화', true]);
            }
            it.push(['data-drvset="' + esc(u) + '" data-on="' + (x.uses_driving === false ? '1' : '0') + '"', x.uses_driving === false ? '운전함으로 바꾸기' : '운전 안 함으로 바꾸기']);
            return (fixed ? '<span class="dim kfix">' + fixed + '</span>' : '') + kmenu((x.name || u) + ' 님 작업', it);
          })() +
          '</td></tr>';
      }).join('') + '<tr class="permnone" hidden><td colspan="6"><div class="blank" style="padding:28px 0"><div class="t">찾는 직원이 없어요.</div>' +
        '<div class="d">이름 두 글자, 아이디 일부, ‘대전센터’ 같은 소속으로도 찾을 수 있어요.</div></div></td></tr>' +
      '</tbody></table></div></div>');
    setTimeout(permFilter, 0);              // 그린 뒤 지금 찾기·거르기를 적용
    return h;
  }
  /** 「⋯」 메뉴(2026-10-19 사용성 2차 #14) — 줄마다 단추 서너 개 대신 하나. items = [[속성 문자열, 글자, 위험?], …].
   *  <details> 라 키보드(Enter·Space)로 열리고, 안의 단추는 원래 data-* 를 그대로 가져 같은 처리기가 받는다.
   *  창은 화면 기준(fixed)으로 띄운다 — 표의 스크롤 칸(.scroll) 안에서 잘리지 않게. */
  function kmenu(label, items) {
    if (!items.length) return '';
    return '<details class="kmenu"><summary class="btn sm kbtn" aria-label="' + esc(label) + '" title="' + esc(label) + '">' +
      '<span aria-hidden="true">⋯</span></summary><div class="kpop" role="menu" aria-label="' + esc(label) + '">' +
      items.map(function (it) {
        return '<button type="button" role="menuitem" class="kitem' + (it[2] ? ' danger' : '') + '" ' + it[0] + '>' + esc(it[1]) + '</button>';
      }).join('') + '</div></details>';
  }
  function kmenuCloseAll(except) {
    Array.prototype.forEach.call(document.querySelectorAll('details.kmenu[open]'), function (d) { if (d !== except) d.open = false; });
  }
  function kmenuPlace(d) {
    var s = d.querySelector('summary'), p = d.querySelector('.kpop'); if (!s || !p) return;
    var r = s.getBoundingClientRect(), W = document.documentElement.clientWidth, H = window.innerHeight;
    p.style.left = '0px'; p.style.top = '0px';
    var pw = p.offsetWidth, ph = p.offsetHeight;
    var left = Math.max(8, Math.min(r.right - pw, W - pw - 8));
    var top = r.bottom + 4 + ph > H - 8 && r.top - 4 - ph >= 8 ? r.top - 4 - ph : r.bottom + 4;
    p.style.left = Math.round(left) + 'px'; p.style.top = Math.round(top) + 'px';
  }
  /** 열 때 아래 공간이 모자라면 화면을 조금 올려 아래로 열 자리를 만든다(2026-10-20 폰 마무리 — 위로 열리면 찾기 칸을 덮었다).
   *  더 내릴 데가 없을 때만 kmenuPlace 가 위로 연다. */
  function kmenuRoom(d) {
    var s = d.querySelector('summary'), p = d.querySelector('.kpop'); if (!s || !p) return;
    p.style.left = '0px'; p.style.top = '0px';          // kmenuPlace 와 같은 자리에서 잰다(제자리면 폭이 좁아 높이가 달랐다)
    var r = s.getBoundingClientRect(), H = window.innerHeight, need = r.bottom + 4 + p.offsetHeight - (H - 8) + 1;
    if (need <= 0) return;
    var se = document.scrollingElement || document.documentElement, can = se.scrollHeight - H - (window.pageYOffset || se.scrollTop);
    // 단추가 머리 줄 밑으로 숨지 않을 만큼만(머리 줄 아래 8px 위로는 올리지 않는다)
    var hd = document.querySelector('header.top'), top = hd ? hd.getBoundingClientRect().bottom : 0;
    var by = Math.min(need, can, r.top - top - 8);
    if (by > 0) { try { window.scrollTo({ top: (window.pageYOffset || se.scrollTop) + by, behavior: 'instant' }); } catch (er) { window.scrollTo(0, (window.pageYOffset || se.scrollTop) + by); } }
  }
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d || !d.classList || !d.classList.contains('kmenu') || !d.open) return;
    kmenuCloseAll(d); kmenuRoom(d); kmenuPlace(d);
    var f = d.querySelector('.kitem'); if (f) try { f.focus(); } catch (er) { }
  }, true);
  document.addEventListener('click', function (e) {
    var d = e.target.closest && e.target.closest('details.kmenu');
    if (!d) { kmenuCloseAll(null); return; }
    // 메뉴 안 항목을 누르면 닫는다(그 항목의 일은 원래 처리기가 한다)
    if (e.target.closest('.kitem')) setTimeout(function () { d.open = false; }, 0);
  });
  document.addEventListener('keydown', function (e) {
    var d = document.querySelector('details.kmenu[open]'); if (!d) return;
    if (e.key === 'Escape') { d.open = false; var s = d.querySelector('summary'); if (s) s.focus(); e.stopPropagation(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      var it = Array.prototype.slice.call(d.querySelectorAll('.kitem')), i = it.indexOf(document.activeElement);
      if (!it.length) return;
      e.preventDefault();
      it[(i + (e.key === 'ArrowDown' ? 1 : it.length - 1)) % it.length].focus();
    }
  }, true);
  // 굴리면 닫지 않고 단추를 따라 옮긴다 — 누르는 순간 화면이 단추로 굴러가면(폰·자동 스크롤) 열리자마자 닫혀 「메뉴가 안 나온다」가 됐다
  //   (2026-10-19 로봇). 단추가 화면 밖으로 나가면 그때 닫는다.
  var kmenuFollow = function (e) {
    if (e && e.target && e.target.closest && e.target.closest('.kpop')) return;
    Array.prototype.forEach.call(document.querySelectorAll('details.kmenu[open]'), function (d) {
      var s = d.querySelector('summary'), r = s && s.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight || !r.width) d.open = false; else kmenuPlace(d);
    });
  };
  window.addEventListener('scroll', kmenuFollow, true);
  window.addEventListener('resize', kmenuFollow);

  /** 권한 관리 찾기어·거르기(다시 그려도 남는다). */
  var PERMQ = '', PERMF = '';
  /** 표 줄을 감추고 보이며, 맞은 글자에 형광펜. 표를 다시 그리지 않는다. */
  function permFilter() {
    var t = $('permT'); if (!t) return;
    var q = PERMQ.trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean), n = 0;
    var mark = function (s) {
      var low = s.toLowerCase(), out = '', i = 0;
      if (!words.length) return esc(s);
      while (i < s.length) {
        var hit = 0;
        words.forEach(function (w) { if (!hit && low.substr(i, w.length) === w) hit = w.length; });
        if (hit) { out += '<mark>' + esc(s.substr(i, hit)) + '</mark>'; i += hit; }
        else { out += esc(s.charAt(i)); i++; }
      }
      return out;
    };
    Array.prototype.forEach.call(t.querySelectorAll('tbody tr[data-pq]'), function (tr) {
      var r = tr.dataset.pr;
      var okF = !PERMF || (PERMF === 'adm' ? r !== 'usr' : r === PERMF);
      var okQ = words.every(function (w) { return tr.dataset.pq.indexOf(w) >= 0; });
      tr.hidden = !(okF && okQ);
      if (!tr.hidden) n++;
      Array.prototype.forEach.call(tr.querySelectorAll('[data-pt]'), function (c) { c.innerHTML = mark(c.dataset.pt); });
    });
    var none = t.querySelector('.permnone'); if (none) none.hidden = n > 0;
    var c = $('permN'); if (c) c.textContent = (q || PERMF ? n0(n) + ' / ' : '') + n0(t.querySelectorAll('tbody tr[data-pq]').length) + '명';
    var x = $('permX'); if (x) x.hidden = !PERMQ;
  }

  /** 권한·비밀번호를 바꾸기 전에 본인 비밀번호를 확인받는 창. */
  function openPermConfirm(kind, target, enabled) {
    var nm = nameOf(target);
    $('pTitle').textContent = kind === 'admin' ? (enabled ? '관리자 지정' : '관리자 해제')
      : kind === 'mgr' ? (enabled ? '권한 주기 허용' : '권한 주기 해제') : '비밀번호 초기화';
    $('pSub').textContent = nm + ' (' + target + ')';
    var body = '<div class="form" style="border-top:0;margin-top:0">';   // 창 맨 위 빈 구분선 없음(2026-10-19, 내 계정과 같게)
    if (kind === 'pw') {
      body += '<div class="frow"><label class="flab" for="rsNew">새 비밀번호</label><div class="fbody">' +
        '<input class="inp" type="text" id="rsNew" autocomplete="off" placeholder="4자 이상">' +
        '<div class="fhint">본인에게 직접 알려 주세요. ' +
        '<b>앱과 웹은 같은 비밀번호</b>를 써요.</div></div></div>';
    } else if (kind === 'mgr') {
      body += '<div class="anote">' + esc(nm) + ' 님을 <b>' +
        (enabled ? '권한 주는 관리자로 지정' : '권한 주는 관리자에서 해제') + '</b>할까요?' +
        (enabled ? ' 운행일지 관리자도 함께 켜지고, ‘권한 관리’에서 다른 직원을 관리자로 지정·해제하고 비밀번호를 초기화할 수 있게 돼요.'
          : ' 운행일지 관리자 권한은 그대로 남아요.') + '</div>';
    } else {
      body += '<div class="anote">' + esc(nm) + ' 님을 <b>' +
        (enabled ? '운행일지 관리자로 지정' : '관리자에서 해제') + '</b>할까요?' +
        (enabled ? ' 전 직원의 운행, 정산, 증빙을 보고 계기판을 고칠 수 있게 돼요.' : '') +
        '</div>';
    }
    body += '<div class="frow"><label class="flab" for="rsMine">본인 비밀번호</label><div class="fbody">' +
      mineUserField() + '<input class="inp" type="password" id="rsMine" autocomplete="current-password">' +
      '<div class="fhint">지금 로그인한 <b>' + esc(myName()) + '</b> 계정의 비밀번호를 입력해 주세요.</div>' +
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
      if (np.length < 4) { toast('새 비밀번호는 4자 이상 입력해 주세요.', true); return; }
      payload.next = np;
    }
    var btn = $('btnPermGo'); btn.disabled = true; btn.textContent = '처리 중…';
    apiRetry('/functions/v1/driving-account', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (x) { return { ok: r.ok, j: x }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = '확인';
        if (!res.ok || !res.j || !res.j.ok) {
          toast((res.j && res.j.error) || '처리하지 못했어요.', true); return;
        }
        if (kind === 'admin' && USERS[target]) USERS[target].is_admin = enabled;
        if (kind === 'mgr') {
          var ml = (ACCT.managers || []).filter(function (x) { return x !== target; });
          if (enabled) { ml.push(target); if (USERS[target]) USERS[target].is_admin = true; }
          ACCT.managers = ml;
        }
        closePanel(); render();
        toast(res.j.message || '처리했어요.');
      }).catch(function () {
        btn.disabled = false; btn.textContent = '확인';
        toast('처리하지 못했어요.', true);
      });
  }

  /* ── 업무용 차량 운전함/안 함 (2026-10-07 개인경비) ──
     app_users.uses_driving. false 면 운행일지 화면을 감추고 결재함·개인경비·내 계정만 보인다.
     바꾸는 것은 관리자 RPC(driving_set_uses_driving, 로그인 토큰으로 관리자인지 서버가 본다). */
  function usesDriving(u) {
    var x = USERS[u];
    if (x && x.uses_driving === false) return false;
    if (u === myName() && ME && ME.uses_driving === false) return false;
    return true;
  }
  function openDrvSet(target, on) {
    var nm = nameOf(target);
    openPanel(on ? '운전함으로 바꾸기' : '운전 안 함으로 바꾸기', nm + ' (' + target + ')',
      '<div class="anote" style="margin-top:0">' + esc(nm) + ' 님을 <b>' + (on ? '업무용 차량을 운전하는 직원' : '운전하지 않는 직원') + '</b>으로 바꿀까요? ' +
      (on ? '운행일지와 개인경비를 모두 쓰게 돼요. 앱은 다시 로그인하면 바뀌어요.'
        : '운행일지 화면이 숨겨지고 <b>개인경비 지출결의, 결재함, 내 계정</b>만 보여요. 이미 있는 운행 기록은 지워지지 않아요.') + '</div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnDrvSetGo" data-target="' + esc(target) + '" data-on="' + (on ? '1' : '0') + '">바꾸기</button>');
  }
  function runDrvSet(target, on) {
    var btn = $('btnDrvSetGo'); if (btn) { btn.disabled = true; btn.textContent = '바꾸는 중…'; }
    apiRetry('/rest/v1/rpc/driving_set_uses_driving', {
      // 서버(2026-10-07): p_actor = 나, 돌려주는 값 'ok' | 'NOT_ALLOWED' | 'BAD_TARGET' | 'BAD_INPUT'
      method: 'POST', body: JSON.stringify({ p_actor: myName(), p_target: target, p_value: !!on })
    }).then(function (r) {
      return r.text().then(function (t) { var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; } return { ok: r.ok, j: j }; });
    }).then(function (res) {
      var code = typeof res.j === 'string' ? res.j : '';
      if (!res.ok || code !== 'ok') {
        if (btn) { btn.disabled = false; btn.textContent = '바꾸기'; }
        toast(code === 'NOT_ALLOWED' ? '운행일지 관리자만 바꿀 수 있어요.'
          : code === 'BAD_TARGET' ? '그 계정을 찾지 못했어요.'
          : (res.j && (res.j.message || res.j.error)) || '바꾸지 못했어요. 잠시 후 다시 해 주세요.', true); return;
      }
      if (USERS[target]) USERS[target].uses_driving = !!on;
      closePanel(); render();
      toast(nameOf(target) + ' 님을 ' + (on ? '‘운전함’' : '‘운전 안 함’') + '으로 바꿨어요.');
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = '바꾸기'; }
      toast('바꾸지 못했어요.', true);
    });
  }

  /* ══════════════════ 결재 ══════════════════
     결재 단위는 사람 × 마감주기. 운행 건별로 결재하지 않는다.
     결재선은 상신 창을 열 때 조직도에서 자동으로 채워 주되 잠그지 않는다 — 칸마다 바꾸거나 비울 수 있다(autoLine).
     운행일지·개인경비·법인카드 세 상신 창이 모두 이 한 벌(openSubmit · renderSubmit · autoLine · docBoxes)을 쓴다.  */
  var CYCKEY = function () { return CR.key(CYC); };
  /* ── 결재란 칸 모양 (2026-10-14 사용자 결정) ──
     v2(새것) 담당 · 센터·파트장 · 팀장 · 사업부장 · 대표이사 — 새로 상신하는 문서는 모두 이것(box_set 'v2').
     v1(예전) 담당 · 팀장 · 실장 · 사업부장 · 대표이사 — 이미 상신·완료된 문서는 화면·PDF·엑셀 모두 예전 칸 이름 그대로.
     「팀장」 칸이 v1 은 둘째, v2 는 셋째라 칸 이름으로는 모양을 알 수 없다 — 결재 건의 box_set 을 본다
     (서버 20261014100000_approval_box_v2.sql: 그 전 건은 모두 'v1'). 결재 순서는 어느 쪽이든 칸 순서(왼쪽부터). */
  var BOXES_V1 = ['담당', '팀장', '실장', '사업부장', '대표이사'];
  var BOXES_V2 = ['담당', '센터·파트장', '팀장', '사업부장', '대표이사'];
  var BOXES = BOXES_V2;                  // 새 상신 · 상신 전 미리보기
  /** 결재 건의 결재선이 어느 칸 모양으로 저장됐나 — box_set 이 'v2' 면 새 모양, 없거나 'v1' 이면 예전 건(v1). */
  function boxSetOf(a) { return a && a.box_set === 'v2' ? 'v2' : 'v1'; }
  /**
   * 그 결재 건의 문서에 찍을 결재란 칸 이름 5개(담당 포함).
   * 결재 중·완료 건은 그 건의 칸 모양 그대로(예전 건은 예전 칸). 상신 전(a 없음)·결재선 없는 건·반려·회수된 건은
   * 다음에 올릴 문서의 미리보기라 새 모양 — 그때 결재란에는 담당 칸만 찍힌다(docBoxes).
   * filed = 그 결재 건의 고정본(상신 때 문서)으로 만드는 중 — 반려·회수된 건이어도 상신 때 칸·서명·날짜 그대로(2026-10-16 6차:
   *   예전 칸 문서를 반려하자 문서 결재란이 새 칸 모양 · 모두 빗금 · 담당 날짜 없음으로 바뀌었다). 안 넘기면 운행일지 고정본(withFrozen) 안인지로 정한다.
   */
  function docLive(a, filed) {
    if (filed === undefined) filed = FROZEN_ON;
    return !a || a.status === 'draft' || (!filed && (a.status === 'rejected' || a.status === 'withdrawn'));
  }
  function boxLabels(a, filed) {
    var live = docLive(a, filed) || !(a.steps || []).length;
    return !live && boxSetOf(a) === 'v1' ? BOXES_V1 : BOXES_V2;
  }
  /**
   * 문서(PDF·엑셀·인쇄)의 결재란 칸 값 — 세 문서가 같이 쓴다. { 칸 이름: { name, date, signId } }, 없는 칸 = 빗금.
   * 담당 = 상신자, 승인한 칸만 이름·날짜·서명(안 한 칸·반려한 칸은 빈칸 — 서명처럼 보이면 위조로 오해된다, 2026-09-15).
   * 반려·회수된 건과 상신 전은 결재선을 찍지 않는다(다시 상신하면 처음부터). liveSign = 그때 담당 칸에 찍을 내 서명 id(운행일지만).
   */
  function docBoxes(a, name, liveSign, who, filed) {
    var at = a && a.submitted_at ? Date.parse(a.submitted_at) : NaN;
    var live = docLive(a, filed);
    var labels = boxLabels(a, filed);
    var b = { 담당: { name: name, date: !live && isFinite(at) ? md(at) : '', signId: live ? (liveSign || null) : ((a.snapshot || {}).sign_id || null) } };
    if (!live) ((a && a.steps) || []).forEach(function (s) {
      if (s.box && labels.indexOf(s.box) > 0) {
        var t = s.acted_at ? Date.parse(s.acted_at) : NaN;
        b[s.box] = s.result === 'approved' ? { name: s.name || s.approver, date: isFinite(t) ? md(t) : '', signId: s.sign_id || null } : { name: '', date: '' };
      }
    });
    // 대표이사 칸은 전자 결재를 하지 않는다. 상신자가 사업부장(조직도 직책)이면 빗금 대신 빈칸으로 두어
    // 출력한 종이에 대표이사가 손으로 서명한다. 나머지 직원 문서는 그대로 빗금(2026-10-14 사용자).
    if (!b['대표이사'] && isDivHead(who || (a && a.username))) b['대표이사'] = { name: '', date: '' };
    return b;
  }

  function myAppr(cycle) {
    var k = cycle || CYCKEY(), mine = myName();
    return APPR.filter(function (a) { return a.username === mine && a.cycle === k; })[0] || null;
  }
  /* ── 결재 문서 종류(2026-10-07 개인경비) ──
     운행일지 결재 건은 APPR, 확장 모듈의 결재 건(개인경비)은 EXT.kinds[종류].rows() 에 있고 a._kind 가 붙어 있다.
     번호(id)는 표마다 따로 매기므로 겹칠 수 있다 — 결재 건을 찾을 때는 늘 종류와 함께 찾는다. */
  function kindOf(a) { return (a && a._kind) || ''; }
  function kindDef(k) { return (k && EXT.kinds[k]) || null; }
  function extAppr() {
    var out = [];
    Object.keys(EXT.kinds).forEach(function (k) { try { out = out.concat(EXT.kinds[k].rows() || []); } catch (e) { } });
    return out;
  }
  /** 결재함이 보는 결재 건 전부 — 운행일지 + 확장. 확장 건이 있으면 상신 시각 최근 순으로 섞는다. */
  function allAppr() {
    var x = extAppr();
    if (!x.length) return APPR;
    return APPR.concat(x).sort(function (a, b) { return String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')); });
  }
  function apprFind(id, kind) {
    var kd = kindDef(kind), list = kd ? (kd.rows() || []) : APPR;
    return list.filter(function (x) { return x.id === id; })[0] || null;
  }
  /** 내 차례인 결재 건. 관리자라도 결재선에 없으면 안 나온다(대결 불가). */
  function inbox() {
    var mine = myName();
    return allAppr().filter(function (a) {
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
   * 결재선의 정본은 상신자다 — 상신 창이 조직도로 미리 채워도(autoLine) 칸마다 직접 바꾸고 비운다
   * (2026-10-02 「상신자가 칸마다 직접」 + 2026-10-14 「조직도로 미리 채우기」 사용자 결정).
   * ★ 예전 칸 모양(v1 — 팀장·실장 …)으로 올린 결재선은 쓰지 않는다. 칸 이름이 같아도 자리가 달라
   *   (v1 「팀장」 칸 = 센터장) 그대로 옮기면 다른 사람이 다른 칸에 들어간다(2026-10-14 사용자 결정).
   */
  function previousSteps() {
    var mine = myName(), kd = kindDef(SUB_KIND);
    var cur = sameCycleLine();
    var latest = function (list) {
      return list.filter(function (a) {
        return a.username === mine && a.cycle !== CYCKEY() && (a.steps || []).length && boxSetOf(a) === 'v2';
      }).sort(function (a, b) { return (b.submitted_at || '').localeCompare(a.submitted_at || ''); })[0];
    };
    // 개인경비·법인카드는 그 종류 결재 건에서 먼저 찾고, 처음 올리는 것이면 운행일지 때의 결재선을 불러온다.
    var past = cur || (kd ? (latest(kd.rows() || []) || latest(APPR)) : latest(APPR));
    if (!past) return null;
    return usableSteps(past.steps);
  }
  /** 이번 기간에 반려·회수된 내 결재 건(새 칸 모양 v2 일 때만) — 상신 창을 열 때 자동 결재선보다 먼저 쓴다. 없으면 null. */
  function sameCycleLine() {
    var kd = kindDef(SUB_KIND), cur = kd ? kd.mine(CYCKEY()) : myAppr();
    return cur && (cur.status === 'rejected' || cur.status === 'withdrawn') && (cur.steps || []).length && boxSetOf(cur) === 'v2' ? cur : null;
  }
  /** 지금 규칙(새 칸 모양 · 칸마다 한 명 · 결재할 수 있는 사람)으로 거른 [{approver, box}], 칸 순서. 남는 것이 없으면 null. */
  function usableSteps(steps) {
    // 버튼에 적는 것과 실제로 불러오는 것이 같아야 한다 — 미리 걸러 둔다. 예전 화면에서 만든 결재선은 칸이 겹치거나 비어 있을 수 있다.
    var seenB = {};
    var out = (steps || []).filter(function (s) {
      if (!s.approver || !canApprove(s.approver)) return false;      // 본인 칸도 그대로(2026-10-07 본인 넣기 허용)
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
  /** 조직도 직책이 사업부장인 계정인가 — 그 사람이 올린 문서는 대표이사 칸을 손 서명 빈칸으로 둔다(2026-10-14). */
  function isDivHead(u) { var o = u ? orgOf(u) : null; return !!(o && String(o.role || '').trim() === '사업부장'); }
  function orgLabel(u) {
    var o = orgOf(u), p = personOf(u);
    if (!o) return [p.dept, p.position].filter(Boolean).join(' · ');
    return [[o.team, o.unit].filter(Boolean).join(' ') || o.division, o.rank, o.role].filter(Boolean).join(' · ');
  }
  /** 결재란 이름 아래 글 — 서버 approval-act 가 steps.position 에 적는 것과 같은 규칙: 조직도 직책 → 직급 → 앱 계정의 직급(2026-10-16 4차).
   *  예전에는 앱 계정의 직급(책임·수석)을 그대로 써서 「팀장」 칸 아래 「책임」이 찍혔다. */
  function boxPos(u) {
    var o = orgOf(u) || {};
    return String(o.role || '').trim() || String(o.rank || '').trim() || personOf(u).position || '';
  }
  /** 결재 단계 사람의 직책 — 상신 창 결재란(boxPos)과 같은 값. 조직도에서 내려간 분이면 상신 때 서버가 굳힌 steps.position.
   *  예전에는 곳마다 달랐다: 상신 창 「센터장」, 진행 줄 「센터·파트장」(칸 이름), 결재 완료 출력 「홍길동 (실장)」(예전 칸 이름)(2026-10-16 5차). */
  function stepPos(s) {
    if (!s) return '';
    return orgOf(s.approver) ? boxPos(s.approver) : (String(s.position || '').trim() || personOf(s.approver).position || '');
  }
  /** 「홍길동 센터장」 — 이름 + 직책. */
  function stepWho(s) { var p = stepPos(s), n = (s && (s.name || nameOf(s.approver))) || ''; return n + (p ? ' ' + p : ''); }
  /** 「홍길동 센터장 (센터·파트장 칸)」 — 직책과 결재란 칸 이름을 나눠 적는다(칸 이름이 직책처럼 읽히지 않게). */
  function stepText(s) { return stepWho(s) + (s && s.box ? ' (' + s.box + ' 칸)' : ''); }
  function canApprove(u) {
    return !!PEOPLE[u] && ORG.some(function (o) { return o.username === u && o.active !== false; });
  }

  /* ── 조직도 자동 결재선 (2026-10-14 사용자 결정) ──
     상신 창을 열 때 결재란을 조직도로 미리 채운다. 세 문서(운행일지·개인경비·법인카드)가 이 함수 하나를 쓰고,
     관리 › 조직도 화면(drv-org.js)도 같은 함수로 부서별 결재선을 미리 보인다.
       상신자의 조직도 행(앱 계정으로 이음) →
         같은 센터·파트(unit)에서 직책이 센터장·파트장인 분 → 「센터·파트장」 칸
         같은 팀에서 직책이 팀장인 분                        → 「팀장」 칸
         같은 사업부에서 직책이 사업부장인 분                → 「사업부장」 칸
         「대표이사」 칸은 채우지 않는다(빗금 /).
       · 상신자 본인이 그 장이면 그 칸은 비운다(빗금).
       · 센터·파트 없이 팀 직속이면 센터·파트장 칸은 말없이 비운다(담당 → 팀장 → 사업부장).
       · 그 자리에 장이 없거나, 둘 이상이거나, 장에게 앱 계정이 없거나 조직도에서 내려가 있으면 비우고 까닭을 적는다
         (「센터·파트장: 조직도에 직책이 없어요. 직접 골라 주세요.」).
     미리 채운 칸도 지금처럼 칸마다 바꾸거나 × 로 비울 수 있다 — 결재선의 정본은 여전히 상신자다. */
  /** 결재 카드(상신 전)의 안내 — 세 문서가 같은 글을 쓴다. */
  var APPR_HINT = '상신 창을 열면 관리자가 지정한 결재선이, 없으면 조직도의 센터·파트장, 팀장, 사업부장 순서로 미리 채워져요. 칸마다 바꾸거나 비울 수 있어요.';
  var AUTO_LEVELS = [
    { box: '센터·파트장', roles: ['센터장', '파트장'], key: 'unit' },
    { box: '팀장', roles: ['팀장'], key: 'team' },
    { box: '사업부장', roles: ['사업부장'], key: 'division' }
  ];
  /**
   * 조직도 자리 pos = { division, team, unit } 에 있는 사람(self = 그 사람의 조직도 행, 부서 미리보기면 null)의 자동 결재선.
   * 돌려주는 값: { steps: [{ approver, box }](칸 순서), notes: [{ box, why, t }](비운 까닭 — t 는 화면 글) }
   */
  function lineAt(pos, self) {
    var steps = [], notes = [];
    var same = function (o, key) {
      if ((o.division || '') !== (pos.division || '')) return false;
      if (key === 'division') return true;
      if ((o.team || '') !== (pos.team || '')) return false;
      return key === 'team' || (o.unit || '') === (pos.unit || '');
    };
    AUTO_LEVELS.forEach(function (lv) {
      if (!pos[lv.key]) return;                                   // 그 단계가 없는 자리(팀 직속 등) — 말없이 건너뜀
      var heads = ORG.filter(function (o) { return lv.roles.indexOf(String(o.role || '').trim()) >= 0 && same(o, lv.key); });
      if (self && heads.some(function (o) { return o === self || (o.id != null && o.id === self.id) || (self.username && o.username === self.username); })) return;   // 본인이 장
      var on = heads.filter(function (o) { return o.active !== false; });
      var note = function (why) { notes.push({ box: lv.box, why: why, t: lv.box + ': ' + why + '. 직접 골라 주세요.' }); };
      if (!on.length) { note(heads.length ? '조직도에서 내려간 분뿐이에요(' + heads.map(function (o) { return o.name; }).join('·') + ')' : '조직도에 직책이 없어요'); return; }
      if (on.length > 1) { note('직책이 ' + on.length + '명이에요(' + on.map(function (o) { return o.name; }).join('·') + ')'); return; }
      var h = on[0];
      if (!h.username || !canApprove(h.username)) { note(h.name + ' 님은 앱 계정이 없어요'); return; }
      steps.push({ approver: h.username, box: lv.box });
    });
    return { steps: steps, notes: notes };
  }
  /** 이 계정 사람의 자동 결재선. 조직도에 없으면 steps 없이 까닭 하나. */
  function autoLine(u) {
    var me = orgOf(u);
    if (!me) return { steps: [], notes: [{ box: '', why: '조직도에 없어요', t: '조직도에 없어 결재선을 미리 채우지 못했어요. 직접 골라 주세요.' }] };
    return lineAt({ division: me.division || '', team: me.team || '', unit: me.unit || '' }, me);
  }

  /* ── 관리자가 지정한 결재선 (2026-10-14 사용자: 「결재라인을 일일이 수정할 수 있게」) ──
     관리 › 조직도에서 관리자가 사람마다(또는 한 부서 모두) 칸마다 정한다 — driving_line_override.boxes
       키 없음 = 그 칸은 자동(조직도 직책) · '' = 비움(빗금) · 아이디 = 그 분
     상신 창은 「이번 기간 넣다 만 것 → 이번 기간 반려·회수된 결재선 → 관리자 지정 → 조직도 자동」 차례로 미리 채운다.
     직원은 여전히 칸마다 바꾸거나 비울 수 있다(결재선의 정본은 상신자). 서버(approval-act)는 바뀌지 않는다.
       · 지정한 분이 지금 결재할 수 없으면(조직도에서 내려감·계정 없어짐) 그 칸만 자동으로 채우고 까닭을 남긴다.
       · 지정한 분이 상신자 본인이면 자동과 같이 그 칸은 비운다. */
  /** 표가 없거나(배포 순서) 못 받으면 null — 그때는 자동 결재선만 쓰고 「결재선 지정」을 숨긴다. */
  /** 지정 결재선 받기 — 1000줄씩 끝까지(서버 기본 상한에 말없이 잘리지 않게, 2026-10-14 검증로봇).
   *  표가 아직 없으면(404) null = 기능 숨김. 그 밖의 실패(5xx·네트워크)는 undefined = 받아 둔 목록을 그대로 둔다
   *  — 한 번 실패로 관리자 지정이 사라지고 자동 결재선이 대신 채워지던 것. */
  function fetchLineOv() {
    var acc = [];
    function page(off) {
      return apiRetry('/rest/v1/driving_line_override?select=username,boxes,updated_by,updated_at&order=username.asc&offset=' +
        off + '&limit=1000').then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) return undefined;
        return r.json().then(function (a) {
          if (!Array.isArray(a)) return undefined;
          acc = acc.concat(a);
          return a.length < 1000 || off > 40000 ? acc : page(off + 1000);
        });
      });
    }
    return page(0).catch(function () { return undefined; });
  }
  function setLineOv(rows) {
    if (rows === undefined) return;                          // 받지 못함 — 전에 받은 목록 그대로
    LINE_OV = {}; LINE_OV_OK = Array.isArray(rows);
    (rows || []).forEach(function (x) {
      if (x && x.username && x.boxes && typeof x.boxes === 'object' && !Array.isArray(x.boxes)) LINE_OV[x.username] = x;
    });
  }
  /** 이 사람에게 관리자가 지정한 칸들({ 칸: '' | 아이디 }), 없으면 null. */
  function lineOverride(u) { var x = u && LINE_OV[u]; return x ? x.boxes : null; }
  /** 지정(boxes)을 자동 결재선(al = lineAt·autoLine 결과)에 칸마다 얹는다. self = 상신자 아이디(본인 칸은 비움). */
  function applyOverride(al, boxes, self) {
    var steps = [], notes = [], anyAuto = false;
    APPR_BOXES.forEach(function (b) {
      var a = al.steps.filter(function (s) { return s.box === b; })[0];
      var an = al.notes.filter(function (n) { return n.box === b; });
      if (!Object.prototype.hasOwnProperty.call(boxes, b)) {          // 자동
        anyAuto = true;
        if (a) steps.push(a);
        notes = notes.concat(an);
        return;
      }
      var v = boxes[b];
      if (!v) return;                                                 // 비움(빗금)
      if (self && v === self) return;                                 // 본인 칸은 비움(자동과 같은 규칙)
      if (canApprove(v)) { steps.push({ approver: v, box: b }); return; }
      // 지정한 분이 지금 결재할 수 없다 — 그 칸만 자동으로. keep = 칸이 채워져도 상신 창에 까닭을 남긴다.
      var why = '관리자가 지정한 ' + nameOf(v) + ' 님은 지금 결재할 수 없어요';
      if (a) { steps.push(a); notes.push({ box: b, keep: true, why: why, t: b + ': ' + why + '. 조직도로 채웠어요.' }); }
      else if (an.length) notes = notes.concat(an.map(function (n) { return { box: b, why: why + '. ' + n.why, t: b + ': ' + why + '. ' + n.why + '. 직접 골라 주세요.' }; }));
      else notes.push({ box: b, why: why, t: b + ': ' + why + '. 직접 골라 주세요.' });
    });
    // 칸 없는 까닭(조직도에 없음)은 자동 칸이 하나라도 남을 때만
    if (anyAuto) al.notes.forEach(function (n) { if (!n.box) notes.push(n); });
    return { steps: steps, notes: notes, part: anyAuto };
  }
  /** 이 사람의 실제로 미리 채워질 결재선(지정 + 자동). over = 관리자 지정이 있는가. */
  function effLine(u) {
    var al = autoLine(u), b = lineOverride(u);
    if (!b) { al.over = false; return al; }
    var m = applyOverride(al, b, u);
    m.over = true; m.boxes = b;
    return m;
  }

  /* ══════════════════ 관리 화면 공통 — 소속(사업부 › 팀 › 파트·센터)으로 좁히고 묶기 (2026-10-07) ══════════════════
     조직도(driving_org)가 정본이다. 조직도에 안 이어진 계정은 가입 때 적은 부서(dept)를 조직도의 팀·파트 이름과
     맞춰 본다. 고른 범위(ORGF)는 관리 화면 전부에 같이 걸린다 — 한 번 「광역교통지원팀」을 고르면 운행일지·영수증·
     정산·검증·결재 완료가 모두 그 팀만 보인다. */
  // 2026-10-07 사용자: 기본은 늘 「전체」 — 메뉴로 다른 관리 화면에 가거나 새로 열면 전체로 돌아간다(같은 묶음의 탭끼리는 유지).
  var ORGF = { div: '', team: '', unit: '' };
  function saveOrgF() { }
  var ORGP = { ref: null, users: null, people: null, map: {} };
  function orgPath(u) {
    if (ORGP.ref !== ORG || ORGP.users !== USERS || ORGP.people !== PEOPLE) ORGP = { ref: ORG, users: USERS, people: PEOPLE, map: {} };
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
  var KEEP_ORG = false;          // 다음 go() 한 번은 보는 범위를 비우지 않는다(파고드는 이동)
  /** 지금 보는 범위의 이름(파일 이름·제목용). 전체면 ''. */
  function orgScopeName() {
    if (!orgFilterOn()) return '';
    return [ORGF.div === '-' ? '소속미지정' : ORGF.div, ORGF.team, ORGF.unit].filter(Boolean).slice(-1)[0] || '';
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
  /** 묶음 제목 줄. right = 오른쪽에 붙일 합계 등. lead = 팀 이름 앞에 둘 것(결재 완료 출력 「이 팀 모두 고르기」 칸 finGrp, 2026-10-23) —
   *  있으면 줄에 팀 열쇠(data-gk = orgGroups 의 사업부|팀)를 단다. */
  function orgGroupRow(g, cols, right, lead) {
    return '<tr class="ogrp"' + (lead ? ' data-gk="' + esc(g.k) + '"' : '') + '><td colspan="' + cols + '"><div>' + (lead || '') + '<b>' + esc(orgName(g.p)) + '</b>' +
      (g.p.team && g.p.div ? '<span class="od">' + esc(g.p.div) + '</span>' : '') +
      '<span class="on">' + n0(g.list.length) + '명</span>' + (right ? '<span class="or">' + right + '</span>' : '') + '</div></td></tr>';
  }
  /** 관리 화면 위 「보는 범위」 줄 — 사업부 › 팀 › 파트·센터. 고를 수 있는 값은 지금 자료에 있는 사람 기준. */
  function orgBarHtml() {
    var r = viewRange(), seen = {};
    // 확장 화면(개인경비 관리)은 그 기간에 경비를 쓴·상신한 사람으로 고를 값을 만든다.
    var xu = EXT.orgUsers ? EXT.orgUsers(VIEW) : null;
    if (xu) xu.list.forEach(function (u) { seen[u] = 1; });
    else ALL_TRIPS.forEach(function (t) { if (t.start_time >= r.lo && t.start_time < r.hi) seen[t.username] = 1; });
    var us = Object.keys(seen);
    var cnt = function (f) { var c = {}; us.forEach(function (u) { var p = orgPath(u); if (f(p)) { var v = f(p); c[v] = (c[v] || 0) + 1; } }); return c; };
    var divs = cnt(function (p) { return p.div || '-'; });
    var inDiv = function (p) { return !ORGF.div || (ORGF.div === '-' ? !p.div : p.div === ORGF.div); };
    var teams = cnt(function (p) { return inDiv(p) ? p.team : ''; });
    var units = cnt(function (p) { return inDiv(p) && (!ORGF.team || p.team === ORGF.team) ? p.unit : ''; });
    var opt = function (obj, cur, all) {
      if (cur && obj[cur] == null) obj[cur] = 0;
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
      '<span class="ocnt">' + (xu ? esc(xu.label) : '운행한 사람') + ' <b>' + n0(shown) + '</b>' + (orgFilterOn() ? ' / ' + n0(us.length) : '') + '명</span>' +
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
    if (!a) return { t: '아직 상신하지 않았어요', cls: '' };
    if (a.status === 'approved') return { t: '결재 완료', cls: 'ok' };
    if (a.status === 'rejected' && reopenInfo(a)) {
      var ro = reopenInfo(a);
      // 사유가 마침표로 끝나면 「..」이 되지 않게 사유 끝 부호를 떼고 잇는다(2026-10-24 검수)
      return { t: '정정 중 · 관리자(' + nameOf(ro.reopened_by) + ')' + (ro.reopen_reason ? ' · ' + String(ro.reopen_reason).trim().replace(/[.\s]+$/, '') : '') + '. 고친 뒤 다시 상신하세요.', cls: 'bad' };
    }
    if (a.status === 'rejected') {
      var r = (a.steps || []).filter(function (s) { return s.result === 'rejected'; })[0];
      // 관리자 권한 반려는 그 칸의 결재자가 한 것이 아니다 — 이름을 바꿔 적는다.
      var who = r && r.forced_by ? '관리자(' + nameOf(r.forced_by) + ')' : ((r && r.name) || '');
      // 승인했다가 취소하고 반려한 칸(2026-10-19)은 「승인 취소」를 붙인다 — 반려와 같은 띠·같은 다시 상신
      if (r && r.recalled && !r.forced_by) who += '(승인 취소)';
      return { t: '반려 · ' + who + (r && r.comment ? ' · ' + r.comment : ''), cls: 'bad' };
    }
    // 상신한 본인에게는 「회수했어요」, 결재하는 분에게는 「회수됨」(결재자가 회수한 것처럼 읽혔다 — 2026-10-15)
    if (a.status === 'withdrawn') return { t: a.username === myName() ? '회수했어요' : '회수됨', cls: '' };
    var cur = (a.steps || []).filter(function (s) { return s.seq === a.cur_seq; })[0];
    if (!cur) return { t: '결재 중', cls: 'warn' };
    // 내 차례면 3인칭으로 부르지 않는다. 눌러야 할 사람에게 눌러야 한다고 말해야 한다.
    if (cur.approver === myName()) return { t: '내 차례예요', cls: 'bad' };
    return { t: (cur.name || cur.approver) + ' 님 결재 중', cls: 'warn' };
  }

  /** 진행 막대 — 상신자부터 마지막 결재자까지. */
  function apprTrack(a) {
    if (!a || !(a.steps || []).length) return '';
    // 번호·이름을 한 덩어리(.astep)로 묶고, 다음 단계로 가는 선은 앞 덩어리 끝에 붙인다 —
    // 폰에서 줄이 바뀌어도 번호만 윗줄에 남거나 아랫줄이 선부터 시작하지 않게(2026-10-08)
    var h = '<div class="aprog"><span class="astep"><span class="anode done">' + ic('check', 12) + '</span>' +
      '<span class="alabel">' + esc(nameOf(a.username)) + '</span>';
    a.steps.forEach(function (s) {
      var st = s.result === 'approved' ? 'done'
        : s.result === 'rejected' ? 'bad'
          : (a.status === 'submitted' && s.seq === a.cur_seq) ? 'now' : 'wait';
      h += '<span class="aline ' + (st === 'done' ? 'done' : '') + '"></span></span>' +
        '<span class="astep"><span class="anode ' + st + '">' +
        (st === 'done' ? ic('check', 12) : st === 'bad' ? '!' : s.seq) + '</span>' +
        // 이름 + 직책(상신 창 결재란과 같은 값) · 흐린 글씨로 결재란 칸 이름(「… 칸」) — 칸 이름이 직책처럼 읽히지 않게(2026-10-16 5차)
        //   괄호는 상신 창·알림·출력 표와 같게 「홍길동 센터장 (센터·파트장 칸)」(2026-10-16 6차 — 진행 줄만 괄호가 없었다)
        '<span class="alabel' + (st === 'wait' ? ' wait' : '') + '">' + esc(stepWho(s) || s.approver) +
        (s.box ? '<em>(' + esc(s.box) + ' 칸)</em>' : '') + '</span>';
    });
    return h + '</span></div>';
  }

  /* ── 의견 모아 보기(2026-10-21 사용자 「결재할 때 의견란이 이미 있으니 영수증마다 따로 둘 필요 없고, 담당자부터 의견이 결재함 어딘가에 있기만 하면 된다」) ──
     차례대로 — 담당(상신 의견: 서버가 그 상신의 요약 snapshot.note 에 굳힌 글) → 결재자마다 승인 의견(steps[].comment). 글이 있는 것만.
     반려 사유는 넣지 않는다 — 반려된 문서는 상태 글(「반려 — 이름 · 사유」)·반려 띠가 이미 보인다(겹치지 않게).
     세 결재 같은 조각: 결재함 「문서 보기」를 편 자리(apvSlot) · 승인·반려 창(「의견」 칸 위) · 상신한 본인의 결재 띠(apprStrip). */
  function apprOpinions(a) {
    var out = [];
    if (!a) return out;
    var note = a.snapshot && typeof a.snapshot.note === 'string' ? a.snapshot.note.trim() : '';
    if (note) out.push({ who: nameOf(a.username), tag: '담당', at: a.submitted_at, txt: note });
    (a.steps || []).slice().sort(function (x, y) { return x.seq - y.seq; }).forEach(function (s) {
      var c = s && s.comment != null ? String(s.comment).trim() : '';
      if (!c || s.result !== 'approved') return;
      out.push({ who: stepWho(s) || nameOf(s.approver), tag: (s.box ? s.box + ' 칸 · ' : '') + '승인', at: s.acted_at, txt: c });
    });
    return out;
  }
  function opinionsHtml(a) {
    var L = apprOpinions(a);
    if (!L.length) return '';
    return '<div class="aops" role="group" aria-label="의견"><div class="aoph">의견</div><ol class="aopl">' + L.map(function (o) {
      var t = Date.parse(o.at || '');
      return '<li><div class="aopw"><b>' + esc(o.who) + '</b> <span>' + esc(o.tag + (isFinite(t) ? ' · ' + noteTime(t) : '')) + '</span></div>' +
        '<div class="aopt">' + esc(o.txt) + '</div></li>';
    }).join('') + '</ol></div>';
  }

  /* ── 상신 창 ── */
  /** 상신 창이 다루는 결재 문서 종류. '' = 운행일지, 'expense' = 개인경비(EXT.kinds). */
  var SUB_KIND = '';
  function draftKey() { return (SUB_KIND ? SUB_KIND + ':' : '') + CYCKEY(); }
  function openSubmit(kind) {
    SUB_KIND = kindDef(kind) ? kind : '';
    APPR_SWAP = false;
    if (isMulti()) { toast('상신은 한 기간씩 해요. 기간을 하나 골라 주세요.', true); return; }
    var a = SUB_KIND ? kindDef(SUB_KIND).mine(CYCKEY()) : myAppr();
    if (a && (a.status === 'submitted' || a.status === 'approved')) {
      toast(a.status === 'approved' ? '이미 결재가 끝났어요.' : '이미 상신했어요.', true); return;
    }
    // 미리 채우는 차례(2026-10-14 사용자 결정):
    //   ① 이 기간에 넣다 만 결재선(창을 닫거나 「검증 결과 보기」로 나갔다 와도 다시 넣지 않게 — 다 비운 것도 그대로)
    //   ② 이 기간에 반려·회수된 건의 결재선(새 칸 모양일 때만 — 상신자가 이미 손본 것)
    //   ③ 관리자가 지정한 결재선(effLine — 지정 안 한 칸은 자동, 2026-10-14)
    //   ④ 조직도 자동 결재선(autoLine)
    //   예전 칸 모양(v1)으로 올린 결재선은 미리 채우는 데 쓰지 않는다.
    var key = draftKey();
    if (Object.prototype.hasOwnProperty.call(DRAFT_KEEP, key)) {
      DRAFT = DRAFT_KEEP[key].slice();
    } else {
      var back = sameCycleLine(), bs = back && usableSteps(back.steps);
      if (bs) { DRAFT = bs; FILL_SRC[key] = { src: 'prev', notes: [] }; }
      else if (lineOverride(myName())) {
        var el = effLine(myName()); DRAFT = el.steps.slice(); FILL_SRC[key] = { src: 'admin', notes: el.notes, part: !!el.part };
      }
      else { var al = autoLine(myName()); DRAFT = al.steps.slice(); FILL_SRC[key] = { src: 'auto', notes: al.notes }; }
    }
    APPR_Q = '';
    // 넣을 칸: 비어 있으면 첫 칸(바로 이름을 칠 수 있게), 미리 채웠으면 까닭이 적힌 빈칸(「직접 골라 주세요」), 없으면 고르지 않는다.
    var fs0 = FILL_SRC[key] || { notes: [] };
    APPR_BOX = !DRAFT.length ? APPR_BOXES[0]
      : (fs0.notes.map(function (n) { return n.box; }).filter(function (b) { return b && !draftAt(b); })[0] || '');
    renderSubmit();
    var box = $('apprQ'); if (box) box.focus();
  }
  /** 결재자 찾기 입력에 지금 쳐 놓은 글자. 창을 다시 그려도 남는다. */
  var APPR_Q = '';

  /** 조직도에서 고른 자리(사업부 | 팀 | 파트). '' = 전체. 이름을 치면 전체에서 찾는다. */
  var APPR_NODE = '';
  /** 이름·아이디·부서·직급 어디에든 걸리면 후보로 본다.
   *  2026-10-07: 본인도 넣을 수 있다(팀장이 직접 올릴 때 팀장 칸에 본인). 본인 칸도 차례가 오면 결재함에서 직접 승인한다(칸마다 한 번씩). */
  function apprCandidates(ignoreNode) {
    var q = APPR_Q.trim().toLowerCase();
    var list = Object.keys(PEOPLE).filter(function (u) { return canApprove(u); });
    if (q) {
      list = list.filter(function (u) {
        var p = personOf(u);
        var o = orgOf(u) || {};
        return [nameOf(u), u, p.dept || '', p.position || '', o.division || '', o.team || '', o.unit || '', o.rank || '', o.role || '']
          .join(' ').toLowerCase().indexOf(q) >= 0;
      });
    } else if (APPR_NODE && !ignoreNode) {
      var n = APPR_NODE.split('|');
      list = list.filter(function (u) {
        var p = orgPath(u);
        return (p.div || '(소속 미지정)') === n[0] && (n.length < 2 || p.team === n[1]) && (n.length < 3 || p.unit === n[2]);
      });
    }
    return list.sort(function (a, b) {
      var pa = orgPath(a), pb = orgPath(b);
      return (orgRank(pa) - orgRank(pb)) || (pa.unit || '').localeCompare(pb.unit || '', 'ko') || nameOf(a).localeCompare(nameOf(b), 'ko');
    });
  }
  /** 조직도 나무(결재자가 있는 곳만) — 사업부 › 팀 › 파트·센터, 사람 수와 함께. */
  function apprTreeHtml() {
    var all = apprCandidates(true), tree = {}, order = [];
    if (APPR_Q.trim()) { all = Object.keys(PEOPLE).filter(function (u) { return canApprove(u); }); }
    all.forEach(function (u) {
      var p = orgPath(u), d = p.div || '(소속 미지정)';
      if (!tree[d]) { tree[d] = { n: 0, teams: {}, rank: orgRank(p) }; order.push(d); }
      tree[d].n++;
      var t = tree[d].teams;
      if (p.team) {
        if (!t[p.team]) t[p.team] = { n: 0, units: {} };
        t[p.team].n++;
        if (p.unit) t[p.team].units[p.unit] = (t[p.team].units[p.unit] || 0) + 1;
      }
    });
    order.sort(function (x, y) { return tree[x].rank - tree[y].rank || x.localeCompare(y, 'ko'); });
    var node = function (key, label, n, lv) {
      var on = APPR_NODE === key && !APPR_Q.trim();
      return '<button class="atn lv' + lv + (on ? ' on' : '') + '" data-anode="' + esc(key) + '"' + (on ? ' aria-current="true"' : '') + '>' +
        '<span class="atl">' + esc(label) + '</span><span class="atc">' + n0(n) + '</span></button>';
    };
    var cur = APPR_NODE.split('|');
    var h = node('', '전체', all.length, 0);
    order.forEach(function (d) {
      h += node(d, d, tree[d].n, 1);
      if (cur[0] !== d) return;                      // 고른 사업부만 펼친다
      Object.keys(tree[d].teams).sort(function (a, b) { return a.localeCompare(b, 'ko'); }).forEach(function (t) {
        var T = tree[d].teams[t];
        h += node(d + '|' + t, t, T.n, 2);
        if (cur[1] !== t) return;
        Object.keys(T.units).sort(function (a, b) { return a.localeCompare(b, 'ko'); }).forEach(function (u) {
          h += node(d + '|' + t + '|' + u, u, T.units[u], 3);
        });
      });
    });
    return h;
  }
  function apprCandHtml() {
    var all = apprCandidates();
    var list;
    if (!all.length) {
      list = '<div class="acnone">' +
        (APPR_Q.trim() ? '‘' + esc(APPR_Q.trim()) + '’ 검색 결과가 없어요.' : '이 자리에는 결재자로 넣을 분이 없어요.') +
        '<br><span style="font-size:12px">조직도에 올라 있고 앱 계정이 연결된 분만 결재자로 나와요. 없으면 관리자에게 조직도 등록을 요청하세요.</span></div>';
    } else {
      var lastG = null;
      list = all.map(function (u, i) {
        var p = orgPath(u), g = orgName(p) + (p.unit ? ' · ' + p.unit : '');
        var o = orgOf(u) || {};
        var head = g !== lastG ? '<div class="acg">' + esc(g) + '</div>' : '';
        lastG = g;
        var at = DRAFT.filter(function (d) { return d.approver === u; }).map(function (d) { return d.box; });
        return head + '<button class="acand-i' + (i === 0 && APPR_Q.trim() ? ' top' : '') + '" data-addappr="' + esc(u) + '">' +
          '<b>' + esc(nameOf(u)) + '</b>' +
          '<span>' + esc([o.role, o.rank].filter(Boolean).join(' · ') || personOf(u).position || '') + '</span>' +
          (u === myName() ? '<span class="st" style="flex:none;margin-left:6px">본인</span>' : '') +
          (at.length ? '<span class="st warn" style="flex:none;margin-left:6px">이미 ' + esc(at.join('·')) + ' 칸</span>' : '') +
          (i === 0 && APPR_Q.trim() ? '<span class="acent">Enter</span>' : '') + '</button>';
      }).join('');
    }
    return '<div class="apick"><div class="atree" aria-label="조직도">' + apprTreeHtml() + '</div>' +
      '<div class="alist">' + list + '</div></div>';
  }

  /* ── 결재란 칸 고르기 ──
     상신 창은 결재 문서의 결재란 모양(담당 · 센터·파트장 · 팀장 · 사업부장 · 대표이사 — 2026-10-14 새 칸) 그대로 보여 준다.
     창을 열 때 조직도로 미리 채운다(openSubmit · autoLine). 상신자는 칸을 누르고 이름을 넣어 그 칸의 결재자를 고르고,
     미리 채운 칸도 × 로 비우고 다른 분을 넣을 수 있다. 비워 둔 칸은 빗금(/)으로 찍히고 건너뛴다.
     결재는 왼쪽 칸부터 채워진 칸 차례로 진행된다(DRAFT 는 늘 칸 순서로 정렬해 둔다).
     (2026-10-02 사용자 결정 — "결재란 화면은 그대로 있고 본인이 선택해서 이름 넣는 방식, 건너뛰면 / 처리") */
  // 센터·파트장 · 팀장 · 사업부장 (담당 = 상신자 본인). 전자 결재는 사업부장에서 끝난다 — 대표이사 칸은 고를 수 없고
  // 출력한 종이에 손으로 서명하는 빈칸이다(2026-10-14 사용자).
  var APPR_BOXES = BOXES.slice(1, 4);
  var APPR_BOX = '';                     // 지금 이름을 넣을 칸
  var APPR_SWAP = false;                 // 채운 칸을 눌러 「다른 분으로 바꾸기」 중(그 칸을 고른 채로 둔다 — 2026-10-15)
  function draftAt(box) { return DRAFT.filter(function (s) { return s.box === box; })[0] || null; }
  /** 칸 순서로 정렬하고, 한 칸에 한 명만 남긴다(같은 분이 여러 칸에 있어도 된다). */
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
    if (!u) return;
    var box = APPR_BOX || nextEmptyBox(APPR_BOXES[0]);
    if (!box) { toast('칸이 다 찼어요. 바꿀 칸의 ×를 눌러 비운 뒤 넣어 주세요.', true); return; }
    // 같은 분이 다른 칸에 있어도 그대로 둔다(한 분이 여러 칸을 맡을 수 있다). 이 칸에 있던 분만 바꾼다.
    DRAFT = DRAFT.filter(function (s) { return s.box !== box; });
    DRAFT.push({ approver: u, box: box });
    if (FILL_SRC[draftKey()]) FILL_SRC[draftKey()].edited = true;
    tidyDraft();
    APPR_SWAP = false;
    APPR_Q = '';                       // 다음 사람을 바로 칠 수 있게 비운다
    APPR_BOX = nextEmptyBox(box);
    renderSubmit();
    var q = $('apprQ');
    if (q) q.focus();
    else { var sb = $('btnSubmitAppr'); if (sb) sb.focus(); }       // 칸이 다 차면 「상신」으로
  }

  /** 주기별로 넣다 만 결재선(상신 창을 닫아도 남는다, 상신하면 비운다). */
  var DRAFT_KEEP = {};
  /** 주기별로 처음 미리 채운 출처 — { src: 'auto'(조직도) | 'prev'(이번 기간 반려·회수 건) | 'admin'(관리자 지정, part = 자동 칸이 섞임), notes: 비운 칸의 까닭 }. */
  var FILL_SRC = {};
  function renderSubmit() {
    // 창을 다시 그리면 돌고 있던 '검증 뒤 상신'은 무효다 — 화면의 버튼은 다시 「상신」으로 돌아가 있다.
    SUBMIT.token = null; SUBMIT.send = null;
    tidyDraft();
    DRAFT_KEEP[draftKey()] = DRAFT.slice();
    if (APPR_BOX && draftAt(APPR_BOX) && !APPR_SWAP) APPR_BOX = '';
    var KD = kindDef(SUB_KIND), KH = KD ? KD.submitHead() : null;
    // ★ 관리자는 TRIPS 에 전 직원 운행이 들어 있다. 예전에는 그 합계를 그대로
    //   보여 줘서 "1,842건 · ₩12,400,000" 같은 회사 전체 숫자가 자기 결재 금액인
    //   양 보였다. 서버가 굳히는 snapshot 은 본인 것이므로 화면만 거짓말했다.
    var T = KD ? null : totals(TRIPS.filter(function (t) { return t.username === myName(); }), { who: myName() });

    $('pTitle').textContent = KD ? KH.title : cycleName(CYC) + ' 상신';
    // 금액은 업무 운행만 — 건수도 업무 운행을 먼저 적는다(2026-10-16 5차: 머리 「7건」인데 문서의 일반업무 표는 5건이었다).
    $('pSub').textContent = KD ? KH.sub : cycleSpan(CYC) + ' · ' +
      (T.biz === T.n ? '운행 ' + n0(T.n) + '건' : '업무 운행 ' + n0(T.biz) + '건 · 전체 ' + n0(T.n) + '건') + ' · ' + won(T.cost);

    // ── 결재란: 운행기록부에 찍히는 모양 그대로 ──
    var h = '<div class="agrid" role="group" aria-label="결재란">' +
      '<div class="ag-lab" aria-hidden="true">결<br>재</div>' +
      '<div class="ag-cell me"><div class="ag-h">담당</div><div class="ag-b"><b>' + esc(ME.name || myName()) + '</b>' +
      '<small>' + esc(boxPos(myName()) || '본인') + '</small></div></div>';
    // 칸 머리 — 「센터·파트장」은 폰 칸에 한 줄로 안 들어가 가운뎃점 뒤에서 줄을 바꿀 수 있게 한다.
    var bh = function (b) { return esc(b).replace('·', '·<wbr>'); };
    APPR_BOXES.forEach(function (b) {
      var s = draftAt(b), on = APPR_BOX === b;
      if (s) {
        var u = personOf(s.approver);
        h += '<div class="ag-cell set' + (on ? ' on' : '') + '" data-agset="' + esc(b) + '" data-agbox="' + esc(b) + '" data-agwho="' + esc(s.approver) + '" role="button" tabindex="0" title="눌러서 다른 분으로 바꾸기 · × 는 칸 비우기"><div class="ag-h">' + bh(b) + '</div>' +
          '<div class="ag-b"><b>' + esc(u.name || s.approver) + '</b><small>' + esc(boxPos(s.approver)) + '</small>' +
          '<button class="ag-x" data-agclr="' + esc(b) + '" aria-label="' + esc(b) + ' 칸 비우기">' + ic('close', 11) + '</button></div></div>';
      } else {
        h += '<button class="ag-cell empty' + (on ? ' on' : '') + '" data-agbox="' + esc(b) + '" aria-pressed="' + (on ? 'true' : 'false') + '" ' +
          'aria-label="' + esc(b) + ' 칸 — 비어 있음(건너뜀). 눌러서 이름 넣기">' +
          '<span class="ag-h">' + bh(b) + '</span><span class="ag-b"><span class="ag-pick">' + (on ? '이름 입력' : '눌러서 넣기') + '</span></span></button>';
      }
    });
    // 대표이사 — 고르지 않는 칸. 사업부장이 올린 문서만 출력한 종이에 대표이사가 손으로 서명하는 빈칸, 나머지는 빗금.
    h += isDivHead(myName())
      ? '<div class="ag-cell hand" title="출력한 문서에 대표이사가 손으로 서명하는 칸이에요"><div class="ag-h">대표이사</div>' +
        '<div class="ag-b"><small>수기 서명</small></div></div>'
      : '<div class="ag-cell hand slash" title="전자 결재는 사업부장에서 끝나요"><div class="ag-h">대표이사</div><div class="ag-b"></div></div>';
    h += '</div>';
    // 결재 순서 — 채워진 칸을 왼쪽부터.
    h += '<div class="ag-order">' + (DRAFT.length
      ? '결재 순서: ' + DRAFT.map(function (s, i) { return (i + 1) + '. ' + esc(stepText(s)); }).join(' → ')
      : '아직 넣은 분이 없어요. 결재받을 칸을 누르고 이름을 넣어 주세요.') + '</div>';
    // 미리 채운 출처 + 비운 칸의 까닭(그 칸을 아직 비워 둔 동안만) — 2026-10-14
    var fs = FILL_SRC[draftKey()];
    if (fs) {
      // keep = 관리자가 지정한 분을 못 써서 자동으로 채운 칸 — 채워져 있어도 까닭을 남긴다(2026-10-14)
      var left = (fs.notes || []).filter(function (n) { return !n.box || n.keep || !draftAt(n.box); });
      h += '<div class="ag-fill" data-fill="' + esc(fs.src) + '">' + (fs.src === 'prev'
        ? '이번 기간에 반려·회수된 결재선을 불러왔어요.'
        : fs.src === 'last' ? '지난번 결재선을 불러왔어요.'
        : fs.src === 'admin' ? '관리자가 지정한 결재선을 불러왔어요.' + (fs.part ? ' 지정하지 않은 칸은 조직도로 채웠어요.' : '')
          : '조직도의 센터·파트장, 팀장, 사업부장 순서로 결재선을 미리 채웠어요.') +
        (fs.edited ? ' 그 뒤 직접 바꾼 칸이 있어요.' : ' 칸마다 바꾸거나 ×로 비울 수 있어요.') + '</div>' +   // 직접 고친 뒤에도 「미리 채웠습니다」만 남아 헷갈렸다(2026-10-15)
        (left.length ? '<div class="ag-notes">' + left.map(function (n) {
          return '<div data-agnote="' + esc(n.box) + '">' + ic('alert', 13) + '<span>' + esc(n.t) + '</span></div>';
        }).join('') + '</div>' : '');
    }

    // 이름 넣기 — 고른 칸에 들어간다.
    if (APPR_BOX) {
      // ★ 예전에는 61명짜리 <select> 였다. 마감일에 그 목록을 훑어 고르는 것은
      //   할 짓이 아니다. 이름을 두어 글자만 쳐도 좁혀지게 바꿨다.
      //   부서·직급으로도 찾힌다("광역", "팀장").
      h += '<div class="aadd">' +
        '<input id="apprQ" autocomplete="off" aria-label="' + esc(APPR_BOX) + ' 칸에 넣을 분 찾기" placeholder="' + esc(APPR_BOX) +
        ' 칸에 넣을 분의 이름을 쓰거나 조직도에서 고르세요" value="' + esc(APPR_Q) + '">' +
        '<div class="acand" id="apprCand">' + apprCandHtml() + '</div></div>';
    }

    // 지난번 결재선(새 칸 모양으로 올린 것만) — 지금 칸과 다를 때만 버튼을 보인다(미리 채운 것과 같으면 누를 까닭이 없다).
    var prev = previousSteps();
    var sameLine = function (x, y) { return JSON.stringify(x.map(function (s) { return s.box + ':' + s.approver; })) === JSON.stringify(y.map(function (s) { return s.box + ':' + s.approver; })); };
    if (prev && !sameLine(prev, DRAFT)) {
      // 결재선이 길면 창 폭 안에서 줄을 바꾼다(CSS #btnPrevLine) — 「이름 직책 (칸)」 한 덩어리는 끊지 않고 「→」 앞뒤에서만(2026-10-21)
      var nw = function (t) { return '<span style="white-space:nowrap">' + esc(t) + '</span>'; };
      h += '<div style="margin-top:10px"><button class="btn sm" id="btnPrevLine">' + ic('list', 13) + '<span>' + nw('지난번 결재선 불러오기 —') + ' ' +
        prev.map(function (s) { return nw(stepText(s)); }).join(' → ') + '</span></button></div>';
    }
    h += '<div class="anote" style="margin-top:10px">결재받을 <b>칸을 누르고 이름</b>을 넣으세요. <b>비워 둔 칸은 빗금(/)</b>으로 찍히고 건너뛰어요. ' +
      '결재는 왼쪽 칸부터 진행되고 <b>사업부장에서 끝나요</b>' +
      (isDivHead(myName()) ? '. 대표이사 칸은 출력한 문서에 대표이사가 손으로 서명해요.</div>' : '. 대표이사 칸도 빗금이에요.</div>');

    // 상신 의견(선택, 2026-10-21 사용자) — 결재 창의 「의견」 칸과 같은 모양. 보낸 글은 서버가 이 상신의 요약(snapshot.note)에 굳히고
    //   결재선 모두가 결재함에서 본다. 결재선을 고쳐 창을 다시 그려도 적던 글은 그대로(SUB_NOTE). 다시 상신이면 그때 의견을 불러와 채운다.
    var nk = myName() + '|' + draftKey();
    if (SUB_NOTE[nk] === undefined) {
      // 이번 기간에 반려·회수된 내 건의 의견(결재선과 달리 예전 칸 모양 건이어도 불러온다)
      var nb = KD ? KD.mine(CYCKEY()) : myAppr();
      var nprev = nb && (nb.status === 'rejected' || nb.status === 'withdrawn') && nb.snapshot && typeof nb.snapshot.note === 'string' ? nb.snapshot.note : '';
      SUB_NOTE[nk] = nprev; SUB_NOTE_PREV[nk] = !!nprev;
    }
    h += '<div class="frow" style="border:0;padding-bottom:0"><label class="flab" for="subNote">의견</label><div class="fbody">' +
      '<textarea class="inp" id="subNote" rows="3" maxlength="300" placeholder="결재자에게 남길 말(선택). 예: 9/30 통행료 두 장은 왕복이에요">' +
      esc(SUB_NOTE[nk]) + '</textarea>' +
      '<div class="fhint">' + (SUB_NOTE_PREV[nk] ? '지난번 상신 때 남긴 의견을 불러왔어요. 고치거나 지울 수 있어요. ' : '') +
      '결재선의 모든 결재자가 결재함에서 봐요(300자까지).</div></div></div>';

    var warn = [];
    if (KD) warn = KH.warn || [];
    else {
    if (T.unk) warn.push('통행료 미확정 ' + n0(T.unk) + '건은 0원으로 정산돼요.');
    // ★ 상신은 **내 운행**을 올리는 것이다. audit() 는 지금 화면 범위(관리자면 전 직원)를 봐서,
    //   '전체 마감 현황 → 내 것 결재 상신' 에서 회사 전체 건수가 경고로 떴다(2026-09-23 검증로봇).
    //   합계를 본인 것으로 고친 것(paintPills)과 같은 규칙.
    var mineU = myName();
    var A = auditOf(ALL_TRIPS.filter(function (t) { return t.username === mineU; }))
      .filter(function (f) { return f.sev === 'bad' && f.n > 0; });
    if (A.length) warn.push('점검에서 걸린 기록이 ' + A.reduce(function (s, f) { return s + f.n; }, 0) + '건 있어요.');
    }
    if (warn.length) {
      h += '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(warn.map(endDot).join(' ')) + '</span></div>';
    }
    h += '<div class="anote"><b>지금 자료로 결재가 진행</b>돼요. 상신한 뒤에 이 기간의 ' +
      // 종류마다 무엇이 잠기는지(lockNoun, 조사까지) — 없으면 예전 그대로 「경비를」(개인경비 글자 그대로). 법인카드 「카드 내역을」.
      (KD ? esc(KD.lockNoun || '경비를') : '운행·영수증을') + ' 고치려면 <b>먼저 회수해야 해요</b>. ' +
      '상신을 누르면 먼저 검증하고, 맞지 않는 곳이 있으면 올리기 전에 알려 드려요.</div>';

    $('pBody').innerHTML = h;
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnSubmitAppr">상신</button>';
    $('panel').classList.add('open');
  }

  /** 서버 오류 글 — error 가 약속된 코드(STALE 등 영문 대문자)면 사람 말(message)을, 아니면 error 글 그대로(2026-10-20). */
  function apiErrText(j, status) {
    j = j || {};
    var e = j.error == null ? '' : String(j.error), m = j.message == null ? '' : String(j.message);
    var t = /^[A-Z][A-Z0-9_]+$/.test(e) && m ? m : (e || m);
    // 서버가 영어 기본 글만 주면(「Internal Server Error」 등) 우리말로 — 상신 500 이 영어로 떴다(2026-10-20 V3 U7). 상태 번호는 괄호에.
    if (t && !/[가-힣]/.test(t)) t = '서버에서 처리하지 못했어요' + (status ? '(오류 ' + status + ')' : '') + '. 잠시 후 다시 해 주세요.';
    return t;
  }
  /** 낡은 결재 화면(409 STALE, 2026-10-20 서버·웹 약속) — 서버 문구를 띄우고 창을 닫은 뒤 그 종류의 결재 목록을 새로 받아 다시 그린다.
   *  (그 사이 상신자가 회수하고 금액을 바꿔 다시 상신했다 — 결재함을 다시 열어 새 문서를 보고 결재하게.) */
  /** STALE 로 창이 닫힐 때 적던 반려·정정 사유(종류:번호:동작 → 글) — 같은 문서의 같은 창을 다시 열면 채운다(2026-10-20 V3 B8 — 창이 닫히며 사유가 사라졌다). 처리되면 지운다. */
  var APPR_KEEP = {};
  function apprStale(payload, j) {
    // 적던 사유를 맡아 둔다 — 같은 문서의 같은 창을 다시 열면 채운다(V3 B8). 바뀌기 전 금액도 기억한다(새로 읽은 뒤 무엇이 바뀌었는지 알린다 — V3 U6)
    var kk = (payload && payload.kind || 'd') + ':' + (payload && payload.id);
    var why = String(($('apprWhy') || {}).value || '').trim();
    if (why && payload && payload.action) APPR_KEEP[kk + ':' + payload.action] = why;
    var a0 = payload && payload.id ? apprFind(+payload.id, (payload && payload.kind) || '') : null, c0 = a0 && a0.snapshot ? a0.snapshot.cost : null;
    closePanel();
    TRIP_CACHE = {};
    var kd = kindDef(payload && payload.kind);
    // 알림 — 결재함은 이미 새로 읽었다(예전 서버 글 「새로 고쳐 다시 열어 주세요」는 실제와 달랐다, 2026-10-20 V3 U6) · 바뀐 금액 · 맡아 둔 사유
    var say = function (fresh) {
      var a1 = fresh ? apprFind(+payload.id, (payload && payload.kind) || '') : null, c1 = a1 && a1.snapshot ? a1.snapshot.cost : null;
      var amt = c0 != null && c1 != null ? (Number(c0) !== Number(c1) ? '(전 금액 ' + won(c0) + ' · 새 금액 ' + won(c1) + ')' : '(금액은 그대로 ' + won(c1) + ')') : '';
      toast('그 사이 문서가 바뀌었어요' + amt + (fresh ? '. 결재함을 새로 불러왔으니 카드를 다시 열어 확인한 뒤 결재해 주세요.' : '. 결재함을 다시 불러올게요.') +
        (why ? ' 적던 사유는 다시 열면 그대로 있어요.' : ''), true);
    };
    (kd ? Promise.resolve(kd.reload ? kd.reload() : null)
      : fetchAll('/rest/v1/driving_approvals?select=*&order=submitted_at.desc,id.desc').then(function (rows) { APPR = rows || []; }))
      .then(function () { paintPills(); render(); say(true); }, function (e) {
        if (e && e.authGone) { toast('로그인이 만료됐어요. 다시 로그인해 주세요.', true); setTimeout(signOut, 900); return; }
        say(false);
        loadAll();
      });
  }
  /** 유류단가가 어떻게 바뀌었는지 한 줄 — 하나면 「191 → 186원」, 여럿이면 지역(분기가 둘 이상이면 분기도)을 붙인다(2026-10-20 RATE_CHANGED). */
  function rateChangeText(ch) {
    ch = (Array.isArray(ch) ? ch : []).filter(function (c) { return c && isFinite(Number(c.from)) && isFinite(Number(c.to)); });
    if (!ch.length) return '';
    var qs = {}; ch.forEach(function (c) { qs[c.quarter] = 1; });
    var manyQ = Object.keys(qs).length > 1, many = ch.length > 1;
    return ch.slice(0, 4).map(function (c) {
      var q = String(c.quarter == null ? '' : c.quarter).split('-');
      return (manyQ && q.length === 2 ? q[1] + '분기 ' : '') + (many && c.region ? c.region + ' ' : '') + n0(c.from) + '원에서 ' + n0(c.to) + '원으로';
    }).join(' · ') + (ch.length > 4 ? ' 외 ' + n0(ch.length - 4) + '곳' : '');
  }
  /** 상신 뒤 유류단가가 바뀌었다(409 RATE_CHANGED, 2026-10-20 서버·웹 약속 — 운행일지 승인) — 승인 창 아랫줄에서 묻는다:
   *  「상신 뒤 유류단가가 바뀌었습니다(191 → 186원). 이대로 승인하면 옛 단가로 정산됩니다.」 [반려하기] [그래도 승인].
   *  「그래도 승인」은 같은 요청에 ack_rate_change:true 를 붙여 다시 보내고, 「반려하기」는 이 건의 반려 창을 연다(사유를 미리 적어 둠).
   *  그 승인 창이 열려 있지 않으면 false — 부른 쪽이 오류 글로 알린다. */
  var RATE_ASK = null;
  function apprRateAsk(payload, okMsg, j) {
    var go = $('btnApprGo');
    if (!go || !$('panel').classList.contains('open') || go.dataset.act !== 'approve' || +go.dataset.id !== +payload.id ||
      (go.dataset.kind || '') !== (payload.kind || '')) return false;
    var what = rateChangeText(j.changes);
    var head = endDot(String(j.message || '상신 뒤 유류단가가 바뀌었어요').replace(/[.\s]+$/, '') + (what ? '(' + what + ')' : ''));
    RATE_ASK = { payload: payload, okMsg: okMsg, head: head };
    $('pFoot').innerHTML = '<span class="st subwarn warn" data-rateask>' + esc(head) + '<br>이대로 승인하면 옛 단가로 정산돼요.</span>' +
      '<button class="btn" id="btnRateReject">반려하기</button>' +
      '<button class="btn pri" id="btnRateGo">그래도 승인</button>';
    var b = $('btnRateGo'); if (b) { try { b.focus(); } catch (e) { } }
    // 금액 차이도(2026-10-20 V3 다듬기 — 단가만 보여 얼마가 달라지는지 몰랐다): 서버가 함께 주는 fuel_from(상신 때 단가로 센 업무 운행 유류비)·
    //   fuel_to(지금 단가로 센 것, 둘 다 반올림 — _shared/driving-freeze.ts rateChanges)의 차이. 없거나 같으면 예전처럼 단가만.
    var f0 = j.fuel_from, f1 = j.fuel_to, fd = typeof f0 === 'number' && typeof f1 === 'number' && isFinite(f0) && isFinite(f1) ? f1 - f0 : 0;
    var fel = fd ? document.querySelector('#pFoot [data-rateask]') : null;
    if (fel) {
      fel.setAttribute('data-ratediff', String(fd));
      fel.innerHTML = esc(head) + '<br>이대로 승인하면 옛 단가로 정산돼요. 새 단가로 계산하면 유류비가 ' + won(Math.abs(fd)) + ' ' + (fd < 0 ? '적어요' : '많아요') + '.';
    }
    return true;
  }
  function callAppr(payload, okMsg) {
    return apiRetry('/functions/v1/approval-act', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j, st: r.status }; }); })
      .then(function (res) {
        if (!res.ok || !res.j || !res.j.ok) {
          var ej = res.j || {};
          // 낡은 결재 화면 — 창을 닫고 결재함을 새로 읽는다(상신은 해당 없음: 결재 건 id 가 있는 동작만)
          if (ej.error === 'STALE' && payload && payload.id) { apprStale(payload, ej); return 'stale'; }
          // 상신 뒤 유류단가가 바뀜 — 이대로 승인할지 반려할지 승인 창에서 묻는다
          if (ej.error === 'RATE_CHANGED' && payload && payload.action === 'approve' && !payload.ack_rate_change &&
            apprRateAsk(payload, okMsg, ej)) return 'ask';
          toast(apiErrText(ej, res.st) || '처리하지 못했어요.', true); return false;
        }
        // 방금 결재한 건(승인·반려·승인 취소)은 결재함 「그 밖의 건」 기간 거르기와 상관없이 보이게 — 9월분을 10월분 화면에서
        //   승인하면 카드가 사라져 「승인 취소·반려」를 못 찾았다(2026-10-19 로봇)
        var acted = payload && payload.id && /^(approve|reject|recall_reject)$/.test(payload.action || '');
        if (acted) INBOX_JUST = (payload.kind || 'd') + ':' + payload.id;
        // 처리된 문서의 맡아 둔 사유(STALE, V3 B8)는 지운다
        if (payload && payload.id) Object.keys(APPR_KEEP).forEach(function (x) { if (x.indexOf((payload.kind || 'd') + ':' + payload.id + ':') === 0) delete APPR_KEEP[x]; });
        if (acted) inboxNextMark(payload);    // 결재함 내 차례에서 승인·반려했으면 다음 문서를 바로 연다(2026-10-20 D2)
        var midOk = payload && payload.action === 'approve' && res.j.row && res.j.row.status === 'submitted';
        toastOk(endDot(res.j.message || okMsg || '처리했어요.') +
          (midOk ? ' 다음 결재자가 결재하기 전까지는 ‘그 밖의 건’에서 승인을 취소할 수 있어요.' : '') +
          (res.j.verify && EXT.sumText ? ' 검증: ' + EXT.sumText(res.j.verify) + '.' : ''), res.j.warning);
        closePanel();
        TRIP_CACHE = {};                   // 잠금 상태가 바뀌었다 — 다른 주기 캐시도 믿지 않는다
        // 개인경비 결재 건이면 그 모듈이 자기 결재 목록을 다시 받는다.
        var kd = kindDef(payload && payload.kind);
        if (kd) {
          return Promise.resolve(kd.reload ? kd.reload() : null)
            .then(function () { paintPills(); render(); return true; })
            .catch(function () { toast('처리는 됐어요. 목록을 다시 불러올게요.'); loadAll(); return true; });
        }
        // 처리는 이미 끝났다. 뒤이은 목록 재조회가 실패해도 '연결 실패' 로 오인시키지 않는다 —
        // 그러면 사용자가 상신을 다시 눌러 헷갈린다. 전체를 다시 불러오게 한다.
        return fetchAll('/rest/v1/driving_approvals?select=*&order=submitted_at.desc,id.desc')
          .then(function (rows) { APPR = rows || []; paintPills(); render(); return true; })
          .catch(function (e) {
            if (e && e.authGone) { toast('로그인이 만료됐어요. 다시 로그인해 주세요.', true); setTimeout(signOut, 900); return true; }
            toast('처리는 됐어요. 목록을 다시 불러올게요.'); loadAll(); return true;
          });
      }).catch(function () { toast('서버에 연결하지 못했어요. 잠시 후 다시 해 주세요.', true); return false; });
  }

  /**
   * 승인·반려·회수 확인 창. 결재자는 여기서 금액 요약·검증 결과를 보고, 결재 문서(PDF)를 열어 본 뒤 누른다.
   * 예전에는 카드의 [승인]이 한 번 클릭으로 확정됐고 내역을 볼 길이 없었다.
   */
  function openApprAct(act, id, kind) {
    var a = apprFind(id, kind), kd = kindDef(kind);
    if (!a) { toast('결재 건을 찾지 못했어요. 새로고침해 주세요.', true); return; }
    var s = a.snapshot || {};
    var cname = keyName(a.cycle, a.cycle);
    if (kd && kd.cycName) cname = kd.cycName(a);
    var kv = function (k, v) { return '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; };
    var sumHtml = kd ? (kd.sumHtml ? kd.sumHtml(a) : '') : s.trips != null
      ? kv('운행', esc(snapTrips(s))) +
        kv('유류비', won(s.fuel)) +
        kv('통행료', won(s.toll) + (s.toll_unknown ? ' <span class="st warn">미확정 ' + n0(s.toll_unknown) + '건은 0원</span>' : '') +
          (s.ev_toll ? ' <span class="dim">영수증 ' + won(s.ev_toll) + ' 포함</span>' : '')) +
        kv('주차비', won(s.parking) + (s.ev_parking ? ' <span class="dim">영수증 ' + won(s.ev_parking) + ' 포함</span>' : '')) +
        // 금액 규칙 v3(version 3) — 운행 없는 날의 영수증은 정산에서 뺐다
        (Number(s.no_trip_n) > 0 ? kv('제외', '<span class="st warn">운행 없는 영수증 ' + n0(s.no_trip_n) + '장 ' + won(s.no_trip_amt || 0) + ' 정산 제외</span>') : '') +
        kv('합계', '<b style="font-size:15px">' + won(s.cost) + '</b>') +
        ((s.rate_miss || []).length ? kv('주의', '<span class="st bad">유류단가 미등록 · 기본 단가 159원/km로 계산</span>') : '')
      : '';
    APPR_BACK = null; RATE_ASK = null;
    // 결재 중인 건은 아래 결재 요약(청구 금액·운행·검증)이 같은 숫자를 또 보여 준다 — 위 줄은 뺀다(2026-10-16 3차: 운행·유류비·합계가 두 번).
    if (act !== 'withdraw' && a.status === 'submitted' && s.cost != null) sumHtml = '';
    // 상신 때 검증 결과(고정본 요약)를 이 창에서 직접 받는다 — 관리자 「결재 완료 출력」 등 카드가 받아 두지 않은 화면에서
    //   열면 「검증 결과를 불러오는 중…」에 멈춰 있었다. 받으면(못 받아도) 이 창을 다시 그린다(적던 사유는 그대로).
    var wantS = act === 'withdraw' ? null : kd ? kd.wantSummaries : EXT.wantSummaries;
    if (wantS) wantS([a.id], function () {
      var g = $('btnApprGo');
      if (!g || !$('panel').classList.contains('open') || g.dataset.act !== act || +g.dataset.id !== +id) return;
      var w = $('apprWhy') ? $('apprWhy').value : '';
      openApprAct(act, id, kind);
      if ($('apprWhy')) $('apprWhy').value = w;
    });
    var title = act === 'approve' ? '승인' : act === 'reject' ? '반려' : act === 'force_reject' ? '관리자 반려'
      : act === 'reopen' ? '정정 열기' : act === 'recall_reject' ? '승인 취소·반려' : '상신 회수';
    // 승인 취소·반려(2026-10-19) — 차례가 없어지는 다음 분 이름을 안내에 적는다
    var rcNext = act === 'recall_reject' ? (a.steps || []).filter(function (x) { return x.seq === a.cur_seq; })[0] : null;
    var body = '';
    if (act === 'withdraw') {
      body = '<div class="anote" style="margin-top:0">상신을 회수할까요? 결재선은 그대로 남고, <b>' +
        (kd ? (kd.withdrawText || '이 기간의 경비를 다시 고칠 수 있게') : '이 기간의 운행·영수증을 다시 고칠 수 있게') + '</b> 돼요. ' +
        '고친 뒤 다시 상신하면 그때 자료로 결재가 진행돼요.</div>' + apprTrack(a);
    } else {
      body = sumHtml + apprTrack(a) + (kd ? (kd.extra ? kd.extra(a) : '') : (EXT.apprExtra ? EXT.apprExtra(a) : '')) +
        // 지금까지의 의견(담당 상신 의견 → 앞 결재자 승인 의견) — 「의견」 칸 바로 위(2026-10-21)
        opinionsHtml(a) +
        '<div class="frow" style="border:0;padding-bottom:0"><label class="flab" for="apprWhy">' +
        (act === 'approve' ? '의견' : act === 'reopen' ? '정정 사유' : '반려 사유') + '</label><div class="fbody">' +
        '<textarea class="inp" id="apprWhy" rows="3" maxlength="500" placeholder="' +
        (act === 'approve' ? '남기면 상신자가 볼 수 있어요(선택).' : '무엇을 고쳐야 하는지 적어 주세요. 상신자에게 그대로 전달돼요.') +
        // 그 사이 문서가 바뀌어(STALE) 창이 닫혔을 때 적던 사유 — 다시 열면 그대로 채운다(2026-10-20 V3 B8)
        '">' + esc(APPR_KEEP[(kind || 'd') + ':' + a.id + ':' + act] || '') + '</textarea>' +
        (APPR_KEEP[(kind || 'd') + ':' + a.id + ':' + act] ? '<div class="fhint" data-whykept>적던 사유를 다시 채웠어요. 바뀐 문서를 확인한 뒤 보내 주세요.</div>' : '') +
        '</div></div>' +
        '<div class="anote">' + (act === 'recall_reject'
          ? '<b>승인을 취소하고 상신자에게 반려해요.</b> 결재란의 내 이름과 날짜가 지워지고 문서는 반려 상태가 돼요. ' +
            (rcNext ? '다음 결재자 ' + esc(stepWho(rcNext) || rcNext.approver) + ' 님은 결재하지 않아도 돼요. ' : '') +
            '상신자가 고쳐서 다시 상신하면 결재선을 처음부터 다시 거쳐요.'
          : act === 'approve'
          ? '승인하면 결재란에 <b>이름과 날짜</b>가 찍혀요. 위 금액과 검증 결과는 <b>상신할 때의 값</b>이에요. ' +
            '마지막 결재자가 승인하면 결재 완료 문서를 다운로드할 수 있어요.'
          : act === 'reopen'
            ? '결재가 끝난 건을 <b>정정할 수 있게 다시 열어요</b>. 상신자가 고친 뒤 다시 상신하면 결재선을 처음부터 다시 거쳐요. ' +
              '지금의 결재 완료 문서와 결재선, 금액은 <b>이력에 그대로 남고</b>, 누가 왜 열었는지도 기록돼요.'
          : act === 'force_reject'
            ? '결재자가 자리에 없어 결재가 멈췄을 때 쓰는 <b>관리자 권한 반려</b>예요. 승인은 대신할 수 없어요. ' +
              '반려하면 상신자가 고쳐서 다시 상신할 수 있고, 누가 반려했는지 기록에 남아요.'
            : '반려하면 상신자가 자료를 고쳐 다시 상신할 수 있어요.') + '</div>';
    }
    if (act === 'approve' || act === 'reject') body += inboxNextHint(id, kind);   // 「다음 문서가 바로 열립니다」(2026-10-20 D2, 결재함에서 연 창만)
    openPanel(nameOf(a.username) + ' · ' + (kd ? kd.tag + ' ' : '') + title, cname,
      body,
      // 아래 단추 차례 = [동작] [취소] — 동작 단추가 왼쪽, 취소가 오른쪽(2026-10-20 사용자 「승인버튼하고 취소버튼하고 바꿔줬으면 해」).
      //   DOM 차례가 곧 Tab 차례(의견 칸 → 동작 → 취소). 높이·색·Esc(닫기)는 그대로.
      // data-sub — 이 창을 그린 결재 행의 상신 시각(submitted_at 글자 그대로). 보낼 때 실어 서버가 낡은 화면인지 본다(2026-10-20 STALE)
      '<span style="flex:1"></span><button class="btn pri" id="btnApprGo" data-act="' + esc(act) + '" data-id="' + a.id + '"' + (kd ? ' data-kind="' + esc(kind) + '"' : '') +
      (a.submitted_at ? ' data-sub="' + esc(a.submitted_at) + '"' : '') + '>' +
      (act === 'approve' ? '승인' : act === 'withdraw' ? '회수' : act === 'reopen' ? '정정으로 열기' : act === 'recall_reject' ? '승인 취소하고 반려' : '반려') + '</button>' +
      // 승인 취소·반려 창에서는 창 닫기를 「닫기」로 — 「취소」가 옆 단추(승인 취소)와 헷갈렸다(2026-10-19 로봇)
      '<button class="btn" data-close>' + (act === 'recall_reject' ? '닫기' : '취소') + '</button>');
    if (act !== 'approve' && $('apprWhy')) $('apprWhy').focus();
  }

  /* ── 결재함 ── */
  function viewInbox() {
    if (!LOADED) return head('결재함') + skeleton();
    // ★ 결재함은 갈래마다 따로(2026-10-08 사용자 결정) — 개인경비 갈래에서는 개인경비 문서만, 운행일지 갈래에서는
    //   운행일지 문서만. 다른 갈래에 문서가 있으면 한 줄로 그리 가는 길만 둔다(inboxSplit).
    //   운전 안 하는 사람(개인경비 갈래 고정)은 결재선에 든 운행일지 문서를 아래 따로 모아 보여 준다 — 숨기면 결재가 멈춘다.
    var SP = inboxSplit();
    var mine = SP.mine;
    // ★ 결재함은 개인 화면이다. 관리자는 APPR 에 전 직원 결재건이 들어 있어,
    //   거르지 않으면 남의 결재 진행상황과 금액이 '그 밖의 건' 으로 나열됐다.
    //   내가 올린 것과 내가 결재선에 든 것만 남긴다.
    var others = SP.others;

    // 예전에는 40건에서 말없이 잘랐다(건수는 전체로 적어 놓고). 이제는 상태로 좁히고, 넘치면 넘친다고 말한다.
    var st = INBOX_F;
    // ── 그 밖의 건 거르기(2026-10-14 사용자, 세 결재함 공통) ──
    //   기본은 위에서 고른 기간(몇월분) 것만. 「전체 기간」·상신일(시작~끝)·상신한 사람 이름으로도 찾는다. 상태 칩은 맨 마지막.
    var cyk = CYCKEY(), q = INBOX_Q.replace(/\s+/g, '');
    var dayOf = function (a) { var t = Date.parse(a.submitted_at || ''); return isFinite(t) ? new Date(t + 9 * 3600e3).toISOString().slice(0, 10) : ''; };
    var base = others.filter(function (a) {
      if (!INBOX_ALLCYC && a.cycle !== cyk && (kindOf(a) || 'd') + ':' + a.id !== INBOX_JUST) return false;
      if (q && String(nameOf(a.username) || '').replace(/\s+/g, '').indexOf(q) < 0) return false;
      var d = dayOf(a);
      if (INBOX_D1 && (!d || d < INBOX_D1)) return false;
      if (INBOX_D2 && (!d || d > INBOX_D2)) return false;
      return true;
    });
    // 고른 상태 칩이 0건이 되면 칩이 사라진다 — 거르기만 남아 「해당하는 건이 없습니다」가 되지 않게 「전체」로 푼다
    //   (2026-10-16 4차: 법인카드 결재함에서 반려 건을 다시 상신한 뒤 등. 세 결재함 공통).
    if (st !== 'all' && !base.some(function (a) { return a.status === st; })) st = INBOX_F = 'all';
    var shown = base.filter(function (a) { return st === 'all' || a.status === st; });
    var CAP = 80;
    // 카드에 붙는 검증 요약·결재 문서 버튼은 고정본에서 온다 — 보이는 건만 한 번에 물어본다.
    // 번호는 종류마다 따로 매긴다 — 운행일지 것은 운행일지 모듈에, 개인경비 것은 개인경비 모듈에 묻는다.
    var vis = mine.concat(shown.slice(0, CAP), SP.ndMine, SP.ndOthers.slice(0, 20));
    if (EXT.wantSummaries) {
      EXT.wantSummaries(vis.filter(function (a) { return !kindOf(a); }).map(function (a) { return a.id; }));
    }
    Object.keys(EXT.kinds).forEach(function (k) {
      var kd = EXT.kinds[k];
      if (kd.wantSummaries) kd.wantSummaries(vis.filter(function (a) { return kindOf(a) === k; }).map(function (a) { return a.id; }));
    });

    var nTurn = mine.length + SP.ndMine.length;
    INBOX_ORDER = [];          // 내 차례 문서가 보이는 차례(확인 필요 → 이상 없음) — 승인·반려 뒤 다음 문서를 고를 때 쓴다(inboxNextMark)
    // 두 묶음(내 차례 · 운행일지 결재 — 내 차례)의 차례를 먼저 다 채운다 — 카드 아래 「다음 문서」 안내가 승인 창 안내(inboxNextHint)와 같고,
    //   빨간 「승인」(맨 앞 카드 하나)이 화면에 하나다(2026-10-20 V3 다듬기)
    [mine, SP.ndMine].forEach(function (l) { turnOrder(l).forEach(function (k) { if (INBOX_ORDER.indexOf(k) < 0) INBOX_ORDER.push(k); }); });
    var h = head(SP.split ? MODE_NAME[SP.mode] + ' 결재함' : '결재함',
      nTurn ? '내 차례 ' + nTurn + '건' : '내 차례인 건이 없어요');
    // 다른 갈래로 가는 줄 — 갈래마다 한 줄(2026-10-09 세 갈래). 그쪽에 내 차례가 있으면 건수를, 없으면 문서가 있다는 것만.
    SP.other.forEach(function (o) {
      var oName = MODE_NAME[o.mode];
      h += '<button type="button" class="ibswitch' + (o.turn ? ' hot' : '') + '" data-inboxmode="' + o.mode + '">' +
        ic(MODE_ICO[o.mode], 15) + '<span>' + (o.turn
          ? oName + ' 결재 <b>' + n0(o.turn) + '건</b>은 ' + oName + ' 결재함에서'
          : oName + ' 결재 문서는 ' + oName + ' 결재함에서') + '</span>' + ic('chev', 14) + '</button>';
    });
    if (mine.length) {
      h += sect('내 차례', mine.length + '건', '', '<div class="panel ibturn ibcards">' + turnGroups(mine) + '</div>');
    } else if (!SP.ndMine.length && isApproverMe()) {
      // 결재선에 든 적이 없는 사람(사원)에게는 큰 빈 상자를 보이지 않는다 — 머리글의 「내 차례인 건이 없습니다」로 충분(2026-10-15 2차)
      h += blank('결재할 문서가 없어요.', '다른 분 차례이거나 아직 상신 전이에요.', 'check');
    }
    if (SP.ndMine.length) {
      h += sect('운행일지 결재 — 내 차례', SP.ndMine.length + '건', '',
        '<div class="fhint" style="margin:-4px 0 10px">운행일지를 쓰지 않아도, 결재선에 든 운행일지는 여기서 결재해요.</div>' +
        '<div class="panel ibturn ibcards">' + turnGroups(SP.ndMine) + '</div>');
    }
    if (others.length) {
      var cnt = function (k) { return base.filter(function (a) { return a.status === k; }).length; };
      var chips = '<div class="seg">' +
        [['all', '전체', base.length], ['submitted', '결재 중', cnt('submitted')], ['approved', '완료', cnt('approved')],
          ['rejected', '반려', cnt('rejected')], ['withdrawn', '회수', cnt('withdrawn')]]
          .filter(function (c) { return c[0] === 'all' || c[2] > 0; })
          .map(function (c) {
            return '<button class="' + (st === c[0] ? 'on' : '') + '" aria-pressed="' + (st === c[0] ? 'true' : 'false') + '" data-inboxf="' + c[0] + '">' + c[1] +
              ' <span class="c">' + n0(c[2]) + '</span></button>';
          }).join('') + '</div>';
      var filtered = INBOX_ALLCYC || q || INBOX_D1 || INBOX_D2;
      var fbar = '<div class="bar ibflt">' +
        '<div class="seg" role="group" aria-label="기간">' +
          '<button class="' + (!INBOX_ALLCYC ? 'on' : '') + '" aria-pressed="' + (!INBOX_ALLCYC) + '" data-ibcyc="0">' + esc(cycleName(CYC)) + '</button>' +
          '<button class="' + (INBOX_ALLCYC ? 'on' : '') + '" aria-pressed="' + (!!INBOX_ALLCYC) + '" data-ibcyc="1">전체 기간</button></div>' +
        '<label class="field">' + ic('search', 14) +
          '<input id="ibQ" aria-label="상신한 사람 이름" placeholder="상신한 사람 이름" value="' + esc(INBOX_Q) + '"></label>' +
        '<label class="field ibdate"><span class="dim">상신일</span>' +
          '<input type="date" id="ibD1" aria-label="상신일 시작" value="' + esc(INBOX_D1) + '">' +
          '<span class="dim">~</span><input type="date" id="ibD2" aria-label="상신일 끝" value="' + esc(INBOX_D2) + '"></label>' +
        (filtered ? '<button class="btn sm" data-ibreset>' + ic('close', 12) + '조건 지우기</button>' : '') +
        '</div>';
      h += sect('그 밖의 건', shown.length + '건', chips, fbar +
        '<div class="panel ibcards">' + (shown.length ? shown.slice(0, CAP).map(apprCard).join('')
          : '<div class="blank"><div class="t">해당하는 건이 없어요.</div>' +
            (!INBOX_ALLCYC ? '<div class="d">다른 달 문서는 ‘전체 기간’을 눌러 보세요.</div>' : '') + '</div>') + '</div>' +
        (shown.length > CAP ? '<div class="fhint" style="margin-top:8px">최근 ' + CAP + '건만 보여요. 상태로 좁혀 보세요(전체 ' +
          n0(shown.length) + '건).</div>' : ''));
    }
    if (SP.ndOthers.length) {
      h += sect('운행일지 결재 기록', SP.ndOthers.length + '건', '',
        '<div class="panel ibcards">' + SP.ndOthers.slice(0, 20).map(apprCard).join('') + '</div>' +
        (SP.ndOthers.length > 20 ? '<div class="fhint" style="margin-top:8px">최근 20건만 보여요.</div>' : ''));
    }
    return h;
  }
  /* ── 결재함 갈래 나누기(2026-10-08 · 2026-10-09 세 갈래) ──
     'd' 운행일지 = 운행일지 결재 건(종류 없음) · 확장 종류는 그 모듈이 정한 갈래(개인경비 'x' · 법인카드 'c').
     확장 모듈이 없으면 나누지 않는다. 운전 안 하는 사람은 'd' 갈래가 없다(운행일지 건은 아래 따로 모은다). */
  var MODE_NAME = { d: '운행일지', x: '개인경비', c: '법인카드' }, MODE_ICO = { d: 'car', x: 'won', c: 'card' };
  function modeOfAppr(a) { var kd = kindDef(kindOf(a)); return kd ? (kd.mode || 'x') : 'd'; }
  function inboxMode() { var m = navModeOf(VIEW); return noDriving() && m === 'd' ? 'x' : m; }
  function inMode(a, mode) { return modeOfAppr(a) === mode; }
  function involvesMe(a) {
    var me = myName();
    return a.username === me || (a.steps || []).some(function (s) { return s && s.approver === me; });
  }
  /** 결재함이 그릴 것 — 지금 갈래의 내 차례·그 밖의 건, 다른 갈래 건수, 운전 안 하는 사람의 운행일지 건. */
  function inboxSplit() {
    var all = inbox(), split = Object.keys(EXT.kinds).length > 0, mode = split ? inboxMode() : 'd', nd = split && noDriving();
    var rel = allAppr().filter(function (a) { return all.indexOf(a) < 0 && involvesMe(a); });
    if (!split) return { split: false, mode: mode, mine: all, others: rel, ndMine: [], ndOthers: [], other: [] };
    var modes = ['d'];
    Object.keys(EXT.kinds).forEach(function (k) { var m = EXT.kinds[k].mode || 'x'; if (modes.indexOf(m) < 0) modes.push(m); });
    return {
      split: true, mode: mode,
      mine: all.filter(function (a) { return inMode(a, mode); }),
      others: rel.filter(function (a) { return inMode(a, mode); }),
      ndMine: nd ? all.filter(function (a) { return inMode(a, 'd'); }) : [],
      ndOthers: nd ? rel.filter(function (a) { return inMode(a, 'd'); }) : [],
      // 다른 갈래(운전 안 하는 사람은 운행일지 갈래를 빼고 — 그 건은 ndMine·ndOthers 로 이 화면에 있다). 건이 있는 갈래만.
      other: modes.filter(function (m) { return m !== mode && !(nd && m === 'd'); }).map(function (m) {
        return { mode: m, turn: all.filter(function (a) { return inMode(a, m); }).length, any: rel.filter(function (a) { return inMode(a, m); }).length };
      }).filter(function (o) { return o.turn || o.any; })
    };
  }
  /** 메뉴 결재함 숫자 — 지금 갈래에서 내가 처리할 것만(운전 안 하는 사람은 아래 운행일지 칸까지). */
  function inboxCount() {
    var SP = inboxSplit();
    return SP.mine.length + SP.ndMine.length;
  }
  function paintInboxPill() {
    var el = $('pInbox'); if (!el) return;
    var v = inboxCount();
    el.hidden = !v;
    el.textContent = v > 999 ? '999+' : n0(v);
    el.className = 'pill' + (v > 0 ? ' hot' : '');
    pillSay(el, v ? '내가 결재할 차례 ' + n0(v) + '건' : '');
    placeInboxNav(v);
  }
  /** 결재하는 사람인가 — 어떤 결재 건(운행일지·개인경비·법인카드)의 결재선에 들어 있다. 내가 올린 건만 있으면 아니다. */
  function isApproverMe() {
    var me = myName();
    return !!me && allAppr().some(function (a) {
      return a.username !== me && (a.steps || []).some(function (s) { return s.approver === me; });
    });
  }
  /** 결재함 메뉴 자리(2026-10-15 2차 「결재함 자리」) — 결재할 일이 없는 사람(결재선에 든 건이 없고 지금 내 차례 0)은
   *  메뉴 묶음 맨 아래(관리 위)로 내린다. 내 문서 상태는 각 시스템 첫 화면 띠에 있다. 결재 차례가 생기면 다시 위로(숫자 딱지와 함께). */
  function placeInboxNav(turn) {
    var nav = $('nav'), a = nav && nav.querySelector(':scope > a[data-v="inbox"]');
    if (!a) return;
    var low = !turn && !isApproverMe();
    var anchor = low ? $('admTog') : nav.querySelector(':scope > a[data-v="close"]');
    if (!anchor) return;
    var want = low ? anchor : anchor.nextSibling;
    if (a !== want && a.nextSibling !== want) nav.insertBefore(a, want);
    a.classList.toggle('low', low);
  }

  /* ══════════════════ 알림(종) — 2026-10-08 ══════════════════
     결재 건(APPR + 확장 종류)에서 화면이 직접 만든다. 서버에 새 사건은 없다.
       · 내가 올린 문서: 결재자 승인 · 결재 완료 · 반려(누가·사유) · 관리자 반려 · 정정 열기
       · 내 차례가 된 문서: 「○○ 님 개인경비 10월분 결재 차례」
     읽음 상태는 서버 notice_seen(사람마다 한 줄: seen_at 까지 모두 읽음 + 그 뒤 하나씩 읽은 키)에 둔다.
     표가 아직 없거나(마이그레이션 적용 전) 실패하면 브라우저 저장소만 쓴다 — 오류를 띄우지 않는다. */
  var NOTE = { at: null, ids: [], srv: '', loaded: false, open: false, saveT: 0, focus: '' };
  var NOTE_MAX_IDS = 200, NOTE_DAYS = 90, NOTE_BASE_DAYS = 30;
  function noteLsKey() { return 'drv.notice.' + myName(); }
  function noteMs(t) { var v = t ? Date.parse(t) : NaN; return isNaN(v) ? 0 : v; }
  function noteLocal() {
    try { var j = JSON.parse(localStorage.getItem(noteLsKey()) || 'null'); return j && typeof j === 'object' ? j : null; } catch (e) { return null; }
  }
  function noteMerge(x) {
    if (!x) return;
    var at = noteMs(x.seen_at || x.at);
    if (at && (NOTE.at == null || at > NOTE.at)) NOTE.at = at;
    (Array.isArray(x.read_ids) ? x.read_ids : Array.isArray(x.ids) ? x.ids : []).forEach(function (k) {
      if (typeof k === 'string' && NOTE.ids.indexOf(k) < 0) NOTE.ids.push(k);
    });
  }
  /** 로그인 뒤 한 번 — 브라우저 것과 서버 것을 합친다(더 늦은 seen_at · 읽은 키 합집합). */
  function noteLoad() {
    if (NOTE.loaded || !myName()) return;
    NOTE.loaded = true;
    noteMerge(noteLocal());
    apiRetry('/rest/v1/notice_seen?select=seen_at,read_ids&username=eq.' + encodeURIComponent(myName()))
      .then(function (r) {
        if (!r.ok) { NOTE.srv = 'off'; return null; }     // 표 없음(404)·권한 없음 — 브라우저 저장소만
        NOTE.srv = 'on';
        return r.json();
      })
      .then(function (rows) { if (Array.isArray(rows) && rows[0]) noteMerge(rows[0]); paintBell(); })
      .catch(function () { NOTE.srv = 'off'; });
  }
  /** 지금 읽음 상태로 쓸 한 줄 — 읽은 키는 seen_at 이전 것이면 필요 없다(지금 목록에 없는 키부터 버리고 개수를 묶는다). */
  function noteRow(me) {
    if (LOADED) {
      var live = {}; noteEvents().forEach(function (e) { live[e.k] = 1; });
      NOTE.ids = NOTE.ids.filter(function (k) { return live[k]; });
    }
    NOTE.ids = NOTE.ids.slice(-NOTE_MAX_IDS);
    // 「모두 읽음」을 누른 적이 없으면(NOTE.at 없음) 지금 쓰는 기준(30일 전)을 그대로 적는다 — 예전엔 지금 시각을 적어,
    //   알림 하나만 열어도 다음에 페이지를 열 때(시스템 선택 → 개인경비 등) 나머지가 모두 읽음이 되었다(2026-10-16 6차).
    if (NOTE.at == null) NOTE.at = noteBase();
    return { username: me, seen_at: new Date(NOTE.at).toISOString(), read_ids: NOTE.ids.slice(), updated_at: new Date().toISOString() };
  }
  function notePersist() {
    var me = myName(); if (!me) return;
    // ★ 쓰기 직전에 다른 탭·기기가 적은 것을 먼저 합친다(2026-10-20 AU2 #12) — 예전엔 나중에 쓴 탭이 줄을 통째로 덮어,
    //   다른 탭에서 읽은 알림이 다시 「안 읽음」이 됐다. 합치기 = 더 늦은 seen_at · 읽은 키 합집합(noteMerge).
    noteMerge(noteLocal());
    try { localStorage.setItem(noteLsKey(), JSON.stringify(noteRow(me))); } catch (e) { }
    if (NOTE.srv !== 'on') return;
    clearTimeout(NOTE.saveT);
    NOTE.saveT = setTimeout(function () {
      var before = NOTE.at + '|' + NOTE.ids.length;
      apiRetry('/rest/v1/notice_seen?select=seen_at,read_ids&username=eq.' + encodeURIComponent(me))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) { if (Array.isArray(rows) && rows[0]) noteMerge(rows[0]); }, function () { })   // 못 읽어도 내 것은 쓴다
        .then(function () {
          if (myName() !== me) return null;          // 그 사이 다른 사람으로 바뀌었으면 쓰지 않는다
          var row = noteRow(me);
          try { localStorage.setItem(noteLsKey(), JSON.stringify(row)); } catch (e) { }
          if (NOTE.at + '|' + NOTE.ids.length !== before) paintBell();   // 다른 탭·기기에서 읽은 것이 더해졌으면 종 숫자에도
          return apiRetry('/rest/v1/notice_seen?on_conflict=username', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row)
          });
        })
        .then(function (r) { if (r && !r.ok) NOTE.srv = 'off'; }).catch(function () { NOTE.srv = 'off'; });
    }, 500);
  }
  function noteTime(ms) {
    var d = new Date(ms + 9 * 3600e3);
    return pad(d.getUTCMonth() + 1) + '.' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }
  function noteDoc(a) {
    var kd = kindDef(kindOf(a));
    return { sys: kd ? (kd.mode || 'x') : 'd', tag: kd ? kd.tag : '운행일지', month: keyShort(a.cycle, String(a.cycle || '')) };
  }
  /** 알림 글의 사람 — 「홍길동 센터장 님」. 칸 이름은 끝에 따로(noteBox). 예전 「실장 홍길동 님」은 칸 이름이 직책처럼 읽혔다(2026-10-16 5차). */
  function noteWho(s) { return stepWho(s) + ' 님'; }
  function noteBox(s) { return s.box ? ' (' + s.box + ' 칸)' : ''; }
  /** 알림 목록(최근 순). 키는 사건마다 고유하다 — 다시 상신하면 단계 시각이 바뀌어 새 알림이 된다. */
  function noteEvents() {
    var me = myName(), out = [], lo = Date.now() - NOTE_DAYS * 864e5;
    if (!me || !LOADED) return out;
    allAppr().forEach(function (a) {
      var D = noteDoc(a), base = (kindOf(a) || 'd') + ':' + a.id;
      var steps = (a.steps || []).slice().sort(function (x, y) { return x.seq - y.seq; });
      var push = function (k, ms, txt, why, turn) {
        if (!ms || (!turn && ms < lo)) return;
        // 윗줄(문서) — 내 차례 알림은 본문이 이미 「누구 님 무슨 문서」라 윗줄에는 내 칸만 적는다.
        out.push({ k: base + ':' + k, ms: ms, sys: D.sys, tag: D.tag,
          doc: turn ? (turn.box ? turn.box + ' 칸 결재 요청' : '결재 요청') : (a.username === me ? '내 ' : nameOf(a.username) + ' 님 ') + D.tag + ' ' + D.month,
          txt: txt, why: why || '', turn: !!turn, id: a.id, kind: kindOf(a) });
      };
      if (a.username === me) {
        var allOk = steps.length > 0 && steps.every(function (s) { return s.result === 'approved'; });
        var reo = steps.filter(function (s) { return s.reopened_by; })[0];
        steps.forEach(function (s, i) {
          if (!s.acted_at || !s.result) return;
          var ms = noteMs(s.acted_at);
          if (s.result === 'approved') {
            if (allOk && i === steps.length - 1) {
              push('done:' + s.acted_at, ms, noteWho(s) + noteBox(s) + '이 마지막으로 승인해 결재가 끝났어요', s.comment);
            } else push('a' + s.seq + ':' + s.acted_at, ms, noteWho(s) + noteBox(s) + '이 승인했어요', s.comment);
          } else if (s.result === 'rejected') {
            push('r' + s.seq + ':' + s.acted_at, ms, s.forced_by
              ? '관리자 ' + nameOf(s.forced_by) + ' 님이 결재자 대신 반려했어요'
              : s.recalled ? noteWho(s) + noteBox(s) + '이 승인을 취소하고 반려했어요'
                : noteWho(s) + noteBox(s) + '이 반려했어요', s.comment || '');
          }
        });
        if (reo) {
          var rms = noteMs(reo.reopened_at) || noteMs(a.closed_at);
          push('reopen:' + (reo.reopened_at || a.closed_at), rms, nameOf(reo.reopened_by) + ' 님이 정정으로 다시 열었어요', reo.reopen_reason);
        }
      }
      // 승인 취소·반려(2026-10-19) — 차례가 왔다가 없어진 다음 결재자에게 「결재할 필요가 없어졌습니다」
      if (a.status === 'rejected' && a.username !== me) {
        var rc = steps.filter(function (s) { return s.recalled && s.result === 'rejected'; })[0];
        var rn = rc && steps.filter(function (s) { return s.seq === rc.seq + 1; })[0];
        if (rn && rn.approver === me && rc.approver !== me) {
          push('rc' + rc.seq + ':' + rc.acted_at, noteMs(rc.acted_at),
            noteWho(rc) + '이 승인을 취소하고 반려해서 결재할 필요가 없어졌어요', rc.comment || '');
        }
      }
      if (a.status === 'submitted') {
        var cur = steps.filter(function (s) { return s.seq === a.cur_seq; })[0];
        if (cur && cur.approver === me) {
          var prev = steps.filter(function (s) { return s.seq < a.cur_seq && s.acted_at; }).pop();
          var tms = noteMs(prev && prev.acted_at) || noteMs(a.submitted_at);
          push('turn' + a.cur_seq + ':' + (a.submitted_at || ''), tms,
            nameOf(a.username) + ' 님 ' + D.tag + ' ' + D.month + ' 결재 차례예요', '', cur);
        }
      }
    });
    // 공지 한 줄(2026-10-15 2차) — 운행일지를 쓰는 사람에게만
    if (usesDriving(me)) NOTICES.forEach(function (n) {
      if (n.ms >= lo) out.push({ k: n.k, ms: n.ms, sys: 'd', tag: '공지', doc: n.doc, txt: n.title, why: '', turn: false, notice: n });
    });
    return out.sort(function (x, y) { return y.ms - x.ms; }).slice(0, 60);
  }
  /* ── 공지(2026-10-15 2차 「통행료·주차비 영수증 필수」 — 사용자 승인 문구 그대로) ──
     종 알림에 한 줄(읽음은 다른 알림과 같은 방식) + 2단계 주차·통행료 차례와 이번 달 마감 위에 닫을 수 있는 띠.
     띠를 닫으면 그 사람·그 브라우저에 기억한다(localStorage). 운행일지를 쓰는 사람에게만. */
  var NOTICES = [{
    k: 'notice:money-v3-receipt', ms: Date.parse('2026-10-15T00:00:00+09:00'), doc: '운행일지 공지',
    // 2026-10-16 사용자 결정: 영수증이 없어도 금액은 정산에 남고 「영수증 없음」(R06)으로 표시만 한다 — 결재선 모두가 본다. 띠는 앞에 [안내] 를 따로 붙인다.
    title: '10월분부터 통행료·주차비는 영수증을 꼭 올려 주세요',
    text: '10월분부터 통행료·주차비는 영수증을 꼭 올려 주세요. 자동 계산이나 하이패스로 들어간 통행료도 마찬가지예요. ' +
      '하이패스 이용내역 PDF로 맞춘 통행료는 영수증으로 인정해요. 영수증이 없으면 ‘영수증 없음’으로 표시되고 결재자도 함께 봐요. ' +
      '운행에 금액이 없으면 올린 영수증 금액이 운행에 들어가고, 금액이 있으면 영수증과 맞는지 확인만 하고 두 번 더하지 않아요. ' +
      '업무 운행이 없는 날의 영수증은 정산에서 빠져요.'
  }];
  function noticeKey(k) { return 'drv.noticex.' + myName() + '.' + k; }
  function noticeClosed(k) { try { return localStorage.getItem(noticeKey(k)) === '1'; } catch (e) { return false; } }
  function noticeClose(k) { try { localStorage.setItem(noticeKey(k), '1'); } catch (e) { } }
  /** 닫을 수 있는 공지 띠(아직 안 닫은 것만). 운행일지를 안 쓰는 사람·관리 화면에는 없다.
      웹 사용성 1차(2026-10-19): 8줄 띠 → 한 줄 요약(title) + 「자세히」(펼치면 사용자 결정 문구 전체 그대로). × 는 오른쪽 위.
      이번 달 마감 화면에만 단다(영수증 화면 주차·통행료 카드 안 것은 뺐다). 펼침은 이 창에서만 기억한다. */
  var NOTICE_OPEN = {};
  /* 공지 띠가 걸리는 첫 기간 — 「10월분부터」 규칙의 공지라 9월분·6월분 같은 지난 기간 마감 화면에는 달지 않는다(2026-10-20 AU6-L6, 문구는 그대로).
     여러 기간을 보는 화면(조회 전용)도 마지막 기간이 그 뒤일 때만. */
  var NOTICE_FROM = { y: 2026, m: 10 };
  function noticeBand() {
    if (!myName() || !usesDriving(myName()) || isAll()) return '';
    if (cmpCycle(RANGE ? RANGE.to : CYC, NOTICE_FROM) < 0) return '';
    return NOTICES.filter(function (n) { return !noticeClosed(n.k); }).map(function (n) {
      var open = !!NOTICE_OPEN[n.k];
      return '<div class="hpnote notice' + (open ? ' open' : '') + '" data-notice="' + esc(n.k) + '">' + ic('alert', 16) +
        '<span class="ntx"><b>[안내]</b> <span class="nsum">' + esc(n.title) + '</span>' +
        '<span class="nfull">' + esc(n.text) + '</span> ' +
        '<button type="button" class="nmore" data-noticemore="' + esc(n.k) + '" aria-expanded="' + open + '">' + (open ? '접기' : '자세히') + '</button></span>' +
        '<button class="iconbtn" data-noticex="' + esc(n.k) + '" aria-label="이 안내 닫기" title="이 안내 닫기">' + ic('close', 14) + '</button></div>';
    }).join('');
  }
  function noteBase() { return NOTE.at != null ? NOTE.at : Date.now() - NOTE_BASE_DAYS * 864e5; }
  function noteUnread(e) { return e.ms > noteBase() && NOTE.ids.indexOf(e.k) < 0; }
  function paintBell() {
    var n = noteEvents().filter(noteUnread).length;
    var t = n > 99 ? '99+' : String(n);
    [['bellN', 'bellBtn'], ['uBadge', 'uBtn']].forEach(function (p) {
      var b = $(p[0]); if (b) { b.hidden = !n; b.textContent = t; }
    });
    var bb = $('bellBtn');
    if (bb) bb.setAttribute('aria-label', n ? '알림 · 읽지 않은 ' + n + '건' : '알림');
    var ub = $('uBtn');
    if (ub) ub.setAttribute('aria-label', '내 정보' + (n ? ' · 읽지 않은 알림 ' + n + '건' : ''));
    if (ub) ub.title = '내 정보' + (n ? ' · 읽지 않은 알림 ' + n + '건' : '');      // 좁은 폰에서 이름 위 숫자의 뜻(2026-10-19)
    if (NOTE.open) paintNotePop();
  }
  /** 좁은 폰(≤460px)에서는 종을 따로 두지 않는다 — 머리줄이 넘친다. 이름 단추가 알림 창을 연다(창 안에 「내 계정」). */
  function bellNarrow() { try { return window.matchMedia('(max-width:460px)').matches; } catch (e) { return false; } }
  function paintNotePop() {
    var pop = $('notePop'); if (!pop) return;
    var ev = noteEvents(), un = ev.filter(noteUnread).length;
    pop.innerHTML =
      '<div class="nh"><b>알림</b>' + (un ? '<span class="nc">' + n0(un) + '</span>' : '') + '<span class="sp"></span>' +
        '<button type="button" class="nlink" data-noteacct>' + ic('users', 14) + '내 계정</button>' +
        (un ? '<button type="button" class="nall" data-noteall>모두 읽음</button>' : '') + '</div>' +
      (ev.length
        ? '<div class="nlist">' + ev.map(function (e) {
            var u = noteUnread(e);
            return '<button type="button" class="ni' + (u ? ' un' : '') + (e.turn ? ' turn' : '') + '" data-note="' + esc(e.k) + '">' +
              '<span class="nd" aria-hidden="true"></span>' +
              '<span class="nb"><span class="nt"><span class="akind' + (e.sys !== 'd' ? ' ' + e.sys : '') + '">' + esc(e.tag) + '</span>' +
                '<span class="ndoc">' + esc(e.doc) + '</span><time>' + noteTime(e.ms) + '</time></span>' +
              '<span class="nx">' + esc(e.txt) + (u ? '<span class="sr"> (안 읽음)</span>' : '') + '</span>' +
              (e.why ? '<span class="nw">' + esc(e.why) + '</span>' : '') + '</span></button>';
          }).join('') + '</div>'
        : '<div class="nempty">' + ic('check', 20) + '<b>새 알림이 없어요</b><span>결재가 진행되거나 내 차례가 되면 여기에 보여요.</span></div>');
  }
  function openNotePop(on) {
    var pop = $('notePop'); if (!pop) return;
    if (on === undefined) on = pop.hidden;
    if (on) { noteLoad(); openCyclePop(false); }
    NOTE.open = !!on;
    pop.hidden = !on;
    var bb = $('bellBtn'), ub = $('uBtn');
    if (bb) bb.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (ub && bellNarrow()) ub.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) {
      paintNotePop();
      var f = pop.querySelector('.ni.un') || pop.querySelector('.ni') || pop.querySelector('button');
      if (f) { try { f.focus({ preventScroll: true }); } catch (e) { } }
    }
  }
  function noteReadAll() {
    var mx = Date.now();
    noteEvents().forEach(function (e) { if (e.ms > mx) mx = e.ms; });
    NOTE.at = mx; NOTE.ids = [];
    notePersist(); paintBell();
  }
  /** 알림을 눌렀다 — 읽음으로 하고 그 문서가 있는 갈래의 결재함을 열어 그 카드로 간다. */
  function noteOpen(k) {
    var e = noteEvents().filter(function (x) { return x.k === k; })[0];
    if (!e) return;
    if (NOTE.ids.indexOf(k) < 0) NOTE.ids.push(k);
    notePersist();
    openNotePop(false);
    if (e.notice) {
      // 공지는 결재함으로 가지 않고 그 자리에서 전문을 보인다
      paintBell();
      openPanel('공지', e.notice.doc, '<div class="hpnote notice" style="margin-top:0">' + ic('alert', 16) + '<span><b>[안내]</b> ' + esc(e.notice.text) + '</span></div>',
        '<span style="flex:1"></span><button class="btn pri" data-close>확인</button>');
      return;
    }
    if (!noDriving() || e.sys !== 'd') NAV_MODE = e.sys;          // 운전 안 하는 사람도 개인경비·법인카드 갈래는 오간다
    INBOX_F = 'all';
    INBOX_ALLCYC = true;   // 알림 문서가 다른 달 것이어도 결재함에 보이게(2026-10-14 기간 거르기)
    NOTE.focus = (e.kind || 'd') + ':' + e.id; NOTE.focusUntil = Date.now() + 2500;
    if (VIEW === 'inbox') render(); else go('inbox');
    paintBell();
    noteFocusCard();
  }
  function noteFocusCard() {
    if (!NOTE.focus) return;
    // 알림을 누른 뒤 2.5초 동안은 다시 그릴 때마다 그 카드로 간다 — 자료가 늦게 와 결재함을 한 번 더 그리면
    //   카드가 새로 만들어져 자리를 잃었다(2026-10-15 매뉴얼 로봇: 알림을 눌러도 맨 위에 남았다).
    if (Date.now() > (NOTE.focusUntil || 0)) { NOTE.focus = ''; return; }
    var c = document.querySelector('.acard[data-akey="' + NOTE.focus + '"]');
    if (!c) return;
    c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
    // 카드 머리(이름·「내 차례입니다」·승인 단추)가 보이게 위에 맞춘다 — 문서를 펼친 카드는 길어 가운데 맞추면 머리가 화면 위로 지나갔다
    //   2026-10-16 3차: 위 카드의 문서 그림이 뒤늦게 붙어 길어지면 카드가 아래로 밀려 「위 카드 중간」에서 멈췄다 —
    //   4초 동안 그 카드 머리가 머리띠 바로 아래에 있게 따라간다(사용자가 스크롤·터치·키를 누르면 그만둔다).
    var key = NOTE.focus, until = Date.now() + 4000;
    var stop = function () { until = 0; };
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (ev) { window.addEventListener(ev, stop, { once: true, passive: true }); });
    var align = function () {
      if (!until || Date.now() > until || NOTE.focus !== key) return;
      if (!document.contains(c)) { c = document.querySelector('.acard[data-akey="' + key + '"]'); if (!c) return; }
      var hd = document.querySelector('header.top'), hb = hd ? Math.max(0, hd.getBoundingClientRect().bottom) : 0;
      var off = c.getBoundingClientRect().top - (hb + 12);
      if (Math.abs(off) > 4) window.scrollTo({ top: Math.max(0, window.scrollY + off) });
      setTimeout(align, 150);
    };
    setTimeout(align, 40);
  }
  /** 승인 취소·반려를 할 수 있는가(2026-10-19 사용자 — 세 결재 시스템 공통). 서버 approval-act kinds.ts recallRejectPlan 과 같은 판정:
   *  결재 중 · 지금 차례 바로 앞 칸이 내 칸이고 내가 승인 · 지금 차례 칸은 아직 처리 전. 다음 분이 결재하면 단추가 사라진다. */
  function canRecall(a) {
    var me = myName();
    if (!me || !a || a.status !== 'submitted') return false;
    var st = a.steps || [];
    var mine = st.filter(function (s) { return s.seq === a.cur_seq - 1; })[0];
    var next = st.filter(function (s) { return s.seq === a.cur_seq; })[0];
    return !!(mine && next && mine.approver === me && mine.result === 'approved' && !next.result && !next.acted_at);
  }
  /** 결재 완료 건을 정정으로 다시 열 수 있는가 — 운행일지 관리자만(서버 approval-act 'reopen' 도 같은 판정). */
  function canReopen(a) { return !!(ME && ME.is_admin && a && a.status === 'approved'); }
  /** 결재 건 상태 이력에서 '정정 열기'가 있었으면 그 단계(누가·왜). */
  function reopenInfo(a) {
    return (a && (a.steps || []).filter(function (x) { return x.reopened_by; })[0]) || null;
  }
  /** 결재함 '그 밖의 건' 상태 필터. */
  var INBOX_F = 'all';
  /** 그 밖의 건 — 전체 기간 보기 · 상신한 사람 이름 · 상신일 시작/끝(YYYY-MM-DD, 한국 날짜). 기본은 고른 기간만(2026-10-14). */
  var INBOX_ALLCYC = false, INBOX_Q = '', INBOX_D1 = '', INBOX_D2 = '';
  /** 방금 결재한 건(종류:id) — 기간 거르기로 숨기지 않는다(새로고침하면 잊는다). */
  var INBOX_JUST = '';

  /* ── 결재함 내 차례 — 확인 필요 먼저 · 승인·반려 뒤 다음 문서(2026-10-20 D2 시안 P_Inbox · M_Approve, 사용자 「한 번에 승인」은 넣지 않음) ── */
  /** 내 차례 문서가 보이는 차례(종류:id) — 확인 필요 → 이상 없음. viewInbox 가 그릴 때마다 채운다. */
  var INBOX_ORDER = [];
  /** 결재 카드의 판정 — 카드 판정 띠(상신 때 굳힌 검증 결과, 모듈의 extra/apprExtra)와 같은 것: 'ok' · 'warn' · 'bad' · ''(띠 없음) */
  function apprLevel(a) {
    var kd = kindDef(kindOf(a)), ext = kd ? (kd.extra ? kd.extra(a) : '') : (EXT.apprExtra ? EXT.apprExtra(a) : '');
    var m = /<div class="abrief (ok|warn|bad)/.exec(String(ext || ''));
    return m ? m[1] : '';
  }
  /** 그 결재 건의 판정을 아직 받는 중인가 — 판정 띠가 「검증 결과를 불러오는 중…」(세 모듈 같은 글, 2026-10-20 V3 B7).
   *  끝(「입니다」·「이에요」·「…」)은 보지 않는다 — 세 모듈(drv-verify·drv-expense·drv-card)이 말투를 바꿔도 같이 잡히게(2026-10-24 해요체). */
  function apprLoading(a) {
    var kd = kindDef(kindOf(a)), ext = kd ? (kd.extra ? kd.extra(a) : '') : (EXT.apprExtra ? EXT.apprExtra(a) : '');
    return /<div class="abrief[^>]*>[\s\S]*?검증 결과를 불러오는 중/.test(String(ext || ''));
  }
  /** 내 차례 묶음의 보이는 차례(종류:id) — 확인 필요 → 이상 없음(turnGroups 와 같은 차례). 판정을 받는 중이면 [](묶지 않고 뼈대만, V3 B7). */
  function turnOrder(list) {
    if (list.some(function (a) { return apprLoading(a); })) return [];
    var need = [], ok = [];
    list.forEach(function (a) { (apprLevel(a) === 'ok' ? ok : need).push(a); });
    return need.concat(ok).map(function (a) { return (kindOf(a) || 'd') + ':' + a.id; });
  }
  /** 내 차례를 둘로 묶는다 — 판정 띠가 「이상 없음」(ok)인 문서는 아래 「이상 없음」, 나머지(확인·불일치·결과를 받는 중)는 위 「확인 필요」.
   *  묶음 안 순서는 그대로. 카드 모양·단추는 그대로(줄 배치만). */
  function turnGroups(list) {
    // 검증 결과(상신 때 굳힌 판정)를 받기 전에는 묶지 않는다 — 받는 동안 「확인 필요」로 묶였다가 받은 뒤 「이상 없음」으로 옮겨 가며
    //   첫 카드가 바뀌었다(2026-10-20 V3 B7 — 누르려던 「승인」 자리에 다른 문서가 올 수 있다). 받는 동안은 자리표시(뼈대)만.
    //   모듈이 받으면(못 받아도) 다시 그린다 — 못 받은 문서는 판정 띠가 「불러오지 못했습니다」라 「확인 필요」로 묶인다.
    if (list.some(function (a) { return apprLoading(a); })) {
      return '<div class="ibload" aria-busy="true"><span class="sr" role="status">검증 결과를 받는 중…</span>' +
        '<div class="sk" style="width:38%;height:14px"></div><div class="sk" style="width:100%;height:64px;margin-top:12px"></div>' +
        (list.length > 1 ? '<div class="sk" style="width:100%;height:64px;margin-top:12px"></div>' : '') + '</div>';
    }
    var need = [], ok = [];
    list.forEach(function (a) { (apprLevel(a) === 'ok' ? ok : need).push(a); });
    var order = need.concat(ok), akey = function (a) { return (kindOf(a) || 'd') + ':' + a.id; };
    order.forEach(function (a) { if (INBOX_ORDER.indexOf(akey(a)) < 0) INBOX_ORDER.push(akey(a)); });
    // 카드 아래 안내 = 승인 창 안내(같은 inboxNextOf — 마지막 카드면 남은 맨 앞 문서, 예전엔 카드는 「마지막 문서입니다」인데 창은 다음 문서를 말했다) ·
    //   빨간 「승인」은 화면에 하나 — 내 차례 맨 앞 카드(lead), 나머지는 테두리 단추(2026-10-20 V3 다듬기)
    var card = function (a) {
      var nk = inboxNextOf(akey(a)), p = nk ? nk.split(':') : null, nb = p ? apprFind(+p[1], p[0] === 'd' ? '' : p[0]) : null;
      return apprCard(a, { next: nb ? nameOf(nb.username) : '', lead: INBOX_ORDER[0] === akey(a) });
    };
    var grp = function (cls, label, n, desc) {
      return '<h3 class="ibgrp ' + cls + '"><span class="d2chip ' + cls + '">' + label + ' ' + n0(n) + '</span><span class="ibgd">' + desc + '</span></h3>';
    };
    return (need.length ? grp('warn', '확인 필요', need.length, '검증에서 볼 것이 있거나 결과를 받는 중이라 먼저 볼 문서') + need.map(function (a, i) { return card(a, i); }).join('') : '') +
      (ok.length ? grp('ok', '이상 없음', ok.length, '금액·검증 모두 이상 없는 문서') + ok.map(function (a, i) { return card(a, need.length + i); }).join('') : '');
  }
  /** 내 차례에서 이 문서 다음 것(종류:id) — 마지막이면 맨 앞(남은 것). 없으면 ''. */
  function inboxNextOf(k) {
    var i = INBOX_ORDER.indexOf(k);
    if (i < 0) return '';
    return INBOX_ORDER.slice(i + 1).concat(INBOX_ORDER.slice(0, i))[0] || '';
  }
  /** 승인·반려 창 안내 — 결재함 내 차례에서 연 창에만 「다음 문서가 바로 열립니다」. */
  function inboxNextHint(id, kind) {
    if (VIEW !== 'inbox') return '';
    var nk = inboxNextOf((kind || 'd') + ':' + id);
    if (!nk) return '';
    var p = nk.split(':'), b = apprFind(+p[1], p[0] === 'd' ? '' : p[0]);
    return b ? '<div class="anote d2nexthint">' + ic('chev', 13) + '승인·반려하면 다음 문서(' + esc(nameOf(b.username)) + ')가 바로 열려요.</div>' : '';
  }
  /** 승인·반려가 끝나면 — 다음 문서의 「문서 보기」를 편 채로 다시 그리고(apvSlot), 그 카드로 옮겨 깜빡이고(noteFocusCard), 승인 단추에 초점을 둔다. */
  function inboxNextMark(payload) {
    if (VIEW !== 'inbox' || !payload || !/^(approve|reject)$/.test(payload.action || '')) return;
    var nk = inboxNextOf((payload.kind || 'd') + ':' + payload.id);
    if (!nk) return;
    var p = nk.split(':');
    try { sessionStorage.setItem(apvSsKey(p[0], p[1]), '1'); } catch (e) { }
    NOTE.focus = nk; NOTE.focusUntil = Date.now() + 2500;
    var t0 = Date.now();
    (function focusNext() {
      var bs = Array.prototype.filter.call(document.querySelectorAll('.acard[data-akey="' + nk + '"] [data-appr="approve"]'), function (b) { return b.offsetParent !== null; });
      if (bs.length && !$('panel').classList.contains('open')) { try { bs[0].focus({ preventScroll: true }); } catch (e) { bs[0].focus(); } return; }
      if (Date.now() - t0 < 5000) setTimeout(focusNext, 150);
    })();
  }
  function apprCard(a, opt) {
    opt = opt && typeof opt === 'object' ? opt : {};          // .map(apprCard) 은 둘째 값으로 번호를 준다
    var st = apprStatusText(a);
    var s = a.snapshot || {};
    var canAct = inbox().indexOf(a) >= 0;
    // 반려·회수된 내 건이고 그 기간의 가장 최근 건이면 「고쳐서 다시 상신」(「올리기」는 업로드로 읽혀 바꿈 — 2026-10-15 2차)
    var kd0 = kindDef(kindOf(a)), latest0 = kd0 ? (kd0.mine ? kd0.mine(a.cycle) : null) : apprOf(myName(), a.cycle);
    var canFix = a.username === myName() && (a.status === 'rejected' || a.status === 'withdrawn') && (!latest0 || latest0.id === a.id);
    var canWithdraw = a.username === myName() && a.status === 'submitted' &&
      !(a.steps || []).some(function (x) { return x.result; });
    // 결재 문서 종류(개인경비 등)가 붙어 있으면 한 결재함에서 어느 문서인지 딱지로 가른다.
    var kd = kindDef(kindOf(a)), anyKind = Object.keys(EXT.kinds).length > 0;
    var kattr = kd ? ' data-kind="' + esc(kindOf(a)) + '"' : '';
    // 검증 요약 · 결재 문서(고정본) — drv-verify.js(운행일지) · drv-expense.js(개인경비)가 채운다.
    var ext = kd ? (kd.extra ? kd.extra(a) : '') : (EXT.apprExtra ? EXT.apprExtra(a) : '');
    // ── 얇은 카드(2026-10-19 사용자 「한 건 한 건이 너무 두꺼워서 내리기 힘든데」) ──
    //   ① 머리 줄: 딱지 · 이름 · 기간 · 상태 · 건수·금액 (내 차례면 오른쪽 끝에 반려·승인)
    //   ② 한 줄: 진행 줄 + 검증 딱지 · 출력 딱지 · 단추들(PDF 받기 · 엑셀 받기 · 정정 열기 · 승인 취소·반려 · 문서 보기 · 자세히)
    //   큰 판정 상자(띠 + 숫자 4칸 + 딱지)는 그 밖의 건이면 「자세히」를 눌러야 펼친다. 내 차례는 판정 한 줄 + 숫자 한 줄로 늘 보이고,
    //   확인 항목 목록만 「확인 항목 N건」으로 접는다(「영수증 없음」 R06 은 결재선 모두가 보게 접지 않는다 — 2026-10-16 사용자).
    //   모듈(drv-verify·drv-expense·drv-card)이 만든 조각은 그대로 쓴다 — 판정 상자(.abrief)와 단추 줄(.aext)로 나눠 자리만 옮긴다.
    var akey = (kindOf(a) || 'd') + ':' + a.id;
    var ai = ext.indexOf('<div class="aext"');
    var brief = ai > 0 ? ext.slice(0, ai) : ai < 0 ? ext : '', tail = ai >= 0 ? ext.slice(ai) : '';
    if (brief && brief.indexOf('<div class="abrief') !== 0) { tail = brief + tail; brief = ''; }
    var nItems = (brief.match(/<li class="(?:bad|warn)"/g) || []).length;
    var longSt = st.t.length > 34;
    var det = !!ACARD_DET[akey];
    // 자세히: 그 밖의 건은 판정 상자·긴 반려 사유, 내 차례는 확인 항목이 있을 때만
    var detWhat = canAct ? (nItems ? '확인 항목 ' + n0(nItems) + '건' : '') : (brief || longSt ? '자세히' : '');
    var detBtn = detWhat ? '<button type="button" class="btn sm adetbtn" data-adet aria-expanded="' + det + '">' +
      (det ? (canAct ? '확인 항목 접기' : '접기') : detWhat) + ic('chev', 12) + '</button>' : '';
    var recallTip = '다음 결재자가 결재하기 전이라 승인을 취소할 수 있어요.';
    // 폰 「⋯」(2026-10-24 사용자 「결재함 한 건 높이 줄이기」) — 엑셀 받기·승인 취소·정정 열기·회수는 폰(≤600)에서 「⋯」 메뉴 하나로.
    //   PC·태블릿은 지금처럼 줄에 펼친다(.amx 단추). 메뉴 항목은 같은 data-* 를 가진 단추라 같은 처리기가 받는다(kmenu).
    var moreIt = [], recall = canRecall(a), reopen = canReopen(a);
    var xm = /<button class="btn sm" (data-(?:fz|xfz|cfz)xlsx="[^"]*")>/.exec(tail);
    if (xm) { moreIt.push([xm[1], '엑셀 받기']); tail = tail.replace(xm[0], xm[0].replace('class="btn sm"', 'class="btn sm amx"')); }
    // 승인 취소 항목도 줄 단추와 같은 풀이(title · 화면 읽기 안내 — 안내 글 span 은 줄 단추 쪽에 하나)
    if (recall) moreIt.push(['data-appr="recall_reject" data-id="' + a.id + '"' + kattr + ' title="' + recallTip + '" aria-describedby="arc-' +
      esc(akey.replace(':', '-')) + '"', '승인 취소·반려', true]);
    if (reopen) moreIt.push(['data-appr="reopen" data-id="' + a.id + '"' + kattr, '정정 열기']);
    if (canWithdraw) moreIt.push(['data-appr="withdraw" data-id="' + a.id + '"' + kattr, '회수']);
    var acts =
      // 방금 승인한 건 — 다음 분이 결재하기 전이면 승인을 거두고 반려로 돌려보낸다(2026-10-19). 안내는 단추 풀이(title·화면 읽기)로
      (recall ? '<button class="btn sm amx" data-appr="recall_reject" data-id="' + a.id + '"' + kattr + ' title="' + recallTip + '"' +
        ' aria-describedby="arc-' + esc(akey.replace(':', '-')) + '">승인 취소·반려</button>' +
        '<span class="sr arecall" id="arc-' + esc(akey.replace(':', '-')) + '">' + recallTip + '</span>' : '') +
      // 반려·회수된 내 건 — 고칠 화면으로 바로(2026-10-15 매뉴얼 로봇: 결재함 카드에 갈 길이 없었다)
      (canFix ? '<button class="btn pri sm" data-fixgo="' + esc(kd ? (kd.mode || 'x') + '_month' : 'close') + '" data-fixcyc="' + esc(a.cycle) + '">고쳐서 다시 상신 →</button>' : '') +
      (reopen ? '<button class="btn sm amx" data-appr="reopen" data-id="' + a.id + '"' + kattr + '>정정 열기</button>' : '') +
      (canWithdraw ? '<button class="btn sm amx" data-appr="withdraw" data-id="' + a.id + '"' + kattr + '>회수</button>' : '');
    return '<div class="acard cmp' + (canAct ? ' turn' : '') + (det ? ' det' : '') + (kd ? ' akind-' + esc(kindOf(a)) : '') + '" data-akey="' + esc(akey) + '">' +
      '<div class="ahd">' + (anyKind ? '<span class="akind' + (kd ? ' ' + (kd.mode || 'x') : '') + '">' + esc(kd ? kd.tag : '운행일지') + '</span>' : '') +
      '<b>' + esc(nameOf(a.username)) + '</b>' +
      // 다른 화면과 같은 이름으로 부른다("2026-09분" → "2026년 9월분").
      // 개인경비는 기간이 20일~19일이라 달 이름만으로는 헷갈린다 — 범위를 같이 적는다(kd.cycLabel).
      '<span class="acyc">' + esc(kd && kd.cycLabel ? kd.cycLabel(a) : keyName(a.cycle, a.cycle + '분')) + '</span>' +
      // 폰 「⋯」는 카드 오른쪽 위(첫 줄 끝) — 단추 줄 끝에 두면 360px 에서 혼자 한 줄을 썼다(2026-10-24)
      (moreIt.length ? '<span class="amore">' + kmenu('다른 작업', moreIt) + '</span>' : '') +
      // 긴 반려 사유는 한 줄로 줄이고(끝 「…」) 「자세히」에서 전부 — 마우스를 올려도 전부 보인다
      '<span class="st ' + st.cls + (longSt ? ' along' : '') + '"' + (longSt ? ' title="' + esc(st.t) + '"' : '') + '>' + esc(st.t) + '</span>' +
      '<span style="flex:1"></span>' +
      (kd ? (kd.sumLine ? '<span class="asum">' + kd.sumLine(a) + '</span>' : '')
        : // 머리 줄 — 업무 운행 건수·거리 · 금액(2026-10-20 사용자 ③ 「결재함에 업무 운행 N건」 — 고정본에 biz_trips 가 있을 때, 전체 건수는 다를 때만).
          //   옛 문서(biz_trips 없음)는 예전처럼 업무 거리 · 금액만. 마우스를 올리면 snapTrips 전체 글.
        (s.trips != null ? '<span class="asum" title="' + esc(snapTrips(s)) + '">' +
          (s.biz_trips != null && s.biz_km != null ? esc(snapTrips(s)) : s.biz_km != null ? '업무 ' + km(s.biz_km) + ' km' : n0(s.trips) + '건 · ' + km(s.km) + ' km') +
          ' · ' + won(s.cost) + '</span>' : '')) +
      // 「자세히」(판정 상자·긴 사유) / 「확인 항목 N건」 — 머리 줄 오른쪽(아래 줄은 단추가 많아 넘쳤다)
      detBtn +
      // 내 차례 — 반려·승인을 머리 줄 오른쪽에(카드를 내리지 않고 누른다). 빨간 「승인」은 맨 앞 카드 하나(opt.lead === false 면 테두리, 2026-10-20 V3 다듬기)
      (canAct ? '<span class="aact ahact"><button class="btn sm" data-appr="reject" data-id="' + a.id + '"' + kattr + '>반려</button>' +
        '<button class="btn' + (opt.lead === false ? '' : ' pri') + ' sm" data-appr="approve" data-id="' + a.id + '"' + kattr + '>승인</button></span>' : '') +
      '</div>' +
      '<div class="acrow">' + apprTrack(a) + '<span class="asp"></span>' + tail +
      (acts ? '<span class="aact">' + acts + '</span>' : '') +
      // 결재 문서 미리보기 — 「문서 보기」는 이 줄에, 펼친 쪽은 카드 맨 아래 한 줄 전체로. 「결재 문서 PDF」 단추가 있는 카드에만.
      apvIfPdf(kindOf(a), a, ext) +
      (longSt ? '<div class="adst">' + esc(st.t) + '</div>' : '') +
      brief +
      '</div>' +
      // 폰(≤600px) 결재 — 근거(판정·금액·결재선)를 먼저 보이고 단추는 카드 아래 고정 줄 [반려 1 : 승인 3](2026-10-20 D2 시안 M_Approve).
      //   PC·태블릿은 위 머리 줄 단추 그대로(CSS 가 폭에 따라 하나만 보인다 — 같은 data-appr 단추).
      (canAct ? '<div class="amact"><span class="amnext">' + (opt.next ? '승인·반려하면 다음 문서(' + esc(opt.next) + ')가 바로 열려요' : '내 차례 마지막 문서예요') + '</span>' +
        '<div class="amgrid"><button class="btn" data-appr="reject" data-id="' + a.id + '"' + kattr + '>반려</button>' +
        '<button class="btn' + (opt.lead === false ? '' : ' pri') + '" data-appr="approve" data-id="' + a.id + '"' + kattr + '>승인</button></div></div>' : '') +
      '</div>';
  }
  /** 결재 카드 「자세히」를 펼친 카드(종류:id) — 화면을 다시 그려도 그대로. 새로고침하면 잊는다. */
  var ACARD_DET = {};
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-adet]');
    var c = b && b.closest('.acard');
    if (!c) return;
    var on = !c.classList.contains('det'), turn = c.classList.contains('turn');
    c.classList.toggle('det', on);
    ACARD_DET[c.dataset.akey] = on;
    b.setAttribute('aria-expanded', String(on));
    var n = (c.querySelectorAll('.abitems li.bad,.abitems li.warn') || []).length;
    b.innerHTML = (on ? (turn ? '확인 항목 접기' : '접기') : (turn ? '확인 항목 ' + n0(n) + '건' : '자세히')) + ic('chev', 12);
  });
  /** 모듈이 그린 줄에 그 종류의 「결재 문서 PDF」 단추가 있을 때만 미리보기 자리(고정본이 없는 옛 건 등은 빠진다). */
  function apvIfPdf(kind, a, html, opt) {
    var at = APV_PDFATTR[kind || ''];
    return at && String(html || '').indexOf(at + '="') >= 0 ? apvSlot(kind, a, opt) : '';
  }

  /* ── 결재 문서 미리보기(2026-10-12 사용자: 「눌러서 확인하는 것 말고 미리보기로」 — 카드 아래 전체 펼침) ──
     「결재 문서 PDF」 단추가 만드는 것과 같은 바이트(모듈 previewBytes → buildPdf, 같은 고정본·같은 생성기)를
     pdf.js 로 쪽마다 그림(JPEG)으로 그려 카드 아래 세로로 늘어놓는다. 미리보기만의 다른 그리기 길은 없다.
       · 화면에 들어올 때만(IntersectionObserver) · 한 번만 — 결재 건(종류·id·상태·상신·완료 시각) 별로 그림을 맡아 둔다.
         화면을 다시 그려도(render) 맡아 둔 그림을 바로 다시 붙인다.
       · 한 번에 하나씩 만든다(APV.MAX) — 결재함에 카드가 많아도 한꺼번에 PDF 를 만들지 않는다.
       · 모두 접은 채로 시작해 「문서 보기」로 편다(2026-10-19 — 예전에는 내 차례 카드를 펼쳐서 시작). 누른 것은 카드마다 sessionStorage 에 남긴다.
       · 실패해도 카드는 그대로 — 짧은 안내만. 서버에서 더 받는 것은 단추가 받는 그 고정본뿐이다(RLS 그대로). */
  var APV = { cache: {}, q: [], busy: 0, io: null, MAX: 1 };
  var APV_FAIL = '미리보기를 만들지 못했어요. ‘PDF 받기’로 열어 보세요.';
  var APV_PDFATTR = { '': 'data-fzpdf', expense: 'data-xfzpdf', card: 'data-cfzpdf' };
  function apvProv(kind) { return kind ? (EXT.kinds[kind] || {}).previewBytes : EXT.previewBytes; }
  // 그림 열쇠 — 결재란이 바뀌면 열쇠도 바뀐다(2026-10-21 매뉴얼 로봇: 중간 승인은 상태·상신·완료 시각이 그대로라
  //   승인한 뒤 「그 밖의 건」 카드에 승인 전 그림이 남았다). 지금 차례(cur_seq)와 칸마다 결과·시각을 넣는다.
  function apvKey(kind, a) {
    var st = (a.steps || []).map(function (s) { return s ? (s.seq || '') + '=' + (s.result || '') + '@' + (s.acted_at || '') : ''; }).join(',');
    return (kind || 'd') + ':' + a.id + ':' + a.status + ':' + (a.submitted_at || '') + ':' + (a.closed_at || '') + ':' + (a.cur_seq == null ? '' : a.cur_seq) + ':' + st;
  }
  /** 「문서 보기」로 펼친 것을 이 탭에 기억하는 열쇠 — 사람마다 따로(2026-10-21 매뉴얼 로봇: 같은 탭에서 로그아웃한 뒤 다른 사람으로
   *  들어오면 앞사람이 펼쳐 둔 문서가 펼친 채 남았다). 로그아웃하면 모두 지운다(tabMemClear). */
  function apvSsKey(kind, id) { return 'apv.' + myName() + '|' + (kind || 'd') + ':' + id; }
  function apvSaved(kind, id) { try { return sessionStorage.getItem(apvSsKey(kind, id)); } catch (e) { return null; } }
  /** 결재 카드·결재 띠에 끼우는 미리보기 자리(모듈의 extra/apprExtra 가 「결재 문서 PDF」 줄 아래에 붙인다).
   *  2026-10-15 2차(「똑같은 내용 아니야? 버튼??」): 같은 문서를 보는 단추 셋(결재 문서 PDF·문서 펼치기·크게 보기) →
   *  「문서 보기」(그 자리에 펼침 · 펼친 쪽을 누르면 크게) + 「PDF 받기」(받기·인쇄 — 모듈 줄의 단추) 둘. */
  function apvSlot(kind, a, opt) {
    if (!a || a.status === 'draft' || !apvProv(kind) || (kind && !APV_PDFATTR[kind])) return '';
    var sv = apvSaved(kind, a.id);
    // 내 차례 카드도 접은 채로 시작한다(2026-10-19 사용자 「한 건 한 건이 너무 두꺼워서」) — 펼친 것은 카드마다 기억
    var open = sv === '1';
    // 의견(2026-10-21) — 펼친 문서 위에 차례대로(담당 → 결재자). 접힌 동안은 「의견 N」만. 상신한 본인의 결재 띠는 띠에 이미 있어 빼고 부른다(opt.ops === false)
    var ops = opt && opt.ops === false ? '' : opinionsHtml(a), nOps = ops ? apprOpinions(a).length : 0;
    return '<div class="apv' + (open ? ' open' : '') + '" data-apv="' + esc(apvKey(kind, a)) + '" data-apvk="' + esc(kind || '') + '" data-apvid="' + esc(a.id) + '">' +
      '<div class="apvbar"><button type="button" class="btn sm" data-apvtog aria-expanded="' + open + '">' + (open ? '문서 접기' : '문서 보기') + '</button>' +
      (nOps ? '<span class="apvopn" title="‘문서 보기’를 누르면 의견이 보여요">의견 ' + n0(nOps) + '</span>' : '') +
      '<span class="dim apvhint">쪽을 누르면 크게 보여요</span></div>' +
      (ops ? '<div class="apvops"' + (open ? '' : ' hidden') + '>' + ops + '</div>' : '') +
      '<div class="apvpages" aria-label="결재 문서 미리보기"' + (open ? '' : ' hidden') + '></div></div>';
  }
  function apvPagesHtml(pages, big) {
    return pages.map(function (p, i) {
      var img = '<img src="' + p.url + '" width="' + p.w + '" height="' + p.h + '" alt="결재 문서 ' + (i + 1) + '쪽" loading="lazy" decoding="async">';
      return big ? img : '<button type="button" class="apvpg" data-apvpg="' + i + '" title="이 쪽 크게" aria-label="' + (i + 1) + '쪽 크게">' + img + '</button>';
    }).join('');
  }
  /** 화면을 그린 뒤(afterPaint) — 펼친 자리에 맡아 둔 그림을 붙이고, 아직 없으면 화면에 들어올 때 만들게 건다. */
  function apvMount() {
    var els = document.querySelectorAll('.apv[data-apv]');
    if (APV.io) APV.io.disconnect();          // 지난 화면의 (떨어져 나간) 자리는 잊는다
    if (!els.length) return;
    if (!APV.io && 'IntersectionObserver' in window) {
      APV.io = new IntersectionObserver(function (ents) {
        ents.forEach(function (en) {
          if (!en.isIntersecting) return;
          APV.io.unobserve(en.target);
          var el = en.target.closest('.apv');
          if (el && el.isConnected) apvWant(el);
        });
      }, { rootMargin: '240px 0px' });
    }
    Array.prototype.forEach.call(els, apvPaint);
  }
  function apvPaint(el) {
    if (!el.classList.contains('open')) return;
    var key = el.dataset.apv, c = APV.cache[key], box = el.querySelector('.apvpages');
    if (!box) return;
    if (c && c.pages) {
      if (box.dataset.k !== key) { box.innerHTML = apvPagesHtml(c.pages); box.dataset.k = key; }
      return;
    }
    if (c && c.err) { box.innerHTML = '<div class="apverr" role="status">' + esc(APV_FAIL) + '</div>'; box.dataset.k = key; return; }
    if (!box.firstChild) box.innerHTML = '<div class="apvwait" role="status"><div class="apvsk"></div><span>결재 문서를 그리는 중…</span></div>';
    if (c) return;                              // 만드는 중 — 끝나면 apvDone 이 붙인다
    if (APV.io) APV.io.observe(box); else apvWant(el);
  }
  function apvPump() {
    while (APV.busy < APV.MAX && APV.q.length) {
      var t = APV.q.shift();
      APV.busy++;
      t().then(function () { APV.busy--; apvPump(); });
    }
  }
  /** 그 결재 건 미리보기를 (아직이면) 만든다. front = 줄 맨 앞에(크게 보기). */
  function apvWant(el, front) {
    var key = el.dataset.apv, c = APV.cache[key];
    if (c) {
      if (front && c.task) { var qi = APV.q.indexOf(c.task); if (qi > 0) { APV.q.splice(qi, 1); APV.q.unshift(c.task); } }
      return c.p;
    }
    var kind = el.dataset.apvk, id = el.dataset.apvid;
    // 카드 폭에 맞춰 그린다(화소 비율 반영, 2배까지). 화면 폭이 바뀌어도 그림은 폭에 맞춰 줄고 는다.
    //   결재함 얇은 카드(2026-10-19)는 자리(.apv)가 상자 없이 줄에 녹아 있어 폭이 0 이다 — 쪽 상자 폭을 먼저 본다.
    var pbox = el.querySelector('.apvpages');
    var cssW = Math.min(1000, Math.max(280, (pbox && pbox.clientWidth) || el.clientWidth || 600));
    var job = APV.cache[key] = {};
    job.p = new Promise(function (ok) {
      job.task = function () {
        var prov = apvProv(kind);
        return Promise.resolve().then(function () {
          if (!prov) throw new Error('noprov');
          return prov(id);
        }).then(function (bytes) {
          job.bytes = bytes;
          return apvRender(bytes, cssW);
        }).then(function (pages) { job.pages = pages; }, function (e) { job.err = (e && e.message) || 'fail'; })
          .then(function () { job.task = null; ok(job); apvDone(key); });
      };
      if (front) APV.q.unshift(job.task); else APV.q.push(job.task);
      apvPump();
    });
    return job.p;
  }
  /** PDF 바이트 → 쪽마다 JPEG(object URL). 영수증 PDF 읽기와 같은 pdf.js(같은 출처 워커·eval 끔). */
  function apvRender(bytes, cssW) {
    var dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1)), px = Math.round(cssW * dpr);
    return loadPdfJs().then(function (pdfjs) {
      // pdf.js 가 받은 버퍼를 워커로 넘기며 비운다 — 사본을 준다.
      return pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
    }).then(function (doc) {
      var out = [], chain = Promise.resolve();
      for (var i = 1; i <= doc.numPages; i++) {
        (function (n) {
          chain = chain.then(function () { return doc.getPage(n); }).then(function (page) {
            var v1 = page.getViewport({ scale: 1 });
            var vp = page.getViewport({ scale: px / v1.width });          // 가로 문서(법인카드)도 폭에 맞춘다
            var cv = document.createElement('canvas');
            cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
            var cx = cv.getContext('2d');
            cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
            return page.render({ canvasContext: cx, viewport: vp }).promise
              .then(function () { page.cleanup(); return canvasToJpeg(cv); })
              .then(function (b) {
                if (!b) throw new Error('blob');
                out.push({ url: URL.createObjectURL(b), w: cv.width, h: cv.height });
                cv.width = cv.height = 0;
              });
          });
        })(i);
      }
      return chain.then(function () { doc.destroy(); return out; }, function (e) {
        doc.destroy();
        out.forEach(function (p) { URL.revokeObjectURL(p.url); });
        throw e;
      });
    });
  }
  /** 다 만들었으면 지금 화면에 있는 그 건의 자리(다시 그렸으면 새 자리)와 「크게 보기」 창에 붙인다. */
  function apvDone(key) {
    Array.prototype.forEach.call(document.querySelectorAll('.apv[data-apv]'), function (el) {
      if (el.dataset.apv !== key) return;
      var box = el.querySelector('.apvpages');
      if (box) { box.innerHTML = ''; box.dataset.k = ''; }
      apvPaint(el);
    });
    apvBigFill(key);
  }
  /** 「크게 보기」 — 옆 창에 쪽을 크게. 아래 「결재 문서 PDF」는 단추와 같은 창(내려받기·열기·인쇄)을 연다. */
  function apvBig(el, n) {
    var key = el.dataset.apv, kind = el.dataset.apvk, id = el.dataset.apvid;
    var card = el.closest('.acard');
    var who = card && card.querySelector('.ahd b'), cyc = card && card.querySelector('.ahd .acyc');
    openPanel('결재 문서 미리보기', [who && who.textContent, cyc && cyc.textContent].filter(Boolean).join(' · '),
      '<div id="apvBig" data-k="' + esc(key) + '" data-n="' + (n || 0) + '"><div class="pdfwait"><div class="spin"></div>' +
      '<div role="status">결재 문서를 그리는 중…</div></div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>' +
      '<button class="btn pri" ' + APV_PDFATTR[kind || ''] + '="' + esc(id) + '">' + ic('dl', 14) + 'PDF 받기</button>', true);
    apvWant(el, true);
    apvBigFill(key);
  }
  function apvBigFill(key) {
    var b = $('apvBig'), c = APV.cache[key];
    if (!b || b.dataset.k !== key || !c || (!c.pages && !c.err) || !$('panel').classList.contains('open')) return;
    if (c.err) { b.innerHTML = '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(APV_FAIL) + '</span></div>'; return; }
    b.innerHTML = '<div class="apvbig">' + apvPagesHtml(c.pages, true) + '</div>';
    var im = b.querySelectorAll('img')[+b.dataset.n || 0];
    if (im && +b.dataset.n) { im.loading = 'eager'; try { im.scrollIntoView({ block: 'start' }); } catch (e) { } }
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-apvtog],[data-apvbig],[data-apvpg]');
    var el = t && t.closest('.apv');
    if (!el) return;
    if (t.hasAttribute('data-apvtog')) {
      var open = !el.classList.contains('open'), box = el.querySelector('.apvpages');
      el.classList.toggle('open', open);
      t.setAttribute('aria-expanded', String(open));
      t.textContent = open ? '문서 접기' : '문서 보기';
      if (box) box.hidden = !open;
      var opsBox = el.querySelector('.apvops'); if (opsBox) opsBox.hidden = !open;      // 의견도 같이 펴고 접는다(2026-10-21)
      try { sessionStorage.setItem(apvSsKey(el.dataset.apvk, el.dataset.apvid), open ? '1' : '0'); } catch (er) { }
      if (open) apvPaint(el);
      return;
    }
    apvBig(el, t.hasAttribute('data-apvpg') ? +t.dataset.apvpg : 0);
  });

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
  /** 빈 상태 + 할 일 단추(act — HTML) 하나(2026-10-20 AU6-M5). 단추는 상자 안에 — 예전엔 음수 여백으로 상자 테두리에 걸쳐 그려졌다. */
  function blankAct(title, desc, icon, act) {
    return '<div class="panel"><div class="blank"><div class="ico">' + ic(icon || 'list', 21) + '</div>' +
      '<div class="t">' + esc(title) + '</div>' +
      (desc ? '<div class="d">' + esc(desc) + '</div>' : '') +
      (act ? '<div class="bact" style="margin-top:12px">' + act + '</div>' : '') + '</div></div>';
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
    // 빈 표의 「전체 보기」·「출퇴근 등 N건 보기」 — 목적까지 비운다(「조건 지우기」와 같게, 2026-10-20 AU6-M5: 예전엔 목적이 일반업무로 돌아가 헛단추)
    if (cf) cf.addEventListener('click', function () { clearFilters(); FILT.purp = ''; render(); });
    // 행이 많은 표만 자체 스크롤 + 머리글 고정. 짧은 표까지 가두면 답답하다.
    Array.prototype.forEach.call($('inner').querySelectorAll('.scroll[data-rows]'), function (w) {
      var n = w.querySelectorAll('tbody tr').length;
      w.classList.toggle('tall', n > 22);
      // 표가 오른쪽으로 더 있으면 감싼 상자(.panel)에 「더 있음」 그림자(좁은 화면 CSS 만 그린다, 2026-10-08)
      var box = w.parentNode, more = function () { box.classList.toggle('scrollmore', w.scrollWidth - w.clientWidth - w.scrollLeft > 2); };
      if (!w.dataset.moreOn) { w.dataset.moreOn = '1'; w.addEventListener('scroll', more, { passive: true }); }
      more();
    });
    apvMount();
    mselSync();             // 여러 줄 골라 지우기 — 고른 칸·띠를 다시 맞춘다(2026-10-19)
    finSyncAll();           // 결재 완료 출력 — 찾기·팀 칸 반쯤·전체 선택·묶기 단추(2026-10-23)
  }
  /** 하이패스 대조 — 고른 건수·합계와 확정 버튼만 제자리에서 고쳐 쓴다. */
  function paintHpCount() {
    HP.groups.forEach(function (g, gi) {
      var picked = (g.matched || []).filter(function (m) { return m.pick; });
      // 합계는 금액을 맞추는 것만 · 원본만 붙이기(keep)는 따로 센다(2026-10-23 hpSumHtml · hpBtnText)
      var lab = $('hpSum' + gi);
      if (lab) lab.innerHTML = hpSumHtml(g);
      var btn = document.querySelector('[data-hpapply="' + gi + '"]');
      if (btn) { btn.disabled = !picked.length; btn.textContent = hpBtnText(picked); }
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
      '<div class="dim" style="font-size:13px;line-height:1.7;max-width:430px;margin:0 auto">' +
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
    return cycleName(CYC) + (cycleApproved(u) ? ' 결재가 끝났어요' : ' 결재 중이에요');
  }
  /** 잠겼을 때 무엇을 하면 되는지. */
  function lockHow(u) {
    // 결재가 끝났다는 말은 앞 제목·문장(lockTitle·lockWhy)이 한다 — 여기서는 할 일만(2026-10-24 검수: 같은 말 두 번)
    if (cycleApproved(u)) return '정정이 필요하면 관리자에게 문의해 주세요.';
    var a = APPR.filter(function (x) { return x.username === u && x.cycle === CYCKEY() && x.status === 'submitted'; })[0];
    return a ? withdrawHow(a) : '고치려면 ‘이번 달 마감’에서 <b>회수</b>한 뒤 다시 상신하세요.';
  }
  /**
   * 결재 중인 건을 고치려면 무엇을 해야 하는지. 아무도 승인하지 않았으면 회수, 한 분이라도 승인했으면
   * 회수가 막히므로 '지금 차례인 분에게 반려를 요청'(그분만 반려할 수 있다).
   */
  function withdrawHow(a) {
    var anyDone = (a.steps || []).some(function (x) { return x.result; });
    if (!anyDone) return '고치려면 ‘이번 달 마감’에서 <b>회수</b>한 뒤 다시 상신하세요.';
    var cur = (a.steps || []).filter(function (x) { return x.seq === a.cur_seq; })[0];
    return '이미 승인한 결재자가 있어 회수할 수 없어요. 고치려면 ' +
      (cur ? '지금 차례인 <b>' + esc(cur.name || nameOf(cur.approver)) + '</b> 님에게' : '지금 차례인 결재자에게') + ' 반려를 요청하세요.';
  }
  /** 영수증 화면(2단계)을 지금 단계(1단계)보다 먼저 연 것인가 — 맨 아래 띠가 「지금은 1단계 차례」라고 말하는 경우와 같은 조건. */
  function evAhead() {
    return VIEW === 'evid' && !isAll() && !isMulti() && !cycleLocked(myName()) && Math.min(stepNow(), 3) < 2;
  }
  /** 결재 중인 기간을 고치는 방법 한 줄(글만, 마감 첫 화면 큰 제목 아래 — 2026-10-19). */
  function fixHowPlain(a) {
    if (!a) return '';
    var anyDone = (a.steps || []).some(function (x) { return x.result; });
    if (!anyDone) return '고치려면 회수한 뒤 다시 상신하세요.';
    var cur = (a.steps || []).filter(function (x) { return x.seq === a.cur_seq; })[0];
    return '고치려면 ' + (cur ? (cur.name || nameOf(cur.approver)) + ' 님에게' : '지금 차례인 결재자에게') + ' 반려를 요청하세요.';
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
    // 업무 운행에서 0원은 운행 고치기에서 고른 「없음」이다 — 출퇴근 등의 「면제」와 구분한다(2026-10-16 3차)
    if (Number(t.toll_cost) === 0) return '<span class="st dim">' + ((t.purpose || '') === BUSINESS ? '없음' : '면제') + '</span>';
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
      var r = cycleRange(c), key = cycKey(c);
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
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>' + n0(rows.length) + '개 기간 합계' +
      (all ? ' · 전 직원' : '') + '</div>' +
      '<p class="verdict">업무용 비용 <em>' + won(sum.cost) + '</em></p><div class="facts">' +
      fact('운행', n0(sum.n) + '<small>건</small>', km(sum.km) + ' km') +
      fact('유류비', won(sum.fuel), '거리 × 분기·지역 단가') +
      fact('통행료 · 주차', won(sum.toll + sum.park), '통행료 ' + won(sum.toll) + ' · 주차비 ' + won(sum.park)) +
      fact('기간 평균', won(withData ? sum.cost / withData : 0), '운행이 있는 ' + n0(withData) + '개 기간 기준') +
      '</div></div>';

    h += sect('기간별', rows.length + '개 기간', '',
      '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>월분</th><th>기간</th><th class="n">운행</th><th class="n">거리</th><th class="n">유류비</th>' +
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
        return '<tr class="clk" tabindex="0" data-cyc="' + cycKey(x.c) + '" title="' + esc(cycleName(x.c)) + ' 보기">' +
          '<td><span class="lead">' + cycleName(x.c) + '</span></td>' +
          '<td class="dim">' + esc(cycleSpan(x.c)) + '</td>' +
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

    h += '<div class="anote">합계는 <b>기간별 합계를 더한 값</b>이고, 통행료 미확정은 0원으로 계산했어요. ' +
      '줄을 누르면 그 기간으로 가서 상신, 결재 문서, 영수증 올리기를 할 수 있어요.</div>';
    return h;

    function fact(k, v, sub) {
      return '<div class="fact"><div class="k">' + esc(k) + '</div><div class="v">' + v +
        '</div><div class="sub">' + esc(sub || '') + '</div></div>';
    }
  }

  /** 이번 주기에 업무 운행했는데 계기판 사진이 없는 차량(번호판 목록). 서버 검증 R12 와 같은 기준. */
  function odoPhotoMissing() {
    var me = myName(), r = cycleRange(CYC);
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

  /** 이번 달 마감 맨 위 반려 사유 띠 — 반려된 기간에만(정정 열기 포함). 3단계 검증 화면의 띠와 같은 모양. */
  function rejBandHtml() {
    var a = myAppr();
    if (!a || a.status !== 'rejected') return '';
    var rsx = apprStatusText(a);
    // 상태 글(반려 사유로 끝남)과 할 일 사이에 마침표 한 번(2026-10-24 검수 — 줄표를 뺀 자리에서 두 글이 붙어 읽혔다)
    return '<div class="hpnote warn" data-rejband>' + ic('alert', 16) + '<span><b>' + esc(/다시 상신/.test(rsx.t) ? rsx.t : endDot(rsx.t)) + '</b>' +
      (/다시 상신/.test(rsx.t) ? '' : ' 고친 뒤 ‘검증·상신’ 단계에서 다시 상신하세요.') + '</span></div>';
  }
  /* ══════════════════ 마감 현황 ══════════════════ */
  function viewClose() {
    if (!LOADED) return head(isAll() ? '현황' : '이번 달 마감') + skeleton();
    if (isMulti()) return viewPeriod();
    var T = totals(TRIPS, isAll() ? { allUsers: true } : { who: myName() }), A = audit();
    var bads = A.filter(function (f) { return f.sev === 'bad' && f.n > 0; });
    var badN = bads.reduce(function (s, f) { return s + f.n; }, 0);
    var r = cycleRange(CYC), now = Date.now();
    var pct = Math.max(0, Math.min(100, Math.round((now - r.lo) / (r.hi - r.lo) * 100)));
    var days = dueDays(r, now);
    var closed = now >= r.hi;

    // 한 문장의 판정 — 숫자 네 개보다 이게 먼저다
    var verdict, clean = '';
    // 결재 중이거나 끝났으면 고칠 수도 채울 수도 없다 — 손보라고 시키지 않는다.
    var approved = !isAll() && cycleLocked(myName());
    var notSent = !isAll() && !myAppr();
    if (approved) {
      // 끝난 것(초록)과 결재 중(주황)은 다른 상태다 — 같은 색이면 '다 됐다'로 읽는다.
      if (cycleApproved(myName())) { verdict = '<em>결재가 끝났어요</em>'; clean = ' clean'; }
      else { verdict = '<em>결재 중이에요</em>'; clean = ' wait'; }
    } else if (badN) {
      verdict = '고칠 기록이 <em>' + n0(badN) + '건</em> 있어요';
    } else if (T.unk) {
      verdict = '통행료 <em>' + n0(T.unk) + '건</em>을 채우고 상신하면 끝나요';
    } else if (!T.n) {
      verdict = '아직 기록된 운행이 없어요'; clean = ' clean';
    } else {
      verdict = notSent && closed ? '<em>고칠 기록이 없어요.</em> 상신하세요' : '<em>고칠 기록이 없어요</em>'; clean = ' clean';
    }

    // 본인 마감 화면의 제목 줄은 homeA 가 그린다(오른쪽에 지금 단계 단추 — 2026-10-20 디자인 v2). 여기서는 그 위·아래 띠만 모은다.
    var h = !isAll() ? '' : head('현황',
      orgFilterOn() ? esc(orgScopeName()) + ' ' + Object.keys(USERS).filter(function (u) { return USERS[u].uses_driving !== false && orgMatch(u); }).length + '명'
        : '전체 직원 ' + Object.keys(USERS).filter(function (u) { return USERS[u].uses_driving !== false; }).length + '명');

    // 공지 띠 「통행료·주차비 영수증 필수」(2026-10-15 2차 — 닫으면 이 브라우저에 기억)
    // 반려된 기간이면 반려 사유가 맨 위(공지·계기판 안내보다 먼저, 2026-10-16 3차)
    if (!isAll()) h += rejBandHtml();
    if (!isAll()) h += noticeBand();
    // 21일이 지나 들어오면 새 주기가 먼저 뜬다. 지난달분을 아직 안 올렸으면 그것부터 알려 준다.
    var pp = prevPending();
    if (pp) {
      h += '<div class="hpnote warn">' + ic('alert', 16) + '<span><b>' + esc(cycleName(pp.cyc)) + '(' +
        esc(cycleSpan(pp.cyc)) + ')</b>' + (pp.cyc.x ? '를 ' : '을 ') +
        (pp.a && pp.a.status === 'rejected' && reopenInfo(pp.a) ? '관리자가 정정으로 다시 열었어요. 고친 뒤 다시 상신해 주세요.'   // 정정 열기는 반려가 아니다(2026-10-15)
          : pp.a && pp.a.status === 'rejected' ? '반려받은 뒤 아직 다시 상신하지 않았어요.'
          : pp.a && pp.a.status === 'withdrawn' ? '회수한 뒤 아직 다시 상신하지 않았어요.' : '아직 상신하지 않았어요.') +
        '</span><button class="btn sm" data-cyc="' + cycKey(pp.cyc) + '">' + CR.short(pp.cyc) + ' 마감하기</button>' +
        '<button class="iconbtn" data-prevx="' + esc(pp.key) + '" aria-label="이 안내 닫기" title="이 안내 닫기">' + ic('close', 14) + '</button></div>';
    }

    // ★ 계기판 사진 안내(2026-10-07)는 「남은 일」 한 줄이 됐다(2026-10-20 디자인 v2 — closeTasks 의 odo, 같은 기준 odoPhotoMissing).

    if (!isAll()) return homeA(T, A, badN, approved, closed, days, h);
    h += '<div class="hero fade">' +
      '<div class="eyebrow"><span class="dot' + (clean === ' clean' ? ' ok' : '') + '"></span>' + esc(cycleName(CYC)) +
      ' · ' + esc(cycleSpan(CYC)) + '</div>' +
      '<p class="verdict' + clean + '">' + verdict + '</p>' +
      '<div class="track' + (closed ? ' done' : '') + '"><i style="width:' + pct + '%"></i></div>' +
      '<div class="facts">' +
      fact('마감', closed ? (daysPast(r, now) <= CR.graceDays() ? daysPast(r, now) + '일 지남' : '종료') : (days <= 0 ? '오늘' : 'D-' + days),
        closed ? esc(cycleSpan(CYC)) + ' 종료' : pct + '% 지남') +
      fact('운행', n0(T.n) + '<small>건</small>', km(T.km) + ' km' + (T.manual ? ' · 수기 ' + n0(T.manual) : '')) +
      fact('업무용 비용', won(T.cost), '유류비 ' + won(T.fuel) + ' · 통행료 ' + won(T.toll)) +
      // 잠긴 뒤에는 채울 수 없다 — 빨갛게 '여기를 보라'고 하지 않고, 어떻게 올라갔는지만 적는다.
      fact('통행료 미확정', n0(T.unk) + '<small>건</small>',
        T.unk ? (approved ? '0원으로 상신됨' : '0원으로 정산') : '전부 확정', T.unk > 0 && !approved) +
      '</div></div>';

    // 결재 — 히어로 바로 아래. 이 주기가 지금 어디까지 갔는지가 제일 궁금하다.
    h += apprStrip();

    // 점검 요약 — 문제가 있을 때만, 있으면 크게.
    //  결재가 끝났으면 어차피 못 고치니 시키지 않는다.
    if ((badN || T.unk) && !approved) {
      var list = A.filter(function (f) { return f.n > 0; }).slice(0, 4);
      h += sect('바로 봐야 할 것', null,
        '<button class="btn sm" data-keeporg data-v="' + (isAll() ? 'a_check' : 'check') + '">전체 점검 ' +
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

  /* ══════════════════ 이번 달 마감 = 남은 일 목록(2026-10-20 디자인 v2 — P_Close · M_Close) ══════════════════
     「지금 할 일」 큰 글 대신, 이 화면이 이미 계산하는 것(금액 규칙 v3 moneyOf · 기록 점검 auditOf · 계기판 사진 odoPhotoMissing ·
     주유 영수증 · 통행료 미확정 · 사진 없는 영수증)을 한 줄에 한 가지 일로 늘어놓는다. 줄의 단추는 모두 기존 길(그 화면·그 차례·기존 창)뿐 —
     새 동작은 없다. 서버 검증(R06·R10·R13·R14·R02·R12·R11·R07·R01·R04)과 같은 기준이다.
       위: 제목 줄(오른쪽 = 지금 단계 단추 하나, 빨강) → 마감 단계 4칸
       가운데: 남은 일(8칸) + 정산 예정 금액(4칸)
       아래: 결재 띠(3단계·상신한 적 있음) → 최근 운행(증빙 딱지)
       폰: 아래 고정 「다음 할 일」(첫 남은 일, 없으면 지금 단계)
     상신한 기간(결재 중·완료)은 고칠 수 없으니 남은 일 대신 상태 한 줄(예전과 같은 말). */
  var DOWK = ['일', '월', '화', '수', '목', '금', '토'];
  /** 'YYYY-MM-DD' → 'MM.DD(요)' */
  function dayDow(k) { var p = String(k).split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); return p[1] + '.' + p[2] + '(' + DOWK[d.getUTCDay()] + ')'; }
  /** 남은 일 단추 { t 글, a 속성, i 아이콘, danger, hp(하이패스 PDF 고르기 — 영수증 화면 통행료 차례와 같은 #hpQuick) } */
  function ctBtn(b, cls) {
    if (!b) return '';
    if (b.hp) return '<label class="btn' + (cls ? ' ' + cls : '') + '" data-hpquick>' + ic('upload', 15) + esc(b.t) +
      '<input type="file" id="hpQuick" accept="application/pdf,.pdf" multiple class="sr"></label>';
    return '<button type="button" class="btn' + (b.danger ? ' danger' : '') + (cls ? ' ' + cls : '') + '" ' + b.a + '>' + (b.i ? ic(b.i, 15) : '') + esc(b.t) + '</button>';
  }
  /** 지금 단계 — 제목 줄 오른쪽 단추·남은 일 맨 위 한 줄·폰 「다음 할 일」(남은 일이 없을 때). 상신한 기간·빈 기간은 null. */
  function closeStep(S, closed) {
    var cur = S.cur;
    if (S.sent || (cur === 0 && !S.trips.length && !S.ev.length)) return null;
    if (cur === 0) {
      // 「2 영수증·통행료 →」 단추는 이 화면이 아니라 운행 기록·기록 점검 화면 맨 아래에 있다 — 그 화면을 말한다(2026-10-20 V3 U2)
      if (S.fixBad) return { n: 1, t: '운행 기록 ' + n0(S.fixBad) + '건을 먼저 고치세요',
        d: '계기판 값이 튀거나 목적이 비어 있으면 비용이 잘못 계산돼요. 기록을 고친 뒤 ‘영수증·통행료’ 단계로 넘어가세요.',
        b: { t: '기록 ' + n0(S.fixBad) + '건 고치기', a: 'data-v="check"', i: 'list' } };
      // 운행 기록 화면은 「일반업무」로 걸러져 열린다 — 같은 수를 말한다(전체 6건이라 해 놓고 4건이 보였다, 2026-10-19 로봇)
      var biz = S.trips.filter(function (t) { return (t.purpose || '') === BUSINESS; }).length;
      return { n: 1, t: '운행 기록을 확인하세요',
        d: '업무 운행 ' + n0(biz) + '건' + (biz !== S.trips.length ? '(전체 ' + n0(S.trips.length) + '건)' : '') + '이 맞는지 확인하고 ‘영수증·통행료’ 단계로 넘어가세요.',
        b: { t: '운행 기록 확인하기', a: 'data-v="trips"', i: 'list' } };
    }
    if (cur === 1) return { n: 2, t: '영수증·통행료를 차례대로 정리하세요', d: '주차, 통행료, 주유, 계기판 순서로 하나씩 확인하세요.',
      b: { t: '영수증·통행료 정리하기', a: 'data-v="evid"', i: 'receipt' } };
    return { n: 3, t: S.status === 'rejected' ? '고쳐서 다시 검증하고 상신하세요' : '기록을 정리했어요. 검증하고 상신하세요',
      d: closed ? '검증에서 AI가 영수증 사진과 입력값을 비교해요. 끝나면 결재선을 골라 상신하세요.' : '기간 중에도 상신할 수 있지만, 상신하면 이 기간의 기록은 고칠 수 없어요.',
      b: { t: '검증하고 상신하기', a: 'data-v="verify"', i: 'check' } };
  }
  /** 이번 기간 남은 일(고칠 수 있는 기간에만) → { list: [{ k, sev, t, d, b1, b2, nx }], done: [{ t, d }], M(moneyOf) }.
   *  순서: 손봐야 할 기록 → 영수증 없는 날 → 금액 다른 날 → 계기판 사진 → 운행 없는 날 영수증 → 두 번 정산 의심 → 통행료 미확정 → 주유 → 사진 없음 → 확인할 기록. */
  function closeTasks(S, A) {
    var me = myName(), r = cycleRange(CYC), M = moneyOf(me, r, ALL_TRIPS, ALL_EVID), CATS = ['통행료', '주차'];
    var won0 = function (v) { return n0(v) + '원'; }, list = [], done = [];
    var audits = (A || []).filter(function (f) { return f.n > 0 && f.k !== 'unk'; });
    var auditTask = function (f) {
      return { k: 'audit-' + f.k, sev: f.sev === 'bad' ? 'bad' : 'warn', t: f.t + ' ' + n0(f.n) + '건', d: f.d,
        b1: f.rows && f.rows.length ? { t: '운행 기록에서 보기', a: 'data-issue="' + f.k + '"', i: 'list' } : null, nx: f.t };
    };
    audits.filter(function (f) { return f.sev === 'bad'; }).forEach(function (f) { list.push(auditTask(f)); });
    // 영수증 없는 날(R06) — 통행료 먼저(하이패스 PDF 한 번으로 한 달 치가 된다)
    CATS.forEach(function (cat) {
      var days = M[cat].days.filter(function (d) { return d.show && d.st === 'no_receipt'; });
      if (!days.length) return;
      var word = cat === '통행료' ? '통행료' : '주차비', sum = days.reduce(function (a, d) { return a + d.T; }, 0);
      var same = days.every(function (d) { return d.T === days[0].T; });
      list.push({ k: 'norcp-' + cat, sev: 'bad', t: cat + ' 영수증이 없는 날 ' + n0(days.length) + '일',
        d: days.slice(0, 4).map(function (d) { return dayDow(d.day); }).join(' · ') + (days.length > 4 ? ' 외 ' + n0(days.length - 4) + '일' : '') +
          ', 운행 ' + word + ' ' + (same ? (days.length > 1 ? '각 ' : '') + won0(days[0].T) : '합계 ' + won0(sum)),
        b1: { t: '사진 올리기', a: 'data-evupcat="' + cat + '"', i: 'camera' },
        b2: cat === '통행료' ? { t: '하이패스 PDF', hp: 1 } : { t: '영수증 보기', a: 'data-evstep="' + cat + '"', i: 'eye' }, nx: cat + ' 영수증' });
    });
    // 금액이 다른 날(R10) — 하루 단위 차이만(특정 운행 금액은 제안하지 않는다, money-rule.js adviceOf 와 같은 원칙)
    var mm = [];
    CATS.forEach(function (cat) { M[cat].days.forEach(function (d) { if (d.show && d.st === 'mismatch') mm.push({ cat: cat, d: d }); }); });
    if (mm.length) {
      var evTxt = function (d) { var U = d.R - (d.D || 0); return d.H ? '하이패스 ' + won0(d.H) + (U ? ' + 영수증 ' + won0(U) : '') : '영수증 ' + won0(d.R); };
      var tg = mm[0].d.target || mm[0].d.trips[0];
      list.push({ k: 'diff', sev: 'bad', t: '금액이 다른 날 ' + n0(mm.length) + '일',
        d: mm.slice(0, 2).map(function (x) { return dayDow(x.d.day) + ' ' + x.cat + ' 운행 ' + won0(x.d.T) + ' · ' + evTxt(x.d); }).join(' / ') +
          (mm.length > 2 ? ' 외 ' + n0(mm.length - 2) + '일' : '') + '. 어느 쪽이 맞는지 확인해 주세요.',
        b1: tg ? { t: '운행 금액 고치기', a: 'data-edit="' + esc(String(tg.id)) + '"', i: 'edit' } : null,
        b2: { t: '영수증 보기', a: 'data-evstep="' + mm[0].cat + '"', i: 'eye' }, nx: '금액이 다른 날' });
    }
    // 계기판 사진 없음(R12) — 예전 마감 화면 띠와 같은 기준
    var miss = odoPhotoMissing();
    if (miss.length) list.push({ k: 'odo', sev: 'bad',
      t: '계기판 사진이 없어요' + (miss.length > 1 || miss[0] ? ' (' + miss.map(function (p) { return p || '차량 미지정'; }).join(', ') + ')' : ''),
      d: '마지막 운행 후 계기판 사진을 올려 주세요. 검증 때 운행일지 최종 km와 비교해요.',
      b1: { t: '계기판 사진 올리기', a: 'data-odoshot="1"', i: 'camera' }, nx: '계기판 사진' });
    // 운행 없는 날 영수증(R13) — 정산에서 빠짐
    var nt = [];
    CATS.forEach(function (cat) { M[cat].days.forEach(function (d) { if (d.show && d.st === 'no_trip') d.ev.forEach(function (e) { nt.push({ cat: cat, d: d, e: e }); }); }); });
    if (nt.length) {
      nt.sort(function (a, b) { return a.d.day < b.d.day ? -1 : a.d.day > b.d.day ? 1 : 0; });
      var e0 = nt[0], ntSum = nt.reduce(function (a, x) { return a + (Number(x.e.amount) || 0); }, 0);
      // 주차·통행료가 섞여 있으면 창도 두 구분을 함께(2026-10-20 V3 B4 — 주차 창만 열려 통행료 영수증이 목록에 없었다)
      var ntCats = CATS.slice().reverse().filter(function (c) { return nt.some(function (x) { return x.cat === c; }); });
      list.push({ k: 'notrip', sev: 'warn', t: '운행 없는 날 영수증 ' + n0(nt.length) + '장 · ' + won0(ntSum),
        d: nt.slice(0, 3).map(function (x) { return dayDow(x.d.day) + ' ' + x.cat + ' ' + won0(x.e.amount); }).join(' · ') +
          (nt.length > 3 ? ' 외 ' + n0(nt.length - 3) + '장' : '') + '. 그날 업무 운행이 없어 정산에서 빠져요.',
        b1: { t: '다른 운행에 붙이기', a: 'data-evlink="' + ntCats.join(',') + '" data-evlinkid="' + esc(String(e0.e.id)) + '"', i: 'link' },
        b2: nt.length === 1 ? { t: '지우기', a: 'data-evdel="' + esc(String(e0.e.id)) + '"', i: 'trash', danger: 1 } : { t: '영수증 보기', a: 'data-evstep="' + e0.cat + '"', i: 'eye' },
        nx: '운행 없는 날 영수증' });
    }
    // 두 번 정산 의심(R14) — 자동으로 옮기지 않고 안내(2026-10-20 사용자 결정 ②)
    var tw = [];
    CATS.forEach(function (cat) { M[cat].days.forEach(function (d) { if (d.show && d.twice && d.twice.ev.length) tw.push({ cat: cat, d: d }); }); });
    if (tw.length) list.push({ k: 'twice', sev: 'warn', t: '두 번 정산 의심 ' + n0(tw.length) + '일',
      d: tw.slice(0, 2).map(function (x) { return dayDow(x.d.day) + ' ' + x.cat + ' 영수증 ' + won0(x.d.twice.amount) + '(전날 ' + x.d.twice.prev.slice(5).replace('-', '.') + ' 운행 금액과 같음)'; }).join(' / ') +
        '. 전날 운행 영수증이면 그 운행에 연결해 주세요.',
      b1: { t: '다른 운행에 붙이기', a: 'data-evlink="' + tw[0].cat + '" data-evlinkid="' + esc(String(tw[0].d.twice.ev[0].id)) + '"', i: 'link' },
      b2: { t: '영수증 보기', a: 'data-evstep="' + tw[0].cat + '"', i: 'eye' }, nx: '두 번 정산 의심' });
    // 같은 금액 영수증(2026-10-21 통행료 버그 2) — 영수증으로 채울 날인데 같은 금액 영수증이 여러 장 → 영수증 적기가 적기 전에 묻는다
    var dq = myCycLocked() ? [] : dupFillDays(M).filter(function (x) { return x.ask.length && x.d.show; });
    if (dq.length) list.push({ k: 'dupfill', sev: 'warn', t: '같은 금액 영수증 확인 ' + n0(dq.length) + '일',
      d: dq.slice(0, 2).map(function (x) { return dayDow(x.d.day) + ' ' + x.cat + ' ' + x.ask.map(function (g) { return won0(g.a) + ' ' + n0(g.ev.length) + '장'; }).join(' · '); }).join(' / ') +
        (dq.length > 2 ? ' 외 ' + n0(dq.length - 2) + '일' : '') + '. 같은 영수증을 두 번 올렸는지, 실제로 여러 번 냈는지 골라 주세요.',
      b1: { t: '확인하기', a: 'data-dupfill="' + esc(dq[0].cat + '|' + dq[0].d.day) + '"', i: 'check' },
      b2: { t: '영수증 보기', a: 'data-evstep="' + dq[0].cat + '"', i: 'eye' }, nx: '같은 금액 영수증' });
    // 통행료 미확정(R02) — 자동 계산이 안 된 업무 운행
    var unk = S.trips.filter(function (t) { return isUnknownToll(t) && (t.purpose || '') === BUSINESS; }).sort(function (a, b) { return a.start_time - b.start_time; });
    if (unk.length) list.push({ k: 'unk', sev: 'warn', t: '통행료 미확정 운행 ' + n0(unk.length) + '건',
      d: unk.slice(0, 3).map(function (t) { return md(t.start_time) + ' ' + (t.visit_place || placeShort(t.end_address) || '방문처 없음'); }).join(' · ') +
        (unk.length > 3 ? ' 외 ' + n0(unk.length - 3) + '건' : '') + '. 냈으면 영수증을 올리고, 안 냈으면 운행에서 ‘없음’을 고르세요.',
      b1: { t: '통행료 차례로', a: 'data-evstep="통행료"', i: 'ticket' }, b2: { t: '운행 고치기', a: 'data-edit="' + esc(String(unk[0].id)) + '"', i: 'edit' },
      nx: '통행료 미확정' });
    // 주유 영수증(R11) — 청구 유류비(업무 거리 × 단가)보다 적음. 2단계 주유 차례의 맞춰보기와 같은 계산
    var biz = S.trips.filter(function (t) { return (t.purpose || '') === BUSINESS; });
    var claim = Math.round(biz.reduce(function (a, t) { return a + tripFuel(t); }, 0));
    var fuelEv = S.ev.filter(function (e) { return e.category === '주유' && (Number(e.amount) || 0) > 0; });
    var paid = fuelEv.reduce(function (a, e) { return a + (Number(e.amount) || 0); }, 0);
    if (claim > paid + 1) list.push({ k: 'fuel', sev: 'warn', t: paid ? '주유 영수증이 청구 유류비보다 적어요' : '주유 영수증이 없어요',
      d: '청구 유류비 ' + won0(claim) + ' · 주유 영수증 ' + won0(paid) + (fuelEv.length ? '(' + n0(fuelEv.length) + '장)' : '') + '. 빠진 주유 영수증을 올려 주세요.',
      b1: { t: '주유 영수증 올리기', a: 'data-evupcat="주유"', i: 'receipt' }, nx: '주유 영수증' });
    // 사진 없는 영수증(R07)
    var noPh = S.ev.filter(function (e) { return Number(e.amount) > 0 && !e.photo_path; });
    if (noPh.length) list.push({ k: 'nophoto', sev: 'warn', t: '사진 없는 영수증 ' + n0(noPh.length) + '장',
      d: '사진이 없으면 결재 문서에 빈칸으로 나가요. 앱에서 사진을 첨부하거나, 지우고 다시 올려 주세요.',
      b1: { t: '영수증 보기', a: 'data-v="evid"', i: 'eye' }, nx: '사진 없는 영수증' });
    audits.filter(function (f) { return f.sev !== 'bad'; }).forEach(function (f) { list.push(auditTask(f)); });
    // 끝난 일 — 확인한 것만(남은 일이 있는 구분은 넣지 않는다)
    if (S.cur >= 1) done.push({ t: '운행 기록 확인', d: '업무 운행 ' + n0(biz.length) + '건 · ' + km(biz.reduce(function (a, t) { return a + (Number(t.distance_km) || 0); }, 0)) + ' km' });
    CATS.slice().reverse().forEach(function (cat) {
      var sh = M[cat].days.filter(function (d) { return d.show && (d.T || d.R || d.H); });
      if (!sh.length || sh.some(function (d) { return d.st === 'no_receipt' || d.st === 'mismatch' || d.st === 'no_trip' || d.twice; })) return;
      if (dq.some(function (x) { return x.cat === cat; })) return;          // 같은 금액 영수증 확인이 남은 구분
      done.push({ t: cat + ' 증빙 ' + n0(sh.length) + '일 맞음', d: sh.slice(0, 5).map(function (d) { return dayDow(d.day); }).join(' · ') + (sh.length > 5 ? ' 외 ' + n0(sh.length - 5) + '일' : '') });
    });
    if (claim > 0 && claim <= paid + 1) done.push({ t: '주유 영수증 ' + n0(fuelEv.length) + '장', d: '주유 영수증 ' + won0(paid) + ' ≥ 청구 유류비 ' + won0(claim) });
    if (!miss.length && biz.some(function (t) { return t.end_odometer != null; })) done.push({ t: '계기판 사진', d: '업무 운행 차량 모두 올림' });
    return { list: list, done: done, M: M };
  }
  /** 남은 일 카드(8칸). */
  function closeTasksHtml(TK, step) {
    var h = '<section class="ccard ctasks" aria-label="남은 일" data-ctasks><div class="chd"><h2>남은 일<small>' + n0(TK.list.length) + '건</small></h2>' +
      '<span class="note">남은 일이 있어도 상신할 수 있고, 결재자에게도 보여요.</span></div>' +
      (step ? '<p class="cnowl" data-cstep><b>지금 ' + step.n + '단계 · ' + esc(step.t) + '</b><span>' + esc(step.d) + '</span></p>' : '');
    h += TK.list.length ? '<ul class="ctlist">' + TK.list.map(function (x) {
      return '<li class="ctask ' + x.sev + '" data-ctask="' + esc(x.k) + '">' + ic('alert', 20) +
        '<span class="ctt"><b>' + esc(x.t) + '</b><span>' + esc(x.d) + '</span></span>' +
        '<span class="ctb">' + ctBtn(x.b1) + ctBtn(x.b2) + '</span></li>';
    }).join('') + '</ul>' : '<div class="cnone">' + ic('check', 18) + '남은 일이 없어요</div>';
    if (TK.done.length) h += '<details class="cdone"><summary><b>끝난 일 ' + n0(TK.done.length) + '</b>' +
      TK.done.slice(0, 4).map(function (x) { return '<span class="ci">' + ic('check', 14) + esc(x.t) + '</span>'; }).join('') +
      '<span class="cm" aria-hidden="true"></span></summary><ul>' + TK.done.map(function (x) {
        return '<li>' + ic('check', 14) + '<span><b>' + esc(x.t) + '</b>' + (x.d ? ': ' + esc(x.d) : '') + '</span></li>';
      }).join('') + '</ul></details>';
    return h + '</section>';
  }
  /** 정산 예정 금액 카드(4칸) — 이름 왼쪽·숫자 오른쪽. totals(금액 규칙 v3)와 같은 숫자(영수증 화면 「정산에 들어가는」 금액과 같다). */
  function closeMoneyHtml(T, closed, st) {
    var other = T.n - T.biz, chip = st === 'rejected' ? ['반려됨', ' bad'] : st === 'withdrawn' ? ['회수함', ''] : ['상신 전', ''];
    var dim = function (on) { return on ? ' <small class="dim">(영수증 포함)</small>' : ''; };
    return '<section class="ccard cmoney" aria-label="정산 예정 금액" data-cmoney><div class="chd"><h2>정산 예정 금액</h2><span class="dchip' + chip[1] + '">' + chip[0] + '</span></div>' +
      '<div class="cbig"><span>' + (closed ? '업무용 비용' : '업무용 비용(지금까지)') + '</span><b data-k="cost">' + n0(T.cost) + '<small>원</small></b></div>' +
      '<dl class="cdl"><dt>유류비</dt><dd data-k="fuel">' + n0(T.fuel) + '</dd><dt>통행료' + dim(T.evToll) + '</dt><dd data-k="toll">' + n0(T.toll) + '</dd>' +
      '<dt>주차비' + dim(T.evPark) + '</dt><dd data-k="park">' + n0(T.park) + '</dd><dt class="tot">합계</dt><dd class="tot">' + n0(T.cost) + '</dd></dl>' +
      '<div class="csep"></div><dl class="cdl"><dt>운행</dt><dd>' + n0(T.n) + '건 · ' + km(T.km) + ' km</dd>' +
      '<dt>업무 운행</dt><dd>' + n0(T.biz) + '건 · ' + km(T.bizKm) + ' km</dd>' +
      (other ? '<dt>출퇴근 등</dt><dd>' + n0(other) + '건 · ' + km(T.km - T.bizKm) + ' km</dd>' : '') +
      (T.manual ? '<dt>수기 입력</dt><dd>' + n0(T.manual) + '건</dd>' : '') + '</dl>' +
      '<p class="cfoot">금액은 원 단위이고, 상신할 때 한 번 더 계산해요.</p></section>';
  }
  /** 마감 화면 「최근 운행」 — 날짜 · 시간 · 구분 · 방문처 · 차량 · 거리 · 통행료 · 증빙(딱지). 폰은 두 줄 카드(table.mc).
   *  증빙 = 그날 금액 규칙 v3 결과(통행료·주차 중 나쁜 쪽): 영수증 없음 · 금액 다름 · 두 번 정산 의심 · 맞음 / 통행료 미확정 / 업무가 아니거나 금액 없는 날 —. */
  function closeTripTable(rows, M) {
    if (!rows.length) return blank('이 기간에 운행 기록이 없어요.', null, 'list');
    var flags = flaggedIds(), of = {}, RK = { no_receipt: 4, mismatch: 3, twice: 2, dup: 2, ok: 1 };
    // 같은 금액 영수증 확인을 기다리는 날(2026-10-21 통행료 버그 2) — 「맞음」 대신 「같은 금액 확인」
    var dupDay = {};
    if (M && !myCycLocked()) dupFillDays(M).forEach(function (x) { if (x.ask.length) dupDay[x.cat + '|' + x.d.day] = 1; });
    ['통행료', '주차'].forEach(function (cat) {
      ((M && M[cat] && M[cat].days) || []).forEach(function (d) {
        var k = !d.show ? '' : d.st === 'no_receipt' ? 'no_receipt' : d.st === 'mismatch' ? 'mismatch' : d.twice ? 'twice' : dupDay[cat + '|' + d.day] ? 'dup'
          : d.st === 'match' || d.st === 'filled' ? 'ok' : '';
        if (k) d.trips.forEach(function (t) {
          if (!(d.amt[t.id] > 0) && !(d.fill[t.id] > 0)) return;          // 그날 금액이 없는 운행에는 붙이지 않는다
          if (!of[t.id] || RK[k] > RK[of[t.id]]) of[t.id] = k;
        });
      });
    });
    var CH = { no_receipt: ['영수증 없음', 'bad'], mismatch: ['금액 다름', 'warn'], twice: ['두 번 정산 의심', 'warn'], dup: ['같은 금액 확인', 'warn'], ok: ['맞음', 'ok'] };
    var evCell = function (t) {
      if ((t.purpose || '') !== BUSINESS) return '<span class="dim">—</span>';
      if (isUnknownToll(t)) return '<span class="dchip warn">통행료 미확정</span>';
      var k = of[t.id];
      return k ? '<span class="dchip ' + CH[k][1] + '">' + CH[k][0] + '</span>' : '<span class="dim">—</span>';
    };
    var h = '<div class="panel"><div class="scroll" data-rows><table class="mc ctrip"><thead><tr><th>날짜</th><th class="n">시간</th><th>구분</th><th>방문처</th>' +
      '<th>차량</th><th class="n">거리(km)</th><th class="n">통행료(원)</th><th>증빙</th></tr></thead><tbody>';
    rows.forEach(function (t) {
      var place = t.visit_place || t.end_address || '';
      h += '<tr class="clk' + (flags[t.id] ? ' flagged' : '') + '" tabindex="0" data-trip="' + t.id + '">' +
        '<td class="m1 cday"><span class="lead">' + md(t.start_time) + '</span><span class="dim">(' + DOWK[kd(t.start_time).getUTCDay()] + ')</span>' +
          (t.is_manual ? ' <span class="kind">수기</span>' : '') + '</td>' +
        '<td class="n m1 dim">' + hm(t.start_time) + '</td><td class="m1">' + purposeCell(t.purpose) + '</td>' +
        '<td class="el m2" title="' + esc(place) + '">' + esc(place || '—') + '</td><td class="mx">' + esc(t.plate_no || '—') + '</td>' +
        '<td class="n mr" data-u="km">' + km(t.distance_km) + '</td><td class="n" data-l="통행료">' + tollCell(t) + '</td><td class="cev">' + evCell(t) + '</td></tr>';
    });
    return h + '</tbody></table></div></div>';
  }
  /** 포털(work.html 「오늘 할 일」)에 넘길 남은 일 — 마감 화면이 그릴 때 적어 둔다(portalHint 가 이 탭에 저장). */
  var CLOSE_TODO = null;
  function homeA(T, A, badN, approved, closed, days, bands) {
    var S = stepInfo(), st = S.status, cur = S.cur, sentNow = st === 'submitted' || st === 'approved';
    var empty = !sentNow && cur === 0 && !S.trips.length && !S.ev.length;
    var step = closeStep(S, closed), when = dueText(cycleRange(CYC), Date.now());
    var title = cmpCycle(CYC, currentCycle()) === 0 ? '이번 달 마감' : cycleName(CYC) + ' 마감';
    // 제목 줄 — 오른쪽에 지금 단계 단추 하나(빨간 단추는 화면에 하나, 폰에서는 아래 「다음 할 일」이 대신한다).
    //   이 단추가 이 화면에서 깜빡이는 하나(cta — 단계 카드와 같은 1.6초 고리, 움직임 줄이기면 멈춤. 2026-10-20 사용자 「화면마다 지금 할 일 단추 하나만 깜빡」 V3 U1)
    var h = '<div class="phead pact"><div><h1>' + esc(title) + '</h1><p>' + esc(cycleName(CYC) + ' · ' + cycleSpan(CYC) + ' · ' + (ME.name || '')) + '</p></div>' +
      (step ? '<div class="nowbtns"><button class="btn pri cta" ' + step.b.a + '>' + esc(step.b.t) + ' →</button></div>' : '') + '</div>' + (bands || '');
    // 상태 한 줄 — 상신한 기간·빈 기간·반려(예전과 같은 말)
    var verdict = '', desc = '', clean = '';
    if (st === 'approved') {
      verdict = '<em>결재가 끝났어요</em>'; clean = ' clean';
      // 2026-10-15 2차: 큰 「정산·엑셀 받기 →」는 뺐다 — 아래 결재 띠의 「PDF 받기」·「엑셀 받기」(결재 완료본)와 같은 일이다.
      desc = '결재 완료 문서를 PDF나 엑셀로 다운로드하세요.';
    } else if (st === 'submitted') {
      verdict = '<em>결재 중이에요</em>'; clean = ' wait';
      // 2026-10-19 웹 사용성 1차: 「결재 중」을 세 번 말하던 것 → 큰 제목 + 고치는 방법 한 줄(결재 띠 아래 같은 안내는 뺐다)
      desc = fixHowPlain(myAppr());
    } else if (empty) {
      verdict = '아직 기록된 운행이 없어요'; clean = ' clean'; desc = '앱에서 운행을 기록하면 여기에 모여요.';
    } else if (st === 'rejected') {
      // 반려된 기간(2026-10-16 3차) — 사유 띠는 viewClose 가 맨 위에(rejBandHtml)
      verdict = '반려됐어요. 고쳐서 <em>다시 상신</em>하세요'; desc = step ? step.d : '';
    }
    // 마감일 당일·마감 뒤 며칠은 빨강·굵게(AU6-L7) — 상신한 뒤에는 빨갛게 하지 않는다(AU6-M1 과 같은 원칙)
    var hot = !sentNow && /오늘 마감|지남/.test(when);
    h += '<div class="hero fade cstep"><div class="eyebrow"><span class="dot' + (st === 'approved' ? ' ok' : '') + '"></span>' +
      esc(cycleName(CYC)) + ' · ' + esc(cycleSpan(CYC)) + ' · <b class="due' + (hot ? ' hot' : '') + '">' + esc(when) + '</b></div>' +
      '<div class="steps">' + S.steps.map(function (x, i) {
        // 상신한 뒤의 1~3단계는 '완료'가 아니라 '상신됨' — 남은 것이 있었으면 그대로(0원 등) 올라간 것이다.
        var tail = x.state === 'done' ? (S.sent && i < 2 ? ' · 상신됨' : ' · 완료') : x.state === 'now' ? ' · 지금 할 일' : '';
        return '<button class="stp ' + x.state + '" data-v="' + x.v + '"' + (x.state === 'now' ? ' aria-current="step"' : '') +
          '><i></i><b>' + esc((i + 1) + ' ' + x.t) + (tail ? '<em>' + esc(tail) + '</em>' : '') + '</b><span>' + esc(x.sub) + '</span></button>';
      }).join('') + '</div>' +
      (verdict ? '<div class="nowrow"><div style="flex:1;min-width:0"><p class="verdict' + clean + '">' + verdict + '</p>' + (desc ? '<div class="nd">' + esc(desc) + '</div>' : '') + '</div></div>' : '') +
      '</div>';

    // 운행일지 첫 화면 — 결재함 갈래 나누기(2026-10-08)에 맞춰 운행일지 결재 건만 센다(「결재함 열기」가 여는 것과 같게).
    var ib = inbox().filter(function (a) { return !kindOf(a); });
    var monthOf = function (c) { return keyShort(c, String(c || '')); };   // 추가 기간(2026-12b)도 이름으로(연말 마감)
    var inboxCard = function () {
      return '<div class="cards3 one"><div class="cardx"><div class="k">내가 결재할 것</div><div class="v hot">' + n0(ib.length) + '<small>건</small></div>' +
        '<div class="rows">' + ib.slice(0, 2).map(function (a) {
          return '<div><span>' + esc(nameOf(a.username)) + ' · ' + esc(monthOf(a.cycle)) + '</span><b>' + won((a.snapshot || {}).cost) + '</b></div>';
        }).join('') + '</div><button class="lk" data-v="inbox">결재함 열기 →</button></div></div>';
    };
    // 상신 뒤(결재 중·완료)·빈 기간에는 남은 일·금액 카드가 없다(결재 띠 요약과 같은 숫자 — 2026-10-15 2차). 「내가 결재할 것」은 있을 때만.
    var TK = null;
    if (!sentNow && !empty) {
      TK = closeTasks(S, A);
      h += '<div class="cgrid">' + closeTasksHtml(TK, step) + '<div class="cside">' + closeMoneyHtml(T, closed, st) + (ib.length ? inboxCard() : '') + '</div></div>';
    } else if (ib.length) h += inboxCard();
    // empty = 이 기간에 아직 운행·영수증이 없다 — 포털이 「남은 일 없음 — 0단계 차례」 대신 「아직 운행 기록이 없습니다」(2026-10-20 V3 B10)
    CLOSE_TODO = { cyc: CYCKEY(), at: Date.now(), sent: sentNow, step: step ? step.n : 0, empty: empty,
      list: TK ? TK.list.slice(0, 6).map(function (x) { return { k: x.k, sev: x.sev, t: x.t, d: x.d }; }) : [], n: TK ? TK.list.length : 0 };

    // 「아직 상신하지 않았습니다」 띠는 3단계(검증·상신)일 때만(2026-10-19). 상신한 적이 있으면(결재 중·완료·반려·회수) 진행 줄을 보여야 하므로 그대로 단다.
    if (cur === 2 || myAppr()) h += apprStrip(cur === 2, true);
    h += sect('최근 운행', n0(TRIPS.length) + '건', '<button class="btn sm" data-v="trips">운행 기록 전체 ' + ic('chev', 13) + '</button>',
      closeTripTable(TRIPS.slice(0, 6), TK ? TK.M : moneyOf(myName(), cycleRange(CYC), ALL_TRIPS, ALL_EVID)));
    // 폰 아래 고정 「다음 할 일」 — 첫 남은 일(없으면 지금 단계). 빨간 단추는 이것 하나(제목 줄 단추는 폰에서 숨긴다)
    //   1단계(운행 기록 확인) 차례면 위 안내와 같은 일 = 지금 단계 단추(2026-10-20 V3 U2 — 위는 「운행 기록 확인」인데 아래 띠는 「사진 올리기」였다).
    //   폰에서 이 화면의 깜빡이는 단추 하나(cta, V3 U1)
    var nx = TK && TK.list.length && !(step && step.n === 1) ? TK.list[0] : null, nb = (nx && (nx.b1 || nx.b2)) || (step && step.b) || null;
    if (nb && !nb.hp) h += '<div class="cnext-sp" aria-hidden="true"></div><div class="cnext" role="region" aria-label="다음 할 일"><span class="cnn">' +
      (nx ? '다음 할 일 1 / ' + n0(TK.list.length) + ' · ' + esc(nx.nx || nx.t) : '지금 할 일 · ' + esc(step.t)) + '</span>' + ctBtn(nb, 'pri cta') + '</div>';
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
      var r = cycleRange(pv);
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
  function apprStrip(nowVerify, inHome) {
    var a = myAppr(), st = apprStatusText(a);
    var canWithdraw = a && a.status === 'submitted' &&
      !(a.steps || []).some(function (x) { return x.result; });
    // 단계마다 '지금 받을 수 있는 문서'가 다르다.
    //   상신 전        : 지금 자료로 만든 미리보기(쪽마다 「미결재」)
    //   결재 중·완료   : 상신할 때 고정한 자료로 만든 결재 문서 — 버튼은 apprExtra 가 단다
    var btn = '';
    // 2026-10-15 2차: 반려·회수 뒤에는 위 「검증하고 상신하기 →」 하나만(띠의 「바로 다시 상신」·「PDF 미리보기」는 동작이 달라 헷갈렸다).
    //   상신 전 단추 이름은 「상신」(「바로 상신」·「내 것 상신」 → 「상신」). 관리 화면에는 이 띠를 달지 않는다(현황 화면).
    // 2026-10-16 3차: 띠의 「상신」이 검증·PDF 미리보기를 건너뛰었다 — 상신은 3단계(① 검증 → ② PDF 미리보기 → ③ 상신)에서만.
    //   위 「지금 할 일」이 이미 「검증하고 상신하기 →」(3단계)이면 같은 길을 또 달지 않는다.
    if (!a) {
      btn = '<button class="btn sm" data-pdf="">' + ic('dl', 13) + 'PDF 미리보기</button>' +
        (nowVerify ? '' : '<button class="btn sm" data-v="verify" title="검증, PDF 미리보기, 상신 순서로 진행해요">3 검증·상신 →</button>');
    } else if (canWithdraw) {
      btn = '<button class="btn sm" data-appr="withdraw" data-id="' + a.id + '">회수</button>';
    }
    var locked = a && (a.status === 'submitted' || a.status === 'approved');
    if (locked && EXT.wantSummaries) EXT.wantSummaries([a.id]);
    return '<section class="sect" style="margin-top:16px"><div class="astrip">' +
      '<div class="ahd"><span class="st ' + st.cls + '">' + esc(st.t) + '</span>' +
      '<span style="flex:1"></span>' + btn + '</div>' +
      // 의견(2026-10-21) — 진행 줄 바로 아래 차례대로(담당 → 결재자 승인 의견). 펼친 문서 자리에는 다시 넣지 않는다(ops:false)
      (a ? apprTrack(a) + opinionsHtml(a) : '<div class="anote" style="margin-top:0">' + APPR_HINT + ' 지난번 결재선도 불러올 수 있어요.</div>') +
      (locked && EXT.apprExtra ? (function (x) { return x + apvIfPdf('', a, x, { ops: false }); })(EXT.apprExtra(a)) : '') +
      // 결재 중 안내는 위 큰 제목 아래 한 줄(fixHowPlain)이 말한다(2026-10-19 — 「결재 중」 세 번).
      (a && a.status === 'submitted' && !inHome ? '<div class="anote">결재 중에는 이 기간의 운행·영수증을 고칠 수 없어요. ' +
        withdrawHow(a) + '</div>' : '') +
      (a && (a.status === 'rejected' || a.status === 'withdrawn') ? '<div class="anote">고친 뒤 ‘검증·상신’ 단계에서 다시 상신하세요.</div>' : '') +
      '</div></section>';
  }

  /** 관리 화면의 점검 줄 — 직원용 문장(「영수증을 올리세요」) 대신 몇 건·몇 명인지와 누르면 무엇을 보는지(2026-10-19).
      현황에서 누르면 전체 운행 기록을 소속·이름 순으로 연다(data-issue 처리). */
  function adminIssueRow(f, byPerson) {
    var who = {}; (f.rows || []).forEach(function (t) { if (t && t.username) who[t.username] = 1; });
    var np = Object.keys(who).length, g = {};
    for (var k in f) g[k] = f[k];
    g.d = n0(f.n) + '건' + (np ? ' · ' + n0(np) + '명' : '') +
      (f.rows && f.rows.length ? (byPerson === false ? '. 누르면 그 운행으로 가요.' : '. 누르면 사람별 운행 기록으로 가요.') : '');
    return issueRow(g);
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
      var g = by[k]; g.n++; g.cost += x.cost || 0; g.unk += x.unk || 0; g.trips += x.biz || 0;   // 업무 운행(2026-10-20 — 마감 화면과 같은 말)
    });
    if (out.length < 2 && !byUnit) return '';
    return teamBars(out.map(function (g) {
      return { attr: byUnit ? (g.p.unit ? ' data-orgunit="' + esc(g.p.unit) + '"' : '') : ' data-orgteam="' + esc(g.p.div + '|' + g.p.team) + '"',
        label: g.label, sub: g.sub, value: g.cost, meta: n0(g.n) + '명 · 업무 운행 ' + n0(g.trips) + '건', unk: g.unk };
    }));
  }
  /** 팀별 합계(2026-10-19 사용성 2차 #13) — 운행일지·개인경비·법인카드 관리가 같이 쓴다.
   *  groups = [{ attr(누르면 좁히는 data-*), label, sub, value(원), meta(글), unk(미확정 수) }].
   *  막대 = 전체 중 그 팀 몫(「전체의 N%」). 팀이 셋 이하면 카드 대신 표 줄(팀 · 금액 · 막대 · 미확정)로. */
  function teamBars(groups) {
    var list = groups.slice().sort(function (a, b) { return b.value - a.value; });
    var tot = list.reduce(function (a, g) { return a + (g.value || 0); }, 0);
    var pct = function (g) { return tot > 0 ? Math.round(g.value / tot * 100) : 0; };
    var bar = function (g) {
      return '<span class="tbar" role="img" aria-label="전체의 ' + pct(g) + '%"><i style="width:' + Math.max(2, pct(g)) + '%"></i></span>';
    };
    if (list.length <= 3) {
      return '<div class="panel tlist">' + list.map(function (g) {
        return '<button class="trow"' + g.attr + (g.attr ? '' : ' disabled') + '>' +
          '<span class="tn"><b>' + esc(g.label) + '</b><small>' + esc(g.sub || '') + (g.sub && g.meta ? ' · ' : '') + (g.meta || '') + '</small></span>' +
          '<span class="tv">' + won(g.value) + '</span>' +
          '<span class="tb">' + bar(g) + '<small>전체의 ' + pct(g) + '%</small></span>' +
          '<span class="tu' + (g.unk ? ' on' : '') + '">' + (g.unk == null ? '' : g.unk ? '미확정 ' + n0(g.unk) : '미확정 없음') + '</span></button>';
      }).join('') + '</div>';
    }
    return '<div class="tcards">' + list.map(function (g) {
      return '<button class="tcard"' + g.attr + (g.attr ? '' : ' disabled') + '><span class="tl">' + esc(g.label) + '</span>' +
        '<span class="ts">' + esc(g.sub || '') + '</span>' +
        '<span class="tv">' + won(g.value) + '</span>' + bar(g) +
        '<span class="tm">' + (g.meta || '') + ' · 전체의 ' + pct(g) + '%' + (g.unk ? ' · <em>미확정 ' + n0(g.unk) + '</em>' : '') + '</span></button>';
    }).join('') + '</div>';
  }
  /** 직원별 금액 표. 관리 화면에서는 소속을 맨 앞에 두고 팀별로 묶어 팀 합계를 붙인다(2026-10-07). */
  function personTable(rows) {
    if (!rows.length) return blank('집계할 운행이 없어요.', null, 'users');
    var all = isAll(), cols = all ? 10 : 9;
    var h = '<div class="panel"><div class="scroll tall" data-rows><table class="ptable mc"><thead><tr>' +
      (all ? '<th>파트·센터</th>' : '') + '<th>이름</th>' + (all ? '' : '<th>소속</th>') + '<th class="n">운행</th><th class="n">거리(km)</th>' +
      '<th class="n">유류비</th><th class="n">통행료</th><th class="n">주차</th>' +
      '<th class="n">합계</th><th class="n">통행료 미확정</th>' +
      (all ? '<th></th>' : '') + '</tr></thead><tbody>';
    var row = function (x) {
      var u = USERS[x.u] || {};
      return '<tr class="clk" tabindex="0" data-person="' + esc(x.u) + '">' +
        (all ? orgCell(x.u, true) : '') +
        '<td class="m1"><span class="lead">' + esc(u.name || x.u) + '</span></td>' +
        (all ? '' : '<td class="dim m1">' + esc(u.dept || '—') + '</td>') +
        '<td class="n" data-l="운행" data-u="건">' + n0(x.n) + '</td>' +
        '<td class="n" data-u="km">' + km(x.km) + '</td>' +
        '<td class="n" data-l="유류비">' + n0(x.fuel) + '</td>' +
        '<td class="n" data-l="통행료">' + n0(x.toll) + '</td>' +
        '<td class="n" data-l="주차">' + (x.park ? n0(x.park) : '—') + '</td>' +
        '<td class="n total mr">' + n0(x.cost) + '</td>' +
        '<td class="n ' + (x.unk ? 'unk' : 'dim mx') + '"' + (x.unk ? ' data-l="통행료 미확정"' : '') + '>' + (x.unk ? n0(x.unk) + '건' : '—') + '</td>' +
        (all
          ? '<td class="n mact"><button class="btn sm" data-print="' + esc(x.u) + '" ' +
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

  /* ══════════════════ 관리 — 현황 (2026-10-15 2차 「관리자 메뉴 합치기」) ══════════════════
     예전 「마감 현황」·「검증 현황」·「정산」 세 화면이 같은 팀별 카드·직원별 표를 되풀이했다(군더더기 검토 상 8·16). 한 화면으로 합친다.
       위: 진행 상태 요약(결재 완료·결재 중·상신 전·검증 불일치) · 바로 봐야 할 기록 · 팀별 카드
       표: 사람별 상신 상태 + 검증 결과 + 금액 · 줄마다 운행기록부 「인쇄」 · 머리에 「목록 CSV」(이 표 그대로)
     관리자 반려·정정 열기는 「결재 완료 출력」에만 둔다. 관리자 본인의 상신 띠(「내 것 상신」)·「내 운행기록부」는 넣지 않는다.
     예전 주소(#/a_close · #/a_verify · #/a_settle)는 이 화면으로 돌려보낸다(OLD_VIEWS — 북마크·알림 링크가 깨지지 않게). */
  // 분류 넷(결재 완료·결재 중·반려·미상신)을 현황·결재 완료 출력이 같이 쓴다(2026-10-19 웹 사용성 1차). 회수는 다시 올리기 전까지 미상신.
  var ST_LABEL = { approved: ['결재 완료', 'ok'], submitted: ['결재 중', 'warn'], rejected: ['반려', 'bad'], withdrawn: ['미상신', 'dim'] };
  /** 현황 표의 줄 — 사람별 금액(perPersonTotals) + 이 기간 결재 상태 + 검증 요약. */
  function statusRows(V) {
    var cyc = CYCKEY();
    return perPersonTotals().map(function (x) {
      var a = apprOf(x.u, cyc);
      x.a = a; x.st = a ? a.status : '';
      x.v = V ? V.sum(x.u) : undefined;          // undefined = 검증 결과를 받는 중 · null = 검증 전
      return x;
    });
  }

  /* ══════════════════ 관리 현황 맨 위 — 상신 현황 · 챙길 사람(팀즈 알림) · 팀별 결재 완료 (2026-10-20 D2 시안 P_Status) ══════════════════
     지금 현황 표·기능(검증·비용·바로 봐야 할 기록·팀별 비용·직원별 표)은 그 아래 그대로 둔다. 「챙길 사람」 조각(followCard)과
     팀즈 알림 창은 개인경비·법인카드 현황도 같이 쓴다(C.follow). 보내는 것은 서버 approval-act op 'remind'(remind.ts)가 다시 확인하고 한다. */
  /** 보내기 그림(종이비행기) — 공통 아이콘 묶음에 없어 이 조각에서만 그린다. */
  function sendIco(n) {
    return '<svg width="' + (n || 15) + '" height="' + (n || 15) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>';
  }
  /** 상신 현황 — 결재 완료 · 결재 중 · 반려 · 미상신 쌓은 막대. 색만으로 가르지 않게 막대 아래에 이름·숫자를 같이 쓴다.
   *  색은 아래 표 딱지와 같은 뜻(결재 완료 초록 · 결재 중 주황 · 반려 빨강 · 미상신 회색). */
  function apprSumCard(c, total, sub) {
    var seg = [['ok', '결재 완료', c.approved], ['mid', '결재 중', c.submitted], ['bad', '반려', c.rej], ['none', '미상신', c.none]];
    var pct = function (n) { return total ? Math.round(n / total * 1000) / 10 : 0; };
    return '<section class="sect d2top" aria-labelledby="d2sumh"><div class="panel d2pad">' +
      '<div class="d2hd"><div class="d2t"><h2 id="d2sumh">상신 현황</h2><span class="cnt">' + n0(total) + '명</span></div><span class="d2asof">' + sub + '</span></div>' +
      '<div class="d2bar" data-apvbar role="img" aria-label="' + n0(total) + '명 중 ' + seg.map(function (s) { return s[1] + ' ' + n0(s[2]) + '명'; }).join(', ') + '">' +
        seg.filter(function (s) { return s[2] > 0; }).map(function (s) { return '<i class="' + s[0] + '" data-k="' + s[1] + '" style="width:' + pct(s[2]) + '%"></i>'; }).join('') + '</div>' +
      '<div class="d2leg">' + seg.map(function (s) {
        return '<div class="d2lg ' + s[0] + '"><span class="k"><i aria-hidden="true"></i>' + s[1] + '</span><b>' + n0(s[2]) + '<small>명</small></b></div>';
      }).join('') + '</div></div></section>';
  }
  /** 팀별 결재 완료 — 팀(팀을 골랐으면 파트·센터)마다 인원 · 결재 완료 · 완료율. 이름을 누르면 그 팀으로 좁힌다(아래 팀별 비용과 같은 길). */
  function teamDoneCard(rows) {
    var byUnit = !!ORGF.team, by = {}, out = [];
    rows.forEach(function (x) {
      var p = orgPath(x.u), k = byUnit ? (p.unit || '') : p.div + '|' + p.team;
      if (!by[k]) {
        by[k] = { label: byUnit ? (p.unit || '팀 직속') : orgName(p), rank: orgRank(p), n: 0, done: 0,
          attr: byUnit ? (p.unit ? ' data-orgunit="' + esc(p.unit) + '"' : '') : ' data-orgteam="' + esc(p.div + '|' + p.team) + '"' };
        out.push(by[k]);
      }
      by[k].n++; if (x.st === 'approved') by[k].done++;
    });
    out.sort(function (a, b) { return a.rank - b.rank || a.label.localeCompare(b.label, 'ko'); });
    var pct = function (d, n) { return n ? Math.round(d / n * 100) : 0; };
    var bar = function (d, n) { return '<span class="d2pc"><span class="d2pbar" aria-hidden="true"><i style="width:' + pct(d, n) + '%"></i></span><span class="d2pn">' + pct(d, n) + '%</span></span>'; };
    var tn = rows.length, td = rows.filter(function (x) { return x.st === 'approved'; }).length;
    var title = byUnit ? '파트·센터별 결재 완료' : '팀별 결재 완료';
    return '<section class="sect d2top d2s4" aria-labelledby="d2teamh"><div class="panel d2pad">' +
      '<div class="d2hd"><div class="d2t"><h2 id="d2teamh">' + title + '</h2></div></div>' +
      (out.length ? '<table class="d2tbl d2team"><caption class="sr">' + title + '</caption><thead><tr><th scope="col">' + (byUnit ? '파트·센터' : '팀') + '</th>' +
        '<th scope="col" class="n">인원</th><th scope="col" class="n">완료</th><th scope="col" class="n">완료율</th></tr></thead><tbody>' +
        out.map(function (g) {
          return '<tr><td>' + (g.attr ? '<button type="button" class="plink"' + g.attr + ' title="' + esc(g.label) + '만 보기">' + esc(g.label) + '</button>' : esc(g.label)) + '</td>' +
            '<td class="n">' + n0(g.n) + '</td><td class="n">' + n0(g.done) + '</td><td class="n">' + bar(g.done, g.n) + '</td></tr>';
        }).join('') + '</tbody><tfoot><tr><td>합계</td><td class="n">' + n0(tn) + '</td><td class="n">' + n0(td) + '</td><td class="n"><span class="d2pn">' + pct(td, tn) + '%</span></td></tr></tfoot></table>'
        : '<div class="d2empty">이 기간에 운행한 사람이 없어요.</div>') +
      '</div></section>';
  }
  /** 운행일지 챙길 사람 — 이 기간 운행이 있는데 상신 전 · 회수 · 반려(결재 완료 출력 「챙겨야 할 사람」·서버 remind 와 같은 규칙).
   *  남은 일 = 화면이 이미 센 것만(업무 운행 · 통행료 미확정 · 검증 요약, 반려면 반려 사유). 마지막 활동 = 이 기간 운행·영수증 날짜·결재 건 시각 중 늦은 것. */
  function followOfDriving(rows, V) {
    var r = cycleRange(CYC), last = {};
    var put = function (u, ms) { ms = Number(ms) || 0; if (ms > (last[u] || 0)) last[u] = ms; };
    TRIPS.forEach(function (t) { if (t.start_time >= r.lo && t.start_time < r.hi) put(t.username, t.start_time); });
    evidOfCycle().forEach(function (e) { put(e.username, e.date_millis); });
    return rows.filter(function (x) { return (!x.st && x.n > 0) || x.st === 'withdrawn' || x.st === 'rejected'; }).map(function (x) {
      var a = x.a, st = !a ? 'none' : a.status, left;
      if (a) put(x.u, Date.parse(a.closed_at || a.updated_at || a.submitted_at || '') || 0);
      if (st === 'rejected') {
        var rs = (a.steps || []).filter(function (s) { return s && s.result === 'rejected'; })[0];
        left = '반려 사유: ' + (rs && rs.comment ? String(rs.comment).replace(/\s+/g, ' ') : '(사유 없음)');
      } else {
        var p = ['업무 운행 ' + n0(x.biz) + '건'], v = x.v;
        if (x.unk) p.push('통행료 미확정 ' + n0(x.unk) + '건');
        p.push(v === undefined ? '검증 결과 받는 중' : !v ? '검증 전' : v.bad ? '검증 불일치 ' + n0(v.bad) + '건' : v.warn ? '검증 확인 ' + n0(v.warn) + '건' : '검증 이상 없음');
        left = (st === 'withdrawn' ? '회수함 · ' : '') + p.join(' · ');
      }
      return { u: x.u, st: st, left: left, last: last[x.u] || 0 };
    });
  }
  /* ── 챙길 사람 표 + 팀즈 알림 보내기(세 시스템 공용 — C.follow) ──
     people = [{ u, st: 'none'|'withdrawn'|'rejected', left: 남은 일 한 줄, last: 마지막 활동(ms) }]. 반려 → 회수 → 상신 전 차례로, 처음 6명만(「N명 모두 보기」).
     줄마다 [알림], 머리에 [미상신 N명에게 알림](오늘 이미 보낸 사람 빼고). 오늘 보낸 사람은 「오늘 보냄」 — 기록은 approval_remind_log(관리자만 읽음). */
  var FOLLOW_N = 6, FOLLOW_ALL = {}, FOLLOW_LIST = {};
  var REMIND_NEW_UNTIL = '2026-11-30';     // 「팀즈 알림 보내기」 머리의 「새 기능」 딱지를 이 날(한국 날짜)까지만(2026-10-20 V3 다듬기)
  var FOLLOW_VIEWS = ['a_status', 'xa_close', 'ca_close'];
  var KIND_TAG = { driving: '운행일지', expense: '개인경비', card: '법인카드' };
  var RMD = { day: '', by: {}, ask: {}, job: null };
  /** 오늘(한국 날짜) 보낸 사람 { 아이디: { at, result } } — 아직 못 받았으면 null(받으러 간다). 못 읽으면 빈 것(표시만 빠진다). */
  function remindSeen(kind) {
    var day = ymd(Date.now());
    if (RMD.day !== day) RMD = { day: day, by: {}, ask: {}, job: RMD.job };
    if (RMD.by[kind]) return RMD.by[kind];
    if (!RMD.ask[kind]) remindLoad(kind);
    return null;
  }
  function remindLoad(kind) {
    var day = RMD.day || ymd(Date.now());
    RMD.ask[kind] = true;
    // cycle 도 받는다 — 다른 기간 안내를 보낸 날이면 그 기간 이름으로 보인다(2026-10-20 V3 U8 — 10월분 보낸 날 9월분 현황도 「오늘 보냄」이었다)
    return fetchAll('/rest/v1/approval_remind_log?select=target,created_at,result,cycle&kind=eq.' + encodeURIComponent(kind) + '&day=eq.' + day + '&order=created_at.asc')
      .then(function (rows) {
        var m = {};
        (rows || []).forEach(function (x) { m[x.target] = { at: Date.parse(x.created_at || '') || 0, result: String(x.result || ''), cycle: String(x.cycle || '') }; });
        RMD.by[kind] = m;
      }, function () { RMD.by[kind] = {}; })        // 표가 아직 없는 서버(마이그레이션 전) 등 — 「오늘 보냄」 표시만 빠진다
      .then(function () { delete RMD.ask[kind]; if (FOLLOW_VIEWS.indexOf(VIEW) >= 0 && LOADED) render(); });
  }
  function followCard(kind, cyc, people, opt) {
    opt = opt || {};
    var order = { rejected: 0, withdrawn: 1, none: 2 };
    people = people.slice().sort(function (a, b) {
      var pa = orgPath(a.u), pb = orgPath(b.u);
      return (order[a.st] - order[b.st]) || (orgRank(pa) - orgRank(pb)) || nameOf(a.u).localeCompare(nameOf(b.u), 'ko');
    });
    FOLLOW_LIST[kind] = { cyc: cyc, people: people };
    var seen = remindSeen(kind) || {};
    // 오늘 보낸 것 = 팀즈가 받은 것(2xx)과 보내는 중(pending)만 — 팀즈가 받지 않은 것(500 등)은 「못 보냄」, 그날 다시 보낼 수 있다(2026-10-20 V3 B9, 서버 remind.ts 와 같은 판정)
    var gone = function (u) { var s = seen[u]; return !!s && (/^2\d\d$/.test(String(s.result)) || s.result === 'pending'); };
    var notYet = people.filter(function (p) { return p.st !== 'rejected'; }), bulk = notYet.filter(function (p) { return !gone(p.u); });
    var all = !!FOLLOW_ALL[kind], shown = all ? people : people.slice(0, FOLLOW_N);
    var stChip = function (p) {
      return p.st === 'rejected' ? '<span class="d2chip bad">반려</span>'
        : '<span class="d2chip neu"' + (p.st === 'withdrawn' ? ' title="회수한 뒤 다시 상신하지 않았어요"' : '') + '>미상신</span>';
    };
    var who = function (u) { var o = orgPath(u); return [orgName(o), o.unit].filter(Boolean).join(' · '); };
    var btn = function (p) {
      var s = seen[p.u];
      // 다른 기간 안내를 보낸 날이면 그 기간 이름(「10월분 보냄」) — 한 사람에게 하루 한 번이라 오늘은 더 못 보낸다(V3 U8)
      var other = s && s.cycle && s.cycle !== cyc ? keyShort(s.cycle, s.cycle) : '';
      if (s && gone(p.u)) return '<span class="d2sent" title="' + esc(hm(s.at) + ' ' + (other ? other + ' 마감 안내 ' : '') + (s.result === 'pending' ? '보내는 중' : '보냄') +
        (other ? '. 한 사람에게 하루 한 번만 보낼 수 있어요.' : '')) + '">' + ic('check', 13) + (s.result === 'pending' ? '보내는 중' : other ? esc(other) + ' 보냄' : '오늘 보냄') + '</span>';
      // 팀즈가 받지 않음 — 폰에서도 보이게 글로(예전엔 「오늘 보냄」에 마우스를 올려야 보였다) + 다시 보내기
      var fail = s ? '<span class="d2fail" title="' + esc(hm(s.at) + ' 팀즈 응답 ' + s.result) + '">' + ic('alert', 13) + '못 보냄</span>' : '';
      return fail + '<button type="button" class="btn sm d2rbtn" data-remind="' + esc(kind + '|' + p.u) + '" aria-label="' + esc(nameOf(p.u)) + ' 님에게 팀즈 알림' + (s ? ' 다시 보내기' : '') + '">' +
        sendIco(14) + (s ? '다시 알림' : '알림') + '</button>';
    };
    var hd = '<div class="d2hd"><div class="d2t"><h2 id="d2fh-' + kind + '">챙길 사람</h2><span class="cnt">' + n0(people.length) + '명</span></div>' +
      // 「새 기능」 딱지는 REMIND_NEW_UNTIL(한국 날짜)까지만 — 뗄 날이 없었다(2026-10-20 V3 다듬기). 늘리려면 날짜만 고친다.
      '<div class="d2act">' + (ymd(Date.now()) <= REMIND_NEW_UNTIL ? '<span class="d2new" title="' + REMIND_NEW_UNTIL + '까지 보여요">새 기능</span>' : '') +
      '<button type="button" class="btn pri d2all" data-remindall="' + kind + '"' + (bulk.length ? '' : ' disabled') + '>' + sendIco(15) +
      (bulk.length ? '미상신 ' + n0(bulk.length) + '명에게 알림' : notYet.length ? '미상신 모두 오늘 보냄' : '미상신 없음') + '</button></div></div>';
    var body = people.length
      ? '<table class="d2tbl d2fol"><caption class="sr">챙길 사람(반려·미상신)</caption><thead><tr><th scope="col">이름 · 팀</th><th scope="col">상태</th>' +
        '<th scope="col">남은 일</th><th scope="col" class="n">마지막 활동</th><th scope="col" class="n"><span class="sr">팀즈 알림</span></th></tr></thead><tbody>' +
        shown.map(function (p) {
          return '<tr data-fol="' + esc(p.u) + '"><td class="d2who"><b>' + esc(nameOf(p.u)) + '</b><small>' + esc(who(p.u)) + '</small></td>' +
            '<td class="d2st">' + stChip(p) + '</td>' +
            '<td class="d2left"><span title="' + esc(p.left) + '">' + esc(p.left) + '</span></td>' +
            '<td class="n d2last" data-l="마지막 활동">' + (p.last ? md(p.last) : '—') + '</td>' +
            '<td class="n d2go">' + btn(p) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        (people.length > FOLLOW_N ? '<button type="button" class="d2more" data-followall="' + kind + '" aria-expanded="' + all + '">' +
          (all ? '처음 ' + FOLLOW_N + '명만 보기' : n0(people.length) + '명 모두 보기') + ic('chev', 14) + '</button>' : '')
      : '<div class="d2empty">' + ic('check', 15) + '챙길 사람이 없어요. ' + (opt.none || '이 기간 자료가 있는 사람은 모두 상신했어요') + '.</div>';
    return '<section class="sect d2top ' + (opt.wide ? 'd2s12' : 'd2s8') + '" aria-labelledby="d2fh-' + kind + '"><div class="panel d2pad">' + hd + body +
      '<div class="d2note">알림은 팀즈 개인 채팅으로 한 사람씩 가고(조직도의 회사 메일 계정), 한 사람에게는 하루 한 번만 가요. 보내기 전에 받는 사람과 글을 보여 드려요.</div>' +
      '</div></section>';
  }
  function remindCall(payload) {
    return apiRetry('/functions/v1/approval-act', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && !!(j && j.ok), status: r.status, j: j || {} }; }); });
  }
  /** 팀즈 알림 확인 창 — 서버에 먼저 물어(dry) 받을 사람·보낼 글을 그대로 보이고, 「N명에게 보내기」를 눌러야 보낸다. */
  function openRemind(kind, users) {
    var L = FOLLOW_LIST[kind];
    // 보내는 중일 때만 막는다 — 「취소」·Esc 로 닫은 창의 작업은 새 창이 이어받는다(예전엔 남아서 다시 열리지 않았다)
    if (!L || !users.length || (RMD.job && RMD.job.sending)) return;
    var MAX = 30, more = users.length > MAX ? users.length - MAX : 0;
    users = users.slice(0, MAX);
    var kd = kindDef(kind === 'driving' ? '' : kind);
    // 기간 이름은 열쇠로(엔진 — '2026-12b' → 「2026년 12월분 2차」, 2026-10-20 V3 B12: 달 숫자로 나눠 「2026년 NaN월분」이 나왔다)
    var cname = kd && kd.cycName ? kd.cycName({ cycle: L.cyc }) : keyName(L.cyc, L.cyc);
    var sub = KIND_TAG[kind] + ' · ' + cname;
    var job = RMD.job = { kind: kind, cyc: L.cyc, users: [] };
    openPanel('팀즈 알림 보내기', sub, '<div class="pdfwait"><div class="spin"></div><div role="status">받는 사람과 보낼 글을 확인하는 중…</div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>');
    remindCall({ action: 'remind', kind: kind, cycle: L.cyc, users: users, dry: true }).then(function (res) {
      if (RMD.job !== job || !$('panel').classList.contains('open')) return;
      if (!res.ok) { RMD.job = null; closePanel(); toast((res.j && res.j.error) || '받는 사람을 확인하지 못했어요. 잠시 후 다시 해 주세요.', true); return; }
      var list = res.j.results || [], ready = list.filter(function (x) { return x.r === 'ready'; }), skip = list.filter(function (x) { return x.r !== 'ready'; });
      var flow = res.j.flow !== false;
      job.users = ready.map(function (x) { return x.u; });
      var stName = { none: '미상신', withdrawn: '미상신(회수함)', rejected: '반려' };
      var why = { today: '오늘 이미 보냄', nomail: '회사 메일 없음', left: '조직도에 없음', submitted: '이미 상신', nodata: '이 기간 자료 없음', error: '확인하지 못함', limit: '시간당 상한' };
      var whoOf = function (u) { var o = orgPath(u); return [orgName(o), o.unit].filter(Boolean).join(' · '); };
      var groups = {};
      skip.forEach(function (x) { (groups[x.r] = groups[x.r] || []).push(nameOf(x.u)); });
      var hourly = Number(res.j.hourly) || 0;      // 서버가 쓰는 시간당 상한(결재 알림과 함께) — 화면이 숫자를 지어내지 않는다
      var body = '<div class="anote" style="margin-top:0">조직도의 회사 메일 계정으로 팀즈 개인 채팅을 <b>한 사람씩</b> 보내고, 한 사람에게는 <b>하루 한 번</b>만 가요. ' +
        (hourly ? '결재 알림과 합쳐 한 시간에 ' + n0(hourly) + '건까지라' : '결재 알림과 합쳐 시간당 보낼 수 있는 수가 정해져 있어') +
        ', 한꺼번에 많이 보내면 결재 알림이 늦어질 수 있어요.</div>' +
        (flow ? '' : '<div class="awarn">' + ic('alert', 15) + '<span>팀즈 알림이 설정되지 않아 지금은 보낼 수 없어요. 관리자에게 문의해 주세요.</span></div>') +
        '<div class="d2rmh">받는 사람 <b>' + n0(ready.length) + '명</b></div>' +
        (ready.length ? '<ul class="d2rmlist">' + ready.map(function (x) {
          return '<li><div class="d2rmrow"><span class="d2rmn"><b>' + esc(nameOf(x.u)) + '</b><small>' + esc(whoOf(x.u)) + '</small></span>' +
            '<span class="d2chip ' + (x.st === 'rejected' ? 'bad' : 'neu') + '">' + esc(stName[x.st] || '') + '</span></div>' +
            '<details><summary>보낼 글 보기</summary><pre class="d2rmtext">' + esc(x.text || '') + '</pre></details></li>';
        }).join('') + '</ul>' : '<div class="d2empty">보낼 사람이 없어요.</div>') +
        (skip.length ? '<div class="d2rmskip"><b>보내지 않는 사람 ' + n0(skip.length) + '명</b>: ' + Object.keys(groups).map(function (k) {
          return esc((why[k] || k) + ' ' + groups[k].length + '명(' + groups[k].join(', ') + ')');
        }).join(' · ') + '</div>' : '') +
        (more ? '<div class="d2rmskip">한 번에 ' + MAX + '명까지 보내요. 나머지 ' + n0(more) + '명은 보낸 뒤 다시 눌러 주세요.</div>' : '') +
        (ready.length ? '<div class="d2rmh">보낼 글 <span class="dim">' + esc(nameOf(ready[0].u)) + ' 님에게 갈 글이에요. 사람마다 이유와 건수만 달라요.</span></div>' +
          '<pre class="d2rmtext" id="d2rmFirst">' + esc(ready[0].text || '') + '</pre>' : '');
      openPanel('팀즈 알림 보내기', sub, body, '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
        '<button class="btn pri" id="btnRemindGo"' + (ready.length && flow ? '' : ' disabled') + '>' + sendIco(15) + (ready.length ? n0(ready.length) + '명에게 보내기' : '보낼 사람 없음') + '</button>');
    }).catch(function () {
      if (RMD.job === job) { RMD.job = null; closePanel(); toast('서버에 연결하지 못했어요. 잠시 후 다시 해 주세요.', true); }
    });
  }
  function sendRemind() {
    var job = RMD.job, b = $('btnRemindGo');
    if (!job || !job.users.length || job.sending) return;
    job.sending = true;
    if (b) { b.disabled = true; b.textContent = '보내는 중…'; }
    remindCall({ action: 'remind', kind: job.kind, cycle: job.cyc, users: job.users }).then(function (res) {
      RMD.job = null;
      closePanel();
      if (!res.ok) { toast((res.j && res.j.error) || '보내지 못했어요. 잠시 후 다시 해 주세요.', true); }
      else toast(endDot(res.j.message || '보냈어요'), !(res.j.sent > 0));
      delete RMD.by[job.kind];
      remindLoad(job.kind);
    }).catch(function () {
      RMD.job = null; closePanel(); toast('서버에 연결하지 못했어요. 보냈는지 ‘오늘 보냄’ 표시로 확인해 주세요.', true);
      delete RMD.by[job.kind]; remindLoad(job.kind);
    });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-remind],[data-remindall],[data-followall],#btnRemindGo,[data-tfold]');
    if (!t) return;
    if (t.id === 'btnRemindGo') { sendRemind(); return; }
    if (t.hasAttribute('data-tfold')) {        // 관리자 운행 기록 폰 「조건 ▾」(다시 그리지 않고 펼치기만)
      TFOLD_OPEN = !TFOLD_OPEN;
      var bar = t.closest('.tfbar');
      if (bar) bar.classList.toggle('open', TFOLD_OPEN);
      t.setAttribute('aria-expanded', String(TFOLD_OPEN));
      return;
    }
    if (t.hasAttribute('data-followall')) {
      var k0 = t.getAttribute('data-followall');
      FOLLOW_ALL[k0] = !FOLLOW_ALL[k0];
      render();
      var nb = document.querySelector('[data-followall="' + k0 + '"]'); if (nb) nb.focus();
      return;
    }
    if (t.hasAttribute('data-remindall')) {
      var k1 = t.getAttribute('data-remindall'), L = FOLLOW_LIST[k1], seen = remindSeen(k1) || {};
      if (!L) return;
      // 팀즈가 받지 않은(못 보낸) 사람도 다시 보낸다 — 받은 것(2xx)·보내는 중만 뺀다(2026-10-20 V3 B9)
      var sentOk = function (u) { var s = seen[u]; return !!s && (/^2\d\d$/.test(String(s.result)) || s.result === 'pending'); };
      openRemind(k1, L.people.filter(function (p) { return p.st !== 'rejected' && !sentOk(p.u); }).map(function (p) { return p.u; }));
      return;
    }
    var v = String(t.getAttribute('data-remind') || ''), i = v.indexOf('|');
    if (i > 0) openRemind(v.slice(0, i), [v.slice(i + 1)]);
  });
  function viewStatus() {
    if (!LOADED) return head('현황') + skeleton();
    if (isMulti()) return viewPeriod();
    var T = totals(TRIPS, { allUsers: true }), A = audit();
    var V = EXT.statusVerify ? EXT.statusVerify(CYCKEY()) : null;
    var rows = statusRows(V);
    var c = { approved: 0, submitted: 0, rej: 0, none: 0, vbad: 0, vwarn: 0, vnone: 0 };
    rows.forEach(function (x) {
      if (x.st === 'approved') c.approved++; else if (x.st === 'submitted') c.submitted++;
      else if (x.st === 'rejected') c.rej++; else c.none++;          // 회수(withdrawn)는 미상신
      if (V) { if (!x.v) c.vnone++; else if (x.v.bad) c.vbad++; else if (x.v.warn) c.vwarn++; }
    });
    var r = cycleRange(CYC), now = Date.now(), closed = now >= r.hi;
    var drivers = Object.keys(USERS).filter(function (u) { return USERS[u].uses_driving !== false && orgMatch(u); }).length;
    var h = head('현황', (orgFilterOn() ? esc(orgScopeName()) + ' ' : '전체 직원 ') + n0(drivers) + '명 · 이 기간 운행한 사람 ' + n0(rows.length) + '명');

    // ── 맨 위(2026-10-20 D2 시안 P_Status): 상신 현황 쌓은 막대 → 챙길 사람(팀즈 알림) · 팀별 결재 완료 ──
    //   예전 큰 제목(「결재 완료 N명 · 결재 중 · 반려 · 미상신」)과 두 색 막대는 「상신 현황」으로 옮겼다(같은 네 갈래 · 회수는 미상신).
    h += apprSumCard(c, rows.length, esc(cycleName(CYC)) + ' · ' + esc(cycleSpan(CYC)) + ' · ' + dueText(r, now) +
      (closed ? '' : ' · ' + hm(now) + ' 기준'));
    h += '<div class="d2grid">' + followCard('driving', CYCKEY(), followOfDriving(rows, V), { none: '이 기간 운행한 사람은 모두 상신했어요' }) + teamDoneCard(rows) + '</div>';

    // ── 검증 · 업무용 비용 — 회사(보는 범위) 전체(관리자 본인에게 시키는 말이 아니다) ──
    h += '<div class="hero fade d2facts"><div class="eyebrow"><span class="dot' + (rows.length && c.approved === rows.length ? ' ok' : '') + '"></span>검증 · 업무용 비용</div>' +
      '<div class="facts">' +
      // 결재 상태 숫자는 위 큰 제목 한 줄이 말한다(예전에는 숫자 칸에 한 번 더, 분류도 달랐다 — 2026-10-19). 여기는 검증·금액만.
      // 불일치와 확인 필요를 나눠 센다(2026-10-19 사용성 2차 — 「불일치 0명」인데 표에는 「확인 1」이 붙은 사람이 있어 헷갈렸다)
      fact('검증 불일치', V && !V.fail ? n0(c.vbad) + '<small>명</small>' : '—', V ? (V.fail ? '검증 결과를 불러오지 못했어요' : '검증 전 ' + n0(c.vnone) + '명') : '검증 결과를 받는 중…', c.vbad > 0) +
      (V && !V.fail ? fact('검증 확인 필요', n0(c.vwarn) + '<small>명</small>', c.vwarn ? '불일치는 없고 한 번 볼 것만 있어요' : '') : '') +   // 0명이면 설명 없음(2026-10-20)
      fact('업무용 비용', won(T.cost), '유류비 ' + won(T.fuel) + ' · 통행료 ' + won(T.toll) + ' · 주차비 ' + won(T.park) +
        (T.unk ? ' · 통행료 미확정 ' + n0(T.unk) + '건(0원)' : '')) +
      '</div></div>';

    // 바로 봐야 할 기록(계기판 튐·목적 미선택 등) — 있을 때만
    var issues = A.filter(function (f) { return f.n > 0; }).slice(0, 4);
    if (issues.length) {
      h += sect('바로 봐야 할 기록', null,
        '<button class="btn sm" data-keeporg data-v="a_check">전체 점검 ' + ic('chev', 13) + '</button>',
        '<div class="panel">' + issues.map(function (f) { return adminIssueRow(f, true); }).join('') + '</div>');
    }
    var tc = teamCards(rows);
    // 위 「팀별 결재 완료」와 헷갈리지 않게 이름에 「비용」(2026-10-20 D2)
    if (tc) h += sect(ORGF.team ? '파트·센터별 비용' : '팀별 비용', null, '', tc);

    h += sect('직원별', rows.length + '명',
      '<button class="btn sm" id="btnStatusCsv" title="이 표를 CSV로 다운로드해요">' + ic('dl', 13) + '목록 CSV</button>',
      statusTable(rows, V));

    h += '<div class="anote">상신 칸은 이 기간 운행일지 결재 상태예요. 검증 칸은 상신했으면 상신할 때의 결과, 상신 전이면 마지막 검증 결과예요. ' +
      '결재 완료 문서 다운로드, 관리자 반려, 정정 열기는 ‘결재 완료 출력’에서 하세요. 이름을 누르면 그 사람의 운행 기록으로 가요.</div>';
    h += sect('산정 기준', null, '',
      '<div class="panel" style="padding:18px 20px;font-size:13px;line-height:1.7;color:var(--ink-3)">' +
      '업무용(<b style="color:var(--ink-2)">' + BUSINESS + '</b>) 운행만 집계해요.<br>' +
      '유류비 = 분기 기준단가 × 주행거리(도착 계기판 km − 출발 계기판 km, 각각 반올림)<br>' +
      '주차비·통행료 = 금액 규칙 v3: 운행 금액(영수증과 비교), 운행 금액이 없는 날은 영수증 금액, 운행 없는 날의 영수증은 제외<br>' +
      '<b style="color:var(--ink-2)">회사 월간 리포트와 같은 식</b>으로 계산해요. 리포트와 다르면 알려 주세요.</div>');
    return h;

    function fact(k, v, sub, alert) {
      return '<div class="fact"><div class="k">' + esc(k) + '</div><div class="v' + (alert ? ' alert' : '') + '">' + v + '</div>' +
        '<div class="sub">' + esc(sub || '') + '</div></div>';
    }
  }
  /** 현황 표 — 소속별로 묶고(팀 합계), 사람마다 상신 상태 · 검증 · 금액 · 인쇄. */
  function statusTable(rows, V) {
    if (!rows.length) return blank('집계할 운행이 없어요.', null, 'users');
    // 2026-10-16 3차: 1280 폭에서 표(1068px)가 칸(954px)을 넘었다 — 운행·거리를 한 칸으로, 「통행료 미확정」은 「미확정」, 단추 칸은 줄을 바꿀 수 있게.
    var cols = 11;
    var stCell = function (x) {
      var L = ST_LABEL[x.st] || ['미상신', 'dim'];
      return '<span class="st ' + L[1] + '" title="' + esc(x.a ? apprStatusText(x.a).t : '아직 상신하지 않았어요') + '">' + esc(L[0]) + '</span>';
    };
    var h = '<div class="panel"><div class="scroll tall" data-rows><table class="ptable stable mc"><thead><tr>' +
      '<th>파트·센터</th><th>이름</th><th>상신</th><th>검증</th><th class="n bz" title="업무 운행 건수·거리(괄호는 출퇴근 등을 더한 전체 건수)">업무 운행</th>' +
      '<th class="n">유류비</th><th class="n">통행료</th><th class="n">주차</th><th class="n">합계</th><th class="n" title="통행료 미확정(0원으로 정산)">미확정</th><th></th></tr></thead><tbody>';
    var row = function (x) {
      var u = USERS[x.u] || {};
      return '<tr>' + orgCell(x.u, true) +
        '<td class="m1"><button type="button" class="plink lead" data-person="' + esc(x.u) + '" title="' + esc(u.name || x.u) + ' 님 운행 기록 보기">' + esc(u.name || x.u) + '</button></td>' +
        '<td class="m1">' + stCell(x) + '</td>' +
        '<td class="m2" style="white-space:nowrap">' + (V ? V.chip(x.u) : '<span class="dim">…</span>') + '</td>' +
        // 금액은 업무 운행만이라 건수·거리도 업무 운행으로 — 「업무 운행 N건 · X km (전체 M건)」(2026-10-20, 마감 화면과 같은 말)
        '<td class="n bz" data-l="업무 운행">' + n0(x.biz) + '건<div class="dim skm">' + km(x.bizKm) + ' km</div>' + (x.biz !== x.n ? '<div class="dim skm skt">(전체 ' + n0(x.n) + '건)</div>' : '') + '</td>' +
        '<td class="n mx">' + n0(x.fuel) + '</td><td class="n mx">' + n0(x.toll) + '</td>' +
        '<td class="n mx">' + (x.park ? n0(x.park) : '—') + '</td>' +
        '<td class="n total mr">' + n0(x.cost) + '</td>' +
        '<td class="n ' + (x.unk ? 'unk' : 'dim mx') + '"' + (x.unk ? ' data-l="미확정"' : '') + '>' + (x.unk ? n0(x.unk) + '건' : '—') + '</td>' +
        // 작업 단추는 한 줄 고정 자리 두 칸(검증 · 인쇄 — 2026-10-19 사용성 2차 #9). 결과 보기는 검증 칸 딱지를 누른다.
        '<td class="n sact mact"><div class="sacts"><span class="sslot">' + (V ? V.act(x.u) : '') + '</span>' +
          '<span class="sslot"><button class="btn sm" data-print="' + esc(x.u) + '" title="' + esc(u.name || x.u) + ' 님 운행기록부 인쇄">' + ic('receipt', 13) + '인쇄</button></span></div></td></tr>';
    };
    var sum = function (list, k) { return list.reduce(function (a, x) { return a + (Number(x[k]) || 0); }, 0); };
    orgGroups(rows, function (x) { return x.u; }).forEach(function (g) {
      var done = g.list.filter(function (x) { return x.st === 'approved'; }).length;
      h += orgGroupRow(g, cols, '결재 완료 ' + n0(done) + ' / ' + n0(g.list.length) + '명 · 합계 <b>' + won(sum(g.list, 'cost')) + '</b>' +
        (sum(g.list, 'unk') ? ' · <span class="unk">미확정 ' + n0(sum(g.list, 'unk')) + '건</span>' : ''));
      g.list.forEach(function (x) { h += row(x); });
    });
    h += '</tbody><tfoot><tr><td colspan="4">' + n0(rows.length) + '명 합계</td>' +
      '<td class="n bz">' + n0(sum(rows, 'biz')) + '건<div class="dim skm">' + km(sum(rows, 'bizKm')) + ' km</div>' + (sum(rows, 'biz') !== sum(rows, 'n') ? '<div class="dim skm skt">(전체 ' + n0(sum(rows, 'n')) + '건)</div>' : '') + '</td>' +
      '<td class="n">' + n0(sum(rows, 'fuel')) + '</td><td class="n">' + n0(sum(rows, 'toll')) + '</td>' +
      '<td class="n">' + n0(sum(rows, 'park')) + '</td><td class="n total">' + n0(sum(rows, 'cost')) + '</td>' +
      '<td class="n">' + (sum(rows, 'unk') ? n0(sum(rows, 'unk')) + '건' : '—') + '</td><td></td></tr></tfoot>';
    return h + '</table></div></div>';
  }
  /** 현황 표를 그대로 CSV 로(목록 CSV). */
  function statusCsv() {
    var V = EXT.statusVerify ? EXT.statusVerify(CYCKEY()) : null;
    var rows = statusRows(V);
    var lines = [['사업부', '팀', '파트·센터', '이름', '상신', '검증', '운행', '거리km', '유류비', '통행료', '주차비', '합계', '통행료미확정'].join(',')];
    orgGroups(rows, function (x) { return x.u; }).forEach(function (g) {
      g.list.forEach(function (x) {
        var p = orgPath(x.u), L = ST_LABEL[x.st] || ['미상신'];
        var cells = [p.div || '', p.team || '', p.unit || '', nameOf(x.u), L[0], V ? V.text(x.u) : '',
          x.n, Math.round(x.km), Math.round(x.fuel), Math.round(x.toll), Math.round(x.park), Math.round(x.cost), x.unk || 0];
        lines.push(cells.map(function (v) {
          if (typeof v === 'number') return String(v);
          var s = String(v == null ? '' : v);
          if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;            // 엑셀이 수식으로 실행하지 않게
          return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(','));
      });
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ATEC_운행일지_현황_' + cycKey(CYC) + (orgFilterOn() ? '_' + orgScopeName().replace(/[\\/:*?"<>|\s]+/g, '') : '') + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('현황 목록을 CSV로 다운로드했어요.');
  }

  /* ══════════════════ 좁히기 공통 (기간 · 날짜 · 정렬 · 나눠 보기) ══════════════════ */
  /** 여러 주기를 보고 있는가. */
  function isMulti() { return !!RANGE; }
  /** 지금 화면이 보는 기간(ms). 한 주기면 그 주기, 여러 주기면 처음~끝. */
  function viewRange() {
    if (!RANGE) return cycleRange(CYC);
    return { lo: cycleRange(RANGE.from).lo, hi: cycleRange(RANGE.to).hi };
  }
  /** 조회 범위에 든 주기들(오래된 것부터). 한 주기면 그것 하나. */
  function cyclesInView() {
    if (!RANGE) return [toC(CYC)];
    // 한 칸씩 — 연말 추가 기간이 있으면 그것도 한 칸(2026-10-20)
    var out = [], c = RANGE.from;
    for (var i = 0; i < 60 && cmpCycle(c, RANGE.to) <= 0; i++) { out.push(toC(c)); c = addCycle(c, 1); }
    return out;
  }
  /** 'YYYY-MM' · 추가 기간 'YYYY-12b'(2026-10-20) — 서버 결재 건의 cycle 과 같은 글자. */
  function cycKey(c) { return CR.key(c); }
  /** 결재 건 cycle 글자 → '2026년 9월분' · '2026년 12월분 2차' / '9월분' · '12월분 2차'. 못 읽으면 fb(없으면 그 글자 그대로). */
  function keyName(key, fb) { return CR.isKey(String(key == null ? '' : key)) ? CR.name(String(key)) : fb === undefined ? key : fb; }
  function keyShort(key, fb) { return CR.isKey(String(key == null ? '' : key)) ? CR.short(String(key)) : fb === undefined ? key : fb; }
  /** 그 갈래(kind)의 키 → [lo, hi) ms(없는 기간이면 NaN) · '09.21 – 10.20'. */
  function keyRange(kind, key) { return cycleRange(CR.parse(String(key == null ? '' : key)) || { y: NaN, m: NaN }, kind); }
  function keySpan(kind, key) { return cycleSpan(CR.parse(String(key == null ? '' : key)) || { y: NaN, m: NaN }, kind); }
  /** 그 시각이 속한 주기(운행일지). 21일부터 다음 달분 — 연말 설정이 있으면 그 기간. */
  function cycleOfMs(ms) {
    return toC(CR.periodOfMs('driving', ms));
  }
  /** 머리띠·제목에 쓰는 기간 이름. "2026년 9월분" / "2026년 4월분 – 9월분". */
  function viewName() {
    if (!RANGE) return cycleName(CYC);
    var a = RANGE.from, b = RANGE.to;
    return cycleName(a) + ' – ' + (a.y === b.y ? '' : b.y + '년 ') + CR.short(b);
  }
  function viewSpan() {
    if (!RANGE) return cycleSpan(CYC);
    var r = viewRange();
    return ymd(r.lo).slice(2).replace(/-/g, '.') + ' – ' + ymd(r.hi - 1).slice(2).replace(/-/g, '.');
  }
  /** 여러 주기를 볼 때 한 주기 전용 화면에 띄우는 안내. */
  function singleOnly(title, what) {
    var cs = cyclesInView().slice().reverse().slice(0, 6);
    return head(title, esc(viewName())) +
      '<div class="panel" style="padding:30px 26px;text-align:center">' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:8px">' + esc(what) + ' 화면은 한 기간만 열 수 있어요</div>' +
      '<div class="dim" style="font-size:13px;line-height:1.7;max-width:460px;margin:0 auto 16px">' +
      '지금은 여러 기간을 함께 보고 있어서 조회만 돼요. 어느 기간을 다룰지 골라 주세요.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">' +
      cs.map(function (c) {
        return '<button class="btn sm" data-cyc="' + cycKey(c) + '">' + esc(cycleName(c)) + '</button>';
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
      var q = [['이번주', clip(mon, mon + 6 * 86400e3)], ['지난주', clip(mon - 7 * 86400e3, mon - 86400e3)]];
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
      // 2026-10-20 AU6-M5: 기본 목적(일반업무)은 사용자가 건 조건으로 세지 않는다 — 빈 기간에 「일반업무 조건에 맞는 운행이 없습니다」 +
      //   「전체 보기」가 떴는데, 누르면 목적이 다시 일반업무로 돌아가 아무것도 안 바뀌었다(헛단추). 단추는 보일 운행이 실제로 있을 때만,
      //   누르면 목적까지 비워 이 기간 운행을 모두 보인다(afterPaint). 줄인 표(마감 화면 최근 운행)는 조건과 상관없는 이 기간 운행이라 조건을 말하지 않는다.
      if (opt.compact) return blank('이 기간에 운행 기록이 없어요.', null, 'list');
      var on = [];
      if (FILT.who) on.push(nameOf(FILT.who) + ' 님');
      if (FILT.car) on.push(FILT.car);
      if (FILT.purp && FILT.purp !== BUSINESS) on.push(FILT.purp === '-' ? '목적 미선택' : FILT.purp);
      if (dateFilterOn()) on.push('날짜 조건');
      if (FILT.q) on.push('‘' + FILT.q + '’ 검색');
      if (FILT.chip && FILT.chip !== 'all') on.push('점검 항목');
      var allN = TRIPS.length;                 // 아무 조건 없이 이 기간(보는 범위)의 운행
      if (!allN) return blank('이 기간에 운행 기록이 없어요.', null, 'list');
      var clr = function (label) { return '<button class="btn sm" id="btnClearFilt">' + esc(label) + '</button>'; };
      if (on.length) {
        return blankAct(on.join(' · ') + ' 조건에 맞는 운행이 없어요.', '조건을 풀면 이 기간 운행 ' + n0(allN) + '건을 모두 볼 수 있어요.', 'list', clr('전체 보기'));
      }
      // 걸린 것은 기본 목적(일반업무)뿐 — 이 기간에 업무 운행만 없다. 다른 목적 운행을 보는 단추(가장 많은 목적 이름).
      var ps = {}; TRIPS.forEach(function (t) { var p = t.purpose || '목적 미선택'; ps[p] = (ps[p] || 0) + 1; });
      var top = Object.keys(ps).sort(function (a, b) { return ps[b] - ps[a]; });
      return blankAct('이 기간에 업무 운행이 없어요.', '정산은 업무 운행(일반업무)만 해요. 다른 목적 운행이 ' + n0(allN) + '건 있어요.', 'list',
        clr((top.length === 1 ? top[0] : top[0] + ' 등') + ' ' + n0(allN) + '건 보기'));
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
        who: function (t) { var p = orgPath(t.username); return ('0000' + orgRank(p)).slice(-5) + '|' + p.team + '|' + p.unit + '|' + nameOf(t.username); },
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
    // 폰(≤600px)에서는 줄마다 두 줄 카드(table.mc — 2026-10-19 사용성 2차 #7): 날짜·목적·거리 / 방문처·통행료·주차. PC 는 표 그대로.
    var h = '<div class="panel"><div class="scroll" data-rows><table class="mc"><thead><tr>' +
      th('날짜', 'date', -1) + (showWho ? th('소속 · 이름', 'who', 1) : '') + th('목적', 'purp', 1) + th('차량', 'car', 1) +
      th('거리', 'dist', -1, true) + (opt.compact ? '' : th('계기판', 'odo', -1, true)) +
      th('통행료', 'toll', -1, true) + (opt.compact ? '' : th('주차', 'park', -1, true)) +
      th('방문처', 'place', 1) + '</tr></thead><tbody>';
    rows.slice(0, pg.n).forEach(function (t) {
      var place = t.visit_place || t.end_address || '';
      h += '<tr class="clk' + (flags[t.id] ? ' flagged' : '') + '" tabindex="0" data-trip="' + t.id + '">' +
        // 여러 해를 함께 볼 때는 연도가 없으면 어느 해인지 알 수 없다.
        '<td class="m1"><span class="lead">' + (isMulti() ? ymd(t.start_time).slice(2).replace(/-/g, '.') : md(t.start_time)) +
        '</span> <span class="dim">' + hm(t.start_time) + '</span>' +
        (t.is_manual ? ' <span class="kind">수기</span>' : '') + '</td>' +
        (showWho ? whoCell(t.username).replace('<td class="whoc">', '<td class="whoc m1">') : '') +
        '<td class="m1">' + purposeCell(t.purpose) + '</td>' +
        '<td class="mx">' + esc(t.plate_no || '—') + '</td>' +
        '<td class="n mr" data-u="km">' + km(t.distance_km) + '</td>' +
        (opt.compact ? '' : '<td class="n dim mx" style="white-space:nowrap">' + n0(t.start_odometer) + ' → ' + n0(t.end_odometer) + '</td>') +
        '<td class="n" data-l="통행료">' + tollCell(t) + '</td>' +
        (opt.compact ? '' : '<td class="n' + (t.parking_cost ? '' : ' mx') + '" data-l="주차">' + (t.parking_cost ? n0(t.parking_cost) : '—') + '</td>') +
        '<td class="el m2" title="' + esc(place) + '">' + esc(place) + '</td></tr>';
    });
    return h + '</tbody></table></div>' + pg.more + '</div>';
  }

  /** 사람·차량·목적·날짜까지만 건 것(검색어·점검 칩은 뺀 것). 칩 숫자를 이 안에서 센다. */
  /** ignorePurp: 점검 칩 숫자는 목적과 상관없이 센다(목적 기본값이 일반업무라 출퇴근 칩이 늘 0 이 되던 것). */
  function baseFiltered(ignorePurp) {
    return TRIPS.filter(function (t) {
      if (FILT.who && t.username !== FILT.who) return false;
      if (FILT.car && t.plate_no !== FILT.car) return false;
      if (!ignorePurp && FILT.purp && (FILT.purp === '-' ? !!(t.purpose || '') : t.purpose !== FILT.purp)) return false;
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

  /** 관리자 운행 기록 폰 「조건 ▾」을 펼쳐 두었는가(다시 그려도 그대로, 2026-10-20 D2). */
  var TFOLD_OPEN = false;
  function viewTrips() {
    if (!LOADED) return head(scopeTitle('운행 기록')) + skeleton();
    // 예전 「출퇴근」 칩을 눌러 둔 상태 → 목적 칸 「출퇴근」으로(칩은 뺐다, 2026-10-15 2차)
    if (FILT.chip === 'commute') { FILT.chip = 'all'; FILT.purp = '출퇴근'; }
    var A = audit();
    // 칩 숫자는 '지금 걸린 사람·차량·날짜' 안에서 센다(검색어·칩 자신·목적은 빼고 — 점검 칩을 누르면 목적 조건이 풀린다). 「전체」만 표와 같은 조건.
    var base = baseFiltered(true);
    var inBase = {}; base.forEach(function (t) { inBase[t.id] = 1; });
    var c = {};
    A.forEach(function (f) {
      c[f.k] = (f.rows || []).filter(function (t) { return inBase[t.id]; }).length;
    });
    var rows = filtered(), t2 = totals(rows, { tripsOnly: true });   // 표에 보이는 운행만의 소계

    // 무엇으로 좁혀 놓았는지 제목에 드러낸다. 그 상태로 CSV 를 누르는 실수를 줄인다.
    var narrowed = filterWords();
    var h = head(scopeTitle('운행 기록') + (narrowed.length ? ' — ' + narrowed.join(' · ') : ''),
      esc(viewName()) + ' · ' + esc(viewSpan()) + (isMulti() ? ' · <b>조회 전용</b>' : ''));

    // 관리자(전체) 운행 기록은 폰(≤600px)에서 조건 칸 다섯 개를 「조건 ▾」 한 줄로 접는다(2026-10-20 D2 · AU6-L3 — 표가 화면 아래로 밀렸다).
    //   PC 는 그대로 한 줄(접는 단추는 숨고 칸들은 그 줄에 그대로 놓인다). 걸린 조건은 단추에 글로.
    var tfold = isAll();
    if (tfold) {
      var tfw = filterWords(); if (FILT.q) tfw.push('‘' + FILT.q + '’');
      h += '<div class="bar tfbar' + (TFOLD_OPEN ? ' open' : '') + '"><button type="button" class="btn tfoldbtn" data-tfold aria-expanded="' + TFOLD_OPEN + '" aria-controls="tfFields">' +
        ic('list', 14) + '<span class="tft">조건' + (tfw.length ? ' · ' + esc(tfw.join(' · ')) : '') + '</span><span class="tfar" aria-hidden="true">▾</span></button>' +
        '<div class="tfields" id="tfFields">';
    } else h += '<div class="bar">';
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
      '<input id="qBox" aria-label="운행 찾기" placeholder="방문처·주소·이름" title="단축키 /" value="' + esc(FILT.q) + '"></label>';
    if (tfold) h += '</div>';
    h += '<div class="sp" style="flex:1"></div>';
    if (!isMulti()) h += '<button class="btn sm" id="btnAddTrip">＋ 운행 추가</button>';
    // 예전 이름은 「엑셀」이었는데 받는 것은 CSV 목록이다. 양식 엑셀(운행기록부)은 정산 화면에 있다.
    h += '<button class="btn sm" id="btnCsv" title="지금 보이는 목록을 CSV로 다운로드해요. 양식 엑셀은 ‘정산·엑셀’ 화면에 있어요.">' +
      ic('dl', 13) + '목록 CSV</button>';
    h += '</div>';

    // 2026-10-15 2차: 「전체 N」은 표와 같은 조건(목적·검색어 포함)으로 센다 — 예전에는 목적을 빼고 세어 「전체 6」인데 표는 4건이었다.
    //   「출퇴근」 칩은 뺐다 — 목적은 위 목적 칸 하나로 고른다.
    var allN = (function () { var keep = FILT.chip; FILT.chip = 'all'; var n = filtered().length; FILT.chip = keep; return n; })();
    h += '<div id="belowF"><div class="bar"><div class="seg">' +
      seg('all', '전체', allN) +
      seg('unk', '통행료 미확정', c.unk, 1) +
      seg('jump', '계기판 튐', c.jump) +
      seg('nopurp', '목적 미선택', c.nopurp) +
      seg('overlap', '시간 겹침', c.overlap) +
      seg('zero', '0km', c.zero) +
      seg('manual', '수기', base.filter(function (t) { return t.is_manual; }).length) +
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

    var h = head(scopeTitle('기록 점검'), esc(viewName()) + ' · 금액이 틀어지기 쉬운 기록을 찾아 줘요');

    if (!found.length) {
      h += '<div class="hero fade"><div class="eyebrow"><span class="dot" style="background:var(--ok)"></span>점검 완료</div>' +
        '<p class="verdict clean"><em>이번 기간은 고칠 기록이 없어요</em></p>' +
        '<div class="facts"><div class="fact"><div class="k">검사 항목</div><div class="v">' +
        A.length + '<small>가지</small></div><div class="sub">전부 이상 없음</div></div></div></div>';
    } else {
      h += sect('발견된 것', found.length + '가지', '',
        '<div class="panel">' + found.map(isAll() ? function (f) { return adminIssueRow(f, false); } : issueRow).join('') + '</div>');
    }
    // 이상 없는 항목은 한 줄로 접는다(2026-10-19 웹 사용성 1차 — 6줄이 발견된 것보다 길었다). 펼치면 항목 이름.
    if (okOnes.length) {
      h += '<details class="okfold"><summary>' + ic('check', 15) + '<span>이상 없음 <b>' + okOnes.length + '가지</b></span>' +
        '<span class="dim">' + esc(okOnes.map(function (f) { return f.t; }).join(' · ')) + '</span></summary>' +
        '<div class="panel">' + okOnes.map(function (f) {
          return '<div class="issue sv-ok" style="cursor:default">' +
            '<span class="ico">' + ic('check', 16) + '</span>' +
            '<span class="bd"><span class="t">' + esc(f.t) + '</span></span>' +
            '<span class="amt" style="color:var(--ok)">0</span><span style="width:15px"></span></div>';
        }).join('') + '</div></details>';
    }

    h += sect('점검 기준', null, '',
      '<div class="panel" style="padding:18px 20px;font-size:13px;line-height:1.7;color:var(--ink-3)">' +
      '<b style="color:var(--ink-2)">계기판이 크게 튄 곳</b>: 같은 사람, 같은 차에서 1,000km 이상 벌어진 지점이에요. 계기판 숫자를 잘못 적었을 수 있어요.<br>' +
      '<b style="color:var(--ink-2)">한 차를 두 사람이</b>: 번호판을 잘못 고르면 남의 차 기록이 돼요.<br>' +
      '<b style="color:var(--ink-2)">운행목적 미선택</b>: 업무용으로 잡히지 않아 금액이 0원이 돼요.<br>' +
      '<b style="color:var(--ink-2)">유류단가 미등록</b>: 기본 단가 159원/km로 계산돼 실제와 달라요.<br>' +
      '<b style="color:var(--ink-2)">통행료 미확정</b>: 정산에서 0원으로 잡혀 실제보다 덜 받아요.</div>');
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
      ' · 앱과 이 화면에서 올린 영수증이 함께 모여요');
    var stepMode = !isAll() && !isMulti();
    var unkMine = stepMode ? ALL_TRIPS.filter(function (t) { return t.username === mine && !t.deleted_at && (t.purpose || '') === BUSINESS && isUnknownToll(t); }) : [];
    var byAll = {};
    all.forEach(function (e) { var c = e.category || '기타'; byAll[c] = byAll[c] || { n: 0 }; byAll[c].n++; });
    // 사람이 구분 칸(전체·주차…)을 직접 고르기 전에는 지금 차례의 구분으로 좁혀 보인다.
    if (stepMode && !EVF.touched) EVF.cat = EV_SUBS[evSub()];
    if (stepMode) {
      h += evSubHtml(byAll, unkMine);
      setTimeout(autoFillEv, 0);           // 영수증으로 채운 금액을 운행 기록에도 적는다(v3 — 그린 뒤에, 한 번씩만)
    }

    // 스캐너로 뜬 영수증을 올리는 자리. 잠긴 주기는 서버가 막으므로
    // 버튼도 두지 않는다 — 올리게 해 놓고 저장에서 튕기면 안 된다.
    //   ★ 내 영수증(차례 화면)에서는 차례 카드의 「○○ 영수증 올리기」 하나만 둔다 — 같은 창을 여는 단추가 둘이었다(2026-10-15 2차).
    var upBtn = (isMulti() || cycleLocked(mine) || stepMode) ? '' :
      '<button class="btn pri sm" id="btnEvUp">' + ic('receipt', 13) + '영수증 올리기</button>';

    if (!all.length) {
      return h + (locked
        ? blank('등록된 영수증이 없어요.', cycleName(CYC) + '에는 ' + lockWhy(mine) + ' 더 올릴 수 없어요.', 'receipt')
        : '<div class="panel"><div class="blank"><div class="ico">' + ic('receipt', 21) + '</div>' +
          '<div class="t">등록된 영수증이 없어요.</div>' +
          '<div class="d">앱이나 ' + (stepMode ? '‘영수증 올리기’로' : '이 화면에서') + ' 올린 사진과 스캔 PDF가 여기에 모여요.<br>' +
          'A4에 여러 장 붙여 스캔한 파일도 올릴 수 있어요.</div>' +
          (upBtn ? '<div style="margin-top:16px"><button class="btn pri" id="btnEvUp">' + ic('receipt', 14) +
          '영수증 올리기</button></div>' : '') + '</div></div>');
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
    // 2026-10-19 사용성 2차: 이 카드는 「올린 영수증」 합계다 — 마감 화면의 업무용 비용(정산 금액)과 숫자가 달라 헷갈렸다.
    //   이름을 「올린 영수증 합계」로 하고, 내 화면에서는 정산에 들어가는 금액(마감 화면과 같은 계산 totals)을 한 줄 같이 보인다.
    var Tst = stepMode ? totals(TRIPS, { who: mine }) : null;
    //   큰 숫자는 받을 돈(정산 금액)으로 — 로봇이 큰 「올린 영수증 합계」를 받을 돈으로 읽었다(2026-10-19).
    h += '<div class="hero fade">' + (Tst
      ? '<div class="eyebrow"><span class="dot"></span>정산에 들어가는 주차·통행료 · 마감 화면과 같음</div>' +
        '<p class="verdict">' + won(Tst.park + Tst.toll) + '</p>' +
        '<div class="evsettle" data-evsettle>주차비 <b>' + won(Tst.park) + '</b> · 통행료 <b>' + won(Tst.toll) + '</b> · 올린 영수증 합계 ' + won(settle) +
        (Tst.park + Tst.toll !== settle ? '<br><span class="dim">정산 금액이 올린 영수증 합계와 달라요. 운행에 금액이 있는 날은 운행 금액이 들어가고, 업무 운행이 없는 날의 영수증은 빠져요.</span>' : '') +
        '</div>'
      : '<div class="eyebrow"><span class="dot"></span>올린 주차·통행료 영수증 합계</div><p class="verdict">' + won(settle) + '</p>') +
      '<div class="facts">' +
      fct('주차', won((by['주차'] || {}).sum || 0), n0((by['주차'] || {}).n || 0) + '건 · 올린 영수증') +
      fct('통행료', won((by['통행료'] || {}).sum || 0), n0((by['통행료'] || {}).n || 0) + '건 · 올린 영수증') +
      fct('주유', won((by['주유'] || {}).sum || 0), n0((by['주유'] || {}).n || 0) + '건 · 증빙용(유류비는 거리×단가)') +
      fct('계기판', n0((by['계기판'] || {}).n || 0) + '<small>장</small>', '운행 계기판 확인용') +
      '</div></div>';

    if (locked) h += '<div class="hpnote">' + ic('check', 16) + '<span><b>' + esc(lockTitle(mine)) +
      '.</b> 영수증을 더 올리거나 지울 수 없어요. ' + lockHow(mine) + '</span></div>';

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
      who: function (e) { var p = orgPath(e.username); return ('0000' + orgRank(p)).slice(-5) + '|' + p.team + '|' + p.unit + '|' + nameOf(e.username); },
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
    // 여러 줄 골라 지우기(2026-10-19) — 내가 올린 줄이 보일 때만 고르기 칸. 못 지우는 줄(잠긴 기간·다른 분 것)은 막고 까닭을 단다.
    var selOn = rows.some(function (e) { return e.username === mine; });
    var evWhyNot = function (e) {
      return e.username !== mine ? '다른 분이 올린 영수증은 지울 수 없어요'
        : evLocked(e) ? '결재 중이거나 결재가 끝난 기간이라 지울 수 없어요' : '';
    };
    var thDate = thSort('날짜', 'date', 'ev', -1);
    if (selOn) thDate = thDate.replace(/^<th class="/, '<th class="mselth ').replace(/^(<th[^>]*>)/, function (m) { return m + mselAll('ev'); });
    // 기간 경계에 걸친 이은 영수증(이은 운행이 다른 기간이라 어느 기간에도 정산 안 됨) — 줄에 문구만(2026-10-17 사용자, 금액은 그대로)
    var XLH = {};
    if (!isMulti()) {
      var xr = cycleRange(CYC), xu = {};
      all.forEach(function (e) { if (e.trip_id != null && (e.category === '주차' || e.category === '통행료')) xu[e.username] = 1; });
      Object.keys(xu).forEach(function (u) { xlinkOf(u, xr).here.forEach(function (x) { XLH[x.e.id] = x; }); });
    }
    // 날짜 칸을 치는 동안 입력 칸을 갈아 끼우지 않게, 날짜에 따라 바뀌는 곳(건수 · 표)만 따로 표시해 둔다(paintBelow).
    h += sect('내역', '<span data-live="evcnt">' + (rows.length === all.length ? rows.length + '건' : rows.length + ' / ' + all.length + '건') + '</span>', upBtn,
      // 폰(≤600px)에서는 줄마다 두 줄 카드(table.mc — 2026-10-20 폰 마무리: 금액·사진·지우기 칸이 오른쪽에서 잘렸다).
      //   1줄: 고르기·날짜 · 구분 … 금액 / 2줄: 메모 · 차량 / 3줄: 사진·원본·지우기. 표 머리가 정렬 칩이 되므로 「모두 고르기」는 표 위 한 줄.
      bar + '<div id="belowF">' + (rows.length ? (selOn ? mselAllLine('ev', 'evtab') : '') + '<div class="panel"><div class="scroll" data-rows><table class="mc evtab"><thead><tr>' +
      thDate + (isAll() ? thSort('소속 · 이름', 'who', 'ev', 1) : '') +
      thSort('구분', 'cat', 'ev', 1) + '<th>차량</th>' +
      thSort('금액', 'amount', 'ev', -1, true) + '<th>메모</th><th></th></tr></thead><tbody>' +
      rows.map(function (e) {
        var canDel = e.username === mine && !evLocked(e);
        var xl = XLH[e.id];
        // 계기판 사진은 금액이 없다(0원으로 저장) — 「0원」 대신 검증 때 사진에서 읽은 km, 없으면 「계기판 사진」(2026-10-21 사용자). 합계는 그대로(0원).
        var odo = e.category === '계기판' && !(Number(e.amount) || 0), okm = odo ? evOdoKm(e) : null;
        var amtTxt = odo ? (okm != null ? n0(okm) + ' km' : '사진') : n0(e.amount) + '원';
        var line = md(e.date_millis) + ' ' + (e.category || '기타') + ' ' + amtTxt + (isAll() && e.username !== mine ? ' ' + nameOf(e.username) : '');
        return '<tr' + (xl ? ' data-evxl="' + esc(e.id) + '"' : '') + '><td class="m1' + (selOn ? ' mseltd' : '') + '">' +
          (selOn ? mselBox('ev', { id: String(e.id), amt: e.amount, line: line, why: evWhyNot(e) }) : '') +
          '<span class="lead">' + md(e.date_millis) + '</span>' +
          (xl ? '<div class="evxl" title="' + esc(xl.say) + '">' + esc(md(xl.t.start_time)) + ' 운행(' + CR.short(cycleOfMs(Number(xl.t.start_time))) + ')에 이음 · 어느 기간에도 정산 안 됨</div>' : '') + '</td>' +
          (isAll() ? whoCell(e.username).replace('<td class="whoc">', '<td class="whoc m1">') : '') +
          '<td class="m1"><span class="kind">' + esc(e.category || '기타') + '</span></td>' +
          '<td class="dim' + (e.vehicle_plate ? '' : ' mx') + '">' + esc(e.vehicle_plate || '—') + '</td>' +
          (odo ? '<td class="n mr' + (okm != null ? ' total' : ' dim') + '" data-evkm>' + (okm != null ? amtTxt : '계기판 사진') + '</td>'
            : '<td class="n total mr" data-u="원">' + n0(e.amount) + '</td>') +
          '<td class="el m2' + (e.memo ? '' : ' mx') + '" title="' + esc(e.memo || '') + '">' + esc(e.memo || '') + '</td>' +
          // 원본 장을 이 줄 사진으로 쓴 줄(photo_path = scan_path — 영수증 자리를 못 받아 오리지 않음, 2026-10-21)은 「원본」 하나만
          '<td class="n mact" style="white-space:nowrap">' + (e.photo_path && e.photo_path === e.scan_path ? ''
            : e.photo_path ? '<a class="btn sm" target="_blank" rel="noopener" href="' + esc(photoUrl(e.photo_path)) + '">사진</a>'
            : '<span class="dim" style="font-size:12px">사진 없음</span>') +
          (e.scan_path ? ' <a class="btn sm" target="_blank" rel="noopener" title="' +
            (e.photo_path === e.scan_path ? '영수증 자리를 찾지 못해 원본 장 전체가 이 줄의 사진이에요' : '스캔한 A4 원본') + '" href="' +
            esc(photoUrl(e.scan_path)) + '">원본</a>' : '') +
          // 잘못 올린 것을 못 지우면 정산 금액이 부풀어 오른 채로 남는다.
          (canDel ? ' <button class="btn sm" data-evdel="' + esc(e.id) + '">지우기</button>' : '') +
          '</td></tr>';
      }).join('') + '</tbody><tfoot><tr><td colspan="' + (isAll() ? 4 : 3) + '">보이는 ' + n0(rows.length) +
      '건 합계</td><td class="n total">' + n0(sumShown) + '</td><td colspan="2"></td></tr></tfoot></table></div></div>' +
        (selOn ? mselBar('ev') : '')
        : '<div class="panel"><div class="blank"><div class="t">조건에 맞는 영수증이 없어요.</div>' +
          '<div style="margin-top:12px"><button class="btn sm" data-fclear>조건 지우기</button></div></div></div>') + '</div>');
    return h;
  }
  /** 증빙 화면의 좁히기 상태(구분). 날짜는 DATEF, 정렬은 SORTS.ev 를 쓴다. */
  var EVF = { cat: 'all' };
  function photoUrl(path) {
    return SB + '/storage/v1/object/public/evidence/' + String(path).split('/').map(encodeURIComponent).join('/');
  }
  /** 계기판 사진에서 읽은 km(검증 때 Gemini 가 읽은 것 — evidence_ai, 사진이 바뀌었거나 못 읽었으면 없음) · 없으면 null. */
  function evOdoKm(e) {
    var ai = aiOf(e);
    return ai && ai.odometer_km != null && isFinite(Number(ai.odometer_km)) ? Math.round(Number(ai.odometer_km)) : null;
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
    evCropReset();                         // 오리느라 풀어 둔 마지막 장 그림도 놓는다
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
    if (isMulti()) { toast('영수증은 한 기간씩 올려요. 기간을 하나 골라 주세요.', true); return; }
    if (cycleLocked(myName())) { toast(lockWhy(myName()) + ' 이 기간에는 올릴 수 없어요.', true); return; }
    // 올리는 중에 뒤로가기로 창이 닫혔을 수 있다. 그 사이 새 창을 열면 돌고 있는 올리기가 새 목록을 건드린다.
    if (EV_SENDING) { toast('앞서 누른 영수증을 아직 올리는 중이에요. 끝나면 다시 열어 주세요.'); return; }
    evFreeUrls();
    EVUP = { busy: false, items: [], pages: [], sent: false, defCat: EV_CATS.indexOf(defCat) >= 0 ? defCat : '' };
    var r = cycleRange(CYC);
    var my = personOf(myName());
    var cars = myPlates();
    // 계기판 차례에서 열면 창 이름·안내도 계기판으로(2026-10-21 — 계기판 사진은 금액이 아니라 km 를 읽는다)
    var odo = EVUP.defCat === '계기판';
    $('pTitle').textContent = odo ? '계기판 사진 올리기' : '영수증 올리기';
    $('pSub').textContent = cycleName(CYC) + ' · ' + cycleSpan(CYC);
    $('pBody').innerHTML =
      '<div class="drop gemdrop" id="evDrop" style="margin:0 0 14px">' +
      '<div class="gemorb">' + gemSvg(28) + '</div>' +
      '<div class="gemchip">' + gemSvg(12) + 'AI가 읽어 드려요</div>' +
      (odo
        ? '<div class="dt">계기판 사진을 올리면 <b class="gemtxt">AI</b>가 km를 읽어 드려요</div>' +
          '<div class="dd">JPG, PNG 파일을 여러 장 올릴 수 있어요. PC에서는 여기에 끌어다 놓아도 돼요.<br>' +
          '날짜는 <b>사진을 찍은 날</b>로 미리 넣어요. 맞는지 확인해 주세요.</div>'
        : '<div class="dt">영수증을 올리면 <b class="gemtxt">AI</b>가 구분, 날짜, 금액을 읽어 드려요</div>' +
          '<div class="dd">JPG, PNG, PDF 파일을 여러 장 올릴 수 있어요. PC에서는 여기에 끌어다 놓아도 돼요.<br>' +
          '<b>A4에 여러 장 붙여 스캔한 파일도 그대로</b> 올리세요. 영수증마다 한 줄씩 나눠 적어요.</div>') +
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
      '<div class="fhint">올리는 파일 모두에 같이 적혀요.</div></div></div></div>' +
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
        ? gemTag('AI') + '가 사진에서 <b>구분·날짜·금액</b>을 읽어 미리 채워 드려요. 틀릴 수 있으니 <b>올리기 전에 꼭 확인</b>해 주세요.'
        : 'AI 읽기가 꺼져 있어 구분, 날짜, 금액을 직접 넣어야 해요. 한 장에 영수증이 여럿이면 줄 끝의 <b>＋</b>로 줄을 늘리세요.';
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
    if (tooBig.length) { evNote('<b style="color:var(--red)">‘' +
      esc(tooBig[0].name) + '’ 파일이 30MB를 넘어요.</b> 더 작은 사진이나 PDF로 골라 주세요.'); return; }

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
        // 사진을 찍은 날 — 고른 파일 그대로에서 읽는다(줄인 그림은 캔버스를 거쳐 EXIF 가 빠진다). PDF 쪽은 없음(null).
        var shotP = evShotOf(file);
        return fileToJpegs(file, function (n, total) {
          if (!live()) return;
          evNote('<b>' + esc(file.name) + '</b> ' + n + ' / ' + total + '쪽 바꾸는 중…' +
            (total > 3 ? ' <span class="dim">다른 탭으로 가면 잠시 멈췄다가, 돌아오면 이어서 바꿔요.</span>' : ''));
        }).then(function (blobs) {
          return shotP.then(function (shot) {
            if (!live()) return;
            // PDF 에서 나온 장인가(2026-10-23) — 영수증이 하나뿐인 장도 오릴지 가른다(evScanPages · 폰 사진은 그대로)
            var fromPdf = /pdf$/i.test(file.type || '') || /\.pdf$/i.test(file.name || '');
            blobs.forEach(function (b, i) {
              var pi = EVUP.pages.length;
              EVUP.pages.push({
                blob: b, url: URL.createObjectURL(b), ai: '', shot: shot, pdf: fromPdf,
                name: file.name + (blobs.length > 1 ? ' (' + (i + 1) + '/' + blobs.length + '쪽)' : '')
              });
              EVUP.items.push(evBlankItem(pi));
              fresh.push(pi);
            });
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
        m === 'pdfjs' ? 'PDF 읽기 도구를 불러오지 못했어요. 새로고침하거나 사진으로 올려 주세요.'
          : m === 'toomany' ? 'PDF가 30장을 넘어요. 나눠서 올려 주세요.'
            : m === 'image' ? '이미지를 읽지 못했어요. 다른 파일로 올려 주세요.'
              : '파일을 읽지 못했어요. 다른 파일로 다시 올려 주세요.') + '</b>');
      if (m && m !== 'pdfjs' && m !== 'toomany' && m !== 'image') console.warn('영수증 읽기 실패', m);
    });
  }
  /** 빈 줄 하나. 날짜는 오늘 — 단 오늘이 보는 기간 밖이면 비워 두고 고르게 한다(2026-10-20 AU2).
   *  예전엔 기간 안으로 당겨 넣어, 마감 뒤 5일(지난 기간을 보는 중)에 올린 오늘 영수증이 지난 기간 마지막 날로 조용히 들어갔다.
   *  ★ 구분은 비워 둔다. 예전 기본값 '주유' 는 주차 영수증을 안 바꾸고 올리면 정산에서 빠지게 했다.
   *  줄의 안내는 셋으로 나눠 둔다(2026-10-21 — 계기판 줄은 금액 안내를 보이지 않는다): dh 날짜 · amtMiss 금액을 못 읽음 · hint 그 밖(흐림·자리).
   *  dhShot = dh 가 사진 정보(찍은 날)에서 온 안내 — Gemini 가 한 일이 아니라 Gemini 딱지 없이 따로 보인다.
   *  km = Gemini 가 읽은 계기판 km · dateBy = 날짜를 누가 넣었나(today 기본값 · shot 찍은 날 · ai · user). */
  function evBlankItem(pi) {
    var now = Date.now(), inside = now >= EVUP.lo && now < EVUP.hi;
    var it = { page: pi, cat: EVUP.defCat || '', amt: '', memo: '', crop: null, ai: false, km: null, amtMiss: false, hint: '',
      date: inside ? ymd(now) : '', dateBy: inside ? 'today' : '', dhShot: false,
      dh: inside ? '' : '오늘이 ' + cycleName(CYC) + '(' + cycleSpan(CYC) + ') 기간 밖이라 날짜를 골라 주세요' };
    // 계기판에는 날짜가 없다 — 사진을 찍은 날로(사진 날짜가 없는 PDF 쪽은 위 규칙 그대로)
    if (it.cat === '계기판') evShotDate(it);
    return it;
  }

  /* ── 사진을 찍은 날(2026-10-21 사용자 「계기판 사진 영수증 올리기는 금액·메모가 아니지 않나?」) ──
     계기판에는 날짜가 없어 Gemini 가 날짜를 주지 못한다 — 계기판 줄은 사진을 찍은 날로 미리 채운다.
     JPEG 의 EXIF DateTimeOriginal(없으면 DateTime)을 고른 파일 앞쪽에서 직접 읽고(작은 파서 — 외부 라이브러리 없음), 없으면 파일 날짜(lastModified).
     못 읽으면 조용히 넘어간다(null). */
  function exifTakenMs(file) {
    var jpeg = /jpe?g$/i.test((file && file.type) || '') || /\.jpe?g$/i.test((file && file.name) || '');
    if (!jpeg || !file.slice || !window.FileReader) return Promise.resolve(null);
    return new Promise(function (ok) {
      var fr = new FileReader();
      fr.onload = function () { var ms = null; try { ms = exifDate(new DataView(fr.result)); } catch (e) { ms = null; } ok(ms); };
      fr.onerror = function () { ok(null); };
      try { fr.readAsArrayBuffer(file.slice(0, 262144)); } catch (e) { ok(null); }   // EXIF(APP1)는 파일 맨 앞 64KB 안 — 넉넉히 256KB
    });
  }
  /** JPEG 앞쪽 바이트 → 찍은 시각(ms) · 없으면 null. 이음표(마커)를 따라가 APP1 「Exif」 를 찾는다(그림 자료 SOS 앞에서 멈춤). */
  function exifDate(v) {
    var n = v.byteLength, p = 2;
    if (n < 12 || v.getUint16(0) !== 0xFFD8) return null;
    while (p + 4 <= n) {
      if (v.getUint8(p) !== 0xFF) return null;
      var mk = v.getUint8(p + 1);
      if (mk === 0xFF) { p++; continue; }                                   // 채움 바이트
      if (mk === 0xD9 || mk === 0xDA) return null;                          // 끝 · 그림 자료 시작 — 그 뒤엔 EXIF 가 없다
      if (mk === 0x01 || (mk >= 0xD0 && mk <= 0xD8)) { p += 2; continue; }  // 길이 없는 이음표
      var len = v.getUint16(p + 2), seg = p + 4;
      if (len < 2) return null;
      if (mk === 0xE1 && len >= 16 && seg + 6 <= n && v.getUint32(seg) === 0x45786966 && v.getUint16(seg + 4) === 0) {
        return exifTiff(v, seg + 6, Math.min(n, p + 2 + len));
      }
      p += 2 + len;
    }
    return null;
  }
  /** TIFF 머리(t) → IFD0(0x0132 DateTime · 0x8769 Exif IFD 자리) → Exif IFD(0x9003 DateTimeOriginal). 글 「YYYY:MM:DD HH:MM:SS」 — 시간대가 없어 한국 시각으로 읽는다. */
  function exifTiff(v, t, end) {
    if (t + 8 > end) return null;
    var bo = v.getUint16(t), le = bo === 0x4949;
    if (!le && bo !== 0x4D4D) return null;
    var u16 = function (o) { return v.getUint16(o, le); }, u32 = function (o) { return v.getUint32(o, le); };
    if (u16(t + 2) !== 42) return null;
    var ifd = function (off) {
      var o = t + off, out = {};
      if (!off || o + 2 > end) return out;
      for (var i = 0, cnt = u16(o); i < cnt && i < 256; i++) {
        var e = o + 2 + i * 12;
        if (e + 12 > end) break;
        var tag = u16(e), type = u16(e + 2), num = u32(e + 4);
        if (tag === 0x8769) out.exif = u32(e + 8);
        else if ((tag === 0x0132 || tag === 0x9003) && type === 2 && num >= 19) out[tag] = u32(e + 8);   // 20바이트 글 — 4바이트가 넘으니 늘 자리값
      }
      return out;
    };
    var txt = function (off) {
      if (off == null || t + off + 19 > end) return '';
      for (var s = '', i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(t + off + i));
      return s;
    };
    var at = function (s) {
      var m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
      if (!m || +m[1] < 2000) return null;                                   // 「0000:00:00 00:00:00」 같은 빈 값
      var ms = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+09:00');
      return isFinite(ms) ? ms : null;
    };
    var d0 = ifd(u32(t + 4)), dx = d0.exif ? ifd(d0.exif) : {};
    return at(txt(dx[0x9003])) || at(txt(d0[0x0132]));
  }
  /** 올린 파일을 찍은 날(ms) — 사진이면 EXIF, 없으면 파일 날짜. PDF(쪽을 그림으로 바꾼 장)는 null. 늘 이루어진다(실패하면 null). */
  function evShotOf(file) {
    if (!file || /pdf$/i.test(file.type || '') || /\.pdf$/i.test(file.name || '')) return Promise.resolve(null);
    return exifTakenMs(file).then(function (ms) {
      if (ms != null) return ms;
      var lm = Number(file.lastModified);
      return isFinite(lm) && lm > 0 ? lm : null;
    }, function () { return null; });
  }
  /** 계기판 줄 날짜 = 그 장을 찍은 날. 보는 기간 안이면 넣고, 밖이면 비운다(+ 까닭). 장에 찍은 날이 없으면(PDF 쪽) false — 부른 쪽 규칙 그대로. */
  function evShotDate(it) {
    var pg = EVUP.pages[it.page], ms = pg ? pg.shot : null;
    if (ms == null || !isFinite(ms)) return false;
    var day = ymd(ms), d0 = Date.parse(day + 'T00:00:00+09:00'), inside = d0 >= EVUP.lo && d0 < EVUP.hi;
    it.date = inside ? day : '';
    it.dateBy = inside ? 'shot' : '';
    it.dh = inside ? '사진을 찍은 날로 넣었어요. 맞는지 확인해 주세요.'
      : '사진 정보의 날짜(' + day.replace(/-/g, '.') + ')가 ' + cycleName(CYC) + '(' + cycleSpan(CYC) + ') 기간 밖이에요. 찍은 날을 넣어 주세요.';   // 점 꼴 — 「2026-09-」에서 줄이 끊기지 않게
    it.dhShot = true;
    return true;
  }
  /** 줄 아래 안내 한 줄(Gemini 줄이면 딱지와 함께) — 계기판 줄에는 금액 안내가 없고 km 는 제 칸에 있다. 다른 구분이면 예전처럼 「계기판 N km」(Gemini 가 계기판으로 읽은 사진)도.
   *  사진 정보로 넣은 날짜 안내(dhShot)는 여기 넣지 않는다 — 따로 딱지 없이 보인다(paintEvList). */
  function evHintOf(it) {
    var odo = it.cat === '계기판', p = [];
    if (it.dh && !it.dhShot) p.push(it.dh);
    if (!odo && it.km != null) p.push('계기판 ' + n0(it.km) + ' km로 읽었어요.');
    if (!odo && it.amtMiss) p.push('금액을 읽지 못했어요. 직접 넣어 주세요.');
    if (it.hint) p.push(it.hint);
    return p.map(endDot).join(' ');
  }

  function blobToB64(blob) {
    return new Promise(function (ok, no) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result || ''); ok(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = function () { no(new Error('read')); };
      fr.readAsDataURL(blob);
    });
  }
  /** 장 그림을 한 번 풀어 회색조로 둔다 — 영수증마다 오릴 때 같은 장을 다시 풀지 않는다. { img, W, H, g(Uint8Array | null) } · 못 읽으면 null.
   *  마지막 한 장만 들고 있는다(창을 닫으면 evCropReset 이 비운다). */
  var EVPG = { url: '', p: null };
  function evPage(pageUrl) {
    if (EVPG.url === pageUrl && EVPG.p) return EVPG.p;
    var p = new Promise(function (ok) {
      var img = new Image();
      img.onload = function () {
        var W = img.naturalWidth, H = img.naturalHeight, g = null;
        try {
          var cv = document.createElement('canvas');
          cv.width = W; cv.height = H;
          var cx = cv.getContext('2d');
          cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H);
          cx.drawImage(img, 0, 0);
          var d = cx.getImageData(0, 0, W, H).data;
          g = new Uint8Array(W * H);
          for (var i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        } catch (e) { g = null; }            // 회색조를 못 만들면 테두리 맞춤 없이 상자대로 오린다
        ok({ img: img, W: W, H: H, g: g });
      };
      img.onerror = function () { ok(null); };
      img.src = pageUrl;
    });
    EVPG = { url: pageUrl, p: p };
    return p;
  }
  function evCropReset() { EVPG = { url: '', p: null }; }
  /**
   * 영수증 상자(px)를 장에 그려진 칸 테두리에 맞춘다(2026-10-21 — 하이패스 「영수증 출력」처럼 영수증마다 옅은 회색 사각형이 있는 격자 장).
   *   Gemini 상자는 촘촘한 장에서 어긋난다(옆 영수증과 섞임 · 왼쪽이 잘려 연도가 안 보임 — 2026-10-21 직원 10월분 사례). 상자 변마다 ± 30% 안에서
   *   상자 길이 가운데 70%를 거의 끊김 없이(75% 이상) 지나는 선을 찾아, 상자 변에 가장 가까운 선을 고른다. 그 안쪽에 선이 또 있고
   *   둘 사이가 비었으면(칸 사이 빈틈 — 바깥 선은 옆 칸 테두리) 안쪽 선으로 옮긴다. 네 변이 다 있고, 크기가 상자의 0.6~1.6배이고,
   *   상자와 반 넘게 겹치고, 네 변이 그 사각형 길이로 다시 재도 선일 때만 쓴다 — 아니면 null(상자 + 작은 여유로 오린다).
   *   돌려주는 것: 테두리 선 바로 안쪽 [x0, y0, x1, y1) (x1·y1 은 들어가지 않음).
   */
  function evSnap(G, bx0, by0, bx1, by1) {
    var W = G.W, H = G.H, g = G.g, R = 3, D = 14, TH = 0.75;
    if (!g) return null;
    var bw = bx1 - bx0, bh = by1 - by0;
    if (bw < 60 || bh < 60) return null;
    // 선 세기 — 세로선: x 열이 [a, b) 줄에서(두 줄마다) 양옆 R 칸보다 D 이상 어두운 비율(x±1 까지 — 살짝 기운 선)
    var vS = function (x, a, b) {
      var n = 0, hit = 0;
      for (var y = a; y < b; y += 2) {
        n++;
        for (var dx = -1; dx <= 1; dx++) {
          var c = y * W + x + dx, v = g[c];
          if (v + D <= g[c - R] && v + D <= g[c + R]) { hit++; break; }
        }
      }
      return n ? hit / n : 0;
    };
    var hS = function (y, a, b) {
      var n = 0, hit = 0;
      for (var x = a; x < b; x += 2) {
        n++;
        for (var dy = -1; dy <= 1; dy++) {
          var c = (y + dy) * W + x, v = g[c];
          if (v + D <= g[c - R * W] && v + D <= g[c + R * W]) { hit++; break; }
        }
      }
      return n ? hit / n : 0;
    };
    // 진한 글자가 있는가 — 두 선 사이 띠가 비었는지(칸 사이 빈틈) 볼 때
    var inked = function (x0, y0, x1, y1) {
      var n = 0, k = 0;
      for (var y = y0; y < y1; y += 2) for (var x = x0; x < x1; x += 2) { n++; if (g[y * W + x] < 150) k++; }
      return n ? k / n : 0;
    };
    var cx = function (v) { return Math.max(R + 2, Math.min(W - R - 3, Math.round(v))); };
    var cy = function (v) { return Math.max(R + 2, Math.min(H - R - 3, Math.round(v))); };
    // [from, to] 안에서 세기 TH 이상인 열(행)을 이어 붙여 선 목록 { a, b }(선 두께)
    var lines = function (from, to, s) {
      var out = [], cur = null;
      for (var p = from; p <= to; p++) {
        if (s(p) < TH) continue;
        if (cur && p - cur.b <= 2) cur.b = p; else { cur = { a: p, b: p }; out.push(cur); }
      }
      return out;
    };
    var my0 = cy(by0 + 0.15 * bh), my1 = cy(by1 - 0.15 * bh), mx0 = cx(bx0 + 0.15 * bw), mx1 = cx(bx1 - 0.15 * bw);
    var mw = 0.3 * bw, mh = 0.3 * bh;
    var Ls = lines(cx(bx0 - mw), cx(bx0 + mw), function (x) { return vS(x, my0, my1); });
    var Rs = lines(cx(bx1 - mw), cx(bx1 + mw), function (x) { return vS(x, my0, my1); });
    var Ts = lines(cy(by0 - mh), cy(by0 + mh), function (y) { return hS(y, mx0, mx1); });
    var Bs = lines(cy(by1 - mh), cy(by1 + mh), function (y) { return hS(y, mx0, mx1); });
    if (!Ls.length || !Rs.length || !Ts.length || !Bs.length) return null;
    var mid = function (l) { return (l.a + l.b) / 2; };
    /** 상자 변(edge)에 가장 가까운 선 → 안쪽(dir +1 = 값이 커지는 쪽)에 선이 또 있고 사이가 비었으면 안쪽 선으로. */
    var pick = function (list, edge, dir, blank) {
      var best = list.slice().sort(function (p, q) { return Math.abs(mid(p) - edge) - Math.abs(mid(q) - edge); })[0];
      for (var guard = 0; guard < 4; guard++) {
        var inner = list.filter(function (l) { return dir > 0 ? l.a > best.b : l.b < best.a; })
          .sort(function (p, q) { return dir > 0 ? p.a - q.a : q.b - p.b; })[0];
        if (!inner || !blank(best, inner)) break;
        best = inner;
      }
      return best;
    };
    var L = pick(Ls, bx0, 1, function (o, i) { return inked(o.b + 2, my0, i.a - 1, my1) < 0.002; });
    var Rr = pick(Rs, bx1, -1, function (o, i) { return inked(i.b + 2, my0, o.a - 1, my1) < 0.002; });
    var T = pick(Ts, by0, 1, function (o, i) { return inked(mx0, o.b + 2, mx1, i.a - 1) < 0.002; });
    var B = pick(Bs, by1, -1, function (o, i) { return inked(mx0, i.b + 2, mx1, o.a - 1) < 0.002; });
    var x0 = L.b + 1, x1 = Rr.a, y0 = T.b + 1, y1 = B.a;
    var w = x1 - x0, h = y1 - y0;
    if (w < 0.6 * bw || w > 1.6 * bw || h < 0.6 * bh || h > 1.6 * bh) return null;
    var ix = Math.min(x1, bx1) - Math.max(x0, bx0), iy = Math.min(y1, by1) - Math.max(y0, by0);
    if (ix <= 0 || iy <= 0 || ix * iy < 0.5 * bw * bh) return null;
    // 네 변이 정말 그 사각형을 두르는가 — 사각형 자기 길이(가운데 80%)로 다시 잰다(선 두께 안에서 가장 센 열·행)
    var ry0 = cy(y0 + 0.1 * h), ry1 = cy(y1 - 0.1 * h), rx0 = cx(x0 + 0.1 * w), rx1 = cx(x1 - 0.1 * w);
    var best = function (l, s) { var m = 0; for (var p = l.a; p <= l.b; p++) m = Math.max(m, s(p)); return m; };
    if (best(L, function (x) { return vS(x, ry0, ry1); }) < 0.7 || best(Rr, function (x) { return vS(x, ry0, ry1); }) < 0.7 ||
        best(T, function (y) { return hS(y, rx0, rx1); }) < 0.7 || best(B, function (y) { return hS(y, rx0, rx1); }) < 0.7) return null;
    return [x0, y0, x1, y1];
  }
  /** 장에서 영수증 한 건이 있는 자리만 오려 낸다. box = [ymin, xmin, ymax, xmax] (0~1000).
   *  칸 테두리가 그려진 장이면 테두리 안쪽에 맞추고(evSnap — 옆 영수증이 섞이지 않고 가장자리가 잘리지 않게), 아니면 상자에 작은 여유(1.2%,
   *  예전 2.5% — 촘촘한 장에서 옆 영수증까지 들어갔다)를 둔다. 돌려주는 것: { blob, url, rect: [x0, y0, x1, y1) px, snap } · 못 오리면 null. */
  function evCrop(pageUrl, box) {
    return evPage(pageUrl).then(function (G) {
      if (!G) return null;
      var W = G.W, H = G.H, pad = 0.012, s = null;
      try { s = evSnap(G, box[1] / 1000 * W, box[0] / 1000 * H, box[3] / 1000 * W, box[2] / 1000 * H); } catch (e) { s = null; }
      var x0, y0, x1, y1;
      if (s) { x0 = s[0]; y0 = s[1]; x1 = s[2]; y1 = s[3]; }
      else {
        x0 = Math.max(0, (box[1] / 1000 - pad) * W); y0 = Math.max(0, (box[0] / 1000 - pad) * H);
        x1 = Math.min(W, (box[3] / 1000 + pad) * W); y1 = Math.min(H, (box[2] / 1000 + pad) * H);
      }
      x0 = Math.round(x0); y0 = Math.round(y0);
      var w = Math.round(x1 - x0), h = Math.round(y1 - y0);
      if (w < 40 || h < 40) return null;
      return new Promise(function (ok) {
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
        cx.drawImage(G.img, x0, y0, w, h, 0, 0, w, h);
        cv.toBlob(function (b) { ok(b ? { blob: b, url: URL.createObjectURL(b), rect: [x0, y0, x0 + w, y0 + h], snap: !!s } : null); }, 'image/jpeg', 0.9);
      });
    });
  }
  /** Gemini 상자(box_2d [ymin, xmin, ymax, xmax], 0~1000)가 장 넓이의 절반 아래인가 — 영수증 하나뿐인 PDF 장을 오릴지(2026-10-23). 꼴이 이상하면 거짓. */
  function evSmallBox(b) {
    if (!b || b.length !== 4) return false;
    var y0 = Number(b[0]), x0 = Number(b[1]), y1 = Number(b[2]), x1 = Number(b[3]);
    if (![y0, x0, y1, x1].every(function (v) { return isFinite(v) && v >= 0 && v <= 1000; }) || y1 <= y0 || x1 <= x0) return false;
    return (y1 - y0) * (x1 - x0) <= 0.5 * 1000 * 1000;
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
          // 영수증이 하나뿐인 장도 오린다(2026-10-23) — PDF 한 쪽(A4)에 영수증 한 장이 작게 있으면(하이패스 「영수증 출력」 한 건 등)
          //   장 전체가 그 줄 사진이 됐다. PDF 에서 나온 장이고 상자가 장 넓이의 절반 아래일 때만 — 폰으로 찍은 영수증 한 장(장을 거의 채움)은
          //   예전처럼 그대로 올린다(원본을 따로 올리지 않는다). 오리면 원본 장은 scan_path 로 그대로 남는다(runEvUpload).
          var one = recs.length === 1 && !!pg.pdf && evSmallBox(recs[0].box_2d);
          return Promise.all(recs.map(function (x) {
            return ((many || one) && x.box_2d) ? evCrop(pg.url, x.box_2d) : Promise.resolve(null);
          })).then(function (crops) {
            if (EVUP !== session || pg.ai !== 'run') return;
            evRead();
            var rows = recs.map(function (x, k) {
              var it = evBlankItem(pi);
              it.ai = true; it.crop = crops[k];
              it.cat = KIND_CAT[x.kind] || EVUP.defCat || '';
              it.dh = ''; it.dhShot = false; it.dateBy = '';
              // 계기판 km — 줄에 담아 두고 계기판 칸에 보인다(저장하는 칸은 없다 — 서버 검증 A05 가 사진을 다시 읽어 운행일지 마지막 km 와 맞춰 본다)
              it.km = x.odometer_km != null && isFinite(Number(x.odometer_km)) ? Math.round(Number(x.odometer_km)) : null;
              var hint = [];
              if (x.merchant) { it.memo = String(x.merchant).slice(0, 60); }
              if (x.date) {
                var ms = Date.parse(x.date + 'T00:00:00+09:00');
                if (isFinite(ms) && ms >= EVUP.lo && ms < EVUP.hi) { it.date = x.date; it.dateBy = 'ai'; }
                else {
                  // ★ 기본 날짜(오늘)로 두면 8월 영수증이 10월분 정산에 그대로 들어간다. 비워서 사람이 정하게 한다.
                  it.date = '';
                  it.dh = '사진 날짜(' + String(x.date).replace(/-/g, '.') + ')가 ' + cycleName(CYC) + '(' + cycleSpan(CYC) +
                    ') 기간 밖이에요. 이 기간 영수증이 아니면 이 줄을 빼 주세요.';
                }
              } else if (!(it.cat === '계기판' && evShotDate(it))) {
                // 날짜를 못 읽음 — 계기판(늘 날짜가 없다)이면 위 조건에서 사진을 찍은 날로 넣었다. 영수증이나 찍은 날이 없는 장(PDF 쪽)만 비운다.
                it.date = ''; it.dh = '날짜를 읽지 못했어요. 직접 넣어 주세요.';
              }
              if (x.kind !== 'odometer') {
                if (x.amount != null) it.amt = String(x.amount);
                else it.amtMiss = true;              // 「금액을 읽지 못했습니다」 — 계기판으로 바꾸면 보이지 않는다(evHintOf)
              }
              if (x.legible === false) hint.push('글자가 흐려요. 직접 확인해 주세요.');
              // 영수증 자리를 받지 못했으면 장 전체를 따로 올리지 않고 원본 장을 이 줄의 사진으로 쓴다(올리기 — 2026-10-21). 그렇다고 알린다.
              if (many && !crops[k]) hint.push('영수증 자리를 찾지 못해 원본 장 전체가 이 줄의 사진이 돼요.');
              it.hint = hint.join(' ');
              return it;
            });
            // 0원으로 읽힌 영수증(하이패스 할인·면제 줄 등)은 올릴 것이 없다 — 저절로 뺀다(2026-10-15 사용자).
            //   계기판 사진은 금액이 없으니 그대로 둔다. 뺀 수는 알림으로 알린다.
            var zero = recs.filter(function (x) { return x.kind !== 'odometer' && x.amount != null && Number(x.amount) === 0; }).length;
            if (zero) {
              rows = rows.filter(function (it, k) { var x = recs[k]; return !(x.kind !== 'odometer' && x.amount != null && Number(x.amount) === 0); });
              toast('0원으로 읽힌 영수증 ' + n0(zero) + '건은 올릴 필요가 없어 목록에서 뺐어요.');
            }
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
          evNote('<span class="dim">AI가 읽지 못한 장이 있어요. 그 줄은 직접 넣어 주세요.</span>');
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
      // 날짜를 사람이 바꿨으면 기억한다 — 계기판으로 바꿀 때 사진을 찍은 날로 덮지 않게(2026-10-21)
      var d = g('[data-evdate]'); if (d != null) { if (d !== it.date) it.dateBy = 'user'; it.date = d; }
      // 금액 — 숫자·쉼표만(2026-10-20 AU2 #9). 못 읽는 글은 지우지 않고 그대로 두고(amtBad) 올리기에서 막는다.
      var a = g('[data-evamt]');
      if (a != null) { var na = numIn(a); it.amtBad = na !== null && isNaN(na); it.amt = it.amtBad ? String(a) : na === null ? '' : String(na); }
      var m = g('[data-evmemo]'); if (m != null) it.memo = m;
    });
  }

  /**
   * 영수증 올리기 창 — 통행료 줄의 날짜·금액이 그날 하이패스 이용내역으로 이미 증빙된 통행료와 같으면 알려 준다(웹 8차, 2026-10-17).
   * 막지는 않는다 — 올려도 같은 통행료의 두 번째 증빙으로 한 번만 센다(money-rule.js hpPair). 위 줄부터 하이패스 금액을 하나씩 쓴다.
   */
  function evHpNotes() {
    var rowsEl = document.querySelectorAll('#evList [data-evrow]');
    if (!rowsEl.length || !myName()) return;
    var MM = moneyOf(myName(), cycleRange(CYC))['통행료'], left = {};
    MM.days.forEach(function (d) {
      if (!d.hp || !d.hp.length) return;
      var a = d.hp.map(function (t) { return Math.round((d.ha && d.ha[t.id]) || d.amt[t.id] || 0); });   // 하이패스로 맞춘 금액(toll_hipass — 운행 금액을 고쳐도 남는다)
      (d.dup || []).forEach(function (e) { var i = a.indexOf(Math.round(Number(e.amount) || 0)); if (i >= 0) a.splice(i, 1); });   // 이미 짝지은 영수증 몫은 뺀다
      left[d.day] = a;
    });
    Array.prototype.forEach.call(rowsEl, function (tr) {
      var box = tr.querySelector('[data-evhp]'); if (!box) return;
      var g = function (sel) { var el = tr.querySelector(sel); return el ? el.value : ''; };
      var amt = Math.round(numIn(g('[data-evamt]')) || 0), day = g('[data-evdate]');     // 못 읽는 글(NaN)·빈칸은 0 — 안내만 안 뜬다
      var pool = g('[data-evcatsel]') === '통행료' && amt > 0 ? left[day] : null, i = pool ? pool.indexOf(amt) : -1;
      if (i >= 0) pool.splice(i, 1);
      box.hidden = i < 0;
      box.textContent = i < 0 ? '' : '이 날 통행료는 하이패스 이용내역으로 이미 증빙됐어요. 같은 통행료면 올리지 않아도 되고, 올려도 한 번만 계산해요.';
    });
  }

  /** 올리기 창 계기판 줄의 두 칸(2026-10-21 사용자 「계기판 사진 영수증 올리기는 금액·메모가 아니지 않나?」) — 금액 자리에 계기판 km(읽기만),
   *  메모 자리에 안내 + 날짜 안내. km 는 저장하는 칸이 없다 — 서버 검증(A05)이 사진을 다시 읽어 운행일지 마지막 km 와 맞춰 본다(저장은 금액 0 · 메모 없음).
   *  폰 카드에서는 칸 이름(data-l 「계기판 km」) 뒤에 값이 안 들어가면 아래 줄로 내려간다(flex-wrap — 표 칸일 때는 아무 일도 안 한다). */
  function evOdoCells(it, hintHtml) {
    return '<td class="n eva" data-l="계기판 km" data-evodo style="flex-wrap:wrap;row-gap:2px">' +
      (it.km != null ? '<b class="evkm" style="white-space:nowrap">' + n0(it.km) + ' km</b>'
        : '<span class="evkm dim" style="font-size:12px;line-height:1.5">읽지 못했어요. 검증 때 다시 읽어요.</span>') + '</td>' +
      '<td class="evm"><div class="evguide" style="font-size:13px;line-height:1.5;color:var(--ink-600)">검증 때 운행일지 마지막 km와 비교해요.</div>' +
      hintHtml + '</td>';
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
    // 계기판 줄은 금액·메모 대신 계기판 km·안내(2026-10-21 사용자) — 머리도 줄에 맞춘다(모두 계기판 · 섞임 · 없음)
    var nOdo = EVUP.items.filter(function (x) { return x.cat === '계기판'; }).length;
    var thA = !nOdo ? '금액' : nOdo === n ? '계기판 km' : '금액 · 계기판 km', thM = !nOdo ? '메모' : nOdo === n ? '안내' : '메모 · 안내';

    box.innerHTML = '<div class="panel"><div class="scroll" data-rows style="max-height:46vh">' +
      '<table class="evup"><thead><tr><th style="width:64px">사진</th><th>구분</th><th>날짜</th>' +
      '<th class="n">' + thA + '</th><th>' + thM + '</th><th></th></tr></thead><tbody>' +
      EVUP.items.map(function (it, i) {
        var pg = EVUP.pages[it.page] || {}, first = it.page !== prevPage;
        prevPage = it.page;
        var src = (it.crop && it.crop.url) || pg.url;
        var thumb = '<a href="' + src + '" target="_blank" rel="noopener" aria-label="' + (i + 1) + '번째 줄 사진 크게" title="사진 크게 — ' + esc(pg.name || '') + '">' +
          '<img src="' + src + '" alt=""></a>' +
          (perPage[it.page] > 1 ? '<span class="pgno" title="같은 장에서 나온 영수증">' + pageNo[it.page] + '장</span>' : '');
        if (pg.ai === 'run') {
          return '<tr data-evrow="' + i + '" class="evwait' + (first ? ' pgfirst' : '') + '"><td class="evth">' + thumb + '</td>' +
            '<td colspan="4" class="evg"><div class="gemread">' + gemSvg(16, 'spinning') + '<span><b class="gemtxt">AI</b>가 이 장에서 영수증을 읽는 중…</span>' +
            '<i class="gemshim"></i><i class="gemshim s2"></i></div></td>' +
            '<td class="n evx"><button class="btn sm" data-evskip="' + it.page + '">직접 입력</button></td></tr>';
        }
        // 사진 정보로 넣은 날짜 안내는 Gemini 딱지 없이(Gemini 가 한 일이 아니다) — 그것이 있으면 「가 채웠습니다」 줄은 내지 않는다(안내 줄이 셋이 되지 않게)
        var ht = evHintOf(it), shot = it.dhShot ? it.dh : '';
        var hintHtml = (shot ? '<div class="evhint" data-evshot>' + esc(shot) + '</div>' : '') +
          (ht ? '<div class="evhint">' + (it.ai ? gemTag('AI') + ' ' : '') + esc(ht) + '</div>'
            : (it.ai && !shot ? '<div class="evhint ok">' + gemTag('AI') + '가 채웠어요. 사진과 맞는지 확인해 주세요.</div>' : ''));
        return '<tr data-evrow="' + i + '" class="' + (first ? 'pgfirst' : '') + (it.ai ? ' evai' : '') + '">' +
          '<td class="evth">' + thumb + '</td>' +
          '<td class="evc"><select class="inp' + (it.cat ? '' : ' need') + '" data-evcatsel style="width:108px" aria-label="' + (i + 1) + '번째 구분">' +
          '<option value="">구분 고르기</option>' +
          EV_CATS.map(function (c) {
            return '<option value="' + c + '"' + (it.cat === c ? ' selected' : '') + '>' + c + '</option>';
          }).join('') + '</select></td>' +
          '<td class="evd"><input class="inp' + (it.date ? '' : ' need') + '" type="date" data-evdate style="width:148px" value="' + esc(it.date) +
          '" min="' + ymd(EVUP.lo) + '" max="' + ymd(EVUP.hi - 1) + '" aria-label="' + (i + 1) + '번째 날짜"></td>' +
          (it.cat === '계기판' ? evOdoCells(it, hintHtml)
            : '<td class="n eva" data-l="금액"><input class="inp num' + (it.amtBad ? ' need" aria-invalid="true" data-numbad="1' : '') + '" data-evamt inputmode="numeric" style="width:100px" ' +
              'placeholder="원" aria-label="' + (i + 1) + '번째 금액" value="' + esc(it.amtBad ? it.amt : it.amt ? n0(it.amt) : '') + '"></td>' +
              '<td class="evm"><input class="inp" data-evmemo maxlength="60" style="width:100%" placeholder="선택" value="' +
              esc(it.memo) + '" aria-label="' + (i + 1) + '번째 메모">' + hintHtml +
              '<div class="evhint hpdup" data-evhp hidden></div></td>') +
          '<td class="n evx" style="white-space:nowrap">' +
          '<button class="btn sm" data-evadd="' + i + '" title="이 장에 영수증이 더 있으면 줄을 늘려요" aria-label="같은 장에 줄 추가">＋</button> ' +
          '<button class="btn sm" data-evrm="' + i + '">빼기</button></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div style="padding:10px 14px;font-size:12px;color:var(--ink-3)">' +
      n0(EVUP.pages.filter(function (p, pi) { return perPage[pi]; }).length) + '장 · ' +
      (nOdo < n ? '영수증 ' + n0(n - nOdo) + '건' + (nOdo ? ' · ' : '') : '') + (nOdo ? '계기판 사진 ' + n0(nOdo) + '건' : '') +
      (running ? ' · <b class="gemtxt">AI가 ' + n0(running) + '장을 읽는 중</b>' : '') + '</div></div>';
    evHpNotes();
    if (b) {
      b.disabled = running > 0;
      // 읽는 동안은 Gemini 색으로 돌며 빛이 지나간다(검증 버튼과 같은 모양).
      b.classList.toggle('gembtn', running > 0); b.classList.toggle('running', running > 0);
      b.innerHTML = running ? gemSvg(16) + '<span class="gl">AI가 읽는 중…</span>' : esc(n0(n) + '건 올리기');
    }
    // 채울 빈 칸이 있을 때만 보인다.
    if (f) f.hidden = n < 2 || running > 0 || !EVUP.items.some(function (x, i) { return i && (!x.cat || (!x.date && !x.ai)); });
  }
  /* 구분을 바꾸면 그 줄을 다시 그린다(2026-10-21) — 계기판 ↔ 주유·주차·통행료는 칸이 다르다(계기판 km·안내 ↔ 금액·메모).
     칸 모양이 그대로인 바꿈(주차 ↔ 통행료)은 다시 그리지 않는다. 그리기 전에 쳐 둔 값을 담아(evRead) 계기판으로 갔다 돌아와도
     금액·메모가 남고, 표 스크롤과 그 구분 칸 초점을 지킨다. 계기판이 되면 날짜가 비었거나 아직 오늘(기본값) 그대로일 때만
     사진을 찍은 날로 넣는다(고른 날짜·Gemini 가 읽은 날짜는 그대로). 서버로 올리는 중에는 손대지 않는다. */
  document.addEventListener('change', function (e) {
    var s = e.target;
    if (!s || !s.matches || !s.matches('#evList [data-evcatsel]') || EV_SENDING) return;
    var tr = s.closest('[data-evrow]'), odo = s.value === '계기판';
    if (!tr || odo === !!tr.querySelector('[data-evodo]')) return;
    var i = +tr.dataset.evrow;
    evRead();
    var it = EVUP.items[i];
    if (it && odo && (!it.date || (it.dateBy === 'today' && it.date === ymd(Date.now())))) evShotDate(it);
    var sc = document.querySelector('#evList [data-rows]'), top = sc ? sc.scrollTop : 0;
    paintEvList();
    sc = document.querySelector('#evList [data-rows]'); if (sc) sc.scrollTop = top;
    var ns = document.querySelector('#evList [data-evrow="' + i + '"] [data-evcatsel]');
    if (ns) { try { ns.focus({ preventScroll: true }); } catch (er) { ns.focus(); } }
  });

  function runEvUpload() {
    if (EVUP.busy) { toast('아직 파일을 읽는 중이에요. 잠시만 기다려 주세요.'); return; }
    if (EVUP.pages.some(function (p) { return p.ai === 'run'; })) { toast('AI가 아직 읽는 중이에요. 기다리거나 ‘직접 입력’을 눌러 주세요.'); return; }
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
        bad(' 날짜가 ' + cycleName(CYC) + '(' + cycleSpan(CYC) + ') 기간 밖이에요.', '[data-evdate]'); return;
      }
      it.ms = ms;
      // 계기판 사진은 금액 칸이 없다(2026-10-21) — 금액을 보지 않고 0 으로 올린다(계기판으로 바꾸기 전에 쳐 둔 금액·메모는 올리지 않는다)
      if (it.cat === '계기판') { it.amtN = 0; continue; }
      if (it.amtBad) { bad(' 금액에는 ' + NUM_BAD + '.', '[data-evamt]'); return; }
      var amt = Number(it.amt || 0);
      if (!isFinite(amt) || amt < 0 || amt > 5000000) { bad('의 금액이 범위를 벗어났어요.', '[data-evamt]'); return; }
      if (!amt) { bad('의 금액을 넣어 주세요. 계기판 사진만 0원으로 올릴 수 있어요.', '[data-evamt]'); return; }
      it.amtN = Math.round(amt);
    }

    EVUP.busy = true; EV_SENDING = true;
    var btn = $('btnEvGo'); if (btn) { btn.disabled = true; btn.textContent = '올리는 중…'; }
    var total = EVUP.items.length, done = 0;
    var base = Date.now();
    // 한 장에 영수증이 둘 이상이면 그 장(A4 원본)을 따로 한 번 올리고, 줄마다 scan_path 로 가리킨다.
    // 결재 문서에는 원본 한 장이 통째로 실린다.
    //   영수증 하나뿐인 PDF 장을 오렸으면(2026-10-23 evScanPages) 그 장도 — 오린 그림이 photo_path, 원본 장은 scan_path 로 그대로.
    var perPage = {}, cropped = {};
    EVUP.items.forEach(function (x) { perPage[x.page] = (perPage[x.page] || 0) + 1; if (x.crop && x.crop.blob) cropped[x.page] = 1; });
    EVUP.pages.forEach(function (p, pi) { if (perPage[pi] > 1 || cropped[pi]) p.multi = true; });
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
        // ★ 한 장에 여러 영수증인데 이 줄은 오린 그림이 없다(Gemini 가 자리를 안 줌·직접 더한 줄) — 예전엔 장 전체를 이 줄 사진으로
        //   또 올려, 12줄이 모두 같은 장 그림이었다(2026-10-21 직원 10월분 사례). 이제는 따로 올리지 않고 원본 장(scan_path)을 이 줄 사진으로
        //   가리킨다(photo_path = scan_path — 목록에 「원본」만 보이고, 지울 때는 원본을 다른 줄이 안 쓸 때만 지운다).
        var useScan = !!pg.multi && !(it.crop && it.crop.blob);
        var scanP = Promise.resolve();
        if (pg.multi && !pg.scanPath) {
          var sp = mine + '/scan/' + key + '.jpg';
          scanP = upload(sp, pg.blob, (i + 1) + '번째 원본').then(function () { pg.scanPath = sp; });
        }
        return scanP.then(function () {
          if (useScan) { path = pg.scanPath; return; }
          return upload(path, (it.crop && it.crop.blob) || pg.blob, (i + 1) + '번째 파일');
        }).then(function () {
          return apiRetry('/rest/v1/evidences', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              username: mine, client_key: key, vehicle_plate: car,
              date_millis: it.ms, category: it.cat, amount: it.amtN,
              // ★ captured_at 을 0 으로 두면 앱의 사진 정리(cleanupEvidenceServer,
              //   captured_at < cutoff)가 웹에서 올린 사진을 다음 동기화에 바로 지운다.
              memo: it.cat === '계기판' ? '' : it.memo, captured_at: Date.now(), photo_path: path,
              scan_path: pg.multi ? pg.scanPath : null
            })
          }).then(function (ins) {
            if (!ins.ok) return ins.text().then(function (t) {
              // 파일만 올라간 채로 두지 않는다(다시 누르면 새 키로 또 올라가 파일이 둘이 된다).
              //   원본 장을 가리킨 줄(useScan)은 지우지 않는다 — 같은 장의 다른 줄이 그 원본을 쓴다.
              return (useScan ? Promise.resolve() : apiRetry('/storage/v1/object/evidence/' + path, { method: 'DELETE' }))
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
      toastOk('영수증 ' + n0(done) + '건을 올렸어요.');
      AUDIT = null; loadAll();
    }).catch(function (e) {
      EVUP.busy = false; EV_SENDING = false;
      if (btn) { btn.disabled = false; }
      // 이미 올라간 것은 목록에서 빼고 화면에도 바로 반영한다 — 안 그러면 '안 올라갔나'
      // 하고 다시 올려 겹친다.
      EVUP.items.splice(0, done);
      paintEvList();
      if (done) { AUDIT = null; loadAll(); }
      var failTxt = done ? done + '건까지 올렸고 ' + (total - done) + '건이 남았어요. ' + evWhy(e) : '올리지 못했어요. ' + evWhy(e);
      evNote('<b style="color:var(--red)">' + esc(failTxt) + '</b>');
      // 폰에서는 안내 줄이 창 아래쪽(화면 밖)에 있어 실패를 몰랐다(2026-10-20 AU6-M6) — 토스트로도 알리고 그 줄로 굴린다
      toast(failTxt, true);
      var en = $('evNote'); if (en) { try { en.scrollIntoView({ block: 'center' }); } catch (er) { } }
    });
  }

  /** 서버 원문 대신 사람이 할 수 있는 말로. 원문은 콘솔에 남긴다. */
  function evWhy(e) {
    var m = String((e && e.message) || '');
    console.error('증빙 올리기 실패:', m);
    if (/413|too large/i.test(m)) return '파일이 너무 커요. 사진을 줄여서 다시 올려 주세요.';
    // 403 은 로그인 만료가 아니라 권한·잠금 판정이다(2026-10-20 AU2 #17) — 결재가 올라간 기간이거나 권한이 없다
    if (/CYCLE_LOCKED|row-level security|403|permission/i.test(m) && !/401|jwt/i.test(m)) return '올릴 권한이 없거나 결재가 올라간 기간이에요. 기간을 확인해 주세요.';
    if (/401|jwt|로그인/i.test(m)) return '로그인이 만료됐어요. 다시 로그인한 뒤 올려 주세요.';
    if (/409|duplicate/i.test(m)) return '같은 파일이 이미 올라가 있어요. 목록을 다시 확인해 주세요.';
    return '잠시 후 ‘올리기’를 다시 눌러 주세요.';
  }

  function evDelete(id) {
    var e = EVID.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!e) return;
    $('pTitle').textContent = '영수증 지우기';
    $('pSub').textContent = md(e.date_millis) + ' · ' + (e.category || '') +
      (e.amount ? ' · ' + won(e.amount) : '');
    // 주차·통행료 영수증이면 그 금액이 운행에 들어가 있는지 먼저 본다(2026-10-20 AU2 ①) — 보는 동안 「지우기」를 잠깐 막는다
    var money = e.category === '주차' || e.category === '통행료';
    $('pBody').innerHTML = '<div class="anote">이 영수증을 지울까요? 지우면 되돌릴 수 없어요.</div>' +
      (money ? '<div id="evUndo" class="undowait dim">이 영수증 금액이 들어간 운행이 있는지 보는 중…</div>' : '') +
      (e.photo_path ? '<div class="form"><div class="frow"><div class="fbody">' +
        '<img src="' + esc(SB + '/storage/v1/object/public/evidence/' + e.photo_path) + '" ' +
        'style="max-width:100%;border-radius:var(--r-sm);border:1px solid var(--line)" alt=""></div></div></div>' : '');
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnEvDelGo" data-id="' + esc(e.id) + '"' + (money ? ' disabled' : '') + '>지우기</button>';
    $('panel').classList.add('open');
    var tok = EVUNDO = { id: String(e.id), plan: [] };
    if (!money) return;
    fillUndoPlan([{ e: e, to: null }]).then(function (plan) {
      if (EVUNDO !== tok) return;
      tok.plan = plan;
      var box = $('evUndo'); if (box) box.outerHTML = undoBlock(plan, true);
      var b = $('btnEvDelGo'); if (b && b.dataset.id === String(e.id)) b.disabled = false;
    });
  }

  /** 지운 영수증 id — 여러 장을 한 번에 지울 때 아직 다시 받지 않은 목록(ALL_EVID)에 남은 줄을 「남은 줄」로 세지 않게. */
  var EV_GONE = {};
  /** 영수증 한 장 지우기 — 한 건 지우기·여러 장 지우기가 같은 길(기록 → A4 원본 → 사진). 결과: 사진·원본 파일까지 지웠는가(true/false). */
  function evDelOne(e) {
    // 기록을 먼저 지운다. 파일만 남는 것이 기록만 남는 것보다 덜 위험하다.
    // 지운 줄을 돌려받아 실제로 지워졌는지 본다 — 서버 규칙이 막으면 0줄이 지워져도 200 이 와서
    // "지웠습니다"라고 거짓으로 말했다(2026-10-06 검증로봇 2: 다른 탭에서 상신한 직후 등).
    return apiRetry('/rest/v1/evidences?id=eq.' + encodeURIComponent(e.id),
      { method: 'DELETE', headers: { Prefer: 'return=representation' } })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.status); });
        return r.json().then(function (rows) {
          if (!Array.isArray(rows) || !rows.length) {
            throw new Error('지워지지 않았어요. 이 기간이 상신됐거나 권한이 없을 수 있으니, 새로고침한 뒤 다시 확인해 주세요.');
          }
        });
      })
      .then(function () {
        EV_GONE[String(e.id)] = 1;
        // A4 스캔 원본은 여러 영수증이 함께 가리킨다. 이 줄이 마지막이었으면 원본도 지운다 —
        // 안 그러면 잘못 올린 A4 한 장이 화면에서 지울 길 없이 남는다(버킷이 공개라 주소로 열린다).
        //   여러 장을 한 번에 지울 때는 방금 지운 줄(EV_GONE)을 남은 줄로 세지 않는다 — 같은 A4 의 영수증을 다 지워도 원본이 남던 것.
        var scanLeft = e.scan_path && ALL_EVID.some(function (x) {
          return x.scan_path === e.scan_path && String(x.id) !== String(e.id) && !EV_GONE[String(x.id)];
        });
        var scanP = (e.scan_path && !scanLeft)
          ? apiRetry('/storage/v1/object/evidence/' + e.scan_path, { method: 'DELETE' })
            .then(function (r3) { return r3.ok; }, function () { return false; })
          : Promise.resolve(true);
        if (!e.photo_path) return scanP;
        // 원본 장을 이 줄 사진으로 쓴 줄(영수증 자리를 못 받음 — 2026-10-21)은 사진 = 원본이다. 원본은 위에서(남은 줄이 없을 때만) 지운다.
        if (e.photo_path === e.scan_path) return scanP;
        // 앱이 올린 파일은 anon 경로라 웹 권한으로 못 지울 수 있다. 결과를 보고 말한다.
        return apiRetry('/storage/v1/object/evidence/' + e.photo_path, { method: 'DELETE' })
          .then(function (r2) { return r2.ok; }, function () { return false; })
          .then(function (ok1) { return scanP.then(function (ok2) { return ok1 && ok2; }); });
      });
  }
  function evDelWhy(err) {
    var m = err && String(err.message || '');
    return m.indexOf('지워지지 않았어요') === 0 ? m : '지우지 못했어요. 잠시 후 다시 해 주세요.';
  }
  function runEvDelete(id) {
    var e = EVID.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!e) return;
    // 켜 둔 「운행에 넣은 금액 되돌리기」 — 창이 닫히기 전에 읽는다(2026-10-20 AU2 ①)
    var picked = EVUNDO && EVUNDO.id === String(id) ? undoPicked(EVUNDO.plan) : [];
    var btn = $('btnEvDelGo'); if (btn) { btn.disabled = true; btn.textContent = '지우는 중…'; }
    evDelOne(e)
      .then(function (fileGone) {
        return (picked.length ? applyUndo(picked) : Promise.resolve(null)).then(function (u) {
          closePanel(); AUDIT = null; TRIP_CACHE = {}; loadAll();
          var m = '지웠어요.' + undoSay(u);
          if (u && u.fail) toast(m + (fileGone ? '' : ' 기록은 지웠지만 사진 파일은 남았어요.'), true);
          else toastOk(m, fileGone ? null : '기록은 지웠지만 사진 파일은 남았어요.');
        });
      })
      .catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = '지우기'; }
        toast(evDelWhy(err), true);
      });
  }

  /* ══════════════════ 여러 줄 골라 지우기(2026-10-19 사용자 「하나씩 지워야 하는데 너무 힘드네. 선택 항목을 넣으면」) ══════════════════
     내역 표 공통 — 운행일지 영수증·통행료(2단계)·관리 영수증 · 개인경비 내역 · 법인카드 내역(drv-expense·drv-card 가 C.msel* 로 같이 쓴다).
       · 줄 첫 칸 안에 고르기 칸 · 표 머리(폰에서 머리가 숨는 표는 표 위 한 줄)에 「보이는 줄 모두 고르기」
       · 고르면 표 아래 띠 「선택 N건 · ₩합계 [선택 지우기] [선택 풀기]」 — 화면 아래에 붙어 따라온다(긴 표를 다시 내리지 않게)
       · 확인 창 하나(지울 목록 날짜·구분·금액) → 한 건 지우기와 같은 길로 하나씩(「지우는 중… 3/7」) → 끝나면 알림 하나(실패가 섞이면 몇 건·왜)
       · 지울 수 없는 줄(잠긴 기간·다른 분 것)은 고르기 칸을 막고 까닭을 칸 풀이(title·화면 읽기)로
     고른 것은 화면을 다시 그려도 남고, 보이지 않게 된 줄(거르기·지워짐)은 고른 것에서 빠진다. */
  var MSEL = {};
  function mselG(grp) { return MSEL[grp] || (MSEL[grp] = { ids: {}, meta: {}, def: null, busy: false }); }
  /** def: { noun:'영수증', note:'사진도 함께 지워집니다.', del:function(id)→Promise(false = 파일은 남음), why:function(err)→문구, done:function(nOk) } */
  function mselDef(grp, def) { mselG(grp).def = def; }
  /** 표 머리 첫 칸 안에 넣는 「모두 고르기」. */
  function mselAll(grp) {
    return '<label class="mselhit" title="보이는 줄 모두 고르기"><input type="checkbox" data-mselall="' + esc(grp) + '" aria-label="보이는 줄 모두 고르기"></label>';
  }
  /** 표 위 한 줄 「보이는 줄 모두 고르기」 — 폰에서 표 머리가 숨는 표(개인경비·법인카드)만. cls = 그 표 이름(CSS 가 폭에 따라 보임). */
  function mselAllLine(grp, cls) {
    return '<div class="mselallm ' + esc(cls || '') + '"><label class="mselhit wide"><input type="checkbox" data-mselall="' + esc(grp) + '">' +
      '<span>보이는 줄 모두 고르기</span></label></div>';
  }
  /** 줄 첫 칸 안에 넣는 고르기 칸. o: { id, amt, line:'09.30 통행료 1,000원', why:'못 고르는 까닭'(있으면 막음) } */
  function mselBox(grp, o) {
    var on = !o.why && !!mselG(grp).ids[o.id];
    return '<label class="mselhit"' + (o.why ? ' title="' + esc(o.why) + '"' : '') + '><input type="checkbox" data-msel="' + esc(grp) + '" value="' + esc(o.id) + '"' +
      ' data-amt="' + (Number(o.amt) || 0) + '" data-line="' + esc(o.line) + '"' + (on ? ' checked' : '') +
      (o.why ? ' disabled aria-label="' + esc(o.line + ' — ' + o.why) + '"' : ' aria-label="' + esc(o.line + ' 고르기') + '"') + '></label>';
  }
  /** 표 아래 띠 자리(고르면 보인다). */
  function mselBar(grp) {
    return '<div class="mselbar" data-mselbar="' + esc(grp) + '" role="region" aria-label="고른 줄" hidden>' +
      '<span class="mselt" aria-live="polite"></span><span class="sp"></span>' +
      '<button type="button" class="btn sm pri" data-mseldel="' + esc(grp) + '">선택 지우기</button>' +
      '<button type="button" class="btn sm" data-mselclear="' + esc(grp) + '">선택 풀기</button></div>';   // [동작] [취소] 차례(2026-10-21 사용자 「바꾸기」 — 창 아래 단추와 같게)
  }
  function mselBoxes(grp) { return Array.prototype.slice.call(document.querySelectorAll('input[data-msel="' + grp + '"]')); }
  /** 고른 상태를 화면에 맞춘다 — 칸 체크 · 모두 고르기(일부면 반쯤) · 띠 · 고른 줄 색. 그린 뒤(afterPaint)와 고를 때마다. */
  function mselSync() {
    Object.keys(MSEL).forEach(function (grp) {
      var g = MSEL[grp], live = {}, n = 0, sum = 0, nOk = 0;
      mselBoxes(grp).forEach(function (b) {
        if (b.disabled) return;
        nOk++; live[b.value] = b;
        b.checked = !!g.ids[b.value];
        var tr = b.closest('tr'); if (tr) tr.classList.toggle('msel-on', b.checked);
        if (b.checked) g.meta[b.value] = { line: b.dataset.line, amt: Number(b.dataset.amt) || 0 };
      });
      // 표가 아직 없으면(다시 받는 중 · 다른 화면) 고른 것을 버리지 않는다 — 다시 그려진 표에서 그대로 이어진다
      var any = mselBoxes(grp).length > 0;
      if (!g.busy && any) Object.keys(g.ids).forEach(function (id) { if (!live[id]) delete g.ids[id]; });
      Object.keys(g.ids).forEach(function (id) { n++; sum += (g.meta[id] || {}).amt || 0; });
      Array.prototype.forEach.call(document.querySelectorAll('input[data-mselall="' + grp + '"]'), function (a) {
        a.disabled = !nOk; a.checked = nOk > 0 && n === nOk; a.indeterminate = n > 0 && n < nOk;
        var lab = a.closest('label'); if (lab) lab.title = nOk ? '보이는 줄 모두 고르기' : '고를 수 있는 줄이 없어요';
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-mselbar="' + grp + '"]'), function (bar) {
        bar.hidden = !n;
        var t = bar.querySelector('.mselt');
        if (t) t.innerHTML = '선택 <b>' + n0(n) + '건</b> · ' + won(sum);
      });
    });
  }
  document.addEventListener('change', function (e) {
    var b = e.target;
    if (!b || !b.matches) return;
    if (b.matches('input[data-msel]')) {
      var g = mselG(b.dataset.msel);
      if (b.checked) g.ids[b.value] = 1; else delete g.ids[b.value];
      mselSync();
    } else if (b.matches('input[data-mselall]')) {
      var grp = b.dataset.mselall, g2 = mselG(grp), on = b.checked;
      mselBoxes(grp).forEach(function (x) { if (!x.disabled) { if (on) g2.ids[x.value] = 1; else delete g2.ids[x.value]; } });
      mselSync();
    }
  });
  // 차례 카드 「○○ 영수증 N건 보기·지우기 ↓」 — 아래 「내역」 표로
  document.addEventListener('click', function (e) {
    var j = e.target.closest && e.target.closest('[data-evjump]');
    if (!j) return;
    var to = $('belowF'); if (!to) return;
    var sec = to.closest('section') || to;
    try { sec.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); } catch (er) { sec.scrollIntoView(); }
    var f = to.querySelector('input[data-msel]:not(:disabled),[data-evdel]'); if (f) setTimeout(function () { try { f.focus({ preventScroll: true }); } catch (er) { } }, 350);
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-mselclear],[data-mseldel],#btnMselGo');
    if (!t) return;
    if (t.id === 'btnMselGo') { mselRun(t.dataset.grp); return; }
    if (t.hasAttribute('data-mselclear')) { mselG(t.dataset.mselclear).ids = {}; mselSync(); return; }
    mselAsk(t.dataset.mseldel);
  });
  /** 확인 창 — 지울 목록(날짜·구분·금액)과 합계. */
  function mselAsk(grp) {
    var g = mselG(grp), def = g.def, ids = Object.keys(g.ids);
    if (!def || !ids.length || g.busy) return;
    var sum = ids.reduce(function (s, id) { return s + ((g.meta[id] || {}).amt || 0); }, 0);
    openPanel(def.noun + ' ' + n0(ids.length) + '건 지우기', '합계 ' + won(sum),
      '<div class="anote" style="margin-top:0">고른 ' + n0(ids.length) + '건을 지울까요? 지우면 되돌릴 수 없어요.' + (def.note ? ' ' + esc(def.note) : '') + '</div>' +
      '<ul class="mselist">' + ids.map(function (id) { return '<li data-mselid="' + esc(id) + '">' + esc((g.meta[id] || {}).line || id) + '</li>'; }).join('') + '</ul>' +
      (def.undoPlan ? '<div id="mselUndo" class="undowait dim">고른 영수증 금액이 들어간 운행이 있는지 보는 중…</div>' : '') +
      '<div class="mselprog" aria-live="polite"></div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnMselGo" data-grp="' + esc(grp) + '"' + (def.undoPlan ? ' disabled' : '') + '>' + n0(ids.length) + '건 지우기</button>');
    // 운행일지 영수증 — 그 금액이 운행에 들어가 있으면 함께 되돌릴지 묻는다(2026-10-20 AU2 ①). 보는 동안 지우기 단추를 잠깐 막는다.
    g.undo = null;
    if (def.undoPlan) {
      var tok = g.undo = { plan: [] };
      def.undoPlan(ids).then(function (plan) {
        if (g.undo !== tok) return;
        tok.plan = plan || [];
        var box = $('mselUndo'); if (box) box.outerHTML = undoBlock(tok.plan, true);
        var b = $('btnMselGo'); if (b && b.dataset.grp === grp && !g.busy) b.disabled = false;
      }, function () { var b = $('btnMselGo'); if (b) b.disabled = false; var box = $('mselUndo'); if (box) box.remove(); });
    }
  }
  /** 하나씩 차례로 지운다(한 건 지우기와 같은 길 — def.del). 실패한 것은 고른 채로 남긴다. */
  function mselRun(grp) {
    var g = mselG(grp), def = g.def, ids = Object.keys(g.ids);
    if (!def || !ids.length || g.busy) return;
    // 켜 둔 「운행에 넣은 금액 되돌리기」(2026-10-20 AU2 ①) — 창이 닫히기 전에 읽는다. 지운 영수증의 것만 되돌린다.
    var picked = def.undoPlan && g.undo ? undoPicked(g.undo.plan) : [], gone = {};
    g.busy = true;
    var btn = $('btnMselGo'), cl = document.querySelector('#pFoot [data-close]'), prog = document.querySelector('.mselprog');
    if (btn) btn.disabled = true;
    if (cl) cl.disabled = true;
    var ok = 0, warn = 0, bad = [], i = 0;
    var mark = function (id, cls) { var li = document.querySelector('.mselist li[data-mselid="' + id + '"]'); if (li) li.className = cls; };
    (function next() {
      if (i >= ids.length) return finish();
      var id = ids[i++];
      if (btn) btn.textContent = '지우는 중… ' + i + '/' + ids.length;
      if (prog) prog.textContent = ids.length + '건 중 ' + i + '번째를 지우는 중…';
      mark(id, 'now');
      Promise.resolve().then(function () { return def.del(id); })
        .then(function (r) { ok++; if (r === false) warn++; delete g.ids[id]; gone[String(id)] = 1; mark(id, 'done'); },
          function (err) { bad.push({ id: id, why: def.why ? def.why(err) : String((err && err.message) || err) }); mark(id, 'bad'); })
        .then(next);
    })();
    function finish() {
      // 지운 영수증이 넣은 운행 금액만 되돌린다 — 못 지운 영수증의 것은 그대로(그 영수증이 아직 근거다)
      var undo = picked.filter(function (p) { return p.ev.some(function (x) { return gone[String(x)]; }); });
      (undo.length ? applyUndo(undo) : Promise.resolve(null)).then(function (u) {
        g.busy = false;
        closePanel();
        var msg = !bad.length ? n0(ok) + '건을 지웠어요.'
          : n0(ids.length) + '건 중 ' + n0(ok) + '건을 지웠고, ' + n0(bad.length) + '건(' +
            bad.slice(0, 3).map(function (x) { return (g.meta[x.id] || {}).line || x.id; }).join(', ') + (bad.length > 3 ? ' 외' : '') +
            ')은 지우지 못했어요. ' + String(bad[0].why).replace(/[.\s]+$/, '') + '. 못 지운 줄은 고른 채로 남겨 두었어요.';
        if (!bad.length && warn) msg += ' 사진 파일 ' + n0(warn) + '개는 남았어요.';
        toast(msg + undoSay(u), !!bad.length || !!(u && u.fail));
        if (u && u.ok) TRIP_CACHE = {};
        if (def.done) def.done(ok); else render();
      });
    }
  }
  mselDef('ev', {
    noun: '영수증', note: '사진도 함께 지워져요.',
    // 그 영수증 금액이 운행에 들어가 있으면 확인 창에서 함께 되돌린다(2026-10-20 AU2 ①)
    undoPlan: function (ids) {
      var moves = ids.map(function (id) { var e = EVID.filter(function (x) { return String(x.id) === String(id); })[0]; return e ? { e: e, to: null } : null; })
        .filter(function (m) { return m && (m.e.category === '주차' || m.e.category === '통행료'); });
      return fillUndoPlan(moves);
    },
    del: function (id) {
      var e = EVID.filter(function (x) { return String(x.id) === String(id); })[0];
      if (!e) return Promise.reject(new Error('이미 없는 줄이에요'));
      return evDelOne(e);
    },
    // 여러 건 알림은 줄 이름이 이미 길다 — 까닭만 짧게
    why: function (err) {
      return String((err && err.message) || '').indexOf('지워지지 않았어요') === 0 ? '이 기간이 상신됐거나 권한이 없을 수 있어요' : '잠시 후 다시 해 주세요';
    },
    done: function () { AUDIT = null; loadAll(); }
  });

  /* ══════════════════ 결재 완료 출력 — 고르기 · 팀 고르기 · 이름으로 찾기(세 화면 공통, 2026-10-23) ══════════════════
     관리자 「아래쪽 하나를 고르면 위로 올라간다 — 고른 자리 그대로」 · 「팀별로 뽑을 수 있게」 · 「이름으로 검색」.
     예전엔 칸 하나를 고를 때마다 화면 전체를 다시 그렸다(C.render → #inner innerHTML 통째 교체). 줄이 22개를 넘는 표는
     자기 스크롤 상자(.scroll.tall)라 새로 만든 상자가 맨 위(scrollTop 0)에서 시작했고, 누른 칸도 새로 만들어져 초점이 body 로 갔다.
     이제 고르기·찾기는 다시 그리지 않고 그 자리에서 고르기 칸 · 팀 칸 · 전체 선택 · 묶기 단추 · 찾은 수만 맞춘다(finSync).
       표 table[data-fin="driving|expense|card"] · 줄 tr[data-frow](finRow) · 고르기 칸 input[data-fid](finBox)
       팀 머리 줄 orgGroupRow(…, finGrp) — 그 팀의 보이는 줄 모두 고르기·풀기, 일부만 골랐으면 반쯤(indeterminate)
       전체 선택 input[data-finall] · 묶기 단추 [data-finbtn] · 찾기 칸 input[data-finq] · 지우기 [data-finqx](Esc 도)
     「보이는 줄」 = 표에 있는 줄(「출력 안 한 것만」으로 거른 뒤) 중 찾기에 맞는 줄. 고른 수 · 전체 선택 · 팀 고르기 · 묶어 받기는 이것만 센다 —
     숨은 줄은 고른 채 남아도 묶음에 몰래 들어가지 않는다(「출력 안 한 것만」과 같은 원칙). 고른 것 자체는 모듈이 가진다(finReg 의 sel).
     찾는 말은 화면을 옮기거나 기간을 바꾸면 비운다(notifyGo · setPeriod). */
  var FINK = {}, FINQ = {};
  /** def: { sel: function () → 고른 것 { 결재번호: 1 }, busy: function () → 묶는 중인가 } */
  function finReg(kind, def) { FINK[kind] = def; }
  /** 찾는 이름들 — 띄어 쓰거나 쉼표로 여러 명(그중 하나라도 이름에 들어 있으면 보인다). */
  function finWords(kind) { return String(FINQ[kind] || '').toLowerCase().split(/[\s,]+/).filter(Boolean); }
  function finHit(words, name) {
    var n = String(name || '').toLowerCase().replace(/\s+/g, '');
    return !words.length || words.some(function (w) { return n.indexOf(w) >= 0; });
  }
  /** 그 사람이 찾기에 맞는가 — 묶어 받기·고른 수가 화면과 같은 판정을 쓴다. */
  function finMatch(kind, u) { return finHit(finWords(kind), nameOf(u)); }
  /** 줄(tr)에 붙일 것 — 팀 열쇠(orgGroups 와 같은 사업부|팀) · 이름 · 금액(찾는 중 팀 합계) */
  function finRow(kind, id, u, amt) {
    var p = orgPath(u);
    return ' data-frow="' + esc(id) + '" data-fgk="' + esc(p.div + '|' + p.team) + '" data-fname="' + esc(nameOf(u)) + '" data-famt="' + (Number(amt) || 0) + '"';
  }
  /** 고르기 칸(input)에 붙일 것. data-fk — 화면을 다시 그려도 초점이 그 칸으로 돌아온다(keepRestore). */
  function finBox(kind, id) { return ' data-fid="' + esc(id) + '" data-fk="fin:' + esc(kind) + ':' + esc(id) + '"'; }
  function finAllAttr(kind) { return ' data-finall="' + esc(kind) + '" data-fk="finall:' + esc(kind) + '"'; }
  /** 팀 묶음 머리 줄 맨 앞 「이 팀 모두 고르기」 칸 */
  function finGrp(kind, g) {
    var nm = orgName(g.p);
    return '<label class="mselhit fgrp" title="' + esc(nm) + ' 모두 고르기"><input type="checkbox" data-fingrp="' + esc(kind) + '" data-gk="' + esc(g.k) + '"' +
      ' data-fk="fing:' + esc(kind) + ':' + esc(g.k) + '" aria-label="' + esc(nm) + ' 모두 고르기"></label>';
  }
  /** 표 위 찾기 칸 */
  function finBar(kind) {
    var q = FINQ[kind] || '';
    return '<div class="finbar"><label class="field finq">' + ic('search', 15) +
      '<input data-finq="' + esc(kind) + '" data-fk="finq:' + esc(kind) + '" autocomplete="off" spellcheck="false" enterkeyhint="search" placeholder="이름으로 찾기"' +
      ' value="' + esc(q) + '" title="이름 일부만 써도 돼요. 여러 명은 띄어 쓰고, Esc로 지워요." aria-label="이름으로 찾기 — 여러 명은 띄어서">' +
      '<button type="button" class="permx finqx" data-finqx="' + esc(kind) + '" aria-label="찾기 지우기"' + (q ? '' : ' hidden') + '>' + ic('close', 12) + '</button></label>' +
      '<span class="finqn" data-finqn="' + esc(kind) + '" aria-live="polite"></span></div>';
  }
  /** 찾는 이름이 없을 때 표 안 한 줄(finSync 가 보인다) */
  function finNone(cols) {
    return '<tr class="finnone" hidden><td colspan="' + cols + '"><div class="blank" style="padding:22px 0"><div class="t">찾는 이름이 없어요.</div>' +
      '<div class="d">이름 일부만 써도 돼요. 여러 명은 띄어 쓰세요.</div></div></td></tr>';
  }
  /** 묶음 차례 = 표에 보이는 차례(팀 → 파트·센터 → 이름). team = 고른 사람이 모두 한 팀이면 그 팀 이름(파일 이름), 아니면 ''. */
  function finOrder(list, getU) {
    var by = list.slice().sort(function (x, y) { return nameOf(getU(x)).localeCompare(nameOf(getU(y)), 'ko'); });
    var gs = orgGroups(by, getU, true);
    return { list: [].concat.apply([], gs.map(function (g) { return g.list; })), team: gs.length === 1 ? orgName(gs[0].p) : '' };
  }
  /** 파일 이름에 넣을 팀 이름(파일 이름에 못 쓰는 글자·띄어쓰기 뺌 — 금액 요약표의 보는 범위와 같게) */
  function finFileTag(team) { var s = String(team || '').replace(/[\\/:*?"<>|\s]+/g, ''); return s ? '_' + s : ''; }
  /** 고른 상태·찾기를 화면에 맞춘다 — 다시 그리지 않는다. 그린 뒤(afterPaint)와 고르기·찾기 때마다. */
  function finSync(kind) {
    var d = FINK[kind]; if (!d) return;
    var t = document.querySelector('#inner table[data-fin="' + kind + '"]');
    var sel = d.sel() || {}, words = finWords(kind), G = {}, vis = 0, nSel = 0, all = 0;
    if (t) {
      Array.prototype.forEach.call(t.querySelectorAll('tbody tr[data-frow]'), function (tr) {
        var id = tr.dataset.frow, ok = finHit(words, tr.dataset.fname), on = !!sel[id], b = tr.querySelector('input[data-fid]');
        var g = G[tr.dataset.fgk] || (G[tr.dataset.fgk] = { n: 0, s: 0, amt: 0 });
        all++;
        tr.hidden = !ok;
        if (b) b.checked = on;
        if (!ok) return;
        vis++; g.n++; g.amt += Number(tr.dataset.famt) || 0;
        if (on) { nSel++; g.s++; }
      });
      Array.prototype.forEach.call(t.querySelectorAll('tbody tr.ogrp[data-gk]'), function (tr) {
        var g = G[tr.dataset.gk] || { n: 0, s: 0, amt: 0 }, b = tr.querySelector('input[data-fingrp]');
        tr.hidden = !g.n;                                   // 찾는 사람이 없는 팀은 머리 줄도 숨긴다
        if (b) { b.checked = g.n > 0 && g.s === g.n; b.indeterminate = g.s > 0 && g.s < g.n; }
        // 팀 사람 수·합계 = 보이는 줄(찾는 중이면 찾은 사람만 — 「출력 안 한 것만」 때처럼)
        var on = tr.querySelector('.on'), sum = tr.querySelector('.or b');
        if (on) on.textContent = n0(g.n) + '명';
        if (sum) sum.textContent = won(g.amt);
      });
      var none = t.querySelector('tr.finnone'); if (none) none.hidden = vis > 0 || !all;
      Array.prototype.forEach.call(t.querySelectorAll('input[data-finall]'), function (a) {
        a.disabled = !vis; a.checked = vis > 0 && nSel === vis; a.indeterminate = nSel > 0 && nSel < vis;
      });
    }
    var busy = !!(d.busy && d.busy());
    Array.prototype.forEach.call(document.querySelectorAll('#inner [data-finbtn="' + kind + '"]'), function (b) {
      var lab = nSel ? '고른 ' + n0(nSel) + '명 PDF 한 파일로' : 'PDF 한 파일로 묶기';
      b.disabled = !nSel || busy;
      b.classList.toggle('pri', nSel > 0);
      if (b.textContent !== lab) b.innerHTML = ic('dl', 13) + esc(lab);
    });
    var qn = document.querySelector('#inner [data-finqn="' + kind + '"]');
    if (qn) qn.textContent = words.length ? '찾은 ' + n0(vis) + '명' + (nSel ? ' · 그중 고른 ' + n0(nSel) + '명' : '') : '';
    var qx = document.querySelector('#inner [data-finqx="' + kind + '"]'); if (qx) qx.hidden = !words.length;
  }
  function finSyncAll() { Object.keys(FINK).forEach(finSync); }
  function finClear(kind, focus) {
    FINQ[kind] = '';
    var i = document.querySelector('#inner input[data-finq="' + kind + '"]');
    if (i) { i.value = ''; if (focus) { try { i.focus({ preventScroll: true }); } catch (er) { } } }
    finSync(kind);
  }
  document.addEventListener('change', function (e) {
    var b = e.target;
    if (!b || !b.matches || !b.matches('input[data-fid],input[data-finall],input[data-fingrp]')) return;
    var t = b.closest('table[data-fin]'), kind = t && t.dataset.fin, d = kind && FINK[kind];
    if (!d) return;
    var sel = d.sel(), on = b.checked;
    if (b.matches('input[data-fid]')) { if (on) sel[b.dataset.fid] = 1; else delete sel[b.dataset.fid]; }
    else {
      // 전체 선택 · 이 팀 모두 고르기 — 보이는 줄만(찾기·「출력 안 한 것만」으로 숨은 줄은 건드리지 않는다)
      var gk = b.matches('input[data-fingrp]') ? b.dataset.gk : null;
      Array.prototype.forEach.call(t.querySelectorAll('tbody tr[data-frow]'), function (tr) {
        if (tr.hidden || (gk != null && tr.dataset.fgk !== gk)) return;
        if (on) sel[tr.dataset.frow] = 1; else delete sel[tr.dataset.frow];
      });
    }
    finSync(kind);
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('input[data-finq]')) return;
    FINQ[t.dataset.finq] = t.value;              // 치는 동안 다시 그리지 않는다 — 줄만 숨긴다(한글 조합·커서 그대로)
    finSync(t.dataset.finq);
  });
  document.addEventListener('click', function (e) {
    var x = e.target.closest && e.target.closest('[data-finqx]');
    if (x) finClear(x.dataset.finqx, true);
  });


  /* ══════════════════ 안전교육 ══════════════════ */
  /* 안전교육 — 앱과 같은 화면·같은 규칙(2026-10-14 사용자: 「웹에서도 시청·이수, %도 앱하고 동일하게」).
     · 목록: 회차별(최신 먼저) · 미래 회차는 🔒 공개예정(그 달 21일에 열림) · 의무 배지 · 진도 % · 100% 면 ✅ 시청 완료
     · 시청: 이 창 안에서 유튜브를 틀고, 앱과 **같은 가드 코드**(아래 guard-core)가 앞으로 건너뛰기(+2초)·배속을 막고
       본 만큼만 진도로 센다. 진도는 앱과 같은 표·같은 방식(edu_progress upsert)으로 저장된다 — 앱과 웹이 함께 쌓인다.
     · 진도는 줄지 않는다(가드의 최고 시청 위치 + 저장 직전 서버 시작값 미만이면 보내지 않음), completed_at 은 처음 100% 때 한 번만. */

  /* guard-core:begin — app/src/main/assets/edu_player.html 의 <script id="guard-core"> 를 **글자 그대로** 옮긴 것.
     고치지 말 것. 앱 쪽을 고치면 여기에 다시 복사한다(test/edu-web.test.mjs 가 한 글자라도 다르면 실패한다). */
// 순수 가드코어 — DOM/YouTube 미참조. Node 테스트(tools/edu/edu-guard.test.mjs)가 이 블록만 추출해 검증한다.
// Android/iOS 가 같은 파일을 그대로 번들한다(검증로봇이 SHA 대조). 수정 시 반드시 양쪽 복사.
window.EduGuard = {
  FORWARD_TOLERANCE: 2, SAVE_MS: 5000, MIN_DELTA_PCT: 1,
  create: function (d) {
    var max = Number(d.savedSeconds) || 0, lastSavedPct = -1, lastSaveAt = 0, playing = false;
    function pct() {
      var dur = d.player.getDuration();
      if (!dur || dur <= 0) return 0;
      return Math.min(100, Math.round((max / dur) * 100));
    }
    function save(ended) {
      var p = pct();
      d.onSave(p, Math.round(max), !!ended);
      lastSavedPct = p; lastSaveAt = d.now();
    }
    return {
      tick: function () {
        var cur = d.player.getCurrentTime();
        if (cur > max + window.EduGuard.FORWARD_TOLERANCE) {   // 앞으로 스킵 차단
          d.player.seekTo(max); d.onBlockedSeek(); return;
        }
        if (d.player.getPlayerState() === d.states.PLAYING) {
          max = Math.max(max, cur);
          if (playing && d.now() - lastSaveAt >= window.EduGuard.SAVE_MS &&
              Math.abs(pct() - lastSavedPct) >= window.EduGuard.MIN_DELTA_PCT) save(false);
        }
      },
      onStateChange: function (s) {
        playing = (s === d.states.PLAYING);
        if (s === d.states.PAUSED) save(false);
        if (s === d.states.ENDED) {
          // ENDED 시 현재 위치가 시청 최고점의 허용범위 안일 때만 인정한다.
          // 끝으로 드래그해 ENDED 를 유발하는 우회(웹 버전 허점)를 차단 — 실제 시청분만 진도가 된다.
          var cur = d.player.getCurrentTime();
          if (cur <= max + window.EduGuard.FORWARD_TOLERANCE) max = Math.max(max, cur);
          save(true);
        }
      },
      onRateChange: function () { d.player.setPlaybackRate(1); },   // 배속 잠금(웹 허점 수정)
      maybeSave: function () { save(false); },
      setServerSeconds: function (s) { max = Math.max(max, Number(s) || 0); },
      state: function () { return { maxWatchedSec: max }; },
    };
  },
};
  /* guard-core:end */

  /** YouTube 링크 → 영상 ID. 앱 EduModels.kt parseYoutubeId 와 같은 규칙(키보드가 바꿔 넣은 대시·제로폭 문자 정리,
   *  youtu.be · watch?v= · shorts · embed · 11자 ID, 주소로 못 읽으면 정규식 안전망). 못 읽으면 null. */
  function parseYoutubeId(input) {
    var s = String(input == null ? '' : input)
      .replace(/[‐-―−]/g, '-')          // 각종 대시 → 하이픈
      .replace(/[​-‏﻿⁠]/g, '')     // 제로폭·방향 문자 제거
      .trim();
    if (!s) return null;
    var idp = /^[A-Za-z0-9_-]{11}$/;
    if (idp.test(s)) return s;
    // java.net.URI 처럼: 주소에 쓸 수 없는 글자가 있으면 주소로 읽지 않고(앱은 예외로 넘어간다) 안전망으로 간다.
    // 호스트 대소문자도 앱처럼 그대로 둔다.
    var u = /[\s<>"{}|\\^`]/.test(s) ? null
      : /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^\/?#@]*@)?([^\/?#:]+)(?::\d*)?([^?#]*)(?:\?([^#]*))?/.exec(s);
    if (u) {
      var host = u[1].indexOf('www.') === 0 ? u[1].slice(4) : u[1], path = u[2] || '', query = u[3], got = null;
      var ends = host.length >= 11 && host.slice(-11) === 'youtube.com';
      if (host === 'youtu.be') { got = path.replace(/^\/+|\/+$/g, ''); }
      else if (ends && path === '/watch') {
        got = query == null ? null : (query.split('&').filter(function (x) { return x.indexOf('v=') === 0; })[0] || null);
        if (got) got = got.slice(2);
      } else if (ends && path.indexOf('/shorts/') === 0) { got = path.slice(8).replace(/^\/+|\/+$/g, ''); }
      if (got && idp.test(got)) return got;
    }
    // 마지막 안전망 — 문자열 어디에 있든 유튜브 ID 모양을 직접 뽑는다
    var m = /(?:youtu\.be\/|[?&]v=|shorts\/|embed\/)([A-Za-z0-9_-]{11})/.exec(s);
    return m ? m[1] : null;
  }

  /* ── 이번 회차 대상자 스냅샷(edu_targets) — 앱과 같은 계산·같은 쓰기(2026-10-14) ──
     앱은 직원이 앱을 열 때 본인 것(eduEnsureSelfTarget), 관리자가 교육 관리를 열 때 전 직원 것(eduEnsureMonthTargets)을
     만든다. 직전 평가기간(전달 21일~이번 달 20일) **자동 기록만**의 거리 가중 평균이 80점 미만이면 대상.
     최초 기록이 이긴다(ignore-duplicates, 이후 불변) — 웹이 먼저 써도 앱이 쓸 값과 같다(같은 safeScore·safeAvg).
     서버 규칙(20261008160000 edu_targets_app_insert): 본인 행이거나 관리자. */
  var EDU_TRIP_COLS = 'username,start_time,distance_km,is_manual,overspeed_count,rapid_accel_count,rapid_decel_count,' +
    'school_zone_overspeed_count,sustained_overspeed_count,harsh_corner_count';
  /** 운행 목록 → { avg: 거리 가중 평균(없으면 −1), n: 자동 운행 수 }. 앱 eduAverageOf. */
  function eduAverageOf(list) {
    var pairs = list.filter(function (t) { return !t.is_manual; })
      .map(function (t) { return [safeScore(t), Number(t.distance_km) || 0]; });
    return { avg: pairs.length ? safeAvg(pairs) : -1, n: pairs.length };
  }
  function eduIsTarget(avg, n) { return n > 0 && avg >= 0 && avg < EDU_THRESHOLD; }
  function eduInsertTargets(rows) {
    if (!rows.length) return Promise.resolve(false);
    return apiRetry('/rest/v1/edu_targets?on_conflict=month,username', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(rows)
    }).then(function (r) { return r.ok; });
  }
  /** 교육 표 셋만 다시 받는다(영상 등록·삭제, 스냅샷 생성 뒤). 보고 있는 교육 화면이면 다시 그린다. */
  function eduReload() {
    return Promise.all([
      fetchAll('/rest/v1/edu_videos?deleted=eq.false&select=*&order=month.desc,id.asc'),
      fetchAll('/rest/v1/edu_progress?select=*&order=username.asc,video_id.asc'),
      fetchAll('/rest/v1/edu_targets?select=*&order=month.asc,username.asc')
    ]).then(function (o) {
      EDUV = o[0] || []; EDUP = o[1] || []; EDUT = o[2] || [];
      paintPills();
      if ((VIEW === 'edu' || VIEW === 'eduadm') && !$('panel').classList.contains('open')) render();
      return true;
    }).catch(function (e) { console.warn('edu reload', e); return false; });
  }
  var EDU_SELF = {};
  /** 직원: 이번 회차 내 대상 여부가 아직 없으면 직전 평가기간 내 운행으로 계산해 기록한다(페이지당 한 번). */
  function eduEnsureSelf() {
    var me = myName(), now = Date.now(), month = eduKeyAt(now);
    if (!ME || !me || EDU_SELF[month]) return;
    if (EDUT.some(function (t) { return t.month === month && t.username === me; })) return;
    EDU_SELF[month] = 1;
    var r = eduPrevRange(now);
    fetchAll('/rest/v1/trips?username=eq.' + encodeURIComponent(me) + '&start_time=gte.' + r.lo + '&start_time=lt.' + r.hi +
      '&deleted_at=is.null&select=' + EDU_TRIP_COLS + '&order=start_time.desc,id.desc')
      .then(function (list) {
        var a = eduAverageOf(list || []);
        if (!eduIsTarget(a.avg, a.n)) return false;
        return eduInsertTargets([{ month: month, username: me, avg_score: a.avg, trip_count: a.n }]);
      })
      .then(function (ins) { if (ins) eduReload(); })
      .catch(function () { delete EDU_SELF[month]; });
  }
  var EDU_ADM = { tab: 'videos', month: '', ensured: {} };
  /** 관리자: 이번 회차 전 직원 스냅샷(아직 없는 사람만). 교육 관리를 열 때 페이지당 한 번. */
  function eduEnsureMonth() {
    if (!(ME && ME.is_admin)) return;
    var now = Date.now(), month = eduKeyAt(now);
    if (EDU_ADM.ensured[month]) return;
    EDU_ADM.ensured[month] = 1;
    var r = eduPrevRange(now);
    Promise.all([
      fetchAll('/rest/v1/edu_targets?select=month,username&month=eq.' + month + '&order=username.asc'),
      fetchAll('/rest/v1/app_users?select=username&order=name.asc,username.asc'),
      fetchAll('/rest/v1/trips?start_time=gte.' + r.lo + '&start_time=lt.' + r.hi + '&deleted_at=is.null&select=' + EDU_TRIP_COLS +
        '&order=start_time.asc,username.asc,id.asc')
    ]).then(function (o) {
      var have = {}, by = {}, rows = [];
      (o[0] || []).forEach(function (t) { have[t.username] = 1; });
      (o[2] || []).forEach(function (t) { (by[t.username] = by[t.username] || []).push(t); });
      (o[1] || []).forEach(function (u) {
        var un = u.username;
        if (!un || have[un]) return;
        var a = eduAverageOf(by[un] || []);
        if (eduIsTarget(a.avg, a.n)) rows.push({ month: month, username: un, avg_score: a.avg, trip_count: a.n });
      });
      return eduInsertTargets(rows);
    }).then(function (ins) { if (ins) eduReload(); })
      .catch(function () { delete EDU_ADM.ensured[month]; });
  }

  function eduThumb(v, locked) {
    return '<span class="eduth' + (locked ? ' lk' : '') + '"' + (locked ? '' : ' data-eduplay="' + esc(v.id) + '" role="button" tabindex="0" aria-label="' + esc(v.title) + ' 보기"') + '>' +
      '<img src="https://img.youtube.com/vi/' + encodeURIComponent(v.youtube_id) + '/hqdefault.jpg" alt="" loading="lazy">' +
      (locked ? '<i>🔒</i>' : '<b>' + ic('play', 14) + '</b>') + '</span>';
  }
  function viewEdu() {
    if (!LOADED) return head('안전교육') + skeleton();
    var key = eduNowKey(), me = myName(), pct = eduPctOf(me), months = eduTargetMonths(me);
    var ob = eduObligations(months, pct);
    var round = EDUV.filter(function (v) { return v.month === key; });
    var done = round.filter(function (v) { return (pct[v.id] || 0) >= 100; }).length;
    var amTarget = !!months[key];
    var carry = ob.filter(function (v) { return v.month !== key; }).length;
    var clean = !ob.length && (amTarget ? round.length > 0 : true);

    var h = head('안전교육', esc(key) + ' 회차 · 시청 기간 ' + eduOpenLabel(key) + '~' + eduDeadlineLabel(key) + ' · ' + eduDday(key));
    var verdict = ob.length ? '의무 교육 <em>' + ob.length + '편</em>이 남았어요'
      : amTarget && !round.length ? '이번 회차 영상이 아직 없어요'
        : amTarget ? '<em>이수를 마쳤어요</em>'
          : '의무 대상은 아니지만 자율 학습으로 볼 수 있어요';
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"' + (clean ? ' style="background:var(--ok)"' : '') + '></span>' +
      esc(key) + ' 회차</div>' +
      '<p class="verdict' + (clean ? ' clean' : '') + '">' + verdict + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">이번 회차 내 이수</div><div class="v">' + done + '<small> / ' + round.length + '편</small></div>' +
      '<div class="sub">' + (amTarget ? '의무 대상' : '의무 대상 아님') + '</div></div>' +
      '<div class="fact"><div class="k">남은 의무</div><div class="v' + (ob.length ? ' alert' : '') + '">' + ob.length + '<small>편</small></div>' +
      // D-day 는 위 머리 줄에 한 번만(2026-10-19) — 여기서는 마감 날짜
      '<div class="sub">' + (ob.length ? (carry ? '이월 ' + carry + '편 포함 · ' : '') + '가장 급한 마감 ' + eduDeadlineLabel(ob[0].month) : '남은 것 없음') + '</div></div>' +
      '<div class="fact"><div class="k">전체 영상</div><div class="v">' + EDUV.length + '<small>편</small></div></div>' +
      '</div></div>';

    if (!EDUV.length) return h + blank('등록된 교육 영상이 없어요.', null, 'play');
    var by = {}, keys = [];
    EDUV.forEach(function (v) { if (!by[v.month]) { by[v.month] = []; keys.push(v.month); } by[v.month].push(v); });
    // 순서: 이번 회차 → 지난 회차(최근 것부터) → 공개 예정(2026-10-19 웹 사용성 1차 — 공개 예정이 의무 영상보다 위에 있었다)
    var rank = function (mo) { return mo === key ? 0 : eduIsOpen(mo) ? 1 : 2; };
    keys.sort(function (a, b) { return rank(a) - rank(b) || (rank(a) === 2 ? (a < b ? -1 : a > b ? 1 : 0) : (a < b ? 1 : a > b ? -1 : 0)); });
    keys.forEach(function (mo) {
      var open = eduIsOpen(mo), yy = eduYm(mo);
      // 이번 회차의 D-day 는 머리 줄에 이미 있다 — 한 번만
      var sub = open ? '시청기간 ' + eduOpenLabel(mo) + '~' + eduDeadlineLabel(mo) + (mo === key ? '' : ' · ' + eduDday(mo))
        : '🔒 공개예정 · ' + eduOpenLabel(mo) + ' 공개';
      h += sect(yy.y + '년 ' + pad(yy.m) + '월 회차', '<span class="' + (open ? '' : 'edusoon') + '">' + esc(sub) + '</span>', '',
        '<div class="panel edulist">' + by[mo].map(function (v) {
          var p = pct[v.id] || 0, ok = p >= 100;
          var badge = !open ? '<span class="edutag soon">공개예정</span>'
            : months[v.month] && !ok ? '<span class="edutag must">의무</span>' : '';
          return '<div class="eduv' + (open ? '' : ' lk') + '" data-eduvid="' + esc(v.id) + '">' + eduThumb(v, !open) +
            '<div class="edubd"><div class="edut">' + badge + '<span class="lead">' + esc(v.title) + '</span></div>' +
            (v.description ? '<div class="edud">' + esc(v.description) + '</div>' : '') +
            (open ? '<div class="track' + (ok ? ' ok' : '') + '"><i style="width:' + Math.max(0, Math.min(100, p)) + '%"></i></div>' +
              '<div class="edup' + (ok ? ' ok' : '') + '">' + (ok ? '✅ 시청 완료' : p + '%') + '</div>'
              : '<div class="edup">' + eduOpenLabel(v.month) + '부터 시청할 수 있어요</div>') +
            '</div>' +
            (open ? '<button class="btn sm" data-eduplay="' + esc(v.id) + '">' + ic('play', 12) + (ok ? '다시 보기' : p > 0 ? '이어 보기' : '보기') + '</button>' : '') +
            '</div>';
        }).join('') + '</div>');
    });
    h += '<section class="sect"><div class="panel" style="padding:16px 20px;font-size:13px;color:var(--ink-600);line-height:1.7">' +
      '· 앞으로 건너뛰기와 배속 변경은 할 수 없어요<br>· 되감기는 자유롭고, 나갔다 와도 이어서 볼 수 있어요<br>' +
      '· 앱과 웹의 진도는 함께 쌓여요</div></section>';
    return h;
  }

  /* ── 시청 창 — 앱 EducationWatchScreen 과 같은 흐름 ──
     유튜브 IFrame API 로 창 안에서 틀고, 가드(EduGuard)가 0.25초마다 위치를 본다. 저장은 가드가 부른다
     (5초마다 1%p 이상 늘었을 때 · 일시정지 · 끝 · 창 닫기 · 다른 탭으로 감). 웹은 앱 WebView 와 달리
     리퍼러 문제가 없어서 YT.Player 가 iframe 을 직접 만들게 둔다. */
  var EDUW = null;          // 지금 열린 시청 창
  var YT_WAIT = null;
  function eduYtApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (YT_WAIT) return YT_WAIT;
    YT_WAIT = new Promise(function (ok, no) {
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') { try { prev(); } catch (e) { } }
        ok(window.YT);
      };
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api'; s.async = true;
      s.onerror = function () { YT_WAIT = null; no(new Error('youtube api')); };
      document.head.appendChild(s);
    });
    return YT_WAIT;
  }
  function eduMsg(t) { var m = $('eduMsg'); if (m) m.textContent = t; }
  function eduPaintPct(W) {
    if (W !== EDUW) return;
    var p = Math.max(0, Math.min(100, W.pct)), ok = p >= 100;
    var a = $('eduPct'); if (a) { a.textContent = p + '%'; a.className = ok ? 'ok' : ''; }
    var b = $('eduBar'); if (b) { b.style.width = p + '%'; b.parentNode.classList.toggle('ok', ok); }
  }
  function eduOpenWatch(id) {
    var v = EDUV.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!v) { toast('영상 정보를 찾을 수 없어요.', true); return; }
    if (!eduIsOpen(v.month)) { toast(eduOpenLabel(v.month) + '부터 시청할 수 있어요.', true); return; }
    eduStop();
    openPanel(v.title, v.month + ' 회차 · 마감 ' + eduDeadlineLabel(v.month) + ' · ' + eduDday(v.month),
      '<div class="eduplayer"><div id="eduYt"></div></div>' +
      '<div class="edustat"><b id="eduPct"></b><div class="edusb"><div class="track"><i id="eduBar"></i></div>' +
      '<div id="eduMsg" class="dim">영상을 불러오는 중…</div></div></div>' +
      '<div class="fhint">· 앞으로 건너뛰기와 배속 변경은 할 수 없어요<br>· 되감기는 자유롭고, 나갔다 와도 이어서 볼 수 있어요</div>' +
      '<div id="eduCongrats" hidden></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>', true);
    // 창을 연 뒤에 시청 상태를 만든다(openPanel 은 열려 있던 시청 창을 멈춘다).
    var me = myName();
    var row = EDUP.filter(function (p) { return p.username === me && String(p.video_id) === String(v.id); })[0];
    var W = EDUW = { v: v, start: row ? Number(row.progress_pct) || 0 : 0, sec: row ? Number(row.watch_seconds) || 0 : 0,
      pct: 0, player: null, guard: null, ticker: null, q: Promise.resolve(), gone: false };
    W.pct = W.start;
    eduPaintPct(W);
    // ★ 시작값은 창을 열 때마다 서버에서 새로 받는다(앱 EducationWatchScreen 과 같다, 2026-10-14 검증로봇).
    //   페이지를 연 뒤 앱에서 다 본 영상을 웹에서 다시 열면, 페이지가 받아 둔 옛 값(0%)으로 시작해
    //   서버의 100%·이수를 낮은 값으로 덮었다. 못 받으면 열 수는 있되 받아 둔 값 그대로.
    var fresh = apiRetry('/rest/v1/edu_progress?username=eq.' + encodeURIComponent(me) + '&video_id=eq.' +
      encodeURIComponent(v.id) + '&select=*')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        var f = rows && rows[0];
        if (!f || W !== EDUW) return;
        var fp = Number(f.progress_pct) || 0, fs = Number(f.watch_seconds) || 0;
        if (fp > W.start) W.start = fp;
        if (fs > W.sec) W.sec = fs;
        if (W.start > W.pct) W.pct = W.start;
        eduLocalRow({ username: me, video_id: v.id, progress_pct: W.start, watch_seconds: W.sec,
          updated_at: f.updated_at || null, completed_at: f.completed_at || null });
        eduPaintPct(W);
      }, function () { });
    Promise.all([eduYtApi(), fresh]).then(function (res) {
      var YT = res[0];
      if (W !== EDUW || !$('eduYt')) return;
      W.player = new YT.Player('eduYt', {
        videoId: v.youtube_id, width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, controls: 1, fs: 1, origin: location.origin },
        events: {
          onReady: function () {
            if (W !== EDUW) return;
            W.guard = window.EduGuard.create({
              player: W.player,
              states: { PLAYING: YT.PlayerState.PLAYING, PAUSED: YT.PlayerState.PAUSED, ENDED: YT.PlayerState.ENDED },
              savedSeconds: W.sec,
              now: function () { return Date.now(); },
              onSave: function (p, s) { eduSave(W, p, s); },
              onBlockedSeek: function () { if (W === EDUW) eduMsg('⛔ 앞으로 건너뛸 수 없어요'); }
            });
            if (W.sec > 3) W.player.seekTo(W.sec, true);
            W.ticker = setInterval(function () { if (W.guard) W.guard.tick(); }, 250);
            eduMsg(W.sec > 3 ? '지난번 본 곳부터 이어서 봐요. ▶ 재생을 누르세요.' : '▶ 재생을 눌러 시작하세요.');
          },
          onStateChange: function (e) {
            if (W !== EDUW) return;
            if (e.data === 3) eduMsg('버퍼링 중…');
            else if (e.data === 1) eduMsg('재생 중 · 자동 저장');
            else if (e.data === 2) eduMsg('일시정지');
            if (W.guard) W.guard.onStateChange(e.data);
          },
          onPlaybackRateChange: function () { if (W.guard) W.guard.onRateChange(); },
          onError: function (e) { if (W === EDUW) eduMsg('⚠️ 영상을 불러오지 못했어요(오류 ' + e.data + '). 네트워크를 확인하고 다시 해 주세요.'); }
        }
      });
    }, function () { if (W === EDUW) eduMsg('⚠️ 영상을 불러오지 못했어요(오류 -1). 네트워크를 확인하고 다시 해 주세요.'); });
  }
  /** 가드가 부르는 저장. 앱처럼 서버 시작값 미만이면 보내지 않고, 처음 100% 일 때만 completed_at 을 싣는다.
   *  저장은 한 줄로 세운다 — 앞 저장이 끝난 뒤에 '처음 100%' 를 판단해야 completed_at 이 두 번 안 간다. */
  function eduSave(W, p, s) {
    if (p > W.pct) W.pct = p;
    if (s > W.sec) W.sec = s;
    eduPaintPct(W);
    // 페이지를 떠나는 중이면 줄을 서지 않고 바로 보낸다 — 앞 저장이 덜 끝났으면 keepalive 가 아예 안 나갔다(검증로봇).
    var tail = W.gone ? Promise.resolve() : W.q;
    W.q = tail.then(function () {
      if (p < W.start) return null;                         // 단조증가 이중 안전(앱과 같다)
      var first = p >= 100 && W.start < 100, iso = new Date().toISOString();
      var row = { username: myName(), video_id: W.v.id, progress_pct: Math.max(0, Math.min(100, p)),
        watch_seconds: Math.max(0, s), updated_at: iso };
      if (first) row.completed_at = iso;
      return apiRetry('/rest/v1/edu_progress?on_conflict=username,video_id', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([row]), keepalive: !!W.gone
      }).then(function (r) {
        if (!r.ok) { if (W === EDUW) eduMsg('⚠️ 진도를 저장하지 못했어요. 네트워크를 확인하고 다시 재생해 주세요.'); return; }
        eduLocalRow(row);
        if (first) { W.start = 100; eduCongrats(W); }
        if (W === EDUW) eduMsg(p >= 100 ? '✅ 시청 완료!' : '재생 중 · 자동 저장');
      });
    }).catch(function () { if (W === EDUW) eduMsg('⚠️ 진도를 저장하지 못했어요. 네트워크를 확인하고 다시 재생해 주세요.'); });
  }
  /** 저장이 된 값을 화면 자료(EDUP)에도 넣는다 — 다시 받지 않아도 목록 %·메뉴 숫자가 맞게. */
  function eduLocalRow(row) {
    var hit = EDUP.filter(function (x) { return x.username === row.username && String(x.video_id) === String(row.video_id); })[0];
    if (!hit) { hit = { username: row.username, video_id: row.video_id, completed_at: null }; EDUP.push(hit); }
    hit.progress_pct = row.progress_pct; hit.watch_seconds = row.watch_seconds; hit.updated_at = row.updated_at;
    if (row.completed_at) hit.completed_at = row.completed_at;
    paintPills();
  }
  /** 수료 축하 — 처음 100% 때 한 번(앱 EduCongratsDialog). 스크린샷 증빙용으로 제목·일시를 남긴다. */
  function eduCongrats(W) {
    toastOk('수료 완료! ' + W.v.title);
    var c = $('eduCongrats');
    if (!c || W !== EDUW) return;
    var d = kd(Date.now());
    c.innerHTML = '<div class="educg" role="status"><div class="e">🎉</div><div class="t">수료 완료!</div>' +
      '<div class="n">' + esc(W.v.title) + '</div>' +
      '<div class="dim">' + d.getUTCFullYear() + '.' + pad(d.getUTCMonth() + 1) + '.' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' 시청 완료</div>' +
      '<button class="btn pri sm" data-educg>확인</button></div>';
    c.hidden = false;
    // 영상 아래에 붙어 낮은 화면에서는 창 밖이었다 — 보이게 굴린다(2026-10-15 매뉴얼 로봇)
    try { c.scrollIntoView({ block: 'nearest', behavior: (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') }); } catch (e) { }
  }
  /** 창을 닫을 때 — 앱 EduPlayerPause 와 같다(일시정지 + 지금 위치 저장). 저장이 끝나면 목록을 다시 그린다. */
  function eduStop() {
    var W = EDUW;
    if (!W) return;
    EDUW = null;
    if (W.ticker) clearInterval(W.ticker);
    try { if (W.player && W.player.pauseVideo) W.player.pauseVideo(); } catch (e) { }
    if (W.guard) W.guard.maybeSave();
    try { if (W.player && W.player.destroy) W.player.destroy(); } catch (e) { }
    W.q.then(function () { if (VIEW === 'edu' && !$('panel').classList.contains('open')) render(); });
  }
  // 다른 탭·앱으로 가면 멈추고 저장(앱의 ON_PAUSE). 페이지를 떠날 때는 keepalive 로 마지막 위치를 보낸다.
  document.addEventListener('visibilitychange', function () {
    var W = EDUW;
    if (!document.hidden || !W) return;
    try { if (W.player && W.player.pauseVideo) W.player.pauseVideo(); } catch (e) { }
    if (W.guard) W.guard.maybeSave();
  });
  window.addEventListener('pagehide', function () {
    var W = EDUW;
    if (W && W.guard) { W.gone = true; W.guard.maybeSave(); }
  });

  /* ══════════════════ 정산 ══════════════════ */
  function viewSettle() {
    if (!LOADED) return head(scopeTitle('정산')) + skeleton();
    var T = totals(TRIPS, isAll() ? { allUsers: true } : { who: myName() });
    var rows = perPersonTotals();

    var h = head(scopeTitle('정산'), esc(viewName()) + ' · ' + esc(viewSpan()) + (isMulti() ? ' · <b>조회 전용</b>' : ''));

    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>업무용 비용 합계</div>' +
      '<p class="verdict">' + won(T.cost) + '</p>' +
      // 세 칸(유류비·통행료·주차비)은 폰에서도 한 줄(2026-10-19 — 2열이라 주차비만 혼자 아래 줄이었다)
      '<div class="facts f3">' +
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
        '<span class="bd"><span class="t">통행료 미확정 ' + n0(T.unk) + '건이 0원으로 정산돼요</span>' +
        '<span class="d">' + (!isAll() && myCycLocked()
          ? lockWhy(myName()) + ' 이 기간에는 영수증을 올릴 수 없어요. ' + lockHow(myName())
          : '통행료를 냈다면 ‘영수증·통행료’ 단계에서 영수증을 올리세요. 그날 운행 금액이 없으면 영수증 금액이 합계에 들어가요.') + '</span></span>' +
        '<span class="go">' + ic('chev', 15) + '</span></button></section>';
    }

    if (isAll()) { var tc = teamCards(rows); if (tc) h += sect(ORGF.team ? '파트·센터별' : '팀별', null, '', tc); }
    // 개인 범위에서 rows 는 사람 목록(늘 1명)이다. 건수는 운행 수로 적는다.
    h += sect(isAll() ? '직원별' : '내 정산',
      isAll() ? rows.length + '명' : '운행 ' + n0(T.n) + '건',
      // 버튼 이름을 받는 것 그대로 부른다(예전 「인쇄용 출력」은 엑셀 창을 열었다).
      // 두 단추는 한 묶음(같은 줄·같은 높이 — 폰에서 두 줄로 갈라지던 것, 2026-10-19)
      '<span class="hdbtns">' + (isMulti() ? '' : '<button class="btn sm" data-print="' + esc(myName()) + '">' + ic('receipt', 13) +
        (isAll() ? '내 운행기록부' : '운행기록부 (엑셀 · PDF)') + '</button>') +
      '<button class="btn sm" id="btnCsv" title="운행 목록을 CSV로 다운로드해요">' + ic('dl', 13) + '목록 CSV</button></span>', personTable(rows));

    h += sect('산정 기준', null, '',
      '<div class="panel" style="padding:18px 20px;font-size:13px;line-height:1.7;color:var(--ink-3)">' +
      '업무용(<b style="color:var(--ink-2)">' + BUSINESS + '</b>) 운행만 집계해요.<br>' +
      '유류비 = 분기 기준단가 × 주행거리(도착 계기판 km − 출발 계기판 km, 각각 반올림)<br>' +
      '분기 경계 ' + esc(QBOUNDS.map(function (b) { return pad(b[0]) + '-' + pad(b[1]); }).join(' · ')) + '<br>' +
      '<b style="color:var(--ink-2)">회사 월간 리포트와 같은 식</b>으로 계산해요. 리포트와 다르면 알려 주세요.</div>');
    return h;
  }

  /* ══════════════════ 인쇄용 출력 ══════════════════
     운행기록부 + 영수증 4종을 한 번에 인쇄한다(브라우저의 'PDF로 저장' 이 곧 한 권).

     ★ 왜 서버에서 PDF 를 만들지 않는가
       서버에서 만들려면 한글 글꼴을 PDF 안에 심어야 한다(5MB 급). 함수가 무거워지고
       글꼴이 조금만 어긋나도 글자가 깨진다. 게다가 영수증 282장을 서버가 내려받아
       다시 넣어야 한다. 브라우저는 한글 글꼴도, 사진도 이미 갖고 있다.
       그래서 화면을 인쇄 규격(A4)으로 짜고 브라우저에 맡긴다 — 미리보기도 공짜다.  */

  /* 사내 양식 결재란 칸 이름은 결재 건마다 boxLabels(a) 로 고른다(예전 건 v1 · 새 건 v2, 2026-10-14). 배정 안 된 칸은 빗금으로 지운다. */
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
       · 주차비·통행료  금액 규칙 v3(sheetMoney · money-rule.js) — 운행 금액, 없는 날만 영수증(그 운행 줄)
                     통행료 칸 읽기는 tollAmountForExport 그대로(TollCharge.kt 126행). ★ 앱 349~357행(운행+영수증)은 v2 — 앱도 v3 로 고칠 것
       · 금액합계    SUM(유류+주차+통행)                  (359행) ← 목적 무관
       · 근거자료만 있는 날의 행(앱 363~377행)은 v3 에서 없다 — 운행 없는 날의 영수증은 정산에서 뺀다(예전 고정본만 legacy)
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
    var r = cycleRange(CYC);
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

    // ── 주차비·통행료 칸 — 금액 규칙 v3(sheetMoney · moneyOf). 운행 없는 날의 영수증은 정산에서 빠져 행이 없다. ──
    var SM = sheetMoney(mine, r, pick, false);
    var orphan = SM.orphans(rows).map(function (o) { return o.date; });
    var evPark = {}, evToll = {};
    SM.orphans(rows).forEach(function (o) { evPark[o.date] = o.parking; evToll[o.date] = o.toll; });

    // ── 행을 만들면서 합계를 함께 낸다 ──
    var body = '';
    var sumKm = 0, sumFuel = 0, sumPark = 0, sumToll = 0, sumAll = 0;
    var partMap = {};                     // 지역·단가별 분해

    rows.forEach(function (t) {
      var g = odoInt(t.start_odometer), hh = odoInt(t.end_odometer);
      var dist = hh - g;                                   // 앱 I열 = H−G (음수도 그대로)
      var rate = rateOf(t);
      var fuel = Math.max(0, dist) * rate;                 // 앱 J열 = MAX(0,I)×단가. 목적 무관.
      var day = ymd(t.start_time);
      var mv = SM.row(t);
      var park = mv.park;
      var toll = mv.toll;
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
    var boxMap = boxesOf(a, u, mine), FORM_BOXES = boxLabels(a);
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
      FORM_BOXES.map(function (b) { return '<th>' + esc(b) + '</th>'; }).join('') + '</tr><tr>' +
      FORM_BOXES.map(function (b) {
        var v = boxMap[b];
        if (!v) return '<td class="pslash"></td>';
        var sg = signOf(v);
        return '<td class="psign">' + (sg ? '<img class="pstamp" alt="' + esc(v.name) + '" src="' + esc(sg) + '">' : esc(v.name)) +
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

  /**
   * 운행기록부 한 장의 주차비·통행료 칸. row(t) 는 **줄 순서대로** 부른다(예전 규칙의 「그날 첫 행」 때문).
   *  · v3(기본 · 2026-10-15): 업무 운행 줄 = 운행 금액 + 영수증으로 채운 금액(money-rule.js rowOf — 운행 금액이 없는 날만,
   *    이은 운행 줄 아니면 그날 첫 업무 운행 줄). 운행 금액이 있는 날은 영수증을 더하지 않는다. 운행 없는 날의 영수증은 뺀다(행 없음).
   *    업무가 아닌 운행 줄은 운행에 적힌 금액 그대로(영수증은 업무 운행에만 붙는다).
   *  · legacy(예전 v1·v2 결재 고정본을 다시 만들 때): 그때 규칙 그대로 — 운행 금액 + 그날 첫 행에 영수증 전부,
   *    운행 없는 날의 영수증은 「근거자료」 행. 결재된 문서가 나중에 다른 숫자로 다시 찍히면 안 되기 때문이다.
   * pick = evidBySheet() 가 이 장에 정한 영수증(legacy 만 쓴다 — v3 는 운행 줄이 곧 장을 정한다).
   */
  function sheetMoney(mine, r, pick, legacy) {
    if (!legacy) {
      var M = moneyOf(mine, r);
      return {
        row: function (t) {
          var biz = (t.purpose || '') === BUSINESS && !t.deleted_at;
          if (!biz) return { park: Number(t.parking_cost) || 0, toll: tollForExport(t, 0), evPark: 0, evToll: 0 };
          var p = M.rowOf('주차', t), l = M.rowOf('통행료', t);
          return { park: p.amt + p.fill, toll: tollForExport(t, l.fill), evPark: p.fill, evToll: l.fill };
        },
        orphans: function () { return []; }
      };
    }
    var evPark = {}, evToll = {}, seen = {};
    EVID.forEach(function (e) {
      var d = Number(e.date_millis);
      if (e.username !== mine || !(d >= r.lo && d < r.hi)) return;
      if (!pick || !pick[e.id]) return;
      if (!(Number(e.amount) > 0)) return;
      var k = evDay(e, r);                               // 운행에 이은 영수증은 그 운행의 날로
      if (e.category === '주차') evPark[k] = (evPark[k] || 0) + Number(e.amount);
      if (e.category === '통행료') evToll[k] = (evToll[k] || 0) + Number(e.amount);
    });
    return {
      row: function (t) {
        var day = ymd(t.start_time);
        var first = !seen[day]; seen[day] = 1;           // 그날 첫 운행 행에만 영수증을 붙인다(예전 규칙)
        var exP = first ? (evPark[day] || 0) : 0, exT = first ? (evToll[day] || 0) : 0;
        return { park: (Number(t.parking_cost) || 0) + exP, toll: tollForExport(t, exT), evPark: exP, evToll: exT };
      },
      // 운행이 하나도 없는 날의 영수증은 별도 행(앱 363~377행 · 예전 규칙)
      orphans: function (rows) {
        var tripDates = {};
        rows.forEach(function (t) { tripDates[ymd(t.start_time)] = 1; });
        return Object.keys(evPark).concat(Object.keys(evToll))
          .filter(function (d, i, arr) { return arr.indexOf(d) === i && !tripDates[d]; }).sort()
          .map(function (d) { return { date: d, parking: evPark[d] || 0, toll: evToll[d] || 0 }; });
      }
    };
  }
  /** 고정본(withFrozen)으로 예전 규칙(v1·v2) 결재 문서를 다시 만드는가 — 그때 규칙 그대로 찍는다(sheetMoney legacy). */
  var FROZEN_ON = false;
  function legacyDoc(a) { return FROZEN_ON && !!a && (Number((a.snapshot || {}).version) || 1) < 3; }

  /** 차량 한 대치 엑셀 한 장을 만든다. 앱 exportRange 와 같은 순서·같은 규칙(주차비·통행료는 규칙 v3 — sheetMoney). */
  function sheetDataFor(mine, u, plate, list, r, pick, legacy) {
    // 앱 188행: 같은 날이면 계기판 순, 그 다음 시각 순.
    var rows = list.slice().sort(function (x, y) {
      return dayNo(x.start_time) - dayNo(y.start_time)
        || odoInt(x.start_odometer) - odoInt(y.start_odometer)
        || x.start_time - y.start_time;
    });
    var veh = VEHICLES.filter(function (v) {
      return v.username === mine && (v.plate_no || '') === plate;
    })[0] || {};

    var SM = sheetMoney(mine, r, pick, legacy);
    var out = [], partMap = {};
    rows.forEach(function (t) {
      var g = odoInt(t.start_odometer), hh = odoInt(t.end_odometer);
      var rate = rateOf(t);
      var day = ymd(t.start_time);
      var mv = SM.row(t);
      // 통행료 칸 출처(PDF 표시만 — 2026-10-23): 영 = 영수증으로 채운 금액 · 하 = 하이패스 이용내역으로 맞춘 통행료(규칙 v3 하이패스 몫이 있는 업무 운행)
      var ta = tollNeed(t).a;
      var tollMark = mv.evToll > 0 ? '영'
        : (t.purpose || '') === BUSINESS && !t.deleted_at && ta > 0 && window.MoneyRule && window.MoneyRule.hipassOf(t, ta) > 0 ? '하' : '';
      out.push({
        date: day, start: dong(t.start_address), end: dong(t.end_address),
        visit: t.visit_place || '', purpose: t.purpose || '', manual: !!t.is_manual,
        odoS: g, odoE: hh, rate: rate, parking: mv.park, toll: mv.toll,
        // 영수증으로 채운 금액(표시용 — 엑셀 칸 값은 parking·toll 그대로)
        evPark: mv.evPark, evToll: mv.evToll, tollMark: tollMark
      });
      // 지역별 분해 — FuelCost.km 규칙(역행이면 0)을 그대로 쓴다.
      var km = Math.max(0, hh - g);
      var rg = region(t.start_address || '', t.start_lat, t.start_lng);
      var key = rg + '-' + rate;
      var p = partMap[key] = partMap[key] || { region: rg, rate: rate, km: 0, amount: 0 };
      p.km += km; p.amount += km * Math.max(rate, 0);
    });
    var orphans = SM.orphans(rows);                      // v3 는 늘 비어 있다(운행 없는 날의 영수증은 정산에서 뺀다)
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
    if (!LOADED) { toast('아직 불러오는 중이에요.'); return; }
    var mine = who || myName();
    if (who && who !== myName() && !isAll()) {
      toast('다른 분 운행기록부는 관리 › 현황에서 다운로드할 수 있어요.', true);
      return;
    }
    if (!window.Xlsx) { toast('엑셀 모듈을 불러오지 못했어요. 새로고침해 주세요.', true); return; }

    // ★ 파일은 xlsxFiles() 하나로만 만든다. 예전에는 여기에 같은 일을 하는 코드가 따로 있어,
    //   '번호판이 장과 안 맞는 영수증' 수정이 결재 문서 엑셀에만 들어가고 이 버튼에는 빠졌다(2026-10-02 재검증).
    var files = xlsxFiles(mine);
    if (!files.length) { toast('고른 목적에 해당하는 운행·영수증이 없어요.', true); return; }
    files.forEach(function (f, i) {
      // 여러 장이면 브라우저가 한꺼번에 받는 것을 막을 수 있어 조금씩 띄운다.
      setTimeout(function () { saveBlob(f.bytes, f.name); }, i * 400);
    });
    var warn = sheetSumWarn(files, expectCost(mine));
    if (warn) toast(warn, true);
    else toast(files.length > 1 ? '엑셀 ' + files.length + '개를 차량별로 다운로드해요.' : '엑셀을 다운로드해요.');
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
    // 1원도 봐주지 않는다(2026-10-08) — 정산 금액은 원 단위로 정확히 맞아야 한다(±1원 허용이 실제 차이를 숨겼다).
    if (!known || Math.round(sum) - Math.round(Number(expect)) === 0) return '';
    return '문서 총계(' + won(sum) + ')와 집계 금액(' + won(expect) + ')이 ' +
      n0(Math.abs(Math.round(sum) - Math.round(Number(expect)))) + '원 달라요. 관리자에게 알려 주세요.';
  }

  function saveBlob(bytes, filename, type) {
    var blob = new Blob([bytes], {
      type: type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
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
          '<span>' + esc(u.name || mine) + ' · ' + esc(cycleName(CYC)) + '</span>' +
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
  /** 마감까지 남은 날 — KST 달력 날짜로 센다(마지막 날 − 오늘). 안전교육 「D-4」(eduDday)·포털 첫 화면과 같은 셈(2026-10-16 3차).
   *  예전에는 남은 시간을 올림해서 10/16 에 10/20 마감이 「5일」로 나와 안전교육 「D-4」와 달랐다. */
  function dueDays(r, now) { return dayNo(r.hi - 1) - dayNo(now); }
  function dueText(r, now) {
    // 끝난 뒤 GRACE_DAYS 일 동안은 며칠 지났는지(2026-10-20 — 포털 첫 화면 「1일 지남」과 같은 셈)
    if (now >= r.hi) { var p = daysPast(r, now); return p >= 1 && p <= CR.graceDays() ? '마감 ' + p + '일 지남' : '마감 종료'; }
    var d = dueDays(r, now);
    return d <= 0 ? '오늘 마감' : '마감 D-' + d;
  }

  /**
   * 앱 ExcelExporter.exportRange 103행: "(기간 : yyyy-MM-dd ~ yyyy-MM-dd)"
   * 끝날짜는 포함이므로 회차 끝(hi)에서 하루를 뺀 날이다.
   */
  function periodLabel() {
    var r = cycleRange(CYC);
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
    var r = cycleRange(CYC);
    var s = quarterOf(r.lo), e = quarterOf(r.hi - 1);
    if (s.y !== e.y || s.q !== e.q) return '기간 분기·지역별 적용';
    var m = RATES[s.y + '-' + s.q + '-수도권'], l = RATES[s.y + '-' + s.q + '-지방'];
    if (m != null && l != null) return '수도권 ' + m + '·지방 ' + l + '원';
    return s.y + ' ' + s.q + '분기 기준';
  }

  /** 인쇄 전에 담을 운행목적을 고르게 한다. 앱 내보내기 창과 같은 자리다. */
  function doPrint(who) {
    if (!LOADED) { toast('아직 불러오는 중이에요.'); return; }
    if (isMulti()) { toast('운행기록부는 한 기간씩 만들어요. 기간을 하나 골라 주세요.', true); return; }
    // 개인 화면에서는 본인 것만 뽑는다. 남의 이름으로 부르면 운행은 없어도
    // 머리 정보(이름·부서·차량)가 찍히므로 여기서 막는다.
    if (who && who !== myName() && !isAll()) {
      toast('다른 분 운행기록부는 관리 › 현황에서 인쇄할 수 있어요.', true);
      return;
    }
    var target = who || myName();
    // 결재 중이거나 끝난 주기는 '고정본'이 정본이다 — 상신할 때 서버가 굳힌 자료로만 만든다.
    var ap = apprOf(target, CYCKEY());
    if (ap && (ap.status === 'submitted' || ap.status === 'approved')) {
      var done = ap.status === 'approved';
      openPanel(done ? '결재 완료본' : '결재 문서',
        nameOf(target) + ' · ' + cycleName(CYC) + ' · ' + cycleSpan(CYC),
        '<div class="hpnote" style="margin-top:0">' + ic('check', 16) + '<span><b>' +
        (done ? '결재가 끝났어요.' : '결재 중이에요.') + '</b> 상신할 때의 자료로 만든 문서예요. ' +
        // 상신 뒤 덧붙인 하이패스 영수증 원본은 더해진다(2026-10-23) — 「언제 받아도 같은 내용」만 말하면 틀린다
        '금액과 운행은 언제 다운로드해도 같고, 상신 뒤 첨부한 하이패스 영수증 원본만 ‘덧붙임’ 표시와 함께 더해져요.</span></div>' + apprTrack(ap) +
        // 결재 완료본에는 검증 결과 쪽이 없다(2026-10-14) — 안내 글도 그대로 말한다.
        '<div class="anote"><b>PDF</b>: ' + (done ? '운행기록부(결재란 포함)와 영수증 사진이 한 권으로 나와요.'
          : '운행기록부(결재란 포함), 검증 결과, 영수증 사진이 한 권으로 나와요. 결재가 끝나기 전에는 쪽마다 ‘결재 중’이 찍혀요.') + '<br>' +
        '<b>엑셀</b>: 앱에서 다운로드하는 것과 같은 양식이고, 차량마다 한 장씩이에요. 업무(일반업무) 운행만 들어가요.</div>',
        '<span style="flex:1"></span><button class="btn" data-close>닫기</button>' +
        // 단추 이름은 결재 띠와 같게 「엑셀 받기」·「PDF 받기」(2026-10-16 3차) — 무엇을 받는지는 창 제목(결재 완료본·결재 문서)이 말한다.
        '<button class="btn" data-fzxlsx="' + ap.id + '">' + ic('dl', 14) + '엑셀 받기</button>' +
        '<button class="btn pri" data-fzpdf="' + ap.id + '">' + ic('dl', 14) + 'PDF 받기</button>');
      return;
    }
    $('pTitle').textContent = '운행기록부';
    $('pSub').textContent = nameOf(target) + ' · ' + cycleName(CYC) + ' · ' + cycleSpan(CYC);
    $('pBody').innerHTML =
      '<div class="form"><div class="frow"><label class="flab">담을 운행</label><div class="fbody">' +
      '<div class="radios" role="group" aria-label="담을 운행">' + PURPOSES.map(function (p) {
        return '<label class="radio"><input type="checkbox" name="ppurp" value="' + esc(p) + '"' +
          (PRINT_PURPOSES.indexOf(p) >= 0 ? ' checked' : '') + '><span>' + esc(p) + '</span></label>';
      }).join('') + '</div>' +
      '<div class="fhint">차량일지를 <b>제출</b>할 때는 <b>일반업무</b>만 고르세요. ' +
      '앱에서 엑셀로 다운로드할 때와 같은 기준이에요.</div>' +
      '</div></div></div>' +
      '<div class="anote"><b>엑셀</b>: 앱에서 다운로드하는 것과 같은 파일이에요. ' +
      '엑셀에서 계기판 값을 고치면 운행거리, 유류비, 합계가 <b>수식으로 따라 바뀌어요</b>. ' +
      '차량을 두 대 이상 운행했으면 <b>차량별로 한 장씩</b> 나와요.<br>' +
      '<b>PDF 미리보기</b>: 운행기록부, 검증 결과, 영수증 사진이 한 권으로 나와요. ' +
      (ap && (ap.status === 'rejected' || ap.status === 'withdrawn') ? (ap.status === 'rejected' ? '반려된' : '회수한') + ' 기간이라 다시 상신하기 전까지' : '아직 상신 전이라') + ' 쪽마다 <b>‘미리보기’</b>가 찍혀요. 결재가 끝나면 <b>결재 완료 문서</b>를 다운로드할 수 있어요.</div>';
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
    if (!anyRow) { toast('고른 목적에 해당하는 운행이 없어요.', true); return; }
    var imgs = Array.prototype.slice.call(host.querySelectorAll('img'));
    var left = imgs.length;
    toast(left ? '영수증 ' + left + '장을 불러오는 중…' : '인쇄 창을 여는 중…');
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
      var op = orgPath(t.username);
      var row = [ymd(t.start_time), hm(t.start_time), u.name || t.username, [orgName(op), op.unit].filter(Boolean).join(' · '),
        t.plate_no || '', t.purpose || '', t.start_address || '', t.end_address || '', t.visit_place || '',
        t.start_odometer, t.end_odometer, t.distance_km,
        Math.round(tripFuel(t)), t.toll_cost == null ? '' : t.toll_cost,
        isUnknownToll(t) ? '미확정' : '확정', t.parking_cost == null ? '' : t.parking_cost,
        t.is_manual ? '수기' : '자동'];
      lines.push(row.map(function (v) {
        if (typeof v === 'number') return String(v);
        var s = String(v == null ? '' : v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;            // 엑셀이 수식으로 실행하지 않게(방문처·주소는 직원이 친 글)
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
    toast('운행 목록을 CSV로 다운로드했어요.');
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
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>이번 기간</div>' +
      '<p class="verdict">' + (idle ? '<em>' + idle + '명</em>이 한 건도 기록하지 않았어요' : '<em>전원 기록</em>했어요') + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">등록 인원</div><div class="v">' + list.length + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">기록 있음</div><div class="v">' + (list.length - idle) + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">기록 없음</div><div class="v' + (idle ? ' alert' : '') + '">' + idle + '<small>명</small></div></div>' +
      '</div></div>';

    h += sect('명단', list.length + '명', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>파트·센터</th><th>이름</th><th>직급</th><th>차량</th><th class="n">운행</th>' +
      '<th class="n">거리</th><th class="n">비용</th></tr></thead><tbody>' +
      orgGroups(list, function (u) { return u.username; }, true).map(function (g) {
        var gi = g.list.filter(function (u) { return !(byU[u.username] || []).length; }).length;
        return orgGroupRow(g, 7, gi ? '<span class="unk">기록 없음 ' + n0(gi) + '명</span>' : '전원 기록') + g.list.map(peopleRow).join('');
      }).join('') + '</tbody></table></div></div>');
    return h;
    function peopleRow(u) {
      return (function () {
        var x = totals(byU[u.username] || [], { who: u.username });   // 영수증만 있는 사람도 금액이 나온다(다른 화면과 같은 기준)
        return '<tr class="clk" tabindex="0" data-person="' + esc(u.username) + '">' + orgCell(u.username, true) +
          // 「관리자」는 맨 끝 빈 칸이 아니라 이름 옆 딱지(2026-10-19 웹 사용성 1차)
          '<td><span class="lead">' + esc(u.name || u.username) + '</span>' + (u.is_admin ? ' <span class="admtag">관리자</span>' : '') +
          '<div class="dim" style="font-size:12px">' + esc(u.username) + '</div></td>' +
          '<td class="dim">' + esc(u.position || '—') + '</td>' +
          '<td class="dim">' + esc(u.plate_no || '—') + '</td>' +
          '<td class="n' + (x.n ? '' : ' dim') + '">' + n0(x.n) + '</td>' +
          '<td class="n">' + (x.km ? km(x.km) : '—') + '</td>' +
          '<td class="n total">' + (x.cost ? n0(x.cost) : '—') + '</td></tr>';
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
      (problem.length ? '<em>' + problem.length + '대</em>에 이상이 있어요' : '<em>이상이 없어요</em>') + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">운행한 차량</div><div class="v">' + plates.length + '<small>대</small></div></div>' +
      '<div class="fact"><div class="k">등록된 차량</div><div class="v">' + VEHICLES.length + '<small>대</small></div></div>' +
      '</div></div>';

    // 2026-10-19 웹 사용성 1차: 「이번 기간에 운행된 차량」·「등록된 차량」 두 표가 같은 차를 되풀이했다 → 표 하나(차종·누적 km 를 합침),
    //   이번 기간에 운행이 없는 등록 차는 아래에 따로 짧게.
    var vOf = {};
    VEHICLES.forEach(function (v) { if (v && v.plate_no && !vOf[v.plate_no]) vOf[v.plate_no] = v; });
    h += sect('차량', plates.length + '대 운행', '',
      plates.length ? '<div class="panel"><div class="scroll" data-rows><table class="mc"><thead><tr>' +
        '<th>번호판</th><th>사용자</th><th>차종</th><th class="n">운행</th><th class="n">거리</th>' +
        '<th class="n">계기판</th><th class="n">누적 km</th><th>비고</th></tr></thead><tbody>' +
        plates.map(function (p) {
          var v = used[p], us = Object.keys(v.users), reg = vOf[p];
          var multi = us.length > 1, wide = isFinite(v.min) && (v.max - v.min) > 10000;
          return '<tr class="clk' + (multi || wide ? ' flagged' : '') + '" tabindex="0" data-car="' + esc(p) + '">' +
            '<td class="m1"><span class="lead">' + esc(p) + '</span></td>' +
            '<td class="m1">' + esc(us.map(nameOf).join(', ')) + '</td>' +
            '<td class="dim mx">' + esc((reg && reg.vehicle_type) || '—') + '</td>' +
            '<td class="n" data-l="운행" data-u="건">' + n0(v.n) + '</td><td class="n mr" data-u="km">' + km(v.km) + '</td>' +
            '<td class="n dim" data-l="계기판">' + (isFinite(v.min) ? n0(v.min) + ' – ' + n0(v.max) : '—') + '</td>' +
            '<td class="n dim mx">' + (reg && reg.cumulative_km != null ? n0(reg.cumulative_km) : '—') + '</td>' +
            '<td class="m2">' + (multi ? '<span class="st bad">사용자 ' + us.length + '명</span> ' : '') +
            (wide ? '<span class="st bad">계기판 폭 ' + n0(v.max - v.min) + 'km</span>' : '') +
            (!multi && !wide ? '<span class="st dim">정상</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>' : blank('운행 기록이 없어요.', null, 'car'));

    var idleCars = VEHICLES.filter(function (v) { return v && v.plate_no && !used[v.plate_no]; })
      .sort(function (a, b) { return (a.plate_no || '').localeCompare(b.plate_no || ''); });
    if (idleCars.length) {
      h += sect('이번 기간 운행 없는 차', idleCars.length + '대', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
        '<th>번호판</th><th>사용자</th><th>차종</th><th class="n">누적 km</th></tr></thead><tbody>' +
        idleCars.map(function (v) {
          return '<tr><td><span class="lead">' + esc(v.plate_no) + '</span></td>' +
            '<td>' + esc(nameOf(v.username)) + '</td>' +
            '<td class="dim">' + esc(v.vehicle_type || '—') + '</td>' +
            '<td class="n">' + n0(v.cumulative_km) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>');
    }
    return h;
  }

  /* ══════════════════ 교육 관리(관리자) — 앱 EduAdminScreen 과 같은 두 탭(2026-10-14) ══════════════════
     ① 영상 관리: 회차(YYYY-MM)별 유튜브 영상 등록·수정·삭제(삭제 = deleted 표시, 시청 이력은 남는다)
     ② 시청 현황: 고른 회차의 대상 / 수료 / 미수료 · 전체 평균 진행률 · 사람별 진행(영상별 %·이월 건수)
     쓰기는 서버 규칙 edu_videos_app_insert/update(관리자만)를 그대로 탄다. */
  function viewEduAdm() {
    if (!LOADED) return head('교육 관리') + skeleton();
    setTimeout(eduEnsureMonth, 0);            // 이번 회차 대상자 스냅샷(아직 없는 사람만) — 앱이 이 화면을 열 때와 같다
    var cur = eduNowKey();
    if (!EDU_ADM.month) EDU_ADM.month = cur;
    var h = head('교육 관리', esc(cur) + ' 회차 · 시청 ' + eduOpenLabel(cur) + '~' + eduDeadlineLabel(cur) + ' · ' + eduDday(cur));
    h += '<div class="bar"><div class="seg" role="group" aria-label="교육 관리">' +
      [['videos', '영상 관리', EDUV.length], ['status', '시청 현황', null]].map(function (t) {
        var on = EDU_ADM.tab === t[0];
        return '<button class="' + (on ? 'on' : '') + '" data-eatab="' + t[0] + '" aria-pressed="' + on + '">' + t[1] +
          (t[2] != null ? ' <span class="c">' + n0(t[2]) + '</span>' : '') + '</button>';
      }).join('') + '</div></div>';
    return h + (EDU_ADM.tab === 'status' ? eduAdmStatus() : eduAdmVideos());
  }
  function eduAdmVideos() {
    var add = '<button class="btn pri sm" data-eduadd>＋ 영상 등록</button>';
    if (!EDUV.length) return sect('영상', '0편', add, blank('등록된 교육 영상이 없어요.', '회차마다 유튜브 영상을 등록해 주세요.', 'play'));
    return sect('영상', EDUV.length + '편', add, '<div class="panel"><div class="scroll" data-rows><table id="eduVT"><thead><tr>' +
      '<th>회차</th><th>제목</th><th class="n"></th></tr></thead><tbody>' +
      EDUV.map(function (v) {
        return '<tr data-eduvrow="' + esc(v.id) + '"><td class="dim" style="white-space:nowrap">' + esc(v.month) + ' 회차' +
          '<div style="font-size:12px">공개 ' + eduOpenLabel(v.month) + ' · 마감 ' + eduDeadlineLabel(v.month) + '</div></td>' +
          '<td><span class="lead">' + esc(v.title) + '</span>' +
          '<div class="dim" style="font-size:12px;word-break:break-all">youtube.com/watch?v=' + esc(v.youtube_id) + '</div>' +
          (v.description ? '<div class="dim" style="font-size:12px">' + esc(v.description) + '</div>' : '') + '</td>' +
          '<td class="n" style="white-space:nowrap"><button class="btn sm" data-eduedit="' + esc(v.id) + '">수정</button> ' +
          '<button class="btn sm" data-edudel="' + esc(v.id) + '" style="color:var(--red)">삭제</button></td></tr>';
      }).join('') + '</tbody></table></div></div>');
  }
  /** 영상 등록·수정 창. v 가 없으면 등록(대상 회차 기본 = 이번 회차). 앱 VideoFormDialog 와 같은 칸·같은 검사. */
  function eduVideoForm(v) {
    var row = function (lab, inner, hint) {
      return '<div class="frow"><label class="flab">' + lab + '</label><div class="fbody">' + inner +
        (hint ? '<div class="fhint">' + hint + '</div>' : '') + '</div></div>';
    };
    openPanel(v ? '영상 수정' : '영상 등록', v ? v.month + ' 회차' : '',
      '<div class="form">' +
      row('제목', '<input class="inp" id="evTitle" autocomplete="off" value="' + esc(v ? v.title : '') + '">') +
      row('YouTube 링크', '<input class="inp" id="evLink" autocomplete="off" inputmode="url" placeholder="https://youtu.be/xxxxx" value="' +
        esc(v ? 'https://youtu.be/' + v.youtube_id : '') + '">', 'youtu.be, youtube.com/watch?v=, shorts 링크나 11자 ID 모두 돼요.') +
      row('대상 회차', '<input class="inp" id="evMonth" autocomplete="off" placeholder="YYYY-MM" value="' + esc(v ? v.month : eduNowKey()) + '">',
        'YYYY-MM · 그달 21일 공개, 다음 달 20일 마감') +
      row('설명', '<textarea class="inp" id="evDesc" rows="3" placeholder="(선택)">' + esc(v ? v.description || '' : '') + '</textarea>') +
      '</div><div id="evErr" class="anote" style="color:var(--red)" role="alert"></div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnEduSave"' + (v ? ' data-id="' + esc(v.id) + '"' : '') + '>저장</button>');
  }
  function eduSaveVideo(id) {
    var t = ($('evTitle') || {}).value || '', link = ($('evLink') || {}).value || '';
    var month = ($('evMonth') || {}).value || '', desc = ($('evDesc') || {}).value || '';
    var yid = parseYoutubeId(link);
    var bad = !t.trim() ? '제목을 입력해 주세요.' : yid == null ? 'YouTube 링크가 올바르지 않아요.'
      : !/^\d{4}-\d{2}$/.test(month) ? '대상 회차는 YYYY-MM 형식으로 입력해 주세요.' : '';
    var e = $('evErr');
    if (bad) { if (e) e.textContent = bad; return; }
    if (e) e.textContent = '';
    var btn = $('btnEduSave'); if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }
    var req = id
      ? apiRetry('/rest/v1/edu_videos?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ title: t.trim(), youtube_id: yid, description: desc.trim(), month: month })
      })
      : apiRetry('/rest/v1/edu_videos', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ month: month, title: t.trim(), youtube_id: yid, description: desc.trim(), created_by: myName() })
      });
    eduAdmWrite(req, id ? '영상을 수정했어요.' : '영상을 등록했어요.', !!id, btn, '저장');
  }
  /** 쓰기 결과 처리 — PATCH 는 고친 줄이 돌아와야 성공(서버 규칙에 걸리면 0줄 200 이 온다). */
  function eduAdmWrite(req, okMsg, needRow, btn, label) {
    req.then(function (r) {
      return (needRow && r.ok ? r.json() : Promise.resolve(null)).then(function (j) {
        return r.ok && (!needRow || (Array.isArray(j) && j.length > 0));
      });
    }).then(function (ok) {
      if (!ok) {
        if (btn) { btn.disabled = false; btn.textContent = label; }
        toast('저장하지 못했어요. 관리자 권한과 네트워크를 확인해 주세요.', true); return;
      }
      closePanel(); toastOk(okMsg); eduReload();
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = label; }
      toast('저장하지 못했어요. 네트워크를 확인해 주세요.', true);
    });
  }
  function eduDelAsk(v) {
    openPanel('영상 삭제', v.month + ' 회차',
      '<div class="anote">‘' + esc(v.title) + '’ 영상을 삭제할까요?<br>시청 기록은 남고, 목록과 의무 시청에서 빠져요.</div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnEduDelGo" data-id="' + esc(v.id) + '">삭제</button>');
  }
  function eduDelVideo(id) {
    var btn = $('btnEduDelGo'); if (btn) { btn.disabled = true; btn.textContent = '삭제 중…'; }
    eduAdmWrite(apiRetry('/rest/v1/edu_videos?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ deleted: true })
    }), '영상을 삭제했어요.', true, btn, '삭제');
  }
  /** 고른 회차의 사람별 집계 — 앱 StatusTab 과 같은 계산(정수 나눗셈·정렬까지). */
  function eduAdmStats(sel) {
    var vids = EDUV.filter(function (v) { return v.month === sel && !v.deleted; });
    var pctBy = {};
    EDUP.forEach(function (p) { (pctBy[p.username] = pctBy[p.username] || {})[p.video_id] = Number(p.progress_pct) || 0; });
    var stats = EDUT.filter(function (t) { return t.month === sel; })
      .sort(function (a, b) { return a.username < b.username ? -1 : a.username > b.username ? 1 : 0; })
      .map(function (tg) {
        var my = pctBy[tg.username] || {};
        var per = vids.map(function (v) { return { v: v, p: my[v.id] || 0 }; });
        var avg = per.length ? Math.floor(per.reduce(function (a, x) { return a + x.p; }, 0) / per.length) : 0;
        // ★ 영상이 0개인 회차는 '수료' 로 세지 않는다(앱 2026-10-01 수정과 같다).
        var done = per.length > 0 && eduMonthDone(sel, my);
        var carry = eduObligations(eduTargetMonths(tg.username), my).filter(function (v) { return v.month !== sel; }).length;
        return { t: tg, avg: avg, done: done, carry: carry, per: per };
      });
    // 미수료 먼저, 그 안에서 진행률 낮은 순(관리자가 챙길 사람이 위로)
    stats.sort(function (a, b) { return (a.done - b.done) || (a.avg - b.avg); });
    return { vids: vids, stats: stats };
  }
  function eduBar(p) {
    var ok = p >= 100;
    return '<span class="edumini"><span class="track' + (ok ? ' ok' : '') + '"><i style="width:' + Math.max(0, Math.min(100, p)) + '%"></i></span>' +
      '<b class="' + (ok ? 'ok' : '') + '">' + p + '%</b></span>';
  }
  function eduAdmStatus() {
    var sel = EDU_ADM.month || eduNowKey();
    var ms = {};
    EDUV.forEach(function (v) { ms[v.month] = 1; }); EDUT.forEach(function (t) { ms[t.month] = 1; });
    var months = Object.keys(ms).sort().reverse();
    if (months.indexOf(sel) < 0) months.unshift(sel);
    var S = eduAdmStats(sel), st = S.stats, vids = S.vids;
    var doneN = st.filter(function (x) { return x.done; }).length;
    var overall = st.length ? Math.floor(st.reduce(function (a, x) { return a + x.avg; }, 0) / st.length) : 0;
    var left = st.length - doneN;

    var pick = '<label class="field edumo"><select class="inp" id="eduAdmMonth" aria-label="회차">' + months.map(function (m) {
      return '<option value="' + esc(m) + '"' + (m === sel ? ' selected' : '') + '>' + esc(m) + ' 회차</option>';
    }).join('') + '</select></label>';
    var note = !vids.length
      ? '<div class="eduwarn" role="alert">⚠ 이 회차에 등록된 영상이 없어요. ‘영상 관리’에서 ' + esc(sel) + ' 회차 영상을 등록해 주세요.</div>'
      : '<div class="dim" style="font-size:12px;margin-bottom:12px">영상 ' + vids.length + '개 · 직전 평가기간(21~20일) 평균 ' + EDU_THRESHOLD + '점 미만 대상</div>';
    var h = '<div class="bar">' + pick + '</div>' + note;
    var clean = st.length > 0 && vids.length > 0 && !left;
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"' + (clean ? ' style="background:var(--ok)"' : '') + '></span>' +
      esc(sel) + ' 회차 시청 현황</div>' +
      '<p class="verdict' + (clean ? ' clean' : '') + '">' +
      (!st.length ? '이 달의 교육 대상자가 없어요' : !vids.length ? '영상이 없어 수료를 판단할 수 없어요'
        : left ? '<em>' + left + '명</em>이 아직 수료하지 않았어요' : '<em>전원 수료</em>했어요') + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">대상</div><div class="v" id="eduNT">' + st.length + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">수료</div><div class="v" id="eduND" style="color:var(--ok)">' + doneN + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">미수료</div><div class="v' + (left ? ' alert' : '') + '" id="eduNL">' + left + '<small>명</small></div></div>' +
      '<div class="fact"><div class="k">전체 평균 진행률</div><div class="v" id="eduNA">' + overall + '<small>%</small></div>' +
      (st.length && vids.length ? '<div class="sub">수료율 ' + Math.floor(doneN * 100 / st.length) + '%</div>' : '') + '</div>' +
      '</div><div class="track' + (overall >= 100 ? ' ok' : '') + '"><i style="width:' + Math.min(100, overall) + '%"></i></div></div>';
    if (!st.length) return h + blank('이 달의 교육 대상자가 없어요.', '직전 평가기간 평균 ' + EDU_THRESHOLD + '점 미만인 직원이 대상이에요.', 'cap');
    h += sect('대상자', st.length + '명', '', '<div class="panel"><div class="scroll" data-rows><table id="eduST"><thead><tr>' +
      '<th>소속</th><th>이름</th><th class="n">전월</th><th>진행률</th><th>상태</th><th>영상별</th></tr></thead><tbody>' +
      st.map(function (x) {
        var u = USERS[x.t.username] || {};
        var badge = !x.per.length ? '<span class="st dim">영상 없음</span>'
          : x.done ? '<span class="st ok">수료</span>' : '<span class="st bad">미수료</span>';
        return '<tr data-eduu="' + esc(x.t.username) + '"' + (x.done ? '' : ' class="flagged"') + '>' +
          orgCell(x.t.username) + '<td><span class="lead">' + esc(u.name || x.t.username) + '</span></td>' +
          '<td class="n"' + (x.t.avg_score < 70 ? ' style="color:var(--red)"' : '') + '>' + n0(x.t.avg_score) + '점</td>' +
          '<td>' + eduBar(x.avg) + '</td>' +
          '<td style="white-space:nowrap">' + badge + (x.carry > 0 ? ' <span class="edutag carry">이월 ' + x.carry + '건</span>' : '') + '</td>' +
          '<td>' + x.per.map(function (pv) {
            var ok = pv.p >= 100;
            return '<div class="eduvl' + (ok ? ' ok' : '') + '"><span>' + (ok ? '✅' : '▸') + '</span><span class="t">' + esc(pv.v.title) +
              '</span><b>' + pv.p + '%</b></div>';
          }).join('') + '</td></tr>';
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
    var h = head(isAll() ? '하이패스 대조 (전체)' : '하이패스 이용내역',
      isAll() ? '하이패스 이용내역 PDF로 전 직원 통행료를 확정해요.'
              : 'PDF를 올리면 통과 시각으로 맞는 운행을 찾아 줘요. 확정하면 그날 통행료 증빙이 돼요.');
    if (isMulti()) return singleOnly(isAll() ? '하이패스 대조 (전체)' : '하이패스 대조', '하이패스 대조');

    // ★ 개인 화면에서 내 주기가 결재 완료면 서버가 전부 튕긴다. 먼저 말한다.
    //   (전체 화면은 사람마다 다르므로 묶음 줄에서 따로 표시한다.)
    if (!isAll() && cycleLocked(myName())) {
      return h + lockedNote(lockTitle(myName()),
        '이 기간은 통행료를 바꿀 수 없고, 영수증을 올려도 반영되지 않아요. ' + lockHow(myName()));
    }

    var T = totals(TRIPS);
    if (LOADED && T.unk) {
      h += '<div class="hpnote">' + ic('ticket', 16) +
        '<span>이번 기간에 <b>통행료 미확정 ' + n0(T.unk) + '건</b>이 있어요. ' +
        '채우지 않으면 0원으로 정산돼요.</span></div>';
    }

    h += '<div class="drop" id="hpDrop">' +
      '<div class="dico">' + ic('receipt', 22) + '</div>' +
      '<div class="dt">하이패스 이용내역 PDF를 여기에 끌어다 놓으세요</div>' +
      '<div class="dd">한국도로공사 하이패스 누리집 › 이용내역에서 PDF로 다운로드할 수 있어요. 영수증 출력 화면을 PDF로 저장한 파일도 되고, 여러 개를 함께 올려도 돼요.</div>' +
      '<label class="btn" style="margin-top:14px">파일 고르기' +
      '<input type="file" id="hpFile" accept="application/pdf,.pdf" multiple class="sr"></label>' +
      '</div>';

    if (HP.note) h += '<div class="hpnote' + (HP.noteBad ? ' warn' : '') + '">' +
      ic(HP.noteBad ? 'alert' : 'check', 16) + '<span>' + esc(HP.note) + '</span></div>';
    // 원본 PDF 를 보관하지 못했을 때만(2026-10-23 hpKeep) — 맞추기·확정은 그대로 된다
    if (HP.keepNote) h += hpKeepHtml();
    if (!HP.groups.length) return h;

    HP.groups.forEach(function (g, gi) {
      var picked = (g.matched || []).filter(function (e) { return e.pick; });
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

      // 맞는 운행을 못 찾은 기록 — 지금 보는 기간 안의 것과 밖의 것을 나눈다(2026-10-20 AU2 #7).
      //   기간 밖 기록(마감 뒤 5일 동안 10월분 화면에 10.22 기록이 든 PDF 를 올린 경우 등)의 운행은 다른 기간에 이미 있을 수 있다 —
      //   예전처럼 「운행을 먼저 넣으면 맞춰집니다」라고 하면 같은 운행을 또 넣게 된다. 그 기간 화면에서 올리라고 한다.
      var unIn = (g.unmatched || []).filter(hpInView), unOut = (g.unmatched || []).filter(function (r) { return !hpInView(r); });
      var unHtml = (unIn.length ? '<details class="hpun"><summary>맞는 운행을 못 찾은 기록 ' +
          n0(unIn.length) + '건</summary><div class="hpunb">' +
          unIn.slice(0, 60).map(function (r) {
            return '<div><span class="mono">' + esc(r.atText) + '</span> ' +
              esc(r.office || '') + ' <b>' + n0(r.amount) + '</b></div>';
          }).join('') +
          '<p class="fhint">그 시각에 이 차량의 운행 기록이 없어요. 운행을 먼저 넣으면 맞춰져요.</p>' +
          '</div></details>' : '') +
        (unOut.length ? '<details class="hpun hpout" data-hpout><summary>이 기간 밖의 기록 ' + n0(unOut.length) +
          '건은 그 기간 화면에서 올려 주세요</summary><div class="hpunb">' +
          unOut.slice(0, 60).map(function (r) {
            return '<div><span class="mono">' + esc(r.atText) + '</span> ' + esc(r.office || '') + ' <b>' + n0(r.amount) + '</b>' +
              ' <span class="dim">' + esc(hpCycName(r)) + '</span></div>';
          }).join('') +
          '<p class="fhint">이 기록의 운행은 지금 보는 기간(' + esc(viewSpan()) + ')이 아니라 ' +
          esc(unOut.map(hpCycName).filter(function (v, i, a) { return v && a.indexOf(v) === i; }).join('·') || '다른 기간') +
          '에 있을 수 있어요. 운행을 새로 넣지 말고 그 기간 화면에서 이 PDF를 올려 주세요.</p>' +
          '</div></details>' : '');

      if (!g.plate) {
        h += blank('차량을 골라 주세요.', '어느 차의 카드인지 골라야 운행과 맞출 수 있어요.', 'car');
      } else if (!(g.matched || []).length) {
        h += unOut.length && !unIn.length
          ? blank('이 기간에 맞는 운행이 없어요.', '이 카드의 기록 ' + n0(unOut.length) + '건이 모두 지금 보는 기간(' + viewSpan() + ') 밖이에요. 그 기간 화면에서 올려 주세요.', 'ticket')
          : blank('맞는 운행이 없어요.', '통과 시각이 이 차량의 운행 시간 안에 들지 않아요.', 'ticket');
        h += unHtml;
      } else if (!todo.length) {
        // 전부 맞은 상태. 여기서 표를 그대로 두면 '아직 할 일이 있다' 로 읽힌다.
        h += '<div class="panel"><div class="blank"><div class="ico" style="color:var(--ok)">' +
          ic('check', 21) + '</div><div class="t">이 카드는 다 확정됐어요.</div>' +
          '<div class="d">' + n0(done.length) + '건 모두 영수증 금액과 같아요. 이제 통행료로 돌아가세요.</div></div></div>';   // 돌아가는 단추는 맨 아래 하나(2026-10-15 2차)
        h += unHtml;
      } else {
        var allOn = todo.length && todo.every(function (x) { return x.pick || x.locked; });
        // 폰(≤600px)에서는 줄마다 두 줄 카드(table.mc — 2026-10-20 폰 마무리: 차이 칸이 오른쪽에서 잘렸다).
        //   표 머리가 숨으므로 「전부 고르기」는 표 위 한 줄(같은 data-hpall — 같은 처리기).
        h += '<div class="mselallm hptab"><label class="mselhit wide"><input type="checkbox" data-hpall="' + gi + '"' + (allOn ? ' checked' : '') + '>' +
          '<span>이 카드의 운행 전부 고르기</span></label></div>' +
          '<div class="panel"><div class="scroll" data-rows><table class="mc hptab"><thead><tr>' +
          '<th style="width:36px"><input type="checkbox" data-hpall="' + gi + '"' +
          (allOn ? ' checked' : '') +
          ' aria-label="이 카드의 운행 전부 고르기"></th>' +
          '<th>운행</th><th>지금 값</th><th class="n">영수증</th><th class="n">차이</th><th>영수증 내역</th>' +
          '</tr></thead><tbody>';
        todo.forEach(function (e) {
          var ei = g.matched.indexOf(e);          // 체크박스 키는 원래 자리를 쓴다
          var t = e.trip;
          // 원본만 붙이기(keep, 2026-10-23) — 이미 하이패스로 맞춘 금액 그대로 · 원본 PDF 만 붙인다
          var keep = e.kind === 'keep';
          var now = keep ? '<span class="st ok">확정 ' + n0(t.toll_cost) + '</span>'
            : e.kind === 'new' ? '<span class="st warn">미확정</span>'
            : (e.who === 'person'
              ? '<span class="st bad">직접 넣은 ' + n0(t.toll_cost) + '</span>'
              : '<span class="dim">자동 ' + n0(t.toll_cost) + '</span>');
          var diff = keep ? '<span class="st ok">그대로</span>'
            : e.diff == null ? '<span class="dim">—</span>'
            : e.diff === 0 ? '<span class="st ok">같음</span>'
              : '<b style="color:' + (e.diff > 0 ? 'var(--ok)' : 'var(--red)') + '">' +
                (e.diff > 0 ? '+' : '') + n0(e.diff) + '</b>';
          h += '<tr class="' + (e.kind === 'diff-person' ? 'flagged' : '') + '"' + (keep ? ' data-hpkeep' : '') + '>' +
            '<td class="m1 hpck"><label class="mselhit"><input type="checkbox" data-hppick="' + gi + '.' + ei + '"' +
            ' aria-label="' + esc(md(t.start_time) + ' ' + hm(t.start_time) + (keep ? ' 운행 원본 붙이기' : ' 운행 확정하기')) + '"' +
            (e.pick ? ' checked' : '') +
            (e.locked ? ' disabled title="결재가 끝난 운행이라 바꿀 수 없어요."' : '') + '></label></td>' +
            '<td class="m1 hpwhen"><span class="lead">' + md(t.start_time) + '</span> <span class="dim">' +
            hm(t.start_time) + '–' + (t.end_time ? hm(t.end_time) : '') + '</span>' +
            (isAll() ? ' <span class="dim">' + esc(nameOf(t.username)) + '</span>' : '') +
            // 원본만 붙이기 — 폰에서도 보이게 운행 칸에(차이 칸은 「그대로」)
            (keep ? '<div class="hpkeepl" data-hpkeepl>원본만 붙이기 — 금액은 그대로</div>' : '') +
            // 같은 날 같은 금액 통행료 영수증 사진이 이미 있으면(웹 8차 — 확정해도 두 번 세지 않는다). 폰에서도 보이게 운행 칸에
            (hpSamePhoto(t, e.sum) ? '<div class="hpphoto" data-hpphoto>같은 날 같은 금액 영수증 사진도 있어요. 확정해도 정산은 한 번만 돼요.</div>' : '') + '</td>' +
            '<td data-l="지금">' + (e.locked ? '<span class="st ok">결재 완료</span>' : now) + '</td>' +
            '<td class="n lead mr" data-u="원">' + n0(e.sum) + '</td>' +
            '<td class="n" data-l="차이">' + diff + '</td>' +
            '<td class="el dim m2" title="' + esc(e.lines.map(function (r) {
              return r.atText + ' ' + r.office + ' ' + n0(r.amount);
            }).join(' / ')) + '">' +
            esc(e.lines.map(function (r) { return r.office + ' ' + n0(r.amount); }).join(' · ')) + '</td></tr>';
        });
        h += '</tbody></table></div></div>';

        if (done.length) {
          h += '<details class="hpun"><summary>이미 확정된 ' + n0(done.length) +
            '건은 영수증과 같아 고칠 것이 없어요</summary><div class="hpunb">' +
            done.slice(0, 60).map(function (e) {
              return '<div><span class="mono">' + md(e.trip.start_time) + ' ' + hm(e.trip.start_time) +
                '</span> ' + esc(dong(e.trip.start_address)) + ' → ' + esc(dong(e.trip.end_address)) +
                ' <b>' + n0(e.sum) + '</b></div>';
            }).join('') + '</div></details>';
        }

        h += unHtml;

        h += '<div class="hpact">' +
          '<span class="dim" id="hpSum' + gi + '">' + hpSumHtml(g) + '</span>' +
          '<button class="btn pri" data-hpapply="' + gi + '"' + (picked.length ? '' : ' disabled') + '>' +
          hpBtnText(picked) + '</button></div>';
      }
      h += '</section>';
    });
    return h;
  }

  /** 하이패스 기록이 지금 보는 기간 안인가(2026-10-20 AU2 #7). 시각을 못 읽은 기록은 안으로 친다(예전과 같은 안내). */
  function hpInView(r) { var vr = viewRange(), t = Number(r && r.at); return !isFinite(t) || (t >= vr.lo && t < vr.hi); }
  /** 그 기록이 드는 운행일지 기간 이름 — 「2026년 11월분」. */
  function hpCycName(r) { var t = Number(r && r.at); if (!isFinite(t)) return ''; var c = cycleOfMs(t); return cycleName(c); }
  /** 그 운행 날에 금액이 같은 통행료 영수증(올린 것)이 있는가 — 하이패스 표의 안내 한 줄(웹 8차). */
  function hpSamePhoto(t, amt) {
    var day = ymd(t.start_time);
    return EVID.some(function (e) {
      return e.username === t.username && e.category === '통행료' && Math.round(Number(e.amount) || 0) === Math.round(Number(amt) || 0) &&
        (e.trip_id != null ? String(e.trip_id) === String(t.id) : ymd(Number(e.date_millis)) === day);
    });
  }

  /* ── 하이패스 이용내역 PDF 원본 보관(2026-10-23 사용자 「하이패스 이용내역 PDF 원본도 앞으로 보관」) ──
     예전에는 PDF 를 브라우저가 읽기만 하고 버려 결재 문서에 하이패스 통행료의 근거가 하나도 안 실렸다(저장소에 PDF 0개).
     이제 기록을 읽은 PDF 만 증빙 저장소(evidence)에 올린다 — <내 아이디>/hipass/<파일 시각 KST YYYYMMDD-HHmmss>-<SHA-256 앞 16자>.pdf
     (파일 시각 = 고른 파일의 lastModified — 같은 파일은 늘 같은 경로라, 이미 있으면 다시 올리지 않고 그대로 쓴다).
     확정(toll-apply)할 때 줄마다 그 줄이 나온 PDF 의 경로를 pdf 로 실어 보낸다(page 는 그 PDF 안 쪽 번호) — 서버는 내 폴더의 경로만 남기고,
     상신 때 결재본에 굳히고 그 PDF 를 지우거나 덮어쓰지 못하게 막는다. 결재 문서 출력이 맨 뒤에 원본 쪽을 붙인다.
     보관에 실패해도(15MB 넘음 · 저장소가 PDF 를 안 받음 · 네트워크) 맞추기·확정은 그대로 — 안내만 한다(그 줄에 pdf 가 없을 뿐). */
  var HP_PDF_MAX = 15 * 1024 * 1024;
  var HP_KEEP_FAIL = '원본 PDF를 보관하지 못했어요. 맞춘 금액은 그대로 저장돼요.';
  var HP_KEEP_BIG = '원본 PDF가 15MB를 넘어 보관하지 않았어요. 맞춘 금액은 그대로 저장돼요.';
  function hpHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }
  /** 저장소 주소의 경로 — 조각마다 인코딩 */
  function hpObj(path) { return String(path).split('/').map(encodeURIComponent).join('/'); }
  /** PDF 하나 올리기 → 그 경로 · 이미 있으면(같은 파일을 전에 올림) 덮지 않고 그대로 쓴다 · 못 올리면 거절.
   *  x-upsert 없이 올린다 — 있는 객체면 저장소가 「Duplicate」(409)로 거절한다. 결재본이 가리키는 경로는 새로 넣기가 막혀(403 — driving_photo_frozen)
   *  그때만 있는지 물어본다(내 폴더는 볼 수 있다 — evidence web select). */
  function hpPut(path, file) {
    var at = hpObj(path), why = function (st, t) { return new Error('HTTP ' + st + ' ' + String(t || '').slice(0, 160)); };
    return apiRetry('/storage/v1/object/evidence/' + at, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: file
    }).then(function (up) {
      if (up.ok) return path;
      return up.text().then(function (t) {
        if (up.status === 409 || /duplicate|already exists/i.test(t || '')) return path;
        if (up.status === 403 || /"403"|row-level security|unauthorized/i.test(t || '')) {
          return apiRetry('/storage/v1/object/authenticated/evidence/' + at, { method: 'HEAD' })
            .then(function (h) { if (h.ok) return path; throw why(up.status, t); });
        }
        throw why(up.status, t);
      });
    });
  }
  /** 고른 PDF(files — 배열) 중 기록을 읽은 것(lists[fi])만 차례로 올린다 → { paths: [파일 차례] → 경로|null, fail, big }. 늘 끝난다(거절하지 않는다). */
  function hpKeep(files, lists) {
    var me = myName(), out = { paths: [], fail: 0, big: 0 };
    var can = !!(window.crypto && window.crypto.subtle && window.Hipass && window.Hipass.keepPath);   // 안전하지 않은 주소(http)면 지문을 못 낸다
    return files.reduce(function (chain, f, fi) {
      return chain.then(function () {
        out.paths[fi] = null;
        if (!(lists[fi] && lists[fi].length)) return;              // 못 읽은 파일·기록 없는 파일은 올리지 않는다
        if (!can) { out.fail++; return; }
        if (f.size > HP_PDF_MAX) { out.big++; return; }
        return f.arrayBuffer().then(function (buf) { return window.crypto.subtle.digest('SHA-256', buf); })
          .then(function (h) {
            var lm = Number(f.lastModified);
            // 경로 꼴은 hipass.js keepPath 하나(서버 toll-apply 가 같은 꼴만 받는다 — web/test/hipass-keep.test.mjs)
            var path = window.Hipass.keepPath(me, isFinite(lm) && lm > 0 ? lm : Date.now(), hpHex(h));
            if (!path) throw new Error('이 아이디로는 저장소 경로를 만들 수 없어요');
            return hpPut(path, f);
          })
          .then(function (p) { out.paths[fi] = p; }, function (e) { out.fail++; console.warn('하이패스 PDF 보관 못 함:', f.name, e && e.message); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }
  function hpKeepHtml() {
    return '<div class="hpnote warn" id="hpKeep" role="status">' + ic('alert', 16) + '<span>' + esc(HP.keepNote) + '</span></div>';
  }
  /** 보관이 끝나면 — 못 했을 때만 하이패스 화면 안내 줄(HP.note) 아래에 한 줄(다시 그리지 않고 끼운다 — 고른 것·스크롤 그대로) */
  function hpKeepDone(job, r) {
    if (HP.pdfJob !== job) return;                                    // 그 사이 다른 PDF 를 올렸거나 화면이 바뀌었다
    HP.pdfDone = true;
    HP.keepNote = r.fail ? HP_KEEP_FAIL : r.big ? HP_KEEP_BIG : '';
    var drop = $('hpDrop');
    if (!HP.keepNote || !drop || $('hpKeep')) return;
    var nx = drop.nextElementSibling, at = nx && nx.classList.contains('hpnote') ? nx : drop;
    var el = document.createElement('div'), sp = document.createElement('span');
    el.className = 'hpnote warn'; el.id = 'hpKeep'; el.setAttribute('role', 'status');
    el.innerHTML = ic('alert', 16);                                   // 아이콘(고정 SVG)만 — 글은 textContent
    sp.textContent = HP.keepNote; el.appendChild(sp);
    at.parentNode.insertBefore(el, at.nextSibling);
    toast(HP.keepNote);
  }
  /** 그 줄의 원본 PDF — 그 기록이 든 파일 중 보관한 첫 파일의 { pdf, page } · 없으면 null */
  function hpSrcOf(r, paths) {
    var src = r.srcs || [];
    for (var i = 0; i < src.length; i++) if (paths[src[i].fi]) return { pdf: paths[src[i].fi], page: src[i].page };
    return null;
  }

  /* ── 이미 맞춘 운행에 원본만 붙이기(2026-10-23 관리자 「영수증은 없고 내역만 있으면 안 된다」 · 사용자 「이미 맞춘 운행에 PDF 를 다시 올리면 원본이 붙게」) ──
     원본 보관(hpKeep) 전에 맞췄거나 보관을 못 한 운행은 이용내역 줄에 pdf 가 없다. 같은 PDF 를 다시 올리면 「이미 하이패스로 맞춘 값」(same)이라
     아무것도 안 보내 원본이 영영 안 붙었다. 이제 같음(same) 운행 중 내 운행·안 잠긴 것은 근거(toll_evidence_json — 운행 목록에는 없어 따로 받는다)를 보고,
     읽은 기록과 같은 줄에 pdf 가 없으면 「원본만 붙이기 — 금액은 그대로」(keep)로 바꿔 기본으로 고른다(hipass.js needPdf — 서버와 같은 짝짓기).
     확정하면 그 줄만 toll-apply 원본 붙이기(attach)로 보낸다 — 서버는 pdf·page 만 넣는다(금액·상태·출처·하이패스 몫 그대로).
     ★ 내 운행만: 결재 문서 출력은 그 문서 주인 폴더의 원본만 싣는다 — 관리자가 남의 운행에 자기 폴더 원본을 붙이면 문서에 안 실리고
       그 줄은 「원본 있음」이 돼 주인이 올려도 못 붙인다(서버도 막는다). 잠긴 운행은 예전처럼 손대지 않는다.
     2026-10-23 오후: 서버는 관리자 「하이패스 대조 (전체)」 확정(items)에서도 남의 운행 줄의 pdf 를 버린다(toll-apply evidence.ts) ·
       줄에 운행 주인 폴더의 원본이 아닌 pdf(그 전에 남은 관리자 폴더 경로 등)가 있으면 「없음」으로 보고 주인이 다시 올리면 바꿔 넣는다 ·
       출구 글은 끝이 같으면 같은 영업소(PDF 꼴마다 다르다) — hipass.js needPdf(운행 주인 아이디를 넘긴다)와 서버 attachPdf 가 같은 규칙. */
  var HP_ATTACH_NOPATH = '원본을 보관하지 못해 첨부하지 못했어요. 다시 올려 주세요';
  // 30초를 기다려도 원본 보관(hpKeep)이 안 끝났다 — 실패가 아니라 아직 올리는 중이다(2026-10-23 오후). 그 줄은 고른 채 두고 다시 누르게 한다.
  var HP_ATTACH_SLOW = '원본 PDF를 아직 보관하는 중이에요. 잠시 후 ‘원본 붙이기’를 다시 눌러 주세요';
  /** 이미 맞춘(same) 내 운행·안 잠긴 것의 근거를 받아 HP.ej 에 둔다(이미 받은 운행은 다시 안 받는다).
   *  → Promise<참|거짓>(하나라도 못 받으면 거짓 — 그 운행은 same 그대로, 거절하지 않는다). */
  function hpScanKeep(groups) {
    var me = myName(), cache = HP.ej = HP.ej || {}, ids = [];
    (groups || []).forEach(function (g) {
      (g.matched || []).forEach(function (e) {
        var id = e.trip && e.trip.id;
        if (e.kind !== 'same' || e.locked || !me || id == null || e.trip.username !== me) return;
        if (Object.prototype.hasOwnProperty.call(cache, String(id)) || ids.indexOf(id) >= 0) return;
        ids.push(id);
      });
    });
    var parts = [];
    for (var i = 0; i < ids.length; i += 80) parts.push(ids.slice(i, i + 80));
    return Promise.all(parts.map(function (part) {
      return apiRetry('/rest/v1/trips?select=id,toll_evidence_json&id=in.(' + part.map(function (x) { return encodeURIComponent(String(x)); }).join(',') + ')')
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (rows) {
          (Array.isArray(rows) ? rows : []).forEach(function (x) { if (x && x.id != null) cache[String(x.id)] = x.toll_evidence_json; });
          return true;
        }, function (e) { console.warn('하이패스 — 이미 맞춘 운행의 근거를 받지 못함:', e && e.message); return false; });
    })).then(function (oks) { return oks.every(Boolean); });
  }
  /** 받아 둔 근거로 — 같음(same) 내 운행·안 잠긴 것 중 원본 없는 같은 줄이 있으면 keep 으로 바꾸고 고른다(e.need = 붙일 기록). 늘 잠금 표시(hpMarkLocked) 뒤에. */
  function hpMarkKeep(groups) {
    var me = myName(), cache = HP.ej || {};
    (groups || []).forEach(function (g) {
      (g.matched || []).forEach(function (e) {
        if (e.kind !== 'same' || e.locked || !me || !e.trip || e.trip.username !== me) return;
        var k = String(e.trip.id);
        if (!Object.prototype.hasOwnProperty.call(cache, k) || !window.Hipass.needPdf) return;
        // 운행 주인(= 나) 폴더의 원본이 있는 줄만 「있음」 — 남의 폴더 경로는 「없음」이라 다시 붙인다(2026-10-23 오후, 서버 attachPdf 와 같은 owner)
        var need = window.Hipass.needPdf(cache[k], e.lines, e.trip.username);
        if (need.length) { e.kind = 'keep'; e.pick = true; e.need = need; }
      });
    });
    return groups;
  }
  function hpKeepCount(groups) {
    return (groups || []).reduce(function (s, g) { return s + (g.matched || []).filter(function (e) { return e.kind === 'keep'; }).length; }, 0);
  }
  /** 확정 단추 글 — 금액을 맞추는 것만이면 예전 그대로 「N건 확정하기」, 원본만 붙이는 것(keep)이 있으면 따로 센다. */
  function hpBtnText(picked) {
    var k = picked.filter(function (e) { return e.kind === 'keep'; }).length, n = picked.length - k;
    return !k ? n0(n) + '건 확정하기' : !n ? n0(k) + '건 원본 붙이기' : n0(n) + '건 확정 · 원본 ' + n0(k) + '건 붙이기';
  }
  /** 카드 아래 한 줄 — 남은 것 · 선택 · 합계(금액을 맞추는 것만 — 원본만 붙이는 것은 금액이 그대로라 따로 센다) */
  function hpSumHtml(g) {
    var picked = (g.matched || []).filter(function (m) { return m.pick; });
    var todo = (g.matched || []).filter(function (m) { return !hpDone(m); });
    var keep = picked.filter(function (m) { return m.kind === 'keep'; }).length;
    // ★ 금액은 m.sum 이다. 예전에는 m.amount 를 더해서(그런 필드가 없다) 체크를 아무리 해도 합계가 늘 ₩0 으로 보였다.
    var sum = picked.reduce(function (a, m) { return a + (m.kind === 'keep' ? 0 : (Number(m.sum) || 0)); }, 0);
    return '남은 것 <b>' + n0(todo.length) + '건</b> · 선택 <b>' + n0(picked.length) + '건</b>' +
      (!keep || picked.length > keep ? ' · 합계 ' + won(sum) : '') +             // 원본만 붙이기뿐이면 합계(₩0)는 빼고
      (keep ? ' · 원본만 붙이기 <b>' + n0(keep) + '건</b>(금액 그대로)' : '');
  }
  /** 확정이 다 된 뒤 한 줄 — 금액 확정만이면 예전 글 그대로. back = 통행료 차례로 돌아갈 때 */
  function hpOkMsg(a, k, back) {
    if (!k) return a + '건을 확정했어요.' + (back ? ' 통행료에 반영됐어요.' : '');
    if (!a) return '금액은 그대로 두고 원본 ' + k + '건을 첨부했어요.';
    return a + '건을 확정하고 원본 ' + k + '건을 첨부했어요.' + (back ? ' 통행료에 반영됐어요.' : '');
  }

  function hpFiles(files) {
    // ★ 운행을 다 못 받은 상태로 대조하면 "맞는 운행이 없습니다" 가 되고,
    //   로드가 끝나도 다시 맞추지 않아 PDF 를 또 올려야 했다.
    if (!LOADED) { toast('운행을 불러오는 중이에요. 잠시 후 다시 올려 주세요.'); return; }
    if (!files || !files.length) return;
    files = Array.prototype.slice.call(files);   // 고른 파일을 붙잡아 둔다 — 원본 보관(hpKeep)이 나중에 다시 읽는다
    if (!window.Hipass) { toast('PDF 읽기 도구를 불러오지 못했어요. 새로고침한 뒤 다시 올려 주세요.', true); return; }
    // 사진만 골랐으면 읽지 말고 어디로 올리는지 알려 준다(웹 8차)
    if (!Array.prototype.some.call(files, function (f) { return /pdf/i.test(f.type || '') || /pdf$/i.test(f.name || ''); })) {
      HP.noteBad = true; HP.groups = [];
      HP.note = '여기는 하이패스 이용내역 PDF만 올릴 수 있어요. 영수증 사진은 통행료 화면에서 올려 주세요.';
      render(); return;
    }
    HP.busy = true; HP.note = 'PDF를 읽는 중…';
    HP.pdfJob = null; HP.pdfDone = false; HP.keepNote = '';         // 앞서 올린 PDF 의 보관 일은 버린다(그 기록도 새로 읽는다)
    HP.ej = {};                                                       // 이미 맞춘 운행의 근거(원본 붙이기, 2026-10-23)도 새로 받는다
    render();
    var lists = [], recs = [], done = 0, bad = 0, warns = [], dup = 0;
    Array.prototype.forEach.call(files, function (f, fi) {
      f.arrayBuffer().then(function (buf) {
        return window.Hipass.parsePdf(buf, { pdfjs: loadPdfJs });   // 「영수증 출력」 화면을 인쇄해 저장한 PDF 는 pdf.js 로 읽는다
      }).then(function (rs) {
        lists[fi] = rs || []; if (rs && rs.warning) warns.push(rs.warning);
      }).catch(function (e) { bad++; console.error(f.name, e); })
        .then(function () {
          if (++done < files.length) return;
          HP.busy = false;
          // 기록마다 그 기록이 든 파일과 그 파일 안 쪽 번호(원본 보관 — 확정할 때 줄의 pdf·page). 겹친 기록은 든 파일 모두를 차례대로.
          var srcOf = {}, rk = window.Hipass.recKey || function (r) { return r.at + '|' + r.amount + '|' + (r.office || '') + '|' + (r.card4 || ''); };
          lists.forEach(function (rs, fi) {
            (rs || []).forEach(function (r) { var k = rk(r); (srcOf[k] = srcOf[k] || []).push({ fi: fi, page: r.page }); });
          });
          // 파일끼리 겹친 기록은 한 번만(2026-10-20 AU2 — 기간이 겹치는 두 파일·같은 파일 두 번이면 통행료가 두 배로 확정됐다).
          //   열쇠: 통과 시각·금액·영업소·카드 끝 4자리(hipass.js mergeFiles · recKey). 파일 하나 안의 겹침은 읽을 때 이미 뺐다.
          var mg = window.Hipass.mergeFiles ? window.Hipass.mergeFiles(lists) : { recs: [].concat.apply([], lists.filter(Boolean)), removed: 0 };
          recs = mg.recs; dup = mg.removed;
          recs.forEach(function (r) { r.srcs = srcOf[rk(r)] || []; });
          if (dup) toast('여러 파일에 겹친 기록 ' + n0(dup) + '건은 한 번만 계산해요.');
          if (!recs.length) {
            HP.noteBad = true;
            HP.note = bad ? '읽지 못한 파일이 있어요. 한국도로공사 이용내역 PDF가 맞는지 확인하고, 영수증 사진은 ‘영수증 사진 올리기’로 올려 주세요.'
              : 'PDF에서 통행 기록을 찾지 못했어요.';
            HP.groups = []; render(); return;
          }
          HP.groups = hpMarkLocked(window.Hipass.match(recs, TRIPS));
          HP.batch = 'web-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
          // 원본 보관을 시작한다(기다리지 않는다 — 확정할 때 끝나기를 기다린다). 못 하면 안내 한 줄(hpKeepDone).
          var job = HP.pdfJob = hpKeep(files, lists);
          job.then(function (r) { hpKeepDone(job, r); });
          HP.noteBad = !!bad || warns.length > 0;
          // 지금 보는 기간 밖의 기록 수(2026-10-20 AU2 #7) — 그 기간 화면에서 올리라고 한 줄 더한다(카드마다 아래 「이 기간 밖의 기록」에 목록)
          var nOut = recs.filter(function (r) { return !hpInView(r); }).length;
          // 다음에 할 일까지 한 줄로(웹 8차 — 「확정하기」를 눌러야 증빙이 된다는 것을 몰랐다)
          var base = n0(recs.length) + '건을 읽었어요.' + (dup ? ' 여러 파일에 겹친 ' + n0(dup) + '건은 뺐어요.' : '') + (bad ? ' 읽지 못한 파일이 ' + bad + '개 있어요.' : '') + (warns.length ? ' ' + warns.join(' ') : '') +
            (nOut ? ' 지금 보는 기간(' + viewSpan() + ') 밖의 기록 ' + n0(nOut) + '건은 그 기간 화면에서 올려 주세요.' : '');
          var how = isAll() ? '' : ' 운행이 맞으면 ‘확정하기’를 눌러 주세요. 확정하면 그날 통행료 증빙이 돼요.';
          HP.note = base + how;
          // 이미 맞춘 운행 중 원본이 없는 것 → 「원본만 붙이기」(2026-10-23). 근거를 받은 뒤에 그린다 —
          //   먼저 그리면 「이 카드는 다 확정됐습니다」가 보였다가 표로 바뀐다(받는 동안은 「읽는 중」 그대로 · 10초가 넘으면 기다리지 않는다).
          var hp0 = HP, grs = HP.groups;
          Promise.race([hpScanKeep(grs), new Promise(function (ok) { setTimeout(function () { ok(false); }, 10000); })]).then(function (ok) {
            if (HP !== hp0 || HP.groups !== grs) return;              // 그 사이 다른 PDF 를 올렸거나 기간을 바꿨다
            hpMarkKeep(grs);
            var nk = hpKeepCount(grs), nfix = grs.reduce(function (s, g) { return s + (g.matched || []).filter(function (e) { return !hpDone(e) && e.kind !== 'keep'; }).length; }, 0);
            // 원본만 붙이기뿐이면 「확정하기」 대신 그 단추 이름으로
            if (nk) HP.note = base + (nfix ? how : '') + ' 이미 맞춘 운행 ' + n0(nk) + '건은 금액을 그대로 두고 원본 PDF만 첨부해요' +
              (nfix || isAll() ? '.' : '. ‘원본 붙이기’를 눌러 주세요.');
            if (!ok) { HP.noteBad = true; HP.note += ' 이미 맞춘 운행에 원본이 첨부돼 있는지 확인하지 못했어요. 다시 올려 주세요.'; }
            render();
          });
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
      toast(anyLocked ? '고른 운행이 없어요. 결재가 끝난 운행은 바꿀 수 없어요.'
                      : '확정할 운행을 골라 주세요.', true);
      return;
    }
    var over = picked.filter(function (e) { return e.who === 'person' && e.kind === 'diff-person'; });
    if (over.length && !force) {
      // 브라우저 기본 confirm 대신 다른 확인(전부 없음·지우기)과 같은 패널을 쓴다.
      $('pTitle').textContent = '직접 넣은 값을 덮어쓸까요?';
      $('pSub').textContent = n0(over.length) + '건';
      $('pBody').innerHTML = '<div class="anote">영수증 금액으로 바뀌고, 앱이나 웹에서 직접 넣은 값은 사라져요.</div>';
      $('pFoot').innerHTML = '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
        '<button class="btn pri" id="btnHpOverGo" data-gi="' + gi + '">' + n0(over.length) + '건 덮어쓰기</button>';
      $('panel').classList.add('open');
      return;
    }
    // 금액을 맞추는 것(fix — 예전 그대로 toll-apply items) · 원본만 붙이는 것(keep — toll-apply attach, 2026-10-23).
    //   서버는 한 요청에 한 가지만 받는다 — 확정 먼저, 그다음 붙이기. 확정이 실패하면 예전처럼 거기서 멈춘다(아무것도 안 바뀐다).
    var fix = picked.filter(function (e) { return e.kind !== 'keep'; }), keep = picked.filter(function (e) { return e.kind === 'keep'; });
    var label = hpBtnText(picked);
    var hbtn = document.querySelector('[data-hpapply="' + gi + '"]');
    if (hbtn) { hbtn.disabled = true; hbtn.textContent = fix.length ? '확정 중…' : '붙이는 중…'; }

    // 원본 PDF 보관(hpKeep)이 끝나기를 기다린다(30초까지 — 넘으면 확정 줄들은 pdf 없이 · 원본만 붙이기는 보내지 않고 다시 누르게). 보관은 거절하지 않는다.
    var job = HP.pdfJob;
    var kept = job ? Promise.race([job, new Promise(function (ok) { setTimeout(function () { ok(null); }, 30000); })]) : Promise.resolve(null);
    toast(job && !HP.pdfDone ? '원본 PDF를 보관하고 있어요. 끝나면 바로 확정해요.' : fix.length ? '확정하는 중…' : '원본을 붙이는 중…');
    var post = function (body) {
      return apiRetry('/functions/v1/toll-apply', { method: 'POST', body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
    };
    // R — sent: 서버가 하나라도 받아 처리했나 · err: 확정(items) 실패 · applied·attached: 서버가 센 수 · skipped: 서버가 건너뛴 것(확정·붙이기) ·
    //     local: 웹이 못 보낸 붙이기(원본을 보관하지 못함 · 아직 보관하는 중)·붙이기 요청 실패 · part: 일부 줄만 보낸 붙이기 · att: 보낸 붙이기 · attSkip: 붙이기 응답의 건너뜀
    var R = { sent: false, err: '', applied: 0, attached: 0, skipped: [], rows: [], warning: null, local: [], part: 0, att: [], attSkip: null };
    kept.then(function (k) {
      var paths = (k && k.paths) || [];
      // 보관 일은 늘 { paths, … } 로 끝난다(거절하지 않는다) — k 가 없으면 30초 안에 안 끝난 것, 아직 올리는 중이지 실패가 아니다(2026-10-23 오후).
      //   그때 원본만 붙이기는 「아직 보관하는 중」으로 남긴다 — 그 줄은 고른 채(받아 둔 근거 HP.ej 를 지우지 않는다), 다시 누르면 끝난 보관으로 붙는다.
      var slow = !k && !!job;
      var items = fix.map(function (e) {
        return {
          id: e.trip.id, amount: e.sum,
          note: '카드 ' + (g.card4 || '?') + ' · ' + (g.plate || ''),
          lines: e.lines.map(function (r) {
            // 입구 영업소·차종도 보낸다 — 서버 toll_evidence_json.lines 에 입구·출구·차종·금액이 남아 통행료 추정 개선에 쓴다(2026-10-17)
            var o = { at: r.atText, office: r.office, entry: r.entryOffice || null, cls: r.carClass || null, amount: r.amount, page: r.page };
            // 그 줄이 나온 PDF 원본(2026-10-23) — 보관한 것만 · page 는 그 PDF 안 쪽 번호
            var s = hpSrcOf(r, paths);
            if (s) { o.pdf = s.pdf; if (s.page != null) o.page = s.page; }
            return o;
          }),
        };
      });
      // 원본 붙이기 — 원본 없는 같은 줄(e.need)마다 그 기록이 나온 보관한 PDF·쪽. 보관한 원본이 없으면 보내지 않는다(까닭을 알린다 —
      //   아직 보관하는 중(slow)이면 다시 누르라고, 보관을 못 했으면 다시 올리라고).
      keep.forEach(function (e) {
        var ls = [];
        (e.need || []).forEach(function (r) {
          var s = hpSrcOf(r, paths), pg = s ? (s.page != null ? Number(s.page) : Number(r.page)) : NaN;
          if (s && pg >= 1 && Math.floor(pg) === pg) ls.push({ at: r.atText, office: r.office, entry: r.entryOffice || null, amount: r.amount, page: pg, pdf: s.pdf });
        });
        if (!ls.length) { R.local.push({ id: e.trip.id, why: slow ? HP_ATTACH_SLOW : HP_ATTACH_NOPATH }); return; }
        if (ls.length < (e.need || []).length) R.part++;
        R.att.push({ id: e.trip.id, lines: ls });
      });
      var first = items.length ? post({ items: items, batch: HP.batch }).then(function (res) {
        if (!res.ok || !res.j || !res.j.ok) { R.err = (res.j && res.j.error) || '확정하지 못했어요.'; return; }
        R.sent = true; R.applied = Number(res.j.applied) || 0; R.warning = res.j.warning || null;
        R.skipped = R.skipped.concat(res.j.skipped || []); R.rows = R.rows.concat(res.j.rows || []);
      }) : Promise.resolve();
      return first.then(function () {
        if (R.err || !R.att.length) return;
        return post({ attach: R.att, batch: HP.batch }).then(function (res) {
          if (!res.ok || !res.j || !res.j.ok) {
            var why = (res.j && res.j.error) || '원본을 첨부하지 못했어요';
            R.local = R.local.concat(R.att.map(function (a) { return { id: a.id, why: why }; })); return;
          }
          R.sent = true; R.attached = Number(res.j.attached) || 0; R.attSkip = res.j.skipped || [];
          R.skipped = R.skipped.concat(R.attSkip); R.rows = R.rows.concat(res.j.rows || []);
        }, function () { R.local = R.local.concat(R.att.map(function (a) { return { id: a.id, why: '서버에 연결하지 못했어요' }; })); });
      });
    }).then(function () {
      if (!R.sent) {
        // 서버가 아무것도 처리하지 않았다(확정 실패 · 붙일 원본이 없음 · 붙이기 실패) — 예전처럼 단추를 살리고 까닭만
        if (hbtn) { hbtn.disabled = false; hbtn.textContent = label; }
        toast(R.err || (R.local.length ? endDot(R.local[0].why) : '확정하지 못했어요.'), true); return;
      }
      // 서버가 되읽어 준 값으로 화면을 맞춘다 — 트리거가 바꿔치기했을 수 있다(원본 붙이기는 금액이 그대로 — 같은 값).
      R.rows.forEach(function (row) {
        var t = ALL_TRIPS.filter(function (x) { return x.id === row.id; })[0];
        if (t) { t.toll_cost = row.toll_cost; t.toll_status = row.toll_status; t.toll_source = row.toll_source; if ('toll_hipass' in row) t.toll_hipass = row.toll_hipass; }
      });
      AUDIT = null;
      TRIP_CACHE = {};
      // 원본을 붙인 운행은 받아 둔 근거를 버린다 — 다시 맞춰도 같음(same)으로 끝나고, 다음에 올리면 새로 받는다
      if (R.attSkip) {
        var no = R.attSkip.map(function (x) { return String(x.id); });
        R.att.forEach(function (a) { if (no.indexOf(String(a.id)) < 0 && HP.ej) delete HP.ej[String(a.id)]; });
      }
      var A = R.applied, K = R.attached, skipped = R.skipped.concat(R.local);
      // 건너뛴 이유가 이미 「원본을 보관하지 못해 …」면 같은 말을 또 하지 않는다(2026-10-24 검수 #34)
      var part = !R.part ? '' : skipped.length && endDot(skipped[0].why) === endDot(HP_ATTACH_NOPATH)
        ? ' 다른 운행도 일부 줄은 같은 이유로 첨부하지 못했어요.' : ' 원본을 보관하지 못한 줄은 첨부하지 못했어요. 다시 올려 주세요.';
      var did = A && K ? A + '건을 확정하고 원본 ' + K + '건을 첨부했어요.' : K ? '원본 ' + K + '건을 첨부했어요.' : A + '건을 확정했어요.';
      if (R.warning) toast(R.warning, true);
      // ★ 0건이면 '반영했다' 로 읽히면 안 된다. 왜 못 했는지를 앞세운다.
      else if (!A && !K) toast((fix.length ? '한 건도 확정하지 못했어요.' : '원본을 한 건도 첨부하지 못했어요.') + (skipped.length
        ? ' 이유: ' + endDot(skipped[0].why)
        : ''), true);
      else if (skipped.length) toast(did + ' ' + skipped.length + '건은 건너뛰었어요. 이유: ' +
        endDot(skipped[0].why) + part, true);   // toast 는 textContent — esc 를 씌우면 &quot; 가 그대로 보인다
      else if (part) toast(hpOkMsg(A, K, false) + part, true);
      else toast(hpOkMsg(A, K, false));
      // 남은 것만 다시 계산(원본만 붙이기는 받아 둔 근거로 다시 표시 — 붙인 운행은 위에서 버려 같음으로 끝난다)
      hpMarkKeep(hpMarkLocked([window.Hipass.assign(g, TRIPS)]));
      paintPills();
      // 모든 카드를 다 맞췄으면 영수증 › 통행료 차례로 돌아가 반영된 금액을 보여 준다(2026-10-14 사용자).
      // 건너뛴 것·경고가 있으면 여기 남아 까닭을 보게 한다.
      var left = HP.groups.some(function (x) { return x.plate && (x.matched || []).some(function (e) { return !hpDone(e); }); });
      if ((A || K) && !skipped.length && !R.warning && !R.part && !left) { tollBack(hpOkMsg(A, K, true)); return; }
      render();
      // 통째로 다시 그리면 스크롤이 맨 위로 간다 — 눌렀던 카드로 돌려놓는다.
      var card = document.querySelector('[data-hpcard="' + gi + '"]');
      if (card) card.scrollIntoView({ block: 'start' });
    }).catch(function () {
      if (hbtn) { hbtn.disabled = false; hbtn.textContent = label; }
      toast('서버에 연결하지 못했어요. 잠시 후 다시 해 주세요.', true);
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
      ['계기판', '<b style="white-space:nowrap">' + n0(t.start_odometer) + ' → ' + n0(t.end_odometer) + '</b> <span class="dim">(' + n0(odoKm(t)) + ' km)</span>'],
      ['주행거리', '<b>' + km(t.distance_km) + ' km</b>'],
      ['유류비', '<b>' + won(tripFuel(t)) + '</b><div class="dim" style="font-size:12px">' +
        esc(region(t.start_address, t.start_lat, t.start_lng)) + ' · ' + qq.y + '년 ' + qq.q + '분기 단가</div>'],
      // 통행료·주차비 금액 모양을 같게(₩ · 굵게, 2026-10-16 3차) — 미확정·없음·면제는 표와 같은 딱지
      ['통행료', (isUnknownToll(t) || Number(t.toll_cost) === 0 ? tollCell(t) : '<b>' + won(t.toll_cost) + '</b>') + (t.toll_source ?'<div class="dim" style="font-size:12px">' + esc(t.toll_source) + '</div>' : '')],
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
      ? '<span class="dim" style="font-size:12px;flex:1">결재 중이거나 끝난 기간이라 고칠 수 없어요.</span>' +
        '<button class="btn" data-close>닫기</button>'
      : isMulti()
        ? '<span class="dim" style="font-size:12px;flex:1">여러 기간을 함께 볼 때는 조회만 돼요.</span>' +
          '<button class="btn" data-close>닫기</button>' +
          '<button class="btn pri" data-cyc="' + cycKey(tc) + '">' + CR.short(tc) + ' 열어 고치기</button>'
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
  /** 고치기 창이 처음 보이는 값 — 주차비(0 = 없음) · 통행료 none(확정 0원) | amount | unknown. 저장할 때 이것과 견줘 바뀐 것만 보낸다. */
  function editInit(t) {
    var p = Number(t.parking_cost), a = tollNeed(t).a;
    return {
      park: isFinite(p) && p > 0 ? Math.round(p) : 0,
      toll: a > 0 ? 'amount' : isUnknownToll(t) ? 'unknown' : 'none',
      tollAmt: a > 0 ? Math.round(a) : 0
    };
  }
  /** 지금 통행료가 어디서 왔는가(고치기 창 안내). */
  function tollSrcText(t) {
    var a = tollNeed(t).a, src = String(t.toll_source || ''), st = t.toll_status;
    if (isUnknownToll(t) && !(a > 0)) return '미확정';
    var from = src === '하이패스 영수증' ? '하이패스 대조' : src === '영수증' || /영수증/.test(src) ? '영수증' : src.indexOf('기사 확인') === 0 ? '운행 종료 때 확인'
      : src === '웹 직접 입력' || st === 'MANUAL' ? '직접 입력' : st === 'CHARGED' ? '자동 계산' : st === 'FREE_CONFIRMED' ? '없음(0원)' : '';
    return (a > 0 ? n0(a) + '원' : '0원') + (from ? ' (' + from + ')' : '');
  }
  /** 운행 고치기 창 통행료 안내 — 고른 값(pick)에 맞춘다. 「지금 값」은 처음 고름 그대로일 때만 보인다. */
  // 「없음」·「모름」이어도 그날 영수증이 있으면 영수증 금액이 운행에 들어간다(금액 규칙 v3 — 의도된 동작).
  //   창에는 「사람이 정한 값은 자동 계산이 덮어쓰지 않는다」만 있어, 영수증 금액이 들어가면 고친 값이 무시된 것처럼 보였다(2026-10-16 5차).
  var RCP_FILL = { '통행료': '그날 업무 운행에 통행료가 하나도 없으면 그날 올린 <b>통행료 영수증 금액</b>이 운행에 들어가요.',
    '주차': '그날 업무 운행에 주차비가 하나도 없으면 그날 올린 <b>주차 영수증 금액</b>이 운행에 들어가요.' };
  /** 키보드(화살표)로 고르는 중인가 — 그때 금액 칸으로 포커스를 옮기면 고르기 묶음 밖으로 튀어 나머지 칩으로 못 간다(2026-10-16 5차).
   *  마우스·손가락으로 누르면 :focus-visible 이 아니다 → 예전처럼 금액 칸으로. */
  function kbdPick(el) { try { return el.matches(':focus-visible'); } catch (e) { return false; } }
  function tollEditHint(pick, first, srcTxt, other) {
    var now = srcTxt && pick === first ? '지금 값: ' + esc(srcTxt) + ' · ' : '';
    if (pick === 'none') return now + '통행료가 없는 운행으로 저장해요(0원). ' + RCP_FILL['통행료'];
    if (pick === 'unknown') return now + unkTollHint(other);
    return now + '1 ~ 200,000원 · 자동으로 채운 금액이 틀렸으면 고치세요.';
  }
  /** 「모름」 안내(2026-10-21) — 예전 「(영수증이 있으면 영수증 금액)」은 그날 다른 운행에 통행료가 있으면 틀렸다(규칙 v3: 운행 금액이 있는 날
   *  영수증은 대조만 — 「모름」 운행은 0원으로 정산). other = 그날 다른 업무 운행에 통행료 금액이 있는가(otherTollOn). */
  function unkTollHint(other) {
    return other ? '‘모름’은 0원으로 정산돼요. 이날은 다른 운행에 통행료가 있어 그날 영수증이 이 운행에 들어가지 않아요. 영수증이 있으면 ‘금액 입력’에 그 금액을 넣어 주세요.'
      : '‘모름’은 우선 0원이에요. 이날 다른 운행에도 통행료가 없으면 그날 통행료 영수증 금액이 들어가는데, 이 운행에 연결한 영수증이면 이 운행에, 아니면 그날 첫 운행에 들어가요. 이 운행 영수증이면 ‘금액 입력’에 넣는 것이 정확해요.';
  }
  /** 같은 사람·같은 날(KST)의 다른 업무 운행에 통행료 금액이 있는가 — 있으면 그날 영수증은 「모름」 운행을 채우지 않는다(금액 규칙 v3). */
  function otherTollOn(t, who, dayKey) {
    var u = who || (t && t.username), k = dayKey || (t ? ymd(t.start_time) : '');
    return !!u && !!k && ALL_TRIPS.some(function (x) {
      return x.username === u && !x.deleted_at && (x.purpose || '') === BUSINESS && (!t || String(x.id) !== String(t.id)) &&
        ymd(x.start_time) === k && tollNeed(x).a > 0;
    });
  }
  function parkEditHint(pick) {
    return pick === 'amount' ? '1 ~ 300,000원 · 그날 주차 영수증과 비교하고, 정산에는 운행 금액이 들어가요.'
      : '주차비가 없는 운행으로 저장해요. ' + RCP_FILL['주차'];
  }
  /** 운행 추가 창 주차비 안내 — 고른 값을 따른다. 「없음」 뜻은 운행 고치기 창과 같다(그날 영수증 금액이 들어감, 2026-10-16 6차). */
  function parkAddHint(pick) {
    return pick === 'amount' ? '1 ~ 300,000원 · 영수증도 올려 주세요. 그날 주차 영수증과 비교하고, 정산에는 운행 금액이 들어가요.'
      : pick === 'none' ? '주차비가 없는 운행으로 넣어요. ' + RCP_FILL['주차']
      : '주차비를 냈으면 있음을 골라 금액을 넣고 영수증도 올려 주세요. ' + RCP_FILL['주차'];
  }
  function openEdit(id) {
    var t = TRIPS.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!t) return;
    if (apprLocked(t)) { toast('결재 중이거나 끝난 기간이라 고칠 수 없어요. ‘이번 달 마감’에서 고치는 방법을 확인해 주세요.', true); return; }
    // 계기판: 본인 운행·관리자(2026-10-07 — 직원도 계기판 사진과 맞춰 직접 고친다. 서버 trip-edit 와 같은 규칙)
    var canOdo = !!(ME && (ME.is_admin || t.username === myName()));

    $('pTitle').textContent = md(t.start_time) + ' ' + hm(t.start_time) + ' 고치기';
    $('pSub').textContent = nameOf(t.username) + ' · ' + (t.plate_no || '');

    var h = '<div class="form">';
    h += fld('운행목적', '<div class="radios" role="radiogroup" aria-label="운행목적">' + PURPOSES.map(function (p) {
      return '<label class="radio"><input type="radio" name="ePurpose" value="' + esc(p) + '"' +
        ((t.purpose || '') === p ? ' checked' : '') + '><span>' + esc(p) + '</span></label>';
    }).join('') + '</div>',
      (t.purpose || '') === '일반업무' ? '업무용만 비용으로 집계돼요.' : '업무용이 아니면 비용에서 빠져요.');

    h += fld('방문처', '<input class="inp" id="eVisit" maxlength="120" value="' + esc(t.visit_place || '') + '">');
    // 주차비·통행료 — 「운행 추가」 창과 같은 고르기(2026-10-15 사용자: 수기로 넣을 수 있게 · 「0 을 넣어라 / 비워라」를 섞지 않는다).
    //   통행료는 자동으로 채워지지만(자동 계산·하이패스·영수증) 틀리면 언제든 여기서 고친다(사람이 정한 값 MANUAL).
    var E0 = editInit(t);
    h += fld('주차비',
      '<div class="radios" role="radiogroup" aria-label="주차비"><label class="radio"><input type="radio" name="eParkM" value="none"' + (E0.park ? '' : ' checked') + '><span>없음</span></label>' +
      '<label class="radio"><input type="radio" name="eParkM" value="amount"' + (E0.park ? ' checked' : '') + '><span>있음</span></label></div>' +
      '<div style="margin-top:9px" id="eParkBox"' + (E0.park ? '' : ' hidden') + '><input class="inp num" id="ePark" inputmode="numeric" placeholder="금액" value="' +
      (E0.park ? n0(E0.park) : '') + '"><span class="unit">원</span></div>',
      '<span id="eParkHint">' + parkEditHint(E0.park ? 'amount' : 'none') + '</span>');

    var srcTxt = tollSrcText(t), othToll = otherTollOn(t);
    h += fld('통행료',
      '<div class="radios" role="radiogroup" aria-label="통행료"><label class="radio"><input type="radio" name="eToll" value="none"' + (E0.toll === 'none' ? ' checked' : '') + '><span>없음</span></label>' +
      '<label class="radio"><input type="radio" name="eToll" value="amount"' + (E0.toll === 'amount' ? ' checked' : '') + '><span>금액 입력</span></label>' +
      '<label class="radio"><input type="radio" name="eToll" value="unknown"' + (E0.toll === 'unknown' ? ' checked' : '') + '><span>모름</span></label></div>' +
      '<div style="margin-top:9px" id="eTollBox"' + (E0.toll === 'amount' ? '' : ' hidden') + '><input class="inp num" id="eToll" inputmode="numeric" placeholder="금액" value="' +
      (E0.toll === 'amount' ? n0(E0.tollAmt) : '') + '"><span class="unit">원</span></div>',
      '<span id="eTollHint">' + tollEditHint(E0.toll, E0.toll, srcTxt, othToll) + '</span>');
    // 아래 안내는 통행료 고르기 바로 아래에 둔다 — 창 맨 아래에 있으면 1280×800 에서 창을 내려야 보였다(2026-10-16 6차)
    h += '</div>' + '<div class="anote" id="eNote" style="margin:-4px 0 16px">' +
      '통행료를 고치면 <b>직접 정한 값</b>으로 남아 길찾기나 하이패스 요금 같은 <b>자동 계산</b>이 덮어쓰지 않아요. ' +
      '단, 통행료나 주차비를 ‘없음’으로 두었는데 그날 다른 업무 운행에도 그 항목 금액이 하나도 없으면, 그날 올린 그 항목의 <b>영수증 금액</b>이 들어가요.</div>' + '<div class="form">';

    if (canOdo) {
      h += fld('계기판',
        // n0(null) 은 '—' 다. 그걸 칸에 박아 두면 목적만 바꿔도 저장이 막힌다.
        '<input class="inp num" id="eOdoS" inputmode="numeric" value="' + odoVal(t.start_odometer) + '">' +
        '<span class="arrowto">→</span>' +
        '<input class="inp num" id="eOdoE" inputmode="numeric" value="' + n0(t.end_odometer) + '">',
        '고치면 <b>주행거리도 같이 바뀌어요</b>. 한 번에 3,000km를 넘을 수 없어요.');
    }
    h += '</div>';

    $('pBody').innerHTML = h;
    $('pFoot').innerHTML = '<span style="flex:1"></span>' +
      '<button class="btn" data-trip="' + t.id + '" data-cancel>취소</button>' +     // data-cancel — 아래 줄 끝으로(footOrder, 2026-10-20 단추 차례 통일)
      '<button class="btn pri" id="btnSaveTrip" data-id="' + t.id + '">저장</button>';
    $('panel').classList.add('open');
    document.querySelectorAll('input[name="eParkM"]').forEach(function (x) { x.addEventListener('change', function () {
      $('eParkBox').hidden = this.value !== 'amount';
      var hn = $('eParkHint'); if (hn) hn.innerHTML = parkEditHint(this.value);
      if (this.value === 'amount' && !kbdPick(this)) $('ePark').focus();
    }); });
    document.querySelectorAll('input[name="eToll"]').forEach(function (x) { x.addEventListener('change', function () {
      $('eTollBox').hidden = this.value !== 'amount';
      // 안내도 고른 값에 맞춘다 — 「없음」을 골라도 「지금 값: 1,100원…」이 남아 있었다(2026-10-16 4차).
      var hn = $('eTollHint'); if (hn) hn.innerHTML = tollEditHint(this.value, E0.toll, srcTxt, othToll);
      if (this.value === 'amount' && !kbdPick(this)) $('eToll').focus();
    }); });

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
    var minD = ymd(cycleRange(addCycle(currentCycle(), -3, 'driving')).lo);
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
      }).join('') + '</select>', '관리자는 다른 분의 운행도 넣을 수 있어요.');
    }
    h += fld('차량번호', myCars.length
      ? '<select class="inp" id="cPlate">' + myCars.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('') + '</select>'
      : '<input class="inp" id="cPlateEtc" placeholder="예) 12가3456">');
    h += fld('날짜 <em class="req">*</em>', '<input class="inp" type="date" id="cDate" value="' + dstr + '" min="' + minD + '" max="' + maxD + '">', '<span id="cDateHint"></span>');
    h += '<div id="cPosRow"></div>';
    h += fld('출발지 <em class="req">*</em>', placeBox('cFrom', '건물 이름·주소로 찾기 (예: 서울버스 본사)'), '<span id="cFromHint">목록에서 골라 주세요. 출발지로 수도권·지방 유류단가가 정해져요.</span>');
    h += fld('도착지 <em class="req">*</em>', placeBox('cTo', '건물 이름·주소로 찾기'), '<span id="cToHint">목록에서 고르면 도로 거리로 도착 계기판이 채워져요.</span>');
    h += fld('계기판 <em class="req">*</em>',
      '<input class="inp num" id="cOdoS" inputmode="numeric" placeholder="출발">' +
      '<span class="arrowto">→</span>' +
      '<input class="inp num" id="cOdoE" inputmode="numeric" placeholder="도착">',
      '<span id="cOdoHint">출발은 앞 운행의 도착값, 도착은 도로 거리로 채워져요. 직접 고쳐도 돼요.</span>');
    h += fld('시각', '<input class="inp num" type="time" id="cFromT" style="width:150px">' +
      '<span class="arrowto">→</span><input class="inp num" type="time" id="cToT" style="width:150px">',
      '고른 자리에 맞춰 정해져요. 도착 시각이 있으면 나중에 <b>하이패스 기록과 맞출 수 있어요</b>.');
    h += fld('운행목적', '<div class="radios" role="radiogroup" aria-label="운행목적">' + PURPOSES.map(function (p) {
      return '<label class="radio"><input type="radio" name="cPurpose" value="' + esc(p) + '"' + (p === '일반업무' ? ' checked' : '') + '><span>' + esc(p) + '</span></label>';
    }).join('') + '</div>');
    h += fld('방문처 <em class="req">*</em>', '<input class="inp" id="cVisit" maxlength="120" placeholder="예) 서울버스 본사">', '도착지를 고르면 그 이름으로 채워져요.');
    h += fld('주차비 <em class="req">*</em>',
      '<div class="radios" role="radiogroup" aria-label="주차비"><label class="radio"><input type="radio" name="cParkM" value="none"><span>없음</span></label>' +
      '<label class="radio"><input type="radio" name="cParkM" value="amount"><span>있음</span></label></div>' +
      '<div style="margin-top:9px" id="cParkBox" hidden><input class="inp num" id="cPark" inputmode="numeric" placeholder="금액"><span class="unit">원</span></div>',
      '<span id="cParkHint">' + parkAddHint('') + '</span>');
    h += fld('통행료 <em class="req">*</em>',
      '<div class="radios" role="radiogroup" aria-label="통행료"><label class="radio"><input type="radio" name="cToll" value="none"><span>없음</span></label>' +
      '<label class="radio"><input type="radio" name="cToll" value="amount"><span>금액 입력</span></label>' +
      '<label class="radio"><input type="radio" name="cToll" value="unknown"><span>모름</span></label></div>' +
      '<div style="margin-top:9px" id="cTollBox" hidden><input class="inp num" id="cToll" inputmode="numeric" placeholder="0"><span class="unit">원</span></div>',
      '<span id="cTollHint">모름을 고르면 나중에 자동 계산이나 하이패스 이용내역 PDF로 채워져요.</span>');
    h += '</div><div class="anote">직접 넣은 운행에는 <b>수기</b> 표시가 붙고, 주행거리는 계기판 차이로 계산돼요.</div>';

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
    document.querySelectorAll('input[name="cParkM"]').forEach(function (x) { x.addEventListener('change', function () { $('cParkBox').hidden = this.value !== 'amount'; var ph = $('cParkHint'); if (ph) ph.innerHTML = parkAddHint(this.value); if (this.value === 'amount' && !kbdPick(this)) $('cPark').focus(); }); });
    document.querySelectorAll('input[name="cToll"]').forEach(function (x) { x.addEventListener('change', function () {
      $('cTollBox').hidden = this.value !== 'amount';
      cfTollHint();
      if (this.value === 'amount' && !kbdPick(this)) $('cToll').focus();
    }); });
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
          .then(function (j) { if (my !== seq) return; if (!j || !j.ok) { show([], (j && j.error) || '찾지 못했어요.'); return; } show(j.list, j.list.length ? '' : '찾는 곳이 없어요. 다른 이름이나 주소로 찾아 보세요.'); })
          .catch(function () { if (my === seq) show([], '서버에 연결하지 못했어요. 잠시 후 다시 해 주세요.'); });
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
      if (!isFinite(ms)) hint.textContent = '날짜를 골라 주세요.';
      else { var c = cycleOfMs(ms); hint.innerHTML = '<b>' + esc(cycleName(c)) + '</b>(' + esc(cycleSpan(c)) + ')에 들어가요.' + (lk ? ' <b style="color:var(--red)">결재 중이거나 끝난 기간이라 넣을 수 없어요.</b>' : ''); }
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
        }).join('') + '</select><div class="fhint">이 날 운행이 ' + day.length + '건 있어요. 어느 운행 앞뒤인지 고르면 시각과 계기판이 그 자리에 맞춰져요.</div></div></div>' : '';
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
    var so = numIn($('cOdoS').value);
    if (so === null || isNaN(so)) return;           // 출발 계기판이 비었거나 못 읽는 글이면 채우지 않는다(2026-10-20 AU2 #9)
    $('cOdoE').value = n0(Math.round(so + CF.route.km));
  }
  /** 출발·도착을 모두 골랐으면 도로 거리·예상 시간·예상 통행료를 받아 채운다.
   *  ★ 늦게 온 예전 답은 버린다(2026-10-20 AU2 #6) — 도착지를 A(120km) → B(5km)로 바로 바꾸면 A 의 답이 나중에 와서
   *    칸에는 B 가 보이는데 도착 계기판이 +120 으로 채워졌다. 요청마다 순번을 매기고, 순번·창·출발·도착이 그대로일 때만 쓴다. */
  var CF_ROUTE_SEQ = 0;
  function cfRoute() {
    CF.route = null;
    var my = ++CF_ROUTE_SEQ;                 // 출발·도착을 비워도 순번을 올린다 — 가는 중인 예전 요청을 무르기 위해
    var hint = $('cOdoHint');
    if (!CF.from || !CF.to) { if (hint) hint.textContent = '출발은 앞 운행의 도착값, 도착은 도로 거리로 채워져요. 직접 고쳐도 돼요.'; return; }
    if (hint) hint.textContent = '도로 거리를 계산하는 중…';
    var cf = CF, from = CF.from, to = CF.to;
    var live = function () { return my === CF_ROUTE_SEQ && cf === CF && cf.from === from && cf.to === to; };
    apiRetry('/functions/v1/trip-geo', { method: 'POST', body: JSON.stringify({ action: 'route', from: { lat: from.lat, lng: from.lng }, to: { lat: to.lat, lng: to.lng } }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!live()) return;
        if (!j || !j.ok || j.km == null) { if (hint) hint.textContent = (j && (j.error || j.note)) || '거리를 계산하지 못했어요. 도착 계기판을 직접 넣어 주세요.'; return; }
        CF.route = j;
        if (hint) hint.innerHTML = '도로 거리 <b>' + esc(j.km) + 'km</b>, 약 ' + esc(j.min) + '분 기준으로 채웠어요. 직접 고쳐도 돼요.';
        cfFillEnd();
        if (!CF.timeTouched) cfRefresh(false);
        cfTollHint();
      }).catch(function () { if (live() && hint) hint.textContent = '거리를 계산하지 못했어요. 도착 계기판을 직접 넣어 주세요.'; });
  }
  /** 통행료 안내 — 고른 값(없음·금액 입력·모름)에 맞춘 한 줄 + 길찾기 예상 통행료(있으면).
   *  예전에는 길찾기 결과 한 줄로 덮어써서 「모름」을 골라도 「길찾기 경로에는 통행료가 없습니다」만 남았다(2026-10-16 5차 — 고치기 창과 같게). */
  function cfTollHint() {
    var th = $('cTollHint'); if (!th || !CF) return;
    var pick = (document.querySelector('input[name="cToll"]:checked') || {}).value || '';
    var rt = CF.route, toll = rt && rt.toll > 0 ? rt.toll : 0;
    var head = pick === 'none' ? '통행료가 없는 운행으로 넣어요(0원). ' + RCP_FILL['통행료']
      // 「(영수증이 있으면 영수증 금액)」은 그날 다른 운행에 통행료가 있으면 틀렸다(2026-10-21) — 그날 상황대로
      : pick === 'unknown' ? '모름을 고르면 우선 0원이고, 나중에 자동 계산이나 하이패스 이용내역 PDF로 채워져요. ' +
        (otherTollOn(null, CF.who, CF.date) ? '이 날은 다른 운행에 통행료가 있어 그날 영수증이 이 운행에 들어가지 않으니, 영수증이 있으면 금액 입력을 골라 그 금액을 넣어 주세요.'
          : '이 날 다른 운행에도 통행료가 없으면 그날 통행료 영수증 금액이 들어가요.')
        : pick === 'amount' ? '1 ~ 200,000원 · 통행료 영수증도 올려 주세요. 검증 때 비교해요.'
          : '모름을 고르면 나중에 자동 계산이나 하이패스 이용내역 PDF로 채워져요.';
    var route = !rt ? '' : toll
      ? ' 카카오 길찾기 예상 통행료 <b>' + n0(toll) + '원</b>' + (pick === 'amount' && numIn($('cToll').value) === Number(toll) ? ''
        : ' <button type="button" class="btn sm" id="cTollUse">이 금액 넣기</button>')
      : ' 길찾기 경로에는 통행료가 없어요.';
    th.innerHTML = head + route;
    var u = $('cTollUse');
    if (u) u.addEventListener('click', function () {
      var rb = document.querySelector('input[name="cToll"][value="amount"]'); rb.checked = true;
      $('cTollBox').hidden = false; $('cToll').value = String(toll);
      cfTollHint();
    });
  }

  function createTrip(force, shift, nextDay) {
    // 숫자 칸은 숫자·쉼표만(2026-10-20 AU2 #9) — 못 읽는 글이면 아래 numStop 이 그 칸을 표시하고 멈춘다(예전엔 글자를 지운 숫자로 넣었다)
    var num = function (el) { return numIn(el && el.value); };
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
    if (numStop($('cOdoS'), '출발 계기판') || numStop($('cOdoE'), '도착 계기판')) return;
    var so = num($('cOdoS')), eo = num($('cOdoE'));
    if (so == null || eo == null) { toast('계기판 값을 넣어 주세요.', true); return; }
    if (eo < so) { toast('도착 계기판이 출발보다 작아요.', true); return; }
    if (eo - so > 3000) { toast('한 운행에 3,000km를 넘을 수 없어요.', true); return; }
    var visit = $('cVisit').value.trim();
    if (!visit) { toast('방문처를 넣어 주세요.', true); $('cVisit').focus(); return; }
    var parkM = (document.querySelector('input[name="cParkM"]:checked') || {}).value;
    if (!parkM) { toast('주차비를 없음, 있음 중에서 골라 주세요.', true); return; }
    if (parkM === 'amount' && numStop($('cPark'), '주차비')) return;
    var park = parkM === 'amount' ? num($('cPark')) : null;
    if (parkM === 'amount' && !(park > 0)) { toast('주차비 금액을 넣어 주세요.', true); $('cPark').focus(); return; }
    var tollMode = (document.querySelector('input[name="cToll"]:checked') || {}).value;
    if (!tollMode) { toast('통행료를 없음, 금액 입력, 모름 중에서 골라 주세요.', true); return; }
    if (tollMode === 'amount' && numStop($('cToll'), '통행료')) return;
    var tollAmt = tollMode === 'amount' ? num($('cToll')) : null;
    if (tollMode === 'amount' && !(tollAmt > 0)) { toast('통행료 금액을 넣어 주세요. 없으면 없음을 고르세요.', true); $('cToll').focus(); return; }
    // 도착 시각이 출발보다 이르면 다음 날 도착으로 넣기 전에 한 번 묻는다(2026-10-20 AU2 #16 — 예전엔 말없이 하루를 더했다).
    //   다른 칸을 다 본 뒤에 묻는다(칸을 고치고 다시 누를 때마다 묻지 않게). 서버가 되묻고 다시 부를 때는 이미 답한 것(nextDay)을 넘긴다.
    if (endMs < startMs) {
      if (!nextDay && !window.confirm('도착 시각(' + to + ')이 출발 시각(' + from + ')보다 일러요.\n\n자정을 넘겨 다음 날 ' + to + '에 도착한 운행으로 넣을까요?\n시각을 고치려면 ‘취소’를 눌러 주세요.')) {
        if ($('cToT')) $('cToT').focus();
        return;
      }
      nextDay = true; endMs += 86400e3;
    }

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
          if (j.needShift && window.confirm(j.error + '\n\n이 운행을 넣고 이후 운행의 계기판을 밀어 올릴까요?')) { createTrip(force, true, nextDay); return; }
          if (j.needConfirm && window.confirm(j.error + '\n\n그래도 이대로 넣을까요?')) { createTrip(true, shift, nextDay); return; }
          if (!j.needShift) toast(j.error || '운행을 넣지 못했어요.', true);
          return;
        }
        var note = '운행을 넣었어요.' + (res.j.shifted ? ' 이후 운행 ' + res.j.shifted + '건의 계기판을 +' + n0(res.j.shiftKm) + 'km 밀었어요.' : '');
        TRIP_CACHE = {};
        AUDIT = null;
        toastOk(note, res.j.warning);
        closePanel();
        loadAll();                            // 밀린 운행까지 서버 값으로 다시 받는다
      }).catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = '넣기'; }
        toast('서버에 연결하지 못했어요. 잠시 후 다시 해 주세요.', true);
      });
  }

  function saveTrip(id, force) {
    var t = TRIPS.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!t) return;
    // ★ 예전에는 '-' 를 남겨 둬서 "-" 나 "12-34" 가 NaN 이 됐다. NaN 은 모든
    //   범위 검사를 빠져나가고 JSON.stringify 가 null 로 바꿔 값이 조용히 지워졌다.
    //   그다음엔 숫자 밖의 글자를 다 지워 「1,100.5」가 11,005 가 됐다 — 이제는 숫자·쉼표만 받고, 다른 글자가 있으면
    //   그 칸을 표시하고 멈춘다(numStop, 2026-10-20 AU2 #9). 여기 num 은 numStop 을 지난 칸만 읽는다.
    var num = function (el) { return numIn(el && el.value); };
    var patch = {};

    var p = document.querySelector('input[name="ePurpose"]:checked');
    if (p && p.value !== (t.purpose || '')) patch.purpose = p.value;

    var vis = $('eVisit').value.trim().slice(0, 120);
    if (vis !== (t.visit_place || '')) patch.visit_place = vis;

    // 주차비·통행료 — 「운행 추가」와 같은 고르기(없음 / 있음·금액 입력 / 모름). 처음 보인 값(editInit)과 다를 때만 보낸다.
    var E0 = editInit(t);
    var parkM = (document.querySelector('input[name="eParkM"]:checked') || {}).value;
    if (parkM === 'amount') {
      if (numStop($('ePark'), '주차비')) return;
      var park = num($('ePark'));
      if (!(park > 0)) { toast('주차비 금액을 넣어 주세요. 없으면 없음을 고르세요.', true); $('ePark').focus(); return; }
      if (park > 300000) { toast('주차비는 300,000원까지 넣을 수 있어요.', true); return; }
      if (park !== E0.park) patch.parking_cost = park;
    } else if (E0.park) patch.parking_cost = null;      // 있음 → 없음

    var mode = (document.querySelector('input[name="eToll"]:checked') || {}).value;
    if (mode === 'unknown') {
      if (E0.toll !== 'unknown') patch.toll = { mode: 'unknown' };
    } else if (mode === 'none') {
      if (E0.toll !== 'none') patch.toll = { mode: 'amount', amount: 0 };
    } else if (mode === 'amount') {
      if (numStop($('eToll'), '통행료')) return;
      var amt = num($('eToll'));
      if (!(amt > 0)) { toast('통행료 금액을 넣어 주세요. 없으면 없음, 모르면 모름을 고르세요.', true); $('eToll').focus(); return; }
      if (amt > 200000) { toast('통행료는 200,000원까지 넣을 수 있어요.', true); return; }
      if (E0.toll !== 'amount' || amt !== E0.tollAmt) patch.toll = { mode: 'amount', amount: amt };
    } else { toast('통행료를 없음, 금액 입력, 모름 중에서 골라 주세요.', true); return; }

    if ($('eOdoS')) {                                    // 칸은 고칠 수 있는 사람(본인·관리자)에게만 그려진다
      if (numStop($('eOdoS'), '출발 계기판') || numStop($('eOdoE'), '도착 계기판')) return;
      var so = num($('eOdoS')), eo = num($('eOdoE'));
      var so0 = t.start_odometer == null ? null : Math.round(Number(t.start_odometer));
      var eo0 = t.end_odometer == null ? null : Math.round(Number(t.end_odometer));
      // ★ 계기판은 **바뀌었을 때만** 검사한다. 예전에는 늘 검사해서, 계기판이 비어 있는
      //   운행은 관리자가 목적만 고쳐도 '계기판 값을 넣어 주세요' 에서 막혔다(2026-09-23 검증로봇).
      if (so !== so0 || eo !== eo0) {
        if (so == null || eo == null) { toast('계기판 값을 넣어 주세요.', true); return; }
        if (eo < so) { toast('도착 계기판이 출발보다 작아요.', true); return; }
        if (eo - so > 3000) { toast('한 운행에 3,000km를 넘을 수 없어요.', true); return; }
        patch.start_odometer = so; patch.end_odometer = eo;
      }
    }
    // 서버가 앞뒤 운행과 크게 벌어졌다고 되물은 뒤 '그래도 저장' 을 고른 경우.
    if (force) patch.force = true;

    if (!Object.keys(patch).length) { toast('바뀐 내용이 없어요.'); closePanel(); return; }

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
          if (j.needConfirm && window.confirm(j.error + '\n\n그래도 이대로 저장할까요?')) {
            saveTrip(id, true); return;
          }
          toast(j.error || '저장하지 못했어요.', true); return;
        }
        // 서버가 되돌려 준 값으로 갈아끼운다 — 트리거가 값을 바꿨을 수 있다.
        var row = res.j.row || {};
        Object.keys(row).forEach(function (k) { if (k !== 'id') t[k] = row[k]; });
        AUDIT = null;
        TRIP_CACHE = {};                     // 다른 기간으로 갔다 왔을 때 고치기 전 값이 나오지 않게
        toastOk((res.j.changed || []).join('·') + ' 항목을 고쳤어요.', res.j.warning);
        closePanel(); paintPills(); render();
      }).catch(function () {
        btn.disabled = false; btn.textContent = '저장';
        toast('서버에 연결하지 못했어요. 잠시 후 다시 해 주세요.', true);
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
    if (EV_SENDING && $('evDrop')) { toast('영수증을 올리는 중이에요. 끝날 때까지 기다려 주세요.'); return; }
    if (!panelDirty()) { closePanel(); return; }
    // 창을 다시 그린 쪽(운행 추가의 '누구 운행' 등)이 되묻는 줄을 지웠을 수 있다 — 떠 있을 때만 '묻는 중'이다.
    if (CLOSE_ASK != null && $('btnKeep')) return;
    CLOSE_ASK = $('pFoot').innerHTML;
    // 「계속 입력」 = 닫기를 그만두는 취소(data-cancel) — footOrder 가 줄 끝으로 옮겨 [버리고 닫기] [계속 입력](2026-10-20 단추 차례 통일, 초점은 계속 입력 그대로)
    $('pFoot').innerHTML = '<span class="dim" style="flex:1;font-size:13px">입력한 내용이 사라져요. 닫을까요?</span>' +
      '<button class="btn" id="btnKeep" data-cancel>계속 입력</button><button class="btn pri" id="btnDiscard">버리고 닫기</button>';
    var k = $('btnKeep'); if (k) k.focus();
  }
  function closePanel() {
    CLOSE_ASK = null; APPR_BACK = null; SUBMIT.token = null; SUBMIT.send = null; RATE_ASK = null;
    // 안전교육 시청 창이면 멈추고 지금 위치를 저장한다(앱이 화면을 나갈 때와 같다, 2026-10-14).
    if (EDUW) eduStop();
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
    // 관리 「현황」(2026-10-15 2차) — 예전 a_close(마감 현황)·a_settle(정산)·a_verify(검증 현황)를 합쳤다. 예전 주소는 OLD_VIEWS 로 돌린다.
    a_status: viewStatus, a_trips: viewTrips, a_check: viewCheck, a_evid: viewEvid,
    a_hipass: viewHipass,
    people: viewPeople, cars: viewCars, eduadm: viewEduAdm,
    account: viewAccount, perm: viewPerm, tollfill: viewTollFill,
    safety: viewSafety, a_safety: viewSafety
  };
  /** 관리자만 열 수 있는 화면. */
  /** 예전 관리 화면 주소 → 새 화면(북마크·알림 링크가 깨지지 않게, 2026-10-15 2차). readHash·go 가 쓴다. */
  var OLD_VIEWS = { a_close: 'a_status', a_verify: 'a_status', a_settle: 'a_status' };
  var ADMIN_VIEWS = ['a_status', 'a_trips', 'a_check', 'a_evid', 'a_hipass',
    'people', 'cars', 'eduadm', 'perm', 'a_safety', 'cycset'];   // cycset = 마감 기간 설정(drv-cycles.js, 2026-10-20)
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
  var ORGBAR_VIEWS = ['a_status', 'a_trips', 'a_check', 'a_evid', 'a_safety', 'a_final'];
  /* ── A안: 한 단계로 묶인 화면 사이의 탭, 단계 화면 맨 아래 '다음 단계' ── */
  // 하이패스 대조·통행료 채우기의 위 탭(「← 영수증」·「하이패스 PDF」)은 뺐다 — 돌아가는 길은 맨 아래 「← 통행료로 돌아가기」 하나(2026-10-15 2차)
  var TAB_OF = { trips: 'rec', check: 'rec', a_trips: 'arec', a_check: 'arec', a_evid: 'arec' };
  var TAB_SET = {
    rec: [['trips', '운행 기록'], ['check', '기록 점검']],
    arec: [['a_trips', '운행 기록'], ['a_check', '기록 점검'], ['a_evid', '영수증']]
  };
  var NEXT_OF = {
    trips: ['evid', '2 영수증·통행료로'], check: ['evid', '2 영수증·통행료로'],
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
    // 하이패스 대조·직접 채우기는 영수증 › 통행료 차례 안의 화면이다 — 맨 아래는 「통행료로 돌아가기」 하나(2026-10-14 사용자).
    //   예전에는 「← 1 운행 기록」만 있어서 다 맞춘 뒤 어디로 가야 할지 몰랐다.
    if ((VIEW === 'hipass' || VIEW === 'tollfill') && !isAll() && !isMulti()) {
      html += '<div class="nextstep"><span class="stepbadge">2</span><span class="t">' +
        '다 맞췄으면 <b>통행료</b>로 돌아가 반영된 금액을 확인하고 ‘다음: 주유’로 넘어가세요.</span>' +
        '<button class="btn pri cta" data-tollback="1">← 통행료로 돌아가기</button></div>';
      sn = 0;
    }
    if (sn && sn <= 3 && !isAll() && !isMulti() && !cycleLocked(myName())) {
      var S = stepInfo(), p = Math.min(stepNow(), 3);
      var here = S.steps[sn - 1];
      // 3단계(검증·상신)에는 맨 아래 「다음 단계」 단추가 없다 — 위 ①②③ 으로 상신하면 끝난다고 말한다(2026-10-20 V3 다듬기: 없는 단추를 가리켰다)
      var back = sn > 1 ? ' 잘못 넘어왔으면 앞 단계로 돌아가도 돼요.' : '';
      var note = sn < p ? '<b>이미 지난 단계</b>예요. 고친 뒤 다음 단계로 다시 넘어가세요.'
        : sn > p ? '지금은 <b>' + p + '단계(' + esc(STEP_NAMES[p - 1]) + ')</b> 차례예요.'
        : sn === 3 ? (here && here.n > 0 ? '이 단계에 남은 일이 있어요(<b>' + esc(here.sub) + '</b>). 그래도 상신할 수 있고, 결재자에게도 함께 보여요.'
          : '<b>검증하기, PDF 미리보기, 상신</b> 순서로 하면 이 단계가 끝나요.') + back
        : here && here.n > 0 ? '이 단계에 남은 일이 있어요(<b>' + esc(here.sub) + '</b>). 그래도 다음 단계로 넘어갈 수 있어요.'
        : '이 단계를 마쳤으면 <b>다음 단계</b>로 넘어가세요.' + back;
      html += '<div class="nextstep"><span class="stepbadge">' + sn + '</span><span class="t">' + note + '</span>' +
        // 아직 오지 않은 단계에서는 건너뛰지 못하게 — 지금 단계로 가는 버튼 하나만. 이 화면에서 깜빡이는 하나(마감 뒤 5일에 1·2단계인 사람 등, 2026-10-20 V3 U1)
        (sn > p ? '<button class="btn pri cta" data-v="' + STEP_VIEW[p - 1] + '">' + p + '단계로 가기 →</button>' : '') +
        (sn > p ? '' : sn > 1 ? '<button class="btn" data-stepmove="-1" data-from="' + sn + '">← ' + (sn - 1) + ' ' + esc(STEP_NAMES[sn - 2]) + '</button>' : '') +
        // ★ 2단계(영수증·통행료)는 주차 → 통행료 → 주유 → 계기판 차례를 끝까지 지나야 3단계로 넘어간다(2026-10-07 사용자).
        //   맨 아래 버튼으로 바로 건너뛸 수 있어 헷갈렸다. 이미 지난 단계(sn < p)에서 돌아와 고치는 중이면 막지 않는다.
        (sn === 2 && sn === p && evSubMax() < 3
          ? '<span class="dim" style="font-size:13px">주차, 통행료, 주유, 계기판을 차례로 마치면 3단계 검증·상신으로 넘어갈 수 있어요.</span>'
          // 계기판 차례에서는 카드의 「다음: 3 검증·상신 →」 하나만(같은 단추가 카드와 띠에 둘이었다 — 2026-10-15 2차)
          : sn === 2 && sn === p && VIEW === 'evid' && evSub() === 3 ? ''
          // 영수증 화면은 카드 안의 단추(올리기·「다음」)가 깜빡이는 하나 — 띠 단추는 빨강만(깜빡임 둘이 되지 않게, V3 U1)
          : sn < 3 && sn <= p ?'<button class="btn pri' + (sn === p && VIEW !== 'evid' ? ' cta' : '') + '" data-stepmove="1" data-from="' + sn + '">' +
            (sn + 1) + ' ' + esc(STEP_NAMES[sn]) + ' →</button>' : '') + '</div>';
    }
    // 단계를 옮겨 온 직후면 그 방향으로 밀려 들어오는 효과
    // 기간과 상관없는 화면(결재함·계정·권한·조직도·차량)에는 띠를 달지 않는다.
    if (['inbox', 'account', 'perm', 'org', 'cars', 'cycset'].indexOf(VIEW) < 0) html = cycleBand() + html;
    if (STEP_FX) { html = '<div class="stepfx ' + STEP_FX + '">' + html + '</div>'; STEP_FX = ''; }
    return html;
  }
  /** 관리 묶음은 평소 접어 둔다. 관리 화면에 있거나 펼쳐 둔 적이 있으면 편다. */
  var ADM_OPEN = (function () { try { return localStorage.getItem('drv.admopen') === '1'; } catch (e) { return false; } })();
  var ADM_CLICK_VIEW = '';      // 관리 화면에서 직접 접었으면 그 화면에 있는 동안은 접힌 채로 둔다
  function syncAdm() {
    var list = $('admList'), tog = $('admTog');
    if (!list || !tog) return;
    var inAdm = !!list.querySelector('[data-v="' + VIEW + '"]') ||
      Array.prototype.some.call(list.querySelectorAll('[data-alt]'), function (a) { return a.dataset.alt.split(',').indexOf(VIEW) >= 0; });
    var open = ADM_OPEN || (inAdm && ADM_CLICK_VIEW !== VIEW);
    list.classList.toggle('fold', !open);
    tog.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  /** 운행일지를 안 쓰고 결재만 하는 사람인가(2026-10-07, 포털 가입 때 고름). 관리자는 늘 전부 본다. */
  function noDriving() {
    if (!ME || ME.is_admin) return false;
    var u = USERS[myName()];
    return ME.uses_driving === false || !!(u && u.uses_driving === false);
  }
  // 운전 안 하는 사람이 들어갈 수 있는 화면 — 결재함 · 내 계정 · 개인경비(2026-10-07)
  var NODRV_VIEWS = ['inbox', 'account', 'x_month', 'x_verify', 'c_month', 'c_verify'];   // 법인카드도 모든 직원(2026-10-09)
  /** 운전 안 하는 사람의 첫 화면 — 결재할 것이 있으면 결재함, 아니면 개인경비. */
  function ndLanding() {
    if (inbox().length) return 'inbox';
    return VIEWS.x_month ? 'x_month' : 'inbox';
  }
  // 메뉴 갈래(2026-10-08): 'd' 운행일지 · 'x' 개인경비 · 'c' 법인카드(2026-10-09). 함께 쓰는 화면에서는 앞 갈래를 그대로 둔다.
  var NAV_MODE = (function () { try { var v = sessionStorage.getItem('drv_navmode'); return v === 'x' || v === 'c' ? v : 'd'; } catch (e) { return 'd'; } })();
  var SHARED_VIEWS = ['inbox', 'account', 'org', 'perm', 'cycset'];   // 직원 현황은 갈래마다 따로(people / xa_people, 2026-10-08)
  /** 갈래마다 머리 이름·아이콘·첫 화면·기간 이름표(2026-10-09). */
  var MODE_SYS = {
    d: { name: '운행일지', ico: '#i-car', home: 'close', homeLabel: '이번 달 마감으로', cyc: '마감 기간' },
    x: { name: '개인경비 지출결의', ico: '#i-won', home: 'x_month', homeLabel: '개인경비 지출결의 첫 화면으로', cyc: '경비 기간' },
    c: { name: '법인카드 지출결의', ico: '#i-card', home: 'c_month', homeLabel: '법인카드 지출결의 첫 화면으로', cyc: '카드 기간' }
  };
  /** 그 갈래의 모듈이 실려 있는가 — 첫 화면이 있어야 한다(drv-card.js 가 없으면 'c' 는 없다. 운행일지 'd' 는 늘 있다). */
  function modeOk(m) { return m === 'd' || !!(MODE_SYS[m] && VIEWS[MODE_SYS[m].home]); }
  function navModeOf(v) {
    if (/^xa?_/.test(v)) return 'x';
    if (/^ca?_/.test(v)) return 'c';                 // 법인카드(2026-10-09) — c_month·ca_close …('cars' 는 밑줄이 없어 걸리지 않는다)
    // 함께 쓰는 화면은 앞 갈래 그대로 — 단 그 갈래 모듈이 없으면(세션에 남은 'c' 인데 drv-card.js 가 안 실림) 운행일지로.
    if (SHARED_VIEWS.indexOf(v) >= 0) return modeOk(NAV_MODE) ? NAV_MODE : 'd';
    return 'd';
  }
  function paintNavMode() {
    var m0 = navModeOf(VIEW);
    NAV_MODE = noDriving() && m0 === 'd' ? 'x' : m0;   // 운전 안 하는 사람은 운행일지 갈래가 없다
    try { sessionStorage.setItem('drv_navmode', NAV_MODE); } catch (e) { }
    ['d', 'x', 'c'].forEach(function (m) { document.body.classList.toggle('mode-' + m, NAV_MODE === m); });
    // 법인카드 모듈(drv-card.js)이 없으면 그 메뉴는 숨긴다(누를 곳이 없는 메뉴를 남기지 않게).
    document.body.classList.toggle('no-c', !modeOk('c'));
    var M = MODE_SYS[NAV_MODE] || MODE_SYS.d;
    var nm = $('navSysName'), ni = $('navSysIco');
    if (nm) nm.textContent = M.name;
    // 브라우저 탭 제목도 갈래 이름으로(개인경비 화면인데 「ATEC 운행일지」였다 — 2026-10-15)
    try { document.title = 'ATEC ' + M.name; } catch (e) { }
    if (ni) ni.setAttribute('href', M.ico);
    // 머리띠 로고 — 지금 갈래의 첫 화면으로(2026-10-08). 개인경비 갈래에서 누르면 운행일지 마감 현황으로 튀지 않게.
    var lg = $('appLogo');
    if (lg) {
      var LM = MODE_SYS[NAV_MODE] || MODE_SYS.d, lx = LM.home !== 'close' && VIEWS[LM.home];
      lg.setAttribute('data-v', lx ? LM.home : 'close');
      lg.setAttribute('aria-label', lx ? LM.homeLabel : MODE_SYS.d.homeLabel);
    }
    // 기간 이름표 — 개인경비는 「마감」이 아니라 20~19일 「경비 기간」, 법인카드는 1일~말일 「카드 기간」이다.
    var cl = $('cycLab');
    //   결재함 같은 공용 화면은 운행일지 기간 규칙으로 그려지므로 그냥 「기간」이라 부른다(이름표와 날짜가 어긋나지 않게).
    if (cl) cl.textContent = SHARED_VIEWS.indexOf(VIEW) >= 0 && !periodOfMode(NAV_MODE) ? '기간' : (MODE_SYS[NAV_MODE] || MODE_SYS.d).cyc;
    if (SHARED_VIEWS.indexOf(VIEW) >= 0 && $('cycleTxt')) paintCycle();      // 갈래가 바뀌면 범위 글자도
    // 결재함 숫자는 갈래마다 다르다 — 갈래가 바뀌면 다시 센다.
    paintInboxPill();
  }
  var ND_AUTO = false;           // 자료가 오기 전에 첫 화면을 정했다(다 받은 뒤 결재할 것이 있으면 결재함으로 한 번 옮긴다)

  var NOCYC_VIEWS = ['account', 'org', 'perm', 'eduadm', 'edu', 'cycset'];
  /** 포털(work.html 「시스템 선택」) 카드의 내 상태 한 줄에 쓸 것 — 이 화면이 이미 아는 것만 이 탭(sessionStorage)에 적어 둔다
      (2026-10-19 웹 사용성 1차). 이번 운행일지 기간의 내 단계·결재 상태, 종류별 「결재할 것」 수. 서버를 더 부르지 않는다. */
  function portalHint() {
    if (!LOADED || !myName() || isMulti()) return;
    try {
      var cur = cycKey(defaultCycle()), old = {};   // 포털 카드 = 처음 보일 기간(마감 뒤 GRACE_DAYS 일은 방금 끝난 기간, work.html deadlines 와 같다)
      try { old = JSON.parse(sessionStorage.getItem('drv_portal_hint') || '{}') || {}; } catch (e) { old = {}; }
      if (old.u !== myName()) old = {};
      var n = { d: 0, x: 0, c: 0 };
      inbox().forEach(function (a) {
        var k = kindOf(a), s = !k ? 'd' : k === 'expense' ? 'x' : k === 'card' ? 'c' : '';
        if (s) n[s]++;
      });
      var a = myAppr(cur);
      // 개인경비·법인카드 카드도 내 결재 상태(2026-10-20 AU6 — 이미 상신·결재 중·완료인데 「마감 N일 지남」이 빨갛게 보였다).
      //   그 모듈의 처음 보일 기간(마감 뒤 GRACE_DAYS 일은 방금 끝난 기간 — work.html deadlines 와 같다)의 내 결재 건 상태.
      var mod = function (mode) {
        var p = periodOfMode(mode);
        if (!p || !p.status) return null;
        var k = cycKey(toC(CR.defaultPeriod(kindOfMode(mode))));          // 기간 엔진(2026-10-20 연말 마감)
        var r = p.row ? p.row(k) : null;
        // ro = 정정으로 다시 연 건(포털이 「반려됨」 대신 「정정 중」 — 2026-10-21)
        return { cyc: k, st: p.status(k) || '', ro: !!(r && r.status === 'rejected' && reopenInfo(r)) };
      };
      // 포털 「오늘 할 일」(2026-10-20 디자인 v2) — 마감 화면이 그릴 때 센 남은 일(그때 시각 at 과 함께). 이 기간 것이 없으면 지난번 것을 그대로 둔다.
      var todo = CLOSE_TODO && CLOSE_TODO.cyc === cur ? CLOSE_TODO : (old.todo && old.todo.cyc === cur ? old.todo : null);
      var h = { u: myName(), at: Date.now(), cyc: cur, st: a ? a.status : '', ro: !!(a && a.status === 'rejected' && reopenInfo(a)), inbox: { d: n.d, x: n.x, c: n.c },
        step: CYCKEY() === cur ? Math.min(stepNow(), 4) : (old.cyc === cur ? old.step : null), drv: usesDriving(myName()),
        xs: mod('x'), cs: mod('c'), todo: todo };
      sessionStorage.setItem('drv_portal_hint', JSON.stringify(h));
    } catch (e) { }
  }
  /* ── 같은 화면을 다시 그려도 그 자리 그대로(2026-10-23 결재 완료 출력) ──
     render 는 #inner 를 통째로 바꾼다 — 자기 스크롤 상자(.scroll.tall)는 새로 만들어져 맨 위에서 시작하고, 누르던 칸의 초점은 body 로 간다.
     고르기는 이제 다시 그리지 않지만(finSync), 출력 기록 딱지(drv-prints repaint)·묶어 받기·자료 다시 받기는 여전히 다시 그린다 —
     그때 data-keep 상자의 스크롤과 data-fk 칸의 초점(글 칸이면 커서까지)을 되돌린다. 바라는 상자·칸만 표시한다(다른 화면은 예전 그대로).
     화면이나 기간이 바뀌었으면 맨 위에서. keepDrop() = 다음 한 번은 지키지 않는다(거르기를 바꿔 목록 자체가 달라질 때). */
  var KEEP_AT = '';
  function keepSave() {
    var at = VIEW + '|' + CYCKEY(), inner = $('inner');
    if (at !== KEEP_AT || !inner) return null;
    var k = { box: {}, fk: '', sel: null };
    Array.prototype.forEach.call(inner.querySelectorAll('[data-keep]'), function (b) {
      if (b.scrollTop || b.scrollLeft) k.box[b.getAttribute('data-keep')] = [b.scrollTop, b.scrollLeft];
    });
    var ae = document.activeElement;
    if (ae && ae !== document.body && inner.contains(ae) && ae.getAttribute('data-fk')) {
      k.fk = ae.getAttribute('data-fk');
      try { if (typeof ae.selectionStart === 'number') k.sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) { }
    }
    return k;
  }
  function keepRestore(k) {
    KEEP_AT = VIEW + '|' + CYCKEY();
    if (!k) return;
    var inner = $('inner');
    Array.prototype.forEach.call(inner.querySelectorAll('[data-keep]'), function (b) {
      var v = k.box[b.getAttribute('data-keep')]; if (v) { b.scrollTop = v[0]; b.scrollLeft = v[1]; }
    });
    var ae = document.activeElement;
    if (k.fk && (!ae || ae === document.body)) {
      var f = Array.prototype.filter.call(inner.querySelectorAll('[data-fk]'), function (n) { return n.getAttribute('data-fk') === k.fk; })[0];
      if (f) { try { f.focus({ preventScroll: true }); if (k.sel && f.setSelectionRange) f.setSelectionRange(k.sel[0], k.sel[1]); } catch (e) { } }
    }
  }
  function keepDrop() { KEEP_AT = ''; }
  function render() {
    // 운전 안 하는 사람은 결재함·개인경비·내 계정만 — 다른 화면 주소로 와도 그리로 돌린다.
    var nd = noDriving();
    document.body.classList.toggle('nodrv', nd);
    if (nd && NODRV_VIEWS.indexOf(VIEW) < 0) {
      VIEW = ndLanding(); ND_AUTO = !LOADED;
      // 운행일지 화면에서 개인경비로 돌린 것이다 — 기간도 개인경비의 이번 기간으로(20일에 지난 기간에 떨어지지 않게, 2026-10-08).
      if (!RANGE && usesXPeriod(VIEW) && cmpCycle(CYC, defCyc(VIEW)) !== 0) {
        setPeriod({ cyc: defCyc(VIEW) }, { silent: true });
        applyScope(); writeHash();
        // 받은(받는 중인) 자료는 옛 기간 것이다 — 새 기간으로 다시 받는다(loadAll 이 다시 그린다. 늦게 온 옛 응답은 LOAD_SEQ 가 버린다).
        if (LOADED || LOADING) { loadAll({ soft: true }); return; }
      } else { applyScope(); writeHash(); }
    }
    else if (nd && ND_AUTO && LOADED) {
      ND_AUTO = false;
      if (VIEW !== 'inbox' && inbox().length) { VIEW = 'inbox'; applyScope(); writeHash(); }
    }
    if (ME) paintCycle();          // 화면마다 기간 규칙이 다를 수 있다(개인경비 20~19일)
    var keep = keepSave();         // 같은 화면을 다시 그리면 표 상자 스크롤·초점 그대로(2026-10-23)
    // 적재가 실패했으면 스켈레톤 대신 사유와 다시 시도 버튼을 보여 준다.
    $('inner').innerHTML = LOAD_ERR
      ? '<section class="sect"><div class="panel" style="padding:34px 24px;text-align:center">' +
        '<div style="font-weight:700;margin-bottom:6px">' + esc(LOAD_ERR) + '</div>' +
        '<div class="dim" style="margin-bottom:16px">' + retryHint(LOAD_ERR) + '</div>' +
        '<button class="btn pri" id="btnRetryLoad">다시 불러오기</button></div></section>'
      : (LOADED ? stepChrome((VIEWS[VIEW] || viewClose)()) : (VIEWS[VIEW] || viewClose)());
    paintNavMode();
    portalHint();
    // 기간과 상관없는 화면(내 계정·조직도·권한 관리·교육 관리·안전교육)에서는 위 기간 단추를 숨긴다 — 눌러도 아무 일이 없었다(2026-10-15 2차)
    var cbx = $('cycleBox'); if (cbx) cbx.classList.toggle('nocyc', NOCYC_VIEWS.indexOf(VIEW) >= 0);
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
    keepRestore(keep);             // .tall(자기 스크롤)·찾기로 숨긴 줄이 정해진 뒤에 되돌린다
    noteFocusCard();
    // 정렬 머리를 눌러 다시 그렸으면 그 머리로 포커스를 돌려준다(키보드로 누르던 자리를 잃지 않게).
    if (SORT_FOCUS) {
      var sf = $('inner').querySelector('[data-sort="' + SORT_FOCUS + '"]');
      SORT_FOCUS = '';
      if (sf) { try { sf.focus(); } catch (e) { } }
    }
  }
  function go(v) {
    v = OLD_VIEWS[v] || v;
    if (!VIEWS[v]) return;
    // 관리 화면은 관리자만. 주소를 직접 만져도 못 들어간다(서버 RLS 가 이중으로 막는다).
    if (ADMIN_VIEWS.indexOf(v) >= 0 && !(ME && ME.is_admin)) return;
    // 권한 관리는 관리자 중에서도 마스터 계정만(서버 RPC 가 그렇게 못 박혀 있다).
    if (v === 'perm' && !ACCT.can_manage_admin) return;
    if (v === 'cycset' && !ACCT.can_manage_admin) return;     // 마감 기간 설정 — 권한 관리와 같은 사람만(2026-10-20)
    if (noDriving() && NODRV_VIEWS.indexOf(v) < 0) v = ndLanding();
    if (v !== VIEW && !KEEP_ORG && !(TAB_OF[v] && TAB_OF[v] === TAB_OF[VIEW])) ORGF = { div: '', team: '', unit: '' };
    KEEP_ORG = false;
    if (v !== VIEW) notifyGo(v, VIEW);
    // ★ 개인경비(20~19일) 화면에서 20일에 넘어간 「다음 달분」을 보다가 운행일지(21~20일) 화면으로 오면
    //   운행일지에는 아직 없는 앞날의 주기가 된다 — 그 화면의 이번 주기로 맞춘다(applyHash 와 같은 규칙).
    //   조용히 바꾼다(silent: 주소 쓰기·다시 받기는 아래에서 한 번만).
    // ★ 2026-10-08: 운행일지 갈래에서 개인경비 화면으로 들어가면(기간을 따로 고른 적 없음) 개인경비의 이번 기간으로 맞춘다.
    //   20일에는 운행일지 주기는 아직 이번 달인데 개인경비는 이미 다음 달분으로 넘어가 있다 —
    //   그대로 두면 지난 기간에 떨어진다. 개인경비 갈래 안에서 옮겨 다닐 때(결재함 등 함께 쓰는 화면을 거쳐도)는
    //   사용자가 고른 기간을 그대로 둔다.
    // 2026-10-09: 기간 규칙이 셋(운행일지 21~20 · 개인경비 20~19 · 법인카드 1~말일). 규칙이 바뀌는 이동이면(함께 쓰는 화면으로 가는 것은 빼고)
    //   그 화면의 이번 기간으로 — 25일에 법인카드(10월분)에서 운행일지로 오면 운행일지 11월분, 반대면 법인카드 10월분.
    // 2026-10-20: 들어갈 때 맞추는 기간은 그 화면의 「처음 보일 기간」(마감 뒤 GRACE_DAYS 일 동안은 방금 끝난 기간). 앞날을 당기는 것은 오늘이 든 기간까지.
    var enterX = !RANGE && SHARED_VIEWS.indexOf(v) < 0 && !samePeriod(v) && cmpCycle(CYC, defCyc(v)) !== 0;
    // ★ 함께 쓰는 화면(결재함·내 계정·사람·조직도·권한)은 기간과 무관하다 — 개인경비 갈래에서 들어가도
    //   운행일지 규칙으로 기간을 당기지 않는다(돌아왔을 때 기간이 말없이 바뀌어 있지 않게, 2026-10-08).
    var clampCyc = enterX || (!RANGE && SHARED_VIEWS.indexOf(v) < 0 && cmpCycle(CYC, curCyc(v)) > 0);
    VIEW = v;
    if (clampCyc) setPeriod({ cyc: enterX ? defCyc(v) : curCyc(v) }, { silent: true });
    // 보던 추가 기간(…-12b)이 이 화면 갈래에는 없으면 그 달로(2026-10-20 연말 마감)
    else if (fixX(v)) { setPeriod(RANGE ? { range: RANGE } : { cyc: CYC }, { silent: true }); clampCyc = true; }
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
    // 위에서 기간을 이번 주기로 당겼으면 그 주기 자료를 받는다.
    if (clampCyc && LOADED) { loadAll({ soft: true }); window.scrollTo({ top: 0 }); return; }
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
      // (함께 쓰는 화면은 기간과 무관하다 — 당기지 않는다, 2026-10-08)
      if (!RANGE && SHARED_VIEWS.indexOf(h.view) < 0 && cmpCycle(CYC, curCyc(h.view)) > 0) setPeriod({ cyc: curCyc(h.view) }, { silent: true });
      changed = hashOf().split('/')[2] !== before;
    }
    var v = h.view;
    var okView = VIEWS[v] && !(ADMIN_VIEWS.indexOf(v) >= 0 && !(ME && ME.is_admin)) && !(v === 'perm' && !ACCT.can_manage_admin) &&
      !(v === 'cycset' && !ACCT.can_manage_admin);
    // ★ 주소에 기간 없이 개인경비 화면만 적혀 왔으면(포털 카드 driving.html#/x_month, 첫 진입) 개인경비의 이번 기간으로.
    //   운행일지 주기를 그대로 쓰면 20일에는 지난 기간에 떨어진다(2026-10-08). go() 와 같은 규칙 —
    //   개인경비 갈래 안에서 옮겨 다니는 중이면 고른 기간을 그대로 둔다. 주소에 기간이 적혀 있으면 그것을 따른다(위).
    if (!h.a && okView && !RANGE && SHARED_VIEWS.indexOf(v) < 0 && !samePeriod(v) && cmpCycle(CYC, defCyc(v)) !== 0) {
      setPeriod({ cyc: defCyc(v) }, { silent: true });
      changed = true;
    }
    if (okView) {
      if (VIEW !== v) {
        if (v !== VIEW && !(TAB_OF[v] && TAB_OF[v] === TAB_OF[VIEW])) ORGF = { div: '', team: '', unit: '' };
        notifyGo(v, VIEW);
        VIEW = v; AUDIT = null; clearFilters();
        // go() 와 같은 이유 — 관리 화면에서 맞춰 둔 남의 대조 결과가 개인 화면에 남으면 안 된다.
        HP = { groups: [], batch: '', busy: false, note: '' };
      }
    }
    // 주소의 추가 기간(…-12b)이 이 화면 갈래에는 없으면 그 달로(2026-10-20 연말 마감 — #/x_month/2026-12b → 12월분)
    //   주소도 그 달로 바로잡는다 — 열린 화면에서 주소만 바꾸면(hashchange) 화면은 12월분인데 주소가 12b 로 남았다.
    //   replaceState: 방문 기록을 늘리지 않고 hashchange 도 다시 일으키지 않는다(들어올 때 enter() 가 하는 것과 같다).
    if (fixX()) {
      setPeriod(RANGE ? { range: RANGE } : { cyc: CYC }, { silent: true }); changed = true;
      try { history.replaceState(null, '', location.pathname + location.search + hashOf()); } catch (e) { }
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
      toast('저장하지 않은 통행료가 ' + n0(unsavedFills()) + '구간 있어요. 먼저 저장해 주세요.', true);
      return;
    }
    closePanel();
    var oldV = OLD_VIEWS[(/^#\/([a-z_]+)/.exec(location.hash || '') || [])[1]];
    if (applyHash(h)) { loadAll({ soft: true }); if (oldV) writeHash(); return; }
    if (oldV) writeHash();             // 예전 관리 화면 주소(#/a_close 등) → 주소도 「현황」으로 고쳐 쓴다(2026-10-15 2차)
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
    /* ── 알림(종) ── 좁은 폰에서는 이름 단추가 알림 창을 연다(창 안에 「내 계정」). */
    if (e.target.closest('#bellBtn') || (e.target.closest('#uBtn') && bellNarrow())) { openNotePop(); return; }
    if ((el = e.target.closest('[data-note]'))) { noteOpen(el.dataset.note); return; }
    if (e.target.closest('[data-noteall]')) {
      noteReadAll();
      var nf = $('notePop') && $('notePop').querySelector('.ni,button'); if (nf) { try { nf.focus({ preventScroll: true }); } catch (er) { } }
      return;
    }
    if (e.target.closest('[data-noteacct]')) { openNotePop(false); go('account'); return; }
    if (NOTE.open && !e.target.closest('#noteBox')) openNotePop(false);
    if ((el = e.target.closest('[data-inboxmode]'))) {
      NAV_MODE = MODE_NAME[el.dataset.inboxmode] ? el.dataset.inboxmode : 'd'; INBOX_F = 'all';
      if (VIEW === 'inbox') render(); else go('inbox');
      window.scrollTo({ top: 0 }); return;
    }
    if (e.target.closest('#btnKeep')) {
      if (CLOSE_ASK != null) { $('pFoot').innerHTML = CLOSE_ASK; CLOSE_ASK = null; }
      // 되묻는 사이에 AI 판독이 끝났으면 올리기 버튼이 옛 상태('읽는 중…')로 되살아난다 — 다시 맞춘다.
      if ($('evDrop')) paintEvList();
      return;
    }
    if (e.target.closest('#btnDiscard')) { closePanel(); return; }
    if (e.target.closest('[data-close]')) { askClose(); return; }
    /* ── 안전교육(2026-10-14) — 시청 창 · 교육 관리 ── */
    if ((el = e.target.closest('[data-eduplay]'))) { eduOpenWatch(el.dataset.eduplay); return; }
    if ((el = e.target.closest('[data-educg]'))) { var cg = $('eduCongrats'); if (cg) { cg.hidden = true; cg.innerHTML = ''; } return; }
    if ((el = e.target.closest('[data-eatab]'))) { EDU_ADM.tab = el.dataset.eatab === 'status' ? 'status' : 'videos'; render(); return; }
    if (e.target.closest('[data-eduadd]')) { eduVideoForm(null); return; }
    if ((el = e.target.closest('[data-eduedit]'))) {
      var ev0 = EDUV.filter(function (x) { return String(x.id) === el.dataset.eduedit; })[0];
      if (ev0) eduVideoForm(ev0); return;
    }
    if ((el = e.target.closest('[data-edudel]'))) {
      var ev1 = EDUV.filter(function (x) { return String(x.id) === el.dataset.edudel; })[0];
      if (ev1) eduDelAsk(ev1); return;
    }
    if ((el = e.target.closest('#btnEduSave'))) { eduSaveVideo(el.dataset.id || ''); return; }
    if ((el = e.target.closest('#btnEduDelGo'))) { eduDelVideo(el.dataset.id); return; }
    /* ── 기간 고르기 ── */
    if (e.target.closest('#cycBtn')) { openCyclePop(); return; }
    if (e.target.closest('#cycPrev')) { stepCycle(-1); return; }
    if (e.target.closest('#cycNext')) { stepCycle(1); return; }
    if (e.target.closest('#cpGo')) {
      var cf0 = parseCyc($('cpFrom').value), ct0 = parseCyc($('cpTo').value);
      if (cf0 && ct0) setPeriod({ range: { from: cf0, to: ct0 } });
      return;
    }
    if ((el = e.target.closest('[data-fixgo]'))) {
      var cf = parseCyc(el.dataset.fixcyc);
      if (cf) setPeriod({ cyc: cf });
      go(el.dataset.fixgo);
      return;
    }
    if ((el = e.target.closest('[data-cyc]'))) {
      var c1 = parseCyc(el.dataset.cyc);
      // 창 안의 버튼(운행 상세의 'N월분 열어 고치기')에서 왔으면 창을 닫고 넘어간다.
      if (c1 && el.closest('#panel')) closePanel();
      if (c1) setPeriod({ cyc: c1 });
      return;
    }
    if ((el = e.target.closest('[data-safeall]'))) { SAFE_ALL = el.dataset.safeall === '1'; render(); return; }
    if ((el = e.target.closest('[data-noticex]'))) { noticeClose(el.dataset.noticex); render(); return; }
    if ((el = e.target.closest('[data-noticemore]'))) {
      var nb = el.closest('.hpnote.notice'), nk = el.dataset.noticemore;
      NOTICE_OPEN[nk] = !NOTICE_OPEN[nk];
      if (nb) nb.classList.toggle('open', NOTICE_OPEN[nk]);
      el.setAttribute('aria-expanded', String(NOTICE_OPEN[nk])); el.textContent = NOTICE_OPEN[nk] ? '접기' : '자세히';
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
    if (e.target.closest('[data-fclear]')) { clearFilters(); FILT.purp = ''; render(); return; }   // 「조건 지우기」는 목적까지 비운다
    if ((el = e.target.closest('[data-inboxf]'))) { INBOX_F = el.dataset.inboxf; render(); return; }
    if ((el = e.target.closest('[data-ibcyc]'))) {
      INBOX_ALLCYC = el.dataset.ibcyc === '1';
      if (!INBOX_ALLCYC) { INBOX_D1 = ''; INBOX_D2 = ''; }   // 고른 달로 돌아가면 날짜 조건은 지운다
      render(); return;
    }
    if (e.target.closest('[data-ibreset]')) { INBOX_ALLCYC = false; INBOX_Q = ''; INBOX_D1 = ''; INBOX_D2 = ''; INBOX_F = 'all'; render(); return; }
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
    if ((el = e.target.closest('[data-v]'))) { if (el.hasAttribute('data-keeporg')) KEEP_ORG = true; go(el.dataset.v); return; }
    // 점검 칩은 목적과 상관없이 보인다(출퇴근·목적 미선택 칩이 일반업무 필터에 가려지지 않게).
    if ((el = e.target.closest('[data-chip]'))) { FILT.chip = el.dataset.chip; if (FILT.chip !== 'all') FILT.purp = ''; render(); return; }
    if ((el = e.target.closest('[data-issue]'))) {
      // go() 가 필터를 비우므로 반드시 go() **뒤에** 넣어야 한다. 예전에는 앞에 넣어
      // 필터가 날아갔고, 화면도 개인 운행일지로 못 박혀 있어 전체 점검에서 누르면
      // 보러 간 건이 한 건도 안 보였다.
      var issue = el.dataset.issue;
      // 미확정 통행료는 2단계 영수증 › 통행료 차례로(예전 「통행료 채우기」 화면은 없앴다 — 2026-10-15 사용자: 영수증으로만).
      if (issue === 'unk' && !isAll()) { tollBack(); return; }
      var fromStatus = VIEW === 'a_status';
      KEEP_ORG = true;                     // 같은 범위를 그대로 들고 간다(팀을 골라 놓고 미확정을 누르면 그 팀 것만)
      go(isAll() ? 'a_trips' : 'trips');
      FILT.chip = issue; FILT.who = ''; FILT.purp = '';   // 점검 항목은 목적과 관계없이 다 보인다
      // 관리 현황 「바로 봐야 할 기록」은 「사람별로 봅니다」라고 말한다 — 전체 운행 기록을 소속·이름 순으로 묶어 연다(2026-10-19 로봇)
      if (fromStatus) SORTS.tr = 'who:1';
      render(); return;
    }
    // 줄 전체를 누르면 그 운행 고치기 — 단 줄 안의 「다른 운행에 붙이기」(두 번 정산 의심 줄, 2026-10-20)는 그 단추가 먼저다(아래 data-evlink)
    //   줄 끝 「올리기」(영수증 없음, 2026-10-20 디자인 v2)도 그 단추가 먼저다(아래 data-evupcat — 영수증 올리기 창)
    //   줄 끝 「확인」(같은 금액 영수증, 2026-10-21)도 그 단추가 먼저다(아래 data-dupfill — 확인 창)
    if ((el = e.target.closest('[data-edit]')) && !e.target.closest('[data-evlink]') && !e.target.closest('[data-evupcat]') && !e.target.closest('[data-dupfill]')) { openEdit(el.dataset.edit); return; }
    // 같은 금액 영수증 확인 창(2026-10-21 통행료 버그 2) — 맞춰보기 표 그 줄 · 마감 화면 남은 일의 「확인」 · 창 아래 [적기]
    if ((el = e.target.closest('[data-dupfill]'))) { var dfp = String(el.dataset.dupfill).split('|'); openDupFill(dfp[0], dfp[1]); return; }
    if (e.target.closest('#btnDupGo')) { dupFillGo(); return; }
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
    // 검증 항목 R02(통행료 미확정)·R13(운행 없는 영수증) → 영수증 › 그 차례로(2026-10-15)
    if ((el = e.target.closest('[data-evstep]'))) { var si = EV_SUBS.indexOf(el.dataset.evstep); setEvSub(si < 0 ? 0 : si); closePanel(); go('evid'); return; }
    if ((el = e.target.closest('[data-mfold]'))) { var mfc = el.dataset.mfold; MFOLD[mfc] = MFOLD[mfc] === false; render(); return; }
    if ((el = e.target.closest('[data-evlink]'))) { openEvLink(el.dataset.evlink, el.dataset.evlinkid); return; }
    if (e.target.closest('#btnEvLinkSave')) { saveEvLink(); return; }
    // 통행료 맞추기 제안(2026-10-21) — 통행료 차례 한 줄의 「제안 보기·맞추기」 · 창 아래 [N건 맞추기]
    if (e.target.closest('[data-tollsugopen]')) { openTollSug(); return; }
    if (e.target.closest('#btnTsApply')) { tsApply(); return; }
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
    if (e.target.closest('[data-tollback]')) {
      if (VIEW === 'tollfill' && unsavedFills()) { toast('저장하지 않은 통행료가 ' + n0(unsavedFills()) + '구간 있어요. 먼저 저장해 주세요.', true); return; }
      tollBack(); return;
    }
    if ((el = e.target.closest('[data-evsubmove]'))) {
      var d = +el.dataset.evsubmove, ti = evSub() + d;
      setEvSub(ti, d > 0 ? 'fwd' : 'back');
      toast(d > 0 ? (ti + 1) + '/4 ' + EV_SUBS[ti] + ' 차례예요.' : (ti + 1) + '/4 ' + EV_SUBS[ti] + ' 차례로 돌아왔어요.');
      render(); evSubTop(); return;
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
        var ne = document.querySelector('[data-evrow="' + (ai0 + 1) + '"] [data-evamt]') ||
          document.querySelector('[data-evrow="' + (ai0 + 1) + '"] [data-evcatsel]');   // 계기판 줄은 금액 칸이 없다(2026-10-21)
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
        toast(filled ? '비어 있던 구분과 날짜를 첫 줄 값으로 채웠어요.' : '채울 빈칸이 없어요.');
      }
      return;
    }
    if ((el = e.target.closest('[data-evdel]'))) { evDelete(el.dataset.evdel); return; }
    if ((el = e.target.closest('#btnEvDelGo'))) { runEvDelete(el.dataset.id); return; }
    if (e.target.closest('#btnCsv')) { downloadCsv(); return; }
    if (e.target.closest('#btnStatusCsv')) { statusCsv(); return; }
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
    if ((el = e.target.closest('[data-anode]'))) {
      APPR_NODE = el.dataset.anode; APPR_Q = '';
      var qn = $('apprQ'); if (qn) qn.value = '';
      var cn = $('apprCand'); if (cn) cn.innerHTML = apprCandHtml();
      // 다시 그리면 누른 버튼이 사라진다 — 같은 자리 버튼에 초점을 돌려준다.
      var again = null;
      Array.prototype.forEach.call(document.querySelectorAll('[data-anode]'), function (b) { if (b.dataset.anode === APPR_NODE) again = b; });
      if (again) again.focus();
      return;
    }
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
      toast(n0(marked) + '건을 없음으로 표시했어요. ‘' + n0(doneNow) + '건 저장’을 눌러야 저장돼요.');
      return;
    }
    if (e.target.closest('#tfSave')) { tfSave(); return; }
    if ((el = e.target.closest('[data-perm]'))) {
      openPermConfirm('admin', el.dataset.perm, el.dataset.on === '1'); return;
    }
    if ((el = e.target.closest('[data-drvset]'))) { openDrvSet(el.dataset.drvset, el.dataset.on === '1'); return; }
    if ((el = e.target.closest('#btnDrvSetGo'))) { if (!el.disabled) runDrvSet(el.dataset.target, el.dataset.on === '1'); return; }
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
    if ((el = e.target.closest('#btnOpenSubmit'))) { openSubmit(el.dataset.kind || ''); return; }
    if ((el = e.target.closest('[data-orgteam]'))) {
      var tp = el.dataset.orgteam.split('|'); ORGF = { div: tp[0] || '-', team: tp[1] || '', unit: '' }; saveOrgF();
      PAGES = {}; AUDIT = null; applyScope(); render(); window.scrollTo({ top: 0, behavior: (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') }); return;
    }
    if ((el = e.target.closest('[data-orgunit]'))) { ORGF.unit = el.dataset.orgunit; saveOrgF(); PAGES = {}; AUDIT = null; applyScope(); render(); return; }
    if ((el = e.target.closest('[data-permf]'))) {
      PERMF = el.dataset.permf;
      Array.prototype.forEach.call(document.querySelectorAll('[data-permf]'), function (b) {
        var on = b.dataset.permf === PERMF; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      permFilter(); return;
    }
    if (e.target.closest('#permX')) { PERMQ = ''; var pq = $('permQ'); if (pq) { pq.value = ''; pq.focus(); } permFilter(); return; }
    if (e.target.closest('#ofClear')) { ORGF = { div: '', team: '', unit: '' }; saveOrgF(); PAGES = {}; AUDIT = null; applyScope(); render(); return; }
    if (e.target.closest('#btnPrevLine')) {
      var pv = previousSteps();
      if (pv) { DRAFT = pv.slice(); FILL_SRC[draftKey()] = { src: 'last', notes: [] }; APPR_Q = ''; APPR_BOX = ''; renderSubmit(); }
      return;
    }
    if (e.target.closest('#btnApprPdf')) { doPrint(); return; }
    // 결재란 칸 — 빈칸을 누르면 그 칸에 넣을 이름을 받는다. × 는 그 칸을 비운다(빗금 · 건너뜀).
    // × 를 먼저 본다 — 채운 칸 전체가 data-agbox(눌러서 바꾸기)라서 × 도 그 안에 있다.
    if ((el = e.target.closest('[data-agclr]'))) {
      var cb = el.dataset.agclr;
      DRAFT = DRAFT.filter(function (s) { return s.box !== cb; });
      if (FILL_SRC[draftKey()]) FILL_SRC[draftKey()].edited = true;
      APPR_BOX = cb; APPR_Q = ''; renderSubmit();
      var qc = $('apprQ'); if (qc) qc.focus();
      return;
    }
    if ((el = e.target.closest('[data-agbox]'))) {
      APPR_BOX = el.dataset.agbox; APPR_SWAP = !!draftAt(APPR_BOX); APPR_Q = ''; renderSubmit();
      var qb = $('apprQ'); if (qb) qb.focus();
      return;
    }
    if (e.target.closest('#btnSubmitAppr')) {
      var bad = DRAFT.filter(function (s) { return !s.approver; });
      if (!DRAFT.length) { toast('결재자를 한 명 이상 넣어 주세요.', true); return; }
      if (bad.length) { toast('아직 고르지 않은 결재자가 있어요.', true); return; }
      var sb = $('btnSubmitAppr');
      if (sb.disabled) return;
      // ★ 주기(21일~20일)가 끝나기 전이면 한 번 묻는다 — 상신하면 그 뒤 운행·영수증은 결재 문서에 들어가지 않는다
      //   (2026-10-02 사용자 결정: 막지 않고 되묻고 허용).
      //   2026-10-15 2차: 예전에는 「기간 중」 되묻기(그래도 상신)와 「맞지 않는 곳」 되묻기(그대로 상신)를 차례로 두 번 물었다 —
      //   이제 검증을 먼저 돌리고, 걸리는 것을 한 번에 보여 주고 단추 하나 「그래도 상신」으로 묻는다.
      var subKind = SUB_KIND, subKD = kindDef(subKind);      // 누른 순간의 문서 종류(창이 바뀌어도 그대로)
      var rEnd = subKD ? subKD.rangeHi() : cycleRange(CYC).hi;
      var earlyMsg = '';
      if (Date.now() < rEnd) {
        var endD = md(rEnd - 1);
        // 개인경비는 「뒤의 경비가 빠진다」가 아니다 — 상신하면 그 기간이 잠겨 회수 전에는 영수증을 더 올리거나 고칠 수 없다(2026-10-08).
        earlyMsg = subKD
          ? '아직 기간이 끝나지 않았어요. 이 기간은 ' + esc(endD) + '까지예요. 상신하면 회수하기 전에는 이 기간의 ' + (subKD.earlyNoun || '영수증을 더 올리거나') + ' 고칠 수 없어요.'
          : '아직 기간이 끝나지 않았어요. 이 기간은 ' + esc(endD) + '까지예요. 지금 상신하면 이후 운행과 영수증은 결재 문서에 들어가지 않아요.';
      }
      sb.disabled = true; sb.textContent = '검증하는 중…';
      var cyc0 = CYCKEY();
      // 창을 닫거나(취소·Esc) 결재선을 고쳐 창을 다시 그리면 이 표가 바뀐다 —
      // 검증이 끝난 뒤에, 다시 누르지도 않았는데 말없이 상신되지 않게.
      var token = SUBMIT.token = {};
      var alive = function () { return SUBMIT.token === token && $('panel').classList.contains('open'); };
      // 창이 닫혔을 때만 '취소했다'고 말한다. 결재선을 고쳐 다시 그린 것이면 화면에 「상신」 버튼이 돌아와 있다.
      var gone = function () { if (!$('panel').classList.contains('open')) toast('상신하지 않고 닫았어요.'); };
      var send = function () {
        if (!alive()) { gone(); return; }
        // ★ 결재선은 보내는 순간의 화면에서 읽는다. 누른 순간에 만들어 두면, '그대로 상신할까요?' 가 떠 있는 동안
        //   결재란 칸을 바꿔도 옛 결재선으로 올라간다(2026-10-02 재검증).
        if (!DRAFT.length || DRAFT.some(function (s) { return !s.approver; })) {
          toast('결재선을 다시 확인해 주세요.', true); renderSubmit(); return;
        }
        // box_set 'v2' — 새 결재란 칸(담당·센터·파트장·팀장·사업부장·대표이사)으로 올린다는 표시(2026-10-14). 세 문서 같다.
        var payload = {
          action: 'submit', cycle: cyc0, box_set: 'v2',
          steps: DRAFT.map(function (s) { return { approver: s.approver, box: s.box }; })
        };
        if (subKD) payload.kind = subKind;             // 개인경비 상신 — 서버가 그 기간 expense_items 를 굳힌다
        // 상신 의견(선택, 2026-10-21) — 결재선처럼 보내는 순간의 칸에서 읽는다. 비었으면 보내지 않는다(서버도 빈 글은 의견 없음).
        var nkey = myName() + '|' + (subKD ? subKind + ':' : '') + cyc0;
        var noteEl = $('subNote'), noteTxt = String(noteEl ? noteEl.value : (SUB_NOTE[nkey] || '')).trim();
        if (noteTxt) payload.note = noteTxt;
        var b = $('btnSubmitAnyway') || sb;
        if (document.contains(b)) { b.disabled = true; b.textContent = '상신하는 중…'; }
        callAppr(payload, '상신했어요.').then(function (ok) {
          if (ok) { delete SUB_NOTE[nkey]; delete SUB_NOTE_PREV[nkey]; }     // 올라간 의견은 결재 건에 있다 — 적던 글은 지운다
          // 상신되면 그 주기는 잠긴다 — 통행료 채우기에 쳐 둔 값은 더 저장할 수 없다.
          if (ok && subKD) delete DRAFT_KEEP[subKind + ':' + cyc0];
          else if (ok) { FILLS = {}; delete DRAFT_KEEP[cyc0]; }
          if (!ok && document.contains(b)) { b.disabled = false; b.textContent = b.id === 'btnSubmitAnyway' ? '그래도 상신' : '상신'; }
        });
      };
      SUBMIT.send = send;
      // 검증·사진 판독이 실패해도 상신은 한다(불일치는 표시만 — 2026-10-01 결정).
      // 다만 '맞지 않는 곳'이 있으면 잠기기 전에 한 번 보여 준다 — 상신 뒤에 알면 회수해야 한다.
      var bfs = subKD ? subKD.beforeSubmit : EXT.beforeSubmit;
      (bfs
        ? bfs(function (t) { if (alive() && document.contains(sb)) sb.textContent = t + '…'; })
        : Promise.resolve(null)).then(function (sum) {
        // 확장 모듈이 상신을 멈췄다(개인경비: PDF 미리보기 뒤에 경비가 바뀜, 2026-10-08) — 창 닫기·안내는 모듈이 했다.
        if (sum && sum.blocked) return;
        if (!alive()) { gone(); return; }
        var badMsg = sum && sum.bad > 0 ? '검증에서 맞지 않는 곳이 ' + n0(sum.bad) + '건 있어요.' : '';
        if (earlyMsg || badMsg) {
          // 두 가지를 한 번에 — 단추는 하나(그래도 상신)
          $('pFoot').innerHTML = '<span class="st subwarn ' + (badMsg ? 'bad' : 'warn') + '" data-subwarn>' +
            [badMsg, earlyMsg].filter(Boolean).join('<br>') + '<br>그래도 상신할까요?</span>' +
            '<button class="btn" data-close>취소</button>' +
            (badMsg ? '<button class="btn" id="btnSeeVerify">검증 결과 보기</button>' : '') +
            '<button class="btn pri" id="btnSubmitAnyway">그래도 상신</button>';
          return;
        }
        send();
      }, function () {
        // 검증이 실패해도 상신은 한다 — 기간 중이면 그것만 묻는다
        if (!alive()) { gone(); return; }
        if (!earlyMsg) { send(); return; }
        $('pFoot').innerHTML = '<span class="st subwarn warn" data-subwarn>' + earlyMsg + '<br>그래도 상신할까요?</span>' +
          '<button class="btn" data-close>취소</button><button class="btn pri" id="btnSubmitAnyway">그래도 상신</button>';
      });
      return;
    }
    if (e.target.closest('#btnSubmitAnyway')) { if (SUBMIT.send) SUBMIT.send(); return; }
    if (e.target.closest('#btnSeeVerify')) {
      var svk = kindDef(SUB_KIND);
      closePanel(); go(svk && svk.verifyView ? svk.verifyView : 'verify'); return;
    }
    if (e.target.closest('#btnBackAppr')) {
      var bk = APPR_BACK; APPR_BACK = null;
      if (bk) { openApprAct(bk.act, bk.id, bk.kind); if ($('apprWhy')) $('apprWhy').value = bk.why; }
      return;
    }
    if ((el = e.target.closest('[data-appr]'))) { openApprAct(el.dataset.appr, +el.dataset.id, el.dataset.kind || ''); return; }
    if ((el = e.target.closest('#btnApprGo'))) {
      var act = el.dataset.act, id = +el.dataset.id;
      var why = String(($('apprWhy') || {}).value || '').trim();
      if ((act === 'reject' || act === 'force_reject' || act === 'reopen' || act === 'recall_reject') && !why) {
        toast(act === 'reopen' ? '정정 사유를 적어 주세요.' : '반려 사유를 적어 주세요.', true); if ($('apprWhy')) $('apprWhy').focus(); return;
      }
      if (el.disabled) return;
      el.disabled = true;
      var p2 = { action: act, id: id };
      if (el.dataset.kind) p2.kind = el.dataset.kind;          // 개인경비 결재 건이면 서버가 개인경비 표를 쓴다
      // 낡은 결재 화면 막기(2026-10-20 서버·웹 약속, 세 시스템 모든 결재 동작) — 이 창을 그린 결재 행의 상신 시각을 그대로 싣는다.
      //   그 사이 회수·다시 상신으로 문서가 바뀌었으면 서버가 409 STALE 로 돌려보낸다(옛 금액을 보고 새 금액을 승인하지 않게).
      if (el.dataset.sub) p2.expect_submitted_at = el.dataset.sub;
      if (why && act !== 'withdraw') p2.comment = why;
      // 서버가 문구를 안 보내는 동작(회수)도 무엇을 했는지 말한다 — 예전엔 「처리했습니다.」(2026-10-15 매뉴얼 로봇)
      var okWord = { withdraw: '회수했어요. 고친 뒤 다시 상신하세요.', approve: '승인했어요.', reject: '반려했어요.',
        recall_reject: '승인을 취소하고 상신자에게 반려했어요.' }[act];
      callAppr(p2, okWord).then(function (ok) { if (!ok && document.contains(el)) el.disabled = false; });
      return;
    }
    // 상신 뒤 유류단가가 바뀐 운행일지 승인(2026-10-20 RATE_CHANGED) — 「그래도 승인」은 같은 요청 + ack, 「반려하기」는 반려 창(사유 미리 적음)
    if ((el = e.target.closest('#btnRateGo'))) {
      var ra = RATE_ASK;
      if (!ra || el.disabled) return;
      el.disabled = true;
      var p3 = {}; Object.keys(ra.payload).forEach(function (k) { p3[k] = ra.payload[k]; });
      p3.ack_rate_change = true;
      var w3 = String(($('apprWhy') || {}).value || '').trim();       // 묻는 동안 고친 의견도 함께
      if (w3) p3.comment = w3; else delete p3.comment;
      callAppr(p3, ra.okMsg).then(function (ok) { if (!ok && document.contains(el)) el.disabled = false; });
      return;
    }
    if (e.target.closest('#btnRateReject')) {
      var rr = RATE_ASK;
      if (!rr) return;
      openApprAct('reject', +rr.payload.id, rr.payload.kind || '');
      if ($('apprWhy')) $('apprWhy').value = rr.head + ' 바뀐 단가로 다시 상신해 주세요.';
      return;
    }
  });
  document.addEventListener('change', function (e) {
    // 금액·계기판 칸(운행일지·개인경비 모두) — 칸을 떠날 때 숫자·쉼표 밖의 글자가 있으면 바로 표시(2026-10-20 AU2 #9). 막는 것은 저장 단추가 한다.
    if (e.target.matches && e.target.matches('input.num[inputmode="numeric"]')) numMark(e.target);
    if (e.target.closest && e.target.closest('#evList [data-evrow]')) evHpNotes();   // 구분·날짜를 바꾸면 하이패스 안내도 다시(웹 8차)
    if (e.target.matches && e.target.matches('[data-tspick],#tsAll')) { tsPick(e.target); return; }   // 통행료 맞추기 제안 창 고르기(2026-10-21)
    // 같은 금액 영수증 확인 창 — 고르면 [적기]가 풀린다(2026-10-21 통행료 버그 2)
    if (e.target.matches && e.target.matches('input[name="dupfill"]')) { var dg = $('btnDupGo'); if (dg) dg.disabled = false; return; }
    if (e.target.id === 'signFile') {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (f.size > 20e6) { toast('파일이 너무 커요. 20MB 이하로 올려 주세요.', true); return; }
      toast('서명을 읽는 중…');
      fileToSign(f).then(function (png) { SIGN_DRAFT = png; render(); },
        function (err) { toast((err && err.message) || '서명을 읽지 못했어요.', true); });
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
    // 통행료 차례의 「하이패스 이용내역 PDF 올리기」(웹 8차) — 고르자마자 하이패스 화면으로 가서 읽은 결과를 보인다
    if (e.target.id === 'hpQuick') {
      var hq = Array.prototype.slice.call(e.target.files || []), isPdf = function (f) { return /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name); };
      var hpdf = hq.filter(isPdf), hpic = hq.filter(function (f) { return !isPdf(f); });
      // 사진을 여기로 골랐으면 영수증 올리기 창으로 넘긴다(2026-10-17 모르는 로봇 — 사진이 하이패스 칸으로 들어가 「읽지 못한 파일」)
      if (!hpdf.length && hpic.length) { openEvUpload('통행료'); evAddFiles(hpic); toast('사진이라 영수증 올리기 창으로 옮겼어요. 하이패스 버튼은 이용내역 PDF만 받아요.'); return; }
      if (hpdf.length) { go('hipass'); hpFiles(hpdf); if (hpic.length) toast('사진 ' + hpic.length + '장은 빼고 PDF만 읽어요. 영수증 사진은 ‘영수증 사진 올리기’로 올려 주세요.', true); }
      return;
    }
    if (e.target.id === 'evFile') { evAddFiles(e.target.files); e.target.value = ''; return; }
    if (e.target.dataset && e.target.dataset.hpcar !== undefined) {
      var g = HP.groups[+e.target.dataset.hpcar];   // 아래에서 재배분 후 잠금 표시를 다시 단다
      g.plate = e.target.value || null;
      // 원본만 붙이기(2026-10-23) — 받아 둔 근거로 바로 표시하고, 새로 맞은 이미 맞춘 운행의 근거는 받아 와서 바뀌었을 때만 다시 그린다
      hpMarkKeep(hpMarkLocked([window.Hipass.assign(g, TRIPS)]));
      var hpc = HP, hgs = HP.groups, hpl = g.plate;
      hpScanKeep([g]).then(function () {
        if (HP !== hpc || HP.groups !== hgs || g.plate !== hpl) return;
        var k0 = hpKeepCount([g]);
        hpMarkKeep([g]);
        if (hpKeepCount([g]) !== k0) render();
      });
      render(); return;
    }
    if (e.target.id === 'cPlate') {
      var etc = $('cPlateEtc'); if (etc) etc.hidden = e.target.value !== '__etc__';
      if (etc && !etc.hidden) etc.focus();
      return;
    }
    // ── 상신 창 ──
  });
  /* 영수증 화면 「올리기」 카드에 사진·PDF 를 끌어 놓기(2026-10-20 디자인 v2, P_Evid) — 기존 영수증 올리기 창(openEvUpload)을 그 구분으로 열고
     놓은 파일을 그대로 넣는다(하이패스 단추에 사진을 고른 경우와 같은 길). 잠긴 기간·여러 기간·올리는 중이면 openEvUpload 가 까닭을 알린다. */
  var evDropZone = function (e) { return e.target && e.target.closest ? e.target.closest('[data-evdrop]') : null; };
  document.addEventListener('dragover', function (e) {
    var z = evDropZone(e); if (!z) return;
    e.preventDefault(); z.classList.add('over');
  });
  document.addEventListener('dragleave', function (e) {
    var z = evDropZone(e); if (z && !z.contains(e.relatedTarget)) z.classList.remove('over');
  });
  document.addEventListener('drop', function (e) {
    var z = evDropZone(e); if (!z) return;
    e.preventDefault(); z.classList.remove('over');
    var fs = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
    if (!fs.length) return;
    var blocked = isMulti() || cycleLocked(myName()) || EV_SENDING;
    openEvUpload(z.dataset.evdrop);
    if (!blocked) evAddFiles(fs);
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
    if (e.target.id === 'qBox' || e.target.id === 'ibQ') { IME = true; clearTimeout(window.__q); }
  });
  document.addEventListener('compositionend', function (e) {
    if (e.target.id !== 'qBox' && e.target.id !== 'ibQ') return;
    IME = false;
    if (e.target.id === 'ibQ') INBOX_Q = e.target.value; else FILT.q = e.target.value;
    queueSearch(e.target);
  });
  // 결재함 그 밖의 건 — 상신일 칸은 고르면 바로 다시 그린다(2026-10-14)
  document.addEventListener('change', function (e) {
    if (e.target.id === 'eduAdmMonth') { EDU_ADM.month = e.target.value || ''; render(); return; }
    if (e.target.id === 'ibD1' || e.target.id === 'ibD2') {
      if (e.target.id === 'ibD1') INBOX_D1 = e.target.value || ''; else INBOX_D2 = e.target.value || '';
      // 날짜로 찾으면 다른 달 것도 보여야 한다 — 기간 고정을 푼다
      if (INBOX_D1 || INBOX_D2) INBOX_ALLCYC = true;
      render();
    }
  });
  document.addEventListener('input', function (e) {
    if (e.target.closest && e.target.closest('#evList [data-evrow]')) evHpNotes();
    if (e.target.id === 'permQ') { PERMQ = e.target.value; permFilter(); return; }
    // 상신 의견 — 적는 대로 맡아 둔다(결재선을 고쳐 창을 다시 그려도 그대로, 2026-10-21). 다시 그리지 않는다(한글 조합이 끊긴다).
    if (e.target.id === 'subNote') { SUB_NOTE[myName() + '|' + draftKey()] = e.target.value; return; }
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
    if (e.target.id === 'ibQ') { INBOX_Q = e.target.value; if (!IME) queueSearch(e.target); return; }
    if (e.target.id !== 'qBox') return;
    FILT.q = e.target.value;
    if (IME) return;                       // 조합이 끝나면 compositionend 가 부른다
    queueSearch(e.target);
  });
  function queueSearch(box) {
    clearTimeout(window.__q);
    var id = box.id;
    window.__q = setTimeout(function () {
      var pos = box.selectionStart;
      render();
      var b = $(id); if (b) { b.focus(); b.setSelectionRange(pos, pos); }
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
        e.target.matches && e.target.matches('a[data-v],tr.clk,tr[data-person],tr[data-car],span[data-eduplay]')) {
      e.preventDefault(); e.target.click(); return;
    }
    if (e.key === 'Escape') {
      // 결재 완료 출력 이름 찾기 — Esc 로 비운다(비어 있으면 아래 원래 동작, 2026-10-23)
      if (e.target.matches && e.target.matches('input[data-finq]') && e.target.value) { e.preventDefault(); finClear(e.target.dataset.finq, false); return; }
      if (!$('cycPop').hidden) { openCyclePop(false); return; }
      if (NOTE.open) {
        openNotePop(false);
        var nb = bellNarrow() ? $('uBtn') : $('bellBtn'); if (nb) { try { nb.focus(); } catch (er) { } }
        return;
      }
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
    if (e.key === 'Escape' && e.target.id === 'permQ' && PERMQ) { e.preventDefault(); e.stopPropagation(); PERMQ = ''; e.target.value = ''; permFilter(); return; }
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
    // 보던 안전교육 영상의 마지막 위치를 토큰이 지워지기 전에 저장한다(2026-10-14 검증로봇).
    if (EDUW) { EDUW.gone = true; eduStop(); }
    // 서버의 갱신 토큰도 끊는다(2026-10-06). 응답을 기다리지 않는다.
    var at = ss(K_AT);
    if (at) { try { fetch(SB + '/auth/v1/logout?scope=local', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + at }, keepalive: true }).catch(function () { }); } catch (e) { } }
    ss(K_AT, null); ss(K_RT, null); ss(K_ME, null);
    // 메뉴 갈래도 지운다(2026-10-08) — 같은 탭에서 다른 사람이 로그인하면 앞사람의 갈래(개인경비)로 열리지 않게.
    try { sessionStorage.removeItem('drv_navmode'); } catch (e2) { }
    tabMemClear();
    // 직접 로그아웃이면 포털 첫 화면, 로그인이 만료된 것이면 다시 로그인한 뒤 보던 화면으로 돌아오게.
    toPortal(e && e.type === 'click' ? '' : location.hash);
  }
  /** 이 탭에 남긴 사람에 딸린 화면 기억 — 펼친 결재 문서(apv.*) · 영수증 차례(drv.evsub.*)를 지운다(2026-10-21 매뉴얼 로봇:
   *  로그아웃한 뒤 같은 탭에서 다른 사람으로 들어오면 앞사람이 펼쳐 둔 문서가 펼친 채 남았다). 열쇠도 사람마다라 지우지 못해도 섞이지는 않는다.
   *  work.html 로그아웃(leave)도 같은 것을 지운다. */
  function tabMemClear() {
    try {
      // 열쇠를 먼저 다 모은 뒤 지운다 — 지우면서 key(i) 를 돌면 차례가 바뀌어 하나씩 남았다
      var ks = [];
      for (var i = 0; i < sessionStorage.length; i++) ks.push(sessionStorage.key(i));
      ks.forEach(function (k) { if (k && (k.indexOf('apv.') === 0 || k.indexOf('drv.evsub.') === 0)) sessionStorage.removeItem(k); });
    } catch (e) { }
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
    return fetchAll('/rest/v1/driving_signatures?select=id,image&id=in.(' + need.join(',') + ')&order=id.asc')
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
  /** 서명 그림 주소가 PNG data URL 모양 그대로인가(2026-10-20 AU2 #15) — DB 검사는 앞부분(like 'data:image/png;base64,%')만 본다.
   *  모양이 다르면 쓰지 않고 이름 도장으로(화면 HTML 에 넣는 곳은 esc 도 붙인다). */
  function signUrlOk(s) { return typeof s === 'string' && /^data:image\/png;base64,[A-Za-z0-9+\/]+={0,2}$/.test(s); }
  /** 결재란 한 칸에 찍을 그림. 올린 서명이 있으면 그것, 아니면 이름 도장. */
  function signOf(v) {
    if (!v || !v.name) return '';
    var s = v.signId && SIGNS[v.signId];
    return (s && signUrlOk(s) ? s : '') || stampPng(v.name);
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

  /** 운행기록부 결재란 — 세 문서 공통 docBoxes 를 그대로 쓴다(2026-10-14 「세 결재 시스템 동일」).
   *  담당 칸: 상신된 건이면 상신 때 서명, 상신 전 미리보기(·반려·회수 뒤)면 지금 내 서명. */
  function boxesOf(a, u, mine) {
    return docBoxes(a, u.name || mine, liveSign(mine), mine);
  }
  /** 상신 전(·반려·회수 뒤) 문서의 담당 칸에 찍을 지금 내 서명 id — 본인 문서이고 올린 서명이 있을 때만.
   *  개인경비·법인카드도 같은 것을 쓴다(C.liveSign, 2026-10-14 — 세 문서 담당 칸이 같게). */
  function liveSign(who) {
    return who === myName() && MYSIGN && MYSIGN.image ? MYSIGN.id : null;
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
    // = 금액 규칙 v3 의 「운행 없는 영수증」(정산에서 뺀 것) — 2단계 표·검증 R13 과 같은 계산(moneyOf)
    //   표시는 「10월분부터」(09-21 이후 날만, 2026-10-15 추가 결정) — 그 전 날 것은 정산에서만 빠지고 짚지 않는다
    var out = [];
    moneyOf(myName(), cycleRange(CYC))[cat].days.forEach(function (d) { if (d.st === 'no_trip' && d.show) out = out.concat(d.ev); });
    return out;
  }
  /* ── 기간 경계에 걸친 이은 영수증(2026-10-17 사용자 「그냥 문구만 띄워주고 작성자 판단에 맡기려고」) ──
     영수증의 기간은 영수증 날짜로 정하고, 이은 운행(trip_id)은 그 기간 안에 있을 때만 쓴다(금액 규칙 v3 — 웹·서버·앱 같은 규칙, 바꾸지 않는다).
     그래서 9.20 밤 운행에 9.21 새벽 영수증을 이으면 9월분은 영수증 날짜가 기간 밖이라 빼고, 10월분은 이은 운행이 기간 밖이라
     (그날 업무 운행이 없으면) 「운행 없는 영수증」으로 빠져 어느 기간에도 정산되지 않는다. 금액은 그대로 두고 문구만 띄운다.
     서버 driving-verify R13 상세에도 같은 뜻의 한 줄이 붙는다(결재하는 분도 본다).
     XLINK = 이 화면 운행 목록에 없는 이은 운행(id → { id, username, start_time, deleted_at } | null) — 필요한 것만 한 번 받는다. */
  var XLINK = {}, XLINK_ASK = {};
  function xlinkLoad(ids) {
    ids = ids.filter(function (id) { return !(id in XLINK) && !XLINK_ASK[id]; });
    if (!ids.length) return;
    ids.forEach(function (id) { XLINK_ASK[id] = 1; });
    apiRetry('/rest/v1/trips?select=id,username,start_time,deleted_at&id=in.(' + ids.join(',') + ')')
      .then(function (x) { return x.ok ? x.json() : Promise.reject(new Error('HTTP ' + x.status)); })
      .then(function (rows) {
        ids.forEach(function (id) { XLINK[id] = null; delete XLINK_ASK[id]; });
        (rows || []).forEach(function (t) { XLINK[String(t.id)] = t; });
        if ((rows || []).length && LOADED && !$('panel').classList.contains('open')) render();
      }, function () { ids.forEach(function (id) { delete XLINK_ASK[id]; }); });   // 못 받으면 문구만 안 뜬다(다음에 그릴 때 다시)
  }
  /** 영수증 e 가 이은 운행이 **다른 기간**의 (살아 있는 같은 사람) 운행이면 그 운행, 아니면 null. 모르는 운행은 받기 시작하고 null. */
  function xlinkTrip(e, byId) {
    if (!e || e.trip_id == null || (e.category !== '주차' && e.category !== '통행료') || !(Number(e.amount) > 0)) return null;
    var id = String(e.trip_id), t = byId && byId[id];
    if (!t) {
      if (!(id in XLINK)) { xlinkLoad([id]); return null; }
      t = XLINK[id];
    }
    if (!t || t.deleted_at || t.username !== e.username) return null;
    return cycKey(cycleOfMs(Number(t.start_time))) !== cycKey(cycleOfMs(Number(e.date_millis))) ? t : null;
  }
  /** 이은 운행이 다른 기간인 영수증(그 영수증 기간에서 「운행 없는 영수증」이 된 것) — 영수증 기간 쪽 문구. */
  function xlinkHereText(e, t) {
    var tm = CR.short(cycleOfMs(Number(t.start_time))), em = CR.short(cycleOfMs(Number(e.date_millis)));
    return md(e.date_millis) + ' ' + (e.category || '') + ' 영수증 ' + n0(e.amount) + '원은 ' + md(t.start_time) + ' 운행(' + tm + ')에 이어져 있지만, ' +
      '영수증 날짜가 ' + em + '에 속해 어느 기간에도 정산되지 않아요. ‘다른 운행에 붙이기’로 이번 기간 운행에 다시 잇거나, ' +
      tm + ' 기간이 아직 상신 전이면 그쪽에서 확인하세요.';
  }
  /** 이 기간 운행에 이었는데 영수증 날짜가 다른 기간인 영수증 — 운행 기간 쪽 문구(영수증 기간에 그날 운행이 있는지는 여기서 모른다). */
  function xlinkThereText(e, t) {
    var em = CR.short(cycleOfMs(Number(e.date_millis)));
    return md(t.start_time) + ' 운행에 이은 ' + (e.category || '') + ' 영수증 ' + n0(e.amount) + '원은 영수증 날짜(' + md(e.date_millis) + ')가 ' + em +
      '에 속해 이 기간 정산에 들어가지 않아요. ' + em + '에 그날 업무 운행이 없으면 어느 기간에도 정산되지 않으니, ' + em +
      ' 화면에서 ‘다른 운행에 붙이기’로 그 기간 운행에 다시 잇거나 확인하세요.';
  }
  /**
   * 한 사람 · 한 기간(r)의 경계 영수증. here = 이 기간 영수증인데 이은 운행이 다른 기간이라 「운행 없는 영수증」이 된 것(표시하는 날만 —
   * 서버 R13 과 같은 날), there = 이 기간 운행에 이었는데 영수증 날짜가 다른 기간인 것. 둘 다 [{ e, t, say }].
   */
  function xlinkOf(u, r) {
    var byId = {}, here = [], there = [];
    ALL_TRIPS.forEach(function (t) { if (t.username === u && !t.deleted_at) byId[String(t.id)] = t; });
    var M = null;
    ALL_EVID.forEach(function (e) {
      if (e.username !== u || e.trip_id == null || (e.category !== '주차' && e.category !== '통행료') || !(Number(e.amount) > 0)) return;
      var d = Number(e.date_millis), inR = d >= r.lo && d < r.hi, lt = byId[String(e.trip_id)];
      var ts = lt ? Number(lt.start_time) : NaN, tIn = lt && ts >= r.lo && ts < r.hi;
      if (inR && !tIn) {
        var t = xlinkTrip(e, byId);
        if (!t) return;
        M = M || moneyOf(u, r, ALL_TRIPS, ALL_EVID);
        var lost = M[e.category].days.some(function (x) { return x.st === 'no_trip' && x.show && x.ev.some(function (y) { return String(y.id) === String(e.id); }); });
        if (lost) here.push({ e: e, t: t, say: xlinkHereText(e, t) });
      } else if (!inR && tIn) {
        // 영수증 날짜도 「10월분부터」(09-21) 뒤일 때만 — 서버·검증 표시와 같은 날
        if (ymd(d) >= window.MoneyRule.FROM) there.push({ e: e, t: lt, say: xlinkThereText(e, lt) });
      }
    });
    return { here: here, there: there };
  }
  /* ── 영수증 금액을 운행 기록에 실제로 적기(금액 규칙 v3 「운행 기록에 실제로 적기(웹)」, 2026-10-15) ──
     2단계(영수증·통행료) 화면을 열 때·영수증을 올리거나 맞춘 뒤 다시 그릴 때, 운행 금액이 없고(T = 0) 영수증이 있고
     업무 운행이 있는 날(filled)을 찾아 그 운행의 금액 칸에 영수증 금액을 적는다 — 운행 기록 화면에서도 보이게.
       · 통행료: toll-apply manual(사람이 정한 값 MANUAL). ★ 서버가 출처를 「영수증」으로 적는 길이 아직 없어
         지금은 「웹 직접 입력」으로 적히고, batch·note 에 「영수증」과 영수증 번호를 남긴다(서버에 mode 'receipt' 가 생기면 바꿀 것).
       · 주차: trip-edit patch parking_cost.
     결재가 올라간(잠긴) 기간·운행은 적지 않는다. 적지 않아도 정산·엑셀·결재 금액은 같다(moneyOf 가 이미 영수증 금액을 넣는다).
     같은 값은 한 번만 시도한다(AUTOFILL_TRIED) — 실패해도 화면을 다시 그릴 때마다 되풀이하지 않는다.
     ★ 같은 금액 영수증이 2장 이상인 날(2026-10-21 통행료 버그 2 — money-rule.js sameAmt)은 적지 않고 직원에게 묻는다(openDupFill):
       「두 번 낸 것 맞음(왕복 등) → 합계 적기」 / 「같은 영수증이 겹침 → 한 번만 적기」. 예전엔 합계를 적어 그날이 「맞음」이 되고 검증 R08 이
       참고로 내려가 중복이 정산에 굳었다(직원 사례: 14분 운행 1건에 1,700원 영수증 3장 → 운행 5,100원). 영수증 시각이 모두 있고 서로 다르면
       별개 영수증으로 보고 묻지 않고 합계를 적는다(글에 「시각이 다른 영수증」). 고른 것은 저장 글(fillNote)에 남아 서버 검증이 읽는다(_shared/fill-mark.ts). */
  var AUTOFILL_TRIED = {}, AUTOFILL_BUSY = false;
  var DUPF_ASKED = {}, DUPF = null;        // 같은 금액 영수증 확인 창 — 이 탭에서 저절로 띄운 날(한 번씩) · 열린 창
  var EVUNDO = null, EVLINK_UNDO = null;   // 지우기·붙이기 확인 창의 「되돌릴 운행 금액」(2026-10-20 AU2 ①)
  /** 이 영수증의 시각(money-rule rcptTime — 원본 장 판독 시각 · 영수증 날짜의 시각). */
  function evTimeOf(e) { return window.MoneyRule.rcptTime(e, AIR[e.id] || null); }
  /** 영수증으로 채울 날 중 같은 금액 영수증이 2장 이상인 날 — [{ cat, d, G: 묶음(sameAmt), ask: 시각으로 못 가른 묶음 }](두 번 정산 의심인 날은 뺀다). */
  function dupFillDays(M) {
    var out = [];
    ['주차', '통행료'].forEach(function (cat) {
      ((M && M[cat] && M[cat].days) || []).forEach(function (d) {
        if (d.st !== 'filled' || d.twice) return;
        var G = window.MoneyRule.sameAmt(d.ev, evTimeOf);
        if (G.length) out.push({ cat: cat, d: d, G: G, ask: G.filter(function (g) { return !g.sep; }) });
      });
    });
    return out;
  }
  /** 그날 운행에 적을 것 — [{ cat, id, amount, note, say }](money-rule fillPlan·fillNote). 내 것·안 잠긴 운행·서버 범위 안만. */
  function fillItemsOf(cat, d, mode, G, how) {
    var me = myName(), byId = {};
    ALL_TRIPS.forEach(function (t) { byId[String(t.id)] = t; });
    return window.MoneyRule.fillPlan(d, mode, G).map(function (p) {
      var t = byId[String(p.tripId)];
      if (!t || t.username !== me || apprLocked(t) || !(p.amount > 0)) return null;
      if (p.amount > (cat === '통행료' ? TOLL_MAX : 300000)) return null;   // 서버 범위 밖 — 적지 않는다(정산은 그대로 영수증 금액)
      // 근거 = 그 운행 줄을 채운 영수증(money-rule fillEv) — 나중에 그 영수증을 지우거나 옮기면 이 금액을 되돌린다(2026-10-20 AU2 ①)
      return { cat: cat, id: Number(p.tripId), amount: p.amount, note: window.MoneyRule.fillNote(cat, p.ids, how),
        say: d.day.slice(5).replace('-', '.') + ' ' + cat + ' ' + n0(p.amount) + '원' };
    }).filter(Boolean);
  }
  function autoFillEv() {
    if (AUTOFILL_BUSY || !LOADED || isAll() || isMulti() || !myName() || VIEW !== 'evid') return;
    var me = myName();
    if (cycleLocked(me)) return;
    var r = cycleRange(CYC), M = moneyOf(me, r, ALL_TRIPS, ALL_EVID);
    var tolls = [], parks = [], tried = [], asks = [];
    // 같은 금액 영수증의 시각은 원본 장 판독(evidence_ai)에도 있다 — 받기 전이면 그런 날은 이번에 건너뛴다(받으면 다시 그려 다시 본다)
    var air = airReady();
    ['주차', '통행료'].forEach(function (cat) {
      M[cat].days.forEach(function (d) {
        if (d.st !== 'filled') return;
        // 두 번 정산 의심(2026-10-20, R14 — 전날 운행 영수증을 다음 날 날짜로 올린 것일 수 있음)인 날은 적지 않는다.
        //   적으면 그 날 운행 금액이 생겨 「맞음」이 되고 의심 표시가 사라진 채 두 번 정산이 운행 기록에 굳는다. 정산 금액은 그대로(영수증으로 채움) —
        //   작성자가 전날 운행에 잇거나(「다른 운행에 붙이기」), 그 날 운행 영수증이 맞으면 운행 금액을 직접 적는다.
        if (d.twice) return;
        // 같은 금액 영수증이 2장 이상 — 시각으로 가르지 못하면 묻는다(위 머리 주석). 모두 시각이 달라 별개면 합계 + 「시각이 다른 영수증」.
        var G = window.MoneyRule.sameAmt(d.ev, evTimeOf), ask = G.filter(function (g) { return !g.sep; });
        if (ask.length) { if (air) asks.push({ cat: cat, d: d, G: G, ask: ask }); return; }
        fillItemsOf(cat, d, 'sum', G, G.length ? 'apart' : '').forEach(function (p) {
          var key = me + '|' + cat + '|' + p.id + '|' + p.amount;
          if (AUTOFILL_TRIED[key]) return;
          AUTOFILL_TRIED[key] = 1; tried.push(key);
          (cat === '통행료' ? tolls : parks).push(p);
        });
      });
    });
    if (tolls.length || parks.length) { fillSafe(tolls, parks, tried); return; }
    // 물을 날 — 그 구분 차례를 보고 있고 다른 창이 없을 때 하나씩 저절로 연다(이 탭에서 날마다 한 번). 닫아도 그 줄 「확인」으로 다시 연다.
    var q = asks.filter(function (x) { return EV_SUBS[evSub()] === x.cat && !DUPF_ASKED[dupKey(x.cat, x.d)]; })[0];
    if (q && !$('panel').classList.contains('open')) { DUPF_ASKED[dupKey(q.cat, q.d)] = 1; openDupFill(q.cat, q.d.day); }
  }
  /** 물은 날 열쇠 — 사람·구분·날·그날 영수증(바뀌면 다시 묻는다). */
  function dupKey(cat, d) { return myName() + '|' + cat + '|' + d.day + '|' + d.ev.map(function (e) { return e.id; }).join(','); }
  /** ★ 적기 직전에 그 운행들을 서버에서 다시 읽어, 지금도 금액이 비어 있는 것만 적는다(2026-10-16 검증로봇 —
   *  화면에 받아 둔 묵은 자료로 판단해, 그 사이 앱·다른 탭에서 확정된 통행료·주차비를 영수증 금액으로 덮어쓸 수 있었다).
   *  다시 읽지 못하면 적지 않는다(다음에 화면을 그릴 때 다시 해 본다 — tried 를 지운다). opt = writeFill 의 알림 글(ok·miss). */
  function fillSafe(tolls, parks, tried, opt) {
    var me = myName();
    AUTOFILL_BUSY = true;
    var ids = tolls.concat(parks).map(function (p) { return p.id; });
    apiRetry('/rest/v1/trips?select=id,username,deleted_at,toll_cost,toll_status,toll_source,parking_cost&id=in.(' + ids.join(',') + ')')
      .then(function (x) { return x.ok ? x.json() : Promise.reject(new Error('HTTP ' + x.status)); })
      .then(function (rows) {
        var fresh = {}, stale = 0;
        (rows || []).forEach(function (t) { fresh[String(t.id)] = t; });
        var still = function (cat) {
          return function (p) {
            var f = fresh[String(p.id)];
            var ok1 = f && !f.deleted_at && f.username === me && !(window.MoneyRule.tripAmt(cat, f) > 0);
            if (!ok1) stale++;
            return ok1;
          };
        };
        tolls = tolls.filter(still('통행료'));
        parks = parks.filter(still('주차'));
        if (!tolls.length && !parks.length) {
          AUTOFILL_BUSY = false;
          if (opt && opt.miss) toast(opt.miss, true);
          if (stale) { TRIP_CACHE = {}; AUDIT = null; loadAll(); }
          return;
        }
        writeFill(tolls, parks, opt);
      }, function () {
        AUTOFILL_BUSY = false;
        (tried || []).forEach(function (k) { delete AUTOFILL_TRIED[k]; });
        if (opt && opt.miss) toast('운행 정보를 불러오지 못해 저장하지 않았어요. 잠시 후 ‘확인’을 다시 눌러 주세요.', true);
      });
  }
  function writeFill(tolls, parks, opt) {
    var notes = tolls.concat(parks).map(function (p) { return p.say; });
    var ok = 0, fail = 0;
    var tollStep = !tolls.length ? Promise.resolve() :
      apiRetry('/functions/v1/toll-apply', { method: 'POST', body: JSON.stringify({ mode: 'manual', batch: '영수증 금액 반영 ' + CYCKEY(), items: tolls.map(function (p) { return { id: p.id, amount: p.amount, note: p.note }; }) }) })
        .then(function (res) { return res.json().catch(function () { return {}; }); })
        .then(function (j) { var a = Number(j && j.applied) || 0; ok += a; fail += tolls.length - a; }, function () { fail += tolls.length; });
    var parkStep = function (i) {
      if (i >= parks.length) return Promise.resolve();
      var p = parks[i];
      return apiRetry('/functions/v1/trip-edit', { method: 'POST', body: JSON.stringify({ id: p.id, patch: { parking_cost: p.amount }, note: p.note }) })
        .then(function (res) { return res.json().then(function (j) { if (res.ok && j && j.ok) ok++; else fail++; }, function () { fail++; }); }, function () { fail++; })
        .then(function () { return parkStep(i + 1); });
    };
    tollStep.then(function () { return parkStep(0); }).then(function () {
      AUTOFILL_BUSY = false;
      if (!ok) { if (fail) toast('영수증 금액을 운행에 적지 못했어요. 정산에는 그대로 영수증 금액이 들어가요.', true); return; }
      toastOk(opt && opt.ok ? opt.ok(notes) : '영수증 금액을 운행에 넣었어요. ' + notes.slice(0, 4).join(' · ') + (notes.length > 4 ? ' 외 ' + (notes.length - 4) + '건' : ''),
        fail ? fail + '건은 적지 못했어요. 정산에는 그대로 영수증 금액이 들어가요.' : (opt && opt.sub) || null);
      TRIP_CACHE = {}; AUDIT = null;
      loadAll();
    });
  }
  /* ── 같은 금액 영수증 확인 창(2026-10-21 통행료 버그 2) ──
     영수증으로 채울 날(운행 금액 없음)에 같은 금액 영수증이 2장 이상이면 영수증 적기가 적지 않고 여기서 묻는다. 고르는 것은 둘:
       · 「두 번 낸 것 맞음(왕복 등) → 합계 적기」 — 그날 영수증 합계를 운행에 적고 저장 글에 「두 번 낸 것 맞음 — 직원 확인」(검증 R08 은 참고)
       · 「같은 영수증이 겹침 → 한 번만 적기」 — 같은 금액 묶음은 한 장만 세어 적는다(글 「같은 영수증 겹침 — 한 번만」). 그날은 금액 다름이 되고
         겹친 영수증을 지우면 맞음 — 지울 때 되돌리기는 이 운행 금액을 건드리지 않는다(근거 #id 가 남긴 한 장뿐).
     창 아래 [적기] [취소](웹 전체 규칙 — footOrder). 고르기 전에는 [적기]가 막혀 있다. 취소하면 그대로 두고, 그 줄의 「확인」으로 다시 연다
     (그동안 정산은 규칙대로 영수증 합계 — 검증 R08 은 확인). */
  function openDupFill(cat, day) {
    var me = myName();
    if (!me || isMulti() || cycleLocked(me)) return;
    var M = moneyOf(me, cycleRange(CYC), ALL_TRIPS, ALL_EVID);
    var x = dupFillDays(M).filter(function (y) { return y.cat === cat && y.d.day === day; })[0];
    if (!x || !x.ask.length) { toast('이 날은 확인할 같은 금액 영수증이 없어요. 화면을 새로 고쳤어요.'); render(); return; }
    var d = x.d, word = cat === '주차' ? '주차비' : '통행료', w = function (v) { return n0(v) + '원'; };
    var sum = fillItemsOf(cat, d, 'sum', x.G, 'paid'), once = fillItemsOf(cat, d, 'once', x.G, 'once');
    var tot = function (l) { return l.reduce(function (s, p) { return s + p.amount; }, 0); };
    if (!sum.length) { toast('본인 운행이 아니거나 결재 중이라 이 날 운행에 영수증 금액을 적을 수 없어요.', true); return; }
    DUPF = { cat: cat, day: day, key: dupKey(cat, d), sum: sum, once: once };
    var nDup = x.ask.reduce(function (s, g) { return s + g.ev.length; }, 0);
    var DOW = ['일', '월', '화', '수', '목', '금', '토'], p = day.split('-'), dw = DOW[new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay()];
    var evLi = x.ask.map(function (g) {
      return '<li><b>' + esc(w(g.a)) + ' × ' + n0(g.ev.length) + '장</b> <span class="dim">' + g.ev.map(function (e) {
        var t = evTimeOf(e);
        return esc((e.memo ? String(e.memo).slice(0, 16) + ' ' : '') + (t ? t + ' ' : '') + '#' + e.id) +
          (e.photo_path ? ' <a target="_blank" rel="noopener" href="' + esc(photoUrl(e.photo_path)) + '">사진</a>' : '') +
          (e.scan_path ? ' <a target="_blank" rel="noopener" href="' + esc(photoUrl(e.scan_path)) + '">원본</a>' : '');
      }).join(' · ') + '</span></li>';
    }).join('');
    var tripTxt = d.trips.filter(function (t) { return sum.some(function (q) { return String(q.id) === String(t.id); }); })
      .map(function (t) { return hm(t.start_time) + ' ' + (t.visit_place || placeShort(t.end_address) || '운행'); }).join(' · ');
    var opt = function (v, title, sub) {
      return '<label class="dupopt"><input type="radio" name="dupfill" value="' + v + '"><span><b>' + esc(title) + '</b><span class="dim">' + esc(sub) + '</span></span></label>';
    };
    var body = '<div class="anote warn" style="margin-top:0">이 날은 운행 ' + word + '가 비어 있어 영수증 금액을 넣어야 하는데, <b>같은 금액 영수증이 ' + n0(nDup) + '장</b> 있어요. ' +
        '같은 영수증을 두 번 올렸는지, 실제로 여러 번 냈는지(왕복 등) 골라 주세요.</div>' +
      '<ul class="dupev">' + evLi + '</ul>' +
      '<div class="dim" style="font-size:13px;margin:6px 0 10px">넣을 운행: ' + esc(tripTxt || '그날 첫 업무 운행') + ' · 사진이 같은 영수증이면 겹친 거예요. 같은 원본에서 오린 두 장도 겹칠 수 있어요.</div>' +
      '<div class="dupopts" role="radiogroup" aria-label="같은 금액 영수증">' +
        opt('sum', (nDup > 2 ? '여러 번' : '두 번') + ' 낸 것 맞음(왕복 등) → 합계 ' + w(tot(sum)) + ' 적기', '영수증 ' + n0(d.ev.length) + '장을 모두 정산해요.') +
        opt('once', '같은 영수증이 겹침 → 한 번만 ' + w(tot(once)) + ' 적기', '적은 뒤 겹친 영수증을 내역에서 지워 주세요. 그대로 두면 ‘금액 다름’으로 남아요.') +
      '</div>';
    openPanel('같은 금액 영수증 확인', md(Date.parse(day + 'T00:00:00+09:00')) + '(' + dw + ') · ' + cat, body,
      '<span style="flex:1"></span><button class="btn pri" id="btnDupGo" disabled>적기</button><button class="btn" data-close>취소</button>');
  }
  /** [적기] — 고른 쪽으로 그날 운행에 적는다(적기 직전에 다시 읽어 그날 영수증·운행 금액이 그대로일 때만). */
  function dupFillGo() {
    var S0 = DUPF, me = myName();
    if (!S0 || !me) return;
    var c = document.querySelector('input[name="dupfill"]:checked');
    if (!c) { toast('둘 중 하나를 골라 주세요.', true); return; }
    if (AUTOFILL_BUSY) { toast('영수증 금액을 적는 중이에요. 잠시 후 다시 눌러 주세요.', true); return; }
    // 창을 연 뒤 영수증·운행이 바뀌었으면 적지 않는다(다시 묻는다)
    var M = moneyOf(me, cycleRange(CYC), ALL_TRIPS, ALL_EVID);
    var x = dupFillDays(M).filter(function (y) { return y.cat === S0.cat && y.d.day === S0.day; })[0];
    if (!x || dupKey(x.cat, x.d) !== S0.key) { DUPF = null; closePanel(); toast('그 사이 이 날 영수증이 바뀌었어요. 다시 확인해 주세요.', true); render(); return; }
    var once = c.value === 'once', items = once ? S0.once : S0.sum;
    DUPF = null; closePanel();
    var tolls = items.filter(function (p) { return p.cat === '통행료'; }), parks = items.filter(function (p) { return p.cat === '주차'; });
    var amt = items.reduce(function (s, p) { return s + p.amount; }, 0), dd = S0.day.slice(5).replace('-', '.');
    var nGone = x.ask.reduce(function (s, g) { return s + g.ev.length - 1; }, 0), nDup = x.ask.reduce(function (s, g) { return s + g.ev.length; }, 0);
    fillSafe(tolls, parks, [], {
      miss: '그 사이 이 날 운행 금액이 정해져서 적지 않았어요. 표를 새로 고쳤어요.',
      ok: function () {
        return once ? dd + ' ' + S0.cat + ' ' + n0(amt) + '원을 운행에 한 번만 넣었어요.'
          : dd + ' ' + S0.cat + ' ' + n0(amt) + '원을 운행에 넣었어요(' + (nDup > 2 ? '여러 번' : '두 번') + ' 낸 것 맞음).';
      },
      sub: once ? '겹친 영수증 ' + n0(nGone) + '장은 내역에서 지워 주세요. 그대로 두면 ‘금액 다름’으로 남아요.' : null
    });
  }

  /* ── 영수증을 지우거나 옮길 때 그 영수증이 넣은 운행 금액 되돌리기(2026-10-20 AU2 ①) ──
     웹 영수증 적기(autoFillEv)는 그날 운행 금액 칸에 영수증 금액을 실제로 적는다. 그 영수증을 지우거나 「다른 운행에 붙이기」로
     옮기면 적은 금액이 남아 두 번 정산됐다(09.26 영수증 3,000 → 운행 43 에 적힘 → 09.24 운행 42 에 붙이면 42 에도 3,000 → 6,000 ·
     지우면 그날 「영수증 없음」인데 정산 그대로). 이제 지우기·붙이기 확인 창에 「이 영수증 금액이 들어간 운행」 목록을 띄우고(기본 켬)
     켠 것을 적기 전 값(비움·0)으로 되돌린다. 남은 영수증이 있으면 영수증 적기가 그 금액으로 다시 적는다(정산은 늘 금액 규칙대로).
       · 통행료: toll-apply 가 남긴 근거(toll_evidence_json — batch 「영수증 금액 반영 …」 · note 「영수증 #id」)로 정확히.
       · 주차비: trip-edit 수정 기록(driving_trip_edit_log.note 「영수증 금액 반영 #id」 — 2026-10-20~)으로 정확히. 그 전 기록(까닭 없음)은
         「비어 있던 주차비를 내가 웹에서 바꾼 마지막 수정」이고 금액이 그 영수증(또는 그날 영수증 합)과 같을 때만 후보(「…넣은 것 같습니다」).
     어느 운행인지 고르는 계산은 money-rule.js fillUndo(시험: money-parity). 잠긴(결재 중·완료) 운행은 빼고 묻는다. */
  var FILL_NOTE = '영수증 금액 반영', UNDO_NOTE = '영수증 지움·옮김 — 넣었던 금액 되돌림';
  /** 운행들의 「영수증 적기 표시」를 서버에서 새로 읽는다 → markOf(cat, trip). 못 읽으면 표시 없음(되돌리지 않는다). */
  function fillMarks(ids) {
    var me = myName(), q = ids.map(Number).filter(isFinite).join(',');
    if (!q) return Promise.resolve(function () { return null; });
    var get = function (path) { return apiRetry(path).then(function (r) { return r.ok ? r.json() : []; }, function () { return []; }); };
    return Promise.all([
      get('/rest/v1/trips?select=id,username,deleted_at,toll_cost,toll_status,toll_source,toll_evidence_json,parking_cost&id=in.(' + q + ')'),
      get('/rest/v1/driving_trip_edit_log?select=id,trip_id,actor,prev,next,note&trip_id=in.(' + q + ')&order=id.desc')
    ]).then(function (res) {
      var T = {}, L = {};
      (res[0] || []).forEach(function (t) { T[String(t.id)] = t; });
      (res[1] || []).forEach(function (l) { var k = String(l.trip_id); (L[k] = L[k] || []).push(l); });
      var refs = function (s) { return (String(s || '').match(/#\d+/g) || []).map(function (x) { return Number(x.slice(1)); }); };
      return function (cat, t) {
        var f = T[String(t.id)];
        if (!f || f.deleted_at || f.username !== me) return null;
        if (cat === '통행료') {
          var ej = f.toll_evidence_json || {};
          if (f.toll_source !== '웹 직접 입력' || ej.kind !== 'web_bulk' || String(ej.batch || '').indexOf(FILL_NOTE) !== 0 || !(tollNeed(f).a > 0)) return null;
          var pc = ej.prev && ej.prev.cost != null && ej.prev.cost !== '' ? Number(ej.prev.cost) : null;
          if (pc) return null;                             // 적기 전에 금액이 있었다 — 적기는 빈 운행에만 적으므로 이 금액은 적기가 아니다
          var ti = refs(ej.note);
          return ti.length ? { ids: ti, prev: pc } : null;
        }
        var last = (L[String(t.id)] || []).filter(function (l) { return l.next && Object.prototype.hasOwnProperty.call(l.next, 'parking_cost'); })[0];
        if (!last) return null;
        var now = Number(f.parking_cost) || 0, was = last.prev ? last.prev.parking_cost : null;
        // 마지막 웹 수정이 지금 값을 넣었고(그 뒤에 앱 등이 바꾸지 않음), 넣기 전에는 비어 있었을 때만
        if (!(now > 0) || Number(last.next.parking_cost) !== now || (was != null && Number(was) !== 0)) return null;
        if (last.note) return last.note.indexOf(FILL_NOTE) === 0 ? { ids: refs(last.note), prev: was == null ? null : 0 } : null;
        return last.actor === me ? { ids: null, prev: was == null ? null : 0 } : null;
      };
    });
  }
  /** moves = [{ e: 영수증, to: 새로 이을 운행 id 또는 null }] → Promise<되돌릴 것 목록>(money-rule fillUndo — 내 것·안 잠긴 운행만). 못 보면 []. */
  function fillUndoPlan(moves) {
    var me = myName(), r = cycleRange(CYC);
    if (!me || isMulti() || !window.MoneyRule.fillUndo || !moves.length) return Promise.resolve([]);
    var M = moneyOf(me, r, ALL_TRIPS, ALL_EVID), ids = {};
    moves.forEach(function (mv) {
      var C = M[mv.e.category]; if (!C) return;
      C.days.forEach(function (d) {
        if (d.ev.some(function (x) { return String(x.id) === String(mv.e.id); })) d.trips.forEach(function (t) { if (d.amt[t.id] > 0) ids[t.id] = 1; });
      });
    });
    if (!Object.keys(ids).length) return Promise.resolve([]);
    return fillMarks(Object.keys(ids)).then(function (markOf) {
      return window.MoneyRule.fillUndo(M, moves, markOf).filter(function (p) { return p.trip.username === me && !apprLocked(p.trip); });
    }).catch(function () { return []; });
  }
  /** 확인 창에 넣는 목록 — 줄마다 고르기 칸(기본 켬). del = 영수증 지우기 창 — 지우면 「두 번 정산」이 아니라 운행에 영수증 없는 금액으로 남는다(2026-10-20 V3 다듬기). */
  function undoBlock(plan, del) {
    if (!plan || !plan.length) return '';
    return '<div class="undoblk" role="group" aria-label="영수증 금액이 들어간 운행 되돌리기">' +
      '<div class="anote warn" style="margin-top:0">이 영수증 금액이 아래 운행에 들어가 있어요. 함께 되돌리지 않으면 ' +
      (del ? '운행에 영수증 없는 금액으로 남아요' : '두 번 정산될 수 있어요') + '. 되돌리지 않을 줄만 끄세요.</div><ul class="undolist">' +
      plan.map(function (p, i) {
        var t = p.trip, w = p.cat === '주차' ? '주차비' : '통행료';
        return '<li><label><input type="checkbox" data-undo="' + i + '" checked> <span>' +
          esc(md(t.start_time) + ' ' + hm(t.start_time) + ' ' + (t.visit_place || placeShort(t.end_address) || '운행') + ' · ' + w + ' ' + n0(p.amount) + '원 → ' +
            (p.cat === '주차' ? (p.prev ? n0(p.prev) + '원' : '비움') : p.prev == null ? '모름(미확정)' : p.prev === 0 ? '없음(0원)' : n0(p.prev) + '원')) +
          (p.exact ? '' : ' <span class="dim">(이 영수증 금액으로 넣은 것 같아요)</span>') + '</span></label></li>';
      }).join('') + '</ul></div>';
  }
  /** 켜 둔 줄만. */
  function undoPicked(plan) {
    return (plan || []).filter(function (p, i) { var c = document.querySelector('[data-undo="' + i + '"]'); return !!(c && c.checked); });
  }
  /** 되돌리기 — trip-edit 로 하나씩(주차비: 적기 전 값 · 통행료: 모름/0원). 결과 { ok, fail }. */
  function applyUndo(items) {
    var ok = 0, fail = 0, me = myName();
    var one = function (i) {
      if (i >= items.length) return Promise.resolve({ ok: ok, fail: fail });
      var p = items[i], note = UNDO_NOTE + ' #' + p.ev.join(',#');
      var patch = p.cat === '주차' ? { parking_cost: p.prev == null ? null : p.prev }
        : { toll: p.prev == null ? { mode: 'unknown' } : { mode: 'amount', amount: p.prev, note: note } };
      // 다시 적기가 같은 금액을 「이미 해 봤다」로 건너뛰지 않게(남은 영수증으로 다시 적을 수 있게)
      Object.keys(AUTOFILL_TRIED).forEach(function (k) { if (k.indexOf(me + '|' + p.cat + '|' + p.trip.id + '|') === 0) delete AUTOFILL_TRIED[k]; });
      return apiRetry('/functions/v1/trip-edit', { method: 'POST', body: JSON.stringify({ id: p.trip.id, patch: patch, note: note }) })
        .then(function (res) { return res.json().then(function (j) { if (res.ok && j && j.ok) ok++; else fail++; }, function () { fail++; }); }, function () { fail++; })
        .then(function () { return one(i + 1); });
    };
    return one(0);
  }
  /** 결과 한 마디(지우기·붙이기 알림 뒤에 붙인다). */
  function undoSay(u) {
    if (!u) return '';
    return (u.ok ? ' 운행에 넣었던 금액 ' + n0(u.ok) + '건도 되돌렸어요.' : '') +
      (u.fail ? ' ' + n0(u.fail) + '건은 되돌리지 못했어요. 그 운행을 눌러 금액을 직접 고쳐 주세요.' : '');
  }

  /* ══════════════════ 통행료 맞추기 제안(2026-10-21 사용자 결정 「제안 + 한 번 눌러 확정」) ══════════════════
     통행료 미확정·「모름」 업무 운행에 그날 영수증·하이패스 기록으로 맞춘 값(없음 0원 / 금액)을 제안하고(계산: toll-suggest.js — money-rule.js 결과를 읽기만),
     직원이 창에서 고른 줄만 적는다. 정산 규칙은 그대로다.
       · 저장 = 운행 고치기와 같은 길 — trip-edit patch.toll { mode: 'amount', amount(0 = 없음 → FREE_CONFIRMED · 금액 → MANUAL), note }.
         서버(trip-edit · toll-apply)는 통행료 출처를 「웹 직접 입력」 하나로 정해 적는다(받는 출처 값이 없다 — 자동 계산이 덮지 않게 보호 트리거가 이 값을 본다).
         그래서 출처는 「웹 직접 입력」 그대로이고, 근거(toll_evidence_json.note)에 「영수증 맞춤 제안 — …원: 남는 영수증 … #영수증번호」를 남겨 가린다.
       · 적기 직전에 그 운행들을 서버에서 다시 읽어 지금도 「모름」인 것만 적는다(그 사이 앱·다른 탭이 정했으면 건너뜀 — 영수증 적기 autoFillEv 와 같은 원칙).
       · 결재 중·완료(잠긴) 기간은 제안하지 않는다(서버 trip-edit 도 막는다). */
  var TSUG = null;     // 열린 제안 창 { items, busy }
  /** 본인 · 지금 기간의 제안(toll-suggest.js plan). 잠긴 기간·여러 기간·모듈 없음이면 null. M = 같은 자료의 moneyOf 결과(있으면 다시 세지 않는다). */
  function tollSugPlan(M) {
    var me = myName();
    if (!window.TollSuggest || !me || isMulti() || cycleLocked(me)) return null;
    var r = cycleRange(CYC);
    var trips = ALL_TRIPS.filter(function (t) { var s = Number(t.start_time); return t.username === me && !t.deleted_at && s >= r.lo && s < r.hi; });
    var evid = ALL_EVID.filter(function (e) { var d = Number(e.date_millis); return e.username === me && d >= r.lo && d < r.hi; });
    try {
      // timeOf: 같은 금액 영수증을 가르는 시각 — 영수증 적기와 같은 것(원본 장 판독 시각 · 영수증 날짜의 시각, 2026-10-21 통행료 버그 2)
      return window.TollSuggest.plan({ trips: trips, evid: evid, money: M || moneyOf(me, r, ALL_TRIPS, ALL_EVID), toll: function (t) { return tollNeed(t).a; }, day: ymd, timeOf: evTimeOf });
    } catch (e) { console.error('통행료 제안을 만들지 못했습니다:', e); return null; }
  }
  /** 「제안 보기·맞추기」 창 — 날짜·운행 시각·방문처 → 제안(금액/없음)·근거, 줄마다 고르기 칸(기본 모두 고름), 아래 [N건 맞추기] [취소]. */
  function openTollSug() {
    var me = myName();
    if (!me || isMulti()) return;
    if (cycleLocked(me)) { toast(lockWhy(me) + ' 이 기간에는 통행료를 고칠 수 없어요.', true); return; }
    var P = tollSugPlan();
    if (!P) { toast('통행료 제안을 만들지 못했어요. 새로고침한 뒤 다시 눌러 주세요.', true); return; }
    if (!P.items.length) { toast('통행료 미확정 운행이 없어요.'); return; }
    TSUG = { items: P.items, busy: false };
    var DOW = ['일', '월', '화', '수', '목', '금', '토'];
    var dn = function (k) { var p = k.split('-'), x = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); return p[1] + '.' + p[2] + '(' + DOW[x.getUTCDay()] + ')'; };
    var can = P.n.none + P.n.amount, groups = [];
    P.items.forEach(function (it, i) {
      var g = groups[groups.length - 1];
      if (!g || g.day !== it.day) groups.push(g = { day: it.day, list: [] });
      g.list.push({ it: it, i: i });
    });
    var w = function (v) { return n0(v) + '원'; };
    var row = function (x) {
      var it = x.it, t = it.trip, sel = it.kind === 'none' || it.kind === 'amount';
      var place = t.visit_place || placeShort(t.end_address) || '방문처 없음';
      var val = it.kind === 'amount' ? '<span class="tsv amt">' + w(it.amount) + '</span>'
        : it.kind === 'none' ? '<span class="tsv none">없음(0원)</span>'
        : it.kind === 'auto' ? '<span class="tsv auto">영수증으로 채움 ' + w(it.amount) + '</span>'
        : '<span class="tsv pick">직접 고르기</span>';
      // 직접 고르기 줄 — 근거 글에 영수증이 안 나왔으면 그날 남는 영수증을 한 줄 더(그 운행들과 남는 영수증만 보인다)
      var evLine = it.kind === 'pick' && it.ev.length && it.say.indexOf(window.TollSuggest.evSay(it.ev[0])) < 0
        ? '<div class="tse">이 날 영수증: ' + esc(it.ev.map(window.TollSuggest.evSay).join(' · ')) + '</div>' : '';
      return '<li class="tsr k-' + it.kind + '" data-tsrow="' + esc(String(t.id)) + '">' +
        (sel ? '<label class="tsc"><input type="checkbox" data-tspick="' + x.i + '" checked aria-label="' +
            esc(md(t.start_time) + ' ' + hm(t.start_time) + ' ' + place + ' — ' + (it.kind === 'amount' ? w(it.amount) : '없음') + ' 맞추기') + '"></label>'
          : '<span class="tsc" aria-hidden="true"></span>') +
        '<div class="tsb"><div class="tst"><b>' + esc(hm(t.start_time)) + '</b> ' + esc(place) + '</div>' +
        '<div class="tss">' + val + '<span class="tsw">' + esc(it.say) + '</span></div>' + evLine + '</div>' +
        (it.kind === 'pick' ? '<button type="button" class="btn sm tsedit" data-edit="' + esc(String(t.id)) + '">' + ic('edit', 13) + '직접 고치기</button>' : '') +
        '</li>';
    };
    var body = '<div class="anote" style="margin-top:0">영수증과 하이패스 기록으로 통행료 미확정 운행을 맞춘 제안이에요. <b>정산 규칙은 그대로</b>이고, ' +
      '고른 줄만 그 운행의 통행료로 적어요. 운행 고치기에서 직접 넣은 값과 똑같이 저장되고, 근거에는 ‘영수증 맞춤 제안’이 남아요. ‘직접 고르기’ 줄은 그 운행을 고쳐 금액을 정해 주세요.</div>' +
      (can ? '<label class="tsall"><input type="checkbox" id="tsAll" checked> 제안 ' + n0(can) + '건 모두 고르기</label>'
        : '<div class="anote">바로 맞출 제안이 없어요. 아래 운행을 직접 고쳐 주세요.</div>') +
      '<div class="tsgrps">' + groups.map(function (g) {
        return '<div class="tsgrp"><div class="tsday">' + esc(dn(g.day)) + '</div><ul class="tslist">' + g.list.map(row).join('') + '</ul></div>';
      }).join('') + '</div>';
    openPanel('통행료 맞추기 제안', cycleName(CYC) + ' · 미확정 ' + n0(P.items.length) + '건', body,
      '<span style="flex:1"></span><button class="btn pri" id="btnTsApply"' + (can ? '' : ' disabled') + '>' + n0(can) + '건 맞추기</button>' +
      '<button class="btn" data-close>취소</button>');
  }
  /** 고르기 칸이 바뀌면 — 「모두 고르기」(반쯤 표시)와 아래 단추 「N건 맞추기」만 고쳐 쓴다(창을 다시 그리지 않는다). */
  function tsPick(el) {
    if (!TSUG) return;
    var boxes = [].slice.call(document.querySelectorAll('[data-tspick]'));
    if (el && el.id === 'tsAll') boxes.forEach(function (b) { b.checked = el.checked; });
    var on = boxes.filter(function (b) { return b.checked; }).length, all = $('tsAll');
    if (all) { all.checked = on > 0 && on === boxes.length; all.indeterminate = on > 0 && on < boxes.length; }
    var btn = $('btnTsApply');
    if (btn && !TSUG.busy) { btn.textContent = n0(on) + '건 맞추기'; btn.disabled = !on; }
  }
  /** [N건 맞추기] — 고른 줄을 운행 고치기와 같은 trip-edit 로 적는다(셋씩 나란히). 끝나면 알림 「N건을 맞췄습니다」 · 표 다시 계산. */
  function tsApply() {
    var S0 = TSUG, me = myName();
    if (!S0 || S0.busy || !me) return;
    if (cycleLocked(me)) { toast(lockWhy(me) + ' 이 기간에는 통행료를 고칠 수 없어요.', true); return; }
    var picked = S0.items.filter(function (it, i) {
      var c = document.querySelector('[data-tspick="' + i + '"]');
      return c && c.checked && (it.kind === 'none' || it.kind === 'amount');
    });
    if (!picked.length) { toast('맞출 줄을 하나 이상 골라 주세요.', true); return; }
    S0.busy = true;
    var btn = $('btnTsApply'), say = function (s) { var b = $('btnTsApply'); if (b) b.textContent = s; };
    var lockUi = function (on) {
      if (btn) btn.disabled = on;
      [].slice.call(document.querySelectorAll('[data-tspick],#tsAll')).forEach(function (c) { c.disabled = on; });
    };
    lockUi(true); say('확인하는 중…');
    // 적기 직전에 서버에서 다시 읽는다 — 지금도 「모름」(미확정)이고 본인 것만 적는다
    var ids = picked.map(function (it) { return Number(it.trip.id); }), chunks = [];
    for (var i = 0; i < ids.length; i += 80) chunks.push(ids.slice(i, i + 80));
    Promise.all(chunks.map(function (c) {
      return apiRetry('/rest/v1/trips?select=id,username,deleted_at,purpose,toll_cost,toll_status&id=in.(' + c.join(',') + ')')
        .then(function (x) { return x.ok ? x.json() : Promise.reject(new Error('HTTP ' + x.status)); });
    })).then(function (parts) {
      var fresh = {};
      [].concat.apply([], parts).forEach(function (t) { fresh[String(t.id)] = t; });
      var still = picked.filter(function (it) { var f = fresh[String(it.trip.id)]; return !!f && f.username === me && window.TollSuggest.isUnk(f); });
      var R = { ok: 0, fail: 0, stale: picked.length - still.length }, next = 0, done = 0;
      var worker = function () {
        if (next >= still.length) return Promise.resolve();
        var it = still[next++];
        var body = { id: Number(it.trip.id), patch: { toll: { mode: 'amount', amount: it.amount, note: it.note } }, note: it.note };
        return apiRetry('/functions/v1/trip-edit', { method: 'POST', body: JSON.stringify(body) })
          .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }, function () { return { ok: false, j: null }; }); })
          .then(function (x) {
            if (!(x.ok && x.j && x.j.ok)) { R.fail++; return; }
            R.ok++;
            // 서버가 되돌려 준 값으로 갈아끼운다(운행 고치기 saveTrip 과 같다) — 다시 받기 전에도 표가 바로 맞게
            var row = x.j.row || {}, t = ALL_TRIPS.filter(function (y) { return String(y.id) === String(it.trip.id); })[0];
            if (t) Object.keys(row).forEach(function (k) { if (k !== 'id') t[k] = row[k]; });
          }, function () { R.fail++; })
          .then(function () { done++; say('맞추는 중… ' + n0(done) + '/' + n0(still.length)); return worker(); });
      };
      say('맞추는 중… 0/' + n0(still.length));
      return Promise.all([worker(), worker(), worker()]).then(function () { return R; });
    }).then(function (R) {
      if (TSUG === S0) TSUG = null;
      closePanel();
      var warn = [];
      if (R.stale) warn.push(n0(R.stale) + '건은 그 사이 통행료가 정해져 건너뛰었어요.');
      if (R.fail) warn.push(n0(R.fail) + '건은 저장하지 못했어요. 그 운행을 눌러 직접 고쳐 주세요.');
      if (R.ok) toastOk(n0(R.ok) + '건을 맞췄어요.', warn.join(' ') || null);
      else toast(warn.join(' ') || '맞춘 운행이 없어요.', true);
      AUDIT = null; TRIP_CACHE = {};
      paintPills(); render();
      loadAll();                                   // 서버 값으로 다시 받아 표·합계를 다시 센다
    }, function () {
      S0.busy = false; lockUi(false); tsPick(null);
      toast('운행 정보를 불러오지 못해 아무것도 바꾸지 않았어요. 잠시 후 다시 눌러 주세요.', true);
    });
  }

  /** 「다른 운행에 붙이기」 창 — 이번 주기 내 영수증(주차·통행료)마다 어느 운행 것인지 고른다. */
  function openEvLink(cat, focusId) {
    var me = myName(), r = cycleRange(CYC);
    EVLINK_UNDO = null;
    // 구분 하나(「주차」) 또는 여럿(「주차,통행료」) — 마감 화면 「운행 없는 날 영수증」이 두 구분을 함께 가리키면 창에 둘 다(2026-10-20 V3 B4:
    //   주차 창만 열려 통행료 영수증이 목록에 없었다). 줄마다 구분 딱지.
    var cats = String(cat == null ? '' : cat).split(',').filter(Boolean), many = cats.length > 1, catName = cats.join('·');
    var evs = EVID.filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === me && cats.indexOf(e.category) >= 0 && Number(e.amount) > 0 && d >= r.lo && d < r.hi;
    }).sort(function (a, b) { return a.date_millis - b.date_millis; });
    var trips = TRIPS.filter(function (t) { return t.username === me && !t.deleted_at && t.start_time >= r.lo && t.start_time < r.hi; })
      .sort(function (a, b) { return a.start_time - b.start_time; });
    if (!evs.length) { toast('이번 기간에 올린 ' + catName + ' 영수증이 없어요.'); return; }
    var bad = {}; cats.forEach(function (c) { evUnmatched(c).forEach(function (e) { bad[e.id] = 1; }); });
    // 두 번 정산 의심(2026-10-20 R14) — 다음 날 날짜로 올라온 전날 영수증일 수 있는 것: 줄에 까닭을 적고 운행 칸에서 전날 묶음을 짚는다
    var twice = {}, MM = moneyOf(me, r);
    cats.forEach(function (c) { ((MM[c] || {}).days || []).forEach(function (d) { if (d.twice && d.show) d.twice.ev.forEach(function (e) { twice[e.id] = d.twice.prev; }); }); });
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
      // 다른 기간 운행에 이어진 영수증(2026-10-17) — 지금 이은 운행을 고른 채로 보여 준다(그대로 저장해도 풀리지 않게).
      //   이번 기간 운행을 고르면 다시 이어지고, 「자동」을 고르면 영수증 날짜로 붙는다.
      var xt = e.trip_id != null && !trips.some(function (t) { return String(t.id) === String(e.trip_id); }) ? xlinkTrip(e, null) : null;
      var opts = (xt ? '<option value="' + esc(String(e.trip_id)) + '" selected>지금: ' + esc(md(xt.start_time)) + ' 운행(' + CR.short(cycleOfMs(Number(xt.start_time))) +
        ')에 이어짐 — 어느 기간에도 정산 안 됨</option>' : '') +
        '<option value="">자동 — 영수증 날짜(' + esc(dayName(e.date_millis)) + ') 운행에 붙이기</option>' + groups.map(function (g) {
        return '<optgroup label="' + esc(dayName(g.ms) + (g.k === ymd(e.date_millis) ? '  ← 영수증과 같은 날' : twice[e.id] === g.k ? '  ← 전날(영수증 없는 운행)' : '')) + '">' + g.list.map(function (t) {
          return '<option value="' + t.id + '"' + (String(e.trip_id || '') === String(t.id) ? ' selected' : '') + '>' + esc(tripLabel(t)) + '</option>';
        }).join('') + '</optgroup>';
      }).join('');
      return '<tr' + (bad[e.id] || twice[e.id] ? ' class="flagged"' : '') + ' data-evlinkrow="' + esc(String(e.id)) + '"><td style="white-space:nowrap">' +
        (many ? '<span class="kind">' + esc(e.category) + '</span> ' : '') + '<span class="lead">' + esc(dayName(e.date_millis)) + '</span>' +
        (hm(e.date_millis) !== '00:00' ? ' <span class="dim">' + esc(hm(e.date_millis)) + '</span>' : '') + (bad[e.id] ? '<div><span class="st warn">' + (xt ? '다른 기간 운행에 이어짐' : '그날 업무 운행 없음') + '</span></div>'
          : twice[e.id] ? '<div><span class="st warn">두 번 정산 의심</span></div><div class="evtw" style="white-space:normal">전날(' + esc(twice[e.id].slice(5).replace('-', '.')) + ') 운행 영수증이면 운행 칸에서 전날 운행을 고르세요</div>' : '') + '</td>' +
        '<td class="n" style="white-space:nowrap">' + n0(e.amount) + '원</td>' +
        '<td style="width:100%"><select class="inp" data-evlinksel="' + e.id + '" data-was="' + esc(String(e.trip_id || '')) + '" style="min-width:260px">' + opts + '</select></td></tr>';
    }).join('');
    openPanel(catName + ' 영수증을 다른 운행에 붙이기', cycleName(CYC) + ' · ' + n0(evs.length) + '건',
      '<div class="anote" style="margin-top:0">영수증은 보통 <b>같은 날 운행</b>에 연결돼요. 자정을 넘겨 결제했거나 수기 운행 날짜가 달라 ' +
      '그날 업무 운행이 없으면, 영수증 날짜는 그대로 두고 <b>어느 운행의 영수증인지</b>만 골라 저장하세요. ' +
      '맞는 운행이 없으면 1단계에서 운행을 넣거나, 잘못 올린 영수증이면 내역에서 지우세요.</div>' +
      '<div id="evLinkUndo"></div>' +
      // evlinkt — 폰에서는 줄마다 두 줄(날짜·금액 / 운행 고르기 칸 전체 폭). 창(348px) 안에 660px 표라 운행 칸이 가로 스크롤 뒤에 있었다(2026-10-20 V3 U3)
      '<div class="panel" style="margin-top:12px"><div class="scroll"><table class="evlinkt"><thead><tr><th>영수증 날짜</th><th class="n">금액</th><th>운행</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnEvLinkSave">저장</button>', true);
    // 표의 그 줄 「다른 운행에 붙이기」로 열었으면 그 영수증 줄을 보이게(웹 8차)
    var fr = focusId != null && document.querySelector('[data-evlinkrow="' + String(focusId).replace(/[^0-9A-Za-z_-]/g, '') + '"]');
    if (fr) { fr.classList.add('evlfocus'); try { fr.scrollIntoView({ block: 'center' }); } catch (e) { } var sel = fr.querySelector('select'); if (sel) sel.focus({ preventScroll: true }); }
  }
  function saveEvLink() {
    var sels = [].slice.call(document.querySelectorAll('[data-evlinksel]')).filter(function (s) { return s.value !== s.dataset.was; });
    if (!sels.length) { toast('바뀐 내용이 없어요.'); closePanel(); return; }
    var btn = $('btnEvLinkSave');
    // 옮기는 영수증의 금액이 지금 다른 운행에 들어가 있으면(웹 영수증 적기) 함께 되돌릴지 먼저 묻는다(2026-10-20 AU2 ① —
    //   안 되돌리면 그 운행 금액이 남아 두 번 정산된다). 처음 누르면 확인 → 있으면 목록을 보이고 한 번 더 「저장」, 없으면 바로 저장.
    var key = sels.map(function (s) { return s.dataset.evlinksel + ':' + s.value; }).join('|');
    if (!EVLINK_UNDO || EVLINK_UNDO.key !== key) {
      var moves = sels.map(function (s) {
        var e = EVID.filter(function (x) { return String(x.id) === String(s.dataset.evlinksel); })[0];
        return e ? { e: e, to: s.value ? Number(s.value) : null } : null;
      }).filter(Boolean);
      var tok = EVLINK_UNDO = { key: key, plan: null };
      if (btn) { btn.disabled = true; btn.textContent = '확인하는 중…'; }
      fillUndoPlan(moves).then(function (plan) {
        if (EVLINK_UNDO !== tok) return;
        tok.plan = plan;
        if (!plan.length) { evLinkWrite(sels, []); return; }
        var host = $('evLinkUndo');
        if (host) { host.innerHTML = undoBlock(plan); try { host.scrollIntoView({ block: 'nearest' }); } catch (e) { } }
        if (btn) { btn.disabled = false; btn.textContent = '저장'; }
        toast('이 영수증 금액이 들어간 운행이 있어요. 목록을 확인하고 ‘저장’을 한 번 더 눌러 주세요.');
      });
      return;
    }
    evLinkWrite(sels, undoPicked(EVLINK_UNDO.plan));
  }
  /** 이음 저장 + 켜 둔 「넣은 금액 되돌리기」(이음을 저장한 영수증 것만). */
  function evLinkWrite(sels, picked) {
    var btn = $('btnEvLinkSave'); if (btn) { btn.disabled = true; btn.textContent = '저장하는 중…'; }
    var fail = 0, saved = {};
    var one = function (i) {
      if (i >= sels.length) return Promise.resolve();
      var s = sels[i];
      return apiRetry('/rest/v1/evidences?id=eq.' + encodeURIComponent(s.dataset.evlinksel), {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ trip_id: s.value ? Number(s.value) : null })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) { if (!rows || !rows.length) fail++; else saved[String(s.dataset.evlinksel)] = 1; }, function () { fail++; })
        .then(function () { return one(i + 1); });
    };
    one(0).then(function () {
      var undo = (picked || []).filter(function (p) { return p.ev.some(function (x) { return saved[String(x)]; }); });
      return undo.length ? applyUndo(undo) : null;
    }).then(function (u) {
      EVLINK_UNDO = null;
      closePanel();
      toast((fail ? (sels.length - fail) + '건을 저장했고 ' + fail + '건은 저장하지 못했어요. 결재 중이거나 다른 기간 운행일 수 있어요.'
        : sels.length + '건을 맞췄어요.') + undoSay(u), !!fail || !!(u && u.fail));
      if (u && u.ok) TRIP_CACHE = {};
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
    var mine = who || myName(), u = personOf(mine), r = cycleRange(CYC);
    var all = TRIPS.filter(function (t) {
      return t.username === mine && PRINT_PURPOSES.indexOf(t.purpose || '') >= 0;
    });
    var g = platesOf(all, u.plate_no || '');
    var boxes = boxesOf(a, u, mine), labels = boxLabels(a);
    var pick = evidBySheet(mine, g.plates, r), legacy = legacyDoc(a);
    var sheets = g.plates.map(function (p, i) {
      var d = sheetDataFor(mine, u, p, g.by[p], r, pick[i], legacy);
      d.boxes = boxes; d.boxLabels = labels;
      return d;
    });
    var evid = EVID.filter(function (e) {
      var d = Number(e.date_millis);
      return e.username === mine && d >= r.lo && d < r.hi && e.photo_path;
    }).sort(function (x, y) { return x.date_millis - y.date_millis || x.id - y.id; });
    // (옛 재료 — 문서는 이제 ev 로 그린다. 사진이 있는지 보는 데·예전 도구가 읽는 데만 남긴다.)
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
    return { sheets: sheets, scans: scans, photos: photos, ev: evMaterial(mine, r, sheets, legacy),
      any: hasRow || scans.length > 0 || photos.length > 0 };
  }
  /**
   * 결재 문서의 근거 재료(2026-10-23 관리자 신고 — 하이패스 근거 누락 · 원본 장 줄이 「통행료」 쪽에 없음 · 순서 · 표 금액과 맞춰 볼 줄 없음).
   * sheetpdf.js 가 「통행료 근거」 한 흐름 · 사진 쪽 차례 · 원본 부록으로 그린다. 지금 전역(고정본이면 withFrozen 안)에서 만든다.
   * ★ 금액은 다시 세지 않는다 — 날마다 값은 moneyOf(금액 규칙 v3) 그대로, 표 칸 값은 이 문서의 장(sheets)에서 읽는다.
   *   인쇄할 때 받아야 하는 것(하이패스 영수증 줄·원본 경로 · 사진 판독 시각 · 찍은 시각)은 pdfPrep 이 채운다.
   */
  function evMaterial(mine, r, sheets, legacy) {
    var M = moneyOf(mine, r);
    var inR = function (ms) { ms = Number(ms); return ms >= r.lo && ms < r.hi; };
    var has = function (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); };
    var biz = TRIPS.filter(function (t) { return t.username === mine && !t.deleted_at && (t.purpose || '') === BUSINESS && inR(t.start_time); });
    var evs = EVID.filter(function (e) { return e.username === mine && inR(e.date_millis); });
    var dayOf = {};                  // 영수증 id → 규칙 v3 이 붙인 날(이은 운행의 날 · 자정 넘긴 운행의 날)
    ['주차', '통행료'].forEach(function (cat) { M[cat].days.forEach(function (d) { d.ev.forEach(function (e) { dayOf[e.id] = d.day; }); }); });
    // 표 칸 값(이 문서의 장들) — 날마다·합계. 대조 줄의 「표 통행료」는 이것이다.
    var table = { '통행료': { total: 0, byDay: {} }, '주차': { total: 0, byDay: {} } };
    var addT = function (cat, day, v) { v = Math.round(Number(v) || 0); if (!v) return; table[cat].total += v; table[cat].byDay[day] = (table[cat].byDay[day] || 0) + v; };
    sheets.forEach(function (sh) {
      (sh.rows || []).forEach(function (x) { addT('통행료', x.date, x.toll); addT('주차', x.date, x.parking); });
      (sh.orphans || []).forEach(function (x) { addT('통행료', x.date, x.toll); addT('주차', x.date, x.parking); });
    });
    var days = function (cat) {
      return M[cat].days.map(function (d) {
        var hp = {};
        (d.hp || []).forEach(function (t) { hp[t.id] = Math.round((d.ha && d.ha[t.id]) || 0); });
        return { day: d.day, T: Math.round(d.T), H: Math.round(d.H || 0), D: Math.round(d.D || 0), settle: Math.round(d.settle), st: d.st,
          U: d.ev.reduce(function (s, e) { return s + Math.round(Number(e.amount) || 0); }, 0),
          ev: d.ev.map(function (e) { return e.id; }), hp: hp, amt: d.amt || {}, trips: d.trips.map(function (t) { return t.id; }),
          fill: d.fillEv || {}, target: d.target ? d.target.id : null, dup: (d.dup || []).map(function (e) { return e.id; }) };
      });
    };
    var ejOf = function (v) { if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } } return v || null; };
    var trips = biz.map(function (t) {
      var a = tollNeed(t).a, ej = has(t, 'toll_evidence_json');
      return { id: t.id, start: Number(t.start_time), end: t.end_time == null || t.end_time === '' ? null : Number(t.end_time),
        visit: t.visit_place || '', to: dong(t.end_address), plate: t.plate_no || '',
        // 하이패스 몫(규칙 v3 은 통행료가 있는 운행만 센다) — 이 값이 있는데 자료에 toll_evidence_json 칸이 없으면 인쇄 준비가 지금 줄을 받는다
        hp: a > 0 && window.MoneyRule ? window.MoneyRule.hipassOf(t, a) : 0,
        ej: ej ? ejOf(t.toll_evidence_json) : undefined, line: ej ? 'frozen' : '',
        // 결재본(또는 지금 화면)의 통행료 — 지금 줄을 받으면 이것과 같을 때만 쓴다
        fz: { c: t.toll_cost == null || t.toll_cost === '' ? null : Number(t.toll_cost), s: t.toll_status || '', src: t.toll_source || '',
          h: has(t, 'toll_hipass') ? (t.toll_hipass == null || t.toll_hipass === '' ? null : Number(t.toll_hipass)) : undefined } };
    });
    var items = evs.map(function (e) {
      var lt = linkedTrip(e, r);
      return { id: e.id, cat: e.category || '기타', ms: Number(e.date_millis),
        cap: has(e, 'captured_at') ? (e.captured_at == null || e.captured_at === '' ? null : Number(e.captured_at)) : undefined,
        amount: Number(e.amount) || 0, memo: e.memo || '', plate: e.vehicle_plate || '', photo: e.photo_path || '', scan: e.scan_path || '',
        link: lt ? lt.id : null, day: dayOf[e.id] || ymd(Number(e.date_millis)), ai: null };
    });
    // 계기판 사진의 차 — 번호판이 없는 사진은 업무 운행 차가 한 대일 때만 그 차(서버 검증 R12·A05 와 같은 bizPlates)
    var plates = [];
    biz.forEach(function (t) { var p = t.plate_no || ''; if (t.end_odometer != null && plates.indexOf(p) < 0) plates.push(p); });
    // user — 하이패스 원본은 이 사람 폴더(<아이디>/hipass/…)의 것만 싣는다(sheetpdf 보안 확인)
    return { v: 1, user: mine, legacy: !!legacy, frozen: !!FROZEN_ON, items: items, trips: trips,
      money: { '통행료': { days: days('통행료') }, '주차': { days: days('주차') } }, table: table, bizPlates: plates, photoMeta: null };
  }
  /**
   * 인쇄 준비(2026-10-23) — 근거 재료(doc.ev)에 인쇄할 때만 받는 것을 채운다. 모두 읽기만 하는 GET 이고, 못 받아도 문서는 만든다.
   * 세 길(결재 완료 한 사람 PDF · 결재 완료 묶음 · 상신 전 미리보기·결재 중 문서)이 모두 이것을 거친다 — 같은 자료면 같은 문서.
   *   ① 하이패스 영수증 줄 — 자료의 운행에 toll_evidence_json 칸이 없으면(이미 결재된 10월분 고정본 · 지금 자료) 지금 줄을 받는다.
   *      그 운행의 toll_cost·toll_status·toll_source(·toll_hipass)가 자료와 같을 때만 쓴다 — 다르면 「결재 뒤 바뀐 운행」(줄을 싣지 않음).
   *      결재 기간은 잠겨 있어 보통 같다. 못 받으면(권한·연결) 「하이패스 영수증 줄을 받지 못함」 + 문서 점검 「확인 필요」.
   *   ①-2 결재본 줄은 있는데 원본 경로(pdf)가 없는 줄(금액 0 줄은 빼고)이 있으면 — 결재본 문서만(미리보기는 자료 그대로) 지금 운행도 받아
   *      (같은 주소·같은 묶음), 금액 칸이 결재본과 같을 때만 같은 줄(시각·출구 영업소·금액, 둘 다 있으면 입구)의 pdf·page 를 인쇄 재료에만 옮긴다(2026-10-23 —
   *      10월분 원본은 관리자가 모아 지금 운행 줄에 붙인다). 결재본 자료는 고치지 않는다 — 고친 줄만 새로 만들고, 옮긴 줄 차례는 t.late(「상신 뒤 덧붙임」).
   *      금액이 다르면 결재본 줄 그대로(「원본 없음」). 지금 운행을 못 받으면(관리자가 아닌 결재자는 남의 운행을 읽지 못해 빈 목록 · 연결 실패)
   *      원본이 있는지 모른다 — 인쇄 재료에 t.lateMiss 를 적어 그 줄은 「확인 못 함」 + 문서 점검 「원본을 확인하지 못한 운행 N건」(2026-10-23 검토 —
   *      예전에는 조용히 「원본 없음」이었다). 결재본 자료(t.ej 가 가리키는 것)는 그대로 — t 는 이 인쇄의 재료다.
   *   ② 사진 판독(evidence_ai) — 영수증 시각(원본 장 줄이면 그 장 판독에서 짝지은 영수증의 시각) · 원본 장 안 자리 · 그 장 영수증 수 · 계기판 km.
   *      사진이 바뀐 판독은 쓰지 않는다. 볼 수 있는 사람만(본인·관리자) — 못 보면 찍은 시각, 그것도 없으면 그날 맨 뒤.
   *   ③ 찍은 시각(captured_at) — 지금 자료(EVID)에는 그 칸이 없다(고정본에는 있다).
   */
  function pdfPrep(doc) {
    var ev = doc && doc.ev;
    if (!ev || ev.prepped) return Promise.resolve(doc);
    var get = function (path) { return apiRetry(path).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); };
    var chunks = function (list) { var out = []; for (var i = 0; i < list.length; i += 80) out.push(list.slice(i, i + 80)); return out; };
    var idList = function (l) { return l.map(function (x) { return encodeURIComponent(String(x.id)); }).join(','); };
    var num = function (v) { return v == null || v === '' ? null : Number(v); };
    var ejOf = function (v) { if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } } return v || null; };
    var byId = {};
    ev.items.forEach(function (e) { byId[String(e.id)] = e; });
    var jobs = [];
    // ①-2 — 근거 줄(sheetpdf tollFlow 와 같은 규칙: lines 가 비어 있지 않으면 그것, 아니면 prev.lines) · 줄 금액(원)
    var linesOf = function (ej) {
      if (!ej || typeof ej !== 'object') return null;
      if (Array.isArray(ej.lines) && ej.lines.length) return { list: ej.lines, prev: false };
      var pv = ej.prev && typeof ej.prev === 'object' ? ej.prev : null;
      return pv && Array.isArray(pv.lines) && pv.lines.length ? { list: pv.lines, prev: true } : null;
    };
    var amtOf = function (l) { return Math.round(Number(l && l.amount) || 0); };
    var noPdf = function (l) { return !!l && typeof l === 'object' && !l.pdf && amtOf(l) > 0; };
    var own = function (o) { var c = {}, k; for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k]; return c; };
    /** 결재본 줄(t.ej)에 지금 줄(cur — 지금 운행의 toll_evidence_json)의 원본 경로를 옮긴다. t.ej 가 가리키는 결재본은 그대로 두고 새 근거를 만든다. */
    var latePdf = function (t, cur) {
      var L = linesOf(t.ej), cu = cur && typeof cur === 'object' ? cur : null;
      if (!L || !cu) return;
      var cp = cu.prev && typeof cu.prev === 'object' ? cu.prev : null;
      var pool = [].concat(Array.isArray(cu.lines) ? cu.lines : [], cp && Array.isArray(cp.lines) ? cp.lines : [])
        .filter(function (c) { return !!c && typeof c === 'object' && typeof c.pdf === 'string' && !!c.pdf; });
      if (!pool.length) return;
      var str = function (v) { return v == null ? '' : String(v).trim(); };
      var idx = [];
      var list = L.list.map(function (l, i) {
        if (!noPdf(l) || !str(l.at)) return l;
        var hit = pool.filter(function (c) {
          return str(c.at) === str(l.at) && str(c.office) === str(l.office) && amtOf(c) === amtOf(l) &&
            (!str(c.entry) || !str(l.entry) || str(c.entry) === str(l.entry));
        })[0];
        if (!hit) return l;
        var o = own(l);
        o.pdf = hit.pdf;
        if (hit.page != null && hit.page !== '') o.page = hit.page; else delete o.page;
        idx.push(i);
        return o;
      });
      if (!idx.length) return;
      var ej = own(t.ej);
      if (L.prev) { ej.prev = own(t.ej.prev); ej.prev.lines = list; } else ej.lines = list;
      t.ej = ej; t.late = idx;
    };
    var late = ev.frozen ? ev.trips.filter(function (t) { var L = t.hp > 0 && t.line === 'frozen' ? linesOf(t.ej) : null; return !!L && L.list.some(noPdf); }) : [];
    chunks(ev.trips.filter(function (t) { return t.hp > 0 && t.ej === undefined; }).concat(late)).forEach(function (part) {
      jobs.push(get('/rest/v1/trips?select=id,toll_cost,toll_status,toll_source,toll_hipass,toll_evidence_json&id=in.(' + idList(part) + ')').then(function (rows) {
        var by = {};
        (rows || []).forEach(function (x) { by[String(x.id)] = x; });
        part.forEach(function (t) {
          var x = by[String(t.id)];
          var same = !!x && num(x.toll_cost) === t.fz.c && String(x.toll_status || '') === t.fz.s && String(x.toll_source || '') === t.fz.src &&
            (t.fz.h === undefined || num(x.toll_hipass) === t.fz.h);
          // ①-2 결재본 줄이 있는 운행 — 줄은 결재본 그대로. 금액이 같을 때만 원본 경로를 옮기고, 다르면 그대로 둔다(「원본 없음」).
          //   못 받았으면(빈 목록 — 볼 권한 없음 · 지운 운행) 원본이 있는지 모른다: t.lateMiss(「확인 못 함」). 옮기다 깨져도(지금 근거 꼴 이상) 같다.
          if (t.line === 'frozen') {
            if (!x) t.lateMiss = true;
            else if (same) { try { latePdf(t, ejOf(x.toll_evidence_json)); } catch (e) { t.lateMiss = true; } }
            return;
          }
          if (!x) { t.line = 'nofetch'; return; }
          if (!same) { t.line = 'stale'; return; }
          t.ej = ejOf(x.toll_evidence_json); t.line = 'live';
        });
      }, function () { part.forEach(function (t) { if (t.line === 'frozen') t.lateMiss = true; else t.line = 'nofetch'; }); }));
    });
    chunks(ev.items.filter(function (e) { return e.photo; })).forEach(function (part) {
      jobs.push(get('/rest/v1/evidence_ai?select=evidence_id,photo_path,result&evidence_id=in.(' + idList(part) + ')').then(function (rows) {
        (rows || []).forEach(function (x) {
          var e = byId[String(x.evidence_id)];
          if (e && x.photo_path === e.photo) e.ai = aiBits(e, x.result || {});
        });
      }, function () { }));
    });
    chunks(ev.items.filter(function (e) { return e.cap === undefined && e.cat !== '계기판'; })).forEach(function (part) {
      jobs.push(get('/rest/v1/evidences?select=id,captured_at&id=in.(' + idList(part) + ')').then(function (rows) {
        (rows || []).forEach(function (x) { var e = byId[String(x.id)]; if (e) e.cap = x.captured_at == null || x.captured_at === '' ? null : Number(x.captured_at); });
      }, function () { }));
    });
    return Promise.all(jobs).then(function () { ev.prepped = true; return doc; });
  }
  /** 사진 판독 한 줄 → 근거 재료에 쓸 것(시각 · 원본 장 안 자리 · 그 장 영수증 수 · 계기판 km · 상호). 원본 장 줄은 원본 장 판독(via 'scan_page')만 —
   *  오린 줄 사진으로 읽은 옛 판독은 서버도 쓰지 않는다(driving-verify.ts scanState 'stale'). 영수증 수는 서버 isRcpt 와 같은 셈. */
  function aiBits(e, r) {
    var hm0 = function (t) { return /^\d{2}:\d{2}$/.test(String(t || '')) ? String(t) : null; };
    var rcpt = function (x) { return !!x && x.kind !== 'odometer' && (x.amount != null || ['fuel', 'parking', 'toll', 'unreadable'].indexOf(String(x.kind)) >= 0); };
    var out = { time: null, idx: null, n: null, km: null, merchant: '' };
    if (e.scan && e.cat !== '계기판') {
      if (r.via === 'scan_page' && r.scan_path === e.scan && Array.isArray(r.all)) {
        var i = r.page_idx != null && r.page_idx !== '' && isFinite(Number(r.page_idx)) ? Number(r.page_idx) : null, m = i != null ? r.all[i] : null;
        out.idx = i; out.n = r.all.filter(rcpt).length;
        out.time = hm0(m ? m.time : r.time); out.merchant = String((m && m.merchant) || r.merchant || '');
      }
      return out;
    }
    if (r.legible === false || r.kind === 'unreadable') return out;
    out.time = hm0(r.time); out.merchant = String(r.merchant || '');
    if (r.odometer_km != null && r.odometer_km !== '' && isFinite(Number(r.odometer_km))) out.km = Math.round(Number(r.odometer_km));
    return out;
  }
  /** 엑셀 파일들(차량별 1개). 지금 전역에서 만든다 — downloadXlsx 와 같은 규칙·같은 파일 이름.
   *  a = 그 문서의 결재 건(결재란 칸 이름을 고른다 — 예전 건 v1). 안 넘기면 그 사람·기간의 운행일지 결재 건. */
  function xlsxFiles(who, a) {
    if (!window.Xlsx) return [];
    var mine = who || myName(), u = personOf(mine), r = cycleRange(CYC);
    var all = TRIPS.filter(function (t) {
      return t.username === mine && PRINT_PURPOSES.indexOf(t.purpose || '') >= 0;
    });
    // 운행이 없어도 영수증(주차·통행료)만 있으면 근거자료 행만 든 한 장을 만든다 — PDF 와 같은 내용이어야 한다.
    var g = platesOf(all, hasSettleEvid(mine, r) ? (u.plate_no || '') : null);
    var pick = evidBySheet(mine, g.plates, r), legacy = legacyDoc(a);
    var ap = a === undefined ? apprOf(mine, CYCKEY()) : a;
    var labels = boxLabels(ap);
    // 결재란 칸 값(2026-10-14 — 법인카드·개인경비 엑셀과 같게): 결재 건이 있으면 PDF 와 같은 boxesOf(docBoxes)로
    //   승인한 칸 이름·날짜, 결재선에 없는 칸 빗금. 결재 건이 없는 상신 전 엑셀은 앱 엑셀 그대로 빈칸.
    var boxes = ap ? boxesOf(ap, u, mine) : null;
    return g.plates.map(function (plate, i) {
      var safe = String(plate).replace(/[^0-9A-Za-z가-힣]/g, '') || '차량';
      var data = sheetDataFor(mine, u, plate, g.by[plate], r, pick[i], legacy);
      data.boxLabels = labels;
      if (boxes) data.boxes = boxes;
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
    var keep = { T: TRIPS, E: EVID, V: VEHICLES, R: RATES, M: RATE_MISS, C: CYC, Q: QBOUNDS, P: PRINT_PURPOSES, F: FROZEN_RANGE,
      hadU: Object.prototype.hasOwnProperty.call(USERS, u), U: USERS[u] };
    try {
      TRIPS = fz.trips || []; EVID = fz.evidences || []; VEHICLES = fz.vehicles || [];
      RATES = {}; RATE_MISS = {};
      (fz.rates || []).forEach(function (x) { RATES[x.year + '-' + x.quarter + '-' + x.region] = Number(x.price); });
      setQuarterBounds(fz.quarter_bounds);
      CYC = parseCyc(fz.cycle) || { y: NaN, m: NaN };          // 추가 기간 '2026-12b' 도(2026-10-20)
      // 서버가 굳힌 기간 범위(frozenData.range, ms)가 있으면 그것 — 없으면(옛 문서) 키로 계산(그때는 모두 기본 규칙이라 같다)
      var fr = fz.range || {};
      FROZEN_RANGE = typeof fr.lo === 'number' && typeof fr.hi === 'number' && isFinite(fr.lo) && isFinite(fr.hi) && fr.hi > fr.lo
        ? { key: cycKey(CYC), lo: fr.lo, hi: fr.hi } : null;
      if (fz.user) USERS[u] = fz.user;
      PRINT_PURPOSES = [BUSINESS];
      FROZEN_ON = true;                  // 예전 규칙(v1·v2) 결재 건이면 그때 규칙으로 다시 만든다(legacyDoc)
      return fn();
    } finally {
      FROZEN_ON = false;
      TRIPS = keep.T; EVID = keep.E; VEHICLES = keep.V; RATES = keep.R; RATE_MISS = keep.M;
      CYC = keep.C; QBOUNDS = keep.Q; PRINT_PURPOSES = keep.P; FROZEN_RANGE = keep.F;
      if (keep.hadU) USERS[u] = keep.U; else delete USERS[u];
    }
  }
  /** 옆 패널을 연다(제목·부제는 글자 그대로, 본문·아랫줄은 HTML). */
  function openPanel(title, sub, bodyHtml, footHtml, wide) {
    CLOSE_ASK = null;
    if (EDUW) eduStop();          // 시청 창 위에 다른 창을 띄우면 영상은 멈추고 위치를 저장한다

    // 결재 확인 창 위에 다른 내용(결재 문서·검증 결과)을 띄우는 것이면 돌아올 곳과 적던 의견을 맡아 둔다.
    // 결재 확인 창이 자기 자신을 다시 그리는 것(검증 결과를 받은 뒤 등)이면 돌아올 곳이 아니다 — 「← 결재 화면으로」가 저절로 생겼다(2026-10-16 4차).
    var go0 = $('btnApprGo');
    if (go0 && $('panel').classList.contains('open') && String(footHtml || '').indexOf('id="btnApprGo"') < 0) {
      APPR_BACK = { act: go0.dataset.act, id: +go0.dataset.id, kind: go0.dataset.kind || '', why: String(($('apprWhy') || {}).value || '') };
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
  /* ── 창 아래 줄 단추 차례 — [동작] … [취소·닫기](2026-10-20 사용자 「웹 전체 통일」, 결재 창과 같게) ──
     웹의 모든 확인·입력 창 아래 줄에서 취소·닫기를 맨 끝(오른쪽)에 둔다. 창마다 HTML 을 고치지 않고 여기 한 곳에서 —
     #pFoot 의 자식이 바뀔 때마다(openPanel · 확장 모듈의 C.openPanel · $('pFoot').innerHTML 을 바로 쓰는 곳 모두) 취소·닫기를 줄 끝으로 옮긴다.
       · 취소·닫기 = [data-close](창 닫기) · [data-cancel](닫지 않고 앞 화면으로 — 운행 고치기 「취소」, 닫기 되묻기 「계속 입력」)
       · DOM 째 옮긴다 — Tab 차례 = 보이는 차례(CSS order 로 자리만 바꾸면 둘이 어긋난다). 이미 끝에 있으면 아무것도 안 한다(되풀이 없음)
       · 옮기면 브라우저가 그 단추의 초점을 놓는다 — 초점이 있었으면 다시 준다(닫기 되묻기는 「계속 입력」에 초점)
       · 사이 칸(flex:1) 앞의 왼쪽 단추(「← 결재 화면으로」·개인경비 「지우기」 등)는 그대로 왼쪽.
         「상신 뒤 유류단가가 바뀌었습니다」 줄의 [반려하기] [그래도 승인]은 취소 단추가 없어 그대로(정해 둔 차례) */
  function footOrder() {
    var pf = $('pFoot'); if (!pf) return;
    var kids = Array.prototype.slice.call(pf.children);
    var cs = kids.filter(function (n) { return n.matches && n.matches('[data-close],[data-cancel]'); });
    if (!cs.length) return;
    var tail = kids.slice(kids.length - cs.length);
    if (cs.every(function (n, i) { return tail[i] === n; })) return;
    var act = document.activeElement;
    cs.forEach(function (n) { pf.appendChild(n); });
    if (act && cs.indexOf(act) >= 0) { try { act.focus({ preventScroll: true }); } catch (e) { } }
  }
  if (window.MutationObserver && $('pFoot')) new MutationObserver(footOrder).observe($('pFoot'), { childList: true });

  /* ══════════════════ 확장 모듈 이음매 ══════════════════
     drv-*.js 가 window.DrvExtQ 에 올려 둔 것을 여기서 붙인다. 화면(view)을 더하고,
     결재 카드에 끼울 조각과 상신 직전에 돌릴 일을 받는다. 없으면 없는 대로 돈다. */
  (function () {
    var C = {
      $: $, SB: SB, esc: esc, ic: ic, n0: n0, won: won, km: km, pad: pad, md: md, hm: hm, ymd: ymd, snapTrips: snapTrips,
      toast: toast, toastOk: toastOk, apiRetry: apiRetry, fetchAll: fetchAll,
      // 숫자 칸 엄격하게 읽기(2026-10-20 AU2 #9) — 개인경비 금액 칸도 같은 규칙
      numIn: numIn, numMark: numMark, numStop: numStop, NUM_BAD: NUM_BAD,
      head: head, sect: sect, blank: blank, skeleton: skeleton,
      nameOf: nameOf, personOf: personOf, myName: myName,
      orgCell: orgCell, orgGroups: orgGroups, orgGroupRow: orgGroupRow, orgMatch: orgMatch, orgPath: orgPath, orgName: orgName, myAppr: myAppr, apprOf: apprOf,
      cycleRange: cycleRange, cycleName: cycleName, cycleSpan: cycleSpan,
      // 기간 엔진(2026-10-20 연말 마감) — 모듈은 기간을 CR(cycle-rules.js)로 센다. 키 글자 → 이름·범위, 갈래 글자 → kind
      CR: CR, cycKey: cycKey, parseCyc: parseCyc, keyName: keyName, keyShort: keyShort, keyRange: keyRange, keySpan: keySpan,
      prevMonthKey: CR.prevMonthKey, kindOfMode: kindOfMode,
      /** 관리 화면(마감 기간 설정)이 저장한 뒤 — 서버 답의 cycle_rules 를 바로 쓴다(바뀌었으면 true). 다시 받기(loadAll)는 부른 쪽이. */
      reloadRules: function (raw) { var ch = CR.set(raw); if (ch) { if (fixX()) writeHash(); paintCycle(); } return ch; },
      render: render, go: go, loadAll: loadAll, closePanel: closePanel, openPanel: openPanel, backBtn: backBtn,
      // pdfPrep — 인쇄 준비(하이패스 이용내역 줄 · 사진 판독 시각, 2026-10-23). PDF 를 만드는 세 길이 모두 pdfDocFor 다음에 부른다.
      pdfDocFor: pdfDocFor, pdfPrep: pdfPrep, fillSigns: fillSigns, openEdit: openEdit, photoUrl: photoUrl, evLocked: evLocked, xlsxFiles: xlsxFiles, withFrozen: withFrozen, saveBlob: saveBlob,
      // pdf.js 불러오기 — 결재 문서 PDF 가 하이패스 영수증 원본(「영수증 출력」 화면을 인쇄한 PDF)의 영수증을 읽을 때(drv-verify parseHipass, 2026-10-23)
      loadPdfJs: loadPdfJs,
      isAll: isAll, isMulti: isMulti, singleOnly: singleOnly, BOXES: BOXES,
      // 결재란·결재선 — 세 문서(운행일지·개인경비·법인카드)와 조직도 화면이 같은 것을 쓴다(2026-10-14)
      BOXES_V1: BOXES_V1, boxSetOf: boxSetOf, boxLabels: boxLabels, docBoxes: docBoxes, liveSign: liveSign,
      autoLine: autoLine, lineAt: lineAt, apprHint: APPR_HINT, canApprove: canApprove, retryHint: retryHint, endDot: endDot, lockSay: lockSay,
      // 관리자가 지정한 결재선(2026-10-14) — 조직도 화면(drv-org.js)이 같은 계산으로 보이고 고친다
      APPR_BOXES: APPR_BOXES, effLine: effLine, applyOverride: applyOverride, lineOverride: lineOverride,
      lineOvOk: function () { return LINE_OV_OK; }, fetchLineOv: fetchLineOv, setLineOv: setLineOv, orgLabel: orgLabel,
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
      setOrg: function (rows) { ORG = rows || []; },
      orgScopeName: orgScopeName,
      /** 검증을 돌린 뒤 — 영수증 화면의 사진 판독(evidence_ai)을 다시 받게 한다. */
      aiReset: function () { AIR = {}; AIR_ASKED = {}; },
      // 2026-10-07 개인경비(drv-expense.js)가 같이 쓰는 것 — 영수증 올리기·결재·기간
      fileToJpegs: fileToJpegs, evCrop: evCrop, evCropReset: evCropReset, bindDrop: bindDrop, gemSvg: gemSvg, gemTag: gemTag,
      apprTrack: apprTrack, stepText: stepText, apprStatusText: apprStatusText, callAppr: callAppr, canReopen: canReopen,
      // 의견 모아 보기(2026-10-21) — 담당 상신 의견 → 결재자 승인 의견. 개인경비·법인카드 결재 띠도 같은 조각
      opinions: opinionsHtml,
      inbox: inbox, paintPills: paintPills, openSubmit: openSubmit,
      // 마감 단계 진행 위치(2026-10-20 디자인 v2) — 검증 화면 단계 카드가 앞 단계 차례인지 본다(AU6-L9)
      stepNow: stepNow,
      addCycle: addCycle, cmpCycle: cmpCycle, currentCycle: currentCycle, kd: kd,
      usesDriving: usesDriving, noDriving: noDriving,
      apvSlot: apvSlot, teamBars: teamBars, kmenu: kmenu,
      // 관리 현황 「챙길 사람」 + 팀즈 알림 보내기(2026-10-20 D2) — 개인경비·법인카드 현황도 같은 조각
      follow: followCard,
      // 여러 줄 골라 지우기(2026-10-19) — 개인경비·법인카드 내역 표도 같은 모양·같은 확인 창
      mselDef: mselDef, mselAll: mselAll, mselAllLine: mselAllLine, mselBox: mselBox, mselBar: mselBar, mselSync: mselSync,
      // 결재 완료 출력 고르기·팀 고르기·이름 찾기(2026-10-23) — 세 화면이 같은 칸·같은 규칙(다시 그리지 않고 그 자리에서)
      fin: { reg: finReg, row: finRow, box: finBox, all: finAllAttr, grp: finGrp, bar: finBar, none: finNone,
        match: finMatch, order: finOrder, fileTag: finFileTag, sync: finSync },
      keepDrop: keepDrop
    };
    (window.DrvExtQ || []).forEach(function (make) {
      var x;
      try { x = make(C) || {}; } catch (e) { console.error('확장 모듈을 붙이지 못했습니다:', e); return; }
      Object.keys(x.views || {}).forEach(function (k) { VIEWS[k] = x.views[k]; });
      (x.admin || []).forEach(function (k) { if (ADMIN_VIEWS.indexOf(k) < 0) ADMIN_VIEWS.push(k); });
      ['apprExtra', 'wantSummaries', 'beforeSubmit', 'sumText', 'previewBytes', 'statusVerify'].forEach(function (k) { if (x[k]) EXT[k] = x[k]; });
      if (x.onCycle) EXT.onCycle.push(x.onCycle);
      if (x.dirty) EXT.dirty.push(x.dirty);
      if (x.onGo) EXT.onGo.push(x.onGo);
      // 개인경비(2026-10-07): 결재 문서 종류 · 기간 규칙 · 같이 받을 자료 · 「보는 범위」를 얹을 관리 화면
      Object.keys(x.kinds || {}).forEach(function (k) { EXT.kinds[k] = x.kinds[k]; });
      if (x.period) EXT.periods.push(x.period);            // 기간 규칙은 모듈마다(개인경비 'x' · 법인카드 'c')
      if (x.load) EXT.load.push(x.load);
      // 「보는 범위」 사람 — 모듈마다 자기 관리 화면에서만 값을 낸다(아니면 null). 앞의 것이 null 이면 다음 것.
      if (x.orgUsers) (function (prev, next) { EXT.orgUsers = prev ? function (v) { return prev(v) || next(v); } : next; })(EXT.orgUsers, x.orgUsers);
      (x.orgbar || []).forEach(function (k) { if (ORGBAR_VIEWS.indexOf(k) < 0) ORGBAR_VIEWS.push(k); });
    });
  })();

  /* ── 검증용 이음매 ──────────────────────────────────────────────
     실데이터 하네스(_realstub.js)가 깔렸을 때만 인쇄 생성기를 밖으로 낸다.
     배포본에는 __VERIFY__ 가 없으므로 아무 일도 하지 않는다. */
  if (window.__VERIFY__) {
    window.__buildPrint = buildPrint;
    window.__pdfDocFor = pdfDocFor; window.__totals = totals; window.__withFrozen = withFrozen; window.__pdfPrep = pdfPrep;
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
  // 앱 → 웹 프리패스(2026-10-20): 머리 스크립트(driving-v2.html)가 #pass=<코드> 를 보고 work.html 로 넘기는 중이면 아무것도 시작하지 않는다 —
  //   여기서 화면 주소를 바꾸거나 toPortal 로 다시 보내면 코드가 실린 이동이 덮여 코드를 잃는다.
  if (window.__DRV_TO_WORK) return;
  // 로그인 전이면 업무 결재 포털로 보낸다(보던 주소는 로그인 뒤 돌아오게). ?direct=1 이면 예전 로그인 화면을 쓴다.
  if (ss(K_AT) && me()) enter();
  else if (!window.__VERIFY__ && !/[?&]direct=1/.test(location.search)) toPortal(location.hash);
  else document.body.classList.add('showlogin');
})();
