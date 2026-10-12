// The shared fixture (tests/world.ts) with the shapes the review concern's tests use: a `files` map that
// $.fs.write updates and $.fs.exists / $.fs.read see, and failWrite as a switch.
import { world } from './world.ts'
import type { World, WorldOptions } from './world.ts'

export type ReviewWorld = World & {
  /** Files by absolute path; a $.fs.write lands here, and $.fs.exists and $.fs.read see it. */
  files: Record<string, string>
}

export function reviewWorld(
  on: any,
  opts: Omit<WorldOptions, 'files' | 'failWrite'> & { files?: Record<string, string>; failWrite?: boolean } = {},
): ReviewWorld {
  const { failWrite, files: given, ...rest } = opts
  const files: Record<string, string> = { ...(given ?? {}) }
  const w = world(on, { ...rest, files, failWrite: failWrite ? 'EACCES' : undefined })
  return Object.assign(w, { files })
}
