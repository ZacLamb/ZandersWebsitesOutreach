// Autopilot: drafts a sample site + text per lead, sends within hard caps, follows up, triages replies,
// and hands anything important to Zac. Default mode is "off". Every action is logged in out/autopilot.json.
import fs from 'node:fs';
import path from 'node:path';
import { askClaude } from './claude.js';
import { generateSite } from './sites.js';
import { stageProspect, sendSms, moveOpportunity, addTags } from './ghl.js';

// Estimated unit costs in USD (Zac's SMS rate; the rest are rough and only used for the budget guard).
export const COST = { sms: 0.008, site: 0.01, msg: 0.01, triage: 0.005, search: 0.035 }; // site = per-trade template, filled per lead
export const DEFAULTS = {
  mode: 'off', dailyBudget: 5, dailyTextCap: 25, maxBotReplies: 2, zwDelayDays: 7,
  offer: 'Revenue Generating Solutions: website build $497 one time, then $99/mo for hosting, changes and Google Business Profile setup. No contract. Optional local SEO (town and service pages added monthly) is +$199/mo.',
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

const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out)\W*$|\b(remove me|do not text|don'?t text|dont text|leave me alone|stop (texting|messaging|contacting|calling)|take me off|opt out)\b/i;
export const isOptOut = (t) => OPT_OUT.test(String(t || ''));
const ascii = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\n]/g, '').replace(/ +/g, ' ').trim();
export const segments = (m) => Math.max(1, Math.ceil(m.length / (m.length <= 160 ? 160 : 153)));
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);

const hook = (p) => ({ none: "doesn't have a website on its Google listing", 'social-only': 'is only on Facebook with no website', 'builder-subdomain': 'has a website that looked a bit outdated' }[p.web_type] || 'had a website that looked a bit outdated');
export function zanderMessage(p, url) {
  return ascii(`Hi! I'm Zander, I'm 7 and building websites is my first business (my dad helps). I made one for ${p.name}: ${url} It's $20/mo, no setup fee. Reply STOP to opt out.`);
}
export function templateMessage(p, url, step) {
  if (step === 1) return ascii(`Hey, just checking you saw the sample site I built for ${p.name}? ${url} Happy to tweak it, no pressure.`);
  if (step === 2) return ascii(`Last note from me, the sample for ${p.name} stays up this week: ${url} Thanks either way! Reply STOP to opt out.`);
  // Short wins: in Zac's history, texts under ~140 chars got ~35% replies vs ~9% over 300 chars (confounded, but consistent).
  return ascii(`Hey, Zac here. Built a free sample site for ${p.name}: ${url} Worth a look? Reply STOP to opt out.`);
}

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
  const pause = (why) => { load().paused = why; ev('paused', why); save(); };
  const ghlReady = () => !!(env.GHL_TOKEN && env.GHL_LOCATION_ID && env.GHL_PIPELINE_ID && env.GHL_STAGE_NEW_LEAD);
  const publicUrl = () => env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');

  async function writeMessage(p, url) {
    if (!env.ANTHROPIC_API_KEY) return templateMessage(p, url, 0);
    try {
      const t = await askClaude(env, {
        system: `${VOICE}\nWrite ONE first text from Zac to the owner of a local trade business. Rules: SHORT, under 150 characters not counting the link (short texts get 3-4x the replies), plain ASCII, no emoji, at most one true specific detail from the facts, include the link exactly as given, say it is a free sample he built, no price, no hype, no invented facts, do not claim to know the owner's name. Start with "Hey" or "Morning". Include "Zac". End with "Reply STOP to opt out." Return only the text.`,
        user: `Business: ${p.name}\nTrade: ${p.trade}\nTown: ${p.town}\nWebsite situation: ${hook(p)}\nGoogle reviews: ${p.reviews || 'unknown'} (rating ${p.rating || 'unknown'})\nLink: ${url}`, maxTokens: 300,
      }, fetchImpl);
      const m = ascii(t);
      return m.includes(url) && /stop/i.test(m) && m.length <= 260 ? m : templateMessage(p, url, 0);
    } catch (e) { ev('warn', `message draft fell back to template: ${e.message}`); return templateMessage(p, url, 0); }
  }

  async function draftOne() {
    load();
    if (!env.ANTHROPIC_API_KEY || !publicUrl()) return false;
    if (!room(COST.site + COST.msg)) return false;
    const p = deps.nextProspect(new Set(Object.keys(S.leads)), new Set(S.optOut));
    if (!p) return false;
    const L = (S.leads[p.place_id] = { id: p.place_id, name: p.name, phone: digits(p.phone), trade: p.trade, town: p.town, tier: p.tier, status: 'drafting', step: 0, replies: [], botReplies: 0, created: now().toISOString() });
    try {
      const slug = await generateSite(env, p, dir, fetchImpl);
      L.slug = slug; L.url = `${publicUrl()}/s/${slug}`;
      L.msg = await writeMessage(p, L.url); L.status = 'drafted';
      const d = day(); d.spend += COST.site + COST.msg; d.drafts++;
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
    const done = Object.values(S.leads).find((x) => quiet(x) && x.step === 3 && t - x.lastSentAt >= 4 * DAY);
    if (done) {
      done.status = 'no_response'; done.zwDueAt = t + (S.settings.zwDelayDays * DAY); ev('info', `No response from ${done.name}; closing out (Zander's Websites follow-up scheduled)`, done.id);
      try { await moveOpportunity(env, done.oppId, stage('NO_RESPONSE'), fetchImpl); } catch {} save(); return true;
    }
    const due = Object.values(S.leads).find((x) => quiet(x) && ((x.step === 1 && t - x.lastSentAt >= 3 * DAY) || (x.step === 2 && t - x.lastSentAt >= 4 * DAY)));
    let L = due, step = due ? due.step : 0;
    // Zander's Websites second touch: separate brand, separate number, after RGS got a no / no answer.
    if (!L && env.GHL_FROM_NUMBER_ZW) {
      const z = Object.values(S.leads).find((x) => x.zwDueAt && x.zwDueAt <= t && !x.zwSentAt && x.status !== 'opted_out' && x.contactId);
      if (z) {
        const zmsg = zanderMessage(z, z.zwUrl || z.url);
        if (!room(segments(zmsg) * COST.sms)) return false;
        try {
          if (!z.zwUrl) { const slug = await generateSite(env, { name: z.name, phone: z.phone, trade: z.trade, town: z.town }, dir, fetchImpl, 'zw'); z.zwUrl = `${publicUrl()}/s/${slug}`; }
          const m2 = zanderMessage(z, z.zwUrl);
          await sendSms(env, z.contactId, m2, fetchImpl, env.GHL_FROM_NUMBER_ZW);
          d.texts++; d.spend += segments(m2) * COST.sms; z.zwSentAt = t; z.brand = 'zw'; z.status = 'zw_sent'; z.botReplies = 0; z.msg = m2;
          try { await addTags(env, z.contactId, ['zw-zander-pitch'], fetchImpl); } catch {}
          ev('send', `Zander's Websites text to ${z.name}`, z.id);
          S.nextSendAt = t + ((9.5 * 3600e3) / effCap()) * (0.7 + Math.random() * 0.6);
        } catch (e) { d.errors++; ev('error', `Zander send failed for ${z.name}: ${e.message}`, z.id); }
        save(); return true;
      }
    }
    if (!L) { L = Object.values(S.leads).find((x) => x.status === 'drafted'); step = 0; }
    if (!L) return false;
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
      if (step === 0) { try { await moveOpportunity(env, L.oppId, stage('TEXTED'), fetchImpl); } catch (e) { ev('warn', `stage move failed: ${e.message}`, L.id); } }
      ev('send', `${step === 0 ? 'Texted' : 'Follow-up ' + step + ' to'} ${L.name}`, L.id);
      const gap = (9.5 * 3600e3) / effCap(); S.nextSendAt = t + gap * (0.7 + Math.random() * 0.6);
    } catch (e) {
      d.errors++; ev('error', `Send failed for ${L.name}: ${e.message}`, L.id);
      if (/landline|invalid|not a valid|cannot be sent/i.test(e.message)) { L.status = 'bad_number'; try { await moveOpportunity(env, L.oppId, stage('BAD_NUMBER'), fetchImpl); } catch {} }
      if (d.errors >= 5) pause('5 send errors in a row. Check the number/A2P status in GHL, then resume.');
    }
    save(); return true;
  }

  async function classify(L, text) {
    if (!env.ANTHROPIC_API_KEY) return { intent: 'other', reply: '' };
    try {
      const out = await askClaude(env, {
        system: `You triage replies to a cold text. SENDER: ${L.brand === 'zw' ? "Zander's Websites (Zander, age 7, with his dad Zac helping)" : 'Zac from Revenue Generating Solutions'}, who offered a local trade business a free sample website. Return ONLY JSON: {"intent": one of "interested","price","question","objection","not_interested","wrong_person","asks_if_bot","other","reply": string}. "reply" is a short friendly plain-ASCII text from Zac (max 220 chars, no emoji) or "" if no reply should be sent. Rules: never state any price or timeline unless it appears in OFFER below; if price is asked and OFFER is empty, reply that you'll grab the details and text right back; never promise anything not in OFFER; if they ask whether this is a bot/automated/AI, intent "asks_if_bot" and reply ""; if not_interested/wrong_person, reply "" ; keep the sender's casual local voice; never mention the other brand.\nOFFER: ${(L.brand === 'zw' ? S.settings.offerZw : S.settings.offer) || '(none)'}`,
        user: `Business: ${L.name}\nOur text: ${L.msg}\nTheir reply: ${text}`, maxTokens: 300,
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
      try { await addTags(env, contactId, ['zw-optout'], fetchImpl); await moveOpportunity(env, L.oppId, stage('NOT_INTERESTED'), fetchImpl); } catch {}
      const d = day(); if (d.texts >= 10 && d.optouts / d.texts > 0.08) pause(`Opt-outs are ${Math.round((100 * d.optouts) / d.texts)}% of today's texts. Review the message before resuming.`);
      save(); return { optout: true };
    }
    const c = await classify(L, body); L.lastIntent = c.intent;
    if (L.brand !== 'zw' && ['not_interested', 'objection'].includes(c.intent) && !L.zwSentAt) L.zwDueAt = now().getTime() + S.settings.zwDelayDays * DAY;
    if (['interested', 'price'].includes(c.intent)) L.zwDueAt = null;
    const hot = ['interested', 'price', 'objection', 'asks_if_bot', 'other', 'question'].includes(c.intent);
    if (c.intent === 'not_interested' || c.intent === 'wrong_person') {
      L.status = 'closed'; try { await moveOpportunity(env, L.oppId, stage('NOT_INTERESTED'), fetchImpl); } catch {}
    } else if (hot) {
      L.status = 'hot'; L.needsYou = true;
      try { await moveOpportunity(env, L.oppId, ['interested', 'price'].includes(c.intent) ? stage('RESPOND_YES') : stage('RESPOND'), fetchImpl); await addTags(env, contactId, ['zw-hot'], fetchImpl); } catch {}
      await alertZac(`ZW lead: ${L.name} replied "${body.slice(0, 120)}"`);
    }
    if (c.reply && L.botReplies < S.settings.maxBotReplies) { S.pending.push({ id: L.id, at: now().getTime() + 45e3 + Math.random() * 75e3, text: c.reply }); L.botReplies++; }
    ev('reply', `${L.name}: "${body.slice(0, 80)}" -> ${c.intent}${c.reply ? ' (auto-reply queued)' : ''}`, L.id);
    save(); return { intent: c.intent };
  }

  async function flushPending() {
    load(); const t = now().getTime();
    for (const p of [...S.pending]) {
      if (p.at > t || !canReplyNow(now())) continue;
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
      if (S.settings.mode === 'off' || S.paused) return;
      await flushPending();
      // supply: keep a small buffer of drafts, top up leads with a daily search batch
      const drafted = Object.values(S.leads).filter((L) => L.status === 'drafted').length;
      const cap = effCap(), d = day();
      if (drafted < Math.min(5, cap - d.texts)) { if (await draftOne()) return; }
      if (deps.readyCount(new Set(Object.keys(S.leads)), new Set(S.optOut)) < 15 && d.searches < 60 && !deps.jobRunning() && room(60 * COST.search) && env.GOOGLE_PLACES_KEY) {
        if (deps.startFind(60)) { d.searches += 60; d.spend += 60 * COST.search; ev('search', 'Started a 60-search batch to find more leads'); save(); }
      }
      if (S.settings.mode === 'auto' && ghlReady() && canSendNow(now()) && now().getTime() >= S.nextSendAt) await sendOne();
    } catch (e) { ev('error', `tick: ${e.message}`); save(); } finally { busy = false; }
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
      drafts: leads.filter((L) => L.status === 'drafted').slice(0, 8).map((L) => ({ id: L.id, name: L.name, msg: L.msg, url: L.url })),
      zwScheduled: leads.filter((L) => L.zwDueAt && !L.zwSentAt).length, counts: leads.reduce((a, L) => ((a[L.status] = (a[L.status] || 0) + 1), a), {}), events: S.events.slice(0, 40),
      setup: { claude: !!env.ANTHROPIC_API_KEY, ghl: ghlReady(), publicUrl: !!publicUrl(), stages: !!(stage('TEXTED') && stage('RESPOND_YES')), webhook: !!env.GHL_WEBHOOK_SECRET, alerts: !!env.ALERT_CONTACT_ID, numberRgs: !!(env.GHL_FROM_NUMBER_RGS || env.GHL_FROM_NUMBER), numberZw: !!env.GHL_FROM_NUMBER_ZW, inWindow: canSendNow(now()) },
    };
  }
  return { tick, handleInbound, setSettings, resume, resolve, view, _state: () => load() };
}
