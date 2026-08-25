/* ============================================================================
 *  atec-auth.js — ATEC 통합 관제 포털 공용 인증 모듈
 *
 *  이 파일이 하는 일
 *    · 로그인/가입/전환/로그아웃을 Supabase Auth 로 처리한다.
 *    · 발급받은 토큰을 붙여 데이터 요청을 보낸다(authFetch). 만료되면 자동 갱신.
 *    · 하위 화면의 진입 가드(requireAuth)를 제공한다.
 *
 *  중요
 *    화면에서 하는 권한 확인은 "메뉴를 보여줄지" 판단용일 뿐이다.
 *    실제 차단은 서버(RLS)가 한다 — sessionStorage 를 위조해도 데이터는 안 나온다.
 *
 *  사용법
 *    <script src="atec-auth.js"></script>
 *    await AtecAuth.login(email, pw)         → {ok} | {needsMigration} | {error}
 *    await AtecAuth.migrate(email, old, neu) → {ok} | {error}
 *    AtecAuth.me()                           → {email,name,role,perms,status} | null
 *    await AtecAuth.requireAuth('rail')      → 미로그인·무권한이면 포털로 보냄
 *    await AtecAuth.authFetch(url, opts)     → 토큰 자동 첨부 + 401 시 1회 재시도
 * ========================================================================== */
(function (global) {
  'use strict';

  var SB_URL = 'https://eiyksjcqntenmetmhmij.supabase.co';
  // publishable(anon) 키 — 공개되어도 되는 값이다. 실제 권한은 로그인 토큰이 정한다.
  var SB_KEY = 'sb_publishable_9xO2pBxLIpMvxbFmQPw1hQ_qtHN5Rm5';

  var K_AT = 'atec_at';        // access token
  var K_RT = 'atec_rt';        // refresh token
  var K_ME = 'atec_session';   // 화면 표시용 사용자 정보(신뢰 대상 아님)

  var ALL_PERMS = ['terminal', 'forms', 'center', 'rail', 'railkr'];

  /* ---------- 저장소 (탭을 닫으면 로그아웃되는 기존 동작 유지) ---------- */
  function get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function del(k) { try { sessionStorage.removeItem(k); } catch (e) {} }

  function me() {
    try { return JSON.parse(get(K_ME) || 'null'); } catch (e) { return null; }
  }
  function saveMe(p) { set(K_ME, JSON.stringify(p)); }

  /* ---------- 공통 요청 ---------- */
  function authHeaders(extra) {
    var h = Object.assign({ apikey: SB_KEY, 'Content-Type': 'application/json' }, extra || {});
    var t = get(K_AT);
    h.Authorization = 'Bearer ' + (t || SB_KEY);
    return h;
  }

  function storeTokens(j) {
    if (j && j.access_token) set(K_AT, j.access_token);
    if (j && j.refresh_token) set(K_RT, j.refresh_token);
    startAutoRefresh();
  }

  /* 액세스 토큰은 1시간 뒤 만료된다. 화면을 오래 켜 둔 채 저장을 눌러도
     실패하지 않도록 45분마다, 그리고 탭으로 돌아올 때 미리 갱신해 둔다. */
  var refreshTimer = null;
  function startAutoRefresh() {
    if (refreshTimer || !get(K_RT)) return;
    refreshTimer = setInterval(function () {
      if (get(K_RT)) refresh(); else { clearInterval(refreshTimer); refreshTimer = null; }
    }, 45 * 60 * 1000);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && get(K_RT)) refresh();
  });

  /** 토큰 갱신. 실패하면 false */
  function refresh() {
    var rt = get(K_RT);
    if (!rt) return Promise.resolve(false);
    return fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt })
    }).then(function (r) {
      if (!r.ok) return false;
      return r.json().then(function (j) { storeTokens(j); return true; });
    }).catch(function () { return false; });
  }

  /** 토큰을 붙여 요청. 401/403 이면 한 번 갱신 후 재시도한다. */
  function authFetch(url, opts) {
    opts = opts || {};
    var send = function () {
      var o = Object.assign({}, opts);
      o.headers = authHeaders(opts.headers);
      return fetch(url, o);
    };
    return send().then(function (r) {
      if (r.status !== 401 && r.status !== 403) return r;
      return refresh().then(function (ok) { return ok ? send() : r; });
    });
  }

  /* ---------- 프로필 ---------- */
  function loadProfile() {
    return authFetch(SB_URL + '/rest/v1/profiles?select=id,email,name,role,status,perms,must_change_pw&limit=1')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        var p = rows && rows[0];
        if (!p) return null;
        var perms = p.role === 'admin' ? ALL_PERMS.slice()
          : (Array.isArray(p.perms) ? p.perms : []);
        var info = {
          username: p.email,   // 기존 화면들이 username 을 참조하므로 이름을 맞춰 둔다
          email: p.email,
          name: p.name || p.email,
          role: p.role,
          status: p.status,
          perms: perms,
          mustChangePw: !!p.must_change_pw
        };
        saveMe(info);
        return info;
      });
  }

  /* ---------- 로그인 / 전환 / 가입 ---------- */
  function login(email, password) {
    email = (email || '').trim().toLowerCase();
    return fetch(SB_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (r) {
      if (r.ok) {
        return r.json().then(function (j) {
          storeTokens(j);
          return loadProfile().then(function (p) {
            if (!p) { logout(); return { error: '계정 정보를 불러오지 못했습니다.' }; }
            if (p.status === 'pending') { logout(); return { error: '아직 관리자 승인 대기 중인 계정입니다.' }; }
            if (p.status === 'rejected') { logout(); return { error: '승인이 거부된 계정입니다. 관리자에게 문의하세요.' }; }
            authFetch(SB_URL + '/rest/v1/rpc/record_login', { method: 'POST', body: '{}' })
              .catch(function () {});
            return { ok: true, profile: p };
          });
        });
      }
      // 새 인증에 없는 계정 → 구계정인지 서버에 확인 요청
      return fetch(SB_URL + '/functions/v1/auth-migrate', {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      }).then(function (mr) {
        return mr.json().then(function (mj) {
          if (mj && mj.needsMigration) return { needsMigration: true, email: email, name: mj.name || '' };
          if (mj && mj.alreadyMigrated) return { error: '이미 전환된 계정입니다. 새 비밀번호로 로그인해 주세요.' };
          return { error: (mj && mj.error) || '이메일 또는 비밀번호가 올바르지 않습니다.' };
        });
      }).catch(function () {
        return { error: '이메일 또는 비밀번호가 올바르지 않습니다.' };
      });
    }).catch(function () {
      return { error: '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
    });
  }

  /** 구계정 전환: 기존 비번 확인 → 새 비번으로 계정 생성 → 자동 로그인 */
  function migrate(email, oldPassword, newPassword) {
    email = (email || '').trim().toLowerCase();
    return fetch(SB_URL + '/functions/v1/auth-migrate', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: oldPassword, newPassword: newPassword })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (j && j.ok) return login(email, newPassword);
        if (j && j.alreadyMigrated) return { error: '이미 전환된 계정입니다. 새 비밀번호로 로그인해 주세요.' };
        return { error: (j && j.error) || '전환에 실패했습니다.' };
      });
    }).catch(function () {
      return { error: '서버에 연결하지 못했습니다.' };
    });
  }

  function signup(email, password, name) {
    email = (email || '').trim().toLowerCase();
    return fetch(SB_URL + '/auth/v1/signup', {
      method: 'POST',
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password, data: { name: name || '' } })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (r.ok) return { ok: true };
        var m = (j && (j.msg || j.message || j.error_description)) || '';
        if (/registered|exists/i.test(m)) return { error: '이미 가입된 이메일입니다.' };
        return { error: m || '가입에 실패했습니다.' };
      });
    }).catch(function () { return { error: '서버에 연결하지 못했습니다.' }; });
  }

  function changePassword(newPassword) {
    return authFetch(SB_URL + '/auth/v1/user', {
      method: 'PUT',
      body: JSON.stringify({ password: newPassword })
    }).then(function (r) {
      return r.ok ? { ok: true } : r.json().then(function (j) {
        return { error: (j && (j.msg || j.message)) || '변경에 실패했습니다.' };
      });
    });
  }

  function logout() {
    var t = get(K_AT);
    if (t) {
      fetch(SB_URL + '/auth/v1/logout', {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + t }
      }).catch(function () {});
    }
    del(K_AT); del(K_RT); del(K_ME);
  }

  /* ---------- 권한 ---------- */
  function isAdmin() { var m = me(); return !!(m && m.role === 'admin'); }
  function hasPerm(p) {
    var m = me();
    if (!m) return false;
    if (m.role === 'admin') return true;
    return Array.isArray(m.perms) && m.perms.indexOf(p) >= 0;
  }

  /**
   * 하위 화면 진입 가드.
   * 토큰이 살아 있는지 서버에 확인하므로 sessionStorage 위조로는 통과할 수 없다.
   */
  function requireAuth(perm) {
    if (!get(K_AT)) { location.replace('index.html'); return Promise.reject(); }
    return loadProfile().then(function (p) {
      if (!p || p.status !== 'approved') { logout(); location.replace('index.html'); return Promise.reject(); }
      if (perm && !hasPerm(perm)) {
        alert('이 시스템에 접근할 권한이 없습니다.\n관리자에게 권한 부여를 요청하세요.');
        location.replace('index.html');
        return Promise.reject();
      }
      return p;
    }).catch(function (e) {
      if (e) { logout(); location.replace('index.html'); }
      return Promise.reject(e);
    });
  }

  // 새로고침으로 모듈이 다시 로드된 경우에도 갱신 타이머를 살려 둔다
  startAutoRefresh();

  global.AtecAuth = {
    SB_URL: SB_URL,
    SB_KEY: SB_KEY,
    ALL_PERMS: ALL_PERMS,
    login: login,
    migrate: migrate,
    signup: signup,
    changePassword: changePassword,
    logout: logout,
    me: me,
    loadProfile: loadProfile,
    isAdmin: isAdmin,
    hasPerm: hasPerm,
    requireAuth: requireAuth,
    authFetch: authFetch,
    token: function () { return get(K_AT); }
  };
})(window);
