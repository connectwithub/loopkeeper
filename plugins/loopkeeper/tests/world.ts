// Shared fixture for loopkeeper tests: stubs every $ call any concern makes during session.start and the
// commands, tools and bands, and records what they were asked. Register it before the test's first call on $.
import { mock } from 'claude-code/testing'

export const CWD = '/work/project'
export const HOME = '/home/tester'
export const USER_CONFIG = `${HOME}/.claude/loopkeeper.json`
export const PROJECT_CONFIG = `${CWD}/.claude/loopkeeper.json`

export type WorldOptions = {
  /** Files by absolute path, for $.fs.exists and $.fs.read. */
  files?: Record<string, string>
  /** Environment variables beside HOME. */
  env?: Record<string, string>
  /** What $.session.version reports as its base. */
  version?: string
  /** Names $.command.register refuses, to exercise the try/catch around it. */
  refuse?: string[]
  /** Answers $.process.run (with the folder it runs in, when given); return undefined for "not a repository". */
  run?: (argv: string[], cwd?: string) => { exitCode: number; stdout: string; stderr?: string } | undefined
  // ---- added for decisions (all optional) ----
  /**
   * Directories by absolute path, with the names inside, for $.fs.exists and $.fs.list. A name is a file of size 0;
   * an entry object (added for files) gives its kind, size, mtimeMs and isLink. $.fs.list refuses a folder not here.
   */
  dirs?: Record<string, Array<string | DirEntry>>
  /** When set, $.fs.write is refused with this text. */
  failWrite?: string
  /** The clock's start in ms; default 1_000. */
  now?: number
  /** What the stubbed $.model.complete answers, one per call: an object (sent as JSON), raw text, or null for no answer. */
  replies?: Array<Record<string, unknown> | string | null>
  /** The transcript $.session.messages returns. */
  messages?: Array<{ role: 'user' | 'assistant'; text: string; toolUses: unknown[] }>
  // ---- added for stage (all optional) ----
  /** File paths the stubbed permission rules (tool.check, below every hook) refuse with the reason "locked". */
  locked?: string[]
  // ---- added for gates (all optional) ----
  /** Answers to $.ui.ask (the AskUserQuestion shim), used in order; 'reject' makes that ask reject. The last one repeats. */
  answers?: string[]
  /** What $.session.surfaces resolves to; [] is a non-interactive session. Default ['terminal']. */
  surfaces?: string[]
  /** What the permission rules decided beneath every hook for a path not in `locked`. Default 'allow'. */
  below?: 'allow' | 'ask' | 'deny'
  /** Make $.session.cwd and $.session.root reject, to exercise the gates' fail-closed handler. */
  breakCwd?: boolean
  /** Answers a tool.call before the default ({ result: 'ran' }); return undefined for the default. May return a promise. */
  tool?: (e: any) => unknown
  /** What $.fs.stat says for a path (mtimeMs); a path not here is refused. */
  stats?: Record<string, number>
  /** How prompt.mention attaches a file: 'file' by default, null for nothing attached. */
  mention?: 'file' | 'already_read_file' | 'pdf_reference' | null
  /**
   * loopkeeper atoms answered beneath every concern, by key (a stage atom the gates read, say). A key here is read and
   * written in this object from then on; add or change one on `w.atoms` mid-test to seed it there.
   */
  atoms?: Record<string, unknown>
  // ---- added for routing (all optional) ----
  /** Store keys starting with one of these are refused by $.store.set, to make one concern's part fail. */
  refuseStore?: string[]
}

export type Run = { exitCode: number; stdout: string; stderr?: string }

/** A folder entry for WorldOptions.dirs (added for files). */
export type DirEntry = { name: string; kind: 'file' | 'dir' | 'other'; size?: number; mtimeMs?: number; isLink?: boolean }

/** What git and gh answer when `run` gives nothing: branch "feature", origin/HEAD main, HEAD not pushed, a clean
 *  tree, no pull request, no checks. Anything else exits 1. */
export const DEFAULT_RUN = (argv: string[]): Run => {
  const cmd = argv.join(' ')
  if (cmd === 'git branch --show-current') return { exitCode: 0, stdout: 'feature\n' }
  if (cmd.startsWith('git symbolic-ref')) return { exitCode: 0, stdout: 'origin/main\n' }
  if (cmd.startsWith('git merge-base')) return { exitCode: 1, stdout: '' }
  if (cmd.startsWith('git status')) return { exitCode: 0, stdout: '' }
  if (cmd.startsWith('gh pr view')) return { exitCode: 1, stdout: '', stderr: 'no pull requests found' }
  if (cmd.startsWith('gh pr checks')) return { exitCode: 0, stdout: '[]' }
  return { exitCode: 1, stdout: '', stderr: 'unexpected ' + cmd }
}

export type World = {
  /** Every command name a concern tried to register, in order, refused ones included. */
  attempted: string[]
  /** Commands that registered. */
  registered: string[]
  /** Tools registered, by the name given (the model sees mcp__loopkeeper__<name>). */
  tools: Array<{ name: string; isDeferred?: boolean; description?: string }>
  toasts: string[]
  processes: string[][]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
  // ---- added for decisions ----
  /** Files written through $.fs.write, in order. The `files` map given to world() is updated too. */
  writes: Array<{ path: string; text: string }>
  /** Lines logged through $.ui.log. */
  logs: string[]
  /** Pane ids opened (as given) and closed (as `closed:<id>`). */
  panes: string[]
  /** Every $.model.complete request. */
  calls: Array<{ model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }>
  /** The transcript; replace `.messages` to change what the next turn sees. */
  chat: { messages: Array<{ role: 'user' | 'assistant'; text: string; toolUses: unknown[] }> }
  // ---- added for stage ----
  /** Every path $.fs.exists or $.fs.read was asked about, in order. */
  looked: string[]
  // ---- added for gates ----
  /** Questions asked through $.ui.ask, in order. */
  asked: string[]
  /** Turn ids $.turn.abort was called with. */
  aborted: string[]
  /** Tools that ran through the default tool.call stub (AskUserQuestion aside). */
  ran: string[]
  /** The seeded atoms (see WorldOptions.atoms); change a key to change what every concern reads. */
  atoms: Record<string, unknown>
  /** The last value written to each loopkeeper atom, seeded or not. */
  state: Map<string, unknown>
  // ---- added for files ----
  /** Folders $.fs.list was asked for, in order. */
  listed: string[]
  /** What each command that registered was registered with (name, description, immediate …), in order. */
  commands: Array<Record<string, unknown>>
  // ---- added for routing ----
  /** Subagents started through $.agent.spawn, with the model each was handed. */
  spawned: Array<{ model: unknown; description: unknown }>
  /** Text put in the prompt box through $.prompt.fill, in order. */
  filled: string[]
  /** Every prompt.submit that reached the bottom of the chain (a test's own and a plugin's), in order. */
  submitted: Array<{ text: unknown; origin: unknown; asUser: unknown }>
  // ---- added for the project root ----
  /**
   * Move $.session.cwd as a shell `cd` does (absolute, or relative to where it is now); $.session.root stays at CWD.
   */
  cd: (dir: string) => void
}

export function world(on: any, opts: WorldOptions = {}): World {
  let cwd = CWD
  const w: World = {
    attempted: [],
    registered: [],
    tools: [],
    toasts: [],
    processes: [],
    store: new Map(),
    clock: mock.clock(on, { now: opts.now ?? 1_000 }),
    writes: [],
    logs: [],
    panes: [],
    calls: [],
    chat: { messages: opts.messages ?? [] },
    looked: [],
    asked: [],
    aborted: [],
    ran: [],
    atoms: { ...(opts.atoms ?? {}) },
    state: new Map(),
    listed: [],
    commands: [],
    spawned: [],
    filled: [],
    submitted: [],
    cd: dir => {
      cwd = dir.startsWith('/') ? dir.replace(/\/+$/, '') : `${cwd}/${dir.replace(/\/+$/, '')}`
    },
  }
  const files = opts.files ?? {}
  const dirs = opts.dirs ?? {}
  const replies = [...(opts.replies ?? [])]
  const env: Record<string, string> = { HOME, ...(opts.env ?? {}) }
  const refuse = opts.refuse ?? []
  const answers = [...(opts.answers ?? [])]

  // Seeded atoms live here, beneath every concern and above the kit's $.state; every write is recorded.
  const versions = new Map<string, number>()
  const isSeeded = (r: any) => r?.plugin === 'loopkeeper' && typeof r?.key === 'string' && Object.prototype.hasOwnProperty.call(w.atoms, r.key)
  on('state.get', { plugin: 'loopkeeper' }, ($: unknown, e: any, next: (e: unknown) => unknown) => {
    const r = e?.ref ?? e
    if (!isSeeded(r)) return next(e)
    return { value: { value: w.atoms[r.key], version: versions.get(r.key) ?? 1 } }
  })
  on('state.set', { plugin: 'loopkeeper' }, ($: unknown, e: any, next: (e: unknown) => unknown) => {
    const r = e?.ref ?? e
    if (r?.plugin === 'loopkeeper' && typeof r?.key === 'string') w.state.set(r.key, e.value)
    if (!isSeeded(r)) return next(e)
    w.atoms[r.key] = e.value
    const version = (versions.get(r.key) ?? 1) + 1
    versions.set(r.key, version)
    return { value: { isSet: true, version } }
  })
  on('session.cwd', () => (opts.breakCwd ? { deny: 'cwd unavailable' } : { value: cwd }))
  // the project root: a shell `cd` (w.cd) does not move it
  on('session.root', () => (opts.breakCwd ? { deny: 'root unavailable' } : { value: CWD }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('session.version', () => ({ value: { version: opts.version ?? '2.1.294', base: opts.version ?? '2.1.294' } }))
  on('env.get', ($: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('fs.exists', ($: unknown, e: { path: string }) => {
    w.looked.push(e.path)
    return { value: e.path in files || e.path in dirs }
  })
  on('fs.list', ($: unknown, e: { path: string }) => {
    w.listed.push(e.path)
    // as the host does, a folder that is not there is refused
    if (!Object.prototype.hasOwnProperty.call(dirs, e.path)) return { deny: 'ENOENT: no such directory' }
    return {
      value: (dirs[e.path] ?? []).map(d =>
        typeof d === 'string' ? { name: d, kind: 'file', size: 0, isLink: false } : { size: 0, isLink: false, ...d },
      ),
    }
  })
  on('fs.write', ($: unknown, e: any) => {
    if (opts.failWrite) return { deny: opts.failWrite }
    const text = String(e.text ?? e.content ?? e.data ?? '')
    w.writes.push({ path: e.path, text })
    files[e.path] = text
    return { value: undefined }
  })
  on('session.messages', () => ({ value: w.chat.messages }))
  on('classic.SessionStart', () => ({}))
  on('turn.start', ($: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.abort', ($: unknown, e: { turnId: string }) => {
    w.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('fs.stat', ($: unknown, e: { path: string }) => {
    const t = opts.stats?.[e.path]
    return t === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: 1, mtimeMs: t } }
  })
  on('prompt.mention', () => ({ type: opts.mention === undefined ? 'file' : opts.mention }))
  on('ui.open', ($: unknown, e: { id: string }) => {
    w.panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($: unknown, e: { id: string }) => {
    w.panes.push('closed:' + e.id)
    return { value: undefined }
  })
  on('model.complete', ($: unknown, e: any) => {
    w.calls.push({ model: e.model, system: e.system, prompt: e.prompt, maxTokens: e.maxTokens, timeoutMs: e.timeoutMs })
    const r = replies.length ? replies.shift() : { decisions: [], preferences: [] }
    const usage = { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (r === null || r === undefined) return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } }
    return { value: { isAnswered: true, text: typeof r === 'string' ? r : JSON.stringify(r), usage } }
  })
  on('fs.read', ($: unknown, e: { path: string }) => {
    w.looked.push(e.path)
    return e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }
  })
  on('store.get', ($: unknown, e: { key: string }) => ({ value: w.store.get(e.key) }))
  on('store.set', ($: unknown, e: { key: string; value: unknown }) => {
    if ((opts.refuseStore ?? []).some(p => String(e.key).startsWith(p))) return { deny: 'store unavailable' }
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($: unknown, e: { key: string }) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  // instructionFiles go back as they came (the routing rules join them as an instruction file)
  on('prompt.context', ($: unknown, e: { blocks: unknown[]; instructionFiles?: unknown[] }) =>
    e.instructionFiles === undefined ? { blocks: e.blocks } : { blocks: e.blocks, instructionFiles: e.instructionFiles },
  )
  // the prompt box takes the text (added for routing)
  on('prompt.fill', ($: unknown, e: { text: string }) => {
    w.filled.push(e.text)
    return { isFilled: true }
  })
  // the subagent starts on the model it was handed (added for routing)
  on('agent.spawn', ($: unknown, e: { model?: unknown; description?: unknown }) => {
    w.spawned.push({ model: e.model, description: e.description })
    return { model: typeof e.model === 'string' ? e.model : 'parent-model', agentId: 'agent-' + w.spawned.length }
  })
  on('process.run', ($: unknown, e: { argv: string[]; init?: { cwd?: string } }) => {
    w.processes.push(e.argv)
    const r = opts.run?.(e.argv, e.init?.cwd) ?? DEFAULT_RUN(e.argv)
    return { value: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? '' } }
  })
  on('command.register', ($: unknown, e: any) => {
    const name = String((e?.command ?? e)?.name)
    w.attempted.push(name)
    if (refuse.includes(name)) return { deny: `"/${name}" refused: it is the built-in /${name}` }
    w.registered.push(name)
    w.commands.push({ ...(e?.command ?? e) })
    return { value: undefined }
  })
  on('tool.register', ($: unknown, e: any) => {
    const t = e?.tool ?? e
    w.tools.push({ name: String(t?.name), isDeferred: t?.isDeferred, description: t?.description })
    return { value: undefined }
  })
  on('ui.toast', ($: unknown, e: { text: string }) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($: unknown, e: { text: string }) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('session.start', () => ({ cwd: CWD }))
  // the tool runs: `tool` answers first; AskUserQuestion is how $.ui.ask reaches the user (answers in order)
  on('tool.call', ($: unknown, e: any) => {
    const own = opts.tool?.(e)
    if (own !== undefined) return own
    if (e?.tool === 'AskUserQuestion') {
      const q = String(e.questions?.[0]?.question ?? '')
      w.asked.push(q)
      const answer = answers.length > 1 ? answers.shift() : answers[0]
      if (answer === undefined || answer === 'reject') return { deny: 'no one to ask' }
      return { result: { answers: { [q]: answer } } }
    }
    w.ran.push(String(e?.tool))
    return { result: 'ran' }
  })
  // what the permission rules decided, below every hook: a locked path is refused, anything else gets `below`
  on('tool.check', ($: unknown, e: any) =>
    (opts.locked ?? []).includes(String(e?.input?.file_path ?? '')) ? { decision: 'deny', reason: 'locked' } : { decision: opts.below ?? 'allow' },
  )
  on('prompt.submit', ($: unknown, e: any) => {
    w.submitted.push({ text: e?.text, origin: e?.origin, asUser: e?.asUser ?? e?.origin?.asUser })
    return { text: e?.text }
  })
  return w
}

/** Fire session.start, which runs every concern's session.start hook. It does not run by itself. */
export const start = async ($: any) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

/** Run /lk with these arguments; resolves to the text that came back. */
export const lk = async ($: any, args: string, command = 'lk'): Promise<string> => {
  const r: any = await $.command.run({ command, args })
  return String(r?.text ?? '')
}

/** Call a loopkeeper tool as the model would, by its short name. */
export const tool = async ($: any, name: string, input: Record<string, unknown>): Promise<any> =>
  $.tool.call({ tool: `mcp__loopkeeper__${name}`, ...input })

export const BAND = {
  plugin: 'loopkeeper',
  component: 'AbovePrompt',
  requestId: 'AbovePrompt',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

/** Every Text string of a drawn element, depth first, in drawing order. */
export function texts(el: any): string[] {
  if (el === null || el === undefined) return []
  if (typeof el === 'string' || typeof el === 'number') return [String(el)]
  const kids: any[] = Array.isArray(el.children) ? el.children : el.children === undefined ? [] : [el.children]
  return kids.flatMap(texts)
}

// ---- added for gates ----

let ids = 0
/** A tool.check event for an edit tool (NotebookEdit names notebook_path). */
export const edit = (file: string, tool = 'Edit') => ({
  tool,
  input: tool === 'NotebookEdit' ? { notebook_path: file, new_source: 'x' } : { file_path: file, old_string: 'a', new_string: 'b' },
  tool_use_id: `u${++ids}`,
})
/** A tool.check event for Bash. */
export const bash = (command: string) => ({ tool: 'Bash', input: { command }, tool_use_id: `u${++ids}` })

/** Start the session, then a main-loop turn (the gates count files per turn). */
export const startTurn = async ($: any, turnId = 't1') => {
  await start($)
  await $.turn.start({ text: 'do the thing', turnId })
}

/** A loopkeeper.json with this changeControl section, for the project or the user. */
export const projectGates = (cc: unknown) => ({ [PROJECT_CONFIG]: JSON.stringify({ changeControl: cc }) })
export const userGates = (cc: unknown) => ({ [USER_CONFIG]: JSON.stringify({ changeControl: cc }) })

// ---- band lines (kit.line) ----

/** One drawn Text of a band line: its text, color and bold. */
export type LineText = { text: string; color?: string; bold?: boolean }
/** A kit band line: the label, its `● text` chips and the quiet right side (absent when empty). */
export type BandLine = { label: LineText; chips: LineText[]; right?: LineText }

const lineText = (n: any): LineText => ({ text: texts(n).join(''), color: n?.props?.color, bold: n?.props?.bold })

/** The kit band line labelled `label` in a drawn tree (`await ui.drawn()`), or undefined. */
export function lineOf(tree: any, label: string): BandLine | undefined {
  if (tree === null || tree === undefined || typeof tree !== 'object') return undefined
  const kids: any[] = Array.isArray(tree.children) ? tree.children : tree.children === undefined ? [] : [tree.children]
  const p = tree.props ?? {}
  if (tree.type === 'Box' && p.justifyContent === 'space-between' && p.columnGap === 2) {
    const [left, right] = kids.filter(k => k !== null && k !== undefined && k !== false)
    const [head, ...chips] = (Array.isArray(left?.children) ? left.children : []).filter((k: any) => k !== null && k !== undefined && k !== false)
    if (head && texts(head).join('') === label) {
      return { label: lineText(head), chips: chips.map(lineText), ...(right ? { right: lineText(right) } : {}) }
    }
  }
  for (const k of kids) {
    const found = lineOf(k, label)
    if (found) return found
  }
  return undefined
}

/** A band line as plain text: `label  ● a  ● b   right`. */
export function linePlain(l: BandLine | undefined): string {
  if (!l) return ''
  return [l.label.text, ...l.chips.map(c => c.text)].join('  ') + (l.right ? '   ' + l.right.text : '')
}

/** Mount the band on a surface and read the line labelled `label` (undefined when not drawn). */
export async function bandLineOf($: any, label: string, surface: 'terminal' | 'desktop' = 'terminal'): Promise<BandLine | undefined> {
  const ui = await $.ui.mount({ ...BAND, surface })
  const found = lineOf(await ui.drawn(), label)
  await ui.unmount()
  return found
}
