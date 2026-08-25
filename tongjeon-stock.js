/* ============================================================================
 *  통전망 — 자재 재고 · 수리 관리
 *
 *  재고는 tj_stock_current(이력 합계 뷰)에서 읽는다. 숫자를 직접 고치지 않고
 *  입고·사용·회수·수리완료·폐기 이력을 남기는 방식이라 항상 근거가 남는다.
 * ========================================================================== */
(function () {
  'use strict';

  /* ══════════════ 자재 재고 ══════════════ */
  var stockBuilt = false, SF = { org: '', q: '', lowOnly: false };

  function stockShell() {
    return '' +
    '<div class="panel">' +
      '<div class="flex items-center justify-between mb-3 flex-wrap gap-2">' +
        '<div class="panel-head" style="margin-bottom:0"><span class="panel-dot"></span>자재 재고<span class="panel-sub">양품 · 불량 · 외주</span></div>' +
        '<button class="btn-main px-4 py-2 text-sm" onclick="TJStock.openIn()">+ 입고 등록</button>' +
      '</div>' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<select id="s-org" class="fld" style="width:auto"><option value="">전체 거점</option></select>' +
        '<input id="s-q" class="fld" style="max-width:240px" placeholder="🔍 품목 검색">' +
        '<label class="text-[12.5px] text-slate-600 flex items-center gap-1.5"><input type="checkbox" id="s-low"> 부족만 보기</label>' +
        '<button class="btn-main text-[12.5px] px-4 py-2 font-extrabold" onclick="TJStock.applyStock()">적용</button>' +
        '<span id="s-count" class="text-[12.5px] text-slate-500 font-semibold md:ml-auto"></span>' +
      '</div>' +
    '</div>' +
    '<div id="s-low-box"></div>' +
    '<div class="panel" style="padding:0;overflow:hidden">' +
      '<div class="overflow-x-auto" style="max-height:620px;overflow-y:auto">' +
        '<table class="rtbl"><thead><tr>' +
          '<th>거점</th><th>품목</th><th style="text-align:right">양품</th><th style="text-align:right">불량</th>' +
          '<th style="text-align:right">외주</th><th style="text-align:right">합계</th><th></th>' +
        '</tr></thead><tbody id="s-rows"></tbody></table>' +
      '</div>' +
    '</div>';
  }

  function loadStock() {
    return Promise.all([
      TJ.selectAll('tj_stock_current?select=org_id,part_id,state,qty&order=org_id'),
      TJ.master.parts(), TJ.master.orgs()
    ]).then(function (r) {
      var cur = r[0], pmap = TJ.indexBy(r[1], 'id'), omap = TJ.indexBy(r[2], 'id');
      var agg = {};
      cur.forEach(function (c) {
        var k = c.org_id + '|' + c.part_id;
        if (!agg[k]) agg[k] = { org_id: c.org_id, part_id: c.part_id, 양품: 0, 불량: 0, 외주: 0 };
        agg[k][c.state] = (agg[k][c.state] || 0) + c.qty;
      });
      var list = Object.values(agg).map(function (a) {
        var p = pmap[a.part_id] || {}, o = omap[a.org_id] || {};
        return {
          org: o.name || '(미상)', part: p.name || '(미상)', part_id: a.part_id, org_id: a.org_id,
          good: a.양품 || 0, bad: a.불량 || 0, out: a.외주 || 0,
          total: (a.양품 || 0) + (a.불량 || 0) + (a.외주 || 0),
          low: (a.양품 || 0) <= (p.low_stock_threshold == null ? 2 : p.low_stock_threshold)
        };
      });
      return list;
    });
  }

  function paintStock(list) {
    var view = list.filter(function (x) {
      if (SF.org && x.org !== SF.org) return false;
      if (SF.q && x.part.indexOf(SF.q) < 0) return false;
      if (SF.lowOnly && !x.low) return false;
      return true;
    }).sort(function (a, b) { return a.org.localeCompare(b.org, 'ko') || a.part.localeCompare(b.part, 'ko'); });

    document.getElementById('s-count').textContent = TJ.num(view.length) + '개 품목';
    document.getElementById('s-rows').innerHTML = view.length ? view.map(function (x) {
      return '<tr>' +
        '<td class="whitespace-nowrap">' + TJ.esc(x.org) + '</td>' +
        '<td class="font-semibold">' + TJ.esc(x.part) + (x.low ? ' <span class="chip" style="background:#fef3c7;color:#92400e">부족</span>' : '') + '</td>' +
        '<td style="text-align:right" class="tabular font-bold' + (x.low ? ' text-amber-600' : '') + '">' + TJ.num(x.good) + '</td>' +
        '<td style="text-align:right" class="tabular">' + TJ.num(x.bad) + '</td>' +
        '<td style="text-align:right" class="tabular">' + TJ.num(x.out) + '</td>' +
        '<td style="text-align:right" class="tabular text-slate-500">' + TJ.num(x.total) + '</td>' +
        '<td style="text-align:right"><button class="btn-ghost px-2.5 py-1 text-[11.5px]" onclick="TJStock.history(' + x.org_id + ',' + x.part_id + ')">이력</button></td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="7" class="text-center text-slate-400 py-8">조건에 맞는 자재가 없습니다.</td></tr>';

    var lows = list.filter(function (x) { return x.low && x.good <= 0; });
    document.getElementById('s-low-box').innerHTML = lows.length ?
      '<div class="panel" style="border-color:#fcd9a4;background:#fffbeb">' +
        '<div class="panel-head" style="color:#B45309"><span class="panel-dot" style="background:#F59E0B"></span>양품이 없는 자재 ' + lows.length + '건</div>' +
        '<div class="flex flex-wrap gap-1.5">' + lows.slice(0, 30).map(function (x) {
          return '<span class="chip" style="background:#fef3c7;color:#92400e">' + TJ.esc(x.org) + ' · ' + TJ.esc(x.part) + '</span>';
        }).join('') + '</div></div>' : '';
  }

  function renderStock() {
    var el = document.getElementById('tab-stock');
    if (!stockBuilt) {
      el.innerHTML = stockShell(); stockBuilt = true;
      TJ.master.orgs().then(function (os) {
        document.getElementById('s-org').innerHTML = '<option value="">전체 거점</option>' +
          os.filter(function (o) { return o.has_stock; }).map(function (o) { return '<option>' + TJ.esc(o.name) + '</option>'; }).join('');
      });
    }
    document.getElementById('s-org').value = SF.org;
    document.getElementById('s-q').value = SF.q;
    document.getElementById('s-low').checked = SF.lowOnly;
    loadStock().then(paintStock).catch(function (e) { console.error(e); TJ.toast('재고를 불러오지 못했습니다.', false); });
  }

  /* ══════════════ 수리 ══════════════ */
  var repBuilt = false, RF = { status: '' }, repRows = [], busy = false;

  function repShell() {
    return '' +
    '<div class="panel">' +
      '<div class="flex items-center justify-between mb-3 flex-wrap gap-2">' +
        '<div class="panel-head" style="margin-bottom:0"><span class="panel-dot"></span>수리 관리<span class="panel-sub">불량품 입고 → 수리 → 양품 복귀</span></div>' +
        '<button class="btn-main px-4 py-2 text-sm" onclick="TJStock.openRepair()">+ 수리 입고</button>' +
      '</div>' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<select id="r-status" class="fld" style="width:auto">' +
          '<option value="">전체 상태</option><option>진행중</option><option>완료</option><option>외주</option><option>폐기</option><option>수리불가</option>' +
        '</select>' +
        '<button class="btn-main text-[12.5px] px-4 py-2 font-extrabold" onclick="TJStock.applyRep()">적용</button>' +
        '<span id="r-count" class="text-[12.5px] text-slate-500 font-semibold md:ml-auto"></span>' +
      '</div>' +
      '<div id="r-hint" class="text-[12px] text-slate-400 mt-2"></div>' +
    '</div>' +
    '<div class="m-list"><div class="panel" style="padding:0;overflow:hidden">' +
      '<div class="overflow-x-auto" style="max-height:620px;overflow-y:auto">' +
        '<table class="rtbl"><thead><tr>' +
          '<th class="m-keep m-date">입고일</th><th class="m-keep">품목</th>' +
          '<th class="desk-only">출처</th><th class="desk-only">증상</th>' +
          '<th class="m-keep m-tail">상태</th>' +
        '</tr></thead><tbody id="r-rows"></tbody></table>' +
      '</div>' +
    '</div></div>';
  }

  function loadRepairs() {
    var q = 'tj_repairs?select=id,received_date,terminal_id,part_id,part_name_raw,terminal_name_raw,symptom,status,done_date,note,org_id&order=received_date.desc,id.desc';
    if (RF.status) q += '&status=eq.' + encodeURIComponent(RF.status);
    return Promise.all([TJ.selectAll(q), TJ.master.parts(), TJ.master.terminals(), TJ.master.orgs()]).then(function (r) {
      repRows = r[0];
      var pmap = TJ.indexBy(r[1], 'id'), tmap = TJ.indexBy(r[2], 'id');
      document.getElementById('r-count').textContent = TJ.num(repRows.length) + '건';
      var omap = TJ.indexBy(r[3] || [], 'id');
      document.getElementById('r-rows').innerHTML = repRows.length ? repRows.map(function (x) {
        var p = pmap[x.part_id], t = tmap[x.terminal_id], o = omap[x.org_id];
        // 터미널이 이어졌으면 그 이름, 아니면 원본 표기, 그것도 없으면 거점
        var src = t ? t.name : (x.terminal_name_raw || (o ? o.name : ''));
        return '<tr onclick="TJStock.repDetail(' + x.id + ')">' +
          '<td class="m-keep m-date whitespace-nowrap">' + TJ.esc(x.received_date || '-') + '</td>' +
          '<td class="m-keep font-semibold">' + TJ.esc(p ? p.name : (x.part_name_raw || '-')) + '</td>' +
          '<td class="desk-only">' + TJ.esc(src || '-') + '</td>' +
          '<td class="desk-only">' + TJ.esc(x.symptom || '-') + '</td>' +
          '<td class="m-keep m-tail">' + TJ.statusChip(x.status) + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="text-center text-slate-400 py-8">수리 내역이 없습니다.</td></tr>';

      // 옮겨온 기록에는 완료일이 없다 — 빈 표로 오해하지 않도록 알려준다
      var noDone = repRows.filter(function (x) { return x.status === '완료' && !x.done_date; }).length;
      var hint = document.getElementById('r-hint');
      if (hint) {
        hint.textContent = noDone
          ? '옮겨온 기록 ' + TJ.num(noDone) + '건은 완료일이 없습니다. 원본 엑셀에 완료일 항목이 없었습니다. 앞으로 이 화면에서 완료 처리하면 날짜가 남습니다.'
          : '';
      }
    });
  }

  function renderRepairs() {
    var el = document.getElementById('tab-repairs');
    if (!repBuilt) { el.innerHTML = repShell(); repBuilt = true; }
    document.getElementById('r-status').value = RF.status;
    loadRepairs().catch(function (e) { console.error(e); TJ.toast('수리 내역을 불러오지 못했습니다.', false); });
  }

  /* ── 폼(시트로 띄운다) ─────────────────────────────────────────────── */
  function selectHtml(id, list, valKey, txtKey, placeholder, sel) {
    return '<select id="' + id + '" class="fld"><option value="">' + placeholder + '</option>' +
      list.map(function (x) { return '<option value="' + x[valKey] + '"' + (String(sel) === String(x[valKey]) ? ' selected' : '') + '>' + TJ.esc(x[txtKey]) + '</option>'; }).join('') +
      '</select>';
  }

  var api = {
    applyStock: function () {
      SF.org = document.getElementById('s-org').value;
      SF.q = document.getElementById('s-q').value.trim();
      SF.lowOnly = document.getElementById('s-low').checked;
      loadStock().then(paintStock);
    },
    applyRep: function () { RF.status = document.getElementById('r-status').value; loadRepairs(); },

    /* 입고 등록 */
    openIn: function () {
      Promise.all([TJ.master.parts(), TJ.master.orgs()]).then(function (r) {
        var body =
          '<div class="mb-3"><label class="fld-label req">거점</label>' + selectHtml('in-org', r[1].filter(function (o) { return o.has_stock; }), 'id', 'name', '선택') + '</div>' +
          '<div class="mb-3"><label class="fld-label req">품목</label>' + selectHtml('in-part', r[0], 'id', 'name', '선택') + '</div>' +
          '<div class="mb-3"><label class="fld-label req">수량</label><input id="in-qty" type="number" min="1" value="1" class="fld"></div>' +
          '<div class="mb-3"><label class="fld-label">상태</label><select id="in-state" class="fld"><option>양품</option><option>불량</option><option>외주</option></select></div>' +
          '<div class="mb-1"><label class="fld-label">메모</label><input id="in-note" class="fld" placeholder="구매·인수 등"></div>';
        TJ.openSheet('입고 등록', body,
          '<button class="btn-main px-4 py-2" onclick="TJStock.saveIn()">저장</button>' +
          '<button class="btn-ghost px-4 py-2" onclick="TJ.closeSheet()">취소</button>');
      });
    },
    saveIn: function () {
      if (busy) return;
      var org = document.getElementById('in-org').value, part = document.getElementById('in-part').value;
      var qty = parseInt(document.getElementById('in-qty').value, 10);
      if (!org || !part || !qty || qty < 1) return TJ.toast('거점·품목·수량을 확인하세요.', false);
      busy = true;
      TJ.insert('tj_stock_moves', [{
        org_id: parseInt(org, 10), part_id: parseInt(part, 10), state: document.getElementById('in-state').value,
        qty: qty, reason: '입고', note: document.getElementById('in-note').value.trim() || null,
        by_user: (TJ.me() || {}).email || ''
      }]).then(function () {
        busy = false; TJ.closeSheet(); TJ.toast('입고 등록되었습니다');
        loadStock().then(paintStock);
      }).catch(function (e) { busy = false; TJ.toast(e.message, false); });
    },

    /* 재고 이력 */
    history: function (orgId, partId) {
      TJ.select('tj_stock_moves?select=state,qty,reason,at,note,by_user&org_id=eq.' + orgId + '&part_id=eq.' + partId + '&order=at.desc&limit=100')
        .then(function (ms) {
          var body = ms.length ? ms.map(function (m) {
            return '<div class="drow"><span class="dl">' + TJ.esc((m.at || '').slice(0, 10)) + ' · ' + TJ.esc(m.reason) + '</span>' +
              '<span class="dv">' + TJ.esc(m.state) + ' <b style="color:' + (m.qty < 0 ? '#dc2626' : '#0D9488') + '">' +
              (m.qty > 0 ? '+' : '') + m.qty + '</b>' + (m.note ? '<br><span style="font-size:11.5px;color:#94a3b8">' + TJ.esc(m.note) + '</span>' : '') + '</span></div>';
          }).join('') : '<div class="text-[13px] text-slate-400 py-4">이력이 없습니다.</div>';
          TJ.openSheet('재고 이력', body, '<button class="btn-ghost px-4 py-2" onclick="TJ.closeSheet()">닫기</button>');
        }).catch(function (e) { TJ.toast(e.message || '이력을 불러오지 못했습니다.', false); });
    },

    /* 수리 입고 */
    openRepair: function () {
      Promise.all([TJ.master.parts(), TJ.master.terminals(), TJ.master.orgs()]).then(function (r) {
        var body =
          '<div class="mb-3"><label class="fld-label req">입고일</label><input id="rp-date" type="date" class="fld" value="' + TJ.today() + '"></div>' +
          '<div class="mb-3"><label class="fld-label req">품목</label>' + selectHtml('rp-part', r[0], 'id', 'name', '선택') + '</div>' +
          '<div class="mb-3"><label class="fld-label">터미널</label>' + selectHtml('rp-terminal', r[1].filter(function (t) { return t.active; }), 'id', 'name', '(모름)') + '</div>' +
          '<div class="mb-3"><label class="fld-label">거점</label>' + selectHtml('rp-org', r[2].filter(function (o) { return o.has_stock; }), 'id', 'name', '선택') + '</div>' +
          '<div class="mb-1"><label class="fld-label">증상</label><input id="rp-symptom" class="fld"></div>';
        TJ.openSheet('수리 입고', body,
          '<button class="btn-main px-4 py-2" onclick="TJStock.saveRepair()">저장</button>' +
          '<button class="btn-ghost px-4 py-2" onclick="TJ.closeSheet()">취소</button>');
      });
    },
    saveRepair: function () {
      if (busy) return;
      var part = document.getElementById('rp-part').value;
      if (!part) return TJ.toast('품목을 선택하세요.', false);
      busy = true;
      TJ.insert('tj_repairs', [{
        received_date: document.getElementById('rp-date').value || null,
        part_id: parseInt(part, 10),
        terminal_id: document.getElementById('rp-terminal').value ? parseInt(document.getElementById('rp-terminal').value, 10) : null,
        org_id: document.getElementById('rp-org').value ? parseInt(document.getElementById('rp-org').value, 10) : null,
        symptom: document.getElementById('rp-symptom').value.trim() || null,
        status: '진행중'
      }]).then(function () { busy = false; TJ.closeSheet(); TJ.toast('수리 입고 등록'); loadRepairs(); })
        .catch(function (e) { busy = false; TJ.toast(e.message, false); });
    },

    /* 수리 상세·완료 */
    repDetail: function (id) {
      var x = repRows.find(function (r) { return r.id === id; });
      if (!x) return;
      Promise.all([TJ.master.parts(), TJ.master.terminals(), TJ.master.orgs()]).then(function (r) {
        var p = TJ.indexBy(r[0], 'id')[x.part_id], t = TJ.indexBy(r[1], 'id')[x.terminal_id], o = TJ.indexBy(r[2], 'id')[x.org_id];
        var body = TJ.detailRows([
          ['상태', TJ.statusChip(x.status), true], ['입고일', x.received_date],
          ['품목', p ? p.name : x.part_name_raw], ['터미널', t ? t.name : ''],
          ['거점', o ? o.name : ''], ['증상', x.symptom], ['완료일', x.done_date],
          ['원본 터미널 표기', t ? '' : x.terminal_name_raw], ['비고', x.note]
        ]);
        var acts = '';
        if (x.status === '진행중' || x.status === '외주') {
          acts += '<button class="btn-main px-4 py-2" onclick="TJStock.finishRepair(' + id + ',\'완료\')">수리 완료</button>' +
                  '<button class="btn-warn px-4 py-2" onclick="TJStock.finishRepair(' + id + ',\'폐기\')">폐기</button>';
        }
        acts += '<button class="btn-ghost px-4 py-2" onclick="TJ.closeSheet()">닫기</button>';
        TJ.openSheet('수리 상세', body, acts);
      });
    },
    /** 완료 = 불량 −1, 양품 +1 / 폐기 = 불량 −1 */
    finishRepair: function (id, how) {
      if (busy) return;
      var x = repRows.find(function (r) { return r.id === id; });
      if (!x) return;
      if (!x.org_id || !x.part_id) {
        return TJ.toast('거점·품목이 없어 재고에 반영할 수 없습니다. 먼저 수정해 주세요.', false);
      }
      if (x.status === '완료' || x.status === '폐기') return TJ.toast('이미 처리된 건입니다.', false);
      busy = true;
      var me = (TJ.me() || {}).email || '';
      var moves = [{ org_id: x.org_id, part_id: x.part_id, state: '불량', qty: -1,
        reason: how === '완료' ? '수리완료' : '폐기', ref_repair_id: id, by_user: me }];
      if (how === '완료') moves.push({ org_id: x.org_id, part_id: x.part_id, state: '양품', qty: 1,
        reason: '수리완료', ref_repair_id: id, by_user: me });
      // 재고를 먼저 기록한다. 상태만 바뀌고 재고가 안 잡히는 상황을 피하기 위함이다.
      TJ.insert('tj_stock_moves', moves)
        .then(function () { return TJ.update('tj_repairs', 'id=eq.' + id, { status: how, done_date: TJ.today() }); })
        .then(function () { busy = false; TJ.closeSheet(); TJ.toast(how + ' 처리했습니다'); loadRepairs(); })
        .catch(function (e) { busy = false; TJ.toast(e.message, false); });
    }
  };

  window.TJStock = api;
  TJ.registerTab('stock', renderStock);
  TJ.registerTab('repairs', renderRepairs);
})();
