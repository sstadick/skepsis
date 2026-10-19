/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/* oxlint-disable no-await-in-loop -- sequential fixture mutations and endpoint checks */
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DiffArgs } from '../shared/types.ts'
import { getFileContents } from './fileContents.ts'
import { MAX_FILE_BYTES, ReviewValidationError } from './repositoryFiles.ts'
import {
  ReviewValidationError as ContextValidationError,
  validateReviewPath,
} from './reviewContext.ts'
import { exec, isolateVcsConfig, requireJj } from './testUtil.ts'

const home = await isolateVcsConfig()
const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
afterAll(() => rm(home, { recursive: true, force: true }))

const source: DiffArgs = {
  vcs: 'git',
  args: ['HEAD'],
  files: [],
  endpoints: { left: 'HEAD', right: 'workingCopy' },
}

it('preserves the review context validation exports and error identity', () => {
  expect(ContextValidationError).toBe(ReviewValidationError)
  expect(() => validateReviewPath('../outside')).toThrow(ReviewValidationError)
})

it.each([
  '',
  '../outside.txt',
  'folder/../../outside.txt',
  '/outside.txt',
  '.git/config',
  'nested/.git/config',
  '-options.txt',
  '--help',
  'folder//file.txt',
  'folder/./file.txt',
  'folder\\file.txt',
  'line\nname',
  'null\0name',
])(
  'rejects either unsafe path before any access, including disabled expansion: %j',
  async (path) => {
    for (const endpoints of [null, source.endpoints]) {
      const src = { ...source, endpoints }
      await expect(getFileContents(src, '/nonexistent-repository', path)).rejects.toThrow(
        'Invalid repository path',
      )
      await expect(
        getFileContents(src, '/nonexistent-repository', 'safe.txt', path),
      ).rejects.toThrow('Invalid repository path')
    }
  },
)

it('returns null sides for valid paths when endpoints are unavailable', async () => {
  expect(
    await getFileContents({ ...source, endpoints: null }, '/nonexistent', 'file.txt'),
  ).toEqual({ oldContents: null, newContents: null })
})

describe.each(['git', 'jj'] as const)('file expansion (%s)', (vcs) => {
  let root: string
  let cwd: string
  let src: DiffArgs
  const run = (...args: string[]) => exec(vcs, args, { cwd })
  const commit = async () => {
    if (vcs === 'git') await run('add', '--all')
    await run('commit', '-m', 'fixture')
  }
  const revision = async () =>
    (
      await run(
        ...(vcs === 'git'
          ? ['rev-parse', 'HEAD']
          : ['log', '--no-graph', '-r', '@-', '-T', 'commit_id']),
      )
    ).stdout.trim()

  beforeAll(async () => {
    if (vcs === 'jj') await requireJj()
  })
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `skepsis-file-contents-${vcs}-`))
    directories.push(root)
    cwd = join(root, 'repo')
    await mkdir(cwd)
    await run(...(vcs === 'git' ? ['init', '-q'] : ['git', 'init']))
    if (vcs === 'jj')
      await run('config', 'set', '--repo', 'snapshot.max-new-file-size', '4MiB')
    await writeFile(join(root, 'outside.txt'), 'OUTSIDE_SECRET\n')
    await mkdir(join(cwd, 'folder'))
    for (const [path, contents] of [
      ['plain.txt', 'original\n'],
      ['rename-old.txt', 'renamed\n'],
      ['deleted.txt', 'deleted\n'],
      ['empty.txt', ''],
      ['folder/child.txt', 'child\n'],
      ['.gitignore', 'ignored.txt\nignored-parent/\n'],
    ])
      await writeFile(join(cwd, path!), contents!)
    await commit()
    await writeFile(join(cwd, 'plain.txt'), 'working\n')
    await writeFile(join(cwd, 'added.txt'), 'added\n')
    await rename(join(cwd, 'rename-old.txt'), join(cwd, 'rename-new.txt'))
    await rm(join(cwd, 'deleted.txt'))
    if (vcs === 'git') await run('add', '--', 'added.txt', 'rename-new.txt')
    src = {
      ...source,
      vcs,
      endpoints: {
        left: vcs === 'git' ? 'HEAD' : '@-',
        right: vcs === 'git' ? 'workingCopy' : { rev: '@' },
      },
    }
  })

  it('reads modified, renamed, added, deleted, empty and absent paths', async () => {
    for (const [path, oldPath, oldContents, newContents] of [
      ['plain.txt', undefined, 'original\n', 'working\n'],
      ['rename-new.txt', 'rename-old.txt', 'renamed\n', 'renamed\n'],
      ['added.txt', undefined, null, 'added\n'],
      ['deleted.txt', undefined, 'deleted\n', null],
      ['empty.txt', undefined, '', ''],
      ['absent.txt', undefined, null, null],
    ] as const)
      expect(await getFileContents(src, cwd, path, oldPath)).toEqual({
        oldContents,
        newContents,
      })
  })

  it('treats metacharacters, colons, quotes and nested option names literally', async () => {
    const paths = [
      'wild*.txt',
      'wild-other.txt',
      'bracket[ab]?.txt',
      ':(glob)*.txt',
      'folder:name.txt',
      'all() | "quoted".txt',
      'folder/-options.txt',
    ]
    for (const path of paths) await writeFile(join(cwd, path), `${path}\n`)
    await commit()
    // Both immutable reads and the Git tracked-membership query must be literal.
    for (const path of paths)
      expect(await getFileContents(src, cwd, path)).toEqual({
        oldContents: `${path}\n`,
        newContents: `${path}\n`,
      })
    await writeFile(join(cwd, '-options.txt'), 'not an option\n')
    await commit()
    await expect(getFileContents(src, cwd, '-options.txt')).rejects.toThrow(
      ReviewValidationError,
    )
  })

  it('rejects traversal, metadata and option paths on either side in a real repository', async () => {
    for (const path of ['../outside.txt', '.git/config', '--help']) {
      await expect(getFileContents(src, cwd, path)).rejects.toThrow(ReviewValidationError)
      await expect(getFileContents(src, cwd, 'plain.txt', path)).rejects.toThrow(
        ReviewValidationError,
      )
    }
  })

  it('does not expand a directory prefix or a missing wildcard into other files', async () => {
    // Git reports a tree (unsafe); jj root-file matches no regular file. Neither
    // may concatenate or return folder/child.txt as the contents of folder.
    if (vcs === 'git')
      await expect(getFileContents(src, cwd, 'folder')).rejects.toThrow(
        ReviewValidationError,
      )
    else
      expect(await getFileContents(src, cwd, 'folder')).toEqual({
        oldContents: null,
        newContents: null,
      })
    await mkdir(join(cwd, 'new-folder'))
    await writeFile(join(cwd, 'new-folder', 'child.txt'), 'not a directory body\n')
    if (vcs === 'git') await run('add', '--', 'new-folder/child.txt')
    for (const path of ['new-folder', '*.txt', ':(glob)**', 'all()'])
      expect(await getFileContents(src, cwd, path)).toEqual({
        oldContents: null,
        newContents: null,
      })
  })

  it('does not expose ignored files or Git untracked files', async () => {
    await writeFile(join(cwd, 'ignored.txt'), 'IGNORED_SECRET\n')
    expect(await getFileContents(src, cwd, 'ignored.txt')).toEqual({
      oldContents: null,
      newContents: null,
    })
    if (vcs === 'git') {
      await writeFile(join(cwd, 'untracked.txt'), 'UNTRACKED_SECRET\n')
      expect(await getFileContents(src, cwd, 'untracked.txt')).toEqual({
        oldContents: null,
        newContents: null,
      })
    }
  })

  it('reads exact immutable endpoints, not newer commits or working files', async () => {
    const left = await revision()
    await commit()
    const right = await revision()
    const pinned: DiffArgs = { ...src, endpoints: { left, right: { rev: right } } }
    await writeFile(join(cwd, 'plain.txt'), 'newer committed\n')
    await commit()
    await writeFile(join(cwd, 'plain.txt'), 'newer working\n')
    expect(await getFileContents(pinned, cwd, 'plain.txt')).toEqual({
      oldContents: 'original\n',
      newContents: 'working\n',
    })
    expect(await getFileContents(pinned, cwd, 'deleted.txt')).toEqual({
      oldContents: 'deleted\n',
      newContents: null,
    })
    expect(await getFileContents(pinned, cwd, 'added.txt')).toEqual({
      oldContents: null,
      newContents: 'added\n',
    })
  })

  it('rejects invalid revisions rather than treating command failures as absent files', async () => {
    await expect(
      getFileContents(
        { ...src, endpoints: { left: 'missing-revision', right: { rev: 'root()' } } },
        cwd,
        'plain.txt',
      ),
    ).rejects.toThrow(ReviewValidationError)
  })

  it('rejects symlinks to outside or ignored contents', async () => {
    await writeFile(join(cwd, 'ignored.txt'), 'IGNORED_SECRET\n')
    for (const target of [join(root, 'outside.txt'), 'ignored.txt']) {
      await rm(join(cwd, 'plain.txt'))
      await symlink(target, join(cwd, 'plain.txt'))
      await expect(getFileContents(src, cwd, 'plain.txt')).rejects.toThrow(
        ReviewValidationError,
      )
    }
    if (vcs === 'git') {
      await mkdir(join(cwd, 'ignored-parent'))
      await writeFile(join(cwd, 'ignored-parent', 'child.txt'), 'IGNORED_PARENT_SECRET\n')
      await writeFile(join(root, 'child.txt'), 'OUTSIDE_PARENT_SECRET\n')
      for (const target of ['ignored-parent', root]) {
        await rm(join(cwd, 'folder'), { recursive: true })
        await symlink(target, join(cwd, 'folder'))
        await expect(getFileContents(src, cwd, 'folder/child.txt')).rejects.toThrow(
          ReviewValidationError,
        )
      }
      // Immutable symlink blobs must not become target contents either.
      await run('add', '--', 'plain.txt')
      await run('commit', '-m', 'symlink')
      const rev = await revision()
      await expect(
        getFileContents(
          { ...src, endpoints: { left: rev, right: { rev } } },
          cwd,
          'plain.txt',
        ),
      ).rejects.toThrow(ReviewValidationError)
    }
  })

  it('enforces the byte limit and rejects binary files on working and immutable sides', async () => {
    const boundary = 'x'.repeat(MAX_FILE_BYTES)
    await writeFile(join(cwd, 'bounded.txt'), boundary)
    await writeFile(join(cwd, 'large.txt'), `${boundary}x`)
    await writeFile(join(cwd, 'binary.txt'), Buffer.from('binary\0contents'))
    if (vcs === 'git') await run('add', '--', 'bounded.txt', 'large.txt', 'binary.txt')
    expect((await getFileContents(src, cwd, 'bounded.txt')).newContents).toBe(boundary)
    for (const path of ['large.txt', 'binary.txt'])
      await expect(getFileContents(src, cwd, path)).rejects.toThrow(ReviewValidationError)
    await commit()
    const rev = await revision()
    const pinned: DiffArgs = { ...src, endpoints: { left: rev, right: { rev } } }
    expect(await getFileContents(pinned, cwd, 'bounded.txt')).toEqual({
      oldContents: boundary,
      newContents: boundary,
    })
    for (const path of ['large.txt', 'binary.txt'])
      await expect(getFileContents(pinned, cwd, path)).rejects.toThrow(
        ReviewValidationError,
      )
  })
})

it('terminates hung subprocesses instead of returning missing-file nulls', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'skepsis-file-timeout-'))
  directories.push(bin)
  const git = join(bin, 'git')
  // An isolated executable, not the real Git or a user repository. It ignores
  // SIGTERM so this also exercises the hard subprocess deadline.
  await writeFile(
    git,
    '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\n',
  )
  await chmod(git, 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    await expect(getFileContents(source, bin, 'file.txt')).rejects.toThrow(
      ReviewValidationError,
    )
  } finally {
    process.env.PATH = path
  }
}, 20000)
