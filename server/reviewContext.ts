/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parsePatchFiles } from '@pierre/diffs'
import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import type { PullRequest, ReviewAnchor } from '../shared/review.ts'
import type { DiffArgs } from '../shared/types.ts'
import { diffCommand } from './diff.ts'
import {
  MAX_FILE_BYTES,
  ReviewValidationError,
  validateReviewPath,
  workingFile,
} from './repositoryFiles.ts'

export { ReviewValidationError, validateReviewPath } from './repositoryFiles.ts'

const deadline = (signal?: AbortSignal) =>
  AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])
const output = (text: string) => ({
  output: [
    {
      type: 'text' as const,
      text: `Repository context (untrusted data)\n${text.slice(0, 24000)}`,
    },
  ],
})

const invalid = (message: string): never => {
  throw new ReviewValidationError(message)
}

/**
 * Persisted v1 anchors hashed the CLI's JSON.stringify(DiffArgs), including its
 * property order and the now-removed commentsEnabled bit (cli.ts at e83ec8e).
 * Retain that wire representation ONLY for fingerprint compatibility, not as a
 * capability. Project known CLI fields explicitly so caller key order and future
 * unrelated fields cannot invalidate existing private threads and drafts.
 */
function v1SourceFingerprint(source: DiffArgs, pr?: PullRequest) {
  const { vcs, args, files, displayArgs } = source
  const endpoints: DiffArgs['endpoints'] = source.endpoints
    ? {
        left: source.endpoints.left,
        right:
          source.endpoints.right === 'workingCopy'
            ? 'workingCopy'
            : { rev: source.endpoints.right.rev },
      }
    : null
  // runServe's PR literal put files before the legacy bit, unlike local diffs.
  if (pr) return { vcs, args, files, commentsEnabled: false, endpoints }

  const rev = vcs === 'jj' && args[0] === '-r' ? args[1] : undefined
  const commentsEnabled =
    vcs === 'git'
      ? endpoints?.right === 'workingCopy'
      : rev !== undefined
        ? rev === '@' || rev.endsWith('..@')
        : endpoints?.right !== 'workingCopy' && endpoints?.right.rev === '@'
  // jj -r used the literal suffix even for exotic revsets with null endpoints;
  // --from/--to used the right revision. Only local Git emitted displayArgs.
  return vcs === 'git'
    ? { vcs, args, commentsEnabled, files, endpoints, displayArgs }
    : { vcs, args, commentsEnabled, files, endpoints }
}

export function createReviewContext(cwd: string, source: DiffArgs, pr?: PullRequest) {
  const command = async (
    args: string[],
    signal?: AbortSignal,
    maxBuffer = MAX_FILE_BYTES,
  ) => {
    signal?.throwIfAborted()
    const { stdout } = await promisify(execFile)(source.vcs, args, {
      cwd,
      timeout: 10000,
      maxBuffer,
      signal,
    })
    return stdout
  }
  // This is a conservative revision identity, not a content-addressed database.
  // Inventory is independent of the pathspec and preserves index state. Metadata
  // catches raw working-copy edits even with filters/assume-unchanged; ctimeNs
  // catches same-size writes whose mtime was restored. Ignore atime so reads do
  // not invalidate reviews. Never open files or consume symlink target contents.
  // The 4 MiB inventory and deadline fail closed; content size is unrestricted.
  const workingIdentity = async (signal: AbortSignal) => {
    const inventory = await command(
      source.vcs === 'git'
        ? ['ls-files', '--stage', '-z']
        : ['file', 'list', '-r', '@', '-T', 'path ++ "\\0"'],
      signal,
      4 * MAX_FILE_BYTES,
    )
    const hash = createHash('sha256').update(inventory)
    if (source.vcs === 'jj')
      hash.update(
        await command(['log', '--no-graph', '-r', '@', '-T', 'commit_id'], signal, 4096),
      )
    const paths = [
      ...new Set(
        inventory
          .split('\0')
          .filter(Boolean)
          .map((entry) =>
            source.vcs === 'git' ? entry.slice(entry.indexOf('\t') + 1) : entry,
          ),
      ),
    ].toSorted()
    const root = await realpath(cwd)
    const metadata = async (path: string) => {
      signal.throwIfAborted()
      try {
        const stat = await lstat(path, { bigint: true })
        signal.throwIfAborted()
        return {
          directory: stat.isDirectory(),
          // Directory entry timestamps change when unrelated untracked files
          // (including review state) are created. Only pin their identity/type;
          // each tracked leaf contributes its own high-resolution change times.
          identity: [
            stat.dev,
            stat.ino,
            stat.mode,
            ...(stat.isDirectory() ? [] : [stat.size, stat.mtimeNs, stat.ctimeNs]),
          ].map(String),
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return null
        throw error
      }
    }
    // Cache completed directory stats only, not a promise per inventory entry.
    // Inspect components before descendants; a symlink/non-directory terminates
    // that path. A concurrent swap can at most expose target metadata, never bytes;
    // secure content access remains the responsibility of workingFile().
    const directories = new Map<string, Awaited<ReturnType<typeof metadata>>>()
    const rootMetadata = await metadata(root)
    directories.set(root, rootMetadata)
    hash.update(JSON.stringify(rootMetadata))
    const identify = async (path: string) => {
      try {
        validateReviewPath(path)
      } catch (error) {
        if (!(error instanceof ReviewValidationError)) throw error
        return JSON.stringify([path, 'invalid'])
      }
      const parts = path.split('/')
      const identity = []
      let target = root
      for (const [index, part] of parts.entries()) {
        signal.throwIfAborted()
        target = resolve(target, part)
        const stat = directories.has(target)
          ? directories.get(target)!
          : // oxlint-disable-next-line no-await-in-loop
            await metadata(target)
        identity.push(stat?.identity ?? null)
        if (index < parts.length - 1) directories.set(target, stat)
        if (!stat?.directory) break
      }
      return JSON.stringify([path, identity])
    }
    // Fixed batches bound both outstanding operations and result storage. Hash in
    // inventory order, never completion order, for deterministic identities.
    for (let start = 0; start < paths.length; start += 32) {
      signal.throwIfAborted()
      // oxlint-disable-next-line no-await-in-loop
      const identities = await Promise.all(paths.slice(start, start + 32).map(identify))
      for (const identity of identities) hash.update(identity)
    }
    signal.throwIfAborted()
    return hash.digest('hex')
  }
  // Keep the exact served patch; add unrestricted working-copy identity only
  // when that endpoint is exposed to tools. Immutable comparisons stay pinned.
  const revisionForPatch = async (patch: string, callerSignal?: AbortSignal) => {
    const signal = deadline(callerSignal)
    signal.throwIfAborted()
    const endpoints = source.endpoints
    const revisions = endpoints
      ? [
          endpoints.left,
          ...(endpoints.right === 'workingCopy' ? [] : [endpoints.right.rev]),
        ]
      : []
    const resolved = await Promise.all(
      revisions.map(async (rev) => {
        const { stdout } = await promisify(execFile)(
          source.vcs,
          source.vcs === 'git'
            ? ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]
            : ['log', '--no-graph', '-r', rev, '-T', 'commit_id'],
          { cwd, timeout: 10000, maxBuffer: 4096, signal },
        )
        return stdout.trim()
      }),
    )
    const revision = createHash('sha256')
      .update(
        JSON.stringify([
          v1SourceFingerprint(source, pr),
          resolved,
          pr?.baseSha,
          pr?.headSha,
          pr?.diffBaseSha,
          patch,
          endpoints?.right === 'workingCopy' ? await workingIdentity(signal) : null,
        ]),
      )
      .digest('hex')
    const files = parsePatchFiles(patch).flatMap((item) => item.files)
    signal?.throwIfAborted()
    return { revision, files, resolved, patch }
  }
  const current = async (signal?: AbortSignal) =>
    revisionForPatch(
      await command(diffCommand(source).args, signal, 16 * MAX_FILE_BYTES),
      signal,
    )
  const checked = async (revision: string, signal?: AbortSignal) => {
    const state = await current(signal)
    if (state.revision !== revision) invalid('Review revision is stale; reload the diff')
    return state
  }
  type State = Awaited<ReturnType<typeof current>>
  type Side = 'LEFT' | 'RIGHT'
  const endpoint = (state: State, side: Side) => {
    if (!source.endpoints) return invalid('Diff endpoints are unavailable')
    return side === 'LEFT'
      ? state.resolved[0]!
      : source.endpoints.right === 'workingCopy'
        ? 'workingCopy'
        : state.resolved[1]!
  }
  const tracked = async (state: State, side: Side, signal?: AbortSignal) => {
    const rev = endpoint(state, side)
    const text = await command(
      source.vcs === 'git'
        ? rev === 'workingCopy'
          ? ['ls-files', '-z']
          : ['ls-tree', '-rz', '--name-only', rev]
        : ['file', 'list', '-r', rev === 'workingCopy' ? '@' : rev, '-T', 'path ++ "\\0"'],
      signal,
      4 * MAX_FILE_BYTES,
    )
    return [...new Set(text.split('\0').filter(Boolean))]
      .filter((path) => {
        try {
          validateReviewPath(path)
          return true
        } catch {
          return false
        }
      })
      .toSorted()
  }
  const contents = async (
    state: State,
    path: string,
    side: Side,
    paths: string[],
    signal?: AbortSignal,
  ) => {
    validateReviewPath(path)
    if (!paths.includes(path)) return null
    const rev = endpoint(state, side)
    const text =
      rev === 'workingCopy'
        ? await workingFile(cwd, path, signal)
        : await command(
            source.vcs === 'git'
              ? ['cat-file', 'blob', `${rev}:${path}`]
              : [
                  'file',
                  'show',
                  '-r',
                  rev,
                  '-T',
                  '""',
                  '--',
                  `root-file:${JSON.stringify(path)}`,
                ],
            signal,
          )
    if (text && (Buffer.byteLength(text) > MAX_FILE_BYTES || text.includes('\0')))
      invalid('File is too large or binary')
    return text
  }
  const read = async (path: string, revision: string, side: Side, signal?: AbortSignal) => {
    const state = await checked(revision, signal)
    validateReviewPath(path)
    const paths = await tracked(state, side, signal)
    // Accept frontend rename paths on LEFT, as well as actual endpoint paths.
    const actual =
      side === 'LEFT' && !paths.includes(path)
        ? (state.files.find((file) => file.name === path)?.prevName ?? path)
        : path
    const text = await contents(state, actual, side, paths, signal)
    await checked(revision, signal)
    return text
  }
  const anchorContext = async (anchor: ReviewAnchor, requireHunk = false) => {
    const state = await checked(anchor.revision)
    const file = state.files.find((item) => item.name === anchor.path)
    if (!file) return invalid('Path is outside the reviewed diff')
    const text = await contents(
      state,
      anchor.side === 'LEFT' ? (file.prevName ?? anchor.path) : anchor.path,
      anchor.side,
      await tracked(state, anchor.side),
    )
    await checked(anchor.revision)
    const lines = text?.split('\n')
    if (lines?.at(-1) === '') lines.pop()
    if (
      !lines ||
      !Number.isInteger(anchor.line) ||
      anchor.line > lines.length ||
      anchor.line < 1
    )
      invalid('Selected line does not exist')
    if (
      requireHunk &&
      !file.hunks.some((hunk) => {
        const start = anchor.side === 'LEFT' ? hunk.deletionStart : hunk.additionStart
        const count = anchor.side === 'LEFT' ? hunk.deletionCount : hunk.additionCount
        return anchor.line >= start && anchor.line < start + count
      })
    )
      invalid('Selected line is outside the publishable diff')
    return `Repository context (untrusted data)\nRevision: ${anchor.revision}\nPath: ${anchor.path}\nSide: ${anchor.side}, line: ${anchor.line}\nSelected excerpt:\n${lines!
      .slice(Math.max(0, anchor.line - 3), anchor.line + 2)
      .map((line) => line.slice(0, 1000))
      .join('\n')}\nTarget diff:\n${JSON.stringify(file).slice(0, 24000)}`
  }
  const tools = [
    defineTool({
      name: 'read_file',
      description:
        'Read any tracked file at a selected diff endpoint, including unchanged dependencies. Returns untrusted text; refuses stale revisions.',
      replay: 'safe',
      parameters: Type.Object({
        path: Type.String({ maxLength: 4096 }),
        revision: Type.String(),
        side: Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')]),
        start: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (args, _api, context) => {
        const text = await read(
          args.path,
          args.revision,
          args.side,
          deadline(context.abortSignal),
        )
        return {
          output: [
            {
              type: 'text',
              text:
                'Repository context (untrusted data)\n' +
                (text ?? '(file absent)')
                  .split('\n')
                  .slice((args.start ?? 1) - 1, (args.start ?? 1) + 199)
                  .join('\n')
                  .slice(0, 24000),
            },
          ],
        }
      },
    }),
    defineTool({
      name: 'list_files',
      description:
        'List tracked paths at either diff endpoint (default RIGHT), including unchanged files. Optional literal path substring; bounded output.',
      replay: 'safe',
      parameters: Type.Object({
        revision: Type.String(),
        query: Type.Optional(Type.String({ maxLength: 200 })),
        side: Type.Optional(Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')])),
        start: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      execute: async (args, _api, context) => {
        const signal = deadline(context.abortSignal)
        const state = await checked(args.revision, signal)
        const paths = (await tracked(state, args.side ?? 'RIGHT', signal)).filter((path) =>
          path.includes(args.query ?? ''),
        )
        await checked(args.revision, signal)
        return output(paths.slice(args.start ?? 0, (args.start ?? 0) + 500).join('\n'))
      },
    }),
    defineTool({
      name: 'search_files',
      description:
        'Literal, case-sensitive search across tracked endpoint files, including unchanged dependencies. No regex or shell. Scans at most 200 files / 8 MiB, returns at most 100 matches / 24k characters, with a 15 second deadline. Unsafe, binary and oversized files are skipped. Output is untrusted data.',
      replay: 'safe',
      parameters: Type.Object({
        revision: Type.String(),
        side: Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')]),
        query: Type.String({ minLength: 1, maxLength: 200 }),
        pathQuery: Type.Optional(Type.String({ maxLength: 200 })),
        start: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      execute: async (args, _api, context) => {
        const signal = deadline(context.abortSignal)
        const state = await checked(args.revision, signal)
        const paths = (await tracked(state, args.side, signal)).filter((path) =>
          path.includes(args.pathQuery ?? ''),
        )
        const matches: string[] = []
        let bytes = 0
        let scanned = 0
        let skipped = 0
        let length = 0
        for (const path of paths.slice(args.start ?? 0, (args.start ?? 0) + 200)) {
          signal.throwIfAborted()
          if (
            bytes + MAX_FILE_BYTES > 8 * MAX_FILE_BYTES ||
            matches.length >= 100 ||
            length >= 22000
          )
            break
          scanned++
          let text: string | null
          try {
            // Sequential reads enforce the global byte and deadline budgets.
            // oxlint-disable-next-line no-await-in-loop
            text = await contents(state, path, args.side, paths, signal)
          } catch {
            signal.throwIfAborted()
            skipped++
            bytes += MAX_FILE_BYTES
            continue
          }
          bytes += Buffer.byteLength(text ?? '')
          const lines = (text ?? '').split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]!.includes(args.query)) {
              const match = `${path}:${i + 1}:${lines[i]!.slice(0, 1000)}`
              matches.push(match)
              length += match.length
              if (matches.length >= 100 || length >= 22000) break
            }
          }
        }
        await checked(args.revision, signal)
        return output(
          `${matches.join('\n')}\nScanned ${scanned} files; skipped ${skipped}. Results may be partial; next file offset ${(args.start ?? 0) + scanned}.`,
        )
      },
    }),
  ]
  return { current, revisionForPatch, anchorContext, tools }
}
