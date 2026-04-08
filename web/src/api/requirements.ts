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

/** Extract a human-readable message from a FastAPI error response body.
 *  FastAPI returns detail as a plain string for HTTPException, but as an
 *  array of {loc, msg, type} objects for Pydantic validation errors.
 *  Calling String() on that array produces "[object Object]".
 */
function extractDetail(err: unknown, fallback: string): string {
  if (typeof err !== 'object' || err === null || !('detail' in err)) return fallback
  const detail = (err as { detail: unknown }).detail
  if (Array.isArray(detail)) {
    return detail
      .map((d) =>
        typeof d === 'object' && d !== null && 'msg' in d
          ? String((d as { msg: unknown }).msg)
          : JSON.stringify(d),
      )
      .join('; ')
  }
  return String(detail)
}

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
    throw new Error(extractDetail(err, `Create failed (${res.status})`))
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
    throw new Error(extractDetail(err, `Update failed (${res.status})`))
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

export type FilterConfig = {
  status?: string[]
  classification?: string
  discipline?: string[]
  owner?: string
  source_type?: string
  source_document_id?: string
  hierarchy_node_id?: string
  include_descendants?: boolean
  site_id?: string[]
  unit_id?: string[]
  tags?: string[]
  created_date_from?: string
  created_date_to?: string
  modified_date_from?: string
  modified_date_to?: string
}

export async function fetchRequirementsFiltered(
  page = 1,
  pageSize = 50,
  filters: FilterConfig = {},
): Promise<RequirementListResponse> {
  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('page_size', String(pageSize))

  if (filters.status?.length) filters.status.forEach((v) => params.append('status', v))
  if (filters.classification) params.set('classification', filters.classification)
  if (filters.discipline?.length) filters.discipline.forEach((v) => params.append('discipline', v))
  if (filters.owner) params.set('owner', filters.owner)
  if (filters.source_type) params.set('source_type', filters.source_type)
  if (filters.source_document_id) params.set('source_document_id', filters.source_document_id)
  if (filters.hierarchy_node_id) {
    params.set('hierarchy_node_id', filters.hierarchy_node_id)
    params.set('include_descendants', String(filters.include_descendants ?? false))
  }
  if (filters.site_id?.length) filters.site_id.forEach((v) => params.append('site_id', v))
  if (filters.unit_id?.length) filters.unit_id.forEach((v) => params.append('unit_id', v))
  if (filters.tags?.length) filters.tags.forEach((v) => params.append('tags', v))
  if (filters.created_date_from) params.set('created_date_from', filters.created_date_from)
  if (filters.created_date_to) params.set('created_date_to', filters.created_date_to)
  if (filters.modified_date_from) params.set('modified_date_from', filters.modified_date_from)
  if (filters.modified_date_to) params.set('modified_date_to', filters.modified_date_to)

  const res = await fetch(`${BASE}/requirements?${params.toString()}`)
  if (!res.ok) throw new Error(`Failed to load requirements (${res.status})`)
  return res.json() as Promise<RequirementListResponse>
}

export async function fetchAllLinks(): Promise<RequirementLink[]> {
  const res = await fetch(`${BASE}/requirement-links`)
  if (!res.ok) throw new Error(`Failed to load links (${res.status})`)
  return res.json() as Promise<RequirementLink[]>
}

async function _apiError(res: Response, fallback: string): Promise<never> {
  const err = await res.json().catch(() => ({}))
  throw new Error(extractDetail(err, fallback))
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
