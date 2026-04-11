import type { GapAnalysisResult, OrphanRequirement, SearchResults } from '../types'

const BASE = '/api'

export async function globalSearch(q: string): Promise<SearchResults> {
  const res = await fetch(`${BASE}/search?q=${encodeURIComponent(q)}`)
  if (!res.ok) throw new Error(`Search failed (${res.status})`)
  return res.json() as Promise<SearchResults>
}

export async function fetchOrphans(params?: {
  discipline?: string
  status?: string
}): Promise<OrphanRequirement[]> {
  const p = new URLSearchParams()
  if (params?.discipline) p.set('discipline', params.discipline)
  if (params?.status) p.set('status', params.status)
  const res = await fetch(`${BASE}/reports/orphans?${p.toString()}`)
  if (!res.ok) throw new Error(`Failed to load orphan report (${res.status})`)
  return res.json() as Promise<OrphanRequirement[]>
}

export async function fetchGapAnalysis(requirementId: string): Promise<GapAnalysisResult> {
  const res = await fetch(`${BASE}/reports/gaps?requirement_id=${requirementId}`)
  if (!res.ok) throw new Error(`Failed to load gap analysis (${res.status})`)
  return res.json() as Promise<GapAnalysisResult>
}
