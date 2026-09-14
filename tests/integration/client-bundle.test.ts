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

/** Minimal createElement stub capturing the tree. */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  return {
    createElement,
    Fragment: 'Fragment',
    useState: (init) => {
      let value = init
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

function loadBundle() {
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
    if (spec === 'react') return fakeReact()
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
      ['/home2/x/PRD/.venv/bin/python', 'train.py', '--config', '/home2/x/PRD/configs/a.yaml'],
      '/home2/x/PRD',
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
    const model = (exports.buildModel as (data: unknown) => { rows: { kind: string; title?: string }[] })({
      project: { name: 'proj', root: '/lab' },
      graph: { milestones: [], nodes: [{ id: 'main', role: 'main', status: 'active', branch: 'main', headCommit: 'a1' }] },
      runs: [
        { id: 'r1', solutionSlug: 'main', snapshotCommit: 'c1', status: 'succeeded', command: ['/lab/.venv/bin/python', 't.py'], title: 'my title', createdAt: 500 },
        { id: 'r2', solutionSlug: 'main', snapshotCommit: 'c2', status: 'succeeded', command: ['/lab/.venv/bin/python', 't.py'], createdAt: 400 },
      ],
      events: [],
    })
    const titles = model.rows.filter((r) => r.kind === 'run').map((r) => r.title)
    expect(titles).toContain('my title')
    expect(titles).toContain('python t.py')
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
    expect(model.counts).toEqual({ solutions: 2, running: 0 })

    // newest first: merge (t0+60), run_2 (t0+40), run_1 (t0+20), fork (t0+10), init
    expect(model.rows.map((r) => r.kind)).toEqual(['merge', 'run', 'run', 'fork', 'init'])
    expect(model.rows[0]!.lane).toBe(0) // merge dot lands on main
    expect(model.rows[0]!.srcLane).toBe(1)
    expect(model.rows[0]!.vLabel).toBe('v2')
    expect(model.rows[1]!.slug).toBe('exp-a')
    expect(model.rows[2]!.slug).toBe('main')
    expect(model.rows[3]!.kind).toBe('fork')
    expect(model.rows[3]!.parentLane).toBe(0)
    expect(model.rows[4]!.kind).toBe('init')

    // lane 1 spans from its fork row (bottom) to its merge row (top)
    expect(model.topIdx[1]).toBe(0)
    expect(model.botIdx[1]).toBe(3)
    // its top end is a terminal (merge) row → through-line enters from above
    expect(model.topIsTerminal[1]).toBe(true)
  })

  it('buildModel synthesizes missing event times and orders lanes by fork time', () => {
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

    expect(model.laneOf['early']).toBe(1)
    expect(model.laneOf['late']).toBe(2)
    expect(model.counts.running).toBe(1)
    // every experiment gets a synthesized fork row; init is the last row
    const kinds = model.rows.map((r) => r.kind)
    expect(kinds.filter((k) => k === 'fork')).toHaveLength(2)
    expect(kinds[kinds.length - 1]).toBe('init')
    // no terminals here → lane tops are run tips, so no incoming through-line
    expect(model.topIsTerminal[1]).toBe(false)
    expect(model.topIsTerminal[2]).toBe(false)
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
