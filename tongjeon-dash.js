/* ============================================================================
 *  통전망 — 현황 대시보드
 *  기간을 서버에서 걸러 필요한 컬럼만 받아온 뒤 브라우저에서 집계한다.
 * ========================================================================== */
(function () {
  'use strict';

  var DIMS = [
    ['region', '지역별'], ['terminal', '터미널별'], ['intake_category', '접수구분별'],
    ['fault_type', '장애유형별'], ['handle_category', '처리구분별'], ['equip_type1', '장비유형별'],
    ['equip_class', '장비구분별'], ['handler', '처리자별'], ['part', '사용자재별']
  ];
  var DIM = 'intake_category';
  var RANGE = { from: '', to: '' };
  var DATA = null, PARTAGG = null, charts = {};
  var built = false;

  function shell() {
    return '' +
    '<div class="panel" style="padding:16px 18px">' +
      '<div class="flex items-center justify-between mb-3">' +
        '<div class="panel-head" style="margin-bottom:0"><span class="panel-dot"></span>조회 기간<span class="panel-sub">선택하면 아래 전체가 갱신됩니다</span></div>' +
      '</div>' +
      '<div class="flex flex-col gap-2.5">' +
        '<div class="rng-main flex items-center gap-2 flex-wrap">' +
          '<span class="rng-label text-[12.5px] font-extrabold" style="color:var(--tj-deep)">기간</span>' +
          '<input id="d-from" type="date" class="fld" style="width:auto;padding:7px 10px">' +
          '<span class="rng-tilde text-slate-400 text-[12px]">~</span>' +
          '<input id="d-to" type="date" class="fld" style="width:auto;padding:7px 10px">' +
          '<button class="btn-main text-[12.5px] px-4 py-1.5 font-extrabold" onclick="TJDash.apply()">확인</button>' +
        '</div>' +
        '<div class="rng-quick flex items-center gap-2 flex-wrap">' +
          '<button class="btn-ghost text-[12px] px-3 py-1.5" onclick="TJDash.quick(\'month\')">이번 달</button>' +
          '<button class="btn-ghost text-[12px] px-3 py-1.5" onclick="TJDash.quick(90)">90일</button>' +
          '<button class="btn-ghost text-[12px] px-3 py-1.5" onclick="TJDash.quick(365)">1년</button>' +
          '<button class="btn-ghost text-[12px] px-3 py-1.5" onclick="TJDash.quick(0)">전체</button>' +
        '</div>' +
        '<div class="rng-tail flex items-center gap-2 flex-wrap" style="justify-content:space-between">' +
          '<span id="d-summary" class="text-[12.5px] text-slate-500 font-semibold"></span>' +
          '<button class="btn-main text-[12.5px] px-4 py-2 flex items-center gap-1.5" onclick="TJDash.excel()">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '현재 조건 엑셀</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div id="tj-kpi" class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5"></div>' +
    '<div class="panel">' +
      '<div class="flex items-center justify-between flex-wrap gap-2 mb-3">' +
        '<div class="panel-head" style="margin-bottom:0"><span class="panel-dot"></span><span id="dim-title">접수구분별</span> 장애 건수<span class="panel-sub">기준 선택</span></div>' +
        '<div id="tj-dim" class="flex items-center gap-1 rounded-lg p-1 flex-wrap" style="background:#eef8f7">' +
          DIMS.map(function (d) {
            return '<button data-dim="' + d[0] + '" class="dim-btn text-[12px] font-bold px-2.5 py-1 rounded-md' +
              (d[0] === DIM ? ' active' : '') + '" style="' + (d[0] === DIM ? 'background:#0D9488;color:#fff' : 'color:#0D9488') + '">' + d[1] + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="h-[320px] px-1 pb-1"><canvas id="ch-dim"></canvas></div>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="panel-head"><span class="panel-dot"></span>월별 장애 추이<span class="panel-sub">접수 건수</span></div>' +
      '<div class="h-[260px] px-1 pb-1"><canvas id="ch-month"></canvas></div>' +
    '</div>' +
    '<div class="grid lg:grid-cols-2 gap-5">' +
      '<div class="panel"><div class="panel-head"><span class="panel-dot"></span>접수구분<span class="panel-sub">상위 10</span></div><div id="top-intake" class="px-1"></div></div>' +
      '<div class="panel"><div class="panel-head"><span class="panel-dot"></span>장애유형<span class="panel-sub">상위 10</span></div><div id="top-ftype" class="px-1"></div></div>' +
    '</div>';
  }

  /* ── 데이터 ────────────────────────────────────────────────────────── */
  function query() {
    var cols = 'id,received_date,action_date,status,terminal_id,intake_category,fault_type,handle_category,handle_method,equip_type1,equip_class,handler';
    var q = 'tj_faults?select=' + cols + '&order=received_date.desc';
    if (RANGE.from) q += '&received_date=gte.' + RANGE.from;
    if (RANGE.to) q += '&received_date=lte.' + RANGE.to;
    return q;
  }

  /* 같은 기간을 다시 볼 때 5,889건을 또 내려받지 않도록 마지막 조회를 기억한다 */
  var lastKey = null;
  function load(force) {
    var key = query();
    if (!force && lastKey === key && DATA) return Promise.resolve(DATA);
    return TJ.selectAll(key).then(function (rows) {
      DATA = rows; PARTAGG = null; lastKey = key;
      return rows;
    });
  }

  /* ── 집계 ──────────────────────────────────────────────────────────── */
  function keyOf(f, dim, tmap) {
    if (dim === 'region') { var t = tmap[f.terminal_id]; return (t && t.region) || '(미지정)'; }
    if (dim === 'terminal') { var t2 = tmap[f.terminal_id]; return (t2 && t2.name) || '(미지정)'; }
    return f[dim] || '(미입력)';
  }
  function tally(rows, dim, tmap) {
    var m = {};
    rows.forEach(function (f) { var k = keyOf(f, dim, tmap); m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).sort(function (a, b) { return b[1] - a[1]; });
  }

  function barList(entries, el) {
    var max = entries.length ? entries[0][1] : 1;
    var tot = entries.reduce(function (s, e) { return s + e[1]; }, 0) || 1;
    document.getElementById(el).innerHTML = (entries.length ? entries : [['데이터 없음', 0]]).slice(0, 10).map(function (e, i) {
      return '<div class="barrow"><div class="rk">' + (i + 1) + '</div>' +
        '<div class="nm">' + TJ.esc(e[0]) + '</div>' +
        '<div class="bar"><i style="width:' + Math.max(3, e[1] / max * 100) + '%"></i></div>' +
        '<div class="vl">' + TJ.num(e[1]) + '</div>' +
        '<div class="pc">' + (e[1] / tot * 100).toFixed(0) + '%</div></div>';
    }).join('');
  }

  /* ── 렌더 ──────────────────────────────────────────────────────────── */
  function render() {
    var el = document.getElementById('tab-dash');
    if (!built) { el.innerHTML = shell(); built = true; bind(); }
    if (!RANGE.from && !RANGE.to && DATA === null) { RANGE.from = ''; RANGE.to = ''; }
    document.getElementById('d-from').value = RANGE.from;
    document.getElementById('d-to').value = RANGE.to;

    load().then(function (rows) {
      return TJ.master.terminals().then(function (ts) { draw(rows, TJ.indexBy(ts, 'id')); });
    }).catch(function (e) { console.error(e); TJ.toast('현황을 불러오지 못했습니다.', false); });
  }

  function draw(rows, tmap) {
    var open = rows.filter(function (f) { return f.status === '접수' || f.status === '진행중'; }).length;
    var lead = rows.map(function (f) { return TJ.daysBetween(f.received_date, f.action_date); })
                   .filter(function (d) { return d !== null && d >= 0; });
    var avg = lead.length ? (lead.reduce(function (a, b) { return a + b; }, 0) / lead.length).toFixed(1) : '-';
    var label = RANGE.from || RANGE.to ? (RANGE.from || '처음') + ' ~ ' + (RANGE.to || '끝') : '전체 기간';
    document.getElementById('d-summary').textContent = label + ' · ' + TJ.num(rows.length) + '건';

    document.getElementById('tj-kpi').innerHTML = [
      ['접수 건수', TJ.num(rows.length), '#0D9488', label],
      ['미처리', TJ.num(open), open > 0 ? '#EA580C' : '#0D9488', '접수 + 진행중'],
      ['평균 처리기간', avg + (avg === '-' ? '' : '일'), '#0F5A54', '접수 → 조치'],
      ['운영 터미널', TJ.num(Object.keys(tmap).length), '#14B8A6', '명부 등록 기준']
    ].map(function (k) {
      return '<div class="kpi"><div class="kpi-label">' + k[0] + '</div>' +
        '<div class="kpi-val" style="color:' + k[2] + '">' + k[1] + '</div>' +
        '<div class="kpi-sub">' + k[3] + '</div></div>';
    }).join('');

    barList(tally(rows, 'intake_category', tmap), 'top-intake');
    barList(tally(rows, 'fault_type', tmap), 'top-ftype');
    drawDim(rows, tmap);
    drawMonth(rows);
  }

  function drawDim(rows, tmap) {
    if (typeof Chart === 'undefined') return;
    var title = (DIMS.find(function (d) { return d[0] === DIM; }) || [, ''])[1];
    document.getElementById('dim-title').textContent = title;

    var go = function (entries) {
      // 좁은 화면에서 12개를 넣으면 이름이 겹쳐 절반이 사라진다
      var mob = TJ.isMobile();
      var top = entries.slice(0, mob ? 7 : 12);
      if (charts.dim) charts.dim.destroy();
      // 항목 수에 맞춰 차트 높이를 늘려 막대가 뭉개지지 않게 한다
      var box = document.getElementById('ch-dim').parentNode;
      if (box) box.style.height = Math.max(mob ? 230 : 320, top.length * (mob ? 30 : 26) + 40) + 'px';
      charts.dim = new Chart(document.getElementById('ch-dim'), {
        type: 'bar',
        data: { labels: top.map(function (e) { return e[0]; }), datasets: [{ data: top.map(function (e) { return e[1]; }), backgroundColor: '#0D9488', borderRadius: 7, maxBarThickness: 26 }] },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false, layout: { padding: { right: 28 } },
          plugins: {
            legend: { display: false },
            // 이름을 줄여 보여주므로, 손을 대면 전체 이름이 보이게 한다
            tooltip: { callbacks: { title: function (i) { return top[i[0].dataIndex][0]; },
                                    label: function (c) { return TJ.num(c.parsed.x) + '건'; } } }
          },
          scales: {
            x: { beginAtZero: true, grid: { color: '#eef6f5' }, ticks: { font: { size: 11 }, color: '#94a3b8' } },
            y: {
              grid: { display: false },
              ticks: {
                autoSkip: false,                       // 이름을 건너뛰지 않는다
                font: { size: mob ? 11 : 12, weight: '600' }, color: '#475569',
                callback: function (v) {               // 너무 길면 줄여서 겹침을 막는다
                  var s = this.getLabelForValue ? this.getLabelForValue(v) : top[v] && top[v][0];
                  s = String(s == null ? '' : s);
                  var max = mob ? 9 : 16;
                  return s.length > max ? s.slice(0, max - 1) + '…' : s;
                }
              }
            }
          }
        }
      });
    };

    if (DIM !== 'part') return go(tally(rows, DIM, tmap));
    // 사용자재는 별도 테이블 → 한 번만 받아 캐시
    if (PARTAGG) return go(PARTAGG);
    var ids = rows.map(function (r) { return r.id; });
    if (!ids.length) return go([]);
    TJ.master.parts().then(function (ps) {
      var pmap = TJ.indexBy(ps, 'id');
      return TJ.selectAll('tj_fault_parts?select=part_id,fault_id&order=id').then(function (fps) {
        var idset = {}; ids.forEach(function (i) { idset[i] = 1; });
        var m = {};
        fps.forEach(function (fp) {
          if (!idset[fp.fault_id]) return;
          var p = pmap[fp.part_id]; var k = p ? p.name : '(미상)';
          m[k] = (m[k] || 0) + 1;
        });
        PARTAGG = Object.entries(m).sort(function (a, b) { return b[1] - a[1]; });
        go(PARTAGG);
      });
    }).catch(function (e) { console.error(e); go([]); });
  }

  function drawMonth(rows) {
    if (typeof Chart === 'undefined') return;
    var m = {};
    rows.forEach(function (f) { var k = (f.received_date || '').slice(0, 7); if (k) m[k] = (m[k] || 0) + 1; });
    var labels = Object.keys(m).sort();
    if (charts.month) charts.month.destroy();
    charts.month = new Chart(document.getElementById('ch-month'), {
      type: 'line',
      data: {
        labels: labels.map(function (l) { return l.slice(2).replace('-', '.'); }),
        datasets: [{ data: labels.map(function (k) { return m[k]; }), fill: true, tension: .38,
          borderColor: '#0D9488', borderWidth: 3, backgroundColor: 'rgba(13,148,136,.15)',
          pointBackgroundColor: '#fff', pointBorderColor: '#0D9488', pointBorderWidth: 2.5, pointRadius: 3, pointHoverRadius: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return TJ.num(c.parsed.y) + '건'; } } } },
        scales: { y: { beginAtZero: true, grid: { color: '#eef6f5' }, ticks: { font: { size: 11 }, color: '#94a3b8' } },
                  x: { grid: { display: false }, ticks: { font: { size: 11 }, color: '#94a3b8' } } }
      }
    });
  }

  function bind() {
    document.getElementById('tj-dim').addEventListener('click', function (e) {
      var b = e.target.closest('.dim-btn'); if (!b) return;
      DIM = b.dataset.dim;
      document.querySelectorAll('#tj-dim .dim-btn').forEach(function (x) {
        var on = x.dataset.dim === DIM;
        x.style.cssText = on ? 'background:#0D9488;color:#fff' : 'color:#0D9488';
      });
      TJ.master.terminals().then(function (ts) { drawDim(DATA || [], TJ.indexBy(ts, 'id')); });
    });
  }

  window.TJDash = {
    apply: function () {
      RANGE.from = document.getElementById('d-from').value || '';
      RANGE.to = document.getElementById('d-to').value || '';
      render();
    },
    quick: function (kind) {
      if (kind === 'month') { RANGE.from = TJ.monthStart(); RANGE.to = TJ.today(); }
      else if (kind === 0) { RANGE.from = ''; RANGE.to = ''; }
      else {
        var d = new Date(); d.setDate(d.getDate() - kind + 1);
        RANGE.from = d.toISOString().slice(0, 10); RANGE.to = TJ.today();
      }
      render();
    },
    excel: function () {
      if (!DATA || !DATA.length) return TJ.toast('내려받을 자료가 없습니다.', false);
      TJ.master.terminals().then(function (ts) {
        var tmap = TJ.indexBy(ts, 'id');
        var head = ['접수일자', '조치일', '상태', '지역', '터미널', '장비유형', '장비구분', '접수구분', '장애유형', '처리구분', '처리유형', '처리자', '처리기간(일)'];
        var aoa = [head].concat(DATA.map(function (f) {
          var t = tmap[f.terminal_id] || {};
          return [f.received_date, f.action_date || '', f.status, t.region || '', t.name || '',
            f.equip_type1 || '', f.equip_class || '', f.intake_category || '', f.fault_type || '',
            f.handle_category || '', f.handle_method || '', f.handler || '', TJ.daysBetween(f.received_date, f.action_date)];
        }));
        var ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 11 }];
        var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '장애내역');
        var tag = (RANGE.from || '전체').replace(/-/g, '') + '-' + (RANGE.to || '').replace(/-/g, '');
        XLSX.writeFile(wb, '통전망_장애내역_' + tag + '.xlsx');
      });
    }
  };

  TJ.registerTab('dash', render);
})();
