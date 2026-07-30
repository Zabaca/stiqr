import type { z } from 'zod'
import type { ApplyFn, DestroyFn, ModuleDefinition, ModuleInstance, InstanceOptions } from './types'

interface DefineModuleOptions<TConfig extends z.ZodType, TOutputs extends z.ZodType> {
  name: string
  configSchema: TConfig
  outputs: TOutputs
  apply: ApplyFn<z.infer<TConfig>, z.infer<TOutputs>>
  destroy?: DestroyFn<z.infer<TConfig>>
}

export function defineModule<TConfig extends z.ZodType, TOutputs extends z.ZodType>(
  opts: DefineModuleOptions<TConfig, TOutputs>,
): ModuleDefinition<TConfig, TOutputs> {
  const definition: ModuleDefinition<TConfig, TOutputs> = {
    name: opts.name,
    configSchema: opts.configSchema,
    outputsSchema: opts.outputs,
    apply: opts.apply,
    destroy: opts.destroy,
    instance(instanceOpts: InstanceOptions<TConfig>): ModuleInstance<TOutputs> {
      return {
        name: instanceOpts.name,
        moduleName: opts.name,
        config: instanceOpts.config,
        imports: instanceOpts.imports ?? [],
        _outputsSchema: opts.outputs,
        _definition: definition as ModuleDefinition<any, TOutputs>,
      }
    },
  }

  return definition
}
