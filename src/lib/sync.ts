import { demoMode, supabase } from './supabase'

export async function runManualSync(): Promise<boolean> {
  if (demoMode || !supabase || !navigator.onLine) return false
  return false
}
