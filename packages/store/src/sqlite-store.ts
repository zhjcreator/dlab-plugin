/**
 * StorePort implementation over better-sqlite3. Executes schema.sql
 * idempotently at open and exposes typed repositories. Skeleton: opens the
 * DB and runs DDL; row CRUD is filled in next.
 */

import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { LabEventType, Project, RunMetric, RunStatus, Solution } from '@dsh-lab/shared'
import type { StorePort } from '@dsh-lab/core'

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql')

export interface SqliteStoreOptions {
  path: string // absolute path to lab.sqlite
}

export class SqliteStore implements StorePort {
  private readonly db: Database.Database

  constructor(opts: SqliteStoreOptions) {
    this.db = new Database(opts.path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
  }

  close(): void {
    this.db.close()
  }

  // ── projects ─────────────────────────────────────────────────────────────

  getProject(): Promise<Project | undefined> {
    const row = this.db.prepare('SELECT * FROM projects LIMIT 1').get() as Record<string, unknown> | undefined
    if (!row) return Promise.resolve(undefined)
    return Promise.resolve({
      id: row.id as string,
      name: row.name as string,
      rootPath: row.root_path as string,
      mainSolutionId: (row.main_solution_id as string | null) ?? undefined,
      docs: (row.docs as string | null) ?? undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    })
  }

  async createProject(input: { name: string; rootPath: string }): Promise<Project> {
    const now = Date.now()
    const project: Project = {
      id: `project_${now.toString(36)}`,
      name: input.name,
      rootPath: input.rootPath,
      createdAt: now,
      updatedAt: now,
    }
    this.db.prepare('INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      project.id,
      project.name,
      project.rootPath,
      project.createdAt,
      project.updatedAt,
    )
    return project
  }

  // ── solutions ────────────────────────────────────────────────────────────

  /** Map a raw snake_case DB row to the camelCase domain object. */
  private static rowToSolution(row: Record<string, unknown>): Solution {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      slug: row.slug as string,
      name: row.name as string,
      description: (row.description as string | null) ?? undefined,
      hypothesis: (row.hypothesis as string | null) ?? undefined,
      conclusion: (row.conclusion as string | null) ?? undefined,
      role: row.role as Solution['role'],
      status: row.status as Solution['status'],
      branch: row.branch as string,
      worktreePath: (row.worktree_path as string | null) ?? undefined,
      workspaceId: (row.workspace_id as string | null) ?? undefined,
      parentSolutionId: (row.parent_solution_id as string | null) ?? undefined,
      forkCommit: (row.fork_commit as string | null) ?? undefined,
      headCommit: row.head_commit as string,
      mergedIntoSolutionId: (row.merged_into_solution_id as string | null) ?? undefined,
      mergeCommit: (row.merge_commit as string | null) ?? undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      archivedAt: (row.archived_at as number | null) ?? undefined,
      mergedAt: (row.merged_at as number | null) ?? undefined,
    }
  }

  listSolutions(): Promise<Solution[]> {
    const rows = this.db.prepare('SELECT * FROM solutions ORDER BY created_at').all() as Record<string, unknown>[]
    return Promise.resolve(rows.map((r) => SqliteStore.rowToSolution(r)))
  }

  getSolution(id: string): Promise<Solution | undefined> {
    const row = this.db.prepare('SELECT * FROM solutions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return Promise.resolve(row ? SqliteStore.rowToSolution(row) : undefined)
  }

  getSolutionBySlug(slug: string): Promise<Solution | undefined> {
    const row = this.db.prepare('SELECT * FROM solutions WHERE slug = ?').get(slug) as Record<string, unknown> | undefined
    return Promise.resolve(row ? SqliteStore.rowToSolution(row) : undefined)
  }

  upsertSolution(solution: Solution): Promise<void> {
    const p: Record<string, unknown> = {
      id: solution.id,
      projectId: solution.projectId,
      slug: solution.slug,
      name: solution.name,
      description: solution.description ?? null,
      hypothesis: solution.hypothesis ?? null,
      conclusion: solution.conclusion ?? null,
      role: solution.role,
      status: solution.status,
      branch: solution.branch,
      worktreePath: solution.worktreePath ?? null,
      workspaceId: solution.workspaceId ?? null,
      parentSolutionId: solution.parentSolutionId ?? null,
      forkCommit: solution.forkCommit ?? null,
      headCommit: solution.headCommit,
      mergedIntoSolutionId: solution.mergedIntoSolutionId ?? null,
      mergeCommit: solution.mergeCommit ?? null,
      createdAt: solution.createdAt,
      updatedAt: solution.updatedAt,
      archivedAt: solution.archivedAt ?? null,
      mergedAt: solution.mergedAt ?? null,
    }
    this.db
      .prepare(
        `INSERT INTO solutions (
           id, project_id, slug, name, description, hypothesis, conclusion,
           role, status, branch, worktree_path, workspace_id, parent_solution_id,
           fork_commit, head_commit, merged_into_solution_id, merge_commit,
           created_at, updated_at, archived_at, merged_at
         ) VALUES (
           @id, @projectId, @slug, @name, @description, @hypothesis, @conclusion,
           @role, @status, @branch, @worktreePath, @workspaceId, @parentSolutionId,
           @forkCommit, @headCommit, @mergedIntoSolutionId, @mergeCommit,
           @createdAt, @updatedAt, @archivedAt, @mergedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           hypothesis = excluded.hypothesis,
           conclusion = excluded.conclusion,
           role = excluded.role,
           status = excluded.status,
           branch = excluded.branch,
           worktree_path = excluded.worktree_path,
           workspace_id = excluded.workspace_id,
           head_commit = excluded.head_commit,
           merged_into_solution_id = excluded.merged_into_solution_id,
           merge_commit = excluded.merge_commit,
           updated_at = excluded.updated_at,
           archived_at = excluded.archived_at,
           merged_at = excluded.merged_at`,
      )
      .run(p)
    return Promise.resolve()
  }

  setMainSolution(projectId: string, solutionId: string): Promise<void> {
    this.db
      .prepare('UPDATE projects SET main_solution_id = ?, updated_at = ? WHERE id = ?')
      .run(solutionId, Date.now(), projectId)
    return Promise.resolve()
  }

  /** Record the project-wide document directory (see DESIGN §26). */
  setProjectDocs(projectId: string, docs: string): Promise<void> {
    this.db.prepare('UPDATE projects SET docs = ?, updated_at = ? WHERE id = ?').run(docs, Date.now(), projectId)
    return Promise.resolve()
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  /** Map a raw snake_case runs row to the camelCase domain object. */
  private static rowToRun(row: Record<string, unknown>): import('@dsh-lab/shared').ExperimentRun {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      solutionId: row.solution_id as string,
      snapshotCommit: row.snapshot_commit as string,
      sourceHeadCommit: row.source_head_commit as string,
      status: row.status as import('@dsh-lab/shared').RunStatus,
      title: (row.title as string | null) ?? undefined,
      description: (row.description as string | null) ?? undefined,
      runProfileId: (row.run_profile_id as string | null) ?? undefined,
      command: JSON.parse((row.command_json as string) ?? '[]') as string[],
      resources: JSON.parse((row.resources_json as string) ?? '{}') as import('@dsh-lab/shared').RunResourceRequest,
      environmentFingerprint: (row.environment_fingerprint as string | null) ?? 'env:unknown',
      runDir: row.run_dir as string,
      worktreePath: (row.worktree_path as string | null) ?? undefined,
      pid: (row.pid as number | null) ?? undefined,
      pgid: (row.pgid as number | null) ?? undefined,
      exitCode: (row.exit_code as number | null) ?? undefined,
      createdAt: row.created_at as number,
      startedAt: (row.started_at as number | null) ?? undefined,
      finishedAt: (row.finished_at as number | null) ?? undefined,
      tags: [],
    }
  }

  private runTags(runId: string): string[] {
    try {
      const rows = this.db.prepare('SELECT tag FROM run_tags WHERE run_id = ?').all(runId) as { tag: string }[]
      return rows.map((r) => r.tag)
    } catch {
      return []
    }
  }

  listRuns(filter?: { solutionId?: string; status?: RunStatus }): Promise<import('@dsh-lab/shared').ExperimentRun[]> {
    let sql = 'SELECT * FROM runs'
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (filter?.solutionId) {
      where.push('solution_id = @solutionId')
      params.solutionId = filter.solutionId
    }
    if (filter?.status) {
      where.push('status = @status')
      params.status = filter.status
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY created_at DESC'
    const rows = this.db.prepare(sql).all(params) as Record<string, unknown>[]
    return Promise.resolve(rows.map((r) => ({ ...SqliteStore.rowToRun(r), tags: this.runTags(r.id as string) })))
  }

  getRun(id: string): Promise<import('@dsh-lab/shared').ExperimentRun | undefined> {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return Promise.resolve(row ? { ...SqliteStore.rowToRun(row), tags: this.runTags(row.id as string) } : undefined)
  }

  upsertRun(run: import('@dsh-lab/shared').ExperimentRun): Promise<void> {
    const p: Record<string, unknown> = {
      id: run.id,
      projectId: run.projectId,
      solutionId: run.solutionId,
      snapshotCommit: run.snapshotCommit,
      sourceHeadCommit: run.sourceHeadCommit,
      status: run.status,
      title: run.title ?? null,
      description: run.description ?? null,
      runProfileId: run.runProfileId ?? null,
      commandJson: JSON.stringify(run.command),
      resourcesJson: JSON.stringify(run.resources),
      environmentFingerprint: run.environmentFingerprint ?? null,
      runDir: run.runDir,
      worktreePath: run.worktreePath ?? null,
      pid: run.pid ?? null,
      pgid: run.pgid ?? null,
      exitCode: run.exitCode ?? null,
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
    }
    this.db
      .prepare(
        `INSERT INTO runs (
           id, project_id, solution_id, snapshot_commit, source_head_commit,
           status, title, description, run_profile_id, command_json,
           resources_json, environment_fingerprint, run_dir, worktree_path,
           pid, pgid, exit_code, created_at, started_at, finished_at
         ) VALUES (
           @id, @projectId, @solutionId, @snapshotCommit, @sourceHeadCommit,
           @status, @title, @description, @runProfileId, @commandJson,
           @resourcesJson, @environmentFingerprint, @runDir, @worktreePath,
           @pid, @pgid, @exitCode, @createdAt, @startedAt, @finishedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           snapshot_commit = excluded.snapshot_commit,
           source_head_commit = excluded.source_head_commit,
           command_json = excluded.command_json,
           resources_json = excluded.resources_json,
           status = excluded.status,
           title = excluded.title,
           description = excluded.description,
           environment_fingerprint = excluded.environment_fingerprint,
           run_dir = excluded.run_dir,
           worktree_path = excluded.worktree_path,
           pid = excluded.pid,
           pgid = excluded.pgid,
           exit_code = excluded.exit_code,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at`,
      )
      .run(p)
    this.db.prepare('DELETE FROM run_tags WHERE run_id = ?').run(run.id)
    for (const tag of run.tags ?? []) {
      this.db.prepare('INSERT OR IGNORE INTO run_tags (run_id, tag) VALUES (?, ?)').run(run.id, tag)
    }
    return Promise.resolve()
  }

  // ── metrics ──────────────────────────────────────────────────────────────

  upsertRunMetric(metric: RunMetric): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO run_metrics (run_id, name, value, dataset, split)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, name, dataset, split) DO UPDATE SET value = excluded.value`,
      )
      .run(metric.runId, metric.name, metric.value, metric.dataset ?? null, metric.split ?? null)
    return Promise.resolve()
  }

  listRunMetrics(runId: string): Promise<RunMetric[]> {
    const rows = this.db.prepare('SELECT * FROM run_metrics WHERE run_id = ?').all(runId) as RunMetric[]
    return Promise.resolve(rows)
  }

  // ── counters / reservations / events ─────────────────────────────────────

  /**
   * Atomically allocate the next run identity and insert its starting-row
   * skeleton: the COUNT + INSERT happen in one immediate write transaction,
   * so concurrent starters (in- or cross-process) always get distinct ids,
   * and every later GPU reservation references a run row that already
   * exists (missing-run rows are sweepable as stale).
   */
  allocateRunId(input: {
    projectId: string
    solutionId: string
    experimentsDir: string
  }): Promise<{ id: string; runDir: string }> {
    const allocate = this.db.transaction(
      (inp: { projectId: string; solutionId: string; experimentsDir: string }) => {
        const row = this.db
          .prepare("SELECT COUNT(*) AS n FROM runs WHERE id LIKE 'run-%'")
          .get() as { n: number }
        const id = `run-${String(row.n + 1).padStart(6, '0')}`
        const runDir = `${inp.experimentsDir}/${id}`
        this.db
          .prepare(
            `INSERT INTO runs (
               id, project_id, solution_id, snapshot_commit, source_head_commit,
               status, command_json, resources_json, run_dir, created_at
             ) VALUES (?, ?, ?, '', '', 'starting', '[]', '{}', ?, ?)`,
          )
          .run(id, inp.projectId, inp.solutionId, runDir, Date.now())
        return { id, runDir }
      },
    )
    return Promise.resolve(allocate.immediate(input))
  }

  /**
   * Atomically flip a run between two statuses (single UPDATE guarded by
   * the expected `from` status). False when another process won the race —
   * the queue's queued→starting claim and its requeue both ride on this.
   */
  transitionRunStatus(
    runId: string,
    from: import('@dsh-lab/shared').RunStatus,
    to: import('@dsh-lab/shared').RunStatus,
  ): Promise<boolean> {
    const result = this.db
      .prepare('UPDATE runs SET status = ? WHERE id = ? AND status = ?')
      .run(to, runId, from)
    return Promise.resolve(result.changes === 1)
  }

  listReservations(): Promise<import('@dsh-lab/shared').GpuReservation[]> {
    const rows = this.db
      .prepare('SELECT gpu_id, run_id, reserved_at FROM gpu_reservations')
      .all() as { gpu_id: number; run_id: string; reserved_at: number }[]
    return Promise.resolve(
      rows.map((r) => ({ gpuId: r.gpu_id, runId: r.run_id, reservedAt: r.reserved_at })),
    )
  }

  /**
   * All-or-nothing reservation: succeeds only when NO listed gpu is already
   * reserved. The gpu_id PK plus an immediate write transaction serialize
   * concurrent starters in- and cross-process (DESIGN §19).
   */
  tryReserveGpus(gpuIds: number[], runId: string): Promise<boolean> {
    if (gpuIds.length === 0) return Promise.resolve(true)
    const reserve = this.db.transaction((ids: number[]): boolean => {
      const placeholders = ids.map(() => '?').join(',')
      const taken = this.db
        .prepare(`SELECT gpu_id FROM gpu_reservations WHERE gpu_id IN (${placeholders})`)
        .get(...ids) as { gpu_id: number } | undefined
      if (taken) return false
      const insert = this.db.prepare(
        'INSERT INTO gpu_reservations (gpu_id, run_id, reserved_at) VALUES (?, ?, ?)',
      )
      for (const id of ids) insert.run(id, runId, Date.now())
      return true
    })
    try {
      return Promise.resolve(reserve.immediate(gpuIds))
    } catch (error) {
      // UNIQUE race lost to a concurrent transaction — the cards are taken
      if ((error as { code?: string }).code?.startsWith('SQLITE_')) return Promise.resolve(false)
      throw error
    }
  }

  /** Release every reservation held by one run (owner-correct by run_id). */
  releaseGpus(runId: string): Promise<void> {
    this.db.prepare('DELETE FROM gpu_reservations WHERE run_id = ?').run(runId)
    return Promise.resolve()
  }

  listEvents(limit?: number): Promise<import('@dsh-lab/shared').LabEvent[]> {
    const n = Math.min(limit ?? 20, 100)
    const rows = this.db
      .prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?')
      .all(n) as unknown as import('@dsh-lab/shared').LabEvent[]
    return Promise.resolve(rows)
  }

  appendEvent(event: { type: LabEventType; entityType?: 'solution' | 'run'; entityId?: string; payload?: Record<string, unknown> }): Promise<void> {
    this.db
      .prepare('INSERT INTO events (type, entity_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(event.type, event.entityType ?? null, event.entityId ?? null, event.payload ? JSON.stringify(event.payload) : null, Date.now())
    return Promise.resolve()
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = await fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
