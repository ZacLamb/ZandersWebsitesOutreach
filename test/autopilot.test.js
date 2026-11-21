import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canSendNow, canReplyNow, isOptOut, templateMessage, segments, createAutopilot } from '../src/autopilot.js';
import { sanitize, withBanner } from '../src/sites.js';

const SAT_3PM_ET = new Date('2026-11-21T20:00:00Z');

test('send window: Mon-Sat 9-18:30 ET, no Sundays or holidays', () => {
  assert.equal(canSendNow(SAT_3PM_ET), true);
  assert.equal(canSendNow(new Date('2026-11-22T20:00:00Z')), false); // Sunday
  assert.equal(canSendNow(new Date('2026-11-21T23:30:00Z')), false); // 6:30pm
  assert.equal(canSendNow(new Date('2026-11-21T13:00:00Z')), false); // 8am
  assert.equal(canSendNow(new Date('2026-11-26T17:00:00Z')), false); // Thanksgiving
  assert.equal(canReplyNow(new Date('2026-11-22T20:00:00Z')), true);
});

test('opt-out detection', () => {
  for (const t of ['STOP', 'stop', 'Unsubscribe', 'please stop texting me', 'remove me', "don't text me", 'take me off your list']) assert.equal(isOptOut(t), true, t);
  for (const t of ['how much?', 'who is this', 'stop by tomorrow?', 'sounds good']) assert.equal(isOptOut(t), false, t);
});

test('template message is ASCII, has link + STOP, one segment-ish', () => {
  const m = templateMessage({ name: "Joe's Roofing", web_type: 'none', reviews: '12' }, 'https://x.up.railway.app/s/joes-abc123', 0);
  assert.match(m, /Zac here/i); assert.ok(m.length < 160); assert.match(m, /STOP/); assert.ok(m.includes('https://x.up.railway.app/s/joes-abc123'));
  assert.ok(/^[\x20-\x7E]+$/.test(m)); assert.ok(segments(m) <= 3);
});

test('site sanitizer strips scripts, handlers, forms and adds banner', () => {
  const h = sanitize('<html><body onload="x()"><script>alert(1)</script><form action="//evil"><input></form><a href="javascript:x()">a</a></body></html>');
  assert.ok(!/script|onload|<form|javascript:/i.test(h));
  assert.match(withBanner(h, 'A & B'), /A &amp; B/);
});

function mockFetch(log) {
  const J = (o, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(o), json: async () => o });
  return async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    log.push({ url, method: init.method, body });
    if (url.includes('anthropic')) {
      if (body.system.includes('sample websites')) return J({ content: [{ type: 'text', text: '<!doctype html><html><body><h1>[[NAME]]</h1><p>[[TOWN]] [[PHONE]]</p><a href="tel:[[PHONE_DIGITS]]">Call</a></body></html>' }] });
      if (body.system.includes('ONE first text')) { const link = body.messages[0].content.match(/Link: (\S+)/)[1]; return J({ content: [{ type: 'text', text: `Morning! This is Zac. Built a free sample site for Joe's Roofing: ${link} Reply STOP to opt out.` }] }); }
      return J({ content: [{ type: 'text', text: '{"intent":"price","reply":"Good question, let me grab the details and text you right back."}' }] });
    }
    if (url.includes('/contacts/search/duplicate')) return J({ message: 'none' }, 404);
    if (url.includes('/contacts/upsert')) return J({ contact: { id: 'c1' } });
    if (url.endsWith('/opportunities/')) return J({ opportunity: { id: 'o1' } });
    return J({ ok: true });
  };
}

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-')); const log = []; const marks = {};
  let queue = [{ place_id: 'ChIJ1', name: "Joe's Roofing", phone: '(508) 555-0101', trade: 'pest control', town: 'Mashpee, MA', tier: 'A', web_type: 'none', reviews: '12', rating: '4.8' }];
  const env = { ANTHROPIC_API_KEY: 'k', GHL_TOKEN: 't', GHL_LOCATION_ID: 'L', GHL_PIPELINE_ID: 'P', GHL_STAGE_NEW_LEAD: 'S0', GHL_STAGE_TEXTED: 'S1', GHL_STAGE_RESPOND_YES: 'S2', GHL_STAGE_NOT_INTERESTED: 'S3', GHL_FROM_NUMBER_RGS: '+15085550001', GHL_FROM_NUMBER_ZW: '+15085550002', PUBLIC_URL: 'https://x.up.railway.app', ...over };
  const ap = createAutopilot({ env, dir, fetchImpl: mockFetch(log), now: () => SAT_3PM_ET, log: () => {}, deps: { nextProspect: () => queue.shift() || null, readyCount: () => 0, markState: (id, v) => (marks[id] = v), jobRunning: () => false, startFind: () => false } });
  ap._deps = { queue };
  return { ap, log, marks, dir };
}

test('off by default: tick does nothing', async () => {
  const { ap, log } = setup(); await ap.tick(); assert.equal(log.length, 0);
});

test('auto mode drafts, stages in GHL, texts once, moves stage, tracks spend', async () => {
  const { ap, log, marks, dir } = setup(); ap.setSettings({ mode: 'auto', dailyBudget: 5, dailyTextCap: 25 });
  await ap.tick(); await ap.tick();
  const sms = log.filter((l) => l.url.endsWith('/conversations/messages'));
  assert.equal(sms.length, 1); assert.equal(sms[0].body.contactId, 'c1'); assert.match(sms[0].body.message, /\/s\/joes-roofing-/);
  assert.ok(log.some((l) => l.method === 'PUT' && l.body.pipelineStageId === 'S1'));
  const v = ap.view(); assert.equal(v.today.texts, 1); assert.ok(v.today.spend > 0 && v.today.spend < 1); assert.equal(marks.ChIJ1, 'created');
  assert.equal(fs.readdirSync(path.join(dir, 'sites')).filter((f) => f.endsWith('.html')).length, 1);
  const page = fs.readFileSync(path.join(dir, 'sites', fs.readdirSync(path.join(dir, 'sites')).find((f) => f.endsWith('.html'))), 'utf8');
  assert.match(page, /Joe&#39;s Roofing/); assert.match(page, /\(508\) 555-0101/); assert.match(page, /tel:5085550101/); assert.ok(!page.includes('[['));
  await ap.tick(); assert.equal(log.filter((l) => l.url.endsWith('/conversations/messages')).length, 1, 'paced: no second send immediately');
});

test('draft mode never sends', async () => {
  const { ap, log } = setup(); ap.setSettings({ mode: 'draft' }); await ap.tick(); await ap.tick();
  assert.equal(log.filter((l) => l.url.endsWith('/conversations/messages')).length, 0); assert.equal(ap.view().drafts.length, 1);
});

test('budget and cap are hard stops', async () => {
  const a = setup(); a.ap.setSettings({ mode: 'auto', dailyBudget: 0.01 }); await a.ap.tick(); assert.equal(a.log.length, 0);
  const b = setup(); b.ap.setSettings({ mode: 'auto', dailyTextCap: 0 }); await b.ap.tick(); await b.ap.tick();
  assert.equal(b.log.filter((l) => l.url.endsWith('/conversations/messages')).length, 0);
});

test('STOP reply opts out, tags, never texts again, no AI call', async () => {
  const { ap, log } = setup(); ap.setSettings({ mode: 'auto' }); await ap.tick(); await ap.tick();
  const before = log.length; const r = await ap.handleInbound({ contactId: 'c1', text: 'STOP' });
  assert.equal(r.optout, true); assert.ok(!log.slice(before).some((l) => l.url.includes('anthropic')));
  assert.ok(log.slice(before).some((l) => l.url.includes('/tags') && l.body.tags.includes('zw-optout')));
  assert.equal(ap.view().counts.opted_out, 1);
});

test('price question: flags Zac, moves to Respond Yes, queues one holding reply only', async () => {
  const { ap, log } = setup(); ap.setSettings({ mode: 'auto' }); await ap.tick(); await ap.tick();
  await ap.handleInbound({ contactId: 'c1', text: 'how much is it?' });
  const v = ap.view(); assert.equal(v.needsYou.length, 1); assert.ok(log.some((l) => l.method === 'PUT' && l.body.pipelineStageId === 'S2'));
  assert.equal(ap._state().pending.length, 1); assert.ok(!/\$\d/.test(ap._state().pending[0].text));
});

test('unknown contacts (not ours) are ignored', async () => {
  const { ap } = setup(); assert.deepEqual(await ap.handleInbound({ contactId: 'nope', text: 'hi' }), { ignored: true });
});

test('one template per trade: a second lead of the same trade makes no new site call', async () => {
  const { ap, log } = setup(); ap.setSettings({ mode: 'draft' });
  const second = { place_id: 'ChIJ2', name: 'Cape Roof Co', phone: '(508) 555-0199', trade: 'pest control', town: 'Falmouth, MA', tier: 'A', web_type: 'none' };
  await ap.tick(); const before = log.filter((l) => l.body?.system?.includes('sample websites')).length;
  ap._deps.queue.push(second); await ap.tick();
  assert.equal(before, 1); assert.equal(log.filter((l) => l.body?.system?.includes('sample websites')).length, 1); assert.equal(ap.view().drafts.length, 2);
});

test('two brands, two numbers: RGS first, Zander a week after a no, never after STOP', async () => {
  let clock = SAT_3PM_ET.getTime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap2-')); const log = [];
  const fetchImpl = mockFetch(log);
  const queue = [{ place_id: 'ChIJ9', name: 'Bay Plumbing', phone: '(508) 555-0177', trade: 'pest control', town: 'Bourne, MA', tier: 'A', web_type: 'none' }];
  const env = { ANTHROPIC_API_KEY: 'k', GHL_TOKEN: 't', GHL_LOCATION_ID: 'L', GHL_PIPELINE_ID: 'P', GHL_STAGE_NEW_LEAD: 'S0', GHL_FROM_NUMBER_RGS: '+1RGS', GHL_FROM_NUMBER_ZW: '+1ZW', PUBLIC_URL: 'https://x.app' };
  const ap = createAutopilot({ env, dir, fetchImpl, now: () => new Date(clock), deps: { nextProspect: () => queue.shift() || null, readyCount: () => 0, markState() {}, jobRunning: () => false, startFind: () => false } });
  ap.setSettings({ mode: 'auto' }); await ap.tick(); await ap.tick();
  const sms = () => log.filter((l) => l.url.endsWith('/conversations/messages'));
  assert.equal(sms()[0].body.fromNumber, '+1RGS');
  // mock triage returns "price" by default; force a not_interested reply
  const realFetch = fetchImpl;
  await ap.handleInbound({ contactId: 'c1', text: 'not interested' });
  const L = ap._state().leads.ChIJ9;
  L.lastIntent = 'not_interested'; L.zwDueAt = clock + 7 * 864e5; L.needsYou = false; L.status = 'closed';
  clock += 7 * 864e5 + 3600e3; while (new Date(clock).getUTCDay() === 0) clock += 864e5; // skip Sunday
  ap._state().nextSendAt = 0; ap._state().pending = [];
  await ap.tick();
  const z = sms().at(-1); assert.equal(z.body.fromNumber, '+1ZW'); assert.match(z.body.message, /Zander/); assert.ok(!/Revenue Generating/.test(z.body.message));
  const zsite = fs.readdirSync(path.join(dir, 'sites')).filter((f) => f.endsWith('.html')).map((f) => fs.readFileSync(path.join(dir, 'sites', f), 'utf8'));
  assert.ok(zsite.some((h) => h.includes("Zander's Websites"))); assert.ok(zsite.some((h) => h.includes('Revenue Generating Solutions')));
  // STOP on the Zander thread opts out for good
  await ap.handleInbound({ contactId: 'c1', text: 'STOP' }); assert.equal(ap._state().leads.ChIJ9.status, 'opted_out');
});

test('STOP to RGS means no Zander text ever', async () => {
  const { ap } = setup(); ap.setSettings({ mode: 'auto' }); await ap.tick(); await ap.tick();
  await ap.handleInbound({ contactId: 'c1', text: 'STOP' });
  const L = ap._state().leads.ChIJ1; assert.ok(!L.zwDueAt);
});

test('templates: picks by trade, skips the original client\'s towns, fills tokens', async () => {
  const { pickTemplate, renderTemplatePage } = await import('../src/sites.js');
  assert.equal(pickTemplate('electrician', 'Falmouth, MA')?.id, 'electrician-a');
  assert.equal(pickTemplate('electrician', 'Marion, MA'), null);
  assert.equal(pickTemplate('pest control', 'Falmouth, MA'), null);
  const html = renderTemplatePage({ tpl: 'electrician-a', name: 'Bay & Co', phone: '5085550100', town: 'Falmouth, MA', brand: 'rgs' }, '/', 'bay-co-abc123');
  assert.match(html, /Bay &amp; Co/); assert.match(html, /\(508\) 555-0100/); assert.ok(!html.includes('[['));
  assert.ok(!/Matt Farrell|Marion|916-1980/i.test(html));
});

test('every built template renders clean for a sample prospect', async () => {
  const { loadTemplates, renderTemplatePage, pickTemplate } = await import('../src/sites.js');
  const ids = loadTemplates().map((t) => t.id).sort();
  assert.deepEqual(ids, ['contractor-a', 'electrician-a', 'landscaper-a', 'plumber-a', 'roofer-a']);
  for (const t of loadTemplates()) for (const p of t.pages) {
    const html = renderTemplatePage({ tpl: t.id, name: 'Acme Co', phone: '8605550100', town: 'Hartford, CT', brand: 'rgs' }, p, 'acme-co-abc123');
    assert.ok(html, `${t.id} ${p}`); assert.ok(!html.includes('[['), `${t.id} ${p} has unfilled token`);
  }
  assert.equal(pickTemplate('general contractor', 'Hartford, CT'), null, 'MA-only template not used in CT');
  assert.equal(pickTemplate('general contractor', 'Worcester, MA')?.id, 'contractor-a');
  assert.equal(pickTemplate('landscaper', 'Falmouth, MA'), null, 'never in the original client\'s towns');
});
