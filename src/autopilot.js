// Autopilot: drafts a sample site + text per lead, sends within hard caps, follows up, triages replies,
// and hands anything important to Zac. Default mode is "off". Every action is logged in out/autopilot.json.
import fs from 'node:fs';
import path from 'node:path';
import { askClaude } from './claude.js';
import { research, brief } from './research.js';
import { generateSite } from './sites.js';
import { stageProspect, sendSms, moveOpportunity, addTags, removeTags } from './ghl.js';

// Estimated unit costs in USD (Zac's SMS rate; the rest are rough and only used for the budget guard).
export const COST = { sms: 0.008, site: 0.01, msg: 0.03, research: 0.03, triage: 0.005, search: 0.035 }; // site = per-trade template, filled per lead
export const DEFAULTS = {
  mode: 'off', dailyBudget: 5, dailyTextCap: 25, maxBotReplies: 2, zwDelayDays: 7,
  offer: 'Revenue Generating Solutions: website build $497 one time, then $99/mo for hosting, changes and Google Business Profile setup. No contract. If they want the $497 build fee waived: pay the year up front ($1,188 for 12 months at $99) and the build is free. Optional local SEO (town and service pages added monthly) is +$199/mo.',
  offerZw: "Zander's Websites: $20/mo, no setup fee, no contract. Zander is 7 and this is his first business; his dad helps him.",
};
const HOLIDAYS = new Set(['2026-11-26', '2026-12-25', '2027-01-01']);
const DAY = 864e5;

export function etParts(d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: (+p.hour % 24) + +p.minute / 60, dow: p.weekday };
}
// Recipients are in New England: first texts only Mon-Sat 9:00-18:30 Eastern, never on listed holidays.
export const canSendNow = (d) => { const t = etParts(d); return t.dow !== 'Sun' && !HOLIDAYS.has(t.date) && t.hour >= 9 && t.hour < 18.5; };
export const canReplyNow = (d) => { const t = etParts(d); return !HOLIDAYS.has(t.date) && t.hour >= 8 && t.hour < 21; };

const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out)\W*$|\b(remove me|do not text|don'?t text|dont text|stop (texting|messaging|contacting|calling)|take me off|opt out)\b/i;
export const isOptOut = (t) => OPT_OUT.test(String(t || ''));
const ascii = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\n]/g, '').replace(/ +/g, ' ').trim();
export const segments = (m) => Math.max(1, Math.ceil(m.length / (m.length <= 160 ? 160 : 153)));
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);

const hook = (p) => ({ none: "doesn't have a website on its Google listing", 'social-only': 'is only on Facebook with no website', 'builder-subdomain': 'has a website that looked a bit outdated' }[p.web_type] || 'had a website that looked a bit outdated');
// First texts ask permission (no link). The sample link goes out only after they say yes.
export function zanderMessage(p) {
  return ascii(`Hi! I'm Zander, I'm 7 and building websites is my first business (my dad helps). I made a free one for ${p.name}, can I send it to you? It's $20/mo, no setup fee.`);
}
export function templateMessage(p, url, step) {
  if (step === 1) return ascii(`Hey, just checking, want me to send over the free sample site I built for ${p.name}?`);
  if (step === 2) return ascii(`Last note from me, happy to send the free sample site for ${p.name} anytime. Have a good one!`);
  // Short wins: in Zac's history, texts under ~140 chars got ~35% replies vs ~9% over 300 chars (confounded, but consistent).
  return ascii(`Hey, Zac here. Built a free sample site for ${p.name}, want me to send it over?`);
}
export const linkMessage = (p, url, brand) => ascii(brand === 'zw'
  ? `Yay! Here it is: ${url} I made it for ${p.name}. Tell me what you think!`
  : `Here you go: ${url} Built it for ${p.name}. Let me know what you think, easy to tweak.`);
const SKIP_LINK = new Set(['not_interested', 'wrong_person', 'asks_if_bot']);

const VOICE = `Zac's style (from texts that got replies): casual, local, friendly, short. Examples:
"Morning Tony! Any reason your google profile doesnt have a website to show off the awesome work you do? Built one for you if you'd have any interest, no monthly contracts just a site that works and can be updated easily <link>"
"Hey boss! Saw your post, your website looked a bit outdated so I made you a new one. Let me know if you'd be interested in having an update and working with someone local <link>"
"Hi Stephanie, this is Zac. I saw Lucys Cleaning & Junk Removal covers everything from Middleboro out to Boston with 18 reviews at 100% recommend, so I went ahead and built you a sample site: <link> Worth a look?"`;

export function createAutopilot({ env = process.env, dir, fetchImpl = fetch, now = () => new Date(), deps, log = console.log }) {
  const file = path.join(dir, 'out', 'autopilot.json');
  let S = null, busy = false;
  const load = () => {
    if (S) return S;
    try { S = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { S = {}; }
    S.settings = { ...DEFAULTS, ...(S.settings || {}) }; S.days ||= {}; S.leads ||= {}; S.byContact ||= {}; S.optOut ||= []; S.events ||= []; S.pending ||= []; S.paused ||= null; S.nextSendAt ||= 0;
    return S;
  };
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(S)); fs.renameSync(file + '.tmp', file); };
  const ev = (type, text, id) => { load().events.unshift({ at: now().toISOString(), type, text, id }); S.events.length = Math.min(S.events.length, 200); };
  const day = () => { load(); const d = etParts(now()).date; return (S.days[d] ||= { texts: 0, spend: 0, replies: 0, optouts: 0, errors: 0, drafts: 0, searches: 0 }); };
  const effCap = () => { load(); const active = Object.values(S.days).filter((d) => d.texts > 0).length; return Math.min(S.settings.dailyTextCap, 20 + 10 * active); }; // warm-up ramp
  const room = (cost) => day().spend + cost <= S.settings.dailyBudget;
  const stage = (k) => env[`GHL_STAGE_${k}`];
  // Two pipelines: RGS Outreach (GHL_PIPELINE_ID / GHL_STAGE_*) and Zander's Websites Outreach (GHL_ZW_PIPELINE_ID / GHL_ZW_STAGE_*).
  // A lead lives in the pipeline of the brand that is talking to it; a no-go for RGS moves the same card into Zander's.
  const zwPipe = () => !!(env.GHL_ZW_PIPELINE_ID && env.GHL_ZW_STAGE_TEXTED);
  async function move(L, key, brand = L.brand === 'zw' ? 'zw' : 'rgs') {
    if (!L.oppId) return;
    const zw = brand === 'zw' && zwPipe();
    const id = zw ? env[`GHL_ZW_STAGE_${key}`] : stage(key);
    try { await moveOpportunity(env, L.oppId, id, fetchImpl, zw ? env.GHL_ZW_PIPELINE_ID : env.GHL_PIPELINE_ID); }
    catch (e) { ev('warn', `stage move failed (${key}): ${e.message}`, L.id); }
  }
  // RGS is a no-go: hand the card to Zander's pipeline, queued for the Zander text a week out.
  async function toZander(L) {
    L.zwDueAt = now().getTime() + S.settings.zwDelayDays * DAY;
    if (env.GHL_FROM_NUMBER_ZW && zwPipe()) { L.inZwQueue = true; await move(L, 'QUEUED', 'zw'); }
    else await move(L, L.replies.length ? 'NOT_INTERESTED' : 'NO_RESPONSE');
  }
  const pause = (why) => { load().paused = why; ev('paused', why); save(); };
  const ghlReady = () => !!(env.GHL_TOKEN && env.GHL_LOCATION_ID && env.GHL_PIPELINE_ID && env.GHL_STAGE_NEW_LEAD);
  const publicUrl = () => env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');

  const WRITER = () => env.ANTHROPIC_MODEL_WRITER || 'claude-opus-5-5';
  const okText = (m, max = 320) => m && !/https?:|www\.|\.com|\/s\//i.test(m) && /\?/.test(m) && m.length <= max;

  // Research the lead (Google reviews + their current site), then write a first text that could only be for them.
  async function writeMessage(p, url, facts) {
    if (!env.ANTHROPIC_API_KEY) return { text: templateMessage(p, url, 0), why: '' };
    try {
      const t = await askClaude(env, {
        model: WRITER(),
        system: `${VOICE}

You write ONE first cold text from Zac to the owner of a local trade business. The goal is a reply. It must read like Zac personally looked at THIS business, because he did: you have their Google reviews and a look at their current website.

How to personalize (pick the 1-2 strongest, true, specific things):
- Something customers keep praising in the reviews (a specific kind of job, a town, being on time, cleanup, fair price). Paraphrase, never quote a review word for word, never name or describe a reviewer.
- A concrete problem with their web presence: no website, only Facebook, site does not load, not secure, broken on phones, footer stuck on an old year, thin site that does not show their work.
- Their standing: lots of reviews or a high rating with no site to match it is a strong angle.
- Owner first name: ONLY if two or more reviews name the same first name and it is clearly the owner/the guy running it (or the business is named after him). Otherwise no name. Never guess.

Rules: 160-260 characters, plain ASCII, no emoji, NO link and no URL (the sample link is sent only after they say yes), say he built them a free sample site, end by ASKING if they want him to send it over. No price. No hype words (amazing, incredible, game changer). Never invent or exaggerate a fact that is not in the research. Sound like a local guy texting, not a marketer. Include "Zac". Do not mention Google reviews robotically ("I saw your 4.8 rating") unless it is the best angle; specifics beat numbers.

Return ONLY JSON: {"text": "...", "why": "the specific detail(s) you used, 10 words max"}`,
        user: brief(p, facts), maxTokens: 2500,
      }, fetchImpl);
      // Prefer the JSON shape; if the model answered with just the text, use that.
      let j = {}; const jm = t.match(/\{[\s\S]*\}/);
      if (jm) { try { j = JSON.parse(jm[0]); } catch { j = {}; } }
      if (!j.text) { const tm = t.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/); if (tm) j.text = JSON.parse(`"${tm[1]}"`); }
      const m = ascii(j.text || (/"text"\s*:/.test(t) ? '' : t.replace(/^```\w*|```$/g, '').replace(/^["']|["']$/g, '').trim()));
      if (okText(m)) return { text: m, why: ascii(j.why || '').slice(0, 120) };
      ev('warn', `personalized text for ${p.name} failed checks (${m.length} chars: "${m.slice(0, 60)}..."), using template`, p.place_id || p.id);
    } catch (e) { ev('warn', `message draft fell back to template: ${e.message}`); }
    return { text: templateMessage(p, url, 0), why: '' };
  }

  async function zanderWrite(L) {
    const base = zanderMessage(L);
    if (!env.ANTHROPIC_API_KEY || !L.facts) return base;
    try {
      const t = await askClaude(env, {
        model: WRITER(),
        system: `Write ONE text from Zander, a 7 year old whose first business is building websites (his dad Zac helps), to a local trade business. Kid voice: simple words, excited, honest, short sentences, a little cute but not babyish. Must include: he is 7, he made them a free website, it is $20 a month with no setup fee, and end by ASKING if he can send it to them. Add ONE true specific thing about this business from the research, phrased the way a kid would (e.g. "people say you always clean up really good"). Never quote a review word for word, never name a reviewer, invent nothing. 160-280 characters, plain ASCII, no emoji, NO link or URL. Never mention Revenue Generating Solutions or any earlier text. Return only the text.`,
        user: brief(L, L.facts), maxTokens: 2000,
      }, fetchImpl);
      const m = ascii(t);
      day().spend += COST.msg;
      return okText(m, 320) && /7|seven/i.test(m) && /\$?20/.test(m) ? m : base;
    } catch { return base; }
  }

  // Research + write for a lead object; stores facts so the Zander touch can reuse them.
  async function personalize(L) {
    if (!L.facts) { try { L.facts = await research(env, L, fetchImpl); } catch { L.facts = {}; } day().spend += COST.research; }
    const r = await writeMessage(L, L.url, L.facts);
    day().spend += COST.msg;
    L.msg = r.text; L.why = r.why; L.researched = true; L.writes = (L.writes || 0) + 1;
  }

  async function draftOne() {
    load();
    if (!env.ANTHROPIC_API_KEY || !publicUrl()) return false;
    // refresh drafts written before personalization so what you review is what goes out
    const stale = Object.values(S.leads).find((x) => x.status === 'drafted' && !x.test && (!x.researched || (!x.why && (x.writes || 0) < 4)));
    if (stale) {
      if (!room(COST.msg + COST.research)) return false;
      await personalize(stale); ev('draft', `Rewrote the text for ${stale.name} with research`, stale.id); save(); return true;
    }
    if (!room(COST.site + COST.msg + COST.research)) return false;
    const p = deps.nextProspect(new Set(Object.keys(S.leads)), new Set(S.optOut));
    if (!p) return false;
    const L = (S.leads[p.place_id] = { id: p.place_id, place_id: p.place_id, name: p.name, phone: digits(p.phone), trade: p.trade, town: p.town, tier: p.tier, website: p.website || '', web_type: p.web_type || '', rating: p.rating, reviews: p.reviews, status: 'drafting', step: 0, replies: [], botReplies: 0, created: now().toISOString() });
    try {
      const slug = await generateSite(env, p, dir, fetchImpl);
      L.slug = slug; L.url = `${publicUrl()}/s/${slug}`;
      await personalize(L); L.status = 'drafted';
      const d = day(); d.spend += COST.site; d.drafts++;
      ev('draft', `Drafted sample + text for ${p.name}`, p.place_id);
    } catch (e) { L.status = 'failed'; L.error = e.message; ev('error', `Draft failed for ${p.name}: ${e.message}`, p.place_id); }
    save(); return true;
  }

  async function sendOne() {
    load();
    const d = day();
    if (d.texts >= effCap()) return false;
    // close out leads that never answered both follow-ups, then follow-ups, then new drafts
    const t = now().getTime();
    const quiet = (x) => x.status === 'sent' && !x.replies.length;
    const zq = Object.values(S.leads).find((x) => x.status === 'zw_sent' && t - x.zwSentAt >= 7 * DAY && !x.replies.some((r) => !r.bot && Date.parse(r.at) > x.zwSentAt));
    if (zq) { zq.status = 'zw_no_response'; ev('info', `No response to Zander's text from ${zq.name}`, zq.id); await move(zq, 'NO_RESPONSE'); save(); return true; }
    const done = Object.values(S.leads).find((x) => quiet(x) && x.step === 3 && t - x.lastSentAt >= 4 * DAY);
    if (done) {
      done.status = 'no_response'; ev('info', `No response from ${done.name}; moved to Zander's Websites (text goes out in ${S.settings.zwDelayDays} days)`, done.id);
      await toZander(done); save(); return true;
    }
    const due = Object.values(S.leads).find((x) => quiet(x) && ((x.step === 1 && t - x.lastSentAt >= 3 * DAY) || (x.step === 2 && t - x.lastSentAt >= 4 * DAY)));
    let L = due, step = due ? due.step : 0;
    // Zander's Websites second touch: separate brand, separate number, after RGS got a no / no answer.
    if (!L && env.GHL_FROM_NUMBER_ZW) {
      const z = Object.values(S.leads).find((x) => x.zwDueAt && x.zwDueAt <= t && !x.zwSentAt && x.status !== 'opted_out' && x.contactId);
      if (z) {
        if (!room(2 * COST.sms + COST.msg)) return false;
        try {
          if (!z.zwUrl) { const slug = await generateSite(env, { name: z.name, phone: z.phone, trade: z.trade, town: z.town }, dir, fetchImpl, 'zw'); z.zwUrl = `${publicUrl()}/s/${slug}`; }
          const m2 = await zanderWrite(z);
          await sendSms(env, z.contactId, m2, fetchImpl, env.GHL_FROM_NUMBER_ZW);
          d.texts++; d.spend += segments(m2) * COST.sms; z.zwSentAt = t; z.brand = 'zw'; z.status = 'zw_sent'; z.botReplies = 0; z.msg = m2; z.linkSent = false; z.url = z.zwUrl;
          z.inZwQueue = false; await move(z, 'TEXTED');
          try { await addTags(env, z.contactId, ['zw-zander-pitch'], fetchImpl); } catch {}
          ev('send', `Zander's Websites text to ${z.name}`, z.id);
          S.nextSendAt = t + ((9.5 * 3600e3) / effCap()) * (0.7 + Math.random() * 0.6);
        } catch (e) { d.errors++; ev('error', `Zander send failed for ${z.name}: ${e.message}`, z.id); }
        save(); return true;
      }
    }
    if (!L) { L = Object.values(S.leads).find((x) => x.status === 'drafted'); step = 0; }
    if (!L) return false;
    // drafts made before personalization get researched + rewritten before they go out
    if (step === 0 && !L.researched) { if (!room(COST.msg + COST.research + 2 * COST.sms)) return false; await personalize(L); save(); }
    const msg = step === 0 ? L.msg : templateMessage({ name: L.name }, L.url, step);
    if (!room(segments(msg) * COST.sms)) return false;
    if (S.optOut.includes(L.phone)) { L.status = 'opted_out'; save(); return true; }
    try {
      if (step === 0) {
        const r = await stageProspect(env, { name: L.name, phone: L.phone, website: '', address: '', tier: L.tier, trade: L.trade }, { tags: ['zw-autopilot'], fetchImpl });
        if (r.status === 'duplicate') { L.status = 'duplicate'; ev('info', `${L.name} already exists in GHL; not texting`, L.id); deps.markState(L.id, 'duplicate'); save(); return true; }
        L.contactId = r.contactId; L.oppId = r.opportunityId; S.byContact[r.contactId] = L.id; deps.markState(L.id, 'created');
      }
      await sendSms(env, L.contactId, msg, fetchImpl, env.GHL_FROM_NUMBER_RGS || env.GHL_FROM_NUMBER);
      d.texts++; d.spend += segments(msg) * COST.sms; d.errors = 0;
      L.step = step + 1; L.lastSentAt = now().getTime(); L.status = 'sent';
      if (step === 0) await move(L, 'TEXTED');
      ev('send', `${step === 0 ? 'Texted' : 'Follow-up ' + step + ' to'} ${L.name}`, L.id);
      const gap = (9.5 * 3600e3) / effCap(); S.nextSendAt = t + gap * (0.7 + Math.random() * 0.6);
    } catch (e) {
      d.errors++; ev('error', `Send failed for ${L.name}: ${e.message}`, L.id);
      if (/landline|invalid|not a valid|cannot be sent/i.test(e.message)) { L.status = 'bad_number'; await move(L, 'BAD_NUMBER'); }
      if (d.errors >= 5) pause('5 send errors in a row. Check the number/A2P status in GHL, then resume.');
    }
    save(); return true;
  }

  async function classify(L, text) {
    if (!env.ANTHROPIC_API_KEY) return { intent: 'other', reply: '' };
    try {
      const out = await askClaude(env, {
        system: `You triage replies to a cold text. SENDER: ${L.brand === 'zw' ? "Zander's Websites (Zander, age 7, with his dad Zac helping)" : 'Zac from Revenue Generating Solutions'}, who offered a local trade business a free sample website. Return ONLY JSON: {"intent": one of "interested","price","question","objection","not_interested","wrong_person","asks_if_bot","other","reply": string}. "reply" is a short friendly plain-ASCII text from Zac (max 220 chars, no emoji) or "" if no reply should be sent. Rules: never state any price or timeline unless it appears in OFFER below; if price is asked and OFFER is empty, reply that you'll grab the details and text right back; never promise anything not in OFFER; if they ask whether this is a bot/automated/AI, intent "asks_if_bot" and reply ""; if not_interested/wrong_person, reply "" ; keep the sender's casual local voice; never mention the other brand.\nOFFER: ${(L.brand === 'zw' ? S.settings.offerZw : S.settings.offer) || '(none)'}`,
        user: `Business: ${L.name}\nOur text: ${L.msg}\n${L.linkSent ? 'We already sent them the sample link.' : 'We have not sent the link yet; a separate message with the link is sent automatically, so your reply must NOT include a link.'}\nTheir reply: ${text}`, maxTokens: 1000,
      }, fetchImpl);
      day().spend += COST.triage;
      const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
      return { intent: String(j.intent || 'other'), reply: ascii(j.reply || '').slice(0, 300) };
    } catch (e) { ev('warn', `triage failed: ${e.message}`, L.id); return { intent: 'other', reply: '' }; }
  }

  async function alertZac(text) {
    if (!env.ALERT_CONTACT_ID) return;
    try { await sendSms(env, env.ALERT_CONTACT_ID, ascii(text).slice(0, 300), fetchImpl); } catch (e) { ev('warn', `alert failed: ${e.message}`); }
  }

  // Called by the GHL webhook when a prospect replies.
  async function handleInbound({ contactId, text }) {
    load();
    const id = S.byContact[contactId]; const L = id && S.leads[id];
    if (!L) return { ignored: true };
    const body = String(text || '').slice(0, 1000);
    L.replies.push({ at: now().toISOString(), text: body }); day().replies++;
    if (isOptOut(body)) {
      L.status = 'opted_out'; if (!S.optOut.includes(L.phone)) S.optOut.push(L.phone); day().optouts++;
      ev('optout', `${L.name} opted out`, L.id);
      L.zwDueAt = null; L.inZwQueue = false;
      try { await addTags(env, contactId, ['zw-optout'], fetchImpl); } catch {}
      await move(L, 'OPTED_OUT');
      const d = day(); if (d.texts >= 10 && d.optouts / d.texts > 0.08) pause(`Opt-outs are ${Math.round((100 * d.optouts) / d.texts)}% of today's texts. Review the message before resuming.`);
      save(); return { optout: true };
    }
    const c = await classify(L, body); L.lastIntent = c.intent;
    if (!L.linkSent && !SKIP_LINK.has(c.intent)) {
      // They answered the ask-first text: send the sample link. Only a price question also pulls Zac in.
      L.linkSent = true; L.status = 'link_sent';
      S.pending.push({ id: L.id, at: now().getTime() + 30e3 + Math.random() * 60e3, text: linkMessage(L, L.url, L.brand) });
      L.zwDueAt = null; L.inZwQueue = false; await move(L, 'RESPOND');
      if (c.intent === 'price' || c.intent === 'objection') {
        L.needsYou = true; await alertZac(`ZW lead: ${L.name} replied "${body.slice(0, 120)}"`);
        if (c.reply) S.pending.push({ id: L.id, at: now().getTime() + 120e3 + Math.random() * 60e3, text: c.reply });
      }
      ev('reply', `${L.name}: "${body.slice(0, 80)}" -> sending the sample link`, L.id);
      save(); return { intent: c.intent, link: true };
    }
    const rgs = L.brand !== 'zw';
    if (rgs && c.intent === 'objection' && !L.zwSentAt) L.zwDueAt = now().getTime() + S.settings.zwDelayDays * DAY; // Zac gets a shot first; Zander follows if it goes nowhere
    if (['interested', 'price'].includes(c.intent)) { L.zwDueAt = null; L.inZwQueue = false; }
    const hot = ['interested', 'price', 'objection', 'asks_if_bot', 'other', 'question'].includes(c.intent);
    if (c.intent === 'not_interested') {
      L.status = 'closed';
      if (rgs && !L.zwSentAt) { await toZander(L); ev('info', `${L.name} said no to RGS; moved to Zander's Websites`, L.id); }
      else await move(L, 'NOT_INTERESTED');
    } else if (c.intent === 'wrong_person') {
      L.status = 'closed'; L.zwDueAt = null; L.inZwQueue = false; await move(L, rgs ? 'BAD_NUMBER' : 'NOT_INTERESTED');
    } else if (hot) {
      L.status = 'hot'; L.needsYou = true;
      await move(L, ['interested', 'price'].includes(c.intent) ? 'RESPOND_YES' : 'RESPOND');
      try { await addTags(env, contactId, ['zw-hot'], fetchImpl); } catch {}
      await alertZac(`ZW lead: ${L.name} replied "${body.slice(0, 120)}"`);
    }
    if (c.reply && L.botReplies < S.settings.maxBotReplies) { S.pending.push({ id: L.id, at: now().getTime() + 45e3 + Math.random() * 75e3, text: c.reply }); L.botReplies++; }
    ev('reply', `${L.name}: "${body.slice(0, 80)}" -> ${c.intent}${c.reply ? ' (auto-reply queued)' : ''}`, L.id);
    save(); return { intent: c.intent };
  }

  async function flushPending(testOnly = false) {
    load(); const t = now().getTime();
    for (const p of [...S.pending]) {
      if (testOnly && !S.leads[p.id]?.test) continue;
      if (p.at > t || (!S.leads[p.id]?.test && !canReplyNow(now()))) continue;
      S.pending = S.pending.filter((x) => x !== p);
      const L = S.leads[p.id]; if (!L || L.status === 'opted_out' || !room(segments(p.text) * COST.sms)) continue;
      try { await sendSms(env, L.contactId, p.text, fetchImpl, L.brand === 'zw' ? env.GHL_FROM_NUMBER_ZW : (env.GHL_FROM_NUMBER_RGS || env.GHL_FROM_NUMBER)); day().spend += segments(p.text) * COST.sms; L.replies.push({ at: now().toISOString(), text: p.text, bot: true }); ev('send', `Auto-replied to ${L.name}`, L.id); }
      catch (e) { ev('error', `Auto-reply failed for ${L.name}: ${e.message}`, L.id); }
      save();
    }
  }

  async function tick() {
    if (busy) return; busy = true;
    try {
      load();
      if (S.settings.mode === 'off' || S.paused) { if (S.pending.some((p) => S.leads[p.id]?.test)) await flushPending(true); return; }
      await flushPending();
      // supply: keep a small buffer of drafts, top up leads with a daily search batch
      const drafted = Object.values(S.leads).filter((L) => L.status === 'drafted').length;
      const cap = effCap(), d = day();
      const stale = Object.values(S.leads).some((L) => L.status === 'drafted' && !L.test && (!L.researched || (!L.why && (L.writes || 0) < 4)));
      if (stale || drafted < Math.min(5, cap - d.texts)) { if (await draftOne()) return; }
      if (deps.readyCount(new Set(Object.keys(S.leads)), new Set(S.optOut)) < 15 && d.searches < 60 && !deps.jobRunning() && room(60 * COST.search) && env.GOOGLE_PLACES_KEY) {
        if (deps.startFind(60)) { d.searches += 60; d.spend += 60 * COST.search; ev('search', 'Started a 60-search batch to find more leads'); save(); }
      }
      if (S.settings.mode === 'auto' && ghlReady() && canSendNow(now()) && now().getTime() >= S.nextSendAt) await sendOne();
    } catch (e) { ev('error', `tick: ${e.message}`); save(); } finally { busy = false; }
  }

  // Live end-to-end test against Zac's own GHL contact (ALERT_CONTACT_ID). Ignores mode, caps and send window.
  async function testSend(brand = 'rgs') {
    load();
    if (!env.ALERT_CONTACT_ID) throw new Error('ALERT_CONTACT_ID is not set');
    if (!ghlReady()) throw new Error('GHL keys are not set');
    const from = brand === 'zw' ? env.GHL_FROM_NUMBER_ZW : (env.GHL_FROM_NUMBER_RGS || env.GHL_FROM_NUMBER);
    if (!from) throw new Error(`${brand === 'zw' ? 'GHL_FROM_NUMBER_ZW' : 'GHL_FROM_NUMBER_RGS'} is not set`);
    await endTest(true);
    const p = { place_id: `TEST-${now().getTime()}`, name: 'Test Roofing Co', phone: env.TEST_PHONE || '6178775608', trade: 'roofing contractor', town: 'Worcester, MA', tier: 'A', web_type: 'none', reviews: '12' };
    const slug = await generateSite(env, p, dir, fetchImpl, brand);
    const url = `${publicUrl()}/s/${slug}`;
    const L = (S.leads[p.place_id] = { id: p.place_id, test: true, name: p.name, phone: p.phone, trade: p.trade, town: p.town, tier: 'A', brand, slug, url, status: 'sent', step: 1, replies: [], botReplies: 0, contactId: env.ALERT_CONTACT_ID, created: now().toISOString(), lastSentAt: now().getTime() });
    L.msg = brand === 'zw' ? zanderMessage(p) : (await writeMessage(p, url, null)).text;
    await addTags(env, L.contactId, ['zw-autopilot'], fetchImpl);
    await sendSms(env, L.contactId, L.msg, fetchImpl, from);
    S.byContact[L.contactId] = L.id;
    ev('test', `TEST ${brand === 'zw' ? "Zander's" : 'RGS'} text sent to your phone: "${L.msg}"`, L.id);
    save(); return { sent: L.msg, url };
  }
  async function endTest(quiet = false) {
    load();
    const tests = Object.values(S.leads).filter((L) => L.test);
    for (const L of tests) { if (S.byContact[L.contactId] === L.id) delete S.byContact[L.contactId]; delete S.leads[L.id]; }
    S.pending = S.pending.filter((p) => S.leads[p.id]);
    if (tests.length && env.ALERT_CONTACT_ID) { try { await removeTags(env, env.ALERT_CONTACT_ID, ['zw-autopilot', 'zw-hot', 'zw-optout'], fetchImpl); } catch (e) { ev('warn', `could not remove test tags: ${e.message}`); } }
    S.optOut = S.optOut.filter((ph) => !tests.some((L) => L.phone === ph));
    if (tests.length && !quiet) ev('test', 'Test ended; your contact is back to normal');
    save(); return { ended: tests.length };
  }

  function setSettings(s) {
    load(); const n = S.settings;
    if (['off', 'draft', 'auto'].includes(s.mode)) n.mode = s.mode;
    if (Number.isFinite(+s.dailyBudget)) n.dailyBudget = Math.min(500, Math.max(0, +s.dailyBudget));
    if (Number.isFinite(+s.dailyTextCap)) n.dailyTextCap = Math.min(1000, Math.max(0, Math.floor(+s.dailyTextCap)));
    if (typeof s.offer === 'string') n.offer = s.offer.slice(0, 600);
    if (typeof s.offerZw === 'string') n.offerZw = s.offerZw.slice(0, 600);
    save();
  }
  const resume = () => { load().paused = null; ev('info', 'Resumed by Zac'); save(); };
  const resolve = (id) => { const L = load().leads[id]; if (L) { L.needsYou = false; if (L.status === 'hot') L.status = 'handled'; save(); } };

  function view() {
    load(); const d = day(); const week = Object.entries(S.days).sort().slice(-7);
    const leads = Object.values(S.leads);
    return {
      locationId: env.GHL_LOCATION_ID || '', settings: S.settings, paused: S.paused, today: d, effCap: effCap(), week: week.map(([date, v]) => ({ date, ...v })),
      needsYou: leads.filter((L) => L.needsYou).map((L) => ({ id: L.id, name: L.name, phone: L.phone, contactId: L.contactId, last: L.replies.filter((r) => !r.bot).slice(-1)[0]?.text || '', intent: L.lastIntent })),
      drafts: leads.filter((L) => L.status === 'drafted').slice(0, 8).map((L) => ({ id: L.id, name: L.name, msg: L.msg, url: L.url, why: L.why || '' })),
      testActive: leads.some((L) => L.test), testLead: (leads.find((L) => L.test) || null) && (({ msg, url, replies, lastIntent, brand }) => ({ msg, url, replies, lastIntent, brand }))(leads.find((L) => L.test)), zwScheduled: leads.filter((L) => L.zwDueAt && !L.zwSentAt).length, counts: leads.reduce((a, L) => ((a[L.status] = (a[L.status] || 0) + 1), a), {}), events: S.events.slice(0, 40),
      setup: { claude: !!env.ANTHROPIC_API_KEY, ghl: ghlReady(), publicUrl: !!publicUrl(), stages: !!(stage('TEXTED') && stage('RESPOND_YES')), zwPipeline: zwPipe(), webhook: !!env.GHL_WEBHOOK_SECRET, alerts: !!env.ALERT_CONTACT_ID, numberRgs: !!(env.GHL_FROM_NUMBER_RGS || env.GHL_FROM_NUMBER), numberZw: !!env.GHL_FROM_NUMBER_ZW, inWindow: canSendNow(now()) },
    };
  }
  return { tick, handleInbound, setSettings, resume, resolve, view, testSend, endTest, _state: () => load() };
}
