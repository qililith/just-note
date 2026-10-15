import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const demoMode = import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === 'true'
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null
export const lastUserKey = 'just-note:last-user'
export const themeKey = 'just-note:theme'

export type RememberedUser = { id: string; email: string }

export function rememberUser(user: User | RememberedUser) {
  const email = 'email' in user && user.email ? user.email : ''
  localStorage.setItem(lastUserKey, JSON.stringify({ id: user.id, email }))
}

export function rememberedUser(): RememberedUser | null {
  try {
    const raw = localStorage.getItem(lastUserKey)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
      return { id: value.id, email: 'email' in value && typeof value.email === 'string' ? value.email : '' }
    }
  } catch { /* Ignore a malformed account hint. */ }
  return null
}

export function forgetUser() {
  localStorage.removeItem(lastUserKey)
}

export function isAuthRejection(error: { name?: string; status?: number; code?: string }) {
  return error.name === 'AuthSessionMissingError' || error.status === 401 || error.status === 403
    || ['user_banned', 'user_not_found', 'session_not_found', 'refresh_token_not_found', 'refresh_token_already_used'].includes(error.code ?? '')
}
