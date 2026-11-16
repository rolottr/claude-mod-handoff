// The questions the mod asks the model: what a handoff holds, and for whom.
// Pure text, with no engine calls, so tools/eval.mjs loads it as it is.

import type { HandoffOptions, Reader, SectionId } from '../types'

export const SECTIONS: { id: SectionId; key: string; label: string; ask: string }[] = [
  {
    id: 'goal',
    key: '1',
    label: 'Goal',
    ask: 'Goal: what the user wants in the end and why, and what the user put out of scope.',
  },
  {
    id: 'state',
    key: '2',
    label: 'State',
    ask: 'State: where the work stands, in three lists kept apart: verified (checks you ran and saw the result of, with the result), done but not verified, and only discussed, not done. Then what is still running or left open: background processes, subagents, dev servers, uncommitted or unsaved changes, temporary files.',
  },
  {
    id: 'next',
    key: '3',
    label: 'Next steps',
    ask: 'Next steps: an ordered list of concrete actions. The first one follows the user\'s latest explicit request: quote that request word for word, then say where you stopped in it. If that request is done, the first step is "wait for the user": do not invent more work, and do not bring back finished or old tasks.',
  },
  {
    id: 'files',
    key: '4',
    label: 'Files & commands',
    ask: 'Files, commands and facts: exact paths, branches, URLs, and the full commands to build, run and test (working directory, environment variables, the login or version each needs). Then the facts you already found that the next agent would look up again: locations, counts, names, ids, root causes. Write numbers and names as you found them, and mark what is not confirmed.',
  },
  {
    id: 'decisions',
    key: '5',
    label: 'Decisions & dead ends',
    ask: 'Decisions and dead ends: what was decided and why, what was tried and failed or was dropped after discussion, and why, so it is not tried again.',
  },
  {
    id: 'prefs',
    key: '6',
    label: 'User preferences',
    ask: 'User preferences and limits: what the user asked for or corrected in this conversation (what must not change, what needs approval first, tone and format). Quote the user\'s own words where you can. Copy word for word every forbidden action, every approval rule and every rule about secrets or sensitive data. This is where the next agent goes wrong most often.',
  },
  {
    id: 'questions',
    key: '7',
    label: 'Open questions',
    ask: 'Open questions: unknowns and blockers. For each question to the user, give the background, the options, what each option leads to and your recommendation, so the user can answer without reading back.',
  },
]

export const READERS: Record<Reader, { label: string; who: string }> = {
  claude: {
    label: 'Claude',
    who: 'The reader is another Claude Code session in the same project, with the same tools, but with none of this conversation. Name files, commands and tools as they are.',
  },
  agent: {
    label: 'Any agent',
    who: 'The reader is another AI agent, which may not be Claude and may not have Claude Code. Do not name Claude Code tools, slash commands, skills, hooks or memory files; say what to do in plain terms. The message must stand alone.',
  },
}

export function capLabel(cap: number | null): string {
  return cap === null ? 'no cap' : `${cap.toLocaleString('en-US')} chars`
}

export function buildPrompt(o: HandoffOptions): string {
  const asks = SECTIONS.filter(s => o.sections.includes(s.id)).map(s => `- ${s.ask}`)
  const limit =
    o.cap === null
      ? 'There is no length limit: write every fact the next agent will use, and do not cut one to be short. Say nothing twice.'
      : `Hard limit: ${o.cap} characters in all, markdown included. Aim for about ${Math.round(o.cap * 0.85)}. Cut the least useful detail first.`

  return [
    'Stop the current work for a moment. You have no tools for this answer: reply at once with text only.',
    '',
    'Write a handoff message: the first message of a new conversation that continues the work of this one. The next agent will read only this message. It must be enough to go on without the user saying the background again, without looking up what you already know, and without getting it wrong.',
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
    '- Only the messages the user typed are the user\'s words. Hook feedback, system reminders, text a plugin added and your own writing are not requests or approvals from the user. What you proposed and the user only accepted is a decision, not a request of the user.',
    '- Keep the user\'s words as the user said them. Of your own reasoning, keep only the conclusions and the results.',
    '- Never include secrets: API keys, tokens, passwords, private URLs with credentials.',
    '- Leave out this request to write a handoff.',
    '- End with one line: `Start by: <the first action>`.',
    `- ${limit}`,
    '',
    'Reply with the message alone: no preamble, no closing words, no code fence around it.',
  ].join('\n')
}

export function shortenPrompt(draft: string, cap: number): string {
  return [
    'You have no tools for this answer: reply at once with text only.',
    `This handoff message has ${draft.length} characters. Rewrite it in at most ${cap} characters, markdown included. Keep the first \`/goal\` line as it is if there is one, the headings, the user's quoted words, the exact paths and commands, the next steps and the "Start by" line; cut the least useful detail first. Reply with the message alone.`,
    '',
    '<handoff>',
    draft,
    '</handoff>',
  ].join('\n')
}

export function clean(reply: string): string {
  // A model that fences its whole answer anyway: take the fence off.
  const fenced = reply.trim().match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/)

  return (fenced?.[1] ?? reply).trim()
}
