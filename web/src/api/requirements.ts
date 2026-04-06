import type {
  RequirementCreatePayload,
  RequirementDetail,
  RequirementListResponse,
  RequirementUpdatePayload,
  Site,
  Unit,
} from '../types'

const BASE = '/api'

export async function fetchRequirements(
  page = 1,
  pageSize = 50,
): Promise<RequirementListResponse> {
  const res = await fetch(
    `${BASE}/requirements?page=${page}&page_size=${pageSize}`,
  )
  if (!res.ok) throw new Error(`Failed to load requirements (${res.status})`)
  return res.json() as Promise<RequirementListResponse>
}

export async function fetchRequirement(id: string): Promise<RequirementDetail> {
  const res = await fetch(`${BASE}/requirements/${id}`)
  if (!res.ok) throw new Error(`Failed to load requirement (${res.status})`)
  return res.json() as Promise<RequirementDetail>
}

export async function createRequirement(
  data: RequirementCreatePayload,
): Promise<RequirementDetail> {
  const res = await fetch(`${BASE}/requirements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const detail =
      typeof err === 'object' && err !== null && 'detail' in err
        ? String((err as { detail: unknown }).detail)
        : `Create failed (${res.status})`
    throw new Error(detail)
  }
  return res.json() as Promise<RequirementDetail>
}

export async function updateRequirement(
  id: string,
  data: RequirementUpdatePayload,
): Promise<RequirementDetail> {
  const res = await fetch(`${BASE}/requirements/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const detail =
      typeof err === 'object' && err !== null && 'detail' in err
        ? String((err as { detail: unknown }).detail)
        : `Update failed (${res.status})`
    throw new Error(detail)
  }
  return res.json() as Promise<RequirementDetail>
}

export async function fetchSites(): Promise<Site[]> {
  const res = await fetch(`${BASE}/sites`)
  if (!res.ok) throw new Error(`Failed to load sites (${res.status})`)
  return res.json() as Promise<Site[]>
}

export async function fetchUnits(): Promise<Unit[]> {
  const res = await fetch(`${BASE}/units`)
  if (!res.ok) throw new Error(`Failed to load units (${res.status})`)
  return res.json() as Promise<Unit[]>
}
