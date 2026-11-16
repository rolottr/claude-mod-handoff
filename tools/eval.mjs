#!/usr/bin/env node
// Measures a handoff by what happened after it. The questions are real
// handoffs from this computer's transcripts; the answer is the conversation
// that followed: what the user had to say again, what Claude looked up again,
// what Claude got wrong.
//
//   node tools/eval.mjs list                          handoffs that were carried over
//   node tools/eval.mjs judge <session>               score the handoff that session started with
//   node tools/eval.mjs regen <session> [--cap n]     write a handoff from an old session with the current prompt
//   node tools/eval.mjs compare <session> <a> <b>     which of two handoff files serves that session better
//
// `judge` and `compare` run `claude -p` with no tools on the model in
// EVAL_MODEL (default haiku). `regen` resumes the whole old conversation on
// its own model, once: on a long session that is the costly step.
// Compare two prompts with `compare`, not with two `judge` scores: a judge
// finds more to fault in a longer text.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROJECTS = process.env.CLAUDE_PROJECTS ?? join(homedir(), '.claude', 'projects')
const MODEL = process.env.EVAL_MODEL ?? 'haiku'
const TITLE = '# Handoff:'
const CARRIED = 'The user started this conversation with a handoff from an earlier one. Continue the work from it:\n\n'

// How much of the conversation after the handoff the judge reads.
const AFTER_USER_MESSAGES = 6
const AFTER_CHARS = 60_000

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more]` : s)

function rowsOf(file) {
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // A line cut short by a crash: skip it.
    }
  }
  return rows
}

const blocks = row => (Array.isArray(row.message?.content) ? row.message.content : [])
const isToolResult = row => blocks(row).some(b => b?.type === 'tool_result')

/** The text a person typed in this row, or '' for any other row. */
export function typed(row) {
  if (row.type !== 'user' || row.isMeta || row.isSidechain || isToolResult(row)) return ''
  const c = row.message?.content
  const text = typeof c === 'string' ? c : blocks(row).filter(b => b?.type === 'text').map(b => b.text).join('\n')
  return /^\s*<(task-notification|local-command|command-name|system-reminder)/.test(text) ? '' : text.trim()
}

/** The handoff a conversation started with, and the row it is in; undefined when it started with none. */
export function handoffOf(rows) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const text = typed(row)
    if (text.startsWith(TITLE)) return { at: i, text, via: 'prompt' }
    // Sent with a /goal line: the rest went to the model as context, in a
    // row that is neither the model's nor a tool's.
    if (row.type === 'assistant' || row.type === 'api-request-blob' || isToolResult(row)) continue
    const raw = JSON.stringify(row)
    if (!raw.includes('started this conversation with a handoff')) continue
    const found = findString(row, s => s.includes(CARRIED))
    if (found !== undefined) return { at: i, text: found.slice(found.indexOf(CARRIED) + CARRIED.length), via: 'goal' }
  }
  return undefined
}

function findString(value, test) {
  if (typeof value === 'string') return test(value) ? value : undefined
  if (value === null || typeof value !== 'object') return undefined
  for (const v of Object.values(value)) {
    const found = findString(v, test)
    if (found !== undefined) return found
  }
  return undefined
}

/** What followed the handoff, as plain text: what was typed, what Claude said, which tools it called. */
export function afterOf(rows, at) {
  const lines = []
  let users = 0
  for (const row of rows.slice(at + 1)) {
    if (row.isSidechain) continue
    const said = typed(row)
    if (said !== '') {
      users++
      if (users > AFTER_USER_MESSAGES) break
      lines.push(`[USER] ${clip(said, 2000)}`)
      continue
    }
    if (row.type !== 'assistant') continue
    for (const b of blocks(row)) {
      if (b?.type === 'text' && b.text.trim() !== '') lines.push(`[CLAUDE] ${clip(b.text.trim(), 1500)}`)
      if (b?.type === 'tool_use') lines.push(`  [TOOL ${b.name}] ${clip(JSON.stringify(b.input ?? {}), 300)}`)
    }
  }
  const text = lines.join('\n')
  return { users, text: text.length > AFTER_CHARS ? `${text.slice(0, AFTER_CHARS)}\n[cut here]` : text }
}

function transcripts() {
  const files = []
  for (const project of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, project)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.jsonl')) files.push(join(dir, name))
    }
  }
  return files
}

function fileOf(session) {
  const file = transcripts().find(f => f.endsWith(`${session}.jsonl`) || f.split('/').pop().startsWith(session))
  if (file === undefined) throw new Error(`No transcript for session ${session} under ${PROJECTS}`)
  return file
}

function caseOf(session) {
  const rows = rowsOf(fileOf(session))
  const handoff = handoffOf(rows)
  if (handoff === undefined) throw new Error(`Session ${session} did not start with a handoff`)
  return { handoff: handoff.text, after: afterOf(rows, handoff.at) }
}

function claude(args, prompt) {
  // An empty folder, no tools and no MCP servers: the answer comes from the prompt alone.
  return execFileSync('claude', ['-p', '--tools', '', '--strict-mcp-config', '--output-format', 'text', ...args], {
    input: prompt,
    cwd: mkdtempSync(join(tmpdir(), 'handoff-eval-')),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

function jsonOf(reply) {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error(`The judge did not answer with JSON:\n${reply.slice(0, 500)}`)
  return JSON.parse(reply.slice(start, end + 1))
}

const NEEDS = [
  'First list the NEEDS: each thing the new conversation turned out to need from the old one. The evidence is in what followed:',
  '- the user said background again, or corrected a state Claude had wrong ("user-restated");',
  '- Claude read files or ran commands to find out what the old conversation already knew ("looked-up-again");',
  '- Claude did something wrong because it did not know a limit, a preference or a fact ("got-wrong");',
  '- Claude used a fact straight from the handoff and it was right ("used").',
  'Work the user newly asked for is not a need. Do not list a need you cannot point to in what followed.',
].join('\n')

export function judgePrompt(handoff, after) {
  return [
    'You are grading a handoff message: the first message of a new conversation, written by an AI agent to continue the work of an earlier conversation that the new one cannot see.',
    'You are given the handoff and what happened after it.',
    '',
    NEEDS,
    '',
    'For each need, say whether the handoff had it: "yes", "partly" or "no". Also list each statement in the handoff that what followed shows to be wrong.',
    'Reply with JSON alone:',
    '{"needs":[{"need":"...","kind":"user-restated|looked-up-again|got-wrong|used","inHandoff":"yes|partly|no"}],"wrong":["..."],"continued":true,"score":1}',
    '"continued": the first reply went on with the work without asking what it was. "score": 1 (the new conversation was lost) to 5 (it needed nothing more).',
    '',
    '<handoff>',
    handoff,
    '</handoff>',
    '',
    '<what_followed>',
    after,
    '</what_followed>',
  ].join('\n')
}

export function comparePrompt(first, second, after) {
  return [
    'You are comparing two handoff messages, A and B, written for the same moment: each is the first message of a new conversation that continues an earlier one it cannot see.',
    'You are given both and what happened in the new conversation. (It was started with one of them, or with a third; that does not matter.)',
    '',
    NEEDS,
    '',
    'For each need, say whether A had it and whether B had it. Judge the facts, not the length: a longer handoff is not better for being longer, nor worse.',
    'Reply with JSON alone:',
    '{"needs":[{"need":"...","a":"yes|partly|no","b":"yes|partly|no"}],"wrongA":["..."],"wrongB":["..."],"better":"A|B|tie"}',
    '',
    '<handoff_A>',
    first,
    '</handoff_A>',
    '',
    '<handoff_B>',
    second,
    '</handoff_B>',
    '',
    '<what_followed>',
    after,
    '</what_followed>',
  ].join('\n')
}

const had = (needs, key) => needs.filter(n => n[key] === 'yes').length + needs.filter(n => n[key] === 'partly').length / 2

function list() {
  const found = []
  for (const file of transcripts()) {
    if (!readFileSync(file, 'utf8').includes('Handoff:')) continue
    const rows = rowsOf(file)
    const handoff = handoffOf(rows)
    if (handoff === undefined) continue
    const when = rows[handoff.at]?.timestamp ?? ''
    found.push({ when, session: file.split('/').pop().replace('.jsonl', ''), chars: handoff.text.length, via: handoff.via, after: afterOf(rows, handoff.at).users })
  }
  found.sort((a, b) => a.when.localeCompare(b.when))
  for (const f of found) {
    console.log(`${f.when.slice(0, 16)}  ${f.session}  ${String(f.chars).padStart(6)} chars  via ${f.via}  ${f.after} user messages after`)
  }
  console.log(`${found.length} carried handoffs. Three or more user messages after make a fair question.`)
}

function judge(session) {
  const { handoff, after } = caseOf(session)
  const verdict = jsonOf(claude(['--model', MODEL], judgePrompt(handoff, after.text)))
  const needs = verdict.needs ?? []
  console.log(JSON.stringify(verdict, null, 2))
  console.log(`\n${needs.length} needs, the handoff had ${had(needs, 'inHandoff')}; ${(verdict.wrong ?? []).length} wrong; score ${verdict.score}/5`)
}

async function regen(session, flags) {
  // The prompt as the mod builds it now, from this checkout or the one in --hooks.
  const hooks = flags.hooks ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks')
  const { buildPrompt, clean, SECTIONS } = await import(pathToFileURL(join(hooks, 'prompt.ts')).href)
  const cap = flags.cap === undefined || flags.cap === 'none' ? null : Number(flags.cap)
  const prompt = buildPrompt({ cap, reader: 'claude', sections: SECTIONS.map(s => s.id) })
  const text = clean(claude(['--resume', session, '--fork-session', ...(flags.model ? ['--model', flags.model] : [])], prompt))
  const out = flags.out ?? `handoff-${session.slice(0, 8)}.md`
  writeFileSync(out, `${text}\n`)
  console.log(`${out}: ${text.length} chars`)
}

function compare(session, fileA, fileB) {
  const { after } = caseOf(session)
  const a = readFileSync(fileA, 'utf8').trim()
  const b = readFileSync(fileB, 'utf8').trim()
  // Both orders: a judge favours a position.
  const forward = jsonOf(claude(['--model', MODEL], comparePrompt(a, b, after.text)))
  const backward = jsonOf(claude(['--model', MODEL], comparePrompt(b, a, after.text)))
  const total = { needs: 0, a: 0, b: 0, winsA: 0, winsB: 0, wrongA: 0, wrongB: 0 }
  for (const [verdict, first, second] of [[forward, 'a', 'b'], [backward, 'b', 'a']]) {
    const needs = verdict.needs ?? []
    total.needs += needs.length
    total[first] += had(needs, 'a')
    total[second] += had(needs, 'b')
    total[first === 'a' ? 'wrongA' : 'wrongB'] += (verdict.wrongA ?? []).length
    total[second === 'a' ? 'wrongA' : 'wrongB'] += (verdict.wrongB ?? []).length
    if (verdict.better === 'A') total[first === 'a' ? 'winsA' : 'winsB']++
    if (verdict.better === 'B') total[second === 'a' ? 'winsA' : 'winsB']++
  }
  console.log(`${fileA} (${a.length} chars): had ${total.a} of ${total.needs} needs, ${total.wrongA} wrong, better in ${total.winsA} of 2`)
  console.log(`${fileB} (${b.length} chars): had ${total.b} of ${total.needs} needs, ${total.wrongB} wrong, better in ${total.winsB} of 2`)
}

function flagsOf(args) {
  const flags = {}
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i]
    else rest.push(args[i])
  }
  return { flags, rest }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  const { flags, rest } = flagsOf(args)
  if (command === 'list') list()
  else if (command === 'judge' && rest.length === 1) judge(rest[0])
  else if (command === 'regen' && rest.length === 1) await regen(rest[0], flags)
  else if (command === 'compare' && rest.length === 3) compare(rest[0], rest[1], rest[2])
  else {
    console.error('Usage: node tools/eval.mjs list | judge <session> | regen <session> [--cap n] [--model m] [--hooks dir] [--out file] | compare <session> <a.md> <b.md>')
    process.exit(1)
  }
}
