// Monthly backup of Payvori Engine, run by Netlify on a schedule (the 1st of each month, 06:00 UTC).
// Copies every document from the "payvori-engine" store into one backup in the "payvori-engine-backups" store,
// and keeps the newest 12 monthly backups. Admins download or restore them on the Backup and import page.
import { getStore } from '@netlify/blobs';

const KEEP = 12;

export default async () => {
  const data = getStore('payvori-engine');
  const backups = getStore('payvori-engine-backups');
  const { blobs } = await data.list();
  const keys = blobs.map(b => b.key).filter(k => !k.startsWith('_')).sort();
  const docs = {};
  for (const k of keys) {
    const raw = await data.get(k);
    if (raw == null) continue;
    try { docs[k] = JSON.parse(raw); } catch (e) {}
  }
  const at = new Date().toISOString();
  await backups.set('monthly/' + at, JSON.stringify({ format: 'payvori-engine-export', exportedAt: at, source: 'Payvori Engine monthly backup', docs }),
    { metadata: { at, count: Object.keys(docs).length, kind: 'monthly' } });
  const { blobs: old } = await backups.list({ prefix: 'monthly/' });
  const stale = old.map(b => b.key).sort().reverse().slice(KEEP);
  for (const k of stale) await backups.delete(k);
  console.log('monthly-backup: saved', Object.keys(docs).length, 'documents; removed', stale.length, 'old backups');
  return new Response('ok');
};

export const config = { schedule: '0 6 1 * *' };
