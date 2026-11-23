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
import { createAutopilot, STAGES } from './autopilot.js';
import { PLANS, checkStripe } from './stripe.js';
import { createPush } from './push.js';
import { renderTemplatePage } from './sites.js';

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
const push = createPush(DATA_DIR, process.env.PUBLIC_URL || undefined);
const autopilot = createAutopilot({
  dir: DATA_DIR,
  deps: {
    notify: (m) => push.send(m),
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
  const CSP = "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' https: data:";
  const pageHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300' };
  const sm = url.pathname.match(/^\/s\/([a-z0-9-]{6,80})(\/.*)?$/);
  if (req.method === 'GET' && sm) {
    const slug = sm[1], sub = sm[2] || '';
    const j = path.join(DATA_DIR, 'sites', `${slug}.json`);
    if (fs.existsSync(j)) { // multi-page template sample
      if (!sub) { res.writeHead(301, { Location: `/s/${slug}/` }); return res.end(); }
      const html = renderTemplatePage(JSON.parse(fs.readFileSync(j, 'utf8')), sub, slug);
      if (!html) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, pageHeaders); return res.end(html);
    }
    const f = path.join(DATA_DIR, 'sites', `${slug}.html`);
    if ((sub && sub !== '/') || !fs.existsSync(f)) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, pageHeaders); return res.end(fs.readFileSync(f));
  }
  const dm = url.pathname.match(/^\/demo\/([a-z0-9-]{2,40})(\/.*)?$/); // public preview of a template with made-up details
  if (req.method === 'GET' && dm) {
    if (!dm[2]) { res.writeHead(301, { Location: `/demo/${dm[1]}/` }); return res.end(); }
    let html = renderTemplatePage({ tpl: dm[1], name: 'Bay State Example Co', phone: '5085550100', town: 'Falmouth, MA', brand: 'rgs' }, dm[2], 'x');
    if (!html) return send(res, 404, 'Not found', 'text/plain');
    html = html.replace('<base href="/s/x/">', `<base href="/demo/${dm[1]}/">`);
    res.writeHead(200, pageHeaders); return res.end(html);
  }
  const tm = url.pathname.match(/^\/t\/([a-z0-9-]{2,40})\/([\w./-]{1,200})$/);
  if (req.method === 'GET' && tm && !tm[2].includes('..')) {
    const f = path.join(ROOT, 'templates', tm[1], 'assets', tm[2]);
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, 'Not found', 'text/plain');
    const type = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff', ico: 'image/x-icon' }[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }); return res.end(fs.readFileSync(f));
  }
  if (req.method === 'POST' && url.pathname === '/hook/ghl') {
    if (!process.env.GHL_WEBHOOK_SECRET || !safeEq(url.searchParams.get('s') || '', process.env.GHL_WEBHOOK_SECRET)) return send(res, 401, { error: 'bad secret' });
    try {
      const b = JSON.parse((await readBody(req, 2e5)) || '{}');
      const contactId = b.contact_id || b.contactId || b.contact?.id;
      const text = b.customData?.reply_body || b.reply_body || (typeof b.message === 'object' ? b.message?.body : b.message) || b.body || b.text || '';
      const dir = String(b.direction || b.message?.direction || 'inbound').toLowerCase();
      if (!contactId || dir === 'outbound') return send(res, 200, { ignored: true });
      return send(res, 200, await autopilot.handleInbound({ contactId, text }));
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // Public app shell files (icon + manifest) so the dashboard works as a home-screen app.
  const pub = url.pathname.match(/^\/(manifest\.json|apple-touch-icon\.png|icon-192\.png|icon-512\.png|sw\.js)$/);
  if (req.method === 'GET' && pub) {
    const ctype = pub[1].endsWith('.json') ? 'application/manifest+json' : pub[1].endsWith('.js') ? 'text/javascript' : 'image/png';
    res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': pub[1] === 'sw.js' ? 'no-cache' : 'public, max-age=86400', ...(pub[1] === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) });
    return res.end(fs.readFileSync(path.join(ROOT, 'public', pub[1])));
  }
  // Sign-in: a remembered cookie (home-screen apps can't show the browser password popup). Basic auth still works.
  const SESSION = crypto.createHmac('sha256', PASSWORD).update('zw-session-v1').digest('hex');
  const cookieOk = (req.headers.cookie || '').split(/;\s*/).some((c) => c === `zw=${SESSION}`);
  if (url.pathname === '/login' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req, 1e4));
    if (safeEq(body.get('pw') || '', PASSWORD)) {
      res.writeHead(303, { 'Set-Cookie': `zw=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`, Location: '/' }); return res.end();
    }
    res.writeHead(303, { Location: '/login?bad=1' }); return res.end();
  }
  if (url.pathname === '/logout') { res.writeHead(303, { 'Set-Cookie': 'zw=; Path=/; Max-Age=0', Location: '/login' }); return res.end(); }
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  const [, pw = ''] = m ? Buffer.from(m[1], 'base64').toString().match(/^[^:]*:(.*)$/) || [] : [];
  if (!cookieOk && !(m && safeEq(pw, PASSWORD))) {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
      return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZW Outreach</title><link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Outreach"><meta name="theme-color" content="#0f1115"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8eaf0;font:16px system-ui,sans-serif}form{background:#171a21;border:1px solid #262b36;border-radius:16px;padding:24px;width:min(340px,88vw)}input,button{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:12px;border-radius:10px;margin-top:10px}input{background:#0c0e13;color:#e8eaf0;border:1px solid #262b36}button{background:#4f8cff;color:#fff;border:0;font-weight:600}.bad{color:#ef5b5b;font-size:14px}</style></head><body><form method="post" action="/login"><b style="font-size:20px">ZW Outreach</b>${url.searchParams.get('bad') ? '<div class="bad">Wrong password, try again.</div>' : ''}<input type="password" name="pw" placeholder="Password" autocomplete="current-password" autofocus><button>Sign in</button></form></body></html>`, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/out/')) { res.writeHead(303, { Location: '/login' }); return res.end(); }
    return send(res, 401, { error: 'sign in again' });
  }
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
    if (req.method === 'GET' && url.pathname === '/api/leads') return send(res, 200, { leads: autopilot.leadsView(), stages: STAGES, plans: PLANS, stripe: { rgs: !!process.env.STRIPE_KEY_RGS, zw: !!process.env.STRIPE_KEY_ZW } });
    if (req.method === 'GET' && url.pathname === '/api/push/key') return send(res, 200, { key: push.publicKey(), devices: push.count() });
    if (req.method === 'GET' && url.pathname === '/api/lead/live') { try { return send(res, 200, autopilot.live(String(url.searchParams.get('id') || ''))); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (req.method === 'GET' && url.pathname === '/api/learn') return send(res, 200, autopilot.learnView());
    if (req.method === 'GET' && url.pathname === '/api/metrics') return send(res, 200, autopilot.metrics());
    const tmatch = url.pathname.match(/^\/api\/thread\/([\w-]{3,200})$/);
    if (req.method === 'GET' && tmatch) { try { return send(res, 200, await autopilot.thread(tmatch[1])); } catch (e) { return send(res, 404, { error: e.message }); } }
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
        else if (url.pathname.endsWith('/test')) { try { await autopilot.testSend(o.brand === 'zw' ? 'zw' : 'rgs'); } catch (e) { return send(res, 400, { error: e.message }); } }
        else if (url.pathname.endsWith('/test-end')) await autopilot.endTest();
        else return send(res, 404, { error: 'not found' });
        return send(res, 200, autopilot.view());
      }
      if (url.pathname === '/api/push/subscribe') { try { push.subscribe(JSON.parse((await readBody(req, 1e4)) || '{}')); return send(res, 200, { ok: true, devices: push.count() }); } catch (e) { return send(res, 400, { error: e.message }); } }
      if (url.pathname === '/api/push/test') { await push.send({ title: 'ZW Outreach', body: 'Notifications are on. You will get one for every reply.', url: '/' }); return send(res, 200, { ok: true, devices: push.count() }); }
      if (url.pathname === '/api/stripe/check') return send(res, 200, { rgs: await checkStripe(process.env, 'rgs'), zw: await checkStripe(process.env, 'zw') });
      if (url.pathname.startsWith('/api/learn/')) {
        const o = JSON.parse((await readBody(req, 1e4)) || '{}');
        try {
          if (url.pathname === '/api/learn/run') { await autopilot.learnNow('you asked'); return send(res, 200, autopilot.learnView()); }
          if (url.pathname === '/api/learn/teach') return send(res, 200, autopilot.teach(o.text));
          if (url.pathname === '/api/learn/forget') return send(res, 200, autopilot.forget(String(o.id || '')));
        } catch (e) { return send(res, 400, { error: e.message }); }
        return send(res, 404, { error: 'not found' });
      }
      if (url.pathname.startsWith('/api/lead/')) {
        const o = JSON.parse((await readBody(req, 1e5)) || '{}'); const id = String(o.id || '');
        try {
          if (url.pathname === '/api/lead/reply') return send(res, 200, await autopilot.reply(id, o.text));
          if (url.pathname === '/api/lead/call') return send(res, 200, await autopilot.callLead(id));
          if (url.pathname === '/api/lead/feedback') return send(res, 200, await autopilot.feedback(id, o.text, o.rewrite, o.note));
          if (url.pathname === '/api/lead/draft') return send(res, 200, await autopilot.draftAction(id, String(o.pid || ''), String(o.action || ''), o.text));
          if (url.pathname === '/api/lead/owner') return send(res, 200, autopilot.setOwner(id, String(o.owner || '')));
          if (url.pathname === '/api/lead/stage') return send(res, 200, await autopilot.setStage(id, String(o.stage || '')));
          if (url.pathname === '/api/lead/paylink') return send(res, 200, await autopilot.payLink(id, String(o.plan || '')));
        } catch (e) { return send(res, 400, { error: e.message }); }
        return send(res, 404, { error: 'not found' });
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
