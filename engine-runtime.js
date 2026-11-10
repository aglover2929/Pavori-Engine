// Payvori Engine on Netlify: provides the window.claude.use('db' | 'user' | 'downloads') calls the Engine page was
// written against, backed by Netlify Identity (auth.js) and the db function (functions/db.js).
(function () {
  'use strict';
  var A = window.PvAuth;
  var API = '/.netlify/functions/db';
  var POLL_VISIBLE = 4000, POLL_HIDDEN = 30000;

  function err(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function toLogin(hash) { location.replace('/login' + (hash || '')); }

  async function call(body) {
    var r;
    try {
      r = await A.authFetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      if (!A.current() || /not signed in|invalid|expired|refresh/i.test(e.message)) { toLogin(); throw err('unauthenticated'); }
      throw err('unavailable', e.message);
    }
    var j = null; try { j = await r.json(); } catch (e) {}
    if (r.status === 401) { toLogin(); throw err('unauthenticated'); }
    if (j && j.code === 'not_member') { toLogin('#not-member'); throw err('not_member'); }
    if (!r.ok) {
      var code = r.status === 403 ? 'invalid_argument' : r.status === 413 ? 'quota_exceeded' : r.status === 404 ? 'not_found' : 'unavailable';
      throw err(code, j && j.error);
    }
    return j;
  }

  // ---------- db ----------
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function docSnap(path, data) {
    return { id: path.split('/').pop(), ref: { path: path }, exists: data != null, data: function () { return data == null ? undefined : clone(data); } };
  }
  function colSnap(path, list) {
    var docs = (list || []).map(function (d) { return docSnap(path + '/' + d.id, d.data); });
    return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (f) { docs.forEach(f); } };
  }
  function segs(p) { return String(p || '').split('/').filter(Boolean); }
  function autoId() {
    var c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', a = crypto.getRandomValues(new Uint8Array(20)), s = '';
    for (var i = 0; i < 20; i++) s += c[a[i] % 62];
    return s;
  }

  var subs = [], rev = null, running = false, again = false, failures = 0, timer = null, kick = null;

  async function pull(force) {
    if (!subs.length) return;
    if (running) { again = true; return; }
    running = true;
    var cols = [], docs = [];
    subs.forEach(function (s) { var l = s.kind === 'col' ? cols : docs; if (l.indexOf(s.path) < 0) l.push(s.path); });
    try {
      var j = await call({ op: 'pull', cols: cols, docs: docs, rev: force ? null : rev });
      failures = 0;
      if (!j.unchanged) {
        rev = j.rev;
        subs.slice().forEach(function (s) {
          try {
            if (s.kind === 'col' && j.cols && s.path in j.cols) s.next(colSnap(s.path, j.cols[s.path]));
            else if (s.kind === 'doc' && j.docs && s.path in j.docs) s.next(docSnap(s.path, j.docs[s.path]));
          } catch (e) { console.error(e); }
        });
      }
    } catch (e) {
      failures++;
      if (e.code === 'invalid_argument' || failures === 3) subs.slice().forEach(function (s) { if (s.error) try { s.error(e); } catch (x) {} });
    } finally {
      running = false;
      if (again) { again = false; pull(true); }
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () { pull(false).finally(schedule); }, document.visibilityState === 'visible' ? POLL_VISIBLE : POLL_HIDDEN);
  }
  function soon() { clearTimeout(kick); kick = setTimeout(function () { pull(true); }, 0); }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { pull(false); schedule(); } });

  function subscribe(kind, path, next, error) {
    var s = { kind: kind, path: path, next: next, error: error };
    subs.push(s);
    soon();
    if (!timer) schedule();
    return function () { subs = subs.filter(function (x) { return x !== s; }); };
  }
  async function write(op, path, data) {
    await call({ op: op, path: path, data: data });
    rev = null;
    soon();
  }

  function docRef(path) {
    if (segs(path).length % 2 !== 0) throw err('invalid_argument', 'Not a document path: ' + path);
    path = segs(path).join('/');
    return {
      id: path.split('/').pop(), path: path,
      get: async function () { var j = await call({ op: 'get', path: path }); return docSnap(path, j.exists ? j.data : null); },
      set: function (d) { return write('set', path, clone(d)); },
      update: function (d) { return write('update', path, clone(d)); },
      delete: function () { return write('delete', path); },
      onSnapshot: function (next, error) { return subscribe('doc', path, next, error); },
      collection: function (c) { return colRef(path + '/' + c); }
    };
  }
  function colRef(path) {
    if (segs(path).length % 2 !== 1) throw err('invalid_argument', 'Not a collection path: ' + path);
    path = segs(path).join('/');
    return {
      id: path.split('/').pop(), path: path,
      doc: function (id) { return docRef(path + '/' + (id || autoId())); },
      add: async function (d) { var r = docRef(path + '/' + autoId()); await r.set(d); return r; },
      get: async function () { var j = await call({ op: 'pull', cols: [path], docs: [] }); return colSnap(path, j.cols && j.cols[path]); },
      onSnapshot: function (next, error) { return subscribe('col', path, next, error); }
    };
  }
  var db = Object.freeze({ collection: colRef, doc: docRef });

  // ---------- user ----------
  var mePromise = null;
  function whoami() { if (!mePromise) mePromise = call({ op: 'whoami' }); return mePromise; }
  function avatar(name) {
    var ch = (String(name || '?').trim()[0] || '?').toUpperCase().replace(/[<>&"']/g, '');
    return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#4a5a6c"/><text x="12" y="16.5" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="12" font-weight="600" fill="#fbfaf7">' + ch + '</text></svg>');
  }
  function withAvatar(p) { p.avatarUrl = p.avatarUrl || avatar(p.name || p.email); return p; }
  var user = Object.freeze({
    me: async function () { var w = await whoami(); return { id: w.id, email: w.email, name: w.name || '', avatarUrl: avatar(w.name || w.email), isOwner: !!w.isAdmin, canEdit: !!w.isAdmin, guest: false }; },
    id: async function () { return (await whoami()).id; },
    isOwner: async function () { return !!(await whoami()).isAdmin; },
    canEdit: async function () { return !!(await whoami()).isAdmin; },
    can: async function (name) { return name === 'data.write' ? !!(await whoami()).canWrite : null; },
    profiles: async function (ids) {
      ids = (ids || []).filter(Boolean).filter(function (x, i, a) { return a.indexOf(x) === i; });
      if (!ids.length) return {};
      try { var p = (await call({ op: 'profiles', ids: ids.slice(0, 64) })).profiles || {}; Object.keys(p).forEach(function (k) { withAvatar(p[k]); }); return p; } catch (e) { return {}; }
    },
    search: async function (q) { try { return ((await call({ op: 'people', q: q || '' })).people || []).map(withAvatar); } catch (e) { return []; } }
  });

  // ---------- downloads ----------
  var TYPES = { csv: 'text/csv', html: 'text/html', json: 'application/json', txt: 'text/plain', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };
  var downloads = Object.freeze({
    save: async function (o) {
      var ext = String(o.filename || '').split('.').pop().toLowerCase();
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: o.mimeType || TYPES[ext] || 'application/octet-stream' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = o.filename || 'download'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    }
  });

  // ---------- boot ----------
  var ready = (async function () {
    if (!A || !A.current()) { toLogin(); return false; }
    try { await whoami(); return true; } catch (e) { return false; }
  })();
  window.claude = Object.freeze({
    use: async function (name) {
      if (name === 'downloads') return downloads;
      if (!(await ready)) return null;
      return name === 'db' ? db : name === 'user' ? user : null;
    }
  });

  // Sign-out control beside the sync status.
  document.addEventListener('DOMContentLoaded', function () {
    var sync = document.getElementById('sync');
    if (!sync || !A) return;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = 'Sign out';
    b.style.cssText = 'height:30px;padding:0 10px;font-size:13px;margin-left:14px';
    b.title = A.name() ? 'Signed in as ' + A.name() : '';
    b.onclick = function () { A.logout(); };
    sync.after(b);
  });
})();
