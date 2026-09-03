/**
 * nvidia-smi query parsing.
 *
 * Query format:
 *   --query-gpu=index,name,memory.total,memory.free
 *   --format=csv,noheader,nounits
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RawGpu {
  index: number
  name: string
  memoryTotalMB: number
  memoryFreeMB: number
}

export async function queryNvidiaSmi(): Promise<RawGpu[]> {
  const { stdout } = await execFileAsync('nvidia-smi', [
    '--query-gpu=index,name,memory.total,memory.free',
    '--format=csv,noheader,nounits',
  ])
  const rows = stdout.split('\n').filter(Boolean)
  const gpus: RawGpu[] = []
  for (const row of rows) {
    const [index, name, total, free] = row.split(', ').map((s) => s.trim())
    if (index === undefined) continue
    gpus.push({
      index: Number(index),
      name: name ?? 'unknown',
      memoryTotalMB: Number(total),
      memoryFreeMB: Number(free),
    })
  }
  return gpus
}
