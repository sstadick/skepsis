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
import type { HunkPriority, PrioritySnapshot } from '../shared/priorities.ts'
import type { ReviewAnchor } from '../shared/review.ts'
import {
  currentPriorities,
  HunkPriorities,
  HunkPriorityNote,
  useHunkPriorities,
} from './HunkPriorities.tsx'

const anchor = { path: 'file.ts', side: 'RIGHT' as const, line: 3, revision: 'rev' }
const hunk: HunkPriority = {
  id: 'hunk',
  path: anchor.path,
  header: '@@ -1,3 +1,3 @@',
  anchor,
  status: 'scored',
  score: 3.2,
  confidence: 0.85,
  category: 'correctness',
}
let snapshot: PrioritySnapshot
let container: HTMLDivElement
let root: Root
let qc: QueryClient
let controller: ReturnType<typeof useHunkPriorities>
let navigate = vi.fn<(anchor: ReviewAnchor) => void>()
let posts: { path: string; body: { id: string; revision: string }; token: string | null }[]
let loseResponse: boolean
let revision: string
function Harness() {
  controller = useHunkPriorities(revision, true)
  return (
    <HunkPriorities priorities={controller} revision={revision} onNavigate={navigate} />
  )
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
  await act(async () => qc.setQueryData(['priorities'], structuredClone(snapshot)))
  await flush()
}
function button(label: string) {
  return [...container.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  )!
}
async function click(label: string) {
  expect(button(label)).toBeTruthy()
  await act(async () => button(label).click())
  await flush()
}
beforeEach(async () => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  snapshot = {
    revision: 'rev',
    status: 'idle',
    available: true,
    results: [],
    completed: 0,
    total: 0,
  }
  revision = 'rev'
  posts = []
  loseResponse = false
  navigate = vi.fn()
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/session') return Response.json({ token: 'test-token' })
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        posts.push({ path, body, token: new Headers(init.headers).get('x-skepsis-token') })
        if (loseResponse) throw new Error('Response lost')
        snapshot = {
          ...snapshot,
          runId: body.id,
          status: path.endsWith('/cancel') ? 'cancelled' : 'running',
        }
      }
      if (path.startsWith('/api/priorities')) return Response.json(snapshot)
      throw new Error(`Unexpected request ${path}`)
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

it('keeps the action visible with explicit configuration guidance; GET never starts inference', async () => {
  snapshot.available = false
  snapshot.unavailableReason = 'Set --classifier-config and restart to enable scoring'
  await update()
  expect(button('Prioritize hunks').disabled).toBe(true)
  expect(button('Prioritize hunks').title).toContain('--classifier-config')
  await click('Show priorities')
  expect(container.textContent).toContain('Set --classifier-config')
  expect(posts).toEqual([])
})

it('authenticates explicit starts, reuses an uncertain request ID, and cancels the exact run', async () => {
  expect(posts).toEqual([])
  loseResponse = true
  await click('Prioritize hunks')
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('Response lost')
  expect(posts).toHaveLength(1)
  expect(posts[0]!.token).toBe('test-token')
  expect(posts[0]!.body.revision).toBe('rev')
  expect(posts[0]!.body.id).toMatch(/^[a-f\d-]{36}$/)
  loseResponse = false
  await click('Prioritize hunks')
  expect(posts[1]!.body).toEqual(posts[0]!.body)
  expect(button('Prioritize hunks').disabled).toBe(true)
  await click('Stop scoring')
  expect(posts[2]).toMatchObject({
    path: '/api/priorities/cancel',
    body: posts[0]!.body,
    token: 'test-token',
  })
  expect(container.textContent).toContain('stopped')
})

it('ranks continuous scores without inventing scores for failed hunks and navigates left anchors', async () => {
  snapshot = {
    ...snapshot,
    status: 'complete',
    completed: 3,
    total: 3,
    results: [
      { ...hunk, id: 'low', score: 0 },
      {
        ...hunk,
        id: 'high',
        anchor: { ...anchor, side: 'LEFT' },
        score: 3.9,
        confidence: 0.3,
      },
      {
        ...hunk,
        id: 'failed',
        status: 'failed',
        score: undefined,
        error: 'Classifier could not score this hunk',
      },
    ],
  }
  await update()
  await click('Show priorities')
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-priority-id]')]
  expect(rows.map((row) => row.dataset.priorityId)).toEqual(['high', 'low', 'failed'])
  expect(rows[0]!.textContent).toContain('Critical · 3.9/4')
  expect(rows[0]!.textContent).toContain('Uncertain — inspect manually')
  expect(rows[1]!.textContent).toContain('Minimal · 0.0/4')
  expect(rows[2]!.textContent).toContain('Not scored')
  expect(rows[2]!.textContent).not.toContain('/4')
  await act(async () => rows[0]!.click())
  expect(navigate).toHaveBeenCalledWith({ ...anchor, side: 'LEFT' })
  expect(button('Show priorities').getAttribute('aria-expanded')).toBe('false')
  expect(posts).toEqual([])
})

it('hides stale scores on a new displayed revision and never auto-rescores', async () => {
  snapshot = { ...snapshot, status: 'complete', total: 1, completed: 1, results: [hunk] }
  await update()
  await click('Show priorities')
  expect(container.querySelectorAll('[data-priority-id]')).toHaveLength(1)
  revision = 'new-revision'
  await render()
  expect(controller.results).toEqual([])
  expect(container.querySelectorAll('[data-priority-id]')).toHaveLength(0)
  expect(container.textContent).toContain('Diff changed — prioritize again')
  expect(currentPriorities({ ...snapshot, status: 'stale' }, 'rev')).toEqual([])
  expect(posts).toEqual([])
})

it('renders a private discussion action separately from scoring without sending anything', async () => {
  const discuss = vi.fn()
  await act(async () => root.render(<HunkPriorityNote hunk={hunk} onDiscuss={discuss} />))
  expect(container.textContent).toContain('High · 3.2/4')
  await click('Discuss hunk')
  expect(discuss).toHaveBeenCalledOnce()
  expect(posts).toEqual([])
})
