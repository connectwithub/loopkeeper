// The classifier: keywords to a role, inline tags, the spawn decision and the /lk explain text.
// Ported from gsd-orchestrator's classify.ts. Pure: this file never sees $.

import type { LkRole, LkRouteDecision, LkRoutingConfig } from '../../types/index.d.ts'
import { PRIORITY, ROLES, isModelName, isRole, resolveModel, shortModel } from './routingConfig.ts'

/** How much of the subagent's prompt the classifier reads. */
export const PROMPT_CHARS = 300

export type Classification = {
  role: LkRole
  matched: string[]
  scores: Record<LkRole, string[]>
}

export type Tag = { kind: 'model'; value: string; raw: string } | { kind: 'role'; value: LkRole; raw: string }

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a keyword occurs at the start of a word: `test` matches "tests" and
 * "testing" but not "latest"; `map the` matches "map the auth flow".
 */
export function hasKeyword(haystack: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase()
  if (k === '') return false
  const spaced = escape(k).replace(/\s+/g, '\\s+')
  return new RegExp('(?:^|[^a-z0-9])' + spaced, 'i').test(haystack)
}

/** Score every role by distinct keyword hits; ties go hard > verify > execute > recon. */
export function classify(text: string, config: LkRoutingConfig): Classification {
  const haystack = String(text ?? '').toLowerCase()
  const scores = {} as Record<LkRole, string[]>
  for (const role of ROLES) {
    const keywords = role === 'default' ? [] : config.roles[role]?.keywords ?? []
    scores[role] = [...new Set(keywords.filter(k => hasKeyword(haystack, k)))]
  }
  let best: LkRole = 'default'
  let bestScore = 0
  for (const role of PRIORITY) {
    const score = scores[role].length
    if (score > bestScore) {
      best = role
      bestScore = score
    }
  }
  return { role: best, matched: scores[best], scores }
}

/** The first `[model:x]` or `[role:x]` tag in the text, when one is valid. */
export function findTag(text: string): Tag | undefined {
  const pattern = /\[(model|role)\s*:\s*([A-Za-z0-9._:-]+)\s*\]/gi
  for (const m of String(text ?? '').matchAll(pattern)) {
    const kind = (m[1] ?? '').toLowerCase()
    const value = m[2] ?? ''
    if (kind === 'role' && isRole(value.toLowerCase())) {
      return { kind: 'role', value: value.toLowerCase() as LkRole, raw: m[0] }
    }
    if (kind === 'model' && isModelName(value)) return { kind: 'model', value, raw: m[0] }
  }
  return undefined
}

/** The spawn fields the classifier reads, every one optional and unchecked. */
export type SpawnLike = {
  description?: unknown
  prompt?: unknown
  subagentType?: unknown
  model?: unknown
  fork?: unknown
  isTeammate?: unknown
  name?: unknown
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Type name, description and the first 300 characters of the prompt. */
export function spawnText(e: SpawnLike): string {
  return [str(e.subagentType), str(e.description), str(e.prompt).slice(0, PROMPT_CHARS)].join('\n')
}

export type SpawnDecision = Omit<LkRouteDecision, 'at'> & {
  /** The model id to hand next(), or undefined to pass the spawn through. */
  setModel: string | undefined
}

/**
 * Decide one spawn. Tag beats an explicit model, which beats routing unless
 * config.override is true. Off mode passes everything through.
 */
export function decide(e: SpawnLike, config: LkRoutingConfig, isOn: boolean): SpawnDecision {
  const isTeammate = e.isTeammate === true
  const label = (str(e.description) || str(e.name) || str(e.subagentType) || 'agent').slice(0, 30)
  const type = str(e.subagentType) || (isTeammate ? 'teammate' : 'agent')
  const explicit = str(e.model)
  const base = { label, type, isTeammate }
  if (!isOn) {
    return { ...base, role: '', model: explicit || 'inherit', matched: [], source: 'off', setModel: undefined }
  }
  if (e.fork === true) {
    // A fork always runs on its parent's model; the engine ignores `model`.
    return { ...base, role: '', model: 'inherit (fork)', matched: [], source: 'explicit', setModel: undefined }
  }
  const tag = findTag(str(e.description) + '\n' + str(e.prompt))
  if (tag !== undefined) {
    const role: LkRole | '' = tag.kind === 'role' ? tag.value : ''
    const aliasOrId = tag.kind === 'role' ? config.roles[tag.value].model : tag.value
    const model = resolveModel(aliasOrId, config)
    return { ...base, role, model, matched: [tag.raw], source: 'tag', setModel: model }
  }
  const c = classify(spawnText(e), config)
  if (explicit !== '' && !config.override) {
    return { ...base, role: c.role, model: explicit, matched: c.matched, source: 'explicit', setModel: undefined }
  }
  const model = resolveModel(config.roles[c.role].model, config)
  return { ...base, role: c.role, model, matched: c.matched, source: 'routed', setModel: model }
}

/** What `/lk explain <text>` prints. */
export function explain(text: string, config: LkRoutingConfig): string {
  const shown = text.length > 60 ? text.slice(0, 57) + '...' : text
  const tag = findTag(text)
  const c = classify(text, config)
  const lines: string[] = []
  if (tag !== undefined) {
    const aliasOrId = tag.kind === 'role' ? config.roles[tag.value].model : tag.value
    lines.push(`"${shown}" → tag ${tag.raw} wins → ${resolveModel(aliasOrId, config)}`)
  } else {
    const route = config.roles[c.role]
    lines.push(`"${shown}" → ${c.role} → ${resolveModel(route.model, config)} (${shortModel(route.model, config)})`)
  }
  const parts = PRIORITY.map(role => {
    const hits = c.scores[role]
    return hits.length > 0 ? `${role} ${hits.length} (${hits.join(', ')})` : `${role} 0`
  })
  lines.push('scores: ' + parts.join(' · '))
  lines.push(c.matched.length === 0 ? 'no keyword matched: default role' : 'ties resolve hard > verify > execute > recon')
  return lines.join('\n')
}
