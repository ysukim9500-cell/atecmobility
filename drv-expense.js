/* ═══════════════════════════════════════════════════════════════════════════
   drv-expense.js — 개인경비 지출결의 (2026-10-07, docs/expense/SPEC.md §4)
   ---------------------------------------------------------------------------
   운행일지와 **별개의 결재 문서**다. 결재 방식(결재란·결재선·결재함·PDF 확인·검증)은 운행일지 것을
   그대로 쓴다 — 상신 창·결재함·결재 확인 창은 driving-app.js 의 것을 kind:'expense' 로 부른다.

   ★ 기간은 운행일지와 다르다: 전월 20일 00:00 ~ 당월 19일 24:00(KST), 끝나는 달 이름.
     2026-09-20 ~ 2026-10-19 = '2026-10' = 「2026년 10월분」. 헷갈리지 않게 모든 화면에 범위를 함께 적는다.
   ★ 금액 계산은 단순 합이다(소계 = 구분별 합, 합계 = 소계의 합). 서버 approval-act 가 상신 때 같은 합을 굳힌다.
   ★ 식비 기준(1인 1끼 13,000원)은 **알리기만** 한다. 인원은 사용내역의 「N명/인」(N, 붙여 쓴 것만), 「외 N명/인」(N+1), 없으면 1명(2026-10-08 규칙 — mealPeople 주석) —
     서버 _shared/expense-verify.ts X07 과 같은 규칙(mealPeople·mealOver).

   화면: x_month(이번 달 경비) · x_verify(검증·상신) · 관리 xa_close(현황) · xa_list(전체 내역) · xa_final(결재 완료 출력)
   ═══════════════════════════════════════════════════════════════════════════ */
(window.DrvExtQ = window.DrvExtQ || []).push(function (C) {
  'use strict';
  var $ = C.$, esc = C.esc, ic = C.ic, n0 = C.n0, won = C.won, pad = C.pad;
  var KST = 9 * 3600e3;
  var CATS = ['소모품비', '식비', '기타비용'];
  var MEAL_LIMIT = 13000;
  var XVIEWS = ['x_month', 'x_verify', 'xa_close', 'xa_list', 'xa_final', 'xa_people'];
  var ADMIN_X = ['xa_close', 'xa_list', 'xa_final', 'xa_people'];

  /* ══════════════════ 기간 (20일 ~ 19일) ══════════════════ */
  function xRange(y, m) { return { lo: Date.UTC(y, m - 2, 20) - KST, hi: Date.UTC(y, m - 1, 20) - KST }; }
  function parseKey(k) { var p = String(k || '').split('-'); return { y: +p[0], m: +p[1] }; }
  function xRangeKey(k) { var c = parseKey(k); return xRange(c.y, c.m); }
  function xSpan(y, m) {
    var r = xRange(y, m), s = C.kd(r.lo), e = C.kd(r.hi - 1);
    return pad(s.getUTCMonth() + 1) + '.' + pad(s.getUTCDate()) + ' – ' + pad(e.getUTCMonth() + 1) + '.' + pad(e.getUTCDate());
  }
  function xSpanKey(k) { var c = parseKey(k); return xSpan(c.y, c.m); }
  /** 오늘이 속한 개인경비 기간. 20일부터는 다음 달분. */
  function xCurrent() {
    var d = C.kd(Date.now()), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    if (d.getUTCDate() >= 20) { m += 1; if (m > 12) { m = 1; y += 1; } }
    return { y: y, m: m };
  }
  function cycName(k) { var c = parseKey(k); return c.y && c.m ? C.cycleName(c.y, c.m) : String(k || '') + '분'; }
  function keyOf(c) { return c.y + '-' + pad(c.m); }
  /** 'YYYY-MM-DD' → 그날 KST 12:00(앱과 같은 값). */
  function dayMs(s) { var ms = Date.parse(s + 'T12:00:00+09:00'); return isFinite(ms) ? ms : NaN; }

  /* ══════════════════ 식비 기준 ══════════════════ */
  /** 사용내역에서 인원 — 「외 N명」 = N+1, 「N명」 = N, 없으면 1. (서버 X07 과 같은 규칙) */
  function mealPeople(usage) {
    // ★ 2026-10-08 규칙 교체 — 서버·앱과 글자 하나까지 같게 바꾼다.
    //   A 「외 N명/인」(띄어 써도 됨) = N+1 (N ≥ 1 일 때만).
    //   B (A 가 없을 때만) 숫자 바로 뒤에 「명/인」이 붙고(띄우지 않음), 숫자 앞이 숫자·. , / : - 가 아닌 것 = N.
    //     예전 규칙은 「123명」→23명, 「10.3 명동 점심」→3명으로 잘못 읽었다.
    //   그 밖은 1명. 결과는 1~99.
    var text = String(usage || ''), n = 1;
    var a = /외\s*(\d{1,2})\s*(?:명|인)/.exec(text);
    if (a) { if (+a[1] >= 1) n = +a[1] + 1; }
    else {
      var b = /(?:^|[^\d.,\/:\-])(\d{1,2})(?:명|인)/.exec(text);
      if (b && +b[1] >= 1) n = +b[1];
    }
    return Math.max(1, Math.min(99, n));
  }
  /** 식비 줄이 1인 1끼 13,000원을 넘는가 — { n, per } 또는 null.
   *  ★ 판정은 금액 > 13,000 × 인원(나누지 않고 — 서버와 같게). per 는 보여 줄 1인 금액(원 아래 올림, 2026-10-08 서버·앱과 같게). */
  function mealOver(it) {
    if (!it || it.category !== '식비') return null;
    var n = mealPeople(it.usage), amt = Number(it.amount) || 0;
    return amt > MEAL_LIMIT * n ? { n: n, per: Math.ceil(amt / n) } : null;
  }
  function mealTag(it) {
    var o = mealOver(it);
    if (!o) return '';
    return '<span class="st warn xmeal" title="식비 기준 1인 1끼 13,000원 — 알리기만 합니다">1인 ' + n0(o.per) + '원' +
      (o.n > 1 ? ' (' + o.n + '명)' : '') + ' · 13,000원 초과</span>';
  }

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
  function xai(body) {
    return C.apiRetry('/functions/v1/expense-ai', { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j || j.error) { var e = new Error((j && j.error) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
          return j;
        });
      });
  }
  /** 서버 오류를 사람 말로. 잠금(EXPENSE_LOCKED)은 따로 말한다. */
  function why(e) {
    var m = String((e && e.message) || '');
    if (/EXPENSE_LOCKED/.test(m)) return '결재 중이거나 결재가 끝난 기간이라 고칠 수 없습니다. 고치려면 먼저 회수해 주세요.';
    if (/413|too large/i.test(m)) return '파일이 너무 큽니다. 사진을 줄여서 다시 올려 주세요.';
    if (/401|403|jwt|로그인/i.test(m)) return '로그인이 풀렸거나 권한이 없습니다. 다시 로그인해 주세요.';
    if (/409|duplicate/i.test(m)) return '같은 것이 이미 올라가 있습니다. 목록을 다시 확인해 주세요.';
    console.error('개인경비:', m);
    return '잠시 뒤 다시 해 주세요.';
  }
  /** 「~하지 못했습니다」 알림 — 서버가 준 한국어 설명은 그대로 붙이고, HTTP 500·주소 같은 원문은 콘솔로만(2026-10-08 문구 점검). */
  function failMsg(head, e, tail) {
    var m = String((e && e.message) || '');
    if (m) console.warn(head, m);
    return /[가-힣]/.test(m) && !/https?:\/\/|HTTP \d/.test(m) ? head + ': ' + m : head + '. ' + tail;
  }

  /* ══════════════════ 자료 ══════════════════ */
  var ITEMS = {};          // 'me|2026-10' · 'all|2026-10' → { rows } | { err } (받는 중이면 { wait })
  var XAPPR = null;        // 개인경비 결재 건 전부(RLS 가 거른 것). 행마다 _kind = 'expense'
  var XLOCK = {};          // 'user|cyc' → 서버 잠금(expense_cycle_locked)
  function me() { return C.myName(); }
  function isAdmin() { var S = C.state(); return !!(S.ME && S.ME.is_admin); }
  function itemKey(all, cyc) { return (all ? 'all' : 'me') + '|' + cyc; }
  function sortItems(rows) {
    return rows.sort(function (a, b) {
      return (CATS.indexOf(a.category) < 0 ? 9 : CATS.indexOf(a.category)) - (CATS.indexOf(b.category) < 0 ? 9 : CATS.indexOf(b.category)) ||
        Number(a.date_millis) - Number(b.date_millis) || (a.id || 0) - (b.id || 0);
    });
  }
  function loadItems(cyc, all, force) {
    var k = itemKey(all, cyc);
    if (!force && ITEMS[k] && (ITEMS[k].rows || ITEMS[k].wait)) return ITEMS[k].wait || Promise.resolve(ITEMS[k].rows);
    var r = xRangeKey(cyc);
    var p = C.fetchAll('/rest/v1/expense_items?select=*&date_millis=gte.' + r.lo + '&date_millis=lt.' + r.hi +
      (all ? '' : '&username=eq.' + encodeURIComponent(me())) + '&order=date_millis.asc,id.asc')
      .then(function (rows) { ITEMS[k] = { rows: sortItems(rows || []) }; return ITEMS[k].rows; })
      .catch(function (e) { ITEMS[k] = { err: (e && e.authGone) ? '로그인이 만료되었습니다.' : '개인경비를 불러오지 못했습니다.' }; return null; });
    ITEMS[k] = { wait: p };
    if (!all) {
      // 서버 잠금도 물어 둔다(결재 목록을 못 받았을 때의 대비). 실패하면 결재 목록만 본다.
      rest('/rest/v1/rpc/expense_cycle_locked', { method: 'POST', body: JSON.stringify({ p_username: me(), p_ms: r.lo }) })
        .then(function (v) { XLOCK[me() + '|' + cyc] = v === true; }, function () { });
    }
    return p;
  }
  function loadAppr() {
    return C.fetchAll('/rest/v1/expense_approvals?select=*&order=submitted_at.desc')
      .then(function (rows) {
        XAPPR = (rows || []).map(function (a) { a._kind = 'expense'; return a; });
      }).catch(function () { if (!XAPPR) XAPPR = []; });
  }
  function dropItems(cyc) { delete ITEMS[itemKey(false, cyc)]; delete ITEMS[itemKey(true, cyc)]; }
  /** 운행일지 적재(loadAll)와 같이 돈다 — 결재 건과 지금 기간의 내 경비. */
  function loadWith(soft) {
    var S = C.state();
    if (!S.ME) return null;
    if (!soft) ITEMS = {};
    var ps = [loadAppr(), loadItems(S.CYCKEY, false, !soft)];
    if (isAdmin() && ADMIN_X.indexOf(S.VIEW) >= 0) ps.push(loadItems(S.CYCKEY, true, !soft));
    return Promise.all(ps);
  }
  /** 화면이 쓸 줄들. 아직 없으면 받으러 가고 null(그동안 뼈대). */
  function itemsFor(all) {
    var S = C.state(), k = itemKey(all, S.CYCKEY), x = ITEMS[k];
    if (x && x.rows) return x.rows;
    if (x && x.err) return { err: x.err };
    if (!x) loadItems(S.CYCKEY, all).then(function () { if (XVIEWS.indexOf(C.state().VIEW) >= 0) C.render(); });
    return null;
  }
  function xApprOf(u, cyc) {
    return (XAPPR || []).filter(function (a) { return a.username === u && a.cycle === cyc; })[0] || null;
  }
  function myX(cyc) { return xApprOf(me(), cyc || C.state().CYCKEY); }
  function lockedFor(u, cyc) {
    var a = xApprOf(u, cyc);
    if (a && (a.status === 'submitted' || a.status === 'approved')) return true;
    return u === me() && XLOCK[u + '|' + cyc] === true && !(a && (a.status === 'rejected' || a.status === 'withdrawn'));
  }
  function apprById(id) { return (XAPPR || []).filter(function (a) { return String(a.id) === String(id); })[0] || null; }

  /* ══════════════════ 공통 조각 ══════════════════ */
  function sums(rows) {
    var by = {}; CATS.forEach(function (c) { by[c] = { n: 0, sum: 0 }; });
    var all = 0, meal = 0;
    rows.forEach(function (it) {
      var c = by[it.category] ? it.category : '기타비용';
      by[c].n++; by[c].sum += Number(it.amount) || 0; all += Number(it.amount) || 0;
      if (mealOver(it)) meal++;
    });
    return { by: by, all: all, n: rows.length, meal: meal };
  }
  function photoLink(it, label) {
    if (!it.photo_path) return '<span class="dim" style="font-size:11.5px">사진 없음</span>';
    return '<a class="btn sm" target="_blank" rel="noopener" href="' + esc(C.photoUrl(it.photo_path)) + '">' + (label || '사진') + '</a>' +
      (it.scan_path ? ' <a class="btn sm" target="_blank" rel="noopener" title="스캔한 A4 원본" href="' + esc(C.photoUrl(it.scan_path)) + '">원본</a>' : '');
  }
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
    return C.head(title, esc(C.cycleName(S.CYC.y, S.CYC.m)) + ' · <b>' + esc(xSpan(S.CYC.y, S.CYC.m)) + '</b>' + (extra ? ' · ' + extra : ''));
  }
  function notReady(title, x) {
    if (x && x.err) {
      return C.head(title) + '<section class="sect"><div class="panel" style="padding:34px 24px;text-align:center">' +
        '<div style="font-weight:700;margin-bottom:6px">' + esc(x.err) + '</div><div class="dim" style="margin-bottom:16px">잠시 뒤 다시 시도해 주세요.</div>' +
        '<button class="btn pri" data-xreload>다시 불러오기</button></div></section>';
    }
    return C.head(title) + C.skeleton();
  }

  /** 기간 띠(운행일지의 cycleBand 자리) — 지난 기간을 볼 때, 또는 20일이라 기간이 이미 넘어갔을 때. */
  function band() {
    var S = C.state(), cur = xCurrent();
    if (C.cmpCycle(S.CYC, cur) >= 0) return '';
    return '<div class="cycband">' + ic('cal', 15) + '<span>지금 <b>' + S.CYC.y + '년 ' + S.CYC.m + '월분 (' + esc(xSpan(S.CYC.y, S.CYC.m)) +
      ') · 지난 기간</b>을 보고 있습니다. 개인경비는 <b>20일 ~ 다음 달 19일</b>이 한 기간입니다.</span>' +
      '<button class="btn sm" data-cyc="' + cur.y + '-' + cur.m + '">이번 기간(' + cur.m + '월분 ' + esc(xSpan(cur.y, cur.m)) + ')으로 →</button></div>';
  }
  function tag(key) {
    var a = myX(key);
    if (!a) return '';
    var m = { approved: ['결재 완료', 'ok'], submitted: ['결재 중', 'warn'], rejected: ['반려', 'bad'], withdrawn: ['회수', 'dim'] }[a.status];
    return m ? '<span class="st ' + m[1] + '">' + m[0] + '</span>' : '';
  }

  /** 결재 띠 — 상태 · 진행 막대 · 회수. 이번 달 경비·검증 화면 위에. */
  function apprStrip(a) {
    var st = C.apprStatusText(a);
    var canWithdraw = a && a.status === 'submitted' && !(a.steps || []).some(function (x) { return x.result; });
    var btn = canWithdraw ? '<button class="btn sm" data-appr="withdraw" data-kind="expense" data-id="' + a.id + '">회수</button>' : '';
    if (a && (a.status === 'submitted' || a.status === 'approved')) wantSums([a.id]);
    return '<section class="sect" style="margin:0 0 16px"><div class="astrip">' +
      '<div class="ahd"><span class="akind x">개인경비</span><span class="st ' + st.cls + '">' + esc(st.t) + '</span><span style="flex:1"></span>' + btn + '</div>' +
      (a ? C.apprTrack(a) : '<div class="anote" style="margin-top:0">결재선은 상신할 때 결재받을 분의 이름을 넣어 직접 고릅니다. 상신하면 결재함으로 갑니다.</div>') +
      (a && (a.status === 'submitted' || a.status === 'approved') ? extra(a) : '') +
      (a && a.status === 'submitted' ? '<div class="anote">결재 중에는 이 기간의 경비를 고칠 수 없습니다. ' +
        (canWithdraw ? '고치려면 「회수」한 뒤 다시 상신하세요.' : '첫 결재자가 이미 결재해 회수할 수 없습니다 — 반려를 요청하세요.') + '</div>' : '') +
      '</div></section>';
  }

  /* ══════════════════ 이번 달 경비 ══════════════════ */
  var XDAY = '';            // 달력에서 고른 날('YYYY-MM-DD'), '' = 기간 전체
  function viewMonth() {
    var S = C.state();
    if (!S.LOADED) return C.head('이번 달 경비') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('이번 달 경비', '개인경비');
    var rows = itemsFor(false);
    if (!rows || rows.err) return notReady('이번 달 경비', rows);
    var cyc = S.CYCKEY, r = xRangeKey(cyc), a = myX(cyc), locked = lockedFor(me(), cyc);
    var T = sums(rows);
    var h = head('이번 달 경비', '영수증 한 장이 한 줄입니다');
    h += apprStrip(a);
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (a && a.status === 'approved' ? ' ok' : '') + '"></span>' +
      esc(C.cycleName(S.CYC.y, S.CYC.m)) + ' · ' + esc(xSpan(S.CYC.y, S.CYC.m)) + ' · ' + n0(T.n) + '건</div>' +
      '<p class="verdict">' + won(T.all) + '</p><div class="facts">' +
      CATS.map(function (c) { return fact(c, won(T.by[c].sum), n0(T.by[c].n) + '건'); }).join('') +
      fact('식비 기준 초과', n0(T.meal) + '<small>건</small>', '1인 1끼 13,000원 — 알리기만', false) +
      '</div>' +
      (locked ? '' : '<div class="vact" style="margin-top:16px"><button class="btn pri" data-xup="">' + ic('receipt', 14) + '영수증 올리기</button>' +
        (rows.length ? '<button class="btn" data-v="x_verify">검증·상신으로 ' + ic('chev', 13) + '</button>' : '') + '</div>') +
      '</div>';
    if (locked) h += '<div class="hpnote">' + ic('check', 16) + '<span><b>' + (a && a.status === 'approved' ? '결재가 끝난 기간입니다.' : '결재 중인 기간입니다.') +
      '</b> 경비를 더하거나 고칠 수 없습니다.' + (a && a.status === 'approved' ? ' 고칠 것이 있으면 관리자에게 「정정 열기」를 요청하세요.' : '') + '</span></div>';

    h += C.sect('달력', XDAY ? esc(XDAY.slice(5).replace('-', '.')) + ' 고름' : '날을 누르면 그날 것만', XDAY ? '<button class="btn sm" data-xday="">기간 전체 보기</button>' : '', calHtml(rows, r));

    var shown = XDAY ? rows.filter(function (it) { return C.ymd(it.date_millis) === XDAY; }) : rows;
    h += C.sect('내역', shown.length === rows.length ? n0(rows.length) + '건' : n0(shown.length) + ' / ' + n0(rows.length) + '건',
      locked ? '' : '<button class="btn pri sm" data-xup="' + esc(XDAY) + '">' + ic('receipt', 13) + (XDAY ? XDAY.slice(5).replace('-', '.') + ' 영수증 올리기' : '영수증 올리기') + '</button>',
      rows.length ? listHtml(shown, { mine: true, locked: locked })
        : '<div class="panel"><div class="blank"><div class="ico">' + ic('receipt', 21) + '</div><div class="t">이 기간에 올린 경비가 없습니다.</div>' +
          '<div class="d">영수증 사진이나 스캔 PDF 를 올리면 ' + C.gemTag('Gemini') + ' 가 금액·사용처를 읽고 구분·사용내역을 추천합니다.<br>앱(「개인경비」)에서 올린 것도 여기에 모입니다.</div>' +
          (locked ? '' : '<div style="margin-top:16px"><button class="btn pri" data-xup="">' + ic('receipt', 14) + '영수증 올리기</button></div>') + '</div></div>');
    h += '<div class="anote">구분은 <b>소모품비 · 식비 · 기타비용</b>입니다. 식비는 1인 1끼 <b>13,000원</b> 기준 — 넘으면 표시만 합니다 ' +
      '(사용내역에 「3명」·「외 2명」을 적으면 1인당으로 봅니다). 사진 없는 줄은 만들 수 없습니다.</div>';
    return h;
  }

  /** 달력 칸에 들어갈 짧은 금액 — 4,300 → 4.3천, 12,800 → 1.3만, 128,000 → 12.8만, 1,234,000 → 123만. */
  function shortWon(v) {
    v = Math.round(Number(v) || 0);
    if (v < 1000) return String(v);
    if (v < 9950) return (Math.round(v / 100) / 10).toString().replace(/\.0$/, '') + '천';
    var m = v / 10000;
    return (m < 100 ? (Math.round(m * 10) / 10).toString().replace(/\.0$/, '') : String(Math.round(m))) + '만';
  }
  /** 달력 — 기간(20일~19일) 날마다 건수·금액. */
  function calHtml(rows, r) {
    var by = {};
    rows.forEach(function (it) { var d = C.ymd(it.date_millis); by[d] = by[d] || { n: 0, sum: 0, meal: 0 }; by[d].n++; by[d].sum += Number(it.amount) || 0; if (mealOver(it)) by[d].meal++; });
    var today = C.ymd(Date.now());
    var first = C.kd(r.lo), lead = first.getUTCDay();
    var h = '<div class="panel xcalp"><div class="xcal" role="grid" aria-label="날마다 경비">';
    ['일', '월', '화', '수', '목', '금', '토'].forEach(function (w, i) { h += '<div class="xw' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '') + '">' + w + '</div>'; });
    for (var i = 0; i < lead; i++) h += '<div class="xd off" aria-hidden="true"></div>';
    for (var ms = r.lo; ms < r.hi; ms += 86400e3) {
      var d = C.kd(ms), k = C.ymd(ms), x = by[k], dow = d.getUTCDay();
      var lab = (d.getUTCDate() === 1 || ms === r.lo ? (d.getUTCMonth() + 1) + '/' : '') + d.getUTCDate();
      h += '<button class="xd' + (x ? ' has' : '') + (k === XDAY ? ' on' : '') + (k === today ? ' today' : '') + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '') +
        '" data-xday="' + k + '"' + (k === XDAY ? ' aria-pressed="true"' : '') + ' aria-label="' + esc(k + (x ? ' ' + x.n + '건 ' + n0(x.sum) + '원' : ' 없음')) + '">' +
        '<span class="xn">' + lab + '</span>' +
        (x ? '<span class="xc">' + n0(x.n) + '건' + (x.meal ? ' <i class="xm" title="식비 기준 초과">!</i>' : '') + '</span>' +
          // 폰(칸 약 45px)에서는 「12,800」이 잘린다 — 짧은 꼴(「1.3만」·「4.3천」)을 따로 두고 CSS 로 바꿔 보인다.
          '<span class="xa"><span class="xaf">' + n0(x.sum) + '</span><span class="xas" aria-hidden="true">' + shortWon(x.sum) + '</span></span>' : '') + '</button>';
    }
    return h + '</div></div>';
  }

  /** 구분별 표(소계·합계). opt.mine = 내 것(고치기·지우기), opt.who = 이름 칸, opt.locked */
  function listHtml(rows, opt) {
    opt = opt || {};
    var cols = 7 + (opt.who ? 1 : 0);
    var h = '<div class="panel"><div class="scroll" data-rows><table class="xtab"><thead><tr>' +
      '<th>날짜</th>' + (opt.who ? '<th>소속 · 이름</th>' : '') + '<th>사용처</th><th class="n">금액</th><th>사용내역</th><th>비고</th><th>사진</th><th></th></tr></thead><tbody>';
    var total = 0;
    CATS.forEach(function (cat) {
      var list = rows.filter(function (it) { return (CATS.indexOf(it.category) < 0 ? '기타비용' : it.category) === cat; });
      if (!list.length) return;
      var sum = list.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0);
      total += sum;
      h += '<tr class="ogrp xsec"><td colspan="' + cols + '"><div><b>&lt;' + esc(cat) + '&gt;</b><span class="on">' + n0(list.length) + '건</span></div></td></tr>';
      list.forEach(function (it) {
        var can = opt.mine && !opt.locked && it.username === me();
        h += '<tr' + (mealOver(it) ? ' class="xover"' : '') + '><td><span class="lead">' + C.md(it.date_millis) + '</span></td>' +
          (opt.who ? C.orgCell(it.username) : '') +
          '<td class="el" title="' + esc(it.merchant || '') + '">' + esc(it.merchant || '—') + '</td>' +
          // 폰 카드에서는 금액(.xamt)과 식비 초과 표시(.xmealw)를 따로 놓는다(초과 표시가 금액 칸을 넓혀 왼쪽이 눌리던 것, 2026-10-08)
          '<td class="n total"><span class="xamt">' + n0(it.amount) + '</span>' + (mealOver(it) ? '<div class="xmealw">' + mealTag(it) + '</div>' : '') + '</td>' +
          '<td class="el xuse" title="' + esc(it.usage || '') + '">' + (it.usage ? esc(it.usage) : '<span class="st warn">비어 있음</span>') + '</td>' +
          '<td class="el dim xnote" title="' + esc(it.note || '') + '">' + esc(it.note || '') + '</td>' +
          '<td class="xph" style="white-space:nowrap">' + photoLink(it) + '</td>' +
          '<td class="n xact" style="white-space:nowrap">' + (can ? '<button class="btn sm" data-xedit="' + it.id + '">고치기</button> <button class="btn sm" data-xdel="' + it.id + '">지우기</button>' : '') + '</td></tr>';
      });
      h += '<tr class="xsub"><td colspan="' + (opt.who ? 3 : 2) + '">' + esc(cat) + ' 소계</td><td class="n total">' + n0(sum) + '</td><td colspan="4"></td></tr>';
    });
    h += '</tbody><tfoot><tr><td colspan="' + (opt.who ? 3 : 2) + '">합계 ' + n0(rows.length) + '건</td><td class="n total">' + n0(total) + '</td><td colspan="4"></td></tr></tfoot></table></div></div>';
    return h;
  }

  /* ══════════════════ 영수증 올리기 ══════════════════
     운행일지 「영수증 올리기」와 같은 흐름 — 사진·스캔 PDF(여러 장) → 장마다 Gemini 가 영수증을 찾아 줄을 만든다
     (A4 에 여러 장이면 영수증마다 오려 낸다) → 표에서 고친다 → 사진을 evidence/{나}/exp/{키}.jpg 로 올리고 expense_items 에 넣는다. */
  var XUP = { busy: false, items: [], pages: [], sent: false };
  var X_SENDING = false;
  function freeUrls() {
    XUP.pages.forEach(function (p) { if (p.url) URL.revokeObjectURL(p.url); });
    XUP.items.forEach(function (it) { if (it.crop && it.crop.url) URL.revokeObjectURL(it.crop.url); });
  }
  function xNote(m) { var el = $('xNote'); if (el) el.innerHTML = m; }
  function openUpload(day) {
    var S = C.state();
    if (C.isMulti()) { C.toast('경비는 한 기간씩 올립니다. 위에서 기간을 하나 골라 주세요.', true); return; }
    if (lockedFor(me(), S.CYCKEY)) { C.toast('결재 중이거나 끝난 기간이라 올릴 수 없습니다.', true); return; }
    if (X_SENDING) { C.toast('앞서 누른 경비를 아직 올리는 중입니다. 끝난 뒤 다시 열어 주세요.'); return; }
    freeUrls();
    var r = xRangeKey(S.CYCKEY);
    XUP = { busy: false, items: [], pages: [], sent: false, lo: r.lo, hi: r.hi, cyc: S.CYCKEY, defDate: day || '' };
    C.openPanel('영수증 올리기 — 개인경비', C.cycleName(S.CYC.y, S.CYC.m) + ' · ' + xSpan(S.CYC.y, S.CYC.m),
      '<div class="drop gemdrop" id="xDrop" style="margin:0 0 14px">' +
      '<div class="gemorb">' + C.gemSvg(28) + '</div>' +
      '<div class="gemchip">' + C.gemSvg(12) + 'Gemini 가 읽어 줍니다</div>' +
      '<div class="dt">영수증을 올리면 <b class="gemtxt">Gemini</b> 가 금액·사용처를 읽고 구분·사용내역을 추천합니다</div>' +
      '<div class="dd">JPG · PNG · PDF · 여러 장도 됩니다. PC 에서는 여기에 끌어다 놓아도 됩니다<br>' +
      '<b>A4 에 여러 장 붙여 스캔한 것도 그대로</b> 올리세요 — 영수증마다 한 줄씩 나눠 적습니다</div>' +
      '<label class="btn" style="margin-top:14px">파일 고르기<input type="file" id="xFile" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" multiple class="sr"></label>' +
      '</div><div id="xList"></div><div id="xNote" class="fhint" style="margin-top:10px"></div>' +
      '<div class="fhint">' + C.gemTag('Gemini') + ' 가 채운 값은 틀릴 수 있습니다. <b>올리기 전에 사진과 꼭 맞춰 보세요.</b> 처음부터 손으로 써도 됩니다. ' +
      '날짜는 ' + esc(xSpan(S.CYC.y, S.CYC.m)) + ' 안이어야 합니다.</div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnXUpGo" disabled>올리기</button>', true);
    C.bindDrop($('xDrop'), addFiles);
  }
  function blankItem(pi) {
    var d = XUP.defDate || C.ymd(Math.max(XUP.lo, Math.min(Date.now(), XUP.hi - 1)));
    return { page: pi, cat: '', merchant: '', amt: '', usage: '', note: '', date: d, hint: '', crop: null, ai: null };
  }
  function addFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length || XUP.busy) return;
    var big = list.filter(function (f) { return f.size > 30e6; });
    if (big.length) { xNote('<b style="color:var(--red)">30MB 가 넘는 파일이 있습니다: ' + esc(big[0].name) + '</b>'); return; }
    readRows();
    XUP.busy = true;
    var session = XUP, live = function () { return XUP === session; }, fresh = [], chain = Promise.resolve();
    list.forEach(function (file) {
      chain = chain.then(function () {
        if (!live()) return;
        xNote('<b>' + esc(file.name) + '</b> 읽는 중…');
        return C.fileToJpegs(file, function (n, total) { if (live()) xNote('<b>' + esc(file.name) + '</b> ' + n + ' / ' + total + '쪽 바꾸는 중…'); })
          .then(function (blobs) {
            if (!live()) return;
            blobs.forEach(function (b, i) {
              var pi = XUP.pages.length;
              XUP.pages.push({ blob: b, url: URL.createObjectURL(b), ai: '', name: file.name + (blobs.length > 1 ? ' (' + (i + 1) + '/' + blobs.length + '쪽)' : '') });
              XUP.items.push(blankItem(pi)); fresh.push(pi);
            });
          });
      });
    });
    chain.then(function () {
      session.busy = false;
      if (!live()) return;
      xNote(''); paintList();
      if (fresh.length) scanPages(fresh);
    }).catch(function (e) {
      session.busy = false;
      if (!live()) return;
      paintList();
      var m = String((e && e.message) || '');
      xNote('<b style="color:var(--red)">' + esc(m === 'pdfjs' ? 'PDF 를 읽는 도구를 불러오지 못했습니다. 사진으로 올려 주세요.'
        : m === 'toomany' ? 'PDF 가 30장을 넘습니다. 나눠서 올려 주세요.' : m === 'image' ? '이미지를 읽지 못했습니다. 다른 파일로 해 보세요.' : '읽지 못했습니다: ' + m) + '</b>');
    });
  }
  function blobToDataUrl(blob) {
    return new Promise(function (ok, no) { var fr = new FileReader(); fr.onload = function () { ok(String(fr.result || '')); }; fr.onerror = function () { no(new Error('read')); }; fr.readAsDataURL(blob); });
  }
  /** 새 장들을 Gemini 에게 한 장씩 — 찾은 영수증마다 줄. 못 읽으면 그 장은 손으로 넣는 줄로 남는다. */
  function scanPages(idxs) {
    var session = XUP, stop = false;
    idxs.forEach(function (pi) { if (XUP.pages[pi]) XUP.pages[pi].ai = 'run'; });
    readRows(); paintList();
    return idxs.reduce(function (chain, pi) {
      return chain.then(function () {
        var pg = session.pages[pi], swapped = false;
        if (XUP !== session || !pg || pg.ai !== 'run') return;
        if (stop) { pg.ai = ''; return; }
        return blobToDataUrl(pg.blob).then(function (url) { return xai({ op: 'scan', image: url }); })
          .then(function (j) {
            if (j.ai === false) { stop = true; pg.ai = 'off'; return; }
            var recs = (j.receipts || []).filter(function (x, i, all) { return x && (x.kind !== 'unreadable' || all.length === 1); });
            if (XUP !== session || pg.ai !== 'run') return;
            if (!recs.length) { pg.ai = 'none'; return; }
            var many = recs.length > 1;
            return Promise.all(recs.map(function (x) { return many && x.box_2d ? C.evCrop(pg.url, x.box_2d) : Promise.resolve(null); }))
              .then(function (crops) {
                if (XUP !== session || pg.ai !== 'run') return;
                readRows();
                var rows = recs.map(function (x, k) {
                  var it = blankItem(pi), hint = [];
                  it.crop = crops[k]; it.ai = x;
                  it.cat = CATS.indexOf(x.category) >= 0 ? x.category : '';
                  if (x.merchant) it.merchant = String(x.merchant).slice(0, 60);
                  if (x.usage) it.usage = String(x.usage).slice(0, 200);
                  // ★ 음수(환불)는 칸을 비우고 알린다(2026-10-08) — 그대로 두면 칸이 숫자만 남겨 「-5,000」이 5,000원(양수)이 된다.
                  if (x.amount != null && isFinite(Number(x.amount)) && Number(x.amount) < 0) hint.push('금액이 음수(환불)로 읽혔습니다 — 확인해 주세요');
                  else if (x.amount != null && isFinite(Number(x.amount))) it.amt = String(Math.round(Number(x.amount)));
                  else hint.push('금액을 읽지 못했습니다');
                  if (x.date) {
                    var ms = dayMs(x.date);
                    if (isFinite(ms) && ms >= XUP.lo && ms < XUP.hi) it.date = x.date;
                    else { it.date = ''; hint.push('사진의 날짜가 ' + x.date + ' 입니다 — 이 기간(' + xSpanKey(XUP.cyc) + ') 영수증이 아니면 이 줄을 빼 주세요'); }
                  }
                  if (x.legible === false || x.kind === 'unreadable') hint.push('글자가 흐립니다 — 직접 확인해 주세요');
                  it.hint = hint.join(' · ');
                  return it;
                });
                var at = -1;
                session.items = session.items.filter(function (it, i) { if (it.page === pi) { if (at < 0) at = i; return false; } return true; });
                Array.prototype.splice.apply(session.items, [at < 0 ? session.items.length : at, 0].concat(rows));
                pg.ai = 'done'; swapped = true;
              });
          }).catch(function (e) {
            if (XUP !== session) return;
            pg.ai = 'fail';
            if (e && e.status === 429) stop = true;
            if (e && e.message) console.warn('Gemini 읽기 실패:', e.message);
            xNote('<span class="dim">Gemini 가 읽지 못한 장이 있습니다. 그 줄은 직접 넣어 주세요.</span>');
          }).then(function () {
            if (XUP !== session) return;
            if (!swapped) readRows();
            paintList();
          });
      });
    }, Promise.resolve()).then(function () { if (XUP === session) { readRows(); paintList(); } });
  }
  function readRows() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-xrow]'), function (tr) {
      var it = XUP.items[+tr.dataset.xrow];
      if (!it) return;
      var g = function (s) { var el = tr.querySelector(s); return el ? el.value : null; };
      var v;
      if ((v = g('[data-xucat]')) != null) it.cat = v;
      if ((v = g('[data-xdate]')) != null) it.date = v;
      if ((v = g('[data-xmer]')) != null) it.merchant = v;
      if ((v = g('[data-xamt]')) != null) it.amt = String(v).replace(/[^\d]/g, '');
      if ((v = g('[data-xuse]')) != null) it.usage = v;
      if ((v = g('[data-xnote]')) != null) it.note = v;
    });
  }
  function paintList() {
    var box = $('xList'); if (!box) return;
    var n = XUP.items.length, running = XUP.pages.filter(function (p) { return p.ai === 'run'; }).length;
    var b = $('btnXUpGo');
    if (!n) { box.innerHTML = ''; if (b) { b.disabled = true; b.classList.remove('gembtn', 'running'); b.textContent = '올리기'; } return; }
    var perPage = {}, pageNo = {}, seq = 0, prev = -1;
    XUP.items.forEach(function (it) { perPage[it.page] = (perPage[it.page] || 0) + 1; if (pageNo[it.page] == null) pageNo[it.page] = ++seq; });
    var opts = function (cur) { return '<option value="">구분 고르기</option>' + CATS.map(function (c) { return '<option value="' + c + '"' + (cur === c ? ' selected' : '') + '>' + c + '</option>'; }).join(''); };
    box.innerHTML = '<div class="panel"><div class="scroll" data-rows style="max-height:52vh"><table class="evup xup"><thead><tr><th style="width:64px">사진</th>' +
      '<th>구분 · 날짜</th><th>사용처 · 금액</th><th>사용내역 · 비고</th><th></th></tr></thead><tbody>' +
      XUP.items.map(function (it, i) {
        var pg = XUP.pages[it.page] || {}, first = it.page !== prev; prev = it.page;
        var src = (it.crop && it.crop.url) || pg.url;
        var thumb = '<a href="' + src + '" target="_blank" rel="noopener" aria-label="' + (i + 1) + '번째 줄 사진 크게 보기"><img src="' + src + '" alt=""></a>' +
          (perPage[it.page] > 1 ? '<span class="pgno" title="같은 장에서 나온 영수증">' + pageNo[it.page] + '장</span>' : '');
        if (pg.ai === 'run') {
          return '<tr data-xrow="' + i + '" class="evwait' + (first ? ' pgfirst' : '') + '"><td class="evth">' + thumb + '</td>' +
            '<td colspan="3"><div class="gemread">' + C.gemSvg(16, 'spinning') + '<span><b class="gemtxt">Gemini</b> 가 영수증을 읽는 중… 금액·사용처를 읽고 구분·사용내역을 고릅니다</span>' +
            '<i class="gemshim"></i><i class="gemshim s2"></i></div></td>' +
            '<td class="n"><button class="btn sm" data-xskip="' + it.page + '">직접 입력</button></td></tr>';
        }
        var lab = function (t) { return ' aria-label="' + (i + 1) + '번째 ' + t + '"'; };
        return '<tr data-xrow="' + i + '" class="' + (first ? 'pgfirst' : '') + (it.ai ? ' evai' : '') + '"><td class="evth">' + thumb + '</td>' +
          '<td><select class="inp' + (it.cat ? '' : ' need') + '" data-xucat style="width:120px"' + lab('구분') + '>' + opts(it.cat) + '</select>' +
          '<input class="inp' + (it.date ? '' : ' need') + '" type="date" data-xdate style="width:150px;margin-top:6px" value="' + esc(it.date) + '" min="' + C.ymd(XUP.lo) + '" max="' + C.ymd(XUP.hi - 1) + '"' + lab('날짜') + '></td>' +
          '<td><input class="inp" data-xmer maxlength="60" style="width:100%" placeholder="사용처(상호)" value="' + esc(it.merchant) + '"' + lab('사용처') + '>' +
          '<input class="inp num' + (it.amt ? '' : ' need') + '" data-xamt inputmode="numeric" style="width:120px;margin-top:6px" placeholder="금액(원)" value="' + esc(it.amt ? n0(it.amt) : '') + '"' + lab('금액') + '></td>' +
          '<td><input class="inp" data-xuse maxlength="200" style="width:100%" placeholder="사용내역 — 예) 장갑·청소용품 구입, 야간 작업 후 식사(3명)" value="' + esc(it.usage) + '"' + lab('사용내역') + '>' +
          '<input class="inp" data-xnote maxlength="200" style="width:100%;margin-top:6px" placeholder="비고(선택)" value="' + esc(it.note) + '"' + lab('비고') + '>' +
          (it.hint ? '<div class="evhint">' + (it.ai ? C.gemTag() + ' ' : '') + esc(it.hint) + '</div>'
            : it.ai ? '<div class="evhint ok">' + C.gemTag() + ' 가 채웠습니다 — 사진과 맞는지 확인해 주세요</div>' : '') +
          (mealOver({ category: it.cat, amount: it.amt, usage: it.usage }) ? '<div class="evhint">' + mealTag({ category: it.cat, amount: it.amt, usage: it.usage }) + '</div>' : '') + '</td>' +
          '<td class="n" style="white-space:nowrap"><button class="btn sm" data-xaddrow="' + i + '" title="이 장에 영수증이 더 있으면 줄을 늘립니다" aria-label="같은 장에 줄 추가">＋</button> ' +
          '<button class="btn sm" data-xrm="' + i + '">빼기</button></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div style="padding:10px 14px;font-size:12px;color:var(--ink-3)">' + n0(Object.keys(perPage).length) + '장 · 영수증 ' + n0(n) + '건' +
      (running ? ' · <b class="gemtxt">Gemini 가 ' + n0(running) + '장을 읽는 중</b>' : '') + '</div></div>';
    if (b) {
      b.disabled = running > 0;
      b.classList.toggle('gembtn', running > 0); b.classList.toggle('running', running > 0);
      b.innerHTML = running ? C.gemSvg(16) + '<span class="gl">Gemini 가 읽는 중…</span>' : esc(n0(n) + '건 올리기');
    }
  }
  function runUpload() {
    if (XUP.busy) { C.toast('아직 파일을 읽는 중입니다. 잠시만 기다려 주세요.'); return; }
    if (XUP.pages.some(function (p) { return p.ai === 'run'; })) { C.toast('Gemini 가 아직 읽는 중입니다. 기다리거나 「직접 입력」을 눌러 주세요.'); return; }
    if (!XUP.items.length) { C.toast('올릴 영수증 사진을 골라 주세요.', true); return; }
    readRows();
    var mine = me();
    for (var i = 0; i < XUP.items.length; i++) {
      var it = XUP.items[i];
      var bad = function (msg, sel) {
        C.toast((i + 1) + '번째 줄' + msg, true);
        var el = document.querySelector('[data-xrow="' + i + '"] ' + sel); if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
      };
      if (CATS.indexOf(it.cat) < 0) { bad('의 구분을 골라 주세요.', '[data-xucat]'); return; }
      var ms = dayMs(it.date);
      if (!isFinite(ms)) { bad('의 날짜를 골라 주세요.', '[data-xdate]'); return; }
      if (ms < XUP.lo || ms >= XUP.hi) { bad(' 날짜가 ' + cycName(XUP.cyc) + '(' + xSpanKey(XUP.cyc) + ') 밖입니다.', '[data-xdate]'); return; }
      var amt = Number(it.amt || 0);
      if (!isFinite(amt) || amt <= 0 || amt > 5000000) { bad('의 금액을 넣어 주세요(1원 ~ 500만 원).', '[data-xamt]'); return; }
      it.ms = ms; it.amtN = Math.round(amt);
    }
    XUP.busy = true; X_SENDING = true;
    var session = XUP;
    var btn = $('btnXUpGo'); if (btn) { btn.disabled = true; btn.textContent = '올리는 중…'; }
    var total = XUP.items.length, done = 0, base = Date.now();
    var perPage = {};
    XUP.items.forEach(function (x) { perPage[x.page] = (perPage[x.page] || 0) + 1; });
    XUP.pages.forEach(function (p, pi) { if (perPage[pi] > 1) p.multi = true; });
    var upload = function (path, blob) {
      return C.apiRetry('/storage/v1/object/evidence/' + path, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob })
        .then(function (up) { if (!up.ok) return up.text().then(function (t) { throw new Error(t || ('HTTP ' + up.status)); }); });
    };
    // 줄이 서버에 들어가 있는가 — { id, photo_path } 또는 null. 묻지도 못했으면 reject(그때는 아무것도 지우지 않는다).
    var existing = function (key) {
      return rest('/rest/v1/expense_items?username=eq.' + encodeURIComponent(mine) + '&client_key=eq.' + encodeURIComponent(key) + '&select=id,photo_path')
        .then(function (a) { return (Array.isArray(a) && a[0]) || null; });
    };
    session.items.reduce(function (chain, it, i) {
      return chain.then(function () {
        xNote((done + 1) + ' / ' + total + '건 올리는 중…');
        // ★ 2026-10-08: client_key 는 줄마다 한 번만 정하고 다시 올릴 때도 그대로 쓴다 — 응답만 잃고 실제로는
        //   들어간 줄이 있으면 다시 올려도 같은 줄로 알아본다(username+client_key 가 유일). 사진 이름은
        //   두 번째 시도부터 뒤에 -N 을 붙인다(먼저 올라간 사진이 남아 있으면 같은 이름으로는 못 올린다).
        if (it.key == null) it.key = base + i;
        var att = it.tries = (it.tries || 0) + 1;
        var pg = session.pages[it.page], key = it.key, sfx = att > 1 ? '-' + att : '';
        var path = mine + '/exp/' + key + sfx + '.jpg';
        var scanP = Promise.resolve();
        if (pg.multi && !pg.scanPath) {
          var sp = mine + '/exp/scan/' + key + sfx + '.jpg';
          scanP = upload(sp, pg.blob).then(function () { pg.scanPath = sp; });
        }
        return scanP.then(function () { return upload(path, (it.crop && it.crop.blob) || pg.blob); }).then(function () {
          return rest('/rest/v1/expense_items', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              username: mine, client_key: key, date_millis: it.ms, category: it.cat,
              merchant: String(it.merchant || '').trim().slice(0, 60), amount: it.amtN,
              usage: String(it.usage || '').trim().slice(0, 200), note: String(it.note || '').trim().slice(0, 200),
              photo_path: path, scan_path: pg.multi ? (pg.scanPath || '') : '',
              ai: it.ai || null, captured_at: Date.now()
            })
          }).catch(function (e) {
            // ★ 실패로 보여도 줄은 들어갔을 수 있다(응답만 잃음 · 앞 시도에서 이미 들어가 409). 사진을 지우기 전에
            //   서버에 그 줄이 있는지 먼저 묻는다(2026-10-08). 예전에는 바로 지워, 들어간 줄의 사진이 비었다.
            //   · 줄이 있다 → 올라간 것으로 친다. 그 줄이 이번 사진을 안 가리키면(앞 시도 사진) 이번 사진만 지운다.
            //   · 줄이 없다 → 사진만 남기지 않게 지우고 실패로.
            //   · 묻지도 못했다 → 아무것도 지우지 않고 실패로(남는 사진 한 장이 빈 증빙보다 낫다).
            return existing(key).then(function (row) {
              if (row) {
                if (row.photo_path !== path) C.apiRetry('/storage/v1/object/evidence/' + path, { method: 'DELETE' }).catch(function () { });
                return;
              }
              return C.apiRetry('/storage/v1/object/evidence/' + path, { method: 'DELETE' }).catch(function () { })
                .then(function () { throw e; });
            }, function () { throw e; });
          }).then(function () { done++; });
        });
      });
    }, Promise.resolve()).then(function () {
      session.busy = false; session.sent = true; X_SENDING = false;
      if (XUP === session) { freeUrls(); XUP.items = []; XUP.pages = []; }
      dropItems(session.cyc);
      if ($('xDrop')) C.closePanel();
      C.toastOk('경비 ' + n0(done) + '건을 올렸습니다.');
      loadItems(session.cyc, false, true).then(function () { C.render(); });
    }).catch(function (e) {
      session.busy = false; X_SENDING = false;
      session.items.splice(0, done);
      if (btn) btn.disabled = false;
      paintList();
      if (done) { dropItems(session.cyc); loadItems(session.cyc, false, true).then(function () { C.render(); }); }
      xNote('<b style="color:var(--red)">' + esc((done ? done + '건까지 올렸습니다. ' + (total - done) + '건이 남았습니다 — ' : '올리지 못했습니다 — ') + why(e)) + '</b>');
    });
  }

  /* ── 한 줄 고치기 · 지우기 ── */
  var XEDIT = null;         // { id, before(문자열) , newPhoto:{blob,url} }
  function findItem(id) {
    var S = C.state(), lists = [ITEMS[itemKey(false, S.CYCKEY)], ITEMS[itemKey(true, S.CYCKEY)]];
    for (var i = 0; i < lists.length; i++) {
      var rows = lists[i] && lists[i].rows;
      if (rows) for (var j = 0; j < rows.length; j++) if (String(rows[j].id) === String(id)) return rows[j];
    }
    return null;
  }
  function editVals() {
    var v = function (id) { return String(($(id) || {}).value || ''); };
    return { cat: v('xeCat'), date: v('xeDate'), merchant: v('xeMer').trim(), amt: v('xeAmt').replace(/[^\d]/g, ''), usage: v('xeUse').trim(), note: v('xeNote').trim() };
  }
  function openEdit(id) {
    var it = findItem(id);
    if (!it) { C.toast('그 줄을 찾지 못했습니다. 새로고침해 주세요.', true); return; }
    if (lockedFor(it.username, C.state().CYCKEY)) { C.toast('결재 중이거나 끝난 기간이라 고칠 수 없습니다.', true); return; }
    var r = xRangeKey(C.state().CYCKEY);
    var frow = function (lab, id2, body, hint) { return '<div class="frow"><label class="flab" for="' + id2 + '">' + lab + '</label><div class="fbody">' + body + (hint ? '<div class="fhint">' + hint + '</div>' : '') + '</div></div>'; };
    C.openPanel('경비 고치기', C.md(it.date_millis) + ' · ' + (it.category || '') + ' · ' + won(it.amount),
      '<div class="xephoto">' + (it.photo_path ? '<a target="_blank" rel="noopener" href="' + esc(C.photoUrl(it.photo_path)) + '"><img id="xePh" alt="영수증 사진" src="' + esc(C.photoUrl(it.photo_path)) + '"></a>' : '') +
      '<label class="btn sm" style="margin-top:8px">사진 바꾸기<input type="file" id="xePhFile" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" class="sr"></label></div>' +
      '<div class="form">' +
      frow('구분', 'xeCat', '<select class="inp" id="xeCat" style="max-width:200px">' + CATS.map(function (c) { return '<option' + (it.category === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select>') +
      frow('날짜', 'xeDate', '<input class="inp" type="date" id="xeDate" style="max-width:200px" value="' + C.ymd(it.date_millis) + '" min="' + C.ymd(r.lo) + '" max="' + C.ymd(r.hi - 1) + '">', '이 기간(' + esc(xSpanKey(C.state().CYCKEY)) + ') 안의 날만 됩니다.') +
      frow('사용처', 'xeMer', '<input class="inp" id="xeMer" maxlength="60" value="' + esc(it.merchant || '') + '">') +
      frow('금액', 'xeAmt', '<input class="inp num" id="xeAmt" inputmode="numeric" style="max-width:200px" value="' + n0(it.amount) + '">') +
      frow('사용내역', 'xeUse', '<input class="inp" id="xeUse" maxlength="200" value="' + esc(it.usage || '') + '">', '식비는 인원을 적으면(「3명」·「외 2명」) 1인당 금액으로 봅니다.') +
      frow('비고', 'xeNote', '<input class="inp" id="xeNote" maxlength="200" value="' + esc(it.note || '') + '">') +
      '</div>',
      '<button class="btn" data-xdel="' + it.id + '">지우기</button><span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="btnXEditGo" data-id="' + it.id + '">저장</button>');
    XEDIT = { id: it.id, before: JSON.stringify(editVals()), photo: null };
  }
  function saveEdit(id) {
    var it = findItem(id); if (!it) return;
    var v = editVals(), S = C.state(), r = xRangeKey(S.CYCKEY);
    if (CATS.indexOf(v.cat) < 0) { C.toast('구분을 골라 주세요.', true); return; }
    var ms = dayMs(v.date);
    if (!isFinite(ms) || ms < r.lo || ms >= r.hi) { C.toast('날짜가 이 기간(' + xSpanKey(S.CYCKEY) + ') 밖입니다.', true); return; }
    var amt = Number(v.amt);
    if (!(amt > 0 && amt <= 5000000)) { C.toast('금액을 넣어 주세요(1원 ~ 500만 원).', true); return; }
    var btn = $('btnXEditGo'); if (btn) { btn.disabled = true; btn.textContent = '저장하는 중…'; }
    var body = { date_millis: ms, category: v.cat, merchant: v.merchant.slice(0, 60), amount: Math.round(amt), usage: v.usage.slice(0, 200), note: v.note.slice(0, 200) };
    // ★ 사진을 바꾸면 새 이름으로 올린다 — 한 번 상신에 굳은 사진 경로는 반려·회수 뒤에도 덮어쓸 수 없다(서버 약속).
    var ph = XEDIT && XEDIT.id === it.id ? XEDIT.photo : null, newPath = '';
    var up = ph ? (function () {
      newPath = it.username + '/exp/' + (it.client_key || it.id) + '-' + Date.now() + '.jpg';
      return C.apiRetry('/storage/v1/object/evidence/' + newPath, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: ph.blob })
        .then(function (r2) { if (!r2.ok) return r2.text().then(function (t) { throw new Error(t || ('HTTP ' + r2.status)); }); body.photo_path = newPath; body.scan_path = ''; });
    })() : Promise.resolve();
    var saved = function () {
      XEDIT = null; dropItems(S.CYCKEY); C.closePanel(); C.toast('고쳤습니다.');
      loadItems(S.CYCKEY, false, true).then(function () { C.render(); });
    };
    var failed = function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '저장'; }
      C.toast('저장하지 못했습니다 — ' + why(e), true);
    };
    up.then(function () {
      return rest('/rest/v1/expense_items?id=eq.' + encodeURIComponent(it.id), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
    }).then(function (rows) {
      if (!Array.isArray(rows) || !rows.length) throw new Error('EXPENSE_LOCKED');
      saved();
    }).catch(function (e) {
      if (!newPath) { failed(e); return; }
      // ★ 2026-10-08: 새 사진을 바로 지우지 않는다 — 응답만 잃고 실제로는 고쳐졌으면 그 줄이 새 사진을 가리킨다
      //   (지우면 증빙이 빈다). 줄을 다시 읽어 보고: 새 사진을 가리키면 저장된 것, 아니면 새 사진만 지운다.
      //   다시 읽지도 못했으면 지우지 않는다(남는 사진 한 장이 빈 증빙보다 낫다).
      rest('/rest/v1/expense_items?id=eq.' + encodeURIComponent(it.id) + '&select=id,photo_path').then(function (a) {
        var row = Array.isArray(a) && a[0];
        if (row && row.photo_path === newPath) { saved(); return; }
        C.apiRetry('/storage/v1/object/evidence/' + newPath, { method: 'DELETE' }).catch(function () { });
        failed(e);
      }, function () { failed(e); });
    });
  }
  function openDel(id) {
    var it = findItem(id); if (!it) return;
    C.openPanel('경비 지우기', C.md(it.date_millis) + ' · ' + (it.category || '') + ' · ' + won(it.amount),
      '<div class="anote" style="margin-top:0">이 줄을 지웁니다. 되돌릴 수 없습니다.</div>' +
      (it.photo_path ? '<div class="xephoto"><img alt="" src="' + esc(C.photoUrl(it.photo_path)) + '"></div>' : '') +
      '<div class="dim" style="font-size:13px;margin-top:8px">' + esc([it.merchant, it.usage].filter(Boolean).join(' · ')) + '</div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="btnXDelGo" data-id="' + it.id + '">지우기</button>');
  }
  function runDel(id) {
    var it = findItem(id), S = C.state(); if (!it) return;
    var btn = $('btnXDelGo'); if (btn) { btn.disabled = true; btn.textContent = '지우는 중…'; }
    rest('/rest/v1/expense_items?id=eq.' + encodeURIComponent(it.id), { method: 'DELETE', headers: { Prefer: 'return=representation' } })
      .then(function (rows) {
        if (!Array.isArray(rows) || !rows.length) throw new Error('EXPENSE_LOCKED');
        // 사진은 지우지 않는다 — 예전에 상신했던 문서(고정본)가 그 사진을 가리킬 수 있다(지우면 그 문서의 증빙이 빈다).
        dropItems(S.CYCKEY); C.closePanel(); C.toast('지웠습니다.');
        loadItems(S.CYCKEY, false, true).then(function () { C.render(); });
      }).catch(function (e) {
        if (btn) { btn.disabled = false; btn.textContent = '지우기'; }
        C.toast('지우지 못했습니다 — ' + why(e), true);
      });
  }

  /* ══════════════════ 검증 · 상신 ══════════════════
     운행일지 검증 화면과 같은 세 칸: ① 검증하기 → ② PDF 미리보기(열어 봐야 확인) → ③ 결재 상신. 들어올 때마다 ①부터.
     검증 = expense-ai: 아직 안 읽은 사진을 한 장씩 read(「사진 읽는 중 3/12」) → run(규칙 + 읽은 값 대조, expense_verifications 에 저장). */
  var VROWS = {}, VASK = {}, VRUN = { busy: false, note: '', who: '' }, FRESH = {};
  var PREV = (function () { try { return JSON.parse(sessionStorage.getItem('drv.xpreviewed') || '{}'); } catch (e) { return {}; } })();
  function vkey(u, cyc) { return u + '|' + cyc; }
  function sig(u, cyc) {
    var x = ITEMS[itemKey(false, cyc)], rows = (x && x.rows) || [], h = 0;
    var add = function (v) { var s = String(v == null ? '' : v); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; };
    rows.forEach(function (it) { if (it.username !== u) return; add(it.id); add(it.amount); add(it.category); add(it.date_millis); add(it.merchant); add(it.usage); add(it.note); add(it.photo_path); });
    return rows.length + ':' + h;
  }
  function previewOk(k) {
    var v = PREV[k]; if (!v) return false;
    var p = k.split('|'); if (v.sig !== sig(p[0], p[1])) return false;
    var a = xApprOf(p[0], p[1]);
    return !(a && a.submitted_at && Date.parse(a.submitted_at) > v.at);
  }
  function setPreviewed(k, on) {
    var p = k.split('|');
    if (on) PREV[k] = { at: Date.now(), sig: sig(p[0], p[1]) }; else delete PREV[k];
    try { sessionStorage.setItem('drv.xpreviewed', JSON.stringify(PREV)); } catch (e) { }
  }
  function fetchLatest(u, cyc) {
    var k = vkey(u, cyc);
    if (VASK[k]) return VASK[k];
    VASK[k] = rest('/rest/v1/expense_verifications?username=eq.' + encodeURIComponent(u) + '&cycle=eq.' + encodeURIComponent(cyc) + '&select=*&order=created_at.desc&limit=1')
      .then(function (a) { VROWS[k] = (a && a[0]) || null; }, function () { VROWS[k] = null; })
      .then(function () { delete VASK[k]; });
    return VASK[k];
  }
  /** 한 번 검증 — 안 읽은 사진을 읽힌 뒤 규칙 검증. say(글) 로 진행을 알린다. */
  function runVerify(u, cyc, say, quiet) {
    say = say || function () { };
    var admin = u !== me();
    say('사진을 살피는 중…');
    var body = { cycle: cyc }; if (admin) body.username = u;
    return xai({ op: 'status', cycle: cyc, username: admin ? u : undefined }).catch(function () { return {}; }).then(function (st) {
      var unread = Array.isArray(st.unread) ? st.unread : [];
      var total = unread.length, stop = '';
      if (st.ai === false || !total) return { fail: 0 };
      say('사진 읽는 중 0/' + total);
      return C.vx.pool(unread, 2, function (id) {
        if (stop) return Promise.reject(new Error(stop));
        return xai({ op: 'read', item_id: id }).catch(function (e) {
          if (/횟수|한도|429/.test(String(e && e.message)) || (e && e.status === 429)) stop = e.message;
          throw e;
        });
      }, function (n) { say('사진 읽는 중 ' + n + '/' + total); }).then(function (res) { res.stop = stop; return res; });
    }).then(function (res) {
      say('읽은 값을 대조하는 중…');
      return xai({ op: 'run', cycle: cyc, username: admin ? u : undefined }).then(function (j) {
        if (!quiet) {
          if (res.stop) C.toast(res.stop, true);
          else if (res.fail) C.toast('사진 ' + res.fail + '장은 읽지 못했습니다. 다시 검증하면 이어서 읽습니다.', true);
        }
        return j.row || null;
      });
    });
  }
  function startRun(u) {
    var S = C.state(), cyc = S.CYCKEY, k = vkey(u, cyc);
    if (VRUN.busy) return;
    VRUN = { busy: true, note: '사진을 살피는 중…', who: k };
    C.render();
    var p = runVerify(u, cyc, function (t) {
      VRUN.note = t;
      var st = C.state();
      if (st.VIEW === 'x_verify' && st.CYCKEY === cyc) {
        var v = document.querySelector('.hero .verdict .xvnote'); if (v) v.textContent = t;
        var gl = document.querySelector('[data-xvrun] .gl'); if (gl) gl.textContent = t;
      }
    });
    VRUN.p = p;
    p.then(function (row) {
      VROWS[k] = row || null; FRESH[k] = sig(u, cyc); setPreviewed(k, false);
      C.toast(row ? '검증했습니다 — ' + C.vx.sumText(row.summary) : '검증했습니다.');
    }).catch(function (e) { C.toast(failMsg('검증하지 못했습니다', e, '잠시 뒤 다시 눌러 주세요.'), true); })
      .then(function () { VRUN = { busy: false, note: '', who: '' }; C.render(); });
  }
  var LV = { bad: ['불일치', 'bad'], warn: ['확인 필요', 'warn'], info: ['참고', ''] };
  var VITEMS = [];
  function isAiItem(it) { return /^X0[2-5]/.test(String(it && it.code || '')) || /^X06/.test(String(it && it.code || '')) && /승인번호/.test(String(it.detail || '')); }
  function itemsHtml(items, links) {
    if (!items || !items.length) return '<div class="panel"><div class="blank"><div class="ico">' + ic('check', 21) + '</div><div class="t">확인이 필요한 항목이 없습니다.</div></div></div>';
    return '<div class="panel vlist">' + items.map(function (it) {
      var lv = LV[it.level] || LV.info, ref = (it.ref && it.ref.items) || (it.refs && it.refs.items) || [];
      var go = '';
      if (links && ref.length && it.level !== 'info') { VITEMS.push(it); go = '<button class="btn sm vgo vfix" data-xvfix="' + (VITEMS.length - 1) + '">바로 고치기' + ic('chev', 12) + '</button>'; }
      return '<div class="vitem v-' + esc(it.level) + (isAiItem(it) ? ' v-ai' : '') + '"><span class="st ' + lv[1] + '">' + lv[0] + '</span>' +
        '<div class="vb"><div class="vt">' + esc(it.title) + (isAiItem(it) ? ' ' + C.vx.gemBadge() : '') + '</div><div class="vd">' + esc(it.detail || '') + '</div></div>' + go + '</div>';
    }).join('') + '</div>';
  }
  function openFix(it) {
    var ref = ((it && it.ref && it.ref.items) || (it && it.refs && it.refs.items) || []).map(String);
    var S = C.state(), x = ITEMS[itemKey(false, S.CYCKEY)], rows = ((x && x.rows) || []).filter(function (r) { return ref.indexOf(String(r.id)) >= 0; });
    if (rows.length === 1) { openEdit(rows[0].id); return; }
    if (!rows.length) { C.toast('가리키는 줄을 찾지 못했습니다. 「다시 검증하기」를 눌러 주세요.', true); return; }
    C.openPanel('바로 고치기 — ' + it.title, '고친 뒤 「다시 검증하기」를 눌러 주세요',
      '<div class="anote">' + esc(it.detail || '') + '</div><div class="fixl">' + rows.map(function (r) {
        return '<div class="fixi">' + (r.photo_path ? '<a class="fixph" target="_blank" rel="noopener" href="' + esc(C.photoUrl(r.photo_path)) + '"><img alt="" loading="lazy" src="' + esc(C.photoUrl(r.photo_path)) + '"></a>' : '<span class="fixph none">사진 없음</span>') +
          '<div class="fixt"><b>' + C.md(r.date_millis) + ' ' + esc(r.category) + ' ' + n0(r.amount) + '원</b><div class="dim">' + esc([r.merchant, r.usage].filter(Boolean).join(' · ')) + '</div></div>' +
          '<button class="btn sm pri" data-xedit="' + r.id + '">고치기</button></div>';
      }).join('') + '</div>', '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
  }
  function viewVerify() {
    var S = C.state();
    if (!S.LOADED) return C.head('검증·상신') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('검증·상신', '개인경비 검증');
    var rows = itemsFor(false);
    if (!rows || rows.err) return notReady('검증·상신', rows);
    var u = me(), cyc = S.CYCKEY, k = vkey(u, cyc);
    var h = head('검증·상신', '상신하기 전에 영수증과 입력값이 맞는지 살펴봅니다');
    if (VROWS[k] === undefined) { fetchLatest(u, cyc).then(function () { if (C.state().VIEW === 'x_verify') C.render(); }); return h + C.skeleton(); }
    var row = VROWS[k], busy = VRUN.busy && VRUN.who === k, a = myX(cyc);
    var locked = a && (a.status === 'submitted' || a.status === 'approved');
    var s = (row && row.summary) || {}, items = (row && row.result && row.result.items) || [];
    VITEMS = [];
    var verdict, clean = '';
    if (busy) verdict = '<span class="gemrun">' + C.vx.gemBadge('Gemini') + '</span><span class="xvnote">' + esc(VRUN.note || '검증하는 중…') + '</span>';
    else if (!row) verdict = '아직 검증하지 않았습니다';
    else if (s.bad) verdict = '맞지 않는 곳이 <em>' + n0(s.bad) + '건</em> 있습니다';
    else if (s.warn) { verdict = '확인할 것이 <em>' + n0(s.warn) + '건</em> 있습니다'; clean = ' wait'; }
    else { verdict = '<em>이상 없습니다</em>'; clean = ' clean'; }
    var seen = previewOk(k), fresh = FRESH[k] != null && FRESH[k] === sig(u, cyc);   // 검증한 뒤 자료가 바뀌었으면(바로 고치기·지우기·올리기) ①부터 다시
    var stage = locked ? 0 : !row || !fresh ? 1 : !seen ? 2 : 3;
    var canSubmit = !a || a.status === 'rejected' || a.status === 'withdrawn';
    var card = function (n, title, desc, button) {
      var st = stage > n ? 'done' : stage === n ? 'now' : 'todo';
      return '<li class="vstep ' + st + '"' + (st === 'now' ? ' aria-current="step"' : '') + '><div class="vsh"><i>' + (st === 'done' ? '✓' : n) + '</i><b>' + title + '</b></div><p>' + desc + '</p>' + button + '</li>';
    };
    var none = !rows.length;
    var steps = locked ? '' : '<ol class="vsteps" aria-label="상신 순서">' +
      card(1, '검증하기 ' + C.vx.gemBadge('Gemini'),
        none ? '먼저 「이번 달 경비」에서 영수증을 올려 주세요.'
          : busy ? 'Gemini 가 영수증 사진을 읽고 입력값과 맞춰 보는 중입니다…'
          : row && fresh ? 'Gemini 가 사진을 읽어 대조했습니다. 고친 게 있으면 다시 눌러 주세요.'
          : row ? '먼저 지금 자료로 검증해 주세요. 아래는 지난 검증(' + esc(C.vx.whenText(row.created_at)) + ') 결과입니다.'
          : 'Gemini 가 영수증 사진을 읽어 금액·날짜·사용처가 입력과 맞는지, 같은 영수증을 두 번 올리지 않았는지 봅니다.',
        C.vx.gemBtn('data-xvrun' + (VRUN.busy || none ? ' disabled' : ''),
          busy ? (VRUN.note || 'Gemini 가 읽는 중…') : VRUN.busy ? '다른 검증이 도는 중…' : row && fresh ? '다시 검증하기' : '검증하기',
          busy, ' big' + (stage === 1 && !none ? ' pri' + (busy ? '' : ' cta') : ''))) +
      card(2, 'PDF 미리보기', row && fresh ? '결재자에게 갈 지출 명세·영수증을 눈으로 확인합니다.' : '① 검증하기를 먼저 해 주세요.',
        '<button class="btn big' + (stage === 2 ? ' pri cta' : '') + '" data-xpdf=""' + (row && fresh && !busy ? '' : ' disabled') + '>' + ic('dl', 16) + 'PDF 미리보기</button>') +
      card(3, '결재 상신', !canSubmit ? '이미 상신했습니다.' : stage === 3 ? '결재선을 고르고 올립니다.' : 'PDF 미리보기를 먼저 확인해 주세요.',
        canSubmit ? '<button class="btn big' + (stage === 3 ? ' pri cta' : '') + '" id="btnOpenSubmit" data-kind="expense"' + (stage === 3 && !busy ? '' : ' disabled') + '>' +
          (a && a.status === 'rejected' ? '다시 상신' : '결재 상신') + '</button>' : '') + '</ol>';
    h += apprStrip(a);
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (row && !s.bad ? ' ok' : '') + '"></span>' +
      (row ? '마지막 검증 ' + esc(C.vx.whenText(row.created_at)) : '검증 전') + ' · 경비 ' + n0(rows.length) + '건 ' + won(sums(rows).all) + '</div>' +
      '<p class="verdict' + clean + '">' + verdict + '</p>' +
      (row ? '<div class="facts">' + fact('불일치', n0(s.bad), '금액·영수증이 서로 다름', s.bad > 0) + fact('확인 필요', n0(s.warn), '사람이 한 번 봐야 함') +
        fact('참고', n0(s.info), '식비 기준 초과 등 — 알리기만') +
        '<div class="fact"><div class="k">사진 판독 ' + C.vx.gemBadge() + '</div><div class="v">' + (row.ai ? n0(s.read) + ' / ' + n0(s.receipts) + '<small>장</small>' : '—') + '</div><div class="sub">' + (row.ai ? 'Gemini 가 읽은 영수증' : 'Gemini 미설정 — 규칙 검증만') + '</div></div></div>' : '') +
      (locked ? '<div class="vact">' + C.vx.gemBtn('data-xvrun' + (VRUN.busy ? ' disabled' : ''), busy ? (VRUN.note || 'Gemini 가 읽는 중…') : '다시 검증하기', busy, '') +
        '<button class="btn" data-xpdf="">' + ic('dl', 14) + '결재 문서 PDF</button></div>' : steps) + '</div>';
    if (row) {
      var need = items.filter(function (i) { return i.level !== 'info'; }), info = items.filter(function (i) { return i.level === 'info'; });
      h += C.sect('봐야 할 것', need.length ? need.length + '건' : null, '', itemsHtml(need, !locked));
      if (info.length) h += C.sect('참고', info.length + '건', '', itemsHtml(info));
    } else if (!busy) {
      h += '<div class="panel"><div class="blank"><div class="ico">' + ic('scan', 21) + '</div><div class="t">위 ① 「검증하기」를 누르면 이번 기간 경비를 살펴봅니다.</div>' +
        '<div class="d">사진의 금액·날짜·상호가 입력과 같은지, 같은 영수증을 두 번 올리지 않았는지, 사용내역이 비어 있지 않은지 봅니다.<br>' +
        '맞지 않는 곳이 있어도 상신은 할 수 있습니다 — 결재자가 같이 봅니다.</div></div></div>';
    }
    h += '<div class="anote">금액은 입력한 값으로만 더합니다. ' + C.vx.gemBadge('Gemini') + ' 는 <b>입력값과 다른 곳을 표시</b>만 하고 값은 바꾸지 않습니다.</div>';
    return h;
  }
  /** 상신 창이 「상신」을 누른 직후 부른다 — 검증을 돌려 요약을 돌려준다(실패하면 null, 상신은 막지 않음). */
  function beforeSubmit(onNote) {
    var u = me(), cyc = C.state().CYCKEY, k = vkey(u, cyc);
    var say = function (t) { if (onNote) onNote(String(t).replace(/…\s*/g, ' ').trim()); };
    // ★ 2026-10-08: PDF 미리보기 뒤에 경비가 바뀌었으면(다른 탭·앱에서 올리기·고치기·지우기) 상신을 멈춘다 —
    //   결재자에게 가는 것(서버가 상신 순간의 줄을 굳힌다)이 사용자가 눈으로 본 PDF 와 달라진다.
    //   이 기간 내 경비를 서버에서 다시 받아 미리보기 때의 서명(건수·id·금액·내용)과 맞춰 본다.
    //   다시 받지 못했으면 막지 않는다(검증 실패와 같이 — 상신은 서버가 지킨다).
    var seen = PREV[k] ? PREV[k].sig : null;
    say('경비를 다시 확인하는 중');
    return loadItems(cyc, false, true).then(function (rows) {
      if (rows && seen != null && sig(u, cyc) !== seen) {
        setPreviewed(k, false);
        C.closePanel();
        if (C.state().VIEW !== 'x_verify') C.go('x_verify'); else C.render();
        C.toast('미리보기 뒤에 경비가 바뀌었습니다. PDF를 다시 확인해 주세요.', true);
        return { blocked: true };          // driving-app 상신 흐름이 보내지 않고 멈춘다
      }
      if (VRUN.busy && VRUN.who === k && VRUN.p) { say('검증이 끝나기를 기다리는 중'); return VRUN.p.then(function (r) { return (r && r.summary) || null; }, function () { return null; }); }
      return runVerify(u, cyc, say, true).then(function (row) { VROWS[k] = row || null; return (row && row.summary) || null; }).catch(function () { return null; });
    });
  }

  /* ══════════════════ 문서(PDF · 엑셀) ══════════════════ */
  /** 결재란 — 운행기록부와 같은 규칙. 담당 = 상신자, 승인한 칸만 이름·날짜·서명, 결재선에 없는 칸은 빗금. */
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
  function docItems(rows) {
    return sortItems(rows.slice()).map(function (it) {
      return { id: it.id, date: C.ymd(it.date_millis), category: CATS.indexOf(it.category) < 0 ? '기타비용' : it.category, merchant: it.merchant || '', amount: Number(it.amount) || 0,
        usage: it.usage || '', note: it.note || '', path: it.photo_path || '' };
    });
  }
  function periodLabel(cyc) { var r = xRangeKey(cyc); return cycName(cyc) + '  (기간 : ' + C.ymd(r.lo) + ' ~ ' + C.ymd(r.hi - 1) + ')'; }
  /** 엑셀 제목 아래 줄 — 「2026년 10월분 (2026-09-20 ~ 2026-10-19)」. */
  function periodText(cyc) { var r = xRangeKey(cyc); return cycName(cyc) + ' (' + C.ymd(r.lo) + ' ~ ' + C.ymd(r.hi - 1) + ')'; }
  function personOf(u, fz) {
    var p = (fz && fz.person) || {}, o = C.orgPath(u), q = C.personOf(u);
    return { name: p.name || q.name || C.nameOf(u), dept: p.dept || [C.orgName(o), o.unit].filter(Boolean).join(' ') || q.dept || '', position: p.position || q.position || '' };
  }
  /** PDF 재료 하나(사람 × 기간). */
  function xDoc(u, cyc, rows, a, fz, verify, mark, docNo) {
    var p = personOf(u, fz);
    var boxes = boxesOf(a, p.name);
    var its = docItems(rows);
    return {
      meta: { name: p.name, cycleName: cycName(cyc) + ' 개인경비', mark: mark, docNo: docNo },
      person: p, periodLabel: periodLabel(cyc), periodText: periodText(cyc), boxes: boxes, items: its, verify: verify,
      sheets: [{ boxes: boxes }]               // fillSigns 가 결재란 서명을 여기에 채운다(같은 객체)
    };
  }
  function vOf(v) { return v ? { ranAt: C.vx.whenText(v.ran_at || v.created_at), ai: !!v.ai, summary: v.summary || {}, items: v.items || (v.result && v.result.items) || [] } : null; }
  function showPdf(d, o) {
    var nImg = d.items.filter(function (i) { return i.path; }).length;
    return C.vx.makePdf({
      doc: { sheets: d.sheets, scans: [], photos: [] }, nImg: nImg, verify: d.verify, title: o.title, sub: o.sub, file: o.file,
      note: o.note, expect: o.expect, expectName: o.expectName, okKey: o.okKey || '', okAttr: 'data-xpdfok', meta: d.meta,
      // 명세가 길면 2장 이상 — 실제로 그린 쪽 수(sheetpdf totals[0].pages)로 적는다.
      stat: function (res) { var t = (res && res.totals && res.totals[0]) || {}; return '지출 명세 ' + n0(t.pages || 1) + '장 · ' + n0(d.items.length) + '건'; },
      build: function (lib, loadImage) {
        return window.SheetPdf.buildExpense(d, { PDFLib: lib.PDFLib, fontkit: lib.fontkit, fontRegular: lib.fontRegular, fontBold: lib.fontBold, loadImage: loadImage });
      }
    }).catch(function () { });
  }
  /** 상신 전 미리보기(지금 자료). 결재 중·완료면 고정본으로. */
  function pdfMine() {
    var S = C.state(), u = me(), cyc = S.CYCKEY, a = myX(cyc);
    if (a && (a.status === 'submitted' || a.status === 'approved')) { pdfFrozen(a.id); return; }
    var x = ITEMS[itemKey(false, cyc)], rows = ((x && x.rows) || []).filter(function (it) { return it.username === u; });
    if (!rows.length) { C.toast('이 기간에 담을 경비가 없습니다.', true); return; }
    var k = vkey(u, cyc), go = function () {
      var now = C.vx.whenText(new Date().toISOString());
      var d = xDoc(u, cyc, rows, null, null, vOf(VROWS[k]), 'preview', '상신 전 미리보기 · ' + now + ' 출력');
      showPdf(d, { title: 'PDF 미리보기 — 개인경비', sub: d.person.name + ' · ' + cycName(cyc) + ' (' + xSpanKey(cyc) + ')',
        file: '개인경비_지출명세_' + C.vx.safeName(d.person.name) + '_' + cyc + '_미리보기.pdf',
        expect: sums(rows).all, expectName: '화면 합계', okKey: k });
    };
    if (VROWS[k] === undefined) fetchLatest(u, cyc).then(go); else go();
  }
  var FZ = {}, FZSUM = {}, FZFAIL = {}, FZASK = '';
  function fzKey(a) { return a.id + '|' + (a.submitted_at || ''); }
  function fetchFrozen(a) {
    var k = fzKey(a);
    if (FZ[k] !== undefined) return Promise.resolve(FZ[k]);
    return rest('/rest/v1/expense_frozen?approval_id=eq.' + encodeURIComponent(a.id) + '&select=*&limit=1')
      .then(function (rows) { FZ[k] = (rows && rows[0]) || null; return FZ[k]; });
  }
  function frozenDoc(a, fz) {
    var data = fz.data || {}, rows = (data.items || []).map(function (it) { return it; });
    var done = a.status === 'approved';
    var mark = done ? '' : a.status === 'submitted' ? 'pending' : a.status === 'rejected' ? 'rejected' : 'withdrawn';
    return xDoc(a.username, a.cycle, rows, a, data, vOf(fz.verify), mark,
      '개인경비 결재 #' + a.id + ' · 상신 ' + C.vx.whenText(fz.frozen_at || a.submitted_at) + (done && a.closed_at ? ' · 완료 ' + C.vx.whenText(a.closed_at) : ''));
  }
  function pdfFrozen(id) {
    var a = apprById(id);
    if (!a) { C.toast('결재 건을 찾지 못했습니다.', true); return; }
    fetchFrozen(a).then(function (fz) {
      if (!fz) { C.toast('상신 때 저장한 자료를 찾지 못했습니다. 관리자에게 알려 주세요.', true); return; }
      var d = frozenDoc(a, fz), done = a.status === 'approved';
      showPdf(d, { title: done ? '결재 완료본 — 개인경비' : a.status === 'submitted' ? '결재 문서 — 개인경비' : '상신했던 문서 — 개인경비',
        sub: d.person.name + ' · ' + cycName(a.cycle) + ' (' + xSpanKey(a.cycle) + ')',
        file: '개인경비_지출명세_' + C.vx.safeName(d.person.name) + '_' + a.cycle + ({ '': '_결재완료', pending: '_결재중', rejected: '_반려', withdrawn: '_회수' }[d.meta.mark]) + '.pdf',
        expect: (a.snapshot || {}).cost, expectName: '상신 때 집계한 금액' });
    }).catch(function () { C.toast('결재 문서를 불러오지 못했습니다. 잠시 뒤 다시 해 보세요.', true); });
  }

  /* ── 엑셀(사용자 양식) ──
     docs/expense/개인경비 지출명세서_양식.xlsx 와 같은 칸: 순번·날짜·사용처·금액·사용내역·비고,
     제목 · 기간 줄 · 결재란 5칸(담당·팀장·실장·사업부장·대표이사, 운행일지와 같은 규칙) · 부서·이름 띠,
     <소모품비>·<식비>·<기타비용> 묶음(가운데)마다 줄·소계(SUM), 합계(소계의 합), 별첨 문구. A4 세로, 폭에 맞춤.
     ★ 양식을 엑셀로 인쇄한 모습과 같게(2026-10-08): 열 폭은 양식 그대로(A 3.5 · B 5.75 · C 18.75 · D 20.25 · E 20.25 · F 31.125 · G 22.375 · H 9),
       행 높이 28.5, 띠·합계 파랑(#9BC2E6), 머리글 노랑(#FFFF99)·굴림 12 굵게, 제목 맑은 고딕 22 굵게·밑줄, 칸은 모두 가운데, 소계·묶음은 칠 없음.
     ★ 결재란은 양식 그림 자리(오른쪽 위, 표 오른쪽 끝을 조금 넘는다)에 칸으로 그린다 — 「결 재」 세로 칸 + 5칸(머리 22 · 서명 50, 바깥 굵은 선).
       칸 경계를 만들려고 양식의 F·G·H 열을 잘게 나눴다: F → F(9.5)·G(4.375 「결 재」)·H·I(8.625), G → J·K(8.625)·L(5.125), H → M(3.5)·N(5.5).
       그래서 표의 사용내역은 F:I, 비고는 J:L 를 합쳐 쓰고(폭은 양식과 같다), 결재 칸은 H·I·J·K·L:M 이다. sheetpdf.js 의 PDF 도 같은 자리·크기로 그린다.
     ★ 제목은 B:F 를 합쳐 오른쪽 맞춤 + 들여쓰기 3 — 결재란과 떨어져 끝나 양식처럼 표 가운데쯤에 온다.
     ★ 쪽 나눔은 PDF 와 같은 규칙으로 손수(rowBreaks) — 묶음 머리·소계·합계가 쪽 끝/첫머리에 홀로 남지 않게.
     ★ 소계·합계는 수식을 두고 계산한 값(<v>)도 같이 적는다 — 수식을 계산하지 않는 보기 프로그램에서도 숫자가 보인다.
     ★ 날짜는 진짜 엑셀 날짜(일련번호 + yyyy-mm-dd), 금액은 양식과 같은 회계 서식(0 은 「-」).
     ★ 긴 사용처·사용내역·비고는 줄을 바꿔 다 보이게 하고, 행 높이는 글자 수로 어림해 늘린다(2~6줄).
     ★ 인쇄: 양식과 같은 여백·가로 가운데·폭에 맞춤, 머리글 줄을 쪽마다 되풀이(Print_Titles), 인쇄 영역 A1:N끝. */
  var XL_BD = function (l, r, t, b, diag) {
    var s = function (tag, v) { return v ? '<' + tag + ' style="' + v + '"><color indexed="64"/></' + tag + '>' : '<' + tag + '/>'; };
    return '<border' + (diag ? ' diagonalUp="1"' : '') + '>' + s('left', l) + s('right', r) + s('top', t) + s('bottom', b) +
      (diag ? '<diagonal style="thin"><color indexed="64"/></diagonal>' : '<diagonal/>') + '</border>';
  };
  var XL_XF = function (numFmt, font, fill, border, align) {
    return '<xf numFmtId="' + numFmt + '" fontId="' + font + '" fillId="' + fill + '" borderId="' + border + '"' + (numFmt ? ' applyNumberFormat="1"' : '') +
      ' applyFont="1" applyFill="1" applyBorder="1"' + (align ? ' applyAlignment="1"><alignment ' + align + '/></xf>' : '/>');
  };
  var XL_C = 'horizontal="center" vertical="center"';
  var XL_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0"/>' +
    '<numFmt numFmtId="165" formatCode="_-* #,##0_-;\\-* #,##0_-;_-* &quot;-&quot;_-;_-@_-"/><numFmt numFmtId="166" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
    '<fonts count="9"><font><sz val="11"/><name val="맑은 고딕"/></font>' +                    // 0 기본
    '<font><b/><u/><sz val="22"/><name val="맑은 고딕"/></font>' +                              // 1 제목
    '<font><b/><sz val="12"/><name val="맑은 고딕"/></font>' +                                  // 2 띠·합계
    '<font><sz val="12"/><name val="맑은 고딕"/></font>' +                                      // 3 묶음·순번·별첨
    '<font><b/><sz val="12"/><name val="굴림"/></font>' +                                       // 4 머리글
    '<font><sz val="12"/><name val="굴림"/></font>' +                                           // 5 내용
    '<font><sz val="11"/><name val="굴림"/></font>' +                                           // 6 날짜
    '<font><sz val="10"/><name val="맑은 고딕"/></font>' +                                      // 7 결재란
    '<font><sz val="10"/><color rgb="FF595959"/><name val="맑은 고딕"/></font></fonts>' +       // 8 기간 줄
    '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF9BC2E6"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF99"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="13">' + [
      XL_BD(), XL_BD('thin', 'thin', 'thin', 'thin'),                                  // 0 없음 · 1 가는 선
      XL_BD('thin', 'thin', 'thin', 'thin', 1),                                        // 2 (예전 빗금 — 쓰지 않음)
      XL_BD('thin', '', 'thin', 'thin'), XL_BD('', '', 'thin', 'thin'), XL_BD('', 'thin', 'thin', 'thin'),   // 3·4·5 띠 왼쪽·가운데·오른쪽(칸 사이 세로줄 없음)
      XL_BD('medium', 'thin', 'medium', 'medium'),                                     // 6 「결 재」
      XL_BD('thin', 'thin', 'medium', 'thin'), XL_BD('thin', 'medium', 'medium', 'thin'),   // 7·8 결재 머리 · 마지막 칸
      XL_BD('thin', 'thin', 'thin', 'medium'), XL_BD('thin', 'medium', 'thin', 'medium'),   // 9·10 서명 자리 · 마지막 칸
      // 결재선에 없는 결재 칸 — 빗금 「/」(왼쪽 아래 → 오른쪽 위). PDF 결재란·사용자 결정(빈칸 빗금 /)과 같다.
      XL_BD('thin', 'thin', 'thin', 'medium', 1), XL_BD('thin', 'medium', 'thin', 'medium', 1)   // 11·12
    ].join('') + '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="28">' + [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>',                                  // 0
      XL_XF(0, 1, 0, 0, 'horizontal="right" vertical="center" indent="3"'),                     // 1 제목(B:F 오른쪽 맞춤, 결재란과 띄움)
      XL_XF(0, 8, 0, 0, 'horizontal="left" vertical="bottom"'),                                 // 2 기간 줄
      XL_XF(0, 2, 2, 3, 'vertical="center"'),                                                   // 3 띠 왼쪽 끝
      XL_XF(0, 2, 2, 4, 'vertical="center"'),                                                   // 4 띠 가운데
      XL_XF(0, 2, 2, 4, XL_C + ' shrinkToFit="1"'),                                             // 5 띠 글자(F:L)
      XL_XF(0, 2, 2, 5, XL_C + ' shrinkToFit="1"'),                                             // 6 띠 오른쪽 끝
      XL_XF(0, 4, 3, 1, XL_C + ' wrapText="1"'),                                                // 7 머리글
      XL_XF(0, 3, 0, 1, XL_C + ' shrinkToFit="1"'),                                             // 8 묶음 <식비>
      XL_XF(0, 3, 0, 1, XL_C + ' shrinkToFit="1"'),                                             // 9 순번
      XL_XF(166, 6, 0, 1, XL_C + ' shrinkToFit="1"'),                                           // 10 날짜
      XL_XF(0, 6, 0, 1, XL_C + ' shrinkToFit="1"'),                                             // 11 날짜(글자)
      XL_XF(0, 5, 0, 1, XL_C + ' wrapText="1"'),                                                // 12 사용처·사용내역·비고
      XL_XF(165, 5, 0, 1, 'vertical="center" shrinkToFit="1"'),                                 // 13 금액(회계)
      XL_XF(0, 5, 0, 1, XL_C),                                                                  // 14 소계
      XL_XF(0, 5, 0, 1, ''),                                                                    // 15 빈 칸
      XL_XF(0, 2, 2, 1, XL_C),                                                                  // 16 합계
      XL_XF(165, 2, 2, 1, 'vertical="center" shrinkToFit="1"'),                                 // 17 합계 금액
      XL_XF(0, 3, 2, 1, 'vertical="center"'),                                                   // 18 합계 줄 빈 칸
      XL_XF(0, 3, 0, 0, 'vertical="center"'),                                                   // 19 별첨 문구
      XL_XF(0, 7, 0, 6, XL_C + ' wrapText="1"'),                                                // 20 「결 재」
      XL_XF(0, 7, 0, 7, XL_C + ' shrinkToFit="1"'),                                             // 21 결재 머리
      XL_XF(0, 7, 0, 8, XL_C + ' shrinkToFit="1"'),                                             // 22 결재 머리 — 마지막 칸
      XL_XF(0, 7, 0, 9, XL_C + ' wrapText="1"'),                                                // 23 서명 자리
      XL_XF(0, 7, 0, 10, XL_C + ' wrapText="1"'),                                               // 24 서명 자리 — 마지막 칸
      XL_XF(0, 7, 0, 11, XL_C),                                                                 // 25 서명 자리 — 빗금
      XL_XF(0, 7, 0, 12, XL_C),                                                                 // 26 서명 자리 — 빗금, 마지막 칸
      XL_XF(0, 2, 2, 3, 'horizontal="right" vertical="center" indent="1" shrinkToFit="1"')     // 27 띠 글자 — 부서가 길 때(B:L)
    ].join('') + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  /** 'YYYY-MM-DD' → 엑셀 날짜 일련번호(1900 체계). 못 읽으면 null. */
  function xlDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400e3);
  }
  /** 글자가 칸 폭(엑셀 폭 단위)에서 몇 줄이 될지 어림한다 — 12pt 맑은 고딕, 한글은 약 2.1, 나머지 약 1.1(엑셀로 열어 본 실측에 맞춤). */
  function xlLines(s, width) {
    var per = Math.max(1, width - 0.5);
    return String(s || '').split('\n').reduce(function (n, part) {
      var u = 0;
      Array.from(part).forEach(function (ch) {
        var cp = ch.codePointAt(0);
        u += (cp >= 0x1100 && cp <= 0x11FF) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFF00 && cp <= 0xFF60) ? 2.1 : 1.1;
      });
      return n + Math.max(1, Math.ceil(u / per));
    }, 0);
  }
  // 양식 열 폭 그대로(F = F~I 31.125, G = J~L 22.375, H = M~N 9). 결재 칸 H·I·J·K·L+M 은 모두 69px(8.625 = 5.125 + 3.5)로 같다.
  var XL_W = { A: 3.5, B: 5.75, C: 18.75, D: 20.25, E: 20.25, F: 9.5, G: 4.375, H: 8.625, I: 8.625, J: 8.625, K: 8.625, L: 5.125, M: 3.5, N: 5.5 };
  var XL_USE = 31.125, XL_NOTE = 22.375;                // 사용내역(F:I) · 비고(J:L) 폭 — 줄 수 어림에 쓴다
  var XL_SHEET = '개인경비';
  /** 엑셀에 쓸 글자 정리 — PDF(sheetpdf clean)처럼: 풀어쓴 한글은 모아 쓰고, 탭·전각 공백·nbsp 는 공백,
   *  보이지 않는 글자(폭 없는 공백·BOM·개체 자리표 U+FFFC/FFFD)는 지운다(엑셀에서 □ 로 보인다). 줄바꿈은 남긴다(칸 안 줄 바꿈). */
  // 줄바꿈(CR·U+2028/2029) → \n, 탭·nbsp·전각 공백 → 공백, 폭 없는 공백 U+200B~200F·BOM·U+FFFC/FFFD → 지움.
  //   특수 글자는 소스에 직접 쓰지 않고 코드 번호로 만든다(편집기가 보이지 않는 글자로 바꾸거나 줄바꿈으로 깨뜨리지 않게).
  var XL_NL = new RegExp('\r\n?|[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
  var XL_SP = new RegExp('[\t' + String.fromCharCode(0xA0, 0x3000) + ']', 'g');
  var XL_GONE = new RegExp('[' + String.fromCharCode(0x200B) + '-' + String.fromCharCode(0x200F) + String.fromCharCode(0xFEFF, 0xFFFC, 0xFFFD) + ']', 'g');
  function xlText(v) {
    var s = String(v == null ? '' : v);
    if (s.normalize) s = s.normalize('NFC');
    return s.replace(XL_NL, '\n').replace(XL_SP, ' ').replace(XL_GONE, '');
  }
  // 인쇄 한 쪽에 들어가는 시트 높이(pt) — A4 842pt − 위아래 여백 1cm×2 ≈ 785pt 를 폭 맞춤 배율(시트 폭 786pt → 약 0.74)로 나눈 값 ≈ 1060.
  // 엑셀 배율 반올림·글꼴 차이를 생각해 조금 줄여 잡는다. 이보다 앞에서 우리가 손수 쪽을 나눈다(rowBreaks).
  var XL_PAGE = 1010;
  function xlsxBytes(d) {
    var X = window.Xlsx, cell = function (col, row, s, v, o) {
      var ref = X.colName(col) + row; o = o || {};
      if (o.f) return '<c r="' + ref + '" s="' + s + '"><f>' + X.esc(v) + '</f>' + (o.v != null ? '<v>' + o.v + '</v>' : '') + '</c>';
      if (v == null || v === '') return '<c r="' + ref + '" s="' + s + '"/>';
      if (o.n) return '<c r="' + ref + '" s="' + s + '"><v>' + v + '</v></c>';
      return '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + X.esc(xlText(v)) + '</t></is></c>';
    };
    // 열 번호(0 = A): 순번 B · 날짜 C · 사용처 D · 금액 E · 사용내역 F:I · 비고 J:L · 「결 재」 G · 결재 칸 H·I·J·K·L:M
    var B = 1, C = 2, D = 3, E = 4, F = 5, G = 6, H = 7, I = 8, J = 9, K = 10, L = 11, M = 12, N = 13, rows = '', merges = [], r, c;
    var line = function (rr, ht, cells) { rows += '<row r="' + rr + '"' + (ht ? ' ht="' + ht + '" customHeight="1"' : '') + '>' + cells + '</row>'; };
    var fillRow = function (rr, s, from, to) { var h = ''; for (c = from; c <= to; c++) h += cell(c, rr, s); return h; };
    var ref = function (col, rr) { return X.colName(col) + rr; };
    // 사용내역(F:I) · 비고(J:L) 를 합친 칸
    var useNote = function (rr, s, use, note) { merges.push(ref(F, rr) + ':' + ref(I, rr), ref(J, rr) + ':' + ref(L, rr)); return cell(F, rr, s, use) + fillRow(rr, s, G, I) + cell(J, rr, s, note) + fillRow(rr, s, K, L); };
    // 1~3행: 제목(B2:F3, 오른쪽 맞춤) + 결재란(G2:M3). 4행: 기간 줄(양식에는 없는 줄 — 어느 기간 문서인지 밝힌다).
    var BX = ['담당', '팀장', '실장', '사업부장', '대표이사'], BXC = [H, I, J, K, L];
    line(1, 6, '');
    line(2, 22, cell(B, 2, 1, '개인경비 지출 명세') + fillRow(2, 1, C, F) + cell(G, 2, 20, '결\n\n재') +
      BX.map(function (b, i) { return cell(BXC[i], 2, 21, b); }).join('') + cell(M, 2, 22));
    line(3, 50, fillRow(3, 1, B, F) + cell(G, 3, 20) + BX.map(function (b, i) {
      var v = d.boxes[b], last = i === 4, s = v ? (last ? 24 : 23) : (last ? 26 : 25);
      return cell(BXC[i], 3, s, !v ? '' : v.name ? v.name + (v.date ? '\n' + v.date : '') : '');
    }).join('') + cell(M, 3, d.boxes['대표이사'] ? 24 : 26));
    merges.push('B2:F3', 'G2:G3', 'L2:M2', 'L3:M3');
    line(4, 40.5, cell(B, 4, 2, d.periodText || '') + fillRow(4, 2, C, F)); merges.push('B4:F4');
    // 5행: 부서·이름 띠 — 파랑 한 줄, 칸 사이 세로줄 없음. 글자는 사용내역·비고(F:L) 위 가운데 굵게(길면 줄여 맞춘다).
    // 부서 이름이 길어 F:L 에 한 줄로 안 들어가면 띠 전체(B:L)를 합쳐 오른쪽 끝에 맞춘다(PDF 와 같다).
    var band = '부서 :  ' + (d.person.dept || '') + '          이름 :  ' + (d.person.name || '');
    if (xlLines(band, XL_USE + XL_NOTE) > 1) {
      line(5, 28.5, cell(B, 5, 27, band) + fillRow(5, 4, C, K) + cell(L, 5, 6));
      merges.push('B5:L5');
    } else {
      line(5, 28.5, cell(B, 5, 3) + fillRow(5, 4, C, E) + cell(F, 5, 5, band) + fillRow(5, 5, G, K) + cell(L, 5, 6));
      merges.push('F5:L5');
    }
    var HEADR = 6;
    line(HEADR, 28.5, cell(B, HEADR, 7, '순번') + cell(C, HEADR, 7, '날 짜') + cell(D, HEADR, 7, '사용처') + cell(E, HEADR, 7, '금액') +
      useNote(HEADR, 7, '사용내역', '비고'));
    r = HEADR + 1;
    // ── 쪽 나눔 — PDF(sheetpdf drawExpense)와 같은 규칙으로 우리가 손수 나눈다(엑셀 자동 나눔에 맡기면 마지막 쪽에 소계·합계만 남는다).
    //   묶음 머리는 첫 줄과 함께(줄이 0~1건이면 소계·합계까지), 묶음 마지막 줄은 소계와 함께, 마지막 소계는 합계·별첨과 함께.
    //   다음 쪽엔 머리글 줄(Print_Titles)이 되풀이되므로 그 높이부터 센다.
    var used = 6 + 22 + 50 + 40.5 + 28.5 + 28.5, brks = [];
    var fit = function (h) { if (used + h > XL_PAGE) { brks.push(r - 1); used = 28.5; } };
    var body = function (ht, cells) { fit(ht); line(r, ht, cells); used += ht; };
    var itemHt = function (it) {
      if (!it) return 28.5;
      // 긴 글은 다 보이게 — 줄 수만큼 늘린다(엑셀 행 높이 상한 409pt 안에서, 24줄).
      var n = Math.min(24, Math.max(xlLines(xlText(it.merchant), XL_W.D), xlLines(xlText(it.usage), XL_USE), xlLines(xlText(it.note), XL_NOTE)));
      return Math.max(28.5, n * 16.5 + 8);
    };
    var FOOT = 28.5 + 17.25;                               // 합계 줄 + 별첨 문구
    var gsx = window.SheetPdf.expenseGroups(d.items);
    var subs = [], total = 0;
    gsx.forEach(function (g, gi) {
      var rowsG = g.list.length ? g.list : [null], tail = 28.5 + (gi === gsx.length - 1 ? FOOT : 0);
      fit(28.5 + itemHt(rowsG[0]) + (rowsG.length <= 1 ? tail : 0));
      body(28.5, cell(B, r, 8, '<' + g.cat + '>') + fillRow(r, 8, C, L)); merges.push('B' + r + ':L' + r); r++;
      var first = r, sum = 0;
      rowsG.forEach(function (it, k) {
        var ht = itemHt(it);
        if (k === rowsG.length - 1) fit(ht + tail);
        if (!it) { body(ht, cell(B, r, 9) + cell(C, r, 10) + cell(D, r, 12) + cell(E, r, 13) + useNote(r, 12)); r++; return; }
        var amt = Math.round(Number(it.amount) || 0), ds = xlDate(it.date);
        sum += amt;
        body(ht, cell(B, r, 9, String(k + 1), { n: 1 }) +
          (ds != null ? cell(C, r, 10, String(ds), { n: 1 }) : cell(C, r, 11, it.date)) + cell(D, r, 12, it.merchant) +
          cell(E, r, 13, String(amt), { n: 1 }) + useNote(r, 12, it.usage, it.note));
        r++;
      });
      total += sum;
      fit(tail);
      body(28.5, cell(B, r, 15) + cell(C, r, 15) + cell(D, r, 14, '소계') + cell(E, r, 13, 'SUM(E' + first + ':E' + (r - 1) + ')', { f: 1, v: sum }) +
        useNote(r, 15));
      subs.push('E' + r); r++;
    });
    fit(FOOT);
    body(28.5, cell(B, r, 16, '합계') + cell(C, r, 16) + cell(D, r, 16) + cell(E, r, 17, subs.join('+'), { f: 1, v: total }) + useNote(r, 18));
    merges.push('B' + r + ':D' + r); r++;
    line(r, 0, cell(B, r, 19, '* 해당 증빙은 명세서 기재순으로 별첨'));
    var cols = Object.keys(XL_W).map(function (Lt, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + XL_W[Lt] + '" customWidth="1"/>'; }).join('');
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="B2:M' + r + '"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="17.25"/><cols>' + cols + '</cols>' +
      '<sheetData>' + rows + '</sheetData><mergeCells count="' + merges.length + '">' + merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>' +
      // 양식과 같은 인쇄 설정 — 좌우 여백 0.2cm, 위아래 1cm, 가로 가운데, 폭 1쪽에 맞춤.
      '<printOptions horizontalCentered="1"/><pageMargins left="0.0787" right="0.0787" top="0.3937" bottom="0.3937" header="0.315" footer="0.315"/>' +
      '<pageSetup paperSize="9" fitToWidth="1" fitToHeight="0" orientation="portrait"/>' +
      (brks.length ? '<rowBreaks count="' + brks.length + '" manualBreakCount="' + brks.length + '">' +
        brks.map(function (b) { return '<brk id="' + b + '" max="16383" man="1"/>'; }).join('') + '</rowBreaks>' : '') + '</worksheet>';
    var book = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + XL_SHEET + '" sheetId="1" r:id="rId1"/></sheets>' +
      '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">\'' + XL_SHEET + '\'!$A$1:$N$' + r + '</definedName>' +
      '<definedName name="_xlnm.Print_Titles" localSheetId="0">\'' + XL_SHEET + '\'!$' + HEADR + ':$' + HEADR + '</definedName></definedNames>' +
      '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
    return X.zip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: book },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', data: XL_STYLES },
      { name: 'xl/worksheets/sheet1.xml', data: sheet }
    ]);
  }
  function xlsxFrozen(id) {
    var a = apprById(id); if (!a) return;
    fetchFrozen(a).then(function (fz) {
      if (!fz) { C.toast('상신 때 저장한 자료를 찾지 못했습니다.', true); return; }
      var d = frozenDoc(a, fz);
      var sum = d.items.reduce(function (s, it) { return s + it.amount; }, 0), exp = (a.snapshot || {}).cost;
      C.saveBlob(xlsxBytes(d), '개인경비_지출명세_' + C.vx.safeName(d.person.name) + '_' + a.cycle + (a.status === 'approved' ? '_결재완료' : '_결재중') + '.xlsx');
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
    rest('/rest/v1/expense_frozen?approval_id=in.(' + need.map(function (a) { return a.id; }).join(',') + ')&select=approval_id,verify,frozen_at')
      .then(function (rows) {
        var by = {}; (rows || []).forEach(function (x) { by[x.approval_id] = x; });
        need.forEach(function (a) { FZSUM[fzKey(a)] = by[a.id] || null; });
        FZASK = '';
        if (C.state().VIEW === view) C.render();
      }).catch(function () { need.forEach(function (a) { FZFAIL[fzKey(a)] = Date.now(); }); FZASK = ''; });
  }
  function byLine(sn) {
    var by = sn.by || {};
    return CATS.map(function (c) { var x = by[c] || {}; return c.replace('비용', '') + ' ' + won(x.sum || 0); }).join(' · ');
  }
  /** 결재 요약(결재 중) + 검증 딱지 · 문서 단추. 운행일지 apprBrief 와 같은 모양. */
  function extra(a) {
    if (!a) return '';
    var f = FZSUM[fzKey(a)], done = a.status === 'approved', live = a.status === 'submitted' || done;
    var chip = f && f.verify ? '<button class="vchip" data-xfzverify="' + a.id + '" title="상신할 때의 검증 결과 보기">' + C.vx.sumChip(f.verify.summary) + '</button>' : '';
    return brief(a, f) + '<div class="aext">' + chip + '<span style="flex:1"></span>' +
      '<button class="btn sm" data-xfzpdf="' + a.id + '">' + ic('dl', 13) + (done ? '결재 완료본 PDF' : live ? '결재 문서 PDF' : '상신했던 문서 PDF') + '</button>' +
      (done ? '<button class="btn sm" data-xfzxlsx="' + a.id + '">결재 완료본 엑셀</button>' : '') + '</div>';
  }
  function brief(a, f) {
    if (!a || a.status !== 'submitted') return '';
    var s = a.snapshot || {};
    if (s.cost == null) return '';
    var cost = Number(s.cost) || 0, cy = parseKey(a.cycle), pc = C.addCycle(cy, -1), pkey = keyOf(pc);
    var prev = (XAPPR || []).filter(function (x) { return x.username === a.username && x.cycle === pkey && (x.status === 'approved' || x.status === 'submitted') && x.snapshot && x.snapshot.cost != null; })[0];
    var cmp, bigJump = false;
    if (prev) {
      var p0 = Number(prev.snapshot.cost) || 0, d = cost - p0, pct = p0 ? Math.round(d / p0 * 100) : null;
      bigJump = p0 > 0 && d > 100000 && pct >= 50;
      cmp = '<div class="abf"><span class="k">전월(' + pc.m + '월분) 대비</span><b class="' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '') + won(Math.abs(d)) +
        (pct != null && d ? ' <small>(' + (d > 0 ? '+' : '−') + (Math.abs(pct) < 1 ? '1% 미만' : Math.abs(pct) + '%') + ')</small>' : '') + '</b><span class="sub">' + pc.m + '월분 ' + won(p0) + ' · ' + n0(prev.snapshot.n) + '건</span></div>';
    } else cmp = '<div class="abf"><span class="k">전월 대비</span><b class="dimv">—</b><span class="sub">볼 수 있는 ' + pc.m + '월분 개인경비 결재가 없습니다</span></div>';
    var v = f && f.verify, vs = (v && v.summary) || null;
    var items = ((v && (v.items || (v.result && v.result.items))) || []).filter(function (i) { return i.level === 'bad' || i.level === 'warn'; });
    var checks = [];
    if (vs) {
      checks.push(vs.bad ? ['bad', '검증 불일치 ' + n0(vs.bad) + '건'] : vs.warn ? ['warn', '검증 확인 필요 ' + n0(vs.warn) + '건'] : ['ok', '검증 이상 없음']);
      if (vs.receipts) checks.push(vs.read >= vs.receipts ? ['ok', 'AI 사진 판독 ' + n0(vs.read) + '/' + n0(vs.receipts) + '장 완료'] : ['warn', 'AI 사진 판독 ' + n0(vs.read) + '/' + n0(vs.receipts) + '장']);
    } else if (f === undefined) checks.push(['warn', '검증 결과를 불러오는 중…']);
    else checks.push(['warn', '상신 때 검증 결과가 없습니다']);
    checks.push(s.meal_over ? ['warn', '식비 1인 13,000원 초과 ' + n0(s.meal_over) + '건(알림)'] : ['ok', '식비 기준 안']);
    if (bigJump) checks.push(['warn', '전월보다 크게 늘었습니다']);
    var nBad = checks.filter(function (c) { return c[0] === 'bad'; }).length, nWarn = checks.filter(function (c) { return c[0] === 'warn'; }).length;
    var verdict = !vs ? ['warn', '검증 결과를 아직 받지 못했습니다 — 결재 문서를 열어 확인해 주세요']
      : nBad ? ['bad', '확인이 필요합니다 — 문서의 불일치 항목을 보고 결재해 주세요']
      : nWarn ? ['warn', '대체로 정상입니다 — 아래 확인 항목만 살펴봐 주세요']
      : ['ok', '금액·검증 모두 이상 없습니다 — 문서를 열지 않고 승인하셔도 됩니다'];
    return '<div class="abrief ' + verdict[0] + '"><div class="abv"><span class="abi">' + (verdict[0] === 'ok' ? '✓' : '!') + '</span><b>' + esc(verdict[1]) + '</b></div>' +
      '<div class="abgrid">' +
      '<div class="abf"><span class="k">청구 금액</span><b>' + won(cost) + '</b><span class="sub">' + esc(byLine(s)) + '</span></div>' +
      '<div class="abf"><span class="k">영수증</span><b>' + n0(s.n) + '<small>장</small></b><span class="sub">' + esc(xSpanKey(a.cycle)) + '</span></div>' +
      cmp +
      '<div class="abf"><span class="k">식비 기준 초과</span><b>' + n0(s.meal_over || 0) + '<small>건</small></b><span class="sub">1인 1끼 13,000원 — 알리기만</span></div>' +
      '</div><div class="abchk">' + checks.map(function (c) { return '<span class="ck ' + c[0] + '">' + (c[0] === 'ok' ? '✓' : '!') + ' ' + esc(c[1]) + '</span>'; }).join('') + '</div>' +
      (items.length ? '<ul class="abitems">' + items.slice(0, 4).map(function (i) {
        return '<li class="' + i.level + '"><b>' + esc(i.title || '') + '</b>' + (i.detail ? ' — ' + esc(String(i.detail).slice(0, 110)) + (String(i.detail).length > 110 ? '…' : '') : '') + '</li>';
      }).join('') + (items.length > 4 ? '<li class="more">외 ' + n0(items.length - 4) + '건 — 아래 「검증」을 눌러 전부 보기</li>' : '') + '</ul>' : '') + '</div>';
  }
  function sumHtml(a) {
    var s = a.snapshot || {};
    var kv = function (k, v) { return '<div class="kv"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; };
    if (s.cost == null) return '';
    return kv('기간', esc(cycName(a.cycle)) + ' <span class="dim">(' + esc(xSpanKey(a.cycle)) + ')</span>') +
      kv('구분별', esc(byLine(s))) +
      kv('식비 기준', s.meal_over ? '<span class="st warn">1인 13,000원 초과 ' + n0(s.meal_over) + '건 — 알리기만</span>' : '<span class="dim">초과 없음</span>') +
      kv('합계', '<b style="font-size:15px">' + won(s.cost) + '</b> <span class="dim">' + n0(s.n) + '건</span>');
  }

  /* ══════════════════ 관리 — 개인경비 현황 · 전체 내역 · 결재 완료 출력 ══════════════════ */
  function cycAppr() { var k = C.state().CYCKEY; return (XAPPR || []).filter(function (a) { return a.cycle === k; }); }
  function peopleOf(rows) {
    var by = {};
    rows.forEach(function (it) { var x = by[it.username] = by[it.username] || { u: it.username, n: 0, sum: 0, meal: 0 }; x.n++; x.sum += Number(it.amount) || 0; if (mealOver(it)) x.meal++; });
    cycAppr().forEach(function (a) { if (!by[a.username]) by[a.username] = { u: a.username, n: 0, sum: 0, meal: 0 }; });
    return by;
  }
  function orgUsers(view) {
    if (ADMIN_X.indexOf(view) < 0) return null;
    var x = ITEMS[itemKey(true, C.state().CYCKEY)];
    var has = Object.keys(peopleOf((x && x.rows) || []));
    // 직원 현황은 경비가 없는 사람도 명단에 있으므로 「보는 범위」도 등록된 전 직원으로 고른다.
    if (view === 'xa_people') return { label: '등록 직원', list: Object.keys(C.state().USERS || {}).concat(has) };
    return { label: '경비가 있는 사람', list: has };
  }
  function adminRows() {
    var rows = itemsFor(true);
    if (!rows || rows.err || XAPPR === null) return rows || null;
    return rows;
  }
  function viewAdminClose() {
    var S = C.state();
    if (!S.LOADED) return C.head('개인경비 현황') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('개인경비 현황', '개인경비');
    var rows = adminRows();
    if (!rows || rows.err) return notReady('개인경비 현황', rows);
    rows = rows.filter(function (it) { return C.orgMatch(it.username); });
    var by = peopleOf(rows), list = Object.keys(by).filter(function (u) { return C.orgMatch(u); }).map(function (u) { var x = by[u]; x.a = xApprOf(u, S.CYCKEY); return x; });
    var T = sums(rows);
    var cnt = function (f) { return list.filter(f).length; };
    var nDone = cnt(function (x) { return x.a && x.a.status === 'approved'; }), nGo = cnt(function (x) { return x.a && x.a.status === 'submitted'; });
    var nBack = cnt(function (x) { return x.a && (x.a.status === 'rejected' || x.a.status === 'withdrawn'); }), nNot = cnt(function (x) { return !x.a && x.n > 0; });
    var h = head('개인경비 현황', '직원별 상신·결재 상태');
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (nGo || nBack || nNot ? '' : ' ok') + '"></span>경비가 있는 ' + n0(list.length) + '명 · ' + n0(T.n) + '건</div>' +
      '<p class="verdict">' + won(T.all) + '</p><div class="facts">' +
      fact('결재 완료', n0(nDone) + '<small>명</small>', '출력할 수 있습니다') + fact('결재 중', n0(nGo) + '<small>명</small>', '결재자 차례를 기다리는 중', nGo > 0) +
      fact('반려·회수', n0(nBack) + '<small>명</small>', '고쳐서 다시 올려야 함', nBack > 0) + fact('상신 안 함', n0(nNot) + '<small>명</small>', '이번 기간 경비가 있는데 상신 전', nNot > 0) +
      '</div><div class="facts" style="margin-top:10px">' + CATS.map(function (c) { return fact(c, won(T.by[c].sum), n0(T.by[c].n) + '건'); }).join('') +
      fact('식비 기준 초과', n0(T.meal) + '<small>건</small>', '1인 13,000원 — 알리기만') + '</div></div>';
    // 팀별 합계 카드 — 누르면 그 팀으로 좁힌다(운행일지 관리와 같은 모양)
    var tb = {}, tl = [], byUnit = false;
    list.forEach(function (x) {
      var p = C.orgPath(x.u), k = p.div + '|' + p.team;
      if (!tb[k]) { tb[k] = { p: p, n: 0, sum: 0, cnt: 0 }; tl.push(tb[k]); }
      tb[k].n++; tb[k].sum += x.sum; tb[k].cnt += x.n;
    });
    if (tl.length > 1 && !byUnit) {
      var max = tl.reduce(function (m, g) { return Math.max(m, g.sum); }, 1);
      tl.sort(function (a, b) { return b.sum - a.sum; });
      h += '<section class="sect"><div class="tcards">' + tl.map(function (g) {
        return '<button class="tcard" data-orgteam="' + esc(g.p.div + '|' + g.p.team) + '"><span class="tl">' + esc(C.orgName(g.p)) + '</span><span class="ts">' + esc(g.p.div || '') + '</span>' +
          '<span class="tv">' + won(g.sum) + '</span><span class="tbar"><i style="width:' + Math.max(3, Math.round(g.sum / max * 100)) + '%"></i></span>' +
          '<span class="tm">' + n0(g.n) + '명 · ' + n0(g.cnt) + '건</span></button>';
      }).join('') + '</div></section>';
    }
    var order = function (x) { return !x.a ? (x.n ? 0 : 5) : x.a.status === 'rejected' || x.a.status === 'withdrawn' ? 1 : x.a.status === 'submitted' ? 2 : 3; };
    list.sort(function (x, y) { return order(x) - order(y) || y.sum - x.sum; });
    h += C.sect('직원별', n0(list.length) + '명', '', list.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>파트·센터</th><th>이름</th>' +
      '<th class="n">건수</th><th class="n">금액</th><th>식비 기준</th><th>결재</th><th></th></tr></thead><tbody>' +
      C.orgGroups(list, function (x) { return x.u; }, true).map(function (g) {
        return C.orgGroupRow(g, 7, '합계 <b>' + won(g.list.reduce(function (s, x) { return s + x.sum; }, 0)) + '</b>') + g.list.map(function (x) {
          var a = x.a;
          return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td><td class="n">' + n0(x.n) + '</td>' +
            '<td class="n total">' + n0(x.sum) + '</td><td>' + (x.meal ? '<span class="st warn">초과 ' + n0(x.meal) + '건</span>' : '<span class="dim">—</span>') + '</td>' +
            '<td>' + stChip(a) + '</td><td class="n" style="white-space:nowrap">' +
            (x.n ? '<button class="btn sm" data-xperson="' + esc(x.u) + '">내역</button> ' : '') +
            (a && (a.status === 'submitted' || a.status === 'approved') ? '<button class="btn sm" data-xfzpdf="' + a.id + '">PDF</button> ' : '') +
            (a && a.status === 'submitted' ? '<button class="btn sm" data-appr="force_reject" data-kind="expense" data-id="' + a.id + '" title="결재가 멈췄을 때 관리자 권한으로 반려합니다">관리자 반려</button>' : '') +
            (a && a.status === 'approved' ? '<button class="btn sm" data-appr="reopen" data-kind="expense" data-id="' + a.id + '" title="결재 완료 건을 정정하도록 다시 엽니다">정정 열기</button>' : '') + '</td></tr>';
        }).join('');
      }).join('') + '</tbody></table></div></div>' : C.blank('이 기간에 경비가 있는 사람이 없습니다.', null, 'users'));
    var todo = list.filter(function (x) { return x.n > 0 && (!x.a || x.a.status === 'rejected' || x.a.status === 'withdrawn'); });
    if (todo.length) {
      h += C.sect('챙겨야 할 사람', n0(todo.length) + '명', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>파트·센터</th><th>이름</th><th>상태</th><th class="n">이번 기간 경비</th></tr></thead><tbody>' +
        C.orgGroups(todo, function (x) { return x.u; }, true).map(function (g) {
          return C.orgGroupRow(g, 4, '') + g.list.map(function (x) {
            return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td><td>' + (x.a ? stChip(x.a) : '<span class="st warn">상신 전</span>') + '</td>' +
              '<td class="n">' + n0(x.n) + '건 · ' + won(x.sum) + '</td></tr>';
          }).join('');
        }).join('') + '</tbody></table></div></div>');
    }
    h += '<div class="anote"><b>관리자 반려</b>는 결재자가 자리에 없어 결재가 멈췄을 때만 씁니다. <b>정정 열기</b>는 결재가 끝난 뒤 고칠 것이 생겼을 때 씁니다 — ' +
      '잠금이 풀려 직원이 고쳐 다시 상신하고, 그때의 결재 완료본은 이력에 남습니다.</div>';
    return h;
  }
  /** 직원 현황(개인경비) — 등록된 모든 직원의 이번 기간 경비. 운행일지 직원 현황(운행·거리·유지비)과 따로 둔다(2026-10-08).
   *  운전을 안 하는 직원도 개인경비는 쓰므로 uses_driving 으로 거르지 않는다. */
  function viewAdminPeople() {
    var S = C.state();
    if (!S.LOADED) return C.head('직원 현황') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('직원 현황', '개인경비');
    var rows = adminRows();
    if (!rows || rows.err) return notReady('직원 현황', rows);
    var users = Object.keys(S.USERS || {}).filter(function (u) { return C.orgMatch(u); });
    var mine = {};
    rows.forEach(function (it) { if (C.orgMatch(it.username)) (mine[it.username] = mine[it.username] || []).push(it); });
    Object.keys(mine).forEach(function (u) { if (users.indexOf(u) < 0) users.push(u); });   // 명단에 없지만 경비가 있는 사람도 빠뜨리지 않는다
    var list = users.map(function (u) { var s = sums(mine[u] || []); s.u = u; s.a = xApprOf(u, S.CYCKEY); return s; });
    var none = list.filter(function (x) { return !x.n; }).length;
    var scope = C.orgScopeName ? C.orgScopeName() : '';
    var h = head('직원 현황', n0(list.length) + '명' + (scope ? ' · ' + esc(scope) : ''));
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot"></span>이번 기간 개인경비</div>' +
      '<p class="verdict">' + (list.length - none ? '<em>' + n0(list.length - none) + '명</em>이 경비를 올렸습니다' : '<em>아직 올린 경비가 없습니다</em>') + '</p>' +
      '<div class="facts">' + fact('등록 인원', n0(list.length) + '<small>명</small>') + fact('경비 있음', n0(list.length - none) + '<small>명</small>') +
      fact('경비 없음', n0(none) + '<small>명</small>') + '</div></div>';
    list.sort(function (x, y) { return y.all - x.all; });
    h += C.sect('명단', n0(list.length) + '명', '', list.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>파트·센터</th><th>이름</th><th>직급</th>' +
      '<th class="n">건수</th><th class="n">합계</th>' + CATS.map(function (c) { return '<th class="n">' + c + '</th>'; }).join('') + '<th>식비 기준</th><th>결재</th></tr></thead><tbody>' +
      C.orgGroups(list, function (x) { return x.u; }, true).map(function (g) {
        var gn = g.list.filter(function (x) { return x.n; }).length;
        return C.orgGroupRow(g, 10, '경비 있음 ' + n0(gn) + '명 · 합계 <b>' + won(g.list.reduce(function (s, x) { return s + x.all; }, 0)) + '</b>') + g.list.map(function (x) {
          var u = S.USERS[x.u] || {};
          return '<tr' + (x.n ? ' class="clk" tabindex="0" data-xperson="' + esc(x.u) + '"' : '') + '>' + C.orgCell(x.u, true) +
            '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td><td class="dim">' + esc(u.position || '—') + '</td>' +
            '<td class="n' + (x.n ? '' : ' dim') + '">' + n0(x.n) + '</td>' +
            '<td class="n total">' + (x.all ? n0(x.all) : '—') + '</td>' +
            CATS.map(function (c) { return '<td class="n">' + (x.by[c].sum ? n0(x.by[c].sum) : '—') + '</td>'; }).join('') +
            '<td>' + (x.meal ? '<span class="st warn">초과 ' + n0(x.meal) + '건</span>' : '<span class="dim">—</span>') + '</td>' +
            '<td>' + (x.a ? stChip(x.a) : (x.n ? '<span class="st warn">상신 전</span>' : '<span class="dim">—</span>')) + '</td></tr>';
        }).join('');
      }).join('') + '</tbody></table></div></div>' : C.blank('보는 범위에 직원이 없습니다.', null, 'users'));
    h += '<div class="anote">줄을 누르면 그 사람의 경비 내역(전체 내역)으로 갑니다. 운행·거리·차량 유지비는 운행일지의 직원 현황에서 봅니다.</div>';
    return h;
  }
  var XL = { cat: 'all', who: '', meal: false };
  function listFiltered(rows) {
    return rows.filter(function (it) {
      if (!C.orgMatch(it.username)) return false;
      if (XL.cat !== 'all' && (CATS.indexOf(it.category) < 0 ? '기타비용' : it.category) !== XL.cat) return false;
      if (XL.who && it.username !== XL.who) return false;
      if (XL.meal && !mealOver(it)) return false;
      return true;
    });
  }
  function viewAdminList() {
    var S = C.state();
    if (!S.LOADED) return C.head('개인경비 전체 내역') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('개인경비 전체 내역', '개인경비');
    var all = adminRows();
    if (!all || all.err) return notReady('개인경비 전체 내역', all);
    var scoped = all.filter(function (it) { return C.orgMatch(it.username); });
    var rows = listFiltered(all);
    var h = head('개인경비 전체 내역', '영수증 한 장이 한 줄');
    var cnt = function (c) { return scoped.filter(function (it) { return c === 'all' || (CATS.indexOf(it.category) < 0 ? '기타비용' : it.category) === c; }).length; };
    var who = {}; scoped.forEach(function (it) { who[it.username] = 1; });
    var whoOpts = Object.keys(who).sort(function (a, b) { return C.nameOf(a).localeCompare(C.nameOf(b), 'ko'); });
    if (XL.who && !who[XL.who]) XL.who = '';
    h += '<div class="fbar"><div class="seg">' + ['all'].concat(CATS).map(function (c) {
      return '<button class="' + (XL.cat === c ? 'on' : '') + '" aria-pressed="' + (XL.cat === c) + '" data-xcat="' + c + '">' + (c === 'all' ? '전체' : c) + ' <span class="c">' + n0(cnt(c)) + '</span></button>';
    }).join('') + '</div>' +
      '<label class="field"><select id="xWho" aria-label="사람"><option value="">사람 전체</option>' + whoOpts.map(function (u) { return '<option value="' + esc(u) + '"' + (XL.who === u ? ' selected' : '') + '>' + esc(C.nameOf(u)) + '</option>'; }).join('') + '</select></label>' +
      '<button class="btn sm' + (XL.meal ? ' pri' : '') + '" data-xmeal aria-pressed="' + XL.meal + '">식비 기준 초과만 ' + n0(scoped.filter(mealOver).length) + '</button>' +
      '<span style="flex:1"></span><button class="btn sm" data-xcsv>' + ic('dl', 13) + 'CSV 내려받기</button></div>';
    var total = rows.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0);
    var sorted = rows.slice().sort(function (a, b) { return Number(a.date_millis) - Number(b.date_millis) || a.id - b.id; });
    h += C.sect('내역', n0(rows.length) + '건 · ' + won(total), '', rows.length ? '<div class="panel"><div class="scroll tall" data-rows><table class="xtab"><thead><tr>' +
      '<th>날짜</th><th>파트·센터</th><th>이름</th><th>구분</th><th>사용처</th><th class="n">금액</th><th>사용내역</th><th>비고</th><th>사진</th></tr></thead><tbody>' +
      C.orgGroups(sorted, function (it) { return it.username; }).map(function (g) {
        return C.orgGroupRow(g, 9, n0(g.list.length) + '건 · 합계 <b>' + won(g.list.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0)) + '</b>').replace(/<span class="on">[^<]*<\/span>/, '') + g.list.map(function (it) {
          return '<tr' + (mealOver(it) ? ' class="xover"' : '') + '><td><span class="lead">' + C.md(it.date_millis) + '</span></td>' + C.orgCell(it.username, true) +
            '<td>' + esc(C.nameOf(it.username)) + '</td><td><span class="kind">' + esc(it.category) + '</span></td>' +
            '<td class="el" title="' + esc(it.merchant || '') + '">' + esc(it.merchant || '—') + '</td><td class="n total"><span class="xamt">' + n0(it.amount) + '</span>' + (mealOver(it) ? '<div class="xmealw">' + mealTag(it) + '</div>' : '') + '</td>' +
            '<td class="el xuse" title="' + esc(it.usage || '') + '">' + esc(it.usage || '') + '</td><td class="el dim xnote">' + esc(it.note || '') + '</td><td class="xph" style="white-space:nowrap">' + photoLink(it) + '</td></tr>';
        }).join('');
      }).join('') + '</tbody><tfoot><tr><td colspan="5">보이는 ' + n0(rows.length) + '건 합계</td><td class="n total">' + n0(total) + '</td><td colspan="3"></td></tr></tfoot></table></div></div>'
      : '<div class="panel"><div class="blank"><div class="t">조건에 맞는 경비가 없습니다.</div><div style="margin-top:12px"><button class="btn sm" data-xclear>조건 지우기</button></div></div></div>');
    return h;
  }
  /** CSV — 엑셀에서 바로 열리게 BOM. 글자 칸이 = + - @ 탭·CR 로 시작하면 ' 를 붙여 수식으로 실행되지 않게 한다. */
  function csvText(rows) {
    var NL = String.fromCharCode(13, 10);
    var q = function (v) {
      if (typeof v === 'number') return String(v);
      var s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return String.fromCharCode(0xFEFF) + rows.map(function (r) { return r.map(q).join(','); }).join(NL) + NL;
  }
  function scopeSuffix() { var s = C.orgScopeName ? C.orgScopeName() : ''; return s ? '_' + s.replace(/[\\/:*?"<>|\s]+/g, '') : ''; }
  function listCsv() {
    var S = C.state(), x = ITEMS[itemKey(true, S.CYCKEY)], rows = listFiltered((x && x.rows) || []);
    var out = [['날짜', '이름', '아이디', '소속', '구분', '사용처', '금액', '사용내역', '비고', '식비 1인 금액', '식비 기준 초과']];
    rows.slice().sort(function (a, b) { return a.date_millis - b.date_millis; }).forEach(function (it) {
      var op = C.orgPath(it.username), mo = mealOver(it);
      out.push([C.ymd(it.date_millis), C.nameOf(it.username), it.username, [C.orgName(op), op.unit].filter(Boolean).join(' · '), it.category, it.merchant || '',
        Number(it.amount) || 0, it.usage || '', it.note || '', it.category === '식비' ? Math.ceil((Number(it.amount) || 0) / mealPeople(it.usage)) : '', mo ? '초과' : '']);   // 1인 금액은 올림(2026-10-08 서버·앱과 같게)
    });
    out.push(['합계', '', '', '', '', '', rows.reduce(function (s, it) { return s + (Number(it.amount) || 0); }, 0), '', '', '', '']);
    C.saveBlob(new TextEncoder().encode(csvText(out)), '개인경비_내역_' + S.CYCKEY + scopeSuffix() + '.csv');
    C.toast('CSV 를 내려받습니다(' + n0(rows.length) + '건).');
  }
  var FINSEL = {}, FINJOB = null;
  function viewAdminFinal() {
    var S = C.state();
    if (!S.LOADED) return C.head('개인경비 결재 완료 출력') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('개인경비 결재 완료 출력', '출력');
    var all = adminRows();
    if (!all || all.err) return notReady('개인경비 결재 완료 출력', all);
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
    var h = head('개인경비 결재 완료 출력', '결재가 끝난 지출결의를 모아 출력합니다');
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (done.length && !going.length && !notYet.length ? ' ok' : '') + '"></span>' + esc(cycName(S.CYCKEY)) + ' · ' + esc(xSpanKey(S.CYCKEY)) + '</div>' +
      '<p class="verdict">결재 완료 <em>' + n0(done.length) + '명</em> · ' + won(total) + '</p><div class="facts">' +
      fact('결재 완료', n0(done.length) + '<small>명</small>', '출력할 수 있습니다') + fact('결재 중', n0(going.length) + '<small>명</small>', '결재자 차례를 기다리는 중', going.length > 0) +
      fact('반려·회수', n0(back.length) + '<small>명</small>', '고쳐서 다시 올려야 함', back.length > 0) + fact('아직 상신 안 함', n0(notYet.length) + '<small>명</small>', '이번 기간 경비가 있는데 상신 전', notYet.length > 0) + '</div></div>';
    var tools = done.length ? '<label class="finall"><input type="checkbox" id="xFinAll"' + (nSel && nSel === done.length ? ' checked' : '') + '> 전체 선택</label>' +
      '<button class="btn sm' + (nSel ? ' pri' : '') + '" data-xfinpdf' + (nSel && !FINJOB ? '' : ' disabled') + '>' + ic('dl', 13) + (nSel ? '고른 ' + n0(nSel) + '명 PDF 한 파일로' : 'PDF 한 파일로 묶기') + '</button>' +
      '<button class="btn sm" data-xfincsv>' + ic('dl', 13) + '금액 요약표(CSV)</button>' : '';
    h += C.sect('결재 완료', n0(done.length) + '명', tools, done.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th style="width:36px"></th><th>파트·센터</th><th>이름</th>' +
      '<th>결재 완료</th><th class="n">건수</th><th class="n">금액</th><th>결재선</th><th></th></tr></thead><tbody>' +
      C.orgGroups(done, function (a) { return a.username; }, true).map(function (g) {
        return C.orgGroupRow(g, 8, '합계 <b>' + won(g.list.reduce(function (s, a) { return s + (Number((a.snapshot || {}).cost) || 0); }, 0)) + '</b>') + g.list.map(function (a) {
          var line = (a.steps || []).map(function (s) { return (s.name || C.nameOf(s.approver)) + '(' + (s.box || '') + ')'; }).join(' → ');
          return '<tr><td><input type="checkbox" data-xfinsel="' + a.id + '"' + (FINSEL[a.id] ? ' checked' : '') + ' aria-label="' + esc(C.nameOf(a.username)) + ' 고르기"></td>' +
            C.orgCell(a.username, true) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span></td><td class="dim">' + (a.closed_at ? esc(C.vx.whenText(a.closed_at)) : '—') + '</td>' +
            '<td class="n">' + n0((a.snapshot || {}).n) + '</td><td class="n total">' + n0((a.snapshot || {}).cost) + '</td><td class="el dim" title="' + esc(line) + '">' + esc(line) + '</td>' +
            '<td class="n" style="white-space:nowrap"><button class="btn sm" data-xfzpdf="' + a.id + '">PDF</button> <button class="btn sm" data-xfzxlsx="' + a.id + '">엑셀</button> ' +
            '<button class="btn sm" data-appr="reopen" data-kind="expense" data-id="' + a.id + '">정정 열기</button></td></tr>';
        }).join('');
      }).join('') + '</tbody><tfoot><tr><td></td><td colspan="4">결재 완료 ' + n0(done.length) + '명 합계</td><td class="n total">' + n0(total) + '</td><td colspan="2"></td></tr></tfoot></table></div></div>'
      : C.blank('아직 결재가 끝난 건이 없습니다.', '결재가 끝나면 여기에 모입니다.', 'stamp'));
    if (going.length) {
      h += C.sect('결재 중', n0(going.length) + '명', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>소속</th><th>이름</th><th>상신</th><th class="n">금액</th><th>지금 차례</th><th></th></tr></thead><tbody>' +
        going.map(function (a) {
          var cur = (a.steps || []).filter(function (s) { return s.seq === a.cur_seq; })[0] || {};
          return '<tr>' + C.orgCell(a.username) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span></td><td class="dim">' + (a.submitted_at ? esc(C.vx.whenText(a.submitted_at)) : '') + '</td>' +
            '<td class="n">' + n0((a.snapshot || {}).cost) + '</td><td>' + esc((cur.name || C.nameOf(cur.approver || '')) + (cur.box ? ' (' + cur.box + ')' : '')) + '</td>' +
            '<td class="n"><button class="btn sm" data-appr="force_reject" data-kind="expense" data-id="' + a.id + '">관리자 반려</button></td></tr>';
        }).join('') + '</tbody></table></div></div>');
    }
    if (back.length || notYet.length) {
      var todo = back.map(function (a) { return { u: a.username, st: a.status === 'rejected' ? '반려' : '회수' }; }).concat(notYet.map(function (u) { return { u: u, st: '상신 전' }; }));
      h += C.sect('챙겨야 할 사람', n0(todo.length) + '명', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>파트·센터</th><th>이름</th><th>상태</th><th class="n">이번 기간 경비</th></tr></thead><tbody>' +
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
    var out = [['이름', '아이디', '소속', '결재 완료', '건수', '소모품비', '식비', '기타비용', '금액 합계', '식비 기준 초과', '결재 번호']];
    var t = [0, 0, 0, 0, 0, 0];
    done.forEach(function (a) {
      var s = a.snapshot || {}, by = s.by || {}, op = C.orgPath(a.username);
      var v = [Number(s.n) || 0, (by['소모품비'] || {}).sum || 0, (by['식비'] || {}).sum || 0, (by['기타비용'] || {}).sum || 0, Number(s.cost) || 0, Number(s.meal_over) || 0];
      v.forEach(function (x, i) { t[i] += x; });
      out.push([C.nameOf(a.username), a.username, [C.orgName(op), op.unit].filter(Boolean).join(' · '), a.closed_at ? C.vx.whenText(a.closed_at) : ''].concat(v).concat([a.id]));
    });
    out.push(['합계', '', '', ''].concat(t).concat(['']));
    C.saveBlob(new TextEncoder().encode(csvText(out)), '개인경비_결재완료_금액요약_' + S.CYCKEY + scopeSuffix() + '.csv');
    C.toast('요약표를 내려받습니다(' + n0(done.length) + '명).');
  }
  /** 고른 결재 완료 건들을 PDF 한 파일로 — 한 사람씩 고정본으로 만든 뒤 이어 붙인다(한 번에 20명까지). */
  function finBundle() {
    var S = C.state();
    var list = Object.keys(FINSEL).map(apprById).filter(function (a) { return a && a.status === 'approved'; })
      .sort(function (x, y) { return C.nameOf(x.username).localeCompare(C.nameOf(y.username), 'ko'); });
    if (!list.length || FINJOB) return;
    if (list.length > 20) { C.toast('한 번에 20명까지 묶을 수 있습니다(지금 ' + list.length + '명). 나눠서 골라 받아 주세요.', true); return; }
    var job = FINJOB = {};
    C.openPanel('개인경비 결재 완료본 묶어 받기', cycName(S.CYCKEY) + ' · ' + n0(list.length) + '명',
      '<div class="pdfwait"><div class="spin"></div><div id="xFinNote" role="status">준비하는 중…</div><div class="dim" style="margin-top:6px">사람마다 영수증 사진을 넣어 만듭니다. 사람이 많으면 몇 분 걸릴 수 있습니다.</div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
    var note = function (t) { var el = $('xFinNote'); if (el) el.textContent = t; };
    // ★ 창을 닫으면(닫기·Esc·바깥 누르기·다른 창) 그 묶음은 끝난 것이다 — 남은 사람 문서를 계속 만들지 않는다.
    var alive = function () { if (FINJOB === job && !$('xFinNote')) { FINJOB = null; C.render(); } return FINJOB === job; };
    var parts = [], skipped = [], checks = [];
    var one = function (i) {
      if (i >= list.length || !alive()) return Promise.resolve();
      var a = list[i];
      note((i + 1) + ' / ' + list.length + ' · ' + C.nameOf(a.username) + ' 님 문서를 만드는 중…');
      return fetchFrozen(a).then(function (fz) {
        if (!fz) { skipped.push(C.nameOf(a.username)); return; }
        var d = frozenDoc(a, fz);
        return C.fillSigns(d).then(C.vx.ensureLibs).then(function (lib) {
          return window.SheetPdf.buildExpense(d, { PDFLib: lib.PDFLib, fontkit: lib.fontkit, fontRegular: lib.fontRegular, fontBold: lib.fontBold, loadImage: function (p) { return C.vx.loadPhoto(p, 1500); } });
        }).then(function (res) {
          parts.push(res.bytes);
          var sum = (res.totals[0] || {}).all || 0, exp = (a.snapshot || {}).cost, w = [];
          // 1원 차이도 알린다(2026-10-08, 예전 > 1 은 1원 차이를 숨겼다).
          if (exp != null && Math.round(sum) - Math.round(Number(exp)) !== 0) w.push('문서 합계 ' + n0(sum) + '원 ≠ 결재 금액 ' + n0(exp) + '원');
          var img = (res.issues || []).filter(function (x) { return x.kind === 'image'; }).length;
          if (img) w.push('불러오지 못한 사진 ' + img + '장');
          var cut = (res.issues || []).filter(function (x) { return x.kind === 'cut'; }).length;
          if (cut) w.push('「…」로 줄인 증빙 설명 ' + cut + '곳');
          if (w.length) checks.push(d.person.name + ' — ' + w.join(', '));
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
        return chain.then(function () { out.setTitle('개인경비 지출결의 결재 완료본 ' + cycName(S.CYCKEY)); return out.save(); })
          .then(function (bytes) { return { bytes: bytes, pages: out.getPageCount() }; });
      });
    }).then(function (res) {
      if (FINJOB !== job) { C.render(); return; }   // 닫혀서 그만둔 묶음(새 묶음이 돌고 있을 수도 있다)
      FINJOB = null;
      if (!res || !$('xFinNote')) { C.render(); return; }
      var blob = new Blob([res.bytes], { type: 'application/pdf' }), url = URL.createObjectURL(blob);
      C.vx.setPdfUrls([url]);
      var file = '개인경비_결재완료_' + S.CYCKEY + '_' + parts.length + '명.pdf';
      $('pBody').innerHTML = '<div class="pdfdone"><div class="big">' + n0(res.pages) + '<small>쪽</small></div><div class="dim">' + (blob.size / 1e6).toFixed(1) + ' MB · ' + n0(parts.length) + '명 결재 완료본</div>' +
        (skipped.length ? '<div class="awarn">' + ic('alert', 15) + '<span>만들지 못한 사람: ' + esc(skipped.join(', ')) + ' — 한 사람씩 「PDF」로 다시 받아 주세요.</span></div>' : '') +
        (checks.length ? '<div class="awarn">' + ic('alert', 15) + '<span>확인 필요: ' + esc(checks.join(' · ')) + '</span></div>' : '') +
        (!skipped.length && !checks.length ? '<div class="pdfok">' + ic('check', 15) + '<span>모두 묶었습니다 — 합계·사진 점검 이상 없음</span></div>' : '') + '</div>';
      $('pFoot').innerHTML = '<span style="flex:1"></span><button class="btn" data-close>닫기</button><a class="btn" href="' + url + '" download="' + esc(file) + '">' + ic('dl', 14) + '내려받기</a>' +
        '<a class="btn pri" href="' + url + '" target="_blank" rel="noopener">열기 · 인쇄</a>';
      C.render();
    }).catch(function (e) {
      if (FINJOB !== job) return;
      FINJOB = null;
      if ($('xFinNote')) $('pBody').innerHTML = '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(failMsg('PDF 한 파일로 묶지 못했습니다', e, '새로 고침 뒤 다시 해 주세요.')) + '</span></div>';
      C.render();
    });
    C.render();
  }

  /* ══════════════════ 이벤트 ══════════════════ */
  document.addEventListener('click', function (e) {
    var el;
    // 묶어 받기 창의 「닫기」 — 돌던 묶음을 바로 멈춘다(Esc·바깥 누르기는 다음 사람으로 넘어갈 때 alive() 가 멈춘다).
    if (FINJOB && e.target.closest('[data-close]') && $('xFinNote')) { FINJOB = null; setTimeout(function () { C.render(); }, 0); }
    if ((el = e.target.closest('[data-xup]'))) { openUpload(el.dataset.xup || ''); return; }
    if ((el = e.target.closest('[data-xday]'))) {
      // 다시 그리면 누른 단추가 새로 생긴다 — 키보드로 누르던 그 날로 포커스를 돌려준다(「기간 전체 보기」면 고르던 날로).
      var dv = el.dataset.xday, was = XDAY;
      XDAY = dv === XDAY ? '' : dv; C.render();
      var back = document.querySelector('.xcal [data-xday="' + (dv || was) + '"]');
      if (back) { try { back.focus({ preventScroll: true }); } catch (er) { } }
      return;
    }
    if (e.target.closest('#btnXUpGo')) { runUpload(); return; }
    if ((el = e.target.closest('[data-xrm]'))) {
      if (XUP.busy) return;
      readRows();
      var rm = XUP.items.splice(+el.dataset.xrm, 1)[0];
      if (rm && rm.crop && rm.crop.url) URL.revokeObjectURL(rm.crop.url);
      paintList(); return;
    }
    if ((el = e.target.closest('[data-xaddrow]'))) {
      if (XUP.busy) return;
      readRows();
      var i0 = +el.dataset.xaddrow, src = XUP.items[i0];
      if (src) { var nu = blankItem(src.page); nu.date = src.date; nu.cat = src.cat; XUP.items.splice(i0 + 1, 0, nu); paintList(); }
      return;
    }
    if ((el = e.target.closest('[data-xskip]'))) { var pg = XUP.pages[+el.dataset.xskip]; if (pg) pg.ai = ''; readRows(); paintList(); return; }
    if ((el = e.target.closest('[data-xedit]'))) { openEdit(el.dataset.xedit); return; }
    if ((el = e.target.closest('#btnXEditGo'))) { if (!el.disabled) saveEdit(el.dataset.id); return; }
    if ((el = e.target.closest('[data-xdel]'))) { openDel(el.dataset.xdel); return; }
    if ((el = e.target.closest('#btnXDelGo'))) { if (!el.disabled) runDel(el.dataset.id); return; }
    if (e.target.closest('[data-xreload]')) { ITEMS = {}; C.render(); return; }
    if (e.target.closest('[data-xvrun]')) { startRun(me()); return; }
    if ((el = e.target.closest('[data-xvfix]'))) { openFix(VITEMS[+el.dataset.xvfix]); return; }
    if (e.target.closest('[data-xpdf]')) { pdfMine(); return; }
    if ((el = e.target.closest('[data-xpdfok]'))) {
      setPreviewed(el.dataset.xpdfok, true);
      C.closePanel();
      if (C.state().VIEW !== 'x_verify') C.go('x_verify'); else C.render();
      setTimeout(function () { var b = document.getElementById('btnOpenSubmit'); if (b) { try { b.focus(); b.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (er) { } } }, 60);
      return;
    }
    if ((el = e.target.closest('[data-xfzpdf]'))) { pdfFrozen(el.dataset.xfzpdf); return; }
    if ((el = e.target.closest('[data-xfzxlsx]'))) { xlsxFrozen(el.dataset.xfzxlsx); return; }
    if ((el = e.target.closest('[data-xfzverify]'))) {
      var a = apprById(el.dataset.xfzverify), f = a && FZSUM[fzKey(a)];
      if (f && f.verify) C.vx.showItems(C.nameOf(a.username) + ' 개인경비 검증 결과', cycName(a.cycle) + ' · 상신 시점', f.verify);
      return;
    }
    if ((el = e.target.closest('[data-xcat]'))) { XL.cat = el.dataset.xcat; C.render(); return; }
    if (e.target.closest('[data-xmeal]')) { XL.meal = !XL.meal; C.render(); return; }
    if (e.target.closest('[data-xclear]')) { XL = { cat: 'all', who: '', meal: false }; C.render(); return; }
    if (e.target.closest('[data-xcsv]')) { listCsv(); return; }
    if ((el = e.target.closest('[data-xperson]'))) { var who = el.dataset.xperson; C.go('xa_list'); XL = { cat: 'all', who: who, meal: false }; C.render(); return; }
    if (e.target.closest('[data-xfinpdf]')) { finBundle(); return; }
    if (e.target.closest('[data-xfincsv]')) { finCsv(); return; }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'xFile') { addFiles(t.files); t.value = ''; return; }
    if (t.id === 'xWho') { XL.who = t.value; C.render(); var w = $('xWho'); if (w) w.focus(); return; }
    if (t.id === 'xePhFile') {
      var f = t.files && t.files[0]; t.value = '';
      if (!f) return;
      C.fileToJpegs(f).then(function (bl) {
        if (!bl || !bl[0] || !XEDIT) return;
        if (XEDIT.photo && XEDIT.photo.url) URL.revokeObjectURL(XEDIT.photo.url);
        XEDIT.photo = { blob: bl[0], url: URL.createObjectURL(bl[0]) };
        var im = $('xePh'); if (im) im.src = XEDIT.photo.url;
        C.toast('새 사진을 골랐습니다. 「저장」을 누르면 바뀝니다.');
      }, function () { C.toast('사진을 읽지 못했습니다.', true); });
      return;
    }
    if (t.matches && t.matches('[data-xfinsel]')) { if (t.checked) FINSEL[t.dataset.xfinsel] = 1; else delete FINSEL[t.dataset.xfinsel]; C.render(); return; }
    if (t.id === 'xFinAll') {
      cycAppr().forEach(function (a) { if (a.status === 'approved' && C.orgMatch(a.username)) { if (t.checked) FINSEL[a.id] = 1; else delete FINSEL[a.id]; } });
      C.render();
    }
  });
  // 칸을 고칠 때 식비 초과 표시를 바로 바꾸려고 줄을 다시 그리지는 않는다(커서가 튄다) — 올리기 전 검사에서 다시 본다.

  var S0 = {
    tag: '개인경비',
    rows: function () { return XAPPR || []; },
    mine: function (cyc) { return myX(cyc); },
    reload: function () { var S = C.state(); dropItems(S.CYCKEY); return Promise.all([loadAppr(), loadItems(S.CYCKEY, false, true)]); },
    sumLine: function (a) { var s = a.snapshot || {}; return s.cost != null ? n0(s.n) + '건 · ' + won(s.cost) : ''; },
    sumHtml: sumHtml,
    extra: extra,
    wantSummaries: wantSums,
    cycName: function (a) { return cycName(a.cycle) + ' (' + xSpanKey(a.cycle) + ') · 개인경비 지출결의'; },
    cycLabel: function (a) { return cycName(a.cycle) + ' (' + xSpanKey(a.cycle) + ')'; },
    submitHead: function () {
      var S = C.state(), x = ITEMS[itemKey(false, S.CYCKEY)], rows = ((x && x.rows) || []).filter(function (it) { return it.username === me(); });
      var T = sums(rows), warn = [];
      if (!rows.length) warn.push('이 기간에 올린 경비가 없습니다 — 먼저 영수증을 올려 주세요');
      if (T.meal) warn.push('식비 1인 13,000원 초과 ' + n0(T.meal) + '건(알림만, 결재자가 봅니다)');
      var noUse = rows.filter(function (it) { return !String(it.usage || '').trim(); }).length;
      if (noUse) warn.push('사용내역이 빈 줄 ' + n0(noUse) + '건');
      return { title: C.cycleName(S.CYC.y, S.CYC.m) + ' 개인경비 결재 상신', sub: xSpan(S.CYC.y, S.CYC.m) + ' · ' + n0(T.n) + '건 · ' + won(T.all), warn: warn };
    },
    rangeHi: function () { var S = C.state(); return xRange(S.CYC.y, S.CYC.m).hi; },
    beforeSubmit: beforeSubmit,
    verifyView: 'x_verify'
  };
  return {
    views: { x_month: viewMonth, x_verify: viewVerify, xa_close: viewAdminClose, xa_list: viewAdminList, xa_final: viewAdminFinal, xa_people: viewAdminPeople },
    admin: ADMIN_X,
    orgbar: ADMIN_X,
    orgUsers: orgUsers,
    kinds: { expense: S0 },
    period: { views: XVIEWS, current: xCurrent, span: xSpan, band: band, tag: tag },
    load: loadWith,
    onGo: function (v, prev) {
      if (v === 'x_verify') FRESH = {};
      if (v === 'xa_list' && prev !== 'xa_close') XL = { cat: 'all', who: '', meal: false };
      if (ADMIN_X.indexOf(v) >= 0 && isAdmin()) loadItems(C.state().CYCKEY, true);
    },
    onCycle: function () { XDAY = ''; FINSEL = {}; },
    dirty: function () {
      if (X_SENDING) return true;
      if ($('xDrop') && XUP.items.length && !XUP.sent) return true;
      if ($('btnXEditGo') && XEDIT && (XEDIT.photo || JSON.stringify(editVals()) !== XEDIT.before)) return true;
      return false;
    }
  };
});
