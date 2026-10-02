export type Status = { kind: 'idle' | 'writing' | 'failed'; message: string }
/** One explanation, kept across sessions so it can be reread later. */
export type Saved = { at: number; project: string; label: string; text: string }
/** What one turn of work did, kept so a later session can recap it. */
export type Turn = { at: number; session: number; project: string; prompt: string; actions: string[]; answer: string }

declare module 'claude-code' {
  interface PluginState {
    'explain-it': {
      status: Status
      saved: Saved[]
      viewing: number
      hasChanges: boolean
      hasRecap: boolean
      didThings: boolean
      actions: string[]
      prompt: string
      sessionStartedAt: number
      learnedCount: number
    }
  }
}
