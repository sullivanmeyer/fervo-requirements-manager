import type { ConflictRecord } from '../types'

const BASE = '/api'

export async function fetchConflictRecordsForRequirement(requirementId: string): Promise<ConflictRecord[]> {
  const res = await fetch(`${BASE}/conflict-records?requirement_id=${requirementId}`)
  if (!res.ok) throw new Error(`Failed to load conflict records (${res.status})`)
  return res.json() as Promise<ConflictRecord[]>
}

export async function createConflictRecord(data: {
  description: string
  requirement_ids: string[]
  created_by: string
}): Promise<ConflictRecord> {
  const res = await fetch(`${BASE}/conflict-records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const detail = (err as { detail?: unknown }).detail
    throw new Error(typeof detail === 'string' ? detail : `Create failed (${res.status})`)
  }
  return res.json() as Promise<ConflictRecord>
}

export async function updateConflictRecord(
  id: string,
  data: { status?: string; description?: string; resolution_notes?: string },
): Promise<ConflictRecord> {
  const res = await fetch(`${BASE}/conflict-records/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const detail = (err as { detail?: unknown }).detail
    throw new Error(typeof detail === 'string' ? detail : `Update failed (${res.status})`)
  }
  return res.json() as Promise<ConflictRecord>
}

export async function deleteConflictRecord(id: string): Promise<void> {
  const res = await fetch(`${BASE}/conflict-records/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Delete failed (${res.status})`)
}
