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

## Rolling back

1. Delete the Worker custom-domain attachment for `stiqr.zabaca.com`. A proxied
   `AAAA` placeholder at `100::` holds the record's place, and a CNAME cannot be
   written over it while the Worker still claims the hostname.
2. Recreate `CNAME stiqr.zabaca.com -> stiqr.netlify.app`, proxied.
3. Remove the `routes` block from `apps/frontend/wrangler.jsonc` so the next
   apply does not recreate the attachment.

The Netlify site is not deleted and keeps serving at `stiqr.netlify.app`.

### The rollback was broken, and is now fixed

Worth knowing, because it was invisible. The Netlify Functions are CommonJS while
`apps/frontend/package.json` sets `"type": "module"`, so on any **fresh** build
Node treats a `.js` function as ESM and every call dies with
`ReferenceError: module is not defined in ES module scope`. Production never
showed it because production was built before that `"type"` field landed. A
rollback that triggered a rebuild would have landed on a site whose LLM proxies
502, and the build would have looked green while doing it.

Fixed by renaming both functions to `.cjs`. Verified on the branch's own Netlify
deploy preview, which is the cheapest way to test a Netlify build: it is already
running on every push, no deploy required.

## Current state of the LLM proxies

Both return `500 "API key not configured"`. The keys were never carried over from
Netlify, deliberately: the plan is to mint fresh Cerebras and Groq keys rather
than copy the old pair, since both endpoints are unauthenticated proxies to paid
accounts. The AI features are down until that happens, which was an accepted
trade to get the cutover done.
