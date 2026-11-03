/* ═══════════════════════════════════════════════════════════════════════════
   drv-card.js — 법인카드 지출결의 (2026-10-09, docs/card/SPEC.md §4)
   ---------------------------------------------------------------------------
   운행일지·개인경비에 이은 세 번째 결재 문서. 결재 방식(결재란·결재선·결재함·PDF 확인·정정 열기)은 같고,
   상신 창·결재함·결재 확인 창은 driving-app.js 의 것을 kind:'card' 로 부른다.
   ★ 기간은 달력 한 달: 1일 00:00 ~ 말일 24:00(KST). '2026-07' = 「2026년 7월분」 = 07.01 – 07.31.
   ★ 자료는 직원이 ERP 에서 받은 자기 카드 승인내역 엑셀(card-erp.js 가 읽는다 — SheetJS 는 올리기 창을 열 때만 싣는다).
     손으로 적는 칸은 구분·사용목적·비고뿐. 칸을 고치면 바로 저장한다(화면을 다시 그리지 않는다 — 커서가 튀지 않게).
   ★ 구분·사용목적이 빈 줄이 있으면 상신하지 못한다(beforeSubmit {blocked} + 서버 CARD_INCOMPLETE). 나머지 검증은 표시만.
   ★ 검증(2026-10-12): 「검증하기」 = expense-ai op card_review(서버가 줄을 읽어 규칙 C01~C10 + Gemini C07·C08, card_verifications 에 저장).
     서버·Gemini 를 못 쓰면 브라우저 규칙(card-rules.js — 서버 _shared/card-verify.ts 와 같은 판정)만 + 「AI 검증을 하지 못해 규칙으로만 검증했어요」(AI_FAIL).
     Gemini 는 표시만 한다(warn). 상신을 막는 것은 빈칸(C01·C02)뿐. 사진 없음.
   ★ 식대 13,000원(2026-11-02 docs/meal-note/SPEC.md §4): 13,000원 넘는 식사 줄인데 비고에 이름·사유가 없으면 이번 달 표의 비고 칸을 주황 점선(want)으로 —
     판정은 card-rules.js(needsMealNote — 서버 C10 과 같은 판정). 칸에 적는 대로 바로 사라진다(paintMeal). 막지 않는다.
   ★ 저장(2026-10-12 → 2026-10-15): 칸은 자동 저장 + 표 위 저장 상태 줄(자동 저장됨·저장 중…·저장 못 함 N곳).
     「임시저장」 단추는 뺐다(2026-10-15 화면 정리) — 저장이 실패했을 때만 상태 줄에 「다시 저장」(그때 적은 값을 다시 보냄).
   ★ 다시 올리기는 ERP 칸만 upsert(CardErp.toRow) — 적어 둔 구분·사용목적·비고는 그대로, 파일에 없는 줄은 표시만.
   ★ 추가 상신(2026-11-03, docs/card-multi/SPEC.md §5): 한 사람·한 달에 문서 여럿 — 문서 하나 = 카드 한 장. 줄은 card_items.approval_id 로 문서에 묶이고
     잠김은 줄마다(살아 있는 문서에 묶인 줄 · 살아 있는 여러 카드 예전 문서가 있는 달은 전부). 이번 달 표는 카드별 묶음 · 검증·상신은 고른 대상(카드) 줄만 ·
     문서 이름은 「10월분 · 카드 끝 1234(· 추가 1)」(card-rules.js docName — 카드번호 전체는 이름·DOM·저장소 열쇠 어디에도 넣지 않는다).
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

  /* ── 식대 13,000원 → 비고 칸 안내(2026-11-02 docs/meal-note/SPEC.md §1~§4) ──
     판정은 card-rules.js 의 needsMealNote(식사 낱말 구분 · 회식·접대·협의·회의 뺌 · 줄 금액 > 13,000 · 비고가 비었거나 「외 N명」·인원수뿐 —
     서버 card-verify.ts C10 과 같은 판정, card-parity 시험)를 그대로 부른다. 화면 글은 개인경비 drv-expense.js 와 같은 글자.
     앞 판 card-rules.js 와 섞여 실려도(배포 직후 캐시) 죽지 않게 — 함수가 없으면 안내 없음.
     빈 비고 칸 자리 글은 짧게 「이름·사유」(2026-11-02 고침 1차 — PC 표 비고 칸(92~120px)에 끝까지 들어가게, 칸 폭은 그대로).
     안내 글 전체(SPEC §4)는 PC 는 칸의 title, 폰·태블릿 카드는 칸 아래 줄. */
  var MEAL_PH = '이름·사유';
  var MEAL_HINT_EMPTY = '13,000원이 넘는 식사예요. 비고에 함께한 분 이름을 모두(혼자면 사유) 적어 주세요.';
  var MEAL_HINT_COUNT = '‘외 N명’이나 인원수 대신 함께한 분 이름을 모두 적어 주세요.';
  /** 비고 안내 글 — 안내가 필요 없는 줄이면 ''. 비고가 비었으면 첫째 글, 「외 N명」·인원수만이면 둘째 글. x = { category, amount, note } */
  function mealHint(x) {
    if (!R.needsMealNote || !R.needsMealNote(x)) return '';
    var s = String(x.note == null ? '' : x.note);
    return (s.normalize ? s.normalize('NFKC') : s).trim() ? MEAL_HINT_COUNT : MEAL_HINT_EMPTY;
  }
  /** 비고가 비어 있으면 안내가 필요한 줄인가(13,000원 넘는 식사 줄) — 빈 비고 칸의 placeholder 를 정한다. */
  function mealWants(x) { return !!R.needsMealNote && R.needsMealNote({ category: x.category, amount: x.amount, note: '' }); }
  /** 안내 글을 HTML 로 — 짝말·괄호를 한 덩이로(줄 끝에 「주세요.」만, 「(혼자면 / 사유)」로 갈리지 않게, 2026-11-02 화면 검토 U-L1·L2).
   *  개인경비 drv-expense.js hintHtml 과 같은 글자. 글은 위 상수뿐(사용자 글 아님). */
  function hintHtml(s) {
    return esc(s).replace('‘외 N명’', '‘외&nbsp;N명’').replace(' 주세요', '&nbsp;주세요')
      .replace('(혼자면 사유)', '<span style="white-space:nowrap">(혼자면 사유)</span>');
  }

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
  /** 줄 잠금(CARD_LOCKED — DB 트리거 card_items_lock) 때 할 말(2026-11-03 SPEC §5-1). 칸 저장·지우기가 0행이어도 같은 뜻으로 본다.
   *  그 줄의 문서를 알면 상태대로(lockSayFor — 고침 1 L3: 결재가 끝난 문서에는 「회수하거나 반려받은 뒤」를 말하지 않는다), 모르면 두 경우를 다 말한다. */
  var LOCK_SAY = '결재 중이거나 결재가 끝난 문서에 든 줄이라 고칠 수 없어요. 결재 중이면 그 문서를 회수하거나 반려받은 뒤, 결재가 끝났으면 관리자에게 정정을 요청해 고쳐 주세요.';
  function lockSayFor(a) {
    if (!a) return LOCK_SAY;
    if (a.status === 'approved') return '결재가 끝난 문서에 든 줄이라 고칠 수 없어요. 정정이 필요하면 관리자에게 문의해 주세요.';
    if (a.status === 'submitted') return (a.steps || []).some(function (x) { return x && x.result; })
      ? '결재 중인 문서에 든 줄이라 고칠 수 없어요. 이미 승인한 결재자가 있어 회수할 수 없어요. 고치려면 지금 차례인 결재자에게 반려를 요청하세요.'
      : '결재 중인 문서에 든 줄이라 고칠 수 없어요. 고치려면 그 문서를 회수한 뒤 고쳐 주세요.';
    return LOCK_SAY;
  }
  /** 서버 오류를 사람 말로. 잠금(CARD_LOCKED)은 따로 말한다 — it = 그 줄(알면 그 줄의 문서 상태대로). */
  function why(e, it) {
    var m = String((e && e.message) || '');
    if (/CARD_LOCKED/.test(m)) return lockSayFor(docOfLine(it));
    if (/CARD_ATTACH/.test(m)) return '결재 문서에 묶는 칸은 상신만 써요. 새로고침한 뒤 다시 해 주세요.';
    if (/401|403|jwt|로그인/i.test(m)) return '로그인이 만료됐거나 권한이 없어요. 다시 로그인해 주세요.';
    if (/23505|duplicate/i.test(m)) return '같은 승인번호·승인일 줄이 이미 있어요. 목록을 다시 불러와 주세요.';
    if (/23514|check constraint/i.test(m)) return '칸 길이나 금액 범위를 넘었어요. 구분은 20자, 사용목적·비고는 200자까지 적을 수 있어요.';
    console.error('법인카드:', m);
    return '잠시 후 다시 해 주세요.';
  }
  function failMsg(head, e, tail) {
    var m = String((e && e.message) || '');
    if (m) console.warn(head, m);
    // 원인은 쌍점 대신 다음 문장으로(2026-10-24 검수 — 「저장하지 못했어요: …」는 문장 속 쌍점), 끝 마침표는 한 번만
    var mm = m.trim();
    return /[가-힣]/.test(mm) && !/https?:\/\/|HTTP \d/.test(mm) ? head + '. ' + mm + (/[.!?…]$/.test(mm) ? '' : '.') : head + '. ' + tail;
  }

  /* ══════════════════ 자료 ══════════════════ */
  var ITEMS = {};          // 'me|2026-07' · 'all|2026-07' → { rows } | { err } | { wait }
  var CAPPR = null;        // 카드 결재 건 전부(RLS 가 거른 것). 행마다 _kind = 'card'
  //   (2026-11-03 추가 상신) 그 달 통째 잠금(card_cycle_locked)은 부르지 않는다 — 잠김은 줄마다(lineLocked, 결재 목록으로 안다)
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
  // 쪽 서명과 함께 받기(본체 C.fetchAllSig, 2026-11-02 nav-refresh 고침 1차 N3) — 조용히 새로 받기가 넣어 둔 것과 같은 글인지 본다(JSON 으로 견주지 않는다).
  //   memo — 넣어 둔 자료를 받을 때의 쪽 서명: 그대로면 { same: true }. 서명이 없는 본체(옛 driving-app.js)면 fetchAll 그대로(늘 넣는다)
  function sigAll(path, signal, memo) {
    if (C.fetchAllSig) return C.fetchAllSig(path, { signal: signal, memo: memo || null });
    return C.fetchAll(path).then(function (rows) { return { rows: rows }; });
  }
  function itemsUrl(cyc, all, u) {
    return '/rest/v1/card_items?select=*&cycle=eq.' + encodeURIComponent(cyc) +
      (all ? '' : '&username=eq.' + encodeURIComponent(u || me())) + '&order=appr_date.asc,appr_time.asc,id.asc';
  }
  var APPR_URL = '/rest/v1/card_approvals?select=*&order=submitted_at.desc,id.desc';     // id 둘째 열쇠 — 나눠 받을 때 겹침·빠짐 없게(2026-10-20)
  // 늦게 출발한 받기가 이긴다(아래 결재 목록 LA_SEQ 와 같게, 2026-11-03 T7-6) — 먼저 출발해 늦게 끝난 줄 받기가 새로 받는 중인 자리(wait)를 덮으면
  //   붙잡은 대상(PIN)을 새 줄이 오기 전의 줄로 판단했다. 늦은 받기는 부른 쪽에 줄을 돌려주기만 하고 ITEMS 에는 넣지 않는다.
  //   keep = 받는 동안 지금 줄을 그대로 둔다(화면이 뼈대로 바뀌지 않게 · 못 받으면 지금 줄 그대로 — 잠김 다시 보기·「다시 저장」, 회귀 N2).
  //   받는 중({rows, wait})에는 bothIn 이 「모름」으로 본다 · 조용히 새로 받기(loadQuiet)도 받지 않는다(그것이 더 새것).
  //   pages — 받은 글의 쪽 서명(조용히 새로 받기가 견준다, N3). keep 으로 둔 줄은 그 줄을 만든 글의 서명도 그대로 둔다.
  //   ★ (2026-11-03 card_cycle_locked 는 부르지 않는다 — 추가 상신은 잠김을 줄마다 결재 목록으로 안다, lineLocked)
  var IT_SEQ = {};
  function loadItems(cyc, all, force, keep) {
    var k = itemKey(all, cyc), old = ITEMS[k];
    if (!force && old && (old.rows || old.wait)) return old.wait || Promise.resolve(old.rows);
    var seq = IT_SEQ[k] = (IT_SEQ[k] || 0) + 1, kept = keep && old && old.rows ? old.rows : null, kp = kept ? old.pages : undefined;
    var p = sigAll(itemsUrl(cyc, all))
      .then(function (x) {
        var rows = (x.rows || []).sort(byDate);
        if (IT_SEQ[k] !== seq) return rows;
        ITEMS[k] = { rows: rows, pages: x.pages };
        if (!all) { pruneFailed(cyc); pinCheck(); }
        return rows;
      })
      .catch(function (e) {
        if (IT_SEQ[k] !== seq) return null;
        ITEMS[k] = kept ? { rows: kept, pages: kp } : { err: (e && e.authGone) ? '로그인이 만료됐어요.' : (e && e.noPerm) ? '법인카드 내역을 볼 권한이 없어요.' : '법인카드 내역을 불러오지 못했어요.' };
        return null;
      });
    ITEMS[k] = kept ? { rows: kept, pages: kp, wait: p } : { wait: p };
    return p;
  }
  // 늦게 출발한 받기가 이긴다 — 먼저 출발해 늦게 끝난 받기(결재함 새로 받기)가 결재 뒤 받은 새 목록을 덮지 않게(2026-11-02 검증 로봇 M3)
  //   loadAppr 는 출발할 때 표(LA_SEQ)를 올린다 · 조용히 새로 받기(loadQuiet)는 올리지 않고 출발 때의 표만 기억해 넣을 때 그대로면 올리고 넣는다(고침 1차 N1).
  //   CAPPR_SIG — 지금 CAPPR 를 만든 받은 글의 쪽 서명(그 목록 객체와 함께 — 다른 길이 목록을 바꿨으면 무효)
  var LA_SEQ = 0, CAPPR_SIG = null;
  // 결재 목록을 마지막에 받지 못했는가(2026-11-03 고침 1 M1) — 받지 못한 것은 「모름」이지 「문서 없음」이 아니다(본체 fetchAll 의 5xx 규칙과 같은 생각).
  //   모르는 동안은 묶인 줄을 잠근 것으로 보고, 상신 대상을 비우고(상신 단추 없음), 검증·상신·이번 달 화면에 「다시 불러오기」를 보인다.
  var CAPPR_ERR = false;
  // 마지막으로 끝난 결재 목록 받기 번호 · 마지막에 떠난 받기(T7-6) — LA_DONE < LA_SEQ 면 받는 중(붙잡은 대상을 판단하지 않는다).
  //   조용히 새로 받기가 결재 목록을 넣을 때(표를 올리며)도 끝난 받기로 친다(loadQuiet commit — LA_DONE = LA_SEQ, 2026-11-03 합치기).
  var LA_DONE = 0, LA_P = null;
  function loadAppr() {
    var seq = ++LA_SEQ;
    LA_P = sigAll(APPR_URL)
      .then(function (x) {
        if (seq !== LA_SEQ) return;
        LA_DONE = seq;
        CAPPR = (x.rows || []).map(function (a) { a._kind = 'card'; return a; });
        CAPPR_SIG = { pages: x.pages, obj: CAPPR };
        CAPPR_ERR = false;
        pinCheck();
        bandHeal();             // 「결재 목록을 불러오지 못했어요」 띠가 화면에 남았으면 지금 자료로(2026-11-03 최종 검토 L1)
      })
      .catch(function () { if (seq !== LA_SEQ) return; LA_DONE = seq; CAPPR_ERR = true; if (!CAPPR) CAPPR = []; });   // 결재함(본체)은 빈 목록으로 그대로 돈다
    return LA_P;
  }
  /** 결재 목록을 안다(받았고, 마지막 받기가 실패하지 않았다). */
  function apprKnown() { return CAPPR !== null && !CAPPR_ERR; }
  /** 결재 목록 실패 띠(#cApprErr — apprErrBand)가 화면에 남았는데 이제 결재 목록을 안다 — 띠를 거둘 다시 그리기가 필요하다. */
  function bandStale() { return !CAPPR_ERR && !!$('cApprErr'); }
  /** 결재 목록을 받은 뒤(loadAppr) — 띠가 남았으면 그 카드 화면을 다시 그린다(2026-11-03 최종 검토 L1: 탭 복귀(60초 넘음)는 apprRefresh 가 결재 목록을 받아도
   *  카드 화면을 다시 그리지 않고, 함께 도는 조용히 받기는 결재 목록을 빼고 받아(noAppr) 띠·「다시 불러오기」가 남았다 — 화면을 옮겨야 걷혔다).
   *  지금 그리면 안 되면(칸에 쓰는 중·한글 조합·창이 열림·적어 두고 저장하지 않은 글 — 본체 navHold, 조용히 받기와 같은 규칙) 그리지 않는다 —
   *  그때는 조용히 받기가 맡아 둔 것을 넣을 때(loadQuiet commit 이 띠가 남았으면 바뀐 것으로 친다) 본체가 다시 그린다. */
  function bandHeal() {
    if (!bandStale() || CVIEWS.indexOf(C.state().VIEW) < 0) return;
    var a = document.activeElement;
    // navHold 가 없는 앞 판 본체(배포 직후 캐시)면 — 칸에 쓰는 중 · 창이 열림 · 입력 칸에 초점(한글 조합은 초점이 있는 칸에서만 일어난다)
    var held = C.navHold ? !!C.navHold() : (typing() || $('panel').classList.contains('open') || !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
    if (!held) C.render();
  }
  /** 그 기간 내 줄과 결재 목록을 둘 다 받아 둔 채(받는 중인 것 없음)인가 — 붙잡은 대상은 이때만 판단한다(T7-6: 줄을 다시 받는 중에
   *  결재 목록이 먼저 오면 「줄 없음」으로 보고 창을 닫았다). 줄을 아직 안 받았거나·받는 중·못 받음 = 모름(「줄 없음」이 아니다). */
  function bothIn(cyc) {
    var x = ITEMS[itemKey(false, cyc)];
    return apprKnown() && LA_DONE === LA_SEQ && !!x && !!x.rows && !x.wait;
  }
  /** 결재 목록·그 기간 내 줄 받기가 모두 끝날 때까지(기다리는 사이 새 받기가 또 떠나면 그것까지, 몇 번까지만). */
  function settledFor(cyc, n) {
    var x = ITEMS[itemKey(false, cyc)], w = [];
    if (LA_DONE !== LA_SEQ && LA_P) w.push(LA_P);
    if (x && x.wait) w.push(x.wait);
    if (!w.length || (n || 0) >= 5) return Promise.resolve();
    return Promise.all(w).then(function () { return settledFor(cyc, (n || 0) + 1); }, function () { return settledFor(cyc, (n || 0) + 1); });
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
  /** 조용히 다시 받기(2026-11-02 docs/nav-refresh/SPEC.md — 본체가 화면을 옮길 때·탭으로 돌아올 때 loadWith(true, { silent: true, signal, noAppr })).
   *  받는 동안 ITEMS·CAPPR 를 건드리지 않는다(뼈대 없이) — 다 받으면 { busy, commit } 을 돌려주고 넣을 때는 본체가 고른다.
   *  busy = 칸 저장이 기다리거나 보내는 중 · 파일을 올리는 중(그 칸을 저장 전 값으로 되돌리지 않게). commit() 은 그 사이 그 칸을 다시 받았거나 받는 중이면 덮지 않는다.
   *  결재 건은 출발 뒤 다른 받기가 출발하지도(LA_SEQ) 넣지도(CAPPR 객체) 않았을 때만 넣고 그때 표를 올린다 — 그 사이 따로 받기 시작했거나 넣었으면
   *  (결재·상신 뒤 다시 받기) 그것이 이긴다(고침 1차 N1). 그래서 「같은 글」(same)은 출발 때 목록과 같다는 뜻 그대로다.
   *  받은 글이 넣어 둔 것과 같으면(쪽 서명) 읽지도 넣지도 않는다(N3) · 받는 중인 칸은 받지 않는다. opt.signal — 멈추기 · opt.noAppr — 결재 건은 빼고(N8).
   *  ※ 칸 저장은 줄 객체를 그 자리에서 고친다(it[f]) — 저장이 되면 서버 글이 달라져 다음 받기에 새로 넣고, 안 되면 되돌려 받은 글과 같다.
   *  (2026-11-03 추가 상신과 합침) 잠김은 줄마다 결재 목록으로 안다 — card_cycle_locked 는 받지 않는다. 결재 목록을 넣으면 끝난 받기로 친다(LA_DONE · CAPPR_ERR —
   *  붙잡은 대상 bothIn 이 「받는 중」으로 남지 않게). 넣은 뒤 붙잡은 대상을 다시 본다(pinCheck — loadItems·loadAppr 가 넣을 때와 같은 규칙.
   *  상신 창이 열려 있으면 본체 navHold 가 넣기를 창을 닫을 때까지 미루므로 창이 붙잡은 대상은 조용히 바뀌지 않는다). */
  function loadQuiet(S, opt) {
    opt = opt || {};
    var cyc = S.CYCKEY, u = me(), all = isAdmin() && ADMIN_C.indexOf(S.VIEW) >= 0, a0 = LA_SEQ, sg = opt.signal;
    var km = itemKey(false, cyc), ka = itemKey(true, cyc), xm = ITEMS[km], xa = ITEMS[ka];
    var ap0 = CAPPR, am = CAPPR_SIG && CAPPR_SIG.obj === CAPPR ? CAPPR_SIG.pages : null;
    var q = function (a, x0) { return x0 && x0.wait ? null : sigAll(itemsUrl(cyc, a, u), sg, x0 && x0.rows ? x0.pages : null); };
    return Promise.all([
      opt.noAppr ? null : sigAll(APPR_URL, sg, am),
      q(false, xm), all ? q(true, xa) : null
    ]).then(function (o) {
      var put = function (k, x0, x) {
        if (!x || x.same || ITEMS[k] !== x0 || (x0 && x0.wait)) return false;   // 같은 글 · 그 사이 다시 받았거나 받는 중(그것이 더 새것)
        ITEMS[k] = { rows: (x.rows || []).slice().sort(byDate), pages: x.pages }; return true;
      };
      return {
        busy: function () { return pending() || C_SENDING; },
        commit: function () {
          if (me() !== u || C.state().CYCKEY !== cyc || pending() || C_SENDING) return false;
          var ch = false;
          if (o[0] && LA_SEQ === a0 && CAPPR === ap0) {                        // 출발 뒤 다른 받기가 출발하지도 넣지도 않았다 — 넣고 표를 올린다(M3 · N1)
            LA_SEQ++; LA_DONE = LA_SEQ;                                        // 끝난 받기(T7-6 bothIn) — 그 전에 떠난 받기는 늦은 것이라 버려진다
            if (CAPPR_ERR) { CAPPR_ERR = false; ch = true; }                    // 「결재 목록을 불러오지 못했어요」 띠를 거둔다(같은 글이어도 이제 안다)
            if (!o[0].same) { CAPPR = (o[0].rows || []).map(function (a) { a._kind = 'card'; return a; }); ch = true; }
            CAPPR_SIG = { pages: o[0].pages, obj: CAPPR };
          }
          if (put(km, xm, o[1])) { ch = true; pruneFailed(cyc); }
          if (all && put(ka, xa, o[2])) ch = true;
          // 결재 목록 실패 띠가 아직 화면에 남았다 — 결재 목록은 다른 길(탭 복귀 apprRefresh)이 받았는데 그때는 그리면 안 됐다(bandHeal) · 이 넣기와 함께 다시 그린다(L1)
          if (bandStale()) ch = true;
          if (ch) pinCheck();
          return ch;
        }
      };
    });
  }
  /** 운행일지 적재(loadAll)와 같이 돈다 — 결재 건과 지금 기간의 내 카드 내역. opt.silent = 조용히 다시 받기(loadQuiet — opt 를 그대로 넘긴다). */
  function loadWith(soft, opt) {
    var S = C.state();
    if (!S.ME) return null;
    if (opt && opt.silent) return loadQuiet(S, opt);
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
  /* ── 한 사람·한 달에 문서 여럿(2026-11-03 추가 상신, docs/card-multi/SPEC.md §1·§5-1) ──
     문서 하나 = 카드 한 장. 줄은 card_items.approval_id 로 문서에 묶인다. 판정·이름은 card-rules.js(서버 _shared/card-doc.ts 와 같은 판정 — card-parity 시험).
     · 살아 있는 문서 = 결재 중·결재 완료 · 죽은 문서 = 반려·회수(draft 포함 — 다시 상신하면 같은 문서 번호).
     · 여러 카드 문서 = 이 기능 전에 카드 둘 이상을 한 문서로 올린 예전 문서(card_no 없음). 살아 있으면 그 달 줄이 모두 잠긴다(예전 그대로).
     · 잠긴 줄(lineLocked) = 살아 있는 문서에 묶인 줄 + 위 달의 모든 줄. 결재 목록을 못 받았거나 목록에 없는 문서에 묶인 줄도 잠긴 것으로(서버 트리거가 마지막에 다시 막는다).
     · 대상 = 이번 상신·검증이 쓰는 문서 — 죽은 문서(다시 상신) 또는 새 문서(카드 키 + 차례). 목록 = R.docTargets(내 그 달 줄, 내 그 달 문서).
       대상 표시 tid = 'd{문서 번호}' · 'n{카드 키 짧은 지문}' — 카드번호를 DOM·sessionStorage·주소에 두지 않는다. 고른 대상 = CSEL[기간](사라지면 첫 대상). */
  var CSEL = {};           // 기간 → 고른 대상 tid(이 탭에서만)
  var CSTRIP = {};         // 문서 번호 → 1 = 펼친 결재 띠(문서가 셋 이상이면 띠는 머리 줄만 — 눌러 펼친다)
  function isLive(st) { return st === 'submitted' || st === 'approved'; }
  function isDead(st) { return st === 'rejected' || st === 'withdrawn' || st === 'draft'; }
  function str(v) { return String(v == null ? '' : v); }
  /** 카드 키(공백 뺀 카드번호) · 끝자리(숫자 뒤 4자리) — card-rules.js 가 앞 판이면(배포 직후 캐시) 같은 식으로. */
  function cKey(v) { return R.cardKey ? R.cardKey(v) : str(v).replace(/\s+/g, ''); }
  function cTail(v) { return R.cardTail ? R.cardTail(cKey(v)) : cKey(v).replace(/[^0-9]/g, '').slice(-4); }
  function seqOf(a) { var s = Number(a && a.seq); return isFinite(s) && s >= 1 ? s : 1; }
  /** 여러 카드 문서인가(card_no 없음 — DB 를 아직 안 고친 서버의 문서도 같게 본다: 그 달 통째 잠금, 예전 그대로). */
  function multiDoc(a) { return !!a && a.card_no == null; }
  /** 문서 이름 꼬리(SPEC §2) — ' · 카드 끝 1234'(· 추가 N) · ' · 여러 카드' · ' · 카드 번호 없음' · 문서가 아니면(card_no 칸 없음) ''. */
  function docSuffix(card_no, seq) {
    if (R.docSuffix) return R.docSuffix(card_no, seq);
    if (card_no === undefined) return '';
    if (card_no === null) return ' · 여러 카드';
    var t = cTail(card_no), s = Number(seq);
    return (t ? ' · 카드 끝 ' + t : ' · 카드 번호 없음') + (s >= 2 ? ' · 추가 ' + (s - 1) : '');
  }
  /** 꼬리를 앞 「 · 」 없이 — 「카드 끝 1234」·「카드 끝 1234 · 추가 1」·「여러 카드」(단추·딱지·이름 아래 작은 줄). */
  function tagText(card_no, seq) { return docSuffix(card_no, seq).replace(/^ · /, ''); }
  /* ── 끝자리가 같은 다른 카드 가르기(2026-11-03 고침 1 L4) — 한 사람·한 달에 끝 4자리가 같은 카드가 둘 이상이면 카드 키 차례로 「(1)」·「(2)」를
     화면 이름(고르기 단추·머리 줄·상신 창·결재 띠·결재함·관리 칸) 끝자리 뒤에 붙인다. 카드번호 전체는 보이지 않는다. 문서·파일 이름(PDF·엑셀)은 그대로. ── */
  function dupMap(keys) {
    var byT = {}, out = {};
    (keys || []).forEach(function (k) { if (k == null) return; k = cKey(k); var t = cTail(k); if (t) (byT[t] = byT[t] || {})[k] = 1; });
    Object.keys(byT).forEach(function (t) { var ks = Object.keys(byT[t]).sort(cmpS); if (ks.length > 1) ks.forEach(function (k, i) { out[k] = ' (' + (i + 1) + ')'; }); });
    return out;
  }
  /** 그 사람·그 달에 받아 둔 줄(본인은 내 줄, 관리자 화면은 전 직원 줄) + 보이는 문서의 카드 키로 가르는 번호. */
  function dupOf(u, cyc) {
    var keys = [], add = function (it) { if (it && it.username === u) keys.push(it.card_no); };
    var x = ITEMS[itemKey(false, cyc)], y = ITEMS[itemKey(true, cyc)];
    ((x && x.rows) || []).forEach(add); ((y && y.rows) || []).forEach(add);
    docsOf(u, cyc).forEach(function (a) { if (a.card_no != null) keys.push(a.card_no); });
    return dupMap(keys);
  }
  /** 「카드 끝 1234」 → 「카드 끝 1234 (1)」(그 카드가 가를 카드일 때만). */
  function withDup(s, card_no, dm) {
    var d = card_no != null && dm ? dm[cKey(card_no)] : '';
    if (!d) return s;
    var tl = cTail(card_no);
    return String(s).replace('카드 끝 ' + tl, '카드 끝 ' + tl + d);
  }
  /** 화면 이름 꼬리(가르는 번호까지) — u·cyc = 그 카드의 사람·달. */
  function tagFor(card_no, seq, u, cyc) { return withDup(tagText(card_no, seq), card_no, dupOf(u, cyc)); }
  /** 문서 짧은 이름 — 「10월분 · 카드 끝 1234」(종·포털·알림). 긴 이름 — 「2026년 10월분 (10.01~10.31) · 카드 끝 1234」(결재함·결재 창). 둘 다 가르는 번호까지. */
  function docShort(a) {
    var s = R.docName ? R.docName(a.cycle, a.card_no, a.seq) : (C.keyShort ? C.keyShort(a.cycle, a.cycle) : str(a.cycle)) + docSuffix(a.card_no, a.seq);
    return withDup(s, a.card_no, dupOf(a.username, a.cycle));
  }
  function docLong(a) { return withDup(cycName(a.cycle) + ' (' + R.span(a.cycle) + ')' + docSuffix(a.card_no, a.seq), a.card_no, dupOf(a.username, a.cycle)); }
  /** 파일 이름 조각 — 「_카드1234」(+ 「_추가1」). 여러 카드·번호 없음은 조각 없음(지금 이름 그대로, SPEC §2). */
  function filePiece(card_no, seq) {
    if (card_no == null) return '';
    var t = cTail(card_no), s = Number(seq);
    return t ? '_카드' + t + (s >= 2 ? '_추가' + (s - 1) : '') : '';
  }
  /** 문서 차례 = 대상 목록과 같은 차례(여러 카드 문서 → 끝자리 → 차례 → 카드 키 → 번호). */
  function docCmp(a, b) {
    return (multiDoc(a) ? 0 : 1) - (multiDoc(b) ? 0 : 1) || cmpS(cTail(a.card_no), cTail(b.card_no)) || seqOf(a) - seqOf(b) ||
      cmpS(cKey(a.card_no), cKey(b.card_no)) || (Number(a.id) || 0) - (Number(b.id) || 0);
  }
  // 결재 목록 찾아보기 — 번호 → 문서 · 사람|기간 → 문서들(차례대로). 결재 목록(CAPPR)을 새로 받으면 다시 만든다.
  var IDX = { src: undefined, byId: {}, byUc: {} };
  function idx() {
    if (IDX.src !== CAPPR) {
      var byId = {}, byUc = {};
      (CAPPR || []).forEach(function (a) { byId[String(a.id)] = a; var k = a.username + '|' + a.cycle; (byUc[k] = byUc[k] || []).push(a); });
      Object.keys(byUc).forEach(function (k) { byUc[k].sort(docCmp); });
      IDX = { src: CAPPR, byId: byId, byUc: byUc };
    }
    return IDX;
  }
  function apprById(id) { return idx().byId[String(id)] || null; }
  /** 그 사람·그 기간의 문서들(차례대로). */
  function docsOf(u, cyc) { return (idx().byUc[u + '|' + cyc] || []).slice(); }
  function myDocs(cyc) { return docsOf(me(), cyc || C.state().CYCKEY); }
  /** 그 달 통째 잠금 — 살아 있는 여러 카드 문서가 있다(올리기 단추도 숨긴다). */
  function monthLocked(u, cyc) { return docsOf(u, cyc).some(function (a) { return multiDoc(a) && isLive(a.status); }); }
  /** 그 줄을 고칠 수 없는가(SPEC §5-1 lineLocked). 결재 목록을 모르면(못 받음 — 고침 1 M1) 묶인 줄은 잠긴 것으로. */
  function lineLocked(it) {
    if (!it) return false;
    var bound = it.approval_id != null && it.approval_id !== '';
    if (!apprKnown()) return bound;
    if (monthLocked(it.username, it.cycle)) return true;
    if (!bound) return false;
    var a = apprById(it.approval_id);
    return !a || isLive(a.status);
  }
  /** 그 줄이 든 문서(잠금 글을 상태대로 — 고침 1 L3) — 묶인 문서, 없으면 그 달을 통째로 잠근 여러 카드 문서, 모르면 null. */
  function docOfLine(it) {
    if (!it) return null;
    var a = it.approval_id != null && it.approval_id !== '' ? apprById(it.approval_id) : null;
    return a || docsOf(it.username, it.cycle).filter(function (d) { return multiDoc(d) && isLive(d.status); })[0] || null;
  }
  function openOf(rows) { return (rows || []).filter(function (it) { return !lineLocked(it); }); }
  /** 그 사람·그 기간의 살아 있는 상태 — 결재 중 문서가 하나라도 있으면 'submitted', 아니면 결재 완료가 있으면 'approved', 아니면 ''(「내역 없음」 효력 판정). */
  function liveStOf(docs) {
    var s = (docs || []).map(function (a) { return a.status; });
    return R.liveStatus ? R.liveStatus(s) : s.indexOf('submitted') >= 0 ? 'submitted' : s.indexOf('approved') >= 0 ? 'approved' : '';
  }
  /** 달 상태(R.monthState — { st, sub, app, rej, wd, left, blank_left }). lines 가 null 이면(그 달 줄을 안 받음) 문서만으로(반려 > 회수 > 결재 중 > 결재 완료). */
  function monthOfLines(lines, docs) {
    if (R.monthState) return R.monthState(lines, docs);
    var n = { submitted: 0, approved: 0, rejected: 0, withdrawn: 0 }, open = lines ? openOf(lines) : null;
    docs.forEach(function (a) { var s = a.status === 'draft' ? 'withdrawn' : a.status; if (n[s] != null) n[s]++; });
    var lm = docs.filter(function (a) { return multiDoc(a) && isLive(a.status); });
    var st = lm.length ? liveStOf(lm) : n.rejected ? 'rejected' : n.withdrawn ? 'withdrawn' : open && open.length ? '' : n.submitted ? 'submitted' : n.approved ? 'approved' : '';
    return { st: st, sub: n.submitted, app: n.approved, rej: n.rejected, wd: n.withdrawn, left: open ? open.length : null, blank_left: open ? R.blankRows(open) : null };
  }
  /** 내 그 기간 달 상태 — 결재 목록을 모르면(아직 · 못 받음) null. */
  function myMonth(k) {
    if (!apprKnown()) return null;
    var x = ITEMS[itemKey(false, k)];
    return monthOfLines(x && x.rows ? mineRows(k) : null, myDocs(k));
  }
  /** 이번 상신·검증 대상 목록(내 그 기간) — 줄·결재 목록을 모르면 [](상신 단추 없음 — 고침 1 M1). */
  function targetsOf(cyc) {
    var x = ITEMS[itemKey(false, cyc)];
    if (!apprKnown() || !x || !x.rows) return [];
    if (!R.docTargets) {                 // 앞 판 card-rules.js(배포 직후 캐시) — 달 하나를 한 대상으로(서버가 대상을 정한다)
      var op = openOf(mineRows(cyc)), dd = myDocs(cyc).filter(function (a) { return isDead(a.status); }).pop();
      return op.length ? [{ approval_id: dd ? dd.id : null, card_no: dd ? dd.card_no : null, seq: dd ? seqOf(dd) : 1, status: dd ? dd.status : '', items: op, tid: 'm' }] : [];
    }
    return R.docTargets(mineRows(cyc), myDocs(cyc)).map(function (t) {
      if (!t.tid) t.tid = t.approval_id != null ? 'd' + t.approval_id : 'n' + (cTail(t.card_no) || 'x') + '_' + cKey(t.card_no).length;
      return t;
    });
  }
  /** 고른 대상 — CSEL[기간] 이 가리키는 대상, 없으면 첫 대상(없으면 null). */
  function selTarget(cyc, list) {
    list = list || targetsOf(cyc);
    var want = CSEL[cyc];
    return list.filter(function (t) { return t.tid === want; })[0] || list[0] || null;
  }
  /** 대상 줄(날짜 순 사본). */
  function tItems(t) { return t ? t.items.slice().sort(byDate) : []; }
  /** 대상 줄 번호(오름차순) — 상신 본문 item_ids(PLAN K2 고침 1 M1)·붙잡은 대상 견주기. */
  function idsOf(t) { return (t ? t.items : []).map(function (it) { return Number(it.id); }).sort(function (a, b) { return a - b; }); }

  /* ── 상신 창이 붙잡는 대상(2026-11-03 고침 1 H1) ──
     「상신」 창을 여는 순간(#btnOpenSubmit — 붙잡기 단계 처리기) 고른 대상의 tid · 문서 번호 · 카드 키 · 미리 본 줄 번호를 붙잡는다.
     창이 열려 있는 동안 갈고리(draftTag·submitExtra·mine·submitHead·beforeSubmit)는 모두 이 대상만 본다 — 목록이 새로 들어와 고른 대상이
     없어지거나 바뀌어도 첫 대상으로 말없이 바꾸지 않는다. 바뀐 것을 알면(목록 다시 받기 · 상신 실패 · 상신 직전 확인) 창을 닫고
     까닭을 알린 뒤 검증·상신(대상 고르기)으로 데려간다. 창이 닫히면 붙잡기를 푼다(다음 창은 그때 다시 붙잡는다). */
  var PIN = null;
  //   t = 붙잡을 때의 대상(줄을 다시 받는 중이라 지금 모습을 모를 때 창 머리에 쓴다)
  function pinOf(cyc, t) { return { cyc: cyc, tid: t.tid, approval_id: t.approval_id == null ? null : t.approval_id, card_no: t.card_no == null ? null : t.card_no, seq: t.seq, ids: idsOf(t), t: t, live: false }; }
  /** 지금 열려 있는(또는 여는 중인) 법인카드 상신 창의 붙잡은 대상 — 없으면 null. 창이 닫혔거나 다른 창으로 바뀌었으면 붙잡기를 푼다. */
  function pinNow() {
    if (!PIN || PIN.cyc !== C.state().CYCKEY) return null;
    if (!PIN.live) return PIN;                 // 창을 여는 중(본체 openSubmit) — 그 대상
    var p = $('panel'), sub = !!p && p.classList.contains('open') && !!document.querySelector('#pBody .agrid') && !!($('btnSubmitAppr') || $('btnSubmitAnyway'));
    if (!sub) { PIN = null; return null; }
    return PIN;
  }
  /** 붙잡은 대상이 지금 목록에 그대로 있으면 그 대상(같은 tid · 문서 번호 · 카드 · 줄), 없어졌거나 바뀌었으면 null.
   *  결재 목록·그 기간 내 줄을 둘 다 받아 둔 채가 아니면(받는 중 · 못 받음) undefined = 모름 — 「없어졌다」로 보지 않는다(T7-6). */
  function pinTarget(P) {
    if (!P) return null;
    if (!bothIn(P.cyc)) return undefined;
    var t = targetsOf(P.cyc).filter(function (x) { return x.tid === P.tid; })[0];
    if (!t || String(t.approval_id == null ? '' : t.approval_id) !== String(P.approval_id == null ? '' : P.approval_id)) return null;
    if ((t.card_no == null) !== (P.card_no == null) || cKey(t.card_no) !== cKey(P.card_no)) return null;
    return idsOf(t).join(',') === P.ids.join(',') ? t : null;
  }
  /** 붙잡은 대상이 바뀌었다 — 창을 닫고 까닭을 알린 뒤 대상 고르기(검증·상신)로. 다른 카드로 바꾸지 않는다. */
  function pinStop(msg) {
    PIN = null;
    C.closePanel();
    C.toast(msg, true);
    if (C.state().VIEW !== 'c_verify') C.go('c_verify'); else C.render();
  }
  var PIN_GONE = '그 사이 상신할 카드 내역이 바뀌었어요. 검증·상신에서 카드를 다시 골라 주세요.';
  /** 목록을 새로 받은 뒤 — 열린 상신 창이 붙잡은 대상이 없어졌거나 바뀌었으면 멈춘다. 상신을 확인·보내는 중이면(단추가 막혀 있음) 그쪽(beforeSubmit·onSubmitFail)이 본다.
   *  결재 목록과 그 기간 내 줄이 둘 다 들어온 뒤에만 판단한다 — 하나가 아직 오는 중이면(모름) 그것이 들어올 때 다시 부른다(T7-6). */
  function pinCheck() {
    var P = pinNow();
    if (!P || !P.live) return;
    var b = $('btnSubmitAnyway') || $('btnSubmitAppr');
    if (b && b.disabled) return;
    if (pinTarget(P) === null) pinStop(PIN_GONE);
  }
  /** 칸에 「 · 」로 이은 이름 넣기 — 조각이 둘 이상이면 줄바꿈 조각(C.dn — 폰에서 줄 끝 「·」·「카드 끝」/「1234」 갈림 없게, 2026-11-03 디자인 검사 M1), 아니면 글자 그대로. */
  function dnPut(el, text) {
    if (!el) return;
    text = text == null ? '' : String(text);
    if (C.dn && text.split(' · ').length > 1) el.innerHTML = C.dn(text); else el.textContent = text;
  }
  /** 「A · B」를 줄바꿈 조각 HTML 로(C.dn — 없는 앞 판 본체면 esc 그대로). */
  function dnHtml(text) { text = text == null ? '' : String(text); return C.dn && text.split(' · ').length > 1 ? C.dn(text) : esc(text); }
  /** 열린 상신 창 머리(제목·아래 줄)를 지금 자료로 — 상신이 막혔는데 대상이 그대로일 때(본체가 창을 열 때와 같은 조각 모양). */
  function pinHead() {
    var H = K0.submitHead();
    dnPut($('pTitle'), H.title);
    dnPut($('pSub'), H.sub);
  }
  /** 「이번 기간 내역 없음」 효력(2026-11-02 docs/none-mark/SPEC.md §5) — 내 그 기간: 표시 + 살아 있는 문서 없음 + 그 기간 카드 줄 0건.
   *  ★ 이 모듈은 보고 있는 기간의 줄만 받는다 — 줄(또는 결재 목록)을 아직 받지 않은 기간은 null = 모름(효력 없음으로 친다 — 0건으로 치면 가짜 「내역 없음」이 뜬다).
   *    포털 hint 는 null 이면 같은 기간에 알던 값을 그대로 둔다(검토 L6). 화면은 === true 로만 본다. */
  function noneOn(k) {
    var x = ITEMS[itemKey(false, k)];
    if (!C.noneEffective || !apprKnown() || !x || !x.rows) return null;
    return C.noneEffective('card', me(), k, x.rows.length, liveStOf(myDocs(k)));
  }
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
    // 설명의 가운뎃점 낱말(「구분·사용목적」)은 한 덩이로(keepDots) — 「확인 필요」 설명에 식대 비고를 더하자 360·390 에서 그 낱말이 두 줄로 갈렸다(2026-11-02 고침 2차)
    //   설명이 { html } 이면 이미 만든 HTML 그대로(「 · 」 조각 dnLine — 2026-11-03 화면 다듬기)
    return '<div class="fact"><div class="k">' + esc(k) + '</div><div class="v' + (alert ? ' alert' : '') + '">' + v + '</div>' +
      '<div class="sub">' + (sub && sub.html != null ? sub.html : keepDots(esc(sub || ''))) + '</div></div>';
  }
  function head(title, extra) {
    var S = C.state();
    return C.head(title, esc(cycName(S.CYCKEY)) + ' · <b>' + esc(R.span(S.CYCKEY)) + '</b>' + (extra ? ' · ' + extra : ''));
  }
  function notReady(title, x) {
    if (x && x.err) {
      return C.head(title) + '<section class="sect"><div class="panel" style="padding:34px 24px;text-align:center">' +
        '<div style="font-weight:700;margin-bottom:6px">' + esc(x.err) + '</div><div class="dim" style="margin-bottom:16px">' +
        (C.retryHint ? C.retryHint(x.err) : '잠시 후 다시 해 주세요.') + '</div>' +
        '<button class="btn pri" data-creload>다시 불러오기</button></div></section>';
    }
    return C.head(title) + C.skeleton();
  }
  /** 기간 띠 — 지난 기간을 볼 때만. */
  function band() {
    var S = C.state(), cur = cCurrent();
    if (C.cmpCycle(S.CYC, cur) >= 0) return '';
    // 「(기간) · 지난 기간을」은 한 덩이 — 360 에서 「지금 2026년 10월분 (10.01~10.31) ·」으로 줄이 끝났다(2026-11-03 화면 다듬기, 운행일지 띠와 같게)
    return '<div class="cycband"><span>' + ic('cal', 15) + '지금 <b>' + esc(cycName(S.CYCKEY)) + ' </b><span style="white-space:nowrap"><b>(' + esc(R.span(S.CYCKEY)) +
      ') · 지난 기간</b>을</span> 보고 있어요. 법인카드는 <b>1일 ~ 말일</b>이 한 기간이에요.</span>' +
      '<button class="btn sm" data-cyc="' + cur.y + '-' + cur.m + (cur.x || '') + '">이번 기간(' + esc(CR.short(cur)) + ' ' + esc(cSpan(cur)) + ')으로 →</button></div>';
  }
  function tag(key) {
    // 「내역 없음」 효력이면 그 딱지(2026-11-02 — 결재 상태 딱지와 같은 꼴, 색 없음). 줄을 받지 않은 기간은 모름 = 딱지 없음
    if (noneOn(key) === true) return '<span class="st dim">내역 없음</span>';
    // 문서가 여럿이면 달 상태(monthState.st — 반려 > 회수 > 상신 전 줄 > 결재 중 > 결재 완료, 2026-11-03 SPEC §5-9)
    var ms = myMonth(key);
    var m = ms && { approved: ['결재 완료', 'ok'], submitted: ['결재 중', 'warn'], rejected: ['반려', 'bad'], withdrawn: ['회수', 'dim'] }[ms.st];
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
  /** 구분별 합계 조각 — 큰 것부터 넷(「구분 ₩X」), 나머지는 「외 N구분 ₩X」(2026-10-15 — 넷만 보여 합계와 안 맞아 보이던 것). */
  function catParts(byCat) {
    var all = Object.keys(byCat || {}).map(function (c) { return { c: c, sum: byCat[c].sum }; }).sort(function (a, b) { return b.sum - a.sum; });
    var t = all.slice(0, 4), rest = all.slice(4);
    return t.map(function (x) { return x.c + ' ' + won(x.sum); })
      .concat(rest.length ? ['외 ' + n0(rest.length) + '구분 ' + won(rest.reduce(function (s, x) { return s + (Number(x.sum) || 0); }, 0))] : []);
  }
  /** 구분별 합계 한 줄(HTML) — 「구분 금액」 쌍은 덩이째, 줄은 쌍 사이에서만 바뀌고 줄 끝·처음에 「·」가 남지 않는다(C.dnJoin 걸린 구분점 —
   *  2026-11-03 최종 화면 검사 L2: 「…석식대 / 12,000원 · 중식대 9,000원 · / …」). 글(textContent)은 예전 「A · B」 그대로. 앞 판 본체면 글 그대로. */
  function catHtml(byCat) {
    var p = catParts(byCat);
    return !p.length ? '—' : C.dnJoin ? C.dnJoin(p.map(esc)) : esc(p.join(' · '));
  }
  /** 통행료·하이패스 줄인가 — 하이패스 가맹점(R.isHipassMerchant — 「후불하이패스3건」) 또는 업종·가맹점에 통행료·톨게이트·도로공사(구분 칸 예시 글만 바꾼다). */
  function tollLine(it) {
    return !!(R.isHipassMerchant && R.isHipassMerchant(it && it.merchant)) || /통행료|톨게이트|도로공사/.test(String((it && it.biz_type) || '').replace(/\s+/g, '') + ' ' + String((it && it.merchant) || '').replace(/\s+/g, ''));
  }
  /** 「 · 」로 잇는 짧은 조각(글 그대로 — 여기서 esc)을 한 줄로 — catHtml 과 같은 방법(조각은 덩이째, 줄은 조각 사이에서만 · 줄 끝·처음 「·」 없음).
   *  2026-11-03 화면 다듬기: 「상신 때 검증 결과 · 2026-11-10 07:00 ·」 / 「· 소모품비」처럼 「·」가 줄 끝·처음에 남던 곳. 앞 판 본체면 글 그대로. */
  function dnLine(parts) { return C.dnJoin ? C.dnJoin(parts.map(esc)) : esc(parts.join(' · ')); }
  /** 결재 띠 — 상태 · 진행 · 회수. 이번 달 카드 내역·검증 화면 위에(상신한 본인 화면).
   *  ★ 2026-10-15: 본인 화면에서는 결재자용 요약 표(brief)를 빼고 검증 딱지 · PDF·엑셀 단추만(개인경비와 같게). 결재함 카드는 그대로.
   *  ★ 2026-11-03 추가 상신(SPEC §5-2): 문서마다 띠 하나 — 머리에 짧은 이름(「10월분 · 카드 끝 1234」). 문서가 셋 이상이면(o.many) 머리 줄만 보이고(o.fold)
   *    「펼치기」로 펼친다(.astrip.fold · data-cstrip). o.sums = 결재 요약(고정본 검증)은 부른 쪽이 한 번에 받는다(stripsHtml). */
  /** 결재 띠가 쓰는 이 기간 모양(2026-11-03 회귀 N1 · 디자인 검사 M2) — nk = 카드 수(줄·문서) · nOpen = 열린 줄 수 ·
   *  named = 띠 머리에 문서 이름(문서가 둘 이상이거나 카드가 둘 이상일 때만) · solo = 카드 한 장 · 문서 하나 · 열린 줄 없음(예전 띠 그대로 — 이름 없음 · 「이 기간의」 글). */
  function stripCtx(docs) {
    var rows = mineRows(C.state().CYCKEY), keys = {};
    rows.forEach(function (it) { keys[cKey(it.card_no)] = 1; });
    (docs || []).forEach(function (a) { if (a.card_no != null) keys[cKey(a.card_no)] = 1; });
    var nk = Object.keys(keys).length, nOpen = openOf(rows).length, nd = (docs || []).length;
    return { nk: nk, nOpen: nOpen, named: nd >= 2 || nk >= 2, solo: nd <= 1 && nk <= 1 && !nOpen };
  }
  function apprStrip(a, o) {
    o = o || {};
    var S = C.state(), live = !!a && isLive(a.status), dead = !!a && isDead(a.status), cx = o.cx || stripCtx(myDocs(S.CYCKEY));
    var st = C.apprStatusText(a);
    // 「이번 기간 내역 없음」 효력이면 회수·반려 건이어도 「다시 상신하세요」·「수정 후 다시 상신 →」을 두지 않는다 — 빈 상신은 서버가 막아
    //   따라갈 수도 없는 일이었다(2026-11-02 검토 M1). 상태 딱지·진행 줄·의견은 그대로(정정 중 글의 「고친 뒤 다시 상신하세요.」 꼬리만 뗀다).
    var nn = noneOn(S.CYCKEY) === true;
    if (nn && C.noResubmit) st = { t: C.noResubmit(st.t), cls: st.cls };
    var canWithdraw = a && a.status === 'submitted' && !(a.steps || []).some(function (x) { return x.result; });
    var btn = canWithdraw ? '<button class="btn sm" data-appr="withdraw" data-kind="card" data-id="' + a.id + '">회수</button>' : '';
    if (live && !o.sums) wantSums([a.id]);
    var tog = a && o.many ? '<button type="button" class="btn sm" data-cstriptog="' + a.id + '" aria-expanded="' + (o.fold ? 'false' : 'true') + '">' + (o.fold ? '펼치기' : '접기') + '</button>' : '';
    // 문서 이름은 문서·카드가 여럿일 때만(카드 한 장 · 문서 하나는 예전 띠 그대로 — 회귀 N1). 이름은 「 · 」 조각(폰에서 줄 끝 「·」·끝자리 갈림 없게 — 디자인 검사 M1)
    var hd = '<div class="ahd"><span class="akind c">법인카드</span>' + (a && cx.named ? '<b>' + dnHtml(docShort(a)) + '</b>' : '') +
      '<span class="st ' + st.cls + '">' + esc(st.t) + '</span><span style="flex:1"></span>' + btn + tog + '</div>';
    if (a && o.fold) return '<section class="sect" style="margin:0 0 16px"><div class="astrip fold" data-cstrip="' + a.id + '">' + hd + '</div></section>';
    // 반려·회수 문서로 다시 상신할 수 있으면(그 문서가 대상 — 줄이 있다) 그 대상을 골라 검증·상신으로. 검증 화면에서 이미 고른 대상이면 단추 없음
    var tid = a ? 'd' + a.id : '', canGo = dead && !nn && targetsOf(S.CYCKEY).some(function (t) { return t.tid === tid; }) &&
      !(S.VIEW === 'c_verify' && (selTarget(S.CYCKEY) || {}).tid === tid);
    return '<section class="sect" style="margin:0 0 16px"><div class="astrip"' + (a && o.many ? ' data-cstrip="' + a.id + '"' : '') + '>' + hd +
      // 의견(2026-10-21) — 진행 줄 바로 아래 차례대로(담당 상신 의견 → 결재자 승인 의견). 펼친 문서 자리에는 다시 넣지 않는다(ops:false)
      (a ? C.apprTrack(a) + (C.opinions ? C.opinions(a) : '') : '<div class="anote" style="margin-top:0">' + C.apprHint + ' 지난번 결재선도 불러올 수 있어요.</div>') +
      (live ? extra(a, true) + (C.apvSlot ? C.apvSlot('card', a, { ops: false }) : '') : '') +
      // 잠기는 것은 그 문서에 든 줄뿐이라 문서가 하나여도 「이 문서에 든」(2026-11-03 화면 다듬기 — 예전 「이 기간의」는 바로 아래 「늦게 온 카드 내역이 있으면
      //   ERP 엑셀을 다시 올려 주세요」와 맞지 않아 기간 전체가 막힌 것처럼 읽혔다) — 끝 문장은 카드가 둘 이상이거나 열린 줄이 있을 때만(디자인 검사 M2)
      (a && a.status === 'submitted' ? '<div class="anote">결재 중에는 이 문서에 든 카드 내역을 고칠 수 없어요. ' +
        (canWithdraw ? '고치려면 회수한 뒤 다시 상신하세요.' : '이미 승인한 결재자가 있어 회수할 수 없어요. 고치려면 지금 차례인 결재자에게 반려를 요청하세요.') +
        (cx.nk >= 2 ? ' 다른 카드·새로 올린 줄은 따로 상신해요.' : cx.nOpen ? ' 새로 올린 줄은 따로 상신해요.' : '') + '</div>' : '') +
      // 반려·회수 뒤 — 어디서 다시 상신하는지(운행일지 띠와 같게, 2026-10-16 3차). 그 문서를 대상으로 골라 검증·상신으로 가는 길도.
      (dead && !nn ? '<div class="anote afix">고친 뒤 ‘검증·상신’에서 다시 상신하세요.' +
        (canGo ? ' <button class="btn pri sm" data-v="c_verify" data-ctarget="' + tid + '">수정 후 다시 상신 →</button>' : '') + '</div>' : '') +
      '</div></section>';
  }
  /** 결재 목록을 못 받았을 때(고침 1 M1) — 상신 상태를 모른다는 말 + 「다시 불러오기」(불러오지 못한 줄 화면 notReady 와 같은 모양). */
  function apprErrBand() {
    return '<section class="sect"><div class="panel" id="cApprErr" style="padding:34px 24px;text-align:center">' +
      '<div style="font-weight:700;margin-bottom:6px">결재 목록을 불러오지 못했어요.</div>' +
      '<div class="dim" style="margin-bottom:16px">어느 카드 내역이 상신됐는지 몰라 상신을 잠시 막아 뒀어요. 잠시 후 다시 불러와 주세요.</div>' +
      '<button class="btn pri" data-creload>다시 불러오기</button></div></section>';
  }
  /** 문서마다 결재 띠(차례 = 대상 목록과 같은 차례), 문서가 없으면 안내 띠 하나. 문서가 셋 이상이면 머리 줄만 — 누르면 펼친다(2026-11-03 SPEC §5-2 설계 판단). */
  function stripsHtml(docs) {
    if (!docs.length) return apprStrip(null);
    var many = docs.length >= 3, cx = stripCtx(docs);
    wantSums(docs.filter(function (a) { return isLive(a.status); }).map(function (a) { return a.id; }));
    return docs.map(function (a) { return apprStrip(a, { many: many, fold: many && !CSTRIP[a.id], sums: true, cx: cx }); }).join('');
  }

  /* ══════════════════ 이번 달 카드 내역 ══════════════════ */
  /** 화면 제목 — 지금 기간이면 「이번 달 카드 내역」, 다른 기간을 볼 때는 「카드 내역」(기간은 제목 아래 줄에, 2026-10-15). */
  //   2026-10-24 4단계 이름표 통일 — 지금 기간도 「카드 내역」(메뉴 이름과 같게). 기간은 제목 아래 줄이 말한다.
  function monthTitle() { return '카드 내역'; }
  /** 「추천 구분 채우기 (N)」의 N — 구분이 비었고 추천이 있는 줄(칩을 누르거나 칸을 채울 때마다 다시 센다, 2026-10-15).
   *  list = 셀 줄(열린 줄만 — 2026-11-03 잠긴 줄은 추천하지 않는다) · rows = 추천 재료(그 달 모든 줄, 없으면 list). */
  function sugCount(list, rows) {
    var hist = histFor(rows || list);
    return list.filter(function (it) { return !String(it.category || '').trim() && R.suggest(it, hist); }).length;
  }
  function sugBtnHtml(n) { return '<button class="btn" id="btnCSugAll" data-csugall' + (n ? '' : ' hidden') + '>추천 구분 채우기 (' + n0(n) + ')</button>'; }
  function viewMonth() {
    var S = C.state(), title = monthTitle();
    if (!S.LOADED) return C.head(title) + C.skeleton();
    if (C.isMulti()) return C.singleOnly(title, '법인카드');
    var rows = itemsFor(false);
    if (!rows || rows.err) return notReady(title, rows);
    if (HIST === null && !HIST_ASK) loadHist();
    // 2026-11-03 추가 상신: 잠김은 줄마다(lineLocked) — 「올리기」를 숨기는 것은 그 달 통째 잠금(살아 있는 여러 카드 예전 문서)일 때만.
    //   건수·금액은 모든 줄 · 빈칸·추천은 열린 줄 · 「검증·상신으로」는 상신할 대상(카드)이 있을 때(SPEC §5-2)
    var cyc = S.CYCKEY, docs = myDocs(cyc), mlock = monthLocked(me(), cyc), open = openOf(rows), tg = targetsOf(cyc);
    var T = R.totals(rows), hist = histFor(rows);
    var nSug = open.length ? sugCount(open, rows) : 0;
    // 다 상신했다(줄이 모두 결재 중·결재 완료 문서에 듦 — 지금 할 일이 없다, 2026-11-03 회귀 N1 · 디자인 검사 M2): 요약 칸에 빨간 「ERP 엑셀 올리기」 줄을 두지 않는다
    //   (예전 판처럼 — 표가 내려가지 않게). 늦게 온 카드 내역을 올리는 단추는 표 아래 안내 줄에 보통 단추로(따로 상신 — SPEC §5-4).
    var quiet = !mlock && apprKnown() && rows.length > 0 && !open.length;
    // 결재가 끝났다 = 줄이 모두 결재 완료 문서에 듦(살아 있는 문서가 모두 결재 완료) — 예전 「정정 요청」 안내를 다시 보인다(회귀 N1)
    var liveD = docs.filter(function (a) { return isLive(a.status); });
    var allDone = rows.length > 0 && !open.length && liveD.length > 0 && liveD.every(function (a) { return a.status === 'approved'; });
    var h = head(title, 'ERP에서 받은 내 카드 내역에 구분·사용목적을 적어요.');
    // 결재 목록을 못 받았으면(고침 1 M1) 결재 띠 대신 「다시 불러오기」 — 모르는 것을 「아직 상신하지 않았어요」로 보이지 않는다(묶인 줄은 잠가 두고 상신 단추는 없다)
    h += CAPPR_ERR ? apprErrBand() : stripsHtml(docs);
    h += cancelBand(rows);                 // 전액 취소된 승인이 남아 있으면(2026-10-20 AU2 #5)
    // ★ 2026-10-15: 「ERP 엑셀 올리기」는 요약 칸의 빨간 단추 하나만(빈 기간에 둘이던 것). 「임시저장」 단추는 뺐다 —
    //   칸은 자동 저장이고, 표 위 저장 상태 줄이 저장 중·저장됨·저장 못 함을 알리며, 저장이 실패했을 때만 그 줄에 「다시 저장」이 나온다.
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (allDone ? ' ok' : '') + '"></span>' +
      esc(cycName(S.CYCKEY)) + ' · ' + esc(R.span(S.CYCKEY)) + ' · ' + n0(T.n) + '건</div>' +
      '<p class="verdict">' + won(T.cost) + '</p><div class="facts" id="cFacts">' + factsInner(rows) + '</div>' +
      (mlock || quiet ? '' : '<div class="vact" style="margin-top:16px"><button class="btn pri" data-cup>' + ic('card', 14) + 'ERP 엑셀 올리기</button>' +
        (open.length ? sugBtnHtml(nSug) : '') +
        (tg.length ? '<button class="btn" data-v="c_verify">검증·상신으로 ' + ic('chev', 13) + '</button>' : '') + '</div>') + '</div>';
    // 결재 중 안내는 위 결재 띠에 이미 있다 — 여기서는 결재가 끝났을 때만(2026-10-15, 같은 안내 두 번). 늦게 온 줄은 올릴 수 있으니 「올리거나」는
    //   올리기 단추가 없는 달(통째로 잠긴 여러 카드 예전 문서)에만
    //   잠긴 것은 결재가 끝난 문서에 든 줄뿐이면(늦게 온 줄은 올려 따로 상신) 「결재가 끝난 카드 내역은」 — 「기간이라」는 그 달이 통째로 잠긴 때만(2026-11-03 화면 다듬기)
    if (allDone) h += '<div class="hpnote">' + ic('check', 16) + '<span><b>' + (mlock ? '결재가 끝난 기간이라 카드 내역을 올리거나 고칠 수 없어요.' : '결재가 끝난 카드 내역은 고칠 수 없어요.') + '</b> ' +
      '고칠 것이 있으면 관리자에게 정정을 요청하세요.</span></div>';
    // 「이번 기간 내역 없음」(2026-11-02 docs/none-mark/SPEC.md §5) — 빈 기간 자리에 보조 단추, 효력이 있으면 표시 블록 + 「되살리기」(운행일지 월 마감과 같은 글)
    var NM = C.noneUi ? C.noneUi('card', cyc, rows.length, liveStOf(docs)) : { on: false, can: false };
    // 저장 상태 줄 — 열린 줄이 있을 때 · 그 사이 잠겨 저장 못 한 칸이 남았을 때(「다시 저장」 — 회귀 N2)
    h += C.sect('내역', '<span id="cSectN">' + sectN(rows) + '</span>', '',
      rows.length ? (open.length || Object.keys(FAILED).length ? saveLineHtml(rows) : '') + tableHtml(rows, hist)
        : '<div class="panel"><div class="blank"' + (NM.on ? ' data-nonemark' : '') + '><div class="ico">' + ic('card', 21) + '</div>' + (NM.on
          ? '<div class="t">' + C.noneTitle(cyc) + '</div><div class="d">' + esc(C.noneSaid) + '</div>' + C.noneBtn('card', cyc, true)
          : '<div class="t">이 기간에 올린 카드 내역이 없어요.</div>' +
            // 파일 형식은 줄에서 갈리지 않게 묶는다(2026-11-02 화면 로봇)
            (mlock ? '' : '<div class="d">ERP에서 내 법인카드 승인내역을 <span style="white-space:nowrap">엑셀(.xls, .xlsx)로</span> 다운로드해서 올려 주세요. 0원·취소 줄은 자동으로 빠져요.<br>' +
              // 따옴표 낱말 + 토씨는 한 덩이로(크롬이 「없음’ / 을」로 가를 수 있다 — 아래 「‘추천 구분 채우기’로」와 같은 방법).
              //   두 문장 사이는 줄을 바꾸고(<br>), 짝말(눌러 주세요 · 마감 안내)은 &nbsp; 로 붙인다(2026-11-02 화면 검토 L5)
              (NM.can ? '법인카드를 쓰지 않았으면 <span style="white-space:nowrap">‘이번 기간 내역 없음’을</span> 눌러&nbsp;주세요.<br>마감&nbsp;안내가 멈춰요.'
                : '법인카드를 쓰지 않았으면 할 일이 없어요.') + '</div>') +
            (NM.can ? C.noneBtn('card', cyc, false) : '')) +
          '</div></div>');
    // 줄이 없는 기간에는 빈칸 안내가 할 일이 아니다(2026-11-02 화면 로봇) · 고칠 수 있는 줄이 없어도(모두 상신한 문서에 듦) 할 일이 아니다
    if (open.length) h += '<div class="anote"><b>구분·사용목적이 빈 줄이 있으면 상신할 수 없어요.</b> 구분 칸의 점선 버튼은 <b>추천</b>이라 ' +
      '누르거나 <span style="white-space:nowrap">‘추천 구분 채우기’로</span> 확정하세요.</div>';
    // 다 상신한 달 — 늦게 온 카드 내역 올리기(보통 단추, 표 아래 — 위 요약 칸·표 자리는 예전 그대로, 디자인 검사 M2)
    if (quiet) h += '<div class="anote" id="cLateUp" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px">' +
      '<span style="flex:1 1 260px;min-width:0">늦게 온 카드 내역이 있으면 ERP 엑셀을 다시 올려 주세요. 상신한 줄은 그대로 두고 새 줄만 더해서 따로 상신해요.</span>' +
      '<button class="btn sm" data-cup>' + ic('card', 13) + 'ERP 엑셀 올리기</button></div>';
    return h;
  }
  function tableHtml(rows, hist) {
    // 여러 줄 골라 지우기(2026-10-19) — 순번 칸 안에 고르기 칸. 잠긴 줄이면 막고 까닭을 단다.
    //   카드 묶음(2026-11-03 SPEC §5-2) — 카드가 둘 이상이거나 한 카드에 잠긴 줄·열린 줄이 섞이면 카드마다 머리 줄(tr.cgrp) 아래 그 카드 줄. 순번은 보이는 차례대로 이어 센다.
    var sel = rows.length > 0 && !!C.mselBox, G = cardGroups(rows), n = 0;
    var body = G ? G.map(function (g) { return grpRow(g) + g.rows.map(function (it) { return rowHtml(it, n++, hist); }).join(''); }).join('')
      : rows.map(function (it, i) { return rowHtml(it, i, hist); }).join('');
    return (sel ? C.mselAllLine('c', 'ctab') : '') + '<div class="panel"><div class="scroll tall cscroll" data-rows><table class="ctab"><thead><tr><th class="n' + (sel ? ' mselth">' + C.mselAll('c') : '">') + '순번</th><th>승인일</th><th>시간</th><th>가맹점</th><th>업종</th>' +
      '<th class="n">승인금액</th><th>구분</th><th>사용목적</th><th>비고</th><th></th></tr></thead><tbody>' + body +
      '</tbody><tfoot><tr><td colspan="5">합계 ' + n0(rows.length) + '건</td><td class="n total">' + n0(R.totals(rows).cost) + '</td><td colspan="4"></td></tr></tfoot></table></div></div>' + (sel ? C.mselBar('c') : '');
  }
  /** 카드 묶음 머리 이름 — 「카드 끝 1234」. 끝자리가 같은 다른 카드가 그 달에 있으면 카드 키 차례로 「카드 끝 1234 (1)」·「(2)」 —
   *  고르기 단추·상신 창·결재 띠와 같은 번호(고침 1 L4 — 예전 「카드 0000-…-1234」 대신. 전체 번호는 보이지 않는다). 숫자가 없으면 「카드 번호 없음」. */
  function cardLabel(k, dm) {
    var t = cTail(k);
    return t ? '카드 끝 ' + t + ((dm && dm[cKey(k)]) || '') : '카드 번호 없음';
  }
  /** 이번 달 표의 카드 묶음(2026-11-03 SPEC §5-2) — 카드가 둘 이상이거나 한 카드에 잠긴 줄·열린 줄이 섞일 때만, 아니면 null(지금 표 그대로 — 설계 판단).
   *  묶음 = { key, label, rows, docs, targets, nOpen, cost } · 차례 = 끝자리 순 · 묶음 안 = 살아 있는 문서 줄(차례 순) → 죽은 문서 줄 → 안 묶인 줄, 그 안은 날짜 순. */
  function cardGroups(rows) {
    var by = {}, keys = [];
    rows.forEach(function (it) { var k = cKey(it.card_no); if (!by[k]) { by[k] = { key: k, rows: [] }; keys.push(k); } by[k].rows.push(it); });
    var mixed = keys.some(function (k) { var L = by[k].rows.map(lineLocked); return L.indexOf(true) >= 0 && L.indexOf(false) >= 0; });
    if (keys.length < 2 && !mixed) return null;
    var cyc = C.state().CYCKEY, docs = myDocs(cyc), tg = targetsOf(cyc), dm = dupOf(me(), cyc);
    var docOf = function (it) { return it.approval_id != null && it.approval_id !== '' ? apprById(it.approval_id) : null; };
    // 목록에 없는 문서에 묶인 줄은 잠긴 줄 쪽(0)
    var rank = function (it) { var a = docOf(it); return a ? (isLive(a.status) ? 0 : 1) : it.approval_id != null && it.approval_id !== '' ? 0 : 2; };
    var sq = function (it) { var a = docOf(it); return a ? seqOf(a) : 0; };
    return keys.map(function (k) {
      var g = by[k];
      g.rows.sort(function (x, y) { return rank(x) - rank(y) || sq(x) - sq(y) || byDate(x, y); });
      g.docs = docs.filter(function (a) { return multiDoc(a) ? g.rows.some(function (it) { return String(it.approval_id) === String(a.id); }) : cKey(a.card_no) === k; });
      g.targets = tg.filter(function (t) { return t.items.some(function (it) { return cKey(it.card_no) === k; }); });
      g.nOpen = openOf(g.rows).length;
      g.cost = R.totals(g.rows).cost;
      g.label = cardLabel(k, dm);
      return g;
    }).sort(function (a, b) { return cmpS(cTail(a.key), cTail(b.key)) || cmpS(a.key, b.key); });
  }
  /** 문서 딱지 — 「결재 중」·「추가 1 결재 완료」·「반려」·「여러 카드 결재 중」. */
  function docChip(a) {
    var m = { approved: ['결재 완료', 'ok'], submitted: ['결재 중', 'warn'], rejected: ['반려', 'bad'], withdrawn: ['회수', 'dim'], draft: ['회수', 'dim'] }[a.status] || [str(a.status), 'dim'];
    var pre = multiDoc(a) ? '여러 카드 ' : seqOf(a) >= 2 ? '추가 ' + (seqOf(a) - 1) + ' ' : '';
    return '<span class="st ' + m[1] + '">' + esc(pre + m[0]) + '</span>';
  }
  /** 카드 묶음 머리 줄(K8 tr.cgrp) — 「카드 끝 1234 · N건 · ₩X」 + 문서 딱지 + 「상신 전 N줄」 + 그 카드 대상으로 검증·상신(새 문서 「상신하기 →」 · 죽은 문서 「다시 상신 →」).
   *  한 카드에 대상이 둘 이상이면 단추에 어느 문서인지(「추가 1」·「여러 카드」)를 붙인다. */
  function grpRow(g) {
    var many = g.targets.length > 1;
    var btns = g.targets.map(function (t) {
      var dead = t.approval_id != null, q = !many ? '' : t.card_no == null ? '여러 카드 ' : seqOf(t) >= 2 ? '추가 ' + (seqOf(t) - 1) + ' ' : '';
      return '<button type="button" class="btn sm" data-ctarget="' + esc(t.tid) + '">' + esc(q + (dead ? '다시 상신' : '상신하기')) + ' →</button>';
    }).join('');
    return '<tr class="cgrp"><td colspan="10"><div class="cgh"><b>' + esc(g.label) + '</b><span class="cgn">' + n0(g.rows.length) + '건 · ' + won(g.cost) + '</span>' +
      (g.docs.length ? '<span class="cgd">' + g.docs.map(docChip).join('') + '</span>' : '') +
      (g.nOpen ? '<span class="cgo">상신 전 ' + n0(g.nOpen) + '줄</span>' : '') + btns + '</div></td></tr>';
  }
  function rowHtml(it, i, hist) {
    // 잠긴 줄(2026-11-03 — 결재 중·결재 완료 문서에 든 줄): 칸 막음 · 삭제 없음 · 여러 줄 고르기 막음 · 추천 칩·식대 안내 없음(tr.clock)
    var locked = lineLocked(it);
    var sg = !locked && !String(it.category || '').trim() ? R.suggest(it, hist) : null;
    // 식대 13,000원 비고 안내(2026-11-02) — 잠긴 줄(결재 중·완료 문서)은 고칠 수 없으니 표시하지 않는다(빈칸 need 와 같게)
    var mh = locked ? '' : mealHint(it);
    var inp = function (f, ph) {
      var v = String(it[f] == null ? '' : it[f]), need = f !== 'note' && !v.trim(), want = f === 'note' && !!mh;
      return '<input class="inp cin' + (need ? ' need' : '') + (want ? ' want' : '') + (f === 'purpose' ? ' wide' : '') + '" data-cid="' + it.id + '" data-f="' + f + '" maxlength="' + MAXLEN[f] +
        '" value="' + esc(v) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + (locked ? ' disabled' : '') + ' aria-label="' + (i + 1) + '번째 줄 ' + LABEL[f] + '"' +
        // 비고 칸 안내 글 — PC 표는 title(칸 크기·줄 맞춤 그대로), 폰·태블릿 카드는 칸 아래 작은 줄(.cmeal). 화면 읽기는 그 줄을 읽는다
        (f === 'note' ? ' aria-describedby="cmh' + it.id + '"' + (want ? ' title="' + esc(mh) + '"' : '') : '') +
        // 잠긴 칸은 글이 길면 「…」로 끝나니(CSS .cin:disabled) 전체 글을 title 로(2026-11-03 화면 다듬기)
        (locked && v.trim() && !want ? ' title="' + esc(v) + '"' : '') +
        // 사용목적 칸 최소 폭 220 → 180(2026-10-15) — PC 폭(1280)에서 맨 끝 「지우기」가 표 밖으로 잘리던 것
        (f === 'purpose' ? ' style="min-width:180px"' : '') + '>';
    };
    var cls = (MISSING[it.id] ? ' cmiss' : '') + (locked ? ' clock' : '');
    return '<tr data-crow="' + it.id + '"' + (cls ? ' class="' + cls.slice(1) + '"' : '') + '>' +
      '<td class="n" data-l="순번">' + (C.mselBox ? C.mselBox('c', { id: String(it.id), amt: it.amount,
        line: String(it.appr_date || '').slice(5).replace('-', '.') + ' ' + (it.merchant || '카드') + ' ' + n0(it.amount) + '원',
        why: locked ? '상신한 문서에 든 줄이라 지울 수 없어요' : '' }) : '') + (i + 1) + '</td>' +
      '<td data-l="승인일">' + esc(String(it.appr_date || '').slice(5).replace('-', '.')) + '</td>' +
      '<td class="dim" data-l="시간">' + esc(String(it.appr_time || '').slice(0, 5)) + '</td>' +
      // 「파일에 없는 줄」 표시는 가맹점 아래 줄에 — 가맹점 옆에 붙이면 칸이 넓어져 맨 끝 「지우기」가 표 밖으로 밀렸다(2026-10-15)
      '<td class="el" data-l="가맹점" title="' + esc(it.merchant || '') + '">' + esc(it.merchant || '—') +
        (cancelOf(it) ? '<div style="margin-top:3px;line-height:1"><span class="st bad" data-ccancel title="' + esc((it.src.cancel.file || 'ERP 파일') + '에서 전액 취소로 확인됐어요. 청구하지 않으려면 이 줄을 지워 주세요.') + '">전액 취소된 승인</span></div>'
          : MISSING[it.id] ? '<div style="margin-top:3px;line-height:1"><span class="st warn">파일에 없는 줄</span></div>' : '') + '</td>' +
      '<td class="el dim" data-l="업종">' + esc(it.biz_type || '') + '</td>' +
      '<td class="n total" data-l="승인금액">' + n0(it.amount) + '</td>' +
      // 추천은 칸 아래 점선 단추 하나로만 보인다 — 칸 안 흐린 글씨(placeholder)에 또 쓰지 않는다(2026-10-15)
      //   통행료·하이패스 줄은 예시도 「예: 통행료」(「후불하이패스3건」 줄에 「예: 중식대」가 보였다 — 2026-11-03 교육 자료 로봇)
      '<td data-l="구분">' + inp('category', tollLine(it) ? '예: 통행료' : '예: 중식대') +
        (sg ? '<button type="button" class="csug" data-csug="' + it.id + '" data-cat="' + esc(sg.cat) + '" title="' + esc(sg.why) + ' — 누르면 확정">' + esc(sg.cat) + ' ✓</button>' : '') + '</td>' +
      '<td data-l="사용목적">' + inp('purpose', '무엇에 썼는지') + '</td>' +
      '<td data-l="비고">' + inp('note', !locked && mealWants(it) ? MEAL_PH : '') +
        '<div class="cmeal" id="cmh' + it.id + '"' + (mh ? '>' + hintHtml(mh) : ' hidden>') + '</div></td>' +
      '<td class="n" data-l=""><span class="csave" id="cs' + it.id + '" aria-live="polite"></span>' +
        (locked ? '' : '<button type="button" class="btn sm" data-cdel="' + it.id + '" aria-label="' + (i + 1) + '번째 줄 삭제">삭제</button>') + '</td></tr>';
  }

  /* ── 칸 저장 — 칸마다 차례로(늦게 온 응답이 새 값을 덮지 않게), 다시 그리지 않는다 ── */
  // SAVE_T: 'id|f' → { t: 타이머, id, f, v, cyc } — 기다리는 칸(쓰는 중). 기간은 넣을 때 굳힌다(그사이 기간을 바꿔도 그 줄로 간다).
  var SAVE_T = {}, CHAIN = {}, SAVING = 0;
  // 저장 상태 줄(2026-10-12): INFL 'id|f' → id(보내는 중) · FAILED 'id|f' → { id, f, v, cyc }(마지막 저장이 실패한 칸과 그때 적은 값 — 「다시 저장」이 다시 보낸다, 2026-10-15)
  //   · LAST_SAVE 마지막으로 저장된 시각(ms)
  var INFL = {}, FAILED = {}, LAST_SAVE = 0;
  /** 그 줄 비고 칸의 식대 안내(주황 점선 · placeholder · title · 칸 아래 줄)를 지금 칸 값으로 다시 — 구분·비고를 적을 때마다(다시 그리지 않는다). */
  function paintMeal(id) {
    var tr = document.querySelector('tr[data-crow="' + id + '"]'), it = findMine(id);
    if (!tr || !it) return;
    var nt = tr.querySelector('.cin[data-f="note"]'), ct = tr.querySelector('.cin[data-f="category"]'), hl = $('cmh' + id);
    if (!nt || nt.disabled) return;
    var x = { category: ct ? ct.value : it.category, amount: it.amount, note: nt.value }, h = mealHint(x);
    nt.classList.toggle('want', !!h);
    nt.placeholder = mealWants(x) ? MEAL_PH : '';
    if (h) nt.title = h; else nt.removeAttribute('title');
    if (hl) { if (hl.getAttribute('data-h') !== h) { hl.innerHTML = h ? hintHtml(h) : ''; hl.setAttribute('data-h', h); } hl.hidden = !h; }
  }
  function queueSave(el, now) {
    var id = el.dataset.cid, f = el.dataset.f, k = id + '|' + f;
    if (f !== 'note') el.classList.toggle('need', !el.value.trim());
    if (f !== 'purpose') paintMeal(id);                 // 구분·비고가 바뀌면 식대 안내도 그 자리에서(2026-11-02)
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
    if (pending()) return '<span class="st warn">저장 중…</span> <span>칸에 적은 값을 보내고 있어요.</span>';
    // 실패한 칸은 서버 값으로 되돌려 둔다 — 그때 적은 값은 FAILED 에 남겨 「다시 저장」으로 다시 보낸다(2026-10-15, 「임시저장」 단추 대신).
    if (nf) return '<span class="st bad">저장 못 함 ' + n0(nf) + '곳</span> <span>적은 값이 되돌아갔어요. ‘다시 저장’을 누르면 적었던 값을 다시 보내요.</span>' +
      '<button type="button" class="btn sm" id="btnCRetry" data-cretry>다시 저장</button>';
    var t = lastSaveMs(rows);
    // 안내 글은 늘 둘째 줄(.csaven) — 한 덩이로 두면 좁은 폰에서 둘째 줄이 「· 마지막 저장…」처럼 「·」로 시작했다(2026-10-28 로봇)
    //   「구분·사용목적·비고는」은 한 덩이(keepDots) — 360·390 에서 「…적어 둔 구분·」 / 「사용목적·비고는…」으로 갈렸다(2026-11-03 화면 다듬기)
    return '<span class="st ok">자동 저장됨</span>' + (t ? ' <span>· 마지막 저장 ' + hhmm(t) + '</span>' : '') +
      ' <span class="csaven">' + keepDots('같은 달 ERP 엑셀을 다시 올리면 새 줄만 추가되고, 적어 둔 구분·사용목적·비고는 그대로예요.') + '</span>';
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

  /* ── 그 사이 상신돼 잠긴 줄(2026-11-03 회귀 N2) — 칸 저장이 CARD_LOCKED 로 막히면(다른 탭·기기에서 그 줄이 든 문서를 상신함) 결재 목록과 줄을
     다시 받아 잠긴 줄을 잠긴 모양으로 바꾼다(칸 막음 · 삭제·추천 숨김 · tr.clock). 다시 그리지 않고 그 자리에서 — 「저장 못 함」 표시·「다시 저장」과
     그때 적은 값(FAILED)은 그대로 둔다(그 문서를 회수하면 다시 보낼 수 있다). 「추천 구분 채우기」는 끝난 뒤 한 번에 보고 화면을 다시 그린다. ── */
  var RELOCK_T = null, FILLING = false, RETRYING = false;
  /** 표 줄의 잠금을 지금 자료대로 그 자리에서. → { any: 바뀐 줄이 있다, need: 풀 줄에 단추가 없어(처음부터 잠긴 줄로 그렸다) 다시 그려야 한다 } */
  function paintLocks() {
    var out = { any: false, need: false };
    [].forEach.call(document.querySelectorAll('.ctab tr[data-crow]'), function (tr) {
      var id = tr.getAttribute('data-crow'), it = findMine(id);
      if (!it) return;
      var L = lineLocked(it);
      if (tr.classList.contains('clock') === L) return;
      out.any = true;
      if (!L && !tr.querySelector('[data-cdel]')) { out.need = true; return; }
      tr.classList.toggle('clock', L);
      // 잠긴 칸은 전체 글을 title 로(글이 길면 「…」로 끝난다 — 그린 때의 inp 와 같게) · 풀리면 뗀다(비고 칸 식대 안내 title 은 아래 paintMeal 이 다시 단다)
      [].forEach.call(tr.querySelectorAll('.cin'), function (i) { i.disabled = L; if (L && i.value.trim()) i.title = i.value; else i.removeAttribute('title'); });
      [].forEach.call(tr.querySelectorAll('[data-cdel]'), function (b) { b.hidden = L; });
      var cat = tr.querySelector('.cin[data-f="category"]');
      [].forEach.call(tr.querySelectorAll('[data-csug]'), function (b) { b.hidden = L || !!(cat && cat.value.trim()); });
      var box = tr.querySelector('input[data-msel]'); if (box) box.disabled = L;
      var mh = $('cmh' + id);
      if (L) { if (mh) mh.hidden = true; } else paintMeal(id);
    });
    return out;
  }
  /** 잠금이 바뀐 줄을 그 자리에서 바꾸고 숫자 칸·저장 줄을 다시 쓴다. 그 자리에서 못 바꾸면(위 need) 쓰는 중이 아닐 때 다시 그린다. */
  function lockPaint() {
    var r = paintLocks();
    if (r.need && !typing()) { C.render(); return; }
    if (r.any) paintBlank();
    paintSave();
  }
  /** 칸 저장이 잠김으로 막힌 뒤 — 결재 목록과 그 기간 줄을 다시 받아(받는 동안 지금 줄 그대로) 잠긴 줄을 잠긴 모양으로. 여러 칸이 한꺼번에 막혀도 한 번만. */
  function relockSoon(cyc) {
    if (FILLING) return;
    clearTimeout(RELOCK_T);
    RELOCK_T = setTimeout(function () {
      RELOCK_T = null;
      Promise.all([loadAppr(), loadItems(cyc, false, true, true)]).then(function () { return settledFor(cyc); }).then(function () {
        var S = C.state();
        if (cyc === S.CYCKEY && CVIEWS.indexOf(S.VIEW) >= 0) lockPaint();
      });
    }, 150);
  }
  /** 「다시 저장」 — 먼저 결재 목록과 줄을 다시 받아 그 사이 잠긴 줄(상신한 문서에 듦)은 보내지 않고 그 까닭을 알린다(잠긴 모양으로) ·
   *  열린 줄은 그때 적었던 값을 다시 넣고 보낸다(그 사이 문서가 회수돼 풀렸으면 풀린 모양으로). 끝나면 알린다(또 실패하면 그 까닭은 칸마다 알림으로). */
  function retrySaves() {
    var list = Object.keys(FAILED).map(function (k) { return FAILED[k]; }).filter(function (x) { return x && x.v != null; });
    if (!list.length) { C.toast('다시 보낼 값이 없어요. ‘저장 못 함’으로 표시된 칸을 다시 적어 주세요.', true); paintSave(); return; }
    if (RETRYING) return;
    RETRYING = true;
    var cyc = C.state().CYCKEY, b = $('btnCRetry');
    if (b) b.disabled = true;
    Promise.all([loadAppr(), loadItems(cyc, false, true, true)]).then(function () { return settledFor(cyc); }).then(function () {
      RETRYING = false;
      var gone = [], send = [];
      list.forEach(function (x) {
        if (!FAILED[x.id + '|' + x.f]) return;               // 받는 사이 다시 적어 저장됐다
        var it = x.cyc === cyc ? findMine(x.id) : null;
        if (it && apprKnown() && lineLocked(it)) gone.push({ x: x, it: it }); else send.push(x);
      });
      gone.forEach(function (g) { delete FAILED[g.x.id + '|' + g.x.f]; mark(g.x.id, ''); });
      lockPaint();
      send.forEach(function (x) {
        var el = document.querySelector('.cin[data-cid="' + x.id + '"][data-f="' + x.f + '"]');
        if (el && el !== document.activeElement) { el.value = x.v; if (x.f !== 'note') el.classList.toggle('need', !String(x.v).trim()); if (x.f !== 'purpose') paintMeal(x.id); }
        saveCell(x.id, x.f, x.v, x.cyc);
      });
      paintSave();
      return settleSaves().then(function () {
        var bad = send.filter(function (x) { return FAILED[x.id + '|' + x.f]; }).length, ok = send.length - bad;
        if (gone.length) C.toast((ok ? n0(ok) + '곳을 다시 저장했어요. ' : '') + n0(gone.length) + '곳은 다시 보내지 않았어요. ' + lockSayFor(docOfLine(gone[0].it)), true);
        else if (bad) C.toast('또 저장하지 못한 칸이 ' + n0(bad) + '곳 있어요. ‘저장 못 함’ 표시를 확인해 주세요.', true);
        else C.toast(n0(send.length) + '곳을 다시 저장했어요.');
        paintSave();
      });
    }).catch(function (e) { RETRYING = false; console.error('법인카드 다시 저장:', e); paintSave(); });
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
    if (el && prev !== undefined) { el.value = prev == null ? '' : prev; if (f !== 'note') el.classList.toggle('need', !el.value.trim()); if (f !== 'purpose') paintMeal(id); }
  }
  function rowIn(cyc, id) {
    var x = ITEMS[itemKey(false, cyc)];
    var find = function () { return mineRows(cyc).filter(function (it) { return String(it.id) === String(id); })[0] || null; };
    return x && x.wait && !x.rows ? x.wait.then(find) : Promise.resolve(find());    // 다시 받는 중이면 받은 뒤에 찾는다
  }
  function saveNow(id, f, v, cyc) {
    return rowIn(cyc, id).then(function (it) {
      if (!it) {
        failCell(id, f, undefined, '그 줄을 찾지 못해 저장하지 못했어요. 지워졌거나 다른 기간일 수 있으니 목록을 다시 불러온 뒤 적어 주세요.', v, cyc);
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
        if (!out || !out.length) throw new Error('CARD_LOCKED');     // 0행 = 잠긴 줄과 같은 뜻(2026-11-03 SPEC §5-1 — why 가 말로 바꾼다)
        it[f] = out[0][f]; it.updated_at = out[0].updated_at;
        delete FAILED[k]; LAST_SAVE = Date.now();
        mark(id, '저장됨');
      }).catch(function (e) {
        it[f] = prev;
        failCell(id, f, prev, failMsg('저장하지 못했어요', e, why(e, it)), v, cyc);      // 그 줄의 문서 상태대로(고침 1 L3)
        // 그 사이 상신돼 잠겼다(다른 탭·기기) — 결재 목록·줄을 다시 받아 잠긴 줄을 잠긴 모양으로(회귀 N2 — 「저장 못 함 · 다시 저장」만 남지 않게)
        if (/CARD_LOCKED/.test(String((e && e.message) || ''))) relockSoon(cyc);
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
    // 건수·금액·구분 합계 = 모든 줄 · 빈칸 = 열린 줄(상신한 문서에 든 줄은 고칠 수 없다, 2026-11-03 SPEC §5-2)
    var T = R.totals(rows), blank = R.blankRows(openOf(rows));
    var all = Object.keys(T.by_cat).filter(function (k) { return k !== '(빈칸)'; })
      .map(function (k) { return { c: k, n: T.by_cat[k].n, sum: T.by_cat[k].sum }; }).sort(function (x, y) { return y.sum - x.sum; });
    var top = all.slice(0, 2), rest = all.slice(2);
    // 많이 쓴 구분 둘 + 나머지는 「외 N구분」 한 칸(2026-10-15 — 둘만 보여 위 합계와 안 맞아 보이던 것)
    var restSum = rest.reduce(function (s, x) { return s + (Number(x.sum) || 0); }, 0), restN = rest.reduce(function (s, x) { return s + x.n; }, 0);
    return fact('건수', n0(T.n) + '<small>건</small>', 'ERP에서 올린 승인') +
      // 줄이 없으면 빈칸 칸은 뺀다(할 일이 아니다, 2026-11-02 화면 로봇)
      (rows.length ? fact('빈칸', '<span id="cBlankN">' + n0(blank) + '</span><small>줄</small>', '구분·사용목적을 채워야 상신할 수 있어요', blank > 0) : '') +
      top.map(function (x) { return fact(x.c, won(x.sum), n0(x.n) + '건'); }).join('') +
      // 「N건 · 구분 · 구분 …」은 조각 사이에서만 줄을 바꾼다(줄 처음 「· 소모품비」 없음 — 2026-11-03 화면 다듬기, 360)
      (rest.length ? fact('외 ' + n0(rest.length) + '구분', won(restSum), { html: dnLine([n0(restN) + '건'].concat(rest.map(function (x) { return x.c; }))) }) : '');
  }
  function sectN(rows) {
    var blank = R.blankRows(openOf(rows)), nMiss = rows.filter(function (it) { return MISSING[it.id] && !cancelOf(it); }).length, nCan = rows.filter(cancelOf).length;
    return n0(rows.length) + '건' + (blank ? ' · 빈칸 ' + n0(blank) + '줄' : '') + (nCan ? ' · 전액 취소된 승인 ' + n0(nCan) : '') + (nMiss ? ' · 파일에 없는 줄 ' + n0(nMiss) : '');
  }
  /** 전액 취소로 확인된 승인이 아직 남아 있으면 띠 하나(2026-10-20 AU2 #5 — 검증 경고). 고칠 수 없는 줄(상신한 문서에 든 줄 — 2026-11-03)은 세지 않는다. */
  function cancelBand(rows) {
    var c = openOf(rows).filter(cancelOf);
    if (!c.length) return '';
    var amt = c.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0);
    return '<div class="awarn" id="cCancelBand">' + ic('alert', 15) + '<span><b>전액 취소된 승인 ' + n0(c.length) + '건(' + won(amt) + ')이 아직 남아 있어요.</b> ' +
      '그대로 상신하면 취소된 금액까지 청구되니 표에서 ‘전액 취소된 승인’ 줄을 지워 주세요.</span></div>';
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
    var n = openOf(rows).filter(function (it) {
      var el = document.querySelector('.cin[data-cid="' + it.id + '"][data-f="category"]');
      return !String(el ? el.value : (it.category || '')).trim() && R.suggest(it, hist);
    }).length;
    b.textContent = '추천 구분 채우기 (' + n0(n) + ')';
    b.hidden = !n;
  }
  function pending() { return SAVING > 0 || Object.keys(SAVE_T).length > 0; }
  function fillSuggest() {
    var S = C.state(), rows = mineRows(S.CYCKEY), hist = histFor(rows), todo = [];
    if (monthLocked(me(), S.CYCKEY)) return;
    openOf(rows).forEach(function (it) {             // 상신한 문서에 든 줄(잠긴 줄)은 건드리지 않는다(2026-11-03)
      if (String(it.category || '').trim() || SAVE_T[it.id + '|category']) return;     // 쓰는 중인 칸은 건드리지 않는다
      var sg = R.suggest(it, hist);
      if (sg) todo.push({ id: String(it.id), cat: sg.cat });
    });
    if (!todo.length) { C.toast('채울 추천이 없어요.'); return; }
    C.toast('추천 구분 ' + n0(todo.length) + '줄을 채우는 중…');
    var cyc = S.CYCKEY;
    FILLING = true;
    C.vx.pool(todo, 3, function (x) {
      // 화면의 칸도 바로 채운다 — 다른 칸에 쓰는 중이면 다시 그리지 않으므로(커서가 튄다) 칸 값만 바꾼다
      var inp = document.querySelector('.cin[data-cid="' + x.id + '"][data-f="category"]');
      if (inp && inp !== document.activeElement && !inp.value.trim()) { inp.value = x.cat; inp.classList.remove('need'); paintMeal(x.id); }
      var chip = document.querySelector('[data-csug="' + x.id + '"]'); if (chip) chip.remove();
      return saveCell(x.id, 'category', x.cat, cyc);
    }).then(function () {
      FILLING = false;
      // ★ 칸 저장은 실패해도 reject 하지 않는다(그 칸에 「저장 못 함」을 단다) — 그래서 끝난 뒤 실패한 칸을 센다(2026-10-20 AU2 #14:
      //   결재 중 잠김 등으로 하나도 안 들어갔는데 「N줄에 추천 구분을 채웠습니다」라고 했다). 실패가 있으면 그 수를 알리고 다시 받는다.
      var bad = todo.filter(function (x) { return FAILED[x.id + '|category']; }).length, ok = todo.length - bad;
      if (!bad) {
        C.toast(n0(todo.length) + '줄에 추천 구분을 채웠어요. 맞는지 한 번 보세요.');
        if (!typing()) C.render(); else paintSug();
        return;
      }
      C.toast((ok ? n0(ok) + '줄은 채웠지만 ' : '') + n0(bad) + '줄은 저장하지 못했어요. ‘저장 못 함’ 칸을 확인하고, 결재 중이면 회수한 뒤 다시 채워 주세요.', true);
      // 줄만이 아니라 결재 목록도 다시 받는다(회귀 N2) — 그 사이 다른 탭·기기에서 상신했으면 그 줄을 잠긴 모양으로 다시 그린다(예전 판처럼 잠긴 화면).
      //   잠긴 줄에 채우려던 추천은 버린다(사람이 적은 값이 아니다 — 다시 보낼 것이 없다). 열린 줄의 실패는 「다시 저장」으로 그대로
      dropItems(cyc);
      Promise.all([loadAppr(), loadItems(cyc, false, true)]).then(function () { return settledFor(cyc); }).then(function () {
        todo.forEach(function (x) { var it = findMine(x.id), k = x.id + '|category'; if (FAILED[k] && it && apprKnown() && lineLocked(it)) delete FAILED[k]; });
        if (cyc !== C.state().CYCKEY) return;
        if (!typing()) C.render(); else { lockPaint(); paintSug(); }
      });
    }, function () { FILLING = false; });
  }
  function openDel(id) {
    var it = findMine(id); if (!it) return;
    C.openPanel('이 줄을 삭제할까요?', String(it.appr_date) + ' · ' + (it.merchant || '') + ' · ' + n0(it.amount) + '원',
      '<div class="anote" style="margin-top:0">지운 줄이 ERP 파일에 있으면 다음에 올릴 때 다시 들어와요. 그때 구분·사용목적은 새로 적어야 해요.</div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnCDelGo" data-id="' + esc(String(it.id)) + '">삭제</button>');
  }
  /** 한 줄 지우기 — 한 건 지우기·여러 줄 지우기(C.msel)가 같은 길. */
  function delOne(id) {
    return rest('/rest/v1/card_items?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=representation' } })
      .then(function (rows) {
        if (!rows || !rows.length) throw new Error('CARD_LOCKED');   // 0행 = 잠긴 줄과 같은 뜻(2026-11-03 SPEC §5-1)
        delete MISSING[id];
        Object.keys(FAILED).forEach(function (k) { if (k.split('|')[0] === String(id)) delete FAILED[k]; });
      });
  }
  if (C.mselDef) C.mselDef('c', {
    noun: '카드 내역', note: '지운 줄이 ERP 파일에 있으면 다음에 올릴 때 다시 들어와요. 그때 구분·사용목적은 새로 적어야 해요.',
    del: function (id) { return findMine(id) ? delOne(id) : Promise.reject(new Error('이미 없는 줄이에요')); },
    // 까닭만 — 이어 붙이는 쪽이 이미 「…은 지우지 못했어요.」라고 말한다(2026-10-24 검수 — 같은 말이 두 번 나왔다, 개인경비와 같게)
    why: function (e) { var m = String((e && e.message) || ''); return /이미 없는|권한이 없거나/.test(m) ? m : why(e); },
    done: function () { var S = C.state(); dropItems(S.CYCKEY); loadItems(S.CYCKEY, false, true).then(function () { C.render(); }); }
  });
  function runDel(id) {
    var b = $('btnCDelGo'); if (b) { b.disabled = true; b.textContent = '지우는 중…'; }
    delOne(id)
      .then(function () {
        C.closePanel(); C.toast('지웠어요.');
        if (C.markGone) C.markGone(['tr[data-crow="' + id + '"]']);   // 움직임 ③ — 지운 줄 흐리게
        var S = C.state(); dropItems(S.CYCKEY);
        return loadItems(S.CYCKEY, false, true).then(function () { C.render(); });
      }).catch(function (e) {
        if (b && document.contains(b)) { b.disabled = false; b.textContent = '삭제'; }
        C.toast(failMsg('지우지 못했어요', e, why(e, findMine(id))), true);
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
    if (C.isMulti()) { C.toast('카드 내역은 한 기간씩 올려요. 기간을 하나만 골라 주세요.', true); return; }
    // 그 달 통째 잠금(살아 있는 여러 카드 예전 문서)일 때만 막는다 — 카드 한 장 문서가 결재 중이어도 새 줄·다른 카드는 올린다(2026-11-03 SPEC §5-3)
    if (monthLocked(me(), S.CYCKEY)) { C.toast('결재 중이거나 끝난 기간이라 올릴 수 없어요.', true); return; }
    if (C_SENDING) { C.toast('앞서 고른 파일을 아직 올리는 중이에요. 끝난 뒤 다시 열어 주세요.'); return; }
    CUP = { cyc: S.CYCKEY, busy: false, sent: false, res: null, plan: null, file: '', useOwner: true };
    C.openPanel('ERP 엑셀 올리기 — 법인카드', cycName(S.CYCKEY) + ' · ' + R.span(S.CYCKEY),
      '<div class="drop" id="cDrop" style="margin-bottom:14px">' +
      '<div class="dt">ERP에서 다운로드한 <b>내 법인카드 승인내역</b> 엑셀을 올려 주세요</div>' +
      '<div class="dd">.xls, .xlsx 파일이에요. PC에서는 여기에 끌어다 놓아도 돼요.<br>0원·취소 줄과 ' + esc(R.span(S.CYCKEY)) + ' 밖의 줄은 자동으로 빠져요.</div>' +
      '<label class="btn" style="margin-top:14px">파일 고르기<input type="file" id="cFile" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="sr"></label>' +
      '</div><div id="cPrev"></div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnCUpGo" disabled>올리기</button>', true);
    C.bindDrop($('cDrop'), function (fs) { readFile(fs && fs[0]); });
    loadItems(S.CYCKEY, false);            // 다시 올리기 계획에 쓸 지금 줄(이미 있으면 그대로)
    ensureXlsx().catch(function () { });   // 미리 받아 둔다
  }
  function prevMsg(t) { var el = $('cPrev'); if (el) el.innerHTML = '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(t) + '</span></div>'; }
  function replan(s) {
    var cur = mineRows(s.cyc), lk = {};
    // 상신한 문서에 든 줄(잠긴 줄)은 보내지 않는다(2026-11-03 SPEC §5-3) — card-erp plan 이 frozen(그대로 둠)·frozenDiff(ERP 값이 달라짐)·frozenCancelled(전액 취소)로 따로 묶고
    //   updates·missing·cancelled 는 열린 줄만. 새 줄(inserts)은 그대로 넣는다(살아 있는 문서가 있어도).
    cur.forEach(function (it) { if (lineLocked(it)) lk[String(it.id)] = true; });
    // 뺀 줄(dropped)도 넘긴다 — 이미 올린 승인이 이 파일에서 전액 취소로 확인되면 plan.cancelled 로 따로 묶인다(2026-10-20 AU2 #5)
    s.plan = E.plan(cur, s.res.items.filter(function (it) { return s.useOwner || !it.owner_mismatch; }), s.res.dropped, { locked: lk });
  }
  function readFile(f) {
    var s = CUP;
    if (!f || !s || s.busy) return;
    // ★ 5MB 읽기 상한은 여기서(card-erp.js 는 크기를 보지 않는다) — SheetJS 에 넘기기 전에 막아야 큰 파일에서 브라우저가 멈추지 않는다.
    if (f.size > MAX_BYTES) {
      // 앞서 고른 파일의 결과·「N건 올리기」 단추가 남아 눌리지 않게 지운다(검증 로봇 L10, 2026-11-02)
      s.res = null; s.plan = null;
      var b0 = $('btnCUpGo'); if (b0) { b0.disabled = true; b0.textContent = '올리기'; }
      prevMsg('파일이 너무 커요(' + (f.size / 1048576).toFixed(1) + 'MB). 5MB까지 올릴 수 있으니 ERP에서 한 달치만 다운로드해서 올려 주세요.');
      return;
    }
    s.busy = true; s.res = null; s.plan = null; s.painted = false;
    var el = $('cPrev'); if (el) el.innerHTML = '<div class="pdfwait"><div class="spin"></div><div role="status">엑셀을 읽는 중…</div></div>';
    var btn = $('btnCUpGo'); if (btn) btn.disabled = true;
    Promise.all([ensureXlsx(), f.arrayBuffer(), loadItems(s.cyc, false)]).then(function (r) {
      if (CUP !== s) return;
      var bytes = new Uint8Array(r[1]);
      if (!E.looksLikeSheet(bytes)) throw new Error('NOT_SHEET');
      var res = E.parse(E.sheetRows(r[0], bytes), { cycle: s.cyc, range: R.cycleRange(s.cyc), me: myFullName(), file: f.name, known: mineRows(s.cyc) });   // range — 연말 설정 기간(2026-10-20) · known — 하이패스 카드 판정(2026-11-02)
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
      prevMsg(m === 'NOT_SHEET' ? 'ERP 엑셀 파일(.xls, .xlsx)이 아니에요. ERP에서 엑셀로 다운로드한 파일을 올려 주세요.'
        : m === 'NO_HEADER' ? '머리글(법인카드, 승인일자, 승인번호, 가맹점, 승인금액)을 찾지 못했어요. 빠진 것: ' + (((e.res && e.res.missing) || []).join(', ') || '없음')
        : m === 'TOO_MANY' ? '줄이 너무 많아요(' + n0(E.MAX_ROWS) + '줄까지). 한 달치만 다운로드해서 올려 주세요.'
        : m === 'XLSX' ? '엑셀 읽기 도구를 불러오지 못했어요. 새로고침한 뒤 다시 해 주세요.'
        : '파일을 읽지 못했어요. ERP에서 다시 다운로드해서 올려 주세요.');
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
      h += '<div class="awarn" id="cErpBad">' + ic('alert', 15) + '<span><b>ERP 합계가 맞지 않아요.</b> 파일 합계는 ' + won(erp.fileTotal) + '인데, 승인 ' + won(erp.approved) + ' − 취소 ' + won(erp.cancelled) + ' = ' + won(erp.net) + '이에요' +
        '. 파일이 잘렸거나 읽지 못한 줄이 있을 수 있으니 ‘뺀 줄’을 확인해 주세요.</span></div>';
    }
    // 읽지 못해 뺀 줄 — 특히 승인번호가 비었거나 너무 긴 「취소」 줄은 원래 승인과 짝을 못 지어 원래 승인이 그대로 들어간다.
    var bad = res.dropped.filter(function (d) { return d.reason === 'invalid'; }), badCancel = bad.filter(function (d) { return d.cancel; });
    if (bad.length) {
      nCheck += bad.length;
      h += '<div class="awarn" id="cBadRows">' + ic('alert', 15) + '<span>승인일, 승인번호, 금액을 읽지 못해 뺀 줄이 <b>' + n0(bad.length) + '건</b> 있어요.' +
        (badCancel.length ? ' 그 가운데 <b>취소 줄 ' + n0(badCancel.length) + '건</b>은 원래 승인과 맞추지 못해 <b>원래 승인이 그대로 들어가요</b>.' +
          ' 취소된 승인이면 올린 뒤 표에서 그 줄을 지워 주세요.' : ' ‘뺀 줄’에서 확인해 주세요.') + '</span></div>';
    }
    // 이 기간에 넣을 줄이 없는 파일 — 다른 달·읽지 못한 줄이 있으면 「다른 달 파일인지」, 아니면(0원·취소 줄뿐·승인 줄 없음) 안내만(2026-11-02).
    //   0원·취소로 뺀 줄도 날짜가 이 기간 밖이면 「다른 달」 — card-erp 가 0원·취소를 달 검사보다 먼저 뺀다(화면 로봇 C1b).
    if (!res.items.length) {
      var zrg = R.cycleRange(s.cyc);
      var outRange = function (d) { return !!d.appr_date && !(d.appr_date >= zrg.lo && d.appr_date < zrg.hi); };
      var otherRows = res.dropped.some(function (d) { return d.reason === 'month' || d.reason === 'invalid' || outRange(d); });
      if (otherRows) h += '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(cycName(s.cyc)) + '(' + esc(R.span(s.cyc)) + ') 줄이 없어요. 다른 달 파일인지 확인해 주세요.</span></div>';
      else h += '<div class="fhint">' + esc(cycName(s.cyc)) + '에 새로 넣을 줄이 없어요. ' + (res.dropped.length ? '0원·취소 줄만 있어 빼요.' : '이 파일에는 승인 줄이 없어요.') + '</div>';
    }
    if (res.owner.mismatch && s.useOwner) nCheck += res.owner.mismatch;
    if (res.owner.mismatch) {
      var names = {};
      res.items.forEach(function (it) { if (it.owner_mismatch) names[it.owner_name] = 1; });
      var who = Object.keys(names).join(', ');
      h += '<div class="awarn">' + ic('alert', 15) + '<span>' + (res.owner.all
        ? '이 파일은 <b>' + esc(who) + '</b> 님 카드 내역 같아요. 내 이름(' + esc(myFullName()) + ')으로 된 카드 내역만 올려 주세요.'
        : '소유자가 내 이름(' + esc(myFullName()) + ')이 아닌 줄이 ' + n0(res.owner.mismatch) + '건 있어요(' + esc(who) + ').') + '</span></div>' +
        '<label class="finall" style="margin:6px 0 10px"><input type="checkbox" id="cOwn"' + (s.useOwner ? ' checked' : '') + '> 소유자가 다른 줄 ' + n0(res.owner.mismatch) + '건도 올리기' +
        (s.useOwner ? '' : ' <span class="dim">(지금은 빼 둬요)</span>') + '</label>';
    }
    // 이미 올린 승인 가운데 이 파일에서 전액 취소로 확인된 것(2026-10-20 AU2 #5) — 기본 「같이 지우기」.
    //   끄면 지우지 않고 그 줄에 「전액 취소된 승인」 표시를 남긴다(새로 고침해도 남음 — src.cancel). 돈이 틀리는 경고라 숫자 칸보다 위에.
    var canc = pl.cancelled || [], nDel = s.delCancel ? canc.length : 0;
    var nMark = s.delCancel ? 0 : canc.filter(function (e) { return !cancelOf(e); }).length;
    if (canc.length) {
      var cAmt = canc.reduce(function (a2, e) { return a2 + (Number(e.amount) || 0); }, 0);
      if (!s.delCancel) nCheck += canc.length;
      h += '<div class="awarn" id="cCancelGone">' + ic('alert', 15) + '<span><b>이미 올린 승인 ' + n0(canc.length) + '건(' + won(cAmt) + ')이 이 파일에서 전액 취소로 확인됐어요.</b> ' +
        '그대로 두면 취소된 결제가 청구돼요. 대상: ' + esc(canc.slice(0, 5).map(function (e) {
          return String(e.appr_date || '').slice(5).replace('-', '.') + ' ' + (e.merchant || '') + ' ' + n0(e.amount) + '원';
        }).join(', ')) + (canc.length > 5 ? ' 외 ' + n0(canc.length - 5) + '건' : '') + '</span></div>' +
        '<label class="finall" style="margin:6px 0 10px"><input type="checkbox" id="cCancelDel"' + (s.delCancel ? ' checked' : '') + '> 취소된 승인 ' + n0(canc.length) + '건 같이 삭제' +
        (s.delCancel ? '' : ' <span class="dim">(지금은 지우지 않고 표시만 해요)</span>') + '</label>';
    }
    // 이미 상신한 문서에 든 줄(잠긴 줄, 2026-11-03 SPEC §5-3) — 보내지 않는다. ERP 값이 달라졌거나 전액 취소로 확인되면 돈이 틀릴 수 있어 숫자 칸보다 위에(「확인 N건」에 센다)
    var fz = pl.frozen || [], fzd = pl.frozenDiff || [], fzc = pl.frozenCancelled || [];
    // 고칠 길은 그 줄 문서의 상태대로(고침 1 L3) — 결재가 끝난 문서는 회수·반려를 받을 수 없다(관리자 정정). 섞이면 둘 다 말한다
    var fixHow = function (ids, act) {
      var mine0 = mineRows(s.cyc), st = ids.map(function (id) { var it = mine0.filter(function (x) { return String(x.id) === String(id); })[0], a = docOfLine(it); return a ? a.status : ''; });
      var appr = st.filter(function (x) { return x === 'approved'; }).length;
      if (appr && appr === st.length) return '결재가 끝난 문서라 ' + act + ' 관리자에게 정정을 요청해 주세요.';
      return '그 문서를 회수하거나 반려받은 뒤 ' + (act === '고치려면' ? '다시 올려' : '지워') + ' 주세요.' + (appr ? ' 결재가 끝난 문서는 관리자에게 정정을 요청해 주세요.' : '');
    };
    if (fzd.length) {
      nCheck += fzd.length;
      var dh = fixHow(fzd.map(function (x) { return x.id; }), '고치려면');
      h += '<div class="awarn" id="cFrozenDiff">' + ic('alert', 15) + '<span><b>이미 상신한 문서에 든 줄 ' + n0(fz.length || fzd.length) + '건은 그대로 둬요.</b> ' +
        '그 가운데 ' + n0(fzd.length) + '건은 ERP 값이 달라졌어요. ' + (/^결재가 끝난/.test(dh) ? dh : '고치려면 ' + dh) + '</span></div>';
    }
    if (fzc.length) {
      nCheck += fzc.length;
      h += '<div class="awarn" id="cFrozenCancel">' + ic('alert', 15) + '<span><b>상신한 문서에 든 승인 ' + n0(fzc.length) + '건이 이 파일에서 전액 취소로 확인됐어요.</b> ' +
        fixHow(fzc.map(function (x) { return x.id; }), '지우려면') + '</span></div>';
    }
    h += '<div class="facts cfacts">' +
      fact('새 줄', n0(pl.inserts.length) + '<small>줄</small>', '처음 들어오는 승인') +
      fact('바뀐 줄', n0(pl.updates.length) + '<small>줄</small>', 'ERP 칸만 바꾸고 구분·사용목적은 그대로 둬요') +
      fact('그대로', n0(pl.same.length) + '<small>줄</small>', '이미 같은 값') +
      fact('올릴 금액', won(amt), '새 줄 + 바뀐 줄') +
      fact('뺀 줄', n0(res.dropped.length) + '<small>줄</small>', '0원·취소·다른 달 등') + '</div>';
    if (erp.found && erp.ok) h += '<div class="pdfok">' + ic('check', 15) + '<span>ERP 합계가 맞아요. 파일 합계 ' + won(erp.fileTotal) + ' = 승인 ' + won(erp.approved) + ' − 취소 ' + won(erp.cancelled) + '</span></div>';
    else if (!erp.found) h += '<div class="fhint">파일에 ‘합계’ 줄이 없어 ERP 합계와 비교하지 못했어요.</div>';
    if (fz.length && !fzd.length) h += '<div class="fhint" id="cFrozen">이미 상신한 문서에 든 줄 ' + n0(fz.length) + '건은 그대로 둬요.</div>';
    if (pl.missing.length) h += '<div class="fhint">이 기간에 이미 있는데 <b>파일에 없는 줄 ' + n0(pl.missing.length) + '건</b>은 지우지 않아요. 올린 뒤 표에 ‘파일에 없는 줄’로 표시되니 필요 없으면 지워 주세요.</div>';
    if (res.dropped.length) {
      h += '<section class="sect" style="margin-top:12px"><div class="hd"><h2>뺀 줄</h2><span class="cnt">' + n0(res.dropped.length) + '줄</span></div>' +
        '<div class="panel"><div class="scroll" data-rows><table class="cdrop"><thead><tr><th class="n">엑셀 행</th><th>승인일</th><th>승인번호</th><th>가맹점</th><th class="n">금액</th><th>이유</th></tr></thead><tbody>' +
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
      b.textContent = !nAct ? '올릴 줄이 없어요' : [nGo ? n0(nGo) + '건 올리기' : '', nDel ? '취소 ' + n0(nDel) + '건 삭제' : '', nMark ? '취소 ' + n0(nMark) + '건 표시' : '']
        .filter(Boolean).join(' · ') + (nCheck ? ' · 확인 ' + n0(nCheck) + '건' : '');
      b.title = nCheck ? '위의 경고를 확인한 뒤 올려 주세요' : '';
    }
    // 경고가 있으면 창 안을 미리보기 머리까지 내려 둔다(올리기 칸 아래에 묻히지 않게) — 뒤 화면은 건드리지 않는다
    var pb = $('pBody');
    var firstPaint = !s.painted; s.painted = true;      // 새 파일의 첫 그림에서만 — 체크박스 등으로 다시 그릴 때는 자리를 지킨다
    if (pb && firstPaint && (erpBad || bad.length || canc.length || fzd.length || fzc.length)) pb.scrollTop += Math.max(0, el.getBoundingClientRect().top - pb.getBoundingClientRect().top - 8);
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
        return p.then(function () { return delOne(String(e.id)).then(function () { nDel++; }, function (er) { delFail.push(failMsg('지우지 못했어요', er, why(er, e))); }); });
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
      var msg = '새 줄 ' + n0(s.plan.inserts.length) + '줄, 바뀐 줄 ' + n0(s.plan.updates.length) + '줄을 올렸어요.' +
        (nDel ? ' 전액 취소된 승인 ' + n0(nDel) + '줄을 지웠어요.' : '') +
        (toMark.length ? ' 전액 취소된 승인 ' + n0(nMark) + '줄은 지우지 않고 표에 표시했어요.' : '') +
        (s.plan.missing.length ? ' 파일에 없는 ' + n0(s.plan.missing.length) + '줄도 표에 표시했어요.' : '');
      if (delFail.length) C.toast(msg + ' 취소된 승인 ' + n0(delFail.length) + '줄은 남았어요. ' + delFail[0], true);
      else C.toast(msg);
    }).catch(function (e) {
      // 그 사이(다른 탭·기기에서) 상신돼 잠긴 줄이 생겼다(2026-11-03 SPEC §5-3) — 결재 목록·줄을 다시 받아 계획을 새로 세운다(아래). 일부 들어간 줄은 그대로
      var lk = /CARD_LOCKED/.test(String((e && e.message) || ''));
      if (lk) s.relock = true;
      // 일부만 들어갔으면 그 사실을 먼저(2026-10-24 검수 — 「다시 해 주세요」 뒤에 덧붙어 읽혔다)
      C.toast(lk ? (done ? n0(done) + '줄만 올렸어요. ' : '') + '그 사이 상신된 줄이 있어 올리지 못했어요. 목록을 다시 불러온 뒤 다시 올려 주세요.'
        : failMsg(done ? n0(done) + '줄만 올리고 나머지는 올리지 못했어요' : '올리지 못했어요', e, why(e)), true);
      if (b && document.contains(b)) { b.disabled = false; b.textContent = '다시 올리기'; }
    }).then(function () {
      s.busy = false; C_SENDING = false;
      dropItems(s.cyc);
      return Promise.all([loadItems(s.cyc, false, true), s.relock ? loadAppr() : null]);
    // ★ 창을 닫아도 #cDrop 은 숨은 창 안에 남는다 — 「창이 열려 있고 올리기 창인가」로 본다(닫혔으면 표를 다시 그린다)
    }).then(function () {
      var up = !!($('cDrop') && $('panel').classList.contains('open'));
      // 잠금이 바뀌어 실패했으면 — 받은 목록으로 계획을 다시 세워 미리보기를 고친다(잠긴 줄은 「그대로 둬요」로 빠진다)
      if (s.relock && up && CUP === s && s.res) { s.relock = false; replan(s); paintPreview(); }
      if (!up) C.render();
    });
  }

  /* ══════════════════ 검증 · 상신 ══════════════════
     운행일지·개인경비와 같은 세 칸: ① 검증하기 → ② PDF 미리보기(열어 봐야 확인) → ③ 결재 상신.
     검증은 브라우저에서 card-rules.js 로(서버와 같은 판정). 구분·사용목적이 빈 줄이 있으면 ③ 이 꺼지고 그 줄로 가는 단추. */
  var VR = {}, VITEMS = [];
  /** 이번에 검증 화면에 들어와서 검증을 돌렸는가(키별) — 화면에 들어올 때마다 비운다(onGo). 운행일지·개인경비처럼 들어올 때마다 ① 검증하기부터
   *  (2026-10-20 V3 U9 — 법인카드만 다른 화면에 다녀와도 ③ 부터였다). 지난 결과는 아래에 그대로 보인다. */
  var CFRESH = {};
  var PREV = (function () { try { return JSON.parse(sessionStorage.getItem('drv.cpreviewed') || '{}'); } catch (e) { return {}; } })();
  // 검증 결과(VR)·이번에 검증했는가(CFRESH)·PDF 미리보기 확인(PREV, sessionStorage)·지문(sig)의 열쇠 = 사람|기간|대상 tid(2026-11-03 — 대상마다 따로, 카드번호 없음)
  function vkey(u, cyc, tid) { return u + '|' + cyc + '|' + (tid || ''); }
  /** 대상 줄 지문 — 대상 줄만(다른 카드 줄을 고쳐도 이 대상의 검증·미리보기는 그대로). 대상이 없으면 '0:0'. */
  function sig(u, cyc, tid) {
    var t = u === me() ? targetsOf(cyc).filter(function (x) { return x.tid === tid; })[0] : null, h = 0, cnt = 0;
    var add = function (v) { var s = String(v == null ? '' : v); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; };
    tItems(t).forEach(function (it) {
      cnt++;
      add(it.id); add(it.amount); add(it.appr_date); add(it.appr_no); add(it.merchant); add(it.owner_name); add(it.category); add(it.purpose); add(it.note);
    });
    return cnt + ':' + h;
  }
  function previewOk(k) {
    var v = PREV[k]; if (!v) return false;
    var p = k.split('|'); if (p.length < 3 || v.sig !== sig(p[0], p[1], p[2])) return false;
    // 다시 상신하는 문서가 그 사이(다른 탭에서) 상신됐으면 미리보기 확인은 낡았다
    var a = /^d\d+$/.test(p[2]) ? apprById(p[2].slice(1)) : null;
    return !(a && a.submitted_at && Date.parse(a.submitted_at) > v.at);
  }
  function setPreviewed(k, on) {
    var p = k.split('|');
    if (on) PREV[k] = { at: Date.now(), sig: sig(p[0], p[1], p[2]) }; else delete PREV[k];
    try { sessionStorage.setItem('drv.cpreviewed', JSON.stringify(PREV)); } catch (e) { }
  }
  /* ── AI 검증(2026-10-12, SPEC §3-1) — expense-ai op card_review: 서버가 card_items 를 직접 읽어 규칙(C01~C10) + Gemini(C07·C08).
     같은 자료면 서버가 보관해 둔 Gemini 결과를 쓴다. 서버·Gemini 를 못 쓰면 브라우저 규칙만 + 「AI 검증을 하지 못해 규칙으로만 검증했어요」(AI_FAIL). */
  var VRUN = { busy: false, note: '', k: '', t0: 0 }, VTICK = null, EXP = {};
  var AI_FAIL = 'AI 검증을 하지 못해 규칙으로만 검증했어요';   // 서버 expense-ai card_review FAIL_NOTE 와 같은 글자(2026-10-24 4단계 해요체)
  function cai(body) {
    return C.apiRetry('/functions/v1/expense-ai', { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j || j.error) { var e = new Error((j && j.error) || ('HTTP ' + r.status)); e.status = r.status; e.code = (j && j.code) || ''; throw e; }
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
  /** 브라우저 규칙 검증 — 대상 줄만(2026-11-03). known = 그 달 내 모든 줄(C05 하이패스 카드 판정에만 — 서버 runCardVerify(items, { known }) 와 같다). */
  function localVerify(cyc, t, aiData) {
    return R.runVerify(tItems(t), { cycle: cyc, submitterName: myFullName(), expenses: EXP[cyc] || null, ai: aiData || null, known: mineRows(cyc) });
  }
  function sayRun(t) {
    VRUN.note = t;
    var M = C.vx.aiMotion, mk = 'c:' + VRUN.k;
    if (M) M.step(mk, { phase: 'run' });
    var v = document.querySelector('.hero .verdict .cvnote'); if (v) v.textContent = t;
    var gl = document.querySelector('[data-cvrun] .gl'); if (gl) gl.textContent = (M && M.short(mk)) || t;   // 단추에는 짧게(2026-10-20)
  }
  /** AI 검증 모션 재료(2026-10-20) — 검증하는 대상 줄(날짜·가맹점·금액, 여섯 줄). 사진이 없으니 종이(카드 내역) 그림. */
  function cMotion(t) {
    var rows = tItems(t);
    return { title: 'AI가 카드 내역을 읽고 있어요', cols: ['날짜', '가맹점', '금액(원)', '비교'], N: 0, paper: 'sheet', more: Math.max(0, rows.length - 6),
      rows: rows.slice(0, 6).map(function (it) { return { id: it.id, date: String(it.appr_date || '').slice(5).replace('-', '.'), place: it.merchant || '—', amt: n0(it.amount) }; }),
      photos: [] };
  }
  function runCheck() {
    var S = C.state(), u = me(), cyc = S.CYCKEY, t = selTarget(cyc);
    if (VRUN.busy || !t) return;
    var tid = t.tid, k = vkey(u, cyc, tid), mk = 'c:' + k, M = C.vx.aiMotion;
    if (pending()) { C.toast('칸을 저장하는 중이에요. 잠시 후 다시 눌러 주세요.'); return; }
    var n = t.items.length, s0 = sig(u, cyc, tid);
    VRUN = { busy: true, note: '규칙을 살피는 중…', k: k, t0: Date.now() };
    if (M) { M.begin(mk, cMotion(t)); M.step(mk, { phase: 'run' }); }
    C.render();
    loadExp(cyc).then(function () {
      // 지난 초는 AI 판(「N초 지남」)이 센다 — 진행 글에 따로 세면 시계가 둘이고 1초 어긋났다(2026-10-20 V3 다듬기). 판이 없을 때만 글에 초를
      var tick = function () { if (VRUN.busy && VRUN.k === k) sayRun('카드 ' + n0(n) + '줄을 읽는 중…' + (M && M.on(mk) ? '' : ' ' + Math.round((Date.now() - VRUN.t0) / 1000) + '초')); };
      tick(); clearInterval(VTICK); VTICK = setInterval(tick, 1000);
      // 대상(2026-11-03 PLAN K3) — 카드 키(여러 카드 문서면 null) · 다시 상신할 문서 번호(새 문서면 null). 서버가 card_doc_plan 으로 같은 줄을 정한다
      return cai({ op: 'card_review', cycle: cyc, card_no: t.card_no == null ? null : t.card_no, approval_id: t.approval_id == null ? null : t.approval_id })
        .then(function (j) { return { j: j }; }, function (e) { return { e: e }; });
    }).then(function (x) {
      clearInterval(VTICK); VTICK = null;
      // 대상이 그 사이 바뀌었다(다른 탭에서 상신·회수 등 — 서버 CARD_*·ALREADY_*, 2026-11-03 SPEC §3-7) — 서버 글을 띄우고 문서·줄을 다시 받는다.
      //   이때는 규칙만으로 본 결과를 보이지 않는다(없는 대상의 결과가 남는다).
      if (x.e && /^(CARD_|ALREADY_|STALE)/.test(String(x.e.code || ''))) {
        C.toast(failMsg('검증하지 못했어요', x.e, '새로고침해 주세요.'), true);
        dropItems(cyc);
        return Promise.all([loadAppr(), loadItems(cyc, false, true)]).then(function () { return null; });
      }
      var res, ai, row = x.j && x.j.row;
      if (row && row.summary && row.result && Array.isArray(row.result.items)) {
        var a = x.j.ai || {};
        res = { summary: row.summary, items: row.result.items };
        ai = { status: a.status || row.result.ai_status || 'none', note: a.note || row.result.ai_note || '', model: a.model || '', data: row.result.ai || null,
          exNote: x.j.ex_note || row.result.ex_note || '' };
      } else {
        if (x.e) console.warn('법인카드 AI 검증:', String((x.e && x.e.message) || x.e));
        // 받는 사이 줄을 다시 받았으면 새 줄로(같은 대상 tid)
        res = localVerify(cyc, targetsOf(cyc).filter(function (y) { return y.tid === tid; })[0] || t, null);
        ai = { status: 'failed', note: AI_FAIL, model: '', data: null };
      }
      VR[k] = { at: Date.now(), sig: s0, res: res, ai: ai };
      CFRESH[k] = 1;                               // 이번에 들어와서 검증했다(V3 U9)
      setPreviewed(k, false);
      C.toast('검증했어요(' + sumText(res.summary) + ').' + (ai.note ? ' ' + C.endDot(ai.note) : '') + (ai.exNote ? ' ' + C.endDot(ai.exNote) : ''));
      // 응답이 왔다 — 실제 결과(항목이 가리키는 줄)로 카드 줄마다 딱지(80ms 간격) 뒤 결과 화면
      if (M) return M.finish(mk, M.chipsFrom(res.items || [], 'items', function (it) {
        return it.level === 'block' ? ['빈칸', 'bad', 4] : it.level === 'bad' ? ['불일치', 'bad', 3] : it.level === 'warn' ? ['확인 필요', 'warn', 2] : null;
      }));
    }).catch(function (e) { C.toast(failMsg('검증하지 못했어요', e, '잠시 후 다시 눌러 주세요.'), true); })
      .then(function () { clearInterval(VTICK); VTICK = null; VRUN = { busy: false, note: '', k: '', t0: 0 }; if (M) M.end(mk); C.render(); });
  }
  /** AI 상태 → [값, 설명]. */
  function aiFact(ai, nRows) {
    if (!ai) return ['—', '검증 전'];
    if (ai.status === 'ok') return ['완료', 'AI가 ' + n0(nRows) + '줄의 구분·사용목적을 봤어요'];
    if (ai.status === 'cached') return ['완료', '같은 자료로 본 AI 결과를 다시 썼어요'];
    if (ai.status === 'none') return ['—', '카드 내역이 없어요'];
    return ['규칙만', ai.note || AI_FAIL];
  }
  var LV = { block: ['빈칸', 'bad'], bad: ['불일치', 'bad'], warn: ['확인 필요', 'warn'], info: ['참고', ''] };
  /** 가운뎃점으로 이은 한글 낱말(「이름·사유를」·「구분·내역이」)은 한 덩이로 — 좁은 폭에서 줄 끝에 「·」가 남지 않게(2026-11-02 식대 C10 제목). esc 한 글에 쓴다. */
  function keepDots(h) { return String(h).replace(/[가-힣]{1,12}(?:·[가-힣]{1,12}){1,4}/g, function (m) { return '<span style="white-space:nowrap">' + m + '</span>'; }); }
  function itemsHtml(items, links) {
    if (!items || !items.length) return '<div class="panel"><div class="blank"><div class="ico">' + ic('check', 21) + '</div><div class="t">확인이 필요한 항목이 없어요.</div></div></div>';
    return '<div class="panel vlist">' + items.map(function (it) {
      var lv = LV[it.level] || LV.info, ref = (it.ref && it.ref.items) || [], go = '';
      if (links && ref.length && it.level !== 'info') { VITEMS.push(it); go = '<button class="btn sm vgo vfix" data-cvfix="' + (VITEMS.length - 1) + '">바로 수정' + ic('chev', 12) + '</button>'; }
      return '<div class="vitem v-' + esc(it.level === 'block' ? 'bad' : it.level) + (it.ai ? ' v-ai' : '') + '" data-ccode="' + esc(it.code || '') + '"><span class="st ' + lv[1] + '">' + lv[0] + '</span>' +
        // 설명의 「가맹점 금액」·「합계 금액」은 한 덩이(C.keepPairs — 360·390 「11.03 가짜식당 / 36,000원」, 2026-11-03 화면 다듬기)
        '<div class="vb"><div class="vt">' + keepDots(esc(it.title)) + (it.ai ? ' ' + C.vx.gemBadge() : '') + '</div><div class="vd">' + (C.keepPairs || String)(keepDots(esc(it.detail || ''))) + '</div></div>' + go + '</div>';
    }).join('') + '</div>';
  }
  /** 그 줄로 가서 빈 칸(없으면 첫 칸 — 구분)에 커서를 둔다. code 가 C10(식대 비고)이면 비고 칸으로.
   *  ★ 비고 칸은 C10 일 때만(2026-11-02 검토 M2 — 모든 항목이 비고로 가서 C07 「구분·내역이 맞지 않아 보임」을 고치러 가도 비고에 섰다). */
  function focusRow(id, code) {
    if (C.state().VIEW !== 'c_month') C.go('c_month');
    setTimeout(function () {
      var tr = document.querySelector('tr[data-crow="' + id + '"]');
      if (!tr) return;
      var el = (code === 'C10' && tr.querySelector('.cin[data-f="note"]')) || tr.querySelector('.cin.need') || tr.querySelector('.cin');
      try { tr.scrollIntoView({ block: 'center' }); } catch (e) { }
      tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash');
      if (el && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (e) { } }
    }, 80);
  }
  /** 검증·상신의 「빈 칸으로 가기」 — 고른 대상 줄 가운데 첫 빈칸 줄(상신을 막는 것은 그 대상 줄뿐, 2026-11-03). */
  function firstBlankId() {
    var r = tItems(selTarget(C.state().CYCKEY)).filter(function (it) { return !String(it.category || '').trim() || !String(it.purpose || '').trim(); })[0];
    return r ? r.id : null;
  }
  /** 「상신할 카드」 고르기(K8 .cpick · .cpq, 2026-11-03 SPEC §5-4) — 대상이 둘 이상일 때만. 단추마다 「카드 끝 1234 · N건 · ₩X」 + 죽은 문서면 「반려 · 다시 상신」·「회수 · 다시 상신」. */
  function pickHtml(tg, t) {
    if (tg.length < 2) return '';
    return '<div class="cpick" role="group" aria-label="상신할 카드"><span class="cpl">상신할 카드</span>' + tg.map(function (x) {
      var on = !!t && x.tid === t.tid, T = R.totals(x.items), dead = x.approval_id != null;
      return '<button type="button" class="cpq' + (on ? ' on' : '') + '" data-ctarget="' + esc(x.tid) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<b>' + dnHtml(tagFor(x.card_no, x.seq, me(), C.state().CYCKEY) || '카드 번호 없음') + '</b> <span class="cpqn">' + n0(T.n) + '건 · ' + won(T.cost) + '</span>' +
        // 「반려 · 다시 상신」만 빨강(.cpqs.bad — 띠·묶음 딱지 「반려」와 같은 색), 회수는 회색(디자인 검사 L4 · T5-6)
        (dead ? ' <span class="cpqs' + (x.status === 'rejected' ? ' bad' : '') + '">' + (x.status === 'rejected' ? '반려' : '회수') + ' · 다시 상신</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function viewVerify() {
    var S = C.state();
    if (!S.LOADED) return C.head('검증·상신') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('검증·상신', '법인카드 검증');
    var rows = itemsFor(false);
    if (!rows || rows.err) return notReady('검증·상신', rows);
    // 2026-11-03 추가 상신(SPEC §5-4): ①②③·결과·PDF·상신은 모두 고른 대상(카드) 줄만. 대상이 둘 이상이면 「상신할 카드」 고르기.
    //   대상이 없고 문서가 있으면 — 하나(결재 중·완료)면 예전 결재 중 화면(lockedVerify), 그 밖은 문서마다 띠 + 「상신할 카드 내역이 없어요」
    // 결재 목록을 못 받았으면(고침 1 M1) 검증·상신을 열지 않는다 — 어느 줄이 어느 문서에 들었는지 모르면 상신할 대상도 모른다
    if (CAPPR_ERR) return C.head('검증·상신') + apprErrBand();
    var u = me(), cyc = S.CYCKEY, docs = myDocs(cyc), tg = targetsOf(cyc), t = selTarget(cyc, tg);
    if (!t && rows.length) {
      if (docs.length === 1 && isLive(docs[0].status)) return lockedVerify(rows, docs[0]);
      return noTargetVerify(docs);
    }
    var tid = t ? t.tid : '', its = tItems(t), k = vkey(u, cyc, tid), dead = !!t && t.approval_id != null;
    // dataFresh = 지난 검증 뒤 자료가 그대로 · fresh = 그리고 이번에 들어와서 검증했다(단계는 fresh 로 — 들어올 때마다 ① 부터, V3 U9. 지난 결과 글·목록은 dataFresh 로)
    var v = VR[k], dataFresh = !!(v && v.sig === sig(u, cyc, tid)), fresh = dataFresh && !!CFRESH[k], s = v ? v.res.summary : {}, items = v ? v.res.items : [];
    var seen = previewOk(k), blocked = !!(v && fresh && s.block);
    var busy = VRUN.busy && VRUN.k === k;
    // 도는 동안은 ① 도는 중 · ②③ 아직(2026-10-20 V3 B2). 빈 칸이 있으면 지금 할 일은 ③ 「빈 칸으로 가기」(V3 B5 — ② PDF 가 깜빡이고 ③ 이 회색이었다)
    var locked = false, stage = busy || !v || !fresh ? 1 : blocked ? 3 : !seen ? 2 : 3;
    var canSubmit = true;                  // 대상이 있으면 늘 상신할 수 있다(살아 있는 문서는 대상이 아니다)
    VITEMS = [];
    var verdict, clean = '';
    if (busy) verdict = '<span class="gemrun">' + C.vx.gemBadge('AI') + '</span><span class="cvnote">' + esc(VRUN.note || '검증하는 중…') + '</span>';
    else if (!v) verdict = '아직 검증하지 않았어요';
    else if (!dataFresh) verdict = '자료가 바뀌었어요. 다시 검증해 주세요.';
    else if (s.block) verdict = '<em>' + n0(s.blank_rows) + '줄</em>에 빈 칸이 있어요. 채워야 상신할 수 있어요.';
    else if (s.bad) verdict = '맞지 않는 곳이 <em>' + n0(s.bad) + '건</em> 있어요';
    else if (s.warn) { verdict = '확인할 것이 <em>' + n0(s.warn) + '건</em> 있어요'; clean = ' wait'; }
    else { verdict = '<em>이상 없어요</em>'; clean = ' clean'; }
    // 2026-10-20 디자인 v2: 세 시스템 같은 단계 카드(C.vx.stepCard — 지금 할 단계 단추가 깜빡임, 도는 동안 진행 막대)
    // st — 빈 칸이 있어 ③ 이 지금일 때 ② 는 「끝」이 아니라 「아직」(누를 수는 있다 — 흰 바탕 단추, V3 B5)
    var card = function (n, title, desc, button, st) { return C.vx.stepCard(n, stage, title, desc, button, { busy: busy && n === 1, st: st }); };
    var mk = 'c:' + k, AM = C.vx.aiMotion;
    var none = !its.length;
    var steps = locked ? '' : '<ol class="vsteps" aria-label="상신 순서">' +
      card(1, '검증하기 ' + C.vx.gemBadge('AI'), none ? '먼저 ‘카드 내역’에서 ERP 엑셀을 올려 주세요.'
        : busy ? '규칙으로 살피고, AI가 구분·사용목적을 읽는 중…'
        : v && fresh ? '지금 자료로 검증했어요. 고친 게 있으면 다시 눌러 주세요.'
        : v && dataFresh ? '먼저 지금 자료로 검증해 주세요. 지금 보이는 건 지난 검증(' + esc(C.vx.whenText(new Date(v.at).toISOString())) + ') 결과예요.'
        : '규칙으로 빈칸, 중복, 기간 밖 줄을 보고 AI가 구분과 사용목적을 봐요.',
        C.vx.gemBtn('data-cvrun' + (busy || none ? ' disabled' : ''), busy ? ((AM && AM.short(mk)) || VRUN.note || 'AI가 읽는 중…') : v && fresh ? '다시 검증하기' : '검증하기',
          busy, ' big' + (stage === 1 && !none ? ' pri' + (busy ? '' : ' cta') : ''))) +
      card(2, 'PDF 미리보기', v && fresh ? '결재자에게 갈 지출결의서(가로 A4)를 열어 확인하세요.' : '검증을 먼저 해 주세요.',
        '<button class="btn big' + (stage === 2 ? ' pri cta' : '') + '" data-cpdf=""' + (v && fresh && !busy ? '' : ' disabled') + '>' + ic('dl', 16) + 'PDF 미리보기</button>',
        blocked && !seen ? 'todo' : undefined) +
      card(3, '상신', !canSubmit ? '이미 상신했어요.' : blocked ? '구분·사용목적이 빈 줄이 있어요. 빈 칸을 채우고 다시 검증하면 상신할 수 있어요.' : stage === 3 ? '결재선을 고르고 상신하세요.' : 'PDF 미리보기를 먼저 확인해 주세요.',
        // 빈 칸이 있으면 지금 누를 단추는 「빈 칸으로 가기」(빨강·깜빡임) — 상신 단추는 그 아래 회색(못 누름)
        (blocked ? '<button class="btn big pri cta" data-cgoblank>' + ic('chev', 14) + '빈 칸으로 가기</button>' : '') +
        (canSubmit ? '<button class="btn big' + (stage === 3 && !blocked ? ' pri cta' : '') + '" id="btnOpenSubmit" data-kind="card"' + (stage === 3 && !blocked && !busy ? '' : ' disabled') + '>' +
          (dead ? '다시 상신' : '상신') + '</button>' : '')) + '</ol>';
    // 대상이 하나면 고르기 없이 머리 줄에 그 이름(「카드 끝 1234」·「카드 끝 1234 · 추가 1」) — 가를 것이 있을 때만(카드가 둘 이상 · 추가 문서 · 문서가 둘 이상).
    //   카드 한 장 사람의 첫 상신·다시 상신은 예전 머리 줄 그대로(회귀 N1). 이름이 있으면 머리 줄 전체를 「 · 」 조각으로(폰에서 줄 끝 「·」·끝자리 갈림 없게 — 디자인 검사 M1)
    var nm = t && tg.length === 1 && (stripCtx(docs).nk >= 2 || seqOf(t) >= 2 || docs.length >= 2) ? tagFor(t.card_no, t.seq, u, cyc) : '';
    var GO = '깜빡이는 버튼부터 순서대로 눌러 주세요.';
    var h = nm && C.dnJoin ? C.head('검증·상신', C.dnJoin([esc(cycName(cyc)), '<b>' + esc(R.span(cyc)) + '</b>']
      .concat(nm.split(' · ').map(function (p) { return '<b>' + esc(p) + '</b>'; }), [GO])))
      : head('검증·상신', (nm ? '<b style="white-space:nowrap">' + esc(nm) + '</b> · ' : '') + GO);
    h += stripsHtml(docs);
    h += pickHtml(tg, t);
    h += cancelBand(its);                  // 전액 취소된 승인이 남아 있으면 — 상신 전에 한 번 더(2026-10-20 AU2 #5 검증 경고)
    var af = aiFact(v && v.ai, its.length);
    // 단계 카드는 제목 바로 아래(P_Verifying) — 그 아래 결과 자리. 검증이 도는 동안은 결과 자리에 AI 검증 모션(응답 뒤 실제 결과로 딱지)
    var moving = busy && AM && AM.on(mk);
    h += steps;
    if (moving) h += AM.html(mk, verdict);
    else h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (v && dataFresh && !s.block && !s.bad ? ' ok' : '') + '"></span>' +
      // 「마지막 검증 날짜」·「카드 N건 금액」은 한 덩이씩(360 「… · 카드 4건」 / 「135,600원」 — 2026-11-03 화면 다듬기, 상신 뒤 검증 머리와 같은 꼴)
      '<span>' + dnLine([(v ? '마지막 검증 ' + C.vx.whenText(new Date(v.at).toISOString()) : '검증 전'), '카드 ' + n0(its.length) + '건 ' + won(R.totals(its).cost)]) + '</span></div>' +
      '<p class="verdict' + (busy ? '' : clean) + '">' + verdict + '</p>' +
      (v && !busy ? '<div class="facts">' + fact('빈칸', n0(s.blank_rows) + '<small>줄</small>', '구분·사용목적이 비면 상신할 수 없어요', s.block > 0) +
        // 확인 필요 설명에 C10(식대 비고, 2026-11-02 검토 L2)
        //   「기간 밖 · 소유자 · …」는 조각 사이에서만 줄을 바꾼다(360·390 「기간 밖 · 소유자 ·」 / 「· 식대 비고」 — 2026-11-03 화면 다듬기)
        fact('불일치', n0(s.bad), '같은 승인번호가 두 번', s.bad > 0) + fact('확인 필요', n0(s.warn), { html: dnLine(['기간 밖', '소유자', '구분·사용목적', '개인경비 중복', '식대 비고']) }) + fact('참고', n0(s.info), '0원 줄') +
        '<div class="fact" id="cAiFact"><div class="k">검토 ' + C.vx.gemBadge() + '</div><div class="v">' + esc(af[0]) + '</div><div class="sub">' + esc(af[1]) + '</div></div></div>' +
        (v.ai && v.ai.note ? '<div class="awarn" id="cAiNote" style="margin-top:12px">' + ic('alert', 15) + '<span>' + esc(v.ai.note) + '</span></div>' : '') +
        (v.ai && v.ai.exNote ? '<div class="awarn" id="cExNote" style="margin-top:12px">' + ic('alert', 15) + '<span>' + esc(v.ai.exNote) + '</span></div>' : '') : '') +
      '</div>';
    if (v && dataFresh && !busy) {                // 지난 검증 결과도 보인다(자료가 그대로일 때) — 다시 들어와 ① 부터여도(V3 U9)
      var need = items.filter(function (i) { return i.level !== 'info'; }), info = items.filter(function (i) { return i.level === 'info'; });
      h += C.sect('봐야 할 것', need.length ? need.length + '건' : null, '', itemsHtml(need, true));
      if (info.length) h += C.sect('참고', info.length + '건', '', itemsHtml(info));
    } else if (!none && !busy) {
      h += '<div class="panel"><div class="blank"><div class="ico">' + ic('check', 21) + '</div><div class="t">‘검증하기’를 누르면 ' + (tg.length > 1 ? '고른 카드의' : '이번 기간') + ' 카드 내역을 살펴봐요.</div>' +
        // 가운뎃점 낱말(「구분·사용목적이」·「구분·내역이」)은 한 덩이(keepDots) — 768 에서 「…0원 줄, 구분·」으로 줄이 끝났다(2026-11-03 화면 다듬기)
        '<div class="d">' + keepDots('구분·사용목적이 빈 줄만 상신을 막아요. 같은 승인번호, 이 기간 밖 승인일, 소유자가 상신자와 다른 줄(하이패스 카드는 빼고), 0원 줄, 구분·내역이 맞지 않아 보이는 줄, 짧거나 모호한 사용목적, 개인경비와 겹칠 수 있는 줄은 상신을 막지 않고 결재자도 같이 봐요.') + '</div></div></div>';
    }
    h += '<div class="anote">금액은 ERP 승인금액 그대로이고, ' + C.vx.gemBadge('AI') + '는 <b>가맹점·시간과 맞지 않아 보이는 구분과 성의 없는 사용목적을 표시</b>만 해요. 값을 고치거나 상신을 막지 않고, 카드번호·이름은 AI에 보내지 않아요.</div>';
    return h;
  }
  /** 결재 중·결재 완료 기간의 검증·상신 화면(2026-10-15 화면 정리, 개인경비 lockedVerify 와 같은 모양) — 다시 검증하지 않는다.
   *  상신 때 굳힌 검증 결과(card_frozen.verify)만 보이고, 문서는 위 결재 띠의 PDF·엑셀 단추로 본다
   *  (예전: 「아직 검증하지 않았습니다」·없는 ① 단추 안내·띠와 같은 문서의 「결재 문서 PDF」 단추가 또 하나). */
  function lockedVerify(rows, a) {
    // 2026-11-03 추가 상신: 문서 하나가 결재 중·완료이고 상신할 다른 카드 내역이 없을 때 — 「기간」 대신 「문서」(새 줄은 같은 카드의 다음 문서로 따로 상신한다).
    //   카드 한 장 · 문서 하나면(그 문서 = 그 기간) 예전 글 그대로(회귀 N1)
    var cx = stripCtx(myDocs(C.state().CYCKEY)), noun = cx.solo ? '기간이에요.' : '문서예요.', nounR = cx.solo ? '기간이라' : '문서라';
    var h = head('검증·상신', (a.status === 'approved' ? '결재가 끝난 ' : '결재 중인 ') + noun);
    h += apprStrip(a, { cx: cx });
    var f = FZSUM[fzKey(a)], v = f && f.verify, s = (v && v.summary) || {}, items = (v && v.items) || [];
    var verdict, clean = '';
    if (f === undefined) verdict = FZFAIL[fzKey(a)] ? '상신 때 검증 결과를 불러오지 못했어요. 잠시 후 다시 열어 주세요.' : '상신 때 검증 결과를 불러오는 중…';
    else if (!v) verdict = '상신 때 검증 결과가 없어요';
    else if (s.block) verdict = '빈 칸이 있는 줄이 <em>' + n0(s.blank_rows || s.block) + '줄</em> 있었어요';
    else if (s.bad) verdict = '맞지 않는 곳이 <em>' + n0(s.bad) + '건</em> 있었어요';
    else if (s.warn) { verdict = '확인할 것이 <em>' + n0(s.warn) + '건</em> 있었어요'; clean = ' wait'; }
    else { verdict = '<em>이상 없었어요</em>'; clean = ' clean'; }
    var at = v && (v.ran_at || (f && f.frozen_at));
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (v && !s.block && !s.bad ? ' ok' : '') + '"></span>' +
      // 날짜·「카드 N건 금액」은 한 덩이 · 두 줄이 되면 덩이 사이에서만(줄 끝 「·」 없음 — 2026-11-03 화면 다듬기, 360·390 「… 07:00 ·」)
      '<span>' + dnLine(['상신 때 검증 결과'].concat(at ? [C.vx.whenText(at)] : [], ['카드 ' + n0(rows.length) + '건 ' + won(R.totals(rows).cost)])) + '</span></div>' +
      '<p class="verdict' + clean + '">' + verdict + '</p></div>';
    if (v) {
      var need = items.filter(function (i) { return i.level !== 'info'; }), info = items.filter(function (i) { return i.level === 'info'; });
      VITEMS = [];
      h += C.sect('봐야 할 것', need.length ? need.length + '건' : null, '', itemsHtml(need, false));
      if (info.length) h += C.sect('참고', info.length + '건', '', itemsHtml(info));
    }
    h += '<div class="anote">' + (a.status === 'approved' ? '결재가 끝난 ' : '결재 중인 ') + nounR + ' 다시 검증하지 않아요. 결재 문서는 PDF로 확인하세요.</div>';
    return h;
  }
  /** 상신할 대상이 없을 때(문서가 여럿 — 모두 결재 중·완료, 또는 줄 없는 반려·회수 문서) — 문서마다 결재 띠 + 「상신할 카드 내역이 없어요」(2026-11-03 SPEC §5-4). */
  function noTargetVerify(docs) {
    var h = head('검증·상신');
    h += stripsHtml(docs);
    h += '<div class="panel"><div class="blank"><div class="ico">' + ic('check', 21) + '</div><div class="t">상신할 카드 내역이 없어요.</div>' +
      '<div class="d">결재 문서는 위 띠의 PDF로 확인하세요. 카드 내역을 더 올리면 그 카드의 다음 문서로 따로 상신해요.</div></div></div>';
    return h;
  }
  /** 상신 창이 「상신」을 누른 직후 — 미리보기 뒤 자료가 바뀌었거나 빈 칸이 있으면 멈추고({blocked}), 아니면 요약을 돌려준다. */
  function beforeSubmit(onNote) {
    // 2026-11-03 고침 1 H1·M1 — 창이 붙잡은 대상만 확인한다(누른 순간 고른 대상이 아니다). 멈출 때는 늘 창을 닫고 까닭을 알린 뒤 대상 고르기(검증·상신)로:
    //   붙잡은 대상이 없음 · 카드 내역/결재 목록을 다시 받지 못함(모름 — 상신하지 않는다) · 대상이 없어졌거나 바뀜(다른 카드로 바꾸지 않는다) ·
    //   PDF 미리보기를 안 했거나 그 뒤 바뀜(법인카드는 미리보기가 꼭 있어야 한다) · 구분·사용목적 빈칸.
    var P = pinNow(), u = me(), cyc = C.state().CYCKEY;
    var stop = function (msg) { pinStop(msg); return { blocked: true }; };
    if (!P) return Promise.resolve(stop('상신할 카드를 다시 골라 주세요. 검증·상신에서 카드를 고르고 PDF 미리보기를 확인한 뒤 상신해요.'));
    var k = vkey(u, cyc, P.tid), seen = PREV[k] ? PREV[k].sig : null;
    if (onNote) onNote(pending() ? '칸을 저장하는 중' : '카드 내역을 다시 확인하는 중');
    // 쓰다 만 칸·보내는 중인 칸을 먼저 끝낸다 — 끝나기 전에 서버에서 다시 받으면 방금 적은 값이 빠진 채 판정한다
    return settleSaves().then(function () {
      if (onNote) onNote('카드 내역을 다시 확인하는 중');
      // 결재 목록도 — 다른 탭에서 이 대상을 이미 상신했거나 결재자가 반려했으면 대상이 바뀐다(아래에서 멈춘다).
      //   둘 다 들어온 뒤에 본다(받는 사이 다른 받기가 또 떠났으면 그것까지 — T7-6)
      return Promise.all([loadItems(cyc, false, true), loadExp(cyc), loadAppr()]).then(function () { return settledFor(cyc); });
    }).then(function () {
      if (pinNow() !== P) return { blocked: true };       // 받는 사이 창이 닫혔거나 붙잡기가 멈췄다(그쪽이 이미 알렸다)
      var t = pinTarget(P);
      if (t === undefined) return stop('카드 내역이나 결재 목록을 불러오지 못해 상신하지 않았어요. 잠시 후 다시 상신해 주세요.');
      if (!t) return stop(PIN_GONE);
      if (!previewOk(k)) {
        if (seen != null) setPreviewed(k, false);
        return stop(seen != null ? '미리보기 후에 카드 내역이 바뀌었어요. PDF를 다시 확인해 주세요.' : 'PDF 미리보기를 먼저 확인해 주세요. 검증·상신에서 PDF 미리보기를 연 뒤 상신해요.');
      }
      var v0 = VR[k], ai0 = v0 && v0.ai ? v0.ai : null;
      // 검증하기 때 받은 Gemini 결과(같은 자료)를 그대로 더한다 — 서버도 같은 지문의 보관본으로 C07·C08 을 굳힌다.
      var res = localVerify(cyc, t, ai0 && ai0.data);
      VR[k] = { at: Date.now(), sig: sig(u, cyc, P.tid), res: res, ai: ai0 };
      if (res.summary.block) return stop('구분·사용목적이 빈 줄이 ' + n0(res.summary.blank_rows) + '건 있어요. 채운 뒤 상신해 주세요.');
      return { bad: res.summary.bad, warn: res.summary.warn, info: res.summary.info };
    }).catch(function (e) {
      // 확인이 깨지면(예상 못 한 오류) 보내지 않는다 — 본체는 확인이 실패해도 상신하므로 여기서 막는다
      console.error('법인카드 상신 확인:', e);
      return pinNow() === P ? stop('카드 내역을 다시 확인하지 못해 상신하지 않았어요. 잠시 후 다시 상신해 주세요.') : { blocked: true };
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
  /** 문서 모델 하나(사람 × 기간 × 카드 — 2026-11-03) — SheetPdf.buildCard · CardSheet.xlsxBytes 가 같이 쓴다.
   *  nm = { card_no, seq }(대상 또는 문서) — 기간 글·문서 이름 끝에 꼬리(「 · 카드 끝 1234」·「 · 추가 1」, SPEC §5-5). sheetpdf.js·card-sheet.js 는 그 글을 그대로 그린다. */
  function cDoc(u, cyc, rows, a, fz, verify, mark, docNo, nm) {
    // 결재란 — 세 문서 공통(C.docBoxes · C.boxLabels): 칸 이름은 그 건의 칸 모양(예전 건 v1 · 새 건 v2, 2026-10-14)
    //   담당 칸 — 상신 전(·반려·회수 뒤) 본인 문서면 지금 내 서명(운행일지 boxesOf 와 같게, 2026-10-14)
    var p = personOf(u, fz), filed = !!fz, boxes = C.docBoxes(a, p.name, C.liveSign ? C.liveSign(u) : null, u, filed);   // filed — 고정본이면 반려·회수 뒤에도 상신 때 결재란 그대로(2026-10-16 6차)
    var sx = nm ? docSuffix(nm.card_no, nm.seq) : '';
    return {
      meta: { name: p.name, cycleName: cycName(cyc) + ' 법인카드' + sx, mark: mark, docNo: docNo },
      person: p, periodLabel: cycName(cyc) + ' (' + R.span(cyc) + ')' + sx, boxes: boxes, boxLabels: C.boxLabels(a, filed), items: docItems(rows, p.name), verify: verify,
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
      noAiText: '규칙 검증(빈칸 · 같은 승인번호 · 기간 · 소유자 · 0원 · 개인경비 중복 · 식대 비고)' +   // 식대 비고 = C10(2026-11-02 검토 L2)
        (aiUsed === true ? ' + AI 구분·사용목적 확인' : aiUsed === false ? ' · AI 확인 없음' : ''),
      // 검증 결과 창(C.vx.showItems) 한 줄 — 검증 화면과 같은 말. 모르면 말하지 않는다(2026-10-21: 예전엔 늘 「Gemini 읽기 없음」)
      aiNote: aiUsed === true ? 'AI가 구분·사용목적을 봤어요' : aiUsed === false ? AI_FAIL : '',
      notes: ['· 금액은 ERP 에서 받은 승인금액 그대로입니다(취소·0원 줄은 올릴 때 뺐습니다).',
        '· 구분·사용목적이 빈 줄이 있으면 상신할 수 없습니다. 나머지 항목은 결재자가 보고 판단합니다.'],
      summary: { bad: (s.block || 0) + (s.bad || 0), warn: s.warn || 0, info: s.info || 0, receipts: 0, read: 0 },
      items: (res.items || []).map(function (i) { return i.level === 'block' ? { code: i.code, level: 'bad', title: '[상신 막음] ' + i.title, detail: i.detail } : i; })
    };
  }
  function showPdf(d, o) {
    var p = C.vx.makePdf(pdfOpts(d, o));
    subDn(o.sub);
    return p.catch(function () { });
  }
  /** 방금 연 창의 아래 줄(「이름 · 2026년 11월분 (11.01~11.30) · 카드 끝 1234」)을 「 · 」 조각으로(디자인 검사 M1 — 본체 창은 글자로 넣는다). 다른 창이면 그대로. */
  function subDn(text) { var el = $('pSub'); if (el && text && el.textContent === String(text)) dnPut(el, text); }
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
  /** 상신 전 미리보기(지금 자료 — 고른 대상 줄만, 2026-11-03). 대상이 없고 결재 중·완료 문서 하나뿐이면 고정본으로. */
  function pdfMine() {
    var S = C.state(), u = me(), cyc = S.CYCKEY, t = selTarget(cyc), docs = myDocs(cyc);
    if (!t && docs.length === 1 && isLive(docs[0].status)) { pdfFrozen(docs[0].id); return; }
    var rows = tItems(t);
    if (!rows.length) { C.toast('이 기간에 담을 카드 내역이 없어요.', true); return; }
    var k = vkey(u, cyc, t.tid), v = VR[k];
    var d = cDoc(u, cyc, rows, null, null, v ? vOf(v.res, v.at, v.ai) : null, 'preview', '상신 전 미리보기 · ' + C.vx.whenText(new Date().toISOString()) + ' 출력', t);
    showPdf(d, { title: 'PDF 미리보기 — 법인카드', sub: d.person.name + ' · ' + cycName(cyc) + ' (' + R.span(cyc) + ')' + withDup(docSuffix(t.card_no, t.seq), t.card_no, dupOf(u, cyc)),
      file: '법인카드_지출결의_' + C.vx.safeName(d.person.name) + '_' + cyc + filePiece(t.card_no, t.seq) + '_미리보기.pdf',
      expect: R.totals(rows).cost, expectName: '화면 합계', okKey: k, again: t.approval_id != null });
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
      '법인카드 결재 #' + a.id + ' · 상신 ' + C.vx.whenText(fz.frozen_at || a.submitted_at) + (done && a.closed_at ? ' · 완료 ' + C.vx.whenText(a.closed_at) : ''), a);
  }
  /** 결재 문서 파일 이름 — 「법인카드_지출결의_{이름}_{기간}{_카드1234}{_추가1}_{결재완료|결재중|반려|회수}.{pdf|xlsx}」(2026-11-03 SPEC §5-5). */
  function frozenFile(a, d, ext) { return '법인카드_지출결의_' + C.vx.safeName(d.person.name) + '_' + a.cycle + filePiece(a.card_no, a.seq) + MARK_SUFFIX[d.meta.mark] + ext; }
  var MARK_SUFFIX = { '': '_결재완료', pending: '_결재중', rejected: '_반려', withdrawn: '_회수' };
  function pdfFrozen(id) {
    var a = apprById(id);
    if (!a) { C.toast('결재 건을 찾지 못했어요.', true); return; }
    fetchFrozen(a).then(function (fz) {
      if (!fz) { C.toast('상신 때 저장한 자료를 찾지 못했어요. 관리자에게 알려 주세요.', true); return; }
      var o = frozenOpts(a, fz);
      if (a.status === 'approved') o.prints = { kind: 'card', ids: [a.id] };      // 결재 완료본 — 내려받기·열기를 누르면 출력 기록(2026-10-14)
      var p = C.vx.makePdf(o);
      subDn(o.sub);
      p.catch(function () { });
    }).catch(function () { C.toast('결재 문서를 불러오지 못했어요. 잠시 후 다시 해 주세요.', true); });
  }
  function frozenOpts(a, fz) {
    var d = frozenDoc(a, fz), done = a.status === 'approved';
    // 결재 완료본에는 검증 결과 쪽을 붙이지 않는다(2026-10-14 사용자 — 출력물엔 필요 없다). 결재 중 문서에는 그대로 — 결재자가 본다.
    if (done) d = Object.assign({}, d, { verify: null });
    return pdfOpts(d, { title: done ? '결재 완료 문서 — 법인카드' : a.status === 'submitted' ? '결재 문서 — 법인카드' : '상신했던 문서 — 법인카드',
      sub: d.person.name + ' · ' + docLong(a),
      file: frozenFile(a, d, '.pdf'),
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
      if (!fz) { C.toast('상신 때 저장한 자료를 찾지 못했어요. 관리자에게 알려 주세요.', true); return; }
      var d = frozenDoc(a, fz), x = SH.xlsxBytes(d, window.Xlsx);
      var sum = d.items.reduce(function (s, it) { return s + it.amount; }, 0), exp = (a.snapshot || {}).cost;
      C.saveBlob(x.bytes, frozenFile(a, d, '.xlsx'));
      if (a.status === 'approved' && C.prints) C.prints.log('card', a.id, 'xlsx');        // 출력 기록(기다리지 않는다)
      if (exp != null && Math.round(sum) !== Math.round(Number(exp))) C.toast('엑셀 합계 ' + n0(sum) + '원이 상신 때 금액 ' + n0(exp) + '원과 달라요. 관리자에게 알려 주세요.', true);
      else C.toast('엑셀을 다운로드해요.');
    }).catch(function () { C.toast('결재 문서를 불러오지 못했어요.', true); });
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
      '<button class="btn sm" data-cfzpdf="' + a.id + '">' + ic('dl', 13) + 'PDF 다운로드</button>' +
      (done ? '<button class="btn sm" data-cfzxlsx="' + a.id + '">' + ic('dl', 13) + '엑셀 다운로드</button>' : '') + '</div>';
  }
  function brief(a, f) {
    if (!a || a.status !== 'submitted') return '';
    var s = a.snapshot || {};
    if (s.cost == null) return '';
    // 전월 = 이름 달의 앞 달(1월분 → 12월분, 2026-10-20). 12월 추가 기간(12월분 2차)은 견주지 않는다 — 「—」.
    //   2026-11-03 추가 상신(SPEC §5-6 설계 판단): 앞 달 같은 카드의 살아 있는 문서 합계(여러 카드 예전 문서면 앞 달 그 사람 문서 모두)
    var cost = Number(s.cost) || 0, pkey = prevMonthKey(a.cycle), pm = pkey ? +pkey.slice(5, 7) + '월분' : '';
    var pl = pkey ? docsOf(a.username, pkey).filter(function (x) {
      return isLive(x.status) && x.snapshot && x.snapshot.cost != null && (multiDoc(a) || (!multiDoc(x) && cKey(x.card_no) === cKey(a.card_no)));
    }) : [];
    var prev = pl.length ? pl.reduce(function (o, x) { o.cost += Number(x.snapshot.cost) || 0; o.n += Number(x.snapshot.n) || 0; return o; }, { cost: 0, n: 0 }) : null;
    var cmp;
    if (prev) {
      var p0 = prev.cost, d = cost - p0, pct = p0 ? Math.round(d / p0 * 100) : null;
      cmp = '<div class="abf"><span class="k">전월(' + pm + ') 대비</span><b class="' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '') + won(Math.abs(d)) +
        (pct != null && d ? ' <small>(' + (d > 0 ? '+' : '−') + (Math.abs(pct) < 1 ? '1% 미만' : Math.abs(pct) + '%') + ')</small>' : '') + '</b><span class="sub">' + dnLine([pm + ' ' + won(p0), n0(prev.n) + '건']) + '</span></div>';
    } else cmp = '<div class="abf"><span class="k">전월 대비</span><b class="dimv">—</b><span class="sub">' + (pkey ? '볼 수 있는 ' + pm + ' ' + (multiDoc(a) ? '법인카드' : '같은 카드') + ' 결재가 없어요' : '추가 기간은 전월과 비교하지 않아요') + '</span></div>';
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
    else checks.push(['warn', '상신 때 검증 결과가 없어요']);
    var nBad = (vs && vs.bad ? 1 : 0) + checks.filter(function (c) { return c[0] === 'bad'; }).length,
      nWarn = (vs && vs.warn ? 1 : 0) + checks.filter(function (c) { return c[0] === 'warn'; }).length;
    var asApprover = a.username !== (C.state().ME || {}).username;   // 결재하는 분 — 상신자 할 일(고치세요)은 보이지 않는다
    var verdict = !vs ? ['warn', (f === undefined && FZFAIL[fzKey(a)] ? '상신 때 검증 결과를 불러오지 못했어요' : f === undefined ? '검증 결과를 불러오는 중이에요' : '검증 결과를 아직 받지 못했어요') + '. ‘PDF\u00a0다운로드’로 문서를 열어 확인해 주세요.']
      : nBad ? ['bad', asApprover ? '확인이 필요해요. 문서의 불일치 항목을 보고 결재해 주세요.' : '검증에서 맞지 않는 곳이 있어요. 결재자도 문서에서 함께 봐요.']   // 상신한 본인에게는 본인용 문구(2026-10-16 3차)
      : nWarn ? ['warn', '대체로 정상이에요. ' + C.vx.warnTail(items, vs, asApprover) + '.']
      : ['ok', '금액·검증 모두 이상 없어요.' + (myTurn(a) ? ' 문서를 열지 않고 승인해도 돼요.' : '')];   // 「열지 않고 승인」은 지금 결재할 분에게만
    return '<div class="abrief ' + verdict[0] + '"><div class="abv"><span class="abi">' + (verdict[0] === 'ok' ? '✓' : '!') + '</span><b>' + esc(verdict[1]) + '</b></div>' +
      '<div class="abgrid">' +
      '<div class="abf"><span class="k">청구 금액</span><b>' + won(cost) + '</b><span class="sub">' + catHtml(s.by_cat) + '</span></div>' +
      '<div class="abf"><span class="k">카드 승인</span><b>' + n0(s.n) + '<small>건</small></b><span class="sub">' + esc(R.span(a.cycle)) + '</span></div>' +
      cmp + '</div><div class="abchk">' + checks.map(function (c) { return '<span class="ck ' + c[0] + '">' + (c[0] === 'ok' ? '✓' : '!') + ' ' + esc(c[1]) + '</span>'; }).join('') + '</div>' +
      (items.length ? '<ul class="abitems">' + items.slice(0, 4).map(function (i) {
        return '<li class="' + i.level + '"><b>' + keepDots(esc(i.title || '')) + '</b>' + (i.detail && !asApprover ? ' — ' + esc(String(i.detail).slice(0, 110)) + (String(i.detail).length > 110 ? '…' : '') : '') + '</li>';
      }).join('') + (items.length > 4 ? '<li class="more">외 ' + n0(items.length - 4) + '건은 ‘검증’ 버튼을 누르면 모두 보여요.</li>' : '') +
        (asApprover ? '<li class="more">고치는 것은 상신자가 해요. 고쳐야 하면 반려하고 사유에 적어 주세요.</li>' : '') + '</ul>' : '') + '</div>';
  }
  function sumHtml(a) {
    var s = a.snapshot || {};
    var kv = function (k, v) { return '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; };
    if (s.cost == null) return '';
    // 꼬리(카드 끝자리·추가 N, 2026-11-03) — 있으면 「 · 」 조각으로(폰에서 줄 끝 「·」·끝자리 갈림 없게, 디자인 검사 M1)
    var per = esc(cycName(a.cycle)) + ' <span class="dim">(' + esc(R.span(a.cycle)) + ')</span>';
    var sx = withDup(docSuffix(a.card_no, a.seq), a.card_no, dupOf(a.username, a.cycle)).replace(/^ · /, '');
    return kv('기간', sx && C.dnJoin ? C.dnJoin([per].concat(sx.split(' · ').map(esc))) : per + (sx ? esc(' · ' + sx) : '')) +
      kv('구분별', catHtml(s.by_cat)) +
      kv('합계', '<b style="font-size:15px">' + won(s.cost) + '</b> <span class="dim">' + n0(s.n) + '건</span>');
  }

  /* ══════════════════ 관리 — 현황 · 전체 내역 · 결재 완료 출력 · 직원 현황 ══════════════════ */
  function cycAppr() { var k = C.state().CYCKEY; return (CAPPR || []).filter(function (a) { return a.cycle === k; }); }
  /** 사람마다 그 기간 카드 줄 — { u, n, sum, blank, rows }(결재 건만 있고 줄이 없는 사람도 0건으로). */
  function peopleOf(rows) {
    var by = {};
    rows.forEach(function (it) {
      var x = by[it.username] = by[it.username] || { u: it.username, n: 0, sum: 0, blank: 0, rows: [] };
      x.n++; x.sum += Number(it.amount) || 0; x.rows.push(it);
      if (!String(it.category || '').trim() || !String(it.purpose || '').trim()) x.blank++;
    });
    cycAppr().forEach(function (a) { if (!by[a.username]) by[a.username] = { u: a.username, n: 0, sum: 0, blank: 0, rows: [] }; });
    return by;
  }
  /** 챙길 사람 한 줄 — 현황 「챙길 사람」과 결재 완료 문서 「챙겨야 할 사람」이 같은 사람·같은 글(2026-11-03 SPEC §5-7, 사람마다 달 상태 R.monthState).
   *  반려 → 가장 최근 반려 문서 사유 · 회수 → 「회수됨 · …」 · 상신 전 줄(열린 줄) → 「상신 전 N줄 · ₩X(· 빈칸 M줄)」. 챙길 일이 없거나
   *  「이번 기간 내역 없음」 효력이면 null(서버 remind 도 「이 기간 자료 없음」으로 건너뛴다). 돌려주는 것 { u, st: 'rejected'|'withdrawn'|'none', left, last }. */
  function followOf(u, cyc, lines, docs) {
    if (C.noneEffective && C.noneEffective('card', u, cyc, lines.length, liveStOf(docs))) return null;
    var ms = monthOfLines(lines, docs), open = openOf(lines);
    var st = ms.st === 'rejected' ? 'rejected' : ms.st === 'withdrawn' ? 'withdrawn' : ms.st === '' && open.length ? 'none' : '';
    if (!st) return null;
    var amt = open.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0), bl = R.blankRows(open);
    var tail = '상신 전 ' + n0(open.length) + '줄 · ' + won(amt) + (bl ? ' · 빈칸 ' + n0(bl) + '줄' : '');
    var left;
    if (st === 'rejected') {
      var rd = docs.filter(function (a) { return a.status === 'rejected'; }).sort(function (x, y) { return cmpS(y.closed_at || y.updated_at, x.closed_at || x.updated_at) || (Number(y.id) || 0) - (Number(x.id) || 0); })[0];
      var rs = rd ? (rd.steps || []).filter(function (s) { return s && s.result === 'rejected'; })[0] : null;
      left = '반려 사유: ' + (rs && rs.comment ? String(rs.comment).replace(/\s+/g, ' ') : '(사유 없음)');
    } else left = st === 'withdrawn' ? '회수됨' + (open.length ? ' · ' + tail : '') : tail;
    var last = 0;
    lines.forEach(function (it) { var ms0 = Date.parse(it.updated_at || it.created_at || '') || 0; if (ms0 > last) last = ms0; });
    docs.forEach(function (a) { var ms1 = Date.parse(a.closed_at || a.updated_at || '') || 0; if (ms1 > last) last = ms1; });
    return { u: u, st: st, left: left, last: last };
  }
  /** 보는 범위 사람들의 챙길 사람 목록(그 기간 — 줄이 있거나 문서가 있는 사람). */
  function followList(rows, cyc) {
    var by = peopleOf(rows);
    return Object.keys(by).filter(function (u) { return C.orgMatch(u); }).map(function (u) { return followOf(u, cyc, by[u].rows, docsOf(u, cyc)); }).filter(Boolean);
  }
  /** 관리 「카드」 칸 재료(R.cardList — [{ key, tail, hipass }] 끝자리 순). hp = 그 화면이 받은 그 달 모든 줄의 하이패스 카드(R.hipassCards). */
  function cardListOf(lines, hp) {
    if (R.cardList) return R.cardList(lines, hp);
    var seen = {}, out = [];
    (lines || []).forEach(function (it) { var k = cKey(it.card_no); if (seen[k]) return; seen[k] = 1; out.push({ key: k, tail: cTail(k), hipass: !!(hp && hp[k]) }); });
    return out.sort(function (a, b) { return cmpS(a.tail, b.tail) || cmpS(a.key, b.key); });
  }
  /** 관리 「카드」 칸(2026-11-02 사용자 요청, SPEC §5-7 · K8 td.ccards) — 그 사람 그 달 줄의 카드마다 끝자리를 「 · 」로 잇고, 하이패스 카드는 「 (하)」.
   *  카드번호 전체는 어디에도(title 에도) 넣지 않는다. 줄이 없으면 「—」(폰 카드 모양 표에서는 빈 칸을 숨긴다 — rnone). */
  //   카드가 많아 줄이 넘어가면 카드 사이에서만, 줄 끝·처음에 「·」 없이(C.dnJoin 걸린 구분점 — 디자인 검사 L2). 표 칸에서는 카드 셋까지 늘 한 줄,
  //   넷 이상만 카드 사이에서 꺾인다(T5 CSS td.ccards .dnl — T5-6). 앞 판 본체면 예전 구분 글
  function cardsTd(lines, hp) {
    var L = cardListOf(lines, hp), dm = dupMap(L.map(function (c) { return c.key; }));     // 끝자리가 같은 카드 둘이면 「1234 (1) · 1234 (2)」(고침 1 L4)
    if (!L.length) return '<td class="ccards rnone" data-l="카드"><span class="dim">—</span></td>';
    var parts = L.map(function (c) { return '<span class="ccard">' + esc((c.tail || '번호 없음') + (dm[c.key] || '') + (c.hipass ? ' (하)' : '')) + '</span>'; });
    return '<td class="ccards" data-l="카드">' + (C.dnJoin ? C.dnJoin(parts) : parts.join('<span class="csep"> · </span>')) + '</td>';
  }
  /** 직원 현황 「결재」 칸(2026-11-03 SPEC §5-7) — 문서 하나·열린 줄 없음이면 지금 딱지 하나, 그 밖은 「완료 2」·「결재 중 1」·「반려 1」·「회수 1」·「상신 전 12줄」 딱지들.
   *  x = { n, nOpen, docs }. 줄도 문서도 없으면 「—」. */
  function apprChips(x) {
    var d = x.docs || [];
    // 카드 한 장 · 문서 0~1건(예전과 같은 달)은 예전 딱지 그대로 — 「반려」·「결재 중」·「상신 전」(고침 1 L2). 딱지를 여럿 쓰는 것은 카드가 여럿이거나 문서가 여럿인 달만
    var keys = {}; (x.rows || []).forEach(function (it) { keys[cKey(it.card_no)] = 1; });
    d.forEach(function (a) { if (a.card_no != null) keys[cKey(a.card_no)] = 1; });
    if (d.length <= 1 && Object.keys(keys).length <= 1) return d.length ? stChip(d[0]) : x.n ? '<span class="st warn">상신 전</span>' : '<span class="dim">—</span>';
    if (d.length === 1 && !x.nOpen) return stChip(d[0]);
    if (!d.length && !x.nOpen) return x.n ? '<span class="st warn">상신 전</span>' : '<span class="dim">—</span>';
    var c = { approved: 0, submitted: 0, rejected: 0, withdrawn: 0 };
    d.forEach(function (a) { var s = a.status === 'draft' ? 'withdrawn' : a.status; if (c[s] != null) c[s]++; });
    var out = [];
    if (c.approved) out.push('<span class="st ok">완료 ' + n0(c.approved) + '</span>');
    if (c.submitted) out.push('<span class="st warn">결재 중 ' + n0(c.submitted) + '</span>');
    if (c.rejected) out.push('<span class="st bad">반려 ' + n0(c.rejected) + '</span>');
    if (c.withdrawn) out.push('<span class="st dim">회수 ' + n0(c.withdrawn) + '</span>');
    if (x.nOpen) out.push('<span class="st warn">상신 전 ' + n0(x.nOpen) + '줄</span>');
    return out.join(' ');
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
    // 하이패스 카드 = 받은 그 달 모든 줄(전 직원 — 보는 범위로 거르기 전)에서 하이패스 가맹점 줄이 있는 카드(2026-11-03 SPEC §5-7 설계 판단 — 센터 카드의 통행료 줄이 다른 직원 쪽에 있어도 (하))
    var hp = R.hipassCards ? R.hipassCards(rows) : null;
    rows = rows.filter(function (it) { return C.orgMatch(it.username); });
    var by = peopleOf(rows), list = Object.keys(by).filter(function (u) { return C.orgMatch(u); }).map(function (u) { return by[u]; });
    var T = R.totals(rows);
    // 2026-10-15 2차(관리자 메뉴 원칙): 현황은 금액·구분·팀만. 결재 상태 네 칸·PDF·관리자 반려·정정 열기는 「결재 완료 출력」에만
    //   (예전에는 두 화면이 같은 결재 상태 칸과 반려·정정 단추를 되풀이했다 — 군더더기 검토 상 9).
    var cats = Object.keys(T.by_cat || {}).map(function (c) { return { c: c, n: T.by_cat[c].n, sum: T.by_cat[c].sum }; })
      .sort(function (a, b) { return b.sum - a.sum; });
    var h = head('법인카드 현황', '직원별 금액·구분·팀');
    // 챙길 사람 + 팀즈 알림 보내기(2026-10-20 D2 — 운행일지 현황과 같은 조각 C.follow, 서버 approval-act op 'remind' 가 다시 확인).
    //   결재 완료 출력 「챙겨야 할 사람」과 같은 사람·같은 글(followOf — 2026-11-03 사람마다 달 상태: 반려 · 회수 · 상신 전 줄). 「내역 없음」 효력이면 뺀다.
    if (C.follow) h += '<div class="d2grid">' + C.follow('card', S.CYCKEY, followList(rows, S.CYCKEY), { wide: true, none: '이 기간 카드 내역이 있는 사람은 모두 상신했어요' }) + '</div>';
    // 결재 건만 있고 줄이 없는 사람(0건)은 「카드 내역이 있는」 사람으로 세지 않는다(아래 직원별 표에는 0건으로 보인다, 2026-11-02)
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot ok"></span>카드 내역이 있는 ' + n0(list.filter(function (x) { return x.n > 0; }).length) + '명 · ' + n0(T.n) + '건</div>' +
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
    // 폰·태블릿(≤820)은 사람마다 한 덩이(rcard) — 가로 스크롤 표라 금액 칸이 화면 밖에 있었다(2026-10-28 로봇)
    // 「카드」 칸(2026-11-02 사용자 요청) — 이름 바로 뒤, 그 사람 카드 끝자리 「1111 · 2222 · 3333 (하)」(cardsTd)
    h += C.sect('직원별', n0(list.length) + '명', '', list.length ? '<div class="panel"><div class="scroll" data-rows><table class="rcard"><thead><tr><th>파트·센터</th><th>이름</th><th>카드</th>' +
      '<th class="n">건수</th><th class="n">금액</th><th>빈칸</th><th></th></tr></thead><tbody>' +
      C.orgGroups(list, function (x) { return x.u; }, true).map(function (g) {
        return C.orgGroupRow(g, 7, '합계 <b>' + won(g.list.reduce(function (s, x) { return s + x.sum; }, 0)) + '</b>') + g.list.map(function (x) {
          return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td>' + cardsTd(x.rows, hp) + '<td class="n" data-l="건수">' + n0(x.n) + '</td>' +
            '<td class="n total" data-l="금액">' + n0(x.sum) + '</td><td' + (x.blank ? ' data-l="빈칸"><span class="st bad">' + n0(x.blank) + '줄</span>' : ' class="rnone"><span class="dim">—</span>') + '</td>' +
            '<td class="n rbtn" style="white-space:nowrap">' +
            (x.n ? '<button class="btn sm" data-cperson="' + esc(x.u) + '">내역</button>' : '') + '</td></tr>';
        }).join('');
      }).join('') + '</tbody></table></div></div>' : C.blank('이 기간에 카드 내역이 있는 사람이 없어요.', null, 'users'));
    h += '<div class="anote">결재 상태 확인, 결재 완료 문서 다운로드, 관리자 반려, 정정 열기는 ‘결재 완료 문서’에서 해요.</div>';
    return h;
  }
  /** 직원 현황(법인카드) — 등록된 모든 직원의 이번 달 카드 내역(카드가 없는 사람도 명단에). */
  function viewAdminPeople() {
    var S = C.state();
    if (!S.LOADED) return C.head('직원 현황') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('직원 현황', '법인카드');
    var rows = adminRows();
    if (!rows || rows.err) return notReady('직원 현황', rows);
    var hp = R.hipassCards ? R.hipassCards(rows) : null;      // 「카드」 칸의 (하) — 받은 그 달 모든 줄로(현황과 같다, 2026-11-03)
    var users = Object.keys(S.USERS || {}).filter(function (u) { return C.orgMatch(u); }), mine = {};
    rows.forEach(function (it) { if (C.orgMatch(it.username)) (mine[it.username] = mine[it.username] || []).push(it); });
    Object.keys(mine).forEach(function (u) { if (users.indexOf(u) < 0) users.push(u); });
    var list = users.map(function (u) {
      var r = mine[u] || [], t = R.totals(r), op = openOf(r);
      // 빈칸 = 열린 줄(상신한 문서에 든 줄은 이미 채워 올렸다) · 결재 = 그 사람 그 달 문서들(2026-11-03)
      return { u: u, n: t.n, sum: t.cost, blank: R.blankRows(op), rows: r, nOpen: op.length, docs: docsOf(u, S.CYCKEY) };
    });
    // 「이번 기간 내역 없음」(2026-11-02 SPEC §5 — 운행일지 직원 현황과 같은 나눔): 자료 기준 이름 「내역 있음·내역 없음」은 그대로 두고,
    //   카드 줄 0건이고 효력이 있는 사람은 「없음 표시」로 따로 센다(「내역 없음」 = 줄도 표시도 없는 사람만)
    var marked = function (x) { return !x.n && !!C.noneEffective && C.noneEffective('card', x.u, S.CYCKEY, x.n, liveStOf(x.docs)); };
    var mk = list.filter(marked).length, has = list.filter(function (x) { return x.n; }).length, none = list.length - has - mk;
    var h = head('직원 현황', n0(list.length) + '명');
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>이번 기간 법인카드</div>' +
      '<p class="verdict">' + (has ? '<em>' + n0(has) + '명</em>이 카드 내역을 올렸어요' : '<em>아직 올린 카드 내역이 없어요</em>') + '</p>' +
      // 칸 넷(f4) — 태블릿(601~900)에서도 한 줄(2026-11-02 화면 검토 L3, 운행일지 직원 현황과 같다)
      '<div class="facts f4">' + fact('등록 인원', n0(list.length) + '<small>명</small>') + fact('내역 있음', n0(has) + '<small>명</small>') + fact('내역 없음', n0(none) + '<small>명</small>') +
      fact('없음 표시', n0(mk) + '<small>명</small>') + '</div></div>';
    list.sort(function (x, y) { return y.sum - x.sum; });
    h += C.sect('명단', n0(list.length) + '명', '', list.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>파트·센터</th><th>이름</th><th>카드</th><th>직급</th>' +
      // 건수 칸은 폭을 정해 둔다(nmcol) — 「없음 표시」 딱지가 생겨도 표 칸 너비가 다시 나뉘지 않게(2026-11-02 화면 검토 L5)
      '<th class="n nmcol">건수</th><th class="n">합계</th><th>빈칸</th><th>결재</th></tr></thead><tbody>' +
      C.orgGroups(list, function (x) { return x.u; }, true).map(function (g) {
        var gm = g.list.filter(marked).length;
        return C.orgGroupRow(g, 8, (gm ? '없음 표시 ' + n0(gm) + '명 · ' : '') + '합계 <b>' + won(g.list.reduce(function (s, x) { return s + x.sum; }, 0)) + '</b>') + g.list.map(function (x) {
          var u = S.USERS[x.u] || {}, nm = marked(x);                   // 건수 칸 — 효력이 있으면 0 대신 딱지
          // 「카드」 칸(2026-11-02 사용자 요청) — 이름 바로 뒤. 건수 칸은 data-l="건수"로 찾는다(칸 차례가 하나 밀렸다)
          return '<tr' + (x.n ? ' class="clk" tabindex="0" data-cperson="' + esc(x.u) + '"' : '') + '>' + C.orgCell(x.u, true) +
            '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td>' + cardsTd(x.rows, hp) + '<td class="dim">' + esc(u.position || '—') + '</td>' +
            '<td class="n' + (x.n || nm ? '' : ' dim') + '" data-l="건수">' + (nm ? '<span class="st dim" data-nonechip>없음 표시</span>' : n0(x.n)) + '</td><td class="n total">' + (x.sum ? n0(x.sum) : '—') + '</td>' +
            '<td>' + (x.blank ? '<span class="st bad">' + n0(x.blank) + '줄</span>' : '<span class="dim">—</span>') + '</td>' +
            '<td>' + apprChips(x) + '</td></tr>';
        }).join('');
      }).join('') + '</tbody></table></div></div>' : C.blank('보는 범위에 직원이 없어요.', null, 'users'));
    h += '<div class="anote">줄을 누르면 전체 내역에서 그 사람의 카드 내역이 열려요.</div>';
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
      : '<div class="panel"><div class="blank"><div class="t">조건에 맞는 카드 내역이 없어요.</div><div style="margin-top:12px"><button class="btn sm" data-cclear>조건 초기화</button></div></div></div>');
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
    C.toast('카드 내역 ' + n0(rows.length) + '건을 CSV로 다운로드했어요.');
  }
  var FINSEL = {}, FINJOB = null;
  // 고르기 · 이 팀 모두 고르기 · 이름으로 찾기는 다시 그리지 않고 그 자리에서(C.fin — 운행일지 결재 완료 출력과 같게, 2026-10-23).
  //   FINSEL 은 기간을 바꾸면 새 객체가 된다(onCycle) — 그래서 고른 것은 함수로 넘긴다.
  //   C.fin 이 없는 앞 판 driving-app.js 와 섞여 실려도(배포 직후 캐시) 죽지 않게 — 그때는 예전 그대로(finOld, 아래 change 처리기).
  var FIN = C.fin || finOld();
  // unit — 법인카드 결재 완료 표는 한 줄이 문서 하나(2026-11-03 추가 상신 — 한 사람이 여러 줄일 수 있다). 고른 수·팀 머리 줄 수를 「건」으로 세 달라는 표시
  FIN.reg('card', { sel: function () { return FINSEL; }, busy: function () { return !!FINJOB; }, unit: '건' });
  function finOld() {
    var nil = function () { return ''; };
    return { old: true, reg: nil, row: nil, box: nil, all: nil, grp: nil, bar: nil, none: nil, fileTag: nil, sync: nil, match: function () { return true; },
      order: function (l, gu) { return { list: l.slice().sort(function (x, y) { return C.nameOf(gu(x)).localeCompare(C.nameOf(gu(y)), 'ko'); }), team: '' }; } };
  }
  /** 결재 완료 출력 표의 날짜 — 「10.14 15:20」(한국시간, 2026-10-20 AU6-M3, 개인경비와 같게). */
  function finWhen(iso) { var ms = Date.parse(iso); return isFinite(ms) ? C.md(ms) + ' ' + C.hm(ms) : ''; }
  /** 결재 완료 문서 표 — 줄 = 문서(2026-11-03). 이름 칸 아래 작은 줄에 꼬리(「카드 끝 1234 · 추가 1」 — 끝자리만). */
  //   꼬리는 「 · 」 조각(C.dn — 칸을 넓히지 않고 칸 안에서 조각 사이에서 꺾인다 · 줄 끝·처음 「·」 없음, 디자인 검사 M1·M3 · T5-6)
  function docSub(a) {
    var t = tagFor(a.card_no, a.seq, a.username, a.cycle);
    return t ? '<div class="dim" style="font-size:12px;margin-top:2px">' + (C.dn ? C.dn(t) : esc(t)) + '</div>' : '';
  }
  /** 결재 중 표 「현재 결재자」 — 「이름 직책 (칸)」의 괄호 안은 한 덩이(줄은 칸 이름 앞에서만, 결재 완료 표 결재선과 같은 규칙 — 2026-11-03 최종 화면 검사 M1). */
  function curStepHtml(s) {
    if (!s || !s.approver) return '—';
    var w = C.stepText(s), i = w.lastIndexOf(' (');
    return i < 0 ? esc(w) : esc(w.slice(0, i)) + ' <span style="white-space:nowrap">' + esc(w.slice(i + 1)) + '</span>';
  }
  /** 이름 차례(같은 사람이면 문서 차례 — 끝자리 → 추가 N). */
  function byNameDoc(x, y) { return C.nameOf(x.username).localeCompare(C.nameOf(y.username), 'ko') || docCmp(x, y); }
  /** 팀 머리 줄의 「N명」 — 줄이 문서인 표는 「N건」(팀즈·결재 완료 표, 2026-11-03). orgGroupRow 가 그린 것을 바꾼다. */
  function grpCount(html, n, unit) { return html.replace(/<span class="on">[^<]*<\/span>/, '<span class="on">' + n0(n) + unit + '</span>'); }
  /** CSV 「카드」 칸 — 「끝 1234 · 추가 1」 · 「여러 카드」 · 「번호 없음」(카드번호 전체는 넣지 않는다). */
  function csvCard(a) {
    if (multiDoc(a)) return '여러 카드';
    var t = cTail(a.card_no);
    return (t ? '끝 ' + t : '번호 없음') + (seqOf(a) >= 2 ? ' · 추가 ' + (seqOf(a) - 1) : '');
  }
  function viewAdminFinal() {
    var S = C.state();
    if (!S.LOADED) return C.head('법인카드 결재 완료 문서') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('법인카드 결재 완료 문서', '결재 완료 문서');
    var all = adminRows();
    if (!all || all.err) return notReady('법인카드 결재 완료 문서', all);
    // 2026-11-03 추가 상신(SPEC §5-7): 줄 = 문서(한 사람이 카드마다 여러 줄). 큰 제목 「결재 완료 N건 · ₩X」 + 「M명」 · 칸 「결재 중 N건」·「반려 N건」·「상신 전 N명」
    //   (상신 전 = 회수 문서나 상신 전 줄이 있는 사람 — 아래 「챙겨야 할 사람」·현황 「챙길 사람」과 같은 사람·같은 글, followOf)
    var list = cycAppr().filter(function (a) { return C.orgMatch(a.username); });
    var done = list.filter(function (a) { return a.status === 'approved'; }).sort(byNameDoc);
    var going = list.filter(function (a) { return a.status === 'submitted'; }).sort(byNameDoc);
    var todo = followList(all.filter(function (it) { return C.orgMatch(it.username); }), S.CYCKEY);
    var nRej = list.filter(function (a) { return a.status === 'rejected'; }).length;
    var pre = todo.filter(function (x) { return x.st !== 'rejected'; }), nWd = pre.filter(function (x) { return x.st === 'withdrawn'; }).length;
    var who = {}; done.forEach(function (a) { who[a.username] = 1; });
    var total = done.reduce(function (s, a) { return s + (Number((a.snapshot || {}).cost) || 0); }, 0);
    var ok = {}; done.forEach(function (a) { ok[a.id] = 1; });
    Object.keys(FINSEL).forEach(function (k) { if (!ok[k]) delete FINSEL[k]; });
    // 「출력 안 한 것만」(2026-10-14) — 표에 보이는 줄만 거른다(위 숫자·합계는 그대로). 고른 수·전체 선택·묶어 받기도 보이는 줄만.
    var shown = C.prints ? done.filter(function (a) { return C.prints.keep('card', a); }) : done;
    // 이름으로 찾기(2026-10-23) — 표에는 shown 을 다 그리고 안 맞는 줄은 C.fin 이 그 자리에서 숨긴다. 고른 수는 보이는 줄만.
    var vis = shown.filter(finVisible), nSel = vis.filter(function (a) { return FINSEL[a.id]; }).length;
    var h = head('법인카드 결재 완료 문서', '결재가 끝난 지출결의서를 모아 출력해요.');
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (done.length && !going.length && !todo.length ? ' ok' : '') + '"></span>' + esc(cycName(S.CYCKEY)) + ' · ' + esc(R.span(S.CYCKEY)) +
      (done.length ? ' · ' + n0(Object.keys(who).length) + '명' : '') + '</div>' +
      '<p class="verdict">결재 완료 <em>' + n0(done.length) + '건</em> · ' + won(total) + '</p><div class="facts">' +
      // 분류는 운행일지 결재 완료 출력과 같은 셋(결재 중·반려·미상신, 결재 완료는 위 큰 제목) — 회수는 다시 올리기 전까지 미상신(2026-10-19)
      fact('결재 중', n0(going.length) + '<small>건</small>', '결재자 차례를 기다리는 중', going.length > 0) +
      fact('반려', n0(nRej) + '<small>건</small>', '고쳐서 다시 상신해야 함', nRej > 0) +
      fact('상신 전', n0(pre.length) + '<small>명</small>', nWd ? '이번 기간 카드 내역이 있는데 상신 전(회수 ' + n0(nWd) + '명 포함)' : '이번 기간 카드 내역이 있는데 상신 전', pre.length > 0) + '</div></div>';
    var tools = done.length ? '<button class="btn sm' + (nSel ? ' pri' : '') + '" data-cfinpdf data-finbtn="card"' + (nSel && !FINJOB ? '' : ' disabled') + '>' + ic('dl', 13) + (nSel ? '고른 ' + n0(nSel) + '건 PDF 한 파일로' : 'PDF 한 파일로 묶기') + '</button>' +
      '<button class="btn sm" data-cfincsv>' + ic('dl', 13) + '금액 요약표(CSV)</button>' + (C.prints ? C.prints.onlyBtn('card') : '') : '';
    h += C.sect('결재 완료', n0(done.length) + '건', tools, done.length && !shown.length
      ? C.blank('출력 안 한 결재 완료 문서가 없어요.', '모두 한 번 이상 출력됐어요. ‘출력 안 한 것만’을 다시 누르면 전체가 보여요.', 'stamp')
      // 2026-10-23: 표 위 이름 찾기 · 팀 머리 줄 「이 팀 모두 고르기」 · 고르기는 다시 그리지 않음(C.fin) · 다시 그려도 안쪽 스크롤 그대로(data-keep)
      : done.length ? FIN.bar('card') + '<div class="panel"><div class="scroll" data-rows data-keep="fin"><table class="rcard ftab" data-fin="card"><thead><tr>' +
      // 세 표 같은 열 순서(팀 묶음 + 파트·센터 · 이름 · 상태) · 「전체 선택」은 표 머리 첫 칸(2026-10-19 사용성 2차 #12, 운행일지와 같게)
      '<th class="fchk"><label class="finall"><input type="checkbox" id="cFinAll"' + FIN.all('card') + (nSel && nSel === vis.length ? ' checked' : '') + '> 전체 선택</label></th>' +
      '<th>파트·센터</th><th>이름</th><th>상태</th><th>날짜</th><th class="n">건수</th><th class="n">금액</th><th>결재선</th><th></th></tr></thead><tbody>' +
      C.orgGroups(shown, function (a) { return a.username; }, true).map(function (g) {
        return grpCount(C.orgGroupRow(g, 9, '합계 <b>' + won(g.list.reduce(function (s, a) { return s + (Number((a.snapshot || {}).cost) || 0); }, 0)) + '</b>', FIN.grp('card', g)), g.list.length, '건') + g.list.map(function (a) {
          var line = (a.steps || []).map(function (s) { return C.stepText(s); }).join(' → '), tg0 = tagFor(a.card_no, a.seq, a.username, a.cycle);
          // 화면 글 — 「(대표이사 칸)」 괄호 안에서는 줄을 바꾸지 않는다(「(대표이사 / 칸)」으로 갈렸다, 2026-10-28 로봇). title 은 위 line 그대로
          var lineH = (a.steps || []).map(function (s) { var w = C.stepText(s), i = w.lastIndexOf(' ('); return i < 0 ? esc(w) : esc(w.slice(0, i)) + ' <span style="white-space:nowrap">' + esc(w.slice(i + 1)) + '</span>'; }).join(' → ');   // 이름 직책 (칸) — 진행 줄·상신 창과 같은 직책(2026-10-16 5차)
          return '<tr' + FIN.row('card', a.id, a.username, (a.snapshot || {}).cost) + '><td><input type="checkbox" data-cfinsel="' + a.id + '"' + FIN.box('card', a.id) +
            (FINSEL[a.id] ? ' checked' : '') + ' aria-label="' + esc(C.nameOf(a.username) + (tg0 ? ' ' + tg0 : '')) + ' 고르기"></td>' +
            C.orgCell(a.username, true) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span>' + docSub(a) + '</td>' +
            '<td><span class="st ok">결재 완료</span>' + (C.prints ? '<div class="prline">' + C.prints.badge('card', a) + '</div>' : '') + '</td>' +
            // 1280 에서 표가 칸보다 넓던 것(2026-10-20 AU6-M3, 개인경비와 같게): 날짜 「MM.DD HH:MM」 · 결재선 두 줄 말줄임 · 단추 셋은 「⋯」 하나
            '<td class="dim" style="white-space:nowrap"' + (a.closed_at ? ' title="결재 완료 ' + esc(C.vx.whenText(a.closed_at)) + '">' + esc(finWhen(a.closed_at)) : '>—') + '</td>' +
            '<td class="n" data-l="건수">' + n0((a.snapshot || {}).n) + '</td><td class="n total" data-l="금액">' + n0((a.snapshot || {}).cost) + '</td>' +
            '<td class="el dim" data-l="결재선" title="' + esc(line) + '"><span style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden">' + lineH + '</span></td>' +
            '<td class="n ract" style="white-space:nowrap">' + C.kmenu(C.nameOf(a.username) + ' 님 ' + (tg0 ? tg0 + ' ' : '') + '결재 완료 문서', [
              ['data-cfzpdf="' + a.id + '"', 'PDF 다운로드'], ['data-cfzxlsx="' + a.id + '"', '엑셀 다운로드'],
              ['data-appr="reopen" data-kind="card" data-id="' + a.id + '"', '정정 열기', true]]) + '</td></tr>';
        }).join('');
      }).join('') + FIN.none(9) + '</tbody><tfoot><tr><td></td><td colspan="5">결재 완료 ' + n0(done.length) + '건 합계</td><td class="n total">' + n0(total) + '</td><td colspan="2"></td></tr></tfoot></table></div></div>'
      : C.blank('아직 결재가 끝난 건이 없어요.', '결재가 끝나면 여기에 모여요.', 'stamp'));
    if (going.length) {
      h += C.sect('결재 중', n0(going.length) + '건', '', '<div class="panel"><div class="scroll" data-rows data-keep="fin-going"><table class="rcard ftab"><thead><tr><th>파트·센터</th><th>이름</th><th>상태</th><th>날짜</th><th class="n">건수</th><th class="n">금액</th><th>현재 결재자</th><th></th></tr></thead><tbody>' +
        C.orgGroups(going, function (a) { return a.username; }, true).map(function (g) { return grpCount(C.orgGroupRow(g, 8, ''), g.list.length, '건') + g.list.map(function (a) {
          var cur = (a.steps || []).filter(function (s) { return s.seq === a.cur_seq; })[0] || {};
          // 날짜는 결재 완료 표처럼 「11.10 07:00」(전체 「상신 2026-11-10 07:00」은 title) — 예전 글(「상신 2026-11-10 07:00」)이 가장 넓은 칸이라 1024 에서 표가 상자보다
          //   27~33px 넓었고, 붙은 「관리자 반려」 칸이 「현재 결재자」 끝 글자(「…파트장 칸)」)를 덮었다(2026-11-03 화면 다듬기)
          return '<tr>' + C.orgCell(a.username, true) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span>' + docSub(a) + '</td><td><span class="st warn">결재 중</span></td>' +
            '<td class="dim" style="white-space:nowrap"' + (a.submitted_at ? ' title="상신 ' + esc(C.vx.whenText(a.submitted_at)) + '">' + esc(finWhen(a.submitted_at)) : '>') + '</td>' +
            '<td class="n" data-l="건수">' + n0((a.snapshot || {}).n) + '</td><td class="n" data-l="금액">' + n0((a.snapshot || {}).cost) + '</td><td class="fcur" data-l="현재 결재자">' + curStepHtml(cur) + '</td>' +
            '<td class="n ract"><button class="btn sm" data-appr="force_reject" data-kind="card" data-id="' + a.id + '">관리자 반려</button></td></tr>';
        }).join(''); }).join('') + '</tbody></table></div></div>');
    }
    if (todo.length) {
      // 현황 「챙길 사람」과 같은 사람·같은 글(followOf) — 반려(사유) · 상신 전(회수됨) · 상신 전(상신 전 줄)
      var ST = { rejected: ['반려', 'bad'], withdrawn: ['상신 전(회수됨)', 'warn'], none: ['상신 전', 'warn'] };
      h += C.sect('챙겨야 할 사람', n0(todo.length) + '명', '', '<div class="panel"><div class="scroll" data-rows data-keep="fin-todo"><table class="rcard ftab"><thead><tr><th>파트·센터</th><th>이름</th><th>상태</th><th>카드 내역</th></tr></thead><tbody>' +
        C.orgGroups(todo, function (x) { return x.u; }, true).map(function (g) {
          return C.orgGroupRow(g, 4, '') + g.list.map(function (x) {
            var m = ST[x.st] || ST.none;
            return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td><td><span class="st ' + m[1] + '">' + esc(m[0]) + '</span></td>' +
              '<td class="el" title="' + esc(x.left) + '">' + esc(x.left) + '</td></tr>';
          }).join('');
        }).join('') + '</tbody></table></div></div>');
    }
    return h;
  }
  function finCsv() {
    // 줄 = 문서(2026-11-03) — 「카드」 칸(「끝 1234 · 추가 1」, 카드번호 전체는 넣지 않는다)
    var S = C.state(), done = cycAppr().filter(function (a) { return a.status === 'approved' && C.orgMatch(a.username); }).sort(byNameDoc);
    var out = [['이름', '아이디', '소속', '카드', '결재 완료', '건수', '금액 합계', '결재 번호']], tn = 0, tc = 0;
    done.forEach(function (a) {
      var s = a.snapshot || {}, op = C.orgPath(a.username);
      tn += Number(s.n) || 0; tc += Number(s.cost) || 0;
      out.push([C.nameOf(a.username), a.username, [C.orgName(op), op.unit].filter(Boolean).join(' · '), csvCard(a), a.closed_at ? C.vx.whenText(a.closed_at) : '', Number(s.n) || 0, Number(s.cost) || 0, a.id]);
    });
    out.push(['합계', '', '', '', '', tn, tc, '']);
    C.saveBlob(new TextEncoder().encode(csvText(out)), '법인카드_결재완료_금액요약_' + S.CYCKEY + scopeSuffix() + '.csv', 'text/csv;charset=utf-8');
    C.toast('요약표를 다운로드해요(' + n0(done.length) + '건).');
  }
  /** 고른 결재 완료 문서를 PDF 한 파일로 — 문서마다 고정본으로 만든 뒤 이어 붙인다(한 번에 20건까지 — 2026-11-03 줄 = 문서). */
  function finBundle() {
    var S = C.state();
    // 보이는 줄만(출력 안 한 것만 2026-10-14 · 이름으로 찾기 2026-10-23) · 차례는 표에 보이는 차례 — 팀 → 파트·센터 → 이름 → (같은 사람이면) 끝자리·추가 N
    var ord = FIN.order(Object.keys(FINSEL).map(apprById).filter(function (a) { return a && a.status === 'approved' && finVisible(a); }).sort(docCmp), function (a) { return a.username; });
    var list = ord.list;
    if (!list.length || FINJOB) return;
    if (list.length > 20) { C.toast('한 번에 20건까지 묶을 수 있어요(지금 ' + list.length + '건). 나눠서 골라 다운로드해 주세요.', true); return; }
    var job = FINJOB = {};
    C.openPanel('법인카드 결재 완료 문서 묶음 다운로드', cycName(S.CYCKEY) + ' · ' + (ord.team ? ord.team + ' · ' : '') + n0(list.length) + '건',
      '<div class="pdfwait"><div class="spin"></div><div id="cFinNote" role="status">준비하는 중…</div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
    var note = function (t) { var el = $('cFinNote'); if (el) el.textContent = t; };
    var alive = function () { if (FINJOB === job && !$('cFinNote')) { FINJOB = null; C.render(); } return FINJOB === job; };
    var parts = [], skipped = [], checks = [], partIds = [];   // partIds — 묶음에 실제로 들어간 결재 건(출력 기록용)
    var one = function (i) {
      if (i >= list.length || !alive()) return Promise.resolve();
      var a = list[i], tg1 = tagFor(a.card_no, a.seq, a.username, a.cycle), who1 = C.nameOf(a.username) + (tg1 ? '(' + tg1 + ')' : '');
      note((i + 1) + ' / ' + list.length + ' · ' + C.nameOf(a.username) + ' 님 ' + (tg1 ? tg1 + ' ' : '') + '문서를 만드는 중…');
      return fetchFrozen(a).then(function (fz) {
        if (!fz) { skipped.push(who1); return; }
        // 결재 완료본 묶음에는 검증 결과 쪽을 넣지 않는다(2026-10-23 사용자 — 2명 이상 묶으면 「검증 결과」 쪽이 끼어 나왔다).
        //   한 사람씩 받는 결재 완료본(frozenOpts)·운행일지 묶음(drv-verify.js finBundle)과 같은 규칙(2026-10-14).
        var d = Object.assign({}, frozenDoc(a, fz), { verify: null });
        return C.fillSigns(d).then(C.vx.ensureLibs).then(function (lib) {
          return window.SheetPdf.buildCard(d, { PDFLib: lib.PDFLib, fontkit: lib.fontkit, fontRegular: lib.fontRegular, fontBold: lib.fontBold });
        }).then(function (res) {
          parts.push(res.bytes); partIds.push(a.id);
          var sum = (res.totals[0] || {}).all || 0, exp = (a.snapshot || {}).cost;
          if (exp != null && Math.round(sum) - Math.round(Number(exp)) !== 0) checks.push(d.person.name + ' 님' + (tg1 ? '(' + tg1 + ')' : '') + ': 문서 합계 ' + n0(sum) + '원과 결재 금액 ' + n0(exp) + '원이 다름');
        });
      }).catch(function () { skipped.push(who1); }).then(function () { if (alive()) return one(i + 1); });
    };
    one(0).then(function () {
      if (!alive()) return null;
      if (!parts.length) throw new Error('만든 문서가 없어요');
      note('한 파일로 묶는 중…');
      var P = window.PDFLib;
      return P.PDFDocument.create().then(function (out) {
        var chain = Promise.resolve();
        parts.forEach(function (b) {
          chain = chain.then(function () { return P.PDFDocument.load(b); }).then(function (src) { return out.copyPages(src, src.getPageIndices()); })
            .then(function (pages) { pages.forEach(function (pg) { out.addPage(pg); }); });
        });
        return chain.then(function () { out.setTitle('법인카드 지출결의 결재 완료 문서 ' + cycName(S.CYCKEY) + (ord.team ? ' ' + ord.team : '')); return out.save(); })
          .then(function (bytes) { return { bytes: bytes, pages: out.getPageCount() }; });
      });
    }).then(function (res) {
      if (FINJOB !== job) { C.render(); return; }
      FINJOB = null;
      if (!res || !$('cFinNote')) { C.render(); return; }
      var blob = new Blob([res.bytes], { type: 'application/pdf' }), url = URL.createObjectURL(blob);
      C.vx.setPdfUrls([url]);
      var file = '법인카드_결재완료_' + S.CYCKEY + FIN.fileTag(ord.team) + '_' + parts.length + '건.pdf';   // 한 팀만이면 팀 이름(2026-10-23) · 문서 수 「N건」(2026-11-03)
      $('pBody').innerHTML = '<div class="pdfdone"><div class="big">' + n0(res.pages) + '<small>쪽</small></div><div class="dim">' + (blob.size / 1e6).toFixed(1) + ' MB · ' + n0(parts.length) + '건 결재 완료 문서</div>' +
        (skipped.length ? '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(skipped.join(', ')) + ' 님 문서는 만들지 못했어요. 한 사람씩 ‘PDF\u00a0다운로드’를 다시 눌러 주세요.</span></div>' : '') +
        (checks.length ? '<div class="awarn">' + ic('alert', 15) + '<span>확인이 필요한 문서가 있어요. 한 사람씩 ‘PDF\u00a0다운로드’를 다시 눌러 확인해 주세요.<br>' + checks.map(function (x) { return esc(x); }).join('<br>') + '</span></div>' : '') +
        (!skipped.length && !checks.length ? '<div class="pdfok">' + ic('check', 15) + '<span>모두 묶었어요. 합계도 맞아요.</span></div>' : '') + '</div>';
      $('pFoot').innerHTML = '<span style="flex:1"></span><button class="btn" data-close>닫기</button><a class="btn" href="' + url + '" download="' + esc(file) + '">' + ic('dl', 14) + '다운로드</a>' +
        '<a class="btn pri" href="' + url + '" target="_blank" rel="noopener">열기 · 인쇄</a>';
      if (C.prints) C.prints.bindOut($('pFoot'), 'card', partIds, url);    // 묶은 사람마다 한 번씩 출력 기록
      C.render();
    }).catch(function (e) {
      if (FINJOB !== job) return;
      FINJOB = null;
      if ($('cFinNote')) $('pBody').innerHTML = '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(failMsg('PDF 한 파일로 묶지 못했어요', e, '새로고침한 뒤 다시 해 주세요.')) + '</span></div>';
      C.render();
    });
    C.render();
  }

  /* ══════════════════ 이벤트 ══════════════════ */
  // 대상 고르기는 본체 처리기(data-v 화면 옮기기 · data-fixgo 결재함 「수정 후 다시 상신 →」)보다 먼저 — 옮겨 간 화면이 고른 대상으로 그려지게(붙잡기 단계, 2026-11-03)
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-ctarget]');
    if (el) { CSEL[C.state().CYCKEY] = el.dataset.ctarget; return; }
    // 「상신」 창을 여는 단추(검증·상신 ③ · PDF 확인 뒤 저절로) — 그 순간 고른 대상을 붙잡는다(고침 1 H1). 다른 문서 종류의 창이면 푼다.
    //   본체가 창을 열지 않았으면(이미 상신했어요 등) 바로 푼다 · 열었으면 그 창이 끝날 때까지 이 대상만
    el = e.target.closest && e.target.closest('#btnOpenSubmit');
    if (el) {
      if (el.dataset.kind !== 'card') { PIN = null; return; }
      var cy = C.state().CYCKEY, tg = selTarget(cy), pin = PIN = tg ? pinOf(cy, tg) : null;
      if (pin) setTimeout(function () { if (PIN !== pin) return; if ($('panel').classList.contains('open') && document.querySelector('#pBody .agrid')) pin.live = true; else PIN = null; }, 0);
      return;
    }
    // 결재함 카드(법인카드 · 내 반려·회수 문서)의 「수정 후 다시 상신 →」 — 그 문서를 그 기간의 대상으로 골라 둔다
    el = e.target.closest && e.target.closest('[data-fixgo]');
    var ac = el && el.closest('[data-akey]'), m = ac && /^card:(\d+)$/.exec(ac.getAttribute('data-akey') || '');
    if (m && el.dataset.fixcyc) CSEL[el.dataset.fixcyc] = 'd' + m[1];
  }, true);
  document.addEventListener('click', function (e) {
    var el;
    if (FINJOB && e.target.closest('[data-close]') && $('cFinNote')) { FINJOB = null; setTimeout(function () { C.render(); }, 0); }
    // 카드 묶음 머리 줄 「상신하기 →」·「다시 상신 →」 → 검증·상신 · 검증 화면 「상신할 카드」 → 그 대상으로 다시 그림(고르기는 위 붙잡기 단계에서 했다).
    //   data-v 가 함께 있으면(결재 띠 「수정 후 다시 상신 →」) 화면 옮기기는 본체가 한다
    if ((el = e.target.closest('[data-ctarget]'))) {
      if (el.hasAttribute('data-v')) return;
      if (C.state().VIEW !== 'c_verify') C.go('c_verify'); else C.render();
      return;
    }
    // 문서가 셋 이상일 때 접힌 결재 띠 — 「펼치기」·「접기」(문서마다 이 탭에서 기억)
    if ((el = e.target.closest('[data-cstriptog]'))) {
      var sid = el.dataset.cstriptog;
      if (CSTRIP[sid]) delete CSTRIP[sid]; else CSTRIP[sid] = 1;
      C.render();
      var tb = document.querySelector('[data-cstriptog="' + sid + '"]'); if (tb) { try { tb.focus({ preventScroll: true }); } catch (er) { } }
      return;
    }
    if (e.target.closest('[data-cup]')) { openUpload(); return; }
    if (e.target.closest('#btnCUpGo')) { runUpload(); return; }
    if ((el = e.target.closest('[data-csug]'))) {
      var inp = document.querySelector('.cin[data-cid="' + el.dataset.csug + '"][data-f="category"]');
      if (inp && !inp.disabled) { inp.value = el.dataset.cat; inp.classList.remove('need'); saveCell(el.dataset.csug, 'category', el.dataset.cat); paintMeal(el.dataset.csug); el.remove(); paintSug(); }
      return;
    }
    if (e.target.closest('[data-csugall]')) { fillSuggest(); return; }
    if (e.target.closest('[data-cretry]')) { retrySaves(); return; }
    if ((el = e.target.closest('[data-cdel]'))) { openDel(el.dataset.cdel); return; }
    if ((el = e.target.closest('#btnCDelGo'))) { if (!el.disabled) runDel(el.dataset.id); return; }
    // 다시 불러오기 — 줄과 결재 목록 둘 다(결재 목록을 못 받은 때도 이 단추, 고침 1 M1)
    if (e.target.closest('[data-creload]')) { ITEMS = {}; loadAppr().then(function () { if (!typing()) C.render(); }); C.render(); return; }
    if (e.target.closest('[data-cvrun]')) { runCheck(); return; }
    if ((el = e.target.closest('[data-cvfix]'))) { var it = VITEMS[+el.dataset.cvfix], ref = (it && it.ref && it.ref.items) || []; if (ref.length) focusRow(ref[0], it.code); return; }
    if (e.target.closest('[data-cgoblank]')) { var bid = firstBlankId(); if (bid != null) focusRow(bid); return; }
    if (e.target.closest('[data-cpdf]')) { pdfMine(); return; }
    if ((el = e.target.closest('[data-cpdfok]'))) {
      // 미리 본 대상 tid — 확인 열쇠(vkey = 사람|기간|대상 tid)의 셋째 조각(setPreviewed·previewOk 와 같은 자르기)
      var pk = el.dataset.cpdfok, ptid = String(pk).split('|')[2] || '';
      setPreviewed(pk, true);
      C.closePanel();
      if (C.state().VIEW !== 'c_verify') C.go('c_verify'); else C.render();
      // 이름대로 바로 상신 창을 연다(2026-10-15 매뉴얼 로봇: 창만 닫혀 한 번 더 눌러야 했다). 아직 못 누르는 상태면 그 단추로 데려간다.
      //   (2026-11-03 최종 검토 M1) 지금 고른 대상이 방금 미리 본 대상일 때만 — 창을 닫을 때 맡아 둔 조용히 받기가 들어가(closePanel → navKick)
      //   미리 본 카드가 대상에서 빠지면 고른 대상이 첫 대상(다른 카드)으로 바뀐다. 그 카드 창을 저절로 열면 그 카드가 그대로 올라갔다 — 열지 않고 알린다.
      //   알림은 대상을 알 때만(다른 대상으로 바뀜 · 결재 목록과 줄을 받아 둔 채 대상 없음) — 모르면 화면의 띠·뼈대가 말한다
      setTimeout(function () {
        var S1 = C.state();
        if (S1.VIEW !== 'c_verify') return;
        var t1 = selTarget(S1.CYCKEY), x1 = ITEMS[itemKey(false, S1.CYCKEY)];
        if (!t1 || t1.tid !== ptid) { if (t1 || (apprKnown() && x1 && x1.rows)) C.toast(PIN_GONE, true); return; }
        var b = document.getElementById('btnOpenSubmit'); if (b) { try { if (!b.disabled) b.click(); else { b.focus(); b.scrollIntoView({ block: 'center', behavior: (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') }); } } catch (er) { } }
      }, 60);
      return;
    }
    if ((el = e.target.closest('[data-cfzpdf]'))) { pdfFrozen(el.dataset.cfzpdf); return; }
    if ((el = e.target.closest('[data-cfzxlsx]'))) { xlsxFrozen(el.dataset.cfzxlsx); return; }
    if ((el = e.target.closest('[data-cfzverify]'))) {
      var a = apprById(el.dataset.cfzverify), f = a && FZSUM[fzKey(a)];
      if (f && f.verify) {
        var vsub = cycName(a.cycle) + withDup(docSuffix(a.card_no, a.seq), a.card_no, dupOf(a.username, a.cycle)) + ' · 상신 시점';
        C.vx.showItems(C.nameOf(a.username) + ' 법인카드 검증 결과', vsub, vOf(f.verify, Date.parse(f.verify.ran_at || f.frozen_at)), a.username !== C.myName());
        subDn(vsub);
      }
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
    // 결재 완료 출력 고르기 칸 · 전체 선택 · 이 팀 모두 고르기는 C.fin(driving-app.js)이 받는다 — 다시 그리지 않는다(2026-10-23).
    //   C.fin 이 없는 앞 판 driving-app.js 와 섞여 실렸을 때만 아래 예전 처리(고르면 다시 그림).
    if (!FIN.old) return;
    if (t.matches && t.matches('[data-cfinsel]')) { if (t.checked) FINSEL[t.dataset.cfinsel] = 1; else delete FINSEL[t.dataset.cfinsel]; C.render(); return; }
    if (t.id === 'cFinAll') {
      cycAppr().forEach(function (a) { if (a.status === 'approved' && C.orgMatch(a.username) && finVisible(a)) { if (t.checked) FINSEL[a.id] = 1; else delete FINSEL[a.id]; } });
      C.render();
    }
  });
  /** 보이는 줄인가 — 「출력 안 한 것만」(2026-10-14) + 이름으로 찾기(2026-10-23). 고른 수·묶어 받기가 화면과 같은 판정. */
  function finVisible(a) { return (!C.prints || C.prints.keep('card', a)) && FIN.match('card', a.username); }

  /** 정정 열기(관리자)로 다시 연 반려 문서인가 — 본체 reopenInfo 와 같은 판정(결재 단계에 reopened_by). */
  function reopened(a) { return !!(a && (a.steps || []).some(function (x) { return x && x.reopened_by; })); }
  var K0 = {
    tag: '법인카드', mode: 'c',
    rows: function () { return CAPPR || []; },
    // ── 한 기간에 문서가 여럿(2026-11-03 추가 상신 — PLAN K5 갈고리, 본체 driving-app.js 가 있으면 쓴다) ──
    /** 이번 상신이 덮을 죽은 대상 문서(반려·회수 — 다시 상신) · 새 문서면 null. 상신 창의 「이미 상신했어요」 막기·이번 기간 결재선·의견 불러오기가 쓴다. */
    //   (고침 1 H1) 상신 창이 열려 있으면 모두 붙잡은 대상(PIN)만 — 고른 대상이 그 사이 바뀌어도 따라가지 않는다
    mine: function (cyc) {
      var P = pinNow();
      if (P && P.cyc === cyc) return P.approval_id != null ? apprById(P.approval_id) : null;
      var t = selTarget(cyc);
      if (t) return t.approval_id != null ? apprById(t.approval_id) : null;
      // 상신할 대상이 없고 그 달 문서가 모두 살아 있으면 그 문서(결재 중 먼저) — 본체 openSubmit 이 「이미 상신했어요」·「이미 결재가 끝났어요」로 막는다(고침 1 L1)
      var d = myDocs(cyc), live = d.filter(function (a) { return isLive(a.status); });
      return d.length && live.length === d.length ? (live.filter(function (a) { return a.status === 'submitted'; })[0] || live[0]) : null;
    },
    /** 상신 대상 표시(tid — 문서 번호 또는 카드 키 짧은 지문, 카드번호 아님) — 넣다 만 결재선·의견 열쇠가 대상마다 따로. */
    draftTag: function () { var P = pinNow(), t = P ? null : selTarget(C.state().CYCKEY); return P ? P.tid : t ? t.tid : ''; },
    /** 상신 본문에 더할 칸(PLAN K2 + 고침 1 M1) — card_no(대상 카드 키, 여러 카드 예전 문서면 null) · approval_id(다시 상신할 죽은 문서 번호, 새 문서면 null) ·
     *  item_ids(미리 본 대상 줄 번호, 오름차순 — 서버 대상 줄과 다르면 409 STALE_DATA). 붙잡은 대상 그대로(바뀌었으면 beforeSubmit 이 멈춘다). 대상이 없으면 null. */
    submitExtra: function () {
      var P = pinNow();
      if (P) return { card_no: P.card_no, approval_id: P.approval_id, item_ids: P.ids.slice() };
      var t = selTarget(C.state().CYCKEY);
      return t ? { card_no: t.card_no == null ? null : t.card_no, approval_id: t.approval_id == null ? null : t.approval_id, item_ids: idsOf(t) } : null;
    },
    /** 같은 기간 가장 최근 내 문서(새 칸 모양 v2, 상태 상관없음) — 상신 창 결재선 미리 채우기 ③(SPEC §5-4, 초안 §2). */
    lineFrom: function (cyc) {
      return myDocs(cyc).filter(function (a) { return (a.steps || []).length && (C.boxSetOf ? C.boxSetOf(a) === 'v2' : a.box_set === 'v2'); })
        .sort(function (x, y) { return cmpS(y.submitted_at, x.submitted_at) || (Number(y.id) || 0) - (Number(x.id) || 0); })[0] || null;
    },
    /** 결재함 「수정 후 다시 상신 →」 — 내 반려·회수 문서마다(그 기간 줄을 받았으면 그 문서가 대상(줄이 있다)일 때만, 받지 않았으면 고칠 화면으로 가는 길은 둔다). */
    canFix: function (a) {
      if (!a || a.username !== me() || !isDead(a.status)) return false;
      var x = ITEMS[itemKey(false, a.cycle)];
      if (CAPPR === null || !x || !x.rows) return true;
      return targetsOf(a.cycle).some(function (t) { return String(t.approval_id) === String(a.id); });
    },
    /** 기간이 끝나기 전 상신 되묻기 글(완성 글 — 여기서 esc). */
    earlyText: function (endD) {
      return '아직 기간이 끝나지 않았어요. 이 기간은 ' + esc(endD) + '까지예요. 지금 상신해도 나중에 올리는 카드 내역은 같은 카드의 다음 문서(추가)로 따로 상신해요.';
    },
    lockText: '상신한 뒤에 이 문서에 든 카드 내역을 고치려면 먼저 회수해야 해요.',
    /** 문서 짧은 이름(「10월분 · 카드 끝 1234」 — 끝자리만) — 종·알림 글. */
    docShort: function (a) { return a ? docShort(a) : ''; },
    /** 상신이 서버에서 막혔을 때(409·404 · 400 CARD_* — 대상이 그 사이 바뀜) — 문서·줄을 다시 받아 다시 그린다. 알림 글은 본체가 이미 띄웠다. */
    //   (고침 1 H1) 다시 받은 뒤 — 붙잡은 대상이 없어졌거나 바뀌었으면 창을 닫고 대상 고르기로(다른 카드로 말없이 바꾸지 않는다) · 그대로면 창 머리를 지금 자료로
    onSubmitFail: function (ej, st) {
      var code = String((ej && (ej.code || ej.error)) || '');
      if (st !== 409 && st !== 404 && !(st === 400 && /^CARD_/.test(code))) return;
      var cyc = C.state().CYCKEY, P = pinNow();
      dropItems(cyc);
      // 줄과 결재 목록이 둘 다 들어온 뒤에만 판단한다(T7-6 — 결재 목록이 먼저 오면 줄이 아직 없는 채로 「바뀌었어요」라며 창을 닫았다).
      //   받는 사이 판단은 마지막에 들어온 쪽의 pinCheck 가 먼저 할 수 있다(창이 닫혔으면 여기서는 머리만 둔다)
      Promise.all([loadAppr(), loadItems(cyc, false, true)]).then(function () { return settledFor(cyc); }).then(function () {
        if (P && pinNow() === P) {
          var t = pinTarget(P);
          if (t === undefined) pinStop('카드 내역이나 결재 목록을 다시 불러오지 못했어요. 잠시 후 검증·상신에서 다시 상신해 주세요.');
          else if (!t) pinStop(PIN_GONE);
          else pinHead();
        }
        if (!typing() && CVIEWS.indexOf(C.state().VIEW) >= 0) C.render();
      });
    },
    reload: function () { var S = C.state(); dropItems(S.CYCKEY); return Promise.all([loadAppr(), loadItems(S.CYCKEY, false, true)]); },
    sumLine: function (a) { var s = a.snapshot || {}; return s.cost != null ? n0(s.n) + '건 · ' + won(s.cost) : ''; },
    sumHtml: sumHtml,
    extra: extra,
    previewBytes: previewBytes,
    wantSummaries: wantSums,
    // 결재함·결재 창 이름 — 긴 이름(「2026년 10월분 (10.01~10.31) · 카드 끝 1234」). {cycle} 만 받으면(문서 아님 — 팀즈 알림 창 등) 꼬리 없음(SPEC §5-6)
    cycName: function (a) { return docLong(a) + ' · 법인카드 지출결의'; },
    cycLabel: function (a) { return docLong(a); },
    submitHead: function () {
      // 고른 대상(카드) 줄만(2026-11-03 SPEC §5-4) — 제목 「2026년 10월분 법인카드 상신 · 카드 끝 1234」, 아래 줄 = 기간·건수·금액·빈칸
      //   (고침 1 H1) 창이 붙잡은 대상으로 — 그 대상이 그 사이 바뀌었으면 제목은 그대로 두고 경고(상신은 beforeSubmit 이 멈춘다)
      //   줄·결재 목록을 다시 받는 중이라 지금 모습을 모르면(undefined — T7-6) 붙잡을 때의 대상으로 그리고 경고는 하지 않는다
      var S = C.state(), cyc = S.CYCKEY, P = pinNow(), pt = P ? pinTarget(P) : null, t = P ? (pt === undefined ? P.t : pt) : selTarget(cyc);
      var rows = tItems(t), T = R.totals(rows), warn = [], bl = R.blankRows(rows);
      var nm = P ? tagFor(P.card_no, P.seq, me(), cyc) : t ? tagFor(t.card_no, t.seq, me(), cyc) : '';
      if (P && pt === null) warn.push(PIN_GONE);
      else if (!t) warn.push(mineRows(cyc).length ? '상신할 카드 내역이 없어요. 이 기간 카드 내역은 모두 상신한 문서에 들어 있어요.' : '이 기간에 올린 카드 내역이 없어요. 먼저 ERP 엑셀을 올려 주세요.');
      if (bl) warn.push('구분·사용목적이 빈 줄이 ' + n0(bl) + '건 있어요. 채워야 상신할 수 있어요.');
      return { title: cycName(cyc) + ' 법인카드 상신' + (nm ? ' · ' + nm : ''), sub: R.span(cyc) + ' · ' + n0(T.n) + '건 · ' + won(T.cost) + (bl ? ' · 빈칸 ' + n0(bl) + '줄' : ''), warn: warn };
    },
    rangeHi: function () { return rangeHiMs(C.state().CYCKEY); },
    beforeSubmit: beforeSubmit,
    verifyView: 'c_verify',
    withdrawText: '이 문서에 든 카드 내역(구분·사용목적)을 다시 고칠 수 있게',
    // 아래 둘은 갈고리(earlyText·lockText)가 없는 앞 판 본체(배포 직후 캐시)용 — 예전 글 그대로
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
      // 달 상태(2026-11-03 SPEC §5-9 monthState.st) — 반려 > 회수 > 상신 전 줄('') > 결재 중 > 결재 완료. 그 기간 줄을 안 받았으면 문서만으로
      status: function (k) { var ms = myMonth(k); return ms ? ms.st : ''; },
      // 「이번 기간 내역 없음」 효력(2026-11-02) — 마감 띠(graceBand)·포털 hint 가 쓴다. true·false = 안다 · null = 그 기간 줄을 받지 않아 모름(효력 없음으로 친다)
      none: function (k) { return noneOn(k); },
      // 포털 한 줄이 정정 열기를 「정정 중」으로 가른다(2026-10-21) — 문서가 여럿이면 정정 중 반려 문서 먼저, 그다음 반려 · 회수 · 결재 중 · 결재 완료(같으면 최근 것)
      row: function (k) {
        var rk = function (a) { return a.status === 'rejected' ? (reopened(a) ? 0 : 1) : isDead(a.status) ? 2 : a.status === 'submitted' ? 3 : 4; };
        return myDocs(k).sort(function (x, y) { return rk(x) - rk(y) || cmpS(y.submitted_at, x.submitted_at) || (Number(y.id) || 0) - (Number(x.id) || 0); })[0] || null;
      },
      // 포털 hint(PLAN K6) — 상태별 문서 수 · left = 상신 전 줄 수(그 기간 줄을 받았을 때만 숫자, 아니면 null). 결재 목록을 못 받았으면 null(모름)
      docs: function (k) {
        var ms = myMonth(k);
        return ms ? { sub: ms.sub, app: ms.app, rej: ms.rej, wd: ms.wd, left: typeof ms.left === 'number' ? ms.left : null } : null;
      } },
    load: loadWith,
    onGo: function (v, prev) {
      if (v === 'c_verify') CFRESH = {};          // 검증 화면에 들어올 때마다 ① 검증하기부터(운행일지·개인경비와 같게, 2026-10-20 V3 U9)
      if (v === 'ca_list' && prev !== 'ca_close' && prev !== 'ca_people') CL = { cat: '', who: '', blank: false };
      if (ADMIN_C.indexOf(v) >= 0 && isAdmin()) loadItems(C.state().CYCKEY, true);
    },
    onCycle: function () { MISSING = {}; FINSEL = {}; FAILED = {}; LAST_SAVE = 0; CSTRIP = {}; },   // 고른 대상(CSEL)은 기간마다 따로라 그대로 둔다
    dirty: function () {
      if (C_SENDING || pending()) return true;
      if ($('cDrop') && CUP && CUP.plan && !CUP.sent) return true;
      return false;
    }
  };
});
