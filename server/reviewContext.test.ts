/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/* oxlint-disable no-await-in-loop -- sequential endpoint assertions */
import { execFileSync } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createReviewContext, validateReviewPath } from './reviewContext.ts'
import type { DiffArgs } from '../shared/types.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'review-context-'))
  directories.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git('init', '-q')
  await writeFile(join(cwd, 'old.txt'), 'old line\n')
  await writeFile(join(cwd, 'deleted.txt'), 'deleted line\n')
  await writeFile(join(cwd, 'dependency.txt'), 'literal .* dependency\n')
  git('add', '.')
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'initial',
  )
  git('mv', 'old.txt', 'new.txt')
  git('rm', 'deleted.txt')
  const source: DiffArgs = {
    vcs: 'git',
    args: ['HEAD'],
    files: [],
    endpoints: { left: 'HEAD', right: 'workingCopy' },
    commentsEnabled: true,
  }
  return { cwd, git, source, context: createReviewContext(cwd, source) }
}
it('reads left sides of renamed and deleted paths with frontend path names', async () => {
  const { context } = await fixture()
  const { revision } = await context.current()
  expect(
    await context.anchorContext({ path: 'new.txt', side: 'LEFT', line: 1, revision }),
  ).toContain('old line')
  expect(
    await context.anchorContext({ path: 'deleted.txt', side: 'LEFT', line: 1, revision }),
  ).toContain('deleted line')
  await expect(
    context.anchorContext({ path: 'deleted.txt', side: 'RIGHT', line: 1, revision }),
  ).rejects.toThrow('does not exist')
})
it('refuses stale anchors, outside-diff paths and symlink escapes', async () => {
  const { context, cwd } = await fixture()
  const { revision } = await context.current()
  await expect(
    context.anchorContext({ path: 'missing.txt', side: 'LEFT', line: 1, revision }),
  ).rejects.toThrow('outside')
  await writeFile(join(cwd, 'new.txt'), 'changed\n')
  await expect(
    context.anchorContext({ path: 'new.txt', side: 'RIGHT', line: 1, revision }),
  ).rejects.toThrow('stale')
  await rm(join(cwd, 'new.txt'))
  await symlink('/etc/passwd', join(cwd, 'new.txt'))
  await expect(
    context.anchorContext({
      path: 'new.txt',
      side: 'RIGHT',
      line: 1,
      revision: (await context.current()).revision,
    }),
  ).rejects.toThrow('escapes')
})
async function invoke(
  context: ReturnType<typeof createReviewContext>,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const tool = context.tools.find((candidate) => candidate.name === name)!
  const execute = tool.execute as unknown as (
    args: Record<string, unknown>,
    api: object,
    context: { abortSignal?: AbortSignal },
  ) => Promise<{ output: { text?: string }[] }>
  const result = await execute(args, {}, { abortSignal: signal })
  return result.output.map((item) => item.text).join('\n')
}

it('reads and searches unchanged tracked dependencies, but cannot anchor them', async () => {
  const { context, cwd } = await fixture()
  await writeFile(join(cwd, 'untracked.txt'), 'literal .* secret\n')
  const { revision } = await context.current()
  for (const side of ['LEFT', 'RIGHT']) {
    expect(
      await invoke(context, 'read_file', { revision, side, path: 'dependency.txt' }),
    ).toContain('literal .* dependency')
    expect(await invoke(context, 'list_files', { revision, side })).toContain(
      'dependency.txt',
    )
    const found = await invoke(context, 'search_files', { revision, side, query: '.*' })
    expect(found).toContain('dependency.txt:1:literal .* dependency')
    expect(found).not.toContain('untracked.txt')
  }
  await expect(
    context.anchorContext({ path: 'dependency.txt', side: 'LEFT', line: 1, revision }),
  ).rejects.toThrow('outside')
  await expect(
    invoke(
      context,
      'search_files',
      { revision, side: 'RIGHT', query: 'literal' },
      AbortSignal.abort(),
    ),
  ).rejects.toThrow()
})

it('lists and reads rename and deletion endpoint paths', async () => {
  const { context } = await fixture()
  const { revision } = await context.current()
  const left = await invoke(context, 'list_files', { revision, side: 'LEFT' })
  const right = await invoke(context, 'list_files', { revision, side: 'RIGHT' })
  expect(left).toContain('old.txt')
  expect(left).toContain('deleted.txt')
  expect(right).toContain('new.txt')
  expect(right).not.toContain('deleted.txt')
  for (const path of ['old.txt', 'new.txt'])
    expect(await invoke(context, 'read_file', { revision, side: 'LEFT', path })).toContain(
      'old line',
    )
  expect(
    await invoke(context, 'read_file', { revision, side: 'RIGHT', path: 'new.txt' }),
  ).toContain('old line')
  expect(
    await invoke(context, 'read_file', { revision, side: 'RIGHT', path: 'deleted.txt' }),
  ).toContain('file absent')
})

it('reads pinned endpoints rather than working files', async () => {
  const { cwd, git, source } = await fixture()
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'rename',
  )
  const context = createReviewContext(cwd, {
    ...source,
    args: ['HEAD^', 'HEAD'],
    endpoints: { left: 'HEAD^', right: { rev: 'HEAD' } },
  })
  await writeFile(join(cwd, 'dependency.txt'), 'not committed\n')
  const { revision } = await context.current()
  expect(
    await invoke(context, 'read_file', { revision, side: 'RIGHT', path: 'dependency.txt' }),
  ).toContain('literal .* dependency')
  await writeFile(join(cwd, 'dependency.txt'), 'another uncommitted change\n')
  expect((await context.current()).revision).toBe(revision)
})

it('rejects escaping symlinks and FIFOs without blocking; search skips them', async () => {
  const { source, cwd } = await fixture()
  const context = createReviewContext(cwd, { ...source, files: ['new.txt'] })
  await rm(join(cwd, 'dependency.txt'))
  await symlink('/etc/passwd', join(cwd, 'dependency.txt'))
  let revision = (await context.current()).revision
  await expect(
    invoke(context, 'read_file', { revision, side: 'RIGHT', path: 'dependency.txt' }),
  ).rejects.toThrow('escapes')
  expect(
    await invoke(context, 'search_files', { revision, side: 'RIGHT', query: 'root:' }),
  ).not.toContain('root:x:')
  await rm(join(cwd, 'dependency.txt'))
  execFileSync('mkfifo', [join(cwd, 'dependency.txt')])
  revision = (await context.current()).revision
  await expect(
    invoke(context, 'read_file', { revision, side: 'RIGHT', path: 'dependency.txt' }),
  ).rejects.toThrow('regular')
})

const hasJj = (() => {
  try {
    execFileSync('jj', ['--version'])
    return true
  } catch {
    return false
  }
})()
it.skipIf(!hasJj)(
  'lists NUL-delimited jj paths and reads unchanged dependencies',
  async () => {
    const { cwd } = await fixture()
    execFileSync('jj', ['git', 'init', '--colocate'], { cwd })
    const context = createReviewContext(cwd, {
      vcs: 'jj',
      args: ['-f', '@-'],
      files: ['new.txt'],
      commentsEnabled: true,
      endpoints: { left: '@-', right: 'workingCopy' },
    })
    const { revision, patch } = await context.current()
    for (const side of ['LEFT', 'RIGHT']) {
      expect(await invoke(context, 'list_files', { revision, side })).toContain(
        'dependency.txt',
      )
      expect(
        await invoke(context, 'read_file', { revision, side, path: 'dependency.txt' }),
      ).toContain('literal .* dependency')
    }
    await writeFile(join(cwd, 'dependency.txt'), 'changed jj dependency\n')
    const changed = await context.current()
    expect(changed.patch).toBe(patch)
    expect(changed.revision).not.toBe(revision)
    expect((await context.revisionForPatch(patch)).revision).toBe(changed.revision)
    await expect(
      invoke(context, 'read_file', {
        revision,
        side: 'RIGHT',
        path: 'dependency.txt',
      }),
    ).rejects.toThrow('stale')
  },
)

it('rejects internal secret links and directory links, and search skips them', async () => {
  const { cwd, git, source } = await fixture()
  await mkdir(join(cwd, 'nested'))
  await writeFile(join(cwd, 'nested', 'secret.txt'), 'safe tracked file\n')
  git('add', 'nested')
  await writeFile(join(cwd, '.gitignore'), '.env\nsecrets/\n')
  await writeFile(join(cwd, '.env'), 'UNOBSERVABLE_SECRET\n')
  await writeFile(join(cwd, '.git', 'secret.txt'), 'UNOBSERVABLE_SECRET\n')
  await mkdir(join(cwd, 'secrets'))
  await writeFile(join(cwd, 'secrets', 'secret.txt'), 'UNOBSERVABLE_SECRET\n')
  const context = createReviewContext(cwd, { ...source, files: ['new.txt'] })
  for (const target of ['.env', '.git/secret.txt', '/etc/passwd']) {
    await rm(join(cwd, 'dependency.txt'), { force: true })
    await symlink(target, join(cwd, 'dependency.txt'))
    const { revision } = await context.current()
    await expect(
      invoke(context, 'read_file', {
        revision,
        side: 'RIGHT',
        path: 'dependency.txt',
      }),
    ).rejects.toThrow('symlink')
    expect(
      await invoke(context, 'search_files', {
        revision,
        side: 'RIGHT',
        query: 'UNOBSERVABLE_SECRET',
      }),
    ).not.toContain('UNOBSERVABLE_SECRET')
  }
  await rm(join(cwd, 'nested'), { recursive: true })
  await symlink('secrets', join(cwd, 'nested'))
  const { revision } = await context.current()
  await expect(
    invoke(context, 'read_file', {
      revision,
      side: 'RIGHT',
      path: 'nested/secret.txt',
    }),
  ).rejects.toThrow('symlink')
  expect(
    await invoke(context, 'search_files', {
      revision,
      side: 'RIGHT',
      query: 'UNOBSERVABLE_SECRET',
    }),
  ).not.toContain('UNOBSERVABLE_SECRET')
  expect(
    await invoke(context, 'read_file', {
      revision,
      side: 'RIGHT',
      path: '.env',
    }),
  ).toContain('file absent')
  await writeFile(join(cwd, '.env'), 'another ignored secret\n')
  expect((await context.current()).revision).toBe(revision)
})

it('invalidates filtered reviews for dependency bytes and tracked inventory changes', async () => {
  const { cwd, git, source } = await fixture()
  const context = createReviewContext(cwd, { ...source, files: ['new.txt'] })
  const original = await context.current()
  expect((await context.revisionForPatch(original.patch)).revision).toBe(original.revision)
  git('update-index', '--assume-unchanged', 'dependency.txt')
  await writeFile(join(cwd, 'dependency.txt'), 'changed dependency\n')
  const changed = await context.current()
  expect(changed.patch).toBe(original.patch)
  expect(changed.revision).not.toBe(original.revision)
  expect((await context.revisionForPatch(original.patch)).revision).toBe(changed.revision)
  await expect(
    invoke(context, 'read_file', {
      revision: original.revision,
      side: 'RIGHT',
      path: 'dependency.txt',
    }),
  ).rejects.toThrow('stale')
  await expect(
    context.anchorContext({
      revision: original.revision,
      side: 'RIGHT',
      path: 'new.txt',
      line: 1,
    }),
  ).rejects.toThrow('stale')
  git('rm', '--cached', 'dependency.txt')
  expect((await context.current()).revision).not.toBe(changed.revision)
})

it('invalidates same-length dependency rewrites even when mtime is restored', async () => {
  const { cwd, git, source } = await fixture()
  const path = join(cwd, 'dependency.txt')
  // Whole-second mtime permits exact restoration through the Date API.
  await utimes(path, 1700000000, 1700000000)
  git('update-index', '--assume-unchanged', 'dependency.txt')
  const context = createReviewContext(cwd, { ...source, files: ['new.txt'] })
  const before = await lstat(path, { bigint: true })
  const original = await context.current()
  await writeFile(path, 'literal .* DEPENDENCY\n')
  await utimes(path, 1700000000, 1700000000)
  const after = await lstat(path, { bigint: true })
  expect(after.size).toBe(before.size)
  expect(after.mtimeNs).toBe(before.mtimeNs)
  expect(after.ctimeNs).not.toBe(before.ctimeNs)
  const changed = await context.current()
  expect(changed.patch).toBe(original.patch)
  expect(changed.revision).not.toBe(original.revision)
  await expect(
    invoke(context, 'read_file', {
      revision: original.revision,
      side: 'RIGHT',
      path: 'dependency.txt',
    }),
  ).rejects.toThrow('stale')
})

it('keeps empty files and rejected symlinks stable across reads without observing targets', async () => {
  const { cwd, git, source } = await fixture()
  await writeFile(join(cwd, 'empty.txt'), '')
  git('add', 'empty.txt')
  await writeFile(join(cwd, '.gitignore'), 'secret/\n')
  await mkdir(join(cwd, 'secret'))
  await writeFile(join(cwd, 'secret', 'target'), 'ignored secret')
  await rm(join(cwd, 'dependency.txt'))
  await symlink('secret/target', join(cwd, 'dependency.txt'))
  const context = createReviewContext(cwd, { ...source, files: ['new.txt'] })
  const { revision } = await context.current()
  expect(
    await invoke(context, 'read_file', { revision, side: 'RIGHT', path: 'empty.txt' }),
  ).not.toContain('absent')
  await expect(
    invoke(context, 'read_file', { revision, side: 'RIGHT', path: 'dependency.txt' }),
  ).rejects.toThrow('symlink')
  await writeFile(join(cwd, 'secret', 'target'), 'entirely different ignored contents')
  expect((await context.current()).revision).toBe(revision)
  await writeFile(join(cwd, 'empty.txt'), 'now nonempty')
  expect((await context.current()).revision).not.toBe(revision)
})

it('fingerprints repositories exceeding the former total content budget', async () => {
  const { cwd, git, source } = await fixture()
  await mkdir(join(cwd, 'large'))
  // Sparse files keep fixture construction cheap, but represent >256 MiB of
  // individually bounded files which the old fingerprint read on every call.
  for (let index = 0; index < 257; index++) {
    const path = join(cwd, 'large', `${index}.txt`)
    await writeFile(path, '')
    await truncate(path, 1024 * 1024)
  }
  git('add', 'large')
  const context = createReviewContext(cwd, { ...source, files: ['new.txt'] })
  const { revision } = await context.current()
  expect((await context.current()).revision).toBe(revision)
  expect(
    await invoke(context, 'read_file', { revision, side: 'RIGHT', path: 'new.txt' }),
  ).toContain('old line')
})

it('rejects unsafe repository paths', () => {
  for (const path of [
    '../secret',
    '/etc/passwd',
    '.git/config',
    'a/../b',
    '-flag',
    'a\\b',
    'a\0b',
  ])
    expect(() => validateReviewPath(path)).toThrow()
})
