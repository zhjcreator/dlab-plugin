/**
 * Idempotent migration runner. Schema.sql holds the full current DDL with
 * `IF NOT EXISTS`; migrations.ts is where future ALTER steps land, keyed by a
 * user_version pragma.
 */

import type Database from 'better-sqlite3'

export const SCHEMA_VERSION = 1

export function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current < 1) {
    db.pragma('user_version = 1')
  }
  // Future: switch on version and apply ALTERs; keep them idempotent.
}
