/**
 * Browser half entry for the Deep Learning Lab.
 *
 * Registers slots for the Lab entry button + panel, and exposes a
 * ClientLabModel that talks to the host over the /dlab channel
 * (ctx.connection.rpc). Skeleton: registration shape only; real slots are
 * resolved via Slots.listSubTree before first fill-in.
 *
 * NOTE: This module intentionally does NOT import @deepseek-ai/dsh-client-*
 * packages yet — those types resolve only when the package is installed
 * inside a dsh web profile (they are not part of this monorepo's devDeps).
 * The ClientContext type below is structural and replaced during Phase 2
 * wiring once the host composition is exercised inside dsh web.
 */

/** Minimal structural shape of the browser context we consume. */
export interface ClientContextShape {
  slots?: {
    inject(name: string, cb: () => unknown): void
    register(spec: unknown, component: unknown): unknown
  }
  connection?: {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown): Promise<unknown>
    }
  }
}

export const name = 'dlab-lab-client'

export function apply(ctx: ClientContextShape): void {
  const slots = ctx.slots
  if (!slots) return

  // Real slot names come from Slots.listSubTree during implementation. The
  // current Web product declares conversation.session.header.actions and
  // shell.overlay; both are queried before registration.
  void slots
  void ctx
}
