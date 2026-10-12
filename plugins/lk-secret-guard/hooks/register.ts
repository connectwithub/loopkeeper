// lk-secret-guard: a seatbelt that stops credential-shaped strings and a private
// deny-list of words from being written into files or shell commands.
//
// tool.call (Write, Edit, MultiEdit, NotebookEdit, Bash): scans only the NEW
// text the call would write. A "block" finding refuses the call; a "warn"
// finding asks the user (Allow once / Block). Subagents' calls are guarded too.
// Every decision is logged in $.state with the value masked, never raw.
//
// Helpers that take `$` are top-level functions in this file, as the static
// analysis requires; the pattern table and pure matching live in ./patterns.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { GuardConfig, LogRow } from '../types'
import {
  askQuestion,
  bandParts,
  blockMessage,
  judge,
  mergeConfig,
  parseConfig,
  scan,
  targetOf,
  type Config,
  type Finding,
} from './patterns'
import { TONES, makeKit } from './kit'
import type { Elements } from './kit'
import { activeRules, lastBlocked, outcomeOf, ruleRows, wordScope } from './pane'

const PANE_ID = 'secret-guard'
const LOG_KEEP = 200
const PANE_ROWS = 20
/** Secondary text: the theme's quiet key. */
const QUIET = TONES.muted.fg

const enabledAtom = atom({ plugin: 'lk-secret-guard', key: 'enabled' } as const, true)
const bandAtom = atom({ plugin: 'lk-secret-guard', key: 'band' } as const, true)
const logAtom = atom({ plugin: 'lk-secret-guard', key: 'log' } as const, [] as LogRow[])
const blockedAtom = atom({ plugin: 'lk-secret-guard', key: 'blocked' } as const, 0)
const allowedAtom = atom({ plugin: 'lk-secret-guard', key: 'allowed' } as const, 0)
const configAtom = atom({ plugin: 'lk-secret-guard', key: 'config' } as const, null as GuardConfig | null)
const filesAtom = atom({ plugin: 'lk-secret-guard', key: 'configFiles' } as const, [] as string[])
const errorsAtom = atom({ plugin: 'lk-secret-guard', key: 'configErrors' } as const, [] as string[])

const USAGE =
  'usage: /secret-guard (open the pane) · on · off · reload · test <text> · band on|off'

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    try {
      await loadConfig($)
    } catch {
      // The guard loads the config again on the first guarded call.
    }
    try {
      await loadBand($)
    } catch {
      // The band stays at its default.
    }
    try {
      await $.command.register({
        name: 'secret-guard',
        description: 'Secret guard: status pane, on/off, reload config, test a string, band on/off',
        argumentHint: '[on|off|reload|test <text>|band on|off]',
        immediate: true,
      })
    } catch {
      // The name is taken; the guard itself still runs.
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state, and session.start does not fire again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      await loadConfig($)
      await loadBand($)
    } catch {
      // Loaded again lazily on the next guarded call.
    }
    return next(e)
  })

  on('tool.call', { tool: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const fields = e as unknown as Record<string, unknown>
    const target = targetOf(fields)
    if (target === null || target.texts.length === 0) return next(e)
    if (!(await read($, enabledAtom))) return next(e)

    const config = await ensureConfig($)
    const ctx = await pathCtx($)
    const verdict = judge(target, config, ctx)
    if (verdict.findings.length === 0) return next(e)

    const agentId = typeof fields.agentId === 'string' && fields.agentId !== '' ? fields.agentId : undefined
    const first = verdict.findings[0]
    if (first.action === 'block') {
      await record($, first, target.where, 'blocked', agentId)
      return { deny: blockMessage(first, target.where) }
    }

    const warns = verdict.findings
    let answer: string | null = null
    try {
      answer = await $.ui.ask(askQuestion(first, target.where, warns.length - 1), ['Allow once', 'Block'])
    } catch {
      answer = null
    }
    if (answer === null) {
      // Dismissed, or nobody to ask. Non-interactive runs (-p, SDK) allow with a toast;
      // a person who dismissed the question gets the safe answer.
      const surfaces = await $.session.surfaces()
      if (surfaces.length === 0) {
        $.ui.toast(`possible ${first.kind} in ${target.where} (${first.masked}) allowed: no one to ask`)
        await record($, first, target.where, 'allowed', agentId)
        return next(e)
      }
      await record($, first, target.where, 'blocked', agentId)
      return { deny: blockMessage(first, target.where) + ' (The question was dismissed.)' }
    }
    if (answer === 'Allow once') {
      await record($, first, target.where, 'warned-allowed', agentId)
      return next(e)
    }
    await record($, first, target.where, 'blocked', agentId)
    return { deny: blockMessage(first, target.where) + ' The user chose Block.' }
  }).catch(async ($, e, next) => {
    const kind = next.error?.kind ?? 'throw'
    const message = String(next.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 120)
    return {
      deny: `secret-guard failed (${kind}: ${message}), so this call was not run. Retry, or run /secret-guard off if the guard is broken.`,
    }
  })

  on('command.run', { command: 'secret-guard' }, async ($, e) => {
    const args = typeof e.args === 'string' ? e.args.trim() : ''
    const [sub = '', ...rest] = args.split(/\s+/)
    const verb = sub.toLowerCase()

    if (verb === '') {
      await $.ui.open({ id: PANE_ID, title: 'Secret guard', focus: true, closeOnEscape: true })
      return {}
    }
    if (verb === 'off') {
      await update($, enabledAtom, () => false)
      return { text: 'off for this session. Writes and commands are not checked. Run /secret-guard on to resume.' }
    }
    if (verb === 'on') {
      await update($, enabledAtom, () => true)
      return { text: 'on. Writes and commands are checked for credentials and deny-listed words.' }
    }
    if (verb === 'reload') {
      const config = await loadConfig($)
      const files = await read($, filesAtom)
      const errors = await read($, errorsAtom)
      return { text: describeConfig(config, files, errors) }
    }
    if (verb === 'band') {
      const value = (rest[0] ?? '').toLowerCase()
      if (value !== 'on' && value !== 'off') return { text: 'usage: /secret-guard band on|off' }
      await $.store.set('band', value === 'on')
      await update($, bandAtom, () => value === 'on')
      return { text: `band ${value} (saved for future sessions).` }
    }
    if (verb === 'test') {
      const text = args.replace(/^test\s*/i, '')
      if (text === '') return { text: 'usage: /secret-guard test <text>' }
      const config = await ensureConfig($)
      return { text: describeTest(scan(text, { config, wordsApply: true }), await read($, enabledAtom)) }
    }
    return { text: USAGE }
  })

  // The band, one kit line: a bold label, then the blocked and allowed counts as chips (danger and ok
  // once nonzero, else quiet); when the guard is off, an `off for this session` chip in danger and how
  // to resume on the right side, in the default text color (kit.line draws its right side quiet).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const isOn = await read($, enabledAtom)
    const showBand = await read($, bandAtom)
    const blocked = await read($, blockedAtom)
    const allowed = await read($, allowedAtom)
    if (isOn && (!showBand || blocked + allowed === 0)) return next(e)
    const parts = bandParts(isOn, blocked, allowed)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const kit = makeKit(ui as unknown as Elements, e.surface)
    const drawn = (
      parts.urgent && parts.right
        ? Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            columnGap: 2,
            children: [kit.line('secret-guard', parts.chips) as ReturnType<typeof Box>, kit.text(parts.right, { wrap: 'truncate' }) as ReturnType<typeof Box>],
          })
        : kit.line('secret-guard', parts.chips, parts.right)
    ) as ReturnType<typeof Box>
    const line = Box({ key: 'secret-guard-band', flexDirection: 'column', children: [drawn] })
    const theirs = await next(e)
    if (theirs === null || theirs === undefined) return line
    return Box({ flexDirection: 'column', children: [line, theirs] })
  })

  // The pane, drawn with the kit: the last block as the hero, tiles, then the recent decisions,
  // the rules and the config files as sections. Values are masked; word lists are only counted.
  // A page: one row between blocks; the rows inside a section stay together.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const kit = makeKit($.ui.resolve(e) as unknown as Elements, e.surface)
    const isOn = await read($, enabledAtom)
    const showBand = await read($, bandAtom)
    const blocked = await read($, blockedAtom)
    const allowed = await read($, allowedAtom)
    const config = await read($, configAtom)
    const files = await read($, filesAtom)
    const errors = await read($, errorsAtom)
    const log = await read($, logAtom)
    const rows = log.slice(-PANE_ROWS).reverse()
    const last = lastBlocked(log)
    const dim = (s: string) => kit.text(s, { color: QUIET, wrap: 'truncate' })

    const hero = last
      ? kit.hero({
          kicker: 'secret guard',
          title: `Blocked ${last.kind} in ${last.where}`,
          sub: [clock(last.at), last.masked, last.agentId ? 'agent ' + last.agentId : ''].filter(Boolean).join(' · '),
          tone: 'danger',
        })
      : kit.hero({
          kicker: 'secret guard',
          title: 'Nothing blocked yet',
          sub: isOn
            ? 'Checking the new text of Write, Edit, MultiEdit, NotebookEdit and Bash calls'
            : 'The guard is off for this session · /secret-guard on to resume',
          tone: isOn ? 'ok' : 'danger',
        })

    const status = kit.row({
      key: 'status',
      left: [
        kit.text(isOn ? 'Status: ON' : 'Status: OFF for this session', {
          color: TONES[isOn ? 'ok' : 'danger'].fg,
          bold: true,
          wrap: 'truncate',
        }),
      ],
      right: `Band above the prompt: ${showBand ? 'on' : 'off'}`,
    })

    const recent = kit.stack([
      kit.section(`Recent · ${rows.length}`, rows.length > 0 ? 'newest first' : undefined),
      ...(rows.length > 0
        ? rows.map((r, i) => {
            const o = outcomeOf(r.action)
            return kit.row({
              key: `row-${i}`,
              left: [
                dim(clock(r.at)),
                kit.pill(o.label, o.tone),
                kit.text(r.kind, { bold: true, wrap: 'truncate' }),
                kit.text(`in ${r.where} (${r.masked})`, { wrap: 'truncate' }),
              ],
              right: r.agentId ? 'agent ' + r.agentId : '',
              align: 'center',
            })
          })
        : [dim('No decisions yet this session')]),
    ])

    const rulesList = config === null ? [] : ruleRows(config)
    const off = rulesList.filter(r => !r.on).length
    const rules =
      config === null
        ? kit.stack([kit.section('Rules'), dim('Not loaded yet: /secret-guard reload reads the config files')])
        : kit.stack([
            kit.section(`Rules · ${activeRules(config)}`, off > 0 ? `${off} off` : undefined),
            ...rulesList.map(r =>
              kit.row({
                key: r.key,
                left: [
                  kit.text(r.name, r.on ? { wrap: 'truncate' } : { color: QUIET, wrap: 'truncate' }),
                  kit.pill(r.source, r.source === 'config' ? 'accent' : 'muted'),
                ],
                right: r.right,
                align: 'center',
              }),
            ),
          ])

    const configSection = kit.stack([
      kit.section(`Config · ${files.length}`, errors.length > 0 ? `${errors.length} ignored` : undefined),
      ...(files.length > 0
        ? files.map((f, i) => kit.row({ key: `file-${i}`, left: [kit.text(f, { wrap: 'truncate' })], right: 'loaded' }))
        : [dim('No files found (built-in patterns only)')]),
      ...errors.map((err, i) =>
        kit.row({ key: `err-${i}`, left: [kit.pill('ignored', 'danger'), kit.text(err, { color: TONES.danger.fg, wrap: 'truncate' })], align: 'center' }),
      ),
      config === null ? null : dim(`${config.allowPaths.length} allowPaths · word lists apply ${wordScope(config)}`),
    ])

    return kit.page([
      hero,
      kit.tiles([
        { label: 'Blocked', value: String(blocked), tone: blocked > 0 ? 'danger' : 'muted' },
        { label: 'Allowed', value: String(allowed), tone: allowed > 0 ? 'ok' : 'muted' },
        { label: 'Rules', value: config === null ? '—' : String(activeRules(config)), tone: 'info' },
      ]),
      status,
      recent,
      rules,
      configSection,
      kit.buttons([
        {
          key: 'close',
          label: 'Close',
          hotkey: 'c',
          plain: true,
          onPress: async () => {
            await $.ui.close({ id: PANE_ID })
          },
        },
      ]),
    ]) as never
  })
}

// ---- Helpers that take $ ----------------------------------------------------

async function pathCtx($: EngineInterface) {
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  return { cwd, home }
}

async function ensureConfig($: EngineInterface): Promise<Config> {
  const cached = await read($, configAtom)
  if (cached !== null) return cached
  return loadConfig($)
}

/** Reads ~/.claude/secret-guard.json, then <cwd>/.claude/secret-guard.json; later wins. */
async function loadConfig($: EngineInterface): Promise<Config> {
  const home = (await $.env.get('HOME')) ?? ''
  const cwd = (await $.session.cwd()).replace(/\/+$/, '')
  const candidates: string[] = []
  if (home !== '') candidates.push(home.replace(/\/+$/, '') + '/.claude/secret-guard.json')
  const project = cwd + '/.claude/secret-guard.json'
  if (!candidates.includes(project)) candidates.push(project)

  const layers = []
  const files: string[] = []
  const errors: string[] = []
  for (const path of candidates) {
    let exists = false
    try {
      exists = await $.fs.exists(path)
    } catch {
      exists = false
    }
    if (!exists) continue
    try {
      const text = String(await $.fs.read(path))
      layers.push(parseConfig(text))
      files.push(path)
    } catch {
      // Never echo the parser's message: it can quote the file, and the file holds private words.
      errors.push(`${path} is unreadable or not a JSON object`)
    }
  }
  const merged = mergeConfig(layers)
  await update($, configAtom, () => merged)
  await update($, filesAtom, () => files)
  await update($, errorsAtom, () => errors)
  if (errors.length > 0) {
    $.ui.toast(`config ignored: ${errors.join('; ')}`)
  }
  return merged
}

async function loadBand($: EngineInterface) {
  const saved = await $.store.get('band')
  await update($, bandAtom, () => saved !== false)
}

async function record(
  $: EngineInterface,
  f: Finding,
  where: string,
  action: LogRow['action'],
  agentId: string | undefined,
) {
  const row: LogRow = { at: Date.now(), kind: f.kind, where, masked: f.masked, action }
  if (agentId !== undefined) row.agentId = agentId
  await update($, logAtom, rows => [...rows, row].slice(-LOG_KEEP))
  if (action === 'blocked') {
    await update($, blockedAtom, n => n + 1)
  } else {
    await update($, allowedAtom, n => n + 1)
  }
}

// ---- Pure text helpers --------------------------------------------------------

function clock(at: number): string {
  try {
    return new Date(at).toISOString().slice(11, 19)
  } catch {
    return '--:--:--'
  }
}

function rulesSummary(c: Config): string {
  const scope = c.publicPaths === null ? 'everywhere' : `only in ${c.publicPaths.length} public path(s)`
  const disabled = c.disabledKinds.length > 0 ? ` · disabled: ${c.disabledKinds.join(', ')}` : ''
  return `Rules: ${c.deny.length} deny word(s), ${c.warn.length} warn word(s), applied ${scope} · ${c.allowPaths.length} allowPaths${disabled}`
}

function describeConfig(c: Config, files: string[], errors: string[]): string {
  const found = files.length > 0 ? `reloaded ${files.join(', ')}.` : 'reloaded: no config files found, built-in patterns only.'
  const bad = errors.length > 0 ? ` Ignored: ${errors.join('; ')}.` : ''
  return `${found} ${rulesSummary(c)}.${bad}`
}

function describeTest(findings: Finding[], isOn: boolean): string {
  const off = isOn ? '' : ' (The guard is off for this session, so nothing would be stopped right now.)'
  if (findings.length === 0) return `nothing in that text would be flagged.${off}`
  const lines = findings.map(f => `- would ${f.action === 'block' ? 'BLOCK' : 'ASK (warn)'}: ${f.kind} (${f.masked})`)
  return `${findings.length} finding(s); word lists applied as if the path were public:\n${lines.join('\n')}${off}`
}
