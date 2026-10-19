/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export const MAX_FILE_BYTES = 1024 * 1024

export class ReviewValidationError extends Error {}
const invalid = (message: string): never => {
  throw new ReviewValidationError(message)
}
export function validateReviewPath(path: string): void {
  if (
    !path ||
    path.length > 4096 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part === '.git') ||
    path.startsWith('-')
  )
    invalid('Invalid repository path')
}

export async function workingFile(
  cwd: string,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted()
  validateReviewPath(path)
  const root = await realpath(cwd)
  const handles: { file: Awaited<ReturnType<typeof open>>; path: string }[] = []
  try {
    // Pin every directory on Linux: O_NOFOLLOW on just the leaf is insufficient.
    // Never canonicalize a user path and then open its symlink target.
    let target = root
    for (const part of ['', ...path.split('/')]) {
      signal?.throwIfAborted()
      const parent = handles.at(-1)
      if (part) target = resolve(target, part)
      const candidate =
        parent && process.platform === 'linux'
          ? `/proc/self/fd/${parent.file.fd}/${part}`
          : target
      // oxlint-disable-next-line no-await-in-loop
      const before = await lstat(candidate)
      if (before.isSymbolicLink()) invalid('Repository symlink escapes safe file access')
      const directory = target !== resolve(root, path)
      if (directory && !before.isDirectory()) invalid('Path is not a directory')
      // oxlint-disable-next-line no-await-in-loop
      const file = await open(
        candidate,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (directory ? constants.O_DIRECTORY : 0),
      )
      handles.push({ file, path: target })
      // oxlint-disable-next-line no-await-in-loop
      const after = await file.stat()
      if (before.dev !== after.dev || before.ino !== after.ino)
        invalid('Repository path changed during read')
    }
    const revalidate = async () => {
      for (const entry of handles) {
        // Check every original component, not just containment: an internal
        // symlink to an ignored secret is just as unsafe as an external one.
        // oxlint-disable-next-line no-await-in-loop
        const current = await lstat(entry.path)
        // oxlint-disable-next-line no-await-in-loop
        const opened = await entry.file.stat()
        if (
          current.isSymbolicLink() ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino
        )
          invalid('Repository path changed during read')
        if (
          process.platform === 'linux' &&
          // oxlint-disable-next-line no-await-in-loop
          (await realpath(`/proc/self/fd/${entry.file.fd}`)) !== entry.path
        )
          invalid('Repository path changed during read')
      }
    }
    await revalidate()
    const file = handles.at(-1)!.file
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      invalid('File is not a bounded regular text file')
    // A fixed-size read also bounds files that grow after stat().
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      signal?.throwIfAborted()
      // Sequential reads enforce the byte budget even if the file grows.
      // oxlint-disable-next-line no-await-in-loop
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > MAX_FILE_BYTES) invalid('File is too large')
    await revalidate()
    const contents = buffer.subarray(0, size)
    if (contents.includes(0)) invalid('File is binary')
    return contents.toString('utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ELOOP' || code === 'ENOTDIR')
      invalid('Repository symlink escapes safe file access')
    throw error
  } finally {
    await Promise.all(handles.map(({ file }) => file.close()))
  }
}
