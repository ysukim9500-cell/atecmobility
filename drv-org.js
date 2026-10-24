/* ═══════════════════════════════════════════════════════════════════════════
   drv-org.js — 조직도 (운행일지 관리자)
   ---------------------------------------------------------------------------
   · 조직도(driving_org)는 **사람 명단**이다(이름·소속·직급·직책·앱 계정). 앱 계정이 없는 사람도 들어 있다.
   · 결재선은 상신 창을 열 때 **조직도의 직책으로 미리 채운다**(2026-10-14 사용자 결정 — driving-app.js autoLine,
     운행일지·개인경비·법인카드 세 상신 창이 같은 함수). 결재란 칸은 담당 · 센터·파트장 · 팀장 · 사업부장 · 대표이사.
       상신자와 같은 센터·파트의 센터장·파트장 → 「센터·파트장」 칸
       같은 팀의 팀장                         → 「팀장」 칸
       같은 사업부의 사업부장                 → 「사업부장」 칸,  「대표이사」 칸은 비운다(빗금)
     본인이 그 장이면 그 칸은 비운다. 장이 없거나 둘 이상이거나 앱 계정이 없으면 비우고 상신 창에 까닭을 적는다.
     미리 채운 칸도 상신자가 칸마다 바꾸거나 비운다 — 결재선의 정본은 여전히 상신자다(2026-10-02 결정은 그대로).
     그래서 관리자가 할 일은 사람마다 **직책**(센터장·파트장·팀장·사업부장)과 **앱 계정**을 맞춰 두는 것이다.
     이 화면은 부서를 고르면 그 부서 직원의 자동 결재선을 미리 보이고, 결재선을 다 못 채우는 부서·사람을 주황으로 표시한다.
     예전 부서별 결재선(driving_approval_lines) 2건은 지우지 않고 그대로 두었다(더 읽지 않는다).
   · 결재선 지정(2026-10-14 사용자 「결재라인을 일일이 수정할 수 있게」): 직책으로 안 맞는 사람은 관리자가 사람 표의
     「결재선 지정」으로 칸마다 자동 · 비움 · 사람을 정한다(driving_line_override). 한 사람씩, 또는 고른 부서 모두에.
     상신 창은 이 지정을 자동보다 먼저 채운다(이번 기간 넣다 만 것 · 반려·회수된 결재선 다음). 표·미리보기·주황 경고는
     지정 + 자동을 합친 실제 결재선으로 센다 — 지정으로 고치면 경고가 사라진다.
   · 결재를 누르려면 앱 계정이 있어야 하므로, 사람마다 '계정 연결'을 보여 준다.
   · 사람을 지우지 않는다. '내리기'는 active=false 로 감출 뿐이다(기록이 남는다).
   · 쓰기는 서버 정책이 운행일지 관리자에게만 허락한다(화면에서 막는 것은 안내일 뿐).
   ═══════════════════════════════════════════════════════════════════════════ */
(window.DrvExtQ = window.DrvExtQ || []).push(function (C) {
  'use strict';
  var $ = C.$, esc = C.esc, ic = C.ic, n0 = C.n0;
  var RANKS = ['대표이사', '부사장', '전무', '상무', '이사', '수석', '책임', '선임', '사원', '대표', '차장'];

  var SEL = '';                                 // 고른 부서 키: '' = 전체, 'A' 사업부, 'A|B' 팀, 'A|B|C' 센터·파트
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

  /* ══════════════════ 자동 결재선 미리보기 (2026-10-14) ══════════════════
     계산은 상신 창과 같은 함수(C.lineAt · C.autoLine — driving-app.js)로 한다. 여기서 따로 규칙을 만들지 않는다. */
  function posOf(o) { return { division: o.division || '', team: o.team || '', unit: o.unit || '' }; }
  function nodePos(k) { var p = parts(k); return { division: p[0] || '', team: p[1] || '', unit: p[2] || '' }; }
  /** 그 사람(조직도 행)의 실제 결재선 — 관리자 지정(있으면) + 자동. 상신 창이 그 사람에게 미리 채울 것과 같다(2026-10-14).
   *  over = 관리자 지정이 있는가. */
  function lineOf(o) {
    var al = C.lineAt(posOf(o), o), b = o.username ? C.lineOverride(o.username) : null;
    if (!b) { al.over = false; return al; }
    var m = C.applyOverride(al, b, o.username);
    m.over = true;
    return m;
  }
  /** 지정 칸들을 견주는 글(같은 지정인지). 키 없음 = '*'. */
  function boxSig(b) {
    return C.APPR_BOXES.map(function (k) { return k + '=' + (Object.prototype.hasOwnProperty.call(b || {}, k) ? b[k] : '*'); }).join('|');
  }
  /** 부서(정확히 그 자리)에 있는 앱 계정 직원. */
  /** 직접 골라야 하는 칸 수 — 지정한 결재자가 결재할 수 없어 조직도로 채운 칸(keep)은 빼고 센다(2026-10-14 검증로봇). */
  function need(ln) { return ln.notes.filter(function (n) { return !n.keep; }).length; }
  function members(k) {
    var S = C.state(), p = parts(k);
    return S.ORG.filter(function (o) {
      return o.active !== false && o.username && S.PEOPLE[o.username] &&
        (o.division || '') === (p[0] || '') && (o.team || '') === (p[1] || '') && (o.unit || '') === (p[2] || '');
    });
  }
  /** 부서 미리보기 결재선 — 그 자리 직원이 모두 같은 지정이면 그 지정을 얹고(over), 아니면 자동. nOv = 지정된 직원 수. */
  function nodeLine(k) {
    var ch = C.lineAt(nodePos(k), null), mem = members(k);
    var ovs = mem.map(function (o) { return C.lineOverride(o.username); }), nOv = ovs.filter(Boolean).length;
    if (mem.length && nOv === mem.length && ovs.every(function (b) { return boxSig(b) === boxSig(ovs[0]); })) {
      var m = C.applyOverride(ch, ovs[0], null);
      m.over = true; m.nOv = nOv; m.mem = mem.length;
      return m;
    }
    ch.over = false; ch.nOv = nOv; ch.mem = mem.length;
    return ch;
  }
  /** 결재선을 지정할 수 있는가 — 운행일지 관리자이고 서버에 표가 있을 때만. */
  function canLov() { var S = C.state(); return !!(S.ME && S.ME.is_admin && C.lineOvOk()); }
  /** 결재선 한 줄(이름만) — 표 칸에 넣는다. */
  function lineText(steps) {
    return steps.map(function (s) { return C.nameOf(s.approver) + '(' + s.box + ')'; }).join(' → ');
  }
  /** 결재란 모양 그대로 — 담당 · 센터·파트장 · 팀장 · 사업부장 · 대표이사, 빈칸은 빗금 칸. */
  function lineHtml(steps) {
    return '<div class="oline">' + C.BOXES.map(function (b, i) {
      var s = i === 0 ? null : steps.filter(function (x) { return x.box === b; })[0];
      return (i ? '<span class="oarrow">→</span>' : '') + '<span class="ostep' + (i === 0 ? ' me' : '') + '" data-obox="' + esc(b) + '"><em>' + esc(b) + ' 칸</em>' +
        (i === 0 ? '<b>상신자</b>' : s ? '<b>' + esc(C.nameOf(s.approver)) + '</b>' : '<b><small>/ 비움</small></b>') + '</span>';
    }).join('') + '</div>';
  }
  function notesHtml(notes) {
    return notes.length ? '<div class="onotes">' + notes.map(function (n) {
      return '<div data-onote="' + esc(n.box) + '">' + ic('alert', 13) + '<span>' + esc(n.t) + '</span></div>';
    }).join('') + '</div>' : '';
  }

  /* ══════════════════ 화면 ══════════════════ */
  function viewOrg() {
    var S = C.state();
    if (!S.LOADED) return C.head('조직도') + C.skeleton();
    var org = S.ORG;
    // 앱 계정이 있는데 자동 결재선을 다 못 채우는 사람(까닭이 하나라도 있음) — 관리자가 직책·계정을 맞춰야 한다.
    var short = org.filter(function (o) { return o.active !== false && o.username && S.PEOPLE[o.username] && need(lineOf(o)); });
    // 머리 줄에 「앱 계정 연결 N명」은 뺐다 — 아래 「앱 계정 없는 사람」 칸과 같은 숫자를 두 번 보였다(2026-10-15 화면 정리).
    var h = C.head('조직도', n0(org.length) + '명' +
      (short.length ? ' · 결재선을 다 못 채우는 사람 ' + n0(short.length) + '명' : ''));

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
    // 사업부 → 팀 → 센터·파트로 묶는다. 처음 나온 순서대로만 늘어놓으면, 나중에 만든 팀이
    // 다른 사업부 아래에 그려진다(목록의 순번이 사업부별로 이어져 있지 않을 때).
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
        // 이 부서 직원의 결재선을 다 못 채우면(장이 없음·둘 이상·계정 없음) 주황 점 — 부서 모두에 지정했으면 그 결재선으로 본다
        // 사람마다 다르게 지정했어도 맞게 — 계정 있는 직원이 있으면 그 사람들 결재선으로, 없으면 부서 결재선으로 본다(검증로봇)
        // 다만 직원이 모두 장이라 자기 결재선은 다 차도(예: 사업부장 둘), 지정 없는 직원이 있으면 그 부서 보통 직원 결재선도 본다
        var mem = members(k), anyAuto = !mem.length || mem.some(function (o) { return !C.lineOverride(o.username); }),
          warn = mem.some(function (o) { return need(lineOf(o)) > 0; }) || (anyAuto && need(nodeLine(k)) > 0);
        return '<button class="onode d' + d + (SEL === k ? ' on' : '') + '" data-onode="' + esc(k) + '"' + (warn ? ' data-owarn="1"' : '') + '>' +
          '<span class="nm">' + esc(nodeName(k)) + '</span>' +
          (warn ? '<span class="dot warn" title="결재선을 다 못 채우는 직원이 있어요"></span>' : '') +
          '<span class="c">' + n0(tree[k]) + '</span></button>';
      }).join('');

    // ── 오른쪽: 사람 ──
    var right;
    if (SEL) {
      // 고른 부서의 직원(장이 아닌 보통 직원)이 상신할 때 미리 채워지는 결재선 — 상신 창과 같은 계산.
      // 그 자리 직원 모두에게 같은 결재선을 지정했으면 그것을 보인다(2026-10-14).
      var ch = nodeLine(SEL);
      right = '<div class="ocard" id="oLine" data-oover="' + (ch.over ? 1 : 0) + '"><div class="ohd"><b>' + esc(nodeName(SEL)) + ' 직원의 결재선' + (ch.over ? '(지정)' : '(자동)') + '</b>' +
        '<span class="st ' + (ch.notes.length ? 'warn' : 'ok') + '">' + (ch.notes.length ? '다 못 채움 ' + ch.notes.length + '칸' : ch.over ? '지정으로 다 채움' : '조직도로 다 채움') + '</span></div>' +
        lineHtml(ch.steps) + notesHtml(ch.notes) +
        (!ch.over && ch.nOv ? '<div class="anote" id="oLineOv" style="margin-top:10px">이 부서 직원 ' + n0(ch.mem) + '명 중 <b>' + n0(ch.nOv) +
          '명</b>은 관리자가 결재선을 지정했어요. 표에 ‘지정’으로 표시돼요.</div>' : '') +
        '<div class="anote" style="margin-top:10px">장 본인이 상신하면 자기 칸은 빈칸이 돼요. 사람의 <b>직책</b>(센터장, 파트장, 팀장, 사업부장), ' +
        '<b>소속</b>, <b>앱 계정</b>을 고치면 결재선에 바로 반영돼요. 직책으로 맞지 않는 사람은 ‘결재선 지정’으로 한 사람씩 또는 이 부서 모두의 ' +
        '칸을 정하세요. 직원도 상신 창에서 칸마다 바꾸거나 비울 수 있어요.</div></div>';
    } else {
      // 설명 6줄은 「?」 안에 접는다(2026-10-19 웹 사용성 1차) — 첫 문장만 늘 보인다.
      right = '<div class="ocard"><div class="anote" style="margin:0"><b>결재선은 상신 창을 열 때 조직도로 미리 채워져요.</b> ' +
        '<details class="ohelp"><summary aria-label="결재선이 채워지는 방법 자세히">?<span> 어떻게 채워지나요</span></summary><div>' +
        '결재란의 센터·파트장, 팀장, 사업부장 칸에는 상신자가 속한 <b>센터·파트의 센터장·파트장, 같은 팀의 팀장, 같은 사업부의 사업부장</b>이 들어가요. 전자 결재는 사업부장에서 끝나요. ' +
        '대표이사 칸은 빗금이에요. <b>사업부장이 올린 문서만</b> 이 칸을 비워 두고, 출력한 종이에 대표이사가 손으로 서명해요. ' +
        '직책으로 맞지 않는 사람은 ‘결재선 지정’으로 칸마다 정해 두면 그 결재선이 먼저 채워져요. 직원도 상신 창에서 칸마다 바꾸거나 비울 수 있어요. ' +
        '여기서는 사람의 <b>직책</b>, <b>소속</b>, <b>앱 계정</b>을 맞춰 두세요. ' +
        '앱 계정이 있어야 결재자 목록에 나오고 결재도 할 수 있어요. 부서를 고르면 그 부서 직원의 결재선이 미리 보여요.</div></details></div>' +
        // 숫자는 머리 줄에 이미 있다 — 여기서는 누구인지만(2026-10-15, 같은 숫자 두 번)
        (short.length ? '<div class="awarn" id="oShort" style="margin-top:12px">' + ic('alert', 15) + '<span>앱 계정이 있는데 결재선을 다 못 채우는 사람: ' +
          esc(short.slice(0, 8).map(function (o) { return o.name; }).join(', ') + (short.length > 8 ? ' 외 ' + (short.length - 8) + '명' : '')) +
          '. 주황 점이 있는 부서를 눌러 이유를 확인하세요.</span></div>' : '') + '</div>';
    }

    // ── 정리할 것 — 계정 잇기·메일 채우기 ──
    var unl = unlinkedAccts(S);
    var nNoAcct = org.filter(function (o) { return !o.username || !S.PEOPLE[o.username]; }).length;
    var nNoMail = org.filter(function (o) { return o.username && S.PEOPLE[o.username] && noMail(o); }).length;
    var tile = function (attr, on, n, t, d, warn) {
      return '<button class="otile' + (on ? ' on' : '') + (n && warn ? ' warn' : '') + '" ' + attr + '>' +
        '<b>' + n0(n) + '<small>명</small></b><span class="t">' + t + '</span><span class="d">' + d + '</span></button>';
    };
    right += '<div class="otiles">' +
      tile('data-ounl', false, unl.length, '조직도에 안 이어진 계정', unl.length ? '눌러서 조직도의 누구인지 연결해 주세요.' : '모두 연결됐어요.', true) +
      tile('data-of="noacct"', OF === 'noacct', nNoAcct, '앱 계정 없는 사람', '결재자로 고를 수 없어요. 가입하면 연결해 주세요.', false) +
      tile('data-of="nomail"', OF === 'nomail', nNoMail, '회사 메일 없는 사람', '팀즈 알림(결재 차례·반려)을 받지 못해요.', true) +
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
      '<th>이름</th><th>직급</th><th>직책</th><th>소속</th><th>담당 업무</th><th>앱 계정 · 메일</th><th>결재선</th><th></th></tr></thead><tbody>' +
      people.map(function (o) {
        var acct = o.username
          ? (S.PEOPLE[o.username] ? '<span class="st ok">' + esc(o.username) + '</span>'
            : '<span class="st bad" title="연결한 계정이 없어졌어요">' + esc(o.username) + '</span>')
          : '<span class="st dim">없음</span>';
        acct += o.username && S.PEOPLE[o.username]
          ? (noMail(o) ? '<div class="omail miss">메일 없음</div>' : '<div class="omail" title="' + esc(o.email) + '">' + esc(o.email).replace('@', '<wbr>@') + '</div>') : '';
        return '<tr><td><span class="lead">' + esc(o.name) + '</span>' + (o.outsourced ? ' <span class="kind">외주</span>' : '') + '</td>' +
          '<td>' + esc(o.rank || '—') + '</td>' +
          '<td>' + (o.role ? '<span class="kind biz">' + esc(o.role) + '</span>' : '<span class="dim">—</span>') + '</td>' +
          // 소속은 자르지 않는다(2026-10-14 사용자 「잘 안 보인다」) — 팀 / 센터·파트 두 줄.
          '<td class="oplace"><b>' + esc(o.team || o.division) + '</b>' + (o.unit ? '<small>' + esc(o.unit) + '</small>' : '') + '</td>' +
          '<td class="el" title="' + esc(o.duty || '') + '">' + esc(o.duty || '') + '</td>' +
          '<td>' + acct + '</td>' +
          // 이 사람이 상신할 때 미리 채워질 결재선(계정이 있는 사람만 — 없으면 상신을 못 한다).
          // 관리자 지정이 있으면 지정 + 자동을 합친 것에 「지정」 딱지(2026-10-14).
          (function () {
            if (!(o.username && S.PEOPLE[o.username])) return '<td class="dim">—</td>';
            var ln = lineOf(o), lt = lineText(ln.steps), why = ln.notes.map(function (n) { return n.t; }).join(' / ');
            // 결재선도 자르지 않는다(2026-10-14) — 결재자 한 사람씩 한 줄: 「칸 이름  이름」.
            return '<td class="olinec" data-oline="' + esc(o.username) + '" title="' + esc([lt, why].filter(Boolean).join(' · ')) + '">' +
              (ln.over ? '<span class="kind olov-tag" data-oover="1" title="관리자가 지정한 결재선(지정 안 한 칸은 자동)">지정</span>' : '') +
              (ln.steps.length ? '<ol>' + ln.steps.map(function (s) {
                return '<li><em>' + esc(s.box) + '</em><b>' + esc(C.nameOf(s.approver)) + '</b></li>';
              }).join('') + '</ol>' : '<span class="dim">비움</span>') +
              (need(ln) ? '<span class="st warn" title="' + esc(why) + '">' + need(ln) + '칸 직접</span>'
                : ln.notes.length ? '<span class="st" title="' + esc(why) + '">지정 무효 ' + ln.notes.length + '칸</span>' : '') +
              (canLov() ? '<button class="btn sm olov-btn" data-olov="' + esc(o.username) + '" aria-label="' + esc(o.name) + ' 결재선 지정">결재선 지정</button>' : '') +
              '</td>';
          })() +
          // 「내리기」는 고치기 창 안에 있다 — 줄마다 두면 표가 넘쳐 잘리고, 「고치기」 옆이라 잘못 누르기 쉽다.
          '<td class="n" style="white-space:nowrap"><button class="btn sm" data-oedit="' + o.id + '" aria-label="' +
          esc(o.name) + ' 고치기">고치기</button></td></tr>';
      }).join('') + '</tbody></table></div></div>'
      : '<div class="panel"><div class="blank"><div class="t">' + (q ? '찾는 사람이 없어요.' : '이 부서에 사람이 없어요.') + '</div></div></div>';

    // ★ <aside> 를 쓰지 않는다 — 좌측 메뉴(aside)의 폭·고정 위치·좁은 화면 감춤 규칙을 그대로 물려받는다.
    h += '<div class="orgwrap"><nav class="otree" aria-label="부서">' + left + '</nav><div class="omain">' + right + '</div></div>';
    h += '<div class="anote">앱 계정이 없는 사람은 상신 창에서 결재자로 찾을 수 없어요. ' +
      '먼저 앱에서 가입하게 한 뒤 ‘고치기’에서 계정을 연결해 주세요. 퇴사하거나 이동한 사람은 고치기 창의 ‘목록에서 내리기’로 감추세요. 기록은 남아요.</div>';
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
      fld('사업부', '<input class="inp" id="oDiv" list="dlDiv" maxlength="40" value="' + esc(v.division) + '">' + dl('dlDiv', uniq('division')),
        '예) 고객지원사업부 · 용인공장', 'oDiv') +
      fld('팀', '<input class="inp" id="oTeam" list="dlTeam" maxlength="40" value="' + esc(v.team) + '">' + dl('dlTeam', uniq('team')),
        '사업부 직속이면 비워 두세요.', 'oTeam') +
      fld('센터·파트', '<input class="inp" id="oUnit" list="dlUnit" maxlength="40" value="' + esc(v.unit) + '">' + dl('dlUnit', uniq('unit')),
        '팀 직속이면 비워 두세요.', 'oUnit') +
      fld('직급', '<input class="inp" id="oRank" list="dlRank" maxlength="20" value="' + esc(v.rank) + '">' + dl('dlRank', RANKS), null, 'oRank') +
      fld('직책', '<input class="inp" id="oRole" list="dlRole" maxlength="20" value="' + esc(v.role) + '">' +
        dl('dlRole', ['사업부장', '팀장', '센터장', '파트장', '공장장', '실장']),
        '<b>그 부서의 장</b>일 때만 넣으세요. 센터장, 파트장, 팀장, 사업부장이면 직원들의 결재선이 이 칸으로 미리 채워져요. 한 부서에 한 명만 넣고, 장이 아니면 비워 두세요.', 'oRole') +
      fld('담당 업무', '<input class="inp" id="oDuty" maxlength="80" value="' + esc(v.duty) + '">', null, 'oDuty') +
      fld('회사 메일', '<input class="inp" id="oEmail" type="email" maxlength="80" value="' + esc(v.email || '') + '">',
        '팀즈 아이디와 같은 메일을 넣으세요. 결재 차례가 되면 이 주소로 팀즈 개인 채팅 알림이 가요.', 'oEmail') +
      fld('앱 계정', '<select class="inp" id="oUser"><option value="">없음 (아직 가입 전)</option>' +
        accts.map(function (u) {
          var pp = S.PEOPLE[u] || {};
          return '<option value="' + esc(u) + '"' + (v.username === u ? ' selected' : '') + '>' +
            esc(C.nameOf(u)) + ' · ' + esc(pp.dept || '') + ' · ' + esc(u) + '</option>';
        }).join('') + '</select>', '계정이 있어야 결재할 수 있어요. 같은 이름이 둘이면 소속을 보고 고르세요.', 'oUser') +
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
    if ($('lovSave') && LOV) return lovSig() !== LOV.init;      // 결재선 지정 창(2026-10-14)
    return false;
  }
  function reloadOrg() {
    return C.fetchAll('/rest/v1/driving_org?select=*&active=eq.true&order=sort.asc,id.asc')
      .then(function (rows) { C.setOrg(rows); });
  }
  function fail(r, what) {
    return r.text().then(function (t) {
      var msg = r.status === 401 || r.status === 403 || /row-level security|permission/i.test(t)
        ? '권한이 없어요. 운행일지 관리자만 고칠 수 있어요.' : what + '. 잠시 후 다시 해 주세요.';
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
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) { C.toast('메일 주소 형식이 맞지 않아요.', true); $('oEmail').focus(); return; }
    if (!row.division) { C.toast('사업부를 넣어 주세요.', true); $('oDiv').focus(); return; }
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
    req.then(function (r) { if (!r.ok) return fail(r, '저장하지 못했어요'); })
      .then(reloadOrg)
      .then(function () { C.closePanel(); C.toast(id ? '고쳤어요.' : row.name + ' 님을 추가했어요.'); C.render(); })
      .catch(function (e) { if (btn) btn.disabled = false; C.toast((e && e.message) || '저장하지 못했어요. 잠시 후 다시 해 주세요.', true); });
  }
  function askOff(id) {
    var S = C.state(), o = S.ORG.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!o) return;
    C.openPanel('목록에서 내리기', o.name + ' · ' + [o.team, o.unit].filter(Boolean).join(' › '),
      '<div class="anote" style="margin-top:0"><b>' + esc(o.name) + '</b> 님을 조직도 목록에서 내릴까요? ' +
      '기록은 지우지 않아요. 앱 계정, 운행 기록, 이미 올라간 결재 건도 그대로 남아요.</div>',
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="oOffGo" data-id="' + o.id + '">내리기</button>');
  }
  function runOff(id) {
    C.apiRetry('/rest/v1/driving_org?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ active: false, updated_by: C.myName(), updated_at: new Date().toISOString() })
    }).then(function (r) { if (!r.ok) return fail(r, '목록에서 내리지 못했어요'); })
      .then(reloadOrg)
      .then(function () { C.closePanel(); C.toast('목록에서 내렸어요.'); C.render(); })
      .catch(function (e) { C.toast((e && e.message) || '내리지 못했어요.', true); });
  }

  /* ══════════════════ 결재선 지정 (2026-10-14) ══════════════════
     한 사람의 세 칸(센터·파트장 · 팀장 · 사업부장)을 칸마다 「자동」(조직도 직책 — 지금 무엇이 들어가는지 흐리게) ·
     「비움」(빗금) · 「사람」(찾아서 고름)으로 정한다. 저장 = driving_line_override 한 줄(키 없음 = 자동, '' = 비움).
     「자동으로 되돌리기」 = 그 줄을 지운다. 「이 부서 사람 모두에 적용」 = 고른 부서(아래 부서 포함)의 앱 계정 직원 모두에
     같은 칸을 쓴다(몇 명인지 먼저 보이고 한 번 더 누른다). 쓰기는 서버 정책이 운행일지 관리자에게만 허락한다. */
  var LOV = null;     // { u, o, mode: {칸: 'auto'|'empty'|'pick'}, who: {칸: 아이디}, open: 고르는 칸, q, init, confirm: 부서 적용 확인 중 }
  function lovBoxes() {
    var b = {};
    C.APPR_BOXES.forEach(function (k) {
      var m = LOV.mode[k];
      if (m === 'empty') b[k] = '';
      else if (m === 'pick' && LOV.who[k]) b[k] = LOV.who[k];
    });
    return b;
  }
  function lovSig() {
    return C.APPR_BOXES.map(function (k) { return k + '=' + LOV.mode[k] + ':' + (LOV.who[k] || ''); }).join('|');
  }
  function openLov(u) {
    var S = C.state();
    if (!canLov()) { C.toast('운행일지 관리자만 결재선을 지정할 수 있어요.', true); return; }
    var o = S.ORG.filter(function (x) { return x.username === u && x.active !== false; })[0];
    if (!o) return;
    var b = C.lineOverride(u) || {};
    LOV = { u: u, o: o, mode: {}, who: {}, open: '', q: '', confirm: false };
    C.APPR_BOXES.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) LOV.mode[k] = 'auto';
      else if (!b[k]) LOV.mode[k] = 'empty';
      else { LOV.mode[k] = 'pick'; LOV.who[k] = b[k]; }
    });
    LOV.init = lovSig();
    C.openPanel('결재선 지정', o.name + ' · ' + ([o.team, o.unit].filter(Boolean).join(' › ') || o.division), '', '', true);
    paintLov();
  }
  /** 이 칸에 자동이면 들어갈 것(흐리게 보인다). */
  function autoText(al, k) {
    var s = al.steps.filter(function (x) { return x.box === k; })[0];
    if (s) return C.nameOf(s.approver);
    var n = al.notes.filter(function (x) { return x.box === k; })[0];
    return n ? '비움: ' + n.why : '비움';
  }
  function lovCandHtml() {
    var S = C.state(), q = LOV.q.trim().toLowerCase(), pos = posOf(LOV.o);
    var list = Object.keys(S.PEOPLE).filter(function (u) { return C.canApprove(u); });
    if (q) {
      list = list.filter(function (u) {
        var p = S.PEOPLE[u] || {}, x = S.ORG.filter(function (r) { return r.username === u && r.active !== false; })[0] || {};
        return [C.nameOf(u), u, p.dept || '', p.position || '', x.division || '', x.team || '', x.unit || '', x.rank || '', x.role || '']
          .join(' ').toLowerCase().indexOf(q) >= 0;
      });
    }
    // 같은 사업부 사람을 먼저, 그다음 이름 순
    var inDiv = function (u) { return C.orgPath(u).div === pos.division ? 0 : 1; };
    list.sort(function (a, b) { return inDiv(a) - inDiv(b) || C.nameOf(a).localeCompare(C.nameOf(b), 'ko'); });
    var more = list.length > 40;
    list = list.slice(0, 40);
    if (!list.length) return '<div class="blank" style="padding:14px"><div class="t">찾는 분이 없어요.</div>' +
      '<div class="d">결재자는 조직도에 있고 앱 계정이 연결된 분만 고를 수 있어요.</div></div>';
    return list.map(function (u) {
      return '<button class="acand-i" data-lovpick="' + esc(u) + '"><b>' + esc(C.nameOf(u)) + '</b><span>' + esc(C.orgLabel(u)) + '</span>' +
        (u === LOV.u ? '<span class="st" style="flex:none;margin-left:6px">본인</span>' : '') + '</button>';
    }).join('') + (more ? '<div class="anote" style="margin:6px 12px">더 있어요. 이름을 입력해 좁혀 주세요.</div>' : '');
  }
  /** 고른 부서(아래 부서 포함)의 앱 계정 직원 — 「이 부서 사람 모두에 적용」 대상. */
  function lovTargets() {
    var S = C.state(), seen = {};
    return S.ORG.filter(function (o) {
      if (o.active === false || !o.username || !S.PEOPLE[o.username] || !inNode(o, SEL) || seen[o.username]) return false;
      seen[o.username] = 1; return true;
    });
  }
  function paintLov() {
    if (!LOV) return;
    var al = C.lineAt(posOf(LOV.o), LOV.o), had = !!C.lineOverride(LOV.u);
    var h = '<div class="anote" style="margin-top:0">칸마다 <b>자동</b>(조직도 직책으로 채움), <b>비움</b>(빗금, 건너뜀), <b>사람 지정</b> 중에서 고르세요. ' +
      '저장하면 ' + esc(LOV.o.name) + ' 님이 상신 창을 열 때 이 결재선이 먼저 채워져요. 이번 기간에 반려·회수된 결재선이 있으면 그것이 먼저예요. ' +
      '본인이 들어간 칸은 빈칸이 돼요. 전자 결재는 사업부장에서 끝나서 대표이사 칸은 고를 수 없어요. ' + esc(LOV.o.name) + ' 님도 상신 창에서 칸마다 바꾸거나 비울 수 있어요.</div>';
    h += '<div class="olov">' + C.APPR_BOXES.map(function (k, i) {
      var m = LOV.mode[k], who = LOV.who[k];
      var r = function (val, label, extra) {
        return '<label class="radio"><input type="radio" name="lov' + i + '" value="' + val + '" data-lovset="' + esc(k) + '"' + (m === val ? ' checked' : '') + '>' +
          '<span>' + label + '</span>' + (extra || '') + '</label>';
      };
      return '<div class="olov-row" data-lovrow="' + esc(k) + '"><div class="olov-h" id="lovh' + i + '"><b>' + esc(k) + '</b> 칸</div>' +
        '<div class="radios" role="radiogroup" aria-labelledby="lovh' + i + '">' +
        r('auto', '자동', ' <small class="olov-auto">' + esc(autoText(al, k)) + '</small>') +
        r('empty', '비움(/)') +
        r('pick', who ? esc(C.nameOf(who)) + (C.canApprove(who) ? '' : ' <small>(지금 결재 못 함)</small>') : '사람 지정') +
        '</div>' +
        (LOV.open === k ? '<div class="olov-pick"><input class="inp" id="lovQ" autocomplete="off" aria-label="' + esc(k) + ' 칸에 넣을 분 찾기" ' +
          'placeholder="이름, 부서, 직급으로 찾기" value="' + esc(LOV.q) + '">' +
          '<div class="olov-cand" id="lovCand">' + lovCandHtml() + '</div></div>' : '') +
        '</div>';
    }).join('') + '</div>';
    // 이대로 저장하면 — 상신 창에 채워질 결재선
    var m2 = C.applyOverride(C.lineAt(posOf(LOV.o), LOV.o), lovBoxes(), LOV.u);
    h += '<div class="olov-prev"><div class="olov-h"><b>저장하면 미리 채워질 결재선</b></div>' + lineHtml(m2.steps) + notesHtml(m2.notes) + '</div>';
    if (LOV.confirm) {
      var tg = lovTargets();
      h += '<div class="awarn" id="lovConfirm" style="margin-top:12px">' + ic('alert', 15) + '<span><b>' + esc(nodeName(SEL)) + '</b>의 앱 계정 직원 <b>' + n0(tg.length) +
        '명</b>(하위 부서 포함)의 결재선을 모두 이것으로 바꿔요. 지금 지정이 있으면 덮어써요. 대상: ' +
        esc(tg.slice(0, 12).map(function (o) { return o.name; }).join(', ') + (tg.length > 12 ? ' 외 ' + (tg.length - 12) + '명' : '')) + '</span></div>' +
        // 본문 안 확인 줄도 [동작] [취소] 차례(2026-10-20 단추 차례 통일 — 창 아래 줄 규칙 footOrder 가 닿지 않는 곳이라 여기서)
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">' +
        '<button class="btn sm pri" id="lovAllGo" data-n="' + tg.length + '">' + n0(tg.length) + '명에 적용</button><button class="btn sm" data-lovallno>취소</button></div>';
    }
    $('pBody').innerHTML = h;
    $('pFoot').innerHTML = (had ? '<button class="btn" id="lovClear">자동으로 되돌리기</button>' : '') +
      (SEL ? '<button class="btn" data-lovall>이 부서 사람 모두에 적용</button>' : '') +
      '<span style="flex:1"></span><button class="btn" data-close>취소</button>' +
      '<button class="btn pri" id="lovSave">저장</button>';
    var qb = $('lovQ'); if (qb) qb.focus();
  }
  /** 칸 값이 다 정해졌는가 — 「사람 지정」인데 아직 안 고른 칸이 있으면 알리고 false. */
  function lovReady() {
    var miss = C.APPR_BOXES.filter(function (k) { return LOV.mode[k] === 'pick' && !LOV.who[k]; })[0];
    if (miss) { C.toast('‘' + miss + '’ 칸에 넣을 분을 골라 주세요.', true); LOV.open = miss; paintLov(); return false; }
    return true;
  }
  function reloadLov() {
    return C.fetchLineOv().then(function (rows) {
      if (!rows) throw new Error('저장은 됐지만 목록을 다시 불러오지 못했어요. 새로고침해 주세요.');
      C.setLineOv(rows);
    });
  }
  /** 여러 사람에 같은 칸을 쓴다. 칸이 모두 자동이면 줄을 지운다(= 자동으로 되돌리기). */
  function writeLov(users, boxes) {
    var path = '/rest/v1/driving_line_override';
    var req = Object.keys(boxes).length
      ? C.apiRetry(path + '?on_conflict=username', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(users.map(function (u) { return { username: u, boxes: boxes, updated_by: C.myName() }; }))
      })
      : C.apiRetry(path + '?username=in.' + encodeURIComponent('(' + users.map(function (u) { return '"' + String(u).replace(/["\\]/g, '') + '"'; }).join(',') + ')'), {
        method: 'DELETE', headers: { Prefer: 'return=minimal' }
      });
    return req.then(function (r) { if (!r.ok) return fail(r, '결재선을 저장하지 못했어요'); }).then(reloadLov);
  }
  function lovDone(msg) { LOV = null; C.closePanel(); C.toast(msg); C.render(); }
  function saveLov() {
    if (!LOV || !lovReady()) return;
    var b = lovBoxes(), nm = LOV.o.name, btn = $('lovSave'); if (btn) btn.disabled = true;
    writeLov([LOV.u], b)
      .then(function () { lovDone(Object.keys(b).length ? nm + ' 님의 결재선을 지정했어요.' : nm + ' 님의 결재선을 자동으로 되돌렸어요.'); })
      .catch(function (e) { if (btn) btn.disabled = false; C.toast((e && e.message) || '저장하지 못했어요. 잠시 후 다시 해 주세요.', true); });
  }
  function clearLov() {
    if (!LOV) return;
    var nm = LOV.o.name;
    writeLov([LOV.u], {})
      .then(function () { lovDone(nm + ' 님의 결재선을 자동으로 되돌렸어요.'); })
      .catch(function (e) { C.toast((e && e.message) || '되돌리지 못했어요.', true); });
  }
  function applyAllLov() {
    if (!LOV) return;
    var tg = lovTargets().map(function (o) { return o.username; });
    if (!tg.length) { C.toast('이 부서에 앱 계정이 있는 직원이 없어요.', true); return; }
    var b = lovBoxes(), btn = $('lovAllGo'); if (btn) btn.disabled = true;
    writeLov(tg, b)
      .then(function () { lovDone(nodeName(SEL) + ' 직원 ' + n0(tg.length) + '명의 결재선을 ' + (Object.keys(b).length ? '지정했어요.' : '자동으로 되돌렸어요.')); })
      .catch(function (e) { if (btn) btn.disabled = false; C.toast((e && e.message) || '저장하지 못했어요. 잠시 후 다시 해 주세요.', true); });
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
      return '<tr><td><span class="lead">' + esc(nm) + '</span><div class="dim" style="font-size:12px">' + esc(u) + '</div></td>' +
        '<td class="dim">' + esc([pp.dept, pp.position].filter(Boolean).join(' · ') || '—') + '</td>' +
        '<td style="min-width:240px"><select class="inp" data-olinksel="' + esc(u) + '" style="height:auto">' + opts + '</select></td>' +
        '<td class="n"><button class="btn sm pri" data-olink="' + esc(u) + '">잇기</button></td></tr>';
    }).join('');
    C.openPanel('조직도에 안 이어진 계정', n0(unl.length) + '명',
      unl.length
        ? '<div class="anote" style="margin-top:0">웹이나 앱으로 가입했지만 조직도의 누구인지 정해지지 않은 계정이에요. ' +
          '<b>조직도의 그 사람</b>을 고르고 ‘잇기’를 누르세요. 같은 이름이 한 명이면 미리 골라 뒀어요. ' +
          '조직도에 없는 사람이면 창을 닫고 ‘＋ 사람 추가’로 만든 뒤 앱 계정을 고르세요.<br>' +
          '이으면 <b>결재자로 고를 수 있고</b>, 관리 화면의 <b>소속(사업부·팀·파트)</b>도 바르게 묶여요.</div>' +
          '<div class="panel" style="margin-top:12px"><div class="scroll"><table><thead><tr><th>계정</th><th>가입 때 적은 부서</th><th>조직도의 누구?</th><th></th></tr></thead><tbody>' +
          rows + '</tbody></table></div></div>'
        : C.blank('모든 계정이 조직도에 이어져 있어요.', null, 'users'),
      '<span style="flex:1"></span><button class="btn" data-close>닫기</button>', true);
  }
  function linkAcct(u) {
    var sel = null;
    Array.prototype.forEach.call(document.querySelectorAll('[data-olinksel]'), function (x) { if (x.dataset.olinksel === u) sel = x; });
    var id = sel && sel.value;
    if (!id) { C.toast('조직도에서 누구인지 먼저 골라 주세요.', true); if (sel) sel.focus(); return; }
    var S = C.state(), o = S.ORG.filter(function (x) { return String(x.id) === String(id); })[0];
    // 고를 때 본 계정 칸 그대로일 때만 잇는다(2026-10-20 AU2 #16) — 그 사이 다른 관리자가 그 사람에게 다른 계정을 이었으면
    //   말없이 덮지 않는다. 비어 있던 사람이면 username=is.null, 없어진 계정이 남아 있던 사람이면 그 값 그대로.
    var was = o && o.username ? 'eq.' + encodeURIComponent(o.username) : 'is.null';
    C.apiRetry('/rest/v1/driving_org?id=eq.' + encodeURIComponent(id) + '&username=' + was, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ username: u, updated_by: C.myName(), updated_at: new Date().toISOString() })
    }).then(function (r) {
      if (!r.ok) return fail(r, '계정을 연결하지 못했어요');
      return r.json().catch(function () { return null; }).then(function (rows) {
        if (!Array.isArray(rows) || !rows.length) { var er = new Error('그사이 다른 분이 이 사람에게 계정을 연결했어요. 목록을 다시 불러왔으니 확인해 주세요.'); er.raced = true; throw er; }
      });
    })
      .then(reloadOrg)
      .then(function () { C.toast(C.nameOf(u) + ' 계정을 ' + (o ? o.name + ' 님에게' : '조직도에') + ' 연결했어요.'); C.render(); openUnlinked(); })
      .catch(function (e) {
        C.toast((e && e.message) || '연결하지 못했어요. 잠시 후 다시 해 주세요.', true);
        if (e && e.raced) reloadOrg().then(function () { C.render(); openUnlinked(); }, function () { });
      });
  }

  /* ══════════════════ 이벤트 ══════════════════ */
  document.addEventListener('click', function (e) {
    var el;
    if ((el = e.target.closest('[data-onode]'))) {
      // 다시 그리면 부서 나무의 스크롤이 맨 위로 돌아갔다(2026-10-14 사용자) — 보던 자리를 지킨다.
      var tr = el.closest('.otree'), st = tr ? tr.scrollTop : 0, py = window.scrollY;
      SEL = el.dataset.onode; Q = ''; C.render();
      var nt = document.querySelector('.otree'); if (nt) nt.scrollTop = st;
      window.scrollTo(0, py);
      return;
    }
    if (e.target.closest('[data-ounl]')) { openUnlinked(); return; }
    if ((el = e.target.closest('[data-olink]'))) { linkAcct(el.dataset.olink); return; }
    if ((el = e.target.closest('[data-of]'))) { OF = OF === el.dataset.of ? '' : el.dataset.of; C.render(); return; }
    if (e.target.closest('[data-oadd]')) { openPerson(null); return; }
    if ((el = e.target.closest('[data-oedit]'))) { openPerson(el.dataset.oedit); return; }
    if ((el = e.target.closest('#oSave'))) { savePerson(el.dataset.id); return; }
    if ((el = e.target.closest('[data-ooff]'))) { askOff(el.dataset.ooff); return; }
    if ((el = e.target.closest('#oOffGo'))) { runOff(el.dataset.id); return; }
    // 결재선 지정(2026-10-14)
    if ((el = e.target.closest('[data-olov]'))) { openLov(el.dataset.olov); return; }
    if (!LOV) return;
    if (e.target.matches && e.target.matches('input[data-lovset]')) {
      var k = e.target.dataset.lovset, v = e.target.value;
      LOV.mode[k] = v; LOV.confirm = false;
      if (v === 'pick') { LOV.open = k; LOV.q = ''; } else if (LOV.open === k) LOV.open = '';
      paintLov();
      // 키보드(화살표·스페이스)로 골랐으면 다시 그린 뒤에도 그 칸의 고른 칩에 포커스를 둔다 — 안 그러면 포커스가 창 밖으로 빠졌다(2026-10-16 5차).
      //   「사람 지정」은 찾기 칸으로 간다(paintLov 가 옮긴다).
      if (v !== 'pick' && e.detail === 0) {
        var f = document.querySelector('input[data-lovset="' + CSS.escape(k) + '"]:checked'); if (f) f.focus();
      }
      return;
    }
    if ((el = e.target.closest('[data-lovpick]'))) {
      LOV.who[LOV.open] = el.dataset.lovpick; LOV.mode[LOV.open] = 'pick'; LOV.open = ''; LOV.q = ''; LOV.confirm = false;
      paintLov();
      return;
    }
    if (e.target.closest('#lovSave')) { saveLov(); return; }
    if (e.target.closest('#lovClear')) { clearLov(); return; }
    if (e.target.closest('[data-lovall]')) { if (lovReady()) { LOV.confirm = true; paintLov(); var g = $('lovAllGo'); if (g) g.focus(); } return; }
    if (e.target.closest('[data-lovallno]')) { LOV.confirm = false; paintLov(); return; }
    if (e.target.closest('#lovAllGo')) { applyAllLov(); return; }
  });
  // 결재자 찾기 — 목록만 다시 그린다(입력 칸은 그대로라 한글 조합이 깨지지 않는다)
  document.addEventListener('input', function (e) {
    if (e.target.id !== 'lovQ' || !LOV) return;
    LOV.q = e.target.value;
    var c = $('lovCand'); if (c) c.innerHTML = lovCandHtml();
  });
  // Enter = 맨 위 후보 넣기(한글 조합 중 Enter 는 글자 확정이라 건너뛴다)
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing || e.target.id !== 'lovQ' || !LOV) return;
    e.preventDefault();
    var f = document.querySelector('#lovCand [data-lovpick]'); if (f) f.click();
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
