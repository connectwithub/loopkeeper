// Routing concern: the model of each subagent chosen by role (agent.spawn), the loop rules block
// (prompt.context), GSD mode and its loop, the routing band, the Routing pane (the nav bar first) and its hub row.
// Ported from gsd-orchestrator.
// Owns the /lk words routes, loop, route, explain and text; shares status, reload, band, on and off.
// GSD mode, loop, band and route overrides live in $.store, shared by every session on the machine, as before.
// ADR 0004: nothing is sent to the other concerns; stage and gates act on /lk on|off and /lk loop themselves.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { LkNext, LkRole, LkRouteDecision, LkRoutingConfig } from '../types/index.d.ts'
import { decide, explain } from './lib/classify.ts'
import type { SpawnDecision } from './lib/classify.ts'
import { TONES, makeKit } from './lib/kit.ts'
import type { Elements, Tone } from './lib/kit.ts'
import { rulesText, withRules } from './lib/loopRules.ts'
import { DISABLE_ENV, PLUGIN, joinText, projectConfigPath, storeKey, subOf, userConfigPath } from './lib/names.ts'
import { HUB_ID, HUB_ROWS, PANES } from './lib/panes.ts'
import { ROLES, buildConfig, isModelName, isRole, resolveModel, routingLayer, sane } from './lib/routingConfig.ts'
import {
  DISABLED_NOTE,
  USAGE,
  approvalLine,
  clockOf,
  countsLine,
  loopEffects,
  loopLine,
  routingBand,
  statusLine,
  statusText,
  tableRow,
  tableRows,
} from './lib/routingFormat.ts'
import { DEFAULT_LIMITS, killSwitchOn } from './lib/stageModel.ts'
import type { Approval, Limits } from './lib/stageModel.ts'

const PANE_ID = 'loopkeeper-routes'
const KEEP_DECISIONS = 50
// The pane's Recent spawns section shows this many, newest first.
const SHOWN_SPAWNS = 8
// A role's badge tone in the pane.
const ROLE_TONES: Record<LkRole, Tone> = { recon: 'muted', execute: 'info', verify: 'ok', hard: 'accent', default: 'muted' }
const CONCERN_WORDS = ['stage', 'gates', 'files', 'routing', 'review', 'decisions']

const MODE_KEY = storeKey('routing', 'mode')
const LOOP_KEY = storeKey('routing', 'loop')
const BAND_KEY = storeKey('routing', 'band')
const OVERRIDES_KEY = storeKey('routing', 'overrides')

const routeMode = atom({ plugin: 'loopkeeper', key: 'routeMode' } as const, false)
const routeLoop = atom({ plugin: 'loopkeeper', key: 'routeLoop' } as const, true)
const routeBand = atom({ plugin: 'loopkeeper', key: 'routeBand' } as const, true)
const routeDecisions = atom({ plugin: 'loopkeeper', key: 'routeDecisions' } as const, [] as LkRouteDecision[])
const routeCounts = atom({ plugin: 'loopkeeper', key: 'routeCounts' } as const, {} as Record<string, number>)
const routeRouted = atom({ plugin: 'loopkeeper', key: 'routeRouted' } as const, 0)
const routeConfig = atom({ plugin: 'loopkeeper', key: 'routeConfig' } as const, null as LkRoutingConfig | null)
const routeDisabled = atom({ plugin: 'loopkeeper', key: 'routeDisabled' } as const, false)
// Read only, written by the stage: its plan approval mode (ADR 0005) and the file budget numbers, for the rules
// block and the pane.
const stageApproval = atom({ plugin: 'loopkeeper', key: 'stageApproval' } as const, 'auto' as Approval)
const stageLimits = atom({ plugin: 'loopkeeper', key: 'stageLimits' } as const, { ...DEFAULT_LIMITS } as Limits)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---- Helpers that take $ (same file, so validate can follow them) ----------------------------------------------

async function textOf($: EngineInterface, path: string): Promise<string | null> {
  try {
    return (await $.fs.exists(path)) ? await $.fs.read(path) : null
  } catch {
    return null
  }
}

async function routingStoreGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function routingStoreSet($: EngineInterface, key: string, value: unknown): Promise<boolean> {
  try {
    await $.store.set(key, value)
    return true
  } catch {
    return false
  }
}

/** Re-read the routing section of both config files and the stored switches into the atoms. */
async function loadAll($: EngineInterface): Promise<LkRoutingConfig> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const cwd = (await $.session.cwd().catch(() => undefined)) ?? ''
  const userPath = home ? userConfigPath(home) : ''
  const projectPath = cwd ? projectConfigPath(cwd) : ''
  const userLayer = userPath ? routingLayer(await textOf($, userPath)) : undefined
  const projectLayer = projectPath && projectPath !== userPath ? routingLayer(await textOf($, projectPath)) : undefined
  const config = buildConfig(userLayer, projectLayer, await routingStoreGet($, OVERRIDES_KEY))
  const savedMode = await routingStoreGet($, MODE_KEY)
  const savedBand = await routingStoreGet($, BAND_KEY)
  const savedLoop = await routingStoreGet($, LOOP_KEY)
  await update($, routeConfig, () => config)
  // an explicit /lk on|off wins over the files' `enabled`
  await update($, routeMode, () => (typeof savedMode === 'boolean' ? savedMode : config.enabled === true))
  await update($, routeBand, () => (typeof savedBand === 'boolean' ? savedBand : true))
  await update($, routeLoop, () => (typeof savedLoop === 'boolean' ? savedLoop : true))
  return config
}

/** ADR 0009: CLAUDE_MODS_DISABLE naming loopkeeper (or all) turns spawn routing off; the rules may stay. */
async function loadKill($: EngineInterface): Promise<boolean> {
  const off = killSwitchOn(await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined))
  await update($, routeDisabled, () => off)
  return off
}

function rerender($: EngineInterface): void {
  try {
    $.ui.invalidate('prompt.context')
  } catch {
    // The rules follow on the next re-read of the context.
  }
}

/** Turn GSD mode on or off, save it, and have the engine re-render the context. */
async function setMode($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, routeMode, () => isOn)
  await routingStoreSet($, MODE_KEY, isOn)
  rerender($)
}

/** Turn the loop on or off and save it; the rules change only while the mode is on. */
async function setLoop($: EngineInterface, isLoop: boolean): Promise<void> {
  await update($, routeLoop, () => isLoop)
  await routingStoreSet($, LOOP_KEY, isLoop)
  if ((await read($, routeMode)) === true) rerender($)
}

async function nowOf($: EngineInterface): Promise<number> {
  try {
    const t = await $.clock.now()
    return typeof t === 'number' ? t : Date.now()
  } catch {
    return Date.now()
  }
}

/** Keep one routing decision, the per-model count and the routed count. */
async function record($: EngineInterface, d: SpawnDecision): Promise<void> {
  const at = await nowOf($)
  const { setModel: _set, ...kept } = d
  const entry: LkRouteDecision = { at, ...kept }
  await update($, routeDecisions, list => [...(list ?? []), entry].slice(-KEEP_DECISIONS))
  if (d.source !== 'off') {
    await update($, routeCounts, c => ({ ...(c ?? {}), [d.model]: ((c ?? {})[d.model] ?? 0) + 1 }))
  }
  if (d.setModel !== undefined) await update($, routeRouted, n => (n ?? 0) + 1)
}

async function currentConfig($: EngineInterface): Promise<LkRoutingConfig> {
  return sane(await read($, routeConfig))
}

async function modeText($: EngineInterface, isOn: boolean): Promise<string> {
  if (!isOn) return 'GSD orchestrator mode off: subagents keep the model they ask for and the rules leave the context.'
  const isLoop = (await read($, routeLoop)) !== false
  const disabled = (await read($, routeDisabled)) === true
  return (
    'GSD orchestrator mode on: subagents are routed by role and the orchestrator rules join the context.' +
    (isLoop ? ' Loop on: the stage takes preset gsd and the gates require a plan.' : '') +
    (disabled ? ` Spawns are not routed while ${DISABLE_ENV} names ${PLUGIN}.` : '')
  )
}

async function textAnswer($: EngineInterface): Promise<string> {
  return statusText({
    isOn: (await read($, routeMode)) === true,
    isBand: (await read($, routeBand)) !== false,
    isLoop: (await read($, routeLoop)) !== false,
    disabled: (await read($, routeDisabled)) === true,
    config: await currentConfig($),
    decisions: (await read($, routeDecisions)) ?? [],
    counts: (await read($, routeCounts)) ?? {},
    routed: (await read($, routeRouted)) ?? 0,
  })
}

// ---- /lk ---------------------------------------------------------------------------------------------------------

/** The words routing owns. Undefined when the word is not routing's, so the chain moves on. */
async function ownWord($: EngineInterface, sub: string, rest: string[], text: string): Promise<{ text?: string } | undefined> {
  if (sub === 'routes') {
    await $.ui.open({ id: PANE_ID, title: 'Routing', focus: true, closeOnEscape: true })
    return {}
  }
  if (sub === 'loop') {
    const want = (rest[0] ?? '').toLowerCase()
    if (want !== 'on' && want !== 'off') return { text: USAGE.loop }
    await setLoop($, want === 'on')
    // the stage and the gates, earlier in the chain, add what they switched
    return { text: `GSD loop ${want}.` + ((await read($, routeMode)) === true ? '' : ' It takes effect when the mode is on.') }
  }
  if (sub === 'route') {
    const role = (rest[0] ?? '').toLowerCase()
    if (role === 'reset' && rest.length === 1) {
      await $.store.delete(OVERRIDES_KEY)
      return { text: 'Overrides dropped. Routing table:\n' + tableRows(await loadAll($)) }
    }
    const model = rest[1] ?? ''
    if (!isRole(role) || !isModelName(model)) return { text: USAGE.route }
    const saved = await routingStoreGet($, OVERRIDES_KEY)
    await $.store.set(OVERRIDES_KEY, { ...(isObj(saved) ? saved : {}), [role]: model })
    const config = await loadAll($)
    return { text: 'Route set for this and later sessions until /lk route reset:\n  ' + tableRow(config, role) }
  }
  if (sub === 'explain') {
    const words = text.split(/\s+/)
    const what = text.slice((words[0] ?? '').length).trim()
    if (what === '') return { text: USAGE.explain }
    return { text: explain(what, await currentConfig($)) }
  }
  // /lk text: the stage and the gates, earlier in the chain, put their parts above this one
  if (sub === 'text') return { text: await textAnswer($) }
  return undefined
}

// The routing line for a /lk word other concerns also answer (status, reload, band, on, off)
// /lk band [concern…] on|off: null when another concern was named, '' when no on/off word was given
function bandWordOf(rest: string[]): string | null {
  const words = rest.map(w => w.toLowerCase())
  const named = words.filter(w => CONCERN_WORDS.includes(w))
  if (named.length > 0 && !named.includes('routing')) return null
  return words.find(w => w === 'on' || w === 'off') ?? ''
}

async function lk($: EngineInterface, e: { args?: unknown }, next: LkNext): Promise<{ text?: string } | undefined> {
  const { sub, rest, text } = subOf(e?.args)
  if (sub === 'status' || sub === 'reload' || sub === 'band' || sub === 'on' || sub === 'off') {
    const r = await next(e)
    let line = ''
    try {
      if (sub === 'status') {
        const modeOn = (await read($, routeMode)) === true
        const loopOn = (await read($, routeLoop)) !== false
        const config = await currentConfig($)
        const routed = (await read($, routeRouted)) ?? 0
        const disabled = (await read($, routeDisabled)) === true
        line = statusLine(modeOn, loopOn, config, routed, disabled)
      } else if (sub === 'reload') {
        await loadKill($)
        const config = await loadAll($)
        line = 'Routing config re-read. Routing table:\n' + tableRows(config)
      } else if (sub === 'band') {
        const want = bandWordOf(rest)
        if (want === '') {
          const shown = (await read($, routeBand)) !== false
          line = `The routing band is ${shown ? 'on' : 'off'}. Usage: /lk band [routing] on|off`
        } else if (want !== null) {
          await update($, routeBand, () => want === 'on')
          let saved = true
          try {
            await $.store.set(BAND_KEY, want === 'on')
          } catch {
            saved = false
          }
          line = `The routing band is ${want}.${saved ? '' : ' (this session only)'}`
        }
      } else {
        await setMode($, sub === 'on')
        line = await modeText($, sub === 'on')
      }
    } catch {
      line = `${PLUGIN}: routing could not answer "${sub}".`
    }
    return { ...(r ?? {}), text: joinText(line, r?.text) }
  }
  let own: { text?: string } | undefined
  try {
    own = await ownWord($, sub, rest, text)
  } catch (err) {
    return { text: `${PLUGIN}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return own ?? next(e)
}

async function lkFailed($: EngineInterface, e: unknown, next: any): Promise<{ text?: string }> {
  const r = next.called ? ((await next(e)) as { text?: string } | undefined) : undefined
  const why = `${next.error?.kind ?? 'throw'}: ${String(next.error?.message ?? '').slice(0, 120)}`
  return { ...(r ?? {}), text: joinText(`${PLUGIN}: the routing command failed (${why}).`, r?.text) }
}

function toast($: EngineInterface, text: string): void {
  try {
    const p: unknown = $.ui.toast(text)
    if (p && typeof (p as Promise<unknown>).then === 'function') (p as Promise<unknown>).then(undefined, () => undefined)
  } catch {
    // Display only.
  }
}

/**
 * A pane button whose switch the stage and the gates must follow. A plugin never sees its own $ calls (so a
 * button cannot run /lk through the other concerns) and ADR 0004 sends nothing, so the /lk words go in the
 * prompt box: Enter runs them across every concern, as typing them would.
 */
async function offer($: EngineInterface, args: string): Promise<void> {
  let filled = false
  try {
    filled = (await $.prompt.fill({ text: '/lk ' + args, mode: 'replace' })).isFilled === true
  } catch {
    filled = false
  }
  toast($, filled ? `Press Enter to run /lk ${args}: the stage and the gates switch with routing.` : `Run /lk ${args}: the stage and the gates switch with routing.`)
}

// ---- The hub and the nav bar -------------------------------------------------------------------------------------

// HUB_ID, HUB_ROWS and PANES (every loopkeeper pane in wiring order) come from lib/panes.ts.

// the "ctrl+x tab to focus the panel" toast showed this session (stage.ts's atom, shared by all six concern files)
const stageFocusHinted = atom({ plugin: 'loopkeeper', key: 'stageFocusHinted' } as const, false)

// Switch panes: close `fromId` first ('' closes nothing), since a focus request is refused while the person holds a
// pane, then open `toId` with the focus. The composer keeps the focus while it holds a draft: then a toast says how to
// reach the pane, once a session and only in the terminal (the press's `surface`; with no press, a session whose every
// surface is the terminal). False when the pane could not be opened.
async function switchTo($: EngineInterface, fromId: string, toId: string, title: string, surface?: unknown): Promise<boolean> {
  if (fromId) {
    try {
      await $.ui.close({ id: fromId })
    } catch {
      // already closed
    }
  }
  try {
    await $.ui.open({ id: toId, title, focus: true, closeOnEscape: true, ...(toId === HUB_ID ? { rows: HUB_ROWS } : {}) })
  } catch {
    return false
  }
  try {
    const pane = (await $.ui.panes()).find(p => p.id === toId)
    if (pane && !pane.isFocused && !(await read($, stageFocusHinted))) {
      const terminal = typeof surface === 'string' ? surface === 'terminal' : (await $.session.surfaces()).every(s => s === 'terminal')
      if (terminal) {
        await update($, stageFocusHinted, () => true)
        toast($, 'ctrl+x tab to focus the panel')
      }
    }
  } catch {
    // no list: no hint
  }
  return true
}

// The nav bar's items: every loopkeeper pane, a press switching from `fromId` to it
function navItems($: EngineInterface, fromId: string) {
  return PANES.map(p => ({
    key: p.key,
    label: p.label,
    hotkey: p.hotkey,
    onPress: async (e?: { surface?: unknown }) => {
      if (!(await switchTo($, fromId, p.id, p.title, e?.surface))) toast($, 'Could not open the ' + p.label + ' pane.')
    },
  }))
}

/** The hub row's words: `GSD on · routed 3`, then the kill switch's note and `band off` when they apply. */
async function hubWords($: EngineInterface): Promise<string> {
  const modeOn = (await read($, routeMode)) === true
  const routed = (await read($, routeRouted)) ?? 0
  const words = [`GSD ${modeOn ? 'on' : 'off'}`, `routed ${routed}`]
  if ((await read($, routeDisabled)) === true) words.push(DISABLED_NOTE)
  if ((await read($, routeBand)) === false) words.push('band off')
  return words.join(' · ')
}

// ---- Wiring ------------------------------------------------------------------------------------------------------

export function wireRouting(on: On): void {
  // The stage and the gates read routeMode and routeLoop after this, on their way out of session start.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    try {
      await loadKill($)
    } catch {
      // Routing stays on.
    }
    try {
      await loadAll($)
    } catch {
      // Defaults stand.
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state without a session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      await loadKill($)
      await loadAll($)
    } catch {
      // Defaults stand.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Route each subagent's (and teammate's) model. Fails open: on any error the spawn goes through exactly as asked.
  on('agent.spawn', {}, async ($, e, next) => {
    let d: SpawnDecision
    try {
      const isOn = (await read($, routeMode)) === true && (await read($, routeDisabled)) !== true
      d = decide(e, sane(await read($, routeConfig)), isOn)
    } catch {
      return next(e)
    }
    try {
      await record($, d)
    } catch {
      // Recording is a nicety.
    }
    if (d.setModel === undefined) return next(e)
    return next({ ...e, model: d.setModel })
  }).catch(async ($, e, next) => {
    // Fail open: a routing failure never blocks a subagent. If the spawn already went through, report it
    // rather than start a second one.
    if (next.called) return { model: typeof e.model === 'string' && e.model !== '' ? e.model : String(e.parentModel ?? '') }
    return next(e)
  })

  // The rules join the first message's context the way agents-md joins AGENTS.md: as an instruction file behind
  // the claudeMd block. They name the stage's approval mode and the plan slack, so they follow both.
  on('prompt.context', {}, async ($, e, next) => {
    let text = ''
    try {
      if ((await read($, routeMode)) === true) {
        const limits = await read($, stageLimits)
        text = rulesText((await read($, routeLoop)) !== false, { slack: limits?.slack, approval: await read($, stageApproval) })
      }
    } catch {
      text = ''
    }
    if (text === '') return next(e)
    let withIt = e
    try {
      withIt = withRules(e, $.plugin.root, text)
    } catch {
      return next(e)
    }
    return next(withIt)
  })

  on('command.run', { command: 'lk' }, async ($, e, next) => lk($, e, next)).catch(($, e, next) => lkFailed($, e, next))
  on('command.run', { command: 'loopkeeper' }, async ($, e, next) => lk($, e, next)).catch(($, e, next) => lkFailed($, e, next))

  // The Routing pane (/lk routes), drawn with the kit: hero, tiles, routes, recent spawns, the loop, buttons.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const els = $.ui.resolve(e) as unknown as Elements
    const k = makeKit(els, e.surface)
    const isOn = (await read($, routeMode)) === true
    const isBand = (await read($, routeBand)) !== false
    const isLoop = (await read($, routeLoop)) !== false
    const disabled = (await read($, routeDisabled)) === true
    const config = sane(await read($, routeConfig))
    const all: LkRouteDecision[] = (await read($, routeDecisions)) ?? []
    const counts = (await read($, routeCounts)) ?? {}
    const routed = (await read($, routeRouted)) ?? 0
    const approval = await read($, stageApproval)
    const shown = all.slice(-SHOWN_SPAWNS).reverse()
    const quiet = (text: string) => k.text(text, { color: TONES.muted.fg, wrap: 'truncate' })

    const hero = k.hero({
      kicker: 'GSD',
      title: isOn ? 'Orchestrator on' : 'Orchestrator off',
      icon: isOn ? '●' : '○',
      tone: isOn ? 'ok' : 'muted',
      sub: approvalLine(approval) + ` · band ${isBand ? 'on' : 'off'}` + (disabled ? ' · ' + DISABLED_NOTE : ''),
    })

    const tiles = k.tiles([
      { label: 'Routes', value: String(ROLES.length), tone: 'info' },
      { label: 'Spawns', value: all.length >= KEEP_DECISIONS ? KEEP_DECISIONS + '+' : String(all.length) },
      { label: 'Approval', value: approval === 'ask' ? 'ask' : 'auto', tone: approval === 'ask' ? 'warn' : 'ok' },
    ])

    const routes = k.stack([
      k.section('Routes', `override explicit: ${config.override ? 'yes' : 'no'}`),
      ...ROLES.map(role =>
        k.row({
          key: 'route-' + role,
          left: [k.badge(role, ROLE_TONES[role]), '→ ' + resolveModel(config.roles[role].model, config)],
          right: config.roles[role].source,
        }),
      ),
    ])

    const spawns = k.stack([
      k.section('Recent spawns · ' + all.length, `routed ${routed} · ${countsLine(counts)}`),
      ...(shown.length === 0
        ? [quiet('none yet')]
        : shown.map((d, i) =>
            k.row({
              key: 'spawn-' + i,
              left: [
                quiet(clockOf(d.at)),
                k.badge(d.role === '' ? '-' : d.role, d.role === '' ? 'muted' : ROLE_TONES[d.role]),
                k.text(d.label + (d.isTeammate ? ' (teammate)' : ''), { color: d.source === 'off' ? TONES.muted.fg : undefined, wrap: 'truncate' }),
              ],
              right: [d.source, '→ ' + d.model],
            }),
          )),
    ])

    const loop = k.stack([
      k.section('Loop'),
      k.row({
        key: 'loop-row',
        left: [k.badge(isLoop ? 'Loop on' : 'Loop off', isLoop ? 'ok' : 'muted'), 'size → plan → validate plan → execute → verify → QA → ship gate'],
      }),
      ...(isLoop
        ? [quiet('mode on:  ' + loopEffects(true).join(' · ')), quiet('mode off: ' + loopEffects(false).join(' · '))]
        : [quiet(loopLine(false))]),
      quiet('Toggle mode and Toggle loop put /lk on|off or /lk loop on|off in the prompt box when the stage and the gates must follow'),
    ])

    const buttons = k.buttons([
      {
        key: 'toggle',
        label: 'Toggle mode',
        hotkey: 't',
        plain: true,
        onPress: async () => {
          const want = (await read($, routeMode)) !== true
          // with the loop off only routing changes, so the switch happens here
          if ((await read($, routeLoop)) === false) await setMode($, want)
          else await offer($, want ? 'on' : 'off')
        },
      },
      {
        key: 'loop',
        label: 'Toggle loop',
        hotkey: 'l',
        plain: true,
        onPress: async () => {
          const want = (await read($, routeLoop)) === false
          // with the mode off only routing changes, so the switch happens here
          if ((await read($, routeMode)) !== true) await setLoop($, want)
          else await offer($, 'loop ' + (want ? 'on' : 'off'))
        },
      },
      {
        key: 'close',
        label: 'Close',
        hotkey: 'c',
        plain: true,
        onPress: async () => {
          try {
            await $.ui.close({ id: PANE_ID })
          } catch {
            // Already closed.
          }
        },
      },
    ])

    return k.page([k.nav(navItems($, PANE_ID), 'routes'), hero, tiles, routes, spawns, loop, buttons]) as never
  })

  // The hub's Routes row, above the later concerns' rows (next): `4: Routes` and the routing words, quiet. It shows
  // with the band off or the kill switch on; a failure draws what the chain drew.
  on('ui.render', { component: 'Pane', requestId: HUB_ID }, async ($, e, next) => {
    let asked = false
    let theirs: unknown = null
    try {
      const els = $.ui.resolve(e) as unknown as Elements
      const k = makeKit(els, e.surface)
      const row = k.row({
        key: 'hub-routes',
        left: [
          els.Button({
            key: 'panel-routes',
            label: 'Routes',
            hotkey: '4',
            plain: true,
            onPress: async (press?: { surface?: unknown }) => {
              if (!(await switchTo($, HUB_ID, PANE_ID, 'Routing', press?.surface))) toast($, 'Could not open the Routes pane.')
            },
          }),
          k.text(await hubWords($), { color: TONES.muted.fg, wrap: 'truncate' }),
        ],
      })
      asked = true
      theirs = await next(e)
      return (theirs === null || theirs === undefined ? row : k.stack([row, theirs])) as never
    } catch {
      return (asked ? theirs : await next(e)) as never
    }
  })

  // The band: one kit line above the prompt, `routing  ● on  ● loop   recon→haiku · … · routed n`, over the bands of
  // the concerns after this one.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props = (e.props ?? {}) as { hasSurvey?: boolean }
    if (props.hasSurvey === true || (await read($, routeBand)) === false) return next(e)
    const els = $.ui.resolve(e) as unknown as Elements
    const k = makeKit(els, e.surface)
    const band = routingBand(
      sane(await read($, routeConfig)),
      (await read($, routeRouted)) ?? 0,
      (await read($, routeMode)) === true,
      (await read($, routeLoop)) !== false,
      (await read($, routeDisabled)) === true,
    )
    const line = k.line('routing', band.chips, band.right)
    const theirs = await next(e)
    if (theirs === null || theirs === undefined) return line as never
    return els.Box({ flexDirection: 'column', children: [line, theirs] }) as never
  })
}
