/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import { parseHunks } from './hunks.ts'

const TWO_FILE_PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@ function f() {',
  ' const x = 1',
  '-return x',
  '+const y = 2',
  '+return x + y',
  '@@ -10,2 +11,2 @@ function g() {',
  '-  old()',
  '+  new()',
  'diff --git a/README.md b/README.md',
  'index 3333333..4444444 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-old title',
  '+new title',
  '',
].join('\n')

describe('parseHunks', () => {
  it('splits a multi-file patch into per-file hunks', () => {
    const hunks = parseHunks(TWO_FILE_PATCH)
    expect(hunks.map((h) => ({ file: h.file, newStart: h.newStart }))).toEqual([
      { file: 'src/a.ts', newStart: 1 },
      { file: 'src/a.ts', newStart: 11 },
      { file: 'README.md', newStart: 1 },
    ])
  })

  it('keeps the @@ header in the classifiable text', () => {
    const [first] = parseHunks(TWO_FILE_PATCH)
    expect(first!.text.startsWith('@@ -1,3 +1,4 @@')).toBe(true)
    expect(first!.text).toContain('+return x + y')
  })

  it('does not treat file-header +++/--- lines as body', () => {
    const hunks = parseHunks(TWO_FILE_PATCH)
    for (const hunk of hunks) {
      expect(hunk.text).not.toContain('+++ b/')
      expect(hunk.text).not.toContain('--- a/')
    }
  })

  it('hashes by content, so line-number shifts do not change the hash', () => {
    const shifted = TWO_FILE_PATCH.replace('@@ -1,3 +1,4 @@', '@@ -50,3 +60,4 @@')
    const a = parseHunks(TWO_FILE_PATCH)[0]!
    const b = parseHunks(shifted)[0]!
    expect(b.newStart).toBe(60)
    expect(b.hash).toBe(a.hash)
  })

  it('changes the hash when body content changes', () => {
    const edited = TWO_FILE_PATCH.replace('+return x + y', '+return x - y')
    const a = parseHunks(TWO_FILE_PATCH)[0]!
    const b = parseHunks(edited)[0]!
    expect(b.hash).not.toBe(a.hash)
  })

  it('distinguishes identical bodies in different files', () => {
    const patch = [
      'diff --git a/one.txt b/one.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/two.txt b/two.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n')
    const [one, two] = parseHunks(patch)
    expect(one!.hash).not.toBe(two!.hash)
  })

  it('records both ranges, including deletion-only and addition-only hunks', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n@@ -1,3 +0,0 @@\n-one\n-two\n-three\n'
    expect(parseHunks(patch)[0]).toMatchObject({
      oldStart: 1,
      oldCount: 3,
      newStart: 0,
      newCount: 0,
    })
    const added = patch
      .replace('@@ -1,3 +0,0 @@', '@@ -0,0 +1,3 @@')
      .replaceAll('\n-', '\n+')
    expect(parseHunks(added)[0]).toMatchObject({
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: 3,
    })
  })

  it('keeps quoted paths aligned with the diff renderer and does not inherit an invalid file', () => {
    const patch = 'diff --git "a/a\\\\t.ts" "b/a\\\\t.ts"\n@@ -1 +1 @@\n-a\n+b\n'
    expect(parseHunks(patch)[0]?.file).toBe('a\\\\t.ts')
    expect(parseHunks(patch + 'diff --git invalid\n@@ -1 +1 @@\n-a\n+b\n')).toHaveLength(1)
  })

  it('includes function context in identity but not absolute line numbers', () => {
    const changedContext = TWO_FILE_PATCH.replace(
      'function f() {',
      'function dangerous() {',
    )
    expect(parseHunks(changedContext)[0]?.hash).not.toBe(
      parseHunks(TWO_FILE_PATCH)[0]?.hash,
    )
  })

  it('keeps duplicate occurrences independent without keying on absolute lines', () => {
    const patch =
      'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-old\n+new\n'
    const hunks = parseHunks(patch)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.hash).not.toBe(hunks[1]!.hash)
    const shifted = parseHunks(patch.replace('@@ -10 +10 @@', '@@ -20 +20 @@'))
    expect(shifted.map((h) => h.hash)).toEqual(hunks.map((h) => h.hash))
  })

  it('returns nothing for an empty patch', () => {
    expect(parseHunks('')).toEqual([])
  })
})
