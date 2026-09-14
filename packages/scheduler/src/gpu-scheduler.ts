/**
 * GPU picking policy on top of an nvidia-smi probe: which cards satisfy a
 * RunResourceRequest, minus the cards the caller marks as taken.
 *
 * The scheduler is STATELESS by design — reservations live in the store
 * (gpu_reservations, gpu_id PK). RunService passes the live-reservation set
 * in as `excludedGpuIds`, and the store's atomic tryReserveGpus is the
 * serialization point (DESIGN §19). No Slurm.
 */

import type { GpuState, ResourceView, RunResourceRequest } from '@dsh-lab/shared'
import type { SchedulerPort } from '@dsh-lab/core'
import { queryNvidiaSmi, type RawGpu } from './nvidia-smi.js'

export interface GpuSchedulerOptions {
  /** Hardware probe override (deterministic tests); defaults to nvidia-smi. */
  probe?: () => Promise<RawGpu[]>
}

export class GpuScheduler implements SchedulerPort {
  private readonly probe: () => Promise<RawGpu[]>

  constructor(opts: GpuSchedulerOptions = {}) {
    this.probe = opts.probe ?? queryNvidiaSmi
  }

  async discover(): Promise<GpuState[]> {
    let raw: RawGpu[]
    try {
      raw = await this.probe()
    } catch {
      // probe failed / no nvidia-smi — CPU-only environment
      return []
    }
    return raw.map((g) => ({
      id: g.index,
      model: g.name,
      freeVramMB: g.memoryFreeMB,
      totalVramMB: g.memoryTotalMB,
      runningRunIds: [],
    }))
  }

  async allocate(
    request: RunResourceRequest,
    opts: { excludedGpuIds?: number[] } = {},
  ): Promise<number[]> {
    const excluded = new Set(opts.excludedGpuIds ?? [])
    const gpus = await this.discover()
    const byId = new Map(gpus.map((g) => [g.id, g]))
    const minFree = request.minFreeVramMB ?? 0

    if (request.gpuIds) {
      // explicit pin: every requested card must exist, be unreserved and
      // satisfy minFreeVramMB — a busy pin fails instead of stealing the card
      for (const id of request.gpuIds) {
        const gpu = byId.get(id)
        if (!gpu) throw new Error(`GPU ${id} not found`)
        if (excluded.has(id)) throw new Error(`GPU ${id} is reserved by another run`)
        if (gpu.freeVramMB < minFree) {
          throw new Error(`GPU ${id} has ${gpu.freeVramMB}MB free, need ${minFree}MB`)
        }
      }
      return [...request.gpuIds]
    }

    const count = request.gpuCount ?? 1
    const candidates = gpus.filter((g) => !excluded.has(g.id) && g.freeVramMB >= minFree)
    if (candidates.length < count) {
      throw new Error(
        `not enough free GPUs: need ${count}, found ${candidates.length}` +
          (excluded.size > 0 ? ` (${excluded.size} held by reserved runs)` : ''),
      )
    }
    return candidates.slice(0, count).map((g) => g.id)
  }

  async snapshot(): Promise<ResourceView> {
    const gpus = await this.discover()
    return { gpus, queued: [], polledAt: Date.now() }
  }
}
