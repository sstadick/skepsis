/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { exec, isolateVcsConfig } from './testUtil.ts'
import type { DiffResponse } from '../shared/types.ts'
import type { ReviewSnapshot } from '../shared/review.ts'

const home = await isolateVcsConfig()
const { startServer } = await import('./main.ts')
afterAll(() => rm(home, { recursive: true, force: true }))

it('serves a review outside the process cwd, including assets, anchored chat and SSE', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'skepsis-other-cwd-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([fauxAssistantMessage('Only the operator changed.')])
  const run = (args: string[]) => exec('git', args, { cwd })
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  let events: AbortController | undefined
  try {
    await run(['init', '-q'])
    await writeFile(join(cwd, 'code.ts'), 'const n = 1 + 2\n')
    await run(['add', '.'])
    await run(['commit', '-qm', 'base'])
    const contents = 'const n = 1 * 2\n'
    await writeFile(join(cwd, 'code.ts'), contents)
    server = await startServer({
      cwd,
      hostname: '127.0.0.1',
      diffSource: {
        vcs: 'git',
        args: ['HEAD'],
        files: [],
        commentsEnabled: true,
        endpoints: { left: 'HEAD', right: 'workingCopy' },
      },
      review: {
        directory: join(cwd, '.state'),
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
    const { token } = (await fetch(url + '/api/session').then((r) => r.json())) as {
      token: string
    }
    events = new AbortController()
    const stream = await fetch(url + '/api/events', { signal: events.signal })
    const reader = stream.body!.getReader()
    const changed = (async () => {
      let text = ''
      while (!text.includes('event: thread-changed')) {
        // One consumer maintains ordered SSE frames.
        // oxlint-disable-next-line no-await-in-loop
        const chunk = await reader.read()
        if (chunk.done) throw new Error('Event stream ended')
        text += new TextDecoder().decode(chunk.value)
      }
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
    await changed
    await expect
      .poll(async () => {
        const snapshot = (await fetch(url + '/api/review').then((r) =>
          r.json(),
        )) as ReviewSnapshot
        return snapshot.threads[0]?.turns[0]?.answer
      })
      .toBe('Only the operator changed.')
    expect(await readFile(join(cwd, 'code.ts'), 'utf8')).toBe(contents)
  } finally {
    events?.abort()
    await server?.close()
    await rm(cwd, { recursive: true, force: true })
  }
})
