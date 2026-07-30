import { cloudflareModule } from '../../modules/cloudflare'

// stiqr: the Vite/React SPA plus the two LLM proxy routes, shipped as a
// Cloudflare Worker (topology in apps/frontend/wrangler.jsonc). The module runs
// the build locally, then `wrangler deploy` uploads dist/ and the worker.
//
// CEREBRAS_API_KEY and GROQ_API_KEY are worker secrets, read from this
// environment's sops-encrypted secrets.yaml and pushed via `wrangler secret put`
// over stdin, so no value ever lands in a command line, a log, or the repo in
// plaintext. These are freshly minted keys, not the pair that was sitting in the
// Netlify dashboard; revoke that old pair once this is confirmed working.
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
    workerSecrets: ['CEREBRAS_API_KEY', 'GROQ_API_KEY'],
  },
})
