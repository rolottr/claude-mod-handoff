import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const ROOT = '/work/app'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const HANDOFF = '# Handoff: ship the mod\n\n## Next steps\n1. Run the tests.\n\nStart by: running the tests.'
const WITH_GOAL = `/goal all tests pass\n${HANDOFF}`

const PANE = {
  plugin: 'handoff',
  component: 'Pane',
  requestId: 'handoff',
  props: {
    title: 'Handoff',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'handoff',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

// A store the test can read back.
function store(on: On, entries: Record<string, unknown> = {}) {
  const kept = new Map<string, unknown>(Object.entries(entries))
  on('store.get', (_, e) => ({ value: kept.get(e.key) }))
  on('store.set', (_, e) => {
    kept.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    kept.delete(e.key)
    return { value: undefined }
  })

  return kept
}

// The engine beneath the mod: a session in ROOT whose forks answer `replies`
// in turn (the last one again when they run out).
function engine(on: On, { replies = [HANDOFF], sessionId = 'one', entries = {} }: { replies?: string[]; sessionId?: string; entries?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on)
  const kept = store(on, entries)
  const asked: string[] = []
  const filled: string[] = []
  const status: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'handoff' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: sessionId }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('model.fork', (_, e) => {
    asked.push(e.prompt)
    const text: string = replies[Math.min(asked.length, replies.length) - 1] ?? HANDOFF
    return { value: { isAnswered: true, text, usage: USAGE } }
  })
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.paint', (_, e) => ({ value: { isPainted: true, text: e.text ?? '', cursor: 0 } }))

  return { clock, kept, asked, filled, status }
}

const start = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' = 'terminal') =>
  $.session.start({ cwd: ROOT, surface, isInteractive: true })

const run = (args: string) => ({ command: 'handoff', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`writes a handoff with the chosen options and copies it (${surface})`, async ($, on) => {
    const { asked, kept } = engine(on)
    const copied: string[] = []
    on('ui.copy', (_, e) => {
      copied.push(e.text)
      return { value: { isCopied: true } }
    })

    await start($, surface)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ key: 'write' }))?.text).toContain('Write handoff')
    expect((await ui.find({ key: 'cap' }))?.text).toContain('3,000 chars')
    await ui.press({ key: 'cap' })
    expect((await ui.find({ key: 'cap' }))?.text).toContain('no cap')
    await ui.press({ key: 'reader' })
    expect((await ui.find({ key: 'reader' }))?.text).toContain('Any agent')
    await ui.press({ key: 'prefs' })

    await ui.press({ key: 'write' })
    expect(asked[0]).toContain('no length limit')
    expect(asked[0]).toContain('may not be Claude')
    expect(asked[0]).not.toContain('User preferences:')
    expect(asked[0]).toContain('The very first line is `/goal <condition>`')

    await ui.press({ key: 'copy' })
    expect(copied).toEqual([HANDOFF])
    expect((kept.get(`history:${ROOT}`) as { text: string }[]).map(h => h.text)).toEqual([HANDOFF])
    await ui.unmount()
  })
}

test('a handoff over the cap is shortened once; Goal off leaves out /goal', async ($, on) => {
  const { asked } = engine(on, { replies: ['x'.repeat(1500), 'short'] })

  await start($)
  await $.command.run(run('1000'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'goal' })
  await ui.press({ key: 'write' })

  expect(asked[0]).not.toContain('/goal')
  expect(asked).toHaveLength(2)
  expect(asked[1]).toContain('at most 1000 characters')
  expect(await ui.find({ type: 'Text', text: /5 \/ 1,000 chars/ })).toBeDefined()
  await ui.unmount()
})

test('past 70% the band shows, and a handoff is written in the background', async ($, on) => {
  const { asked, status, clock } = engine(on)

  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'handoff' })).toBeUndefined()

  await $.session.measure({ context: { window: 200000, percent: 55 }, rateLimits: [], changed: ['context'] })
  expect(status.at(-1)).toBe('ctx 55%')
  expect(asked).toHaveLength(0)

  await $.session.measure({ context: { window: 200000, percent: 74 }, rateLimits: [], changed: ['context'] })
  await clock.advance(10)
  expect(asked).toHaveLength(1)
  expect((await band.find({ type: 'Text', text: /Context 74%/ }))?.text).toContain('74%')
  expect(await band.find({ type: 'Text', text: /a handoff is ready/ })).toBeDefined()

  // The same fill again writes nothing; 10 points more writes a new one.
  await $.session.measure({ context: { window: 200000, percent: 78 }, rateLimits: [], changed: ['context'] })
  await clock.advance(10)
  expect(asked).toHaveLength(1)
  await $.session.measure({ context: { window: 200000, percent: 85 }, rateLimits: [], changed: ['context'] })
  await clock.advance(10)
  expect(asked).toHaveLength(2)

  // Later hides it until 10 points more.
  await band.press({ key: 'later' })
  expect(await band.find({ key: 'handoff' })).toBeUndefined()
  await band.unmount()
})

test('a handoff in the transcript is drawn as a card', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({
    plugin: 'handoff',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: HANDOFF, origin: { kind: 'composer' }, isExpanded: false },
  })

  expect(await ui.find({ type: 'Text', text: /↪ Handoff/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /running the tests/ }))?.text).toContain('Start by: running the tests.')
  await ui.unmount()
})

test('a /goal prompt that holds a handoff sets the goal line and carries the rest to the model', async ($, on) => {
  engine(on)
  const goals: string[] = []
  const context: string[] = []
  on('command.run', (_, e) => {
    goals.push(e.args)
    return { text: 'Goal set: all tests pass' }
  })
  on('prompt.submit', (_, e) => {
    context.push(...(e.context ?? []))
    return { text: e.text }
  })

  await start($)
  await $.command.run({ command: 'goal', args: WITH_GOAL.slice('/goal '.length), origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(goals).toEqual(['all tests pass'])

  // The turn /goal starts carries the rest of the handoff.
  await $.prompt.submit({ text: '/goal all tests pass', command: { name: 'goal', args: 'all tests pass' } } as Parameters<typeof $.prompt.submit>[0])
  expect(context.at(-1)).toContain(HANDOFF)

  // The band shows the handoff's card until the next prompt.
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /↪ Handoff/ })).toBeDefined()
  expect((await band.find({ type: 'Text', text: /goal set/ }))?.text).toContain('all tests pass')
  await band.press({ key: 'hide-card' })
  expect(await band.find({ type: 'Text', text: /↪ Handoff/ })).toBeUndefined()
  await band.unmount()
})

test('history: older, newer, diff, and editing the goal', async ($, on) => {
  const second = WITH_GOAL.replace('Run the tests.', 'Run the tests twice.')
  const { kept } = engine(on, { replies: [WITH_GOAL, second] })

  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'write' })
  await ui.press({ key: 'again' })
  expect(await ui.find({ type: 'Text', text: /2 of 2/ })).toBeDefined()

  await ui.press({ key: 'diff' })
  const diff = await ui.find({ type: 'Code' })
  expect(diff?.text).toContain('+1. Run the tests twice.')
  expect(diff?.text).toContain('-1. Run the tests.')
  await ui.press({ key: 'diff' })

  await ui.press({ key: 'older' })
  expect(await ui.find({ type: 'Text', text: /1 of 2/ })).toBeDefined()

  await ui.press({ key: 'edit-goal' })
  await ui.input({ key: 'goal-input', text: 'the CSV total matches the bank' })
  const list = kept.get(`history:${ROOT}`) as { text: string }[]
  expect(list[0]?.text.split('\n')[0]).toBe('/goal the CSV total matches the bank')
  expect(list[1]?.text).toBe(second)
  await ui.unmount()
})

test('a handoff saved for the next window fills the next session prompt once', async ($, on) => {
  const { clock, kept, filled } = engine(on, {
    sessionId: 'later',
    entries: { [`pending:${ROOT}`]: { text: WITH_GOAL, root: ROOT, sessionId: 'earlier', createdAt: 0 } },
  })

  await start($)
  await clock.advance(1000)

  expect(filled).toEqual([WITH_GOAL])
  expect(kept.has(`pending:${ROOT}`)).toBe(false)
})

test('the session that saved a handoff does not take it back', async ($, on) => {
  const { clock, kept, filled } = engine(on, {
    sessionId: 'same',
    entries: { [`pending:${ROOT}`]: { text: HANDOFF, root: ROOT, sessionId: 'same', createdAt: 0 } },
  })

  await start($)
  await clock.advance(1000)

  expect(filled).toEqual([])
  expect(kept.has(`pending:${ROOT}`)).toBe(true)
})
