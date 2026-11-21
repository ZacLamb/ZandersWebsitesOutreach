// GoHighLevel v2 API helpers. Stages prospects in the "50$ Sites" pipeline (stage: New Lead).
// Nothing here sends a text. Texting happens later, one tap at a time, from the new number.
const BASE = 'https://services.leadconnectorhq.com';

function headers(env) {
  return { Authorization: `Bearer ${env.GHL_TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };
}

async function call(env, method, path, body, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchImpl(BASE + path, { method, headers: headers(env), body: body ? JSON.stringify(body) : undefined });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`GHL ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
    return json;
  }
  throw new Error(`GHL ${method} ${path}: retries exhausted`);
}

export async function findDuplicate(env, phone) {
  const q = new URLSearchParams({ locationId: env.GHL_LOCATION_ID, number: `+1${phone}` });
  try {
    const j = await call(env, 'GET', `/contacts/search/duplicate?${q}`);
    return j.contact || null;
  } catch (e) {
    if (/ (400|404):/.test(e.message)) return null;
    throw e;
  }
}

// Creates the contact + opportunity. Returns {status:'created'|'duplicate', contactId?}
export async function stageProspect(env, p, { tags = [] } = {}) {
  const phone10 = p.phone.replace(/\D/g, '').slice(-10);
  const dup = await findDuplicate(env, phone10);
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
  });
  const contactId = contact.contact?.id;
  if (!contactId) throw new Error('GHL upsert returned no contact id');
  await call(env, 'POST', '/opportunities/', {
    pipelineId: env.GHL_PIPELINE_ID,
    locationId: env.GHL_LOCATION_ID,
    name: p.name,
    pipelineStageId: env.GHL_STAGE_NEW_LEAD,
    status: 'open',
    contactId,
    source: 'ZW Prospector',
  });
  return { status: 'created', contactId };
}
