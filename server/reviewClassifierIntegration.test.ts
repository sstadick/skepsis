/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { createModels, type MutableModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry, defineTool } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { expect, it } from 'vitest'
import { setupReviewAgentWithEnvironment } from './reviewAgent.ts'
import { openReviewStore, type ReviewStore } from './reviewStore.ts'

// Inspect the committed native ledger only while the review store is closed.
// No resume/submit: unfinished classifier work must not run in this inspector.
async function toolUsage(directory: string) {
  const inspector = await Harness.open(
    await openNodeSqliteStorage(join(directory, 'review.sqlite')),
    { models: createModels(), registry: createRegistry() },
    context,
  )
  try {
    return (await inspector.usage(context)).tools
  } finally {
    await inspector.close(context)
  }
}

it.each(
  [false, true].flatMap((changePolicy) =>
    [false, true].map((viaTool) => ({ changePolicy, viaTool })),
  ),
)(
  'replays a configured classifier result without resending or double-counting usage (policy changed: $changePolicy, parallel tool: $viaTool)',
  async ({ changePolicy, viaTool }) => {
    const directory = await mkdtemp(join(tmpdir(), 'skepsis-classifier-integration-'))
    const requests: { url: string; authorization?: string; body: unknown }[] = []
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push({
        url: request.url!,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          usage: { input_tokens: 13, output_tokens: 5 },
          answers: {
            flag: { type: 'noul', noul: 0.7 },
            level: { type: 'score', score: 1.2, confidence: 0.6 },
            pick: {
              type: 'choice',
              choice: 'yes',
              probabilities: { yes: 0.8, no: 0.2 },
              confidence: 0.8,
            },
          },
        }),
      )
    })
    let store: ReviewStore | undefined
    let waitCalls = 0
    let aborted = false
    let finalChecked = false
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing address')
      const endpoint = `http://127.0.0.1:${address.port}/custom/prefix/decision`
      const configPath = join(directory, 'classifier.json')
      const config = {
        provider: 'fixture-decider',
        model: 'arbitrary-decision-model',
        endpoint,
        apiKeyEnv: 'DECISION_KEY',
        timeoutMs: 2000,
        cost: { input: 2, output: 4 },
      }
      const inputCost = (config.cost.input / 1_000_000) * 13
      const outputCost = (config.cost.output / 1_000_000) * 5
      const expectedUsage = {
        input: 13,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 18,
        cost: {
          input: inputCost,
          output: outputCost,
          cacheRead: 0,
          cacheWrite: 0,
          total: inputCost + outputCost,
        },
      }
      const expectedToolUsage = {
        [viaTool ? 'classify_review' : 'pi.codemode.models.classify']: expectedUsage,
      }
      await writeFile(configPath, JSON.stringify(config))
      const cwd = join(directory, 'source')
      await mkdir(cwd)
      await writeFile(join(cwd, 'source.ts'), 'original\n')
      const env = {
        OPENAI_API_KEY: 'catalog-only-secret',
        DECISION_KEY: 'transport-only-secret',
      }
      const setup = () =>
        setupReviewAgentWithEnvironment(undefined, env, directory, configPath)
      const agent = await setup()
      expect(agent.status.classifier).toEqual({
        provider: config.provider,
        model: config.model,
        endpoint,
      })
      expect(agent.classifierInstructions).toContain('stopReason')
      const faux = fauxProvider({ tokensPerSecond: 100000 })
      ;(agent.models as MutableModels).setProvider(faux.provider)
      const model = faux.getModel()
      const wait = defineTool({
        name: 'wait_here',
        description: 'Wait at the replay boundary',
        parameters: Type.Object({ catalog: Type.String(), usage: Type.Unknown() }),
        replay: 'safe',
        execute: async ({ catalog, usage }, _api, toolContext) => {
          waitCalls++
          // The native structured result retains tokens and priced usage, including
          // when the VM receives its completed result from the replay journal.
          expect(usage).toEqual(expectedUsage)
          expect(requests).toHaveLength(1)
          expect(catalog).toContain(config.model)
          expect(catalog).not.toContain(env.DECISION_KEY)
          expect(catalog).not.toContain(env.OPENAI_API_KEY)
          if (waitCalls === 1) {
            await new Promise<void>((_resolve, reject) => {
              const signal = toolContext.abortSignal
              const timer = setTimeout(() => {
                cleanup()
                reject(new Error('Wait was not aborted'))
              }, 10000)
              const cleanup = () => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', abort)
              }
              const abort = () => {
                aborted = true
                cleanup()
                reject(new Error('Store closed'))
              }
              signal?.addEventListener('abort', abort, { once: true })
              if (signal?.aborted) abort()
            })
          }
          return { output: [{ type: 'text' as const, text: 'resumed' }] }
        },
      })
      const opts = {
        directory: join(directory, 'store'),
        cwd,
        models: agent.models,
        model: { provider: model.provider, modelId: model.id },
        tools: [wait],
        classifierInstructions: agent.classifierInstructions,
        toolPolicyKey: agent.toolPolicyKey,
        onChange() {},
        maxRunMs: 30000,
      }
      const code = `const catalog = await models.getAvailableOfType('classifier');
      if (catalog.length !== 1) throw new Error('Unexpected classifier catalog');
      const input = {
        state: { text: 'review fixture' }, questions: {
          flag: { type: 'bool', instructions: 'Flag?', criteria: { true: 'Yes', false: 'No' } },
          level: { type: 'score', instructions: 'Level', criteria: ['low', 'medium', 'high'] },
          pick: { type: 'choice', instructions: 'Pick', criteria: { yes: 'Yes', no: 'No' } }
        }
      };
      const result = await ${viaTool ? 'tools.classify_review({model: catalog[0], context: input})' : 'models.classify(catalog[0], input)'};
      if (result.stopReason !== 'stop') throw new Error('Classification failed');
      await tools.wait_here({ catalog: JSON.stringify(catalog), usage: result.usage });
      if (result.answers.flag.type !== 'bool' || result.answers.flag.probability !== 0.7 ||
          result.answers.level.type !== 'score' || result.answers.level.score !== 1.2 || result.answers.level.confidence !== 0.6 ||
          result.answers.pick.type !== 'choice' || result.answers.pick.choice !== 'yes' ||
          result.answers.pick.probabilities.yes !== 0.8 || result.answers.pick.probabilities.no !== 0.2 || result.answers.pick.confidence !== 0.8)
        throw new Error('Incorrect normalized answers');
      text(JSON.stringify(result.answers));`
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('codemode', { code }), { stopReason: 'toolUse' }),
        (ctx) => {
          const result = ctx.messages.findLast((message) => message.role === 'toolResult')
          expect(result).toMatchObject({ isError: false })
          const output = JSON.stringify(result)
          expect(output).toContain('Script completed')
          // The script checks exact values; only normalized answers reach the chat model.
          expect(output).toContain('probability')
          expect(output).toContain('0.7')
          expect(output).toContain('1.2')
          expect(output).toContain('0.8')
          expect(output).toContain('0.2')
          expect(output).not.toContain('noul')
          expect(JSON.stringify(ctx.messages)).not.toContain(env.DECISION_KEY)
          expect(JSON.stringify(ctx.messages)).not.toContain(env.OPENAI_API_KEY)
          finalChecked = true
          return fauxAssistantMessage('done')
        },
      ])
      store = await openReviewStore(opts)
      await store.ask({
        id: 'one',
        anchor: { path: 'source.ts', side: 'RIGHT', line: 1, revision: 'a' },
        text: 'Classify this fixture',
        context: '',
      })
      await expect.poll(() => waitCalls, { timeout: 10000 }).toBe(1)
      // The VM awaited classification before entering this unfinished nested call.
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        url: '/custom/prefix/decision',
        authorization: `Bearer ${env.DECISION_KEY}`,
        body: { questions: { flag: { type: 'noul' } } },
      })
      expect((await store.snapshot()).threads[0]?.status).toBe('running')
      await store.close()
      expect(aborted).toBe(true)
      // Count the nested native tool once, not again under the codemode parent.
      expect(await toolUsage(opts.directory)).toEqual(expectedToolUsage)
      if (changePolicy)
        await writeFile(
          configPath,
          JSON.stringify({ ...config, endpoint: `${endpoint}/changed` }),
        )
      const reopenedAgent = await setup()
      ;(reopenedAgent.models as MutableModels).setProvider(faux.provider)
      expect(reopenedAgent.toolPolicyKey === agent.toolPolicyKey).toBe(!changePolicy)
      store = await openReviewStore({
        ...opts,
        models: reopenedAgent.models,
        classifierInstructions: reopenedAgent.classifierInstructions,
        toolPolicyKey: reopenedAgent.toolPolicyKey,
      })
      await expect
        .poll(async () => (await store!.snapshot()).threads[0]?.status, { timeout: 10000 })
        .toBe(changePolicy ? 'failed' : 'answered')
      const snapshot = await store.snapshot()
      if (changePolicy) {
        expect(snapshot.threads[0]?.turns[0]?.error).toContain('policy changed')
        expect(waitCalls).toBe(1)
        expect(faux.state.callCount).toBe(1)
        expect(finalChecked).toBe(false)
      } else {
        expect(snapshot.threads[0]?.turns[0]?.answer).toBe('done')
        expect(waitCalls).toBe(2)
        expect(faux.state.callCount).toBe(2)
        expect(finalChecked).toBe(true)
      }
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(snapshot)).not.toContain(env.DECISION_KEY)
      expect(JSON.stringify(snapshot)).not.toContain(env.OPENAI_API_KEY)
      expect(await readFile(join(cwd, 'source.ts'), 'utf8')).toBe('original\n')
      expect(await readdir(cwd)).toEqual(['source.ts'])
      await store.close()
      // Replaying a completed nested result (or refusing a changed policy) must
      // preserve the exact same ledger, rather than charge the classifier twice.
      expect(await toolUsage(opts.directory)).toEqual(expectedToolUsage)
    } finally {
      await store?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  },
  30000,
)
