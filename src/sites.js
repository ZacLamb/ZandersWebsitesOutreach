// Sample-site generation for a prospect. Facts only: nothing the listing doesn't state may be invented.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { askClaude } from './claude.js';
import { stockFor } from './stock.js';

export const slugify = (name) => String(name).toLowerCase().replace(/['\u2019]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site';
export const newSlug = (name) => `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Strip anything active; the route also serves a CSP that blocks scripts.
export function sanitize(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<(iframe|object|embed|form)[\s\S]*?(<\/\1>|\/>)/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/javascript:/gi, '');
}

export function withBanner(html, name, brand = 'rgs') {
  const by = brand === 'zw' ? "Zander's Websites" : 'Revenue Generating Solutions';
  const bar = `<div style="position:fixed;left:0;right:0;bottom:0;background:#111;color:#fff;font:14px system-ui,sans-serif;padding:10px 14px;text-align:center;z-index:99999">Free sample site made for ${esc(name)} by ${by}. Not live on your domain yet. Reply to the text to make it yours.</div>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, bar + '</body>') : html + bar;
}

// One Claude-written template per TRADE (cached on disk), personalized per lead by plain text substitution.
// Cost is ~zero per lead. The deeper custom build (town pages, services, logo) only happens once they show interest.
const TOKENS = ['[[NAME]]', '[[TOWN]]', '[[PHONE]]', '[[PHONE_DIGITS]]', '[[IMG_HERO]]', '[[IMG_1]]', '[[IMG_2]]'];
async function getTemplate(env, trade, dir, fetchImpl) {
  const f = path.join(dir, 'sites', 'templates', `${slugify(trade)}-v2.html`);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const out = await askClaude(env, {
    system: `You build one-page marketing sample websites for small local trade businesses. Output ONE complete HTML document (doctype to </html>) with inline CSS only. No JavaScript, no forms, no external scripts. Mobile-first, clean, modern, fast. This is a reusable TEMPLATE for the trade "${trade}": use these exact placeholders wherever the business details go: [[NAME]] (business name), [[TOWN]] (town and state), [[PHONE]] (display phone), [[PHONE_DIGITS]] (digits only, for tel: links). Sections: hero with a call button (href="tel:[[PHONE_DIGITS]]"), typical services for this trade, service area mentioning [[TOWN]], why choose us, contact with [[PHONE]]. PHOTOS (required): the hero must use the photo [[IMG_HERO]] as a full-bleed background (background-image:url('[[IMG_HERO]]'), cover, with a dark gradient overlay so white text reads well); use <img src="[[IMG_1]]"> and <img src="[[IMG_2]]"> (object-fit:cover, rounded corners, alt text describing the trade work) in the services and why-choose-us sections, and you may reuse [[IMG_HERO]] once more. Use no other image URLs. STRICT: do not invent years in business, licenses, awards, owner names, testimonials, prices, ratings or guarantees. Return only the HTML.`,
    user: `Trade: ${trade}`, maxTokens: 6000,
  }, fetchImpl);
  const m = out.match(/<!doctype html[\s\S]*<\/html>/i) || out.match(/<html[\s\S]*<\/html>/i);
  if (!m || !m[0].includes('[[NAME]]')) throw new Error('template generation returned no usable HTML');
  const html = sanitize(m[0]);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, html);
  return html;
}

// ---- Multi-page templates built from Zac's shipped client sites (see tools/snap.js) ----
const TPL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'templates');
let TPLS = null;
export function loadTemplates() {
  if (TPLS) return TPLS;
  TPLS = [];
  if (fs.existsSync(TPL_DIR)) for (const id of fs.readdirSync(TPL_DIR)) {
    const f = path.join(TPL_DIR, id, 'meta.json');
    if (fs.existsSync(f)) TPLS.push({ ...JSON.parse(fs.readFileSync(f, 'utf8')), dir: path.join(TPL_DIR, id) });
  }
  return TPLS;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
export function pickTemplate(trade, town) {
  const [c, st = ''] = String(town || '').split(',').map((x) => x.trim());
  const city = norm(c);
  const ok = loadTemplates().filter((t) => (t.trades || []).includes(trade) && !(t.avoidTowns || []).some((a) => norm(a) === city) && (!t.states || t.states.includes(st.toUpperCase())));
  return ok.length ? ok[Math.floor(Math.random() * ok.length)] : null;
}
export function fillTokens(html, d) {
  const digits = String(d.phone || '').replace(/\D/g, '').slice(-10);
  const pretty = digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : String(d.phone || '');
  const [city, state = ''] = String(d.town || '').split(',').map((x) => x.trim());
  const v = { NAME: esc(d.name), PHONE: esc(pretty), PHONE_DIGITS: digits, CITY: esc(city), STATE: esc(state), TOWN: esc(d.town || ''), ASSET: `/t/${d.tpl}` };
  return html.replace(/\[\[(NAME|PHONE_DIGITS|PHONE|CITY|STATE|TOWN|ASSET)\]\]/g, (_, k) => v[k]);
}
// Pages with no pictures at all (older one-page samples, templates whose photos were stripped) get a photo band
// with stock photos for their trade right after the hero. Generic trade photos, no claims about whose work it is.
export const hasPhotos = (html) => /<img\s[^>]*src=["']https?:|url\(['"]?https?:[^)]*\.(png|jpe?g|webp)/i.test(html);
export function withPhotos(html, trade) {
  if (hasPhotos(html)) return html;
  const [h, a, b] = stockFor(trade);
  const alt = esc(String(trade || 'local service') + ' work');
  const band = `<section style="padding:28px 16px;background:#fff"><div style="max-width:1120px;margin:0 auto;display:grid;gap:12px;grid-template-columns:2fr 1fr"><img src="${h}" alt="${alt}" style="width:100%;height:100%;min-height:220px;max-height:420px;object-fit:cover;border-radius:14px;grid-row:span 2"><img src="${a}" alt="${alt}" style="width:100%;height:100%;min-height:104px;max-height:204px;object-fit:cover;border-radius:14px"><img src="${b}" alt="${alt}" style="width:100%;height:100%;min-height:104px;max-height:204px;object-fit:cover;border-radius:14px"></div></section>`;
  const i = html.search(/<\/section>/i);
  return i >= 0 ? html.slice(0, i + 10) + band + html.slice(i + 10) : html.replace(/<body([^>]*)>/i, `<body$1>${band}`);
}
export function renderTemplatePage(d, page, slug) {
  const t = loadTemplates().find((x) => x.id === d.tpl);
  if (!t) return null;
  const name = (!page || page === '/' ? 'index' : page.replace(/^\/|\/$/g, '').replace(/\//g, '__')).replace(/[^a-z0-9_-]/gi, '') + '.html';
  const f = path.join(t.dir, 'pages', name);
  if (!fs.existsSync(f)) return null;
  let html = fillTokens(fs.readFileSync(f, 'utf8'), d);
  if (!page || page === '/') html = withPhotos(html, d.trade || (t.trades || [])[0]);
  html = html.replace(/<head([^>]*)>/i, `<head$1><base href="/s/${slug}/">`);
  return withBanner(html, d.name, d.brand);
}

export async function generateSite(env, p, dir, fetchImpl = fetch, brand = 'rgs') {
  const tpl = pickTemplate(p.trade, p.town);
  if (tpl) {
    const slug = newSlug(p.name);
    fs.mkdirSync(path.join(dir, 'sites'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sites', `${slug}.json`), JSON.stringify({ tpl: tpl.id, name: p.name, phone: p.phone, town: p.town, trade: p.trade, brand }));
    return slug;
  }
  const base = await getTemplate(env, p.trade, dir, fetchImpl);
  const digits = String(p.phone || '').replace(/\D/g, '').slice(-10);
  const pretty = digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : String(p.phone || '');
  const st = stockFor(p.trade);
  const vals = { '[[NAME]]': esc(p.name), '[[TOWN]]': esc(p.town), '[[PHONE]]': esc(pretty), '[[PHONE_DIGITS]]': digits, '[[IMG_HERO]]': st[0], '[[IMG_1]]': st[1], '[[IMG_2]]': st[2] };
  let html = base; for (const t of TOKENS) html = html.split(t).join(vals[t]);
  const slug = newSlug(p.name);
  fs.mkdirSync(path.join(dir, 'sites'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sites', `${slug}.html`), withBanner(withPhotos(html, p.trade), p.name, brand));
  return slug;
}
