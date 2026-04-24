const EXERCISES_KEY = "fitlog-exercises-v1"

export type StoredExercise = {
  id: string
  name: string
  /** Optional category used for grouping in UI (local only). */
  category?: "Push" | "Pull" | "Legs"
  /** Optional manual order key (lower = earlier). */
  order?: number
  /** Three preset weights in kg */
  weights: [number, number, number]
}

export function loadExercises(): StoredExercise[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(EXERCISES_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data
      .filter(
        (row): row is StoredExercise =>
          row != null &&
          typeof row === "object" &&
          "id" in row &&
          "name" in row &&
          "weights" in row &&
          typeof (row as StoredExercise).id === "string" &&
          typeof (row as StoredExercise).name === "string" &&
          Array.isArray((row as StoredExercise).weights) &&
          (row as StoredExercise).weights.length === 3,
      )
      .map((e) => ({
        id: e.id,
        name: e.name,
        category:
          (e as StoredExercise).category === "Push" ||
          (e as StoredExercise).category === "Pull" ||
          (e as StoredExercise).category === "Legs"
            ? (e as StoredExercise).category
            : undefined,
        order: Number.isFinite((e as StoredExercise).order) ? Number((e as StoredExercise).order) : undefined,
        weights: [
          Number(e.weights[0]) || 0,
          Number(e.weights[1]) || 0,
          Number(e.weights[2]) || 0,
        ] as [number, number, number],
      }))
  } catch {
    return []
  }
}

export function saveExercises(exercises: StoredExercise[]) {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(EXERCISES_KEY, JSON.stringify(exercises))
  } catch {
    // ignore quota / private mode
  }
}

export function newExerciseId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `ex-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}
