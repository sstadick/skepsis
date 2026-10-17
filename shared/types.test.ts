/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import { commentRequestSchema } from './types.ts'

describe('commentRequestSchema', () => {
  it('defaults kind to comment', () => {
    expect(
      commentRequestSchema.parse({
        file: 'src/App.tsx',
        afterLine: 12,
        text: 'note',
      }),
    ).toEqual({
      file: 'src/App.tsx',
      afterLine: 12,
      text: 'note',
      kind: 'comment',
    })
  })

  it('accepts explicit question requests', () => {
    expect(
      commentRequestSchema.parse({
        file: 'src/App.tsx',
        afterLine: 12,
        text: 'why?',
        kind: 'question',
      }),
    ).toEqual({
      file: 'src/App.tsx',
      afterLine: 12,
      text: 'why?',
      kind: 'question',
    })
  })
})
