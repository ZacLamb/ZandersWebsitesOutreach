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
export const moveOpportunity = (env, oppId, stageId, fetchImpl = fetch) =>
  stageId && oppId ? call(env, 'PUT', `/opportunities/${oppId}`, { pipelineStageId: stageId, pipelineId: env.GHL_PIPELINE_ID }, fetchImpl) : null;
export const addTags = (env, contactId, tags, fetchImpl = fetch) => call(env, 'POST', `/contacts/${contactId}/tags`, { tags }, fetchImpl);
export const removeTags = (env, contactId, tags, fetchImpl = fetch) => call(env, 'DELETE', `/contacts/${contactId}/tags`, { tags }, fetchImpl);
