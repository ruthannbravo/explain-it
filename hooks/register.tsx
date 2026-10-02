// Explain It: explains Claude's work step by step in plain English, teaching
// a few technical words each time.
// - After a turn that changed or ran things, a band offers "Explain it".
// - It keeps a short journal of each turn's work, so a new session can recap
//   the previous one ("/explain-it last", or the band at session start).
// - Every explanation is saved, so "/explain-it history" rereads old ones.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Saved, Status, Turn } from '../types'

const PANE = 'explain-it'
const RECAP_MODEL = 'sonnet'

// Kept in $.state, not variables, so a reload mid-turn doesn't forget them.
const status = atom({ plugin: 'explain-it', key: 'status' } as const, { kind: 'idle', message: '' })
const saved = atom({ plugin: 'explain-it', key: 'saved' } as const, [])
const viewing = atom({ plugin: 'explain-it', key: 'viewing' } as const, 0)
const hasChanges = atom({ plugin: 'explain-it', key: 'hasChanges' } as const, false)
const hasRecap = atom({ plugin: 'explain-it', key: 'hasRecap' } as const, false)
const didThings = atom({ plugin: 'explain-it', key: 'didThings' } as const, false)
const actions = atom({ plugin: 'explain-it', key: 'actions' } as const, [])
const prompt = atom({ plugin: 'explain-it', key: 'prompt' } as const, '')
const sessionStartedAt = atom({ plugin: 'explain-it', key: 'sessionStartedAt' } as const, 0)
const learnedCount = atom({ plugin: 'explain-it', key: 'learnedCount' } as const, 0)

// Kept in $.store, across sessions.
const LEARNED_KEY = 'learned-terms'
const SAVED_KEY = 'saved-explanations'
const JOURNAL_KEY = 'journal'

const DOING_TOOLS = /^(Bash|Edit|Write|NotebookEdit|MultiEdit)$/

const FORMAT = `Use exactly these headings:

SUMMARY — one sentence on what changed.
STEPS — a bullet-point list (start each line with •), one short sentence per step. No emojis.
THE TECHNICAL VERSION — the same steps again, in the same order, now said the way an engineer would say them, using the real technical terms. Bullet points (start each line with •), each as: technical sentence → in plain words: short plain version. No emojis.
WHY IT MATTERS — one or two sentences.
DO I NEED TO DO ANYTHING? — a clear yes/no, and what to do if yes.
WORDS TO LEARN — 2-4 real technical terms from this work that I'd hear engineers use. One per line, as: term — what it means in everyday words — how it was used here. Pick the most useful ones to know, not the most obscure.

Use no emojis anywhere in your answer. Keep it under 400 words. Only describe what actually happened.`

const NOW_PROMPT = `I'm a designer, not an engineer. Explain what you just did in your most recent work in this conversation, step by step, in plain English. No jargon: if a technical word is unavoidable, explain it in brackets with an everyday comparison. ${FORMAT}`

const RECAP_PROMPT = `I'm a designer, not an engineer. Below is a log of what Claude did for me in an earlier session: what I asked, the files it changed, the commands it ran, and what it told me at the end. Recap that session for me, step by step, in plain English. No jargon: if a technical word is unavoidable, explain it in brackets with an everyday comparison. ${FORMAT}`

const STYLE = [
  { match: /SUMMARY/i, emoji: '📌', color: 'cyan' },
  { match: /STEPS/i, emoji: '👣', color: 'yellow' },
  { match: /TECHNICAL/i, emoji: '🛠️', color: 'red' },
  { match: /WHY/i, emoji: '💡', color: 'green' },
  { match: /DO I NEED/i, emoji: '✅', color: 'magenta' },
  { match: /WORDS/i, emoji: '📚', color: 'blue' },
  { match: /./, emoji: '📝', color: 'white' },
]

// Splits an explanation into its headed sections.
function sections(text: string) {
  const out: { title: string; body: string }[] = []
  for (const line of text.split('\n')) {
    const clean = line.replace(/[*#]/g, '').trim()
    const head = clean.match(/^([A-Z][A-Z '"?,]{3,}?)\s*(?:[—:-]\s*(.*))?$/)
    if (head && STYLE.slice(0, -1).some(s => s.match.test(head[1]))) {
      out.push({ title: head[1].trim(), body: head[2] ?? '' })
    } else if (out.length && clean) {
      const last = out[out.length - 1]
      last.body = last.body ? `${last.body}\n${clean}` : clean
    }
  }
  return out.length ? out : [{ title: 'What happened', body: text }]
}

// Pulls the terms out of the WORDS TO LEARN section.
function newTerms(text: string) {
  const words = sections(text).find(s => /WORDS/i.test(s.title))
  if (!words) return []
  return words.body
    .split('\n')
    .map(l => l.replace(/^[-•\d.\s]+/, '').split(/\s[—–-]\s/)[0].trim())
    .filter(t => t.length > 0 && t.length < 40)
}

function listOf<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

function projectName(cwd: string) {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

function when(at: number) {
  return new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Terms already learned: used freely, not redefined, so each explanation
// teaches something new.
async function learnedTerms($: EngineInterface): Promise<string[]> {
  return listOf<unknown>(await $.store.get(LEARNED_KEY)).filter((t): t is string => typeof t === 'string')
}

function withLearned(base: string, learned: string[]) {
  if (learned.length === 0) return base
  return `${base}

Terms I already know (use them freely without defining them, and don't pick them for WORDS TO LEARN): ${learned.join(', ')}.`
}

// The turns of the most recent earlier session, oldest first.
async function previousSession($: EngineInterface) {
  const started = await read($, sessionStartedAt)
  const journal = listOf<Turn>(await $.store.get(JOURNAL_KEY)).filter(t => t.session !== started)
  if (journal.length === 0) return []
  const last = journal[journal.length - 1].session
  return journal.filter(t => t.session === last)
}

function logOf(turns: Turn[]) {
  return turns
    .map(
      (t, i) =>
        `--- Turn ${i + 1} (${when(t.at)}, project: ${t.project})\nI asked: ${t.prompt}\nWhat Claude did:\n${t.actions.map(a => `- ${a}`).join('\n')}\nClaude's reply: ${t.answer}`,
    )
    .join('\n\n')
}

// Writes an explanation, saves it, and shows it in the pane.
async function explain($: EngineInterface, mode: 'now' | 'last') {
  await update($, hasChanges, () => false)
  await update($, hasRecap, () => false)
  await update($, status, () => ({ kind: 'writing', message: '' }) as Status)
  const opened = $.ui.open({ id: PANE, title: 'Explain it' })

  const learned = await learnedTerms($)
  let label = 'This session'
  let project = projectName(await $.session.cwd())
  let r
  if (mode === 'last') {
    const turns = await previousSession($)
    if (turns.length === 0) {
      await update($, status, () => ({
        kind: 'failed',
        message: "No earlier session recorded yet. Explain It starts keeping a journal from now on, so next time there'll be one to recap.",
      }) as Status)
      return
    }
    label = `Recap of ${when(turns[0].at)}`
    project = turns[turns.length - 1].project
    r = await $.model.complete({ model: RECAP_MODEL, prompt: `${withLearned(RECAP_PROMPT, learned)}\n\n${logOf(turns)}` })
  } else {
    r = await $.model.fork({ prompt: withLearned(NOW_PROMPT, learned) })
  }
  if (!(await opened).isPlaced) $.ui.toast('Explanation is ready — widen the window or type /explain-it history')

  if (!r.isAnswered) {
    await update($, status, () => ({
      kind: 'failed',
      message: `Couldn't explain it (${r.reason}). Try again.`,
    }) as Status)
    return
  }

  const entry: Saved = { at: Date.now(), project, label, text: r.text }
  const all = [...listOf<Saved>(await $.store.get(SAVED_KEY)), entry].slice(-50)
  await $.store.set(SAVED_KEY, all)
  await update($, saved, () => all)
  await update($, viewing, () => all.length - 1)
  await update($, status, () => ({ kind: 'idle', message: '' }) as Status)

  const known = new Set(learned.map(t => t.toLowerCase()))
  const added = newTerms(r.text).filter(t => !known.has(t.toLowerCase()))
  if (added.length) {
    const terms = [...learned, ...added].slice(-300)
    await $.store.set(LEARNED_KEY, terms)
    await update($, learnedCount, () => terms.length)
  }
}

function start($: EngineInterface, mode: 'now' | 'last') {
  explain($, mode).catch(err =>
    update($, status, () => ({ kind: 'failed', message: `Couldn't explain it (${String(err)}). Try again.` }) as Status),
  )
}

async function showHistory($: EngineInterface) {
  const all = await read($, saved)
  await update($, viewing, () => Math.max(0, all.length - 1))
  await update($, status, () => ({ kind: 'idle', message: '' }) as Status)
  await $.ui.open({ id: PANE, title: 'Explain it' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, sessionStartedAt, () => Date.now())
    const learned = await learnedTerms($)
    await update($, learnedCount, () => learned.length)
    const all = listOf<Saved>(await $.store.get(SAVED_KEY))
    await update($, saved, () => all)
    await update($, hasRecap, () => false)
    if ((await previousSession($)).length > 0) await update($, hasRecap, () => true)
    await $.command.register({
      name: 'explain-it',
      description: 'Explain Claude\'s work in plain English. Add "last" to recap the previous session, or "history" to reread old ones',
    })
    return result
  })

  on('command.run', { command: 'explain-it' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'history') {
      await showHistory($)
      return { text: 'Opened your saved explanations.' }
    }
    const mode = arg === 'last' ? 'last' : 'now'
    start($, mode)
    return { text: mode === 'last' ? 'Recapping your previous session in the side pane.' : 'Explaining in the side pane.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, didThings, () => false)
    await update($, hasChanges, () => false)
    await update($, hasRecap, () => false)
    await update($, actions, () => [])
    await update($, prompt, () => e.text.slice(0, 500))
    return next(e)
  })

  // Main conversation only; helpers (subagents) report back through it.
  on('tool.call', async ($, e, next) => {
    if (!e.agentId && DOING_TOOLS.test(e.tool)) {
      await update($, didThings, () => true)
      const input = e as unknown as { command?: unknown; file_path?: unknown; notebook_path?: unknown }
      const what =
        e.tool === 'Bash'
          ? `Ran a command: ${String(input.command ?? '').slice(0, 200)}`
          : `Changed a file: ${String(input.file_path ?? input.notebook_path ?? '')}`
      await update($, actions, list => [...list, what].slice(-40))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || !(await read($, didThings))) return result
    await update($, hasChanges, () => true)
    const turn: Turn = {
      at: Date.now(),
      session: await read($, sessionStartedAt),
      project: projectName(await $.session.cwd()),
      prompt: await read($, prompt),
      actions: await read($, actions),
      answer: result.text.slice(0, 1500),
    }
    const journal = [...listOf<Turn>(await $.store.get(JOURNAL_KEY)), turn].slice(-200)
    await $.store.set(JOURNAL_KEY, journal)
    return result
  })

  // A small offer above the prompt: explain what just happened, or recap last time.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (await read($, hasChanges)) {
      return (
        <Box>
          <Text color="cyan">🧩 Not sure what just happened? </Text>
          <Button key="explain" label="Explain it" hotkey="e" onPress={() => start($, 'now')} />
          <Button key="dismiss" label="No thanks" onPress={() => update($, hasChanges, () => false)} />
        </Box>
      )
    }
    if (await read($, hasRecap)) {
      return (
        <Box>
          <Text color="cyan">🧩 Want a recap of what Claude did last time? </Text>
          <Button key="recap" label="Recap" hotkey="r" onPress={() => start($, 'last')} />
          <Button key="dismiss" label="No thanks" onPress={() => update($, hasRecap, () => false)} />
        </Box>
      )
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, status)
    const all = await read($, saved)
    const i = Math.min(await read($, viewing), all.length - 1)
    const shown = all[i]
    // A thin line between sections, as wide as the pane allows.
    const rule = '─'.repeat(Math.max(10, Math.min(40, (e.viewport?.columns ?? 40) - 6)))

    if (s.kind !== 'idle' || !shown) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color="cyan">🧩 Explain it</Text>
          <Text dimColor>
            {s.kind === 'writing'
              ? '✨ Putting it in plain English…'
              : s.kind === 'failed'
                ? s.message
                : 'Nothing explained yet. Type /explain-it, or /explain-it last to recap your previous session.'}
          </Text>
          {all.length > 0 && <Button key="history" label="📖 Saved explanations" onPress={() => void showHistory($)} />}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">🧩 {shown.label}</Text>
        <Box marginBottom={1}><Text dimColor>
          {shown.project} · {when(shown.at)} · {i + 1} of {all.length}
        </Text></Box>
        {sections(shown.text).map(({ title, body }, n) => {
          const look = STYLE.find(st => st.match.test(title)) ?? STYLE[STYLE.length - 1]
          return (
            <Box key={`s${n}`} flexDirection="column">
              {n > 0 && <Text dimColor>{rule}</Text>}
              <Text bold color={look.color}>{look.emoji} {title}</Text>
              <Box marginBottom={1}><Text>{body}</Text></Box>
            </Box>
          )
        })}
        <Text dimColor>📚 Words you've learned so far: {await read($, learnedCount)}</Text>
        <Box>
          {i > 0 && <Button key="older" label="◀ Older" onPress={() => update($, viewing, v => Math.max(0, v - 1))} />}
          {i < all.length - 1 && (
            <Button key="newer" label="Newer ▶" onPress={() => update($, viewing, v => Math.min(all.length - 1, v + 1))} />
          )}
          <Button key="again" label="🔄 Explain latest" onPress={() => start($, 'now')} />
        </Box>
      </Box>
    )
  })
}
