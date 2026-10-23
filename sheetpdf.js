/* ═══════════════════════════════════════════════════════════════════════
 *  sheetpdf.js — 운행기록부 · 검증 결과 · 영수증을 A4 PDF 한 권으로 만든다
 *
 *  왜 브라우저 인쇄에 맡기지 않나
 *    쪽 나눔과 칸 폭을 브라우저가 정하면 "어디서 잘리는지"를 우리가 보장할 수 없다.
 *    여기서는 행 높이를 직접 재서 쪽을 나누고, 글자가 칸보다 넓으면 줄을 바꾸거나
 *    글자를 줄인다. 그래도 넘치는 글자가 있으면 issues 로 보고한다(0 이어야 정상).
 *
 *  양식은 앱 ExcelExporter(= xlsx.js) 와 같은 13칸이다. 값은 호출하는 쪽이
 *  sheetDataFor() 로 만든 모델을 그대로 받는다 — 금액 규칙을 여기서 다시 짜지 않는다.
 *  (행별 운행거리·유류비·합계만 엑셀 수식과 같은 식으로 계산한다: I=H−G, J=MAX(0,I)×단가, M=J+K+L)
 *
 *  브라우저·Node 양쪽에서 돈다(Node 는 검증용).
 *    SheetPdf.build(doc, deps) → Promise<{ bytes, pages, issues, stats }>
 *    deps = { PDFLib, fontkit, fontRegular, fontBold, loadImage(path) → Promise<Uint8Array|null> }
 * ═══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SheetPdf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MM = 72 / 25.4;                       // 1mm = 2.8346pt
  var PW = 595.28, PH = 841.89;             // A4 세로
  var MX = 10 * MM, MT = 11 * MM;           // 좌우·위 여백
  var MB = 14 * MM;                         // 아래 여백(쪽 번호 줄 포함)
  var CW = PW - 2 * MX;                     // 본문 폭 190mm
  var LIMIT = PH - MB;                      // 본문이 내려갈 수 있는 끝(위에서부터 잰 y)
  var BW = 0.4;                             // 괘선 두께
  var LH = 1.3;                             // 줄 간격

  /** 운행기록부 13칸 폭(mm). driving-v2.html 인쇄 CSS 와 같은 비율 — 합 189.5 를 190 에 맞춘다. */
  var COLS_MM = [17.5, 23.5, 23.5, 18, 13.5, 8.5, 12.5, 12.5, 12, 12.5, 11, 11, 13.5];
  var COLS = (function () {
    var sum = COLS_MM.reduce(function (a, b) { return a + b; }, 0);
    return COLS_MM.map(function (w) { return w / sum * CW; });
  })();
  var HEAD = ['운행일자', '출발지역', '도착지역', '방문처', '업무\n구분', '입력\n구분',
    '출발시\n키로수', '도착시\n키로수', '운행거리\n(km)', '유류비', '주차비', '통행료', '금액합계'];
  // 결재란 칸 이름 — 문서 모델(sh.boxLabels · d.boxLabels)이 결재 건의 칸 모양에 따라 넘긴다(driving-app.js boxLabels, 2026-10-14).
  //   v2(새 상신) 담당·센터·파트장·팀장·사업부장·대표이사 · v1(예전 건) 담당·팀장·실장·사업부장·대표이사. 안 넘기면 v2.
  var BOXES_V1 = ['담당', '팀장', '실장', '사업부장', '대표이사'];
  var BOXES = ['담당', '센터·파트장', '팀장', '사업부장', '대표이사'];
  var CATS = ['계기판', '주유', '주차', '통행료'];

  function n0(n) {
    if (n == null || !isFinite(Number(n))) return '';
    var v = Math.round(Number(n)), neg = v < 0;
    var s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + s;
  }
  function won(n) { return '₩' + n0(n); }
  /** 기본지급액 — 사내 양식 수식(ExcelExporter.kt 291행 · driving-app.js basePay 와 같다). */
  function basePay(km) {
    if (km <= 499) return 0;
    if (km <= 999) return 70000;
    if (km <= 1499) return 90000;
    if (km <= 1999) return 110000;
    if (km <= 2499) return 130000;
    return 150000;
  }

  // ─────────────────────────── 그리기 도구 ───────────────────────────
  function Ctx(pdf, lib, fR, fB, doc) {
    this.pdf = pdf; this.lib = lib; this.fR = fR; this.fB = fB; this.doc = doc;
    this.page = null; this.y = MT; this.issues = [];
    // 뒤에서 정해지는 글(부록 쪽 번호 — 「원본 장 부록 12쪽 3번째」)을 담을 칸. 칸만 먼저 그리고 글은 fillLater 가 맨 끝에 쓴다(2026-10-23).
    this.later = [];
    this.pw = PW; this.ph = PH; this.limit = LIMIT;          // 쪽 크기 — 가로 문서(법인카드)는 geo() 로 바꾼다(2026-10-09)
    this.stats = { cells: 0, shrunk: 0, wrapped: 0, minSize: 99, images: 0 };
    this.black = lib.rgb(0, 0, 0);
    this.cs = null;
    try {
      var set = fR.getCharacterSet();
      this.cs = Object.create(null);
      for (var i = 0; i < set.length; i++) this.cs[set[i]] = 1;
    } catch (e) { this.cs = null; }
    this.missing = Object.create(null);
  }
  Ctx.prototype.issue = function (kind, msg) {
    if (this.issues.length < 200) this.issues.push({ kind: kind, page: this.pdf.getPageCount(), msg: msg });
  };
  Ctx.prototype.gray = function (v) { return this.lib.rgb(v, v, v); };
  /** 쪽 크기를 바꾼다(가로 A4 = 841.89 × 595.28). 다음 newPage 부터, 그리고 좌표 뒤집기(ph)·쪽 끝(limit)에 바로 쓴다. */
  Ctx.prototype.geo = function (pw, ph, limit) { this.pw = pw; this.ph = ph; this.limit = limit; };
  Ctx.prototype.newPage = function () {
    this.page = this.pdf.addPage([this.pw, this.ph]);
    this.y = MT;
    return this.page;
  };
  /** 글자들이 전부 글꼴에 있는가. */
  Ctx.prototype.has = function (s) {
    var cs = this.cs;
    if (!cs) return true;
    for (var i = 0; i < s.length;) {
      var cp = s.codePointAt(i);
      if (!cs[cp]) return false;
      i += cp > 0xFFFF ? 2 : 1;
    }
    return true;
  };
  /** 글꼴에 없는 글자는 그리면 네모로 깨진다 — 같은 뜻의 흔한 글자로 풀어 보고, 안 되면 '?' 로 바꾸고 보고한다.
   *  제어문자·줄바꿈은 공백. */
  Ctx.prototype.clean = function (s) {
    s = s == null ? '' : String(s);
    if (!s) return '';
    // 풀어쓴 한글(맥·아이폰에서 붙여 넣은 글 — 자모가 따로 저장된다)은 먼저 모아 쓴다. 안 그러면 자모마다 '?' 가 된다.
    if (s.normalize) s = s.normalize('NFC');
    var out = '', cs = this.cs;
    for (var i = 0; i < s.length;) {
      var cp = s.codePointAt(i);
      var ch = String.fromCodePoint(cp);
      i += ch.length;
      if (cp === 0x09 || cp === 0x0A || cp === 0x0D || cp === 0xA0 || cp === 0x2028 || cp === 0x2029) { out += ' '; continue; }
      if (cp === 0xFFFE || cp === 0xFFFF) continue;     // 글자가 아닌 코드(엑셀 esc 와 같이 지운다)
      // 보이지 않는 글자는 그리지 않는다(제어문자 · BOM · 폭 없는 공백 · 붙여 넣기에 딸려 온 개체 자리표 U+FFFC/FFFD).
      if (cp < 0x20 || cp === 0x7F || cp === 0xFEFF || cp === 0xFFFC || cp === 0xFFFD || (cp >= 0x200B && cp <= 0x200F)) continue;
      if (cs && !cs[cp]) {
        // 나눔고딕에는 ㈜·①·㎞·전각 글자·− 가 없다. '?' 로 바꾸기 전에 풀어 쓴다
        // (㈜ → (주), ㎞ → km, Ａ → A, 전각 공백 → 공백, − → -). 화면·엑셀과 뜻이 같게 남는다.
        var alt = cp === 0x3000 ? ' ' : cp === 0x2212 ? '-' : (ch.normalize ? ch.normalize('NFKC') : ch);
        if (alt !== ch && alt && this.has(alt)) { out += alt; continue; }
        if (!this.missing[cp]) {
          this.missing[cp] = 1;
          this.issue('glyph', '글꼴에 없는 글자 U+' + cp.toString(16).toUpperCase() + ' → ? 로 바꿈');
        }
        out += '?';
        continue;
      }
      out += ch;
    }
    return out;
  };
  Ctx.prototype.font = function (bold) { return bold ? this.fB : this.fR; };
  Ctx.prototype.w = function (s, size, bold) { return this.font(bold).widthOfTextAtSize(s, size); };

  /** 낱말 단위로 접는다(한글은 어절을 지킨다). 한 낱말이 칸보다 길면 글자 단위로 끊는다. */
  Ctx.prototype.wrap = function (s, size, bold, maxW) {
    var self = this, lines = [], cur = '';
    if (!s) return [''];
    var push = function () { lines.push(cur); cur = ''; };
    s.split(' ').forEach(function (tok) {
      if (tok === '') return;
      var cand = cur ? cur + ' ' + tok : tok;
      if (self.w(cand, size, bold) <= maxW) { cur = cand; return; }
      if (cur) push();
      if (self.w(tok, size, bold) <= maxW) { cur = tok; return; }
      var chars = Array.from(tok), piece = '';
      chars.forEach(function (c) {
        if (piece && self.w(piece + c, size, bold) > maxW) { lines.push(piece); piece = c; }
        else piece += c;
      });
      cur = piece;
    });
    if (cur || !lines.length) lines.push(cur);
    return lines;
  };

  /**
   * 칸 하나의 글자 배치를 정한다(그리기 전에 높이를 알아야 쪽을 나눌 수 있다).
   *   o = { t, size, bold, align, wrap, padX, padY, minSize, lines(미리 나눈 줄), color, fill, maxLines }
   * 돌려주는 값: { lines, size, h } — h 는 이 칸이 필요로 하는 높이.
   */
  Ctx.prototype.layout = function (o, w) {
    var size = o.size || 7.4, bold = !!o.bold;
    var padX = o.padX == null ? 1 * MM : o.padX, padY = o.padY == null ? 1.1 * MM : o.padY;
    // padL — 왼쪽만 따로 비울 때(운행기록부 통행료 칸의 출처 표시 「하」·「영」 자리, 2026-10-23). 없으면 양쪽 padX(예전 그대로).
    var padL = o.padL == null ? padX : o.padL;
    var inner = Math.max(1, o.padL == null ? w - 2 * padX : w - padL - padX);
    var minSize = o.minSize || 4.5;
    var lines, self = this;
    var src = o.t == null ? '' : String(o.t);
    var raw = this.clean(src);
    this.stats.cells++;

    if (o.lines) {
      lines = o.lines.map(function (x) { return self.clean(x); });
    } else if (!o.wrap && src.indexOf('\n') >= 0) {
      // 머리글처럼 줄을 미리 나눠 준 칸(clean 은 줄바꿈을 공백으로 바꾸므로 먼저 나눈다)
      lines = src.split('\n').map(function (x) { return self.clean(x); });
    } else if (o.wrap) {
      // 낱말 하나가 칸보다 조금 넓으면 글자 중간에서 끊기 전에 글자를 먼저 줄여 본다
      // ("대전복합터미/널" 보다 조금 작은 "대전복합터미널" 이 읽기 좋다). 6.2pt 까지만.
      var longest = raw.split(' ').reduce(function (m, tk) { return Math.max(m, self.w(tk, size, bold)); }, 0);
      if (longest > inner) {
        var floor = Math.max(minSize, Math.min(size, 6.2));
        var want = size * inner / longest;
        if (want >= floor) size = Math.floor(want * 10) / 10;
      }
      lines = this.wrap(raw, size, bold, inner);
      // 줄 수가 너무 많으면(주소가 아주 길 때) 글자를 조금 줄여 다시 접는다.
      var cap = o.maxLines || 3;
      while (lines.length > cap && size > Math.max(minSize, 5.5)) {
        size -= 0.3;
        lines = this.wrap(raw, size, bold, inner);
      }
      if (lines.length > 1) this.stats.wrapped++;
    } else {
      lines = [raw];
    }
    // 어느 줄이든 칸보다 넓으면 맞을 때까지 줄인다(줄바꿈 안 하는 숫자·머리글 칸).
    var widest = function () {
      return lines.reduce(function (m, l) { return Math.max(m, self.w(l, size, bold)); }, 0);
    };
    var shrunk = false;
    while (widest() > inner + 0.01 && size > minSize) { size = Math.max(minSize, size - 0.2); shrunk = true; }
    if (shrunk) this.stats.shrunk++;
    if (widest() > inner + 0.01) {
      this.issue('overflow', '칸보다 넓은 글자: "' + lines.join(' / ').slice(0, 40) + '"');
    }
    if (size < this.stats.minSize) this.stats.minSize = size;
    if (size < 5.2) this.issue('tiny', '글자가 너무 작아짐(' + size.toFixed(1) + 'pt): "' + lines.join(' ').slice(0, 30) + '"');
    return { lines: lines, size: size, h: lines.length * size * LH + 2 * padY, padX: padX, padY: padY, padL: padL };
  };

  /** 칸을 그린다. (x, yTop) 은 왼쪽 위, 좌표는 위에서 아래로 센다. */
  Ctx.prototype.cell = function (x, yTop, w, h, o, lay) {
    var pg = this.page, lib = this.lib;
    lay = lay || this.layout(o, w);
    if (o.fill != null || o.border !== false) {
      pg.drawRectangle({
        x: x, y: this.ph - yTop - h, width: w, height: h,
        // fill: 회색 값(0~1) 또는 [r, g, b](0~1) — 개인경비 명세는 양식의 파랑·노랑 칠을 쓴다.
        color: o.fill == null ? undefined : Array.isArray(o.fill) ? lib.rgb(o.fill[0], o.fill[1], o.fill[2]) : this.gray(o.fill),
        borderColor: o.border === false ? undefined : this.black,
        borderWidth: o.border === false ? 0 : (o.bw || this.bw || BW)
      });
    }
    if (o.slash) {
      pg.drawLine({ start: { x: x, y: this.ph - yTop - h }, end: { x: x + w, y: this.ph - yTop }, thickness: BW, color: this.black });
      return;
    }
    var size = lay.size, bold = !!o.bold, f = this.font(bold), lh = size * LH;
    var blockH = lay.lines.length * lh;
    // 높이가 정해진 칸(행 높이를 글자에 맞추지 않는 칸)에서 글자가 위아래로 넘치면 알린다.
    if (blockH > h + 0.5) this.issue('overflow', '칸 높이를 넘는 글자: "' + lay.lines.join(' / ').slice(0, 40) + '"');
    var top = o.valign === 'top' ? yTop + lay.padY : yTop + (h - blockH) / 2;
    var color = o.color != null ? this.gray(o.color) : this.black;
    var padL = o.padL == null ? lay.padX : (lay.padL == null ? o.padL : lay.padL);
    for (var i = 0; i < lay.lines.length; i++) {
      var ln = lay.lines[i];
      if (!ln) continue;
      var tw = f.widthOfTextAtSize(ln, size);
      var tx = o.align === 'right' ? x + w - lay.padX - tw
        : o.align === 'center' ? (o.padL == null ? x + (w - tw) / 2 : x + padL + (w - padL - lay.padX - tw) / 2)
          : x + padL;
      var base = top + i * lh + lh / 2 + size * 0.35;      // 한글 글리프의 눈높이 중심
      pg.drawText(ln, { x: tx, y: this.ph - base, size: size, font: f, color: color });
    }
    // 칸 왼쪽의 작은 표시(운행기록부 통행료 칸 「하」·「영」 — 2026-10-23). 글자 자리는 padL 로 비워 둔다.
    if (o.mark) {
      var mz = o.markSize || 5.2, mt = this.clean(o.mark);
      pg.drawText(mt, { x: x + 0.7, y: this.ph - (yTop + h / 2 + mz * 0.35), size: mz, font: this.fR, color: this.gray(0.35) });
    }
  };
  /** 뒤에서 정해지는 글 칸들을 채운다 — 부록까지 다 그린 뒤(쪽 번호가 정해진 뒤) 한 번 부른다.
   *  칸 높이는 그릴 때 견본 글(o.t)로 정했다 — 실제 글이 견본보다 길면 칸을 넘친 것으로 알린다(cell 이 issue). */
  Ctx.prototype.fillLater = function () {
    var self = this, list = this.later;
    this.later = [];
    list.forEach(function (it) {
      self.page = it.page;
      var o = {}, k;
      for (k in it.o) o[k] = it.o[k];
      var t = '';
      try { t = it.o.later(); } catch (e) { t = ''; }
      o.t = t; o.later = null; o.border = false; o.fill = null;
      self.cell(it.x, it.y, it.w, it.h, o);
    });
  };

  /** 한 줄 글자(칸 없이). align 은 x 를 기준으로 한다. 폭이 주어지면 그 안에 들어가게 줄인다. */
  Ctx.prototype.text = function (s, x, yTop, o) {
    o = o || {};
    var size = o.size || 9, bold = !!o.bold, f = this.font(bold);
    s = this.clean(s);
    if (o.maxW) { while (f.widthOfTextAtSize(s, size) > o.maxW && size > 4.5) size -= 0.2; }
    var tw = f.widthOfTextAtSize(s, size);
    var tx = o.align === 'right' ? x - tw : o.align === 'center' ? x - tw / 2 : x;
    this.page.drawText(s, {
      x: tx, y: this.ph - (yTop + size * 0.85), size: size, font: f,
      color: o.color != null ? this.gray(o.color) : this.black
    });
    return tw;
  };
  Ctx.prototype.rule = function (yTop, thick, gray) {
    this.page.drawLine({
      start: { x: MX, y: this.ph - yTop }, end: { x: this.pw - MX, y: this.ph - yTop },
      thickness: thick || 0.6, color: gray != null ? this.gray(gray) : this.black
    });
  };

  /**
   * 표의 한 행. cells = [{ w, ...칸 옵션 }]. 필요한 높이를 먼저 재고,
   * 쪽에 안 들어가면 onBreak() 를 불러 새 쪽을 연 뒤 그린다.
   */
  Ctx.prototype.row = function (cells, o) {
    o = o || {};
    var self = this, lays = cells.map(function (c) { return c.slash ? null : self.layout(c, c.w); });
    var h = Math.max(o.minH || 0, lays.reduce(function (m, l) { return l ? Math.max(m, l.h) : m; }, 0));
    if (this.y + h > this.limit + 0.01) {
      if (o.onBreak) o.onBreak(); else this.newPage();
    }
    var x = o.x == null ? MX : o.x;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i].later) {
        // 글이 뒤에서 정해지는 칸 — 테두리·칠만 지금, 글은 fillLater 가(높이는 견본 글 o.t 로 쟀다)
        this.cell(x, this.y, cells[i].w, h, { t: '', fill: cells[i].fill });
        this.later.push({ page: this.page, x: x, y: this.y, w: cells[i].w, h: h, o: cells[i] });
      } else this.cell(x, this.y, cells[i].w, h, cells[i], lays[i]);
      x += cells[i].w;
    }
    this.y += h;
    return h;
  };
  /** 행을 그리지 않고 높이만 잰다(묶음을 한 쪽에 두려고 미리 재는 데 쓴다). */
  Ctx.prototype.rowHeight = function (cells, minH) {
    var self = this, saved = {}, k;
    for (k in this.stats) saved[k] = this.stats[k];
    var issuesBefore = this.issues.length;
    // ★ '없는 글자' 표시도 되돌린다. 안 그러면 잴 때 표시만 남고 경고는 지워져,
    //   실제로 그릴 때는 '이미 알린 글자'로 보고 아무 말도 하지 않는다.
    var missBefore = Object.create(null);
    for (k in this.missing) missBefore[k] = 1;
    var h = cells.reduce(function (m, c) { return c.slash ? m : Math.max(m, self.layout(c, c.w).h); }, minH || 0);
    this.stats = saved; this.issues.length = issuesBefore; this.missing = missBefore;   // 재기만 한 것은 통계에서 뺀다
    return h;
  };

  // ─────────────────────────── 운행기록부 ───────────────────────────
  function sheetTotals(sh) {
    var t = { km: 0, fuel: 0, park: 0, toll: 0, all: 0 };
    var rows = (sh.rows || []).map(function (r) {
      var dist = Number(r.odoE) - Number(r.odoS);              // I = H − G (역행이면 음수 그대로)
      var fuel = Math.max(0, dist) * Number(r.rate || 0);      // J = MAX(0, I) × 단가
      var park = Number(r.parking) || 0;
      var toll = r.toll == null ? null : Number(r.toll);
      var total = fuel + park + (toll || 0);                   // M = J + K + L
      t.km += dist; t.fuel += fuel; t.park += park; t.toll += (toll || 0); t.all += total;
      return { r: r, dist: dist, fuel: fuel, park: park, toll: toll, total: total };
    });
    var orph = (sh.orphans || []).map(function (d) {
      var p = Number(d.parking) || 0, tl = Number(d.toll) || 0;
      t.park += p; t.toll += tl; t.all += p + tl;
      return { date: d.date, park: p, toll: tl, total: p + tl };
    });
    return { rows: rows, orphans: orph, t: t };
  }

  function drawTableHead(c) {
    c.row(HEAD.map(function (h, i) {
      return { w: COLS[i], t: h, size: 7.2, align: 'center', fill: 0.95 };
    }));
  }
  function contHeader(c, sh) {
    c.newPage();
    c.text('차량운행내역기록부 (계속)', MX, c.y, { size: 9.5, bold: true });
    c.text([sh.name, sh.plateNo, sh.periodLabel].filter(Boolean).join(' · '), MX + CW, c.y + 0.8,
      { size: 8, align: 'right', color: 0.2, maxW: CW * 0.6 });
    c.y += 9.5 * LH + 1.5 * MM;
    drawTableHead(c);
  }

  function drawSheet(c, sh) {
    var calc = sheetTotals(sh), t = calc.t;
    c.newPage();

    // ── 제목 ──
    c.text('차량운행내역기록부', MX + CW / 2, c.y, { size: 17, bold: true, align: 'center' });
    c.y += 17 * 1.25 + 4.5 * MM;
    c.text(sh.periodLabel || '', MX + CW / 2, c.y, { size: 9, align: 'center', color: 0.2 });
    c.y += 9 * LH + 4 * MM;

    // ── 인적사항(왼쪽) + 결재란(오른쪽) ──
    var top = c.y;
    var apprW = (7 + 17 * 5) * MM, gap = 5 * MM, infoW = CW - apprW - gap;
    var thW = 24 * MM, rowH = 7 * MM, iy = top;
    [['부 서', sh.dept], ['성 명', sh.name], ['차량번호', sh.plateNo], ['차 종', sh.vehicleType || '—']]
      .forEach(function (kv) {
        // 값이 길어 두 줄이 되면 그 줄만 키운다 — 7mm 에 가두면 글자가 칸 위아래로 넘친다.
        var vo = { t: kv[1] || '', size: 9, padX: 2.4 * MM, padY: 0.8 * MM, wrap: true, maxLines: 2 };
        var vl = c.layout(vo, infoW - thW), hh = Math.max(rowH, vl.h);
        c.cell(MX, iy, thW, hh, { t: kv[0], size: 9, align: 'center', fill: 0.95 });
        c.cell(MX + thW, iy, infoW - thW, hh, vo, vl);
        iy += hh;
      });
    var boxBottom = drawBoxes(c, MX + infoW + gap, top, sh.boxes, null, sh.boxLabels);
    c.y = Math.max(iy, boxBottom) + 4 * MM;

    // ── 요약 한 줄 ──
    var sw = [30, 28, 30, 28, 34, 40].map(function (m) { return m * MM; });
    c.row([
      { w: sw[0], t: '총 운행거리(Km)', size: 8.5, align: 'center', fill: 0.95 },
      { w: sw[1], t: n0(t.km), size: 8.5, align: 'right', padX: 2.4 * MM },
      { w: sw[2], t: '기본지급액(원)', size: 8.5, align: 'center', fill: 0.95 },
      { w: sw[3], t: n0(basePay(t.km)), size: 8.5, align: 'right', padX: 2.4 * MM },
      { w: sw[4], t: '■ 유류 기준단가', size: 8.5, align: 'center', fill: 0.95 },
      { w: sw[5], t: sh.quarterLabel || '', size: 8.5, align: 'right', padX: 2.4 * MM }
    ], { minH: 7 * MM });
    c.y += 3 * MM;
    return drawSheetBody(c, sh, calc, t);
  }

  /** 결재란(담당·센터·파트장·팀장·사업부장·대표이사 — labels, 예전 건은 v1 칸) — 세 문서가 같이 쓴다. (ax, top) 은 왼쪽 위. 아래 끝 y 를 돌려준다.
   *  boxes[칸] = { name, date, sign } · 칸이 없으면 빗금(건너뜀) · name 이 비면 빈칸(아직 결재 전). */
  /*  g = 칸 크기·모양(없으면 운행기록부 크기). 개인경비 명세는 양식 결재란(흰 바탕, 「결 재」 세로 칸)에 맞춘 값을 넘긴다. */
  function drawBoxes(c, ax, top, boxesIn, g, labels) {
    g = g || {};
    var labW = g.labW || 7 * MM, boxW = g.boxW || 17 * MM, hdH = g.hdH || 5.8 * MM, sgH = g.sgH || 13 * MM;
    var hfill = g.fill === undefined ? 0.95 : g.fill, hsz = g.size || 8;
    c.cell(ax, top, labW, hdH + sgH, { lines: g.label || ['결', '재'], size: hsz, align: 'center', fill: hfill });
    var boxes = boxesIn || {};
    (labels || BOXES).forEach(function (b, i) {
      var bx = ax + labW + i * boxW;
      c.cell(bx, top, boxW, hdH, { t: b, size: hsz, align: 'center', fill: hfill, padX: g.hpadX });
      var v = boxes[b];
      if (!v) { c.cell(bx, top + hdH, boxW, sgH, { slash: true }); return; }
      c.cell(bx, top + hdH, boxW, sgH, { t: '' });
      var sgi = v.sign && c.signs && c.signs[v.sign];
      if (v.name && sgi) {
        // 서명·도장 그림을 칸 위쪽에 맞춰 넣고(비율 유지), 날짜는 그 아래.
        var mw = boxW - 2 * MM, mh = sgH - (v.date ? 4.2 * MM : 1.6 * MM);
        var k = Math.min(mw / sgi.width, mh / sgi.height), iw = sgi.width * k, ih = sgi.height * k;
        var iy0 = top + hdH + 0.8 * MM + (mh - ih) / 2;
        c.page.drawImage(sgi, { x: bx + (boxW - iw) / 2, y: c.ph - iy0 - ih, width: iw, height: ih });
        if (v.date) {
          var ds0 = c.clean(v.date), dw0 = c.fR.widthOfTextAtSize(ds0, 6.5);
          c.page.drawText(ds0, { x: bx + (boxW - dw0) / 2, y: c.ph - (top + hdH + sgH - 1.3 * MM), size: 6.5, font: c.fR, color: c.gray(0.33) });
        }
      } else if (v.name) {
        var lay = c.layout({ t: v.name, size: 8.5, padX: 0.8 * MM }, boxW);
        var f = c.fR, nm = lay.lines[0], tw = f.widthOfTextAtSize(nm, lay.size);
        var mid = top + hdH + sgH / 2;
        var by = v.date ? mid - 0.6 : mid + lay.size * 0.35;
        c.page.drawText(nm, { x: bx + (boxW - tw) / 2, y: c.ph - by, size: lay.size, font: f, color: c.black });
        if (v.date) {
          var ds = c.clean(v.date), dw = f.widthOfTextAtSize(ds, 6.5);
          c.page.drawText(ds, { x: bx + (boxW - dw) / 2, y: c.ph - (mid + 9), size: 6.5, font: f, color: c.gray(0.33) });
        }
      }
    });
    return top + hdH + sgH;
  }

  function drawSheetBody(c, sh, calc, t) {
    // ── 운행 내역 ──
    drawTableHead(c);
    var brk = function () { contHeader(c, sh); };
    var N = { align: 'right' };
    var mk = function (vals, extra) {
      return vals.map(function (v, i) {
        var o = { w: COLS[i], t: v == null ? '' : v };
        if (i === 0 || i === 4 || i === 5) o.align = 'center';
        else if (i >= 6) o.align = N.align;
        else { o.wrap = true; }
        if (extra) for (var k in extra) o[k] = extra[k];
        return o;
      });
    };
    var body = [], marks = {};
    calc.rows.forEach(function (x) {
      var r = x.r;
      // 통행료: 0 은 '확정된 0원', 빈 값은 아직 정하지 않은 것이다. 빈칸으로 두면 둘을 가릴 수 없어 적어 준다(합계에는 0원).
      var cells = mk([r.date, r.start, r.end, r.visit, r.purpose, r.manual ? '수기' : '자동',
        n0(r.odoS), n0(r.odoE), n0(x.dist), n0(x.fuel),
        x.park > 0 ? n0(x.park) : '', x.toll == null ? '미확정' : n0(x.toll), n0(x.total)]);
      if (x.toll == null) { cells[11].color = 0.4; cells[11].align = 'center'; }
      // 통행료 칸 출처(2026-10-23) — 하: 하이패스 영수증(PDF)으로 맞춘 금액 · 영: 운행에 금액이 없어 영수증 사진으로 채운 금액. 표 아래 범례.
      //   「입력 구분」 칸(자동·수기)은 운행을 어떻게 넣었는지라 통행료가 어디서 왔는지는 말하지 않는다.
      else if (r.tollMark === '하' || r.tollMark === '영') { cells[11].mark = r.tollMark; cells[11].padL = 0.7 + 4.9 + 0.8; marks[r.tollMark] = 1; }
      body.push(cells);
    });
    calc.orphans.forEach(function (d) {
      body.push(mk([d.date, '', '', '', '근거자료', '영수증', '', '', '', '',
        d.park > 0 ? n0(d.park) : '', d.toll > 0 ? n0(d.toll) : '', d.total ? n0(d.total) : '']));
    });

    // ── 합계 묶음 — 쪼개지지 않게 한 쪽에 둔다 ──
    var span = function (from, to) { var s = 0; for (var i = from; i <= to; i++) s += COLS[i]; return s; };
    var totRow = [
      { w: span(0, 7), t: '운행 내역 합계', bold: true, align: 'center', fill: 0.95 },
      { w: COLS[8], t: n0(t.km), bold: true, align: 'right' },
      { w: COLS[9], t: n0(t.fuel), bold: true, align: 'right' },
      { w: COLS[10], t: n0(t.park), bold: true, align: 'right' },
      { w: COLS[11], t: n0(t.toll), bold: true, align: 'right' },
      { w: COLS[12], t: n0(t.all), bold: true, align: 'right' }
    ];
    var partRows = (sh.parts || []).map(function (p) {
      return [
        { w: span(0, 7), t: '└  ' + p.region + ' 출발  ×  ' + n0(p.rate) + '원/km', size: 7.2, color: 0.2, padX: 2 * MM },
        { w: COLS[8], t: n0(p.km), align: 'right', color: 0.2 },
        { w: COLS[9], t: n0(p.amount), align: 'right', color: 0.2 },
        { w: COLS[10], t: '' }, { w: COLS[11], t: '' }, { w: COLS[12], t: '' }
      ];
    });
    var grandRow = [
      { w: span(0, 11), t: '당월 차량운행비 총계', size: 8, bold: true, align: 'center', fill: 0.91 },
      { w: COLS[12], t: n0(t.all), size: 8.6, bold: true, align: 'right', fill: 0.91 }
    ];
    // 하이패스 근거는 한국도로공사 하이패스 영수증 PDF 다(2026-10-23 관리자 — 문서 글은 「이용내역」이 아니라 「하이패스 영수증」, 사진은 「영수증 사진」으로 가른다)
    var legend = [marks['하'] ? '하 = 하이패스 영수증(PDF)으로 맞춘 통행료' : '', marks['영'] ? '영 = 운행에 통행료가 없어 영수증 사진으로 채운 금액' : ''].filter(Boolean);
    var legendH = legend.length ? 1.4 * MM + 6.8 * LH : 0;
    var need = c.rowHeight(totRow) + partRows.reduce(function (s, r) { return s + c.rowHeight(r); }, 0) +
      c.rowHeight(grandRow, 6.4 * MM) + legendH;
    body.forEach(function (cells, i) {
      // 합계 묶음만 다음 쪽으로 넘어가면 「(계속)」 쪽에 숫자만 덩그러니 남는다 — 마지막 행을 데리고 넘어간다.
      if (i === body.length - 1 && c.y + c.rowHeight(cells) + need > LIMIT + 0.01) brk();
      c.row(cells, { onBreak: brk });
    });
    if (!body.length) {
      c.row(mk(['', '', '', '', '', '', '', '', '', '', '', '', '']), { onBreak: brk, minH: 5.6 * MM });
    }
    if (c.y + need > LIMIT + 0.01) brk();
    c.row(totRow);
    partRows.forEach(function (r) { c.row(r); });
    c.row(grandRow, { minH: 6.4 * MM });
    if (legend.length) {
      c.y += 1.4 * MM;
      c.text('통행료 칸 표시 — ' + legend.join(' · '), MX, c.y, { size: 6.8, color: 0.3, maxW: CW });
      c.y += 6.8 * LH;
    }
    return t;
  }

  // ─────────────────────────── 검증 결과 ───────────────────────────
  var LEVEL = { bad: '불일치', warn: '확인', info: '참고', ok: '정상' };
  function drawVerify(c, v, meta) {
    var head = function (cont) {
      c.newPage();
      c.text('검증 결과' + (cont ? ' (계속)' : ''), MX, c.y, { size: 14, bold: true });
      c.text([meta.name, meta.cycleName].filter(Boolean).join(' · '), MX + CW, c.y + 3,
        { size: 8.5, align: 'right', color: 0.2, maxW: CW * 0.55 });
      c.y += 14 * LH + 1.5 * MM;
      c.rule(c.y, 0.6); c.y += 3 * MM;
    };
    head(false);
    var s = v.summary || {};
    var line1 = [
      v.ranAt ? '검증 시각 ' + v.ranAt : '',
      v.ai ? 'AI 사진 판독 ' + n0(s.read || 0) + ' / ' + n0(s.receipts || 0) + '장' : (v.noAiText || 'AI 사진 판독 없음(규칙 검증만)')
    ].filter(Boolean).join('   ·   ');
    c.text(line1, MX, c.y, { size: 8.5, color: 0.2, maxW: CW });
    c.y += 8.5 * LH + 2.5 * MM;

    var bw = CW / 3;
    c.row([
      { w: bw, t: '불일치  ' + n0(s.bad || 0) + '건', size: 10.5, bold: true, align: 'center', fill: (s.bad ? 0.88 : 0.97) },
      { w: bw, t: '확인 필요  ' + n0(s.warn || 0) + '건', size: 10.5, bold: true, align: 'center', fill: 0.97 },
      { w: bw, t: '참고  ' + n0(s.info || 0) + '건', size: 10.5, bold: true, align: 'center', fill: 0.97 }
    ], { minH: 9 * MM });
    c.y += 4 * MM;

    var items = (v.items || []).filter(function (it) { return it.level !== 'ok'; });
    var W = [15 * MM, 50 * MM, CW - 65 * MM];
    var th = function () {
      c.row([
        { w: W[0], t: '등급', size: 8, align: 'center', fill: 0.95 },
        { w: W[1], t: '항목', size: 8, align: 'center', fill: 0.95 },
        { w: W[2], t: '내용', size: 8, align: 'center', fill: 0.95 }
      ], { minH: 6 * MM });
    };
    if (!items.length) {
      c.text('확인이 필요한 항목이 없습니다.', MX, c.y, { size: 10 });
      c.y += 10 * LH + 3 * MM;
    } else {
      th();
      var brk = function () { head(true); th(); };
      items.forEach(function (it) {
        c.row([
          { w: W[0], t: LEVEL[it.level] || it.level, size: 8, align: 'center', bold: it.level === 'bad' },
          { w: W[1], t: it.title || '', size: 8, wrap: true, maxLines: 4, padX: 1.6 * MM, bold: it.level === 'bad' },
          // 결재 문서에는 끝의 「다시 검증하면 …」(직원만 할 수 있는 일)을 싣지 않는다 — drv-verify.js noRecheck 와 같은 규칙(2026-10-21)
          { w: W[2], t: String(it.detail || '').replace(/\s*[—-]?\s*다시 검증하면[^.。]*[.。]?\s*$/, ''), size: 8, wrap: true, maxLines: 12, padX: 1.6 * MM }
        ], { onBreak: brk, minH: 6 * MM });
      });
      c.y += 3 * MM;
    }
    if (c.y + 12 * MM > LIMIT) head(true);
    // 맺음 문구 — 문서마다 다르면 v.notes 로 받는다(법인카드: AI 없음, 빈칸만 막음 — 2026-10-09). 없으면 예전 두 줄.
    var notes = v.notes || ['· 금액 계산은 정해진 규칙으로만 합니다. AI 는 사진을 읽어 입력값과 다른 곳을 표시할 뿐, 값을 바꾸지 않습니다.',
      '· 불일치·확인 항목이 있어도 상신할 수 있습니다. 결재자는 이 표를 보고 판단합니다.'];
    notes.forEach(function (t, k) {
      c.text(t, MX, c.y, { size: 7.6, color: 0.3, maxW: CW });
      c.y += 7.6 * LH + (k < notes.length - 1 ? 0.8 * MM : 0);
    });
  }

  // ─────────────────────────── 영수증 ───────────────────────────
  /** JPEG 의 EXIF 방향(1~8). 없으면 1. 폰 사진은 6(시계 90°)이 흔하다. */
  function exifOrientation(b) {
    try {
      if (b[0] !== 0xFF || b[1] !== 0xD8) return 1;
      var p = 2;
      while (p + 4 < b.length) {
        if (b[p] !== 0xFF) return 1;
        var mk = b[p + 1], len = (b[p + 2] << 8) | b[p + 3];
        if (mk === 0xE1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
          var t = p + 10, le = b[t] === 0x49;
          var u16 = function (o) { return le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]); };
          var u32 = function (o) {
            return le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
              : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
          };
          var ifd = t + u32(t + 4), n = u16(ifd);
          for (var i = 0; i < n; i++) {
            var e = ifd + 2 + i * 12;
            if (u16(e) === 0x0112) { var v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
          }
          return 1;
        }
        if (mk === 0xDA) return 1;
        p += 2 + len;
      }
    } catch (e) { /* 손상된 헤더 — 그대로 둔다 */ }
    return 1;
  }

  /** 사진을 (x, yTop, w, h) 안에 비율을 지켜 넣는다. 못 불러오면 빈 칸에 사유를 적는다. */
  function drawPhoto(c, im, x, yTop, w, h) {
    c.page.drawRectangle({ x: x, y: PH - yTop - h, width: w, height: h, borderColor: c.gray(0.73), borderWidth: BW });
    if (!im || !im.img) {
      c.text('사진을 불러오지 못했습니다', x + w / 2, yTop + h / 2 - 5, { size: 8, align: 'center', color: 0.45, maxW: w - 8 });
      return;
    }
    var o = im.orient || 1, swap = o >= 5;
    var iw = swap ? im.img.height : im.img.width, ih = swap ? im.img.width : im.img.height;
    var pad = 1.2;
    var sc = Math.min((w - 2 * pad) / iw, (h - 2 * pad) / ih);
    var DW = iw * sc, DH = ih * sc;                       // 보이는 크기
    var left = x + (w - DW) / 2, bottom = PH - yTop - h + (h - DH) / 2;
    var deg = c.lib.degrees;
    if (o === 6) c.page.drawImage(im.img, { x: left, y: bottom + DH, width: DH, height: DW, rotate: deg(-90) });
    else if (o === 8) c.page.drawImage(im.img, { x: left + DW, y: bottom, width: DH, height: DW, rotate: deg(90) });
    else if (o === 3) c.page.drawImage(im.img, { x: left + DW, y: bottom + DH, width: DW, height: DH, rotate: deg(180) });
    else c.page.drawImage(im.img, { x: left, y: bottom, width: DW, height: DH });
    c.stats.images++;
  }

  /** sumText = 오른쪽 위에 적을 금액 설명(없으면 쪽 번호만). 무엇의 합인지 글로 밝혀 넘긴다.
   *  sub = 머리 아래 한 줄(통행료·주차 쪽의 대조 줄 「표 통행료 14,300 = 하이패스 13,500 + 영수증 사진 800」, 2026-10-23). */
  function receiptHead(c, title, meta, pageNo, pageCnt, sumText, sub) {
    c.newPage();
    var tw = c.text(title, MX, c.y, { size: 12, bold: true });
    c.text([meta.name, meta.cycleName].filter(Boolean).join(' · '), MX + tw + 4 * MM, c.y + 3,
      { size: 8.5, color: 0.2, maxW: CW * 0.3 });
    var right = (sumText ? sumText + '    ' : '') + pageNo + ' / ' + pageCnt;
    c.text(right, MX + CW, c.y + 3, { size: 8.5, align: 'right', bold: !!sumText, maxW: CW * 0.52 });
    c.y += 12 * LH + 1.8 * MM;
    c.rule(c.y, 0.6); c.y += 3.5 * MM;
    if (sub) {
      // sub 가 [굵은 대조 줄, 흐린 둘째 줄] 이면 두 줄(통행료 묶음 첫 쪽 「정산에 넣지 않은 것 — …」, 2026-10-23)
      var s1 = Array.isArray(sub) ? sub[0] : sub, s2 = Array.isArray(sub) ? sub[1] : '';
      c.text(s1, MX, c.y, { size: 8.6, bold: true, maxW: CW });
      c.y += 8.6 * LH + (s2 ? 0.8 : 2.4) * MM;
      if (s2) { c.text(s2, MX, c.y, { size: 7.4, color: 0.3, maxW: CW }); c.y += 7.4 * LH + 2.4 * MM; }
    }
  }
  /** 계기판 사진의 km 글(2026-10-23 — 「₩129,832」로 찍히던 것). 계기판 줄의 금액 칸은 돈이 아니다: 예전 앱·웹은 거기에 km 를 적었고(직원 사례),
   *  2026-10-21 부터 웹은 0 으로 올린다. km = 적은 값(금액 칸 > 0) → 사진 판독 km → 메모가 숫자뿐이면 그 숫자. 없으면 null. */
  function odoKmOf(e) {
    var a = Number(e.amount);
    if (isFinite(a) && a > 0) return Math.round(a);
    var ai = e.ai && Number(e.ai.km);
    if (ai && isFinite(ai) && ai > 0) return Math.round(ai);
    var m = /^\s*([0-9][0-9,.\s]{2,})\s*(km|㎞|키로|킬로)?\s*$/i.exec(String(e.memo || ''));
    var v = m ? Number(m[1].replace(/[,.\s]/g, '')) : NaN;
    return isFinite(v) && v > 0 ? v : null;
  }
  function capOf(e) {
    var memo = String(e.memo || '');
    if (memo.length > 40) memo = memo.slice(0, 39) + '…';      // 사진 설명은 두 줄까지 — 긴 메모는 줄인다
    // 계기판은 금액이 아니라 km(2026-10-23) — ₩ 로 찍지 않는다
    var odo = (e.category || e.cat) === '계기판', km = odo ? odoKmOf(e) : null;
    if (odo && km != null && String(memo).replace(/[^0-9]/g, '') === String(km)) memo = '';
    return [e.date || '', odo ? (km != null ? '계기판 ' + n0(km) + 'km' : '계기판 사진') : Number(e.amount) > 0 ? won(e.amount) : '', e.plate || '', memo]
      .filter(Boolean).join(' · ');
  }

  function drawScans(c, scans, imgs, meta) {
    scans.forEach(function (sc, si) {
      var sum = (sc.items || []).reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0);
      receiptHead(c, '영수증 (스캔 원본)', meta, si + 1, scans.length, '이 장 합계 ' + won(sum));
      var W = [20 * MM, 24 * MM, 28 * MM, CW - 72 * MM];
      c.row([
        { w: W[0], t: '구분', size: 7.6, align: 'center', fill: 0.95 },
        { w: W[1], t: '날짜', size: 7.6, align: 'center', fill: 0.95 },
        { w: W[2], t: '금액', size: 7.6, align: 'center', fill: 0.95 },
        { w: W[3], t: '메모', size: 7.6, align: 'center', fill: 0.95 }
      ], { minH: 5 * MM });
      (sc.items || []).forEach(function (e) {
        c.row([
          { w: W[0], t: e.category || '', size: 7.6, align: 'center' },
          { w: W[1], t: e.date || '', size: 7.6, align: 'center' },
          { w: W[2], t: Number(e.amount) > 0 ? n0(e.amount) : '', size: 7.6, align: 'right', padX: 2 * MM },
          { w: W[3], t: e.memo || '', size: 7.6, wrap: true, maxLines: 2, padX: 1.6 * MM }
        ], { minH: 5 * MM });
      });
      c.y += 3 * MM;
      // 표가 길어 사진 자리가 너무 줄면(40% 미만) 사진을 다음 쪽에 통째로 싣는다.
      if (LIMIT - c.y < (LIMIT - MT) * 0.4) {
        c.newPage();
        c.text('영수증 (스캔 원본) — ' + (si + 1) + '번째 장 사진', MX, c.y, { size: 9, bold: true });
        c.y += 9 * LH + 2 * MM;
      }
      drawPhoto(c, imgs[sc.path], MX, c.y, CW, LIMIT - c.y);
      c.y = LIMIT;
    });
  }

  function drawPhotos(c, photos, imgs, meta) {
    var cats = CATS.slice();
    photos.forEach(function (p) { if (cats.indexOf(p.category || '') < 0) cats.push(p.category || ''); });
    cats.forEach(function (cat) {
      var list = photos.filter(function (p) { return (p.category || '') === cat; });
      if (!list.length) return;
      var per = cat === '계기판' ? 1 : 4, pages = Math.ceil(list.length / per);
      var add = function (s, e) { return s + (Number(e.amount) || 0); };
      var all = list.reduce(add, 0);
      for (var i = 0; i < list.length; i += per) {
        var chunk = list.slice(i, i + per);
        var sum = chunk.reduce(add, 0);
        // 여러 쪽이면 '이 쪽 소계'와 '구분 전체'를 같이 적는다. "합계" 한 마디만 적으면 그 쪽 4장의 합을 구분 전체로 읽는다.
        //   「사진 합계」(2026-10-23) — 표 금액이 아니라 이 쪽들에 실은 사진의 금액 합이다(표와 맞춰 보는 줄은 통행료 근거·쪽 머리 대조 줄).
        var st = per === 1 ? '' : pages > 1
          ? '이 쪽 사진 소계 ' + won(sum) + ' · 사진 합계 ' + n0(list.length) + '건 ' + won(all)
          : '사진 합계 ' + n0(list.length) + '건 ' + won(all);
        receiptHead(c, cat || '기타', meta, i / per + 1, pages, st);
        var top = c.y, gap = 4 * MM, capH = 7.6 * LH * 2 + 1.2 * MM;
        var cols = per === 1 ? 1 : 2, rows = per === 1 ? 1 : 2;
        var cw = (CW - gap * (cols - 1)) / cols;
        var ch = (LIMIT - top - gap * (rows - 1)) / rows;
        chunk.forEach(function (e, k) {
          var cx = MX + (k % cols) * (cw + gap), cy = top + Math.floor(k / cols) * (ch + gap);
          drawPhoto(c, imgs[e.path], cx, cy, cw, ch - capH);
          var lay = c.layout({ t: capOf(e), size: 7.6, wrap: true, maxLines: 2, padX: 0, padY: 0 }, cw);
          // 설명 자리는 두 줄이다 — 넘는 줄은 그리지 않는다(아래 사진이나 쪽 번호 줄을 덮는다).
          if (lay.lines.length > 2) { lay.lines = lay.lines.slice(0, 2); lay.h = 2 * lay.size * LH; }
          c.cell(cx, cy + ch - capH + 1.2 * MM, cw, lay.h, { border: false, align: 'center', color: 0.2, valign: 'top' }, lay);
        });
        c.y = LIMIT;
      }
    });
  }

  // ─────────────────────────── 통행료 근거 · 증빙 차례 · 부록 (2026-10-23) ───────────────────────────
  /* 관리자 신고(2026-10-23, 10명): 「일부 통행료 영수증 누락 · 순서가 섞임 · 표 금액과 다른 곳 · 통행료 아닌 영수증도 들어감」.
     돈 계산은 맞았다(결재 요약 = 표 = 엑셀 = 서버, 1원까지) — 문서가 근거를 싣는 방식이 문제였다:
       · 하이패스 이용내역으로 맞춘 통행료는 표에 숫자만 있고 근거가 없었다
       · 여러 영수증을 한 번에 찍은 장(scan_path)의 줄은 「영수증 (스캔 원본)」에 장째로 가서 「통행료」 쪽에는 없었다
       · 같은 날 안의 차례가 날짜 → id 라 거꾸로 나왔고(여러 장 올리기는 날짜를 그날 00:00 으로 둔다), 쪽 머리 「합계」는 그 쪽 사진 합이었다
       · 원본 장을 통째로 실어 정산하지 않은 영수증도 보였고, 계기판 사진 설명에 km 가 ₩ 로 찍혔다
     사용자 결정 「한 흐름」 — 운행기록부 → 통행료 근거(날짜·시각 순, 날마다 표 금액 = 하이패스 + 영수증) → (검증 결과) → 통행료 영수증(#k 차례)
       → 주차 → 주유 → 계기판(차마다 마지막 한 장) → 여러 영수증을 한 번에 찍은 원본 → 하이패스 영수증 원본.
     금액은 여기서 다시 세지 않는다 — doc.ev.money 는 driving-app.js evMaterial 이 금액 규칙 v3(money-rule.js)로 낸 날마다 값,
     doc.ev.table 은 이 문서 운행기록부 칸 값 그대로다. 여기서는 차례를 정하고, 대조 줄을 글로 쓰고, 그린다.
     (2026-10-23 관리자 「영수증은 없고 내역만 있으면 안 된다」) 하이패스 근거는 한국도로공사 하이패스 영수증 PDF 다 — 문서 글은 「하이패스 영수증」,
       사진으로 올린 영수증은 「영수증 사진」으로 가른다. 원본 PDF 가 없는 하이패스 줄은 사진 칸 「원본 없음」(굵게) + issues 'hipass' 「원본 없음 N줄」.
       결재본 문서에 지금 자료에서 받은 원본(결재본에 줄이 없던 문서의 'live' 줄 · 인쇄 준비가 결재본 줄에 옮긴 pdf — Tr.late)은
       「상신 뒤 덧붙임(MM.DD)」(결재 완료본이고 파일 날짜가 완료한 날 이후면 「결재 완료 뒤 덧붙임」) — 미리보기에는 없다.
     (2026-10-23 검토) 원본이 있는지 모르는 줄 — 줄을 못 받은 하이패스(hpMiss) · 인쇄 준비가 지금 운행을 받지 못해 원본을 확인하지 못한 결재본 줄
       (Tr.lateMiss — 관리자가 아닌 결재자는 남의 운행을 읽지 못한다) — 은 사진 칸 「확인 못 함」(굵게 아님)이고 「원본 없음」으로 세지 않는다
       (문서 점검은 「줄을 받지 못한 운행 N건」 · 「원본을 확인하지 못한 운행 N건」). 「원본 없음」·「확인 못 함」은 10월분(HP_ORIG_FROM)부터 —
       그 전 기간은 원본을 보관하지 않아 다시 출력해도 고칠 수 없다(「—」 그대로).

     doc.ev = { user(문서 주인 아이디), legacy, frozen, items:[I], trips:[Tr], money:{ 통행료:{days:[Dy]}, 주차:{…} }, table:{ 통행료:{total, byDay}, 주차:{…} }, bizPlates, photoMeta }
       I  = { id, cat, ms(date_millis), cap(captured_at — 모르면 undefined), amount, memo, plate, photo, scan, link(이은 운행 id), day(규칙 v3 의 날),
              ai: null | { time 'HH:MM', idx(원본 장 안 자리), n(그 장에서 읽은 영수증 수), km, merchant } }
       Tr = { id, start, end, visit, to, plate, hp(하이패스 몫), ej(toll_evidence_json — 자료에 칸이 없으면 undefined), line('frozen'|'live'|'stale'|'nofetch'|''),
              late([줄 차례] — 인쇄 준비가 지금 자료에서 pdf 를 옮긴 결재본 줄, 없으면 undefined),
              lateMiss(true — 인쇄 준비가 원본을 보려고 지금 운행을 받으려 했는데 못 받음(권한·연결), 없으면 undefined) }
       Dy = { day, T, H, U, D, settle, st, ev:[영수증 id], hp:{ 운행 id: 하이패스 몫 }, amt:{ 운행 id: 운행 금액 }, trips:[운행 id], fill:{ 운행 id: [영수증 id] }, target, dup:[영수증 id] } */
  var KST = 9 * 3600e3, DAY = 864e5;
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  // 하이패스 영수증 원본을 따지는 첫날(2026-10-23 검토) — 10월분부터: 서버 MONEY_V3_FROM · money-rule.js FROM · 검증 R15 와 같은 날.
  //   흐름의 날 = 규칙 v3 이 하이패스 몫을 둔 날 = 운행 출발 날(R15 와 같은 날 셈). 그 전 날의 줄은 원본이 없어도 「—」 · 세지 않는다.
  var HP_ORIG_FROM = '2026-09-21';
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function kd(ms) { return new Date(Number(ms) + KST); }
  function ymdK(ms) { var d = kd(ms); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); }
  function hmK(ms) { var d = kd(ms); return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); }
  function dayMs(day) { var p = String(day).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]) - KST; }
  function mdOf(day) { return String(day).slice(5).replace('-', '.'); }
  function dayLabel(day) { return mdOf(day) + '(' + DOW[kd(dayMs(day)).getUTCDay()] + ')'; }
  /** 하이패스 영수증 줄의 시각 'YYYY-MM-DD HH:MM'(한국 시각) → ms. 못 읽으면 NaN. */
  function atMs(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - KST : NaN;
  }
  function ext(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
  function sumOf(list, f) { return (list || []).reduce(function (s, x) { return s + (Number(f ? f(x) : x) || 0); }, 0); }
  /** 여러 영수증을 한 번에 찍은 장의 줄인가(원본 scan_path 가 있고 계기판이 아님 — 서버 driving-verify.ts isScanLine 과 같다). */
  function isScanLine(e) { return !!e.scan && e.cat !== '계기판'; }
  /** 원본 장 줄인데 오린 사진이 없는가(영수증 자리를 못 받아 원본 장 전체가 그 줄 사진 — photo_path = scan_path). */
  function noCrop(e) { return isScanLine(e) && (!e.photo || e.photo === e.scan); }
  /** 사진 쪽에 실을 그 줄 사진 — 원본 장 줄이면 오린 사진(있을 때만), 아니면 그 줄 사진. 없으면 ''. */
  function photoOf(e) { return noCrop(e) ? '' : (e.photo || ''); }
  /**
   * 영수증의 시각(정렬·표시용) — { ms, hm, how } | null. ★ date_millis 는 바꾸지 않는다 — 그 영수증의 날은 금액 규칙이 정한 날 그대로다
   * (규칙 v3 receiptHome 이 시각을 보고 날을 다시 고르지 않게). 시각은 차례를 정하는 데만 쓴다.
   *   ① 사진 판독 시각(evidence_ai result.time — 원본 장 줄이면 그 장 판독에서 이 줄과 짝지은 영수증의 시각)
   *   ② 영수증 날짜에 시각이 있으면(date_millis 가 한국 자정이 아님 — 하이패스 인쇄 영수증·운행과 함께 넣은 영수증)
   *   ③ 찍은 시각(captured_at) — 영수증 날짜와 같은 날일 때만(나중에 몰아 올리면 올린 시각이라 그 영수증의 시각이 아니다)
   * 없으면 null — 그날 맨 뒤에 id 순.
   */
  function evTime(e) {
    var ms = Number(e.ms), day = ymdK(ms);
    var t = e.ai && /^\d{2}:\d{2}$/.test(String(e.ai.time || '')) ? String(e.ai.time) : '';
    if (t && +t.slice(0, 2) < 24 && +t.slice(3) < 60) return { ms: dayMs(day) + (+t.slice(0, 2)) * 3600e3 + (+t.slice(3)) * 60e3, hm: t, how: 'ai' };
    if (isFinite(ms) && (ms + KST) % DAY !== 0) return { ms: ms, hm: hmK(ms), how: 'date' };
    var cap = e.cap == null ? NaN : Number(e.cap);
    if (isFinite(cap) && cap > 0 && ymdK(cap) === day) return { ms: cap, hm: hmK(cap), how: 'cap' };
    return null;
  }
  /** 붙은 운행 글 — 「13:20 출발 · 방문처」(그 날이 아니면 날짜도). */
  function tripText(t, day) {
    if (!t) return '';
    var when = (day && ymdK(t.start) !== day ? mdOf(ymdK(t.start)) + ' ' : '') + hmK(t.start) + ' 출발';
    var where = t.visit ? t.visit : t.to ? t.to + ' 도착' : '';
    return where ? when + ' · ' + where : when;
  }
  /** 하이패스 영수증 한 줄의 내용 — 「입구 → 출구 영업소 · 1종」. */
  function lineText(l) {
    var route = l.entry ? l.entry + ' → ' + (l.office || '?') : (l.office || '');
    return [route, l.cls ? l.cls + '종' : ''].filter(Boolean).join(' · ');
  }
  /** 영수증이 붙은 운행 — 이은 운행 → 그 영수증으로 채운 운행 → 시각이 든 운행(없으면 그 시각 앞의 마지막 운행) →
   *  하이패스가 아닌 통행료가 그 영수증 금액과 같은 운행 → 하이패스가 아닌 통행료가 있는 운행 → 그날 대표 운행. (표시만 — 금액은 날 단위 규칙 그대로) */
  function attachTrip(e, d, tm, T) {
    if (e.link != null && T[String(e.link)]) return T[String(e.link)];
    if (!d || !(d.trips || []).length) return null;
    var list = d.trips.map(function (id) { return T[String(id)]; }).filter(Boolean);
    var fill = d.fill || {}, k;
    for (k in fill) {
      if ((fill[k] || []).some(function (x) { return String(x) === String(e.id); }) && T[String(k)]) return T[String(k)];
    }
    if (tm) {
      var hit = list.filter(function (t) { return t.end != null && t.start <= tm.ms && tm.ms <= t.end; })[0];
      if (hit) return hit;
      var before = list.filter(function (t) { return t.start <= tm.ms; });
      if (before.length) return before[before.length - 1];
    }
    var amt = d.amt || {}, hp = d.hp || {};
    var rest = function (t) { return Math.round((Number(amt[t.id]) || 0) - (Number(hp[t.id]) || 0)); };
    var own = list.filter(function (t) { return rest(t) > 0; });
    return own.filter(function (t) { return rest(t) === Math.round(Number(e.amount) || 0); })[0] || own[0] ||
      (d.target != null && T[String(d.target)]) || list[0] || null;
  }

  /**
   * 날마다 대조(표 금액 = 하이패스 + 영수증)와 쪽 머리 대조 줄. 숫자는 doc.ev.money(규칙 v3) · doc.ev.table(이 문서 표 칸) 그대로 쓴다.
   *   규칙 v3: 정산 = 업무 운행 금액 T(있으면) · 없으면 붙은 영수증 합(채움) · 업무 운행 없는 날은 0.
   *     일치     T = 하이패스 H + 영수증(U − D) — D 는 하이패스와 같은 통행료로 본 영수증(한 번만 셈)
   *     금액 다름 정산은 T, 증빙(H + U)과 차이 · 영수증 없음 정산 T, 증빙 0 · 업무 운행 없는 날 영수증은 정산 제외
   *   예전 규칙(v1·v2) 결재본은 표 = 운행 금액 + 영수증이었다 — 날마다 「표 · 증빙」 차이만 적는다(그때 규칙 그대로 찍은 표를 다시 셈하지 않는다).
   * 돌려주는 것: { days: [{ day, label, table, settle, hp, rc, U, D, st, diff, nonbiz, text, bad }],
   *               head: { table, hp, rc, parts: [[글, ±금액]], text, noTrip, noTripN, dup, dupN } }
   *   head.text = 「표 통행료 14,300 = 하이패스 13,500 + 영수증 사진 800」 — 증빙 없는 몫은 「+ 영수증 없는 날 2일 2,300」처럼 더해 식이 늘 맞게.
   *   ★ 하이패스 몫도 영수증(하이패스 영수증 PDF)이다 — 사진으로 올린 영수증은 「영수증 사진」으로 적어 가른다(2026-10-23, 주차 쪽도 같은 말).
   *     「영수증 없는 날」·「증빙 없음(그날 … 영수증이 없습니다)」은 하이패스·사진 어느 영수증도 없다는 뜻이라 그대로.
   */
  function dayChecks(ev, cat) {
    var word = cat === '주차' ? '주차비' : '통행료';
    var M = ((ev.money || {})[cat] || {}).days || [], tab = (ev.table || {})[cat] || {}, by = tab.byDay || {};
    var md = {};
    M.forEach(function (d) { md[d.day] = d; });
    var keys = Object.keys(by).filter(function (k) { return Math.round(Number(by[k]) || 0) !== 0; }).concat(M.map(function (d) { return d.day; }));
    keys = keys.filter(function (k, i) { return keys.indexOf(k) === i; }).sort();
    var H = { table: Math.round(Number(tab.total) || 0), hp: 0, rc: 0, none: 0, noneN: 0, diff: 0, diffN: 0, nonbiz: 0, noTrip: 0, noTripN: 0, dup: 0, dupN: 0 };
    var rhs = function (h, r) { var t = []; if (h) t.push('하이패스 ' + n0(h)); if (r || !h) t.push('영수증 사진 ' + n0(r)); return t.join(' + '); };
    var days = keys.map(function (k) {
      var d = md[k] || null, table = Math.round(Number(by[k]) || 0);
      var hp = d ? Math.round(Number(d.H) || 0) : 0, U = d ? Math.round(Number(d.U) || 0) : 0, D = d ? Math.round(Number(d.D) || 0) : 0;
      var st = d ? d.st : '', settle = d ? Math.round(Number(d.settle) || 0) : 0;
      var rc = 0, text = '', bad = false, nonbiz = 0, diff = 0;
      if (ev.legacy) {
        // 예전 규칙(v2): 표 = 운행에 적은 금액 + 그날 영수증 — 하이패스 몫을 빼고 남는 운행 금액을 그대로 적는다(차이가 아니다)
        rc = U; diff = table - hp - rc;
        var lt = [];
        if (hp) lt.push('하이패스 ' + n0(hp));
        if (diff > 0) lt.push('운행에 적은 금액 ' + n0(diff));
        if (rc || !lt.length) lt.push('영수증 사진 ' + n0(rc));
        text = '표 ' + n0(table) + ' = ' + lt.join(' + ') + (diff < 0 ? ' - 차이 ' + n0(-diff) : '');
        bad = diff < 0;
        if (diff > 0) { H.legacyTrip = (H.legacyTrip || 0) + diff; diff = 0; }
      } else {
        nonbiz = table - settle;                          // 업무 외 운행(목적을 더 골라 만든 미리보기에만 있다)
        if (st === 'match') {
          rc = U - D;
          text = '표 ' + n0(settle) + ' = ' + rhs(hp, rc) + ' · 일치' + (D ? ' · 하이패스와 같은 영수증 사진 ' + n0(D) + '원은 한 번만 셈' : '');
          if (D) { H.dup += D; H.dupN += (d.dup || []).length; }
        } else if (st === 'filled') {
          rc = U; text = '표 ' + n0(settle) + ' = 영수증 사진 ' + n0(rc) + ' · 운행에 ' + word + '가 없어 영수증 사진으로 채움';
        } else if (st === 'mismatch') {
          rc = U; diff = settle - hp - rc; bad = true;
          text = '표 ' + n0(settle) + ' ≠ ' + rhs(hp, rc) + ' · 금액 다름(증빙이 ' + n0(Math.abs(diff)) + '원 ' + (diff > 0 ? '적음' : '많음') + ')';
          H.diff += diff; H.diffN++;
        } else if (st === 'no_receipt') {
          diff = settle; bad = true; text = '표 ' + n0(settle) + ' · 증빙 없음(그날 ' + cat + ' 영수증이 없습니다)';
          H.none += settle; H.noneN++;
        } else if (st === 'no_trip') {
          text = '업무 운행 없는 날 · 영수증 사진 ' + n0(U) + '원은 정산에서 뺌';
          H.noTrip += U; H.noTripN += (d.ev || []).length;
        } else if (table) text = '표 ' + n0(table);
        if (nonbiz) text = (text ? text + ' · ' : '') + '업무 외 운행 ' + n0(nonbiz) + '원(대조하지 않음)';
        H.nonbiz += nonbiz;
      }
      H.hp += hp; H.rc += rc;
      return { day: k, label: dayLabel(k), table: table, settle: settle, hp: hp, rc: rc, U: U, D: D, st: st, diff: diff, nonbiz: nonbiz, text: text, bad: bad };
    });
    var parts = [];
    if (!ev.legacy) {
      if (H.none) parts.push(['영수증 없는 날 ' + H.noneN + '일', H.none]);
      if (H.diff) parts.push(['금액 다른 날 ' + H.diffN + '일 차이', H.diff]);
      if (H.nonbiz) parts.push(['업무 외 운행', H.nonbiz]);
    } else if (H.legacyTrip) parts.push(['운행에 적은 금액(예전 규칙)', H.legacyTrip]);
    // 식이 늘 맞게 — 위에서 설명하지 못한 몫은 따로 적는다
    var rest = H.table - H.hp - H.rc - sumOf(parts, function (p) { return p[1]; });
    if (rest) parts.push(['그 밖의 차이', rest]);
    H.parts = parts;
    // 하이패스가 없으면 「하이패스 0 +」를 적지 않는다(2026-10-23 시안 — 낱장 사진만 올린 사람)
    H.text = '표 ' + word + ' ' + n0(H.table) + ' = ' + (cat === '통행료' && H.hp ? '하이패스 ' + n0(H.hp) + ' + ' : '') + '영수증 사진 ' + n0(H.rc) +
      parts.map(function (p) { return (p[1] < 0 ? ' - ' : ' + ') + p[0] + ' ' + n0(Math.abs(p[1])); }).join('');
    return { days: days, head: H };
  }

  var KIND_ORDER = { hp: 0, hpPrev: 0, hpNone: 0, hpStale: 0, hpMiss: 0, rc: 1, scan: 1 };
  /** 한 날 안의 차례 — 시각 → 시각 있는 줄 먼저 → 하이패스 줄 먼저 → 운행 출발 → 영수증 id → 하이패스 영수증 줄 차례. */
  function flowCmp(a, b) {
    return a.ms - b.ms || (a.known === b.known ? 0 : a.known ? -1 : 1) || (KIND_ORDER[a.kind] || 0) - (KIND_ORDER[b.kind] || 0) ||
      (a.tstart || 0) - (b.tstart || 0) || (Number(a.ev) || 0) - (Number(b.ev) || 0) || (a.seq || 0) - (b.seq || 0);
  }
  /**
   * 통행료 근거 한 흐름 — 표 한 줄 = 근거 하나. 날(규칙 v3 의 날)마다 묶고, 날 안에서는 시각 순(flowCmp).
   *   하이패스 영수증 — 운행의 toll_evidence_json.lines(결재본에 없으면 인쇄 준비가 받은 지금 줄) · 없고 prev.lines 만 있으면 「고치기 전」 ·
   *                      둘 다 없으면 「하이패스 금액 N원(하이패스 영수증 줄 없음)」 · 결재 뒤 바뀐 운행이면 줄을 싣지 않는다
   *   영수증 사진 — 규칙 v3 이 그날에 붙인 것(금액 0원 영수증은 영수증 날짜에 「정산에 안 셈」 — 사진이 빠지지 않게)
   * opt.changed = 바뀐 운행 글(결재 뒤 · 상신 뒤 · 화면을 연 뒤).
   * 원본 없음(2026-10-23) — 원본 PDF 경로가 없는 하이패스 줄(금액 0 줄은 빼고)과 줄 없는 하이패스(hpNone, 금액이 있으면): R.noOrig · nNoOrig.
   * 확인 못 함(2026-10-23 검토) — 원본이 있는지 모르는 줄: 줄을 못 받은 하이패스(hpMiss, 금액이 있으면) · 원본 경로가 없는 결재본 줄인데 인쇄 준비가
   *   지금 운행을 받지 못한 운행(Tr.lateMiss)의 줄: R.unk · nUnk(칸 수) · nUnkTrip(Tr.lateMiss 운행 수 — hpMiss 는 「줄을 받지 못한 운행」이 따로 센다).
   *   원본 없음·확인 못 함은 10월분부터(HP_ORIG_FROM) — 그 전 날은 둘 다 아니다(「—」).
   * 상신 뒤 덧붙임(2026-10-23) — 결재본 문서(ev.frozen)에서 원본 경로를 지금 자료에서 받은 줄: R.late —
   *   결재본에 줄이 없어 지금 줄을 받은 운행('live')의 줄 · 인쇄 준비가 결재본 줄에 지금 줄의 pdf 를 옮긴 줄(Tr.late). 미리보기(ev.frozen 아님)는 늘 아님.
   *   late[경로] = 그 원본을 가리키는 줄이 모두 late 인가(결재본 줄이 하나라도 가리키면 상신 때 있던 원본).
   * 돌려주는 것: { head, days: [{ …dayChecks, rows: [R] }], nHp, nRc, nZero, nNoOrig, nUnk, nUnkTrip, pdfs: [하이패스 원본 경로], late: { 경로: bool }, show }
   *   R = { kind, ms, known, timeText, what, content, amount, trip, ev, e, photo, ref(오린 사진 없는 원본 장 줄), pdf, page, late, noOrig, unk, excluded, note, no(#k) }
   */
  function tollFlow(ev, opt) {
    opt = opt || {};
    var C0 = dayChecks(ev, '통행료');
    var T = {}, E = {}, md = {};
    (ev.trips || []).forEach(function (t) { T[String(t.id)] = t; });
    (ev.items || []).forEach(function (e) { E[String(e.id)] = e; });
    (((ev.money || {})['통행료'] || {}).days || []).forEach(function (d) { md[d.day] = d; });
    var zero = {};
    (ev.items || []).forEach(function (e) {
      if (e.cat === '통행료' && !(Number(e.amount) > 0) && (e.photo || e.scan)) (zero[ymdK(e.ms)] = zero[ymdK(e.ms)] || []).push(e);
    });
    var days = C0.days.slice();
    Object.keys(zero).forEach(function (k) {
      if (!days.some(function (x) { return x.day === k; })) days.push({ day: k, label: dayLabel(k), text: '금액 0원 영수증(정산에 안 들어감)', bad: false, table: 0 });
    });
    days.sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });
    var changed = opt.changed || '결재 뒤 바뀐 운행';
    var out = { head: C0.head, days: [], nHp: 0, nRc: 0, nZero: 0, nNoOrig: 0, nUnk: 0, nUnkTrip: 0, pdfs: [], late: {} };
    days.forEach(function (x) {
      var d = md[x.day] || null, rows = [];
      // 원본을 따지는 날인가 — 10월분부터(HP_ORIG_FROM). 그 전 날은 원본이 없어도 「원본 없음」·「확인 못 함」이 아니다
      var orig = x.day >= HP_ORIG_FROM;
      Object.keys((d && d.hp) || {}).forEach(function (tid) {
        var t = T[String(tid)], share = Math.round(Number(d.hp[tid]) || 0);
        if (!t) return;
        var base = { trip: tripText(t, x.day), tstart: t.start, known: true, amount: share, photo: '' };
        var ej = t.ej && typeof t.ej === 'object' ? t.ej : null;
        var lines = ej && Array.isArray(ej.lines) && ej.lines.length ? ej.lines : null, prev = false;
        if (!lines && ej && ej.prev && Array.isArray(ej.prev.lines) && ej.prev.lines.length) { lines = ej.prev.lines; prev = true; }
        if (t.line === 'stale') {
          rows.push(ext(base, { kind: 'hpStale', ms: t.start, what: '하이패스', content: changed + ' — 하이패스 영수증 줄 생략(하이패스 금액 ' + n0(share) + '원)' }));
        } else if (lines) {
          var lateI = Array.isArray(t.late) ? t.late : [], unkN = 0;
          lines.forEach(function (l, i) {
            var at = atMs(l.at), pdf = l.pdf ? String(l.pdf) : '', amt = Math.round(Number(l.amount) || 0);
            // 상신 뒤 덧붙인 원본 — 결재본 문서에서 그 경로가 지금 자료에서 왔다(위 머리 글). 미리보기는 지금 자료가 곧 문서라 아니다.
            var late = !!(ev.frozen && pdf && (t.line === 'live' || lateI.indexOf(i) >= 0));
            // 원본 경로가 없는 줄(금액 0 줄 빼고 · 10월분부터) — 인쇄 준비가 지금 운행을 받지 못해 원본을 확인하지 못한 운행(Tr.lateMiss)이면
            //   「확인 못 함」(없다는 뜻이 아니다), 아니면 「원본 없음」
            var none = orig && !pdf && amt > 0, unk = none && !!t.lateMiss;
            rows.push(ext(base, { kind: prev ? 'hpPrev' : 'hp', ms: isFinite(at) ? at : t.start, what: prev ? '하이패스 영수증(고치기 전)' : '하이패스 영수증',
              amount: amt, content: lineText(l), pdf: pdf, page: Number(l.page) || 1, seq: i, late: late, noOrig: none && !unk, unk: unk }));
            if (pdf) {
              if (out.pdfs.indexOf(pdf) < 0) out.pdfs.push(pdf);
              out.late[pdf] = (out.late[pdf] === undefined || out.late[pdf]) && late;
            } else if (unk) { out.nUnk++; unkN++; }
            else if (none) out.nNoOrig++;
            out.nHp++;
          });
          if (unkN) out.nUnkTrip++;
          var ls = Math.round(sumOf(lines, function (l) { return l.amount; }));
          if (ls !== share) rows[rows.length - 1].note = '이 운행 하이패스 영수증 합 ' + n0(ls) + '원 · 하이패스 금액 ' + n0(share) + '원';
        } else {
          // 줄 없음(hpNone) — 하이패스 금액만 있고 그 영수증 원본이 없다: 「원본 없음」.
          // 줄을 못 받음(hpMiss) — 원본이 있는지 모른다: 「확인 못 함」(「원본 없음」으로 세지 않는다 — 문서 점검은 「줄을 받지 못한 운행 N건」).
          //   둘 다 금액이 있고 10월분부터일 때만(그 전 날은 「—」).
          var miss = t.line === 'nofetch', due = orig && share > 0;
          rows.push(ext(base, { kind: miss ? 'hpMiss' : 'hpNone', ms: t.start, what: '하이패스', noOrig: due && !miss, unk: due && miss,
            content: '하이패스 금액 ' + n0(share) + '원(' + (miss ? '하이패스 영수증 줄을 받지 못함' : '하이패스 영수증 줄 없음') + ')' }));
          if (due && miss) out.nUnk++;
          else if (due) out.nNoOrig++;
        }
      });
      var dup = {};
      ((d && d.dup) || []).forEach(function (id) { dup[String(id)] = 1; });
      ((d && d.ev) || []).concat((zero[x.day] || []).map(function (e) { return e.id; })).forEach(function (id) {
        var e = E[String(id)];
        if (!e) return;
        var tm = evTime(e), z = !(Number(e.amount) > 0), tr = z ? null : attachTrip(e, d, tm, T);
        var r = { kind: isScanLine(e) ? 'scan' : 'rc', ms: tm ? tm.ms : dayMs(x.day) + DAY - 1, known: !!tm, how: tm ? tm.how : '', ev: e.id, e: e,
          what: isScanLine(e) ? '영수증 사진(원본 장)' : '영수증 사진', amount: Math.round(Number(e.amount) || 0),
          content: e.memo || (e.ai && e.ai.merchant) || '', trip: tr ? tripText(tr, x.day) : (z ? '' : '업무 운행 없음'),
          photo: photoOf(e), ref: noCrop(e) };
        if (z) { r.excluded = true; r.note = '금액 0원 — 정산에 안 셈'; out.nZero++; }
        else if (d && d.st === 'no_trip') { r.excluded = true; r.note = '업무 운행 없는 날 — 정산 제외'; }
        else if (dup[String(id)]) { r.excluded = true; r.note = '하이패스와 같은 통행료 — 한 번만 셈'; }
        rows.push(r); out.nRc++;
      });
      rows.sort(flowCmp);
      // 찍은 시각(captured_at)은 영수증에 찍힌 시각이 아니다 — 「찍음」을 붙여 가른다
      rows.forEach(function (r) { r.timeText = !r.known ? '—' : (ymdK(r.ms) !== x.day ? mdOf(ymdK(r.ms)) + ' ' : '') + hmK(r.ms) + (r.how === 'cap' ? ' 찍음' : ''); });
      out.days.push(ext(x, { rows: rows }));
    });
    out.show = out.days.length > 0;
    return out;
  }
  /** 통행료 근거 줄에 사진 번호 #k(흐름 차례)를 단다. 같은 사진(fp 가 같음 — 같은 파일·같은 지문)은 같은 번호 — 사진은 한 번만 싣는다.
   *  돌려주는 것: [{ no, path, rows }] */
  function numberToll(F, fp) {
    var out = [], by = {};
    F.days.forEach(function (d) {
      d.rows.forEach(function (r) {
        r.no = 0;
        if (!r.photo) return;
        var k = fp ? fp(r.photo) : r.photo, g = by[k];
        if (!g) { g = by[k] = { no: out.length + 1, path: r.photo, rows: [] }; out.push(g); }
        g.rows.push(r); r.no = g.no;
      });
    });
    return out;
  }
  /** 한 사람의 업무 운행 차 — 계기판 사진에 번호판이 없으면 이 차가 한 대일 때만 그 차로 본다(서버 검증 R12·A05 photoPlate 와 같다). */
  function odoPlateOf(e, plates) { return e.plate ? e.plate : plates.length === 1 ? plates[0] : null; }
  /**
   * 계기판 — 차마다 가장 늦은(날짜·시각) 사진 한 장(서버 검증 A05 가 운행일지 최종 km 와 견주는 사진과 같은 고르기 — 날짜가 같으면 먼저 올린 것).
   * 돌려주는 것: [{ plate | null, pick, n }] — 업무 운행 차 차례 → 그 밖의 번호판 → 차를 모르는 사진.
   */
  function odoPicks(ev) {
    var plates = ev.bizPlates || [], groups = {}, order = [], NONE = ' (차 모름)';     // 번호판은 빈칸으로 시작하지 않는다
    (ev.items || []).filter(function (e) { return e.cat === '계기판' && e.photo; })
      .sort(function (a, b) { return a.ms - b.ms || Number(a.id) - Number(b.id); })
      .forEach(function (e) {
        var p = odoPlateOf(e, plates), k = p == null ? NONE : p, g = groups[k];
        if (!g) { g = groups[k] = { plate: p, pick: null, n: 0 }; order.push(k); }
        g.n++;
        if (!g.pick || Number(e.ms) > Number(g.pick.ms)) g.pick = e;
      });
    var rank = function (k) { var i = plates.indexOf(k); return k === NONE ? 2e9 : i >= 0 ? i : 1e9; };
    return order.slice().sort(function (a, b) { return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0); }).map(function (k) { return groups[k]; });
  }
  /** 사진 쪽 묶음 차례 — 통행료(근거 흐름 #k 차례) · 주차 · 주유(날짜·시각 순) · 계기판(차마다 마지막 한 장) · 그 밖(날짜·시각 순).
   *  주차·주유·그 밖에서 오린 사진이 없는 원본 장 줄은 사진 대신 「원본 장 부록 ○쪽 ○번째」 칸(kind 'ref'). 같은 사진은 한 번만(fp). */
  function photoSections(ev, F, fp) {
    var secs = [], items = ev.items || [];
    var tollG = numberToll(F, fp);
    if (tollG.length) {
      secs.push({ cat: '통행료', title: '통행료 영수증', per: 4, sub: F.head.text,
        entries: tollG.map(function (g) { return { kind: 'photo', path: g.path, no: g.no, rows: g.rows.map(function (r) { return r.e; }) }; }) });
    }
    var byTime = function (a, b) {
      var da = ymdK(a.ms), db = ymdK(b.ms);
      if (da !== db) return da < db ? -1 : 1;
      var ta = evTime(a), tb = evTime(b);
      return (ta && tb ? ta.ms - tb.ms : ta ? -1 : tb ? 1 : 0) || Number(a.id) - Number(b.id);
    };
    var put = function (cat, title, sub) {
      var list = items.filter(function (e) { return e.cat === cat && (e.photo || e.scan); }).sort(byTime);
      var entries = [], by = {};
      list.forEach(function (e) {
        if (noCrop(e)) { entries.push({ kind: 'ref', scan: e.scan, rows: [e] }); return; }
        var k = fp ? fp(e.photo) : e.photo;
        if (by[k]) { by[k].rows.push(e); return; }
        entries.push(by[k] = { kind: 'photo', path: e.photo, rows: [e] });
      });
      if (entries.length) secs.push({ cat: cat, title: title, per: 4, sub: sub, entries: entries });
    };
    put('주차', '주차 영수증', dayChecks(ev, '주차').head.text);
    put('주유', '주유 영수증', '');
    var odo = odoPicks(ev);
    if (odo.length) {
      secs.push({ cat: '계기판', title: '계기판 사진', per: 1, entries: odo.map(function (g) {
        var who = g.plate == null ? '차량을 고르지 않은 계기판 사진 ' : (g.plate ? g.plate + ' · ' : '') + '계기판 사진 ';
        return { kind: 'photo', path: g.pick.photo, rows: [g.pick], odo: true, headText: who + (g.n > 1 ? g.n + '장 중 마지막 1장' : '1장') };
      }) });
    }
    var other = [];
    items.forEach(function (e) { if (['통행료', '주차', '주유', '계기판'].indexOf(e.cat) < 0 && other.indexOf(e.cat) < 0) other.push(e.cat); });
    other.forEach(function (cat) { put(cat, cat || '기타', ''); });
    return secs;
  }
  /** 여러 영수증을 한 번에 찍은 원본 — 장마다 그 장의 이 문서 줄(장 안 자리 page_idx 차례, 모르면 뒤에 id 순)과 판독한 영수증 수.
   *  돌려주는 것: { pages: [{ path, lines, n, extra, pageNo }], pos: { 영수증 id: { g, k(몇 번째) } } } */
  function scanPlan(ev) {
    var by = {}, pages = [], pos = {};
    var idx = function (e) { var v = e.ai && e.ai.idx; return v != null && v !== '' && isFinite(Number(v)) ? Number(v) : null; };
    (ev.items || []).filter(isScanLine).slice().sort(function (a, b) { return a.ms - b.ms || Number(a.id) - Number(b.id); }).forEach(function (e) {
      var g = by[e.scan];
      if (!g) { g = by[e.scan] = { path: e.scan, lines: [], n: null, extra: 0, pageNo: 0 }; pages.push(g); }
      g.lines.push(e);
      var n = e.ai && e.ai.n;
      if (n != null && isFinite(Number(n))) g.n = Math.max(g.n || 0, Number(n));
    });
    pages.forEach(function (g) {
      g.lines.sort(function (a, b) { var ia = idx(a), ib = idx(b); return (ia == null ? 1e9 : ia) - (ib == null ? 1e9 : ib) || Number(a.id) - Number(b.id); });
      g.lines.forEach(function (e, k) { pos[String(e.id)] = { g: g, k: k + 1 }; });
      // 「이 장에는 정산에 넣지 않은 영수증 N장도 보입니다」 — 판독(all)의 영수증 수 − 이 기간 이 장의 줄 수
      g.extra = g.n != null ? Math.max(0, g.n - g.lines.length) : 0;
    });
    return { pages: pages, pos: pos };
  }
  /** 바뀐 운행 글 — 결재본이면 결재 뒤(결재 중·반려·회수는 상신 뒤), 지금 자료면 화면을 연 뒤. */
  function changedText(ev, meta) {
    return !ev.frozen ? '화면을 연 뒤 바뀐 운행' : meta && meta.mark ? '상신 뒤 바뀐 운행' : '결재 뒤 바뀐 운행';
  }
  /** 그릴 것 계획(사진을 받기 전) — 흐름 · 원본 장 · 받을 사진 경로. 같은 사진 가르기(fp)는 사진을 받은 뒤 photoSections 로 다시 한다. */
  function planOf(doc) {
    var ev = doc.ev, F = tollFlow(ev, { changed: changedText(ev, doc.meta) }), S = scanPlan(ev), paths = [];
    var add = function (p) { if (p && paths.indexOf(p) < 0) paths.push(p); };
    // 통행료는 오린 사진을 싣지 않는다(2026-10-23 — 원본 장 · 낱장 사진만). 주차·주유·계기판·그 밖은 예전 그대로.
    photoSections(ev, F, null).forEach(function (s) {
      if (s.cat === '통행료') return;
      s.entries.forEach(function (e) { add(e.path); });
    });
    F.days.forEach(function (d) { d.rows.forEach(function (r) { if (r.kind === 'rc' && r.photo) add(r.photo); }); });   // 낱장 통행료 사진
    S.pages.forEach(function (g) { add(g.path); });
    return { F: F, S: S, paths: paths };
  }
  /** 문서에 넣을 사진 경로(받기 전에 세기·진행 글용). */
  function imagePaths(doc) {
    if (doc && doc.ev) return planOf(doc).paths;
    var paths = [];
    ((doc && doc.scans) || []).forEach(function (s) { if (s.path && paths.indexOf(s.path) < 0) paths.push(s.path); });
    ((doc && doc.photos) || []).forEach(function (p) { if (p.path && paths.indexOf(p.path) < 0) paths.push(p.path); });
    return paths;
  }
  /** 원본 장(크게 받을 사진) 경로. */
  function scanPaths(doc) {
    if (doc && doc.ev) return scanPlan(doc.ev).pages.map(function (g) { return g.path; });
    return ((doc && doc.scans) || []).map(function (s) { return s.path; }).filter(Boolean);
  }
  /** 하이패스 영수증 원본 경로 꼴(2026-10-23 서버 약속 — 올린 사람 폴더) <아이디>/hipass/<YYYYMMDD-HHmmss>-<SHA-256 앞 16자>.pdf.
   *  맞으면 { owner, sha16 }, 아니면 null. */
  function hipassName(p) {
    var m = /^([^/]+)\/hipass\/(\d{8}-\d{6})-([0-9a-fA-F]{16})\.pdf$/.exec(String(p || ''));
    return m ? { owner: m[1], sha16: m[3].toLowerCase() } : null;
  }
  /** 덧붙인 원본 파일 이름의 날짜(<YYYYMMDD>-…, 한국 시각 — 올릴 때 그 파일의 시각) — [, YYYY, MM, DD] | null. */
  function lateDay(p) { return /\/hipass\/(\d{4})(\d{2})(\d{2})-\d{6}-[0-9a-fA-F]{16}\.pdf$/.exec(String(p || '')); }
  /** 결재 완료 뒤에 덧붙인 원본인가(2026-10-23) — 결재 완료본(meta.mark 없음 + meta.closedAt 결재 완료 시각)이고 파일 이름의 날짜가 완료한 날과 같거나 뒤. */
  function lateDone(p, meta) {
    var m = lateDay(p), done = meta && !meta.mark && meta.closedAt ? Date.parse(meta.closedAt) : NaN;
    return !!m && isFinite(done) && m[1] + '-' + m[2] + '-' + m[3] >= ymdK(done);
  }
  /** 상신 뒤 덧붙인 원본의 표시(2026-10-23) — 「상신 뒤 덧붙임(10.24)」 · 결재 완료 뒤(lateDone)면 「결재 완료 뒤 덧붙임(10.24)」. */
  function lateText(p, meta) {
    var m = lateDay(p);
    return (lateDone(p, meta) ? '결재 완료 뒤 덧붙임' : '상신 뒤 덧붙임') + (m ? '(' + m[2] + '.' + m[3] + ')' : '');
  }
  /** 「통행료 근거」 안내 한 줄(2026-10-23 검토 — 부록 머리 표시 lateText 와 같은 말). n = 부록에 실은 덧붙인 원본 수 · done = 그중 결재 완료 뒤(lateDone).
   *  모두 상신 뒤 「… N개는 상신 뒤 덧붙인 …」 · 모두 결재 완료 뒤 「… N개는 결재 완료 뒤 덧붙인 …」 · 섞이면 「… A개는 상신 뒤, B개는 결재 완료 뒤 덧붙인 …」. */
  function lateNote(n, done) {
    var when = !done ? n0(n) + '개는 상신 뒤' : done >= n ? n0(n) + '개는 결재 완료 뒤' : n0(n - done) + '개는 상신 뒤, ' + n0(done) + '개는 결재 완료 뒤';
    return '하이패스 영수증 원본 ' + when + ' 덧붙인 것입니다 — 금액·결재 내용은 그대로입니다.';
  }
  /** SHA-256 16진 글자(브라우저·Node 의 crypto.subtle). 쓸 수 없으면 null — 그때는 원본을 싣지 않는다(지문을 못 맞춰 봄). */
  function sha256hex(bytes) {
    var sub = typeof crypto !== 'undefined' && crypto && crypto.subtle ? crypto.subtle : null;
    if (!sub) return Promise.resolve(null);
    return sub.digest('SHA-256', bytes).then(function (buf) {
      var a = new Uint8Array(buf), s = '';
      for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
      return s;
    }, function () { return null; });
  }
  /** 사진 지문(받은 바이트) — FNV-1a 32 + 길이. */
  function fnv(b) {
    var h = 0x811c9dc5;
    for (var i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return 'h:' + h.toString(16) + ':' + b.length;
  }
  /** 같은 사진 가르기 — 같은 경로 · 결재본 사진 지문(photo_meta etag·크기)이 같음 · 받은 바이트가 같음 중 하나면 같은 사진. 돌려주는 것: 경로 → 대표 경로. */
  function samePhotoFn(paths, meta, hashes) {
    var parent = {}, byKey = {};
    var find = function (p) { while (parent[p] !== p) { parent[p] = parent[parent[p]]; p = parent[p]; } return p; };
    paths.forEach(function (p) { parent[p] = p; });
    var link = function (k, p) {
      if (!k) return;
      if (byKey[k] == null) { byKey[k] = p; return; }
      var a = find(p), b = find(byKey[k]);
      if (a !== b) parent[a] = b;
    };
    paths.forEach(function (p) {
      var m = meta && meta[p];
      if (m && m.etag) link('e:' + m.etag + ':' + (m.size == null ? '' : m.size), p);
      if (hashes && hashes[p]) link(hashes[p], p);
    });
    return function (p) { return parent[p] != null ? find(p) : p; };
  }

  // 사진 칸은 「원본 장 부록 16쪽 12번째」가 한 줄에 들어가는 폭(31mm) — 두 줄이면 그 줄들만 높아져 표가 들쭉날쭉했다
  /** 사진 대신 원본 장 부록을 가리키는 칸(주차·주유 — 오린 사진이 없는 원본 장 줄). 글은 쪽 번호가 정해진 뒤에 쓴다. */
  function drawRefBox(c, x, yTop, w, h, fn) {
    c.page.drawRectangle({ x: x, y: c.ph - yTop - h, width: w, height: h, borderColor: c.gray(0.73), borderWidth: BW });
    c.later.push({ page: c.page, x: x, y: yTop, w: w, h: h,
      o: { t: '', size: 8.6, align: 'center', wrap: true, maxLines: 4, color: 0.3, padX: 5 * MM, later: fn } });
  }
  function amountsText(rows) {
    var a = rows.map(function (e) { return Math.round(Number(e.amount) || 0); }).filter(function (v, i, l) { return l.indexOf(v) === i; });
    return a.map(function (v) { return n0(v) + '원'; }).join(' / ');
  }
  /** 사진 아래 두 줄 — 첫 줄 「#3 · 10.02 14:05 · 1,000원」 · 둘째 줄 「같은 사진 2장 — 한 번만 실음 · 메모」(앞의 것이 잘리지 않게 메모가 뒤). */
  function photoCaps(sec, ent) {
    var e = ent.rows[0], tm = evTime(e), when = mdOf(ymdK(e.ms)) + (tm ? ' ' + tm.hm + (tm.how === 'cap' ? ' 찍음' : '') : '');
    var memo = e.memo || (e.ai && e.ai.merchant) || '';
    if (ent.odo) {
      var km = odoKmOf(e);
      if (km != null && String(memo).replace(/[^0-9]/g, '') === String(km)) memo = '';
      return [[when, km != null ? '계기판 ' + n0(km) + 'km' : '계기판 사진', e.plate].filter(Boolean).join(' · '), memo];
    }
    var l1 = [ent.no ? '#' + ent.no : '', when, amountsText(ent.rows), sec.cat !== '통행료' && e.plate ? e.plate : ''].filter(Boolean).join(' · ');
    var l2 = [ent.rows.length > 1 ? '같은 사진 ' + ent.rows.length + '장 — 한 번만 실음' : '', ent.kind === 'ref' ? '원본 장의 줄(오린 사진 없음)' : '', memo].filter(Boolean).join(' · ');
    return [l1, l2];
  }
  /** 사진 쪽 한 묶음(4장씩, 계기판은 한 장씩). 머리 오른쪽 「사진 합계」 = 이 묶음에 실은 영수증 금액 합(표 금액과 맞춰 보는 줄은 머리 아래 대조 줄). */
  function drawSection(c, sec, imgs, meta, refs) {
    var per = sec.per, list = sec.entries, pages = Math.ceil(list.length / per);
    var allRows = [].concat.apply([], list.map(function (x) { return x.rows; }));
    var all = sumOf(allRows, function (e) { return e.amount; });
    for (var i = 0; i < list.length; i += per) {
      var chunk = list.slice(i, i + per);
      var sum = sumOf([].concat.apply([], chunk.map(function (x) { return x.rows; })), function (e) { return e.amount; });
      var st = per === 1 ? (chunk[0].headText || '') : pages > 1
        ? '이 쪽 사진 소계 ' + won(sum) + ' · 사진 합계 ' + n0(allRows.length) + '건 ' + won(all)
        : '사진 합계 ' + n0(allRows.length) + '건 ' + won(all);
      receiptHead(c, sec.title, meta, i / per + 1, pages, st, sec.sub);
      var top = c.y, gap = 4 * MM, S1 = 7.8, S2 = 7.4, capH = (S1 + S2) * LH + 1.6 * MM;
      var cols = per === 1 ? 1 : 2, rows = per === 1 ? 1 : 2;
      var cw = (CW - gap * (cols - 1)) / cols;
      var ch = (LIMIT - top - gap * (rows - 1)) / rows;
      chunk.forEach(function (ent, k) {
        var cx = MX + (k % cols) * (cw + gap), cy = top + Math.floor(k / cols) * (ch + gap);
        if (ent.kind === 'ref') drawRefBox(c, cx, cy, cw, ch - capH, function () { return refs.scanBox(ent.rows[0].id); });
        else drawPhoto(c, imgs[ent.path], cx, cy, cw, ch - capH);
        var cap = photoCaps(sec, ent), y1 = cy + ch - capH + 1.2 * MM;
        var l1 = fitLine(c, cap[0], S1, true, cw, 6.4), l2 = fitLine(c, cap[1] || '', S2, false, cw, 6.4);
        c.text(l1.t, cx + cw / 2, y1, { size: l1.size, bold: true, align: 'center', color: 0.1 });
        if (l2.t) c.text(l2.t, cx + cw / 2, y1 + S1 * LH, { size: l2.size, align: 'center', color: 0.25 });
      });
      c.y = LIMIT;
    }
  }
  /** 여러 영수증을 한 번에 찍은 원본 — 장마다 한 쪽(줄 목록 + 그 장 사진). 줄 목록 차례 = 장 안 자리(page_idx). */
  function drawScanPages(c, S, imgs, meta, noOf) {
    var pages = S.pages;
    pages.forEach(function (g, si) {
      var sum = sumOf(g.lines, function (e) { return e.amount; });
      receiptHead(c, '여러 영수증을 한 번에 찍은 원본', meta, si + 1, pages.length, '이 장 줄 합계 ' + won(sum));
      g.pageNo = c.pdf.getPageCount();
      var W = [9 * MM, 15 * MM, 15 * MM, 19 * MM, CW - 86 * MM, 28 * MM];
      c.row(['번호', '구분', '날짜', '금액', '내용', '사진'].map(function (h, i) { return { w: W[i], t: h, size: 7.6, align: 'center', fill: 0.95 }; }), { minH: 5 * MM });
      g.lines.forEach(function (e, k) {
        var no = noOf[String(e.id)];
        var pc = no ? '#' + no + '(통행료 영수증 쪽)' : photoOf(e) ? '오린 사진 — ' + e.cat + ' 쪽' : '이 장';
        c.row([
          { w: W[0], t: String(k + 1), size: 7.6, align: 'center', bold: true },
          { w: W[1], t: e.cat || '', size: 7.6, align: 'center' },
          { w: W[2], t: mdOf(ymdK(e.ms)), size: 7.6, align: 'center' },
          { w: W[3], t: Number(e.amount) > 0 ? n0(e.amount) : '', size: 7.6, align: 'right', padX: 2 * MM },
          { w: W[4], t: e.memo || '', size: 7.6, wrap: true, maxLines: 2, padX: 1.6 * MM },
          { w: W[5], t: pc, size: 7, align: 'center', wrap: true, maxLines: 2, padX: 0.8 * MM, color: 0.25 }
        ], { minH: 5 * MM });
      });
      if (g.extra > 0) {
        c.y += 1.6 * MM;
        c.text('이 장에는 정산에 넣지 않은 영수증 ' + n0(g.extra) + '장도 보입니다.', MX, c.y, { size: 8.4, bold: true, maxW: CW });
        c.y += 8.4 * LH;
      }
      c.y += 3 * MM;
      // 표가 길어 사진 자리가 너무 줄면(40% 미만) 사진을 다음 쪽에 통째로 싣는다.
      if (LIMIT - c.y < (LIMIT - MT) * 0.4) {
        c.newPage();
        c.text('여러 영수증을 한 번에 찍은 원본 — ' + (si + 1) + '번째 장 사진', MX, c.y, { size: 9, bold: true });
        c.y += 9 * LH + 2 * MM;
      }
      drawPhoto(c, imgs[g.path], MX, c.y, CW, LIMIT - c.y);
      c.y = LIMIT;
    });
  }
  // ─────────────────── 통행료 묶음 (2026-10-23 관리자: 「3·4쪽(통행료 근거) 필요 없음 · 통행료는 4장짜리 말고 한 번에 표 + 여러 장 ·
  //   차례 = 차량운행내역기록부 → 통행료(여러 영수증을 한 번에 찍은 원본) → 주차비 → 주유비 → 계기판」 · 시안을 보고 고른 것:
  //   ① 같은 영수증이 사진 원본과 하이패스 영수증 PDF 에 다 있으면 PDF 만 ② 낱장 통행료 사진은 표 + 사진 ③ 주차·주유 원본 장은 그 묶음 바로 뒤) ───────────
  var DUP_NOTE = '하이패스와 같은 통행료 — 한 번만 셈';
  var TV_HEAD = { size: 7.6, align: 'center', fill: 0.95 };
  function whenText(r) { return r.known ? mdOf(ymdK(r.ms)) + ' ' + hmK(r.ms) + (r.how === 'cap' ? ' 찍음' : '') : (r.e ? mdOf(ymdK(r.e.ms)) : '—'); }
  /** 표 한 줄의 「정산 · 붙은 운행」 칸 — 정산에서 뺀 영수증은 그 까닭, 아니면 붙은 운행. */
  function settleText(r) {
    if (!r) return '';
    if (r.excluded) return r.note === DUP_NOTE ? '하이패스 영수증과 같음 — 한 번만 셈' : (r.note || '정산 제외');
    return r.trip || '정산';
  }
  function offKey(s) { return String(s || '').replace(/\s+/g, ''); }
  /** 영업소 글이 같은 곳인가 — 띄어쓰기를 빼고 같거나 한쪽이 다른 쪽으로 끝나면(「한국도로공사 천안영업소」 · 「천안영업소」). 하나라도 비면 false. */
  function sameOffice(a, b) {
    a = offKey(a); b = offKey(b);
    if (!a || !b) return false;
    var n = Math.min(a.length, b.length);
    return a.slice(a.length - n) === b.slice(b.length - n);
  }
  /** 통행료 사진 영수증 줄(낱장 rc · 원본 장 scan)인가 */
  function tollPhotoRow(r) { return (r.kind === 'rc' || r.kind === 'scan') && !!r.e && r.e.cat === '통행료'; }
  /** 사진 영수증을 하이패스 영수증 PDF 와 맞출 수 있는가 — 메모(저장된 영업소 글)가 있는 통행료 사진이 하나라도 있어야 PDF 를 읽는다. */
  function needRecs(F) {
    return F.days.some(function (d) { return d.rows.some(function (r) { return tollPhotoRow(r) && !!offKey(r.e.memo); }); });
  }
  /**
   * 사진 영수증이 하이패스 영수증 PDF 안에 있는가(2026-10-23 사용자 「PDF만」 · 검토 반영) — 저장된 값만으로 본다(누가 출력해도 같은 결과):
   *   같은 날 · 같은 금액 · 메모(e.memo — 사진 판독 상호는 보는 사람마다 달라 쓰지 않는다)의 영업소 글이 PDF 영수증 영업소와 맞음 ·
   *   영수증 날짜에 시각이 있으면(evTime how 'date') 그 시각 ±10분. 메모가 없으면 PDF 에 있다고 보지 않는다(사진을 남긴다 — 닫힌 쪽).
   *   하이패스 줄은 그 PDF 의 같은 영수증(통과 시각·금액)을 먼저 차지한다. 「하이패스와 같은」 사진은 그 영수증과도 짝지을 수 있고,
   *   그 밖의 사진은 남은 영수증하고만(같은 영수증을 두 사진이 차지하지 않는다). PDF 를 못 읽었으면(f.recs 없음) 그 PDF 로는 맞추지 않는다.
   * 돌려주는 것: { 영수증 id: { f, page } }
   */
  function tollMatch(F, files) {
    var out = {}, pool = [];
    files.forEach(function (f) {
      if (!Array.isArray(f.recs)) return;
      f.recs.forEach(function (x) {
        var at = String((x && x.atText) || '');
        pool.push({ f: f, x: x, ms: atMs(at), day: at.slice(0, 10), amt: Math.round(Number(x && x.amount) || 0), hp: false, ph: false });
      });
    });
    if (!pool.length) return out;
    F.days.forEach(function (d) {
      d.rows.forEach(function (r) {
        if (!((r.kind === 'hp' || r.kind === 'hpPrev') && r.pdf)) return;
        for (var i = 0; i < pool.length; i++) {
          var p = pool[i];
          if (!p.hp && p.f.path === r.pdf && p.ms === r.ms && p.amt === r.amount) { p.hp = true; break; }
        }
      });
    });
    F.days.forEach(function (d) {
      d.rows.forEach(function (r) {
        if (!tollPhotoRow(r)) return;
        var e = r.e, memo = String(e.memo || '');
        if (!offKey(memo)) return;
        // 시각은 영수증 날짜에 저장된 것만(한국 자정이 아니면 — evTime 'date' 와 같은 셈). 사진 판독 시각(e.ai)은 본인·관리자만 받아
        //   보는 사람마다 결과가 달라지므로 쓰지 않는다(2026-10-23 검토).
        var ms0 = Number(e.ms), day = ymdK(ms0), amt = Math.round(Number(e.amount) || 0), at = isFinite(ms0) && (ms0 + KST) % DAY !== 0 ? ms0 : null;
        var dup = r.excluded && r.note === DUP_NOTE, hit = null;
        for (var i = 0; i < pool.length && !hit; i++) {
          var p = pool[i];
          if (p.ph || p.day !== day || p.amt !== amt || (p.hp && !dup)) continue;
          if (!sameOffice(memo, p.x.office)) continue;
          if (at != null && Math.abs(p.ms - at) > 10 * 60e3) continue;
          hit = p;
        }
        if (!hit) return;
        hit.ph = true;
        out[String(e.id)] = { f: hit.f, page: Number(hit.x.page) || 1 };
      });
    });
    return out;
  }
  /**
   * 통행료 묶음 계획 — 하이패스 원본을 받고 읽은 뒤, 사진을 받기 전(빠질 사진은 받지도 넣지도 않는다 — 파일이 커지지 않게).
   *   장의 줄이 모두 통행료이고 모두 PDF 에 있으면 그 원본 장은 싣지 않는다 · 낱장 사진은 그 사진의 줄이 모두 PDF 에 있으면 싣지 않는다.
   * 돌려주는 것: { ok: 실을 PDF, match, dropSheet: { 경로: true }, dropPhoto: { 경로: true } }
   */
  function tollPlan(P, files) {
    var F = P.F, ok = files.filter(function (f) { return f.pages && f.pages.length; });
    var match = tollMatch(F, ok);
    var isIn = function (e) { return !!e && e.cat === '통행료' && !!match[String(e.id)]; };
    var dropSheet = {}, dropPhoto = {}, byPhoto = {};
    P.S.pages.forEach(function (g) {
      if (g.lines.length && g.lines.every(isIn)) dropSheet[g.path] = true;
    });
    F.days.forEach(function (d) { d.rows.forEach(function (r) { if (r.kind === 'rc' && r.photo) (byPhoto[r.photo] = byPhoto[r.photo] || []).push(r); }); });
    Object.keys(byPhoto).forEach(function (p) { if (byPhoto[p].every(function (r) { return isIn(r.e); })) dropPhoto[p] = true; });
    return { ok: ok, match: match, dropSheet: dropSheet, dropPhoto: dropPhoto };
  }
  /** 낱장 통행료 사진 — 같은 사진(fp)은 한 묶음 · 묶음의 사진이 모두 빠지면(PDF 에 있음) 묶음도 뺀다. [{ path, paths, rows }] */
  function singleGroups(F, fp, drop) {
    var out = [], by = {};
    F.days.forEach(function (d) {
      d.rows.forEach(function (r) {
        if (r.kind !== 'rc' || !r.photo) return;
        var k = fp ? fp(r.photo) : r.photo, g = by[k];
        if (!g) { g = by[k] = { path: r.photo, paths: [], rows: [] }; out.push(g); }
        if (g.paths.indexOf(r.photo) < 0) g.paths.push(r.photo);
        g.rows.push(r);
      });
    });
    return out.filter(function (g) { return !g.paths.every(function (p) { return drop && drop[p]; }); });
  }
  /** 원본 쪽에 실리지 않는 하이패스 줄 — 원본 없음 · 확인 못 함 · 원본을 싣지 못함(못 받음·지문 다름·확인 안 됨) · 결재 뒤 바뀐 운행(줄 생략) · 10월분 전(—).
   *  (2026-10-23 검토: 「통행료 근거」 쪽이 없어진 뒤로 이 줄들이 문서 어디에도 안 나왔다) */
  function drawUnplaced(c, list, meta, sub) {
    var W = [26 * MM, CW - 99 * MM, 17 * MM, 34 * MM, 22 * MM];
    var th = function () { c.row(['날짜·시각', '내용', '금액', '붙은 운행', '원본'].map(function (h, i) { return ext({ w: W[i], t: h }, TV_HEAD); }), { minH: 5 * MM }); };
    receiptHead(c, '통행료 — 원본 쪽에 없는 하이패스 영수증 줄', meta, 1, 1, '하이패스 ' + n0(list.length) + '줄', sub);
    th();
    var brk = function () {
      c.newPage();
      c.text('통행료 — 원본 쪽에 없는 하이패스 영수증 줄 (계속)', MX, c.y, { size: 9, bold: true });
      c.y += 9 * LH + 2 * MM;
      th();
    };
    list.forEach(function (x) {
      var r = x.r, bad = x.bad;
      c.row([
        { w: W[0], t: r.kind === 'hpStale' || r.kind === 'hpNone' || r.kind === 'hpMiss' ? mdOf(ymdK(r.ms)) : whenText(r), size: 7.4, align: 'center' },
        { w: W[1], t: [r.content || '', r.kind === 'hpPrev' ? '(고치기 전)' : ''].filter(Boolean).join(' '), size: 7.2, wrap: true, maxLines: 2, padX: 1.4 * MM },
        { w: W[2], t: n0(r.amount), size: 7.4, align: 'right', padX: 1.6 * MM },
        { w: W[3], t: r.trip || '', size: 7, wrap: true, maxLines: 2, padX: 1.2 * MM },
        { w: W[4], t: x.st, size: 7.2, align: 'center', bold: bad, wrap: true, maxLines: 2, padX: 0.6 * MM }
      ], { onBreak: brk, minH: 5 * MM });
    });
    var note = '원본 없음 = 하이패스 금액은 있는데 영수증 원본(PDF)이 없음 · 확인 못 함 = 출력한 분이 원본이 있는지 볼 수 없음 · ' +
      '원본 못 받음·지문 다름·확인 안 됨 = 원본 파일을 싣지 못함 · 줄 생략 = 결재 뒤 바뀐 운행 · — = 10월분 전(원본을 따지지 않음).';
    var lay = c.layout({ t: note, size: 7.2, wrap: true, maxLines: 3, padX: 0, padY: 0, color: 0.3 }, CW);
    if (c.y + 2 * MM + lay.h > LIMIT) c.newPage(); else c.y += 2 * MM;
    c.cell(MX, c.y, CW, lay.h, { border: false, color: 0.3, valign: 'top' }, lay);
    c.y = LIMIT;
  }
  /** 하이패스 영수증 원본 — PDF 쪽마다 한 쪽: 위에 그 쪽에서 정산한 영수증 표(하이패스 줄 + 사진을 싣지 않은, 이 PDF 에 있는 사진 영수증) ·
   *  아래에 그 쪽(비율대로, 글자는 벡터). 줄의 쪽 번호가 PDF 쪽 수보다 크면 마지막 쪽에. 상신 뒤 덧붙인 원본이면 쪽마다 머리 아래 표시(f.lateText),
   *  첫 쪽에 안내 한 줄(note). */
  function drawHipassSheets(c, files, rows, meta, subOnce, note) {
    var total = files.reduce(function (s, f) { return s + f.pages.length; }, 0), k = 0;
    files.forEach(function (f, fi) {
      f.start = c.pdf.getPageCount() + 1;
      var pageOf = function (r) { return Math.max(1, Math.min(f.pages.length, Number(r.page) || 1)); };
      f.pages.forEach(function (ep, j) {
        k++;
        var mine = rows.filter(function (r) { return r.pdfPath === f.path && pageOf(r) === j + 1; }).sort(function (a, b) { return a.ms - b.ms; });
        var sum = sumOf(mine, function (r) { return r.amount; });
        receiptHead(c, '통행료 — 하이패스 영수증 원본', meta, k, total, mine.length ? '이 쪽 정산 ' + n0(mine.length) + '장 ' + won(sum) : '', subOnce());
        if (k === 1 && note) {
          c.text(note, MX, c.y, { size: 7.4, color: 0.3, maxW: CW });
          c.y += 7.4 * LH + 1 * MM;
        }
        var lw = f.lateText ? c.text(f.lateText, MX, c.y, { size: 8.6, bold: true, maxW: CW * 0.5 }) + 3 * MM : 0;
        c.text(f.name + ' · ' + (j + 1) + ' / ' + f.pages.length + '쪽' + (files.length > 1 ? ' · 파일 ' + (fi + 1) + ' / ' + files.length : ''),
          MX + lw, c.y + (lw ? (8.6 - 7.6) * 0.85 : 0), { size: 7.6, color: 0.35, maxW: CW - lw });
        c.y += (lw ? 8.6 : 7.6) * LH + 2 * MM;
        if (mine.length) {
          var W = [9 * MM, 24 * MM, 17 * MM, CW - 100 * MM, 50 * MM];
          var th = function () { c.row(['번호', '날짜·시각', '금액', '내용(입구 → 출구 영업소)', '붙은 운행'].map(function (h, i) { return ext({ w: W[i], t: h }, TV_HEAD); }), { minH: 5 * MM }); };
          var brk = function () { c.newPage(); th(); };
          th();
          mine.forEach(function (r, i) {
            var photo = r.kind === 'rc' || r.kind === 'scan';
            c.row([
              { w: W[0], t: String(i + 1), size: 7.6, align: 'center', bold: true },
              { w: W[1], t: whenText(r), size: 7.4, align: 'center' },
              { w: W[2], t: n0(r.amount), size: 7.4, align: 'right', padX: 1.6 * MM },
              { w: W[3], t: [photo ? (r.content || '') : r.content, r.kind === 'hpPrev' ? '(고치기 전)' : '', photo ? '(영수증 사진으로 정산 · 원본은 이 쪽)' : '', !photo && r.note ? '(' + r.note + ')' : ''].filter(Boolean).join(' '),
                size: 7.2, wrap: true, maxLines: 2, padX: 1.4 * MM },
              { w: W[4], t: r.trip || '', size: 7, wrap: true, maxLines: 2, padX: 1.2 * MM }
            ], { onBreak: brk, minH: 5 * MM });
          });
        } else {
          c.text('이 쪽 영수증은 이 문서 통행료 정산에 쓰지 않았습니다.', MX, c.y, { size: 8, color: 0.3, maxW: CW });
          c.y += 8 * LH;
        }
        c.y += 2.5 * MM;
        // 표가 길어 원본 자리가 너무 줄면(40% 미만) 원본 쪽을 다음 쪽에 통째로
        if (LIMIT - c.y < (LIMIT - MT) * 0.4) {
          c.newPage();
          c.text('하이패스 영수증 원본 — ' + f.name + ' ' + (j + 1) + '쪽', MX, c.y, { size: 9, bold: true });
          c.y += 9 * LH + 2 * MM;
        }
        var top = c.y, bh = LIMIT - top, sc = Math.min(CW / ep.width, bh / ep.height);
        var dw = ep.width * sc, dh = ep.height * sc, x = MX + (CW - dw) / 2, yb = c.ph - top - dh;
        c.page.drawPage(ep, { x: x, y: yb, width: dw, height: dh });
        c.page.drawRectangle({ x: x, y: yb, width: dw, height: dh, borderColor: c.gray(0.73), borderWidth: BW });
        c.y = LIMIT;
      });
    });
  }
  /** 여러 영수증을 한 번에 찍은 원본(통행료가 든 장) — 장마다 한 쪽: 위에 그 장의 줄 표 · 아래에 그 장 사진. */
  function drawTollSheets(c, sheets, imgs, meta, rowOfEv, subOnce) {
    sheets.forEach(function (g, si) {
      var sum = sumOf(g.lines, function (e) { return e.amount; });
      receiptHead(c, '통행료 — 여러 영수증을 한 번에 찍은 원본', meta, si + 1, sheets.length, '이 장 줄 합계 ' + won(sum), subOnce());
      g.pageNo = c.pdf.getPageCount();
      var W = [9 * MM, 13 * MM, 15 * MM, 17 * MM, CW - 104 * MM, 50 * MM];
      var th = function () { c.row(['번호', '구분', '날짜', '금액', '내용', '정산 · 붙은 운행'].map(function (h, i) { return ext({ w: W[i], t: h }, TV_HEAD); }), { minH: 5 * MM }); };
      var brk = function () { c.newPage(); th(); };
      th();
      g.lines.forEach(function (e, k) {
        var r = rowOfEv[String(e.id)];
        var st = e.cat === '통행료' ? settleText(r) : (photoOf(e) ? e.cat + ' 쪽에 사진' : e.cat + ' — 이 장');
        c.row([
          { w: W[0], t: String(k + 1), size: 7.6, align: 'center', bold: true },
          { w: W[1], t: e.cat || '', size: 7.4, align: 'center' },
          { w: W[2], t: mdOf(ymdK(e.ms)), size: 7.4, align: 'center' },
          { w: W[3], t: Number(e.amount) > 0 ? n0(e.amount) : '', size: 7.4, align: 'right', padX: 2 * MM },
          { w: W[4], t: e.memo || '', size: 7.4, wrap: true, maxLines: 2, padX: 1.6 * MM },
          { w: W[5], t: st, size: 7, wrap: true, maxLines: 2, padX: 1 * MM, color: r && r.excluded ? 0.45 : null }
        ], { onBreak: brk, minH: 5 * MM });
      });
      if (g.extra > 0) {
        c.y += 1.6 * MM;
        c.text('이 장에는 정산에 넣지 않은 영수증 ' + n0(g.extra) + '장도 보입니다.', MX, c.y, { size: 8.4, bold: true, maxW: CW });
        c.y += 8.4 * LH;
      }
      c.y += 3 * MM;
      if (LIMIT - c.y < (LIMIT - MT) * 0.4) {
        c.newPage();
        c.text('여러 영수증을 한 번에 찍은 원본 — ' + (si + 1) + '번째 장 사진', MX, c.y, { size: 9, bold: true });
        c.y += 9 * LH + 2 * MM;
      }
      drawPhoto(c, imgs[g.path], MX, c.y, CW, LIMIT - c.y);
      c.y = LIMIT;
    });
  }
  /** 낱장 통행료 사진 — 한 쪽에 위 표(그 쪽 사진들의 영수증) · 아래 사진 4장(2 × 2). 사진 번호 #k 는 이 묶음 차례. 머리 금액 = 정산한 것만. */
  function drawTollSingles(c, groups, imgs, meta, subOnce) {
    var per = 4, pages = Math.ceil(groups.length / per);
    var settled = sumOf([].concat.apply([], groups.map(function (g) { return g.rows; })), function (r) { return r.excluded ? 0 : r.amount; });
    groups.forEach(function (g, i) { g.no = i + 1; });
    for (var i = 0; i < groups.length; i += per) {
      var chunk = groups.slice(i, i + per);
      receiptHead(c, '통행료 — 영수증 사진', meta, i / per + 1, pages, '사진 ' + n0(groups.length) + '장 · 정산 ' + won(settled), subOnce());
      var W = [9 * MM, 24 * MM, 17 * MM, CW - 100 * MM, 50 * MM];
      var th = function () { c.row(['번호', '날짜·시각', '금액', '내용', '정산 · 붙은 운행'].map(function (h, k) { return ext({ w: W[k], t: h }, TV_HEAD); }), { minH: 5 * MM }); };
      var brk = function () { c.newPage(); th(); };
      th();
      chunk.forEach(function (g) {
        g.rows.forEach(function (r) {
          c.row([
            { w: W[0], t: '#' + g.no, size: 7.6, align: 'center', bold: true },
            { w: W[1], t: whenText(r), size: 7.4, align: 'center' },
            { w: W[2], t: n0(r.amount), size: 7.4, align: 'right', padX: 1.6 * MM },
            { w: W[3], t: r.content || '', size: 7.2, wrap: true, maxLines: 2, padX: 1.4 * MM },
            { w: W[4], t: settleText(r), size: 7, wrap: true, maxLines: 2, padX: 1 * MM, color: r.excluded ? 0.45 : null }
          ], { onBreak: brk, minH: 5 * MM });
        });
      });
      c.y += 3 * MM;
      // 표가 길어 사진 자리가 너무 줄면(40% 미만) 사진을 다음 쪽에
      if (LIMIT - c.y < (LIMIT - MT) * 0.4) {
        c.newPage();
        c.text('통행료 — 영수증 사진 (계속)', MX, c.y, { size: 9, bold: true });
        c.y += 9 * LH + 2 * MM;
      }
      var top = c.y, gap = 4 * MM, capH = 7.8 * LH + 1.2 * MM;
      var cw = (CW - gap) / 2, ch = (LIMIT - top - gap) / 2;
      chunk.forEach(function (g, k) {
        var cx = MX + (k % 2) * (cw + gap), cy = top + Math.floor(k / 2) * (ch + gap);
        var p = g.paths.filter(function (q) { return imgs[q]; })[0] || g.path;
        drawPhoto(c, imgs[p], cx, cy, cw, ch - capH);
        c.text('#' + g.no, cx + cw / 2, cy + ch - capH + 1 * MM, { size: 7.8, bold: true, align: 'center', color: 0.1 });
      });
      c.y = LIMIT;
    }
  }
  /**
   * 통행료 묶음 — 원본 쪽에 없는 하이패스 줄 → 하이패스 영수증 원본(PDF 쪽 + 표) → 여러 영수증을 한 번에 찍은 원본(사진 장 + 표) → 낱장 사진(표 + 사진).
   *   PDF 에 다 든 사진 원본 장·낱장 사진은 싣지 않는다(P.T — tollPlan, 사용자 「PDF만」). 사진을 싣지 않은 정산 영수증만 PDF 쪽 표에 함께 적는다(두 번 적지 않게).
   *   머리 대조 줄(표 통행료 = 하이패스 + 영수증 사진)과 정산에 넣지 않은 것 한 줄은 첫 쪽에만.
   */
  function drawTollPart(c, P, imgs, files, meta, fp) {
    var F = P.F, T = P.T || { ok: [], match: {}, dropSheet: {}, dropPhoto: {} }, rowOfEv = {}, okBy = {}, unplaced = [], onPdf = [];
    T.ok.forEach(function (f) { okBy[f.path] = f; });
    // 낱장 묶음은 같은 사진(fp — 결재본 사진 지문)끼리 묶여, 빠진 경로의 줄도 남는 묶음에 들 수 있다 — 그런 줄은 사진 쪽에 남으니 PDF 쪽 표에 또 적지 않는다(2026-10-23 검토)
    var singles = singleGroups(F, fp, T.dropPhoto), shown = {};
    singles.forEach(function (g) { g.rows.forEach(function (r) { shown[String(r.ev)] = 1; }); });
    var dropped = function (r) { return r.kind === 'scan' ? !!T.dropSheet[r.e.scan] : !!(r.photo && T.dropPhoto[r.photo]) && !shown[String(r.ev)]; };
    F.days.forEach(function (d) {
      d.rows.forEach(function (r) {
        if (r.ev != null) rowOfEv[String(r.ev)] = r;
        if (r.kind === 'hp' || r.kind === 'hpPrev') {
          if (r.pdf && okBy[r.pdf]) { onPdf.push(ext(r, { pdfPath: r.pdf })); return; }
          var fb = r.pdf ? files.by[r.pdf] : null;
          var st = r.pdf ? (fb && fb.bad === 'sha' ? '원본 지문 다름' : fb && (fb.bad === 'name' || fb.bad === 'owner') ? '원본 확인 안 됨' : '원본 못 받음')
            : r.noOrig ? '원본 없음' : r.unk ? '확인 못 함' : '—';
          unplaced.push({ r: r, st: st, bad: !!r.pdf || !!r.noOrig });
        } else if (r.kind === 'hpNone') unplaced.push({ r: r, st: r.noOrig ? '원본 없음' : '—', bad: !!r.noOrig });
        else if (r.kind === 'hpMiss') unplaced.push({ r: r, st: r.unk ? '확인 못 함' : '줄 못 받음', bad: false });
        else if (r.kind === 'hpStale') unplaced.push({ r: r, st: '줄 생략', bad: false });
        else if (tollPhotoRow(r) && !r.excluded && dropped(r)) {
          // 사진을 싣지 않는 정산 영수증 — 그 PDF 쪽 표에 함께(사진이 남는 영수증은 사진 쪽에만 — 두 번 적지 않는다)
          var m = T.match[String(r.e.id)];
          if (m) onPdf.push(ext(r, { pdfPath: m.f.path, page: m.page }));
        }
      });
    });
    var sheets = P.S.pages.filter(function (g) { return g.lines.some(function (e) { return e.cat === '통행료'; }) && !T.dropSheet[g.path]; });
    if (!F.show && !sheets.length && !T.ok.length && !singles.length) return;
    var H0 = F.head, ex = [H0.noTripN ? '업무 운행 없는 날 영수증 사진 ' + n0(H0.noTripN) + '장 ' + n0(H0.noTrip) + '원' : '',
      H0.dupN ? '하이패스와 같은 영수증 사진 ' + n0(H0.dupN) + '장 ' + n0(H0.dup) + '원(한 번만 셈)' : '',
      F.nZero ? '금액 0원 영수증 사진 ' + n0(F.nZero) + '장' : ''].filter(Boolean);
    var first = true;
    var subOnce = function () { var s = first ? [H0.text, ex.length ? '정산에 넣지 않은 것 — ' + ex.join(' · ') : ''] : ''; first = false; return s; };
    if (unplaced.length) drawUnplaced(c, unplaced, meta, subOnce());
    if (T.ok.length) drawHipassSheets(c, T.ok, onPdf, meta, subOnce, F.lateN ? lateNote(F.lateN, F.lateDoneN || 0) : '');
    if (sheets.length) drawTollSheets(c, sheets, imgs, meta, rowOfEv, subOnce);
    if (singles.length) drawTollSingles(c, singles, imgs, meta, subOnce);
    if (first) {
      receiptHead(c, '통행료', meta, 1, 1, '', subOnce());
      c.text('이 기간 통행료 영수증이 없습니다.', MX, c.y, { size: 9 });
      c.y = LIMIT;
    }
  }

  // ─────────────────────────── 쪽 번호 · 문서 상태 표시 ───────────────────────────
  /**
   * 결재가 끝나지 않은 문서는 쪽마다 상태를 찍는다. meta.mark:
   *   preview   상신 전, 지금 자료로 만든 미리보기
   *   pending   상신해서 결재가 진행 중(결재자가 보는 문서) — '초안'이 아니다
   *   rejected · withdrawn   반려됐거나 회수한 상신 건
   *   (없음)    결재 완료본 — 아무것도 찍지 않는다
   */
  var MARKS = {
    preview: ['미리보기', '상신 전 미리보기입니다 — 제출용이 아닙니다'],
    pending: ['결재 중', '결재가 진행 중인 문서입니다 — 결재 완료본이 아닙니다'],
    rejected: ['반려', '반려된 문서입니다 — 제출용이 아닙니다'],
    withdrawn: ['회수', '회수한 문서입니다 — 제출용이 아닙니다']
  };
  function finishPages(c, meta) {
    var pages = c.pdf.getPages(), n = pages.length;
    var deg = c.lib.degrees;
    var mk = MARKS[meta.mark] || (meta.draft ? MARKS.preview : null);
    pages.forEach(function (pg, i) {
      c.page = pg;
      // 쪽마다 크기가 다를 수 있다(법인카드 = 가로 + 검증 쪽은 세로, 2026-10-09). 세로 쪽은 예전과 같은 값이 나온다.
      var sz = pg.getSize(), pw = sz.width, ph = sz.height, cw = pw - 2 * MX;
      c.geo(pw, ph, ph - MB);
      var fy = ph - 10.5 * MM;
      pg.drawLine({ start: { x: MX, y: ph - fy }, end: { x: MX + cw, y: ph - fy }, thickness: 0.3, color: c.gray(0.6) });
      var ty = fy + 1.2 * MM;
      c.text([meta.name, meta.cycleName].filter(Boolean).join(' · '), MX, ty, { size: 8, color: 0.3, maxW: cw * 0.3 });
      c.text(meta.docNo || '', MX + cw / 2, ty, { size: 8, color: 0.3, align: 'center', maxW: cw * 0.5 });
      c.text((i + 1) + ' / ' + n, MX + cw, ty, { size: 8, color: 0.3, align: 'right' });
      if (mk) {
        var s = mk[0], size = Array.from(s).length >= 4 ? 104 : 120, f = c.fB;
        var tw = f.widthOfTextAtSize(s, size), th = size * 0.72, a = 32 * Math.PI / 180;
        var cx = pw / 2, cy = ph / 2;
        // 0.07 은 영수증 사진 위에서 거의 안 보였다 — 사진 쪽에서도 읽히게 조금 진하게.
        pg.drawText(s, {
          x: cx - (tw / 2 * Math.cos(a) - th / 2 * Math.sin(a)),
          y: cy - (tw / 2 * Math.sin(a) + th / 2 * Math.cos(a)),
          size: size, font: f, color: c.gray(0), opacity: 0.12, rotate: deg(32)
        });
        c.text(mk[1], MX + cw / 2, 4.2 * MM, { size: 7.5, align: 'center', color: 0.3 });
      }
    });
    return n;
  }

  // ─────────────────────────── 조립 ───────────────────────────
  /**
   * doc = {
   *   meta:   { name, cycleName, docNo, mark, closedAt },   // mark: 'preview' | 'pending' | 'rejected' | 'withdrawn' | ''(완료본)
   *           closedAt: 결재 완료 시각(ISO, 결재 완료본만) — 상신 뒤 덧붙인 하이패스 원본이 결재 완료 뒤인지 가른다(2026-10-23)
   *   sheets: [ sheetDataFor() 결과 + { boxes: { 담당:{name,date}, 팀장:{…} } } ],   // 차량 1대 = 1장
   *   verify: { ranAt, ai, summary:{bad,warn,info,receipts,read}, items:[{level,title,detail}] } | null,
   *   scans:  [ { path, items:[{category,date,amount,memo}] } ],                      // A4 스캔 원본(ev 가 없는 옛 재료)
   *   photos: [ { path, category, date, amount, plate, memo } ],                      // 낱장 사진(ev 가 없는 옛 재료)
   *   ev:     근거 재료(2026-10-23 — 위 「통행료 근거 · 증빙 차례 · 부록」). 있으면 scans·photos 대신 이것으로 그린다:
   *           운행기록부 → 통행료 근거 → 검증 결과 → 통행료 영수증 → 주차 → 주유 → 계기판 → 원본 장 부록 → 하이패스 원본 부록
   * }
   * deps.loadFile(path) → Promise<Uint8Array|null> — 하이패스 영수증 원본 PDF(하이패스 줄의 pdf 경로). 못 받으면 issues 'hipass'.
   * 돌려주는 것에 parts = [{ part, from, to }](쪽 범위 — 시험·안내용)도 있다.
   */
  function build(doc, deps) {
    var lib = deps.PDFLib, c, imgs = {}, hashes = {}, files = [];
    var meta = doc.meta || {};
    var P = doc.ev ? planOf(doc) : null;
    files.by = {};
    return lib.PDFDocument.create().then(function (pdf) {
      pdf.registerFontkit(deps.fontkit);
      pdf.setTitle('차량운행내역기록부 ' + (meta.name || '') + ' ' + (meta.cycleName || ''));
      pdf.setAuthor('ATEC Driving');
      pdf.setProducer('ATEC Driving sheetpdf');
      // ★ subset:true 를 쓰지 말 것. 나눔고딕의 한글은 합성 글리프(자모 조각을 참조)라
      //   pdf-lib 의 부분 내장이 조각을 빠뜨려 글자가 통째로 사라진다
      //   (2026-10-01 실측: "차량운행내역기록부" → "역기록부", "701,788" → "7   788").
      //   통째로 넣으면 파일이 1.6MB 쯤 커지지만 글자가 빠지지 않는다.
      return Promise.all([
        pdf.embedFont(deps.fontRegular, { subset: false }),
        pdf.embedFont(deps.fontBold, { subset: false })
      ]).then(function (f) { c = new Ctx(pdf, lib, f[0], f[1], doc); return pdf; });
    }).then(function (pdf) {
      // 하이패스 영수증 원본(하이패스 줄의 pdf 경로 — 2026-10-23 부터 올린 파일을 보관한다). 하나씩 받아 쪽을 넣어 둔다.
      //   사진보다 먼저 받는다 — 그 PDF 의 영수증을 읽어야 어떤 통행료 사진이 빠지는지 알고(tollPlan), 빠질 사진은 받지도 넣지도 않는다(2026-10-23 검토).
      // ★ 보안(2026-10-23 서버 약속): 하이패스 줄은 앱 키로도 고칠 수 있어 남의 경로를 근거에 끼울 수 있다 — 그래서
      //   ① 경로가 약속 꼴(<아이디>/hipass/<시각>-<SHA-256 앞 16자>.pdf)이고 ② 이 문서 주인 폴더이며 ③ 받은 바이트의 SHA-256 앞 16자가
      //   이름의 지문과 같을 때만 싣는다. 아니면 싣지 않고 issues 'hipass'(결과 창 「확인 필요」)에 「원본 지문이 맞지 않음」 등.
      //   상신 뒤 덧붙인 원본(P.F.late — 지금 자료에서 받은 경로)도 똑같이 본다. 덧붙인 것이면 부록 머리에 그 표시(lateText).
      if (!P || !P.F.pdfs.length) return pdf;
      var owner = (doc.ev && doc.ev.user) || '';
      P.F.pdfs.forEach(function (p) {
        var f = { path: p, name: String(p).split('/').pop(), pages: null, start: 0, bad: '', late: !!P.F.late[p] };
        f.lateText = f.late ? lateText(p, meta) : '';
        f.lateDone = f.late && lateDone(p, meta);          // 「결재 완료 뒤 덧붙임」 — 「통행료 근거」 안내도 같은 말로(lateNote)
        files.push(f); files.by[p] = f;
      });
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          var nm = hipassName(f.path);
          if (!nm) { f.bad = 'name'; c.issue('hipass', '하이패스 영수증 원본 이름에 지문이 없음 — 싣지 않음: ' + f.path); return; }
          if (owner && nm.owner !== owner) { f.bad = 'owner'; c.issue('hipass', '하이패스 영수증 원본이 이 문서 주인의 폴더가 아님 — 싣지 않음: ' + f.path); return; }
          return Promise.resolve(deps.loadFile ? deps.loadFile(f.path) : null).then(function (bytes) {
            var head = bytes && bytes.length ? String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, 0, Math.min(1024, bytes.length))) : '';
            if (head.indexOf('%PDF-') < 0) { f.bad = 'load'; c.issue('hipass', '하이패스 영수증 원본을 불러오지 못함: ' + f.path); return; }
            return sha256hex(bytes).then(function (hex) {
              if (!hex || hex.slice(0, 16) !== nm.sha16) { f.bad = 'sha'; c.issue('hipass', '하이패스 영수증 원본 지문이 맞지 않음 — 싣지 않음: ' + f.path); return; }
              return lib.PDFDocument.load(bytes, { ignoreEncryption: true })
                .then(function (src) { return pdf.embedPdf(src, src.getPageIndices()); })
                .then(function (eps) { f.pages = eps; })
                // 그 PDF 의 영수증 목록(웹 hipass.js 해석기 — deps.parseHipass) — 사진 영수증이 이 PDF 에 있는지 맞춘다(tollMatch, 「PDF만」 2026-10-23).
                //   맞출 사진(메모가 있는 통행료 사진)이 없으면 읽지 않는다. 못 읽으면 f.recs = null — 사진을 빼지 않는다(닫힌 쪽).
                .then(function () {
                  if (!deps.parseHipass || !needRecs(P.F)) return;
                  return Promise.resolve().then(function () { return deps.parseHipass(bytes.slice()); }).then(function (recs) { f.recs = Array.isArray(recs) ? recs : null; }, function () { f.recs = null; });
                });
            });
          });
        }).catch(function (e) { f.bad = f.bad || 'load'; c.issue('hipass', '하이패스 영수증 원본을 넣지 못함: ' + f.path + ' (' + (e && e.message || e) + ')'); });
      });
      return chain.then(function () { return pdf; });
    }).then(function (pdf) {
      // 사진을 먼저 다 불러온다(그리는 중에 기다리지 않게). 같은 경로는 한 번만.
      //   근거 재료(ev)면 실을 사진만(계기판은 차마다 마지막 한 장 · 오린 사진 · 원본 장) — planOf.
      //   통행료 묶음 계획(tollPlan) — PDF 에 다 든 사진 원본 장·낱장 사진은 받지 않는다.
      if (P) P.T = tollPlan(P, files);
      var paths = P ? P.paths.filter(function (p) { return !P.T.dropSheet[p] && !P.T.dropPhoto[p]; }) : imagePaths(doc);
      // 받기는 넷씩 함께(사진 30장을 하나씩 받으면 한참 걸린다), PDF 에 넣기는 받은 순서와 무관하게 하나씩.
      var one = function (p) {
        return Promise.resolve().then(function () { return deps.loadImage ? deps.loadImage(p) : null; })
          .then(function (bytes) {
            if (!bytes || !bytes.length) { c.issue('image', '사진을 불러오지 못함: ' + p); return; }
            var isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
            var isJpg = bytes[0] === 0xFF && bytes[1] === 0xD8;
            if (!isPng && !isJpg) { c.issue('image', 'JPEG·PNG 가 아닌 사진: ' + p); return; }
            hashes[p] = fnv(bytes);                 // 같은 사진 가르기(경로가 달라도 내용이 같으면 한 번만 싣는다)
            return (isPng ? pdf.embedPng(bytes) : pdf.embedJpg(bytes)).then(function (img) {
              imgs[p] = { img: img, orient: isJpg ? exifOrientation(bytes) : 1 };
            });
          }).catch(function (e) { c.issue('image', '사진 처리 실패: ' + p + ' (' + (e && e.message || e) + ')'); });
      };
      var next = 0;
      var worker = function () {
        if (next >= paths.length) return Promise.resolve();
        return one(paths[next++]).then(worker);
      };
      var ws = [];
      for (var w = 0; w < Math.min(4, paths.length); w++) ws.push(worker());
      return Promise.all(ws).then(function () { return pdf; });
    }).then(function (pdf) {
      // 결재란 서명 그림(PNG data URL) — 같은 그림은 한 번만 넣는다.
      c.signs = {};
      var urls = [];
      (doc.sheets || []).forEach(function (sh) {
        Object.keys(sh.boxes || {}).forEach(function (k) {
          var v = sh.boxes[k];
          if (v && v.sign && urls.indexOf(v.sign) < 0) urls.push(v.sign);
        });
      });
      return Promise.all(urls.map(function (u) {
        var m = /^data:image\/png;base64,(.+)$/.exec(u);
        if (!m) return null;
        var bin = atob(m[1]), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return pdf.embedPng(bytes).then(function (img) { c.signs[u] = img; },
          function () { c.issue('image', '서명 그림을 넣지 못함'); });
      })).then(function () { return pdf; });
    }).then(function (pdf) {
      var totals = [], parts = [];
      var part = function (name, fn) {
        var from = pdf.getPageCount() + 1;
        fn();
        if (pdf.getPageCount() >= from) parts.push({ part: name, from: from, to: pdf.getPageCount() });
      };
      part('운행기록부', function () { (doc.sheets || []).forEach(function (sh) { totals.push(drawSheet(c, sh)); }); });
      if (P) {
        var ev = doc.ev;
        var miss = (ev.trips || []).filter(function (t) { return t.hp > 0 && t.line === 'nofetch'; }).length;
        if (miss) c.issue('hipass', '하이패스 영수증 줄을 받지 못한 운행 ' + miss + '건');
        // 인쇄 준비가 지금 운행을 받지 못해 원본이 있는지 확인하지 못한 운행(10월분부터 — 2026-10-23 검토: 관리자가 아닌 결재자는 남의 운행을
        //   읽지 못해 빈 목록을 받는다. 예전에는 조용히 「원본 없음」이라 적었다) → 결과 창 「확인 필요」
        if (P.F.nUnkTrip) c.issue('hipass', '하이패스 영수증 원본을 확인하지 못한 운행 ' + P.F.nUnkTrip + '건');
        // 원본 PDF 가 없는 하이패스 줄(금액 0 줄은 빼고 · 10월분부터 — 2026-10-23 관리자 「영수증은 없고 내역만 있으면 안 된다」) → 결과 창 「확인 필요」
        if (P.F.nNoOrig) c.issue('hipass', '하이패스 영수증 원본 없음 ' + P.F.nNoOrig + '줄');
        // 부록에 실은 원본 중 상신 뒤 덧붙인 것의 수 · 그중 결재 완료 뒤 — 「통행료 근거」 안내 줄(부록 머리 표시와 같은 말)
        var lateF = files.filter(function (f) { return f.late && f.pages && f.pages.length; });
        P.F.lateN = lateF.length;
        P.F.lateDoneN = lateF.filter(function (f) { return f.lateDone; }).length;
        // 같은 사진(경로 · 결재본 사진 지문 · 받은 바이트)은 한 번만 — 받은 뒤에 가른다
        var fp = samePhotoFn(P.paths, ev.photoMeta || null, hashes);
        var secs = photoSections(ev, P.F, fp);
        var scanAt = function (id) { var p = P.S.pos[String(id)]; return p && p.g.pageNo ? '원본 장 ' + p.g.pageNo + '쪽 ' + p.k + '번째' : '원본 장'; };
        var refs = {
          scan: scanAt,
          scanBox: function (id) { return '여러 영수증을 한 번에 찍은 장의 영수증입니다(오린 사진 없음) — ' + scanAt(id); }
        };
        // 차례(2026-10-23 관리자) = 운행기록부 → (검증 결과) → 통행료(표 + 원본) → 주차 → 주유 → 계기판. 「통행료 근거」 쪽·통행료 4장씩 쪽은 없다.
        if (doc.verify) part('검증 결과', function () { drawVerify(c, doc.verify, meta); });
        part('통행료', function () { drawTollPart(c, P, imgs, files, meta, fp); });
        // 통행료가 없는 원본 장(주차·주유를 한 번에 찍은 장)은 그 장 첫 줄 구분 묶음 바로 뒤에 표 + 원본 — 계기판이 맨 끝
        var rest = P.S.pages.filter(function (g) { return !g.lines.some(function (e) { return e.cat === '통행료'; }); }), placed = [];
        secs = secs.filter(function (s) { return s.cat !== '통행료' && s.cat !== '계기판'; }).concat(secs.filter(function (s) { return s.cat === '계기판'; }));
        secs.forEach(function (s) {
          part(s.title, function () { drawSection(c, s, imgs, meta, refs); });
          var mine = rest.filter(function (g) { return g.lines[0] && g.lines[0].cat === s.cat; });
          if (mine.length) { placed = placed.concat(mine); part('여러 영수증을 한 번에 찍은 원본', function () { drawScanPages(c, { pages: mine }, imgs, meta, {}); }); }
        });
        var left = rest.filter(function (g) { return placed.indexOf(g) < 0; });
        if (left.length) part('여러 영수증을 한 번에 찍은 원본', function () { drawScanPages(c, { pages: left }, imgs, meta, {}); });
        c.fillLater();
      } else {
        if (doc.verify) drawVerify(c, doc.verify, meta);
        if ((doc.scans || []).length) drawScans(c, doc.scans, imgs, meta);
        if ((doc.photos || []).length) drawPhotos(c, doc.photos, imgs, meta);
      }
      if (!pdf.getPageCount()) { c.newPage(); c.text('내용이 없습니다.', MX, c.y, { size: 10 }); }
      var n = finishPages(c, meta);
      return pdf.save().then(function (bytes) {
        return { bytes: bytes, pages: n, issues: c.issues, stats: c.stats, totals: totals, parts: parts };
      });
    });
  }

  // ─────────────────────────── 개인경비 지출 명세 (2026-10-07) ───────────────────────────
  /* 사용자 양식(docs/expense/개인경비 지출명세서_양식.xlsx)과 같은 짜임:
       제목 「개인경비 지출 명세」 · 부서·이름 · 결재란(운행기록부와 같은 5칸)
       표 = 순번 · 날짜 · 사용처 · 금액 · 사용내역 · 비고, <소모품비>·<식비>·<기타비용> 묶음마다 줄·소계, 합계
       「* 해당 증빙은 명세서 기재순으로 별첨」 → 증빙 쪽(영수증 2×2, 명세 순서, 사진마다 날짜·구분·금액·사용처·사용내역)
     doc = { meta, person:{dept,name}, periodLabel, boxes, verify,
             items:[{ date, category, merchant, amount, usage, note, path }] }   ← 이미 명세 순서(구분 → 날짜)로 정렬해 넘긴다 */
  var X_CATS = ['소모품비', '식비', '기타비용'];
  /* 양식을 엑셀에서 인쇄한 모습(A4 세로, 폭에 맞춤)을 그대로 옮긴다 — 엑셀 시트의 pt 값 × XK.
     열(pt): 순번 34.5 · 날짜 112.5 · 사용처 121.5 · 금액 121.5 · 사용내역 186.75 · 비고 134.25 (양식 열 폭 5.75·18.75·20.25·20.25·31.125·22.375)
     XK = 양식 인쇄본의 표 폭 522.6pt ÷ 시트 표 폭 711pt. 표 왼쪽 = MX.
     결재란은 양식 그림 자리(오른쪽 위, 표 오른쪽 끝을 조금 넘는다) — 「결 재」 세로 칸 + 5칸(머리 + 서명 자리).
     엑셀(drv-expense.js xlsxBytes)도 같은 자리·크기다: 시트 x 468 에서 시작, 칸 26.25 + 51.75 × 5, 머리 22 · 서명 50
     (양식 그림은 4칸 248pt 이지만 우리는 5칸이라 칸을 조금 좁히고 왼쪽으로 조금 늘였다 — 제목에 닿지 않는 데까지). */
  var XK = 0.735;
  var XCOLS = [34.5, 112.5, 121.5, 121.5, 186.75, 134.25].map(function (w) { return w * XK; });
  var XTW = XCOLS.reduce(function (a, b) { return a + b; }, 0);       // 표 폭(약 522.6pt)
  var XBLUE = [155 / 255, 194 / 255, 230 / 255], XYELLOW = [1, 1, 153 / 255];   // 양식 #9BC2E6 · #FFFF99
  var XFS = 12 * XK;                                                   // 표 글자(양식 12pt)
  var XHEAD = ['순번', '날 짜', '사용처', '금액', '사용내역', '비고'];
  /** 구분별 묶음. 세 구분은 늘 이 순서로 나온다(비어 있어도). 모르는 구분은 기타비용에 넣는다. */
  function expenseGroups(items) {
    var gs = X_CATS.map(function (cat) { return { cat: cat, list: [], sum: 0 }; });
    (items || []).forEach(function (it) {
      var i = X_CATS.indexOf(it.category); gs[i < 0 ? 2 : i].list.push(it);
    });
    // ★ 줄마다 원 단위로 반올림한 값을 더한다 — 표에 보이는 금액의 합 = 소계·합계(엑셀 xlsxBytes 와 같은 규칙).
    gs.forEach(function (g) { g.sum = g.list.reduce(function (s, it) { return s + Math.round(Number(it.amount) || 0); }, 0); });
    return gs;
  }
  /** 양식의 회계 서식처럼 — 0 은 「-」. */
  function acc(n) { var v = Math.round(Number(n) || 0); return v === 0 ? '-' : n0(v); }
  function drawExpense(c, d) {
    var gs = expenseGroups(d.items), total = gs.reduce(function (s, g) { return s + g.sum; }, 0);
    var p = d.person || {};
    var X0 = MX, sx = function (v) { return X0 + (v - 21) * XK; };   // 시트 x(pt, A열 폭 21 포함) → 쪽 x
    var rowH = 28.5 * XK;                                              // 양식 표 행 높이 28.5
    c.newPage();
    var y0 = MT - 3;                                                   // 시트 1행 위

    // ── 결재란 — 양식 그림 자리(오른쪽 위). 흰 바탕, 「결 재」 세로 칸, 머리 줄 + 서명 자리 ──
    var bx = sx(468), btop = y0 + 6 * XK, bg = { labW: 26.25 * XK, boxW: 51.75 * XK, hdH: 22 * XK, sgH: 50 * XK, fill: null, size: 10 * XK, hpadX: 0.4 * MM, label: ['결', '', '재'] };
    c.bw = 0.6;                                                        // 양식 인쇄본의 가는 선
    drawBoxes(c, bx, btop, d.boxes, bg, d.boxLabels);
    // 양식 결재란은 바깥 테두리만 굵다.
    c.page.drawRectangle({ x: bx, y: PH - btop - bg.hdH - bg.sgH, width: bg.labW + 5 * bg.boxW, height: bg.hdH + bg.sgH, borderColor: c.black, borderWidth: 1.2 });

    // ── 제목 — 맑은 고딕 22 굵게·밑줄, 표 가운데(결재란에 닿으면 왼쪽으로 민다) ──
    var TS = 22 * XK, title = '개인경비 지출 명세', tw = c.w(title, TS, true);
    var tcx = Math.min(X0 + XTW / 2, bx - 3 * MM - tw / 2);
    var tTop = y0 + 42 * XK - TS * 0.45;
    c.text(title, tcx, tTop, { size: TS, bold: true, align: 'center' });
    var uy = tTop + TS * 1.0;
    c.page.drawLine({ start: { x: tcx - tw / 2, y: PH - uy }, end: { x: tcx + tw / 2, y: PH - uy }, thickness: 0.9, color: c.black });

    // ── 기간 — 양식에는 없는 줄. 어느 기간 문서인지 밝혀 둔다(띠 바로 위 왼쪽, 작게) ──
    var bandTop = y0 + 118.5 * XK;
    if (d.periodLabel) c.text(d.periodLabel, X0 + 0.5 * MM, bandTop - 8 * 1.2 - 1.5, { size: 8, color: 0.25, maxW: bx - X0 - 4 * MM });

    // ── 부서·이름 띠 — 파랑 한 줄(칸 사이 세로줄 없음), 글자는 사용내역·비고 위 가운데 굵게 ──
    c.y = bandTop;
    c.cell(X0, c.y, XTW, rowH, { t: '', fill: XBLUE });
    var fg = XCOLS[4] + XCOLS[5], fx = X0 + XTW - fg;
    var bandTxt = '부서 :  ' + (p.dept || '') + '          이름 :  ' + (p.name || '');
    var bs = XFS, bw0 = c.w(c.clean(bandTxt), bs, true);
    while (bw0 > XTW - 4 * MM && bs > 6) { bs = Math.max(6, bs - 0.2); bw0 = c.w(c.clean(bandTxt), bs, true); }
    if (bw0 > XTW - 4 * MM) c.issue('overflow', '부서·이름 띠가 넘침');
    var btx = bw0 <= fg - 2 * MM ? fx + (fg - bw0) / 2 : X0 + XTW - 2 * MM - bw0;   // 길면 오른쪽 끝에 맞춰 왼쪽으로 늘인다
    c.text(bandTxt, btx, c.y + rowH / 2 - bs * 0.5, { size: bs, bold: true });
    c.y += rowH;

    // ── 표 ──
    var head = function () {
      c.row(XHEAD.map(function (h, i) { return { w: XCOLS[i], t: h, size: XFS, bold: true, align: 'center', fill: XYELLOW }; }), { minH: rowH });
    };
    // 다음 쪽 — 머리글 위에 「(계속) · 이름 · 기간」 작은 줄, 그리고 엑셀 인쇄 제목 행처럼 머리글 줄을 되풀이한다.
    var brk = function () {
      c.newPage();
      c.text('개인경비 지출 명세 (계속)  ·  ' + [p.name, d.periodLabel].filter(Boolean).join('  ·  '), X0 + 0.5 * MM, c.y, { size: 7.6, color: 0.3, maxW: XTW - 1 * MM });
      c.y += 7.6 * LH + 1.2 * MM;
      head();
    };
    var span = function (a, b) { var s = 0; for (var i = a; i <= b; i++) s += XCOLS[i]; return s; };
    var itemCells = function (it, k) {
      if (!it) return XCOLS.map(function (w) { return { w: w, t: '' }; });
      return [
        { w: XCOLS[0], t: String(k + 1), size: XFS, align: 'center' },
        { w: XCOLS[1], t: it.date || '', size: 11 * XK, align: 'center' },
        { w: XCOLS[2], t: it.merchant || '', size: XFS, align: 'center', wrap: true, maxLines: 3, padX: 1.4 * MM },
        { w: XCOLS[3], t: acc(it.amount), size: XFS, align: 'right', padX: 2 * MM },
        { w: XCOLS[4], t: it.usage || '', size: XFS, align: 'center', wrap: true, maxLines: 4, padX: 1.4 * MM },
        { w: XCOLS[5], t: it.note || '', size: XFS, align: 'center', wrap: true, maxLines: 3, padX: 1.4 * MM }
      ];
    };
    var footH = rowH + 0.8 * MM + XFS * LH;            // 합계 줄 + 별첨 문구
    head();
    gs.forEach(function (g, gi) {
      var gh = [{ w: XTW, t: '<' + g.cat + '>', size: XFS, align: 'center' }];
      var rows = g.list.length ? g.list : [null];
      var tail = rowH + (gi === gs.length - 1 ? footH : 0);   // 소계(+ 마지막 묶음이면 합계·별첨)
      // 묶음 머리가 쪽 끝에 홀로 남지 않게 — 첫 줄과 같이 넘긴다. 줄이 0~1건이면 첫 줄이 곧 마지막 줄이라
      // 소계(·합계·별첨)까지 한 쪽에 들어가야 한다(안 그러면 머리 + 줄만 남고 소계가 다음 쪽 머리에 홀로 간다).
      if (c.y + c.rowHeight(gh, rowH) + c.rowHeight(itemCells(rows[0], 0), rowH) + (rows.length <= 1 ? tail : 0) > LIMIT + 0.01) brk();
      c.row(gh, { onBreak: brk, minH: rowH });
      rows.forEach(function (it, k) {
        var cells = itemCells(it, k);
        // 묶음의 마지막 줄은 소계와 같은 쪽에 — 소계(·합계)만 다음 쪽에 덩그러니 남지 않게 데리고 넘어간다.
        if (k === rows.length - 1 && c.y + c.rowHeight(cells, rowH) + tail > LIMIT + 0.01) brk();
        c.row(cells, { onBreak: brk, minH: rowH });
      });
      if (c.y + tail > LIMIT + 0.01) brk();
      c.row([
        { w: XCOLS[0], t: '' }, { w: XCOLS[1], t: '' },
        { w: XCOLS[2], t: '소계', size: XFS, align: 'center' },
        { w: XCOLS[3], t: acc(g.sum), size: XFS, align: 'right', padX: 2 * MM },
        { w: XCOLS[4], t: '' }, { w: XCOLS[5], t: '' }
      ], { onBreak: brk, minH: rowH });
    });
    if (c.y + footH > LIMIT + 0.01) brk();
    c.row([
      { w: span(0, 2), t: '합계', size: XFS, bold: true, align: 'center', fill: XBLUE },
      { w: XCOLS[3], t: acc(total), size: XFS, bold: true, align: 'right', padX: 2 * MM, fill: XBLUE },
      { w: XCOLS[4], t: '', fill: XBLUE }, { w: XCOLS[5], t: '', fill: XBLUE }
    ], { minH: rowH });
    c.y += 0.8 * MM;
    c.text('* 해당 증빙은 명세서 기재순으로 별첨', X0 + 0.5 * MM, c.y, { size: XFS });
    c.y += XFS * LH;
    c.bw = null;
    return { all: total, groups: gs.map(function (g) { return { cat: g.cat, n: g.list.length, sum: g.sum }; }) };
  }
  /** 증빙 쪽 머리 — 양식 둘째 쪽의 「< 개인경비 증빙 >」(굵게, 왼쪽)과 안내 문구. 오른쪽엔 이 쪽 금액·쪽 번호. */
  function expenseReceiptHead(c, pageNo, pageCnt, sumText) {
    c.newPage();
    var hs = XFS + 1;
    c.text('< 개인경비 증빙 >', MX + 0.5 * MM, c.y, { size: hs, bold: true });
    c.text((sumText ? sumText + '    ' : '') + pageNo + ' / ' + pageCnt, MX + CW, c.y + 0.6, { size: 8.5, align: 'right', bold: !!sumText, maxW: CW * 0.6 });
    c.y += hs * LH + 0.4 * MM;
    c.text('* 영수증은 명세서 기재순(최초 날짜부터 차례로)으로 첨부', MX + 0.5 * MM, c.y, { size: XFS - 0.6 });
    c.y += (XFS - 0.6) * LH + 2.6 * MM;
  }
  /** 명세 번호 — 「식비 1」처럼 구분 + 그 구분 안의 순번. 명세 표의 순번 칸과 같은 수(사진이 없는 줄도 센다). */
  function expenseLabels(items) {
    var lab = new Map();
    expenseGroups(items).forEach(function (g) { g.list.forEach(function (it, k) { lab.set(it, g.cat + ' ' + (k + 1)); }); });
    return lab;
  }
  /** 한 줄에 맞춘다 — size 에서 minSize(읽을 수 있는 크기)까지만 줄이고, 그래도 넘치면 끝을 「…」로 자른다. */
  function fitLine(c, s, size, bold, maxW, minSize) {
    s = c.clean(s);
    while (c.w(s, size, bold) > maxW && size > minSize) size = Math.max(minSize, size - 0.2);
    if (c.w(s, size, bold) <= maxW) return { t: s, size: size, cut: false };
    var ell = c.has('…') ? '…' : '...', ch = Array.from(s);
    while (ch.length && c.w(ch.join('') + ell, size, bold) > maxW) ch.pop();
    return { t: ch.join('').replace(/\s+$/, '') + ell, size: size, cut: true };
  }
  /** 증빙 — 영수증 사진 한 쪽에 넷(2×2), 명세 순서.
   *  사진 아래 첫 줄은 늘 다 보인다: 「식비 1 · 2026-10-03 · 27,000원」(명세의 구분·순번과 같은 번호).
   *  둘째 줄 「사용처 · 사용내역」은 길면 「…」로 줄이고, 줄인 것은 자체 점검(issues kind 'cut')에 남긴다. 7pt 아래로는 줄이지 않는다. */
  function drawExpensePhotos(c, items, imgs, meta) {
    var labs = expenseLabels(items);
    var list = [];
    expenseGroups(items).forEach(function (g) { g.list.forEach(function (it) { if (it.path) list.push(it); }); });
    if (!list.length) return;
    var per = 4, pages = Math.ceil(list.length / per);
    var addR = function (s, e) { return s + Math.round(Number(e.amount) || 0); };   // 명세와 같게 줄마다 반올림
    var all = list.reduce(addR, 0);
    for (var i = 0; i < list.length; i += per) {
      var chunk = list.slice(i, i + per);
      var sum = chunk.reduce(addR, 0);
      expenseReceiptHead(c, i / per + 1, pages,
        pages > 1 ? '이 쪽 소계 ' + won(sum) + ' · 전체 ' + n0(list.length) + '건 ' + won(all) : '합계 ' + n0(list.length) + '건 ' + won(all));
      var S1 = 8.2, S2 = 7.6, MIN = 7;
      var top = c.y, gap = 4 * MM, capH = (S1 + S2) * LH + 1.6 * MM;
      var cw = (CW - gap) / 2, ch = (LIMIT - top - gap) / 2;
      chunk.forEach(function (e, k) {
        var cx = MX + (k % 2) * (cw + gap), cy = top + Math.floor(k / 2) * (ch + gap);
        drawPhoto(c, imgs[e.path], cx, cy, cw, ch - capH);
        var no = labs.get(e) || (e.category || '');
        var l1 = fitLine(c, [no, e.date || '', n0(e.amount) + '원'].filter(Boolean).join(' · '), S1, true, cw, MIN);
        var l2 = fitLine(c, [e.merchant || '', e.usage || ''].filter(Boolean).join(' · '), S2, false, cw, MIN);
        if (l1.cut) c.issue('cut', '증빙 설명 첫 줄을 줄임: ' + no);
        if (l2.cut) c.issue('cut', '증빙 설명(사용처·사용내역)을 줄임: ' + no);
        var y1 = cy + ch - capH + 1.2 * MM;
        c.text(l1.t, cx + cw / 2, y1, { size: l1.size, bold: true, align: 'center', color: 0.1 });
        if (l2.t) c.text(l2.t, cx + cw / 2, y1 + S1 * LH, { size: l2.size, align: 'center', color: 0.25 });
      });
      c.y = LIMIT;
    }
  }
  /** 개인경비 지출결의 PDF 한 권. deps 는 build 와 같다. 돌려주는 totals[0].all = 명세 합계. */
  function buildExpense(doc, deps) {
    var lib = deps.PDFLib, c, imgs = {};
    var meta = doc.meta || {};
    return lib.PDFDocument.create().then(function (pdf) {
      pdf.registerFontkit(deps.fontkit);
      pdf.setTitle('개인경비 지출 명세 ' + (meta.name || '') + ' ' + (meta.cycleName || ''));
      pdf.setAuthor('ATEC Driving');
      pdf.setProducer('ATEC Driving sheetpdf');
      return Promise.all([   // ★ subset:false — build() 와 같은 까닭(한글 합성 글리프)
        pdf.embedFont(deps.fontRegular, { subset: false }),
        pdf.embedFont(deps.fontBold, { subset: false })
      ]).then(function (f) { c = new Ctx(pdf, lib, f[0], f[1], doc); return pdf; });
    }).then(function (pdf) {
      var paths = [];
      (doc.items || []).forEach(function (it) { if (it.path && paths.indexOf(it.path) < 0) paths.push(it.path); });
      var one = function (p) {
        return Promise.resolve().then(function () { return deps.loadImage ? deps.loadImage(p) : null; })
          .then(function (bytes) {
            if (!bytes || !bytes.length) { c.issue('image', '사진을 불러오지 못함: ' + p); return; }
            var isPng = bytes[0] === 0x89 && bytes[1] === 0x50, isJpg = bytes[0] === 0xFF && bytes[1] === 0xD8;
            if (!isPng && !isJpg) { c.issue('image', 'JPEG·PNG 가 아닌 사진: ' + p); return; }
            return (isPng ? pdf.embedPng(bytes) : pdf.embedJpg(bytes)).then(function (img) {
              imgs[p] = { img: img, orient: isJpg ? exifOrientation(bytes) : 1 };
            });
          }).catch(function (e) { c.issue('image', '사진 처리 실패: ' + p + ' (' + (e && e.message || e) + ')'); });
      };
      var next = 0, ws = [];
      var worker = function () { if (next >= paths.length) return Promise.resolve(); return one(paths[next++]).then(worker); };
      for (var w = 0; w < Math.min(4, paths.length); w++) ws.push(worker());
      return Promise.all(ws).then(function () { return pdf; });
    }).then(function (pdf) {
      c.signs = {};
      var urls = [];
      Object.keys(doc.boxes || {}).forEach(function (k) { var v = doc.boxes[k]; if (v && v.sign && urls.indexOf(v.sign) < 0) urls.push(v.sign); });
      return Promise.all(urls.map(function (u) {
        var m = /^data:image\/png;base64,(.+)$/.exec(u);
        if (!m) return null;
        var bin = atob(m[1]), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return pdf.embedPng(bytes).then(function (img) { c.signs[u] = img; }, function () { c.issue('image', '서명 그림을 넣지 못함'); });
      })).then(function () { return pdf; });
    }).then(function (pdf) {
      var t = drawExpense(c, doc);
      t.pages = pdf.getPageCount();          // 지출 명세가 차지한 쪽 수(줄이 많으면 2장 이상) — 결과 창 「지출 명세 N장」
      drawExpensePhotos(c, doc.items || [], imgs, meta);
      if (doc.verify) drawVerify(c, doc.verify, meta);
      var n = finishPages(c, meta);
      return pdf.save().then(function (bytes) {
        return { bytes: bytes, pages: n, issues: c.issues, stats: c.stats, totals: [t] };
      });
    });
  }

  // ─────────────────────────── 법인카드 지출결의서 (2026-10-09, 가로 A4) ───────────────────────────
  /* 양식(docs/card/법인카드 지출결의서_양식.xlsx)과 같은 짜임:
       제목 「지 출 결 의 서」(굵게, 밑줄 두 줄) · 오른쪽 위 결재란 5칸(운행일지·개인경비와 같은 drawBoxes)
       왼쪽 파란 띠 「신용카드 전표 정보」(순번~사용자) + 오른쪽 파란 띠(구분~비고)
       노란 머리글(굵게): 순번 · 카드번호 · 승인일 · 승인번호 · 가맹점명 · 승인금액 · 사용자 · 구분 · 사용목적 · 비고(사용목적 칸 글자는 굵게)
       합계 줄(순번~가맹점명을 합쳐 「합계」, 승인금액 합). 표 바깥은 굵은 선.
     쪽이 넘치면 「(계속)」 줄 + 띠 + 머리글을 되풀이하고, 마지막 줄 없이 합계만 다음 쪽에 가지 않게 마지막 줄을 데리고 넘어간다.
     doc = { meta, person:{dept,name}, periodLabel, boxes, verify,
             items:[{ no, card_no, date, appr_no, merchant, amount, user, category, purpose, note }] }   ← 이미 승인일 순 */
  var CPW = 841.89, CPH = 595.28, CMX = 30, CMB = MB;
  var CCW = CPW - 2 * CMX, CLIMIT = CPH - CMB;
  var CCOLS_W = [5.13, 24, 11.88, 10.13, 27, 10.88, 10.13, 8.38, 57, 28.63];   // 양식 열 폭(엑셀 B~K)
  var CCOLS = (function () { var s = CCOLS_W.reduce(function (a, b) { return a + b; }, 0); return CCOLS_W.map(function (w) { return w / s * CCW; }); })();
  var CHEAD = ['순번', '카드번호', '승인일', '승인번호', '가맹점명', '승인금액', '사용자', '구분', '사용목적', '비고'];
  function drawCard(c, d) {
    var items = d.items || [], p = d.person || {};
    var total = items.reduce(function (s, it) { return s + Math.round(Number(it.amount) || 0); }, 0);
    var X0 = CMX, rowH = 22, bandH = 20, headH = 24, FS = 8.6;
    var sum = function (a, b) { var s = 0; for (var i = a; i <= b; i++) s += CCOLS[i]; return s; };
    c.geo(CPW, CPH, CLIMIT);
    c.newPage();
    c.bw = 0.6;
    // ── 결재란(오른쪽 위) ──
    var bg = { labW: 16, boxW: 50, hdH: 16, sgH: 48, fill: null, size: 8.5, hpadX: 0.4 * MM, label: ['결', '', '재'] };
    var bw5 = bg.labW + 5 * bg.boxW, bx = X0 + CCW - bw5, btop = 20;
    drawBoxes(c, bx, btop, d.boxes, bg, d.boxLabels);
    c.page.drawRectangle({ x: bx, y: c.ph - btop - bg.hdH - bg.sgH, width: bw5, height: bg.hdH + bg.sgH, borderColor: c.black, borderWidth: 1.2 });
    // ── 제목 — 굵게, 밑줄 두 줄. 결재란에 닿으면 왼쪽으로 민다 ──
    var TS = 24, title = '지 출 결 의 서', tw = c.w(title, TS, true);
    var tcx = Math.min(X0 + CCW / 2, bx - 8 * MM - tw / 2), tTop = btop + 12;
    c.text(title, tcx, tTop, { size: TS, bold: true, align: 'center' });
    [tTop + TS * 1.12, tTop + TS * 1.12 + 2.6].forEach(function (uy) {
      c.page.drawLine({ start: { x: tcx - tw / 2 - 4, y: c.ph - uy }, end: { x: tcx + tw / 2 + 4, y: c.ph - uy }, thickness: 0.9, color: c.black });
    });
    // ── 기간 · 소속 이름(양식에는 없는 줄 — 어느 기간 누구의 문서인지) ──
    var lineTop = btop + bg.hdH + bg.sgH + 7;
    c.text([d.periodLabel, [p.dept, p.name].filter(Boolean).join(' ')].filter(Boolean).join(' · '), X0, lineTop, { size: 8, color: 0.25, maxW: CCW });
    c.y = lineTop + 8 * LH + 3;
    var pageTop = c.y;
    var band = function () {
      c.row([{ w: sum(0, 6), t: '신용카드 전표 정보', size: 9.5, bold: true, align: 'center', fill: XBLUE },
        { w: sum(7, 9), t: '', fill: XBLUE }], { x: X0, minH: bandH });
      c.row(CHEAD.map(function (h, i) { return { w: CCOLS[i], t: h, size: 9.5, bold: true, align: 'center', fill: XYELLOW }; }), { x: X0, minH: headH });
    };
    var closeBox = function () {
      c.page.drawRectangle({ x: X0, y: c.ph - c.y, width: CCW, height: c.y - pageTop, borderColor: c.black, borderWidth: 1.2 });
    };
    var brk = function () {
      closeBox();
      c.newPage();
      c.text('지출결의서 (계속)  ·  ' + [p.name, d.periodLabel].filter(Boolean).join('  ·  '), X0, c.y, { size: 7.6, color: 0.3, maxW: CCW });
      c.y += 7.6 * LH + 1.2 * MM;
      pageTop = c.y;
      band();
    };
    var cells = function (it) {
      if (!it) return CCOLS.map(function (w) { return { w: w, t: '' }; });
      return [
        { w: CCOLS[0], t: String(it.no == null ? '' : it.no), size: FS, align: 'center' },
        { w: CCOLS[1], t: it.card_no || '', size: FS, align: 'center', padX: 0.8 * MM },
        { w: CCOLS[2], t: it.date || '', size: FS, align: 'center', padX: 0.6 * MM },
        { w: CCOLS[3], t: it.appr_no || '', size: FS, align: 'center', padX: 0.6 * MM },
        { w: CCOLS[4], t: it.merchant || '', size: FS, align: 'center', wrap: true, maxLines: 2 },
        { w: CCOLS[5], t: n0(it.amount), size: FS, align: 'right', padX: 1.6 * MM },
        { w: CCOLS[6], t: it.user || '', size: FS, align: 'center', padX: 0.6 * MM },
        { w: CCOLS[7], t: it.category || '', size: FS, align: 'center', padX: 0.6 * MM },
        { w: CCOLS[8], t: it.purpose || '', size: FS, bold: true, align: 'center', wrap: true, maxLines: 3 },
        { w: CCOLS[9], t: it.note || '', size: FS, align: 'center', wrap: true, maxLines: 2 }
      ];
    };
    band();
    var rows = items.length ? items : [null];
    rows.forEach(function (it, k) {
      var cs = cells(it);
      // 마지막 줄은 합계와 같은 쪽에 — 합계만 다음 쪽에 덩그러니 남지 않게 데리고 넘어간다.
      if (k === rows.length - 1 && c.y + c.rowHeight(cs, rowH) + rowH > c.limit + 0.01) brk();
      c.row(cs, { x: X0, onBreak: brk, minH: rowH });
    });
    if (c.y + rowH > c.limit + 0.01) brk();
    c.row([{ w: sum(0, 4), t: '합계', size: 9.5, bold: true, align: 'center' },
      { w: CCOLS[5], t: n0(total), size: 9, bold: true, align: 'right', padX: 1.6 * MM },
      { w: CCOLS[6], t: '' }, { w: CCOLS[7], t: '' }, { w: CCOLS[8], t: '' }, { w: CCOLS[9], t: '' }], { x: X0, minH: rowH });
    closeBox();
    c.bw = null;
    return { all: total, n: items.length };
  }
  /** 법인카드 지출결의서 PDF 한 권. deps 는 build 와 같다(loadImage 없음 — 사진이 없다).
   *  totals[0] = { all: 표 합계, n: 줄 수, pages: 지출결의서가 차지한 쪽 수 }. 검증 쪽(doc.verify)은 세로로 뒤에 붙인다. */
  function buildCard(doc, deps) {
    var lib = deps.PDFLib, c, meta = doc.meta || {};
    return lib.PDFDocument.create().then(function (pdf) {
      pdf.registerFontkit(deps.fontkit);
      pdf.setTitle('지출결의서(법인카드) ' + (meta.name || '') + ' ' + (meta.cycleName || ''));
      pdf.setAuthor('ATEC Driving');
      pdf.setProducer('ATEC Driving sheetpdf');
      return Promise.all([   // ★ subset:false — build() 와 같은 까닭(한글 합성 글리프)
        pdf.embedFont(deps.fontRegular, { subset: false }),
        pdf.embedFont(deps.fontBold, { subset: false })
      ]).then(function (f) { c = new Ctx(pdf, lib, f[0], f[1], doc); return pdf; });
    }).then(function (pdf) {
      c.signs = {};
      var urls = [];
      Object.keys(doc.boxes || {}).forEach(function (k) { var v = doc.boxes[k]; if (v && v.sign && urls.indexOf(v.sign) < 0) urls.push(v.sign); });
      return Promise.all(urls.map(function (u) {
        var m = /^data:image\/png;base64,(.+)$/.exec(u);
        if (!m) return null;
        var bin = atob(m[1]), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return pdf.embedPng(bytes).then(function (img) { c.signs[u] = img; }, function () { c.issue('image', '서명 그림을 넣지 못함'); });
      })).then(function () { return pdf; });
    }).then(function (pdf) {
      var t = drawCard(c, doc);
      t.pages = pdf.getPageCount();
      if (doc.verify) { c.geo(PW, PH, LIMIT); drawVerify(c, doc.verify, meta); }
      var n = finishPages(c, meta);
      return pdf.save().then(function (bytes) {
        return { bytes: bytes, pages: n, issues: c.issues, stats: c.stats, totals: [t] };
      });
    });
  }

  return {
    build: build, basePay: basePay, sheetTotals: sheetTotals, exifOrientation: exifOrientation,
    buildExpense: buildExpense, expenseGroups: expenseGroups, EXPENSE_CATS: X_CATS,
    buildCard: buildCard, CARD_COLS_W: CCOLS_W,
    // 근거 흐름(2026-10-23) — 시험·결재 화면(사진 수 세기)이 쓴다
    tollFlow: tollFlow, dayChecks: dayChecks, evTime: evTime, photoSections: photoSections, odoPicks: odoPicks, scanPlan: scanPlan,
    imagePaths: imagePaths, scanPaths: scanPaths, samePhotoFn: samePhotoFn, odoKmOf: odoKmOf, hipassName: hipassName, lateText: lateText, lateNote: lateNote,
    HP_ORIG_FROM: HP_ORIG_FROM, COLS_MM: COLS_MM, BOXES: BOXES, BOXES_V1: BOXES_V1, VERSION: '1.5.2'
  };
});
