/* ═══════════════════════════════════════════════════════════════════════════
   toll-suggest.js — 통행료 맞추기 제안 (2026-10-21 사용자 결정 「제안 + 한 번 눌러 확정」)
   정산 규칙은 그대로다 — 금액 규칙 v3(money-rule.js · 서버 driving-calc.ts moneyV3 · 정본 docs/money-rule-v3.md)의 하루 계산 결과를
   그대로 읽어, 통행료 「모름」(미확정) 업무 운행에 넣을 값을 **제안**만 한다. 확정은 직원이 웹 창에서 고른 줄만
   (운행 고치기와 같은 trip-edit — 출처는 서버가 정하는 「웹 직접 입력」, 근거 메모 「영수증 맞춤 제안 …」 · driving-app.js tsApply).

   왜(2026-10-21 직원 사례 둘)
     · 수동 입력에서 통행료를 안 넣은 업무 운행이 많음 → 미확정 0원 정산 + 경고. 그날 영수증·하이패스는 다른 운행 금액과 모두 맞음 → 사실상 「없음」.
     · 운행을 본인이 「모름」으로 되돌림 → 그날 다른 운행에 금액이 있어 영수증이 채우지 못함(운행 금액이 있는 날 영수증은 대조만)
       → 「금액 다름」 · 덜 정산. 남는 영수증 금액을 그 운행에 넣으면 그날은 맞음.

   하루(KST)마다, 그날 통행료 미확정 업무 운행 U(toll_cost 없음·UNKNOWN·PENDING — 서버 R02 와 같은 뜻)에 대해 money-rule 통행료 하루 d 를 본다:
     ① 증빙이 하나도 없는 날(하이패스 H = 0 · 영수증 R = 0) → 「없음」 · 근거 「이날 영수증·하이패스 기록 없음」
     ② 맞음(d.st match — 증빙이 아는 운행 금액 T 를 모두 설명) → 「없음」 · 근거 「남는 증빙 없음」.
        단 그날 영수증이 그 운행에 이어져 있거나(trip_id), 영수증 시각이 그 운행 시간 안이고 금액 있는 운행 시간 밖이면 → 직접 고르기
        (왕복 중 한쪽만 하이패스·한쪽은 현금처럼 금액이 같아 하이패스와 겹친 것으로 읽혔을 수 있다)
     ③ 영수증으로 채움(d.st filled — 그날 운행 금액이 없음) → 채우는 운행은 규칙대로 영수증 금액이 들어간다(제안하지 않음 — 웹 영수증 적기가 운행에 적는다),
        나머지 미확정 운행은 「없음」(남는 영수증 없음). 두 번 정산 의심(d.twice)인 날은 모두 직접 고르기.
     ④ 금액 다름(d.st mismatch):
        · 남는 금액 L = U − D − N  (U 영수증 합 · N = T − H 하이패스가 아닌 운행 금액 · D = 하이패스와 같은 영수증 — money-rule hpPair 「한 번만 셈」.
          미확정 운행에 이었거나 그 운행 시간 안(금액 있는 운행 시간 밖)인 영수증은 그 운행 것으로 보고 하이패스와 짝짓지 않는다)
        · L ≤ 0 → 직접 고르기(남는 증빙 없음 — 증빙이 다른 운행 금액보다 적거나, 남는 영수증이 하이패스와 같은 통행료)
        · 남는 영수증 = 하이패스와 겹치지 않은 영수증 중 합이 L 인 묶음(이은 것·그 운행 시간 안인 것 먼저, 금액 있는 운행 시간 안인 것은 뒤로).
          그런 묶음이 없으면(L 이 영수증 금액과 안 맞음) 직접 고르기.
        · 미확정 하나 → 그 운행에 L(근거: 남는 영수증의 영업소·시각·금액). 남는 영수증이 금액 있는 운행 시간 안뿐이면 직접 고르기.
        · 미확정 여럿 → 남는 영수증마다 운행 하나(이은 운행 · 시각이 든 운행). 시각·이음이 없으면 장수 = 운행 수이고 금액이 모두 같을 때만.
          영수증이 안 간 운행은 「없음」. 애매하면 모두 직접 고르기(제안 없이 그 운행들과 남는 영수증만 보인다).
        · L > 200,000(통행료 상한) → 직접 고르기
     ⑤ 결재 중·완료(잠긴) 기간은 제안하지 않는다(locked).
     ⑥ 「모름」으로 되돌린 운행에 하이패스로 맞춘 금액(toll_hipass)이 남아 있으면 그 금액이 그 운행의 증빙 — ①·② 날은 그 금액, ③·④ 날은 모두 직접 고르기.
     ⑦ 같은 금액 영수증 여러 장(2026-10-21 통행료 버그 2 — 웹 영수증 적기와 같은 규칙 money-rule sameAmt): 그날 같은 금액 영수증이 2장 이상이고
        시각으로 가르지 못하면(모두 시각이 있고 서로 달라야 별개 — 같은 원본 장에서 오린 두 장이라는 것만으로는 별개가 아님) 같은 영수증을 두 번
        올린 것일 수 있다. 그 영수증이 운행 금액이 되면 그날이 「맞음」이 되어 중복이 정산에 굳는다 — 그래서 두 번 세지 않는다:
        · ③ 채움인 날 → 모두 직접 고르기(영수증 적기가 맞춰보기 표 그 줄 「확인」에서 「두 번 낸 것 맞음 / 한 번만」을 묻는다)
        · ④ 금액 다름인 날 → 남는 영수증(또는 묶음을 못 정했으면 남는 후보 모두)이 그런 묶음에 들면 모두 직접 고르기
   제안을 그대로 확정하면 그날은 규칙 v3 로 「맞음」이 된다(④: T + L 에서 U − N' = D 는 하이패스 부분합) — 시험 web/test/toll-suggest.test.js.
   금액 다름 안내(unkTips) — 그날 미확정 운행이 있으면 영수증 지우기 권유를 빼고, 증빙이 남으면 「모름 운행에 금액을」 하나로 짚는다.
     서버 _shared/driving-verify.ts R10 의 unkTips 와 같은 글자(시험 web/test/toll-suggest-parity.test.mjs).
   의존: money-rule.js(compute · hpPair · subsetSums · TOLL_MAX). 브라우저(window.TollSuggest)·node(require) 양쪽에서 쓴다.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var S = factory(node ? require('./money-rule.js') : root && root.MoneyRule);
  if (node) module.exports = S;
  if (root) root.TollSuggest = S;
})(typeof window !== 'undefined' ? window : null, function (MR) {
  'use strict';

  var KST = 9 * 3600e3, DAY = 864e5;
  var BUSINESS = '일반업무';
  var NOTE = '영수증 맞춤 제안';          // 저장 메모 머리(trip-edit → toll_evidence_json.note) — 「웹 직접 입력」 가운데 이 제안으로 맞춘 것을 가린다
  var NOTE_MAX = 200;                     // trip-edit 수정 기록 note 와 같은 길이
  var MAX_SET = 16;                       // 남는 영수증 묶음을 하나하나 볼 영수증 장수(넘으면 합만 본다)

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hmK(ms) { var d = new Date(Number(ms) + KST); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
  function won(n) { return Math.round(Number(n) || 0).toLocaleString('ko-KR') + '원'; }
  function amt(e) { return Math.round(Number(e && e.amount) || 0); }
  function same(a, b) { return a != null && b != null && String(a) === String(b); }
  /** 영수증 시각이 있는가 — KST 자정이면 날짜만 적힌 것으로 본다(money-rule receiptHome 과 같은 판단). */
  function hasTime(ms) { ms = Number(ms); return isFinite(ms) && (ms + KST) % DAY !== 0; }
  /** 그 시각이 운행 [출발, 도착] 안인가 — 도착 시각이 없거나 출발보다 이르면 모른다(false). */
  function inWin(ms, t) {
    var s = Number(t && t.start_time), e = t && t.end_time != null && t.end_time !== '' ? Number(t.end_time) : NaN;
    return isFinite(s) && isFinite(e) && e > s && Number(ms) >= s && Number(ms) <= e;
  }
  function byTime(a, b) { return Number(a.start_time) - Number(b.start_time) || (Number(a.id) || 0) - (Number(b.id) || 0); }
  function byId(a, b) { return (Number(a.id) || 0) - (Number(b.id) || 0); }

  /**
   * 통행료 미확정 업무 운행 — 금액이 없고(toll_cost 없음) 또는 상태가 UNKNOWN·PENDING 이면서 금액이 0 보다 크지 않은 것.
   * 서버 R02(isUnknownToll && toll_cost ≤ 0)와 같은 뜻 — money-rule tollOf 가 0 으로 읽는 운행이다(상태가 미확정인데 금액이 남은 옛 기록은 금액으로 친다).
   */
  function isUnk(t) {
    if (!t || t.deleted_at || (t.purpose || '') !== BUSINESS) return false;
    var c = t.toll_cost == null || t.toll_cost === '' ? null : Number(t.toll_cost);
    return (c == null || t.toll_status === 'UNKNOWN' || t.toll_status === 'PENDING') && !(c > 0);
  }
  /** 영수증 한 장 말 — 「영업소(메모) 시각 금액」(메모·시각이 없으면 뺀다). */
  function evSay(e) {
    var m = String((e && e.memo) || '').replace(/\s+/g, ' ').trim();
    if (m.length > 18) m = m.slice(0, 17) + '…';
    return (m ? m + ' ' : '') + (hasTime(e.date_millis) ? hmK(e.date_millis) + ' ' : '') + won(amt(e));
  }

  /**
   * 금액 다름인 날에 통행료 미확정 운행이 있을 때의 안내 한 줄(2026-10-21). 서버 driving-verify.ts unkTip 과 같은 글자.
   * 「… 주세요」로 끝난다 — 결재하는 분에게는 상신자 할 일로 빠진다(drv-verify.js apprDetail).
   */
  function unkTip(times) {
    return '이 날 통행료 「모름」 운행(' + times.join('·') + ')이 있습니다 — 다른 운행에 통행료가 있는 날은 영수증이 「모름」 운행을 채우지 않으니, ' +
      '남는 영수증이 그 운행 것이면 그 운행에 금액을 넣어 주세요';
  }
  /**
   * 금액 다름 안내(money-rule adviceOf · 서버 moneyAdvice 의 tips)를 그날 미확정 운행이 있을 때 고친다 — 서버 driving-verify.ts unkTips 와 같다.
   *   · 영수증 지우기 권유(「같은 영수증을 두 번 올렸으면 하나를 지우세요」 · 「… 올린 것은 지워도 됩니다 …」)는 내지 않는다
   *   · 증빙이 운행 금액보다 많으면(diff = 하이패스 + 영수증 − 운행 금액 > 0) 「모름 운행에 금액을」 하나로 짚는다
   *   · 남는 것이 없으면 「운행 통행료와 영수증 금액 중 틀린 쪽을 고쳐 주세요」
   * times = 그날 미확정 운행 출발 시각('HH:MM'). 비어 있으면 tips 그대로.
   */
  function unkTips(tips, times, diff) {
    if (!times || !times.length) return (tips || []).slice();
    var out = (tips || []).filter(function (t) { return !/지우세요|지워도/.test(t); });
    if (diff > 0) out = [unkTip(times)];
    if (!out.length) out = ['운행 통행료와 영수증 금액 중 틀린 쪽을 고쳐 주세요'];
    return out;
  }

  /** 저장 메모(trip-edit toll.note → toll_evidence_json.note) — 「영수증 맞춤 제안 — 2,400원: 남는 영수증 … #12,#13」(200자까지, #번호는 남긴다). */
  function noteOf(it) {
    var ids = (it.ev || []).map(function (e) { return '#' + e.id; }).join(',');
    var head = NOTE + ' — ' + (it.kind === 'amount' ? won(it.amount) : '없음') + ': ';
    var tail = ids ? ' ' + ids : '';
    var body = String(it.say || '');
    var room = NOTE_MAX - head.length - tail.length;
    if (body.length > room) body = body.slice(0, Math.max(0, room - 1)) + '…';
    return (head + body + tail).slice(0, NOTE_MAX);
  }

  /**
   * 남는 영수증 묶음 — 하이패스와 겹치지 않은 영수증(rest) 중 합이 L 인 것. 점수가 가장 높은 묶음:
   *   그 미확정 운행에 이은 영수증 +4 · 다른 운행에 이은 영수증 −4 · 시각이 미확정 운행 시간 안(금액 있는 운행 시간 밖) +2 · 그 반대 −2.
   * 돌려주는 것: { set: [영수증] | null(장수가 많아 합만 봄), tie: 같은 점수 묶음이 또 있음, score } · 합이 L 인 묶음이 없으면 null.
   */
  function leftSet(rest, L, U, known, linkTo) {
    var sc = rest.map(function (e) {
      var l = linkTo(e), s = 0, ms = Number(e.date_millis);
      if (l) s += U.some(function (u) { return same(u.id, l.id); }) ? 4 : -4;
      else if (hasTime(ms)) {
        var inU = U.some(function (u) { return inWin(ms, u); }), inK = known.some(function (t) { return inWin(ms, t); });
        if (inU && !inK) s += 2; else if (inK && !inU) s -= 2;
      }
      return s;
    });
    var n = rest.length;
    if (n > MAX_SET) return MR.subsetSums(rest.map(amt), L)[L] ? { set: null, tie: true, score: 0 } : null;
    var best = -1, bestScore = -Infinity, tie = false;
    for (var m = 1; m < (1 << n); m++) {
      var sum = 0, s = 0;
      for (var b = 0; b < n; b++) if (m & (1 << b)) { sum += amt(rest[b]); s += sc[b]; }
      if (sum !== L) continue;
      if (s > bestScore) { bestScore = s; best = m; tie = false; } else if (s === bestScore) tie = true;
    }
    if (best < 0) return null;
    return { set: rest.filter(function (e, i) { return best & (1 << i); }), tie: tie, score: bestScore };
  }
  /**
   * 남는 영수증을 미확정 운행에 나누기 — 영수증 하나 = 운행 하나.
   *   이은 운행 · 시각이 든 운행(하나뿐일 때)이 모두 정해지면 그대로(한 운행에 여러 장이면 합).
   *   시각·이음이 하나도 없으면 장수 = 운행 수이고 금액이 모두 같을 때만(어느 짝이든 금액이 같다). 그 밖은 null(애매).
   */
  function assign(set, U, linkTo) {
    var to = set.map(function (e) {
      var l = linkTo(e);
      if (l) { var a = U.filter(function (u) { return same(u.id, l.id); }); return a.length === 1 ? a[0] : null; }
      if (!hasTime(e.date_millis)) return null;
      var w = U.filter(function (u) { return inWin(e.date_millis, u); });
      return w.length === 1 ? w[0] : null;
    });
    var out = {};
    if (to.every(Boolean)) { set.forEach(function (e, i) { (out[to[i].id] = out[to[i].id] || []).push(e); }); return out; }
    if (to.every(function (x) { return !x; }) && set.length === U.length && set.every(function (e) { return amt(e) === amt(set[0]); })) {
      U.forEach(function (u, i) { out[u.id] = [set[i]]; });
      return out;
    }
    return null;
  }

  /** 같은 금액 묶음 한 마디 — 「1,800원 2장」. */
  function grpSay(g) { return won(g.a) + ' ' + g.ev.length + '장'; }
  /** 하루 풀기 — d = money-rule 통행료 하루(없으면 증빙도 운행 금액도 없는 날), U = 그날 미확정 업무 운행(시각 순), timeOf = 영수증 시각(⑦). */
  function solve(k, d, U, linkTo, timeOf) {
    var info = { day: k, st: d ? d.st : 'none', unk: U, items: [], left: null, diff: null, ev: [],
      T: d ? Math.round(d.T || 0) : 0, H: d ? Math.round(d.H || 0) : 0, R: d ? Math.round(d.R || 0) : 0 };
    var mk = function (t, kind, amount, why, say, ev) {
      var it = { trip: t, day: k, kind: kind, amount: kind === 'none' ? 0 : kind === 'pick' ? null : Math.round(amount), why: why, say: say, ev: ev || [] };
      it.note = kind === 'none' || kind === 'amount' ? noteOf(it) : '';
      info.items.push(it);
      return it;
    };
    var pickAll = function (why, say, ev) { U.forEach(function (t) { mk(t, 'pick', null, why, say, ev); }); return info; };
    // 「모름」으로 되돌린 운행에 하이패스로 맞춘 금액(toll_hipass)이 남아 있으면 그것이 그 운행의 증빙이다(하이패스 PDF 인정) —
    //   money-rule 은 금액이 0 인 운행의 하이패스 몫을 세지 않으므로 여기서 따로 본다. 증빙이 없거나 맞는 날 → 그 운행에 그 금액
    //   (넣으면 운행 금액과 하이패스 몫이 함께 늘어 그날 판정은 그대로), 금액 다름·채움인 날 → 모두 직접 고르기.
    var hipU = function (t) { var h = t.toll_hipass == null || t.toll_hipass === '' ? NaN : Number(t.toll_hipass); return isFinite(h) && h > 0 ? Math.min(Math.round(h), MR.TOLL_MAX) : 0; };
    var hipSay = function (t) { return '이 운행에 하이패스 이용내역으로 맞춘 ' + won(hipU(t)) + '이 남아 있습니다(하이패스가 증빙)'; };
    var withH = U.filter(function (t) { return hipU(t) > 0; });
    if (withH.length && d && (d.st === 'mismatch' || d.st === 'filled')) {
      return pickAll('hipass', '이 날 「모름」 운행에 하이패스로 맞춘 금액이 남아 있습니다(' + withH.map(function (t) { return hmK(t.start_time) + ' ' + won(hipU(t)); }).join(' · ') +
        ') — 하이패스로 낸 통행료면 그 운행에 그 금액을 넣어 주세요', []);
    }
    // ① 증빙이 하나도 없는 날
    if (!d || (!(info.H > 0) && !(info.R > 0))) {
      U.forEach(function (t) { if (hipU(t)) mk(t, 'amount', hipU(t), 'hipass', hipSay(t)); else mk(t, 'none', 0, 'nothing', '이날 영수증·하이패스 기록 없음'); });
      return info;
    }
    var isU = function (t) { return !!t && U.some(function (u) { return same(u.id, t.id); }); };
    var known = d.trips.filter(function (t) { return d.amt[t.id] > 0; });
    var inKnown = function (ms) { return known.some(function (t) { return inWin(ms, t); }); };
    var ev = d.ev.slice().sort(byId);
    // ⑦ 시각으로 가르지 못한 같은 금액 영수증 묶음(같은 영수증을 두 번 올렸을 수 있음)
    var dupG = MR.sameAmt(ev, timeOf).filter(function (g) { return !g.sep; });
    var dupSay0 = function (G) {
      return '같은 금액 영수증 ' + G.map(grpSay).join(' · ') + '이 있습니다 — 같은 영수증을 두 번 올렸으면 하나를 지우고, 실제로 여러 번 냈으면(왕복 등) ';
    };
    // ③ 영수증으로 채움 — 채우는 운행은 규칙대로(제안하지 않음), 나머지는 남는 영수증 없음
    if (d.st === 'filled') {
      if (d.twice) return pickAll('twice', '두 번 정산 의심인 날입니다 — 맞춰보기 표의 그 줄 안내를 먼저 보세요', ev);
      if (dupG.length) return pickAll('dupfill', '같은 금액 영수증 ' + dupG.map(grpSay).join(' · ') + '이 있어 영수증 금액을 운행에 넣기 전에 확인합니다 — ' +
        '맞춰보기 표 그 줄의 「확인」에서 「합계 적기」(실제로 여러 번 냄) 또는 「한 번만 적기」(같은 영수증이 겹침)를 골라 주세요',
        [].concat.apply([], dupG.map(function (g) { return g.ev; })));
      var tgts = d.trips.filter(function (t) { return d.fill[t.id] > 0; });
      U.forEach(function (t) {
        var f = Math.round(d.fill[t.id] || 0);
        if (f > 0) {
          var ids = (d.fillEv && d.fillEv[t.id]) || [];
          mk(t, 'auto', f, 'filled', '영수증 ' + won(f) + '이 이 운행에 들어갑니다(영수증으로 채움 — 따로 맞추지 않아도 됩니다)',
            ev.filter(function (e) { return ids.some(function (i) { return same(i, e.id); }); }));
        } else {
          mk(t, 'none', 0, 'filledOther', '이날 영수증 ' + won(info.R) + '은 ' + tgts.map(function (x) { return hmK(x.start_time); }).join('·') + ' 운행에 들어갑니다 — 남는 증빙 없음');
        }
      });
      return info;
    }
    // ② 맞음 — 남는 증빙 없음(그 운행에 이은·그 운행 시간 안 영수증이 있으면 직접 고르기)
    if (d.st === 'match') {
      var proof = info.H ? '하이패스 ' + won(info.H) + (info.R ? ' · 영수증 ' + won(info.R) : '') : '영수증 ' + won(info.R);
      U.forEach(function (t) {
        if (hipU(t)) return mk(t, 'amount', hipU(t), 'hipass', hipSay(t));
        var lk = ev.filter(function (e) { var l = linkTo(e); return l && same(l.id, t.id); });
        if (lk.length) return mk(t, 'pick', null, 'linked', '이 운행에 이은 영수증 ' + lk.map(evSay).join(' · ') + '이 있습니다 — 이날 증빙은 다른 운행 통행료와 맞아 금액을 정하지 않았습니다', lk);
        var tm = ev.filter(function (e) { return !linkTo(e) && hasTime(e.date_millis) && inWin(e.date_millis, t) && !inKnown(e.date_millis); });
        if (tm.length) return mk(t, 'pick', null, 'timed', '영수증 ' + tm.map(evSay).join(' · ') + '이 이 운행 시간 안입니다 — 이날 증빙은 다른 운행 통행료와 맞아 금액을 정하지 않았습니다', tm);
        mk(t, 'none', 0, 'match', '남는 증빙 없음 — 이날 ' + proof + '이 다른 운행 통행료 ' + won(info.T) + '과 맞습니다' +
          (d.D > 0 ? '(하이패스와 같은 영수증 ' + won(d.D) + '은 한 번만 셈)' : ''));
      });
      return info;
    }
    if (d.st !== 'mismatch') return pickAll('other', '이날 통행료 증빙을 확인해 주세요', ev);
    // ④ 금액 다름 — 남는 금액 L = U − D − N
    var N = info.T - info.H;
    var Usum = ev.reduce(function (s, e) { return s + amt(e); }, 0);
    var diff = Usum - N;
    info.diff = diff;
    if (!(diff > 0)) return pickAll('short', '남는 증빙이 없습니다 — 이날 증빙이 다른 운행 통행료보다 ' + won(-diff) + ' 적습니다', []);
    // 미확정 운행 것으로 보이는 영수증(그 운행에 이음 · 시각이 그 운행 시간 안이고 금액 있는 운행 시간 밖)은 하이패스와 짝짓지 않는다
    var mine = function (e) {
      var l = linkTo(e);
      if (l) return isU(l);
      return hasTime(e.date_millis) && U.some(function (u) { return inWin(e.date_millis, u); }) && !inKnown(e.date_millis);
    };
    var pool = ev.filter(function (e) { return !mine(e); });
    var hp = d.hp.map(function (t) { return { id: t.id, a: Math.round(d.ha[t.id] || 0) }; }).filter(function (h) { return h.a > 0; });
    var other = known.map(function (t) { return { id: t.id, a: Math.round((d.amt[t.id] || 0) - (d.ha[t.id] || 0)) }; }).filter(function (q) { return q.a > 0; });
    // 「한 번만 셈」 — 하이패스와 같은 금액 영수증(한 장 또는 여러 장 합)은 같은 통행료의 두 번째 증빙(money-rule hpPair 그대로)
    var dupIds = hp.length ? MR.hpPair(hp, pool.map(function (e) { var l = linkTo(e); return { id: e.id, a: amt(e), link: l ? { id: l.id } : null }; }), other) : [];
    var isDup = function (e) { return dupIds.some(function (i) { return same(i, e.id); }); };
    var D = ev.filter(isDup).reduce(function (s, e) { return s + amt(e); }, 0);
    var L = diff - D;
    info.left = L;
    if (!(L > 0)) return pickAll('dup', '남는 증빙이 없습니다 — 남는 영수증이 하이패스와 같은 통행료로 보입니다(한 번만 셈)', ev.filter(isDup));
    if (L > MR.TOLL_MAX) return pickAll('max', '남는 증빙 ' + won(L) + '이 통행료 상한(200,000원)을 넘습니다', []);
    var rest = ev.filter(function (e) { return !isDup(e); });
    var lf = leftSet(rest, L, U, known, linkTo);
    if (!lf) return pickAll('partial', '남는 증빙 ' + won(L) + '이 영수증 금액과 맞지 않습니다 — 다른 운행 통행료가 틀렸을 수 있습니다', rest);
    // ⑦ 남는 영수증(묶음을 못 정했으면 남는 후보 모두)이 같은 금액 묶음에 들면 — 제안하면 중복이 운행 금액이 된다. 직접 고르기.
    var cand = lf.set && !lf.tie ? lf.set : rest;
    var risky = dupG.filter(function (g) { return g.ev.some(function (e) { return cand.some(function (c) { return same(c.id, e.id); }); }); });
    if (risky.length) return pickAll('same', dupSay0(risky) + '그 운행 통행료를 직접 넣어 주세요',
      [].concat.apply([], risky.map(function (g) { return g.ev; })));
    var named = !!(lf.set && !lf.tie);
    info.ev = named ? lf.set : [];
    var dupSay = D > 0 ? '(하이패스와 같은 영수증 ' + won(D) + '은 한 번만 셈)' : '';
    if (lf.score < 0) return pickAll('elsewhere', '남는 영수증 ' + (lf.set || rest).map(evSay).join(' · ') + '이 금액 있는 다른 운행 시간 안입니다 — 다른 운행 통행료가 틀렸을 수 있습니다', lf.set || rest);
    if (U.length === 1) {
      mk(U[0], 'amount', L, 'left', (named ? '남는 영수증 ' + lf.set.map(evSay).join(' · ') : '남는 증빙 ' + won(L)) + dupSay, named ? lf.set : []);
      return info;
    }
    var asg = named ? assign(lf.set, U, linkTo) : null;
    if (!asg) return pickAll('many', (named ? '남는 영수증 ' + lf.set.map(evSay).join(' · ') : '남는 증빙 ' + won(L)) + '을 어느 운행에 넣을지 정할 수 없습니다', named ? lf.set : rest);
    var got = U.filter(function (u) { return (asg[u.id] || []).length; });
    U.forEach(function (u) {
      var es = asg[u.id] || [];
      if (es.length) mk(u, 'amount', es.reduce(function (s, e) { return s + amt(e); }, 0), 'left', '남는 영수증 ' + es.map(evSay).join(' · ') + dupSay, es);
      else mk(u, 'none', 0, 'leftOther', '이날 남는 영수증은 ' + got.map(function (x) { return hmK(x.start_time); }).join('·') + ' 운행 몫입니다 — 이 운행 몫 증빙 없음');
    });
    return info;
  }

  /**
   * 한 사람 · 한 기간의 제안.
   * @param o.trips  그 사람의 운행(이 기간 — money-rule compute 와 같은 목록)
   * @param o.evid   그 사람의 영수증(이 기간)
   * @param o.money  (선택) 같은 자료의 MoneyRule.compute 결과 — 없으면 여기서 센다
   * @param o.toll · o.day · o.link  (선택) compute 와 같다
   * @param o.timeOf (선택) 영수증 → 시각 'HH:MM' | null(⑦ 같은 금액 묶음 가르기 — 웹은 원본 장 판독 시각까지). 없으면 영수증 날짜의 시각(money-rule rcptTime)
   * @param o.locked 그 기간이 결재 중·완료 — 제안하지 않는다
   * @return { locked, items: [Item…날짜·시각 순], days: { 'YYYY-MM-DD': DayInfo }, n: { unk, none, amount, pick, auto } }
   *   Item = { trip, day, kind: 'none'(없음 0원) | 'amount'(금액) | 'pick'(직접 고르기 — 제안 없음) | 'auto'(영수증으로 채움 — 규칙대로 들어감),
   *            amount, why, say: 근거 글, ev: [근거 영수증], note: 저장 메모(none·amount 만) }
   *   DayInfo = { day, st, unk: [미확정 운행], items, left: 남는 금액 L(금액 다름인 날), diff: 영수증 − 하이패스 아닌 운행 금액, ev: [남는 영수증], T, H, R }
   */
  function plan(o) {
    o = o || {};
    var out = { locked: !!o.locked, items: [], days: {}, n: { unk: 0, none: 0, amount: 0, pick: 0, auto: 0 } };
    if (o.locked || !MR) return out;
    var day = o.day || MR.ymdK;
    var trips = (o.trips || []).filter(function (t) { return t && !t.deleted_at; });
    var tById = {};
    trips.forEach(function (t) { tById[String(t.id)] = t; });
    var M = o.money || MR.compute({ trips: trips, evid: o.evid, toll: o.toll, day: day, link: o.link });
    var dayOf = {};
    ((M && M['통행료'] && M['통행료'].days) || []).forEach(function (d) { dayOf[d.day] = d; });
    // 이은 운행 — compute 와 같다(목록에 있고 같은 사람일 때만)
    var linkTo = function (e) {
      if (!e || e.trip_id == null) return null;
      var t = tById[String(e.trip_id)];
      return t && (e.username == null || t.username == null || t.username === e.username) ? t : null;
    };
    var unk = {};
    var timeOf = o.timeOf || function (e) { return MR.rcptTime(e, null); };
    trips.filter(isUnk).sort(byTime).forEach(function (t) { var k = day(Number(t.start_time)); (unk[k] = unk[k] || []).push(t); });
    Object.keys(unk).sort().forEach(function (k) {
      var info = solve(k, dayOf[k], unk[k], linkTo, timeOf);
      out.days[k] = info;
      info.items.forEach(function (it) { out.items.push(it); out.n.unk++; out.n[it.kind]++; });
    });
    return out;
  }

  /**
   * 맞춰보기 표 「금액 다름」 줄의 할 일(그날 미확정 운행이 있고 증빙이 남을 때) —
   * 「이 날 모름 운행 10:14 에 금액을 넣으세요(제안 4,400원)」 · 여럿이면 「(제안 10:14 2,400원 · 13:20 없음)」 · 제안이 없으면 「(남는 증빙 X원)」.
   */
  function rowSay(info) {
    if (!info || !info.unk || !info.unk.length) return '';
    var s = '이 날 모름 운행 ' + info.unk.map(function (t) { return hmK(t.start_time); }).join('·') + ' 에 금액을 넣으세요';
    var its = info.items || [];
    if (its.length === 1 && its[0].kind === 'amount') return s + '(제안 ' + won(its[0].amount) + ')';
    if (its.length > 1 && its.some(function (it) { return it.kind === 'amount' || it.kind === 'none'; })) {
      return s + '(제안 ' + its.map(function (it) {
        return hmK(it.trip.start_time) + ' ' + (it.kind === 'amount' ? won(it.amount) : it.kind === 'none' ? '없음' : '직접 고르기');
      }).join(' · ') + ')';
    }
    return info.left > 0 ? s + '(남는 증빙 ' + won(info.left) + ')' : s;
  }

  return { plan: plan, isUnk: isUnk, unkTip: unkTip, unkTips: unkTips, rowSay: rowSay, evSay: evSay, noteOf: noteOf, NOTE: NOTE, hmK: hmK };
});
