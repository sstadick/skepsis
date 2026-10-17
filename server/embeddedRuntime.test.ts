/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Message,
  type ToolResultMessage,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentQuestion } from './agentRuntime.ts'
import { createEmbeddedRuntime } from './embeddedRuntime.ts'
import type { ReviewModelsResult } from './modelRuntime.ts'

const tempPaths: string[] = []

function trackTemp(path: string): string {
  tempPaths.push(path)
  return path
}

async function createRuntimeRig() {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'skepsis-embedded-runtime-')))
  const repo = join(root, 'repo')
  const storage = join(root, 'storage')
  await mkdir(repo, { recursive: true })
  await writeFile(join(repo, 'safe.ts'), 'export const safe = 1\nexport const other = 2\n')

  const faux = fauxProvider({
    provider: `faux-review-${Math.random().toString(36).slice(2)}`,
  })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  if (!model) throw new Error('missing faux model')

  const loadModels = vi.fn(
    async (): Promise<ReviewModelsResult> => ({
      models,
      model: { provider: model.provider, modelId: model.id },
    }),
  )

  return {
    repo,
    storage,
    faux,
    loadModels,
    runtime: () => createEmbeddedRuntime(repo, { directory: storage, loadModels }),
  }
}

function question(overrides: Partial<AgentQuestion> = {}): AgentQuestion {
  return {
    threadId: 'thread-1',
    requestId: 'request-1',
    file: 'safe.ts',
    line: 1,
    excerpt: '> 1 | export const safe = 1',
    question: 'What does this do?',
    messages: [],
    ...overrides,
  }
}

function userText(message: Extract<Message, { role: 'user' }>): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function toolResultText(message: ToolResultMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'))
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return await new Promise<never>(() => {})
  return await new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(abortError(signal.reason))
      return
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(abortError(signal.reason))
      },
      { once: true },
    )
  })
}

function lastToolResult(context: TranscriptContext): ToolResultMessage {
  const results = context.messages.filter(
    (message): message is ToolResultMessage => message.role === 'toolResult',
  )
  const last = results.at(-1)
  if (!last) throw new Error('missing tool result')
  return last
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('createEmbeddedRuntime', () => {
  it('does not lazily initialize on create or canResume, and unregistered requests cannot resume', async () => {
    const rig = await createRuntimeRig()
    const runtime = rig.runtime()

    expect(rig.loadModels).not.toHaveBeenCalled()
    expect(existsSync(rig.storage)).toBe(false)

    await expect(runtime.canResume('missing-thread', 'missing-request')).resolves.toBe(
      false,
    )

    expect(rig.loadModels).not.toHaveBeenCalled()
    expect(existsSync(rig.storage)).toBe(false)

    await runtime.close()
  })

  it('reuses the durable answer after restart without another model call', async () => {
    const rig = await createRuntimeRig()
    rig.faux.setResponses([fauxAssistantMessage('Durable answer')])
    const input = question()

    const first = rig.runtime()
    await expect(first.answer(input, AbortSignal.timeout(10_000))).resolves.toBe(
      'Durable answer',
    )
    expect(rig.faux.state.callCount).toBe(1)
    await first.close()

    const restarted = rig.runtime()
    await expect(restarted.answer(input, AbortSignal.timeout(10_000))).resolves.toBe(
      'Durable answer',
    )
    expect(rig.faux.state.callCount).toBe(1)
    await restarted.close()
  })

  it('shows earlier thread history to follow-up questions', async () => {
    const rig = await createRuntimeRig()
    const firstInput = question({ requestId: 'request-1', question: 'What changed?' })
    const secondInput = question({ requestId: 'request-2', question: 'What about tests?' })

    rig.faux.setResponses([
      fauxAssistantMessage('First answer'),
      async (context) => {
        const userMessages = context.messages.filter(
          (message): message is Extract<Message, { role: 'user' }> =>
            message.role === 'user',
        )
        const assistantMessages = context.messages.filter(
          (message): message is AssistantMessage => message.role === 'assistant',
        )

        expect(userMessages).toHaveLength(2)
        expect(JSON.parse(userText(userMessages[0]!))).toMatchObject({
          question: firstInput.question,
        })
        expect(JSON.parse(userText(userMessages[1]!))).toMatchObject({
          question: secondInput.question,
        })
        expect(assistantMessages.map(assistantText)).toContain('First answer')

        return fauxAssistantMessage('Second answer')
      },
    ])

    const runtime = rig.runtime()
    await expect(runtime.answer(firstInput, AbortSignal.timeout(10_000))).resolves.toBe(
      'First answer',
    )
    await expect(runtime.answer(secondInput, AbortSignal.timeout(10_000))).resolves.toBe(
      'Second answer',
    )
    expect(rig.faux.state.callCount).toBe(2)
    await runtime.close()
  })

  it('closes with pending work preserved so the same request can answer after restart', async () => {
    const rig = await createRuntimeRig()
    const started = Promise.withResolvers<undefined>()
    const input = question()

    rig.faux.setResponses([
      async (_context, options) => {
        started.resolve(undefined)
        return await waitForAbort(options?.signal)
      },
      fauxAssistantMessage('Recovered answer'),
    ])

    const first = rig.runtime()
    const pending = first.answer(input, AbortSignal.timeout(10_000))
    await started.promise

    await expect(first.canResume(input.threadId, input.requestId)).resolves.toBe(true)

    const close = first.close()
    await expect(pending).rejects.toThrow()
    await close

    const restarted = rig.runtime()
    await expect(restarted.canResume(input.threadId, input.requestId)).resolves.toBe(true)
    await expect(restarted.answer(input, AbortSignal.timeout(10_000))).resolves.toBe(
      'Recovered answer',
    )
    expect(rig.faux.state.callCount).toBe(2)
    await restarted.close()
  })

  it('settles cancelled inputs so later questions do not resume stale work', async () => {
    const rig = await createRuntimeRig()
    const started = Promise.withResolvers<undefined>()
    rig.faux.setResponses([
      async (_context, options) => {
        started.resolve(undefined)
        return waitForAbort(options?.signal)
      },
      fauxAssistantMessage('Fresh answer'),
    ])
    const runtime = rig.runtime()
    const controller = new AbortController()
    const pending = runtime.answer(question(), controller.signal)
    await started.promise
    controller.abort()
    await expect(pending).rejects.toThrow()
    await expect(
      runtime.answer(question({ requestId: 'followup' }), AbortSignal.timeout(10000)),
    ).resolves.toBe('Fresh answer')
    expect(rig.faux.state.callCount).toBe(2)
    await runtime.close()
  })

  it('prevents concurrent owners from answering the same stored thread', async () => {
    const rig = await createRuntimeRig()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()

    rig.faux.setResponses([
      async () => {
        entered.resolve(undefined)
        await release.promise
        return fauxAssistantMessage('First owner answer')
      },
    ])

    const first = rig.runtime()
    const second = rig.runtime()
    const running = first.answer(question(), AbortSignal.timeout(10_000))
    await entered.promise

    await expect(
      second.answer(
        question({ requestId: 'request-2', question: 'Can I take over?' }),
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toThrow()
    expect(rig.faux.state.callCount).toBe(1)

    release.resolve(undefined)
    await expect(running).resolves.toBe('First owner answer')
    await first.close()
    await second.close()
  })

  it('keeps read_file scoped to the repo and blocks symlink escapes', async () => {
    const rig = await createRuntimeRig()
    const outsideName = 'outside.txt'
    const outsidePath = join(rig.repo, '..', outsideName)
    const linkName = 'leak.txt'
    await writeFile(outsidePath, 'outside\n')
    await symlink(outsidePath, join(rig.repo, linkName))

    rig.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('read_file', { path: 'safe.ts', startLine: 1, maxLines: 2 })],
        { stopReason: 'toolUse' },
      ),
      async (context) => {
        const result = lastToolResult(context)
        expect(result.toolName).toBe('read_file')
        expect(result.isError).toBe(false)
        expect(toolResultText(result)).toContain('1: export const safe = 1')
        return fauxAssistantMessage('Read succeeded')
      },
      fauxAssistantMessage([fauxToolCall('read_file', { path: `../${outsideName}` })], {
        stopReason: 'toolUse',
      }),
      async (context) => {
        const result = lastToolResult(context)
        expect(result.isError).toBe(true)
        expect(toolResultText(result)).toContain(
          `Unsafe review file path: ../${outsideName}`,
        )
        return fauxAssistantMessage('Relative escape blocked')
      },
      fauxAssistantMessage([fauxToolCall('read_file', { path: linkName })], {
        stopReason: 'toolUse',
      }),
      async (context) => {
        const result = lastToolResult(context)
        expect(result.isError).toBe(true)
        expect(toolResultText(result)).toContain(`Unsafe review file path: ${linkName}`)
        return fauxAssistantMessage('Symlink escape blocked')
      },
    ])

    const runtime = rig.runtime()
    await expect(
      runtime.answer(question({ requestId: 'request-safe' }), AbortSignal.timeout(10_000)),
    ).resolves.toBe('Read succeeded')
    await expect(
      runtime.answer(
        question({ requestId: 'request-outside' }),
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBe('Relative escape blocked')
    await expect(
      runtime.answer(
        question({ requestId: 'request-symlink' }),
        AbortSignal.timeout(10_000),
      ),
    ).resolves.toBe('Symlink escape blocked')
    await runtime.close()
  })
})
