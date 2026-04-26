/**
 * Progressive spotlight onboarding (v2).
 * `step` = next step to show when its screen/context matches (0..N-1). Pauses when context does not match.
 * Steps:
 * 0 home Settings
 * 1 home Start Workout
 * 2 workout Add / Switch exercise
 * 3 log weight/reps
 * 4 log note
 * 5 log Save set
 * 6 rest timer
 * 7 workout history list
 * 8 history detail Save as Program
 * 9 programs list
 */
export const ONBOARDING_STEP_COUNT = 10

const K_DONE = "fitlog-onboard-v2-done"
const K_STEP = "fitlog-onboard-v2-step"

export const FITLOG_ONBOARDING_EVENT = "fitlog-onboarding-change"

function dispatchOnboarding() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(FITLOG_ONBOARDING_EVENT))
}

export function getOnboardingProgress(): { done: boolean; step: number } {
  if (typeof window === "undefined") return { done: false, step: 0 }
  try {
    if (localStorage.getItem(K_DONE) === "1") return { done: true, step: ONBOARDING_STEP_COUNT }
    const raw = localStorage.getItem(K_STEP)
    const n = raw == null ? 0 : parseInt(raw, 10)
    const step = Number.isFinite(n) ? Math.min(Math.max(0, n), ONBOARDING_STEP_COUNT - 1) : 0
    return { done: false, step }
  } catch {
    return { done: false, step: 0 }
  }
}

export function advanceOnboardingProgress() {
  if (typeof window === "undefined") return
  try {
    if (localStorage.getItem(K_DONE) === "1") return
    const raw = localStorage.getItem(K_STEP)
    let n = raw == null ? 0 : parseInt(raw, 10)
    if (!Number.isFinite(n) || n < 0) n = 0
    n += 1
    if (n >= ONBOARDING_STEP_COUNT) {
      localStorage.setItem(K_DONE, "1")
      localStorage.removeItem(K_STEP)
    } else {
      localStorage.setItem(K_STEP, String(n))
    }
  } catch {
    // ignore
  }
  dispatchOnboarding()
}

export function skipOnboardingProgress() {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(K_DONE, "1")
    localStorage.removeItem(K_STEP)
  } catch {
    // ignore
  }
  dispatchOnboarding()
}

export function onboardingSnapshot(): string {
  const { done, step } = getOnboardingProgress()
  return done ? "1|0" : `0|${step}`
}

export function subscribeOnboarding(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(FITLOG_ONBOARDING_EVENT, onStoreChange)
  return () => window.removeEventListener(FITLOG_ONBOARDING_EVENT, onStoreChange)
}

export function parseOnboardingSnapshot(s: string): { done: boolean; step: number } {
  const [a, b] = s.split("|")
  if (a === "1") return { done: true, step: 0 }
  const step = parseInt(b || "0", 10)
  return { done: false, step: Number.isFinite(step) ? step : 0 }
}
