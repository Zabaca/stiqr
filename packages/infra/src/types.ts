import type { z } from 'zod'

export type ApplyFn<TConfig, TOutputs> = (config: TConfig, ctx: ApplyContext) => Promise<TOutputs>

export type DestroyFn<TConfig> = (config: TConfig, ctx: ApplyContext) => Promise<void>

export interface ApplyContext {
  secrets: Record<string, string>
  imports: Record<string, unknown>
  projectRoot: string
}

export interface ModuleDefinition<TConfig extends z.ZodType, TOutputs extends z.ZodType> {
  name: string
  configSchema: TConfig
  outputsSchema: TOutputs
  apply: ApplyFn<z.infer<TConfig>, z.infer<TOutputs>>
  destroy?: DestroyFn<z.infer<TConfig>>
  instance: (opts: InstanceOptions<TConfig>) => ModuleInstance<TOutputs>
}

export interface InstanceOptions<TConfig extends z.ZodType> {
  name: string
  config: z.input<TConfig>
  imports?: ModuleInstance[]
}

export interface ModuleInstance<TOutputs extends z.ZodType = z.ZodType> {
  name: string
  moduleName: string
  config: unknown
  imports: ModuleInstance[]
  _outputsSchema: TOutputs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _definition: ModuleDefinition<any, TOutputs>
}
