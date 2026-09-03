/**
 * ULID helpers for stable, time-ordered ids.
 *
 * Solution ids are `solution_<ulid>`; Run ids are `run_<ulid>` with the
 * canonical directory spelling `run-NNNNNN` derived from an epoch counter,
 * not from the ULID. These helpers intentionally depend on nothing but
 * `node:crypto` so they can live in the pure shared package.
 */

import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Generate one 26-char Crockford-base32 ULID. */
export function ulid(): string {
  // 48-bit millisecond timestamp prefix (10 chars)
  const ts = Date.now()
  const timePart = ts.toString(32).padStart(10, '0').toUpperCase()
  // 80-bit randomness (16 chars)
  const bytes = randomBytes(10)
  let randPart = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      randPart += CROCKFORD[(acc >> bits) & 31]
    }
  }
  return (timePart + randPart).padEnd(26, '0')
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/

export function isUlid(value: string): boolean {
  return ULID_RE.test(value)
}

/** Branded id forms. Use these as plain strings at the DB boundary. */
export function solutionId(): string {
  return `solution_${ulid()}`
}

export function runId(): string {
  return `run_${ulid()}`
}

export function runDirName(counter: number): string {
  return `run-${String(counter).padStart(6, '0')}`
}
