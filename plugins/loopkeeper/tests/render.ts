// render.ts: a plain-text renderer over a mount's drawn() tree (no colors), for the kit tests and for
// docs/renderings.md. It is an approximation of the host's layout, enough to read a pane as text:
// round and single borders, columns, rows, row and column gaps, padding, flexGrow, flexShrink,
// flexWrap and justifyContent 'space-between'. Not a test file: the harness does not collect it.
//
//   const ui = await $.ui.mount({ ...PANE, surface })
//   console.log(render(await ui.drawn(), 60))

type N = any

const W = (s: string): number => [...s].length

const FRAMES: Record<string, string[]> = {
  round: ['╭', '╮', '╰', '╯', '─', '│'],
  single: ['┌', '┐', '└', '┘', '─', '│'],
  bold: ['┏', '┓', '┗', '┛', '━', '┃'],
  double: ['╔', '╗', '╚', '╝', '═', '║'],
}

function textOf(n: N): string {
  if (n === null || n === undefined || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  // a plain Button reads as the host draws it: `1: Stage` with a hotkey, the label alone without
  if (n.type === 'Button' && n.props?.plain === true) return n.props?.hotkey ? `${n.props.hotkey}: ${n.props?.label ?? ''}` : String(n.props?.label ?? '')
  if (n.type === 'Button') return `[ ${n.props?.label ?? ''} ]`
  if (n.type === 'Svg') return String(n.props?.alt ?? '')
  return (n.children ?? []).map(textOf).join('')
}

function cut(s: string, width: number): string {
  if (width <= 0 || W(s) <= width) return s
  return width === 1 ? '…' : [...s].slice(0, width - 1).join('') + '…'
}

function wrapWords(s: string, width: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const word of s.split(' ')) {
    const next = cur ? cur + ' ' + word : word
    if (W(next) <= width || !cur) cur = next
    else {
      out.push(cur)
      cur = word
    }
  }
  if (cur || !out.length) out.push(cur)
  return out
}

/** Lines of a node; width null means its natural size. */
function lay(n: N, width: number | null): string[] {
  if (n === null || n === undefined || n === false) return []
  if (typeof n === 'string' || typeof n === 'number') return [String(n)]
  if (n.type !== 'Box') {
    const s = textOf(n)
    if (width === null) return [s]
    return n.props?.wrap === 'wrap' ? wrapWords(s, width) : [cut(s, width)]
  }
  const p = n.props ?? {}
  const kids: N[] = (n.children ?? []).filter((c: N) => c !== null && c !== undefined && c !== false)
  const border = FRAMES[p.borderStyle as string] ? 1 : 0
  const padX = p.paddingX ?? p.padding ?? 0
  const padY = p.paddingY ?? p.padding ?? 0
  const chrome = 2 * (border + padX)
  const inner = width === null ? null : Math.max(0, width - chrome)
  let body: string[] = p.flexDirection === 'column' ? column(kids, inner, p) : row(kids, inner, p)
  const natural = Math.max(0, ...body.map(W))
  const boxW = width === null ? natural + chrome : width
  const innerW = boxW - chrome
  if (padY) body = [...Array(padY).fill(''), ...body, ...Array(padY).fill('')]
  if (!border && !padX) return body
  const side = ' '.repeat(padX)
  const lines = body.map(l => side + l.padEnd(innerW) + side)
  if (!border) return lines.map(l => l.trimEnd())
  const [tl, tr, bl, br, h, v] = FRAMES[p.borderStyle as string]!
  const span = boxW - 2
  return [tl + h.repeat(span) + tr, ...lines.map(l => v + l + v), bl + h.repeat(span) + br]
}

function column(kids: N[], inner: number | null, p: N): string[] {
  const gap = p.rowGap ?? p.gap ?? 0
  const body: string[] = []
  kids.forEach((k, i) => {
    const l = lay(k, inner)
    if (i && gap && l.length) for (let g = 0; g < gap; g++) body.push('')
    body.push(...l)
  })
  return body
}

function row(kids: N[], inner: number | null, p: N): string[] {
  const gap = p.columnGap ?? p.gap ?? 0
  const nat = kids.map(k => Math.max(0, ...lay(k, null).map(W)))
  const groups: number[][] = []
  if (inner !== null && p.flexWrap === 'wrap') {
    let cur: number[] = []
    let used = 0
    kids.forEach((_, i) => {
      const need = nat[i]! + (cur.length ? gap : 0)
      if (cur.length && used + need > inner) {
        groups.push(cur)
        cur = []
        used = 0
      }
      used += nat[i]! + (cur.length ? gap : 0)
      cur.push(i)
    })
    if (cur.length) groups.push(cur)
  } else groups.push(kids.map((_, i) => i))
  const out: string[] = []
  for (const g of groups) out.push(...rowGroup(kids, nat, g, inner, gap, p))
  return out
}

function rowGroup(kids: N[], nat: number[], idx: number[], inner: number | null, gap: number, p: N): string[] {
  const ws = idx.map(i => nat[i]!)
  const gaps = Math.max(0, idx.length - 1) * gap
  let spread = 0
  if (inner !== null) {
    const total = ws.reduce((a, c) => a + c, 0) + gaps
    if (total > inner) {
      let over = total - inner
      idx.forEach((i, j) => {
        if (over > 0 && (kids[i].props?.flexShrink ?? 0) > 0) {
          const take = Math.min(over, Math.max(0, ws[j]! - 1))
          ws[j]! -= take
          over -= take
        }
      })
    } else {
      const free = inner - total
      const grows = idx.map(i => (kids[i].props?.flexGrow ?? 0) as number)
      const gsum = grows.reduce((a, c) => a + c, 0)
      if (gsum) {
        let given = 0
        grows.forEach((gr, j) => {
          const add = Math.floor((free * gr) / gsum)
          ws[j]! += add
          given += add
        })
        // the cells that do not divide go one by one to the first growing children
        let left = free - given
        for (let j = 0; left > 0 && j < grows.length; j++) {
          if (grows[j]) {
            ws[j]! += 1
            left--
          }
          if (j === grows.length - 1 && left > 0) j = -1
        }
      } else if (p.justifyContent === 'space-between' && idx.length > 1) spread = free
    }
  }
  const cells = idx.map((i, j) => lay(kids[i], inner === null ? null : ws[j]!))
  const h = Math.max(1, ...cells.map(c => c.length))
  const lines: string[] = []
  for (let r = 0; r < h; r++) {
    let s = ''
    idx.forEach((_, j) => {
      const cell = cells[j]![r] ?? ''
      const last = j === idx.length - 1
      let pad = ws[j]! - W(cell)
      if (spread && !last) {
        const slots = idx.length - 1
        const share = Math.floor(spread / slots) + (j === slots - 1 ? spread % slots : 0)
        pad += share
      }
      s += (j ? ' '.repeat(gap) : '') + cell + (last ? '' : ' '.repeat(Math.max(0, pad)))
    })
    lines.push(s.trimEnd())
  }
  return lines
}

/** The drawn tree as text, `width` columns wide (what a Pane body or the prompt band would get). */
export function render(tree: unknown, width: number): string {
  return lay(tree as N, width).join('\n')
}
