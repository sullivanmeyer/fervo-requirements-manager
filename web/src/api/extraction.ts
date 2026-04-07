import type { DocumentBlock, ExtractionCandidate } from '../types'

const BASE = '/api'

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export async function decomposeDocument(documentId: string): Promise<DocumentBlock[]> {
  const res = await fetch(`${BASE}/source-documents/${documentId}/decompose`, {
    method: 'POST',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail ?? `Decomposition failed (${res.status})`)
  }
  const data = await res.json()
  return data.blocks as DocumentBlock[]
}

export async function fetchBlocks(documentId: string): Promise<DocumentBlock[]> {
  const res = await fetch(`${BASE}/source-documents/${documentId}/blocks`)
  if (!res.ok) throw new Error(`Failed to load blocks (${res.status})`)
  const data = await res.json()
  return data.blocks as DocumentBlock[]
}

export async function updateBlock(
  blockId: string,
  content: string,
): Promise<DocumentBlock> {
  const res = await fetch(`${BASE}/document-blocks/${blockId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail ?? `Update failed (${res.status})`)
  }
  return res.json() as Promise<DocumentBlock>
}

// ---------------------------------------------------------------------------
// Extraction candidates
// ---------------------------------------------------------------------------

export async function extractRequirements(
  documentId: string,
  blockIds?: string[],
): Promise<ExtractionCandidate[]> {
  const res = await fetch(`${BASE}/source-documents/${documentId}/extract-requirements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(blockIds && blockIds.length > 0 ? { block_ids: blockIds } : {}),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail ?? `Extraction failed (${res.status})`)
  }
  const data = await res.json()
  return data.candidates as ExtractionCandidate[]
}

export async function fetchCandidates(documentId: string): Promise<ExtractionCandidate[]> {
  const res = await fetch(`${BASE}/source-documents/${documentId}/candidates`)
  if (!res.ok) throw new Error(`Failed to load candidates (${res.status})`)
  const data = await res.json()
  return data.candidates as ExtractionCandidate[]
}

export async function updateCandidate(
  candidateId: string,
  updates: Partial<Pick<ExtractionCandidate, 'title' | 'statement' | 'source_clause' | 'suggested_classification' | 'suggested_discipline' | 'status'>>,
): Promise<ExtractionCandidate> {
  const res = await fetch(`${BASE}/extraction-candidates/${candidateId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail ?? `Update failed (${res.status})`)
  }
  return res.json() as Promise<ExtractionCandidate>
}

export async function acceptCandidate(
  candidateId: string,
  payload: {
    owner: string
    title?: string
    statement?: string
    classification?: string
    discipline?: string
    hierarchy_node_ids?: string[]
    site_ids?: string[]
    unit_ids?: string[]
    parent_requirement_ids?: string[]
  },
): Promise<{ requirement: { id: string; requirement_id: string; title: string }; candidate: ExtractionCandidate }> {
  const res = await fetch(`${BASE}/extraction-candidates/${candidateId}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail ?? `Accept failed (${res.status})`)
  }
  return res.json()
}
