import type { FilterConfig } from './requirements'

const BASE = '/api'

export interface SavedFilter {
  id: string
  name: string
  filter_config: FilterConfig
  user_name: string | null
  created_at: string
}

async function apiError(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({}))
  throw new Error((body as { detail?: string }).detail ?? `HTTP ${res.status}`)
}

export async function fetchSavedFilters(userName?: string): Promise<SavedFilter[]> {
  const url = userName
    ? `${BASE}/saved-filters?user_name=${encodeURIComponent(userName)}`
    : `${BASE}/saved-filters`
  const res = await fetch(url)
  if (!res.ok) return apiError(res)
  return res.json()
}

export async function createSavedFilter(
  name: string,
  filterConfig: FilterConfig,
  userName?: string,
): Promise<SavedFilter> {
  const res = await fetch(`${BASE}/saved-filters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, filter_config: filterConfig, user_name: userName ?? null }),
  })
  if (!res.ok) return apiError(res)
  return res.json()
}

export async function deleteSavedFilter(id: string): Promise<void> {
  const res = await fetch(`${BASE}/saved-filters/${id}`, { method: 'DELETE' })
  if (!res.ok) return apiError(res)
}
