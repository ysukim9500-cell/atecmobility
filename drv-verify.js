/* ═══════════════════════════════════════════════════════════════════════════
   drv-verify.js — 검증 화면 · 결재 문서(PDF·엑셀)
   ---------------------------------------------------------------------------
   driving-app.js 가 내어 준 이음매(C)에 얹는다. 돈 계산은 여기서 하지 않는다 —
   기록부 모델은 C.pdfDocFor()(= sheetDataFor) 가, 검증은 서버(driving-verify)가 한다.

   ★ 결재 문서는 두 가지 재료에서 나온다
       · 지금 자료(live)  : 상신 전 미리보기. 쪽마다 「미리보기」가 찍힌다.
       · 고정본(frozen)   : 상신하는 순간 서버가 굳힌 자료. 결재자가 보는 것도,
                            결재 완료본도 이것이다 — 언제 받아도 같은 내용이 나온다.
                            결재가 끝나기 전에는 쪽마다 「결재 중」이 찍힌다.
   ═══════════════════════════════════════════════════════════════════════════ */
(window.DrvExtQ = window.DrvExtQ || []).push(function (C) {
  'use strict';
  var $ = C.$, esc = C.esc, ic = C.ic, n0 = C.n0;

  /* ══════════════════ 서버 ══════════════════ */
  function call(body) {
    return C.apiRetry('/functions/v1/driving-verify', { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j || j.error) throw new Error((j && j.error) || ('HTTP ' + r.status));
          return j;
        });
      });
  }

  /* ══════════════════ 검증 결과 보관 ══════════════════ */
  // 키 = 아이디|주기. undefined = 아직 안 물어봄 · null = 검증한 적 없음 · 객체 = 마지막 결과
  var ROWS = {}, ASKING = {}, RUN = { busy: false, note: '', who: '' };
  var ALLROWS = { key: '', list: null };          // 전체 검증(관리) — 주기별 최신 한 줄씩
  function keyOf(u, cyc) { return u + '|' + cyc; }
  /** "2026-09" → "2026년 9월분". 다른 화면과 같은 이름으로 부른다. */
  function cycName(key) {
    var p = String(key || '').split('-');
    return p.length === 2 && +p[0] && +p[1] ? C.cycleName(+p[0], +p[1]) : String(key || '') + '분';
  }

  function fetchLatest(u, cyc) {
    var k = keyOf(u, cyc);
    if (ASKING[k]) return ASKING[k];
    ASKING[k] = C.apiRetry('/rest/v1/driving_verifications?username=eq.' + encodeURIComponent(u) +
      '&cycle=eq.' + encodeURIComponent(cyc) + '&select=*&order=created_at.desc&limit=1')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (a) { ROWS[k] = (a && a[0]) || null; })
      .catch(function () { ROWS[k] = null; })
      .then(function () { delete ASKING[k]; });
    return ASKING[k];
  }

  /** 정해진 수만큼만 동시에 돌린다(사진 판독은 한 장에 몇 초 걸린다). */
  function pool(list, size, fn, onStep) {
    var i = 0, done = 0, fail = 0;
    return new Promise(function (ok) {
      if (!list.length) { ok({ done: 0, fail: 0 }); return; }
      function next() {
        if (i >= list.length) { if (done + fail === list.length) ok({ done: done, fail: fail }); return; }
        var item = list[i++];
        fn(item).then(function () { done++; }, function () { fail++; })
          .then(function () { if (onStep) onStep(done + fail, list.length); next(); });
      }
      for (var k = 0; k < Math.min(size, list.length); k++) next();
    });
  }

  /**
   * 검증 한 번: ① 규칙 검증 ② 아직 안 읽은 사진을 AI 로 읽힘 ③ 다시 검증.
   * onNote(글) 로 진행 상황을 알린다. 끝나면 마지막 결과 행을 돌려준다.
   * quiet 이면 사진을 못 읽었다는 토스트를 띄우지 않는다(상신 창이 따로 말한다).
   */
  function runVerify(u, cyc, onNote, quiet) {
    var say = onNote || function () { };
    say('기록을 검사하는 중…');
    return call({ op: 'run', cycle: cyc, username: u }).then(function (j) {
      var unread = j.unread || [];
      if (!unread.length) return j.row;
      var stop = '';
      return pool(unread, 3, function (id) {
        if (stop) return Promise.reject(new Error(stop));
        return call({ op: 'read', evidence_id: id }).catch(function (e) {
          // 하루 상한에 닿았으면 남은 것은 더 보내지 않는다.
          if (/횟수|한도/.test(String(e && e.message))) stop = e.message;
          throw e;
        });
      }, function (n, total) { say('영수증 사진을 읽는 중… ' + n + ' / ' + total + '장'); })
        .then(function (res) {
          say('읽은 값을 대조하는 중…');
          return call({ op: 'run', cycle: cyc, username: u }).then(function (j2) {
            if (!quiet) {
              if (stop) C.toast(stop, true);
              else if (res.fail) C.toast('사진 ' + res.fail + '장은 읽지 못했습니다. 다시 실행하면 이어서 읽습니다.', true);
            }
            return j2.row;
          });
        });
    });
  }

  /* ══════════════════ 화면 조각 ══════════════════ */
  var LV = { bad: ['불일치', 'bad'], warn: ['확인', 'warn'], info: ['참고', ''] };
  /** 검증 항목 → 고치러 갈 화면. 없으면 버튼을 달지 않는다. */
  var FIX = {
    R01: ['trips', '운행일지에서 보기'], R02: ['tollfill', '통행료 채우기'], R04: ['trips', '운행일지에서 보기'],
    R05: ['trips', '운행일지에서 보기'], R06: ['evid', '영수증에서 보기'], R07: ['evid', '영수증에서 보기'],
    R08: ['evid', '영수증에서 보기'], R09: ['evid', '영수증에서 보기'], A01: ['evid', '영수증에서 보기'],
    A02: ['evid', '영수증에서 보기'], A03: ['evid', '영수증에서 보기'], A04: ['evid', '영수증에서 보기'],
    A05: ['trips', '운행일지에서 보기'], A06: ['evid', '영수증에서 보기']
  };
  /** AI(Gemini)가 사진을 읽어 낸 항목인가 — 코드가 A 로 시작한다(A00 은 '읽지 않음' 안내). */
  function isAi(it) { return /^A0[1-9]/.test(String(it && it.code || '')); }
  /** Gemini 표시. 구글 공식 로고 파일이 아니라, 같은 색감의 반짝임 모양 + 이름이다. */
  function gemBadge(label) {
    return '<span class="gem" title="Google Gemini 가 사진을 읽어 찾은 항목">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="gemg" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#4C8DF6"/><stop offset=".55" stop-color="#9B72CB"/><stop offset="1" stop-color="#D96570"/></linearGradient></defs>' +
      '<path fill="url(#gemg)" d="M12 1.5c.6 5.6 4.9 9.9 10.5 10.5-5.6.6-9.9 4.9-10.5 10.5C11.4 16.9 7.1 12.6 1.5 12 7.1 11.4 11.4 7.1 12 1.5z"/></svg>' +
      (label || 'Gemini') + '</span>';
  }
  /** Gemini 반짝임 아이콘(버튼용). 그라데이션 id 가 겹치면 두 번째부터 색이 빠질 수 있어 부를 때마다 새 id. */
  var GEM_N = 0;
  function gemIcon(size) {
    var id = 'gemi' + (++GEM_N);
    return '<svg class="gemico" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="' + id +
      '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4C8DF6"/><stop offset=".55" stop-color="#9B72CB"/><stop offset="1" stop-color="#D96570"/>' +
      '</linearGradient></defs><path fill="url(#' + id + ')" d="M12 1.5c.6 5.6 4.9 9.9 10.5 10.5-5.6.6-9.9 4.9-10.5 10.5C11.4 16.9 7.1 12.6 1.5 12 7.1 11.4 11.4 7.1 12 1.5z"/></svg>';
  }
  /** 검증 버튼 — 도는 동안(running) 아이콘이 돌고 빛이 지나가며 진행 글자를 보여 준다. */
  function gemBtn(attrs, label, running, extraCls) {
    // 도는 동안은 빨간 기본 버튼 모양을 빼고 Gemini 색으로만 보인다.
    var cls = running ? String(extraCls || '').replace(' pri', '') : (extraCls || '');
    return '<button class="btn gembtn' + cls + (running ? ' running' : '') + '" ' + attrs +
      (running ? ' aria-busy="true"' : '') + '>' + gemIcon(running ? 16 : 15) + '<span class="gl">' + esc(label) + '</span></button>';
  }
  /** 지금 화면의 검증 항목(「바로 고치기」가 번호로 찾는다). */
  var VITEMS = [];
  /** links 가 참이면 항목마다 '고치러 가기' 버튼을 붙인다(본인 검증 화면에서만). */
  function itemsHtml(items, links) {
    if (!items || !items.length) {
      return '<div class="panel"><div class="blank"><div class="ico">' + ic('check', 21) + '</div>' +
        '<div class="t">확인이 필요한 항목이 없습니다.</div></div></div>';
    }
    return '<div class="panel vlist">' + items.map(function (it) {
      var lv = LV[it.level] || LV.info, fx = links && it.level !== 'info' ? FIX[it.code] : null;
      var refs = it.refs || {}, nRef = (refs.trips || []).length + (refs.evid || []).length;
      var go = '';
      if (links && it.code === 'R02') go = '<button class="btn sm vgo" data-v="tollfill">통행료 채우기' + ic('chev', 12) + '</button>';
      else if (links && nRef) {
        VITEMS.push(it);
        go = '<button class="btn sm vgo vfix" data-vfix="' + (VITEMS.length - 1) + '">바로 고치기' + ic('chev', 12) + '</button>';
      } else if (fx) go = '<button class="btn sm vgo" data-v="' + fx[0] + '">' + fx[1] + ic('chev', 12) + '</button>';
      return '<div class="vitem v-' + esc(it.level) + (isAi(it) ? ' v-ai' : '') + '"><span class="st ' + lv[1] + '">' + lv[0] + '</span>' +
        '<div class="vb"><div class="vt">' + esc(it.title) + (isAi(it) ? ' ' + gemBadge() : '') + '</div>' +
        '<div class="vd">' + esc(it.detail) + '</div></div>' + go + '</div>';
    }).join('') + '</div>';
  }
  /** 「바로 고치기」 — 항목이 가리키는 운행·영수증을 한 창에 모아 거기서 바로 고친다.
   *  운행 하나뿐이면 곧장 그 운행의 고치기 창을 연다. 영수증은 웹에서 지우고 다시 올릴 수 있다(값 고치기는 앱). */
  function openFix(it) {
    if (!it) return;
    var S = C.state(), refs = it.refs || {};
    var tid = (refs.trips || []).map(String), eid = (refs.evid || []).map(String);
    var trips = S.TRIPS.filter(function (t) { return tid.indexOf(String(t.id)) >= 0; })
      .sort(function (a, b) { return a.start_time - b.start_time; });
    var evs = S.EVID.filter(function (e) { return eid.indexOf(String(e.id)) >= 0; })
      .sort(function (a, b) { return a.date_millis - b.date_millis; });
    if (trips.length === 1 && !eid.length) { C.openEdit(trips[0].id); return; }
    if (!trips.length && !evs.length) { C.toast('가리키는 운행·영수증을 찾지 못했습니다. 기간을 확인하거나 「다시 검증」을 눌러 주세요.', true); return; }
    var mine = C.myName();
    var body = '<div class="anote">' + esc(it.detail) + '</div>';
    if (trips.length) {
      body += '<div class="fixh">운행 ' + n0(trips.length) + '건</div><div class="fixl">' + trips.map(function (t) {
        var cost = [];
        if (Number(t.parking_cost) > 0) cost.push('주차 ' + n0(t.parking_cost));
        if (Number(t.toll_cost) > 0) cost.push('통행료 ' + n0(t.toll_cost));
        return '<div class="fixi"><div class="fixt"><b>' + C.md(t.start_time) + ' ' + C.hm(t.start_time) + '</b> ' +
          esc(t.plate_no || '') + ' · ' + esc(t.purpose || '목적 없음') +
          '<div class="dim">' + esc([t.visit_place, t.end_address].filter(Boolean)[0] || '') +
          ' · 계기판 ' + n0(t.start_odometer) + ' → ' + n0(t.end_odometer) + (cost.length ? ' · ' + cost.join(' · ') : '') + '</div></div>' +
          '<button class="btn sm pri" data-edit="' + esc(t.id) + '">운행 고치기</button></div>';
      }).join('') + '</div>';
    }
    if (evs.length) {
      body += '<div class="fixh">영수증·사진 ' + n0(evs.length) + '건</div><div class="fixl">' + evs.map(function (e) {
        var canDel = e.username === mine && !C.evLocked(e);
        return '<div class="fixi">' + (e.photo_path
            ? '<a class="fixph" target="_blank" rel="noopener" href="' + esc(C.photoUrl(e.photo_path)) + '"><img alt="" loading="lazy" src="' + esc(C.photoUrl(e.photo_path)) + '"></a>'
            : '<span class="fixph none">사진 없음</span>') +
          '<div class="fixt"><b>' + C.md(e.date_millis) + ' ' + esc(e.category || '기타') + ' ' + n0(e.amount) + '원</b>' +
          '<div class="dim">' + esc([e.vehicle_plate, e.memo].filter(Boolean).join(' · ')) + '</div></div>' +
          (e.photo_path ? '<a class="btn sm" target="_blank" rel="noopener" href="' + esc(C.photoUrl(e.photo_path)) + '">사진 크게</a>' : '') +
          (canDel ? ' <button class="btn sm" data-evdel="' + esc(e.id) + '">지우기</button>' : '') + '</div>';
      }).join('') + '</div>' +
        '<div class="fhint" style="margin-top:8px">영수증의 금액·날짜·구분은 앱에서 고치거나, 여기서 지운 뒤 「증빙」에서 다시 올려 주세요.</div>';
    }
    C.openPanel('바로 고치기 — ' + it.title, (isAi(it) ? 'Gemini 가 사진을 읽어 찾은 항목 · ' : '') + '고친 뒤 「다시 검증」을 눌러 주세요',
      body, '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
  }
  function sumText(s) {
    if (!s) return '';
    var p = [];
    if (s.bad) p.push('불일치 ' + n0(s.bad));
    if (s.warn) p.push('확인 ' + n0(s.warn));
    if (s.info) p.push('참고 ' + n0(s.info));
    return p.length ? p.join(' · ') : '이상 없음';
  }
  /** 검증 요약 딱지. 빨강은 '불일치'에만 쓴다 — 참고 1건까지 빨갛게 칠하면 무엇을 봐야 할지 모른다. */
  function sumChip(s) {
    if (!s) return '';
    var p = [];
    if (s.bad) p.push('<span class="st bad">불일치 ' + n0(s.bad) + '</span>');
    if (s.warn) p.push('<span class="st warn">확인 ' + n0(s.warn) + '</span>');
    if (s.info) p.push('<span class="st dim">참고 ' + n0(s.info) + '</span>');
    if (!p.length) p.push('<span class="st ok">이상 없음</span>');
    return '<span class="vsumc"><span class="vlab">검증</span>' + p.join('') + '</span>';
  }
  function whenText(iso) {
    var ms = Date.parse(iso);
    return isFinite(ms) ? C.ymd(ms) + ' ' + C.hm(ms) : '';
  }

  /* ══════════════════ 검증 (개인) ══════════════════ */
  function viewVerify() {
    var S = C.state();
    if (!S.LOADED) return C.head('검증') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('검증', '검증');
    var u = C.myName(), cyc = S.CYCKEY, k = keyOf(u, cyc);
    var h = C.head('검증', esc(C.cycleName(S.CYC.y, S.CYC.m)) +
      ' · 상신하기 전에 운행·영수증·계기판이 서로 맞는지 살펴봅니다');
    if (ROWS[k] === undefined) {
      fetchLatest(u, cyc).then(function () { if (C.state().VIEW === 'verify') C.render(); });
      return h + C.skeleton();
    }
    var row = ROWS[k], busy = RUN.busy && RUN.who === k;
    VITEMS = [];
    var a = C.myAppr(), locked = a && (a.status === 'submitted' || a.status === 'approved');
    var s = row && row.summary, items = (row && row.result && row.result.items) || [];
    var verdict, clean = '';
    if (busy) verdict = '<span class="gemrun">' + gemBadge('Gemini') + '</span>' + esc(RUN.note || '검증하는 중…');
    else if (!row) verdict = '아직 검증하지 않았습니다';
    else if (s.bad) verdict = '맞지 않는 곳이 <em>' + n0(s.bad) + '건</em> 있습니다';
    else if (s.warn) { verdict = '확인할 것이 <em>' + n0(s.warn) + '건</em> 있습니다'; clean = ' wait'; }
    else { verdict = '<em>이상 없습니다</em>'; clean = ' clean'; }

    // 검증은 한 번에 하나만 돈다. 다른 주기 것이 돌고 있으면 그렇다고 말한다(눌러도 반응이 없으면 고장으로 보인다).
    var btn = gemBtn('data-vrun' + (RUN.busy ? ' disabled' : ''),
      busy ? (RUN.note || 'Gemini 가 읽는 중…') : RUN.busy ? '다른 검증이 도는 중…' : row ? '다시 검증' : '검증 실행',
      busy, row || locked ? '' : ' pri');
    // 검증을 봤으면 다음 할 일은 상신이다 — 마감 현황으로 돌아가야 한다는 것을 알 길이 없었다.
    var canSubmit = !a || a.status === 'rejected' || a.status === 'withdrawn';
    var submitBtn = row && canSubmit && !busy
      ? '<button class="btn pri" id="btnOpenSubmit">' + (a && a.status === 'rejected' ? '다시 상신' : '결재 상신') + '</button>' : '';
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (row && !s.bad ? ' ok' : '') + '"></span>' +
      (row ? '마지막 검증 ' + esc(whenText(row.created_at)) : '검증 전') + '</div>' +
      '<p class="verdict' + clean + '">' + verdict + '</p>' +
      (row ? '<div class="facts">' +
        fact('불일치', n0(s.bad), '금액·계기판이 서로 다름', s.bad > 0) +
        fact('확인 필요', n0(s.warn), '사람이 한 번 봐야 함') +
        fact('참고', n0(s.info), '고칠 것은 아님') +
        fact('사진 판독', row.ai ? n0(s.read) + ' / ' + n0(s.receipts) + '<small>장</small>' : '—',
          row.ai ? 'AI 가 읽은 영수증·계기판' : 'AI 미설정 — 규칙 검증만', false, row.ai) +
        '</div>' : '') +
      '<div class="vact">' + btn +
      '<button class="btn" data-pdf="">' + ic('dl', 14) + (locked ? '결재 문서 PDF' : 'PDF 미리보기') + '</button>' +
      (submitBtn ? '<span style="flex:1"></span>' + submitBtn : '') + '</div></div>';

    if (locked) {
      h += '<div class="hpnote">' + ic('check', 16) + '<span><b>' +
        (a.status === 'approved' ? '결재가 끝났습니다.' : '결재 중입니다.') +
        '</b> 상신할 때의 자료와 검증 결과는 그대로 저장돼 있습니다. 아래는 지금 자료를 다시 본 결과입니다.</span></div>';
    }
    if (row) {
      var need = items.filter(function (i) { return i.level !== 'info'; });
      var info = items.filter(function (i) { return i.level === 'info'; });
      h += C.sect('봐야 할 것', need.length ? need.length + '건' : null, '', itemsHtml(need, !locked));
      if (info.length) h += C.sect('참고', info.length + '건', '', itemsHtml(info));
    } else if (!busy) {
      h += '<div class="panel"><div class="blank"><div class="ico">' + ic('scan', 21) + '</div>' +
        '<div class="t">「검증 실행」을 누르면 이번 주기 기록을 살펴봅니다.</div>' +
        '<div class="d">계기판이 이어지는지, 영수증 금액이 입력과 같은지, 같은 영수증을 두 번 올리지 않았는지 봅니다.<br>' +
        '맞지 않는 곳이 있어도 상신은 할 수 있습니다 — 결재자가 같이 봅니다.</div></div></div>';
    }
    h += '<div class="anote">금액 계산은 규칙으로만 합니다. ' + gemBadge('Gemini AI') + ' 는 사진을 읽어 <b>입력값과 다른 곳을 표시</b>할 뿐, 값을 바꾸지 않습니다. ' +
      '「바로 고치기」로 고친 뒤에는 「다시 검증」을 눌러 주세요.</div>';
    return h;

    function fact(kk, v, sub, alert, gem) {
      return '<div class="fact"><div class="k">' + esc(kk) + (gem ? ' ' + gemBadge() : '') + '</div>' +
        '<div class="v' + (alert ? ' alert' : '') + '">' + v + '</div>' +
        '<div class="sub">' + esc(sub || '') + '</div></div>';
    }
  }

  function startRun(u) {
    var S = C.state(), cyc = S.CYCKEY, k = keyOf(u, cyc);
    if (RUN.busy) return;
    RUN = { busy: true, note: '기록을 검사하는 중…', who: k };
    C.render();
    // 돌고 있는 검증의 결과를 다른 곳(상신 창)도 기다릴 수 있게 약속을 걸어 둔다.
    var p = runVerify(u, cyc, function (t) {
      RUN.note = t;
      // 화면 전체를 다시 그리지 않는다. 그 사이 다른 주기로 넘어갔으면 남의 판정 줄에 쓰지 않는다.
      var st = C.state(), v = document.querySelector('.hero .verdict');
      if (v && st.VIEW === 'verify' && st.CYCKEY === cyc && !C.isMulti()) {
        v.textContent = t;
        var gl = document.querySelector('[data-vrun] .gl'); if (gl) gl.textContent = t;   // 버튼에도 진행 상황
      }
    });
    RUN.p = p;
    p.then(function (row) {
      ROWS[k] = row || null;
      ALLROWS.list = null;
      C.toast(row ? '검증했습니다 — ' + sumText(row.summary) : '검증했습니다.');
    }).catch(function (e) {
      C.toast('검증하지 못했습니다: ' + ((e && e.message) || ''), true);
    }).then(function () { RUN = { busy: false, note: '', who: '' }; C.render(); });
  }

  /* ══════════════════ 전체 검증 (관리) ══════════════════ */
  function viewVerifyAll() {
    var S = C.state();
    if (!S.LOADED) return C.head('전체 검증') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('전체 검증', '검증');
    var cyc = S.CYCKEY;
    var h = C.head('전체 검증', esc(C.cycleName(S.CYC.y, S.CYC.m)) + ' · 직원별 마지막 검증 결과');
    if (ALLROWS.key !== cyc || !ALLROWS.list) {
      ALLROWS = { key: cyc, list: null };
      C.fetchAll('/rest/v1/driving_verifications?cycle=eq.' + encodeURIComponent(cyc) +
        '&select=id,username,summary,ai,created_at,result&order=created_at.desc')
        .then(function (rows) {
          var seen = {}, out = [];
          (rows || []).forEach(function (r) { if (!seen[r.username]) { seen[r.username] = 1; out.push(r); } });
          ALLROWS = { key: cyc, list: out };
          out.forEach(function (r) { ROWS[keyOf(r.username, cyc)] = r; });
        }).catch(function () { ALLROWS = { key: cyc, list: [] }; })
        .then(function () { if (C.state().VIEW === 'a_verify') C.render(); });
      return h + C.skeleton();
    }
    var by = {};
    ALLROWS.list.forEach(function (r) { by[r.username] = r; });
    // 이번 주기에 운행이나 검증 기록이 있는 사람
    var users = {};
    S.ALL_TRIPS.forEach(function (t) { users[t.username] = 1; });
    Object.keys(by).forEach(function (u) { users[u] = 1; });
    var list = Object.keys(users).map(function (u) {
      var r = by[u], s = r && r.summary;
      var a = S.APPR.filter(function (x) { return x.username === u && x.cycle === cyc; })[0];
      return { u: u, r: r, s: s, a: a, rank: !r ? 1 : s.bad ? 0 : s.warn ? 2 : 3 };
    }).sort(function (x, y) { return x.rank - y.rank || C.nameOf(x.u).localeCompare(C.nameOf(y.u), 'ko'); });
    var nBad = list.filter(function (x) { return x.s && x.s.bad; }).length;
    var nNone = list.filter(function (x) { return !x.r; }).length;

    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (nBad ? '' : ' ok') + '"></span>' + n0(list.length) + '명</div>' +
      '<p class="verdict' + (nBad ? '' : ' clean') + '">' +
      (nBad ? '불일치가 있는 사람이 <em>' + n0(nBad) + '명</em> 있습니다' : '<em>불일치가 없습니다</em>') + '</p>' +
      '<div class="facts"><div class="fact"><div class="k">검증 안 한 사람</div><div class="v">' +
      n0(nNone) + '<small>명</small></div><div class="sub">각자 「검증」에서 실행하거나 아래에서 대신 실행</div></div></div></div>';

    h += C.sect('직원별', list.length + '명', '',
      '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>이름</th><th>소속</th><th>결과</th><th>사진 판독</th><th>검증 시각</th><th>결재</th><th></th></tr></thead><tbody>' +
      list.map(function (x) {
        var p = C.personOf(x.u);
        var busy = RUN.busy && RUN.who === keyOf(x.u, cyc);
        var stuck = x.a && x.a.status === 'submitted';
        return '<tr><td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td>' +
          '<td class="dim">' + esc(p.dept || '') + '</td>' +
          '<td>' + (x.r ? sumChip(x.s) : '<span class="dim">검증 전</span>') + '</td>' +
          '<td class="dim">' + (x.r && x.r.ai ? n0(x.s.read) + ' / ' + n0(x.s.receipts) : '—') + '</td>' +
          '<td class="dim">' + (x.r ? esc(whenText(x.r.created_at)) : '') + '</td>' +
          '<td>' + (x.a ? '<span class="st ' + (x.a.status === 'approved' ? 'ok' : x.a.status === 'submitted' ? 'warn' : x.a.status === 'rejected' ? 'bad' : '') + '">' +
            esc({ approved: '결재 완료', submitted: '결재 중', rejected: '반려', withdrawn: '회수' }[x.a.status] || '') + '</span>' : '<span class="dim">상신 전</span>') + '</td>' +
          '<td class="n" style="white-space:nowrap">' +
          (x.r ? '<button class="btn sm" data-vshow="' + esc(x.u) + '">결과 보기</button> ' : '') +
          gemBtn('data-vrunfor="' + esc(x.u) + '"' + (RUN.busy ? ' disabled' : ''), busy ? '읽는 중…' : x.r ? '다시 검증' : '검증', busy, ' sm') +
          // 결재자가 자리에 없어 결재가 멈췄을 때의 탈출구 — 사유가 기록에 남는다.
          (stuck ? ' <button class="btn sm" data-appr="force_reject" data-id="' + x.a.id + '" title="결재가 멈췄을 때 관리자 권한으로 반려합니다">관리자 반려</button>' : '') +
          // 결재가 끝난 건의 정정 — 잠금을 풀어 다시 상신하게 한다(완료본은 이력에 남는다).
          (x.a && x.a.status === 'approved' ? ' <button class="btn sm" data-appr="reopen" data-id="' + x.a.id + '" title="결재 완료 건을 정정하도록 다시 엽니다">정정 열기</button>' : '') +
          '</td></tr>';
      }).join('') + '</tbody></table></div></div>');
    h += '<div class="anote"><b>관리자 반려</b>는 결재자가 자리에 없어 결재가 멈췄을 때만 씁니다. 반려하면 그 직원의 잠금이 풀려 고쳐서 다시 올릴 수 있고, ' +
      '누가 왜 반려했는지 기록에 남습니다. 승인을 대신할 수는 없습니다.<br>' +
      '<b>정정 열기</b>는 결재가 끝난 뒤 고칠 것이 생겼을 때 씁니다. 잠금이 풀려 직원이 고쳐 다시 상신하고 결재선을 처음부터 다시 탑니다. ' +
      '그때의 결재 완료본은 이력에 남습니다.</div>';
    return h;
  }

  function showItems(title, sub, v) {
    var s = (v && v.summary) || {}, items = (v && (v.items || (v.result && v.result.items))) || [];
    C.openPanel(title, sub,
      '<div class="vsum">' + sumChip(s) +
      (v && (v.ran_at || v.created_at) ? '<span class="dim">' + esc(whenText(v.ran_at || v.created_at)) + ' 기준</span>' : '') +
      (v && v.ai === false ? '<span class="dim">AI 판독 없음</span>' : '') + '</div>' +
      itemsHtml(items.filter(function (i) { return i.level !== 'info'; })) +
      (items.some(function (i) { return i.level === 'info'; })
        ? '<div class="vsub">참고</div>' + itemsHtml(items.filter(function (i) { return i.level === 'info'; })) : ''),
      '<span style="flex:1"></span><button class="btn pri" data-close>닫기</button>');
  }

  /* ══════════════════ 고정본 ══════════════════
     ★ 회수·반려 뒤 다시 상신하면 서버는 같은 결재 번호를 다시 쓰고 고정본을 덮어쓴다.
       번호만으로 기억해 두면 옛 문서가 나온다(결재자가 옛 PDF 를 보고 새 건을 승인한다).
       그래서 열쇠에 상신 시각을 넣는다 — 다시 상신하면 열쇠가 달라져 새로 받는다. */
  var FZ = {};                           // 열쇠 → 고정본(통째) | null(없음)
  var FZSUM = {}, FZFAIL = {}, FZASK = '';   // 열쇠 → {verify 요약} | null · 실패 시각 · 묻는 중인 묶음
  var STALE_SEEN = {};                       // 열쇠 → 상신 시각이 어긋난 것을 한 번 본 적이 있다
  function fzKey(a) { return a.id + '|' + (a.submitted_at || ''); }
  function apprById(id) {
    return C.state().APPR.filter(function (x) { return String(x.id) === String(id); })[0] || null;
  }
  /** 받아 온 고정본이 이 결재 건(이번 상신)의 것인가. 서버는 상신 시각과 고정 시각에 같은 값을 쓴다. */
  function sameSubmit(a, fz) {
    if (!fz || !a.submitted_at || !fz.frozen_at) return true;
    return Date.parse(fz.frozen_at) === Date.parse(a.submitted_at);
  }
  function fetchFrozen(a) {
    var k = fzKey(a);
    if (FZ[k] !== undefined) return Promise.resolve(FZ[k]);
    return C.apiRetry('/rest/v1/driving_frozen?approval_id=eq.' + encodeURIComponent(a.id) + '&select=*&limit=1')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (rows) {
        var fz = (rows && rows[0]) || null;
        // 화면의 결재 목록이 옛것이다(그 사이 회수·재상신됨) — 옛 번호표로 새 문서를 열지 않는다.
        // 목록을 다시 받은 뒤에도 같은 열쇠로 또 어긋나면 그 건은 원래 두 시각이 다른 것이다(목록 탓이 아니다).
        // 그때는 받은 자료를 그대로 쓴다 — 누를 때마다 전체를 다시 받으며 '바뀌었습니다'만 되풀이하지 않게.
        if (!sameSubmit(a, fz)) {
          if (!STALE_SEEN[k]) { STALE_SEEN[k] = 1; var e = new Error('STALE'); e.stale = true; throw e; }
        }
        FZ[k] = fz;
        return fz;
      });
  }
  /** 고정본을 못 받았을 때 할 말. 결재 건이 바뀐 것이면 목록을 다시 받는다. */
  function frozenFail(e) {
    if (e && e.stale) { C.toast('결재 건이 바뀌었습니다(회수·재상신). 목록을 다시 불러옵니다.', true); C.loadAll(); return; }
    C.toast('결재 문서를 불러오지 못했습니다. 잠시 뒤 다시 해 보세요.', true);
  }
  /** 결재 카드에 붙일 검증 요약을 한 번에 받아 온다. 받으면 화면을 다시 그린다. */
  function wantSummaries(ids) {
    var now = Date.now(), need = [];
    (ids || []).forEach(function (id) {
      var a = apprById(id);
      if (!a || a.status === 'draft') return;
      var k = fzKey(a);
      if (FZSUM[k] !== undefined) return;
      if (FZFAIL[k] && now - FZFAIL[k] < 30000) return;        // 방금 실패했으면 잠깐 쉰다(다시 그릴 때마다 묻지 않게)
      need.push(a);
    });
    if (!need.length) return;
    var sig = need.map(fzKey).join(',');
    if (FZASK === sig) return;
    FZASK = sig;
    var view = C.state().VIEW;
    C.apiRetry('/rest/v1/driving_frozen?approval_id=in.(' + need.map(function (a) { return a.id; }).join(',') +
      ')&select=approval_id,verify,frozen_at')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (rows) {
        var by = {};
        (rows || []).forEach(function (x) { by[x.approval_id] = x; });
        need.forEach(function (a) { FZSUM[fzKey(a)] = by[a.id] || null; });
        FZASK = '';
        // 물어본 그 화면에 아직 있을 때만 다시 그린다(다른 화면에서 치던 것을 건드리지 않는다).
        if (C.state().VIEW === view) C.render();
      })
      .catch(function () {
        // ★ 실패를 '고정본 없음'으로 굳히지 않는다 — 그러면 결재 문서 버튼이 세션 내내 사라진다.
        need.forEach(function (a) { FZFAIL[fzKey(a)] = Date.now(); });
        FZASK = '';
      });
  }
  /** 결재 카드에 끼워 넣는 줄: 검증 요약 + 결재 문서 버튼. */
  function apprExtra(a) {
    if (!a || a.status === 'draft') return '';
    var f = FZSUM[fzKey(a)];
    var done = a.status === 'approved', live = a.status === 'submitted' || done;
    if (f === null) {
      // 상신 때 저장한 자료가 없는 옛 결재 건. 지금 보고 있는 주기의 것이면 지금 자료로 만들어 준다.
      if (!live) return '';
      var S = C.state(), mine = a.username === C.myName();
      if (a.cycle === S.CYCKEY && !C.isMulti() && (mine || C.isAll())) {
        return '<div class="aext"><span class="dim" style="font-size:12px;flex:1">상신 때 저장한 자료가 없는 건입니다(예전 방식) — 지금 자료로 만듭니다.</span>' +
          '<button class="btn sm" data-pdf="' + (mine ? '' : esc(a.username)) + '">' + ic('dl', 13) + '운행기록부 PDF</button></div>';
      }
      return '<div class="aext"><span class="dim" style="font-size:12px">상신 때 저장한 자료가 없는 건입니다(예전 방식). ' +
        '그 달 화면의 「정산·엑셀」에서 받을 수 있습니다.</span></div>';
    }
    var chip = f && f.verify ? '<button class="vchip" data-fzverify="' + a.id + '" title="상신할 때의 검증 결과 보기">' +
      sumChip(f.verify.summary) + '</button>' : '';
    return '<div class="aext">' + chip +
      '<span style="flex:1"></span>' +
      '<button class="btn sm" data-fzpdf="' + a.id + '">' + ic('dl', 13) +
      (done ? '결재 완료본 PDF' : live ? '결재 문서 PDF' : '상신했던 문서 PDF') + '</button>' +
      (done ? '<button class="btn sm" data-fzxlsx="' + a.id + '">결재 완료본 엑셀</button>' : '') +
      '</div>';
  }

  /* ══════════════════ PDF ══════════════════ */
  var LIBS = null;
  function loadScript(src) {
    return new Promise(function (ok, no) {
      var s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = function () { no(new Error('불러오지 못함: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function fetchBytes(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('불러오지 못함: ' + url);
      return r.arrayBuffer();
    }).then(function (b) { return new Uint8Array(b); });
  }
  /** pdf-lib · fontkit · 글꼴은 쓸 때 한 번만 받는다(합쳐 5MB 남짓 — 처음 한 번만 느리다). */
  function ensureLibs() {
    if (LIBS) return LIBS;
    var base = function (p) { return new URL(p, document.baseURI).href; };
    LIBS = Promise.all([
      window.PDFLib ? null : loadScript(base('vendor/pdf-lib.min.js')),
      window.fontkit ? null : loadScript(base('vendor/fontkit.umd.min.js')),
      fetchBytes(base('vendor/NanumGothic-Regular.ttf')),
      fetchBytes(base('vendor/NanumGothic-Bold.ttf'))
    ]).then(function (x) {
      if (!window.PDFLib || !window.fontkit || !window.SheetPdf) throw new Error('PDF 도구를 불러오지 못했습니다');
      return { PDFLib: window.PDFLib, fontkit: window.fontkit, fontRegular: x[2], fontBold: x[3] };
    }).catch(function (e) { LIBS = null; throw e; });
    return LIBS;
  }
  /** 사진을 받아 긴 변 max 픽셀의 JPEG 로 다시 만든다(폰 사진 5MB 를 그대로 넣으면 PDF 가 수십 MB 가 된다).
   *  캔버스를 거치면 EXIF 방향도 바로 선다. */
  function loadPhoto(path, max) {
    var url = C.SB + '/storage/v1/object/public/evidence/' + path.split('/').map(encodeURIComponent).join('/');
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function (blob) {
        return new Promise(function (ok, no) {
          var u = URL.createObjectURL(blob), img = new Image();
          img.onload = function () {
            URL.revokeObjectURL(u);
            var sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
            var cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(img.naturalWidth * sc));
            cv.height = Math.max(1, Math.round(img.naturalHeight * sc));
            var cx = cv.getContext('2d');
            cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
            cx.drawImage(img, 0, 0, cv.width, cv.height);
            cv.toBlob(function (b) {
              if (!b) { no(new Error('toBlob')); return; }
              b.arrayBuffer().then(function (ab) { ok(new Uint8Array(ab)); }, no);
            }, 'image/jpeg', 0.86);
          };
          img.onerror = function () { URL.revokeObjectURL(u); no(new Error('image')); };
          img.src = u;
        });
      }).catch(function () { return null; });
  }

  var PDF_URLS = [], PDF_JOB = null;
  /** 문서 상태 표시(meta.mark) 별 결과 창 안내문. */
  var MARK_NOTE = {
    preview: '상신 전 미리보기입니다. 쪽마다 <b>「미리보기」</b>가 찍혀 있습니다. 결재가 끝나면 같은 자리에서 <b>결재 완료본</b>을 받을 수 있습니다.',
    pending: '상신할 때 저장한 자료로 만든 문서입니다. 결재가 끝나기 전이라 쪽마다 <b>「결재 중」</b>이 찍혀 있습니다.',
    rejected: '반려된 상신 건의 문서입니다. 쪽마다 <b>「반려」</b>가 찍혀 있습니다.',
    withdrawn: '회수한 상신 건의 문서입니다. 쪽마다 <b>「회수」</b>가 찍혀 있습니다.',
    '': '상신할 때 저장한 자료로 만든 문서입니다. <b>언제 받아도 같은 내용</b>이 나옵니다.'
  };
  /**
   * PDF 를 만들어 결과 창을 띄운다.
   *   o = { doc(기록부 재료), verify, meta{name,cycleName,docNo,mark}, title, sub, file, note(안내문 HTML),
   *         expect(상신 때 집계한 총액 — 문서 총계와 다르면 알린다) }
   */
  function makePdf(o) {
    var scanPaths = {};
    (o.doc.scans || []).forEach(function (s) { scanPaths[s.path] = 1; });
    var nImg = Object.keys(scanPaths).length + (o.doc.photos || []).length;
    C.openPanel(o.title, o.sub,
      '<div class="pdfwait"><div class="spin"></div><div id="pdfNote" role="status">PDF 를 만드는 중입니다…</div>' +
      '<div class="dim" style="margin-top:6px">' + (nImg ? '사진 ' + n0(nImg) + '장을 넣습니다. ' : '') +
      '처음 한 번은 글꼴을 받느라 조금 걸립니다.</div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
    // ★ 만드는 데 몇 초~수십 초 걸린다. 그 사이 창을 닫고 다른 창(운행 추가 등)을 열었으면
    //   결과로 그 창을 덮어쓰면 안 된다 — 이 작업이 띄운 '만드는 중' 줄이 아직 있을 때만 쓴다.
    var job = PDF_JOB = {};
    var mine = function () { return PDF_JOB === job && !!$('pdfNote') && $('panel').classList.contains('open'); };
    var note = function (t) { var el = $('pdfNote'); if (el && PDF_JOB === job) el.textContent = t; };
    var loaded = 0;
    // 결재란 서명(올린 서명 · 이름 도장)을 먼저 채운다.
    return (C.fillSigns ? C.fillSigns(o.doc) : Promise.resolve()).then(ensureLibs).then(function (lib) {
      note(nImg ? '사진을 불러오는 중… 0 / ' + nImg : 'PDF 를 만드는 중입니다…');
      return window.SheetPdf.build({
        meta: o.meta, sheets: o.doc.sheets, verify: o.verify || null,
        scans: o.doc.scans, photos: o.doc.photos
      }, {
        PDFLib: lib.PDFLib, fontkit: lib.fontkit, fontRegular: lib.fontRegular, fontBold: lib.fontBold,
        loadImage: function (p) {
          return loadPhoto(p, scanPaths[p] ? 2000 : 1500).then(function (b) {
            loaded++; note('사진을 불러오는 중… ' + loaded + ' / ' + nImg);
            return b;
          });
        }
      });
    }).then(function (res) {
      if (!mine()) return res;
      var blob = new Blob([res.bytes], { type: 'application/pdf' });
      PDF_URLS.forEach(function (u) { URL.revokeObjectURL(u); });
      var url = URL.createObjectURL(blob); PDF_URLS = [url];
      var mb = (blob.size / 1e6).toFixed(1);
      // 자체 검사 — 칸을 넘친 글자·못 불러온 사진·글꼴에 없는 글자
      var over = res.issues.filter(function (i) { return i.kind === 'overflow' || i.kind === 'tiny'; });
      var img = res.issues.filter(function (i) { return i.kind === 'image'; });
      var gly = res.issues.filter(function (i) { return i.kind === 'glyph'; });
      var chk = '';
      if (!over.length && !img.length && !gly.length) {
        chk = '<div class="pdfok">' + ic('check', 15) + '<span>문서 점검 완료 — 잘린 글자·빠진 사진 없음</span></div>';
      } else {
        chk = '<div class="awarn">' + ic('alert', 15) + '<span>' +
          [over.length ? '글자가 칸에 꽉 찬 곳 ' + over.length + '곳(' + esc(over[0].page + '쪽') + ' 등)' : '',
            img.length ? '불러오지 못한 사진 ' + img.length + '장' : '',
            gly.length ? '글꼴에 없어 ? 로 바꾼 글자 ' + gly.length + '종' : ''].filter(Boolean).join(' · ') +
          ' — 열어서 확인해 주세요.</span></div>';
      }
      // 문서 총계(장별 총계의 합)가 상신 때 서버가 집계한 금액과 같은가 — 다르면 결재 카드와 문서가 다른 숫자를 말한다.
      var sum = (res.totals || []).reduce(function (s, t) { return s + (Number(t && t.all) || 0); }, 0);
      if (o.expect != null && isFinite(Number(o.expect)) && Math.abs(Math.round(sum) - Math.round(Number(o.expect))) > 1) {
        chk += '<div class="awarn">' + ic('alert', 15) + '<span>문서 총계 <b>' + C.won(sum) + '</b> 가 ' + (o.expectName || '상신 때 집계한 금액') + ' <b>' +
          C.won(o.expect) + '</b> 과 ' + n0(Math.abs(Math.round(sum) - Math.round(Number(o.expect)))) +
          '원 다릅니다. 관리자에게 알려 주세요.</span></div>';
      }
      var mk = o.meta.mark || '';
      $('pBody').innerHTML = '<div class="pdfdone"><div class="big">' + n0(res.pages) + '<small>쪽</small></div>' +
        '<div class="dim">' + mb + ' MB · 운행기록부 ' + n0((o.doc.sheets || []).length) + '장' +
        (o.verify ? ' · 검증 결과' : '') + (nImg ? ' · 영수증 사진 ' + n0(nImg) + '장' : '') + '</div>' + chk +
        '<div class="anote">' + (o.note || MARK_NOTE[mk] || MARK_NOTE['']) + '</div></div>';
      $('pFoot').innerHTML = C.backBtn() + '<span style="flex:1"></span><button class="btn" data-close>닫기</button>' +
        '<a class="btn" href="' + url + '" download="' + esc(o.file) + '">' + ic('dl', 14) + '내려받기</a>' +
        '<a class="btn pri" id="pdfOpen" href="' + url + '" target="_blank" rel="noopener">열기 · 인쇄</a>';
      var op = $('pdfOpen'); if (op) { try { op.focus(); } catch (e) { } }
      return res;
    }).catch(function (e) {
      if (mine()) $('pBody').innerHTML = '<div class="awarn">' + ic('alert', 15) +
        '<span>PDF 를 만들지 못했습니다: ' + esc((e && e.message) || '') + '</span></div>';
      throw e;
    });
  }

  function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_'); }

  /** 지금 자료로 만든다. 상신 전이면 미리보기, 고정본이 없는 옛 결재 건이면 그 사정을 문서에 적는다. */
  function pdfLive(who) {
    var S = C.state(), u = who || C.myName(), cyc = S.CYCKEY;
    var ap = C.apprOf(u, cyc);
    var doc = C.pdfDocFor(u, ap);
    if (!doc.any) { C.toast('이번 주기에 담을 운행·영수증이 없습니다.', true); return; }
    var k = keyOf(u, cyc);
    // 결재 중·완료인데 지금 자료로 만드는 것은 '상신 때 저장한 자료가 없는 옛 건'뿐이다.
    var old = ap && (ap.status === 'submitted' || ap.status === 'approved');
    var done = old && ap.status === 'approved';
    var mark = done ? '' : old ? 'pending' : 'preview';
    // 지금 자료로 만드는 문서도 총계를 견준다. 옛 결재 건은 결재 카드 금액(상신 때 집계)과, 미리보기는 화면 합계와.
    var snap0 = (ap && ap.snapshot) || {};
    var expect = old ? (snap0.version >= 2 ? snap0.cost : null) : C.expectCost(u);
    var go = function () {
      var row = ROWS[k];
      var v = row ? { ranAt: whenText(row.created_at), ai: !!row.ai, summary: row.summary, items: (row.result || {}).items || [] } : null;
      var now = whenText(new Date().toISOString());
      makePdf({
        doc: doc, verify: v,
        title: done ? '결재 완료본' : old ? '결재 문서' : 'PDF 미리보기',
        sub: C.nameOf(u) + ' · ' + C.cycleName(S.CYC.y, S.CYC.m),
        file: '운행기록부_' + safeName(C.nameOf(u)) + '_' + cyc + (done ? '_결재완료' : old ? '_결재중' : '_미리보기') + '.pdf',
        note: old ? '이 결재 건은 상신 때 저장한 자료가 없어(예전 방식) <b>지금 자료</b>로 만들었습니다.' : null,
        expect: expect, expectName: old ? '상신 때 집계한 금액' : '화면 합계',
        meta: { name: C.nameOf(u), cycleName: C.cycleName(S.CYC.y, S.CYC.m), mark: mark,
          docNo: old ? '결재 #' + ap.id + ' · 지금 자료로 ' + now + ' 출력' : '상신 전 미리보기 · ' + now + ' 출력' }
      }).catch(function () { });
    };
    if (ROWS[k] === undefined) fetchLatest(u, cyc).then(go); else go();
  }

  /** 지금 화면 자료로 대신 만들 수 있는 결재 건인가(고정본이 없는 옛 건의 대비책). */
  function liveOk(a) {
    var S = C.state();
    return a.cycle === S.CYCKEY && !C.isMulti() && (a.username === C.myName() || C.isAll());
  }
  var NO_FZ = '이 결재 건에는 상신 때 저장한 자료가 없습니다(예전 방식). 그 달 화면의 「정산·엑셀」에서 받아 주세요.';

  /** 고정본으로 결재 문서(결재 중이면 「결재 중」 표시, 끝났으면 완료본). */
  function pdfFrozen(id) {
    var a = apprById(id);
    if (!a) { C.toast('결재 건을 찾지 못했습니다.', true); return; }
    fetchFrozen(a).then(function (fz) {
      if (!fz) { if (liveOk(a)) { C.bizOnly(); pdfLive(a.username); } else C.toast(NO_FZ, true); return; }
      var doc = C.withFrozen(fz.data, function () { return C.pdfDocFor(a.username, a); });
      var done = a.status === 'approved';
      var mark = done ? '' : a.status === 'submitted' ? 'pending' : a.status === 'rejected' ? 'rejected' : 'withdrawn';
      var cname = cycName(a.cycle);
      var vv = fz.verify || null;
      var name = (fz.data.user && fz.data.user.name) || C.nameOf(a.username);
      var snap = a.snapshot || {};
      makePdf({
        doc: doc,
        verify: vv ? { ranAt: whenText(vv.ran_at), ai: !!vv.ai, summary: vv.summary, items: vv.items || [] } : null,
        title: done ? '결재 완료본' : mark === 'pending' ? '결재 문서' : '상신했던 문서', sub: name + ' · ' + cname,
        file: '운행기록부_' + safeName(name) + '_' + a.cycle +
          ({ '': '_결재완료', pending: '_결재중', rejected: '_반려', withdrawn: '_회수' }[mark]) + '.pdf',
        // 영수증까지 넣어 집계한 것은 version 2 부터다. 그 전 것은 기준이 달라 견주지 않는다.
        expect: snap.version >= 2 ? snap.cost : null,
        meta: { name: name, cycleName: cname, mark: mark,
          docNo: '결재 #' + a.id + ' · 상신 ' + whenText(fz.frozen_at) + (done && a.closed_at ? ' · 완료 ' + whenText(a.closed_at) : '') }
      }).catch(function () { });
    }).catch(frozenFail);
  }

  function xlsxFrozen(id) {
    var a = apprById(id);
    if (!a) return;
    var tag = '_결재' + (a.status === 'approved' ? '완료' : '중');
    var snap = a.snapshot || {};
    var save = function (files) {
      if (!files.length) { C.toast('담을 운행·영수증이 없습니다.', true); return; }
      files.forEach(function (f, i) {
        setTimeout(function () { C.saveBlob(f.bytes, f.name.replace(/\.xlsx$/, tag + '.xlsx')); }, i * 400);
      });
      // PDF 와 같은 대조: 장별 총계의 합이 상신 때 집계와 다르면 말없이 내보내지 않는다.
      var warn = C.sheetSumWarn(files, snap.version >= 2 ? snap.cost : null);
      if (warn) C.toast(warn, true);
      else C.toast(files.length > 1 ? '엑셀 ' + files.length + '개를 내려받습니다(차량별로 한 장씩).' : '엑셀을 내려받습니다.');
    };
    fetchFrozen(a).then(function (fz) {
      if (!fz) { if (liveOk(a)) { C.bizOnly(); save(C.xlsxFiles(a.username)); } else C.toast(NO_FZ, true); return; }
      save(C.withFrozen(fz.data, function () { return C.xlsxFiles(a.username); }));
    }).catch(frozenFail);
  }

  /**
   * 상신 직전에 부른다 — 안 읽은 사진을 읽혀 두면 고정본의 검증 결과에 AI 대조가 들어간다.
   * 마지막 검증 요약을 돌려준다(상신 창이 '맞지 않는 곳 N건'을 잠그기 전에 보여 준다).
   * 실패하면 null — 상신을 막지 않는다.
   */
  function beforeSubmit(onNote) {
    var S = C.state(), u = C.myName(), cyc = S.CYCKEY, k = keyOf(u, cyc);
    var say = function (t) { if (onNote) onNote(String(t).replace(/…\s*/g, ' ').trim()); };
    // 「검증」 화면에서 같은 검증이 이미 돌고 있으면 그것을 기다린다 — 겹쳐 돌리면 같은 사진을 두 번 읽혀 AI 하루 한도만 쓴다.
    if (RUN.busy && RUN.who === k && RUN.p) {
      say('검증이 끝나기를 기다리는 중');
      return RUN.p.then(function (row) { return (row && row.summary) || null; }, function () { return null; });
    }
    // 다른 검증이 돌고 있으면(다른 사람·다른 주기) 그쪽 표시는 건드리지 않고 이 검증만 돌린다.
    var own = !RUN.busy;
    var p = runVerify(u, cyc, say, true);
    if (own) RUN = { busy: true, note: '상신 전 검증 중…', who: k, p: p };
    var done = function () { if (own && RUN.p === p) RUN = { busy: false, note: '', who: '' }; };
    return p.then(function (row) {
      done();
      ROWS[k] = row || null;
      ALLROWS.list = null;
      return (row && row.summary) || null;
    }).catch(function () { done(); return null; });
  }

  /* ══════════════════ 이벤트 ══════════════════ */
  document.addEventListener('click', function (e) {
    var el;
    if (e.target.closest('[data-vrun]')) { startRun(C.myName()); return; }
    if ((el = e.target.closest('[data-vfix]'))) { openFix(VITEMS[+el.dataset.vfix]); return; }
    if ((el = e.target.closest('[data-vrunfor]'))) {
      var u = el.dataset.vrunfor, S = C.state(), k = keyOf(u, S.CYCKEY);
      if (RUN.busy) return;
      RUN = { busy: true, note: '', who: k }; C.render();
      runVerify(u, S.CYCKEY).then(function (row) {
        ROWS[k] = row || null; ALLROWS.list = null;
        C.toast(C.nameOf(u) + ' — ' + (row ? sumText(row.summary) : '검증했습니다'));
      }).catch(function (er) { C.toast('검증하지 못했습니다: ' + ((er && er.message) || ''), true); })
        .then(function () { RUN = { busy: false, note: '', who: '' }; C.render(); });
      return;
    }
    if ((el = e.target.closest('[data-vshow]'))) {
      var S2 = C.state(), r = ROWS[keyOf(el.dataset.vshow, S2.CYCKEY)];
      if (r) showItems(C.nameOf(el.dataset.vshow) + ' 검증 결과', C.cycleName(S2.CYC.y, S2.CYC.m), r);
      return;
    }
    if ((el = e.target.closest('[data-fzverify]'))) {
      var a = apprById(el.dataset.fzverify), f = a && FZSUM[fzKey(a)];
      if (f && f.verify) showItems(C.nameOf(a.username) + ' 검증 결과', cycName(a.cycle) + ' · 상신 시점', f.verify);
      return;
    }
    if ((el = e.target.closest('[data-fzpdf]'))) { pdfFrozen(el.dataset.fzpdf); return; }
    if ((el = e.target.closest('[data-fzxlsx]'))) { xlsxFrozen(el.dataset.fzxlsx); return; }
    if ((el = e.target.closest('[data-pdf]'))) {
      // 상신했거나 결재가 끝난 주기는 상신 때 저장한 자료가 정본이다(없으면 pdfFrozen 이 지금 자료로 넘긴다).
      var who = el.dataset.pdf || C.myName();
      var ap = C.apprOf(who, C.state().CYCKEY);
      if (ap && (ap.status === 'submitted' || ap.status === 'approved')) pdfFrozen(ap.id);
      else pdfLive(who);
      return;
    }
  });

  return {
    views: { verify: viewVerify, a_verify: viewVerifyAll },
    admin: ['a_verify'],
    apprExtra: apprExtra, wantSummaries: wantSummaries, beforeSubmit: beforeSubmit,
    sumText: sumText, pdfFrozen: pdfFrozen, xlsxFrozen: xlsxFrozen,
    // ★ 주기가 바뀌어도 돌고 있는 검증은 그대로 둔다. 여기서 '안 도는 중'으로 풀면 같은 검증이 겹쳐 돈다.
    onCycle: function () { }
  };
});
