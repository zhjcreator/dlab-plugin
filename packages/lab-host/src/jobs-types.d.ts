/**
 * Minimal structural mirror of the subset of `@deepseek-ai/dsh-jobs`
 * (0.1.5-rc.x) the run → background-job bridge consumes.
 *
 * Why hand-mirrored: the published dsh-jobs 0.1.5-rc.2 declares peer ranges
 * (`^0.1.5-rc.2`) that the npm registry cannot satisfy during resolution —
 * only the prerelease itself exists — so declaring it as a lab-host
 * dependency makes every workspace/profile install fail. The bridge's
 * runtime access is untyped anyway (`ctx.get('jobs')`); this declaration
 * covers exactly the five fields `start()` consumes, mirrored from the
 * generated reference in the deployment's installed copy:
 * node_modules/@deepseek-ai/dsh-jobs/lib/types/{index,types}.d.ts
 *
 * Do NOT extend this mirror by guessing — re-read the reference instead, and
 * drop this file in favor of the real types once dsh-jobs publishes
 * installable ranges.
 */
declare module '@deepseek-ai/dsh-jobs' {
  /** Terminal result supplied by the producer through {@link JobHooks.done}. */
  export interface JobOutcome {
    status: 'completed' | 'killed' | 'failed'
    detail?: string
    output?: string
  }
  /** Hooks through which the runtime controls and observes producer work. */
  export interface JobHooks {
    /** Synchronous, idempotent termination request; must eventually settle done. */
    cancel(reason?: string): void
    /** Resolves after the producer releases its resources; must not reject. */
    done: Promise<JobOutcome>
    /** Consume output produced since the previous call (one cursor per job). */
    readOutput?(): string
  }
  /** Producer declaration passed to {@link JobRegistry.start}. */
  export interface JobStart {
    /** Producer kind — also the registry-issued id prefix (`<kind>-N`). */
    kind: string
    /** One-line model-facing label. */
    label: string
    /** UTF-8 byte cap for model-facing completion notices and output reads. */
    outputLimitBytes?: number
    /** Owning live agent; access is fenced by its session id. */
    owner?: unknown
    /** Started synchronously after preflight; a throw leaves nothing registered. */
    run(): JobHooks
  }
  /** The abstract registry mounted as ctx.jobs (implementation: dsh-jobs-local). */
  export abstract class JobRegistry {
    /** Preflight + atomically register work; returns the `<kind>-N` id. */
    start(spec: JobStart): string
  }
}
