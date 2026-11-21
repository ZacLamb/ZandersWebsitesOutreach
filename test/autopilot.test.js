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

test('first text asks permission: ASCII, short, no link, no opt-out line', () => {
  const m = templateMessage({ name: "Joe's Roofing", web_type: 'none', reviews: '12' }, 'https://x.up.railway.app/s/joes-abc123', 0);
  assert.match(m, /Zac here/i); assert.ok(m.length < 160); assert.ok(!/STOP|http/i.test(m)); assert.match(m, /\?$/);
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
      if (body.system.includes('ONE first cold text')) return J({ content: [{ type: 'text', text: JSON.stringify({ text: "Hey Mike, Zac here. Folks keep saying you leave every job spotless, but there's no site to show it off, so I built Joe's Roofing a free sample one. Want me to send it over?", why: 'clean-up praise, no website' }) }] });
      if (body.system.includes('Zander, a 7 year old')) return J({ content: [{ type: 'text', text: "Hi! I'm Zander and I'm 7. People say you clean up really good! I made Joe's Roofing a free website. It's $20 a month and no setup fee. Can I send it to you?" }] });
      if (/Their reply: sure/.test(body.messages[0].content)) return J({ content: [{ type: 'text', text: '{"intent":"interested","reply":""}' }] });
      return J({ content: [{ type: 'text', text: '{"intent":"price","reply":"Good question, let me grab the details and text you right back."}' }] });
    }
    if (url.includes('places.googleapis.com/v1/places/')) return J({ rating: 4.9, userRatingCount: 31, photos: [{}, {}], reviews: [{ rating: 5, relativePublishTimeDescription: 'a month ago', text: { text: 'Mike and his crew left the yard spotless after our roof in Mashpee.' } }, { rating: 5, text: { text: 'Mike was on time and fair.' } }] });
    if (url.startsWith('https://oldsite.example')) return { ok: true, status: 200, url, text: async () => '<html><head><title>Joes</title></head><body>Copyright 2014 Joe</body></html>' };
    if (url.includes('/contacts/search/duplicate')) return J({ message: 'none' }, 404);
    if (url.includes('/contacts/upsert')) return J({ contact: { id: 'c1' } });
    if (url.endsWith('/opportunities/')) return J({ opportunity: { id: 'o1' } });
    return J({ ok: true });
  };
}

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-')); const log = []; const marks = {};
  let queue = [{ place_id: 'ChIJ1', name: "Joe's Roofing", phone: '(508) 555-0101', trade: 'pest control', town: 'Mashpee, MA', tier: 'A', web_type: 'none', reviews: '12', rating: '4.8' }];
  const env = { ANTHROPIC_API_KEY: 'k', GOOGLE_PLACES_KEY: 'g', GHL_TOKEN: 't', GHL_LOCATION_ID: 'L', GHL_PIPELINE_ID: 'P', GHL_STAGE_NEW_LEAD: 'S0', GHL_STAGE_TEXTED: 'S1', GHL_STAGE_RESPOND_YES: 'S2', GHL_STAGE_NOT_INTERESTED: 'S3', GHL_FROM_NUMBER_RGS: '+15085550001', GHL_FROM_NUMBER_ZW: '+15085550002', PUBLIC_URL: 'https://x.up.railway.app', ...over };
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
  assert.equal(sms.length, 1); assert.equal(sms[0].body.contactId, 'c1'); assert.ok(!/http/.test(sms[0].body.message)); assert.match(sms[0].body.message, /send it/);
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

test('price question as first reply: sends the link, flags Zac, queues the bot answer after it', async () => {
  const { ap } = setup(); ap.setSettings({ mode: 'auto' }); await ap.tick(); await ap.tick();
  await ap.handleInbound({ contactId: 'c1', text: 'how much is it?' });
  const v = ap.view(); assert.equal(v.needsYou.length, 1);
  const pend = ap._state().pending; assert.equal(pend.length, 2); assert.match(pend[0].text, /\/s\//); assert.ok(pend[1].at > pend[0].at);
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
  const env = { ANTHROPIC_API_KEY: 'k', GOOGLE_PLACES_KEY: 'g', GHL_TOKEN: 't', GHL_LOCATION_ID: 'L', GHL_PIPELINE_ID: 'P', GHL_STAGE_NEW_LEAD: 'S0', GHL_FROM_NUMBER_RGS: '+1RGS', GHL_FROM_NUMBER_ZW: '+1ZW', PUBLIC_URL: 'https://x.app' };
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

test('phone test: texts Zac from the brand number, bot replies even when Off, End test cleans up', async () => {
  const { ap, log } = setup({ ALERT_CONTACT_ID: 'zac1' });
  const r = await ap.testSend('rgs');
  const sms = log.filter((l) => l.url.endsWith('/conversations/messages'));
  assert.equal(sms.length, 1); assert.equal(sms[0].body.contactId, 'zac1'); assert.equal(sms[0].body.fromNumber, '+15085550001'); assert.ok(r.url.includes('/s/'));
  assert.ok(log.some((l) => l.url.includes('/contacts/zac1/tags') && l.method === 'POST'));
  await ap.handleInbound({ contactId: 'zac1', text: 'how much?' });
  ap._state().pending.forEach((p) => (p.at = 0));
  await ap.tick(); // mode is off, but test replies still go out
  const after = log.filter((l) => l.url.endsWith('/conversations/messages'));
  assert.ok(after.length >= 2);
  await ap.endTest();
  assert.equal(ap.view().testActive, false); assert.ok(log.some((l) => l.url.includes('/contacts/zac1/tags') && l.method === 'DELETE'));
  assert.deepEqual(await ap.handleInbound({ contactId: 'zac1', text: 'hi' }), { ignored: true });
});

test('ask-first: a yes gets the sample link from the same number, no hot alert; price question after that pings Zac', async () => {
  const { ap, log } = setup({ ALERT_CONTACT_ID: 'zac1' }); ap.setSettings({ mode: 'auto' }); await ap.tick(); await ap.tick();
  const r = await ap.handleInbound({ contactId: 'c1', text: 'sure send it' });
  assert.equal(r.link, true); assert.equal(ap.view().needsYou.length, 0);
  ap._state().pending.forEach((p) => (p.at = 0)); await ap.tick();
  const msgs = log.filter((l) => l.url.endsWith('/conversations/messages'));
  const link = msgs.at(-1); assert.match(link.body.message, /\/s\/joes-roofing-/); assert.equal(link.body.fromNumber, '+15085550001');
  await ap.handleInbound({ contactId: 'c1', text: 'nice, how much?' });
  assert.equal(ap.view().needsYou.length, 1);
});

test('personalized first text: researches reviews + their site, writes with the writer model, shows why', async () => {
  const { ap, log } = setup(); ap._deps.queue[0].website = 'https://oldsite.example'; ap._deps.queue[0].web_type = 'site';
  ap.setSettings({ mode: 'draft' }); await ap.tick();
  assert.ok(log.some((l) => l.url.includes('places.googleapis.com/v1/places/ChIJ1')));
  assert.ok(log.some((l) => l.url === 'https://oldsite.example'));
  const w = log.find((l) => l.url.includes('anthropic') && l.body.system.includes('ONE first cold text'));
  assert.equal(w.body.model, 'claude-opus-5-5');
  const u = w.body.messages[0].content;
  assert.match(u, /spotless/); assert.match(u, /NO mobile layout/); assert.match(u, /copyright 2014/);
  const d = ap.view().drafts[0]; assert.match(d.msg, /spotless/); assert.ok(!/http/.test(d.msg)); assert.match(d.msg, /\?$/); assert.equal(d.why, 'clean-up praise, no website');
});

test('a bad model text (has a link) falls back to the safe template', async () => {
  const { ap } = setup(); const L = { name: "Joe's Roofing" };
  assert.match(templateMessage(L, '', 0), /want me to send it over\?$/);
});

test('two pipelines: RGS card moves to Zander pipeline on a no, then Texted / Opted Out there', async () => {
  let clock = SAT_3PM_ET.getTime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap3-')); const log = [];
  const base = mockFetch(log);
  let triage = 'not_interested';
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('anthropic') && /Their reply:/.test(JSON.parse(init.body).messages[0].content)) { log.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ intent: triage, reply: '' }) }] }) }; }
    return base(url, init);
  };
  const queue = [{ place_id: 'ChIJ7', name: 'Cape Decks', phone: '(508) 555-0199', trade: 'pest control', town: 'Bourne, MA', tier: 'A', web_type: 'none' }];
  const env = { ANTHROPIC_API_KEY: 'k', GHL_TOKEN: 't', GHL_LOCATION_ID: 'L', GHL_PIPELINE_ID: 'RGSP', GHL_STAGE_NEW_LEAD: 'R0', GHL_STAGE_TEXTED: 'R1', GHL_STAGE_RESPOND: 'R2', GHL_STAGE_RESPOND_YES: 'R3', GHL_STAGE_OPTED_OUT: 'R6',
    GHL_ZW_PIPELINE_ID: 'ZWP', GHL_ZW_STAGE_QUEUED: 'Z0', GHL_ZW_STAGE_TEXTED: 'Z1', GHL_ZW_STAGE_RESPOND: 'Z2', GHL_ZW_STAGE_RESPOND_YES: 'Z3', GHL_ZW_STAGE_NOT_INTERESTED: 'Z5', GHL_ZW_STAGE_NO_RESPONSE: 'Z6', GHL_ZW_STAGE_OPTED_OUT: 'Z7',
    GHL_FROM_NUMBER_RGS: '+1RGS', GHL_FROM_NUMBER_ZW: '+1ZW', PUBLIC_URL: 'https://x.app' };
  const ap = createAutopilot({ env, dir, fetchImpl, now: () => new Date(clock), log: () => {}, deps: { nextProspect: () => queue.shift() || null, readyCount: () => 0, markState() {}, jobRunning: () => false, startFind: () => false } });
  ap.setSettings({ mode: 'auto' }); await ap.tick(); await ap.tick();
  const puts = () => log.filter((l) => l.method === 'PUT').map((l) => `${l.body.pipelineId}:${l.body.pipelineStageId}`);
  assert.deepEqual(puts(), ['RGSP:R1']);
  await ap.handleInbound({ contactId: 'c1', text: 'no thanks' }); // a straight no to the ask
  assert.equal(puts().at(-1), 'ZWP:Z0');
  clock += 7 * 864e5 + 3600e3; while (new Date(clock).getUTCDay() === 0) clock += 864e5;
  ap._state().nextSendAt = 0; ap._state().pending = []; await ap.tick();
  assert.equal(puts().at(-1), 'ZWP:Z1');
  await ap.handleInbound({ contactId: 'c1', text: 'STOP' });
  assert.equal(puts().at(-1), 'ZWP:Z7');
});

test('only real opt-outs stop everything; a rude no still goes to Zander', () => {
  for (const t of ['STOP', 'stop.', 'Unsubscribe', 'stop texting me', "don't text me", 'remove me from your list']) assert.ok(isOptOut(t), t);
  for (const t of ['leave me alone', 'not interested', 'no thanks', 'we are all set', 'stop by tomorrow, ill look', 'f off']) assert.ok(!isOptOut(t), t);
});

test('dashboard: reply from RGS number stops the bot, stage move syncs, Stripe link + payment marks Won, metrics count it', async () => {
  let clock = SAT_3PM_ET.getTime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap4-')); const log = [];
  const base = mockFetch(log); let paid = false;
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('https://api.stripe.com')) {
      log.push({ url, method: init.method, body: init.body || '' });
      if (url.includes('/prices?')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.endsWith('/products')) return { ok: true, json: async () => ({ id: 'prod_1' }) };
      if (url.endsWith('/prices')) return { ok: true, json: async () => ({ id: 'price_' + log.length }) };
      if (url.endsWith('/payment_links')) return { ok: true, json: async () => ({ id: 'plink_1', url: 'https://buy.stripe.com/test_1' }) };
      if (url.includes('/checkout/sessions?')) return { ok: true, json: async () => ({ data: paid ? [{ id: 'cs_1', amount_total: 59600, customer_details: { email: 'joe@x.com' } }] : [] }) };
    }
    return base(url, init);
  };
  const queue = [{ place_id: 'ChIJ5', name: 'Joe Roofing', phone: '(508) 555-0111', trade: 'roofing contractor', town: 'Plymouth, MA', tier: 'A', web_type: 'none' }];
  const env = { ANTHROPIC_API_KEY: 'k', GHL_TOKEN: 't', GHL_LOCATION_ID: 'L', GHL_PIPELINE_ID: 'RGSP', GHL_STAGE_NEW_LEAD: 'R0', GHL_STAGE_TEXTED: 'R1', GHL_STAGE_RESPOND: 'R2', GHL_STAGE_RESPOND_YES: 'R3', GHL_STAGE_WON: 'R4',
    GHL_FROM_NUMBER_RGS: '+1RGS', GHL_FROM_NUMBER_ZW: '+1ZW', PUBLIC_URL: 'https://x.app', STRIPE_KEY_RGS: 'rk_test_rgs', ALERT_CONTACT_ID: 'zac' };
  const ap = createAutopilot({ env, dir, fetchImpl, now: () => new Date(clock), log: () => {}, deps: { nextProspect: () => queue.shift() || null, readyCount: () => 0, markState() {}, jobRunning: () => false, startFind: () => false } });
  ap.setSettings({ mode: 'auto' }); await ap.tick(); await ap.tick();
  await ap.handleInbound({ contactId: 'c1', text: 'how much?' }); // price on first reply: link + flagged
  let v = ap.leadsView()[0]; assert.equal(v.unread, true); assert.equal(v.needsYou, true);
  await ap.reply('ChIJ5', 'Hey Joe, it is $497 to build then $99 a month. Want the link?');
  const sms = log.filter((l) => l.url.endsWith('/conversations/messages'));
  assert.equal(sms.at(-1).body.fromNumber, '+1RGS'); assert.equal(ap._state().leads.ChIJ5.manual, true);
  ap._state().pending = [];
  await ap.handleInbound({ contactId: 'c1', text: 'is it a contract?' });
  assert.equal(ap._state().pending.length, 0, 'bot stays quiet once Zac has replied');
  await ap.setStage('ChIJ5', 'RESPOND_YES');
  assert.equal(log.filter((l) => l.method === 'PUT').at(-1).body.pipelineStageId, 'R3');
  const r = await ap.payLink('ChIJ5', 'monthly'); assert.equal(r.url, 'https://buy.stripe.com/test_1');
  const pl = log.find((l) => l.url.endsWith('/payment_links')); assert.match(decodeURIComponent(pl.body), /metadata\[lead_id\]=ChIJ5/);
  clock += 6 * 60e3; await ap.pollPayments(); assert.equal(ap._state().leads.ChIJ5.paid, undefined);
  paid = true; clock += 6 * 60e3; await ap.pollPayments();
  const L = ap._state().leads.ChIJ5; assert.equal(L.status, 'won'); assert.equal(L.paid.amount, 596);
  assert.equal(log.filter((l) => l.method === 'PUT').at(-1).body.pipelineStageId, 'R4');
  assert.ok(log.some((l) => l.url.endsWith('/conversations/messages') && l.body.contactId === 'zac' && /PAID/.test(l.body.message)));
  const m = ap.metrics(); assert.equal(m.rgs.won, 1); assert.equal(m.rgs.collected, 596); assert.equal(m.rgs.mrr, 99); assert.equal(m.rgs.replied, 1);
  assert.equal(m.byAngle[0].key, 'No website');
  await assert.rejects(() => ap.payLink('ChIJ5', 'monthly_seo_x'), /Unknown plan/);
});

test('ready to buy: bot sends the right payment link itself, flags Zac, never twice; not once Zac has taken over', async () => {
  const clock = SAT_3PM_ET.getTime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap5-')); const log = [];
  const base = mockFetch(log);
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('anthropic')) { const b = JSON.parse(init.body); const m = b.messages[0].content.match(/Their reply: (.*)$/);
      if (m) { const t = m[1]; const intent = /year up front/.test(t) ? 'ready_to_buy' : /^yes/.test(t) ? 'interested' : 'question';
        return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ intent, plan: /year/.test(t) ? 'annual' : 'monthly', reply: intent === 'ready_to_buy' ? '' : 'Sure thing!' }) }] }) }; } }
    if (url.startsWith('https://api.stripe.com')) {
      log.push({ url, method: init.method, body: init.body || '' });
      if (url.includes('/prices?')) return { ok: true, json: async () => ({ data: [{ id: 'price_x' }] }) };
      if (url.endsWith('/payment_links')) return { ok: true, json: async () => ({ id: 'plink_9', url: 'https://buy.stripe.com/annual_9' }) };
    }
    return base(url, init);
  };
  const queue = [{ place_id: 'ChIJ8', name: 'Cape Tile', phone: '(508) 555-0122', trade: 'tile', town: 'Dennis, MA', tier: 'A', web_type: 'none' }];
  const env = { ANTHROPIC_API_KEY: 'k', GHL_TOKEN: 't', GHL_LOCATION_ID: 'L', GHL_PIPELINE_ID: 'RGSP', GHL_STAGE_NEW_LEAD: 'R0', GHL_STAGE_TEXTED: 'R1', GHL_STAGE_RESPOND: 'R2', GHL_STAGE_RESPOND_YES: 'R3',
    GHL_FROM_NUMBER_RGS: '+1RGS', PUBLIC_URL: 'https://x.app', STRIPE_KEY_RGS: 'rk_live_x', ALERT_CONTACT_ID: 'zac' };
  const ap = createAutopilot({ env, dir, fetchImpl, now: () => new Date(clock), log: () => {}, deps: { nextProspect: () => queue.shift() || null, readyCount: () => 0, markState() {}, jobRunning: () => false, startFind: () => false } });
  ap.setSettings({ mode: 'auto' }); await ap.tick(); await ap.tick();
  await ap.handleInbound({ contactId: 'c1', text: 'yes send it' }); // sample link goes out first
  ap._state().pending = [];
  const r = await ap.handleInbound({ contactId: 'c1', text: "love it, I'll do the year up front" });
  assert.equal(r.intent, 'ready_to_buy');
  const pend = ap._state().pending; assert.equal(pend.length, 1); assert.match(pend[0].text, /buy\.stripe\.com\/annual_9/);
  assert.ok(decodeURIComponent(log.find((l) => l.url.endsWith('/payment_links')).body).includes('metadata[plan]=annual'));
  assert.ok(log.some((l) => l.body?.contactId === 'zac' && /payment link/.test(l.body.message)));
  assert.equal(log.filter((l) => l.method === 'PUT').at(-1).body.pipelineStageId, 'R3');
  await ap.handleInbound({ contactId: 'c1', text: "year up front please" });
  assert.equal(log.filter((l) => l.url.endsWith('/payment_links')).length, 1, 'no duplicate link');
});
