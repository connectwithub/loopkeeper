import { expect, test } from 'claude-code/testing'

import { CWD, FAKE, globalConfig, projectConfig, world } from './world'

const write = (content: string, file_path = 'src/x.ts') => ({ tool: 'Write', file_path, content })

// ---- One test per blocking pattern -------------------------------------------

const BLOCKS: Array<[string, string]> = [
  ['AWS access key', FAKE.aws],
  ['Anthropic API key', FAKE.anthropic],
  ['OpenAI API key', FAKE.openai],
  ['OpenAI API key', FAKE.openaiProj],
  ['GitHub token', FAKE.github],
  ['GitHub token', FAKE.githubPat],
  ['Slack token', FAKE.slack],
  ['Google API key', FAKE.google],
  ['Stripe live key', FAKE.stripe],
  ['Stripe live key', FAKE.stripeRestricted],
  ['private key block', FAKE.privateKey],
]

for (const [kind, secret] of BLOCKS) {
  test(`blocks a ${kind} in a Write (${secret.slice(0, 6)}…)`, async ($, on) => {
    const w = world(on)
    const out: any = await $.tool.call(write(`const value = '${secret}'\n`))
    expect(out.deny).toBeDefined()
    expect(out.deny).toContain(`secret-guard: ${kind} detected in src/x.ts (`)
    expect(out.deny).toContain('add the path to allowPaths in .claude/secret-guard.json or run /secret-guard off')
    expect(out.deny.includes(secret)).toBe(false)
    expect(w.ran).toEqual([])
    expect(w.asked).toEqual([])
  })
}

// ---- One test per warning pattern ----------------------------------------------

const WARNS: Array<[string, string]> = [
  ['Twilio API key', `const sid = "${FAKE.twilio}"`],
  ['JWT', `const bearer = "${FAKE.jwt}"`],
  ['hard-coded secret', 'password = "hunter2hunter2"'],
  ['hard-coded secret', 'API_KEY: q8Zt4LmP0wRb'],
]

for (const [kind, content] of WARNS) {
  test(`asks about a ${kind}, and Block refuses it`, async ($, on) => {
    const w = world(on, { answer: 'Block' })
    const out: any = await $.tool.call(write(content))
    expect(w.asked.length).toBe(1)
    expect(w.asked[0]).toContain(`secret-guard: possible ${kind} in src/x.ts (`)
    expect(w.asked[0]).toContain('Allow?')
    expect(out.deny).toContain(`${kind} detected in src/x.ts`)
    expect(w.ran).toEqual([])
  })

  test(`asks about a ${kind}, and Allow once lets it through`, async ($, on) => {
    const w = world(on, { answer: 'Allow once' })
    const out: any = await $.tool.call(write(content))
    expect(w.asked.length).toBe(1)
    expect(out).toEqual({ result: 'ran' })
    expect(w.ran.length).toBe(1)
  })
}

test('a warn with nobody to ask (-p, SDK) is allowed with a toast', async ($, on) => {
  const w = world(on, { answer: 'reject', surfaces: [] })
  const out: any = await $.tool.call(write(`const bearer = "${FAKE.jwt}"`))
  expect(out).toEqual({ result: 'ran' })
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('no one to ask')
  expect(w.toasts[0].includes(FAKE.jwt)).toBe(false)
})

test('a warn the person dismisses is refused', async ($, on) => {
  const w = world(on, { answer: 'reject', surfaces: ['terminal'] })
  const out: any = await $.tool.call(write(`const bearer = "${FAKE.jwt}"`))
  expect(out.deny).toContain('dismissed')
  expect(w.ran).toEqual([])
})

// ---- Each tool's new text, and only the new text -------------------------------

test('Bash heredoc carrying a key is blocked as a Bash command', async ($, on) => {
  const w = world(on)
  const command = `cat > config.ts <<'EOF'\nexport const key = "${FAKE.github}"\nEOF`
  const out: any = await $.tool.call({ tool: 'Bash', command })
  expect(out.deny).toContain('GitHub token detected in Bash command')
  expect(w.ran).toEqual([])
})

test('Bash echo redirect of a key is blocked', async ($, on) => {
  world(on)
  const out: any = await $.tool.call({ tool: 'Bash', command: `echo ${FAKE.aws} >> notes.txt` })
  expect(out.deny).toContain('AWS access key detected in Bash command')
})

test('an ordinary Bash command runs', async ($, on) => {
  const w = world(on)
  const out = await $.tool.call({ tool: 'Bash', command: 'ls -la && git status' })
  expect(out).toEqual({ result: 'ran' })
  expect(w.ran.length).toBe(1)
})

test('Edit: a secret in old_string does not trigger, only new_string does', async ($, on) => {
  const w = world(on)
  const removing = await $.tool.call({
    tool: 'Edit',
    file_path: 'src/x.ts',
    old_string: `const key = '${FAKE.stripe}'`,
    new_string: 'const key = process.env.STRIPE_KEY',
  })
  expect(removing).toEqual({ result: 'ran' })
  const adding: any = await $.tool.call({
    tool: 'Edit',
    file_path: 'src/x.ts',
    old_string: 'const key = process.env.STRIPE_KEY',
    new_string: `const key = '${FAKE.stripe}'`,
  })
  expect(adding.deny).toContain('Stripe live key detected in src/x.ts')
  expect(w.ran.length).toBe(1)
})

test('MultiEdit: every edit new_string is checked, old_string never', async ($, on) => {
  world(on)
  const clean = await $.tool.call({
    tool: 'MultiEdit',
    file_path: 'src/x.ts',
    edits: [{ old_string: FAKE.slack, new_string: 'redacted()' }],
  })
  expect(clean).toEqual({ result: 'ran' })
  const dirty: any = await $.tool.call({
    tool: 'MultiEdit',
    file_path: 'src/x.ts',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: `token("${FAKE.slack}")` },
    ],
  })
  expect(dirty.deny).toContain('Slack token detected in src/x.ts')
})

test('NotebookEdit new_source is checked', async ($, on) => {
  world(on)
  const out: any = await $.tool.call({
    tool: 'NotebookEdit',
    notebook_path: 'analysis.ipynb',
    new_source: `client = Client("${FAKE.anthropic}")`,
  })
  expect(out.deny).toContain('Anthropic API key detected in analysis.ipynb')
})

test('other tools are not touched', async ($, on) => {
  const w = world(on)
  const out = await $.tool.call({ tool: 'Read', file_path: FAKE.aws })
  expect(out).toEqual({ result: 'ran' })
  expect(w.ran.length).toBe(1)
})

// ---- Placeholders -------------------------------------------------------------

const PLACEHOLDERS = [
  'password = "changeme123"',
  'api_key: "${API_KEY}"',
  "token = 'your_token_here'",
  'secret: "xxxxxxxxxxxx"',
  'password=<your-password>',
  'API_KEY=EXAMPLE_KEY_VALUE',
  'secret = "REDACTED-REDACTED"',
  'token: "placeholder-token"',
  'password = "aaaaaaaaaaaa"',
  'apiKey = process.env.API_KEY',
]

for (const content of PLACEHOLDERS) {
  test(`placeholder does not trigger the generic rule: ${content}`, async ($, on) => {
    const w = world(on)
    const out = await $.tool.call(write(content))
    expect(out).toEqual({ result: 'ran' })
    expect(w.asked).toEqual([])
  })
}

// ---- Config: allowPaths, publicPaths, disabledKinds ------------------------------

test('allowPaths exempts .env files from every check', async ($, on) => {
  const w = world(on, { files: projectConfig({ allowPaths: ['.env', '.env.*'], deny: ['Zorblax'] }) })
  const env = await $.tool.call(write(`AWS_KEY=${FAKE.aws}\nZorblax`, '.env'))
  const local = await $.tool.call(write(`AWS_KEY=${FAKE.aws}`, `${CWD}/.env.local`))
  const elsewhere: any = await $.tool.call(write(`AWS_KEY=${FAKE.aws}`, 'src/config.ts'))
  expect(env).toEqual({ result: 'ran' })
  expect(local).toEqual({ result: 'ran' })
  expect(elsewhere.deny).toContain('AWS access key')
  expect(w.ran.length).toBe(2)
})

test('allowPaths globs: **/*.secret, node_modules/** and ~/.claude/**', async ($, on) => {
  world(on, { files: globalConfig({ allowPaths: ['**/*.secret', 'node_modules/**', '~/.claude/**'] }) })
  const a = await $.tool.call(write(FAKE.aws, 'deep/dir/keys.secret'))
  const b = await $.tool.call(write(FAKE.aws, 'node_modules/pkg/index.js'))
  const c = await $.tool.call(write(FAKE.aws, '/home/tester/.claude/settings.json'))
  const d: any = await $.tool.call(write(FAKE.aws, 'src/keys.ts'))
  expect([a, b, c]).toEqual([{ result: 'ran' }, { result: 'ran' }, { result: 'ran' }])
  expect(d.deny).toBeDefined()
})

test('with publicPaths, deny words apply only to public files', async ($, on) => {
  world(on, { files: projectConfig({ deny: ['Project Zorblax'], publicPaths: ['public/', 'README', 'docs/'] }) })
  const readme: any = await $.tool.call(write('We built project   zorblax last year.', 'README.md'))
  const site: any = await $.tool.call(write('<p>Project Zorblax</p>', 'site/public/index.html'))
  const src = await $.tool.call(write('// Project Zorblax internals', 'src/x.ts'))
  expect(readme.deny).toContain('deny-listed word detected in README.md')
  expect(site.deny).toContain('deny-listed word detected in site/public/index.html')
  expect(src).toEqual({ result: 'ran' })
})

test('with publicPaths, Bash commands are word-checked only when they mention a public path', async ($, on) => {
  world(on, { files: projectConfig({ deny: ['Zorblax'], publicPaths: ['public/'] }) })
  const pub: any = await $.tool.call({ tool: 'Bash', command: 'echo "Zorblax" >> public/about.html' })
  const priv = await $.tool.call({ tool: 'Bash', command: 'echo "Zorblax" >> notes/internal.md' })
  expect(pub.deny).toContain('deny-listed word detected in Bash command')
  expect(priv).toEqual({ result: 'ran' })
})

test('without publicPaths, deny words apply everywhere, as whole words only', async ($, on) => {
  world(on, { files: projectConfig({ deny: ['Zorblax'] }) })
  const hit: any = await $.tool.call(write('call zorblax now', 'src/a.ts'))
  const partial = await $.tool.call(write('call Zorblaxian now', 'src/b.ts'))
  expect(hit.deny).toContain('deny-listed word')
  expect(partial).toEqual({ result: 'ran' })
})

test('warn words ask before writing', async ($, on) => {
  const w = world(on, { files: projectConfig({ warn: ['Quuxcorp'] }), answer: 'Allow once' })
  const out = await $.tool.call(write('Thanks to Quuxcorp', 'README.md'))
  expect(out).toEqual({ result: 'ran' })
  expect(w.asked[0]).toContain('possible warn-listed word in README.md')
})

test('global and project deny words are unioned', async ($, on) => {
  world(on, {
    files: { ...globalConfig({ deny: ['Zorblax'] }), ...projectConfig({ deny: ['Quuxcorp'] }) },
  })
  const a: any = await $.tool.call(write('Zorblax', 'a.md'))
  const b: any = await $.tool.call(write('Quuxcorp', 'b.md'))
  expect(a.deny).toBeDefined()
  expect(b.deny).toBeDefined()
})

test('disabledKinds turns off a credential kind', async ($, on) => {
  const w = world(on, { files: projectConfig({ disabledKinds: ['jwt'] }) })
  const out = await $.tool.call(write(`const bearer = "${FAKE.jwt}"`))
  expect(out).toEqual({ result: 'ran' })
  expect(w.asked).toEqual([])
})

test('a malformed config file is ignored with a toast that does not quote it', async ($, on) => {
  const w = world(on, { files: { [CWD + '/.claude/secret-guard.json']: '{ "deny": [Zorblax' } })
  const out: any = await $.tool.call(write(FAKE.aws))
  expect(out.deny).toContain('AWS access key')
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('not a JSON object')
  expect(w.toasts[0].includes('Zorblax')).toBe(false)
})

// ---- Subagents, off switch, fail closed -------------------------------------------

test("a subagent's write is guarded too", async ($, on) => {
  world(on)
  const out: any = await $.tool.call({ ...write(FAKE.aws), agentId: 'agent-7' })
  expect(out.deny).toContain('AWS access key')
})

test('/secret-guard off passes everything through, /secret-guard on restores it', async ($, on) => {
  const w = world(on)
  const offText: any = await $.command.run({ command: 'secret-guard', args: 'off' })
  expect(offText.text).toContain('off for this session')
  const passed = await $.tool.call(write(FAKE.aws))
  expect(passed).toEqual({ result: 'ran' })
  await $.command.run({ command: 'secret-guard', args: 'on' })
  const blocked: any = await $.tool.call(write(FAKE.aws))
  expect(blocked.deny).toBeDefined()
  expect(w.ran.length).toBe(1)
})

test('fails closed: a crash inside the guard refuses the call', async ($, on) => {
  const w = world(on, { breakCwd: true })
  const out: any = await $.tool.call(write('nothing secret here'))
  expect(out.deny).toContain('secret-guard failed')
  expect(w.ran).toEqual([])
})
