/**
 * Runner reconciliation helpers for host restarts.
 * Skeleton: PID liveness probing is OS-level; see RunService.reconcile().
 */

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
