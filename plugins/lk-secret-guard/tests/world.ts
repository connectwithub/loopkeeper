// Shared stubs for lk-secret-guard tests. Every fake credential is assembled at
// run time so this file holds no credential-shaped literal of its own.

export const CWD = '/work'
export const HOME = '/home/tester'

const rep = (s: string, n: number) => s.repeat(n)

export const FAKE = {
  aws: 'AKIA' + 'QWERTYUIOP' + '123456',
  anthropic: 'sk-' + 'ant-' + 'api03-' + rep('Ab3', 9),
  openai: 'sk-' + rep('Zq9', 9),
  openaiProj: 'sk-' + 'proj-' + rep('Xy7_', 7),
  github: 'gh' + 'p_' + rep('A1b2', 10),
  githubPat: 'github' + '_pat_' + rep('11ABC', 6),
  slack: 'xo' + 'xb-' + '1234567890-' + rep('abc', 5),
  google: 'AI' + 'za' + rep('Sy0_', 8) + 'abc',
  stripe: 'sk' + '_live_' + rep('a1B2', 7),
  stripeRestricted: 'rk' + '_live_' + rep('c3D4', 7),
  twilio: 'S' + 'K' + rep('0123456789abcdef', 2),
  privateKey: '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
  jwt: 'ey' + 'J' + rep('hbGciOi', 2) + '.ey' + 'J' + rep('zdWIiOi', 2) + '.' + rep('SflKxw', 2),
}

export type World = {
  ran: Array<Record<string, unknown>>
  asked: string[]
  toasts: string[]
  store: Map<string, unknown>
  /** Pane ids passed to $.ui.close. */
  closed: string[]
}

export type WorldOptions = {
  /** Files by absolute path. */
  files?: Record<string, string>
  /** What the user answers to $.ui.ask; 'reject' makes the ask reject. */
  answer?: 'Allow once' | 'Block' | 'reject'
  /** What $.session.surfaces resolves to. */
  surfaces?: string[]
  /** Make $.session.cwd reject, to exercise the fail-closed handler. */
  breakCwd?: boolean
}

export function world(on: any, opts: WorldOptions = {}): World {
  const w: World = { ran: [], asked: [], toasts: [], store: new Map(), closed: [] }
  const files = opts.files ?? {}
  on('session.cwd', () => (opts.breakCwd ? { deny: 'cwd unavailable' } : { value: CWD }))
  on('env.get', ($: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', ($: unknown, e: { path: string }) => ({ value: e.path in files }))
  on('fs.read', ($: unknown, e: { path: string }) =>
    e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' },
  )
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('ui.toast', ($: unknown, e: { text: string }) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('store.get', ($: unknown, e: { key: string }) => ({ value: w.store.get(e.key) }))
  on('store.set', ($: unknown, e: { key: string; value: unknown }) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', ($: unknown, e: { id: string }) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('session.start', () => ({ cwd: CWD }))
  on('tool.call', ($: unknown, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0].question
      w.asked.push(q)
      if (opts.answer === 'reject') return { deny: 'no one to ask' }
      return { result: { answers: { [q]: opts.answer ?? 'Block' } } }
    }
    w.ran.push(e)
    return { result: 'ran' }
  })
  return w
}

export const PANE = {
  plugin: 'lk-secret-guard',
  component: 'Pane',
  requestId: 'secret-guard',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: {
    title: 'Secret guard',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

export const BAND = {
  plugin: 'lk-secret-guard',
  component: 'AbovePrompt',
  requestId: 'AbovePrompt',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

export const projectConfig = (cfg: unknown) => ({ [CWD + '/.claude/secret-guard.json']: JSON.stringify(cfg) })
export const globalConfig = (cfg: unknown) => ({ [HOME + '/.claude/secret-guard.json']: JSON.stringify(cfg) })

// ---------- reading a drawn band ----------

type Drawn = { type: string; props: Record<string, unknown>; children: unknown[] }

/** Every element of a drawn tree, depth first. */
export function* walk(n: unknown): Generator<Drawn> {
  if (n === null || typeof n !== 'object') return
  const d = n as Drawn
  yield d
  for (const c of Array.isArray(d.children) ? d.children : []) yield* walk(c)
}

/** What a drawn band shows: `label  ● chip  ● chip`, each chip's color, and the right side with its color. */
export type BandSeen = { text: string; tones: unknown[]; right?: string; rightColor?: unknown; bold?: unknown }

/** Reads the band under its keyed Box: the bold label, the `● ` chips, then the right side. */
export function bandSeen(root: unknown): BandSeen | undefined {
  const texts = [...walk(root)].filter(n => n.type === 'Text' && typeof n.children[0] === 'string')
  const [label, ...rest] = texts
  if (!label) return undefined
  const chips = rest.filter(t => String(t.children[0]).startsWith('● '))
  const right = rest.find(t => !String(t.children[0]).startsWith('● '))
  const seen: BandSeen = {
    text: [label, ...chips].map(t => String(t.children[0])).join('  '),
    tones: chips.map(c => c.props.color),
    bold: label.props.bold,
  }
  if (right) {
    seen.right = String(right.children[0])
    seen.rightColor = right.props.color
  }
  return seen
}
