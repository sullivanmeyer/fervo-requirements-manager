import type { AncestorNode, BlockView, HierarchyNode } from '../types'

const BASE = '/api'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, options)
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      detail = body.detail ?? detail
    } catch {
      // ignore parse error, keep status message
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

export const fetchHierarchy = (): Promise<HierarchyNode[]> =>
  request('/hierarchy')

export const createNode = (data: {
  name: string
  description?: string
  parent_id?: string | null
  sort_order?: number
  applicable_disciplines?: string[]
}): Promise<HierarchyNode> =>
  request('/hierarchy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })

export const updateNode = (
  id: string,
  data: {
    name?: string
    description?: string | null
    parent_id?: string | null
    sort_order?: number
    applicable_disciplines?: string[] | null
  },
): Promise<HierarchyNode> =>
  request(`/hierarchy/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })

export const archiveNode = (id: string): Promise<HierarchyNode> =>
  request(`/hierarchy/${id}/archive`, { method: 'PATCH' })

export const fetchAncestors = (id: string): Promise<AncestorNode[]> =>
  request(`/hierarchy/${id}/ancestors`)

export const fetchBlockView = (id: string): Promise<BlockView> =>
  request(`/hierarchy/${id}/block-view`)
