// Shell reading for change-control, borrowed VERBATIM from hamzafer/claude-code-mods,
// mods/merge-gate/hooks/register.tsx (MIT, Copyright (c) 2026 Hamza Zafar):
// START, WORD, WRAPPERS, PREFIX, OPTS, at(), RUNNER, SHELL_HEREDOC, bare(), prNumber(),
// LEAD_CD, LEAD_RUNNER, cdTargets() and resolveDir(). Our only edits: `export` keywords, the
// GH_MERGE constant moved up, and four `?? ''` guards for noUncheckedIndexedAccess.

// A command counts only where the shell starts one: at the start, after ; & | ( { or a backtick,
// or on a new line. Before it may come VAR=x, wrappers (sudo, env, npx, timeout 900, nohup, xargs...),
// shell keywords (if, then, !...), options and numbers; between the tool and its subcommand,
// global options (codex -c k=v exec, gh -R o/r pr merge).
// Words are bounded by [^\s;&|()] and the prefix is capped, so a long command cannot make the match slow.
const START = String.raw`(?:^|[\n;&|({\x60])[ \t]*`
const WORD = String.raw`[^\s;&|()\x60]`
const WRAPPERS = 'sudo|env|npx|bunx|pnpx|time|timeout|nohup|nice|caffeinate|stdbuf|xargs|command|builtin|exec|if|elif|while|until|then|do|else|!'
const PREFIX = String.raw`(?:(?:\w+=${WORD}*|(?:${WRAPPERS})(?![\w-])|-${WORD}+(?:[ \t]+[^\s;&|()\x60-]${WORD}*)?|\d[\w.]*)[ \t]+){0,8}`
const OPTS = String.raw`(?:\s+-\S+(?:\s+[^\s;&|)\x60-]\S*)?)*`
export const at = (tool: string, ...sub: string[]) =>
  new RegExp(START + PREFIX + String.raw`\\?(?:${WORD}*/)?` + tool + sub.map(s => OPTS + String.raw`\s+` + s).join('') + String.raw`(?![\w-])`)
// A shell that runs the next string (bash -c, sh -lc, eval) or a heredoc (bash <<EOF).
const RUNNER = /(?:^|[\s;&|({`])(?:(?:(?:ba|z|da|k)?sh)\s+(?:-\S+\s+)*-\w*c|eval)\s+$/
const SHELL_HEREDOC = /(?:^|[\s;&|({`])(?:ba|z|da|k)?sh(?:\s+-\S+)*\s*$/
export const GH_MERGE = at('gh', 'pr', 'merge')

// The command as the shell reads it: heredoc bodies, quoted text and # comments blanked, so text
// that merely mentions a command (a grep pattern, a commit message, a note) is not taken for one.
// What the shell does run is kept: $( ) and backticks inside double quotes, the string given to
// bash -c or eval, a heredoc fed to a shell, and a quoted number ("42").
export function bare(command: string): string {
  // The rest of the opener line (cat <<EOF | codex ...) is kept; only the body goes.
  const text = command.replace(/<<-?[ \t]*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g, (_m, _q, _tag, tail: string, body: string, at: number) =>
    SHELL_HEREDOC.test(command.slice(command.lastIndexOf('\n', at - 1) + 1, at)) ? `${tail}\n${body}\n` : `${tail}\n`,
  )
  let i = 0

  // A quoted string the shell runs as a command, or a quoted number: what to keep of it, if anything.
  const keep = (out: string, inner: string) => (RUNNER.test(out) ? `(${bare(inner)})` : /^\d+$/.test(inner) ? inner : null)

  // Plain shell, up to `stop` (the ) or backtick that closes a substitution) or the end.
  const plain = (stop?: string): string => {
    let out = ''
    let depth = 0
    while (i < text.length) {
      const c = text[i]
      if (c === stop && (stop !== ')' || depth === 0)) {
        i++
        return out
      }
      if (c === '$' && text[i + 1] === "'") {
        let end = i + 2 // $'...' takes backslash escapes, \' among them
        while (end < text.length && text[end] !== "'") end += text[end] === '\\' ? 2 : 1
        out += "''"
        i = end + 1
      } else if (c === "'") {
        const end = text.indexOf("'", i + 1) < 0 ? text.length : text.indexOf("'", i + 1)
        out += keep(out, text.slice(i + 1, end)) ?? "''"
        i = end + 1
      } else if (c === '"') {
        let end = i + 1
        while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
        const kept = keep(out, text.slice(i + 1, end).replace(/\\(.)/g, '$1'))
        i++
        if (kept === null) out += `"${quoted()}"`
        else {
          out += kept
          i = end + 1
        }
      } else if (c === '\\') {
        out += text.slice(i, i + 2)
        i += 2
      } else if (c === '#' && (i === 0 || /[\s;&|()`]/.test(text[i - 1] ?? ''))) {
        const end = text.indexOf('\n', i)
        i = end < 0 ? text.length : end
      } else {
        if (c === '(') depth++
        if (c === ')') depth--
        out += c
        i++
      }
    }
    return out
  }

  // Inside double quotes: the text is dropped, the substitutions are kept.
  const quoted = (): string => {
    let out = ''
    while (i < text.length) {
      const c = text[i]
      if (c === '"') {
        i++
        return out
      }
      if (c === '\\') {
        i += 2
      } else if (c === '$' && text[i + 1] === '(') {
        i += 2
        out += `(${plain(')')})`
      } else if (c === '`') {
        i++
        out += `\`${plain('`')}\``
      } else {
        i++
      }
    }
    return out
  }

  return plain()
}

// The PR number given to `gh pr merge`, if any (options may come first).
export function prNumber(shell: string) {
  const m = GH_MERGE.exec(shell)
  if (!m) return undefined
  const rest = shell.slice(m.index + m[0].length)
  return /^(?:\s+-\S+(?:\s+[^\s;&|)\x60-]\S*)?)*?\s+(\d+)(?![^\s;&|)\x60])/.exec(rest)?.[1]
}

// The folders a command moves to before it runs the rest: each leading `cd X &&` or `cd X;`
// (also inside a leading `(` or `{`), quoted or not, then the same inside a leading
// `bash -c '...'` or `eval '...'`. Paths are returned as written, in order.
const LEAD_CD = /^[\s({]*cd[ \t]+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|((?:[^\s;&|()'"`\\]|\\.)+))[ \t]*(?:&&|;|\n)/
const LEAD_RUNNER = /^[\s({]*(?:(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-\w*c|eval)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/
export function cdTargets(command: string): string[] {
  const dirs: string[] = []
  let rest = command
  for (;;) {
    const m = LEAD_CD.exec(rest)
    if (!m) break
    dirs.push(m[1] ?? m[2]?.replace(/\\(.)/g, '$1') ?? (m[3] ?? '').replace(/\\(.)/g, '$1'))
    rest = rest.slice(m[0].length)
  }
  const inner = LEAD_RUNNER.exec(rest)
  if (inner) dirs.push(...cdTargets(inner[1] ?? (inner[2] ?? '').replace(/\\(.)/g, '$1')))
  return dirs
}

// `to` resolved against the folder `from` (absolute), with `~` as `home`. Null when only the
// shell knows: a variable or glob, `cd -` or another option, `~user`.
export function resolveDir(from: string, to: string, home: string): string | null {
  if (/[$`*?]/.test(to) || to.startsWith('-') || /^~[^/]/.test(to)) return null
  const path = to === '~' || to.startsWith('~/') ? home + to.slice(1) : to.startsWith('/') ? to : `${from}/${to}`
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return `/${parts.join('/')}`
}
