import * as path from 'node:path'
import * as fs from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { z } from 'zod'
import { defineModule } from '../../src/define-module'

/**
 * cloudflare — deploys a Cloudflare Worker (optionally with static assets, a
 * Durable Object, and a Container) via `wrangler deploy`.
 *
 * This is a THIN orchestrator, the same shape as the turso module: `apply` runs
 * on the operator machine, reads CF creds from `ctx.secrets`, runs an optional
 * local build, then shells `wrangler deploy` in the package's own directory. The
 * Worker TOPOLOGY (name, assets binding, durable_objects, containers,
 * migrations) lives in that package's `wrangler.jsonc` — wrangler is the source
 * of truth for it, not this module. That keeps the module reusable for both
 * plain assets Workers (e.g. a static Astro/Next site) and container-backed
 * payloads (e.g. a DO-bound NATS server).
 *
 * Auth is non-interactive: wrangler reads `CLOUDFLARE_API_TOKEN` +
 * `CLOUDFLARE_ACCOUNT_ID` from the environment, so no `wrangler login` is
 * needed. Worker secrets (e.g. CLAUDE_CODE_OAUTH_TOKEN) are pushed via
 * `wrangler secret put`, piped through stdin so no secret value is ever
 * interpolated into a command string.
 *
 * NOTE on containers (Phase B): `wrangler deploy` builds the container image
 * with Docker, so Docker must be running locally at apply time, and the account
 * must be on a Workers Paid plan with Containers enabled. A plain assets Worker
 * (Phase A) has neither requirement.
 *
 * Two config knobs shape WHICH worker a given apply targets:
 *   - `wranglerEnv` selects a named `env.<name>` block in the package's
 *     wrangler.jsonc (`--env`), so one package can ship distinct workers per zbc
 *     environment from a single config file.
 *   - `workerName` renames the deployed worker (`--name`), which is what powers
 *     per-PR preview workers (`zbc-<app>-pr-<N>`). The `*.workers.dev` deploy-URL
 *     regex still matches a renamed worker's URL.
 *
 * IMPORT SYNC: `workerSecrets` and `workerVars` entries can be either a plain
 * name (resolved from this environment's secrets.yaml, exactly as before) or a
 * `{ name, from, output }` reference into an imported instance's outputs
 * (`ctx.imports[from][output]`, populated by the engine from that instance's
 * validated outputs). Secrets are pushed via `wrangler secret put`, piped
 * through stdin; vars are passed as `wrangler deploy --var KEY:VALUE`. The two
 * are deliberately separate fields — a var is visible in `wrangler.jsonc`/the
 * dashboard, a secret is not — so an imported value's exposure is an explicit
 * per-entry choice, never inferred. Referencing an instance not listed in this
 * instance's `imports`, or an output key that instance doesn't emit, is a hard
 * error naming both.
 */

/** Resolve the wrangler binary: prefer the package-local one, else `bunx`. */
function resolveWrangler(workdir: string): { cmd: string; pre: string[] } {
  const local = path.join(workdir, 'node_modules', '.bin', 'wrangler')
  if (fs.existsSync(local)) return { cmd: local, pre: [] }
  // Fall back to bunx on the NODE runtime. Never pass --bun: wrangler under
  // the bun runtime exits 0 after uploading the version but silently skips the
  // deploy/trigger step (2026-07-12 lov incident in Zabaca/ceo: three green
  // applies, zero code deployed).
  return { cmd: 'bunx', pre: ['wrangler'] }
}

/** Run wrangler in `workdir` with CF creds in the env; return captured stdout. */
function wrangler(workdir: string, args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  const { cmd, pre } = resolveWrangler(workdir)
  // spawnSync (not execFileSync) so BOTH streams are captured on success too:
  // wrangler splits its human output across stdout/stderr, and parsing only
  // stdout is how the 2026-07-12 silent-no-deploy went unnoticed.
  const res = spawnSync(cmd, [...pre, ...args], {
    cwd: workdir,
    env,
    input,
    maxBuffer: 64 * 1024 * 1024,
  })
  const combined = `${res.stdout?.toString() ?? ''}\n${res.stderr?.toString() ?? ''}`
  if (res.status !== 0 || res.error) {
    throw new Error(
      `wrangler ${args.join(' ')} failed (exit ${res.status}):\n${combined.trim() || res.error?.message}`,
    )
  }
  return combined
}

const buildSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
})

/**
 * A worker secret/var entry: a plain name (resolved from this environment's
 * secrets.yaml), a `{ name, value }` literal (vars that are per-instance
 * config rather than secrets — e.g. DEFAULT_FROM — so a generic wrangler.jsonc
 * needs no editing), or a `{ name, from, output }` reference into an imported
 * instance's outputs (`ctx.imports[from][output]`).
 */
const workerValueSchema = z.union([
  z.string(),
  z.object({
    /** Env var name inside the Worker. */
    name: z.string(),
    /** Literal value, straight from this instance's config file. */
    value: z.string(),
  }),
  z.object({
    /** Env var name inside the Worker. */
    name: z.string(),
    /** Instance name — must be listed in this instance's `imports`. */
    from: z.string(),
    /** Which output of that instance to read. */
    output: z.string(),
  }),
])

type WorkerValueEntry = z.infer<typeof workerValueSchema>

/** Resolve a workerSecrets/workerVars entry to its `{ name, value }` pair. */
function resolveWorkerValue(
  entry: WorkerValueEntry,
  ctx: { secrets: Record<string, string>; imports: Record<string, unknown> },
  fieldName: string,
): { name: string; value: string } {
  if (typeof entry === 'string') {
    const value = ctx.secrets[entry]
    if (!value) {
      throw new Error(
        `${fieldName} references "${entry}" but it's missing from this environment's secrets.yaml`,
      )
    }
    return { name: entry, value }
  }

  if ('value' in entry) {
    return { name: entry.name, value: entry.value }
  }

  const instanceOutputs = ctx.imports[entry.from]
  if (instanceOutputs === undefined) {
    throw new Error(
      `${fieldName} entry "${entry.name}" references instance "${entry.from}", which is not in this instance's imports`,
    )
  }
  const value = (instanceOutputs as Record<string, unknown> | null)?.[entry.output]
  if (typeof value !== 'string') {
    throw new Error(
      `${fieldName} entry "${entry.name}" references output "${entry.output}" on instance "${entry.from}", which doesn't emit it`,
    )
  }
  return { name: entry.name, value }
}

/**
 * An R2 binding override: which bucket the named `r2_buckets` binding in the
 * package's wrangler config should attach to. Either a literal bucket name or
 * a `{ from, output }` reference into an imported instance's outputs (the r2
 * module emits `bucketName`). Wrangler has no CLI flag for this, so the module
 * patches a generated copy of the wrangler config and deploys with --config —
 * which is what lets a scaffolded package's wrangler.jsonc stay generic while
 * the per-project bucket name lives in the instance file.
 */
const r2BindingSchema = z.union([
  z.object({
    /** Binding name inside the Worker (the `binding` field in r2_buckets). */
    binding: z.string(),
    /** Literal bucket name. */
    bucketName: z.string(),
  }),
  z.object({
    binding: z.string(),
    /** Instance name — must be listed in this instance's `imports`. */
    from: z.string(),
    /** Which output of that instance holds the bucket name. */
    output: z.string(),
  }),
])

type R2BindingEntry = z.infer<typeof r2BindingSchema>

function resolveR2Binding(
  entry: R2BindingEntry,
  ctx: { imports: Record<string, unknown> },
): { binding: string; bucketName: string } {
  if ('bucketName' in entry) return { binding: entry.binding, bucketName: entry.bucketName }
  const instanceOutputs = ctx.imports[entry.from]
  if (instanceOutputs === undefined) {
    throw new Error(
      `r2Bindings entry "${entry.binding}" references instance "${entry.from}", which is not in this instance's imports`,
    )
  }
  const value = (instanceOutputs as Record<string, unknown> | null)?.[entry.output]
  if (typeof value !== 'string') {
    throw new Error(
      `r2Bindings entry "${entry.binding}" references output "${entry.output}" on instance "${entry.from}", which doesn't emit it`,
    )
  }
  return { binding: entry.binding, bucketName: value }
}

/** Strip line and block comments from JSONC, string-aware. */
function stripJsoncComments(src: string): string {
  let out = ''
  let i = 0
  let inStr = false
  while (i < src.length) {
    const c = src[i]!
    if (inStr) {
      out += c
      if (c === '\\') {
        out += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** Remove trailing commas (`,}` / `,]`), string-aware — JSONC allows them. */
function stripTrailingCommas(src: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (inStr) {
      out += c
      if (c === '\\') {
        out += src[i + 1] ?? ''
        i++
        continue
      }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < src.length && /\s/.test(src[j]!)) j++
      if (src[j] === '}' || src[j] === ']') continue
    }
    out += c
  }
  return out
}

interface WranglerR2Entry {
  binding: string
  bucket_name?: string
}

/**
 * Rewrite `bucket_name` for each resolved r2Bindings entry, in the top-level
 * `r2_buckets` and (when `wranglerEnv` is set) the matching `env.<name>` block.
 * A binding with no matching r2_buckets entry is a hard config error.
 */
function patchR2Buckets(
  config: Record<string, unknown>,
  resolved: Array<{ binding: string; bucketName: string }>,
  wranglerEnv?: string,
): void {
  const blocks: Array<Record<string, unknown>> = [config]
  if (wranglerEnv) {
    const envBlock = (config.env as Record<string, Record<string, unknown>> | undefined)?.[
      wranglerEnv
    ]
    if (envBlock) blocks.push(envBlock)
  }
  for (const { binding, bucketName } of resolved) {
    let found = false
    for (const block of blocks) {
      const entry = (block.r2_buckets as WranglerR2Entry[] | undefined)?.find(
        (b) => b.binding === binding,
      )
      if (entry) {
        entry.bucket_name = bucketName
        found = true
      }
    }
    if (!found) {
      throw new Error(
        `r2Bindings entry "${binding}" has no matching r2_buckets binding in the package's wrangler config`,
      )
    }
  }
}

export const cloudflareModule = defineModule({
  name: 'cloudflare',
  configSchema: z.object({
    /** Package dir (relative to projectRoot) that holds wrangler.jsonc. */
    workdir: z.string(),
    /**
     * Cloudflare account id. Not a secret (it appears in the dashboard URL), so
     * it lives in config — only the API token is held in secrets.yaml.
     */
    accountId: z.string(),
    /** Optional local build run before deploy (e.g. `vite build` for assets). */
    build: buildSchema.optional(),
    /**
     * Worker secrets to push after deploy. Each entry is either a plain name
     * — a key in this environment's secrets.yaml, becoming a Worker secret
     * binding of the same name (read at runtime as `env.<NAME>`) — or a
     * `{ name, from, output }` reference into an imported instance's outputs.
     * Pushed via `wrangler secret put` with the value piped through stdin.
     */
    workerSecrets: z.array(workerValueSchema).default([]),
    /**
     * Worker vars to set at deploy time (`wrangler deploy --var KEY:VALUE`).
     * Same entry shape as `workerSecrets` — plain name (from secrets.yaml) or
     * `{ name, from, output }` — but for non-secret, publicly-visible config.
     * Unlike secrets, var values are passed on the command line, so never
     * route sensitive values through this field.
     */
    workerVars: z.array(workerValueSchema).default([]),
    /**
     * Override which R2 bucket each named `r2_buckets` binding attaches to.
     * Entries are `{ binding, bucketName }` literals or `{ binding, from,
     * output }` references into an imported instance's outputs (the r2 module
     * emits `bucketName`). Lets the package's wrangler config stay generic —
     * the per-project bucket lives here, next to the other identifiers.
     */
    r2Bindings: z.array(r2BindingSchema).default([]),
    /**
     * For container-backed Workers: roll the running container to the new image
     * IMMEDIATELY on deploy (`--containers-rollout immediate`). The wrangler
     * default is a GRADUAL rollout, which never drains a single always-warm,
     * DO-bound container — so a redeployed image silently never takes effect
     * until the container idle-sleeps. Set true whenever the image matters at
     * deploy time. No-op for asset-only Workers.
     */
    immediateContainerRollout: z.boolean().default(false),
    /**
     * Wrangler named environment (`--env <name>`). When set, deploy and every
     * `secret put` target the matching `env.<name>` block in the package's
     * wrangler.jsonc, so a non-production zbc environment (e.g. `preview`) can
     * ship a DISTINCT worker (own name/domain/bindings) from the same package —
     * without a separate wrangler config. Omit for the top-level (production)
     * worker.
     */
    wranglerEnv: z.string().optional(),
    /**
     * Override the deployed worker name (`--name <workerName>`). This is what
     * enables per-PR preview workers (e.g. `zbc-landing-pr-42`) from a single
     * wrangler.jsonc: the preview instance sets a PR-scoped name so each PR
     * lands on its own isolated worker + `*.workers.dev` URL. Omit to use the
     * `name` declared in wrangler.jsonc.
     */
    workerName: z.string().optional(),
  }),
  outputs: z.object({
    deployUrl: z.string(),
    /**
     * The deployed Worker's script name, parsed from wrangler's "Deployed
     * <name> triggers" confirmation. Lets dependents reference this worker
     * without repeating the name from wrangler.jsonc (e.g. cloudflare-email's
     * catchAll.workerName as `{ from, output: 'workerName' }`).
     */
    workerName: z.string(),
  }),
  async apply(config, ctx) {
    const apiToken = ctx.secrets['CLOUDFLARE_API_TOKEN']
    if (!apiToken) throw new Error('Missing secret: CLOUDFLARE_API_TOKEN')

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: config.accountId,
    }

    const workdir = path.resolve(ctx.projectRoot, config.workdir)

    // 1. Optional local build (assets). Inherit stdio so build output streams.
    if (config.build) {
      const buildCwd = path.resolve(ctx.projectRoot, config.build.cwd ?? config.workdir)
      console.log(
        `  Building: ${config.build.command} (in ${path.relative(ctx.projectRoot, buildCwd) || '.'})`,
      )
      execSync(config.build.command, { cwd: buildCwd, stdio: 'inherit', env })
    }

    // 2. Resolve every workerVars/workerSecrets entry BEFORE deploy so a bad
    //    reference (unknown import, missing output/secret) fails fast, without
    //    leaving a deployed-but-unconfigured worker. `resolveWorkerValue` is
    //    pure — only the wrangler pushes below have side effects. --var values
    //    additionally ship as part of `wrangler deploy` itself (not a follow-up
    //    call); secrets are pushed after deploy (step 4) since the script must
    //    exist first.
    const resolvedVars = config.workerVars.map((entry) =>
      resolveWorkerValue(entry, ctx, 'workerVars'),
    )
    const resolvedSecrets = config.workerSecrets.map((entry) =>
      resolveWorkerValue(entry, ctx, 'workerSecrets'),
    )
    const resolvedR2 = config.r2Bindings.map((entry) => resolveR2Binding(entry, ctx))

    // 2b. r2Bindings: wrangler has no CLI flag for bucket overrides, so patch
    //     a generated copy of the package's wrangler config and deploy with
    //     --config. Written next to the original so relative paths (main,
    //     assets dir) still resolve; comments don't survive the round-trip,
    //     but the file is throwaway (deleted after deploy).
    let generatedConfig: string | undefined
    if (resolvedR2.length > 0) {
      const configPath = ['wrangler.jsonc', 'wrangler.json']
        .map((f) => path.join(workdir, f))
        .find((f) => fs.existsSync(f))
      if (!configPath) {
        throw new Error(
          `r2Bindings requires a wrangler.jsonc/wrangler.json in ${config.workdir} (wrangler.toml is not supported)`,
        )
      }
      const parsed = JSON.parse(
        stripTrailingCommas(stripJsoncComments(fs.readFileSync(configPath, 'utf8'))),
      ) as Record<string, unknown>
      patchR2Buckets(parsed, resolvedR2, config.wranglerEnv)
      generatedConfig = path.join(workdir, 'wrangler.zbc-generated.json')
      fs.writeFileSync(generatedConfig, JSON.stringify(parsed, null, 2))
    }

    // 3. Deploy. Creates/updates the Worker script (+ assets, DO, container).
    //    --env selects the named wrangler environment (e.g. preview) so it ships
    //    a distinct worker from the same package; --name overrides the worker
    //    name (per-PR preview workers); both omitted = the package's default.
    const deployArgs = ['deploy']
    if (generatedConfig) deployArgs.push('--config', generatedConfig)
    if (config.wranglerEnv) deployArgs.push('--env', config.wranglerEnv)
    if (config.workerName) deployArgs.push('--name', config.workerName)
    if (config.immediateContainerRollout) deployArgs.push('--containers-rollout', 'immediate')
    for (const { name, value } of resolvedVars) deployArgs.push('--var', `${name}:${value}`)
    console.log(
      `  Deploying via wrangler (in ${config.workdir})${config.wranglerEnv ? ` [env: ${config.wranglerEnv}]` : ''}${config.workerName ? ` [name: ${config.workerName}]` : ''}${config.immediateContainerRollout ? ' [immediate container rollout]' : ''}${resolvedVars.length ? ` [vars: ${resolvedVars.map((v) => v.name).join(', ')}]` : ''}${resolvedR2.length ? ` [r2: ${resolvedR2.map((b) => `${b.binding}→${b.bucketName}`).join(', ')}]` : ''}`,
    )
    let out: string
    try {
      out = wrangler(workdir, deployArgs, env)
    } finally {
      if (generatedConfig) fs.rmSync(generatedConfig, { force: true })
    }
    // Success theater guard: wrangler can exit 0 without actually deploying
    // (the --bun incident above). Require the deploy confirmation line — and
    // capture the deployed script name from it for the workerName output.
    const deployedMatch = out.match(/Deployed\s+(\S+)\s+triggers/)
    if (!deployedMatch) {
      throw new Error(
        `wrangler deploy exited 0 but printed no "Deployed ... triggers" confirmation:\n${out}`,
      )
    }
    const workerName = deployedMatch[1]!
    const urlMatch = out.match(/https:\/\/[^\s"',]+\.workers\.dev[^\s"',]*/)
    const deployUrl = urlMatch?.[0] ?? ''
    console.log(`  Deployed: ${deployUrl || '(URL not parsed — see wrangler output)'}`)

    // 4. Push Worker secrets (after deploy: the script must exist first).
    //    Already resolved in step 2, so a misconfigured reference never reaches
    //    this point. Value piped via stdin so it never lands in a command
    //    string or the log.
    for (const { name, value } of resolvedSecrets) {
      const secretArgs = ['secret', 'put', name]
      if (config.wranglerEnv) secretArgs.push('--env', config.wranglerEnv)
      if (config.workerName) secretArgs.push('--name', config.workerName)
      wrangler(workdir, secretArgs, env, value)
      console.log(`  Set Worker secret: ${name}`)
    }

    return { deployUrl, workerName }
  },
  async destroy(config, ctx) {
    const apiToken = ctx.secrets['CLOUDFLARE_API_TOKEN']
    if (!apiToken) throw new Error('Missing secret: CLOUDFLARE_API_TOKEN')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: config.accountId,
    }
    const workdir = path.resolve(ctx.projectRoot, config.workdir)
    // `wrangler delete` removes the Worker (and its DO/container). Non-fatal if
    // already gone. --env / --name target the same worker `apply` deployed
    // (named environment and/or per-PR preview name).
    try {
      const deleteArgs = ['delete', '--force']
      if (config.wranglerEnv) deleteArgs.push('--env', config.wranglerEnv)
      if (config.workerName) deleteArgs.push('--name', config.workerName)
      wrangler(workdir, deleteArgs, env)
      console.log('  Deleted Worker')
    } catch (err) {
      console.log(`  Worker delete skipped: ${(err as Error).message}`)
    }
  },
})
