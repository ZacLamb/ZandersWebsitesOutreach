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

function prospects(limit = 300) {
  const f = path.join(OUT, 'prospects.csv');
  if (!fs.existsSync(f)) return { total: 0, rows: [], tiers: {} };
  const rows = parseCsv(fs.readFileSync(f, 'utf8')).slice(1).filter((r) => r.length >= COLS.length).map((r) => Object.fromEntries(COLS.map((c, i) => [c, r[i]])));
  const pushed = fs.existsSync(path.join(OUT, 'pushed.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'pushed.json'), 'utf8')) : {};
  const tiers = rows.reduce((a, r) => (a[r.tier] = (a[r.tier] || 0) + 1, a), {});
  return { total: rows.length, tiers, pushedCount: Object.keys(pushed).length, rows: rows.slice(0, limit).map((r) => ({ ...r, pushed: pushed[r.place_id] || '' })) };
}

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
  // Basic auth on everything else
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  const [, pw = ''] = m ? Buffer.from(m[1], 'base64').toString().match(/^[^:]*:(.*)$/) || [] : [];
  if (!m || !safeEq(pw, PASSWORD)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ZW Prospector"' }); return res.end('Auth required'); }
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, {
        job, clients: clientStatus(),
        env: { google: !!process.env.GOOGLE_PLACES_KEY, ghl: !!(process.env.GHL_TOKEN && process.env.GHL_LOCATION_ID && process.env.GHL_PIPELINE_ID && process.env.GHL_STAGE_NEW_LEAD) },
        states: Object.keys(TOWNS), trades: TRADES, townCounts: Object.fromEntries(Object.entries(TOWNS).map(([k, v]) => [k, v.length])),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/prospects') return send(res, 200, prospects());
    if (req.method === 'GET' && url.pathname === '/out/prospects.csv') {
      const f = path.join(OUT, 'prospects.csv');
      return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f, 'utf8'), 'text/csv') : send(res, 404, { error: 'no prospects yet' });
    }
    if (req.method === 'POST') {
      if (req.headers['x-zw'] !== '1') return send(res, 403, { error: 'missing X-ZW header' }); // blocks cross-site form posts
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
        const args = ['push', '--min-score', String(int(opts.minScore, 35, 0, 100)), '--max', String(int(opts.max, 1, 1, 200))];
        if (opts.yes === true) {
          if (!(process.env.GHL_TOKEN && process.env.GHL_LOCATION_ID)) return send(res, 400, { error: 'GHL env vars are not set on the server.' });
          args.push('--yes');
        }
        return startJob(opts.yes === true ? 'push' : 'push (preview)', args) ? send(res, 200, { started: true }) : send(res, 409, { error: 'A job is already running.' });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
});
server.listen(PORT, () => console.log(`ZW Prospector dashboard on :${PORT} (data: ${DATA_DIR})`));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZW Prospector</title><style>
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--tx:#e8eaf0;--mut:#8b93a7;--ac:#4f8cff;--ok:#2fbf71;--bad:#ef5b5b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.45 system-ui,sans-serif}
header{padding:14px 16px;border-bottom:1px solid var(--line);font-weight:700}
nav{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line);overflow:auto}
nav button{background:none;border:1px solid var(--line);color:var(--mut);padding:8px 14px;border-radius:999px;cursor:pointer;white-space:nowrap}
nav button.on{background:var(--ac);border-color:var(--ac);color:#fff}
main{padding:14px;max-width:1100px;margin:auto}section{display:none}section.on{display:block}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
h3{margin:0 0 8px;font-size:15px}label{display:block;color:var(--mut);font-size:13px;margin:8px 0 4px}
input,select,textarea{width:100%;background:#0c0e13;color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:9px;font:inherit}
.row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1;min-width:120px}
button.act{background:var(--ac);color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer;margin-top:10px}
button.act.danger{background:var(--bad)}button.act[disabled]{opacity:.5;cursor:not-allowed}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);margin-right:4px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.mut{color:var(--mut)}
pre{background:#0c0e13;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:260px;overflow:auto;font-size:12px;white-space:pre-wrap}
.tw{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--mut);position:sticky;top:0;background:var(--card)}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chips label{display:flex;align-items:center;gap:6px;margin:0;color:var(--tx);background:#0c0e13;border:1px solid var(--line);border-radius:999px;padding:5px 10px;width:auto}.chips input{width:auto}
</style></head><body><header>ZW Prospector <span class="mut" style="font-weight:400">· stages leads, never sends texts</span></header>
<nav id="nav"></nav><main>
<section id="s-setup"><div class="card"><h3>1. Client list (exclusions)</h3><div id="clientStatus" class="mut">…</div>
<label>Upload master client CSV</label><input type="file" id="file" accept=".csv,text/csv"><button class="act" id="upBtn">Upload</button><div id="upMsg" class="mut"></div></div>
<div class="card"><h3>Server keys</h3><div id="env"></div></div></section>
<section id="s-find"><div class="card"><h3>2. Find prospects</h3><label>States</label><div class="chips" id="states"></div>
<label>Trades (none checked = all)</label><div class="chips" id="trades"></div>
<label>Max searches (start small: 40)</label><input type="number" id="maxQ" value="40" min="1" max="5000"><button class="act" id="findBtn">Run search</button><div id="findMsg" class="mut"></div></div></section>
<section id="s-leads"><div class="card"><h3>3. Prospects</h3><div id="sum" class="mut"></div><div class="tw" style="max-height:60vh"><table id="tbl"></table></div>
<p><a href="/out/prospects.csv" style="color:var(--ac)">Download CSV</a></p></div>
<div class="card"><h3>4. Stage in GHL (50$ Sites → New Lead)</h3><div class="row"><div><label>Min score</label><input type="number" id="minS" value="35"></div><div><label>How many</label><input type="number" id="maxP" value="1"></div></div>
<button class="act" id="prevBtn" style="background:#3a4256">Preview</button> <button class="act danger" id="pushBtn">Push to GHL</button><div id="pushMsg" class="mut"></div></div></section>
<section id="s-log"><div class="card"><h3>Job</h3><div id="job" class="mut"></div><pre id="log"></pre></div></section></main>
<script>
const $=id=>document.getElementById(id),H={'X-ZW':'1','Content-Type':'application/json'};
const tabs=[['setup','Setup'],['find','Find'],['leads','Leads'],['log','Log']];
tabs.forEach(([k,n],i)=>{const b=document.createElement('button');b.textContent=n;b.onclick=()=>show(k);b.id='t-'+k;$('nav').append(b)});
function show(k){tabs.forEach(([t])=>{$('s-'+t).classList.toggle('on',t===k);$('t-'+t).classList.toggle('on',t===k)});if(k==='leads')loadLeads()}
function chip(box,v,checked){const l=document.createElement('label');const i=document.createElement('input');i.type='checkbox';i.value=v;i.checked=!!checked;l.append(i,document.createTextNode(v));box.append(l)}
const picked=box=>[...box.querySelectorAll('input:checked')].map(i=>i.value);
async function api(p,body){const r=await fetch(p,{method:'POST',headers:H,body:JSON.stringify(body||{})});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
let inited=false;
async function status(){const s=await (await fetch('/api/status')).json();
 if(!inited){inited=true;s.states.forEach(x=>chip($('states'),x,x==='MA'));s.trades.forEach(x=>chip($('trades'),x,false));show('setup')}
 const c=s.clients;$('clientStatus').textContent=c.present?c.rows+' clients · '+c.phones+' phones · '+c.domains+' business domains loaded':'No client list yet — upload one before searching.';
 $('env').innerHTML='';[['Google Places key',s.env.google],['GHL token + pipeline',s.env.ghl]].forEach(([n,ok])=>{const d=document.createElement('div');d.textContent=(ok?'✓ ':'✗ ')+n;d.className=ok?'ok':'bad';$('env').append(d)});
 const j=s.job;$('job').textContent=j.name?(j.running?'Running: ':'Last: ')+j.name+(j.running?'':' (exit '+j.code+')'):'No job yet';$('log').textContent=j.log.join('\\n');
 ['findBtn','pushBtn','prevBtn'].forEach(id=>$(id).disabled=j.running);
}
$('upBtn').onclick=async()=>{const f=$('file').files[0];if(!f)return;const r=await fetch('/api/clients',{method:'POST',headers:{'X-ZW':'1'},body:await f.text()});const j=await r.json();$('upMsg').textContent=r.ok?'Loaded '+j.rows+' clients':j.error;status()};
$('findBtn').onclick=async()=>{try{await api('/api/find',{states:picked($('states')),trades:picked($('trades')),maxQueries:+$('maxQ').value});$('findMsg').textContent='Started — see Log.';show('log')}catch(e){$('findMsg').textContent=e.message}status()};
async function push(yes){if(yes&&!confirm('Create '+$('maxP').value+' contact(s) + opportunities in GHL?'))return;try{await api('/api/push',{minScore:+$('minS').value,max:+$('maxP').value,yes});$('pushMsg').textContent='Started — see Log.';show('log')}catch(e){$('pushMsg').textContent=e.message}status()}
$('prevBtn').onclick=()=>push(false);$('pushBtn').onclick=()=>push(true);
async function loadLeads(){const p=await (await fetch('/api/prospects')).json();$('sum').textContent=p.total+' prospects · tiers '+JSON.stringify(p.tiers)+' · '+(p.pushedCount||0)+' already handled';
 const t=$('tbl');t.innerHTML='';const hr=t.insertRow();['Tier','Score','Business','Trade','Town','Phone','Web','Signals','Reviews','GHL'].forEach(h=>{const th=document.createElement('th');th.textContent=h;hr.append(th)});
 p.rows.forEach(r=>{const tr=t.insertRow();[r.tier,r.score,r.name,r.trade,r.town,r.phone,r.web_type,r.signals,r.reviews,r.pushed].forEach(v=>{tr.insertCell().textContent=v||''})})}
status();setInterval(status,3000);
</script></body></html>`;
