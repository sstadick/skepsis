// @vitest-environment happy-dom
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ReviewTool, ReviewToolbar, useReviewTool } from './ReviewToolbar.tsx'

let container: HTMLDivElement
let root: Root
const start = vi.fn()
function Agent({ running }: { running: boolean }) {
  const { setOpen } = useReviewTool('agent')
  const [prompt, setPrompt] = useState('Keep this prompt')
  return (
    <ReviewTool
      id="agent"
      heading="Agent Review"
      className="agent-review-panel"
      actions={running && <span role="status">Reviewing…</span>}
    >
      <textarea
        aria-label="Prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <button
        type="button"
        onClick={() => {
          start()
          setOpen(false)
        }}
      >
        Start review
      </button>
    </ReviewTool>
  )
}
async function render(running = false) {
  await act(async () =>
    root.render(
      <>
        <ReviewToolbar>
          <ReviewTool id="review" heading="Review" className="durable-review-panel">
            <textarea aria-label="Summary" defaultValue="Private draft" />
          </ReviewTool>
          <Agent running={running} />
          <ReviewTool
            id="github"
            heading="GitHub comments"
            className="github-comments-panel"
          >
            <p>Published discussion</p>
          </ReviewTool>
        </ReviewToolbar>
        <button type="button" id="outside">
          Diff
        </button>
      </>,
    ),
  )
}
const trigger = (id: string) =>
  container.querySelector<HTMLButtonElement>(`[data-tool="${id}"] .review-tool-trigger`)!
const panel = (id: string) =>
  document.getElementById(trigger(id).getAttribute('aria-controls')!)!
const popup = () => container.querySelector<HTMLDivElement>('.review-tools-popover')!
const click = async (element: HTMLElement) => act(async () => element.click())

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  start.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await render()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('keeps every tool in one action group, with panels outside the action row and closed by default', () => {
  const actions = container.querySelector('[aria-label="Review tools"]')!
  expect(actions.querySelectorAll('.review-tool')).toHaveLength(3)
  expect(actions.querySelector('textarea, .review-tool-content')).toBeNull()
  expect(popup().hidden).toBe(true)
  for (const id of ['review', 'agent', 'github']) {
    expect(panel(id).hidden).toBe(true)
    expect(trigger(id).getAttribute('aria-expanded')).toBe('false')
  }
  expect(start).not.toHaveBeenCalled()
})

it('switches one panel at a time without unmounting editors or losing input and selection', async () => {
  await click(trigger('review'))
  const summary = panel('review').querySelector('textarea')!
  summary.value = 'Unsaved summary'
  summary.setSelectionRange(2, 6)
  await click(trigger('github'))
  expect(panel('review').hidden).toBe(true)
  expect(panel('github').hidden).toBe(false)
  await click(trigger('review'))
  expect(panel('review').querySelector('textarea')).toBe(summary)
  expect(summary.value).toBe('Unsaved summary')
  expect(summary.selectionStart).toBe(2)
  expect(summary.selectionEnd).toBe(6)
  await click(trigger('review'))
  expect(popup().hidden).toBe(true)
})

it('closes on Escape or the close button and restores focus; outside clicks do not steal focus', async () => {
  await click(trigger('agent'))
  const input = panel('agent').querySelector('textarea')!
  input.focus()
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  )
  expect(popup().hidden).toBe(true)
  expect(document.activeElement).toBe(trigger('agent'))
  await click(trigger('github'))
  await click(
    container.querySelector<HTMLButtonElement>('[aria-label="Close review tools"]')!,
  )
  expect(document.activeElement).toBe(trigger('github'))
  await click(trigger('agent'))
  const outside = container.querySelector<HTMLButtonElement>('#outside')!
  outside.focus()
  await act(async () =>
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
  )
  expect(popup().hidden).toBe(true)
  expect(document.activeElement).toBe(outside)
})

it('does not close when interacting inside a panel and does not reopen on background updates', async () => {
  await click(trigger('agent'))
  const input = panel('agent').querySelector('textarea')!
  await act(async () =>
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
  )
  expect(popup().hidden).toBe(false)
  await click(panel('agent').querySelector('button')!)
  expect(start).toHaveBeenCalledOnce()
  expect(popup().hidden).toBe(true)
  await render(true)
  expect(popup().hidden).toBe(true)
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Reviewing…')
  await click(trigger('agent'))
  expect(panel('agent').querySelector('textarea')).toBe(input)
  expect(input.value).toBe('Keep this prompt')
})
