// Sample-site generation for a prospect. Facts only: nothing the listing doesn't state may be invented.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { askClaude } from './claude.js';

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
const TOKENS = ['[[NAME]]', '[[TOWN]]', '[[PHONE]]', '[[PHONE_DIGITS]]'];
async function getTemplate(env, trade, dir, fetchImpl) {
  const f = path.join(dir, 'sites', 'templates', `${slugify(trade)}.html`);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const out = await askClaude(env, {
    system: `You build one-page marketing sample websites for small local trade businesses. Output ONE complete HTML document (doctype to </html>) with inline CSS only. No JavaScript, no forms, no external scripts. Mobile-first, clean, modern, fast. This is a reusable TEMPLATE for the trade "${trade}": use these exact placeholders wherever the business details go: [[NAME]] (business name), [[TOWN]] (town and state), [[PHONE]] (display phone), [[PHONE_DIGITS]] (digits only, for tel: links). Sections: hero with a call button (href="tel:[[PHONE_DIGITS]]"), typical services for this trade, service area mentioning [[TOWN]], why choose us, contact with [[PHONE]]. STRICT: do not invent years in business, licenses, awards, owner names, testimonials, prices, ratings or guarantees. No stock-photo URLs; use CSS shapes/gradients. Return only the HTML.`,
    user: `Trade: ${trade}`, maxTokens: 6000,
  }, fetchImpl);
  const m = out.match(/<!doctype html[\s\S]*<\/html>/i) || out.match(/<html[\s\S]*<\/html>/i);
  if (!m || !m[0].includes('[[NAME]]')) throw new Error('template generation returned no usable HTML');
  const html = sanitize(m[0]);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, html);
  return html;
}

export async function generateSite(env, p, dir, fetchImpl = fetch, brand = 'rgs') {
  const tpl = await getTemplate(env, p.trade, dir, fetchImpl);
  const digits = String(p.phone || '').replace(/\D/g, '').slice(-10);
  const pretty = digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : String(p.phone || '');
  const vals = { '[[NAME]]': esc(p.name), '[[TOWN]]': esc(p.town), '[[PHONE]]': esc(pretty), '[[PHONE_DIGITS]]': digits };
  let html = tpl; for (const t of TOKENS) html = html.split(t).join(vals[t]);
  const slug = newSlug(p.name);
  fs.mkdirSync(path.join(dir, 'sites'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sites', `${slug}.html`), withBanner(html, p.name, brand));
  return slug;
}
