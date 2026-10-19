/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DiffArgs, FileContentsResponse } from '../shared/types.ts'
import {
  MAX_FILE_BYTES,
  ReviewValidationError,
  validateReviewPath,
  workingFile,
} from './repositoryFiles.ts'

/** Only an explicitly expected missing-path exit may become null. In particular,
 * truncated output, timeouts, signals and spawn failures must fail closed. */
async function command(
  vcs: DiffArgs['vcs'],
  args: string[],
  cwd: string,
  signal: AbortSignal,
  maxBuffer = MAX_FILE_BYTES,
  missingExitCode?: number,
): Promise<Buffer | null> {
  try {
    const { stdout } = await promisify(execFile)(vcs, args, {
      cwd,
      encoding: 'buffer',
      maxBuffer,
      timeout: 10000,
      killSignal: 'SIGKILL',
      signal,
    })
    return stdout
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; signal?: unknown }
    if (
      missingExitCode !== undefined &&
      failure.code === missingExitCode &&
      !failure.killed &&
      !failure.signal &&
      !signal.aborted
    )
      return null
    throw new ReviewValidationError('Repository file read failed or exceeded its limits')
  }
}

const MAX_METADATA_BYTES = 64 * 1024

async function fetchWorking(cwd: string, path: string, signal: AbortSignal) {
  // workingCopy endpoints are Git-only. A literal pathspec still matches directory
  // prefixes, so require exact membership, not just a successful exit status.
  const tracked = await command(
    'git',
    ['--literal-pathspecs', 'ls-files', '--error-unmatch', '-z', '--', path],
    cwd,
    signal,
    MAX_METADATA_BYTES,
    1,
  )
  if (!tracked?.toString('utf8').split('\0').includes(path)) return null
  return workingFile(cwd, path, signal)
}

async function fetchRevision(
  vcs: DiffArgs['vcs'],
  rev: string,
  path: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string | null> {
  // Resolve once, then inspect/read the exact immutable object. A moved ref must
  // not change the file between the existence check and the content read.
  const resolved = (await command(
    vcs,
    vcs === 'git'
      ? ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]
      : ['log', '--no-graph', `--revisions=${rev}`, '-T', 'commit_id'],
    cwd,
    signal,
    4096,
  ))!
    .toString('utf8')
    .trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolved))
    throw new ReviewValidationError('File endpoint must resolve to one commit')

  let args: string[]
  if (vcs === 'git') {
    const entry = (await command(
      vcs,
      ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', resolved, '--', path],
      cwd,
      signal,
      MAX_METADATA_BYTES,
    ))!.toString('utf8')
    if (!entry) return null
    const match = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(entry)
    if (!match || entry.slice(match[0].length) !== `${path}\0`)
      throw new ReviewValidationError('Path is not a regular repository file')
    args = ['cat-file', 'blob', match[2]!]
  } else {
    const fileset = `root-file:${JSON.stringify(path)}`
    const entry = (await command(
      vcs,
      [
        '--ignore-working-copy',
        'file',
        'list',
        '-r',
        resolved,
        '-T',
        'file_type ++ "\\0" ++ path ++ "\\0"',
        '--',
        fileset,
      ],
      cwd,
      signal,
      MAX_METADATA_BYTES,
    ))!.toString('utf8')
    if (!entry) return null
    if (entry !== `file\0${path}\0`)
      throw new ReviewValidationError('Path is not a regular repository file')
    args = [
      '--ignore-working-copy',
      'file',
      'show',
      '-r',
      resolved,
      '-T',
      '""',
      '--',
      fileset,
    ]
  }
  const contents = (await command(vcs, args, cwd, signal))!
  if (contents.includes(0)) throw new ReviewValidationError('File is binary')
  return contents.toString('utf8')
}

/**
 * Full file contents at both diff endpoints, used by the client to build a
 * non-partial diff that supports hunk expansion. `oldPath` differs from `path`
 * for renamed files (the old-side path). No diff or repository-wide inventory
 * is needed: each read checks only the requested, literal repository path.
 */
export async function getFileContents(
  src: DiffArgs,
  cwd: string,
  path: string,
  oldPath?: string,
): Promise<FileContentsResponse> {
  validateReviewPath(path)
  if (oldPath !== undefined) validateReviewPath(oldPath)
  if (!src.endpoints) return { oldContents: null, newContents: null }
  const signal = AbortSignal.timeout(15000)
  const { left, right } = src.endpoints
  const [oldContents, newContents] = await Promise.all([
    fetchRevision(src.vcs, left, oldPath ?? path, cwd, signal),
    right === 'workingCopy'
      ? fetchWorking(cwd, path, signal)
      : fetchRevision(src.vcs, right.rev, path, cwd, signal),
  ])
  return { oldContents, newContents }
}
