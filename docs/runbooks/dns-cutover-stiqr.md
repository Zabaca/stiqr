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

## Rolling back: impossible, and that is now settled

James retired the rollback on 2026-07-30 and then **deleted the Netlify project**
the same day. `stiqr.netlify.app` returns 404. There is no revert target: the way
out of a bad Worker deploy is to fix forward.

Worth recording why losing it cost less than it sounds, because both directions
were measured before it went away:

- Rolling back would have **restored the AI features**, since Netlify still held
  working keys while the Worker had none. A "rollback" was an upgrade, which
  inverts what the word usually means. Moot now: the Worker has its own keys.
- Rolling back would have **broken deep links**, since Netlify had no SPA
  fallback for this site (404 on `stiqr.netlify.app/a/deep/link`, versus 200 on
  the Worker).

So the revert everyone assumed was clean would have traded one broken thing for
another. It is not a loss worth mourning.

**One thing deleting the project did NOT do: revoke the old API keys.** Removing
the site removed the open proxy that fronted them, which was the actual exposure.
The credentials themselves stay valid at Cerebras and Groq until revoked in those
consoles.

## Current state of the LLM proxies

Live, on freshly minted keys pushed as worker secrets from sops. The routes moved
from `/.netlify/functions/*` to `/api/*` once the Netlify project was deleted and
the drop-in constraint disappeared.

They require an `Origin` the app sends, so a bare `curl` gets 403. That is a
speed bump, not a wall: `curl -H 'Origin: https://stiqr.zabaca.com'` still works.
There is **no rate limit**, because Cloudflare's `ratelimit` binding does not
enforce on this account (registers as "Unsafe Metadata", `limit()` always returns
`success: true`, 20 parallel requests against a 5-per-10-second config produced
zero 429s). Bounding the spend needs a zone WAF rule or a Durable Object.
