/* ═══════════════════════════════════════════════════════════════════════════
   drv-org.js — 조직도 · 결재선 (운행일지 관리자)
   ---------------------------------------------------------------------------
   · 조직도(driving_org)가 결재선의 정본이다. **결재선은 부서마다 지정하지 않는다** —
     상신자의 조직도 위치와 '직책' 칸에서 자동으로 만든다(2026-10-02 사용자 결정).
       센터·파트의 장(센터장·파트장 등) → 결재란 「팀장」 칸
       팀의 장(팀장)                    → 「실장」 칸
       본부의 장(사업부장·공장장)       → 「대표이사」 칸
     (칸 이름과 직위가 1:1이 아니다 — 사내 양식 관례. 20260915020000 마이그레이션 주석 참고)
     본인이 그 단계의 장이면 그 위 단계부터. 장이 없거나 앱 계정이 없는 단계는 건너뛴다.
     그래서 관리자가 할 일은 조직도에서 **직책 칸**과 **앱 계정**을 맞춰 두는 것뿐이다.
   · 직원은 상신 창에서 미리 채워진 결재선을 빼거나 더하거나 칸을 바꿀 수 있다.
   · 예전 부서별 결재선(driving_approval_lines)은 지우지 않고 남겨 둔다. 조직도로 결재선을 만들 수 없는
     사람(조직도에 없거나 위로 장이 아무도 없는 사람)에게만 예비로 쓴다.
   · 사람을 지우지 않는다. '내리기'는 active=false 로 감출 뿐이다(기록이 남는다).
   · 쓰기는 서버 정책이 운행일지 관리자에게만 허락한다(화면에서 막는 것은 안내일 뿐).
   ═══════════════════════════════════════════════════════════════════════════ */
(window.DrvExtQ = window.DrvExtQ || []).push(function (C) {
  'use strict';
  var $ = C.$, esc = C.esc, ic = C.ic, n0 = C.n0;
  var RANKS = ['대표이사', '부사장', '전무', '상무', '이사', '수석', '책임', '선임', '사원', '대표', '차장'];

  var SEL = '';                                 // 고른 부서 키: '' = 전체, 'A' 본부, 'A|B' 팀, 'A|B|C' 센터·파트
  var Q = '';                                   // 사람 찾기

  function nodeKey(o, depth) { return [o.division, o.team, o.unit].slice(0, depth).join('|'); }
  function parts(k) { return k ? k.split('|') : []; }
  function inNode(o, k) {
    var p = parts(k);
    return (!p[0] || o.division === p[0]) && (p.length < 2 || o.team === p[1]) && (p.length < 3 || o.unit === p[2]);
  }
  function nodeName(k) { var p = parts(k); return p.length ? (p[p.length - 1] || p[p.length - 2]) : '전체'; }
  function stepUsers(s) { return s.approver ? [s.approver] : (s.candidates || []).slice(); }
  function who(u) {
    var S = C.state(), o = S.ORG.filter(function (x) { return x.username === u; })[0];
    var p = S.PEOPLE[u] || {};
    return { name: (o && o.name) || p.name || u, rank: (o && o.rank) || p.position || '', has: !!S.PEOPLE[u] };
  }

  /* ══════════════════ 자동 결재선 ══════════════════ */
  /** 단계: 아래에서 위로. box = 결재란 칸, what = 화면에 보일 그 단계의 장 이름. */
  var LEVELS = [
    { key: 'unit', box: '팀장', what: '센터·파트장' },
    { key: 'team', box: '실장', what: '팀장' },
    { key: 'division', box: '대표이사', what: '사업부장' }
  ];
  /** 그 단계의 장들(조직도에서 직책 칸이 채워진 사람). pos = { division, team, unit } */
  function headsAt(lv, pos) {
    return C.state().ORG.filter(function (o) {
      if (!String(o.role || '').trim() || o.division !== pos.division) return false;
      if (lv === 'division') return !o.team && !o.unit;
      if (lv === 'team') return !!pos.team && o.team === pos.team && !o.unit;
      return !!pos.unit && o.team === pos.team && o.unit === pos.unit;
    });
  }
  /**
   * 그 자리(pos)에 있는 사람(self = 조직도 행, 없으면 그 부서의 보통 직원)의 결재선.
   * 돌려주는 값: { steps: [{box, approver} | {box, candidates, pick}], notes: [건너뛴 까닭] }
   */
  function chainFor(pos, self) {
    var S = C.state();
    var lv = LEVELS.filter(function (l) {
      return l.key === 'division' || (l.key === 'team' && pos.team) || (l.key === 'unit' && pos.unit);
    });
    // 본인이 그 단계의 장이면 그 단계와 그 아래는 뺀다(본인이 본인을 결재하지 않는다).
    var at = -1;
    lv.forEach(function (l, i) {
      if (self && headsAt(l.key, pos).some(function (o) { return o.id === self.id; })) at = i;
    });
    lv = lv.slice(at + 1);
    var used = {}, steps = [], notes = [];
    if (self && self.username) used[self.username] = 1;
    lv.forEach(function (l) {
      var hs = headsAt(l.key, pos).filter(function (o) { return !self || o.id !== self.id; });
      var ok = hs.filter(function (o) { return o.username && S.PEOPLE[o.username] && !used[o.username]; })
        .map(function (o) { return o.username; })
        .filter(function (u, i, a) { return a.indexOf(u) === i; });
      if (!hs.length) { notes.push({ box: l.box, why: '조직도에 ' + l.what + ' 직책이 없음' }); return; }
      if (!ok.length) {
        notes.push({ box: l.box, why: hs.map(function (o) { return o.name; }).join('·') + ' ' + l.what + ' — 앱 계정이 없어 건너뜀' });
        return;
      }
      ok.forEach(function (u) { used[u] = 1; });
      steps.push(ok.length === 1 ? { box: l.box, approver: ok[0] } : { box: l.box, candidates: ok, pick: l.what });
    });
    return { steps: steps, notes: notes };
  }
  function posOf(o) { return { division: o.division || '', team: o.team || '', unit: o.unit || '' }; }
  /** 결재선 한 줄(이름만) — 표 칸에 넣는다. */
  function chainText(steps) {
    return steps.map(function (s) {
      var us = stepUsers(s);
      return us.map(function (u) { return who(u).name; }).join('/') + '(' + s.box + ')';
    }).join(' → ');
  }
  function stepsHtml(steps) {
    return '<div class="oline">' + '<span class="ostep me"><em>담당</em><b>상신자 본인</b></span>' +
      steps.map(function (s) {
        var us = stepUsers(s);
        return '<span class="oarrow">→</span><span class="ostep"><em>' + esc(s.box || '') + ' 칸</em>' +
          (us.length > 1 ? '<span class="dim">' + esc(s.pick || '후보') + ' 중 1명</span>' : '') +
          us.map(function (u) {
            var w = who(u);
            return '<b>' + esc(w.name) + (w.rank ? ' <small>' + esc(w.rank) + '</small>' : '') + '</b>';
          }).join('') + '</span>';
      }).join('') + '</div>';
  }

  /* ══════════════════ 화면 ══════════════════ */
  function viewOrg() {
    var S = C.state();
    if (!S.LOADED) return C.head('조직도 · 결재선') + C.skeleton();
    var org = S.ORG;
    var linked = org.filter(function (o) { return o.username && S.PEOPLE[o.username]; });
    // 앱 계정이 있는 사람 중 결재선이 자동으로 하나도 안 만들어지는 사람 — 관리자가 직책을 채워야 한다.
    var noLine = linked.filter(function (o) { return !chainFor(posOf(o), o).steps.length; });
    var h = C.head('조직도 · 결재선', n0(org.length) + '명 · 앱 계정 연결 ' + n0(linked.length) + '명 · ' +
      (noLine.length ? '<b>결재선을 못 만드는 사람 ' + n0(noLine.length) + '명</b>' : '전원 결재선 자동'));

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
    // 부서마다 그 부서의 장이 있는지(계정까지) — 없으면 나무에 주황 점.
    var headState = function (k) {
      var p = parts(k), lvKey = p.length === 3 ? 'unit' : p.length === 2 ? 'team' : 'division';
      var hs = headsAt(lvKey, { division: p[0] || '', team: p[1] || '', unit: p[2] || '' });
      if (!hs.length) return 'none';
      return hs.some(function (o) { return o.username && S.PEOPLE[o.username]; }) ? 'ok' : 'noacct';
    };
    var left = '<button class="onode root' + (SEL === '' ? ' on' : '') + '" data-onode="">전체 <span class="c">' + n0(org.length) + '</span></button>' +
      order.map(function (k) {
        var d = parts(k).length, hsx = headState(k);
        return '<button class="onode d' + d + (SEL === k ? ' on' : '') + '" data-onode="' + esc(k) + '">' +
          '<span class="nm">' + esc(nodeName(k)) + '</span>' +
          (hsx === 'ok' ? '' : '<span class="dot warn" title="' + (hsx === 'none' ? '이 부서의 장(직책)이 조직도에 없습니다' : '이 부서의 장에게 앱 계정이 없습니다') + '"></span>') +
          '<span class="c">' + n0(tree[k]) + '</span></button>';
      }).join('');

    // ── 오른쪽: 이 부서의 자동 결재선 + 사람 ──
    var right = '';
    if (SEL) {
      var p0 = parts(SEL), pos = { division: p0[0] || '', team: p0[1] || '', unit: p0[2] || '' };
      var ch = chainFor(pos, null);
      right += '<div class="ocard"><div class="ohd"><b>' + esc(nodeName(SEL)) + ' 직원의 결재선</b>' +
        '<span class="st ' + (ch.steps.length ? 'ok' : 'warn') + '">' + (ch.steps.length ? '조직도에서 자동' : '만들 수 없음') + '</span></div>' +
        (ch.steps.length ? stepsHtml(ch.steps)
          : '<div class="anote" style="margin-top:8px">이 부서 위로 직책(센터장·팀장·사업부장 등)이 채워진 사람이 없습니다. ' +
            '그대로 두면 직원이 상신할 때 결재자를 직접 찾아 넣어야 합니다.</div>') +
        (ch.notes.length ? '<div class="onotes">' + ch.notes.map(function (n) {
          return '<div>' + ic('alert', 13) + '<span>「' + esc(n.box) + '」 칸 — ' + esc(n.why) + '</span></div>';
        }).join('') + '</div>' : '') +
        '<div class="anote" style="margin-top:10px">장 본인이 상신하면 그 위 단계부터 들어갑니다. 결재선을 바꾸려면 사람의 <b>직책</b>·<b>소속</b>·<b>앱 계정</b>을 고치세요 — 바로 반영됩니다.</div>' +
        '</div>';
    } else {
      right += '<div class="ocard"><div class="anote" style="margin:0"><b>결재선은 조직도에서 자동으로 정해집니다.</b> 상신자가 속한 ' +
        '<b>센터·파트의 장 → 팀장 → 사업부장</b> 순서로, 결재란은 각각 「팀장」·「실장」·「대표이사」 칸에 찍힙니다. ' +
        '장이 없거나 앱 계정이 없는 단계는 건너뜁니다. 관리자는 사람의 <b>직책</b>과 <b>앱 계정</b>만 맞춰 두면 됩니다. ' +
        '직원은 상신할 때 미리 채워진 결재선에서 빼거나 더할 수 있습니다.</div>' +
        (noLine.length ? '<div class="awarn" style="margin-top:12px">' + ic('alert', 15) + '<span>앱 계정이 있는데 결재선을 못 만드는 사람이 <b>' +
          n0(noLine.length) + '명</b> 있습니다(위로 직책이 채워진 사람이 없음): ' +
          esc(noLine.slice(0, 8).map(function (o) { return o.name; }).join(', ') + (noLine.length > 8 ? ' 외 ' + (noLine.length - 8) + '명' : '')) +
          '. 그 부서의 장에게 <b>직책</b>을 넣어 주세요.</span></div>' : '') + '</div>';
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
      '<th>이름</th><th>직급</th><th>직책</th><th>소속</th><th>앱 계정</th><th>결재선(자동)</th><th></th></tr></thead><tbody>' +
      people.map(function (o) {
        var acct = o.username
          ? (S.PEOPLE[o.username] ? '<span class="st ok">' + esc(o.username) + '</span>'
            : '<span class="st bad" title="연결한 계정이 없어졌습니다">' + esc(o.username) + '</span>')
          : '<span class="st dim">없음</span>';
        var line = chainFor(posOf(o), o).steps;
        var lt = chainText(line);
        return '<tr><td><span class="lead">' + esc(o.name) + '</span>' + (o.outsourced ? ' <span class="kind">외주</span>' : '') + '</td>' +
          '<td>' + esc(o.rank || '—') + '</td>' +
          '<td>' + (o.role ? '<span class="kind biz">' + esc(o.role) + '</span>' : '<span class="dim">—</span>') + '</td>' +
          '<td class="el dim" title="' + esc([o.team, o.unit].filter(Boolean).join(' › ') || o.division) + '">' +
          esc([o.team, o.unit].filter(Boolean).join(' › ') || o.division) + '</td>' +
          '<td>' + acct + '</td>' +
          '<td class="el" title="' + esc(lt) + '">' + (line.length ? esc(lt) : '<span class="st warn">없음 — 상신 때 직접</span>') + '</td>' +
          // 「내리기」는 고치기 창 안에 있다 — 줄마다 두면 표가 넘쳐 잘리고, 「고치기」 옆이라 잘못 누르기 쉽다.
          '<td class="n" style="white-space:nowrap"><button class="btn sm" data-oedit="' + o.id + '" aria-label="' +
          esc(o.name) + ' 고치기">고치기</button></td></tr>';
      }).join('') + '</tbody></table></div></div>'
      : '<div class="panel"><div class="blank"><div class="t">' + (q ? '찾는 사람이 없습니다.' : '이 부서에 사람이 없습니다.') + '</div></div></div>';

    // ★ <aside> 를 쓰지 않는다 — 좌측 메뉴(aside)의 폭·고정 위치·좁은 화면 감춤 규칙을 그대로 물려받는다.
    h += '<div class="orgwrap"><nav class="otree" aria-label="부서">' + left + '</nav><div class="omain">' + right + '</div></div>';
    h += '<div class="anote">결재를 누르려면 <b>앱 계정</b>이 있어야 합니다. 계정이 없는 장은 결재선에서 건너뜁니다 — ' +
      '먼저 앱에서 가입하게 한 뒤 「고치기」에서 계정을 이어 주세요. 퇴사·이동한 사람은 「고치기」 창의 <b>목록에서 내리기</b>로 감춥니다(기록은 남습니다). ' +
      '나무의 주황 점은 그 부서의 장(직책)이 없거나 계정이 없다는 뜻입니다.</div>';
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
        dl('dlRole', ['사업부장', '공장장', '실장', '팀장', '센터장', '파트장']),
        '<b>그 부서의 장</b>일 때만 넣습니다(센터장·파트장·팀장·사업부장 등). 직원들의 결재선이 이 칸으로 자동으로 정해집니다. 장이 아니면 비워 둡니다', 'oRole') +
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
    // 이 사람이 결재자로 들어가는 직원 수 — 내리면 그 직원들의 결재선에서 이 단계가 빠진다(자동).
    var affected = o.username ? S.ORG.filter(function (x) {
      return x.id !== o.id && chainFor(posOf(x), x).steps.some(function (s) { return stepUsers(s).indexOf(o.username) >= 0; });
    }).length : 0;
    C.openPanel('목록에서 내리기', o.name + ' · ' + [o.team, o.unit].filter(Boolean).join(' › '),
      '<div class="anote" style="margin-top:0"><b>' + esc(o.name) + '</b> 님을 조직도에서 내립니다. 기록은 지워지지 않고 목록에서만 사라집니다. ' +
      '앱 계정과 운행 기록에는 아무 영향이 없습니다.</div>' +
      (affected ? '<div class="awarn">' + ic('alert', 15) + '<span>이 분은 직원 <b>' + n0(affected) +
        '명</b>의 결재선에 들어 있습니다. 내리면 그 직원들의 결재선에서 이 단계가 빠집니다 — 후임이 있으면 후임에게 <b>직책</b>을 먼저 넣어 주세요. ' +
        '이미 올라간 결재 건은 바뀌지 않습니다.</span></div>' : ''),
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

  /* ══════════════════ 이벤트 ══════════════════ */
  document.addEventListener('click', function (e) {
    var el;
    if ((el = e.target.closest('[data-onode]'))) { SEL = el.dataset.onode; Q = ''; C.render(); return; }
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

  /**
   * 상신 창이 쓴다 — 그 사람의 자동 결재선(조직도 위치·직책). 만들 수 없으면 null
   * (그때 상신 창은 예전 부서별 결재선 → 직접 입력 순으로 넘어간다).
   */
  function lineForUser(u) {
    var S = C.state(), o = S.ORG.filter(function (x) { return x.username === u; })[0];
    if (!o) return null;
    var ch = chainFor(posOf(o), o);
    return ch.steps.length ? { steps: ch.steps, auto: true } : null;
  }

  return { views: { org: viewOrg }, admin: ['org'], lineForUser: lineForUser, dirty: dirty, onCycle: function () { } };
});
