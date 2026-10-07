/* ═══════════════════════════════════════════════════════════════════════════
   drv-org.js — 조직도 (운행일지 관리자)
   ---------------------------------------------------------------------------
   · 조직도(driving_org)는 **사람 명단**이다(이름·소속·직급·직책·앱 계정). 앱 계정이 없는 사람도 들어 있다.
   · 결재선은 여기서 정하지 않는다. **상신자가 상신 창에서 결재받을 분의 이름을 넣어 직접 고른다**
     (2026-10-02 사용자 결정 — "이름만 넣어 주면 결재하는 사람이 알아서 지정할 수 있게, 딱 누구다 이렇게 넣지 말고").
     그래서 부서별 결재선 지정도, 직책으로 결재선을 자동으로 만드는 것도 하지 않는다.
     예전 부서별 결재선(driving_approval_lines) 2건은 지우지 않고 그대로 두었다(더 읽지 않는다).
   · 결재를 누르려면 앱 계정이 있어야 하므로, 사람마다 '계정 연결'을 보여 준다.
   · 사람을 지우지 않는다. '내리기'는 active=false 로 감출 뿐이다(기록이 남는다).
   · 쓰기는 서버 정책이 운행일지 관리자에게만 허락한다(화면에서 막는 것은 안내일 뿐).
   ═══════════════════════════════════════════════════════════════════════════ */
(window.DrvExtQ = window.DrvExtQ || []).push(function (C) {
  'use strict';
  var $ = C.$, esc = C.esc, ic = C.ic, n0 = C.n0;
  var RANKS = ['대표이사', '부사장', '전무', '상무', '이사', '수석', '책임', '선임', '사원', '대표', '차장'];

  var SEL = '';                                 // 고른 부서 키: '' = 전체, 'A' 본부, 'A|B' 팀, 'A|B|C' 센터·파트
  var Q = '';                                   // 사람 찾기
  var OF = '';                                  // 정리할 것 걸러 보기: '' | 'noacct'(계정 없음) | 'nomail'(메일 없음)

  /** 조직도 어디에도 안 이어진 앱 계정(가입 대기·거절은 뺀다). */
  function unlinkedAccts(S) {
    var used = {};
    S.ORG.forEach(function (x) { if (x.username) used[x.username] = 1; });
    return Object.keys(S.PEOPLE).filter(function (u) {
      var pp = S.PEOPLE[u] || {};
      return !used[u] && (!pp.signup_status || pp.signup_status === 'active');
    }).sort(function (a, b) { return C.nameOf(a).localeCompare(C.nameOf(b), 'ko'); });
  }
  /** 메일이 비었거나 회사 메일이 아닌가(팀즈 알림을 못 받는다). */
  function noMail(o) { return !/^[^@\s]+@atecmobility\.com$/i.test(String(o.email || '').trim()); }

  function nodeKey(o, depth) { return [o.division, o.team, o.unit].slice(0, depth).join('|'); }
  function parts(k) { return k ? k.split('|') : []; }
  function inNode(o, k) {
    var p = parts(k);
    return (!p[0] || o.division === p[0]) && (p.length < 2 || o.team === p[1]) && (p.length < 3 || o.unit === p[2]);
  }
  function nodeName(k) { var p = parts(k); return p.length ? (p[p.length - 1] || p[p.length - 2]) : '전체'; }

  /* ══════════════════ 화면 ══════════════════ */
  function viewOrg() {
    var S = C.state();
    if (!S.LOADED) return C.head('조직도') + C.skeleton();
    var org = S.ORG;
    var linked = org.filter(function (o) { return o.username && S.PEOPLE[o.username]; }).length;
    var h = C.head('조직도', n0(org.length) + '명 · 앱 계정 연결 ' + n0(linked) + '명');

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
        var d = parts(k).length;
        return '<button class="onode d' + d + (SEL === k ? ' on' : '') + '" data-onode="' + esc(k) + '">' +
          '<span class="nm">' + esc(nodeName(k)) + '</span>' +
          '<span class="c">' + n0(tree[k]) + '</span></button>';
      }).join('');

    // ── 오른쪽: 사람 ──
    var right = '<div class="ocard"><div class="anote" style="margin:0"><b>결재선은 직원이 상신할 때 직접 고릅니다.</b> ' +
      '상신 창에서 결재받을 분의 이름을 넣어 순서대로 고르고, 지난번 결재선을 불러올 수도 있습니다. ' +
      '여기서는 사람의 <b>이름·소속</b>과 <b>앱 계정</b>만 맞춰 두면 됩니다 — 앱 계정이 있어야 결재자로 찾히고 결재를 누를 수 있습니다.</div></div>';

    // ── 정리할 것 — 계정 잇기·메일 채우기 ──
    var unl = unlinkedAccts(S);
    var nNoAcct = org.filter(function (o) { return !o.username || !S.PEOPLE[o.username]; }).length;
    var nNoMail = org.filter(function (o) { return o.username && S.PEOPLE[o.username] && noMail(o); }).length;
    var tile = function (attr, on, n, t, d, warn) {
      return '<button class="otile' + (on ? ' on' : '') + (n && warn ? ' warn' : '') + '" ' + attr + '>' +
        '<b>' + n0(n) + '<small>명</small></b><span class="t">' + t + '</span><span class="d">' + d + '</span></button>';
    };
    right += '<div class="otiles">' +
      tile('data-ounl', false, unl.length, '조직도에 안 이어진 계정', unl.length ? '눌러서 조직도의 누구인지 잇기' : '모두 이어졌습니다', true) +
      tile('data-of="noacct"', OF === 'noacct', nNoAcct, '앱 계정 없는 사람', '결재자로 못 고릅니다 — 가입하면 이어 주세요', false) +
      tile('data-of="nomail"', OF === 'nomail', nNoMail, '회사 메일 없는 사람', '팀즈 알림(결재 차례·반려)을 못 받습니다', true) +
      '</div>';

    var q = Q.trim().toLowerCase();
    var people = org.filter(function (o) {
      if (!inNode(o, SEL)) return false;
      if (OF === 'noacct' && o.username && S.PEOPLE[o.username]) return false;
      if (OF === 'nomail' && !(o.username && S.PEOPLE[o.username] && noMail(o))) return false;
      if (!q) return true;
      return [o.name, o.rank, o.role, o.duty, o.team, o.unit, o.username || '', o.email || ''].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    right += '<div class="bar" style="margin-top:14px"><label class="field">' + ic('search', 14) +
      '<input id="orgQ" aria-label="사람 찾기" placeholder="이름·직급·업무로 찾기" value="' + esc(Q) + '"></label>' +
      (OF ? '<button class="btn sm" data-of="">' + ic('close', 12) + (OF === 'noacct' ? '계정 없는 사람만' : '메일 없는 사람만') + ' — 풀기</button>' : '') +
      '<div class="sp" style="flex:1"></div>' +
      '<button class="btn sm pri" data-oadd>＋ 사람 추가</button></div>';
    right += people.length ? '<div class="panel"><div class="scroll" data-rows><table><thead><tr>' +
      '<th>이름</th><th>직급</th><th>직책</th><th>소속</th><th>담당 업무</th><th>앱 계정 · 메일</th><th></th></tr></thead><tbody>' +
      people.map(function (o) {
        var acct = o.username
          ? (S.PEOPLE[o.username] ? '<span class="st ok">' + esc(o.username) + '</span>'
            : '<span class="st bad" title="연결한 계정이 없어졌습니다">' + esc(o.username) + '</span>')
          : '<span class="st dim">없음</span>';
        acct += o.username && S.PEOPLE[o.username]
          ? (noMail(o) ? '<div class="omail miss">메일 없음</div>' : '<div class="omail">' + esc(o.email) + '</div>') : '';
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
    h += '<div class="anote">결재를 누르려면 <b>앱 계정</b>이 있어야 합니다. 계정이 없는 사람은 상신 창에서 결재자로 찾히지 않습니다 — ' +
      '먼저 앱에서 가입하게 한 뒤 「고치기」에서 계정을 이어 주세요. 퇴사·이동한 사람은 「고치기」 창의 <b>목록에서 내리기</b>로 감춥니다(기록은 남습니다).</div>';
    return h;
  }

  /* ══════════════════ 사람 추가·고치기 ══════════════════ */
  function openPerson(id) {
    var S = C.state();
    var o = id ? S.ORG.filter(function (x) { return String(x.id) === String(id); })[0] : null;
    var p = parts(SEL);
    var v = o || { division: p[0] || '', team: p[1] || '', unit: p[2] || '', name: '', rank: '', role: '', duty: '', username: '', email: '', outsourced: false };
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
        dl('dlRole', ['사업부장', '공장장', '실장', '팀장', '센터장', '파트장']),
        '참고용입니다(센터장·팀장 등). 없으면 비워 둡니다. 결재선은 직원이 상신할 때 직접 고릅니다', 'oRole') +
      fld('담당 업무', '<input class="inp" id="oDuty" maxlength="80" value="' + esc(v.duty) + '">', null, 'oDuty') +
      fld('회사 메일', '<input class="inp" id="oEmail" type="email" maxlength="80" value="' + esc(v.email || '') + '">',
        '팀즈 아이디와 같은 메일. 결재 차례가 오면 이 주소로 팀즈 개인 채팅 알림을 보냅니다', 'oEmail') +
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
    return ['oName', 'oDiv', 'oTeam', 'oUnit', 'oRank', 'oRole', 'oDuty', 'oEmail', 'oUser'].map(function (i) {
      return String(($(i) || {}).value || '');
    }).join('\u0001') + '\u0001' + ((($('oOut') || {}).checked) ? 1 : 0);
  }
  /** 닫기 전에 되물어야 하는가 — 사람 창에서 실제로 바꾼 것이 있을 때만. */
  function dirty() {
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
      rank: val('oRank'), role: val('oRole'), duty: val('oDuty'), email: val('oEmail').toLowerCase() || null,
      username: val('oUser') || null, outsourced: !!($('oOut') || {}).checked,
      updated_by: C.myName(), updated_at: new Date().toISOString()
    };
    if (!row.name) { C.toast('이름을 넣어 주세요.', true); $('oName').focus(); return; }
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) { C.toast('메일 주소 모양이 아닙니다.', true); $('oEmail').focus(); return; }
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
    C.openPanel('목록에서 내리기', o.name + ' · ' + [o.team, o.unit].filter(Boolean).join(' › '),
      '<div class="anote" style="margin-top:0"><b>' + esc(o.name) + '</b> 님을 조직도에서 내립니다. 기록은 지워지지 않고 목록에서만 사라집니다. ' +
      '앱 계정과 운행 기록에는 아무 영향이 없습니다. 이미 올라간 결재 건도 바뀌지 않습니다.</div>',
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

  /* ══════════════════ 안 이어진 계정 잇기 ══════════════════
     웹·앱으로 가입했지만 조직도의 어느 사람과도 이어지지 않은 계정. 조직도에서 계정이 비어 있는 사람을 골라 잇는다.
     같은 이름이 있으면 맨 위에 「같은 이름」으로 먼저 보인다. 조직도에 없는 사람이면 「사람 추가」로 만든다. */
  function openUnlinked() {
    var S = C.state(), unl = unlinkedAccts(S);
    var free = S.ORG.filter(function (o) { return !o.username || !S.PEOPLE[o.username]; });
    var lab = function (o) { return o.name + ' · ' + ([o.team, o.unit].filter(Boolean).join(' › ') || o.division) + (o.rank ? ' · ' + o.rank : ''); };
    var rows = unl.map(function (u) {
      var pp = S.PEOPLE[u] || {}, nm = C.nameOf(u);
      var same = free.filter(function (o) { return o.name === nm; });
      var rest = free.filter(function (o) { return o.name !== nm; }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
      var opts = '<option value="">— 조직도에서 고르기 —</option>' +
        (same.length ? '<optgroup label="같은 이름">' + same.map(function (o) { return '<option value="' + o.id + '"' + (same.length === 1 ? ' selected' : '') + '>' + esc(lab(o)) + '</option>'; }).join('') + '</optgroup>' : '') +
        '<optgroup label="계정 없는 사람 전체">' + rest.map(function (o) { return '<option value="' + o.id + '">' + esc(lab(o)) + '</option>'; }).join('') + '</optgroup>';
      return '<tr><td><span class="lead">' + esc(nm) + '</span><div class="dim" style="font-size:11px">' + esc(u) + '</div></td>' +
        '<td class="dim">' + esc([pp.dept, pp.position].filter(Boolean).join(' · ') || '—') + '</td>' +
        '<td style="min-width:240px"><select class="inp" data-olinksel="' + esc(u) + '" style="height:auto">' + opts + '</select></td>' +
        '<td class="n"><button class="btn sm pri" data-olink="' + esc(u) + '">잇기</button></td></tr>';
    }).join('');
    C.openPanel('조직도에 안 이어진 계정', n0(unl.length) + '명',
      unl.length
        ? '<div class="anote" style="margin-top:0">웹·앱으로 가입했지만 조직도의 누구인지 정해지지 않은 계정입니다. ' +
          '오른쪽에서 <b>조직도의 그 사람</b>을 고르고 「잇기」를 누르세요. 같은 이름이 한 명이면 미리 골라 두었습니다. ' +
          '조직도에 없는 사람이면 닫고 「＋ 사람 추가」로 만든 뒤 앱 계정을 고르면 됩니다.<br>' +
          '이으면 <b>결재자로 고를 수 있고</b>, 관리 화면의 <b>소속(사업부·팀·파트)</b>도 바르게 묶입니다.</div>' +
          '<div class="panel" style="margin-top:12px"><div class="scroll"><table><thead><tr><th>계정</th><th>가입 때 적은 부서</th><th>조직도의 누구?</th><th></th></tr></thead><tbody>' +
          rows + '</tbody></table></div></div>'
        : C.blank('모든 계정이 조직도에 이어져 있습니다.', null, 'users'),
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>', true);
  }
  function linkAcct(u) {
    var sel = null;
    Array.prototype.forEach.call(document.querySelectorAll('[data-olinksel]'), function (x) { if (x.dataset.olinksel === u) sel = x; });
    var id = sel && sel.value;
    if (!id) { C.toast('조직도에서 누구인지 먼저 골라 주세요.', true); if (sel) sel.focus(); return; }
    var S = C.state(), o = S.ORG.filter(function (x) { return String(x.id) === String(id); })[0];
    C.apiRetry('/rest/v1/driving_org?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ username: u, updated_by: C.myName(), updated_at: new Date().toISOString() })
    }).then(function (r) { if (!r.ok) return fail(r, '잇기'); })
      .then(reloadOrg)
      .then(function () { C.toast(C.nameOf(u) + ' 계정을 ' + (o ? o.name : '조직도') + ' 님에게 이었습니다.'); C.render(); openUnlinked(); })
      .catch(function (e) { C.toast((e && e.message) || '잇지 못했습니다.', true); });
  }

  /* ══════════════════ 이벤트 ══════════════════ */
  document.addEventListener('click', function (e) {
    var el;
    if ((el = e.target.closest('[data-onode]'))) { SEL = el.dataset.onode; Q = ''; C.render(); return; }
    if (e.target.closest('[data-ounl]')) { openUnlinked(); return; }
    if ((el = e.target.closest('[data-olink]'))) { linkAcct(el.dataset.olink); return; }
    if ((el = e.target.closest('[data-of]'))) { OF = OF === el.dataset.of ? '' : el.dataset.of; C.render(); return; }
    if (e.target.closest('[data-oadd]')) { openPerson(null); return; }
    if ((el = e.target.closest('[data-oedit]'))) { openPerson(el.dataset.oedit); return; }
    if ((el = e.target.closest('#oSave'))) { savePerson(el.dataset.id); return; }
    if ((el = e.target.closest('[data-ooff]'))) { askOff(el.dataset.ooff); return; }
    if ((el = e.target.closest('#oOffGo'))) { runOff(el.dataset.id); return; }
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

  return { views: { org: viewOrg }, admin: ['org'], dirty: dirty, onCycle: function () { } };
});
