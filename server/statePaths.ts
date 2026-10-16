/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function stateDirectory(): string {
  return process.env['SKEPSIS_STATE_DIR'] ?? join(homedir(), '.local', 'share', 'skepsis')
}

export function reviewDirectory(identity: string): string {
  return join(
    stateDirectory(),
    'reviews',
    createHash('sha256').update(identity).digest('hex'),
  )
}
