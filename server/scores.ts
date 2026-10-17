/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Content-addressed scores, isolated by repo and model/rubric version.
 * One atomically replaced file per hunk avoids lost updates between workers
 * or even two Skepsis servers. Missing/corrupt/expired entries are unscored.
 */
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import type { FileScores } from '../shared/types.ts'
import { SCORE_PROFILE } from '../shared/scoring.ts'
import type { Hunk } from './hunks.ts'

const BASE_DIR = join(process.env['HOME'] ?? '~', '.local', 'share', 'skepsis')
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const scoresDir = (cwd: string) =>
  join(BASE_DIR, digest(cwd).slice(0, 12) + '.scores', SCORE_PROFILE)

interface Entry {
  hash: string
  score: number
  timestamp: number
}

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false
  const e = value as Entry
  return (
    typeof e.hash === 'string' &&
    typeof e.score === 'number' &&
    Number.isFinite(e.score) &&
    e.score >= 0 &&
    e.score <= 1 &&
    Number.isFinite(e.timestamp) &&
    e.timestamp >= Date.now() - MAX_AGE_MS
  )
}

async function readEntry(path: string): Promise<Entry | null> {
  try {
    const entry: unknown = JSON.parse(await readFile(path, 'utf8'))
    return validEntry(entry) ? entry : null
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw error
  }
}

export async function loadScoreMap(cwd: string): Promise<Map<string, number>> {
  const dir = scoresDir(cwd)
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const entries = await Promise.all(
    names.filter((n) => n.endsWith('.json')).map((n) => readEntry(join(dir, n))),
  )
  return new Map(
    entries.filter((e): e is Entry => e !== null).map((e) => [e.hash, e.score]),
  )
}

export async function loadFileScores(cwd: string, hunks: Hunk[]): Promise<FileScores> {
  const all = await loadScoreMap(cwd)
  const scores: FileScores = Object.create(null)
  for (const { hash, file, newStart, newCount, oldStart, oldCount } of hunks) {
    const score = all.get(hash)
    if (score === undefined) continue
    ;(scores[file] ??= []).push({ newStart, newCount, oldStart, oldCount, score })
  }
  return scores
}

async function writeEntry(dir: string, entry: Entry): Promise<void> {
  const path = join(dir, digest(entry.hash) + '.json')
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function saveScores(
  cwd: string,
  entries: { hash: string; score: number }[],
): Promise<void> {
  const stamped = entries.map((e) => ({ ...e, timestamp: Date.now() }))
  if (stamped.some((e) => !validEntry(e))) throw new Error('Invalid score')
  if (stamped.length === 0) return
  const dir = scoresDir(cwd)
  await mkdir(dir, { recursive: true })
  await Promise.all(stamped.map((e) => writeEntry(dir, e)))
}
