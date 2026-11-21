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
  assert.match(m, /this is Zac/i); assert.match(m, /STOP/); assert.ok(m.includes('https://x.up.railway.app/s/joes-abc123'));
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
      if (body.system.includes('sample websites')) return J({ content: [{ type: 'text', text: '<!doctype html><html><body><h1>Joe</h1></body></html>' }] });
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
  let queue = [{ place_id: 'ChIJ1', name: "Joe's Roofing", phone: '(508) 555-0101', trade: 'roofing contractor', town: 'Mashpee, MA', tier: 'A', web_type: 'none', reviews: '12', rating: '4.8' }];
  const env = { ANTHROPIC_API_KEY: 'k', GHL_TOKEN: 't', GHL_LOCATION_ID: 'L', GHL_PIPELINE_ID: 'P', GHL_STAGE_NEW_LEAD: 'S0', GHL_STAGE_TEXTED: 'S1', GHL_STAGE_RESPOND_YES: 'S2', GHL_STAGE_NOT_INTERESTED: 'S3', PUBLIC_URL: 'https://x.up.railway.app', ...over };
  const ap = createAutopilot({ env, dir, fetchImpl: mockFetch(log), now: () => SAT_3PM_ET, log: () => {}, deps: { nextProspect: () => queue.shift() || null, readyCount: () => 0, markState: (id, v) => (marks[id] = v), jobRunning: () => false, startFind: () => false } });
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
  assert.ok(fs.readdirSync(path.join(dir, 'sites')).length === 1);
  await ap.tick(); assert.equal(log.filter((l) => l.url.endsWith('/conversations/messages')).length, 1, 'paced: no second send immediately');
});

test('draft mode never sends', async () => {
  const { ap, log } = setup(); ap.setSettings({ mode: 'draft' }); await ap.tick(); await ap.tick();
  assert.equal(log.filter((l) => l.url.endsWith('/conversations/messages')).length, 0); assert.equal(ap.view().drafts.length, 1);
});

test('budget and cap are hard stops', async () => {
  const a = setup(); a.ap.setSettings({ mode: 'auto', dailyBudget: 0.05 }); await a.ap.tick(); assert.equal(a.log.length, 0);
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
