"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import {
  Play,
  Square,
  Check,
  Settings,
  ArrowLeft,
  Trash2,
  Pause,
  Pencil,
  ArrowUp,
  ArrowDown,
  Plus,
  ChevronDown,
  ChevronRight,
  Undo2,
  LayoutList,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useTheme } from "next-themes"
import {
  loadExercises,
  saveExercises,
  newExerciseId,
  loadStarterLevel,
  saveStarterLevel,
  resolveWorkoutExerciseCategory,
  type StoredExercise,
} from "@/lib/fitness-storage"
import {
  appendSavedWorkout,
  deleteSavedWorkout,
  loadSavedWorkouts,
  newSavedWorkoutId,
  replaceSavedWorkout,
  type SavedWorkout,
  type SavedWorkoutSet,
  updateSavedWorkoutName,
} from "@/lib/saved-workouts-storage"
import { findLastExerciseSession, compareSetToPrevious } from "@/lib/exercise-memory"
import {
  deleteProgram,
  loadPrograms,
  newProgramId,
  newProgramItemId,
  upsertProgram,
  type Program,
  type ProgramExercise,
} from "@/lib/programs-storage"
import { applyFitlogImport, downloadFitlogExportJson } from "@/lib/fitlog-backup"

type Screen =
  | "home"
  | "chooseFirstExercise"
  | "chooseWorkoutMode"
  | "programs"
  | "programEditor"
  | "settings"
  | "workout"
  | "workoutSummary"
  | "workoutHistory"
  | "workoutHistoryDetail"

type StarterLevel = "newbie" | "intermediate" | "charles"
type ExerciseTab = "All" | "Push" | "Pull" | "Legs"

/** One row in the current session’s log (in-memory, local to this app session) */
type SessionSetLog = {
  id: string
  sessionId: string
  sessionStartedAt: string
  exerciseId: string
  exerciseName: string
  weight: number
  reps: number
  setEndedAt: string
  setDurationSec: number
  /** Filled when the user presses Start for the *next* set; until then `null` */
  restBeforeNextSetSec: number | null
  /** Optional note for this set */
  note?: string
}

type PendingAfterStop = {
  exerciseId: string
  exerciseName: string
  setEndedAt: Date
  setDurationSec: number
}

/**
 * Priority for “previous” reps when opening the log form (weight-specific):
 * 1) Last set in the current session for this exercise at this exact weight
 * 2) Most recent saved workout set for this exercise at this exact weight
 * 3) Fallback to 8 reps
 */
function getSuggestedRepsForWeight(
  exerciseName: string,
  weight: number,
  sessionLogs: SessionSetLog[],
  savedWorkouts: SavedWorkout[],
): number {
  const clamp = (n: number) => Math.min(99, Math.max(1, Math.round(n)))
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-6

  // 1) current session: last logged set with same weight
  for (let i = sessionLogs.length - 1; i >= 0; i--) {
    const l = sessionLogs[i]
    if (l.exerciseName === exerciseName && near(l.weight, weight) && l.reps > 0) {
      return clamp(l.reps)
    }
  }

  // 2) history: scan most recent workouts first, pick the most recent set with same weight
  const sorted = [...savedWorkouts].sort(
    (a, b) => new Date(b.sessionEndedAt).getTime() - new Date(a.sessionEndedAt).getTime(),
  )
  for (const w of sorted) {
    const group = w.byExercise.find((g) => g.exerciseName === exerciseName)
    if (!group?.sets?.length) continue
    for (let i = group.sets.length - 1; i >= 0; i--) {
      const s = group.sets[i]
      if (near(s.weight, weight) && Number.isFinite(s.reps) && s.reps > 0) return clamp(s.reps)
    }
  }
  return 8
}

function formatSessionDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

function formatWorkoutNameDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  } catch {
    return iso
  }
}

function formatClock(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    return iso
  }
}

/** e.g. Apr 21 (for “last time” labels) */
function formatShortSessionDay(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  } catch {
    return iso
  }
}

function savedWorkoutTotalSets(w: SavedWorkout): number {
  return w.byExercise.reduce((acc, g) => acc + g.sets.length, 0)
}

function savedWorkoutExerciseCount(w: SavedWorkout): number {
  if (w.exercisesPerformed?.length) return w.exercisesPerformed.length
  return w.byExercise.length
}

function formatWorkoutDurationMinutes(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0
  const m = Math.round(s / 60)
  if (m <= 0) return "< 1 min"
  return `${m} min`
}

const GENERIC_WORKOUT_NAME_RE = /^Workout \d+$/

function nextWorkoutFallbackNumber(existingSaved: SavedWorkout[]): number {
  let max = 0
  for (const w of existingSaved) {
    const m = w.name?.trim().match(/^Workout (\d+)$/)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return max + 1
}

/** Chest-biased push movements for “Chest Day” vs “Push Day” when session is push-only. */
function isChestLikePushExerciseName(name: string): boolean {
  const n = name.trim().toLowerCase()
  if (/\bbench\s*press\b/.test(n)) return true
  if (/incline/.test(n) && /(bench|press|fly)/.test(n)) return true
  if (/decline/.test(n) && /(bench|press)/.test(n)) return true
  if (/\bdips?\b/.test(n)) return true
  if (/chest/.test(n) && /(press|fly|cross)/.test(n)) return true
  if (/pec\s*(deck|fly)/.test(n)) return true
  if (/push[\s-]?up/.test(n) || /pushup/.test(n)) return true
  if (/cable\s+(cross|fly)/.test(n)) return true
  if (/\b(db|dumbbell)\b.*bench/.test(n)) return true
  return false
}

function generateSmartWorkoutName(
  exerciseOrder: string[],
  exercises: StoredExercise[],
  existingSaved: SavedWorkout[],
): string {
  if (exerciseOrder.length === 0) {
    return `Workout ${nextWorkoutFallbackNumber(existingSaved)}`
  }
  const cats = exerciseOrder.map((name) => resolveWorkoutExerciseCategory(name, exercises))
  if (cats.some((c) => c == null)) {
    return `Workout ${nextWorkoutFallbackNumber(existingSaved)}`
  }
  const hasPush = cats.some((c) => c === "Push")
  const hasPull = cats.some((c) => c === "Pull")
  const hasLegs = cats.some((c) => c === "Legs")

  if (hasPush && hasPull && hasLegs) return "Full Body"
  if (hasLegs && (hasPush || hasPull)) return "Mixed Leg Day"
  if (hasPush && hasPull && !hasLegs) return "Upper Body"
  if (hasPull && !hasPush && !hasLegs) return "Back Day"
  if (hasLegs && !hasPush && !hasPull) return "Leg Day"
  if (hasPush && !hasPull && !hasLegs) {
    const pushNames = exerciseOrder.filter((_, i) => cats[i] === "Push")
    const chestLike = pushNames.filter(isChestLikePushExerciseName).length
    const otherPush = pushNames.length - chestLike
    if (chestLike > otherPush) return "Chest Day"
    return "Push Day"
  }
  return `Workout ${nextWorkoutFallbackNumber(existingSaved)}`
}

function isAutoDateWorkoutName(name: string | undefined, sessionEndedAt: string): boolean {
  const t = name?.trim()
  if (!t) return true
  try {
    return t === formatWorkoutNameDate(sessionEndedAt)
  } catch {
    return false
  }
}

function savedWorkoutDisplayTitle(w: SavedWorkout): string {
  const n = w.name?.trim()
  if (!n) return "Workout"
  if (isAutoDateWorkoutName(n, w.sessionEndedAt)) return "Workout"
  return n
}

function syncExercisesPerformedFromGroups(
  groups: { exerciseName: string }[],
  previous: string[],
): string[] {
  const inGroups = new Set(groups.map((g) => g.exerciseName))
  const out = previous.filter((n) => inGroups.has(n))
  for (const g of groups) {
    if (!out.includes(g.exerciseName)) out.push(g.exerciseName)
  }
  return out
}

function applyNoteToSessionLog(log: SessionSetLog, draft: string): SessionSetLog {
  const t = draft.trim()
  if (!t) {
    const { note: _n, ...rest } = log
    return rest as SessionSetLog
  }
  return { ...log, note: t }
}

function updateSavedSetFields(
  w: SavedWorkout,
  groupName: string,
  setId: string,
  patch: Partial<Pick<SavedWorkoutSet, "weight" | "reps" | "note">>,
): SavedWorkout {
  return {
    ...w,
    byExercise: w.byExercise.map((g) =>
      g.exerciseName !== groupName
        ? g
        : {
            ...g,
            sets: g.sets.map((s) => {
              if (s.id !== setId) return s
              const merged = { ...s, ...patch } as SavedWorkoutSet
              if ("note" in patch) {
                const t = (patch.note ?? "").trim()
                if (!t) {
                  const { note: _omit, ...rest } = merged
                  return rest as SavedWorkoutSet
                }
                merged.note = t
              }
              return merged
            }),
          },
    ),
  }
}

function deleteSavedSetFromWorkout(w: SavedWorkout, groupName: string, setId: string): SavedWorkout {
  const byExercise = w.byExercise
    .map((g) =>
      g.exerciseName !== groupName ? g : { ...g, sets: g.sets.filter((s) => s.id !== setId) },
    )
    .filter((g) => g.sets.length > 0)
  return {
    ...w,
    byExercise,
    exercisesPerformed: syncExercisesPerformedFromGroups(byExercise, w.exercisesPerformed ?? []),
  }
}

function moveSavedSetToGroup(
  w: SavedWorkout,
  fromGroup: string,
  setId: string,
  toExerciseName: string,
): SavedWorkout | null {
  if (fromGroup === toExerciseName) return w
  const group = w.byExercise.find((g) => g.exerciseName === fromGroup)
  const set = group?.sets.find((s) => s.id === setId)
  if (!set) return null
  let byExercise = w.byExercise
    .map((g) => (g.exerciseName !== fromGroup ? g : { ...g, sets: g.sets.filter((s) => s.id !== setId) }))
    .filter((g) => g.sets.length > 0)
  const tIdx = byExercise.findIndex((g) => g.exerciseName === toExerciseName)
  if (tIdx >= 0) {
    const target = byExercise[tIdx]!
    byExercise = [...byExercise]
    byExercise[tIdx] = { ...target, sets: [...target.sets, { ...set }] }
  } else {
    byExercise = [...byExercise, { exerciseName: toExerciseName, sets: [{ ...set }] }]
  }
  const prev = w.exercisesPerformed ?? []
  return {
    ...w,
    byExercise,
    exercisesPerformed: syncExercisesPerformedFromGroups(byExercise, [...prev, toExerciseName]),
  }
}

function exerciseCategoryLabel(c: StoredExercise["category"]): "Push" | "Pull" | "Legs" | "Unassigned" {
  if (c === "Push" || c === "Pull" || c === "Legs") return c
  return "Unassigned"
}

function exerciseOrderValue(ex: StoredExercise, fallbackIndex: number) {
  return Number.isFinite(ex.order) ? (ex.order as number) : 100000 + fallbackIndex
}

function groupExercisesForUI(exercises: StoredExercise[]) {
  const order: Array<"Push" | "Pull" | "Legs" | "Unassigned"> = ["Push", "Pull", "Legs", "Unassigned"]
  const map = new Map<(typeof order)[number], StoredExercise[]>()
  for (const k of order) map.set(k, [])
  for (const [idx, ex] of exercises.entries()) {
    map.get(exerciseCategoryLabel(ex.category))!.push({ ...ex, order: ex.order ?? (100000 + idx) })
  }
  return order
    .map((k) => ({
      label: k,
      items: (map.get(k) ?? []).sort((a, b) => {
        const ao = exerciseOrderValue(a, 0)
        const bo = exerciseOrderValue(b, 0)
        if (ao !== bo) return ao - bo
        return a.name.localeCompare(b.name)
      }),
    }))
    .filter((g) => g.items.length > 0)
}

function categoryToSelectValue(c: StoredExercise["category"]): ExerciseTab {
  if (c === "Push" || c === "Pull" || c === "Legs") return c
  return "Push"
}

function starterExercises(level: StarterLevel, newId: () => string): StoredExercise[] {
  const presets: Record<
    StarterLevel,
    Array<{ name: string; category: NonNullable<StoredExercise["category"]>; weights: [number, number, number] }>
  > = {
    newbie: [
      // Push
      { name: "Bench Press", category: "Push", weights: [20, 30, 40] },
      { name: "Incline Bench Press", category: "Push", weights: [15, 25, 35] },
      { name: "Shoulder Press", category: "Push", weights: [10, 15, 20] },
      { name: "Dips", category: "Push", weights: [10, 15, 20] },
      { name: "Tricep Pushdown", category: "Push", weights: [15, 20, 25] },
      // Pull
      { name: "Pull-ups", category: "Pull", weights: [10, 15, 20] },
      { name: "Lat Pulldown", category: "Pull", weights: [30, 40, 50] },
      { name: "Seated Cable Row", category: "Pull", weights: [25, 35, 45] },
      { name: "Barbell Row", category: "Pull", weights: [20, 30, 40] },
      { name: "Bicep Curl", category: "Pull", weights: [6, 8, 10] },
      // Legs
      { name: "Squat", category: "Legs", weights: [30, 40, 50] },
      { name: "Leg Press", category: "Legs", weights: [60, 80, 100] },
      { name: "Romanian Deadlift", category: "Legs", weights: [30, 40, 50] },
      { name: "Leg Curl", category: "Legs", weights: [15, 20, 25] },
      { name: "Leg Extension", category: "Legs", weights: [15, 20, 25] },
    ],
    intermediate: [
      // Push
      { name: "Bench Press", category: "Push", weights: [40, 60, 80] },
      { name: "Incline Bench Press", category: "Push", weights: [30, 45, 60] },
      { name: "Shoulder Press", category: "Push", weights: [20, 25, 30] },
      { name: "Dips", category: "Push", weights: [20, 30, 40] },
      { name: "Tricep Pushdown", category: "Push", weights: [25, 35, 45] },
      // Pull
      { name: "Pull-ups", category: "Pull", weights: [20, 30, 40] },
      { name: "Lat Pulldown", category: "Pull", weights: [50, 70, 90] },
      { name: "Seated Cable Row", category: "Pull", weights: [45, 60, 75] },
      { name: "Barbell Row", category: "Pull", weights: [40, 60, 80] },
      { name: "Bicep Curl", category: "Pull", weights: [8, 10, 14] },
      // Legs
      { name: "Squat", category: "Legs", weights: [60, 80, 100] },
      { name: "Leg Press", category: "Legs", weights: [100, 140, 180] },
      { name: "Romanian Deadlift", category: "Legs", weights: [60, 80, 100] },
      { name: "Leg Curl", category: "Legs", weights: [30, 40, 50] },
      { name: "Leg Extension", category: "Legs", weights: [30, 40, 50] },
    ],
    charles: [
      // Push
      { name: "Bench Press", category: "Push", weights: [80, 100, 120] },
      { name: "Incline Bench Press", category: "Push", weights: [60, 80, 100] },
      { name: "Shoulder Press", category: "Push", weights: [30, 40, 50] },
      { name: "Dips", category: "Push", weights: [40, 50, 60] },
      { name: "Tricep Pushdown", category: "Push", weights: [45, 60, 75] },
      // Pull
      { name: "Pull-ups", category: "Pull", weights: [40, 50, 60] },
      { name: "Lat Pulldown", category: "Pull", weights: [80, 100, 120] },
      { name: "Seated Cable Row", category: "Pull", weights: [70, 90, 110] },
      { name: "Barbell Row", category: "Pull", weights: [80, 100, 120] },
      { name: "Bicep Curl", category: "Pull", weights: [14, 18, 22] },
      // Legs
      { name: "Squat", category: "Legs", weights: [100, 120, 140] },
      { name: "Leg Press", category: "Legs", weights: [180, 220, 260] },
      { name: "Romanian Deadlift", category: "Legs", weights: [100, 120, 140] },
      { name: "Leg Curl", category: "Legs", weights: [50, 70, 90] },
      { name: "Leg Extension", category: "Legs", weights: [50, 70, 90] },
    ],
  }
  return presets[level].map((e) => ({ id: newId(), name: e.name, category: e.category, weights: e.weights }))
}

function ensureStarterExercises(
  existing: StoredExercise[],
  level: StarterLevel,
  newId: () => string,
): StoredExercise[] {
  const want = starterExercises(level, newId)
  const haveNames = new Set(existing.map((e) => e.name.trim().toLowerCase()))
  const missing = want.filter((e) => !haveNames.has(e.name.trim().toLowerCase()))
  if (!missing.length) return existing
  return [...existing, ...missing]
}

function WorkoutPauseOverlay({
  onResume,
  onFinish,
  onCancel,
}: {
  onResume: () => void
  onFinish: () => void
  onCancel: () => void
}) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/90 p-4">
      <div className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-card p-5 shadow-lg">
        <h2 className="text-center text-lg font-semibold">Paused</h2>
        <p className="text-center text-sm text-muted-foreground">All timers are stopped</p>
        <Button type="button" className="w-full" size="lg" onClick={onResume}>
          Resume Workout
        </Button>
        <Button type="button" className="w-full" size="lg" onClick={onFinish}>
          Finish &amp; Save Workout
        </Button>
        <Button type="button" className="w-full" size="lg" variant="outline" onClick={onCancel}>
          Cancel Workout
        </Button>
      </div>
    </div>
  )
}

export function FitnessApp() {
  const { theme, setTheme } = useTheme()
  const [screen, setScreen] = useState<Screen>("home")
  const [exercises, setExercises] = useState<StoredExercise[]>([])
  const [workoutTab, setWorkoutTab] = useState<ExerciseTab>("All")
  const [showQuickAddExercise, setShowQuickAddExercise] = useState(false)
  const [quickAddName, setQuickAddName] = useState("")
  const [quickAddCategory, setQuickAddCategory] = useState<ExerciseTab>("Push")
  const [quickAddW1, setQuickAddW1] = useState("")
  const [quickAddW2, setQuickAddW2] = useState("")
  const [quickAddW3, setQuickAddW3] = useState("")
  const [manageExpanded, setManageExpanded] = useState<Record<"Push" | "Pull" | "Legs", boolean>>({
    Push: true,
    Pull: true,
    Legs: true,
  })

  const [sessionId, setSessionId] = useState("")
  const [sessionStartedAt, setSessionStartedAt] = useState("")

  const [currentExerciseId, setCurrentExerciseId] = useState<string | null>(null)
  const [sessionExerciseIds, setSessionExerciseIds] = useState<string[]>([])
  const [showSwitchSheet, setShowSwitchSheet] = useState(false)
  const [isSetActive, setIsSetActive] = useState(false)
  const [restTime, setRestTime] = useState(0)
  const [setTime, setSetTime] = useState(0)
  const setTimeRef = useRef(0)
  const restTimeRef = useRef(0)
  const setStartedAtMsRef = useRef<number | null>(null)
  const restStartedAtMsRef = useRef<number | null>(null)
  const setBaseSecRef = useRef(0)
  const restBaseSecRef = useRef(0)
  const wakeLockRef = useRef<any>(null)

  const [showLogForm, setShowLogForm] = useState(false)
  const [pendingAfterStop, setPendingAfterStop] = useState<PendingAfterStop | null>(null)
  const [selectedWeight, setSelectedWeight] = useState<number | null>(null)
  const [customWeight, setCustomWeight] = useState("")
  const [showCustomWeight, setShowCustomWeight] = useState(false)
  const customWeightInputRef = useRef<HTMLInputElement>(null)
  const [reps, setReps] = useState("")
  const [showCustomReps, setShowCustomReps] = useState(false)
  const [showLogChangeExerciseSheet, setShowLogChangeExerciseSheet] = useState(false)
  const [logSetNote, setLogSetNote] = useState("")
  const [restNoteSheet, setRestNoteSheet] = useState<{ logId: string; draft: string } | null>(null)

  const [sessionLogs, setSessionLogs] = useState<SessionSetLog[]>([])

  const [isResting, setIsResting] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [summaryWorkout, setSummaryWorkout] = useState<SavedWorkout | null>(null)

  const [draftName, setDraftName] = useState("")
  const [draftW1, setDraftW1] = useState("")
  const [draftW2, setDraftW2] = useState("")
  const [draftW3, setDraftW3] = useState("")
  const [editingExerciseId, setEditingExerciseId] = useState<string | null>(null)
  const [editExName, setEditExName] = useState("")
  const [editExCategory, setEditExCategory] = useState<"Push" | "Pull" | "Legs" | "">("")
  const [editExW1, setEditExW1] = useState("")
  const [editExW2, setEditExW2] = useState("")
  const [editExW3, setEditExW3] = useState("")
  const [showProgramAddExerciseSheet, setShowProgramAddExerciseSheet] = useState(false)
  const [showProgramCreateExercise, setShowProgramCreateExercise] = useState(false)
  const [progNewExName, setProgNewExName] = useState("")
  const [progNewExCategory, setProgNewExCategory] = useState<"Push" | "Pull" | "Legs">("Push")
  const [progNewExW1, setProgNewExW1] = useState("")
  const [progNewExW2, setProgNewExW2] = useState("")
  const [progNewExW3, setProgNewExW3] = useState("")

  const [exercisesReady, setExercisesReady] = useState(false)

  const [savedWorkoutsList, setSavedWorkoutsList] = useState<SavedWorkout[]>([])
  const [programsList, setProgramsList] = useState<Program[]>([])
  const [editingProgram, setEditingProgram] = useState<Program | null>(null)
  const [activeProgram, setActiveProgram] = useState<Program | null>(null)
  const [lastAddedProgramExerciseId, setLastAddedProgramExerciseId] = useState<string | null>(null)
  const lastAddedProgramExerciseRef = useRef<HTMLDivElement | null>(null)
  const [historyDetailWorkout, setHistoryDetailWorkout] = useState<SavedWorkout | null>(null)
  const [historyEditingId, setHistoryEditingId] = useState<string | null>(null)
  const [historyDraftName, setHistoryDraftName] = useState("")
  const [sessionSetEditSheet, setSessionSetEditSheet] = useState<
    | null
    | {
        log: SessionSetLog
        phase: "actions" | "weight" | "reps" | "exercise" | "note"
        draftW: string
        draftR: string
        draftNote: string
      }
  >(null)
  const [setEditPickerTab, setSetEditPickerTab] = useState<ExerciseTab>("All")
  const [historySetEditSheet, setHistorySetEditSheet] = useState<
    | null
    | {
        groupName: string
        set: SavedWorkoutSet
        phase: "actions" | "weight" | "reps" | "exercise" | "note"
        draftW: string
        draftR: string
        draftNote: string
      }
  >(null)
  const [postSaveComparison, setPostSaveComparison] = useState<
    | null
    | {
        text: string
        tone: "up" | "down" | "same" | "new"
        isPersonalBest: boolean
      }
  >(null)
  const postSaveComparisonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repsInputRef = useRef<HTMLInputElement>(null)
  const importBackupInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setTimeRef.current = setTime
  }, [setTime])

  useEffect(() => {
    restTimeRef.current = restTime
  }, [restTime])

  const computeSetElapsedSec = useCallback(() => {
    const base = setBaseSecRef.current
    const start = setStartedAtMsRef.current
    if (start == null) return base
    return Math.max(0, base + Math.floor((Date.now() - start) / 1000))
  }, [])

  const computeRestElapsedSec = useCallback(() => {
    const base = restBaseSecRef.current
    const start = restStartedAtMsRef.current
    if (start == null) return base
    return Math.max(0, base + Math.floor((Date.now() - start) / 1000))
  }, [])

  const syncTimersNow = useCallback(() => {
    if (isSetActive) setSetTime(computeSetElapsedSec())
    if (isResting) setRestTime(computeRestElapsedSec())
  }, [computeRestElapsedSec, computeSetElapsedSec, isResting, isSetActive])

  // Keep screen awake during an active set (best-effort).
  useEffect(() => {
    let cancelled = false
    async function enable() {
      try {
        const wl = (navigator as any)?.wakeLock
        if (!wl?.request) return
        const sentinel = await wl.request("screen")
        if (cancelled) {
          try {
            await sentinel?.release?.()
          } catch {
            // ignore
          }
          return
        }
        wakeLockRef.current = sentinel
        sentinel?.addEventListener?.("release", () => {
          if (wakeLockRef.current === sentinel) wakeLockRef.current = null
        })
      } catch {
        // ignore unsupported / denied
      }
    }

    async function disable() {
      try {
        await wakeLockRef.current?.release?.()
      } catch {
        // ignore
      } finally {
        wakeLockRef.current = null
      }
    }

    if (isSetActive && screen === "workout" && !isPaused) {
      enable()
    } else {
      disable()
    }

    return () => {
      cancelled = true
      disable()
    }
  }, [isSetActive, screen, isPaused])

  useEffect(() => {
    setExercises(loadExercises())
    setExercisesReady(true)
  }, [])

  // If the user previously chose a starter level, ensure missing starter exercises are present.
  useEffect(() => {
    if (!exercisesReady) return
    const level = loadStarterLevel()
    if (!level) return
    setExercises((prev) => ensureStarterExercises(prev, level, newExerciseId))
  }, [exercisesReady])

  useEffect(() => {
    if (!exercisesReady) return
    saveExercises(exercises)
  }, [exercises, exercisesReady])

  useEffect(() => {
    if (screen === "workoutHistory" || screen === "workoutHistoryDetail" || screen === "workout") {
      setSavedWorkoutsList(loadSavedWorkouts())
    }
  }, [screen])

  useEffect(() => {
    if (screen === "programs" || screen === "programEditor") {
      setProgramsList(loadPrograms())
    }
  }, [screen])

  useEffect(() => {
    if (screen !== "programEditor") return
    if (!lastAddedProgramExerciseId) return
    // Scroll to the newly added exercise, then clear.
    lastAddedProgramExerciseRef.current?.scrollIntoView({ block: "start", behavior: "auto" })
    setLastAddedProgramExerciseId(null)
  }, [lastAddedProgramExerciseId, screen])

  const sortedSavedWorkouts = useMemo(() => {
    return [...savedWorkoutsList].sort(
      (a, b) => new Date(b.sessionEndedAt).getTime() - new Date(a.sessionEndedAt).getTime(),
    )
  }, [savedWorkoutsList])

  const savedWorkoutsForInsights = useMemo(() => {
    // Used for summary/history computed labels; exclude current summary workout when present.
    const excludeId = summaryWorkout?.id
    return sortedSavedWorkouts.filter((w) => w.id !== excludeId)
  }, [sortedSavedWorkouts, summaryWorkout?.id])

  const currentExercise = useMemo(
    () => exercises.find((e) => e.id === currentExerciseId) ?? null,
    [exercises, currentExerciseId],
  )

  const currentExerciseSessionSets = useMemo(() => {
    if (!currentExercise) return []
    return sessionLogs.filter((l) => l.exerciseName === currentExercise.name)
  }, [sessionLogs, currentExercise])

  const currentExerciseLastSet = useMemo(() => {
    if (!currentExerciseSessionSets.length) return null
    return currentExerciseSessionSets[currentExerciseSessionSets.length - 1]
  }, [currentExerciseSessionSets])

  const programProgress = useMemo(() => {
    if (!activeProgram) return null
    const setsByExerciseId = new Map<string, number>()
    for (const l of sessionLogs) {
      setsByExerciseId.set(l.exerciseId, (setsByExerciseId.get(l.exerciseId) ?? 0) + 1)
    }
    const nextExercise = activeProgram.exercises.find((ex) => {
      const done = setsByExerciseId.get(ex.exerciseId) ?? 0
      return done < ex.sets.length
    })
    const nextSet =
      nextExercise != null ? nextExercise.sets[setsByExerciseId.get(nextExercise.exerciseId) ?? 0] ?? null : null
    const currentPlanned = currentExerciseId
      ? activeProgram.exercises.find((ex) => ex.exerciseId === currentExerciseId) ?? null
      : null
    const currentDone = currentPlanned ? setsByExerciseId.get(currentPlanned.exerciseId) ?? 0 : 0
    const currentNextSet =
      currentPlanned != null ? currentPlanned.sets[currentDone] ?? null : null
    const currentTotalSets = currentPlanned?.sets.length ?? 0
    const currentSetNumber =
      currentPlanned && currentTotalSets > 0
        ? currentDone >= currentTotalSets
          ? currentTotalSets
          : currentDone + 1
        : 0
    const currentAllSetsDone =
      currentPlanned != null && currentTotalSets > 0 && currentDone >= currentTotalSets

    let nextExercisePreview: {
      exerciseId: string
      exerciseName: string
      setsCount: number
      firstWeight: string
      firstReps: string
    } | null = null
    if (nextExercise) {
      const s0 = nextExercise.sets[0]
      nextExercisePreview = {
        exerciseId: nextExercise.exerciseId,
        exerciseName: nextExercise.exerciseName,
        setsCount: nextExercise.sets.length,
        firstWeight: s0?.targetWeight != null ? `${s0.targetWeight} kg` : "—",
        firstReps: s0?.targetReps != null ? `${s0.targetReps} reps` : "—",
      }
    }
    const sameExerciseAsNext =
      nextExercise != null &&
      currentPlanned != null &&
      nextExercise.exerciseId === currentPlanned.exerciseId
    const remainingThisExercise =
      currentPlanned != null ? Math.max(0, currentPlanned.sets.length - currentDone) : 0

    return {
      setsByExerciseId,
      nextExercise,
      nextSet,
      currentPlanned,
      currentDone,
      currentNextSet,
      currentTotalSets,
      currentSetNumber,
      currentAllSetsDone,
      nextExercisePreview,
      sameExerciseAsNext,
      remainingThisExercise,
    }
  }, [activeProgram, sessionLogs, currentExerciseId])

  const lastSessionForCurrentExercise = useMemo(() => {
    if (!currentExercise) return null
    return findLastExerciseSession(savedWorkoutsList, currentExercise.name)
  }, [savedWorkoutsList, currentExercise])

  /** Next set index (1-based) for the exercise currently being logged */
  const pendingLogSetNumber = useMemo(() => {
    if (!pendingAfterStop) return 0
    return sessionLogs.filter((l) => l.exerciseName === pendingAfterStop.exerciseName).length + 1
  }, [pendingAfterStop, sessionLogs])

  const lastTimeSetMatchingPending = useMemo(() => {
    if (!pendingAfterStop || pendingLogSetNumber < 1) return undefined
    return findLastExerciseSession(savedWorkoutsList, pendingAfterStop.exerciseName)?.sets[
      pendingLogSetNumber - 1
    ]
  }, [savedWorkoutsList, pendingAfterStop, pendingLogSetNumber])

  useEffect(() => {
    if (!showLogForm || !showCustomReps) return
    const id = requestAnimationFrame(() => {
      repsInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [showLogForm, showCustomReps])

  useEffect(() => {
    if (!showLogForm || !showCustomWeight) return
    const id = requestAnimationFrame(() => {
      customWeightInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [showLogForm, showCustomWeight])

  /** Rest runs whenever we are not in an active set and rest mode is on (e.g. after stop, including on log form) */
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null

    // Ensure we have a start timestamp when running.
    if (isResting && !isSetActive && !isPaused) {
      if (restStartedAtMsRef.current == null) restStartedAtMsRef.current = Date.now()
      syncTimersNow()
      interval = setInterval(syncTimersNow, 250)
    } else {
      // Freeze rest timer when not running.
      if (restStartedAtMsRef.current != null) {
        restBaseSecRef.current = computeRestElapsedSec()
        restStartedAtMsRef.current = null
        setRestTime(restBaseSecRef.current)
      }
    }

    return () => {
      if (interval) clearInterval(interval)
    }
  }, [computeRestElapsedSec, isPaused, isResting, isSetActive, syncTimersNow])

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null

    if (isSetActive && !isPaused) {
      if (setStartedAtMsRef.current == null) setStartedAtMsRef.current = Date.now()
      syncTimersNow()
      interval = setInterval(syncTimersNow, 250)
    } else {
      if (setStartedAtMsRef.current != null) {
        setBaseSecRef.current = computeSetElapsedSec()
        setStartedAtMsRef.current = null
        setSetTime(setBaseSecRef.current)
      }
    }

    return () => {
      if (interval) clearInterval(interval)
    }
  }, [computeSetElapsedSec, isPaused, isSetActive, syncTimersNow])

  useEffect(() => {
    const onVis = () => {
      // When returning to the app, re-sync from timestamps.
      if (document.visibilityState === "visible") syncTimersNow()
    }
    window.addEventListener("focus", syncTimersNow)
    document.addEventListener("visibilitychange", onVis)
    return () => {
      window.removeEventListener("focus", syncTimersNow)
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [syncTimersNow])

  const formatTime = useCallback((seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }, [])

  const resetDraft = () => {
    setDraftName("")
    setDraftW1("")
    setDraftW2("")
    setDraftW3("")
  }

  const addExercise = () => {
    const name = draftName.trim()
    const w1 = parseFloat(draftW1)
    const w2 = parseFloat(draftW2)
    const w3 = parseFloat(draftW3)
    if (!name || [w1, w2, w3].some((w) => !Number.isFinite(w) || w < 0)) {
      return
    }
    setExercises((prev) => [
      ...prev,
      { id: newExerciseId(), name, weights: [w1, w2, w3] as [number, number, number] },
    ])
    resetDraft()
  }

  const removeExercise = (id: string) => {
    setExercises((prev) => prev.filter((e) => e.id !== id))
    if (currentExerciseId === id) setCurrentExerciseId(null)
    setSessionExerciseIds((prev) => prev.filter((x) => x !== id))
  }

  const moveExerciseInGroup = (exerciseId: string, dir: -1 | 1) => {
    setExercises((prev) => {
      const groups = groupExercisesForUI(prev)
      const group = groups.find((g) => g.items.some((e) => e.id === exerciseId))
      if (!group) return prev
      const sorted = group.items
      const idx = sorted.findIndex((e) => e.id === exerciseId)
      const j = idx + dir
      if (idx < 0 || j < 0 || j >= sorted.length) return prev

      const a = sorted[idx]
      const b = sorted[j]
      const ao = exerciseOrderValue(a, 0)
      const bo = exerciseOrderValue(b, 0)

      return prev.map((e) => {
        if (e.id === a.id) return { ...e, order: bo }
        if (e.id === b.id) return { ...e, order: ao }
        return e
      })
    })
  }

  const resetWorkoutSession = useCallback(() => {
    setSessionId("")
    setSessionStartedAt("")
    setCurrentExerciseId(null)
    setSessionExerciseIds([])
    setShowSwitchSheet(false)
    setActiveProgram(null)
    setSessionLogs([])
    setPendingAfterStop(null)
    setShowLogForm(false)
    setSelectedWeight(null)
    setCustomWeight("")
    setReps("")
    setLogSetNote("")
    setRestNoteSheet(null)
    setIsSetActive(false)
    setIsResting(false)
    setIsPaused(false)
    setStartedAtMsRef.current = null
    restStartedAtMsRef.current = null
    setBaseSecRef.current = 0
    restBaseSecRef.current = 0
    setRestTime(0)
    setSetTime(0)
    setPostSaveComparison(null)
    if (postSaveComparisonTimerRef.current) {
      clearTimeout(postSaveComparisonTimerRef.current)
      postSaveComparisonTimerRef.current = null
    }
    setSessionSetEditSheet(null)
  }, [])

  const activateExercise = useCallback(
    (exerciseId: string) => {
      setPostSaveComparison(null)
      if (postSaveComparisonTimerRef.current) {
        clearTimeout(postSaveComparisonTimerRef.current)
        postSaveComparisonTimerRef.current = null
      }
      setCurrentExerciseId(exerciseId)
      setSessionExerciseIds((prev) => (prev.includes(exerciseId) ? prev : [...prev, exerciseId]))
      setShowSwitchSheet(false)
    },
    [setPostSaveComparison],
  )

  const startWorkout = () => {
    if (exercises.length === 0) return
    const progs = loadPrograms()
    setProgramsList(progs)
    const start = new Date()
    resetWorkoutSession()
    setSessionId(`sess-${start.getTime()}-${Math.random().toString(36).slice(2, 7)}`)
    setSessionStartedAt(start.toISOString())
    setCurrentExerciseId(null)
    setSessionExerciseIds([])
    setShowSwitchSheet(false)
    setIsPaused(false)
    setScreen(progs.length === 0 ? "chooseFirstExercise" : "chooseWorkoutMode")
  }

  /** Settings only: does not clear an in-progress workout (none reachable from here today) */
  const returnFromSettingsToHome = () => {
    setScreen("home")
  }

  const openPause = () => {
    setIsPaused(true)
  }

  const resumeWorkout = () => {
    setIsPaused(false)
  }

  const confirmCancelWorkout = () => {
    if (typeof window !== "undefined" && !window.confirm("Discard this workout? Nothing will be saved.")) {
      return
    }
    resetWorkoutSession()
    setIsPaused(false)
    setScreen("home")
  }

  const dismissSummaryToHome = () => {
    setSummaryWorkout(null)
    setScreen("home")
  }

  const startSet = () => {
    if (isPaused) return
    const restToAttach = computeRestElapsedSec()
    if (isSetActive) return

    setSessionLogs((prev) => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const i = next.length - 1
      if (next[i].restBeforeNextSetSec == null) {
        next[i] = { ...next[i], restBeforeNextSetSec: restToAttach }
      }
      return next
    })

    setIsResting(false)
    restBaseSecRef.current = 0
    restStartedAtMsRef.current = null
    setRestTime(0)
    setSetTime(0)
    setBaseSecRef.current = 0
    setStartedAtMsRef.current = Date.now()
    setIsSetActive(true)
  }

  const stopSet = () => {
    if (isPaused) return
    if (!currentExercise) return
    const ended = new Date()
    const duration = computeSetElapsedSec()
    setBaseSecRef.current = duration
    setStartedAtMsRef.current = null
    setSetTime(duration)

    setPendingAfterStop({
      exerciseId: currentExercise.id,
      exerciseName: currentExercise.name,
      setEndedAt: ended,
      setDurationSec: duration,
    })
    setIsSetActive(false)
    setIsResting(true)
    restBaseSecRef.current = 0
    restStartedAtMsRef.current = Date.now()
    setRestTime(0)
    setShowLogForm(true)
    applyExerciseDefaultsForLogging(currentExercise)
  }

  const saveSet = () => {
    if (!pendingAfterStop) return
    const fromPreset = selectedWeight != null
    const fromCustom = customWeight.trim() !== "" && !fromPreset
    const weight = fromPreset
      ? selectedWeight!
      : fromCustom
        ? parseFloat(customWeight)
        : NaN
    const repCount = parseInt(reps, 10)
    if (!Number.isFinite(weight) || weight < 0) return
    if (!Number.isFinite(repCount) || repCount <= 0) return

    const p = pendingAfterStop
    const plannedForThisSet = (() => {
      if (!activeProgram) return null
      const progEx = activeProgram.exercises.find((ex) => ex.exerciseId === p.exerciseId) ?? null
      if (!progEx) return null
      const setIndex0 = sessionLogs.filter((l) => l.exerciseId === p.exerciseId).length
      return progEx.sets[setIndex0] ?? null
    })()
    const setIndex0 = sessionLogs.filter((l) => l.exerciseName === p.exerciseName).length
    const lastSess = findLastExerciseSession(savedWorkoutsList, p.exerciseName)
    const prevMatching = lastSess?.sets[setIndex0]
    const comparison = compareSetToPrevious({ weight, reps: repCount }, prevMatching)

    const tone: "up" | "down" | "same" | "new" = (() => {
      if (!prevMatching) return "new"
      const near = (x: number, y: number) => Math.abs(x - y) < 1e-6
      if (near(weight, prevMatching.weight) && repCount === prevMatching.reps) return "same"
      if (!near(weight, prevMatching.weight)) return weight > prevMatching.weight ? "up" : "down"
      return repCount > prevMatching.reps ? "up" : "down"
    })()

    const prevBest = (() => {
      let best = -Infinity
      for (const w of savedWorkoutsList) {
        for (const g of w.byExercise) {
          if (g.exerciseName !== p.exerciseName) continue
          for (const s of g.sets) {
            const v = s.weight * s.reps
            if (Number.isFinite(v)) best = Math.max(best, v)
          }
        }
      }
      return best
    })()
    const curVol = weight * repCount
    const isPersonalBest = Number.isFinite(curVol) && curVol > prevBest

    const noteTrim = logSetNote.trim()
    setSessionLogs((prev) => [
      ...prev,
      {
        id: `set-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sessionId,
        sessionStartedAt,
        exerciseId: p.exerciseId,
        exerciseName: p.exerciseName,
        weight,
        reps: repCount,
        setEndedAt: p.setEndedAt.toISOString(),
        setDurationSec: p.setDurationSec,
        restBeforeNextSetSec: null,
        ...(noteTrim ? { note: noteTrim } : {}),
      },
    ])
    setLogSetNote("")
    setPendingAfterStop(null)
    setShowLogForm(false)

    const plannedLine =
      plannedForThisSet && (plannedForThisSet.targetWeight != null || plannedForThisSet.targetReps != null)
        ? `Planned: ${plannedForThisSet.targetWeight != null ? `${plannedForThisSet.targetWeight} kg` : "— kg"} × ${plannedForThisSet.targetReps != null ? `${plannedForThisSet.targetReps} reps` : "— reps"}`
        : null
    setPostSaveComparison({
      text: plannedLine ? `${comparison} · ${plannedLine}` : comparison,
      tone,
      isPersonalBest,
    })
    if (postSaveComparisonTimerRef.current) clearTimeout(postSaveComparisonTimerRef.current)
    postSaveComparisonTimerRef.current = setTimeout(() => {
      setPostSaveComparison(null)
      postSaveComparisonTimerRef.current = null
    }, 5000)
  }

  const selectWeight = (weight: number) => {
    setSelectedWeight(weight)
    setCustomWeight("")
    setShowCustomWeight(false)
    if (pendingAfterStop) {
      const nextReps = getSuggestedRepsForWeight(
        pendingAfterStop.exerciseName,
        weight,
        sessionLogs,
        savedWorkoutsList,
      )
      setReps(String(nextReps))
    }
  }

  const handleCustomWeight = (value: string) => {
    setCustomWeight(value)
    setSelectedWeight(null)
    setShowCustomWeight(true)
    if (pendingAfterStop) {
      const w = parseFloat(value)
      if (Number.isFinite(w) && w >= 0) {
        const nextReps = getSuggestedRepsForWeight(
          pendingAfterStop.exerciseName,
          w,
          sessionLogs,
          savedWorkoutsList,
        )
        setReps(String(nextReps))
      }
    }
  }

  const exerciseOrder = useMemo(() => {
    const order: string[] = []
    for (const l of sessionLogs) {
      if (!order.includes(l.exerciseName)) order.push(l.exerciseName)
    }
    return order
  }, [sessionLogs])

  const logsByExercise = useMemo(() => {
    const m = new Map<string, SessionSetLog[]>()
    for (const l of sessionLogs) {
      const list = m.get(l.exerciseName) ?? []
      list.push(l)
      m.set(l.exerciseName, list)
    }
    return m
  }, [sessionLogs])

  const logExercise = pendingAfterStop
    ? exercises.find((e) => e.id === pendingAfterStop.exerciseId) ?? null
    : null

  const applyExerciseDefaultsForLogging = useCallback(
    (exercise: StoredExercise) => {
      const name = exercise.name
      const [w1, w2, w3] = exercise.weights
      const forExercise = sessionLogs.filter((l) => l.exerciseName === name)
      const lastInSession = forExercise.length ? forExercise[forExercise.length - 1] : null
      const setIndex0 = forExercise.length
      const lastSess = findLastExerciseSession(savedWorkoutsList, name)
      const lastTimeThisSet = lastSess?.sets[setIndex0]

      let targetW: number
      if (lastInSession) targetW = lastInSession.weight
      else if (lastTimeThisSet) targetW = lastTimeThisSet.weight
      else targetW = w1

      const near = (x: number, y: number) => Math.abs(x - y) < 1e-6
      let preset: number | null = null
      let customW = ""
      if (near(targetW, w1)) preset = w1
      else if (near(targetW, w2)) preset = w2
      else if (near(targetW, w3)) preset = w3
      else customW = String(Math.round(targetW * 10) / 10)

      setSelectedWeight(preset)
      setCustomWeight(customW)
      setShowCustomWeight(false)
      setShowCustomReps(false)
      const baseReps = getSuggestedRepsForWeight(name, targetW, sessionLogs, savedWorkoutsList)
      setReps(String(baseReps))
      setLogSetNote("")
    },
    [savedWorkoutsList, sessionLogs],
  )

  const finishAndSaveWorkout = useCallback(() => {
    if (showLogForm) {
      if (typeof window !== "undefined") {
        window.alert("Save the current set before finishing the workout.")
      }
      return
    }
    const ended = new Date()
    const order: string[] = []
    const m = new Map<string, SessionSetLog[]>()
    for (const l of sessionLogs) {
      if (!order.includes(l.exerciseName)) order.push(l.exerciseName)
      const list = m.get(l.exerciseName) ?? []
      list.push(l)
      m.set(l.exerciseName, list)
    }
    const byExercise = order.map((name) => ({
      exerciseName: name,
      sets: (m.get(name) ?? []).map((l) => ({
        id: l.id,
        weight: l.weight,
        reps: l.reps,
        setEndedAt: l.setEndedAt,
        setDurationSec: l.setDurationSec,
        restBeforeNextSetSec: l.restBeforeNextSetSec,
        ...(l.note?.trim() ? { note: l.note.trim() } : {}),
      })),
    }))
    const total = Math.max(
      0,
      Math.round((ended.getTime() - new Date(sessionStartedAt).getTime()) / 1000),
    )
    const existingBeforeSave = loadSavedWorkouts()
    const smartName = generateSmartWorkoutName(order, exercises, existingBeforeSave)
    const saved: SavedWorkout = {
      id: newSavedWorkoutId(),
      name: smartName,
      sessionId: sessionId || "session",
      sessionStartedAt,
      sessionEndedAt: ended.toISOString(),
      totalDurationSec: total,
      exercisesPerformed: order,
      byExercise,
    }
    appendSavedWorkout(saved)
    setSummaryWorkout(saved)
    resetWorkoutSession()
    setIsPaused(false)
    setScreen("workoutSummary")
  }, [sessionLogs, sessionId, sessionStartedAt, resetWorkoutSession, showLogForm, exercises])

  const suggestWorkoutName = useCallback((w: SavedWorkout): string | null => {
    const sig = [...(w.exercisesPerformed ?? [])].slice().sort().join("|")
    if (!sig) return null
    for (const other of sortedSavedWorkouts) {
      if (other.id === w.id) continue
      const otherSig = [...(other.exercisesPerformed ?? [])].slice().sort().join("|")
      if (otherSig !== sig) continue
      const n = other.name?.trim()
      if (!n) continue
      if (isAutoDateWorkoutName(n, other.sessionEndedAt)) continue
      if (GENERIC_WORKOUT_NAME_RE.test(n)) continue
      return n
    }
    return null
  }, [sortedSavedWorkouts])

  const persistHistoryWorkout = useCallback((next: SavedWorkout) => {
    replaceSavedWorkout(next)
    setSavedWorkoutsList(loadSavedWorkouts())
    setHistoryDetailWorkout((prev) => (prev?.id === next.id ? next : prev))
  }, [])

  const saveWorkoutAsProgram = useCallback(
    (w: SavedWorkout) => {
      const performed =
        w.exercisesPerformed?.length > 0 ? w.exercisesPerformed : w.byExercise.map((g) => g.exerciseName)
      const groupByName = new Map(w.byExercise.map((g) => [g.exerciseName, g]))
      let nextCatalog = [...exercises]
      const resolveOrCreateExerciseId = (name: string, sampleW: number): string => {
        const found = nextCatalog.find((e) => e.name.trim().toLowerCase() === name.trim().toLowerCase())
        if (found) return found.id
        const id = newExerciseId()
        const w0 = Number.isFinite(sampleW) && sampleW > 0 ? sampleW : 20
        nextCatalog.push({ id, name, weights: [w0, w0, w0] as [number, number, number] })
        return id
      }
      const programExercises: ProgramExercise[] = []
      for (const name of performed) {
        const g = groupByName.get(name)
        if (!g?.sets.length) continue
        const sampleW = g.sets[0]?.weight ?? 0
        const exId = resolveOrCreateExerciseId(name, sampleW)
        programExercises.push({
          id: newProgramItemId(),
          exerciseId: exId,
          exerciseName: name,
          sets: g.sets.map((s) => ({
            id: newProgramItemId(),
            targetWeight: Number.isFinite(s.weight) ? s.weight : null,
            targetReps: Number.isFinite(s.reps) ? s.reps : null,
          })),
        })
      }
      if (programExercises.length === 0) {
        if (typeof window !== "undefined") window.alert("No exercises in this workout to copy.")
        return
      }
      if (nextCatalog.length !== exercises.length) {
        saveExercises(nextCatalog)
        setExercises(nextCatalog)
      }
      const now = new Date().toISOString()
      const prog: Program = {
        id: newProgramId(),
        name: `${savedWorkoutDisplayTitle(w)} program`.slice(0, 120),
        createdAt: now,
        updatedAt: now,
        exercises: programExercises,
      }
      upsertProgram(prog)
      setProgramsList(loadPrograms())
      setEditingProgram(prog)
      setScreen("programEditor")
    },
    [exercises],
  )

  // —— First-time setup (only when there are no saved exercises)
  if (screen === "home" && exercisesReady && exercises.length === 0) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-background p-6">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => {
            setScreen("settings")
            resetDraft()
          }}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
          aria-label="Open settings"
        >
          <Settings className="size-5" />
        </Button>

        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-sm">
          <h1 className="text-xl font-semibold text-foreground">Choose your starter level</h1>
          <p className="mt-1 text-sm text-muted-foreground">Adds a few common exercises with preset weights.</p>
          <div className="mt-4 grid gap-2">
            {([
              { id: "newbie", label: "Newbie" },
              { id: "intermediate", label: "Intermediate" },
              { id: "charles", label: "Charles" },
            ] as const).map((opt) => (
              <Button
                key={opt.id}
                type="button"
                size="lg"
                className="h-14 rounded-2xl text-base font-semibold"
                onClick={() => {
                  // Guard: never overwrite existing exercises
                  if (exercises.length > 0) return
                  saveStarterLevel(opt.id)
                  setExercises(starterExercises(opt.id, newExerciseId))
                }}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            You can edit or delete exercises later in Settings.
          </p>
        </div>
      </div>
    )
  }

  // —— Home
  if (screen === "home") {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-background p-6">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => {
            setScreen("settings")
            resetDraft()
          }}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground"
          aria-label="Open settings"
        >
          <Settings className="size-5" />
        </Button>

        <Button
          type="button"
          onClick={startWorkout}
          size="lg"
          disabled={exercises.length === 0}
          className="h-20 min-w-[16rem] rounded-2xl bg-primary px-10 text-lg font-semibold text-primary-foreground transition-transform active:scale-95 disabled:opacity-40"
        >
          <Play className="mr-2 size-6 shrink-0" />
          Start Workout
        </Button>
        {exercises.length === 0 && (
          <p className="mt-4 max-w-xs text-center text-sm text-muted-foreground">
            Add exercises in settings (the gear above) before you can start.
          </p>
        )}
        <Button
          type="button"
          variant="link"
          onClick={() => setScreen("workoutHistory")}
          className="mt-8 text-sm font-normal text-muted-foreground underline-offset-4 hover:text-foreground"
        >
          Workout History
        </Button>
        <Button
          type="button"
          variant="link"
          onClick={() => setScreen("programs")}
          className="mt-2 text-sm font-normal text-muted-foreground underline-offset-4 hover:text-foreground"
        >
          Programs
        </Button>
      </div>
    )
  }

  // —— Programs (list)
  if (screen === "programs") {
    return (
      <div className="flex min-h-screen flex-col bg-background p-4">
        <header className="mb-4 flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon" onClick={() => setScreen("home")} aria-label="Back to home">
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-lg font-semibold">Programs</h1>
        </header>

        <div className="mx-auto w-full max-w-md space-y-3">
          <Button
            type="button"
            className="h-12 w-full rounded-xl text-base font-semibold"
            onClick={() => {
              const now = new Date().toISOString()
              const p: Program = {
                id: newProgramId(),
                name: "New program",
                createdAt: now,
                updatedAt: now,
                exercises: [],
              }
              setEditingProgram(p)
              setScreen("programEditor")
            }}
          >
            <Plus className="mr-2 size-5" />
            New program
          </Button>

          {programsList.length === 0 ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">No programs yet</p>
          ) : (
            <ul className="space-y-2">
              {programsList.map((p) => (
                <li key={p.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground truncate">{p.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {p.exercises.length} exercise{p.exercises.length === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground"
                        onClick={() => {
                          setEditingProgram(p)
                          setScreen("programEditor")
                        }}
                        aria-label="Edit program"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground"
                        onClick={() => {
                          if (typeof window !== "undefined" && !window.confirm("Delete this program?")) return
                          deleteProgram(p.id)
                          setProgramsList(loadPrograms())
                        }}
                        aria-label="Delete program"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    )
  }

  // —— Program editor (minimal)
  if (screen === "programEditor") {
    if (!editingProgram) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
          <p className="text-sm text-muted-foreground">Program not found.</p>
          <Button type="button" variant="outline" onClick={() => setScreen("programs")}>
            Back to Programs
          </Button>
        </div>
      )
    }
    const p = editingProgram
    return (
      <div className="flex min-h-screen flex-col bg-background p-4">
        <header className="mb-4 flex items-center gap-2">
          <Button type="button" variant="ghost" size="icon" onClick={() => setScreen("programs")} aria-label="Back to programs">
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-lg font-semibold">Edit program</h1>
        </header>

        <div className="mx-auto w-full max-w-md space-y-4 pb-8">
          {showProgramAddExerciseSheet && (
            <div className="absolute inset-0 z-50 flex flex-col justify-end bg-black/30 p-0">
              <button
                type="button"
                className="absolute inset-0 cursor-default"
                aria-label="Close add exercise"
                onClick={() => setShowProgramAddExerciseSheet(false)}
              />
              <div className="relative w-full rounded-t-3xl border border-border bg-card p-4 shadow-xl">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-foreground">Add exercise</h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => setShowProgramAddExerciseSheet(false)}
                  >
                    Close
                  </Button>
                </div>

                <div className="mt-3 space-y-2">
                  <Button
                    type="button"
                    className="h-12 w-full rounded-xl text-base font-semibold"
                    onClick={() => {
                      setShowProgramCreateExercise(true)
                      setProgNewExName("")
                      setProgNewExCategory("Push")
                      setProgNewExW1("")
                      setProgNewExW2("")
                      setProgNewExW3("")
                    }}
                  >
                    <Plus className="mr-2 size-5" />
                    Create New Exercise
                  </Button>
                </div>

                <div className="mt-4 max-h-[55vh] overflow-y-auto pr-1">
                  <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Existing
                  </p>
                  <div className="space-y-2">
                    {exercises.map((ex) => (
                      <Button
                        key={ex.id}
                        type="button"
                        variant="secondary"
                        className="h-12 w-full justify-between rounded-xl px-4"
                        onClick={() => {
                          const newId = newProgramItemId()
                          setEditingProgram({
                            ...p,
                            exercises: [
                              ...p.exercises,
                              {
                                id: newId,
                                exerciseId: ex.id,
                                exerciseName: ex.name,
                                sets: [
                                  { id: newProgramItemId(), targetWeight: null, targetReps: null },
                                  { id: newProgramItemId(), targetWeight: null, targetReps: null },
                                  { id: newProgramItemId(), targetWeight: null, targetReps: null },
                                ],
                              },
                            ],
                          })
                          setLastAddedProgramExerciseId(newId)
                          setShowProgramAddExerciseSheet(false)
                        }}
                      >
                        <span className="font-semibold">{ex.name}</span>
                        <span className="text-xs text-muted-foreground">{ex.category ?? "Unassigned"}</span>
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {showProgramCreateExercise && (
            <div className="absolute inset-0 z-50 flex flex-col justify-end bg-black/30 p-0">
              <button
                type="button"
                className="absolute inset-0 cursor-default"
                aria-label="Close create exercise"
                onClick={() => setShowProgramCreateExercise(false)}
              />
              <div className="relative w-full rounded-t-3xl border border-border bg-card p-4 shadow-xl">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-foreground">Create exercise</h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => setShowProgramCreateExercise(false)}
                  >
                    Close
                  </Button>
                </div>

                <div className="mt-3 space-y-3">
                  <div>
                    <Label className="text-xs text-muted-foreground" htmlFor="prog-new-ex-name">
                      Name
                    </Label>
                    <Input
                      id="prog-new-ex-name"
                      className="mt-1 h-11"
                      value={progNewExName}
                      onChange={(e) => setProgNewExName(e.target.value)}
                      placeholder="Cable Fly"
                    />
                  </div>

                  <div>
                    <p className="text-xs text-muted-foreground">Category</p>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      {(["Push", "Pull", "Legs"] as const).map((c) => (
                        <Button
                          key={c}
                          type="button"
                          variant={progNewExCategory === c ? "default" : "secondary"}
                          className={cn("h-10", progNewExCategory === c && "bg-primary text-primary-foreground")}
                          onClick={() => setProgNewExCategory(c)}
                        >
                          {c}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="text-xs text-muted-foreground">Preset weights (kg)</p>
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.5"
                        placeholder="w1"
                        className="h-11 text-center"
                        value={progNewExW1}
                        onChange={(e) => setProgNewExW1(e.target.value)}
                      />
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.5"
                        placeholder="w2"
                        className="h-11 text-center"
                        value={progNewExW2}
                        onChange={(e) => setProgNewExW2(e.target.value)}
                      />
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.5"
                        placeholder="w3"
                        className="h-11 text-center"
                        value={progNewExW3}
                        onChange={(e) => setProgNewExW3(e.target.value)}
                      />
                    </div>
                  </div>

                  <Button
                    type="button"
                    className="h-12 w-full rounded-xl text-base font-semibold"
                    disabled={
                      !progNewExName.trim() ||
                      [progNewExW1, progNewExW2, progNewExW3].some(
                        (s) => !s.trim() || !Number.isFinite(parseFloat(s)) || parseFloat(s) < 0,
                      )
                    }
                    onClick={() => {
                      const name = progNewExName.trim()
                      const w1 = parseFloat(progNewExW1)
                      const w2 = parseFloat(progNewExW2)
                      const w3 = parseFloat(progNewExW3)
                      if (!name || [w1, w2, w3].some((w) => !Number.isFinite(w) || w < 0)) return

                      const newExId = newExerciseId()
                      const maxOrder = exercises.reduce(
                        (m, e) => (typeof e.order === "number" ? Math.max(m, e.order) : m),
                        0,
                      )
                      setExercises((prev) => [
                        ...prev,
                        {
                          id: newExId,
                          name,
                          category: progNewExCategory,
                          order: maxOrder + 1,
                          weights: [w1, w2, w3] as [number, number, number],
                        },
                      ])

                      const newProgExId = newProgramItemId()
                      setEditingProgram({
                        ...p,
                        exercises: [
                          ...p.exercises,
                          {
                            id: newProgExId,
                            exerciseId: newExId,
                            exerciseName: name,
                            sets: [
                              { id: newProgramItemId(), targetWeight: null, targetReps: null },
                              { id: newProgramItemId(), targetWeight: null, targetReps: null },
                              { id: newProgramItemId(), targetWeight: null, targetReps: null },
                            ],
                          },
                        ],
                      })
                      setLastAddedProgramExerciseId(newProgExId)
                      setShowProgramCreateExercise(false)
                      setShowProgramAddExerciseSheet(false)
                    }}
                  >
                    Save exercise
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <Label htmlFor="prog-name" className="text-xs text-muted-foreground">
              Program name
            </Label>
            <Input
              id="prog-name"
              className="mt-1 h-11"
              value={p.name}
              onChange={(e) => setEditingProgram({ ...p, name: e.target.value })}
            />
          </div>

          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Exercises</h2>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowProgramAddExerciseSheet(true)
                }}
              >
                <Plus className="mr-1 size-4" />
                Add
              </Button>
            </div>

            {p.exercises.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Add exercises to plan your session.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {p.exercises.map((pe, idx) => {
                  const ex = exercises.find((e) => e.id === pe.exerciseId) ?? null
                  const name = ex?.name ?? pe.exerciseName
                  const done = 0
                  return (
                    <div
                      key={pe.id}
                      ref={pe.id === lastAddedProgramExerciseId ? lastAddedProgramExerciseRef : undefined}
                      className="rounded-xl border border-border bg-background/60 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-semibold text-foreground">
                          {idx + 1}. {name}
                        </p>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground"
                            onClick={() => {
                              if (idx === 0) return
                              const next = [...p.exercises]
                              ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
                              setEditingProgram({ ...p, exercises: next })
                            }}
                            aria-label="Move exercise up"
                            disabled={idx === 0}
                          >
                            <ArrowUp className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground"
                            onClick={() => {
                              if (idx === p.exercises.length - 1) return
                              const next = [...p.exercises]
                              ;[next[idx + 1], next[idx]] = [next[idx], next[idx + 1]]
                              setEditingProgram({ ...p, exercises: next })
                            }}
                            aria-label="Move exercise down"
                            disabled={idx === p.exercises.length - 1}
                          >
                            <ArrowDown className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground"
                            onClick={() => setEditingProgram({ ...p, exercises: p.exercises.filter((x) => x.id !== pe.id) })}
                            aria-label="Remove exercise from program"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>

                      <div className="mt-3">
                        <Label className="text-xs text-muted-foreground">Exercise</Label>
                        <Select
                          value={pe.exerciseId}
                          onValueChange={(id) => {
                            const ex2 = exercises.find((e) => e.id === id)
                            setEditingProgram({
                              ...p,
                              exercises: p.exercises.map((x) =>
                                x.id === pe.id ? { ...x, exerciseId: id, exerciseName: ex2?.name ?? x.exerciseName } : x,
                              ),
                            })
                          }}
                        >
                          <SelectTrigger className="mt-1 w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {exercises.map((e) => (
                              <SelectItem key={e.id} value={e.id}>
                                {e.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="mt-3">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Planned sets</p>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setEditingProgram({
                                ...p,
                                exercises: p.exercises.map((x) =>
                                  x.id === pe.id
                                    ? {
                                        ...x,
                                        sets: [...x.sets, { id: newProgramItemId(), targetWeight: null, targetReps: null }],
                                      }
                                    : x,
                                ),
                              })
                            }}
                          >
                            <Plus className="mr-1 size-4" />
                            Add set
                          </Button>
                        </div>

                        {pe.sets.length === 0 ? (
                          <p className="mt-2 text-sm text-muted-foreground">Add planned sets (optional targets).</p>
                        ) : (
                          <div className="mt-2 space-y-2">
                            {pe.sets.map((s, si) => (
                              <div key={s.id} className="rounded-lg border border-border bg-card/60 p-2.5">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-sm font-medium text-foreground">Set {si + 1}</p>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="text-muted-foreground"
                                    onClick={() => {
                                      setEditingProgram({
                                        ...p,
                                        exercises: p.exercises.map((x) =>
                                          x.id === pe.id ? { ...x, sets: x.sets.filter((z) => z.id !== s.id) } : x,
                                        ),
                                      })
                                    }}
                                    aria-label="Remove set"
                                  >
                                    <Trash2 className="size-4" />
                                  </Button>
                                </div>
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                  <div>
                                    <Label className="text-xs text-muted-foreground">Target weight (kg)</Label>
                                    <Input
                                      type="number"
                                      inputMode="decimal"
                                      min={0}
                                      step="0.5"
                                      className="mt-1 h-10"
                                      value={s.targetWeight == null ? "" : String(s.targetWeight)}
                                      onChange={(e) => {
                                        const raw = e.target.value.trim()
                                        const tw = raw === "" ? null : parseFloat(raw)
                                        setEditingProgram({
                                          ...p,
                                          exercises: p.exercises.map((x) =>
                                            x.id === pe.id
                                              ? {
                                                  ...x,
                                                  sets: x.sets.map((z) =>
                                                    z.id === s.id
                                                      ? { ...z, targetWeight: Number.isFinite(tw as any) ? (tw as any) : null }
                                                      : z,
                                                  ),
                                                }
                                              : x,
                                          ),
                                        })
                                      }}
                                    />
                                  </div>
                                  <div>
                                    <Label className="text-xs text-muted-foreground">Target reps</Label>
                                    <Input
                                      type="number"
                                      inputMode="numeric"
                                      min={0}
                                      step="1"
                                      className="mt-1 h-10"
                                      value={s.targetReps == null ? "" : String(s.targetReps)}
                                      onChange={(e) => {
                                        const raw = e.target.value.trim()
                                        const tr = raw === "" ? null : parseInt(raw, 10)
                                        setEditingProgram({
                                          ...p,
                                          exercises: p.exercises.map((x) =>
                                            x.id === pe.id
                                              ? {
                                                  ...x,
                                                  sets: x.sets.map((z) =>
                                                    z.id === s.id
                                                      ? { ...z, targetReps: Number.isFinite(tr as any) ? (tr as any) : null }
                                                      : z,
                                                  ),
                                                }
                                              : x,
                                          ),
                                        })
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {p.exercises.length > 0 ? (
              <Button
                type="button"
                variant="secondary"
                className="mt-4 h-11 w-full rounded-xl"
                onClick={() => {
                  setShowProgramAddExerciseSheet(true)
                }}
              >
                <Plus className="mr-2 size-4" />
                Add exercise
              </Button>
            ) : null}
          </div>

          <Button
            type="button"
            className="h-12 w-full rounded-xl text-base font-semibold"
            onClick={() => {
              upsertProgram(p)
              setProgramsList(loadPrograms())
              setScreen("programs")
            }}
            disabled={!p.name.trim()}
          >
            Save program
          </Button>
        </div>
      </div>
    )
  }

  // —— Choose first exercise (before workout starts)
  if (screen === "chooseFirstExercise") {
    return (
      <div className="flex min-h-screen flex-col bg-background p-4">
        <header className="mb-4 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              // Cancel starting a workout
              resetWorkoutSession()
              setScreen("home")
            }}
            aria-label="Back to home"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-lg font-semibold">Choose first exercise</h1>
        </header>

        <div className="mx-auto w-full max-w-md">
          <div className="no-scrollbar mb-3 flex gap-1 overflow-x-auto">
            {(["All", "Push", "Pull", "Legs"] as const).map((t) => (
              <Button
                key={t}
                type="button"
                variant={workoutTab === t ? "default" : "secondary"}
                size="sm"
                className={cn("h-9 rounded-full px-3 text-xs", workoutTab === t && "bg-primary text-primary-foreground")}
                onClick={() => setWorkoutTab(t)}
              >
                {t}
              </Button>
            ))}
          </div>

          <div className="space-y-4">
            {groupExercisesForUI(exercises)
              .filter((g) => {
                if (workoutTab === "All") return true
                return g.label === workoutTab
              })
              .map((group) => (
                <section key={group.label}>
                  {workoutTab === "All" ? (
                    <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.label === "Unassigned" ? "Unassigned" : group.label}
                    </p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    {group.items.map((ex) => (
                      <Button
                        key={ex.id}
                        type="button"
                        variant="secondary"
                        className="h-12 justify-start rounded-xl px-4 text-left font-semibold"
                        onClick={() => {
                          activateExercise(ex.id)
                          setScreen("workout")
                        }}
                      >
                        {ex.name}
                      </Button>
                    ))}
                  </div>
                </section>
              ))}
          </div>
        </div>
      </div>
    )
  }

  // —— Choose workout mode (Free vs Program)
  if (screen === "chooseWorkoutMode") {
    return (
      <div className="flex min-h-screen flex-col bg-background p-4">
        <header className="mb-4 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              resetWorkoutSession()
              setScreen("home")
            }}
            aria-label="Back to home"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-lg font-semibold">Start workout</h1>
        </header>

        <div className="mx-auto w-full max-w-md space-y-3">
          <Button
            type="button"
            size="lg"
            className="h-14 w-full rounded-2xl text-base font-semibold"
            onClick={() => {
              setActiveProgram(null)
              setScreen("chooseFirstExercise")
            }}
          >
            Free workout
          </Button>

          <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <p className="text-sm font-semibold text-foreground">Start from program</p>
            <p className="mt-1 text-xs text-muted-foreground">Shows the next planned exercise/sets while you train.</p>

            {programsList.length === 0 ? (
              <div className="mt-3">
                <p className="text-sm text-muted-foreground">No programs yet.</p>
                <Button
                  type="button"
                  variant="secondary"
                  className="mt-3 h-11 w-full rounded-xl"
                  onClick={() => setScreen("programs")}
                >
                  Create a program
                </Button>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {programsList.map((p) => (
                  <Button
                    key={p.id}
                    type="button"
                    variant="secondary"
                    className="h-12 w-full justify-between rounded-xl px-4"
                    onClick={() => {
                      setActiveProgram(p)
                      // Start with the first planned exercise if available, otherwise choose manually.
                      const first = p.exercises[0]?.exerciseId
                      if (first) {
                        activateExercise(first)
                        setScreen("workout")
                      } else {
                        setScreen("chooseFirstExercise")
                      }
                    }}
                  >
                    <span className="font-semibold">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{p.exercises.length} ex</span>
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // —— Workout History (list)
  if (screen === "workoutHistory") {
    return (
      <div className="flex min-h-screen flex-col bg-background p-4">
        <header className="mb-4 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              setHistoryDetailWorkout(null)
              setScreen("home")
            }}
            aria-label="Back to home"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-lg font-semibold">Workout History</h1>
        </header>
        {sortedSavedWorkouts.length === 0 ? (
          <p className="mt-12 text-center text-sm text-muted-foreground">No workouts logged yet</p>
        ) : (
          <ul className="mx-auto w-full max-w-md space-y-3">
            {sortedSavedWorkouts.map((w) => (
              <li key={w.id}>
                <div className="w-full rounded-xl border border-border bg-card p-4 text-left shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {historyEditingId === w.id ? (
                        <div className="space-y-2">
                          <Input
                            value={historyDraftName}
                            onChange={(e) => setHistoryDraftName(e.target.value)}
                            className="h-10"
                            placeholder="Workout name"
                          />
                          <div className="flex gap-2">
                            {(() => {
                              const suggestion = suggestWorkoutName(w)
                              return suggestion ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => setHistoryDraftName(suggestion)}
                                >
                                  Use suggestion
                                </Button>
                              ) : null
                            })()}
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => {
                                updateSavedWorkoutName(w.id, historyDraftName)
                                setSavedWorkoutsList(loadSavedWorkouts())
                                setHistoryEditingId(null)
                                setHistoryDraftName("")
                              }}
                            >
                              Save
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setHistoryEditingId(null)
                                setHistoryDraftName("")
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setHistoryDetailWorkout(w)
                            setScreen("workoutHistoryDetail")
                          }}
                          className="w-full text-left"
                        >
                          <p className="text-base font-semibold text-foreground truncate">
                            {savedWorkoutDisplayTitle(w)}
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {formatSessionDate(w.sessionEndedAt)}
                          </p>
                          <p className="mt-0.5 text-sm text-muted-foreground">
                            <span>
                              {formatWorkoutDurationMinutes(
                                Number.isFinite(w.totalDurationSec) ? w.totalDurationSec : 0,
                              )}
                            </span>
                            <span className="mx-1.5">·</span>
                            <span>{savedWorkoutExerciseCount(w)} exercises</span>
                            <span className="mx-1.5">·</span>
                            <span>{savedWorkoutTotalSets(w)} sets</span>
                          </p>
                        </button>
                      )}
                    </div>
                    {historyEditingId !== w.id ? (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground"
                          onClick={() => {
                            setHistoryEditingId(w.id)
                            setHistoryDraftName(w.name?.trim() ? w.name : "")
                          }}
                          aria-label="Rename workout"
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground"
                          onClick={() => saveWorkoutAsProgram(w)}
                          aria-label="Save as program"
                        >
                          <LayoutList className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground"
                          onClick={() => {
                            if (typeof window !== "undefined" && !window.confirm("Delete this workout?")) return
                            deleteSavedWorkout(w.id)
                            setSavedWorkoutsList(loadSavedWorkouts())
                            if (historyDetailWorkout?.id === w.id) {
                              setHistoryDetailWorkout(null)
                              setHistorySetEditSheet(null)
                            }
                          }}
                          aria-label="Delete workout"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="outline"
          className="mx-auto mt-8 w-full max-w-md shrink-0"
          onClick={() => {
            setHistoryDetailWorkout(null)
            setScreen("home")
          }}
        >
          Back to Home
        </Button>
      </div>
    )
  }

  // —— Workout History (saved session detail)
  if (screen === "workoutHistoryDetail") {
    if (!historyDetailWorkout) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
          <p className="text-sm text-muted-foreground">Workout not found.</p>
          <Button type="button" variant="outline" onClick={() => setScreen("workoutHistory")}>
            Back to history
          </Button>
        </div>
      )
    }
    const w = historyDetailWorkout
    return (
      <div className="flex min-h-screen flex-col bg-background p-4">
        <header className="mb-4 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              setHistorySetEditSheet(null)
              setHistoryDetailWorkout(null)
              setScreen("workoutHistory")
            }}
            aria-label="Back to workout history"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-lg font-semibold">Saved workout</h1>
        </header>
        <div className="mx-auto mb-3 w-full max-w-md rounded-xl border border-border bg-card p-3 shadow-sm">
          {historyEditingId === w.id ? (
            <div className="space-y-2">
              <Label htmlFor="workout-name" className="text-xs text-muted-foreground">
                Workout name
              </Label>
              <Input
                id="workout-name"
                value={historyDraftName}
                onChange={(e) => setHistoryDraftName(e.target.value)}
                className="h-10"
                placeholder="Workout name"
              />
              <div className="flex gap-2 flex-wrap">
                {(() => {
                  const suggestion = suggestWorkoutName(w)
                  return suggestion ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setHistoryDraftName(suggestion)}
                    >
                      Use suggestion
                    </Button>
                  ) : null
                })()}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    updateSavedWorkoutName(w.id, historyDraftName)
                    const next = loadSavedWorkouts()
                    setSavedWorkoutsList(next)
                    const updated = next.find((x) => x.id === w.id) ?? null
                    setHistoryDetailWorkout(updated)
                    setHistoryEditingId(null)
                    setHistoryDraftName("")
                  }}
                >
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setHistoryEditingId(null)
                    setHistoryDraftName("")
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold text-foreground truncate">{savedWorkoutDisplayTitle(w)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{formatSessionDate(w.sessionEndedAt)}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {formatWorkoutDurationMinutes(Number.isFinite(w.totalDurationSec) ? w.totalDurationSec : 0)}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  onClick={() => {
                    setHistoryEditingId(w.id)
                    setHistoryDraftName(w.name?.trim() ? w.name : "")
                  }}
                  aria-label="Rename workout"
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  onClick={() => {
                    if (typeof window !== "undefined" && !window.confirm("Delete this workout?")) return
                    deleteSavedWorkout(w.id)
                    const next = loadSavedWorkouts()
                    setSavedWorkoutsList(next)
                    setHistoryDetailWorkout(null)
                    setScreen("workoutHistory")
                  }}
                  aria-label="Delete workout"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="mx-auto w-full max-w-md space-y-1 text-sm text-muted-foreground">
          <p>
            <span className="text-foreground/80">Started</span> {formatSessionDate(w.sessionStartedAt)}
          </p>
          <p>
            <span className="text-foreground/80">Ended</span> {formatSessionDate(w.sessionEndedAt)}
          </p>
          <p>
            <span className="text-foreground/80">Duration</span>{" "}
            {formatWorkoutDurationMinutes(Number.isFinite(w.totalDurationSec) ? w.totalDurationSec : 0)}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="mx-auto mt-4 w-full max-w-md"
          onClick={() => saveWorkoutAsProgram(w)}
        >
          <LayoutList className="mr-2 size-4" />
          Save as Program
        </Button>
        <div className="mx-auto mt-6 w-full max-w-md flex-1 space-y-6 overflow-y-auto pb-8">
          {w.byExercise.map((g) => (
            <section key={g.exerciseName}>
              <h2 className="text-sm font-semibold text-foreground">{g.exerciseName}</h2>
              <ul className="mt-2 space-y-2">
                {g.sets.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="w-full rounded-lg border border-border/80 bg-secondary/30 px-3 py-2.5 text-left text-sm transition-colors hover:bg-secondary/50"
                      onClick={() => {
                        setSetEditPickerTab("All")
                        setHistorySetEditSheet({
                          groupName: g.exerciseName,
                          set: s,
                          phase: "actions",
                          draftW: String(s.weight),
                          draftR: String(s.reps),
                          draftNote: s.note ?? "",
                        })
                      }}
                    >
                      <div className="font-medium text-foreground">
                        {s.weight} kg × {s.reps}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Rest before next:{" "}
                        {s.restBeforeNextSetSec != null ? formatTime(s.restBeforeNextSetSec) : "—"}
                        {typeof s.setDurationSec === "number" && s.setDurationSec > 0 ? (
                          <span> · Set duration {formatTime(s.setDurationSec)}</span>
                        ) : null}
                      </div>
                      {s.note?.trim() ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Note:</span> {s.note.trim()}
                        </p>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        {historySetEditSheet && (
          <div
            className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/40 p-0 sm:items-center sm:justify-center sm:p-4"
            role="dialog"
            aria-modal="true"
          >
            <button
              type="button"
              className="absolute inset-0 cursor-default"
              aria-label="Close"
              onClick={() => setHistorySetEditSheet(null)}
            />
            <div className="relative z-10 mx-auto max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-border bg-card p-4 shadow-xl sm:max-h-[90vh] sm:rounded-2xl">
              {historySetEditSheet.phase === "actions" && (
                <>
                  <p className="text-sm font-semibold text-foreground">Set options</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {historySetEditSheet.groupName} · {historySetEditSheet.set.weight} kg ×{" "}
                    {historySetEditSheet.set.reps}
                  </p>
                  <div className="mt-4 grid gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-11"
                      onClick={() => setHistorySetEditSheet((s) => s && { ...s, phase: "weight" })}
                    >
                      Edit weight
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-11"
                      onClick={() => setHistorySetEditSheet((s) => s && { ...s, phase: "reps" })}
                    >
                      Edit reps
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-11"
                      onClick={() => {
                        setSetEditPickerTab("All")
                        setHistorySetEditSheet((s) => s && { ...s, phase: "exercise" })
                      }}
                    >
                      Change exercise
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="h-11"
                      onClick={() =>
                        setHistorySetEditSheet((s) => s && { ...s, phase: "note", draftNote: s.set.note ?? "" })
                      }
                    >
                      Edit note
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      className="h-11"
                      onClick={() => {
                        if (typeof window !== "undefined" && !window.confirm("Delete this set?")) return
                        const next = deleteSavedSetFromWorkout(
                          w,
                          historySetEditSheet.groupName,
                          historySetEditSheet.set.id,
                        )
                        persistHistoryWorkout(next)
                        setHistorySetEditSheet(null)
                      }}
                    >
                      Delete set
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11"
                      onClick={() => setHistorySetEditSheet(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              )}
              {historySetEditSheet.phase === "weight" && (
                <>
                  <p className="text-sm font-semibold text-foreground">Weight (kg)</p>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.5"
                    className="mt-2 h-11"
                    value={historySetEditSheet.draftW}
                    onChange={(e) => setHistorySetEditSheet((s) => s && { ...s, draftW: e.target.value })}
                  />
                  <div className="mt-4 flex gap-2">
                    <Button
                      type="button"
                      className="flex-1"
                      onClick={() => {
                        const v = parseFloat(historySetEditSheet.draftW)
                        if (!Number.isFinite(v) || v < 0) return
                        const next = updateSavedSetFields(
                          w,
                          historySetEditSheet.groupName,
                          historySetEditSheet.set.id,
                          { weight: v },
                        )
                        persistHistoryWorkout(next)
                        setHistorySetEditSheet(null)
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => setHistorySetEditSheet(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              )}
              {historySetEditSheet.phase === "reps" && (
                <>
                  <p className="text-sm font-semibold text-foreground">Reps</p>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={99}
                    className="mt-2 h-11"
                    value={historySetEditSheet.draftR}
                    onChange={(e) => setHistorySetEditSheet((s) => s && { ...s, draftR: e.target.value })}
                  />
                  <div className="mt-4 flex gap-2">
                    <Button
                      type="button"
                      className="flex-1"
                      onClick={() => {
                        const v = parseInt(historySetEditSheet.draftR, 10)
                        if (!Number.isFinite(v) || v < 1) return
                        const next = updateSavedSetFields(
                          w,
                          historySetEditSheet.groupName,
                          historySetEditSheet.set.id,
                          { reps: v },
                        )
                        persistHistoryWorkout(next)
                        setHistorySetEditSheet(null)
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => setHistorySetEditSheet(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              )}
              {historySetEditSheet.phase === "note" && (
                <>
                  <p className="text-sm font-semibold text-foreground">Note</p>
                  <Textarea
                    placeholder="Add note…"
                    value={historySetEditSheet.draftNote}
                    onChange={(e) => setHistorySetEditSheet((s) => s && { ...s, draftNote: e.target.value })}
                    rows={3}
                    className="mt-2 min-h-[5.5rem] resize-none text-sm"
                  />
                  <div className="mt-4 flex gap-2">
                    <Button
                      type="button"
                      className="flex-1"
                      onClick={() => {
                        const t = historySetEditSheet.draftNote.trim()
                        const next = updateSavedSetFields(w, historySetEditSheet.groupName, historySetEditSheet.set.id, {
                          note: t || undefined,
                        })
                        persistHistoryWorkout(next)
                        setHistorySetEditSheet(null)
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => setHistorySetEditSheet(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              )}
              {historySetEditSheet.phase === "exercise" && (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-foreground">Pick exercise</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setHistorySetEditSheet((s) => s && { ...s, phase: "actions" })}
                    >
                      Back
                    </Button>
                  </div>
                  <div className="no-scrollbar mt-3 flex gap-1 overflow-x-auto">
                    {(["All", "Push", "Pull", "Legs"] as const).map((t) => (
                      <Button
                        key={t}
                        type="button"
                        variant={setEditPickerTab === t ? "default" : "secondary"}
                        size="sm"
                        className={cn(
                          "h-8 rounded-full px-3 text-xs",
                          setEditPickerTab === t && "bg-primary text-primary-foreground",
                        )}
                        onClick={() => setSetEditPickerTab(t)}
                      >
                        {t}
                      </Button>
                    ))}
                  </div>
                  <div className="mt-3 max-h-[45vh] overflow-y-auto pr-1">
                    {groupExercisesForUI(exercises)
                      .filter((g) => (setEditPickerTab === "All" ? true : g.label === setEditPickerTab))
                      .map((group) => (
                        <div key={group.label} className="mb-4">
                          {setEditPickerTab === "All" ? (
                            <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {group.label === "Unassigned" ? "Unassigned" : group.label}
                            </p>
                          ) : null}
                          <div className="space-y-2">
                            {group.items.map((ex) => (
                              <Button
                                key={ex.id}
                                type="button"
                                variant="secondary"
                                className="h-12 w-full justify-start rounded-xl px-4 text-left font-semibold"
                                onClick={() => {
                                  const moved = moveSavedSetToGroup(
                                    w,
                                    historySetEditSheet.groupName,
                                    historySetEditSheet.set.id,
                                    ex.name,
                                  )
                                  if (moved) persistHistoryWorkout(moved)
                                  setHistorySetEditSheet(null)
                                }}
                              >
                                {ex.name}
                              </Button>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          className="mx-auto mt-4 w-full max-w-md"
          onClick={() => {
            setHistorySetEditSheet(null)
            setHistoryDetailWorkout(null)
            setScreen("home")
          }}
        >
          Back to Home
        </Button>
      </div>
    )
  }

  // —— Settings
  if (screen === "settings") {
    const unassigned = exercises.filter((e) => !e.category)
    const grouped = groupExercisesForUI(exercises).filter((g) => g.label !== "Unassigned")
    return (
      <div className="flex min-h-screen flex-col bg-background p-4">
        <header className="mb-4 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={returnFromSettingsToHome}
            aria-label="Back to home"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-lg font-semibold">Exercises</h1>
        </header>

        <div className="mx-auto mb-6 w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-foreground">Theme</h2>
          <p className="mt-1 text-xs text-muted-foreground">Light is the default. Dark is available for low light.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={theme === "light" ? "default" : "secondary"}
              className={cn(theme === "light" && "bg-primary text-primary-foreground")}
              onClick={() => setTheme("light")}
            >
              Light
            </Button>
            <Button
              type="button"
              variant={theme === "dark" ? "default" : "secondary"}
              className={cn(theme === "dark" && "bg-primary text-primary-foreground")}
              onClick={() => setTheme("dark")}
            >
              Dark
            </Button>
          </div>
        </div>

        <div className="mx-auto mb-6 w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-foreground">Backup</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Export or import all local data (exercises, workouts, programs, theme, starter level) as one JSON file.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="secondary"
              className="h-11"
              onClick={() => {
                if (typeof window === "undefined") return
                downloadFitlogExportJson()
              }}
            >
              Export JSON
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => importBackupInputRef.current?.click()}
            >
              Import JSON
            </Button>
          </div>
          <input
            ref={importBackupInputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-hidden
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (!file || typeof window === "undefined") return
              try {
                const text = await file.text()
                const parsed: unknown = JSON.parse(text)
                const { applied, theme: importedTheme } = applyFitlogImport(parsed)
                setExercises(loadExercises())
                setSavedWorkoutsList(loadSavedWorkouts())
                setProgramsList(loadPrograms())
                if (importedTheme) setTheme(importedTheme)
                window.alert(
                  applied.length
                    ? `Restored: ${applied.join(", ")}.`
                    : "No recognized fields in that file (nothing was changed).",
                )
              } catch {
                window.alert("Could not read or parse that file.")
              }
            }}
          />
        </div>

        <div className="mx-auto w-full max-w-md space-y-3 rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground">
            Set a name and three preset weights (kg) for this exercise.
          </p>
          <div className="space-y-2">
            <Label htmlFor="ex-name">Name</Label>
            <Input
              id="ex-name"
              placeholder="Bicep Curl"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label htmlFor="w1" className="text-xs">
                Preset 1 (kg)
              </Label>
              <Input
                id="w1"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.5"
                placeholder="10"
                value={draftW1}
                onChange={(e) => setDraftW1(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="w2" className="text-xs">
                Preset 2
              </Label>
              <Input
                id="w2"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.5"
                placeholder="15"
                value={draftW2}
                onChange={(e) => setDraftW2(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="w3" className="text-xs">
                Preset 3
              </Label>
              <Input
                id="w3"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.5"
                placeholder="18"
                value={draftW3}
                onChange={(e) => setDraftW3(e.target.value)}
              />
            </div>
          </div>
          <Button
            type="button"
            onClick={addExercise}
            className="w-full"
            disabled={
              !draftName.trim() ||
              [draftW1, draftW2, draftW3].some(
                (s) => !s.trim() || !Number.isFinite(parseFloat(s)) || parseFloat(s) < 0,
              )
            }
          >
            Save exercise
          </Button>
        </div>

        <div className="mx-auto mt-6 w-full max-w-md">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Manage exercises</h2>
          {exercises.length === 0 ? (
            <p className="text-sm text-muted-foreground">No exercises yet.</p>
          ) : (
            <div className="space-y-4">
              {unassigned.length ? (
                <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unassigned</p>
                    <p className="text-xs text-muted-foreground">{unassigned.length}</p>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    New exercises start here. Assign Push / Pull / Legs.
                  </p>
                  <ul className="mt-3 space-y-2">
                    {unassigned.map((e) => (
                      <li
                        key={e.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{e.name}</p>
                          <p className="text-xs text-muted-foreground">{e.weights.map((w) => `${w} kg`).join(" · ")}</p>
                          <div className="mt-2 grid grid-cols-3 gap-2">
                            {(["Push", "Pull", "Legs"] as const).map((c) => (
                              <Button
                                key={c}
                                type="button"
                                variant="secondary"
                                className="h-9"
                                onClick={() => {
                                  setExercises((prev) =>
                                    prev.map((x) => (x.id === e.id ? { ...x, category: c } : x)),
                                  )
                                }}
                              >
                                {c}
                              </Button>
                            ))}
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0 text-muted-foreground"
                          onClick={() => removeExercise(e.id)}
                          aria-label={`Remove ${e.name}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {(["Push", "Pull", "Legs"] as const).map((cat) => {
                const group = grouped.find((g) => g.label === cat)
                const items = group?.items ?? []
                const open = manageExpanded[cat]
                return (
                  <section key={cat} className="rounded-xl border border-border bg-card p-3 shadow-sm">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2"
                      onClick={() => setManageExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }))}
                    >
                      <div className="flex items-center gap-2">
                        {open ? (
                          <ChevronDown className="size-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-4 text-muted-foreground" />
                        )}
                        <p className="text-sm font-semibold text-foreground">{cat}</p>
                      </div>
                      <p className="text-xs text-muted-foreground">{items.length}</p>
                    </button>

                    {open ? (
                      items.length ? (
                        <ul className="mt-3 space-y-2">
                          {items.map((e, i) => (
                            <li
                              key={e.id}
                              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="font-medium truncate">{e.name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {e.weights.map((w) => `${w} kg`).join(" · ")}
                                </p>
                                <div className="mt-2">
                                  <Select
                                    value={categoryToSelectValue(e.category)}
                                    onValueChange={(v) => {
                                      const category = v === "Push" || v === "Pull" || v === "Legs" ? v : e.category
                                      setExercises((prev) =>
                                        prev.map((x) => (x.id === e.id ? { ...x, category } : x)),
                                      )
                                    }}
                                  >
                                    <SelectTrigger size="sm" className="w-full max-w-[10.5rem]">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="Push">Push</SelectItem>
                                      <SelectItem value="Pull">Pull</SelectItem>
                                      <SelectItem value="Legs">Legs</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="text-muted-foreground"
                                  onClick={() => {
                                    setEditingExerciseId(e.id)
                                    setEditExName(e.name)
                                    setEditExCategory(e.category ?? "")
                                    setEditExW1(String(e.weights[0]))
                                    setEditExW2(String(e.weights[1]))
                                    setEditExW3(String(e.weights[2]))
                                  }}
                                  aria-label={`Edit ${e.name}`}
                                >
                                  <Pencil className="size-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="text-muted-foreground"
                                  onClick={() => moveExerciseInGroup(e.id, -1)}
                                  aria-label={`Move ${e.name} up`}
                                  disabled={i === 0}
                                >
                                  <ArrowUp className="size-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="text-muted-foreground"
                                  onClick={() => moveExerciseInGroup(e.id, 1)}
                                  aria-label={`Move ${e.name} down`}
                                  disabled={i === items.length - 1}
                                >
                                  <ArrowDown className="size-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="text-muted-foreground"
                                  onClick={() => removeExercise(e.id)}
                                  aria-label={`Remove ${e.name}`}
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-3 text-sm text-muted-foreground">No exercises yet.</p>
                      )
                    ) : null}
                  </section>
                )
              })}
            </div>
          )}
        </div>

        {editingExerciseId && (
          <div className="absolute inset-0 z-50 flex flex-col justify-end bg-black/30 p-0">
            <button
              type="button"
              className="absolute inset-0 cursor-default"
              aria-label="Close exercise editor"
              onClick={() => setEditingExerciseId(null)}
            />
            <div className="relative w-full rounded-t-3xl border border-border bg-card p-4 shadow-xl">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-foreground">Edit exercise</h2>
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setEditingExerciseId(null)}>
                  Close
                </Button>
              </div>
              <div className="mt-3 space-y-3">
                <div>
                  <Label className="text-xs text-muted-foreground" htmlFor="edit-ex-name">Name</Label>
                  <Input id="edit-ex-name" className="mt-1 h-11" value={editExName} onChange={(e) => setEditExName(e.target.value)} />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Category</Label>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {(["Push","Pull","Legs"] as const).map((c) => (
                      <Button key={c} type="button" variant={editExCategory===c ? "default":"secondary"} className={cn("h-10", editExCategory===c && "bg-primary text-primary-foreground")} onClick={() => setEditExCategory(c)}>
                        {c}
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Preset weights (kg)</Label>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <Input type="number" inputMode="decimal" min={0} step="0.5" className="h-11 text-center" value={editExW1} onChange={(e)=>setEditExW1(e.target.value)} />
                    <Input type="number" inputMode="decimal" min={0} step="0.5" className="h-11 text-center" value={editExW2} onChange={(e)=>setEditExW2(e.target.value)} />
                    <Input type="number" inputMode="decimal" min={0} step="0.5" className="h-11 text-center" value={editExW3} onChange={(e)=>setEditExW3(e.target.value)} />
                  </div>
                </div>
                <Button
                  type="button"
                  className="h-12 w-full rounded-xl text-base font-semibold"
                  onClick={() => {
                    const name = editExName.trim()
                    const w1 = parseFloat(editExW1)
                    const w2 = parseFloat(editExW2)
                    const w3 = parseFloat(editExW3)
                    if (!name || [w1,w2,w3].some((w)=>!Number.isFinite(w) || w < 0)) return
                    const category =
                      editExCategory === "Push" || editExCategory === "Pull" || editExCategory === "Legs"
                        ? editExCategory
                        : undefined
                    setExercises((prev) =>
                      prev.map((x) =>
                        x.id === editingExerciseId
                          ? { ...x, name, category, weights: [w1, w2, w3] as [number, number, number] }
                          : x,
                      ),
                    )
                    setEditingExerciseId(null)
                  }}
                >
                  Save changes
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // —— Workout summary (after Finish & Save)
  if (screen === "workoutSummary" && summaryWorkout) {
    const w = summaryWorkout
    return (
      <div className="flex min-h-screen flex-col bg-background p-4">
        <h1 className="text-xl font-semibold text-foreground">{savedWorkoutDisplayTitle(w)}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {formatSessionDate(w.sessionEndedAt)} ·{" "}
          {formatWorkoutDurationMinutes(Number.isFinite(w.totalDurationSec) ? w.totalDurationSec : 0)}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">Workout saved on this device.</p>
        <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-border bg-card p-4 text-sm shadow-sm">
          <div>
            <p className="text-xs text-muted-foreground">Ended</p>
            <p className="font-medium">{formatSessionDate(w.sessionEndedAt)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Duration</p>
            <p className="font-medium">
              {formatWorkoutDurationMinutes(Number.isFinite(w.totalDurationSec) ? w.totalDurationSec : 0)}
            </p>
          </div>
          <div className="col-span-2">
            <p className="text-xs text-muted-foreground">Exercises</p>
            <p className="font-medium">{w.exercisesPerformed.length ? w.exercisesPerformed.join(", ") : "—"}</p>
          </div>
        </div>

        <div className="mt-6 flex-1 space-y-5 overflow-y-auto pb-2">
          {w.byExercise.map((g) => (
            <div key={g.exerciseName}>
              <h2 className="text-sm font-semibold text-foreground">{g.exerciseName}</h2>
              <ul className="mt-2 space-y-2">
                {g.sets.map((s) => (
                  <li
                    key={s.id}
                    className="rounded-xl border border-border bg-background/60 px-3 py-2.5 text-left text-sm shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium text-foreground">
                        {s.weight} kg × {s.reps}
                      </div>
                      {(() => {
                        const prev = findLastExerciseSession(savedWorkoutsForInsights, g.exerciseName)
                        const idx = g.sets.findIndex((x) => x.id === s.id)
                        const prevMatch = prev?.sets[idx]
                        const txt = compareSetToPrevious({ weight: s.weight, reps: s.reps }, prevMatch)
                        return (
                          <div className="text-xs text-muted-foreground">{txt}</div>
                        )
                      })()}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Rest: {s.restBeforeNextSetSec != null ? formatTime(s.restBeforeNextSetSec) : "—"}
                    </div>
                    {s.note?.trim() ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Note:</span> {s.note.trim()}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <Button type="button" className="mt-6" size="lg" onClick={dismissSummaryToHome}>
          Done
        </Button>
      </div>
    )
  }

  // —— Workout
  if (screen === "workout" && !currentExercise) {
    return (
      <div className="relative min-h-screen flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <p className="text-muted-foreground">No exercise selected.</p>
        <Button type="button" onClick={openPause}>
          Pause
        </Button>
        {isPaused && (
          <WorkoutPauseOverlay
            onResume={resumeWorkout}
            onFinish={finishAndSaveWorkout}
            onCancel={confirmCancelWorkout}
          />
        )}
      </div>
    )
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      {isSetActive && !isPaused && !showLogForm ? (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black text-white"
          style={{
            minHeight: "100dvh",
            paddingTop: "env(safe-area-inset-top, 0px)",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
            paddingLeft: "env(safe-area-inset-left, 0px)",
            paddingRight: "env(safe-area-inset-right, 0px)",
          }}
        >
          <div className="flex shrink-0 flex-col items-center px-5 pt-2">
            <p className="text-xs font-semibold tracking-[0.35em] text-white/70">IN SET</p>
            <p className="mt-3 text-center text-lg font-semibold text-white/90">
              {currentExercise?.name ?? "Exercise"}
            </p>
          </div>

          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5">
            <p className="text-center font-mono text-7xl font-bold tabular-nums text-white sm:text-8xl">
              {formatTime(setTime)}
            </p>
          </div>

          <div className="mx-auto w-full max-w-xs shrink-0 px-5 pb-2">
            <Button
              type="button"
              onClick={stopSet}
              size="lg"
              className="h-16 w-full rounded-2xl bg-white text-lg font-semibold text-black active:scale-[0.99]"
            >
              <Square className="mr-2 size-6" />
              Stop set
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-2">
        <div className="flex min-w-0 items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={openPause}
            aria-label="End session"
          >
            <ArrowLeft className="size-5" />
          </Button>
          <div className="ml-1 min-w-0 text-sm text-muted-foreground">
            <span>Workout</span>
            {sessionStartedAt ? (
              <span className="ml-2 hidden text-xs sm:inline">· {formatSessionDate(sessionStartedAt)}</span>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={openPause}
          className="shrink-0 gap-1.5"
        >
          <Pause className="size-4" />
          End Session
        </Button>
      </div>

      {/* (Switching UI moved into bottom sheet) */}

      {/* Current exercise header (always visible) */}
      <div className="border-b border-border px-4 py-3">
        <div className="mx-auto w-full max-w-md">
          {activeProgram ? (
            <div className="mb-3 rounded-xl border border-border bg-card px-3 py-3 text-sm shadow-sm">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Program
                </span>
                <span className="truncate text-right text-xs font-medium text-foreground">{activeProgram.name}</span>
              </div>

              {programProgress?.currentPlanned ? (
                <div className="mt-2 space-y-2">
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Current</p>
                    <p className="text-lg font-semibold leading-snug text-foreground">
                      {(() => {
                        const ex = exercises.find((e) => e.id === programProgress.currentPlanned!.exerciseId)
                        return ex?.name ?? programProgress.currentPlanned!.exerciseName
                      })()}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Set {programProgress.currentSetNumber} / {programProgress.currentTotalSets}
                      {programProgress.currentAllSetsDone ? (
                        <span className="ml-1 font-medium text-foreground">· Done</span>
                      ) : null}
                    </p>
                    {!programProgress.currentAllSetsDone ? (
                      <p className="mt-1 text-sm">
                        <span className="text-muted-foreground">Plan </span>
                        <span className="font-semibold tabular-nums text-foreground">
                          {programProgress.currentNextSet?.targetWeight != null
                            ? `${programProgress.currentNextSet.targetWeight} kg`
                            : "— kg"}{" "}
                          ×{" "}
                          {programProgress.currentNextSet?.targetReps != null
                            ? `${programProgress.currentNextSet.targetReps} reps`
                            : "— reps"}
                        </span>
                      </p>
                    ) : null}
                    {currentExerciseLastSet ? (
                      <p className="text-xs text-muted-foreground">
                        Last logged{" "}
                        <span className="font-medium text-foreground">
                          {currentExerciseLastSet.weight} kg × {currentExerciseLastSet.reps}
                        </span>
                      </p>
                    ) : null}
                  </div>

                  {programProgress.nextExercisePreview && !programProgress.sameExerciseAsNext ? (
                    <div className="rounded-lg border border-dashed border-border bg-muted/25 px-2.5 py-2 text-xs">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Next up
                      </p>
                      <p className="mt-0.5 font-semibold text-foreground">
                        {(() => {
                          const nx = programProgress.nextExercisePreview!
                          const ex = exercises.find((e) => e.id === nx.exerciseId)
                          return ex?.name ?? nx.exerciseName
                        })()}
                      </p>
                      <p className="mt-0.5 text-muted-foreground">
                        {programProgress.nextExercisePreview.setsCount} sets · first{" "}
                        <span className="font-medium text-foreground">
                          {programProgress.nextExercisePreview.firstWeight} ×{" "}
                          {programProgress.nextExercisePreview.firstReps}
                        </span>
                      </p>
                    </div>
                  ) : programProgress.sameExerciseAsNext && !programProgress.currentAllSetsDone ? (
                    <p className="text-xs text-muted-foreground">
                      {programProgress.remainingThisExercise} more set
                      {programProgress.remainingThisExercise !== 1 ? "s" : ""} on this exercise.
                    </p>
                  ) : programProgress.currentAllSetsDone && !programProgress.nextExercise ? (
                    <p className="text-xs font-medium text-foreground">Program complete.</p>
                  ) : null}

                  {(() => {
                    const currentId = currentExerciseId
                    const currentPlannedId = programProgress.currentPlanned?.exerciseId ?? null
                    const currentDone = programProgress.currentDone
                    const currentTotal = programProgress.currentPlanned?.sets.length ?? 0
                    const isCurrentComplete =
                      currentPlannedId != null && currentPlannedId === currentId && currentDone >= currentTotal
                    return isCurrentComplete && programProgress.nextExercise ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-9 w-full"
                        onClick={() => activateExercise(programProgress.nextExercise!.exerciseId)}
                      >
                        Go to next exercise
                      </Button>
                    ) : null
                  })()}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Pick an exercise that matches this program to see planned sets.
                </p>
              )}
            </div>
          ) : null}

          <p className="text-center text-2xl font-semibold text-foreground">{currentExercise?.name}</p>
          <p className="mt-1 text-center text-sm text-muted-foreground">
            {currentExerciseLastSet
              ? `Last set: ${currentExerciseLastSet.weight} kg × ${currentExerciseLastSet.reps}`
              : "No sets logged yet"}
          </p>

          {currentExerciseSessionSets.length ? (
            <ul className="mt-3 space-y-1.5 rounded-xl border border-border bg-card px-3 py-2 text-sm shadow-sm">
              {currentExerciseSessionSets.map((s, i) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Set {i + 1}</span>
                  <span className="font-medium text-foreground">
                    {s.weight} kg × {s.reps}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {showSwitchSheet && (
        <div className="absolute inset-0 z-30 flex flex-col justify-end bg-black/30 p-0">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="Close exercise switcher"
            onClick={() => setShowSwitchSheet(false)}
          />
          <div className="relative w-full rounded-t-3xl border border-border bg-card p-4 shadow-xl">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-foreground">Add / Switch exercise</h2>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9"
                  onClick={() => setShowQuickAddExercise(true)}
                  disabled={showLogForm || isPaused}
                >
                  New
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => setShowSwitchSheet(false)}
                >
                  Close
                </Button>
              </div>
            </div>

            <div className="no-scrollbar mt-3 flex gap-1 overflow-x-auto">
              {(["All", "Push", "Pull", "Legs"] as const).map((t) => (
                <Button
                  key={t}
                  type="button"
                  variant={workoutTab === t ? "default" : "secondary"}
                  size="sm"
                  className={cn("h-8 rounded-full px-3 text-xs", workoutTab === t && "bg-primary text-primary-foreground")}
                  onClick={() => setWorkoutTab(t)}
                  disabled={showLogForm || isPaused || showQuickAddExercise}
                >
                  {t}
                </Button>
              ))}
            </div>

            {sessionExerciseIds.length ? (
              <div className="mt-3">
                <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent
                </p>
                <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-1 pb-1">
                  {sessionExerciseIds
                    .map((id) => exercises.find((e) => e.id === id) ?? null)
                    .filter((x): x is StoredExercise => x != null)
                    .map((ex) => (
                      <button
                        key={ex.id}
                        type="button"
                        className={cn(
                          "shrink-0 rounded-full border border-border px-3 py-1 text-xs font-medium",
                          currentExerciseId === ex.id
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background text-muted-foreground",
                        )}
                        onClick={() => {
                          if (showLogForm || isPaused || showQuickAddExercise) return
                          activateExercise(ex.id)
                        }}
                      >
                        {ex.name}
                      </button>
                    ))}
                </div>
              </div>
            ) : null}

            <div className="mt-3 max-h-[55vh] overflow-y-auto pr-1">
              {groupExercisesForUI(exercises)
                .filter((g) => {
                  if (workoutTab === "All") return true
                  return g.label === workoutTab
                })
                .map((group) => (
                  <div key={group.label} className="mb-4">
                    {workoutTab === "All" ? (
                      <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.label === "Unassigned" ? "Unassigned" : group.label}
                      </p>
                    ) : null}
                    <div className="space-y-2">
                      {group.items.map((ex) => (
                        <Button
                          key={ex.id}
                          type="button"
                          variant="secondary"
                          className={cn(
                            "h-12 w-full justify-start rounded-xl px-4 text-left font-semibold",
                            currentExerciseId === ex.id && "bg-primary text-primary-foreground",
                          )}
                          onClick={() => {
                            if (showLogForm || isPaused || showQuickAddExercise) return
                            activateExercise(ex.id)
                          }}
                          disabled={showLogForm || isPaused || showQuickAddExercise}
                        >
                          {ex.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {showQuickAddExercise && (
        <div className="absolute inset-0 z-30 flex flex-col bg-background/98 p-4 pt-6">
          <div className="mx-auto w-full max-w-md rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-foreground">Add exercise</h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setShowQuickAddExercise(false)
                  setQuickAddName("")
                  setQuickAddCategory("Push")
                  setQuickAddW1("")
                  setQuickAddW2("")
                  setQuickAddW3("")
                }}
              >
                Close
              </Button>
            </div>

            <div className="mt-3 space-y-3">
              <div>
                <Label htmlFor="qa-name" className="text-xs text-muted-foreground">
                  Name
                </Label>
                <Input
                  id="qa-name"
                  value={quickAddName}
                  onChange={(e) => setQuickAddName(e.target.value)}
                  placeholder="Cable Fly"
                  className="mt-1 h-11"
                />
              </div>

              <div>
                <p className="text-xs text-muted-foreground">Category</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {(["Push", "Pull", "Legs"] as const).map((c) => (
                    <Button
                      key={c}
                      type="button"
                      variant={quickAddCategory === c ? "default" : "secondary"}
                      className={cn("h-10", quickAddCategory === c && "bg-primary text-primary-foreground")}
                      onClick={() => setQuickAddCategory(c)}
                    >
                      {c}
                    </Button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-xs text-muted-foreground">Preset weights (kg)</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.5"
                    placeholder="w1"
                    value={quickAddW1}
                    onChange={(e) => setQuickAddW1(e.target.value)}
                    className="h-11 text-center"
                  />
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.5"
                    placeholder="w2"
                    value={quickAddW2}
                    onChange={(e) => setQuickAddW2(e.target.value)}
                    className="h-11 text-center"
                  />
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.5"
                    placeholder="w3"
                    value={quickAddW3}
                    onChange={(e) => setQuickAddW3(e.target.value)}
                    className="h-11 text-center"
                  />
                </div>
              </div>

              <Button
                type="button"
                className="mt-2 h-12 w-full rounded-xl text-base font-semibold"
                disabled={
                  !quickAddName.trim() ||
                  [quickAddW1, quickAddW2, quickAddW3].some(
                    (s) => !s.trim() || !Number.isFinite(parseFloat(s)) || parseFloat(s) < 0,
                  )
                }
                onClick={() => {
                  const name = quickAddName.trim()
                  const w1 = parseFloat(quickAddW1)
                  const w2 = parseFloat(quickAddW2)
                  const w3 = parseFloat(quickAddW3)
                  if (!name || [w1, w2, w3].some((w) => !Number.isFinite(w) || w < 0)) return
                  const maxOrder = exercises.reduce((m, e) => (typeof e.order === "number" ? Math.max(m, e.order) : m), 0)
                  const id = newExerciseId()
                  const category =
                    quickAddCategory === "Push" || quickAddCategory === "Pull" || quickAddCategory === "Legs"
                      ? quickAddCategory
                      : undefined
                  setExercises((prev) => [
                    ...prev,
                    { id, name, category, order: maxOrder + 1, weights: [w1, w2, w3] as [number, number, number] },
                  ])
                  setCurrentExerciseId(id)
                  setShowQuickAddExercise(false)
                  setQuickAddName("")
                  setQuickAddCategory("Push")
                  setQuickAddW1("")
                  setQuickAddW2("")
                  setQuickAddW3("")
                }}
              >
                Save exercise
              </Button>
            </div>
          </div>
        </div>
      )}

      {currentExercise && lastSessionForCurrentExercise && !showLogForm && (
        <div className="border-b border-border px-4 py-3">
          <div className="mx-auto w-full max-w-md rounded-xl border border-border bg-card px-3 py-3 shadow-sm">
            <p className="text-xs font-medium text-muted-foreground">
              Last time:{" "}
              <span className="text-foreground">
                {formatShortSessionDay(lastSessionForCurrentExercise.sessionEndedAt)}
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {lastSessionForCurrentExercise.sets.length} set
              {lastSessionForCurrentExercise.sets.length !== 1 ? "s" : ""}
            </p>
            <ul className="mt-2 space-y-1.5 text-sm">
              {lastSessionForCurrentExercise.sets.map((s, i) => (
                <li key={i} className="text-foreground">
                  Set {i + 1}: {s.weight} kg x {s.reps}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div
        className={cn("flex min-h-0 flex-1 flex-col px-4 pt-4", showLogForm && "pointer-events-none select-none opacity-0")}
        aria-hidden={showLogForm}
      >
        <p className="text-center text-xs uppercase tracking-wide text-muted-foreground">Timer</p>
        <p
          className={cn(
            "mt-1 text-center font-mono text-5xl font-bold tabular-nums sm:text-6xl",
            isPaused
              ? "text-muted-foreground"
              : isSetActive
                ? "text-primary"
                : isResting
                  ? "text-orange-400"
                  : "text-foreground",
          )}
        >
          {formatTime(isSetActive ? setTime : restTime)}
        </p>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          {isPaused ? "Paused" : isSetActive ? "Set" : isResting ? "Rest" : "Ready"}
        </p>

        {postSaveComparison && !showLogForm && (
          <div className="mt-4 text-center" role="status" aria-live="polite">
            <p
              className={cn(
                "text-sm font-medium",
                postSaveComparison.tone === "up" && "text-emerald-600 dark:text-emerald-400",
                postSaveComparison.tone === "down" && "text-rose-600 dark:text-rose-400",
                (postSaveComparison.tone === "same" || postSaveComparison.tone === "new") &&
                  "text-muted-foreground",
              )}
            >
              {postSaveComparison.text}
            </p>
            {postSaveComparison.isPersonalBest && (
              <p className="mt-1 text-xs font-semibold tracking-wide text-amber-600 drop-shadow-[0_0_6px_rgba(251,191,36,0.35)] dark:text-amber-400">
                NEW PERSONAL BEST
              </p>
            )}
          </div>
        )}

        {isResting && !showLogForm && !isPaused && sessionLogs.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-3 text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              const last = sessionLogs[sessionLogs.length - 1]!
              setRestNoteSheet({ logId: last.id, draft: last.note ?? "" })
            }}
          >
            {sessionLogs[sessionLogs.length - 1]?.note?.trim() ? "Edit note" : "Add note"} (last set)
          </Button>
        ) : null}

        <div className="mt-8 flex w-full max-w-xs flex-col gap-3 self-center">
          {!isSetActive ? (
            <Button
              type="button"
              onClick={startSet}
              size="lg"
              className="h-14 rounded-2xl text-base font-semibold"
              disabled={showLogForm || isPaused}
            >
              <Play className="mr-2 size-5" />
              Start set
            </Button>
          ) : (
            <Button
              type="button"
              onClick={stopSet}
              size="lg"
              variant="destructive"
              className="h-14 rounded-2xl text-base font-semibold"
            >
              <Square className="mr-2 size-5" />
              Stop set
            </Button>
          )}

          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="h-12 rounded-2xl text-base font-semibold"
            onClick={() => {
              if (showLogForm || isPaused || showQuickAddExercise) return
              setShowSwitchSheet(true)
            }}
            disabled={showLogForm || isPaused || showQuickAddExercise}
          >
            <Plus className="mr-2 size-5" />
            + Add / Switch Exercise
          </Button>
        </div>

        {sessionLogs.length > 0 && (
          <div className="mt-6 w-full max-w-md flex-1 self-center overflow-y-auto pb-6">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-foreground">Session log</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1"
                disabled={showLogForm || sessionLogs.length === 0}
                onClick={() => {
                  if (typeof window === "undefined") return
                  if (!window.confirm("Are you sure you want to undo the last set?")) return
                  setSessionLogs((prev) => (prev.length ? prev.slice(0, -1) : prev))
                }}
              >
                <Undo2 className="size-3.5" />
                Undo last set
              </Button>
            </div>
            {sessionStartedAt && (
              <p className="mb-3 text-xs text-muted-foreground">Started {formatSessionDate(sessionStartedAt)}</p>
            )}
            <div className="space-y-4">
              {exerciseOrder.map((name) => {
                const list = logsByExercise.get(name) ?? []
                return (
                  <div key={name}>
                    <h4 className="mb-1.5 text-sm font-semibold text-foreground">{name}</h4>
                    <ul className="space-y-2 text-sm">
                      {list.map((log) => (
                        <li key={log.id}>
                          <button
                            type="button"
                            className="w-full rounded-lg border border-border/80 bg-secondary/30 px-3 py-2 text-left leading-snug transition-colors hover:bg-secondary/50"
                            onClick={() => {
                              setSetEditPickerTab("All")
                              setSessionSetEditSheet({
                                log,
                                phase: "actions",
                                draftW: String(log.weight),
                                draftR: String(log.reps),
                                draftNote: log.note ?? "",
                              })
                            }}
                          >
                            <div>
                              {log.reps} reps @ {log.weight} kg
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              Set ended {formatClock(log.setEndedAt)} · work {formatTime(log.setDurationSec)}
                              {log.restBeforeNextSetSec != null
                                ? ` · rest before next ${formatTime(log.restBeforeNextSetSec)}`
                                : " · rest before next — (until you start the next set)"}
                            </div>
                            {log.note?.trim() ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">Note:</span> {log.note.trim()}
                              </p>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Logging overlay: rest already running; form does not block the rest timer (Issue 2) */}
      {showLogForm && logExercise && pendingAfterStop && (
        <div
          className="absolute inset-0 z-20 flex flex-col bg-background/98 p-4 pt-6"
          style={{ pointerEvents: "auto" }}
        >
          {showLogChangeExerciseSheet && (
            <div className="absolute inset-0 z-40 flex flex-col justify-end bg-black/30 p-0">
              <button
                type="button"
                className="absolute inset-0 cursor-default"
                aria-label="Close exercise picker"
                onClick={() => setShowLogChangeExerciseSheet(false)}
              />
              <div className="relative w-full rounded-t-3xl border border-border bg-card p-4 shadow-xl">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-foreground">Pick exercise</h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => setShowLogChangeExerciseSheet(false)}
                  >
                    Close
                  </Button>
                </div>

                <div className="no-scrollbar mt-3 flex gap-1 overflow-x-auto">
                  {(["All", "Push", "Pull", "Legs"] as const).map((t) => (
                    <Button
                      key={t}
                      type="button"
                      variant={workoutTab === t ? "default" : "secondary"}
                      size="sm"
                      className={cn(
                        "h-8 rounded-full px-3 text-xs",
                        workoutTab === t && "bg-primary text-primary-foreground",
                      )}
                      onClick={() => setWorkoutTab(t)}
                    >
                      {t}
                    </Button>
                  ))}
                </div>

                <div className="mt-3 max-h-[55vh] overflow-y-auto pr-1">
                  {groupExercisesForUI(exercises)
                    .filter((g) => (workoutTab === "All" ? true : g.label === workoutTab))
                    .map((group) => (
                      <div key={group.label} className="mb-4">
                        {workoutTab === "All" ? (
                          <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {group.label === "Unassigned" ? "Unassigned" : group.label}
                          </p>
                        ) : null}
                        <div className="space-y-2">
                          {group.items.map((ex) => (
                            <Button
                              key={ex.id}
                              type="button"
                              variant="secondary"
                              className="h-12 w-full justify-start rounded-xl px-4 text-left font-semibold"
                              onClick={() => {
                                setPendingAfterStop((prev) =>
                                  prev
                                    ? { ...prev, exerciseId: ex.id, exerciseName: ex.name }
                                    : prev,
                                )
                                setCurrentExerciseId(ex.id)
                                setSessionExerciseIds((prev) =>
                                  prev.includes(ex.id) ? prev : [...prev, ex.id],
                                )
                                applyExerciseDefaultsForLogging(ex)
                                setShowLogChangeExerciseSheet(false)
                              }}
                            >
                              {ex.name}
                            </Button>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}

          <div className="mb-4 flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {isPaused ? "Rest (paused)" : "Rest (running)"}
              </span>
              <span className="font-mono text-xl font-bold tabular-nums text-orange-400">
                {formatTime(restTime)}
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openPause}
              className="shrink-0 gap-1"
            >
              <Pause className="size-4" />
              Pause
            </Button>
          </div>
          <h2 className="mb-1 text-center text-sm text-muted-foreground">Log set</h2>
          <p className="mb-2 text-center text-xl font-semibold">{pendingAfterStop.exerciseName}</p>
          <div className="mb-3 flex justify-center">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-full"
              onClick={() => setShowLogChangeExerciseSheet(true)}
              disabled={isPaused}
            >
              Change exercise
            </Button>
          </div>
          <div className="mb-4 space-y-2 text-sm text-muted-foreground">
            <p className="text-center">
              <span className="text-foreground">Set {pendingLogSetNumber}</span>
              {activeProgram && programProgress?.currentPlanned ? (
                <span className="text-muted-foreground">
                  {" "}
                  / {programProgress.currentPlanned.sets.length}
                </span>
              ) : null}
            </p>
            {activeProgram && programProgress?.currentPlanned ? (
              <div className="grid grid-cols-2 gap-2 text-left text-xs">
                <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Planned</p>
                  <p className="mt-0.5 font-semibold tabular-nums text-foreground">
                    {(() => {
                      const ex = programProgress.currentPlanned
                      const s = ex?.sets[pendingLogSetNumber - 1]
                      const w = s?.targetWeight != null ? `${s.targetWeight} kg` : "—"
                      const r = s?.targetReps != null ? `${s.targetReps} reps` : "—"
                      return `${w} × ${r}`
                    })()}
                  </p>
                </div>
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Your input</p>
                  <p className="mt-0.5 font-semibold tabular-nums text-foreground">
                    {(() => {
                      const w =
                        selectedWeight != null
                          ? `${selectedWeight} kg`
                          : customWeight.trim() !== "" &&
                              Number.isFinite(parseFloat(customWeight)) &&
                              parseFloat(customWeight) >= 0
                            ? `${parseFloat(customWeight)} kg`
                            : "—"
                      const r =
                        reps.trim() !== "" && Number.isFinite(parseInt(reps, 10))
                          ? `${parseInt(reps, 10)} reps`
                          : "—"
                      return `${w} × ${r}`
                    })()}
                  </p>
                </div>
              </div>
            ) : null}
            <div className="space-y-1 text-center text-xs">
              {lastTimeSetMatchingPending ? (
                <p>
                  Last time set {pendingLogSetNumber}:{" "}
                  <span className="font-medium text-foreground">
                    {lastTimeSetMatchingPending.weight} kg × {lastTimeSetMatchingPending.reps}
                  </span>
                </p>
              ) : (
                <p>No matching set from last time</p>
              )}
            </div>
          </div>
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault()
              saveSet()
            }}
          >
            <div className="mb-4">
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Weight</span>
              <div className="grid grid-cols-3 gap-2">
                {logExercise.weights.map((w, i) => (
                  <Button
                    key={i}
                    type="button"
                    variant={selectedWeight === w ? "default" : "secondary"}
                    className={cn(
                      "h-12 rounded-full text-sm font-semibold",
                      selectedWeight === w && "bg-primary text-primary-foreground",
                    )}
                    onClick={() => selectWeight(w)}
                  >
                    {w} kg
                  </Button>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="h-14 w-14 rounded-2xl text-2xl font-bold"
                  onClick={() => {
                    const base =
                      selectedWeight ??
                      (Number.isFinite(parseFloat(customWeight)) ? parseFloat(customWeight) : 0)
                    const next = Math.max(0, Math.round(base - 1))
                    selectWeight(next)
                  }}
                  aria-label="Decrease weight"
                >
                  −
                </Button>

                {!showCustomWeight ? (
                  <div
                    className="px-1 text-center"
                    onClick={() => {
                      const base =
                        selectedWeight ??
                        (Number.isFinite(parseFloat(customWeight)) ? parseFloat(customWeight) : 0)
                      setCustomWeight(String(Math.max(0, Math.round(base))))
                      setSelectedWeight(null)
                      setShowCustomWeight(true)
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label="Enter custom weight"
                  >
                    <div className="text-4xl font-bold tabular-nums text-foreground leading-none">
                      {(() => {
                        const base =
                          selectedWeight ??
                          (Number.isFinite(parseFloat(customWeight)) ? parseFloat(customWeight) : 0)
                        return Math.max(0, Math.round(base))
                      })()}
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground leading-none">kg</div>
                  </div>
                ) : (
                  <Input
                    ref={customWeightInputRef}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="1"
                    placeholder="kg"
                    value={customWeight}
                    onChange={(e) => handleCustomWeight(e.target.value)}
                    onBlur={() => {
                      const w = parseFloat(customWeight)
                      const next = Number.isFinite(w) ? Math.max(0, w) : 0
                      selectWeight(next)
                    }}
                    className="h-14 flex-1 rounded-2xl text-center text-xl font-bold tabular-nums"
                  />
                )}

                <Button
                  type="button"
                  variant="secondary"
                  className="h-14 w-14 rounded-2xl text-2xl font-bold"
                  onClick={() => {
                    const base =
                      selectedWeight ??
                      (Number.isFinite(parseFloat(customWeight)) ? parseFloat(customWeight) : 0)
                    const next = Math.max(0, Math.round(base + 1))
                    selectWeight(next)
                  }}
                  aria-label="Increase weight"
                >
                  +
                </Button>
              </div>
            </div>
            <div className="mb-2">
              <span className="text-sm font-medium text-muted-foreground">Reps</span>
              <div className="mt-2 flex items-center justify-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="h-14 w-14 rounded-2xl text-2xl font-bold"
                  onClick={() => {
                    const n = parseInt(reps, 10)
                    const cur = Number.isFinite(n) ? n : 8
                    const next = Math.max(1, cur - 1)
                    setReps(String(next))
                  }}
                  aria-label="Decrease reps"
                >
                  −
                </Button>
                <div className="px-1 text-center">
                  <div className="text-4xl font-bold tabular-nums text-foreground leading-none">
                    {(() => {
                      const n = parseInt(reps, 10)
                      const cur = Number.isFinite(n) ? n : 8
                      const clamped = Math.min(99, Math.max(1, cur))
                      return clamped
                    })()}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground leading-none">reps</div>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  className="h-14 w-14 rounded-2xl text-2xl font-bold"
                  onClick={() => {
                    const n = parseInt(reps, 10)
                    const cur = Number.isFinite(n) ? n : 8
                    const next = Math.min(99, cur + 1)
                    setReps(String(next))
                  }}
                  aria-label="Increase reps"
                >
                  +
                </Button>
              </div>

              <div className="mt-3">
                {!showCustomReps ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 w-full text-xs text-muted-foreground"
                    onClick={() => setShowCustomReps(true)}
                  >
                    Custom
                  </Button>
                ) : (
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="reps-custom" className="text-xs text-muted-foreground">
                        Custom reps
                      </Label>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-8 px-2 text-xs text-muted-foreground"
                        onClick={() => setShowCustomReps(false)}
                      >
                        Done
                      </Button>
                    </div>
                    <Input
                      ref={repsInputRef}
                      id="reps-custom"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={99}
                      placeholder="Reps"
                      value={reps}
                      onChange={(e) => setReps(e.target.value)}
                      className="mt-1 h-11 text-center text-base"
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4">
              <Label htmlFor="log-set-note" className="text-xs text-muted-foreground">
                Note (optional)
              </Label>
              <Textarea
                id="log-set-note"
                placeholder="Add note…"
                value={logSetNote}
                onChange={(e) => setLogSetNote(e.target.value)}
                rows={2}
                className="mt-1 min-h-[4.5rem] resize-none text-sm"
              />
            </div>
            <Button
              type="submit"
              size="lg"
              className="mt-4 h-12 w-full rounded-xl text-base font-semibold"
              disabled={
                (selectedWeight == null && !customWeight.trim()) ||
                !reps.trim() ||
                !Number.isFinite(parseInt(reps, 10)) ||
                parseInt(reps, 10) < 1
              }
            >
              <Check className="mr-2 size-5" />
              Save set
            </Button>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Set finished at {formatClock(pendingAfterStop.setEndedAt.toISOString())} ({formatTime(pendingAfterStop.setDurationSec)} work)
            </p>
          </form>
        </div>
      )}

      {restNoteSheet && (
        <div
          className="fixed inset-0 z-[61] flex flex-col justify-end bg-black/40 p-0 sm:items-center sm:justify-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="Close"
            onClick={() => setRestNoteSheet(null)}
          />
          <div className="relative z-10 mx-auto w-full max-w-md rounded-t-2xl border border-border bg-card p-4 shadow-xl sm:rounded-2xl">
            <p className="text-sm font-semibold text-foreground">Set note</p>
            <Textarea
              placeholder="Add note…"
              value={restNoteSheet.draft}
              onChange={(e) => setRestNoteSheet((s) => (s ? { ...s, draft: e.target.value } : s))}
              rows={3}
              className="mt-2 min-h-[5.5rem] resize-none text-sm"
            />
            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                className="flex-1"
                onClick={() => {
                  const { logId, draft } = restNoteSheet
                  setSessionLogs((prev) =>
                    prev.map((l) => (l.id === logId ? applyNoteToSessionLog(l, draft) : l)),
                  )
                  setRestNoteSheet(null)
                }}
              >
                Save
              </Button>
              <Button type="button" variant="outline" className="flex-1" onClick={() => setRestNoteSheet(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {sessionSetEditSheet && (
        <div
          className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/40 p-0 sm:items-center sm:justify-center sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="Close"
            onClick={() => setSessionSetEditSheet(null)}
          />
          <div className="relative z-10 mx-auto max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-border bg-card p-4 shadow-xl sm:max-h-[90vh] sm:rounded-2xl">
            {sessionSetEditSheet.phase === "actions" && (
              <>
                <p className="text-sm font-semibold text-foreground">Set options</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {sessionSetEditSheet.log.exerciseName} · {sessionSetEditSheet.log.weight} kg ×{" "}
                  {sessionSetEditSheet.log.reps}
                </p>
                <div className="mt-4 grid gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-11"
                    onClick={() => setSessionSetEditSheet((s) => s && { ...s, phase: "weight" })}
                  >
                    Edit weight
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-11"
                    onClick={() => setSessionSetEditSheet((s) => s && { ...s, phase: "reps" })}
                  >
                    Edit reps
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-11"
                    onClick={() => {
                      setSetEditPickerTab("All")
                      setSessionSetEditSheet((s) => s && { ...s, phase: "exercise" })
                    }}
                  >
                    Change exercise
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-11"
                    onClick={() =>
                      setSessionSetEditSheet((s) => s && { ...s, phase: "note", draftNote: s.log.note ?? "" })
                    }
                  >
                    Edit note
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    className="h-11"
                    onClick={() => {
                      if (typeof window !== "undefined" && !window.confirm("Delete this set?")) return
                      const id = sessionSetEditSheet.log.id
                      setSessionLogs((prev) => prev.filter((l) => l.id !== id))
                      setSessionSetEditSheet(null)
                    }}
                  >
                    Delete set
                  </Button>
                  <Button type="button" variant="outline" className="h-11" onClick={() => setSessionSetEditSheet(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
            {sessionSetEditSheet.phase === "weight" && (
              <>
                <p className="text-sm font-semibold text-foreground">Weight (kg)</p>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.5"
                  className="mt-2 h-11"
                  value={sessionSetEditSheet.draftW}
                  onChange={(e) => setSessionSetEditSheet((s) => s && { ...s, draftW: e.target.value })}
                />
                <div className="mt-4 flex gap-2">
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={() => {
                      const v = parseFloat(sessionSetEditSheet.draftW)
                      if (!Number.isFinite(v) || v < 0) return
                      const id = sessionSetEditSheet.log.id
                      setSessionLogs((prev) => prev.map((l) => (l.id === id ? { ...l, weight: v } : l)))
                      setSessionSetEditSheet(null)
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setSessionSetEditSheet(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
            {sessionSetEditSheet.phase === "reps" && (
              <>
                <p className="text-sm font-semibold text-foreground">Reps</p>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={99}
                  className="mt-2 h-11"
                  value={sessionSetEditSheet.draftR}
                  onChange={(e) => setSessionSetEditSheet((s) => s && { ...s, draftR: e.target.value })}
                />
                <div className="mt-4 flex gap-2">
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={() => {
                      const v = parseInt(sessionSetEditSheet.draftR, 10)
                      if (!Number.isFinite(v) || v < 1) return
                      const id = sessionSetEditSheet.log.id
                      setSessionLogs((prev) => prev.map((l) => (l.id === id ? { ...l, reps: v } : l)))
                      setSessionSetEditSheet(null)
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setSessionSetEditSheet(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
            {sessionSetEditSheet.phase === "note" && (
              <>
                <p className="text-sm font-semibold text-foreground">Note</p>
                <Textarea
                  placeholder="Add note…"
                  value={sessionSetEditSheet.draftNote}
                  onChange={(e) => setSessionSetEditSheet((s) => s && { ...s, draftNote: e.target.value })}
                  rows={3}
                  className="mt-2 min-h-[5.5rem] resize-none text-sm"
                />
                <div className="mt-4 flex gap-2">
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={() => {
                      const id = sessionSetEditSheet.log.id
                      const d = sessionSetEditSheet.draftNote
                      setSessionLogs((prev) =>
                        prev.map((l) => (l.id === id ? applyNoteToSessionLog(l, d) : l)),
                      )
                      setSessionSetEditSheet(null)
                    }}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => setSessionSetEditSheet(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
            {sessionSetEditSheet.phase === "exercise" && (
              <>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">Pick exercise</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSessionSetEditSheet((s) => s && { ...s, phase: "actions" })}
                  >
                    Back
                  </Button>
                </div>
                <div className="no-scrollbar mt-3 flex gap-1 overflow-x-auto">
                  {(["All", "Push", "Pull", "Legs"] as const).map((t) => (
                    <Button
                      key={t}
                      type="button"
                      variant={setEditPickerTab === t ? "default" : "secondary"}
                      size="sm"
                      className={cn(
                        "h-8 rounded-full px-3 text-xs",
                        setEditPickerTab === t && "bg-primary text-primary-foreground",
                      )}
                      onClick={() => setSetEditPickerTab(t)}
                    >
                      {t}
                    </Button>
                  ))}
                </div>
                <div className="mt-3 max-h-[45vh] overflow-y-auto pr-1">
                  {groupExercisesForUI(exercises)
                    .filter((g) => (setEditPickerTab === "All" ? true : g.label === setEditPickerTab))
                    .map((group) => (
                      <div key={group.label} className="mb-4">
                        {setEditPickerTab === "All" ? (
                          <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {group.label === "Unassigned" ? "Unassigned" : group.label}
                          </p>
                        ) : null}
                        <div className="space-y-2">
                          {group.items.map((ex) => (
                            <Button
                              key={ex.id}
                              type="button"
                              variant="secondary"
                              className="h-12 w-full justify-start rounded-xl px-4 text-left font-semibold"
                              onClick={() => {
                                const id = sessionSetEditSheet.log.id
                                setSessionLogs((prev) =>
                                  prev.map((l) =>
                                    l.id === id ? { ...l, exerciseId: ex.id, exerciseName: ex.name } : l,
                                  ),
                                )
                                setSessionSetEditSheet(null)
                              }}
                            >
                              {ex.name}
                            </Button>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {isPaused && (
        <WorkoutPauseOverlay
          onResume={resumeWorkout}
          onFinish={finishAndSaveWorkout}
          onCancel={confirmCancelWorkout}
        />
      )}
    </div>
  )
}
