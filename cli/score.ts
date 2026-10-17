/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { Command } from '@commander-js/extra-typings'
import { apiFetch, resolveServerAccess } from './access.ts'
import type { ServerAccessOptions } from './access.ts'
import type { OkResponse, ScoreTriggerResponse } from '../shared/types.ts'

async function triggerScoring(opts: ServerAccessOptions): Promise<void> {
  const access = await resolveServerAccess(opts)
  const res = await apiFetch<ScoreTriggerResponse>('/api/score', {
    method: 'POST',
    access,
  })
  process.stdout.write(`queued ${res.queued}, pending ${res.pending}\n`)
}

async function cancelScoring(opts: ServerAccessOptions): Promise<void> {
  const access = await resolveServerAccess(opts)
  await apiFetch<OkResponse>('/api/score', { method: 'DELETE', access })
}

function removedScoreCommandMessage(name: string): string {
  return (
    `skepsis score ${name} was removed. Use skepsis score to queue embedded scoring, ` +
    'or skepsis score cancel to cancel pending scoring. No external worker session is required.'
  )
}

export function registerScoreCommands(program: Command): void {
  const score = program
    .command('score')
    .description('Queue embedded per-hunk review scoring on the running Skepsis server')

  score.showHelpAfterError()
  score.showSuggestionAfterError()

  // Parent options work with the default action and the cancel subcommand.
  score
    .option('--cwd <path>', 'repository cwd used for running-server discovery')
    .option('--server <url>', 'explicit Skepsis server URL')
    .option('--token <token>', 'explicit Skepsis server token')
    .action(triggerScoring)

  score
    .command('cancel')
    .description('Cancel pending scoring and clear scoring failures on the running server')
    .action(async () => {
      await cancelScoring(score.opts())
    })

  for (const removed of ['claim', 'submit', 'fail', 'config', 'trigger']) {
    score
      .command(removed, { hidden: true })
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .argument('[args...]')
      .action(() => {
        throw new Error(removedScoreCommandMessage(removed))
      })
  }

  score.addHelpText(
    'after',
    "\nTriggers the running Skepsis server's embedded scorer. Discover the server from this repository, or pass --server/--token. No external pi worker session is required.",
  )
}
