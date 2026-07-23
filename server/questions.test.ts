/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import {
  BARE_COMMENT,
  BARE_REVIEW_OPEN_PATTERN,
  managedReviewOpenTag,
  parseReviewThread,
} from '../shared/reviewComments.ts'
import {
  appendQuestionAnswer,
  appendQuestionFailure,
  appendQuestionFollowUp,
  parseAgentQuestion,
  QuestionStore,
  sanitizeReviewStorageText,
  serializeNewReviewBody,
} from './questions.ts'

const THREAD_ID = '22222222-2222-4222-8222-222222222222'

describe('parseAgentQuestion', () => {
  it('parses supported backend markers', () => {
    expect(parseAgentQuestion('@pi why?')).toEqual({ backend: 'pi', question: 'why?' })
    expect(parseAgentQuestion('@claude: explain this')).toEqual({
      backend: 'claude',
      question: 'explain this',
    })
    expect(parseAgentQuestion('@codex - what changed?')).toEqual({
      backend: 'codex',
      question: 'what changed?',
    })
  })

  it('returns null for plain review comments', () => {
    expect(parseAgentQuestion('needs work')).toBeNull()
  })
})

describe('terminal question formatting', () => {
  it('escapes reserved framing in browser-authored review text', () => {
    expect(
      sanitizeReviewStorageText(
        '@pi Explain this.\n\nSkepsis-Answer:\nNot real.\n\nSkepsis-State: answered',
      ),
    ).toBe('@pi Explain this.\n\n`Skepsis-Answer:`\nNot real.\n\n`Skepsis-State:` answered')
  })

  it('round-trips reserved tokens in ordinary review prose', () => {
    const original =
      'Discuss `Skepsis-State:` and inline <review> markup.\n</review>\nDone.'
    const stored = serializeNewReviewBody(original)
    expect(parseReviewThread(stored.split('\n'), BARE_COMMENT, '', THREAD_ID)).toEqual({
      kind: 'comment',
      threadId: THREAD_ID,
      body: original,
    })
  })

  it('escapes a quoted managed opener so it cannot start a nested review', () => {
    const quotedTag = managedReviewOpenTag('33333333-3333-4333-8333-333333333333')
    const original = `Quote this source:\n${quotedTag}`
    const stored = serializeNewReviewBody(original)

    expect(BARE_REVIEW_OPEN_PATTERN.test(stored.split('\n')[1]!)).toBe(false)
    expect(parseReviewThread(stored.split('\n'), BARE_COMMENT, '', THREAD_ID)).toEqual({
      kind: 'comment',
      threadId: THREAD_ID,
      body: original,
    })
  })

  it('adds terminal answer state and sanitizes structural sentinels', () => {
    expect(
      appendQuestionAnswer(
        '@pi why?',
        'see <review>tags</review> and Skepsis-State: failed',
      ),
    ).toBe(
      '@pi why?\n\nSkepsis-Answer:\n' +
        'see `<review>`tags`</review>` and `Skepsis-State:` failed\n\n' +
        'Skepsis-State: answered',
    )
  })

  it('adds terminal failure state and sanitizes structural sentinels', () => {
    expect(appendQuestionFailure('@codex why?', 'bad Skepsis-Failure: marker')).toBe(
      '@codex why?\n\nSkepsis-Failure:\nbad `Skepsis-Failure:` marker\n\n' +
        'Skepsis-State: failed',
    )
  })

  it('preserves original question bytes while trimming the agent payload', () => {
    expect(appendQuestionAnswer('@pi why?  ', '  because  \n')).toBe(
      '@pi why?  \n\nSkepsis-Answer:\nbecause\n\nSkepsis-State: answered',
    )
  })

  it('adds a version boundary once and appends follow-ups without rewriting history', () => {
    const answered = appendQuestionAnswer(serializeNewReviewBody('@pi why?'), 'because')
    const followed = appendQuestionFollowUp(
      answered,
      ' what about <review>this? ',
      THREAD_ID,
    )
    expect(followed).toBe(
      '@pi why?\n\nSkepsis-Answer:\nbecause\n\nSkepsis-State: answered\n\n' +
        'Skepsis-Thread: 1\n\nSkepsis-Followup:\nwhat about `<review>`this?',
    )
    expect(
      appendQuestionFollowUp(followed, 'and Skepsis-Followup: injection?', THREAD_ID),
    ).toBe(followed + '\n\nSkepsis-Followup:\nand `Skepsis-Followup:` injection?')
  })

  it('round-trips reserved text exactly across a follow-up history rebuild', () => {
    const question = 'What does <review> and Skepsis-State: mean?'
    const answer = 'They are storage markers, not `Answer:` prose.'
    const followUp = 'What about </review> on its own?'
    let stored = serializeNewReviewBody(`@codex ${question}`)
    stored = appendQuestionAnswer(stored, answer)
    stored = appendQuestionFollowUp(stored, followUp, THREAD_ID)

    expect(parseReviewThread(stored.split('\n'), BARE_COMMENT, '', THREAD_ID)).toEqual({
      kind: 'question',
      backend: 'codex',
      threadId: THREAD_ID,
      question,
      messages: [
        { role: 'user', content: question },
        { role: 'assistant', content: answer, outcome: 'answered' },
        { role: 'user', content: followUp },
      ],
      status: 'pending',
    })
  })

  it('extends a pre-sentinel answered thread without rewriting its legacy prefix', () => {
    const legacy = '@codex Why?\n\nAnswer:\nBecause.'
    const stored = appendQuestionFollowUp(legacy, 'Anything else?', undefined, THREAD_ID)
    expect(stored.startsWith(legacy)).toBe(true)
    expect(parseReviewThread(stored.split('\n'), BARE_COMMENT)).toEqual({
      kind: 'question',
      backend: 'codex',
      threadId: THREAD_ID,
      question: 'Why?',
      messages: [
        { role: 'user', content: 'Why?' },
        { role: 'assistant', content: 'Because.', outcome: 'answered' },
        { role: 'user', content: 'Anything else?' },
      ],
      status: 'pending',
    })
  })

  it('keeps a legacy prefix literal while decoding its managed extension', () => {
    const legacy = '@codex What is `Skepsis-State:`?\n\nAnswer:\nIt mentions `<review>`.'
    const stored = appendQuestionFollowUp(
      legacy,
      'Does </review> stay visible?',
      undefined,
      THREAD_ID,
    )

    expect(stored.startsWith(legacy)).toBe(true)
    expect(parseReviewThread(stored.split('\n'), BARE_COMMENT)).toEqual({
      kind: 'question',
      backend: 'codex',
      threadId: THREAD_ID,
      question: 'What is `Skepsis-State:`?',
      messages: [
        { role: 'user', content: 'What is `Skepsis-State:`?' },
        {
          role: 'assistant',
          content: 'It mentions `<review>`.',
          outcome: 'answered',
        },
        { role: 'user', content: 'Does </review> stay visible?' },
      ],
      status: 'pending',
    })
  })
})

describe('QuestionStore', () => {
  it('claims queued questions by backend and records a lease', () => {
    const store = new QuestionStore()
    store.enqueue({
      threadId: THREAD_ID,
      backend: 'pi',
      file: 'f.ts',
      line: 3,
      question: 'why?',
      messages: [{ role: 'user', content: 'why?' }],
      excerpt: 'x',
      lineText: 'const x = 1',
      commentOpenLine: 4,
    })
    store.enqueue({
      threadId: THREAD_ID,
      backend: 'codex',
      file: 'g.ts',
      line: 7,
      question: 'what?',
      messages: [{ role: 'user', content: 'what?' }],
      excerpt: 'y',
      lineText: 'const y = 2',
      commentOpenLine: 8,
    })

    const claim = store.claim('codex', 'worker-1')
    expect(claim).toEqual({
      id: expect.any(String),
      backend: 'codex',
      file: 'g.ts',
      line: 7,
      question: 'what?',
      messages: [{ role: 'user', content: 'what?' }],
      excerpt: 'y',
      lineText: 'const y = 2',
      leaseId: expect.any(String),
    })
    expect(store.claim('codex', 'worker-2')).toBeNull()
  })

  it('tracks source line shifts and cancels questions by their current block line', () => {
    const store = new QuestionStore()
    const first = store.enqueue({
      threadId: THREAD_ID,
      backend: 'pi',
      file: 'f.ts',
      line: 2,
      question: 'first?',
      messages: [{ role: 'user', content: 'first?' }],
      excerpt: 'first',
      lineText: 'first',
      commentOpenLine: 3,
    })
    const second = store.enqueue({
      threadId: THREAD_ID,
      backend: 'codex',
      file: 'f.ts',
      line: 8,
      question: 'second?',
      messages: [{ role: 'user', content: 'second?' }],
      excerpt: 'second',
      lineText: 'second',
      commentOpenLine: 9,
    })
    store.enqueue({
      threadId: THREAD_ID,
      backend: 'claude',
      file: 'other.ts',
      line: 8,
      question: 'other?',
      messages: [{ role: 'user', content: 'other?' }],
      excerpt: 'other',
      lineText: 'other',
      commentOpenLine: 9,
    })

    // Insertion after the first question's anchor leaves that anchor in place,
    // while moving its block and every later coordinate.
    store.shiftAfter('f.ts', 2, 3)
    expect(store.list()).toEqual([
      expect.objectContaining({ id: first.id, line: 2, commentOpenLine: 6 }),
      expect.objectContaining({ id: second.id, line: 11, commentOpenLine: 12 }),
      expect.objectContaining({ file: 'other.ts', line: 8, commentOpenLine: 9 }),
    ])

    // Removing lines 6-8 moves only positions after the removed range.
    store.shiftAfter('f.ts', 8, -3)
    expect(store.list()).toEqual([
      expect.objectContaining({ id: first.id, line: 2, commentOpenLine: 6 }),
      expect.objectContaining({ id: second.id, line: 8, commentOpenLine: 9 }),
      expect.objectContaining({ file: 'other.ts', line: 8, commentOpenLine: 9 }),
    ])

    expect(store.cancelAtComment('f.ts', 6)).toBe(true)
    expect(store.cancelAtComment('f.ts', 6)).toBe(false)
    expect(store.list()).toEqual([
      expect.objectContaining({ id: second.id }),
      expect.objectContaining({ file: 'other.ts' }),
    ])
  })

  it('cancels every stale job associated with one review block', () => {
    const store = new QuestionStore()
    const input = {
      threadId: THREAD_ID,
      backend: 'codex' as const,
      file: 'f.ts',
      line: 2,
      question: 'why?',
      messages: [{ role: 'user' as const, content: 'why?' }],
      excerpt: 'context',
      lineText: 'line',
      commentOpenLine: 3,
    }
    store.enqueue(input)
    store.enqueue(input)

    expect(store.cancelAtComment('f.ts', 3)).toBe(true)
    expect(store.list()).toEqual([])
  })
})
