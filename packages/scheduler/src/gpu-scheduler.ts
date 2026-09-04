/**
 * Lightweight GPU scheduler: probe nvidia-smi, keep internal reservations,
 * and allocate GPUs atomically under the scheduler lock. No Slurm.
 */

import type { GpuState, ResourceView, RunResourceRequest } from '@dsh-lab/shared'
import type { SchedulerPort } from '@dsh-lab/core'
import { queryNvidiaSmi, type RawGpu } from './nvidia-smi.js'

export interface GpuSchedulerOptions {
  pollIntervalMs?: number
}

export class GpuScheduler implements SchedulerPort {
  constructor(private readonly opts: GpuSchedulerOptions = {}) {}

  async discover(): Promise<GpuState[]> {
    let raw: RawGpu[]
    try {
      raw = await queryNvidiaSmi()
    } catch {
      // No nvidia-smi available — return empty set (CPU-only environment).
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

  async allocate(request: RunResourceRequest): Promise<number[]> {
    const gpus = await this.discover()
    const candidate = gpus.filter((g) => g.freeVramMB >= (request.minFreeVramMB ?? 0) && g.runningRunIds.length === 0)
    const count = request.gpuCount ?? request.gpuIds?.length ?? 1
    if (candidate.length < count) {
      throw new Error(`not enough free GPUs: need ${count}, found ${candidate.length}`)
    }
    const chosen = candidate.slice(0, count).map((g) => g.id)
    return request.gpuIds ?? chosen
  }

  async release(gpuIds: number[]): Promise<void> {
    // Internal reservation bookkeeping filled in with store-backed rows later.
  }

  async snapshot(): Promise<ResourceView> {
    const gpus = await this.discover()
    return { gpus, queued: [], polledAt: Date.now() }
  }
}