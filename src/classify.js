// Classifies a prospect's web presence and scores how good a pitch target they are.
import { domainOf } from './exclusions.js';

const SOCIAL = ['facebook.com', 'fb.com', 'instagram.com', 'linktr.ee', 'yelp.com', 'nextdoor.com', 'tiktok.com', 'youtube.com', 'google.com', 'goo.gl', 'g.page', 'business.site', 'mapquest.com', 'angi.com', 'homeadvisor.com', 'thumbtack.com', 'bbb.org', 'yellowpages.com', 'manta.com'];
const BUILDERS = ['wixsite.com', 'wix.com', 'squarespace.com', 'godaddysites.com', 'weebly.com', 'webs.com', 'site123.com', 'jimdosite.com', 'wordpress.com', 'carrd.co', 'strikingly.com', 'mysite.com'];

export function classifyUrl(url) {
  if (!url) return { type: 'none', host: null };
  const host = domainOf(url);
  if (!host) return { type: 'none', host: null };
  if (SOCIAL.some((d) => host === d || host.endsWith('.' + d))) return { type: 'social-only', host };
  if (BUILDERS.some((d) => host === d || host.endsWith('.' + d))) return { type: 'builder-subdomain', host };
  return { type: 'own-domain', host };
}

// Inspect fetched homepage HTML for age/quality signals. Pure function so it can be unit-tested.
export function analyzeHtml(html, { https = true, now = new Date() } = {}) {
  const signals = [];
  if (!html || html.length < 400) { signals.push('page-empty-or-broken'); return signals; }
  const h = html.toLowerCase();
  if (!https) signals.push('no-https');
  if (!/<meta[^>]+name=["']viewport["']/.test(h)) signals.push('not-mobile-friendly');
  const years = [...h.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2}|19\d{2})/g)].map((m) => +m[1]);
  if (years.length) {
    const y = Math.max(...years);
    if (now.getFullYear() - y >= 3) signals.push(`stale-copyright-${y}`);
  }
  if (/<table[^>]+(width|bgcolor)=/.test(h) || /<font[ >]/.test(h) || /<marquee/.test(h)) signals.push('table-or-font-tags-layout');
  if (/wix\.com|wixstatic|squarespace|godaddy|weebly|hibu|yodle|websites\.godaddy/.test(h)) signals.push('template-builder');
  const textLen = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').length;
  if (textLen < 1200) signals.push('thin-content');
  if (!/<form/.test(h) && !/tel:/.test(h)) signals.push('no-contact-path');
  if (!/<title>[^<]{5,}/.test(h)) signals.push('weak-title');
  if (!/(town|serving|service area|areas we serve)/.test(h)) signals.push('no-service-area-pages');
  return signals;
}

const WEIGHT = {
  none: 50, 'social-only': 45, 'builder-subdomain': 40, 'own-domain': 0,
  'page-empty-or-broken': 35, 'no-https': 10, 'not-mobile-friendly': 15, 'table-or-font-tags-layout': 15,
  'template-builder': 10, 'thin-content': 10, 'no-contact-path': 5, 'weak-title': 5, 'no-service-area-pages': 8,
};

export function score({ type, signals = [], rating = 0, reviews = 0, hasPhone = true }) {
  if (!hasPhone) return 0; // nothing we can pitch
  let s = WEIGHT[type] ?? 0;
  for (const g of signals) s += g.startsWith('stale-copyright') ? 15 : (WEIGHT[g] ?? 0);
  // established, reviewed businesses are better targets (they have money and something to protect)
  if (reviews >= 5) s += 5;
  if (reviews >= 25) s += 5;
  if (rating && rating < 3.5) s -= 10;
  return Math.max(0, Math.min(100, s));
}

export function tierLabel(s) { return s >= 60 ? 'A' : s >= 35 ? 'B' : 'C'; }
