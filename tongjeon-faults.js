/* ============================================================================
 *  통전망 — 장애 관리 (목록 · 입력 · 상태 전환 · 자재 연동)
 *
 *  자재를 쓰면 tj_fault_parts 기록과 함께 tj_stock_moves 에
 *  '사용'(양품 −) / '회수'(불량 +) 이력을 남긴다. 재고는 그 합계로 계산된다.
 * ========================================================================== */
(function () {
  'use strict';

  var PAGE = 100;
  var F = { from: '', to: '', status: '', region: '', terminal: '', q: '' };
  var rows = [], total = 0, offset = 0, built = false, editing = null, partLines = [], ORIGINAL_PARTS = [], busy = false;

  /* ── 목록 ──────────────────────────────────────────────────────────── */
  function shell() {
    return '' +
    '<div class="panel">' +
      '<div class="flex items-center justify-between mb-3">' +
        '<div class="panel-head" style="margin-bottom:0"><span class="panel-dot"></span>장애 목록</div>' +
        '<button class="btn-main px-4 py-2 text-sm flex items-center gap-1.5" onclick="TJFaults.openForm()">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>새 장애 등록</button>' +
      '</div>' +
      '<button class="flt-toggle mb-2.5" style="display:none" onclick="var g=this.parentNode.querySelector(\'.flt-grid\');var c=g.classList.toggle(\'m-collapsed\');this.textContent=c?\'상세 필터 펼치기 ▾\':\'상세 필터 접기 ▴\'">상세 필터 펼치기 ▾</button>' +
      '<div class="flt-grid m-collapsed grid grid-cols-2 md:grid-cols-5 gap-2.5 mb-3">' +
        '<div><label class="flt-label">상태</label><select id="f-status" class="fld"><option value="">전체</option><option>접수</option><option>진행중</option><option>완료</option><option>보류</option></select></div>' +
        '<div><label class="flt-label">지역</label><select id="f-region" class="fld"><option value="">전체</option></select></div>' +
        '<div><label class="flt-label">터미널</label><input id="f-terminal" class="fld" placeholder="터미널명 일부"></div>' +
        '<div><label class="flt-label">시작일</label><input id="f-from" type="date" class="fld"></div>' +
        '<div><label class="flt-label">종료일</label><input id="f-to" type="date" class="fld"></div>' +
      '</div>' +
      '<div class="flex items-center gap-2 flex-wrap">' +
        '<input id="f-q" class="fld" style="max-width:280px" placeholder="🔍 터미널·접수구분·내용·조치 검색">' +
        '<button class="btn-main text-[12.5px] px-4 py-2 font-extrabold" onclick="TJFaults.search()">검색</button>' +
        '<button class="btn-ghost text-[12px] px-3 py-2" onclick="TJFaults.reset()">초기화</button>' +
        '<span id="f-count" class="text-[12.5px] text-slate-500 font-semibold md:ml-auto"></span>' +
      '</div>' +
    '</div>' +
    '<div class="m-list"><div class="panel" style="padding:0;overflow:hidden">' +
      '<div class="overflow-x-auto" style="max-height:640px;overflow-y:auto">' +
        '<table class="rtbl"><thead><tr>' +
          '<th class="m-keep m-date">접수일</th><th class="desk-only">조치일</th><th class="m-keep">터미널</th>' +
          '<th class="desk-only">지역</th><th class="desk-only">장비</th><th class="m-keep">접수구분</th>' +
          '<th class="desk-only">장애유형</th><th class="desk-only">처리구분</th><th class="desk-only">처리자</th>' +
          '<th class="m-keep m-tail">상태</th>' +
        '</tr></thead><tbody id="f-rows"></tbody></table>' +
      '</div>' +
    '</div>' +
    '<div id="f-more" class="text-center py-3"></div></div>';
  }

  function build() {
    var el = document.getElementById('tab-faults');
    el.innerHTML = shell();
    built = true;
    TJ.master.terminals().then(function (ts) {
      var regions = [...new Set(ts.map(function (t) { return t.region; }).filter(Boolean))].sort();
      document.getElementById('f-region').innerHTML = '<option value="">전체</option>' +
        regions.map(function (r) { return '<option>' + TJ.esc(r) + '</option>'; }).join('');
      document.getElementById('f-region').value = F.region;   // 옵션이 생긴 뒤에 복원한다
    });
    document.getElementById('f-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') api.search(); });
  }

  function buildQuery(forCount) {
    var q = 'tj_faults?select=' + (forCount ? 'id' :
      'id,received_date,action_date,status,terminal_id,equip_type1,equip_class,equip_no,intake_category,fault_type,' +
      'request_content,handle_category,handle_method,action_content,receiver,handler,org_id,confirm_doc,note,customer_request');
    if (F.status) q += '&status=eq.' + encodeURIComponent(F.status);
    if (F.from) q += '&received_date=gte.' + F.from;
    if (F.to) q += '&received_date=lte.' + F.to;
    if (F.terminalIds && F.terminalIds.length) q += '&terminal_id=in.(' + F.terminalIds.join(',') + ')';
    if (F.q) {
      // 값에 괄호·쉼표·별표가 있으면 필터 문법이 깨진다 → 큰따옴표로 감싼다
      var safe = '"*' + F.q.replace(/["\\]/g, '') + '*"';
      var v = encodeURIComponent(safe);
      var ors = ['request_content.ilike.' + v, 'action_content.ilike.' + v,
                 'fault_type.ilike.' + v, 'intake_category.ilike.' + v, 'note.ilike.' + v];
      // 터미널명으로도 찾을 수 있게 한다(안내 문구와 실제 동작을 맞춘다)
      if (F.searchTerminalIds && F.searchTerminalIds.length) {
        ors.push('terminal_id.in.(' + F.searchTerminalIds.join(',') + ')');
      }
      q += '&or=(' + ors.join(',') + ')';
    }
    if (!forCount) q += '&order=received_date.desc,id.desc';
    return q;
  }

  /** 지역·터미널 필터는 마스터에서 id 목록으로 바꿔 서버에 넘긴다 */
  function resolveTerminalFilter() {
    return TJ.master.terminals().then(function (ts) {
      // 검색어와 이름이 겹치는 터미널 (검색 대상에 터미널명을 포함시키기 위함)
      F.searchTerminalIds = F.q
        ? ts.filter(function (t) { return String(t.name).indexOf(F.q) >= 0; }).map(function (t) { return t.id; }).slice(0, 300)
        : null;
      if (!F.region && !F.terminal) { F.terminalIds = null; return; }
      var list = ts.filter(function (t) {
        if (F.region && t.region !== F.region) return false;
        if (F.terminal && String(t.name).indexOf(F.terminal) < 0) return false;
        return true;
      }).map(function (t) { return t.id; });
      F.terminalIds = list.length ? list : [-1];   // 매칭 없으면 결과 0건
    });
  }

  function load(append) {
    return resolveTerminalFilter().then(function () {
      return Promise.all([
        TJ.count(buildQuery(true)),
        TJ.api(buildQuery(false), { headers: { 'Range': offset + '-' + (offset + PAGE - 1) } }).then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error(t.slice(0, 200)); });
          return r.json();
        })
      ]);
    }).then(function (res) {
      total = res[0];
      rows = append ? rows.concat(res[1]) : res[1];
      return TJ.master.terminals();
    }).then(function (ts) { paint(TJ.indexBy(ts, 'id')); });
  }

  function paint(tmap) {
    document.getElementById('f-count').textContent = TJ.num(total) + '건';
    document.getElementById('f-rows').innerHTML = rows.length ? rows.map(function (f) {
      var t = tmap[f.terminal_id] || {};
      return '<tr onclick="TJFaults.detail(' + f.id + ')">' +
        '<td class="m-keep m-date whitespace-nowrap">' + TJ.esc(f.received_date) + '</td>' +
        '<td class="desk-only whitespace-nowrap">' + TJ.esc(f.action_date || '-') + '</td>' +
        '<td class="m-keep font-semibold">' + TJ.esc(t.name || '-') + '</td>' +
        '<td class="desk-only">' + TJ.esc(t.region || '-') + '</td>' +
        '<td class="desk-only whitespace-nowrap">' + TJ.esc([f.equip_type1, f.equip_no].filter(Boolean).join(' ') || '-') + '</td>' +
        '<td class="m-keep"><span class="chip chip-type">' + TJ.esc(f.intake_category || '-') + '</span></td>' +
        '<td class="desk-only">' + TJ.esc(f.fault_type || '-') + '</td>' +
        '<td class="desk-only">' + TJ.esc(f.handle_category || '-') + '</td>' +
        '<td class="desk-only">' + TJ.esc(f.handler || '-') + '</td>' +
        '<td class="m-keep m-tail">' + TJ.statusChip(f.status) + '</td></tr>';
    }).join('') : '<tr><td colspan="10" class="text-center text-slate-400 py-8">조건에 맞는 장애가 없습니다.</td></tr>';

    document.getElementById('f-more').innerHTML = rows.length < total ?
      '<button class="btn-ghost px-5 py-2 text-sm" onclick="TJFaults.more()">더 보기 (' + TJ.num(rows.length) + ' / ' + TJ.num(total) + ')</button>' :
      (rows.length ? '<span class="text-[12px] text-slate-400">전체 ' + TJ.num(total) + '건을 모두 표시했습니다</span>' : '');
  }

  /* ── 상세 ──────────────────────────────────────────────────────────── */
  function detail(id) {
    var f = rows.find(function (x) { return x.id === id; });
    if (!f) return;
    Promise.all([TJ.master.terminals(), TJ.master.parts(), TJ.master.orgs(),
      TJ.select('tj_fault_parts?select=part_id,qty&fault_id=eq.' + id)])
      .then(function (r) {
        var t = TJ.indexBy(r[0], 'id')[f.terminal_id] || {};
        var pmap = TJ.indexBy(r[1], 'id'), omap = TJ.indexBy(r[2], 'id');
        var used = r[3].map(function (fp) { var p = pmap[fp.part_id]; return (p ? p.name : '(미상)') + (fp.qty > 1 ? ' ×' + fp.qty : ''); }).join(', ');
        var body = TJ.detailRows([
          ['상태', TJ.statusChip(f.status), true],
          ['접수일', f.received_date], ['조치일', f.action_date],
          ['처리기간', (function () { var d = TJ.daysBetween(f.received_date, f.action_date); return d === null ? '' : d + '일'; })()],
          ['지역', t.region], ['터미널', t.name],
          ['장비', [f.equip_type1, f.equip_class, f.equip_no].filter(Boolean).join(' / ')],
          ['접수구분', f.intake_category], ['장애유형', f.fault_type], ['요청 내용', f.request_content],
          ['처리유형', f.handle_method], ['처리구분', f.handle_category], ['조치 내용', f.action_content],
          ['사용자재', used], ['접수자', f.receiver], ['처리자', f.handler],
          ['소속', (omap[f.org_id] || {}).name], ['확인서', f.confirm_doc],
          ['비고', f.note], ['고객요청', f.customer_request]
        ]);
        var acts = '<button class="btn-main px-4 py-2" onclick="TJ.closeSheet();TJFaults.openForm(' + id + ')">수정</button>' +
          (f.status !== '완료' ? '<button class="btn-ghost px-4 py-2" onclick="TJFaults.quickDone(' + id + ')">완료 처리</button>' : '') +
          (TJ.isAdmin() ? '<button class="btn-warn px-4 py-2" onclick="TJFaults.del(' + id + ')">삭제</button>' : '');
        TJ.openSheet(t.name || '장애 상세', body, acts);
      });
  }

  /* ── 입력·수정 ─────────────────────────────────────────────────────── */
  function openForm(id) {
    editing = id || null;
    partLines = [];
    var f = id ? rows.find(function (x) { return x.id === id; }) : null;
    Promise.all([TJ.master.terminals(), TJ.master.parts(), TJ.master.orgs()]).then(function (r) {
      var ts = r[0], ps = r[1], os = r[2];
      var opt = function (list, sel, val, txt) {
        return '<option value=""></option>' + list.map(function (x) {
          return '<option value="' + x[val] + '"' + (String(sel) === String(x[val]) ? ' selected' : '') + '>' + TJ.esc(x[txt]) + '</option>';
        }).join('');
      };
      var v = function (k) { return f && f[k] != null ? TJ.esc(f[k]) : ''; };
      var html = '<div class="panel tj-form" style="max-width:1100px">' +
        '<div class="panel-head"><span class="panel-dot"></span>' + (id ? '장애 수정' : '새 장애 등록') +
        '<span class="panel-sub">접수 정보만으로도 저장할 수 있습니다</span></div>' +
        '<div class="grid md:grid-cols-3 gap-x-5 gap-y-4">' +
          '<div class="fsec first"><b>접수 정보</b><span>언제 · 어디서</span></div>' +
          '<div><label class="fld-label req">접수일자</label><input id="x-received" type="date" class="fld" value="' + (f ? f.received_date : TJ.today()) + '"></div>' +
          '<div class="md:col-span-2"><label class="fld-label req">터미널</label>' +
            '<select id="x-terminal" class="fld">' + opt(ts.filter(function (t) { return t.active || (f && t.id === f.terminal_id); }), f && f.terminal_id, 'id', 'name') + '</select>' +
            '<div class="text-[11.5px] text-slate-500 mt-1">목록에 없으면 관리자에게 터미널 추가를 요청하세요.</div></div>' +
          '<div><label class="fld-label">장비유형</label><input id="x-etype1" class="fld" value="' + v('equip_type1') + '"></div>' +
          '<div><label class="fld-label">장비구분</label><input id="x-eclass" class="fld" value="' + v('equip_class') + '"></div>' +
          '<div><label class="fld-label">장비번호</label><input id="x-eno" class="fld" value="' + v('equip_no') + '"></div>' +

          '<div class="fsec"><b>장애 내용</b><span>무엇이 · 어떻게</span></div>' +
          '<div><label class="fld-label req">접수구분</label><input id="x-intake" class="fld" list="dl-intake" value="' + v('intake_category') + '"></div>' +
          '<div><label class="fld-label">장애유형</label><input id="x-ftype" class="fld" list="dl-ftype" value="' + v('fault_type') + '"></div>' +
          '<div><label class="fld-label">접수자</label><input id="x-receiver" class="fld" value="' + v('receiver') + '"></div>' +
          '<div class="md:col-span-3"><label class="fld-label">요청 내용</label><textarea id="x-request" class="fld">' + v('request_content') + '</textarea></div>' +

          '<div class="fsec"><b>처리 내역</b><span>조치 · 결과</span></div>' +
          '<div><label class="fld-label">상태</label><select id="x-status" class="fld">' +
            ['접수', '진행중', '완료', '보류'].map(function (s) { return '<option' + (f && f.status === s ? ' selected' : (!f && s === '접수' ? ' selected' : '')) + '>' + s + '</option>'; }).join('') + '</select></div>' +
          '<div><label class="fld-label">조치일</label><input id="x-action" type="date" class="fld" value="' + (f && f.action_date ? f.action_date : '') + '"></div>' +
          '<div><label class="fld-label">처리구분</label><input id="x-hcat" class="fld" list="dl-hcat" value="' + v('handle_category') + '"></div>' +
          '<div><label class="fld-label">처리유형</label><input id="x-hmethod" class="fld" list="dl-hmethod" value="' + v('handle_method') + '"></div>' +
          '<div><label class="fld-label">처리자</label><input id="x-handler" class="fld" value="' + v('handler') + '"></div>' +
          '<div><label class="fld-label">소속</label><select id="x-org" class="fld">' + opt(os, f && f.org_id, 'id', 'name') + '</select></div>' +
          '<div class="md:col-span-3"><label class="fld-label">조치 내용</label><textarea id="x-actioncontent" class="fld">' + v('action_content') + '</textarea></div>' +
          '<div><label class="fld-label">확인서</label><select id="x-confirm" class="fld">' +
            ['', 'O', 'X'].map(function (s) { return '<option' + (f && f.confirm_doc === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>' +
          '<div class="md:col-span-2"><label class="fld-label">비고</label><input id="x-note" class="fld" value="' + v('note') + '"></div>' +

          '<div class="fsec"><b>사용 자재</b><span>저장하면 해당 거점 재고에서 자동 차감됩니다</span></div>' +
          '<div class="md:col-span-3"><div id="x-parts"></div>' +
            '<button class="btn-ghost px-3 py-1.5 text-[12.5px] mt-2" onclick="TJFaults.addPart()">+ 자재 추가</button></div>' +
        '</div>' +
        '<div id="x-msg" class="text-[13px] font-semibold mt-4 min-h-[20px]"></div>' +
        '<div class="form-actions flex items-center gap-2.5 mt-1">' +
          '<button class="btn-main px-6 py-2.5 text-sm" onclick="TJFaults.save()">' + (id ? '수정 저장' : '저장하기') + '</button>' +
          '<button class="btn-ghost px-5 py-2.5 text-sm" onclick="TJFaults.render()">취소</button>' +
        '</div></div>' +
        '<datalist id="dl-intake"></datalist><datalist id="dl-ftype"></datalist>' +
        '<datalist id="dl-hcat"></datalist><datalist id="dl-hmethod"></datalist>';

      document.getElementById('tab-faults').innerHTML = html;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      fillDatalists();
      if (id) {
        TJ.select('tj_fault_parts?select=id,part_id,qty,org_id,recover&fault_id=eq.' + id).then(function (fps) {
          partLines = fps.map(function (x) {
            return { row_id: x.id, part_id: x.part_id, qty: x.qty, org_id: x.org_id, recover: !!x.recover, existing: true };
          });
          ORIGINAL_PARTS = partLines.map(function (l) { return JSON.parse(JSON.stringify(l)); });
          paintParts(ps, os);
        }).catch(function (e) {
          // 기존 자재를 못 읽은 채로 저장하면 이력이 어긋난다 → 폼을 닫는다
          console.error(e);
          TJ.toast('기존 사용자재를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', false);
          api.render();
        });
      } else paintParts(ps, os);
    });
  }

  /* 입력 도우미 목록 — 최근 1,000건에서 쓰이는 값을 모은다.
     (전량을 받을 필요는 없고, 최근 자료면 실제 어휘가 거의 다 들어온다) */
  function fillDatalists() {
    var cols = [['intake_category', 'dl-intake'], ['fault_type', 'dl-ftype'],
                ['handle_category', 'dl-hcat'], ['handle_method', 'dl-hmethod']];
    TJ.select('tj_faults?select=' + cols.map(function (c) { return c[0]; }).join(',') +
              '&order=received_date.desc&limit=1000')
      .then(function (rs) {
        cols.forEach(function (c) {
          var set = [...new Set(rs.map(function (r) { return r[c[0]]; }).filter(Boolean))].sort();
          var dl = document.getElementById(c[1]);
          if (dl) dl.innerHTML = set.map(function (v) { return '<option value="' + TJ.esc(v) + '">'; }).join('');
        });
      }).catch(function () {});
  }

  function paintParts(ps, os) {
    var box = document.getElementById('x-parts');
    if (!box) return;
    var stockOrgs = os.filter(function (o) { return o.has_stock; });
    box.innerHTML = partLines.length ? partLines.map(function (l, i) {
      return '<div class="flex items-center gap-2 mb-2 flex-wrap">' +
        '<select class="fld" style="flex:2 1 200px" onchange="TJFaults.setPart(' + i + ',\'part_id\',this.value)">' +
          '<option value="">자재 선택</option>' +
          ps.map(function (p) { return '<option value="' + p.id + '"' + (l.part_id == p.id ? ' selected' : '') + '>' + TJ.esc(p.name) + '</option>'; }).join('') +
        '</select>' +
        '<input type="number" min="1" class="fld" style="width:80px" value="' + (l.qty || 1) + '" onchange="TJFaults.setPart(' + i + ',\'qty\',this.value)">' +
        '<select class="fld" style="flex:1 1 140px" onchange="TJFaults.setPart(' + i + ',\'org_id\',this.value)">' +
          '<option value="">출고 거점</option>' +
          stockOrgs.map(function (o) { return '<option value="' + o.id + '"' + (l.org_id == o.id ? ' selected' : '') + '>' + TJ.esc(o.name) + '</option>'; }).join('') +
        '</select>' +
        '<label class="text-[12px] text-slate-600 flex items-center gap-1"><input type="checkbox"' + (l.recover ? ' checked' : '') +
          ' onchange="TJFaults.setPart(' + i + ',\'recover\',this.checked)"> 불량품 회수</label>' +
        '<button class="btn-warn px-3 py-1.5 text-[12px]" onclick="TJFaults.delPart(' + i + ')">삭제</button>' +
      '</div>';
    }).join('') : '<div class="text-[12.5px] text-slate-400">사용한 자재가 있으면 추가하세요.</div>';
  }

  /* ── 저장 ──────────────────────────────────────────────────────────── */
  function save() {
    if (busy) return;                       // 두 번 눌러 중복 저장되는 것을 막는다
    var msg = document.getElementById('x-msg');
    var set = function (t, ok) { msg.textContent = t; msg.style.color = ok ? '#16A34A' : '#B91C1C'; };
    var val = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };

    var received = val('x-received'), terminal = val('x-terminal'), intake = val('x-intake');
    if (!received) return set('접수일자를 입력하세요.');
    if (!terminal) return set('터미널을 선택하세요.');
    if (!intake) return set('접수구분을 입력하세요.');
    var status = val('x-status'), action = val('x-action');
    if (status === '완료' && !action) return set('완료 처리하려면 조치일을 입력하세요.');

    var bad = partLines.filter(function (l) { return !l.part_id || !l.org_id; });
    if (bad.length) return set('자재의 품목과 출고 거점을 모두 선택하세요.');

    var payload = {
      received_date: received, action_date: action || null, status: status,
      terminal_id: parseInt(terminal, 10),
      equip_type1: val('x-etype1') || null, equip_class: val('x-eclass') || null, equip_no: val('x-eno') || null,
      intake_category: intake, fault_type: val('x-ftype') || null, request_content: val('x-request') || null,
      handle_category: val('x-hcat') || null, handle_method: val('x-hmethod') || null,
      action_content: val('x-actioncontent') || null,
      receiver: val('x-receiver') || null, handler: val('x-handler') || null,
      org_id: val('x-org') ? parseInt(val('x-org'), 10) : null,
      confirm_doc: val('x-confirm') || null, note: val('x-note') || null
    };

    set('저장 중…', true);
    busy = true;
    var saveBtn = document.querySelector('.form-actions .btn-main');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '.6'; }
    var done = function () {
      busy = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; }
    };
    var p;
    if (editing) {
      payload.updated_at = new Date().toISOString();
      payload.updated_by = (TJ.me() || {}).email || '';
      p = TJ.update('tj_faults', 'id=eq.' + editing, payload).then(function () { return { id: editing }; });
    } else {
      payload.created_by = (TJ.me() || {}).email || '';
      p = TJ.insert('tj_faults', [payload]).then(function (r) { return r[0]; });
    }

    p.then(function (saved) { return syncParts(saved.id); })
      .then(function () {
        done();
        TJ.toast(editing ? '수정되었습니다' : '저장되었습니다');
        editing = null; ORIGINAL_PARTS = [];
        api.render();
      })
      .catch(function (e) { done(); console.error(e); set(e.message || '저장에 실패했습니다.'); });
  }

  /** 자재 연결과 재고 이력을 함께 기록한다.
   *
   *  수정일 때가 까다롭다. 예전에는 기존 줄을 지우고 전부 다시 넣으면서
   *  재고 이력도 한 벌 더 쌓아, 저장을 누를 때마다 재고가 줄었다.
   *  이제는 **바뀐 것만** 계산해서, 빠진 만큼은 되돌리고 늘어난 만큼만 새로 뺀다.
   */
  function syncParts(faultId) {
    var me = (TJ.me() || {}).email || '';
    var key = function (l) { return [l.part_id, l.org_id, l.recover ? 1 : 0].join('|'); };

    // 지금 화면의 줄과, 열었을 때의 줄을 각각 (품목|거점|회수) 단위로 합산
    var now = {}, before = {};
    partLines.forEach(function (l) {
      var k = key(l);
      now[k] = (now[k] || 0) + parseInt(l.qty || 1, 10);
    });
    (editing ? ORIGINAL_PARTS : []).forEach(function (l) {
      var k = key(l);
      before[k] = (before[k] || 0) + parseInt(l.qty || 1, 10);
    });

    var moves = [];
    Object.keys(now).concat(Object.keys(before)).filter(function (k, i, a) { return a.indexOf(k) === i; })
      .forEach(function (k) {
        var diff = (now[k] || 0) - (before[k] || 0);
        if (!diff) return;
        var p = k.split('|');
        var partId = parseInt(p[0], 10), orgId = parseInt(p[1], 10), recover = p[2] === '1';
        // 늘어났으면 그만큼 더 빼고, 줄었으면 그만큼 되돌린다
        moves.push({ org_id: orgId, part_id: partId, state: '양품', qty: -diff,
          reason: diff > 0 ? '사용' : '조정', ref_fault_id: faultId, by_user: me,
          note: diff > 0 ? null: '장애 수정으로 사용 취소' });
        if (recover) {
          moves.push({ org_id: orgId, part_id: partId, state: '불량', qty: diff,
            reason: diff > 0 ? '회수' : '조정', ref_fault_id: faultId, by_user: me,
            note: diff > 0 ? null : '장애 수정으로 회수 취소' });
        }
      });

    // 연결 줄은 통째로 다시 쓴다(수량·회수 여부가 바뀔 수 있으므로)
    var chain = Promise.resolve();
    if (editing) chain = TJ.remove('tj_fault_parts', 'fault_id=eq.' + faultId);
    return chain.then(function () {
      if (!partLines.length) return null;
      return TJ.insert('tj_fault_parts', partLines.map(function (l) {
        return { fault_id: faultId, part_id: parseInt(l.part_id, 10), qty: parseInt(l.qty || 1, 10),
                 org_id: parseInt(l.org_id, 10), recover: !!l.recover };
      }));
    }).then(function () {
      return moves.length ? TJ.insert('tj_stock_moves', moves) : null;
    }).then(function () {
      ORIGINAL_PARTS = partLines.map(function (l) { return JSON.parse(JSON.stringify(l)); });
    });
  }

  /* ── 외부 API ──────────────────────────────────────────────────────── */
  var api = {
    render: function () {
      build();
      document.getElementById('f-status').value = F.status;
      document.getElementById('f-region').value = F.region;
      document.getElementById('f-terminal').value = F.terminal;
      document.getElementById('f-from').value = F.from;
      document.getElementById('f-to').value = F.to;
      document.getElementById('f-q').value = F.q;
      offset = 0;
      load(false).catch(function (e) { console.error(e); TJ.toast('목록을 불러오지 못했습니다.', false); });
    },
    search: function () {
      F.status = document.getElementById('f-status').value;
      F.region = document.getElementById('f-region').value;
      F.terminal = document.getElementById('f-terminal').value.trim();
      F.from = document.getElementById('f-from').value;
      F.to = document.getElementById('f-to').value;
      F.q = document.getElementById('f-q').value.trim();
      offset = 0;
      load(false).catch(function (e) { console.error(e); TJ.toast('검색에 실패했습니다. 검색어를 줄여 보세요.', false); });
    },
    reset: function () { F = { from: '', to: '', status: '', region: '', terminal: '', q: '' }; api.render(); },
    more: function () { offset += PAGE; load(true).catch(function (e) { console.error(e); TJ.toast('추가로 불러오지 못했습니다.', false); }); },
    detail: detail,
    openForm: openForm,
    addPart: function () {
      partLines.push({ part_id: '', qty: 1, org_id: '', recover: false });
      Promise.all([TJ.master.parts(), TJ.master.orgs()]).then(function (r) { paintParts(r[0], r[1]); });
    },
    delPart: function (i) {
      partLines.splice(i, 1);
      Promise.all([TJ.master.parts(), TJ.master.orgs()]).then(function (r) { paintParts(r[0], r[1]); });
    },
    setPart: function (i, k, v) { partLines[i][k] = v; },
    save: save,
    quickDone: function (id) {
      TJ.update('tj_faults', 'id=eq.' + id, { status: '완료', action_date: TJ.today(), updated_at: new Date().toISOString() })
        .then(function () { TJ.closeSheet(); TJ.toast('완료 처리했습니다'); offset = 0; load(false); })
        .catch(function (e) { TJ.toast(e.message, false); });
    },
    del: function (id) {
      if (!confirm('이 장애 기록을 삭제할까요?\n사용한 자재가 있으면 재고를 되돌립니다. 이 작업은 취소할 수 없습니다.')) return;
      var me = (TJ.me() || {}).email || '';
      // 먼저 사용 자재를 되돌린 뒤 삭제한다 (삭제하면 연결이 사라져 되돌릴 수 없다)
      TJ.select('tj_fault_parts?select=part_id,qty,org_id,recover&fault_id=eq.' + id)
        .then(function (fps) {
          var moves = [];
          fps.forEach(function (x) {
            moves.push({ org_id: x.org_id, part_id: x.part_id, state: '양품', qty: x.qty,
              reason: '조정', by_user: me, note: '장애 삭제로 사용 취소' });
            if (x.recover) moves.push({ org_id: x.org_id, part_id: x.part_id, state: '불량', qty: -x.qty,
              reason: '조정', by_user: me, note: '장애 삭제로 회수 취소' });
          });
          return moves.length ? TJ.insert('tj_stock_moves', moves) : null;
        })
        .then(function () { return TJ.remove('tj_faults', 'id=eq.' + id); })
        .then(function () { TJ.closeSheet(); TJ.toast('삭제되었습니다'); offset = 0; load(false); })
        .catch(function (e) { TJ.toast(e.message, false); });
    }
  };
  window.TJFaults = api;
  TJ.registerTab('faults', api.render);
})();
