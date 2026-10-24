/* ═══════════════════════════════════════════════════════════════════════════
   cycle-rules.js — 마감 기간 엔진(웹) (2026-10-20 연말 마감 설정)
   ---------------------------------------------------------------------------
   · 원천은 서버 app_config.cycle_rules(jsonb) 하나다. 규칙은 DB(cycle_key_in · cycle_bounds_in)·서버
     supabase/functions/_shared/cycle-rules.ts 와 같다 — 한쪽을 고치면 다른 쪽도 고친다.
       기간 키 = 그 날(KST 달력 날짜)을 품은 override(배열 차례 첫 번째), 없으면 기본 규칙.
       기간 범위 = 그 키의 override, 없으면 기본 범위. 그 갈래에 없는 추가 기간 키('…-12b')는 없음(null).
     기본 규칙(바꿀 수 없음): 운행일지 21일 ~ 다음 달 20일 · 개인경비 20일 ~ 19일 · 법인카드 1일 ~ 말일, 이름은 끝나는 달.
     ★ 설정이 없으면(overrides 빈 배열 · cycle_rules 없음 · 못 읽음) 지금까지의 웹 식과 하루도, 1ms 도 다르지 않다.
   · 기간 c = {y, m} — 12월 추가 기간(「2026년 12월분 2차」, 키 '2026-12b')만 {y, m: 12, x: 'b'}.
     순서 ord(c) = y*12 + m (+0.5 추가 기간 — 12월분과 다음 1월분 사이).
   · P(기간 한 칸) = { kind, key, y, m, x('' | 'b'), lo, hi('YYYY-MM-DD' KST, 둘 다 포함), loMs, endMs([loMs, endMs) ms),
                       label('2026년 12월분 2차'), short('12월분 2차') } — 이름은 키로 정해진다(DB cycle_label 과 같다).
   · kind = 'driving' | 'expense' | 'card'(화면 갈래 글자 d·x·c 는 driving-app.js kindOfMode).
   · 서버 값은 앱(CycleRules.kt fromMap)과 같은 관대함으로 읽는다 — 틀린 칸은 기본값, 틀린 override 줄은 그 줄만 뺀다.
     객체가 아니거나 못 받으면 직전 값 그대로(처음이면 기본). 받은 값은 이 브라우저(localStorage 'drv.cycrules.v1')에
     두었다가 다음에 열 때 먼저 쓴다(첫 화면이 서버 답을 기다리지 않게). start_day 는 읽지 않는다(서버가 바꾸지 못하게 막는다).
   · 순수 계산만 한다 — 화면·서버를 만지지 않는다. 브라우저(window.CycleRules)·Node(require) 양쪽.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CycleRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KINDS = ['driving', 'expense', 'card'];
  var START = { driving: 21, expense: 20, card: 1 };
  var KIND_NAME = { driving: '운행일지', expense: '개인경비', card: '법인카드' };
  var STORE = 'drv.cycrules.v1';
  var DAY = 864e5, KST = 9 * 3600e3;
  var GRACE_DEFAULT = 5, GRACE_MAX = 28, SPAN_MAX = 92;
  var DEFAULT_RAW = deepFreeze({ v: 1, grace_days: GRACE_DEFAULT, driving: { start_day: 21 }, expense: { start_day: 20 },
    card: { start_day: 1 }, overrides: [] });

  function deepFreeze(o) {
    if (o && typeof o === 'object') { Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); }
    return o;
  }
  function p2(n) { var s = String(n); return s.length < 2 ? '0' + s : s; }
  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  /* ── 날짜 — 날 번호(1970-01-01 = 0)로 센다. 날짜는 모두 KST 달력 날짜. ── */
  function dnOf(y, m, d) { return Date.UTC(y, m - 1, d) / DAY; }
  function partsOf(n) { var d = new Date(n * DAY); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
  function ymdOf(n) { var p = partsOf(n); return p.y + '-' + p2(p.m) + '-' + p2(p.d); }
  /** 'YYYY-MM-DD'(달력에 있는 날만) → 날 번호, 아니면 null. */
  function dnYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1) return null;
    var n = dnOf(y, mo, d), p = partsOf(n);
    return p.y === y && p.m === mo && p.d === d ? n : null;
  }
  /** ms → 그 시각의 KST 날 번호(ms 가 숫자가 아니면 null). */
  function dnMs(ms) {
    var x = Number(ms);
    if (!isFinite(x) || Math.abs(x) > 8.64e15) return null;
    return Math.floor((x + KST) / DAY);
  }

  /* ── 기간 이름(키) ── */
  /** 키 글자를 느슨히 읽는다(해 제한 없음) — 'YYYY-M' · 'YYYY-MM' · 'YYYY-12b'. */
  function keyParts(s) {
    var m = /^(\d{4})-(\d{1,2})(b?)$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12 || (m[3] && mo !== 12)) return null;
    return m[3] ? { y: y, m: mo, x: 'b' } : { y: y, m: mo };
  }
  /** 기간 객체를 확인해 깨끗한 c 로(아니면 null). */
  function objC(c) {
    if (!c || typeof c !== 'object') return null;
    var y = c.y, mo = c.m, x = c.x || '';
    if (!isInt(y) || !isInt(mo) || y < 1000 || y > 9999 || mo < 1 || mo > 12) return null;
    if (x && (x !== 'b' || mo !== 12)) return null;
    return x ? { y: y, m: mo, x: 'b' } : { y: y, m: mo };
  }
  function cOf(c) { return typeof c === 'string' ? keyParts(c) : objC(c); }
  /** 'YYYY-M' · 'YYYY-MM' · 'YYYY-12b'(해 2020~2100) → {y, m[, x:'b']}, 아니면 null. 기간 객체도 받는다. */
  function parse(s) {
    var c = cOf(s);
    return c && c.y >= 2020 && c.y <= 2100 ? c : null;
  }
  function isKey(s) { return typeof s === 'string' && parse(s) !== null; }
  /** c → 'YYYY-MM' · 'YYYY-12b'. 글자면 바르게 고친 키(못 읽으면 그대로). 틀린 객체도 옛 식(c.y + '-' + pad(c.m))처럼 적는다. */
  function key(c) {
    if (typeof c === 'string') { var k = keyParts(c); return k ? key(k) : c; }
    if (!c) return '';
    return c.y + '-' + p2(c.m) + (c.x === 'b' ? 'b' : '');
  }
  /** '2026년 12월분' · '2026년 12월분 2차'(DB cycle_label 과 같다). 글자를 못 읽으면 그대로. */
  function name(c) {
    if (typeof c === 'string') { var k = keyParts(c); return k ? name(k) : c; }
    if (!c) return '';
    return c.y + '년 ' + c.m + '월분' + (c.x === 'b' ? ' 2차' : '');
  }
  /** '12월분' · '12월분 2차'. */
  function short(c) {
    if (typeof c === 'string') { var k = keyParts(c); return k ? short(k) : c; }
    if (!c) return '';
    return c.m + '월분' + (c.x === 'b' ? ' 2차' : '');
  }
  /** 차례 — y*12 + m, 추가 기간은 +0.5(12월분과 다음 1월분 사이). 두 기간의 차례 비교는 ord(a) - ord(b). */
  function ord(c) {
    if (typeof c === 'string') { var k = keyParts(c); return k ? ord(k) : NaN; }
    if (!c) return NaN;
    return c.y * 12 + c.m + (c.x === 'b' ? 0.5 : 0);
  }
  /** 「전월 대비」용 이름 달 — '2027-01' → '2026-12' · '2026-12b' → null(추가 기간은 비교하지 않는다). */
  function prevMonthKey(k) {
    var c = cOf(k);
    if (!c || c.x) return null;
    return c.m === 1 ? (c.y - 1) + '-12' : c.y + '-' + p2(c.m - 1);
  }

  /* ── 기본 규칙(21 · 20 · 1) ── */
  function stdKeyN(kind, n) {
    var st = START[kind];
    if (!st || n == null) return null;
    var p = partsOf(n), y = p.y, mo = p.m;
    if (st > 1 && p.d >= st) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    return y + '-' + p2(mo);
  }
  /** 기본 범위(날 번호) — 키가 'YYYY-MM' 꼴이 아니면 null(DB cycle_std_bounds 와 같다). */
  function stdBN(kind, k) {
    var st = START[kind], m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(k == null ? '' : k));
    if (!st || !m) return null;
    var y = +m[1], mo = +m[2];
    if (st <= 1) return { loN: dnOf(y, mo, 1), hiN: dnOf(y, mo + 1, 1) - 1 };
    return { loN: dnOf(y, mo - 1, st), hiN: dnOf(y, mo, st - 1) };
  }
  function stdKey(kind, ymd) { return stdKeyN(kind, dnYmd(ymd)); }
  function stdBounds(kind, k) { var b = stdBN(kind, k); return b ? { lo: ymdOf(b.loN), hi: ymdOf(b.hiN) } : null; }

  /* ── 지금 규칙 ── */
  /** 서버 한 줄 → override(틀리면 null — 그 줄만 뺀다). 앱 overrideOf 와 같은 판정 + 웹이 다룰 수 있는 키만. */
  var SP = /^[\t    -   　]+|[\t    -   　]+$/g;
  function trimSp(s) { return String(s).replace(SP, ''); }
  function looseYmd(s) {
    if (typeof s !== 'string') return null;
    var p = trimSp(s).split('-');
    if (p.length !== 3 || !/^\d{4}$/.test(p[0]) || !/^\+?\d+$/.test(p[1]) || !/^\+?\d+$/.test(p[2])) return null;
    var y = +p[0], mo = parseInt(p[1], 10), d = parseInt(p[2], 10);
    if (mo < 1 || mo > 12 || d < 1) return null;
    var n = dnOf(y, mo, d), q = partsOf(n);
    return q.y === y && q.m === mo && q.d === d ? n : null;
  }
  function ovOf(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    var kind = typeof x.kind === 'string' ? trimSp(x.kind) : '';
    if (!START[kind]) return null;
    var c = typeof x.key === 'string' ? keyParts(trimSp(x.key)) : null;
    if (!c) return null;
    var loN = looseYmd(x.lo), hiN = looseYmd(x.hi);
    if (loN == null || hiN == null || hiN < loN || hiN - loN > SPAN_MAX) return null;
    var k = key(c);
    return { kind: kind, key: k, loN: loN, hiN: hiN, lo: ymdOf(loN), hi: ymdOf(hiN),
      label: typeof x.label === 'string' && trimSp(x.label) ? trimSp(x.label) : name(c) };
  }
  /** 정수 읽기(앱 intOf 와 같다) — 숫자는 소수 아래를 버리고, 참·거짓은 1·0, 글자는 ASCII 정수만. */
  function intOf(v) {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return isFinite(v) ? (v < 0 ? Math.ceil(v) : Math.floor(v)) : null;
    if (typeof v === 'string' && /^[+-]?[0-9]+$/.test(v)) return parseInt(v, 10);
    return null;
  }
  function mkRules(grace, ovs) {
    var by = { driving: [], expense: [], card: [] };
    ovs.forEach(function (o) { by[o.kind].push(o); });
    return { grace: grace, ovs: ovs, by: by,
      sig: JSON.stringify([grace, ovs.map(function (o) { return [o.kind, o.key, o.lo, o.hi, o.label]; })]) };
  }
  /** 서버 값(객체 또는 JSON 글자) → 규칙. 객체가 아니면 null(= 못 받음). */
  function parseRules(raw) {
    var o = raw;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { return null; } }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    var g = intOf(o.grace_days);
    if (g == null || g < 0 || g > GRACE_MAX) g = GRACE_DEFAULT;
    var ovs = [];
    (Array.isArray(o.overrides) ? o.overrides : []).forEach(function (x) { var v = ovOf(x); if (v) ovs.push(v); });
    return mkRules(g, ovs);
  }
  var DEFAULT_RULES = mkRules(GRACE_DEFAULT, []);
  var CUR = DEFAULT_RULES;

  function rawOf(R) {
    return { v: 1, grace_days: R.grace, driving: { start_day: 21 }, expense: { start_day: 20 }, card: { start_day: 1 },
      overrides: R.ovs.map(function (o) { return { kind: o.kind, key: o.key, lo: o.lo, hi: o.hi, label: o.label }; }) };
  }
  function store(get, val) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return null;
      if (get) return localStorage.getItem(STORE);
      localStorage.setItem(STORE, val);
    } catch (e) { }
    return null;
  }
  /** 이 브라우저에 두었던 규칙을 읽는다(없거나 못 읽으면 지금 값 그대로 — 처음이면 기본). 스크립트가 실릴 때 한 번 저절로 돈다. */
  function boot() {
    var r = parseRules(store(true));
    if (r) CUR = r;
    return !!r;
  }
  /** 서버 값을 받는다(객체 또는 JSON 글자). 바뀌었으면 true(이 브라우저에도 둔다). 객체가 아니면(못 받음) 그대로 두고 false. */
  function set(raw) {
    var r = parseRules(raw);
    if (!r || r.sig === CUR.sig) return false;
    CUR = r;
    store(false, JSON.stringify(rawOf(CUR)));
    return true;
  }
  /** 지금 규칙(서버 꼴 — {v, grace_days, driving, expense, card, overrides}). 새 객체. */
  function raw() { return rawOf(CUR); }
  function graceDays() { return CUR.grace; }
  /** 규칙 raw 로 잠깐 바꿔 fn 을 돌린다(저장하지 않는다 — 가짜 서버의 미리보기·시험용). */
  function under(rawRules, fn) {
    var keep = CUR;
    CUR = parseRules(rawRules) || DEFAULT_RULES;
    try { return fn(); } finally { CUR = keep; }
  }

  /* ── 기간 찾기 ── */
  function ovAt(kind, n) {
    var L = CUR.by[kind] || [];
    for (var i = 0; i < L.length; i++) if (L[i].loN <= n && n <= L[i].hiN) return L[i];
    return null;
  }
  function ovKey(kind, k) {
    var L = CUR.by[kind] || [];
    for (var i = 0; i < L.length; i++) if (L[i].key === k) return L[i];
    return null;
  }
  function keyOfN(kind, n) { var o = ovAt(kind, n); return o ? o.key : stdKeyN(kind, n); }
  /** 키의 범위(날 번호) — override, 없으면 기본(추가 기간은 override 로만 있다). */
  function boundsN(kind, k) { var o = ovKey(kind, k); return o ? { loN: o.loN, hiN: o.hiN } : stdBN(kind, k); }
  function mkP(kind, k, b) {
    var c = keyParts(k);
    return { kind: kind, key: k, y: c.y, m: c.m, x: c.x || '', lo: ymdOf(b.loN), hi: ymdOf(b.hiN),
      loMs: b.loN * DAY - KST, endMs: (b.hiN + 1) * DAY - KST, label: name(c), short: short(c) };
  }
  function perN(kind, n) {
    if (!START[kind] || n == null) return null;
    var k = keyOfN(kind, n), b = k && boundsN(kind, k);
    return b ? mkP(kind, k, b) : null;
  }
  /** 그 날('YYYY-MM-DD', KST)을 품은 기간 P(틀린 날·갈래면 null). */
  function periodOfDay(kind, ymd) { return perN(kind, dnYmd(ymd)); }
  /** 그 시각(ms)이 든 기간 P(숫자가 아니면 null). */
  function periodOfMs(kind, ms) { return perN(kind, dnMs(ms)); }
  /** 키(또는 c)의 기간 P — 그 갈래에 없는 기간이면 null(추가 기간을 두지 않은 갈래의 '…-12b' 등). */
  function byKey(kind, c) {
    if (!START[kind]) return null;
    var o = cOf(c);
    if (!o) return null;
    var k = key(o), ov = ovKey(kind, k);
    if (ov) return mkP(kind, k, ov);
    if (o.x) return null;
    var b = stdBN(kind, k);
    if (!b) return null;
    // 남은 날이 없는 기간(정규화된 설정에서는 생기지 않는다) — 첫날·끝날이 이 키가 아니면 없는 기간
    if (CUR.by[kind].length && (keyOfN(kind, b.loN) !== k || keyOfN(kind, b.hiN) !== k)) return null;
    return mkP(kind, k, b);
  }
  function next(P) { return P ? perN(P.kind, dnYmd(P.hi) + 1) : null; }
  function prev(P) { return P ? perN(P.kind, dnYmd(P.lo) - 1) : null; }
  function toC(P) { return P.x ? { y: P.y, m: P.m, x: P.x } : { y: P.y, m: P.m }; }
  /** 옛 달 셈(설정이 없는 갈래·틀린 c) — 지금까지의 addCycle 과 같다. */
  function addMonths(c, n) {
    var y = c.y, mo = c.m + n;
    while (mo > 12) { mo -= 12; y += 1; }
    while (mo <= 0) { mo += 12; y -= 1; }
    return { y: y, m: mo };
  }
  /** c 에서 n 칸(앞 +, 뒤 -) 옮긴 기간 c — 한 칸 = 한 기간(추가 기간 포함). 그 갈래에 없는 추가 기간이면 그 달에서 센다. */
  function step(kind, c, n) {
    n = Number(n) || 0;
    var o = cOf(c);
    if (!o) return c && typeof c === 'object' ? addMonths(c, n) : null;
    if (!START[kind] || !CUR.by[kind].length || n !== Math.floor(n)) return addMonths(o, n);
    var P = byKey(kind, o) || (o.x ? byKey(kind, { y: o.y, m: o.m }) : null);
    if (!P) return addMonths({ y: o.y, m: o.m }, n);
    for (var i = 0; i < Math.abs(n) && P; i++) P = n > 0 ? next(P) : prev(P);
    return P ? toC(P) : addMonths({ y: o.y, m: o.m }, n);
  }
  /** 오늘(now ms, 없으면 지금)이 든 기간 P. */
  function current(kind, now) { return periodOfMs(kind, now == null ? Date.now() : now); }
  /** P 가 끝난 뒤 며칠째인가 — 끝날 다음 날 = 1, 아직 안 끝났으면 0 이하(KST 날짜). */
  function daysPast(P, now) {
    var t = dnMs(now == null ? Date.now() : now);
    return P && t != null ? t - dnYmd(P.hi) : NaN;
  }
  /** 처음 열 때 보일 기간 — 오늘이 든 기간 바로 앞 기간이 끝난 지 1 ~ grace_days 일이면 그 기간, 아니면 오늘이 든 기간(앱 defaultPeriod 와 같다). */
  function defaultPeriod(kind, now) {
    var t = now == null ? Date.now() : now, cur = current(kind, t);
    if (!cur) return null;
    var p = prev(cur), past = p ? daysPast(p, t) : 0;
    return p && past >= 1 && past <= CUR.grace ? p : cur;
  }
  /** '09.21 – 10.20'(KST, 끝날 포함). */
  function span(P) { return P ? P.lo.slice(5).replace('-', '.') + ' – ' + P.hi.slice(5).replace('-', '.') : ''; }
  /** 그해 마지막 기간 P — 추가 기간이 있으면 그것(「작년 전체」의 끝). */
  function lastOfYear(kind, y) { return byKey(kind, y + '-12b') || byKey(kind, y + '-12'); }
  /** from ~ to('YYYY-MM-DD') 날을 품은 기간들(오래된 것부터) — 관리 화면·가짜 서버 미리보기용. */
  function periods(kind, from, to) {
    var a = dnYmd(from), b = dnYmd(to), out = [];
    if (a == null || b == null || !START[kind]) return out;
    for (var P = perN(kind, a); P && dnYmd(P.lo) <= b && out.length < 400; P = next(P)) out.push(P);
    return out;
  }

  /* ── 관리자 계획 → 정규화된 override(DB cycle_rules_plan · 서버 planToOverrides 와 같은 결과) ──
     계획(p_plan) = { driving|expense|card: null | { dec_hi?: 'YYYY-MM-DD', extra?: bool, jan_hi?: 'YYYY-MM-DD' } } — null·빠짐 = 그 갈래는 이 해 기본.
     범위: Y-12-10 ≤ dec ≤ Y-12-31 · (Y+1)-01-10 ≤ jan ≤ (Y+1)-01-31 · 추가 기간이면 dec ≤ Y-12-30. 추가 기간 끝은 Y-12-31 고정.
     기본과 범위가 다른 기간은 모두 적는다(12월분 · 추가 기간 · 1월분 · 1월분 끝을 옮긴 2월분). 틀리면 Error(code BAD_YEAR · BAD_PLAN · BAD_RANGE, details 쉬운 말). */
  function fail(code, details) { var e = new Error(code + (details ? ': ' + details : '')); e.code = code; e.details = details || ''; throw e; }
  function planToOverrides(Y, plan) {
    if (!isInt(Y) || Y < 2020 || Y > 2099) fail('BAD_YEAR', '해가 틀렸어요');
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('BAD_PLAN', '계획이 객체가 아니에요');
    Object.keys(plan).forEach(function (k) { if (!START[k]) fail('BAD_PLAN', '모르는 시스템 ' + k); });
    var out = [];
    KINDS.forEach(function (kind) {
      var p = plan[kind];
      if (p == null) return;
      if (typeof p !== 'object' || Array.isArray(p)) fail('BAD_PLAN', KIND_NAME[kind] + ' 계획이 객체가 아니에요');
      Object.keys(p).forEach(function (f) { if (['dec_hi', 'jan_hi', 'extra'].indexOf(f) < 0) fail('BAD_PLAN', KIND_NAME[kind] + ' 모르는 칸 ' + f); });
      if (p.extra != null && typeof p.extra !== 'boolean') fail('BAD_PLAN', KIND_NAME[kind] + ' extra는 참·거짓이어야 해요');
      var dn = function (f) {
        if (p[f] == null) return null;
        var n = dnYmd(p[f]);
        if (n == null) fail('BAD_PLAN', KIND_NAME[kind] + ' ' + f + ' 날짜 형식이 틀렸어요(YYYY-MM-DD)');
        return n;
      };
      var S12 = stdBN(kind, Y + '-12'), S01 = stdBN(kind, (Y + 1) + '-01'), S02 = stdBN(kind, (Y + 1) + '-02');
      var d0 = dn('dec_hi'), j0 = dn('jan_hi');
      var dec = d0 == null ? S12.hiN : d0, jan = j0 == null ? S01.hiN : j0, ex = p.extra === true;
      var d10 = dnOf(Y, 12, 10), d30 = dnOf(Y, 12, 30), d31 = dnOf(Y, 12, 31), j10 = dnOf(Y + 1, 1, 10), j31 = dnOf(Y + 1, 1, 31);
      if (dec < d10 || dec > d31) fail('BAD_RANGE', KIND_NAME[kind] + ' 12월분 끝은 ' + ymdOf(d10) + ' ~ ' + ymdOf(d31) + ' 사이여야 해요');
      if (jan < j10 || jan > j31) fail('BAD_RANGE', KIND_NAME[kind] + ' 1월분 끝은 ' + ymdOf(j10) + ' ~ ' + ymdOf(j31) + ' 사이여야 해요');
      if (ex && dec > d30) fail('BAD_RANGE', KIND_NAME[kind] + ' 12월분이 12월 31일까지면 추가 기간을 둘 수 없어요');
      var put = function (k, lo, hi) { out.push({ kind: kind, key: k, lo: ymdOf(lo), hi: ymdOf(hi), label: name(k) }); };
      if (dec !== S12.hiN) put(Y + '-12', S12.loN, dec);
      if (ex) put(Y + '-12b', dec + 1, d31);
      var janLo = ex ? dnOf(Y + 1, 1, 1) : dec + 1;
      if (janLo !== S01.loN || jan !== S01.hiN) put((Y + 1) + '-01', janLo, jan);
      if (jan + 1 !== S02.loN) put((Y + 1) + '-02', jan + 1, S02.hiN);
    });
    return out;
  }
  /** 규칙 raw 에 Y 해 계획을 넣은 새 규칙(서버 꼴) — 그 해 키(Y-12 · Y-12b · Y+1-01 · Y+1-02)의 있던 줄을 빼고 새 줄을 붙인다. 다른 해 줄은 그대로. */
  function applyPlan(rawRules, Y, plan) {
    var add = planToOverrides(Y, plan), mine = [Y + '-12', Y + '-12b', (Y + 1) + '-01', (Y + 1) + '-02'];
    var base = rawRules && typeof rawRules === 'object' && !Array.isArray(rawRules) ? rawRules : DEFAULT_RAW;
    var out = JSON.parse(JSON.stringify(base));
    out.overrides = (Array.isArray(out.overrides) ? out.overrides : []).filter(function (o) { return !(o && mine.indexOf(o.key) >= 0); }).concat(add);
    return out;
  }

  /* ── 검사(DB cycle_rules_problem 과 같은 기준 — 가짜 서버·시험용, 관리 화면은 서버 답을 쓴다) ── */
  function check(rawRules) {
    var o = rawRules;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { return 'JSON으로 읽지 못했어요'; } }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return '규칙이 객체가 아니에요';
    if (o.v !== 1) return 'v는 1이어야 해요';
    if (!isInt(o.grace_days) || o.grace_days < 0 || o.grace_days > GRACE_MAX) return 'grace_days는 0 ~ 28 정수여야 해요';
    for (var i = 0; i < KINDS.length; i++) {
      var s = o[KINDS[i]];
      if (s == null) continue;
      if (typeof s !== 'object' || Array.isArray(s)) return KIND_NAME[KINDS[i]] + ' 칸이 객체가 아니에요';
      if (s.start_day != null && s.start_day !== START[KINDS[i]]) return KIND_NAME[KINDS[i]] + ' 기본 시작일(' + START[KINDS[i]] + '일)은 바꿀 수 없어요';
    }
    if (o.overrides != null && !Array.isArray(o.overrides)) return 'overrides가 목록이 아니에요';
    var list = o.overrides || [], ovs = [];
    for (var j = 0; j < list.length; j++) {
      var x = list[j], at = (j + 1) + '번째 줄: ';
      if (!x || typeof x !== 'object' || Array.isArray(x)) return at + '객체가 아니에요';
      if (!START[x.kind]) return at + 'kind가 틀렸어요';
      if (typeof x.key !== 'string' || !/^[0-9]{4}-((0[1-9]|1[0-2])|12b)$/.test(x.key)) return at + '키 형식이 틀렸어요';
      var lo = dnYmd(x.lo), hi = dnYmd(x.hi);
      if (lo == null || hi == null) return at + '날짜가 틀렸어요(YYYY-MM-DD)';
      if (lo > hi) return at + '시작이 끝보다 늦어요';
      if (hi - lo > SPAN_MAX) return at + '기간이 92일을 넘어요';
      if (typeof x.label !== 'string' || x.label.length < 1 || x.label.length > 40) return at + '이름은 1 ~ 40자여야 해요';
      if (/b$/.test(x.key)) {
        var y = +x.key.slice(0, 4);
        if (lo < dnOf(y, 12, 1) || hi > dnOf(y, 12, 31)) return at + '추가 기간은 그해 12월 안이어야 해요';
      }
      ovs.push({ kind: x.kind, key: x.key, loN: lo, hiN: hi, lo: x.lo, hi: x.hi, label: x.label });
    }
    var R = mkRules(intOf(o.grace_days), ovs), keep = CUR;
    CUR = R;
    try {
      for (var a = 0; a < KINDS.length; a++) {
        var kind = KINDS[a], mine = R.by[kind];
        if (!mine.length) continue;
        for (var p = 0; p < mine.length; p++) {
          for (var q = p + 1; q < mine.length; q++) {
            if (mine[p].key === mine[q].key) return KIND_NAME[kind] + ' ' + mine[p].key + ' 기간이 두 번 있어요';
            if (!(mine[p].hiN < mine[q].loN || mine[q].hiN < mine[p].loN)) return KIND_NAME[kind] + ' ' + mine[p].key + '·' + mine[q].key + ' 범위가 겹쳐요';
          }
        }
        // 경계 일치 — override 앞 62일 ~ 뒤 62일: 모든 날이 자기 키의 범위 안 · 나온 키의 범위 안 모든 날이 그 키
        var lo0 = Infinity, hi0 = -Infinity, seen = {};
        mine.forEach(function (v) { lo0 = Math.min(lo0, v.loN); hi0 = Math.max(hi0, v.hiN); });
        for (var n = lo0 - 62; n <= hi0 + 62; n++) {
          var k = keyOfN(kind, n), b = boundsN(kind, k);
          if (!b || n < b.loN || n > b.hiN) return KIND_NAME[kind] + ' ' + ymdOf(n) + ' 날이 ' + k + ' 범위 밖이에요(주인 없는 날)';
          seen[k] = b;
        }
        var ks = Object.keys(seen);
        for (var t = 0; t < ks.length; t++) {
          for (var d = seen[ks[t]].loN; d <= seen[ks[t]].hiN; d++) {
            if (keyOfN(kind, d) !== ks[t]) return KIND_NAME[kind] + ' ' + ks[t] + ' 기간이 이어지지 않아요. ' + ymdOf(d) + ' 날이 ' + keyOfN(kind, d) + ' 기간이에요';
          }
        }
      }
    } finally { CUR = keep; }
    return null;
  }

  boot();

  return {
    DEFAULT_RAW: DEFAULT_RAW, KINDS: KINDS.slice(), STORE_KEY: STORE,
    boot: boot, set: set, raw: raw, graceDays: graceDays, under: under,
    isKey: isKey, parse: parse, key: key, name: name, short: short, ord: ord, prevMonthKey: prevMonthKey,
    periodOfDay: periodOfDay, periodOfMs: periodOfMs, byKey: byKey,
    next: next, prev: prev, step: step, current: current, defaultPeriod: defaultPeriod,
    daysPast: daysPast, span: span, lastOfYear: lastOfYear, periods: periods,
    planToOverrides: planToOverrides, applyPlan: applyPlan, check: check,
    stdKey: stdKey, stdBounds: stdBounds,
    kstYmd: function (ms) { var n = dnMs(ms); return n == null ? '' : ymdOf(n); },
    ymdStartMs: function (ymd) { var n = dnYmd(ymd); return n == null ? NaN : n * DAY - KST; }
  };
});
