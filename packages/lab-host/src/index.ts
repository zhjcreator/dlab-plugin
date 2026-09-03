/**
 * DSH Host adapter entry for @dlab/lab-host.
 *
 * The plugin reads its project config from the schema below, then mounts the
 * concrete ports and exposes `ctx.lab`. Roles are selected by the row config
 * (service | tools | rpc | shell-env | system-prompt) so one cordis.yml can
 * address individual rows for HMR.
 *
 * Phase 1 skeleton: wiring shape only.
 */

import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { EnvironmentView, SolutionView } from '@dlab/shared'
import type { LabConfig } from '@dlab/core'

export interface Config {
  role: 'service' | 'tools' | 'rpc' | 'shell-env' | 'system-prompt' | 'root'
  solutionRoot: string
  configPath?: string
  projectName?: string
}

export const Config: Schema<Config> = Schema.object({
  role: Schema.union(['service', 'tools', 'rpc', 'shell-env', 'system-prompt', 'root']).default('root'),
  solutionRoot: Schema.string().default(''),
  configPath: Schema.string(),
  projectName: Schema.string(),
})

/** The `lab` service exposes high-level operations to host consumers and tools. */
export class LabService extends Service {
  static inject = ['workspaceRegistry', 'tools', 'storageDomain', 'connection']

  constructor(ctx: Context, private readonly config: LabConfig) {
    super(ctx, 'lab')
  }

  // Projection-facing reads
  solutions = {
    list: async (): Promise<SolutionView[]> => [] as SolutionView[],
    get: async (idOrSlug: string): Promise<SolutionView> => {
      throw new Error(`get(${idOrSlug}) not implemented`)
    },
  }

  runs = {
    list: async (): Promise<unknown[]> => [],
  }

  environment = {
    get: async (): Promise<EnvironmentView> => {
      throw new Error('environment not implemented')
    },
  }
}

export const name = 'dlab-lab-host'

export function apply(ctx: Context, cfg: Config): void {
  // Phase 1: resolve solutionRoot (default to process cwd at first boot),
  // build ports, and register whichever role this row config names.
  void cfg
  void ctx
}
