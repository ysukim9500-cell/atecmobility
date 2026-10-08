/* ═══════════════════════════════════════════════════════════════════════════
   card-rules.js — 법인카드 지출결의 규칙(웹) (2026-10-09, docs/card/SPEC.md §0·§3·§4)
   ---------------------------------------------------------------------------
   · 기간(달력 한 달)·검증(C01~C06)·합계 — 서버 supabase/functions/_shared/card-verify.ts 와 **글자 하나까지 같은 판정**.
     한쪽을 고치면 다른 쪽도 고치고 `node ACTs-ATECmobility/web/test/card-parity.test.mjs` 를 돌린다.
   · 구분 추천(웹만): ① 같은 가맹점에 본인이 전에 쓴 구분 ② 음식 업종은 승인 시각
     (05–10 조식대 · 10–15 중식대 · 15–17 다과비 · 17–05 석식대) ③ 주유·충전 → 주유비 ④ 주차 → 주차비 ⑤ 통신 → 통신비
     ⑥ 철도·항공·택시·고속 → 교통비 ⑦ 그 밖은 추천 없음. AI 는 쓰지 않는다. 추천은 확정 전까지 연하게(화면 몫).
   · 문자열 비교는 < > 로만(localeCompare 는 런타임마다 다를 수 있다), 천 단위 쉼표는 정규식으로(toLocaleString 금지).
   브라우저(window.CardRules)·Node(require) 양쪽.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function n0(v) {
    var x = Math.round(Number(v) || 0), neg = x < 0;
    return (neg ? '-' : '') + String(Math.abs(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function str(v) { return String(v == null ? '' : v); }
  function cmpS(a, b) { a = str(a); b = str(b); return a < b ? -1 : a > b ? 1 : 0; }

  /* ── 기간(SPEC §0) — 당월 1일 00:00 ~ 말일 24:00(KST) ── */
  function isCycle(c) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(str(c)); }
  function ym(cycle) { var p = str(cycle).split('-'); return { y: +p[0], m: +p[1] }; }
  function lastDay(cycle) { var c = ym(cycle); return new Date(Date.UTC(c.y, c.m, 0)).getUTCDate(); }
  function cycleRange(cycle) {
    var c = ym(cycle), ny = c.m === 12 ? c.y + 1 : c.y, nm = c.m === 12 ? 1 : c.m + 1;
    return { lo: c.y + '-' + pad(c.m) + '-01', hi: ny + '-' + pad(nm) + '-01' };
  }
  /** '2026-07' → '07.01 – 07.31'(화면 머리띠·문서). */
  function span(cycle) { var c = ym(cycle); return pad(c.m) + '.01 – ' + pad(c.m) + '.' + pad(lastDay(cycle)); }
  /** '2026-07' → '2026년 7월분(07.01 ~ 07.31)'(팀즈·검증 문구 — SPEC §3 꼴 그대로). */
  function cycleLabel(cycle) {
    if (!isCycle(cycle)) return str(cycle) + '분';
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

  /**
   * 검증. items = 그 사람·그 기간의 card_items 줄. opts = { cycle, submitterName }.
   * C01 구분 빈칸(block) · C02 사용목적 빈칸(block) · C03 같은 승인번호 두 번 이상(bad) · C04 기간 밖 승인일(warn)
   * C05 소유자 ≠ 상신자(warn, 띄어쓰기 무시) · C06 0원 줄(info).
   */
  function runVerify(items, opts) {
    opts = opts || {};
    var out = [];
    var add = function (code, level, title, detail, ids) {
      var u = [];
      (ids || []).forEach(function (x) { x = Number(x); if (isFinite(x) && u.indexOf(x) < 0) u.push(x); });
      u = u.slice(0, 60);
      out.push(u.length ? { code: code, level: level, title: title, detail: detail, ref: { items: u } } : { code: code, level: level, title: title, detail: detail });
    };
    var idsOf = function (l) { return l.map(function (e) { return e.id; }); };
    var list = (items || []).slice().sort(function (a, b) {
      return cmpS(a.appr_date, b.appr_date) || cmpS(a.appr_time, b.appr_time) || (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    var c1 = list.filter(function (e) { return blank(e.category); });
    if (c1.length) add('C01', 'block', '구분이 빈 줄 ' + c1.length + '건', '구분을 적어야 상신할 수 있습니다: ' + some(c1.map(tagOf), 8), idsOf(c1));
    var c2 = list.filter(function (e) { return blank(e.purpose); });
    if (c2.length) add('C02', 'block', '사용목적이 빈 줄 ' + c2.length + '건', '사용목적을 적어야 상신할 수 있습니다: ' + some(c2.map(tagOf), 8), idsOf(c2));
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
        some(g.map(tagOf), 6) + ' — 같은 승인번호가 여러 줄입니다. ERP 에서 두 번 받은 것이 아닌지 확인해 주세요.', idsOf(g));
    });
    if (isCycle(opts.cycle)) {
      var rg = cycleRange(opts.cycle);
      var off = list.filter(function (e) { var d = str(e.appr_date); return !(d >= rg.lo && d < rg.hi); });
      if (off.length) add('C04', 'warn', '이 기간 밖 승인일 ' + off.length + '건',
        cycleLabel(opts.cycle) + ' 밖의 승인일입니다: ' + some(off.map(function (e) { return str(e.appr_date) + ' ' + merchantOf(e) + ' ' + n0(e.amount) + '원'; }), 8), idsOf(off));
    }
    var me = normName(opts.submitterName);
    if (me) {
      var who = list.filter(function (e) { var o = normName(e.owner_name); return o !== '' && o !== me; });
      if (who.length) add('C05', 'warn', '소유자가 상신자와 다른 줄 ' + who.length + '건',
        'ERP 소유자가 ' + str(opts.submitterName).trim() + ' 님이 아닙니다: ' + some(who.map(function (e) { return tagOf(e) + '(' + str(e.owner_name).trim() + ')'; }), 8), idsOf(who));
    }
    var zero = list.filter(function (e) { return Math.round(Number(e.amount) || 0) === 0; });
    if (zero.length) add('C06', 'info', '0원 줄 ' + zero.length + '건',
      '금액이 0원인 줄입니다(올릴 때 빼는 줄 — 남겨 둔 까닭을 비고에 적어 주세요): ' + some(zero.map(tagOf), 8), idsOf(zero));
    var rank = { block: 0, bad: 1, warn: 2, info: 3 };
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
    suggest: suggest, mealOf: mealOf, normMerchant: normMerchant
  };
});
