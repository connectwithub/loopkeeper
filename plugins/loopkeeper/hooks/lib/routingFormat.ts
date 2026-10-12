// Text for the routing band, /lk text, /lk status and the Routing pane. Ported from gsd-orchestrator's
// format.ts. Pure: this file never sees $.

import type { LkRouteDecision, LkRoutingConfig } from '../../types/index.d.ts'
import { DISABLE_ENV, PLUGIN } from './names.ts'
import { ROLES, SHORT, resolveModel, shortModel } from './routingConfig.ts'

/**
 * What GSD mode switching does to the other concerns while the loop is on (ADR 0004: no commands are sent;
 * the stage and the gates act on /lk on|off themselves). The plan approval mode is not part of it (ADR 0005).
 */
export function loopEffects(isOn: boolean): string[] {
  return isOn ? ['stage preset gsd', 'gates plan required on'] : ['stage preset default', 'gates plan required off']
}

/** The loop's state and what it switches, one line. */
export function loopLine(isLoop: boolean): string {
  if (!isLoop) return 'loop off · /lk on|off leaves the stage preset and the plan gate as they are'
  return `loop on · on: ${loopEffects(true).join(' + ')} · off: ${loopEffects(false).join(' + ')}`
}

/** The stage's plan approval mode, one line (ADR 0005: one mode, set with /lk approval). */
export function approvalLine(approval: string | undefined): string {
  return `Plan approval: ${approval === 'ask' ? 'ask' : 'auto'} (/lk approval auto|ask)`
}

/** Why spawns are not routed while CLAUDE_MODS_DISABLE names the plugin (ADR 0009). */
export const DISABLED_NOTE = `spawn routing off (${DISABLE_ENV})`

/** A band chip: its words and the kit tone it is drawn in (lib/kit.ts TONES; never a color name). */
export type RoutingChip = { text: string; tone: 'ok' | 'muted' | 'info' }
/** The routing band as kit.line('routing', chips, right) draws it. */
export type RoutingBand = { chips: RoutingChip[]; right?: string }

/**
 * `routing  ● on  ● loop   recon→haiku · exec→sonnet · verify→sonnet · hard→opus · routed 3`; `routing  ● off` while
 * the mode is off; `routing  ● routing off (CLAUDE_MODS_DISABLE)` while the kill switch names the plugin.
 */
export function routingBand(config: LkRoutingConfig, routed: number, isOn: boolean, isLoop = false, disabled = false): RoutingBand {
  if (disabled) return { chips: [{ text: `routing off (${DISABLE_ENV})`, tone: 'muted' }] }
  if (!isOn) return { chips: [{ text: 'off', tone: 'muted' }] }
  const routes = (['recon', 'execute', 'verify', 'hard'] as const)
    .map(role => `${SHORT[role]}→${shortModel(config.roles[role].model, config)}`)
    .join(' · ')
  const chips: RoutingChip[] = [{ text: 'on', tone: 'ok' }]
  if (isLoop) chips.push({ text: 'loop', tone: 'info' })
  return { chips, right: `${routes} · routed ${routed}` }
}

/** HH:MM:SS of a millisecond time (local clock as the Date sees it). */
export function clockOf(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '--:--:--'
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** One routing-table row. */
export function tableRow(config: LkRoutingConfig, role: (typeof ROLES)[number]): string {
  const route = config.roles[role]
  return `${role.padEnd(8)} → ${resolveModel(route.model, config).padEnd(20)} ${route.source}`
}

/** Every routing-table row, indented. */
export function tableRows(config: LkRoutingConfig): string {
  return ROLES.map(r => '  ' + tableRow(config, r)).join('\n')
}

/** One decision row. */
export function decisionRow(d: LkRouteDecision): string {
  const role = d.role === '' ? '-' : d.role
  const kw = d.matched.length > 0 ? ` [${d.matched.slice(0, 3).join(', ')}]` : ''
  const mate = d.isTeammate ? ' (teammate)' : ''
  return `${clockOf(d.at)} ${d.source.padEnd(8)} ${role.padEnd(7)} → ${d.model}  ${d.label}${mate}${kw}`
}

/** Counts per model as `model n` pairs, most first. */
export function countsLine(counts: Record<string, number>): string {
  const pairs = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return pairs.length === 0 ? 'none yet' : pairs.map(([m, n]) => `${m} ${n}`).join(' · ')
}

/** Routing's line in /lk status. */
export function statusLine(isOn: boolean, isLoop: boolean, config: LkRoutingConfig, routed: number, disabled = false): string {
  const routes = (['recon', 'execute', 'verify', 'hard'] as const)
    .map(role => `${SHORT[role]}→${shortModel(config.roles[role].model, config)}`)
    .join(' · ')
  return `routing ● ${isOn ? 'on' : 'off'} · loop ${isLoop ? 'on' : 'off'} · ${disabled ? DISABLED_NOTE : routes} · routed ${routed}`
}

export type RoutingText = {
  isOn: boolean
  isBand: boolean
  isLoop: boolean
  disabled: boolean
  config: LkRoutingConfig
  decisions: readonly LkRouteDecision[]
  counts: Record<string, number>
  routed: number
}

/** Routing's part of /lk text. */
export function statusText(s: RoutingText): string {
  const lines = [
    `GSD orchestrator: ${s.isOn ? 'on' : 'off'} · loop ${s.isLoop ? 'on' : 'off'} · band ${s.isBand ? 'on' : 'off'} · override explicit models: ${s.config.override ? 'yes' : 'no'}`,
    'GSD ' + loopLine(s.isLoop),
    ...(s.disabled ? [`Spawns are not routed: ${DISABLE_ENV} names ${PLUGIN}; the rules block still joins the context.`] : []),
    'Routing table:',
    tableRows(s.config),
    `Routed this session: ${s.routed} · per model: ${countsLine(s.counts)}`,
  ]
  const recent = s.decisions.slice(-5)
  if (recent.length > 0) {
    lines.push('Last decisions:', ...recent.map(d => '  ' + decisionRow(d)))
  }
  return lines.join('\n')
}

/** The usage line of each routing word, for a word given the wrong arguments. */
export const USAGE = {
  loop: 'Usage: /lk loop on|off',
  route: 'Usage: /lk route <recon|execute|verify|hard|default> <haiku|sonnet|opus|model-id> | /lk route reset',
  explain: 'Usage: /lk explain <description or prompt text>',
} as const
