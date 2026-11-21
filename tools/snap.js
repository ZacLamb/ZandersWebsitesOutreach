// Turns one of Zac's shipped client sites into a reusable sample-site template pack.
// Usage: node snap.js <template-id>   (config in templates.config.js)
// Output: out/<id>/pages/*.html (with [[TOKENS]]), out/<id>/assets/**, out/<id>/meta.json
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cheerio = require('cheerio');
const CONFIGS = require('./templates.config');

const id = process.argv[2];
const C = CONFIGS[id];
if (!C) { console.error('unknown template', id, Object.keys(CONFIGS)); process.exit(1); }
const REPO = path.resolve(__dirname, '..', 'refsites', C.repo);
const OUT = path.join(__dirname, 'out', id);
const PORT = 4200 + Math.floor(Math.random() * 500);

// Preload hook that swaps the repo's data modules for placeholder versions.
const hookFile = path.join(__dirname, `.hook-${id}.js`);
fs.writeFileSync(hookFile, `
const Module = require('module'); const path = require('path');
const ov = ${JSON.stringify(C.overrides || {})};
const orig = Module._load;
Module._load = function (req, parent, isMain) {
  const out = orig.apply(this, arguments);
  try {
    const file = Module._resolveFilename(req, parent, isMain);
    for (const [rel, val] of Object.entries(ov)) {
      if (file === path.join(${JSON.stringify(REPO)}, rel)) {
        if (Array.isArray(val)) return val;
        if (val && typeof val === 'object' && out && typeof out === 'object' && !Array.isArray(out)) { const m = Object.assign({}, out); for (const [k, v] of Object.entries(val)) m[k] = (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) ? Object.assign({}, out[k], v) : v; return m; }
        return val;
      }
    }
  } catch {}
  return out;
};`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  const child = spawn(process.execPath, ['-r', hookFile, C.entry || 'server.js'], { cwd: REPO, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  child.on('exit', (c) => { if (c) console.error('server exited', c, log.slice(-1500)); });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await sleep(250); } }
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, 'pages'), { recursive: true });
    const pages = typeof C.pages === 'function' ? await C.pages(PORT) : C.pages;
    const keep = new Set(pages.map((p) => p.replace(/\/$/, '') || '/'));
    const leaks = [];
    for (const p of pages) {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
      if (!res.ok) { console.error('skip', p, res.status); continue; }
      let html = await res.text();
      html = transform(html, keep, leaks, p);
      const name = (p === '/' ? 'index' : p.replace(/^\/|\/$/g, '').replace(/\//g, '__')) + '.html';
      fs.writeFileSync(path.join(OUT, 'pages', name), html);
    }
    // static assets
    const pub = path.join(REPO, C.publicDir || 'public');
    if (fs.existsSync(pub)) fs.cpSync(pub, path.join(OUT, 'assets'), { recursive: true, filter: (s) => !/\.(mp4|mov|zip|psd|jpe?g|png|webp)$/i.test(s) && !(C.skipAssets || []).some((r) => new RegExp(r).test(s)) });
    fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ id, repo: C.repo, trades: C.trades, states: C.states, avoidTowns: C.avoidTowns, pages: [...keep], builtAt: new Date().toISOString() }, null, 2));
    if (leaks.length) { console.error('LEAKS:\n' + [...new Set(leaks)].slice(0, 60).join('\n')); process.exitCode = 2; }
    else console.log(`ok ${id}: ${pages.length} pages`);
  } finally { child.kill(); fs.rmSync(hookFile, { force: true }); }
  if (log && (process.exitCode || process.env.DEBUG)) console.error(log.slice(-1500));
}

function transform(html, keep, leaks, page) {
  const $ = cheerio.load(html, { decodeEntities: false });
  // 1. Remove things that would misrepresent the prospect or leak the original client.
  $('script, noscript, iframe, form, link[rel="canonical"], link[rel="alternate"], meta[property^="og:"], meta[name^="twitter:"]').remove();
  for (const sel of C.logoSelectors || []) $(sel).replaceWith('<span style="font-weight:800;font-size:1.3rem;line-height:1.1;letter-spacing:-.01em;color:inherit">[[NAME]]</span>');
  for (const sel of C.removeSelectors || []) $(sel).remove();
  for (const pre of C.removeLinksTo || []) $(`a[href^="${pre}"]`).each((_, a) => { const li = $(a).closest('li'); (li.length && li.find('a').length === 1 ? li : $(a)).remove(); });
  for (const rx of C.removeBlocksMatching || []) {
    const re = new RegExp(rx, 'i');
    // remove the matching element, or its nearest small item wrapper (never a whole section)
    $('h1,h2,h3,h4,h5,p,span,div,li,strong,a,summary,dt').each((_, el) => {
      if (!$(el).parent().length) return;
      const t = $(el).text().trim();
      if (t.length >= 300 || !re.test(t)) return;
      if ($(el).children().filter((_, c) => re.test($(c).text())).length) return; // let the innermost match decide
      const item = $(el).closest(C.itemSelector || 'li, details, [class*="__item"], [class*="-item"], [class*="badge"], [class*="chip"]');
      (item.length && item.text().trim().length < 400 ? item : $(el)).remove();
    });
  }
  // 2. Text + attribute replacements (order matters).
  const reps = (C.replacements || []).map(([a, b]) => [new RegExp(a, 'g'), b]);
  const fix = (s) => { for (const [re, b] of reps) s = s.replace(re, b); return s; };
  $('*').contents().each((_, n) => { if (n.type === 'text') n.data = fix(n.data); });
  $('[title],[alt],[content],[aria-label],[placeholder]').each((_, el) => {
    for (const a of ['title', 'alt', 'content', 'aria-label', 'placeholder']) { const v = $(el).attr(a); if (v) $(el).attr(a, fix(v)); }
  });
  $('title').text(fix($('title').text()));
  // 3. Links: pages we keep stay inside the sample; everything else goes to the sample's contact page.
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href');
    if (/^(tel:|mailto:|#)/.test(h)) return;
    let u; try { u = new URL(h, 'http://x'); } catch { return; }
    if (u.host !== 'x' && !(C.ownDomains || []).some((d) => u.host.endsWith(d))) { $(el).attr('href', 'contact'); return; }
    const p = u.pathname.replace(/\/$/, '') || '/';
    $(el).attr('href', keep.has(p) ? (p === '/' ? './' : p.replace(/^\//, '')) + (u.hash || '') : 'contact');
  });
  if (C.imgMap) $('img, source').each((_, el) => {
    const m = /^\/img\/([a-z0-9-]+?)-\d+\.webp$/.exec($(el).attr('src') || '');
    if (m && C.imgMap[m[1]]) { $(el).attr('src', C.imgMap[m[1]]); $(el).removeAttr('srcset'); $(el).removeAttr('sizes'); }
    else if (m) $(el).remove();
  });
  $('img[src=""]').remove();
  for (const [rx, to] of C.urlRewrites || []) {
    const re = new RegExp(rx);
    $('[src],[style]').each((_, el) => { for (const a of ['src', 'style']) { const v = $(el).attr(a); if (v && re.test(v)) $(el).attr(a, v.replace(new RegExp(rx, 'g'), to)); } $(el).removeAttr('srcset'); });
  }
  $('[src],[href],[srcset]').each((_, el) => {
    for (const a of ['src', 'href']) { const v = $(el).attr(a); if (v && /^\/(?!\/)/.test(v) && /\.\w{2,5}(\?|$)/.test(v)) $(el).attr(a, '[[ASSET]]' + v); }
    const ss = $(el).attr('srcset'); if (ss) $(el).attr('srcset', ss.replace(/(^|,\s*)\/(?!\/)/g, '$1[[ASSET]]/'));
  });
  $('style').each((_, el) => { $(el).html(($(el).html() || '').replace(/url\((['"]?)\/(?!\/)/g, 'url($1[[ASSET]]/')); });
  $('head').prepend('<meta name="robots" content="noindex, nofollow">');
  // scripts are stripped, so force scroll-reveal content visible; plus any per-template CSS fixes
  $('head').append(`<style>[class*="reveal"],[class*="reveal"]>*,[data-aos],.fade-in,.animate-on-scroll{opacity:1!important;transform:none!important;visibility:visible!important}${C.extraCss || ''}</style>`);
  let out = $.html();
  // 4. Leak check against the original client's identity.
  for (const term of C.leakTerms || []) {
    const re = new RegExp(term, 'gi'); let m;
    const text = cheerio.load(out).root().text() + ' ' + out.match(/(content|alt|title)="[^"]*"/g)?.join(' ');
    while ((m = re.exec(text))) leaks.push(`${page}: ...${text.slice(Math.max(0, m.index - 50), m.index + 50).replace(/\s+/g, ' ')}...`);
  }
  return out;
}
main().catch((e) => { console.error(e.message); process.exit(1); });
