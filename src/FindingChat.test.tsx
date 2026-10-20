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
import type { AgentReviewFinding, AgentReviewRun } from '../shared/agentReview.ts'
import type { ReviewAnchor, ReviewSnapshot } from '../shared/review.ts'
import { AgentFinding, AgentReviewPanel } from './AgentReview.tsx'
import { findingChatKey } from './FindingChat.tsx'
import { useReview, type ReviewController } from './ReviewPanel.tsx'
import { ReviewToolbar } from './ReviewToolbar.tsx'

const anchor: ReviewAnchor = {
  path: 'src/file.ts',
  line: 14,
  side: 'RIGHT',
  revision: 'rev',
}
const findings: AgentReviewFinding[] = [
  { id: 'first', anchor, body: 'issue: Check bounds', status: 'pending' },
  { id: 'second', anchor, body: 'issue: Check errors', status: 'dismissed' },
]
const messagePath = '/api/agent-review/run/findings/first/messages'
const cancelPath = '/api/agent-review/run/cancel'
function run(overrides: Partial<AgentReviewRun> = {}): AgentReviewRun {
  return {
    id: 'run',
    revision: 'rev',
    model: { provider: 'faux', modelId: 'reviewer' },
    reasoningLevel: 'off',
    turns: [{ id: 'review', question: 'Review the diff', answer: 'Summary' }],
    status: 'answered',
    resolved: false,
    findings: structuredClone(findings),
    ...overrides,
  }
}

let snapshot: ReviewSnapshot
let controller: ReviewController
let root: Root
let qc: QueryClient
let container: HTMLDivElement
let panelVisible: boolean
let inlineVisible: boolean
let compact: boolean
let error: { path: string; message: string; status: number } | undefined
let reply:
  | ((request: { path: string; body?: { id: string; text: string } }) => Promise<Response>)
  | undefined
let requests: {
  path: string
  method: string
  body?: { id: string; text: string }
  token: string | null
}[]

function Harness() {
  controller = useReview()
  const content = (
    <>
      {panelVisible && <AgentReviewPanel review={controller} />}
      {inlineVisible &&
        snapshot.agentReviews?.[0]?.findings.map((item) => (
          <AgentFinding key={item.id} runId="run" finding={item} review={controller} />
        ))}
    </>
  )
  return compact ? <ReviewToolbar>{content}</ReviewToolbar> : content
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    ),
  )
  await flush()
}
async function update() {
  await act(async () => qc.setQueryData(['review'], structuredClone(snapshot)))
  await flush()
}
function finding(index = 0) {
  return container.querySelectorAll<HTMLElement>('.agent-finding')[index]!
}
function button(label: string, parent: ParentNode = container) {
  return [...parent.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent === label,
  )
}
async function click(label: string, parent: ParentNode = container) {
  const target = button(label, parent)
  expect(target, `Missing button ${label}`).toBeTruthy()
  await act(async () => target!.click())
  await flush()
}
async function typeQuestion(value: string, parent: ParentNode = finding()) {
  const input = parent.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Private finding follow-up"]',
  )!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      value,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

beforeEach(async () => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  snapshot = {
    revision: 'rev',
    pullRequest: null,
    agent: { model: 'reviewer', available: true, enabled: true },
    threads: [],
    drafts: [],
    publication: null,
    agentReviews: [run()],
  }
  panelVisible = true
  inlineVisible = false
  compact = false
  error = undefined
  reply = undefined
  requests = []
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  qc.setQueryData(['review'], snapshot)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/review') return Response.json(snapshot)
      if (path === '/api/session') return Response.json({ token: 'test-token' })
      const request = {
        path,
        method: init?.method ?? 'GET',
        body: init?.body
          ? (JSON.parse(String(init.body)) as { id: string; text: string })
          : undefined,
        token: new Headers(init?.headers).get('x-skepsis-token'),
      }
      requests.push(request)
      if (error?.path === path)
        return Response.json({ error: error.message }, { status: error.status })
      if (path === '/api/agent-review/models')
        return Response.json({ models: [], defaultModel: null })
      if (reply && path === '/api/agent-review/run/findings/first/messages')
        return reply(request)
      if (path.endsWith('/messages')) {
        snapshot.agentReviews![0]!.turns.push({
          id: request.body!.id,
          question: request.body!.text,
          findingId: path.includes('/first/') ? 'first' : 'second',
        })
        snapshot.agentReviews![0]!.status = 'queued'
      } else if (path === cancelPath) {
        snapshot.agentReviews![0]!.status = 'cancelled'
      } else throw new Error(`Unexpected request: ${path}`)
      return Response.json({})
    }),
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await render()
})
afterEach(async () => {
  await act(async () => root.unmount())
  qc.clear()
  container.remove()
  vi.unstubAllGlobals()
})

it('opens without inference, sends only to this finding, and separates persisted history and safe Markdown', async () => {
  snapshot.agentReviews = [
    run({
      turns: [
        { id: 'review', question: 'Review the diff', error: 'Review-only error' },
        {
          id: 'older',
          findingId: 'first',
          question: '## Why? ![tracker](https://evil.example/pixel.png)',
          answer: '**Because** [unsafe](javascript:alert(1)) <script>bad()</script>',
        },
        {
          id: 'other',
          findingId: 'second',
          question: 'Other finding question',
          answer: 'Other answer',
        },
      ],
    }),
  ]
  await update()
  expect(finding().textContent).toContain('1 private follow-up')
  expect(finding().textContent).not.toContain('Why?')
  await click('Chat with agent', finding())
  expect(requests).toEqual([])
  const chat = finding().querySelector('.finding-chat')!
  expect(chat.querySelector('h2')?.textContent).toBe('Why? [Image: tracker]')
  expect(chat.querySelector('strong')?.textContent).toBe('You · private question')
  expect(chat.textContent).toContain('Because')
  expect(chat.querySelector('img, script, a')).toBeNull()
  expect(chat.textContent).not.toContain('Other finding question')
  expect(chat.textContent).not.toContain('Review-only error')
  expect(container.querySelector('.agent-review-run > [role="alert"]')?.textContent).toBe(
    'Review-only error',
  )
  await typeQuestion('  Can you **explain**?  ')
  await click('Send private question', finding())
  expect(requests).toEqual([
    {
      path: messagePath,
      method: 'POST',
      token: 'test-token',
      body: {
        id: expect.stringMatching(/^[a-f\d-]{36}$/),
        text: '  Can you **explain**?  ',
      },
    },
  ])
  expect(snapshot.agentReviews![0]!.turns.at(-1)?.findingId).toBe('first')
  expect(snapshot.drafts).toEqual([])
  expect(snapshot.publication).toBeNull()
  expect(requests.some(({ path }) => /accept|dismiss|submit/.test(path))).toBe(false)
  await click('Chat with agent', finding(1))
  expect(finding(1).textContent).toContain('Other finding question')
  expect(finding(1).textContent).not.toContain('Can you explain')
})

it('leaves accepted and dismissed history readable but explains why stale and --no-agent sends are blocked', async () => {
  snapshot.agentReviews = [
    run({
      findings: [
        { ...findings[0]!, status: 'accepted' },
        { ...findings[1]!, status: 'dismissed' },
      ],
      turns: [
        {
          id: 'old',
          findingId: 'first',
          question: 'Saved question',
          answer: 'Saved answer',
        },
      ],
    }),
  ]
  await update()
  await click('Chat with agent', finding())
  await typeQuestion('Please elaborate')
  expect(button('Send private question', finding())!.disabled).toBe(false)
  snapshot.agent.enabled = false
  snapshot.agent.error = 'Agent paused by --no-agent'
  await update()
  expect(finding().textContent).toContain('Saved answer')
  expect(finding().textContent).toContain('Agent paused by --no-agent')
  expect(button('Send private question', finding())!.disabled).toBe(true)
  snapshot.agent.enabled = true
  snapshot.revision = 'new-revision'
  await update()
  expect(finding().textContent).toContain('Outdated diff')
  expect(button('Send private question', finding())!.disabled).toBe(true)
  expect(controller.text[findingChatKey('run', 'first')]).toBe('Please elaborate')
  expect(requests).toEqual([])
  await click('Chat with agent', finding(1))
  expect(finding(1).querySelector('textarea')).toBeTruthy()
})

it('scopes the stream, progress, cancellation and error to the active finding, not a second whole review', async () => {
  snapshot.agentReviews = [
    run({
      status: 'running',
      partial: '### Private stream',
      turns: [
        { id: 'review', question: 'Review the diff', answer: 'Reviewed' },
        { id: 'follow-up', findingId: 'first', question: 'Why?', error: 'Reply failed' },
      ],
    }),
  ]
  await update()
  await click('Chat with agent', finding())
  await click('Chat with agent', finding(1))
  expect(finding().textContent).toContain('Private stream')
  expect(finding(1).textContent).not.toContain('Private stream')
  expect(finding().textContent).toContain('Reply failed')
  expect(finding(1).textContent).not.toContain('Reply failed')
  expect(button('Stop reply', finding(1))).toBeUndefined()
  expect(button('Stop review')).toBeUndefined()
  expect(container.querySelector('[aria-label="Streaming agent review"]')).toBeNull()
  expect(container.querySelector('.agent-review-run > [role="alert"]')).toBeNull()
  expect(container.textContent).toContain('Chatting…')
  expect(button('Send private question', finding(1))!.disabled).toBe(true)
  expect(finding(1).textContent).toContain('A review or reply is in progress')
  error = { path: cancelPath, message: 'Unable to stop reply', status: 503 }
  await click('Stop reply', finding())
  expect(requests.at(-1)).toMatchObject({
    path: cancelPath,
    method: 'POST',
    token: 'test-token',
  })
  expect(finding().textContent).toContain('Unable to stop reply')
  expect(finding(1).textContent).not.toContain('Unable to stop reply')
  expect(container.querySelector('.agent-review-run > [role="alert"]')).toBeNull()
  error = undefined
  await click('Stop reply', finding())
  expect(snapshot.agentReviews![0]!.status).toBe('cancelled')
  expect(button('Stop reply')).toBeUndefined()
  expect(container.querySelector('.agent-review-run-header')?.textContent).toContain(
    'Chat cancelled',
  )
})

it('blocks sending during a queued whole review and labels a failed follow-up as chat, without root errors', async () => {
  snapshot.agentReviews = [run({ status: 'queued' })]
  await update()
  await click('Chat with agent', finding())
  await typeQuestion('Can you explain?')
  expect(button('Send private question', finding())!.disabled).toBe(true)
  expect(finding().textContent).toContain('A review or reply is in progress')
  expect(button('Stop review')).toBeTruthy()
  expect(button('Stop reply')).toBeUndefined()
  expect(requests).toEqual([])
  snapshot.agentReviews = [
    run({
      status: 'failed',
      turns: [
        { id: 'review', question: 'Review the diff', answer: 'Reviewed' },
        {
          id: 'follow-up',
          findingId: 'first',
          question: 'Why?',
          error: 'Chat model failed',
        },
      ],
    }),
  ]
  await update()
  expect(container.textContent).toContain('Chat failed')
  expect(finding().textContent).toContain('Chat model failed')
  expect(container.querySelector('.agent-review-run > [role="alert"]')).toBeNull()
  expect(button('Send private question', finding())!.disabled).toBe(false)
})

it('retains the exact unsent text and open state across virtualized remounts and toolbar toggles', async () => {
  compact = true
  await render()
  const trigger = () =>
    container.querySelector<HTMLButtonElement>('[data-tool="agent"] .review-tool-trigger')!
  await act(async () => trigger().click())
  await flush()
  await click('Chat with agent', finding())
  await typeQuestion('  Preserve **my** note  ')
  await act(async () => trigger().click())
  await flush()
  await act(async () => trigger().click())
  await flush()
  expect(button('Chat with agent', finding())!.getAttribute('aria-expanded')).toBe('true')
  expect(finding().querySelector('textarea')?.value).toBe('  Preserve **my** note  ')
  panelVisible = false
  inlineVisible = true
  await render()
  expect(button('Chat with agent', finding())!.getAttribute('aria-expanded')).toBe('true')
  expect(finding().querySelector('textarea')?.value).toBe('  Preserve **my** note  ')
  panelVisible = true
  inlineVisible = false
  await render()
  await act(async () => trigger().click())
  await flush()
  expect(finding().querySelector('textarea')?.value).toBe('  Preserve **my** note  ')
  expect(requests.filter(({ method }) => method === 'POST')).toEqual([])
})

it('disables edits while sending, keeps failed text, and reuses the durable ID on retry', async () => {
  await click('Chat with agent', finding())
  await typeQuestion('Retry this question')
  let reject!: (reason: Error) => void
  reply = () =>
    new Promise((_resolve, r) => {
      reject = r
    })
  await act(async () => button('Send private question', finding())!.click())
  await flush()
  expect(finding().querySelector('textarea')?.disabled).toBe(true)
  expect(finding().querySelector('textarea')?.value).toBe('Retry this question')
  await act(async () => reject(new Error('Response lost')))
  await flush()
  expect(finding().querySelector('textarea')?.disabled).toBe(false)
  expect(finding().textContent).toContain('Response lost')
  expect(container.querySelector('.agent-review-run > [role="alert"]')).toBeNull()
  const original = requests.at(-1)!.body
  reply = async (request) => {
    snapshot.agentReviews![0]!.turns.push({
      id: request.body!.id,
      question: request.body!.text,
      findingId: 'first',
    })
    return Response.json({})
  }
  await click('Send private question', finding())
  expect(requests.at(-1)!.body).toEqual(original)
  expect(controller.text[findingChatKey('run', 'first')]).toBeUndefined()
  expect(finding().textContent).toContain('Retry this question')
})
