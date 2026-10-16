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
import {
  LineChat,
  ReviewPanel,
  anchorKey,
  useReview,
  type ReviewController,
} from './ReviewPanel.tsx'
import { PUBLICATION_ABANDON_ACK, type ReviewSnapshot } from '../shared/review.ts'

const anchor = { path: 'file.ts', side: 'RIGHT' as const, line: 1, revision: 'old' }
let snapshot: ReviewSnapshot
let controller: ReviewController
let container: HTMLDivElement
let root: Root
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
