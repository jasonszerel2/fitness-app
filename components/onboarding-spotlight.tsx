"use client"

import { useLayoutEffect, useState, useEffect, useMemo, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import {
  advanceOnboardingProgress,
  onboardingSnapshot,
  skipOnboardingProgress,
  subscribeOnboarding,
} from "@/lib/onboarding-progress"

// Emergency kill switch: disable onboarding rendering/logic.
// Keep code in place for later re-enable.
const ONBOARDING_DISABLED = true

export function useOnboardingProgress() {
  if (ONBOARDING_DISABLED) return "1|0"
  return useSyncExternalStore(
    subscribeOnboarding,
    () => (typeof window === "undefined" ? "0|0" : onboardingSnapshot()),
    () => "0|0",
  )
}

type OnboardingSpotlightProps = {
  show: boolean
  targetRef: React.RefObject<HTMLElement | null>
  message: string
  stepKey?: string | number
  showNext?: boolean
  autoHideMs?: number
}

export function OnboardingSpotlight({
  show,
  targetRef,
  message,
  stepKey,
  showNext = false,
  autoHideMs = 4200,
}: OnboardingSpotlightProps) {
  if (ONBOARDING_DISABLED) return null
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const [mounted, setMounted] = useState(false)
  const [render, setRender] = useState(false)
  const [active, setActive] = useState(false)
  const [snoozed, setSnoozed] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    setSnoozed(false)
  }, [mounted, stepKey])

  useEffect(() => {
    if (!mounted) return
    if (show && !snoozed) {
      setRender(true)
      const id = requestAnimationFrame(() => setActive(true))
      return () => cancelAnimationFrame(id)
    }
    setActive(false)
    const t = window.setTimeout(() => setRender(false), 160)
    return () => window.clearTimeout(t)
  }, [show, mounted])

  useLayoutEffect(() => {
    if (!show || snoozed) {
      setRect(null)
      return
    }
    const el = targetRef.current
    const update = () => {
      const e = targetRef.current
      if (!e) {
        setRect(null)
        return
      }
      const r = e.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    update()
    if (!el) return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener("scroll", update, true)
    window.addEventListener("resize", update)
    return () => {
      ro.disconnect()
      window.removeEventListener("scroll", update, true)
      window.removeEventListener("resize", update)
    }
  }, [show, snoozed, targetRef])

  const complete = () => {
    advanceOnboardingProgress()
    setSnoozed(true)
  }

  const onNext = () => complete()
  const onSkip = () => skipOnboardingProgress()

  useEffect(() => {
    if (!mounted || !show || snoozed) return
    const el = targetRef.current
    if (!el) return

    const onPointer = () => complete()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") complete()
    }

    // Capture so we reliably advance even if the UI navigates.
    el.addEventListener("pointerdown", onPointer, { capture: true })
    el.addEventListener("keydown", onKey, { capture: true })
    return () => {
      el.removeEventListener("pointerdown", onPointer, { capture: true } as any)
      el.removeEventListener("keydown", onKey, { capture: true } as any)
    }
  }, [mounted, show, snoozed, targetRef, stepKey])

  useEffect(() => {
    if (!mounted || !show || snoozed) return
    const t = window.setTimeout(() => setSnoozed(true), autoHideMs)
    return () => window.clearTimeout(t)
  }, [mounted, show, snoozed, autoHideMs, stepKey])

  if (!mounted || !render || snoozed) return null

  const pad = 10
  const hasHole = rect && rect.width > 0 && rect.height > 0

  const tooltip = useMemo(() => {
    if (!rect) return { top: 16, left: 16 }
    const gap = 10
    const w = 260
    const vw = typeof window !== "undefined" ? window.innerWidth : 360
    const vh = typeof window !== "undefined" ? window.innerHeight : 720

    const belowTop = rect.top + rect.height + gap
    const aboveTop = rect.top - gap
    const placeBelow = belowTop + 56 < vh
    const top = placeBelow ? belowTop : Math.max(12, aboveTop - 56)

    const centeredLeft = rect.left + rect.width / 2 - w / 2
    const left = Math.min(Math.max(12, centeredLeft), Math.max(12, vw - w - 12))
    return { top, left }
  }, [rect])

  return createPortal(
    <div
      className={[
        "pointer-events-none fixed inset-0 z-[220]",
        "transition-opacity duration-150 ease-out",
        active ? "opacity-100" : "opacity-0",
      ].join(" ")}
    >
      {hasHole ? (
        <div
          className="pointer-events-none fixed rounded-xl ring-2 ring-primary ring-offset-2 ring-offset-background"
          style={{
            top: rect!.top - pad,
            left: rect!.left - pad,
            width: rect!.width + pad * 2,
            height: rect!.height + pad * 2,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.08)",
          }}
        />
      ) : null}
      <div className="pointer-events-auto fixed right-3 top-3 z-[222]">
        <Button type="button" size="sm" variant="outline" className="h-8 px-3" onClick={onSkip}>
          Skip
        </Button>
      </div>

      <div
        className={[
          "pointer-events-auto fixed z-[222] max-w-[260px] rounded-xl border border-border bg-card/75 px-3 py-2 text-xs text-foreground",
          "shadow-md backdrop-blur-sm",
          "transition-opacity duration-150 ease-out",
          active ? "opacity-100" : "opacity-0",
        ].join(" ")}
        style={{ top: tooltip.top, left: tooltip.left }}
      >
        <div className="leading-snug">{message}</div>
        {showNext ? (
          <div className="mt-2 flex justify-end">
            <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={onNext}>
              Next
            </Button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
