import type { Attachment } from '../types'

const BASE = 'http://localhost:8000/api'

export async function fetchAttachments(requirementId: string): Promise<Attachment[]> {
  const res = await fetch(`${BASE}/requirements/${requirementId}/attachments`)
  if (!res.ok) throw new Error('Failed to load attachments')
  return res.json() as Promise<Attachment[]>
}

export async function uploadAttachment(
  requirementId: string,
  file: File,
  uploadedBy?: string,
): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file)
  if (uploadedBy) form.append('uploaded_by', uploadedBy)
  const res = await fetch(`${BASE}/requirements/${requirementId}/attachments`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(err.detail ?? 'Upload failed')
  }
  return res.json() as Promise<Attachment>
}

export function attachmentDownloadUrl(attachmentId: string): string {
  return `${BASE}/attachments/${attachmentId}/download`
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  const res = await fetch(`${BASE}/attachments/${attachmentId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete attachment')
}
