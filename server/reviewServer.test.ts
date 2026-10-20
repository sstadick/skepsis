/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { exec, isolateVcsConfig } from './testUtil.ts'
import type { DiffArgs, DiffResponse } from '../shared/types.ts'
import type { ReviewSnapshot } from '../shared/review.ts'
import type { ReviewOptions } from './reviewApi.ts'

const home = await isolateVcsConfig()
const { startServer } = await import('./main.ts')
afterAll(() => rm(home, { recursive: true, force: true }))

async function reviewFixture(historical = false) {
  const directory = await mkdtemp(join(tmpdir(), 'skepsis-other-cwd-'))
  const cwd = join(directory, 'repo')
  await mkdir(cwd)
  const run = (args: string[]) => exec('git', args, { cwd })
  await run(['init', '-q'])
  const base = 'const n = 1 + 2\n'
  await writeFile(join(cwd, 'code.ts'), base)
  await run(['add', '.'])
  await run(['commit', '-qm', 'base'])
  const contents = historical ? base : 'const n = 1 * 2\n'
  await writeFile(join(cwd, 'code.ts'), contents)
  // A traversal target outside the reviewed repo, with an existing source-backed
  // block and non-normalized bytes. No blocked route may insert, append or delete.
  const outside = join(directory, 'outside.ts')
  const outsideContents = Buffer.from(
    'const outside = 1\r\n// <review>\r\n// @pi Leave this alone\r\n// </review>\r\n',
  )
  await writeFile(outside, outsideContents)
  const diffSource: DiffArgs = {
    vcs: 'git',
    args: historical ? ['HEAD', 'HEAD'] : ['HEAD'],
    files: [],
    endpoints: { left: 'HEAD', right: historical ? { rev: 'HEAD' } : 'workingCopy' },
  }
  return { directory, cwd, contents, outside, outsideContents, diffSource }
}

function pausedReview(directory: string): ReviewOptions {
  return {
    directory,
    models: createModels(),
    agent: { available: false, model: null, error: 'Agent disabled (--no-agent)' },
  }
}

async function snapshot(url: string): Promise<ReviewSnapshot> {
  const response = await fetch(url + '/api/review')
  expect(response.status).toBe(200)
  return response.json()
}

async function sessionToken(url: string): Promise<string> {
  const response = await fetch(url + '/api/session')
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

async function assertLegacyUnavailable(
  url: string,
  token: string,
  id: string = randomUUID(),
) {
  const routes: { method: string; path: string; body?: unknown }[] = [
    { method: 'POST', path: '/api/questions/claim', body: { backend: 'pi' } },
    {
      method: 'POST',
      path: `/api/questions/${id}/answer`,
      body: { leaseId: 'legacy-lease', answer: 'Not a private answer' },
    },
    {
      method: 'POST',
      path: `/api/questions/${id}/fail`,
      body: { leaseId: 'legacy-lease', error: 'Not a private failure' },
    },
    { method: 'POST', path: '/api/comment', body: {} },
    { method: 'POST', path: '/api/questions', body: {} },
    { method: 'PUT', path: '/api/comment/unknown/nested', body: {} },
    { method: 'DELETE', path: '/api/questions/unknown/nested', body: {} },
    { method: 'OPTIONS', path: '/api/comment' },
    { method: 'OPTIONS', path: '/api/questions' },
  ]
  for (const file of ['code.ts', '../outside.ts']) {
    for (const text of ['A source comment', '@pi Why?', '@claude Why?', '@codex Why?']) {
      routes.push({
        method: 'POST',
        path: '/api/comment',
        body: { file, afterLine: 1, text },
      })
    }
    routes.push(
      {
        method: 'POST',
        path: '/api/comment/follow-up',
        body: { file, line: 2, text: 'A source follow-up' },
      },
      { method: 'DELETE', path: '/api/comment', body: { file, line: 2 } },
    )
  }
  // Include the namespace roots, known routes and unknown descendants: none
  // should fall through to the SPA, including GETs of mutation-only routes.
  for (const path of new Set([
    ...routes.map((route) => route.path),
    '/api/comment/',
    '/api/questions/',
  ])) {
    routes.push({ method: 'GET', path })
  }
  const credentials: Record<string, string>[] = [
    {},
    { 'x-skepsis-token': token },
    { authorization: 'Bearer still-live-legacy-token' },
    { 'x-skepsis-token': token, authorization: 'Bearer still-live-legacy-token' },
  ]
  await Promise.all(
    routes.flatMap(({ method, path, body }) =>
      credentials.map(async (headers) => {
        const response = await fetch(url + path, {
          method,
          headers: { 'content-type': 'application/json', origin: url, ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        expect(response.status, `${method} ${path}`).toBe(410)
        expect(response.headers.get('content-type')).toContain('application/json')
        expect(await response.json()).toEqual({
          error: expect.stringMatching(
            /source-backed comments.*external question queue.*removed.*private chats/i,
          ),
        })
      }),
    ),
  )
}

it('serves a review outside the process cwd, including assets, anchored chat and SSE', async () => {
  const fixture = await reviewFixture()
  const { cwd, contents, diffSource } = fixture
  const faux = fauxProvider({ tokensPerSecond: 100000 })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([fauxAssistantMessage('Only the operator changed.')])
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  let events: AbortController | undefined
  try {
    server = await startServer({
      cwd,
      hostname: '127.0.0.1',
      diffSource,
      review: {
        directory: join(fixture.directory, 'state'),
        models,
        model: { provider: 'faux', modelId: 'faux-1' },
        agent: { available: true, model: 'faux/faux-1' },
      },
    })
    const url = `http://127.0.0.1:${server.port}`
    if (existsSync(join(import.meta.dirname, '../dist/web/index.html'))) {
      const html = await fetch(url).then((r) => r.text())
      const assetPath = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1]
      expect(assetPath).toBeTruthy()
      const asset = await fetch(url + assetPath)
      expect(asset.headers.get('content-type')).toMatch(/javascript/)
      expect((await asset.text()).startsWith('<!')).toBe(false)
    }
    const diff = (await fetch(url + '/api/diff').then((r) => r.json())) as DiffResponse
    const review = (await fetch(url + '/api/review').then((r) =>
      r.json(),
    )) as ReviewSnapshot
    expect(diff.patch).toContain('+const n = 1 * 2')
    expect(diff.reviewRevision).toBe(review.revision)
    const token = await sessionToken(url)
    events = new AbortController()
    const stream = await fetch(url + '/api/events', { signal: events.signal })
    const reader = stream.body!.getReader()
    const changed = (async () => {
      let text = ''
      while (!text.includes('data: {"reason":"thread-changed"}')) {
        // One consumer maintains ordered SSE frames.
        // oxlint-disable-next-line no-await-in-loop
        const chunk = await reader.read()
        if (chunk.done) throw new Error('Event stream ended')
        text += new TextDecoder().decode(chunk.value)
      }
      return text
    })()
    const ask = await fetch(url + '/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-skepsis-token': token },
      body: JSON.stringify({
        id: randomUUID(),
        anchor: { path: 'code.ts', side: 'LEFT', line: 1, revision: diff.reviewRevision },
        text: 'What changed?',
      }),
    })
    expect(ask.status).toBe(200)
    const eventText = await changed
    expect(eventText).toContain('event: thread-changed')
    expect(eventText).toContain('data: {"reason":"thread-changed"}')
    expect(eventText).not.toContain('event: review-changed')
    await expect
      .poll(async () => (await snapshot(url)).threads[0]?.turns[0]?.answer)
      .toBe('Only the operator changed.')
    const before = await snapshot(url)
    await assertLegacyUnavailable(url, token, before.threads[0]!.id)
    expect(await snapshot(url)).toEqual(before)
    faux.setResponses([fauxAssistantMessage('The private conversation still works.')])
    const followUp = await fetch(url + `/api/threads/${before.threads[0]!.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-skepsis-token': token },
      body: JSON.stringify({ id: randomUUID(), text: 'And now?' }),
    })
    expect(followUp.status).toBe(200)
    await expect
      .poll(async () => (await snapshot(url)).threads[0]?.turns[1]?.answer)
      .toBe('The private conversation still works.')
    expect(await readFile(join(cwd, 'code.ts'))).toEqual(Buffer.from(contents))
    expect(await readFile(fixture.outside)).toEqual(fixture.outsideContents)
  } finally {
    events?.abort()
    await server?.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
}, 15000)

describe.each(['working copy', 'historical'] as const)('%s review', (comparison) => {
  it('returns 410 for removed routes in diff-only mode without changing source', async () => {
    const fixture = await reviewFixture(comparison === 'historical')
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      server = await startServer({
        cwd: fixture.cwd,
        hostname: '127.0.0.1',
        diffSource: fixture.diffSource,
      })
      await assertLegacyUnavailable(`http://127.0.0.1:${server.port}`, 'obsolete-token')
      expect(await readFile(join(fixture.cwd, 'code.ts'))).toEqual(
        Buffer.from(fixture.contents),
      )
      expect(await readFile(fixture.outside)).toEqual(fixture.outsideContents)
    } finally {
      await server?.close()
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it.each([false, true])(
    'blocks every legacy API with and without tokens (--no-agent=%s)',
    async (noAgent) => {
      const fixture = await reviewFixture(comparison === 'historical')
      let server: Awaited<ReturnType<typeof startServer>> | undefined
      try {
        expect(fixture.cwd).not.toBe(process.cwd())
        const review = pausedReview(join(fixture.directory, 'state'))
        if (!noAgent) {
          const faux = fauxProvider()
          const models = createModels()
          models.setProvider(faux.provider)
          review.models = models
          review.model = { provider: 'faux', modelId: 'faux-1' }
          review.agent = { available: true, model: 'faux/faux-1' }
        }
        server = await startServer({
          cwd: fixture.cwd,
          hostname: '127.0.0.1',
          diffSource: fixture.diffSource,
          review,
        })
        const url = `http://127.0.0.1:${server.port}`
        const token = await sessionToken(url)
        const before = await snapshot(url)
        const diff = (await fetch(url + '/api/diff').then((r) => r.json())) as DiffResponse
        expect(diff).not.toHaveProperty('commentsEnabled')
        expect(diff).not.toHaveProperty('commentSyntaxes')
        expect(diff.patch === '').toBe(comparison === 'historical')
        expect(diff.reviewRevision).toBe(before.revision)
        await assertLegacyUnavailable(url, token)

        // The 410 handlers must stay behind the durable Host/Origin boundary.
        const forbiddenHeaders: Record<string, string>[] = [
          { origin: 'https://attacker.invalid' },
          { origin: 'null' },
          { host: 'attacker.invalid' },
          { 'sec-fetch-site': 'cross-site' },
        ]
        await Promise.all(
          [
            '/api/comment',
            '/api/comment/follow-up',
            '/api/questions',
            '/api/questions/claim',
          ].flatMap((path) =>
            ['GET', 'POST'].flatMap((method) =>
              forbiddenHeaders.map(async (headers) => {
                // Node fetch rewrites Host; use HTTP directly so the spoofed
                // header actually reaches the server's DNS-rebinding guard.
                const response = await new Promise<{ status: number; body: string }>(
                  (resolve, reject) => {
                    const req = request(
                      url + path,
                      { method, headers: { 'x-skepsis-token': token, ...headers } },
                      (res) => {
                        let body = ''
                        res.setEncoding('utf8')
                        res.on('data', (chunk) => {
                          body += chunk
                        })
                        res.on('end', () => resolve({ status: res.statusCode!, body }))
                        res.on('error', reject)
                      },
                    )
                    req.on('error', reject)
                    req.end()
                  },
                )
                expect(
                  response.status,
                  `${method} ${path} ${JSON.stringify(headers)}`,
                ).toBe(403)
                expect(JSON.parse(response.body)).toEqual({
                  error: 'Forbidden origin or host',
                })
              }),
            ),
          ),
        )
        if (noAgent) {
          const response = await fetch(url + '/api/threads', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-skepsis-token': token },
            body: JSON.stringify({
              id: randomUUID(),
              anchor: { path: 'code.ts', side: 'LEFT', line: 1, revision: before.revision },
              text: 'Keep model work paused',
            }),
          })
          expect(response.status).toBe(503)
          expect(await response.json()).toEqual({ error: 'Review agent unavailable' })
        }
        expect(await snapshot(url)).toEqual(before)
        expect(await readFile(join(fixture.cwd, 'code.ts'))).toEqual(
          Buffer.from(fixture.contents),
        )
        expect(await readFile(fixture.outside)).toEqual(fixture.outsideContents)
      } finally {
        await server?.close()
        await rm(fixture.directory, { recursive: true, force: true })
      }
    },
  )
})

it('confines browser expansion to safe tracked files, including both rename paths', async () => {
  const fixture = await reviewFixture()
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    await writeFile(join(fixture.cwd, '.gitignore'), '.env\n')
    await writeFile(join(fixture.cwd, '.env'), 'fixture secret, not source\n')
    server = await startServer({
      cwd: fixture.cwd,
      hostname: '127.0.0.1',
      diffSource: fixture.diffSource,
      review: pausedReview(join(fixture.directory, 'state')),
    })
    const url = `http://127.0.0.1:${server.port}`
    const expand = (path: string, oldPath?: string) =>
      fetch(
        `${url}/api/file-contents?${new URLSearchParams({ path, ...(oldPath ? { oldPath } : {}) })}`,
      )
    const valid = await expand('code.ts')
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({
      oldContents: 'const n = 1 + 2\n',
      newContents: fixture.contents,
    })
    const invalid = await Promise.all([
      expand('../outside.ts'),
      expand('.git/config'),
      expand('code.ts', '../outside.ts'),
    ])
    await Promise.all(
      invalid.map(async (response) => {
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'Invalid repository path' })
      }),
    )
    expect(await (await expand('.env')).json()).toEqual({
      oldContents: null,
      newContents: null,
    })
    await rm(join(fixture.cwd, 'code.ts'))
    await symlink('.env', join(fixture.cwd, 'code.ts'))
    const linked = await expand('code.ts')
    expect(linked.status).toBe(409)
    expect(await linked.text()).not.toContain('fixture secret')
  } finally {
    await server?.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

it.each([
  ['private', 'absent'],
  ['private', 'live legacy sentinel'],
  ['diff-only', 'absent'],
  ['diff-only', 'live legacy sentinel'],
] as const)(
  '%s mode leaves %s discovery untouched across two sessions in the same cwd',
  async (mode, discovery) => {
    const fixture = await reviewFixture()
    const hash = createHash('sha256').update(fixture.cwd).digest('hex').slice(0, 12)
    const discoveryFile = join(home, '.local', 'share', 'skepsis', `${hash}.server.json`)
    const sentinel = Buffer.from(
      '{ "url": "http://127.0.0.1:12345", "token": "still-live-legacy-token" }\n',
    )
    let first: Awaited<ReturnType<typeof startServer>> | undefined
    let second: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      if (discovery === 'live legacy sentinel') {
        await mkdir(join(home, '.local', 'share', 'skepsis'), { recursive: true })
        await writeFile(discoveryFile, sentinel)
      }
      const originalStat = await stat(discoveryFile).catch(() => undefined)
      const assertDiscoveryUntouched = async () => {
        if (discovery === 'absent') {
          await expect(readFile(discoveryFile)).rejects.toMatchObject({
            code: 'ENOENT',
          })
        } else {
          expect(await readFile(discoveryFile)).toEqual(sentinel)
          const currentStat = await stat(discoveryFile)
          expect(currentStat.ino).toBe(originalStat!.ino)
          expect(currentStat.mtimeMs).toBe(originalStat!.mtimeMs)
          expect(currentStat.ctimeMs).toBe(originalStat!.ctimeMs)
        }
      }
      await assertDiscoveryUntouched()
      const options = {
        cwd: fixture.cwd,
        hostname: '127.0.0.1',
        diffSource: fixture.diffSource,
      }
      first = await startServer({
        ...options,
        review:
          mode === 'private' ? pausedReview(join(fixture.directory, 'state-1')) : undefined,
      })
      await assertDiscoveryUntouched()
      second = await startServer({
        ...options,
        review:
          mode === 'private' ? pausedReview(join(fixture.directory, 'state-2')) : undefined,
      })
      await assertDiscoveryUntouched()
      if (mode === 'private') {
        const firstToken = await sessionToken(`http://127.0.0.1:${first.port}`)
        expect(await sessionToken(`http://127.0.0.1:${second.port}`)).not.toBe(firstToken)
      }
      await first.close()
      first = undefined
      await assertDiscoveryUntouched()
      if (mode === 'private') {
        expect((await snapshot(`http://127.0.0.1:${second.port}`)).threads).toEqual([])
      }
      const response = await fetch(`http://127.0.0.1:${second.port}/api/diff`)
      expect(response.status).toBe(200)
      expect(((await response.json()) as DiffResponse).patch).toContain('+const n = 1 * 2')
      await second.close()
      second = undefined
      await assertDiscoveryUntouched()
    } finally {
      await first?.close()
      await second?.close()
      await rm(fixture.directory, { recursive: true, force: true })
      await rm(discoveryFile, { force: true })
    }
  },
)
