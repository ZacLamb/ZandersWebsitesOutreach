// Autopilot: drafts a sample site + text per lead, sends within hard caps, follows up, triages replies,
// and hands anything important to Zac. Default mode is "off". Every action is logged in out/autopilot.json.
import fs from 'node:fs';
import path from 'node:path';
import { askClaude } from './claude.js';
import { research, brief } from './research.js';
import { generateSite } from './sites.js';
import { stageProspect, sendSms, moveOpportunity, addTags, removeTags, getThread, setWhisper, getContact, isCarrierDnd } from './ghl.js';
import { createPaymentLink, paidSession, PLANS, stripeKey } from './stripe.js';

// Estimated unit costs in USD (Zac's SMS rate; the rest are rough and only used for the budget guard).
export const COST = { sms: 0.008, site: 0.01, msg: 0.03, research: 0.03, triage: 0.005, search: 0.035 }; // site = per-trade template, filled per lead
export const DEFAULTS = {
  mode: 'off', dailyBudget: 5, dailyTextCap: 25, maxBotReplies: 2, zwDelayDays: 7, callWarmDays: 2, callCold: true, autoCall: true,
  offer: 'Revenue Generating Solutions: the sample site is already built. No setup fee and nothing down: it goes live this week, the first month is free, then $99/mo for hosting, changes and Google Business Profile setup. Cancel anytime, no contract. Option: pay the year up front ($1,188) instead. Optional local SEO is +$199/mo: a new article on their site every day about their local area (their towns, local projects, seasonal tips for their trade), each linked back to their service and town pages so Google ranks the whole site higher.',
  offerZw: "Zander's Websites: $20/mo, no setup fee, no contract. Zander is 7 and this is his first business; his dad helps him.",
};
const HOLIDAYS = new Set(['2026-11-26', '2026-12-25', '2027-01-01']);
const DAY = 864e5;

export function etParts(d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: (+p.hour % 24) + +p.minute / 60, dow: p.weekday };
}
// Recipients are in New England. Sales texts go out 7 days a week inside each state's legal window (local = Eastern):
// federal TCPA 8am-9pm; we stop at 6:30pm. Connecticut starts 9am. Rhode Island: Mon-Fri 9-6, Sat 10-5, never Sunday or holidays.
// Sundays everywhere else start at 10am (courtesy). Never on listed holidays.
export const stateOf = (town) => (String(town || '').match(/,\s*([A-Z]{2})\b/) || [])[1] || '';
export function sendWindow(dow, state) {
  if (state === 'RI') return dow === 'Sun' ? null : dow === 'Sat' ? [10, 17] : [9, 18];
  const start = dow === 'Sun' ? 10 : state === 'CT' ? 9 : 8;
  return [start, 18.5];
}
export const canSendNow = (d, state = '') => {
  const t = etParts(d); if (HOLIDAYS.has(t.date)) return false;
  const w = sendWindow(t.dow, state); return !!w && t.hour >= w[0] && t.hour < w[1];
};
export const canReplyNow = (d) => { const t = etParts(d); return !HOLIDAYS.has(t.date) && t.hour >= 8 && t.hour < 21; };

const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out)\W*$|\b(remove me|do not text|don'?t text|dont text|stop (texting|messaging|contacting|calling)|take me off|opt out)\b/i;
export const isOptOut = (t) => OPT_OUT.test(String(t || ''));
const ascii = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\n]/g, '').replace(/ +/g, ' ').trim();
export const segments = (m) => Math.max(1, Math.ceil(m.length / (m.length <= 160 ? 160 : 153)));
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);

export const STAGES = {
  rgs: [['NEW_LEAD', 'New Lead'], ['TEXTED', 'Texted'], ['RESPOND', 'Replied'], ['RESPOND_YES', 'Interested'], ['WON', 'Won'], ['BAD_NUMBER', 'Bad Number'], ['OPTED_OUT', 'Opted Out']],
  zw: [['QUEUED', 'Queued'], ['TEXTED', 'Texted'], ['RESPOND', 'Replied'], ['RESPOND_YES', 'Interested'], ['WON', 'Won'], ['NOT_INTERESTED', 'Not Interested'], ['NO_RESPONSE', 'No Response'], ['OPTED_OUT', 'Opted Out']],
};
// Which website problem the first text led with (for reply-rate by angle).
export function angleOf(L) {
  const site = L.facts?.site;
  if (!L.website) return 'No website';
  if (/facebook\.com/i.test(L.website)) return 'Facebook only';
  if (site && !site.works) return 'Site broken';
  if (site && !site.mobileFriendly) return 'Not mobile friendly';
  if (site && !site.https) return 'Not secure';
  if (site?.copyrightYear && site.copyrightYear < new Date().getFullYear() - 2) return 'Outdated site';
  return 'Has a site';
}
// Why the AI has stopped chasing this lead for good ('' = still working it or waiting on Zander's).
export function finishedWhy(L) {
  if (L.paid || L.status === 'won') return 'Paid';
  if (L.status === 'opted_out') return L.dnd ? 'Do Not Disturb' : 'Opted out';
  if (L.status === 'bad_number') return "Can't text this number";
  if (L.status === 'landline') return 'Landline: call only';
  if (L.status === 'duplicate') return 'Already in GHL';
  if (L.status === 'send_failed') return 'Texts kept failing';
  if (L.zwDueAt || L.inZwQueue) return '';
  if (L.status === 'zw_no_response') return "No reply to RGS or Zander's";
  if (L.status === 'closed') return L.zwSentAt ? "Said no to Zander's too" : 'Said no';
  if (L.status === 'no_response') return 'Never replied';
  return '';
}
// One line on their current site for the dashboard (what we found before texting them).
export function siteNote(L) {
  const s = L.facts?.site;
  if (!L.website) return 'No website on their Google listing';
  if (/facebook\.com/i.test(L.website)) return 'Facebook page only';
  if (!s) return '';
  if (!s.works) return `Site didn't load${s.status ? ` (error ${s.status})` : ''}`;
  return [s.builder && `built on ${s.builder}`, !s.mobileFriendly && 'not mobile friendly', !s.https && 'not secure (no https)', s.copyrightYear && `© ${s.copyrightYear}`].filter(Boolean).join(' · ') || 'Site loads fine';
}
const hook = (p) => ({ none: "doesn't have a website on its Google listing", 'social-only': 'is only on Facebook with no website', 'builder-subdomain': 'has a website that looked a bit outdated' }[p.web_type] || 'had a website that looked a bit outdated');
// First texts ask permission (no link). The sample link goes out only after they say yes.
export function zanderMessage(p) {
  return ascii(`Hi! I'm Zander, I'm 7 and building websites is my first business (my dad helps). I made a free one for ${p.name}, can I send it to you? It's $20/mo, no setup fee.`);
}
export function templateMessage(p, url, step) {
  if (step === 1) return ascii(`Hey, did you see my text? Put something together for ${shortName(p.name)}, want to see it?`);
  if (step === 2) return ascii(`Last one from me, still have what I made for ${shortName(p.name)} if you ever want to see it. -Zac`);
  return ascii(`Hey! Came across ${shortName(p.name)} on Google, do you guys have a website?`);
}
// "Hemerson carpentry finish inc" -> "Hemerson Carpentry Finish" for texts that sound like a person wrote them.
export const shortName = (n) => String(n || '').replace(/\b(inc|llc|l\.l\.c|corp|co|ltd|incorporated|company)\.?\s*$/i, '').replace(/[,\s]+$/, '').replace(/(^|\s)([a-z])/g, (m) => m.toUpperCase()).trim();
// Fallbacks only (the AI writes these from the actual conversation). Both say who Zac is and why he is texting.
export const linkMessage = (p, url, brand) => ascii(brand === 'zw'
  ? `Yay! Here it is: ${url} I made it for ${p.name}. Tell me what you think!`
  : `My name's Zac, I build websites for trades around here. I put together a sample site for ${shortName(p.name)} so you can see what yours could look like: ${url} What do you think?`);
export const offerMessage = (p) => ascii(`My name's Zac! I build websites for trades around here and put together a sample one for ${shortName(p.name)}. Want me to send it over?`);
const SKIP_LINK = new Set(['not_interested', 'wrong_person', 'asks_if_bot']);

const VOICE = `Zac's texting style: casual, plain words, short sentences, sounds like a local contractor texting another contractor. No marketing language.`;

// First-text style split test (built from Zac's own reply data: short + a question wins).
export const OPENERS = {
  ask: { label: 'Direct question (Zac classic)', how: 'Zac\'s proven format: short greeting, a few words on how he came across them, then "do you guys have a website?". e.g. "Hey Mike! Came across Joe\'s Roofing on Google, do you guys have a website?"' },
  rightnum: { label: 'Right number check', how: 'Pattern interrupt: only ask if this is the right number for the business, nothing else (people almost always answer). e.g. "Hey, is this the right number for Cape Tile?" or "Is this Mike from Joe\'s Roofing?"' },
  whohandles: { label: 'Who handles it', how: 'Ask who handles their website, assuming nothing. e.g. "Quick one, who handles the website for Fisher Electric?" or "Morning! Who takes care of the online stuff for Cape Tile?"' },
  showwork: { label: 'Where do they see your work', how: 'Open on one true, specific detail from their reviews in a few words, then ask where people go to see their work. e.g. "41 five-star reviews is no joke. Where do you send people who want to see your work?"' },
  headsup: { label: 'Helpful heads-up', how: 'Give-first: a short, true heads-up about their Google listing or site from the research, then a question. e.g. "Heads up, Cape Tile doesn\'t have a website on Google, so searches go to whoever does. Was that on purpose?" or "Morning Scott, your site isn\'t loading on phones, did you know?"' },
  proof: { label: 'Local proof', how: 'Light social proof, then the question. e.g. "Hey! I\'ve been helping a few trade guys around the Cape get more calls off Google. Do you guys have a website?" Keep it vague (no client names, no numbers).' },
};
// Offer split test (quoted only when they ask about price; never in the first text). Each RGS lead gets one variant; Metrics shows replies and sales per variant.
export const VARIANTS = {
  guarantee: { label: 'No-risk framing', hook: "The first month is free, so if it doesn't get them a call they cancel and never pay a cent.", offer: 'Frame it on this lead as zero risk: if the site does not get them a call in the first month, they cancel before billing starts and never pay a cent.', plan: 'starter' },
  trial: { label: 'First month free', hook: "First month is free and there's no contract.", offer: '', plan: 'starter' },
  thisweek: { label: 'Live this week', hook: 'It is already built and can be live on their own name this week.', offer: 'Frame it on this lead around speed: it is already built and can be live this week.', plan: 'starter' },
  plain: { label: 'Plain', hook: "It's already built, nothing down, no contract.", offer: '', plan: 'starter' },
};


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
    const zw = brand === 'zw' && zwPipe();
    L.pipe = zw ? 'zw' : 'rgs'; L.stage = key; L.stageAt = now().getTime();
    if (!L.oppId) return;
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
  const greet = () => (etParts(now()).hour < 12 ? 'morning' : 'afternoon/evening, so use Hey');
  const hookFor = (p) => (VARIANTS[p.variant] || VARIANTS.plain).hook;
  const badOpener = (m) => /zac|this is|i'?m local|i am local/i.test(m.slice(0, 30));
  const okText = (m, max = 330) => m && !/https?:|www\.|\.com|\/s\//i.test(m) && /\?/.test(m) && m.length <= max;

  // Research the lead (Google reviews + their current site), then write a first text that could only be for them.
  async function writeMessage(p, url, facts) {
    if (!env.ANTHROPIC_API_KEY) return { text: templateMessage(p, url, 0), why: '' };
    try {
      const t = await askClaude(env, {
        model: WRITER(),
        system: `${VOICE}

You write ONE first cold text to the owner of a local trade business, exactly in Zac's style. The only goal is getting a reply.

These are real first texts of Zac's that got replies:
"Hey Elfin, saw ur post on Contractors of MA Fb Group, Do you have a website?"
"Hey margarita! Do you have a website to show off some of your cleaning jobs?"
"Morning Scott, Your website isn't showing on Google, just wanted to give you a heads up"
"Hey Albert! Saw your post in the SMB networking MA/NH group, do you have a website for your solar business?"
"Austin! Congrats on starting up the business man! Do you have a website yet to book appointments and show jobs?"
"Hey Damon, do you guys have a website by chance? I build them for the trades, figured I'd ask"
From 2,000 of his texts: under 120 characters got 47% replies, over 300 got 9%. Asking them a direct question ("do you have a website?") got 35%.

Use THIS opener framework for this lead (do not fall back to another one):
${(OPENERS[p.opener] || OPENERS.ask).how}

Make it sound like a real person texting from his phone, and vary it: do NOT always start with "Hey NAME! Came across". Greeting is optional; if you greet, it is currently ${greet()} where they are. Use the owner's first name ONLY if two or more reviews name the same first name and it is clearly the owner. Use a short form of the business name. You may end with "-Zac" or not. It must end with (or contain) ONE easy question they will want to answer.

Hard rules: 35-150 characters total. No price, cost, money, "free", offers, contracts or guarantees. No link or URL. Do not explain what Zac does or sell anything. Do not compliment their reviews or describe their business back to them. Plain ASCII, no emoji. Never invent facts.

Return ONLY JSON: {"text": "...", "why": "the specific detail(s) you used, 10 words max"}${learnBlock(['first_text'], false)}`,
        user: brief(p, facts), maxTokens: 2500,
      }, fetchImpl);
      // Prefer the JSON shape; if the model answered with just the text, use that.
      let j = {}; const jm = t.match(/\{[\s\S]*\}/);
      if (jm) { try { j = JSON.parse(jm[0]); } catch { j = {}; } }
      if (!j.text) { const tm = t.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/); if (tm) j.text = JSON.parse(`"${tm[1]}"`); }
      const m = ascii(j.text || (/"text"\s*:/.test(t) ? '' : t.replace(/^```\w*|```$/g, '').replace(/^["']|["']$/g, '').trim()));
      if (okText(m, 170) && !/\$|\bfree\b|price|cost|contract|guarantee|per month|\/mo\b/i.test(m)) return { text: m, why: ascii(j.why || '').slice(0, 120) };
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

  // Their first reply came in: answer it like a person, say who Zac is and why he is texting, then either offer the sample or send it.
  const okBridge = (m, link, introduced) => m && m.length <= 330 && !/^figured/i.test(m) && /\b(site|website)\b/i.test(m) && (introduced || /\bzac\b/i.test(m))
    && !/\$|\bfree\b|price|cost|contract|per month|\/mo\b/i.test(m) && (link ? (m.match(/\{LINK\}/g) || []).length === 1 && m.replace('{LINK}', '').length >= 70 : !/https?:|\{LINK\}/.test(m));
  async function writeBridge(L, body) {
    const introduced = /\bzac\b/i.test([L.msg, ...L.replies.filter((r) => r.bot || r.me).map((r) => r.text)].join(' '));
    const fallback = L.sampleOffered ? { action: 'link', text: linkMessage(L, L.url, 'rgs') } : { action: 'offer', text: offerMessage(L) };
    if (!env.ANTHROPIC_API_KEY) return fallback;
    const convo = [`ZAC: ${L.msg}`, ...L.replies.map((r) => `${r.bot || r.me ? 'ZAC' : 'THEM'}: ${r.text}`)].join('\n');
    try {
      const t = await askClaude(env, {
        model: WRITER(), maxTokens: 2000,
        system: `${VOICE}

You write Zac's NEXT text in a cold conversation with a local trade business owner. Zac builds websites for local trades and has ALREADY built a sample site for their business (it is real and ready). Context the reader may not have: who Zac is, and why he is texting them.

Write like a real person who just got a reply from someone he texted out of the blue:
1. First respond to what they actually said. If they asked who this is, tell them ("My name's Zac", the way Zac says it). If they asked why, tell them. If they answered "no website" acknowledge it ("No worries", "Figured you might not"). If they confirmed it's them, just roll into it naturally.
2. Unless Zac's earlier texts already said it, say in a few plain words who he is and why he's texting: he builds websites for trades around here and already put together a sample site for them. If the facts show a real reason (no website on Google, Facebook only, old or broken site) you may mention it briefly and honestly. Never invent anything.
3. Then choose:
   - "offer": ask if they want to see it, with NO link. Use this when they were guarded or asked who this is, when they only confirmed the number/name, or when they don't yet know why Zac is texting. This is the default.
   - "link": only when they clearly said yes to seeing it, or answered Zac's website question in a way that shows they are open (e.g. "no we don't have one", "not yet"), or Zac already offered it. Put the placeholder {LINK} exactly once where the link goes, with context BEFORE it (what it is: a sample site he made for them), and end with an easy question like "What do you think?"
${L.sampleOffered ? 'Zac already offered to send it and they replied; unless they said no, use "link".\n' : ''}Never send a bare link, never start with "Figured!", never sound like a mass text. No price, cost, "free", offers or contracts (if they ask price, say you'll go over it after they see it). 80-300 characters, plain ASCII, no emoji. Optional sign-off "-Zac" only if the name isn't already in the text.

Return ONLY JSON: {"action": "offer" or "link", "text": "..."}`,
        user: `Business: ${L.name} (${L.trade || 'trade'}, ${L.town || ''})\nWhat we know: ${angleOf(L)}${L.facts?.site?.copyrightYear ? ', site copyright ' + L.facts.site.copyrightYear : ''}\nConversation so far:\n${convo}\nTheir latest reply: ${body}`,
      }, fetchImpl);
      const jm = t.match(/\{[\s\S]*\}/); const j = JSON.parse(jm ? jm[0] : '{}');
      const action = j.action === 'link' || L.sampleOffered ? 'link' : 'offer';
      const m = ascii(j.text || '');
      if (okBridge(m, action === 'link', introduced)) return { action, text: m };
      ev('warn', `reply to ${L.name} failed checks ("${m.slice(0, 70)}..."), using the safe version`, L.id);
    } catch (e) { ev('warn', `reply writer failed: ${e.message}`, L.id); }
    return fallback;
  }

  // Research + write for a lead object; stores facts so the Zander touch can reuse them.
  async function personalize(L) {
    if (!L.facts) { try { L.facts = await research(env, L, fetchImpl); } catch { L.facts = {}; } day().spend += COST.research; }
    const r = await writeMessage(L, L.url, L.facts);
    day().spend += COST.msg;
    L.msg = r.text; L.why = r.why; L.researched = true; L.writes = (L.writes || 0) + 1; L.angle = angleOf(L);
  }

  // Rotate openers evenly; once every opener has 20+ sends, give the best reply rate half the traffic.
  function nextOpener() {
    const st = Object.fromEntries(Object.keys(OPENERS).map((k) => [k, { n: 0, sent: 0, rep: 0 }]));
    for (const L of Object.values(S.leads)) {
      const x = st[L.opener]; if (!x) continue; x.n++;
      if (L.step >= 1) { x.sent++; if (L.replies.some((r) => !r.bot && !r.me && !isOptOut(r.text))) x.rep++; }
    }
    const keys = Object.keys(st);
    if (keys.every((k) => st[k].sent >= 20) && Math.random() < 0.5) return keys.sort((a, b) => st[b].rep / st[b].sent - st[a].rep / st[a].sent)[0];
    return keys.sort((a, b) => st[a].n - st[b].n)[0];
  }
  function nextVariant() {
    const n = Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, 0]));
    for (const L of Object.values(S.leads)) if (n[L.variant] != null) n[L.variant]++;
    return Object.keys(n).sort((a, b) => n[a] - n[b])[0];
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
    const L = (S.leads[p.place_id] = { id: p.place_id, place_id: p.place_id, name: p.name, phone: digits(p.phone), trade: p.trade, town: p.town, tier: p.tier, website: p.website || '', web_type: p.web_type || '', rating: p.rating, reviews: p.reviews, status: 'drafting', step: 0, replies: [], botReplies: 0, created: now().toISOString(), variant: nextVariant(), opener: nextOpener() });
    try {
      const slug = await generateSite(env, p, dir, fetchImpl);
      L.slug = slug; L.url = `${publicUrl()}/s/${slug}`;
      await personalize(L); L.status = 'drafted';
      const d = day(); d.spend += COST.site; d.drafts++;
      ev('draft', `Drafted sample + text for ${p.name}`, p.place_id);
    } catch (e) { L.status = 'failed'; L.error = e.message; ev('error', `Draft failed for ${p.name}: ${e.message}`, p.place_id); }
    save(); return true;
  }

  const okNow = (x) => canSendNow(now(), stateOf(x.town));
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
      clearCall(done); done.status = 'no_response'; ev('info', `No response from ${done.name}; moved to Zander's Websites (text goes out in ${S.settings.zwDelayDays} days)`, done.id);
      await toZander(done); save(); return true;
    }
    const due = Object.values(S.leads).find((x) => okNow(x) && quiet(x) && ((x.step === 1 && t - x.lastSentAt >= 3 * DAY) || (x.step === 2 && t - x.lastSentAt >= 4 * DAY)));
    let L = due, step = due ? due.step : 0;
    // Zander's Websites second touch: separate brand, separate number, after RGS got a no / no answer.
    if (!L && env.GHL_FROM_NUMBER_ZW) {
      const z = Object.values(S.leads).find((x) => okNow(x) && x.zwDueAt && x.zwDueAt <= t && !x.zwSentAt && x.status !== 'opted_out' && x.contactId);
      if (z) {
        if (!room(2 * COST.sms + COST.msg)) return false;
        try {
          if (!z.zwUrl) { const slug = await generateSite(env, { name: z.name, phone: z.phone, trade: z.trade, town: z.town }, dir, fetchImpl, 'zw'); z.zwUrl = `${publicUrl()}/s/${slug}`; }
          const m2 = await zanderWrite(z);
          await sendSms(env, z.contactId, m2, fetchImpl, env.GHL_FROM_NUMBER_ZW);
          d.texts++; d.spend += segments(m2) * COST.sms; z.zwSentAt = t; z.brand = 'zw'; z.status = 'zw_sent'; z.botReplies = 0; z.manual = false; z.needsYou = false; z.msg = m2; z.linkSent = false; z.url = z.zwUrl;
          z.inZwQueue = false; await move(z, 'TEXTED');
          try { await addTags(env, z.contactId, ['zw-zander-pitch'], fetchImpl); } catch {}
          ev('send', `Zander's Websites text to ${z.name}`, z.id);
          S.nextSendAt = t + ((10.5 * 3600e3) / effCap()) * (0.7 + Math.random() * 0.6);
        } catch (e) { d.errors++; ev('error', `Zander send failed for ${z.name}: ${e.message}`, z.id); }
        save(); return true;
      }
    }
    if (!L) { L = Object.values(S.leads).find((x) => x.status === 'drafted' && okNow(x)); step = 0; }
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
      L.step = step + 1; L.lastSentAt = now().getTime(); L.status = 'sent'; if (step === 0) L.firstSentAt = L.lastSentAt;
      if (step === 0) await move(L, 'TEXTED');
      ev('send', `${step === 0 ? 'Texted' : 'Follow-up ' + step + ' to'} ${L.name}`, L.id);
      const gap = (10.5 * 3600e3) / effCap(); S.nextSendAt = t + gap * (0.7 + Math.random() * 0.6);
    } catch (e) {
      // Problems with this one contact (DND on, landline, bad number) take the lead out and don't count toward the pause.
      if (/DND|do not disturb/i.test(e.message)) {
        let carrier = false; try { carrier = isCarrierDnd(await getContact(env, L.contactId, fetchImpl)); } catch {}
        if (carrier) markLandline(L);
        else {
          L.status = 'opted_out'; L.dnd = true; L.zwDueAt = null; L.inZwQueue = false; if (!S.optOut.includes(L.phone)) S.optOut.push(L.phone);
          ev('info', `${L.name} has Do Not Disturb on in GHL; skipped and never texted`, L.id); await move(L, 'OPTED_OUT');
        }
      } else if (/landline|invalid|not a valid|cannot be sent|not sms capable/i.test(e.message)) {
        L.status = 'bad_number'; ev('info', `${L.name}: number can't get texts; skipped`, L.id); await move(L, 'BAD_NUMBER');
      } else {
        d.errors++; ev('error', `Send failed for ${L.name}: ${e.message}`, L.id);
        L.sendFails = (L.sendFails || 0) + 1; if (L.sendFails >= 2) { L.status = 'send_failed'; ev('warn', `Gave up on ${L.name} after 2 failed sends`, L.id); }
        S.nextSendAt = t + 5 * 60e3; // back off before the next try
        if (d.errors >= 5) pause('5 send errors in a row. Check the number/A2P status in GHL, then resume.');
      }
    }
    save(); return true;
  }

  async function classify(L, text) {
    if (!env.ANTHROPIC_API_KEY) return { intent: 'other', reply: '' };
    try {
      const out = await askClaude(env, {
        system: `IMPORTANT: our first text asked them a simple question, like "do you guys have a website?", "is this the right number for X?", "who handles your website?" or "where do you send people to see your work?". Plain answers to that question such as "yes", "no", "nope", "not yet", "we don't", "me", "who's asking?", "Facebook", "why?" or "yes I do" are NOT rejections: classify them as "interested" (an opening, the sample link goes out next). Only clear rejections ("not interested", "all set", "don't need one", "leave me alone") are "not_interested".
You triage replies to a cold text. SENDER: ${L.brand === 'zw' ? "Zander's Websites (Zander, age 7, with his dad Zac helping)" : 'Zac from Revenue Generating Solutions'}, who offered a local trade business a free sample website. Return ONLY JSON: {"intent": one of "ready_to_buy","interested","price","question","objection","not_interested","wrong_person","asks_if_bot","other","plan": one of "starter","annual","monthly_seo","reply": string}. Use "ready_to_buy" ONLY when they clearly say they want to go ahead and pay or sign up (e.g. "let's do it", "how do I sign up", "send me the link to pay", "I'll take it"); a yes to seeing the sample, a maybe, or a question is NOT ready_to_buy. "plan": "annual" only if they chose paying the year up front, "monthly_seo" only if they asked for the SEO add-on, otherwise "starter". For ready_to_buy set "reply" to "". MAKE THE OFFER: once we have already sent them the sample link, if they react with anything positive or neutral (looks good, nice, how does it work, what now, ok, a question about it), the reply must make the offer in plain words from OFFER (no setup fee, nothing down, first month free, then the monthly, cancel anytime) and end by asking if they want the link to get it live. Do not wait for them to ask the price. "reply" is a short friendly plain-ASCII text from Zac (max 220 chars, no emoji) or "" if no reply should be sent. Rules: never state any price or timeline unless it appears in OFFER below; if price is asked and OFFER is empty, reply that you'll grab the details and text right back; never promise anything not in OFFER; if they ask whether this is a bot/automated/AI, intent "asks_if_bot" and reply ""; if not_interested/wrong_person, reply "" ; keep the sender's casual local voice; never mention the other brand.\nOFFER: ${(L.brand === 'zw' ? S.settings.offerZw : [S.settings.offer, VARIANTS[L.variant]?.offer].filter(Boolean).join(' ')) || '(none)'}${learnBlock(['replies', 'triage'], true)}`,
        user: `Business: ${L.name}\nOur text: ${L.msg}\n${L.linkSent ? 'We already sent them the sample link.' : 'We have not sent the link yet; a separate message with the link is sent automatically, so your reply must NOT include a link.'}\nTheir reply: ${text}`, maxTokens: 1000,
      }, fetchImpl);
      day().spend += COST.triage;
      const j = JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
      return { intent: String(j.intent || 'other'), plan: String(j.plan || 'monthly'), reply: ascii(j.reply || '').slice(0, 300) };
    } catch (e) { ev('warn', `triage failed: ${e.message}`, L.id); return { intent: 'other', reply: '' }; }
  }

  async function alertZac(text) {
    if (/^PAID/.test(text)) { try { await deps.notify?.({ title: '💰 New client', body: text.slice(0, 180), url: '/' }); } catch {} }
    if (!env.ALERT_CONTACT_ID) return;
    try { await sendSms(env, env.ALERT_CONTACT_ID, ascii(text).slice(0, 300), fetchImpl); } catch (e) { ev('warn', `alert failed: ${e.message}`); }
  }

  // ---------- Learning: Zac's takeovers + stage changes + what got replies/sales become lessons ----------
  const LRN = () => (load().learn ||= { lessons: [], corrections: [], removed: [], lastRun: 0, lastRunDate: '', runs: 0, summary: '', studied: 0 });
  function record(kind, L, data) {
    const X = LRN(); X.corrections.unshift({ at: now().toISOString(), kind, id: L.id, name: L.name, brand: brandOf(L), ...data });
    X.corrections.length = Math.min(X.corrections.length, 300);
  }
  // Studied lessons only steer the bot once there is enough data to trust; lessons Zac types in apply right away.
  const LEARN_MIN = { texts: 75, replies: 10 };
  const learnData = () => { const ls = Object.values(load().leads).filter((L) => !L.test && L.firstSentAt); return { texts: ls.length, replies: ls.filter((L) => L.replies.some((r) => !r.bot && !r.me)).length }; };
  const studyLive = () => { const d = learnData(); return d.texts >= LEARN_MIN.texts && d.replies >= LEARN_MIN.replies; };
  const lessonsFor = (...areas) => LRN().lessons.filter((x) => areas.includes(x.area) && (x.source === 'zac' || studyLive())).map((x) => `- ${x.text}`).join('\n');
  const examples = (n = 8) => !studyLive() ? '' : LRN().corrections.filter((c) => ['takeover', 'edit', 'feedback'].includes(c.kind) && c.zac).slice(0, n)
    .map((c) => c.kind === 'edit' || c.kind === 'feedback' ? `They said: "${(c.theySaid || '').slice(0, 140)}" -> the bot ${c.kind === 'edit' ? 'drafted' : 'sent'} "${(c.botSaid || '').slice(0, 160)}" -> Zac changed it to: "${c.zac.slice(0, 200)}"` : `They said: "${(c.theySaid || '').slice(0, 140)}" -> Zac replied: "${c.zac.slice(0, 200)}"`).join('\n');
  const learnBlock = (areas, withExamples) => {
    const l = lessonsFor(...areas), e = withExamples ? examples() : '';
    if (!l && !e) return '';
    return `\n\nLEARNED FROM ZAC'S REAL CONVERSATIONS (follow these, but they never override the hard rules above${withExamples ? ', and never copy a price or promise from an example unless it is in OFFER' : ''}):\n${l}${e ? `\nHow Zac himself answered when he stepped in (match this voice):\n${e}` : ''}`;
  };
  async function transcript(L) {
    let msgs = null;
    if (L.contactId && env.GHL_TOKEN) { try { msgs = await getThread(env, L.contactId, fetchImpl); } catch { msgs = null; } }
    const mine = new Set(L.replies.filter((r) => r.me).map((r) => r.text.trim()));
    const bot = new Set([L.msg, L.zwMsg, ...L.replies.filter((r) => r.bot).map((r) => r.text), linkMessage(L, L.url, L.brand), templateMessage(L, L.url, 1), templateMessage(L, L.url, 2)].filter(Boolean).map((t) => String(t).trim()));
    if (!msgs) { msgs = []; if (L.msg) msgs.push({ text: L.msg, out: true }); for (const r of L.replies) msgs.push({ text: r.text, out: !!(r.bot || r.me) }); }
    return msgs.map((m) => `${!m.out ? 'THEM' : mine.has(m.text.trim()) ? 'ZAC' : bot.has(m.text.trim()) || /^(Figured!|Awesome! Here's the link|Yay!!)/.test(m.text) ? 'BOT' : 'ZAC'}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  }
  async function learnNow(why = 'scheduled') {
    const X = LRN();
    const cases = Object.values(S.leads).filter((L) => !L.test && L.contactId && (L.replies.length || L.manual || L.paid))
      .sort((a, b) => lastAt(b) - lastAt(a)).slice(0, 40);
    if (!cases.length && !X.corrections.length) { X.lastRun = now().getTime(); X.lastRunDate = etParts(now()).date; save(); return { ok: true, lessons: X.lessons.length, note: 'No conversations yet to learn from.' }; }
    const blocks = [];
    for (const L of cases) {
      const st = derivedStage(L) || {};
      blocks.push(`### ${L.name} (${L.trade || 'trade'}, ${L.town || ''}) brand=${brandOf(L)} opener=${OPENERS[L.opener]?.label || '-'} outcome=${L.paid ? 'PAID ' + L.paid.plan : L.status}/${st.stage || ''} lastIntent=${L.lastIntent || '-'}${L.manual ? ' ZAC_TOOK_OVER' : ''}\n${await transcript(L)}`);
    }
    const m = metrics();
    const opens = Object.entries(m.byOpener || {}).map(([k, v]) => `${k}: ${v.texted} texted, ${v.replied} replied, ${v.interested} interested, ${v.won} won`).join('\n');
    const corr = X.corrections.slice(0, 60).map((c) => c.kind === 'takeover' ? `TAKEOVER ${c.name}: they said "${(c.theySaid || '').slice(0, 120)}"${c.botSaid ? `, bot had said "${c.botSaid.slice(0, 120)}"` : ''}, Zac wrote "${(c.zac || '').slice(0, 200)}"`
      : c.kind === 'edit' ? `EDIT ${c.name}: they said "${(c.theySaid || '').slice(0, 120)}", bot drafted "${(c.botSaid || '').slice(0, 160)}", Zac changed it to "${(c.zac || '').slice(0, 200)}"`
      : c.kind === 'feedback' ? `FEEDBACK ${c.name}: bot sent "${(c.botSaid || '').slice(0, 160)}"${c.zac ? `, Zac would have said "${c.zac.slice(0, 200)}"` : ''}${c.note ? `, note: ${c.note.slice(0, 200)}` : ''}`
      : c.kind === 'approve' ? `APPROVED AS-IS ${c.name}: they said "${(c.theySaid || '').slice(0, 100)}", bot reply "${(c.botSaid || '').slice(0, 140)}"`
      : c.kind === 'stage' ? `STAGE ${c.name}: Zac moved ${c.from || '?'} -> ${c.to} (bot had classified "${c.intent || '-'}")` : `${c.kind.toUpperCase()} ${c.name}${c.note ? ': ' + c.note : ''}`).join('\n');
    const out = await askClaude(env, {
      model: WRITER(), maxTokens: 4000,
      system: `You coach an SMS sales bot that sells websites to local New England trade businesses for Zac (brand RGS: build + monthly care; brand Zander's Websites: $20/mo run by his 7-year-old son). Zac is the expert closer. Study the real conversations, the bot drafts Zac edited, approved or cancelled before they went out (edits are the strongest signal of what he wants), Zac's own takeovers (lines marked ZAC are him; BOT is the bot) and his manual stage corrections, plus which openers got replies and sales. Write the playbook the bot should follow from now on.

Learn mostly from: what Zac wrote when he stepped in (his wording, order, how he handles price and objections), where the bot misread a reply (Zac moved the stage), what first texts got answers, and what led to payment. Ignore one-off noise. Prefer specific, testable rules over vague advice ("When they ask 'how much', give the monthly number first and ask if they want the link" beats "be helpful").

Hard rules the bot keeps no matter what, so never write a lesson against them: no price, cost, 'free' or offer in an RGS first text; first texts stay under 150 characters with one question and no link; never invent facts or prices that are not in the offer; STOP/opt-outs are always honored; never mention the other brand; never claim to be human if asked if it is a bot. Do not repeat any of these rejected lessons: ${JSON.stringify(X.removed.slice(0, 30))}.

Areas: "first_text" (how to write the opening text), "replies" (how to answer after they reply: wording, handling price/objections/questions, when to send links), "triage" (how to read replies: what counts as interested, a no, ready to buy).
The system already A/B tests the opener frameworks and shifts traffic to the winner once each has 20+ sends, so never write a lesson that tells it to always use one opener; first_text lessons should be about wording that works inside any opener. Do not draw a rule from a single conversation unless it is something Zac himself clearly did on purpose. If there is little data, return fewer lessons; it is fine to return 2. Max 12 lessons, each one sentence under 170 characters, plain ASCII.
Return ONLY JSON: {"summary": "2-3 plain sentences on what is working and what is not, with numbers", "lessons": [{"area": "...", "text": "...", "evidence": "short: which leads/numbers"}]}`,
      user: `OPENER RESULTS:\n${opens || '(none yet)'}\n\nZAC'S CORRECTIONS (newest first):\n${corr || '(none yet)'}\n\nCURRENT LESSONS:\n${X.lessons.map((x) => `[${x.area}${x.source === 'zac' ? ', taught by Zac' : ''}] ${x.text}`).join('\n') || '(none)'}\n\nCONVERSATIONS (newest first):\n${blocks.join('\n\n') || '(none)'}`,
    }, fetchImpl);
    day().spend += 0.25;
    const jm = out.match(/\{[\s\S]*\}/); const j = JSON.parse(jm ? jm[0] : '{}');
    const fresh = (Array.isArray(j.lessons) ? j.lessons : []).filter((x) => ['first_text', 'replies', 'triage'].includes(x.area) && x.text)
      .slice(0, 12).map((x, i) => ({ id: `s${now().getTime().toString(36)}${i}`, area: x.area, text: ascii(x.text).slice(0, 200), evidence: ascii(x.evidence || '').slice(0, 160), source: 'study', at: now().toISOString() }))
      .filter((x) => !X.removed.includes(x.text));
    X.lessons = [...X.lessons.filter((x) => x.source === 'zac'), ...fresh];
    X.summary = ascii(j.summary || '').slice(0, 600); X.lastRun = now().getTime(); X.lastRunDate = etParts(now()).date; X.runs++; X.studied = cases.length;
    ev('info', `AI studied ${cases.length} conversations and ${X.corrections.length} of your changes (${why}): ${fresh.length} lessons`);
    save(); return { ok: true, lessons: X.lessons.length };
  }
  function learnView() {
    const X = LRN();
    return { live: studyLive(), data: learnData(), min: LEARN_MIN, summary: X.summary, lessons: X.lessons, lastRun: X.lastRun, runs: X.runs, studied: X.studied,
      takeovers: X.corrections.filter((c) => c.kind === 'takeover').length, edits: X.corrections.filter((c) => ['edit', 'cancel', 'feedback'].includes(c.kind)).length, approvals: X.corrections.filter((c) => c.kind === 'approve').length, stageFixes: X.corrections.filter((c) => c.kind === 'stage').length,
      recent: X.corrections.slice(0, 8).map(({ at, kind, name, theySaid, zac, from, to }) => ({ at, kind, name, theySaid, zac, from, to })) };
  }
  function teach(text) {
    const t = ascii(String(text || '')).trim().slice(0, 200); if (t.length < 5) throw new Error('write the lesson in a sentence');
    const area = /first text|opener|opening/i.test(t) ? 'first_text' : /classif|counts as|means they|treat .* as/i.test(t) ? 'triage' : 'replies';
    LRN().lessons.unshift({ id: `z${now().getTime().toString(36)}`, area, text: t, source: 'zac', at: now().toISOString() });
    ev('info', `You taught the AI: "${t.slice(0, 80)}"`); save(); return learnView();
  }
  function forget(id) {
    const X = LRN(); const x = X.lessons.find((l) => l.id === id); if (!x) throw new Error('lesson not found');
    X.lessons = X.lessons.filter((l) => l !== x); if (x.source === 'study') X.removed.unshift(x.text); X.removed.length = Math.min(X.removed.length, 60);
    save(); return learnView();
  }

  // Zac taps a sent AI text and says how he'd have said it / why. One small Sonnet call turns it into a rule that applies right away.
  async function feedback(id, botText, rewrite, note) {
    load(); const L = S.leads[id]; if (!L) throw new Error('lead not found');
    const b = ascii(String(botText || '')).slice(0, 600), r = ascii(String(rewrite || '')).trim().slice(0, 600), n = ascii(String(note || '')).trim().slice(0, 400);
    if (!r && !n) throw new Error('write how you would say it, or a note');
    const i = L.replies.findIndex((x) => x.text.trim() === b.trim());
    const theySaid = (i > 0 ? L.replies.slice(0, i).filter((x) => !x.bot && !x.me).slice(-1)[0]?.text : L.replies.filter((x) => !x.bot && !x.me).slice(-1)[0]?.text) || '';
    record('feedback', L, { theySaid, botSaid: b, zac: r && r !== b ? r : '', note: n });
    let rule = '', area = 'replies';
    if (env.ANTHROPIC_API_KEY) {
      try {
        const out = await askClaude(env, { maxTokens: 600, system: `Zac runs an SMS bot that texts local trade businesses about websites. He just gave feedback on one text the bot sent. Turn it into ONE short general rule the bot should follow from now on (under 170 characters, plain ASCII, written as an instruction, keep his exact wording when he gives a phrase). Decide the area: "first_text" if it is about the very first cold text, "triage" if it is about how to read their replies, otherwise "replies". Return ONLY JSON: {"area": "...", "rule": "..."}`,
          user: `Bot's first text in this thread: ${L.msg || ''}\nThey said before this: ${theySaid}\nBot sent: ${b}\n${r && r !== b ? `Zac would have sent: ${r}\n` : ''}${n ? `Zac's note: ${n}` : ''}` }, fetchImpl);
        day().spend += COST.triage;
        const j = JSON.parse((out.match(/\{[\s\S]*\}/) || ['{}'])[0]); rule = ascii(j.rule || '').slice(0, 200); if (['first_text', 'triage', 'replies'].includes(j.area)) area = j.area;
      } catch (e) { ev('warn', `could not turn feedback into a rule: ${e.message}`, L.id); }
    }
    if (!rule) rule = n || `Prefer Zac's wording: "${r.slice(0, 150)}"`;
    if (b === L.msg && area === 'replies') area = 'first_text';
    const X = LRN(); X.lessons.unshift({ id: `f${now().getTime().toString(36)}`, area, text: rule, evidence: `Your feedback on ${L.name}`, source: 'zac', at: now().toISOString() });
    ev('info', `You gave feedback on ${L.name}; learned: "${rule.slice(0, 90)}"`, L.id); save();
    return { rule, area };
  }

  // Called by the GHL webhook when a prospect replies.
  async function handleInbound({ contactId, text }) {
    load();
    const id = S.byContact[contactId]; const L = id && S.leads[id];
    if (!L) return { ignored: true };
    const body = String(text || '').slice(0, 1000);
    L.replies.push({ at: now().toISOString(), text: body }); day().replies++; L.unread = true; clearCall(L);
    const unread = Object.values(S.leads).filter((x) => x.unread || x.needsYou).length;
    try { await deps.notify?.({ title: `${ownerOf(L) === 'you' ? '👤 ' : '🤖 '}${L.name}${L.brand === 'zw' ? " (Zander's)" : ''}`, body: body.slice(0, 180), id: L.id, url: `/?lead=${encodeURIComponent(L.id)}`, badge: unread }); } catch {}
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
    if (!['not_interested', 'wrong_person'].includes(c.intent)) queueCall(L, `They texted: ${body.slice(0, 120)}`);
    if (!L.linkSent && !L.manual && !SKIP_LINK.has(c.intent)) {
      // They answered the first text. RGS: reply to what they said, say who Zac is and why, and offer the sample
      // (or send it with context once they are clearly open). Never a bare link. Zander's first text already asked "can I send it?".
      const at = now().getTime() + 30e3 + Math.random() * 60e3;
      L.zwDueAt = null; L.inZwQueue = false; await move(L, 'RESPOND');
      const b = L.brand === 'zw' ? { action: 'link', text: linkMessage(L, L.url, 'zw') } : await writeBridge(L, body);
      if (b.action === 'offer') {
        L.sampleOffered = true; L.status = 'replied';
        S.pending.push({ id: L.id, at, text: b.text });
        if (c.intent === 'price' || c.intent === 'objection') { L.needsYou = true; (L.hot ||= {}).rgs = true; await alertZac(`ZW lead: ${L.name} replied "${body.slice(0, 120)}"`); }
        ev('reply', `${L.name}: "${body.slice(0, 80)}" -> introduced Zac and offered the sample`, L.id);
        save(); return { intent: c.intent, offered: true };
      }
      L.linkSent = true; L.linkSentAt = now().getTime(); L.status = 'link_sent';
      S.pending.push({ id: L.id, at, text: b.text.replace('{LINK}', L.url) });
      if (L.brand !== 'zw') c.reply = '';
      if (c.intent === 'price' || c.intent === 'objection') {
        L.needsYou = true; (L.hot ||= {})[L.brand === 'zw' ? 'zw' : 'rgs'] = true; await alertZac(`ZW lead: ${L.name} replied "${body.slice(0, 120)}"`);
        if (c.reply) S.pending.push({ id: L.id, at: now().getTime() + 120e3 + Math.random() * 60e3, text: c.reply });
      }
      ev('reply', `${L.name}: "${body.slice(0, 80)}" -> sending the sample link`, L.id);
      save(); return { intent: c.intent, link: true };
    }
    // They said yes to buying: the bot sends the right payment link itself (unless Zac already took over).
    if (c.intent === 'ready_to_buy' && L.linkSent) {
      const brand = brandOf(L); let plan = PLANS[brand][c.plan] ? c.plan : (brand === 'rgs' ? 'starter' : 'monthly');
      const V = VARIANTS[L.variant];
      if (brand === 'rgs' && plan === 'starter' && V?.plan && (!V.days || now().getTime() - (L.firstSentAt || Date.parse(L.created)) <= V.days * DAY)) plan = V.plan;
      L.zwDueAt = null; L.inZwQueue = false; L.needsYou = true; (L.hot ||= {})[brand] = true; L.status = 'hot';
      await move(L, 'RESPOND_YES');
      const already = (L.payLinks || []).find((k) => k.brand === brand && k.plan === plan);
      if (!L.manual && stripeKey(env, brand) && !already) {
        try {
          const link = await createPaymentLink(env, brand, plan, L, fetchImpl);
          (L.payLinks ||= []).push({ ...link, plan, brand, at: now().toISOString(), byBot: true });
          const text = brand === 'zw' ? `Yay!! Here's the link to sign up: ${link.url} Thank you so much!` : `Awesome! Here's the link to get set up: ${link.url} Once that goes through I'll get your site live and text you.`;
          S.pending.push({ id: L.id, at: now().getTime() + 45e3 + Math.random() * 45e3, text: ascii(text) });
          ev('reply', `${L.name} wants to buy -> sending the ${PLANS[brand][plan].label} payment link`, L.id);
          await alertZac(`ZW: ${L.name} said "${body.slice(0, 80)}". Bot sent the ${PLANS[brand][plan].label} payment link.`);
        } catch (e) { ev('error', `Could not make payment link for ${L.name}: ${e.message}`, L.id); await alertZac(`ZW lead READY TO BUY: ${L.name} said "${body.slice(0, 100)}" (payment link failed, send it from the Inbox)`); }
      } else await alertZac(`ZW lead READY TO BUY: ${L.name} said "${body.slice(0, 100)}"`);
      try { await addTags(env, contactId, ['zw-hot'], fetchImpl); } catch {}
      save(); return { intent: c.intent, payLink: true };
    }
    const rgs = L.brand !== 'zw';
    if (rgs && c.intent === 'objection' && !L.zwSentAt) L.zwDueAt = now().getTime() + S.settings.zwDelayDays * DAY; // Zac gets a shot first; Zander follows if it goes nowhere
    if (['interested', 'price', 'ready_to_buy'].includes(c.intent)) { L.zwDueAt = null; L.inZwQueue = false; }
    const hot = ['ready_to_buy', 'interested', 'price', 'objection', 'asks_if_bot', 'other', 'question'].includes(c.intent);
    if (c.intent === 'not_interested') {
      L.status = 'closed';
      if (rgs && !L.zwSentAt) { await toZander(L); ev('info', `${L.name} said no to RGS; moved to Zander's Websites`, L.id); }
      else await move(L, 'NOT_INTERESTED');
    } else if (c.intent === 'wrong_person') {
      L.status = 'closed'; L.zwDueAt = null; L.inZwQueue = false; await move(L, rgs ? 'BAD_NUMBER' : 'NOT_INTERESTED');
    } else if (hot) {
      L.status = 'hot'; L.needsYou = true; (L.hot ||= {})[L.brand === 'zw' ? 'zw' : 'rgs'] = true;
      await move(L, ['interested', 'price'].includes(c.intent) ? 'RESPOND_YES' : 'RESPOND');
      try { await addTags(env, contactId, ['zw-hot'], fetchImpl); } catch {}
      await alertZac(`ZW lead: ${L.name} replied "${body.slice(0, 120)}"`);
    }
    const queued = !!(c.reply && !L.manual && L.botReplies < S.settings.maxBotReplies);
    if (queued) { S.pending.push({ id: L.id, at: now().getTime() + 45e3 + Math.random() * 75e3, text: c.reply }); L.botReplies++; }
    ev('reply', `${L.name}: "${body.slice(0, 80)}" -> ${c.intent}${queued ? ' (auto-reply queued)' : L.manual ? ' (yours, bot stays quiet)' : ''}`, L.id);
    save(); return { intent: c.intent };
  }

  async function flushPending(testOnly = false) {
    load(); const t = now().getTime();
    for (const p of [...S.pending]) {
      if (testOnly && !S.leads[p.id]?.test) continue;
      if (p.at > t || (!S.leads[p.id]?.test && !canReplyNow(now()))) continue;
      p.firstDue ||= p.at;
      if (!p.approved && (S.leads[p.id]?.viewingUntil || 0) > t && t - p.firstDue < 10 * 60e3) continue; // Zac has the thread open: wait for him (max 10 min)
      S.pending = S.pending.filter((x) => x !== p);
      const L = S.leads[p.id]; if (!L || L.status === 'opted_out' || !room(segments(p.text) * COST.sms)) continue;
      try { await sendSms(env, L.contactId, p.text, fetchImpl, L.brand === 'zw' ? env.GHL_FROM_NUMBER_ZW : (env.GHL_FROM_NUMBER_RGS || env.GHL_FROM_NUMBER)); day().spend += segments(p.text) * COST.sms; L.replies.push({ at: now().toISOString(), text: p.text, bot: true, ...(p.edited ? { edited: true } : {}) }); ev('send', `${p.edited ? 'Sent your edit to' : p.approved ? 'You approved the reply to' : 'Auto-replied to'} ${L.name}`, L.id); }
      catch (e) { ev('error', `Auto-reply failed for ${L.name}: ${e.message}`, L.id); }
      save();
    }
  }

  // "To call" list: warm leads that went quiet after replying, and cold leads that ignored all 3 RGS texts
  // (flagged 2 days after the last follow-up, before they move to Zander's). Cleared by a reply, a call, a stage change or Dismiss.
  const DONE_ST = ['opted_out', 'won', 'closed', 'bad_number', 'duplicate', 'landline'];
  function callScan() {
    const t = now().getTime(); let n = 0;
    for (const L of Object.values(S.leads)) {
      if (L.test || !L.contactId || L.toCall || DONE_ST.includes(L.status) || brandOf(L) === 'zw') continue;
      const ins = L.replies.filter((r) => !r.bot && !r.me), lastIn = ins.length ? Date.parse(ins.at(-1).at) : 0;
      const lastOut = Math.max(L.lastSentAt || 0, ...L.replies.filter((r) => r.bot || r.me).map((r) => Date.parse(r.at) || 0));
      if (L.callFlaggedFor === lastOut) continue;
      let why = '';
      if (ins.length && lastOut > lastIn && t - lastOut >= S.settings.callWarmDays * DAY && !S.pending.some((p) => p.id === L.id))
        why = L.linkSent ? `Saw the sample site, quiet for ${Math.floor((t - lastOut) / DAY)} days` : `Replied, then quiet for ${Math.floor((t - lastOut) / DAY)} days`;
      else if (S.settings.callCold && L.status === 'sent' && !ins.length && L.step === 3 && t - L.lastSentAt >= 2 * DAY)
        why = "No reply to 3 texts (goes to Zander's in 2 days)";
      if (why) { L.toCall = { at: new Date(t).toISOString(), why }; L.callFlaggedFor = lastOut; n++; ev('info', `To call: ${L.name} (${why})`, L.id); }
    }
    const e = etParts(now()), list = Object.values(S.leads).filter((L) => L.toCall);
    if (list.length && e.hour >= 9 && e.hour < 11 && S.callPushDate !== e.date) {
      S.callPushDate = e.date;
      deps.notify?.({ title: `📞 ${list.length} lead${list.length > 1 ? 's' : ''} to call today`, body: list.slice(0, 4).map((L) => L.name).join(', '), url: '/?f=call' })?.catch?.(() => {});
    }
    if (n) save();
  }
  function clearCall(L, why) { if (L?.toCall) { L.toCall = null; if (why) ev('info', `${L.name} off the call list (${why})`, L.id); } }
  function dismissCall(id) { load(); const L = S.leads[id]; if (!L) throw new Error('lead not found'); clearCall(L, 'dismissed'); save(); return { ok: true }; }

  // Auto-call: a hot reply or a sample-site open rings Zac's cell through GHL, with a whisper saying who and why.
  // One call at a time (90s apart), 8am-8pm ET, at most one auto-call per lead per hour.
  function queueCall(L, why) {
    if (!S.settings.autoCall || L.test || !L.contactId || ['opted_out', 'won', 'bad_number', 'duplicate'].includes(L.status)) return;
    if (now().getTime() - (L.autoCallAt || 0) < 3600e3 || (S.callQueue ||= []).some((q) => q.id === L.id)) return;
    S.callQueue.push({ id: L.id, why: ascii(why).slice(0, 170), at: now().getTime() });
  }
  async function runCallQueue() {
    const q = S.callQueue || []; if (!q.length) return;
    const t = now().getTime(), e = etParts(now());
    S.callQueue = q.filter((x) => t - x.at < 20 * 60e3); // stale after 20 min
    if (e.hour < 8 || e.hour >= 20 || t - (S.lastAutoCall || 0) < 90e3 || !S.callQueue.length) return;
    const x = S.callQueue.shift(); const L = S.leads[x.id]; if (!L) return;
    const name = shortName(L.name);
    try {
      await callLead(L.id, `${name}${L.trade ? ', ' + L.trade : ''}${L.town ? ' in ' + L.town.split(',')[0] : ''}. ${x.why}. Press any key to connect.`);
      L.autoCallAt = S.lastAutoCall = t;
      try { await deps.notify?.({ title: `📞 Calling you: ${name}`, body: x.why, id: L.id, url: `/?lead=${encodeURIComponent(L.id)}` }); } catch {}
      await alertZac(`Calling you now: ${name}${L.town ? ' (' + L.town.split(',')[0] + ')' : ''}. ${x.why}`);
    } catch (err) { ev('warn', `auto-call to ${L.name} failed: ${err.message}`, L.id); }
    save();
  }
  // Sample site opened (server filters bots, link previews and Zac's own views).
  function siteView(slug) {
    load(); const t = now().getTime();
    const L = Object.values(S.leads).find((x) => !x.test && ((x.url || '').includes(slug) || (x.zwUrl || '').includes(slug)));
    if (!L) return;
    const sentAt = L.linkSentAt || 0;
    if (sentAt && t - sentAt < 90e3) return; // the texting app fetching a link preview
    L.views = (L.views || 0) + 1; L.lastViewAt = t;
    if (t - (L.viewAlertAt || 0) > 3 * 3600e3) {
      L.viewAlertAt = t; ev('reply', `👀 ${L.name} opened their sample site`, L.id);
      try { deps.notify?.({ title: `👀 ${shortName(L.name)} is looking at their site`, body: 'Opened the sample just now. Good time to call.', id: L.id, url: `/?lead=${encodeURIComponent(L.id)}` })?.catch?.(() => {}); } catch {}
      queueCall(L, 'They are looking at their sample site right now');
    }
    save();
  }

  // The carrier rejected our text (landline / can't receive SMS): no more texts, but it's a real business phone, so call it.
  function markLandline(L) {
    L.status = 'landline'; L.dnd = false; L.landline = true; L.zwDueAt = null; L.inZwQueue = false;
    S.optOut = S.optOut.filter((p) => p !== L.phone);
    L.toCall = { at: now().toISOString(), why: "Landline: texts can't reach them, call instead" };
    ev('info', `${L.name} is a landline (texts can't reach it); added to your call list`, L.id);
  }
  async function fixCarrierDnd() { // one-time: leads wrongly marked opted out when it was really a landline
    for (const L of Object.values(S.leads)) {
      if (!L.dnd || L.landline || !L.contactId) continue;
      try { if (isCarrierDnd(await getContact(env, L.contactId, fetchImpl))) markLandline(L); else L.dndChecked = true; } catch { continue; }
    }
  }

  // They got the sample link and went quiet: one text that actually makes the offer (once, RGS only, bot-owned threads).
  function offerNudge() {
    const t = now().getTime();
    for (const L of Object.values(S.leads)) {
      if (L.test || L.offerNudged || !L.linkSent || L.manual || brandOf(L) !== 'rgs' || DONE_ST.includes(L.status) || L.paid) continue;
      const sentAt = L.linkSentAt || Math.max(0, ...L.replies.filter((r) => r.bot && /\/s\//.test(r.text)).map((r) => Date.parse(r.at) || 0));
      if (!sentAt || t - sentAt < 20 * 3600e3 || t - sentAt > 6 * DAY) continue;
      if (L.replies.some((r) => !r.bot && !r.me && Date.parse(r.at) > sentAt) || S.pending.some((p) => p.id === L.id)) continue;
      L.offerNudged = true;
      S.pending.push({ id: L.id, at: t, text: ascii(`Did you get a chance to look at the site? I can have it live this week. No setup fee, first month is free, then $99/mo and you can cancel anytime. Want me to send the link to get it going?`) });
      ev('info', `Offer follow-up queued for ${L.name} (saw the sample, no reply)`, L.id); save(); return;
    }
  }

  async function tick() {
    if (busy) return; busy = true;
    try {
      load();
      await pollPayments();
      try { callScan(); } catch (e) { ev('warn', `call list scan failed: ${e.message}`); }
      try { await runCallQueue(); } catch (e) { ev('warn', `call queue: ${e.message}`); }
      { const X = LRN(), e = etParts(now()); if (env.ANTHROPIC_API_KEY && e.hour >= 2 && e.hour < 6 && X.lastRunDate !== e.date) { try { await learnNow('nightly'); } catch (err) { X.lastRunDate = e.date; ev('warn', `learning run failed: ${err.message}`); } } }
      if (S.settings.mode === 'off' || S.paused) { if (S.pending.some((p) => S.leads[p.id]?.test)) await flushPending(true); return; }
      await flushPending();
      if ((S.msgVersion || 1) < 2) { // offer split test + customer-first copy: rewrite queued drafts
        for (const x of Object.values(S.leads)) if (x.status === 'drafted' && !x.test) { x.variant ||= nextVariant(); x.why = ''; x.writes = 0; }
        S.msgVersion = 2; save();
      }
      if (S.msgVersion < 3) { // short question-led openers, no cost in the first text
        for (const x of Object.values(S.leads)) if (x.status === 'drafted' && !x.test) { x.opener ||= nextOpener(); x.why = ''; x.writes = 0; }
        S.msgVersion = 3; save();
      }
      if (S.msgVersion < 4) { // opener frameworks: re-spread queued drafts over all openers
        for (const x of Object.values(S.leads)) if (x.status === 'drafted' && !x.test) { x.opener = nextOpener(); x.why = ''; x.writes = 0; }
        S.msgVersion = 4; save();
      }
      if (S.msgVersion < 5) { // new RGS offer: nothing down, first month free, then $99/mo
        if (/website build \$497 one time/.test(S.settings.offer || '')) S.settings.offer = DEFAULTS.offer;
        S.msgVersion = 5; save();
      }
      if (S.msgVersion < 6) { await fixCarrierDnd(); S.msgVersion = 6; save(); }
      offerNudge();
      // supply: keep a small buffer of drafts, top up leads with a daily search batch
      const drafted = Object.values(S.leads).filter((L) => L.status === 'drafted').length;
      const cap = effCap(), d = day();
      const stale = Object.values(S.leads).some((L) => L.status === 'drafted' && !L.test && (!L.researched || (!L.why && (L.writes || 0) < 4)));
      if (stale || drafted < Math.min(5, cap - d.texts)) { if (await draftOne()) return; }
      if (deps.readyCount(new Set(Object.keys(S.leads)), new Set(S.optOut)) < 15 && d.searches < 60 && !deps.jobRunning() && room(60 * COST.search) && env.GOOGLE_PLACES_KEY) {
        if (deps.startFind(60)) { d.searches += 60; d.spend += 60 * COST.search; ev('search', 'Started a 60-search batch to find more leads'); save(); }
      }
      if (S.settings.mode === 'auto' && ghlReady() && canSendNow(now(), 'MA') && now().getTime() >= S.nextSendAt) await sendOne();
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
    if (s.callWarmDays != null && Number.isFinite(+s.callWarmDays)) n.callWarmDays = Math.min(14, Math.max(1, Math.round(+s.callWarmDays)));
    if (typeof s.callCold === 'boolean') n.callCold = s.callCold;
    if (typeof s.autoCall === 'boolean') n.autoCall = s.autoCall;
    save();
  }
  const resume = () => { load().paused = null; ev('info', 'Resumed by Zac'); save(); };
  const resolve = (id) => { const L = load().leads[id]; if (L) { L.needsYou = false; if (L.status === 'hot') L.status = 'handled'; save(); } };

  // ---------- working from the dashboard: inbox, stages, payments, metrics ----------
  const brandOf = (L) => (L.brand === 'zw' ? 'zw' : 'rgs');
  const lastAt = (L) => Math.max(L.lastSentAt || 0, L.zwSentAt || 0, ...L.replies.map((r) => Date.parse(r.at) || 0), L.paid ? Date.parse(L.paid.at) : 0);
  function derivedStage(L) {
    if (L.stage) return { pipe: L.pipe || brandOf(L), stage: L.stage };
    const m = { sent: 'TEXTED', link_sent: 'RESPOND', hot: 'RESPOND_YES', opted_out: 'OPTED_OUT', bad_number: 'BAD_NUMBER', won: 'WON', zw_sent: 'TEXTED', zw_no_response: 'NO_RESPONSE' };
    if (L.inZwQueue) return { pipe: 'zw', stage: 'QUEUED' };
    return m[L.status] ? { pipe: brandOf(L), stage: m[L.status] } : null;
  }
  // Who is answering this lead right now: 'ai' (bot still replies), 'you' (you took over or the bot handed off), 'done' (closed/opted out/won)
  const ownerOf = (L) => (['opted_out', 'won', 'closed', 'bad_number', 'duplicate', 'landline'].includes(L.status) ? 'done' : L.manual || L.botReplies >= S.settings.maxBotReplies ? 'you' : 'ai');
  // The open thread polls this: marks Zac as looking (bot replies wait for him) and returns what is set to send.
  const pid = () => Math.random().toString(36).slice(2, 10);
  function live(id) {
    load(); const L = S.leads[id]; if (!L) throw new Error('lead not found');
    const t = now().getTime(); L.viewingUntil = t + 25e3;
    const pend = S.pending.filter((p) => p.id === id).map((p) => { p.pid ||= pid(); p.firstDue ||= p.at; return { pid: p.pid, text: p.text, at: p.at, holding: !p.approved && t >= p.at && t - p.firstDue < 10 * 60e3, releaseAt: p.firstDue + 10 * 60e3, inWindow: canReplyNow(now()) }; });
    return { pending: pend, n: L.replies.length, owner: ownerOf(L) };
  }
  async function draftAction(id, p_id, action, text) {
    load(); const L = S.leads[id]; const p = S.pending.find((x) => x.id === id && x.pid === p_id);
    if (!L || !p) throw new Error('that reply already went out or was cancelled');
    const theySaid = L.replies.filter((r) => !r.bot && !r.me).slice(-1)[0]?.text || '';
    if (action === 'cancel') {
      S.pending = S.pending.filter((x) => x !== p);
      if (L.url && p.text.includes(L.url)) { L.linkSent = false; } else if (L.sampleOffered && !L.linkSent) L.sampleOffered = false; else if (L.botReplies > 0) L.botReplies--;
      record('cancel', L, { theySaid, botSaid: p.text, note: `cancelled the bot's reply "${p.text.slice(0, 100)}" after they said "${theySaid.slice(0, 80)}"` });
      ev('info', `You cancelled the AI's reply to ${L.name}`, L.id); save(); return live(id);
    }
    if (!canReplyNow(now())) throw new Error('Outside texting hours (8am-9pm their time). It will send when the window opens.');
    if (action === 'edit') {
      const t = ascii(String(text || '')).trim().slice(0, 600); if (!t) throw new Error('empty message');
      if (L.url && p.text.includes(L.url) && !t.includes(L.url)) L.linkSent = false;
      record('edit', L, { theySaid, botSaid: p.text, zac: t });
      p.text = t; p.edited = true;
    } else if (action === 'send') record('approve', L, { theySaid, botSaid: p.text });
    else throw new Error('unknown action');
    p.approved = true; p.at = 0; save(); await flushPending(); return live(id);
  }
  function setOwner(id, who) {
    load(); const L = S.leads[id]; if (!L) throw new Error('lead not found');
    if (who === 'you') { L.manual = true; record('takeover_flag', L, { note: `took over after they said "${(L.replies.filter((r) => !r.bot && !r.me).slice(-1)[0]?.text || '').slice(0, 100)}"` }); ev('info', `You took over ${L.name}`, L.id); }
    else if (who === 'ai') { record('handback', L, { note: 'Zac handed it back to the AI' }); L.manual = false; L.botReplies = 0; L.needsYou = false; ev('info', `Handed ${L.name} back to the AI`, L.id); }
    else throw new Error('owner must be you or ai');
    save(); return { owner: ownerOf(L) };
  }
  function leadsView() {
    load();
    return Object.values(S.leads).filter((L) => !L.test && L.contactId).map((L) => {
      const st = derivedStage(L) || { pipe: 'rgs', stage: 'TEXTED' };
      const lastIn = L.replies.filter((r) => !r.bot && !r.me).slice(-1)[0];
      return { id: L.id, name: L.name, trade: L.trade, town: L.town, phone: L.phone, brand: brandOf(L), pipe: st.pipe, stage: st.stage, status: L.status,
        needsYou: !!L.needsYou, unread: !!L.unread, owner: ownerOf(L), toCall: L.toCall?.why || '', lastAt: lastAt(L), last: lastIn?.text || '', intent: L.lastIntent || '', url: L.url || '', zwUrl: L.zwUrl || '',
        angle: L.angle || '', why: L.why || '', website: L.website || '', siteNote: siteNote(L), views: L.views || 0, lastViewAt: L.lastViewAt || 0, finished: finishedWhy(L), variant: VARIANTS[L.variant]?.label || '', paid: L.paid || null, payLinks: (L.payLinks || []).map(({ url, plan, brand, at }) => ({ url, plan, brand, at })), contactId: L.contactId };
    }).sort((a, b) => b.lastAt - a.lastAt);
  }
  async function thread(id) {
    load(); const L = S.leads[id]; if (!L) throw new Error('lead not found');
    L.unread = false; save();
    let msgs = null;
    if (L.contactId && env.GHL_TOKEN) { try { msgs = await getThread(env, L.contactId, fetchImpl); } catch (e) { ev('warn', `could not load GHL thread: ${e.message}`, L.id); } }
    if (!msgs || !msgs.length) { // fall back to what we have locally
      msgs = [];
      if (L.lastSentAt) msgs.push({ at: new Date(L.lastSentAt).toISOString(), text: L.msg, out: true });
      for (const r of L.replies) msgs.push({ at: r.at, text: r.text, out: !!(r.bot || r.me) });
    }
    const mine = new Set(L.replies.filter((r) => r.me || r.edited).map((r) => r.text.trim()));
    const aiSet = new Set([L.msg, L.zwMsg, ...L.replies.filter((r) => r.bot && !r.edited).map((r) => r.text), templateMessage(L, L.url, 1), templateMessage(L, L.url, 2)].filter(Boolean).map((t) => String(t).trim()));
    const fb = new Set(LRN().corrections.filter((c) => c.kind === 'feedback' && c.id === L.id).map((c) => (c.botSaid || '').trim()));
    msgs = msgs.map((m) => (!m.out ? m : { ...m, brand: L.zwSentAt && Date.parse(m.at) >= L.zwSentAt - 5e3 ? 'zw' : 'rgs', by: mine.has(m.text.trim()) ? 'you' : aiSet.has(m.text.trim()) ? 'ai' : 'you', feedback: fb.has(m.text.trim()) }));
    return { lead: leadsView().find((x) => x.id === id) || { id, name: L.name }, messages: msgs, plans: PLANS[brandOf(L)], stripe: !!stripeKey(env, brandOf(L)), n: L.replies.length };
  }
  async function reply(id, text) {
    load(); const L = S.leads[id]; if (!L?.contactId) throw new Error('lead has no GHL contact yet');
    const t = String(text || '').trim().slice(0, 1000); if (!t) throw new Error('empty message');
    if (L.status === 'opted_out') throw new Error('this lead opted out');
    await sendSms(env, L.contactId, t, fetchImpl, brandOf(L) === 'zw' ? env.GHL_FROM_NUMBER_ZW : (env.GHL_FROM_NUMBER_RGS || env.GHL_FROM_NUMBER));
    const theySaid = L.replies.filter((r) => !r.bot && !r.me).slice(-1)[0]?.text || '';
    const botSaid = L.replies.filter((r) => r.bot).slice(-1)[0]?.text || '';
    record('takeover', L, { theySaid, botSaid, zac: t, intent: L.lastIntent || '' });
    S.pending = S.pending.filter((p) => p.id !== L.id || /https?:/.test(p.text)); // Zac is answering: drop the bot's queued chit-chat
    L.replies.push({ at: now().toISOString(), text: t, me: true }); L.manual = true; L.needsYou = false; L.unread = false;
    day().spend += segments(t) * COST.sms; ev('send', `You replied to ${L.name}`, L.id); save(); return { ok: true };
  }
  async function setStage(id, key) {
    load(); const L = S.leads[id]; if (!L) throw new Error('lead not found');
    const pipe = derivedStage(L)?.pipe || brandOf(L);
    if (key === 'LOST_TO_ZW') { // RGS is a no: hand them to Zander's, first Zander text goes out after the usual delay
      if (L.status === 'opted_out') throw new Error('they opted out, so they never get texted again');
      if (L.zwSentAt || brandOf(L) === 'zw') throw new Error("they're already with Zander's");
      record('stage', L, { from: derivedStage(L)?.stage || '', to: 'LOST (to Zander)', intent: L.lastIntent || '' });
      L.status = 'closed'; L.needsYou = false; L.unread = false; clearCall(L); S.pending = S.pending.filter((p) => p.id !== L.id);
      await toZander(L);
      const when = new Date(L.zwDueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
      ev('info', `You marked ${L.name} not interested; Zander's texts them ${when}`, L.id); save(); return { ok: true, zwOn: when };
    }
    if (!STAGES[pipe].some(([k]) => k === key)) throw new Error('unknown stage');
    record('stage', L, { from: derivedStage(L)?.stage || '', to: key, intent: L.lastIntent || '' });
    clearCall(L);
    await move(L, key, pipe);
    if (key === 'WON') { L.status = 'won'; L.needsYou = false; L.zwDueAt = null; }
    ev('info', `Moved ${L.name} to ${STAGES[pipe].find(([k]) => k === key)[1]}`, L.id); save(); return { ok: true };
  }
  // Call from the business number: tagging the contact fires the GHL "Call Bridge" workflow for that brand,
  // which rings Zac's cell, then dials the lead from the brand's number once he presses a key.
  async function callLead(id, whisper) {
    load(); const L = S.leads[id]; if (!L?.contactId) throw new Error('lead has no GHL contact yet');
    if (L.status === 'opted_out') throw new Error('they opted out, so no calls');
    const t = now().getTime(); if (t - (L.callAt || 0) < 30e3) throw new Error('already calling, pick up your phone');
    const brand = brandOf(L), tag = brand === 'zw' ? 'zw-call-zander' : 'zw-call-me';
    const w = ascii(whisper || `${shortName(L.name)}${L.trade ? ', ' + L.trade : ''}${L.town ? ' in ' + L.town.split(',')[0] : ''}. Press any key to connect.`);
    try { await setWhisper(env, L.contactId, w, fetchImpl); } catch (e) { ev('warn', `could not set call whisper: ${e.message}`, L.id); }
    try { await removeTags(env, L.contactId, [tag], fetchImpl); } catch {}
    await addTags(env, L.contactId, [tag], fetchImpl);
    L.callAt = t; clearCall(L); ev('info', `Calling ${L.name} from the ${brand === 'zw' ? "Zander's" : 'RGS'} number (your cell rings first)`, L.id); save();
    return { ok: true, brand };
  }
  async function payLink(id, plan) {
    load(); const L = S.leads[id]; if (!L) throw new Error('lead not found');
    const brand = brandOf(L);
    const link = await createPaymentLink(env, brand, plan, L, fetchImpl);
    (L.payLinks ||= []).push({ ...link, plan, brand, at: now().toISOString() });
    ev('info', `Payment link made for ${L.name}: ${PLANS[brand][plan].label}`, L.id); save(); return { url: link.url };
  }
  async function pollPayments() {
    const t = now().getTime();
    if (t - (S.lastPayPoll || 0) < 5 * 60e3) return; S.lastPayPoll = t;
    const open = Object.values(S.leads).filter((L) => !L.paid && L.payLinks?.length).slice(0, 40);
    for (const L of open) {
      for (const k of L.payLinks) {
        let sess = null; try { sess = await paidSession(env, k.brand, k.id, fetchImpl); } catch (e) { ev('warn', `Stripe check failed: ${e.message}`, L.id); continue; }
        if (!sess) continue;
        const P = PLANS[k.brand][k.plan];
        L.paid = { at: now().toISOString(), brand: k.brand, plan: k.plan, amount: (sess.amount_total || 0) / 100, mrr: P.mrr, email: sess.customer_details?.email || '' };
        L.status = 'won'; L.needsYou = false; L.zwDueAt = null; L.inZwQueue = false; clearCall(L);
        await move(L, 'WON', k.brand);
        ev('won', `PAID: ${L.name} - ${P.label} ($${L.paid.amount.toFixed(2)} today)`, L.id);
        await alertZac(`PAID! ${L.name} signed up: ${P.label}. $${L.paid.amount.toFixed(2)} collected.`);
        break;
      }
    }
    save();
  }
  function metrics() {
    load(); const leads = Object.values(S.leads).filter((L) => !L.test);
    const inbound = (L) => L.replies.filter((r) => !r.bot && !r.me);
    const brandM = (b) => {
      const texted = leads.filter((L) => (b === 'rgs' ? L.step >= 1 : L.zwSentAt));
      const replied = texted.filter((L) => inbound(L).some((r) => (b === 'rgs' ? !L.zwSentAt || Date.parse(r.at) < L.zwSentAt : Date.parse(r.at) > L.zwSentAt)));
      const interested = leads.filter((L) => L.hot?.[b]);
      const won = leads.filter((L) => L.paid?.brand === b || (b === brandOf(L) && L.status === 'won' && !L.paid));
      const optouts = texted.filter((L) => L.status === 'opted_out' && brandOf(L) === b);
      return { texted: texted.length, replied: replied.length, interested: interested.length, won: won.length, optouts: optouts.length,
        collected: won.reduce((a, L) => a + (L.paid?.amount || 0), 0), mrr: won.reduce((a, L) => a + (L.paid?.mrr || 0), 0) };
    };
    const by = (keyFn) => {
      const m = {};
      for (const L of leads.filter((x) => x.step >= 1)) {
        const k = keyFn(L) || 'Unknown'; const r = (m[k] ||= { key: k, texted: 0, replied: 0, interested: 0, won: 0 });
        r.texted++; if (inbound(L).length) r.replied++; if (L.hot) r.interested++; if (L.paid || L.status === 'won') r.won++;
      }
      return Object.values(m).sort((a, b) => b.texted - a.texted);
    };
    const days = Object.entries(S.days).sort();
    const spend = days.reduce((a, [, v]) => a + (v.spend || 0), 0);
    const rgs = brandM('rgs'), zw = brandM('zw');
    const replies = rgs.replied + zw.replied, wins = rgs.won + zw.won;
    return { rgs, zw, byOpener: by((L) => (L.brand === 'zw' && !L.step ? null : OPENERS[L.opener]?.label || 'Before opener test')), byVariant: by((L) => (L.brand === 'zw' && !L.step ? null : VARIANTS[L.variant]?.label || 'Before split test')), byAngle: by((L) => L.angle || angleOf(L)), byTrade: by((L) => L.trade), spend,
      perReply: replies ? spend / replies : null, perWin: wins ? spend / wins : null,
      days: days.slice(-14).map(([date, v]) => ({ date, texts: v.texts || 0, replies: v.replies || 0, spend: v.spend || 0 })) };
  }

  function view() {
    load(); const d = day(); const week = Object.entries(S.days).sort().slice(-7);
    const leads = Object.values(S.leads);
    return {
      locationId: env.GHL_LOCATION_ID || '', settings: S.settings, paused: S.paused, today: d, effCap: effCap(), week: week.map(([date, v]) => ({ date, ...v })),
      needsYou: leads.filter((L) => L.needsYou).map((L) => ({ id: L.id, name: L.name, phone: L.phone, contactId: L.contactId, last: L.replies.filter((r) => !r.bot).slice(-1)[0]?.text || '', intent: L.lastIntent })),
      drafts: leads.filter((L) => L.status === 'drafted').slice(0, 8).map((L) => ({ id: L.id, name: L.name, msg: L.msg, url: L.url, why: L.why || '', variant: VARIANTS[L.variant]?.label || '', opener: OPENERS[L.opener]?.label || '' })),
      testActive: leads.some((L) => L.test), testLead: (leads.find((L) => L.test) || null) && (({ msg, url, replies, lastIntent, brand }) => ({ msg, url, replies, lastIntent, brand }))(leads.find((L) => L.test)), zwScheduled: leads.filter((L) => L.zwDueAt && !L.zwSentAt).length, counts: leads.reduce((a, L) => ((a[L.status] = (a[L.status] || 0) + 1), a), {}), events: S.events.slice(0, 40),
      setup: { claude: !!env.ANTHROPIC_API_KEY, ghl: ghlReady(), publicUrl: !!publicUrl(), stages: !!(stage('TEXTED') && stage('RESPOND_YES')), zwPipeline: zwPipe(), webhook: !!env.GHL_WEBHOOK_SECRET, alerts: !!env.ALERT_CONTACT_ID, numberRgs: !!(env.GHL_FROM_NUMBER_RGS || env.GHL_FROM_NUMBER), numberZw: !!env.GHL_FROM_NUMBER_ZW, inWindow: canSendNow(now(), 'MA') },
    };
  }
  return { tick, handleInbound, setSettings, resume, resolve, view, testSend, endTest, leadsView, thread, reply, setStage, setOwner, payLink, pollPayments, metrics, live, draftAction, feedback, callLead, dismissCall, siteView, learnNow, learnView, teach, forget, _state: () => load() };
}
