/**
 * Workspace policy (v0.2.4+): dlab never registers solution directories as
 * DSH workspaces.
 *
 * Through v0.2.3 every init/fork/restore registered the solution directory
 * in the DSH workspace registry, so a five-direction fork dumped five
 * workspaces into the picker — three of them for directories no session was
 * ever opened in. The registration is gone; what remains is the cleanup of
 * rows that still carry a legacy `workspace_id` (ReconcileService sweep,
 * run at host boot), which must touch ONLY recorded ids — a workspace a
 * human created by hand has no row and must survive.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDeps } from '../../packages/cli/lib/cli.js'
import { SolutionService, ReconcileService } from '../../packages/core/lib/index.js'
import type { LabDeps, WorkspacePort } from '../../packages/core/lib/index.js'
import type { Solution } from '../../packages/shared/lib/index.js'

const SANDBOX = join(tmpdir(), 'dlab-workspace-policy')

let labRoot: string
let deps: LabDeps
let solutions: SolutionService
let deleted: string[]

/** Recording port: the only direction dlab still uses. */
const recordingPort: WorkspacePort = {
  async deleteWorkspace(id) {
    deleted.push(id)
  },
}

beforeAll(async () => {
  mkdirSync(SANDBOX, { recursive: true })
  labRoot = mkdtempSync(join(SANDBOX, 'lab-'))
  deleted = []
  deps = { ...makeDeps(labRoot, 'WsPolicy'), workspace: recordingPort }
  solutions = new SolutionService(deps)
  await solutions.init(labRoot, 'WsPolicy')
})

afterAll(() => {
  ;(deps.store as unknown as { close(): void }).close()
  if (labRoot) rmSync(labRoot, { recursive: true, force: true })
})

describe('fork/init never register DSH workspaces', () => {
  it('init leaves main without a workspaceId', async () => {
    const main = (await solutions.list()).find((s) => s.slug === 'main')!
    expect(main.workspaceId).toBeUndefined()
    expect(deleted).toEqual([])
  })

  it('fork creates the worktree but registers nothing', async () => {
    const forked = await solutions.fork({ sourceSolutionId: 'main', slug: 'exp-a', name: 'Exp A' })
    expect(forked.status).toBe('active')
    expect(forked.worktreePath).toBe('solutions/exp-a')
    expect(forked.workspaceId).toBeUndefined()
    expect(deleted).toEqual([])
  })
})

describe('reconcile unregisters legacy solution workspaces — and only those', () => {
  it('sweeps rows that still carry a workspaceId, idempotently', async () => {
    // two legacy rows (what v0.2.3 fork would have recorded)…
    const rows = await deps.store.listSolutions()
    const seeded: Solution[] = []
    for (const [i, slug] of ['main', 'exp-a'].entries()) {
      const row = rows.find((s) => s.slug === slug)!
      const withLegacy = { ...row, workspaceId: `ws-legacy-${i}` }
      await deps.store.upsertSolution(withLegacy)
      seeded.push(withLegacy)
    }

    const first = await new ReconcileService(deps).reconcile()
    expect(deleted.sort()).toEqual(['ws-legacy-0', 'ws-legacy-1'])
    expect(first.repaired.length).toBe(2)
    // the rows are cleared
    for (const s of await deps.store.listSolutions()) {
      expect(s.workspaceId).toBeUndefined()
    }

    // second run is a no-op
    deleted = []
    const second = await new ReconcileService(deps).reconcile()
    expect(deleted).toEqual([])
    expect(second.repaired).toEqual([])
  })
})
