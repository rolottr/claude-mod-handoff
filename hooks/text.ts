// Reading and changing a handoff's text, and the line diff between two.

export type HandoffInfo = {
  goal: string | null
  title: string | null
  startBy: string | null
  parts: number
}

const GOAL = '/goal '
const TITLE = '# Handoff:'

export function isHandoff(text: string): boolean {
  const t = text.trimStart()

  // A prompt that starts with /goal is a command line: its /goal row
  // draws the card (see the CommandOutput hook), not the prompt.
  return t.startsWith(TITLE)
}

export function parse(text: string): HandoffInfo {
  const lines = text.split('\n')
  const first = lines[0] ?? ''
  const title = lines.find(l => l.startsWith(TITLE))
  const startBy = [...lines].reverse().find(l => /^start by:/i.test(l.trim()))

  return {
    goal: first.startsWith(GOAL) ? first.slice(GOAL.length).trim() : null,
    title: title === undefined ? null : title.slice(TITLE.length).trim(),
    startBy: startBy === undefined ? null : startBy.trim().replace(/^start by:\s*/i, ''),
    parts: lines.filter(l => l.startsWith('## ')).length,
  }
}

/** The text with its `/goal` line set to `goal`, or added when it has none. */
export function withGoal(text: string, goal: string): string {
  const line = `${GOAL}${goal.replace(/\s+/g, ' ').trim()}`
  if (!text.startsWith(GOAL)) {
    return `${line}\n${text}`
  }
  const end = text.indexOf('\n')

  return end === -1 ? line : `${line}${text.slice(end)}`
}

/**
 * The arguments of a `/goal` run whose prompt was a whole handoff: the
 * goal's one line, and the handoff after it to send as its own message.
 */
export function splitGoal(args: string): { goal: string; rest: string } | null {
  const end = args.indexOf('\n')
  if (end === -1) {
    return null
  }
  const rest = args.slice(end + 1).trim()
  if (!rest.startsWith(TITLE)) {
    return null
  }

  return { goal: args.slice(0, end).trim(), rest }
}

/** A unified diff of two texts, one hunk over the whole of both. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n').slice(0, 600)
  const b = after.split('\n').slice(0, 600)
  const rows = a.length + 1
  const cols = b.length + 1
  const lcs = new Uint16Array(rows * cols)
  const at = (i: number, j: number) => lcs[i * cols + j] ?? 0

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }

  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i]}`)
      i++
      j++
    } else if (j < b.length && (i >= a.length || at(i, j + 1) >= at(i + 1, j))) {
      out.push(`+${b[j]}`)
      j++
    } else {
      out.push(`-${a[i]}`)
      i++
    }
  }

  return `@@ -1,${a.length} +1,${b.length} @@\n${out.join('\n')}`
}

export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours} h ago`
  }

  return `${Math.floor(hours / 24)} d ago`
}
