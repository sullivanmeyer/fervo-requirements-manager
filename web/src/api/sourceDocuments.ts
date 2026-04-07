import type { SourceDocumentDetail, SourceDocumentListItem } from '../types'

const BASE = '/api'

function apiError(res: Response): Promise<never> {
  return res.json().catch(() => ({})).then((body) => {
    const msg = body?.detail ?? `HTTP ${res.status}`
    return Promise.reject(new Error(msg))
  })
}

export async function fetchSourceDocuments(): Promise<SourceDocumentListItem[]> {
  const res = await fetch(`${BASE}/source-documents`)
  if (!res.ok) return apiError(res)
  return res.json()
}

export async function fetchSourceDocument(id: string): Promise<SourceDocumentDetail> {
  const res = await fetch(`${BASE}/source-documents/${id}`)
  if (!res.ok) return apiError(res)
  return res.json()
}

export async function createSourceDocument(data: {
  title: string
  document_type: string
  revision?: string
  issuing_organization?: string
  disciplines?: string[]
}): Promise<SourceDocumentDetail> {
  const res = await fetch(`${BASE}/source-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) return apiError(res)
  return res.json()
}

export async function updateSourceDocument(
  id: string,
  data: {
    title?: string
    document_type?: string
    revision?: string
    issuing_organization?: string
    disciplines?: string[]
  },
): Promise<SourceDocumentDetail> {
  const res = await fetch(`${BASE}/source-documents/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) return apiError(res)
  return res.json()
}

export async function uploadPdf(id: string, file: File): Promise<SourceDocumentDetail> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/source-documents/${id}/upload`, {
    method: 'POST',
    body: form,
    // Note: do NOT set Content-Type manually — the browser sets it automatically
    // with the correct multipart boundary when you pass a FormData object.
  })
  if (!res.ok) return apiError(res)
  return res.json()
}

/** Returns the URL to use in an iframe or anchor tag for PDF viewing/download. */
export function pdfDownloadUrl(id: string): string {
  return `${BASE}/source-documents/${id}/download`
}
