/* ═══════════════════════════════════════════════════════════════════════════
   money-rule.js — 주차비·통행료 금액 규칙 v3 (2026-10-15 사용자 결정)
   정본: docs/money-rule-v3.md (웹·서버·안드로이드·iOS 공통). 이 파일이 웹의 **유일한** 계산이다 —
   정산 합계·마감·엑셀·PDF·2단계 맞춰보기 표·결재 요약 모두 여기 결과를 쓴다(따로 세면 갈라진다).

   구분(주차·통행료)마다 하루(KST) 단위로 본다.
     T = 그날 업무 운행 금액 합(주차: parking_cost > 0 · 통행료: 상태 규칙으로 읽은 금액 — 출처 무관)
     R = 그날 붙는 영수증 금액 합(trip_id 로 이은 운행이 있으면 그 운행의 날, 없으면 영수증 날짜)
       T > 0, R = 0          → 정산 T · 'no_receipt' 영수증 없음(R06)
       T > 0, R > 0, T = R   → 정산 T · 'match'      일치
       T > 0, R > 0, T ≠ R   → 정산 T · 'mismatch'   금액 다름(R10) — 영수증을 더하지 않는다
       T = 0, R > 0, 운행 있음 → 정산 R · 'filled'     영수증으로 채움(이은 운행 줄, 아니면 그날 첫 업무 운행 줄)
       T = 0, R > 0, 운행 없음 → 정산 0 · 'no_trip'    운행 없는 영수증(R13 · 정산에서 뺀다)
   상태 이름은 서버 _shared/driving-calc.ts moneyV3 의 MoneyStatus 와 같다.
   절대 두 번 더하지 않는다(v2 는 엑셀 = T + R 이었다).

   추가 결정(2026-10-15 사용자, 같은 날 — 정본 「추가 결정」 · 서버 HIPASS_SOURCE · MONEY_V3_FROM 과 같다)
     · 「하이패스 PDF 인정」: 통행료 출처 「하이패스 영수증」(하이패스 PDF 대조로 맞춘 운행)의 금액 H 는 그 자체가 영수증이다.
       상태 판정만 H + (R − D) 로 한다(정산 금액·채우기는 그대로).
       H 는 운행마다 toll_hipass(하이패스로 맞출 때 따로 적은 금액 — 운행 금액을 사람이 고쳐도 남는다, 2026-10-17)를 쓰고, 없으면 출처로 본다(hipassOf).
     · 「같은 통행료를 두 가지로 증빙」(2026-10-17 사용자 「직원들이 잘 모를 것 같은데… 좀 쉽게」): 올린 통행료 영수증 중 그날 하이패스 출처 운행
       통행료와 금액이 같은 것은 같은 통행료의 두 번째 증빙으로 짝지어(hpPair) R 에 다시 세지 않는다(D = 그 합, d.dup = 그 영수증).
       하이패스 500 + 영수증 500 → 일치 · 하이패스 500 + 영수증 700 → 금액 다름. 서버 driving-calc.ts hpPair 와 같은 순서·같은 답.
     · 「10월분부터」: 표시(영수증 없음·금액 다름·운행 없는 영수증)는 2026-09-21(KST) 이후 날만(d.show).
       금액 계산은 모든 날 같다 — sum.none·diff·ok·bad·noTripShowN 은 표시용이라 d.show 인 날만 센다.

   의존성 없음 — 브라우저(window.MoneyRule)와 node(require) 양쪽에서 쓴다(test/money-v3.test.js).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M;
  if (root) root.MoneyRule = M;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var KST = 9 * 3600e3;
  var TOLL_MAX = 200000;                 // 웹 TOLL_MAX · 앱 TollCharge.MAX_AMOUNT · 서버 tollOf 와 같다
  var CATS = ['주차', '통행료'];
  var BUSINESS = '일반업무';
  var HIPASS_SOURCE = '하이패스 영수증';   // 서버 driving-calc.ts HIPASS_SOURCE 와 같다(2026-10-15)
  var FROM = '2026-09-21';                 // 서버 MONEY_V3_FROM — 운행일지 2026년 10월분 첫날(KST)

  function ymdK(ms) {
    var d = new Date(Number(ms) + KST);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }
  /**
   * 통행료 상태 규칙(웹 tollForExport·tollNeed · 서버 tollOf · 앱 TollCharge 와 같은 읽기).
   * 상태·금액이 규약을 어긴 옛 기록은 금액이 있으면 MANUAL 금액, 없으면 미확정으로 본다.
   * 돌려주는 것: { a: 정산에 쓰는 운행 금액(미확정 0), st: 읽은 상태 }
   */
  function tollOf(t) {
    var st = t.toll_status, amt = t.toll_cost == null ? null : Number(t.toll_cost);
    if (amt != null && !isFinite(amt)) amt = null;
    var ok = (st === 'UNKNOWN' || st === 'PENDING') ? amt === null
      : st === 'CHARGED' ? (amt !== null && amt >= 1 && amt <= TOLL_MAX)
      : st === 'FREE_CONFIRMED' ? amt === 0
      : st === 'MANUAL' ? (amt !== null && amt >= 0 && amt <= TOLL_MAX) : false;
    if (!ok) { if (amt != null && amt > 0) { st = 'MANUAL'; amt = Math.min(amt, TOLL_MAX); } else { st = 'UNKNOWN'; amt = null; } }
    if (st === 'UNKNOWN' || st === 'PENDING') return { a: 0, st: st };
    return { a: amt || 0, st: st };
  }
  /** 운행 한 건의 구분별 운행 금액. */
  function tripAmt(cat, t, opt) {
    if (cat === '주차') { var p = Number(t.parking_cost); return isFinite(p) && p > 0 ? p : 0; }
    return opt && opt.toll ? (Number(opt.toll(t)) || 0) : tollOf(t).a;
  }
  /**
   * 운행 한 건의 하이패스 몫(통행료 상태 판정에서 영수증으로 치는 금액) — a = 그 운행의 통행료 금액.
   *   toll_hipass(하이패스 PDF 로 맞출 때 따로 적은 금액, 2026-10-17)가 있으면 그 값 — 운행 금액을 사람이 고쳐도(출처가 바뀌어도) 남는다.
   *   없으면 예전처럼 출처가 「하이패스 영수증」일 때 그 통행료. 서버 driving-calc.ts hipassOf 와 같다.
   */
  function hipassOf(t, a) {
    var h = t.toll_hipass == null || t.toll_hipass === '' ? NaN : Number(t.toll_hipass);
    if (isFinite(h) && h >= 0) return Math.min(h, TOLL_MAX);
    return (t.toll_source || '') === HIPASS_SOURCE ? a : 0;
  }
  function isBiz(t) { return (t.purpose || '') === BUSINESS && !t.deleted_at; }

  /**
   * 「같은 통행료를 두 가지로 증빙」(2026-10-17) — 하이패스 출처 운행 hp[{ id, a }] 와 올린 영수증 ev[{ id, a, link }] 를 금액이 같으면 짝짓는다.
   *   ① trip_id 로 그 하이패스 운행에 이은 영수증이 먼저 ② 나머지는 영수증 id 순으로 금액이 같은 첫 하이패스 운행(시각 순)과. 하이패스 하나에 영수증 하나.
   * 서버 driving-calc.ts hpPair 와 같다. 돌려주는 것: 짝지은 영수증 id 목록.
   */
  function hpPair(hp, ev, other) {
    var used = {}, out = [];
    var list = ev.slice().sort(function (x, y) { return Number(x.id) - Number(y.id); });
    var take = function (e, ok) {
      for (var i = 0; i < hp.length; i++) {
        if (!used[i] && Math.round(hp[i].a) === Math.round(e.a) && ok(hp[i])) { used[i] = 1; out.push(e.id); return true; }
      }
      return false;
    };
    var left = list.filter(function (e) { return !(e.link && take(e, function (h) { return String(h.id) === String(e.link.id); })); });
    left.forEach(function (e) { take(e, function () { return true; }); });
    // ③ 한 운행에 톨게이트를 여러 번 지나면 하이패스는 운행 하나에 합계(3,800)로, 영수증은 톨게이트마다(1,800 + 2,000) 올라온다(2026-10-19 실제 사례).
    //    짝 못 지은 하이패스마다 남은 영수증 2장 이상을 더해 금액이 같으면 같은 통행료로 짝짓는다 — 그 운행에 이은 영수증부터, 다음 이은 데 없는 영수증.
    //    영수증 id 순 · 비트마스크 오름차순으로 처음 맞는 묶음(서버 driving-calc.ts hpPair 와 같은 답). 12장 넘게 남으면 앞 12장만 본다.
    var paired = {};
    out.forEach(function (id) { paired[String(id)] = 1; });
    // 다른 운행(하이패스 아닌 몫) 금액과 꼭 같은 영수증은 그 운행 것으로 먼저 떼어 둔다(묶음에 끌려가지 않게) — 이은 것부터, 다음 이은 데 없는 것.
    var held = {};
    (other || []).forEach(function (o) {
      var pick = function (ok) { for (var i = 0; i < list.length; i++) { var e = list[i]; if (!paired[String(e.id)] && !held[String(e.id)] && Math.round(e.a) === Math.round(o.a) && ok(e)) { held[String(e.id)] = 1; return true; } } return false; };
      pick(function (e) { return e.link && String(e.link.id) === String(o.id); }) || pick(function (e) { return !e.link; });
    });
    for (var h = 0; h < hp.length; h++) {
      if (used[h]) continue;
      var target = Math.round(hp[h].a);
      var pools = [
        list.filter(function (e) { return !paired[String(e.id)] && !held[String(e.id)] && e.link && String(e.link.id) === String(hp[h].id); }),
        list.filter(function (e) { return !paired[String(e.id)] && !held[String(e.id)] && !e.link; }),
      ];
      for (var p = 0; p < pools.length; p++) {
        var pool = pools[p].slice(0, 12), hit = 0;
        for (var m = 1; m < (1 << pool.length) && !hit; m++) {
          var n = 0, sum = 0;
          for (var b = 0; b < pool.length; b++) if (m & (1 << b)) { n++; sum += Math.round(pool[b].a); }
          if (n >= 2 && sum === target) hit = m;
        }
        if (hit) {
          used[h] = 1;
          for (var k = 0; k < pool.length; k++) if (hit & (1 << k)) { paired[String(pool[k].id)] = 1; out.push(pool[k].id); }
          break;
        }
      }
    }
    return out;
  }

  /**
   * 한 사람의 v3 결과.
   * @param o.trips  그 사람의 운행(이 기간 · 지워진 것 제외). 목적은 섞여도 된다 — 업무 운행만 금액에 쓰고,
   *                 다른 목적 운행은 「이은 영수증의 날」을 정하는 데만 쓴다.
   * @param o.evid   그 사람의 영수증(이 기간). 주차·통행료 · 금액 > 0 만 본다.
   * @param o.link   (선택) e → 이은 운행 또는 null. 없으면 o.trips 에서 trip_id 로 찾는다.
   * @param o.toll   (선택) t → 통행료 운행 금액. 없으면 tollOf(t).a.
   * @param o.day    (선택) ms → 'YYYY-MM-DD'. 없으면 KST 날짜.
   * @return { 주차: Cat, 통행료: Cat, rowOf(cat, trip) }
   *   Cat = { days: [Day…날짜순], byTrip: { 운행id: { amt, fill } }, sum }
   *   Day = { day, T, R, H, settle, st: 'no_receipt'|'match'|'mismatch'|'filled'|'no_trip', trips: [그날 업무 운행 시각순], ev: [영수증],
   *           amt: { 운행id: 운행 금액 }, fill: { 운행id: 영수증으로 채운 금액 }, target: 대표 운행(표를 누르면 여는 운행),
   *           show: 표시하는 날(2026-09-21 이후 — 「10월분부터」), D, dup: [하이패스와 같은 통행료로 짝지은 영수증], hp: [하이패스 몫이 있는 운행], ha }
   *     H = 그날 하이패스 몫 합(hipassOf — toll_hipass, 없으면 「하이패스 영수증」 출처 운행의 통행료. 영수증으로 친다 — 상태는 H + R − D 로 판정, 주차는 늘 0)
   *     ha = { 운행id: 그 운행의 하이패스 몫 } (hp 의 운행마다)
   *     D = 올린 영수증 중 하이패스 운행과 금액이 같아 짝지은 것의 합(같은 통행료의 두 번째 증빙 — 다시 세지 않는다)
   *   sum = { T, R, settle, fill, fillN, evN, noTrip, noTripN, noTripShowN, none, diff, ok, fillDays, bad }
   *     fill/fillN = 영수증으로 채운 금액·장수(결재 요약 ev_* · ev_n) · noTrip/noTripN = 정산에서 뺀 영수증(모든 날 — 금액)
   *     evN = 업무 운행이 있는 날에 붙은 영수증 장수 · none/diff/ok = R06/R10/일치 날 수 · bad = none + diff
   *     ★ none·diff·ok·bad·noTripShowN 은 표시용 — show 인 날만 센다(「10월분부터」)
   */
  function compute(o) {
    o = o || {};
    var day = o.day || ymdK;
    var all = (o.trips || []).filter(function (t) { return t && !t.deleted_at; });
    var byId = {};
    all.forEach(function (t) { byId[String(t.id)] = t; });
    var link = o.link || function (e) {
      if (e.trip_id == null) return null;
      var t = byId[String(e.trip_id)];
      return t && (e.username == null || t.username == null || t.username === e.username) ? t : null;
    };
    // 「그날 첫 업무 운행」 순서 — 시각 → 번호판 → 출발 계기판 → id (앱 ExcelExporter Kotlin·Swift 와 같은 순서, 2026-10-15).
    //   한 사람·하루를 차량과 상관없이 본다(두 대를 몬 날도 하루 하나).
    var plateOf = function (t) { return String(t.plate_no || ''); };
    var biz = all.filter(isBiz).sort(function (a, b) {
      return Number(a.start_time) - Number(b.start_time) ||
        (plateOf(a) < plateOf(b) ? -1 : plateOf(a) > plateOf(b) ? 1 : 0) ||
        (Number(a.start_odometer) || 0) - (Number(b.start_odometer) || 0) ||
        (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    var out = {};
    CATS.forEach(function (cat) {
      var days = {};
      var slot = function (k) { return days[k] || (days[k] = { day: k, T: 0, R: 0, H: 0, settle: 0, st: '', trips: [], ev: [], amt: {}, fill: {}, target: null, show: k >= FROM, D: 0, dup: [], hp: [], ha: {} }); };
      biz.forEach(function (t) {
        var d = slot(day(Number(t.start_time))), a = tripAmt(cat, t, o);
        d.trips.push(t);
        if (a > 0) {
          d.T += a; d.amt[t.id] = a;
          // 「하이패스 PDF 인정」(2026-10-15) — 하이패스 PDF 대조로 맞춘 통행료는 영수증이 있는 것으로 본다
          //   하이패스 몫 = toll_hipass(있으면), 없으면 출처가 하이패스일 때 그 통행료(2026-10-17 — 운행 금액을 고쳐도 남는다)
          var hv = cat === '통행료' ? hipassOf(t, a) : 0;
          if (hv > 0) { d.H += hv; d.hp.push(t); d.ha[t.id] = hv; }
        }
      });
      (o.evid || []).forEach(function (e) {
        if (!e || e.category !== cat) return;
        var a = Number(e.amount);
        if (!(isFinite(a) && a > 0)) return;
        var lt = link(e);
        var d = slot(day(Number(lt ? lt.start_time : e.date_millis)));
        d.R += a; d.ev.push({ e: e, a: a, t: lt });
      });
      var byTrip = {};
      var sum = { T: 0, R: 0, settle: 0, fill: 0, fillN: 0, evN: 0, noTrip: 0, noTripN: 0, noTripShowN: 0, none: 0, diff: 0, ok: 0, fillDays: 0, bad: 0 };
      var list = Object.keys(days).sort().map(function (k) { return days[k]; }).filter(function (d) {
        d.trips.forEach(function (t) { byTrip[t.id] = { amt: d.amt[t.id] || 0, fill: 0 }; });
        return d.T > 0 || d.R > 0;
      });
      list.forEach(function (d) {
        var has = d.trips.length > 0;
        // 하이패스와 같은 통행료로 짝지은 영수증(2026-10-17) — 상태 판정에서만 R 에 다시 세지 않는다
        if (d.hp.length) {
          var ids = hpPair(d.hp.map(function (t) { return { id: t.id, a: d.ha[t.id] || 0 }; }),
            d.ev.map(function (x) { return { id: x.e.id, a: x.a, link: x.t }; }),
            d.trips.map(function (t) { return { id: t.id, a: (d.amt[t.id] || 0) - (d.ha[t.id] || 0) }; }).filter(function (o) { return o.a > 0; }));
          d.ev.forEach(function (x) { if (ids.some(function (i) { return String(i) === String(x.e.id); })) { d.D += x.a; d.dup.push(x.e); } });
        }
        if (d.T > 0) {
          d.settle = d.T;
          var RR = d.H + d.R - d.D;                        // 하이패스 PDF 대조분은 영수증으로 친다 + 같은 통행료 영수증은 한 번만(서버 RR 과 같다)
          d.st = RR === 0 ? 'no_receipt' : (Math.round(d.T) === Math.round(RR) ? 'match' : 'mismatch');
        } else if (has) {
          d.settle = d.R; d.st = 'filled';
          // 이은 영수증 → 그 운행 줄(업무 운행일 때). 나머지 → 그날 첫 업무 운행 줄.
          d.ev.forEach(function (x) {
            var to = (x.t && d.trips.filter(function (t) { return String(t.id) === String(x.t.id); })[0]) || d.trips[0];
            d.fill[to.id] = (d.fill[to.id] || 0) + x.a;
            byTrip[to.id].fill += x.a;
          });
          sum.fill += d.R; sum.fillN += d.ev.length; sum.fillDays++;
        } else {
          d.settle = 0; d.st = 'no_trip';
          sum.noTrip += d.R; sum.noTripN += d.ev.length;
          if (d.show) sum.noTripShowN += d.ev.length;
        }
        if (has) sum.evN += d.ev.length;
        // 표시용 숫자는 「10월분부터」 — 그 전 날은 세지 않는다(금액은 위에서 모든 날 같게 셌다)
        if (d.show && d.st === 'no_receipt') sum.none++;
        if (d.show && d.st === 'mismatch') sum.diff++;
        if (d.show && d.st === 'match') sum.ok++;
        sum.T += d.T; sum.R += d.R; sum.settle += d.settle;
        d.ev = d.ev.map(function (x) { return x.e; });
        // 표의 줄을 누르면 여는 운행 — 금액이 있는 운행 → 영수증으로 채운 운행 → 그날 첫 업무 운행
        var withAmt = d.trips.filter(function (t) { return d.amt[t.id] > 0; });
        var withFill = d.trips.filter(function (t) { return d.fill[t.id] > 0; });
        d.target = withAmt[0] || withFill[0] || d.trips[0] || null;
      });
      sum.bad = sum.none + sum.diff;
      out[cat] = { days: list, byTrip: byTrip, sum: sum };
    });
    /** 엑셀·PDF 그 운행 줄의 금액 = 운행 금액 + 영수증으로 채운 금액(업무 운행만 · 채움은 운행 금액이 0 인 날뿐). */
    out.rowOf = function (cat, t) {
      var x = out[cat].byTrip[t.id];
      return x ? { amt: x.amt, fill: x.fill } : { amt: 0, fill: 0 };
    };
    out.settle = { park: out['주차'].sum.settle, toll: out['통행료'].sum.settle };
    return out;
  }

  /** 결과 글자(표·검증 공통). */
  var LABEL = { no_receipt: '영수증 없음', mismatch: '금액 다름', match: '일치', filled: '영수증으로 채움', no_trip: '운행 없는 영수증(정산 제외)' };

  return { compute: compute, hpPair: hpPair, hipassOf: hipassOf, tollOf: tollOf, tripAmt: tripAmt, ymdK: ymdK, LABEL: LABEL, TOLL_MAX: TOLL_MAX, BUSINESS: BUSINESS,
    HIPASS_SOURCE: HIPASS_SOURCE, FROM: FROM, VERSION: 3 };
});
