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

export function withBanner(html, name) {
  const bar = `<div style="position:fixed;left:0;right:0;bottom:0;background:#111;color:#fff;font:14px system-ui,sans-serif;padding:10px 14px;text-align:center;z-index:99999">Free sample site made for ${esc(name)} by Zander's Websites. Not live on your domain. Text Zac to make it yours.</div>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, bar + '</body>') : html + bar;
}

export async function generateSite(env, p, dir, fetchImpl = fetch) {
  const facts = [`Business name: ${p.name}`, `Trade: ${p.trade}`, `Location: ${p.town}`, p.address && `Address: ${p.address}`, p.phone && `Phone: ${p.phone}`,
    p.rating && p.reviews && `Google rating: ${p.rating} from ${p.reviews} reviews`].filter(Boolean).join('\n');
  const out = await askClaude(env, {
    system: 'You build one-page marketing sample websites for small local trade businesses. Output ONE complete HTML document (doctype to </html>) with inline CSS only. No JavaScript, no forms, no external scripts. Mobile-first, clean, modern, fast. Sections: hero with a call button (tel: link), services typical for the trade, service area, why choose us, contact. STRICT: use only the facts given. Do not invent years in business, licenses, awards, owner names, testimonials, prices, or guarantees. Generic trade services are fine. No stock-photo URLs; use CSS shapes/gradients. Return only the HTML.',
    user: facts, maxTokens: 6000,
  }, fetchImpl);
  const m = out.match(/<!doctype html[\s\S]*<\/html>/i) || out.match(/<html[\s\S]*<\/html>/i);
  if (!m) throw new Error('site generation returned no HTML');
  const slug = newSlug(p.name);
  fs.mkdirSync(path.join(dir, 'sites'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sites', `${slug}.html`), withBanner(sanitize(m[0]), p.name));
  return slug;
}
