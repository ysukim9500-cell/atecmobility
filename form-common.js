/* =====================================================================
 *  form-common.js · 전자서식 공통 모듈 (대폐차 확인서 · 설치 체크리스트)
 *  - Supabase(REST/Storage) 연동, 세션, 서명패드, PDF 생성 공통 유틸
 *  - 외부 라이브러리: jsPDF, html2canvas (각 페이지에서 CDN 로드)
 * ===================================================================== */
(function (global) {
  'use strict';

  /* ---------- Supabase 설정 (index.html과 동일 프로젝트) ---------- */
  var SB_URL = 'https://eiyksjcqntenmetmhmij.supabase.co';
  var SB_KEY = 'sb_publishable_9xO2pBxLIpMvxbFmQPw1hQ_qtHN5Rm5';
  var ADMIN_EMAIL = 'ysukim@atecmobility.com';

  function headers(extra) {
    return Object.assign({
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json'
    }, extra || {});
  }
  function cloudAvailable() { return SB_URL.indexOf('http') === 0 && !!SB_KEY; }

  /* ---------- 세션 (index.html이 sessionStorage 'atec_session'에 저장) ---------- */
  function me() {
    try { return JSON.parse(sessionStorage.getItem('atec_session') || 'null'); }
    catch (e) { return null; }
  }
  function isAdmin() {
    var m = me();
    return !!(m && (m.role === 'admin' || (m.username && m.username.toLowerCase() === ADMIN_EMAIL)));
  }
  function myEmail() { var m = me(); return (m && m.username) || ''; }

  /* ---------- REST 헬퍼 ---------- */
  function restInsert(table, row) {
    return fetch(SB_URL + '/rest/v1/' + table, {
      method: 'POST',
      headers: headers({ 'Prefer': 'return=representation' }),
      body: JSON.stringify(row)
    }).then(function (r) { if (!r.ok) throw new Error('insert ' + r.status); return r.json(); });
  }
  function restSelect(table, query) {
    return fetch(SB_URL + '/rest/v1/' + table + '?' + (query || ''), { headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error('select ' + r.status); return r.json(); });
  }
  function restDelete(table, query) {
    return fetch(SB_URL + '/rest/v1/' + table + '?' + query, {
      method: 'DELETE', headers: headers({ 'Prefer': 'return=minimal' })
    }).then(function (r) { if (!r.ok) throw new Error('delete ' + r.status); return true; });
  }

  /* ---------- Storage 업로드/삭제 ---------- */
  function uploadPdf(bucket, path, blob) {
    return fetch(SB_URL + '/storage/v1/object/' + bucket + '/' + encodeURI(path), {
      method: 'POST',
      headers: {
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/pdf', 'x-upsert': 'true'
      },
      body: blob
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('upload ' + r.status + ' ' + (t || '').slice(0, 180)); });
      return path;
    });
  }
  // 스토리지 키는 영문/숫자만 (한글·공백은 400 유발) — 메타데이터엔 원본 한글 유지
  function ascii(s) { return String(s || '').replace(/[^A-Za-z0-9]+/g, '').slice(0, 24); }
  function rand4() { return Math.random().toString(36).slice(2, 6); }
  function removePdf(bucket, path) {
    return fetch(SB_URL + '/storage/v1/object/' + bucket + '/' + encodeURI(path), {
      method: 'DELETE', headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
    }).then(function (r) { return r.ok; });
  }
  // 비공개 버킷: 서명 URL(다운로드 링크) 생성
  function signedUrl(bucket, path, sec) {
    return fetch(SB_URL + '/storage/v1/object/sign/' + bucket + '/' + encodeURI(path), {
      method: 'POST', headers: headers(), body: JSON.stringify({ expiresIn: sec || 3600 })
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j ? SB_URL + '/storage/v1' + j.signedURL : null; });
  }

  /* ---------- 서명패드 (마우스/터치) ---------- */
  function SignaturePad(canvas) {
    var ctx = canvas.getContext('2d');
    var drawing = false, empty = true, last = null;
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      var t = (e.touches && e.touches[0]) || e;
      return { x: (t.clientX - r.left) * (canvas.width / r.width),
               y: (t.clientY - r.top) * (canvas.height / r.height) };
    }
    function start(e) { e.preventDefault(); drawing = true; last = pos(e); }
    function move(e) {
      if (!drawing) return; e.preventDefault();
      var p = pos(e);
      ctx.strokeStyle = '#111827'; ctx.lineWidth = 2.4;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; empty = false;
    }
    function end() { drawing = false; }
    canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    return {
      clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); empty = true; },
      isEmpty: function () { return empty; },
      dataUrl: function () { return empty ? '' : canvas.toDataURL('image/png'); }
    };
  }

  /* ---------- HTML 노드 → PDF(A4) Blob ---------- */
  function nodeToPdf(node) {
    return html2canvas(node, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
      .then(function (canvas) {
        var jsPDF = (global.jspdf && global.jspdf.jsPDF) || global.jsPDF;
        var pdf = new jsPDF('p', 'mm', 'a4');
        var pw = 210, ph = 297, margin = 8;
        var iw = pw - margin * 2;
        var ih = canvas.height * iw / canvas.width;
        var img = canvas.toDataURL('image/jpeg', 0.92);
        if (ih <= ph - margin * 2) {
          pdf.addImage(img, 'JPEG', margin, margin, iw, ih);
        } else {
          // 여러 페이지 분할
          var pageH = ph - margin * 2, left = ih, y = margin, sy = 0;
          var ratio = canvas.width / iw; // px per mm
          while (left > 0) {
            var sliceMm = Math.min(pageH, left);
            var slicePx = sliceMm * ratio;
            var c2 = document.createElement('canvas');
            c2.width = canvas.width; c2.height = slicePx;
            c2.getContext('2d').drawImage(canvas, 0, sy, canvas.width, slicePx, 0, 0, canvas.width, slicePx);
            pdf.addImage(c2.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, iw, sliceMm);
            left -= sliceMm; sy += slicePx;
            if (left > 0) pdf.addPage();
          }
        }
        return pdf.output('blob');
      });
  }

  function toast(msg, ok) {
    var t = document.getElementById('fc-toast');
    if (!t) { t = document.createElement('div'); t.id = 'fc-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;padding:11px 18px;border-radius:10px;font-weight:700;font-size:14px;box-shadow:0 10px 30px -8px rgba(0,0,0,.4);transition:opacity .25s';
      document.body.appendChild(t); }
    t.style.background = ok === false ? '#b91c1c' : '#7A0B3C';
    t.style.color = '#fff'; t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.opacity = '0'; }, 2600);
  }

  function todayStr() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function stampSlug() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  global.FC = {
    SB_URL: SB_URL, ADMIN_EMAIL: ADMIN_EMAIL,
    cloudAvailable: cloudAvailable, isAdmin: isAdmin, myEmail: myEmail, me: me,
    restInsert: restInsert, restSelect: restSelect, restDelete: restDelete,
    uploadPdf: uploadPdf, removePdf: removePdf, signedUrl: signedUrl,
    SignaturePad: SignaturePad, nodeToPdf: nodeToPdf,
    toast: toast, todayStr: todayStr, stampSlug: stampSlug, ascii: ascii, rand4: rand4,
    CENTERS: ['강남', '강서', '강북', '강동'],
    MODELS: ['B700', 'B710', 'B800']
  };
})(window);
