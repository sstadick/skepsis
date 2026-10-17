/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ReviewThreadContent } from '../shared/reviewComments.ts'
import { ReviewComposer, ReviewThreadCard } from './reviewUi.tsx'

describe('ReviewComposer', () => {
  it('defaults to a review comment composer with local-annotation help text', () => {
    const html = renderToStaticMarkup(
      <ReviewComposer
        draft={{ kind: 'comment', text: '' }}
        onDraftChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        submitting={false}
        error={null}
        syntax={{ prefix: '//', suffix: '' }}
      />,
    )

    expect(html).toContain('Review comment')
    expect(html).toContain('Ask agent')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Leave a review comment about this code… (Cmd+Enter to submit)')
    expect(html).toContain(
      'Local annotation in your working files, not a GitHub review comment.',
    )
    expect(html).toContain('Comment marker: //')
  })

  it('renders the controlled question draft without owning local state', () => {
    const html = renderToStaticMarkup(
      <ReviewComposer
        draft={{ kind: 'question', text: 'Can this move?' }}
        onDraftChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        submitting={false}
        error={null}
        syntax={{ prefix: '//', suffix: '' }}
      />,
    )

    expect(html).toContain('aria-label="Ask Agent"')
    expect(html).toContain('Ask Agent about this code… (Cmd+Enter to submit)')
    expect(html).toContain('Agent answers inline with the configured Pi model.')
    expect(html).toContain('Can this move?')
  })
})

describe('ReviewThreadCard', () => {
  it('renders embedded pending questions as generic Agent threads', () => {
    const thread: ReviewThreadContent = {
      kind: 'question',
      backend: 'claude',
      embedded: true,
      question: 'Why is this branch safe?',
      messages: [{ role: 'user', content: 'Why is this branch safe?' }],
      status: 'pending',
      threadId: '0f0b8d9d-a5fb-4e57-bd16-4a450c7d4bb1',
    }

    const html = renderToStaticMarkup(
      <ReviewThreadCard
        thread={thread}
        onResolve={() => {}}
        onFollowUp={() => {}}
        followUpDraft=""
        onFollowUpDraftChange={() => {}}
        resolving={false}
        followingUp={false}
        followUpError={null}
      />,
    )

    expect(html).toContain('Agent')
    expect(html).toContain('Answering')
    expect(html).toContain('Agent is answering…')
    expect(html).not.toContain('Claude')
    expect(html).not.toContain('@claude')
  })

  it('renders pending legacy questions without auto-answer or follow-up UI', () => {
    const thread: ReviewThreadContent = {
      kind: 'question',
      backend: 'claude',
      question: 'Why is this branch safe?',
      messages: [{ role: 'user', content: 'Why is this branch safe?' }],
      status: 'pending',
      threadId: '6db0e412-f0d1-4a11-80e1-db860514b794',
    }

    const html = renderToStaticMarkup(
      <ReviewThreadCard
        thread={thread}
        onResolve={() => {}}
        onFollowUp={() => {}}
        followUpDraft=""
        onFollowUpDraftChange={() => {}}
        resolving={false}
        followingUp={false}
        followUpError={null}
      />,
    )

    expect(html).toContain('Legacy question')
    expect(html).toContain('Pending')
    expect(html).toContain(
      'This older thread is not run automatically. Resolve it and use Ask agent to start a new question.',
    )
    expect(html).not.toContain('Agent is answering…')
    expect(html).not.toContain('Ask Agent a follow-up… (Cmd+Enter to send)')
    expect(html).not.toContain('@claude')
  })

  it('keeps embedded follow-up UX generic and context-preserving after an answer', () => {
    const thread: ReviewThreadContent = {
      kind: 'question',
      backend: 'codex',
      embedded: true,
      question: 'Why is this branch safe?',
      messages: [
        { role: 'user', content: 'Why is this branch safe?' },
        {
          role: 'assistant',
          content: 'Because the guard exits first.',
          outcome: 'answered',
        },
      ],
      status: 'answered',
      threadId: '7e0f7868-f841-439d-9730-f106e7b713bb',
    }

    const html = renderToStaticMarkup(
      <ReviewThreadCard
        thread={thread}
        onResolve={() => {}}
        onFollowUp={() => {}}
        followUpDraft=""
        onFollowUpDraftChange={() => {}}
        resolving={false}
        followingUp={false}
        followUpError={null}
      />,
    )

    expect(html).toContain('Ask Agent a follow-up… (Cmd+Enter to send)')
    expect(html).toContain('Follow-ups keep the earlier thread context.')
    expect(html).toContain('Answered')
    expect(html).not.toContain('Codex')
  })

  it('does not offer follow-ups for answered legacy questions', () => {
    const thread: ReviewThreadContent = {
      kind: 'question',
      backend: 'codex',
      question: 'Why is this branch safe?',
      messages: [
        { role: 'user', content: 'Why is this branch safe?' },
        {
          role: 'assistant',
          content: 'Because the guard exits first.',
          outcome: 'answered',
        },
      ],
      status: 'answered',
      threadId: '9f001205-0e6e-4f38-a24b-b8f3f484bbce',
    }

    const html = renderToStaticMarkup(
      <ReviewThreadCard
        thread={thread}
        onResolve={() => {}}
        onFollowUp={() => {}}
        followUpDraft=""
        onFollowUpDraftChange={() => {}}
        resolving={false}
        followingUp={false}
        followUpError={null}
      />,
    )

    expect(html).toContain('Legacy question')
    expect(html).toContain('Answered')
    expect(html).not.toContain('Ask Agent a follow-up… (Cmd+Enter to send)')
    expect(html).not.toContain('Codex')
  })

  it('renders the controlled follow-up draft text for embedded questions', () => {
    const thread: ReviewThreadContent = {
      kind: 'question',
      backend: 'claude',
      embedded: true,
      question: 'Can we simplify this?',
      messages: [
        { role: 'user', content: 'Can we simplify this?' },
        {
          role: 'assistant',
          content: 'Yes, extract the guard.',
          outcome: 'answered',
        },
      ],
      status: 'answered',
      threadId: '07b50efe-e677-4f36-b7d7-1f5aef5d1234',
    }

    const html = renderToStaticMarkup(
      <ReviewThreadCard
        thread={thread}
        onResolve={() => {}}
        onFollowUp={() => {}}
        followUpDraft="Can you sketch that extraction?"
        onFollowUpDraftChange={() => {}}
        resolving={false}
        followingUp={false}
        followUpError={null}
      />,
    )

    expect(html).toContain('Can you sketch that extraction?')
  })
})
