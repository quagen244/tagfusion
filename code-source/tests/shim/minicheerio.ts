// Mini lecteur HTML compatible avec la partie de cheerio utilisée par TagFusion.
// Sert uniquement aux tests (le vrai cheerio est fourni par Paperback sur l'iPhone).

export interface Node {
    type: 'tag' | 'text' | 'root'
    name: string
    attribs: Record<string, string>
    children: Node[]
    parent: Node | null
    data?: string
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const RAW = new Set(['script', 'style'])

function decode(s: string): string {
    return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&')
}

export function parse(html: string): Node {
    const root: Node = { type: 'root', name: '#root', attribs: {}, children: [], parent: null }
    let cur = root
    const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html))) {
        const tok = m[0]
        if (tok.startsWith('<!')) continue
        if (m[1]) { // fermeture
            const name = m[1].toLowerCase()
            let n: Node | null = cur
            while (n && n.type !== 'root' && n.name !== name) n = n.parent
            if (n && n.type !== 'root') cur = n.parent as Node
            continue
        }
        if (m[2]) { // ouverture
            const name = m[2].toLowerCase()
            const attribs: Record<string, string> = {}
            const are = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
            let a: RegExpExecArray | null
            while ((a = are.exec(m[3] ?? ''))) attribs[(a[1] as string).toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '')
            const node: Node = { type: 'tag', name, attribs, children: [], parent: cur }
            cur.children.push(node)
            if (RAW.has(name)) {
                const end = html.toLowerCase().indexOf(`</${name}`, re.lastIndex)
                const stop = end < 0 ? html.length : end
                node.children.push({ type: 'text', name: '#text', attribs: {}, children: [], parent: node, data: html.slice(re.lastIndex, stop) })
                re.lastIndex = stop
                continue
            }
            if (!VOID.has(name) && !m[4]) cur = node
            continue
        }
        cur.children.push({ type: 'text', name: '#text', attribs: {}, children: [], parent: cur, data: decode(tok) })
    }
    return root
}

// --- Sélecteurs : tag, .classe, #id, [attr], [attr="v"], [attr*="v"], :last-child, descendant, ">" et "," ---

interface Simple { tag?: string, classes: string[], id?: string, attrs: { name: string, op?: string, value?: string }[], lastChild: boolean }
type Step = { simple: Simple, comb: ' ' | '>' }

function parseSimple(s: string): Simple {
    const out: Simple = { classes: [], attrs: [], lastChild: false }
    const re = /^([a-zA-Z*][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w:-]+)(?:([*^$]?=)"([^"]*)")?\]|:last-child/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
        if (m[0] === ':last-child') out.lastChild = true
        else if (m[1]) { if (m[1] !== '*') out.tag = m[1].toLowerCase() }
        else if (m[2]) out.classes.push(m[2])
        else if (m[3]) out.id = m[3]
        else if (m[4]) out.attrs.push({ name: m[4].toLowerCase(), op: m[5], value: m[6] })
        if (re.lastIndex === m.index) re.lastIndex++
    }
    return out
}

function parseSelector(sel: string): Step[][] {
    return sel.split(',').map(part => {
        const steps: Step[] = []
        const tokens = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/)
        let comb: ' ' | '>' = ' '
        for (const t of tokens) {
            if (t === '>') { comb = '>'; continue }
            steps.push({ simple: parseSimple(t), comb })
            comb = ' '
        }
        return steps
    })
}

function matchSimple(n: Node, s: Simple): boolean {
    if (n.type !== 'tag') return false
    if (s.tag && n.name !== s.tag) return false
    if (s.id && n.attribs['id'] !== s.id) return false
    const cls = (n.attribs['class'] ?? '').split(/\s+/)
    if (s.classes.some(c => !cls.includes(c))) return false
    for (const a of s.attrs) {
        const v = n.attribs[a.name]
        if (v === undefined) return false
        if (a.op === '=' && v !== a.value) return false
        if (a.op === '*=' && !v.includes(a.value ?? '')) return false
    }
    if (s.lastChild) {
        const sibs = (n.parent?.children ?? []).filter(c => c.type === 'tag')
        if (sibs[sibs.length - 1] !== n) return false
    }
    return true
}

function matchSteps(n: Node, steps: Step[], i: number): boolean {
    const step = steps[i] as Step
    if (!matchSimple(n, step.simple)) return false
    if (i === 0) return true
    const prevComb = step.comb
    let p = n.parent
    if (prevComb === '>') return !!p && matchSteps(p, steps, i - 1)
    while (p) {
        if (matchSteps(p, steps, i - 1)) return true
        p = p.parent
    }
    return false
}

function matches(n: Node, groups: Step[][]): boolean {
    return groups.some(g => matchSteps(n, g, g.length - 1))
}

function descendants(n: Node, out: Node[] = []): Node[] {
    for (const c of n.children) {
        if (c.type === 'tag') { out.push(c); descendants(c, out) }
    }
    return out
}

function textOf(n: Node): string {
    if (n.type === 'text') return n.data ?? ''
    return n.children.map(textOf).join('')
}

export class Q {
    constructor(public nodes: Node[]) {}
    get length(): number { return this.nodes.length }
    attr(name: string): string | undefined { return this.nodes[0]?.attribs[name.toLowerCase()] }
    text(): string { return this.nodes.map(textOf).join('') }
    html(): string | null { return this.nodes[0] ? textOf(this.nodes[0]) : null }
    find(sel: string): Q {
        const g = parseSelector(sel)
        const seen = new Set<Node>()
        const out: Node[] = []
        for (const n of this.nodes) for (const d of descendants(n)) if (!seen.has(d) && matches(d, g)) { seen.add(d); out.push(d) }
        return new Q(out)
    }
    first(): Q { return new Q(this.nodes.slice(0, 1)) }
    last(): Q { return new Q(this.nodes.slice(-1)) }
    parent(): Q { return new Q(this.nodes.map(n => n.parent).filter((p): p is Node => !!p && p.type === 'tag')) }
    closest(sel: string): Q {
        const g = parseSelector(sel)
        const out: Node[] = []
        for (const n of this.nodes) {
            let p: Node | null = n
            while (p && p.type === 'tag') { if (matches(p, g)) { out.push(p); break } p = p.parent }
        }
        return new Q(out)
    }
    each(fn: (i: number, el: Node) => void | boolean): Q { this.nodes.forEach((n, i) => fn(i, n)); return this }
    map<T>(fn: (i: number, el: Node) => T): { get: () => T[] } { const r = this.nodes.map((n, i) => fn(i, n)); return { get: () => r } }
    is(sel: string): boolean { const g = parseSelector(sel); return this.nodes.some(n => matches(n, g)) }
    get(i?: number): any { return i === undefined ? this.nodes : this.nodes[i] }
    toArray(): Node[] { return this.nodes }
}

export function load(html: string): any {
    const root = parse(html)
    const $ = (x: string | Node): Q => typeof x === 'string' ? new Q([root]).find(x) : new Q([x])
    return $
}
