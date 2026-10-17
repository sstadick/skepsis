/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { ReviewComposerDraft } from './reviewUi.tsx'

export interface ComposerState {
  file: string
  line: number
  draft: ReviewComposerDraft
  focused: boolean
}

export interface FollowUpDraftState {
  text: string
  focused: boolean
}

export function emptyReviewComposerDraft(): ReviewComposerDraft {
  return { kind: 'comment', text: '' }
}

export function beginComposing(
  previous: ComposerState | null,
  file: string,
  line: number,
): ComposerState {
  return previous?.file === file && previous.line === line
    ? { ...previous, focused: true }
    : { file, line, draft: emptyReviewComposerDraft(), focused: true }
}

export function updateComposerDraft(
  previous: ComposerState | null,
  file: string,
  line: number,
  draft: ReviewComposerDraft,
): ComposerState | null {
  return previous?.file === file && previous.line === line
    ? { ...previous, draft }
    : previous
}

export function updateComposerFocus(
  previous: ComposerState | null,
  file: string,
  line: number,
  focused: boolean,
): ComposerState | null {
  return previous?.file === file && previous.line === line
    ? { ...previous, focused }
    : previous
}

export function updateFollowUpDrafts(
  previous: Record<string, FollowUpDraftState>,
  draftKey: string,
  text: string,
): Record<string, FollowUpDraftState> {
  return {
    ...previous,
    [draftKey]: {
      text,
      focused: previous[draftKey]?.focused ?? false,
    },
  }
}

export function updateFollowUpFocus(
  previous: Record<string, FollowUpDraftState>,
  draftKey: string,
  focused: boolean,
): Record<string, FollowUpDraftState> {
  return {
    ...previous,
    [draftKey]: {
      text: previous[draftKey]?.text ?? '',
      focused,
    },
  }
}
