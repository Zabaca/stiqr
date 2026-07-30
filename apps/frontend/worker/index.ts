/**
 * The Cloudflare Worker behind stiqr: a SPA plus the two LLM proxies that used to
 * be Netlify Functions.
 *
 * The proxies exist so the API keys stay server-side; the browser never sees
 * them. That was true on Netlify and stays true here.
 *
 * The routes were `/.netlify/functions/*` through the cutover, so this Worker was
 * a drop-in for the Netlify deployment and the DNS flip moved one thing at a
 * time. The Netlify project was deleted on 2026-07-30, so they are now `/api/*`,
 * matching what the Vite dev proxy already used.
 *
 * ## One deliberate behaviour change
 *
 * The Netlify versions defaulted with `body.temperature || 0.7`, so a caller
 * asking for `temperature: 0` silently got 0.7. Same for `max_tokens: 0`. This
 * uses `??`, so an explicit 0 is honoured. Nothing in the client sends 0 today,
 * which is why the bug was invisible; the fix is carried over rather than the
 * bug.
 */

interface Env {
  ASSETS: Fetcher
  CEREBRAS_API_KEY?: string
  GROQ_API_KEY?: string
}

/**
 * Origins allowed to call the proxies.
 *
 * Browsers send `Origin` on every POST, including same-origin ones, so a real
 * user of the app always presents one of these. A bare `curl` presents none and
 * is refused.
 *
 * Be honest about what this buys: `curl -H 'Origin: https://stiqr.zabaca.com'`
 * walks straight through. A public SPA cannot hold a secret, so nothing enforced
 * at this layer is unforgeable. The goal is to make casual and automated abuse
 * cost something, not to make it impossible.
 *
 * NOTE: there is no rate limit here. Cloudflare's `ratelimit` binding was tried
 * and does NOT enforce on this account: wrangler registers it as "Unsafe
 * Metadata", `limit()` returns `success: true` unconditionally, and 20 parallel
 * requests against a 5-per-10-seconds config produced zero 429s. It was removed
 * rather than left in place looking like protection. Rate limiting belongs in a
 * zone-level WAF rule or a Durable Object; see docs/runbooks/dns-cutover-stiqr.md.
 */
const ALLOWED_ORIGINS = new Set([
  'https://stiqr.zabaca.com',
  'https://stiqr.james-99a.workers.dev',
])

interface ChatRequest {
  model?: string
  messages?: unknown[]
  temperature?: number
  max_tokens?: number
}

/** Upstreams, keyed by the path the client already calls. */
const PROXIES = {
  '/api/cerebras': {
    label: 'Cerebras',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    // The Cerebras original sent this explicitly; the Groq one did not.
    stream: false as boolean | undefined,
    key: (env: Env) => env.CEREBRAS_API_KEY,
    // Each original used its own wording for this. Kept verbatim rather than
    // unified, so the cutover is byte-for-byte comparable.
    missingKey: 'API key not configured',
    model: 'llama3.1-8b',
    temperature: 0.7,
    maxTokens: 20000,
  },
  '/api/groq': {
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: (env: Env) => env.GROQ_API_KEY,
    missingKey: 'Groq API key not configured',
    model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    temperature: 0.3,
    maxTokens: 2000,
  },
} as const

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

async function proxy(
  request: Request,
  env: Env,
  spec: (typeof PROXIES)[keyof typeof PROXIES],
): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const origin = request.headers.get('Origin')
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: 'Forbidden' }, 403)
  }

  const apiKey = spec.key(env)
  if (!apiKey) {
    return json({ error: spec.missingKey }, 500)
  }

  try {
    // Parsing lives inside the try on purpose: the Netlify originals parsed here
    // too, so a malformed body produces 500 "Internal server error" rather than
    // a 400. Faithful over correct, until the cutover is done.
    const body = (await request.json()) as ChatRequest

    const upstream = await fetch(spec.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: body.model ?? spec.model,
        messages: body.messages,
        temperature: body.temperature ?? spec.temperature,
        max_tokens: body.max_tokens ?? spec.maxTokens,
        ...('stream' in spec ? { stream: spec.stream } : {}),
      }),
    })

    if (!upstream.ok) {
      // Pass the upstream status and message through unchanged. The client
      // surfaces these, and the Netlify version behaved the same way.
      return json({ error: `${spec.label} API error: ${await upstream.text()}` }, upstream.status)
    }

    return json(await upstream.json(), 200)
  } catch (error) {
    console.error(`${spec.label} proxy error:`, error)
    return json({ error: 'Internal server error' }, 500)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)

    const spec = PROXIES[pathname as keyof typeof PROXIES]
    if (spec) return proxy(request, env, spec)

    return env.ASSETS.fetch(request)
  },
}
