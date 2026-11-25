/* ═══════════════════════════════════════════════════════════════════════════
   live.js — 되풀이 읽기 · 새 판 판단 · 띠 (2026-11-25 결재 웹 「바로 반영」 묶음 E)
   ---------------------------------------------------------------------------
   · poller(env, o) — 가벼운 서버 값(approval_live_mark)을 보이는 동안만 되풀이해 읽고, 값이 바뀌면 o.hit 을 부른다.
       타이머는 늘 하나 · 안 보이면 지움 · 실패하면 간격 × 2^n(5분 상한) · 읽는 중이면 겹치지 않음. 웹소켓 없음.
   · verDecide / verUrl / verStart — 공개된 판 번호(version.json)와 이 화면의 판(<meta name="atec-ver">)을 견줘
       열려 있는 화면이 새 판으로 저절로 넘어가게 한다(적는 중이면 띠로 알리고 기다림).
   · 띠(#verBar)는 두 화면(driving · work)이 같은 조각을 쓴다. 브라우저 window.AtecLive · Node module.exports.
   · 브라우저 JS 는 ES5 꼴(빌드 없음). DOM 을 만지는 곳은 모두 typeof document 로 가른다.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.AtecLive = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var KNOB = { fast: 10000, slow: 30000, jit: 0.15, max: 300000, off404: 600000, readMax: 8000, verEvery: 300000, verMin: 30000, verQuiet: 1000, off: false };
  var VER_RE = /^[0-9a-f]{10}$/;
  var RL_KEY = 'atec_ver_rl', RL_WIN = 600000;

  function g() { return typeof globalThis !== 'undefined' ? globalThis : root; }
  /* 시험 손잡이 — 일정을 잡을 때마다 다시 읽는다(일부만 줘도 됨) */
  function knob() {
    var k = {}, i, x = g().__LIVE_KNOB;
    for (i in KNOB) if (Object.prototype.hasOwnProperty.call(KNOB, i)) k[i] = KNOB[i];
    if (x && typeof x === 'object') for (i in x) if (Object.prototype.hasOwnProperty.call(x, i)) k[i] = x[i];
    return k;
  }

  function delay(base, fails, rnd, kn) {
    var k = kn || KNOB;
    var d = Math.min(base * Math.pow(2, fails), k.max);
    return d * (1 + k.jit * (2 * rnd - 1));
  }

  function browserEnv() {
    return {
      now: function () { return Date.now(); },
      setTimeout: function (f, ms) { return setTimeout(f, ms); },
      clearTimeout: function (id) { clearTimeout(id); },
      random: function () { return Math.random(); },
      hidden: function () { return typeof document !== 'undefined' && !!document.hidden; },
      onVisibility: function (cb) { if (typeof document !== 'undefined') document.addEventListener('visibilitychange', cb); }
    };
  }

  function poller(env, o) {
    var timer = null, dueAt = 0, reading = false, on = false, offUntil = 0, fails = 0, last = null, why = '', wired = false;

    function clear() { if (timer != null) { env.clearTimeout(timer); timer = null; } }
    function schedule(ms) {
      clear();
      dueAt = env.now() + ms;
      timer = env.setTimeout(tick, ms);
    }
    function next() {
      var d = delay(o.base(), fails, env.random(), knob()), hold = offUntil - env.now();   // off 를 받았으면 off404 가 끝날 때까지는 안 읽는다(탭 오감·kick 도)
      return hold > d ? hold : d;
    }
    function canRun() { return on && !knob().off && !env.hidden(); }

    function readOnce() {
      var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var to, killed;
      var guard = new Promise(function (_, rej) {
        to = setTimeout(function () { if (ac) { try { ac.abort(); } catch (e) { /* 무시 */ } } rej(new Error('timeout')); }, knob().readMax);
        if (to && to.unref) to.unref();
      });
      var p;
      try { p = Promise.resolve(o.read(ac ? ac.signal : undefined)); } catch (e) { p = Promise.reject(e); }
      return Promise.race([p, guard]).then(function (r) { clearTimeout(to); return r; }, function (e) { clearTimeout(to); throw e; });
    }

    function tick() {
      timer = null;
      if (!canRun() || reading) return;
      if (!o.ready()) { schedule(next()); return; }
      reading = true;
      readOnce().then(function (r) {
        reading = false;
        if (!on) return;
        if (r && r.gone) { why = 'gone'; on = false; clear(); return; }
        if (r && r.off) { why = 'off'; offUntil = env.now() + knob().off404; if (!env.hidden() && !knob().off) schedule(knob().off404); return; }
        if (!r || !r.ok || typeof r.mark !== 'string') throw new Error('bad');
        fails = 0; why = ''; offUntil = 0;
        if (last === null) { last = r.mark; o.hit(true); }
        else if (r.mark !== last) { if (o.hit(false) !== false) last = r.mark; }
      }).then(null, function () {
        reading = false;
        // off(10분 쉼) 뒤 첫 읽기가 실패해도(서버 PC 다시 켬 — 404 다음 503) 다음 차례를 잡는다 — why 가 'off' 로 남으면 아래에서 잡지 않아 멈췄다
        //   (탭을 오가거나 start 할 때까지, 묶음 E 마지막 고침 F1). 쉬는 시간은 offUntil 이 지킨다(next)
        if (on) { fails++; why = ''; }
      }).then(function () {
        if (on && why !== 'off' && timer == null && canRun()) schedule(next());
      });
    }

    function onVis() {
      if (!on) return;
      if (env.hidden()) { clear(); return; }
      if (timer == null && !reading && !knob().off) schedule(next());
    }

    return {
      start: function () {
        if (!wired) { wired = true; env.onVisibility(onVis); }
        on = true; why = '';
        if (knob().off || env.hidden()) return;
        if (timer == null && !reading) schedule(next());
      },
      // 멈추면 실패 수 · off 기다림 · 받아 둔 값도 지운다 — 다음 start(포털에 다른 사람이 들어옴)는 처음처럼(첫 값 hit(true) · 보통 간격, F5). why 는 그대로(start 가 지운다)
      stop: function () { on = false; clear(); fails = 0; offUntil = 0; last = null; },
      kick: function () {
        if (!canRun() || reading || timer == null || offUntil > env.now()) return;
        var b = o.base();
        if (dueAt - env.now() > b) schedule(b);
      },
      state: function () { return { on: on, fails: fails, last: last, why: why }; }
    };
  }

  /* 새 판 판단 — 표는 task 2 설계서 그대로 */
  function verDecide(s) {
    if (!s.cur || !VER_RE.test(s.got || '') || s.got === s.cur) return 'none';
    if (s.urlV === s.got) return 'manual';
    if (s.recent >= 3) return 'manual';
    if (s.hold) return 'wait';
    return 'reload';
  }

  /* 주소의 v(와 r) 질의만 넣거나 바꾼다 — 다른 질의·#/… 그대로 */
  function verUrl(href, v, r) {
    var hash = '', q = '', i = href.indexOf('#');
    if (i >= 0) { hash = href.slice(i); href = href.slice(0, i); }
    i = href.indexOf('?');
    if (i >= 0) { q = href.slice(i + 1); href = href.slice(0, i); }
    var parts = q ? q.split('&') : [], out = [], seenV = false, seenR = false, j, key;
    for (j = 0; j < parts.length; j++) {
      key = parts[j].split('=')[0];
      if (key === 'v') { if (!seenV) { out.push('v=' + v); seenV = true; } }
      else if (key === 'r' && r != null) { if (!seenR) { out.push('r=' + r); seenR = true; } }
      else if (parts[j] !== '') out.push(parts[j]);
    }
    if (!seenV) out.push('v=' + v);
    if (r != null && !seenR) out.push('r=' + r);
    return href + '?' + out.join('&') + hash;
  }

  /* ── 띠 ──
     화면 맨 위에 붙는 한 줄(좁으면 글이 두 줄까지) — 글은 왼쪽 · 단추 「새로 고침」 하나는 오른쪽 끝 · 둘의 세로 가운데가 같다. 글꼴은 페이지 것을 물려받는다.
     좌우 여백은 그 페이지 머리띠 안쪽 끝(o.head — padding 안)에 맞춘다. 보일 때 · 폭이 바뀔 때 잰다(없으면 16px).
     보이는 동안 <html> 에 has-verbar 와 --verbar-h(띠 높이)를 걸면 페이지 CSS 가 본문 · 머리띠 · 거기 붙은 것 · 창을 그만큼 내린다
     (driving-v2.html · work.html — 머리띠 단추도 창 머리 줄도 띠 밑에 숨지 않게).
     ★ 띠가 생기거나 걷히거나 높이가 바뀌어도 보던 것은 화면에서 움직이지 않는다(2026-11-25 사용자 「쓸때마다 … 왔다갔다 움직이는데 … 너무 사용하기 불편해」):
       ① 초점이 있는 칸 ② 열린 창의 글(o.boxes — 창 스크롤) ③ 본문(o.main — 문서 스크롤)의 자리를 재어 두고, 바꾼 뒤 움직인 만큼 스크롤한다.
       창 안이 짧아 스크롤할 자리가 모자라면 띠가 있는 동안만 그 창 아래 여백을 늘린다(문서 아래 자리는 페이지 CSS 의 min-height).
       본문(③)은 문서 스크롤이 0 이면 그대로 밀린다 — 맨 위 글이 머리띠 밑에 숨지 않게. 창이 열려 있어도 그렇다: 창 뒤 본문은 쓰는 곳이 아니고
       (창 안 글 ②만 그대로), 첫 화면처럼 흐르는 머리띠도 띠 바로 밑에 남는다. 본문 칸에 초점이 있으면(①) 그 칸이 그대로다.
     띠 글은 바뀔 때만 쓴다(aria-live 가 같은 글을 되풀이해 읽지 않게). */
  var TXT1 = '새 버전이 나왔어요. 적던 내용을 마치면 저절로 새로 고쳐요.';
  var TXT2 = '새 버전이 나왔어요. ‘새로 고침’을 눌러 주세요.';   // 단추 이름은 화면 다른 곳(‘다시 저장’ 등)처럼 작은따옴표(고침 1 R5-3)
  var CSS = '#verBar{position:fixed;top:0;left:0;right:0;z-index:2147483000;display:none;align-items:center;gap:12px;box-sizing:border-box;' +
    'min-height:44px;padding:6px 20px;background:#1D252B;color:#fff;font:inherit;font-size:14px;line-height:1.4;word-break:keep-all;overflow-wrap:break-word}' +
    '#verBar.on{display:flex}' +
    '#verBar>span{flex:1 1 auto;min-width:0;text-wrap:balance}#verBar>span>span{white-space:nowrap}' +
    '#verBar button{flex:none;height:32px;margin:0;padding:0 14px;border:0;border-radius:6px;background:#fff;color:#1D252B;' +
    'font:inherit;font-size:14px;font-weight:700;line-height:1;white-space:nowrap;cursor:pointer}' +
    '#verBar button:hover{background:#E5E9EC}#verBar button:focus-visible{outline:2px solid #fff;outline-offset:2px}' +
    '@media (max-width:1023px){#verBar{min-height:56px;padding-top:8px;padding-bottom:8px}#verBar button{height:40px;padding:0 16px}}' +
    '@media print{#verBar{display:none!important}}';   // 띠가 떠 있어도 인쇄(결재 문서 출력)에는 안 나온다 — 페이지 쪽 has-verbar 규칙도 화면에만

  /* 띠 글 — 두 줄이면 줄 길이를 고르게(balance). 따옴표로 싼 단추 이름(‘…’ · 「…」)과 바로 뒤 토씨는 한 덩이(nowrap — ‘새로 / 고침’을 처럼 갈리지 않게). 글자는 그대로 */
  function setText(el, text) {
    if (text.indexOf('‘') < 0 && text.indexOf('「') < 0) { el.textContent = text; return; }
    el.textContent = '';
    text.split(/(‘[^’]*’\S*|「[^」]*」\S*)/).forEach(function (p) {
      if (!p) return;
      if (p.charAt(0) === '‘' || p.charAt(0) === '「') { var s = document.createElement('span'); s.textContent = p; el.appendChild(s); }
      else el.appendChild(document.createTextNode(p));
    });
  }
  function px(v) { return parseFloat(v) || 0; }
  function inDoc(el) { return !!el && document.documentElement.contains(el); }
  /** 페이지가 준 요소 목록 — 함수가 없거나 던지면 빈 목록 */
  function els(fn) {
    try {
      var a = typeof fn === 'function' ? fn() : null;
      return a ? [].concat(a).filter(function (e) { return !!e && e.nodeType === 1; }) : [];
    } catch (e) { return []; }
  }
  /** 띠 하나(verStart 가 한 번 만든다). o.head · o.main · o.boxes 는 위 설명. */
  function makeBar(o) {
    var bar = null, txt = null, btn = null, got = '', h = 0;
    function make() {
      if (bar) return true;
      if (!document.body) return false;
      var st = document.createElement('style'); st.textContent = CSS; (document.head || document.documentElement).appendChild(st);
      bar = document.createElement('div'); bar.id = 'verBar'; bar.setAttribute('role', 'status'); bar.setAttribute('aria-live', 'polite');
      txt = document.createElement('span');
      btn = document.createElement('button'); btn.type = 'button'; btn.textContent = '새로 고침';
      btn.addEventListener('click', function () { location.replace(verUrl(location.href, got, String(Date.now()))); });
      bar.appendChild(txt); bar.appendChild(btn);
      document.body.appendChild(bar);
      // 폭이 바뀌면 여백 · 높이를 다시 잰다. 글 줄 수가 바뀌면(글꼴이 늦게 옴 등) 높이만 — 지켜보는 글(span)의 크기는 여기서 바꾸지 않는다(되풀이 알림이 없게)
      window.addEventListener('resize', fit);
      if (typeof ResizeObserver === 'function') { try { new ResizeObserver(function () { fitH(); }).observe(txt); } catch (e) { /* 없으면 resize 만 */ } }
      return true;
    }
    function on() { return !!bar && bar.className === 'on'; }
    /* 좌우 여백 = 머리띠 안쪽 끝(padding 안) */
    function pad() {
      var el = els(o.head)[0], L = 16, R = 16;
      if (el && el.getClientRects().length) {
        var r = el.getBoundingClientRect(), cs = getComputedStyle(el), b = bar.getBoundingClientRect();
        L = r.left + px(cs.paddingLeft) + px(cs.borderLeftWidth) - b.left;
        R = b.right - (r.right - px(cs.paddingRight) - px(cs.borderRightWidth));
      }
      var l = Math.max(0, Math.round(L * 100) / 100) + 'px', rr = Math.max(0, Math.round(R * 100) / 100) + 'px';
      if (bar.style.paddingLeft !== l) bar.style.paddingLeft = l;
      if (bar.style.paddingRight !== rr) bar.style.paddingRight = rr;
    }
    /* 요소를 화면에서 그대로 두려면 움직일 스크롤 — 고정 층(fixed · sticky) 안이면 그 안의 가장 바깥 스크롤 상자(없으면 undefined),
       아니면 문서(null). 문서 안 작은 스크롤 상자가 아니라 문서다 — 띠가 미는 것은 문서 맨 위 */
    function scroller(el) {
      var last, n, cs;
      for (n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        cs = getComputedStyle(n);
        if (cs.position === 'fixed' || cs.position === 'sticky') return last;
        if (/(auto|scroll)/.test(cs.overflowY)) last = n;
      }
      return null;
    }
    /* sc 를 d 만큼(+ 아래로) 스크롤 — 창 안 자리가 모자라면 띠가 있는 동안만 그 상자 키를 지금 키에 묶고 아래 여백을 늘린다(data-verroom 에 원래 값).
       키가 글만큼 늘어나는 상자(좁은 화면 알림 창 등)는 묶지 않으면 늘린 여백만큼 같이 커져 스크롤 자리가 생기지 않는다.
       글이 상자보다 짧으면 scrollHeight 가 상자 높이로 나와 모자란 만큼을 한 번에 못 잰다 — 늘린 뒤 다시 재어 모자란 만큼 더(세 번까지) */
    function shift(sc, d) {
      if (sc === null) { window.scrollTo(window.pageXOffset, window.pageYOffset + d); return; }
      var t = sc.scrollTop, i, miss;
      if (d > 0 && t + d - (sc.scrollHeight - sc.clientHeight) > 0.5) {
        if (!sc.hasAttribute('data-verroom')) sc.setAttribute('data-verroom', (sc.style.paddingBottom || '') + '|' + (sc.style.maxHeight || ''));
        sc.style.maxHeight = sc.getBoundingClientRect().height + 'px';
        for (i = 0; i < 3; i++) {
          miss = t + d - (sc.scrollHeight - sc.clientHeight);
          if (miss <= 0.5) break;
          sc.style.paddingBottom = (px(getComputedStyle(sc).paddingBottom) + miss) + 'px';
        }
      }
      sc.scrollTop = t + d;
    }
    function unroom() {
      var a = document.querySelectorAll('[data-verroom]'), i, v;
      for (i = 0; i < a.length; i++) {
        v = a[i].getAttribute('data-verroom').split('|');
        a[i].style.paddingBottom = v[0]; a[i].style.maxHeight = v[1] || ''; a[i].removeAttribute('data-verroom');
      }
    }
    /* 초점이 있는 칸(입력 · 고르기 · 글 칸 · contenteditable) — 띠 단추 · 안 보이는 것은 빼고 */
    function field() {
      var ae = document.activeElement;
      if (!ae || ae === document.body || ae === document.documentElement || (bar && bar.contains(ae))) return null;
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && !ae.isContentEditable) return null;
      return ae.getClientRects().length ? ae : null;
    }
    function snap() {
      var s = { y: window.pageYOffset, f: null, b: [], m: null }, f = field(), m = els(o.main)[0];
      if (f) s.f = { el: f, t: f.getBoundingClientRect().top };
      els(o.boxes).forEach(function (b) { if (b.getClientRects().length) s.b.push({ el: b, t: b.getBoundingClientRect().top }); });
      if (m && m.getClientRects().length) s.m = { el: m, t: m.getBoundingClientRect().top };
      return s;
    }
    /* 재어 둔 자리로 — 칸(그 스크롤) → 창(그 창 스크롤, 칸이 맞춘 것은 건너뜀) → 본문(문서 스크롤) */
    function fix(s) {
      var done = [], d, sc;
      if (s.f && inDoc(s.f.el)) {
        sc = scroller(s.f.el);
        if (sc !== undefined) { d = s.f.el.getBoundingClientRect().top - s.f.t; if (Math.abs(d) >= 0.5) shift(sc, d); done.push(sc); }
      }
      s.b.forEach(function (b) {
        if (done.indexOf(b.el) >= 0 || !inDoc(b.el)) return;
        done.push(b.el);
        if (!/(auto|scroll)/.test(getComputedStyle(b.el).overflowY)) return;   // 스크롤 상자가 아니면 건드리지 않는다(아래 여백을 늘려도 스크롤이 안 된다)
        d = b.el.getBoundingClientRect().top - b.t;
        if (Math.abs(d) >= 0.5) shift(b.el, d);
      });
      // 본문 — 문서 스크롤이 0 이면 밀린다(위 설명 ③ — 창이 열려 있어도. 본문 칸에 초점이 있으면 그 칸 쪽에서 이미 맞췄다)
      if (s.m && done.indexOf(null) < 0 && s.y > 0 && inDoc(s.m.el)) {
        d = s.m.el.getBoundingClientRect().top - s.m.t;
        if (Math.abs(d) >= 0.5) shift(null, d);
      }
    }
    /* --verbar-h 를 nh 로(0 = 걷음) — 보던 것은 그대로 */
    function apply(nh) {
      var de = document.documentElement, s = snap();
      if (nh > 0) { de.classList.add('has-verbar'); de.style.setProperty('--verbar-h', nh + 'px'); }
      else { de.classList.remove('has-verbar'); de.style.removeProperty('--verbar-h'); }
      h = nh;
      fix(s);
      if (!nh) unroom();
    }
    /* 띠가 그려지는 동안만 잰다 — 인쇄 등으로 안 그려지면(높이 0) 재지 않는다(0 을 걸면 머리띠가 띠 밑에서 올라가 버린다) */
    function drawn() { return on() && bar.getClientRects().length > 0; }
    function fitH() {
      if (!drawn()) return;
      var nh = Math.round(bar.getBoundingClientRect().height * 100) / 100;
      if (nh > 0 && Math.abs(nh - h) >= 0.5) apply(nh);
    }
    function fit() { if (drawn()) { pad(); fitH(); } }
    return {
      show: function (text, g) {
        if (!make()) return;
        got = g;
        if (txt.textContent !== text) setText(txt, text);
        if (!on()) bar.className = 'on';
        fit();
      },
      hide: function () {
        if (!on()) return;
        bar.className = '';
        apply(0);
      }
    };
  }

  function rlRead(now) {
    try {
      var a = JSON.parse(sessionStorage.getItem(RL_KEY) || '[]'), out = [], i;
      if (!Array.isArray(a)) return [];
      for (i = 0; i < a.length; i++) if (typeof a[i] === 'number' && now - a[i] < RL_WIN && now - a[i] >= 0) out.push(a[i]);
      return out;
    } catch (e) { return []; }
  }
  function rlAdd(now) {
    try { var a = rlRead(now); a.push(now); sessionStorage.setItem(RL_KEY, JSON.stringify(a)); } catch (e) { /* 저장소 막힘 — 주소 규칙만 믿는다 */ }
  }
  function readCur() {
    if (typeof document === 'undefined') return '';
    var m = document.querySelector('meta[name="atec-ver"]');
    return m ? (m.getAttribute('content') || '') : '';
  }
  function urlV() {
    try { var m = /[?&]v=([^&#]*)/.exec(location.search || ''); return m ? m[1] : ''; } catch (e) { return ''; }
  }

  /* o = { hold(): boolean — 지금 쓰는 중인가(던지면 쓰는 중으로 친다), head · main · boxes — 띠(위 makeBar 설명) } */
  function verStart(o) {
    o = o || {};
    var got = '', mode = '', lastCheck = 0, loopT = null, quietT = null, busy = null;
    var api = { check: function () { return Promise.resolve(); }, state: function () { return { cur: readCur(), got: got, mode: mode }; } };
    // 판 번호가 없는 화면(소스 파일을 그대로 연 것 · 하네스 — 판 번호는 올리는 도구가 넣는다)은 아무것도 걸지 않는다: 듣기 · 타이머 0
    if (typeof document === 'undefined' || !readCur()) return api;
    var bar = makeBar(o);

    function held() {
      if (typeof o.hold !== 'function') return false;
      try { return !!o.hold(); } catch (e) { return true; }   // 던지면 쓰는 중 — 저절로 새로 고치지 않는 쪽(타이머 밖으로 새지 않게)
    }
    function decide() { return verDecide({ cur: readCur(), got: got, urlV: urlV(), hold: held(), recent: rlRead(Date.now()).length }); }
    function doReload() { rlAdd(Date.now()); location.replace(verUrl(location.href, got)); }
    function again(ms, second) {
      if (quietT != null) clearTimeout(quietT);
      quietT = setTimeout(function () { quietT = null; try { act(second); } catch (e) { /* 띠·판단 오류는 삼킨다 — 다음 확인에 다시 */ } }, ms);
    }
    /* 한 번 판단해서 행동 — 저절로 새로 고치는 것은 verQuiet 간격으로 두 번 잇따라 쓰는 중이 아닐 때만.
       새로 고칠 때 띠는 걷지 않는다(곧 새 페이지 — 걷으면 떠나기 바로 전에 본문이 한 번 올라간다) */
    function act(second) {
      var v = decide();
      if (v === 'none') { mode = 'none'; bar.hide(); return; }
      if (v === 'manual') { mode = 'manual'; bar.show(TXT2, got); return; }
      if (v === 'wait') { mode = 'wait'; bar.show(TXT1, got); again(knob().verQuiet); return; }
      if (second) { mode = 'reload'; doReload(); return; }
      mode = 'pending';
      again(knob().verQuiet, true);
    }

    function check() {
      if (knob().off || !readCur()) return Promise.resolve();
      if (busy) return busy;
      lastCheck = Date.now();
      busy = Promise.resolve().then(function () {
        return fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      }).then(function (r) { return r && r.ok ? r.json() : null; }).then(function (j) {
        if (!j || typeof j.v !== 'string') return;
        got = j.v;
        if (quietT == null) act();
      }).then(null, function () { /* 못 읽음 = 아무 일 없음 */ }).then(function () { busy = null; });
      return busy;
    }

    function loop() {
      if (loopT != null) { clearTimeout(loopT); loopT = null; }
      if (document.hidden || knob().off) return;
      var k = knob();
      loopT = setTimeout(function () { loopT = null; check(); loop(); }, k.verEvery * (1 + k.jit * (2 * Math.random() - 1)));
    }
    function back() {
      if (!document.hidden && Date.now() - lastCheck > knob().verMin) check();
      loop();
    }

    document.addEventListener('visibilitychange', back);
    window.addEventListener('pageshow', function (e) { if (e && e.persisted) back(); });
    loop();
    api.check = check;
    return api;
  }

  return {
    KNOB: KNOB, knob: knob, delay: delay, env: browserEnv, poller: poller,
    verDecide: verDecide, verUrl: verUrl, verStart: verStart
  };
});
