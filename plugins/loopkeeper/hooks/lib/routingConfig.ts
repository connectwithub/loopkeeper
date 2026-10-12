// The routing table: defaults, the shape of the config's `routing` section, and the merge.
// Ported from gsd-orchestrator's routing.ts. Pure: this file never sees $.

import type { LkRole, LkRoleRoute, LkRoutingConfig } from '../../types/index.d.ts'

/** Every role, in display order. */
export const ROLES: readonly LkRole[] = ['recon', 'execute', 'verify', 'hard', 'default']

/** Roles that keywords can select, highest tie-break priority first. */
export const PRIORITY: readonly Exclude<LkRole, 'default'>[] = ['hard', 'verify', 'execute', 'recon']

/** Short names for the band. */
export const SHORT: Record<LkRole, string> = {
  recon: 'recon',
  execute: 'exec',
  verify: 'verify',
  hard: 'hard',
  default: 'default',
}

export const SOURCE_DEFAULT = 'default'
export const SOURCE_USER = '~/.claude/loopkeeper.json'
export const SOURCE_PROJECT = '.claude/loopkeeper.json'
export const SOURCE_SESSION = 'session (/lk route)'

/** Alias to model. Defaults pass the alias through: Claude Code resolves `haiku`, `sonnet` and `opus` to the
 *  current model of each tier (the same way the Agent tool's model parameter does), so routing keeps working when
 *  model generations change. Put a full id here in a config file to pin one. */
export const DEFAULT_MODELS: Record<string, string> = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
}

const KEYWORDS: Record<LkRole, string[]> = {
  recon: [
    'explore', 'search', 'survey', 'scan', 'lookup', 'look up', 'find', 'list',
    'inventory', 'grep', 'read', 'catalog', 'research', 'fetch', 'docs', 'recon',
    'map the', 'where is', 'which files',
  ],
  execute: [
    'implement', 'build', 'write code', 'edit', 'refactor', 'fix', 'migrate',
    'generate', 'create file', 'scaffold', 'apply', 'run tests', 'run the',
    'update the',
  ],
  verify: [
    'verify', 'validate', 'review', 'audit', 'critic', 'critique', 'check',
    'test', 'lint', 'qa', 'score', 'rank', 'compare against',
  ],
  hard: [
    'plan', 'design', 'architect', 'position', 'positioning', 'draft', 'analyze',
    'analysis', 'strategy', 'write copy', 'negotiate', 'synthesize', 'judge',
    'tricky', 'complex', 'root cause', 'debug', 'prove', 'security',
  ],
  default: [],
}

const DEFAULT_ALIAS: Record<LkRole, string> = {
  recon: 'haiku',
  execute: 'sonnet',
  verify: 'sonnet',
  hard: 'opus',
  default: 'sonnet',
}

/** The built-in table, before any config file. */
export function defaultRouting(): LkRoutingConfig {
  const roles = {} as Record<LkRole, LkRoleRoute>
  for (const role of ROLES) {
    roles[role] = { model: DEFAULT_ALIAS[role], keywords: [...KEYWORDS[role]], source: SOURCE_DEFAULT }
  }
  return { override: false, enabled: null, models: { ...DEFAULT_MODELS }, roles }
}

/** A model alias or id a person may type: letters, digits and . _ - : [ ]. */
export function isModelName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:\[\]-]{1,100}$/.test(value)
}

export function isRole(value: unknown): value is LkRole {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keywordList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    .map(k => k.trim().toLowerCase())
}

/**
 * The `routing` section of one loopkeeper.json, or undefined for anything that is not a JSON object
 * with that section, so a broken file is skipped and never breaks routing.
 */
export function routingLayer(text: unknown): unknown {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isObject(parsed) && isObject(parsed.routing) ? parsed.routing : undefined
  } catch {
    return undefined
  }
}

/**
 * Lay one config layer over a table. A layer may set:
 *   override: boolean, enabled: boolean,
 *   models: { alias: id },
 *   roles: { role: "alias-or-id" | { model?, keywords?, addKeywords? } }
 * Unknown or malformed fields are ignored.
 */
export function mergeLayer(base: LkRoutingConfig, layer: unknown, source: string): LkRoutingConfig {
  if (!isObject(layer)) return base
  const next: LkRoutingConfig = {
    override: base.override,
    enabled: base.enabled,
    models: { ...base.models },
    roles: { ...base.roles },
  }
  if (typeof layer.override === 'boolean') next.override = layer.override
  if (typeof layer.enabled === 'boolean') next.enabled = layer.enabled
  if (isObject(layer.models)) {
    for (const [alias, id] of Object.entries(layer.models)) {
      if (isModelName(alias) && isModelName(id)) next.models[alias.toLowerCase()] = id
    }
  }
  if (isObject(layer.roles)) {
    for (const [role, spec] of Object.entries(layer.roles)) {
      if (!isRole(role)) continue
      const current = next.roles[role]
      if (isModelName(spec)) {
        next.roles[role] = { ...current, model: spec, source }
        continue
      }
      if (!isObject(spec)) continue
      const model = isModelName(spec.model) ? spec.model : current.model
      const replaced = keywordList(spec.keywords)
      const added = keywordList(spec.addKeywords) ?? []
      const keywords = [...new Set([...(replaced ?? current.keywords), ...added])]
      next.roles[role] = { model, keywords, source }
    }
  }
  return next
}

/** Session overrides from `/lk route`: role to alias or id. */
export function applyOverrides(base: LkRoutingConfig, overrides: unknown): LkRoutingConfig {
  if (!isObject(overrides)) return base
  const roles = { ...base.roles }
  for (const [role, model] of Object.entries(overrides)) {
    if (isRole(role) && isModelName(model)) roles[role] = { ...roles[role], model, source: SOURCE_SESSION }
  }
  return { ...base, roles }
}

/** Defaults, then the user file, then the project file, then session overrides. */
export function buildConfig(userLayer: unknown, projectLayer: unknown, overrides: unknown): LkRoutingConfig {
  const withUser = mergeLayer(defaultRouting(), userLayer, SOURCE_USER)
  const withProject = mergeLayer(withUser, projectLayer, SOURCE_PROJECT)
  return applyOverrides(withProject, overrides)
}

/** An alias's id, or the value itself when it is already an id. */
export function resolveModel(aliasOrId: string, config: LkRoutingConfig): string {
  const key = aliasOrId.toLowerCase()
  return config.models[key] ?? DEFAULT_MODELS[key] ?? aliasOrId
}

/** The alias for an id when one maps to it, else the id: for the band. */
export function shortModel(aliasOrId: string, config: LkRoutingConfig): string {
  const id = resolveModel(aliasOrId, config)
  const alias = Object.entries(config.models).find(([, v]) => v === id)?.[0]
  return alias ?? id
}

/** A config that came out of $.state may be partial or null; fill gaps. */
export function sane(config: unknown): LkRoutingConfig {
  const base = defaultRouting()
  if (!isObject(config) || !isObject(config.roles) || !isObject(config.models)) return base
  const roles = { ...base.roles }
  for (const role of ROLES) {
    const r = (config.roles as Record<string, unknown>)[role]
    if (isObject(r) && isModelName(r.model) && Array.isArray(r.keywords)) {
      roles[role] = {
        model: r.model,
        keywords: keywordList(r.keywords) ?? [],
        source: typeof r.source === 'string' ? r.source : SOURCE_DEFAULT,
      }
    }
  }
  return {
    override: config.override === true,
    enabled: typeof config.enabled === 'boolean' ? config.enabled : null,
    models: { ...base.models, ...(config.models as Record<string, string>) },
    roles,
  }
}
