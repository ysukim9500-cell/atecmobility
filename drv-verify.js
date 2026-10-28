/* ═══════════════════════════════════════════════════════════════════════════
   drv-verify.js — 검증 화면 · 결재 문서(PDF·엑셀)
   ---------------------------------------------------------------------------
   driving-app.js 가 내어 준 이음매(C)에 얹는다. 돈 계산은 여기서 하지 않는다 —
   기록부 모델은 C.pdfDocFor()(= sheetDataFor) 가, 검증은 서버(driving-verify)가 한다.

   ★ 결재 문서는 두 가지 재료에서 나온다
       · 지금 자료(live)  : 상신 전 미리보기. 쪽마다 「미리보기」가 찍힌다.
       · 고정본(frozen)   : 상신하는 순간 서버가 굳힌 자료. 결재자가 보는 것도,
                            결재 완료본도 이것이다 — 금액·운행은 언제 받아도 같다(상신 뒤 덧붙인
                            하이패스 영수증 원본만 「덧붙임」 표시를 달고 더해진다, 2026-10-23).
                            결재가 끝나기 전에는 쪽마다 「결재 중」이 찍힌다.
   ═══════════════════════════════════════════════════════════════════════════ */
(window.DrvExtQ = window.DrvExtQ || []).push(function (C) {
  'use strict';
  var $ = C.$, esc = C.esc, ic = C.ic, n0 = C.n0;
  /** 「~하지 못했습니다」 알림 — 서버가 준 한국어 설명은 그대로 붙이고, HTTP 500·주소 같은 원문은 콘솔로만(2026-10-08 문구 점검). */
  function failMsg(head, e, tail) {
    var m = String((e && e.message) || '');
    if (m) console.warn(head, m);
    // 원인은 쌍점 대신 다음 문장으로(2026-10-24 검수 — 「저장하지 못했어요: …」는 문장 속 쌍점), 끝 마침표는 한 번만
    var mm = m.trim();
    return /[가-힣]/.test(mm) && !/https?:\/\/|HTTP \d/.test(mm) ? head + '. ' + mm + (/[.!?…]$/.test(mm) ? '' : '.') : head + '. ' + tail;
  }

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
  var FZV = {};                              // 관리 현황 — 사람·기간 → 상신 때 굳힌 검증 결과(statusVerify 가 채운다)
  /** 이번에 검증 화면에 들어와서 검증을 돌렸는가(키별). 화면에 들어올 때마다 비운다 — 늘 ① 검증하기부터(2026-10-07 사용자).
   *  예전 검증 결과는 아래에 그대로 보여 주지만, ②·③ 은 지금 자료로 다시 검증해야 열린다. */
  var FRESH = {};
  /** 검증 뒤 PDF 미리보기를 확인했는가(사람·주기별). 다시 검증하면 다시 확인한다. 탭을 닫으면 잊는다. */
  var PREVIEWED = (function () { try { return JSON.parse(sessionStorage.getItem('drv.previewed') || '{}'); } catch (e) { return {}; } })();
  /** 이 사람·주기의 운행·영수증 지문 — 고치면 달라진다(PDF 확인을 다시 받게). */
  function dataSig(k) {
    var S = C.state(), u = k.split('|')[0];
    var r = keyRange(k.split('|')[1]), h = 0, n = 0;
    var add = function (v) { var x = String(v == null ? '' : v); for (var i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) | 0; };
    (S.ALL_TRIPS || []).forEach(function (t) {
      if (t.username !== u || t.start_time < r.lo || t.start_time >= r.hi) return;
      n++; add(t.id); add(t.start_time); add(t.end_time); add(t.start_odometer); add(t.end_odometer); add(t.purpose); add(t.toll_cost); add(t.toll_status); add(t.parking_cost); add(t.plate_no);
    });
    (S.ALL_EVID || []).forEach(function (e) {
      var d = Number(e.date_millis);
      if (e.username !== u || d < r.lo || d >= r.hi) return;
      n++; add(e.id); add(e.amount); add(e.category); add(e.photo_path); add(e.trip_id); add(e.date_millis);
    });
    return n + ':' + h;
  }
  /** PDF 를 확인한 뒤로 자료가 그대로이고, 그 뒤에 상신한 적이 없는가. */
  function previewOk(k) {
    var v = PREVIEWED[k];
    if (!v || typeof v !== 'object') return false;
    if (v.sig !== dataSig(k)) return false;
    var a = (C.state().APPR || []).filter(function (x) { return keyOf(x.username, x.cycle) === k; })[0];
    if (a && a.submitted_at && Date.parse(a.submitted_at) > v.at) return false;
    return true;
  }
  function setPreviewed(k, on) {
    if (on) PREVIEWED[k] = { at: Date.now(), sig: dataSig(k) }; else delete PREVIEWED[k];
    try { sessionStorage.setItem('drv.previewed', JSON.stringify(PREVIEWED)); } catch (e) { }
  }
  var ALLROWS = { key: '', list: null };          // 전체 검증(관리) — 주기별 최신 한 줄씩
  function keyOf(u, cyc) { return u + '|' + cyc; }
  /** "2026-09" → "2026년 9월분" · "2026-12b" → "2026년 12월분 2차". 다른 화면과 같은 이름으로 부른다. */
  function cycName(key) {
    var c = CR.parse(key);
    return c ? CR.name(c) : String(key || '') + '분';
  }
  // ★ 2026-10-20 연말 마감 설정: 운행일지 기간 범위·이름은 엔진(cycle-rules.js 의 'driving') — 관리자가 정하지 않으면 늘 21일 ~ 20일(지금과 같다).
  var CR = C.CR || window.CycleRules;
  /** 운행일지 기간 키 → { lo, hi } ms(hi 는 들어가지 않음). 없는 기간이면 NaN. */
  function keyRange(key) { var P = CR.byKey('driving', key); return P ? { lo: P.loMs, hi: P.endMs } : { lo: NaN, hi: NaN }; }
  /** 운행일지 기간 키 → '09.21 – 10.20'. */
  function keySpan(key) { var P = CR.byKey('driving', key); return P ? P.lo.slice(5).replace('-', '.') + '~' + P.hi.slice(5).replace('-', '.') : ''; }
  /** 「전월 대비」의 앞 기간 키 — 이름 달의 앞 달('2027-01' → '2026-12'). 12월 추가 기간('2026-12b')은 견주지 않는다(null). */
  function prevMonthKey(k) { var c = CR.parse(k); return !c || c.x ? null : c.m > 1 ? c.y + '-' + (c.m < 11 ? '0' : '') + (c.m - 1) : (c.y - 1) + '-12'; }

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
  /** 마지막 검증의 사진 판독 경고(사람|기간 → 글) — 부른 쪽이 마지막 알림(「검증했습니다 — …」)에 이어 붙이고 ① 카드 문구에 쓴다(2026-10-20 V3 B6). */
  var WARN = {};
  function runVerify(u, cyc, onNote, quiet) {
    var say = onNote || function () { };
    var wk = u + '|' + cyc;
    WARN[wk] = '';
    // 두 번째 값(info)은 AI 검증 모션(2026-10-20)이 쓴다 — 단계 · 몇 장째 · 지금 읽는 사진 · 방금 읽은 값(서버가 돌려준 실제 값)
    say('기록을 검사하는 중…', { phase: 'check' });
    return call({ op: 'run', cycle: cyc, username: u }).then(function (j) {
      var unread = j.unread || [];
      if (!unread.length) return j.row;
      var stop = '', byId = {}, last = null;
      (C.state().ALL_EVID || []).forEach(function (e) { byId[String(e.id)] = e; });
      var kindOf = function (id) { var e = byId[String(id)]; return e ? (AIM_KIND[e.category] || ((e.category || '') + ' 영수증')) : '영수증'; };
      var label = function (n, total) { return kindOf(unread[Math.min(n, total - 1)]) + ' 읽는 중… ' + Math.min(n + 1, total) + ' / ' + total; };
      say(label(0, unread.length), { phase: 'read', n: 0, N: unread.length, cur: unread[0] });
      return pool(unread, 3, function (id) {
        if (stop) return Promise.reject(new Error(stop));
        return call({ op: 'read', evidence_id: id }).then(function (r) { last = { id: id, r: r }; return r; }, function (e) {
          // 하루 상한에 닿았으면 남은 것은 더 보내지 않는다.
          if (/횟수|한도/.test(String(e && e.message))) stop = e.message;
          throw e;
        });
      }, function (n, total) {
        var rr = last && last.r && last.r.result, v = !rr ? '' : rr.odometer_km != null && isFinite(Number(rr.odometer_km)) ? n0(rr.odometer_km) + 'km'
          : rr.amount != null && isFinite(Number(rr.amount)) ? n0(rr.amount) + '원' : '';
        say(n < total ? label(n, total) : '읽은 값을 비교하는 중…',
          { phase: 'read', n: n, N: total, cur: n < total ? unread[n] : null, pop: v ? { kind: kindOf(last.id), value: v } : null });
      })
        .then(function (res) {
          say('읽은 값을 운행과 비교하는 중…', { phase: 'match' });
          return call({ op: 'run', cycle: cyc, username: u }).then(function (j2) {
            // 판독 실패(500 등)·하루 한도는 곧바로 알리지 않고 남겨 둔다 — 예전에는 뒤이은 「검증했습니다」 알림에 바로 덮여 몰랐다(V3 B6).
            //   quiet(상신 창)는 창이 따로 말한다 — 남겨만 둔다.
            WARN[wk] = stop ? String(stop) : res.fail ? '사진 ' + res.fail + '장은 읽지 못했어요. 다시 검증하면 이어서 읽어요.' : '';
            return j2.row;
          });
        });
    });
  }

  /* ══════════════════ 화면 조각 ══════════════════ */
  var LV = { bad: ['불일치', 'bad'], warn: ['확인 필요', 'warn'], info: ['참고', ''] };
  /** 검증 항목 → 고치러 갈 화면. 없으면 버튼을 달지 않는다. */
  var FIX = {
    R01: ['trips', '운행일지에서 보기'], R02: ['evid', '통행료 차례로'], R04: ['trips', '운행일지에서 보기'],
    R05: ['trips', '운행일지에서 보기'], R06: ['evid', '영수증에서 보기'], R07: ['evid', '영수증에서 보기'],
    R08: ['evid', '영수증에서 보기'], A01: ['evid', '영수증에서 보기'],
    A02: ['evid', '영수증에서 보기'], A03: ['evid', '영수증에서 보기'], A04: ['evid', '영수증에서 보기'],
    A05: ['trips', '운행일지에서 보기'], A06: ['evid', '영수증에서 보기'], A07: ['evid', '영수증에서 보기'],
    // 2026-10-06 — R10 은 운행에 적은 금액을 지우는 것, R11·R12 는 영수증·계기판 사진을 올리는 것
    R10: ['trips', '운행일지에서 보기'], R11: ['evid', '주유 영수증 올리기'], R12: ['evid', '계기판 사진 올리기'],
    // 2026-10-15 금액 규칙 v3 — R09(근거자료 행)는 없어지고 R13(운행 없는 영수증 · 정산에서 뺌)이 생겼다. 2단계 그 차례로 보낸다.
    R13: ['evid', '영수증에서 보기'],
    // 2026-10-20 — R14(두 번 정산 의심 — 다음 날 날짜로 올라온 전날 영수증)도 2단계 그 차례로(그 줄에 「다른 운행에 붙이기」)
    R14: ['evid', '영수증에서 보기'],
    // 2026-10-21 — A11(한 장에 여러 영수증을 올린 원본 장에서 그 날짜·금액 영수증을 찾지 못함 — 서버 driving-verify.ts 원본 장 짝짓기)
    A11: ['evid', '영수증에서 보기'],
    // 2026-10-23 — R15(하이패스 영수증 원본 없음 — 서버 driving-verify.ts): 고칠 것은 운행이 아니라 하이패스 이용내역 PDF 를 다시 올리는 것.
    //   통행료 차례의 「하이패스 이용내역 PDF 올리기」와 같은 하이패스 화면(#/hipass)으로 보낸다(R11·R12 처럼 올리는 단추)
    R15: ['hipass', '하이패스 PDF 올리기']
  };
  /** R13(운행 없는 주차·통행료 영수증)이 가리키는 영수증의 구분 — 통행료만이면 통행료 차례, 아니면 주차 차례부터. */
  function r13Cat(it) {
    var ids = ((it.refs || {}).evid || []).map(String), cats = {};
    (C.state().ALL_EVID || []).forEach(function (e) { if (ids.indexOf(String(e.id)) >= 0) cats[e.category] = 1; });
    return cats['주차'] || !cats['통행료'] ? '주차' : '통행료';
  }
  /** AI(Gemini)가 사진을 읽어 낸 항목인가 — 코드가 A 로 시작한다(A00 은 '읽지 않음' 안내 · A10 은 원본 파일이 없어 대조를 생략했다는 참고라 뺀다).
   *  A11 = 원본 장(한 장에 여러 영수증)에서 찾지 못한 영수증(2026-10-21). */
  function isAi(it) { return /^A(0[1-9]|11)/.test(String(it && it.code || '')); }
  /** Gemini 표시. 구글 공식 로고 파일이 아니라, 같은 색감의 반짝임 모양 + 이름이다. */
  function gemBadge(label) {
    return '<span class="gem" title="AI가 사진을 읽어 찾은 항목">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="gemg" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#4C8DF6"/><stop offset=".55" stop-color="#9B72CB"/><stop offset="1" stop-color="#D96570"/></linearGradient></defs>' +
      '<path fill="url(#gemg)" d="M12 1.5c.6 5.6 4.9 9.9 10.5 10.5-5.6.6-9.9 4.9-10.5 10.5C11.4 16.9 7.1 12.6 1.5 12 7.1 11.4 11.4 7.1 12 1.5z"/></svg>' +
      (label || 'AI') + '</span>';
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
  /** 상신 뒤에 보이는 검증 글 — 끝의 「다시 검증하면 …」 문장(직원만 할 수 있는 일)은 뗀다. 서버(driving-verify.ts A00·A12 ·
   *  expense-verify.ts X00)가 그 문장을 늘 본문 맨 끝에 둔다(2026-10-21 문구 다듬기). 잠긴 기간·결재하는 분·굳힌 결과 창이 쓴다
   *  (같은 식: drv-expense.js lockedVerify · sheetpdf.js 결재 문서 검증 쪽 — 시험 supabase/functions/_shared/verify-wording_test.ts · harness plans/wording.mjs). */
  function noRecheck(d) { return String(d || '').replace(/\s*[—-]?\s*다시 검증하면[^.。]*[.。]?\s*$/, ''); }
  /** 목록 문장 안의 괄호 안내(「…(… 고쳐 주세요)」)를 괄호째 뗀다 — 괄호가 겹쳐도 바깥 괄호째. 닫히지 않은 괄호는 그대로 둔다. */
  function noAskParen(s) {
    var out = '', depth = 0, start = -1;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '(') { if (!depth) start = i; depth++; }
      else if (c === ')' && depth) {
        if (!--depth && !/(주세요|하세요|지우세요)\.?$/.test(s.slice(start + 1, i).trim())) out += s.slice(start, i + 1);
      } else if (!depth) out += c;
    }
    return depth ? out + s.slice(start) : out;
  }
  /** 결재하는 분이 보는 검증 결과 — 상신한 분께 하는 말(「영수증을 올려 주세요」 등)로 끝나는 문장은 뺀다(2026-10-16 3차).
   *  끝의 「다시 검증하면 …」 문장도 뺀다(2026-10-21 — 결재하는 분은 다시 검증할 수 없다).
   *  목록 문장(「…: 10.08 …」)은 괄호 안내만 떼고 남긴다(2026-10-21 — 「금액이 영수증과 다름」은 목록이 「…(… 고쳐 주세요)」로 끝나
   *  문장째 빠져, 결재하는 분이 어느 날이 얼마 다른지 못 봤다). */
  function apprDetail(d) {
    d = noRecheck(d);
    var parts = d.split(/\.\s+/), keep = parts.map(function (p) { return p.indexOf(':') >= 0 ? noAskParen(p) : p; })
      .filter(function (p) { return !/(주세요|하세요|지우세요)[.)]?$/.test(p.trim()); });
    var same = keep.length === parts.length && keep.every(function (p, i) { return p === parts[i]; });
    return same ? d : keep.join('. ').replace(/([^.])$/, '$1.');
  }
  function itemsHtml(items, links, appr) {
    if (!items || !items.length) {
      return '<div class="panel"><div class="blank"><div class="ico">' + ic('check', 21) + '</div>' +
        '<div class="t">확인이 필요한 항목이 없어요.</div></div></div>';
    }
    return '<div class="panel vlist">' + items.map(function (it) {
      var lv = LV[it.level] || LV.info, fx = links && it.level !== 'info' ? FIX[it.code] : null;
      var refs = it.refs || {}, nRef = (refs.trips || []).length + (refs.evid || []).length;
      var go = '';
      // 통행료 미확정(R02)·운행 없는 영수증(R13)은 2단계 영수증 › 그 차례로(「통행료 채우기」 화면은 없앴다 — 2026-10-15).
      //   R13 은 그 차례에 「다른 운행에 붙이기」(그 줄)·운행 추가 안내가 있다.
      if (links && it.code === 'R02') go = '<button class="btn sm vgo" data-evstep="통행료">통행료 차례로' + ic('chev', 12) + '</button>';
      else if (links && (it.code === 'R13' || it.code === 'R14')) { var sc = r13Cat(it); go = '<button class="btn sm vgo" data-evstep="' + sc + '">' + sc + ' 차례로' + ic('chev', 12) + '</button>'; }
      // 주유 영수증·계기판 사진이 모자란 것은 고칠 기록이 아니라 올릴 것이 없는 것 — 영수증 화면으로 보낸다.
      //   하이패스 원본이 없는 것(R15, 2026-10-23)도 — 운행 고치기 창(바로 고치기)이 아니라 하이패스 화면에서 이용내역 PDF 를 다시 올린다.
      else if (fx && (it.code === 'R11' || it.code === 'R12' || it.code === 'R15')) go = '<button class="btn sm vgo" data-v="' + fx[0] + '">' + fx[1] + ic('chev', 12) + '</button>';
      else if (links && nRef) {
        VITEMS.push(it);
        go = '<button class="btn sm vgo vfix" data-vfix="' + (VITEMS.length - 1) + '">바로 수정' + ic('chev', 12) + '</button>';
      } else if (fx) go = '<button class="btn sm vgo" data-v="' + fx[0] + '">' + fx[1] + ic('chev', 12) + '</button>';
      return '<div class="vitem v-' + esc(it.level) + (isAi(it) ? ' v-ai' : '') + '"><span class="st ' + lv[1] + '">' + lv[0] + '</span>' +
        '<div class="vb"><div class="vt">' + esc(it.title) + (isAi(it) ? ' ' + gemBadge() : '') + '</div>' +
        '<div class="vd">' + esc(appr ? apprDetail(it.detail) : it.detail) + '</div></div>' + go + '</div>';
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
    if (!trips.length && !evs.length) { C.toast('해당 운행이나 영수증을 찾지 못했어요. 기간을 확인하거나 다시 검증해 주세요.', true); return; }
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
          '<button class="btn sm pri" data-edit="' + esc(t.id) + '">운행 수정</button></div>';
      }).join('') + '</div>';
    }
    if (evs.length) {
      body += '<div class="fixh">영수증·사진 ' + n0(evs.length) + '건</div><div class="fixl">' + evs.map(function (e) {
        var canDel = e.username === mine && !C.evLocked(e);
        return '<div class="fixi">' + (e.photo_path
            ? '<a class="fixph" target="_blank" rel="noopener" aria-label="' + esc(C.md(e.date_millis) + ' ' + (e.category || '기타') + ' ' + n0(e.amount) + '원 영수증 사진 크게') + '" href="' + esc(C.photoUrl(e.photo_path)) + '"><img alt="" loading="lazy" src="' + esc(C.photoUrl(e.photo_path)) + '"></a>'
            : '<span class="fixph none">사진 없음</span>') +
          '<div class="fixt"><b>' + C.md(e.date_millis) + ' ' + esc(e.category || '기타') + ' ' + n0(e.amount) + '원</b>' +
          '<div class="dim">' + esc([e.vehicle_plate, e.memo].filter(Boolean).join(' · ')) + '</div></div>' +
          (e.photo_path ? '<a class="btn sm" target="_blank" rel="noopener" href="' + esc(C.photoUrl(e.photo_path)) + '">사진 크게</a>' : '') +
          (canDel ? ' <button class="btn sm" data-evdel="' + esc(e.id) + '">삭제</button>' : '') + '</div>';
      }).join('') + '</div>' +
        // 메뉴 이름은 지금 왼쪽 메뉴 그대로 — 예전 이름 「증빙」은 없다(2026-10-21 매뉴얼 로봇)
        '<div class="fhint" style="margin-top:8px">영수증의 금액, 날짜, 구분은 앱에서 고치거나, 여기서 지운 뒤 ‘영수증·통행료’ 단계에서 다시 올려 주세요.</div>';
    }
    C.openPanel('바로 수정 — ' + it.title, (isAi(it) ? 'AI가 사진을 읽어 찾은 항목이에요. ' : '') + '고친 뒤 다시 검증해 주세요.',
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
  /** bare = 표 칸 안(머리에 이미 「검증」이 있다 — 2026-10-19 사용성 2차 #9) */
  function sumChip(s, bare) {
    if (!s) return '';
    var p = [];
    if (s.bad) p.push('<span class="st bad">불일치 ' + n0(s.bad) + '</span>');
    if (s.warn) p.push('<span class="st warn">확인 ' + n0(s.warn) + '</span>');
    if (s.info) p.push('<span class="st dim">참고 ' + n0(s.info) + '</span>');
    if (!p.length) p.push('<span class="st ok">이상 없음</span>');
    return '<span class="vsumc">' + (bare ? '' : '<span class="vlab">검증</span>') + p.join('') + '</span>';
  }
  function whenText(iso) {
    var ms = Date.parse(iso);
    return isFinite(ms) ? C.ymd(ms) + ' ' + C.hm(ms) : '';
  }
  /** 결재 완료 출력 표의 짧은 날짜 「MM.DD HH:MM」 — 개인경비·법인카드 표의 finWhen 과 같다(2026-10-21) */
  function finWhen(iso) {
    var ms = Date.parse(iso);
    return isFinite(ms) ? C.md(ms) + ' ' + C.hm(ms) : '';
  }

  /* ══════════════════ 검증 (개인) ══════════════════ */
  function viewVerify() {
    var S = C.state();
    if (!S.LOADED) return C.head('검증·상신') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('검증', '검증');
    var u = C.myName(), cyc = S.CYCKEY, k = keyOf(u, cyc);
    // 마감 단계가 아직 1·2단계인가(맨 아래 「지금은 N단계 차례」 — 그때는 깜빡이는 단추가 없다, AU6-L9)
    var ahead = !!C.stepNow && Math.min(C.stepNow(), 3) < 3;
    var h = C.head('검증·상신', esc(cycName(S.CYCKEY)) +
      (ahead ? ' · 지금은 앞 단계 차례예요. 그 단계부터 마쳐 주세요.' : ' · 깜빡이는 버튼부터 순서대로 눌러 주세요.'));
    if (ROWS[k] === undefined) {
      fetchLatest(u, cyc).then(function () { if (C.state().VIEW === 'verify') C.render(); });
      return h + C.skeleton();
    }
    var row = ROWS[k], busy = RUN.busy && RUN.who === k;
    VITEMS = [];
    var a = C.myAppr(), locked = a && (a.status === 'submitted' || a.status === 'approved');
    // 결재 중·결재 완료(2026-10-19 사용성 2차 #5) — 개인경비처럼 상신 때 굳힌 검증 결과를 먼저 보인다
    //   (예전: 「검증 전 · 아직 검증하지 않았습니다」 + 「다시 검증하기」 + 없는 「위 ① 검증하기」 안내).
    if (locked) return lockedVerify(a, cyc);
    // 반려·회수 뒤(2026-10-15 2차) — 3단계에도 반려 사유 띠. 무엇을 고쳐야 하는지 여기서 바로 보인다.
    if (a && (a.status === 'rejected' || a.status === 'withdrawn')) {
      var stx = C.apprStatusText(a);
      // 상태 글과 할 일 사이에 마침표 한 번(2026-10-24 검수 — 「회수했어요 고친 뒤…」처럼 붙어 읽혔다). 사유가 마침표로 끝나면 그대로
      var stt = String(stx.t || '').trim();
      if (!/다시 상신/.test(stt) && !/[.!?…]$/.test(stt)) stt += '.';
      h += '<div class="hpnote' + (a.status === 'rejected' ? ' warn' : '') + '" data-rejband>' + ic('alert', 16) + '<span><b>' + esc(stt) + '</b>' +
        (/다시 상신/.test(stx.t) ? '' : ' 고친 뒤 다시 검증하고 상신하세요.') + '</span></div>';
    }
    var s = row && row.summary, items = (row && row.result && row.result.items) || [];
    var verdict, clean = '';
    // 진행 글은 .vnote 칸만 고친다(Gemini 표시는 그대로 — 개인경비 .xvnote · 법인카드 .cvnote 와 같게, 2026-10-20)
    if (busy) verdict = '<span class="gemrun">' + gemBadge('AI') + '</span><span class="vnote">' + esc(RUN.note || '검증하는 중…') + '</span>';
    else if (!row) verdict = '아직 검증하지 않았어요';
    else if (s.bad) verdict = '맞지 않는 곳이 <em>' + n0(s.bad) + '건</em> 있어요';
    else if (s.warn) { verdict = '확인할 것이 <em>' + n0(s.warn) + '건</em> 있어요'; clean = ' wait'; }
    else { verdict = '<em>이상 없어요</em>'; clean = ' clean'; }

    // 검증은 한 번에 하나만 돈다. 다른 주기 것이 돌고 있으면 그렇다고 말한다(눌러도 반응이 없으면 고장으로 보인다).
    // 상신까지의 순서: ① 검증 → ② PDF 미리보기로 확인 → ③ 결재 상신. 지금 할 것 하나만 깜빡인다.
    var seen = previewOk(k);
    var fresh = !!FRESH[k];
    // 검증이 도는 동안(「다시 검증하기」 포함)은 ① = 도는 중 · ②③ = 아직(2026-10-20 V3 B2 — 다시 검증할 때 ① 초록 ✓ · ② 분홍 「지금」인데 못 누름으로 거꾸로 보였다)
    var stage = locked ? 0 : busy || !row || !fresh ? 1 : !seen ? 2 : 3;
    // 2026-10-07: 순서대로 큰 단추 세 칸 — ① 검증하기 → ② PDF 미리보기 → ③ 결재 상신. 앞 단계를 마쳐야 다음 칸이 열린다.
    var canSubmit = !a || a.status === 'rejected' || a.status === 'withdrawn';
    // 2026-10-20 디자인 v2: 세 시스템 같은 단계 카드(C.vx.stepCard). 마감 단계가 아직 1·2단계면(위 ahead) 큰 단추를 흐리게(AU6-L9)
    var card = function (n, title, desc, button) { return stepCard(n, stage, title, desc, button, { busy: busy && n === 1, ahead: ahead }); };
    var steps = locked ? '' : '<ol class="vsteps" aria-label="상신 순서">' +
      card(1, '검증하기 ' + gemBadge('AI'),
        busy ? 'AI가 영수증과 계기판 사진을 읽고 기록과 비교하는 중…'
          : row && fresh ? readDone(row, WARN[u + '|' + cyc])
          : row ? '먼저 지금 자료로 검증해 주세요. 아래는 지난 검증(' + esc(whenText(row.created_at)) + ') 결과예요.'
          : 'AI가 영수증과 계기판 사진을 읽고 운행 기록과 맞는지 확인해요.',
        gemBtn('data-vrun' + (RUN.busy ? ' disabled' : ''),
          busy ? (aimShort('d:' + k) || RUN.note || 'AI가 읽는 중…') : RUN.busy ? '다른 검증이 도는 중…' : row && fresh ? '다시 검증하기' : '검증하기',
          busy, ' big' + (stage === 1 ? ' pri' + (busy ? '' : ' cta') : ''))) +
      card(2, 'PDF 미리보기',
        row && fresh ? '결재자에게 갈 문서를 미리 확인해요.' : '먼저 검증해 주세요.',
        '<button class="btn big' + (stage === 2 ? ' pri cta' : '') + '" data-pdf=""' + (row && fresh && !busy ? '' : ' disabled') + '>' +
          ic('dl', 16) + 'PDF 미리보기</button>') +
      card(3, '상신',
        !canSubmit ? '이미 상신했어요.' : stage === 3 ? '결재선을 고르고 올려요.' : 'PDF 미리보기를 먼저 확인해 주세요.',
        canSubmit ? '<button class="btn big' + (stage === 3 ? ' pri cta' : '') + '" id="btnOpenSubmit"' + (stage === 3 && !busy ? '' : ' disabled') + '>' +
          (a && (a.status === 'rejected' || a.status === 'withdrawn') ? '다시 상신' : '상신') + '</button>' : '') +
      '</ol>';
    // 단계 카드는 제목 바로 아래(P_Verifying) — 그 아래 결과 자리. 검증이 도는 동안은 결과 자리에 AI 검증 모션(응답 뒤 실제 결과로 딱지)
    var moving = busy && aimOn('d:' + k);
    h += steps;
    if (moving) h += aimHtml('d:' + k, verdict);
    else h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (row && !s.bad ? ' ok' : '') + '"></span>' +
      (row ? '마지막 검증 ' + esc(whenText(row.created_at)) : '검증 전') + '</div>' +
      '<p class="verdict' + clean + '">' + verdict + '</p>' +
      (row ? '<div class="facts">' +
        fact('불일치', n0(s.bad), '금액·계기판이 서로 다름', s.bad > 0) +
        fact('확인 필요', n0(s.warn), '사람이 한 번 봐야 함') +
        fact('참고', n0(s.info), '고칠 것은 아님') +
        fact('사진 인식', row.ai ? n0(s.read) + ' / ' + n0(s.receipts) + '<small>장</small>' : '—',
          row.ai ? 'AI가 읽은 영수증·계기판' : '규칙으로만 검증(AI 미설정)', false, row.ai) +
        '</div>' : '') + '</div>';
    if (moving) { /* 결과는 응답 뒤에 — 지난 결과를 먼저 보이지 않는다 */ }
    else if (row) {
      var need = items.filter(function (i) { return i.level !== 'info'; });
      var info = items.filter(function (i) { return i.level === 'info'; });
      h += C.sect('봐야 할 것', need.length ? need.length + '건' : null, '', itemsHtml(need, true));
      if (info.length) h += C.sect('참고', info.length + '건', '', itemsHtml(info));
    } else if (!busy) {
      h += '<div class="panel"><div class="blank"><div class="ico">' + ic('scan', 21) + '</div>' +
        '<div class="t">이번 기간 기록을 검증해 보세요.</div>' +
        '<div class="d">계기판이 이어지는지, 영수증 금액이 입력과 같은지, 같은 영수증을 두 번 올리지 않았는지 확인해요.<br>' +
        '맞지 않는 곳이 있어도 상신할 수 있고, 결재자도 같이 봐요.</div></div></div>';
    }
    h += '<div class="anote">금액은 입력값과 정산 규칙으로만 계산해요. AI는 <b>맞지 않는 곳을 표시</b>만 하고 값을 바꾸지 않아요. ' +
      '고친 뒤 다시 검증해 주세요.</div>';
    return h;

    function fact(kk, v, sub, alert, gem) {
      return '<div class="fact"><div class="k">' + esc(kk) + (gem ? ' ' + gemBadge() : '') + '</div>' +
        '<div class="v' + (alert ? ' alert' : '') + '">' + v + '</div>' +
        '<div class="sub">' + esc(sub || '') + '</div></div>';
    }
  }

  /** 결재 중·결재 완료 기간의 검증·상신 화면(2026-10-19 사용성 2차 #5, 개인경비 lockedVerify 와 같은 모양).
   *  다시 검증하지 않는다(잠긴 기간이라 자료가 바뀌지 않는다). 상신 때 굳힌 검증 결과(driving_frozen.verify)와
   *  결재 문서(PDF 받기·문서 보기)만 둔다. 고칠 길이 없으니 항목 글의 「…하세요」 안내는 뗀다. */
  function lockedVerify(a, cyc) {
    var S = C.state(), done = a.status === 'approved';
    var h = C.head('검증·상신', esc(cycName(S.CYCKEY)) + ' · ' + (done ? '결재가 끝난 기간이에요.' : '결재 중인 기간이에요.'));
    var fk = fzKey(a), f = FZSUM[fk];
    if (f === undefined) wantSummaries([a.id]);
    var v = f && f.verify, s = (v && v.summary) || {};
    var items = ((v && (v.items || (v.result && v.result.items))) || []).map(function (i) {
      return /다시 검증하면/.test(i.detail || '') ? Object.assign({}, i, { detail: noRecheck(i.detail) }) : i;
    });
    var verdict, clean = '';
    if (f === undefined) verdict = FZFAIL[fk] ? '상신 때 검증 결과를 불러오지 못했어요. 잠시 후 다시 열어 주세요.' : '상신 때 검증 결과를 불러오는 중…';
    else if (!v) verdict = '상신 때 검증 결과가 없어요';
    else if (s.bad) verdict = '맞지 않는 곳이 <em>' + n0(s.bad) + '건</em> 있었어요';
    else if (s.warn) { verdict = '확인할 것이 <em>' + n0(s.warn) + '건</em> 있었어요'; clean = ' wait'; }
    else { verdict = '<em>이상 없었어요</em>'; clean = ' clean'; }
    var at = v && (v.ran_at || v.created_at || (f && f.frozen_at));
    var fact = function (kk, val, sub, alert, gem) {
      return '<div class="fact"><div class="k">' + esc(kk) + (gem ? ' ' + gemBadge() : '') + '</div>' +
        '<div class="v' + (alert ? ' alert' : '') + '">' + val + '</div><div class="sub">' + esc(sub || '') + '</div></div>';
    };
    h += '<div class="hero fade" data-lockedverify><div class="eyebrow"><span class="dot' + (v && !s.bad ? ' ok' : '') + '"></span>' +
      '<span>상신 때 검증 결과' + (at ? ' · <span style="white-space:nowrap">' + esc(whenText(at)) + '</span>' : '') + '</span></div>' +
      '<p class="verdict' + clean + '">' + verdict + '</p>' +
      (v ? '<div class="facts">' +
        fact('불일치', n0(s.bad), '금액·계기판이 서로 다름', s.bad > 0) +
        fact('확인 필요', n0(s.warn), '사람이 한 번 봐야 함') +
        fact('참고', n0(s.info), '고칠 것은 아님') +
        fact('사진 인식', v.ai ? n0(s.read) + ' / ' + n0(s.receipts) + '<small>장</small>' : '—',
          v.ai ? 'AI가 읽은 영수증·계기판' : '규칙으로만 검증(AI 미설정)', false, v.ai) + '</div>' : '') +
      // 결재 문서 미리보기(2026-10-12) — 상신 때 저장한 자료가 있을 때만. 「PDF 받기」·「문서 보기」는 한 줄·같은 높이로 —
      //   미리보기 자리의 단추 줄 맨 앞에 넣는다(2026-10-20 V3 다듬기: 두 단추가 다른 줄·다른 높이였다). 미리보기가 없으면 예전처럼 따로 한 줄.
      (function () {
        var pdfB = '<button class="btn sm" data-pdf="">' + ic('dl', 14) + 'PDF 다운로드</button>';
        var slot = f !== null && C.apvSlot ? C.apvSlot('', a) : '';
        return slot.indexOf('<div class="apvbar">') >= 0 ? slot.replace('<div class="apvbar">', '<div class="apvbar">' + pdfB) : '<div class="vact">' + pdfB + '</div>' + slot;
      })() + '</div>';
    if (v) {
      var need = items.filter(function (i) { return i.level !== 'info'; }), info = items.filter(function (i) { return i.level === 'info'; });
      VITEMS = [];
      h += C.sect('봐야 할 것', need.length ? need.length + '건' : null, '', itemsHtml(need, false, true));
      if (info.length) h += C.sect('참고', info.length + '건', '', itemsHtml(info, false, true));
    }
    h += '<div class="anote">' + (done ? '결재가 끝난 기간이라' : '결재 중인 기간이라') + ' 다시 검증하지 않고, ' +
      '상신할 때 저장한 결과를 결재자도 같이 봐요. 결재 문서는 ‘PDF\u00a0다운로드’로 확인하세요.</div>';
    return h;
  }

  function startRun(u) {
    var S = C.state(), cyc = S.CYCKEY, k = keyOf(u, cyc), mk = 'd:' + k;
    if (RUN.busy) return;
    RUN = { busy: true, note: '기록을 검사하는 중…', who: k };
    aimBegin(mk, drvMotion(u, cyc));            // AI 검증 모션(2026-10-20) — 응답이 올 때까지 결과 자리에
    C.render();
    // 돌고 있는 검증의 결과를 다른 곳(상신 창)도 기다릴 수 있게 약속을 걸어 둔다.
    var p = runVerify(u, cyc, function (t, info) {
      RUN.note = t;
      aimStep(mk, info);
      // 화면 전체를 다시 그리지 않는다. 그 사이 다른 주기로 넘어갔으면 남의 판정 줄에 쓰지 않는다.
      var st = C.state(), v = document.querySelector('.hero .verdict .vnote');
      if (v && st.VIEW === 'verify' && st.CYCKEY === cyc && !C.isMulti()) {
        v.textContent = t;
        var gl = document.querySelector('[data-vrun] .gl'); if (gl) gl.textContent = aimShort(mk) || t;   // 단추에는 짧게(「읽는 중… 3 / 9」)
      }
    });
    RUN.p = p;
    p.then(function (row) {
      ROWS[k] = row || null;
      FRESH[k] = 1;
      setPreviewed(k, false);
      ALLROWS.list = null;
      if (C.aiReset) C.aiReset();                 // 영수증 화면의 사진 판독도 새로 받게
      var w = WARN[u + '|' + cyc] || '';          // 사진 판독 실패·하루 한도는 이 마지막 알림에 이어 붙인다(V3 B6)
      C.toast((row ? '검증했어요(' + sumText(row.summary) + ').' : '검증했어요.') + (w ? ' ' + C.endDot(w) : ''), !!w);
      // 응답이 왔다 — 실제 결과(서버 refs.trips)로 운행 줄마다 딱지를 찍은 뒤(80ms 간격) 결과 화면으로
      if (row) return aimFinish(mk, drvChips(row));
    }).catch(function (e) {
      C.toast(failMsg('검증하지 못했어요', e, '잠시 후 다시 눌러 주세요.'), true);
    }).then(function () { RUN = { busy: false, note: '', who: '' }; aimEnd(mk); C.render(); });
  }

  /* ══════════════════ 관리 「현황」의 검증 칸 (2026-10-15 2차) ══════════════════
     예전 「검증 현황」(전체 검증) 화면은 「마감 현황」·「정산」과 함께 운행일지 관리 「현황」(driving-app.js viewStatus)
     한 화면으로 합쳤다. 여기서는 직원별 마지막 검증 결과(검증 딱지 · 결과 보기 · 대신 검증)만 낸다.
     관리자 반려·정정 열기는 「결재 완료 출력」(viewFinal)에만 둔다. 예전 주소 #/a_verify 는 현황으로 돌아간다. */
  function statusVerify(cyc) {
    // 아직 안 받았거나(다른 기간) 대신 검증한 뒤 비웠으면 받는다 — 받는 중에는 다시 부르지 않는다.
    if (ALLROWS.key !== cyc || (!ALLROWS.list && !ALLROWS.busy)) {
      ALLROWS = { key: cyc, list: null, busy: true };
      C.fetchAll('/rest/v1/driving_verifications?cycle=eq.' + encodeURIComponent(cyc) +
        '&select=id,username,summary,ai,created_at,result&order=created_at.desc,id.desc')     // id 둘째 열쇠(2026-10-20)
        .then(function (rows) {
          var seen = {}, out = [];
          (rows || []).forEach(function (r) { if (!seen[r.username]) { seen[r.username] = 1; out.push(r); } });
          ALLROWS = { key: cyc, list: out };
          out.forEach(function (r) { ROWS[keyOf(r.username, cyc)] = r; });
        }).catch(function () { ALLROWS = { key: cyc, list: [], fail: true }; })   // 못 받았으면 「검증 전」이 아니라 「불러오지 못함」(2026-10-16 3차)
        .then(function () { if (C.state().VIEW === 'a_status') C.render(); });
    }
    if (ALLROWS.key !== cyc || !ALLROWS.list) return null;
    var by = {}, fail = !!ALLROWS.fail;
    ALLROWS.list.forEach(function (r) { by[r.username] = r; });
    // 상신한 사람(결재 중·완료)은 상신 때 굳힌 검증 결과(고정본)를 먼저 쓴다 — 결재 문서와 같은 자료(2026-10-16 6차:
    //   현황 표는 「검증 전」인데 결재 문서에는 검증 결과가 있었다. 직접 「검증하기」를 안 누르고 상신하면 검증 기록 표에는 줄이 없다).
    var live = (C.state().APPR || []).filter(function (a) { return a.cycle === cyc && (a.status === 'submitted' || a.status === 'approved'); });
    if (live.length) wantSummaries(live.map(function (a) { return a.id; }));
    FZV = {};
    live.forEach(function (a) {
      var f = FZSUM[fzKey(a)];
      if (f && f.verify && f.verify.summary) {
        FZV[keyOf(a.username, cyc)] = f.verify;
        by[a.username] = { username: a.username, summary: f.verify.summary, created_at: f.verify.ran_at || f.frozen_at, frozen: true };
      }
    });
    return {
      fail: fail,
      /** 검증 요약({ bad, warn, info, read, receipts }) — 검증 전이면 null */
      sum: function (u) { var r = by[u]; return r ? (r.summary || {}) : null; },
      // 검증 결과가 있으면 딱지 자체가 「결과 보기」 단추다(2026-10-19 사용성 2차 #9 — 줄마다 단추 수가 달랐다)
      chip: function (u) {
        var r = by[u];
        return r ? '<button type="button" class="vchip" data-vshow="' + esc(u) + '" title="' + esc(C.nameOf(u)) + ' 님 검증 결과 보기">' + sumChip(r.summary, true) + '</button>'
          : '<span class="dim">' + (fail ? '불러오지 못함' : '검증 전') + '</span>';
      },
      text: function (u) { var r = by[u]; return r ? sumText(r.summary) : fail ? '불러오지 못함' : '검증 전'; },
      when: function (u) { var r = by[u]; return r ? whenText(r.created_at) + (r.frozen ? ' (상신 때)' : '') : ''; },
      /** 결과 보기 · (다시) 검증 — 그 직원 대신 돌린다 */
      act: function (u) {
        var r = by[u], busy = RUN.busy && RUN.who === keyOf(u, cyc);
        // 결과 보기는 검증 칸의 딱지가 한다 — 여기는 늘 단추 하나(자리가 줄마다 같다)
        return gemBtn('data-vrunfor="' + esc(u) + '"' + (RUN.busy ? ' disabled' : ''), busy ? '읽는 중…' : r ? '다시 검증' : '검증', busy, ' sm');
      }
    };
  }

  /** appr = 결재하는 분(남의 상신 건)이 본다 — 상신한 분께 하는 말은 빼고, 고치는 것은 상신한 분 몫이라고 한 줄.
   *  frozen = 상신 때 굳힌 결과(다시 검증할 수 없다) — 상신한 분 본인이 봐도 끝의 「다시 검증하면 …」 문장은 뗀다(2026-10-21). */
  function showItems(title, sub, v, appr, frozen) {
    var s = (v && v.summary) || {}, items = ((v && (v.items || (v.result && v.result.items))) || []).map(function (i) {
      return frozen && /다시 검증하면/.test(i.detail || '') ? Object.assign({}, i, { detail: noRecheck(i.detail) }) : i;
    });
    // AI 를 안 쓴 검증이면 한 줄 — 결재 문서 PDF 의 검증 쪽과 같은 말(sheetpdf.js). 법인카드는 사진이 없어 그 종류의 말(aiNote)을 쓴다.
    //   예전 「Gemini 읽기 없음」은 법인카드 창에 늘 보였다(카드 검증은 ai:false 로 넘어온다 — 2026-10-21 매뉴얼 로봇).
    var aiNote = !v ? '' : v.aiNote != null ? String(v.aiNote) : v.ai === false ? 'AI 인식 없음(규칙 검증만)' : '';
    C.openPanel(title, sub,
      (appr ? '<div class="anote" style="margin-top:0">수정은 상신자가 해요. 고칠 곳이 있으면 반려하고 사유를 적어 주세요.</div>' : '') +
      '<div class="vsum">' + sumChip(s) +
      (v && (v.ran_at || v.created_at) ? '<span class="dim">' + esc(whenText(v.ran_at || v.created_at)) + ' 기준</span>' : '') +
      (aiNote ? '<span class="dim">' + esc(aiNote) + '</span>' : '') + '</div>' +
      itemsHtml(items.filter(function (i) { return i.level !== 'info'; }), false, appr) +
      (items.some(function (i) { return i.level === 'info'; })
        ? '<div class="vsub">참고</div>' + itemsHtml(items.filter(function (i) { return i.level === 'info'; }), false, appr) : ''),
      '<span style="flex:1"></span><button class="btn pri" data-close>닫기</button>');
  }

  /* ══════════════════ 고정본 ══════════════════
     ★ 회수·반려 뒤 다시 상신하면 서버는 같은 결재 번호를 다시 쓰고 고정본을 덮어쓴다.
       번호만으로 기억해 두면 옛 문서가 나온다(결재자가 옛 PDF 를 보고 새 건을 승인한다).
       그래서 열쇠에 상신 시각을 넣는다 — 다시 상신하면 열쇠가 달라져 새로 받는다. */
  var FZ = {};                           // 열쇠 → 고정본(통째) | null(없음)
  var FZSUM = {}, FZFAIL = {}, FZASK = '';   // 열쇠 → {verify 요약} | null · 실패 시각 · 묻는 중인 묶음
  var FZWAIT = [];                      // 고정본 요약을 기다리는 쪽(결재 창 다시 그리기)
  function fzFlush() { var w = FZWAIT; FZWAIT = []; w.forEach(function (f) { try { f(); } catch (e) { } }); }
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
    if (e && e.stale) { C.toast('결재 문서가 회수 뒤 다시 상신됐어요. 목록을 다시 불러올게요.', true); C.loadAll(); return; }
    C.toast('결재 문서를 불러오지 못했어요. 잠시 후 다시 해 주세요.', true);
  }
  /** 결재 카드에 붙일 검증 요약을 한 번에 받아 온다. 받으면 화면을 다시 그린다. */
  function wantSummaries(ids, done) {
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
    if (done) FZWAIT.push(done);          // 다 받으면(실패해도) 알려 준다 — 결재 창(관리자 반려 등)이 「불러오는 중」에 멈추지 않게(2026-10-16 3차)
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
        fzFlush();
      })
      .catch(function () {
        // ★ 실패를 '고정본 없음'으로 굳히지 않는다 — 그러면 결재 문서 버튼이 세션 내내 사라진다.
        need.forEach(function (a) { FZFAIL[fzKey(a)] = Date.now(); });
        FZASK = '';
        // 못 받았어도 다시 그린다 — 결재함은 검증 결과를 받기 전에는 카드를 묶지 않고 기다린다(2026-10-20 V3 B7)
        if (C.state().VIEW === view) C.render();
        fzFlush();
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
        return '<div class="aext"><span class="dim" style="font-size:12px;flex:1">상신 때 저장한 자료가 없는 예전 건이에요. 지금 자료로 만들어요.</span>' +
          '<button class="btn sm" data-pdf="' + (mine ? '' : esc(a.username)) + '">' + ic('dl', 13) + '운행기록부 PDF</button></div>';
      }
      return '<div class="aext"><span class="dim" style="font-size:12px">상신 때 저장한 자료가 없는 예전 건이에요. ' +
        '그 달의 ‘정산·엑셀’ 화면에서 다운로드하세요.</span></div>';
    }
    var chip = f && f.verify ? '<button class="vchip" data-fzverify="' + a.id + '" title="상신할 때의 검증 결과 보기">' +
      sumChip(f.verify.summary) + '</button>' : '';
    return apprBrief(a, f) + '<div class="aext">' + chip +
      (done && C.prints ? C.prints.badge('driving', a) : '') +       // 출력 딱지(2026-10-14)
      '<span style="flex:1"></span>' +
      '<button class="btn sm" data-fzpdf="' + a.id + '">' + ic('dl', 13) +
      'PDF 다운로드</button>' +
      (done ? '<button class="btn sm" data-fzxlsx="' + a.id + '">' + ic('dl', 13) + '엑셀 다운로드</button>' : '') +
      '</div>';
  }

  /** 「영수증 없음」(R06) 내용에서 날짜·금액만 — 서버 문구 「… 영수증이 없습니다: 10.05 1,100원, 10.07 3,300원(합계 4,400원). 자동 계산…」
   *  (2026-10-21 문구 다듬기 전 굳힌 글 「…(합계 4,400원): 10.05 1,100원, …」도 같은 답). 없으면 ''.
   *  「하이패스 영수증 원본 없음」(R15, 2026-10-23)도 같은 꼴 — 「… 하이패스 영수증 원본(PDF)이 없습니다: 10.05 3,300원(합계 3,300원). …」 */
  function noRcpDays(detail) {
    var d = String(detail || ''), m = /:\s*((?:\d{2}\.\d{2} [\d,]+원(?:, )?)+(?: 외 \d+건)?)/.exec(d), t = /\(합계 ([\d,]+원)\)/.exec(d);
    return m ? m[1] + (t ? ' (합계 ' + t[1] + ')' : '') : '';
  }
  /** 지금 내가 결재할 차례인 건인가(요약 문구용). */
  function myTurn(a) { var me = (C.state().ME || {}).username; return !!me && (a.steps || []).some(function (s) { return s.seq === a.cur_seq && s.approver === me; }); }
  /** 판정 띠 「대체로 정상입니다 — …」 뒤 — 아래에 항목 목록이 없으면 「확인 항목」이라 하지 않는다(세 시스템 같은 말).
   *  예전에는 항목이 하나도 없고 칩 「! AI 사진 판독 0/3장」만 있는데 「아래 확인 항목만 살펴봐 주세요」라 했다(2026-10-16 5차). */
  function warnTail(items, vs, asApprover) {
    if (items && items.length) return asApprover ? '확인 항목만 살펴봐 주세요' : '확인 항목은 결재자에게도 보여요';
    var un = vs && vs.receipts && vs.read < vs.receipts ? vs.receipts - vs.read : 0;
    if (un) return asApprover ? 'AI가 읽지 않은 사진 ' + n0(un) + '장은 직접 확인해 주세요' : 'AI가 읽지 않은 사진 ' + n0(un) + '장은 결재자가 직접 확인해요';
    return asApprover ? '‘!’ 표시만 살펴봐 주세요' : '‘!’ 표시는 결재자에게도 보여요';
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
    //   이름 달의 앞 달(1월분 → 12월분, 2026-10-20). 12월 추가 기간(12월분 2차)은 견주지 않는다 — 「—」.
    var pkey = prevMonthKey(a.cycle), pm = pkey ? +pkey.slice(5, 7) + '월분' : '';
    // 스냅샷 버전이 다르면(예전 방식은 영수증 미포함) 금액 기준이 달라 비교하지 않는다.
    var prev = pkey ? (C.state().APPR || []).filter(function (x) {
      return x.username === a.username && x.cycle === pkey && (x.status === 'approved' || x.status === 'submitted') &&
        x.snapshot && x.snapshot.cost != null && (x.snapshot.version || 1) === (s.version || 1);
    })[0] : null;
    var cmp = '';
    var bigJump = false;
    if (prev) {
      var pc = Number(prev.snapshot.cost) || 0, d = cost - pc, pct = pc ? Math.round(d / pc * 100) : null;
      bigJump = pc > 0 && d > 50000 && pct >= 50;
      cmp = '<div class="abf"><span class="k">전월(' + pm + ') 대비</span><b class="' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' +
        (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '') + won(Math.abs(d)) + (pct != null && d ? ' <small>(' + (d > 0 ? '+' : '−') + (Math.abs(pct) < 1 ? '1% 미만' : Math.abs(pct) + '%') + ')</small>' : '') + '</b>' +
        '<span class="sub">' + pm + ' ' + won(pc) + ' · ' + n0(prev.snapshot.trips) + '건 · ' + C.km(prev.snapshot.km) + 'km</span></div>';
    } else {
      cmp = '<div class="abf"><span class="k">전월 대비</span><b class="dimv">—</b><span class="sub">' + (pkey ? '볼 수 있는 ' + pm + ' 결재가 없어요.' : '추가 기간은 전월과 비교하지 않아요.') + '</span></div>';
    }
    // 검증(상신 때 굳힌 결과)
    var v = f && f.verify, vs = (v && v.summary) || null;
    var items = ((v && (v.items || (v.result && v.result.items))) || []).filter(function (i) { return i.level === 'bad' || i.level === 'warn'; });
    // 「영수증 없음」(R06)은 결재선 모두가 꼭 보게 한다(2026-10-16 사용자: 「불일치 표시만 해줘. 결재선 사람들도 다 알 수 있게」) —
    //   판정 띠에 몇 일인지 적고, 항목 목록 맨 앞에 두며(4건에서 잘리지 않게), 결재하는 분에게도 그날 날짜·금액을 보인다.
    var noRcp = items.filter(function (i) { return i.code === 'R06'; });
    items = noRcp.concat(items.filter(function (i) { return i.code !== 'R06'; }));
    var noRcpTxt = noRcp.map(function (i) { var m = /영수증 없는\s*(\S+)\s*(\d+)\s*일/.exec(i.title || ''); return m ? m[1] + ' ' + m[2] + '일' : ''; }).filter(Boolean).join(' · ');
    var checks = [];
    // 2026-10-15 2차: 불일치가 띠·칩·알약 세 번 나왔다 — 칩 「검증 불일치 N건」은 빼고 띠(판정)와 알약(검증 딱지)만 둔다.
    if (vs) {
      if (vs.receipts) checks.push(vs.read >= vs.receipts ? ['ok', 'AI 인식 ' + n0(vs.read) + '/' + n0(vs.receipts) + '장 완료'] : ['warn', 'AI 인식 ' + n0(vs.read) + '/' + n0(vs.receipts) + '장']);
    } else if (f === undefined) { if (!FZFAIL[fzKey(a)]) checks.push(['warn', '검증 결과를 불러오는 중…']); }   // 못 받았으면 그 줄은 없앤다(판정 띠가 말한다)
    else checks.push(['warn', '상신 때 검증 결과가 없어요']);
    // 통행료 미확정 — 아래 항목(R02)에 이미 있으면 칩으로 또 세지 않는다
    var hasR02 = items.some(function (i) { return i.code === 'R02'; });
    if (s.toll_unknown && !hasR02) checks.push(['warn', '통행료 미확정 ' + n0(s.toll_unknown) + '건(0원으로 정산)']);
    // 영수증 없음(R06)·금액 다름(R10)·운행 없는 영수증(R13)이 남았으면 「✓ 통행료 모두 확정」을 달지 않는다(2026-10-16 3차 — 같은 카드에 ✓ 와 「영수증 없는 통행료 3일」이 같이 떴다)
    //   두 번 정산 의심(R14, 2026-10-20)도 — 통행료 영수증일 수 있다(어느 구분인지는 상세에만 있다)
    //   하이패스 영수증 원본 없음(R15, 2026-10-23)도 — 늘 통행료다
    var tollIssue = items.some(function (i) { return ((i.code === 'R06' || i.code === 'R10') && /통행료/.test(i.title || '')) || i.code === 'R13' || (i.code === 'R14' && /통행료/.test(i.detail || '')) || i.code === 'R15'; });
    if (!s.toll_unknown && !hasR02 && !tollIssue) checks.push(['ok', '통행료 모두 확정']);
    // rate_miss 는 단가가 없던 「분기-지역」 목록이다(예: 2026-4-수도권). 빈 목록이면 문제없음.
    var rm = Array.isArray(s.rate_miss) ? s.rate_miss : (Number(s.rate_miss) > 0 ? [String(s.rate_miss) + '건'] : []);
    if (rm.length) checks.push(['warn', '유류 단가 미등록(' + rm.map(function (k) { var q = String(k).split('-'); return q.length === 3 ? q[0] + '년 ' + q[1] + '분기 ' + q[2] : k; }).join(', ') + ')이라 기본 단가로 계산했어요']);
    if (bigJump) checks.push(['warn', '전월보다 비용이 크게 늘었어요']);
    var nBad = (vs && vs.bad ? 1 : 0) + checks.filter(function (c) { return c[0] === 'bad'; }).length,
      nWarn = (vs && vs.warn ? 1 : 0) + checks.filter(function (c) { return c[0] === 'warn'; }).length + (s.toll_unknown && hasR02 ? 1 : 0);
    // 결재하는 분에게 상신자가 할 일(영수증을 올리세요 등)을 시키지 않는다 — 항목은 제목만, 고칠 것은 상신자 몫이라고 한 줄(2026-10-15 2차)
    var viewer = (C.state().ME || {}).username, asApprover = a.username !== viewer;
    // ★ 상신 때 검증 결과를 못 받았으면(불러오는 중·실패·옛 건) 「이상 없음」이라고 하지 않는다.
    //   「검증 결과를 불러오는 중…」으로 시작하는 글 — driving-app.js apprLoading 이 이 앞부분으로 받는 중을 가린다(세 모듈 같은 글. 판정 줄은 문장이라 세 모듈 모두 끝에 마침표 — 2026-10-24 검수)
    var verdict = !vs ? ['warn', (f === undefined && FZFAIL[fzKey(a)] ? '상신 때 검증 결과를 불러오지 못했어요' : f === undefined ? '검증 결과를 불러오는 중이에요' : '검증 결과를 아직 받지 못했어요') + '. ‘PDF\u00a0다운로드’로 문서를 열어 확인해 주세요.']
      : nBad ? ['bad', asApprover
        ? '확인이 필요해요. ' + (noRcpTxt ? '영수증 없음(' + noRcpTxt + ') 등 ' : '') + '문서의 불일치\u00a0항목을 보고 결재해 주세요.'
        : '검증에서 맞지 않는 곳' + (noRcpTxt ? '(영수증 없음 ' + noRcpTxt + ')' : '') + '이 있어요. 결재자도 문서에서 함께 봐요.']   // 상신한 본인에게는 본인용 문구(2026-10-16 3차)
      : nWarn ? ['warn', '대체로 정상이에요. ' + warnTail(items, vs, asApprover) + '.']
      : ['ok', '금액·검증 모두 이상 없어요.' + (myTurn(a) ? ' 문서를 열지 않고 승인해도 돼요.' : '')];   // 「열지 않고 승인」은 지금 결재할 분에게만

    return '<div class="abrief ' + verdict[0] + '">' +
      '<div class="abv"><span class="abi">' + (verdict[0] === 'ok' ? '✓' : '!') + '</span><b>' + esc(verdict[1]) + '</b></div>' +
      '<div class="abgrid">' +
      '<div class="abf"><span class="k">청구 금액</span><b>' + won(cost) + '</b><span class="sub">유류비 ' + won(s.fuel) + ' · 통행료 ' + won(s.toll) + ' · 주차비 ' + won(s.parking) + '</span></div>' +
      // 운행은 업무 운행을 먼저(2026-10-20 — 금액이 업무 운행만이라). 고정본에 업무 건수가 없으면 업무 거리 · 전체 건수
      (s.biz_km != null && s.biz_trips == null
        ? '<div class="abf"><span class="k">업무 운행</span><b>' + C.km(s.biz_km) + '<small>km</small></b><span class="sub">전체 운행 ' + n0(s.trips) + '건 · ' + C.km(s.km) + 'km</span></div>'
        // 「(전체 M건)」은 아랫줄 — 굵은 17px 한 줄로 두면 1280~1366 폭에서 옆 칸(전월 대비 「▼ ₩…」) 위로 넘쳤다(2026-10-20 V3 B3)
        : (function () {
          var tt = C.snapTrips ? C.snapTrips(s) : n0(s.trips) + '건', mm = /^(.*) \((전체 [^)]*)\)$/.exec(tt);
          return '<div class="abf"><span class="k">운행</span><b class="abwrap">' + esc(mm ? mm[1] : tt) + '</b>' + (mm ? '<span class="sub">' + esc(mm[2]) + '</span>' : '') + '</div>';
        })()) +
      cmp +
      // 금액 규칙 v3(version 3) — ev_* 는 운행 금액이 없는 날 영수증으로 채운 금액, no_trip_* 는 운행 없는 날이라 정산에서 뺀 영수증.
      //   예전(version 2)은 영수증을 모두 더한 금액이라 문구가 다르다.
      //   2026-10-16 3차: 채운 금액이 0 이면(운행에 금액이 이미 있어 영수증은 대조만 한 경우) 「영수증으로 채운 금액 ₩0」이
      //   영수증을 안 쳐 준 것처럼 읽혔다 — 0 이면 그 칸은 빼고, 운행 없는 영수증이 있을 때만 그것을 따로 적는다.
      ((s.version || 1) >= 3
        ? ((Number(s.ev_parking) || 0) + (Number(s.ev_toll) || 0) > 0
          ? '<div class="abf"><span class="k">영수증으로 채운 금액</span><b>' + won((Number(s.ev_parking) || 0) + (Number(s.ev_toll) || 0)) +
            (s.ev_n ? ' <small>' + n0(s.ev_n) + '장</small>' : '') + '</b><span class="sub">운행에 금액이 없던 날 · 주차비 ' + won(s.ev_parking || 0) + ' · 통행료 ' + won(s.ev_toll || 0) +
            (Number(s.no_trip_n) > 0 ? '</span><span class="sub abwarn">운행 없는 영수증 ' + n0(s.no_trip_n) + '장 ' + won(s.no_trip_amt || 0) + ' 정산 제외' : '') + '</span></div>'
          : Number(s.no_trip_n) > 0
            ? '<div class="abf"><span class="k">운행 없는 영수증</span><b>' + n0(s.no_trip_n) + '<small>장</small></b><span class="sub abwarn">' + won(s.no_trip_amt || 0) + ' 정산 제외</span></div>'
            : '')
        : '<div class="abf"><span class="k">주차·통행 영수증</span><b>' + (s.ev_n == null ? '—' : n0(s.ev_n) + '<small>장</small>') + '</b><span class="sub">주차비 ' + won(s.ev_parking || 0) + ' · 통행료 ' + won(s.ev_toll || 0) + ' 포함</span></div>') +
      '</div>' +
      '<div class="abchk">' + checks.map(function (c) { return '<span class="ck ' + c[0] + '">' + (c[0] === 'ok' ? '✓' : '!') + ' ' + esc(c[1]) + '</span>'; }).join('') + '</div>' +
      (items.length ? '<ul class="abitems">' + items.slice(0, 4).map(function (i) {
        // 결재하는 분에게는 상신자가 할 일(내용)을 빼지만, 영수증 없는 날(R06)은 그날 날짜·금액만 보인다.
        //   하이패스 영수증 원본 없는 날(R15, 2026-10-23)도 같은 꼴 — 날짜·금액과 합계만(「… 다시 올려 주세요」는 상신자 몫)
        var days = asApprover && (i.code === 'R06' || i.code === 'R15') ? noRcpDays(i.detail) : '';
        // 통행료 미확정(R02)도 결재하는 분에게 그날과 「0원으로 정산」을 보인다(2026-10-16 6차 — 「모두 확정」으로 보이던 건)
        //   날짜 목록만 — 서버 문구 「… 업무 운행입니다: 10.03, 10.05. 냈으면 …」(2026-10-21 다듬기 뒤 목록 뒤에 할 일이 붙는다 · 예전 「…: 10.03, 10.05」도 같은 답)
        if (asApprover && i.code === 'R02') { var ud = /:\s*((?:\d{2}\.\d{2}(?:, )?)+(?: 외 \d+건)?)/.exec(String(i.detail || '')); days = (ud ? ud[1].trim() + ' 운행은 ' : '') + '0원으로 정산돼요.'; }
        // 상신한 분 본인 — 결재 중이라 다시 검증할 수 없다: 끝의 「다시 검증하면 …」은 뗀다(2026-10-21)
        var dt = noRecheck(i.detail);
        return '<li class="' + i.level + '"' + (i.code === 'R06' ? ' data-norcp="1"' : '') + '><b>' + esc(i.title || '') + '</b>' +
          (days ? ' — ' + esc(days) : dt && !asApprover ? ' — ' + esc(dt.slice(0, 110)) + (dt.length > 110 ? '…' : '') : '') + '</li>';
      }).join('') + (items.length > 4 ? '<li class="more">외 ' + n0(items.length - 4) + '건은 ‘검증’을 눌러 확인하세요.</li>' : '') +
        (asApprover ? '<li class="more">수정은 상신자가 해요. 고칠 곳이 있으면 반려하고 사유를 적어 주세요.</li>' : '') + '</ul>' : '') +
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
      if (!window.PDFLib || !window.fontkit || !window.SheetPdf) throw new Error('PDF 도구를 불러오지 못했어요');
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

  /** 저장소 파일을 바이트 그대로 받는다(하이패스 영수증 원본 PDF — 공개 bucket evidence 의 <아이디>/hipass/…pdf, 2026-10-23). 못 받으면 null. */
  function loadRaw(path) {
    var url = C.SB + '/storage/v1/object/public/evidence/' + String(path).split('/').map(encodeURIComponent).join('/');
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(function (b) { return new Uint8Array(b); }).catch(function () { return null; });
  }

  var PDF_URLS = [], PDF_JOB = null;
  /** 문서 상태 표시(meta.mark) 별 결과 창 안내문. */
  var MARK_NOTE = {
    preview: '상신 전 미리보기라 쪽마다 <b>미리보기</b> 표시가 있어요. 결재가 끝나면 <b>결재 완료 문서</b>를 다운로드할 수 있어요.',
    pending: '상신할 때의 자료로 만든 문서예요. 결재가 끝나기 전이라 쪽마다 <b>결재 중</b> 표시가 있어요.',
    rejected: '반려된 문서예요. 쪽마다 <b>반려</b> 표시가 있어요.',
    withdrawn: '회수한 문서예요. 쪽마다 <b>회수</b> 표시가 있어요.',
    '': '상신할 때의 자료로 만든 문서예요. <b>언제 다운로드해도 내용이 같아요</b>.'
  };
  /**
   * PDF 를 만들어 결과 창을 띄운다.
   *   o = { doc(기록부 재료), verify, meta{name,cycleName,docNo,mark}, title, sub, file, note(안내문 HTML),
   *         expect(상신 때 집계한 총액 — 문서 총계와 다르면 알린다) }
   */
  function pdfImgs(o) {
    var scanPaths = {}, SP = window.SheetPdf, doc = o.doc || {};
    // 근거 재료(ev, 2026-10-23)가 있으면 sheetpdf 가 실을 사진만 센다(계기판은 차마다 한 장 · 오린 사진 · 원본 장)
    (SP && SP.scanPaths ? SP.scanPaths(doc) : (doc.scans || []).map(function (s) { return s.path; })).forEach(function (p) { scanPaths[p] = 1; });
    var n = SP && SP.imagePaths ? SP.imagePaths(doc).length : Object.keys(scanPaths).length + (doc.photos || []).length;
    return { scanPaths: scanPaths, nImg: o.nImg != null ? o.nImg : n };
  }
  /** 운행기록부 PDF 한 권 — 결재 완료 한 사람 PDF · 결재 완료 묶음 · 상신 전 미리보기·결재 중 문서가 모두 이 길로 만든다(2026-10-23 「세 길 같은 결과」).
   *  서명 채우기 → 인쇄 준비(C.pdfPrep — 하이패스 영수증 줄 · 사진 판독 시각) → SheetPdf.build. onImg() 는 사진 하나 받을 때마다(진행 글).
   *  onPhotos(n) 은 실제로 받을 사진 수를 안 때 한 번(「PDF만」으로 뺀 사진을 뺀 수 — 진행 글 「… / n」, 2026-10-23). */
  function sheetBuild(doc, meta, verify, onImg, onPhotos) {
    var sp = pdfImgs({ doc: doc }).scanPaths;
    return (C.fillSigns ? C.fillSigns(doc) : Promise.resolve())
      .then(function () { return C.pdfPrep ? C.pdfPrep(doc) : doc; })
      .then(ensureLibs).then(function (lib) {
        var d = {}, k;
        for (k in doc) d[k] = doc[k];
        d.meta = meta; d.verify = verify || null;
        return window.SheetPdf.build(d, {
          PDFLib: lib.PDFLib, fontkit: lib.fontkit, fontRegular: lib.fontRegular, fontBold: lib.fontBold,
          loadImage: function (p) { return loadPhoto(p, sp[p] ? 2000 : 1500).then(function (b) { if (onImg) onImg(); return b; }); },
          onPhotos: onPhotos || null,
          loadFile: loadRaw,
          // 하이패스 영수증 원본 PDF 의 영수증 목록(웹 hipass.js — 올릴 때와 같은 해석기 · 인쇄 화면 PDF 는 pdf.js) — 사진 영수증이 그 PDF 에 있는지 맞춘다(「PDF만」 2026-10-23)
          parseHipass: function (bytes) {
            if (!window.Hipass || !window.Hipass.parsePdf) return Promise.resolve(null);
            return window.Hipass.parsePdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { pdfjs: C.loadPdfJs || null });
          },
          // 하이패스 영수증 원본의 쪽마다 영수증 통과 시각(「YYYY년MM월DD일HH시MM분」)과 합계 줄(「총 N건/X원」) — pdf.js 로 쪽 글자를 읽는다.
          //   영수증이 없는 쪽(합계 줄만·빈 쪽)은 싣지 않고, 줄을 그 영수증이 실제로 있는 쪽에 놓는다(2026-10-23 사용자 「불필요한 용지」).
          //   못 읽으면 null — 그때는 모든 쪽을 싣는다.
          hipassPages: function (bytes) {
            if (!C.loadPdfJs) return Promise.resolve(null);
            return Promise.resolve(C.loadPdfJs()).then(function (pdfjs) {
              return pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
            }).then(function (doc) {
              var out = [], chain = Promise.resolve();
              var page = function (i) {
                return doc.getPage(i).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
                  var t = tc.items.map(function (it) { return it.str || ''; }).join('').replace(/\s+/g, '');
                  var dts = [], re = /(\d{4})년(\d{1,2})월(\d{1,2})일(\d{1,2})시(\d{1,2})분/g, m;
                  var p2 = function (v) { return ('0' + v).slice(-2); };
                  while ((m = re.exec(t))) dts.push(m[1] + '-' + p2(m[2]) + '-' + p2(m[3]) + ' ' + p2(m[4]) + ':' + p2(m[5]));
                  var tm = /총:?(\d+)건\/?([\d,]+)원/.exec(t);
                  out.push({ n: dts.length, dts: dts, total: tm ? { n: +tm[1], sum: +tm[2].replace(/,/g, '') } : null });
                });
              };
              for (var i = 1; i <= doc.numPages; i++) (function (i) { chain = chain.then(function () { return page(i); }); })(i);
              return chain.then(function () { try { doc.destroy(); } catch (e) { } return out; });
            }).catch(function () { return null; });
          }
        });
      });
  }
  /**
   * PDF 바이트만 만든다(창을 건드리지 않는다). makePdf(「결재 문서 PDF」)와 결재 카드 미리보기(2026-10-12)가
   * 같은 길로 만든다 — 미리보기가 단추로 받는 문서와 달라질 수 없게. note(t) 는 진행 글(없어도 된다).
   */
  function buildPdf(o, note) {
    var nImg = pdfImgs(o).nImg, loaded = 0;
    note = note || function () { };
    if (!o.build) {
      note(nImg ? '사진을 불러오는 중… 0 / ' + nImg : 'PDF를 만드는 중…');
      // 받을 사진 수는 원본을 읽은 뒤에 정해진다(「PDF만」) — 그때 분모를 고친다
      return sheetBuild(o.doc, o.meta, o.verify, function () { loaded++; note('사진을 불러오는 중… ' + loaded + ' / ' + nImg); },
        function (n) { nImg = n; note(n ? '사진을 불러오는 중… ' + loaded + ' / ' + n : 'PDF를 만드는 중…'); });
    }
    // 결재란 서명(올린 서명 · 이름 도장)을 먼저 채운다.
    return (C.fillSigns ? C.fillSigns(o.doc) : Promise.resolve()).then(ensureLibs).then(function (lib) {
      note(nImg ? '사진을 불러오는 중… 0 / ' + nImg : 'PDF를 만드는 중…');
      return o.build(lib, function (p) {
        return loadPhoto(p, 1500).then(function (b) { loaded++; note('사진을 불러오는 중… ' + loaded + ' / ' + nImg); return b; });
      });
    });
  }
  /** 하이패스 근거를 못 넣은 까닭 한 줄(sheetpdf issues 'hipass') — 「원본 PDF 1개 · 원본 없음 3줄 · 원본 확인 못 한 운행 2건 · 영수증 줄 못 받은 운행 2건」.
   *  원본 PDF = 경로는 있는데 싣지 못한 원본 파일(못 받음·지문 다름·남의 폴더) · 원본 없음 = 원본 경로가 없는 하이패스 줄(2026-10-23) ·
   *  원본 확인 못 한 운행 = 인쇄 준비가 지금 운행을 받지 못해 원본이 있는지 모르는 결재본 운행(2026-10-23 검토 — 관리자가 아닌 결재자 등).
   *  원본 파일 글에는 자료의 경로가 그대로 들어간다 — 세는 글은 처음부터 끝까지 맞춰 본다(경로 글자로 숫자를 꾸밀 수 없게). 「이용내역」은 앞 판 sheetpdf.js(캐시). */
  function hipWhy(list) {
    var NO = /^하이패스 영수증 원본 없음 (\d+)줄$/, UNK = /^하이패스 영수증 원본을 확인하지 못한 운행 (\d+)건$/;
    var noOrig = list.map(function (i) { return NO.exec(i.msg || ''); }).filter(Boolean)[0];
    var unk = list.map(function (i) { return UNK.exec(i.msg || ''); }).filter(Boolean)[0];
    var files = list.filter(function (i) { var s = i.msg || ''; return /원본/.test(s) && !NO.test(s) && !UNK.test(s); }).length;
    var m = list.map(function (i) { return /^하이패스 (?:영수증|이용내역) 줄을 받지 못한 운행 (\d+)건$/.exec(i.msg || ''); }).filter(Boolean)[0];
    return [files ? '원본 PDF ' + files + '개' : '', noOrig ? '원본 없음 ' + noOrig[1] + '줄' : '',
      unk ? '원본 확인 못 한 운행 ' + unk[1] + '건' : '', m ? '영수증 줄 못 받은 운행 ' + m[1] + '건' : ''].filter(Boolean).join(' · ');
  }
  function makePdf(o) {
    // o.nImg·o.build·o.stat·o.okAttr — 다른 문서(개인경비 지출결의)도 같은 창·같은 확인 순서로 만든다(2026-10-07).
    var nImg = pdfImgs(o).nImg;
    C.openPanel(o.title, o.sub,
      '<div class="pdfwait"><div class="spin"></div><div id="pdfNote" role="status">PDF를 만드는 중…</div>' +
      '<div class="dim" style="margin-top:6px">' + (nImg ? '사진 ' + n0(nImg) + '장을 넣어요. ' : '') +
      '처음에는 글꼴을 다운로드하느라 조금 걸려요.</div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
    // ★ 만드는 데 몇 초~수십 초 걸린다. 그 사이 창을 닫고 다른 창(운행 추가 등)을 열었으면
    //   결과로 그 창을 덮어쓰면 안 된다 — 이 작업이 띄운 '만드는 중' 줄이 아직 있을 때만 쓴다.
    var job = PDF_JOB = {};
    var mine = function () { return PDF_JOB === job && !!$('pdfNote') && $('panel').classList.contains('open'); };
    var note = function (t) { var el = $('pdfNote'); if (el && PDF_JOB === job) el.textContent = t; };
    return buildPdf(o, note).then(function (res) {
      if (!mine()) return res;
      var blob = new Blob([res.bytes], { type: 'application/pdf' });
      PDF_URLS.forEach(function (u) { URL.revokeObjectURL(u); });
      var url = URL.createObjectURL(blob); PDF_URLS = [url];
      var mb = (blob.size / 1e6).toFixed(1);
      // 자체 검사 — 칸을 넘친 글자·못 불러온 사진·글꼴에 없는 글자
      var over = res.issues.filter(function (i) { return i.kind === 'overflow' || i.kind === 'tiny'; });
      var img = res.issues.filter(function (i) { return i.kind === 'image'; });
      var gly = res.issues.filter(function (i) { return i.kind === 'glyph'; });
      var cut = res.issues.filter(function (i) { return i.kind === 'cut'; });      // 개인경비 증빙 설명을 「…」로 줄인 곳
      var hip = res.issues.filter(function (i) { return i.kind === 'hipass'; });   // 하이패스 영수증 원본 PDF·줄을 못 받음 · 원본 없는 줄 · 원본을 확인하지 못한 운행(2026-10-23)
      var chk = '';
      if (!over.length && !img.length && !gly.length && !cut.length && !hip.length) {
        chk = '<div class="pdfok">' + ic('check', 15) + '<span>문서를 확인했어요. 잘린 글자나 빠진 사진이 없어요.</span></div>';
      } else {
        chk = '<div class="awarn">' + ic('alert', 15) + '<span>' +
          [over.length ? '글자가 칸에 꽉 찬 곳 ' + over.length + '곳(' + esc(over[0].page + '쪽') + ' 등)' : '',
            img.length ? '불러오지 못한 사진 ' + img.length + '장' : '',
            gly.length ? '글꼴에 없어 ? 로 바꾼 글자 ' + gly.length + '종' : '',
            cut.length ? '길어서 ‘…’로 줄인 증빙 설명 ' + cut.length + '곳(' + esc(cut[0].page + '쪽') + ' 등)' : '',
            hip.length ? '확인 필요: 하이패스 영수증 근거를 다 넣지 못함(' + esc(hipWhy(hip)) + ')' : ''].filter(Boolean).join(' · ') +
          '. 열어서 확인해 주세요.</span></div>';
      }
      // 문서 총계(장별 총계의 합)가 상신 때 서버가 집계한 금액과 같은가 — 다르면 결재 카드와 문서가 다른 숫자를 말한다.
      var sum = (res.totals || []).reduce(function (s, t) { return s + (Number(t && t.all) || 0); }, 0);
      // 1원 차이도 알린다(2026-10-08, 예전 > 1 은 1원 차이를 숨겼다).
      if (o.expect != null && isFinite(Number(o.expect)) && Math.round(sum) - Math.round(Number(o.expect)) !== 0) {
        chk += '<div class="awarn">' + ic('alert', 15) + '<span>문서 총계 <b>' + C.won(sum) + '</b> · ' + (o.expectName || '상신 때 집계한 금액') + ' <b>' +
          C.won(o.expect) + '</b>. ' + n0(Math.abs(Math.round(sum) - Math.round(Number(o.expect)))) +
          '원 차이가 있어요. 관리자에게 알려 주세요.</span></div>';
      }
      var mk = o.meta.mark || '';
      // 실제로 실은 사진 수(「PDF만」으로 뺀 사진은 빼고 — 운행기록부 PDF 만 돌려준다) · 개인경비·법인카드는 예전처럼
      if (res.photos != null && o.nImg == null) nImg = res.photos;
      // 결재 완료본에 상신 뒤 덧붙인 하이패스 원본이 실렸으면 「언제 받아도 같은 내용」 대신 그 사실을 말한다(2026-10-23 검토)
      var anote = o.note || MARK_NOTE[mk] || MARK_NOTE[''];
      if (!o.note && !mk && res.late) anote = '상신할 때의 자료로 만들어 금액과 운행은 <b>언제 다운로드해도 같아요</b>. ' +
        '상신 뒤에 첨부한 하이패스 영수증 원본 ' + n0(res.late) + '개는 <b>덧붙임</b> 표시와 함께 실려 있어요.';
      // 반려·회수 뒤 다시 올리는 것이면 「다시 상신」(상신 단추 이름과 같게, 2026-10-16 3차)
      //   단추 이름에 ①② 를 달지 않는다 — 단계 카드의 ①②③(검증·미리보기·상신)과 번호가 겹쳤다(2026-10-20 V3 다듬기)
      var okLab = '확인 완료 → ' + (o.again ? '다시 상신' : '상신');
      $('pBody').innerHTML = '<div class="pdfdone"><div class="big">' + n0(res.pages) + '<small>쪽</small></div>' +
        '<div class="dim">' + mb + ' MB · ' + (typeof o.stat === 'function' ? o.stat(res) : o.stat || '운행기록부 ' + n0((o.doc.sheets || []).length) + '장') +
        (o.verify ? ' · 검증 결과' : '') + (nImg ? ' · 영수증 사진 ' + n0(nImg) + '장' : '') + '</div>' + chk +
        '<div class="anote">' + anote + '</div></div>';
      $('pFoot').innerHTML = C.backBtn() + '<span style="flex:1"></span><button class="btn" data-close>닫기</button>' +
        '<a class="btn" href="' + url + '" download="' + esc(o.file) + '">' + ic('dl', 14) + '다운로드</a>' +
        '<a class="btn pri' + (o.okKey ? ' cta' : '') + '" id="pdfOpen" href="' + url + '" target="_blank" rel="noopener">' +
          (o.okKey ? '열어서 보기' : '열기 · 인쇄') + '</a>' +
        // 상신 전 미리보기면 '확인했다'를 받고 결재 상신으로 넘긴다(검증 → PDF 확인 → 상신).
        // 2026-10-07: 문서를 먼저 열어 봐야 「확인 완료」가 눌린다(열기·내려받기 중 하나).
        (o.okKey ? '<button class="btn" id="pdfOkBtn" ' + (o.okAttr || 'data-pdfok') + '="' + esc(o.okKey) + '" disabled title="먼저 ‘열어서 보기’로 문서를 확인해 주세요.">' + okLab + '</button>' : '');
      // 결재 완료본이면 「내려받기」(pdf) · 「열기 · 인쇄」(print)를 누를 때 출력 기록을 남긴다(기다리지 않는다, 2026-10-14).
      if (o.prints && C.prints) C.prints.bindOut($('pFoot'), o.prints.kind, o.prints.ids, url);
      if (o.okKey) {
        $('pBody').insertAdjacentHTML('beforeend', '<div class="hpnote" id="pdfStepNote" style="margin-top:14px">' + ic('alert', 15) +
          '<span><b>열어서 보기</b>로 문서를 끝까지 확인한 뒤 <b>' + okLab + '</b>을 눌러 주세요.</span></div>');
        var unlock = function () {
          var b = $('pdfOkBtn'); if (!b || !b.disabled) return;
          b.disabled = false; b.removeAttribute('title'); b.classList.add('pri', 'cta');
          var a = $('pdfOpen'); if (a) a.classList.remove('pri', 'cta');
          var nt = $('pdfStepNote');
          if (nt) { nt.classList.add('ok'); nt.innerHTML = ic('check', 15) + '<span>문서를 열었어요. 확인했으면 <b>' + okLab + '</b>을 눌러 주세요.</span>'; }
        };
        Array.prototype.forEach.call($('pFoot').querySelectorAll('a[href="' + url + '"]'), function (a) {
          a.addEventListener('click', unlock); a.addEventListener('auxclick', unlock); a.addEventListener('contextmenu', unlock);
        });
      }
      var op = $('pdfOpen'); if (op) { try { op.focus(); } catch (e) { } }
      return res;
    }).catch(function (e) {
      if (mine()) $('pBody').innerHTML = '<div class="awarn">' + ic('alert', 15) +
        '<span>' + esc(failMsg('PDF를 만들지 못했어요', e, '새로고침한 뒤 다시 해 주세요.')) + '</span></div>';
      throw e;
    });
  }

  function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_'); }

  /** 지금 자료로 만든다. 상신 전이면 미리보기, 고정본이 없는 옛 결재 건이면 그 사정을 문서에 적는다. */
  function pdfLive(who) {
    var S = C.state(), u = who || C.myName(), cyc = S.CYCKEY;
    var ap = C.apprOf(u, cyc);
    var doc = C.pdfDocFor(u, ap);
    if (!doc.any) { C.toast('이번 기간에 담을 운행이나 영수증이 없어요.', true); return; }
    var k = keyOf(u, cyc);
    // 결재 중·완료인데 지금 자료로 만드는 것은 '상신 때 저장한 자료가 없는 옛 건'뿐이다.
    var old = ap && (ap.status === 'submitted' || ap.status === 'approved');
    var done = old && ap.status === 'approved';
    var mark = done ? '' : old ? 'pending' : 'preview';
    // 지금 자료로 만드는 문서도 총계를 견준다. 옛 결재 건은 결재 카드 금액(상신 때 집계)과, 미리보기는 화면 합계와.
    var snap0 = (ap && ap.snapshot) || {};
    // 지금 자료는 금액 규칙 v3 로 만든다 — 같은 v3 로 굳힌 집계(version 3)와만 견준다(예전 v2 집계와는 기준이 다르다).
    var expect = old ? (snap0.version >= 3 ? snap0.cost : null) : C.expectCost(u);
    var go = function () {
      var row = ROWS[k];
      var v = row ? { ranAt: whenText(row.created_at), ai: !!row.ai, summary: row.summary, items: (row.result || {}).items || [] } : null;
      var now = whenText(new Date().toISOString());
      makePdf({
        // 결재 완료본에는 검증 결과 쪽을 붙이지 않는다 — 고정본이 없는 옛 건도 frozenOpts 와 같게(2026-10-14)
        doc: doc, verify: done ? null : v,
        title: done ? '결재 완료 문서' : old ? '결재 문서' : 'PDF 미리보기',
        sub: C.nameOf(u) + ' · ' + cycName(S.CYCKEY),
        file: '운행기록부_' + safeName(C.nameOf(u)) + '_' + cyc + (done ? '_결재완료' : old ? '_결재중' : '_미리보기') + '.pdf',
        note: old ? '상신 때 저장한 자료가 없는 예전 건이라 <b>지금 자료</b>로 만들었어요.' : null,
        expect: expect, expectName: old ? '상신 때 집계한 금액' : '화면 합계',
        okKey: !old && u === C.myName() ? k : '',
        again: !!(ap && (ap.status === 'rejected' || ap.status === 'withdrawn')),     // 반려·회수 뒤면 「확인 완료 → 다시 상신」
        prints: done ? { kind: 'driving', ids: [ap.id] } : null,
        meta: { name: C.nameOf(u), cycleName: cycName(S.CYCKEY), mark: mark,
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
  var NO_FZ = '상신 때 저장한 자료가 없는 예전 건이에요. 그 달의 ‘정산·엑셀’ 화면에서 다운로드해 주세요.';

  /** 고정본으로 결재 문서(결재 중이면 「결재 중」 표시, 끝났으면 완료본). */
  function pdfFrozen(id) {
    var a = apprById(id);
    if (!a) { C.toast('결재 건을 찾지 못했어요.', true); return; }
    fetchFrozen(a).then(function (fz) {
      if (!fz) { if (liveOk(a)) { C.bizOnly(); pdfLive(a.username); } else C.toast(NO_FZ, true); return; }
      makePdf(frozenOpts(a, fz)).catch(function () { });
    }).catch(frozenFail);
  }
  /** 결재 카드 미리보기(2026-10-12) — 「결재 문서 PDF」와 같은 재료·같은 생성기로 바이트만. 고정본이 없으면 실패. */
  function previewBytes(id) {
    var a = apprById(id);
    if (!a) return Promise.reject(new Error('noappr'));
    return fetchFrozen(a).then(function (fz) {
      if (!fz) throw new Error('nofrozen');
      return buildPdf(frozenOpts(a, fz)).then(function (res) { return res.bytes; });
    });
  }
  /** 고정본 → 기록부·근거 재료. 사진 지문(driving_frozen.photo_meta — 상신 때 저장소의 etag·크기)을 근거 재료에 얹는다(같은 사진 가르기, 2026-10-23). */
  function frozenDoc(a, fz) {
    var doc = C.withFrozen(fz.data, function () { return C.pdfDocFor(a.username, a); });
    if (doc && doc.ev) doc.ev.photoMeta = fz.photo_meta && typeof fz.photo_meta === 'object' ? fz.photo_meta : null;
    return doc;
  }
  /** 고정본 → makePdf 재료(창 제목·파일 이름 포함). */
  function frozenOpts(a, fz) {
      var doc = frozenDoc(a, fz);
      var done = a.status === 'approved';
      var mark = done ? '' : a.status === 'submitted' ? 'pending' : a.status === 'rejected' ? 'rejected' : 'withdrawn';
      var cname = cycName(a.cycle);
      // 결재 완료본에는 검증 결과 쪽을 붙이지 않는다(2026-10-14 사용자 — 출력물엔 필요 없다). 결재 중 문서에는 그대로 — 결재자가 본다.
      var vv = done ? null : fz.verify || null;
      var name = (fz.data.user && fz.data.user.name) || C.nameOf(a.username);
      var snap = a.snapshot || {};
      return {
        doc: doc,
        verify: vv ? { ranAt: whenText(vv.ran_at), ai: !!vv.ai, summary: vv.summary, items: vv.items || [] } : null,
        title: done ? '결재 완료 문서' : mark === 'pending' ? '결재 문서' : '상신했던 문서', sub: name + ' · ' + cname,
        file: '운행기록부_' + safeName(name) + '_' + a.cycle +
          ({ '': '_결재완료', pending: '_결재중', rejected: '_반려', withdrawn: '_회수' }[mark]) + '.pdf',
        // 영수증까지 넣어 집계한 것은 version 2 부터다. 그 전 것은 기준이 달라 견주지 않는다.
        expect: snap.version >= 2 ? snap.cost : null,
        prints: done ? { kind: 'driving', ids: [a.id] } : null,
        // closedAt — 결재 완료 시각(쪽 아래 「완료 …」와 같은 값). 상신 뒤 덧붙인 하이패스 원본이 결재 완료 뒤인지 가른다(sheetpdf lateText, 2026-10-23)
        meta: { name: name, cycleName: cname, mark: mark, closedAt: done ? a.closed_at || null : null,
          docNo: '결재 #' + a.id + ' · 상신 ' + whenText(fz.frozen_at) + (done && a.closed_at ? ' · 완료 ' + whenText(a.closed_at) : '') }
      };
  }

  function xlsxFrozen(id) {
    var a = apprById(id);
    if (!a) return;
    // 파일 이름 꼬리 — PDF(frozenOpts)·법인카드와 같은 짝(반려·회수된 건이 「_결재중」으로 나가지 않게, 2026-10-14)
    var tag = { approved: '_결재완료', submitted: '_결재중', rejected: '_반려', withdrawn: '_회수' }[a.status] || '_결재중';
    var snap = a.snapshot || {};
    var save = function (files) {
      if (!files.length) { C.toast('담을 운행이나 영수증이 없어요.', true); return; }
      files.forEach(function (f, i) {
        setTimeout(function () { C.saveBlob(f.bytes, f.name.replace(/\.xlsx$/, tag + '.xlsx')); }, i * 400);
      });
      // PDF 와 같은 대조: 장별 총계의 합이 상신 때 집계와 다르면 말없이 내보내지 않는다.
      // 결재 완료본 엑셀 — 출력 기록(차량별 여러 파일이어도 한 번, 기다리지 않는다)
      if (a.status === 'approved' && C.prints) C.prints.log('driving', a.id, 'xlsx');
      var warn = C.sheetSumWarn(files, snap.version >= 2 ? snap.cost : null);
      if (warn) C.toast(warn, true);
      else C.toast(files.length > 1 ? '차량별 엑셀 ' + files.length + '개를 다운로드해요.' : '엑셀을 다운로드해요.');
    };
    fetchFrozen(a).then(function (fz) {
      if (!fz) { if (liveOk(a)) { C.bizOnly(); save(C.xlsxFiles(a.username, a)); } else C.toast(NO_FZ, true); return; }
      save(C.withFrozen(fz.data, function () { return C.xlsxFiles(a.username, a); }));
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
        var w = WARN[u + '|' + S.CYCKEY] || '';   // 사진 판독 경고는 이 알림에 이어 붙인다(V3 B6)
        C.toast(C.nameOf(u) + ' 님 운행일지를 검증했어요' + (row ? '(' + sumText(row.summary) + ')' : '') + '.' + (w ? ' ' + C.endDot(w) : ''), !!w);
      }).catch(function (er) { C.toast(failMsg('검증하지 못했어요', er, '잠시 후 다시 눌러 주세요.'), true); })
        .then(function () { RUN = { busy: false, note: '', who: '' }; C.render(); });
      return;
    }
    if ((el = e.target.closest('[data-vshow]'))) {
      var S2 = C.state(), fzv = FZV[keyOf(el.dataset.vshow, S2.CYCKEY)], r = fzv || ROWS[keyOf(el.dataset.vshow, S2.CYCKEY)];   // 상신 때 굳힌 결과가 먼저
      if (r) showItems(C.nameOf(el.dataset.vshow) + ' 검증 결과', cycName(S2.CYCKEY), r, false, !!fzv);
      return;
    }
    if ((el = e.target.closest('[data-fzverify]'))) {
      var a = apprById(el.dataset.fzverify), f = a && FZSUM[fzKey(a)];
      if (f && f.verify) showItems(C.nameOf(a.username) + ' 검증 결과', cycName(a.cycle) + ' · 상신 시점', f.verify, a.username !== C.myName(), true);
      return;
    }
    if ((el = e.target.closest('[data-fzpdf]'))) { pdfFrozen(el.dataset.fzpdf); return; }
    if (e.target.closest('[data-finpdf]')) { finBundle(); return; }
    if (e.target.closest('[data-fincsv]')) { finCsv(); return; }
    if ((el = e.target.closest('[data-pdfok]'))) {
      setPreviewed(el.dataset.pdfok, true);
      C.closePanel();
      if (C.state().VIEW !== 'verify') C.go('verify'); else C.render();
      // 이름대로 바로 상신 창을 연다(2026-10-15 매뉴얼 로봇: 창만 닫혀 한 번 더 눌러야 했다). 아직 못 누르는 상태면 그 단추로 데려간다.
      setTimeout(function () { var b = document.getElementById('btnOpenSubmit'); if (b) { try { if (!b.disabled) b.click(); else { b.focus(); b.scrollIntoView({ block: 'center', behavior: (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') }); } } catch (er) { } } }, 60);
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
  // 고르기 · 이 팀 모두 고르기 · 이름으로 찾기는 화면을 다시 그리지 않고 그 자리에서 맞춘다(C.fin — driving-app.js, 2026-10-23).
  //   예전엔 고를 때마다 C.render() 로 화면 전체를 다시 그려 22줄 넘는 표의 안쪽 스크롤이 맨 위로 갔다(관리자 신고).
  //   C.fin 이 없는 앞 판 driving-app.js 와 섞여 실려도(배포 직후 캐시) 이 모듈(검증·상신 화면 포함)이 죽지 않게 — 그때는 예전 그대로(finOld).
  var FIN = C.fin || finOld();
  FIN.reg('driving', { sel: function () { return FINSEL; }, busy: function () { return !!FINJOB; } });
  /** C.fin 이 없을 때 — 팀 칸·찾기 없이 예전처럼(묶음은 이름 순, 고르면 다시 그림 — 아래 change 처리기). 개인경비·법인카드도 같은 모양. */
  function finOld() {
    var nil = function () { return ''; };
    return { old: true, reg: nil, row: nil, box: nil, all: nil, grp: nil, bar: nil, none: nil, fileTag: nil, sync: nil, match: function () { return true; },
      order: function (l, gu) { return { list: l.slice().sort(function (x, y) { return C.nameOf(gu(x)).localeCompare(C.nameOf(gu(y)), 'ko'); }), team: '' }; } };
  }
  /** 보이는 줄 중 고른 것(2026-10-14) — 「출력 안 한 것만」으로 숨은 줄은 고른 채 남아 있어도 세지·묶지 않는다. */
  function finPicked(rows) { return rows.filter(function (a) { return FINSEL[a.id]; }); }
  /** 보이는 줄인가 — 「출력 안 한 것만」(2026-10-14) + 이름으로 찾기(2026-10-23). 고른 수·묶어 받기가 화면과 같은 판정. */
  function finVisible(a) { return (!C.prints || C.prints.keep('driving', a)) && FIN.match('driving', a.username); }
  /** 결재 완료 출력 세 표가 같이 쓰는 앞 열(2026-10-19 사용성 2차 #12) */
  var FIN_HEAD = '<th>파트·센터</th><th>이름</th><th>상태</th>';
  /** 상신 때 통행료 미확정 수(snapshot.toll_unknown) */
  function unkOf(a) { return Number((a && a.snapshot || {}).toll_unknown) || 0; }
  function viewFinal() {
    var S = C.state();
    if (!S.LOADED) return C.head('결재 완료 문서') + C.skeleton();
    if (C.isMulti()) return C.singleOnly('결재 완료 문서', '결재 완료 문서');
    var cyc = S.CYCKEY, cname = cycName(S.CYCKEY);
    // 「보는 범위」(사업부·팀·파트) 안의 사람만.
    var list = S.APPR.filter(function (a) { return a.cycle === cyc && C.orgMatch(a.username); });
    var done = list.filter(function (a) { return a.status === 'approved'; })
      .sort(function (x, y) { return C.nameOf(x.username).localeCompare(C.nameOf(y.username), 'ko'); });
    var going = list.filter(function (a) { return a.status === 'submitted'; });
    var back = list.filter(function (a) { return a.status === 'rejected' || a.status === 'withdrawn'; });
    // 챙겨야 할 사람 = 이 결재 기간에 **운행이 있는** 사람만(2026-10-07 사용자 — 영수증만 있는 사람·운행 없는 사람은 뺀다).
    var r = keyRange(S.CYCKEY), has = {};
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
    // 「출력 안 한 것만」(2026-10-14) — 표에 보이는 줄만 거른다(위 숫자·합계는 그대로 결재 완료 전체).
    //   고른 수·전체 선택·묶어 받기도 보이는 줄만 센다 — 숨은 줄이 묶음에 몰래 들어가지 않게.
    var shown = C.prints ? done.filter(function (a) { return C.prints.keep('driving', a); }) : done;
    // 표에는 shown 을 다 그리고 이름 찾기에 안 맞는 줄은 C.fin 이 그 자리에서 숨긴다(치는 동안 다시 그리지 않게) — 고른 수는 보이는 줄만.
    var vis = shown.filter(finVisible), nSel = finPicked(vis).length;

    var nRej = back.filter(function (a) { return a.status === 'rejected'; }).length, nWd = back.length - nRej;
    var h = C.head('결재 완료 문서', esc(cname) + ' · 결재가 끝난 운행기록부를 모아 출력해요.');
    var fact = function (k, v, sub, alert) {
      return '<div class="fact"><div class="k">' + esc(k) + '</div><div class="v' + (alert ? ' alert' : '') + '">' + v + '</div>' +
        '<div class="sub">' + esc(sub || '') + '</div></div>';
    };
    h += '<div class="hero fade"><div class="eyebrow"><span class="dot' + (done.length && !going.length && !notYet.length ? ' ok' : '') + '"></span>' +
      esc(cname) + ' · ' + esc(keySpan(S.CYCKEY)) + '</div>' +
      '<p class="verdict">결재 완료 <em>' + n0(done.length) + '명</em> · ' + C.won(total) + '</p>' +
      '<div class="facts">' +
      // 2026-10-19 웹 사용성 1차: 「결재 완료」는 위 큰 제목이 말한다(숫자 칸에 또 있었다). 분류는 현황과 같은 넷 — 결재 완료·결재 중·반려·미상신.
      //   회수한 사람은 다시 올리기 전까지 미상신으로 센다(현황과 같게).
      fact('결재 중', n0(going.length) + '<small>명</small>', '결재자 차례를 기다리는 중', going.length > 0) +
      fact('반려', n0(nRej) + '<small>명</small>', '고쳐서 다시 상신해야 함', nRej > 0) +
      fact('상신 전', n0(notYet.length + nWd) + '<small>명</small>', nWd ? '이번 기간 운행이 있는데 상신 전(회수 ' + n0(nWd) + '명 포함)' : '이번 기간 운행이 있는데 상신 전', notYet.length + nWd > 0) +
      '</div></div>';

    // ── 결재 완료 — 출력 ──
    var tools = done.length
      ? '<button class="btn sm' + (nSel ? ' pri' : '') + '" data-finpdf data-finbtn="driving"' + (nSel && !FINJOB ? '' : ' disabled') + '>' + ic('dl', 13) +
        (nSel ? '고른 ' + n0(nSel) + '명 PDF 한 파일로' : 'PDF 한 파일로 묶기') + '</button>' +
        '<button class="btn sm" data-fincsv>' + ic('dl', 13) + '금액 요약표(CSV)</button>' +
        (C.prints ? C.prints.onlyBtn('driving') : '')
      : '';
    h += C.sect('결재 완료', n0(done.length) + '명', tools, done.length && !shown.length
      ? C.blank('출력 안 한 결재 완료 문서가 없어요.', '모두 한 번 이상 출력됐어요. ‘출력 안 한 것만’을 다시 누르면 전체가 보여요.', 'stamp')
      : done.length
      // 세 표(결재 완료·결재 중·챙겨야 할 사람)가 같은 열 순서 — 팀 묶음 + 파트·센터 · 이름 · 상태(2026-10-19 사용성 2차 #12).
      //   「전체 선택」은 표 머리 첫 칸(예전: 표 밖 단추 줄).
      // 2026-10-23: 표 위 이름 찾기 · 팀 머리 줄 「이 팀 모두 고르기」 · 고르기는 다시 그리지 않음(C.fin) · 다시 그려도 안쪽 스크롤 그대로(data-keep)
      ? FIN.bar('driving') + '<div class="panel"><div class="scroll" data-rows data-keep="fin"><table class="rcard ftab" data-fin="driving"><thead><tr>' +
        '<th class="fchk"><label class="finall"><input type="checkbox" id="finAll"' + FIN.all('driving') + (nSel && nSel === vis.length ? ' checked' : '') + '> 전체 선택</label></th>' +
        FIN_HEAD + '<th>날짜</th><th class="n">금액</th><th>결재선</th><th></th></tr></thead><tbody>' +
        C.orgGroups(shown, function (a) { return a.username; }, true).map(function (g) {
          return C.orgGroupRow(g, 8, '합계 <b>' + C.won(g.list.reduce(function (s2, a) { return s2 + (Number((a.snapshot || {}).cost) || 0); }, 0)) + '</b>', FIN.grp('driving', g)) +
            g.list.map(doneRow).join('');
        }).join('') + FIN.none(8) + '</tbody><tfoot><tr><td></td><td colspan="4">결재 완료 ' + n0(done.length) + '명 합계</td>' +
        '<td class="n total">' + n0(total) + '</td><td colspan="2"></td></tr></tfoot></table></div></div>'
      : C.blank('아직 결재가 끝난 건이 없어요.', '결재가 끝나면 여기에 모여요.', 'stamp'));
    function doneRow(a) {
          var p = S.USERS[a.username] || {};
          var line = (a.steps || []).map(function (s) { return C.stepText(s); }).join(' → ');   // 이름 직책 (칸) — 진행 줄·상신 창과 같은 직책(2026-10-16 5차)
          return '<tr' + FIN.row('driving', a.id, a.username, (a.snapshot || {}).cost) + '><td><input type="checkbox" data-finsel="' + a.id + '"' + FIN.box('driving', a.id) +
            (FINSEL[a.id] ? ' checked' : '') + ' aria-label="' + esc(C.nameOf(a.username)) + ' 고르기"></td>' +
            C.orgCell(a.username, true) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span></td>' +
            // 상태: 결재 완료 + 통행료 미확정 딱지(정산은 0원으로 끝났지만 알 수 있게 — 2026-10-19 사용성 2차) + 출력 딱지
            '<td><span class="st ok">결재 완료</span>' + (unkOf(a) ? ' <span class="unktag" title="통행료 미확정 ' + n0(unkOf(a)) + '건 — 0원으로 정산됨">미확정 ' + n0(unkOf(a)) + '</span>' : '') +
            (C.prints ? '<div class="prline">' + C.prints.badge('driving', a) + '</div>' : '') + '</td>' +
            // 1280 에서 출력 딱지가 길면(「출력 12회 · 마지막 … 이름」) 표가 칸보다 넓어 「정정 열기」가 밀려났다(2026-10-21 매뉴얼 로봇):
            //   개인경비·법인카드 표(2026-10-20 AU6-M3)와 같게 날짜는 「MM.DD HH:MM」(전체는 title) · 결재선은 두 줄에서 말줄임(전체는 title).
            //   PDF·엑셀·정정 열기 단추는 그대로 보인다(매뉴얼이 이 세 단추로 설명한다) — 딱지는 drv-prints.js 가 두 덩어리로 줄을 바꾼다.
            '<td class="dim" style="white-space:nowrap"' + (a.closed_at ? ' title="결재 완료 ' + esc(whenText(a.closed_at)) + '">' + esc(finWhen(a.closed_at)) : '>—') + '</td>' +
            '<td class="n total" data-l="금액">' + n0((a.snapshot || {}).cost) + '</td>' +
            '<td class="el dim" data-l="결재선" title="' + esc(line) + '"><span style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden">' + esc(line) + '</span></td>' +
            '<td class="n ract" style="white-space:nowrap"><button class="btn sm" data-fzpdf="' + a.id + '">PDF</button> ' +
            '<button class="btn sm" data-fzxlsx="' + a.id + '">엑셀</button> ' +
            // 정정 열기 · 관리자 반려 — 개인경비·법인카드 출력 화면과 같게(2026-10-14). 운행일지는 data-kind 없이(driving-app.js openApprAct 가 APPR 에서 찾는다).
            '<button class="btn sm" data-appr="reopen" data-id="' + a.id + '">정정 열기</button></td></tr>';
    }

    if (going.length) {
      h += C.sect('결재 중', n0(going.length) + '명', '', '<div class="panel"><div class="scroll" data-rows data-keep="fin-going"><table class="rcard ftab"><thead><tr>' +
        FIN_HEAD + '<th>날짜</th><th class="n">금액</th><th>현재 결재자</th><th></th></tr></thead><tbody>' +
        C.orgGroups(going, function (a) { return a.username; }, true).map(function (g) { return C.orgGroupRow(g, 7, '') + g.list.map(goingRow).join(''); }).join('') +
        '</tbody></table></div></div>');
    }
    function goingRow(a) {
          var cur = (a.steps || []).filter(function (s) { return s.seq === a.cur_seq; })[0] || {};
          return '<tr>' + C.orgCell(a.username, true) + '<td><span class="lead">' + esc(C.nameOf(a.username)) + '</span></td>' +
            '<td><span class="st warn">결재 중</span></td>' +
            '<td class="dim">' + (a.submitted_at ? '상신 ' + esc(whenText(a.submitted_at)) : '') + '</td>' +
            '<td class="n" data-l="금액">' + n0((a.snapshot || {}).cost) + '</td>' +
            '<td data-l="현재 결재자">' + esc(cur.approver ? C.stepText(cur) : '—') + '</td>' +
            '<td class="n ract"><button class="btn sm" data-appr="force_reject" data-id="' + a.id + '">관리자 반려</button></td></tr>';
    }
    if (back.length || notYet.length) {
      var todo = back.map(function (a) { return { u: a.username, st: a.status === 'rejected' ? '반려' : '상신 전(회수됨)', cls: a.status === 'rejected' ? 'bad' : 'warn' }; })
        .concat(notYet.map(function (u) { return { u: u, st: '상신 전', cls: 'warn' }; }));
      h += C.sect('챙겨야 할 사람', n0(todo.length) + '명', '',
        '<div class="panel"><div class="scroll" data-rows data-keep="fin-todo"><table class="rcard ftab"><thead><tr>' + FIN_HEAD + '<th class="n">이번 기간 운행</th><th>검증</th></tr></thead><tbody>' +
        C.orgGroups(todo, function (x) { return x.u; }, true).map(function (g) {
          return C.orgGroupRow(g, 5, '') + g.list.map(function (x) {
            var vr = ROWS[keyOf(x.u, cyc)], vs = vr && vr.summary;
            return '<tr>' + C.orgCell(x.u, true) + '<td><span class="lead">' + esc(C.nameOf(x.u)) + '</span></td>' +
              '<td><span class="st ' + x.cls + '">' + esc(x.st) + '</span></td>' +
              '<td class="n">' + n0(has[x.u] || 0) + '건</td>' +
              '<td>' + (vs ? sumChip(vs, true) : '<span class="dim">검증 전</span>') + '</td></tr>';
          }).join('');
        }).join('') + '</tbody></table></div></div>');
    }
    // 관리자 반려·정정 열기는 이 화면에만 있다(2026-10-15 2차 — 예전 「검증 현황」에서 옮겨 온 안내)
    h += '<div class="anote"><b>관리자 반려</b>는 결재자가 자리에 없어 결재가 멈췄을 때만 쓰고, 승인을 대신할 수는 없어요. 반려하면 잠금이 풀려 직원이 고쳐서 다시 상신할 수 있고, ' +
      '반려한 사람과 사유가 기록에 남아요.<br>' +
      '<b>정정 열기</b>는 결재가 끝난 뒤 고칠 것이 생겼을 때 써요. 잠금이 풀려 직원이 고쳐 다시 상신하면 결재선을 처음부터 다시 거치고, ' +
      '그때의 결재 완료 문서는 이력에 남아요.</div>';
    return h;
  }

  /** 고른 결재 완료 건들을 PDF 한 파일로 — 한 사람씩 고정본으로 만든 뒤 차례대로 이어 붙인다. */
  function finBundle() {
    var S = C.state();
    var ids = Object.keys(FINSEL);
    // 보이는 줄 중 고른 것만(출력 안 한 것만 · 이름으로 찾기) · 차례는 표에 보이는 차례 — 팀 → 파트·센터 → 이름(2026-10-23, 예전엔 이름 순만)
    var ord = FIN.order(ids.map(apprById).filter(function (a) { return a && a.status === 'approved' && finVisible(a); }), function (a) { return a.username; });
    var list = ord.list;
    if (!list.length || FINJOB) return;
    // ★ 한 번에 묶는 인원 상한(2026-10-07 검증로봇 R15) — 사진이 든 PDF 를 모두 메모리에 쌓았다가 합치므로
    //   전원(66명·사진 약 700장)을 한 번에 묶으면 브라우저 탭이 메모리 부족으로 꺼질 수 있다.
    var FIN_MAX = 20;
    if (list.length > FIN_MAX) {
      C.toast('한 번에 ' + FIN_MAX + '명까지 묶을 수 있어요(지금 ' + list.length + '명). 나눠서 골라 다운로드해 주세요.', true);
      return;
    }
    var job = FINJOB = { stop: false };
    var cname = cycName(S.CYCKEY);
    C.openPanel('결재 완료 문서 묶음 다운로드', cname + ' · ' + (ord.team ? ord.team + ' · ' : '') + n0(list.length) + '명',
      '<div class="pdfwait"><div class="spin"></div><div id="finNote" role="status">준비하는 중…</div>' +
      '<div class="dim" style="margin-top:6px">사람마다 사진을 넣어 만들어서, 인원이 많으면 몇 분 걸릴 수 있어요.</div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
    var note = function (t) { var el = $('finNote'); if (el) el.textContent = t; };
    // checks: 한 사람씩 받는 PDF 와 같은 자체 점검 — 문서 총계 ≠ 결재 금액, 못 불러온 사진(2026-10-06 검증로봇 5)
    var parts = [], skipped = [], checks = [], partIds = [];   // partIds — 묶음에 실제로 들어간 결재 건(출력 기록용)
    var one = function (i) {
      if (i >= list.length) return Promise.resolve();
      var a = list[i];
      note((i + 1) + ' / ' + list.length + ' · ' + C.nameOf(a.username) + ' 님 문서를 만드는 중…');
      return fetchFrozen(a).then(function (fz) {
        if (!fz) { skipped.push(C.nameOf(a.username)); return; }
        var doc = frozenDoc(a, fz);
        var name = (fz.data.user && fz.data.user.name) || C.nameOf(a.username);
        // 한 사람 PDF(frozenOpts → buildPdf)와 같은 길(sheetBuild — 서명 · 인쇄 준비(하이패스 영수증 줄) · 근거 쪽) · 결재 완료본 묶음은 검증 결과 쪽 없음(2026-10-14)
        //   closedAt — frozenOpts 와 같게(상신 뒤 덧붙인 하이패스 원본의 「결재 완료 뒤 덧붙임」, 2026-10-23)
        return sheetBuild(doc, { name: name, cycleName: cycName(a.cycle), mark: '', closedAt: a.closed_at || null,
          docNo: '결재 #' + a.id + ' · 상신 ' + whenText(fz.frozen_at) + (a.closed_at ? ' · 완료 ' + whenText(a.closed_at) : '') }, null).then(function (res) {
          parts.push(res.bytes); partIds.push(a.id);
          var snap = a.snapshot || {}, why = [];
          var sum = (res.totals || []).reduce(function (s, t) { return s + (Number(t && t.all) || 0); }, 0);
          if (snap.version >= 2 && isFinite(Number(snap.cost)) && Math.round(sum) - Math.round(Number(snap.cost)) !== 0) {   // 1원 차이도(2026-10-08)
            why.push('문서 총계 ' + n0(sum) + '원과 결재 금액 ' + n0(snap.cost) + '원이 다름');
          }
          var img = (res.issues || []).filter(function (x) { return x.kind === 'image'; }).length;
          if (img) why.push('불러오지 못한 사진 ' + img + '장');
          var hip = (res.issues || []).filter(function (x) { return x.kind === 'hipass'; });
          if (hip.length) why.push('하이패스 영수증 근거를 다 넣지 못함(' + hipWhy(hip) + ')');
          if (why.length) checks.push(name + ' 님: ' + why.join(', '));
        });
      }).catch(function () { skipped.push(C.nameOf(a.username)); })
        .then(function () { if (FINJOB === job) return one(i + 1); });
    };
    one(0).then(function () {
      if (FINJOB !== job) return null;
      if (!parts.length) throw new Error('만든 문서가 없어요');
      note('한 파일로 묶는 중…');
      var P = window.PDFLib;
      return P.PDFDocument.create().then(function (out) {
        var chain = Promise.resolve();
        parts.forEach(function (b) {
          chain = chain.then(function () { return P.PDFDocument.load(b); })
            .then(function (src) { return out.copyPages(src, src.getPageIndices()); })
            .then(function (pages) { pages.forEach(function (pg) { out.addPage(pg); }); });
        });
        return chain.then(function () { out.setTitle('운행기록부 결재 완료 문서 ' + cname + (ord.team ? ' ' + ord.team : '')); return out.save(); })
          .then(function (bytes) { return { bytes: bytes, pages: out.getPageCount() }; });
      });
    }).then(function (res) {
      FINJOB = null;
      if (!res || !$('finNote')) { C.render(); return; }
      var blob = new Blob([res.bytes], { type: 'application/pdf' });
      PDF_URLS.forEach(function (u) { URL.revokeObjectURL(u); });
      var url = URL.createObjectURL(blob); PDF_URLS = [url];
      // 한 팀만 골랐으면 파일 이름에 팀 이름(2026-10-23 팀별로 뽑기) — 운행기록부_결재완료_2026-09_○○팀_5명.pdf
      var file = '운행기록부_결재완료_' + S.CYCKEY + FIN.fileTag(ord.team) + '_' + parts.length + '명.pdf';
      $('pBody').innerHTML = '<div class="pdfdone"><div class="big">' + n0(res.pages) + '<small>쪽</small></div>' +
        '<div class="dim">' + (blob.size / 1e6).toFixed(1) + ' MB · ' + n0(parts.length) + '명 결재 완료 문서</div>' +
        (skipped.length ? '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(skipped.join(', ')) +
          ' 님 문서는 만들지 못했어요. 한 사람씩 ‘PDF’로 다시 다운로드해 주세요.</span></div>' : '') +
        (checks.length ? '<div class="awarn">' + ic('alert', 15) + '<span>확인이 필요한 문서가 있어요. 한 사람씩 ‘PDF’로 다시 다운로드해 확인해 주세요.<br>' +
          checks.map(function (x) { return esc(x); }).join('<br>') + '</span></div>' : '') +
        (!skipped.length && !checks.length ? '<div class="pdfok">' + ic('check', 15) + '<span>모두 묶었어요. 총계와 사진 점검도 이상 없어요.</span></div>' : '') + '</div>';
      $('pFoot').innerHTML = '<span style="flex:1"></span><button class="btn" data-close>닫기</button>' +
        '<a class="btn" href="' + url + '" download="' + esc(file) + '">' + ic('dl', 14) + '다운로드</a>' +
        '<a class="btn pri" href="' + url + '" target="_blank" rel="noopener">열기 · 인쇄</a>';
      if (C.prints) C.prints.bindOut($('pFoot'), 'driving', partIds, url);    // 묶은 사람마다 한 번씩 출력 기록
      C.render();
    }).catch(function (e) {
      FINJOB = null;
      if ($('finNote')) $('pBody').innerHTML = '<div class="awarn">' + ic('alert', 15) + '<span>' + esc(failMsg('PDF 한 파일로 묶지 못했어요', e, '새로고침한 뒤 다시 해 주세요.')) + '</span></div>';
      C.render();
    });
    C.render();
  }
  /** 결재 완료 금액 요약표(엑셀에서 바로 열리게 BOM 붙은 CSV). */
  function finCsv() {
    var S = C.state(), cyc = S.CYCKEY;
    var done = S.APPR.filter(function (a) { return a.cycle === cyc && a.status === 'approved' && C.orgMatch(a.username); });
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
      var op = C.orgPath(a.username);
      rows.push([C.nameOf(a.username), a.username, [C.orgName(op), op.unit].filter(Boolean).join(' · ') || p.dept || '', a.closed_at ? whenText(a.closed_at) : '',
        Math.round((Number(sn.biz_km) || 0) * 10) / 10,
        Math.round(sn.fuel || 0), Math.round(sn.toll || 0), Math.round(sn.parking || 0), Math.round(sn.cost || 0), a.id]);
    });
    rows.push(['합계', '', '', '', Math.round(sk * 10) / 10, sf, st, sp, Math.round(sum), '']);
    var text = String.fromCharCode(0xFEFF) + rows.map(function (r) { return r.map(q).join(','); }).join(NL) + NL;
    var scope = C.orgScopeName ? C.orgScopeName() : '';
    C.saveBlob(new TextEncoder().encode(text), '결재완료_금액요약_' + cyc + (scope ? '_' + scope.replace(/[\\/:*?"<>|\s]+/g, '') : '') + '.csv');
    C.toast(n0(done.length) + '명의 요약표를 다운로드해요.');
  }

  // 결재 완료 출력 — 고르기 칸 · 전체 선택 · 이 팀 모두 고르기는 C.fin(driving-app.js)이 받는다(2026-10-23).
  //   예전 이 처리기는 고를 때마다 C.render() 로 화면 전체를 다시 그려 표 안쪽 스크롤이 맨 위로, 초점이 body 로 갔다.
  //   전체 선택은 그대로 보이는 줄만(「출력 안 한 것만」 2026-10-14 + 이름으로 찾기) 고른다.
  //   아래는 C.fin 이 없는 앞 판 driving-app.js 와 섞여 실렸을 때만 — 예전 그대로.
  if (FIN.old) document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches && t.matches('[data-finsel]')) { if (t.checked) FINSEL[t.dataset.finsel] = 1; else delete FINSEL[t.dataset.finsel]; C.render(); return; }
    if (t.id === 'finAll') {
      var S = C.state();
      S.APPR.forEach(function (a) {
        if (a.cycle === S.CYCKEY && a.status === 'approved' && C.orgMatch(a.username) && finVisible(a)) { if (t.checked) FINSEL[a.id] = 1; else delete FINSEL[a.id]; }
      });
      C.render();
    }
  });
  /** 검증을 마친 ① 카드 문구 — 실제로 읽은 사진 장수대로(2026-10-20 V3 B6: 0/6장인데 「사진을 읽어 대조했습니다」라 했다). row.summary.read/receipts = 서버가 센 것.
   *  warn = 이번 검증의 판독 실패·하루 한도 글(runVerify). 운행일지·개인경비가 같이 쓴다(C.vx.readDone). */
  function readDone(row, warn) {
    var s = (row && row.summary) || {}, n = Number(s.receipts) || 0, rd = Math.min(Number(s.read) || 0, n), again = ' 고친 게 있으면 다시 눌러 주세요.';
    if (!row || !row.ai) return 'AI가 설정되지 않아 규칙으로만 검사했어요.' + again;
    if (!n) return '읽을 사진이 없어 기록만 검사했어요.' + again;
    if (rd >= n) return 'AI가 사진 ' + n0(n) + '장을 모두 읽고 비교했어요.' + again;
    // 하루 한도처럼 서버가 멈춘 까닭이 있으면 그 말을, 아니면(읽기 실패) 다시 누르면 이어서 읽는다는 말
    //   (2026-10-24 해요체 — 읽기 실패 글이 「…못했습니다」·「…못했어요」 어느 쪽이어도 같은 판정)
    var w = String(warn || '').replace(/[.\s]+$/, '');
    return '사진 ' + n0(n) + '장 중 ' + n0(rd) + '장만 읽었어요. ' + (w && !/^사진 \d+장은 읽지 못했/.test(w) ? w + '.' : '다시 누르면 못 읽은 사진을 이어서 읽어요.');
  }
  /* ══════════════════ 검증·상신 단계 카드(2026-10-20 디자인 v2 — P_Verifying, 세 시스템 같은 모양) ══════════════════
     stage = 지금 할 단계(1 검증 · 2 미리보기 · 3 상신, 0 = 잠김). 순서·규칙은 각 화면이 정한 그대로 — 여기서는 모양만.
       now  = 지금 누를 단계(연분홍·빨간 테두리·번호 고리·단추 깜빡임) · work = ① 이 도는 중(진행 막대) · done = 끝(초록 ✓) · todo = 아직(회색, 못 누름)
       ahead = 마감 단계가 아직 1·2단계인데 이 화면을 연 것 — 큰 단추를 흐리게(누르는 것은 그대로, AU6-L9: 맨 아래 「지금은 1단계 차례」와 부딪쳤다) */
  function stepCard(n, stage, title, desc, button, o) {
    o = o || {};
    // o.st — 화면이 정한 상태(예: 법인카드 빈 칸 때 ③ 이 지금이면 ② 는 「끝」이 아니라 「아직」, 2026-10-20 V3 B5)
    var st = o.st || (stage > n ? 'done' : stage === n ? (o.busy ? 'work' : o.ahead ? 'ahead' : 'now') : 'todo');
    return '<li class="vstep ' + st + '"' + (stage === n ? ' aria-current="step"' : '') + '>' +
      '<div class="vsh"><i aria-hidden="true">' + (st === 'done' ? '✓' : n) + '</i><b>' + title + '</b></div>' +
      '<p>' + desc + '</p>' +
      (st === 'work' ? '<span class="vbar" aria-hidden="true"><i data-aimo-bar style="width:' + (AIM ? AIM.pct : 4) + '%"></i></span>' : '') +
      button + '</li>';
  }

  /* ══════════════════ AI 검증 모션(2026-10-20 디자인 v2 — P_Verifying, 세 시스템 같은 판) ══════════════════
     「검증하기」를 누른 뒤 서버 응답이 올 때까지 결과 자리에 「AI가 영수증을 읽고 있습니다」 판을 둔다.
       · 지난 초 · 「사진 i / N 읽는 중 — 종류」(N = 서버가 이번에 읽힐 사진 수, 그 전에는 사진 있는 영수증 수) · 진행 막대(추정 — 응답 전 90% 를 넘지 않음)
       · 실제 영수증 사진 썸네일(없으면 종이 그림)을 스캐너 빛(빨간 2px 줄 + 옅은 띠)이 훑고, 옆에 이번 기간 줄(날짜·방문처·금액)이 「확인 중」으로 선다
       · 응답이 오면 실제 결과로 줄마다 차례로(80ms) 딱지가 찍히고 결과 화면으로. 가짜 결과는 먼저 보이지 않는다(추정은 진행 표시뿐)
       · 60초가 넘으면 「평소보다 오래 걸립니다 — 그대로 기다려 주세요」 · 움직임 줄이기 설정이면 글자 진행만(딱지도 한 번에)
     화면 전체를 다시 그려도(C.render) 판은 지금 상태로 다시 그려지고, 시계(250ms)는 DOM 을 찾아 고친다(다른 화면이면 건너뛴다). */
  var AIM = null, AIM_T = null;
  var AIM_KIND = { '통행료': '통행료 영수증', '주차': '주차 영수증', '주유': '주유 영수증', '계기판': '계기판 사진' };
  function aimReduce() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  /** o: { title, cols:[머리 넷], rows:[{ id, date, place, amt }], photos:[{ id, src, kind }], N(추정 사진 수), paper('receipt'|'sheet') } */
  function aimBegin(k, o) {
    clearInterval(AIM_T);
    AIM = { k: k, t0: Date.now(), phase: 'check', n: 0, N: o.N || 0, cur: null, tp: 0, tm: 0, pct: 4, pi: 0, ps: 0, done: false, chips: {}, pop: null,
      title: o.title || 'AI가 영수증을 읽고 있어요', cols: o.cols || ['날짜', '운행', '금액(원)', '비교'], rows: (o.rows || []).slice(0, 6),
      more: o.more != null ? o.more : Math.max(0, (o.rows || []).length - 6),
      photos: o.photos || [], paper: o.paper || 'receipt' };
    AIM_T = setInterval(aimTick, 250);
    // 폰에서는 단계 카드 셋이 위아래로 쌓여 판이 화면 아래에 있다 — 판의 머리가 보이게 내려 준다(그린 뒤에)
    setTimeout(function () {
      var el = document.querySelector('[data-aimo]');
      if (el && window.innerWidth <= 720) { try { el.scrollIntoView({ block: 'nearest', behavior: aimReduce() ? 'auto' : 'smooth' }); } catch (e) { } }
    }, 80);
  }
  function aimOn(k) { return !!AIM && AIM.k === k; }
  /** 진행 알림 — info: { phase:'check'|'read'|'match'|'run', n, N, cur(지금 읽는 사진 id), pop:{ kind, value } } */
  function aimStep(k, info) {
    if (!aimOn(k) || !info || AIM.done) return;
    var el = (Date.now() - AIM.t0) / 1000;
    if (info.phase && info.phase !== AIM.phase) { AIM.phase = info.phase; if (info.phase === 'match') AIM.tm = el; if (info.phase === 'read') AIM.tp = el; }
    if (info.N != null) AIM.N = info.N;
    if (info.n != null && info.n !== AIM.n) { AIM.n = info.n; AIM.tp = el; }
    if (info.cur != null) {
      AIM.cur = String(info.cur);
      for (var i = 0; i < AIM.photos.length; i++) if (String(AIM.photos[i].id) === AIM.cur) { AIM.pi = i; AIM.ps = Date.now(); break; }
    }
    if (info.pop) AIM.pop = info.pop;
    aimPaint(true);
  }
  function aimPctCalc() {
    var el = (Date.now() - AIM.t0) / 1000, p;
    if (AIM.done) return 100;
    if (AIM.phase === 'check') p = 4 + 11 * (1 - Math.exp(-el / 3));
    else if (AIM.phase === 'read') p = 15 + 65 * Math.min(1, (AIM.N ? AIM.n / AIM.N : 0) + (AIM.N ? (1 - Math.exp(-(el - AIM.tp) / 4)) * 0.9 / AIM.N : 0));
    else if (AIM.phase === 'match') p = 80 + 10 * (1 - Math.exp(-(el - AIM.tm) / 6));
    else p = 90 * (1 - Math.exp(-el / 12));                    // 'run' — 한 번에 묻는 것(법인카드)
    return Math.min(90, Math.max(AIM.pct, Math.round(p)));
  }
  function aimCount() {
    if (!AIM.N) return '';
    if (AIM.done || AIM.phase === 'match') return AIM.N + ' / ' + AIM.N;
    return (AIM.phase === 'read' ? Math.min(AIM.n + 1, AIM.N) : 0) + ' / ' + AIM.N;
  }
  /** 단추에 쓸 짧은 글 — 「읽는 중… 3 / 9」 */
  function aimShort(k) {
    if (!aimOn(k)) return '';
    if (AIM.phase === 'read' && AIM.N) return '읽는 중… ' + Math.min(AIM.n + 1, AIM.N) + ' / ' + AIM.N;
    return AIM.phase === 'match' ? '비교하는 중…' : AIM.phase === 'run' ? '읽는 중…' : '살피는 중…';
  }
  function aimPhoto() {
    if (!AIM.photos.length) return null;
    // 지금 읽는 사진이 있으면 그것, 없으면(검사·대조 중) 1.4초마다 다음 사진 — 이번 기간 영수증을 차례로 훑는다
    if (!(AIM.phase === 'read' && AIM.cur) && Date.now() - AIM.ps > 1400) { AIM.pi = (AIM.pi + 1) % AIM.photos.length; AIM.ps = Date.now(); }
    return AIM.photos[AIM.pi % AIM.photos.length];
  }
  function aimPaperHtml(ph) {
    var doc = AIM.paper === 'sheet'
      ? '<div class="doc"><i class="h"></i><i></i><i></i><i></i><i></i><i></i><i></i><i class="l"></i><span>카드 내역<b>' + n0(AIM.rows.length + AIM.more) + '줄</b></span></div>'
      : '<div class="doc"><i class="h"></i><i style="width:80%"></i><i style="width:64%"></i><i style="width:72%"></i><i class="l"></i><span>합계<b>···</b></span><i style="width:54%"></i><i style="width:38%"></i></div>';
    return doc + (ph ? '<img alt="" src="' + esc(ph.src) + '">' : '') + '<span class="aimo-scan"></span>' + (ph ? '<span class="aimo-tag">' + esc(ph.kind || '영수증') + '</span>' : '');
  }
  function aimChip(c) { return '<span class="dchip ' + (c ? c[1] : 'wait') + '">' + esc(c ? c[0] : '확인 중') + '</span>'; }
  /** 판 — viewVerify 의 결과 자리(.hero). verdictHtml = 지금 진행 글(각 화면의 노트 칸 — 바뀌면 각 화면이 그 칸만 고친다). */
  function aimHtml(k, verdictHtml) {
    if (!aimOn(k)) return '';
    var ph = aimPhoto(), el = Math.floor((Date.now() - AIM.t0) / 1000), long = el >= 60;
    AIM.pct = aimPctCalc();
    return '<section class="hero aimo" data-aimo aria-busy="true" aria-label="AI 검증 중">' +
      '<div class="aimo-hd"><h2>' + esc(AIM.title) + '</h2><span class="aimo-el" data-aimo-el>' + el + '초 지남</span></div>' +
      '<div class="aimo-st"><p class="verdict" role="status" aria-live="polite">' + verdictHtml + '</p><b class="aimo-cnt" data-aimo-cnt>' + aimCount() + '</b></div>' +
      '<span class="aimo-bar" aria-hidden="true"><i data-aimo-bar style="width:' + AIM.pct + '%"></i></span>' +
      '<div class="aimo-stage" aria-hidden="true">' +
        '<div class="aimo-pile"><span class="pp"></span><span class="pp p2"></span><div class="aimo-frame" data-aimo-frame data-pid="' + esc(ph ? String(ph.id) : '') + '">' +
          '<div class="aimo-paper" data-aimo-paper>' + aimPaperHtml(ph) + '</div><span class="cn tl"></span><span class="cn tr"></span><span class="cn bl"></span><span class="cn br"></span></div></div>' +
        '<div class="aimo-flow"><i></i><i></i><i></i></div>' +
        '<div class="aimo-side"><div class="aimo-pop" data-aimo-pop' + (AIM.pop ? '' : ' hidden') + '>' + (AIM.pop ? '<span>' + esc(AIM.pop.kind) + ' 읽음</span><b>' + esc(AIM.pop.value) + '</b>' : '') + '</div>' +
          // 머리 칸에도 줄 칸과 같은 이름(pl·am·ac) — 폰에서 금액 칸을 숨길 때 머리 「금액(원)」도 같이 숨는다(2026-10-20 V3 B11: 머리만 남아 「맞춰 보기」가 아랫줄로 밀렸다)
          '<div class="aimo-rows"><div class="ar hd">' + AIM.cols.map(function (c, i) { return '<span' + ([' class="dt"', ' class="pl"', ' class="am"', ' class="ac"'][i] || '') + '>' + esc(c) + '</span>'; }).join('') + '</div>' +
          (AIM.rows.length ? AIM.rows.map(function (r) {
            return '<div class="ar" data-aimo-row="' + esc(String(r.id)) + '"><b>' + esc(r.date) + '</b><span class="pl">' + esc(r.place || '—') + '</span>' +
              '<span class="am">' + esc(r.amt == null ? '—' : r.amt) + '</span><span class="ac">' + aimChip(AIM.chips[String(r.id)]) + '</span></div>';
          }).join('') : '<div class="aimo-more">이번 기간에 비교할 줄이 없어요</div>') +
          (AIM.more ? '<div class="aimo-more">외 ' + n0(AIM.more) + '줄도 함께 확인해요</div>' : '') + '</div></div>' +
      '</div>' +
      '<p class="aimo-note' + (long ? ' long' : '') + '" data-aimo-note>' + (long ? '평소보다 오래 걸리고 있어요. 이 화면에서 기다려 주세요.' : '보통 10~30초 걸려요. 다 읽을 때까지 이 화면에서 기다려 주세요.') + '</p></section>';
  }
  /** 시계·진행 알림 때 판의 바뀐 곳만 고친다(화면 전체를 다시 그리지 않는다). */
  function aimPaint(force) {
    if (!AIM) return;
    var root = document.querySelector('[data-aimo]');
    AIM.pct = aimPctCalc();
    Array.prototype.forEach.call(document.querySelectorAll('[data-aimo-bar]'), function (b) { b.style.width = AIM.pct + '%'; });
    if (!root) return;
    var el = Math.floor((Date.now() - AIM.t0) / 1000), e1 = root.querySelector('[data-aimo-el]'), c1 = root.querySelector('[data-aimo-cnt]'), nt = root.querySelector('[data-aimo-note]');
    if (e1) e1.textContent = el + '초 지남';
    if (c1) c1.textContent = aimCount();
    if (nt && el >= 60 && !nt.classList.contains('long')) { nt.classList.add('long'); nt.textContent = '평소보다 오래 걸리고 있어요. 이 화면에서 기다려 주세요.'; }
    var ph = aimPhoto(), fr = root.querySelector('[data-aimo-frame]');
    if (fr && fr.getAttribute('data-pid') !== (ph ? String(ph.id) : '')) {
      fr.setAttribute('data-pid', ph ? String(ph.id) : '');
      var pp = fr.querySelector('[data-aimo-paper]'); if (pp) pp.innerHTML = aimPaperHtml(ph);
      if (!aimReduce()) { fr.classList.remove('slide'); void fr.offsetWidth; fr.classList.add('slide'); }
    }
    var img = fr && fr.querySelector('img');
    if (img && !img.__aimo) { img.__aimo = 1; img.addEventListener('error', function () { img.style.display = 'none'; }); }
    var pop = root.querySelector('[data-aimo-pop]');
    if (pop && AIM.pop && force) { pop.hidden = false; pop.innerHTML = '<span>' + esc(AIM.pop.kind) + ' 읽음</span><b>' + esc(AIM.pop.value) + '</b>'; pop.style.animation = 'none'; void pop.offsetWidth; pop.style.animation = ''; }
  }
  function aimTick() { if (!AIM || AIM.done) { clearInterval(AIM_T); AIM_T = null; return; } aimPaint(false); }
  /** 응답이 왔다 — 실제 결과로 줄마다 딱지를 찍는다(80ms 간격, 움직임 줄이기면 한 번에). res = { byId: { 줄 id: [글, 색] }, fallback: [글, 색] } */
  function aimFinish(k, res) {
    return new Promise(function (ok) {
      if (!aimOn(k)) { ok(); return; }
      AIM.done = true; AIM.pct = 100; clearInterval(AIM_T); AIM_T = null;
      aimPaint(false);
      var red = aimReduce(), list = AIM.rows.slice(), i = 0;
      var stamp = function () {
        if (!aimOn(k)) { ok(); return; }
        if (i >= list.length) { setTimeout(ok, red ? 0 : 450); return; }
        var r = list[i++], c = (res && res.byId && res.byId[String(r.id)]) || (res && res.fallback) || null;
        if (c) {
          AIM.chips[String(r.id)] = c;
          var row = null;
          Array.prototype.forEach.call(document.querySelectorAll('[data-aimo-row]'), function (x) { if (x.getAttribute('data-aimo-row') === String(r.id)) row = x; });
          if (row) {
            var ac = row.querySelector('.ac'); if (ac) ac.innerHTML = aimChip(c);
            if (!red) { row.classList.remove('hit'); void row.offsetWidth; row.classList.add('hit'); }
          }
        }
        if (red) stamp(); else setTimeout(stamp, 80);
      };
      stamp();
    });
  }
  function aimEnd(k) { if (aimOn(k)) { clearInterval(AIM_T); AIM_T = null; AIM = null; } }
  /** 결과(items + refs)에서 줄마다 딱지 — key = 'trips'(운행일지 refs.trips) | 'items'(개인경비·법인카드 ref.items). 맨 나쁜 것 하나. */
  function aimChipsFrom(items, key, map) {
    var by = {};
    (items || []).forEach(function (it) {
      var ids = key === 'trips' ? (it.refs || {}).trips : ((it.ref && it.ref.items) || (it.refs && it.refs.items));
      var c = map(it);
      if (!c || !ids || !ids.length) return;
      ids.forEach(function (id) { var o = by[String(id)]; if (!o || o.r < c[2]) by[String(id)] = { c: [c[0], c[1]], r: c[2] }; });
    });
    var out = {}; Object.keys(by).forEach(function (id) { out[id] = by[id].c; });
    return { byId: out, fallback: ['맞음', 'ok'] };
  }
  var AIMO = { begin: aimBegin, step: aimStep, finish: aimFinish, end: aimEnd, html: aimHtml, on: aimOn, short: aimShort, chipsFrom: aimChipsFrom, kind: AIM_KIND,
    pct: function () { return AIM ? AIM.pct : 0; } };
  /** 운행일지 판 재료 — 이번 기간 업무 운행 줄(금액 있는 운행 먼저 여섯, 날짜순)과 사진 있는 영수증. */
  function drvMotion(u, cyc) {
    // 기간 범위는 엔진 열쇠로(2026-10-20 V3 — 연말 추가 기간 '2026-12b' 를 달 숫자로 나눠 NaN 범위가 되어 판에 운행·사진이 0줄이었다)
    var S = C.state(), r = keyRange(cyc);
    var biz = (S.ALL_TRIPS || []).filter(function (t) { return t.username === u && !t.deleted_at && t.purpose === '일반업무' && t.start_time >= r.lo && t.start_time < r.hi; });
    var amt = function (t) { return (Number(t.toll_cost) || 0) + (Number(t.parking_cost) || 0); };
    var pick = biz.filter(function (t) { return amt(t) > 0; }).concat(biz.filter(function (t) { return !(amt(t) > 0); })).slice(0, 6)
      .sort(function (a, b) { return a.start_time - b.start_time; });
    var short = function (a) { var w = String(a || '').trim().split(/\s+/).filter(Boolean); return w.slice(-2).join(' '); };
    var ev = (S.ALL_EVID || []).filter(function (e) { var d = Number(e.date_millis); return e.username === u && e.photo_path && d >= r.lo && d < r.hi; })
      .sort(function (a, b) { return a.date_millis - b.date_millis; });
    return { title: 'AI가 영수증을 읽고 있어요', cols: ['날짜', '운행', '금액(원)', '비교'], N: ev.length,
      rows: pick.map(function (t) { return { id: t.id, date: C.md(t.start_time), place: t.visit_place || short(t.end_address) || '방문처 없음', amt: amt(t) ? n0(amt(t)) : '—' }; }),
      more: Math.max(0, biz.length - 6),
      photos: ev.map(function (e) { return { id: e.id, src: C.photoUrl(e.photo_path), kind: AIM_KIND[e.category] || ((e.category || '') + ' 영수증') }; }) };
  }
  /** 운행일지 검증 결과 → 운행 줄 딱지(서버 R06·R10·R15·R14·R02 와 그 밖의 확인 항목 refs.trips). */
  function drvChips(row) {
    return aimChipsFrom((row && row.result && row.result.items) || [], 'trips', function (it) {
      if (it.code === 'R06') return ['영수증 없음', 'bad', 6];
      if (it.code === 'R10') return ['금액 다름', 'bad', 5];
      // 하이패스 영수증 원본 없음(R15, 2026-10-23) — 금액 다름보다 아래(같은 운행에 둘 다면 금액 다름), 그 밖의 불일치보다 위
      if (it.code === 'R15') return ['하이패스 원본 없음', 'bad', 4.5];
      if (it.code === 'R14') return ['두 번 정산 의심', 'warn', 4];
      if (it.code === 'R02') return ['통행료 미확정', 'warn', 3];
      if (it.level === 'bad') return ['확인 필요', 'bad', 2];
      if (it.level === 'warn') return ['확인 필요', 'warn', 1];
      return null;
    });
  }

  // 개인경비(drv-expense.js)가 같은 모양·같은 순서를 쓰도록 내어 준다 — 결과 창·Gemini 단추·검증 딱지·사진 받기.
  C.vx = {
    makePdf: makePdf, buildPdf: buildPdf, ensureLibs: ensureLibs, loadPhoto: loadPhoto, pool: pool, safeName: safeName,
    gemBtn: gemBtn, gemBadge: gemBadge, sumChip: sumChip, sumText: sumText, whenText: whenText, showItems: showItems, warnTail: warnTail,
    pdfUrls: function () { return PDF_URLS; }, setPdfUrls: function (a) { PDF_URLS.forEach(function (u) { URL.revokeObjectURL(u); }); PDF_URLS = a || []; },
    // 2026-10-20 디자인 v2 — 세 시스템이 같이 쓰는 검증·상신 단계 카드와 AI 검증 모션
    stepCard: stepCard, aiMotion: AIMO,
    readDone: readDone       // ① 카드 「읽은 사진 장수」 문구(2026-10-20 V3 B6)
  };
  return {
    // 「검증 현황」(a_verify)은 관리 「현황」(driving-app.js a_status)으로 합쳤다(2026-10-15 2차) — 검증 칸은 statusVerify 가 낸다
    views: { verify: viewVerify, a_final: viewFinal },
    onGo: function (v) { if (v === 'verify') FRESH = {}; },
    admin: ['a_final'],
    apprExtra: apprExtra, wantSummaries: wantSummaries, beforeSubmit: beforeSubmit, statusVerify: statusVerify,
    sumText: sumText, pdfFrozen: pdfFrozen, xlsxFrozen: xlsxFrozen, previewBytes: previewBytes,
    // ★ 주기가 바뀌어도 돌고 있는 검증은 그대로 둔다. 여기서 '안 도는 중'으로 풀면 같은 검증이 겹쳐 돈다.
    onCycle: function () { }
  };
});
