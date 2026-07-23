/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertComment, replaceComment } from './comment.ts'

describe('replaceComment', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skepsis-comment-test-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('replaces the body of a bare review comment block', async () => {
    await writeFile(join(dir, 'g.txt'), 'one\ntwo\nthree\n')
    const { openLine } = await insertComment(dir, 'g.txt', 2, '@pi why?')
    await replaceComment(dir, 'g.txt', openLine, '@pi why?\n\nAnswer:\nbecause')
    expect(await readFile(join(dir, 'g.txt'), 'utf-8')).toBe(
      'one\ntwo\n<review>\n@pi why?\n\nAnswer:\nbecause\n</review>\nthree\n',
    )
  })

  it('preserves language comment syntax when replacing', async () => {
    await writeFile(join(dir, 'c.ts'), 'const one = 1\nconst two = 2\n')
    const { openLine } = await insertComment(dir, 'c.ts', 1, '@pi why?')
    await replaceComment(dir, 'c.ts', openLine, '@pi why?\n\nAnswer:\nbecause')
    expect(await readFile(join(dir, 'c.ts'), 'utf-8')).toBe(
      'const one = 1\n// <review>\n// @pi why?\n//\n// Answer:\n// because\n// </review>\nconst two = 2\n',
    )
  })
})
