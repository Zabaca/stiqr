/**
 * The Cloudflare Worker behind stiqr: a SPA plus the two LLM proxies that used to
 * be Netlify Functions.
 *
 * The proxies exist so the API keys stay server-side; the browser never sees
 * them. That was true on Netlify and stays true here.
 *
 * ## Why the paths still say `.netlify`
 *
 * The client hardcodes `/.netlify/functions/cerebras` as its production endpoint
 * (see src/services/cerebras.ts). Serving those exact paths means this Worker is
 * a drop-in for the Netlify deployment, so the DNS cutover is a pure DNS change
 * with nothing else moving at the same time, and rollback stays a one-record
 * revert. Renaming them to `/api/*` is a follow-up once the cutover has settled,
 * and it has to change the client, this file, and delete the Netlify function
 * directory in one commit.
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

interface ChatRequest {
  model?: string
  messages?: unknown[]
  temperature?: number
  max_tokens?: number
}

/** Upstreams, keyed by the path the client already calls. */
const PROXIES = {
  '/.netlify/functions/cerebras': {
    label: 'Cerebras',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    key: (env: Env) => env.CEREBRAS_API_KEY,
    model: 'llama3.1-8b',
    temperature: 0.7,
    maxTokens: 20000,
  },
  '/.netlify/functions/groq': {
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    key: (env: Env) => env.GROQ_API_KEY,
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

  const apiKey = spec.key(env)
  if (!apiKey) {
    return json({ error: 'API key not configured' }, 500)
  }

  let body: ChatRequest
  try {
    body = (await request.json()) as ChatRequest
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  try {
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
