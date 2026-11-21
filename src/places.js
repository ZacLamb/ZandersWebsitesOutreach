// Google Places API (New) text search. Needs GOOGLE_PLACES_KEY.
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.nationalPhoneNumber',
  'places.websiteUri', 'places.rating', 'places.userRatingCount', 'places.businessStatus',
  'places.googleMapsUri', 'nextPageToken',
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function searchText(query, { key, maxPages = 1, fetchImpl = fetch } = {}) {
  if (!key) throw new Error('GOOGLE_PLACES_KEY is not set');
  const out = [];
  let pageToken;
  for (let p = 0; p < maxPages; p++) {
    const body = { textQuery: query, pageSize: 20, regionCode: 'US', ...(pageToken ? { pageToken } : {}) };
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
        body: JSON.stringify(body),
      });
      if (res.status !== 429 && res.status < 500) break;
      await sleep(1000 * 2 ** attempt);
    }
    if (!res.ok) throw new Error(`Places ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    for (const x of j.places || []) {
      if (x.businessStatus && x.businessStatus !== 'OPERATIONAL') continue;
      out.push({
        placeId: x.id,
        name: x.displayName?.text || '',
        address: x.formattedAddress || '',
        phone: x.nationalPhoneNumber || '',
        website: x.websiteUri || '',
        rating: x.rating || 0,
        reviews: x.userRatingCount || 0,
        mapsUrl: x.googleMapsUri || '',
      });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) break;
    await sleep(300);
  }
  return out;
}
