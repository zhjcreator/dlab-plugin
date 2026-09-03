/**
 * Read the last N lines of a growing log file without loading the whole file
 * when it is huge. Returns at most maxLines lines of UTF-8 text.
 */

import { open } from 'node:fs/promises'

export async function tailFile(path: string, maxLines: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const CHUNK = 64 * 1024
    let pos = size
    const buffer = Buffer.alloc(CHUNK)
    let text = ''
    let newlines = 0
    while (pos > 0 && newlines <= maxLines) {
      const readLen = Math.min(CHUNK, pos)
      pos -= readLen
      const { bytesRead } = await handle.read(buffer, 0, readLen, pos)
      const chunk = buffer.subarray(0, bytesRead).toString('utf8')
      text = chunk + text
      newlines = (text.match(/\n/g) ?? []).length
      if (bytesRead === 0) break
    }
    if (newlines > maxLines) {
      const lines = text.split('\n')
      return lines.slice(lines.length - maxLines).join('\n')
    }
    return text
  } finally {
    await handle.close()
  }
}
