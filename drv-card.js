/* ═══════════════════════════════════════════════════════════════════════════
   drv-card.js — 법인카드 지출결의 (2026-10-09, docs/card/SPEC.md §4)
   ---------------------------------------------------------------------------
   운행일지·개인경비에 이은 세 번째 결재 문서. 결재 방식(결재란·결재선·결재함·PDF 확인·정정 열기)은 같고,
   상신 창·결재함·결재 확인 창은 driving-app.js 의 것을 kind:'card' 로 부른다.
   ★ 기간은 달력 한 달: 1일 00:00 ~ 말일 24:00(KST). '2026-07' = 「2026년 7월분」 = 07.01 – 07.31.
   ★ 자료는 직원이 ERP 에서 받은 자기 카드 승인내역 엑셀(card-erp.js 가 읽는다 — SheetJS 는 올리기 창을 열 때만 싣는다).
     손으로 적는 칸은 구분·사용목적·비고뿐. 칸을 고치면 바로 저장한다(화면을 다시 그리지 않는다 — 커서가 튀지 않게).
   ★ 구분·사용목적이 빈 줄이 있으면 상신하지 못한다(beforeSubmit {blocked} + 서버 CARD_INCOMPLETE). 나머지 검증은 표시만.
   ★ 검증(2026-10-12): 「검증하기」 = expense-ai op card_review(서버가 줄을 읽어 규칙 C01~C09 + Gemini C07·C08, card_verifications 에 저장).
     서버·Gemini 를 못 쓰면 브라우저 규칙(card-rules.js — 서버 _shared/card-verify.ts 와 같은 판정)만 + 「AI 검증을 하지 못했습니다(규칙 검증만)」.
     Gemini 는 표시만 한다(warn). 상신을 막는 것은 빈칸(C01·C02)뿐. 사진 없음.
   ★ 저장(2026-10-12 → 2026-10-15): 칸은 자동 저장 + 표 위 저장 상태 줄(자동 저장됨·저장 중…·저장 못 함 N곳).
     「임시저장」 단추는 뺐다(2026-10-15 화면 정리) — 저장이 실패했을 때만 상태 줄에 「다시 저장」(그때 적은 값을 다시 보냄).
   ★ 다시 올리기는 ERP 칸만 upsert(CardErp.toRow) — 적어 둔 구분·사용목적·비고는 그대로, 파일에 없는 줄은 표시만.
   화면: c_month(이번 달 카드 내역) · c_verify(검증·상신) · 관리 ca_close(현황) · ca_list(전체 내역) · ca_final(결재 완료 출력) · ca_people(직원 현황)
   ═══════════════════════════════════════════════════════════════════════════ */
(window.DrvExtQ = window.DrvExtQ || []).push(function (C) {
  'use strict';
  var $ = C.$, esc = C.esc, ic = C.ic, n0 = C.n0, won = C.won, pad = C.pad;
  var R = window.CardRules, E = window.CardErp, SH = window.CardSheet;
  if (!R || !E || !SH) { console.error('법인카드: card-rules.js · card-erp.js · card-sheet.js 를 drv-card.js 보다 먼저 실어야 합니다'); return {}; }
  var CVIEWS = ['c_month', 'c_verify', 'ca_close', 'ca_list', 'ca_final', 'ca_people'];
  var ADMIN_C = ['ca_close', 'ca_list', 'ca_final', 'ca_people'];
  var LABEL = { category: '구분', purpose: '사용목적', note: '비고' };
  var MAXLEN = { category: 20, purpose: 200, note: 200 };

  /* ══════════════════ 기간 (1일 ~ 말일) ══════════════════
     ★ 2026-10-20 연말 마감 설정: 범위·이름은 엔진(cycle-rules.js 의 'card')이 정한다 — 관리자가 정하지 않으면 늘 달력 한 달(지금과 같다).
       기간 c = {y, m} · 12월 추가 기간은 {y, m:12, x:'b'}(키 '2026-12b'). cSpan·cRange 는 c 하나로도, 예전처럼 (y, m) 두 숫자로도 받는다. */
  var CR = C.CR || window.CycleRules;
  function cArg(y, m) { return y && typeof y === 'object' ? y : { y: +y, m: +m }; }
  function keyOf(c) { return CR.key(c); }
  function parseKey(k) { return CR.parse(k) || { y: NaN, m: NaN }; }
  /** 오늘이 속한 법인카드 기간 — 달력 달(KST, 연말 설정이 있으면 그 범위). */
  function cCurrent() { var P = CR.current('card'); return P.x ? { y: P.y, m: P.m, x: P.x } : { y: P.y, m: P.m }; }
  function cSpan(y, m) { return R.span(keyOf(cArg(y, m))); }
  /** 법인카드 기간의 ms 범위 — KST(hi 는 들어가지 않음). 마감 뒤 며칠 계산에만 쓴다(2026-10-20). 없는 기간이면 NaN. */
  function cRange(y, m) { var P = CR.byKey('card', cArg(y, m)); return P ? { lo: P.loMs, hi: P.endMs } : { lo: NaN, hi: NaN }; }
  function cycName(k) { var c = CR.parse(k); return c ? CR.name(c) : String(k || '') + '분'; }
  function rangeHiMs(k) { return Date.parse(R.cycleRange(k).hi + 'T00:00:00+09:00'); }
  /** 「전월 대비」의 앞 기간 키 — 이름 달의 앞 달('2027-01' → '2026-12'). 12월 추가 기간('2026-12b')은 견주지 않는다(null). */
  function prevMonthKey(k) { var c = CR.parse(k); return !c || c.x ? null : c.m > 1 ? c.y + '-' + pad(c.m - 1) : (c.y - 1) + '-12'; }

  /* ══════════════════ 서버 ══════════════════ */
  function rest(path, opt) {
    return C.apiRetry(path, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
        if (!r.ok) {
          var msg = (j && (j.message || j.error || j.hint)) || ('HTTP ' + r.status);
          var e = new Error(String(msg)); e.status = r.status; throw e;
        }
        return j;
      });
    });
  }
  /** 서버 오류를 사람 말로. 잠금(CARD_LOCKED)은 따로 말한다. */
  function why(e) {
    var m = String((e && e.message) || '');
    if (/CARD_LOCKED/.test(m)) return '결재 중이거나 결재가 끝난 기간이라 고칠 수 없습니다. 고치려면 먼저 회수해 주세요.';
    if (/401|403|jwt|로그인/i.test(m)) return '로그인이 풀렸거나 권한이 없습니다. 다시 로그인해 주세요.';
    if (/23505|duplicate/i.test(m)) return '같은 승인번호·승인일 줄이 이미 있습니다. 목록을 다시 불러와 주세요.';
    if (/23514|check constraint/i.test(m)) return '칸 길이나 금액 범위를 넘었습니다(구분 20자 · 사용목적·비고 200자).';
    console.error('법인카드:', m);
    return '잠시 뒤 다시 해 주세요.';
  }
  function failMsg(head, e, tail) {
    var m = String((e && e.message) || '');
    if (m) console.warn(head, m);
    return /[가-힣]/.test(m) && !/https?:\/\/|HTTP \d/.test(m) ? head + ': ' + m : head + '. ' + tail;
  }

  /* ══════════════════ 자료 ══════════════════ */
  var ITEMS = {};          // 'me|2026-07' · 'all|2026-07' → { rows } | { err } | { wait }
  var CAPPR = null;        // 카드 결재 건 전부(RLS 가 거른 것). 행마다 _kind = 'card'
  var CLOCK = {};          // 'user|cyc' → 서버 잠금(card_cycle_locked)
  var HIST = null, HIST_ASK = null;   // 구분 추천 재료 — 내가 전에 구분을 적은 줄(최근 순)
  var MISSING = {};        // 마지막으로 올린 파일에 없던 줄 id → 1 (이번 화면에서만 표시)
  /** 전액 취소로 확인된 승인인가(2026-10-20 AU2 #5) — 올리기 창에서 「같이 지우기」를 끄고 올린 줄. 줄의 src.cancel 에 남겨
   *  새로 고침해도 표시가 남는다(예전 「파일에 없는 줄」은 그 화면에서만 보였다). 다음에 올린 파일에 그 승인이 다시 있으면 src 가 새로 써져 풀린다. */
  function cancelOf(it) { return !!(it && it.src && typeof it.src === 'object' && it.src.cancel); }
  function me() { return C.myName(); }
  function myFullName() { return C.nameOf(me()); }
  function isAdmin() { var S = C.state(); return !!(S.ME && S.ME.is_admin); }
  function itemKey(all, cyc) { return (all ? 'all' : 'me') + '|' + cyc; }
  function cmpS(a, b) { a = String(a == null ? '' : a); b = String(b == null ? '' : b); return a < b ? -1 : a > b ? 1 : 0; }
  function byDate(a, b) { return cmpS(a.appr_date, b.appr_date) || cmpS(a.appr_time, b.appr_time) || (a.id || 0) - (b.id || 0); }
  function loadItems(cyc, all, force) {
    var k = itemKey(all, cyc);
    if (!force && ITEMS[k] && (ITEMS[k].rows || ITEMS[k].wait)) return ITEMS[k].wait || Promise.resolve(ITEMS[k].rows);
    var p = C.fetchAll('/rest/v1/card_items?select=*&cycle=eq.' + encodeURIComponent(cyc) +
      (all ? '' : '&username=eq.' + encodeURIComponent(me())) + '&order=appr_date.asc,appr_time.asc,id.asc')
      .then(function (rows) { ITEMS[k] = { rows: (rows || []).sort(byDate) }; if (!all) pruneFailed(cyc); return ITEMS[k].rows; })
      .catch(function (e) { ITEMS[k] = { err: (e && e.authGone) ? '로그인이 만료되었습니다.' : (e && e.noPerm) ? '법인카드 내역을 볼 권한이 없습니다.' : '법인카드 내역을 불러오지 못했습니다.' }; return null; });
    ITEMS[k] = { wait: p };
    if (!all) {
      rest('/rest/v1/rpc/card_cycle_locked', { method: 'POST', body: JSON.stringify({ p_username: me(), p_cycle: cyc }) })
        .then(function (v) { CLOCK[me() + '|' + cyc] = v === true; }, function () { });
    }
    return p;
  }
  function loadAppr() {
    return C.fetchAll('/rest/v1/card_approvals?select=*&order=submitted_at.desc,id.desc')     // id 둘째 열쇠 — 나눠 받을 때 겹침·빠짐 없게(2026-10-20)
      .then(function (rows) { CAPPR = (rows || []).map(function (a) { a._kind = 'card'; return a; }); })
      .catch(function () { if (!CAPPR) CAPPR = []; });
  }
  /** 칸에 쓰는 중이면 다시 그리지 않는다(커서가 튄다). */
  function typing() { var a = document.activeElement; return !!(a && a.classList && a.classList.contains('cin')); }
  function loadHist() {
    if (HIST_ASK) return HIST_ASK;
    HIST_ASK = C.fetchAll('/rest/v1/card_items?select=id,merchant,category,appr_date&username=eq.' + encodeURIComponent(me()) +
      '&category=neq.&order=appr_date.desc,id.desc')
      .then(function (rows) { HIST = rows || []; }, function () { HIST = []; })
      .then(function () { HIST_ASK = null; if (C.state().VIEW === 'c_month' && !typing()) C.render(); });
    return HIST_ASK;
  }
  function dropItems(cyc) { delete ITEMS[itemKey(false, cyc)]; delete ITEMS[itemKey(true, cyc)]; }
  /** 운행일지 적재(loadAll)와 같이 돈다 — 결재 건과 지금 기간의 내 카드 내역. */
  function loadWith(soft) {
    var S = C.state();
    if (!S.ME) return null;
    if (!soft) { ITEMS = {}; HIST = null; }
    var ps = [loadAppr(), loadItems(S.CYCKEY, false, !soft)];
    if (isAdmin() && ADMIN_C.indexOf(S.VIEW) >= 0) ps.push(loadItems(S.CYCKEY, true, !soft));
    return Promise.all(ps);
  }
  /** 화면이 쓸 줄들. 아직 없으면 받으러 가고 null(그동안 뼈대) — 받은 뒤 그 화면이면 다시 그린다. */
  function itemsFor(all) {
    var S = C.state(), k = itemKey(all, S.CYCKEY), x = ITEMS[k];
    if (x && x.rows) return x.rows;
    if (x && x.err) return { err: x.err };
    var p = x ? x.wait : loadItems(S.CYCKEY, all);
    if (p && !(x && x.hooked)) {
      if (x) x.hooked = true; else if (ITEMS[k]) ITEMS[k].hooked = true;
      var want = S.CYCKEY;
      p.then(function () { var T = C.state(); if (CVIEWS.indexOf(T.VIEW) >= 0 && T.CYCKEY === want) C.render(); });
    }
    return null;
  }
  function cApprOf(u, cyc) { return (CAPPR || []).filter(function (a) { return a.username === u && a.cycle === cyc; })[0] || null; }
  function myC(cyc) { return cApprOf(me(), cyc || C.state().CYCKEY); }
  function lockedFor(u, cyc) {
    var a = cApprOf(u, cyc);
    if (a && (a.status === 'submitted' || a.status === 'approved')) return true;
    return u === me() && CLOCK[u + '|' + cyc] === true && !(a && (a.status === 'rejected' || a.status === 'withdrawn'));
  }
  function apprById(id) { return (CAPPR || []).filter(function (a) { return String(a.id) === String(id); })[0] || null; }
  function mineRows(cyc) { var x = ITEMS[itemKey(false, cyc)]; return ((x && x.rows) || []).filter(function (it) { return it.username === me(); }); }
  function findMine(id) { return mineRows(C.state().CYCKEY).filter(function (it) { return String(it.id) === String(id); })[0] || null; }
  /** 구분 추천의 「전에 쓴 구분」 — 이번 달에 이미 적은 줄(최근 순) + 지난 줄. */
  function histFor(rows) {
    var seen = {}, out = [];
    rows.filter(function (it) { return String(it.category || '').trim(); }).sort(byDate).reverse().concat(HIST || [])
      .forEach(function (h) { if (!seen[h.id]) { seen[h.id] = 1; out.push(h); } });
    return out;
  }

  /* ══════════════════ 공통 조각 ══════════════════ */
  function stChip(a) {
    if (!a) return '<span class="dim">상신 전</span>';
    var m = { approved: ['결재 완료', 'ok'], submitted: ['결재 중', 'warn'], rejected: ['반려', 'bad'], withdrawn: ['회수', 'dim'] }[a.status] || [a.status, ''];
    return '<span class="st ' + m[1] + '">' + esc(m[0]) + '</span>';
  }
  function fact(k, v, sub, alert) {
    return '<div class="fact"><div class="k">' + esc(k) + '</div><div class="v' + (alert ? ' alert' : '') + '">' + v + '</div>' +
      '<div class="sub">' + esc(sub || '') + '</div></div>';
  }
  function head(title, extra) {
    var S = C.state();
    return C.head(title, esc(cycName(S.CYCKEY)) + ' · <b>' + esc(R.span(S.CYCKEY)) + '</b>' + (extra ? ' · ' + extra : ''));
  }
  function notReady(title, x) {
    if (x && x.err) {
      return C.head(title) + '<section class="sect"><div class="panel" style="padding:34px 24px;text-align:center">' +
        '<div style="font-weight:700;margin-bottom:6px">' + esc(x.err) + '</div><div class="dim" style="margin-bottom:16px">잠시 뒤 다시 시도해 주세요.</div>' +
        '<button class="btn pri" data-creload>다시 불러오기</button></div></section>';
    }
    return C.head(title) + C.skeleton();
  }
  /** 기간 띠 — 지난 기간을 볼 때만. */
  function band() {
    var S = C.state(), cur = cCurrent();
    if (C.cmpCycle(S.CYC, cur) >= 0) return '';
    return '<div class="cycband">' + ic('cal', 15) + '<span>지금 <b>' + esc(cycName(S.CYCKEY)) + ' (' + esc(R.span(S.CYCKEY)) +
      ') · 지난 기간</b>을 보고 있습니다. 법인카드는 <b>1일 ~ 말일</b>이 한 기간입니다.</span>' +
      '<button class="btn sm" data-cyc="' + cur.y + '-' + cur.m + (cur.x || '') + '">이번 기간(' + esc(CR.short(cur)) + ' ' + esc(cSpan(cur)) + ')으로 →</button></div>';
  }
  function tag(key) {
    var a = myC(key);
    if (!a) return '';
    var m = { approved: ['결재 완료', 'ok'], submitted: ['결재 중', 'warn'], rejected: ['반려', 'bad'], withdrawn: ['회수', 'dim'] }[a.status];
    return m ? '<span class="st ' + m[1] + '">' + m[0] + '</span>' : '';
  }
  function sumText(s) {
    if (!s) return '';
    var p = [];
    if (s.block) p.push('빈칸 ' + n0(s.blank_rows || s.block) + '줄');
    if (s.bad) p.push('불일치 ' + n0(s.bad));
    if (s.warn) p.push('확인 ' + n0(s.warn));
    if (s.info) p.push('참고 ' + n0(s.info));
    return p.length ? p.join(' · ') : '이상 없음';
  }
  function sumChip(s) {
    if (!s) return '';
    var p = [];
    if (s.block) p.push('<span class="st bad">빈칸 ' + n0(s.blank_rows || s.block) + '줄</span>');
    if (s.bad) p.push('<span class="st bad">불일치 ' + n0(s.bad) + '</span>');
    if (s.warn) p.push('<span class="st warn">확인 ' + n0(s.warn) + '</span>');
    if (s.info) p.push('<span class="st dim">참고 ' + n0(s.info) + '</span>');
    if (!p.length) p.push('<span class="st ok">이상 없음</span>');
    // 운행일지·개인경비 검증 칩과 같은 모양 — 앞에 「검증」 이름표(2026-10-16 3차)
    return '<span class="vsumc"><span class="vlab">검증</span>' + p.join('') + '</span>';
  }
  /** 구분별 합계 한 줄 — 큰 것부터 넷, 나머지는 「외 N구분 ₩X」(2026-10-15 — 넷만 보여 합계와 안 맞아 보이던 것). */
  function catLine(byCat) {
    var all = Object.keys(byCat || {}).map(function (c) { return { c: c, sum: byCat[c].sum }; }).sort(function (a, b) { return b.sum - a.sum; });
    var t = all.slice(0, 4), rest = all.slice(4);
    return t.length ? t.map(function (x) { return x.c + ' ' + won(x.sum); }).join(' · ') +
      (rest.length ? ' · 외 ' + n0(rest.length) + '구분 ' + won(rest.reduce(function (s, x) { return s + (Number(x.sum) || 0); }, 0)) : '') : '—';
  }
  /** 결재 띠 — 상태 · 진행 · 회수. 이번 달 카드 내역·검증 화면 위에(상신한 본인 화면).
   *  ★ 2026-10-15: 본인 화면에서는 결재자용 요약 표(brief)를 빼고 검증 딱지 · PDF·엑셀 단추만(개인경비와 같게). 결재함 카드는 그대로. */
  function apprStrip(a) {
    var st = C.apprStatusText(a);
    var canWithdraw = a && a.status === 'submitted' && !(a.steps || []).some(function (x) { return x.result; });
    var btn = canWithdraw ? '<button class="btn sm" data-appr="withdraw" data-kind="card" data-id="' + a.id + '">회수</button>' : '';
    if (a && (a.status === 'submitted' || a.status === 'approved')) wantSums([a.id]);
    return '<section class="sect" style="margin:0 0 16px"><div class="astrip">' +
      '<div class="ahd"><span class="akind c">법인카드</span><span class="st ' + st.cls + '">' + esc(st.t) + '</span><span style="flex:1"></span>' + btn + '</div>' +
      (a ? C.apprTrack(a) : '<div class="anote" style="margin-top:0">' + C.apprHint + ' 상신하면 결재함으로 갑니다.</div>') +
      (a && (a.status === 'submitted' || a.status === 'approved') ? extra(a, true) + (C.apvSlot ? C.apvSlot('card', a) : '') : '') +
      (a && a.status === 'submitted' ? '<div class="anote">결재 중에는 이 기간의 카드 내역을 고칠 수 없습니다. ' +
        (canWithdraw ? '고치려면 「회수」한 뒤 다시 상신하세요.' : '첫 결재자가 이미 결재해 회수할 수 없습니다 — 반려를 요청하세요.') + '</div>' : '') +
      // 반려·회수 뒤 — 어디서 다시 상신하는지(운행일지 띠와 같게, 2026-10-16 3차). 검증·상신 화면이 아니면 그리 가는 길도.
      (a && (a.status === 'rejected' || a.status === 'withdrawn') ? '<div class="anote afix">고친 뒤 「검증·상신」에서 다시 상신합니다.' +
        (C.state().VIEW !== 'c_verify' ? ' <button class="btn pri sm" data-v="c_verify">고쳐서 다시 상신 →</button>' : '') + '</div>' : '') +
      '</div></section>';
  }

  /* ══════════════════ 이번 달 카드 내역 ══════════════════ */
  /** 화면 제목 — 지금 기간이면 「이번 달 카드 내역」, 다른 기간을 볼 때는 「카드 내역」(기간은 제목 아래 줄에, 2026-10-15). */
  function monthTitle() { return C.cmpCycle(C.state().CYC, cCurrent()) === 0 ? '이번 달 카드 내역' : '카드 내역'; }
  /** 「추천 구분 채우기 (N)」의 N — 구분이 비었고 추천이 있는 줄(칩을 누르거나 칸을 채울 때마다 다시 센다, 2026-10-15). */
  function sugCount(rows) {
    var hist = histFor(rows);
    return rows.filter(function (it) { return !String(it.category || '').trim() && R.suggest(it, hist); }).length;
  }
  function sugBtnHtml(n) { return '<button class="btn" id="btnCSugAll" data-csugall' + (n ? '' : ' hidden') + '>추천 구분 채우기 (' + n0(n) + ')</button>'; }
  function viewMonth() {
    var S = C.state(), title = monthTitle();
    if (!S.LOADED) return C.head(title) + C.skeleton();
    if (C.isMulti()) return C.singleOnly(title, '법인카드');
    var rows = itemsFor(false);
    if (!rows || rows.err) return notReady(title, rows);
    if (HIST === null && !HIST_ASK) loadHist();
    var cyc = S.CYCKEY, a = myC(cyc), locked = lockedFor(me(), cyc);
    var T = R.totals(rows), hist = histFor(rows);
    var nSug = locked ? 0 : sugCount(rows);
    var h = head(title, 'ERP 에서 받은 내 카드 내역에 구분·사용목적을 적습니다');
    h += apprStrip(a);
    h += cancelBand(rows);                 // 전액 취소된 승인이 남아 있으면(2026-10-20 AU2 #5)
    // ★ 2026-10-15: 「ERP 엑셀 올리기」는 요약 칸의 빨간 단추 하나만(빈 기간에 둘이던 것). 「임시저장」 단추는 뺐다 —
    //   칸은 자동 저장이고, 표 위 저장 상태 줄이 저장 중·저장됨·저장 못 함을 알리며, 저장이 실패했을 때만 그 줄에 「다시 저장」이 나온다.
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (a && a.status === 'approved' ? ' ok' : '') + '"></span>' +
      esc(cycName(S.CYCKEY)) + ' · ' + esc(R.span(S.CYCKEY)) + ' · ' + n0(T.n) + '건</div>' +
      '<p class="verdict">' + won(T.cost) + '</p><div class="facts" id="cFacts">' + factsInner(rows) + '</div>' +
      (locked ? '' : '<div class="vact" style="margin-top:16px"><button class="btn pri" data-cup>' + ic('card', 14) + 'ERP 엑셀 올리기</button>' +
        (rows.length ? sugBtnHtml(nSug) : '') +
        (rows.length ? '<button class="btn" data-v="c_verify">검증·상신으로 ' + ic('chev', 13) + '</button>' : '') + '</div>') + '</div>';
    // 결재 중 안내는 위 결재 띠에 이미 있다 — 여기서는 결재가 끝난 기간만(2026-10-15, 같은 안내 두 번)
    if (locked && a && a.status === 'approved') h += '<div class="hpnote">' + ic('check', 16) + '<span><b>결재가 끝난 기간입니다.</b> 카드 내역을 올리거나 고칠 수 없습니다. ' +
      '고칠 것이 있으면 관리자에게 「정정 열기」를 요청하세요.</span></div>';
    h += C.sect('내역', '<span id="cSectN">' + sectN(rows) + '</span>', '',
      rows.length ? (locked ? '' : saveLineHtml(rows)) + tableHtml(rows, locked, hist)
        : '<div class="panel"><div class="blank"><div class="ico">' + ic('card', 21) + '</div><div class="t">이 기간에 올린 카드 내역이 없습니다.</div>' +
          (locked ? '' : '<div class="d">ERP 에서 내 법인카드 승인내역을 엑셀(.xls · .xlsx)로 받아 위 「ERP 엑셀 올리기」로 올려 주세요. 0원·취소 줄은 자동으로 뺍니다.<br>법인카드를 쓰지 않았으면 할 일이 없습니다.</div>') +
          '</div></div>');
    if (!locked) h += '<div class="anote"><b>구분·사용목적이 빈 줄이 있으면 상신할 수 없습니다.</b> 칸을 고치면 바로 저장됩니다. 구분 칸 아래 점선 단추는 <b>추천</b>입니다 — ' +
      '누르거나 「추천 구분 채우기」로 확정합니다. 같은 파일을 다시 올려도 적어 둔 구분·사용목적·비고는 그대로입니다.</div>';
    return h;
  }
  function tableHtml(rows, locked, hist) {
    // 여러 줄 골라 지우기(2026-10-19) — 순번 칸 안에 고르기 칸. 잠긴 기간이면 막고 까닭을 단다.
    var sel = rows.length > 0 && !!C.mselBox;
    return (sel ? C.mselAllLine('c', 'ctab') : '') + '<div class="panel"><div class="scroll tall cscroll" data-rows><table class="ctab"><thead><tr><th class="n' + (sel ? ' mselth">' + C.mselAll('c') : '">') + '순번</th><th>승인일</th><th>시간</th><th>가맹점</th><th>업종</th>' +
      '<th class="n">승인금액</th><th>구분</th><th>사용목적</th><th>비고</th><th></th></tr></thead><tbody>' +
      rows.map(function (it, i) { return rowHtml(it, i, locked, hist); }).join('') +
      '</tbody><tfoot><tr><td colspan="5">합계 ' + n0(rows.length) + '건</td><td class="n total">' + n0(R.totals(rows).cost) + '</td><td colspan="4"></td></tr></tfoot></table></div></div>' + (sel ? C.mselBar('c') : '');
  }
  function rowHtml(it, i, locked, hist) {
    var sg = !locked && !String(it.category || '').trim() ? R.suggest(it, hist) : null;
    var inp = function (f, ph) {
      var v = String(it[f] == null ? '' : it[f]), need = f !== 'note' && !v.trim();
      return '<input class="inp cin' + (need ? ' need' : '') + (f === 'purpose' ? ' wide' : '') + '" data-cid="' + it.id + '" data-f="' + f + '" maxlength="' + MAXLEN[f] +
        '" value="' + esc(v) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + (locked ? ' disabled' : '') + ' aria-label="' + (i + 1) + '번째 줄 ' + LABEL[f] + '"' +
        // 사용목적 칸 최소 폭 220 → 180(2026-10-15) — PC 폭(1280)에서 맨 끝 「지우기」가 표 밖으로 잘리던 것
        (f === 'purpose' ? ' style="min-width:180px"' : '') + '>';
    };
    return '<tr data-crow="' + it.id + '"' + (MISSING[it.id] ? ' class="cmiss"' : '') + '>' +
      '<td class="n" data-l="순번">' + (C.mselBox ? C.mselBox('c', { id: String(it.id), amt: it.amount,
        line: String(it.appr_date || '').slice(5).replace('-', '.') + ' ' + (it.merchant || '카드') + ' ' + n0(it.amount) + '원',
        why: locked ? '결재 중이거나 결재가 끝난 기간이라 지울 수 없습니다' : '' }) : '') + (i + 1) + '</td>' +
      '<td data-l="승인일">' + esc(String(it.appr_date || '').slice(5).replace('-', '.')) + '</td>' +
      '<td class="dim" data-l="시간">' + esc(String(it.appr_time || '').slice(0, 5)) + '</td>' +
      // 「파일에 없는 줄」 표시는 가맹점 아래 줄에 — 가맹점 옆에 붙이면 칸이 넓어져 맨 끝 「지우기」가 표 밖으로 밀렸다(2026-10-15)
      '<td class="el" data-l="가맹점" title="' + esc(it.merchant || '') + '">' + esc(it.merchant || '—') +
        (cancelOf(it) ? '<div style="margin-top:3px;line-height:1"><span class="st bad" data-ccancel title="' + esc((it.src.cancel.file || 'ERP 파일') + '에서 전액 취소로 확인 — 청구하지 않으려면 이 줄을 지워 주세요') + '">전액 취소된 승인</span></div>'
          : MISSING[it.id] ? '<div style="margin-top:3px;line-height:1"><span class="st warn">파일에 없는 줄</span></div>' : '') + '</td>' +
      '<td class="el dim" data-l="업종">' + esc(it.biz_type || '') + '</td>' +
      '<td class="n total" data-l="승인금액">' + n0(it.amount) + '</td>' +
      // 추천은 칸 아래 점선 단추 하나로만 보인다 — 칸 안 흐린 글씨(placeholder)에 또 쓰지 않는다(2026-10-15)
      '<td data-l="구분">' + inp('category', '예: 중식대') +
        (sg ? '<button type="button" class="csug" data-csug="' + it.id + '" data-cat="' + esc(sg.cat) + '" title="' + esc(sg.why) + ' — 누르면 확정">' + esc(sg.cat) + ' ✓</button>' : '') + '</td>' +
      '<td data-l="사용목적">' + inp('purpose', '무엇에 썼는지') + '</td>' +
      '<td data-l="비고">' + inp('note', '') + '</td>' +
      '<td class="n" data-l=""><span class="csave" id="cs' + it.id + '" aria-live="polite"></span>' +
        (locked ? '' : '<button type="button" class="btn sm" data-cdel="' + it.id + '" aria-label="' + (i + 1) + '번째 줄 지우기">지우기</button>') + '</td></tr>';
  }

  /* ── 칸 저장 — 칸마다 차례로(늦게 온 응답이 새 값을 덮지 않게), 다시 그리지 않는다 ── */
  // SAVE_T: 'id|f' → { t: 타이머, id, f, v, cyc } — 기다리는 칸(쓰는 중). 기간은 넣을 때 굳힌다(그사이 기간을 바꿔도 그 줄로 간다).
  var SAVE_T = {}, CHAIN = {}, SAVING = 0;
  // 저장 상태 줄(2026-10-12): INFL 'id|f' → id(보내는 중) · FAILED 'id|f' → { id, f, v, cyc }(마지막 저장이 실패한 칸과 그때 적은 값 — 「다시 저장」이 다시 보낸다, 2026-10-15)
  //   · LAST_SAVE 마지막으로 저장된 시각(ms)
  var INFL = {}, FAILED = {}, LAST_SAVE = 0;
  function queueSave(el, now) {
    var id = el.dataset.cid, f = el.dataset.f, k = id + '|' + f;
    if (f !== 'note') el.classList.toggle('need', !el.value.trim());
    var w = SAVE_T[k] || { id: id, f: f, cyc: C.state().CYCKEY };
    clearTimeout(w.t);
    w.v = el.value;
    w.t = setTimeout(function () { if (SAVE_T[k] === w) { delete SAVE_T[k]; saveCell(id, f, w.v, w.cyc); } }, now ? 0 : 800);
    SAVE_T[k] = w;
    paintSave();
    if (f === 'category') {
      // 구분을 직접 적으면 그 줄의 추천 칩은 감춘다(지우면 다시 보임) — 적어 둔 값과 다른 추천이 남아 헷갈리던 것(2026-10-15)
      var chip = document.querySelector('[data-csug="' + id + '"]'); if (chip) chip.hidden = !!el.value.trim();
      paintSug();
    }
  }
  /* ── 저장 상태 줄 · 「다시 저장」(실패했을 때만) ── */
  function hhmm(ms) { var d = C.kd(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
  function lastSaveMs(rows) {
    if (LAST_SAVE) return LAST_SAVE;
    var mx = 0;
    (rows || []).forEach(function (it) { var t = Date.parse(it.updated_at || ''); if (isFinite(t) && t > mx) mx = t; });
    return mx;
  }
  function saveLineText(rows) {
    var nf = Object.keys(FAILED).length;
    if (pending()) return '<span class="st warn">저장 중…</span> <span>칸에 적은 값을 보내고 있습니다</span>';
    // 실패한 칸은 서버 값으로 되돌려 둔다 — 그때 적은 값은 FAILED 에 남겨 「다시 저장」으로 다시 보낸다(2026-10-15, 「임시저장」 단추 대신).
    if (nf) return '<span class="st bad">저장 못 함 ' + n0(nf) + '곳</span> <span>적은 값이 되돌려졌습니다 — 「다시 저장」을 누르면 적었던 값을 다시 보냅니다</span>' +
      '<button type="button" class="btn sm" id="btnCRetry" data-cretry>다시 저장</button>';
    var t = lastSaveMs(rows);
    return '<span class="st ok">자동 저장됨</span> <span>' + (t ? '· 마지막 저장 ' + hhmm(t) + ' ' : '') +
      '— 같은 달 ERP 엑셀을 다시 올리면 새 줄만 추가되고, 적어 둔 구분·사용목적은 그대로입니다</span>';
  }
  /** 다시 받은 줄(지금 기간)에 없는 줄의 「저장 못 함」 표시는 지운다(지운 줄·다른 기간으로 옮겨진 줄). */
  function pruneFailed(cyc) {
    if (cyc !== C.state().CYCKEY) return;
    var have = {};
    mineRows(cyc).forEach(function (it) { have[String(it.id)] = 1; });
    Object.keys(FAILED).forEach(function (k) { if (!have[k.split('|')[0]]) delete FAILED[k]; });
    paintSave();
  }
  function saveLineHtml(rows) { return '<div class="csaveline" id="cSaveLine" aria-live="polite">' + saveLineText(rows) + '</div>'; }
  function paintSave() { var el = $('cSaveLine'); if (el) el.innerHTML = saveLineText(mineRows(C.state().CYCKEY)); }
  /** 「다시 저장」 — 저장 못 한 칸에 그때 적었던 값을 다시 넣고 보낸다. 끝나면 알린다(또 실패하면 그 까닭은 칸마다 알림으로). */
  function retrySaves() {
    var list = Object.keys(FAILED).map(function (k) { return FAILED[k]; }).filter(function (x) { return x && x.v != null; });
    if (!list.length) { C.toast('다시 보낼 값이 없습니다 — 빨간 「저장 못 함」 칸을 다시 적어 주세요.', true); paintSave(); return; }
    list.forEach(function (x) {
      var el = document.querySelector('.cin[data-cid="' + x.id + '"][data-f="' + x.f + '"]');
      if (el && el !== document.activeElement) { el.value = x.v; if (x.f !== 'note') el.classList.toggle('need', !String(x.v).trim()); }
      saveCell(x.id, x.f, x.v, x.cyc);
    });
    paintSave();
    settleSaves().then(function () {
      var bad = list.filter(function (x) { return FAILED[x.id + '|' + x.f]; }).length;
      if (bad) C.toast('또 저장하지 못한 칸이 ' + n0(bad) + '곳 있습니다 — 빨간 「저장 못 함」 표시를 확인해 주세요.', true);
      else C.toast('다시 저장했습니다 (' + n0(list.length) + '곳)');
      paintSave();
    });
  }
  /** 기다리는 칸을 지금 보낸다(페이지를 떠날 때 · 상신 직전). */
  function flushSaves() {
    Object.keys(SAVE_T).forEach(function (k) { var w = SAVE_T[k]; clearTimeout(w.t); delete SAVE_T[k]; saveCell(w.id, w.f, w.v, w.cyc); });
  }
  /** 기다리는 칸 · 보내는 중인 칸이 모두 끝날 때까지. */
  function settleSaves() {
    flushSaves();
    var all = Object.keys(CHAIN).map(function (k) { return CHAIN[k]; });
    return Promise.all(all).then(function () { return pending() ? settleSaves() : null; });
  }
  function mark(id, t, bad) { var el = $('cs' + id); if (el) { el.textContent = t; el.classList.toggle('bad', !!bad); } }
  function saveCell(id, f, v, cyc) {
    var k = id + '|' + f;
    cyc = cyc || C.state().CYCKEY;
    CHAIN[k] = (CHAIN[k] || Promise.resolve()).then(function () { return saveNow(id, f, v, cyc); });
    return CHAIN[k];
  }
  /** 실패하면 칸을 서버 값으로 되돌리고 「저장 못 함」 + 까닭. 말없이 버리지 않는다 — 적었던 값(v)은 「다시 저장」용으로 남긴다. */
  function failCell(id, f, prev, msg, v, cyc) {
    mark(id, '저장 못 함', true);
    FAILED[id + '|' + f] = { id: id, f: f, v: v == null ? null : String(v), cyc: cyc || C.state().CYCKEY };
    paintSave();
    var el = document.querySelector('.cin[data-cid="' + id + '"][data-f="' + f + '"]');
    C.toast(msg, true);
    if (SAVE_T[id + '|' + f] || (el && el === document.activeElement)) return;     // 더 새 값이 기다리거나 쓰는 중이면 되돌리지 않는다
    if (el && prev !== undefined) { el.value = prev == null ? '' : prev; if (f !== 'note') el.classList.toggle('need', !el.value.trim()); }
  }
  function rowIn(cyc, id) {
    var x = ITEMS[itemKey(false, cyc)];
    var find = function () { return mineRows(cyc).filter(function (it) { return String(it.id) === String(id); })[0] || null; };
    return x && x.wait && !x.rows ? x.wait.then(find) : Promise.resolve(find());    // 다시 받는 중이면 받은 뒤에 찾는다
  }
  function saveNow(id, f, v, cyc) {
    return rowIn(cyc, id).then(function (it) {
      if (!it) {
        failCell(id, f, undefined, '저장하지 못했습니다 — 그 줄을 찾지 못했습니다(지워졌거나 다른 기간). 목록을 다시 불러온 뒤 적어 주세요.', v, cyc);
        return;
      }
      v = String(v == null ? '' : v).trim().slice(0, MAXLEN[f]);
      var k = id + '|' + f;
      if (String(it[f] == null ? '' : it[f]) === v) { mark(id, ''); delete FAILED[k]; paintSave(); return; }
      var body = {}, prev = it[f];
      body[f] = v;
      it[f] = v; SAVING++; INFL[k] = id; mark(id, '저장 중…'); paintSave();
      // keepalive — 페이지를 닫는 중(pagehide)에 보낸 저장도 끝까지 간다
      return rest('/rest/v1/card_items?id=eq.' + encodeURIComponent(id) + '&select=id,' + f + ',updated_at', {
        method: 'PATCH', keepalive: true, headers: { Prefer: 'return=representation' }, body: JSON.stringify(body)
      }).then(function (out) {
        if (!out || !out.length) throw new Error('저장되지 않았습니다(권한 또는 잠금)');
        it[f] = out[0][f]; it.updated_at = out[0].updated_at;
        delete FAILED[k]; LAST_SAVE = Date.now();
        mark(id, '저장됨');
      }).catch(function (e) {
        it[f] = prev;
        failCell(id, f, prev, failMsg('저장하지 못했습니다', e, why(e)), v, cyc);
      }).then(function () { SAVING--; delete INFL[k]; paintBlank(); paintSave(); });
    });
  }
  // 쓰다가 새로 고침·탭 닫기 — 본체의 묻기는 창(panel)이 열려 있을 때만 모듈을 본다. 칸 저장은 창 밖이라 여기서 따로 묻는다.
  window.addEventListener('beforeunload', function (e) {
    if (pending() || C_SENDING) { flushSaves(); e.preventDefault(); e.returnValue = ''; }
  });
  // 탭을 숨기거나(휴대폰 앱 전환) 떠날 때는 기다리지 않고 바로 보낸다.
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushSaves(); });
  window.addEventListener('pagehide', flushSaves);
  /** 위 숫자 칸(건수·빈칸·많이 쓴 구분 둘) — 칸을 고칠 때마다 다시 그린다(2026-10-15: 예전엔 빈칸 수만 바뀌고 구분 합계는 화면을 옮겨야 바뀌었다). */
  function factsInner(rows) {
    var T = R.totals(rows), blank = R.blankRows(rows);
    var all = Object.keys(T.by_cat).filter(function (k) { return k !== '(빈칸)'; })
      .map(function (k) { return { c: k, n: T.by_cat[k].n, sum: T.by_cat[k].sum }; }).sort(function (x, y) { return y.sum - x.sum; });
    var top = all.slice(0, 2), rest = all.slice(2);
    // 많이 쓴 구분 둘 + 나머지는 「외 N구분」 한 칸(2026-10-15 — 둘만 보여 위 합계와 안 맞아 보이던 것)
    var restSum = rest.reduce(function (s, x) { return s + (Number(x.sum) || 0); }, 0), restN = rest.reduce(function (s, x) { return s + x.n; }, 0);
    return fact('건수', n0(T.n) + '<small>건</small>', 'ERP 에서 올린 승인') +
      fact('빈칸', '<span id="cBlankN">' + n0(blank) + '</span><small>줄</small>', '구분·사용목적 — 채워야 상신', blank > 0) +
      top.map(function (x) { return fact(x.c, won(x.sum), n0(x.n) + '건'); }).join('') +
      (rest.length ? fact('외 ' + n0(rest.length) + '구분', won(restSum), n0(restN) + '건 · ' + rest.map(function (x) { return x.c; }).join(' · ')) : '');
  }
  function sectN(rows) {
    var blank = R.blankRows(rows), nMiss = rows.filter(function (it) { return MISSING[it.id] && !cancelOf(it); }).length, nCan = rows.filter(cancelOf).length;
    return n0(rows.length) + '건' + (blank ? ' · 빈칸 ' + n0(blank) + '줄' : '') + (nCan ? ' · 전액 취소된 승인 ' + n0(nCan) : '') + (nMiss ? ' · 파일에 없는 줄 ' + n0(nMiss) : '');
  }
  /** 전액 취소로 확인된 승인이 아직 남아 있으면 띠 하나(2026-10-20 AU2 #5 — 검증 경고). 고칠 수 없는 기간(결재 중·완료)에는 없다. */
  function cancelBand(rows) {
    var c = (rows || []).filter(cancelOf);
    if (!c.length || lockedFor(me(), C.state().CYCKEY)) return '';
    var amt = c.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0);
    return '<div class="awarn" id="cCancelBand">' + ic('alert', 15) + '<span><b>전액 취소된 승인 ' + n0(c.length) + '건(' + won(amt) + ')이 아직 남아 있습니다.</b> ' +
      'ERP 파일에서 취소로 확인된 결제라 그대로 상신하면 취소된 금액까지 청구됩니다 — 표에서 「전액 취소된 승인」 줄을 지워 주세요.</span></div>';
  }
  function paintBlank() {
    var rows = mineRows(C.state().CYCKEY);
    var f = $('cFacts'); if (f) f.innerHTML = factsInner(rows);
    var sn = $('cSectN'); if (sn) sn.innerHTML = sectN(rows);
    paintSug();
  }
  /** 「추천 구분 채우기 (N)」 숫자를 지금 칸 값으로 다시 센다 — 칩을 누르거나 구분을 적으면 바로 줄고, 0 이면 숨긴다(2026-10-15). */
  function paintSug() {
    var b = $('btnCSugAll'); if (!b) return;
    var rows = mineRows(C.state().CYCKEY), hist = histFor(rows);
    var n = rows.filter(function (it) {
      var el = document.querySelector('.cin[data-cid="' + it.id + '"][data-f="category"]');
      return !String(el ? el.value : (it.category || '')).trim() && R.suggest(it, hist);
    }).length;
    b.textContent = '추천 구분 채우기 (' + n0(n) + ')';
    b.hidden = !n;
  }
  function pending() { return SAVING > 0 || Object.keys(SAVE_T).length > 0; }
  function fillSuggest() {
    var S = C.state(), rows = mineRows(S.CYCKEY), hist = histFor(rows), todo = [];
    if (lockedFor(me(), S.CYCKEY)) return;
    rows.forEach(function (it) {
      if (String(it.category || '').trim() || SAVE_T[it.id + '|category']) return;     // 쓰는 중인 칸은 건드리지 않는다
      var sg = R.suggest(it, hist);
      if (sg) todo.push({ id: String(it.id), cat: sg.cat });
    });
    if (!todo.length) { C.toast('채울 추천이 없습니다.'); return; }
    C.toast('추천 구분 ' + n0(todo.length) + '줄을 채우는 중…');
    var cyc = S.CYCKEY;
    C.vx.pool(todo, 3, function (x) {
      // 화면의 칸도 바로 채운다 — 다른 칸에 쓰는 중이면 다시 그리지 않으므로(커서가 튄다) 칸 값만 바꾼다
      var inp = document.querySelector('.cin[data-cid="' + x.id + '"][data-f="category"]');
      if (inp && inp !== document.activeElement && !inp.value.trim()) { inp.value = x.cat; inp.classList.remove('need'); }
      var chip = document.querySelector('[data-csug="' + x.id + '"]'); if (chip) chip.remove();
      return saveCell(x.id, 'category', x.cat, cyc);
    }).then(function () {
      // ★ 칸 저장은 실패해도 reject 하지 않는다(그 칸에 「저장 못 함」을 단다) — 그래서 끝난 뒤 실패한 칸을 센다(2026-10-20 AU2 #14:
      //   결재 중 잠김 등으로 하나도 안 들어갔는데 「N줄에 추천 구분을 채웠습니다」라고 했다). 실패가 있으면 그 수를 알리고 다시 받는다.
      var bad = todo.filter(function (x) { return FAILED[x.id + '|category']; }).length, ok = todo.length - bad;
      if (!bad) {
        C.toast(n0(todo.length) + '줄에 추천 구분을 채웠습니다. 맞는지 한 번 보세요.');
        if (!typing()) C.render(); else paintSug();
        return;
      }
      C.toast((ok ? n0(ok) + '줄은 채웠지만 ' : '') + n0(bad) + '줄은 저장하지 못했습니다 — 빨간 「저장 못 함」 칸을 확인해 주세요(결재 중이면 회수한 뒤에 채울 수 있습니다).', true);
      dropItems(cyc);
      loadItems(cyc, false, true).then(function () { if (!typing()) C.render(); else { paintSug(); paintSave(); } });
    });
  }
  function openDel(id) {
    var it = findMine(id); if (!it) return;
    C.openPanel('이 줄을 지울까요?', String(it.appr_date) + ' · ' + (it.merchant || '') + ' · ' + n0(it.amount) + '원',
      '<div class="anote" style="margin-top:0">ERP 파일에 다시 들어 있으면 다음에 올릴 때 다시 들어옵니다(그때 구분·사용목적은 새로 적어야 합니다).</div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnCDelGo" data-id="' + esc(String(it.id)) + '">지우기</button>');
  }
  /** 한 줄 지우기 — 한 건 지우기·여러 줄 지우기(C.msel)가 같은 길. */
  function delOne(id) {
    return rest('/rest/v1/card_items?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=representation' } })
      .then(function (rows) {
        if (!rows || !rows.length) throw new Error('지워지지 않았습니다(권한 또는 잠금)');
        delete MISSING[id];
        Object.keys(FAILED).forEach(function (k) { if (k.split('|')[0] === String(id)) delete FAILED[k]; });
      });
  }
  if (C.mselDef) C.mselDef('c', {
    noun: '카드 내역', note: 'ERP 파일에 다시 들어 있으면 다음에 올릴 때 다시 들어옵니다(그때 구분·사용목적은 새로 적어야 합니다).',
    del: function (id) { return findMine(id) ? delOne(id) : Promise.reject(new Error('이미 없는 줄입니다')); },
    why: function (e) { return failMsg('지우지 못했습니다', e, why(e)); },
    done: function () { var S = C.state(); dropItems(S.CYCKEY); loadItems(S.CYCKEY, false, true).then(function () { C.render(); }); }
  });
  function runDel(id) {
    var b = $('btnCDelGo'); if (b) { b.disabled = true; b.textContent = '지우는 중…'; }
    delOne(id)
      .then(function () {
        C.closePanel(); C.toast('지웠습니다.');
        var S = C.state(); dropItems(S.CYCKEY);
        return loadItems(S.CYCKEY, false, true).then(function () { C.render(); });
      }).catch(function (e) {
        if (b && document.contains(b)) { b.disabled = false; b.textContent = '지우기'; }
        C.toast(failMsg('지우지 못했습니다', e, why(e)), true);
      });
  }

  /* ══════════════════ ERP 엑셀 올리기 ══════════════════ */
  var CUP = null, C_SENDING = false, XL_P = null;
  var MAX_BYTES = 5 * 1024 * 1024;        // 읽기 상한 5MB(SPEC) — 줄 수 상한 5,000 은 card-erp.js 가 본다
  /** SheetJS 를 같은 출처(vendor)에서 한 번만 싣는다. */
  function ensureXlsx() {
    if (window.XLSX && window.XLSX.read) return Promise.resolve(window.XLSX);
    if (!XL_P) {
      XL_P = new Promise(function (ok, no) {
        var s = document.createElement('script');
        s.src = new URL('vendor/xlsx.full.min.js', document.baseURI).href;
        s.onload = function () { if (window.XLSX && window.XLSX.read) ok(window.XLSX); else { XL_P = null; no(new Error('XLSX')); } };
        s.onerror = function () { XL_P = null; no(new Error('XLSX')); };
        document.head.appendChild(s);
      });
    }
    return XL_P;
  }
  function openUpload() {
    var S = C.state();
    if (C.isMulti()) { C.toast('카드 내역은 한 기간씩 올립니다. 위에서 기간을 하나 골라 주세요.', true); return; }
    if (lockedFor(me(), S.CYCKEY)) { C.toast('결재 중이거나 끝난 기간이라 올릴 수 없습니다.', true); return; }
    if (C_SENDING) { C.toast('앞서 고른 파일을 아직 올리는 중입니다. 끝난 뒤 다시 열어 주세요.'); return; }
    CUP = { cyc: S.CYCKEY, busy: false, sent: false, res: null, plan: null, file: '', useOwner: true };
    C.openPanel('ERP 엑셀 올리기 — 법인카드', cycName(S.CYCKEY) + ' · ' + R.span(S.CYCKEY),
      '<div class="drop" id="cDrop" style="margin:0 0 14px">' +
      '<div class="dt">ERP 에서 받은 <b>내 법인카드 승인내역</b> 엑셀을 올립니다</div>' +
      '<div class="dd">.xls · .xlsx · PC 에서는 여기에 끌어다 놓아도 됩니다<br>0원·취소 줄과 ' + esc(R.span(S.CYCKEY)) + ' 밖의 줄은 자동으로 뺍니다</div>' +
      '<label class="btn" style="margin-top:14px">파일 고르기<input type="file" id="cFile" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="sr"></label>' +
      '</div><div id="cPrev"></div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnCUpGo" disabled>올리기</button>', true);
    C.bindDrop($('cDrop'), function (fs) { readFile(fs && fs[0]); });
    loadItems(S.CYCKEY, false);            // 다시 올리기 계획에 쓸 지금 줄(이미 있으면 그대로)
    ensureXlsx().catch(function () { });   // 미리 받아 둔다
  }
  function prevMsg(t) { var el = $('cPrev'); if (el) el.innerHTML = '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(t) + '</span></div>'; }
  function replan(s) {
    var cur = mineRows(s.cyc);
    // 뺀 줄(dropped)도 넘긴다 — 이미 올린 승인이 이 파일에서 전액 취소로 확인되면 plan.cancelled 로 따로 묶인다(2026-10-20 AU2 #5)
    s.plan = E.plan(cur, s.res.items.filter(function (it) { return s.useOwner || !it.owner_mismatch; }), s.res.dropped);
  }
  function readFile(f) {
    var s = CUP;
    if (!f || !s || s.busy) return;
    // ★ 5MB 읽기 상한은 여기서(card-erp.js 는 크기를 보지 않는다) — SheetJS 에 넘기기 전에 막아야 큰 파일에서 브라우저가 멈추지 않는다.
    if (f.size > MAX_BYTES) {
      prevMsg('파일이 너무 큽니다(' + (f.size / 1048576).toFixed(1) + 'MB). 5MB 까지 올릴 수 있습니다 — ERP 에서 한 달치만 받아 올려 주세요.');
      return;
    }
    s.busy = true; s.res = null; s.plan = null; s.painted = false;
    var el = $('cPrev'); if (el) el.innerHTML = '<div class="pdfwait"><div class="spin"></div><div role="status">엑셀을 읽는 중…</div></div>';
    var btn = $('btnCUpGo'); if (btn) btn.disabled = true;
    Promise.all([ensureXlsx(), f.arrayBuffer(), loadItems(s.cyc, false)]).then(function (r) {
      if (CUP !== s) return;
      var bytes = new Uint8Array(r[1]);
      if (!E.looksLikeSheet(bytes)) throw new Error('NOT_SHEET');
      var res = E.parse(E.sheetRows(r[0], bytes), { cycle: s.cyc, range: R.cycleRange(s.cyc), me: myFullName(), file: f.name });   // range — 연말 설정 기간(2026-10-20)
      if (!res.ok) { var er = new Error(res.error); er.res = res; throw er; }
      s.res = res; s.file = f.name;
      s.useOwner = !res.owner.all;         // 모든 줄이 남의 카드면 기본으로 빼 둔다(경고만 — 사용자가 고른다)
      s.delCancel = true;                  // 전액 취소로 확인된 이미 올린 승인은 기본으로 「같이 지우기」(2026-10-20 AU2 #5 — 끄면 표시만 남긴다)
      replan(s);
      s.busy = false;                       // ★ 그리기 전에 푼다 — 읽는 중(busy)이면 paintPreview 가 「넣기」를 끈 채로 둔다
      paintPreview();
    }).catch(function (e) {
      if (CUP !== s) return;
      var m = String((e && e.message) || '');
      prevMsg(m === 'NOT_SHEET' ? 'ERP 엑셀 파일(.xls · .xlsx)이 아닙니다. ERP 에서 엑셀로 받은 파일을 올려 주세요.'
        : m === 'NO_HEADER' ? '머리글(법인카드 · 승인일자 · 승인번호 · 가맹점 · 승인금액)을 찾지 못했습니다. 빠진 것: ' + (((e.res && e.res.missing) || []).join(', ') || '없음')
        : m === 'TOO_MANY' ? '줄이 너무 많습니다(' + n0(E.MAX_ROWS) + '줄까지). 한 달치만 받아 올려 주세요.'
        : m === 'XLSX' ? '엑셀 읽기 도구를 불러오지 못했습니다. 새로 고침 뒤 다시 해 주세요.'
        : '파일을 읽지 못했습니다. ERP 에서 다시 받아 올려 주세요.');
      if (!/^(NOT_SHEET|NO_HEADER|TOO_MANY|XLSX)$/.test(m)) console.error('법인카드 엑셀:', e);
    }).then(function () { s.busy = false; });
  }
  function paintPreview() {
    var s = CUP, el = $('cPrev');
    if (!s || !el || !s.res) return;
    var res = s.res, pl = s.plan, nGo = pl.inserts.length + pl.updates.length, erp = res.erp;
    var amt = pl.inserts.concat(pl.updates.map(function (u) { return u.item; })).reduce(function (a, it) { return a + it.amount; }, 0);
    // ★ 돈이 틀릴 수 있는 경고(ERP 합계 다름 · 읽지 못한 줄 · 남의 카드)는 숫자 칸보다 **위**에 — 휴대폰에서 「넣기」만 보고 누르지 않게.
    //   그런 것이 있으면 「넣기」 단추 글자에도 「확인 N건」을 붙인다.
    var h = '', nCheck = 0;
    var erpBad = erp.found && !erp.ok;
    if (erpBad) {
      nCheck++;
      h += '<div class="awarn" id="cErpBad">' + ic('alert', 15) + '<span><b>ERP 합계가 맞지 않습니다.</b> 파일 합계 ' + won(erp.fileTotal) + ' ≠ 승인 ' + won(erp.approved) + ' − 취소 ' + won(erp.cancelled) + ' = ' + won(erp.net) +
        '. 파일이 잘렸거나 읽지 못한 줄이 있을 수 있습니다 — 아래 「뺀 줄」을 확인해 주세요.</span></div>';
    }
    // 읽지 못해 뺀 줄 — 특히 승인번호가 비었거나 너무 긴 「취소」 줄은 원래 승인과 짝을 못 지어 원래 승인이 그대로 들어간다.
    var bad = res.dropped.filter(function (d) { return d.reason === 'invalid'; }), badCancel = bad.filter(function (d) { return d.cancel; });
    if (bad.length) {
      nCheck += bad.length;
      h += '<div class="awarn" id="cBadRows">' + ic('alert', 15) + '<span><b>읽지 못해 뺀 줄 ' + n0(bad.length) + '건</b>(승인일·승인번호·금액).' +
        (badCancel.length ? ' 그 가운데 <b>취소 줄 ' + n0(badCancel.length) + '건</b>은 원래 승인과 짝을 짓지 못해 <b>원래 승인이 그대로 들어갑니다</b>' +
          ' — 취소된 승인이면 올린 뒤 표에서 그 줄을 지워 주세요.' : ' 아래 「뺀 줄」에서 확인해 주세요.') + '</span></div>';
    }
    if (!res.items.length) h += '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(cycName(s.cyc)) + '(' + esc(R.span(s.cyc)) + ') 줄이 없습니다. 다른 달 파일인지 확인해 주세요.</span></div>';
    if (res.owner.mismatch && s.useOwner) nCheck += res.owner.mismatch;
    if (res.owner.mismatch) {
      var names = {};
      res.items.forEach(function (it) { if (it.owner_mismatch) names[it.owner_name] = 1; });
      var who = Object.keys(names).join(', ');
      h += '<div class="awarn">' + ic('alert', 15) + '<span>' + (res.owner.all
        ? '이 파일은 <b>' + esc(who) + '</b> 님 카드 내역으로 보입니다(소유자가 내 이름 ' + esc(myFullName()) + ' 이 아님). 내 카드 내역만 올려 주세요.'
        : '소유자가 내 이름(' + esc(myFullName()) + ')이 아닌 줄이 ' + n0(res.owner.mismatch) + '건 있습니다(' + esc(who) + ').') + '</span></div>' +
        '<label class="finall" style="margin:6px 0 10px"><input type="checkbox" id="cOwn"' + (s.useOwner ? ' checked' : '') + '> 소유자가 다른 줄 ' + n0(res.owner.mismatch) + '건도 올리기' +
        (s.useOwner ? '' : ' <span class="dim">(지금은 빼 둡니다)</span>') + '</label>';
    }
    // 이미 올린 승인 가운데 이 파일에서 전액 취소로 확인된 것(2026-10-20 AU2 #5) — 기본 「같이 지우기」.
    //   끄면 지우지 않고 그 줄에 「전액 취소된 승인」 표시를 남긴다(새로 고침해도 남음 — src.cancel). 돈이 틀리는 경고라 숫자 칸보다 위에.
    var canc = pl.cancelled || [], nDel = s.delCancel ? canc.length : 0;
    var nMark = s.delCancel ? 0 : canc.filter(function (e) { return !cancelOf(e); }).length;
    if (canc.length) {
      var cAmt = canc.reduce(function (a2, e) { return a2 + (Number(e.amount) || 0); }, 0);
      if (!s.delCancel) nCheck += canc.length;
      h += '<div class="awarn" id="cCancelGone">' + ic('alert', 15) + '<span><b>이미 올린 승인 ' + n0(canc.length) + '건(' + won(cAmt) + ')이 이 파일에서 전액 취소로 확인됐습니다.</b> ' +
        '그대로 두면 취소된 결제가 청구됩니다 — ' + esc(canc.slice(0, 5).map(function (e) {
          return String(e.appr_date || '').slice(5).replace('-', '.') + ' ' + (e.merchant || '') + ' ' + n0(e.amount) + '원';
        }).join(', ')) + (canc.length > 5 ? ' 외 ' + n0(canc.length - 5) + '건' : '') + '</span></div>' +
        '<label class="finall" style="margin:6px 0 10px"><input type="checkbox" id="cCancelDel"' + (s.delCancel ? ' checked' : '') + '> 취소된 승인 ' + n0(canc.length) + '건 같이 지우기' +
        (s.delCancel ? '' : ' <span class="dim">(지금은 지우지 않고 「전액 취소된 승인」으로 표시만 합니다)</span>') + '</label>';
    }
    h += '<div class="facts cfacts">' +
      fact('새 줄', n0(pl.inserts.length) + '<small>줄</small>', '처음 들어오는 승인') +
      fact('바뀐 줄', n0(pl.updates.length) + '<small>줄</small>', 'ERP 칸만 고침 — 구분·사용목적은 그대로') +
      fact('그대로', n0(pl.same.length) + '<small>줄</small>', '이미 같은 값') +
      fact('올릴 금액', won(amt), '새 줄 + 바뀐 줄') +
      fact('뺀 줄', n0(res.dropped.length) + '<small>줄</small>', '0원·취소·다른 달 등') + '</div>';
    if (erp.found && erp.ok) h += '<div class="pdfok">' + ic('check', 15) + '<span>ERP 합계 ' + won(erp.fileTotal) + ' = 승인 ' + won(erp.approved) + ' − 취소 ' + won(erp.cancelled) + ' — 맞습니다</span></div>';
    else if (!erp.found) h += '<div class="fhint">파일에 「합계」 줄이 없어 ERP 합계와 맞춰 보지 못했습니다.</div>';
    if (pl.missing.length) h += '<div class="fhint">이 기간에 이미 있는데 <b>파일에 없는 줄 ' + n0(pl.missing.length) + '건</b> — 지우지 않습니다. 올린 뒤 표의 「파일에 없는 줄」 표시를 보고 필요 없으면 지워 주세요.</div>';
    if (res.dropped.length) {
      h += '<section class="sect" style="margin-top:12px"><div class="hd"><h2>뺀 줄</h2><span class="cnt">' + n0(res.dropped.length) + '줄</span></div>' +
        '<div class="panel"><div class="scroll" data-rows><table class="cdrop"><thead><tr><th class="n">엑셀 행</th><th>승인일</th><th>승인번호</th><th>가맹점</th><th class="n">금액</th><th>까닭</th></tr></thead><tbody>' +
        res.dropped.map(function (d) {
          // 무엇을 못 읽었는지(card-erp detail — 「승인일 「26.10.14」」 등, 2026-10-20) · 금액을 못 읽은 줄은 금액 칸 「—」(예전 NaN)
          var inv = d.reason === 'invalid', why = d.label + (d.detail ? ' — ' + d.detail : '') + (inv && d.cancel ? ' — 취소 줄: 원래 승인은 남음' : '');
          return '<tr' + (inv ? ' class="cbad"' : '') + ' data-dreason="' + esc(d.reason) + '"><td class="n">' + d.row + '</td><td>' + esc(d.appr_date || '—') + '</td><td>' + esc(d.appr_no || '(없음)') + '</td>' +
            '<td class="el">' + esc(d.merchant) + '</td><td class="n">' + (d.cancel ? '−' : '') + n0(d.amount) + '</td><td>' + (inv ? '<span class="st bad">' + esc(why) + '</span>' : esc(why)) + '</td></tr>';
        }).join('') + '</tbody></table></div></div></section>';
    }
    el.innerHTML = h;
    var b = $('btnCUpGo');
    if (b) {
      var nAct = nGo + nDel + nMark;      // 올릴 줄 + 같이 지울 취소 줄 + 표시만 남길 취소 줄(2026-10-20)
      b.disabled = !nAct || s.busy;
      // 개인경비 「N건 올리기」와 같은 이름(2026-10-15 — 예전 「넣기 (새 5 · 바뀜 0)」). 새·바뀐 줄 수는 위 숫자 칸에 있다.
      b.textContent = !nAct ? '올릴 줄이 없습니다' : [nGo ? n0(nGo) + '건 올리기' : '', nDel ? '취소 ' + n0(nDel) + '건 지우기' : '', nMark ? '취소 ' + n0(nMark) + '건 표시' : '']
        .filter(Boolean).join(' · ') + (nCheck ? ' · 확인 ' + n0(nCheck) + '건' : '');
      b.title = nCheck ? '위의 경고를 확인한 뒤 올려 주세요' : '';
    }
    // 경고가 있으면 창 안을 미리보기 머리까지 내려 둔다(올리기 칸 아래에 묻히지 않게) — 뒤 화면은 건드리지 않는다
    var pb = $('pBody');
    var firstPaint = !s.painted; s.painted = true;      // 새 파일의 첫 그림에서만 — 체크박스 등으로 다시 그릴 때는 자리를 지킨다
    if (pb && firstPaint && (erpBad || bad.length || canc.length)) pb.scrollTop += Math.max(0, el.getBoundingClientRect().top - pb.getBoundingClientRect().top - 8);
  }
  function runUpload() {
    var s = CUP;
    if (!s || !s.plan || s.busy) return;
    var list = s.plan.inserts.concat(s.plan.updates.map(function (u) { return u.item; }));
    // 전액 취소로 확인된 이미 올린 승인(2026-10-20 AU2 #5) — 「같이 지우기」면 지우고, 끄면 src.cancel 표시만 남긴다(아직 표시 안 된 줄만)
    var canc = s.plan.cancelled || [];
    var toDel = s.delCancel ? canc : [], toMark = s.delCancel ? [] : canc.filter(function (e) { return !cancelOf(e); });
    if (!list.length && !toDel.length && !toMark.length) { C.closePanel(); return; }
    s.busy = true; C_SENDING = true;
    var b = $('btnCUpGo'); if (b) { b.disabled = true; b.textContent = '올리는 중…'; }
    var at = new Date().toISOString(), u = me(), done = 0, nDel = 0, nMark = 0, delFail = [];
    var payload = list.map(function (it) { return E.toRow(it, u, { file: s.file, at: at }); });   // ★ 손 칸은 보내지 않는다
    var chunks = [];
    for (var i = 0; i < payload.length; i += 200) chunks.push(payload.slice(i, i + 200));
    chunks.reduce(function (p, ch) {
      return p.then(function () {
        return rest('/rest/v1/card_items?on_conflict=username,appr_no,appr_date', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(ch)
        }).then(function () { done += ch.length; });
      });
    }, Promise.resolve()).then(function () {
      // 올린 뒤 취소된 승인 — 한 줄씩(실패해도 나머지는 계속, 몇 줄이 왜 남았는지 알린다)
      return toDel.reduce(function (p, e) {
        return p.then(function () { return delOne(String(e.id)).then(function () { nDel++; }, function (er) { delFail.push(failMsg('지우지 못했습니다', er, why(er))); }); });
      }, Promise.resolve()).then(function () {
        return toMark.reduce(function (p, e) {
          var src = {}; Object.keys(e.src && typeof e.src === 'object' ? e.src : {}).forEach(function (k) { src[k] = e.src[k]; });
          src.cancel = { file: String(s.file || '').slice(0, 120), at: at };
          return p.then(function () {
            return rest('/rest/v1/card_items?id=eq.' + encodeURIComponent(e.id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ src: src }) })
              .then(function () { nMark++; }, function (er) { console.warn('취소 표시를 남기지 못했습니다:', (er && er.message) || er); });
          });
        }, Promise.resolve());
      });
    }).then(function () {
      s.sent = true;
      MISSING = {};
      s.plan.missing.forEach(function (e) { MISSING[e.id] = 1; });
      C.closePanel();
      var msg = '올렸습니다 — 새 ' + n0(s.plan.inserts.length) + '줄 · 바뀜 ' + n0(s.plan.updates.length) + '줄' +
        (nDel ? ' · 전액 취소된 승인 ' + n0(nDel) + '줄을 지웠습니다' : '') +
        (toMark.length ? ' · 전액 취소된 승인 ' + n0(nMark) + '줄은 표에 「전액 취소된 승인」으로 표시했습니다' : '') +
        (s.plan.missing.length ? ' · 파일에 없는 줄 ' + n0(s.plan.missing.length) + '줄은 표에 표시했습니다' : '');
      if (delFail.length) C.toast(msg + ' — 취소된 승인 ' + n0(delFail.length) + '줄은 지우지 못했습니다: ' + delFail[0], true);
      else C.toast(msg);
    }).catch(function (e) {
      C.toast(failMsg('올리지 못했습니다', e, why(e)) + (done ? ' (' + n0(done) + '줄은 들어갔습니다)' : ''), true);
      if (b && document.contains(b)) { b.disabled = false; b.textContent = '다시 올리기'; }
    }).then(function () {
      s.busy = false; C_SENDING = false;
      dropItems(s.cyc);
      return loadItems(s.cyc, false, true);
    // ★ 창을 닫아도 #cDrop 은 숨은 창 안에 남는다 — 「창이 열려 있고 올리기 창인가」로 본다(닫혔으면 표를 다시 그린다)
    }).then(function () { if (!($('cDrop') && $('panel').classList.contains('open'))) C.render(); });
  }

  /* ══════════════════ 검증 · 상신 ══════════════════
     운행일지·개인경비와 같은 세 칸: ① 검증하기 → ② PDF 미리보기(열어 봐야 확인) → ③ 결재 상신.
     검증은 브라우저에서 card-rules.js 로(서버와 같은 판정). 구분·사용목적이 빈 줄이 있으면 ③ 이 꺼지고 그 줄로 가는 단추. */
  var VR = {}, VITEMS = [];
  /** 이번에 검증 화면에 들어와서 검증을 돌렸는가(키별) — 화면에 들어올 때마다 비운다(onGo). 운행일지·개인경비처럼 들어올 때마다 ① 검증하기부터
   *  (2026-10-20 V3 U9 — 법인카드만 다른 화면에 다녀와도 ③ 부터였다). 지난 결과는 아래에 그대로 보인다. */
  var CFRESH = {};
  var PREV = (function () { try { return JSON.parse(sessionStorage.getItem('drv.cpreviewed') || '{}'); } catch (e) { return {}; } })();
  function vkey(u, cyc) { return u + '|' + cyc; }
  function sig(u, cyc) {
    var rows = ((ITEMS[itemKey(false, cyc)] || {}).rows) || [], h = 0, cnt = 0;
    var add = function (v) { var s = String(v == null ? '' : v); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; };
    rows.forEach(function (it) {
      if (it.username !== u) return;
      cnt++;
      add(it.id); add(it.amount); add(it.appr_date); add(it.appr_no); add(it.merchant); add(it.owner_name); add(it.category); add(it.purpose); add(it.note);
    });
    return cnt + ':' + h;
  }
  function previewOk(k) {
    var v = PREV[k]; if (!v) return false;
    var p = k.split('|'); if (v.sig !== sig(p[0], p[1])) return false;
    var a = cApprOf(p[0], p[1]);
    return !(a && a.submitted_at && Date.parse(a.submitted_at) > v.at);
  }
  function setPreviewed(k, on) {
    var p = k.split('|');
    if (on) PREV[k] = { at: Date.now(), sig: sig(p[0], p[1]) }; else delete PREV[k];
    try { sessionStorage.setItem('drv.cpreviewed', JSON.stringify(PREV)); } catch (e) { }
  }
  /* ── AI 검증(2026-10-12, SPEC §3-1) — expense-ai op card_review: 서버가 card_items 를 직접 읽어 규칙(C01~C09) + Gemini(C07·C08).
     같은 자료면 서버가 보관해 둔 Gemini 결과를 쓴다. 서버·Gemini 를 못 쓰면 브라우저 규칙만 + 「AI 검증을 하지 못했습니다(규칙 검증만)」. */
  var VRUN = { busy: false, note: '', k: '', t0: 0 }, VTICK = null, EXP = {};
  var AI_FAIL = 'AI 검증을 하지 못했습니다(규칙 검증만)';
  function cai(body) {
    return C.apiRetry('/functions/v1/expense-ai', { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j || j.error) { var e = new Error((j && j.error) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
          return j;
        });
      });
  }
  /** C09 재료(화면) — 내 개인경비 줄 중 이 달(KST)에 결제한 것. 못 받으면 null(C09 를 화면에서 건너뜀 — 서버는 따로 본다). */
  function loadExp(cyc) {
    var rg = R.expenseRangeMs(cyc);
    return C.fetchAll('/rest/v1/expense_items?select=id,date_millis,amount,category,merchant&username=eq.' + encodeURIComponent(me()) +
      '&date_millis=gte.' + rg.lo + '&date_millis=lt.' + rg.hi + '&order=id.asc')
      .then(function (rows) { EXP[cyc] = rows || []; return EXP[cyc]; }, function () { return EXP[cyc] || null; });
  }
  function localVerify(cyc, aiData) {
    return R.runVerify(mineRows(cyc), { cycle: cyc, submitterName: myFullName(), expenses: EXP[cyc] || null, ai: aiData || null });
  }
  function sayRun(t) {
    VRUN.note = t;
    var M = C.vx.aiMotion, mk = 'c:' + VRUN.k;
    if (M) M.step(mk, { phase: 'run' });
    var v = document.querySelector('.hero .verdict .cvnote'); if (v) v.textContent = t;
    var gl = document.querySelector('[data-cvrun] .gl'); if (gl) gl.textContent = (M && M.short(mk)) || t;   // 단추에는 짧게(2026-10-20)
  }
  /** AI 검증 모션 재료(2026-10-20) — 이번 달 카드 줄(날짜·가맹점·금액, 여섯 줄). 사진이 없으니 종이(카드 내역) 그림. */
  function cMotion(cyc) {
    var rows = mineRows(cyc).slice().sort(byDate);
    return { title: 'AI가 카드 내역을 읽고 있습니다', cols: ['날짜', '가맹점', '금액(원)', '맞춰 보기'], N: 0, paper: 'sheet', more: Math.max(0, rows.length - 6),
      rows: rows.slice(0, 6).map(function (it) { return { id: it.id, date: String(it.appr_date || '').slice(5).replace('-', '.'), place: it.merchant || '—', amt: n0(it.amount) }; }),
      photos: [] };
  }
  function runCheck() {
    var S = C.state(), u = me(), cyc = S.CYCKEY, k = vkey(u, cyc), mk = 'c:' + k, M = C.vx.aiMotion;
    if (VRUN.busy) return;
    if (pending()) { C.toast('칸을 저장하는 중입니다. 잠시 뒤 다시 눌러 주세요.'); return; }
    var n = mineRows(cyc).length, s0 = sig(u, cyc);
    VRUN = { busy: true, note: '규칙을 살피는 중…', k: k, t0: Date.now() };
    if (M) { M.begin(mk, cMotion(cyc)); M.step(mk, { phase: 'run' }); }
    C.render();
    loadExp(cyc).then(function () {
      // 지난 초는 AI 판(「N초 지남」)이 센다 — 진행 글에 따로 세면 시계가 둘이고 1초 어긋났다(2026-10-20 V3 다듬기). 판이 없을 때만 글에 초를
      var tick = function () { if (VRUN.busy && VRUN.k === k) sayRun('카드 ' + n0(n) + '줄을 읽는 중…' + (M && M.on(mk) ? '' : ' ' + Math.round((Date.now() - VRUN.t0) / 1000) + '초')); };
      tick(); clearInterval(VTICK); VTICK = setInterval(tick, 1000);
      return cai({ op: 'card_review', cycle: cyc }).then(function (j) { return { j: j }; }, function (e) { return { e: e }; });
    }).then(function (x) {
      clearInterval(VTICK); VTICK = null;
      var res, ai, row = x.j && x.j.row;
      if (row && row.summary && row.result && Array.isArray(row.result.items)) {
        var a = x.j.ai || {};
        res = { summary: row.summary, items: row.result.items };
        ai = { status: a.status || row.result.ai_status || 'none', note: a.note || row.result.ai_note || '', model: a.model || '', data: row.result.ai || null,
          exNote: x.j.ex_note || row.result.ex_note || '' };
      } else {
        if (x.e) console.warn('법인카드 AI 검증:', String((x.e && x.e.message) || x.e));
        res = localVerify(cyc, null);
        ai = { status: 'failed', note: AI_FAIL, model: '', data: null };
      }
      VR[k] = { at: Date.now(), sig: s0, res: res, ai: ai };
      CFRESH[k] = 1;                               // 이번에 들어와서 검증했다(V3 U9)
      setPreviewed(k, false);
      C.toast('검증했습니다 — ' + sumText(res.summary) + (ai.note ? ' · ' + ai.note : '') + (ai.exNote ? ' · ' + ai.exNote : ''));
      // 응답이 왔다 — 실제 결과(항목이 가리키는 줄)로 카드 줄마다 딱지(80ms 간격) 뒤 결과 화면
      if (M) return M.finish(mk, M.chipsFrom(res.items || [], 'items', function (it) {
        return it.level === 'block' ? ['빈칸', 'bad', 4] : it.level === 'bad' ? ['불일치', 'bad', 3] : it.level === 'warn' ? ['확인 필요', 'warn', 2] : null;
      }));
    }).catch(function (e) { C.toast(failMsg('검증하지 못했습니다', e, '잠시 뒤 다시 눌러 주세요.'), true); })
      .then(function () { clearInterval(VTICK); VTICK = null; VRUN = { busy: false, note: '', k: '', t0: 0 }; if (M) M.end(mk); C.render(); });
  }
  /** AI 상태 → [값, 설명]. */
  function aiFact(ai, nRows) {
    if (!ai) return ['—', '검증 전'];
    if (ai.status === 'ok') return ['완료', 'Gemini 가 ' + n0(nRows) + '줄의 구분·사용목적을 봤습니다'];
    if (ai.status === 'cached') return ['완료', '같은 자료로 본 Gemini 결과를 다시 썼습니다'];
    if (ai.status === 'none') return ['—', '카드 내역이 없습니다'];
    return ['규칙만', ai.note || AI_FAIL];
  }
  var LV = { block: ['빈칸', 'bad'], bad: ['불일치', 'bad'], warn: ['확인 필요', 'warn'], info: ['참고', ''] };
  function itemsHtml(items, links) {
    if (!items || !items.length) return '<div class="panel"><div class="blank"><div class="ico">' + ic('check', 21) + '</div><div class="t">확인이 필요한 항목이 없습니다.</div></div></div>';
    return '<div class="panel vlist">' + items.map(function (it) {
      var lv = LV[it.level] || LV.info, ref = (it.ref && it.ref.items) || [], go = '';
      if (links && ref.length && it.level !== 'info') { VITEMS.push(it); go = '<button class="btn sm vgo vfix" data-cvfix="' + (VITEMS.length - 1) + '">바로 고치기' + ic('chev', 12) + '</button>'; }
      return '<div class="vitem v-' + esc(it.level === 'block' ? 'bad' : it.level) + (it.ai ? ' v-ai' : '') + '" data-ccode="' + esc(it.code || '') + '"><span class="st ' + lv[1] + '">' + lv[0] + '</span>' +
        '<div class="vb"><div class="vt">' + esc(it.title) + (it.ai ? ' ' + C.vx.gemBadge() : '') + '</div><div class="vd">' + esc(it.detail || '') + '</div></div>' + go + '</div>';
    }).join('') + '</div>';
  }
  /** 그 줄로 가서 빈 칸(없으면 첫 칸)에 커서를 둔다. */
  function focusRow(id) {
    if (C.state().VIEW !== 'c_month') C.go('c_month');
    setTimeout(function () {
      var tr = document.querySelector('tr[data-crow="' + id + '"]');
      if (!tr) return;
      var el = tr.querySelector('.cin.need') || tr.querySelector('.cin');
      try { tr.scrollIntoView({ block: 'center' }); } catch (e) { }
      tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash');
      if (el && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (e) { } }
    }, 80);
  }
  function firstBlankId() {
    var r = mineRows(C.state().CYCKEY).slice().sort(byDate).filter(function (it) { return !String(it.category || '').trim() || !String(it.purpose || '').trim(); })[0];
    return r ? r.id : null;
  }
  function viewVerify() {
    var S = C.state();
    if (!S.LOADED) return C.head('검증·상신') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('검증·상신', '법인카드 검증');
    var rows = itemsFor(false);
    if (!rows || rows.err) return notReady('검증·상신', rows);
    var u = me(), cyc = S.CYCKEY, k = vkey(u, cyc), a = myC(cyc);
    var locked = !!(a && (a.status === 'submitted' || a.status === 'approved'));
    if (locked) return lockedVerify(rows, a);
    // dataFresh = 지난 검증 뒤 자료가 그대로 · fresh = 그리고 이번에 들어와서 검증했다(단계는 fresh 로 — 들어올 때마다 ① 부터, V3 U9. 지난 결과 글·목록은 dataFresh 로)
    var v = VR[k], dataFresh = !!(v && v.sig === sig(u, cyc)), fresh = dataFresh && !!CFRESH[k], s = v ? v.res.summary : {}, items = v ? v.res.items : [];
    var seen = previewOk(k), blocked = !!(v && fresh && s.block);
    var busy = VRUN.busy && VRUN.k === k;
    // 도는 동안은 ① 도는 중 · ②③ 아직(2026-10-20 V3 B2). 빈 칸이 있으면 지금 할 일은 ③ 「빈 칸으로 가기」(V3 B5 — ② PDF 가 깜빡이고 ③ 이 회색이었다)
    var stage = locked ? 0 : busy || !v || !fresh ? 1 : blocked ? 3 : !seen ? 2 : 3;
    var canSubmit = !a || a.status === 'rejected' || a.status === 'withdrawn';
    VITEMS = [];
    var verdict, clean = '';
    if (busy) verdict = '<span class="gemrun">' + C.vx.gemBadge('Gemini') + '</span><span class="cvnote">' + esc(VRUN.note || '검증하는 중…') + '</span>';
    else if (!v) verdict = '아직 검증하지 않았습니다';
    else if (!dataFresh) verdict = '자료가 바뀌었습니다 — 다시 검증해 주세요';
    else if (s.block) verdict = '빈 칸이 있는 줄이 <em>' + n0(s.blank_rows) + '줄</em> — 채워야 상신할 수 있습니다';
    else if (s.bad) verdict = '맞지 않는 곳이 <em>' + n0(s.bad) + '건</em> 있습니다';
    else if (s.warn) { verdict = '확인할 것이 <em>' + n0(s.warn) + '건</em> 있습니다'; clean = ' wait'; }
    else { verdict = '<em>이상 없습니다</em>'; clean = ' clean'; }
    // 2026-10-20 디자인 v2: 세 시스템 같은 단계 카드(C.vx.stepCard — 지금 할 단계 단추가 깜빡임, 도는 동안 진행 막대)
    // st — 빈 칸이 있어 ③ 이 지금일 때 ② 는 「끝」이 아니라 「아직」(누를 수는 있다 — 흰 바탕 단추, V3 B5)
    var card = function (n, title, desc, button, st) { return C.vx.stepCard(n, stage, title, desc, button, { busy: busy && n === 1, st: st }); };
    var mk = 'c:' + k, AM = C.vx.aiMotion;
    var none = !rows.length;
    var steps = locked ? '' : '<ol class="vsteps" aria-label="상신 순서">' +
      card(1, '검증하기 ' + C.vx.gemBadge('Gemini'), none ? '먼저 「이번 달 카드 내역」에서 ERP 엑셀을 올려 주세요.'
        : busy ? '규칙으로 살피고, Gemini 가 구분·사용목적을 읽는 중입니다…'
        : v && fresh ? '지금 자료로 검증했습니다. 고친 게 있으면 다시 눌러 주세요.'
        : v && dataFresh ? '먼저 지금 자료로 검증해 주세요. 아래는 지난 검증(' + esc(C.vx.whenText(new Date(v.at).toISOString())) + ') 결과입니다.'
        : '빈칸·같은 승인번호·기간 밖·소유자·0원 줄과 같은 날 같은 금액의 개인경비를 규칙으로 보고, Gemini 가 구분이 가맹점·시간과 맞는지와 사용목적을 봅니다.',
        C.vx.gemBtn('data-cvrun' + (busy || none ? ' disabled' : ''), busy ? ((AM && AM.short(mk)) || VRUN.note || 'Gemini 가 읽는 중…') : v && fresh ? '다시 검증하기' : '검증하기',
          busy, ' big' + (stage === 1 && !none ? ' pri' + (busy ? '' : ' cta') : ''))) +
      card(2, 'PDF 미리보기', v && fresh ? '결재자에게 갈 지출결의서(가로 A4)를 눈으로 확인합니다.' : '① 검증하기를 먼저 해 주세요.',
        '<button class="btn big' + (stage === 2 ? ' pri cta' : '') + '" data-cpdf=""' + (v && fresh && !busy ? '' : ' disabled') + '>' + ic('dl', 16) + 'PDF 미리보기</button>',
        blocked && !seen ? 'todo' : undefined) +
      card(3, '상신', !canSubmit ? '이미 상신했습니다.' : blocked ? '구분·사용목적이 빈 줄이 있습니다 — 「빈 칸으로 가기」로 채운 뒤 ① 다시 검증하면 상신할 수 있습니다.' : stage === 3 ? '결재선을 고르고 올립니다.' : 'PDF 미리보기를 먼저 확인해 주세요.',
        // 빈 칸이 있으면 지금 누를 단추는 「빈 칸으로 가기」(빨강·깜빡임) — 상신 단추는 그 아래 회색(못 누름)
        (blocked ? '<button class="btn big pri cta" data-cgoblank>' + ic('chev', 14) + '빈 칸으로 가기</button>' : '') +
        (canSubmit ? '<button class="btn big' + (stage === 3 && !blocked ? ' pri cta' : '') + '" id="btnOpenSubmit" data-kind="card"' + (stage === 3 && !blocked && !busy ? '' : ' disabled') + '>' +
          (a && (a.status === 'rejected' || a.status === 'withdrawn') ? '다시 상신' : '상신') + '</button>' : '')) + '</ol>';
    var h = head('검증·상신', '순서대로 눌러 주세요 — 깜빡이는 단추가 지금 할 일입니다');
    h += apprStrip(a);
    h += cancelBand(rows);                 // 전액 취소된 승인이 남아 있으면 — 상신 전에 한 번 더(2026-10-20 AU2 #5 검증 경고)
    var af = aiFact(v && v.ai, rows.length);
    // 단계 카드는 제목 바로 아래(P_Verifying) — 그 아래 결과 자리. 검증이 도는 동안은 결과 자리에 AI 검증 모션(응답 뒤 실제 결과로 딱지)
    var moving = busy && AM && AM.on(mk);
    h += steps;
    if (moving) h += AM.html(mk, verdict);
    else h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (v && dataFresh && !s.block && !s.bad ? ' ok' : '') + '"></span>' +
      (v ? '마지막 검증 ' + esc(C.vx.whenText(new Date(v.at).toISOString())) : '검증 전') + ' · 카드 ' + n0(rows.length) + '건 ' + won(R.totals(rows).cost) + '</div>' +
      '<p class="verdict' + (busy ? '' : clean) + '">' + verdict + '</p>' +
      (v && !busy ? '<div class="facts">' + fact('빈칸', n0(s.blank_rows) + '<small>줄</small>', '구분·사용목적 — 상신을 막음', s.block > 0) +
        fact('불일치', n0(s.bad), '같은 승인번호가 두 번', s.bad > 0) + fact('확인 필요', n0(s.warn), '기간 밖 · 소유자 · 구분·사용목적 · 개인경비 중복') + fact('참고', n0(s.info), '0원 줄') +
        '<div class="fact" id="cAiFact"><div class="k">AI 확인 ' + C.vx.gemBadge() + '</div><div class="v">' + esc(af[0]) + '</div><div class="sub">' + esc(af[1]) + '</div></div></div>' +
        (v.ai && v.ai.note ? '<div class="awarn" id="cAiNote" style="margin-top:12px">' + ic('alert', 15) + '<span>' + esc(v.ai.note) + '</span></div>' : '') +
        (v.ai && v.ai.exNote ? '<div class="awarn" id="cExNote" style="margin-top:12px">' + ic('alert', 15) + '<span>' + esc(v.ai.exNote) + '</span></div>' : '') : '') +
      '</div>';
    if (v && dataFresh && !busy) {                // 지난 검증 결과도 보인다(자료가 그대로일 때) — 다시 들어와 ① 부터여도(V3 U9)
      var need = items.filter(function (i) { return i.level !== 'info'; }), info = items.filter(function (i) { return i.level === 'info'; });
      h += C.sect('봐야 할 것', need.length ? need.length + '건' : null, '', itemsHtml(need, true));
      if (info.length) h += C.sect('참고', info.length + '건', '', itemsHtml(info));
    } else if (!none && !busy) {
      h += '<div class="panel"><div class="blank"><div class="ico">' + ic('check', 21) + '</div><div class="t">위 ① 「검증하기」를 누르면 이번 달 카드 내역을 살펴봅니다.</div>' +
        '<div class="d">구분·사용목적이 빈 줄만 상신을 막습니다. 나머지(같은 승인번호·기간 밖·소유자·0원·구분과 내역·사용목적·개인경비 중복)는 결재자가 같이 봅니다.</div></div></div>';
    }
    h += '<div class="anote">금액은 ERP 승인금액 그대로이고 바꾸지 않습니다. ' + C.vx.gemBadge('Gemini') + ' 는 <b>구분이 가맹점·시간과 맞지 않아 보이는 줄과 성의 없는 사용목적을 표시</b>만 하고 값을 고치거나 상신을 막지 않습니다(카드번호·이름은 보내지 않습니다).</div>';
    return h;
  }
  /** 결재 중·결재 완료 기간의 검증·상신 화면(2026-10-15 화면 정리, 개인경비 lockedVerify 와 같은 모양) — 다시 검증하지 않는다.
   *  상신 때 굳힌 검증 결과(card_frozen.verify)만 보이고, 문서는 위 결재 띠의 PDF·엑셀 단추로 본다
   *  (예전: 「아직 검증하지 않았습니다」·없는 ① 단추 안내·띠와 같은 문서의 「결재 문서 PDF」 단추가 또 하나). */
  function lockedVerify(rows, a) {
    var h = head('검증·상신', a.status === 'approved' ? '결재가 끝난 기간입니다' : '결재 중인 기간입니다');
    h += apprStrip(a);
    var f = FZSUM[fzKey(a)], v = f && f.verify, s = (v && v.summary) || {}, items = (v && v.items) || [];
    var verdict, clean = '';
    if (f === undefined) verdict = FZFAIL[fzKey(a)] ? '상신 때 검증 결과를 불러오지 못했습니다 — 잠시 뒤 다시 열어 주세요' : '상신 때 검증 결과를 불러오는 중…';
    else if (!v) verdict = '상신 때 검증 결과가 없습니다';
    else if (s.block) verdict = '빈 칸이 있는 줄이 <em>' + n0(s.blank_rows || s.block) + '줄</em> 있었습니다';
    else if (s.bad) verdict = '맞지 않는 곳이 <em>' + n0(s.bad) + '건</em> 있었습니다';
    else if (s.warn) { verdict = '확인할 것이 <em>' + n0(s.warn) + '건</em> 있었습니다'; clean = ' wait'; }
    else { verdict = '<em>이상 없었습니다</em>'; clean = ' clean'; }
    var at = v && (v.ran_at || (f && f.frozen_at));
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (v && !s.block && !s.bad ? ' ok' : '') + '"></span>' +
      '상신 때 검증 결과' + (at ? ' · ' + esc(C.vx.whenText(at)) : '') + ' · 카드 ' + n0(rows.length) + '건 ' + won(R.totals(rows).cost) + '</div>' +
      '<p class="verdict' + clean + '">' + verdict + '</p></div>';
    if (v) {
      var need = items.filter(function (i) { return i.level !== 'info'; }), info = items.filter(function (i) { return i.level === 'info'; });
      VITEMS = [];
      h += C.sect('봐야 할 것', need.length ? need.length + '건' : null, '', itemsHtml(need, false));
      if (info.length) h += C.sect('참고', info.length + '건', '', itemsHtml(info));
    }
    h += '<div class="anote">' + (a.status === 'approved' ? '결재가 끝난 기간이라' : '결재 중인 기간이라') + ' 다시 검증하지 않습니다. 결재 문서는 위 결재 띠의 PDF 단추로 봅니다.</div>';
    return h;
  }
  /** 상신 창이 「상신」을 누른 직후 — 미리보기 뒤 자료가 바뀌었거나 빈 칸이 있으면 멈추고({blocked}), 아니면 요약을 돌려준다. */
  function beforeSubmit(onNote) {
    var u = me(), cyc = C.state().CYCKEY, k = vkey(u, cyc), seen = PREV[k] ? PREV[k].sig : null;
    if (onNote) onNote(pending() ? '칸을 저장하는 중' : '카드 내역을 다시 확인하는 중');
    // 쓰다 만 칸·보내는 중인 칸을 먼저 끝낸다 — 끝나기 전에 서버에서 다시 받으면 방금 적은 값이 빠진 채 판정한다
    return settleSaves().then(function () {
      if (onNote) onNote('카드 내역을 다시 확인하는 중');
      return Promise.all([loadItems(cyc, false, true), loadExp(cyc)]).then(function (r) { return r[0]; });
    }).then(function (rows) {
      if (!rows) return null;                       // 다시 받지 못했으면 막지 않는다(서버가 CARD_INCOMPLETE 로 지킨다)
      var v0 = VR[k], ai0 = v0 && v0.ai ? v0.ai : null;
      var goVerify = function () { C.closePanel(); if (C.state().VIEW !== 'c_verify') C.go('c_verify'); else C.render(); };
      if (seen != null && sig(u, cyc) !== seen) {
        setPreviewed(k, false); goVerify();
        C.toast('미리보기 뒤에 카드 내역이 바뀌었습니다. PDF를 다시 확인해 주세요.', true);
        return { blocked: true };
      }
      // 검증하기 때 받은 Gemini 결과(같은 자료)를 그대로 더한다 — 서버도 같은 지문의 보관본으로 C07·C08 을 굳힌다.
      var res = localVerify(cyc, ai0 && ai0.data);
      VR[k] = { at: Date.now(), sig: sig(u, cyc), res: res, ai: ai0 };
      if (res.summary.block) {
        goVerify();
        C.toast('구분·사용목적이 빈 줄이 ' + n0(res.summary.blank_rows) + '건 있습니다. 채운 뒤 상신해 주세요.', true);
        return { blocked: true };
      }
      return { bad: res.summary.bad, warn: res.summary.warn, info: res.summary.info };
    });
  }

  /* ══════════════════ 문서(PDF · 엑셀) ══════════════════ */
  function personOf(u, fz) {
    var p = (fz && fz.person) || {}, o = C.orgPath(u), q = C.personOf(u);
    return { name: p.name || q.name || C.nameOf(u), dept: p.dept || [C.orgName(o), o.unit].filter(Boolean).join(' ') || q.dept || '', position: p.position || q.position || '' };
  }
  function docItems(rows, defUser) {
    return rows.slice().sort(byDate).map(function (it, i) {
      return { id: it.id, no: i + 1, card_no: it.card_no || '', date: it.appr_date || '', appr_no: it.appr_no || '', merchant: it.merchant || '',
        amount: Math.round(Number(it.amount) || 0), user: String(it.owner_name || '').trim() || defUser || '',
        category: it.category || '', purpose: it.purpose || '', note: it.note || '' };
    });
  }
  /** 문서 모델 하나(사람 × 기간) — SheetPdf.buildCard · CardSheet.xlsxBytes 가 같이 쓴다. */
  function cDoc(u, cyc, rows, a, fz, verify, mark, docNo) {
    // 결재란 — 세 문서 공통(C.docBoxes · C.boxLabels): 칸 이름은 그 건의 칸 모양(예전 건 v1 · 새 건 v2, 2026-10-14)
    //   담당 칸 — 상신 전(·반려·회수 뒤) 본인 문서면 지금 내 서명(운행일지 boxesOf 와 같게, 2026-10-14)
    var p = personOf(u, fz), filed = !!fz, boxes = C.docBoxes(a, p.name, C.liveSign ? C.liveSign(u) : null, u, filed);   // filed — 고정본이면 반려·회수 뒤에도 상신 때 결재란 그대로(2026-10-16 6차)
    return {
      meta: { name: p.name, cycleName: cycName(cyc) + ' 법인카드', mark: mark, docNo: docNo },
      person: p, periodLabel: cycName(cyc) + ' (' + R.span(cyc) + ')', boxes: boxes, boxLabels: C.boxLabels(a, filed), items: docItems(rows, p.name), verify: verify,
      sheets: [{ boxes: boxes, boxLabels: C.boxLabels(a, filed) }]   // fillSigns 가 결재란 서명을 여기에 채운다(같은 객체)
    };
  }
  /** 검증 결과 → PDF 검증 쪽 재료. 빈칸(block)은 「[상신 막음]」을 붙여 불일치로 보인다. */
  function vOf(res, atMs, ai) {
    if (!res) return null;
    var s = res.summary || {};
    // Gemini 를 썼는가 — 화면 검증은 ai.status, 고정본은 verify.ai_used(2026-10-12 부터). 모르면 말하지 않는다.
    var aiUsed = ai ? (ai.status === 'ok' || ai.status === 'cached') : typeof res.ai_used === 'boolean' ? res.ai_used : null;
    return {
      ranAt: isFinite(atMs) ? C.vx.whenText(new Date(atMs).toISOString()) : '', ai: false,
      noAiText: '규칙 검증(빈칸 · 같은 승인번호 · 기간 · 소유자 · 0원 · 개인경비 중복)' +
        (aiUsed === true ? ' + Gemini 구분·사용목적 확인' : aiUsed === false ? ' · Gemini 확인 없음' : ''),
      // 검증 결과 창(C.vx.showItems) 한 줄 — 검증 화면과 같은 말. 모르면 말하지 않는다(2026-10-21: 예전엔 늘 「Gemini 읽기 없음」)
      aiNote: aiUsed === true ? 'Gemini 가 구분·사용목적을 봤습니다' : aiUsed === false ? 'AI 검증을 하지 못했습니다(규칙 검증만)' : '',
      notes: ['· 금액은 ERP 에서 받은 승인금액 그대로입니다(취소·0원 줄은 올릴 때 뺐습니다).',
        '· 구분·사용목적이 빈 줄이 있으면 상신할 수 없습니다. 나머지 항목은 결재자가 보고 판단합니다.'],
      summary: { bad: (s.block || 0) + (s.bad || 0), warn: s.warn || 0, info: s.info || 0, receipts: 0, read: 0 },
      items: (res.items || []).map(function (i) { return i.level === 'block' ? { code: i.code, level: 'bad', title: '[상신 막음] ' + i.title, detail: i.detail } : i; })
    };
  }
  function showPdf(d, o) {
    return C.vx.makePdf(pdfOpts(d, o)).catch(function () { });
  }
  /** makePdf·buildPdf 재료 — 「결재 문서 PDF」와 결재 카드 미리보기(2026-10-12)가 같이 쓴다. */
  function pdfOpts(d, o) {
    return {
      doc: { sheets: d.sheets, scans: [], photos: [] }, nImg: 0, verify: d.verify, title: o.title, sub: o.sub, file: o.file,
      note: o.note, expect: o.expect, expectName: o.expectName, okKey: o.okKey || '', again: !!o.again, okAttr: 'data-cpdfok', meta: d.meta,
      stat: function (res) { var t = (res && res.totals && res.totals[0]) || {}; return '지출결의서 ' + n0(t.pages || 1) + '장 · ' + n0(d.items.length) + '건'; },
      build: function (lib) {
        return window.SheetPdf.buildCard(d, { PDFLib: lib.PDFLib, fontkit: lib.fontkit, fontRegular: lib.fontRegular, fontBold: lib.fontBold });
      }
    };
  }
  /** 상신 전 미리보기(지금 자료). 결재 중·완료면 고정본으로. */
  function pdfMine() {
    var S = C.state(), u = me(), cyc = S.CYCKEY, a = myC(cyc);
    if (a && (a.status === 'submitted' || a.status === 'approved')) { pdfFrozen(a.id); return; }
    var rows = mineRows(cyc);
    if (!rows.length) { C.toast('이 기간에 담을 카드 내역이 없습니다.', true); return; }
    var k = vkey(u, cyc), v = VR[k];
    var d = cDoc(u, cyc, rows, null, null, v ? vOf(v.res, v.at, v.ai) : null, 'preview', '상신 전 미리보기 · ' + C.vx.whenText(new Date().toISOString()) + ' 출력');
    showPdf(d, { title: 'PDF 미리보기 — 법인카드', sub: d.person.name + ' · ' + cycName(cyc) + ' (' + R.span(cyc) + ')',
      file: '법인카드_지출결의_' + C.vx.safeName(d.person.name) + '_' + cyc + '_미리보기.pdf',
      expect: R.totals(rows).cost, expectName: '화면 합계', okKey: k, again: !!(a && (a.status === 'rejected' || a.status === 'withdrawn')) });
  }
  var FZ = {}, FZSUM = {}, FZFAIL = {}, FZASK = '';
  var FZWAIT = [];                      // 고정본 요약을 기다리는 쪽(결재 창 다시 그리기)
  function fzFlush() { var w = FZWAIT; FZWAIT = []; w.forEach(function (f) { try { f(); } catch (e) { } }); }
  function fzKey(a) { return a.id + '|' + (a.submitted_at || ''); }
  function fetchFrozen(a) {
    var k = fzKey(a);
    if (FZ[k] !== undefined) return Promise.resolve(FZ[k]);
    return rest('/rest/v1/card_frozen?approval_id=eq.' + encodeURIComponent(a.id) + '&select=*&limit=1')
      .then(function (rows) { FZ[k] = (rows && rows[0]) || null; return FZ[k]; });
  }
  function frozenDoc(a, fz) {
    var data = fz.data || {}, done = a.status === 'approved';
    var mark = done ? '' : a.status === 'submitted' ? 'pending' : a.status === 'rejected' ? 'rejected' : 'withdrawn';
    var v = fz.verify ? vOf(fz.verify, Date.parse(fz.verify.ran_at || fz.frozen_at)) : null;
    return cDoc(a.username, a.cycle, data.items || [], a, data, v, mark,
      '법인카드 결재 #' + a.id + ' · 상신 ' + C.vx.whenText(fz.frozen_at || a.submitted_at) + (done && a.closed_at ? ' · 완료 ' + C.vx.whenText(a.closed_at) : ''));
  }
  var MARK_SUFFIX = { '': '_결재완료', pending: '_결재중', rejected: '_반려', withdrawn: '_회수' };
  function pdfFrozen(id) {
    var a = apprById(id);
    if (!a) { C.toast('결재 건을 찾지 못했습니다.', true); return; }
    fetchFrozen(a).then(function (fz) {
      if (!fz) { C.toast('상신 때 저장한 자료를 찾지 못했습니다. 관리자에게 알려 주세요.', true); return; }
      var o = frozenOpts(a, fz);
      if (a.status === 'approved') o.prints = { kind: 'card', ids: [a.id] };      // 결재 완료본 — 내려받기·열기를 누르면 출력 기록(2026-10-14)
      C.vx.makePdf(o).catch(function () { });
    }).catch(function () { C.toast('결재 문서를 불러오지 못했습니다. 잠시 뒤 다시 해 보세요.', true); });
  }
  function frozenOpts(a, fz) {
    var d = frozenDoc(a, fz), done = a.status === 'approved';
    // 결재 완료본에는 검증 결과 쪽을 붙이지 않는다(2026-10-14 사용자 — 출력물엔 필요 없다). 결재 중 문서에는 그대로 — 결재자가 본다.
    if (done) d = Object.assign({}, d, { verify: null });
    return pdfOpts(d, { title: done ? '결재 완료본 — 법인카드' : a.status === 'submitted' ? '결재 문서 — 법인카드' : '상신했던 문서 — 법인카드',
      sub: d.person.name + ' · ' + cycName(a.cycle) + ' (' + R.span(a.cycle) + ')',
      file: '법인카드_지출결의_' + C.vx.safeName(d.person.name) + '_' + a.cycle + MARK_SUFFIX[d.meta.mark] + '.pdf',
      expect: (a.snapshot || {}).cost, expectName: '상신 때 집계한 금액' });
  }
  /** 결재 카드 미리보기(2026-10-12) — 「결재 문서 PDF」와 같은 재료·같은 생성기로 바이트만. */
  function previewBytes(id) {
    var a = apprById(id);
    if (!a) return Promise.reject(new Error('noappr'));
    return fetchFrozen(a).then(function (fz) {
      if (!fz) throw new Error('nofrozen');
      return C.vx.buildPdf(frozenOpts(a, fz)).then(function (res) { return res.bytes; });
    });
  }
  function xlsxFrozen(id) {
    var a = apprById(id); if (!a) return;
    fetchFrozen(a).then(function (fz) {
      if (!fz) { C.toast('상신 때 저장한 자료를 찾지 못했습니다.', true); return; }
      var d = frozenDoc(a, fz), x = SH.xlsxBytes(d, window.Xlsx);
      var sum = d.items.reduce(function (s, it) { return s + it.amount; }, 0), exp = (a.snapshot || {}).cost;
      C.saveBlob(x.bytes, '법인카드_지출결의_' + C.vx.safeName(d.person.name) + '_' + a.cycle + MARK_SUFFIX[d.meta.mark] + '.xlsx');
      if (a.status === 'approved' && C.prints) C.prints.log('card', a.id, 'xlsx');        // 출력 기록(기다리지 않는다)
      if (exp != null && Math.round(sum) !== Math.round(Number(exp))) C.toast('엑셀 합계 ' + n0(sum) + '원이 상신 때 금액 ' + n0(exp) + '원과 다릅니다. 관리자에게 알려 주세요.', true);
      else C.toast('엑셀을 내려받습니다.');
    }).catch(function () { C.toast('결재 문서를 불러오지 못했습니다.', true); });
  }

  /* ══════════════════ 결재함 카드 · 결재 요약 ══════════════════ */
  function wantSums(ids, done) {
    var now = Date.now(), need = [];
    (ids || []).forEach(function (id) {
      var a = apprById(id); if (!a) return;
      var k = fzKey(a);
      if (FZSUM[k] !== undefined || (FZFAIL[k] && now - FZFAIL[k] < 30000)) return;
      need.push(a);
    });
    if (!need.length) return;
    if (done) FZWAIT.push(done);          // 다 받으면(실패해도) 알려 준다 — 결재 창(관리자 반려 등)이 「불러오는 중」에 멈추지 않게(2026-10-16 3차)
    var s = need.map(fzKey).join(',');
    if (FZASK === s) return;
    FZASK = s;
    var view = C.state().VIEW;
    rest('/rest/v1/card_frozen?approval_id=in.(' + need.map(function (a) { return a.id; }).join(',') + ')&select=approval_id,verify,frozen_at')
      .then(function (rows) {
        var by = {}; (rows || []).forEach(function (x) { by[x.approval_id] = x; });
        need.forEach(function (a) { FZSUM[fzKey(a)] = by[a.id] || null; });
        FZASK = '';
        if (C.state().VIEW === view && !typing()) C.render();
        fzFlush();
      }).catch(function () {
        need.forEach(function (a) { FZFAIL[fzKey(a)] = Date.now(); }); FZASK = '';
        if (C.state().VIEW === view && !typing()) C.render();   // 못 받았어도 다시 그린다 — 결재함이 묶기 전에 기다린다(2026-10-20 V3 B7)
        fzFlush();
      });
  }
  /** 지금 내가 결재할 차례인 건인가(요약 문구용). */
  function myTurn(a) { var me = (C.state().ME || {}).username; return !!me && (a.steps || []).some(function (s) { return s.seq === a.cur_seq && s.approver === me; }); }
  /** 결재 요약(결재 중) + 검증 딱지 · 문서 단추. 개인경비 extra 와 같은 모양.
   *  own = 상신한 본인의 카드 내역·검증 화면(결재 띠) — 결재자용 요약 표(brief)는 결재함에서만(2026-10-15). */
  function extra(a, own) {
    if (!a) return '';
    var f = FZSUM[fzKey(a)], done = a.status === 'approved', live = a.status === 'submitted' || done;
    var chip = f && f.verify ? '<button class="vchip" data-cfzverify="' + a.id + '" title="상신할 때의 검증 결과 보기">' + sumChip(f.verify.summary) + '</button>' : '';
    if (done && C.prints) chip += C.prints.badge('card', a);            // 출력 딱지(2026-10-14)
    return (own ? '' : brief(a, f)) + '<div class="aext">' + chip + '<span style="flex:1"></span>' +
      '<button class="btn sm" data-cfzpdf="' + a.id + '">' + ic('dl', 13) + 'PDF 받기</button>' +
      (done ? '<button class="btn sm" data-cfzxlsx="' + a.id + '">' + ic('dl', 13) + '엑셀 받기</button>' : '') + '</div>';
  }
  function brief(a, f) {
    if (!a || a.status !== 'submitted') return '';
    var s = a.snapshot || {};
    if (s.cost == null) return '';
    // 전월 = 이름 달의 앞 달(1월분 → 12월분, 2026-10-20). 12월 추가 기간(12월분 2차)은 견주지 않는다 — 「—」.
    var cost = Number(s.cost) || 0, pkey = prevMonthKey(a.cycle), pm = pkey ? +pkey.slice(5, 7) + '월분' : '';
    var prev = pkey ? (CAPPR || []).filter(function (x) { return x.username === a.username && x.cycle === pkey && (x.status === 'approved' || x.status === 'submitted') && x.snapshot && x.snapshot.cost != null; })[0] : null;
    var cmp;
    if (prev) {
      var p0 = Number(prev.snapshot.cost) || 0, d = cost - p0, pct = p0 ? Math.round(d / p0 * 100) : null;
      cmp = '<div class="abf"><span class="k">전월(' + pm + ') 대비</span><b class="' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '') + won(Math.abs(d)) +
        (pct != null && d ? ' <small>(' + (d > 0 ? '+' : '−') + (Math.abs(pct) < 1 ? '1% 미만' : Math.abs(pct) + '%') + ')</small>' : '') + '</b><span class="sub">' + pm + ' ' + won(p0) + ' · ' + n0(prev.snapshot.n) + '건</span></div>';
    } else cmp = '<div class="abf"><span class="k">전월 대비</span><b class="dimv">—</b><span class="sub">' + (pkey ? '볼 수 있는 ' + pm + ' 법인카드 결재가 없습니다' : '추가 기간은 전월과 견주지 않습니다') + '</span></div>';
    var v = f && f.verify, vs = (v && v.summary) || null;
    var items = ((v && v.items) || []).filter(function (i) { return i.level === 'bad' || i.level === 'warn'; });
    var checks = [];
    if (vs) {
      // 2026-10-15 2차: 칩 「같은 승인번호 N건/검증 확인 필요/이상 없음」은 뺀다 — 띠(판정)와 검증 딱지(알약)에 이미 있다
      // C07~C09(2026-10-12) — 줄 수로 딱지 하나씩
      var rowsOf = function (code) { return ((v && v.items) || []).filter(function (i) { return i.code === code; }).reduce(function (n, i) { return n + ((i.ref && i.ref.items) || []).length; }, 0); };
      [['C07', '구분·내역 불일치'], ['C08', '사용목적 부실'], ['C09', '개인경비 중복 의심']].forEach(function (c) {
        var n = rowsOf(c[0]); if (n) checks.push(['warn', c[1] + ' ' + n0(n) + '줄']);
      });
    } else if (f === undefined) { if (!FZFAIL[fzKey(a)]) checks.push(['warn', '검증 결과를 불러오는 중…']); }   // 못 받았으면 그 줄은 없앤다(판정 띠가 말한다)
    else checks.push(['warn', '상신 때 검증 결과가 없습니다']);
    var nBad = (vs && vs.bad ? 1 : 0) + checks.filter(function (c) { return c[0] === 'bad'; }).length,
      nWarn = (vs && vs.warn ? 1 : 0) + checks.filter(function (c) { return c[0] === 'warn'; }).length;
    var asApprover = a.username !== (C.state().ME || {}).username;   // 결재하는 분 — 상신자 할 일(고치세요)은 보이지 않는다
    var verdict = !vs ? ['warn', (f === undefined && FZFAIL[fzKey(a)] ? '상신 때 검증 결과를 불러오지 못했습니다' : f === undefined ? '검증 결과를 불러오는 중입니다' : '검증 결과를 아직 받지 못했습니다') + ' — 아래 「PDF 받기」로 문서를 열어 확인해 주세요']
      : nBad ? ['bad', asApprover ? '확인이 필요합니다 — 문서의 불일치 항목을 보고 결재해 주세요' : '검증에서 맞지 않는 곳이 있습니다 — 결재하는 분이 문서에서 함께 봅니다']   // 상신한 본인에게는 본인용 문구(2026-10-16 3차)
      : nWarn ? ['warn', '대체로 정상입니다 — ' + C.vx.warnTail(items, vs, asApprover)]
      : ['ok', '금액·검증 모두 이상 없습니다' + (myTurn(a) ? ' — 문서를 열지 않고 승인하셔도 됩니다' : '')];   // 「열지 않고 승인」은 지금 결재할 분에게만
    return '<div class="abrief ' + verdict[0] + '"><div class="abv"><span class="abi">' + (verdict[0] === 'ok' ? '✓' : '!') + '</span><b>' + esc(verdict[1]) + '</b></div>' +
      '<div class="abgrid">' +
      '<div class="abf"><span class="k">청구 금액</span><b>' + won(cost) + '</b><span class="sub">' + esc(catLine(s.by_cat)) + '</span></div>' +
      '<div class="abf"><span class="k">카드 승인</span><b>' + n0(s.n) + '<small>건</small></b><span class="sub">' + esc(R.span(a.cycle)) + '</span></div>' +
      cmp + '</div><div class="abchk">' + checks.map(function (c) { return '<span class="ck ' + c[0] + '">' + (c[0] === 'ok' ? '✓' : '!') + ' ' + esc(c[1]) + '</span>'; }).join('') + '</div>' +
      (items.length ? '<ul class="abitems">' + items.slice(0, 4).map(function (i) {
        return '<li class="' + i.level + '"><b>' + esc(i.title || '') + '</b>' + (i.detail && !asApprover ? ' — ' + esc(String(i.detail).slice(0, 110)) + (String(i.detail).length > 110 ? '…' : '') : '') + '</li>';
      }).join('') + (items.length > 4 ? '<li class="more">외 ' + n0(items.length - 4) + '건 — 아래 검증 딱지를 눌러 전부 보기</li>' : '') +
        (asApprover ? '<li class="more">고치는 것은 상신한 분이 합니다 — 고쳐야 하면 반려하고 사유에 적어 주세요.</li>' : '') + '</ul>' : '') + '</div>';
  }
  function sumHtml(a) {
    var s = a.snapshot || {};
    var kv = function (k, v) { return '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; };
    if (s.cost == null) return '';
    return kv('기간', esc(cycName(a.cycle)) + ' <span class="dim">(' + esc(R.span(a.cycle)) + ')</span>') +
      kv('구분별', esc(catLine(s.by_cat))) +
      kv('합계', '<b style="font-size:15px">' + won(s.cost) + '</b> <span class="dim">' + n0(s.n) + '건</span>');
  }

  /* ══════════════════ 관리 — 현황 · 전체 내역 · 결재 완료 출력 · 직원 현황 ══════════════════ */
  function cycAppr() { var k = C.state().CYCKEY; return (CAPPR || []).filter(function (a) { return a.cycle === k; }); }
  function peopleOf(rows) {
    var by = {};
    rows.forEach(function (it) {
      var x = by[it.username] = by[it.username] || { u: it.username, n: 0, sum: 0, blank: 0 };
      x.n++; x.sum += Number(it.amount) || 0;
      if (!String(it.category || '').trim() || !String(it.purpose || '').trim()) x.blank++;
    });
    cycAppr().forEach(function (a) { if (!by[a.username]) by[a.username] = { u: a.username, n: 0, sum: 0, blank: 0 }; });
    return by;
  }
  function orgUsers(view) {
    if (ADMIN_C.indexOf(view) < 0) return null;
    var x = ITEMS[itemKey(true, C.state().CYCKEY)];
    var has = Object.keys(peopleOf((x && x.rows) || []));
    if (view === 'ca_people') return { label: '등록 직원', list: Object.keys(C.state().USERS || {}).concat(has) };
    return { label: '카드 내역이 있는 사람', list: has };
  }
  function adminRows() {
    var rows = itemsFor(true);
    if (!rows || rows.err || CAPPR === null) return rows || null;
    return rows;
  }
  function viewAdminClose() {
    var S = C.state();
    if (!S.LOADED) return C.head('법인카드 현황') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('법인카드 현황', '법인카드');
    var rows = adminRows();
    if (!rows || rows.err) return notReady('법인카드 현황', rows);
    rows = rows.filter(function (it) { return C.orgMatch(it.username); });
    var by = peopleOf(rows), list = Object.keys(by).filter(function (u) { return C.orgMatch(u); }).map(function (u) { var x = by[u]; x.a = cApprOf(u, S.CYCKEY); return x; });
    var T = R.totals(rows);
    // 2026-10-15 2차(관리자 메뉴 원칙): 현황은 금액·구분·팀만. 결재 상태 네 칸·PDF·관리자 반려·정정 열기는 「결재 완료 출력」에만
    //   (예전에는 두 화면이 같은 결재 상태 칸과 반려·정정 단추를 되풀이했다 — 군더더기 검토 상 9).
    var cats = Object.keys(T.by_cat || {}).map(function (c) { return { c: c, n: T.by_cat[c].n, sum: T.by_cat[c].sum }; })
      .sort(function (a, b) { return b.sum - a.sum; });
    var h = head('법인카드 현황', '직원별 금액·구분·팀');
    // 챙길 사람 + 팀즈 알림 보내기(2026-10-20 D2 — 운행일지 현황과 같은 조각 C.follow, 서버 approval-act op 'remind' 가 다시 확인).
    //   결재 완료 출력 「챙겨야 할 사람」과 같은 사람: 이번 달 카드 내역이 있는데 상신 전 · 회수 · 반려. 남은 일은 이 화면이 이미 센 것만(건수·금액·빈칸, 반려면 사유).
    if (C.follow) {
      var lastC = {};
      rows.forEach(function (it) { var ms = Date.parse(it.updated_at || it.created_at || '') || 0; if (ms > (lastC[it.username] || 0)) lastC[it.username] = ms; });
      h += '<div class="d2grid">' + C.follow('card', S.CYCKEY, list.filter(function (x) {
        return (!x.a && x.n > 0) || (x.a && (x.a.status === 'rejected' || x.a.status === 'withdrawn'));
      }).map(function (x) {
        var a = x.a, st = !a ? 'none' : a.status, rs = st === 'rejected' ? (a.steps || []).filter(function (s) { return s && s.result === 'rejected'; })[0] : null;
        return { u: x.u, st: st, last: Math.max(lastC[x.u] || 0, a ? (Date.parse(a.closed_at || a.updated_at || '') || 0) : 0),
          left: st === 'rejected' ? '반려 사유: ' + (rs && rs.comment ? String(rs.comment).replace(/\s+/g, ' ') : '(사유 없음)')
            : (st === 'withdrawn' ? '회수함 · ' : '') + '카드 ' + n0(x.n) + '건 · ' + won(x.sum) + (x.blank ? ' · 빈칸 ' + n0(x.blank) + '줄' : '') };
      }), { wide: true, none: '이번 달 카드 내역이 있는 사람은 모두 상신했습니다' }) + '</div>';
    }
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot ok"></span>카드 내역이 있는 ' + n0(list.length) + '명 · ' + n0(T.n) + '건</div>' +
      '<p class="verdict">' + won(T.cost) + '</p>' +
      (cats.length ? '<div class="facts">' + cats.slice(0, 4).map(function (x) { return fact(x.c, won(x.sum), n0(x.n) + '건'); }).join('') +
        (cats.length > 4 ? fact('그 밖의 구분', won(cats.slice(4).reduce(function (s, x) { return s + x.sum; }, 0)), n0(cats.length - 4) + '구분') : '') + '</div>' : '') +
      '</div>';
    // 팀별 합계 카드 — 누르면 그 팀으로 좁힌다(운행일지·개인경비 관리와 같은 모양)
    var tb = {}, tl = [];
    list.forEach(function (x) {
      var p = C.orgPath(x.u), k = p.div + '|' + p.team;
      if (!tb[k]) { tb[k] = { p: p, n: 0, sum: 0, cnt: 0 }; tl.push(tb[k]); }
      tb[k].n++; tb[k].sum += x.sum; tb[k].cnt += x.n;
    });
    if (tl.length > 1) {
      var max = tl.reduce(function (m, g) { return Math.max(m, g.sum); }, 1);
      tl.sort(function (a, b) { return b.sum - a.sum; });
      // 팀이 셋 이하면 표 줄, 막대 = 전체의 N%(2026-10-19 사용성 2차 #13 — 운행일지 관리와 같은 C.teamBars)
      h += '<section class="sect">' + (C.teamBars ? C.teamBars(tl.map(function (g) {
        return { attr: ' data-orgteam="' + esc(g.p.div + '|' + g.p.team) + '"', label: C.orgName(g.p), sub: g.p.div || '', value: g.sum, meta: n0(g.n) + '명 · ' + n0(g.cnt) + '건' };
      })) : '<div class="tcards">' + tl.map(function (g) {
        return '<button class="tcard" data-orgteam="' + esc(g.p.div + '|' + g.p.team) + '"><span class="tl">' + esc(C.orgName(g.p)) + '</span><span class="ts">' + esc(g.p.div || '') + '</span>' +
          '<span class="tv">' + won(g.sum) + '</span><span class="tbar"><i style="width:' + Math.max(3, Math.round(g.sum / max * 100)) + '%"></i></span>' +
          '<span class="tm">' + n0(g.n) + '명 · ' + n0(g.cnt) + '건</span></button>';
      }).join('') + '</div>') + '</section>';
    }
    list.sort(function (x, y) { return y.sum - x.sum; });
    h += C.sect('직원별', n0(list.length) + '명', '', list.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>파트·센터</th><th>이름</th>' +
      '<th class="n">건수</th><th class="n">금액</th><th>빈칸</th><th></th></tr></thead><tbody>' +
      C.orgGroups(list, function (x) { return x.u; }, true).map(function (g) {
        return C.orgGroupRow(g, 6, '합계 <b>' + won(g.list.reduce(function (s, x) { return s + x.sum; }, 0)) + '</b>') + g.list.map(function (x) {
          return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td><td class="n">' + n0(x.n) + '</td>' +
            '<td class="n total">' + n0(x.sum) + '</td><td>' + (x.blank ? '<span class="st bad">' + n0(x.blank) + '줄</span>' : '<span class="dim">—</span>') + '</td>' +
            '<td class="n" style="white-space:nowrap">' +
            (x.n ? '<button class="btn sm" data-cperson="' + esc(x.u) + '">내역</button>' : '') + '</td></tr>';
        }).join('');
      }).join('') + '</tbody></table></div></div>' : C.blank('이 기간에 카드 내역이 있는 사람이 없습니다.', null, 'users'));
    h += '<div class="anote">결재 상태·결재 완료본 받기·관리자 반려·정정 열기는 「결재 완료 출력」에서 합니다.</div>';
    return h;
  }
  /** 직원 현황(법인카드) — 등록된 모든 직원의 이번 달 카드 내역(카드가 없는 사람도 명단에). */
  function viewAdminPeople() {
    var S = C.state();
    if (!S.LOADED) return C.head('직원 현황') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('직원 현황', '법인카드');
    var rows = adminRows();
    if (!rows || rows.err) return notReady('직원 현황', rows);
    var users = Object.keys(S.USERS || {}).filter(function (u) { return C.orgMatch(u); }), mine = {};
    rows.forEach(function (it) { if (C.orgMatch(it.username)) (mine[it.username] = mine[it.username] || []).push(it); });
    Object.keys(mine).forEach(function (u) { if (users.indexOf(u) < 0) users.push(u); });
    var list = users.map(function (u) { var r = mine[u] || [], t = R.totals(r); return { u: u, n: t.n, sum: t.cost, blank: R.blankRows(r), a: cApprOf(u, S.CYCKEY) }; });
    var none = list.filter(function (x) { return !x.n; }).length;
    var h = head('직원 현황', n0(list.length) + '명');
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>이번 달 법인카드</div>' +
      '<p class="verdict">' + (list.length - none ? '<em>' + n0(list.length - none) + '명</em>이 카드 내역을 올렸습니다' : '<em>아직 올린 카드 내역이 없습니다</em>') + '</p>' +
      '<div class="facts">' + fact('등록 인원', n0(list.length) + '<small>명</small>') + fact('내역 있음', n0(list.length - none) + '<small>명</small>') + fact('내역 없음', n0(none) + '<small>명</small>') + '</div></div>';
    list.sort(function (x, y) { return y.sum - x.sum; });
    h += C.sect('명단', n0(list.length) + '명', '', list.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>파트·센터</th><th>이름</th><th>직급</th>' +
      '<th class="n">건수</th><th class="n">합계</th><th>빈칸</th><th>결재</th></tr></thead><tbody>' +
      C.orgGroups(list, function (x) { return x.u; }, true).map(function (g) {
        return C.orgGroupRow(g, 7, '합계 <b>' + won(g.list.reduce(function (s, x) { return s + x.sum; }, 0)) + '</b>') + g.list.map(function (x) {
          var u = S.USERS[x.u] || {};
          return '<tr' + (x.n ? ' class="clk" tabindex="0" data-cperson="' + esc(x.u) + '"' : '') + '>' + C.orgCell(x.u, true) +
            '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td><td class="dim">' + esc(u.position || '—') + '</td>' +
            '<td class="n' + (x.n ? '' : ' dim') + '">' + n0(x.n) + '</td><td class="n total">' + (x.sum ? n0(x.sum) : '—') + '</td>' +
            '<td>' + (x.blank ? '<span class="st bad">' + n0(x.blank) + '줄</span>' : '<span class="dim">—</span>') + '</td>' +
            '<td>' + (x.a ? stChip(x.a) : (x.n ? '<span class="st warn">상신 전</span>' : '<span class="dim">—</span>')) + '</td></tr>';
        }).join('');
      }).join('') + '</tbody></table></div></div>' : C.blank('보는 범위에 직원이 없습니다.', null, 'users'));
    h += '<div class="anote">줄을 누르면 그 사람의 카드 내역(전체 내역)으로 갑니다.</div>';
    return h;
  }
  var CL = { cat: '', who: '', blank: false };
  function listFiltered(rows) {
    return rows.filter(function (it) {
      if (!C.orgMatch(it.username)) return false;
      if (CL.cat && String(it.category || '').trim() !== CL.cat) return false;
      if (CL.who && it.username !== CL.who) return false;
      if (CL.blank && String(it.category || '').trim() && String(it.purpose || '').trim()) return false;
      return true;
    });
  }
  function viewAdminList() {
    var S = C.state();
    if (!S.LOADED) return C.head('법인카드 전체 내역') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('법인카드 전체 내역', '법인카드');
    var all = adminRows();
    if (!all || all.err) return notReady('법인카드 전체 내역', all);
    var scoped = all.filter(function (it) { return C.orgMatch(it.username); }), rows = listFiltered(all);
    var who = {}, cats = {};
    scoped.forEach(function (it) { who[it.username] = 1; var c = String(it.category || '').trim(); if (c) cats[c] = (cats[c] || 0) + 1; });
    if (CL.who && !who[CL.who]) CL.who = '';
    if (CL.cat && !cats[CL.cat]) CL.cat = '';
    var whoOpts = Object.keys(who).sort(function (a, b) { return C.nameOf(a).localeCompare(C.nameOf(b), 'ko'); });
    var nBlank = scoped.filter(function (it) { return !String(it.category || '').trim() || !String(it.purpose || '').trim(); }).length;
    var h = head('법인카드 전체 내역', '카드 승인 한 건이 한 줄');
    h += '<div class="fbar"><label class="field"><select id="cCat" aria-label="구분"><option value="">구분 전체</option>' +
      Object.keys(cats).sort().map(function (c) { return '<option value="' + esc(c) + '"' + (CL.cat === c ? ' selected' : '') + '>' + esc(c) + ' (' + cats[c] + ')</option>'; }).join('') + '</select></label>' +
      '<label class="field"><select id="cWho" aria-label="사람"><option value="">사람 전체</option>' + whoOpts.map(function (u) { return '<option value="' + esc(u) + '"' + (CL.who === u ? ' selected' : '') + '>' + esc(C.nameOf(u)) + '</option>'; }).join('') + '</select></label>' +
      '<button class="btn sm' + (CL.blank ? ' pri' : '') + '" data-cblank aria-pressed="' + CL.blank + '">빈칸 있는 줄만 ' + n0(nBlank) + '</button>' +
      '<span style="flex:1"></span><button class="btn sm" data-ccsv>' + ic('dl', 13) + '목록 CSV</button></div>';
    var total = rows.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0);
    var sorted = rows.slice().sort(byDate);
    h += C.sect('내역', n0(rows.length) + '건 · ' + won(total), '', rows.length ? '<div class="panel"><div class="scroll tall" data-rows><table class="xtab"><thead><tr>' +
      '<th>승인일</th><th>파트·센터</th><th>이름</th><th>카드번호</th><th>가맹점</th><th class="n">승인금액</th><th>구분</th><th>사용목적</th><th>비고</th></tr></thead><tbody>' +
      C.orgGroups(sorted, function (it) { return it.username; }).map(function (g) {
        return C.orgGroupRow(g, 9, n0(g.list.length) + '건 · 합계 <b>' + won(g.list.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0)) + '</b>').replace(/<span class="on">[^<]*<\/span>/, '') +
          g.list.map(function (it) {
            var bl = !String(it.category || '').trim() || !String(it.purpose || '').trim();
            return '<tr' + (bl ? ' class="xover"' : '') + '><td><span class="lead">' + esc(String(it.appr_date).slice(5).replace('-', '.')) + '</span></td>' + C.orgCell(it.username, true) +
              // 2026-10-19 웹 사용성 1차: 이름 굵게 · 카드번호는 끝 4자리(「…1234」, 전체는 title) · 비어 있는 구분·사용목적은 「빈칸」 딱지
              '<td><span class="lead">' + esc(C.nameOf(it.username)) + '</span></td><td class="dim" title="' + esc(it.card_no || '') + '">' + esc(cardTail(it.card_no)) + '</td>' +
              '<td class="el" title="' + esc(it.merchant || '') + '">' + esc(it.merchant || '—') + '</td>' +
              // 금액은 .xamt — 폰 두 줄 카드에서 개인경비 전체 내역처럼 줄 맨 위 오른쪽(예전엔 가운데 줄 왼쪽에 놓였다, 2026-10-20 D2)
              '<td class="n total"><span class="xamt">' + n0(it.amount) + '</span></td><td>' + (String(it.category || '').trim() ? '<span class="kind">' + esc(it.category) + '</span>' : '<span class="st warn">빈칸</span>') + '</td>' +
              '<td class="el" title="' + esc(it.purpose || '') + '">' + (String(it.purpose || '').trim() ? esc(it.purpose) : '<span class="st warn">빈칸</span>') + '</td><td class="el dim">' + esc(it.note || '') + '</td></tr>';
          }).join('');
      }).join('') + '</tbody><tfoot><tr><td colspan="5">보이는 ' + n0(rows.length) + '건 합계</td><td class="n total">' + n0(total) + '</td><td colspan="3"></td></tr></tfoot></table></div></div>'
      : '<div class="panel"><div class="blank"><div class="t">조건에 맞는 카드 내역이 없습니다.</div><div style="margin-top:12px"><button class="btn sm" data-cclear>조건 지우기</button></div></div></div>');
    return h;
  }
  /** 카드번호 끝 4자리만(「…1234」). 숫자가 4자리보다 적으면 그대로. */
  function cardTail(no) {
    var d = String(no || '').replace(/[^0-9]/g, '');
    return d.length > 4 ? '…' + d.slice(-4) : String(no || '') || '—';
  }
  /** CSV — 엑셀에서 바로 열리게 BOM. = + - @ 탭·CR 로 시작하는 글자는 ' 를 붙여 수식으로 실행되지 않게. */
  function csvText(rows) {
    var NL = String.fromCharCode(13, 10);
    var q = function (v) {
      if (typeof v === 'number') return String(v);
      var s = String(v == null ? '' : v);
      if (/^\s*[=+\-@|]|^[\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return String.fromCharCode(0xFEFF) + rows.map(function (r) { return r.map(q).join(','); }).join(NL) + NL;
  }
  function scopeSuffix() { var s = C.orgScopeName ? C.orgScopeName() : ''; return s ? '_' + s.replace(/[\\/:*?"<>|\s]+/g, '') : ''; }
  function listCsv() {
    var S = C.state(), x = ITEMS[itemKey(true, S.CYCKEY)], rows = listFiltered((x && x.rows) || []).sort(byDate);
    var out = [['승인일', '승인시간', '이름', '아이디', '소속', '카드번호', '승인번호', '가맹점', '업종', '승인금액', '구분', '사용목적', '비고']];
    rows.forEach(function (it) {
      var op = C.orgPath(it.username);
      out.push([it.appr_date, it.appr_time || '', C.nameOf(it.username), it.username, [C.orgName(op), op.unit].filter(Boolean).join(' · '), it.card_no || '', it.appr_no,
        it.merchant || '', it.biz_type || '', Number(it.amount) || 0, it.category || '', it.purpose || '', it.note || '']);
    });
    out.push(['합계', '', '', '', '', '', '', '', '', rows.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0), '', '', '']);
    C.saveBlob(new TextEncoder().encode(csvText(out)), '법인카드_내역_' + S.CYCKEY + scopeSuffix() + '.csv', 'text/csv;charset=utf-8');
    C.toast('CSV 를 내려받습니다(' + n0(rows.length) + '건).');
  }
  var FINSEL = {}, FINJOB = null;
  /** 결재 완료 출력 표의 날짜 — 「10.14 15:20」(한국시간, 2026-10-20 AU6-M3, 개인경비와 같게). */
  function finWhen(iso) { var ms = Date.parse(iso); return isFinite(ms) ? C.md(ms) + ' ' + C.hm(ms) : ''; }
  function viewAdminFinal() {
    var S = C.state();
    if (!S.LOADED) return C.head('법인카드 결재 완료 출력') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('법인카드 결재 완료 출력', '출력');
    var all = adminRows();
    if (!all || all.err) return notReady('법인카드 결재 완료 출력', all);
    var list = cycAppr().filter(function (a) { return C.orgMatch(a.username); });
    var done = list.filter(function (a) { return a.status === 'approved'; }).sort(function (x, y) { return C.nameOf(x.username).localeCompare(C.nameOf(y.username), 'ko'); });
    var going = list.filter(function (a) { return a.status === 'submitted'; });
    var back = list.filter(function (a) { return a.status === 'rejected' || a.status === 'withdrawn'; });
    var by = peopleOf(all.filter(function (it) { return C.orgMatch(it.username); }));
    var sent = {}; list.forEach(function (a) { sent[a.username] = 1; });
    var notYet = Object.keys(by).filter(function (u) { return by[u].n > 0 && !sent[u] && C.orgMatch(u); });
    var total = done.reduce(function (s, a) { return s + (Number((a.snapshot || {}).cost) || 0); }, 0);
    var ok = {}; done.forEach(function (a) { ok[a.id] = 1; });
    Object.keys(FINSEL).forEach(function (k) { if (!ok[k]) delete FINSEL[k]; });
    // 「출력 안 한 것만」(2026-10-14) — 표에 보이는 줄만 거른다(위 숫자·합계는 그대로). 고른 수·전체 선택·묶어 받기도 보이는 줄만.
    var shown = C.prints ? done.filter(function (a) { return C.prints.keep('card', a); }) : done;
    var nSel = shown.filter(function (a) { return FINSEL[a.id]; }).length;
    var nRej = back.filter(function (a) { return a.status === 'rejected'; }).length, nWd = back.length - nRej;
    var h = head('법인카드 결재 완료 출력', '결재가 끝난 지출결의서를 모아 출력합니다');
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (done.length && !going.length && !notYet.length ? ' ok' : '') + '"></span>' + esc(cycName(S.CYCKEY)) + ' · ' + esc(R.span(S.CYCKEY)) + '</div>' +
      '<p class="verdict">결재 완료 <em>' + n0(done.length) + '명</em> · ' + won(total) + '</p><div class="facts">' +
      // 분류는 운행일지 결재 완료 출력과 같은 셋(결재 중·반려·미상신, 결재 완료는 위 큰 제목) — 회수는 다시 올리기 전까지 미상신(2026-10-19)
      fact('결재 중', n0(going.length) + '<small>명</small>', '결재자 차례를 기다리는 중', going.length > 0) +
      fact('반려', n0(nRej) + '<small>명</small>', '고쳐서 다시 상신해야 함', nRej > 0) +
      fact('미상신', n0(notYet.length + nWd) + '<small>명</small>', nWd ? '이번 달 카드 내역이 있는데 상신 전(회수 ' + n0(nWd) + '명 포함)' : '이번 달 카드 내역이 있는데 상신 전', notYet.length + nWd > 0) + '</div></div>';
    var tools = done.length ? '<button class="btn sm' + (nSel ? ' pri' : '') + '" data-cfinpdf' + (nSel && !FINJOB ? '' : ' disabled') + '>' + ic('dl', 13) + (nSel ? '고른 ' + n0(nSel) + '명 PDF 한 파일로' : 'PDF 한 파일로 묶기') + '</button>' +
      '<button class="btn sm" data-cfincsv>' + ic('dl', 13) + '금액 요약표(CSV)</button>' + (C.prints ? C.prints.onlyBtn('card') : '') : '';
    h += C.sect('결재 완료', n0(done.length) + '명', tools, done.length && !shown.length
      ? C.blank('출력 안 한 결재 완료 문서가 없습니다.', '모두 한 번 이상 출력했습니다. 「출력 안 한 것만」을 다시 누르면 전체가 보입니다.', 'stamp')
      : done.length ? '<div class="panel"><div class="scroll" data-rows><table class="rcard ftab"><thead><tr>' +
      // 세 표 같은 열 순서(팀 묶음 + 파트·센터 · 이름 · 상태) · 「전체 선택」은 표 머리 첫 칸(2026-10-19 사용성 2차 #12, 운행일지와 같게)
      '<th class="fchk"><label class="finall"><input type="checkbox" id="cFinAll"' + (nSel && nSel === shown.length ? ' checked' : '') + '> 전체 선택</label></th>' +
      '<th>파트·센터</th><th>이름</th><th>상태</th><th>날짜</th><th class="n">건수</th><th class="n">금액</th><th>결재선</th><th></th></tr></thead><tbody>' +
      C.orgGroups(shown, function (a) { return a.username; }, true).map(function (g) {
        return C.orgGroupRow(g, 9, '합계 <b>' + won(g.list.reduce(function (s, a) { return s + (Number((a.snapshot || {}).cost) || 0); }, 0)) + '</b>') + g.list.map(function (a) {
          var line = (a.steps || []).map(function (s) { return C.stepText(s); }).join(' → ');   // 이름 직책 (칸) — 진행 줄·상신 창과 같은 직책(2026-10-16 5차)
          return '<tr><td><input type="checkbox" data-cfinsel="' + a.id + '"' + (FINSEL[a.id] ? ' checked' : '') + ' aria-label="' + esc(C.nameOf(a.username)) + ' 고르기"></td>' +
            C.orgCell(a.username, true) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span></td>' +
            '<td><span class="st ok">결재 완료</span>' + (C.prints ? '<div class="prline">' + C.prints.badge('card', a) + '</div>' : '') + '</td>' +
            // 1280 에서 표가 칸보다 넓던 것(2026-10-20 AU6-M3, 개인경비와 같게): 날짜 「MM.DD HH:MM」 · 결재선 두 줄 말줄임 · 단추 셋은 「⋯」 하나
            '<td class="dim" style="white-space:nowrap"' + (a.closed_at ? ' title="결재 완료 ' + esc(C.vx.whenText(a.closed_at)) + '">' + esc(finWhen(a.closed_at)) : '>—') + '</td>' +
            '<td class="n" data-l="건수">' + n0((a.snapshot || {}).n) + '</td><td class="n total" data-l="금액">' + n0((a.snapshot || {}).cost) + '</td>' +
            '<td class="el dim" data-l="결재선" title="' + esc(line) + '"><span style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden">' + esc(line) + '</span></td>' +
            '<td class="n ract" style="white-space:nowrap">' + C.kmenu(C.nameOf(a.username) + ' 님 결재 완료 문서', [
              ['data-cfzpdf="' + a.id + '"', 'PDF 받기'], ['data-cfzxlsx="' + a.id + '"', '엑셀 받기'],
              ['data-appr="reopen" data-kind="card" data-id="' + a.id + '"', '정정 열기', true]]) + '</td></tr>';
        }).join('');
      }).join('') + '</tbody><tfoot><tr><td></td><td colspan="5">결재 완료 ' + n0(done.length) + '명 합계</td><td class="n total">' + n0(total) + '</td><td colspan="2"></td></tr></tfoot></table></div></div>'
      : C.blank('아직 결재가 끝난 건이 없습니다.', '결재가 끝나면 여기에 모입니다.', 'stamp'));
    if (going.length) {
      h += C.sect('결재 중', n0(going.length) + '명', '', '<div class="panel"><div class="scroll" data-rows><table class="rcard ftab"><thead><tr><th>파트·센터</th><th>이름</th><th>상태</th><th>날짜</th><th class="n">건수</th><th class="n">금액</th><th>지금 차례</th><th></th></tr></thead><tbody>' +
        C.orgGroups(going, function (a) { return a.username; }, true).map(function (g) { return C.orgGroupRow(g, 8, '') + g.list.map(function (a) {
          var cur = (a.steps || []).filter(function (s) { return s.seq === a.cur_seq; })[0] || {};
          return '<tr>' + C.orgCell(a.username, true) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span></td><td><span class="st warn">결재 중</span></td>' +
            '<td class="dim">' + (a.submitted_at ? '상신 ' + esc(C.vx.whenText(a.submitted_at)) : '') + '</td>' +
            '<td class="n" data-l="건수">' + n0((a.snapshot || {}).n) + '</td><td class="n" data-l="금액">' + n0((a.snapshot || {}).cost) + '</td><td data-l="지금 차례">' + esc(cur.approver ? C.stepText(cur) : '—') + '</td>' +
            '<td class="n ract"><button class="btn sm" data-appr="force_reject" data-kind="card" data-id="' + a.id + '">관리자 반려</button></td></tr>';
        }).join(''); }).join('') + '</tbody></table></div></div>');
    }
    if (back.length || notYet.length) {
      var todo = back.map(function (a) { return { u: a.username, st: a.status === 'rejected' ? '반려' : '미상신(회수함)' }; }).concat(notYet.map(function (u) { return { u: u, st: '미상신' }; }));
      h += C.sect('챙겨야 할 사람', n0(todo.length) + '명', '', '<div class="panel"><div class="scroll" data-rows><table class="ftab"><thead><tr><th>파트·센터</th><th>이름</th><th>상태</th><th class="n">이번 달 카드</th></tr></thead><tbody>' +
        C.orgGroups(todo, function (x) { return x.u; }, true).map(function (g) {
          return C.orgGroupRow(g, 4, '') + g.list.map(function (x) {
            var p = by[x.u] || { n: 0, sum: 0 };
            return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td><td><span class="st ' + (x.st === '반려' ? 'bad' : 'warn') + '">' + esc(x.st) + '</span></td>' +
              '<td class="n">' + n0(p.n) + '건 · ' + won(p.sum) + '</td></tr>';
          }).join('');
        }).join('') + '</tbody></table></div></div>');
    }
    return h;
  }
  function finCsv() {
    var S = C.state(), done = cycAppr().filter(function (a) { return a.status === 'approved' && C.orgMatch(a.username); });
    var out = [['이름', '아이디', '소속', '결재 완료', '건수', '금액 합계', '결재 번호']], tn = 0, tc = 0;
    done.forEach(function (a) {
      var s = a.snapshot || {}, op = C.orgPath(a.username);
      tn += Number(s.n) || 0; tc += Number(s.cost) || 0;
      out.push([C.nameOf(a.username), a.username, [C.orgName(op), op.unit].filter(Boolean).join(' · '), a.closed_at ? C.vx.whenText(a.closed_at) : '', Number(s.n) || 0, Number(s.cost) || 0, a.id]);
    });
    out.push(['합계', '', '', '', tn, tc, '']);
    C.saveBlob(new TextEncoder().encode(csvText(out)), '법인카드_결재완료_금액요약_' + S.CYCKEY + scopeSuffix() + '.csv', 'text/csv;charset=utf-8');
    C.toast('요약표를 내려받습니다(' + n0(done.length) + '명).');
  }
  /** 고른 결재 완료 건을 PDF 한 파일로 — 한 사람씩 고정본으로 만든 뒤 이어 붙인다(한 번에 20명까지). */
  function finBundle() {
    var S = C.state();
    var list = Object.keys(FINSEL).map(apprById).filter(function (a) { return a && a.status === 'approved' && finVisible(a); })   // 보이는 줄만(2026-10-14)
      .sort(function (x, y) { return C.nameOf(x.username).localeCompare(C.nameOf(y.username), 'ko'); });
    if (!list.length || FINJOB) return;
    if (list.length > 20) { C.toast('한 번에 20명까지 묶을 수 있습니다(지금 ' + list.length + '명). 나눠서 골라 받아 주세요.', true); return; }
    var job = FINJOB = {};
    C.openPanel('법인카드 결재 완료본 묶어 받기', cycName(S.CYCKEY) + ' · ' + n0(list.length) + '명',
      '<div class="pdfwait"><div class="spin"></div><div id="cFinNote" role="status">준비하는 중…</div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
    var note = function (t) { var el = $('cFinNote'); if (el) el.textContent = t; };
    var alive = function () { if (FINJOB === job && !$('cFinNote')) { FINJOB = null; C.render(); } return FINJOB === job; };
    var parts = [], skipped = [], checks = [], partIds = [];   // partIds — 묶음에 실제로 들어간 결재 건(출력 기록용)
    var one = function (i) {
      if (i >= list.length || !alive()) return Promise.resolve();
      var a = list[i];
      note((i + 1) + ' / ' + list.length + ' · ' + C.nameOf(a.username) + ' 님 문서를 만드는 중…');
      return fetchFrozen(a).then(function (fz) {
        if (!fz) { skipped.push(C.nameOf(a.username)); return; }
        var d = frozenDoc(a, fz);
        return C.fillSigns(d).then(C.vx.ensureLibs).then(function (lib) {
          return window.SheetPdf.buildCard(d, { PDFLib: lib.PDFLib, fontkit: lib.fontkit, fontRegular: lib.fontRegular, fontBold: lib.fontBold });
        }).then(function (res) {
          parts.push(res.bytes); partIds.push(a.id);
          var sum = (res.totals[0] || {}).all || 0, exp = (a.snapshot || {}).cost;
          if (exp != null && Math.round(sum) - Math.round(Number(exp)) !== 0) checks.push(d.person.name + ' — 문서 합계 ' + n0(sum) + '원 ≠ 결재 금액 ' + n0(exp) + '원');
        });
      }).catch(function () { skipped.push(C.nameOf(a.username)); }).then(function () { if (alive()) return one(i + 1); });
    };
    one(0).then(function () {
      if (!alive()) return null;
      if (!parts.length) throw new Error('만든 문서가 없습니다');
      note('한 파일로 묶는 중…');
      var P = window.PDFLib;
      return P.PDFDocument.create().then(function (out) {
        var chain = Promise.resolve();
        parts.forEach(function (b) {
          chain = chain.then(function () { return P.PDFDocument.load(b); }).then(function (src) { return out.copyPages(src, src.getPageIndices()); })
            .then(function (pages) { pages.forEach(function (pg) { out.addPage(pg); }); });
        });
        return chain.then(function () { out.setTitle('법인카드 지출결의 결재 완료본 ' + cycName(S.CYCKEY)); return out.save(); })
          .then(function (bytes) { return { bytes: bytes, pages: out.getPageCount() }; });
      });
    }).then(function (res) {
      if (FINJOB !== job) { C.render(); return; }
      FINJOB = null;
      if (!res || !$('cFinNote')) { C.render(); return; }
      var blob = new Blob([res.bytes], { type: 'application/pdf' }), url = URL.createObjectURL(blob);
      C.vx.setPdfUrls([url]);
      var file = '법인카드_결재완료_' + S.CYCKEY + '_' + parts.length + '명.pdf';
      $('pBody').innerHTML = '<div class="pdfdone"><div class="big">' + n0(res.pages) + '<small>쪽</small></div><div class="dim">' + (blob.size / 1e6).toFixed(1) + ' MB · ' + n0(parts.length) + '명 결재 완료본</div>' +
        (skipped.length ? '<div class="awarn">' + ic('alert', 15) + '<span>만들지 못한 사람: ' + esc(skipped.join(', ')) + ' — 한 사람씩 「PDF」로 다시 받아 주세요.</span></div>' : '') +
        (checks.length ? '<div class="awarn">' + ic('alert', 15) + '<span>확인 필요: ' + esc(checks.join(' · ')) + '</span></div>' : '') +
        (!skipped.length && !checks.length ? '<div class="pdfok">' + ic('check', 15) + '<span>모두 묶었습니다 — 합계 점검 이상 없음</span></div>' : '') + '</div>';
      $('pFoot').innerHTML = '<span style="flex:1"></span><button class="btn" data-close>닫기</button><a class="btn" href="' + url + '" download="' + esc(file) + '">' + ic('dl', 14) + '내려받기</a>' +
        '<a class="btn pri" href="' + url + '" target="_blank" rel="noopener">열기 · 인쇄</a>';
      if (C.prints) C.prints.bindOut($('pFoot'), 'card', partIds, url);    // 묶은 사람마다 한 번씩 출력 기록
      C.render();
    }).catch(function (e) {
      if (FINJOB !== job) return;
      FINJOB = null;
      if ($('cFinNote')) $('pBody').innerHTML = '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(failMsg('PDF 한 파일로 묶지 못했습니다', e, '새로 고침 뒤 다시 해 주세요.')) + '</span></div>';
      C.render();
    });
    C.render();
  }

  /* ══════════════════ 이벤트 ══════════════════ */
  document.addEventListener('click', function (e) {
    var el;
    if (FINJOB && e.target.closest('[data-close]') && $('cFinNote')) { FINJOB = null; setTimeout(function () { C.render(); }, 0); }
    if (e.target.closest('[data-cup]')) { openUpload(); return; }
    if (e.target.closest('#btnCUpGo')) { runUpload(); return; }
    if ((el = e.target.closest('[data-csug]'))) {
      var inp = document.querySelector('.cin[data-cid="' + el.dataset.csug + '"][data-f="category"]');
      if (inp && !inp.disabled) { inp.value = el.dataset.cat; inp.classList.remove('need'); saveCell(el.dataset.csug, 'category', el.dataset.cat); el.remove(); paintSug(); }
      return;
    }
    if (e.target.closest('[data-csugall]')) { fillSuggest(); return; }
    if (e.target.closest('[data-cretry]')) { retrySaves(); return; }
    if ((el = e.target.closest('[data-cdel]'))) { openDel(el.dataset.cdel); return; }
    if ((el = e.target.closest('#btnCDelGo'))) { if (!el.disabled) runDel(el.dataset.id); return; }
    if (e.target.closest('[data-creload]')) { ITEMS = {}; C.render(); return; }
    if (e.target.closest('[data-cvrun]')) { runCheck(); return; }
    if ((el = e.target.closest('[data-cvfix]'))) { var it = VITEMS[+el.dataset.cvfix], ref = (it && it.ref && it.ref.items) || []; if (ref.length) focusRow(ref[0]); return; }
    if (e.target.closest('[data-cgoblank]')) { var bid = firstBlankId(); if (bid != null) focusRow(bid); return; }
    if (e.target.closest('[data-cpdf]')) { pdfMine(); return; }
    if ((el = e.target.closest('[data-cpdfok]'))) {
      setPreviewed(el.dataset.cpdfok, true);
      C.closePanel();
      if (C.state().VIEW !== 'c_verify') C.go('c_verify'); else C.render();
      // 이름대로 바로 상신 창을 연다(2026-10-15 매뉴얼 로봇: 창만 닫혀 한 번 더 눌러야 했다). 아직 못 누르는 상태면 그 단추로 데려간다.
      setTimeout(function () { var b = document.getElementById('btnOpenSubmit'); if (b) { try { if (!b.disabled) b.click(); else { b.focus(); b.scrollIntoView({ block: 'center', behavior: (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') }); } } catch (er) { } } }, 60);
      return;
    }
    if ((el = e.target.closest('[data-cfzpdf]'))) { pdfFrozen(el.dataset.cfzpdf); return; }
    if ((el = e.target.closest('[data-cfzxlsx]'))) { xlsxFrozen(el.dataset.cfzxlsx); return; }
    if ((el = e.target.closest('[data-cfzverify]'))) {
      var a = apprById(el.dataset.cfzverify), f = a && FZSUM[fzKey(a)];
      if (f && f.verify) C.vx.showItems(C.nameOf(a.username) + ' 법인카드 검증 결과', cycName(a.cycle) + ' · 상신 시점', vOf(f.verify, Date.parse(f.verify.ran_at || f.frozen_at)), a.username !== C.myName());
      return;
    }
    if (e.target.closest('[data-cblank]')) { CL.blank = !CL.blank; C.render(); return; }
    if (e.target.closest('[data-cclear]')) { CL = { cat: '', who: '', blank: false }; C.render(); return; }
    if (e.target.closest('[data-ccsv]')) { listCsv(); return; }
    if ((el = e.target.closest('[data-cperson]'))) { var who = el.dataset.cperson; C.go('ca_list'); CL = { cat: '', who: who, blank: false }; C.render(); return; }
    if (e.target.closest('[data-cfinpdf]')) { finBundle(); return; }
    if (e.target.closest('[data-cfincsv]')) { finCsv(); return; }
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('cin')) queueSave(t, false);
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('cin')) { queueSave(t, true); return; }
    if (t.id === 'cFile') { var f = t.files && t.files[0]; t.value = ''; readFile(f); return; }
    if (t.id === 'cOwn') { if (CUP && CUP.res) { CUP.useOwner = t.checked; replan(CUP); paintPreview(); } return; }
    if (t.id === 'cCancelDel') { if (CUP && CUP.res) { CUP.delCancel = t.checked; paintPreview(); } return; }     // 전액 취소된 승인 같이 지우기(2026-10-20)
    if (t.id === 'cWho') { CL.who = t.value; C.render(); var w = $('cWho'); if (w) w.focus(); return; }
    if (t.id === 'cCat') { CL.cat = t.value; C.render(); var w2 = $('cCat'); if (w2) w2.focus(); return; }
    if (t.matches && t.matches('[data-cfinsel]')) { if (t.checked) FINSEL[t.dataset.cfinsel] = 1; else delete FINSEL[t.dataset.cfinsel]; C.render(); return; }
    if (t.id === 'cFinAll') {
      // 보이는 줄만(2026-10-14 — 「출력 안 한 것만」이 켜져 있으면 출력 안 한 문서만 고른다)
      cycAppr().forEach(function (a) { if (a.status === 'approved' && C.orgMatch(a.username) && finVisible(a)) { if (t.checked) FINSEL[a.id] = 1; else delete FINSEL[a.id]; } });
      C.render();
    }
  });
  function finVisible(a) { return !C.prints || C.prints.keep('card', a); }

  var K0 = {
    tag: '법인카드', mode: 'c',
    rows: function () { return CAPPR || []; },
    mine: function (cyc) { return myC(cyc); },
    reload: function () { var S = C.state(); dropItems(S.CYCKEY); return Promise.all([loadAppr(), loadItems(S.CYCKEY, false, true)]); },
    sumLine: function (a) { var s = a.snapshot || {}; return s.cost != null ? n0(s.n) + '건 · ' + won(s.cost) : ''; },
    sumHtml: sumHtml,
    extra: extra,
    previewBytes: previewBytes,
    wantSummaries: wantSums,
    cycName: function (a) { return cycName(a.cycle) + ' (' + R.span(a.cycle) + ') · 법인카드 지출결의'; },
    cycLabel: function (a) { return cycName(a.cycle) + ' (' + R.span(a.cycle) + ')'; },
    submitHead: function () {
      var S = C.state(), rows = mineRows(S.CYCKEY), T = R.totals(rows), warn = [], bl = R.blankRows(rows);
      if (!rows.length) warn.push('이 기간에 올린 카드 내역이 없습니다 — 먼저 ERP 엑셀을 올려 주세요');
      if (bl) warn.push('구분·사용목적이 빈 줄 ' + n0(bl) + '건 — 채워야 상신됩니다');
      return { title: cycName(S.CYCKEY) + ' 법인카드 상신', sub: R.span(S.CYCKEY) + ' · ' + n0(T.n) + '건 · ' + won(T.cost), warn: warn };
    },
    rangeHi: function () { return rangeHiMs(C.state().CYCKEY); },
    beforeSubmit: beforeSubmit,
    verifyView: 'c_verify',
    withdrawText: '이 기간의 카드 내역(구분·사용목적)을 다시 고칠 수 있게',
    earlyNoun: '카드 내역을 더 올리거나',
    lockNoun: '카드 내역을'                 // 상신 창 「상신 뒤에는 이 기간의 카드 내역을 고칠 수 없습니다」
  };
  return {
    views: { c_month: viewMonth, c_verify: viewVerify, ca_close: viewAdminClose, ca_list: viewAdminList, ca_final: viewAdminFinal, ca_people: viewAdminPeople },
    admin: ADMIN_C,
    orgbar: ADMIN_C,
    orgUsers: orgUsers,
    kinds: { card: K0 },
    // range·status: 마감 뒤 며칠(GRACE_DAYS) 동안 처음 보일 기간·마감 띠(driving-app.js defCyc·graceBand, 2026-10-20)
    period: { mode: 'c', views: CVIEWS, current: cCurrent, span: cSpan, band: band, tag: tag, range: cRange,
      status: function (k) { var a = myC(k); return a ? a.status : ''; },
      row: function (k) { return myC(k) || null; } },          // 포털 한 줄이 정정 열기를 「정정 중」으로 가른다(2026-10-21)
    load: loadWith,
    onGo: function (v, prev) {
      if (v === 'c_verify') CFRESH = {};          // 검증 화면에 들어올 때마다 ① 검증하기부터(운행일지·개인경비와 같게, 2026-10-20 V3 U9)
      if (v === 'ca_list' && prev !== 'ca_close' && prev !== 'ca_people') CL = { cat: '', who: '', blank: false };
      if (ADMIN_C.indexOf(v) >= 0 && isAdmin()) loadItems(C.state().CYCKEY, true);
    },
    onCycle: function () { MISSING = {}; FINSEL = {}; FAILED = {}; LAST_SAVE = 0; },
    dirty: function () {
      if (C_SENDING || pending()) return true;
      if ($('cDrop') && CUP && CUP.plan && !CUP.sent) return true;
      return false;
    }
  };
});
