/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import {
  BARE_REVIEW_CLOSE_PATTERN,
  BARE_REVIEW_OPEN_PATTERN,
  BARE_COMMENT,
  BLOCK_COMMENT,
  managedReviewOpenTag,
  parseReviewOpenTag,
  REVIEW_CLOSE_PATTERN,
  REVIEW_OPEN_PATTERN,
  SLASH_COMMENT,
  XML_COMMENT,
  parseReviewThread,
  reviewTagRegex,
} from './reviewComments.ts'

const THREAD_ID = '11111111-1111-4111-8111-111111111111'

function parseManaged(lines: string[]) {
  return parseReviewThread(lines, BARE_COMMENT, '', THREAD_ID)
}

describe('REVIEW_OPEN_PATTERN', () => {
  it.each([
    '# <review>',
    '// <review>',
    '-- <review>',
    '/* <review> */',
    '<!-- <review> -->',
    '% <review>',
    '; <review>',
    '" <review>',
  ])('matches %j', (line) => {
    expect(REVIEW_OPEN_PATTERN.test(line)).toBe(true)
  })

  it('tolerates omitted block suffixes', () => {
    expect(REVIEW_OPEN_PATTERN.test('/* <review>')).toBe(true)
    expect(REVIEW_OPEN_PATTERN.test('<!-- <review>')).toBe(true)
  })

  it('does not match a bare tag line', () => {
    expect(REVIEW_OPEN_PATTERN.test('<review>')).toBe(false)
  })

  it('matches and parses managed opening tags', () => {
    const tag = managedReviewOpenTag(THREAD_ID)
    expect(REVIEW_OPEN_PATTERN.test(`// ${tag}`)).toBe(true)
    expect(parseReviewOpenTag(`// ${tag}`, SLASH_COMMENT)).toEqual({
      managed: true,
      threadId: THREAD_ID,
    })
    expect(parseReviewOpenTag('// <review>', SLASH_COMMENT)).toEqual({
      managed: false,
    })
  })
})

describe('REVIEW_CLOSE_PATTERN', () => {
  it.each([
    '# </review>',
    '// </review>',
    '-- </review>',
    '/* </review> */',
    '<!-- </review> -->',
    '% </review>',
    '; </review>',
    '" </review>',
  ])('matches %j', (line) => {
    expect(REVIEW_CLOSE_PATTERN.test(line)).toBe(true)
  })

  it('does not match a bare tag line', () => {
    expect(REVIEW_CLOSE_PATTERN.test('</review>')).toBe(false)
  })
})

describe('bare review patterns', () => {
  it.each(['<review>', '  <review>'])('open matches %j', (line) => {
    expect(BARE_REVIEW_OPEN_PATTERN.test(line)).toBe(true)
  })

  it('close matches a bare close tag', () => {
    expect(BARE_REVIEW_CLOSE_PATTERN.test('</review>')).toBe(true)
  })

  it('does not match commented tags', () => {
    expect(BARE_REVIEW_OPEN_PATTERN.test('# <review>')).toBe(false)
    expect(BARE_REVIEW_OPEN_PATTERN.test('<!-- <review> -->')).toBe(false)
  })

  it('matches a bare managed opening tag', () => {
    const tag = managedReviewOpenTag(THREAD_ID)
    expect(BARE_REVIEW_OPEN_PATTERN.test(tag)).toBe(true)
    expect(parseReviewOpenTag(tag, BARE_COMMENT)).toEqual({
      managed: true,
      threadId: THREAD_ID,
    })
  })
})

describe('reviewTagRegex', () => {
  it('matches the emitted block-comment forms', () => {
    expect(reviewTagRegex(BLOCK_COMMENT, '<review>').test('/* <review> */')).toBe(true)
    expect(reviewTagRegex(XML_COMMENT, '</review>').test('<!-- </review> -->')).toBe(true)
  })
})

describe('parseReviewThread', () => {
  it('parses a plain review comment', () => {
    expect(
      parseReviewThread(['  A regular comment', '  with two lines'], BARE_COMMENT, '  '),
    ).toEqual({
      kind: 'comment',
      body: 'A regular comment\nwith two lines',
    })
  })

  it('does not decode inline code in an unmarked ordinary comment', () => {
    expect(
      parseReviewThread(['Old note about `Answer:` and `Skepsis-State:`.'], BARE_COMMENT),
    ).toEqual({
      kind: 'comment',
      body: 'Old note about `Answer:` and `Skepsis-State:`.',
    })
  })

  it('treats old envelope-shaped prose as literal legacy content', () => {
    const body =
      'Skepsis-Storage: 1; id=11111111-1111-4111-8111-111111111111; ' +
      'Old note about `Answer:`'
    expect(parseReviewThread([body], BARE_COMMENT)).toEqual({
      kind: 'comment',
      body,
    })
  })

  it('parses a pending agent question and removes source comment decoration', () => {
    expect(
      parseReviewThread(
        ['  // @claude: Why is this safe?\n', '  // Please cite the guard.\n'],
        SLASH_COMMENT,
        '  ',
      ),
    ).toEqual({
      kind: 'question',
      backend: 'claude',
      question: 'Why is this safe?\nPlease cite the guard.',
      messages: [{ role: 'user', content: 'Why is this safe?\nPlease cite the guard.' }],
      status: 'pending',
    })
  })

  it('keeps non-framing Skepsis prose in a managed pending question', () => {
    expect(
      parseManaged([
        '@pi Explain this.',
        '',
        'Skepsis-State machines and Skepsis-Thread semantics matter.',
      ]),
    ).toEqual({
      kind: 'question',
      backend: 'pi',
      threadId: THREAD_ID,
      question:
        'Explain this.\n\nSkepsis-State machines and Skepsis-Thread semantics matter.',
      messages: [
        {
          role: 'user',
          content:
            'Explain this.\n\nSkepsis-State machines and Skepsis-Thread semantics matter.',
        },
      ],
      status: 'pending',
    })
  })

  it('parses a terminal Skepsis answer as a separate reply', () => {
    expect(
      parseReviewThread(
        [
          '/* @pi - Why this branch? */\n',
          '/* */\n',
          '/* Skepsis-Answer: */\n',
          '/* It handles the empty case. */\n',
          '/* The fallback is tested. */\n',
          '/* */\n',
          '/* Skepsis-State: answered */\n',
        ],
        BLOCK_COMMENT,
      ),
    ).toEqual({
      kind: 'question',
      backend: 'pi',
      question: 'Why this branch?',
      messages: [
        { role: 'user', content: 'Why this branch?' },
        {
          role: 'assistant',
          content: 'It handles the empty case.\nThe fallback is tested.',
          outcome: 'answered',
        },
      ],
      status: 'answered',
    })
  })

  it('parses a terminal Skepsis failure as a separate reply', () => {
    expect(
      parseReviewThread(
        [
          '// @codex Why did this fail?',
          '//',
          '// Skepsis-Failure:',
          '// The agent process exited.',
          '//',
          '// Skepsis-State: failed',
        ],
        SLASH_COMMENT,
      ),
    ).toEqual({
      kind: 'question',
      backend: 'codex',
      question: 'Why did this fail?',
      messages: [
        { role: 'user', content: 'Why did this fail?' },
        {
          role: 'assistant',
          content: 'The agent process exited.',
          outcome: 'failed',
        },
      ],
      status: 'failed',
    })
  })

  it('decodes an escaped user-authored Answer section in a pending question', () => {
    expect(
      parseManaged(['@claude Explain this.', '', '`Answer:`', 'The caller should decide.']),
    ).toEqual({
      kind: 'question',
      backend: 'claude',
      threadId: THREAD_ID,
      question: 'Explain this.\n\nAnswer:\nThe caller should decide.',
      messages: [
        {
          role: 'user',
          content: 'Explain this.\n\nAnswer:\nThe caller should decide.',
        },
      ],
      status: 'pending',
    })
  })

  it('preserves ambiguous inline-code escapes in an unmarked legacy question', () => {
    expect(
      parseReviewThread(
        ['@claude Explain this.', '', '`Answer:`', 'The caller should decide.'],
        BARE_COMMENT,
      ),
    ).toEqual({
      kind: 'question',
      backend: 'claude',
      question: 'Explain this.\n\n`Answer:`\nThe caller should decide.',
      messages: [
        {
          role: 'user',
          content: 'Explain this.\n\n`Answer:`\nThe caller should decide.',
        },
      ],
      status: 'pending',
    })
  })

  it('parses the pre-sentinel Answer format for existing source threads', () => {
    expect(
      parseReviewThread(
        ['@claude Explain this.', '', 'Answer:', 'The caller validates it.'],
        BARE_COMMENT,
      ),
    ).toEqual({
      kind: 'question',
      backend: 'claude',
      question: 'Explain this.',
      messages: [
        { role: 'user', content: 'Explain this.' },
        {
          role: 'assistant',
          content: 'The caller validates it.',
          outcome: 'answered',
        },
      ],
      status: 'answered',
    })
  })

  it('decodes escaped reserved state markers in a pending question', () => {
    expect(
      parseManaged([
        '@pi Explain this.',
        '',
        '`Skepsis-Answer:`',
        'Not real.',
        '',
        '`Skepsis-State:` answered',
      ]),
    ).toEqual({
      kind: 'question',
      backend: 'pi',
      threadId: THREAD_ID,
      question: 'Explain this.\n\nSkepsis-Answer:\nNot real.\n\nSkepsis-State: answered',
      messages: [
        {
          role: 'user',
          content: 'Explain this.\n\nSkepsis-Answer:\nNot real.\n\nSkepsis-State: answered',
        },
      ],
      status: 'pending',
    })
  })

  it('requires a matching terminal state and uses the last result section', () => {
    expect(
      parseReviewThread(
        [
          '@pi Why?',
          '',
          'Skepsis-Answer:',
          'This text is part of the question.',
          '',
          'Skepsis-Answer:',
          'The real reply.',
          '',
          'Skepsis-State: answered',
        ],
        BARE_COMMENT,
      ),
    ).toEqual({
      kind: 'question',
      backend: 'pi',
      question: 'Why?\n\nSkepsis-Answer:\nThis text is part of the question.',
      messages: [
        {
          role: 'user',
          content: 'Why?\n\nSkepsis-Answer:\nThis text is part of the question.',
        },
        { role: 'assistant', content: 'The real reply.', outcome: 'answered' },
      ],
      status: 'answered',
    })

    expect(
      parseReviewThread(
        ['@pi Why?', '', 'Skepsis-Answer:', 'Not terminal without state.'],
        BARE_COMMENT,
      ),
    ).toEqual({
      kind: 'question',
      backend: 'pi',
      question: 'Why?\n\nSkepsis-Answer:\nNot terminal without state.',
      messages: [
        {
          role: 'user',
          content: 'Why?\n\nSkepsis-Answer:\nNot terminal without state.',
        },
      ],
      status: 'pending',
    })
  })

  it('rejects duplicate raw result frames in a managed base exchange', () => {
    const body = [
      '@pi Why?',
      '',
      'Skepsis-Answer:',
      'This raw frame cannot be question prose.',
      '',
      'Skepsis-Answer:',
      'The apparent reply.',
      '',
      'Skepsis-State: answered',
    ]
    expect(parseManaged(body)).toEqual({
      kind: 'comment',
      body: body.join('\n'),
      threadId: THREAD_ID,
    })
  })

  it('keeps Answer text in an ordinary review comment', () => {
    expect(
      parseReviewThread(['Answer:', 'This is still one ordinary comment.'], BARE_COMMENT),
    ).toEqual({
      kind: 'comment',
      body: 'Answer:\nThis is still one ordinary comment.',
    })
  })

  it('parses an ordered chain of follow-ups, answers, and failures', () => {
    expect(
      parseReviewThread(
        [
          '@codex Why this branch?',
          '',
          'Skepsis-Answer:',
          'It handles empty input.',
          '',
          'Skepsis-State: answered',
          '',
          'Skepsis-Thread: 1',
          '',
          'Skepsis-Followup:',
          'What about whitespace?',
          '',
          'Skepsis-Answer:',
          'Whitespace is trimmed first.',
          '',
          'Skepsis-State: answered',
          '',
          'Skepsis-Followup:',
          'Can you cite the test?',
          '',
          'Skepsis-Failure:',
          'The test file is unavailable.',
          '',
          'Skepsis-State: failed',
        ],
        BARE_COMMENT,
      ),
    ).toEqual({
      kind: 'question',
      backend: 'codex',
      question: 'Why this branch?',
      messages: [
        { role: 'user', content: 'Why this branch?' },
        {
          role: 'assistant',
          content: 'It handles empty input.',
          outcome: 'answered',
        },
        { role: 'user', content: 'What about whitespace?' },
        {
          role: 'assistant',
          content: 'Whitespace is trimmed first.',
          outcome: 'answered',
        },
        { role: 'user', content: 'Can you cite the test?' },
        {
          role: 'assistant',
          content: 'The test file is unavailable.',
          outcome: 'failed',
        },
      ],
      status: 'failed',
    })
  })

  it('infers a final follow-up without a result as pending', () => {
    expect(
      parseReviewThread(
        [
          '@pi Why?',
          '',
          'Skepsis-Failure:',
          'No worker.',
          '',
          'Skepsis-State: failed',
          '',
          'Skepsis-Thread: 1',
          '',
          'Skepsis-Followup:',
          'Could Codex explain it instead?',
        ],
        BARE_COMMENT,
      ),
    ).toEqual({
      kind: 'question',
      backend: 'pi',
      question: 'Why?',
      messages: [
        { role: 'user', content: 'Why?' },
        { role: 'assistant', content: 'No worker.', outcome: 'failed' },
        { role: 'user', content: 'Could Codex explain it instead?' },
      ],
      status: 'pending',
    })
  })

  it('fails closed when a versioned extension is malformed', () => {
    const body = [
      '@pi Why?',
      '',
      'Skepsis-Answer:',
      'Because.',
      '',
      'Skepsis-State: answered',
      '',
      'Skepsis-Thread: 1',
      '',
      'Skepsis-Followup:',
      '',
    ]
    expect(parseReviewThread(body, BARE_COMMENT)).toEqual({
      kind: 'comment',
      body: body.join('\n').trim(),
    })
  })

  it('rejects raw reserved framing in a managed pending follow-up', () => {
    const body = [
      '@pi Why?',
      '',
      'Skepsis-Answer:',
      'Because.',
      '',
      'Skepsis-State: answered',
      '',
      'Skepsis-Thread: 1',
      '',
      'Skepsis-Followup:',
      'What about this?',
      '',
      'Skepsis-State: is raw payload text here.',
    ]
    expect(parseManaged(body)).toEqual({
      kind: 'comment',
      body: body.join('\n'),
      threadId: THREAD_ID,
    })
  })

  it.each([
    ['@pi Why?\n\nSkepsis-Answer:\nBecause.', 'an answer missing its state sentinel'],
    [
      '@pi Why?\n\nSkepsis-Answer:\nBecause.\n\nSkepsis-State answered',
      'a mistyped state sentinel',
    ],
    [
      '@pi Why?\n\nSkepsis-Answer:\nBecause.\n\nSkepsis-State: answered\n\n' +
        'Skepsis-Thread: 1; id=not-a-uuid\n\nSkepsis-Followup:\nMore?',
      'an invalid extension id',
    ],
    [
      '@pi Why?\n\nSkepsis-Answer:\nBecause.\n\nSkepsis-State: answered\n\n' +
        'Skepsis-Thread: 2\n\nSkepsis-Followup:\nMore?',
      'an unknown extension version',
    ],
  ])('fails managed %s closed as an ordinary comment', (body) => {
    expect(parseManaged(body.split('\n'))).toEqual({
      kind: 'comment',
      body,
      threadId: THREAD_ID,
    })
  })
})
