/* ============================================================================
 *  통전망 — 터미널 명부(관리자 전용) · 장비 현황 조회
 *
 *  터미널 추가·수정·비활성은 관리자만 할 수 있다.
 *  화면에서 버튼을 감추는 것과 별개로 서버(RLS)에서도 막혀 있으므로,
 *  주소창으로 직접 호출해도 통하지 않는다.
 * ========================================================================== */
(function () {
  'use strict';

  var KINDS = ['시외', '티머니고속', '코버스고속', '고속'];

  /* ══════════════ 터미널 명부 ══════════════ */
  var tBuilt = false, TFL = { region: '', kind: '', q: '', showInactive: false }, tRows = [], aliasMap = null;

  function normKey(s) {
    return String(s == null ? '' : s).replace(/\s/g, '').replace(/\(.*?\)/g, '')
      .replace(/(종합|복합)?(버스)?터미널$/, '').replace(/정류소$/, '');
  }

  function tShell() {
    var admin = TJ.isAdmin();
    return '' +
    '<div class="panel">' +
      '<div class="flex items-center justify-between mb-3 flex-wrap gap-2">' +
        '<div class="panel-head" style="margin-bottom:0"><span class="panel-dot"></span>터미널 명부' +
          '<span class="panel-sub">' + (admin ? '추가·수정은 관리자만 가능합니다' : '조회 전용 — 추가는 관리자에게 요청하세요') + '</span></div>' +
        (admin ? '<button class="btn-main px-4 py-2 text-sm" onclick="TJMaster.openForm()">+ 터미널 추가</button>' : '') +
      '</div>' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<select id="t-region" class="fld" style="width:auto"><option value="">전체 지역</option></select>' +
        '<select id="t-kind" class="fld" style="width:auto"><option value="">전체 구분</option>' +
          KINDS.map(function (k) { return '<option>' + k + '</option>'; }).join('') + '</select>' +
        '<input id="t-q" class="fld" style="max-width:220px" placeholder="🔍 터미널명 검색">' +
        '<label class="text-[12.5px] text-slate-600 flex items-center gap-1.5"><input type="checkbox" id="t-inactive"> 비활성 포함</label>' +
        '<button class="btn-main text-[12.5px] px-4 py-2 font-extrabold" onclick="TJMaster.apply()">적용</button>' +
        '<span id="t-count" class="text-[12.5px] text-slate-500 font-semibold md:ml-auto"></span>' +
      '</div>' +
    '</div>' +
    '<div class="m-list"><div class="panel" style="padding:0;overflow:hidden">' +
      '<div class="overflow-x-auto" style="max-height:620px;overflow-y:auto">' +
        '<table class="rtbl"><thead><tr>' +
          '<th class="m-keep">터미널명</th><th class="m-keep">지역</th>' +
          '<th class="desk-only">구분</th><th class="desk-only">다른 표기</th>' +
          '<th class="m-keep m-tail">상태</th>' +
        '</tr></thead><tbody id="t-rows"></tbody></table>' +
      '</div>' +
    '</div></div>';
  }

  function loadTerminals() {
    return Promise.all([
      TJ.selectAll('tj_terminals?select=id,name,region,kinds,active,note&order=name'),
      aliasMap ? Promise.resolve(null) : TJ.selectAll('tj_terminal_aliases?select=terminal_id,alias,norm&order=id')
    ]).then(function (r) {
      tRows = r[0];
      if (r[1]) {
        aliasMap = {};
        r[1].forEach(function (a) {
          (aliasMap[a.terminal_id] = aliasMap[a.terminal_id] || []).push(a.alias);
          aliasMap['norm:' + a.norm] = a.terminal_id;
        });
      }
      paintTerminals();
    });
  }

  function paintTerminals() {
    var admin = TJ.isAdmin();
    var view = tRows.filter(function (t) {
      if (!TFL.showInactive && !t.active) return false;
      if (TFL.region && t.region !== TFL.region) return false;
      if (TFL.kind && (t.kinds || []).indexOf(TFL.kind) < 0) return false;
      if (TFL.q && String(t.name).indexOf(TFL.q) < 0) return false;
      return true;
    });
    document.getElementById('t-count').textContent = TJ.num(view.length) + '개';
    document.getElementById('t-rows').innerHTML = view.length ? view.map(function (t) {
      var al = (aliasMap && aliasMap[t.id] || []).filter(function (a) { return a !== t.name; });
      return '<tr onclick="TJMaster.detail(' + t.id + ')">' +
        '<td class="m-keep font-semibold">' + TJ.esc(t.name) + '</td>' +
        '<td class="m-keep">' + TJ.esc(t.region || '-') + '</td>' +
        '<td class="desk-only">' + (t.kinds || []).map(function (k) { return '<span class="chip chip-type">' + TJ.esc(k) + '</span>'; }).join(' ') + '</td>' +
        '<td class="desk-only text-[11.5px] text-slate-400">' + TJ.esc(al.slice(0, 3).join(', ')) + (al.length > 3 ? ' 외 ' + (al.length - 3) : '') + '</td>' +
        '<td class="m-keep m-tail">' + (t.active ? '<span class="chip chip-done">사용</span>' : '<span class="chip chip-hold">비활성</span>') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="5" class="text-center text-slate-400 py-8">조건에 맞는 터미널이 없습니다.</td></tr>';
  }

  function renderTerminals() {
    var el = document.getElementById('tab-terminals');
    if (!tBuilt) {
      el.innerHTML = tShell(); tBuilt = true;
      TJ.selectAll('tj_terminals?select=region&order=id').then(function (rs) {
        var regions = [...new Set(rs.map(function (r) { return r.region; }).filter(Boolean))].sort();
        document.getElementById('t-region').innerHTML = '<option value="">전체 지역</option>' +
          regions.map(function (r) { return '<option>' + TJ.esc(r) + '</option>'; }).join('');
      });
    }
    loadTerminals().catch(function (e) { console.error(e); TJ.toast('터미널 명부를 불러오지 못했습니다.', false); });
  }

  /* ── 상세 ──────────────────────────────────────────────────────────── */
  function tDetail(id) {
    var t = tRows.find(function (x) { return x.id === id; });
    if (!t) return;
    var al = (aliasMap && aliasMap[t.id] || []).filter(function (a) { return a !== t.name; });
    var body = TJ.detailRows([
      ['지역', t.region], ['구분', (t.kinds || []).join(', ')],
      ['상태', t.active ? '사용' : '비활성'], ['다른 표기', al.join(', ')], ['비고', t.note]
    ]);
    var acts = TJ.isAdmin()
      ? '<button class="btn-main px-4 py-2" onclick="TJ.closeSheet();TJMaster.openForm(' + id + ')">수정</button>' +
        '<button class="btn-ghost px-4 py-2" onclick="TJMaster.toggleActive(' + id + ')">' + (t.active ? '비활성으로' : '사용으로') + '</button>'
      : '<button class="btn-ghost px-4 py-2" onclick="TJ.closeSheet()">닫기</button>';
    TJ.openSheet(t.name, body, acts);
  }

  /* ── 추가·수정 폼 (관리자 전용) ───────────────────────────────────── */
  function openForm(id) {
    if (!TJ.isAdmin()) return TJ.toast('관리자만 터미널을 추가·수정할 수 있습니다.', false);
    var t = id ? tRows.find(function (x) { return x.id === id; }) : null;
    var regions = [...new Set(tRows.map(function (x) { return x.region; }).filter(Boolean))].sort();
    var body =
      '<div class="mb-3"><label class="fld-label req">터미널명</label>' +
        '<input id="tm-name" class="fld" value="' + (t ? TJ.esc(t.name) : '') + '" placeholder="예) 동서울종합터미널">' +
        '<div id="tm-dup" class="text-[12px] mt-1"></div></div>' +
      '<div class="mb-3"><label class="fld-label">지역(시도)</label>' +
        '<input id="tm-region" class="fld" list="tm-regions" value="' + (t ? TJ.esc(t.region || '') : '') + '">' +
        '<datalist id="tm-regions">' + regions.map(function (r) { return '<option value="' + TJ.esc(r) + '">'; }).join('') + '</datalist></div>' +
      '<div class="mb-3"><label class="fld-label">구분 <span class="text-[11px] text-slate-400">(여러 개 선택 가능)</span></label>' +
        '<div class="flex flex-wrap gap-2 mt-1">' + KINDS.map(function (k) {
          var on = t && (t.kinds || []).indexOf(k) >= 0;
          return '<label class="flex items-center gap-1.5 text-[13px] px-2.5 py-1.5 rounded-lg border" style="border-color:#d3e3e1">' +
            '<input type="checkbox" class="tm-kind" value="' + k + '"' + (on ? ' checked' : '') + '>' + k + '</label>';
        }).join('') + '</div></div>' +
      '<div class="mb-1"><label class="fld-label">비고</label><input id="tm-note" class="fld" value="' + (t ? TJ.esc(t.note || '') : '') + '"></div>';

    TJ.openSheet(id ? '터미널 수정' : '터미널 추가', body,
      '<button class="btn-main px-4 py-2" onclick="TJMaster.save(' + (id || 'null') + ')">저장</button>' +
      '<button class="btn-ghost px-4 py-2" onclick="TJ.closeSheet()">취소</button>');

    // 중복 경고 — 표기만 다른 같은 터미널이 새로 생기는 것을 막는다
    document.getElementById('tm-name').addEventListener('input', function () {
      var key = normKey(this.value);
      var box = document.getElementById('tm-dup');
      if (!key) { box.innerHTML = ''; return; }
      var hitId = aliasMap ? aliasMap['norm:' + key] : null;
      var hit = tRows.find(function (x) { return normKey(x.name) === key && x.id !== id; }) ||
                (hitId && hitId !== id ? tRows.find(function (x) { return x.id === hitId; }) : null);
      box.innerHTML = hit
        ? '<span style="color:#B45309">⚠ 이미 등록된 터미널과 같아 보입니다: <b>' + TJ.esc(hit.name) + '</b></span>'
        : '<span style="color:#0D9488">사용할 수 있는 이름입니다</span>';
    });
  }

  function save(id) {
    var name = document.getElementById('tm-name').value.trim();
    if (!name) return TJ.toast('터미널명을 입력하세요.', false);
    var kinds = [].slice.call(document.querySelectorAll('.tm-kind:checked')).map(function (c) { return c.value; });
    var payload = {
      name: name,
      region: document.getElementById('tm-region').value.trim() || null,
      kinds: kinds,
      note: document.getElementById('tm-note').value.trim() || null
    };
    var p = id
      ? TJ.update('tj_terminals', 'id=eq.' + id, payload)
      : TJ.insert('tj_terminals', [payload]).then(function (r) {
          // 새 터미널은 이름 자체를 별칭으로도 등록해 이후 검색·이관이 걸리게 한다
          return TJ.insert('tj_terminal_aliases', [{ terminal_id: r[0].id, alias: name, norm: normKey(name) }]).catch(function () {});
        });
    p.then(function () {
      TJ.closeSheet(); TJ.toast(id ? '수정되었습니다' : '터미널이 추가되었습니다');
      TJ.clearCache('terminals'); aliasMap = null;
      loadTerminals();
    }).catch(function (e) { TJ.toast(e.message, false); });
  }

  function toggleActive(id) {
    var t = tRows.find(function (x) { return x.id === id; });
    if (!t) return;
    TJ.update('tj_terminals', 'id=eq.' + id, { active: !t.active })
      .then(function () {
        TJ.closeSheet(); TJ.toast(t.active ? '비활성 처리했습니다' : '사용으로 되돌렸습니다');
        TJ.clearCache('terminals'); loadTerminals();
      }).catch(function (e) { TJ.toast(e.message, false); });
  }

  /* ══════════════ 장비 현황 ══════════════ */
  var eBuilt = false;

  function eShell() {
    return '' +
    '<div class="panel">' +
      '<div class="panel-head"><span class="panel-dot"></span>장비 현황<span class="panel-sub">터미널을 고르면 구축 장비와 예비품을 보여줍니다</span></div>' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<select id="e-terminal" class="fld" style="max-width:320px"><option value="">터미널 선택</option></select>' +
        '<span id="e-count" class="text-[12.5px] text-slate-500 font-semibold"></span>' +
      '</div>' +
    '</div>' +
    '<div id="e-body"></div>';
  }

  function renderEquip() {
    var el = document.getElementById('tab-equip');
    if (!eBuilt) {
      el.innerHTML = eShell(); eBuilt = true;
      TJ.selectAll('tj_terminal_equipment?select=terminal_id&order=id').then(function (rows) {
        var ids = [...new Set(rows.map(function (r) { return r.terminal_id; }))];
        return TJ.master.terminals().then(function (ts) {
          var tmap = TJ.indexBy(ts, 'id');
          var list = ids.map(function (i) { return tmap[i]; }).filter(Boolean)
            .sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
          document.getElementById('e-count').textContent = '장비 등록 터미널 ' + TJ.num(list.length) + '개';
          document.getElementById('e-terminal').innerHTML = '<option value="">터미널 선택</option>' +
            list.map(function (t) { return '<option value="' + t.id + '">' + TJ.esc(t.name) + '</option>'; }).join('');
        });
      }).then(function () {
        document.getElementById('e-terminal').addEventListener('change', function () { showEquip(this.value); });
      }).catch(function (e) { console.error(e); TJ.toast('장비 현황을 불러오지 못했습니다.', false); });
    }
  }

  function showEquip(id) {
    var box = document.getElementById('e-body');
    if (!id) { box.innerHTML = ''; return; }
    Promise.all([
      TJ.select('tj_terminal_equipment?select=category,qty,installed_at&terminal_id=eq.' + id + '&order=category'),
      TJ.select('tj_terminal_spares?select=part_name,qty,checked_at&terminal_id=eq.' + id + '&order=part_name')
    ]).then(function (r) {
      var eq = r[0], sp = r[1];
      var tbl = function (title, rows2, cols) {
        return '<div class="panel"><div class="panel-head"><span class="panel-dot"></span>' + title +
          '<span class="panel-sub">' + rows2.length + '건</span></div>' +
          (rows2.length ? '<div class="overflow-x-auto"><table class="rtbl"><thead><tr>' +
            cols.map(function (c) { return '<th>' + c[0] + '</th>'; }).join('') + '</tr></thead><tbody>' +
            rows2.map(function (x) {
              return '<tr>' + cols.map(function (c) { return '<td>' + TJ.esc(x[c[1]] == null ? '-' : x[c[1]]) + '</td>'; }).join('') + '</tr>';
            }).join('') + '</tbody></table></div>'
            : '<div class="text-[13px] text-slate-400">등록된 자료가 없습니다.</div>') + '</div>';
      };
      box.innerHTML =
        tbl('구축·운영 장비', eq, [['항목', 'category'], ['수량', 'qty'], ['설치시기', 'installed_at']]) +
        tbl('보유 예비품', sp, [['품목', 'part_name'], ['수량', 'qty'], ['확인일', 'checked_at']]);
    });
  }

  window.TJMaster = {
    apply: function () {
      TFL.region = document.getElementById('t-region').value;
      TFL.kind = document.getElementById('t-kind').value;
      TFL.q = document.getElementById('t-q').value.trim();
      TFL.showInactive = document.getElementById('t-inactive').checked;
      paintTerminals();
    },
    detail: tDetail, openForm: openForm, save: save, toggleActive: toggleActive
  };

  TJ.registerTab('terminals', renderTerminals);
  TJ.registerTab('equip', renderEquip);
})();
