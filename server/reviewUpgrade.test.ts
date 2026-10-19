/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, expect, it } from 'vitest'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { PullRequest, ReviewSnapshot } from '../shared/review.ts'
import type { DiffArgs } from '../shared/types.ts'
import { diffCommand } from './diff.ts'
import { mountReviewApi } from './reviewApi.ts'
import { createReviewContext } from './reviewContext.ts'
import { openReviewStore, type ReviewStore } from './reviewStore.ts'

const directories: string[] = []
const stores: ReviewStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const baseSha = 'bb8473e46f4b5aa6fa69037cd8fef2fc57441490'
const headSha = 'ec52f04ea2c2020f8ee9b5fb62997b588b5ba350'
const patch =
  'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n'

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'review-upgrade-'))
  directories.push(cwd)
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' })
  git('init', '-q', '--object-format=sha1')
  await writeFile(join(cwd, 'file.txt'), 'before\n')
  const commit = (message: string) => {
    git('-c', 'core.autocrlf=false', 'add', 'file.txt')
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', message)
  }
  commit('initial')
  expect(git('rev-parse', 'HEAD').trim()).toBe(baseSha)
  await writeFile(join(cwd, 'file.txt'), 'after\n')
  return { cwd, git, commit }
}

// Independent oracle: the array and raw source serialization from
// e83ec8e:server/reviewContext.ts, NOT the new source projection. Callers supply
// literal pre-removal CLI objects, including their historical key order/bit.
function v1Revision(
  source: object,
  resolved: string[],
  servedPatch: string,
  workingIdentity: string | null = null,
  pr?: PullRequest,
) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        source,
        resolved,
        pr?.baseSha,
        pr?.headSha,
        pr?.diffBaseSha,
        servedPatch,
        workingIdentity,
      ]),
    )
    .digest('hex')
}

// These fixed digests were captured with the old array hashing algorithm and
// CLI object literals from e83ec8e. They must not be regenerated from current().
it('preserves the immutable local Git v1 hash regardless of object key order/extra keys', async () => {
  const { cwd, git, commit } = await fixture()
  commit('change')
  expect(git('rev-parse', 'HEAD').trim()).toBe(headSha)
  const source = {
    endpoints: { right: { rev: 'HEAD', extra: true }, left: 'HEAD^', extra: true },
    files: [],
    args: ['HEAD^', 'HEAD'],
    vcs: 'git' as const,
    unrelated: 'not part of revision identity',
  }
  expect((await createReviewContext(cwd, source).revisionForPatch(patch)).revision).toBe(
    '11e3a532efc8fd21d301173223619ab60d2e39b1d754d2e77b60f693867f327a',
  )
})

it('preserves the PR v1 hash with its distinct CLI property order', async () => {
  const { cwd, commit } = await fixture()
  commit('change')
  const pr: PullRequest = {
    owner: 'owner',
    repository: 'repository',
    number: 1,
    title: 'Upgrade fixture',
    url: 'https://github.com/owner/repository/pull/1',
    baseSha,
    headSha,
    diffBaseSha: baseSha,
  }
  const source: DiffArgs = {
    vcs: 'git',
    args: [baseSha, headSha],
    files: [],
    endpoints: { left: baseSha, right: { rev: headSha } },
  }
  expect(
    (await createReviewContext(cwd, source, pr).revisionForPatch(patch)).revision,
  ).toBe('f7605fa590ebbe9e0a2678260210a781b6bff29ce97003731db70afe786b5e58')
})

const hasJj = (() => {
  try {
    execFileSync('jj', ['--version'])
    return true
  } catch {
    return false
  }
})()

it.skipIf(!hasJj)('preserves the immutable jj v1 hash', async () => {
  const { cwd } = await fixture()
  execFileSync('jj', ['git', 'init', '--colocate'], { cwd })
  const source: DiffArgs = {
    vcs: 'jj',
    args: ['--from', 'root()', '--to', 'root()'],
    files: [],
    endpoints: { left: 'root()', right: { rev: 'root()' } },
  }
  expect((await createReviewContext(cwd, source).revisionForPatch('')).revision).toBe(
    '2f0d733555814b0cdf5c41448545fd683374def843ac34b3c839d97a68be4634',
  )
})

it.each([
  { vcs: 'git', rev: 'HEAD^...HEAD', bit: false },
  { vcs: 'git', rev: '..HEAD', bit: false },
  { vcs: 'jj', rev: 'root()...@', bit: true },
  { vcs: 'jj', rev: 'root()..root()..@', bit: true },
  { vcs: 'jj', rev: '..@', bit: true },
  { vcs: 'jj', rev: '@...', bit: false },
] as const)(
  'preserves v1 for $vcs exotic revset $rev with null endpoints',
  async ({ vcs, rev, bit }) => {
    const source: DiffArgs = {
      vcs,
      args: vcs === 'jj' ? ['-r', rev] : [rev],
      files: ['file.txt'],
      endpoints: null,
    }
    const expected = v1Revision(
      {
        vcs,
        args: source.args,
        commentsEnabled: bit,
        files: ['file.txt'],
        endpoints: null,
      },
      [],
      patch,
    )
    // revisionForPatch must not try to resolve unavailable endpoints.
    expect(
      (await createReviewContext('/nonexistent', source).revisionForPatch(patch)).revision,
    ).toBe(expected)
  },
)

it.skipIf(!hasJj).each([
  { args: ['--from', 'root()'], left: 'root()', right: '@', bit: true },
  { args: ['--to', '@'], left: '@', right: '@', bit: true },
  { args: ['--to', 'root()'], left: '@', right: 'root()', bit: false },
  { args: ['-r', '@'], left: '@-', right: '@', bit: true },
  { args: ['-r', 'root()'], left: 'root()-', right: 'root()', bit: false },
  { args: ['-r', 'root()..@'], left: 'root()', right: '@', bit: true },
  { args: ['-r', 'root()..root()'], left: 'root()', right: 'root()', bit: false },
])('preserves the jj CLI v1 bit for $args', async ({ args, left, right, bit }) => {
  const { cwd } = await fixture()
  execFileSync('jj', ['git', 'init', '--colocate'], { cwd })
  const source: DiffArgs = {
    vcs: 'jj',
    args,
    files: [],
    endpoints: { left, right: { rev: right } },
  }
  const resolved = [left, right].map((rev) =>
    execFileSync('jj', ['log', '--no-graph', '-r', rev, '-T', 'commit_id'], {
      cwd,
      encoding: 'utf8',
    }).trim(),
  )
  const expected = v1Revision(
    {
      vcs: 'jj',
      args,
      commentsEnabled: bit,
      files: [],
      endpoints: { left, right: { rev: right } },
    },
    resolved,
    patch,
  )
  expect((await createReviewContext(cwd, source).revisionForPatch(patch)).revision).toBe(
    expected,
  )
})

// Manual v1 workingIdentity for this single tracked, root-level file. The
// filesystem identities cannot be golden constants, but neither the expected
// hash nor the persisted old anchor calls the new context's hashing code.
async function oneFileWorkingIdentity(cwd: string, inventory: string) {
  expect(inventory.split('\0').filter(Boolean)).toHaveLength(1)
  expect(inventory.endsWith('\tfile.txt\0')).toBe(true)
  const root = await lstat(await realpath(cwd), { bigint: true })
  const file = await lstat(join(cwd, 'file.txt'), { bigint: true })
  return createHash('sha256')
    .update(inventory)
    .update(
      JSON.stringify({
        directory: true,
        identity: [root.dev, root.ino, root.mode].map(String),
      }),
    )
    .update(
      JSON.stringify([
        'file.txt',
        [
          [file.dev, file.ino, file.mode, file.size, file.mtimeNs, file.ctimeNs].map(
            String,
          ),
        ],
      ]),
    )
    .digest('hex')
}

it.each([false, true])(
  'reopens v1 working-copy threads/drafts and accepts follow-ups (default diff: %s)',
  async (defaultDiff) => {
    const { cwd, git } = await fixture()
    const args = [defaultDiff ? baseSha : 'HEAD']
    const displayArgs = defaultDiff ? ['--merge-base', 'main'] : undefined
    const source: DiffArgs = {
      vcs: 'git',
      args,
      files: [],
      endpoints: { left: args[0]!, right: 'workingCopy' },
      displayArgs,
    }
    const legacyRevision = v1Revision(
      // Exactly buildDiffSource's pre-removal return literal, not a spread of source.
      {
        vcs: 'git',
        args,
        commentsEnabled: true,
        files: [],
        endpoints: { left: args[0]!, right: 'workingCopy' },
        displayArgs,
      },
      [baseSha],
      git(...diffCommand(source).args),
      await oneFileWorkingIdentity(cwd, git('ls-files', '--stage', '-z')),
    )
    const models = createModels()
    const faux = fauxProvider({ tokensPerSecond: 100000 })
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage('Old answer'),
      fauxAssistantMessage('Upgraded follow-up'),
    ])
    const model = faux.getModel()
    const review = {
      directory: join(cwd, '.review'),
      models,
      model: { provider: model.provider, modelId: model.id },
      agent: { available: true, model: model.id },
    }
    const oldStore = await openReviewStore({
      ...review,
      cwd,
      currentRevision: legacyRevision,
      tools: [],
      onChange() {},
    })
    stores.push(oldStore)
    const anchor = {
      path: 'file.txt',
      side: 'RIGHT' as const,
      line: 1,
      revision: legacyRevision,
    }
    const id = randomUUID()
    await oldStore.ask({
      id,
      anchor,
      text: 'Original question',
      context: 'Original excerpt: after',
    })
    await expect
      .poll(async () => (await oldStore.snapshot()).threads[0]?.status)
      .toBe('answered')
    const draft = { id: randomUUID(), anchor, body: 'Saved v1 draft' }
    await oldStore.saveDraft(draft)
    const oldSnapshot = await oldStore.snapshot()
    await oldStore.close()

    const app = new Hono()
    const store = await mountReviewApi(app, {
      cwd,
      diffSource: source,
      review,
      getOrigin: () => 'http://localhost:4321',
      publish() {},
    })
    stores.push(store)
    const request = (path: string, init?: RequestInit) =>
      app.request(`http://localhost:4321${path}`, init)
    const token = (await (await request('/api/session')).json()).token
    const mutate = (path: string, body: unknown, method = 'POST') =>
      request(path, {
        method,
        headers: { 'x-skepsis-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const reopened = (await (await request('/api/review')).json()) as ReviewSnapshot
    expect(reopened.revision).toBe(legacyRevision)
    expect(reopened.threads).toEqual(oldSnapshot.threads)
    expect(reopened.drafts).toEqual([draft])
    const followup = { id: randomUUID(), text: 'Continue the old conversation' }
    expect((await mutate(`/api/threads/${id}/messages`, followup)).status).toBe(200)
    await expect
      .poll(async () => (await store.snapshot()).threads[0]?.turns[1]?.answer)
      .toBe('Upgraded follow-up')
    expect(
      (await mutate('/api/drafts', { ...draft, body: 'Edited after upgrade' }, 'PUT'))
        .status,
    ).toBe(200)
    // A fresh draft must validate the OLD anchor, not take the existing-draft shortcut.
    expect(
      (await mutate('/api/drafts', { ...draft, id: randomUUID() }, 'PUT')).status,
    ).toBe(200)
    expect((await store.snapshot()).threads[0]?.anchor).toEqual(anchor)
    expect((await store.snapshot()).publication).toBeNull()
    expect(faux.state.callCount).toBe(2)
    expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('after\n')

    await writeFile(join(cwd, 'file.txt'), 'genuinely changed after upgrade\n')
    expect(
      (await mutate(`/api/threads/${id}/messages`, { id: randomUUID(), text: 'Now stale' }))
        .status,
    ).toBe(409)
    expect(
      (await mutate('/api/drafts', { ...draft, id: randomUUID() }, 'PUT')).status,
    ).toBe(409)
    expect((await (await request('/api/review')).json()).revision).not.toBe(legacyRevision)
    expect(faux.state.callCount).toBe(2)
  },
)
