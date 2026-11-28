// GoHighLevel v2 API helpers. Stages prospects in the "50$ Sites" pipeline (stage: New Lead).
// Nothing here sends a text. Texting happens later, one tap at a time, from the new number.
const BASE = 'https://services.leadconnectorhq.com';

function headers(env) {
  return { Authorization: `Bearer ${env.GHL_TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
}

async function call(env, method, path, body, fetchImpl = fetch, version = '2021-07-28') {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchImpl(BASE + path, { method, headers: { ...headers(env), Version: version }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`GHL ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
    return json;
  }
  throw new Error(`GHL ${method} ${path}: retries exhausted`);
}

export async function findDuplicate(env, phone, fetchImpl = fetch) {
  const q = new URLSearchParams({ locationId: env.GHL_LOCATION_ID, number: `+1${phone}` });
  try {
    const j = await call(env, 'GET', `/contacts/search/duplicate?${q}`, undefined, fetchImpl);
    return j.contact || null;
  } catch (e) {
    if (/ (400|404):/.test(e.message)) return null;
    throw e;
  }
}

// Creates the contact + opportunity. Returns {status:'created'|'duplicate', contactId?}
export async function stageProspect(env, p, { tags = [], fetchImpl = fetch } = {}) {
  const phone10 = p.phone.replace(/\D/g, '').slice(-10);
  const dup = await findDuplicate(env, phone10, fetchImpl);
  if (dup) return { status: 'duplicate', contactId: dup.id };
  const contact = await call(env, 'POST', '/contacts/upsert', {
    locationId: env.GHL_LOCATION_ID,
    companyName: p.name,
    name: p.name,
    phone: `+1${phone10}`,
    website: p.website || undefined,
    address1: p.address,
    source: 'ZW Prospector',
    tags: ['zw-prospect', `zw-tier-${p.tier}`, `zw-trade-${p.trade.replace(/\s+/g, '-')}`, ...tags],
  }, fetchImpl);
  const contactId = contact.contact?.id;
  if (!contactId) throw new Error('GHL upsert returned no contact id');
  const opp = await call(env, 'POST', '/opportunities/', {
    pipelineId: env.GHL_PIPELINE_ID,
    locationId: env.GHL_LOCATION_ID,
    name: p.name,
    pipelineStageId: env.GHL_STAGE_NEW_LEAD,
    status: 'open',
    contactId,
    source: 'ZW Prospector',
  }, fetchImpl);
  return { status: 'created', contactId, opportunityId: opp.opportunity?.id || opp.id };
}

// ---- messaging + pipeline helpers used by the autopilot (src/autopilot.js) ----
export const sendSms = (env, contactId, message, fetchImpl = fetch, fromNumber = env.GHL_FROM_NUMBER) =>
  call(env, 'POST', '/conversations/messages', { type: 'SMS', contactId, message, ...(fromNumber ? { fromNumber } : {}) }, fetchImpl, '2021-04-15');
export const moveOpportunity = (env, oppId, stageId, fetchImpl = fetch, pipelineId = env.GHL_PIPELINE_ID) =>
  stageId && oppId ? call(env, 'PUT', `/opportunities/${oppId}`, { pipelineStageId: stageId, pipelineId }, fetchImpl) : null;
export const addTags = (env, contactId, tags, fetchImpl = fetch) => call(env, 'POST', `/contacts/${contactId}/tags`, { tags }, fetchImpl);
export const removeTags = (env, contactId, tags, fetchImpl = fetch) => call(env, 'DELETE', `/contacts/${contactId}/tags`, { tags }, fetchImpl);

// Full SMS thread for a contact, oldest first (includes texts sent from the GHL app).
export async function getThread(env, contactId, fetchImpl = fetch) {
  const q = new URLSearchParams({ locationId: env.GHL_LOCATION_ID, contactId });
  const s = await call(env, 'GET', `/conversations/search?${q}`, undefined, fetchImpl, '2021-04-15');
  const conv = (s.conversations || [])[0];
  if (!conv) return [];
  const m = await call(env, 'GET', `/conversations/${conv.id}/messages?limit=100`, undefined, fetchImpl, '2021-04-15');
  const list = m.messages?.messages || m.messages || [];
  return list
    .filter((x) => x.body && (!x.messageType || /SMS|TYPE_SMS/i.test(String(x.messageType))))
    .map((x) => ({ at: x.dateAdded, text: x.body, out: String(x.direction).toLowerCase() === 'outbound', status: x.status || '' }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// "ZW Whisper" contact field: what the call-bridge voice reads to Zac before connecting him.
let whisperField = null;
export async function whisperFieldId(env, fetchImpl = fetch) {
  if (whisperField) return whisperField;
  const r = await call(env, 'GET', `/locations/${env.GHL_LOCATION_ID}/customFields?model=contact`, undefined, fetchImpl);
  let f = (r.customFields || []).find((x) => /^zw whisper$/i.test(x.name) || x.fieldKey === 'contact.zw_whisper');
  if (!f) f = (await call(env, 'POST', `/locations/${env.GHL_LOCATION_ID}/customFields`, { name: 'ZW Whisper', dataType: 'TEXT', model: 'contact' }, fetchImpl)).customField;
  whisperField = f?.id || null;
  return whisperField;
}
export async function setWhisper(env, contactId, text, fetchImpl = fetch) {
  const id = await whisperFieldId(env, fetchImpl);
  if (!id) return false;
  await call(env, 'PUT', `/contacts/${contactId}`, { customFields: [{ id, field_value: String(text).slice(0, 250) }] }, fetchImpl);
  return true;
}
export const getContact = (env, contactId, fetchImpl = fetch) => call(env, 'GET', `/contacts/${contactId}`, undefined, fetchImpl).then((r) => r.contact || r);
// GHL turns SMS DND on by itself when the carrier rejects a text (30003-30006: landline / unreachable). That is not an opt-out.
export const isCarrierDnd = (c) => /TWILIO_ERROR_CODE:\s*300(03|04|05|06)|landline|unreachable/i.test(String(c?.dndSettings?.SMS?.message || ''));
