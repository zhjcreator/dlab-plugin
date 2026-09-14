/**
 * Idempotent migration runner. Schema.sql holds the full current DDL with
 * `IF NOT EXISTS`; migrations.ts is where future ALTER steps land, keyed by a
 * user_version pragma.
 */

import type Database from 'better-sqlite3'

export const SCHEMA_VERSION = 2

/** Columns added after the first release, applied to pre-existing labs. */
const COLUMN_ADDITIONS: { table: string; column: string; ddl: string }[] = [
  // v2: the project-wide document directory (DESIGN §26)
  { table: 'projects', column: 'docs', ddl: 'ALTER TABLE projects ADD COLUMN docs TEXT' },
]

export function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current < 1) {
    db.pragma('user_version = 1')
  }
  if (current < 2) {
    for (const add of COLUMN_ADDITIONS) {
      if (hasColumn(db, add.table, add.column)) continue
      db.exec(add.ddl)
    }
    db.pragma('user_version = 2')
  }
  // Future: switch on version and apply ALTERs; keep them idempotent.
}

/** Whether a table already carries a column (idempotent ALTER guard). */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}
