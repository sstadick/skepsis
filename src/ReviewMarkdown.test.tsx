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
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ReviewMarkdown, safeReviewUrl } from './ReviewMarkdown.tsx'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(text: string) {
  await act(async () => root.render(<ReviewMarkdown text={text} />))
}

it('renders headings, GFM tables, lists, tasks, inline code and fenced code semantically', async () => {
  await render(
    '# Findings\n\n## Details\n\nA **bold** and ~~old~~ `value`.\n\n> A note\n\n1. First\n2. Second\n\n- [x] Checked\n- [ ] Pending\n\n| File | Result |\n| --- | --- |\n| a.ts | OK |\n\n```diff\n- old\n+ new\n```',
  )
  expect(container.querySelector('h1')?.textContent).toBe('Findings')
  expect(container.querySelector('h2')?.textContent).toBe('Details')
  expect(container.querySelector('strong')?.textContent).toBe('bold')
  expect(container.querySelector('del')?.textContent).toBe('old')
  expect(container.querySelector('p > code')?.textContent).toBe('value')
  expect(container.querySelector('blockquote')?.textContent).toContain('A note')
  expect(container.querySelectorAll('ol li')).toHaveLength(2)
  const tasks = [...container.querySelectorAll<HTMLInputElement>('input')]
  expect(tasks.map((task) => [task.type, task.checked, task.disabled])).toEqual([
    ['checkbox', true, true],
    ['checkbox', false, true],
  ])
  expect(
    container.querySelector('[aria-label="Markdown table"] table th')?.textContent,
  ).toBe('File')
  expect(container.querySelector('td')?.textContent).toBe('a.ts')
  expect(container.querySelector('.review-code-language')?.textContent).toBe('diff')
  expect(container.querySelector('pre code')?.textContent).toBe('- old\n+ new\n')
})

it('disables raw HTML, scripts and embeds, and replaces every image with inert alt text', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await render(`Before <b>plain</b> after

<script>window.evil = true</script>

<iframe src="https://tracker.example/embed"></iframe>

<style>body { display: none }</style>

<img src="/api/session" onerror="window.evil = true">

<video src="https://tracker.example/video"></video>

<object data="https://tracker.example/object"></object>

![Tracking pixel](https://tracker.example/pixel.png)

![Local file](/api/session)

![Data](data:image/svg+xml,evil)

![Reference][image]

[image]: https://tracker.example/ref.png`)
  expect(
    container.querySelector('script, style, iframe, img, video, audio, object, embed, b'),
  ).toBeNull()
  expect(container.querySelector('[src], [srcset], [onerror]')).toBeNull()
  expect(container.querySelectorAll('.review-image-placeholder')).toHaveLength(4)
  expect(container.textContent).toContain('[Image: Tracking pixel]')
  expect(container.textContent).toContain('[Image: Local file]')
  expect(fetch).not.toHaveBeenCalled()
})

it('allows only explicit HTTP(S), mailto and fragment links, with safe external link attributes', async () => {
  await render(
    '[HTTPS](https://example.com/path?q=1) [HTTP](http://example.com) [Email](mailto:review@example.com) [Section](#details)\n\n[JS](javascript:alert%281%29) [Encoded](jav&#x61;script:alert%281%29) [Data](data:text/html,evil) [Relative](/api/session) [Protocol relative](//tracker.example) [FTP](ftp://example.com) [File](file:///etc/passwd)',
  )
  expect(
    [...container.querySelectorAll('a')].map((link) => link.getAttribute('href')),
  ).toEqual([
    'https://example.com/path?q=1',
    'http://example.com',
    'mailto:review@example.com',
    '#details',
  ])
  const external = container.querySelector('a')!
  expect(external.target).toBe('_blank')
  expect(external.rel).toBe('noopener noreferrer')
  expect(container.querySelector('a[href="#details"]')?.hasAttribute('target')).toBe(false)
  expect(container.textContent).toContain('Encoded')
  expect(container.textContent).toContain('Protocol relative')
})

it.each([
  'javascript:alert(1)',
  'java\nscript:alert(1)',
  'https://example.com\u0000/x',
  ' https://example.com',
  'https://',
  'https://user:secret@example.com',
  '//example.com',
  '/api/session',
  'relative.md',
  'data:image/png,abc',
  'vbscript:evil',
  'mailto:',
  'mailto:a@example.com\nBcc:someone',
])('rejects unsafe URL %j', (url) => {
  expect(safeReviewUrl(url)).toBeUndefined()
})

it('copies code including indentation, tabs, trailing spaces and blank lines, not Markdown fences', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const code = '  return `value`;  \n\tkeep();\n\n'
  await render('```suggestion\n' + code + '```')
  expect(container.querySelector('.review-code-language')?.textContent).toBe('suggestion')
  expect(container.querySelector('pre')?.textContent).toBe(code)
  await act(async () => container.querySelector('button')!.click())
  expect(writeText).toHaveBeenCalledExactlyOnceWith(code)
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Copied')
})

it.each(['rejected', 'unavailable'])(
  'handles a %s clipboard without losing code or leaking a rejection',
  async (reason) => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'))
    vi.stubGlobal('navigator', {
      clipboard: reason === 'rejected' ? { writeText } : undefined,
    })
    await render('```ts\nconst value = 1\n```')
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not copy',
    )
    expect(container.querySelector('pre')?.textContent).toBe('const value = 1\n')
    expect(container.querySelector('button')?.disabled).toBe(false)
  },
)

it('tolerates incomplete streaming Markdown and resets code copy feedback as it changes', async () => {
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
  await render('```js\nconst')
  await act(async () => container.querySelector('button')!.click())
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Copied')
  await render('```js\nconst value = 1\n```\n\n**Done**')
  expect(container.querySelector('[role="status"]')).toBeNull()
  expect(container.querySelector('pre')?.textContent).toBe('const value = 1\n')
  expect(container.querySelector('strong')?.textContent).toBe('Done')
})

it.each(['resolved', 'rejected'])(
  'ignores a %s clipboard result for an older streaming chunk',
  async (result) => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const writeText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((yes, no) => {
            resolve = yes
            reject = no
          }),
      )
      .mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await render('```ts\nconst old')
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('button')?.disabled).toBe(true)
    await render('```ts\nconst updated = 1\n```')
    expect(container.querySelector('button')?.disabled).toBe(false)
    await act(async () => {
      if (result === 'resolved') resolve()
      else reject(new Error('Permission denied'))
    })
    expect(container.querySelector('[role="status"], [role="alert"]')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe('const updated = 1\n')
    await act(async () => container.querySelector('button')!.click())
    expect(writeText.mock.calls).toEqual([['const old\n'], ['const updated = 1\n']])
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Copied')
  },
)

it('never emits form submit buttons or active controls from raw HTML', async () => {
  await render(
    '```ts\nconst value = 1\n```\n\n<form action="/api/review/submit"><button>Submit</button></form>\n\n<input type="image" src="https://tracker.example/pixel">',
  )
  expect(container.querySelector('form, input')).toBeNull()
  expect([...container.querySelectorAll('button')].map((button) => button.type)).toEqual([
    'button',
  ])
})
