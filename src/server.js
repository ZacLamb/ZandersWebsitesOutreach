// Password-protected dashboard that drives the CLI (src/run.js) so it can run on Railway.
// Zero dependencies. One job at a time. Never sends a text; "push" only stages contacts in GHL.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIndex, parseCsv } from './exclusions.js';
import { TOWNS, TRADES } from './towns.js';
import { createAutopilot } from './autopilot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT);
const CLIENTS = path.join(DATA_DIR, 'data', 'clients.csv');
const OUT = path.join(DATA_DIR, 'out');
const PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = +process.env.PORT || 3000;
const COLS = ['tier', 'score', 'name', 'trade', 'town', 'phone', 'website', 'web_type', 'signals', 'rating', 'reviews', 'address', 'maps_url', 'place_id'];

if (!PASSWORD || PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD must be set (8+ chars). Refusing to start an unprotected dashboard.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(CLIENTS), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const safeEq = (a, b) => {
  const A = crypto.createHash('sha256').update(String(a)).digest(), B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
};

let job = { running: false, name: null, startedAt: null, endedAt: null, code: null, log: [] };
function startJob(name, args) {
  if (job.running) return false;
  job = { running: true, name, startedAt: Date.now(), endedAt: null, code: null, log: [`$ run ${name}`] };
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'run.js'), ...args], { cwd: ROOT, env: { ...process.env, DATA_DIR } });
  const add = (d) => { for (const l of d.toString().split('\n')) if (l.trim()) job.log.push(l); if (job.log.length > 400) job.log = job.log.slice(-400); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  child.on('close', (code) => { job.running = false; job.code = code; job.endedAt = Date.now(); });
  child.on('error', (e) => { job.running = false; job.code = -1; job.log.push(`spawn error: ${e.message}`); });
  return true;
}

function clientStatus() {
  if (!fs.existsSync(CLIENTS)) return { present: false };
  const idx = buildIndex(fs.readFileSync(CLIENTS, 'utf8'));
  return { present: true, rows: idx.rows, names: idx.names.size, phones: idx.phones.size, domains: idx.emailDomains.size, updated: fs.statSync(CLIENTS).mtimeMs };
}

const PUSHED = () => path.join(OUT, 'pushed.json');
const readPushed = () => (fs.existsSync(PUSHED()) ? JSON.parse(fs.readFileSync(PUSHED(), 'utf8')) : {});
function prospects(limit = 3000) {
  const f = path.join(OUT, 'prospects.csv');
  const state = readPushed();
  const stats = { total: 0, ready: 0, staged: 0, skipped: 0, tiers: {} };
  if (!fs.existsSync(f)) return { stats, rows: [] };
  const rows = parseCsv(fs.readFileSync(f, 'utf8')).slice(1).filter((r) => r.length >= COLS.length).map((r) => Object.fromEntries(COLS.map((c, i) => [c, r[i]])));
  for (const r of rows) {
    r.state = state[r.place_id] || '';
    stats.total++;
    stats.tiers[r.tier] = (stats.tiers[r.tier] || 0) + 1;
    if (r.state === 'skipped') stats.skipped++; else if (r.state === 'excluded') stats.skipped++; else if (r.state) stats.staged++; else if (r.tier !== 'C') stats.ready++;
  }
  return { stats, rows: rows.slice(0, limit) };
}
function searchProgress() {
  const f = path.join(OUT, 'searched.json');
  const done = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).length : 0;
  const possible = Object.values(TOWNS).reduce((n, t) => n + t.length, 0) * TRADES.length;
  return { done, possible };
}

const digits10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const candidates = (skipIds, optOut) => { const st = readPushed(); return prospects().rows.filter((r) => r.tier !== 'C' && !r.state && !st[r.place_id] && !skipIds.has(r.place_id) && digits10(r.phone).length === 10 && !optOut.has(digits10(r.phone))); };
const autopilot = createAutopilot({
  dir: DATA_DIR,
  deps: {
    nextProspect: (skip, opt) => candidates(skip, opt)[0] || null,
    readyCount: (skip, opt) => candidates(skip, opt).length,
    markState: (id, v) => { const st = readPushed(); st[id] = v; fs.writeFileSync(PUSHED(), JSON.stringify(st)); },
    jobRunning: () => job.running,
    startFind: (n) => clientStatus().present && !!process.env.GOOGLE_PLACES_KEY && startJob('find', ['find', '--max-queries', String(n)]),
  },
});
setInterval(() => autopilot.tick().catch((e) => console.error('autopilot tick:', e.message)), 20000);

const readBody = (req, max = 3e6) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const int = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) && v !== '' && v != null ? Math.floor(+v) : d));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return send(res, 200, 'ok', 'text/plain');
  // Public sample sites (no scripts allowed by CSP) and the GHL reply webhook (secret in query string).
  const sm = url.pathname.match(/^\/s\/([a-z0-9-]{6,80})$/);
  if (req.method === 'GET' && sm) {
    const f = path.join(DATA_DIR, 'sites', `${sm[1]}.html`);
    if (!fs.existsSync(f)) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:", 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300' });
    return res.end(fs.readFileSync(f));
  }
  if (req.method === 'POST' && url.pathname === '/hook/ghl') {
    if (!process.env.GHL_WEBHOOK_SECRET || !safeEq(url.searchParams.get('s') || '', process.env.GHL_WEBHOOK_SECRET)) return send(res, 401, { error: 'bad secret' });
    try {
      const b = JSON.parse((await readBody(req, 2e5)) || '{}');
      const contactId = b.contact_id || b.contactId || b.contact?.id;
      const text = (typeof b.message === 'object' ? b.message?.body : b.message) || b.body || b.text || '';
      const dir = String(b.direction || b.message?.direction || 'inbound').toLowerCase();
      if (!contactId || dir === 'outbound') return send(res, 200, { ignored: true });
      return send(res, 200, await autopilot.handleInbound({ contactId, text }));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // Basic auth on everything else
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  const [, pw = ''] = m ? Buffer.from(m[1], 'base64').toString().match(/^[^:]*:(.*)$/) || [] : [];
  if (!m || !safeEq(pw, PASSWORD)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ZW Prospector"' }); return res.end('Auth required'); }
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(ROOT, 'src', 'page.html'), 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, {
        job, clients: clientStatus(), stats: prospects(0).stats, search: searchProgress(),
        env: { google: !!process.env.GOOGLE_PLACES_KEY, ghl: !!(process.env.GHL_TOKEN && process.env.GHL_LOCATION_ID && process.env.GHL_PIPELINE_ID && process.env.GHL_STAGE_NEW_LEAD) },
        states: Object.keys(TOWNS), trades: TRADES, townCounts: Object.fromEntries(Object.entries(TOWNS).map(([k, v]) => [k, v.length])),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/autopilot') return send(res, 200, autopilot.view());
    if (req.method === 'GET' && url.pathname === '/api/prospects') return send(res, 200, prospects());
    if (req.method === 'GET' && url.pathname === '/out/prospects.csv') {
      const f = path.join(OUT, 'prospects.csv');
      return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f, 'utf8'), 'text/csv') : send(res, 404, { error: 'no prospects yet' });
    }
    if (req.method === 'POST') {
      if (req.headers['x-zw'] !== '1') return send(res, 403, { error: 'missing X-ZW header' }); // blocks cross-site form posts
      if (url.pathname.startsWith('/api/autopilot/')) {
        const o = JSON.parse((await readBody(req, 1e5)) || '{}');
        if (url.pathname.endsWith('/settings')) autopilot.setSettings(o);
        else if (url.pathname.endsWith('/resume')) autopilot.resume();
        else if (url.pathname.endsWith('/resolve')) autopilot.resolve(String(o.id || ''));
        else return send(res, 404, { error: 'not found' });
        return send(res, 200, autopilot.view());
      }
      if (url.pathname === '/api/clients') {
        const body = await readBody(req);
        const idx = buildIndex(body);
        if (idx.rows < 1) return send(res, 400, { error: 'No rows with a "Business Name" column found. Is this the master client CSV?' });
        fs.writeFileSync(CLIENTS, body);
        return send(res, 200, clientStatus());
      }
      const opts = JSON.parse((await readBody(req, 1e5)) || '{}');
      if (url.pathname === '/api/find') {
        if (!clientStatus().present) return send(res, 400, { error: 'Upload the client sheet first so existing clients are excluded.' });
        if (!process.env.GOOGLE_PLACES_KEY) return send(res, 400, { error: 'GOOGLE_PLACES_KEY is not set on the server.' });
        const states = (opts.states || []).filter((s) => TOWNS[s]);
        const trades = (opts.trades || []).filter((t) => TRADES.includes(t));
        const args = ['find', '--max-queries', String(int(opts.maxQueries, 40, 1, 5000))];
        if (states.length) args.push('--states', states.join(','));
        if (trades.length) args.push('--trades', trades.join(','));
        return startJob('find', args) ? send(res, 200, { started: true }) : send(res, 409, { error: 'A job is already running.' });
      }
      if (url.pathname === '/api/push') {
        if (!clientStatus().present) return send(res, 400, { error: 'Upload the client sheet first.' });
        const ids = Array.isArray(opts.ids) ? opts.ids.filter((i) => typeof i === 'string' && /^[\w-]{5,200}$/.test(i)).slice(0, 200) : null;
        if (ids && !ids.length) return send(res, 400, { error: 'Nothing selected.' });
        const args = ['push', '--min-score', String(int(opts.minScore, 35, 0, 100)), '--max', String(int(opts.max, 1, 1, 200))];
        if (ids) args.push('--ids', ids.join(','));
        if (opts.yes === true) {
          if (!(process.env.GHL_TOKEN && process.env.GHL_LOCATION_ID)) return send(res, 400, { error: 'GHL env vars are not set on the server.' });
          args.push('--yes');
        }
        return startJob(opts.yes === true ? 'push' : 'push (preview)', args) ? send(res, 200, { started: true }) : send(res, 409, { error: 'A job is already running.' });
      }
      if (url.pathname === '/api/skip') { // hide leads you don't want (or bring them back with restore:true)
        if (job.running) return send(res, 409, { error: 'A job is running; try again in a moment.' });
        const ids = (Array.isArray(opts.ids) ? opts.ids : []).filter((i) => typeof i === 'string' && /^[\w-]{5,200}$/.test(i)).slice(0, 2000);
        const st = readPushed();
        for (const i of ids) { if (opts.restore === true) { if (st[i] === 'skipped') delete st[i]; } else if (!st[i]) st[i] = 'skipped'; }
        fs.writeFileSync(PUSHED(), JSON.stringify(st));
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
});
server.listen(PORT, () => console.log(`ZW Prospector dashboard on :${PORT} (data: ${DATA_DIR})`));
