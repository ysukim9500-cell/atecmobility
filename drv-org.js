/* ═══════════════════════════════════════════════════════════════════════════
   drv-org.js — 조직도 · 결재선 (운행일지 관리자)
   ---------------------------------------------------------------------------
   · 조직도(driving_org)는 결재선을 짜기 위한 사람 목록이다. 앱 계정이 없는 사람도 들어 있다.
     결재를 누르려면 계정이 있어야 하므로, 사람마다 '계정 연결'을 보여 준다.
   · 결재선(driving_approval_lines)은 부서 단위다. 키는 본부 / 팀 / "팀/센터·파트".
     직원이 상신 창을 열면 자기 소속에서 가장 가까운 결재선이 미리 채워진다
     (센터·파트 → 팀 → 본부 순). 직원은 빼거나 더할 수 있다.
   · 사람을 지우지 않는다. '내리기'는 active=false 로 감출 뿐이다(기록이 남는다).
   · 쓰기는 서버 정책이 운행일지 관리자에게만 허락한다(화면에서 막는 것은 안내일 뿐).
   ═══════════════════════════════════════════════════════════════════════════ */
(window.DrvExtQ = window.DrvExtQ || []).push(function (C) {
  'use strict';
  var $ = C.$, esc = C.esc, ic = C.ic, n0 = C.n0;
  var BOXES = C.BOXES.slice(1);                 // 팀장 · 실장 · 사업부장 · 대표이사 (담당 = 상신자 본인)
  var RANKS = ['대표이사', '부사장', '전무', '상무', '이사', '수석', '책임', '선임', '사원', '대표', '차장'];

  var SEL = '';                                 // 고른 부서 키: '' = 전체, 'A' 본부, 'A|B' 팀, 'A|B|C' 센터·파트
  var Q = '';                                   // 사람 찾기
  var LEDIT = null;                             // 결재선 편집 중: { key, steps:[{box, users:[], pick}] }

  function nodeKey(o, depth) { return [o.division, o.team, o.unit].slice(0, depth).join('|'); }
  function parts(k) { return k ? k.split('|') : []; }
  /** 결재선 키 — 본부는 본부 이름, 팀은 팀 이름, 센터·파트는 "팀/센터". (팀 이름이 앱의 '소속'과 같다) */
  function lineKey(k) {
    var p = parts(k);
    if (!p.length) return '';
    if (p.length === 1) return p[0];
    if (p.length === 2) return p[1] || p[0];
    return (p[1] ? p[1] + '/' : '') + p[2];
  }
  function inNode(o, k) {
    var p = parts(k);
    return (!p[0] || o.division === p[0]) && (p.length < 2 || o.team === p[1]) && (p.length < 3 || o.unit === p[2]);
  }
  function nodeName(k) { var p = parts(k); return p.length ? (p[p.length - 1] || p[p.length - 2]) : '전체'; }

  /** 그 부서에 적용되는 결재선과, 어디서 물려받았는지. */
  function lineOf(k) {
    var S = C.state(), p = parts(k);
    var tries = [];
    if (p.length === 3) tries.push([k, lineKey(k)]);
    if (p.length >= 2 && p[1]) tries.push([p.slice(0, 2).join('|'), p[1]]);
    if (p.length >= 1) tries.push([p[0], p[0]]);
    for (var i = 0; i < tries.length; i++) {
      var l = S.LINES[tries[i][1]];
      if (l && Array.isArray(l.steps) && l.steps.length) return { line: l, own: i === 0, from: tries[i][0], key: tries[i][1] };
    }
    return null;
  }
  function stepUsers(s) { return s.approver ? [s.approver] : (s.candidates || []).slice(); }
  function who(u) {
    var S = C.state(), o = S.ORG.filter(function (x) { return x.username === u; })[0];
    var p = S.PEOPLE[u] || {};
    return { name: (o && o.name) || p.name || u, rank: (o && o.rank) || p.position || '', has: !!S.PEOPLE[u] };
  }
  function stepsHtml(steps) {
    return '<div class="oline">' + '<span class="ostep me"><em>담당</em><b>상신자 본인</b></span>' +
      steps.map(function (s) {
        var us = stepUsers(s);
        return '<span class="oarrow">→</span><span class="ostep"><em>' + esc(s.box || '') + '</em>' +
          (us.length > 1 ? '<span class="dim">' + esc(s.pick || '후보') + ' 중 1명</span>' : '') +
          us.map(function (u) {
            var w = who(u);
            return '<b' + (w.has ? '' : ' class="nouser" title="앱 계정이 없어 결재를 누를 수 없습니다"') + '>' +
              esc(w.name) + (w.rank ? ' <small>' + esc(w.rank) + '</small>' : '') + '</b>';
          }).join('') + '</span>';
      }).join('') + '</div>';
  }

  /* ══════════════════ 화면 ══════════════════ */
  function viewOrg() {
    var S = C.state();
    if (!S.LOADED) return C.head('조직도 · 결재선') + C.skeleton();
    var org = S.ORG;
    var linked = org.filter(function (o) { return o.username; }).length;
    var lineN = Object.keys(S.LINES).filter(function (k) { return (S.LINES[k].steps || []).length; }).length;
    var h = C.head('조직도 · 결재선', n0(org.length) + '명 · 앱 계정 연결 ' + n0(linked) + '명 · 결재선 ' + n0(lineN) + '곳');

    // ── 왼쪽: 부서 나무 ──
    var tree = {}, order = [], first = {};
    org.forEach(function (o) {
      [1, 2, 3].forEach(function (d) {
        if (d === 2 && !o.team) return;
        if (d === 3 && !o.unit) return;
        var k = d === 3 && !o.team ? [o.division, '', o.unit].join('|') : nodeKey(o, d);
        if (!tree[k]) { tree[k] = 0; first[k] = order.length; order.push(k); }
        tree[k]++;
      });
    });
    // 본부 → 팀 → 센터·파트로 묶는다. 처음 나온 순서대로만 늘어놓으면, 나중에 만든 팀이
    // 다른 본부 아래에 그려진다(목록의 순번이 본부별로 이어져 있지 않을 때).
    var rankOf = function (k) {
      var p = parts(k), r = [first[p[0]]];
      if (p.length >= 2) { var tk = p.slice(0, 2).join('|'); r.push(first[tk] != null ? first[tk] : first[k]); }
      if (p.length === 3) r.push(first[k]);
      return r;
    };
    order.sort(function (a, b) {
      var x = rankOf(a), y = rankOf(b);
      for (var i = 0; i < Math.max(x.length, y.length); i++) {
        if (x[i] == null) return -1;                 // 윗부서가 먼저
        if (y[i] == null) return 1;
        if (x[i] !== y[i]) return x[i] - y[i];
      }
      return 0;
    });
    var left = '<button class="onode root' + (SEL === '' ? ' on' : '') + '" data-onode="">전체 <span class="c">' + n0(org.length) + '</span></button>' +
      order.map(function (k) {
        var d = parts(k).length, has = lineOf(k), own = has && has.own;
        return '<button class="onode d' + d + (SEL === k ? ' on' : '') + '" data-onode="' + esc(k) + '">' +
          '<span class="nm">' + esc(nodeName(k)) + '</span>' +
          (own ? '<span class="dot ok" title="결재선이 지정돼 있습니다"></span>' : '') +
          '<span class="c">' + n0(tree[k]) + '</span></button>';
      }).join('');

    // ── 오른쪽: 결재선 + 사람 ──
    var right = '';
    if (SEL) {
      var eff = lineOf(SEL), lk = lineKey(SEL);
      right += '<div class="ocard"><div class="ohd"><b>' + esc(nodeName(SEL)) + ' 결재선</b>' +
        (eff ? (eff.own ? '<span class="st ok">이 부서에 지정됨</span>'
          : '<span class="st dim">' + esc(nodeName(eff.from)) + ' 결재선을 따름</span>')
          : '<span class="st warn">지정된 결재선이 없습니다</span>') +
        '<span style="flex:1"></span>' +
        (eff && eff.own ? '<button class="btn sm" data-olinedel="' + esc(lk) + '">지정 풀기</button>' : '') +
        '<button class="btn sm pri" data-olineedit="' + esc(SEL) + '">' + (eff && eff.own ? '고치기' : '이 부서 결재선 지정') + '</button></div>' +
        (eff ? stepsHtml(eff.line.steps)
          : '<div class="anote" style="margin-top:8px">결재선이 없으면 직원이 상신할 때 결재자를 직접 찾아 넣어야 합니다.</div>') +
        '</div>';
    } else {
      right += '<div class="ocard"><div class="anote" style="margin:0">왼쪽에서 부서를 고르면 그 부서의 <b>결재선</b>을 지정할 수 있습니다. ' +
        '센터·파트에 결재선이 없으면 팀 것을, 팀에도 없으면 본부 것을 따릅니다. ' +
        '직원은 상신할 때 미리 채워진 결재선에서 빼거나 더할 수 있습니다.</div></div>';
    }

    var q = Q.trim().toLowerCase();
    var people = org.filter(function (o) {
      if (!inNode(o, SEL)) return false;
      if (!q) return true;
      return [o.name, o.rank, o.role, o.duty, o.team, o.unit, o.username || ''].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    right += '<div class="bar" style="margin-top:14px"><label class="field">' + ic('search', 14) +
      '<input id="orgQ" aria-label="사람 찾기" placeholder="이름·직급·업무로 찾기" value="' + esc(Q) + '"></label>' +
      '<div class="sp" style="flex:1"></div>' +
      '<button class="btn sm pri" data-oadd>＋ 사람 추가</button></div>';
    right += people.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>이름</th><th>직급</th><th>직책</th><th>소속</th><th>담당 업무</th><th>앱 계정</th><th></th></tr></thead><tbody>' +
      people.map(function (o) {
        var acct = o.username
          ? (S.PEOPLE[o.username] ? '<span class="st ok">' + esc(o.username) + '</span>'
            : '<span class="st bad" title="연결한 계정이 없어졌습니다">' + esc(o.username) + '</span>')
          : '<span class="st dim">없음</span>';
        return '<tr><td><span class="lead">' + esc(o.name) + '</span>' + (o.outsourced ? ' <span class="kind">외주</span>' : '') + '</td>' +
          '<td>' + esc(o.rank || '—') + '</td>' +
          '<td>' + (o.role ? '<span class="kind biz">' + esc(o.role) + '</span>' : '<span class="dim">—</span>') + '</td>' +
          '<td class="el dim" title="' + esc([o.team, o.unit].filter(Boolean).join(' › ') || o.division) + '">' +
          esc([o.team, o.unit].filter(Boolean).join(' › ') || o.division) + '</td>' +
          '<td class="el" title="' + esc(o.duty || '') + '">' + esc(o.duty || '') + '</td>' +
          '<td>' + acct + '</td>' +
          // 「내리기」는 고치기 창 안에 있다 — 줄마다 두면 표가 넘쳐 잘리고, 「고치기」 옆이라 잘못 누르기 쉽다.
          '<td class="n" style="white-space:nowrap"><button class="btn sm" data-oedit="' + o.id + '" aria-label="' +
          esc(o.name) + ' 고치기">고치기</button></td></tr>';
      }).join('') + '</tbody></table></div></div>'
      : '<div class="panel"><div class="blank"><div class="t">' + (q ? '찾는 사람이 없습니다.' : '이 부서에 사람이 없습니다.') + '</div></div></div>';

    // ★ <aside> 를 쓰지 않는다 — 좌측 메뉴(aside)의 폭·고정 위치·좁은 화면 감춤 규칙을 그대로 물려받는다.
    h += '<div class="orgwrap"><nav class="otree" aria-label="부서">' + left + '</nav><div class="omain">' + right + '</div></div>';
    h += '<div class="anote">결재를 누르려면 <b>앱 계정</b>이 있어야 합니다. 계정이 없는 사람을 결재선에 넣으면 그 칸에서 결재가 멈춥니다 — ' +
      '먼저 앱에서 가입하게 한 뒤 「고치기」에서 계정을 이어 주세요. 퇴사·이동한 사람은 「고치기」 창의 <b>목록에서 내리기</b>로 감춥니다(기록은 남습니다).</div>';
    return h;
  }

  /* ══════════════════ 사람 추가·고치기 ══════════════════ */
  function openPerson(id) {
    var S = C.state();
    var o = id ? S.ORG.filter(function (x) { return String(x.id) === String(id); })[0] : null;
    var p = parts(SEL);
    var v = o || { division: p[0] || '', team: p[1] || '', unit: p[2] || '', name: '', rank: '', role: '', duty: '', username: '', outsourced: false };
    var uniq = function (f) {
      var s = {};
      S.ORG.forEach(function (x) { if (x[f]) s[x[f]] = 1; });
      return Object.keys(s).sort(function (a, b) { return a.localeCompare(b, 'ko'); });
    };
    var dl = function (idn, list) {
      return '<datalist id="' + idn + '">' + list.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist>';
    };
    // 계정 고르기 — 아직 아무에게도 안 이어진 계정 + 이 사람의 지금 계정
    var used = {};
    S.ORG.forEach(function (x) { if (x.username && (!o || x.id !== o.id)) used[x.username] = 1; });
    var accts = Object.keys(S.PEOPLE).filter(function (u) { return !used[u]; })
      .sort(function (a, b) { return C.nameOf(a).localeCompare(C.nameOf(b), 'ko'); });
    var fld = function (label, body, hint, forId) {
      return '<div class="frow"><label class="flab"' + (forId ? ' for="' + forId + '"' : '') + '>' + label + '</label><div class="fbody">' + body +
        (hint ? '<div class="fhint">' + hint + '</div>' : '') + '</div></div>';
    };
    C.openPanel(o ? '사람 고치기' : '사람 추가', o ? o.name : (nodeName(SEL) === '전체' ? '' : nodeName(SEL)),
      '<div class="form">' +
      fld('이름', '<input class="inp" id="oName" maxlength="30" value="' + esc(v.name) + '">', null, 'oName') +
      fld('본부', '<input class="inp" id="oDiv" list="dlDiv" maxlength="40" value="' + esc(v.division) + '">' + dl('dlDiv', uniq('division')),
        '예) 고객지원사업부 · 용인공장', 'oDiv') +
      fld('팀', '<input class="inp" id="oTeam" list="dlTeam" maxlength="40" value="' + esc(v.team) + '">' + dl('dlTeam', uniq('team')),
        '본부 직속이면 비워 둡니다', 'oTeam') +
      fld('센터·파트', '<input class="inp" id="oUnit" list="dlUnit" maxlength="40" value="' + esc(v.unit) + '">' + dl('dlUnit', uniq('unit')),
        '팀 직속이면 비워 둡니다', 'oUnit') +
      fld('직급', '<input class="inp" id="oRank" list="dlRank" maxlength="20" value="' + esc(v.rank) + '">' + dl('dlRank', RANKS), null, 'oRank') +
      fld('직책', '<input class="inp" id="oRole" list="dlRole" maxlength="20" value="' + esc(v.role) + '">' +
        dl('dlRole', ['사업부장', '공장장', '실장', '팀장', '센터장', '파트장']), '없으면 비워 둡니다', 'oRole') +
      fld('담당 업무', '<input class="inp" id="oDuty" maxlength="80" value="' + esc(v.duty) + '">', null, 'oDuty') +
      fld('앱 계정', '<select class="inp" id="oUser"><option value="">없음 (아직 가입 전)</option>' +
        accts.map(function (u) {
          var pp = S.PEOPLE[u] || {};
          return '<option value="' + esc(u) + '"' + (v.username === u ? ' selected' : '') + '>' +
            esc(C.nameOf(u)) + ' · ' + esc(pp.dept || '') + ' · ' + esc(u) + '</option>';
        }).join('') + '</select>', '계정이 있어야 결재를 누를 수 있습니다. 같은 이름이 둘이면 소속을 보고 고르세요', 'oUser') +
      fld('외주', '<label class="radio"><input type="checkbox" id="oOut"' + (v.outsourced ? ' checked' : '') + '><span>외주·협력사 인원</span></label>') +
      '</div>',
      (o ? '<button class="btn" data-ooff="' + o.id + '">목록에서 내리기</button>' : '') +
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="oSave" data-id="' + (o ? o.id : '') + '">' + (o ? '저장' : '추가') + '</button>');
    var nm = $('oName'); if (nm && !o) nm.focus();
    P_INIT = personSig();
  }
  /** 사람 창에 지금 들어 있는 값(고친 것이 있는지 견주는 데 쓴다). */
  var P_INIT = '';
  function personSig() {
    return ['oName', 'oDiv', 'oTeam', 'oUnit', 'oRank', 'oRole', 'oDuty', 'oUser'].map(function (i) {
      return String(($(i) || {}).value || '');
    }).join('\u0001') + '\u0001' + ((($('oOut') || {}).checked) ? 1 : 0);
  }
  /** 닫기 전에 되물어야 하는가 — 사람 창·결재선 창에서 실제로 바꾼 것이 있을 때만. */
  function dirty() {
    if ($('lSave') && LEDIT) { readLine(); return JSON.stringify(LEDIT.steps) !== LEDIT.init; }
    if ($('oSave')) return personSig() !== P_INIT;
    return false;
  }
  function reloadOrg() {
    return C.fetchAll('/rest/v1/driving_org?select=*&active=eq.true&order=sort.asc,id.asc')
      .then(function (rows) { C.setOrg(rows); });
  }
  function fail(r, what) {
    return r.text().then(function (t) {
      var msg = r.status === 401 || r.status === 403 || /row-level security|permission/i.test(t)
        ? '권한이 없습니다. 운행일지 관리자만 고칠 수 있습니다.' : what + '하지 못했습니다.';
      console.error(what, r.status, t);
      throw new Error(msg);
    });
  }
  function savePerson(id) {
    var val = function (i) { return String(($(i) || {}).value || '').trim(); };
    var row = {
      name: val('oName'), division: val('oDiv'), team: val('oTeam'), unit: val('oUnit'),
      rank: val('oRank'), role: val('oRole'), duty: val('oDuty'),
      username: val('oUser') || null, outsourced: !!($('oOut') || {}).checked,
      updated_by: C.myName(), updated_at: new Date().toISOString()
    };
    if (!row.name) { C.toast('이름을 넣어 주세요.', true); $('oName').focus(); return; }
    if (!row.division) { C.toast('본부를 넣어 주세요.', true); $('oDiv').focus(); return; }
    if (row.unit && !row.team && row.division) {
      // 팀 없이 파트만 있는 구조(예: 용인공장 › 자재파트)는 팀 자리에 적는다 — 나무가 두 갈래로 갈리지 않게.
      row.team = row.unit; row.unit = '';
    }
    var btn = $('oSave'); if (btn) btn.disabled = true;
    var S = C.state();
    if (!id) {
      var same = S.ORG.filter(function (x) { return x.division === row.division && x.team === row.team && x.unit === row.unit; });
      row.sort = same.reduce(function (m, x) { return Math.max(m, x.sort || 0); }, 0) + 1;
    }
    var req = id
      ? C.apiRetry('/rest/v1/driving_org?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) })
      : C.apiRetry('/rest/v1/driving_org', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
    req.then(function (r) { if (!r.ok) return fail(r, '저장'); })
      .then(reloadOrg)
      .then(function () { C.closePanel(); C.toast(id ? '고쳤습니다.' : row.name + ' 님을 추가했습니다.'); C.render(); })
      .catch(function (e) { if (btn) btn.disabled = false; C.toast((e && e.message) || '저장하지 못했습니다.', true); });
  }
  function askOff(id) {
    var S = C.state(), o = S.ORG.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!o) return;
    // 이 사람이 들어 있는 결재선 — 내리기 전에 알려 준다.
    var inLines = o.username ? Object.keys(S.LINES).filter(function (k) {
      return (S.LINES[k].steps || []).some(function (s) { return stepUsers(s).indexOf(o.username) >= 0; });
    }) : [];
    C.openPanel('목록에서 내리기', o.name + ' · ' + [o.team, o.unit].filter(Boolean).join(' › '),
      '<div class="anote" style="margin-top:0"><b>' + esc(o.name) + '</b> 님을 조직도에서 내립니다. 기록은 지워지지 않고 목록에서만 사라집니다. ' +
      '앱 계정과 운행 기록에는 아무 영향이 없습니다.</div>' +
      (inLines.length ? '<div class="awarn">' + ic('alert', 15) + '<span>이 분은 <b>' + esc(inLines.join(' · ')) +
        '</b> 결재선에 들어 있습니다. 내려도 결재선에서는 빠지지 않으니, 결재선도 고쳐 주세요.</span></div>' : ''),
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="oOffGo" data-id="' + o.id + '">내리기</button>');
  }
  function runOff(id) {
    C.apiRetry('/rest/v1/driving_org?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ active: false, updated_by: C.myName(), updated_at: new Date().toISOString() })
    }).then(function (r) { if (!r.ok) return fail(r, '내리기'); })
      .then(reloadOrg)
      .then(function () { C.closePanel(); C.toast('목록에서 내렸습니다.'); C.render(); })
      .catch(function (e) { C.toast((e && e.message) || '내리지 못했습니다.', true); });
  }

  /* ══════════════════ 결재선 편집 ══════════════════ */
  function openLine(k) {
    var eff = lineOf(k);
    LEDIT = {
      node: k, key: lineKey(k),
      steps: eff ? eff.line.steps.map(function (s) { return { box: s.box || '', users: stepUsers(s), pick: s.pick || '' }; }) : []
    };
    if (!LEDIT.steps.length) LEDIT.steps.push({ box: '팀장', users: [], pick: '' });
    LEDIT.init = JSON.stringify(LEDIT.steps);
    paintLine();
  }
  /** 결재자로 고를 수 있는 사람 — 앱 계정이 있는 사람. 이 부서와 가까운 사람이 위로 온다. */
  function pickList(k) {
    var S = C.state(), p = parts(k), seen = {}, out = [];
    var score = function (o) {
      return (o.division === p[0] ? 0 : 4) + (p[1] && o.team === p[1] ? 0 : 2) + (o.role ? 0 : 1);
    };
    S.ORG.filter(function (o) { return o.username && S.PEOPLE[o.username]; })
      .sort(function (a, b) { return score(a) - score(b) || a.sort - b.sort; })
      .forEach(function (o) {
        seen[o.username] = 1;
        out.push({ u: o.username, label: o.name + ' · ' + [o.rank, o.role].filter(Boolean).join(' ') + ' · ' + ([o.team, o.unit].filter(Boolean).join(' › ') || o.division) });
      });
    // 조직도에 없는 앱 계정(본부 밖 임원 등)도 결재자가 될 수 있다.
    Object.keys(S.PEOPLE).filter(function (u) { return !seen[u]; })
      .sort(function (a, b) { return C.nameOf(a).localeCompare(C.nameOf(b), 'ko'); })
      .forEach(function (u) {
        var pp = S.PEOPLE[u];
        out.push({ u: u, label: C.nameOf(u) + ' · ' + [pp.position, pp.dept].filter(Boolean).join(' · ') + ' · (조직도 밖)' });
      });
    return out;
  }
  function readLine() {
    if (!LEDIT) return;
    LEDIT.steps.forEach(function (s, i) {
      var b = document.querySelector('[data-lbox="' + i + '"]'); if (b) s.box = b.value;
      var p = document.querySelector('[data-lpick="' + i + '"]'); if (p) s.pick = p.value.trim();
    });
  }
  function paintLine() {
    var list = pickList(LEDIT.node);
    var body = '<div class="anote" style="margin-top:0">위에서 아래 순서로 결재합니다. <b>칸</b>은 운행기록부 결재란의 어느 칸에 이름이 찍히는지입니다(쓰지 않는 칸은 빗금). ' +
      '한 단계에 <b>두 명 이상</b> 넣으면 직원이 상신할 때 그중 한 명을 고릅니다(예: 센터장이 여럿인 팀).</div>' +
      '<div class="lsteps"><div class="lstep me"><span class="lseq">본</span><span class="lwho"><b>상신자 본인</b></span><span class="lbox">담당</span></div>';
    LEDIT.steps.forEach(function (s, i) {
      var opts = list.filter(function (x) { return s.users.indexOf(x.u) < 0; });
      body += '<div class="lstep"><span class="lseq">' + (i + 1) + '</span><span class="lwho">' +
        (s.users.length ? s.users.map(function (u) {
          var w = who(u);
          return '<span class="lchip' + (w.has ? '' : ' bad') + '">' + esc(w.name) + (w.rank ? ' <small>' + esc(w.rank) + '</small>' : '') +
            '<button data-lrm="' + i + ':' + esc(u) + '" aria-label="' + esc(w.name) + ' 빼기">' + ic('close', 11) + '</button></span>';
        }).join('') : '<span class="dim">결재자를 골라 주세요</span>') +
        '<select class="inp" data-ladd="' + i + '" aria-label="' + (i + 1) + '단계 결재자 고르기"><option value="">' +
        (s.users.length ? '＋ 후보 더 넣기' : '결재자 고르기') + '</option>' +
        opts.map(function (x) { return '<option value="' + esc(x.u) + '">' + esc(x.label) + '</option>'; }).join('') + '</select>' +
        (s.users.length > 1 ? '<input class="inp" data-lpick="' + i + '" maxlength="12" placeholder="고를 때 보일 이름 (예: 센터장)" value="' + esc(s.pick) + '">' : '') +
        '</span><select class="inp lbox" data-lbox="' + i + '" aria-label="' + (i + 1) + '단계 결재란 칸">' +
        BOXES.map(function (b) { return '<option value="' + b + '"' + (s.box === b ? ' selected' : '') + '>' + b + '</option>'; }).join('') +
        '</select><button class="iconbtn sm" data-ldel="' + i + '" aria-label="' + (i + 1) + '단계 빼기">' + ic('close', 14) + '</button></div>';
    });
    body += '</div>' + (LEDIT.steps.length < 4 ? '<button class="btn sm" data-lmore>＋ 단계 추가</button>' : '');
    C.openPanel(nodeName(LEDIT.node) + ' 결재선', '적용 부서: ' + LEDIT.key, body,
      '<span style="flex:1"></span><button class="btn" data-close>취소</button><button class="btn pri" id="lSave">저장</button>', true);
  }
  function saveLine() {
    readLine();
    var steps = LEDIT.steps;
    if (!steps.length) { C.toast('결재 단계를 하나 이상 넣어 주세요.', true); return; }
    for (var i = 0; i < steps.length; i++) {
      if (!steps[i].users.length) { C.toast((i + 1) + '단계의 결재자를 골라 주세요.', true); return; }
    }
    var boxes = steps.map(function (s) { return s.box; });
    if (boxes.some(function (b, i) { return boxes.indexOf(b) !== i; })) { C.toast('같은 결재란 칸이 두 번 들어 있습니다.', true); return; }
    var all = [].concat.apply([], steps.map(function (s) { return s.users; }));
    if (all.some(function (u, i) { return all.indexOf(u) !== i; })) { C.toast('같은 사람이 두 단계에 들어 있습니다.', true); return; }
    var row = {
      dept: LEDIT.key, updated_at: new Date().toISOString(),
      steps: steps.map(function (s) {
        return s.users.length === 1 ? { box: s.box, approver: s.users[0] }
          : { box: s.box, candidates: s.users, pick: s.pick || s.box };
      })
    };
    var btn = $('lSave'); if (btn) btn.disabled = true;
    C.apiRetry('/rest/v1/driving_approval_lines?on_conflict=dept', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row)
    }).then(function (r) { if (!r.ok) return fail(r, '저장'); })
      .then(function () { return C.fetchAll('/rest/v1/driving_approval_lines?select=*'); })
      .then(function (rows) {
        C.setLines(rows); LEDIT = null; C.closePanel();
        C.toast(row.dept + ' 결재선을 저장했습니다.'); C.render();
      }).catch(function (e) { if (btn) btn.disabled = false; C.toast((e && e.message) || '저장하지 못했습니다.', true); });
  }
  function askLineDel(key) {
    C.openPanel('결재선 지정 풀기', key,
      '<div class="anote" style="margin-top:0"><b>' + esc(key) + '</b> 에 따로 지정한 결재선을 풉니다. 풀면 윗부서 결재선을 따르고, ' +
      '윗부서에도 없으면 직원이 상신할 때 결재자를 직접 넣습니다. 이미 올라간 결재 건은 바뀌지 않습니다.</div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="lDelGo" data-key="' + esc(key) + '">풀기</button>');
  }
  function runLineDel(key) {
    C.apiRetry('/rest/v1/driving_approval_lines?dept=eq.' + encodeURIComponent(key), { method: 'DELETE', headers: { Prefer: 'return=minimal' } })
      .then(function (r) { if (!r.ok) return fail(r, '풀기'); })
      .then(function () { return C.fetchAll('/rest/v1/driving_approval_lines?select=*'); })
      .then(function (rows) { C.setLines(rows); C.closePanel(); C.toast('결재선 지정을 풀었습니다.'); C.render(); })
      .catch(function (e) { C.toast((e && e.message) || '풀지 못했습니다.', true); });
  }

  /* ══════════════════ 이벤트 ══════════════════ */
  document.addEventListener('click', function (e) {
    var el;
    if ((el = e.target.closest('[data-onode]'))) { SEL = el.dataset.onode; Q = ''; C.render(); return; }
    if (e.target.closest('[data-oadd]')) { openPerson(null); return; }
    if ((el = e.target.closest('[data-oedit]'))) { openPerson(el.dataset.oedit); return; }
    if ((el = e.target.closest('#oSave'))) { savePerson(el.dataset.id); return; }
    if ((el = e.target.closest('[data-ooff]'))) { askOff(el.dataset.ooff); return; }
    if ((el = e.target.closest('#oOffGo'))) { runOff(el.dataset.id); return; }
    if ((el = e.target.closest('[data-olineedit]'))) { openLine(el.dataset.olineedit); return; }
    if ((el = e.target.closest('[data-olinedel]'))) { askLineDel(el.dataset.olinedel); return; }
    if ((el = e.target.closest('#lDelGo'))) { runLineDel(el.dataset.key); return; }
    if (e.target.closest('#lSave')) { saveLine(); return; }
    if (!LEDIT) return;
    if (e.target.closest('[data-lmore]')) {
      readLine();
      var used = LEDIT.steps.map(function (s) { return s.box; });
      LEDIT.steps.push({ box: BOXES.filter(function (b) { return used.indexOf(b) < 0; })[0] || BOXES[BOXES.length - 1], users: [], pick: '' });
      paintLine(); return;
    }
    if ((el = e.target.closest('[data-ldel]'))) { readLine(); LEDIT.steps.splice(+el.dataset.ldel, 1); paintLine(); return; }
    if ((el = e.target.closest('[data-lrm]'))) {
      readLine();
      var p = el.dataset.lrm, i = +p.slice(0, p.indexOf(':')), u = p.slice(p.indexOf(':') + 1);
      LEDIT.steps[i].users = LEDIT.steps[i].users.filter(function (x) { return x !== u; });
      paintLine(); return;
    }
  });
  document.addEventListener('change', function (e) {
    if (LEDIT && e.target.dataset && e.target.dataset.ladd !== undefined && e.target.value) {
      readLine();
      LEDIT.steps[+e.target.dataset.ladd].users.push(e.target.value);
      paintLine();
    }
  });
  var qT = 0, IME = false;
  // 조합이 시작되면 걸어 둔 다시 그리기도 지운다 — 음절 사이에 걸린 타이머가 다음 음절 조합 중에
  // 입력 칸을 갈아 끼우면 글자가 깨진다("김철수" 를 보통 속도로 칠 때).
  document.addEventListener('compositionstart', function (e) { if (e.target.id === 'orgQ') { IME = true; clearTimeout(qT); } });
  document.addEventListener('compositionend', function (e) { if (e.target.id === 'orgQ') { IME = false; search(e.target); } });
  document.addEventListener('input', function (e) { if (e.target.id === 'orgQ' && !IME) search(e.target); });
  /** 한글 조합 중에는 다시 그리지 않는다(글자가 깨진다). */
  function search(box) {
    Q = box.value;
    clearTimeout(qT);
    qT = setTimeout(function () {
      var pos = box.selectionStart;
      C.render();
      var b = $('orgQ'); if (b) { b.focus(); try { b.setSelectionRange(pos, pos); } catch (er) { } }
    }, 200);
  }

  /** 상신 창이 쓴다 — 그 사람 소속에서 가장 가까운 결재선(센터·파트 → 팀 → 본부). */
  function lineForUser(u) {
    var S = C.state(), o = S.ORG.filter(function (x) { return x.username === u; })[0];
    if (!o) return null;
    var k = [o.division, o.team, o.unit].filter(function (x, i) { return i === 0 || x; }).join('|');
    if (!o.team && o.unit) k = [o.division, '', o.unit].join('|');
    var eff = lineOf(k);
    return eff ? eff.line : null;
  }

  return { views: { org: viewOrg }, admin: ['org'], lineForUser: lineForUser, dirty: dirty, onCycle: function () { } };
});
