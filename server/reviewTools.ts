/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { readFile, stat } from 'node:fs/promises'
import { Type } from '@earendil-works/pi-ai'
import { createRegistry, defineTool } from '@earendil-works/pi-durable'
import { resolveSafeReviewFilePath } from './questions.ts'

export function createReviewRegistry(cwd: string) {
  const registry = createRegistry()
  registry.install({
    name: 'skepsis-review',
    tools: [
      defineTool({
        name: 'read_file',
        description:
          'Read a text file inside this repository. Returns numbered lines; no writes or commands.',
        replay: 'safe',
        parameters: Type.Object({
          path: Type.String(),
          startLine: Type.Optional(Type.Integer({ minimum: 1 })),
          maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
        }),
        execute: async ({ path, startLine = 1, maxLines = 200 }) => {
          const safePath = await resolveSafeReviewFilePath(cwd, path)
          if ((await stat(safePath)).size > 1_000_000)
            throw new Error('File exceeds 1 MB read limit')
          const lines = (await readFile(safePath, 'utf8')).split('\n')
          const text = lines
            .slice(startLine - 1, startLine - 1 + maxLines)
            .map((line, i) => `${startLine + i}: ${line}`)
            .join('\n')
            .slice(0, 24_000)
          return { output: [{ type: 'text', text }] }
        },
      }),
    ],
  })
  return registry
}
