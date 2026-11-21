#!/usr/bin/env node
// CLI: node src/run.js <exclusions|find|push> [flags]
import fs from 'node:fs';
import path from 'node:path';
import { loadIndex, check, normPhone } from './exclusions.js';
import { classifyUrl, analyzeHtml, score, tierLabel } from './classify.js';
import { searchText } from './places.js';
import { stageProspect } from './ghl.js';
import { TOWNS, TRADES } from './towns.js';

const DATA_DIR = process.env.DATA_DIR || '.';
const CLIENTS = path.join(DATA_DIR, 'data', 'clients.csv');
const OUT = path.join(DATA_DIR, 'out');

// ---- tiny .env loader + arg parser (no dependencies) ----
if (fs.existsSync('.env')) {
  for (const l of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2);
    flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
}
const list = (v, d) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const COLS = ['tier', 'score', 'name', 'trade', 'town', 'phone', 'website', 'web_type', 'signals', 'rating', 'reviews', 'address', 'maps_url', 'place_id'];
function writeCsv(path, rows, cols) {
  fs.writeFileSync(path, [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n'));
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function inspectSite(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const u = /^https?:/.test(url) ? url : `https://${url}`;
    const res = await fetch(u, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZWProspector/0.1)' } });
    const html = (await res.text()).slice(0, 400000);
    if (!res.ok) return ['page-empty-or-broken'];
    return analyzeHtml(html, { https: res.url.startsWith('https:') });
  } catch { return ['page-empty-or-broken']; } finally { clearTimeout(t); }
}

if (cmd === 'exclusions') {
  const idx = loadIndex(flags.file || CLIENTS);
  console.log(`client rows: ${idx.rows}\nunique names: ${idx.names.size}\nphones: ${idx.phones.size}\nbusiness email domains: ${idx.emailDomains.size}`);
} else if (cmd === 'find') {
  const key = process.env.GOOGLE_PLACES_KEY;
  const idx = loadIndex(CLIENTS);
  const states = list(flags.states, Object.keys(TOWNS));
  const trades = list(flags.trades, TRADES);
  const maxQ = +flags['max-queries'] || Infinity;
  const queries = [];
  for (const st of states) for (const town of TOWNS[st] || []) for (const tr of trades) queries.push({ q: `${tr} in ${town}, ${st}`, trade: tr, town: `${town}, ${st}` });
  const run = queries.slice(0, maxQ);
  console.error(`${run.length} searches planned (${queries.length} possible)`);
  if (flags['dry-run']) { console.log(run.slice(0, 20).map((x) => x.q).join('\n')); process.exit(0); }

  const seen = new Map(), excluded = [];
  await pool(run, 4, async (x) => {
    let places = [];
    try { places = await searchText(x.q, { key, maxPages: +flags.pages || 1 }); } catch (e) { console.error(`! ${x.q}: ${e.message}`); return; }
    for (const p of places) {
      if (seen.has(p.placeId)) continue;
      seen.set(p.placeId, { ...p, trade: x.trade, town: x.town });
    }
  });
  const all = [...seen.values()];
  // de-dupe by phone too (same business listed under multiple categories)
  const byPhone = new Map();
  for (const p of all) { const ph = normPhone(p.phone); if (!ph) continue; if (!byPhone.has(ph)) byPhone.set(ph, p); }
  const kept = [];
  for (const p of byPhone.values()) {
    const c = check(idx, { name: p.name, phone: p.phone, website: p.website });
    if (c.excluded) excluded.push({ ...p, reason: c.reason }); else kept.push(p);
  }
  console.error(`${all.length} places, ${byPhone.size} with phones, ${excluded.length} excluded as existing clients`);
  const scored = await pool(kept, 8, async (p) => {
    const { type } = classifyUrl(p.website);
    const signals = type === 'own-domain' ? await inspectSite(p.website) : [];
    const s = score({ type, signals, rating: p.rating, reviews: p.reviews, hasPhone: true });
    return { ...p, web_type: type, signals: signals.join('|'), score: s, tier: tierLabel(s), maps_url: p.mapsUrl, place_id: p.placeId };
  });
  scored.sort((a, b) => b.score - a.score);
  fs.mkdirSync(OUT, { recursive: true });
  writeCsv(path.join(OUT, 'prospects.csv'), scored, COLS);
  writeCsv(path.join(OUT, 'excluded.csv'), excluded.map((e) => ({ ...e, signals: e.reason })), ['name', 'phone', 'website', 'signals']);
  const tiers = scored.reduce((a, r) => (a[r.tier] = (a[r.tier] || 0) + 1, a), {});
  console.log(`wrote prospects.csv (${scored.length}) tiers ${JSON.stringify(tiers)}; out/excluded.csv (${excluded.length})`);
} else if (cmd === 'push') {
  const env = process.env;
  for (const k of ['GHL_TOKEN', 'GHL_LOCATION_ID', 'GHL_PIPELINE_ID', 'GHL_STAGE_NEW_LEAD']) if (!env[k]) { console.error(`${k} not set`); process.exit(1); }
  const lines = fs.readFileSync(path.join(OUT, 'prospects.csv'), 'utf8').split('\n').slice(1);
  const { parseCsv } = await import('./exclusions.js');
  const header = COLS;
  const rows = parseCsv(lines.join('\n')).filter((r) => r.length >= header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  const min = +flags['min-score'] || 35, max = +flags.max || 50;
  const state = fs.existsSync(path.join(OUT, 'pushed.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'pushed.json'), 'utf8')) : {};
  const todo = rows.filter((r) => +r.score >= min && !state[r.place_id]).slice(0, max);
  console.log(`${todo.length} to push (min score ${min}, max ${max})${flags.yes ? '' : ' — DRY RUN, add --yes to push'}`);
  if (!flags.yes) { for (const r of todo.slice(0, 15)) console.log(`${r.tier} ${r.score} ${r.name} (${r.town}) ${r.web_type}`); process.exit(0); }
  const idx = loadIndex(CLIENTS);
  let created = 0, dup = 0;
  for (const r of todo) {
    if (check(idx, { name: r.name, phone: r.phone, website: r.website }).excluded) { state[r.place_id] = 'excluded'; continue; }
    try {
      const res = await stageProspect(env, r);
      state[r.place_id] = res.status; res.status === 'created' ? created++ : dup++;
    } catch (e) { console.error(`! ${r.name}: ${e.message}`); }
    fs.writeFileSync(path.join(OUT, 'pushed.json'), JSON.stringify(state));
    await new Promise((r2) => setTimeout(r2, 250));
  }
  console.log(`created ${created}, already in GHL ${dup}`);
} else {
  console.log('usage: node src/run.js exclusions | find [--states MA,RI] [--trades roofing contractor,plumber] [--max-queries N] [--pages N] [--dry-run] | push [--min-score 35] [--max 50] [--yes]');
}
