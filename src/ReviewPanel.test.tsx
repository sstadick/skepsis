// @vitest-environment happy-dom
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Window as HappyWindow } from 'happy-dom'
import {
  LineChat,
  ReviewPanel,
  anchorKey,
  useReview,
  type ReviewController,
} from './ReviewPanel.tsx'
import {
  PUBLICATION_ABANDON_ACK,
  reviewDraftsDigest,
  type ReviewSnapshot,
} from '../shared/review.ts'

const anchor = { path: 'file.ts', side: 'RIGHT' as const, line: 1, revision: 'old' }
let snapshot: ReviewSnapshot
let controller: ReviewController
let container: HTMLDivElement
let root: Root
let style: HTMLStyleElement
let qc: QueryClient
let requests: { path: string; body: Record<string, unknown> }[]
let respond: (path: string) => Promise<Response>
const ok = () => Promise.resolve(new Response('{}'))
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  )
  expect(button, label).toBeTruthy()
  await act(async () => button!.click())
  await flush()
}
async function editText(label: string, text: string) {
  const input = container.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`,
  )!
  expect(input).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      text,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function Harness() {
  controller = useReview()
  return (
    <>
      <LineChat anchor={anchor} review={controller} />
      <ReviewPanel review={controller} />
    </>
  )
}
beforeEach(async () => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  snapshot = {
    revision: 'old',
    pullRequest: {
      owner: 'o',
      repository: 'r',
      number: 1,
      url: '',
      title: '',
      baseSha: '',
      headSha: '',
      diffBaseSha: '',
    },
    agent: { model: 'test', available: true },
    threads: [],
    drafts: [],
    publication: null,
  }
  requests = []
  respond = ok
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/session') return new Response(JSON.stringify({ token: 'token' }))
      if (path === '/api/review') return new Response(JSON.stringify(snapshot))
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return respond(path)
    }),
  )
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  qc.setQueryData(['review'], snapshot)
  style = document.createElement('style')
  style.textContent = readFileSync('src/review.css', 'utf8')
  document.head.append(style)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    ),
  )
  await flush()
})
afterEach(async () => {
  await act(async () => root.unmount())
  qc.clear()
  container.remove()
  style.remove()
  ;(document.defaultView as unknown as HappyWindow).happyDOM.setViewport({ width: 1024 })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function update() {
  await act(async () => qc.setQueryData(['review'], { ...snapshot }))
  await flush()
}
it('preserves composition on cancelled answer replacement and deletes the entry on close', async () => {
  snapshot.threads = [
    {
      id: 't',
      anchor,
      status: 'answered',
      resolved: false,
      turns: [{ id: 'turn', question: 'q', answer: 'answer' }],
    },
  ]
  await update()
  await act(async () => controller.setText({ [anchorKey(anchor)]: 'unsaved' }))
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  )
  await click('Create review comment')
  expect(controller.text[anchorKey(anchor)]).toBe('unsaved')
  await click('Close')
  expect(controller.text).not.toHaveProperty(anchorKey(anchor))
})
it('submits an explicit private change request from the line composer', async () => {
  await act(async () =>
    controller.setText({ [anchorKey(anchor)]: 'Avoid the extra allocation' }),
  )
  await click('Propose a change (private)')
  expect(container.querySelector('[aria-label="Private change request"]')).toBeTruthy()
  expect(container.textContent).toContain('no files are edited or comments published')
  await click('Ask for a proposed change')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    path: '/api/threads',
    body: {
      anchor,
      text: 'Avoid the extra allocation',
      intent: 'propose-change',
    },
  })
  expect(snapshot.drafts).toEqual([])
  expect(snapshot.publication).toBeNull()
})

it.each([undefined, 'Use a guard clause', '    keepIndentation();  \n\tandTabs();\n'])(
  'requests a proposal as a private follow-up (%s)',
  async (text) => {
    snapshot.threads = [
      {
        id: 't',
        anchor,
        status: 'answered',
        resolved: false,
        turns: [{ id: 'turn', question: 'Why?', answer: 'An unnecessary nesting level.' }],
      },
    ]
    await update()
    if (text) await act(async () => controller.setText({ t: text }))
    await click('Propose a change')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      path: '/api/threads/t/messages',
      body: {
        intent: 'propose-change',
        text:
          text ?? 'Propose a minimal change to address the issue discussed in this thread.',
      },
    })
  },
)

it('uses a comment as a private change request without saving or modifying that draft', async () => {
  snapshot.drafts = [{ id: 'd', anchor, body: 'Saved comment' }]
  await update()
  await act(async () => controller.setText({ d: 'Unsaved comment edits' }))
  await click('Use comment as change request')
  expect(requests).toEqual([])
  expect(controller.text.d).toBe('Unsaved comment edits')
  expect(controller.text[anchorKey(anchor)]).toBe('Unsaved comment edits')
  expect(controller.modes[anchorKey(anchor)]).toBe('propose-change')
  await click('Ask for a proposed change')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    path: '/api/threads',
    body: {
      anchor,
      intent: 'propose-change',
      text: 'Unsaved comment edits',
    },
  })
  expect(controller.text.d).toBe('Unsaved comment edits')
  expect(snapshot.drafts[0]!.body).toBe('Saved comment')
})

it('requires explicit copy and save to turn a private proposal into a public-review draft', async () => {
  const answer = 'Avoid the extra allocation.\n```suggestion\nreturn value;\n```'
  snapshot.threads = [
    {
      id: 't',
      anchor,
      status: 'answered',
      resolved: false,
      turns: [
        { id: 'turn', question: 'Avoid the allocation', intent: 'propose-change', answer },
      ],
    },
  ]
  await update()
  expect(container.textContent).toContain('Proposed change (private)')
  expect(requests).toEqual([])
  await click('Create review comment')
  expect(controller.text[anchorKey(anchor)]).toBe(answer)
  expect(controller.modes[anchorKey(anchor)]).toBe('draft')
  expect(requests).toEqual([])
  await click('Save draft')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ path: '/api/drafts', body: { anchor, body: answer } })
  expect(snapshot.publication).toBeNull()
})

it('disables proposal requests without an agent or while provider consent is pending', async () => {
  snapshot.agent.available = false
  await update()
  await act(async () => {
    controller.setText({ [anchorKey(anchor)]: 'Change this' })
    controller.setModes({ [anchorKey(anchor)]: 'propose-change' })
  })
  await click('Ask for a proposed change')
  expect(requests).toEqual([])
  snapshot.agent.available = true
  snapshot.threads = [
    {
      id: 't',
      anchor,
      status: 'answered',
      resolved: false,
      turns: [],
      providerChange: { from: 'old', to: 'new' },
    },
  ]
  await update()
  await click('Propose a change')
  expect(requests).toEqual([])
})

it('recovers unsaved-only anchors across revisions', async () => {
  await act(async () => controller.setText({ [anchorKey(anchor)]: 'recover me' }))
  snapshot.revision = 'new'
  await update()
  expect(container.textContent).toContain('unsaved compositions (1)')
  expect(
    [...container.querySelectorAll('textarea')].some((t) => t.value === 'recover me'),
  ).toBe(true)
})
it('Escape closes the focused composer without treating normal text keys as shortcuts', async () => {
  await act(async () => controller.setText({ [anchorKey(anchor)]: 'text' }))
  const input = container.querySelector<HTMLTextAreaElement>(
    '[aria-label="Private question"]',
  )!
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })),
  )
  expect(controller.text[anchorKey(anchor)]).toBe('text')
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(controller.text[anchorKey(anchor)]).toBeUndefined()
})
it('reuses creation IDs after lost responses', async () => {
  respond = async () => {
    throw new Error('lost')
  }
  for (const id of ['first', 'retry']) {
    // Retries must follow the failed request, not run concurrently.
    // oxlint-disable-next-line no-await-in-loop
    await act(async () => {
      await controller.mutation
        .mutateAsync({
          path: '/api/drafts',
          method: 'PUT',
          creation: true,
          clear: anchorKey(anchor),
          body: { id, anchor, body: 'new' },
        })
        .catch(() => {})
    })
    // oxlint-disable-next-line no-await-in-loop
    await flush()
  }
  expect(requests.map((r) => r.body.id)).toEqual(['first', 'first'])
})
it('never substitutes a lost PUT resource ID into another draft update', async () => {
  respond = async () => {
    throw new Error('lost')
  }
  const save = (id: string) =>
    controller.mutation
      .mutateAsync({
        path: '/api/drafts',
        method: 'PUT',
        body: { id, anchor, body: 'same' },
        clear: id,
      })
      .catch(() => {})
  await act(async () => {
    await save('A')
  })
  await flush()
  await act(async () => {
    await save('B')
  })
  await flush()
  expect(requests.map((r) => r.body.id)).toEqual(['A', 'B'])
})
it('keeps Stop available during publication and requires provider consent', async () => {
  snapshot.threads = [
    {
      id: 't',
      anchor,
      status: 'running',
      resolved: false,
      turns: [],
      providerChange: { from: 'old', to: 'new' },
    },
  ]
  await update()
  let release!: (response: Response) => void
  respond = (path) =>
    path === '/api/review/submit'
      ? new Promise((r) => {
          release = r
        })
      : ok()
  await act(async () =>
    controller.mutation.mutate({ path: '/api/review/submit', body: { id: 'submit' } }),
  )
  await flush()
  await click('Stop')
  expect(requests.some((r) => r.path === '/api/threads/t/cancel')).toBe(true)
  expect(container.textContent).toContain('retained private history')
  await click('Allow history to new')
  expect(requests.find((r) => r.path.endsWith('/provider'))?.body).toEqual({
    provider: 'new',
  })
  await act(async () => release(new Response('{}')))
  await flush()
})
it('previews saved bodies, invalidates changed drafts, and clears after reconciliation success', async () => {
  snapshot.drafts = [{ id: 'd', anchor, body: 'saved body' }]
  await update()
  await act(async () =>
    container.querySelector<HTMLInputElement>('.draft-selection input')!.click(),
  )
  await click('Preview review')
  expect(container.querySelector('.publication-preview')?.textContent).toContain(
    'saved body',
  )
  expect(requests).toHaveLength(0)
  snapshot.drafts = [{ id: 'd', anchor, body: 'changed' }]
  await update()
  expect(container.querySelector('.publication-preview')).toBeNull()
  await click('Preview review')
  await click('Confirm submit to GitHub')
  expect(requests[0]!.body.draftIds).toEqual(['d'])
  snapshot.publication = {
    id: 'p',
    status: 'published',
    event: 'COMMENT',
    body: '',
    draftIds: ['d'],
  }
  await update()
  expect(container.querySelector('.publication-preview')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('.draft-selection input')!.checked).toBe(
    false,
  )
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Review summary"]')!.value,
  ).toBe('')
})

it('manual unlock needs acknowledgement, never resends, and releases the old retry ID', async () => {
  const body = { id: 'lost', event: 'COMMENT', body: 'Summary', draftIds: [] }
  respond = async () => {
    throw new Error('lost response')
  }
  await act(async () => {
    await controller.mutation
      .mutateAsync({ path: '/api/review/submit', body })
      .catch(() => {})
  })
  snapshot.publication = { ...body, event: 'COMMENT', status: 'uncertain' }
  await update()
  const unlock = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Unlock without resubmitting',
  )!
  expect(unlock.disabled).toBe(true)
  respond = async (path) => {
    if (path === '/api/review/abandon')
      snapshot.publication = { ...snapshot.publication!, status: 'abandoned' }
    return new Response('{}')
  }
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  )
  const acknowledge = [...container.querySelectorAll('label')]
    .find((label) => label.textContent?.includes(PUBLICATION_ABANDON_ACK))!
    .querySelector<HTMLInputElement>('input')!
  await act(async () => acknowledge.click())
  await click('Unlock without resubmitting')
  expect(requests.filter((r) => r.path === '/api/review/submit')).toHaveLength(1)
  expect(requests.find((r) => r.path === '/api/review/abandon')?.body).toEqual({
    id: 'lost',
    acknowledgement: PUBLICATION_ABANDON_ACK,
  })
  await act(async () => {
    await controller.mutation.mutateAsync({
      path: '/api/review/submit',
      body: { ...body, id: 'new-explicit-submission' },
    })
  })
  expect(requests.at(-1)?.body.id).toBe('new-explicit-submission')
})

it('renders user, agent and streaming Markdown with roles and a stoppable streaming indicator', async () => {
  snapshot.threads = [
    {
      id: 't',
      anchor,
      status: 'running',
      resolved: false,
      turns: [
        {
          id: 'turn',
          question: '## Why?\n\nWhat about `input`?',
          answer: '**Check** the guard.\n\n- First\n- Second',
        },
      ],
      partial: '### In progress\n\n```ts\nconst result',
    },
  ]
  await update()
  const chat = container.querySelector('.durable-line-chat')!
  expect(chat.querySelector('.review-message-user h2')?.textContent).toBe('Why?')
  expect(chat.querySelector('.review-message-user code')?.textContent).toBe('input')
  expect(
    chat.querySelector('.review-message-agent .review-markdown strong')?.textContent,
  ).toBe('Check')
  expect(chat.querySelectorAll('.review-message-agent li')).toHaveLength(2)
  expect(chat.querySelector('h3')?.textContent).toBe('In progress')
  expect(chat.querySelector('pre code')?.textContent).toBe('const result\n')
  expect(chat.querySelector('.review-streaming[role="status"]')?.textContent).toBe(
    'Agent is writing…',
  )
  expect(chat.querySelector('.review-avatar')?.getAttribute('aria-hidden')).toBe('true')
  expect(requests).toEqual([])
  await click('Stop')
  expect(requests.map((request) => request.path)).toEqual(['/api/threads/t/cancel'])
})

it('previews an answer conversion without altering the Markdown source, then saves only explicit edits', async () => {
  const answer =
    '## Suggested guard\n\nKeep **spacing** and `code`.\n\n```suggestion\n  if (!value) return;  \n\treturn value;\n```\n\n[Details](https://example.com)\n'
  snapshot.threads = [
    {
      id: 't',
      anchor,
      status: 'answered',
      resolved: false,
      turns: [
        { id: 'turn', question: 'Suggest a guard', intent: 'propose-change', answer },
      ],
    },
  ]
  await update()
  await click('Create review comment')
  expect(controller.text[anchorKey(anchor)]).toBe(answer)
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="New review draft"]')?.value,
  ).toBe(answer)
  expect(container.textContent).toContain('Draft only — not published.')
  await click('Preview')
  const preview = container.querySelector('[aria-label="New review draft preview"]')!
  expect(preview.querySelector('h2')?.textContent).toBe('Suggested guard')
  expect(preview.querySelector('pre')?.textContent).toBe(
    '  if (!value) return;  \n\treturn value;\n',
  )
  expect(controller.text[anchorKey(anchor)]).toBe(answer)
  expect(requests).toEqual([])
  await click('Write')
  const edited = answer + '\n- My **review** note\n'
  await editText('New review draft', edited)
  expect(controller.text[anchorKey(anchor)]).toBe(edited)
  await click('Preview')
  expect(
    container.querySelector('[aria-label="New review draft preview"] li strong')
      ?.textContent,
  ).toBe('review')
  await click('Save draft')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ path: '/api/drafts', body: { anchor, body: edited } })
  expect(snapshot.threads[0]!.turns[0]!.answer).toBe(answer)
  expect(snapshot.publication).toBeNull()
})

it('previews saved-draft edits and public Markdown while keeping exact publication payloads and unsaved guards', async () => {
  snapshot.drafts = [
    { id: 'd', anchor, body: '**Saved** comment\n\n```diff\n- old\n+ new\n```\n' },
  ]
  await update()
  await click('Preview')
  expect(
    container.querySelector('[aria-label="Review comment draft preview"] strong')
      ?.textContent,
  ).toBe('Saved')
  const summary = '## Summary\n\nA **careful** review.\n\n- [x] Checked\n'
  await editText('Review summary', summary)
  await act(async () =>
    container.querySelector<HTMLInputElement>('.draft-selection input')!.click(),
  )
  await click('Preview review')
  const preview = container.querySelector('.publication-preview')!
  expect(preview.querySelector('h2')?.textContent).toBe('Summary')
  expect(preview.querySelector('article .review-markdown strong')?.textContent).toBe(
    'Saved',
  )
  expect(preview.querySelector('input')?.disabled).toBe(true)
  expect(requests).toEqual([])
  await click('Write')
  const edited =
    '## Edited\n\n  Leading spaces and **intentional** wording.\n\n```suggestion\n\treturn x;  \n```\n'
  await editText('Review comment draft', edited)
  expect(container.querySelector('.publication-preview')).toBeNull()
  await click('Preview review')
  expect(container.querySelector('.publication-preview')).toBeNull()
  await click('Preview')
  expect(
    container.querySelector('[aria-label="Review comment draft preview"] h2')?.textContent,
  ).toBe('Edited')
  expect(requests).toEqual([])
  respond = async (path) => {
    if (path === '/api/drafts')
      snapshot.drafts = [{ id: 'd', anchor, body: String(requests.at(-1)!.body.body) }]
    return new Response('{}')
  }
  await click('Save draft')
  expect(requests[0]).toMatchObject({
    path: '/api/drafts',
    body: { id: 'd', anchor, body: edited },
  })
  await click('Preview review')
  expect(container.querySelector('.publication-preview article h2')?.textContent).toBe(
    'Edited',
  )
  await click('Confirm submit to GitHub')
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual({
    path: '/api/review/submit',
    body: {
      id: expect.any(String),
      event: 'COMMENT',
      body: summary,
      draftIds: ['d'],
      draftsDigest: await reviewDraftsDigest(snapshot.drafts),
    },
  })
})

it('labels visible composer modes explicitly and sends private questions without changing their source', async () => {
  const text = '    indentedCode();  \n\nIs this **safe**?\n'
  await act(async () => controller.setText({ [anchorKey(anchor)]: text }))
  const chat = container.querySelector('.durable-line-chat')!
  const modes = chat.querySelector<HTMLElement>('.review-mode-buttons')!
  expect(getComputedStyle(modes).display).not.toBe('none')
  expect([...modes.querySelectorAll('button')].map((button) => button.textContent)).toEqual(
    ['Private question', 'Propose a change (private)', 'Draft review comment'],
  )
  expect(getComputedStyle(chat.querySelector('.review-mode-select')!).display).toBe('none')
  await click('Draft review comment')
  expect(
    chat.querySelector<HTMLTextAreaElement>('[aria-label="New review draft"]')?.value,
  ).toBe(text)
  await click('Private question')
  expect(modes.querySelector('[aria-pressed="true"]')?.textContent).toBe('Private question')
  expect(chat.querySelectorAll('textarea[aria-label="Private question"]')).toHaveLength(1)
  expect(
    [...container.querySelectorAll('button')].every((button) => button.type === 'button'),
  ).toBe(true)
  expect(requests).toEqual([])
  await click('Ask agent privately')
  expect(requests).toEqual([
    { path: '/api/threads', body: { id: expect.any(String), anchor, text } },
  ])
})

it('offers the same private modes through the visible narrow-screen selector', async () => {
  ;(document.defaultView as unknown as HappyWindow).happyDOM.setViewport({ width: 480 })
  await act(async () => controller.setText({ [anchorKey(anchor)]: 'Keep this text' }))
  const chat = container.querySelector('.durable-line-chat')!
  expect(getComputedStyle(chat.querySelector('.review-mode-buttons')!).display).toBe('none')
  const label = chat.querySelector('.review-mode-select')!
  expect(getComputedStyle(label).display).toBe('flex')
  const select = label.querySelector('select')!
  expect([...select.options].map((option) => option.textContent)).toEqual([
    'Private question',
    'Propose a change (private)',
    'Draft review comment',
  ])
  await act(async () => {
    select.value = 'propose-change'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(
    chat.querySelector<HTMLTextAreaElement>('[aria-label="Private change request"]')?.value,
  ).toBe('Keep this text')
  expect(requests).toEqual([])
})

it('counts saved unpublished drafts and private threads once, independent of rendered archive copies', async () => {
  snapshot.drafts = [
    { id: 'd', anchor, body: 'Draft' },
    { id: 'published', anchor, body: 'Published', publishedReviewId: 123 },
  ]
  snapshot.threads = [{ id: 't', anchor, status: 'answered', resolved: false, turns: [] }]
  await update()
  expect(container.querySelector('.review-panel-heading')?.textContent).toBe(
    'Review 1 draft 1 private thread',
  )
  snapshot.threads.push({
    id: 'resolved',
    anchor,
    status: 'answered',
    resolved: true,
    turns: [],
  })
  await update()
  expect(container.querySelector('.review-panel-heading')?.textContent).toBe(
    'Review 1 draft 2 private threads',
  )
})

it.each(['New review draft', 'Review comment draft', 'Review summary'])(
  'returns focus and the exact selection to %s after preview without exposing its hidden textarea',
  async (label) => {
    const text = 'First line  \n\tSecond **line**\n\n'
    snapshot.drafts = [{ id: 'd', anchor, body: text }]
    await update()
    await act(async () => {
      controller.setText({ [anchorKey(anchor)]: text })
      controller.setModes({ [anchorKey(anchor)]: 'draft' })
    })
    container.querySelector<HTMLDetailsElement>('.durable-review-panel')!.open = true
    if (label === 'Review summary') await editText(label, text)
    const input = container.querySelector<HTMLTextAreaElement>(
      `textarea[aria-label="${label}"]`,
    )!
    const editor = input.closest('.review-editor')!
    const buttons = [...editor.querySelectorAll('button')]
    input.focus()
    input.setSelectionRange(3, 14, 'backward')
    input.scrollTop = 20
    await act(async () =>
      buttons.find((button) => button.textContent === 'Preview')!.click(),
    )
    expect(editor.querySelector('textarea')).toBe(input)
    expect(input.value).toBe(text)
    expect(input.checkVisibility()).toBe(false)
    expect(getComputedStyle(input.parentElement!).display).toBe('none')
    expect(editor.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe(
      `${label} preview`,
    )
    await act(async () => buttons.find((button) => button.textContent === 'Write')!.click())
    expect(input.checkVisibility()).toBe(true)
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
      3,
      14,
      'backward',
    ])
    expect(input.scrollTop).toBe(20)
    expect(input.value).toBe(text)
    expect(requests).toEqual([])
  },
)

it('requires confirmation even before replacing a whitespace-only composition', async () => {
  snapshot.threads = [
    {
      id: 't',
      anchor,
      status: 'answered',
      resolved: false,
      turns: [{ id: 'turn', question: 'Why?', answer: 'A proposal' }],
    },
  ]
  await update()
  await act(async () => controller.setText({ [anchorKey(anchor)]: '  \n\t' }))
  const confirm = vi.fn(() => false)
  vi.stubGlobal('confirm', confirm)
  await click('Create review comment')
  expect(confirm).toHaveBeenCalledExactlyOnceWith('Replace your unsaved composition?')
  expect(controller.text[anchorKey(anchor)]).toBe('  \n\t')
  expect(requests).toEqual([])
})

it('does not steal focus into a disabled published draft when returning to its source', async () => {
  snapshot.drafts = [{ id: 'd', anchor, body: 'Published', publishedReviewId: 123 }]
  await update()
  const editor = container.querySelector('.review-draft .review-editor')!
  const write = editor.querySelector<HTMLButtonElement>('button')!
  write.focus()
  await act(async () => write.click())
  expect(document.activeElement).toBe(write)
  expect(editor.querySelector('textarea')?.disabled).toBe(true)
  expect(requests).toEqual([])
})

it.each([
  'javascript:alert(1)',
  'data:text/html,evil',
  '/api/session',
  '//evil.example',
  '#details',
  'mailto:review@example.com',
])('does not expose an unsafe or non-web publication link: %s', async (url) => {
  snapshot.publication = {
    id: 'p',
    status: 'published',
    event: 'COMMENT',
    body: '',
    draftIds: [],
    url,
  }
  await update()
  expect(container.querySelector('[role="status"] a')).toBeNull()
  expect(requests).toEqual([])
})

it('opens a valid publication receipt with safe external link attributes', async () => {
  const url = 'https://github.com/o/r/pull/1#pullrequestreview-123'
  snapshot.publication = {
    id: 'p',
    status: 'published',
    event: 'COMMENT',
    body: '',
    draftIds: [],
    url,
  }
  await update()
  const link = container.querySelector<HTMLAnchorElement>('[role="status"] a')!
  expect(link.href).toBe(url)
  expect(link.target).toBe('_blank')
  expect(link.rel).toBe('noopener noreferrer')
  expect(requests).toEqual([])
})
