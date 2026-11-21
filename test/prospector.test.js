import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex, check, phonesIn, normName, domainOf } from '../src/exclusions.js';
import { classifyUrl, analyzeHtml, score, tierLabel } from '../src/classify.js';

const csv = fs.existsSync('data/clients.csv') ? fs.readFileSync('data/clients.csv', 'utf8') : null;

test('phonesIn handles unicode marks, 11-digit, and multi-number cells', () => {
  assert.deepEqual(phonesIn('1‪7864770419‬'), ['7864770419']);
  assert.deepEqual(phonesIn('15088889432 15089588354').sort(), ['5088889432', '5089588354']);
  assert.deepEqual(phonesIn('15084686650'), ['5084686650']);
  assert.deepEqual(phonesIn('(561) 592-8290'), ['5615928290']);
  assert.deepEqual(phonesIn('whatsapp'), []);
});

test('normName strips noise; domainOf normalizes', () => {
  assert.equal(normName('Dumpster Dawgs, LLC'), 'dumpster dawgs');
  assert.equal(normName('The Evergreen Homes'), 'evergreen homes');
  assert.equal(domainOf('https://www.Example.com/about'), 'example.com');
  assert.equal(domainOf('Jeff@jeffreywilliamslandscaping.com'), 'jeffreywilliamslandscaping.com');
});

test('exclusion index from the real client sheet', { skip: !csv }, () => {
  const idx = buildIndex(csv);
  assert.ok(idx.rows > 100, `rows ${idx.rows}`);
  // phone match (Paver Pro Inc 15085776940), formatted differently
  assert.equal(check(idx, { name: 'Anything', phone: '(508) 577-6940' }).excluded, true);
  // business-domain match via client email domain
  assert.equal(check(idx, { name: 'x', phone: '5550001111', website: 'https://www.jeffreywilliamslandscaping.com/' }).excluded, true);
  // name match despite suffix/case
  assert.equal(check(idx, { name: 'KS Construction MA', phone: '5550001112' }).excluded, true);
  assert.equal(check(idx, { name: 'Sleek Renovations LLC', phone: '5550001113' }).excluded, true);
  // gmail clients must not exclude every gmail business
  assert.equal(check(idx, { name: 'Brand New Roofing Co', phone: '5550001114', website: 'https://gmail.com' }).excluded, false);
  // genuinely new business passes
  assert.equal(check(idx, { name: 'Cape Cod Premier Roofing', phone: '5085551234', website: 'https://capecodpremierroofing.com' }).excluded, false);
});

test('classifyUrl', () => {
  assert.equal(classifyUrl('').type, 'none');
  assert.equal(classifyUrl('https://www.facebook.com/somebiz').type, 'social-only');
  assert.equal(classifyUrl('https://somebiz.wixsite.com/home').type, 'builder-subdomain');
  assert.equal(classifyUrl('https://somebiz.com').type, 'own-domain');
});

test('analyzeHtml flags an old, non-mobile page and passes a modern one', () => {
  const old = '<html><head><title>Joe</title></head><body><font>Welcome</font> ' + 'x '.repeat(300) + ' &copy; 2014 Joes</body></html>';
  const sig = analyzeHtml(old, { now: new Date('2026-11-21') });
  assert.ok(sig.includes('not-mobile-friendly'));
  assert.ok(sig.includes('stale-copyright-2014'));
  assert.ok(sig.includes('table-or-font-tags-layout'));
  const modern = '<html><head><title>Best Roofing in Cape Cod</title><meta name="viewport" content="width=device-width"></head><body><form></form><p>Serving every town</p>' + 'lorem ipsum '.repeat(200) + '© 2026</body></html>';
  assert.deepEqual(analyzeHtml(modern, { now: new Date('2026-11-21') }), []);
});

test('score ordering: no site beats stale own site beats modern site; no phone = 0', () => {
  const none = score({ type: 'none', reviews: 30, rating: 4.8 });
  const stale = score({ type: 'own-domain', signals: ['not-mobile-friendly', 'stale-copyright-2015'], reviews: 30, rating: 4.8 });
  const modern = score({ type: 'own-domain', signals: [], reviews: 30, rating: 4.8 });
  assert.ok(none > stale && stale > modern);
  assert.equal(score({ type: 'none', hasPhone: false }), 0);
  assert.equal(tierLabel(none), 'A');
});
