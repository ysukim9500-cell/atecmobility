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
       상태 판정에만 쓴다(정산 금액·채우기는 그대로) — 2026-10-19 부터 아래 「판정을 금액으로」.
       H 는 운행마다 toll_hipass(하이패스로 맞출 때 따로 적은 금액 — 운행 금액을 사람이 고쳐도 남는다, 2026-10-17)를 쓰고, 없으면 출처로 본다(hipassOf).
     · 「같은 통행료를 두 가지로 증빙」(2026-10-17 사용자 「직원들이 잘 모를 것 같은데… 좀 쉽게」): 올린 통행료 영수증 중 그날 하이패스 출처 운행
       통행료와 금액이 같은 것은 같은 통행료의 두 번째 증빙으로 본다. 하이패스 500 + 영수증 500 → 일치 · 하이패스 500 + 영수증 700 → 금액 다름.
       (예전 한 장씩 짝짓기 hpPair 는 이제 맞음인 날 표시용 dup 을 고를 때 먼저 써 볼 뿐이다 — 서버 driving-calc.ts 와 같은 순서·같은 답.)
     · 「10월분부터」: 표시(영수증 없음·금액 다름·운행 없는 영수증)는 2026-09-21(KST) 이후 날만(d.show).
       금액 계산은 모든 날 같다 — sum.none·diff·ok·bad·noTripShowN 은 표시용이라 d.show 인 날만 센다.

   판정을 금액으로(2026-10-19 버그 사냥 — 정본 「판정을 금액으로」) — 영수증 한 장씩 짝짓기(hpPair) 대신 하루·구분별로:
     T = 운행 금액 합 · H = 하이패스 몫 합(운행별 hipassOf) · U = 올린 영수증 합 · N = T − H(하이패스가 아닌 몫)
     U − N 이 하이패스 운행 몫들의 부분합(0 포함) 중 하나면 「맞음」(그 부분합 = 하이패스와 겹친 영수증 D), 아니면 「금액 다름」.
     H = 0 이면 예전과 같다(U = T). H = 0 · U = 0 이면 영수증 없음. 정산 금액(T·채움)은 그대로.
     표시용 D·dup 은 맞음일 때만 채운다(판정에 쓰지 않는다). 금액 다름이면 d.gap(안내용 숫자) — adviceOf 가 문구를 만든다.
   자정 넘긴 운행(2026-10-19 — 정본 「자정 넘긴 운행」): 이음 없는 영수증 날짜 D 에, 전날 시작해 D 에 끝난 업무 운행이 있으면
     그 운행의 날(D−1)로 붙인다 — receiptHome. 서버 driving-calc.ts receiptHome 과 같다.
   다음 날 날짜로 올라온 영수증(2026-10-20 사용자 결정 ② 「자동으로 옮기지 말고 안내」 — 정본 「다음 날 날짜로 올라온 영수증」):
     D 는 운행 금액이 있는데 영수증 없음, D+1 은 업무 운행 금액이 비어 같은 금액 영수증으로 채움이면 D+1 에 d.twice(두 번 정산 의심 —
     서버 검증 R14). 정산 금액은 그대로 — 2단계 표의 D+1 줄에 안내만. twicePick 이 서버 driving-calc.ts twicePick 과 같다.

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
   * 부분합 집합(0 포함, 금액은 반올림) — 금액 합 집합 DP. cap 을 주면 그 이하만. 5만 가지 넘게는 늘리지 않는다.
   * 서버 driving-calc.ts subsetSums 와 같다. 돌려주는 것: { 합: 1 }.
   */
  function subsetSums(list, cap) {
    var seen = { 0: 1 }, arr = [0];
    list.forEach(function (a) {
      a = Math.round(Number(a) || 0);
      var n = arr.length;
      for (var i = 0; i < n; i++) {
        var s = arr[i] + a;
        if ((cap == null || s <= cap) && !seen[s] && arr.length < 50000) { seen[s] = 1; arr.push(s); }
      }
    });
    return seen;
  }
  /**
   * 맞음인 날의 표시용 「하이패스와 겹친 영수증」 — 합이 D 인 영수증들. 먼저 hpPair(예전 짝짓기)가 D 와 맞으면 그것,
   * 아니면 영수증 id 순 DP 로 처음 찾은 묶음. 없으면 []. 서버 driving-calc.ts dupOf 와 같다. ev = [{ id, a, link }].
   */
  function dupOf(D, hp, ev, other) {
    if (!(D > 0)) return [];
    var amt = {};
    ev.forEach(function (e) { amt[String(e.id)] = Math.round(e.a); });
    var first = hpPair(hp, ev, other);
    if (first.reduce(function (s, id) { return s + amt[String(id)]; }, 0) === D) return first;
    var list = ev.slice().sort(function (x, y) { return Number(x.id) - Number(y.id); });
    var arr = [0], from = { 0: [] };
    for (var k = 0; k < list.length && !from[D]; k++) {
      var a = Math.round(list[k].a), n = arr.length;
      for (var i = 0; i < n; i++) {
        var s = arr[i] + a;
        if (s <= D && !from[s]) { from[s] = from[arr[i]].concat([list[k].id]); arr.push(s); }
      }
    }
    return from[D] || [];
  }
  /**
   * 금액 다름인 날의 안내용 숫자(2026-10-19). 특정 운행 금액을 제안하지 않는다 — 하루 단위 차이와 상황만.
   *   dup   = 같은 금액 영수증이 2장 이상이고 U > N(영수증이 필요보다 많음)
   *   short = 영수증이 모자란 금액 Y(하이패스와 같은 영수증 묶음 D 를 빼고 N − (U − D) > 0 인 가장 작은 값 — D 는 하이패스 부분합이면서
   *           영수증 부분합), shortD = 그 D
   *   hp    = 하이패스가 있는 날 영수증이 하이패스 일부와만 겹침(모자람이 아님 — 또는 모자람이 「하이패스와 같은 영수증을 뺀」 풀이라 다른 풀이도 있을 때)
   * 서버 driving-calc.ts gapOf 와 같다.
   */
  function gapOf(T, H, ha, evAmts) {
    T = Math.round(T); H = Math.round(H);
    var U = evAmts.reduce(function (s, a) { return s + Math.round(a); }, 0), N = T - H;
    var cnt = {}, twice = false;
    evAmts.forEach(function (a) { a = Math.round(a); cnt[a] = (cnt[a] || 0) + 1; if (cnt[a] > 1) twice = true; });
    var hpS = subsetSums(ha), rcS = subsetSums(evAmts, H), short = 0, shortD = 0;
    Object.keys(hpS).map(Number).sort(function (x, y) { return x - y; }).forEach(function (D) {
      if (D > U || !rcS[D]) return;
      var y = N - (U - D);
      if (y > 0 && (!short || y < short)) { short = y; shortD = D; }
    });
    return { T: T, H: H, U: U, N: N, diff: H + U - T, dup: twice && U > N, short: short, shortD: shortD, hp: H > 0 && U > 0 && (!short || (shortD > 0 && U > N)) };
  }
  /**
   * 금액 다름인 날의 안내 문구 — { head, tips: [] }. 서버 driving-calc.ts moneyAdvice 와 같은 글자(시험이 대조한다).
   * ★ 그대로 따르면 두 번 정산되는 안내(「운행 금액을 X원으로 고쳐」)는 내지 않는다.
   */
  function adviceOf(d, cat) {
    var g = d && d.gap;
    if (!g) return null;
    var word = cat === '주차' ? '주차비' : '통행료';
    var w = function (n) { return Math.round(n).toLocaleString('ko-KR') + '원'; };
    var head = '운행 ' + word + ' 합 ' + w(g.T) + ' · 증빙 ' + (g.H ? '하이패스 ' + w(g.H) + ' + 영수증 ' + w(g.U) : '영수증 ' + w(g.U)) +
      ' — ' + w(Math.abs(g.diff)) + ' 차이';
    var tips = [];
    // 2026-10-24 4단계 해요체 — 서버 moneyAdvice 와 같이 바꿈(마침표·줄표 없는 한 문장 · 「지우세요」「지워도」는 unkTips 가 거른다)
    if (g.dup) tips.push('같은 영수증을 두 번 올렸으면 하나를 지우세요');
    if (g.short) tips.push((g.shortD ? '하이패스와 같은 영수증을 빼면 ' : '') + '영수증 ' + w(g.short) + '어치가 빠졌으니, 사진을 더 올리거나, 실제로 안 냈으면 그 운행 ' + word + '를 고쳐 주세요');
    if (g.hp) tips.push('하이패스 이용내역에 이미 들어간 통행료면 영수증이 없어도 되니 올린 것은 지워도 되고, 하이패스와 따로 낸 통행료면 그 운행 통행료를 고쳐 주세요');
    if (!tips.length) tips.push('운행 ' + word + '와 영수증 금액 중 틀린 쪽을 고쳐 주세요');
    return { head: head, tips: tips };
  }
  /**
   * 이음 없는 영수증이 붙는 운행(자정 넘긴 운행 — 2026-10-19). 돌려주는 것: { cat: { 영수증id: 운행 } } — 여기 없는 영수증은 영수증 날짜.
   *   ① 영수증 날짜에 시각이 있고(KST 자정이 아님) 그 시각을 품은 업무 운행 [start, end] 이 있으면: 그 운행이 전날 시작했으면 그 운행,
   *      같은 날 시작했으면 영수증 날짜 그대로(②를 보지 않는다).
   *   ② 영수증 날짜 D 에 전날 시작해 D 에 끝난 업무 운행 O(자정 넘김)가 있으면
   *      · D 에 그 구분 금액 있는 업무 운행이 없으면 → O(금액 있는 O 가 먼저)
   *      · 있으면 → 금액이 O 의 그 구분 금액과 꼭 같은 영수증만(O 하나에 한 장, 영수증 id 순) O 로 — 단 D 에 남는 영수증 합이
   *        D 운행 금액 합 이상일 때만(D 가 쓸 영수증을 빼앗지 않는다 — 실데이터 10-16·10-17 처럼 양쪽 다 같은 금액일 때)
   *   biz = 업무 운행(시각 순), amtOf(cat, t) = 운행 금액, day = ms → 'YYYY-MM-DD', linkOf(e) = 이은 운행(목록에 있을 때) 또는 null.
   *   서버 driving-calc.ts receiptHome 과 같다.
   */
  function receiptHome(biz, evid, amtOf, day, linkOf) {
    var out = { '주차': {}, '통행료': {} };
    var ends = biz.filter(function (t) { return t.end_time != null && t.end_time !== '' && isFinite(Number(t.end_time)); });
    CATS.forEach(function (cat) {
      var taken = {}, have = {}, need = {};
      // 날마다 앉은 영수증 합(이은 것은 그 운행의 날, 아니면 영수증 날짜)과 그날 업무 운행 금액 합
      (evid || []).forEach(function (e) {
        if (!e || e.category !== cat || !(Number(e.amount) > 0)) return;
        var lt = linkOf ? linkOf(e) : null, k = day(Number(lt ? lt.start_time : e.date_millis));
        have[k] = (have[k] || 0) + Math.round(Number(e.amount));
      });
      biz.forEach(function (t) { var k = day(Number(t.start_time)); need[k] = (need[k] || 0) + Math.round(amtOf(cat, t)); });
      var move = function (e, t, D) { out[cat][e.id] = t; have[D] -= Math.round(Number(e.amount)); };
      (evid || []).filter(function (e) {
        return e && e.category === cat && e.trip_id == null && Number(e.amount) > 0;
      }).sort(function (x, y) { return Number(x.id) - Number(y.id); }).forEach(function (e) {
        var ms = Number(e.date_millis), D = day(ms), prev = day(ms - 864e5);
        if ((ms + KST) % 864e5 !== 0) {
          var hit = ends.filter(function (t) { return Number(t.start_time) <= ms && ms <= Number(t.end_time); })[0];
          if (hit) { if (day(Number(hit.start_time)) !== D) move(e, hit, D); return; }
        }
        var O = ends.filter(function (t) { return day(Number(t.start_time)) === prev && day(Number(t.end_time)) === D; });
        if (!O.length) return;
        var withAmt = O.filter(function (t) { return amtOf(cat, t) > 0; });
        var dayAmt = biz.some(function (t) { return day(Number(t.start_time)) === D && amtOf(cat, t) > 0; });
        if (!dayAmt) { move(e, withAmt[0] || O[0], D); return; }
        if ((have[D] || 0) - Math.round(Number(e.amount)) < (need[D] || 0)) return;
        var o = withAmt.filter(function (t) { return !taken[String(t.id)] && Math.round(amtOf(cat, t)) === Math.round(Number(e.amount)); })[0];
        if (o) { taken[String(o.id)] = 1; move(e, o, D); }
      });
    });
    return out;
  }

  /** 'YYYY-MM-DD' 의 전날(달력). 서버 driving-calc.ts prevYmd 와 같다. */
  function prevDay(k) {
    var p = String(k).split('-'), t = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] - 1));
    var z = function (n) { return (n < 10 ? '0' : '') + n; };
    return t.getUTCFullYear() + '-' + z(t.getUTCMonth() + 1) + '-' + z(t.getUTCDate());
  }
  /**
   * 두 번 정산 의심 영수증 고르기(2026-10-20, R14) — 서버 driving-calc.ts twicePick 과 같다.
   *   prevAmts = 전날 D 운행 금액(운행마다), prevT = 그 합, cands = D+1 의 후보 영수증 [{ id, a }](id 순).
   *   ① 금액이 D 운행 한 건의 금액이나 D 합과 같은 영수증들 ② 없으면 후보가 2장 이상이고 합이 D 합과 같을 때 후보 모두(톨게이트마다 낸 영수증).
   */
  function twicePick(prevAmts, prevT, cands) {
    var A = {};
    (prevAmts || []).forEach(function (x) { var a = Math.round(Number(x) || 0); if (a > 0) A[a] = 1; });
    var T = Math.round(Number(prevT) || 0);
    if (!(T > 0) || !cands || !cands.length) return [];
    var hit = cands.filter(function (c) { var a = Math.round(Number(c.a) || 0); return a > 0 && (A[a] || a === T); });
    if (hit.length) return hit.map(function (c) { return c.id; });
    var s = cands.reduce(function (x, c) { return x + Math.round(Number(c.a) || 0); }, 0);
    return cands.length >= 2 && s === T ? cands.map(function (c) { return c.id; }) : [];
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
   *     D = 맞음인 날 U − N(하이패스와 겹친 영수증 금액 — 표시용, 2026-10-19) · dup = 합이 D 인 영수증(찾을 수 있을 때만). 금액 다름이면 0·[]
   *     gap = 금액 다름인 날의 안내용 숫자(gapOf — adviceOf 가 문구로)
   *     twice = 두 번 정산 의심(filled 인 D+1 날만, 2026-10-20 — 서버 R14): { prev: 전날 'YYYY-MM-DD', trips: [전날 금액 있는 운행],
   *             ev: [의심 영수증], amount: 그 합, prevT: 전날 운행 금액 합 } · 없으면 undefined
   *   sum = { T, R, settle, fill, fillN, evN, noTrip, noTripN, noTripShowN, none, diff, ok, fillDays, bad, twice, twiceDays }
   *     twice/twiceDays = 두 번 정산 의심 영수증 장수·날 수(표시하는 날만)
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
    // 자정 넘긴 운행(2026-10-19) — 이음 없는 영수증 중 전날 시작한 운행의 날로 붙는 것
    var home = receiptHome(biz, o.evid, function (cat, t) { return tripAmt(cat, t, o); }, day, link);
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
        var lt = link(e) || home[cat][e.id] || null;
        var d = slot(day(Number(lt ? lt.start_time : e.date_millis)));
        d.R += a; d.ev.push({ e: e, a: a, t: lt });
      });
      var byTrip = {};
      var sum = { T: 0, R: 0, settle: 0, fill: 0, fillN: 0, evN: 0, noTrip: 0, noTripN: 0, noTripShowN: 0, none: 0, diff: 0, ok: 0, fillDays: 0, bad: 0, twice: 0, twiceDays: 0 };
      var list = Object.keys(days).sort().map(function (k) { return days[k]; }).filter(function (d) {
        d.trips.forEach(function (t) { byTrip[t.id] = { amt: d.amt[t.id] || 0, fill: 0 }; });
        return d.T > 0 || d.R > 0;
      });
      list.forEach(function (d) {
        var has = d.trips.length > 0;
        if (d.T > 0) {
          d.settle = d.T;
          // 판정을 금액으로(2026-10-19): U − N 이 하이패스 몫 부분합(0 포함)이면 맞음 — 서버 moneyV3 와 같다
          var haL = d.hp.map(function (t) { return d.ha[t.id] || 0; });
          var U = d.ev.reduce(function (s, x) { return s + Math.round(x.a); }, 0), N = Math.round(d.T) - Math.round(d.H);
          if (!Math.round(d.H) && !U) d.st = 'no_receipt';
          else if (subsetSums(haL)[U - N]) {
            d.st = 'match';
            d.D = U - N;                                   // 하이패스와 겹친 영수증(표시용)
            var ids = dupOf(d.D, d.hp.map(function (t) { return { id: t.id, a: d.ha[t.id] || 0 }; }),
              d.ev.map(function (x) { return { id: x.e.id, a: x.a, link: x.t }; }),
              d.trips.map(function (t) { return { id: t.id, a: (d.amt[t.id] || 0) - (d.ha[t.id] || 0) }; }).filter(function (q) { return q.a > 0; }));
            d.ev.forEach(function (x) { if (ids.some(function (i) { return String(i) === String(x.e.id); })) d.dup.push(x.e); });
          } else {
            d.st = 'mismatch';
            d.gap = gapOf(d.T, d.H, haL, d.ev.map(function (x) { return x.a; }));
          }
        } else if (has) {
          d.settle = d.R; d.st = 'filled';
          // 이은 영수증 → 그 운행 줄(업무 운행일 때). 나머지 → 그날 첫 업무 운행 줄.
          //   fillEv = 운행마다 그 줄을 채운 영수증 id(웹 영수증 적기가 근거로 남긴다 — 2026-10-20 AU2)
          d.fillEv = {};
          d.ev.forEach(function (x) {
            var to = (x.t && d.trips.filter(function (t) { return String(t.id) === String(x.t.id); })[0]) || d.trips[0];
            d.fill[to.id] = (d.fill[to.id] || 0) + x.a;
            (d.fillEv[to.id] = d.fillEv[to.id] || []).push(x.e.id);
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
      // 다음 날 날짜로 올라온 영수증 — 두 번 정산 의심(2026-10-20 사용자 결정 ② · R14 · 서버 driving-calc.ts moneyV3 twice 와 같다).
      //   D 는 영수증 없음, D+1 은 영수증으로 채움 — 후보(이음 없음 · 영수증 날짜가 D+1 · 시각이 있으면 D+1 업무 운행 시간 안이 아님)가
      //   D 운행 금액과 같으면(twicePick) D+1 에 d.twice. 정산 금액은 그대로.
      var byDay = {};
      list.forEach(function (d) { byDay[d.day] = d; });
      list.forEach(function (d1) {
        if (d1.st !== 'filled') return;
        var d0 = byDay[prevDay(d1.day)];
        if (!d0 || d0.st !== 'no_receipt') return;
        var inTrip = function (ms) {
          return (ms + KST) % 864e5 !== 0 && d1.trips.some(function (t) {
            return t.end_time != null && t.end_time !== '' && isFinite(Number(t.end_time)) && Number(t.start_time) <= ms && ms <= Number(t.end_time);
          });
        };
        var cands = d1.ev.filter(function (e) { var ms = Number(e.date_millis); return e.trip_id == null && day(ms) === d1.day && !inTrip(ms); })
          .map(function (e) { return { id: e.id, a: Number(e.amount), e: e }; })
          .sort(function (x, y) { return Number(x.id) - Number(y.id); });
        var pt = d0.trips.filter(function (t) { return d0.amt[t.id] > 0; });
        var ids = twicePick(pt.map(function (t) { return d0.amt[t.id]; }), d0.T, cands);
        if (!ids.length) return;
        var picked = cands.filter(function (c) { return ids.some(function (i) { return String(i) === String(c.id); }); });
        d1.twice = { prev: d0.day, trips: pt, ev: picked.map(function (c) { return c.e; }),
          amount: Math.round(picked.reduce(function (s, c) { return s + c.a; }, 0)), prevT: Math.round(d0.T) };
        if (d1.show) { sum.twice += picked.length; sum.twiceDays++; }
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

  /**
   * 영수증을 지우거나 「다른 운행에 붙이기」로 옮길 때 되돌릴 「영수증 금액을 넣은 운행 금액」(2026-10-20 AU2 ①).
   * 웹 영수증 적기(autoFillEv)는 채움인 날 영수증 금액을 그 운행의 금액 칸에 실제로 적는다. 그 영수증을 지우거나 다른 운행에 이으면
   * 적어 둔 금액이 남아 두 번 정산됐다(09.26 영수증 3,000 → 운행 43 에 적힘 → 09.24 운행 42 에 붙이면 42 에도 3,000 → 6,000).
   *   M      = compute(지금 자료 — 바꾸기 전) 결과
   *   moves  = [{ e: 영수증, to: 새로 이을 운행 id(지우기·「자동」이면 null) }]
   *   markOf = function (cat, trip) → 그 운행 금액이 웹 영수증 적기로 들어간 것이면 { ids: [근거 영수증 id] | null(근거 글이 없는 예전 기록), prev: 적기 전 금액(null|0) }, 아니면 null
   * 그 영수증이 붙어 있는 날(지금)의 같은 구분 업무 운행 중 금액이 있고, 표시(markOf)가 그 영수증을 가리키는 것 —
   *   근거 영수증 목록이 없으면(예전 기록) 운행 금액이 그 영수증 금액이나 그날 영수증 합과 같을 때만 — 을 돌려준다. 새로 이을 운행 자신은 빼고.
   * 돌려주는 것: [{ trip, cat, amount(지금 금액), prev, ev: [이 바꿈으로 근거가 사라지는 영수증 id], exact }] (운행·구분마다 한 줄)
   * 되돌린 뒤 그날 남은 영수증이 있으면 영수증 적기가 남은 금액으로 다시 적는다 — 정산은 늘 금액 규칙대로.
   */
  function fillUndo(M, moves, markOf) {
    var out = [], seen = {};
    (moves || []).forEach(function (mv) {
      var e = mv && mv.e, cat = e && e.category;
      if (!e || !M || !M[cat]) return;
      var d = M[cat].days.filter(function (x) { return x.ev.some(function (y) { return String(y.id) === String(e.id); }); })[0];
      if (!d) return;
      d.trips.forEach(function (t) {
        var a = d.amt[t.id] || 0;
        if (!(a > 0) || (mv.to != null && mv.to !== '' && String(mv.to) === String(t.id))) return;
        var mk = markOf ? markOf(cat, t) : null;
        if (!mk) return;
        var hit = mk.ids ? mk.ids.some(function (i) { return String(i) === String(e.id); })
          : (Math.round(a) === Math.round(Number(e.amount)) || Math.round(a) === Math.round(d.R));
        if (!hit) return;
        var k = cat + '|' + t.id;
        if (seen[k]) { if (seen[k].ev.indexOf(e.id) < 0) seen[k].ev.push(e.id); return; }
        seen[k] = { trip: t, cat: cat, amount: a, prev: mk.prev == null ? null : Number(mk.prev), ev: [e.id], exact: !!mk.ids };
        out.push(seen[k]);
      });
    });
    return out;
  }

  /* ── 같은 금액 영수증 여러 장(2026-10-21 통행료 버그 2) ──
     웹 영수증 적기(driving-app.js autoFillEv)는 운행 금액이 비어 있는 날(filled) 영수증 금액을 운행에 실제로 적는다. 그날 같은 금액 영수증이
     2장 이상(같은 영수증을 두 번 올렸을 수 있음)인데 합계를 적으면 그날이 「맞음」이 되어 서버 검증 R08 이 참고로 내려가고 중복이 정산에 굳었다
     (직원 사례: 14분 운행 1건에 1,700원 영수증 3장 → 운행 5,100원). 이제 그런 날은 적기 전에 직원에게 묻는다 —
     「두 번 낸 것 맞음(왕복 등) → 합계 적기」 / 「같은 영수증이 겹침 → 한 번만 적기」. 영수증 시각이 모두 있고 서로 다르면 별개 영수증으로 보고
     묻지 않고 합계를 적는다. ★ 같은 원본 장에서 오린 두 줄이라는 것만으로는 별개로 보지 않는다(오린 자리가 겹친 사례가 있었다).
     적을 때 글(fillNote)에 그 확인을 남기고, 서버 검증(_shared/fill-mark.ts)이 그 글로 그날 「맞음」을 믿을지 정한다(같은 글자 — 시험 r08-parity).
     통행료 맞추기 제안(toll-suggest.js)도 같은 묶음(sameAmt)으로 남는 영수증을 두 번 세지 않는다. */
  var FILL_NOTE = '영수증 금액 반영', PAID_TWICE = '두 번 낸 것 맞음', TIME_APART = '시각이 다른 영수증', ONCE = '같은 영수증 겹침';
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /**
   * 영수증 시각 'HH:MM' | null — ① 원본 장 판독(Gemini, via 'scan_page')이 그 줄에 짝지어 읽은 거래 시각(그 줄 사진·원본이 그대로일 때)
   * ② 영수증 날짜에 시각이 있으면(KST 자정이 아님 — 하이패스 인쇄 PDF·앱에서 운행과 함께 넣은 영수증 등) 그 시각. 없으면 null.
   * ai = 그 영수증의 evidence_ai 줄({ photo_path, result }) 또는 null.
   */
  function rcptTime(e, ai) {
    if (!e) return null;
    var r = ai && ai.result && ai.photo_path === e.photo_path ? ai.result : null;
    if (r && r.via === 'scan_page' && e.scan_path && r.scan_path === e.scan_path && /^\d{2}:\d{2}$/.test(String(r.time || ''))) return String(r.time);
    var ms = Number(e.date_millis);
    if (isFinite(ms) && (ms + KST) % 864e5 !== 0) { var d = new Date(ms + KST); return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); }
    return null;
  }
  /**
   * 같은 금액 영수증 묶음 — ev = 하루·한 구분의 영수증, timeOf(e) → 'HH:MM' | null(영수증 시각 — 없으면 묶음은 늘 묻는다).
   * 돌려주는 것: [{ a: 금액, ev: [영수증(id 순)], sep: 모든 영수증에 시각이 있고 서로 다름(별개 영수증) }] — 2장 이상인 금액만, 금액 순.
   */
  function sameAmt(ev, timeOf) {
    var by = {};
    (ev || []).forEach(function (e) { var a = Math.round(Number(e && e.amount) || 0); if (a > 0) (by[a] = by[a] || []).push(e); });
    return Object.keys(by).map(Number).sort(function (x, y) { return x - y; }).filter(function (a) { return by[a].length > 1; }).map(function (a) {
      var l = by[a].slice().sort(function (x, y) { return (Number(x.id) || 0) - (Number(y.id) || 0); });
      var tm = l.map(function (e) { return timeOf ? timeOf(e) : null; });
      return { a: a, ev: l, sep: tm.every(function (t) { return !!t; }) && tm.every(function (t, i) { return tm.indexOf(t) === i; }) };
    });
  }
  /**
   * 영수증으로 채우는 날(d.st 'filled')에 운행 줄마다 적을 금액 — mode 'sum' = 모두(규칙 그대로 · d.fill 과 같다) ·
   * 'once' = 시각으로 가르지 못한 같은 금액 묶음(groups — sameAmt)은 한 장만(묶음마다 id 가 가장 작은 것) 센다.
   * 돌려주는 것: [{ tripId, amount, ids: [그 줄을 채운 영수증 id] }] (그날 업무 운행 차례 · 금액이 0 인 줄은 뺀다)
   */
  function fillPlan(d, mode, groups) {
    if (!d || d.st !== 'filled') return [];
    var drop = {}, amt = {};
    if (mode === 'once') (groups || []).forEach(function (g) { if (!g.sep) g.ev.slice(1).forEach(function (e) { drop[String(e.id)] = 1; }); });
    (d.ev || []).forEach(function (e) { amt[String(e.id)] = Number(e.amount) || 0; });
    var out = [];
    (d.trips || []).forEach(function (t) {
      var ids = ((d.fillEv && d.fillEv[t.id]) || []).filter(function (id) { return !drop[String(id)]; });
      var a = Math.round(ids.reduce(function (s, id) { return s + (amt[String(id)] || 0); }, 0));
      if (ids.length && a > 0) out.push({ tripId: t.id, amount: a, ids: ids });
    });
    return out;
  }
  /**
   * 영수증 적기의 저장 글 — 통행료: toll-apply note(→ toll_evidence_json.note) · 주차: trip-edit note(→ 수정 기록 note).
   *   how: '' 그대로 · 'paid' 직원이 「두 번 낸 것 맞음」 · 'apart' 시각이 다른 영수증 · 'once' 같은 영수증 겹침 — 한 번만.
   *   통행료 「영수증(…) #id,#id」 · 주차 「영수증 금액 반영(…) #id,#id」 — #id 는 그 운행 줄을 채운 영수증(지우기·옮기기 때 되돌리기가 읽는다).
   *   서버 _shared/fill-mark.ts 가 같은 글자를 읽는다(PAID_TWICE · TIME_APART 이면 「맞음」을 믿음).
   */
  function fillNote(cat, ids, how) {
    var tag = how === 'paid' ? '(' + PAID_TWICE + ' — 직원 확인)' : how === 'apart' ? '(' + TIME_APART + ')' : how === 'once' ? '(' + ONCE + ' — 한 번만)' : '';
    return (cat === '주차' ? FILL_NOTE : '영수증') + tag + ' #' + (ids || []).join(',#');
  }

  /** 결과 글자(표·검증 공통). */
  var LABEL = { no_receipt: '영수증 없음', mismatch: '금액 다름', match: '일치', filled: '영수증으로 채움', no_trip: '운행 없는 영수증(정산 제외)' };

  return { compute: compute, hpPair: hpPair, hipassOf: hipassOf, subsetSums: subsetSums, gapOf: gapOf, adviceOf: adviceOf, receiptHome: receiptHome, tollOf: tollOf, tripAmt: tripAmt, ymdK: ymdK, LABEL: LABEL, TOLL_MAX: TOLL_MAX, BUSINESS: BUSINESS,
    twicePick: twicePick, prevDay: prevDay, fillUndo: fillUndo,
    rcptTime: rcptTime, sameAmt: sameAmt, fillPlan: fillPlan, fillNote: fillNote,
    FILL_NOTE: FILL_NOTE, PAID_TWICE: PAID_TWICE, TIME_APART: TIME_APART,
    HIPASS_SOURCE: HIPASS_SOURCE, FROM: FROM, VERSION: 3 };
});
