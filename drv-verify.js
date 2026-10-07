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
  /** 검증 뒤 PDF 미리보기를 확인했는가(사람·주기별). 다시 검증하면 다시 확인한다. 탭을 닫으면 잊는다. */
  var PREVIEWED = (function () { try { return JSON.parse(sessionStorage.getItem('drv.previewed') || '{}'); } catch (e) { return {}; } })();
  function setPreviewed(k, on) {
    if (on) PREVIEWED[k] = 1; else delete PREVIEWED[k];
    try { sessionStorage.setItem('drv.previewed', JSON.stringify(PREVIEWED)); } catch (e) { }
  }
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
    A05: ['trips', '운행일지에서 보기'], A06: ['evid', '영수증에서 보기'], A07: ['evid', '영수증에서 보기'],
    // 2026-10-06 — R10 은 운행에 적은 금액을 지우는 것, R11·R12 는 영수증·계기판 사진을 올리는 것
    R10: ['trips', '운행일지에서 보기'], R11: ['evid', '주유 영수증 올리기'], R12: ['evid', '계기판 사진 올리기']
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
      // 주유 영수증·계기판 사진이 모자란 것은 고칠 기록이 아니라 올릴 것이 없는 것 — 영수증 화면으로 보낸다.
      else if (fx && (it.code === 'R11' || it.code === 'R12')) go = '<button class="btn sm vgo" data-v="' + fx[0] + '">' + fx[1] + ic('chev', 12) + '</button>';
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
    // 상신까지의 순서: ① 검증 → ② PDF 미리보기로 확인 → ③ 결재 상신. 지금 할 것 하나만 깜빡인다.
    var seen = !!PREVIEWED[k];
    var stage = locked ? 0 : !row ? 1 : !seen ? 2 : 3;
    // 2026-10-07: 순서대로 큰 단추 세 칸 — ① 검증하기 → ② PDF 미리보기 → ③ 결재 상신. 앞 단계를 마쳐야 다음 칸이 열린다.
    var canSubmit = !a || a.status === 'rejected' || a.status === 'withdrawn';
    var stepCard = function (n, title, desc, button) {
      var st = stage > n ? 'done' : stage === n ? 'now' : 'todo';
      return '<li class="vstep ' + st + '"' + (st === 'now' ? ' aria-current="step"' : '') + '>' +
        '<div class="vsh"><i>' + (st === 'done' ? '✓' : n) + '</i><b>' + title + '</b></div>' +
        '<p>' + desc + '</p>' + button + '</li>';
    };
    var steps = locked ? '' : '<ol class="vsteps" aria-label="상신 순서">' +
      stepCard(1, '검증하기 ' + gemBadge('Gemini'),
        busy ? 'Gemini 가 영수증·계기판 사진을 읽고 기록과 맞춰 보는 중입니다…'
          : row ? 'Gemini 가 사진을 읽어 대조했습니다. 고친 게 있으면 다시 눌러 주세요.'
          : 'Gemini 가 영수증·계기판 사진을 읽어 운행 기록과 서로 맞는지 봅니다.',
        gemBtn('data-vrun' + (RUN.busy ? ' disabled' : ''),
          busy ? (RUN.note || 'Gemini 가 읽는 중…') : RUN.busy ? '다른 검증이 도는 중…' : row ? '다시 검증하기' : '검증하기',
          busy, ' big' + (stage === 1 ? ' pri' + (busy ? '' : ' cta') : ''))) +
      stepCard(2, 'PDF 미리보기',
        row ? '결재자에게 갈 문서를 눈으로 확인합니다.' : '검증을 먼저 해 주세요.',
        '<button class="btn big' + (stage === 2 ? ' pri cta' : '') + '" data-pdf=""' + (row && !busy ? '' : ' disabled') + '>' +
          ic('dl', 16) + 'PDF 미리보기</button>') +
      stepCard(3, '결재 상신',
        !canSubmit ? '이미 상신했습니다.' : stage === 3 ? '결재선을 고르고 올립니다.' : 'PDF 미리보기를 먼저 확인해 주세요.',
        canSubmit ? '<button class="btn big' + (stage === 3 ? ' pri cta' : '') + '" id="btnOpenSubmit"' + (stage === 3 && !busy ? '' : ' disabled') + '>' +
          (a && a.status === 'rejected' ? '다시 상신' : '결재 상신') + '</button>' : '') +
      '</ol>';
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
      (locked ? '<div class="vact">' + gemBtn('data-vrun' + (RUN.busy ? ' disabled' : ''),
        busy ? (RUN.note || 'Gemini 가 읽는 중…') : '다시 검증하기', busy, '') + '<button class="btn" data-pdf="">' + ic('dl', 14) + '결재 문서 PDF</button></div>' : steps) + '</div>';

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
        '<div class="t">위 ① 「검증하기」를 누르면 이번 주기 기록을 살펴봅니다.</div>' +
        '<div class="d">계기판이 이어지는지, 영수증 금액이 입력과 같은지, 같은 영수증을 두 번 올리지 않았는지 봅니다.<br>' +
        '맞지 않는 곳이 있어도 상신은 할 수 있습니다 — 결재자가 같이 봅니다.</div></div></div>';
    }
    h += '<div class="anote">금액 계산은 규칙으로만 합니다. ' + gemBadge('Gemini AI') + ' 는 사진을 읽어 <b>입력값과 다른 곳을 표시</b>할 뿐, 값을 바꾸지 않습니다. ' +
      '「바로 고치기」로 고친 뒤에는 「다시 검증하기」를 눌러 주세요.</div>';
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
      setPreviewed(k, false);
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
    // 이번 주기에 운행이 있는 사람만(2026-10-07 사용자) — 「보는 범위」(사업부·팀·파트) 안에서.
    var users = {}, rr = C.cycleRange(S.CYC.y, S.CYC.m);
    S.ALL_TRIPS.forEach(function (t) { if (t.start_time >= rr.lo && t.start_time < rr.hi && C.orgMatch(t.username)) users[t.username] = 1; });
    var list = Object.keys(users).map(function (u) {
      var r = by[u], s = r && r.summary;
      var a = S.APPR.filter(function (x) { return x.username === u && x.cycle === cyc; })[0];
      return { u: u, r: r, s: s, a: a, rank: !r ? 1 : s.bad ? 0 : s.warn ? 2 : 3 };
    }).sort(function (x, y) { return x.rank - y.rank || C.nameOf(x.u).localeCompare(C.nameOf(y.u), 'ko'); });
    var nBad = list.filter(function (x) { return x.s && x.s.bad; }).length;
    var nNone = list.filter(function (x) { return !x.r; }).length;
    var nOk = list.filter(function (x) { return x.r && !x.s.bad && !x.s.warn; }).length;
    var nWarn = list.filter(function (x) { return x.r && !x.s.bad && x.s.warn; }).length;

    var allNone = list.length > 0 && nNone === list.length;
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (nBad || nNone ? '' : ' ok') + '"></span>이번 기간 운행한 ' + n0(list.length) + '명</div>' +
      '<p class="verdict' + (nBad || nNone ? '' : ' clean') + '">' +
      (nBad ? '불일치가 있는 사람이 <em>' + n0(nBad) + '명</em> 있습니다'
        : allNone ? '아직 아무도 <em>검증하지 않았습니다</em>'
        : nNone ? '불일치는 없고, 검증 안 한 사람이 <em>' + n0(nNone) + '명</em>입니다'
        : '<em>모두 검증했고 불일치가 없습니다</em>') + '</p>' +
      '<div class="facts">' +
      '<div class="fact"><div class="k">불일치</div><div class="v' + (nBad ? ' alert' : '') + '">' + n0(nBad) + '<small>명</small></div><div class="sub">고쳐야 할 것이 있음</div></div>' +
      '<div class="fact"><div class="k">확인 필요</div><div class="v">' + n0(nWarn) + '<small>명</small></div><div class="sub">사람이 한 번 봐야 함</div></div>' +
      '<div class="fact"><div class="k">이상 없음</div><div class="v">' + n0(nOk) + '<small>명</small></div><div class="sub">검증 통과</div></div>' +
      '<div class="fact"><div class="k">검증 안 함</div><div class="v">' + n0(nNone) + '<small>명</small></div><div class="sub">각자 실행하거나 아래에서 대신 실행</div></div>' +
      '</div></div>';

    h += C.sect('직원별', list.length + '명', '',
      '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>파트·센터</th><th>이름</th><th>결과</th><th>사진 판독</th><th>검증 시각</th><th>결재</th><th></th></tr></thead><tbody>' +
      C.orgGroups(list, function (x) { return x.u; }, true).map(function (g) {
        var gb = g.list.filter(function (x) { return x.s && x.s.bad; }).length, gn = g.list.filter(function (x) { return !x.r; }).length;
        return C.orgGroupRow(g, 7, (gb ? '<span class="unk">불일치 ' + n0(gb) + '명</span> · ' : '') + '검증 안 함 ' + n0(gn) + '명') +
          g.list.map(vrow).join('');
      }).join('') + '</tbody></table></div></div>');
    function vrow(x) {
      return (function () {
        var p = C.personOf(x.u);
        var busy = RUN.busy && RUN.who === keyOf(x.u, cyc);
        var stuck = x.a && x.a.status === 'submitted';
        return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td>' +
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
      })();
    }
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
    return apprBrief(a, f) + '<div class="aext">' + chip +
      '<span style="flex:1"></span>' +
      '<button class="btn sm" data-fzpdf="' + a.id + '">' + ic('dl', 13) +
      (done ? '결재 완료본 PDF' : live ? '결재 문서 PDF' : '상신했던 문서 PDF') + '</button>' +
      (done ? '<button class="btn sm" data-fzxlsx="' + a.id + '">결재 완료본 엑셀</button>' : '') +
      '</div>';
  }

  /**
   * 결재 요약(2026-10-07 사용자) — 결재자가 문서를 열지 않고도 승인할 수 있게, 상신 때 굳힌 금액·검증 결과와
   * 전월 대비를 한눈에. 결재 중(내 차례 포함)·완료 건에만 붙인다. 숫자는 모두 상신 때 서버가 굳힌 값(snapshot·고정본 검증)이다.
   */
  function apprBrief(a, f) {
    if (!a || a.status !== 'submitted') return '';         // 결재 중인 건만(완료 건은 조용히)
    var s = a.snapshot || {};
    if (s.cost == null) return '';
    var won = C.won, cost = Number(s.cost) || 0;
    // 전월 — 같은 사람의 바로 앞 주기 결재(완료 또는 결재 중). 볼 권한이 없으면 목록에 없다.
    var cy = String(a.cycle || '').split('-').map(Number), py = cy[0], pm = cy[1] - 1;
    if (pm < 1) { pm = 12; py--; }
    var pkey = py + '-' + (pm < 10 ? '0' : '') + pm;
    var prev = (C.state().APPR || []).filter(function (x) {
      return x.username === a.username && x.cycle === pkey && (x.status === 'approved' || x.status === 'submitted') && x.snapshot && x.snapshot.cost != null;
    })[0];
    var cmp = '';
    var bigJump = false;
    if (prev) {
      var pc = Number(prev.snapshot.cost) || 0, d = cost - pc, pct = pc ? Math.round(d / pc * 100) : null;
      bigJump = pc > 0 && d > 50000 && pct >= 50;
      cmp = '<div class="abf"><span class="k">전월(' + pm + '월분) 대비</span><b class="' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' +
        (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '') + won(Math.abs(d)) + (pct != null && d ? ' <small>(' + (d > 0 ? '+' : '−') + Math.abs(pct) + '%)</small>' : '') + '</b>' +
        '<span class="sub">' + pm + '월분 ' + won(pc) + ' · ' + n0(prev.snapshot.trips) + '건 · ' + C.km(prev.snapshot.km) + ' km</span></div>';
    } else {
      cmp = '<div class="abf"><span class="k">전월 대비</span><b class="dimv">—</b><span class="sub">' + pm + '월분 결재 기록이 없습니다</span></div>';
    }
    // 검증(상신 때 굳힌 결과)
    var v = f && f.verify, vs = (v && v.summary) || null;
    var items = ((v && (v.items || (v.result && v.result.items))) || []).filter(function (i) { return i.level === 'bad' || i.level === 'warn'; });
    var checks = [];
    if (vs) {
      checks.push(vs.bad ? ['bad', '검증 불일치 ' + n0(vs.bad) + '건'] : vs.warn ? ['warn', '검증 확인 필요 ' + n0(vs.warn) + '건'] : ['ok', '검증 이상 없음']);
      if (vs.receipts) checks.push(vs.read >= vs.receipts ? ['ok', 'AI 사진 판독 ' + n0(vs.read) + '/' + n0(vs.receipts) + '장 완료'] : ['warn', 'AI 사진 판독 ' + n0(vs.read) + '/' + n0(vs.receipts) + '장']);
    } else if (f === undefined) checks.push(['dim', '검증 결과 불러오는 중…']);
    else checks.push(['warn', '상신 때 검증 결과가 없습니다']);
    checks.push(s.toll_unknown ? ['warn', '통행료 미확정 ' + n0(s.toll_unknown) + '건(0원으로 계산)'] : ['ok', '통행료 모두 확정']);
    // rate_miss 는 단가가 없던 「분기-지역」 목록이다(예: 2026-4-수도권). 빈 목록이면 문제없음.
    var rm = Array.isArray(s.rate_miss) ? s.rate_miss : (Number(s.rate_miss) > 0 ? [String(s.rate_miss) + '건'] : []);
    if (rm.length) checks.push(['warn', '유류 단가 미등록(' + rm.map(function (k) { var q = String(k).split('-'); return q.length === 3 ? q[0] + '년 ' + q[1] + '분기 ' + q[2] : k; }).join(', ') + ') — 기본 단가로 계산']);
    if (bigJump) checks.push(['warn', '전월보다 비용이 크게 늘었습니다']);
    var nBad = checks.filter(function (c) { return c[0] === 'bad'; }).length, nWarn = checks.filter(function (c) { return c[0] === 'warn'; }).length;
    var verdict = nBad ? ['bad', '확인이 필요합니다 — 문서의 불일치 항목을 보고 결재해 주세요']
      : nWarn ? ['warn', '대체로 정상입니다 — 아래 확인 항목만 살펴봐 주세요']
      : ['ok', '금액·검증 모두 이상 없습니다 — 문서를 열지 않고 승인하셔도 됩니다'];
    var perKm = Number(s.biz_km) > 0 ? Math.round((Number(s.fuel) || 0) / Number(s.biz_km)) : 0;
    return '<div class="abrief ' + verdict[0] + '">' +
      '<div class="abv"><span class="abi">' + (verdict[0] === 'ok' ? '✓' : '!') + '</span><b>' + esc(verdict[1]) + '</b></div>' +
      '<div class="abgrid">' +
      '<div class="abf"><span class="k">청구 금액</span><b>' + won(cost) + '</b><span class="sub">유류 ' + won(s.fuel) + ' · 통행 ' + won(s.toll) + ' · 주차 ' + won(s.parking) + '</span></div>' +
      '<div class="abf"><span class="k">운행</span><b>' + n0(s.trips) + '<small>건</small> · ' + C.km(s.km) + '<small>km</small></b><span class="sub">업무 ' + C.km(s.biz_km) + ' km' + (perKm ? ' · 유류 ' + n0(perKm) + '원/km' : '') + '</span></div>' +
      cmp +
      '<div class="abf"><span class="k">영수증</span><b>' + n0(s.ev_n || 0) + '<small>장</small></b><span class="sub">주차 ' + won(s.ev_parking || 0) + ' · 통행 ' + won(s.ev_toll || 0) + ' 포함</span></div>' +
      '</div>' +
      '<div class="abchk">' + checks.map(function (c) { return '<span class="ck ' + c[0] + '">' + (c[0] === 'ok' ? '✓' : '!') + ' ' + esc(c[1]) + '</span>'; }).join('') + '</div>' +
      (items.length ? '<ul class="abitems">' + items.slice(0, 4).map(function (i) {
        return '<li class="' + i.level + '"><b>' + esc(i.title || '') + '</b>' + (i.detail ? ' — ' + esc(String(i.detail).slice(0, 110)) + (String(i.detail).length > 110 ? '…' : '') : '') + '</li>';
      }).join('') + (items.length > 4 ? '<li class="more">외 ' + n0(items.length - 4) + '건 — 아래 「검증」을 눌러 전부 보기</li>' : '') + '</ul>' : '') +
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
        '<a class="btn pri' + (o.okKey ? ' cta' : '') + '" id="pdfOpen" href="' + url + '" target="_blank" rel="noopener">' +
          (o.okKey ? '① 열어서 보기' : '열기 · 인쇄') + '</a>' +
        // 상신 전 미리보기면 '확인했다'를 받고 결재 상신으로 넘긴다(검증 → PDF 확인 → 상신).
        // 2026-10-07: 문서를 먼저 열어 봐야 「확인 완료」가 눌린다(열기·내려받기 중 하나).
        (o.okKey ? '<button class="btn" id="pdfOkBtn" data-pdfok="' + esc(o.okKey) + '" disabled title="먼저 「열어서 보기」로 문서를 확인해 주세요">② 확인 완료 → 결재 상신</button>' : '');
      if (o.okKey) {
        $('pBody').insertAdjacentHTML('beforeend', '<div class="hpnote" id="pdfStepNote" style="margin-top:14px">' + ic('alert', 15) +
          '<span><b>① 열어서 보기</b>로 문서를 끝까지 확인한 뒤 <b>② 확인 완료 → 결재 상신</b>을 눌러 주세요.</span></div>');
        var unlock = function () {
          var b = $('pdfOkBtn'); if (!b || !b.disabled) return;
          b.disabled = false; b.removeAttribute('title'); b.classList.add('pri', 'cta');
          var a = $('pdfOpen'); if (a) a.classList.remove('pri', 'cta');
          var nt = $('pdfStepNote');
          if (nt) { nt.classList.add('ok'); nt.innerHTML = ic('check', 15) + '<span>문서를 열었습니다. 확인했으면 <b>② 확인 완료 → 결재 상신</b>을 눌러 주세요.</span>'; }
        };
        Array.prototype.forEach.call($('pFoot').querySelectorAll('a[href="' + url + '"]'), function (a) { a.addEventListener('click', unlock); });
      }
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
        okKey: !old && u === C.myName() ? k : '',
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
    if (e.target.closest('[data-finpdf]')) { finBundle(); return; }
    if (e.target.closest('[data-fincsv]')) { finCsv(); return; }
    if ((el = e.target.closest('[data-pdfok]'))) {
      setPreviewed(el.dataset.pdfok, true);
      C.closePanel();
      if (C.state().VIEW !== 'verify') C.go('verify'); else C.render();
      setTimeout(function () { var b = document.getElementById('btnOpenSubmit'); if (b) { try { b.focus(); b.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (er) { } } }, 60);
      return;
    }
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

  /* ══════════════════ 결재 완료 출력 (관리자, 2026-10-06) ══════════════════
     한 주기의 결재가 끝난 문서를 모아 본다 — 한 사람씩 PDF·엑셀, 고른 사람들을 PDF 한 파일로 묶어 받기,
     금액 요약표(CSV). 결재 중·아직 상신 안 한 사람도 같이 보여 누구를 챙겨야 하는지 알게 한다.
     문서는 모두 상신 때 저장한 고정본(driving_frozen)으로 만든다 — 결재자가 본 그 문서다. */
  var FINSEL = {}, FINJOB = null;
  function viewFinal() {
    var S = C.state();
    if (!S.LOADED) return C.head('결재 완료 출력') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('결재 완료 출력', '출력');
    var cyc = S.CYCKEY, cname = C.cycleName(S.CYC.y, S.CYC.m);
    // 「보는 범위」(사업부·팀·파트) 안의 사람만.
    var list = S.APPR.filter(function (a) { return a.cycle === cyc && C.orgMatch(a.username); });
    var done = list.filter(function (a) { return a.status === 'approved'; })
      .sort(function (x, y) { return C.nameOf(x.username).localeCompare(C.nameOf(y.username), 'ko'); });
    var going = list.filter(function (a) { return a.status === 'submitted'; });
    var back = list.filter(function (a) { return a.status === 'rejected' || a.status === 'withdrawn'; });
    // 챙겨야 할 사람 = 이 결재 기간에 **운행이 있는** 사람만(2026-10-07 사용자 — 영수증만 있는 사람·운행 없는 사람은 뺀다).
    var r = C.cycleRange(S.CYC.y, S.CYC.m), has = {};
    (S.ALL_TRIPS || []).forEach(function (t) {
      if (t.start_time >= r.lo && t.start_time < r.hi && S.USERS[t.username] && C.orgMatch(t.username)) has[t.username] = (has[t.username] || 0) + 1;
    });
    // 결재 건이 있는 사람(완료·결재 중·반려·회수)은 위 목록에 이미 있다 — 「상신 전」에 또 넣지 않는다
    // (예전에는 반려된 사람이 「반려」와 「상신 전」 두 곳에 나와 숫자가 두 번 셌다, 2026-10-06 검증로봇 5).
    var sent = {}; list.forEach(function (a) { sent[a.username] = 1; });
    var notYet = Object.keys(has).filter(function (u) { return !sent[u]; })
      .sort(function (x, y) { return C.nameOf(x).localeCompare(C.nameOf(y), 'ko'); });
    var total = done.reduce(function (s, a) { return s + (Number((a.snapshot || {}).cost) || 0); }, 0);
    // 고른 것 중 이 주기의 결재 완료 건만 남긴다(주기를 바꾸면 고른 것이 섞이지 않게).
    var okIds = {}; done.forEach(function (a) { okIds[a.id] = 1; });
    Object.keys(FINSEL).forEach(function (k) { if (!okIds[k]) delete FINSEL[k]; });
    var nSel = Object.keys(FINSEL).length;

    var h = C.head('결재 완료 출력', esc(cname) + ' · 결재가 끝난 운행기록부를 모아 출력합니다');
    var fact = function (k, v, sub, alert) {
      return '<div class="fact"><div class="k">' + esc(k) + '</div><div class="v' + (alert ? ' alert' : '') + '">' + v + '</div>' +
        '<div class="sub">' + esc(sub || '') + '</div></div>';
    };
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (done.length && !going.length && !notYet.length ? ' ok' : '') + '"></span>' +
      esc(cname) + ' · ' + esc(C.cycleSpan(S.CYC.y, S.CYC.m)) + '</div>' +
      '<p class="verdict">결재 완료 <em>' + n0(done.length) + '명</em> · ' + C.won(total) + '</p>' +
      '<div class="facts">' +
      fact('결재 완료', n0(done.length) + '<small>명</small>', '출력할 수 있습니다') +
      fact('결재 중', n0(going.length) + '<small>명</small>', '결재자 차례를 기다리는 중', going.length > 0) +
      fact('반려·회수', n0(back.length) + '<small>명</small>', '고쳐서 다시 올려야 함', back.length > 0) +
      fact('아직 상신 안 함', n0(notYet.length) + '<small>명</small>', '이번 기간 운행이 있는데 상신 전', notYet.length > 0) +
      '</div></div>';

    // ── 결재 완료 — 출력 ──
    var tools = done.length
      ? '<label class="finall"><input type="checkbox" id="finAll"' + (nSel && nSel === done.length ? ' checked' : '') + '> 전체 선택</label>' +
        '<button class="btn sm' + (nSel ? ' pri' : '') + '" data-finpdf' + (nSel && !FINJOB ? '' : ' disabled') + '>' + ic('dl', 13) +
        (nSel ? '고른 ' + n0(nSel) + '명 PDF 한 파일로' : 'PDF 한 파일로 묶기') + '</button>' +
        '<button class="btn sm" data-fincsv>' + ic('dl', 13) + '금액 요약표(CSV)</button>'
      : '';
    h += C.sect('결재 완료', n0(done.length) + '명', tools, done.length
      ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th style="width:36px"></th><th>파트·센터</th><th>이름</th>' +
        '<th>결재 완료</th><th class="n">금액</th><th>결재선</th><th></th></tr></thead><tbody>' +
        C.orgGroups(done, function (a) { return a.username; }, true).map(function (g) {
          return C.orgGroupRow(g, 7, '합계 <b>' + C.won(g.list.reduce(function (s2, a) { return s2 + (Number((a.snapshot || {}).cost) || 0); }, 0)) + '</b>') +
            g.list.map(doneRow).join('');
        }).join('') + '</tbody><tfoot><tr><td></td><td colspan="3">결재 완료 ' + n0(done.length) + '명 합계</td>' +
        '<td class="n total">' + n0(total) + '</td><td colspan="2"></td></tr></tfoot></table></div></div>'
      : C.blank('아직 결재가 끝난 건이 없습니다.', '결재가 끝나면 여기에 모입니다.', 'stamp'));
    function doneRow(a) {
          var p = S.USERS[a.username] || {};
          var line = (a.steps || []).map(function (s) { return (s.name || C.nameOf(s.approver)) + '(' + (s.box || '') + ')'; }).join(' → ');
          return '<tr><td><input type="checkbox" data-finsel="' + a.id + '"' + (FINSEL[a.id] ? ' checked' : '') +
            ' aria-label="' + esc(C.nameOf(a.username)) + ' 고르기"></td>' +
            C.orgCell(a.username, true) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span></td>' +
            '<td class="dim">' + (a.closed_at ? esc(whenText(a.closed_at)) : '—') + '</td>' +
            '<td class="n total">' + n0((a.snapshot || {}).cost) + '</td>' +
            '<td class="el dim" title="' + esc(line) + '">' + esc(line) + '</td>' +
            '<td class="n" style="white-space:nowrap"><button class="btn sm" data-fzpdf="' + a.id + '">PDF</button> ' +
            '<button class="btn sm" data-fzxlsx="' + a.id + '">엑셀</button></td></tr>';
    }

    if (going.length) {
      h += C.sect('결재 중', n0(going.length) + '명', '', '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
        '<th>소속</th><th>이름</th><th>상신</th><th class="n">금액</th><th>지금 차례</th></tr></thead><tbody>' +
        going.map(function (a) {
          var cur = (a.steps || []).filter(function (s) { return s.seq === a.cur_seq; })[0] || {};
          return '<tr>' + C.orgCell(a.username) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span></td>' +
            '<td class="dim">' + (a.submitted_at ? esc(whenText(a.submitted_at)) : '') + '</td>' +
            '<td class="n">' + n0((a.snapshot || {}).cost) + '</td>' +
            '<td>' + esc((cur.name || C.nameOf(cur.approver || '')) + (cur.box ? ' (' + cur.box + ')' : '')) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>');
    }
    if (back.length || notYet.length) {
      var todo = back.map(function (a) { return { u: a.username, st: a.status === 'rejected' ? '반려' : '회수', cls: 'bad' }; })
        .concat(notYet.map(function (u) { return { u: u, st: '상신 전', cls: 'warn' }; }));
      h += C.sect('챙겨야 할 사람', n0(todo.length) + '명', '',
        '<div class="panel"><div class="scroll" data-rows><table><thead><tr><th>파트·센터</th><th>이름</th><th>상태</th><th class="n">이번 기간 운행</th><th>검증</th></tr></thead><tbody>' +
        C.orgGroups(todo, function (x) { return x.u; }, true).map(function (g) {
          return C.orgGroupRow(g, 5, '') + g.list.map(function (x) {
            var vr = ROWS[keyOf(x.u, cyc)], vs = vr && vr.summary;
            return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td>' +
              '<td><span class="st ' + x.cls + '">' + esc(x.st) + '</span></td>' +
              '<td class="n">' + n0(has[x.u] || 0) + '건</td>' +
              '<td>' + (vs ? sumChip(vs) : '<span class="dim">검증 전</span>') + '</td></tr>';
          }).join('');
        }).join('') + '</tbody></table></div></div>');
    }
    return h;
  }

  /** 고른 결재 완료 건들을 PDF 한 파일로 — 한 사람씩 고정본으로 만든 뒤 차례대로 이어 붙인다. */
  function finBundle() {
    var S = C.state();
    var ids = Object.keys(FINSEL);
    var list = ids.map(apprById).filter(function (a) { return a && a.status === 'approved'; })
      .sort(function (x, y) { return C.nameOf(x.username).localeCompare(C.nameOf(y.username), 'ko'); });
    if (!list.length || FINJOB) return;
    // ★ 한 번에 묶는 인원 상한(2026-10-07 검증로봇 R15) — 사진이 든 PDF 를 모두 메모리에 쌓았다가 합치므로
    //   전원(66명·사진 약 700장)을 한 번에 묶으면 브라우저 탭이 메모리 부족으로 꺼질 수 있다.
    var FIN_MAX = 20;
    if (list.length > FIN_MAX) {
      C.toast('한 번에 ' + FIN_MAX + '명까지 묶을 수 있습니다(지금 ' + list.length + '명). 나눠서 골라 받아 주세요.', true);
      return;
    }
    var job = FINJOB = { stop: false };
    var cname = C.cycleName(S.CYC.y, S.CYC.m);
    C.openPanel('결재 완료본 묶어 받기', cname + ' · ' + n0(list.length) + '명',
      '<div class="pdfwait"><div class="spin"></div><div id="finNote" role="status">준비하는 중…</div>' +
      '<div class="dim" style="margin-top:6px">사람마다 사진을 넣어 만듭니다. 사람이 많으면 몇 분 걸릴 수 있습니다.</div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
    var note = function (t) { var el = $('finNote'); if (el) el.textContent = t; };
    // checks: 한 사람씩 받는 PDF 와 같은 자체 점검 — 문서 총계 ≠ 결재 금액, 못 불러온 사진(2026-10-06 검증로봇 5)
    var parts = [], skipped = [], checks = [];
    var one = function (i) {
      if (i >= list.length) return Promise.resolve();
      var a = list[i];
      note((i + 1) + ' / ' + list.length + ' · ' + C.nameOf(a.username) + ' 님 문서를 만드는 중…');
      return fetchFrozen(a).then(function (fz) {
        if (!fz) { skipped.push(C.nameOf(a.username)); return; }
        var doc = C.withFrozen(fz.data, function () { return C.pdfDocFor(a.username, a); });
        var vv = fz.verify || null;
        var name = (fz.data.user && fz.data.user.name) || C.nameOf(a.username);
        return (C.fillSigns ? C.fillSigns(doc) : Promise.resolve()).then(ensureLibs).then(function (lib) {
          return window.SheetPdf.build({
            meta: { name: name, cycleName: cycName(a.cycle), mark: '',
              docNo: '결재 #' + a.id + ' · 상신 ' + whenText(fz.frozen_at) + (a.closed_at ? ' · 완료 ' + whenText(a.closed_at) : '') },
            sheets: doc.sheets, verify: vv ? { ranAt: whenText(vv.ran_at), ai: !!vv.ai, summary: vv.summary, items: vv.items || [] } : null,
            scans: doc.scans, photos: doc.photos
          }, {
            PDFLib: lib.PDFLib, fontkit: lib.fontkit, fontRegular: lib.fontRegular, fontBold: lib.fontBold,
            loadImage: function (p) { return loadPhoto(p, 1500); }
          });
        }).then(function (res) {
          parts.push(res.bytes);
          var snap = a.snapshot || {}, why = [];
          var sum = (res.totals || []).reduce(function (s, t) { return s + (Number(t && t.all) || 0); }, 0);
          if (snap.version >= 2 && isFinite(Number(snap.cost)) && Math.abs(Math.round(sum) - Math.round(Number(snap.cost))) > 1) {
            why.push('문서 총계 ' + n0(sum) + '원 ≠ 결재 금액 ' + n0(snap.cost) + '원');
          }
          var img = (res.issues || []).filter(function (x) { return x.kind === 'image'; }).length;
          if (img) why.push('불러오지 못한 사진 ' + img + '장');
          if (why.length) checks.push(name + ' — ' + why.join(', '));
        });
      }).catch(function () { skipped.push(C.nameOf(a.username)); })
        .then(function () { if (FINJOB === job) return one(i + 1); });
    };
    one(0).then(function () {
      if (FINJOB !== job) return null;
      if (!parts.length) throw new Error('만든 문서가 없습니다');
      note('한 파일로 묶는 중…');
      var P = window.PDFLib;
      return P.PDFDocument.create().then(function (out) {
        var chain = Promise.resolve();
        parts.forEach(function (b) {
          chain = chain.then(function () { return P.PDFDocument.load(b); })
            .then(function (src) { return out.copyPages(src, src.getPageIndices()); })
            .then(function (pages) { pages.forEach(function (pg) { out.addPage(pg); }); });
        });
        return chain.then(function () { out.setTitle('운행기록부 결재 완료본 ' + cname); return out.save(); })
          .then(function (bytes) { return { bytes: bytes, pages: out.getPageCount() }; });
      });
    }).then(function (res) {
      FINJOB = null;
      if (!res || !$('finNote')) { C.render(); return; }
      var blob = new Blob([res.bytes], { type: 'application/pdf' });
      PDF_URLS.forEach(function (u) { URL.revokeObjectURL(u); });
      var url = URL.createObjectURL(blob); PDF_URLS = [url];
      var file = '운행기록부_결재완료_' + S.CYCKEY + '_' + parts.length + '명.pdf';
      $('pBody').innerHTML = '<div class="pdfdone"><div class="big">' + n0(res.pages) + '<small>쪽</small></div>' +
        '<div class="dim">' + (blob.size / 1e6).toFixed(1) + ' MB · ' + n0(parts.length) + '명 결재 완료본</div>' +
        (skipped.length ? '<div class="awarn">' + ic('alert', 15) + '<span>만들지 못한 사람: ' + esc(skipped.join(', ')) +
          ' — 한 사람씩 「PDF」로 다시 받아 주세요.</span></div>' : '') +
        (checks.length ? '<div class="awarn">' + ic('alert', 15) + '<span>확인 필요: ' + esc(checks.join(' · ')) +
          ' — 그 사람은 「PDF」로 다시 받아 확인해 주세요.</span></div>' : '') +
        (!skipped.length && !checks.length ? '<div class="pdfok">' + ic('check', 15) + '<span>모두 묶었습니다 — 총계·사진 점검 이상 없음</span></div>' : '') + '</div>';
      $('pFoot').innerHTML = '<span style="flex:1"></span><button class="btn" data-close>닫기</button>' +
        '<a class="btn" href="' + url + '" download="' + esc(file) + '">' + ic('dl', 14) + '내려받기</a>' +
        '<a class="btn pri" href="' + url + '" target="_blank" rel="noopener">열기 · 인쇄</a>';
      C.render();
    }).catch(function (e) {
      FINJOB = null;
      if ($('finNote')) $('pBody').innerHTML = '<div class="awarn">' + ic('alert', 15) + '<span>묶지 못했습니다: ' + esc((e && e.message) || '') + '</span></div>';
      C.render();
    });
    C.render();
  }
  /** 결재 완료 금액 요약표(엑셀에서 바로 열리게 BOM 붙은 CSV). */
  function finCsv() {
    var S = C.state(), cyc = S.CYCKEY;
    var done = S.APPR.filter(function (a) { return a.cycle === cyc && a.status === 'approved'; });
    var NL = String.fromCharCode(13, 10);
    // ★ 글자 칸이 = + - @ 탭·CR 로 시작하면 엑셀이 수식으로 실행한다 — 앞에 ' 를 붙여 글자로 둔다(2026-10-06 검증로봇 5).
    //   숫자 칸(typeof number)은 그대로. 줄바꿈(LF 하나)도 따옴표로 감싼다.
    var q = function (v) {
      if (typeof v === 'number') return String(v);
      var s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var rows = [['이름', '아이디', '소속', '결재 완료', '업무 km', '유류비', '통행료', '주차', '금액 합계', '결재 번호']];
    var sum = 0, sk = 0, sf = 0, st = 0, sp = 0;
    done.forEach(function (a) {
      var sn = a.snapshot || {}, p = S.USERS[a.username] || {};
      sum += Number(sn.cost) || 0; sk += Number(sn.biz_km) || 0;
      sf += Math.round(sn.fuel || 0); st += Math.round(sn.toll || 0); sp += Math.round(sn.parking || 0);
      rows.push([C.nameOf(a.username), a.username, p.dept || '', a.closed_at ? whenText(a.closed_at) : '',
        Math.round((Number(sn.biz_km) || 0) * 10) / 10,
        Math.round(sn.fuel || 0), Math.round(sn.toll || 0), Math.round(sn.parking || 0), Math.round(sn.cost || 0), a.id]);
    });
    rows.push(['합계', '', '', '', Math.round(sk * 10) / 10, sf, st, sp, Math.round(sum), '']);
    var text = String.fromCharCode(0xFEFF) + rows.map(function (r) { return r.map(q).join(','); }).join(NL) + NL;
    C.saveBlob(new TextEncoder().encode(text), '결재완료_금액요약_' + cyc + '.csv');
    C.toast('요약표를 내려받습니다(' + n0(done.length) + '명).');
  }

  // 결재 완료 출력 — 고르기 칸
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches && t.matches('[data-finsel]')) { if (t.checked) FINSEL[t.dataset.finsel] = 1; else delete FINSEL[t.dataset.finsel]; C.render(); return; }
    if (t.id === 'finAll') {
      var S = C.state();
      S.APPR.forEach(function (a) { if (a.cycle === S.CYCKEY && a.status === 'approved') { if (t.checked) FINSEL[a.id] = 1; else delete FINSEL[a.id]; } });
      C.render();
    }
  });
  return {
    views: { verify: viewVerify, a_verify: viewVerifyAll, a_final: viewFinal },
    admin: ['a_verify', 'a_final'],
    apprExtra: apprExtra, wantSummaries: wantSummaries, beforeSubmit: beforeSubmit,
    sumText: sumText, pdfFrozen: pdfFrozen, xlsxFrozen: xlsxFrozen,
    // ★ 주기가 바뀌어도 돌고 있는 검증은 그대로 둔다. 여기서 '안 도는 중'으로 풀면 같은 검증이 겹쳐 돈다.
    onCycle: function () { }
  };
});
