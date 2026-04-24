import type { SavedWorkout } from "@/lib/saved-workouts-storage"

export type LastExerciseSession = {
  sessionEndedAt: string
  /** Set 1 = index 0, in chronological order as saved */
  sets: Array<{ weight: number; reps: number }>
}

/** Most recent saved workout that includes this exercise name (by session end time). */
export function findLastExerciseSession(
  saved: SavedWorkout[],
  exerciseName: string,
): LastExerciseSession | null {
  const sorted = [...saved].sort(
    (a, b) => new Date(b.sessionEndedAt).getTime() - new Date(a.sessionEndedAt).getTime(),
  )
  for (const w of sorted) {
    const group = w.byExercise.find((g) => g.exerciseName === exerciseName)
    if (group?.sets?.length) {
      return {
        sessionEndedAt: w.sessionEndedAt,
        sets: group.sets.map((s) => ({ weight: s.weight, reps: s.reps })),
      }
    }
  }
  return null
}

const EPS = 1e-6

function sameKg(a: number, b: number) {
  return Math.abs(a - b) < EPS
}

function formatKgDelta(delta: number): string {
  const rounded = Math.round(delta * 10) / 10
  const sign = rounded > 0 ? "+" : ""
  return `${sign}${rounded} kg`
}

/** One-line message after logging a set vs the same set index from last time. */
export function compareSetToPrevious(
  current: { weight: number; reps: number },
  previous: { weight: number; reps: number } | undefined,
): string {
  if (!previous) return "New set"
  const wEq = sameKg(current.weight, previous.weight)
  const rEq = current.reps === previous.reps
  if (wEq && rEq) return "Same as last time"
  const wDiff = current.weight - previous.weight
  if (!wEq) return formatKgDelta(wDiff)
  const rDiff = current.reps - previous.reps
  const sign = rDiff > 0 ? "+" : ""
  return `${sign}${rDiff} reps`
}
