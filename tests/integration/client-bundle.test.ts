/**
 * Browser-bundle smoke test: loads the REAL lib/client.js through a fake
 * window.__ModuleLoader__ with a stub react, then drives the official native
 * right-Sidebar integration:
 *   - tab type registration into ctx.sidebarRightTabs (page kind + guide entry)
 *   - tab body registration into the keyed sidebar.right.pane.tab slot
 *   - header button registration into conversation.session.header.actions
 *     (opens the tab through ctx.sidebarRight.openTab)
 * and asserts graceful behavior when slots are absent.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BUNDLE = readFileSync(join(process.cwd(), 'packages/lab-client/lib/client.js'), 'utf8')

/** Minimal createElement stub capturing the tree. An optional `stateQueue`
 *  prescribes the initial value each useState call receives in order, which
 *  lets a test render a component in a non-loading state without a real
 *  React render loop. */
function fakeReact(stateQueue: unknown[] = []) {
  const createElement = (type, props, ...children) => ({ type, props, children })
  return {
    createElement,
    Fragment: 'Fragment',
    useState: (init) => {
      let value = stateQueue.length > 0 ? stateQueue.shift() : init
      const setter = (next) => {
        value = typeof next === 'function' ? next(value) : next
      }
      return [value, setter]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
  }
}

function loadBundle(stateQueue: unknown[] = []) {
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load: (reg) => loaded.push(reg),
    },
    confirm: () => true,
    prompt: () => 'x',
    alert: () => {},
  }
  // evaluate the bundle as a script in this scope
  const fn = new Function('window', 'require', BUNDLE)
  fn(globalThis.window, (spec) => {
    if (spec === 'react') return fakeReact(stateQueue)
    if (spec === 'react-dom') return { createPortal: (el) => ({ portal: el }) }
    throw new Error(`unexpected require("${spec}")`)
  })
  return { loaded }
}

function makeCtx(overrides = {}) {
  const slotInjects = []
  const registrations = []
  const tabTypes = []
  const openedTabs: string[] = []
  const ctx = {
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    sidebarRightTabs: {
      register: (definition: { id: string }) => {
        tabTypes.push(definition)
        return () => {
          const at = tabTypes.indexOf(definition)
          if (at >= 0) tabTypes.splice(at, 1)
        }
      },
    },
    sidebarRight: {
      openTab: (kind: string) => {
        openedTabs.push(kind)
      },
    },
    slots: {
      inject: (key: string, cb: () => unknown) => {
        slotInjects.push({ key, cb })
        return () => {}
      },
      register: (spec: { id?: string; key?: string }, component: unknown) => {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    effect: (fn: () => unknown) => {
      const dispose = fn()
      ctx._effects.push(dispose)
      return dispose
    },
    get: (name: string) => ctx._services[name],
    _effects: [] as Array<() => void>,
    _services: {} as Record<string, unknown>,
    ...overrides,
  }
  ctx._registrations = registrations
  ctx._slotInjects = slotInjects
  ctx._tabTypes = tabTypes
  ctx._openedTabs = openedTabs
  return ctx
}

describe('lab-client browser bundle', () => {
  it('registers through window.__ModuleLoader__ with the package id', () => {
    const { loaded } = loadBundle()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.id).toBe('@dsh-lab/client')
    expect(typeof loaded[0]!.factory).toBe('function')
  })

  it('factory exports apply + inject', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => fakeReact())
    // note: react-dom require fires only when the overlay opens; the factory
    // itself only requires react eagerly — patch: provide both
    expect(exports).toBeTruthy()
  })

  it('factory with full require returns the plugin face', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      throw new Error(`unexpected require("${spec}")`)
    })
    expect(exports.inject).toEqual(['slots', 'connection', 'sidebarRightTabs', 'sidebarRight'])
    expect(exports.TYPE_ID).toBe('@dsh-lab/client')
    expect(exports.TAB_KIND).toBe('dsh-lab')
    expect(typeof exports.apply).toBe('function')
  })

  it('apply registers the header button into conversation.session.header.actions', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      throw new Error('unexpected')
    })
    const ctx = makeCtx()
    exports.apply(ctx)

    expect(ctx._slotInjects.map((s) => s.key)).toContain('conversation.session.header.actions')
    // fire the slot inject callback → the registration happens
    ctx._slotInjects.find((s) => s.key === 'conversation.session.header.actions')!.cb()
    const reg = ctx._registrations.find((r) => r.spec.id === 'dsh-lab')!
    expect(reg).toBeTruthy()
    expect(reg.spec.order).toBe(30)
    // the injected props carry the plugin ctx
    const props = reg.spec.inject!('s1')
    expect(props.ctx).toBe(ctx)
    expect(props.sessionId).toBe('s1')
    // the component wraps LabHeaderButton; invoke it (the fake renderer does
    // not call function components) to reach the 🧪 button element
    const wrapped = reg.component({ ctx, sessionId: 's1' }) as {
      type: (p: unknown) => { props: { onClick: () => void } }
      props: unknown
    }
    expect(wrapped).toBeTruthy()
    const el = wrapped.type(wrapped.props)
    el.props.onClick()
    expect(ctx._openedTabs).toEqual(['dsh-lab'])
  })

  it('registers the native sidebar tab type with a guide entry', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      throw new Error('unexpected')
    })
    const ctx = makeCtx()
    exports.apply(ctx)

    expect(ctx._tabTypes).toHaveLength(1)
    const def = ctx._tabTypes[0] as {
      id: string
      kind: string
      patterns?: string[]
      title: () => string
      guide: { order: number; title: () => string; description: () => string; icon: (p: { size: number }) => unknown }[]
    }
    // page type: identity + kind, no address patterns (opened by kind)
    expect(def.id).toBe('@dsh-lab/client')
    expect(def.kind).toBe('dsh-lab')
    expect(def.patterns).toBeUndefined()
    expect(def.title()).toBe('DLab')
    // guide entry: the capsule the sidebar's guide page offers
    expect(def.guide).toHaveLength(1)
    expect(def.guide[0]!.order).toBe(150)
    expect(def.guide[0]!.title()).toBe('DLab')
    expect(def.guide[0]!.description()).toBeTruthy()
    expect(def.guide[0]!.icon({ size: 22 })).toBeTruthy()
    // effect disposal (HMR / unload) unregisters the type
    ctx._effects[0]!()
    expect(ctx._tabTypes).toHaveLength(0)
  })

  it('registers the tab body into the keyed sidebar.right.pane.tab slot', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      throw new Error('unexpected')
    })
    const ctx = makeCtx()
    exports.apply(ctx)

    // fire the keyed-seat inject callback → the registration happens
    const seat = ctx._slotInjects.find((s) => s.key === 'sidebar.right.pane.tab')!
    expect(seat).toBeTruthy()
    seat.cb()
    const reg = ctx._registrations.find((r) => r.spec.key === '@dsh-lab/client') as {
      spec: { name: string; key: string; inject: (sessionId: string) => { ctx: unknown; sessionId: string } }
      component: (props: { ctx: unknown; sessionId: string; useTabInfo?: () => { tab: { visible: boolean } } }) => {
        props: { visible: boolean; scope: { cwd?: string } }
      }
    }
    expect(reg.spec.name).toBe('sidebar.right.pane.tab')
    // the injected props carry the plugin ctx + the session id
    const injected = reg.spec.inject('s1')
    expect(injected.ctx).toBe(ctx)
    expect(injected.sessionId).toBe('s1')
    // the body adapts the native useTabInfo to LabPanel props
    const el = reg.component({
      ctx,
      sessionId: 's1',
      useTabInfo: () => ({ tab: { visible: false } }),
    })
    expect(el.props.visible).toBe(false)
    expect(el.props.scope).toEqual({ cwd: undefined })
    // a missing useTabInfo degrades to visible
    const el2 = reg.component({ ctx, sessionId: 's1' })
    expect(el2.props.visible).toBe(true)
  })

  it('apply degrades gracefully without slots (no throw)', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const ctx = makeCtx()
    delete (ctx as { slots?: unknown }).slots
    expect(() => exports.apply(ctx)).not.toThrow()
  })

  it('readSessionCwd reads the sessions list summary (host-projected cwd)', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const readSessionCwd = exports.readSessionCwd as (ctx: unknown, id: string) => string | null

    // the canonical source: ctx.sessions.list snapshot byId[<id>].cwd
    const ctx = makeCtx() as unknown as { _services: Record<string, unknown> }
    ctx._services.sessions = {
      list: {
        getSnapshot: () => ({ byId: { s1: { id: 's1', cwd: '/lab/proj' } } }),
      },
    }
    expect(readSessionCwd(ctx, 's1')).toBe('/lab/proj')
    // unknown session → null
    expect(readSessionCwd(ctx, 'nope')).toBeNull()
    // a listed session with no cwd → null
    ctx._services.sessions = {
      list: { getSnapshot: () => ({ byId: { s2: { id: 's2' } } }) },
      binding: () => undefined,
      scope: () => undefined,
    }
    expect(readSessionCwd(ctx, 's2')).toBeNull()
    // no sessions service at all → null (degraded, never throws)
    delete ctx._services.sessions
    expect(readSessionCwd(ctx, 's1')).toBeNull()
  })

  it('readSessionCwd falls back to the legacy binding/scope faces', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const readSessionCwd = exports.readSessionCwd as (ctx: unknown, id: string) => string | null

    const bindingCtx = makeCtx() as unknown as { _services: Record<string, unknown> }
    bindingCtx._services.sessions = { binding: () => ({ cwd: '/legacy/binding' }) }
    expect(readSessionCwd(bindingCtx, 's1')).toBe('/legacy/binding')

    const scopeCtx = makeCtx() as unknown as { _services: Record<string, unknown> }
    scopeCtx._services.sessions = { scope: () => ({ header: { cwd: '/legacy/scope' } }) }
    expect(readSessionCwd(scopeCtx, 's1')).toBe('/legacy/scope')
  })

  it('watchSessionCwd re-notifies when the list hydrates with the cwd', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const watchSessionCwd = exports.watchSessionCwd as (
      ctx: unknown,
      id: string,
      onChange: (cwd: string | null) => void,
    ) => () => void

    // page-load race: the list is empty, then the summary arrives
    let snapshot: { byId: Record<string, { id: string; cwd?: string }> } = { byId: {} }
    let listener: (() => void) | undefined
    let unsubscribed = false
    const ctx = makeCtx() as unknown as { _services: Record<string, unknown> }
    ctx._services.sessions = {
      list: {
        getSnapshot: () => snapshot,
        subscribe: (fn: () => void) => {
          listener = fn
          return () => {
            unsubscribed = true
          }
        },
      },
    }

    const seen: Array<string | null> = []
    const stop = watchSessionCwd(ctx, 's1', (cwd) => seen.push(cwd))
    expect(seen).toEqual([])
    // unchanged snapshot → no notification
    listener!()
    expect(seen).toEqual([])
    snapshot = { byId: { s1: { id: 's1', cwd: '/lab/proj' } } }
    listener!()
    expect(seen).toEqual(['/lab/proj'])
    // idempotent: the same cwd does not re-notify
    listener!()
    expect(seen).toEqual(['/lab/proj'])
    stop()
    expect(unsubscribed).toBe(true)

    // a service without a subscribable list degrades to a no-op disposer
    const bare = makeCtx() as unknown as { _services: Record<string, unknown> }
    bare._services.sessions = { list: { getSnapshot: () => ({ byId: {} }) } }
    expect(() => watchSessionCwd(bare, 's1', () => {})()).not.toThrow()
  })

  it('workspaceMatch contains cwd in the lab root and normalizes slashes', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const match = exports.workspaceMatch as (root: string, cwd: string) => boolean | null
    expect(match('/lab/proj', '/lab/proj')).toBe(true)
    expect(match('/lab/proj', '/lab/proj/solutions/x')).toBe(true)
    expect(match('/lab/proj/', '/lab/proj/')).toBe(true)
    expect(match('/lab/proj', '/lab/other')).toBe(false)
    expect(match('/lab/proj', '/lab/proj-other')).toBe(false)
    expect(match(undefined, '/lab/proj')).toBeNull()
    expect(match('/lab/proj', undefined)).toBeNull()
  })

  it('prettyCommand renders interpreters bare and lab-root paths relative', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const pc = exports.prettyCommand as (argv: string[] | undefined, root?: string) => string
    // the noisy default run: absolute venv interpreter + absolute config
    expect(pc(
      ['/srv/project/.venv/bin/python', 'train.py', '--config', '/srv/project/configs/a.yaml'],
      '/srv/project',
    )).toBe('python train.py --config ./configs/a.yaml')
    // other interpreters collapse to their bare name
    expect(pc(['/usr/bin/python3', '-m', 'tools.eval'], null)).toBe('python3 -m tools.eval')
    expect(pc(['bash', '-c', 'echo hi'], '/lab')).toBe('bash -c echo hi')
    // absolute paths outside the root degrade to the basename
    expect(pc(['python', '/data/datasets/celebdf'], '/lab')).toBe('python celebdf')
    // relative argv passes through untouched; empty argv is empty
    expect(pc(['python', 'train.py', '--lr', '0.01'], '/lab')).toBe('python train.py --lr 0.01')
    expect(pc([], '/lab')).toBe('')
    expect(pc(undefined, '/lab')).toBe('')
    // the model title still wins: buildModel keeps r.title over the command
    const model = (exports.buildModel as (data: unknown) => {
      rows: { kind: string; lane: number; title?: string }[]
      tipRow: Record<number, number>
      runs: { title?: string }[]
    })({
      project: { name: 'proj', root: '/lab' },
      graph: { milestones: [], nodes: [{ id: 'main', role: 'main', status: 'active', branch: 'main', headCommit: 'a1' }] },
      runs: [
        { id: 'r1', solutionSlug: 'main', snapshotCommit: 'c1', status: 'succeeded', command: ['/lab/.venv/bin/python', 't.py'], title: 'my title', createdAt: 500 },
        { id: 'r2', solutionSlug: 'main', snapshotCommit: 'c2', status: 'succeeded', command: ['/lab/.venv/bin/python', 't.py'], createdAt: 400 },
      ],
      events: [],
    })
    // the graph carries no run rows; the Runs tab renders run titles, and
    // model.runs is what it reads
    expect(model.rows.some((r) => r.kind === 'run')).toBe(false)
    expect((model as unknown as { runs: { title?: string }[] }).runs.map((r) => r.title)).toContain('my title')
  })

  it('buildModel merges runs + events into lane rows (fork/merge/init)', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const buildModel = exports.buildModel as (data: unknown) => {
      rows: { kind: string; time: number; lane: number; slug: string; srcLane?: number; parentLane?: number; parent?: string; target?: string; vLabel?: string }[]
      laneCount: number
      laneOf: Record<string, number>
      botIdx: Record<number, number>
      topIdx: Record<number, number>
      topIsTerminal: Record<number, boolean>
      counts: { solutions: number; running: number }
    }

    const t0 = 1_000_000
    const model = buildModel({
      project: { name: 'proj', root: '/lab' },
      graph: {
        milestones: [{ id: 'v2', label: 'v2', metric: 0.9, source: 'exp-a' }],
        nodes: [
          { id: 'main', label: 'Main', role: 'main', status: 'active', branch: 'main', headCommit: 'a1', runCount: 1 },
          { id: 'exp-a', label: 'A', role: 'experiment', status: 'merged', branch: 'exp/exp-a', headCommit: 'b2', parent: 'main', mergedInto: 'main', runCount: 2, lastRunAt: t0 + 40 },
        ],
      },
      runs: [
        { id: 'run_2', solutionSlug: 'exp-a', snapshotCommit: 'c3456789', status: 'succeeded', command: ['python'], createdAt: t0 + 40, durationMs: 65000 },
        { id: 'run_1', solutionSlug: 'main', snapshotCommit: 'd456789a', status: 'succeeded', command: ['python'], createdAt: t0 + 20, durationMs: 1000 },
      ],
      events: [
        { time: t0 + 60, type: 'SolutionMerged', entityId: 'exp-a' },
        { time: t0 + 10, type: 'SolutionForked', entityId: 'exp-a' },
      ],
    })

    // lanes: main = 0, the one experiment = 1
    expect(model.laneCount).toBe(2)
    expect(model.laneOf['main']).toBe(0)
    expect(model.laneOf['exp-a']).toBe(1)
    expect(model.counts).toEqual({ solutions: 2, running: 0, foldable: 0 })

    // lifecycle only, newest first: merge (t0+60), fork (t0+10), init —
    // runs are NOT history rows (they live in the Runs tab)
    expect(model.rows.map((r) => r.kind)).toEqual(['merge', 'fork', 'init'])
    expect(model.rows[0]!.lane).toBe(0) // merge dot lands on main
    expect(model.rows[0]!.srcLane).toBe(1)
    expect(model.rows[0]!.vLabel).toBe('v2')
    expect(model.rows[1]!.kind).toBe('fork')
    expect(model.rows[1]!.parentLane).toBe(0)
    expect(model.rows[2]!.kind).toBe('init')

    // lane 1 spans from its fork row (bottom) to its merge row (top)
    expect(model.topIdx[1]).toBe(0)
    expect(model.botIdx[1]).toBe(1)
    // its top end is a terminal (merge) row → through-line enters from above
    expect(model.topIsTerminal[1]).toBe(true)
    // main's tip is always a main-lane row, never the experiment's lane
    expect(model.rows[model.tipRow[0]!]!.lane).toBe(0)
  })

  it('buildModel synthesizes missing event times and hands lanes out by fork time', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const buildModel = exports.buildModel as (data: unknown) => {
      rows: { kind: string; lane: number; slug: string }[]
      laneOf: Record<string, number>
      topIsTerminal: Record<number, boolean>
      counts: { solutions: number; running: number }
    }

    const model = buildModel({
      project: { name: 'proj', root: '/lab' },
      graph: {
        milestones: [],
        nodes: [
          { id: 'main', role: 'main', status: 'active', branch: 'main', headCommit: 'a1' },
          // forked later but has older runs → should still sort by fork time
          { id: 'late', role: 'experiment', status: 'active', branch: 'exp/late', headCommit: 'b1', parent: 'main', lastRunAt: 500 },
          { id: 'early', role: 'experiment', status: 'active', branch: 'exp/early', headCommit: 'c1', parent: 'main', lastRunAt: 100 },
        ],
      },
      runs: [
        { id: 'run_l', solutionSlug: 'late', snapshotCommit: 'x1', status: 'running', command: [], createdAt: 500 },
        { id: 'run_e', solutionSlug: 'early', snapshotCommit: 'x2', status: 'succeeded', command: [], createdAt: 100 },
      ],
      events: [],
    })

    // Lanes are handed out NEWEST-INNERMOST: the later fork takes the column
    // next to the trunk, the earlier one moves out. A branch connector then
    // never has to cross a rail that was already there.
    expect(model.laneOf['late']).toBe(1)
    expect(model.laneOf['early']).toBe(2)
    expect(model.counts.running).toBe(1)
    // every experiment gets a synthesized fork row; init is the last row
    const kinds = model.rows.map((r) => r.kind)
    expect(kinds.filter((k) => k === 'fork')).toHaveLength(2)
    expect(kinds[kinds.length - 1]).toBe('init')
    // an open line has no terminal, so its lane top stays open
    expect(model.topIsTerminal[1]).toBe(false)
    expect(model.topIsTerminal[2]).toBe(false)
    // main keeps its own tip even though the experiments are newer
    expect(model.rows[model.tipRow[0]!]!.lane).toBe(0)
  })

  it('extends an active line\u2019s rail to the newest row, and a parent\u2019s to its child', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const buildModel = exports.buildModel as (data: unknown) => {
      rows: { kind: string; lane: number; slug: string; parentLane?: number }[]
      laneOf: Record<string, number>
      botIdx: Record<number, number>
      topIdx: Record<number, number>
      colorOf: (slug: string) => string
    }

    const T = Date.UTC(2026, 0, 1)
    const model = buildModel({
      project: { name: 'proj', root: '/lab' },
      graph: {
        milestones: [],
        nodes: [
          { id: 'main', role: 'main', status: 'active', branch: 'main', headCommit: 'a1', createdAt: T },
          { id: 'parent', role: 'experiment', status: 'active', branch: 'exp/parent', headCommit: 'b1', parent: 'main', createdAt: T + 100 },
          { id: 'child', role: 'experiment', status: 'active', branch: 'exp/child', headCommit: 'c1', parent: 'parent', createdAt: T + 200 },
          // merged: its rail stops at the merge row, it is not alive any more
          { id: 'done', role: 'experiment', status: 'merged', branch: 'exp/done', headCommit: 'd1', parent: 'main', mergedInto: 'main', createdAt: T + 50, mergedAt: T + 300 },
        ],
      },
      runs: [],
      events: [],
    })

    // rows (newest first): merge done, fork child, fork parent, fork done, init
    const kinds = model.rows.map((r) => `${r.kind}:${r.slug}`)
    expect(kinds).toEqual(['merge:done', 'fork:child', 'fork:parent', 'fork:done', 'init:main'])

    // an active line runs to the top row (it is still alive)
    expect(model.topIdx[model.laneOf['parent']]).toBe(0)
    expect(model.topIdx[model.laneOf['child']]).toBe(0)
    // a merged line stops at its merge row, which is row 0 here as well
    expect(model.topIdx[model.laneOf['done']]).toBe(0)
    // every rail starts at or above its own fork row
    for (const slug of ['parent', 'child', 'done']) {
      expect(model.topIdx[model.laneOf[slug]]).toBeLessThanOrEqual(model.botIdx[model.laneOf[slug]])
    }
    // the child's connector leaves its parent's lane, not the trunk
    const childRow = model.rows.find((r) => r.slug === 'child')!
    expect(childRow.parentLane).toBe(model.laneOf['parent'])
    // colour follows fork order, never the lane index
    expect(model.colorOf('done')).not.toBe(model.colorOf('parent'))
    expect(model.colorOf('done')).not.toBe(model.colorOf('main'))
  })

  it('the panel exposes the Docs tab reading the shared docs over RPC', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const src = BUNDLE
    // the tab is reachable and only ever reads (no write endpoint is called)
    expect(src).toMatch(/\['docs',\s*'Docs'/)
    expect(src).toContain("call('docs.list')")
    expect(src).toContain("call('docs.read'")
    expect(src).not.toContain("call('docs.write'")
    expect(typeof exports.apply).toBe('function')
  })

  it('buildModel returns a safe empty model without data', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const buildModel = exports.buildModel as (data: unknown) => { rows: unknown[]; laneCount: number }
    expect(buildModel(null).rows).toHaveLength(0)
    expect(buildModel(null).laneCount).toBe(1)
  })
})

/**
 * The evolution list dated every fork "1 Jan 1970": a fork row with no event
 * fell back to `lastRunAt - 1` (undefined → -1), and an unset timestamp
 * formats as the epoch. These tests pin the real pipeline — solution rows
 * carry the lifecycle timestamps, events may arrive in either shape, and a
 * pre-2000 value is never rendered as a date.
 */
describe('lab-client dates (a fork is never dated 1970)', () => {
  function loadExports() {
    const { loaded } = loadBundle()
    return loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error(`unexpected require("${spec}")`)
    })
  }

  type Row = { kind: string; time: number; lane: number; slug: string }
  type Model = {
    rows: Row[]
    bySlug: Record<string, { metric?: number; metricKey?: string; delta?: number }>
    metricsBySlug: Record<string, Record<string, number>>
  }

  /** A timestamp below the 2000 floor must never be rendered. */
  const EPOCH_FLOOR = 946684800000

  it('fmtDate blanks the epoch and renders real timestamps', () => {
    const fmtDate = loadExports().fmtDate as (ts: unknown) => string
    expect(fmtDate(0)).toBe('')
    expect(fmtDate(-1)).toBe('')
    expect(fmtDate(undefined)).toBe('')
    expect(fmtDate(null)).toBe('')
    expect(fmtDate('nope')).toBe('')
    // a real commit time renders as a day + month (never 1970)
    const t = Date.UTC(2026, 8, 15, 3, 2)
    expect(fmtDate(t)).toMatch(/^1[45] Sep/)
    expect(fmtDate(t)).not.toContain('1970')
  })

  it('normalizeEvent accepts the mapped LabEvent and a raw store row', () => {
    const normalizeEvent = loadExports().normalizeEvent as (e: unknown) => {
      time?: number
      type: string
      entityId?: string
      payload: Record<string, unknown>
    }
    const mapped = normalizeEvent({
      type: 'SolutionForked', entityId: 'solution_1',
      payloadJson: '{"branch":"exp/a"}', createdAt: 1_700_000_000_000,
    })
    expect(mapped.time).toBe(1_700_000_000_000)
    expect(mapped.entityId).toBe('solution_1')
    expect(mapped.payload.branch).toBe('exp/a')

    // an older adapter leaks the raw SQLite columns through
    const raw = normalizeEvent({
      type: 'SolutionForked', entity_id: 'solution_2',
      payload_json: '{"branch":"exp/b"}', created_at: 1_700_000_000_001,
    })
    expect(raw.time).toBe(1_700_000_000_001)
    expect(raw.entityId).toBe('solution_2')
    expect(raw.payload.branch).toBe('exp/b')
  })

  it('dates a fork from the solution row when no lifecycle event exists', () => {
    const buildModel = loadExports().buildModel as (data: unknown) => Model
    const forkedAt = Date.UTC(2026, 8, 15, 3, 2)
    const initedAt = forkedAt - 60_000
    const model = buildModel({
      project: { name: 'PRD', root: '/lab/PRD' },
      graph: {
        milestones: [],
        nodes: [
          { id: 'main', role: 'main', status: 'active', branch: 'main', headCommit: 'a1' },
          { id: 'exp-a', role: 'experiment', status: 'active', branch: 'exp/exp-a', headCommit: 'b1', parent: 'main' },
        ],
      },
      runs: [],
      events: [],
      solutions: [
        { id: 'solution_main', slug: 'main', role: 'main', status: 'active', branch: 'main', createdAt: initedAt, updatedAt: forkedAt },
        { id: 'solution_a', slug: 'exp-a', role: 'experiment', status: 'active', branch: 'exp/exp-a', parentSolutionId: 'solution_main', createdAt: forkedAt, updatedAt: forkedAt },
      ],
    })

    const fork = model.rows.find((r) => r.kind === 'fork')!
    const init = model.rows.find((r) => r.kind === 'init')!
    expect(fork.time).toBe(forkedAt)
    expect(init.time).toBe(initedAt)
    // newest first, and nothing lands in the epoch
    expect(model.rows.map((r) => r.kind)).toEqual(['fork', 'init'])
    expect(model.rows.every((r) => r.time >= EPOCH_FLOOR)).toBe(true)
  })

  it('resolves lifecycle events by solution id and dates a merge from the row', () => {
    const buildModel = loadExports().buildModel as (data: unknown) => Model
    const t0 = Date.UTC(2026, 8, 15, 3, 2)
    const mergedAt = t0 + 30_000
    const model = buildModel({
      project: { name: 'PRD', root: '/lab/PRD' },
      graph: {
        milestones: [{ id: 'v2', label: 'v2', source: 'exp-a' }],
        nodes: [
          { id: 'main', role: 'main', status: 'active', branch: 'main', headCommit: 'a1' },
          { id: 'exp-a', role: 'experiment', status: 'merged', branch: 'exp/exp-a', headCommit: 'b1', parent: 'main', mergedInto: 'main' },
        ],
      },
      runs: [],
      // the event names the solution ID, the lane is keyed by slug: the panel
      // has to translate, or every row falls back to the epoch
      events: [{ type: 'SolutionForked', entityId: 'solution_a', createdAt: t0 }],
      solutions: [
        { id: 'solution_main', slug: 'main', role: 'main', status: 'active', branch: 'main', createdAt: t0 - 60_000, updatedAt: mergedAt },
        { id: 'solution_a', slug: 'exp-a', role: 'experiment', status: 'merged', branch: 'exp/exp-a', parentSolutionId: 'solution_main', createdAt: t0, updatedAt: mergedAt, mergedAt },
      ],
    })

    // fork from its event (id → slug), merge from the row's mergedAt
    expect(model.rows.map((r) => r.kind)).toEqual(['merge', 'fork', 'init'])
    expect(model.rows.find((r) => r.kind === 'fork')!.time).toBe(t0)
    expect(model.rows.find((r) => r.kind === 'merge')!.time).toBe(mergedAt)
    expect(model.rows.every((r) => r.time >= EPOCH_FLOOR)).toBe(true)
  })

  it('dates forks from branch-carrying events when the host projects no timestamps', () => {
    // The shape a running host serves before the lifecycle timestamps are
    // projected: raw snake_case event rows and solution rows without dates.
    // The payload's `exp/<slug>` branch is the only handle on the lane.
    const buildModel = loadExports().buildModel as (data: unknown) => Model
    const t0 = Date.UTC(2026, 8, 15, 3, 2)
    const model = buildModel({
      project: { name: 'PRD', root: '/lab/PRD' },
      graph: {
        milestones: [],
        nodes: [
          { id: 'main', role: 'main', status: 'active', branch: 'main', headCommit: 'a1' },
          { id: 'exp-a', role: 'experiment', status: 'active', branch: 'exp/exp-a', headCommit: 'b1', parent: 'main' },
        ],
      },
      runs: [],
      events: [
        { type: 'SolutionForked', entity_type: 'solution', entity_id: 'solution_main', payload_json: '{"init":true}', created_at: t0 - 60_000 },
        { type: 'SolutionForked', entity_type: 'solution', entity_id: 'solution_a', payload_json: '{"branch":"exp/exp-a"}', created_at: t0 },
      ],
      solutions: [
        { id: 'solution_main', slug: 'main', branch: 'main' },
        { id: 'solution_a', slug: 'exp-a', branch: 'exp/exp-a' },
      ],
    })

    expect(model.rows.map((r) => r.kind)).toEqual(['fork', 'init'])
    expect(model.rows.find((r) => r.kind === 'fork')!.time).toBe(t0)
    expect(model.rows.find((r) => r.kind === 'init')!.time).toBe(t0 - 60_000)
    expect(model.rows.every((r) => r.time >= EPOCH_FLOOR)).toBe(true)
  })

  it('surfaces the newest succeeded run metrics as the solution metric', () => {
    const buildModel = loadExports().buildModel as (data: unknown) => Model
    const model = buildModel({
      project: { name: 'PRD', root: '/lab/PRD' },
      graph: { milestones: [], nodes: [{ id: 'main', role: 'main', status: 'active', branch: 'main', headCommit: 'a1' }] },
      runs: [
        { id: 'run_1', solutionSlug: 'main', status: 'succeeded', createdAt: 1_700_000_000_000, summaryMetrics: { acc: 0.8 } },
        { id: 'run_2', solutionSlug: 'main', status: 'succeeded', createdAt: 1_700_000_100_000, summaryMetrics: { acc: 0.9 } },
        { id: 'run_3', solutionSlug: 'main', status: 'failed', createdAt: 1_700_000_200_000, summaryMetrics: { acc: 0.1 } },
      ],
      events: [],
    })
    // the failed run is newer, but only a succeeded run is evidence
    expect(model.metricsBySlug['main']).toEqual({ acc: 0.9 })
    expect(model.bySlug['main']!.metric).toBe(0.9)
    expect(model.bySlug['main']!.metricKey).toBe('acc')
  })
})

/**
 * Render smoke for the panel bodies. The pure builder tests above never
 * execute the components, so a typo inside the new card/chip layout would
 * only show up in the browser; this walks each surface with a fake React,
 * invoking function components the way React would.
 */
describe('lab-client render smoke', () => {
  function loadExports() {
    const { loaded } = loadBundle()
    return loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error(`unexpected require("${spec}")`)
    })
  }

  /** Depth-first walk that INVOKES function components, collecting strings. */
  function walk(node: unknown, out: string[]): void {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out)
      return
    }
    const el = node as { type: unknown; props: Record<string, unknown> | null; children: unknown[] }
    if (typeof el.type === 'function') {
      const kids = el.children.length === 1 ? el.children[0] : el.children
      const rendered = (el.type as (p: unknown) => unknown)({ ...(el.props ?? {}), children: kids })
      walk(rendered, out)
      return
    }
    for (const child of el.children || []) walk(child, out)
  }

  function sample() {
    const ex = loadExports() as Record<string, unknown>
    const buildModel = ex.buildModel as (data: unknown) => Record<string, any>
    const t0 = Date.UTC(2026, 8, 15, 3, 2)
    const model = buildModel({
      project: { name: 'PRD', root: '/home/x/PRD' },
      graph: {
        milestones: [{ id: 'v2', label: 'v2', source: 'exp-a' }],
        nodes: [
          { id: 'main', label: 'Main', role: 'main', status: 'active', branch: 'main', headCommit: 'f72183b0', runCount: 3 },
          {
            id: 'exp-a', label: '实验 A', role: 'experiment', status: 'active', branch: 'exp/exp-a',
            headCommit: 'c0eb803c', parent: 'main', runCount: 1, dirty: true,
            description: 'a line of work', hypothesis: 'it will hold', conclusion: undefined,
          },
          { id: 'exp-b', label: 'B', role: 'experiment', status: 'merged', branch: 'exp/exp-b', headCommit: 'b2', parent: 'main', mergedInto: 'main', runCount: 2 },
        ],
      },
      runs: [
        { id: 'run_1', solutionSlug: 'main', status: 'succeeded', createdAt: t0, durationMs: 65_000, summaryMetrics: { acc: 0.91 }, title: 'main sweep', command: ['python', 't.py'], runDir: '/x/run-1' },
        { id: 'run_2', solutionSlug: 'exp-a', status: 'running', createdAt: t0 + 1000, durationMs: 1200, gpuIds: [0], tags: ['lr=0.01', 'sweep/a'] },
      ],
      events: [
        { type: 'SolutionForked', entity_id: 'solution_a', payload_json: '{"branch":"exp/exp-a"}', created_at: t0 },
        { type: 'RunStarted', entityId: 'run_2', createdAt: t0 + 1000 },
      ],
      solutions: [
        { id: 'solution_main', slug: 'main', role: 'main', status: 'active', branch: 'main', createdAt: t0 - 10_000, updatedAt: t0 },
        {
          id: 'solution_a', slug: 'exp-a', role: 'experiment', status: 'active', branch: 'exp/exp-a',
          parentSolutionId: 'solution_main', createdAt: t0, updatedAt: t0, hypothesis: 'it will hold', mergedAt: undefined, archivedAt: undefined,
        },
      ],
      resources: {
        gpus: [{ id: 0, model: 'RTX 4090', freeVramMB: 23_500, totalVramMB: 24_564, runningRunIds: [] }],
        queued: [],
        polledAt: t0,
      },
    })
    return { ex, model }
  }

  it('renders the overview summary, a solution detail and a run detail', () => {
    const { ex, model } = sample()
    const OverviewTab = ex.renderers.OverviewTab as (p: unknown) => unknown
    const call = () => Promise.resolve({ ok: true, value: {} })
    const base = { model, selected: null, onPickSolution: () => {}, onBack: () => {}, onFollow: () => {}, call, width: 520 }

    const summary: string[] = []
    expect(() => walk(OverviewTab({ ...base }), summary)).not.toThrow()
    const summaryText = summary.join(' ')
    expect(summaryText).toContain('PRD')
    expect(summaryText).toContain('/home/x/PRD')
    expect(summaryText).toContain('实验 A')
    expect(summaryText).toContain('GPUs')

    const solOut: string[] = []
    expect(() => walk(OverviewTab({ ...base, selected: { kind: 'solution', slug: 'exp-a' } }), solOut)).not.toThrow()
    const solText = solOut.join(' ')
    expect(solText).toContain('Promotion')
    expect(solText).toContain('Details')
    expect(solText).toContain('exp/exp-a')
    expect(solText).not.toContain('1970')
    // a fork is dated from the solution row
    expect(solText).toMatch(/1[45] Sep/)

    const runOut: string[] = []
    expect(() => walk(OverviewTab({ ...base, selected: { kind: 'run', run: model.runs![0] } }), runOut)).not.toThrow()
    const runText = runOut.join(' ')
    expect(runText).toContain('Metrics')
    expect(runText).toContain('acc = 0.91')
    expect(runText).toContain('/x/run-1')
    expect(runText).not.toContain('1970')
  })

  it('renders every evolution row, the runs / activity / docs tabs and the gate', () => {
    const { ex, model } = sample()
    const call = () => Promise.resolve({ ok: true, value: {} })

    const Row = ex.renderers.Row as (p: unknown) => unknown
    model.rows!.forEach((row: unknown, i: number) => {
      const out: string[] = []
      expect(() => walk(Row({ model, row, index: i, selected: i, width: 520, onSelect: () => {} }), out)).not.toThrow()
      expect(out.join(' ')).not.toContain('1970')
    })

    const RunsTab = ex.renderers.RunsTab as (p: unknown) => unknown
    const runsOut: string[] = []
    expect(() => walk(RunsTab({ model, selected: { kind: 'run', run: model.runs![1] }, onPick: () => {} }), runsOut)).not.toThrow()
    // folded by default: the headers (and counts) render, the run rows do not
    const runsText = runsOut.join(' ')
    expect(runsText).toContain('exp-a')
    expect(runsText).toContain('expand all')
    expect(runsText).not.toContain('1970')

    const ActivityTab = ex.renderers.ActivityTab as (p: unknown) => unknown
    const actOut: string[] = []
    expect(() => walk(ActivityTab({ model }), actOut)).not.toThrow()
    const actText = actOut.join(' ')
    // the raw snake_case row still yields a readable, dated entry
    expect(actText).toContain('exp-a forked')
    expect(actText).toContain('run started: run_2')
    expect(actText).not.toContain('1970')

    const MergeGate = ex.renderers.MergeGate as (p: unknown) => unknown
    expect(() => walk(MergeGate({ sol: model.bySlug!['exp-a'], runs: model.runs }), [])).not.toThrow()
    expect(() => walk(MergeGate({ sol: model.bySlug!['main'], runs: model.runs }), [])).not.toThrow()

    const ResourceSection = ex.renderers.ResourceSection as (p: unknown) => unknown
    expect(() => walk(ResourceSection({ resources: model.resources, twoCol: true }), [])).not.toThrow()

    const DocsTab = ex.renderers.DocsTab as (p: unknown) => unknown
    expect(() => walk(DocsTab({ call }), [])).not.toThrow()
  })
})

/**
 * Scoped views: with a solution selected, the evolution list draws only that
 * line and its descendants, and the Runs / Docs tabs follow the same
 * selection. Clicking a GPU instead narrows Runs to the runs of that card.
 */
describe('lab-client scoped tree + per-solution runs', () => {
  const T0 = Date.UTC(2026, 8, 15, 3, 2)

  function loadExports(stateQueue: unknown[] = []) {
    const { loaded } = loadBundle(stateQueue)
    return loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact(stateQueue)
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error(`unexpected require("${spec}")`)
    })
  }

  function walk(node: unknown, out: string[]): void {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
    if (Array.isArray(node)) { for (const child of node) walk(child, out); return }
    const el = node as { type: unknown; props: Record<string, unknown> | null; children: unknown[] }
    if (typeof el.type === 'function') {
      const kids = el.children.length === 1 ? el.children[0] : el.children
      walk((el.type as (p: unknown) => unknown)({ ...(el.props ?? {}), children: kids }), out)
      return
    }
    for (const child of el.children || []) walk(child, out)
  }

  type ScopedModel = {
    rows: { kind: string; slug: string; lane: number; parentLane: number; time: number }[]
    scoped: boolean
    focus: string | null
    mainBranch: string
    laneOf: Record<string, number>
    laneCount: number
    colorOf: (slug: string) => string
  }

  const data = {
    project: { name: 'PRD', root: '/lab/PRD' },
    graph: {
      milestones: [],
      nodes: [
        { id: 'main', role: 'main', status: 'active', branch: 'main', headCommit: 'a1' },
        { id: 'exp-a', role: 'experiment', status: 'active', branch: 'exp/exp-a', headCommit: 'b1', parent: 'main' },
        { id: 'exp-b', role: 'experiment', status: 'active', branch: 'exp/exp-b', headCommit: 'c1', parent: 'exp-a' },
        { id: 'exp-c', role: 'experiment', status: 'active', branch: 'exp/exp-c', headCommit: 'd1', parent: 'main' },
      ],
    },
    runs: [],
    events: [],
    solutions: [
      { id: 's_main', slug: 'main', role: 'main', status: 'active', branch: 'main', createdAt: T0 - 5000 },
      { id: 's_a', slug: 'exp-a', role: 'experiment', status: 'active', branch: 'exp/exp-a', createdAt: T0 },
      { id: 's_b', slug: 'exp-b', role: 'experiment', status: 'active', branch: 'exp/exp-b', parentSolutionId: 's_a', createdAt: T0 + 1000 },
      { id: 's_c', slug: 'exp-c', role: 'experiment', status: 'active', branch: 'exp/exp-c', createdAt: T0 + 2000 },
    ],
  }

  it('scopes the evolution list to the selected line and its descendants', () => {
    const buildModel = loadExports().buildModel as (d: unknown, o?: unknown) => ScopedModel
    const model = buildModel(data, { focus: 'exp-a' })

    expect(model.scoped).toBe(true)
    expect(model.focus).toBe('exp-a')
    // only exp-a and the line forked from it — exp-c (a sibling) is out
    expect(model.rows.map((r) => r.slug)).toEqual(['exp-b', 'exp-a'])
    expect(model.rows.every((r) => r.kind === 'fork')).toBe(true)
    // no mainline init row in a scoped view
    expect(model.rows.some((r) => r.kind === 'init')).toBe(false)
    // the focused line is the trunk (lane 0); its child hangs off lane 0
    expect(model.rows.find((r) => r.slug === 'exp-a')!.lane).toBe(0)
    const child = model.rows.find((r) => r.slug === 'exp-b')!
    expect(child.lane).toBe(1)
    expect(child.parentLane).toBe(0)
    // the focus's own parent (main) is outside the scope → no connector
    expect(model.rows.find((r) => r.slug === 'exp-a')!.parentLane).toBe(-1)
    expect(model.laneCount).toBe(2)
    // the header still names the mainline
    expect(model.mainBranch).toBe('main')
  })

  it('keeps the whole tree when nothing (or main) is focused', () => {
    const buildModel = loadExports().buildModel as (d: unknown, o?: unknown) => ScopedModel
    const full = buildModel(data)
    const main = buildModel(data, { focus: 'main' })
    expect(full.scoped).toBe(false)
    expect(main.scoped).toBe(false)
    expect(full.rows.map((r) => r.slug)).toEqual(main.rows.map((r) => r.slug))
    // main + three experiments, init last
    expect(full.rows.filter((r) => r.kind === 'fork')).toHaveLength(3)
    expect(full.rows[full.rows.length - 1]!.kind).toBe('init')
    // an unknown focus degrades to the full tree
    expect(buildModel(data, { focus: 'nope' }).scoped).toBe(false)
  })

  it('keeps a line\u2019s identity colour across scoped and full views', () => {
    const buildModel = loadExports().buildModel as (d: unknown, o?: unknown) => ScopedModel
    const full = buildModel(data)
    const scoped = buildModel(data, { focus: 'exp-c' })
    expect(scoped.scoped).toBe(true)
    expect(scoped.laneOf['exp-c']).toBe(0)
    // same colour as in the full tree, even though its lane index changed
    expect(scoped.colorOf('exp-c')).toBe(full.colorOf('exp-c'))
    expect(scoped.colorOf('exp-c')).not.toBe(full.colorOf('main'))
  })

  it('folds the Runs tab per solution, live lines first, with a GPU banner', () => {
    const ex = loadExports() as Record<string, unknown>
    const buildModel = ex.buildModel as (d: unknown, o?: unknown) => Record<string, any>
    const model = buildModel({
      ...data,
      runs: [
        { id: 'run_1', solutionSlug: 'main', status: 'succeeded', createdAt: T0, command: ['python'], title: 'main run' },
        { id: 'run_2', solutionSlug: 'exp-a', status: 'running', createdAt: T0 + 10, command: ['python'], title: 'live run', gpuIds: [0] },
      ],
      resources: { gpus: [{ id: 0, model: 'RTX 4090', freeVramMB: 100, totalVramMB: 1000, runningRunIds: ['run_2'] }], queued: [], polledAt: T0 },
    })
    const RunsTab = ex.renderers.RunsTab as (p: unknown) => unknown

    // lab-wide list: folded by default — headers + counts, no run rows
    const closedOut: string[] = []
    const runs = [model.runs[1], model.runs[0]]
    walk(RunsTab({ model, runs, selected: null, onPick: () => {} }), closedOut)
    const closed = closedOut.join(' | ')
    expect(closed).toContain('exp-a')
    expect(closed).toContain('main')
    expect(closed).toContain('1 running')
    expect(closed).toContain('2 lines \u00b7 2 runs \u00b7 1 running')
    expect(closed).toContain('expand all')
    expect(closed).not.toContain('live run')
    expect(closed).not.toContain('1970')
    // both solution headers rendered (chevron each), exp-a (live) ahead of main
    expect(closedOut.filter((s) => s === '\u25be')).toHaveLength(0)
    expect(closedOut.filter((s) => s === '\u25b8')).toHaveLength(2)
    expect(closed.indexOf('exp-a')).toBeLessThan(closed.indexOf('main'))

    // a line the user opened shows its runs; the rest stay folded
    const openEx = loadExports([{ 'exp-a': true }]) as Record<string, unknown>
    const OpenRunsTab = openEx.renderers.RunsTab as (p: unknown) => unknown
    const openModel = (openEx.buildModel as (d: unknown) => Record<string, any>)({
      ...data,
      runs: [
        { id: 'run_1', solutionSlug: 'main', status: 'succeeded', createdAt: T0, command: ['python'], title: 'main run' },
        { id: 'run_2', solutionSlug: 'exp-a', status: 'running', createdAt: T0 + 10, command: ['python'], title: 'live run', gpuIds: [0] },
      ],
      resources: { gpus: [{ id: 0, model: 'RTX 4090', freeVramMB: 100, totalVramMB: 1000, runningRunIds: ['run_2'] }], queued: [], polledAt: T0 },
    })
    const openOut: string[] = []
    walk(OpenRunsTab({ model: openModel, runs: [openModel.runs[1], openModel.runs[0]], selected: null, onPick: () => {} }), openOut)
    const openText = openOut.join(' | ')
    expect(openText).toContain('live run')
    expect(openText).toContain('expand all') // main is still folded
    expect(openOut.filter((s) => s === '\u25be')).toHaveLength(1)
    expect(openOut.filter((s) => s === '\u25b8')).toHaveLength(1)

    // every line open → the toolbar offers the inverse
    const allEx = loadExports([{ 'exp-a': true, main: true }]) as Record<string, unknown>
    const AllRunsTab = allEx.renderers.RunsTab as (p: unknown) => unknown
    const allModel = (allEx.buildModel as (d: unknown) => Record<string, any>)({
      ...data,
      runs: [
        { id: 'run_1', solutionSlug: 'main', status: 'succeeded', createdAt: T0, command: ['python'], title: 'main run' },
        { id: 'run_2', solutionSlug: 'exp-a', status: 'running', createdAt: T0 + 10, command: ['python'], title: 'live run', gpuIds: [0] },
      ],
      resources: { gpus: [{ id: 0, model: 'RTX 4090', freeVramMB: 100, totalVramMB: 1000, runningRunIds: ['run_2'] }], queued: [], polledAt: T0 },
    })
    const allOut: string[] = []
    walk(AllRunsTab({ model: allModel, runs: allModel.runs, selected: null, onPick: () => {} }), allOut)
    expect(allOut.join(' | ')).toContain('collapse all')
    expect(allOut.filter((s) => s === '\u25be')).toHaveLength(2)

    // GPU filter banner names the card, counts what is live, and clears
    // (and the filtered line opens itself: the runs ARE the answer)
    const gpuOut: string[] = []
    walk(RunsTab({
      model, runs: [model.runs[1]], selected: null, onPick: () => {},
      gpu: model.resources.gpus[0], onClearGpu: () => {},
    }), gpuOut)
    const gpuText = gpuOut.join(' | ')
    expect(gpuText).toContain('GPU0')
    expect(gpuText).toContain('clear \u00d7')
    expect(gpuText).toContain('1 running')
    expect(gpuText).toContain('live run')
    expect(gpuOut.filter((s) => s === '\u25be')).toHaveLength(1)

    // scoped to one line: a single solution header, open by default
    const scopedOut: string[] = []
    walk(RunsTab({ model, runs: [model.runs[1]], selected: null, onPick: () => {}, scopeSlug: 'exp-a' }), scopedOut)
    expect(scopedOut.filter((s) => s === '\u25b8')).toHaveLength(0)
    expect(scopedOut.join(' | ')).toContain('live run')
    // no lab-wide toolbar when the tab is one solution
    expect(scopedOut.join(' | ')).not.toContain('expand all')
  })

  it('keeps only what is running on a card under a GPU filter', () => {
    const ex = loadExports() as Record<string, unknown>
    const buildModel = ex.buildModel as (d: unknown, o?: unknown) => Record<string, any>
    const model = buildModel({
      ...data,
      runs: [
        { id: 'run_live', solutionSlug: 'exp-a', status: 'running', createdAt: T0 + 30, command: ['python'], gpuIds: [0] },
        { id: 'run_starting', solutionSlug: 'exp-a', status: 'starting', createdAt: T0 + 20, command: ['python'], gpuIds: [0] },
        // settled: ran on GPU0 historically, must NOT show under the filter
        { id: 'run_past', solutionSlug: 'main', status: 'succeeded', createdAt: T0, command: ['python'], gpuIds: [0] },
        // live, but on a different card
        { id: 'run_other_gpu', solutionSlug: 'main', status: 'running', createdAt: T0 + 10, command: ['python'], gpuIds: [3] },
        // queued: holds no card yet
        { id: 'run_queued', solutionSlug: 'main', status: 'queued', createdAt: T0 + 40, command: ['python'] },
      ],
      resources: { gpus: [{ id: 0, model: 'RTX 4090', freeVramMB: 100, totalVramMB: 1000, runningRunIds: ['run_live'] }], queued: [], polledAt: T0 },
    })
    const runsOnGpu = ex.runsOnGpu as (m: unknown, id: number | null) => Record<string, boolean> | null

    // no filter → null (the caller keeps every run)
    expect(runsOnGpu(model, null)).toBeNull()

    const on0 = runsOnGpu(model, 0)!
    expect(on0['run_live']).toBe(true)      // reserved on the card
    expect(on0['run_starting']).toBe(true)  // live and assigned it
    expect(on0['run_past']).toBeUndefined() // finished long ago
    expect(on0['run_other_gpu']).toBeUndefined()
    expect(on0['run_queued']).toBeUndefined()

    const on3 = runsOnGpu(model, 3)!
    expect(on3['run_other_gpu']).toBe(true)
    expect(on3['run_live']).toBeUndefined()
  })

  it('folds the shared inventory under a scoped solution, keeping its own notes on top', () => {
    const t0 = T0
    const sharedDocs = [
      { path: 'charter.md', size: 2048, mtime: t0 },
      { path: 'local/exp-a/conclusion.md', size: 700, mtime: t0 },
      { path: 'local/exp-b/conclusion.md', size: 700, mtime: t0 },
    ]
    const call = () => Promise.resolve({ ok: true, value: {} })
    const node = {
      // a solution's `docs` is a link to the shared tree, so a host that still
      // reports it as localDocs must not turn those into private notes
      localDocs: [
        { path: 'notes/plan.md', size: 120, mtime: t0 },
        { path: 'docs/charter.md', size: 2048, mtime: t0 },
      ],
    }

    // default (scoped): private notes + a folded shared header with its count
    const foldedEx = loadExports([
      { loading: false, error: null, docs: sharedDocs, state: { docsDir: 'docs' } },
      null,
      { loading: false, error: null, text: '', truncated: false },
    ]) as Record<string, unknown>
    const foldedOut: string[] = []
    walk((foldedEx.renderers.DocsTab as (p: unknown) => unknown)({ call, scopeSlug: 'exp-a', node }), foldedOut)
    const folded = foldedOut.join(' | ')
    expect(folded).toContain('Private to this line')
    expect(folded).toContain('notes/plan.md')
    expect(folded).toContain('3 files')
    expect(folded).toContain('\u25b8') // folded chevron
    expect(folded).not.toContain('docs/charter.md')
    expect(folded).not.toContain('charter.md')
    expect(folded).not.toContain('1970')

    // opened: private notes, this line's promotions, then the rest
    const openEx = loadExports([
      { loading: false, error: null, docs: sharedDocs, state: { docsDir: 'docs' } },
      null,
      { loading: false, error: null, text: '', truncated: false },
      true,
    ]) as Record<string, unknown>
    const out: string[] = []
    walk((openEx.renderers.DocsTab as (p: unknown) => unknown)({ call, scopeSlug: 'exp-a', node }), out)
    const text = out.join(' | ')
    expect(text).toContain('\u25be')
    expect(text).toContain('Promoted to shared \u00b7 local/exp-a/')
    expect(out.filter((s) => s === 'local/exp-a/conclusion.md')).toHaveLength(1)
    // another line's promotion stays in the shared list
    expect(out.filter((s) => s === 'local/exp-b/conclusion.md')).toHaveLength(1)
    expect(text).toContain('Shared \u00b7 project-wide')
    expect(text).toContain('charter.md')

    // unscoped: the shared inventory is open and there is no per-line section
    const flatEx = loadExports([
      { loading: false, error: null, docs: sharedDocs, state: { docsDir: 'docs' } },
      null,
      { loading: false, error: null, text: '', truncated: false },
    ]) as Record<string, unknown>
    const flatOut: string[] = []
    walk((flatEx.renderers.DocsTab as (p: unknown) => unknown)({ call }), flatOut)
    const flat = flatOut.join(' | ')
    expect(flat).not.toContain('Private to this line')
    expect(flat).not.toContain('Promoted to shared')
    expect(flat).toContain('charter.md')
    expect(flat).toContain('local/exp-a/conclusion.md')
  })
})
