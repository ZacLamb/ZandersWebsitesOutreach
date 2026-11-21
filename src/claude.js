// Minimal Anthropic Messages API client (no SDK). Used for sample sites, text drafts and reply triage.
export async function askClaude(env, { system, user, maxTokens = 1024, model }, fetchImpl = fetch) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model || env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); continue; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  throw new Error('Anthropic: retries exhausted');
}
