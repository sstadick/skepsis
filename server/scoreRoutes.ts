/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { Hono } from 'hono'
import type { ScoreTriggerResponse } from '../shared/types.ts'
import { parseHunks } from './hunks.ts'
import type { Hunk } from './hunks.ts'
import type { AgentRuntime } from './agentRuntime.ts'
import { ScoreStore } from './scoreQueue.ts'
import { loadScoreMap, saveScores } from './scores.ts'

export function registerScoreRoutes(
  app: Hono,
  opts: {
    cwd: string
    runtime: Pick<AgentRuntime, 'score'>
    patch: () => Promise<string>
    publish: (reason: 'score-queued' | 'scored', pending: number) => void
    mutate: <T>(fn: () => T | Promise<T>) => Promise<T>
  },
) {
  const queue = new ScoreStore({
    runtime: opts.runtime,
    loadCached: async () => new Set((await loadScoreMap(opts.cwd)).keys()),
    currentHunks: async () => parseHunks(await opts.patch()),
    save: (entries) => saveScores(opts.cwd, entries),
    publish: (reason) => opts.publish(reason, queue.pending()),
    mutate: opts.mutate,
  })

  const snapshot = (hunks: Hunk[]) => queue.snapshot(hunks)

  app.post('/api/score', async (c) => {
    return c.json((await queue.trigger()) satisfies ScoreTriggerResponse)
  })

  app.delete('/api/score', async (c) => {
    await queue.cancel()
    return c.json({ ok: true })
  })

  return { snapshot, close: () => queue.close() }
}
