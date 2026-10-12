// Names and constants shared by every concern. Pure: this file never sees $.

export const PLUGIN = 'loopkeeper'
export const MIN_VERSION = '2.1.294'
export const DISABLE_ENV = 'CLAUDE_MODS_DISABLE'

/** Slash commands this plugin registers. Never `loop` or `review`: both belong to Claude Code. */
export const CMD = {
  lk: 'lk',
  loopkeeper: 'loopkeeper',
  reviews: 'reviews',
  decide: 'decide',
  decisions: 'decisions',
  files: 'files',
} as const

/** Tools, by the name registered and by the name Claude sees. */
export const TOOL = {
  setStage: 'set_stage',
  reviewCycle: 'review_cycle',
  reviewItem: 'review_item',
  reviewStatus: 'review_status',
  recordDecision: 'record_decision',
} as const
export const toolFull = (name: string): string => `mcp__${PLUGIN}__${name}`
export const TOOL_FULL = {
  setStage: toolFull(TOOL.setStage),
  reviewCycle: toolFull(TOOL.reviewCycle),
  reviewItem: toolFull(TOOL.reviewItem),
  reviewStatus: toolFull(TOOL.reviewStatus),
  recordDecision: toolFull(TOOL.recordDecision),
} as const

/** The six concerns, in wiring order. This is also the order of the band lines. */
export const CONCERNS = ['stage', 'gates', 'files', 'routing', 'review', 'decisions'] as const
export type Concern = (typeof CONCERNS)[number]

/** Store key for a session override: loopkeeper:<concern>:<key>. */
export const storeKey = (concern: string, key: string): string => `${PLUGIN}:${concern}:${key}`

/** Config files: the user file under the home folder, the project file under the project folder. */
export const CONFIG_FILE = `.claude/${PLUGIN}.json`
export const userConfigPath = (home: string): string => `${home.replace(/\/+$/, '')}/${CONFIG_FILE}`
export const projectConfigPath = (cwd: string): string => `${cwd.replace(/\/+$/, '')}/${CONFIG_FILE}`

/** True when `version` (such as 2.1.294 or 2.1.294-dev) is at least `min`. Unparseable counts as too old. */
export function versionAtLeast(version: string, min: string = MIN_VERSION): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const a = parse(version)
  const b = parse(min)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}

// ---- Words of a command line and the text a chain of handlers builds -------------------------

/** The first word of a command's arguments, lower case, and the words after it. */
export function subOf(args: unknown): { sub: string; rest: string[]; text: string } {
  const text = String(args ?? '').trim()
  const words = text.split(/\s+/).filter(Boolean)
  return { sub: (words[0] ?? '').toLowerCase(), rest: words.slice(1), text }
}

/** Lines joined by a newline, leaving out empty ones. */
export function joinText(...parts: Array<string | undefined | null>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n')
}
