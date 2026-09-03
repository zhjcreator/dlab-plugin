/**
 * ClientLabModel: immutable snapshot + subscribe for React. Kept framework
 * agnostic — UI components use useSyncExternalStore against it.
 */

import type { EnvironmentView, ResourceView, RunView, SolutionView } from '@dlab/shared'

export interface LabBaseline {
  project: { name: string } | undefined
  solutions: SolutionView[]
  runs: RunView[]
  resources: ResourceView
  environment: EnvironmentView
}

export type LabIncrement =
  | { kind: 'solution.upsert'; solution: SolutionView }
  | { kind: 'solution.remove'; id: string }
  | { kind: 'run.upsert'; run: RunView }
  | { kind: 'run.metric'; runId: string; name: string; value: number }
  | { kind: 'resources.update'; resources: ResourceView }
  | { kind: 'environment.update'; environment: EnvironmentView }

export interface ClientLabModel {
  subscribe(listener: () => void): () => void
  getSnapshot(): LabBaseline
  applyIncrement(inc: LabIncrement): void
}
