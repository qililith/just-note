import { useSyncExternalStore } from 'react'

let pendingSaves = 0
let heldCount = 0
let snapshot = { pending: false, held: false }
const listeners = new Set<() => void>()

function publish() {
  const next = { pending: pendingSaves > 0, held: heldCount > 0 }
  if (next.pending === snapshot.pending && next.held === snapshot.held) return
  snapshot = next
  for (const listener of listeners) listener()
}

export function beginSave() {
  pendingSaves += 1
  publish()
}

export function endSave() {
  pendingSaves = Math.max(0, pendingSaves - 1)
  publish()
}

export function holdInput() {
  heldCount += 1
  publish()
}

export function releaseInput() {
  heldCount = Math.max(0, heldCount - 1)
  publish()
}

export function hasPendingSaves() {
  return pendingSaves > 0
}

export function hasHeldInput() {
  return heldCount > 0
}

export function hasUnsavedWork() {
  return pendingSaves > 0 || heldCount > 0
}

export function useSaveFlags() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
