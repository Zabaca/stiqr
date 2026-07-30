import { cloudflareModule } from '../../modules/cloudflare'

// stiqr: the Vite/React SPA plus the two LLM proxy routes, shipped as a
// Cloudflare Worker (topology in apps/frontend/wrangler.jsonc). The module runs
// the build locally, then `wrangler deploy` uploads dist/ and the worker.
//
// The two API keys are NOT wired up yet, deliberately. They live only in the
// Netlify dashboard today, and the plan is to rotate rather than copy them: mint
// fresh Cerebras and Groq keys, add them here, then revoke the old pair. Until
// that happens the proxy routes answer 500 "API key not configured", which is
// exactly what the Netlify functions did with an unset key, so the failure mode
// is familiar rather than novel.
//
// To wire them up: put CEREBRAS_API_KEY and GROQ_API_KEY in this environment's
// secrets.yaml and add `workerSecrets: ['CEREBRAS_API_KEY', 'GROQ_API_KEY']`
// below. The module pushes them via `wrangler secret put` over stdin, so no
// value ever lands in a command line or a log.
//
// ⚠️ THIS IS THE LIVE SITE. Since the 2026-07-30 cutover, applying this instance
// publishes to stiqr.zabaca.com, not just to stiqr.<subdomain>.workers.dev.
// There is no staging environment in front of it. Compare a build on the
// workers.dev URL first. Rollback: docs/runbooks/dns-cutover-stiqr.md.
export default cloudflareModule.instance({
  name: 'web',
  config: {
    workdir: 'apps/frontend',
    accountId: '99a19e584439be0568f33aad0477372b',
    build: {
      command: 'bun run build',
      cwd: '.',
    },
  },
})
