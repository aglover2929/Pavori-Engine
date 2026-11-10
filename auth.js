// Payvori Engine sign-in: Netlify Identity (GoTrue) over plain fetch. Roles live in app_metadata.roles.
// admin = Identity admin (always Engine Admin). member = added under Users in Engine (set by the db function).
(function () {
  var API = '/.netlify/identity', KEY = 'pv-engine-auth', ROLES = ['admin', 'member'];
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function cookie(token, maxAge) {
    document.cookie = 'nf_jwt=' + (token || '') + '; path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '') + '; max-age=' + (token ? maxAge : 0);
  }
  function write(s) {
    localStorage.removeItem(KEY); sessionStorage.removeItem(KEY);
    if (!s) { cookie(null); return null; }
    (s.remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(s));
    cookie(s.access_token, Math.max(60, Math.floor((s.expires_at - Date.now()) / 1000)));
    return s;
  }
  async function call(path, opts) {
    var r = await fetch(API + path, opts);
    var body = null; try { body = await r.json(); } catch (e) {}
    if (!r.ok) {
      var msg = (body && (body.error_description || body.msg || body.message || body.error)) || ('Request failed (' + r.status + ')');
      throw new Error(msg);
    }
    return body;
  }
  async function session(tok, remember) {
    var user = await call('/user', { headers: { Authorization: 'Bearer ' + tok.access_token } });
    return write({ access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Date.now() + (tok.expires_in || 3600) * 1000, remember: !!remember, user: user });
  }
  function form(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); }
  function roleOf(s) {
    var r = (s && s.user && s.user.app_metadata && s.user.app_metadata.roles) || [];
    for (var i = 0; i < ROLES.length; i++) if (r.indexOf(ROLES[i]) >= 0) return ROLES[i];
    return null;
  }
  var A = {
    live: fetch(API + '/settings').then(function (r) { return r.ok && /json/.test(r.headers.get('content-type') || ''); }).catch(function () { return false; }),
    current: read,
    role: function () { return roleOf(read()); },
    name: function () { var s = read(); if (!s) return ''; var m = s.user.user_metadata || {}; return m.full_name || s.user.email; },
    login: async function (email, password, remember) {
      var tok = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'password', username: email, password: password }) });
      return session(tok, remember);
    },
    signup: function (email, password, name) {
      return call('/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: password, data: { full_name: name } }) });
    },
    verify: async function (token, type, remember) {
      var tok = await call('/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, type: type }) });
      return session(tok, remember);
    },
    acceptInvite: async function (token, password) {
      var tok = await call('/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, type: 'signup', password: password }) });
      return session(tok, true);
    },
    recover: function (email) {
      return call('/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) });
    },
    setPassword: async function (password) {
      var s = await A.fresh();
      await call('/user', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token }, body: JSON.stringify({ password: password }) });
      return s;
    },
    // Refresh the token when it is close to expiry, or always when force is set (picks up a newly granted role).
    fresh: async function (force) {
      var s = read();
      if (!s) throw new Error('Not signed in');
      if (!force && s.expires_at - Date.now() > 120000) { cookie(s.access_token, Math.floor((s.expires_at - Date.now()) / 1000)); return s; }
      var tok = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: s.refresh_token }) });
      return session(tok, s.remember);
    },
    authFetch: async function (url, opts) {
      var s = await A.fresh();
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + s.access_token });
      return fetch(url, opts);
    },
    logout: async function () {
      var s = read();
      if (s) { try { await fetch(API + '/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + s.access_token } }); } catch (e) {} }
      write(null);
      location.href = '/login';
    }
  };
  window.PvAuth = A;
})();
