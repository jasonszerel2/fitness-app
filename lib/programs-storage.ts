const PROGRAMS_KEY = "fitlog-programs-v1"

export type ProgramItem = {
  id: string
  exerciseId: string
  /** Snapshot for history/safety if exercise is renamed/deleted */
  exerciseName: string
  targetSets: number
  targetReps: number
  /** Optional target weight in kg */
  targetWeight: number | null
}

export type Program = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  items: ProgramItem[]
}

function isProgramItem(x: any): x is ProgramItem {
  return (
    x != null &&
    typeof x === "object" &&
    typeof x.id === "string" &&
    typeof x.exerciseId === "string" &&
    typeof x.exerciseName === "string" &&
    typeof x.targetSets === "number" &&
    typeof x.targetReps === "number" &&
    ("targetWeight" in x ? x.targetWeight == null || typeof x.targetWeight === "number" : true)
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
    Array.isArray(x.items) &&
    x.items.every(isProgramItem)
  )
}

export function loadPrograms(): Program[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(PROGRAMS_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    return data.filter(isProgram)
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

