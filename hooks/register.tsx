import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { Carried, HandoffEntry, HandoffOptions, PendingHandoff, SectionId } from '../types'
import { buildPrompt, capLabel, clean, READERS, SECTIONS, shortenPrompt } from './prompt'
import { ago, isHandoff, lineDiff, parse, splitGoal, withGoal } from './text'

const PANE = 'handoff'
const COMMAND = 'handoff'
const WIDTH = 76
const MIN_WIDTH = 48

// Length presets, cycled with `l`. Any other cap comes from `/handoff <n>`.
// No cap is the default: a cap cuts what the next session needs most (the
// user's limits, the background of open questions, facts already found).
const CAPS: (number | null)[] = [null, 1000, 3000]
const DEFAULT_CAP: number | null = null

// The context fill, in percent, that shows the status entry, and the one
// that shows the band and writes a handoff in the background. Another
// background handoff is written each 10 points past the last.
const STATUS_AT = 50
const BAND_AT = 70
const AUTO_STEP = 10

// A background handoff waits while background work is still running, so it
// is not written mid-flight; past this fill it is written anyway.
const DEFER_UNTIL = 90

// A fork cannot be cancelled: past this the mod stops waiting for it.
const WRITE_TIMEOUT_MS = 5 * 60 * 1000

// The statuses of a background task that is over.
const STOPPED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error'])

// Handoffs kept per project.
const KEPT = 20

// A saved handoff waits this long for the next window, then is dropped.
const PENDING_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

const DEFAULT_OPTIONS: HandoffOptions = {
  cap: DEFAULT_CAP,
  reader: 'claude',
  sections: SECTIONS.map(s => s.id),
}

const options = atom({ plugin: 'handoff', key: 'options' } as const, DEFAULT_OPTIONS, { shape: 'options-2' })
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
const turn = atom({ plugin: 'handoff', key: 'turn' } as const, null as number | null)
const waitingOn = atom({ plugin: 'handoff', key: 'waitingOn' } as const, null as number | null)
const failed = atom({ plugin: 'handoff', key: 'failed' } as const, null as string | null)

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

/**
 * How many turns the conversation went on after this session wrote `entry`:
 * 0 for a handoff that still holds it all, or one of another session.
 */
function behind(entry: HandoffEntry, sessionId: string, now: number | null): number {
  if (entry.sessionId !== sessionId || entry.turns === undefined || now === null) {
    return 0
  }

  return Math.max(0, now - entry.turns)
}

type Fork = Awaited<ReturnType<EngineInterface['model']['fork']>>
type Answer = Fork | { isAnswered: false; reason: 'timeout' }

/** One question over the conversation, given up on after WRITE_TIMEOUT_MS. */
async function ask($: EngineInterface, prompt: string): Promise<Answer> {
  let timer: Timer | undefined
  const late = new Promise<Answer>(resolve => {
    timer = $.clock.after(WRITE_TIMEOUT_MS, () => resolve({ isAnswered: false, reason: 'timeout' }))
  })
  try {
    return await Promise.race([$.model.fork({ prompt }), late])
  } finally {
    timer?.cancel()
  }
}

function whyNot(reply: Exclude<Answer, { isAnswered: true }>): string {
  return reply.reason === 'nothing-to-fork'
    ? 'there is no conversation to hand off yet (or it was just cleared).'
    : reply.reason === 'api-error'
      ? `the API answered ${reply.status ?? 'with an error'}.`
      : reply.reason === 'aborted'
        ? 'it was interrupted.'
        : reply.reason === 'timeout'
          ? 'it took more than 5 minutes.'
          : 'the model gave no text.'
}

// One write at a time, whether the person asked or the context filled up.
let isBusy = false

// Background tasks and one-shot schedules still to come, as the last stop
// of the main conversation reported them.
let inFlight = 0

/**
 * Writes a handoff from this conversation and adds it to the history.
 * `autoPercent` marks one written in the background: it leaves the pane's
 * phase alone, and a failure shows on the band, not as a notice.
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
    // The turns the conversation had when the question was asked: a turn
    // that ends while it is answered is not in the handoff.
    const turns = await $.session.turns()
    let reply = await ask($, buildPrompt(o))
    if (reply.isAnswered && o.cap !== null && clean(reply.text).length > o.cap) {
      const longer = clean(reply.text)
      const shorter = await ask($, shortenPrompt(longer, o.cap))
      reply = shorter.isAnswered && clean(shorter.text).length < longer.length ? shorter : reply
    }

    if (!reply.isAnswered) {
      const why = whyNot(reply)
      if (isAuto) {
        await update($, failed, () => why)
      } else {
        const hasAny = (await read($, history)).length > 0
        await update($, phase, () => (hasAny ? 'ready' : 'options'))
        await say($, `Could not write the handoff: ${why}`)
      }

      return
    }

    const text = clean(reply.text)
    const createdAt = await $.clock.now()
    const sessionId = await $.session.id()
    await changeHistory($, list => [...list, { id: (list[list.length - 1]?.id ?? 0) + 1, text, createdAt, sessionId, autoAt: autoPercent, turns }])
    await update($, failed, () => null)
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
  const newest = pick(await read($, history), -1)
  if ((await read($, phase)) !== 'writing') {
    await update($, phase, () => (newest === undefined ? 'options' : 'ready'))
  }
  await update($, shown, () => -1)
  const opened = await openPane($)

  // The conversation went on since the newest was written: write it again
  // now, so what is carried over holds the last turns too.
  if (newest !== undefined && !isBusy && behind(newest.entry, await $.session.id(), await read($, turn)) > 0) {
    void write($)
  }

  return opened
}

async function runningAgents($: EngineInterface): Promise<number> {
  try {
    return (await $.agent.list()).filter(a => a.status === 'running').length
  } catch {
    return 0
  }
}

/**
 * Past BAND_AT, writes a handoff in the background, and another each
 * AUTO_STEP points. While background work is running it waits, so the
 * handoff is not written with results still to come.
 */
async function autoCheck($: EngineInterface): Promise<void> {
  const percent = await read($, context)
  if (percent === null || percent < BAND_AT) {
    return
  }
  const last = await read($, autoAt)
  if (isBusy || (last !== null && percent < last + AUTO_STEP)) {
    await update($, waitingOn, () => null)

    return
  }
  const running = inFlight + (await runningAgents($))
  if (running > 0 && percent < DEFER_UNTIL) {
    await update($, waitingOn, () => running)

    return
  }
  await update($, waitingOn, () => null)
  await update($, autoAt, () => percent)
  void write($, percent)
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

// Forgets the context's fill: the status entry, the band, and the
// thresholds the background handoffs count from.
async function resetFill($: EngineInterface): Promise<void> {
  await update($, context, () => null)
  await update($, autoAt, () => null)
  await update($, laterAt, () => null)
  await update($, waitingOn, () => null)
  await update($, failed, () => null)
  $.ui.status(undefined)
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

  // A /clear ends the conversation with no session.start after it, and the
  // next session.measure only comes once the new window's first turn ends:
  // drop the old fill now, so the status line and the band go with it.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await resetFill($)
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await resetFill($)

    return result
  })

  // After each turn: the context's fill on the status line, and past
  // BAND_AT a handoff written in the background, so it is ready when the
  // person asks for it.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.context.percent === undefined) {
      // No response in this window yet: what was shown is an older window's.
      await resetFill($)

      return result
    }
    const percent = Math.round(e.context.percent)
    await update($, context, () => percent)
    const turns = await $.session.turns()
    await update($, turn, () => turns)
    $.ui.status(percent >= STATUS_AT ? `ctx ${percent}%` : undefined)

    if (percent < BAND_AT) {
      // A /clear or a compaction emptied it: start over.
      await update($, autoAt, () => null)
      await update($, laterAt, () => null)
      await update($, waitingOn, () => null)

      return result
    }
    await autoCheck($)

    return result
  })

  // Each stop of the main conversation says what background work is still
  // to come; a background handoff waits for it.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id === undefined) {
      const tasks = (e.background_tasks ?? []).filter(t => !STOPPED.has(t.status)).length
      const wakeups = (e.session_crons ?? []).filter(c => !c.recurring).length
      inFlight = tasks + wakeups
      await autoCheck($)
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
      const sessionId = await $.session.id()
      const isFresh =
        newest !== undefined &&
        newest.entry.autoAt !== null &&
        newest.entry.sessionId === sessionId &&
        behind(newest.entry, sessionId, await read($, turn)) === 0
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

  // The band above the prompt, once the context passes BAND_AT. Its keys are
  // digits: a digit typed in an empty prompt box presses a band Button, and
  // a letter does so only once the band has the keyboard. They are 9 and 0
  // because a hotkey is the mod's, not the site's: with the pane open, a
  // band key the pane also uses (1 to 7, the parts) takes the pane's press.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A handoff that just came in with a /goal: its card, until the next
    // prompt. The /goal row itself is the engine's alone.
    const came = await read($, arrived)
    if (came !== null && !e.props.hasSurvey) {
      const { Box, Button } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          {card($, e, came.text, `goal set: ${came.goal}`)}
          <Button key="hide-card" hotkey="0" plain dimColor label="Hide" onPress={() => update($, arrived, () => null)} />
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
    const sessionId = await $.session.id()
    const isMine = newest !== undefined && newest.entry.autoAt !== null && newest.entry.sessionId === sessionId
    const old = newest === undefined ? 0 : behind(newest.entry, sessionId, await read($, turn))
    const waiting = await read($, waitingOn)
    const why = await read($, failed)
    const state = isWriting
      ? 'writing a handoff…'
      : waiting !== null
        ? `waiting for ${waiting} background ${waiting === 1 ? 'task' : 'tasks'} before writing`
        : why !== null
          ? `the handoff was not written: ${why}`
          : isMine && old === 0
            ? 'a handoff is ready'
            : isMine
              ? `the handoff is ${old} ${old === 1 ? 'turn' : 'turns'} old: 9 writes a new one`
              : 'time to hand off'

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text color={percent >= 85 ? 'red' : 'yellow'}>● Context {percent}%</Text>
        <Text key="band-state" dimColor={why === null || isWriting || waiting !== null} color={why !== null && !isWriting && waiting === null ? 'red' : undefined}>
          {state}
        </Text>
        <Button key="handoff" hotkey="9" plain variant="primary" label="Hand off" onPress={() => void openOnNewest($)} />
        <Button key="later" hotkey="0" plain dimColor label="Later" onPress={() => update($, laterAt, () => percent)} />
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
    const { Box, Button, Code, Input, Markdown, Progress, Text } = $.ui.resolve(e)
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
          <Progress key="writing" label={`Writing the handoff from this conversation (${capLabel(o.cap)}, for ${READERS[o.reader].label})`} />
          <Text dimColor>
            {o.cap === null ? 'With no cap this can take a minute or two.' : 'This takes a few seconds.'} You can close the pane; the result waits here.
          </Text>
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
      const old = behind(entry, await $.session.id(), await read($, turn))
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
            {old > 0 && (
              <Text key="stale" color="yellow">
                Written {old} {old === 1 ? 'turn' : 'turns'} ago: the conversation went on since. g writes it again.
              </Text>
            )}
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
          <Text dimColor>  no cap → 1,000 → 3,000. Any other: /handoff 2500</Text>
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
