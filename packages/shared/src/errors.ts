/**
 * Stable error taxonomy for dlab. All domain failures extend `LabError` and
 * carry a machine-readable `code` so CLI, RPC, and UI can map them without
 * parsing prose.
 */

export class LabError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'LabError'
    this.code = code
    this.details = details
  }
}

export class GitError extends LabError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('git-error', message, details)
    this.name = 'GitError'
  }
}

export class ConflictError extends LabError {
  readonly files: string[]
  constructor(files: string[], message?: string) {
    super('merge-conflict', message ?? `merge conflicts detected: ${files.join(', ')}`, { files })
    this.name = 'ConflictError'
    this.files = files
  }
}

export class DirtyError extends LabError {
  constructor(message: string) {
    super('workspace-dirty', message)
    this.name = 'DirtyError'
  }
}

export class NotFoundError extends LabError {
  constructor(kind: string, id: string) {
    super('not-found', `${kind} "${id}" does not exist`)
    this.name = 'NotFoundError'
  }
}

export class InvalidStateError extends LabError {
  constructor(message: string) {
    super('invalid-state', message)
    this.name = 'InvalidStateError'
  }
}

export class LockError extends LabError {
  constructor(message: string) {
    super('lock-held', message)
    this.name = 'LockError'
  }
}
