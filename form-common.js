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
      'Authorization': 'Bearer ' + ((window.AtecAuth && AtecAuth.token()) || SB_KEY),
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
        'apikey': SB_KEY, 'Authorization': 'Bearer ' + ((window.AtecAuth && AtecAuth.token()) || SB_KEY),
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
      method: 'DELETE', headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + ((window.AtecAuth && AtecAuth.token()) || SB_KEY) }
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

  // HTML 노드 → A4 1장에 '꽉 맞춰(contain)' 넣기 — 항목 많아도 한 장 보장
  function nodeToPdfFit(node) {
    return html2canvas(node, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
      .then(function (canvas) {
        var jsPDF = (global.jspdf && global.jspdf.jsPDF) || global.jsPDF;
        var pdf = new jsPDF('p', 'mm', 'a4');
        var pw = 210, ph = 297, margin = 7;
        var maxW = pw - margin * 2, maxH = ph - margin * 2;
        var iw = maxW, ih = canvas.height * iw / canvas.width;
        if (ih > maxH) { ih = maxH; iw = canvas.width * ih / canvas.height; }
        var x = (pw - iw) / 2, y = margin;
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', x, y, iw, ih);
        return pdf.output('blob');
      });
  }

  // CSV 다운로드 (엑셀 한글 BOM 포함)
  function downloadCsv(name, header, rows) {
    var esc = function (s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [header.map(esc).join(',')].concat(rows.map(function (r) { return r.map(esc).join(','); }));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
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
    SignaturePad: SignaturePad, nodeToPdf: nodeToPdf, nodeToPdfFit: nodeToPdfFit,
    downloadCsv: downloadCsv,
    toast: toast, todayStr: todayStr, stampSlug: stampSlug, ascii: ascii, rand4: rand4,
    /* PDF 머리글에 넣는 회사 로고. html2canvas 가 캡처할 때 따로 받아오지
       않도록 이미지를 그대로 품고 있는다. */
    LOGO: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA3AAAABQCAYAAABYrpd8AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAD8/SURBVHhe7Z0LmCNVmf4/BRVE/14Q8YKoeEVFFBZdFR1XRRFmJlWVZDpVlUzPpVOVpKc7VUl6LiI0F2G9oOt9RXSX1VURFK+4sLiwIoqw3KY7SXenexgYhrvcrwPD5P+8VQlkTjrVSaqSVLrP73neZ+aZyTlVdVJJvrfOd75DxOFwOEuAMtHztlH40CKJxxVJ2DBD4leLJP5qisSriiQWiiRuL5Jw9xSJ90EFEu4pknBrgYSpKRL/WiDht9MkfaNIolkg6YRZCr21TOF92ONwOBwOh8PhcDgcDqcNYLLmSFpTIum8aZImp0h87BYKl++ggfKdNFDeSavKO2hVeTuFyzdTqDxHwb2Ef9tOofIOCluvRRu0vZXC5WkSd82QODVDwZ/MUVgrUehd7PE5HA6Hw+FwOA24gpbtO0viUbMUDNxMqz5zK0mHsa/xO9tp2X5FEsVpkgYKXJ4IY5mn0CvZsW6VPIVfOEehI2ZI+tQUiaFJEiPssZaadlBYnqLAEexY9RoYqRJJm6dJuhomC4YLgnErUbA8RWK56FLoY4Yky9zdXjGD0yQ9M03iDdMknTlLq45iz4vD4XA4HA6HU2GapOQcBQt4Yo6n6XhaXiLpiTkK/n6CVv4D+3q/kqcTXlMkYfddFKlcB5cbIbBG4D5DwQ+yY90seQq8b4ak75RImp0myTIB6Pu2eY631PQYxcoFEs5mx6wX3ETHHVAiUZ2l4GUzJD19p/UZClsmizVfnRKOhZm5u2jAMoolEq+aI0m7lU58BXu+HA6Hw+FwOEuSCyi8T5GE8+8huZLSJFlPxqESSdZT8e0U2pUnUWXb+pEJWnFwkcQHYESr18HVvhBQ4z6YomDLJv63tPzFsyR9Y5Yky1Ajla72/uISy3dTBMblC+zYdZMiCQfOkTQ2S8E5GHakOXbTtDUS7hWYXHwHzZK0c5aCZ5RIPIQ9fw6Hw+FwOJwlRZ6Er9xHihVMsgEUVCDRSnHaRsFn8iR8gG3vNyoG7v5ZCtZdC1frQhCNYL5VA1ck8bWzFLz2XpItA8j2y2ULxrZXBg4Ge4aksTkK3o7zwOecPT+/aBuFrLGao+B9cySdeR0tfxV7PRwOh8PhcDiLngJJH0PQhlQlNmCqFUwcnsoXSdyKdXJsP36CGzhv1Y6B206Bl0+TOFExJ1wO6pWBw7rGWZKmqzOj7Hn5VZhZrxi522ZI0tjr4nA4HA6Hw1m0lOj4FxVJnEaKEgwaGyjNJ6R7TZAwzvblJ7iB81btGLhJEi+4hyJN31dLWd02cP9HwlvmKPgrPJBByjR7Pv0iPHhCauU2Cl4+SeKR7HVyOBwOh8PhLDomSfhiZf1N08JM3RwFn0ZRCrY/v8ANnLdq1cAVSPgszAHasX1x1aubBm6KAmu2UfA+FCdplDLdb8KavTkKPj5DUpa9Xg6Hw+FwOJxFQ4GCH8SatoVSJ1lhRuV2O5XymjLR89l+/QA3cN6qVQOXJ+FPCKrZfrjmVzcM3F8ptH+JpO+jmijSJRfTzCiupZpWWSLpomtIOJC9fg6Hw+FwOJy+BmvYiiTchBLu7QZylaBzE9u3H+AGzlu1YuCmaOU7pkjc44cKhv2iThu4v9GKN89S8GpUme3GrChm9vD+4/NXFR4UVauPsq/3SujbXhsXmrrRxxkCHA6Hw+FwOC0zSYFTW02dZIWgbI6CT86QcDjbf6/hBs5btWLg8iSuxSwP2wdXY3XSwGH/RhT76NR7AtOE2S88DMJ6NKTOVmb49hRIfKxI4qMFEh4tkvgEKpFizR1eV90Q3GujXy22tI1CD9xEK45nx4PD4XA4HA6n77iJVr5/GwWfdmtu7FTKgXKehCvZY/QabuC8VSsGrkjilxGgs31wNVanDNxNtOITMDJuZtobCaYNJgwFkKZIvK9IwuXTJH4ZBh6VbQsUfHeBpDfmKXxonpYfOkPSYSUKvr9EweVFEs1pEs+bIWlymsRncL9gs3CvZgdxrTCHN1PoqQIJq9hx4XA4HA6Hw+kbylR+Htau4Qm1VwEdgs+tFDDYY/WSPJ3wmiKJz2CWEdfaK3lR4a+6Bx/bdzeFQB1B9gwFP8iONUuRAue4NXDVAJw9j8WqJ2g1rvtsdizdsJUCn7yZQo/hHvTqsw5tr8yglUj6+ywF/32aJGGOxFezx2+GMtHz5kh8zwyJuWmSrp6jkHWv4WGB23NGe8wEbqPQnkkKDLDH5nA4HA6Hw+kLJkjY4jZ1khWexM9S8LFJEt7CHq9XTNCJryiS+IsSBS8pkthL/c3tup/KBtgT8/TdNU2TeMmM9Xfh7exYsxRJ+J5bA2en1Qk3sOexWHUXRTC2g+xYtsskLT/mZgo+5JV5Qx/YRNs2bsFSiYLmNooczB7XLdMUPnaGpP8skfQ0jNyUyxm56nlvo9AzExQ4gT0eh8PhcDgcjq+ZJOHwWZJ2eZ1WiCAJwVaehMvYYy51Zkg8EgbXTWoYKn5Okxhm+/Yrbg0czK6dThf4JNs3Z2FupMCbSiTdiTH0wrzh3sWWAyUK3l0iKX0THXcAe0yvKVipltIvkZ6JmVg311Gdwd5GwUcnSDiaPRaHw+FwOByObymSeCXWrLkJhhoJQTeCvDyJOnvcpUyRhA+5NXBIsZsmKcb27Ve8MHB26qmwnO2b48wOCu0/RdL1eKDi9nNeTUHE+rkSSf8xRStfxx6v08yQIM1RcBvStN3MYuNaYAZLJN09RaF3sMfhcDgcDofD8R1FChiVQgkdE1KVSiQ9OEmBN7DHX6pMUeDDXhi4Iomr2b79ilcGbooCK9i+Oc5MUuC8ezz4nMPwwLjNUeiBPIkqe5xuch0tf1WJxPPtWcDW18bh9UjJxT25nUJ3FUj6FHsMTusocfOINSMbvyxr6S8puvFFVTfOlnXznFoNjm4+V9VNsbadrJsnrBnZXGln/rOimV+XNeP7te1WD499P5LIvL+2XSfRNO3F6sjGQyJDxrtxXEjVs+8K6ebrQ6a5P/t6r4mmzOOfGxPji7KW/oqSyHyvdkyiw2PfxzmxbZvgebHU2AlqIneWqmX2GudOCOe5St9wZO0JDI6P76foxpfVZHbe40eTY9+PaMZpONdqGyVpHKYmMnWvrdXgho3nKglTqT2WW2RNe1U0mVutJnNfU5n7slfCeaiJzFnRVM5VVd1wKvUSWTO/piZydceoanDD5nOjmunqOCzRRPbVimZ8T9Ubv5+xDRvPlbX0h9i286HGM+vw3rN9VKVW/xwaOYRtu1hZFTeOwvcmOxa1wvexvH60raUE0WTmw2oye4rTe9hN4X6J6GacPc9aotHsAbJmfqXR9w5kjVnC2My29Q2o/jZLwUdhJNjgxkshUEKQlCfh9+w5LFW4gWtd3MC1x1YSBjHz5uZeg6op0XMULN5E4nvY4/SKKZI+j7RQfJ5aMXEwoni4NEvSd2AG2X77nVhy4+FqMheNJrNnKpr5cyVh/lHRzb/KmnmjrBl/URLmfyua+VMlkTlNTWVXyaNjb2P7aIdVuqHqm04rr01/rkZb9lJi8xllRU9/s7adEje/m9z8Bcd22tipZTluRmrbeYk6tPEQNTUmq4nMv6qJzFWyZuxUdPMRWTOeUROZMoS/K7r5sKybt6mJ7J9jyey3o4lsZLVuvp7tzy2Kbn7TcUyMz5XjufGyGjdOZNs6ER5KvS+Wyl29ZnRLeZ1xUt04ey+c56nlyJAR2us8NO1lsm48MZQ5ZZ42W8rx7HhZ0Yw7x8fHn19tM5AwPrrePLm8zqi/P6pKbDq9LGvmj2qP5QZZT6+OpcbumPc96LHw/q0Z3VyOpXJX4kEDe+7NsHZky0GKbu5Znzm5rv+qEpusz+zpbFs3yFrmnWtHNjveg/rG08pRzdDYtvMha+av8d6zfVRVvWdWxceOYtsuViKpjIzvTXYsaoXv44hmtFTtOrJ+9OBoKnvR6g0bHd+/bkvfeHo5omUuZs+3FmF484GynnlqyOF+13KnlhXdnGLb+oY8iX/0IqWqGSH4xrEmKdA3KX+dhBu41sUNXOvMUuANmP1GyiM7nq3IfghjzXRdcwMdfxB7nF6Tp8AaXONCJg7/h9cg62CWgteWSFjG9tXPYCYmlsycoSYyN6qJzDMI0BFw4s/Bkc3lwZFNZfzg4s81I5utf7f/fzPMyS41kbkmlsptVlLZN7J9N0tEN0LoT9HNhoLxwIxSbTs8EcW5sK+tFc5b0dJSbTsviA5njosmcxeqiczD1THBsWKpsXI0mS2rCcg2cGoya/0b/g+vqY6vksg8FE1lz48msp9g+28XzEQ6jkkiY72fatz4NNu2EasSo++JpXL3O/bruXCem8qReHpl7bmoIyP/T9bNOzCW9W3M8urhjbhPpmoNHGZjosmc9V6wr68KAZism/9ae6x2UTRDw1hhnNnj+En4TEVTuXthithrWAhZy7xK0Y37oqlcXb/P9m/dL+ktbFs3yPrY2xTN2IPPF3u8qqzvprjRVCEvRTP/E+8920dV1XtmlW7uNRPciKhmrh0c2fQtWTe+0Wspicy3rJmuDWMfZc/TCTlhBq3vzXnGoyrcO3I8fRLbthFKcvMr1ERm63rz846fw14I38WyZv6cPedaQuvNV8qaeXfM4X4f3GCN2d/Ytr5gggJ6p1MnWSHAQonx/yPxtez5LDW4gWtd3MC1Tp4Cv8aYO5mahVSdeZsh6dq/0qdfyR7DLyClE0VJGhVjstfjDuD/H54jaWyclu3L9tGvyNqGd0YT2R+ryexTeMqMYLnVH1YYE/zQ42mqmsw+HEuOfbudVKN+MnDyevMD0VTuEtuIbSnDGLDHbFZoiz7wwx9N5f6A1CX2eK3itYGDEZLjxtX2+M/TX8fUnwYumjLfGk1mdsWG5z8/vwmfXVlLY//dZ1NOm4EbuPlRNfMSzOiwszO90ees97f6/TKwJtnUkqROGDiktmO2lu3HD1r0Bg6b5+KpPNKH2CCnk0IgCNOYp8Av2XNaanAD17q4gWuNIokn4h5xW+TDLlYSnOqHNMMCCUkUZKr9XOEaqnsHzlLolwWSPEkV9AtRPZOLJXOP4AceM0PsD1E7QoCMYCGWGrtb0TNr2GM60S8GTk1kTo6lcrsRHDmZgVaFvnAdsVQOM5qu1lB4beCUuPlP1hh6eL3NqT8NHO7Jdebn6/r3rSr3g6IbH2GvxQlu4OZH0cwLrdn1efrqlXAN1kO2RGYunEq9hj1nFq8NHFLFFd18ws3Drk5q0Ru4IgkXu30q364QTCLAytPKvXLhlxrcwLUubuCap0zL9s2TkMfaMHYcWxFmzWdJenCCpJbTcnpFnoR/wZ6W+H5DcRM8NELFylkK9c2WG80QjUYPUJPZC2yj1fiHCIKxs1MnN1upk/gTwTFm3djX1io2vNEK3NSk+V2i54JoJ/xu4FB8JJrMXLjOPGlBw4txxbXgvGqfhGMMFxzzlG2Co4nsT8Ph8AvZ82gGzw2cZozjnOr6qRECRDuN1EtV18CN7PW773sDpxtXOwa/mmG9z/XX2xlVUnXrz6NG1ixci8UXuIGbHz8auKqQvriQUQFeGzg5mRbw/cf2wQq/Mez92w3Za+AMxzVwfWvgJmnlansj3PpgrRlVn2YjTaldA4g0pxmS7pom2fdP9DsFN3Ctixu45sF9gTVr7Bi2ItybmH2bIGEV27+fKdP486dIvOohUvE9tWeWpK9N0ImvYF/Xz6D4AwpowISwPzy1wqzHWjsA2SVrZlHRzP9RdPMSWTOvUDSjpOjmbgRmdqBc3x5C0GOvdTB/uWx8fMG0Uz8buFDI3B/FXHA9bN+1gimqBG73qLr5B1ToUzTz85AcN/5FSWT+C/+H1zivjaqMnZ75g6ZpL2DPZyG8N3Dm1536g6GVNfMhVTd1JWHEvFM2FkuNxdiUXL8bOEU3807vL84voht/rr/ezkjWzRSK6jg9eLEeuCTMr7DX4gQ3cPOjaMYv/GrgcA+oicweNZF23P7GawOnJs2o0/d7ZYz34CECe/92Q4Mjm2OKlv4Ye9619KWBK5L42hIF/95uQQMYtsomwFcUSLy93eqV1VTKAgn/yZ7jUoEbuNbFDVxzlCm8T57Eor1nXv04NiP7M2pVjv0Ptv9+YIoCR9xO4YvzJBzL/l+/AxOl6Ob/OJk3BOJWIJPM3hTVsxuwloddF4N+ULVO0TMbo8lsyQ78GgdS1hNf3fhxbR/z4WcDh4DMKSWumv6oJjL5aCqzZr1pNlzzGRvefKCayAypiexUpU1df1VZhlEzW/6989rAwYg69YeARtaMO9l2ncLvBk7WjQknA7cm/blyRDfPYdt1CoyDqhv3Lmy0jC+zbZ3gBm5+VC1zMSo42gWgui1n02WPjXWfO8aAXhs4bM/h9P1eeS/3hEzvq/J6RV8auDwJF9nGqT5ga0aVIiT3TdHKl8I4uCmCAuOCDXQnSVqSwTg3cK2LG7jmmCJxpdu1b/isT5N4Tz+se1tqRLT0t5xmkFYPjyEQ3x1NZDc1M2MGotnsAdHk2D8jWG0YxFXWXshD6TG2fS1+NXCyNrrZybzB9CI1KJrMnL1scHA/tn0jkMoaTWW/jmCqYUpmZewiWtpg2zvRIwN392A6/XK2bSfoewNnB9Dnse06hW20zL83/Ix22MCpLaZmLkQ0tfmtfjZw0Xjmw7HhnKJo6YFuKqIbq1TMtmrG0073Oe4/vI4971p6ZeAiqfa2tOgGfWfgCiSG7aCuPcNQ3QYgT8KzH6QCCZe72YYAqZhTJO5cbOlNzcANXOviBq458iRcgnWm7Pi1IqRf5kkcZvvm9Bbs94Wns41+1FEtL5Yae1yJpz/Ltm0GRU+vQR+NjAgCZ5hDp820/Wjgorp5ZDSVe7rRwntr3Ze1rsMw2bbNImvmJivYbPTepHIY112xZPpwtm0juIHjBq6Wnhs4LZ1h27ohsm7sdX42cL0Enw1FM3Y1+i62x2YL1mEm2La1cANXT18ZuBKFDpoh6W6sPWMDtWZULSNeIOG/avudpdBbZ0l63E0qJYoNTJBwbm2/SwFu4FoXN3ALM0HSYdMkPoXiHez4NSs8WCmQsC1P7RVe4HQGTdNeLGvmtkY/xvjhRMA7MGQE2LatIMfTSXvdx/wBsl3ly/gLm5JZxY8GLqKl/9cpsMNxZc38EtuuVbA+zukarOPE05ey7RrBDRw3cLX00sBhzGXNKMiacRE2zHYrRTd/JevmZXb/jd/LpWrgYtroodzAdYa+MnCTJPzETeokthsokfTI9STVbe6ap0DWbSqlvVZHaOoHaLHADVzr4gZuYaZIcvV5hCrFT/jsm89QE2nDqYJgxRyczbZrB0UzfuYU6FtBUgMj5TcDh1lLp0IEmNFUdPO6Roa0FcLh8D4I+hsHTBnrGlQt80m27XxwA8cNXC29NHCouInZeVwzPt9eqPHn5DnhddzA1V+LPTbcwLVD3xi4PIkrUUnOjVFA0D1JgYZ5tgUSrkbKVrsGEUH5NEnb8xR+Cdv3YoUbuNbFDdzCFEj8X3ze2bFrVnMUwjj/fTsFuhLAcZpjuTX7ZuxoVC2y8u+3RqPZA9i27RDSzddHE9mHGgV0+AGX48a8P25+M3CyZlzRyMAhoMOawYEh46Nsu3ZR4sanBmGqGhgMO+g39spmaUSPDFzXipgAWTN2cgPXHD01cD0SN3DcwHlNXxg4rC2bJnEnUqLYQK0ZPZc6KV7B9l0LKr7NkbQLWwuwfTQre98m4Zts34sVbuBaFzdwzqDKbIHEx9x8DvH+5En4Ads3p7coWibcyIRA1uybbm5g27lB1tJfsY1W/fEQCOFpvLze/ADbzk8GLprIvieazD7TKNivpIP+N9vOLbKWvrLRXkkIcNRE5umBoczb2XYs3TZwGCdZNx6TE+bXZC1zVrOKJXJnybpxxuBg/cwd3q+1xpa6NpCiG19VNPORRmuguIHbG27gnOEGrh5u4OrpCwOXJ+Hc6oa2bKDWjGAwsMZtK6103GcCTJBwCo7F9tGsZkiy9oebpMDH2b4XI9zAtS5u4JwpkBDA7Fu71Ser4ztJgc+wfXN6i6yZFzYKTBB0yZp5v5JMeloMStZH36Yms081CpStipS6UZey6ScDJ+vmKesamFDICsDjZpBt5xY7yJn//YLWpk/Ce7aJbcfSbQMH4f3Ga/AeNauhzMlWwDOop9/EHlPRzJ8nN3+hro2lBbZf4AZub7iBc4YbuHq4gavH9wYOQVglNbEuUGtWMGSTJDiWjK5yHWkvKJJ4IwLIdgyjvcecZUimSzTyIrb/xQY3cK0LBgP7EM7Qyk+xfXOse+osN+O7jYKYBb8H24SwfXN6x7p1Yy+VNeMezHixPzKQvR7N+Bnbzgtk3fhTZY1YnfADJ2vGTezaMT8ZOEU3/tzo/O1g1bgX67DYdm5RkptfIWvmA42qXlopqLpxOduOpRcGrh1ZQaZm7ELQWX9M4wftHpMbuL3ptYFDwIvPoFdyGtuquIHjBs5rfG3gsJZsmsTt7W7kCzNVMQd/K9NzX5wLMUniMXMU2lNykcIF05gnwXU1ML/DDVzrgoHDLG2BhPQMiUfmKfC+flaRxKMmSHonO07tUiTx4so90ZbstsLFbL+c3jJg7UU01jBgXdvEZq7tIuuZkxoF35XAYtcAM+viFwOHoFTWzIecTJQSN3/LtvMKrHNrNA72rKlx30LFQriB4waull4aOPtBiPFvciL9Gc+kZdfa2wg0fi+5geMGzmt8beAmKfAtN+mMWEOzjYJPTdCK97J9L0SBhC+6OTbKn2+j0J4iif/I9r2Y4AaufcHIQRi7fhZmnAskFthxaocLKLxPgcTpdrcKgfDeTJF4Kts3p7fgB7pRUFIJSJ6JDHXmxxLVEu0Adv4AC4FBRDOPr20zoKUlpx94qBsGbiCZ+TCKYzQKDq1jaebn2XZeEdGM0xpdD87JMiHJ7DFsu1q4geMGrpZeGri1xkllVMJl27ohsn7LwXwfuPnhBq5z+NbAYQ3ZdivNrH1jUJkFG2f7boYSHf+iIolTleC0ru+FhDZ2FT1hK9Iy2f4XC9zAtS+MGe7vflelWqQnBu4mEl9dIPEBNwVMcD55EkNs35zeIuuN9xaDQUHVwJXrxjqS9orZNUUzn2wUROC8IpqJoO555XIZqZTPG9DSYacfeKtdNwxc3Ig5nYc1o5DMNtVXO0SGjFWNCplA1rlpmQG2XS29MnAwSAjmm5VlcjSzrKxL1W01BIOzPnNyXRtLDWZHq+IGbm96auCsftNb2LZukPWxt3EDNz/9buCUpHEY29Yv+NLAbafB/bCGDOuE2jVPlTSqm66gZfuy/TdLgaSP3UwhK0hlj9GsKuvvTmf7XixwA8dV2TB7kh2ndpgh4fAiiXva/czhPsTsN9Kg2b45vUXWjfMbFcRY/dw6tI4QTqVeIuvGnY1+6BAQyZrxd0U387JmYpPfgqybtzkF11A3DFxENzY26s+aAUMao15fRdMrFD33ERyj0VhYJkNLZ9h2tfTCwMmasUfRjQdRGAfr+JqRmsg+gP3j1KGRQ9hjKrr5zTWjmx9i21iFd6zjGM+w51AVN3B7ww2cM9zA1dMrA6cmjRNjw5m3q4n0OzohWcu8s2ISW96/05cGLk/CV9ynLwafKVDwg2zfrTJJwjfdVMDEucyRtLtAK9/P9r0Y4AaOy0sDV6DAR7GHW7v3Ez5vBRJ2XU8n1D1B5/QWOW5e2qgQR2Vdyp/ZNl6BjakRQGOvNPbYVSGYRpCLYBt/Ov0oVtUNA6fo5pmN+kMgp+rm7oHhhUv5twu2MLACmQZGwwqadNMxZbnbBs5+74x7UYE0msi+ullF1o8ejD9xv7DHRJGYcCr3GrYNNBAfeYuim3fxfeCagxs4Z7iBq6fbBq5GuxXdeFrRDfzpuaKp7DOybsyOjLRe9NB3Bq5IwoewdgyBGBucNSMYLRiuCQq09MFvBCrZTZF4s/tCKsK1rRRS6Re4gePy0sBNkvBpzHpPtXk/4V4skHh/iY4/iO2b01vkeObyRgbOTsMzOlp4RtEz1zsFse2oGwZO1s1vNgrmKkHRE4PpTXVl770iOpR9s6wZT6sNArDKtX6VbVdLbwyceVfINPdn23aC40dGXqTo5u3cwDUHN3DOLCYDp2nay/rZwFkPyZLZjmn1yCZ89m7tewN3HR2NEv5b3ZbwnyJx6q8U8uyLG1sZoF83JsVOpQx8ju273+EGjstLAzdNAeFWF3vAVbYQuGMbhV/G9s3pLQsbOPMSto2XKJp5g1MQ2466YuDixjcaBXN20Q3zyeiG7JvZdl6hrDUOkzVjN4IN9vgQrhXXzLarpRcGDqmQC1XH9ArMzsm6eQc3cM3BDZwznTZwmGlWU2OfVLRMGMaoU1K0rKTqaV3BAyCH+xz3n6qbKfY8a0F/vTBwnRYqM8u6cXPfG7g8Bc5wkzqJdTN2MCl9jO3bLZMU+OFdLlIpUZRhjqRdeVr5LrbvfoYbOC5vDZwQ4AZucaKgHH0DA1dJofwL28YrxpeN76toZqlRCqWsGWX8H4K7qqwfPs2oe22tumLgdOOMRv1VgqI98oaMZ9t4sER180gYrEYBWCWF8hS2XS3cwHEDV0svDdw646SyrI+m2bZukLXxV/WDgZM17VXRZPZ70VT2ftwP+N7Fd1FHZRsIR62xrjWzhj3fWriBq8c3Bg5rxLBWrN2912CsYLAmKfBttm8v2E6Bl0+TuBPBKnvsZoTzu50GEFxeVW5jsaJf4QaOy0sDVyTxOLcplEWeQulLFC3dMChBgIviIbUBrpcEBtMvx5qoRj90lc3F/wyzhDVn+FPWjIsavb6qbhi4SNzMNuoPgZxVwTOVOZZt5xWRIeMTjvv3pbeU1aQxwrarhRs4buBq6ZSBC60dOUjRzQec+rUCZi19payZX0L/bqUm0I95rt1/4/cSZiGqmWvZc56PThi4gTXJN0RT2eJ68/NW4SOnc+2mrFTCRLY8kEwfzp5zLdzA1eMLA1fZ++k6BPLtznBhjRo2/cbm32z/XlGggID0TjdmpbK1gWPFrn6CGzguLw3cNK34iJv7qVLE5KkbKdCxNUGc9nAK4hHIoqJfbHjzgWw7L7Aqfenm7kZPyHFeEebp+KpE+jP2k+H61z/brhsGbsEy/lvKSsKIse28QhlKr2lUPbR6LbKWFth2tTi995Y6ZOBgrNi2nWBRGLiE+e9su06BwLMTBm5wcHw/VI+tPJCZV/Zs+8a9ZtvdqhkjgM+wrBkr2HOeD68NHO67SDx9Ocwb21evhXPCwzL2nFl6ZeDw2WDfby81lDsFBu7BwcHB/dhzXAhfGLgCCSe5SZ1EsAcDlydxr41YO0GehJ+5SaVEcDpLwcfytOKtbN/9CDdwXN4aOOmd7rcRCJZnKNSxsuqc9lCs/czmD0rsmSQE3ekPse28AGap0fo7HBvpk6qe/nhtm4huhBb6ge+GgVNSuffZT6nnD/RxLFk3zmbbeYWsYw3e/Ndjn1Nmz6pE9j1su1o8N3B6puGeglC1iInZpSImvjdwmjG5oIHTzR+y7TrFunVjL1UT5r0LGTg54by2cj4UzfgZ0iTZ/nopa5ZcNx8KjYw0lRnitYGTE5nP2N+9je+17itjpbOqieyOgWTmDew5s3TbwFXT05GREdGMkU4pNpwbwcPD+SrfLkTPDRzWhGFtWLsb91arTuZJ7MqXzwStOHiaxHu2U6juXJoRzvcOO5XycrbvfoQbuPaFdV6LQXaFViHPjlM7lCh0UJGE+yupkG3JnskXVrF9c3qLEjePwI9io4DVCtg0c4xt5wV2Jcf5A34EkbJmPoS0rto2fjFw0Wz2AGxy3sgc2D/Qxl/Zdl6haMZ1jdaxVNJ/bsPMB9uuFs8NXNw426k/3GOybj4l6+b1sm5c653Ma2PDG69dpaX3WmfvewO3wAycPTONbRfY6+2MFM24wSrN7njt1vv7z+y1LEQkkXl/NJXb0+i96IWwATzSstlzbYTXBk7RjO+ss76r6vt6ts9k1jLy3RC+N62U0uHc5diCgz3f+ei+gbP3gYsMD7+ObesXemrgsBasQOJf7LVh9YFYM9pup07uzFPolWz/nSJPggwThuCVPZ9mhVm8CRIcy6b2A9zAtS+MG9Z79bsqs+ez7Di1A7baKJAwhc81O17NqvLeNP1jyekOmqa9QNaM2UaBJGbIInHv94Jbtmx8XzluzNlBdP1x8SMua8YVbDu/GDgg68ZvEPiw/UAINFQ982R0aIPnlSgHhrCBbebpxqmnOCfjF2w7Fq8NnKKbccf+LKFPu4iCd9psBeMDzHvndwOn6OZv1za4f6pCRdP66+2M8L6wx2dVeaDT1JoxFjlupvB5sT5nDuPbaSGwHrLMm/mHcHj8hex5NqIDBu6iRt8fkF3i37hXjhs/kfXOSdWNnyia+dNYKvulaCrXUsZczwxcyng329Yv9NTAYS2Ym9RJFDqwn7YHHPPvO0GexF8jUGzXeG6jUHmWpIcKJPX1hsPcwLUuGH8YnyIFNuVJOLbfdSuFjy2SeBQ7Tu1SIPF3O12Mb2UtbUdL0nPaAzNhjZ4EIyiJJrO7VyVGHdPxWgWmwA7k6o8J2Wk8psG285OBiww5GxaMqZwwNrPt3CLHzVMbvV+QFRQ2sf7OawOnDm08RNEyTzoFLp2RbQoj8fTKvc7H7wYubip+Syt0UiXl8NHBVO417LU0ixw3g9HhXB7vF8axu8IM0xYYuPtR5AQPr9jzc0LWzF8nNp0+T7+28JnEn6viY0397iqaeaGTgasYoyvZdn6CG7h6embgCiS9DWvB2k2VqladzJNwPtt3N5ih0OtnSHoQRow9t2ZUk0r5X2zf/QQ3cK0LBm6HtW4s8Em2b471cOQLbsbX3sxbuB+VY9m+Ob1FjY8e41zREE/dDU+LKcha+rJGP9TVjbDVoZFD2HZ+MnBI78QamkY/1FjDJ+vGLe0shG9EOJV6iaxn7mhUEKJSKOR+JZl8BduWxWsDB+SEcTJmNxrdS51Rfxq4ZePj+8qaeZUfi1iwwnhYs1baqOsHEjBOseTYsmgik5R1I61qxkinpSTMUSiayAXbTb/D52D1hjGT7XuvY8TTo2zadyOaNHAdS8P2Am7g6umZgcuTcIVtYOoDsGaEGYwSSffOkfhqtu9uUSRxCIFmu6mUaIcxmOwj88LCDVzrqq4bm6JAUxWplhqTJCyHwW33cwXtsO+pE9m+Ob0noht/ahRMYB1GLJXbrcaNpp4sL4QyNLocP/qNgmRrViJu/AfbDvjJwAElbnzXaRYFxxwYSm9i27VLRDPG1zlch7WfVtz4BttuPjph4ICsm+fgPFDhD2a8usayc8paqb4DQyOB2vOwDJxm3A2jVt8mYwdRmlGqNXAD8ZEPw/A5nbc1s6qb59Qeq11W6+br1WTuBpg4a6wdjttIzaYjsu2aEcYBnzfrHteM77Dnz2kfbuDq4QauTQokJDB7xgZdzQqBHdbN5UlU2b67TZ6Ey9ykUsKIzpB0/4104uvZvvsBbuBaFzdwztxE4qsLJD7cbmEjCA9G8iT8iO2b03uUuPlPTqbKqhaZyFwfDoebXjMyH5gZUhOZWxqtubMC52T2KTUx9g62LfCbgRvQ029SE9knG1Xuw7/HUrlHZW2D6029UXAmmso9gRki9jjVY6mJzGMxbfRQtu18dMrAgWgiG4kmx65SEuajCLieNRodkW3gGszA3RnDTFtdG9vAybo5zc7AwcDBSLGvrwr3V0Qzvld7LDdEo9kDoonMadFktoR1kzhG0+PFvmfNiO1jHlW/B1Q980h0OPcnVTd4ASqP4QauHm7g2gBrvrD2q93UQ6iyIfaFbN+9YJICb5gl6T4PUkEX3AfDj3AD17q4gVuYIol/xJ6L7Ng1K/vzKDxYJKEj+4px3CHH0z9faDZJ0TLzzow1A1KnlETmUifTsM5KJ9vbfNXiNwMHZM04yykNDjNRaiKzVVEWTmtsBIICNZEtNtp2AcLYyXHjZLZtIzpp4KpghsmqdBo3jkIlwk5JHR47KqxpL6s9NkqARxPZ9zQ6NtrEmI2KYaZi87y2Vkoye3QzJdZbBQ9Hohuyb8YWFewxGymqm0fKmvlzpz0JkWJqVyY1N+D1bB/zCWOmDJtHRIbH2ko3bAVFNwKx5FhC0Qytn6Tqpo6iH+Fwqq19jrmBq4cbuDbAmi83M1az1j5P0v0zJB45QSe+AgFaL3U7LX9xnoRTEGy2m/KFdpViLAPsePkdbuBaFzdwC1MgcfROF7P0kN1eyLB9c3pPZP3owWoic2flx2VeIeCPJjPnLWtxXVcsNnygmsxe7GQYKsHMZMhhnzA/Gjicr6KbRafzssctezXGmG2/EJF1w6+LJrPXOFUsxP/JunljeLyFqnpdMHCczrPQ/nv2GsGNdXsq+gVZMwpabryurL3fhbWQeKASS+W2oQIre10LwQ1cPdzAtchWCqxxW34fRqFAwhNFEnYWSLy32GMVSLinSMKd7Hm2KuwrN0PS3UgfY8fNz3AD17q4gVuYPIUPnSLxyZKL+8qu9CnuuI6Wv5jtn9N7IutHj8OaIacfH8uMpHLXRVPmgiWnkZ6mJDMDajIzh4CH7auqyjEfjawffS/bRy1+NHAgsm4E+1w9gcIlbL9VIViLprLb1ERmr1Q/J5RkVlKT2VudAj1r7JK5R1R95F1seye4gVscyLr5bcf3sWLglET6s2xbPyBrxtVOD438LoytvfZ0tKVtcriBq4cbuBZA1UbMnFWCKldCAAzT4Be5WatTVTWVcpKEn7Bj52e4gWtd3MA1R4GE3+CBDzt+rQifqQKJObZvjj+Q48YQfpQdf4BGNlWq+GX+hsqDatL4dGTIeDc2gI0mRt+jJDLLVT1zhprI3oSn1I3WvEFYoxQbHtstrx89gT0XFr8aOBAZMkK4zkZVDyH8PxRNZP+oJjLrsKdb7Ywj/i5rmXeqicyQkshcUX09209VSI3D+8Cu/2oGbuAWB9zA9V52sZctZXm9ueB3WBVu4OrhBq4F8iT8qhJM1QVZXLZggpCKOdGDfe3ahRu41sUNXHPkSTzeTWoyhLW2eHBUJPG1bP8cfzCgGdpC5gGFDvBDhODx2ddpxi78u73PU82/NxDMXXR47AlZSzf1/epnAwfkofRqGCqn67bGbWSzHfBpxtOKZuxQdHOrJfvvu/F/eE2jojJQxSw+MxA3FfY8mqEXBg6FRZS4mVUT2TFZM30tRTc2RpOZnJLIxrCWjr0Wv8ANnD9UMWNN79vGDVw93MA1ySSJERQecROILRXdQmGYoTuwvo8dRz/CDVzr4gauOco0/vwCCTdVtgRoS3hgVFlzewHbfz8wRcLRO2nVlbMkfYb9v8UEZnViqdxd9qbajY2EpZqy4/ZrnV+PKn/rzJOQ+je7ar3xEfbYjfC7gQMoyhBN5f6+0PEga4sGzKJVzLK1H5+9D56DMmVsJRBNjd2jxNsPynth4FCkA+OMoi84dn9oS1lNZp6JDef+uCo+egx7Tb2m/w2cWdRyp84z7v4SxlDWjHnG1xa++2TdfAxrVtlrnA9u4OrhBq4JsE/bDEn3eJE6uRT0XFXKwA/ZsfQj3MC1Lm7gmqdAwiq3aZTVbUewBpft38+USXvBNEnXP0CK9WBnhqQfXk8rm/rB7kfCsdFDo4ns+QheUChjYXPhLAQ5CIaiydyeaDL7PSE23FJF0n4wcEBeM/q2aCp7qV3owDnAaUXoy15Ll/t9aGjDm9njtkIvDJySyr5R1s2nKpu1943wUAJjFRseewx7xbHX1Uv63cChAEhseOMZSjx9um+lGeOyZv4OD1jqx/e5ewRjHR5Kv4+9xvngBq4ebuCaoECBn/LUydYEM4SNjAsk+PJLsBZu4FoXN3DNg1m4PAnXu9lSAEIq5SwFH99Kyz3ZILobFEj8fvW7E58v/H2OQncUSWi5Clk/EU1kPxFNZn+NPdrwg4yy5fiBcp5tw6ycPcNkV237XFlN5B6NpsZ+osazbc1k9IuBqxJL5BRs1Ix0SMsAYI+xhWYza4TXYvzQ1ko3TeWuQ1EY9jjtwA1c64IhlzVjUtPOeQF7bb2i3w1cv6DqGdlpm5Xq53qVbh7Jtp2PZgycrDWfktkLemXgQrrp2z2aO2rgiiSKCM7dBPdLVQjwp0nanqdwW/t+dAtu4FoXN3CtUaDAJ5FG6eYegwlCH7MU3L6VxEPYY/iNSQpstCv2PnfNuAZkMuDf5yh0aZ4CTT197VcGN6DARnZM1c3LFN28017vtvFZg1YVfoQr68D2KLq5Q9XN30UTmWFsfM322Qr9ZuAAKnGqyeyJ0VT2x0oic1vVkNnjtMUywzi2NbtWWRtX/X97c+7srbFU7t+w5xQRPY/tv124gWtD1vrFTWVVy3ySvbZewQ1cd8BModM4t27gjIucDBw++4pm7MQ+k73Q6uGNX47G0x9kz7sWrw2cmjSjzt/vzz78Opc9324IYxLR0zJ73rV0zMBhDdcMSXcg9YcNpria090UKU+Q8B12bP0EN3Ctixu41slT4GduZ/LRFqmUJZImr6YVLe+R1S0KJCQwA19qUN22mhI6R9KuWQqecSkddwDbx2KjUpDiCBgLNWEMRjRjRNUyI3Lc3KAkjFh0OHMcNkrWtHHPtozoRwNXy7p1Yy9VdOMjimYk1ETma4pu/ELRzUvxpB1SdPMSRTcuUPXM2QgYI/H0B6PZbEfupV4YOBh49I3tFmDi/KZmUoTXplEyvvkN0zuNrGfOdpoZqho4OTV6LNuW0zxez8DJmvEDx89fTcp5L6RvPL2saqbBnnctXhu4mG6egEwDtg9W+A1gz7cbwpjImvkH9rxr6ZiBmyTh39wGXEtdMyRZa1/yJH6CHV+/wA1c6+IGrnVQRXKGpL9jv0R2PFsRvo8wgzVL0sR1tPxQ9ji9Jk/iCO4NbE3i9N2J/8Nr7LRKqTBD4olsXxx39LuB8xO9MHAxbdOhsm48rCYzT8i64SspmvG4oplP1o0DIyuNUjf/lb22+cDG7epwdjCqm6vljshQZd34Y2W2u6GsdGfdONt+PduHe+Ea5bgZDIfD+7Bj0ApHH330C2LDGz+jJLNbZN08VdXNU/wgOZE5WdHN3zjt89jqGjhVz4YcP389ljU7qBkJ9rxr8dzADQ8fqOjGg05bsfRSduVg8+fsedfSEQM3TcJn3aY8cVXTvhDoizM7KPTs/j1+ghu41sUNXHvkaWXIi5Ts6kzcLAVvKdBKx7SNbjJF4pcq5+Vo3ljhXoLmKPijaynwBrZfTntwA+cdvTBw4+Pj+1qzcEnjsOhQ9s1+Es5Ljo8Go8nq2s55xqRi4CKa8T322uZjQMt8cn3mZOvpPe7bTsgKFB2qI1ZlpzrXt/dCuEZZMx8IhZ7b07BVlLjxqdjw2FakEbMzH35QU1UoNePxyLqxpopahcPjL5R1YwJ9s335Qb0wcECJm6cPZU6u68cP6omBm6KVL8XaLQQUbKDRrBCg4Un7dgr3vTCDhgIK7DU2KwRySKUsUOCr7Fj7AW7gWhc3cO1TIOHb91CkbkxbVfXhyCwFn5iioOMPR6fBTOAcBX+P2bR2P0doh3vyZgo+0g/Fj/oBbuC8oxcGzu+sihtHNWPgmp2Bk+PmMmtrCIf+FoNwjbJm3DI4OL4fOwbNoCRGl8eGx3Yv9Nn2sxDcR+LGn9lrcyKyfvS90VTunqa2aumyemXgjh8ZeZGqm3+AibPWAc7TZ6/UEwOXp8B3bcNRH2Q0IwQilYX7xQKJhWKfK09CvkDCbW5MHFIpUbxgkgK+KikMuIFrXdzAtc91pL2gSOJVlb3d6sa2FaE97l3Mem2j0C/ztOKt7PE6zSyFVs9R8E63WyXgWvA5miHxlgmSDmOPw2kdbuC8gxu4emQt/SFu4FqXGwMXTWRfrerm/QsZAT8Ls29WcK+bJ7DXtxAD69OHR1NjlyJt8LkZPxQy6q3sNXDprq6BqxIOh18YTZhfjaZyD6+xzsc/YxLp5hq4SZL+qbJfUV2A0axs8yd8rUzhfVBC/AIK79PPGqfx55codFCRxG3tzkoiOKuUUZ/IU/iF7Lj3Em7gWhcMHGZ/pn28ttHP5Cn8mlmSbsZ949bEVd+Pyrq4B0sknlwkoaX9wtphmoRjZ0m6FNeAhzNurgNtK+vm7s/Tynexx+K0Bzdw3sENXD3cwLUnNwZOThib15mfr+uzX4TPCGbQIvH0mey1tYI6PHbU4PCYJmvmmBI3s71WdENuY3SBgiydMnBVULVWTY3Jqo/GRElklrPnWYtnBu6vFNrfXquF/cvqg4yFVE1pKpI4dzst96ySmF8oknhcZWuAumtvVjC3eRJcfXC9hhu49lQiCff8n/MknJ8n8eeLXbdS+JcFkjzZUwrcSCvePUfBe7HWtp3vG1bV2TikMc6StHOOpFOmKeRq82IWPNCZo+BnSyT9Zo5C5dtplWUe2XNpRThvpJtvo9CTEyQsY4/JaR9u4LyDG7h6vDZwA+vTH8cYWhUuE9gXcXHKKqKiGTvaMnC6eanjZ1ozynhPrC03fCTcB6iYGEvltiuaobHXtRTotIHrRzwzcJMkfA0Ggw0wmhVm7bBmzM8VF90ySYFz3KSXIujfRsHdRRJ9sxnxUjRw2GDZrYHDPYDZaqTvLQU9SathVjxdx7mVVvzjHAUf8MrEVYV05zvt9WiPlSh4UYmC0SkKtLWnGIoPzVLww9MknjFD0iQe4mA83HxeqqreQzdTcNcEBVpOp+E4ww2cd3ADVw83cO2pUuDjtnYMnKIZ11QC2nkVG7bM4Q2Klk2oupnygxQtMxxN5JKomBlOpXy9L3An4QauHk8MXJGEDyENqN3USQQiMDaTJHyb7XsxsY3CL5smaUe7e+NV17kUSLj+Clq2L9t/L1iKBq5IwlfcGrilJsxsFUn8AjuWbrmRhA/MUfAur9Ipa4V92NBvxXA9Nk3SNdMknlMkYUORhOWTJB6DlEVokoTDJ0k8coakjxUoEJsi8dQiib+eIvEWfD5wv+Bz73bGrapqxsLNFHyUm7fOwA2cd3ADV4/XBm7lurGXqsnsMRHN+IfFLOsak6Pvxab17BgshKwZVzsZuDVpGADjJ2w7Tu/hBq4e1wauTOEXTpE0iTVa7QZQdkEH8ZY8hRf904VJEpa73WLB3uA74IvNPZeigStQYL3bohNLTZ0ycOAGWvmuOQrOVI7REcHM4XsK7zv03F5twp4CCc9A+AzgQRbuZxi26vo2N5+N+YTvWZhKFD+ZpBUfYceD4w3cwHkHN3D1eG3gOAuzoIGzK/9dyLbj9B5u4OpxbeAmKXCWm9RJBDd4kpwn8Xi278XKBAk/cpNKicBxjqRdBQq+m+272yxFAzdB0junSNzT7ozzUlQnDRy4mlYcXKLgZdhiAO9Lu5+tZoWZNNzzOFZVdgVd+//Y13slHAPfHXMUvO4Gkt7GjgPHO7iB8w5u4OrhBq77cAPXv3ADV48rA4e1WHMk7cbaLDbQaEYIshDY5Uk4l+17MbOThANnSLwTxQfYMWlG9hN4K5XyalS5ZPvvJkvRwIECCVdVzpurCXXawIEw0T4lCn4VM9xIV+y0ieumcC1Ym4fZvxJJ511ByxZ9tkKv4QbOO7iBq4cbuO6zoIFDCqXOUyj9CDdw9bRt4LAGq0jiDW7WnlTWhOy4jsIv26vzJUCRBAljNz3PuDSrSipllu27myxdAxcQEEx3crZlMakbBq4KPlvbKLjTzcbYfhLuMaRkbqPg/UUS4uz1cjoDN3DewQ1cPdzAdZ+FiphgM2dZN26RNfNHfpaq23+GtdFD2WtcrHADV0/bBm6ShM+7TZ1E4J6nlSv36ngJMUnChQgy2zXAME4lkh4vkvB2tu9usVQNHJgk4TduUmGXkrpp4MD1tPJ1JQr+CGvVKnso9qWqVSvnKPibSRLewl4np3NwA+cd3MDVww1c95E14zdrR7fUjfOzwjYCqVzNJtf+FPaCw5/hoezR7DUuVriBq6ctAzdFgSO2UXAX1mKxAUczei51MvDjvc5mibGNVhw8Q9K9KHTAjlEzwjhiFihP4v+yfXeLpWzgbqDjD5qhYAmzI9zEOavbBq5KkcQTSxS8HtsCtFv9tRfCd4K9J11wZoaCMntdnM7DDZx3cANXDzdw3UcZMuMwP+w495uq98yqBTa/XkxwA1dPywYOa67yJP4NT4XbDVqx39s0SXcUSTiQPaGlxgSJqttUPASnkyQk2b67wVI2cGCCpMPmKDhxD8ltb6OxFNQrAwfGadm+JQom5ig4C7NdqXpbd45+ENbFYqzmKHjbHEljl9JxB7DXw+kO3MB5Bzdw9XAD1300bfzFsmZOO96LfSBu4OYXN3D12svAYc2Vm3LdUyRZKUGTFAiyJ7NUyVPgdzBh7RpiFDcokfQIzATbd6eBgdtGQcu8VCvwtSoUZOlXAweuoMDL5yj4A8ya4H3E+1FbkZDLXq/ZKwNXBYU/5iiYKJG0FWmV+B7C9gDs56nbQhGo6n5zJQqWZimYm6ATX8GeP6e7cAPnHdzA1cMNXG+I6uaR0eGxOzETh03P2THvB3EDN7+4gavXswauQCs/iMAHpboRcLSjhygKo3IBeyJLma0kHjJD0kP3klw3Xs0I78ljFEMweM12GtyP7b+TzFDgowjOEXyi+l87eohUGJ71bN/9xjRJH5kl6bwSSTuRXoz3BWKvdykK92eBhLPZMesFF1AY1SqXz1HwFzMkPVrds63dlPB2BOOIcYHhnyFx1yxJf5ghMbKDQvuz58vpDRE9LWu58fLgyOaG0jedVlY08+u17RQt8y197LS619ZqKHsKDNxAbbvFjKIb/+I4JqNbyuszJ8OsLJlN6WVt9Ni16ZOs0vV141GRPnYqxuQ8ti3HHcpa47BoKnt+NJF9nB3zflD1nlkVN45ir22xMpAwFW3jqXXrAWuV3PKFciSePpNtu1gRhjcfKGvm00OZk+vGoiotdyp+o6ZROv2knbTq0jwJFxfb0DSJF8+S9MsJWnEweyJLnUkKDNxOA3Vj1rzEi2+m0GWTJB7D9t1Jpmn5q2ZJGii40BwF5SkKvIntu1+ZopUvnSbxmBkKSkUSI+z1LkXtoDDe4yPYseo1BZLeeDOF9BIFL5km6WEY7mqapdvU4KqQdQBzWN0IHA87pkl8fJrEK2dIGutlESJOYwaSmTesTo3JMFqNtHrDZjmSzL23th2e8K/e4NwuOrwxog6NHFLbbjETSY6+13lMMgPR4WwknMq9hm27WIkNbz5QSWasa68fD1vWmCWXTqGKbhMdyr45lho7AQ9r2LH3taz7Jj0QGEy/nL2mxUokZbw7tmHsLEU3z2yktaObzhpYn/4423axEjLN/RXd3BJLZuvGoqrY8MYzFc1IsG05HA5n0VAi8ZASiaESSd+YIunqKRLvg/HC7BxmymC+8HcYMazjRcos0mUh/B3r16pVL2HS0AZ/4v+LJD40Q9J1JZK+N0eSMk2hN7PH53A4HA6Hw+FwOBxOm2B2GWnjJQpGCySeOk3iDwskXDJF4t+KJOYLJG4vkHBbkcQdRRJuKZBYLJJwbZGEy4ok/hhr/qYouG6ahGO3U3jJzCxwOBwOh8PxD/8fAG7GS9pND8UAAAAASUVORK5CYII=',
    CENTERS: ['강남', '강서', '강북', '강동'],
    MODELS: ['B700', 'B710', 'B800'],
    FORM_MODELS: ['서울 B800', '서울 B700', '서울 B710', '공항 B620', '태그리스']
  };
})(window);
