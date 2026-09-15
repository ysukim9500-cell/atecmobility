/* ═══════════════════════════════════════════════════════════════════════════
   xlsx.js — 앱과 **같은 엑셀 파일**을 브라우저에서 만든다

   ★ 이 파일은 안드로이드 `app/.../export/ExcelExporter.kt` 를 옮긴 것이다.
     한쪽을 고치면 반드시 다른 쪽도 같이 고쳐야 한다. 두 파일이 갈라지면
     같은 달·같은 사람인데 앱과 웹이 서로 다른 문서를 내놓는다.

   왜 HTML 인쇄가 아니라 xlsx 인가
     제출 서류는 앱이 내보내는 엑셀이 기준이다. 직원이 받아서 계기판을 고치면
     운행거리(=H−G) → 유류비(=MAX(0,I)×단가) → 금액합계(=SUM(J:L)) → 하단 SUM
     까지 **수식으로 따라 바뀌어야** 한다. 값만 박힌 인쇄물로는 그게 안 된다.

   의존성이 없다. OOXML(zip + XML)을 직접 만든다 — 앱과 같은 방식이다.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var NCOL = 13;                       // A..M

  // cellXfs 스타일 인덱스 — styles.xml 의 <cellXfs> 순서와 같아야 한다.
  var S_TITLE = 1, S_SUB = 2, S_LABEL = 3, S_VALUE = 4, S_HEAD = 5,
      S_DATA = 6, S_NUM = 7, S_TLABEL = 8, S_TNUM = 9,
      S_FUELV = 11, S_FUELL = 10, S_FUELN = 12;

  /* ── 고정 부품 (ExcelExporter.kt 447~462행과 글자 그대로 같다) ───────────── */
  var CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';

  var RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';

  var WORKBOOK = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="운행기록" sheetId="1" r:id="rId1"/></sheets></workbook>';

  var WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';

  var STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts><fonts count="3"><font><sz val="9"/><name val="맑은 고딕"/></font><font><b/><sz val="9"/><name val="맑은 고딕"/></font><font><b/><sz val="15"/><name val="맑은 고딕"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6E8EA"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="13"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="1" fillId="2" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="1" fillId="3" borderId="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  var COLS = '<cols><col min="1" max="1" width="11"/><col min="2" max="3" width="15"/><col min="4" max="4" width="11"/><col min="5" max="5" width="9"/><col min="6" max="6" width="7"/><col min="7" max="8" width="9"/><col min="9" max="9" width="10"/><col min="10" max="10" width="9"/><col min="11" max="12" width="8"/><col min="13" max="13" width="9"/></cols>';

  /* ── 도우미 (ExcelExporter.kt 132~168행) ─────────────────────────────────── */
  function colName(i) {
    var s = '';
    while (i >= 0) { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; }
    return s;
  }
  /** XML 1.0 이 금지하는 제어문자를 먼저 턴다. 주소·방문처에 한 글자라도 섞이면
   *  sheet1.xml 전체가 잘못된 XML 이 되어 엑셀이 파일을 통째로 거부한다. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /** 한 셀. opt.f=수식, opt.n=숫자, 그 외 inlineStr. 값이 비면 빈 셀. */
  function cell(col, row, style, value, opt) {
    var ref = colName(col) + row;
    opt = opt || {};
    if (opt.f && value != null) return '<c r="' + ref + '" s="' + style + '"><f>' + esc(value) + '</f></c>';
    if (value == null || value === '') return '<c r="' + ref + '" s="' + style + '"/>';
    if (opt.n) return '<c r="' + ref + '" s="' + style + '"><v>' + value + '</v></c>';
    return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
      esc(value) + '</t></is></c>';
  }

  /* ── sheet1.xml (ExcelExporter.kt buildSheetXml) ─────────────────────────── */
  /**
   * @param o.dept        부서 (회사명 + 부서)
   * @param o.name        성명
   * @param o.plateNo     차량번호
   * @param o.vehicleType 차 종
   * @param o.periodLabel "(기간 : yyyy-MM-dd ~ yyyy-MM-dd)"
   * @param o.quarterLabel 유류 기준단가 문구
   * @param o.rows        [{date,start,end,visit,purpose,manual,odoS,odoE,rate,parking,toll}]
   *                      — 이미 정렬·영수증 합산이 끝난 상태로 넘긴다.
   * @param o.orphans     [{date,parking,toll}] 운행 없이 영수증만 있는 날
   * @param o.parts       [{region,rate,km,amount}] 지역별 분해(2종 이상일 때만)
   */
  function buildSheetXml(o) {
    var merges = [], rows = '';
    var nData = Math.max(1, o.rows.length + o.orphans.length);
    var firstData = 12, lastData = firstData + nData - 1, totalRow = lastData + 1;
    var breakRow = totalRow + 1, grandRow = breakRow + o.parts.length;
    var c, i;

    // Row 1: 제목
    rows += '<row r="1" ht="30" customHeight="1">' + cell(0, 1, S_TITLE, '차량운행내역기록부');
    for (c = 1; c < NCOL; c++) rows += cell(c, 1, S_TITLE);
    rows += '</row>'; merges.push('A1:' + colName(NCOL - 1) + '1');

    // Row 2: 기간
    rows += '<row r="2">' + cell(0, 2, S_SUB, o.periodLabel);
    for (c = 1; c < NCOL; c++) rows += cell(c, 2, S_SUB);
    rows += '</row>'; merges.push('A2:' + colName(NCOL - 1) + '2');

    rows += '<row r="3" ht="6" customHeight="1"></row>';

    // Row 4~7: 좌측 정보 + 우측 결재란
    rows += '<row r="4" ht="18" customHeight="1">' +
      cell(0, 4, S_LABEL, '부 서') + cell(1, 4, S_LABEL) + cell(2, 4, S_VALUE, o.dept);
    for (c = 3; c <= 6; c++) rows += cell(c, 4, S_VALUE);
    rows += cell(7, 4, S_LABEL, '결 재') +
      cell(8, 4, S_LABEL, '담당') + cell(9, 4, S_LABEL, '팀장') + cell(10, 4, S_LABEL, '실장') +
      cell(11, 4, S_LABEL, '사업부장') + cell(12, 4, S_LABEL, '대표이사') + '</row>';
    merges.push('A4:B4', 'C4:G4', 'H4:H7');

    rows += '<row r="5" ht="24" customHeight="1">' +
      cell(0, 5, S_LABEL, '성 명') + cell(1, 5, S_LABEL) + cell(2, 5, S_VALUE, o.name);
    for (c = 3; c <= 6; c++) rows += cell(c, 5, S_VALUE);
    rows += cell(7, 5, S_LABEL);
    for (c = 8; c <= 12; c++) rows += cell(c, 5, S_VALUE);
    rows += '</row>';
    merges.push('A5:B5', 'C5:G5', 'I5:I7', 'J5:J7', 'K5:K7', 'L5:L7', 'M5:M7');

    rows += '<row r="6" ht="18" customHeight="1">' +
      cell(0, 6, S_LABEL, '차량번호') + cell(1, 6, S_LABEL) + cell(2, 6, S_VALUE, o.plateNo);
    for (c = 3; c <= 6; c++) rows += cell(c, 6, S_VALUE);
    rows += cell(7, 6, S_LABEL);
    for (c = 8; c <= 12; c++) rows += cell(c, 6, S_VALUE);
    rows += '</row>'; merges.push('A6:B6', 'C6:G6');

    rows += '<row r="7" ht="18" customHeight="1">' +
      cell(0, 7, S_LABEL, '차 종') + cell(1, 7, S_LABEL) + cell(2, 7, S_VALUE, o.vehicleType);
    for (c = 3; c <= 6; c++) rows += cell(c, 7, S_VALUE);
    rows += cell(7, 7, S_LABEL);
    for (c = 8; c <= 12; c++) rows += cell(c, 7, S_VALUE);
    rows += '</row>'; merges.push('A7:B7', 'C7:G7');

    rows += '<row r="8" ht="6" customHeight="1"></row>';

    // Row 9: 총 운행거리 / 기본지급액 / 유류 기준단가
    var baseIf = 'IF(C9<=499,0,IF(C9<=999,70000,IF(C9<=1499,90000,IF(C9<=1999,110000,IF(C9<=2499,130000,150000)))))';
    rows += '<row r="9" ht="20" customHeight="1">' +
      cell(0, 9, S_LABEL, '총 운행거리(Km)') + cell(1, 9, S_LABEL) +
      cell(2, 9, S_NUM, 'I' + totalRow, { f: 1 }) + cell(3, 9, S_NUM) +
      cell(4, 9, S_LABEL, '기본지급액(원)') + cell(5, 9, S_LABEL) +
      cell(6, 9, S_NUM, baseIf, { f: 1 }) + cell(7, 9, S_NUM) +
      cell(8, 9, S_LABEL, '■ 유류 기준단가') + cell(9, 9, S_LABEL) +
      cell(10, 9, S_FUELV, o.quarterLabel) + cell(11, 9, S_FUELV) + cell(12, 9, S_FUELV) + '</row>';
    merges.push('A9:B9', 'C9:D9', 'E9:F9', 'G9:H9', 'I9:J9', 'K9:M9');

    rows += '<row r="10" ht="6" customHeight="1"></row>';

    // Row 11: 표 헤더
    var headers = ['운행일자', '출발지역', '도착지역', '방문처', '업무\n구분', '입력\n구분',
      '출발시\n키로수', '도착시\n키로수', '운행거리\n(km)', '유류비', '주차비', '통행료', '금액합계'];
    rows += '<row r="11" ht="34" customHeight="1">';
    for (c = 0; c < NCOL; c++) rows += cell(c, 11, S_HEAD, headers[c]);
    rows += '</row>';

    // 데이터 행
    var r = firstData;
    if (!o.rows.length && !o.orphans.length) {
      rows += '<row r="' + r + '" ht="30" customHeight="1">';
      for (c = 0; c <= 5; c++) rows += cell(c, r, S_DATA);
      for (c = 6; c < NCOL; c++) rows += cell(c, r, S_NUM);
      rows += '</row>'; r++;
    }
    for (i = 0; i < o.rows.length; i++) {
      var t = o.rows[i];
      // 높이를 고정하지 않는다 — 주소가 2줄·3줄로 달라지므로 엑셀이 내용에 맞춰 잡게 둔다.
      rows += '<row r="' + r + '">' +
        cell(0, r, S_DATA, t.date) +
        cell(1, r, S_DATA, t.start) +
        cell(2, r, S_DATA, t.end) +
        cell(3, r, S_DATA, t.visit) +
        cell(4, r, S_DATA, t.purpose) +
        cell(5, r, S_DATA, t.manual ? '수기' : '자동') +
        cell(6, r, S_NUM, String(t.odoS), { n: 1 }) +
        cell(7, r, S_NUM, String(t.odoE), { n: 1 }) +
        cell(8, r, S_NUM, 'H' + r + '-G' + r, { f: 1 }) +
        // ★ 유류비는 값이 아니라 수식이다 — 직원이 계기판을 고치면 거리→유류비→합계가 따라간다.
        cell(9, r, S_NUM, 'MAX(0,I' + r + ')*' + Math.max(t.rate, 0), { f: 1 }) +
        cell(10, r, S_NUM, t.parking > 0 ? String(t.parking) : null, { n: t.parking > 0 }) +
        cell(11, r, S_NUM, t.toll == null ? null : String(t.toll), { n: t.toll != null }) +
        cell(12, r, S_NUM, 'SUM(J' + r + ':L' + r + ')', { f: 1 }) + '</row>';
      r++;
    }
    for (i = 0; i < o.orphans.length; i++) {
      var d = o.orphans[i];
      rows += '<row r="' + r + '" ht="18" customHeight="1">' + cell(0, r, S_DATA, d.date);
      for (c = 1; c <= 3; c++) rows += cell(c, r, S_DATA);
      rows += cell(4, r, S_DATA, '근거자료') + cell(5, r, S_DATA, '영수증');
      for (c = 6; c <= 9; c++) rows += cell(c, r, S_NUM);
      rows += cell(10, r, S_NUM, d.parking > 0 ? String(d.parking) : null, { n: d.parking > 0 }) +
        cell(11, r, S_NUM, d.toll > 0 ? String(d.toll) : null, { n: d.toll > 0 }) +
        cell(12, r, S_NUM, 'SUM(J' + r + ':L' + r + ')', { f: 1 }) + '</row>';
      r++;
    }

    // 합계 행
    rows += '<row r="' + totalRow + '" ht="20" customHeight="1">' +
      cell(0, totalRow, S_TLABEL, '운행 내역 합계');
    for (c = 1; c <= 7; c++) rows += cell(c, totalRow, S_TLABEL);
    ['I', 'J', 'K', 'L', 'M'].forEach(function (L, k) {
      rows += cell(8 + k, totalRow, S_TNUM, 'SUM(' + L + firstData + ':' + L + lastData + ')', { f: 1 });
    });
    rows += '</row>'; merges.push('A' + totalRow + ':H' + totalRow);

    // 지역별 분해 행
    var br = breakRow;
    for (i = 0; i < o.parts.length; i++) {
      var p = o.parts[i];
      rows += '<row r="' + br + '" ht="18" customHeight="1">' +
        cell(0, br, S_FUELL, '└  ' + p.region + ' 출발  ×  ' + p.rate + '원/km');
      for (c = 1; c <= 7; c++) rows += cell(c, br, S_FUELL);
      rows += cell(8, br, S_FUELN, String(p.km), { n: 1 }) +
        cell(9, br, S_FUELN, String(p.amount), { n: 1 });
      for (c = 10; c < NCOL; c++) rows += cell(c, br, S_FUELL);
      rows += '</row>'; merges.push('A' + br + ':H' + br);
      br++;
    }

    // 총계 행
    rows += '<row r="' + grandRow + '" ht="22" customHeight="1">' +
      cell(0, grandRow, S_TLABEL, '당월 차량운행비 총계');
    for (c = 1; c <= 11; c++) rows += cell(c, grandRow, S_TLABEL);
    rows += cell(12, grandRow, S_TNUM, 'M' + totalRow, { f: 1 }) + '</row>';
    merges.push('A' + grandRow + ':L' + grandRow);

    var mergeXml = '<mergeCells count="' + merges.length + '">' +
      merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      // ★ dimension·sheetViews·sheetFormatPr 가 없으면 데스크톱 엑셀이 <row> 의 ht 를 무시해
      //   주소 2줄이 기본 15pt 칸에 갇혀 잘린다(앱에서 실제로 겪은 문제).
      '<dimension ref="A1:' + colName(NCOL - 1) + grandRow + '"/>' +
      '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="16.9"/>' +
      COLS + '<sheetData>' + rows + '</sheetData>' + mergeXml +
      '<printOptions horizontalCentered="1"/>' +
      '<pageMargins left="0.2" right="0.2" top="0.3" bottom="0.3" header="0.2" footer="0.2"/>' +
      '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>' +
      '</worksheet>';
  }

  /* ── 최소 ZIP (압축 없이 저장만) ─────────────────────────────────────────────
     xlsx 는 "압축 안 함(store)" 으로도 완전히 유효하다. 라이브러리를 들이지 않으려고
     직접 만든다. 파일이 커야 수백 KB 라 크기도 문제가 안 된다. */
  function crc32(buf) {
    var t = crc32.t;
    if (!t) {
      t = crc32.t = new Int32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
      }
    }
    var crc = -1;
    for (var i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ t[(crc ^ buf[i]) & 0xFF];
    return (crc ^ -1) >>> 0;
  }
  function zip(files) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    function u16(n) { return [n & 255, (n >>> 8) & 255]; }
    function u32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }

    files.forEach(function (f) {
      var name = enc.encode(f.name), data = enc.encode(f.data), c = crc32(data);
      var local = [].concat([0x50, 0x4B, 0x03, 0x04], u16(20), u16(0), u16(0),
        u16(0), u16(0),                       // 시각(0 = 1980-01-01). 재현 가능하게 고정한다.
        u32(c), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(local), name, data);
      central.push({ name: name, crc: c, size: data.length, off: offset });
      offset += local.length + name.length + data.length;
    });

    var cdir = [];
    central.forEach(function (e) {
      var h = [].concat([0x50, 0x4B, 0x01, 0x02], u16(20), u16(20), u16(0), u16(0),
        u16(0), u16(0), u32(e.crc), u32(e.size), u32(e.size),
        u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.off));
      cdir.push(new Uint8Array(h), e.name);
    });
    var cdirSize = cdir.reduce(function (a, x) { return a + x.length; }, 0);
    var end = new Uint8Array([].concat([0x50, 0x4B, 0x05, 0x06], u16(0), u16(0),
      u16(central.length), u16(central.length), u32(cdirSize), u32(offset), u16(0)));

    var all = parts.concat(cdir, [end]);
    var total = all.reduce(function (a, x) { return a + x.length; }, 0);
    var out = new Uint8Array(total), p = 0;
    all.forEach(function (x) { out.set(x, p); p += x.length; });
    return out;
  }

  /** 시트 하나짜리 xlsx 바이트를 만든다. */
  function build(o) {
    return zip([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: RELS },
      { name: 'xl/workbook.xml', data: WORKBOOK },
      { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
      { name: 'xl/styles.xml', data: STYLES },
      { name: 'xl/worksheets/sheet1.xml', data: buildSheetXml(o) }
    ]);
  }

  global.Xlsx = { build: build, buildSheetXml: buildSheetXml, zip: zip, colName: colName, esc: esc };
})(window);
