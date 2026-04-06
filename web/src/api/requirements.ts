import type {
  RequirementCreatePayload,
  RequirementDetail,
  RequirementLink,
  RequirementListItem,
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

/** Fetch all requirements without pagination — used to populate search dropdowns. */
export async function fetchAllRequirements(): Promise<RequirementListItem[]> {
  // page_size=200 is the API max; for Stage 3 this covers any realistic dataset.
  const res = await fetch(`${BASE}/requirements?page=1&page_size=200`)
  if (!res.ok) throw new Error(`Failed to load requirements (${res.status})`)
  const data = (await res.json()) as RequirementListResponse
  return data.items
}

export async function fetchAllLinks(): Promise<RequirementLink[]> {
  const res = await fetch(`${BASE}/requirement-links`)
  if (!res.ok) throw new Error(`Failed to load links (${res.status})`)
  return res.json() as Promise<RequirementLink[]>
}

async function _apiError(res: Response, fallback: string): Promise<never> {
  const err = await res.json().catch(() => ({}))
  const detail =
    typeof err === 'object' && err !== null && 'detail' in err
      ? String((err as { detail: unknown }).detail)
      : fallback
  throw new Error(detail)
}

export async function addLink(
  parentId: string,
  childId: string,
): Promise<void> {
  const res = await fetch(`${BASE}/requirement-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent_requirement_id: parentId,
      child_requirement_id: childId,
    }),
  })
  if (!res.ok) await _apiError(res, `Failed to add link (${res.status})`)
}

export async function removeLink(
  parentId: string,
  childId: string,
): Promise<void> {
  const res = await fetch(`${BASE}/requirement-links`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent_requirement_id: parentId,
      child_requirement_id: childId,
    }),
  })
  if (!res.ok) await _apiError(res, `Failed to remove link (${res.status})`)
}

export async function fetchSelfDerived(): Promise<{ id: string; requirement_id: string; title: string }> {
  const res = await fetch(`${BASE}/self-derived`)
  if (!res.ok) throw new Error(`Failed to load Self-Derived record (${res.status})`)
  return res.json() as Promise<{ id: string; requirement_id: string; title: string }>
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
