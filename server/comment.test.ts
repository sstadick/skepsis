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
import { managedReviewOpenTag } from '../shared/reviewComments.ts'
import {
  appendComment,
  insertComment,
  readComment,
  removeComment,
  replaceComment,
} from './comment.ts'

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
    const inserted = await insertComment(dir, 'g.txt', 2, '@pi why?')
    expect(inserted).toEqual({
      openLine: 3,
      insertedLineCount: 3,
      threadId: expect.any(String),
    })
    const replaced = await replaceComment(
      dir,
      'g.txt',
      inserted.openLine,
      '@pi why?\n\nSkepsis-Answer:\nbecause\n\nSkepsis-State: answered',
    )
    expect(replaced).toEqual({
      removedLineCount: 3,
      insertedLineCount: 8,
      lineDelta: 5,
    })
    expect(await readFile(join(dir, 'g.txt'), 'utf-8')).toBe(
      `one\ntwo\n${managedReviewOpenTag(inserted.threadId)}\n` +
        '@pi why?\n\nSkepsis-Answer:\nbecause\n\n' +
        'Skepsis-State: answered\n</review>\nthree\n',
    )
  })

  it('preserves language comment syntax when replacing', async () => {
    await writeFile(join(dir, 'c.ts'), 'const one = 1\nconst two = 2\n')
    const { openLine, threadId } = await insertComment(dir, 'c.ts', 1, '@pi why?')
    await replaceComment(
      dir,
      'c.ts',
      openLine,
      '@pi why?\n\nSkepsis-Answer:\nbecause\n\nSkepsis-State: answered',
    )
    expect(await readFile(join(dir, 'c.ts'), 'utf-8')).toBe(
      `const one = 1\n// ${managedReviewOpenTag(threadId)}\n// @pi why?\n` +
        '//\n// Skepsis-Answer:\n' +
        '// because\n//\n// Skepsis-State: answered\n// </review>\nconst two = 2\n',
    )
  })

  it('reads an undecorated body and appends only new source-comment lines', async () => {
    await writeFile(join(dir, 'thread.ts'), 'const one = 1\nconst two = 2\n')
    const { openLine, threadId } = await insertComment(dir, 'thread.ts', 1, '@codex why?')
    await expect(readComment(dir, 'thread.ts', openLine)).resolves.toEqual({
      text: '@codex why?',
      closeLine: 4,
      threadId,
    })
    await expect(
      appendComment(
        dir,
        'thread.ts',
        openLine,
        '\n\nSkepsis-Answer:\nbecause\n\nSkepsis-State: answered',
      ),
    ).resolves.toEqual({
      insertedLineCount: 5,
      previousCloseLine: 4,
    })
    expect(await readFile(join(dir, 'thread.ts'), 'utf-8')).toBe(
      `const one = 1\n// ${managedReviewOpenTag(threadId)}\n// @codex why?\n` +
        '//\n// Skepsis-Answer:\n' +
        '// because\n//\n// Skepsis-State: answered\n// </review>\nconst two = 2\n',
    )
    await expect(readComment(dir, 'thread.ts', openLine)).resolves.toEqual({
      text: '@codex why?\n\nSkepsis-Answer:\nbecause\n\nSkepsis-State: answered',
      closeLine: 9,
      threadId,
    })
  })

  it('reports the number of lines removed with a review block', async () => {
    await writeFile(join(dir, 'remove.txt'), 'one\ntwo\nthree\n')
    const { openLine } = await insertComment(dir, 'remove.txt', 1, 'two\nlines')
    await expect(removeComment(dir, 'remove.txt', openLine)).resolves.toEqual({
      removedLineCount: 4,
    })
    expect(await readFile(join(dir, 'remove.txt'), 'utf-8')).toBe('one\ntwo\nthree\n')
  })
})
