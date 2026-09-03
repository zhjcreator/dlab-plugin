/**
 * Path and slug validation.
 *
 * Every user-supplied path must resolve under the project root; slugs must
 * match the git-branch-safe grammar. Nothing here touches the filesystem.
 */

export const SLUG_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug)
}

export function assertSlug(slug: string): void {
  if (!isValidSlug(slug)) {
    throw new Error(
      `invalid slug "${slug}": must match ${SLUG_RE.source} and cannot be '.', '..', or contain '/'`,
    )
  }
}

/**
 * Join a relative path onto root and assert the result stays inside root.
 * Rejects absolute paths, '..' escapes, and empty segments that escape.
 */
export function resolveInside(root: string, relative: string): string {
  // reject absolute paths outright
  if (relative.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relative)) {
    throw new Error(`path must be relative to project root, got "${relative}"`)
  }
  const parts = relative.split(/[\\/]+/).filter(Boolean)
  for (const part of parts) {
    if (part === '..' || part === '.') {
      throw new Error(`path escapes project root: "${relative}"`)
    }
  }
  return [root.replace(/[\\/]+$/, ''), ...parts].join('/')
}
