/* ═══════════════════════════════════════════════════════════════════════════
   card-rules.js — 법인카드 지출결의 규칙(웹) (2026-10-09, docs/card/SPEC.md §0·§3·§4)
   ---------------------------------------------------------------------------
   · 기간(달력 한 달)·검증(C01~C09 — C07·C08 의 AI 쪽은 서버가 받아 둔 Gemini 결과를 표시만)·합계 — 서버 supabase/functions/_shared/card-verify.ts 와 **글자 하나까지 같은 판정**.
     한쪽을 고치면 다른 쪽도 고치고 `node ACTs-ATECmobility/web/test/card-parity.test.mjs` 를 돌린다.
   · 구분 추천(웹만): ① 같은 가맹점에 본인이 전에 쓴 구분 ② 음식 업종은 승인 시각
     (05–10 조식대 · 10–15 중식대 · 15–17 다과비 · 17–05 석식대) ③ 주유·충전 → 주유비 ④ 주차 → 주차비 ⑤ 통신 → 통신비
     ⑥ 철도·항공·택시·고속 → 교통비 ⑦ 그 밖은 추천 없음. AI 는 쓰지 않는다. 추천은 확정 전까지 연하게(화면 몫).
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
   * 검증. items = 그 사람·그 기간의 card_items 줄. opts = { cycle, submitterName, expenses?, ai? }.
   * C01 구분 빈칸(block) · C02 사용목적 빈칸(block) · C03 같은 승인번호 두 번 이상(bad) · C04 기간 밖 승인일(warn)
   * C05 소유자 ≠ 상신자(warn, 띄어쓰기 무시) · C06 0원 줄(info)
   * C07 구분·내역 불일치(warn, Gemini — opts.ai.rows) · C08 사용목적 성의 없음(warn, 규칙 + Gemini) · C09 개인경비 이중 청구 의심(warn, opts.expenses).
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
      var who = list.filter(function (e) { var o = normName(e.owner_name); return o !== '' && o !== me; });
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
    suggest: suggest, mealOf: mealOf, normMerchant: normMerchant
  };
});
