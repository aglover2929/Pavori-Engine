// Payvori Engine data store on Netlify. Replaces the claude.ai shared database the page was built on.
// Storage: Netlify Blobs (store "payvori-engine"), one blob per document, keyed by its path ("payees/abc", "runs/2026-09/lines/c0").
// Access: Netlify Identity. Identity admins are always Engine Admin. Everyone else must have an active record under Users;
// their Engine role (Admin, Finance, Operations, Sales, Read-only) decides whether they can write, and only Admins change Users.
const { getStore, connectLambda } = require('@netlify/blobs');

const ENGINE_ROLES = ['Admin', 'Finance', 'Operations', 'Sales', 'Read-only'];
// What each Engine role may reach, enforced here on the server (the page also hides sections, but that alone is not
// protection). Keep in step with ROLE_DEF in index.html.
const ROLE_SECTIONS = {
  'Admin': ['fin', 'orgs', 'pricing', 'res', 'cid', 'orders', 'users'],
  'Finance': ['fin', 'orgs', 'pricing', 'res', 'cid'],
  'Operations': ['orgs', 'cid', 'orders'],
  'Sales': ['orgs', 'cid', 'orders'],
  'Read-only': ['fin', 'orgs', 'pricing', 'res', 'cid', 'orders']
};
// Reading needs any one of these sections. Collections not listed are readable by every Engine user.
const READ_NEEDS = { runs: ['fin', 'res'], ledger: ['fin', 'res'] };
// Saving needs any one of these sections (and a role that can write). Collections not listed: any role that can write.
const WRITE_NEEDS = { schedules: ['pricing'], processors: ['pricing'], runs: ['res', 'fin'], ledger: ['fin'], settings: ['res', 'fin'],
  orders: ['orders'], customers: ['cid'], merchants: ['cid'], deals: ['cid'], maint: ['cid'], payees: ['orgs'], users: ['users'] };
const top = p => String(p).split('/')[0];
const allows = (acc, needs) => !needs || needs.some(n => acc.sections.includes(n));
// Without the pricing section, schedules come through by name only: no rates, and none of Payvori's cost schedules.
function redactSchedules(acc, list) {
  if (acc.sections.includes('pricing')) return list;
  return list.filter(d => (d.data || {}).kind !== 'cost').map(d => {
    const x = d.data || {};
    return { id: d.id, data: { kind: x.kind, code: x.code, title: x.title, payeeId: x.payeeId, processorId: x.processorId, platformIds: x.platformIds, effectiveFrom: x.effectiveFrom, sections: [] } };
  });
}
function readDoc(acc, path, data) {
  if (data == null) return null;
  if (!allows(acc, READ_NEEDS[top(path)])) return null;
  if (top(path) === 'schedules' && path.split('/').length === 2) { const r = redactSchedules(acc, [{ id: path.slice(10), data }]); return r.length ? r[0].data : null; }
  return data;
}
const EXPORT_PAGE_BYTES = 4 * 1024 * 1024;
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const REV = '_meta/rev';

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
const fail = (statusCode, code, error) => json(statusCode, { code, error });

function okPath(p, kind) {
  if (typeof p !== 'string' || p.length > 1000) return false;
  const segs = p.split('/');
  if (segs.length > 15 || !segs.every(s => SEG.test(s) && s !== '.' && s !== '..')) return false;
  if (segs[0].startsWith('_')) return false;
  return kind === 'doc' ? segs.length % 2 === 0 : segs.length % 2 === 1;
}

async function listCol(store, col) {
  const depth = col.split('/').length + 1;
  const { blobs } = await store.list({ prefix: col + '/' });
  const keys = blobs.map(b => b.key).filter(k => k.split('/').length === depth);
  const docs = await Promise.all(keys.map(async k => ({ id: k.slice(col.length + 1), data: await store.get(k, { type: 'json' }) })));
  return docs.filter(d => d.data != null);
}

async function access(store, user) {
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  const isAdmin = roles.includes('admin');
  const users = await listCol(store, 'users');
  const email = String(user.email || '').toLowerCase();
  const rec = users.find(u => u.id === user.sub) || users.find(u => u.data.inviteEmail && String(u.data.inviteEmail).toLowerCase() === email);
  const active = rec && rec.data.status !== 'Disabled' ? rec : null;
  const role = isAdmin ? 'Admin' : active ? (ENGINE_ROLES.includes(active.data.role) ? active.data.role : 'Read-only') : null;
  return { isAdmin, role, member: !!role, sections: role ? ROLE_SECTIONS[role] || [] : [], canWrite: !!role && role !== 'Read-only', canManageUsers: isAdmin || role === 'Admin', users };
}

// ---- Netlify Identity (admin API, using the function's own admin token) ----
async function idUsers(identity) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(identity.url + '/admin/users?per_page=500&page=' + page, { headers: { Authorization: 'Bearer ' + identity.token } });
    if (!r.ok) throw new Error('Loading Identity users failed (' + r.status + ')');
    const batch = (await r.json()).users || [];
    all.push(...batch);
    if (batch.length < 500) break;
  }
  return all;
}

// Give (or take away) the "member" Identity role for one Engine user, inviting them first if they have no account yet.
async function setMember(identity, target, on, cache) {
  if (!identity || !identity.url || !identity.token) return 'Identity is not enabled';
  const h = { Authorization: 'Bearer ' + identity.token, 'Content-Type': 'application/json' };
  const list = cache.list || (cache.list = await idUsers(identity));
  const email = String(target.email || '').toLowerCase();
  let u = (target.id && list.find(x => x.id === target.id)) || (email && list.find(x => String(x.email).toLowerCase() === email));
  if (!u) {
    if (!on || !email) return 'no account';
    const inv = await fetch(identity.url + '/invite', { method: 'POST', headers: h, body: JSON.stringify({ email, data: { full_name: target.name || '' } }) });
    if (!inv.ok) return 'invite failed (' + inv.status + ')';
    u = await inv.json();
    list.push(u);
    cache.invited = (cache.invited || 0) + 1;
  }
  const meta = { ...(u.app_metadata || {}) };
  const roles = new Set(meta.roles || []);
  if (on) roles.add('member'); else roles.delete('member');
  meta.roles = [...roles];
  const r = await fetch(identity.url + '/admin/users/' + u.id, { method: 'PUT', headers: h, body: JSON.stringify({ app_metadata: meta }) });
  u.app_metadata = meta;
  return r.ok ? 'ok' : 'role update failed (' + r.status + ')';
}

const targetOf = (id, data) => ({ id: id && !id.startsWith('inv_') ? id : null, email: data && data.inviteEmail, name: data && data.inviteName });

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return fail(405, 'method', 'Method not allowed');
  const { identity, user } = context.clientContext || {};
  if (!user) return fail(401, 'unauthenticated', 'Sign in first');
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return fail(400, 'invalid_argument', 'Bad request'); }

  connectLambda(event);
  // Default (eventual) consistency: strong reads aren't available to Lambda-style functions. New documents are visible at once;
  // changes reach every reader within about a minute, and the page shows its own changes immediately in the meantime.
  const store = getStore('payvori-engine');
  const acc = await access(store, user);
  const bump = () => store.set(REV, Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const name = (user.user_metadata && user.user_metadata.full_name) || '';

  if (body.op === 'whoami') {
    return json(200, { id: user.sub, email: user.email, name, isAdmin: acc.isAdmin, member: acc.member, role: acc.role, canWrite: acc.canWrite, canManageUsers: acc.canManageUsers });
  }
  if (!acc.member) return fail(403, 'not_member', 'You have not been added to Payvori Engine yet');

  switch (body.op) {
    case 'pull': {
      const rev = (await store.get(REV)) || '0';
      if (body.rev && body.rev === rev) return json(200, { unchanged: true, rev });
      const cols = {}, docs = {};
      for (const c of [...new Set(body.cols || [])]) {
        if (!okPath(c, 'col')) continue;
        if (!allows(acc, READ_NEEDS[top(c)])) { cols[c] = []; continue; }
        const list = c === 'users' ? acc.users : await listCol(store, c);
        cols[c] = c === 'schedules' ? redactSchedules(acc, list) : list;
      }
      for (const d of [...new Set(body.docs || [])]) {
        if (!okPath(d, 'doc')) continue;
        docs[d] = readDoc(acc, d, await store.get(d, { type: 'json' }));
      }
      return json(200, { rev, cols, docs });
    }

    case 'get': {
      if (!okPath(body.path, 'doc')) return fail(400, 'invalid_argument', 'Bad path');
      const data = readDoc(acc, body.path, await store.get(body.path, { type: 'json' }));
      return json(200, { exists: data != null, data });
    }

    case 'set':
    case 'update':
    case 'delete': {
      const path = body.path;
      if (!okPath(path, 'doc')) return fail(400, 'invalid_argument', 'Bad path');
      const isUsers = path.split('/').length === 2 && path.startsWith('users/');
      if (!acc.canWrite) return fail(403, 'invalid_argument', 'Your role is Read-only');
      if (path.startsWith('users/') && !acc.canManageUsers) return fail(403, 'invalid_argument', 'Only Engine Admins can change users');
      if (!top(path).startsWith('users') && !allows(acc, WRITE_NEEDS[top(path)])) return fail(403, 'invalid_argument', 'Your role can\'t change this part of Engine');
      const prev = await store.get(path, { type: 'json' });
      let next = null;
      if (body.op === 'delete') {
        await store.delete(path);
      } else {
        if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return fail(400, 'invalid_argument', 'Bad document');
        if (body.op === 'update' && prev == null) return fail(404, 'not_found', 'Document not found');
        next = body.op === 'update' ? { ...prev, ...body.data } : body.data;
        for (const k of Object.keys(next)) if (next[k] && next[k].__delete__ === true) delete next[k];
        await store.setJSON(path, next);
      }
      await bump();
      let identitySync = null;
      if (isUsers) {
        const id = path.slice(6);
        const was = prev && prev.status !== 'Disabled', now = next && next.status !== 'Disabled';
        if (was !== now || (now && !prev)) {
          try { identitySync = await setMember(identity, targetOf(id, next || prev), !!now, {}); } catch (e) { identitySync = e.message; }
        }
      }
      return json(200, { ok: true, data: next, identitySync });
    }

    case 'profiles': {
      const ids = (body.ids || []).slice(0, 64);
      const out = {};
      if (identity && identity.token && ids.length) {
        const list = await idUsers(identity);
        for (const id of ids) {
          const u = list.find(x => x.id === id);
          if (u) out[id] = { id, name: (u.user_metadata && u.user_metadata.full_name) || u.email, email: u.email, avatarUrl: '' };
        }
      }
      return json(200, { profiles: out });
    }

    case 'people': {
      if (!acc.canManageUsers) return fail(403, 'invalid_argument', 'Admins only');
      const q = String(body.q || '').trim().toLowerCase();
      const list = identity && identity.token ? await idUsers(identity) : [];
      const people = list
        .map(u => ({ id: u.id, name: (u.user_metadata && u.user_metadata.full_name) || u.email, email: u.email, avatarUrl: '' }))
        .filter(p => !q || p.name.toLowerCase().includes(q) || String(p.email).toLowerCase().includes(q))
        .slice(0, 20);
      return json(200, { people });
    }

    // ---- Backups: export everything in pages (each reply stays under Netlify's size limit) ----
    case 'export': {
      if (!acc.isAdmin) return fail(403, 'invalid_argument', 'Only Netlify Identity admins can export');
      const { blobs } = await store.list();
      const keys = blobs.map(b => b.key).filter(k => !k.startsWith('_')).sort();
      const start = Math.max(0, parseInt(body.cursor, 10) || 0), docs = {};
      let i = start, bytes = 0;
      for (; i < keys.length; i++) {
        const raw = await store.get(keys[i]);
        if (raw == null) continue;
        if (bytes && bytes + raw.length > EXPORT_PAGE_BYTES) break;
        try { docs[keys[i]] = JSON.parse(raw); bytes += raw.length; } catch (e) {}
      }
      return json(200, { docs, total: keys.length, next: i < keys.length ? i : null });
    }

    // ---- Saved backups (monthly ones are made by functions/monthly-backup.mjs) ----
    case 'backups': {
      if (!acc.isAdmin) return fail(403, 'invalid_argument', 'Only Netlify Identity admins can see backups');
      const bs = getStore('payvori-engine-backups');
      const { blobs } = await bs.list();
      const items = [];
      for (const b of blobs) { const m = await bs.getMetadata(b.key).catch(() => null); items.push({ key: b.key, kind: b.key.split('/')[0], at: (m && m.metadata && m.metadata.at) || b.key.split('/')[1] || '', count: (m && m.metadata && m.metadata.count) || null }); }
      items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return json(200, { items });
    }
    case 'backupNow': {
      if (!acc.isAdmin) return fail(403, 'invalid_argument', 'Only Netlify Identity admins can make backups');
      const bs = getStore('payvori-engine-backups');
      const { blobs } = await store.list();
      const docs = {};
      for (const k of blobs.map(b => b.key).filter(k => !k.startsWith('_')).sort()) { const raw = await store.get(k); if (raw != null) try { docs[k] = JSON.parse(raw); } catch (e) {} }
      const at = new Date().toISOString();
      await bs.set('manual/' + at, JSON.stringify({ format: 'payvori-engine-export', exportedAt: at, source: 'Payvori Engine backup (saved by ' + (user.email || 'an admin') + ')', docs }), { metadata: { at, count: Object.keys(docs).length, kind: 'manual' } });
      const { blobs: old } = await bs.list({ prefix: 'manual/' });
      for (const k of old.map(b => b.key).sort().reverse().slice(5)) await bs.delete(k);
      return json(200, { ok: true, at, count: Object.keys(docs).length });
    }
    // One saved backup, in pages so each reply stays under Netlify's size limit.
    case 'backupGet': {
      if (!acc.isAdmin) return fail(403, 'invalid_argument', 'Only Netlify Identity admins can download backups');
      if (typeof body.key !== 'string' || !/^(monthly|manual)\/[0-9TZ:.\-]+$/.test(body.key)) return fail(400, 'invalid_argument', 'Bad backup');
      const raw = await getStore('payvori-engine-backups').get(body.key);
      if (raw == null) return fail(404, 'not_found', 'That backup is gone');
      const all = JSON.parse(raw), keys = Object.keys(all.docs || {}).sort();
      const start = Math.max(0, parseInt(body.cursor, 10) || 0), docs = {};
      let i = start, bytes = 0;
      for (; i < keys.length; i++) { const len = JSON.stringify(all.docs[keys[i]]).length; if (bytes && bytes + len > EXPORT_PAGE_BYTES) break; docs[keys[i]] = all.docs[keys[i]]; bytes += len; }
      return json(200, { docs, total: keys.length, next: i < keys.length ? i : null, exportedAt: all.exportedAt });
    }

    // ---- Import: begin (check / clear), then parts, then end (invites). Small files can still use one 'import' call. ----
    case 'importBegin':
    case 'import': {
      if (!acc.isAdmin) return fail(403, 'invalid_argument', 'Only Netlify Identity admins can import');
      const { blobs } = await store.list();
      const existing = blobs.map(b => b.key).filter(k => !k.startsWith('_'));
      if (existing.length && !body.replace) return fail(409, 'exists', 'Engine already has ' + existing.length + ' documents. Tick "Replace existing data" to overwrite them.');
      if (body.replace) for (const k of existing) await store.delete(k);
      if (body.op === 'importBegin') { await bump(); return json(200, { ok: true, replaced: body.replace ? existing.length : 0 }); }
      body.replaced = body.replace ? existing.length : 0;
    }
    // falls through for a one-call 'import'
    case 'importPart': {
      if (!acc.isAdmin) return fail(403, 'invalid_argument', 'Only Netlify Identity admins can import');
      const docs = body.docs && typeof body.docs === 'object' ? body.docs : null;
      if (!docs) return fail(400, 'invalid_argument', 'No documents in the file');
      const paths = Object.keys(docs);
      const bad = paths.filter(p => !okPath(p, 'doc'));
      if (bad.length) return fail(400, 'invalid_argument', 'Bad paths: ' + bad.slice(0, 5).join(', '));
      for (const p of paths) await store.setJSON(p, docs[p]);
      await bump();
      if (body.op === 'importPart') return json(200, { ok: true, imported: paths.length });
    }
    // falls through for a one-call 'import'
    case 'importEnd': {
      if (!acc.isAdmin) return fail(403, 'invalid_argument', 'Only Netlify Identity admins can import');
      const cache = {}, invites = [];
      for (const u of await listCol(store, 'users')) {
        if (u.data.status === 'Disabled') continue;
        let r; try { r = await setMember(identity, targetOf(u.id, u.data), true, cache); } catch (e) { r = e.message; }
        invites.push({ email: u.data.inviteEmail || u.id, result: r });
      }
      const out = { ok: true, invited: cache.invited || 0, users: invites };
      if (body.op === 'import') { out.imported = Object.keys(body.docs).length; out.replaced = body.replaced || 0; }
      return json(200, out);
    }
  }
  return fail(400, 'invalid_argument', 'Unknown operation');
};
