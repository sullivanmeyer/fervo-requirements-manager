import type { DocumentGraph, DocumentReferenceListItem } from '../types'

const BASE = '/api'

export async function fetchDocumentGraph(): Promise<DocumentGraph> {
  const res = await fetch(`${BASE}/document-references/graph`)
  if (!res.ok) throw new Error('Failed to load document graph')
  return res.json() as Promise<DocumentGraph>
}

export async function fetchOutgoingReferences(documentId: string): Promise<DocumentReferenceListItem[]> {
  const res = await fetch(`${BASE}/source-documents/${documentId}/references`)
  if (!res.ok) throw new Error('Failed to load outgoing references')
  return res.json() as Promise<DocumentReferenceListItem[]>
}

export async function fetchIncomingReferences(documentId: string): Promise<DocumentReferenceListItem[]> {
  const res = await fetch(`${BASE}/source-documents/${documentId}/referenced-by`)
  if (!res.ok) throw new Error('Failed to load incoming references')
  return res.json() as Promise<DocumentReferenceListItem[]>
}

export async function addDocumentReference(
  sourceDocumentId: string,
  referencedDocumentId: string,
  referenceContext?: string,
): Promise<void> {
  const res = await fetch(`${BASE}/document-references`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_document_id: sourceDocumentId,
      referenced_document_id: referencedDocumentId,
      reference_context: referenceContext || null,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail ?? `Failed to add reference (${res.status})`)
  }
}

export async function deleteDocumentReference(refRowId: string): Promise<void> {
  const res = await fetch(`${BASE}/document-references/${refRowId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to remove reference')
}

export async function detectDocumentReferences(
  documentId: string,
): Promise<{ detected: number; stubs_created: number; edges_added: number }> {
  const res = await fetch(`${BASE}/source-documents/${documentId}/detect-references`, {
    method: 'POST',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail ?? `Reference detection failed (${res.status})`)
  }
  return res.json() as Promise<{ detected: number; stubs_created: number; edges_added: number }>
}
