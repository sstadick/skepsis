/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ScoreControls } from './scoreControls.tsx'

describe('ScoreControls', () => {
  it('shows queued work without worker language', () => {
    const html = renderToStaticMarkup(
      <ScoreControls
        summary={{ queued: 2, claimed: 0, failed: 0 }}
        triggerPending={false}
        cancelPending={false}
        onTrigger={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(html).toContain('Queued (2)')
    expect(html).not.toContain('Waiting for worker')
  })

  it('shows active scoring with the remaining count once claimed', () => {
    const html = renderToStaticMarkup(
      <ScoreControls
        summary={{ queued: 2, claimed: 1, failed: 0 }}
        triggerPending={false}
        cancelPending={false}
        onTrigger={() => {}}
        onCancel={() => {}}
      />,
    )

    expect(html).toContain('Scoring (3 left)')
  })
})
