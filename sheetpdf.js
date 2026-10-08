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
  var BOXES = ['담당', '팀장', '실장', '사업부장', '대표이사'];
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
    var inner = Math.max(1, w - 2 * padX);
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
    return { lines: lines, size: size, h: lines.length * size * LH + 2 * padY, padX: padX, padY: padY };
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
    for (var i = 0; i < lay.lines.length; i++) {
      var ln = lay.lines[i];
      if (!ln) continue;
      var tw = f.widthOfTextAtSize(ln, size);
      var tx = o.align === 'right' ? x + w - lay.padX - tw
        : o.align === 'center' ? x + (w - tw) / 2
          : x + lay.padX;
      var base = top + i * lh + lh / 2 + size * 0.35;      // 한글 글리프의 눈높이 중심
      pg.drawText(ln, { x: tx, y: this.ph - base, size: size, font: f, color: color });
    }
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
      this.cell(x, this.y, cells[i].w, h, cells[i], lays[i]);
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
    var boxBottom = drawBoxes(c, MX + infoW + gap, top, sh.boxes);
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

  /** 결재란(담당·팀장·실장·사업부장·대표이사) — 운행기록부·개인경비 명세가 같이 쓴다. (ax, top) 은 왼쪽 위. 아래 끝 y 를 돌려준다.
   *  boxes[칸] = { name, date, sign } · 칸이 없으면 빗금(건너뜀) · name 이 비면 빈칸(아직 결재 전). */
  /*  g = 칸 크기·모양(없으면 운행기록부 크기). 개인경비 명세는 양식 결재란(흰 바탕, 「결 재」 세로 칸)에 맞춘 값을 넘긴다. */
  function drawBoxes(c, ax, top, boxesIn, g) {
    g = g || {};
    var labW = g.labW || 7 * MM, boxW = g.boxW || 17 * MM, hdH = g.hdH || 5.8 * MM, sgH = g.sgH || 13 * MM;
    var hfill = g.fill === undefined ? 0.95 : g.fill, hsz = g.size || 8;
    c.cell(ax, top, labW, hdH + sgH, { lines: g.label || ['결', '재'], size: hsz, align: 'center', fill: hfill });
    var boxes = boxesIn || {};
    BOXES.forEach(function (b, i) {
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
    var body = [];
    calc.rows.forEach(function (x) {
      var r = x.r;
      // 통행료: 0 은 '확정된 0원', 빈 값은 아직 정하지 않은 것이다. 빈칸으로 두면 둘을 가릴 수 없어 적어 준다(합계에는 0원).
      var cells = mk([r.date, r.start, r.end, r.visit, r.purpose, r.manual ? '수기' : '자동',
        n0(r.odoS), n0(r.odoE), n0(x.dist), n0(x.fuel),
        x.park > 0 ? n0(x.park) : '', x.toll == null ? '미확정' : n0(x.toll), n0(x.total)]);
      if (x.toll == null) { cells[11].color = 0.4; cells[11].align = 'center'; }
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
    var need = c.rowHeight(totRow) + partRows.reduce(function (s, r) { return s + c.rowHeight(r); }, 0) +
      c.rowHeight(grandRow, 6.4 * MM);
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
          { w: W[2], t: it.detail || '', size: 8, wrap: true, maxLines: 12, padX: 1.6 * MM }
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

  /** sumText = 오른쪽 위에 적을 금액 설명(없으면 쪽 번호만). 무엇의 합인지 글로 밝혀 넘긴다. */
  function receiptHead(c, title, meta, pageNo, pageCnt, sumText) {
    c.newPage();
    var tw = c.text(title, MX, c.y, { size: 12, bold: true });
    c.text([meta.name, meta.cycleName].filter(Boolean).join(' · '), MX + tw + 4 * MM, c.y + 3,
      { size: 8.5, color: 0.2, maxW: CW * 0.3 });
    var right = (sumText ? sumText + '    ' : '') + pageNo + ' / ' + pageCnt;
    c.text(right, MX + CW, c.y + 3, { size: 8.5, align: 'right', bold: !!sumText, maxW: CW * 0.52 });
    c.y += 12 * LH + 1.8 * MM;
    c.rule(c.y, 0.6); c.y += 3.5 * MM;
  }
  function capOf(e) {
    var memo = String(e.memo || '');
    if (memo.length > 40) memo = memo.slice(0, 39) + '…';      // 사진 설명은 두 줄까지 — 긴 메모는 줄인다
    return [e.date || '', Number(e.amount) > 0 ? won(e.amount) : '', e.plate || '', memo]
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
        var st = per === 1 ? '' : pages > 1
          ? '이 쪽 소계 ' + won(sum) + ' · 전체 ' + n0(list.length) + '건 ' + won(all)
          : '합계 ' + n0(list.length) + '건 ' + won(all);
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
   *   meta:   { name, cycleName, docNo, mark },   // mark: 'preview' | 'pending' | 'rejected' | 'withdrawn' | ''(완료본)
   *   sheets: [ sheetDataFor() 결과 + { boxes: { 담당:{name,date}, 팀장:{…} } } ],   // 차량 1대 = 1장
   *   verify: { ranAt, ai, summary:{bad,warn,info,receipts,read}, items:[{level,title,detail}] } | null,
   *   scans:  [ { path, items:[{category,date,amount,memo}] } ],                      // A4 스캔 원본
   *   photos: [ { path, category, date, amount, plate, memo } ]                       // 낱장 사진
   * }
   */
  function build(doc, deps) {
    var lib = deps.PDFLib, c, imgs = {};
    var meta = doc.meta || {};
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
      // 사진을 먼저 다 불러온다(그리는 중에 기다리지 않게). 같은 경로는 한 번만.
      var paths = [];
      (doc.scans || []).forEach(function (s) { if (s.path && paths.indexOf(s.path) < 0) paths.push(s.path); });
      (doc.photos || []).forEach(function (p) { if (p.path && paths.indexOf(p.path) < 0) paths.push(p.path); });
      // 받기는 넷씩 함께(사진 30장을 하나씩 받으면 한참 걸린다), PDF 에 넣기는 받은 순서와 무관하게 하나씩.
      var one = function (p) {
        return Promise.resolve().then(function () { return deps.loadImage ? deps.loadImage(p) : null; })
          .then(function (bytes) {
            if (!bytes || !bytes.length) { c.issue('image', '사진을 불러오지 못함: ' + p); return; }
            var isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
            var isJpg = bytes[0] === 0xFF && bytes[1] === 0xD8;
            if (!isPng && !isJpg) { c.issue('image', 'JPEG·PNG 가 아닌 사진: ' + p); return; }
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
      var totals = [];
      (doc.sheets || []).forEach(function (sh) { totals.push(drawSheet(c, sh)); });
      if (doc.verify) drawVerify(c, doc.verify, meta);
      if ((doc.scans || []).length) drawScans(c, doc.scans, imgs, meta);
      if ((doc.photos || []).length) drawPhotos(c, doc.photos, imgs, meta);
      if (!pdf.getPageCount()) { c.newPage(); c.text('내용이 없습니다.', MX, c.y, { size: 10 }); }
      var n = finishPages(c, meta);
      return pdf.save().then(function (bytes) {
        return { bytes: bytes, pages: n, issues: c.issues, stats: c.stats, totals: totals };
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
    drawBoxes(c, bx, btop, d.boxes, bg);
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
    drawBoxes(c, bx, btop, d.boxes, bg);
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
    COLS_MM: COLS_MM, BOXES: BOXES, VERSION: '1.4.0'
  };
});
