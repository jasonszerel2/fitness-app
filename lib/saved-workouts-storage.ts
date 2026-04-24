const SAVED_KEY = "fitlog-saved-workouts-v1"

export type SavedWorkoutSet = {
  id: string
  weight: number
  reps: number
  setEndedAt: string
  setDurationSec: number
  restBeforeNextSetSec: number | null
}

export type SavedWorkoutGroup = {
  exerciseName: string
  sets: SavedWorkoutSet[]
}

export type SavedWorkout = {
  id: string
  /** Optional user-defined name (local only). */
  name?: string
  sessionId: string
  sessionStartedAt: string
  sessionEndedAt: string
  totalDurationSec: number
  exercisesPerformed: string[]
  byExercise: SavedWorkoutGroup[]
}

function saveSavedWorkouts(list: SavedWorkout[]) {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list))
  } catch {
    // ignore
  }
}

export function loadSavedWorkouts(): SavedWorkout[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(SAVED_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data.filter(
      (w): w is SavedWorkout =>
        w != null &&
        typeof w === "object" &&
        "id" in w &&
        "sessionStartedAt" in w &&
        "sessionEndedAt" in w &&
        "byExercise" in w,
    )
  } catch {
    return []
  }
}

export function appendSavedWorkout(workout: SavedWorkout) {
  if (typeof window === "undefined") return
  try {
    const list = loadSavedWorkouts()
    list.push(workout)
    saveSavedWorkouts(list)
  } catch {
    // ignore
  }
}

export function updateSavedWorkoutName(id: string, name: string | null) {
  if (typeof window === "undefined") return
  try {
    const list = loadSavedWorkouts()
    const next = list.map((w) => {
      if (w.id !== id) return w
      const trimmed = (name ?? "").trim()
      if (!trimmed) {
        // remove name
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { name: _old, ...rest } = w
        return rest as SavedWorkout
      }
      return { ...w, name: trimmed }
    })
    saveSavedWorkouts(next)
  } catch {
    // ignore
  }
}

export function deleteSavedWorkout(id: string) {
  if (typeof window === "undefined") return
  try {
    const list = loadSavedWorkouts()
    const next = list.filter((w) => w.id !== id)
    saveSavedWorkouts(next)
  } catch {
    // ignore
  }
}

export function newSavedWorkoutId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `w-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}
