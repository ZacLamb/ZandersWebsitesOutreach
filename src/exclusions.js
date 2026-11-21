// Builds the "never pitch" index from the master client CSV and matches prospects against it.
import fs from 'node:fs';

const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com',
  'live.com', 'msn.com', 'me.com', 'comcast.net', 'verizon.net', 'protonmail.com',
]);
const NAME_NOISE = new Set([
  'llc', 'inc', 'co', 'corp', 'company', 'the', 'and', 'of', 'ltd', 'group', 'services',
  'service', 'enterprises', 'contracting', 'construction',
]);

// Minimal RFC4180-ish CSV parser (handles quoted commas/newlines).
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Strip invisible directional marks etc., return every 10-digit US number found in a cell.
export function phonesIn(s) {
  if (!s) return [];
  const cleaned = s.replace(/[‎‏‪-‮⁦-⁩]/g, '');
  const out = new Set();
  // split on separators that join two numbers ("a / b", "a b")
  for (const part of cleaned.split(/[\/;,]|\s{2,}|\s(?=1?\d{10}\b)/)) {
    const d = part.replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1')) out.add(d.slice(1));
    else if (d.length === 10) out.add(d);
    else if (d.length > 11) {
      // two numbers run together
      for (const m of d.matchAll(/1?(\d{10})/g)) out.add(m[1]);
    }
  }
  return [...out];
}

export function normPhone(s) {
  return phonesIn(s)[0] || null;
}

export function normName(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter((t) => t && !NAME_NOISE.has(t)).join(' ');
}

// Whitespace/punctuation-insensitive form, keeps descriptive words ("construction") but drops legal suffixes.
// Catches "KS ConstructionMA" vs "KS Construction MA".
export function compactName(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/&/g, 'and').replace(/\b(llc|inc|corp|ltd|co|the)\b/g, ' ').replace(/[^a-z0-9]/g, '');
}

export function domainOf(urlOrEmail) {
  if (!urlOrEmail) return null;
  let s = urlOrEmail.trim().toLowerCase();
  if (s.includes('@')) s = s.split('@').pop();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[\/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

function tokens(n) { return new Set(n.split(' ').filter(Boolean)); }
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function buildIndex(csvText) {
  const rows = parseCsv(csvText);
  const header = rows.find((r) => r.includes('Business Name')) || [];
  const col = (n) => header.indexOf(n);
  const iName = col('Business Name'), iContact = col('Name'), iPhone = col('Phone'), iEmail = col('Email');
  const idx = { phones: new Set(), emailDomains: new Set(), emails: new Set(), names: new Set(), compact: new Set(), contacts: [], rows: 0 };
  for (const r of rows) {
    if (r === header) continue;
    const biz = (r[iName] || '').trim();
    if (!biz) continue;
    idx.rows++;
    idx.names.add(normName(biz));
    idx.compact.add(compactName(biz));
    for (const p of phonesIn(r[iPhone])) idx.phones.add(p);
    const email = (r[iEmail] || '').trim().toLowerCase();
    if (email.includes('@')) {
      idx.emails.add(email);
      const d = domainOf(email);
      if (d && !GENERIC_EMAIL_DOMAINS.has(d)) idx.emailDomains.add(d);
    }
    idx.contacts.push({ business: biz, person: (r[iContact] || '').trim() });
  }
  idx.names.delete('');
  idx.compact.delete('');
  return idx;
}

// Returns {excluded:boolean, reason?:string}
export function check(idx, { name, phone, website, email }) {
  for (const p of phonesIn(phone || '')) if (idx.phones.has(p)) return { excluded: true, reason: `phone ${p}` };
  const wd = domainOf(website);
  if (wd && idx.emailDomains.has(wd)) return { excluded: true, reason: `domain ${wd}` };
  const ed = domainOf(email);
  if (email && idx.emails.has(email.toLowerCase())) return { excluded: true, reason: `email ${email}` };
  if (ed && idx.emailDomains.has(ed)) return { excluded: true, reason: `domain ${ed}` };
  const cn = compactName(name);
  if (cn.length >= 6 && idx.compact.has(cn)) return { excluded: true, reason: 'same business name' };
  const n = normName(name);
  if (n) {
    if (idx.names.has(n)) return { excluded: true, reason: 'same business name' };
    for (const known of idx.names) {
      if (known.length >= 6 && n.length >= 6 && jaccard(n, known) >= 0.75) {
        return { excluded: true, reason: `similar name "${known}"` };
      }
    }
  }
  return { excluded: false };
}

export function loadIndex(path = 'data/clients.csv') {
  return buildIndex(fs.readFileSync(path, 'utf8'));
}
