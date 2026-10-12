// The five config sections, their defaults, and the merge of the two config files.
// Pure: this file never sees $. Each concern reads the files itself and hands the text here.
// Precedence: defaults < ~/.claude/loopkeeper.json < <project>/.claude/loopkeeper.json.
// Session overrides kept in $.store are applied by each concern afterwards.

export const SECTIONS = ['pipeline', 'changeControl', 'routing', 'review', 'decisions'] as const

export const DEFAULT_PLAN_PATHS: readonly string[] = ['.claude/plans/**', 'docs/plans/**', '**/*.plan.md', '**/*.plan.html']

export type StageDef = { id: string; label: string; gate?: boolean; requiresAgent?: string }

export type PipelineConfig = {
  stages: StageDef[]
  auto: boolean
  presets: Record<string, StageDef[]>
  approval: 'auto' | 'ask'
  smallMaxFiles: number
  // after the user approves a gate or a budget, submit one prompt so the model carries on
  continueOnApprove: boolean
  // while a task is in play, the next-step line: a notice line in the chat after each answer (dim; Claude does not
  // read it)
  nextHint: boolean
}

export type ProtectedRuleConfig = { glob: string; action: 'ask' | 'deny' }

export type ChangeControlConfig = {
  maxFilesPerTurn: number
  planSlack: number
  autoBudgetMax: number
  protected: ProtectedRuleConfig[]
  requirePlan: boolean
  mergeGate: boolean
  requireGreenCi: boolean
  blockAmend: boolean
  blockAddAll: boolean
  countSubagents: boolean
  shipGate: boolean
  planPaths: string[]
}

export type RoutingSectionConfig = {
  override: boolean
  enabled: boolean | null
  models: Record<string, string>
  roles: Record<string, { model?: string; keywords?: string[] }>
}

export type ReviewConfig = {
  /** Per kind: target score and cycle limit. A missing kind uses the kind's preset. */
  kinds: Record<string, { target?: number; maxCycles?: number }>
}

export type DecisionsConfig = {
  watch: boolean
  watchModel: string
  watchMaxPerHour: number
  watchMinChars: number
  /** Log file relative to the project; '' finds one. */
  file: string
  /** 'brain-md' is an alias of 'markdown'. */
  format: 'jsonl' | 'markdown' | 'brain-md' | 'journal-md'
}

export type LoopkeeperConfig = {
  pipeline: PipelineConfig
  changeControl: ChangeControlConfig
  routing: RoutingSectionConfig
  review: ReviewConfig
  decisions: DecisionsConfig
}

export const DEFAULT_STAGE_LIST: StageDef[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'build', label: 'Build' },
  { id: 'qa', label: 'QA' },
  { id: 'ship', label: 'Ship' },
]

export const DEFAULT_ROUTING_MODELS: Record<string, string> = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' }

export function defaultConfig(): LoopkeeperConfig {
  return {
    pipeline: {
      stages: DEFAULT_STAGE_LIST.map(s => ({ ...s })),
      auto: true,
      presets: {},
      approval: 'auto',
      smallMaxFiles: 3,
      continueOnApprove: true,
      nextHint: true,
    },
    changeControl: {
      maxFilesPerTurn: 10,
      planSlack: 10,
      autoBudgetMax: 40,
      protected: [
        { glob: 'docs/decisions/**', action: 'ask' },
        { glob: '.env*', action: 'deny' },
        { glob: '**/migrations/**', action: 'ask' },
      ],
      requirePlan: false,
      mergeGate: true,
      requireGreenCi: true,
      blockAmend: true,
      blockAddAll: false,
      countSubagents: false,
      shipGate: true,
      planPaths: [...DEFAULT_PLAN_PATHS],
    },
    routing: { override: false, enabled: null, models: { ...DEFAULT_ROUTING_MODELS }, roles: {} },
    review: { kinds: {} },
    decisions: {
      watch: false,
      watchModel: 'haiku',
      watchMaxPerHour: 20,
      watchMinChars: 200,
      file: '',
      format: 'jsonl',
    },
  }
}

export type ParseResult = { value: Record<string, unknown>; problems: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parse one config file's text. Never throws: a broken file gives an empty layer and a problem. */
export function parseConfigText(text: string | null | undefined, label: string): ParseResult {
  if (text === null || text === undefined || String(text).trim() === '') return { value: {}, problems: [] }
  try {
    const v: unknown = JSON.parse(String(text))
    if (!isObj(v)) return { value: {}, problems: [`${label}: expected a JSON object`] }
    return { value: v, problems: [] }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { value: {}, problems: [`${label}: not valid JSON (${why.slice(0, 80)})`] }
  }
}

// A value fits a default when its kind matches: same typeof, array for array, object for object.
function fits(def: unknown, v: unknown): boolean {
  if (def === null) return v === null || typeof v === 'boolean'
  if (Array.isArray(def)) return Array.isArray(v)
  if (isObj(def)) return isObj(v)
  if (typeof def === 'number') return typeof v === 'number' && Number.isFinite(v)
  return typeof v === typeof def
}

function applySection(base: Record<string, unknown>, layer: unknown, name: string, problems: string[]): void {
  if (layer === undefined) return
  if (!isObj(layer)) {
    problems.push(`${name}: expected an object`)
    return
  }
  for (const [k, v] of Object.entries(layer)) {
    if (!(k in base)) {
      problems.push(`${name}.${k}: unknown key`)
      continue
    }
    if (!fits(base[k], v)) {
      problems.push(`${name}.${k}: wrong type, kept ${JSON.stringify(base[k])}`)
      continue
    }
    base[k] = isObj(v) && isObj(base[k]) ? { ...(base[k] as object), ...v } : Array.isArray(v) ? [...v] : v
  }
  // A few keys have a closed set of values.
  const p = base as Record<string, unknown>
  if (name === 'pipeline' && p.approval !== 'auto' && p.approval !== 'ask') p.approval = 'auto'
  if (name === 'decisions' && !['jsonl', 'markdown', 'brain-md', 'journal-md'].includes(String(p.format))) p.format = 'jsonl'
}

export type Merged = { config: LoopkeeperConfig; problems: string[] }

/** defaults < user file < project file. Layers are parsed objects (see parseConfigText). */
export function mergeConfig(user: unknown, project: unknown): Merged {
  const config = defaultConfig() as unknown as Record<string, Record<string, unknown>>
  const problems: string[] = []
  for (const [label, layer] of [
    ['user', user],
    ['project', project],
  ] as const) {
    if (layer === undefined || layer === null) continue
    if (!isObj(layer)) {
      problems.push(`${label} config: expected an object`)
      continue
    }
    for (const key of Object.keys(layer)) {
      if (!(SECTIONS as readonly string[]).includes(key)) problems.push(`${label} config: unknown section "${key}"`)
    }
    for (const s of SECTIONS) applySection(config[s], layer[s], `${label} ${s}`, problems)
  }
  return { config: config as unknown as LoopkeeperConfig, problems }
}

/** The two files' text in, the merged config and every problem out. */
export function mergeConfigText(userText: string | null | undefined, projectText: string | null | undefined): Merged {
  const u = parseConfigText(userText, 'user config')
  const p = parseConfigText(projectText, 'project config')
  const m = mergeConfig(u.value, p.value)
  return { config: m.config, problems: [...u.problems, ...p.problems, ...m.problems] }
}
