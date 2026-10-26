import { useCallback, useEffect, useRef, useState } from 'react'
import { matchesHotkey } from '@gadgets/ui/hotkey'

/**
 * Fullscreen gadget mode — renders the gadget iframe as an overlay covering the whole page.
 * Tied to the URL hash (#fullscreen) so the state is bookmarkable and survives reloads.
 * Owns the enter/exit focus choreography, the brief exit hint banner, and Escape handling
 * (the iframe forwards Escape via postMessage; see GadgetUI's `onIframeEscape`).
 */
export function useGadgetFullscreen() {
  const [isGadgetFullscreen, setIsGadgetFullscreen] = useState(
    () => typeof window !== 'undefined' && window.location.hash === '#fullscreen'
  )

  useEffect(() => {
    const onHashChange = () => {
      setIsGadgetFullscreen(window.location.hash === '#fullscreen')
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Brief hint banner shown when entering fullscreen, instructing the user how to exit.
  // We don't use the global Kumo toast manager here because the fullscreen overlay sits above
  // it in stacking order (and toasts render bottom-right, not top-center).
  const [showFullscreenHint, setShowFullscreenHint] = useState(false)
  // Element that had focus before entering fullscreen; we restore focus to it on exit so
  // keyboard users aren't stranded.
  const focusBeforeFullscreenRef = useRef<HTMLElement | null>(null)
  // Fullscreen overlay wrapper — we focus this on enter to move focus out of the now-occluded
  // Enter button. From here, Tab moves into the iframe.
  const fullscreenOverlayRef = useRef<HTMLDivElement>(null)
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)

  const enterGadgetFullscreen = useCallback(() => {
    if (window.location.hash !== '#fullscreen') {
      // pushState so the browser Back button also exits fullscreen — natural for many users
      // and helpful for bookmarks: a bookmarked /workspace/foo#fullscreen can still go Back to a
      // useful (non-fullscreen) state if there's prior history.
      window.history.pushState(null, '', '#fullscreen')
    }
    focusBeforeFullscreenRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setIsGadgetFullscreen(true)
    setShowFullscreenHint(true)
  }, [])

  // Auto-dismiss the hint a few seconds after entering fullscreen.
  useEffect(() => {
    if (!showFullscreenHint) return
    const t = setTimeout(() => setShowFullscreenHint(false), 4000)
    return () => clearTimeout(t)
  }, [showFullscreenHint])

  // Move focus into the overlay when entering fullscreen, and back to the prior element on exit.
  useEffect(() => {
    if (isGadgetFullscreen) {
      fullscreenOverlayRef.current?.focus()
    } else if (focusBeforeFullscreenRef.current) {
      if (focusBeforeFullscreenRef.current.isConnected) {
        focusBeforeFullscreenRef.current.focus()
      } else {
        mobileMenuButtonRef.current?.focus()
      }
      focusBeforeFullscreenRef.current = null
    }
  }, [isGadgetFullscreen])

  const exitGadgetFullscreen = useCallback(() => {
    if (window.location.hash === '#fullscreen') {
      // Replace the hash without growing the history stack.
      const { pathname, search } = window.location
      window.history.replaceState(null, '', `${pathname}${search}`)
    }
    setIsGadgetFullscreen(false)
  }, [])

  // Escape exits fullscreen. When focus is in the workshop chrome this listener catches it
  // directly; when focus is in the gadget iframe, the iframe forwards Escape via postMessage.
  useEffect(() => {
    if (!isGadgetFullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchesHotkey(e, 'escape')) exitGadgetFullscreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isGadgetFullscreen, exitGadgetFullscreen])

  return {
    isGadgetFullscreen,
    showFullscreenHint,
    enterGadgetFullscreen,
    exitGadgetFullscreen,
    fullscreenOverlayRef,
    mobileMenuButtonRef,
  }
}
