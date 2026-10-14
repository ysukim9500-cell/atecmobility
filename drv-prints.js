/* ═══════════════════════════════════════════════════════════════════════════
   drv-prints.js — 결재 완료 문서 출력 기록 (2026-10-14 사용자: 「출력했는지 체크 · 출력 횟수」)
   ---------------------------------------------------------------------------
   운행일지(drv-verify.js) · 개인경비(drv-expense.js) · 법인카드(drv-card.js)가 같이 쓴다 — C.prints.
     · log(kind, ids, fmt)  출력 한 번 남기기. ★ 기다리지 않는다(보내 놓고 잊는다). 실패해도 콘솔에만 — 출력은 이미 끝났다.
     · badge(kind, a)       결재 완료 문서 딱지: 「미출력」 / 「출력 N회 · 마지막 MM.DD HH:MM 이름」(한국시간). 누르면 전체 기록 창.
     · bindOut(foot, kind, ids, url)  PDF 결과 창의 「내려받기」(pdf) · 「열기 · 인쇄」(print) 링크를 누를 때 남긴다.
     · onlyBtn(kind) / keep(kind, a)  관리 화면 「출력 안 한 것만」 단추 · 거르기.
   kind = 'driving' · 'expense' · 'card' (서버 approval_prints.kind · approval-act 의 kind 와 같은 이름).
   서버: approval_print_log · approval_print_stats(여러 건 한 번에) · approval_print_history (20261014110000_approval_prints.sql).
   함수가 아직 없거나(적용 전) 실패하면 딱지·단추를 숨긴다 — 「미출력」으로 잘못 말하지 않는다.
   ═══════════════════════════════════════════════════════════════════════════ */
(window.DrvExtQ = window.DrvExtQ || []).push(function (C) {
  'use strict';
  var esc = C.esc, n0 = C.n0;
  var KINDS = { driving: 1, expense: 1, card: 1 };
  var FMT = { pdf: 'PDF 내려받기', xlsx: '엑셀', print: 'PDF 열기·인쇄' };
  // ST[kind][id] = undefined(아직 모름) · null(볼 수 없음·결재 완료 아님) · {n, last_at, last_by, last_name, last_format, n_pdf, n_xlsx, n_print}
  var ST = { driving: {}, expense: {}, card: {} };
  var PEND = { driving: {}, expense: {}, card: {} }, ASKING = { driving: {}, expense: {}, card: {} };
  var FAIL = { driving: 0, expense: 0, card: 0 };          // 요약을 못 받은 때 — 1분 동안 다시 묻지 않고 딱지를 숨긴다
  var ONLY = { driving: false, expense: false, card: false };
  var TIMER = null;

  function rpc(name, body) {
    return C.apiRetry('/rest/v1/rpc/' + name, { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) throw new Error((j && (j.message || j.error)) || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  /** 한국시간 MM.DD HH:MM */
  function kst(iso, withYear) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var d = new Date(t + 9 * 3600e3), p = function (v) { return (v < 10 ? '0' : '') + v; };
    return (withYear ? d.getUTCFullYear() + '.' : '') + p(d.getUTCMonth() + 1) + '.' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }
  function down(kind) { return FAIL[kind] && Date.now() - FAIL[kind] < 60000; }

  /* ── 요약 받기 — 화면을 그리는 동안 모았다가 종류마다 한 번에 ── */
  function want(kind, ids) {
    if (!KINDS[kind] || down(kind)) return;
    var any = false;
    (ids || []).forEach(function (id) {
      if (id == null || ST[kind][id] !== undefined || ASKING[kind][id]) return;
      PEND[kind][id] = 1; any = true;
    });
    if (any && !TIMER) TIMER = setTimeout(flush, 0);
  }
  function flush() {
    TIMER = null;
    Object.keys(PEND).forEach(function (kind) {
      var ids = Object.keys(PEND[kind]).map(Number).filter(isFinite);
      PEND[kind] = {};
      if (!ids.length) return;
      ids.forEach(function (id) { ASKING[kind][id] = 1; });
      rpc('approval_print_stats', { p_kind: kind, p_ids: ids }).then(function (rows) {
        var by = {};
        (Array.isArray(rows) ? rows : []).forEach(function (r) { by[r.approval_id] = r; });
        ids.forEach(function (id) { ST[kind][id] = by[id] || null; delete ASKING[kind][id]; });
        FAIL[kind] = 0;
        repaint();
      }).catch(function (e) {
        ids.forEach(function (id) { delete ASKING[kind][id]; });
        if (!FAIL[kind]) console.warn('출력 기록 요약을 받지 못했습니다(딱지를 숨깁니다):', (e && e.message) || e);
        FAIL[kind] = Date.now();
        repaint();
      });
    });
  }
  /** 받은 요약을 화면에 — 칸에 글을 치는 중이면 다시 그리지 않는다(커서가 튄다). 다음에 그릴 때 붙는다. */
  function repaint() {
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox') return;
    C.render();
  }

  /* ── 남기기 ── */
  function log(kind, ids, fmt) {
    if (!KINDS[kind] || !FMT[fmt]) return;
    (Array.isArray(ids) ? ids : [ids]).forEach(function (id) {
      if (id == null) return;
      // ★ 기다리지 않는다 — 출력은 이미 끝났다. 실패하면 콘솔에만.
      rpc('approval_print_log', { p_kind: kind, p_id: Number(id), p_format: fmt }).then(function () {
        delete ST[kind][id];
        want(kind, [id]);
      }).catch(function (e) {
        console.warn('출력 기록을 남기지 못했습니다(출력은 됐습니다):', kind, id, fmt, (e && e.message) || e);
      });
    });
  }
  /** PDF 결과 창의 링크 — 「내려받기」(download 속성) = pdf, 「열기 · 인쇄」 = print. 누를 때마다 한 번. */
  function bindOut(foot, kind, ids, url) {
    if (!foot || !KINDS[kind] || !ids || !ids.length) return;
    Array.prototype.forEach.call(foot.querySelectorAll('a[href]'), function (a) {
      if (url && a.getAttribute('href') !== url) return;
      var fmt = a.hasAttribute('download') ? 'pdf' : 'print';
      var hit = function (e) { if (e.type === 'auxclick' && e.button !== 1) return; log(kind, ids, fmt); };
      a.addEventListener('click', hit); a.addEventListener('auxclick', hit);
    });
  }

  /* ── 딱지 ── */
  function badge(kind, a) {
    if (!a || a.status !== 'approved' || !KINDS[kind]) return '';
    var s = ST[kind][a.id];
    if (s === undefined) { want(kind, [a.id]); return ''; }
    if (!s || down(kind)) return '';
    var key = esc(kind + ':' + a.id), who = esc(C.nameOf(a.username) + ' · ' + String(a.cycle || ''));
    if (!s.n) {
      return '<button type="button" class="prb none" data-prhist="' + key + '" data-prwho="' + who + '" title="아직 아무도 출력하지 않았습니다 — 눌러서 출력 기록 보기">미출력</button>';
    }
    var tip = [s.n_pdf ? FMT.pdf + ' ' + n0(s.n_pdf) + '회' : '', s.n_print ? FMT.print + ' ' + n0(s.n_print) + '회' : '',
      s.n_xlsx ? FMT.xlsx + ' ' + n0(s.n_xlsx) + '회' : ''].filter(Boolean).join(' · ');
    return '<button type="button" class="prb done" data-prhist="' + key + '" data-prwho="' + who + '" title="' + esc(tip + ' — 눌러서 전체 출력 기록 보기') + '">' +
      '출력 ' + n0(s.n) + '회 · 마지막 ' + esc(kst(s.last_at)) + ' ' + esc(s.last_name || s.last_by || '') + '</button>';
  }
  function stat(kind, id) { return KINDS[kind] ? ST[kind][id] : undefined; }

  /* ── 「출력 안 한 것만」 ── */
  function onlyBtn(kind) {
    if (!KINDS[kind] || down(kind)) return '';
    return '<button type="button" class="btn sm' + (ONLY[kind] ? ' pri' : '') + '" data-pronly="' + kind + '" aria-pressed="' + ONLY[kind] + '">출력 안 한 것만</button>';
  }
  /** 거른 뒤에도 남길 문서인가 — 아직 요약을 모르면(받는 중·실패) 남긴다. */
  function keep(kind, a) {
    if (!ONLY[kind] || down(kind)) return true;
    var s = ST[kind][a.id];
    return !s || !s.n;
  }
  function only(kind) { return !!ONLY[kind] && !down(kind); }

  /* ── 전체 기록 창 ── */
  function openHist(kind, id, who) {
    C.openPanel('출력 기록', who || '',
      '<div class="pdfwait"><div class="spin"></div><div role="status">출력 기록을 불러오는 중…</div></div>',
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>');
    var body = C.$('pBody'), mine = function () { return C.$('pBody') === body && C.$('panel').classList.contains('open') && body.querySelector('.pdfwait'); };
    rpc('approval_print_history', { p_kind: kind, p_id: Number(id) }).then(function (rows) {
      if (!mine()) return;
      rows = Array.isArray(rows) ? rows : [];
      var cur = rows.filter(function (r) { return r.cur !== false; }).length;
      body.innerHTML = !rows.length
        ? C.blank('아직 아무도 출력하지 않았습니다.', '결재 완료본을 PDF·엑셀로 받으면 여기에 남습니다.', 'stamp')
        : '<div class="anote" style="margin-top:0">이번 결재 완료 뒤 <b>' + n0(cur) + '회</b> 출력했습니다. 시각은 한국시간입니다.' +
          (rows.length > cur ? ' 정정 전 판의 출력 ' + n0(rows.length - cur) + '회는 흐리게 보입니다(횟수에 넣지 않습니다).' : '') + '</div>' +
          '<div class="panel" style="margin-top:12px"><div class="scroll"><table class="prhist"><thead><tr><th>날짜·시각</th><th>이름</th><th>형식</th></tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr' + (r.cur === false ? ' class="old"' : '') + '><td>' + esc(kst(r.at, true)) + '</td><td>' + esc(r.name || r.username || '') +
              (r.cur === false ? ' <span class="dim">(정정 전 판)</span>' : '') + '</td><td>' + esc(FMT[r.format] || r.format || '') + '</td></tr>';
          }).join('') + '</tbody></table></div></div>';
    }).catch(function (e) {
      if (!mine()) return;
      console.warn('출력 기록을 받지 못했습니다:', (e && e.message) || e);
      body.innerHTML = '<div class="awarn">' + C.ic('alert', 15) + '<span>출력 기록을 불러오지 못했습니다. 잠시 뒤 다시 해 보세요.</span></div>';
    });
  }

  document.addEventListener('click', function (e) {
    var el;
    if ((el = e.target.closest('[data-prhist]'))) {
      var p = el.dataset.prhist.split(':');
      openHist(p[0], p[1], el.dataset.prwho);
      return;
    }
    if ((el = e.target.closest('[data-pronly]'))) {
      var k = el.dataset.pronly;
      if (KINDS[k]) { ONLY[k] = !ONLY[k]; C.render(); }
    }
  });

  C.prints = { log: log, bindOut: bindOut, badge: badge, want: want, stat: stat, onlyBtn: onlyBtn, keep: keep, only: only, kst: kst };
  return {};
});
