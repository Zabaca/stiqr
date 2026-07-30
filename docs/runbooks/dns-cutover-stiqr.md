# Runbook: move stiqr.zabaca.com off Netlify

- **Status:** executed 2026-07-30
- **Blast radius:** one DNS record. No mail record is involved.

## What changed

`CNAME stiqr.zabaca.com -> stiqr.netlify.app` (proxied) became a Worker custom
domain pointing at the `stiqr` Worker. Exact prior values, for rollback, are in
[`dns-snapshot-stiqr-2026-07-30.txt`](./dns-snapshot-stiqr-2026-07-30.txt).

Nothing else in the `zabaca.com` zone was touched.

## Telling the two hosts apart

`server:` will not help. The record was **already proxied** through Cloudflare,
so Cloudflare answers either way. Use:

- `x-nf-request-id`, a response header present only on Netlify
- the bundle name in `index.html`. Netlify was serving `assets/main-CIm4GWgN.js`
  at cutover; the Worker serves `assets/main-DKs2m2RV.js`.

## How it was done

The Worker declares the hostname as a `custom_domain` route in
`apps/frontend/wrangler.jsonc`, so steady state is `zbc apply production`. The
first attach is the exception: a hostname that already has a DNS record cannot be
attached non-interactively (`code 100117`, and the API rejects
`override_existing_dns_record`), so the record was deleted immediately before the
attach. Same procedure as the zabaca.com cutover.

**Sample repeatedly before concluding anything.** For several minutes after a
deploy the edge serves old and new versions alternately. A single check told me
the cutover had not taken when it had. Convergence here was 12/12.

## Rolling back: retired, deliberately

**James decided on 2026-07-30 that the Netlify rollback is not needed.** Record
that as a decision, not an oversight: the cutover is one-way from here, and
recovering from a bad Worker deploy means fixing forward, not reverting DNS.

That call is easier to defend once you know the rollback was never as clean as it
looked. Both directions were measured, and it cut two ways at once:

- **Rolling back would have RESTORED the AI features.** Netlify still holds
  working Cerebras and Groq keys: `stiqr.netlify.app` returns real upstream
  validation errors (400), while the Worker returns 500 "API key not configured".
  A rollback was an *upgrade* in functionality, which inverts what the word
  normally means.
- **Rolling back would have BROKEN deep links.** Netlify has no SPA fallback for
  this site: no `_redirects` file exists and `netlify.toml` carries only the
  `/api/*` rule, so `stiqr.netlify.app/a/deep/link` returns 404 while the Worker
  returns 200 via `not_found_handling: single-page-application`.

So the real trade was "AI comes back, deep links break". Any runbook claiming a
clean revert would have been lying.

### If someone reverses this decision anyway

The order matters and is not guessable:

1. **Detach the Worker custom domain** for `stiqr.zabaca.com` first, via the
   Cloudflare API (`GET` then `DELETE` on
   `/accounts/$ACCOUNT/workers/domains`) or the dashboard under the Worker's
   Domains & Routes. A proxied `AAAA` placeholder at `100::` holds the record,
   and a CNAME cannot be written over it while the Worker still claims the name.
2. Recreate `CNAME stiqr.zabaca.com -> stiqr.netlify.app`, proxied, from
   [the snapshot](./dns-snapshot-stiqr-2026-07-30.txt).
3. **Remove the `routes` block from `apps/frontend/wrangler.jsonc` before anyone
   runs `zbc apply production` again.** An apply between steps 2 and 3 silently
   re-attaches the custom domain and undoes the rollback with a green checkmark.

Then fix the two asymmetries above, because neither resolves itself.

## Current state of the LLM proxies

Both return `500 "API key not configured"`. The keys were never carried over from
Netlify, deliberately: the plan is to mint fresh Cerebras and Groq keys rather
than copy the old pair, since both endpoints are unauthenticated proxies to paid
accounts. The AI features are down until that happens, which was an accepted
trade to get the cutover done.
