/* ═══════════════════════════════════════════════════════════════════════════
   comments.js — 결재 의견 순수 계산(2026-11-26 묶음 D)
   ---------------------------------------------------------------------------
   · rowsOf · sigAll · countOf   의견 줄 고르기 · 바뀜 판단 · 개수
   · srcLabel · canEdit          줄의 출처 글 · 고칠 수 있는가(본인 + 반려 사유 아님)
   · count                       글자 수(코드 포인트) · 1,000자 넘음
   · atQuery · pickList · applyPick   「@」 로 사람 부르기(찾기 · 목록 · 끼우기)
   · keepMentions · marks        글에 남은 「@이름」 만 부른 사람으로 · 글을 조각으로(HTML 은 만들지 않는다 — 그리는 쪽이 esc)
   브라우저 window.AtecComments · Node module.exports. ES5 꼴(빌드 없음). DOM 을 만지지 않는다.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.AtecComments = factory(root);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX = 1000, MENTION_MAX = 10, Q_MAX = 10, PICK_MAX = 8;

  function cpLen(s) { return Array.from(String(s == null ? '' : s)).length; }
  function isSpace(ch) { return /\s/.test(ch); }

  /** 그 문서(kind · id)의 줄 — 등록 시각 → id 차례. */
  function rowsOf(list, kind, id) {
    var out = [], i;
    list = list || [];
    for (i = 0; i < list.length; i++) {
      var r = list[i];
      if (r && r.kind === kind && Number(r.approval_id) === Number(id)) out.push(r);
    }
    out.sort(function (a, b) {
      var x = String(a.created_at || ''), y = String(b.created_at || '');
      if (x !== y) return x < y ? -1 : 1;
      return Number(a.id) - Number(b.id);
    });
    return out;
  }

  /** 바뀜 판단 글 — id@edited_at 을 id 차례로 이었다(받은 차례와 상관없다). */
  function sigAll(list) {
    var a = (list || []).slice().sort(function (p, q) { return Number(p.id) - Number(q.id); });
    return a.map(function (r) { return r.id + '@' + (r.edited_at || ''); }).join(',');
  }

  function countOf(list, kind, id) { return rowsOf(list, kind, id).length; }

  function srcLabel(row) {
    var s = row && row.src;
    return s === 'submit' ? '상신 의견' : s === 'approve' ? '승인 의견' : s === 'reject' ? '반려 사유' : '';
  }

  function canEdit(row, me) { return !!row && !!me && row.author === me && row.src !== 'reject'; }

  /* 서버 note.ts cleanText 와 같은 글 정리 — 글자 수를 서버가 세는 글과 맞춘다(NFC · 줄바꿈 · 보이지 않는 글자 · 줄 끝 빈칸 · 빈 줄 둘까지 · 앞뒤 빈칸) */
  var INVISIBLE = [[0x00, 0x09], [0x0B, 0x1F], [0x7F, 0x84], [0x86, 0x9F], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2064], [0xFEFF, 0xFEFF], [0xFFF9, 0xFFFC]];
  function cleanText(raw) {
    var s = String(raw == null ? '' : raw);
    s = (s.normalize ? s.normalize('NFC') : s).replace(/\r\n?/g, '\n');
    var out = '';
    Array.from(s).forEach(function (ch) {
      var cp = ch.codePointAt(0), i;
      if (cp === 0x85 || cp === 0x2028 || cp === 0x2029) { out += '\n'; return; }
      if (cp === 0x09) { out += ' '; return; }
      if (cp === 0x0A) { out += ch; return; }
      for (i = 0; i < INVISIBLE.length; i++) if (cp >= INVISIBLE[i][0] && cp <= INVISIBLE[i][1]) return;
      out += ch;
    });
    return out.split('\n').map(function (l) { return l.replace(/\s+$/, ''); }).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
  }

  function count(text) {
    var n = cpLen(cleanText(text));
    return { n: n, over: n > MAX };
  }

  /** 커서 앞 가장 가까운 「@」 — 글 처음이거나 빈칸·줄바꿈 뒤, 사이에 빈칸이 없고 10자 이하일 때만. */
  function atQuery(text, caret) {
    text = String(text == null ? '' : text);
    var c = typeof caret === 'number' ? caret : text.length;
    if (c < 0 || c > text.length) c = text.length;
    var head = text.slice(0, c), at = head.lastIndexOf('@');
    if (at < 0) return null;
    if (at > 0 && !isSpace(head.charAt(at - 1))) return null;
    var q = head.slice(at + 1);
    if (/\s/.test(q) || cpLen(q) > Q_MAX) return null;
    return { from: at, q: q };
  }

  /** 목록 — 이름에 q 가 든 사람(본인 빼고) 8명까지 · 이름 → 소속 차례. sub 는 같은 이름을 가르는 둘째 줄. */
  function pickList(people, q, me) {
    var out = [], i;
    q = String(q == null ? '' : q);
    people = people || [];
    for (i = 0; i < people.length; i++) {
      var p = people[i];
      if (!p || !p.username || p.username === me || !p.name) continue;
      if (q && String(p.name).indexOf(q) < 0) continue;
      out.push({ username: p.username, name: p.name, sub: [p.dept, p.title].filter(Boolean).join(' · ') });
    }
    out.sort(function (a, b) {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      if (a.sub !== b.sub) return a.sub < b.sub ? -1 : 1;
      return a.username < b.username ? -1 : a.username > b.username ? 1 : 0;
    });
    return out.slice(0, PICK_MAX);
  }

  /** 「@q」 를 「@이름 」 으로 — 커서는 그 뒤. at = atQuery 의 결과. */
  function applyPick(text, caret, at, person) {
    text = String(text == null ? '' : text);
    var c = typeof caret === 'number' ? caret : text.length;
    var ins = '@' + person.name + ' ';
    return { text: text.slice(0, at.from) + ins + text.slice(c), caret: at.from + ins.length };
  }

  /** 글에 「@이름」 이 남은 사람만 · 중복 없이 · 10명. */
  function keepMentions(text, picked) {
    var out = [], seen = {}, i;
    text = String(text == null ? '' : text);
    picked = picked || [];
    for (i = 0; i < picked.length && out.length < MENTION_MAX; i++) {
      var p = picked[i];
      if (!p || !p.username || !p.name || seen[p.username]) continue;
      if (text.indexOf('@' + p.name) < 0) continue;
      seen[p.username] = 1;
      out.push(p.username);
    }
    return out;
  }

  /** 글을 조각으로 — 불린 이름의 「@이름」 조각만 at:true. 긴 이름 먼저 맞춘다. */
  function marks(text, names) {
    text = String(text == null ? '' : text);
    var toks = [], i;
    for (i = 0; i < (names || []).length; i++) if (names[i]) toks.push('@' + names[i]);
    toks.sort(function (a, b) { return b.length - a.length; });
    var out = [], buf = '', pos = 0;
    function flush() { if (buf) { out.push({ t: buf, at: false }); buf = ''; } }
    while (pos < text.length) {
      var hit = '';
      for (i = 0; i < toks.length; i++) if (text.substr(pos, toks[i].length) === toks[i]) { hit = toks[i]; break; }
      if (hit) { flush(); out.push({ t: hit, at: true }); pos += hit.length; }
      else { buf += text.charAt(pos); pos++; }
    }
    flush();
    return out;
  }

  return {
    MAX: MAX, MENTION_MAX: MENTION_MAX,
    rowsOf: rowsOf, sigAll: sigAll, countOf: countOf, srcLabel: srcLabel, canEdit: canEdit, count: count,
    atQuery: atQuery, pickList: pickList, applyPick: applyPick, keepMentions: keepMentions, marks: marks
  };
});
