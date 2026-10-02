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
  Ctx.prototype.newPage = function () {
    this.page = this.pdf.addPage([PW, PH]);
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
      if (cp === 0x09 || cp === 0x0A || cp === 0x0D || cp === 0xA0) { out += ' '; continue; }
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
        x: x, y: PH - yTop - h, width: w, height: h,
        color: o.fill != null ? this.gray(o.fill) : undefined,
        borderColor: o.border === false ? undefined : this.black,
        borderWidth: o.border === false ? 0 : BW
      });
    }
    if (o.slash) {
      pg.drawLine({ start: { x: x, y: PH - yTop - h }, end: { x: x + w, y: PH - yTop }, thickness: BW, color: this.black });
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
      pg.drawText(ln, { x: tx, y: PH - base, size: size, font: f, color: color });
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
      x: tx, y: PH - (yTop + size * 0.85), size: size, font: f,
      color: o.color != null ? this.gray(o.color) : this.black
    });
    return tw;
  };
  Ctx.prototype.rule = function (yTop, thick, gray) {
    this.page.drawLine({
      start: { x: MX, y: PH - yTop }, end: { x: MX + CW, y: PH - yTop },
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
    if (this.y + h > LIMIT + 0.01) {
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
    var ax = MX + infoW + gap, labW = 7 * MM, boxW = 17 * MM, hdH = 5.8 * MM, sgH = 13 * MM;
    c.cell(ax, top, labW, hdH + sgH, { lines: ['결', '재'], size: 8, align: 'center', fill: 0.95 });
    var boxes = sh.boxes || {};
    BOXES.forEach(function (b, i) {
      var bx = ax + labW + i * boxW;
      c.cell(bx, top, boxW, hdH, { t: b, size: 8, align: 'center', fill: 0.95 });
      var v = boxes[b];
      if (!v) { c.cell(bx, top + hdH, boxW, sgH, { slash: true }); return; }
      c.cell(bx, top + hdH, boxW, sgH, { t: '' });
      var sgi = v.sign && c.signs && c.signs[v.sign];
      if (v.name && sgi) {
        // 서명·도장 그림을 칸 위쪽에 맞춰 넣고(비율 유지), 날짜는 그 아래.
        var mw = boxW - 2 * MM, mh = sgH - (v.date ? 4.2 * MM : 1.6 * MM);
        var k = Math.min(mw / sgi.width, mh / sgi.height), iw = sgi.width * k, ih = sgi.height * k;
        var iy0 = top + hdH + 0.8 * MM + (mh - ih) / 2;
        c.page.drawImage(sgi, { x: bx + (boxW - iw) / 2, y: PH - iy0 - ih, width: iw, height: ih });
        if (v.date) {
          var ds0 = c.clean(v.date), dw0 = c.fR.widthOfTextAtSize(ds0, 6.5);
          c.page.drawText(ds0, { x: bx + (boxW - dw0) / 2, y: PH - (top + hdH + sgH - 1.3 * MM), size: 6.5, font: c.fR, color: c.gray(0.33) });
        }
      } else if (v.name) {
        var lay = c.layout({ t: v.name, size: 8.5, padX: 0.8 * MM }, boxW);
        var f = c.fR, nm = lay.lines[0], tw = f.widthOfTextAtSize(nm, lay.size);
        var mid = top + hdH + sgH / 2;
        var by = v.date ? mid - 0.6 : mid + lay.size * 0.35;
        c.page.drawText(nm, { x: bx + (boxW - tw) / 2, y: PH - by, size: lay.size, font: f, color: c.black });
        if (v.date) {
          var ds = c.clean(v.date), dw = f.widthOfTextAtSize(ds, 6.5);
          c.page.drawText(ds, { x: bx + (boxW - dw) / 2, y: PH - (mid + 9), size: 6.5, font: f, color: c.gray(0.33) });
        }
      }
    });
    c.y = Math.max(iy, top + hdH + sgH) + 4 * MM;

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
      v.ai ? 'AI 사진 판독 ' + n0(s.read || 0) + ' / ' + n0(s.receipts || 0) + '장' : 'AI 사진 판독 없음(규칙 검증만)'
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
    c.text('· 금액 계산은 정해진 규칙으로만 합니다. AI 는 사진을 읽어 입력값과 다른 곳을 표시할 뿐, 값을 바꾸지 않습니다.',
      MX, c.y, { size: 7.6, color: 0.3, maxW: CW });
    c.y += 7.6 * LH + 0.8 * MM;
    c.text('· 불일치·확인 항목이 있어도 상신할 수 있습니다. 결재자는 이 표를 보고 판단합니다.',
      MX, c.y, { size: 7.6, color: 0.3, maxW: CW });
    c.y += 7.6 * LH;
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
      var fy = PH - 10.5 * MM;
      pg.drawLine({ start: { x: MX, y: PH - fy }, end: { x: MX + CW, y: PH - fy }, thickness: 0.3, color: c.gray(0.6) });
      var ty = fy + 1.2 * MM;
      c.text([meta.name, meta.cycleName].filter(Boolean).join(' · '), MX, ty, { size: 8, color: 0.3, maxW: CW * 0.3 });
      c.text(meta.docNo || '', MX + CW / 2, ty, { size: 8, color: 0.3, align: 'center', maxW: CW * 0.5 });
      c.text((i + 1) + ' / ' + n, MX + CW, ty, { size: 8, color: 0.3, align: 'right' });
      if (mk) {
        var s = mk[0], size = Array.from(s).length >= 4 ? 104 : 120, f = c.fB;
        var tw = f.widthOfTextAtSize(s, size), th = size * 0.72, a = 32 * Math.PI / 180;
        var cx = PW / 2, cy = PH / 2;
        // 0.07 은 영수증 사진 위에서 거의 안 보였다 — 사진 쪽에서도 읽히게 조금 진하게.
        pg.drawText(s, {
          x: cx - (tw / 2 * Math.cos(a) - th / 2 * Math.sin(a)),
          y: cy - (tw / 2 * Math.sin(a) + th / 2 * Math.cos(a)),
          size: size, font: f, color: c.gray(0), opacity: 0.12, rotate: deg(32)
        });
        c.text(mk[1], MX + CW / 2, 4.2 * MM, { size: 7.5, align: 'center', color: 0.3 });
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

  return {
    build: build, basePay: basePay, sheetTotals: sheetTotals, exifOrientation: exifOrientation,
    COLS_MM: COLS_MM, BOXES: BOXES, VERSION: '1.2.0'
  };
});
