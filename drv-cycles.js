/* ═══════════════════════════════════════════════════════════════════════════
   drv-cycles.js — 마감 기간 설정 (관리 › 사람·설정, 「권한 관리」 아래) — 2026-10-20 연말 마감
   ---------------------------------------------------------------------------
   · 세 결재 시스템(운행일지 21일~20일 · 개인경비 20일~19일 · 법인카드 1일~말일)마다 그해 **12월분 끝**,
     12월 말 **추가 기간**(「12월분 2차」 — 12월분 끝 다음 날 ~ 12.31), **1월분 끝**을 고른다.
     2월분 시작은 1월분 끝 다음 날이다(자동). 아무것도 정하지 않으면 늘 하던 대로다(2026-10-20 사용자 — 회귀 0 이 먼저).
   · 원천은 app_config.cycle_rules 하나. 이 화면은 서버 RPC set_cycle_overrides 로만 바꾼다 —
       칸을 바꿀 때마다(0.3초 늦춰) p_dry:true 미리 보기 → 「저장」 → 확인 창 → p_dry:false.
     바뀌는 기간 · 막힌 기간 · 옮겨 가는 날과 이미 올린 기록 수 · 기간 목록은 **서버 답 그대로** 그린다
     (웹이 기간을 따로 계산하지 않는다 — 어긋날 일이 없다). 표 안의 「12.20 – 12.31」·「01.21 자동」은 고른 날짜에 하루를 더한 것뿐이다.
   · 보이는 사람 = 「권한 관리」가 보이는 사람(마스터 · 권한 주는 관리자 — driving-account whoami 의 can_manage_admin).
     다른 관리자는 메뉴가 없고 주소로 와도 들어오지 못한다(driving-app.js go·applyHash). 서버(cycle_admin_ok)가 한 번 더 막는다.
   · 결재 중·결재 완료가 하나라도 있는 기간은 바꿀 수 없다(서버 지킴 트리거 — 미리 보기 blocked 로 먼저 보인다). 반려·회수만 있으면 바꿀 수 있다.
   · 이미 끝난 기간은 바꿀 수 없고, 끝날을 오늘(한국시간)보다 앞으로 정할 수도 없다(2026-10-21 사용자 「마감일을 이미 지난 날로 당기지 못하게」 —
     월간 리포트가 기간이 끝난 다음 날에만 나가서). 서버가 미리 보기·저장 모두 PAST_PERIOD 로 막고(details = {today, items} JSON) 이 화면이
     쉬운 말로 그린다. 날짜 칸 min = 오늘과 고를 수 있는 첫날 중 늦은 날(지난 날을 고르기 어렵게 — 최종 판정은 서버).
   · 저장하면 C.reloadRules(답.cycle_rules)(웹 기간 엔진 cycle-rules.js — 본체에 없으면 window.CycleRules.set) → C.loadAll() —
     직원 화면·포털 마감 일정이 바로 새 기간이다.
   · 바꾼 기록 = cycle_rules_log 최근 20줄(언제 · 누가 · 바뀐 기간 전후 · 사유).
   · 고칠 수 있는 해 = 올해(한국시간) 앞뒤 1년(서버와 같다). 처음 고르는 해 = 1·2월이면 지난해(그 연말이 아직 진행 중), 아니면 올해.
   ═══════════════════════════════════════════════════════════════════════════ */
(window.DrvExtQ = window.DrvExtQ || []).push(function (C) {
  'use strict';
  var $ = C.$, esc = C.esc, n0 = C.n0;
  var KINDS = ['driving', 'expense', 'card'];
  // 기본 시작일(21·20·1)은 바꿀 수 없다 — 바꾸면 지난 결재의 기간이 통째로 움직인다(서버 검사도 같다).
  var SYS = {
    driving: { name: '운행일지', base: '21일 ~ 20일', start: 21 },
    expense: { name: '개인경비', base: '20일 ~ 19일', start: 20 },
    card: { name: '법인카드', base: '1일 ~ 말일', start: 1 }
  };

  /* ══════════════════ 날짜(한국시간 달력 날짜 'YYYY-MM-DD') ══════════════════ */
  var DAY = 864e5;
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dn(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY; }
  function ds(n) { var d = new Date(n * DAY); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && ds(dn(s)) === s; }
  function addD(s, k) { return ds(dn(s) + k); }
  function md(s) { return isYmd(s) ? s.slice(5, 7) + '.' + s.slice(8, 10) : ''; }
  function span(lo, hi) { return md(lo) + ' – ' + md(hi); }
  function kstNow() { return new Date(Date.now() + 9 * 3600e3); }
  function thisYear() { return kstNow().getUTCFullYear(); }
  /** 오늘(한국시간) 'YYYY-MM-DD'. */
  function todayK() { var d = kstNow(); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  /** 날짜 칸 min — 오늘과 고를 수 있는 첫날(lo) 중 늦은 날. 끝날을 이미 지난 날로 정하지 못하게(2026-10-21 — 서버 PAST_PERIOD 가 최종 판정). */
  function minOf(lo) { var t = todayK(); return t > lo ? t : lo; }
  /** 처음 고르는 해 — 1·2월이면 지난해(그 연말의 1월분·2월분이 아직 진행 중), 아니면 올해. */
  function defYear() { var d = kstNow(); return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }
  /** 고칠 수 있는 해 — 올해 앞뒤 1년(서버 BAD_YEAR 와 같다). */
  function years() { var y = thisYear(); return [y - 1, y, y + 1]; }
  /** 한국시간 'MM.DD HH:MM'(올해가 아니면 'YYYY.MM.DD HH:MM'). */
  function when(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var d = new Date(t + 9 * 3600e3);
    return (d.getUTCFullYear() !== thisYear() ? d.getUTCFullYear() + '.' : '') + pad(d.getUTCMonth() + 1) + '.' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }

  /* ══════════════════ 기간 이름 · 기본값 · 고를 수 있는 범위 ══════════════════ */
  /** '2026-12' → '12월분', '2026-12b' → '12월분 2차'(DB cycle_label 의 짧은 꼴). */
  function keyShort(k) {
    var m = /^(\d{4})-(\d{2})(b?)$/.exec(String(k || ''));
    return m ? +m[2] + '월분' + (m[3] ? ' 2차' : '') : String(k || '');
  }
  /** 받침에 맞는 「로/으로」(ㄹ 받침은 「로」). */
  function ro(w) {
    var s = String(w || ''), c = s.charCodeAt(s.length - 1);
    if (c >= 0xAC00 && c <= 0xD7A3) { var j = (c - 0xAC00) % 28; return j === 0 || j === 8 ? '로' : '으로'; }
    return '(으)로';
  }
  function stdDec(k, Y) { return SYS[k].start === 1 ? Y + '-12-31' : Y + '-12-' + pad(SYS[k].start - 1); }
  function stdJan(k, Y) { return SYS[k].start === 1 ? (Y + 1) + '-01-31' : (Y + 1) + '-01-' + pad(SYS[k].start - 1); }
  /** 고를 수 있는 날(서버 BAD_RANGE 와 같다 — 설계서 §7 ④): 12월분 끝 12.10~12.31(추가 기간을 두면 12.30 까지) · 1월분 끝 01.10~01.31. */
  function lim(Y) { return { d0: Y + '-12-10', d1: Y + '-12-31', dx: Y + '-12-30', j0: (Y + 1) + '-01-10', j1: (Y + 1) + '-01-31' }; }

  /* ══════════════════ 저장된 규칙 ↔ 화면 칸 ══════════════════ */
  function ovs(r) { return r && Array.isArray(r.overrides) ? r.overrides : []; }
  function findOv(r, k, key) { return ovs(r).filter(function (o) { return o && o.kind === k && o.key === key; })[0] || null; }
  /** 저장된 규칙에서 그해 칸 값 — 12월분 끝 · 추가 기간 · 1월분 끝(override 가 없으면 기본). */
  function formOf(r, Y) {
    var f = {};
    KINDS.forEach(function (k) {
      var o12 = findOv(r, k, Y + '-12'), ob = findOv(r, k, Y + '-12b'), o1 = findOv(r, k, (Y + 1) + '-01');
      f[k] = { dec: o12 && isYmd(o12.hi) ? o12.hi : stdDec(k, Y), extra: !!ob, jan: o1 && isYmd(o1.hi) ? o1.hi : stdJan(k, Y) };
    });
    return f;
  }
  /** 그해(12월분·추가 기간·1월분·2월분)에 정해 둔 것이 있는가. */
  function yearSet(r, Y) {
    var keys = [Y + '-12', Y + '-12b', (Y + 1) + '-01', (Y + 1) + '-02'];
    return ovs(r).some(function (o) { return o && keys.indexOf(o.key) >= 0; });
  }
  function isStd(k, Y, v) { return v.dec === stdDec(k, Y) && v.jan === stdJan(k, Y) && !v.extra; }
  /** 서버에 보낼 계획 — 기본과 같은 시스템은 null(그해 설정을 지운다). 화면은 늘 세 시스템을 다 보낸다. */
  function planOf(f, Y) {
    var p = {};
    KINDS.forEach(function (k) { var v = f[k]; p[k] = isStd(k, Y, v) ? null : { dec_hi: v.dec, extra: !!v.extra, jan_hi: v.jan }; });
    return p;
  }
  function sig(f, Y) { return Y + '|' + JSON.stringify(planOf(f, Y)); }
  /** 칸 값 문제(서버에 묻기 전에 바로 보인다 — 범위는 서버와 같다). */
  function probs(f, Y) {
    var L = lim(Y), out = { any: false };
    KINDS.forEach(function (k) {
      var v = f[k], e = { dec: '', jan: '' };
      if (!isYmd(v.dec)) e.dec = '날짜를 골라 주세요.';
      else if (v.dec < L.d0 || v.dec > L.d1) e.dec = '12.10 ~ 12.31 사이로 골라 주세요.';
      if (!isYmd(v.jan)) e.jan = '날짜를 골라 주세요.';
      else if (v.jan < L.j0 || v.jan > L.j1) e.jan = '01.10 ~ 01.31 사이로 골라 주세요.';
      if (e.dec || e.jan) out.any = true;
      out[k] = e;
    });
    return out;
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /* ══════════════════ 상태 ══════════════════ */
  var ST = {
    year: 0,
    rules: undefined,            // 서버의 지금 cycle_rules — undefined 아직 · null 못 읽음
    rulesErr: '', noCol: false,
    saved: null, form: null,     // 저장된 값 · 화면 칸 값({driving:{dec,extra,jan}, …})
    note: '',
    dry: null, dryKey: '', dryErr: '', dryAt: 0, dryBusy: false, dryWait: false, drySeq: 0, dryT: 0, dryP: null, dryPKey: '',
    log: undefined, logErr: '',  // 바꾼 기록 — undefined 아직 · null 못 읽음
    saving: false, saveErr: '', cfKey: '', booting: false, hint: {}
  };

  /* ══════════════════ 서버 ══════════════════ */
  /** set_cycle_overrides — 오류는 PostgREST 400 { code:'P0001', message:'CYCLE_LOCKED' 등, details: 쉬운 말 }.
   *  PAST_PERIOD(2026-10-21)만 details 가 기계가 읽는 JSON 글자 {today, items}, hint 가 서버의 한국어 한 줄이다. */
  function rpc(body) {
    return C.apiRetry('/rest/v1/rpc/set_cycle_overrides', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (r.ok) return j && typeof j === 'object' ? j : {};
        var er = new Error(String((j && (j.message || j.error)) || ('HTTP ' + r.status)));
        er.code = j && typeof j.message === 'string' ? j.message : '';
        er.details = j && typeof j.details === 'string' ? j.details : '';
        er.hint = j && typeof j.hint === 'string' ? j.hint : '';
        er.pg = j && j.code; er.status = r.status;
        throw er;
      });
    });
  }
  function noDot(s) { return String(s || '').trim().replace(/[.。]+$/, ''); }
  /** 서버 오류 → 쉬운 말(설계서 §4-8). */
  function errText(e, head) {
    var c = String((e && e.code) || ''), d = noDot(e && e.details), st = e && e.status;
    if (st === 401) return '로그인이 만료됐어요. 다시 로그인해 주세요.';
    if (c === 'NOT_ALLOWED' || st === 403) return '마감 기간 설정은 권한 관리를 맡은 관리자만 바꿀 수 있어요.';
    if (c === 'CYCLE_LOCKED') return '결재 중이거나 결재가 끝난 기간은 바꿀 수 없어요.' + (d ? ' ' + d + '.' : '') + ' 그 건을 회수하거나 반려한 뒤 다시 해 주세요.';
    if (c === 'PAST_PERIOD') return pastText(e.details, e.hint);
    if (c === 'CARD_LOCKED') return '결재 중이거나 결재가 끝난 법인카드 줄이 다른 기간으로 옮겨 가야 해서 저장하지 못했어요. 그 건을 회수하거나 반려한 뒤 다시 해 주세요.';
    if (c === 'BAD_RANGE') return (d || '고를 수 있는 날짜 밖이에요') + '.';
    if (c === 'BAD_YEAR') return '마감 기간은 올해 앞뒤 1년만 바꿀 수 있어요.';
    if (c === 'RULES_INVALID') return '기간이 서로 맞지 않아 저장하지 못했어요' + (d ? '. ' + d : '') + '.';
    if (st === 404 || e && e.pg === 'PGRST202') return '서버에 아직 마감 기간 설정이 없어요. 서버 준비가 끝난 뒤 다시 해 주세요.';
    return (head ? head + '. ' : '') + '잠시 후 다시 해 주세요.';
  }
  /** PAST_PERIOD(2026-10-21 — 이미 끝난 기간·지난 끝날) → 쉬운 말.
   *  details = {"today":"YYYY-MM-DD","items":[{kind,key,old_hi,hi,why:'ended'|'past'}]} JSON 글자(서버 cycle_past_violations).
   *  읽지 못하면 서버 hint(한국어 한 줄), 그것도 없으면 한 줄로 뭉뚱그린다. */
  function pastText(details, hint) {
    var j = null;
    try { j = details ? JSON.parse(details) : null; } catch (er) { j = null; }
    var it = j && Array.isArray(j.items) ? j.items.filter(function (x) { return x && SYS[x.kind] && x.key; }) : [];
    if (!it.length) return noDot(hint) ? noDot(hint) + '.' : '이미 끝난 기간은 바꿀 수 없고, 끝날을 오늘보다 앞으로 정할 수도 없어요.';
    var t = isYmd(j.today) ? md(j.today) : '';
    var nm = function (x) { return SYS[x.kind].name + ' ' + keyShort(x.key); };
    var ended = it.filter(function (x) { return x.why === 'ended'; }), past = it.filter(function (x) { return x.why !== 'ended'; });
    var s = [];
    // 기간 이름 뒤에 바로 조사를 붙이지 않는다(「12월분」·「12월분 2차」 받침이 달라 은/는이 갈린다) — 「… 기간은」·「… 대신」으로 받는다
    if (ended.length) {
      s.push((t ? '오늘(' + t + ') 기준으로 ' : '') + '이미 끝난 기간은 바꿀 수 없어요. ' +
        ended.map(function (x) { return nm(x) + (isYmd(x.old_hi) ? '(' + md(x.old_hi) + ' 마감)' : ''); }).join(', ') + ' 기간은 저장된 그대로 두세요.');
    }
    if (past.length) {
      s.push('끝날을 오늘' + (t ? '(' + t + ')' : '') + '보다 앞으로 정할 수 없어요. ' +
        past.map(function (x) { return nm(x) + ' 끝날' + (isYmd(x.hi) ? '(' + md(x.hi) + ')' : ''); }).join(', ') + '은 오늘이나 그 뒤 날짜로 다시 골라 주세요.');
    }
    return s.join(' ');
  }
  function loadRules() {
    return C.apiRetry('/rest/v1/app_config?id=eq.1&select=*').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (rows) {
      var row = rows && rows[0];
      if (!row) throw new Error('no row');
      var cr = row.cycle_rules;
      if (typeof cr === 'string') { try { cr = JSON.parse(cr); } catch (e) { cr = null; } }
      ST.noCol = !Object.prototype.hasOwnProperty.call(row, 'cycle_rules');
      ST.rules = cr && typeof cr === 'object' ? cr : { overrides: [] };
      ST.rulesErr = '';
    }).catch(function () { ST.rules = null; ST.rulesErr = '마감 기간 설정을 불러오지 못했어요.'; });
  }
  function loadLog() {
    return C.apiRetry('/rest/v1/cycle_rules_log?select=id,at,actor,via,year,note,changed,restamped&order=at.desc&limit=20').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (rows) { ST.log = Array.isArray(rows) ? rows : []; ST.logErr = ''; })
      .catch(function () { ST.log = null; ST.logErr = '바꾼 기록을 불러오지 못했어요.'; });
  }
  function boot() {
    if (ST.booting) return;
    ST.booting = true;
    Promise.all([loadRules(), loadLog()]).then(function () {
      ST.booting = false;
      if (!ST.year) ST.year = defYear();
      if (ST.rules) resetForm();
      C.render();
      if (ST.rules) dry(true);
    });
  }
  function resetForm() {
    ST.saved = formOf(ST.rules, ST.year);
    ST.form = clone(ST.saved);
    ST.saveErr = ''; ST.hint = {};
  }
  /** 웹 기간 엔진에 새 규칙을 알린다 — 본체 길(C.reloadRules: 보던 기간 맞추기까지)이 있으면 그것, 없으면 엔진에 바로. 엔진이 없는 판이면 아무 일도 없다. */
  function apply(raw) {
    try {
      if (typeof C.reloadRules === 'function') { C.reloadRules(raw); return; }
      if (window.CycleRules && typeof window.CycleRules.set === 'function') window.CycleRules.set(raw);
    } catch (e) { }
  }

  /* ══════════════════ 미리 보기(p_dry:true) ══════════════════ */
  /** 지금 칸 값에 맞는 미리 보기 답(없거나 옛 값의 답이면 null). */
  function curDry() { return ST.dry && ST.form && ST.dryKey === sig(ST.form, ST.year) ? ST.dry : null; }
  /** 서버에 미리 보기를 묻는다. force 가 아니면 같은 값의 답·묻는 중인 것을 그대로 쓴다. 지금 칸 값의 답(또는 null)으로 끝난다. */
  function dry(force) {
    clearTimeout(ST.dryT); ST.dryWait = false;
    if (!ST.form || !ST.rules) return Promise.resolve(null);
    var Y = ST.year, key = sig(ST.form, Y);
    if (probs(ST.form, Y).any) { ++ST.drySeq; ST.dryBusy = false; ST.dryErr = ''; paint(); return Promise.resolve(null); }
    if (!force && ST.dry && ST.dryKey === key && !ST.dryErr) { paint(); return Promise.resolve(ST.dry); }
    if (!force && ST.dryBusy && ST.dryP && ST.dryPKey === key) return ST.dryP;
    var seq = ++ST.drySeq;
    ST.dryBusy = true; ST.dryPKey = key; ST.dryErr = '';
    paint();
    ST.dryP = rpc({ p_year: Y, p_plan: planOf(ST.form, Y), p_note: null, p_dry: true }).then(function (j) {
      if (seq !== ST.drySeq) return null;
      ST.dryBusy = false; ST.dry = j; ST.dryKey = key; ST.dryAt = Date.now();
      paint();
      return j;
    }, function (e) {
      if (seq !== ST.drySeq) return null;
      ST.dryBusy = false; ST.dryErr = errText(e, '미리 보기를 불러오지 못했어요');
      paint();
      return null;
    });
    return ST.dryP;
  }
  /** 칸을 바꿀 때마다 — 0.3초 늦춰 묻는다(날짜를 키보드로 칠 때 글자마다 묻지 않게). */
  function later() {
    clearTimeout(ST.dryT);
    ST.dryWait = true; ST.saveErr = '';
    paint();
    ST.dryT = setTimeout(function () { dry(false); }, 300);
  }
  /** 저장 직전 — 지금 칸 값의 미리 보기를 꼭 받는다(늦춰 둔 것은 바로 묻고, 묻는 중이면 기다린다). */
  function fresh(n) {
    return dry(false).then(function (d) {
      if (d && ST.dryKey === sig(ST.form, ST.year)) return d;
      if ((n || 0) >= 2 || ST.dryErr || probs(ST.form, ST.year).any) return null;
      return fresh((n || 0) + 1);
    });
  }

  /* ══════════════════ 그리기 조각 ══════════════════ */
  function chip(kind, t) { return '<span class="cys-chip' + (kind ? ' ' + kind : '') + '">' + esc(t) + '</span>'; }
  function dirtyK(k) { return !!(ST.form && ST.saved) && JSON.stringify(ST.form[k]) !== JSON.stringify(ST.saved[k]); }
  function isDirty() { return KINDS.some(dirtyK); }
  function blParts(b) {
    var p = [];
    if (+b.submitted) p.push('결재 중 ' + n0(b.submitted) + '건');
    if (+b.approved) p.push('결재 완료 ' + n0(b.approved) + '건');
    return p.join(' · ') || '결재 중';
  }
  /** CYCLE_LOCKED 와 같은 말 — 서버가 미리 보기 blocked 로 알려 준 기간들. */
  function lockedText(bl) {
    return '결재 중이거나 결재가 끝난 기간은 바꿀 수 없어요. ' + bl.map(function (b) {
      return (SYS[b.kind] ? SYS[b.kind].name + ' ' : '') + keyShort(b.key) + ': ' + blParts(b);
    }).join(', ') + '. 그 건을 회수하거나 반려한 뒤 다시 해 주세요.';
  }
  /** 옮겨 가는 날의 이미 올린 기록 — [이름, 수, 단위]. 서버 칸 이름이 조금 달라도 읽는다(운행일지 trips·evidences, 개인경비·법인카드 items). */
  function recParts(k, m) {
    var p = [], num = function (v) { return +v || 0; };
    if (k === 'driving') {
      if (num(m.trips)) p.push(['운행', num(m.trips), '건']);
      if (num(m.evidences)) p.push(['영수증', num(m.evidences), '장']);
    } else if (k === 'expense') {
      var x = num(m.items != null ? m.items : m.expense_items != null ? m.expense_items : m.count);
      if (x) p.push(['경비', x, '건']);
    } else {
      var y = num(m.items != null ? m.items : m.card_items != null ? m.card_items : m.count);
      if (y) p.push(['카드', y, '줄']);
    }
    return p;
  }
  function recTotal(k, m) { return recParts(k, m).reduce(function (s, p) { return s + p[1]; }, 0); }
  function chgText(c) {
    var nm = keyShort(c.key), a = isYmd(c.old_lo) && isYmd(c.old_hi) ? span(c.old_lo, c.old_hi) : '', b = isYmd(c.lo) && isYmd(c.hi) ? span(c.lo, c.hi) : '';
    if (!a && b) return nm + ' 새로 ' + b;
    if (a && !b) return nm + ' 없앰(' + a + ')';
    return nm + ' ' + a + ' → ' + b;
  }

  /* ── 표 한 줄(시스템) — 칸에서 바로 나오는 글(하루 더하기)만 ── */
  function extraSub(k) {
    var Y = ST.year, v = ST.form[k];
    if (!isYmd(v.dec)) return '';
    if (v.dec === lim(Y).d1) return '12월분이 12.31까지라 2차를 둘 수 없어요.';
    var r = span(addD(v.dec, 1), Y + '-12-31');
    return v.extra ? '12월분 2차 ' + r : '두면 ' + r;
  }
  function janSub(k) {
    var Y = ST.year, v = ST.form[k];
    if (!isYmd(v.dec) || !isYmd(v.jan)) return '';
    return '1월분 ' + span(v.extra ? (Y + 1) + '-01-01' : addD(v.dec, 1), v.jan);
  }
  function febHtml(k) {
    var v = ST.form[k];
    return isYmd(v.jan) ? '<b class="cys-feb">' + md(addD(v.jan, 1)) + '</b><span class="cys-sub">자동</span>' : '<span class="cys-sub">—</span>';
  }
  function statHtml(k) {
    var P = probs(ST.form, ST.year);
    if (P[k].dec || P[k].jan) return chip('warn', '날짜 확인');
    var d = curDry(), bl = d && Array.isArray(d.blocked) ? d.blocked.filter(function (b) { return b && b.kind === k; }) : [];
    if (bl.length) return chip('bad', '바꿀 수 없음') + '<span class="cys-sub">' + esc(bl.map(function (b) { return keyShort(b.key) + ' ' + blParts(b); }).join(' · ')) + '</span>';
    if (dirtyK(k)) return chip('warn', '저장 전');
    if (!isStd(k, ST.year, ST.saved[k])) return chip('ok', '정해 둠');
    return chip('', '늘 하던 대로');
  }
  /** 한 줄에서 칸 값에 따라 바뀌는 조각(처음 그릴 때와 칸을 바꿀 때 같은 것을 쓴다). 키 = 요소 id 가운데 글자. */
  function rowParts(k) {
    var Y = ST.year, v = ST.form[k], P = probs(ST.form, Y)[k];
    return {
      Db: v.dec === stdDec(k, Y) ? chip('', '기본') : '', Jb: v.jan === stdJan(k, Y) ? chip('', '기본') : '',
      Xt: v.extra ? '둔다' : '두지 않음', Xs: esc(ST.hint[k] || extraSub(k)), Js: esc(janSub(k)),
      De: esc(P.dec), Je: esc(P.jan), F: febHtml(k), S: statHtml(k)
    };
  }
  function rowHtml(k) {
    var Y = ST.year, v = ST.form[k], L = lim(Y), s = SYS[k], p = rowParts(k), P = probs(ST.form, Y)[k];
    var dIn = function (f, min, max, label, bad) {
      return '<span class="cys-dt"><input type="date" class="inp cys-in" id="cys' + f + '-' + k + '" data-cysf="' + f + '" data-k="' + k + '" min="' + min + '" max="' + max +
        '" value="' + esc(v[f === 'D' ? 'dec' : 'jan']) + '" aria-label="' + esc(s.name + ' ' + label) + '" aria-describedby="cys' + f + 'e-' + k + '" aria-invalid="' + (bad ? 'true' : 'false') + '">' +
        '<span class="cys-std" id="cys' + f + 'b-' + k + '">' + p[f + 'b'] + '</span></span>';
    };
    return '<tr data-k="' + k + '">' +
      '<th scope="row" class="cys-sys"><b>' + esc(s.name) + '</b><span>기본 ' + esc(s.base) + '</span></th>' +
      '<td data-l="12월분 끝"><div class="cys-v">' + dIn('D', minOf(L.d0), v.extra ? L.dx : L.d1, '12월분 끝', P.dec) +
        '<span class="cys-err" id="cysDe-' + k + '">' + p.De + '</span></div></td>' +
      '<td data-l="12월 추가 기간"><div class="cys-v"><label class="cys-tg"><input type="checkbox" role="switch" id="cysX-' + k + '" data-cysf="X" data-k="' + k + '"' +
        (v.extra ? ' checked' : '') + (v.dec === L.d1 || ST.saving ? ' disabled' : '') + ' aria-label="' + esc(s.name + ' 12월 추가 기간(12월분 2차) 두기') + '" aria-describedby="cysXs-' + k + '">' +
        '<span class="cys-sw" aria-hidden="true"></span><span class="cys-tgt" id="cysXt-' + k + '" aria-hidden="true">' + p.Xt + '</span></label>' +
        '<span class="cys-sub" id="cysXs-' + k + '">' + p.Xs + '</span></div></td>' +
      '<td data-l="1월분 끝"><div class="cys-v">' + dIn('J', minOf(L.j0), L.j1, '1월분 끝', P.jan) +
        '<span class="cys-sub" id="cysJs-' + k + '">' + p.Js + '</span><span class="cys-err" id="cysJe-' + k + '">' + p.Je + '</span></div></td>' +
      '<td data-l="2월분 시작"><div class="cys-v" id="cysF-' + k + '">' + p.F + '</div></td>' +
      '<td data-l="상태" class="cys-stc"><div class="cys-v" id="cysS-' + k + '">' + p.S + '</div></td></tr>';
  }
  /** 표 한 줄의 바뀌는 조각만 다시 쓴다(입력 칸은 그대로 — 치던 자리를 잃지 않게). */
  function paintRow(k) {
    var Y = ST.year, v = ST.form[k], L = lim(Y), P = probs(ST.form, Y)[k], p = rowParts(k);
    var di = $('cysD-' + k), xi = $('cysX-' + k), ji = $('cysJ-' + k);
    if (!di) return;
    di.max = v.extra ? L.dx : L.d1;
    // 오늘보다 앞 날은 고르기 어렵게(창을 연 채 날이 바뀌어도 따라간다 — 최종 판정은 서버 PAST_PERIOD)
    di.min = minOf(L.d0);
    if (ji) ji.min = minOf(L.j0);
    if (di.value !== v.dec && document.activeElement !== di) di.value = v.dec;
    if (ji && ji.value !== v.jan && document.activeElement !== ji) ji.value = v.jan;
    if (xi) { xi.checked = !!v.extra; xi.disabled = v.dec === L.d1 || ST.saving; }
    Object.keys(p).forEach(function (id) { var e = $('cys' + id + '-' + k); if (e && e.innerHTML !== p[id]) e.innerHTML = p[id]; });
    di.setAttribute('aria-invalid', P.dec ? 'true' : 'false');
    if (ji) ji.setAttribute('aria-invalid', P.jan ? 'true' : 'false');
  }

  /* ── 미리 보기(서버 답 그대로) ── */
  function prevKind(k, d) {
    var per = d.periods && Array.isArray(d.periods[k]) ? d.periods[k] : [];
    var ch = (d.changed || []).filter(function (c) { return c && c.kind === k; });
    var mv = (d.moved || []).filter(function (m) { return m && m.kind === k; });
    var bl = (d.blocked || []).filter(function (b) { return b && b.kind === k; });
    var chk = {}, blk = {};
    ch.forEach(function (c) { chk[c.key] = c; });
    bl.forEach(function (b) { blk[b.key] = b; });
    var head = bl.length ? chip('bad', '바꿀 수 없음') : ch.length ? chip('warn', '바뀜 ' + n0(ch.length) + '곳') : chip('', '그대로');
    var pills = per.map(function (p) {
      var c = chk[p.key], b = blk[p.key], isNew = c && !isYmd(c.old_lo);
      var nm = String(p.label || '').replace(/^\d{4}년\s*/, '') || keyShort(p.key);
      return '<li class="cys-p' + (c ? ' chg' : '') + (b ? ' blk' : '') + '" data-key="' + esc(p.key) + '"><b>' + esc(nm) + '</b><span>' + esc(span(p.lo, p.hi)) + '</span>' +
        (b ? '<em class="bad">' + esc(blParts(b)) + '</em>' : c ? '<em>' + (isNew ? '새 기간' : '바뀜') + '</em>' : '') + '</li>';
    }).join('');
    var gone = ch.filter(function (c) { return !isYmd(c.lo); });
    var h = '<div class="cys-pk" data-k="' + k + '"><div class="cys-pkh"><b>' + esc(SYS[k].name) + '</b>' + head + '</div><div class="cys-pkb">' +
      (pills ? '<ol class="cys-pl" aria-label="' + esc(SYS[k].name) + ' 기간">' + pills + '</ol>' : '') +
      (gone.length ? '<p class="cys-gone">' + esc(gone.map(chgText).join(' · ')) + '</p>' : '');
    if (mv.length) {
      h += '<table class="cys-mv"><caption class="sr">' + esc(SYS[k].name) + '에서 다른 기간으로 옮겨 가는 날</caption><thead><tr>' +
        '<th scope="col">옮겨 가는 날</th><th scope="col">지금</th><th scope="col">바꾼 뒤</th><th scope="col" class="n">이미 올린 기록(건)</th></tr></thead><tbody>' +
        mv.map(function (m) {
          var parts = recParts(k, m);
          return '<tr><td class="cys-mvd">' + esc(m.lo === m.hi ? md(m.lo) : span(m.lo, m.hi)) + '</td><td class="cys-mvf">' + esc(keyShort(m.from)) + '</td>' +
            '<td class="cys-mvt">' + esc(keyShort(m.to)) + '</td><td class="n"><b>' + n0(recTotal(k, m)) + '</b>' +
            (parts.length ? '<small>' + esc(parts.map(function (p) { return p[0] + ' ' + n0(p[1]); }).join(' · ')) + '</small>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    return h + '</div></div>';
  }
  function prevHtml() {
    if (!ST.form) return '';
    if (probs(ST.form, ST.year).any) return '<p class="cys-msg warn">고칠 칸이 있어요. 표에 적힌 날짜 범위로 골라 주세요.</p>';
    if (ST.dryErr && !ST.dryBusy) return '<p class="cys-msg bad">' + esc(ST.dryErr) + '</p><button type="button" class="btn" data-cysretry>다시 미리 보기</button>';
    var d = curDry(), show = d || ST.dry;
    if (!show) return '<p class="cys-wait">미리 보기를 불러오는 중…</p>';
    return '<div class="cys-prev' + (d ? '' : ' stale') + '"' + (d ? '' : ' aria-busy="true"') + '>' +
      (d ? '' : '<p class="cys-wait">고친 값으로 다시 계산하는 중…</p>') +
      KINDS.map(function (k) { return prevKind(k, show); }).join('') + '</div>';
  }
  /** 저장 줄의 글·단추 상태(처음 그릴 때와 다시 칠할 때 같은 것). */
  function barState() {
    var Y = ST.year, P = probs(ST.form, Y), d = curDry(), dirty = isDirty();
    var bl = d && Array.isArray(d.blocked) ? d.blocked : [], chN = d && Array.isArray(d.changed) ? d.changed.length : 0;
    var t = '', cls = '';
    if (ST.saving) t = '저장하는 중…';
    else if (ST.saveErr) { t = ST.saveErr; cls = 'bad'; }
    else if (P.any) { t = '고칠 칸이 있어요.'; cls = 'warn'; }
    else if (ST.dryErr && !ST.dryBusy) { t = ST.dryErr; cls = 'bad'; }
    else if (bl.length) { t = lockedText(bl); cls = 'bad'; }
    else if (!d) t = dirty ? '미리 보기를 불러오는 중…' : '';
    else if (!chN) t = '바꾼 것이 없어요. 날짜를 고르면 미리 보기가 바로 바뀌어요.';   // 이 글은 미리 보기 아래에 있다(2026-10-20 V3 다듬기 — 「아래」라 했다)
    else if (!dirty) { t = '저장된 설정이 이 화면과 조금 달라요. 저장하면 미리 보기처럼 맞춰져요.'; cls = 'warn'; }
    else t = '저장하면 직원 화면·포털 마감 일정이 바로 바뀌어요.';
    return {
      t: t, cls: cls,
      save: !(ST.saving || P.any || (ST.dryErr && !ST.dryBusy) || bl.length > 0 || (d ? !chN : !dirty)),
      def: !(ST.saving || KINDS.every(function (k) { return isStd(k, Y, ST.form[k]); })),
      at: d && ST.dryAt ? when(new Date(ST.dryAt).toISOString()).replace(/^.* /, '') + ' 서버 계산' : '서버 계산'
    };
  }
  function paintBar() {
    var sv = $('cysSave'), df = $('cysDef'), m = $('cysMsg'), at = $('cysAt');
    if (!sv || !ST.form) return;
    var b = barState();
    sv.disabled = !b.save; df.disabled = !b.def;
    if (m.textContent !== b.t) m.textContent = b.t;
    m.className = 'cys-msg' + (b.cls ? ' ' + b.cls : '');
    if (at && at.textContent !== b.at) at.textContent = b.at;
  }
  function paint() {
    if (!$('cys') || !ST.form) return;
    KINDS.forEach(paintRow);
    var pv = $('cysPrev');
    if (pv) { var h = prevHtml(); if (pv.__h !== h) { pv.innerHTML = h; pv.__h = h; } }
    paintBar();
  }

  /* ── 바꾼 기록 ── */
  function logHtml() {
    if (ST.log === undefined) return '<p class="cys-wait">불러오는 중…</p>';
    if (ST.log === null) return '<p class="cys-none">' + esc(ST.logErr) + '</p>';
    if (!ST.log.length) return '<p class="cys-none">아직 바꾼 기록이 없어요.</p>';
    return '<table class="cys-lg"><thead><tr><th scope="col">언제</th><th scope="col">누가</th><th scope="col">바꾼 것</th><th scope="col">사유</th></tr></thead><tbody>' +
      ST.log.map(function (r) {
        var ch = r.changed;
        if (typeof ch === 'string') { try { ch = JSON.parse(ch); } catch (e) { ch = []; } }
        ch = Array.isArray(ch) ? ch : [];
        var by = {};
        ch.forEach(function (c) { if (c && SYS[c.kind]) (by[c.kind] = by[c.kind] || []).push(chgText(c)); });
        var lines = KINDS.filter(function (k) { return by[k]; }).map(function (k) {
          return '<li><b>' + esc(SYS[k].name) + '</b> ' + esc(by[k].join(' · ')) + '</li>';
        });
        if (+r.restamped) lines.push('<li>법인카드 ' + n0(r.restamped) + '줄을 새 기간으로 옮김</li>');
        var actor = String(r.actor || ''), sql = r.via === 'sql' || /^sql:/.test(actor);
        var who = sql ? 'SQL로 직접' + (/^sql:/.test(actor) ? ' (' + actor.slice(4) + ')' : actor ? ' (' + C.nameOf(actor) + ')' : '') : C.nameOf(actor);
        return '<tr><td class="cys-when">' + esc(when(r.at)) + (r.year ? '<span class="cys-sub">' + esc(r.year + '년 연말') + '</span>' : '') + '</td>' +
          '<td class="cys-who">' + esc(who) + '</td>' +
          '<td class="cys-what">' + (lines.length ? '<ul class="cys-chl">' + lines.join('') + '</ul>' : '<span class="cys-sub">바뀐 기간 없음</span>') + '</td>' +
          '<td class="cys-why">' + (r.note ? esc(r.note) : '<span class="cys-sub">—</span>') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function paintLog() { var e = $('cysLog'); if (e) e.innerHTML = logHtml(); }

  /* ══════════════════ 화면 ══════════════════ */
  function headHtml(withYear) {
    var sel = '';
    if (withYear) {
      sel = '<label class="cys-yr" for="cysYear"><span>고칠 해</span><select id="cysYear">' + years().map(function (y) {
        return '<option value="' + y + '"' + (y === ST.year ? ' selected' : '') + '>' + y + '년 연말' + (yearSet(ST.rules, y) ? ' · 정해 둠' : '') + '</option>';
      }).join('') + '</select></label>';
    }
    return '<div class="phead cys-head"><div><h1>마감 기간 설정</h1><p>12월분·1월분 마감일을 바꾸거나 12월 말에 추가 기간을 둬요. 정하지 않으면 늘 하던 대로예요.</p></div>' + sel + '</div>';
  }
  function viewCycSet() {
    css();
    var S = C.state();
    // 메뉴·주소는 driving-app.js 가 막는다 — 그래도 그려지면(권한이 그 사이 바뀜) 글만 보인다
    if (!(S.ACCT && S.ACCT.can_manage_admin)) {
      return '<div class="cys">' + headHtml(false) + C.blank('마감 기간 설정은 권한 관리를 맡은 관리자만 볼 수 있어요.', '마스터 계정이나 권한 주는 관리자에게 부탁해 주세요.', 'cal') + '</div>';
    }
    if (ST.rules === undefined) { boot(); return '<div class="cys">' + headHtml(false) + C.skeleton() + '</div>'; }
    if (ST.rules === null) {
      return '<div class="cys">' + headHtml(false) + '<div class="cys-card"><p class="cys-msg bad">' + esc(ST.rulesErr) + '</p>' +
        '<button type="button" class="btn" data-cysretry>다시 불러오기</button></div></div>';
    }
    if (!ST.form) { if (!ST.year) ST.year = defYear(); resetForm(); }
    // 다시 그려도(자료를 새로 받은 뒤 등) 치던 칸으로 돌아간다
    var ae = document.activeElement, fid = ae && ae.id && /^cys/.test(ae.id) ? ae.id : '';
    if (fid) setTimeout(function () { var e = $(fid); if (e && document.activeElement !== e) { try { e.focus({ preventScroll: true }); } catch (er) { } } }, 0);
    setTimeout(function () { fit(); paint(); }, 0);
    var Y = ST.year, narrow = isNarrow();
    var h = '<div class="cys' + (narrow ? ' narrow' : '') + '" id="cys">' + headHtml(true);
    if (ST.noCol) h += '<p class="cys-msg warn cys-top">서버에 아직 기간 설정 칸이 없어요. 서버 준비가 끝난 뒤 쓸 수 있어요.</p>';
    h += '<section class="cys-card" aria-labelledby="cysT1"><div class="cys-ch"><h2 id="cysT1">마감일</h2><span class="cys-cnt">' + Y + '년 12월분 · ' + (Y + 1) + '년 1월분</span></div>' +
      '<table class="cys-t"><colgroup><col class="c-sys"><col class="c-d"><col class="c-x"><col class="c-j"><col class="c-f"><col class="c-s"></colgroup>' +
      '<thead><tr><th scope="col">시스템</th><th scope="col">12월분 끝</th><th scope="col">12월 추가 기간</th><th scope="col">1월분 끝</th><th scope="col">2월분 시작</th><th scope="col">상태</th></tr></thead>' +
      '<tbody>' + KINDS.map(rowHtml).join('') + '</tbody></table>' +
      '<details class="cys-help"><summary>알아 둘 것' + C.ic('down', 14) + '</summary><ul>' +
      '<li>고를 수 있는 날: 12월분 끝 12.10 ~ 12.31, 1월분 끝 01.10 ~ 01.31. 2월분은 1월분 끝 다음 날부터 자동으로 시작해요.</li>' +
      '<li>12월 추가 기간(12월분 2차)은 12월분 끝 다음 날부터 12.31까지 따로 상신·결재해요. 이때 1월분은 01.01부터예요.</li>' +
      '<li>결재 중이거나 결재가 끝난 기간은 바꿀 수 없어요. 반려·회수된 건만 있으면 바꿀 수 있고, 다시 상신하면 새 기간으로 정해져요.</li>' +
      '<li>이미 끝난 기간은 바꿀 수 없고, 끝날을 오늘보다 앞 날짜로 정할 수도 없어요. 끝난 다음 날 나가는 월간 리포트·정산과 어긋나지 않게 하려는 거예요. 끝날을 오늘로 정하는 건 돼요.</li>' +
      '<li>바꿀 기간이 시작되기 전에 정해 두면 가장 안전해요. 12월분이면 ' + Y + '년 11월 19일까지 정해 두세요.</li>' +
      '<li>앱(4.1.7 이상)은 다음에 열 때 새 기간을 받아요. 그보다 낮은 버전은 기간 이름만 다르게 보이고, 금액과 잠금은 서버가 정해요.</li>' +
      '</ul></details></section>';
    var b = barState();
    h += '<section class="cys-card" aria-labelledby="cysT2"><div class="cys-ch"><h2 id="cysT2">미리 보기</h2><span class="cys-cnt" id="cysAt">' + esc(b.at) + '</span></div>' +
      '<div id="cysPrev" aria-live="polite">' + prevHtml() + '</div>' +
      '<div class="cys-save"><label class="cys-note" for="cysNote"><span>사유 <small>(선택)</small></span>' +
      '<input class="inp" id="cysNote" maxlength="200" autocomplete="off" placeholder="예) 연말 회계 마감" value="' + esc(ST.note) + '"></label>' +
      '<div class="cys-btns"><button type="button" class="btn" id="cysDef"' + (b.def ? '' : ' disabled') + '>기본으로 되돌리기</button>' +
      '<button type="button" class="btn pri" id="cysSave"' + (b.save ? '' : ' disabled') + '>저장</button></div></div>' +
      '<p class="cys-msg' + (b.cls ? ' ' + b.cls : '') + '" id="cysMsg" role="status" aria-live="polite">' + esc(b.t) + '</p></section>';
    h += '<section class="cys-card" aria-labelledby="cysT3"><div class="cys-ch"><h2 id="cysT3">바꾼 기록</h2><span class="cys-cnt">최근 20개</span></div>' +
      '<div id="cysLog">' + logHtml() + '</div></section>';
    return h + '</div>';
  }

  /* ── 폭: 표(넓을 때) ↔ 시스템마다 카드(좁을 때) — 본문 칸의 실제 폭으로 정한다(왼쪽 메뉴가 있는 1024 도 카드) ── */
  var NARROW = 900;
  function isNarrow() { var w = ($('inner') || {}).clientWidth || window.innerWidth; return w < NARROW; }
  function fit() { var r = $('cys'); if (r) r.classList.toggle('narrow', isNarrow()); }
  window.addEventListener('resize', function () { fit(); });

  /* ══════════════════ 저장 · 되돌리기 ══════════════════ */
  function focusBad() {
    var P = probs(ST.form, ST.year);
    for (var i = 0; i < KINDS.length; i++) {
      var k = KINDS[i], e = P[k].dec ? $('cysD-' + k) : P[k].jan ? $('cysJ-' + k) : null;
      if (e) { try { e.focus(); } catch (er) { } return; }
    }
  }
  function askSave() {
    if (ST.saving || !ST.form) return;
    if (probs(ST.form, ST.year).any) { C.toast('고칠 칸이 있어요. 표에 적힌 날짜 범위로 골라 주세요.', true); focusBad(); return; }
    var b = $('cysSave'); if (b) b.disabled = true;
    fresh(0).then(function (d) {
      paintBar();
      if (!d) { C.toast(ST.dryErr || '미리 보기를 불러오지 못했어요. 잠시 후 다시 해 주세요.', true); return; }
      if (Array.isArray(d.blocked) && d.blocked.length) { C.toast(lockedText(d.blocked), true); return; }
      if (!(Array.isArray(d.changed) && d.changed.length)) { C.toast('바뀐 것이 없어요.'); return; }
      openConfirm(d);
    });
  }
  /** 옮겨 가는 기록 한 문장 — 「이미 올린 운행 2건·영수증 1장이 12월분 2차로 옮겨 가요.」 */
  function movedSentence(k, mv) {
    var tot = {}, order = [], to = [];
    mv.filter(function (m) { return m && m.kind === k; }).forEach(function (m) {
      var ps = recParts(k, m);
      ps.forEach(function (p) { if (!tot[p[0]]) { tot[p[0]] = [0, p[2]]; order.push(p[0]); } tot[p[0]][0] += p[1]; });
      if (ps.length && to.indexOf(m.to) < 0) to.push(m.to);
    });
    if (!order.length) return '이미 올린 기록 중 다른 기간으로 옮겨 가는 것은 없어요.';
    var what = order.map(function (nm) { return nm + ' ' + n0(tot[nm][0]) + tot[nm][1]; }).join('·');
    var dest = to.map(keyShort);
    return '이미 올린 ' + what + '이 ' + (dest.length === 1 ? dest[0] + ro(dest[0]) : '다른 기간(' + dest.join(', ') + ')으로') + ' 옮겨 가요.';
  }
  function openConfirm(d) {
    var Y = ST.year, ch = d.changed || [], mv = d.moved || [];
    var body = '<div class="cys-cf"><p class="cys-cfl">' + Y + '년 연말 마감 기간을 이렇게 바꿔요. <b>저장하면 직원 화면과 포털 마감 일정에 바로 반영돼요.</b></p>';
    KINDS.forEach(function (k) {
      var c = ch.filter(function (x) { return x && x.kind === k; });
      if (!c.length) return;
      body += '<div class="cys-cfk" data-k="' + k + '"><h3>' + esc(SYS[k].name) + '</h3><table class="cys-cft"><thead><tr><th scope="col">기간</th><th scope="col">지금</th><th scope="col">바꾼 뒤</th></tr></thead><tbody>' +
        c.map(function (x) {
          return '<tr><th scope="row">' + esc(keyShort(x.key)) + '</th><td>' + esc(isYmd(x.old_lo) ? span(x.old_lo, x.old_hi) : '없음') + '</td><td>' +
            esc(isYmd(x.lo) ? span(x.lo, x.hi) : '없앰') + '</td></tr>';
        }).join('') + '</tbody></table><p class="cys-cfm">' + esc(movedSentence(k, mv)) + '</p></div>';
    });
    var note = String((($('cysNote') || {}).value) || ST.note || '').trim();
    if (note) body += '<p class="cys-cfn">사유: ' + esc(note) + '</p>';
    body += '<p class="cys-cfq">저장할까요?</p></div>';
    ST.cfKey = sig(ST.form, Y);
    C.openPanel('마감 기간 저장', Y + '년 연말 · 12월분·1월분', body,
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="cysGo">저장</button>');
    css();
    var g = $('cysGo'); if (g) { try { g.focus(); } catch (er) { } }
  }
  function runSave() {
    if (ST.saving || !ST.form) return;
    var Y = ST.year;
    if (ST.cfKey !== sig(ST.form, Y)) { C.closePanel(); C.toast('그사이 값이 바뀌었어요. 미리 보기를 다시 확인하고 저장해 주세요.', true); return; }
    var note = String((($('cysNote') || {}).value) || ST.note || '').trim().slice(0, 200);
    ST.saving = true; ST.saveErr = '';
    var g = $('cysGo'); if (g) { g.disabled = true; g.textContent = '저장하는 중…'; }
    paint();
    rpc({ p_year: Y, p_plan: planOf(ST.form, Y), p_note: note || null, p_dry: false }).then(function (j) {
      ST.saving = false;
      C.closePanel();
      var done = function (msg) {
        resetForm(); ST.note = ''; ST.dry = null; ST.dryKey = '';
        var n = $('cysNote'); if (n) n.value = '';
        C.toast(msg);
        loadLog().then(paintLog);
        C.render();
        dry(true);
      };
      if (j && j.nothing) { done('바뀐 것이 없어요.'); return; }
      var raw = j && j.cycle_rules && typeof j.cycle_rules === 'object' ? j.cycle_rules : null;
      var after = function () {
        done('저장했어요. 직원 화면·포털 마감 일정이 바로 바뀌어요.' + (+(j && j.restamped) ? ' 법인카드 ' + n0(j.restamped) + '줄을 새 기간으로 옮겼어요.' : ''));
        apply(ST.rules);
        C.loadAll();
      };
      if (raw) { ST.rules = raw; after(); }
      else loadRules().then(function () {
        if (ST.rules) { after(); return; }
        // 저장은 됐는데 지금 값을 다시 못 읽었다 — 빈 설정으로 그리지 않고 「다시 불러오기」 화면으로
        C.toast('저장했어요. 설정을 다시 불러오지 못했으니 ‘다시 불러오기’를 눌러 주세요.', true);
        C.render(); C.loadAll();
      });
    }, function (e) {
      ST.saving = false;
      ST.saveErr = errText(e, '저장하지 못했어요');
      C.closePanel();
      C.toast(ST.saveErr, true);
      paint();
      dry(true);         // 서버의 지금 상태로 다시(그 사이 상신된 기간 등)
    });
  }
  function toDefault() {
    if (!ST.form || ST.saving) return;
    var Y = ST.year;
    KINDS.forEach(function (k) { ST.form[k] = { dec: stdDec(k, Y), extra: false, jan: stdJan(k, Y) }; });
    ST.hint = {};
    C.toast('세 시스템 모두 기본으로 바꿨어요. 미리 보기를 확인하고 ‘저장’을 눌러야 적용돼요.');
    later();
  }
  function setYear(y) {
    if (!ST.rules || !(y > 2000) || y === ST.year) return;
    var lost = isDirty();
    ST.year = y; ST.dry = null; ST.dryKey = ''; ST.dryErr = '';
    resetForm();
    C.render();
    dry(true);
    if (lost) C.toast('고치던 값은 저장하지 않고 넘어갔어요.');
  }

  /* ══════════════════ 이벤트 ══════════════════ */
  function onField(t) {
    var k = t.dataset.k, f = t.dataset.cysf;
    if (!ST.form || !ST.form[k]) return;
    var v = ST.form[k], Y = ST.year;
    if (f === 'X') {
      if (!!v.extra === !!t.checked) return;
      v.extra = !!t.checked; ST.hint[k] = '';
    } else {
      var fld = f === 'D' ? 'dec' : 'jan';
      if (v[fld] === t.value) return;
      v[fld] = t.value; ST.hint[k] = '';
      // 12월분 끝을 12.31 로 하면 추가 기간이 남을 날이 없다 — 끄고 까닭을 적는다
      if (fld === 'dec' && v.extra && v.dec === lim(Y).d1) { v.extra = false; ST.hint[k] = '12월분이 12.31까지라 추가 기간을 껐어요.'; }
    }
    later();
  }
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'cysNote') { ST.note = t.value; return; }
    if (t.dataset && t.dataset.cysf && t.type === 'date') onField(t);
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'cysYear') { setYear(+t.value); return; }
    if (t.dataset && t.dataset.cysf) onField(t);
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#cysSave')) { askSave(); return; }
    if (t.closest('#cysGo')) { runSave(); return; }
    if (t.closest('#cysDef')) { toDefault(); return; }
    if (t.closest('[data-cysretry]')) {
      if (ST.rules === null) { ST.rules = undefined; C.render(); } else dry(true);
    }
  });
  // 확인 창이 열린 채 Enter 를 누르면 저장되지 않게(창의 단추를 눌러야 한다) — 날짜 칸에서 Enter 는 미리 보기만 바로
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (e.key !== 'Enter' || e.isComposing || !t || !t.dataset || !t.dataset.cysf || t.type !== 'date') return;
    e.preventDefault();
    dry(false);
  });

  /* ══════════════════ 모양(이 화면에만 — 공통 CSS 는 건드리지 않는다) ══════════════════
     12칸(최대 1128) · 카드 = 흰 바탕 + 머리카락 선 + 12px 모서리 · 표 머리 44 · 숫자 오른쪽(tabular-nums) · 한 줄 단추 높이 40(폰 48) ·
     빨간 단추는 「저장」 하나 · 그러데이션·그림자·굵은 색 줄 없음 · 폰 누름 영역 44 이상. */
  function css() {
    if ($('cysCss')) return;
    var s = document.createElement('style');
    s.id = 'cysCss';
    s.textContent = [
      '.cys{max-width:1128px;word-break:keep-all;overflow-wrap:break-word}',
      '.cys .cys-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px 24px;flex-wrap:wrap}',
      '.cys .cys-head>div{min-width:0;flex:1 1 420px}',
      '.cys-yr{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--ink-600)}',
      '.cys-yr select{height:40px;min-width:200px;padding:0 12px;border:1px solid var(--ink-200);border-radius:8px;background:var(--surface);font:inherit;font-size:14px;font-weight:700;color:var(--ink-900)}',
      '.cys-card{background:var(--surface);border:1px solid var(--ink-200);border-radius:12px;padding:20px 24px 24px;margin-top:20px;min-width:0}',
      '.cys-ch{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;margin-bottom:14px}',
      '.cys-ch h2{margin:0;font-size:17px;font-weight:700;line-height:1.4;color:var(--ink-900);letter-spacing:-.01em}',
      '.cys-cnt{font-size:14px;color:var(--ink-600);font-variant-numeric:tabular-nums}',
      '.cys-top{margin:0 0 4px}',
      '.cys table{width:100%;border-collapse:collapse;border-spacing:0;font-size:14px}',
      '.cys thead th{position:static;height:44px;padding:0 12px;background:var(--ink-50);border-bottom:1px solid var(--ink-200);font-size:13px;font-weight:700;color:var(--ink-600);text-align:left;white-space:nowrap;letter-spacing:0}',
      '.cys tbody td,.cys tbody th{padding:12px;border-bottom:1px solid var(--ink-100);vertical-align:top;white-space:normal;color:var(--ink-800);text-align:left;font-weight:400;font-size:14px}',
      '.cys tbody tr:last-child td,.cys tbody tr:last-child th{border-bottom:0}',
      '.cys th.n,.cys td.n{text-align:right;font-variant-numeric:tabular-nums}',
      '.cys-t{table-layout:fixed}',
      '.cys-t col.c-sys{width:15%}.cys-t col.c-d,.cys-t col.c-j{width:19%}.cys-t col.c-x{width:19%}.cys-t col.c-f{width:10%}.cys-t col.c-s{width:18%}',
      '.cys-sys b{display:block;font-size:15px;font-weight:700;color:var(--ink-900)}',
      '.cys-sys span{display:block;margin-top:2px;font-size:13px;color:var(--ink-600)}',
      '.cys-v{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0}',
      '.cys-dt{display:flex;align-items:center;flex-wrap:wrap;gap:6px;max-width:100%}',
      '.cys-in{width:152px;max-width:100%;height:40px;padding:0 10px;font-size:14px;font-variant-numeric:tabular-nums;color:var(--ink-900)}',
      '.cys-in[aria-invalid=true]{border-color:var(--red)}',
      '.cys-sub{display:block;font-size:13px;color:var(--ink-600);font-variant-numeric:tabular-nums;line-height:1.5}',
      '.cys-err{display:block;font-size:13px;color:var(--red-700);line-height:1.5}.cys-err:empty,.cys-std:empty{display:none}',
      '.cys-feb{display:block;font-size:15px;font-weight:700;color:var(--ink-900);font-variant-numeric:tabular-nums;line-height:40px}',
      '.cys-chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;font-size:13px;font-weight:700;white-space:nowrap;background:var(--ink-100);color:var(--ink-700)}',
      '.cys-chip.ok{background:var(--ok-50);color:var(--ok)}.cys-chip.warn{background:var(--warn-50);color:var(--warn)}.cys-chip.bad{background:var(--red-50);color:var(--red-700)}',
      '.cys-tg{position:relative;display:inline-flex;align-items:center;gap:8px;min-height:40px;cursor:pointer;font-size:14px;font-weight:600;color:var(--ink-800)}',
      '.cys-tg input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}',
      '.cys-tg input:disabled{cursor:default}',
      '.cys-sw{position:relative;width:36px;height:20px;border-radius:10px;background:var(--ink-400);flex:none;transition:background var(--t)}',
      '.cys-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform var(--t)}',
      '.cys-tg input:checked+.cys-sw{background:var(--ink-900)}.cys-tg input:checked+.cys-sw::after{transform:translateX(16px)}',
      '.cys-tg input:focus-visible+.cys-sw{outline:2px solid var(--red);outline-offset:2px}',
      '.cys-tg input:disabled+.cys-sw,.cys-tg input:disabled+.cys-sw+.cys-tgt{opacity:.5}',
      '.cys-help{margin-top:12px;padding-top:4px;border-top:1px solid var(--ink-100);font-size:14px;color:var(--ink-700)}',
      '.cys-help summary{display:inline-flex;align-items:center;gap:6px;min-height:40px;cursor:pointer;font-weight:600;color:var(--ink-800);list-style:none}',
      '.cys-help summary::-webkit-details-marker{display:none}',
      '.cys-help summary svg{color:var(--ink-600);transition:transform var(--t)}.cys-help[open] summary svg{transform:rotate(180deg)}',
      '.cys-help ul{margin:0;padding-left:18px;line-height:1.7}',
      '.cys-pk{display:grid;grid-template-columns:132px minmax(0,1fr);gap:10px 16px;padding:16px 0;border-top:1px solid var(--ink-100)}',
      '.cys-pk:first-child{border-top:0;padding-top:0}',
      '.cys-pkh{display:flex;flex-direction:column;align-items:flex-start;gap:6px}.cys-pkh b{font-size:14px;color:var(--ink-900)}',
      '.cys-pkb{min-width:0;display:flex;flex-direction:column;gap:12px}',
      '.cys-pl{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}',
      '.cys-p{display:flex;flex-direction:column;gap:1px;min-width:92px;padding:7px 10px;border:1px solid var(--ink-200);border-radius:8px;background:var(--surface)}',
      '.cys-p b{font-size:14px;font-weight:700;color:var(--ink-900)}',
      '.cys-p span{font-size:13px;color:var(--ink-600);font-variant-numeric:tabular-nums}',
      '.cys-p em{font-style:normal;font-size:13px;font-weight:700;color:var(--warn)}.cys-p em.bad{color:var(--red-700)}',
      '.cys-p.chg{border-color:var(--ink-800)}.cys-p.blk{border-color:var(--red)}',
      '.cys-gone{margin:0;font-size:13px;color:var(--ink-700)}',
      '.cys-prev.stale .cys-pk{opacity:.55}',
      '.cys-mv{max-width:640px}',
      '.cys-mv thead th{height:36px}',
      '.cys-mv tbody td{padding:9px 12px;font-size:14px}',
      '.cys-mv td.n b{font-weight:700;color:var(--ink-900)}',
      '.cys-mv td.n small{display:block;font-size:13px;color:var(--ink-600)}',
      '.cys-mvd{font-weight:600;color:var(--ink-900);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.cys-wait,.cys-none{margin:0;font-size:14px;color:var(--ink-600)}',
      '.cys-save{display:flex;align-items:flex-end;flex-wrap:wrap;gap:12px 16px;margin-top:20px;padding-top:20px;border-top:1px solid var(--ink-100)}',
      '.cys-note{flex:1 1 320px;display:flex;flex-direction:column;gap:6px;min-width:0;font-size:13px;color:var(--ink-600)}',
      '.cys-note small{font-size:13px}.cys-note .inp{height:40px;font-size:14px}',
      '.cys-btns{display:flex;gap:8px;margin-left:auto}',
      '.cys .btn{height:40px;padding:0 16px;font-size:14px;font-weight:700;border-radius:8px}',
      '.cys-msg{margin:10px 0 0;font-size:14px;color:var(--ink-600);line-height:1.6}.cys-msg:empty{display:none}',
      '.cys-msg.bad{color:var(--red-700)}.cys-msg.warn{color:var(--warn)}',
      '.cys tbody td.cys-when{white-space:nowrap;font-variant-numeric:tabular-nums;width:1%}',
      '.cys tbody td.cys-who{white-space:nowrap;width:1%}',
      '.cys tbody td.cys-why{width:24%}',
      '.cys-chl{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}',
      '.cys-chl b{font-weight:700;color:var(--ink-900)}',
      '.cys-why{color:var(--ink-700)}',
      /* 확인 창(#panel 안 — .cys 밖) */
      '.cys-cf{font-size:14px;color:var(--ink-800);line-height:1.6}',
      '.cys-cfl{margin:0 0 12px}.cys-cfl b{font-weight:700;color:var(--ink-900)}',
      '.cys-cfk{padding:12px 0;border-top:1px solid var(--ink-100)}',
      '.cys-cfk h3{margin:0 0 8px;font-size:14px;font-weight:700;color:var(--ink-900)}',
      '.cys-cft{width:100%;border-collapse:collapse;font-size:14px}',
      '.cys-cft thead th{position:static;height:34px;padding:0 10px;background:var(--ink-50);border-bottom:1px solid var(--ink-200);font-size:13px;font-weight:700;color:var(--ink-600);text-align:left;white-space:nowrap}',
      '.cys-cft tbody th,.cys-cft tbody td{padding:8px 10px;border-bottom:1px solid var(--ink-100);text-align:left;font-weight:400;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--ink-800)}',
      '.cys-cft tbody th{font-weight:700;color:var(--ink-900)}',
      '.cys-cfm{margin:8px 0 0;color:var(--ink-700)}',
      '.cys-cfn{margin:12px 0 0;color:var(--ink-700)}',
      '.cys-cfq{margin:12px 0 0;font-weight:700;color:var(--ink-900)}',
      /* 좁을 때(본문 칸 900 미만 — 폰·태블릿·작은 노트북): 시스템마다 카드, 이름표 왼쪽 · 값 오른쪽 */
      '.cys.narrow .cys-card{padding:16px}',
      '.cys.narrow .cys-t,.cys.narrow .cys-t tbody{display:block}',
      '.cys.narrow .cys-t colgroup,.cys.narrow .cys-t thead{display:none}',
      '.cys.narrow .cys-t tr{display:flex;flex-direction:column;gap:8px;padding:16px 0;border-top:1px solid var(--ink-100)}',
      '.cys.narrow .cys-t tr:first-child{border-top:0;padding-top:0}',
      '.cys.narrow .cys-t th,.cys.narrow .cys-t td{display:block;padding:0;border:0}',
      '.cys.narrow .cys-t th.cys-sys{display:flex;align-items:baseline;gap:8px}',
      '.cys.narrow .cys-t td{display:grid;grid-template-columns:6.5em minmax(0,1fr);column-gap:12px;align-items:start}',
      '.cys.narrow .cys-t td::before{content:attr(data-l);font-size:13px;color:var(--ink-600);line-height:1.4;padding-top:11px}',
      '.cys.narrow .cys-t td.cys-stc{order:-1}.cys.narrow .cys-t th.cys-sys{order:-2}',
      '.cys.narrow .cys-t td.cys-stc::before,.cys.narrow .cys-t td[data-l="2월분 시작"]::before{padding-top:2px}',
      '.cys.narrow .cys-feb{display:inline;line-height:1.5}.cys.narrow td[data-l="2월분 시작"] .cys-sub{display:inline;margin-left:6px}',
      '.cys.narrow .cys-in{width:100%;max-width:220px;height:44px}.cys.narrow .cys-dt{width:100%}',
      '.cys.narrow .cys-tg{min-height:44px}',
      '.cys.narrow .cys-pk{grid-template-columns:minmax(0,1fr)}',
      '.cys.narrow .cys-pkh{flex-direction:row;align-items:center}',
      '.cys.narrow .cys-mv,.cys.narrow .cys-mv tbody{display:block;max-width:none}',
      '.cys.narrow .cys-mv thead{display:none}',
      '.cys.narrow .cys-mv tr{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:8px;row-gap:2px;padding:10px 0;border-top:1px solid var(--ink-100)}',
      '.cys.narrow .cys-mv tr:first-child{border-top:0}',
      '.cys.narrow .cys-mv td{display:block;padding:0;border:0}',
      '.cys.narrow .cys-mv td.cys-mvt::before{content:"→ ";color:var(--ink-600)}',
      '.cys.narrow .cys-mv td.n{margin-left:auto;text-align:right}',
      '.cys.narrow .cys-mv td.n b::after{content:"건";margin-left:1px;font-weight:400;color:var(--ink-600)}',
      '.cys.narrow .cys-lg,.cys.narrow .cys-lg tbody{display:block}',
      '.cys.narrow .cys-lg thead{display:none}',
      '.cys.narrow .cys-lg tr{display:flex;flex-wrap:wrap;column-gap:10px;row-gap:4px;padding:12px 0;border-top:1px solid var(--ink-100)}',
      '.cys.narrow .cys-lg tr:first-child{border-top:0;padding-top:0}',
      '.cys.narrow .cys-lg td{display:block;padding:0;border:0;width:auto}',
      '.cys.narrow .cys-lg td.cys-when .cys-sub{display:inline;margin-left:6px}',
      '.cys.narrow .cys-lg td.cys-what,.cys.narrow .cys-lg td.cys-why{flex-basis:100%}',
      '.cys.narrow .cys-btns{width:100%;margin-left:0}',
      '.cys.narrow .cys-btns .btn{flex:1 1 0;justify-content:center;height:48px}',
      '.cys.narrow .cys-note .inp,.cys.narrow .cys-yr select{height:48px}',
      '.cys.narrow .cys-yr{width:100%}.cys.narrow .cys-yr select{width:100%}',
      '.cys.narrow .cys-help summary{min-height:44px}',
      '@media (max-width:900px){.cys-cft tbody th,.cys-cft tbody td{white-space:normal}}',
      /* 폰: 기간 목록은 한 줄에 하나(이름 · 날짜 · 딱지) — 칩 두 개씩 네 줄보다 읽기 쉽다 */
      '@media (max-width:600px){.cys .cys-pl{display:block;border:1px solid var(--ink-200);border-radius:8px}' +
        '.cys .cys-pl .cys-p{flex-direction:row;align-items:baseline;gap:8px;min-width:0;padding:9px 12px;border:0;border-top:1px solid var(--ink-100);border-radius:0}' +
        '.cys .cys-pl .cys-p:first-child{border-top:0}.cys .cys-pl .cys-p b{flex:0 0 6.5em}.cys .cys-pl .cys-p span{flex:1 1 auto}' +
        '.cys .cys-pl .cys-p.chg{background:var(--ink-50)}.cys .cys-pl .cys-p.chg span{color:var(--ink-900);font-weight:600}.cys .cys-pl .cys-p.blk{background:var(--red-50)}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  return {
    views: { cycset: viewCycSet }, admin: ['cycset'],
    // 들어올 때마다 서버의 지금 설정·기록을 새로 읽는다(다른 관리자가 그 사이 바꿨을 수 있다)
    onGo: function (v, prev) {
      if (v !== 'cycset' || prev === 'cycset') return;
      clearTimeout(ST.dryT); ++ST.drySeq;
      ST.rules = undefined; ST.form = null; ST.saved = null; ST.dry = null; ST.dryKey = ''; ST.dryErr = ''; ST.dryBusy = false;
      ST.log = undefined; ST.year = 0; ST.note = ''; ST.saveErr = '';
    }
  };
});
