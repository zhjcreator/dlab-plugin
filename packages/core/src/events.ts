/**
 * Core-internal events. These are NOT Cordis events — they are the pure
 * domain event vocabulary the core services emit so a host adapter can map
 * them to DSH's event bus or persist them in the events table.
 */

import type { LabEventType } from '@dsh-lab/shared'

export interface LabEventPayload {
  type: LabEventType
  entityType?: 'solution' | 'run'
  entityId?: string
  payload?: Record<string, unknown>
  at: number
}

export type LabEventFn = (event: LabEventPayload) => void

export function makeEventSink(sink?: LabEventFn) {
  return (event: Omit<LabEventPayload, 'at'>) => {
    if (!sink) return
    sink({ ...event, at: Date.now() })
  }
}

export type { LabEventType }