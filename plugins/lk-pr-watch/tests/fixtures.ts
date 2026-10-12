// Fixture JSON for the tests: `gh pr view --json` output and `gh api graphql` responses in the
// shape cc-pr-tracker's query returns (plus completedAt). Builders keep each test's intent short.

export const PR_VIEW = {
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  title: 'Add the widget cache',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED',
  headRefName: 'feature/cache',
  baseRefName: 'main',
}

type Run = { name: string; status: string; conclusion: string | null; startedAt: string | null; completedAt?: string | null; workflow?: string }

export function checkRun(r: Run) {
  return {
    __typename: 'CheckRun',
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    detailsUrl: `https://github.com/acme/widgets/actions/runs/1/job/${r.name}`,
    startedAt: r.startedAt,
    completedAt: r.completedAt ?? null,
    checkSuite: { app: { slug: 'github-actions' }, workflowRun: { event: 'pull_request', workflow: { name: r.workflow ?? 'CI' } } },
  }
}

export function statusContext(context: string, state: string, createdAt = '2026-10-09T10:00:00Z') {
  return { __typename: 'StatusContext', context, state, targetUrl: 'https://ci.example.com/build/7', createdAt }
}

export type Pr = {
  number?: number
  state?: string
  isDraft?: boolean
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string | null
  contexts?: unknown[]
}

export function graphql(p: Pr = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          number: p.number ?? 42,
          title: 'Add the widget cache',
          state: p.state ?? 'OPEN',
          isDraft: p.isDraft ?? false,
          mergeable: p.mergeable ?? 'MERGEABLE',
          mergeStateStatus: p.mergeStateStatus ?? 'BLOCKED',
          reviewDecision: p.reviewDecision === undefined ? 'REVIEW_REQUIRED' : p.reviewDecision,
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: p.contexts ?? [] } } } }] },
        },
      },
    },
  }
}

export const T0 = '2026-10-09T10:00:00Z'
export const T1 = '2026-10-09T10:01:23Z'

export const pass = (name: string) => checkRun({ name, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: T0, completedAt: T1 })
export const fail = (name: string) => checkRun({ name, status: 'COMPLETED', conclusion: 'FAILURE', startedAt: T0, completedAt: T1 })
export const pending = (name: string) => checkRun({ name, status: 'IN_PROGRESS', conclusion: null, startedAt: T0 })

/** Five checks: three passed, one failed, one running. */
export const MIXED = graphql({ contexts: [pass('build'), pass('lint'), pass('types'), fail('test'), pending('e2e')], reviewDecision: 'CHANGES_REQUESTED' })

// ---------- reading a drawn band ----------

type Drawn = { type: string; props: Record<string, unknown>; children: unknown[] }

function* walk(n: unknown): Generator<Drawn> {
  if (n === null || typeof n !== 'object') return
  const d = n as Drawn
  yield d
  for (const c of Array.isArray(d.children) ? d.children : []) yield* walk(c)
}

/** What a drawn band shows: `label  ● chip  ● chip`, each chip's color, and the right side with its color. */
export type BandSeen = { text: string; tones: unknown[]; right?: string; rightColor?: unknown }

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
  }
  if (right) {
    seen.right = String(right.children[0])
    seen.rightColor = right.props.color
  }
  return seen
}
