/* ═══════════════════════════════════════════════════════════════════════════
 *  하이패스 영수증 PDF → 운행 배분  (브라우저에서 전부 처리)
 *
 *  읽기는 브라우저가 직접 한다 — (일시·금액·영업소·카드뒷4자리)만 뽑고, 이미 받아둔 운행 목록에 맞춘다.
 *  반영은 사람이 확인한 것만 toll-apply 로 보낸다. 기록을 읽은 PDF 원본은 증빙 저장소에 따로 보관한다
 *  (2026-10-23 — driving-app.js hpKeep, 줄마다 그 원본 경로를 pdf 로 보낸다. 이 파일은 저장소를 건드리지 않는다).
 *
 *  PDF 구조 (한국도로공사 영수증 출력물)
 *    · 한 페이지에 영수증이 4열 × N행 격자
 *    · 본문이 Flate 로 압축돼 있고, 글자는 CID(Type0) 라 ToUnicode 표를 풀어야 읽힌다
 *    · 글자 하나하나가 `1 0 0 1 x y Tm ... (코드)Tj` 로 따로 찍힌다
 *  하이패스 홈페이지 「영수증 출력」 화면을 브라우저로 인쇄해 저장한 PDF 도 읽는다(parsePrint — pdf.js 글자 추출)
 *  ═════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── zlib inflate ──────────────────────────────────────────────────────────
   *  브라우저 기본 DecompressionStream 을 쓴다. 다만 이건 Node 의 zlib 과 달리
   *  **압축 데이터 뒤에 한 바이트라도 더 있으면 통째로 거부**한다.
   *  PDF 는 endstream 앞에 개행을 넣으므로 그대로 넣으면 전부 실패한다.
   *    ① 끝의 개행·공백을 떼고
   *    ② 그래도 잡동사니가 걸리면, 오류 전까지 받아낸 조각을 살려 쓴다
   *  ────────────────────────────────────────────────────────────────────────── */
  async function tryInflate(data, fmt) {
    try {
      var ds = new DecompressionStream(fmt);
      var rd = new Blob([data]).stream().pipeThrough(ds).getReader();
      var parts = [], total = 0;
      try {
        for (;;) {
          var r = await rd.read();
          if (r.done) break;
          parts.push(r.value); total += r.value.length;
        }
      } catch (e) { /* 뒤에 잡동사니 — 여기까지 받은 건 쓴다 */ }
      if (!total) return null;
      var out = new Uint8Array(total), off = 0;
      parts.forEach(function (p) { out.set(p, off); off += p.length; });
      return out;
    } catch (e) { return null; }
  }
  async function inflate(u8) {
    var e = u8.length;
    while (e > 0 && (u8[e - 1] === 10 || u8[e - 1] === 13 || u8[e - 1] === 32)) e--;
    var data = u8.subarray(0, e);
    var got = await tryInflate(data, 'deflate');
    if (got && got.length) return got;
    got = await tryInflate(data, 'deflate-raw');
    return (got && got.length) ? got : null;
  }

  function latin1(u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH)
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return s;
  }

  /* ── PDF 문자열 리터럴의 이스케이프를 바이트로 되돌린다 ── */
  function unesc(t) {
    var out = [], map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      if (c !== '\\') { out.push(t.charCodeAt(i)); continue; }
      var n = t[++i];
      if (n in map) out.push(map[n]);
      else if (n >= '0' && n <= '7') {
        var o = n;
        while (o.length < 3 && t[i + 1] >= '0' && t[i + 1] <= '7') o += t[++i];
        out.push(parseInt(o, 8));
      } else out.push(t.charCodeAt(i));
    }
    return out;
  }

  /** PDF 바이트 → 영수증 레코드 배열
   *  ① 한국도로공사가 내려주는 PDF(아래 parseDirect) 를 먼저 읽고,
   *  ② 못 읽으면 하이패스 홈페이지 「영수증 출력」 화면을 브라우저로 인쇄해 저장한 PDF 로 보고
   *     pdf.js 글자 추출(parsePrint)로 읽는다(2026-10-19).
   *  opts.pdfjs: pdf.js 모듈(또는 그것을 주는 Promise·함수). 없으면 window.__pdfjs.
   *  돌려주는 배열에 .how('direct'|'print') · .total({n,sum} 파일에 적힌 합계) · .warning(합계가 안 맞을 때 안내) 이 붙는다. */
  async function parsePdf(buf, opts) {
    var copy = new Uint8Array(buf).slice();   // pdf.js 가 버퍼를 넘겨받아(분리) 비우므로 따로 둔다
    var firstErr = null, recs = null;
    try { recs = await parseDirect(buf); } catch (e) { firstErr = e; }
    if (recs && recs.length) { recs.how = 'direct'; return recs; }
    var pdfjs = null;
    try { pdfjs = await getPdfjs(opts); } catch (e) { pdfjs = null; }
    if (!pdfjs) { if (firstErr) throw firstErr; return recs || []; }
    var p;
    try { p = await parsePrint(copy, pdfjs); } catch (e) { if (firstErr) throw firstErr; throw e; }
    if (!p.length && firstErr) throw firstErr;
    return p;
  }

  async function getPdfjs(opts) {
    var src = (opts && opts.pdfjs) || global.__pdfjs || null;
    if (typeof src === 'function') src = src();
    return src ? await src : null;
  }

  /* ── 인쇄 PDF(하이패스 홈페이지 「영수증 출력」 → 크롬 인쇄 → PDF로 저장) ──────────
   *  영수증이 3열(또는 4열) 격자로 놓이고, 칸마다
   *    하이패스는 / 빠르고 편리합니다 / 영수증 / 회사 영업소 / TEL / 사업자번호 / 2026년10월12일 07시35분 /
   *    (입구영업소 : ○○) / 1 종  800 원(카드) / KEC 800 원 / 공급가액·부가세 / 카드사 / 카드번호 / 영수증 번호
   *  맨 아래 「총 N 건 / M 원」.
   *  「영수증」 머리 글자를 칸의 기준점으로 삼아 글자를 x(가까운 열)·y(그 위 가장 가까운 머리)로 묶는다. */
  async function parsePrint(u8, pdfjs) {
    var doc = await pdfjs.getDocument({ data: u8, isEvalSupported: false }).promise;
    var recs = [], total = null;
    try {
      for (var pn = 1; pn <= doc.numPages; pn++) {
        var page = await doc.getPage(pn);
        var tc = await page.getTextContent();
        var items = [];
        tc.items.forEach(function (it) {
          var t = String(it.str || '');
          if (!t.trim() || !it.transform) return;
          var h = Math.abs(it.height || it.transform[3] || 8) || 8;
          items.push({ x: it.transform[4], y: it.transform[5], w: it.width || 0, h: h, t: t, cx: it.transform[4] + (it.width || 0) / 2 });
        });
        if (!items.length) continue;

        // 쪽 전체 글줄 — 「총 N 건 / M 원」 찾기
        var tot = linesOf(items).map(function (l) { return l.t.replace(/\s/g, ''); }).join('\n')
          .match(/총(\d+)건\/([\d,]+)원/);
        if (tot) total = { n: (total ? total.n : 0) + +tot[1], sum: (total ? total.sum : 0) + +tot[2].replace(/,/g, '') };

        var heads = headsOf(items);
        // 폰 크롬 「PDF로 저장」(2026-11-12 점검 §2 — 28건 전부 못 읽던 파일): 글자가 한 자씩 따로 와서 머리 글자를 못 찾는다 →
        //   같은 줄에 붙은 글자를 낱말로 합친 뒤 같은 규칙으로 다시 찾는다. 머리를 찾는 쪽(지금 읽히는 PDF)은 그대로 둔다.
        if (!heads.length) { items = joinGlyphs(items); heads = headsOf(items); }
        if (!heads.length) continue;

        // 열 = 머리 글자 가운데 x 를 묶은 것
        var cols = [];
        heads.slice().sort(function (a, b) { return a.cx - b.cx; }).forEach(function (hd) {
          var c = cols[cols.length - 1];
          if (c && Math.abs(hd.cx - c.x) < 30) c.heads.push(hd);
          else cols.push({ x: hd.cx, heads: [hd] });
        });
        var cells = new Map();
        items.forEach(function (it) {
          var col = null, best = Infinity;
          cols.forEach(function (c) { var d = Math.abs(it.cx - c.x); if (d < best) { best = d; col = c; } });
          // 그 열에서, 글자보다 위(머리 높이 4배까지 여유 — 머리 위 「하이패스는」 두 줄)인 머리 중 가장 아래 것
          var own = null;
          col.heads.forEach(function (hd) {
            if (hd.y + hd.h * 4 >= it.y && (!own || hd.y < own.y)) own = hd;
          });
          if (!own) return;
          if (!cells.has(own)) cells.set(own, []);
          cells.get(own).push(it);
        });

        heads.forEach(function (hd) {
          var arr = cells.get(hd); if (!arr) return;
          var lines = linesOf(arr).map(function (l) { return l.t; });
          var ns = lines.map(function (l) { return l.replace(/\s/g, ''); });
          var j = ns.join('\n');
          var dt = j.match(/(\d{4})년(\d{1,2})월(\d{1,2})일(\d{1,2})시(\d{1,2})분/);
          if (!dt) return;
          var p2 = function (v) { return ('0' + v).slice(-2); };
          var ymd = dt[1] + '-' + p2(dt[2]) + '-' + p2(dt[3]), hm = p2(dt[4]) + ':' + p2(dt[5]);
          var amt = j.match(/([\d,]+)원\(카드\)/) || j.match(/\d종([\d,]+)원/);
          var cls = j.match(/(\d)종/);
          var card = j.match(/[\d*]{4}-[\d*]{2}\*\*-\*{4}-(\d{4})/) || j.match(/[\d*]{4}-[\d*]{4}-[\d*]{4}-(\d{4})/);
          var entry = j.match(/입구영업소:([^\n]+)/);
          var hi = ns.indexOf('영수증');
          var oline = hi >= 0 ? (lines[hi + 1] || '') : '';
          if (/입구영업소|TEL|사업자/.test(oline)) oline = '';
          var toks = oline.trim().split(/\s+/).filter(Boolean);
          recs.push({
            page: pn,
            at: Date.parse(ymd + 'T' + hm + ':00+09:00'),
            atText: ymd + ' ' + hm,
            office: toks.length ? toks[toks.length - 1] : '',
            entryOffice: entry ? entry[1] : null,
            carClass: cls ? +cls[1] : null,
            amount: amt ? +amt[1].replace(/,/g, '') : null,
            card4: card ? card[1] : null
          });
        });
      }
    } finally { try { doc.destroy(); } catch (e) { /* 무시 */ } }

    recs = dedupe(recs);
    recs.how = 'print';
    if (total) {
      recs.total = total;
      var sum = recs.reduce(function (a, r) { return a + r.amount; }, 0);
      if (total.n !== recs.length || total.sum !== sum) {
        recs.warning = '파일 맨 아래 ‘총 ' + total.n + '건 / ' + won(total.sum) + '’과 읽은 영수증(' + recs.length + '건 / ' +
          won(sum) + ')이 달라요. 빠진 영수증이 없는지 확인해 주세요.';
      }
    }
    return recs;
  }

  function won(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원'; }

  /** 인쇄 PDF 칸의 머리 글자(「영수증」, 없으면 「하이패스는」) */
  function headsOf(items) {
    var hs = items.filter(function (i) { return i.t.replace(/\s/g, '') === '영수증'; });
    if (!hs.length) hs = items.filter(function (i) { return /하이패스는/.test(i.t); });
    return hs;
  }

  /**
   * 한 자씩 따로 온 글자 → 낱말(parsePrint, 2026-11-12 §8.2). 같은 줄(밑줄 y 차이 1 안)에서 앞 글자 끝과 다음 글자 시작 사이가
   * 글자 높이의 0.6배 안이면 한 낱말로 잇고, 그 틈이 0.15배를 넘으면 사이에 빈칸을 둔다(「1 종」 · 「가상도로공사 서울영업소」 꼴이 붙은 글자 PDF 와 같게).
   * 그보다 먼 글자(양쪽 맞춤으로 벌어진 「회사 ⋯ 영업소」 · 옆 칸)는 따로 둔다 — linesOf 가 빈칸으로 잇는다.
   */
  function joinGlyphs(items) {
    // 먼저 줄로 묶고(밑줄 y 차이 1 안 — linesOf 처럼) 줄마다 x 차례로 잇는다 — 한 낱말 안 글자가 밑줄에서 1 안쪽으로 어긋나도
    //   쪼개지거나 차례가 바뀌지 않게(2026-11-12 Task 3 검토 2 — 예전엔 y 를 그대로 먼저 견줘 0.3 어긋난 글자가 따로 놀았다).
    var arr = items.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; }), rows = [], out = [];
    arr.forEach(function (it) {
      var l = rows[rows.length - 1];
      if (l && Math.abs(l.y - it.y) < 1) l.items.push(it);
      else rows.push({ y: it.y, items: [it] });
    });
    rows.forEach(function (row) {
      var cur = null;
      row.items.sort(function (a, b) { return a.x - b.x; }).forEach(function (it) {
        var h = Math.max(cur ? cur.h : 0, it.h), gap = cur ? it.x - cur.xe : 0;
        if (cur && gap < 0.6 * h && gap > -h) {
          cur.t += (gap > 0.15 * h ? ' ' : '') + it.t;
          cur.xe = Math.max(cur.xe, it.x + it.w); cur.h = h;
        } else {
          if (cur) out.push(cur);
          cur = { x: it.x, y: it.y, xe: it.x + it.w, h: it.h, t: it.t };
        }
      });
      if (cur) out.push(cur);
    });
    return out.map(function (c) { return { x: c.x, y: c.y, w: c.xe - c.x, h: c.h, t: c.t, cx: c.x + (c.xe - c.x) / 2 }; });
  }

  /** 글자 조각 → 글줄(위에서 아래로). y 가 2.5 안쪽이면 같은 줄(「1 종」과 「800 원(카드)」은 1.5 쯤 어긋난다). */
  function linesOf(items) {
    var arr = items.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; }), out = [];
    arr.forEach(function (it) {
      var l = out[out.length - 1];
      if (l && Math.abs(l.y - it.y) <= 2.5) l.items.push(it);
      else out.push({ y: it.y, items: [it] });
    });
    return out.map(function (l) {
      return { y: l.y, t: l.items.sort(function (a, b) { return a.x - b.x; }).map(function (i) { return i.t; }).join(' ') };
    });
  }

  /**
   * 여러 PDF 를 한 번에 올렸을 때 파일끼리 겹친 기록 빼기(2026-10-20 AU2) — 파일 하나 안의 겹침은 읽을 때(dedupe) 이미 뺐다.
   * 기간이 겹치는 두 달치 · 같은 파일을 이름만 바꿔 두 번 고른 경우 같은 통과 기록이 두 번 더해져 통행료가 두 배로 확정됐다.
   * 열쇠: 통과 시각 · 금액 · 영업소 · 카드 끝 4자리(2026-11-12 — 영업소는 다른 파일끼리면 끝이 같아도 같다, 아래 mergeFiles). lists = 파일마다 읽은 기록 배열(파일 순서대로).
   * 돌려주는 것: { recs: 합친 기록(시각 순), removed: 뺀 건수 }
   */
  /** 파일끼리 같은 기록인지 보는 열쇠(mergeFiles) — 웹 원본 보관(driving-app.js hpFiles)이 기록마다 든 파일을 찾을 때도 쓴다(2026-10-23). */
  function recKey(r) { return r.at + '|' + r.amount + '|' + (r.office || '') + '|' + (r.card4 || ''); }

  /**
   * 하이패스 PDF 원본을 보관할 저장소 경로(2026-10-23 — driving-app.js hpKeep):
   *   <아이디>/hipass/<파일 시각 KST YYYYMMDD-HHmmss>-<SHA-256 앞 16자(소문자)>.pdf
   * 서버 toll-apply 는 이 꼴(_shared/toll-evidence.ts hipassPdfOk)이고 부른 사람 폴더일 때만 줄의 pdf 를 남긴다(시험 web/test/hipass-keep.test.mjs) —
   * 그 운행이 부른 사람 것일 때만이다(2026-10-23 오후 — 관리자 「하이패스 대조 (전체)」로 남의 운행을 맞추면 pdf 는 버리고 줄만 남긴다).
   * 아이디를 경로로 쓸 수 없으면(빈칸·/·\·?·#·%·제어 문자 · 「.」·「..」 · 64자 넘음) · 시각·지문이 이상하면 null.
   */
  function keepPath(user, ms, sha256hex) {
    var u = String(user || ''), h = String(sha256hex || '').toLowerCase(), t = Number(ms);
    // eslint-disable-next-line no-control-regex
    if (!u || u.length > 64 || u === '.' || u === '..' || /[\s\/\\?#%\u0000-\u001f\u007f]/.test(u)) return null;
    if (!/^[0-9a-f]{16,}$/.test(h) || !isFinite(t) || t <= 0) return null;
    var d = new Date(t + 9 * 3600e3), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return u + '/hipass/' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' +
      p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + '-' + h.slice(0, 16) + '.pdf';
  }

  /**
   * 하이패스 PDF 원본 경로 꼴인가(2026-10-23 오후) — 서버 _shared/toll-evidence.ts hipassPdfOk 와 같은 규칙(시험 web/test/hipass-attach.test.mjs):
   *   `<아이디>/hipass/<YYYYMMDD-HHmmss>-<16자 소문자 16진>.pdf`(조각 셋 · 120자까지) · 아이디 조각에 빈칸·제어 문자·\·?·#·% 없음 ·
   *   「.」·「..」 아님 · 64자까지. owner 를 주면 그 아이디의 폴더일 때만(빈 값이면 늘 거짓). 안 주면 꼴만 본다.
   */
  function pdfOk(v, owner) {
    if (typeof v !== 'string' || v.length > 120) return false;
    var p = v.split('/');
    if (p.length !== 3 || p[1] !== 'hipass' || !/^\d{8}-\d{6}-[0-9a-f]{16}\.pdf$/.test(p[2])) return false;
    // eslint-disable-next-line no-control-regex
    if (!p[0] || p[0].length > 64 || p[0] === '.' || p[0] === '..' || /[\s\\?#%\u0000-\u001f\u007f]/.test(p[0])) return false;
    return owner === undefined ? true : (!!owner && p[0] === owner);
  }
  /** a 가 b 로 끝나는가(옛 문법만 — String endsWith 대신) */
  function endsW(a, b) { return a.length >= b.length && a.slice(a.length - b.length) === b; }
  /**
   * 출구(영업소)가 같은가(2026-10-23 오후) — 같은 글이거나, 둘 다 비어 있지 않고 한쪽이 다른 쪽으로 끝난다(서버 sameOffice 와 같다).
   * 같은 영수증이라도 한국도로공사 PDF(parseDirect)는 「서울고속도로통일로영업소」, 영수증 출력 화면을 인쇄한 PDF(parsePrint)는 「통일로영업소」로 읽힌다.
   */
  function sameOffice(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    return a === b || (a !== '' && b !== '' && (endsW(a, b) || endsW(b, a)));
  }

  /**
   * 이미 맞춘 운행에 원본만 붙이기(2026-10-23 — driving-app.js hpMarkKeep · hpApply): 운행 근거(toll_evidence_json)의 이용내역 줄 중
   * 원본(pdf)이 아직 없는 줄과 같은 통과 기록을 고른다. 서버 toll-apply 원본 붙이기(_shared/toll-evidence.ts attachPdf)와 같은 규칙이다 —
   *   · owner = 운행 주인 아이디(서버 attachPdf 의 owner — 원본이 있어야 할 폴더). 비면 아무것도 안 고른다(서버도 안 붙인다)
   *   · 줄 = 근거의 lines(비어 있지 않으면) 아니면 prev.lines(서버 hipassLinesOf) · 앞 50줄 · 근거가 객체가 아니면 줄 없음
   *   · 같은 기록 = 통과 시각(atText ↔ at)·금액(amount)이 같고 출구(office)가 같고(sameOffice — 끝이 같아도, 2026-10-23 오후),
   *     둘 다 입구가 있으면 입구(entryOffice ↔ entry)도 같다(글자는 서버 clipLines 꼴 — 제어 문자 → 빈칸 · 120자 — 로 견준다)
   *   · owner 폴더의 원본(pdfOk(pdf, owner))이 이미 있는 줄은 안 고른다 — 남의 폴더 경로·꼴이 아닌 글은 「없음」이라 고른다(2026-10-23 오후 —
   *     예전 관리자 「하이패스 대조 (전체)」가 남긴 관리자 폴더 경로는 결재 문서·R15 가 「원본 없음」으로 보는데 주인이 못 붙였다) ·
   *     pdf·page 를 더하면 키가 12개를 넘는 줄은 안 고른다
   *   · 줄 하나에 기록 하나. 한 기록과 같은 줄이 여럿이면(같은 통과가 근거에 두 번 적힘 — 읽을 때 시각·금액·영업소가 같으면 한 기록이다)
   *     그 줄을 모두 고르고 그 기록을 줄 수만큼 돌려준다 — 서버는 받은 줄 하나에 근거 줄 하나씩 붙이므로, 한 번 올리면 다 붙는다.
   * 시험 web/test/hipass-attach.test.mjs(서버와 맞춰 본다). 돌려주는 것: 고른 기록(recs 차례 · 같은 기록이 거듭 나올 수 있다).
   */
  function needPdf(ej, recs, owner) {
    var ob = function (v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; };
    // eslint-disable-next-line no-control-regex
    var nm = function (v) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 120) : null; };
    var who = typeof owner === 'string' ? owner : '';
    if (!who) return [];
    var o = ob(ej), pv = o && ob(o.prev);
    var ls = o && Array.isArray(o.lines) && o.lines.length ? o.lines
      : pv && Array.isArray(pv.lines) && pv.lines.length ? pv.lines : [];
    ls = ls.slice(0, 50);
    var used = [], out = [];
    (recs || []).forEach(function (r) {
      if (!r) return;
      var at = nm(r.atText), office = nm(r.office), entry = nm(r.entryOffice);
      if (at === null || office === null || typeof r.amount !== 'number' || !isFinite(r.amount)) return;
      for (var i = 0; i < ls.length; i++) {
        var x = ob(ls[i]);
        if (!x || used[i] || pdfOk(x.pdf, who)) continue;
        if (nm(x.at) !== at || !sameOffice(nm(x.office), office) || typeof x.amount !== 'number' || x.amount !== r.amount) continue;
        var xe = nm(x.entry);
        if (xe && entry && xe !== entry) continue;
        if (Object.keys(x).length + ('pdf' in x ? 0 : 1) + ('page' in x ? 0 : 1) > 12) continue;
        used[i] = true; out.push(r);
      }
    });
    return out;
  }
  /**
   * (2026-11-12 §8.1 — 점검 §2 「두 꼴을 같이 올리면 두 배」) 도로공사 PDF 는 「한국도로공사성남영업소」, 인쇄 PDF 는 「성남영업소」라
   * 영업소 글까지 같아야 하던 열쇠로는 같은 통과가 두 번 더해졌다 → 시각·금액·카드 끝 4자리로 묶고, 그 안에서
   *   · 영업소 글이 똑같으면(어느 파일이든) 겹침 · 다른 파일의 기록과 끝이 같으면(sameOffice) 겹침 — 먼저 나온 파일의 기록을 남긴다.
   *   · 짝은 하나씩 — 남긴 기록 하나는 다른 파일마다 기록 하나만 지운다(똑같은 글 먼저, 그다음 끝이 같고 길이 차이가 가장 작은 것).
   * 같은 파일 안에서 끝만 같은 두 기록(「성남영업소」·「서성남영업소」)은 읽을 때 따로 센 것이라 빼지 않는다.
   * recKey 는 그대로다(웹 원본 보관이 기록마다 든 파일을 찾는 열쇠).
   */
  function mergeFiles(lists) {
    var seen = new Map(), out = [], removed = 0;
    // 짝은 하나씩(2026-11-12 Task 3 검토 1): 앞 파일에서 남긴 기록 하나는 뒤 파일마다 기록 하나만 지운다(x.used[fi]).
    //   파일 하나씩 — ① 글이 똑같은 짝 먼저 ② 남은 것은 끝이 같은 짝을, 더 붙은 앞 글이 회사 이름인 짝 → 앞 글이 짧은 짝 차례로(파일 안 차례와 상관없이).
    //   어느 짝을 고르든 지우는 수는 같다 — 고르는 차례는 뒤 파일에 끝이 같은 기록이 여럿일 때 엉뚱한 이름끼리 묶지 않게 할 뿐이다.
    //   (예전엔 인쇄 「대전영업소」 하나가 도로공사 「…대전영업소」·「…남대전영업소」 둘을 다 지웠다 — 진짜 통과 하나가 사라짐)
    var keyOf = function (r) { return r.at + '|' + r.amount + '|' + (r.card4 || ''); };
    (lists || []).forEach(function (rs, fi) {
      var list = (rs || []).slice(), gone = [], pairs = [];
      list.forEach(function (r, i) {
        var o = r.office || '', had = seen.get(keyOf(r)) || [];
        for (var j = 0; j < had.length; j++) {
          if (had[j].office === o && !had[j].used[fi]) { had[j].used[fi] = true; gone[i] = true; return; }
        }
      });
      list.forEach(function (r, i) {
        if (gone[i]) return;
        var o = r.office || '';
        (seen.get(keyOf(r)) || []).forEach(function (x) {
          if (x.used[fi] || !sameOffice(x.office, o)) return;
          // 긴 쪽에서 짧은 쪽을 뗀 앞 글 — 회사 이름(「한국도로공사」·「서울고속도로」 …)이면 가까운 짝, 아니면(「남」·「서」 — 다른 영업소 이름의 앞) 먼 짝
          var lo = x.office.length >= o.length ? x.office : o, pre = lo.slice(0, lo.length - Math.min(x.office.length, o.length));
          pairs.push({ i: i, x: x, d: (/(공사|고속도로|도로|하이웨이|\))$/.test(pre) ? 0 : 1000) + pre.length });
        });
      });
      pairs.sort(function (a, b) { return a.d - b.d || a.i - b.i; }).forEach(function (p) {
        if (gone[p.i] || p.x.used[fi]) return;
        p.x.used[fi] = true; gone[p.i] = true;
      });
      var mine = [];
      list.forEach(function (r, i) {
        if (gone[i]) { removed++; return; }
        // 같은 파일 안에서 글까지 똑같으면 겹침(읽을 때 dedupe 가 이미 빼므로 보통 없다) · 끝만 같은 것은 따로 센 것이라 남긴다
        var k = keyOf(r), o = r.office || '';
        if (mine.some(function (x) { return x.k === k && x.office === o; })) { removed++; return; }
        mine.push({ k: k, office: o });
        var had = seen.get(k) || [];
        had.push({ office: o, used: {} }); seen.set(k, had); out.push(r);
      });
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return { recs: out, removed: removed };
  }

  // 같은 영수증이 두 번 잡히는 일이 없도록 (시각+금액+영업소)로 중복 제거
  function dedupe(recs) {
    var seen = new Set();
    recs = recs.filter(function (r) {
      if (r.amount == null || !r.at) return false;
      var k = r.at + '|' + r.amount + '|' + r.office;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    recs.sort(function (a, b) { return a.at - b.at; });
    return recs;
  }

  /** 칸 경계에 걸친 낱말 고치기(parseDirect, 2026-10-23) — 같은 줄(y)에서 글자 간격(왼쪽 끝끼리)이 12 안쪽으로 이어진 글자들은 한 낱말이다
   *  (이 서식의 한글 간격 ≈8.2 · 띄어쓰기 ≈10.8 · 영수증 사이 ≥25). 한 낱말이 두 칸(it.c)에 걸쳤는데 한쪽이 두 글자 이하면 그 글자들을
   *  다른 쪽(많은 쪽) 칸으로 옮긴다. 양쪽 다 세 글자 넘게 걸치면(두 영수증 글이 붙어 버린 줄) 예전처럼 경계에서 나눈 대로 둔다. */
  function stray(items) {
    var rows = new Map();
    items.forEach(function (it) {
      var k = Math.round(it.y * 2) / 2;
      if (!rows.has(k)) rows.set(k, []);
      rows.get(k).push(it);
    });
    rows.forEach(function (arr) {
      arr.sort(function (a, b) { return a.x - b.x; });
      var word = [];
      var fix = function () {
        var n = {};
        word.forEach(function (it) { n[it.c] = (n[it.c] || 0) + 1; });
        var ks = Object.keys(n);
        if (ks.length === 2) {
          var big = n[ks[0]] >= n[ks[1]] ? ks[0] : ks[1], small = big === ks[0] ? ks[1] : ks[0];
          if (n[small] <= 2) word.forEach(function (it) { it.c = +big; });
        }
        word = [];
      };
      arr.forEach(function (it, i) {
        if (i && it.x - arr[i - 1].x >= 12) fix();
        word.push(it);
      });
      fix();
    });
  }

  /** 한국도로공사 직접 PDF(CID 글자 + 글자마다 Tm/Tj, 4열 격자) */
  async function parseDirect(buf) {
    var u8 = new Uint8Array(buf), s = latin1(u8);

    /* 1) 모든 스트림 풀기 */
    var streams = [], re = /stream\r?\n/g, m;
    while ((m = re.exec(s))) {
      var st = m.index + m[0].length;
      var end = s.indexOf('endstream', st); if (end < 0) continue;
      var out = await inflate(u8.subarray(st, end));
      if (out) streams.push(latin1(out));
    }
    if (!streams.length) throw new Error('PDF 안을 읽지 못했어요. 하이패스에서 다운로드한 원본 파일인지 확인해 주세요.');

    /* 2) ToUnicode 표 */
    var cmap = new Map();
    streams.forEach(function (t) {
      (t.match(/beginbfchar([\s\S]*?)endbfchar/g) || []).forEach(function (blk) {
        var p, r2 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
        while ((p = r2.exec(blk))) {
          var d = '';
          for (var i = 0; i < p[2].length; i += 4) d += String.fromCharCode(parseInt(p[2].substr(i, 4), 16));
          cmap.set(parseInt(p[1], 16), d);
        }
      });
      (t.match(/beginbfrange([\s\S]*?)endbfrange/g) || []).forEach(function (blk) {
        var p, r3 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
        while ((p = r3.exec(blk))) {
          var a = parseInt(p[1], 16), b = parseInt(p[2], 16), c = parseInt(p[3], 16);
          for (var i = a; i <= b && i - a < 65536; i++) cmap.set(i, String.fromCharCode(c + (i - a)));
        }
      });
    });

    /* 3) 글자 + 좌표 */
    var pages = [];
    streams.forEach(function (t) {
      if (!/\bTj\b/.test(t)) return;
      var items = [], p, r4 = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm[\s\S]{0,400}?\((.*?)\)\s*Tj/g;
      while ((p = r4.exec(t))) {
        var by = unesc(p[3]), txt = '';
        for (var i = 0; i + 1 < by.length; i += 2) txt += cmap.get((by[i] << 8) | by[i + 1]) || '';
        items.push({ x: parseFloat(p[1]), y: parseFloat(p[2]), t: txt });
      }
      if (items.length) pages.push(items);
    });
    if (!pages.length) throw new Error('영수증 글자를 찾지 못했어요.');

    /* 4) 4열 격자로 나눠 영수증 블록마다 필드 뽑기
     *    열 글자폭(≈117)이 열 간격(≈144)보다 좁다 → round 를 쓰면 0열 끝 글자가 1열로 넘어간다.
     *    floor + 여유값이 맞다.
     *    다만 가운데 맞춘 긴 글줄(「서울북부고속도로갈매동구릉영업소」 16자)은 경계보다 왼쪽에서 시작해 첫 글자가 왼쪽 칸으로 넘어갔다
     *    (「서울고속도로불암산영업소서」 · 「울북부고속도로갈매동구릉영업소」, 2026-10-23 출력 감사) — 경계에 걸친 낱말은
     *    stray() 가 한두 글자만 넘어간 쪽을 낱말 쪽 칸으로 되돌린다. */
    var NCOL = 4, recs = [];
    pages.forEach(function (items, pi) {
      var xs = items.map(function (i) { return i.x; });
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
      var pitch = (maxX - minX) / (NCOL - 1 + 0.81);
      var cols = {};
      items.forEach(function (it) {
        it.c = Math.min(NCOL - 1, Math.max(0, Math.floor((it.x - minX + 6) / pitch)));
      });
      stray(items);
      items.forEach(function (it) { (cols[it.c] = cols[it.c] || []).push(it); });
      Object.keys(cols).forEach(function (c) {
        var arr = cols[c], lines = new Map();
        arr.forEach(function (it) {
          var k = Math.round(it.y * 2) / 2;
          if (!lines.has(k)) lines.set(k, []);
          lines.get(k).push(it);
        });
        var ys = Array.from(lines.keys()).sort(function (a, b) { return b - a; });
        var text = ys.map(function (y) {
          return { y: y, t: lines.get(y).sort(function (a, b) { return a.x - b.x; })
                          .map(function (i) { return i.t; }).join('') };
        });
        var starts = text.filter(function (l) { return l.t.replace(/\s/g, '') === '영수증'; })
                         .map(function (l) { return l.y; });
        starts.forEach(function (top, i) {
          var bot = i + 1 < starts.length ? starts[i + 1] : -1e9;
          var blk = text.filter(function (l) { return l.y <= top && l.y > bot; })
                        .map(function (l) { return l.t; });
          var j = blk.join('\n');
          var dt = j.match(/(\d{4})년(\d{2})월(\d{2})일(\d{2})시(\d{2})분/);
          if (!dt) return;
          var fee = j.match(/(\d)종([\d,]+)원/);
          var card = j.match(/\d{4}-\d{2}\*\*-\*\*\*\*-(\d{4})/);
          var entry = j.match(/입구영업소:(\S+)/);
          recs.push({
            page: pi + 1,
            at: Date.parse(dt[1] + '-' + dt[2] + '-' + dt[3] + 'T' + dt[4] + ':' + dt[5] + ':00+09:00'),
            atText: dt[1] + '-' + dt[2] + '-' + dt[3] + ' ' + dt[4] + ':' + dt[5],
            office: (blk[1] || '').trim(),
            entryOffice: entry ? entry[1] : null,
            carClass: fee ? +fee[1] : null,
            amount: fee ? +fee[2].replace(/,/g, '') : null,
            card4: card ? card[1] : null
          });
        });
      });
    });

    return dedupe(recs);
  }

  /**
   * 영수증을 운행에 맞춘다.
   *  · 통과시각이 운행의 [출발, 도착] 안에 들어가면 그 운행의 통행료다.
   *  · 한 운행에 여러 번 지나갔으면 합산한다.
   *  · 카드 뒷4자리로 차량을 고를 수 없으니, 어느 차량이 가장 많이 맞는지 투표로 추정한다.
   *  · (2026-11-12 §8.3) 시작 쪽만 조금 넓힌다 — inTrip 「넓힌 창」. 도착 쪽은 그대로.
   *  · (2026-11-12 §8.7) 투표 1·2등이 같으면 차량을 정하지 않는다(plate null · tie true) — 예전엔 목록 차례로 남의 차가 뽑혔다.
   *    opts.ownerPlates(올린 사람의 차량들)에 든 차량이 동점 후보 중 하나뿐이면 그 차량(tie false).
   *    투표는 기록 하나가 한 차량에 한 표(같은 차량의 두 운행 창에 다 들어도 한 표).
   */
  function match(recs, trips, opts) {
    var byCard = {}, own = (opts && opts.ownerPlates) || [];
    recs.forEach(function (r) { (byCard[r.card4 || '?'] = byCard[r.card4 || '?'] || []).push(r); });

    var groups = Object.keys(byCard).map(function (c4) {
      var rs = byCard[c4], vote = {};
      rs.forEach(function (r) {
        // 넓히기 전 규칙으로 든 차량이 있으면 그 차량들만 표를 받는다(2026-11-12 Task 3 검토 3 — assign 의 「넓히기 전 규칙이 이김」과 같게).
        //   예전엔 P 운행 한가운데의 기록이 Q 운행의 넓힌 시작 창에도 들어 Q 에도 표가 갔다.
        //   (2026-11-12 §8.5-1) 표는 범위 운행(도착 > 출발)만 준다 — 0분 수기 운행의 자리 시각은 실제 시각이 아니다.
        var got = {}, strict = {}, anyStrict = false;
        trips.forEach(function (t) { if (isRange(t) && inTrip(t, r.at, false)) { strict[t.plate_no] = true; anyStrict = true; } });
        trips.forEach(function (t) {
          if (!isRange(t) || got[t.plate_no] || !(anyStrict ? strict[t.plate_no] : inTrip(t, r.at, true))) return;
          got[t.plate_no] = true;
          vote[t.plate_no] = (vote[t.plate_no] || 0) + 1;
        });
      });
      var pv = pickPlate(vote, own), mvote = {};
      if (!pv.ranked.length) {
        // (2026-11-12 §8.5-5) 범위 운행 표가 하나도 없으면 — 그 줄들의 날짜(KST)에 0분 수기 운행이 가장 많은 차량. 동점·없으면 비워 둔다(8.7 과 같은 원칙).
        var days = {};
        rs.forEach(function (r) { days[kstDay(r.at)] = true; });
        trips.forEach(function (t) {
          if (isZero(t) && t.plate_no && days[kstDay(Number(t.start_time))]) mvote[t.plate_no] = (mvote[t.plate_no] || 0) + 1;
        });
        pv = pickPlate(mvote, own);
      }
      return {
        card4: c4, records: rs,
        plate: pv.plate, tie: pv.tie,
        vote: Object.keys(vote).sort(function (a, b) { return vote[b] - vote[a]; }).map(function (p) { return { plate: p, n: vote[p] }; }),
        // 수기 운행 수로 차량을 정했을 때만 — 차량 고르기 칸 「(수기 n건)」
        manualVote: Object.keys(vote).length ? [] : pv.ranked.map(function (p) { return { plate: p, n: mvote[p] }; }),
        candidates: Array.from(new Set(trips.map(function (t) { return t.plate_no; }))).filter(Boolean).sort()
      };
    });

    // opts.ev = 받아 둔 운행 근거 { 운행 id: toll_evidence_json } — 이미 붙은 줄 찾기(assign ⓪, 검토 M1). 없으면 null(모름)
    //   근거 줄 하나는 기록 하나만 차지한다 — 카드 묶음 모두에 걸쳐 한 번에 정한다(claimsOf · g.held 를 묶음들이 함께 쓴다).
    var ev = (opts && opts.ev) || null, plateOfRec = new Map();
    groups.forEach(function (g) { g.records.forEach(function (r) { plateOfRec.set(r, g.plate || null); }); });
    var held = claimsOf(recs, trips, ev, function (r) { return plateOfRec.get(r) || null; });
    groups.forEach(function (g) { g.ev = ev; g.held = held; assign(g, trips); });
    return groups;
  }

  /** 표 { 차량: 수 } → 1등 차량. 1·2등이 같으면 올린 사람 차량(own)이 동점 후보 중 하나뿐일 때만 그 차량, 아니면 null · tie(§8.7). */
  function pickPlate(vote, own) {
    var ranked = Object.keys(vote).sort(function (a, b) { return vote[b] - vote[a]; });
    var plate = ranked[0] || null, tie = false;
    if (ranked.length > 1 && vote[ranked[0]] === vote[ranked[1]]) {
      var top = ranked.filter(function (p) { return vote[p] === vote[ranked[0]]; });
      var mine = top.filter(function (p) { return own.indexOf(p) >= 0; });
      if (mine.length === 1) plate = mine[0];
      else { plate = null; tie = true; }
    }
    return { plate: plate, tie: tie, ranked: ranked };
  }

  /* ── 수기 운행 「빈 시간」(2026-11-12 §8.5 · U7 사용자 확정) ──
   *  수기 운행에는 실제 시각이 없다 — 앱이 「○○ 운행 다음」 자리를 시각으로 넣는다(앞 운행 끝 + 1분 / 맨 앞은 다음 운행 시작 − 1분 / 빈 날 00:05)
   *  그래서 시각이 아니라 차례로 맞춘다. 범위 운행 = 도착 > 출발(자동 기록 · 고쳐서 수기가 됐어도 길이가 남은 운행) · 0분 운행 = 출발 = 도착.
   *  도착이 없는 운행(아직 끝나지 않음·깨진 기록)은 어느 쪽도 아니고, 빈 시간의 경계로만 쓴다(그 출발 시각에서 끊는다). */
  var DAY = 86400000, KST_MS = 9 * 3600000, BEFORE_MAX = 30;   // 「운행 시작 n분 전」은 다음 범위 운행이 30분 안에 시작할 때만
  function num(v) { return v == null || v === '' ? NaN : Number(v); }
  function isRange(t) { var s = num(t && t.start_time), e = num(t && t.end_time); return isFinite(s) && isFinite(e) && e > s; }
  function isZero(t) { var s = num(t && t.start_time), e = num(t && t.end_time); return isFinite(s) && isFinite(e) && e === s; }
  function kstDay(ms) { return Math.floor((Number(ms) + KST_MS) / DAY); }

  /**
   * 범위 운행에 못 맞춘 기록 r 의 그날 「빈 시간」과 그 안의 0분 운행(차례 순).
   *   빈 시간 = [r 바로 앞에 끝난 범위 운행의 도착, r 바로 뒤에 시작하는 범위 운행의 출발] — 없으면 그날(KST) 0시 · 다음 날 0시.
   *   돌려주는 것: { options: 0분 운행[], day: 그날 이 차량 운행이 있나, next: 바로 뒤 범위 운행(그날) | null }
   */
  function gapOf(r, mine) {
    var d = kstDay(r.at), d0 = d * DAY - KST_MS, d1 = d0 + DAY, lo = d0, hi = d1, next = null, any = false;
    mine.forEach(function (t) {
      var s = num(t.start_time), e = num(t.end_time);
      if (!isFinite(s)) return;
      if (isRange(t)) {
        if (s < d1 && e >= d0) any = true;                  // 그날에 걸친 범위 운행(자정 넘긴 것 포함)
        if (e < r.at && e > lo) lo = e;
        if (s > r.at && s < hi) { hi = s; next = t; }
      } else if (isZero(t)) {
        if (kstDay(s) === d) any = true;
      } else {
        if (kstDay(s) === d) any = true;                    // 도착 없는 운행 — 출발 시각에서 끊는다
        if (s <= r.at && s > lo) lo = s;
        if (s > r.at && s < hi) { hi = s; next = null; }
      }
    });
    var options = mine.filter(function (t) {
      var s = num(t.start_time);
      return isZero(t) && kstDay(s) === d && s >= lo && s <= hi;
    }).sort(function (a, b) { return num(a.start_time) - num(b.start_time) || (a.id > b.id ? 1 : a.id < b.id ? -1 : 0); });
    return { options: options, day: any, next: next };
  }

  /**
   * 통과 시각 at 이 운행 t 안인가. 넓히기 전 규칙 = [출발, 도착](도착이 있어야 한다).
   * wide(2026-11-12 §8.3 · 점검 §6-5) = [출발을 분 단위로 내린 값 − 5분, 도착] — 통과 시각은 분까지만 적혀 같은 분의 통과가 빠졌고
   *   앱이 몇 분 늦게 켜진 운행도 있었다. 도착 쪽은 넓히지 않는다(넓히면 틀린 짝이 생긴다).
   *   길이가 없는 운행(출발 = 도착 — 시각 없는 0분 수기 운행)은 넓히지 않는다: 그 시각은 앱이 채운 자리 시각이라 실제 시각이 아니다(§8.5 는 차례로 맞춘다).
   */
  function inTrip(t, at, wide) {
    if (!t || !t.end_time) return false;
    if (t.start_time <= at && at <= t.end_time) return true;
    if (!wide || !(t.end_time > t.start_time)) return false;
    return Math.floor(t.start_time / 60000) * 60000 - 300000 <= at && at <= t.end_time;
  }

  /** 기사가 앱에서 「확인」만 누른 기계 값인가(2026-11-12 §8.6 · 연구 F-10) — 명세서 금액과 다르면 명세서가 이긴다(기본 선택). */
  var CONFIRMED_MACHINE = ['기사 확인 · 경로 계산', '기사 확인 · 하이패스 기록'];
  function confirmedMachine(src) { return CONFIRMED_MACHINE.indexOf(String(src || '')) >= 0; }

  /** 사람이 직접 정한 통행료인가. 서버의 보호 트리거(old_by_person)와 같은 기준을 쓴다. */
  var PERSON_SOURCES = ['미입력', 'legacy-client-compat', '하이패스 영수증', '웹 직접 입력'];
  function bySource(src) {
    var s = String(src || '');
    if (!s) return 'none';
    if (s.indexOf('기사 ') === 0 || s.indexOf('사용자 입력') === 0) return 'person';
    if (PERSON_SOURCES.indexOf(s) >= 0) return 'person';
    // 앱이 설·추석 운행에 적는 '명절 통행료 면제'(FREE_CONFIRMED 0원)도 기계 계산이다 — 서버 보호 트리거 v5
    //   (20260902010000_protect_driver_toll_decision_v5.sql)의 기계 출처 목록과 같게(2026-10-20 AU5-L7)
    if (s === '자동계산 실패' || s === '영업소 요금표' || s === '요금소 미통과(실주행 GPS)' || s === '명절 통행료 면제') return 'machine';
    if (s.indexOf('카카오 길찾기') === 0) return 'machine';
    if (s.indexOf('회사 하이패스 기록') === 0) return 'machine';   // 회사 하이패스 기록으로 추정한 값(2026-11-12 §8.6 — 서버 채우기·앱 4.2.0)
    if (s === 'legacy migration') return 'person';   // 이관된 사람 입력값
    return 'unknown';
  }

  /* ── 이미 붙은 줄(2026-11-12 Task 8 검토 M1 — 「붙어 있는 운행이 이긴다」) ──
   *  수기 운행은 고르기로 붙으므로 다시 올리면(같은 명세서 · 기간이 겹치는 명세서 · 빈 시간에 수기 운행이 나중에 늘어남) 같은 통과가 다른 운행에 또 붙을 수 있었다.
   *  그래서 운행 근거(toll_evidence_json)에 이미 그 통과 줄이 있으면 그 운행(붙어 있는 운행)의 줄로 본다 — 빈 시간·범위 규칙보다 먼저.
   *  같은 통과 = mergeFiles 와 같은 열쇠: 통과 시각(at ↔ atText) · 금액 · 영업소(sameOffice) · 카드 끝 4자리(근거 note 「카드 1234 · …」가 있을 때만 견줌 — 줄에는 카드가 없다).
   *  줄은 근거 lines(비어 있지 않으면), 아니면 prev.lines(사람이 고친 뒤 — needPdf 와 같은 규칙). 근거 줄 하나는 기록 하나만 차지한다.
   *  ev = { 운행 id: toll_evidence_json } — 받아 둔 근거(driving-app.js HP.ej). 그 운행 id 가 없으면 「모름」.
   *  받아야 하는 근거(evNeed) = 기록 날짜(KST)에 걸친 운행 중 하이패스 금액이 있는 것(toll_hipass · 출처 「하이패스 영수증」 — 범위 운행도, 검토 M2) — 근거를 못 읽으면(모름)
   *  그날 기록은 어느 운행에도 미리 체크하지 않고(e.unsure · 줄의 unsure) 까닭을 보인다 — 이미 붙은 줄일 수 있는 것은 「붙이기」가 기본이면 안 된다.
   */
  function ejOf(v) {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  }
  function hasHp(t) { return !!t && ((t.toll_hipass != null && t.toll_hipass !== '') || t.toll_source === '하이패스 영수증'); }
  function evKnown(ev, t) { return !!ev && !!t && Object.prototype.hasOwnProperty.call(ev, String(t.id)); }
  /** 근거를 받아야 하는 운행 id — 기록 날짜(KST)에 걸친 운행 중 하이패스 금액이 있는 것(범위·0분 모두 · 차량은 가리지 않는다 — 검토 M2). */
  function evNeed(recs, trips) {
    var days = {}, out = [];
    (recs || []).forEach(function (r) { if (r && isFinite(r.at)) days[kstDay(r.at)] = true; });
    (trips || []).forEach(function (t) {
      if (hasHp(t) && tripDays(t).some(function (d) { return days[d]; }) && out.indexOf(t.id) < 0) out.push(t.id);
    });
    return out;
  }
  /** 운행이 걸친 날(KST) — 출발 날 · 도착 날(다르면). 범위 운행도 0분 운행도(검토 M2 — 붙어 있는 운행은 범위 운행일 수도 있다). */
  function tripDays(t) {
    var s = num(t && t.start_time), e = num(t && t.end_time), out = [];
    if (isFinite(s)) out.push(kstDay(s));
    if (isFinite(e) && out.indexOf(kstDay(e)) < 0) out.push(kstDay(e));
    return out;
  }
  /** 받아 둔 근거로 — 근거 줄 목록(운행마다 { trip, lines, card, used }) */
  function heldPool(trips, ev) {
    if (!ev) return [];
    return (trips || []).filter(function (t) { return evKnown(ev, t); }).map(function (t) {
      var o = ejOf(ev[String(t.id)]), cur = o && Array.isArray(o.lines) && o.lines.length ? o.lines : null;
      var pv = o && ejOf(o.prev), ls = cur || (pv && Array.isArray(pv.lines) ? pv.lines : []);
      var cm = cur && typeof o.note === 'string' ? o.note.match(/카드 (\d{4})/) : null;
      return { trip: t, lines: ls.slice(0, 50), card: cm ? cm[1] : null, used: [] };
    }).filter(function (h) { return h.lines.length; })
      .sort(function (a, b) { return num(a.trip.start_time) - num(b.trip.start_time); });
  }
  /** 기록 r 이 이미 붙어 있는 운행(없으면 null). 찾으면 그 근거 줄을 차지한다. */
  /** 기록들 → Map(기록 → 붙어 있는 운행). 시각 차례로 근거 줄을 하나씩 차지한다(같은 꼴 기록이 둘이면 하나만). */
  //   plateOf(r) = 그 기록 카드 묶음에 정해진 차량(없으면 null) — 근거 note 에 카드가 없는 줄은 차량이 같아야 차지한다(holderOf, 검토 3b·4).
  //   돌려주는 Map 의 .doubt = 차량이 달라 차지하지 않았지만 다른 차 운행에 같은 통과 줄이 있는 기록(Set) — 붙여도 미리 체크하지 않는다(unsure, 검토 4 M3).
  function claimsOf(recs, trips, ev, plateOf) {
    var pool = heldPool(trips, ev), out = new Map();
    out.doubt = new Set();
    if (!pool.length) return out;
    (recs || []).slice().sort(function (a, b) { return a.at - b.at; }).forEach(function (r) {
      var info = { doubt: false };
      var h = holderOf(r, pool, r.card4 || null, plateOf ? plateOf(r) : null, info);
      if (h) out.set(r, h);
      else if (info.doubt) out.doubt.add(r);
    });
    return out;
  }
  /** 차량 번호 견주기(검토 4 — 이 견줌에만): 빈칸을 모두 뺀 글. 투표·차량 거르기는 그대로다. */
  function plateKey(p) { return String(p == null ? '' : p).replace(/\s+/g, ''); }
  //   영업소는 글이 똑같은 줄을 먼저 찾고, 없을 때만 끝이 같은 줄(검토 L4 — mergeFiles 와 같은 차례: 「성남영업소」 기록이 「서성남영업소」 줄을 먼저 차지하지 않게)
  //   (검토 3b·4) 근거 note 에 카드가 없으면 카드로 가릴 수 없다 — 그 기록 묶음의 차량(plate)이 정해져 있으면 붙어 있는 운행의 차량과 같을 때만(빈칸 빼고 견줌) 차지한다
  //   (같은 분·같은 금액·같은 영업소를 두 차가 함께 지남 — 관리자 「전체」 화면). 차량이 다르면 차지하지 않고(그 줄은 맞는 차의 기록 몫으로 남긴다)
  //   info.doubt 를 세운다 — 그 기록은 보통 규칙으로 가되 미리 체크하지 않는다(투표가 틀렸거나 운행이 다른 차로 적혔으면 같은 통과를 두 번 낼 수 있다, 검토 4 M3).
  //   차량이 안 정해졌으면(동점) 예전처럼 차지한다. note 에 카드가 있으면 카드가 정한다.
  function holderOf(r, pool, card4, plate, info) {
    var ro = String(r.office || '');
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < pool.length; i++) {
        var h = pool[i];
        if (h.card && card4 && card4 !== '?' && h.card !== card4) continue;
        var other = !h.card && !!plate && plateKey(h.trip.plate_no) !== plateKey(plate);
        for (var j = 0; j < h.lines.length; j++) {
          var l = h.lines[j];
          if (!l || typeof l !== 'object') continue;
          if (String(l.at == null ? '' : l.at).trim() !== String(r.atText || '').trim()) continue;
          if (typeof l.amount !== 'number' || l.amount !== r.amount) continue;
          var lo = String(l.office == null ? '' : l.office);
          if (pass === 0 ? lo !== ro : !sameOffice(lo, ro)) continue;
          // 다른 차 운행의 같은 통과 줄 — 맞는 차 기록이 이미 차지했어도 이 기록은 미리 체크하지 않는다(어느 차례로 와도 같게)
          if (other) { if (info) info.doubt = true; continue; }
          if (h.used[j]) continue;
          h.used[j] = true;
          return h.trip;
        }
      }
    }
    return null;
  }

  /**
   * 그룹의 차량이 정해진 상태에서 실제 배분을 계산한다(차량을 바꾸면 다시 부른다).
   *  ⓪ (2026-11-12 검토 M1) 이미 운행 근거에 있는 줄은 그 운행(붙어 있는 운행이 이긴다 — 범위·빈 시간 규칙보다 먼저 · 차량 고르기 전에도) — heldPool·holderOf.
   *     ev = 받아 둔 근거(없으면 g.ev). 근거를 모르는 하이패스 운행이 그날 있으면 그 기록은 미리 체크하지 않는다(unsure).
   *  ① 범위 운행(도착 > 출발)에 [출발, 도착] → 넓힌 창(§8.3) 차례로 — 두 운행에 다 들면 넓히기 전 규칙이 이긴다.
   *  ② (2026-11-12 §8.5) 남은 기록마다 그날 그 차량의 「빈 시간」(gapOf) 안 0분 운행 —
   *     하나면 그 운행 · 둘 이상이면 직원이 고른다(g.manualPick 에 고른 운행이 있고 아직 후보면 그 운행, 아니면 「수기 운행이 여러 개예요」) ·
   *     없으면 까닭(r.why: no_trip_day 그날 운행 없음 · before_start 다음 운행 시작 r.min 분 전 · no_trip_time 그 시각에 운행 없음).
   *     수기에 붙인 줄은 운행마다 묶어 g.matched 에 e.manual = true 로 넣는다(확정·고르기·잠금은 범위 운행과 같은 길) ·
   *     미리 체크는 아래 kind 규칙 그대로. 다만 수기 운행에 이미 있는 금액이 기계 출처가 아니면(사람이 넣었거나 출처를 모름) 다르면 diff-person(체크 안 함).
   *  g.manual = 수기 줄마다 { rec, trip(고르기 전이면 null), options(빈 시간 안 0분 운행들 · 붙어 있으면 그 운행 하나), kind, pick,
   *             why('manual_many' — 고르기 전), held(이미 붙어 있음), unsure(근거를 못 읽음), e(그 운행 묶음) }.
   *  g.unmatched = 어느 운행에도 안 붙고 고를 것도 없는 기록 — 기록마다 why(·min). 고르기를 기다리는 줄(manual_many)은 g.manual 에만 있다(검토 L3).
   */
  function assign(g, trips, ev) {
    // ev 를 주면 그 근거로 이 묶음의 붙은 줄을 새로 정한다 · 안 주면 지난번 것(g.ev · g.held — match 가 묶음들에 함께 정해 둔 것)
    if (ev !== undefined) { g.ev = ev || null; g.held = null; }
    ev = g.ev || null;
    var held = g.held instanceof Map ? g.held : (g.held = claimsOf(g.records, trips, ev, function () { return g.plate || null; }));
    // 다른 차 운행에 같은 통과 줄이 있어 차지하지 않은 기록(검토 4 M3) — 보통 규칙으로 가되 미리 체크하지 않는다
    var doubtRec = held.doubt instanceof Set ? held.doubt : new Set();
    var mine = g.plate ? trips.filter(function (t) { return t.plate_no === g.plate; }) : [];
    var range = mine.filter(isRange);
    var per = new Map(), unmatched = [], rows = [];
    var chosen = g.manualPick instanceof Map ? g.manualPick : (g.manualPick = new Map());
    // 근거를 모르는 하이패스 운행이 걸친 날(KST) — 그날 기록은 미리 체크하지 않는다
    var doubtDay = {};
    //   (검토 M2) 0분 운행만이 아니라 하이패스 금액이 있는 모든 운행 — evNeed 와 같은 무리(범위 운행이 시각을 고쳐 그 줄을 안 덮어도 그 운행이 가진 줄일 수 있다)
    trips.forEach(function (t) { if (hasHp(t) && !evKnown(ev, t)) tripDays(t).forEach(function (d) { doubtDay[d] = true; }); });
    var add = function (trip, r, manual) {
      if (!per.has(trip.id)) per.set(trip.id, { trip: trip, lines: [], sum: 0, manual: !!manual, unsure: false });
      var e = per.get(trip.id);
      e.lines.push(r); e.sum += r.amount;
      if (doubtDay[kstDay(r.at)] || doubtRec.has(r)) e.unsure = true;
      return e;
    };
    g.records.forEach(function (r) {
      var hit = null, i;
      delete r.why; delete r.min;
      var hold = held.get(r) || null;
      if (hold) {
        if (isZero(hold)) rows.push({ rec: r, trip: hold, options: [hold], held: true });
        else add(hold, r, false);
        return;
      }
      for (i = 0; i < range.length && !hit; i++) if (inTrip(range[i], r.at, false)) hit = range[i];
      for (i = 0; i < range.length && !hit; i++) if (inTrip(range[i], r.at, true)) hit = range[i];
      if (hit) { add(hit, r, false); return; }
      if (!g.plate) { unmatched.push(r); return; }      // 차량을 고르기 전(예전 「차량을 골라 주세요」)
      var gp = gapOf(r, mine), opts = gp.options, pickT = null;
      if (opts.length === 1) pickT = opts[0];
      else if (opts.length > 1) {
        var want = chosen.get(r);
        pickT = opts.filter(function (t) { return want != null && String(t.id) === String(want); })[0] || null;
      }
      if (pickT) { rows.push({ rec: r, trip: pickT, options: opts }); return; }
      if (opts.length > 1) {
        r.why = 'manual_many';
        rows.push({ rec: r, trip: null, options: opts });
        return;                                          // 고르기를 기다리는 줄 — 안 맞는 줄 목록에 넣지 않는다(검토 L3)
      }
      if (!gp.day) r.why = 'no_trip_day';
      else if (gp.next && num(gp.next.start_time) - r.at <= BEFORE_MAX * 60000) {
        r.why = 'before_start'; r.min = Math.max(1, Math.ceil((num(gp.next.start_time) - r.at) / 60000));
      } else r.why = 'no_trip_time';
      unmatched.push(r);
    });
    // 수기 줄은 운행마다 묶는다 — 한 빈 시간에 통과가 여럿이면 한 운행의 통행료로 더한다(범위 운행과 같다)
    rows.forEach(function (x) { if (x.trip) x.e = add(x.trip, x.rec, true); });
    rows.forEach(function (x) { x.unsure = !!doubtDay[kstDay(x.rec.at)] || doubtRec.has(x.rec); });

    g.matched = Array.from(per.values()).map(function (e) {
      var cur = e.trip.toll_cost;
      var st = e.trip.toll_status;
      var unset = st === 'UNKNOWN' || st === 'PENDING' || cur == null;
      // 「기사 확인 · 경로 계산」·「기사 확인 · 하이패스 기록」은 기사가 확인만 누른 기계 값이다(§8.6) — 사람 값으로 보지 않는다
      //   (금액이 다르면 기본 선택 · 화면도 「자동」). bySource 자체는 그대로(운행 표 「확정」 표시·이력 권하기 기준).
      var who = confirmedMachine(e.trip.toll_source) ? 'machine' : bySource(e.trip.toll_source);

      if (unset) {
        e.kind = 'new';                 // 미확정 → 확정. 잃을 게 없다.
        e.diff = null; e.pick = true;
      } else if (Number(cur) === e.sum && e.trip.toll_source === '하이패스 영수증') {
        e.kind = 'same';                // 이미 하이패스로 맞춘 값이다. 다시 쓸 필요가 없다.
        e.diff = 0; e.pick = false;
      } else if (e.trip.toll_hipass != null && e.trip.toll_hipass !== '' && Number(e.trip.toll_hipass) === e.sum) {
        // 이 금액으로 이미 하이패스 대조를 했고, 그 뒤 사람이 운행 통행료를 고쳤다(예: 하이패스 1,100 + 따로 낸 영수증 2,100 → 3,200).
        //   하이패스 몫은 따로 남아 있어(toll_hipass, 2026-10-17) 다시 확정하면 고친 금액만 1,100 으로 되돌린다 — 손대지 않는다.
        e.kind = 'same';
        e.diff = 0; e.pick = false;
      } else if (Number(cur) === e.sum) {
        // ★ 금액은 같지만 아직 '하이패스 영수증'으로 확정되지 않았다(직접 입력·자동 계산).
        //   확정해 두어야 검증 R06(영수증 없는 직접 입력 통행료)이 풀린다(2026-10-07 검증로봇 R12 —
        //   "다 확정됐습니다"라고 하는데 R06 은 "0 입력"을 권해 맞는 통행료를 지우게 될 수 있었다).
        e.kind = 'confirm';
        e.diff = 0; e.pick = true;
      } else if (who === 'person' || (e.manual && who !== 'machine')) {
        // ★ 사람이 직접 정한 값이다. 영수증이 더 정확하더라도 **기본으로 덮지 않는다** —
        //   관리자가 눈으로 보고 직접 고르게 한다.
        //   수기 운행(§8.5-4)은 출처를 모르는 금액도 사람이 넣은 것으로 본다 — 하이패스에 현금 몫을 더해 넣어 둔 금액이 사라지지 않게.
        e.kind = 'diff-person';
        e.diff = e.sum - Number(cur); e.pick = false;
        if (e.manual) who = 'person';
      } else {
        e.kind = 'diff';                // 자동계산과 다르다. 영수증이 실제 청구액이므로 기본 선택.
        e.diff = e.sum - Number(cur); e.pick = true;
      }
      e.who = who;
      // 그날 근거를 못 읽은 하이패스 0분 운행이 있다 — 이 줄이 거기 이미 붙어 있을 수 있으니 미리 체크하지 않는다(검토 M1)
      if (e.unsure) e.pick = false;
      // (전체 검토 W2-2 · money M5) 수기 운행에 맞춘 기록은 그 운행에 이미 같은 금액이 있을 때(confirm)만 미리 체크한다 — 시각을 확인할 수 없는 맞춤이라
      //   통행료가 비었거나(new) 금액이 다르면(diff) 사람이 고른다(하루에 수기 운행 하나뿐이면 그날 출퇴근 통과까지 모두 그 운행에 모인다). 범위 운행은 그대로.
      if (e.manual && e.kind !== 'confirm') e.pick = false;
      return e;
    }).sort(function (a, b) { return a.trip.start_time - b.trip.start_time; });
    g.manual = rows.map(function (x) {
      return { rec: x.rec, trip: x.trip, options: x.options, kind: x.e ? x.e.kind : null, pick: x.e ? x.e.pick : false,
        why: x.trip ? null : 'manual_many', held: !!x.held, unsure: !!x.unsure, e: x.e || null };
    });
    g.unmatched = unmatched;
    return g;
  }

  /** 「수기 운행이 여러 개예요」 줄에 직원이 고른 운행(trip id · null 이면 고르기 취소)을 남기고 다시 맞춘다. */
  function chooseManual(g, rec, tripId, trips) {
    if (!(g.manualPick instanceof Map)) g.manualPick = new Map();
    if (tripId == null || tripId === '') g.manualPick.delete(rec); else g.manualPick.set(rec, tripId);
    return assign(g, trips);
  }

  /**
   * 확정(toll-apply items[].lines)에 보낼 줄 하나 — 입구 영업소·차종도 보낸다(서버 근거 lines 에 남아 통행료 추정 개선에 쓴다, 2026-10-17).
   * 수기 운행에 붙인 줄(빈 시간, §8.5-7)이면 "manual": true — 출력 「수」 표시 · 배우는 재료에서 빼는 표시(서버 clipLines 는 참거짓을 그대로 남긴다).
   */
  function lineOf(r, manual) {
    var o = { at: r.atText, office: r.office, entry: r.entryOffice || null, cls: r.carClass || null, amount: r.amount, page: r.page };
    if (manual) o.manual = true;
    return o;
  }

  /** 안 맞는 줄의 까닭 글(§8.4) — r.why · r.min. 모르는 값이면 빈 글. */
  var WHY_TEXT = { no_trip_day: '그날 운행 기록 없음', no_trip_time: '그 시각에 운행 기록 없음', manual_many: '수기 운행이 여러 개예요. 골라 주세요.' };
  function whyText(r) {
    if (!r || !r.why) return '';
    if (r.why === 'before_start') return '다음 운행 ' + (r.min || 1) + '분 전에 지남';   // (전체 검토 W2-4) 그 통과가 다음 운행 시작보다 n분 앞
    return WHY_TEXT[r.why] || '';
  }

  global.Hipass = { parsePdf: parsePdf, match: match, assign: assign, bySource: bySource, confirmedMachine: confirmedMachine, mergeFiles: mergeFiles, recKey: recKey, keepPath: keepPath, needPdf: needPdf, pdfOk: pdfOk,
    chooseManual: chooseManual, whyText: whyText, lineOf: lineOf, isRange: isRange, isZero: isZero, evNeed: evNeed };
})(window);
