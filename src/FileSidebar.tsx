/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useEffect, useId, useMemo, useState } from 'react'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { FileHashes, ViewedMap } from '../shared/types.ts'
import {
  hasPriorityScore,
  priorityLevel,
  PRIORITY_LEVELS,
  type HunkPriority,
} from '../shared/priorities.ts'
import './priorities.css'

export const FILE_SIDEBAR_ID = 'review-file-sidebar'
const STORAGE_KEY = 'skepsis.files-sidebar.open'

export function useFileSidebarOpen() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== 'false'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      // Best effort, per origin: a different server port starts a new preference.
      localStorage.setItem(STORAGE_KEY, String(open))
    } catch {
      // Storage may be unavailable or full; navigation must still work.
    }
  }, [open])
  return [open, setOpen] as const
}

export function FileSidebarToggle({
  open,
  onToggle,
}: {
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="file-sidebar-toggle"
      aria-expanded={open}
      aria-controls={FILE_SIDEBAR_ID}
      onClick={onToggle}
    >
      {open ? 'Hide files' : 'Show files'}
    </button>
  )
}

interface SidebarPriority {
  score?: number
  total: number
  scored: number
  pending: number
  unscored: number
  uncertain: boolean
}

export interface SidebarFile {
  path: string
  oldPath?: string
  change: 'A' | 'M' | 'D' | 'R'
  additions: number
  deletions: number
  viewed: 'viewed' | 'stale' | 'unviewed'
  priority?: SidebarPriority
}

function mergePriorities(items: readonly (SidebarPriority | undefined)[]) {
  const result: SidebarPriority = {
    total: 0,
    scored: 0,
    pending: 0,
    unscored: 0,
    uncertain: false,
  }
  for (const item of items) {
    if (!item) continue
    result.total += item.total
    result.scored += item.scored
    result.pending += item.pending
    result.unscored += item.unscored
    result.uncertain ||= item.uncertain
    if (item.score !== undefined)
      result.score = Math.max(result.score ?? item.score, item.score)
  }
  return result.total ? result : undefined
}

function summarizeHunks(hunks: readonly HunkPriority[]) {
  return mergePriorities(
    hunks.map((hunk) => {
      const scored = hasPriorityScore(hunk)
      const confidence = hunk.confidence ?? NaN
      return {
        score: scored ? hunk.score : undefined,
        total: 1,
        scored: scored ? 1 : 0,
        pending: hunk.status === 'queued' ? 1 : 0,
        unscored: !scored && hunk.status !== 'queued' ? 1 : 0,
        uncertain:
          scored && (!Number.isFinite(confidence) || confidence < 0.65 || confidence > 1),
      }
    }),
  )
}

function priorityDescription(priority: SidebarPriority) {
  return [
    priority.score === undefined
      ? priority.pending
        ? 'Review priority pending'
        : 'Review priority not scored'
      : `${priorityLevel(priority.score)} review priority: ${priority.score.toFixed(1)}/4 (highest scored hunk)`,
    `${priority.scored}/${priority.total} hunks scored`,
    ...(priority.pending ? [`${priority.pending} pending`] : []),
    ...(priority.unscored ? [`${priority.unscored} not scored`] : []),
    ...(priority.uncertain ? ['Uncertain results; inspect manually'] : []),
  ].join('. ')
}

function priorityTone(priority?: SidebarPriority) {
  return priority
    ? priority.score === undefined
      ? priority.pending
        ? 'pending'
        : 'unscored'
      : priorityLevel(priority.score).toLowerCase()
    : undefined
}

function SidebarPriorityBadge({ priority }: { priority?: SidebarPriority }) {
  if (!priority) return null
  return (
    <span
      className="file-sidebar-priority"
      aria-hidden="true"
      title={priorityDescription(priority)}
    >
      {priority.score === undefined ? (
        priority.pending ? (
          '…'
        ) : (
          '—'
        )
      ) : (
        <>
          {priority.score.toFixed(1)}
          {priority.scored < priority.total ? '*' : ''}
          {priority.uncertain ? '?' : ''}
        </>
      )}
    </span>
  )
}

/** Read the original patch metadata, before CodeView normalizes add/delete types. */
export function sidebarFiles(
  files: readonly FileDiffMetadata[],
  hashes: FileHashes,
  viewed: ViewedMap,
  priorities: readonly HunkPriority[] = [],
): SidebarFile[] {
  // App supplies only results for the currently displayed revision.
  const byPath = new Map<string, HunkPriority[]>()
  for (const hunk of priorities) {
    const group = byPath.get(hunk.path) ?? []
    group.push(hunk)
    byPath.set(hunk.path, group)
  }
  return files.map((file) => {
    const hash = hashes[file.name]
    const viewedHash = viewed[file.name]
    return {
      path: file.name,
      oldPath: file.prevName,
      priority: summarizeHunks(byPath.get(file.name) ?? []),
      change:
        file.type === 'new'
          ? 'A'
          : file.type === 'deleted'
            ? 'D'
            : file.type === 'rename-pure' || file.type === 'rename-changed'
              ? 'R'
              : 'M',
      additions: file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
      deletions: file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
      viewed:
        hash != null && viewedHash === hash
          ? 'viewed'
          : hash != null && viewedHash != null
            ? 'stale'
            : 'unviewed',
    }
  })
}

export type FileTreeNode =
  | { type: 'file'; name: string; path: string; file: SidebarFile }
  | {
      type: 'folder'
      name: string
      path: string
      children: FileTreeNode[]
      priority?: SidebarPriority
    }

function sortTree(nodes: FileTreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    sortTree(node.children)
    node.priority = mergePriorities(
      node.children.map((child) =>
        child.type === 'file' ? child.file.priority : child.priority,
      ),
    )
  }
}

/** Case-insensitive path filtering includes a rename's old path and keeps ancestors. */
export function buildFileTree(files: readonly SidebarFile[], filter = ''): FileTreeNode[] {
  const query = filter.trim().toLowerCase()
  const root: FileTreeNode[] = []
  const folders = new Map<string, Extract<FileTreeNode, { type: 'folder' }>>()
  for (const file of files) {
    if (
      query &&
      !file.path.toLowerCase().includes(query) &&
      !file.oldPath?.toLowerCase().includes(query)
    )
      continue
    const parts = file.path.split('/')
    const name = parts.pop()!
    let children = root
    let path = ''
    for (const part of parts) {
      path = path ? `${path}/${part}` : part
      let folder = folders.get(path)
      if (!folder) {
        folder = { type: 'folder', name: part, path, children: [] }
        folders.set(path, folder)
        children.push(folder)
      }
      children = folder.children
    }
    children.push({ type: 'file', name, path: file.path, file })
  }
  sortTree(root)
  return root
}

const CHANGE_LABELS = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' }
const VIEWED_LABELS = {
  viewed: 'Viewed',
  stale: 'Changed since viewed',
  unviewed: 'Not viewed',
}

export function FileSidebar({
  files,
  focusedFile,
  open,
  onSelect,
}: {
  files: readonly SidebarFile[]
  focusedFile: string | null
  open: boolean
  onSelect: (path: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set())
  const id = useId()
  const tree = useMemo(() => buildFileTree(files, filter), [files, filter])

  function renderNodes(nodes: FileTreeNode[], depth = 0) {
    return nodes.map((node) => {
      if (node.type === 'folder') {
        const expanded = !collapsedFolders.has(node.path)
        const childrenId = `${id}-${encodeURIComponent(node.path)}`
        return (
          <li key={`folder:${node.path}`}>
            <button
              type="button"
              className="file-sidebar-folder priority-tone"
              data-level={priorityTone(node.priority)}
              aria-description={
                node.priority ? priorityDescription(node.priority) : undefined
              }
              style={{ paddingInlineStart: 8 + Math.min(depth, 6) * 12 }}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} folder ${node.path}`}
              aria-expanded={expanded}
              aria-controls={childrenId}
              title={
                node.path + (node.priority ? '\n' + priorityDescription(node.priority) : '')
              }
              onClick={() =>
                setCollapsedFolders((previous) => {
                  const next = new Set(previous)
                  if (expanded) next.add(node.path)
                  else next.delete(node.path)
                  return next
                })
              }
            >
              <span className="file-sidebar-chevron" aria-hidden="true">
                {expanded ? '▾' : '▸'}
              </span>
              <span className="file-sidebar-name">{node.name}</span>
              <SidebarPriorityBadge priority={node.priority} />
            </button>
            <ul id={childrenId} hidden={!expanded}>
              {renderNodes(node.children, depth + 1)}
            </ul>
          </li>
        )
      }
      const { file } = node
      const rename = file.oldPath ? `, renamed from ${file.oldPath}` : ''
      return (
        <li key={`file:${node.path}`}>
          <button
            type="button"
            className="file-sidebar-file priority-tone"
            data-level={priorityTone(file.priority)}
            style={{ paddingInlineStart: 8 + Math.min(depth, 6) * 12 }}
            aria-current={file.path === focusedFile ? 'true' : undefined}
            aria-label={`Open ${file.path}${rename}, ${CHANGE_LABELS[file.change]}, ${file.additions} additions, ${file.deletions} deletions, ${VIEWED_LABELS[file.viewed]}${file.priority ? ', ' + priorityDescription(file.priority) : ''}`}
            title={
              (file.oldPath ? `${file.path}\nRenamed from ${file.oldPath}` : file.path) +
              (file.priority ? '\n' + priorityDescription(file.priority) : '')
            }
            onClick={() => onSelect(file.path)}
          >
            <span
              className={`file-sidebar-viewed ${file.viewed}`}
              aria-hidden="true"
              title={VIEWED_LABELS[file.viewed]}
            >
              {file.viewed === 'viewed' ? '✓' : file.viewed === 'stale' ? '!' : '○'}
            </span>
            <span className="file-sidebar-name">{node.name}</span>
            <SidebarPriorityBadge priority={file.priority} />
            <span
              className={`file-sidebar-change change-${file.change}`}
              aria-hidden="true"
            >
              {file.change}
            </span>
            <span className="file-sidebar-stats" aria-hidden="true">
              <span className="stat-add">+{file.additions}</span>
              <span className="stat-del">−{file.deletions}</span>
            </span>
          </button>
        </li>
      )
    })
  }

  return (
    <aside
      id={FILE_SIDEBAR_ID}
      className="file-sidebar"
      aria-label="Files sidebar"
      hidden={!open}
    >
      <div className="file-sidebar-heading">Files changed ({files.length})</div>
      <div className="file-sidebar-filter">
        <label htmlFor={`${id}-filter`}>Filter files</label>
        <input
          id={`${id}-filter`}
          type="search"
          placeholder="Filter by path…"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value)
            // Reveal matching descendants, even if their folder was closed.
            setCollapsedFolders(new Set())
          }}
        />
      </div>
      {files.some((file) => file.priority) && (
        <details className="file-sidebar-priority-key">
          <summary>Priority colors · highest hunk</summary>
          <div aria-label="Priority color key">
            {PRIORITY_LEVELS.map((level) => (
              <span className="priority-tone" data-level={level.toLowerCase()} key={level}>
                {level}
              </span>
            ))}
          </div>
          <p>
            Files and folders use their highest scored hunk. * Partial coverage. ?
            Uncertain. … Pending. — Not scored. These are review estimates, not confirmed
            bugs.
          </p>
        </details>
      )}
      <nav className="file-sidebar-list" aria-label="Changed files">
        {tree.length ? (
          <ul>{renderNodes(tree)}</ul>
        ) : (
          <p className="file-sidebar-empty" role="status">
            {files.length ? 'No matching files' : 'No changed files'}
          </p>
        )}
      </nav>
    </aside>
  )
}
