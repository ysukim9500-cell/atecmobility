/* ═══════════════════════════════════════════════════════════════════════════
   drv-card.js — 법인카드 지출결의 (2026-10-09, docs/card/SPEC.md §4)
   ---------------------------------------------------------------------------
   운행일지·개인경비에 이은 세 번째 결재 문서. 결재 방식(결재란·결재선·결재함·PDF 확인·정정 열기)은 같고,
   상신 창·결재함·결재 확인 창은 driving-app.js 의 것을 kind:'card' 로 부른다.
   ★ 기간은 달력 한 달: 1일 00:00 ~ 말일 24:00(KST). '2026-07' = 「2026년 7월분」 = 07.01 – 07.31.
   ★ 자료는 직원이 ERP 에서 받은 자기 카드 승인내역 엑셀(card-erp.js 가 읽는다 — SheetJS 는 올리기 창을 열 때만 싣는다).
     손으로 적는 칸은 구분·사용목적·비고뿐. 칸을 고치면 바로 저장한다(화면을 다시 그리지 않는다 — 커서가 튀지 않게).
   ★ 구분·사용목적이 빈 줄이 있으면 상신하지 못한다(beforeSubmit {blocked} + 서버 CARD_INCOMPLETE). 나머지 검증은 표시만.
   ★ 검증은 브라우저에서 규칙으로만(card-rules.js — 서버 _shared/card-verify.ts 와 같은 판정). AI·사진 없음.
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

  /* ══════════════════ 기간 (1일 ~ 말일) ══════════════════ */
  function keyOf(c) { return c.y + '-' + pad(c.m); }
  function parseKey(k) { var p = String(k || '').split('-'); return { y: +p[0], m: +p[1] }; }
  /** 오늘이 속한 법인카드 기간 — 달력 달(KST). */
  function cCurrent() { var d = C.kd(Date.now()); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; }
  function cSpan(y, m) { return R.span(y + '-' + pad(m)); }
  function cycName(k) { var c = parseKey(k); return c.y && c.m ? C.cycleName(c.y, c.m) : String(k || '') + '분'; }
  function rangeHiMs(k) { return Date.parse(R.cycleRange(k).hi + 'T00:00:00+09:00'); }

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
      .then(function (rows) { ITEMS[k] = { rows: (rows || []).sort(byDate) }; return ITEMS[k].rows; })
      .catch(function (e) { ITEMS[k] = { err: (e && e.authGone) ? '로그인이 만료되었습니다.' : '법인카드 내역을 불러오지 못했습니다.' }; return null; });
    ITEMS[k] = { wait: p };
    if (!all) {
      rest('/rest/v1/rpc/card_cycle_locked', { method: 'POST', body: JSON.stringify({ p_username: me(), p_cycle: cyc }) })
        .then(function (v) { CLOCK[me() + '|' + cyc] = v === true; }, function () { });
    }
    return p;
  }
  function loadAppr() {
    return C.fetchAll('/rest/v1/card_approvals?select=*&order=submitted_at.desc')
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
    return C.head(title, esc(C.cycleName(S.CYC.y, S.CYC.m)) + ' · <b>' + esc(cSpan(S.CYC.y, S.CYC.m)) + '</b>' + (extra ? ' · ' + extra : ''));
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
    return '<div class="cycband">' + ic('cal', 15) + '<span>지금 <b>' + S.CYC.y + '년 ' + S.CYC.m + '월분 (' + esc(cSpan(S.CYC.y, S.CYC.m)) +
      ') · 지난 기간</b>을 보고 있습니다. 법인카드는 <b>1일 ~ 말일</b>이 한 기간입니다.</span>' +
      '<button class="btn sm" data-cyc="' + cur.y + '-' + cur.m + '">이번 기간(' + cur.m + '월분 ' + esc(cSpan(cur.y, cur.m)) + ')으로 →</button></div>';
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
    return p.join(' ');
  }
  /** 구분별 합계 한 줄 — 큰 것부터 넷. */
  function catLine(byCat) {
    var t = Object.keys(byCat || {}).map(function (c) { return { c: c, sum: byCat[c].sum }; }).sort(function (a, b) { return b.sum - a.sum; }).slice(0, 4);
    return t.length ? t.map(function (x) { return x.c + ' ' + won(x.sum); }).join(' · ') : '—';
  }
  /** 결재 띠 — 상태 · 진행 · 회수. 이번 달 카드 내역·검증 화면 위에. */
  function apprStrip(a) {
    var st = C.apprStatusText(a);
    var canWithdraw = a && a.status === 'submitted' && !(a.steps || []).some(function (x) { return x.result; });
    var btn = canWithdraw ? '<button class="btn sm" data-appr="withdraw" data-kind="card" data-id="' + a.id + '">회수</button>' : '';
    if (a && (a.status === 'submitted' || a.status === 'approved')) wantSums([a.id]);
    return '<section class="sect" style="margin:0 0 16px"><div class="astrip">' +
      '<div class="ahd"><span class="akind c">법인카드</span><span class="st ' + st.cls + '">' + esc(st.t) + '</span><span style="flex:1"></span>' + btn + '</div>' +
      (a ? C.apprTrack(a) : '<div class="anote" style="margin-top:0">결재선은 상신할 때 결재받을 분의 이름을 넣어 직접 고릅니다. 상신하면 결재함으로 갑니다.</div>') +
      (a && (a.status === 'submitted' || a.status === 'approved') ? extra(a) : '') +
      (a && a.status === 'submitted' ? '<div class="anote">결재 중에는 이 기간의 카드 내역을 고칠 수 없습니다. ' +
        (canWithdraw ? '고치려면 「회수」한 뒤 다시 상신하세요.' : '첫 결재자가 이미 결재해 회수할 수 없습니다 — 반려를 요청하세요.') + '</div>' : '') +
      '</div></section>';
  }

  /* ══════════════════ 이번 달 카드 내역 ══════════════════ */
  function viewMonth() {
    var S = C.state();
    if (!S.LOADED) return C.head('이번 달 카드 내역') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('이번 달 카드 내역', '법인카드');
    var rows = itemsFor(false);
    if (!rows || rows.err) return notReady('이번 달 카드 내역', rows);
    if (HIST === null && !HIST_ASK) loadHist();
    var cyc = S.CYCKEY, a = myC(cyc), locked = lockedFor(me(), cyc);
    var T = R.totals(rows), blank = R.blankRows(rows), hist = histFor(rows);
    var nSug = locked ? 0 : rows.filter(function (it) { return !String(it.category || '').trim() && R.suggest(it, hist); }).length;
    var nMiss = rows.filter(function (it) { return MISSING[it.id]; }).length;
    var top = Object.keys(T.by_cat).filter(function (k) { return k !== '(빈칸)'; })
      .map(function (k) { return { c: k, n: T.by_cat[k].n, sum: T.by_cat[k].sum }; }).sort(function (x, y) { return y.sum - x.sum; }).slice(0, 2);
    var h = head('이번 달 카드 내역', 'ERP 에서 받은 내 카드 내역에 구분·사용목적을 적습니다');
    h += apprStrip(a);
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (a && a.status === 'approved' ? ' ok' : '') + '"></span>' +
      esc(C.cycleName(S.CYC.y, S.CYC.m)) + ' · ' + esc(cSpan(S.CYC.y, S.CYC.m)) + ' · ' + n0(T.n) + '건</div>' +
      '<p class="verdict">' + won(T.cost) + '</p><div class="facts">' +
      fact('건수', n0(T.n) + '<small>건</small>', 'ERP 에서 올린 승인') +
      fact('빈칸', '<span id="cBlankN">' + n0(blank) + '</span><small>줄</small>', '구분·사용목적 — 채워야 상신', blank > 0) +
      top.map(function (x) { return fact(x.c, won(x.sum), n0(x.n) + '건'); }).join('') + '</div>' +
      (locked ? '' : '<div class="vact" style="margin-top:16px"><button class="btn pri" data-cup>' + ic('card', 14) + 'ERP 엑셀 올리기</button>' +
        (nSug ? '<button class="btn" data-csugall>추천 구분 채우기 (' + n0(nSug) + ')</button>' : '') +
        (rows.length ? '<button class="btn" data-v="c_verify">검증·상신으로 ' + ic('chev', 13) + '</button>' : '') + '</div>') + '</div>';
    if (locked) h += '<div class="hpnote">' + ic('check', 16) + '<span><b>' + (a && a.status === 'approved' ? '결재가 끝난 기간입니다.' : '결재 중인 기간입니다.') +
      '</b> 카드 내역을 올리거나 고칠 수 없습니다.' + (a && a.status === 'approved' ? ' 고칠 것이 있으면 관리자에게 「정정 열기」를 요청하세요.' : '') + '</span></div>';
    h += C.sect('내역', n0(rows.length) + '건' + (blank ? ' · 빈칸 ' + n0(blank) + '줄' : '') + (nMiss ? ' · 파일에 없는 줄 ' + n0(nMiss) : ''), '',
      rows.length ? tableHtml(rows, locked, hist)
        : '<div class="panel"><div class="blank"><div class="ico">' + ic('card', 21) + '</div><div class="t">이 기간에 올린 카드 내역이 없습니다.</div>' +
          '<div class="d">ERP 에서 <b>내 법인카드 승인내역</b>을 엑셀(.xls · .xlsx)로 받아 올려 주세요. 0원·취소 줄은 자동으로 뺍니다.<br>법인카드를 쓰지 않았으면 할 일이 없습니다.</div>' +
          (locked ? '' : '<div style="margin-top:16px"><button class="btn pri" data-cup>' + ic('card', 14) + 'ERP 엑셀 올리기</button></div>') + '</div></div>');
    h += '<div class="anote"><b>구분·사용목적이 빈 줄이 있으면 상신할 수 없습니다.</b> 칸을 고치면 바로 저장됩니다. 연한 글씨와 점선 단추는 <b>추천</b>입니다 — ' +
      '누르거나 「추천 구분 채우기」로 확정합니다. 같은 파일을 다시 올려도 적어 둔 구분·사용목적·비고는 그대로입니다.</div>';
    return h;
  }
  function tableHtml(rows, locked, hist) {
    return '<div class="panel"><div class="scroll tall cscroll" data-rows><table class="ctab"><thead><tr><th class="n">순번</th><th>승인일</th><th>시간</th><th>가맹점</th><th>업종</th>' +
      '<th class="n">승인금액</th><th>구분</th><th>사용목적</th><th>비고</th><th></th></tr></thead><tbody>' +
      rows.map(function (it, i) { return rowHtml(it, i, locked, hist); }).join('') +
      '</tbody><tfoot><tr><td colspan="5">합계 ' + n0(rows.length) + '건</td><td class="n total">' + n0(R.totals(rows).cost) + '</td><td colspan="4"></td></tr></tfoot></table></div></div>';
  }
  function rowHtml(it, i, locked, hist) {
    var sg = !locked && !String(it.category || '').trim() ? R.suggest(it, hist) : null;
    var inp = function (f, ph) {
      var v = String(it[f] == null ? '' : it[f]), need = f !== 'note' && !v.trim();
      return '<input class="inp cin' + (need ? ' need' : '') + (f === 'purpose' ? ' wide' : '') + '" data-cid="' + it.id + '" data-f="' + f + '" maxlength="' + MAXLEN[f] +
        '" value="' + esc(v) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + (locked ? ' disabled' : '') + ' aria-label="' + (i + 1) + '번째 줄 ' + LABEL[f] + '">';
    };
    return '<tr data-crow="' + it.id + '"' + (MISSING[it.id] ? ' class="cmiss"' : '') + '>' +
      '<td class="n" data-l="순번">' + (i + 1) + '</td>' +
      '<td data-l="승인일">' + esc(String(it.appr_date || '').slice(5).replace('-', '.')) + '</td>' +
      '<td class="dim" data-l="시간">' + esc(String(it.appr_time || '').slice(0, 5)) + '</td>' +
      '<td class="el" data-l="가맹점" title="' + esc(it.merchant || '') + '">' + esc(it.merchant || '—') + (MISSING[it.id] ? ' <span class="st warn">파일에 없는 줄</span>' : '') + '</td>' +
      '<td class="el dim" data-l="업종">' + esc(it.biz_type || '') + '</td>' +
      '<td class="n total" data-l="승인금액">' + n0(it.amount) + '</td>' +
      '<td data-l="구분">' + inp('category', sg ? sg.cat : '예: 중식대') +
        (sg ? '<button type="button" class="csug" data-csug="' + it.id + '" data-cat="' + esc(sg.cat) + '" title="' + esc(sg.why) + ' — 누르면 확정">' + esc(sg.cat) + ' ✓</button>' : '') + '</td>' +
      '<td data-l="사용목적">' + inp('purpose', '무엇에 썼는지') + '</td>' +
      '<td data-l="비고">' + inp('note', '') + '</td>' +
      '<td class="n" data-l=""><span class="csave" id="cs' + it.id + '" aria-live="polite"></span>' +
        (locked ? '' : '<button type="button" class="btn sm" data-cdel="' + it.id + '" aria-label="' + (i + 1) + '번째 줄 지우기">지우기</button>') + '</td></tr>';
  }

  /* ── 칸 저장 — 칸마다 차례로(늦게 온 응답이 새 값을 덮지 않게), 다시 그리지 않는다 ── */
  // SAVE_T: 'id|f' → { t: 타이머, id, f, v, cyc } — 기다리는 칸(쓰는 중). 기간은 넣을 때 굳힌다(그사이 기간을 바꿔도 그 줄로 간다).
  var SAVE_T = {}, CHAIN = {}, SAVING = 0;
  function queueSave(el, now) {
    var id = el.dataset.cid, f = el.dataset.f, k = id + '|' + f;
    if (f !== 'note') el.classList.toggle('need', !el.value.trim());
    var w = SAVE_T[k] || { id: id, f: f, cyc: C.state().CYCKEY };
    clearTimeout(w.t);
    w.v = el.value;
    w.t = setTimeout(function () { if (SAVE_T[k] === w) { delete SAVE_T[k]; saveCell(id, f, w.v, w.cyc); } }, now ? 0 : 800);
    SAVE_T[k] = w;
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
  /** 실패하면 칸을 서버 값으로 되돌리고 「저장 못 함」 + 까닭. 말없이 버리지 않는다. */
  function failCell(id, f, prev, msg) {
    mark(id, '저장 못 함', true);
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
        failCell(id, f, undefined, '저장하지 못했습니다 — 그 줄을 찾지 못했습니다(지워졌거나 다른 기간). 목록을 다시 불러온 뒤 적어 주세요.');
        return;
      }
      v = String(v == null ? '' : v).trim().slice(0, MAXLEN[f]);
      if (String(it[f] == null ? '' : it[f]) === v) { mark(id, ''); return; }
      var body = {}, prev = it[f];
      body[f] = v;
      it[f] = v; SAVING++; mark(id, '저장 중…');
      // keepalive — 페이지를 닫는 중(pagehide)에 보낸 저장도 끝까지 간다
      return rest('/rest/v1/card_items?id=eq.' + encodeURIComponent(id) + '&select=id,' + f + ',updated_at', {
        method: 'PATCH', keepalive: true, headers: { Prefer: 'return=representation' }, body: JSON.stringify(body)
      }).then(function (out) {
        if (!out || !out.length) throw new Error('저장되지 않았습니다(권한 또는 잠금)');
        it[f] = out[0][f]; it.updated_at = out[0].updated_at;
        mark(id, '저장됨');
      }).catch(function (e) {
        it[f] = prev;
        failCell(id, f, prev, failMsg('저장하지 못했습니다', e, why(e)));
      }).then(function () { SAVING--; paintBlank(); });
    });
  }
  // 쓰다가 새로 고침·탭 닫기 — 본체의 묻기는 창(panel)이 열려 있을 때만 모듈을 본다. 칸 저장은 창 밖이라 여기서 따로 묻는다.
  window.addEventListener('beforeunload', function (e) {
    if (pending() || C_SENDING) { flushSaves(); e.preventDefault(); e.returnValue = ''; }
  });
  // 탭을 숨기거나(휴대폰 앱 전환) 떠날 때는 기다리지 않고 바로 보낸다.
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushSaves(); });
  window.addEventListener('pagehide', flushSaves);
  function paintBlank() { var el = $('cBlankN'); if (el) el.textContent = n0(R.blankRows(mineRows(C.state().CYCKEY))); }
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
      C.toast(n0(todo.length) + '줄에 추천 구분을 채웠습니다. 맞는지 한 번 보세요.');
      if (!typing()) C.render();
    });
  }
  function openDel(id) {
    var it = findMine(id); if (!it) return;
    C.openPanel('이 줄을 지울까요?', String(it.appr_date) + ' · ' + (it.merchant || '') + ' · ' + n0(it.amount) + '원',
      '<div class="anote" style="margin-top:0">ERP 파일에 다시 들어 있으면 다음에 올릴 때 다시 들어옵니다(그때 구분·사용목적은 새로 적어야 합니다).</div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnCDelGo" data-id="' + esc(String(it.id)) + '">지우기</button>');
  }
  function runDel(id) {
    var b = $('btnCDelGo'); if (b) { b.disabled = true; b.textContent = '지우는 중…'; }
    rest('/rest/v1/card_items?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=representation' } })
      .then(function (rows) {
        if (!rows || !rows.length) throw new Error('지워지지 않았습니다(권한 또는 잠금)');
        delete MISSING[id];
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
    if (C_SENDING) { C.toast('앞서 고른 파일을 아직 넣는 중입니다. 끝난 뒤 다시 열어 주세요.'); return; }
    CUP = { cyc: S.CYCKEY, busy: false, sent: false, res: null, plan: null, file: '', useOwner: true };
    C.openPanel('ERP 엑셀 올리기 — 법인카드', C.cycleName(S.CYC.y, S.CYC.m) + ' · ' + cSpan(S.CYC.y, S.CYC.m),
      '<div class="drop" id="cDrop" style="margin:0 0 14px">' +
      '<div class="dt">ERP 에서 받은 <b>내 법인카드 승인내역</b> 엑셀을 올립니다</div>' +
      '<div class="dd">.xls · .xlsx · PC 에서는 여기에 끌어다 놓아도 됩니다<br>0원·취소 줄과 ' + esc(cSpan(S.CYC.y, S.CYC.m)) + ' 밖의 줄은 자동으로 뺍니다</div>' +
      '<label class="btn" style="margin-top:14px">파일 고르기<input type="file" id="cFile" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="sr"></label>' +
      '</div><div id="cPrev"></div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnCUpGo" disabled>넣기</button>', true);
    C.bindDrop($('cDrop'), function (fs) { readFile(fs && fs[0]); });
    loadItems(S.CYCKEY, false);            // 다시 올리기 계획에 쓸 지금 줄(이미 있으면 그대로)
    ensureXlsx().catch(function () { });   // 미리 받아 둔다
  }
  function prevMsg(t) { var el = $('cPrev'); if (el) el.innerHTML = '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(t) + '</span></div>'; }
  function replan(s) {
    var cur = mineRows(s.cyc);
    s.plan = E.plan(cur, s.res.items.filter(function (it) { return s.useOwner || !it.owner_mismatch; }));
  }
  function readFile(f) {
    var s = CUP;
    if (!f || !s || s.busy) return;
    // ★ 5MB 읽기 상한은 여기서(card-erp.js 는 크기를 보지 않는다) — SheetJS 에 넘기기 전에 막아야 큰 파일에서 브라우저가 멈추지 않는다.
    if (f.size > MAX_BYTES) {
      prevMsg('파일이 너무 큽니다(' + (f.size / 1048576).toFixed(1) + 'MB). 5MB 까지 올릴 수 있습니다 — ERP 에서 한 달치만 받아 올려 주세요.');
      return;
    }
    s.busy = true; s.res = null; s.plan = null;
    var el = $('cPrev'); if (el) el.innerHTML = '<div class="pdfwait"><div class="spin"></div><div role="status">엑셀을 읽는 중…</div></div>';
    var btn = $('btnCUpGo'); if (btn) btn.disabled = true;
    Promise.all([ensureXlsx(), f.arrayBuffer(), loadItems(s.cyc, false)]).then(function (r) {
      if (CUP !== s) return;
      var bytes = new Uint8Array(r[1]);
      if (!E.looksLikeSheet(bytes)) throw new Error('NOT_SHEET');
      var res = E.parse(E.sheetRows(r[0], bytes), { cycle: s.cyc, me: myFullName(), file: f.name });
      if (!res.ok) { var er = new Error(res.error); er.res = res; throw er; }
      s.res = res; s.file = f.name;
      s.useOwner = !res.owner.all;         // 모든 줄이 남의 카드면 기본으로 빼 둔다(경고만 — 사용자가 고른다)
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
          ' — 취소된 승인이면 넣은 뒤 표에서 그 줄을 지워 주세요.' : ' 아래 「뺀 줄」에서 확인해 주세요.') + '</span></div>';
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
        '<label class="finall" style="margin:6px 0 10px"><input type="checkbox" id="cOwn"' + (s.useOwner ? ' checked' : '') + '> 소유자가 다른 줄 ' + n0(res.owner.mismatch) + '건도 넣기' +
        (s.useOwner ? '' : ' <span class="dim">(지금은 빼 둡니다)</span>') + '</label>';
    }
    h += '<div class="facts cfacts">' +
      fact('새 줄', n0(pl.inserts.length) + '<small>줄</small>', '처음 들어오는 승인') +
      fact('바뀐 줄', n0(pl.updates.length) + '<small>줄</small>', 'ERP 칸만 고침 — 구분·사용목적은 그대로') +
      fact('그대로', n0(pl.same.length) + '<small>줄</small>', '이미 같은 값') +
      fact('넣을 금액', won(amt), '새 줄 + 바뀐 줄') +
      fact('뺀 줄', n0(res.dropped.length) + '<small>줄</small>', '0원·취소·다른 달 등') + '</div>';
    if (erp.found && erp.ok) h += '<div class="pdfok">' + ic('check', 15) + '<span>ERP 합계 ' + won(erp.fileTotal) + ' = 승인 ' + won(erp.approved) + ' − 취소 ' + won(erp.cancelled) + ' — 맞습니다</span></div>';
    else if (!erp.found) h += '<div class="fhint">파일에 「합계」 줄이 없어 ERP 합계와 맞춰 보지 못했습니다.</div>';
    if (pl.missing.length) h += '<div class="fhint">이 기간에 이미 있는데 <b>파일에 없는 줄 ' + n0(pl.missing.length) + '건</b> — 지우지 않습니다. 넣은 뒤 표의 「파일에 없는 줄」 표시를 보고 필요 없으면 지워 주세요.</div>';
    if (res.dropped.length) {
      h += '<section class="sect" style="margin-top:12px"><div class="hd"><h2>뺀 줄</h2><span class="cnt">' + n0(res.dropped.length) + '줄</span></div>' +
        '<div class="panel"><div class="scroll" data-rows><table class="cdrop"><thead><tr><th class="n">엑셀 행</th><th>승인일</th><th>승인번호</th><th>가맹점</th><th class="n">금액</th><th>까닭</th></tr></thead><tbody>' +
        res.dropped.map(function (d) {
          var inv = d.reason === 'invalid', why = d.label + (inv && d.cancel ? ' — 취소 줄: 원래 승인은 남음' : '');
          return '<tr' + (inv ? ' class="cbad"' : '') + ' data-dreason="' + esc(d.reason) + '"><td class="n">' + d.row + '</td><td>' + esc(d.appr_date || '—') + '</td><td>' + esc(d.appr_no || '(없음)') + '</td>' +
            '<td class="el">' + esc(d.merchant) + '</td><td class="n">' + (d.cancel ? '−' : '') + n0(d.amount) + '</td><td>' + (inv ? '<span class="st bad">' + esc(why) + '</span>' : esc(why)) + '</td></tr>';
        }).join('') + '</tbody></table></div></div></section>';
    }
    el.innerHTML = h;
    var b = $('btnCUpGo');
    if (b) {
      b.disabled = !nGo || s.busy;
      b.textContent = !nGo ? '넣을 줄이 없습니다' : nCheck ? '넣기 (확인 ' + n0(nCheck) + '건)' : '넣기 (새 ' + n0(pl.inserts.length) + ' · 바뀜 ' + n0(pl.updates.length) + ')';
      b.title = nCheck ? '위의 경고를 확인한 뒤 넣어 주세요' : '';
    }
    // 경고가 있으면 창 안을 미리보기 머리까지 내려 둔다(올리기 칸 아래에 묻히지 않게) — 뒤 화면은 건드리지 않는다
    var pb = $('pBody');
    if (pb && (erpBad || bad.length)) pb.scrollTop += Math.max(0, el.getBoundingClientRect().top - pb.getBoundingClientRect().top - 8);
  }
  function runUpload() {
    var s = CUP;
    if (!s || !s.plan || s.busy) return;
    var list = s.plan.inserts.concat(s.plan.updates.map(function (u) { return u.item; }));
    if (!list.length) { C.closePanel(); return; }
    s.busy = true; C_SENDING = true;
    var b = $('btnCUpGo'); if (b) { b.disabled = true; b.textContent = '넣는 중…'; }
    var at = new Date().toISOString(), u = me(), done = 0;
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
      s.sent = true;
      MISSING = {};
      s.plan.missing.forEach(function (e) { MISSING[e.id] = 1; });
      C.closePanel();
      C.toast('넣었습니다 — 새 ' + n0(s.plan.inserts.length) + '줄 · 바뀜 ' + n0(s.plan.updates.length) + '줄' +
        (s.plan.missing.length ? ' · 파일에 없는 줄 ' + n0(s.plan.missing.length) + '줄은 표에 표시했습니다' : ''));
    }).catch(function (e) {
      C.toast(failMsg('넣지 못했습니다', e, why(e)) + (done ? ' (' + n0(done) + '줄은 들어갔습니다)' : ''), true);
      if (b && document.contains(b)) { b.disabled = false; b.textContent = '다시 넣기'; }
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
  function runCheck() {
    var S = C.state(), u = me(), cyc = S.CYCKEY, k = vkey(u, cyc);
    if (pending()) { C.toast('칸을 저장하는 중입니다. 잠시 뒤 다시 눌러 주세요.'); return; }
    var res = R.runVerify(mineRows(cyc), { cycle: cyc, submitterName: myFullName() });
    VR[k] = { at: Date.now(), sig: sig(u, cyc), res: res };
    setPreviewed(k, false);
    C.toast('검증했습니다 — ' + sumText(res.summary));
    C.render();
  }
  var LV = { block: ['빈칸', 'bad'], bad: ['불일치', 'bad'], warn: ['확인 필요', 'warn'], info: ['참고', ''] };
  function itemsHtml(items, links) {
    if (!items || !items.length) return '<div class="panel"><div class="blank"><div class="ico">' + ic('check', 21) + '</div><div class="t">확인이 필요한 항목이 없습니다.</div></div></div>';
    return '<div class="panel vlist">' + items.map(function (it) {
      var lv = LV[it.level] || LV.info, ref = (it.ref && it.ref.items) || [], go = '';
      if (links && ref.length && it.level !== 'info') { VITEMS.push(it); go = '<button class="btn sm vgo vfix" data-cvfix="' + (VITEMS.length - 1) + '">바로 고치기' + ic('chev', 12) + '</button>'; }
      return '<div class="vitem v-' + esc(it.level === 'block' ? 'bad' : it.level) + '"><span class="st ' + lv[1] + '">' + lv[0] + '</span>' +
        '<div class="vb"><div class="vt">' + esc(it.title) + '</div><div class="vd">' + esc(it.detail || '') + '</div></div>' + go + '</div>';
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
    var v = VR[k], fresh = !!(v && v.sig === sig(u, cyc)), s = v ? v.res.summary : {}, items = v ? v.res.items : [];
    var seen = previewOk(k), blocked = !!(v && fresh && s.block);
    var stage = locked ? 0 : !v || !fresh ? 1 : !seen ? 2 : 3;
    var canSubmit = !a || a.status === 'rejected' || a.status === 'withdrawn';
    VITEMS = [];
    var verdict, clean = '';
    if (!v) verdict = '아직 검증하지 않았습니다';
    else if (!fresh) verdict = '자료가 바뀌었습니다 — 다시 검증해 주세요';
    else if (s.block) verdict = '빈 칸이 있는 줄이 <em>' + n0(s.blank_rows) + '줄</em> — 채워야 상신할 수 있습니다';
    else if (s.bad) verdict = '맞지 않는 곳이 <em>' + n0(s.bad) + '건</em> 있습니다';
    else if (s.warn) { verdict = '확인할 것이 <em>' + n0(s.warn) + '건</em> 있습니다'; clean = ' wait'; }
    else { verdict = '<em>이상 없습니다</em>'; clean = ' clean'; }
    var card = function (n, title, desc, button) {
      var st = stage > n ? 'done' : stage === n ? 'now' : 'todo';
      return '<li class="vstep ' + st + '"' + (st === 'now' ? ' aria-current="step"' : '') + '><div class="vsh"><i>' + (st === 'done' ? '✓' : n) + '</i><b>' + title + '</b></div><p>' + desc + '</p>' + button + '</li>';
    };
    var none = !rows.length;
    var steps = locked ? '' : '<ol class="vsteps" aria-label="상신 순서">' +
      card(1, '검증하기', none ? '먼저 「이번 달 카드 내역」에서 ERP 엑셀을 올려 주세요.'
        : v && fresh ? '지금 자료로 검증했습니다. 고친 게 있으면 다시 눌러 주세요.'
        : '구분·사용목적 빈칸, 같은 승인번호, 기간 밖 승인일, 소유자, 0원 줄을 살핍니다.',
        '<button class="btn big' + (stage === 1 && !none ? ' pri cta' : '') + '" data-cvrun' + (none ? ' disabled' : '') + '>' + ic('check', 16) + (v && fresh ? '다시 검증하기' : '검증하기') + '</button>') +
      card(2, 'PDF 미리보기', v && fresh ? '결재자에게 갈 지출결의서(가로 A4)를 눈으로 확인합니다.' : '① 검증하기를 먼저 해 주세요.',
        '<button class="btn big' + (stage === 2 ? ' pri cta' : '') + '" data-cpdf=""' + (v && fresh ? '' : ' disabled') + '>' + ic('dl', 16) + 'PDF 미리보기</button>') +
      card(3, '결재 상신', !canSubmit ? '이미 상신했습니다.' : blocked ? '구분·사용목적이 빈 줄이 있어 상신할 수 없습니다.' : stage === 3 ? '결재선을 고르고 올립니다.' : 'PDF 미리보기를 먼저 확인해 주세요.',
        (canSubmit ? '<button class="btn big' + (stage === 3 && !blocked ? ' pri cta' : '') + '" id="btnOpenSubmit" data-kind="card"' + (stage === 3 && !blocked ? '' : ' disabled') + '>' +
          (a && a.status === 'rejected' ? '다시 상신' : '결재 상신') + '</button>' : '') +
        (blocked ? ' <button class="btn big" data-cgoblank>' + ic('chev', 14) + '빈 칸으로 가기</button>' : '')) + '</ol>';
    var h = head('검증·상신', '상신하기 전에 빈 칸과 맞지 않는 곳을 살펴봅니다');
    h += apprStrip(a);
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (v && fresh && !s.block && !s.bad ? ' ok' : '') + '"></span>' +
      (v ? '마지막 검증 ' + esc(C.vx.whenText(new Date(v.at).toISOString())) : '검증 전') + ' · 카드 ' + n0(rows.length) + '건 ' + won(R.totals(rows).cost) + '</div>' +
      '<p class="verdict' + clean + '">' + verdict + '</p>' +
      (v ? '<div class="facts">' + fact('빈칸', n0(s.blank_rows) + '<small>줄</small>', '구분·사용목적 — 상신을 막음', s.block > 0) +
        fact('불일치', n0(s.bad), '같은 승인번호가 두 번', s.bad > 0) + fact('확인 필요', n0(s.warn), '기간 밖 승인일 · 소유자') + fact('참고', n0(s.info), '0원 줄') + '</div>' : '') +
      (locked ? '<div class="vact"><button class="btn" data-cpdf="">' + ic('dl', 14) + '결재 문서 PDF</button></div>' : steps) + '</div>';
    if (v && fresh) {
      var need = items.filter(function (i) { return i.level !== 'info'; }), info = items.filter(function (i) { return i.level === 'info'; });
      h += C.sect('봐야 할 것', need.length ? need.length + '건' : null, '', itemsHtml(need, !locked));
      if (info.length) h += C.sect('참고', info.length + '건', '', itemsHtml(info));
    } else if (!none) {
      h += '<div class="panel"><div class="blank"><div class="ico">' + ic('check', 21) + '</div><div class="t">위 ① 「검증하기」를 누르면 이번 달 카드 내역을 살펴봅니다.</div>' +
        '<div class="d">구분·사용목적이 빈 줄만 상신을 막습니다. 나머지(같은 승인번호·기간 밖·소유자·0원)는 결재자가 같이 봅니다.</div></div></div>';
    }
    h += '<div class="anote">검증은 정해진 규칙으로만 합니다(AI·사진 없음). 금액은 ERP 승인금액 그대로이고 바꾸지 않습니다.</div>';
    return h;
  }
  /** 상신 창이 「상신」을 누른 직후 — 미리보기 뒤 자료가 바뀌었거나 빈 칸이 있으면 멈추고({blocked}), 아니면 요약을 돌려준다. */
  function beforeSubmit(onNote) {
    var u = me(), cyc = C.state().CYCKEY, k = vkey(u, cyc), seen = PREV[k] ? PREV[k].sig : null;
    if (onNote) onNote(pending() ? '칸을 저장하는 중' : '카드 내역을 다시 확인하는 중');
    // 쓰다 만 칸·보내는 중인 칸을 먼저 끝낸다 — 끝나기 전에 서버에서 다시 받으면 방금 적은 값이 빠진 채 판정한다
    return settleSaves().then(function () {
      if (onNote) onNote('카드 내역을 다시 확인하는 중');
      return loadItems(cyc, false, true);
    }).then(function (rows) {
      if (!rows) return null;                       // 다시 받지 못했으면 막지 않는다(서버가 CARD_INCOMPLETE 로 지킨다)
      var goVerify = function () { C.closePanel(); if (C.state().VIEW !== 'c_verify') C.go('c_verify'); else C.render(); };
      if (seen != null && sig(u, cyc) !== seen) {
        setPreviewed(k, false); goVerify();
        C.toast('미리보기 뒤에 카드 내역이 바뀌었습니다. PDF를 다시 확인해 주세요.', true);
        return { blocked: true };
      }
      var res = R.runVerify(mineRows(cyc), { cycle: cyc, submitterName: myFullName() });
      VR[k] = { at: Date.now(), sig: sig(u, cyc), res: res };
      if (res.summary.block) {
        goVerify();
        C.toast('구분·사용목적이 빈 줄이 ' + n0(res.summary.blank_rows) + '건 있습니다. 채운 뒤 상신해 주세요.', true);
        return { blocked: true };
      }
      return { bad: res.summary.bad, warn: res.summary.warn, info: res.summary.info };
    });
  }

  /* ══════════════════ 문서(PDF · 엑셀) ══════════════════ */
  /** 결재란 — 운행기록부·개인경비와 같은 규칙. 담당 = 상신자, 승인한 칸만 이름·날짜·서명, 결재선에 없는 칸은 빗금. */
  function boxesOf(a, name) {
    var at = a && a.submitted_at ? Date.parse(a.submitted_at) : NaN;
    var live = !a || a.status === 'withdrawn' || a.status === 'rejected';
    var b = { 담당: { name: name, date: !live && isFinite(at) ? C.md(at) : '', signId: live ? null : ((a.snapshot || {}).sign_id || null) } };
    if (!live) ((a && a.steps) || []).forEach(function (s) {
      if (s.box && C.BOXES.indexOf(s.box) > 0) {
        var t = s.acted_at ? Date.parse(s.acted_at) : NaN;
        b[s.box] = s.result === 'approved' ? { name: s.name || s.approver, date: isFinite(t) ? C.md(t) : '', signId: s.sign_id || null } : { name: '', date: '' };
      }
    });
    return b;
  }
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
    var p = personOf(u, fz), boxes = boxesOf(a, p.name);
    return {
      meta: { name: p.name, cycleName: cycName(cyc) + ' 법인카드', mark: mark, docNo: docNo },
      person: p, periodLabel: cycName(cyc) + ' (' + R.span(cyc) + ')', boxes: boxes, items: docItems(rows, p.name), verify: verify,
      sheets: [{ boxes: boxes }]               // fillSigns 가 결재란 서명을 여기에 채운다(같은 객체)
    };
  }
  /** 검증 결과 → PDF 검증 쪽 재료. 빈칸(block)은 「[상신 막음]」을 붙여 불일치로 보인다. */
  function vOf(res, atMs) {
    if (!res) return null;
    var s = res.summary || {};
    return {
      ranAt: isFinite(atMs) ? C.vx.whenText(new Date(atMs).toISOString()) : '', ai: false,
      noAiText: '규칙 검증(빈칸 · 같은 승인번호 · 기간 · 소유자 · 0원)',
      notes: ['· 금액은 ERP 에서 받은 승인금액 그대로입니다(취소·0원 줄은 올릴 때 뺐습니다).',
        '· 구분·사용목적이 빈 줄이 있으면 상신할 수 없습니다. 나머지 항목은 결재자가 보고 판단합니다.'],
      summary: { bad: (s.block || 0) + (s.bad || 0), warn: s.warn || 0, info: s.info || 0, receipts: 0, read: 0 },
      items: (res.items || []).map(function (i) { return i.level === 'block' ? { code: i.code, level: 'bad', title: '[상신 막음] ' + i.title, detail: i.detail } : i; })
    };
  }
  function showPdf(d, o) {
    return C.vx.makePdf({
      doc: { sheets: d.sheets, scans: [], photos: [] }, nImg: 0, verify: d.verify, title: o.title, sub: o.sub, file: o.file,
      note: o.note, expect: o.expect, expectName: o.expectName, okKey: o.okKey || '', okAttr: 'data-cpdfok', meta: d.meta,
      stat: function (res) { var t = (res && res.totals && res.totals[0]) || {}; return '지출결의서 ' + n0(t.pages || 1) + '장 · ' + n0(d.items.length) + '건'; },
      build: function (lib) {
        return window.SheetPdf.buildCard(d, { PDFLib: lib.PDFLib, fontkit: lib.fontkit, fontRegular: lib.fontRegular, fontBold: lib.fontBold });
      }
    }).catch(function () { });
  }
  /** 상신 전 미리보기(지금 자료). 결재 중·완료면 고정본으로. */
  function pdfMine() {
    var S = C.state(), u = me(), cyc = S.CYCKEY, a = myC(cyc);
    if (a && (a.status === 'submitted' || a.status === 'approved')) { pdfFrozen(a.id); return; }
    var rows = mineRows(cyc);
    if (!rows.length) { C.toast('이 기간에 담을 카드 내역이 없습니다.', true); return; }
    var k = vkey(u, cyc), v = VR[k];
    var d = cDoc(u, cyc, rows, null, null, v ? vOf(v.res, v.at) : null, 'preview', '상신 전 미리보기 · ' + C.vx.whenText(new Date().toISOString()) + ' 출력');
    showPdf(d, { title: 'PDF 미리보기 — 법인카드', sub: d.person.name + ' · ' + cycName(cyc) + ' (' + R.span(cyc) + ')',
      file: '법인카드_지출결의_' + C.vx.safeName(d.person.name) + '_' + cyc + '_미리보기.pdf',
      expect: R.totals(rows).cost, expectName: '화면 합계', okKey: k });
  }
  var FZ = {}, FZSUM = {}, FZFAIL = {}, FZASK = '';
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
      var d = frozenDoc(a, fz), done = a.status === 'approved';
      showPdf(d, { title: done ? '결재 완료본 — 법인카드' : a.status === 'submitted' ? '결재 문서 — 법인카드' : '상신했던 문서 — 법인카드',
        sub: d.person.name + ' · ' + cycName(a.cycle) + ' (' + R.span(a.cycle) + ')',
        file: '법인카드_지출결의_' + C.vx.safeName(d.person.name) + '_' + a.cycle + MARK_SUFFIX[d.meta.mark] + '.pdf',
        expect: (a.snapshot || {}).cost, expectName: '상신 때 집계한 금액' });
    }).catch(function () { C.toast('결재 문서를 불러오지 못했습니다. 잠시 뒤 다시 해 보세요.', true); });
  }
  function xlsxFrozen(id) {
    var a = apprById(id); if (!a) return;
    fetchFrozen(a).then(function (fz) {
      if (!fz) { C.toast('상신 때 저장한 자료를 찾지 못했습니다.', true); return; }
      var d = frozenDoc(a, fz), x = SH.xlsxBytes(d, window.Xlsx);
      var sum = d.items.reduce(function (s, it) { return s + it.amount; }, 0), exp = (a.snapshot || {}).cost;
      C.saveBlob(x.bytes, '법인카드_지출결의_' + C.vx.safeName(d.person.name) + '_' + a.cycle + MARK_SUFFIX[d.meta.mark] + '.xlsx');
      if (exp != null && Math.round(sum) !== Math.round(Number(exp))) C.toast('엑셀 합계 ' + n0(sum) + '원이 상신 때 금액 ' + n0(exp) + '원과 다릅니다. 관리자에게 알려 주세요.', true);
      else C.toast('엑셀을 내려받습니다.');
    }).catch(function () { C.toast('결재 문서를 불러오지 못했습니다.', true); });
  }

  /* ══════════════════ 결재함 카드 · 결재 요약 ══════════════════ */
  function wantSums(ids) {
    var now = Date.now(), need = [];
    (ids || []).forEach(function (id) {
      var a = apprById(id); if (!a) return;
      var k = fzKey(a);
      if (FZSUM[k] !== undefined || (FZFAIL[k] && now - FZFAIL[k] < 30000)) return;
      need.push(a);
    });
    if (!need.length) return;
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
      }).catch(function () { need.forEach(function (a) { FZFAIL[fzKey(a)] = Date.now(); }); FZASK = ''; });
  }
  /** 결재 요약(결재 중) + 검증 딱지 · 문서 단추. 개인경비 extra 와 같은 모양. */
  function extra(a) {
    if (!a) return '';
    var f = FZSUM[fzKey(a)], done = a.status === 'approved', live = a.status === 'submitted' || done;
    var chip = f && f.verify ? '<button class="vchip" data-cfzverify="' + a.id + '" title="상신할 때의 검증 결과 보기">' + sumChip(f.verify.summary) + '</button>' : '';
    return brief(a, f) + '<div class="aext">' + chip + '<span style="flex:1"></span>' +
      '<button class="btn sm" data-cfzpdf="' + a.id + '">' + ic('dl', 13) + (done ? '결재 완료본 PDF' : live ? '결재 문서 PDF' : '상신했던 문서 PDF') + '</button>' +
      (done ? '<button class="btn sm" data-cfzxlsx="' + a.id + '">결재 완료본 엑셀</button>' : '') + '</div>';
  }
  function brief(a, f) {
    if (!a || a.status !== 'submitted') return '';
    var s = a.snapshot || {};
    if (s.cost == null) return '';
    var cost = Number(s.cost) || 0, cy = parseKey(a.cycle), pc = C.addCycle(cy, -1), pkey = keyOf(pc);
    var prev = (CAPPR || []).filter(function (x) { return x.username === a.username && x.cycle === pkey && (x.status === 'approved' || x.status === 'submitted') && x.snapshot && x.snapshot.cost != null; })[0];
    var cmp;
    if (prev) {
      var p0 = Number(prev.snapshot.cost) || 0, d = cost - p0, pct = p0 ? Math.round(d / p0 * 100) : null;
      cmp = '<div class="abf"><span class="k">전월(' + pc.m + '월분) 대비</span><b class="' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '') + won(Math.abs(d)) +
        (pct != null && d ? ' <small>(' + (d > 0 ? '+' : '−') + (Math.abs(pct) < 1 ? '1% 미만' : Math.abs(pct) + '%') + ')</small>' : '') + '</b><span class="sub">' + pc.m + '월분 ' + won(p0) + ' · ' + n0(prev.snapshot.n) + '건</span></div>';
    } else cmp = '<div class="abf"><span class="k">전월 대비</span><b class="dimv">—</b><span class="sub">볼 수 있는 ' + pc.m + '월분 법인카드 결재가 없습니다</span></div>';
    var v = f && f.verify, vs = (v && v.summary) || null;
    var items = ((v && v.items) || []).filter(function (i) { return i.level === 'bad' || i.level === 'warn'; });
    var checks = [];
    if (vs) checks.push(vs.bad ? ['bad', '같은 승인번호 ' + n0(vs.bad) + '건'] : vs.warn ? ['warn', '검증 확인 필요 ' + n0(vs.warn) + '건'] : ['ok', '검증 이상 없음']);
    else if (f === undefined) checks.push(['warn', '검증 결과를 불러오는 중…']);
    else checks.push(['warn', '상신 때 검증 결과가 없습니다']);
    var nBad = checks.filter(function (c) { return c[0] === 'bad'; }).length, nWarn = checks.filter(function (c) { return c[0] === 'warn'; }).length;
    var verdict = !vs ? ['warn', '검증 결과를 아직 받지 못했습니다 — 결재 문서를 열어 확인해 주세요']
      : nBad ? ['bad', '확인이 필요합니다 — 문서의 불일치 항목을 보고 결재해 주세요']
      : nWarn ? ['warn', '대체로 정상입니다 — 아래 확인 항목만 살펴봐 주세요']
      : ['ok', '금액·검증 모두 이상 없습니다 — 문서를 열지 않고 승인하셔도 됩니다'];
    return '<div class="abrief ' + verdict[0] + '"><div class="abv"><span class="abi">' + (verdict[0] === 'ok' ? '✓' : '!') + '</span><b>' + esc(verdict[1]) + '</b></div>' +
      '<div class="abgrid">' +
      '<div class="abf"><span class="k">청구 금액</span><b>' + won(cost) + '</b><span class="sub">' + esc(catLine(s.by_cat)) + '</span></div>' +
      '<div class="abf"><span class="k">카드 승인</span><b>' + n0(s.n) + '<small>건</small></b><span class="sub">' + esc(R.span(a.cycle)) + '</span></div>' +
      cmp + '</div><div class="abchk">' + checks.map(function (c) { return '<span class="ck ' + c[0] + '">' + (c[0] === 'ok' ? '✓' : '!') + ' ' + esc(c[1]) + '</span>'; }).join('') + '</div>' +
      (items.length ? '<ul class="abitems">' + items.slice(0, 4).map(function (i) {
        return '<li class="' + i.level + '"><b>' + esc(i.title || '') + '</b>' + (i.detail ? ' — ' + esc(String(i.detail).slice(0, 110)) + (String(i.detail).length > 110 ? '…' : '') : '') + '</li>';
      }).join('') + (items.length > 4 ? '<li class="more">외 ' + n0(items.length - 4) + '건 — 아래 검증 딱지를 눌러 전부 보기</li>' : '') + '</ul>' : '') + '</div>';
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
    var T = R.totals(rows), cnt = function (f) { return list.filter(f).length; };
    var nDone = cnt(function (x) { return x.a && x.a.status === 'approved'; }), nGo = cnt(function (x) { return x.a && x.a.status === 'submitted'; });
    var nBack = cnt(function (x) { return x.a && (x.a.status === 'rejected' || x.a.status === 'withdrawn'); }), nNot = cnt(function (x) { return !x.a && x.n > 0; });
    var h = head('법인카드 현황', '직원별 상신·결재 상태');
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (nGo || nBack || nNot ? '' : ' ok') + '"></span>카드 내역이 있는 ' + n0(list.length) + '명 · ' + n0(T.n) + '건</div>' +
      '<p class="verdict">' + won(T.cost) + '</p><div class="facts">' +
      fact('결재 완료', n0(nDone) + '<small>명</small>', '출력할 수 있습니다') + fact('결재 중', n0(nGo) + '<small>명</small>', '결재자 차례를 기다리는 중', nGo > 0) +
      fact('반려·회수', n0(nBack) + '<small>명</small>', '고쳐서 다시 올려야 함', nBack > 0) + fact('상신 안 함', n0(nNot) + '<small>명</small>', '이번 달 카드 내역이 있는데 상신 전', nNot > 0) +
      '</div></div>';
    var order = function (x) { return !x.a ? (x.n ? 0 : 5) : x.a.status === 'rejected' || x.a.status === 'withdrawn' ? 1 : x.a.status === 'submitted' ? 2 : 3; };
    list.sort(function (x, y) { return order(x) - order(y) || y.sum - x.sum; });
    h += C.sect('직원별', n0(list.length) + '명', '', list.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>파트·센터</th><th>이름</th>' +
      '<th class="n">건수</th><th class="n">금액</th><th>빈칸</th><th>결재</th><th></th></tr></thead><tbody>' +
      C.orgGroups(list, function (x) { return x.u; }, true).map(function (g) {
        return C.orgGroupRow(g, 7, '합계 <b>' + won(g.list.reduce(function (s, x) { return s + x.sum; }, 0)) + '</b>') + g.list.map(function (x) {
          var a = x.a;
          return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td><td class="n">' + n0(x.n) + '</td>' +
            '<td class="n total">' + n0(x.sum) + '</td><td>' + (x.blank ? '<span class="st bad">' + n0(x.blank) + '줄</span>' : '<span class="dim">—</span>') + '</td>' +
            '<td>' + stChip(a) + '</td><td class="n" style="white-space:nowrap">' +
            (x.n ? '<button class="btn sm" data-cperson="' + esc(x.u) + '">내역</button> ' : '') +
            (a && (a.status === 'submitted' || a.status === 'approved') ? '<button class="btn sm" data-cfzpdf="' + a.id + '">PDF</button> ' : '') +
            (a && a.status === 'submitted' ? '<button class="btn sm" data-appr="force_reject" data-kind="card" data-id="' + a.id + '" title="결재가 멈췄을 때 관리자 권한으로 반려합니다">관리자 반려</button>' : '') +
            (a && a.status === 'approved' ? '<button class="btn sm" data-appr="reopen" data-kind="card" data-id="' + a.id + '" title="결재 완료 건을 정정하도록 다시 엽니다">정정 열기</button>' : '') + '</td></tr>';
        }).join('');
      }).join('') + '</tbody></table></div></div>' : C.blank('이 기간에 카드 내역이 있는 사람이 없습니다.', null, 'users'));
    h += '<div class="anote"><b>관리자 반려</b>는 결재자가 자리에 없어 결재가 멈췄을 때만 씁니다. <b>정정 열기</b>는 결재가 끝난 뒤 고칠 것이 생겼을 때 씁니다 — ' +
      '잠금이 풀려 직원이 고쳐 다시 상신하고, 그때의 결재 완료본은 이력에 남습니다.</div>';
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
      '<span style="flex:1"></span><button class="btn sm" data-ccsv>' + ic('dl', 13) + 'CSV 내려받기</button></div>';
    var total = rows.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0);
    var sorted = rows.slice().sort(byDate);
    h += C.sect('내역', n0(rows.length) + '건 · ' + won(total), '', rows.length ? '<div class="panel"><div class="scroll tall" data-rows><table class="xtab"><thead><tr>' +
      '<th>승인일</th><th>파트·센터</th><th>이름</th><th>카드번호</th><th>가맹점</th><th class="n">승인금액</th><th>구분</th><th>사용목적</th><th>비고</th></tr></thead><tbody>' +
      C.orgGroups(sorted, function (it) { return it.username; }).map(function (g) {
        return C.orgGroupRow(g, 9, n0(g.list.length) + '건 · 합계 <b>' + won(g.list.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0)) + '</b>').replace(/<span class="on">[^<]*<\/span>/, '') +
          g.list.map(function (it) {
            var bl = !String(it.category || '').trim() || !String(it.purpose || '').trim();
            return '<tr' + (bl ? ' class="xover"' : '') + '><td><span class="lead">' + esc(String(it.appr_date).slice(5).replace('-', '.')) + '</span></td>' + C.orgCell(it.username, true) +
              '<td>' + esc(C.nameOf(it.username)) + '</td><td class="dim">' + esc(it.card_no || '') + '</td><td class="el" title="' + esc(it.merchant || '') + '">' + esc(it.merchant || '—') + '</td>' +
              '<td class="n total">' + n0(it.amount) + '</td><td><span class="kind">' + esc(it.category || '—') + '</span></td>' +
              '<td class="el" title="' + esc(it.purpose || '') + '">' + esc(it.purpose || '') + '</td><td class="el dim">' + esc(it.note || '') + '</td></tr>';
          }).join('');
      }).join('') + '</tbody><tfoot><tr><td colspan="5">보이는 ' + n0(rows.length) + '건 합계</td><td class="n total">' + n0(total) + '</td><td colspan="3"></td></tr></tfoot></table></div></div>'
      : '<div class="panel"><div class="blank"><div class="t">조건에 맞는 카드 내역이 없습니다.</div><div style="margin-top:12px"><button class="btn sm" data-cclear>조건 지우기</button></div></div></div>');
    return h;
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
    C.saveBlob(new TextEncoder().encode(csvText(out)), '법인카드_내역_' + S.CYCKEY + scopeSuffix() + '.csv');
    C.toast('CSV 를 내려받습니다(' + n0(rows.length) + '건).');
  }
  var FINSEL = {}, FINJOB = null;
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
    var nSel = Object.keys(FINSEL).length;
    var h = head('법인카드 결재 완료 출력', '결재가 끝난 지출결의서를 모아 출력합니다');
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (done.length && !going.length && !notYet.length ? ' ok' : '') + '"></span>' + esc(cycName(S.CYCKEY)) + ' · ' + esc(R.span(S.CYCKEY)) + '</div>' +
      '<p class="verdict">결재 완료 <em>' + n0(done.length) + '명</em> · ' + won(total) + '</p><div class="facts">' +
      fact('결재 완료', n0(done.length) + '<small>명</small>', '출력할 수 있습니다') + fact('결재 중', n0(going.length) + '<small>명</small>', '결재자 차례를 기다리는 중', going.length > 0) +
      fact('반려·회수', n0(back.length) + '<small>명</small>', '고쳐서 다시 올려야 함', back.length > 0) + fact('아직 상신 안 함', n0(notYet.length) + '<small>명</small>', '이번 달 카드 내역이 있는데 상신 전', notYet.length > 0) + '</div></div>';
    var tools = done.length ? '<label class="finall"><input type="checkbox" id="cFinAll"' + (nSel && nSel === done.length ? ' checked' : '') + '> 전체 선택</label>' +
      '<button class="btn sm' + (nSel ? ' pri' : '') + '" data-cfinpdf' + (nSel && !FINJOB ? '' : ' disabled') + '>' + ic('dl', 13) + (nSel ? '고른 ' + n0(nSel) + '명 PDF 한 파일로' : 'PDF 한 파일로 묶기') + '</button>' +
      '<button class="btn sm" data-cfincsv>' + ic('dl', 13) + '금액 요약표(CSV)</button>' : '';
    h += C.sect('결재 완료', n0(done.length) + '명', tools, done.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th style="width:36px"></th><th>파트·센터</th><th>이름</th>' +
      '<th>결재 완료</th><th class="n">건수</th><th class="n">금액</th><th>결재선</th><th></th></tr></thead><tbody>' +
      C.orgGroups(done, function (a) { return a.username; }, true).map(function (g) {
        return C.orgGroupRow(g, 8, '합계 <b>' + won(g.list.reduce(function (s, a) { return s + (Number((a.snapshot || {}).cost) || 0); }, 0)) + '</b>') + g.list.map(function (a) {
          var line = (a.steps || []).map(function (s) { return (s.name || C.nameOf(s.approver)) + '(' + (s.box || '') + ')'; }).join(' → ');
          return '<tr><td><input type="checkbox" data-cfinsel="' + a.id + '"' + (FINSEL[a.id] ? ' checked' : '') + ' aria-label="' + esc(C.nameOf(a.username)) + ' 고르기"></td>' +
            C.orgCell(a.username, true) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span></td><td class="dim">' + (a.closed_at ? esc(C.vx.whenText(a.closed_at)) : '—') + '</td>' +
            '<td class="n">' + n0((a.snapshot || {}).n) + '</td><td class="n total">' + n0((a.snapshot || {}).cost) + '</td><td class="el dim" title="' + esc(line) + '">' + esc(line) + '</td>' +
            '<td class="n" style="white-space:nowrap"><button class="btn sm" data-cfzpdf="' + a.id + '">PDF</button> <button class="btn sm" data-cfzxlsx="' + a.id + '">엑셀</button> ' +
            '<button class="btn sm" data-appr="reopen" data-kind="card" data-id="' + a.id + '">정정 열기</button></td></tr>';
        }).join('');
      }).join('') + '</tbody><tfoot><tr><td></td><td colspan="4">결재 완료 ' + n0(done.length) + '명 합계</td><td class="n total">' + n0(total) + '</td><td colspan="2"></td></tr></tfoot></table></div></div>'
      : C.blank('아직 결재가 끝난 건이 없습니다.', '결재가 끝나면 여기에 모입니다.', 'stamp'));
    if (going.length) {
      h += C.sect('결재 중', n0(going.length) + '명', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>소속</th><th>이름</th><th>상신</th><th class="n">금액</th><th>지금 차례</th><th></th></tr></thead><tbody>' +
        going.map(function (a) {
          var cur = (a.steps || []).filter(function (s) { return s.seq === a.cur_seq; })[0] || {};
          return '<tr>' + C.orgCell(a.username) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span></td><td class="dim">' + (a.submitted_at ? esc(C.vx.whenText(a.submitted_at)) : '') + '</td>' +
            '<td class="n">' + n0((a.snapshot || {}).cost) + '</td><td>' + esc((cur.name || C.nameOf(cur.approver || '')) + (cur.box ? ' (' + cur.box + ')' : '')) + '</td>' +
            '<td class="n"><button class="btn sm" data-appr="force_reject" data-kind="card" data-id="' + a.id + '">관리자 반려</button></td></tr>';
        }).join('') + '</tbody></table></div></div>');
    }
    if (back.length || notYet.length) {
      var todo = back.map(function (a) { return { u: a.username, st: a.status === 'rejected' ? '반려' : '회수' }; }).concat(notYet.map(function (u) { return { u: u, st: '상신 전' }; }));
      h += C.sect('챙겨야 할 사람', n0(todo.length) + '명', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>파트·센터</th><th>이름</th><th>상태</th><th class="n">이번 달 카드</th></tr></thead><tbody>' +
        C.orgGroups(todo, function (x) { return x.u; }, true).map(function (g) {
          return C.orgGroupRow(g, 4, '') + g.list.map(function (x) {
            var p = by[x.u] || { n: 0, sum: 0 };
            return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td><td><span class="st ' + (x.st === '상신 전' ? 'warn' : 'bad') + '">' + esc(x.st) + '</span></td>' +
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
    C.saveBlob(new TextEncoder().encode(csvText(out)), '법인카드_결재완료_금액요약_' + S.CYCKEY + scopeSuffix() + '.csv');
    C.toast('요약표를 내려받습니다(' + n0(done.length) + '명).');
  }
  /** 고른 결재 완료 건을 PDF 한 파일로 — 한 사람씩 고정본으로 만든 뒤 이어 붙인다(한 번에 20명까지). */
  function finBundle() {
    var S = C.state();
    var list = Object.keys(FINSEL).map(apprById).filter(function (a) { return a && a.status === 'approved'; })
      .sort(function (x, y) { return C.nameOf(x.username).localeCompare(C.nameOf(y.username), 'ko'); });
    if (!list.length || FINJOB) return;
    if (list.length > 20) { C.toast('한 번에 20명까지 묶을 수 있습니다(지금 ' + list.length + '명). 나눠서 골라 받아 주세요.', true); return; }
    var job = FINJOB = {};
    C.openPanel('법인카드 결재 완료본 묶어 받기', cycName(S.CYCKEY) + ' · ' + n0(list.length) + '명',
      '<div class="pdfwait"><div class="spin"></div><div id="cFinNote" role="status">준비하는 중…</div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
    var note = function (t) { var el = $('cFinNote'); if (el) el.textContent = t; };
    var alive = function () { if (FINJOB === job && !$('cFinNote')) { FINJOB = null; C.render(); } return FINJOB === job; };
    var parts = [], skipped = [], checks = [];
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
          parts.push(res.bytes);
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
      if (inp && !inp.disabled) { inp.value = el.dataset.cat; inp.classList.remove('need'); saveCell(el.dataset.csug, 'category', el.dataset.cat); el.remove(); }
      return;
    }
    if (e.target.closest('[data-csugall]')) { fillSuggest(); return; }
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
      setTimeout(function () { var b = document.getElementById('btnOpenSubmit'); if (b) { try { b.focus(); b.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (er) { } } }, 60);
      return;
    }
    if ((el = e.target.closest('[data-cfzpdf]'))) { pdfFrozen(el.dataset.cfzpdf); return; }
    if ((el = e.target.closest('[data-cfzxlsx]'))) { xlsxFrozen(el.dataset.cfzxlsx); return; }
    if ((el = e.target.closest('[data-cfzverify]'))) {
      var a = apprById(el.dataset.cfzverify), f = a && FZSUM[fzKey(a)];
      if (f && f.verify) C.vx.showItems(C.nameOf(a.username) + ' 법인카드 검증 결과', cycName(a.cycle) + ' · 상신 시점', vOf(f.verify, Date.parse(f.verify.ran_at || f.frozen_at)));
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
    if (t.id === 'cWho') { CL.who = t.value; C.render(); var w = $('cWho'); if (w) w.focus(); return; }
    if (t.id === 'cCat') { CL.cat = t.value; C.render(); var w2 = $('cCat'); if (w2) w2.focus(); return; }
    if (t.matches && t.matches('[data-cfinsel]')) { if (t.checked) FINSEL[t.dataset.cfinsel] = 1; else delete FINSEL[t.dataset.cfinsel]; C.render(); return; }
    if (t.id === 'cFinAll') {
      cycAppr().forEach(function (a) { if (a.status === 'approved' && C.orgMatch(a.username)) { if (t.checked) FINSEL[a.id] = 1; else delete FINSEL[a.id]; } });
      C.render();
    }
  });

  var K0 = {
    tag: '법인카드', mode: 'c',
    rows: function () { return CAPPR || []; },
    mine: function (cyc) { return myC(cyc); },
    reload: function () { var S = C.state(); dropItems(S.CYCKEY); return Promise.all([loadAppr(), loadItems(S.CYCKEY, false, true)]); },
    sumLine: function (a) { var s = a.snapshot || {}; return s.cost != null ? n0(s.n) + '건 · ' + won(s.cost) : ''; },
    sumHtml: sumHtml,
    extra: extra,
    wantSummaries: wantSums,
    cycName: function (a) { return cycName(a.cycle) + ' (' + R.span(a.cycle) + ') · 법인카드 지출결의'; },
    cycLabel: function (a) { return cycName(a.cycle) + ' (' + R.span(a.cycle) + ')'; },
    submitHead: function () {
      var S = C.state(), rows = mineRows(S.CYCKEY), T = R.totals(rows), warn = [], bl = R.blankRows(rows);
      if (!rows.length) warn.push('이 기간에 올린 카드 내역이 없습니다 — 먼저 ERP 엑셀을 올려 주세요');
      if (bl) warn.push('구분·사용목적이 빈 줄 ' + n0(bl) + '건 — 채워야 상신됩니다');
      return { title: C.cycleName(S.CYC.y, S.CYC.m) + ' 법인카드 결재 상신', sub: cSpan(S.CYC.y, S.CYC.m) + ' · ' + n0(T.n) + '건 · ' + won(T.cost), warn: warn };
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
    period: { mode: 'c', views: CVIEWS, current: cCurrent, span: cSpan, band: band, tag: tag },
    load: loadWith,
    onGo: function (v, prev) {
      if (v === 'ca_list' && prev !== 'ca_close' && prev !== 'ca_people') CL = { cat: '', who: '', blank: false };
      if (ADMIN_C.indexOf(v) >= 0 && isAdmin()) loadItems(C.state().CYCKEY, true);
    },
    onCycle: function () { MISSING = {}; FINSEL = {}; },
    dirty: function () {
      if (C_SENDING || pending()) return true;
      if ($('cDrop') && CUP && CUP.plan && !CUP.sent) return true;
      return false;
    }
  };
});
