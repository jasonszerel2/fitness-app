/** LocalStorage keys used by Fitlog (keep in sync with feature modules). */
export const FITLOG_STORAGE_KEYS = {
  exercises: "fitlog-exercises-v1",
  workouts: "fitlog-saved-workouts-v1",
  programs: "fitlog-programs-v1",
  starterLevel: "fitlog-starter-level-v1",
  /** next-themes default storage key */
  theme: "theme",
} as const

export type FitlogExportV1 = {
  version: 1
  exportedAt: string
  exercises: unknown
  workouts: unknown
  programs: unknown
  /** Flat keys for easy editing */
  starterLevel: string | null
  theme: string | null
  /** Grouped app preferences (same values as flat keys) */
  settings: { starterLevel: string | null; theme: string | null }
}

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeJsonParse(raw: string | null): unknown {
  if (raw == null || raw === "") return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

export function buildFitlogExport(): FitlogExportV1 {
  const exercisesRaw = readRaw(FITLOG_STORAGE_KEYS.exercises)
  const workoutsRaw = readRaw(FITLOG_STORAGE_KEYS.workouts)
  const programsRaw = readRaw(FITLOG_STORAGE_KEYS.programs)
  const starterLevel = readRaw(FITLOG_STORAGE_KEYS.starterLevel)
  const theme = readRaw(FITLOG_STORAGE_KEYS.theme)
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    exercises: safeJsonParse(exercisesRaw) ?? [],
    workouts: safeJsonParse(workoutsRaw) ?? [],
    programs: safeJsonParse(programsRaw) ?? [],
    starterLevel,
    theme,
    settings: { starterLevel, theme },
  }
}

export function downloadFitlogExportJson() {
  if (typeof window === "undefined") return
  const data = buildFitlogExport()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `fitlog-backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Restore whatever keys are present and valid. Skips missing/invalid parts (no throw).
 * Returns theme value to apply via next-themes, if any.
 */
export function applyFitlogImport(json: unknown): { applied: string[]; theme: string | null } {
  const applied: string[] = []
  let theme: string | null = null
  if (typeof window === "undefined") return { applied, theme }

  if (!json || typeof json !== "object") return { applied, theme }
  const o = json as Record<string, unknown>

  const trySet = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
      applied.push(key)
    } catch {
      // quota / private mode
    }
  }

  if (Array.isArray(o.exercises)) {
    trySet(FITLOG_STORAGE_KEYS.exercises, JSON.stringify(o.exercises))
  }

  if (Array.isArray(o.workouts)) {
    trySet(FITLOG_STORAGE_KEYS.workouts, JSON.stringify(o.workouts))
  }

  if (Array.isArray(o.programs)) {
    trySet(FITLOG_STORAGE_KEYS.programs, JSON.stringify(o.programs))
  }

  const applyStarter = (raw: unknown) => {
    if (typeof raw !== "string") return
    const v = raw.trim()
    if (v === "newbie" || v === "intermediate" || v === "charles") {
      trySet(FITLOG_STORAGE_KEYS.starterLevel, v)
    }
  }
  const applyTheme = (raw: unknown) => {
    if (typeof raw !== "string" || !raw.trim()) return
    const t = raw.trim()
    trySet(FITLOG_STORAGE_KEYS.theme, t)
    theme = t
  }

  applyStarter(o.starterLevel)
  if (typeof o.theme === "string") applyTheme(o.theme)

  const nested = o.settings
  if (nested && typeof nested === "object") {
    const s = nested as Record<string, unknown>
    applyStarter(s.starterLevel)
    if (typeof s.theme === "string") applyTheme(s.theme)
  }

  return { applied, theme }
}
