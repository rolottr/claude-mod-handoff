export type SectionId = 'goal' | 'state' | 'next' | 'files' | 'decisions' | 'prefs' | 'questions'

export type Reader = 'claude' | 'agent'

export type HandoffOptions = {
  /** Most characters the message may have; null is no cap. */
  cap: number | null
  reader: Reader
  sections: SectionId[]
}

export type HandoffPhase = 'options' | 'writing' | 'ready'

/** One written handoff, kept per project. */
export type HandoffEntry = {
  id: number
  text: string
  createdAt: number
  sessionId: string
  /** Written in the background when the context filled up, at this percent. */
  autoAt: number | null
}

/** A handoff that came in with a /goal: the goal line and the rest. */
export type Carried = { goal: string; text: string }

/** A handoff saved for the next session started in the same project. */
export type PendingHandoff = {
  text: string
  root: string
  sessionId: string
  createdAt: number
}

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      options: Shaped<HandoffOptions>
      phase: HandoffPhase
      /** This project's handoffs, oldest first. */
      history: Shaped<HandoffEntry[]>
      /** The index shown in the pane; -1 is the newest. */
      shown: number
      view: 'text' | 'diff'
      isEditingGoal: boolean
      notice: string | null
      /** The context window's fill, in percent, as last measured. */
      context: number | null
      /** The fill at which the person said "Later"; the band waits 10 points past it. */
      laterAt: number | null
      /** The fill at which the last background handoff was written. */
      autoAt: number | null
      /** A handoff is being written in the background. */
      isAutoWriting: boolean
      /** The handoff the last /goal carried to the model, shown as a card above the prompt until the next prompt. */
      arrived: Carried | null
    }
  }
}
