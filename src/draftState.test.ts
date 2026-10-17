/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import {
  beginComposing,
  updateComposerDraft,
  updateComposerFocus,
  updateFollowUpDrafts,
  updateFollowUpFocus,
} from './draftState.ts'

describe('draftState', () => {
  it('keeps the same composer draft when the active target remounts', () => {
    const original = {
      file: 'src/App.tsx',
      line: 42,
      draft: { kind: 'question' as const, text: 'Can this be smaller?' },
      focused: false,
    }

    expect(beginComposing(original, 'src/App.tsx', 42)).toEqual({
      ...original,
      focused: true,
    })
  })

  it('resets the composer draft only when switching to a new target', () => {
    const original = {
      file: 'src/App.tsx',
      line: 42,
      draft: { kind: 'question' as const, text: 'Keep this draft' },
      focused: true,
    }

    expect(beginComposing(original, 'src/reviewUi.tsx', 7)).toEqual({
      file: 'src/reviewUi.tsx',
      line: 7,
      draft: { kind: 'comment', text: '' },
      focused: true,
    })
  })

  it('updates only the matching composer target draft and focus flag', () => {
    const original = {
      file: 'src/App.tsx',
      line: 42,
      draft: { kind: 'comment' as const, text: 'Draft' },
      focused: true,
    }

    expect(
      updateComposerDraft(original, 'src/App.tsx', 42, {
        kind: 'question',
        text: 'Updated draft',
      }),
    ).toEqual({
      ...original,
      draft: { kind: 'question', text: 'Updated draft' },
    })
    expect(updateComposerFocus(original, 'src/App.tsx', 42, false)).toEqual({
      ...original,
      focused: false,
    })
    expect(
      updateComposerDraft(original, 'src/reviewUi.tsx', 42, {
        kind: 'question',
        text: 'Ignored',
      }),
    ).toBe(original)
  })

  it('preserves follow-up text and focus across card remount bookkeeping', () => {
    const withText = updateFollowUpDrafts({}, 'thread-1', 'Please expand that answer')
    expect(withText).toEqual({
      'thread-1': { text: 'Please expand that answer', focused: false },
    })

    const focused = updateFollowUpFocus(withText, 'thread-1', true)
    expect(focused).toEqual({
      'thread-1': { text: 'Please expand that answer', focused: true },
    })

    const preservedText = updateFollowUpDrafts(
      focused,
      'thread-1',
      'Still here after remount',
    )
    expect(preservedText).toEqual({
      'thread-1': { text: 'Still here after remount', focused: true },
    })
  })
})
