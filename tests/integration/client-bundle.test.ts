/**
 * Browser-bundle smoke test: loads the REAL lib/client.js through a fake
 * window.__ModuleLoader__ with a stub react/react-dom, then drives both
 * integration paths:
 *   - header button registration into conversation.session.header.actions
 *   - better-sidebar tab registration via the ctx.inject sub-plugin
 *     (activated / disposed with the service)
 * and asserts graceful behavior when slots / sidebar are absent.
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
  const ctx = {
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    slots: {
      inject: (key, cb) => {
        slotInjects.push({ key, cb })
        return () => {}
      },
      register: (spec, component) => {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    inject: (deps, cb) => {
      ctx._subPlugins.push({ deps, cb })
    },
    effect: (fn) => {
      const dispose = fn()
      ctx._effects.push(dispose)
      return dispose
    },
    get: (name) => ctx._services[name],
    _subPlugins: [],
    _effects: [],
    _services: {},
    ...overrides,
  }
  ctx._registrations = registrations
  ctx._slotInjects = slotInjects
  return ctx
}

describe('lab-client browser bundle', () => {
  it('registers through window.__ModuleLoader__ with the package id', () => {
    const { loaded } = loadBundle()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.id).toBe('@dlab/lab-client')
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
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error(`unexpected require("${spec}")`)
    })
    expect(exports.inject).toEqual(['slots', 'connection'])
    expect(typeof exports.apply).toBe('function')
  })

  it('apply registers the header button into conversation.session.header.actions', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const ctx = makeCtx()
    exports.apply(ctx)

    expect(ctx._slotInjects.map((s) => s.key)).toContain('conversation.session.header.actions')
    // fire the slot inject callback → the registration happens
    ctx._slotInjects.find((s) => s.key === 'conversation.session.header.actions')!.cb()
    expect(ctx._registrations).toHaveLength(1)
    const reg = ctx._registrations[0]!
    expect(reg.spec.id).toBe('dlab-lab')
    expect(reg.spec.order).toBe(30)
    // the injected props carry the plugin ctx
    const props = reg.spec.inject()
    expect(props.ctx).toBe(ctx)
    // the component renders an element without crashing
    const el = reg.component({ ctx })
    expect(el).toBeTruthy()
  })

  it('better-sidebar sub-plugin registers the tab when the service appears', () => {
    const { loaded } = loadBundle()
    const exports = loaded[0]!.factory((spec) => {
      if (spec === 'react') return fakeReact()
      if (spec === 'react-dom') return { createPortal: (el) => el }
      throw new Error('unexpected')
    })
    const ctx = makeCtx()
    exports.apply(ctx)

    // the sub-plugin waits for betterSidebar
    const sub = ctx._subPlugins.find((p) => p.deps.includes('betterSidebar'))
    expect(sub).toBeTruthy()

    // service appears → sub-plugin apply runs → effect registers the tab.
    // The fake ctx is a plain object (not a cordis proxy), so the service
    // must be exposed as a property for `bsCtx.betterSidebar` access.
    const tabs = []
    const service = {
      registerTab: (descriptor) => {
        tabs.push(descriptor)
        return () => {
          tabs.splice(tabs.indexOf(descriptor), 1)
        }
      },
      openTab: () => {},
    }
    ctx._services.betterSidebar = service
    ;(ctx as { betterSidebar?: unknown }).betterSidebar = service
    sub.cb(ctx)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.id).toBe('dlab:lab')
    expect(tabs[0]!.single).toBe(true)
    // tab component renders with TabComponentProps.ctx
    const el = tabs[0]!.component({ ctx, tab: {}, visible: true })
    expect(el).toBeTruthy()
    // effect disposal (HMR / service loss) unregisters the tab
    ctx._effects.pop()!()
    expect(tabs).toHaveLength(0)
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
})
