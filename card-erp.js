/* ═══════════════════════════════════════════════════════════════════════════
   card-erp.js — ERP 법인카드 승인내역 엑셀 읽기 (2026-10-09, docs/card/SPEC.md §1)
   ---------------------------------------------------------------------------
   브라우저(drv-card.js)와 Node(web/test) 양쪽에서 돈다. SheetJS(XLSX)는 부르는 쪽이 넘긴다.
   ★ 머리글은 이름으로, 글자 그대로(공백만 무시) 찾는다. 실제 ERP 파일에는 「가맹점전화번호」·「가맹점우편번호」·
     「부가세여부」·「부가세구분」·「전표승인여부」가 함께 있다 — 「가맹점」이 들어간 칸을 고르면 전화번호를 읽는다.
   ★ 날짜는 Date 로 바꾸지 않는다(브라우저 시간대를 타면 말일 23:59 승인이 다음 날이 된다). 'YYYY-MM-DD' 글자로만.
   ★ 취소 줄은 같은 승인번호의 원래 줄과 짝지어 뺀다(부분 취소는 차감). 짝짓기는 달 거르기보다 먼저 —
     7월 승인 · 8월 취소가 한 파일에 있으면 7월분에서도 빠진다.
   ★ 취소는 구분에 「취소」가 들어 있거나 승인금액이 음수인 줄이다(구분이 「승인」이어도 음수면 취소 — 양수 지출로 두지 않는다).
   ★ 손 칸(구분·사용목적·비고)은 여기서 만들지도, 서버로 보내지도 않는다(toRow). 다시 올려도 손 칸은 그대로다.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CardErp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HEAD = { s: 'S', card: '법인카드', owner: '소유자', date: '승인일자', time: '승인시간', merchant: '가맹점',
    amount: '승인금액', biz: '업종', bizNo: '사업자등록번호', supply: '공급가액', vat: '부가세', no: '승인번호', kind: '구분' };
  var NEED = ['card', 'date', 'no', 'merchant', 'amount'];
  var CARD_RE = /^\d{4}-[\d*]{4}-[\d*]{4}-\d{4}$/;          // 머리글 S 가 없을 때 쓰는 줄 알아보기(가운데 가린 번호도)
  var REASON = {
    zero: '0원 승인', cancel: '취소된 승인(원래 줄과 취소 줄)', cancel_partial: '부분 취소 — 남은 금액만 넣음',
    cancel_orphan: '원래 승인이 이 파일에 없는 취소 줄', month: '고른 달 밖', dup: '파일 안에서 승인번호·승인일이 같은 줄',
    invalid: '승인일·승인번호·금액을 읽지 못함'
  };
  var ERP_COLS = ['card_no', 'appr_time', 'merchant', 'amount', 'owner_name', 'biz_type', 'biz_no', 'supply', 'vat'];
  var MAX_ROWS = 5000;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function norm(v) { return String(v == null ? '' : v).replace(/[\s 　﻿]+/g, ''); }
  function text(v) { return String(v == null ? '' : v).replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim(); }

  /** 금액 — 숫자 칸은 그대로, 글자는 「19,800」「₩19,800」「-19,800」「(19,800)」「-」. 빈칸 = 0, 못 읽으면 NaN. */
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? Math.round(v) : NaN;
    var s = String(v == null ? '' : v).replace(/[\s,원₩\\]/g, '');
    if (s === '' || s === '-') return 0;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (s.charAt(0) === '-') { neg = !neg; s = s.slice(1); }
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    var n = Math.round(Number(s));
    return neg ? -n : n;
  }
  function numOrNull(v) { var n = num(v); return isFinite(n) ? n : null; }

  function realDay(y, m, d) {
    if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? y + '-' + pad(m) + '-' + pad(d) : '';
  }
  /** 승인일 → 'YYYY-MM-DD'. 엑셀 일련번호(1900 체계, 소수 = 시각은 버림) · 20260731 · '2026-07-31' · '2026.07.31' · '2026/7/31' · '2026년 7월 31일'. */
  function ymd(v) {
    if (typeof v === 'number' && isFinite(v)) {
      if (v >= 20000101 && v <= 21001231 && v === Math.floor(v)) return ymd(String(v));
      if (v < 30000 || v > 80000) return '';
      var d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5);
      return realDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    var s = String(v == null ? '' : v).trim(), m;
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return realDay(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{4})\s*[-.\/년]\s*(\d{1,2})\s*[-.\/월]\s*(\d{1,2})/.exec(s))) return realDay(+m[1], +m[2], +m[3]);
    return '';
  }
  function okTime(h, mi, s) { return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59 ? pad(h) + ':' + pad(mi) + ':' + pad(s) : ''; }
  /** 승인시간 → 'HH:MM:SS'. 하루의 몫(0.5 = 정오)·날짜+시각 일련번호·'HH:MM[:SS]'·'HHMMSS'·'HMMSS'·정수 93015. 못 읽으면 ''. */
  function hms(v) {
    if (typeof v === 'number' && isFinite(v)) {
      if (v >= 1 && v === Math.floor(v)) return v <= 235959 ? hms(('000000' + v).slice(-6)) : '';
      if (v >= 1) v = v - Math.floor(v);
      if (v < 0) return '';
      var t = Math.min(86399, Math.round(v * 86400));
      return okTime(Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60);
    }
    var s = String(v == null ? '' : v).trim(), m;
    if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s))) return okTime(+m[1], +m[2], +(m[3] || 0));
    if ((m = /^(\d{1,2})(\d{2})(\d{2})$/.exec(s))) return okTime(+m[1], +m[2], +m[3]);
    return '';
  }

  /* ── 파일 → 표 ── */
  function latin(b, max) { var s = ''; for (var i = 0; i < Math.min(b.length, max); i++) s += String.fromCharCode(b[i]); return s; }
  function isHtml(b) { return /^\s*<(!doctype|html|table|\?xml|meta|head|body)/i.test(latin(b, 512).replace(/^\xEF\xBB\xBF/, '')); }
  /** 엑셀(.xls OLE · .xlsx zip)이거나 ERP 가 .xls 이름으로 내보낸 HTML 표인가. 그 밖(PDF·그림 등)은 false. */
  function looksLikeSheet(b) {
    if (!b || b.length < 8) return false;
    if (b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0) return true;
    if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) return true;
    return isHtml(b);
  }
  function htmlCharset(b) {
    var m = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(latin(b, 4096)), cs = m ? m[1].toLowerCase() : 'utf-8';
    return /euc-?kr|ks_c_5601|cp949|windows-949/.test(cs) ? 'euc-kr' : 'utf-8';
  }
  /** 첫 시트 → { raw: 값 그대로, text: 엑셀에 보이는 글자 }. HTML 표는 글자 그대로 읽는다(앞자리 0 승인번호를 지키려고). */
  function sheetRows(XLSX, bytes) {
    var base = { cellFormula: false, cellHTML: false, cellStyles: false, cellDates: false, sheetRows: MAX_ROWS + 60 };
    var wb = isHtml(bytes)
      ? XLSX.read(new TextDecoder(htmlCharset(bytes)).decode(bytes), Object.assign({}, base, { type: 'string', raw: true }))
      : XLSX.read(bytes, Object.assign({}, base, { type: 'array' }));
    var ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return { raw: [], text: [] };
    return {
      raw: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true }),
      text: XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true })
    };
  }
  /** 시험용 — 손으로 만든 2차원 배열을 sheetRows 모양으로. */
  function fromAoa(aoa) {
    return { raw: aoa, text: aoa.map(function (r) { return (r || []).map(function (c) { return c == null ? '' : String(c); }); }) };
  }

  function findHeader(tx) {
    for (var r = 0; r < Math.min(tx.length, 40); r++) {
      var row = tx[r] || [], cols = {};
      for (var c = 0; c < row.length; c++) {
        var t = norm(row[c]);
        for (var k in HEAD) {
          if (cols[k] == null && (t === HEAD[k] || (k === 's' && t.toUpperCase() === 'S'))) cols[k] = c;
        }
      }
      if (NEED.every(function (k) { return cols[k] != null; })) return { row: r, cols: cols };
    }
    return null;
  }
  function drop(o, reason) {
    return { row: o.row, reason: reason, label: REASON[reason], appr_date: o.appr_date || '', appr_no: o.appr_no || '',
      merchant: o.merchant || '', amount: o.amount0 != null ? o.amount0 : o.amount, cancel: !!o.cancel };
  }

  /**
   * 표 → 넣을 줄 · 뺀 줄 · ERP 합계 대조. opt = { cycle:'YYYY-MM', me:'내 이름', file }.
   * 순서: 줄 읽기 → 취소 짝 맞추기(파일 전체) → 0원 → 달 → 파일 안 중복 → 소유자 표시.
   */
  function parse(sheet, opt) {
    opt = opt || {};
    var raw = (sheet && sheet.raw) || [], tx = (sheet && sheet.text) || [];
    var hd = findHeader(tx);
    if (!hd) {
      var seen = {};
      tx.slice(0, 40).forEach(function (r) { (r || []).forEach(function (c) { seen[norm(c)] = 1; }); });
      return { ok: false, error: 'NO_HEADER', missing: NEED.filter(function (k) { return !seen[HEAD[k]]; }).map(function (k) { return HEAD[k]; }) };
    }
    if (raw.length - hd.row - 1 > MAX_ROWS) return { ok: false, error: 'TOO_MANY', max: MAX_ROWS };
    var cols = hd.cols, recs = [], sums = [], dropped = [];
    for (var r = hd.row + 1; r < raw.length; r++) {
      var R0 = raw[r] || [], T0 = tx[r] || [];
      if (!T0.some(function (c) { return text(c) !== ''; })) continue;
      var g = function (k) { return cols[k] == null ? '' : R0[cols[k]]; };
      var gt = function (k) { return cols[k] == null ? '' : text(T0[cols[k]]); };
      var card = gt('card'), date = ymd(g('date'));
      if (cols.s != null) {
        var f = norm(gt('s')).toUpperCase();
        if (f === 'N') { sums.push(r); continue; }
        if (f !== 'Y') continue;
      } else if (!CARD_RE.test(card) || !date) { sums.push(r); continue; }
      var amt = num(g('amount')), no = gt('no');
      var rec = {
        row: r + 1, card_no: card.slice(0, 25), appr_date: date, appr_time: hms(g('time')), appr_no: no,
        merchant: gt('merchant').slice(0, 80), amount: Math.abs(amt), amount0: Math.abs(amt),
        owner_name: gt('owner').slice(0, 40), biz_type: gt('biz').slice(0, 60), biz_no: gt('bizNo').slice(0, 20),
        supply: cols.supply == null ? null : numOrNull(g('supply')), vat: cols.vat == null ? null : numOrNull(g('vat')),
        // 구분에 「취소」가 있거나 금액이 음수면 취소 — 구분이 「승인」이어도 음수는 양수 지출로 두지 않는다(D1)
        cancel: norm(gt('kind')).indexOf('취소') >= 0 || amt < 0
      };
      if (!date || !no || no.length > 20 || !isFinite(amt) || Math.abs(amt) > 50000000) { dropped.push(drop(rec, 'invalid')); continue; }
      recs.push(rec);
    }
    // ── 취소 짝 맞추기 ──
    var orig = recs.filter(function (x) { return !x.cancel; }), canc = recs.filter(function (x) { return x.cancel; });
    orig.forEach(function (o) { o.left = o.amount; o.cancels = []; });
    canc.forEach(function (x) {
      var cands = orig.filter(function (o) {
        return o.appr_no === x.appr_no && o.left > 0 && (!o.card_no || !x.card_no || o.card_no === x.card_no);
      });
      // 취소일 이전(같은 날 포함) 가운데 가장 늦은 승인 → 없으면 가장 이른 승인
      var before = cands.filter(function (o) { return o.appr_date <= x.appr_date; })
        .sort(function (a, b) { return b.appr_date.localeCompare(a.appr_date) || b.row - a.row; });
      var o = before[0] || cands.sort(function (a, b) { return a.appr_date.localeCompare(b.appr_date) || a.row - b.row; })[0];
      if (!o) { dropped.push(drop(x, 'cancel_orphan')); return; }
      o.left -= x.amount; o.cancels.push(x);
    });
    var kept = [];
    orig.forEach(function (o) {
      if (o.cancels.length && o.left <= 0) {
        dropped.push(drop(o, 'cancel'));
        o.cancels.forEach(function (x) { dropped.push(drop(x, 'cancel')); });
        return;
      }
      if (o.cancels.length) {
        o.cancels.forEach(function (x) { dropped.push(drop(x, 'cancel_partial')); });
        o.partial = o.amount - o.left; o.amount = o.left;
      }
      if (o.amount === 0) { dropped.push(drop(o, 'zero')); return; }
      if (opt.cycle && o.appr_date.slice(0, 7) !== opt.cycle) { dropped.push(drop(o, 'month')); return; }
      kept.push(o);
    });
    // ── 파일 안 중복(서버 unique 와 같은 열쇠) ──
    var seenK = {}, items = [];
    kept.forEach(function (o) {
      var k = o.appr_no + '|' + o.appr_date;
      if (seenK[k]) { dropped.push(drop(o, 'dup')); return; }
      seenK[k] = 1; items.push(o);
    });
    var me = norm(opt.me);
    items.forEach(function (o) { o.owner_mismatch = !!(me && o.owner_name && norm(o.owner_name) !== me); });
    var mis = items.filter(function (o) { return o.owner_mismatch; }).length;
    // ── ERP 합계 대조: 「합계」 줄(N) 승인금액 = 승인 합 − 취소 합 ──
    var fileTotal = null;
    sums.forEach(function (rr) {
      if ((tx[rr] || []).some(function (c) { return norm(c) === '합계'; })) {
        var v = num((raw[rr] || [])[cols.amount]);
        if (isFinite(v)) fileTotal = v;
      }
    });
    var approved = orig.reduce(function (s, o) { return s + o.amount0; }, 0);
    var cancelled = canc.reduce(function (s, x) { return s + x.amount0; }, 0);
    dropped.sort(function (a, b) { return a.row - b.row; });
    var out = items.map(function (o) {
      return { row: o.row, card_no: o.card_no, appr_date: o.appr_date, appr_time: o.appr_time, appr_no: o.appr_no,
        merchant: o.merchant, amount: o.amount, owner_name: o.owner_name, biz_type: o.biz_type, biz_no: o.biz_no,
        supply: o.supply, vat: o.vat, partial: o.partial || 0, owner_mismatch: o.owner_mismatch };
    });
    return {
      ok: true, header: { row: hd.row + 1, hasS: cols.s != null }, items: out, dropped: dropped,
      erp: { found: fileTotal != null, fileTotal: fileTotal, approved: approved, cancelled: cancelled, net: approved - cancelled,
        ok: fileTotal == null ? null : fileTotal === approved - cancelled },
      owner: { mismatch: mis, all: out.length > 0 && mis === out.length },
      total: out.reduce(function (s, o) { return s + o.amount; }, 0)
    };
  }

  /* ── 다시 올리기 계획 — (승인번호, 승인일)로 맞춘다. 손 칸은 보지 않는다 ── */
  function same(a, b) { return String(a == null ? '' : a) === String(b == null ? '' : b); }
  function plan(existing, items) {
    var byKey = {};
    (existing || []).forEach(function (e) { byKey[e.appr_no + '|' + e.appr_date] = e; });
    var seen = {}, inserts = [], updates = [], same0 = [];
    (items || []).forEach(function (it) {
      var k = it.appr_no + '|' + it.appr_date, e = byKey[k];
      seen[k] = 1;
      if (!e) { inserts.push(it); return; }
      var cs = ERP_COLS.filter(function (c) { return !same(e[c], it[c]); });
      if (cs.length) updates.push({ id: e.id, item: it, cols: cs }); else same0.push(e.id);
    });
    var missing = (existing || []).filter(function (e) { return !seen[e.appr_no + '|' + e.appr_date]; });
    return { inserts: inserts, updates: updates, same: same0, missing: missing };
  }
  /** 서버로 보낼 한 줄 — ERP 칸 + 열쇠 + src 만. category·purpose·note 는 절대 넣지 않는다(upsert 가 손 칸을 덮지 않게). */
  function toRow(it, username, src) {
    return {
      username: username, cycle: String(it.appr_date).slice(0, 7), card_no: it.card_no || '', appr_date: it.appr_date,
      appr_time: it.appr_time || '', appr_no: it.appr_no, merchant: it.merchant || '', amount: it.amount,
      owner_name: it.owner_name || '', biz_type: it.biz_type || '', biz_no: it.biz_no || '',
      supply: it.supply == null ? null : it.supply, vat: it.vat == null ? null : it.vat,
      src: { file: String((src && src.file) || '').slice(0, 120), at: (src && src.at) || '', row: it.row || 0, partial: it.partial || 0 }
    };
  }

  return {
    HEAD: HEAD, REASON: REASON, ERP_COLS: ERP_COLS, MAX_ROWS: MAX_ROWS,
    parse: parse, plan: plan, toRow: toRow, sheetRows: sheetRows, fromAoa: fromAoa, looksLikeSheet: looksLikeSheet,
    ymd: ymd, hms: hms, num: num
  };
});
