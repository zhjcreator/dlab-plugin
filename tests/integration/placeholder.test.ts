// Placeholder — real integration tests run against a local sandbox directory.
// Override the path with DLAB_SANDBOX_ROOT=<dir>; otherwise vitest uses the
// OS temp dir. See README §"Working Environment" for context.
import { describe, expect, it } from 'vitest'

describe('integration placeholder', () => {
  it('is a dir', () => {
    expect(1).toBe(1)
  })
})
