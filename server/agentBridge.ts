/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REVIEW_CLOSE_TAG, REVIEW_OPEN_TAG } from '../shared/reviewComments.ts'

export interface AgentBridgeConfig {
  url: string
  token?: string
}

export interface AgentQuestionRequest {
  file: string
  line: number
  question: string
  excerpt: string
  lineText: string
}

const PI_QUESTION_PREFIX = /^\s*@pi\b[:\s-]*/i

export function parsePiQuestion(text: string): string | null {
  const lines = text.trim().split('\n')
  const first = lines[0]
  if (!first) return null
  const match = first.match(PI_QUESTION_PREFIX)
  if (!match) return null
  const question = [first.slice(match[0].length), ...lines.slice(1)].join('\n').trim()
  if (!question) throw new Error('Pi question comments need a question after @pi')
  return question
}

export async function getQuestionContext(
  cwd: string,
  file: string,
  line: number,
): Promise<{ lineText: string; excerpt: string }> {
  const content = await readFile(join(cwd, file), 'utf-8')
  const lines = content.split('\n')
  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range (file has ${lines.length} lines)`)
  }

  const start = Math.max(1, line - 4)
  const end = Math.min(lines.length, line + 4)
  const width = String(end).length
  const excerptLines: string[] = []
  for (let n = start; n <= end; n++) {
    excerptLines.push(
      `${n === line ? '>' : ' '} ${String(n).padStart(width)} | ${lines[n - 1] ?? ''}`,
    )
  }

  return {
    lineText: lines[line - 1] ?? '',
    excerpt: excerptLines.join('\n'),
  }
}

export async function askPiQuestion(
  bridge: AgentBridgeConfig | undefined,
  req: AgentQuestionRequest,
): Promise<string> {
  if (!bridge) {
    throw new Error(
      'Pi question comments require Skepsis to be started from a pi session with /skepsis.',
    )
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (bridge.token) headers['authorization'] = `Bearer ${bridge.token}`

  const res = await fetch(new URL('/question', bridge.url), {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  })
  const data = (await res.json().catch(() => null)) as {
    answer?: string
    error?: string
  } | null
  if (!res.ok) throw new Error(data?.error ?? `Pi bridge request failed (${res.status})`)

  const answer = data?.answer?.trim()
  if (!answer) throw new Error('Pi bridge returned an empty answer')
  return answer
}

function sanitizeAnswer(text: string): string {
  return text
    .replaceAll(REVIEW_OPEN_TAG, `\`${REVIEW_OPEN_TAG}\``)
    .replaceAll(REVIEW_CLOSE_TAG, `\`${REVIEW_CLOSE_TAG}\``)
}

export function appendPiAnswer(text: string, answer: string): string {
  return `${text.trimEnd()}\n\nAnswer:\n${sanitizeAnswer(answer.trim())}`
}
