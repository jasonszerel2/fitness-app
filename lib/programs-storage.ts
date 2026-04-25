const PROGRAMS_KEY = "fitlog-programs-v1"

export type ProgramPlannedSet = {
  id: string
  /** Optional target weight in kg */
  targetWeight: number | null
  /** Optional target reps */
  targetReps: number | null
}

export type ProgramExercise = {
  id: string
  exerciseId: string
  /** Snapshot for history/safety if exercise is renamed/deleted */
  exerciseName: string
  sets: ProgramPlannedSet[]
}

export type Program = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  exercises: ProgramExercise[]
}

function isPlannedSet(x: any): x is ProgramPlannedSet {
  return (
    x != null &&
    typeof x === "object" &&
    typeof x.id === "string" &&
    ("targetWeight" in x ? x.targetWeight == null || typeof x.targetWeight === "number" : true) &&
    ("targetReps" in x ? x.targetReps == null || typeof x.targetReps === "number" : true)
  )
}

function isProgramExercise(x: any): x is ProgramExercise {
  return (
    x != null &&
    typeof x === "object" &&
    typeof x.id === "string" &&
    typeof x.exerciseId === "string" &&
    typeof x.exerciseName === "string" &&
    Array.isArray(x.sets) &&
    x.sets.every(isPlannedSet)
  )
}

function isProgram(x: any): x is Program {
  return (
    x != null &&
    typeof x === "object" &&
    typeof x.id === "string" &&
    typeof x.name === "string" &&
    typeof x.createdAt === "string" &&
    typeof x.updatedAt === "string" &&
    Array.isArray(x.exercises) &&
    x.exercises.every(isProgramExercise)
  )
}

function migrateProgram(raw: any): Program | null {
  // v2 shape
  if (isProgram(raw)) return raw

  // v1 shape: { items: [{ targetSets, targetReps, targetWeight }] }
  if (
    raw != null &&
    typeof raw === "object" &&
    typeof raw.id === "string" &&
    typeof raw.name === "string" &&
    typeof raw.createdAt === "string" &&
    typeof raw.updatedAt === "string" &&
    Array.isArray((raw as any).items)
  ) {
    const items = (raw as any).items as any[]
    const exercises: ProgramExercise[] = items
      .filter(
        (it) =>
          it &&
          typeof it === "object" &&
          typeof it.id === "string" &&
          typeof it.exerciseId === "string" &&
          typeof it.exerciseName === "string",
      )
      .map((it) => {
        const targetSets = Math.max(1, Math.floor(Number(it.targetSets) || 1))
        const targetReps = Number.isFinite(Number(it.targetReps)) ? Number(it.targetReps) : null
        const targetWeight = Number.isFinite(Number(it.targetWeight)) ? Number(it.targetWeight) : null
        return {
          id: it.id,
          exerciseId: it.exerciseId,
          exerciseName: it.exerciseName,
          sets: Array.from({ length: targetSets }).map(() => ({
            id: newProgramItemId(),
            targetWeight,
            targetReps,
          })),
        } satisfies ProgramExercise
      })
    return {
      id: raw.id,
      name: raw.name,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      exercises,
    }
  }

  return null
}

export function loadPrograms(): Program[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(PROGRAMS_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    const migrated = data.map(migrateProgram).filter((p): p is Program => p != null)
    // If migration changed anything, persist it once.
    if (migrated.length !== data.length || !data.every(isProgram)) savePrograms(migrated)
    return migrated
  } catch {
    return []
  }
}

function savePrograms(list: Program[]) {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(PROGRAMS_KEY, JSON.stringify(list))
  } catch {
    // ignore
  }
}

export function upsertProgram(program: Program) {
  const list = loadPrograms()
  const i = list.findIndex((p) => p.id === program.id)
  const now = new Date().toISOString()
  const next: Program = {
    ...program,
    name: program.name.trim(),
    updatedAt: now,
    createdAt: program.createdAt || now,
  }
  if (i >= 0) list[i] = next
  else list.unshift(next)
  savePrograms(list)
}

export function deleteProgram(id: string) {
  const list = loadPrograms().filter((p) => p.id !== id)
  savePrograms(list)
}

export function newProgramId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function newProgramItemId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `pi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

