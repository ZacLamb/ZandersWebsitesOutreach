// Stripe payment links, one Stripe account per brand (STRIPE_KEY_RGS, STRIPE_KEY_ZW).
// Prices are created on first use and found again by lookup_key, so nothing needs setting up by hand.
const API = 'https://api.stripe.com/v1';

export const PRICES = {
  rgs_build_497: { product: 'Website build', amount: 49700 },
  rgs_care_99: { product: 'Website hosting and care', amount: 9900, interval: 'month' },
  rgs_annual_1188: { product: 'Website hosting and care, annual (build included)', amount: 118800, interval: 'year' },
  rgs_seo_199: { product: 'Local SEO: a new local-area article every day', amount: 19900, interval: 'month' },
  zw_monthly_20: { product: "Zander's Websites monthly", amount: 2000, interval: 'month' },
};
// mrr = monthly recurring value used for revenue metrics; upfront = what they pay today
export const PLANS = {
  rgs: {
    monthly: { label: '$497 build + $99/mo', prices: ['rgs_build_497', 'rgs_care_99'], upfront: 596, mrr: 99 },
    annual: { label: '$1,188/yr, build free', prices: ['rgs_annual_1188'], upfront: 1188, mrr: 99 },
    monthly_nobuild: { label: '$99/mo, build fee waived', prices: ['rgs_care_99'], upfront: 99, mrr: 99 },
    monthly_trial: { label: '$497 build, first month free, then $99/mo', prices: ['rgs_build_497', 'rgs_care_99'], trialDays: 30, upfront: 497, mrr: 99 },
    monthly_seo: { label: '$497 build + $99/mo + daily local SEO articles $199/mo', prices: ['rgs_build_497', 'rgs_care_99', 'rgs_seo_199'], upfront: 795, mrr: 298 },
  },
  zw: { monthly: { label: '$20/mo, no setup fee', prices: ['zw_monthly_20'], upfront: 20, mrr: 20 } },
};

export const stripeKey = (env, brand) => (brand === 'zw' ? env.STRIPE_KEY_ZW : env.STRIPE_KEY_RGS) || '';

function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function sreq(key, method, path, params, fetchImpl = fetch) {
  const qs = params ? form(params) : '';
  const url = API + path + (method === 'GET' && qs ? `?${qs}` : '');
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
    body: method === 'GET' ? undefined : qs,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${j.error?.message || 'request failed'}`);
  return j;
}

const cache = new Map(); // `${key4}:${lookup}` -> price id
async function ensurePrice(key, lookup, fetchImpl) {
  const ck = `${key.slice(-6)}:${lookup}`;
  if (cache.has(ck)) return cache.get(ck);
  const found = await sreq(key, 'GET', '/prices', { 'lookup_keys[]': lookup, active: 'true', limit: 1 }, fetchImpl);
  let id = found.data?.[0]?.id;
  if (!id) {
    const def = PRICES[lookup];
    const prod = await sreq(key, 'POST', '/products', { name: def.product }, fetchImpl);
    const p = await sreq(key, 'POST', '/prices', { product: prod.id, unit_amount: def.amount, currency: 'usd', lookup_key: lookup, ...(def.interval ? { recurring: { interval: def.interval } } : {}) }, fetchImpl);
    id = p.id;
  }
  cache.set(ck, id); return id;
}

export async function createPaymentLink(env, brand, plan, lead, fetchImpl = fetch) {
  const key = stripeKey(env, brand);
  if (!key) throw new Error(`No Stripe key for ${brand === 'zw' ? "Zander's" : 'RGS'} yet (set ${brand === 'zw' ? 'STRIPE_KEY_ZW' : 'STRIPE_KEY_RGS'} in Railway)`);
  const P = PLANS[brand]?.[plan];
  if (!P) throw new Error('Unknown plan');
  const line_items = {};
  for (const [i, lk] of P.prices.entries()) line_items[i] = { price: await ensurePrice(key, lk, fetchImpl), quantity: 1 };
  const link = await sreq(key, 'POST', '/payment_links', { line_items, ...(P.trialDays ? { subscription_data: { trial_period_days: P.trialDays } } : {}), metadata: { lead_id: lead.id, brand, plan, business: lead.name.slice(0, 200) }, phone_number_collection: { enabled: 'true' } }, fetchImpl);
  return { id: link.id, url: link.url };
}

// Returns the completed checkout session for a payment link, or null if nobody has paid yet.
export async function paidSession(env, brand, linkId, fetchImpl = fetch) {
  const key = stripeKey(env, brand);
  if (!key) return null;
  const j = await sreq(key, 'GET', '/checkout/sessions', { payment_link: linkId, status: 'complete', limit: 1 }, fetchImpl);
  return j.data?.[0] || null;
}

// Health check: make sure the key works by creating the plan prices and a throwaway link, then switching the link off.
export async function checkStripe(env, brand, fetchImpl = fetch) {
  const key = stripeKey(env, brand);
  if (!key) return { ok: false, error: 'no key set' };
  try {
    const plans = Object.keys(PLANS[brand]);
    const link = await createPaymentLink(env, brand, plans[0], { id: 'stripe-check', name: 'Stripe check' }, fetchImpl);
    await sreq(key, 'POST', `/payment_links/${link.id}`, { active: 'false' }, fetchImpl);
    const tested = [plans[0]];
    for (const p of plans.slice(1)) { const l = await createPaymentLink(env, brand, p, { id: 'stripe-check', name: 'Stripe check' }, fetchImpl); await sreq(key, 'POST', `/payment_links/${l.id}`, { active: 'false' }, fetchImpl); tested.push(p); }
    return { ok: true, livemode: !/_test_/.test(key), plansTested: tested, deactivated: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
