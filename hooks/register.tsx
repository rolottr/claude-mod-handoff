import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Carried, HandoffEntry, HandoffOptions, PendingHandoff, Reader, SectionId } from '../types'
import { ago, isHandoff, lineDiff, parse, splitGoal, withGoal } from './text'

const PANE = 'handoff'
const COMMAND = 'handoff'
const WIDTH = 76
const MIN_WIDTH = 48

// Length presets, cycled with `l`. Any other cap comes from `/handoff <n>`.
const CAPS: (number | null)[] = [1000, 3000, null]
const DEFAULT_CAP = 3000

// The context fill, in percent, that shows the status entry, and the one
// that shows the band and writes a handoff in the background. Another
// background handoff is written each 10 points past the last.
const STATUS_AT = 50
const BAND_AT = 70
const AUTO_STEP = 10

// Handoffs kept per project.
const KEPT = 20

// A saved handoff waits this long for the next window, then is dropped.
const PENDING_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

const SECTIONS: { id: SectionId; key: string; label: string; ask: string }[] = [
  { id: 'goal', key: '1', label: 'Goal', ask: 'Goal: what the user wants in the end, and why.' },
  { id: 'state', key: '2', label: 'State', ask: 'State: what is done, what works, and what was checked and how.' },
  { id: 'next', key: '3', label: 'Next steps', ask: 'Next steps: an ordered list of concrete actions; the first one is where to start.' },
  { id: 'files', key: '4', label: 'Files & commands', ask: 'Files and commands: exact paths, branches, URLs, and the commands to build, run and test.' },
  { id: 'decisions', key: '5', label: 'Decisions & dead ends', ask: 'Decisions and dead ends: what was decided and why, what was tried and failed, so it is not tried again.' },
  { id: 'prefs', key: '6', label: 'User preferences', ask: 'User preferences: how the user wants the work done, constraints they stated, what they rejected.' },
  { id: 'questions', key: '7', label: 'Open questions', ask: 'Open questions: unknowns, blockers, and what to ask the user.' },
]

const DEFAULT_OPTIONS: HandoffOptions = {
  cap: DEFAULT_CAP,
  reader: 'claude',
  sections: SECTIONS.map(s => s.id),
}

const options = atom({ plugin: 'handoff', key: 'options' } as const, DEFAULT_OPTIONS, { shape: 'options-1' })
const phase = atom({ plugin: 'handoff', key: 'phase' } as const, 'options' as 'options' | 'writing' | 'ready')
const history = atom({ plugin: 'handoff', key: 'history' } as const, [] as HandoffEntry[], { shape: 'history-1' })
const shown = atom({ plugin: 'handoff', key: 'shown' } as const, -1)
const view = atom({ plugin: 'handoff', key: 'view' } as const, 'text' as 'text' | 'diff')
const isEditingGoal = atom({ plugin: 'handoff', key: 'isEditingGoal' } as const, false)
const notice = atom({ plugin: 'handoff', key: 'notice' } as const, null as string | null)
const context = atom({ plugin: 'handoff', key: 'context' } as const, null as number | null)
const laterAt = atom({ plugin: 'handoff', key: 'laterAt' } as const, null as number | null)
const autoAt = atom({ plugin: 'handoff', key: 'autoAt' } as const, null as number | null)
const isAutoWriting = atom({ plugin: 'handoff', key: 'isAutoWriting' } as const, false)
const arrived = atom({ plugin: 'handoff', key: 'arrived' } as const, null as Carried | null)

const READERS: Record<Reader, { label: string; who: string }> = {
  claude: {
    label: 'Claude',
    who: 'The reader is another Claude Code session in the same project, with the same tools, but with none of this conversation. Name files, commands and tools as they are.',
  },
  agent: {
    label: 'Any agent',
    who: 'The reader is another AI agent, which may not be Claude and may not have Claude Code. Do not name Claude Code tools, slash commands, skills, hooks or memory files; say what to do in plain terms. The message must stand alone.',
  },
}

function capLabel(cap: number | null): string {
  return cap === null ? 'no cap' : `${cap.toLocaleString('en-US')} chars`
}

function buildPrompt(o: HandoffOptions): string {
  const asks = SECTIONS.filter(s => o.sections.includes(s.id)).map(s => `- ${s.ask}`)
  const limit =
    o.cap === null
      ? 'There is no length limit, but write nothing that the next agent does not need.'
      : `Hard limit: ${o.cap} characters in all, markdown included. Aim for about ${Math.round(o.cap * 0.85)}. Cut the least useful detail first.`

  return [
    'Stop the current work for a moment. You have no tools for this answer: reply at once with text only.',
    '',
    'Write a handoff message: the first message of a new conversation that continues the work of this one. The next agent will read only this message, so it must be enough to go on without asking what happened.',
    '',
    READERS[o.reader].who,
    '',
    'Cover these parts, in this order, each under a short `##` heading. Leave out a part that has nothing in it:',
    ...asks,
    '',
    'Rules:',
    ...(o.sections.includes('goal')
      ? [
          '- The very first line is `/goal <condition>`: the goal as one completion condition that a separate evaluator can check from the conversation (for example "all tests in test/auth pass (bun test exits 0)"). One line, at most 500 characters, nothing before it.',
          '- The second line is `# Handoff: <the task in a few words>`.',
        ]
      : ['- Start with one line: `# Handoff: <the task in a few words>`.']),
    '- Write to the next agent as "you". Be literal and dense: exact paths, names, commands, error texts, numbers. No praise, no filler, no history for its own sake.',
    '- Say what is verified and what is only assumed.',
    '- Never include secrets: API keys, tokens, passwords, private URLs with credentials.',
    '- Leave out this request to write a handoff.',
    '- End with one line: `Start by: <the first action>`.',
    `- ${limit}`,
    '',
    'Reply with the message alone: no preamble, no closing words, no code fence around it.',
  ].join('\n')
}

function shortenPrompt(draft: string, cap: number): string {
  return [
    'You have no tools for this answer: reply at once with text only.',
    `This handoff message has ${draft.length} characters. Rewrite it in at most ${cap} characters, markdown included. Keep the first \`/goal\` line as it is if there is one, the headings, the exact paths and commands, the next steps and the "Start by" line; cut the least useful detail first. Reply with the message alone.`,
    '',
    '<handoff>',
    draft,
    '</handoff>',
  ].join('\n')
}

function clean(reply: string): string {
  // A model that fences its whole answer anyway: take the fence off.
  const fenced = reply.trim().match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/)

  return (fenced?.[1] ?? reply).trim()
}

async function say($: EngineInterface, line: string) {
  await update($, notice, () => line)
  $.clock.after(5000, () => {
    void update($, notice, now => (now === line ? null : now))
  })
}

function historyKey(root: string): string {
  return `history:${root}`
}

function pendingKey(root: string): string {
  return `pending:${root}`
}

function isEntry(value: unknown): value is HandoffEntry {
  const v = value as HandoffEntry | null
  return typeof v?.text === 'string' && typeof v.id === 'number' && typeof v.createdAt === 'number'
}

function isPending(value: unknown): value is PendingHandoff {
  const v = value as PendingHandoff | null
  return typeof v?.text === 'string' && typeof v.sessionId === 'string' && typeof v.createdAt === 'number'
}

/** Changes this project's handoffs, in the session and on disk. */
async function changeHistory($: EngineInterface, change: (list: HandoffEntry[]) => HandoffEntry[]): Promise<HandoffEntry[]> {
  const list = await update($, history, old => change(old).slice(-KEPT))
  await $.store.set(historyKey(await $.session.root()), list)

  return list
}

function pick(list: readonly HandoffEntry[], at: number): { entry: HandoffEntry; index: number } | undefined {
  if (list.length === 0) {
    return undefined
  }
  const index = at < 0 || at >= list.length ? list.length - 1 : at
  const entry = list[index]

  return entry === undefined ? undefined : { entry, index }
}

// One write at a time, whether the person asked or the context filled up.
let isBusy = false

/**
 * Writes a handoff from this conversation and adds it to the history.
 * `autoPercent` marks one written in the background: it leaves the pane's
 * phase alone and says nothing when it fails.
 */
async function write($: EngineInterface, autoPercent: number | null = null) {
  if (isBusy) {
    if (autoPercent === null) {
      await say($, 'A handoff is being written. It shows here when it is done.')
    }
    return
  }
  const o = await read($, options)
  if (o.sections.length === 0) {
    await say($, 'Pick at least one part to include.')

    return
  }

  isBusy = true
  const isAuto = autoPercent !== null
  if (isAuto) {
    await update($, isAutoWriting, () => true)
  } else {
    await update($, phase, () => 'writing')
    await update($, notice, () => null)
  }

  try {
    let reply = await $.model.fork({ prompt: buildPrompt(o) })
    if (reply.isAnswered && o.cap !== null && clean(reply.text).length > o.cap) {
      const longer = clean(reply.text)
      const shorter = await $.model.fork({ prompt: shortenPrompt(longer, o.cap) })
      reply = shorter.isAnswered && clean(shorter.text).length < longer.length ? shorter : reply
    }

    if (!reply.isAnswered) {
      if (!isAuto) {
        const why =
          reply.reason === 'nothing-to-fork'
            ? 'there is no conversation to hand off yet (or it was just cleared).'
            : reply.reason === 'api-error'
              ? `the API answered ${reply.status ?? 'with an error'}.`
              : reply.reason === 'aborted'
                ? 'it was interrupted.'
                : 'the model gave no text.'
        const hasAny = (await read($, history)).length > 0
        await update($, phase, () => (hasAny ? 'ready' : 'options'))
        await say($, `Could not write the handoff: ${why}`)
      }

      return
    }

    const text = clean(reply.text)
    const createdAt = await $.clock.now()
    const sessionId = await $.session.id()
    await changeHistory($, list => [...list, { id: (list[list.length - 1]?.id ?? 0) + 1, text, createdAt, sessionId, autoAt: autoPercent }])
    await update($, shown, () => -1)
    await update($, view, () => 'text')
    await update($, isEditingGoal, () => false)
    if (!isAuto || (await read($, phase)) === 'ready') {
      await update($, phase, () => 'ready')
    }
  } finally {
    isBusy = false
    if (isAuto) {
      await update($, isAutoWriting, () => false)
    }
  }
}

// Bold `/goal` and the title in the prompt box, with a dim note after the
// goal line, so the person sees what pressing Enter does.
async function paintHandoff($: EngineInterface, text: string) {
  const decorations: { start: number; end: number; bold?: boolean; color?: string; dimColor?: boolean; virtualText?: string }[] = []
  if (text.startsWith('/goal ')) {
    const end = text.indexOf('\n')
    decorations.push({ start: 0, end: 5, bold: true, color: 'cyan' })
    decorations.push({ start: end === -1 ? text.length : end, end: end === -1 ? text.length : end, virtualText: '  ← sets the goal; the rest is sent after it', dimColor: true })
  }
  const title = text.indexOf('# Handoff:')
  if (title !== -1) {
    const end = text.indexOf('\n', title)
    decorations.push({ start: title, end: end === -1 ? text.length : end, bold: true })
  }
  await $.prompt.paint({ text, decorations })
}

// Puts the handoff in the prompt box. Right after a /clear or at a
// session's start the box may not be mounted yet, so it tries a few times.
async function fillPrompt($: EngineInterface, text: string, tries = 6): Promise<boolean> {
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (filled.isFilled) {
    await paintHandoff($, text)

    return true
  }
  if (tries <= 1) {
    return false
  }
  await $.clock.sleep(500)

  return fillPrompt($, text, tries - 1)
}

async function copy($: EngineInterface, text: string, surface?: RenderSurface) {
  const done = await $.ui.copy({ text, surface })
  await say($, done.isCopied ? 'Copied. Paste it into the new window.' : `Could not copy: ${done.reason}`)
}

async function carryOver($: EngineInterface, text: string) {
  await $.ui.close({ id: PANE })
  await $.command.run({ command: 'clear' })
  if (await fillPrompt($, text)) {
    $.ui.toast('Context cleared. The handoff is in the prompt box: edit it or press Enter.', { timeoutMs: 8000 })
  } else {
    $.ui.toast('Context cleared, but the prompt box was busy. Run /handoff last to put the handoff there.', { timeoutMs: 10000 })
  }
}

async function saveForNext($: EngineInterface, text: string, andQuit: boolean) {
  const root = await $.session.root()
  const pending: PendingHandoff = { text, root, sessionId: await $.session.id(), createdAt: await $.clock.now() }
  await $.store.set(pendingKey(root), pending)

  if (andQuit) {
    await $.ui.close({ id: PANE })
    await $.command.run({ command: 'exit' })

    return
  }
  await say($, 'Saved. The next `claude` you start in this project opens with it in the prompt box.')
}

// The handoff a /goal run split off, for the turn that /goal starts.
let toCarry: { goal: string; rest: string } | null = null

let terminalColumns: number | undefined

async function openPane($: EngineInterface) {
  const columns =
    terminalColumns === undefined ? WIDTH : Math.max(MIN_WIDTH, Math.min(WIDTH, Math.floor(terminalColumns * 0.45)))

  return $.ui.open({ id: PANE, title: 'Handoff', columns, focus: true, closeOnEscape: true })
}

/** Opens the pane on the newest handoff, or on the options when there is none. */
async function openOnNewest($: EngineInterface) {
  const hasAny = (await read($, history)).length > 0
  if ((await read($, phase)) !== 'writing') {
    await update($, phase, () => (hasAny ? 'ready' : 'options'))
  }
  await update($, shown, () => -1)

  return openPane($)
}

/** A handoff drawn as a card: its title, goal, first action and size. */
function card($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], text: string, more: string) {
  const { Box, Text } = $.ui.resolve(e)
  const info = parse(text)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text>
        <Text bold color="cyan">
          ↪ Handoff
        </Text>
        {info.title === null ? '' : ` · ${info.title}`}
      </Text>
      {info.goal !== null && (
        <Text>
          <Text dimColor>Goal: </Text>
          {info.goal}
        </Text>
      )}
      {info.startBy !== null && (
        <Text>
          <Text dimColor>Start by: </Text>
          {info.startBy}
        </Text>
      )}
      <Text dimColor>
        {text.length.toLocaleString('en-US')} chars · {info.parts} {info.parts === 1 ? 'part' : 'parts'} · {more}
      </Text>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Write a handoff message for a new session: copy it, clear and carry it over, or leave it for the next window',
      argumentHint: '[<max chars>|nocap|last|close]',
    })

    const result = await next(e)
    const root = await $.session.root()

    // This project's handoffs from earlier sessions.
    if ((await read($, history)).length === 0) {
      const kept = await $.store.get(historyKey(root))
      if (Array.isArray(kept)) {
        const list = kept.filter(isEntry)
        if (list.length > 0) {
          await update($, history, () => list)
        }
      }
    }

    // A handoff another session left for this project: put it in the
    // prompt box once, then forget it.
    const pending = await $.store.get(pendingKey(root))
    if (isPending(pending) && pending.sessionId !== (await $.session.id())) {
      await $.store.delete(pendingKey(root))
      if ((await $.clock.now()) - pending.createdAt < PENDING_MAX_AGE_MS) {
        $.clock.after(300, () => {
          void fillPrompt($, pending.text, 10).then(isFilled => {
            $.ui.toast(
              isFilled
                ? 'A handoff from your last session is in the prompt box: edit it or press Enter.'
                : 'A handoff from your last session is waiting: run /handoff last.',
              { timeoutMs: 10000 },
            )
          })
        })
      }
    }

    return result
  })

  // After each turn: the context's fill on the status line, and past
  // BAND_AT a handoff written in the background, so it is ready when the
  // person asks for it.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.context.percent === undefined) {
      return result
    }
    const percent = Math.round(e.context.percent)
    await update($, context, () => percent)
    $.ui.status(percent >= STATUS_AT ? `ctx ${percent}%` : undefined)

    if (percent < BAND_AT) {
      // A /clear or a compaction emptied it: start over.
      await update($, autoAt, () => null)
      await update($, laterAt, () => null)

      return result
    }

    const last = await read($, autoAt)
    if (!isBusy && (last === null || percent >= last + AUTO_STEP)) {
      await update($, autoAt, () => percent)
      void write($, percent)
    }

    return result
  })

  // A handoff sent as one prompt starts with `/goal`, so the whole
  // message would be the goal's argument. The goal keeps the first line;
  // the rest reaches the model as the command's context, which the person
  // never sees as a row: the card on the /goal row stands for it.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const split = splitGoal(e.args)
    if (split === null) {
      return next(e)
    }
    // For the turn /goal starts (the prompt.submit hook below).
    toCarry = split

    return next({ ...e, args: split.goal })
  }).catch(($, e, next) => next(e))

  // The turn the /goal starts: the rest of the handoff goes with it, as
  // context the model reads and the person never sees as a row.
  on('prompt.submit', async ($, e, next) => {
    const carry = toCarry
    if (carry === null || e.command?.name !== 'goal') {
      // The person's next prompt takes the handoff card down.
      if (e.origin.kind === 'composer' && (await read($, arrived)) !== null) {
        await update($, arrived, () => null)
      }
      return next(e)
    }
    toCarry = null
    await update($, arrived, () => ({ goal: carry.goal, text: carry.rest }))

    return next({
      ...e,
      context: [...(e.context ?? []), `The user started this conversation with a handoff from an earlier one. Continue the work from it:\n\n${carry.rest}`],
    })
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    terminalColumns = e.presentation.columns
    const arg = e.args.trim().toLowerCase().replace(/[,_]/g, '')

    if (arg === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Closed the handoff pane.' }
    }

    if (arg === 'last') {
      const found = pick(await read($, history), -1)
      if (found === undefined) {
        return { text: 'There is no handoff for this project yet.' }
      }
      const isFilled = await fillPrompt($, found.entry.text)

      return { text: isFilled ? 'The last handoff is in the prompt box.' : 'Could not fill the prompt box.' }
    }

    if (arg === 'nocap' || arg === 'none' || arg === 'unlimited') {
      await update($, options, o => ({ ...o, cap: null }))
      await update($, phase, () => 'options')
    } else if (arg !== '') {
      const n = Number(arg.replace(/k$/, '000'))
      if (!Number.isInteger(n) || n < 200) {
        return { text: `Unknown option "${e.args.trim()}". Use /handoff, /handoff <max chars> (for example 2000 or 2k), /handoff nocap, last or close.` }
      }
      await update($, options, o => ({ ...o, cap: n }))
      await update($, phase, () => 'options')
    } else if ((await read($, phase)) !== 'writing') {
      // A fresh /handoff opens on the options, unless a handoff was written
      // in the background since the context filled up.
      const newest = pick(await read($, history), -1)
      const isFresh = newest !== undefined && newest.entry.autoAt !== null && newest.entry.sessionId === (await $.session.id())
      await update($, phase, () => (isFresh ? 'ready' : 'options'))
      await update($, shown, () => -1)
    }

    const opened = await openPane($)

    return {
      text: opened.isPlaced
        ? 'Opened the handoff pane. Pick the options, then press g.'
        : `The handoff pane could not open: ${opened.reason}`,
    }
  })

  // The band above the prompt, once the context passes BAND_AT.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A handoff that just came in with a /goal: its card, until the next
    // prompt. The /goal row itself is the engine's alone.
    const came = await read($, arrived)
    if (came !== null && !e.props.hasSurvey) {
      const { Box, Button } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          {card($, e, came.text, `goal set: ${came.goal}`)}
          <Button key="hide-card" hotkey="z" plain dimColor label="Hide" onPress={() => update($, arrived, () => null)} />
        </Box>
      )
    }

    const percent = await read($, context)
    const later = await read($, laterAt)
    if (e.props.hasSurvey || percent === null || percent < BAND_AT || (later !== null && percent < later + AUTO_STEP)) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isWriting = (await read($, isAutoWriting)) || (await read($, phase)) === 'writing'
    const newest = pick(await read($, history), -1)
    const isReady = !isWriting && newest !== undefined && newest.entry.autoAt !== null && newest.entry.sessionId === (await $.session.id())

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text color={percent >= 85 ? 'red' : 'yellow'}>● Context {percent}%</Text>
        <Text dimColor>{isWriting ? 'writing a handoff…' : isReady ? 'a handoff is ready' : 'time to hand off'}</Text>
        <Button key="handoff" hotkey="h" plain variant="primary" label="Hand off" onPress={() => void openOnNewest($)} />
        <Button key="later" hotkey="z" plain dimColor label="Later" onPress={() => update($, laterAt, () => percent)} />
      </Box>
    )
  })

  // In the new session, a handoff sent as a prompt is drawn as a card;
  // ctrl+o shows the whole text. The model reads the whole text either way.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.isExpanded) {
      return next(e)
    }
    if (isHandoff(e.props.text)) {
      return card($, e, e.props.text, 'ctrl+o shows it all')
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    terminalColumns = e.viewport?.columns ?? terminalColumns
    const { Box, Button, Code, Input, Markdown, Text } = $.ui.resolve(e)
    const o = await read($, options)
    const now = await read($, phase)
    const list = await read($, history)
    const line = await read($, notice)
    const rule = <Text dimColor>{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
    const noticeRow =
      line === null ? null : <Text color={line.startsWith('Could not') || line.startsWith('Pick') ? 'red' : 'green'}>{line}</Text>

    if (now === 'writing') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>
            Writing the handoff from this conversation ({capLabel(o.cap)}, for {READERS[o.reader].label})…
          </Text>
          <Text dimColor>This takes a few seconds. You can close the pane; the result waits here.</Text>
        </Box>
      )
    }

    const found = pick(list, await read($, shown))
    if (now === 'ready' && found !== undefined) {
      const { entry, index } = found
      const text = entry.text
      const info = parse(text)
      const before = list[index - 1]
      const isDiff = (await read($, view)) === 'diff' && before !== undefined
      const isEditing = (await read($, isEditingGoal)) && info.goal !== null
      const isOver = o.cap !== null && text.length > o.cap
      const age = ago((await $.clock.now()) - entry.createdAt)
      const run = (job: () => Promise<unknown>) => () => {
        void job()
      }
      const go = (step: number) => async () => {
        await update($, shown, () => Math.min(list.length - 1, Math.max(0, index + step)))
        await update($, isEditingGoal, () => false)
      }
      const saveGoal = async (goal: string) => {
        if (goal.trim() !== '') {
          await changeHistory($, old => old.map(one => (one.id === entry.id ? { ...one, text: withGoal(one.text, goal) } : one)))
          await say($, 'Goal changed.')
        }
        await update($, isEditingGoal, () => false)
      }

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Button key="copy" hotkey="c" plain variant="primary" label="Copy" onPress={p => void copy($, text, p.surface)} />
              <Button key="clear" hotkey="x" plain label="Clear + carry over" onPress={run(() => carryOver($, text))} />
              <Button key="next" hotkey="n" plain label="Next window" onPress={run(() => saveForNext($, text, false))} />
              <Button key="quit" hotkey="q" plain label="Save + quit" onPress={run(() => saveForNext($, text, true))} />
            </Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Button key="again" hotkey="g" plain dimColor label="Write again" onPress={run(() => write($))} />
              {info.goal !== null && (
                <Button key="edit-goal" hotkey="e" plain dimColor label="Edit goal" onPress={() => update($, isEditingGoal, now => !now)} />
              )}
              {before !== undefined && (
                <Button key="diff" hotkey="d" plain dimColor label={isDiff ? 'Text' : 'Diff'} onPress={() => update($, view, now => (now === 'diff' ? 'text' : 'diff'))} />
              )}
              <Button key="back" hotkey="o" plain dimColor label="Options" onPress={() => update($, phase, () => 'options')} />
            </Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {list.length > 1 && <Button key="older" hotkey="k" plain dimColor label="‹ Older" onPress={run(go(-1))} />}
              {list.length > 1 && <Button key="newer" hotkey="j" plain dimColor label="Newer ›" onPress={run(go(1))} />}
              <Text dimColor>
                {index + 1} of {list.length} · {age}
                {entry.autoAt === null ? '' : ` · auto at ${entry.autoAt}%`}
              </Text>
              <Text color={isOver ? 'red' : undefined} dimColor={!isOver}>
                {text.length.toLocaleString('en-US')}
                {o.cap === null ? ' chars' : ` / ${capLabel(o.cap)}`}
              </Text>
            </Box>
            {noticeRow}
            {rule}
          </Box>
          {isEditing && (
            <Input key="goal-input" label="/goal" value={info.goal ?? ''} submitLabel="Save" autoFocus onSubmit={value => void saveGoal(value)} />
          )}
          {isDiff ? (
            <Code key="diff-view" source={lineDiff(before.text, text)} format="diff" wrap="wrap" />
          ) : (
            <Markdown key="handoff" text={text} />
          )}
        </Box>
      )
    }

    const cycleCap = () =>
      update($, options, old => {
        const at = CAPS.indexOf(old.cap)
        const cap = at === -1 ? DEFAULT_CAP : CAPS[(at + 1) % CAPS.length]
        return { ...old, cap: cap === undefined ? DEFAULT_CAP : cap }
      })
    const toggleReader = () => update($, options, (old): HandoffOptions => ({ ...old, reader: old.reader === 'claude' ? 'agent' : 'claude' }))
    const toggle = (id: SectionId) => () =>
      update($, options, old => ({
        ...old,
        sections: old.sections.includes(id) ? old.sections.filter(s => s !== id) : SECTIONS.map(s => s.id).filter(s => s === id || old.sections.includes(s)),
      }))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button key="write" hotkey="g" plain variant="primary" label="Write handoff" onPress={() => void write($)} />
            {list.length > 0 && (
              <Button key="show" hotkey="v" plain dimColor label={`History (${list.length})`} onPress={() => update($, phase, () => 'ready')} />
            )}
          </Box>
          {noticeRow}
          {rule}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>Length</Text>
          <Button key="cap" hotkey="l" plain label={capLabel(o.cap)} onPress={cycleCap} />
          <Text dimColor>  1,000 → 3,000 → no cap. Any other: /handoff 2500</Text>
        </Box>
        <Box flexDirection="column">
          <Text dimColor>Reader</Text>
          <Button key="reader" hotkey="a" plain label={READERS[o.reader].label} onPress={toggleReader} />
        </Box>
        <Box flexDirection="column">
          <Text dimColor>Include</Text>
          {SECTIONS.map(s => (
            <Button key={s.id} hotkey={s.key} plain label={`${o.sections.includes(s.id) ? '[x]' : '[ ]'} ${s.label}`} onPress={toggle(s.id)} />
          ))}
        </Box>
      </Box>
    )
  })
}
