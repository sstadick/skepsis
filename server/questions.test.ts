/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import { appendQuestionAnswer, parseAgentQuestion, QuestionStore } from './questions.ts'

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

describe('appendQuestionAnswer', () => {
  it('adds an answer section and sanitizes review tags', () => {
    expect(appendQuestionAnswer('@pi why?', 'see <review>tags</review>')).toBe(
      '@pi why?\n\nAnswer:\nsee `<review>`tags`</review>`',
    )
  })
})

describe('QuestionStore', () => {
  it('claims queued questions by backend and records a lease', () => {
    const store = new QuestionStore()
    store.enqueue({
      backend: 'pi',
      file: 'f.ts',
      line: 3,
      question: 'why?',
      excerpt: 'x',
      lineText: 'const x = 1',
      commentOpenLine: 4,
      commentBody: '@pi why?',
    })
    store.enqueue({
      backend: 'codex',
      file: 'g.ts',
      line: 7,
      question: 'what?',
      excerpt: 'y',
      lineText: 'const y = 2',
      commentOpenLine: 8,
      commentBody: '@codex what?',
    })

    const claim = store.claim('codex', 'worker-1')
    expect(claim).toEqual({
      id: expect.any(String),
      backend: 'codex',
      file: 'g.ts',
      line: 7,
      question: 'what?',
      excerpt: 'y',
      lineText: 'const y = 2',
      leaseId: expect.any(String),
    })
    expect(store.claim('codex', 'worker-2')).toBeNull()
  })
})
