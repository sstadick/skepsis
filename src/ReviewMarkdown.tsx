/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { memo, useEffect, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Deliberately narrower than Markdown's defaults: repository-relative URLs and
// protocol-relative URLs must not become requests to the review server or elsewhere.
export function safeReviewUrl(value: string): string | undefined {
  // Reject URL-parser whitespace/control normalization rather than accepting obfuscation.
  // oxlint-disable-next-line no-control-regex
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return undefined
  if (value.startsWith('#')) return value
  if (!/^(https?:\/\/|mailto:)/i.test(value)) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'mailto:') return url.pathname ? value : undefined
    return url.hostname && !url.username && !url.password ? value : undefined
  } catch {
    return undefined
  }
}

const CodePanel: NonNullable<Components['pre']> = ({ node, children }) => {
  const code = node?.children.find(
    (child) => child.type === 'element' && child.tagName === 'code',
  )
  const text =
    code?.type === 'element'
      ? code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
      : ''
  const classes = code?.type === 'element' ? code.properties.className : undefined
  const language =
    (Array.isArray(classes) ? classes : [])
      .map(String)
      .find((name) => name.startsWith('language-'))
      ?.slice('language-'.length) || 'text'
  const [copy, setCopy] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle')
  const copyVersion = useRef(0)
  useEffect(() => {
    setCopy('idle')
    return () => {
      // A result for an older streaming chunk must not describe the current code.
      copyVersion.current += 1
    }
  }, [text])
  return (
    <figure className="review-code-panel">
      <figcaption>
        <span className="review-code-language">{language}</span>
        <button
          type="button"
          disabled={copy === 'pending'}
          onClick={async () => {
            const version = ++copyVersion.current
            setCopy('pending')
            try {
              if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
              await navigator.clipboard.writeText(text)
              if (version === copyVersion.current) setCopy('copied')
            } catch {
              if (version === copyVersion.current) setCopy('failed')
            }
          }}
        >
          Copy code
        </button>
        {copy === 'copied' && <span role="status">Copied</span>}
        {copy === 'failed' && (
          <span role="alert">Could not copy. Select the code to copy it manually.</span>
        )}
      </figcaption>
      <pre>{children}</pre>
    </figure>
  )
}

const components: Components = {
  pre: CodePanel,
  a: ({ href, children, title }) => {
    const safe = href && safeReviewUrl(href)
    return safe ? (
      <a
        href={safe}
        title={title}
        target={/^https?:/i.test(safe) ? '_blank' : undefined}
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    )
  },
  // Never emit an img, even for a safe URL: private conversations must not load
  // tracking pixels, remote embeds, or authenticated local server resources.
  img: ({ alt }) => (
    <span className="review-image-placeholder">[Image: {alt || 'image omitted'}]</span>
  ),
  table: ({ children }) => (
    <div
      className="review-table-scroll"
      role="region"
      aria-label="Markdown table"
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  ),
}

// Typing in an editor or receiving a stream chunk should not reparse every
// unchanged message in a long conversation.
export const ReviewMarkdown = memo(function ReviewMarkdown({ text }: { text: string }) {
  return (
    <div className="review-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        allowedElements={[
          'p',
          'br',
          'hr',
          'em',
          'strong',
          'del',
          'blockquote',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'ul',
          'ol',
          'li',
          'pre',
          'code',
          'a',
          'img',
          'table',
          'thead',
          'tbody',
          'tr',
          'th',
          'td',
          'input',
        ]}
        urlTransform={(url, key) => (key === 'href' ? safeReviewUrl(url) : undefined)}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  )
})
