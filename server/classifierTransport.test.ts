/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createReviewModels, scoreHunk } from './modelRuntime.ts'

it('settles native classifier calls on abort even when the service never replies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skepsis-classifier-abort-'))
  const requested = Promise.withResolvers<undefined>()
  const server = createServer(() => requested.resolve(undefined))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  vi.stubEnv('PI_CODING_AGENT_DIR', directory)
  vi.stubEnv('H2O_BASE_URL', `http://127.0.0.1:${address.port}/v1`)
  try {
    const { models } = await createReviewModels()
    const controller = new AbortController()
    const scoring = scoreHunk(
      models,
      { file: 'a.ts', text: '@@ -1 +1 @@\n-a\n+b' },
      controller.signal,
    )
    await requested.promise
    controller.abort()
    await expect(scoring).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    vi.unstubAllEnvs()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
