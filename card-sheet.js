/* ═══════════════════════════════════════════════════════════════════════════
   card-sheet.js — 법인카드 지출결의서 엑셀 (2026-10-09, docs/card/SPEC.md §4 출력)
   ---------------------------------------------------------------------------
   양식(docs/card/법인카드 지출결의서_양식.xlsx)을 엑셀로 인쇄한 모습과 같게 — 가로 A4, 폭 1쪽에 맞춤.
   ★ 열(B~K 양식 폭 5.13·24·11.88·10.13·27·10.88·10.13·8.38·57·28.63): 사용목적(57)·비고(28.63) 열을 잘게 나눠
     오른쪽 위 결재란 칸을 만든다 — J 33.625 · K 4.375(「결 재」) · L·M·N·O 9.5 · P 9.63. 표에서는 J:M · N:P 를 합친다.
   ★ 행 2~3: 제목 「지 출 결 의 서」(B2:J3, 굵게·밑줄 두 줄) + 결재란(머리 18 · 서명 48). 행 4: 기간·소속 이름.
     행 5: 파란 띠(#9BC2E6) 「신용카드 전표 정보」(B:H) + 오른쪽 띠(I:P). 행 6: 노란 머리글(#FFFF99, 굵게).
     인쇄 제목 = 5:6 — 쪽마다 띠·머리글이 되풀이된다.
   ★ 쪽 나눔은 우리가 손수(rowBreaks): 마지막 줄은 합계와 같은 쪽. 시트 높이 어림 PAGE 를 Excel 로 확인해 맞춘다(Task 7 Step 13).
   ★ 합계는 수식 + 계산한 값(<v>) — 수식을 계산하지 않는 보기 프로그램에서도 숫자가 보인다.
   브라우저(window.CardSheet — window.Xlsx 를 넘긴다)·Node(require) 양쪽.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardSheet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var W = { A: 1.5, B: 5.13, C: 24, D: 11.88, E: 10.13, F: 27, G: 10.88, H: 10.13, I: 8.38, J: 33.625, K: 4.375, L: 9.5, M: 9.5, N: 9.5, O: 9.5, P: 9.63 };
  var PURPOSE_W = 57, NOTE_W = 28.63;
  // 인쇄 한 쪽에 들어가는 시트 높이(pt) 어림 — 가로 A4(595pt − 위아래 여백 2cm ≈ 538pt) ÷ 폭 맞춤 배율(약 0.79). 넉넉히 줄여 잡는다.
  var PAGE = 640;
  var SHEET = '지출결의서';
  var BD = function (l, r, t, b, diag) {
    var s = function (tag, v) { return v ? '<' + tag + ' style="' + v + '"><color indexed="64"/></' + tag + '>' : '<' + tag + '/>'; };
    return '<border' + (diag ? ' diagonalUp="1"' : '') + '>' + s('left', l) + s('right', r) + s('top', t) + s('bottom', b) +
      (diag ? '<diagonal style="thin"><color indexed="64"/></diagonal>' : '<diagonal/>') + '</border>';
  };
  var XF = function (numFmt, font, fill, border, align) {
    return '<xf numFmtId="' + numFmt + '" fontId="' + font + '" fillId="' + fill + '" borderId="' + border + '"' + (numFmt ? ' applyNumberFormat="1"' : '') +
      ' applyFont="1" applyFill="1" applyBorder="1"' + (align ? ' applyAlignment="1"><alignment ' + align + '/></xf>' : '/>');
  };
  var CC = 'horizontal="center" vertical="center"';
  var STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0"/>' +
    '<numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
    '<fonts count="6"><font><sz val="11"/><name val="맑은 고딕"/></font>' +                        // 0 기본
    '<font><b/><u val="double"/><sz val="22"/><name val="맑은 고딕"/></font>' +                    // 1 제목(밑줄 두 줄)
    '<font><b/><sz val="10"/><name val="맑은 고딕"/></font>' +                                     // 2 띠·머리글·합계·사용목적
    '<font><sz val="10"/><name val="맑은 고딕"/></font>' +                                         // 3 내용
    '<font><sz val="9"/><name val="맑은 고딕"/></font>' +                                          // 4 결재란
    '<font><sz val="9"/><color rgb="FF595959"/><name val="맑은 고딕"/></font></fonts>' +          // 5 기간 줄
    '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF9BC2E6"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF99"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="9">' + [
      BD(), BD('thin', 'thin', 'thin', 'thin'),                                         // 0 없음 · 1 가는 선
      BD('medium', 'thin', 'medium', 'medium'),                                         // 2 「결 재」
      BD('thin', 'thin', 'medium', 'thin'), BD('thin', 'medium', 'medium', 'thin'),     // 3·4 결재 머리 · 마지막 칸
      BD('thin', 'thin', 'thin', 'medium'), BD('thin', 'medium', 'thin', 'medium'),     // 5·6 서명 자리 · 마지막 칸
      BD('thin', 'thin', 'thin', 'medium', 1), BD('thin', 'medium', 'thin', 'medium', 1)  // 7·8 결재선에 없는 칸 — 빗금 「/」
    ].join('') + '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="21">' + [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>',      // 0
      XF(0, 1, 0, 0, CC),                                           // 1 제목
      XF(0, 5, 0, 0, 'horizontal="left" vertical="center"'),        // 2 기간 줄
      XF(0, 2, 2, 1, CC),                                           // 3 띠 글자
      XF(0, 2, 2, 1, CC),                                           // 4 띠 빈칸
      XF(0, 2, 3, 1, CC + ' wrapText="1"'),                         // 5 머리글
      XF(0, 3, 0, 1, CC + ' shrinkToFit="1"'),                      // 6 내용(줄인다)
      XF(0, 3, 0, 1, CC + ' wrapText="1"'),                         // 7 내용(줄 바꿈) — 가맹점·비고
      XF(0, 2, 0, 1, CC + ' wrapText="1"'),                         // 8 사용목적(굵게)
      XF(164, 3, 0, 1, 'horizontal="right" vertical="center" shrinkToFit="1"'),   // 9 승인금액
      XF(0, 2, 0, 1, CC),                                           // 10 합계 글자
      XF(164, 2, 0, 1, 'horizontal="right" vertical="center" shrinkToFit="1"'),   // 11 합계 금액
      XF(0, 3, 0, 1, CC),                                           // 12 합계 줄 빈칸
      XF(0, 4, 0, 2, CC + ' wrapText="1"'),                         // 13 「결 재」
      XF(0, 4, 0, 3, CC + ' shrinkToFit="1"'),                      // 14 결재 머리
      XF(0, 4, 0, 4, CC + ' shrinkToFit="1"'),                      // 15 결재 머리 — 마지막 칸
      XF(0, 4, 0, 5, CC + ' wrapText="1"'),                         // 16 서명 자리
      XF(0, 4, 0, 6, CC + ' wrapText="1"'),                         // 17 서명 자리 — 마지막 칸
      XF(0, 4, 0, 7, CC),                                           // 18 빗금
      XF(0, 4, 0, 8, CC),                                           // 19 빗금 — 마지막 칸
      XF(165, 3, 0, 1, CC + ' shrinkToFit="1"')                     // 20 승인일(엑셀 날짜)
    ].join('') + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  // 엑셀 글자 정리 — 개인경비 엑셀(drv-expense.js xlText)과 같은 규칙. 특수 글자는 코드 번호로 만든다(편집기가 깨뜨리지 않게).
  var XL_NL = new RegExp('\r\n?|[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
  var XL_SP = new RegExp('[\t' + String.fromCharCode(0xA0, 0x3000) + ']', 'g');
  var XL_GONE = new RegExp('[' + String.fromCharCode(0x200B) + '-' + String.fromCharCode(0x200F) + String.fromCharCode(0xFEFF, 0xFFFC, 0xFFFD) + ']', 'g');
  function xlText(v) {
    var s = String(v == null ? '' : v);
    if (s.normalize) s = s.normalize('NFC');
    return s.replace(XL_NL, '\n').replace(XL_SP, ' ').replace(XL_GONE, '');
  }
  /** 칸 폭(엑셀 폭 단위)에서 몇 줄이 될지 어림 — pt 크기 글자, 한글 약 2.1 · 그 밖 약 1.1(12pt 기준, 크기에 비례). */
  function xlLines(s, width, pt) {
    var per = Math.max(1, (width - 0.5) * 12 / (pt || 12));
    return String(s || '').split('\n').reduce(function (n, part) {
      var u = 0;
      Array.from(part).forEach(function (ch) {
        var cp = ch.codePointAt(0);
        u += (cp >= 0x1100 && cp <= 0x11FF) || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFF00 && cp <= 0xFF60) ? 2.1 : 1.1;
      });
      return n + Math.max(1, Math.ceil(u / per));
    }, 0);
  }
  /** 'YYYY-MM-DD' → 엑셀 날짜 일련번호(1900 체계). 못 읽으면 null. */
  function xlDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400e3);
  }

  /** d = 문서 모델(drv-card.js cDoc). X = window.Xlsx(zip·esc·colName). */
  function xlsxBytes(d, X) {
    var rows = '', merges = [], brks = [], r, c;
    var cell = function (col, row, s, v, o) {
      var rf = X.colName(col) + row; o = o || {};
      if (o.f) return '<c r="' + rf + '" s="' + s + '"><f>' + X.esc(v) + '</f>' + (o.v != null ? '<v>' + o.v + '</v>' : '') + '</c>';
      if (v == null || v === '') return '<c r="' + rf + '" s="' + s + '"/>';
      if (o.n) return '<c r="' + rf + '" s="' + s + '"><v>' + v + '</v></c>';
      return '<c r="' + rf + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + X.esc(xlText(v)) + '</t></is></c>';
    };
    var line = function (rr, ht, cells) { rows += '<row r="' + rr + '"' + (ht ? ' ht="' + ht + '" customHeight="1"' : '') + '>' + cells + '</row>'; };
    var fill = function (rr, s, from, to) { var h = ''; for (c = from; c <= to; c++) h += cell(c, rr, s); return h; };
    var ref = function (col, rr) { return X.colName(col) + rr; };
    var B = 1, C2 = 2, D = 3, E = 4, F = 5, G = 6, H = 7, I = 8, J = 9, K = 10, L = 11, M = 12, N = 13, O = 14, P = 15;
    // 사용목적(J:M) · 비고(N:P)
    var tail = function (rr, s1, s2, purpose, note) {
      merges.push(ref(J, rr) + ':' + ref(M, rr), ref(N, rr) + ':' + ref(P, rr));
      return cell(J, rr, s1, purpose) + fill(rr, s1, K, M) + cell(N, rr, s2, note) + fill(rr, s2, O, P);
    };
    var BX = ['담당', '팀장', '실장', '사업부장', '대표이사'], BXC = [L, M, N, O, P], boxes = d.boxes || {};
    line(1, 6, '');
    line(2, 18, cell(B, 2, 1, '지 출 결 의 서') + fill(2, 1, C2, J) + cell(K, 2, 13, '결\n\n재') +
      BX.map(function (b, i) { return cell(BXC[i], 2, i === 4 ? 15 : 14, b); }).join(''));
    line(3, 48, fill(3, 1, B, J) + cell(K, 3, 13) + BX.map(function (b, i) {
      var v = boxes[b], last = i === 4, s = v ? (last ? 17 : 16) : (last ? 19 : 18);
      return cell(BXC[i], 3, s, !v ? '' : v.name ? v.name + (v.date ? '\n' + v.date : '') : '');
    }).join(''));
    merges.push('B2:J3', 'K2:K3');
    var p = d.person || {};
    line(4, 20, cell(B, 4, 2, [d.periodLabel, [p.dept, p.name].filter(Boolean).join(' ')].filter(Boolean).join(' · ')) + fill(4, 2, C2, P));
    merges.push('B4:P4');
    line(5, 22, cell(B, 5, 3, '신용카드 전표 정보') + fill(5, 3, C2, H) + cell(I, 5, 4) + fill(5, 4, J, P));
    merges.push('B5:H5', 'I5:P5');
    var HEAD = ['순번', '카드번호', '승인일', '승인번호', '가맹점명', '승인금액', '사용자', '구분'];
    line(6, 26, HEAD.map(function (h, i) { return cell(B + i, 6, 5, h); }).join('') + tail(6, 5, 5, '사용목적', '비고'));
    // ── 쪽 나눔 — 다음 쪽엔 인쇄 제목(5·6행)이 되풀이되므로 그 높이부터 센다 ──
    var used = 6 + 18 + 48 + 20 + 22 + 26, REPEAT = 22 + 26, TOT = 24;
    r = 7;
    var fit = function (h) { if (used + h > PAGE) { brks.push(r - 1); used = REPEAT; } };
    var body = function (ht, cells) { fit(ht); line(r, ht, cells); used += ht; };
    var itemHt = function (it) {
      if (!it) return 24;
      var k = Math.min(12, Math.max(xlLines(xlText(it.merchant), W.F, 10), xlLines(xlText(it.purpose), PURPOSE_W, 10), xlLines(xlText(it.note), NOTE_W, 10)));
      return Math.max(24, k * 13.5 + 6);
    };
    var list = d.items && d.items.length ? d.items : [null], total = 0, first = r;
    list.forEach(function (it, k) {
      var ht = itemHt(it);
      if (k === list.length - 1) fit(ht + TOT);          // 마지막 줄은 합계와 같은 쪽
      if (!it) { body(ht, fill(r, 6, B, I) + tail(r, 8, 7, '', '')); r++; return; }
      var amt = Math.round(Number(it.amount) || 0), ds = xlDate(it.date);
      total += amt;
      body(ht, cell(B, r, 6, String(it.no), { n: 1 }) + cell(C2, r, 6, it.card_no) +
        (ds != null ? cell(D, r, 20, String(ds), { n: 1 }) : cell(D, r, 6, it.date)) + cell(E, r, 6, it.appr_no) + cell(F, r, 7, it.merchant) +
        cell(G, r, 9, String(amt), { n: 1 }) + cell(H, r, 6, it.user) + cell(I, r, 6, it.category) + tail(r, 8, 7, it.purpose, it.note));
      r++;
    });
    var lastItem = r - 1;
    fit(TOT);
    body(TOT, cell(B, r, 10, '합계') + fill(r, 10, C2, F) + cell(G, r, 11, 'SUM(G' + first + ':G' + lastItem + ')', { f: 1, v: total }) +
      cell(H, r, 12) + cell(I, r, 12) + tail(r, 12, 12, '', ''));
    merges.push('B' + r + ':F' + r);
    var totalRow = r;
    var cols = Object.keys(W).map(function (Lt, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + W[Lt] + '" customWidth="1"/>'; }).join('');
    var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="B2:P' + totalRow + '"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="17.25"/><cols>' + cols + '</cols>' +
      '<sheetData>' + rows + '</sheetData><mergeCells count="' + merges.length + '">' + merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>' +
      '<printOptions horizontalCentered="1"/><pageMargins left="0.0787" right="0.0787" top="0.3937" bottom="0.3937" header="0.315" footer="0.315"/>' +
      '<pageSetup paperSize="9" fitToWidth="1" fitToHeight="0" orientation="landscape"/>' +
      (brks.length ? '<rowBreaks count="' + brks.length + '" manualBreakCount="' + brks.length + '">' +
        brks.map(function (b) { return '<brk id="' + b + '" max="16383" man="1"/>'; }).join('') + '</rowBreaks>' : '') + '</worksheet>';
    var book = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="' + SHEET + '" sheetId="1" r:id="rId1"/></sheets>' +
      '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">\'' + SHEET + '\'!$A$1:$P$' + totalRow + '</definedName>' +
      '<definedName name="_xlnm.Print_Titles" localSheetId="0">\'' + SHEET + '\'!$5:$6</definedName></definedNames>' +
      '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
    var bytes = X.zip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: book },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', data: STYLES },
      { name: 'xl/worksheets/sheet1.xml', data: sheet }
    ]);
    return { bytes: bytes, meta: { headRow: 6, firstItemRow: first, totalRow: totalRow, breaks: brks, lastRow: totalRow } };
  }

  return { xlsxBytes: xlsxBytes, PAGE: PAGE, W: W, SHEET: SHEET };
});
