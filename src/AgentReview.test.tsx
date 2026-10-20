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
import type {
  AgentReviewFinding,
  AgentReviewRun,
  ReviewAgentModels,
} from '../shared/agentReview.ts'
import { DEFAULT_REVIEW_PROMPT } from '../shared/agentReview.ts'
import type { ReviewAnchor, ReviewSnapshot } from '../shared/review.ts'
import { AgentFinding, AgentReviewPanel } from './AgentReview.tsx'
import { ReviewToolbar } from './ReviewToolbar.tsx'
import { useReview, type ReviewController } from './ReviewPanel.tsx'

const anchor: ReviewAnchor = {
  path: 'src/file.ts',
  side: 'RIGHT',
  line: 14,
  revision: 'rev',
}
const finding: AgentReviewFinding = {
  id: 'finding-1',
  anchor,
  body: 'issue (blocking): **Check bounds** ![tracker](https://evil.example/pixel.png) <script>alert(1)</script>',
  status: 'pending',
}
const catalog: ReviewAgentModels = {
  defaultModel: { provider: 'default-provider', modelId: 'current' },
  models: [
    { provider: 'other', modelId: 'quick', name: 'Quick', reasoningLevels: ['off'] },
    {
      provider: 'default-provider',
      modelId: 'current',
      name: 'Current',
      reasoningLevels: ['low', 'high'],
    },
  ],
}
function run(overrides: Partial<AgentReviewRun> = {}): AgentReviewRun {
  return {
    id: 'run-1',
    revision: 'rev',
    model: { provider: 'default-provider', modelId: 'current' },
    reasoningLevel: 'high',
    turns: [],
    status: 'answered',
    resolved: false,
    summary: 'Look for **regressions**.',
    findings: [structuredClone(finding)],
    ...overrides,
  }
}

type Snapshot = ReviewSnapshot & { agentReviews?: AgentReviewRun[] }
let snapshot: Snapshot
let controller: ReviewController
let root: Root
let qc: QueryClient
let container: HTMLDivElement
let panelVisible: boolean
let inlineFinding: boolean
let compact: boolean
let requests: {
  path: string
  method: string
  body?: Record<string, unknown>
  token?: string | null
}[]
let modelsResponse: () => Response
let responseError: { path: string; message: string; status: number } | undefined
let lostStartResponse: boolean
let navigate: ReturnType<typeof vi.fn<(anchor: ReviewAnchor) => void>>

function Harness() {
  controller = useReview()
  const content = (
    <>
      {panelVisible && <AgentReviewPanel review={controller} onNavigate={navigate} />}
      {inlineFinding && (
        <AgentFinding
          runId="run-1"
          finding={snapshot.agentReviews![0]!.findings[0]!}
          review={controller}
          onNavigate={navigate}
        />
      )}
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
function button(label: string) {
  return [...container.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  )
}
async function click(label: string) {
  expect(button(label), `Missing button ${label}`).toBeTruthy()
  await act(async () => button(label)!.click())
  await flush()
}
async function choose(label: string, value: string) {
  const input = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  await act(async () => {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}
async function editPrompt(value: string) {
  const input = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Review prompt"]',
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
    agent: { model: 'current', available: true },
    threads: [],
    drafts: [],
    publication: null,
    agentReviews: [],
  }
  requests = []
  modelsResponse = () => Response.json(catalog)
  responseError = undefined
  lostStartResponse = false
  panelVisible = true
  inlineFinding = false
  compact = false
  navigate = vi.fn()
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  qc.setQueryData(['review'], snapshot)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (path === '/api/session') return Response.json({ token: 'test-token' })
      if (path === '/api/review') return Response.json(snapshot)
      requests.push({
        path,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        token: new Headers(init?.headers).get('x-skepsis-token'),
      })
      if (path === '/api/agent-review/models') return modelsResponse()
      if (responseError?.path === path)
        return Response.json(
          { error: responseError.message },
          { status: responseError.status },
        )
      if (path === '/api/agent-review' && method === 'POST') {
        if (lostStartResponse) throw new Error('Response lost')
        snapshot.agentReviews!.push(
          run({
            id: requests.at(-1)!.body!.id as string,
            revision: requests.at(-1)!.body!.revision as string,
            status: 'queued',
            findings: [],
            summary: undefined,
          }),
        )
      } else if (path.endsWith('/cancel')) {
        snapshot.agentReviews!.find((item) => path.includes(item.id))!.status = 'cancelled'
      } else if (path.endsWith('/accept') || path.endsWith('/dismiss')) {
        const current = snapshot.agentReviews![0]!.findings[0]!
        current.status = path.endsWith('/accept') ? 'accepted' : 'dismissed'
        if (current.status === 'accepted')
          snapshot.drafts.push({
            id: current.id,
            anchor: current.anchor,
            body: current.body,
          })
      } else {
        throw new Error(`Unexpected request: ${path}`)
      }
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

it('opens without inference, defaults to the current model, uses only its reasoning levels, and retains custom prompt after refresh/remount', async () => {
  expect(requests).toEqual([])
  await click('Agent Review')
  expect(requests.map((request) => request.path)).toEqual(['/api/agent-review/models'])
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
    DEFAULT_REVIEW_PROMPT,
  )
  expect(
    container.querySelector<HTMLSelectElement>('select[aria-label="Agent model"]')!.value,
  ).toBe(JSON.stringify(['default-provider', 'current']))
  expect(
    [
      ...container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning"]')!
        .options,
    ]
      .filter((option) => option.value)
      .map((option) => option.value),
  ).toEqual(['low', 'high'])
  await choose('Reasoning', 'high')
  await editPrompt('Focus on **input validation** and race conditions.')
  await click('Start review')
  expect(requests.at(-1)!.body).toMatchObject({
    model: { provider: 'default-provider', modelId: 'current' },
    reasoningLevel: 'high',
  })
  expect(button('Agent Review')!.getAttribute('aria-expanded')).toBe('false')
  await click('Agent Review')
  await choose('Agent model', JSON.stringify(['other', 'quick']))
  expect(
    [
      ...container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning"]')!
        .options,
    ]
      .filter((option) => option.value)
      .map((option) => option.value),
  ).toEqual(['off'])
  expect(
    container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning"]')!.value,
  ).toBe('off')
  await click('Start review')
  expect(requests.at(-1)!.body).toMatchObject({
    model: { provider: 'other', modelId: 'quick' },
    reasoningLevel: 'off',
  })
  await update()
  panelVisible = false
  await render()
  panelVisible = true
  await render()
  await click('Agent Review')
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
    'Focus on **input validation** and race conditions.',
  )
  expect(requests.filter(({ method }) => method === 'POST')).toHaveLength(2)
  await click('Start review')
  expect(requests.at(-1)).toMatchObject({
    path: '/api/agent-review',
    method: 'POST',
    token: 'test-token',
    body: {
      revision: 'rev',
      prompt: 'Focus on **input validation** and race conditions.',
      model: { provider: 'default-provider', modelId: 'current' },
      reasoningLevel: 'low',
    },
  })
  expect(requests.at(-1)!.body!.id).toMatch(/^[a-f\d-]{36}$/)
  expect(snapshot.drafts).toEqual([])
  expect(snapshot.publication).toBeNull()
  expect(requests.some(({ path }) => path === '/api/review/submit')).toBe(false)
})

it('closes the compact setup after starting, keeps progress in the toolbar, and preserves selections', async () => {
  compact = true
  await render()
  const trigger = () =>
    container.querySelector<HTMLButtonElement>('[data-tool="agent"] .review-tool-trigger')!
  const popup = () => container.querySelector<HTMLDivElement>('.review-tools-popover')!
  expect(popup().hidden).toBe(true)
  await act(async () => trigger().click())
  await flush()
  await choose('Reasoning', 'high')
  await editPrompt('Review only the parser.')
  await click('Start review')
  expect(popup().hidden).toBe(true)
  expect(container.querySelector('.review-tools-actions')!.textContent).toContain('Queued')
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  await act(async () => trigger().click())
  await flush()
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
    'Review only the parser.',
  )
  expect(
    container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning"]')!.value,
  ).toBe('high')
})

it('retries an uncertain start using the same durable ID and never clears the custom prompt', async () => {
  await click('Agent Review')
  await editPrompt('Only verify the parser.')
  lostStartResponse = true
  await click('Start review')
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('Response lost')
  const first = requests.at(-1)!.body
  lostStartResponse = false
  await click('Start review')
  expect(requests.at(-1)!.body).toEqual(first)
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
    'Only verify the parser.',
  )
})

it('shows private pending markdown; explicit accept saves a draft without selecting or publishing', async () => {
  snapshot.agentReviews = [run()]
  await update()
  const suggestion = container.querySelector('.agent-finding')!
  expect(suggestion.textContent).toContain('Pending suggestion')
  expect(suggestion.textContent).toContain('issue (blocking): Check bounds')
  expect(suggestion.querySelector('strong')?.textContent).toBe('Pending suggestion')
  expect(suggestion.querySelector('img, script')).toBeNull()
  expect(suggestion.textContent).toContain('[Image: tracker]')
  expect(container.textContent).toContain('Look for regressions.')
  expect(requests).toEqual([])
  await click('Show in diff')
  expect(navigate).toHaveBeenCalledWith(anchor)
  await click('Accept for review')
  expect(requests).toMatchObject([
    {
      path: '/api/agent-review/run-1/findings/finding-1/accept',
      method: 'POST',
      token: 'test-token',
    },
  ])
  expect(container.textContent).toContain('Saved as review draft')
  expect(button('Accept for review')).toBeUndefined()
  expect(snapshot.publication).toBeNull()
  expect(requests.some(({ path }) => path === '/api/review/submit')).toBe(false)
})

it('supports inline findings, explicit dismiss, and no duplicate accept for saved findings', async () => {
  snapshot.agentReviews = [run({ findings: [{ ...finding, status: 'accepted' }] })]
  snapshot.drafts = [{ id: finding.id, anchor: finding.anchor, body: finding.body }]
  panelVisible = false
  inlineFinding = true
  await render()
  await update()
  expect(container.textContent).toContain('Saved as review draft')
  expect(container.textContent).not.toContain('Pending suggestion')
  snapshot.drafts = []
  await update()
  expect(container.textContent).toContain('Accepted — draft removed')
  expect(container.textContent).not.toContain('Saved as review draft')
  expect(button('Accept for review')).toBeUndefined()
  expect(requests).toEqual([])
  snapshot.agentReviews![0]!.findings[0]!.status = 'pending'
  await update()
  await click('Dismiss')
  expect(requests).toMatchObject([
    { path: '/api/agent-review/run-1/findings/finding-1/dismiss', method: 'POST' },
  ])
  expect(container.textContent).toContain('Dismissed')
  expect(button('Accept for review')).toBeUndefined()
})

it('blocks outdated accept and displays mutation errors without changing findings', async () => {
  snapshot.agentReviews = [run()]
  await update()
  snapshot.revision = 'new-revision'
  await update()
  expect(container.textContent).toContain('Outdated — diff changed')
  expect(button('Accept for review')!.disabled).toBe(true)
  expect(requests).toEqual([])
  snapshot.revision = 'rev'
  await update()
  responseError = {
    path: '/api/agent-review/run-1/findings/finding-1/accept',
    message: 'Unable to save draft',
    status: 503,
  }
  await click('Accept for review')
  expect(container.querySelector('.agent-finding [role="alert"]')!.textContent).toContain(
    'Unable to save draft',
  )
  expect(snapshot.agentReviews[0]!.findings[0]!.status).toBe('pending')
})

it('shows streaming, summary and errors, and cancels only through the review control mutation', async () => {
  snapshot.agentReviews = [
    run({
      status: 'running',
      partial: 'Reading **the patch**…',
      turns: [{ id: 'turn', question: 'Review the diff', error: 'Could not inspect file' }],
    }),
  ]
  await update()
  expect(container.textContent).toContain('Agent is writing…')
  expect(container.textContent).toContain('Reading the patch')
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    'Could not inspect file',
  )
  responseError = {
    path: '/api/agent-review/run-1/cancel',
    message: 'Cancellation failed',
    status: 503,
  }
  await click('Stop review')
  expect(container.textContent).toContain('Cancellation failed')
  responseError = undefined
  await click('Stop review')
  expect(requests.at(-1)).toMatchObject({
    path: '/api/agent-review/run-1/cancel',
    method: 'POST',
    token: 'test-token',
  })
  expect(container.textContent).toContain('cancelled')
  expect(button('Stop review')).toBeUndefined()
})

it('falls back to the first model and blocks a selection removed from the catalog', async () => {
  modelsResponse = () =>
    Response.json({
      models: [catalog.models[0]],
      defaultModel: { provider: 'missing', modelId: 'not-installed' },
    })
  await click('Agent Review')
  expect(
    container.querySelector<HTMLSelectElement>('select[aria-label="Agent model"]')!.value,
  ).toBe(JSON.stringify(['other', 'quick']))
  expect(
    container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning"]')!.value,
  ).toBe('off')
  await choose('Agent model', JSON.stringify(['other', 'quick']))
  modelsResponse = () =>
    Response.json({
      models: [catalog.models[1]],
      defaultModel: { provider: 'default-provider', modelId: 'current' },
    })
  await act(async () => qc.invalidateQueries({ queryKey: ['agent-review-models'] }))
  await flush()
  expect(button('Start review')!.disabled).toBe(true)
  await choose('Agent model', JSON.stringify(['default-provider', 'current']))
  expect(button('Start review')!.disabled).toBe(false)
  expect(requests.every(({ method }) => method === 'GET')).toBe(true)
})

it('disables submission for unavailable agent, empty prompt, invalid models/reasoning, and catalog errors', async () => {
  snapshot.agent.available = false
  snapshot.agent.error = 'Use a configured provider'
  await update()
  await click('Agent Review')
  expect(container.textContent).toContain('Agent unavailable: Use a configured provider')
  expect(button('Start review')!.disabled).toBe(true)
  expect(requests).toEqual([])
  snapshot.agent.available = true
  await update()
  await flush()
  expect(button('Start review')!.disabled).toBe(false)
  await editPrompt(' \n ')
  expect(button('Start review')!.disabled).toBe(true)
  await editPrompt('Check the diff')
  modelsResponse = () =>
    Response.json({
      models: [{ provider: 'other', modelId: 'quick', name: 'Quick', reasoningLevels: [] }],
      defaultModel: null,
    })
  await act(async () => qc.invalidateQueries({ queryKey: ['agent-review-models'] }))
  await flush()
  expect(button('Start review')!.disabled).toBe(true)
  modelsResponse = () => Response.json({ error: 'Models unavailable' }, { status: 503 })
  await act(async () => qc.invalidateQueries({ queryKey: ['agent-review-models'] }))
  await flush()
  expect(container.textContent).toContain('Models: Models unavailable')
  expect(button('Start review')!.disabled).toBe(true)
  expect(requests.every(({ method }) => method === 'GET')).toBe(true)
})
