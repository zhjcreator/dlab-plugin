/**
 * GpuScheduler unit tests: the picking policy in isolation, with a
 * deterministic fake probe (no nvidia-smi, no store).
 */

import { describe, expect, it } from 'vitest'
import { GpuScheduler } from '../../packages/scheduler/lib/index.js'
import type { RawGpu } from '../../packages/scheduler/lib/index.js'

const fourCards = (): RawGpu[] =>
  Array.from({ length: 4 }, (_, i) => ({
    index: i,
    name: 'Fake 4090',
    memoryTotalMB: 24564,
    memoryFreeMB: 24564,
  }))

describe('GpuScheduler.allocate', () => {
  it('reserved cards are never candidates — submissions spread', async () => {
    const s = new GpuScheduler({ probe: fourCards })
    expect(await s.allocate({ mode: 'auto' })).toEqual([0])
    expect(await s.allocate({ mode: 'auto' }, { excludedGpuIds: [0] })).toEqual([1])
    expect(await s.allocate({ mode: 'auto', gpuCount: 2 }, { excludedGpuIds: [0, 1] })).toEqual([2, 3])
  })

  it('throws when exclusions leave too few cards', async () => {
    const s = new GpuScheduler({ probe: fourCards })
    await expect(
      s.allocate({ mode: 'auto', gpuCount: 2 }, { excludedGpuIds: [0, 1, 2] }),
    ).rejects.toThrow(/not enough free GPUs.*held by reserved runs/)
    await expect(s.allocate({ mode: 'auto' }, { excludedGpuIds: [0, 1, 2, 3] })).rejects.toThrow(
      /not enough free GPUs: need 1, found 0/,
    )
  })

  it('minFreeVramMB filters candidates', async () => {
    const s = new GpuScheduler({
      probe: () =>
        Promise.resolve([
          { index: 0, name: 'T', memoryTotalMB: 24564, memoryFreeMB: 1000 },
          { index: 1, name: 'T', memoryTotalMB: 24564, memoryFreeMB: 20000 },
        ]),
    })
    expect(await s.allocate({ mode: 'auto', minFreeVramMB: 5000 })).toEqual([1])
    await expect(s.allocate({ mode: 'auto', minFreeVramMB: 25000 })).rejects.toThrow(/not enough free GPUs/)
  })

  it('pinned gpuIds are validated: reserved / missing / low vram', async () => {
    const s = new GpuScheduler({
      probe: () => Promise.resolve([{ index: 0, name: 'T', memoryTotalMB: 24564, memoryFreeMB: 1000 }]),
    })
    await expect(s.allocate({ mode: 'explicit', gpuIds: [0] }, { excludedGpuIds: [0] })).rejects.toThrow(
      /GPU 0 is reserved by another run/,
    )
    await expect(s.allocate({ mode: 'explicit', gpuIds: [5] })).rejects.toThrow(/GPU 5 not found/)
    await expect(s.allocate({ mode: 'explicit', gpuIds: [0], minFreeVramMB: 2000 })).rejects.toThrow(
      /GPU 0 has 1000MB free, need 2000MB/,
    )
    expect(await s.allocate({ mode: 'explicit', gpuIds: [0] })).toEqual([0])
  })

  it('probe failure means CPU-only: empty discovery, allocation rejects', async () => {
    const s = new GpuScheduler({
      probe: () => {
        throw new Error('no nvidia-smi')
      },
    })
    expect(await s.discover()).toEqual([])
    await expect(s.allocate({ mode: 'auto' })).rejects.toThrow()
    expect((await s.snapshot()).gpus).toEqual([])
  })
})
