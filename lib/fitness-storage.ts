const EXERCISES_KEY = "fitlog-exercises-v1"
const STARTER_LEVEL_KEY = "fitlog-starter-level-v1"

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

function inferCategoryFromName(name: string): StoredExercise["category"] | undefined {
  const n = name.trim().toLowerCase()
  // Push
  if (n.includes("bench press") || (n.includes("bench") && n.includes("press"))) return "Push"
  if (n.includes("incline") && (n.includes("bench") || n.includes("press") || n.includes("fly"))) return "Push"
  if (n.includes("decline") && (n.includes("bench") || n.includes("press"))) return "Push"
  if (n === "shoulder press" || n.includes("shoulder press") || n.includes("overhead press")) return "Push"
  if (n === "dips" || n === "dip") return "Push"
  if (n.includes("chest") && (n.includes("press") || n.includes("fly"))) return "Push"
  if (n.includes("pec deck") || n.includes("pec fly")) return "Push"
  if (n.includes("push-up") || n.includes("push up") || n.includes("pushup")) return "Push"
  // Pull
  if (n === "pull-ups" || n === "pullups" || n === "pull ups" || n === "pullup") return "Pull"
  if (n === "lat pulldown" || n === "lat pull-down" || n === "lat pull down") return "Pull"
  if (n === "cable row" || n === "seated row") return "Pull"
  if (n === "bicep curl" || n === "biceps curl") return "Pull"
  // Legs
  if (n === "squat" || n.includes("squat")) return "Legs"
  if (n === "deadlift" || n.includes("deadlift")) return "Legs"
  if (n === "leg press" || n.includes("leg press")) return "Legs"
  if (n.includes("lunge") || n.includes("leg curl") || n.includes("leg extension") || n.includes("calf raise"))
    return "Legs"
  return undefined
}

/** Resolve Push/Pull/Legs from saved exercise list or name heuristics (local only). */
export function resolveWorkoutExerciseCategory(
  exerciseName: string,
  exercises: StoredExercise[],
): "Push" | "Pull" | "Legs" | null {
  const key = exerciseName.trim().toLowerCase()
  const ex = exercises.find((e) => e.name.trim().toLowerCase() === key)
  const fromStore = ex?.category
  if (fromStore === "Push" || fromStore === "Pull" || fromStore === "Legs") return fromStore
  const inferred = inferCategoryFromName(exerciseName)
  if (inferred === "Push" || inferred === "Pull" || inferred === "Legs") return inferred
  return null
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
            : inferCategoryFromName(e.name),
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

export function loadStarterLevel(): "newbie" | "intermediate" | "charles" | null {
  if (typeof window === "undefined") return null
  try {
    const v = localStorage.getItem(STARTER_LEVEL_KEY)
    if (v === "newbie" || v === "intermediate" || v === "charles") return v
    return null
  } catch {
    return null
  }
}

export function saveStarterLevel(level: "newbie" | "intermediate" | "charles") {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(STARTER_LEVEL_KEY, level)
  } catch {
    // ignore
  }
}

export function newExerciseId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `ex-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}
