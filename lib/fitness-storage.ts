const EXERCISES_KEY = "fitlog-exercises-v1"

export type StoredExercise = {
  id: string
  name: string
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
