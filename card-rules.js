/* ═══════════════════════════════════════════════════════════════════════════
   card-rules.js — 법인카드 지출결의 규칙(웹) (2026-10-09, docs/card/SPEC.md §0·§3·§4)
   ---------------------------------------------------------------------------
   · 기간(달력 한 달)·검증(C01~C10 — C07·C08 의 AI 쪽은 서버가 받아 둔 Gemini 결과를 표시만)·합계 — 서버 supabase/functions/_shared/card-verify.ts 와 **글자 하나까지 같은 판정**.
     한쪽을 고치면 다른 쪽도 고치고 `node ACTs-ATECmobility/web/test/card-parity.test.mjs` 를 돌린다.
   · 구분 추천(웹만): ① 같은 가맹점에 본인이 전에 쓴 구분 ② 음식 업종은 승인 시각
     (05–10 조식대 · 10–15 중식대 · 15–17 다과비 · 17–05 석식대) ③ 주유·충전 → 주유비 ④ 주차 → 주차비 ⑤ 통신 → 통신비
     ⑥ 철도·항공·택시·고속 → 교통비 ⑦ 그 밖은 추천 없음. AI 는 쓰지 않는다. 추천은 확정 전까지 연하게(화면 몫).
   · 추가 상신(2026-11-02, docs/card-multi/SPEC.md): 한 사람·한 달에 문서 여럿(문서 하나 = 카드 한 장) — 이름(docName·docSuffix)·대상 목록(docTargets)·
     달 상태(monthState)·관리 「카드」 칸(cardList)이 서버 _shared/card-doc.ts 와 같은 판정(card-parity 시험).
   · 문자열 비교는 < > 로만(localeCompare 는 런타임마다 다를 수 있다), 천 단위 쉼표는 정규식으로(toLocaleString 금지).
   브라우저(window.CardRules)·Node(require) 양쪽.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  // ★ 2026-10-20 연말 마감 설정: 기간 범위는 엔진(cycle-rules.js)에서 — 브라우저는 window.CycleRules(이 파일보다 먼저 싣는다), Node 는 require.
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./cycle-rules.js'));
  else root.CardRules = factory(root.CycleRules);
})(typeof self !== 'undefined' ? self : this, function (CR) {
  'use strict';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function n0(v) {
    var x = Math.round(Number(v) || 0), neg = x < 0;
    return (neg ? '-' : '') + String(Math.abs(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function str(v) { return String(v == null ? '' : v); }
  function cmpS(a, b) { a = str(a); b = str(b); return a < b ? -1 : a > b ? 1 : 0; }

  /* ── 기간(SPEC §0) — 당월 1일 00:00 ~ 말일 24:00(KST) ──
     ★ 2026-10-20 연말 마감 설정: 범위는 엔진(cycle-rules.js 의 'card') — 관리자가 정하지 않으면 달력 한 달 그대로(글자 하나까지 지금과 같다).
       12월분을 12.20 에서 끊거나 12월 추가 기간('2026-12b' = 「2026년 12월분 2차」)을 두면 그 범위. 이름은 키로 만든다(override 의 label 은 쓰지 않는다).
       서버 card-verify.ts 와 같은 답 — 키 꼴('YYYY-MM' · 'YYYY-12b')만 엔진에 묻고, 엔진에 없는 기간·다른 글자는 예전 식 그대로. */
  var KEY_STD = /^\d{4}-(0[1-9]|1[0-2])$/, KEY_X = /^\d{4}-12b$/;
  function per(cycle) { var s = str(cycle); return KEY_STD.test(s) || KEY_X.test(s) ? CR.byKey('card', s) : null; }
  /** '2026-07' → '2026년 7월분' · '2026-12b' → '2026년 12월분 2차'(DB cycle_label · 서버 periodName 과 같다). */
  function pname(s) { return KEY_X.test(s) ? +s.slice(0, 4) + '년 12월분 2차' : +s.slice(0, 4) + '년 ' + +s.slice(5, 7) + '월분'; }
  function isCycle(c) { var s = str(c); return KEY_STD.test(s) || (KEY_X.test(s) && !!per(s)); }
  function ym(cycle) { var p = str(cycle).split('-'); return { y: +p[0], m: +p[1] }; }
  /** 기간 마지막 날(일) — 기본은 그 달 말일, 12월분을 당기면 그 날(서버 cardLastDay 와 같다). */
  function lastDay(cycle) {
    var P = per(cycle);
    if (P) return +P.hi.slice(8, 10);
    var c = ym(cycle); return new Date(Date.UTC(c.y, c.m, 0)).getUTCDate();
  }
  function mdOf(s) { return s.slice(5, 7) + '.' + s.slice(8, 10); }
  function dayAfter(s) { var t = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + 1)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); }
  /** { lo, hi } 'YYYY-MM-DD' — hi 는 끝날 다음 날(들어가지 않음). */
  function cycleRange(cycle) {
    var P = per(cycle);
    if (P) return { lo: P.lo, hi: dayAfter(P.hi) };
    var c = ym(cycle), ny = c.m === 12 ? c.y + 1 : c.y, nm = c.m === 12 ? 1 : c.m + 1;
    return { lo: c.y + '-' + pad(c.m) + '-01', hi: ny + '-' + pad(nm) + '-01' };
  }
  /** '2026-07' → '07.01 – 07.31'(화면 머리띠·문서). */
  function span(cycle) {
    var P = per(cycle);
    if (P) return mdOf(P.lo) + '~' + mdOf(P.hi);
    var c = ym(cycle); return pad(c.m) + '.01~' + pad(c.m) + '.' + pad(lastDay(cycle));
  }
  /** '2026-07' → '2026년 7월분(07.01 ~ 07.31)'(팀즈·검증 문구 — SPEC §3 꼴 그대로). '2026-12b' → '2026년 12월분 2차(12.21 ~ 12.31)',
   *  설정에 없는 '2026-12b' 는 이름만(「2026년 12월분 2차」 — 서버와 같다). */
  function cycleLabel(cycle) {
    var s = str(cycle);
    if (!isCycle(s)) return KEY_X.test(s) ? pname(s) : s + '분';
    var P = per(s);
    if (P) return pname(s) + '(' + mdOf(P.lo) + ' ~ ' + mdOf(P.hi) + ')';
    var c = ym(cycle);
    return c.y + '년 ' + c.m + '월분(' + pad(c.m) + '.01 ~ ' + pad(c.m) + '.' + pad(lastDay(cycle)) + ')';
  }

  /* ── 검증(SPEC §3) ── */
  function blank(v) { return str(v).trim() === ''; }
  /** 구분 또는 사용목적이 빈 줄 수 — 상신을 막는 기준. */
  function blankRows(items) { return (items || []).filter(function (e) { return blank(e.category) || blank(e.purpose); }).length; }
  function normName(s) { return str(s).replace(/\s+/g, ''); }
  function some(list, max) {
    return list.length <= max ? list.join(', ') : list.slice(0, max).join(', ') + ' 외 ' + (list.length - max) + '건';
  }
  function merchantOf(e) { return str(e.merchant).trim() || '가맹점 없음'; }
  /** 줄을 한 마디로: "07.03 가짜식당 19,800원" */
  function tagOf(e) { return str(e.appr_date).slice(5).replace('-', '.') + ' ' + merchantOf(e) + ' ' + n0(e.amount) + '원'; }

  /* ── 하이패스 카드(2026-11-02 사용자) — 소유자 확인(C05)을 하지 않는 줄 ──
     하이패스 카드는 ERP 소유자가 사람이 아니라 센터·차량(「○○센터1234」)으로 나오고 주유·통행료에만 쓸 수 있다(사용자).
     하이패스 카드 = 가맹점에 「하이패스」가 든 줄(ERP 「후불하이패스N건」 통행료)이 한 줄이라도 있는 카드번호.
     빼는 줄 = 하이패스 통행료 줄 자체 + 하이패스 카드의 주유·통행료 줄(업종·가맹점 FUEL). 그 카드의 다른 줄(식당 등)은 그대로 C05 —
       하이패스 겸용 개인 카드를 남이 올린 경우를 잡으려고(검증 로봇 M2). 글자는 NFKC 로 고른 뒤 공백·-·_·.·가운뎃점을 빼고 본다.
     올리기 화면의 「소유자가 내 이름이 아닌 줄」(card-erp.js)도 이것을 쓴다. 서버 card-verify.ts 와 같은 판정(card-parity 시험). */
  function nfkc(v) { var s = str(v); return s.normalize ? s.normalize('NFKC') : s; }
  // 사이 글자는 NFKC 앞뒤로 한 번씩 뺀다 — 「ㆍ」(U+318D)는 NFKC 에서 다른 글자(가운데 홀소리)로 바뀌어 뒤에서는 못 뺀다
  var HP_SEP = /[\s\-_.·ㆍ・•‧]+/g;
  function isHipassMerchant(m) { return /하이패스|hipass/i.test(nfkc(str(m).replace(HP_SEP, '')).replace(HP_SEP, '')); }
  var FUEL = /주유|충전|오일|정유|s-?oil|에스오일|lpg|연료|에너지|도로공사|통행료|톨게이트/i;
  /** 주유·통행료 줄인가(업종 또는 가맹점, 공백은 빼고 — ERP 업종은 「주 차 장」처럼 띄어 쓰기도 한다). */
  function fuelOrToll(e) {
    return isHipassMerchant(e && e.merchant) || FUEL.test(nfkc(e && e.biz_type).replace(/\s+/g, '')) || FUEL.test(nfkc(e && e.merchant).replace(/\s+/g, ''));
  }
  function cardKey(v) { return str(v).replace(/\s+/g, ''); }
  /** 하이패스 카드 번호 모음 { 카드번호: true }(카드번호의 공백은 뺀다). */
  function hipassCards(list) {
    var set = Object.create(null);
    (list || []).forEach(function (e) { var k = cardKey(e && e.card_no); if (k && isHipassMerchant(e && e.merchant)) set[k] = true; });
    return set;
  }
  /** 소유자 확인을 하지 않는 줄인가 — 하이패스 통행료 줄이거나, 하이패스 카드의 주유·통행료 줄. */
  function onHipass(e, set) {
    if (isHipassMerchant(e && e.merchant)) return true;
    var k = cardKey(e && e.card_no);
    return k !== '' && !!set && set[k] === true && fuelOrToll(e);
  }

  /* ── 식대 13,000원 넘으면 비고에 이름·사유(2026-11-02 사용자 결정, docs/meal-note/SPEC.md) — C10 ──
     식사 줄 = 구분(category)에 식사 낱말이 있고 회식·접대·협의·회의 낱말(회식·회의는 앞 글자가 「호」·숫자면 아님)도 간식·숙식도 없는 줄. 카드사 업종은 보지 않는다.
     글자는 NFKC 로 고른 뒤, 식사 낱말은 공백을 모두 뺀 글에서(「중 식 대」 = 「중식대」) · 빼는 낱말은 공백을 남긴 글(이어진 공백은 한 칸)에서 찾는다
     (「야간 식대」·「합숙 식사」·「학회 식대」가 낱말 경계를 넘어 간식·숙식·회식으로 걸리지 않게 — 2026-11-02 재검토 N1·N2). 금액은 줄 금액 > 13,000원(같으면 아님) — 인원으로 나누지 않는다.
     비고가 「됐다」 = NFKC 뒤 앞뒤 공백을 뺀 글이 비어 있지 않고, 「외 N명」·「외 N인」·「외 N분」 꼴이 없고, 인원수만 적은 것(「3명」·「2분」)도 아닐 때. 이름인지 사유인지는 가리지 않는다(결재자가 본다).
     「외 N명」·인원수로는 인원을 세지 않는다 — 함께한 분 이름을 모두 적게 한다.
     서버 card-verify.ts(cardIsMealLine·cardMealNoteOk·cardMealNeedsNote)와 같은 판정(card-parity 시험). 이번 달 표의 비고 칸(drv-card.js)도 이것을 쓴다. */
  var MEAL_LIMIT = 13000;
  var MEAL_WORDS = /식대|식비|식사|조식|중식|석식|야식|점심|저녁|아침|도시락|밥/;
  // 「회식」·「회의」는 바로 앞 글자가 「호」나 숫자가 아닐 때만(2026-11-02 검토 L4 — 「동호회 식대」·「1회 식대」는 식대) · 간식·숙식은 식사가 아니다(「간식비」·「숙식비」)
  var MEAL_SKIP = /(?:^|[^호0-9])회(?:식|의)|접대|협의/;
  var MEAL_NOT = /간식|숙식/;
  /** 식사 낱말을 찾는 글 — NFKC 뒤 공백을 모두 뺀다(「중 식 대」 = 「중식대」). */
  function mealKey(v) { return nfkc(v).replace(/\s+/g, ''); }
  /** 빼는 낱말을 찾는 글 — NFKC 뒤 이어진 공백을 한 칸으로(공백은 남긴다, 2026-11-02 재검토 N1·N2). 서버 card-verify.ts mealText 와 같은 다듬기. */
  function mealText(v) { return nfkc(v).replace(/\s+/g, ' '); }
  /** 식사 줄인가 — 구분에 식사 낱말이 있고 회식·접대·협의·회의 낱말도 간식·숙식 낱말도 없을 때. 금액·비고는 보지 않는다. */
  function isMealLine(e) { var t = mealText(e && e.category); return MEAL_WORDS.test(mealKey(t)) && !MEAL_SKIP.test(t) && !MEAL_NOT.test(t); }
  /** 비고가 「됐다」 — NFKC 뒤 앞뒤 공백을 뺀 글이 비어 있지 않고, 「외 N명」·「외 N인」·「외 N분」 꼴(자릿수 상관없이)이 없고, 인원수만 적은 것(「3명」·「4인」·「2분」)도 아닐 때.
   *  숫자만으로는 이름이 아니다. 전각 숫자(「외 ２명」·「４인」)는 NFKC 가 보통 숫자로 바꿔 준다. 그 밖(이름·사유·「팀원 점심」)은 됐다고 본다. */
  function mealNoteOk(note) { var s = nfkc(note).trim(); return s !== '' && !/외\s*\d+\s*(?:명|인|분)/.test(s) && !/^\d+\s*(?:명|인|분)$/.test(s); }
  /** 안내가 필요한 줄 — 13,000원 넘는 식사 줄인데 비고가 안 됨(비었거나 「외 N명」·인원수뿐). C10 이 이 줄을 모은다. */
  function needsMealNote(e) { return isMealLine(e) && (Number(e && e.amount) || 0) > MEAL_LIMIT && !mealNoteOk(e && e.note); }

  /** 결제 시각(ms) → KST 날짜 'YYYY-MM-DD'. 숫자가 아니면 ''. */
  function kstDate(ms) {
    if (ms == null || ms === '') return '';
    var x = Number(ms);
    if (!isFinite(x)) return '';
    var d = new Date(Math.round(x) + 9 * 3600e3);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  /** 그 달(KST 1일 00:00 ~ 다음 달 1일 00:00)의 ms 범위 — C09 개인경비 줄을 읽는 범위(서버·웹 같다). */
  function expenseRangeMs(cycle) {
    var rg = cycleRange(cycle);
    return { lo: Date.parse(rg.lo + 'T00:00:00+09:00'), hi: Date.parse(rg.hi + 'T00:00:00+09:00') };
  }
  /** C08 규칙에서 「이것만 적으면 성의 없음」으로 보는 낱말(공백·기호를 뺀 꼴). */
  var VAGUE_WORDS = ['업무', '식대', '기타', '없음', '회의', '구매', '경비', '비용', '식사', '업무용', '업무상', '업무관련', '기타비용', '해당없음', '상동', '동일', '테스트'];
  /**
   * C08 규칙 — n = 사용목적에서 한글 음절·영문·숫자만 남긴 것. 빈칸은 C02 몫이라 false.
   * ① n 이 비었음(기호·자모뿐) ② n 이 2자 이하 ③ n 이 뻔한 낱말(VAGUE_WORDS) ④ n 이 구분과 같음(구분을 되풀이) → true.
   * 그 밖(「팀 점심」처럼 짧아도 뜻이 있는 것)은 Gemini 에 맡긴다.
   */
  function purposeVague(v, category) {
    var s = str(v).trim();
    if (!s) return false;
    var n = s.replace(/[^가-힣A-Za-z0-9]/g, '');
    if (!n) return true;
    if (Array.from(n).length <= 2) return true;
    if (VAGUE_WORDS.indexOf(n) >= 0) return true;
    var c = str(category).replace(/[^가-힣A-Za-z0-9]/g, '');
    return c !== '' && n === c;
  }
  function aiKey(no, d) { return str(no).trim() + '|' + str(d).trim(); }
  function clip(v, max) { var a = Array.from(str(v).trim()); return a.length > max ? a.slice(0, max).join('') + '…' : a.join(''); }
  var PER_ROW_MAX = 30;

  /**
   * 검증. items = 검증하는 줄(추가 상신 뒤로는 대상 문서의 줄 — 2026-11-02). opts = { cycle, submitterName, expenses?, ai?, known? }.
   * known = 그 달 내 모든 줄(C05 하이패스 카드 판정에만 더한다). C03 같은 승인번호도 items 안에서만 본다(승인번호는 카드사마다 따로).
   * C01 구분 빈칸(block) · C02 사용목적 빈칸(block) · C03 같은 승인번호 두 번 이상(bad) · C04 기간 밖 승인일(warn)
   * C05 소유자 ≠ 상신자(warn, 띄어쓰기 무시 — 하이패스 카드 줄은 보지 않는다, 2026-11-02) · C06 0원 줄(info)
   * C07 구분·내역 불일치(warn, Gemini — opts.ai.rows) · C08 사용목적 성의 없음(warn, 규칙 + Gemini) · C09 개인경비 이중 청구 의심(warn, opts.expenses)
   * C10 13,000원 넘는 식대인데 비고에 이름·사유가 없음(warn, 2026-11-02 — 구분의 식사 낱말 · 회식·접대·협의·회의 뺌 · 비고가 비었거나 「외 N명」·인원수뿐).
   */
  function runVerify(items, opts) {
    opts = opts || {};
    var out = [];
    var add = function (code, level, title, detail, ids, ai) {
      var u = [];
      (ids || []).forEach(function (x) { x = Number(x); if (isFinite(x) && u.indexOf(x) < 0) u.push(x); });
      u = u.slice(0, 60);
      var o = u.length ? { code: code, level: level, title: title, detail: detail, ref: { items: u } } : { code: code, level: level, title: title, detail: detail };
      if (ai) o.ai = true;
      out.push(o);
    };
    var idsOf = function (l) { return l.map(function (e) { return e.id; }); };
    var list = (items || []).slice().sort(function (a, b) {
      return cmpS(a.appr_date, b.appr_date) || cmpS(a.appr_time, b.appr_time) || (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    // 문구는 해요체(2026-10-24 4단계 — 서버 card-verify.ts 와 글자 하나 같게, card-parity 시험)
    var c1 = list.filter(function (e) { return blank(e.category); });
    if (c1.length) add('C01', 'block', '구분이 빈 줄 ' + c1.length + '건', '구분을 적어야 상신할 수 있어요: ' + some(c1.map(tagOf), 8), idsOf(c1));
    var c2 = list.filter(function (e) { return blank(e.purpose); });
    if (c2.length) add('C02', 'block', '사용목적이 빈 줄 ' + c2.length + '건', '사용목적을 적어야 상신할 수 있어요: ' + some(c2.map(tagOf), 8), idsOf(c2));
    var byNo = {}, order = [];
    list.forEach(function (e) {
      var k = str(e.appr_no).trim();
      if (!k) return;
      if (!byNo[k]) { byNo[k] = []; order.push(k); }
      byNo[k].push(e);
    });
    order.forEach(function (k) {
      var g = byNo[k];
      if (g.length > 1) add('C03', 'bad', '같은 승인번호 ' + k + ' — ' + g.length + '줄',
        some(g.map(tagOf), 6) + '. 같은 승인번호가 여러 줄이에요. ERP에서 두 번 가져온 것이 아닌지 확인해 주세요.', idsOf(g));
    });
    if (isCycle(opts.cycle)) {
      var rg = cycleRange(opts.cycle);
      var off = list.filter(function (e) { var d = str(e.appr_date); return !(d >= rg.lo && d < rg.hi); });
      if (off.length) add('C04', 'warn', '이 기간 밖 승인일 ' + off.length + '건',
        cycleLabel(opts.cycle) + ' 밖의 승인일이에요: ' + some(off.map(function (e) { return str(e.appr_date) + ' ' + merchantOf(e) + ' ' + n0(e.amount) + '원'; }), 8), idsOf(off));
    }
    var me = normName(opts.submitterName);
    if (me) {
      // 하이패스 카드 판정 = 검증하는 줄 ∪ opts.known(그 달 내 모든 줄 — 같은 카드의 다른 문서 줄 포함, 추가 상신 2026-11-02 SPEC §4-3).
      //   소유자를 보는 줄은 검증하는 줄만 — known 줄은 판정 재료일 뿐 항목에 나오지 않는다. 서버 runCardVerify(items, { known }) 와 같다.
      var hp = hipassCards(Array.isArray(opts.known) ? list.concat(opts.known) : list);
      var who = list.filter(function (e) { var o = normName(e.owner_name); return o !== '' && o !== me && !onHipass(e, hp); });
      if (who.length) add('C05', 'warn', '소유자가 상신자와 다른 줄 ' + who.length + '건',
        'ERP 소유자가 ' + str(opts.submitterName).trim() + ' 님이 아니에요: ' + some(who.map(function (e) { return tagOf(e) + '(' + str(e.owner_name).trim() + ')'; }), 8), idsOf(who));
    }
    var zero = list.filter(function (e) { return Math.round(Number(e.amount) || 0) === 0; });
    if (zero.length) add('C06', 'info', '0원 줄 ' + zero.length + '건',
      '금액이 0원인 줄이에요: ' + some(zero.map(tagOf), 8) + '. 올릴 때 빼는 줄이라 남겨 둔 이유를 비고에 적어 주세요.', idsOf(zero));
    // ── C07 구분·내역 불일치(Gemini) — 구분이 적힌 줄만, 줄마다 하나(30건 넘으면 나머지는 한 항목) ──
    var aiBy = {};
    (opts.ai && Array.isArray(opts.ai.rows) ? opts.ai.rows : []).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      var k = aiKey(r.appr_no, r.appr_date);
      if (!aiBy[k]) aiBy[k] = r;
    });
    var aiOf = function (e) { return aiBy[aiKey(e.appr_no, e.appr_date)] || null; };
    var hm = function (e) { return str(e.appr_time).slice(0, 5); };
    var c7 = list.filter(function (e) { var r = aiOf(e); return !blank(e.category) && !!r && r.mismatch === true; });
    c7.slice(0, PER_ROW_MAX).forEach(function (e) {
      var r = aiOf(e), cat = str(e.category).trim(), sug = str(r.suggest_category).trim(), biz = str(e.biz_type).trim();
      add('C07', 'warn', '구분·내역이 맞지 않아 보임 — ' + tagOf(e),
        '구분 ‘' + cat + '’' + (biz ? ' · 업종 ' + biz : '') + (hm(e) ? ' · 승인 ' + hm(e) : '') + '. ' +
        (clip(r.reason, 60) || '구분과 가맹점·시간이 맞지 않아 보여요') + (sug && sug !== cat ? ' (추천 구분: ' + clip(sug, 20) + ')' : ''), [e.id], true);
    });
    if (c7.length > PER_ROW_MAX) {
      var rest7 = c7.slice(PER_ROW_MAX);
      add('C07', 'warn', '구분·내역이 맞지 않아 보이는 줄 그 밖 ' + rest7.length + '건', some(rest7.map(tagOf), 8), idsOf(rest7), true);
    }
    // ── C08 사용목적 성의 없음 — 규칙(4자 미만·기호뿐) + Gemini(모호함). 빈칸은 C02 ──
    var c8 = list.filter(function (e) { var r = aiOf(e); return !blank(e.purpose) && (purposeVague(e.purpose, e.category) || (!!r && r.purpose_vague === true)); });
    if (c8.length) {
      add('C08', 'warn', '사용목적이 짧거나 모호한 줄 ' + c8.length + '건',
        some(c8.map(function (e) {
          var r = aiOf(e), why = r && r.purpose_vague === true ? clip(r.purpose_reason, 40) : '';
          return tagOf(e) + ' ‘' + clip(e.purpose, 20) + '’' + (why ? '(' + why + ')' : '');
        }), 8) + '. 무엇에 썼는지(어떤 일로·누구와) 알 수 있게 적어 주세요.', idsOf(c8), c8.some(function (e) { return !purposeVague(e.purpose, e.category); }));
    }
    // ── C09 개인경비 이중 청구 의심 — 같은 날(KST)·같은 금액의 개인경비 줄 ──
    if (Array.isArray(opts.expenses)) {
      var exBy = {};
      opts.expenses.forEach(function (x) {
        if (!x) return;
        var a = Math.round(Number(x.amount) || 0), d = kstDate(x.date_millis);
        if (!d || a <= 0) return;
        (exBy[d + '|' + a] = exBy[d + '|' + a] || []).push(x);
      });
      var exOf = function (e) { return exBy[str(e.appr_date) + '|' + Math.round(Number(e.amount) || 0)] || []; };
      var exTag = function (x) {
        return kstDate(x.date_millis).slice(5).replace('-', '.') + ' ' + (str(x.category).trim() || '경비') +
          (str(x.merchant).trim() ? ' ' + str(x.merchant).trim() : '') + ' ' + n0(x.amount) + '원';
      };
      var c9 = list.filter(function (e) { return Math.round(Number(e.amount) || 0) > 0 && exOf(e).length > 0; });
      c9.slice(0, PER_ROW_MAX).forEach(function (e) {
        add('C09', 'warn', '개인경비와 겹칠 수 있음 — ' + tagOf(e),
          '같은 날 같은 금액의 개인경비가 있어요: ' + some(exOf(e).map(exTag), 3) +
          '. 같은 결제를 법인카드와 개인경비로 두 번 청구하지 않았는지 확인해 주세요.', [e.id]);
      });
      if (c9.length > PER_ROW_MAX) {
        var rest9 = c9.slice(PER_ROW_MAX);
        add('C09', 'warn', '개인경비와 겹칠 수 있는 줄 그 밖 ' + rest9.length + '건', some(rest9.map(tagOf), 8), idsOf(rest9));
      }
    }
    // ── C10 13,000원 넘는 식대인데 비고에 이름·사유가 없음(2026-11-02 — 위 「식대 13,000원 넘으면 비고에 이름·사유」) ──
    //   식사 줄 && 줄 금액 > 13,000원 && 비고가 비었거나 「외 N명」·인원수뿐. 한 항목에 줄 목록(막지 않는다 — 구분·사용목적 빈칸 C01·C02 만 막는다).
    var c10 = list.filter(needsMealNote);
    if (c10.length) add('C10', 'warn', '13,000원 넘는 식대 ' + c10.length + '건 — 비고에 이름·사유를 적어 주세요',
      '식대가 13,000원을 넘으면 비고에 함께한 분 이름을 모두 적어 주세요(혼자 먹었으면 사유). ‘외 N명’ 대신 이름을 적어 주세요. 막지는 않아요: ' +
      some(c10.map(tagOf), 8), idsOf(c10));
    var rank ={ block: 0, bad: 1, warn: 2, info: 3 };
    out.sort(function (a, b) { return rank[a.level] - rank[b.level] || Number(a.code.slice(1)) - Number(b.code.slice(1)); });
    var cnt = function (l) { return out.filter(function (i) { return i.level === l; }).length; };
    return {
      summary: { block: cnt('block'), bad: cnt('bad'), warn: cnt('warn'), info: cnt('info'), n: list.length,
        cost: list.reduce(function (s, e) { return s + Math.round(Number(e.amount) || 0); }, 0), blank_rows: blankRows(list) },
      items: out
    };
  }
  /** 구분별 줄 수·합계 — 결재 요약(snapshot.by_cat)·화면 공통. 빈 구분은 '(빈칸)'. */
  function totals(items) {
    var by = {}, cost = 0;
    (items || []).forEach(function (e) {
      var a = Math.round(Number(e.amount) || 0), k = str(e.category).trim() || '(빈칸)';
      cost += a;
      if (!by[k]) by[k] = { n: 0, sum: 0 };
      by[k].n++; by[k].sum += a;
    });
    return { n: (items || []).length, cost: cost, by_cat: by };
  }

  /* ── 추가 상신 — 한 사람·한 달에 문서 여럿(2026-11-02 사용자 결정, docs/card-multi/SPEC.md §1·§2·§3-4·§4-1) ──
     문서 하나 = 카드 한 장. 줄은 card_items.approval_id 로 문서에 묶인다. 서버 _shared/card-doc.ts 와 같은 판정(card-parity 시험) —
     한쪽을 고치면 다른 쪽도 고친다. DB card_doc_plan 이 정본이고 이것은 화면(대상 목록·달 상태·이름)과 하네스 가짜 서버 몫.
     · 카드 키 = card_no 에서 공백(\s)을 뺀 것(cardKey) — 「같은 카드」·문서의 card_no·하이패스 카드 판정이 모두 이것.
     · 끝자리 = 카드 키의 숫자만 모아 뒤 4자리(적으면 있는 만큼, 없으면 '') — 가림 「*」는 빠진다. 카드번호 전체는 이름·DOM·저장소 열쇠에 넣지 않는다.
     · 살아 있는 문서 = submitted·approved(그 문서에 묶인 줄은 잠긴다) · 죽은 문서 = rejected·withdrawn·draft(다시 상신하면 같은 문서 번호).
     · 여러 카드 문서 = 이 기능 전에 카드 둘 이상을 한 문서로 올린 예전 문서(card_no null, 달마다 하나). 살아 있으면 그 달 줄이 모두 잠긴다(예전 그대로).
     · 열린 줄 = 잠기지 않은 줄(안 묶임 + 죽은 문서에 묶임). 목록에 없는 문서에 묶인 줄은 잠긴 것으로 본다(결재 목록을 못 받았을 때 — SPEC §5-1).
     lines = 그 사람·그 달 줄 { id, card_no, approval_id, category, purpose, … } · docs = 그 사람·그 달 문서 { id, status, card_no, seq }. */
  function stOf(x) { return x != null && typeof x === 'object' ? str(x.status) : str(x); }
  /** 살아 있는 문서인가 — 'submitted'·'approved'(글자 또는 { status }). */
  function isLive(st) { var s = stOf(st); return s === 'submitted' || s === 'approved'; }
  /** 그 달 문서들의 살아 있는 상태 — submitted 가 하나라도 있으면 'submitted', 아니면 approved 가 있으면 'approved', 아니면 ''(글자 또는 { status } 목록). */
  function liveStatus(list) {
    var a = (Array.isArray(list) ? list : []).map(stOf);
    return a.indexOf('submitted') >= 0 ? 'submitted' : a.indexOf('approved') >= 0 ? 'approved' : '';
  }
  /** 끝자리 — 카드 키의 숫자(0-9)만 모아 뒤 4자리. 4자리보다 적으면 있는 숫자, 없으면 ''. 「1234-****-****-5678」 → '5678'. */
  function cardTail(v) { return str(v).replace(/[^0-9]/g, '').slice(-4); }
  function intOf(v) { var n = Number(v); return isFinite(n) && Math.floor(n) === n ? n : NaN; }
  /** 문서 이름 꼬리(SPEC §2) — card_no 가 undefined → ''(문서가 아닌 기간) · null → ' · 여러 카드' · 끝자리 없음 → ' · 카드 번호 없음' · 그 밖 ' · 카드 끝 1234'.
   *  seq 가 정수 2 이상이면 뒤에 ' · 추가 {seq-1}'(같은 카드 두 번째 문서부터 — 여러 카드·번호 없음도 같다. 여러 카드 문서는 달마다 하나라 실제로는 seq 1). */
  function docSuffix(card_no, seq) {
    if (card_no === undefined) return '';
    var t = card_no === null ? null : cardTail(card_no), s = intOf(seq);
    return (t === null ? ' · 여러 카드' : t === '' ? ' · 카드 번호 없음' : ' · 카드 끝 ' + t) + (s >= 2 ? ' · 추가 ' + (s - 1) : '');
  }
  /** '2026-10' → '10월분' · '2026-12b' → '12월분 2차' · 그 밖 「<글자>분」(서버 cycle-rules.ts periodShort 와 같다). */
  function pshort(c) { var s = str(c); return KEY_X.test(s) ? '12월분 2차' : KEY_STD.test(s) ? +s.slice(5, 7) + '월분' : s + '분'; }
  /** 짧은 이름 — 「10월분 · 카드 끝 1234」·「10월분 · 카드 끝 1234 · 추가 1」·「12월분 2차 · 카드 끝 1234」(알림·종·포털·단추).
   *  긴 이름은 웹이 cycName + ' (' + span + ')' + docSuffix 로 만든다(팀즈 글은 서버 cardDocLabel). 이름은 굳히지 않는다 — 칸에서 그때 만든다. */
  function docName(cycle, card_no, seq) { return pshort(cycle) + docSuffix(card_no, seq); }

  function bound(e) { return !!e && e.approval_id != null && e.approval_id !== ''; }
  /** 문서 차례 — 정수 1 이상이 아니면 1(DB 는 not null default 1). */
  function seqOf(d) { var s = intOf(d && d.seq); return s >= 1 ? s : 1; }
  /** 문서의 카드 — 카드 키, 여러 카드 문서(card_no null·없음)는 null. */
  function docKey(d) { return d.card_no == null ? null : cardKey(d.card_no); }
  function byIdAsc(a, b) { return (Number(a.id) || 0) - (Number(b.id) || 0); }
  /** 줄·문서를 한 번 훑어 둔다 — 문서(번호가 같으면 앞의 것) · 번호 → 문서 · 살아 있는 여러 카드 문서. */
  function ctxOf(lines, docs) {
    var by = Object.create(null), ds = [];
    (Array.isArray(docs) ? docs : []).forEach(function (d) { if (d && d.id != null && !(String(d.id) in by)) { by[String(d.id)] = d; ds.push(d); } });
    var c = { ls: (Array.isArray(lines) ? lines : []).filter(function (e) { return !!e; }), ds: ds, by: by, got: Array.isArray(lines) };
    c.liveMulti = ds.filter(function (d) { return d.card_no == null && isLive(d.status); });
    c.docOf = function (e) { return bound(e) ? by[String(e.approval_id)] || null : null; };
    c.boundTo = function (e, d) { return bound(e) && String(e.approval_id) === String(d.id); };
    // 빈 죽은 문서(2026-11-02 검토 M1 · 리더 결정) — 그 달에 그 카드 줄이 하나도 없는 죽은 문서(반려·회수·draft): 그 문서에 묶인 줄이 없고,
    //   카드 한 장 문서(카드 K)면 카드 키가 K 인 열린 줄(안 묶임 + 죽은 문서에 묶임)도 없다 · 여러 카드 문서는 묶인 줄만 본다.
    //   달 상태(반려·회수로 세지 않음)·대상·카드로 정하기(「K 의 죽은 문서」로 세지 않음)에서 뺀다 — 줄을 지운 반려 문서가 그 달을 영영 「반려」로 묶지 않게.
    //   그 카드 줄이 다시 올라오면 비어 있지 않아 다시 그 문서가 대상(같은 번호로 다시 상신). 문서 번호로 바로 가리키면 그대로 그 문서.
    //   그 달 줄을 안 받았으면(lines 가 배열이 아님) 비었는지 모르니 예전처럼 센다. 서버 card-doc.ts emptyDead 와 같다(card-parity 시험).
    c.empty = function (d) {
      if (!c.got || isLive(d.status)) return false;
      var k = docKey(d);
      return !c.ls.some(function (e) { return c.boundTo(e, d) || (k !== null && c.open(e) && cardKey(e.card_no) === k); });
    };
    // 열린 줄 — 살아 있는 여러 카드 문서가 있는 달은 줄이 모두 잠긴다(DB card_line_locked) · 목록에 없는 문서에 묶인 줄도 잠긴 것으로
    c.open = function (e) {
      if (c.liveMulti.length) return false;
      if (!bound(e)) return true;
      var d = c.docOf(e);
      return !!d && !isLive(d.status);
    };
    return c;
  }
  /** 죽은 문서 D 의 줄(SPEC §3-4 표) — 카드 한 장 문서: 카드 키 = K 그리고 (안 묶임 또는 D 에 묶임) ·
   *  여러 카드 문서: D 에 묶임 또는 (안 묶임 그리고 카드 키 ∈ D 에 묶인 줄의 카드 키). 다른 죽은 문서에 묶인 줄은 그 문서 몫. */
  function deadLines(c, d) {
    if (d.card_no != null) {
      var k = cardKey(d.card_no);
      return c.ls.filter(function (e) { return cardKey(e.card_no) === k && (!bound(e) || c.boundTo(e, d)); });
    }
    var keys = Object.create(null);
    c.ls.forEach(function (e) { if (c.boundTo(e, d)) keys[cardKey(e.card_no)] = true; });
    return c.ls.filter(function (e) { return c.boundTo(e, d) || (!bound(e) && keys[cardKey(e.card_no)] === true); });
  }
  /** 카드 키 K 의 죽은 문서 — 죽은 문서 중 card_no = K, 또는 card_no null 이고 묶인 줄에 K 가 있는 것(빈 죽은 문서는 뺀다 — 검토 M1). */
  function deadOfKey(c, k) {
    return c.ds.filter(function (d) {
      if (isLive(d.status) || c.empty(d)) return false;
      if (d.card_no != null) return cardKey(d.card_no) === k;
      return c.ls.some(function (e) { return c.boundTo(e, d) && cardKey(e.card_no) === k; });
    });
  }
  function planOf(d, items, k, seq) {
    var its = items.slice().sort(byIdAsc);
    return { doc_id: d ? d.id : null, card_no: d ? docKey(d) : k, seq: d ? seqOf(d) : seq, ids: its.map(function (e) { return e.id; }), items: its };
  }
  /**
   * 대상·줄 정하기 — DB card_doc_plan(SPEC §3-4)을 줄·문서 목록으로(하네스 가짜 서버·시험 몫, 화면은 docTargets).
   * card_no = 고른 카드(번호 그대로도 된다 — 키로 바꾼다) · approval_id = 다시 상신할 문서 번호 · review = 결재자 검증(살아 있는 문서를 대상으로).
   * → { doc_id, card_no, seq, ids, items } 또는 { error: 'ALREADY_SUBMITTED'|'ALREADY_APPROVED'|'CARD_DOC_GONE'|'CARD_MISMATCH'|'CARD_PICK'|'CARD_PICK_DOC' }.
   * 1 살아 있는 여러 카드 문서 L → review 이고 L 번호면 L, 아니면 ALREADY_<L 상태> · 2 번호 있음 → 그 문서(없으면 CARD_DOC_GONE · 살아 있으면 review 가 아니면 ALREADY ·
   *   카드와 문서 카드가 둘 다 있고 다르면 CARD_MISMATCH(review 여도) · 살아 있으면 묶인 줄) · 3 번호 없음 → 카드도 없으면 CARD_PICK · 그 카드의 죽은 문서 1건 → 그 문서 ·
   *   2건 이상 → CARD_PICK_DOC · 0건 → 새 문서(seq = 그 카드 문서 최댓값 + 1 — 빈 죽은 문서의 차례도 센다, 줄이 없어도). 3 의 「죽은 문서」에서 빈 죽은 문서는 뺀다(검토 M1).
   *   서버 card-doc.ts cardDocPlanLocal 과 같다(card-parity 시험).
   */
  function docPlan(lines, docs, card_no, approval_id, review) {
    var c = ctxOf(lines, docs), i, d;
    var boundOf = function (x) { return c.ls.filter(function (e) { return c.boundTo(e, x); }); };
    if (c.liveMulti.length) {
      for (i = 0; i < c.liveMulti.length; i++) {
        d = c.liveMulti[i];
        if (review && approval_id != null && String(approval_id) === String(d.id)) return planOf(d, boundOf(d));
      }
      return { error: 'ALREADY_' + liveStatus(c.liveMulti).toUpperCase() };
    }
    if (approval_id != null && approval_id !== '') {
      d = c.by[String(approval_id)];
      if (!d) return { error: 'CARD_DOC_GONE' };
      var live = isLive(d.status);
      if (live && !review) return { error: 'ALREADY_' + str(d.status).toUpperCase() };
      if (card_no != null && d.card_no != null && cardKey(card_no) !== docKey(d)) return { error: 'CARD_MISMATCH' };
      return planOf(d, live ? boundOf(d) : deadLines(c, d));
    }
    if (card_no == null) return { error: 'CARD_PICK' };
    var k = cardKey(card_no), dead = deadOfKey(c, k);
    if (dead.length === 1) return planOf(dead[0], deadLines(c, dead[0]));
    if (dead.length > 1) return { error: 'CARD_PICK_DOC' };
    var top = 0;
    c.ds.forEach(function (x) { if (docKey(x) === k) top = Math.max(top, seqOf(x)); });
    return planOf(null, c.ls.filter(function (e) { return !bound(e) && cardKey(e.card_no) === k; }), k, top + 1);
  }
  /** 카드 키 짧은 지문 — 새 문서 대상의 tid('n…'). 카드번호를 DOM·sessionStorage·주소에 두지 않으려고(FNV-1a 32비트 → 36진). */
  function keyFp(k) {
    var h = 0x811c9dc5, s = str(k);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  /**
   * 이번 달 상신·검증 대상 목록(SPEC §3-4·§4-1) — [{ approval_id, card_no, seq, status, items, tid }], 줄이 있는 대상만.
   * 죽은 문서마다 하나(그 문서 번호로 다시 상신 · 빈 죽은 문서는 줄이 없어 안 나온다) + 죽은 문서가 없는 카드의 안 묶인 줄마다 새 문서 하나(card_no = 카드 키, seq = 그 카드 문서 최댓값 + 1, status '').
   * 살아 있는 여러 카드 문서가 있는 달은 빈 목록(모두 ALREADY). 차례 = 여러 카드 문서 → 끝자리 → seq(같으면 카드 키 → 문서 번호).
   * tid = 'd{문서 번호}' 또는 'n{카드 키 짧은 지문}'. items 는 줄 번호 순(card_doc_plan ids 와 같은 차례).
   */
  function docTargets(lines, docs) {
    var c = ctxOf(lines, docs), out = [];
    if (c.liveMulti.length) return out;
    c.ds.forEach(function (d) {
      if (isLive(d.status) || c.empty(d)) return;
      var p = planOf(d, deadLines(c, d));
      if (p.items.length) out.push({ approval_id: d.id, card_no: p.card_no, seq: p.seq, status: str(d.status), items: p.items, tid: 'd' + d.id });
    });
    var seen = Object.create(null);
    c.ls.forEach(function (e) {
      var k = cardKey(e.card_no);
      if (bound(e) || seen[k]) return;
      seen[k] = true;
      if (deadOfKey(c, k).length) return;
      var p = docPlan(c.ls, c.ds, k, null, false);
      out.push({ approval_id: null, card_no: k, seq: p.seq, status: '', items: p.items, tid: 'n' + keyFp(k) });
    });
    var aid = function (t) { return t.approval_id == null ? Infinity : Number(t.approval_id); };
    out.sort(function (a, b) {
      var x = aid(a), y = aid(b);
      return (a.card_no == null ? 0 : 1) - (b.card_no == null ? 0 : 1) || cmpS(cardTail(a.card_no), cardTail(b.card_no)) || a.seq - b.seq ||
        cmpS(cardKey(a.card_no), cardKey(b.card_no)) || (x < y ? -1 : x > y ? 1 : 0);
    });
    return out;
  }
  /**
   * 달 상태(SPEC §4-1) — { st, sub, app, rej, wd, left, blank_left }. sub·app·rej·wd = 문서 수(wd 는 회수 + draft) · left = 열린 줄 수 · blank_left = 열린 줄 가운데 빈칸 줄.
   * st: 살아 있는 여러 카드 문서 → 그 상태 · 반려 문서 → 'rejected' · 회수·draft → 'withdrawn' · 열린 줄 → '' · 결재 중 → 'submitted' · 모두 완료 → 'approved' · 없음 → ''.
   * 빈 죽은 문서(묶인 줄도 그 카드의 열린 줄도 없는 반려·회수·draft — ctxOf 의 empty, 검토 M1)는 세지 않는다(rej·wd·st 모두).
   * lines 가 배열이 아니면(그 달 줄을 안 받음) 문서만으로 반려 > 회수 > 결재 중 > 결재 완료, left·blank_left 는 null(SPEC §5-9) — 이때는 죽은 문서를 모두 센다.
   */
  function monthState(lines, docs) {
    var c = ctxOf(lines, docs), n = { submitted: 0, approved: 0, rejected: 0, withdrawn: 0, draft: 0 };
    c.ds.forEach(function (d) { var s = str(d.status); if (Object.prototype.hasOwnProperty.call(n, s) && !c.empty(d)) n[s]++; });
    var got = Array.isArray(lines), open = got ? c.ls.filter(c.open) : [];
    var left = got ? open.length : null, wd = n.withdrawn + n.draft;
    var st = c.liveMulti.length ? liveStatus(c.liveMulti) : n.rejected ? 'rejected' : wd ? 'withdrawn' : left ? '' :
      n.submitted ? 'submitted' : n.approved ? 'approved' : '';
    return { st: st, sub: n.submitted, app: n.approved, rej: n.rejected, wd: wd, left: left, blank_left: got ? blankRows(open) : null };
  }
  /** 빈 죽은 문서 번호(줄 번호처럼 오름차순) — 위 ctxOf 의 empty(검토 M1). 그 달 줄을 안 받았으면 []. 서버 cardEmptyDocIds 와 같다. */
  function emptyDocIds(lines, docs) {
    var c = ctxOf(lines, docs);
    return c.ds.filter(c.empty).map(function (d) { return d.id; }).sort(function (a, b) { return (Number(a) || 0) - (Number(b) || 0); });
  }
  /**
   * 관리 「카드」 칸(SPEC §5-7, 2026-11-02 사용자) — 줄의 카드마다 [{ key, tail, hipass }](끝자리 순, 같으면 카드 키 순 · 카드 키가 같으면 하나).
   * hpSet = hipassCards(그 화면이 받은 그 달 모든 줄 — 센터 카드의 통행료 줄이 다른 직원 쪽에 있어도 (하)), 없으면 lines 로. key 는 가려 쓰는 몫이 아니다 — 화면에 내지 않는다.
   */
  function cardList(lines, hpSet) {
    var hp = hpSet || hipassCards(lines), seen = Object.create(null), out = [];
    var has = function (k) { return k !== '' && (typeof hp.has === 'function' ? hp.has(k) === true : hp[k] === true); };
    (Array.isArray(lines) ? lines : []).forEach(function (e) {
      var k = cardKey(e && e.card_no);
      if (seen[k]) return;
      seen[k] = true;
      out.push({ key: k, tail: cardTail(k), hipass: has(k) });
    });
    return out.sort(function (a, b) { return cmpS(a.tail, b.tail) || cmpS(a.key, b.key); });
  }

  /* ── 구분 추천(SPEC §4) — 웹만 ── */
  var FOOD = /음식|식당|한식|중식|일식|양식|분식|커피|제과|카페|베이커리|제빵|패스트푸드|뷔페|레스토랑|치킨|피자|주점/;
  function normMerchant(s) {
    var v = str(s);
    if (v.normalize) v = v.normalize('NFKC');
    return v.toLowerCase()
      .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\(사\)/g, '')
      .replace(/[\s\-_.,·()[\]{}'"&/]+/g, '')
      .replace(/(본점|지점|점)$/, '');
  }
  /** 승인 시각 → 식대 구분. 05:00 ≤ t < 10:00 조식대 · 10–15 중식대 · 15–17 다과비 · 그 밖(17:00 ~ 다음 날 05:00) 석식대. 시각 모름 = ''. */
  function mealOf(t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(str(t));
    if (!m) return '';
    var x = +m[1] * 60 + +m[2];
    return x >= 300 && x < 600 ? '조식대' : x >= 600 && x < 900 ? '중식대' : x >= 900 && x < 1020 ? '다과비' : '석식대';
  }
  /** history = 내가 전에 구분을 적은 줄 [{id, merchant, category}] (최근 순). 돌려주는 것 { cat, why } 또는 null. */
  function suggest(it, history) {
    var m = normMerchant(it.merchant);
    if (m) {
      for (var i = 0; i < (history || []).length; i++) {
        var h = history[i];
        if (String(h.id) !== String(it.id) && !blank(h.category) && normMerchant(h.merchant) === m) return { cat: str(h.category).trim(), why: '같은 가맹점에 전에 쓴 구분' };
      }
    }
    var b = str(it.biz_type);
    if (FOOD.test(b)) { var meal = mealOf(it.appr_time); return meal ? { cat: meal, why: '음식점 · 승인 ' + str(it.appr_time).slice(0, 5) } : null; }
    if (/주유|충전/.test(b)) return { cat: '주유비', why: '업종 ' + b };
    if (/주차/.test(b)) return { cat: '주차비', why: '업종 ' + b };
    if (/통신/.test(b)) return { cat: '통신비', why: '업종 ' + b };
    if (/철도|항공|택시|고속/.test(b)) return { cat: '교통비', why: '업종 ' + b };
    return null;
  }

  return {
    isCycle: isCycle, lastDay: lastDay, cycleRange: cycleRange, span: span, cycleLabel: cycleLabel,
    blankRows: blankRows, runVerify: runVerify, totals: totals,
    kstDate: kstDate, expenseRangeMs: expenseRangeMs, purposeVague: purposeVague,
    isHipassMerchant: isHipassMerchant, fuelOrToll: fuelOrToll, hipassCards: hipassCards, onHipass: onHipass,
    cardKey: cardKey, cardTail: cardTail, isLive: isLive, liveStatus: liveStatus, docSuffix: docSuffix, docName: docName,
    docPlan: docPlan, docTargets: docTargets, monthState: monthState, emptyDocIds: emptyDocIds, cardList: cardList,
    MEAL_LIMIT: MEAL_LIMIT, isMealLine: isMealLine, mealNoteOk: mealNoteOk, needsMealNote: needsMealNote,
    suggest: suggest, mealOf: mealOf, normMerchant: normMerchant
  };
});
