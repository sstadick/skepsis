/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import './reviewToolbar.css'

type ToolbarState = {
  active: string | null
  target: HTMLDivElement | null
  setOpen: (id: string, open: boolean, trigger?: HTMLElement) => void
}
const ToolbarContext = createContext<ToolbarState | null>(null)

/** Panels stay mounted to preserve drafts, selections, and publication previews. */
export function ReviewToolbar({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<string | null>(null)
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const current = useRef(active)
  const returnFocus = useRef<HTMLElement | null>(null)
  current.current = active
  const close = useCallback((restoreFocus = true) => {
    setActive(null)
    if (restoreFocus) returnFocus.current?.focus()
  }, [])
  const setOpen = useCallback(
    (id: string, open: boolean, trigger?: HTMLElement) => {
      if (open) {
        if (trigger) returnFocus.current = trigger
        setActive(id)
      } else if (current.current === id) close()
    },
    [close],
  )
  useEffect(() => {
    if (!active) return
    const pointer = (event: PointerEvent) => {
      if (!event.composedPath().includes(root.current!)) close(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', pointer)
    root.current?.addEventListener('keydown', key)
    const element = root.current
    return () => {
      document.removeEventListener('pointerdown', pointer)
      element?.removeEventListener('keydown', key)
    }
  }, [active, close])
  const value = useMemo(() => ({ active, target, setOpen }), [active, target, setOpen])
  return (
    <ToolbarContext.Provider value={value}>
      <div className="review-tools" ref={root}>
        <div className="review-tools-actions" role="group" aria-label="Review tools">
          {children}
        </div>
        <div className="review-tools-popover" hidden={!active}>
          <button
            className="review-tools-close"
            type="button"
            aria-label="Close review tools"
            onClick={() => close()}
          >
            Close
          </button>
          <div ref={setTarget} />
        </div>
      </div>
    </ToolbarContext.Provider>
  )
}

export function useReviewTool(id: string) {
  const toolbar = useContext(ToolbarContext)
  const [local, setLocal] = useState(false)
  return {
    compact: !!toolbar,
    open: toolbar ? toolbar.active === id : local,
    setOpen: (open: boolean) => (toolbar ? toolbar.setOpen(id, open) : setLocal(open)),
  }
}

export function ReviewTool({
  id,
  heading,
  compactHeading = heading,
  actions,
  children,
  className,
  summaryClassName,
  toolbar,
}: {
  id: string
  heading: ReactNode
  compactHeading?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className: string
  summaryClassName?: string
  /** Existing standalone section controls; omitted for native details panels. */
  toolbar?: ReactNode
}) {
  const context = useContext(ToolbarContext)
  const panelId = useId()
  if (!context)
    return toolbar ? (
      <section className={className}>
        {toolbar}
        {children}
      </section>
    ) : (
      <details className={className}>
        <summary className={summaryClassName}>{heading}</summary>
        {children}
      </details>
    )
  const open = context.active === id
  return (
    <>
      <div className="review-tool" data-tool={id}>
        <button
          className="review-tool-trigger"
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={(event) => context.setOpen(id, !open, event.currentTarget)}
        >
          {compactHeading}
          <span className="review-tool-chevron" aria-hidden="true">
            ▾
          </span>
        </button>
        {actions}
      </div>
      {context.target &&
        createPortal(
          <section
            id={panelId}
            hidden={!open}
            className={`review-tool-content ${className}`}
            aria-label={`${id} options`}
          >
            {children}
          </section>,
          context.target,
        )}
    </>
  )
}
