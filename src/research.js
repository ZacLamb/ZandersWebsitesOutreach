// Per-lead research for personalized first texts: Google reviews + a quick look at their current website.
// Everything here is facts we actually saw; the writer is told to use nothing else.

const DETAILS = 'https://places.googleapis.com/v1/places/';
const FIELDS = 'displayName,primaryTypeDisplayName,editorialSummary,rating,userRatingCount,reviews,photos,regularOpeningHours.weekdayDescriptions,formattedAddress';

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function timed(fetchImpl, url, opts = {}, ms = 7000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetchImpl(url, { ...opts, signal: ac.signal, redirect: 'follow' }); } finally { clearTimeout(t); }
}

export async function placeFacts(env, placeId, fetchImpl = fetch) {
  if (!env.GOOGLE_PLACES_KEY || !placeId || /^TEST-/.test(placeId)) return null;
  const res = await timed(fetchImpl, DETAILS + encodeURIComponent(placeId), { headers: { 'X-Goog-Api-Key': env.GOOGLE_PLACES_KEY, 'X-Goog-FieldMask': FIELDS } });
  if (!res.ok) throw new Error(`Place details ${res.status}`);
  const j = await res.json();
  return {
    category: j.primaryTypeDisplayName?.text || '',
    summary: clip(j.editorialSummary?.text, 300),
    rating: j.rating || 0,
    reviewCount: j.userRatingCount || 0,
    photoCount: (j.photos || []).length,
    hours: (j.regularOpeningHours?.weekdayDescriptions || []).join('; ').slice(0, 300),
    reviews: (j.reviews || []).slice(0, 5).map((r) => ({
      stars: r.rating, when: r.relativePublishTimeDescription || '', text: clip(r.text?.text || r.originalText?.text, 500),
    })).filter((r) => r.text),
  };
}

const BUILDERS = [['wix', /wix\.com|wixstatic/i], ['GoDaddy builder', /godaddy|secureserver|img1\.wsimg/i], ['Squarespace', /squarespace/i], ['Weebly', /weebly/i], ['WordPress', /wp-content/i], ['Facebook', /facebook\.com/i]];

export async function siteFacts(url, fetchImpl = fetch) {
  if (!url || /facebook\.com|instagram\.com|yelp\.com|google\.com/i.test(url)) return null;
  try {
    const res = await timed(fetchImpl, url, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
    const finalUrl = res.url || url;
    if (!res.ok) return { url, works: false, status: res.status };
    const html = (await res.text()).slice(0, 400000);
    const years = [...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d\d|19\d\d)/gi)].map((m) => +m[1]);
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    return {
      url, works: true,
      https: /^https:/i.test(finalUrl),
      mobileFriendly: /<meta[^>]+name=["']viewport/i.test(html),
      title: clip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1], 120),
      description: clip(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1], 200),
      copyrightYear: years.length ? Math.max(...years) : null,
      builder: (BUILDERS.find(([, re]) => re.test(html)) || [])[0] || '',
      words: text.split(/\s+/).filter(Boolean).length,
      excerpt: clip(text, 600),
    };
  } catch (e) { return { url, works: false, error: /abort/i.test(e.name + e.message) ? 'timed out' : 'did not load' }; }
}

export async function research(env, p, fetchImpl = fetch) {
  const [place, site] = await Promise.all([
    placeFacts(env, p.place_id || p.id, fetchImpl).catch(() => null),
    siteFacts(p.website, fetchImpl).catch(() => null),
  ]);
  return { place, site };
}

// Compact plain-text brief for the writer.
export function brief(p, facts = {}) {
  const { place, site } = facts;
  const L = [`Business: ${p.name}`, `Trade: ${p.trade}`, `Town: ${p.town}`];
  if (place) {
    if (place.category) L.push(`Google category: ${place.category}`);
    L.push(`Google: ${place.rating || '?'} stars from ${place.reviewCount || 0} reviews, ${place.photoCount} photos on the listing`);
    if (place.summary) L.push(`Google summary: ${place.summary}`);
    if (place.hours) L.push(`Hours: ${place.hours}`);
    place.reviews.forEach((r, i) => L.push(`Review ${i + 1} (${r.stars} stars${r.when ? ", " + r.when : ""}): ${r.text}`));
  } else L.push(`Google: ${p.rating || '?'} stars from ${p.reviews || 0} reviews`);
  if (!p.website) L.push('Website: none on their Google listing');
  else if (/facebook\.com/i.test(p.website)) L.push(`Website: their Google listing points to a Facebook page (${p.website}), no real website`);
  else if (!site) L.push(`Website: ${p.website} (not checked)`);
  else if (!site.works) L.push(`Website: ${p.website} is listed on Google but ${site.error || 'returned an error ' + site.status} when we tried it`);
  else {
    L.push(`Website: ${site.url}${site.builder ? ` (built on ${site.builder})` : ''}; ${site.https ? 'secure https' : 'NOT secure (no https)'}; ${site.mobileFriendly ? 'has mobile layout' : 'NO mobile layout, looks broken on phones'}${site.copyrightYear ? `; footer copyright ${site.copyrightYear}` : ''}; about ${site.words} words of text`);
    if (site.title) L.push(`Site title: ${site.title}`);
    if (site.excerpt) L.push(`Site text sample: ${site.excerpt}`);
  }
  return L.join('\n');
}
