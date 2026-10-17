/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SCORE_PROFILE } from '../shared/scoring.ts'
import type { Hunk } from './hunks.ts'
import type * as ScoresModule from './scores.ts'

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// scores.ts derives its storage dir from HOME at import time, so stub HOME
// before importing dynamically (same pattern as settings.test.ts).
let home: string
let scores: typeof ScoresModule

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function scoresDir(cwd: string): string {
  return join(
    home,
    '.local',
    'share',
    'skepsis',
    `${digest(cwd).slice(0, 12)}.scores`,
    SCORE_PROFILE,
  )
}

function scoreFile(cwd: string, hash: string): string {
  return join(scoresDir(cwd), `${digest(hash)}.json`)
}

function hunk(
  hash: string,
  file: string,
  newStart: number,
  newCount: number,
  oldStart: number,
  oldCount: number,
): Hunk {
  return {
    file,
    newStart,
    newCount,
    oldStart,
    oldCount,
    hash,
    text: '',
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'skepsis-scores-'))
  vi.stubEnv('HOME', home)
  scores = await import('./scores.ts')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('score store', () => {
  it('returns empty before anything is scored', async () => {
    const cwd = '/some/repo-empty'
    expect(await scores.loadScoreMap(cwd)).toEqual(new Map())
    expect(await scores.loadFileScores(cwd, [hunk('aaa', 'a.ts', 1, 1, 1, 1)])).toEqual({})
  })

  it('round-trips scores grouped by file and keyed by full hunk ranges', async () => {
    const cwd = '/some/repo-round-trip'
    await scores.saveScores(cwd, [
      { hash: 'h1', score: 0.8 },
      { hash: 'h2', score: 0 },
    ])

    const fileScores = await scores.loadFileScores(cwd, [
      hunk('h1', 'src/auth.ts', 12, 3, 10, 2),
      hunk('h2', 'src/auth.ts', 40, 1, 39, 1),
      hunk('h3', 'src/auth.ts', 99, 2, 98, 2), // unscored
    ])

    expect(fileScores).toEqual({
      'src/auth.ts': [
        { newStart: 12, newCount: 3, oldStart: 10, oldCount: 2, score: 0.8 },
        { newStart: 40, newCount: 1, oldStart: 39, oldCount: 1, score: 0 },
      ],
    })
  })

  it('exposes the raw score map for worker queue decisions', async () => {
    const cwd = '/some/repo-map'
    await scores.saveScores(cwd, [
      { hash: 'h1', score: 0.8 },
      { hash: 'h2', score: 0.1 },
    ])

    expect(await scores.loadScoreMap(cwd)).toEqual(
      new Map([
        ['h1', 0.8],
        ['h2', 0.1],
      ]),
    )
  })

  it('namespaces cache entries by repo and SCORE_PROFILE', async () => {
    const repoA = '/some/repo-a'
    const repoB = '/some/repo-b'
    await scores.saveScores(repoA, [{ hash: 'shared', score: 0.2 }])
    await scores.saveScores(repoB, [{ hash: 'shared', score: 0.9 }])

    expect(scoresDir(repoA)).toContain(`/${SCORE_PROFILE}`)
    expect(scoresDir(repoB)).toContain(`/${SCORE_PROFILE}`)
    expect(scoresDir(repoA)).not.toBe(scoresDir(repoB))
    expect(await readdir(scoresDir(repoA))).toContain(`${digest('shared')}.json`)
    expect(await readdir(scoresDir(repoB))).toContain(`${digest('shared')}.json`)
    expect(await scores.loadScoreMap(repoA)).toEqual(new Map([['shared', 0.2]]))
    expect(await scores.loadScoreMap(repoB)).toEqual(new Map([['shared', 0.9]]))
  })

  it('supports concurrent writes without losing entries', async () => {
    const cwd = '/some/repo-concurrent'
    const entries = Array.from({ length: 16 }, (_, i) => ({
      hash: `h${i}`,
      score: i / 20,
    }))

    await Promise.all(entries.map((entry) => scores.saveScores(cwd, [entry])))

    expect(await scores.loadScoreMap(cwd)).toEqual(
      new Map(entries.map((entry) => [entry.hash, entry.score])),
    )
  })

  it('ignores invalid, expired, and corrupt cache entries while preserving zero scores', async () => {
    const cwd = '/some/repo-garbage'
    const dir = scoresDir(cwd)
    await mkdir(dir, { recursive: true })
    await writeFile(
      scoreFile(cwd, 'zero'),
      JSON.stringify({ hash: 'zero', score: 0, timestamp: Date.now() }),
    )
    await writeFile(
      join(dir, 'expired.json'),
      JSON.stringify({
        hash: 'expired',
        score: 0.7,
        timestamp: Date.now() - MAX_AGE_MS - 1,
      }),
    )
    await writeFile(
      join(dir, 'invalid.json'),
      JSON.stringify({ hash: 'invalid', score: 'nope', timestamp: Date.now() }),
    )
    await writeFile(join(dir, 'corrupt.json'), 'not json')
    await writeFile(
      join(dir, 'ignored.txt'),
      JSON.stringify({ hash: 'ignored', score: 0.5 }),
    )

    expect(await scores.loadScoreMap(cwd)).toEqual(new Map([['zero', 0]]))
    expect(
      await scores.loadFileScores(cwd, [
        hunk('zero', 'src/zero.ts', 7, 2, 5, 1),
        hunk('expired', 'src/zero.ts', 20, 1, 20, 1),
      ]),
    ).toEqual({
      'src/zero.ts': [{ newStart: 7, newCount: 2, oldStart: 5, oldCount: 1, score: 0 }],
    })
  })

  it('overwrites an existing hunk score', async () => {
    const cwd = '/some/repo-overwrite'
    await scores.saveScores(cwd, [{ hash: 'h1', score: 0.25 }])
    await scores.saveScores(cwd, [{ hash: 'h1', score: 0.75 }])

    expect((await scores.loadScoreMap(cwd)).get('h1')).toBe(0.75)
  })
})
