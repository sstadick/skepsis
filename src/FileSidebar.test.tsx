// @vitest-environment happy-dom
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { act, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parsePatchFiles } from '@pierre/diffs'
import type { CodeViewProps } from '@pierre/diffs/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  buildFileTree,
  FileSidebar,
  FileSidebarToggle,
  sidebarFiles,
  useFileSidebarOpen,
  type SidebarFile,
} from './FileSidebar.tsx'
import { App } from './App.tsx'
import type { DiffResponse } from '../shared/types.ts'
import type { HunkPriority, PrioritySnapshot } from '../shared/priorities.ts'
import { PriorityBadge } from './HunkPriorities.tsx'

// Exercise App's controlled-item/ref boundary without a syntax worker or layout
// engine. No server, model, GitHub, or source-writing requests are involved.
let codeViewProps: CodeViewProps<unknown>
const scrollTo = vi.fn()
const clearSelectedLines = vi.fn()
vi.mock('@pierre/diffs/react', async () => {
  const { useImperativeHandle } = await import('react')
  return {
    CodeView: function MockCodeView(
      props: CodeViewProps<unknown> & { ref?: Ref<unknown> },
    ) {
      codeViewProps = props
      useImperativeHandle(props.ref, () => ({
        scrollTo,
        getInstance: () => ({
          getTopForItem: (id: string) =>
            (props.items?.findIndex((item) => item.id === id) ?? 0) * 100,
          getRenderedItems: () =>
            props.items?.map((item) => ({
              id: item.id,
              type: item.type,
              instance: {
                getLinePosition: (line: number) => ({
                  top: 40 + (line - 1) * 20,
                  height: 20,
                }),
              },
            })) ?? [],
          getHeight: () => 600,
          setSelectedLines: () => {},
          clearSelectedLines,
        }),
      }))
      return (
        <div className={props.className}>
          {props.items?.map((item) => (
            <section key={item.id}>
              {props.renderCustomHeader?.(item)}
              {item.annotations?.map((annotation) => (
                <div key={JSON.stringify(annotation)}>
                  {props.renderAnnotation?.(annotation, item)}
                </div>
              ))}
            </section>
          ))}
        </div>
      )
    },
  }
})

const patch = `diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
index 2222222..0000000
--- a/src/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/src/modified.ts b/src/modified.ts
index 3333333..4444444 100644
--- a/src/modified.ts
+++ b/src/modified.ts
@@ -1 +1 @@
-old
+new
diff --git a/old/name.ts b/lib/new.ts
similarity index 100%
rename from old/name.ts
rename to lib/new.ts
`
const originals = parsePatchFiles(patch).flatMap((p) => p.files)
const hashes = {
  'src/added.ts': 'added',
  'src/deleted.ts': 'deleted',
  'src/modified.ts': 'modified',
  'lib/new.ts': 'renamed',
}
const viewed = { 'src/added.ts': 'added', 'src/modified.ts': 'outdated' }
const entries = sidebarFiles(originals, hashes, viewed)
const file = (path: string, oldPath?: string): SidebarFile => ({
  path,
  oldPath,
  change: oldPath ? 'R' : 'M',
  additions: 1,
  deletions: 0,
  viewed: 'unviewed',
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  scrollTo.mockClear()
  clearSelectedLines.mockClear()
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
async function click(target: HTMLButtonElement | null | undefined) {
  expect(target).toBeTruthy()
  await act(async () => target!.click())
}
function button(text: string) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === text)
}
async function filter(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      value,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function sidebarButton(path: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('.file-sidebar-file')].find(
    (b) => b.title.split('\n')[0] === path,
  )
}
async function interactWithLine(
  path: string,
  side: 'additions' | 'deletions',
  lineNumber: number,
  action: 'click' | 'hover' = 'click',
) {
  const item = codeViewProps.items!.find((entry) => entry.id === path)!
  const element = document.createElement('span')
  const handler =
    action === 'click'
      ? codeViewProps.options?.onLineNumberClick
      : codeViewProps.options?.onLineEnter
  expect(handler).toBeTypeOf('function')
  await act(async () =>
    handler!(
      {
        type: 'diff-line',
        annotationSide: side,
        lineNumber,
        lineType: side === 'deletions' ? 'change-deletion' : 'change-addition',
        lineElement: element,
        numberElement: element,
        numberColumn: true,
        event: new PointerEvent('click'),
      },
      { item } as never,
    ),
  ) // The handler reads only item, not native layout internals.
}

function ToggleHarness() {
  const [open, setOpen] = useFileSidebarOpen()
  return (
    <>
      <header>
        <FileSidebarToggle open={open} onToggle={() => setOpen((previous) => !previous)} />
      </header>
      <FileSidebar files={entries} focusedFile={null} open={open} onSelect={() => {}} />
    </>
  )
}

it('builds sorted folder paths without conflating repeated basenames or special keys', () => {
  const files = [
    file('z.ts'),
    file('src/deep/index.ts'),
    file('lib/index.ts'),
    file('__proto__/constructor'),
  ]
  const tree = buildFileTree(files)
  expect(tree.map((node) => [node.type, node.path])).toEqual([
    ['folder', '__proto__'],
    ['folder', 'lib'],
    ['folder', 'src'],
    ['file', 'z.ts'],
  ])
  expect(tree[2]).toMatchObject({
    children: [
      {
        path: 'src/deep',
        children: [{ path: 'src/deep/index.ts', name: 'index.ts', file: files[1] }],
      },
    ],
  })
  expect(files.map((f) => f.path)).toEqual([
    'z.ts',
    'src/deep/index.ts',
    'lib/index.ts',
    '__proto__/constructor',
  ])
})

it('filters full and old rename paths case-insensitively, retaining only matching ancestors', () => {
  const files = [file('src/a.ts'), file('lib/new name.ts', 'old/Original.ts')]
  expect(buildFileTree(files, ' ORIGINAL ')).toMatchObject([
    { path: 'lib', children: [{ path: 'lib/new name.ts' }] },
  ])
  expect(buildFileTree(files, 'src/')).toMatchObject([
    { path: 'src', children: [{ path: 'src/a.ts' }] },
  ])
  expect(buildFileTree(files, 'absent')).toEqual([])
  expect(buildFileTree([], '')).toEqual([])
})

it('keeps original A/M/D/R metadata, sums changed lines, and compares viewed hashes', () => {
  expect(entries).toEqual([
    {
      path: 'src/added.ts',
      oldPath: undefined,
      change: 'A',
      additions: 2,
      deletions: 0,
      viewed: 'viewed',
    },
    {
      path: 'src/deleted.ts',
      oldPath: undefined,
      change: 'D',
      additions: 0,
      deletions: 1,
      viewed: 'unviewed',
    },
    {
      path: 'src/modified.ts',
      oldPath: undefined,
      change: 'M',
      additions: 1,
      deletions: 1,
      viewed: 'stale',
    },
    {
      path: 'lib/new.ts',
      oldPath: 'old/name.ts',
      change: 'R',
      additions: 0,
      deletions: 0,
      viewed: 'unviewed',
    },
  ])
  const modified = originals.find((f) => f.type === 'change')!
  expect(
    sidebarFiles(
      [
        {
          ...modified,
          type: 'rename-changed',
          hunks: [...modified.hunks, ...modified.hunks],
        },
      ],
      {},
      viewed,
    )[0],
  ).toMatchObject({
    change: 'R',
    additions: 2,
    deletions: 2,
    viewed: 'unviewed',
  })
  expect(originals[0]!.type).toBe('new')
})

function scoredHunk(
  path: string,
  score: number,
  overrides: Partial<HunkPriority> = {},
): HunkPriority {
  return {
    id: `${path}-${score}`,
    path,
    header: '@@ -1 +1 @@',
    anchor: { path, side: 'RIGHT', line: 1, revision: 'revision' },
    status: 'scored',
    score,
    confidence: 0.9,
    ...overrides,
  }
}

it('colors a file by its highest hunk, never an average, retaining viewed and change indicators', async () => {
  const results = [0, 0.1, 3.8].map((score) => scoredHunk('src/added.ts', score))
  const files = sidebarFiles(originals, hashes, viewed, results)
  expect(files[0]!.priority).toMatchObject({
    score: 3.8,
    scored: 3,
    total: 3,
    uncertain: false,
  })
  const onSelect = vi.fn()
  await act(async () =>
    root.render(
      <FileSidebar files={files} focusedFile="src/added.ts" open onSelect={onSelect} />,
    ),
  )
  const added = sidebarButton('src/added.ts')!
  expect(added.dataset.level).toBe('critical')
  expect(added.querySelector('.file-sidebar-priority')!.textContent).toBe('3.8')
  expect(added.getAttribute('aria-label')).toContain('Critical review priority: 3.8/4')
  expect(added.title).toContain('3/3 hunks scored')
  expect(added.getAttribute('aria-current')).toBe('true')
  expect(added.querySelector('.file-sidebar-viewed')!.textContent).toBe('✓')
  expect(added.querySelector('.file-sidebar-change')!.textContent).toBe('A')
  expect(sidebarButton('lib/new.ts')!.hasAttribute('data-level')).toBe(false)
  await click(added)
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('src/added.ts')
})

it('marks partial and uncertain coverage without downgrading the highest score or assigning failed hunks zero', async () => {
  const results = [
    scoredHunk('src/added.ts', 1.1),
    scoredHunk('src/added.ts', 0, { confidence: 0.2 }),
    scoredHunk('src/added.ts', 4, { status: 'queued' }),
    scoredHunk('src/added.ts', 4, { status: 'failed' }),
    scoredHunk('src/added.ts', 4, { status: 'skipped' }),
    scoredHunk('src/deleted.ts', 4, { status: 'failed' }),
    scoredHunk('src/modified.ts', 4, { status: 'queued' }),
  ]
  await act(async () =>
    root.render(
      <FileSidebar
        files={sidebarFiles(originals, hashes, viewed, results)}
        focusedFile={null}
        open
        onSelect={() => {}}
      />,
    ),
  )
  const added = sidebarButton('src/added.ts')!
  expect(added.dataset.level).toBe('low')
  expect(added.querySelector('.file-sidebar-priority')!.textContent).toBe('1.1*?')
  expect(added.title).toContain(
    '2/5 hunks scored. 1 pending. 2 not scored. Uncertain results; inspect manually',
  )
  const failed = sidebarButton('src/deleted.ts')!
  expect(failed.dataset.level).toBe('unscored')
  expect(failed.querySelector('.file-sidebar-priority')!.textContent).toBe('—')
  expect(failed.title).toContain('Review priority not scored')
  const pending = sidebarButton('src/modified.ts')!
  expect(pending.dataset.level).toBe('pending')
  expect(pending.querySelector('.file-sidebar-priority')!.textContent).toBe('…')
  expect(pending.title).toContain('Review priority pending')
})

it('keeps highest-priority folder colors when collapsed and recomputes them for filtered descendants', async () => {
  const files = sidebarFiles(originals, hashes, viewed, [
    scoredHunk('src/added.ts', 3.7),
    scoredHunk('src/deleted.ts', 1.2),
  ])
  await act(async () =>
    root.render(<FileSidebar files={files} focusedFile={null} open onSelect={() => {}} />),
  )
  const folder = container.querySelector<HTMLButtonElement>(
    '[aria-label="Collapse folder src"]',
  )!
  expect(folder.dataset.level).toBe('critical')
  expect(folder.getAttribute('aria-description')).toContain('3.7/4')
  expect(folder.title).toContain('2/2 hunks scored')
  await click(folder)
  expect(folder.getAttribute('aria-expanded')).toBe('false')
  expect(folder.dataset.level).toBe('critical')
  await filter('deleted')
  expect(folder.getAttribute('aria-expanded')).toBe('true')
  expect(folder.dataset.level).toBe('low')
  expect(folder.querySelector('.file-sidebar-priority')!.textContent).toBe('1.2')
})

it.each([
  [0, 'minimal'],
  [0.49, 'minimal'],
  [0.5, 'low'],
  [1.49, 'low'],
  [1.5, 'normal'],
  [2.49, 'normal'],
  [2.5, 'high'],
  [3.49, 'high'],
  [3.5, 'critical'],
  [4, 'critical'],
] as const)(
  'uses the same %s score band (%s) in the sidebar and beside the hunk',
  async (score, level) => {
    const hunk = scoredHunk('src/added.ts', score)
    const files = sidebarFiles(originals, hashes, viewed, [hunk])
    await act(async () =>
      root.render(
        <>
          <FileSidebar files={files} focusedFile={null} open onSelect={() => {}} />
          <PriorityBadge hunk={hunk} />
        </>,
      ),
    )
    expect(sidebarButton('src/added.ts')!.dataset.level).toBe(level)
    expect(
      container.querySelector<HTMLElement>('.hunk-priority-badge')!.dataset.level,
    ).toBe(level)
    expect(
      sidebarButton('src/added.ts')!.querySelector('.file-sidebar-priority')!.textContent,
    ).toBe(score.toFixed(1))
  },
)

it('leaves invalid scores neutral instead of inventing colored zero/critical scores', async () => {
  const results = [NaN, Infinity, -0.1, 4.1].map((score) =>
    scoredHunk('src/added.ts', score),
  )
  results.push(scoredHunk('src/added.ts', 0, { score: undefined }))
  await act(async () =>
    root.render(
      <FileSidebar
        files={sidebarFiles(originals, hashes, viewed, results)}
        focusedFile={null}
        open
        onSelect={() => {}}
      />,
    ),
  )
  expect(sidebarButton('src/added.ts')!.dataset.level).toBe('unscored')
  expect(
    sidebarButton('src/added.ts')!.querySelector('.file-sidebar-priority')!.textContent,
  ).toBe('—')
  expect(sidebarButton('src/added.ts')!.title).toContain('0/5 hunks scored')
})

it('uses accessible navigation-only buttons with rename tooltip, counts, viewed status and current highlight', async () => {
  const onSelect = vi.fn()
  await act(async () =>
    root.render(
      <FileSidebar files={entries} focusedFile="src/added.ts" open onSelect={onSelect} />,
    ),
  )
  const added = sidebarButton('src/added.ts')!
  expect(added.getAttribute('aria-current')).toBe('true')
  expect(added.getAttribute('aria-label')).toContain('2 additions, 0 deletions, Viewed')
  expect(added.querySelector('.file-sidebar-viewed')!.textContent).toBe('✓')
  expect(sidebarButton('src/modified.ts')!.getAttribute('aria-label')).toContain(
    'Changed since viewed',
  )
  const renamed = sidebarButton('lib/new.ts')!
  expect(renamed.title).toContain('Renamed from old/name.ts')
  expect(renamed.getAttribute('aria-label')).toContain('renamed from old/name.ts')
  expect(renamed.textContent).toContain('R+0−0')
  expect(container.querySelector('input[type="checkbox"]')).toBeNull()
  await click(renamed)
  expect(onSelect.mock.calls).toEqual([['lib/new.ts']])
  // It is a controlled highlight, not optimistically marked viewed by a click.
  expect(added.getAttribute('aria-current')).toBe('true')
  await act(async () =>
    root.render(
      <FileSidebar files={entries} focusedFile="lib/new.ts" open onSelect={onSelect} />,
    ),
  )
  expect(renamed.getAttribute('aria-current')).toBe('true')
  expect(added.hasAttribute('aria-current')).toBe(false)
})

it('collapses folders independently and reveals filtered descendants without navigating', async () => {
  const onSelect = vi.fn()
  await act(async () =>
    root.render(
      <FileSidebar files={entries} focusedFile={null} open onSelect={onSelect} />,
    ),
  )
  const folder = container.querySelector<HTMLButtonElement>(
    '[aria-label="Collapse folder src"]',
  )!
  await click(folder)
  expect(folder.getAttribute('aria-expanded')).toBe('false')
  const children = document.getElementById(folder.getAttribute('aria-controls')!)!
  expect(children.hidden).toBe(true)
  expect(container.querySelector('label')!.htmlFor).toBe(
    container.querySelector('input')!.id,
  )
  await filter('ADDED')
  expect(children.hidden).toBe(false)
  expect(container.querySelectorAll('.file-sidebar-file')).toHaveLength(1)
  await filter('no such file')
  expect(container.querySelector('[role="status"]')!.textContent).toBe('No matching files')
  expect(onSelect).not.toHaveBeenCalled()
})

it('keeps a header show/hide control, persists its state and retains the filter while closed', async () => {
  await act(async () => root.render(<ToggleHarness />))
  await filter('added')
  const toggle = button('Hide files')!
  expect(toggle.closest('header')).toBeTruthy()
  const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!
  await click(toggle)
  expect(toggle.textContent).toBe('Show files')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(panel.hidden).toBe(true)
  await act(async () => root.render(null))
  await act(async () => root.render(<ToggleHarness />))
  expect(button('Show files')!.getAttribute('aria-expanded')).toBe('false')
  await click(button('Show files'))
  await filter('added')
  await click(button('Hide files'))
  await click(button('Show files'))
  expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('added')
  expect(container.querySelector('aside')!.hidden).toBe(false)
})

it('still toggles when localStorage throws on reads and writes', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('full')
  })
  await act(async () => root.render(<ToggleHarness />))
  await click(button('Hide files'))
  expect(container.querySelector('aside')!.hidden).toBe(true)
  await click(button('Show files'))
  expect(container.querySelector('aside')!.hidden).toBe(false)
})

it('App expands and scrolls a selected file without marking viewed or resetting CodeView state', async () => {
  const response: DiffResponse = {
    patch,
    fileHashes: hashes,
    viewed,
    vcs: 'git',
    revset: 'git diff',
    expandable: false,
    reviewRevision: 'revision',
  }
  let prioritySnapshot: PrioritySnapshot = {
    revision: 'revision',
    status: 'idle',
    available: false,
    results: [],
    completed: 0,
    total: 0,
  }
  const events: EventTarget[] = []
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/api/diff') return Response.json(response)
    if (path === '/api/theme') return Response.json({ theme: 'system' })
    if (path === '/api/priorities') return Response.json(prioritySnapshot)
    if (path === '/api/review')
      return Response.json({
        revision: 'revision',
        pullRequest: null,
        agent: { available: false, model: 'disabled' },
        threads: [],
        drafts: [],
        publication: null,
      })
    throw new Error(`Unexpected request ${path}`)
  })
  const media = window.matchMedia('(min-width: 1060px)')
  Object.defineProperty(media, 'matches', { value: true })
  vi.spyOn(window, 'matchMedia').mockReturnValue(media)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      constructor() {
        super()
        events.push(this)
      }
      close() {}
    },
  )
  await act(async () => root.render(<App />))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const before = codeViewProps.items!.find((item) => item.id === 'src/added.ts')!
  expect(before.collapsed).toBe(true)
  expect(
    sidebarButton('src/added.ts')!.querySelector('.file-sidebar-change')!.textContent,
  ).toBe('A')
  expect(
    sidebarButton('src/deleted.ts')!.querySelector('.file-sidebar-change')!.textContent,
  ).toBe('D')
  await click(sidebarButton('src/added.ts'))
  const after = codeViewProps.items!.find((item) => item.id === 'src/added.ts')!
  expect(after.collapsed).toBe(false)
  expect(after.version).not.toBe(before.version)
  expect(scrollTo).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'item', id: 'src/added.ts', align: 'start' }),
  )
  expect(sidebarButton('src/added.ts')!.getAttribute('aria-current')).toBe('true')
  const items = codeViewProps.items
  const options = codeViewProps.options
  const diffNode = container.querySelector('.codeview-root')
  await click(button('Hide files'))
  await click(button('Show files'))
  expect(codeViewProps.items).toEqual(items)
  const previousDiff = items!.find((item) => item.type === 'diff')!
  const currentDiff = codeViewProps.items!.find((item) => item.type === 'diff')!
  expect(currentDiff.fileDiff).toBe(previousDiff.fileDiff)
  expect(codeViewProps.options).toBe(options)
  expect(container.querySelector('.codeview-root')).toBe(diffNode)
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' })))
  expect(sidebarButton('src/deleted.ts')!.getAttribute('aria-current')).toBe('true')
  expect(scrollTo).toHaveBeenLastCalledWith({
    type: 'item',
    id: 'src/deleted.ts',
    align: 'start',
  })
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' })))
  expect(sidebarButton('src/added.ts')!.getAttribute('aria-current')).toBe('true')
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })))
  expect(scrollTo).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'line', id: 'src/added.ts' }),
  )
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' })))
  expect(scrollTo).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'line', lineNumber: 1 }),
  )
  expect(codeViewProps.options!.diffStyle).toBe('split')
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' })))
  expect(codeViewProps.options!.diffStyle).toBe('unified')
  await click(button('Hide files'))
  await click(button('Show files'))
  expect(codeViewProps.options!.diffStyle).toBe('unified')
  const filterInput = container.querySelector<HTMLInputElement>('input[type="search"]')!
  const scrollCalls = scrollTo.mock.calls.length
  await act(async () =>
    filterInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })),
  )
  expect(scrollTo.mock.calls).toHaveLength(scrollCalls)
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' })))
  const composer = container.querySelector<HTMLTextAreaElement>(
    '.durable-line-chat textarea',
  )!
  expect(composer).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      composer,
      'Unsaved question',
    )
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(sidebarButton('lib/new.ts'))
  await click(button('Hide files'))
  await click(button('Show files'))
  expect(
    container.querySelector<HTMLTextAreaElement>('.durable-line-chat textarea')!.value,
  ).toBe('Unsaved question')
  // Scores share a native line slot with existing conversations, preserving
  // buffers. Ranked navigation targets LEFT deletions as well as RIGHT additions.
  prioritySnapshot = {
    revision: 'revision',
    status: 'complete',
    available: true,
    total: 2,
    completed: 2,
    results: [
      {
        id: 'added-score',
        path: 'src/added.ts',
        header: '@@ -0,0 +1,2 @@',
        anchor: { path: 'src/added.ts', side: 'RIGHT', line: 1, revision: 'revision' },
        status: 'scored',
        score: 2.7,
        confidence: 0.9,
      },
      {
        id: 'deleted-score',
        path: 'src/deleted.ts',
        header: '@@ -1 +0,0 @@',
        anchor: { path: 'src/deleted.ts', side: 'LEFT', line: 1, revision: 'revision' },
        status: 'scored',
        score: 3.8,
        confidence: 0.9,
      },
    ],
  }
  await act(async () => {
    events.at(-1)!.dispatchEvent(new Event('thread-changed'))
    await new Promise((r) => setTimeout(r, 40))
  })
  expect(container.querySelectorAll('.hunk-priority-note')).toHaveLength(2)
  expect(sidebarButton('src/added.ts')!.dataset.level).toBe('high')
  expect(sidebarButton('src/deleted.ts')!.dataset.level).toBe('critical')
  expect(
    codeViewProps.items!.find((item) => item.id === 'src/added.ts')!.annotations,
  ).toHaveLength(1)
  expect(
    container.querySelector<HTMLTextAreaElement>('.durable-line-chat textarea')!.value,
  ).toBe('Unsaved question')
  await click(button('Show priorities'))
  await click(
    container.querySelector<HTMLButtonElement>('[data-priority-id="deleted-score"]'),
  )
  expect(scrollTo).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: 'line',
      id: 'src/deleted.ts',
      lineNumber: 1,
      side: 'deletions',
    }),
  )
  expect(sidebarButton('src/deleted.ts')!.getAttribute('aria-current')).toBe('true')
  // Direct old/new number clicks must work independently of the hunk shortcut,
  // including with the agent disabled (draft comments are still available).
  // A sidebar/keyboard highlight must not pin the native hover + to that line.
  await click(sidebarButton('src/added.ts'))
  clearSelectedLines.mockClear()
  await interactWithLine('src/deleted.ts', 'deletions', 1, 'hover')
  expect(clearSelectedLines).toHaveBeenCalledWith({ notify: false })
  const clears = clearSelectedLines.mock.calls.length
  await interactWithLine('src/added.ts', 'additions', 2, 'hover')
  expect(clearSelectedLines).toHaveBeenCalledTimes(clears)
  expect(
    codeViewProps.items!.find((item) => item.id === 'src/deleted.ts')!.annotations,
  ).toHaveLength(1)
  expect(codeViewProps.options?.onLineClick).toBeUndefined()
  await interactWithLine('src/deleted.ts', 'deletions', 1)
  expect(
    codeViewProps.items!.find((item) => item.id === 'src/deleted.ts')!.annotations,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        lineNumber: 1,
        side: 'deletions',
        metadata: expect.objectContaining({
          conversation: true,
          anchor: { path: 'src/deleted.ts', side: 'LEFT', line: 1, revision: 'revision' },
          priority: expect.objectContaining({ id: 'deleted-score' }),
        }),
      }),
    ]),
  )
  await interactWithLine('src/added.ts', 'additions', 2)
  expect(
    codeViewProps.items!.find((item) => item.id === 'src/added.ts')!.annotations,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        lineNumber: 2,
        side: 'additions',
        metadata: expect.objectContaining({
          conversation: true,
          anchor: { path: 'src/added.ts', side: 'RIGHT', line: 2, revision: 'revision' },
        }),
      }),
    ]),
  )
  const oldComposer = [
    ...container.querySelectorAll('.codeview-root .durable-line-chat'),
  ].find((node) =>
    node.querySelector('.review-location')?.textContent?.includes('src/added.ts:1'),
  )!
  await click(
    [...oldComposer.querySelectorAll('button')].find(
      (node) => node.textContent === 'Preview',
    ),
  )
  expect(oldComposer.querySelector('.review-editor-input')!.hasAttribute('hidden')).toBe(
    true,
  )
  await interactWithLine('src/added.ts', 'additions', 1)
  expect(oldComposer.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
    'Unsaved question',
  )
  expect(oldComposer.querySelector('.review-editor-preview')).toBeNull()
  expect(oldComposer.querySelector('.review-editor-input')!.hasAttribute('hidden')).toBe(
    false,
  )
  prioritySnapshot = { ...prioritySnapshot, status: 'stale' }
  await act(async () => {
    events.at(-1)!.dispatchEvent(new Event('thread-changed'))
    await new Promise((r) => setTimeout(r, 40))
  })
  expect(container.querySelectorAll('.file-sidebar [data-level]')).toHaveLength(0)
  expect(container.querySelectorAll('.hunk-priority-note')).toHaveLength(0)
  expect(
    sidebarButton('src/added.ts')!.querySelector('.file-sidebar-viewed')!.textContent,
  ).toBe('✓')
  expect(
    fetchMock.mock.calls.every(([path]) =>
      ['/api/diff', '/api/theme', '/api/review', '/api/priorities'].includes(path),
    ),
  ).toBe(true)
})
