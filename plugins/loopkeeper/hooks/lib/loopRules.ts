// The operating rules the model reads while GSD mode is on, and how they join the context the engine sends
// with a conversation's first message. Ported from gsd-orchestrator's rules.ts. Pure: this file never sees $.

import type { InstructionFile, PromptContextBlock } from 'claude-code'

import { PLUGIN } from './names.ts'

/** The block name used when the engine hands no instruction-file list. */
export const RULES_BLOCK = 'gsdOrchestrator'

/** The rules while the loop is off, under 25 lines. */
export const RULES = [
  'GSD orchestrator mode is on. You are the orchestrator and auditor, not the worker.',
  '(This applies to the main conversation. A subagent started with the Agent tool',
  'ignores this block and does its own task directly.)',
  '1) Plan first: state Goal, Steps, and Done-when in a few lines before acting.',
  '2) Delegate: send reconnaissance (reading, searching, surveying) and execution',
  '   (multi-file edits, test runs, generation) to subagents with the Agent tool;',
  '   keep the main thread for planning, decisions, and auditing. Run independent',
  '   subagents in parallel in one message.',
  '3) Do not set a model on Agent calls; models are routed by role',
  '   (recon → haiku, execute/verify → sonnet, hard → opus).',
  '   Add [model:opus] or [role:hard] to a description to override.',
  '4) Audit every subagent result before presenting it: spot-check paths, numbers,',
  '   and that no secrets or client names leaked.',
  '5) Report at the end of each unit of work as Goal / Status / Decisions / Next,',
  '   and record settled decisions with the record_decision tool if it is available.',
].join('\n')

/** What the loop rules take from the rest of loopkeeper: the plan slack and the plan approval mode. */
export type LoopRulesOptions = {
  /** changeControl.planSlack: approving a plan approves its planned files plus this many. */
  slack?: number
  /** The stage's plan approval mode (/lk approval). */
  approval?: 'auto' | 'ask'
}

export const DEFAULT_SLACK = 10

/** The sized loop rules, under 30 lines: they replace RULES while the loop is on. */
export function loopRules(opts: LoopRulesOptions = {}): string {
  const slack = typeof opts.slack === 'number' && Number.isInteger(opts.slack) && opts.slack >= 0 ? opts.slack : DEFAULT_SLACK
  const approval = opts.approval === 'ask' ? 'ask' : 'auto'
  return [
    'GSD orchestrator mode is on. You are the orchestrator and auditor, not the worker.',
    '(Main conversation only; a subagent started with the Agent tool ignores this block.)',
    `Every task runs this loop; ${PLUGIN} records and enforces it through set_stage (plan approval: ${approval}).`,
    "0 Size it first: call set_stage {stage:'plan', size:'small'|'large', files: <how many files the plan touches>, note:'<one-line plan>'}.",
    `  Approving the plan approves a file budget of that many files plus ${slack}; the plan validator checks the count.`,
    '  small = one clear change in at most 3 files with no design choice or new behaviour (a typo, a rename,',
    '  a config value, a question, a one-off command). Everything else is large. When unsure, large.',
    '1 Small: the one-line plan is enough; go straight to Execute (the plan gate and the verifier are waived;',
    '  the pipeline pushes a small task back to Plan if it grows past 3 files). Then QA and Ship as below.',
    '2 Large, Plan: state Goal, Steps, Done-when and the files to touch. No code edits yet. Plan material is allowed:',
    '  a plan page under the scratchpad, .claude/plans/ or docs/plans/, published with the Artifact tool for the user to read',
    '  and answer its questions in; that is not shipping.',
    '3 Validate plan: spawn a plan validator subagent (fresh context; call it a validator or reviewer) to check',
    '  the plan against the ask and the code for gaps, conflicts and wrong files. Record its result with',
    "  set_stage {stage:'validate-plan', verdict:'consistent'|'issues', note}; a review_cycle pass of kind plan",
    '  with no open p0 or p1 also records it. Consistent opens the gate by',
    '  itself unless the user wants to approve plans (approval mode ask, or the prompt asked to wait): then ask',
    '  them to run /lk approve. Issues: fix the plan and validate again.',
    '4 Execute: delegate the work to subagents (reconnaissance and multi-file edits); run independent ones in',
    '  parallel in one message. Models are routed by role (recon → haiku, execute/verify → sonnet, hard → opus);',
    '  do not set a model unless overriding with [model:opus] or [role:hard].',
    '5 Validate execution: spawn a verifier subagent with fresh context to check the work against Done-when;',
    '  fix and re-verify. Record each pass with review_cycle (kind plan|review|qa|critic) when that tool exists.',
    '6 QA: run the tests and the build; fix failures.',
    '7 Ship: ask the user before any commit, push, PR, release or package publish (an Artifact page is not shipping);',
    '  shipping commands are held until /lk approve at Ship or the stage before it.',
    'Audit every subagent result before presenting it (paths, numbers, no secrets or client names).',
    'Report each unit of work as Goal / Status / Decisions / Next; record settled decisions with record_decision when it exists.',
  ].join('\n')
}

/** The loop rules with the defaults (slack 10, approval auto). */
export const LOOP_RULES = loopRules()

/** The rules text for the loop switch. */
export function rulesText(isLoop: boolean, opts: LoopRulesOptions = {}): string {
  return isLoop ? loopRules(opts) : RULES
}

/** Where the rules say they come from: this module, inside the plugin. */
export function rulesPath(root: unknown): string {
  const dir = typeof root === 'string' && root.startsWith('/') ? root.replace(/\/+$/, '') : '/' + PLUGIN
  return dir + '/hooks/lib/loopRules.ts'
}

/** The rules as one of the person's own instruction files. */
export function rulesFile(root: unknown, text: string): InstructionFile {
  return { path: rulesPath(root), kind: 'user', content: text + '\n' }
}

type ContextLike = {
  blocks?: readonly PromptContextBlock[]
  instructionFiles?: readonly InstructionFile[]
}

/**
 * The prompt.context input with the rules added, the way agents-md adds
 * AGENTS.md: as an instruction file the engine renders inside `claudeMd`.
 * When a hook above rewrote `claudeMd` (instructionFiles undefined) or the
 * engine has no `claudeMd` block, the rules go in a block of their own.
 * Never added twice.
 */
export function withRules<T extends ContextLike>(e: T, root: unknown, text: string): T {
  const blocks = Array.isArray(e.blocks) ? e.blocks : []
  const files = e.instructionFiles
  const path = rulesPath(root)
  const hasClaudeMd = blocks.some(b => b?.name === 'claudeMd')
  if (Array.isArray(files) && hasClaudeMd) {
    if (files.some(f => f?.path === path)) return e
    return { ...e, instructionFiles: [...files, rulesFile(root, text)] }
  }
  if (blocks.some(b => b?.name === RULES_BLOCK)) return e
  return { ...e, blocks: [...blocks, { name: RULES_BLOCK, text }] }
}
