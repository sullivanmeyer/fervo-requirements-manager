/**
 * SourceDocumentDetail
 *
 * Create / edit form for a source document.  For an existing document it also
 * shows:
 *   - An embedded PDF viewer (iframe) if a file has been uploaded
 *   - The extracted text panel with "Create Requirement from Selection"
 *   - The list of requirements already derived from this document
 *
 * The PDF viewer uses a plain <iframe> — modern browsers render PDFs natively.
 * The Vite dev-server proxies /api/* to the API container, so the iframe src
 * can just use a relative /api path.
 */
import { useEffect, useRef, useState } from 'react'
import {
  createSourceDocument,
  fetchSourceDocument,
  pdfDownloadUrl,
  updateSourceDocument,
  uploadPdf,
} from '../api/sourceDocuments'
import type { SourceDocumentDetail as DocDetail } from '../types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCUMENT_TYPES = [
  'Code/Standard',
  'Specification',
  'Technical Report',
  'Drawing',
  'Datasheet',
  'Other',
]

const DISCIPLINES = [
  'Mechanical',
  'Electrical',
  'I&C',
  'Civil/Structural',
  'Process',
  'Fire Protection',
  'General',
]

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface FormState {
  document_id: string
  title: string
  document_type: string
  revision: string
  issuing_organization: string
  disciplines: string[]
}

function emptyForm(): FormState {
  return {
    document_id: '',
    title: '',
    document_type: 'Code/Standard',
    revision: '',
    issuing_organization: '',
    disciplines: [],
  }
}

function formFromDetail(doc: DocDetail): FormState {
  return {
    document_id: doc.document_id,
    title: doc.title,
    document_type: doc.document_type,
    revision: doc.revision ?? '',
    issuing_organization: doc.issuing_organization ?? '',
    disciplines: doc.disciplines ?? [],
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
        {label}
      </label>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  documentId: string | null    // null = creating new
  onSaved: (savedId: string) => void
  onCancel: () => void
  onCreateRequirement: (sourceDocumentId: string, initialStatement: string) => void
  onOpenRequirement: (requirementId: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SourceDocumentDetail({
  documentId,
  onSaved,
  onCancel,
  onCreateRequirement,
  onOpenRequirement,
}: Props) {
  const isNew = documentId === null

  const [doc, setDoc] = useState<DocDetail | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // PDF upload state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  // Which panel is showing: 'viewer' or 'text'
  const [activePanel, setActivePanel] = useState<'viewer' | 'text'>('viewer')

  // -------------------------------------------------------------------------
  // Load on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (isNew) return
    const doLoad = async () => {
      try {
        const d = await fetchSourceDocument(documentId!)
        setDoc(d)
        setForm(formFromDetail(d))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load document')
      } finally {
        setLoading(false)
      }
    }
    void doLoad()
  }, [isNew, documentId])

  // -------------------------------------------------------------------------
  // Field updater
  // -------------------------------------------------------------------------

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const toggleDiscipline = (d: string) => {
    setForm((f) => ({
      ...f,
      disciplines: f.disciplines.includes(d)
        ? f.disciplines.filter((x) => x !== d)
        : [...f.disciplines, d],
    }))
  }

  // -------------------------------------------------------------------------
  // Save metadata
  // -------------------------------------------------------------------------

  const handleSave = async () => {
    if (!form.document_id.trim()) {
      setError('Document ID is required.')
      return
    }
    if (!form.title.trim()) {
      setError('Title is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload = {
        document_id: form.document_id.trim(),
        title: form.title,
        document_type: form.document_type,
        revision: form.revision || undefined,
        issuing_organization: form.issuing_organization || undefined,
        disciplines: form.disciplines.length > 0 ? form.disciplines : undefined,
      }
      let saved: DocDetail
      if (isNew) {
        saved = await createSourceDocument(payload)
      } else {
        saved = await updateSourceDocument(documentId!, payload)
      }
      setDoc(saved)
      setSaving(false)
      onSaved(saved.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      setSaving(false)
    }
  }

  // -------------------------------------------------------------------------
  // PDF upload
  // -------------------------------------------------------------------------

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !documentId) return
    setUploading(true)
    setError(null)
    try {
      const updated = await uploadPdf(documentId, file)
      setDoc(updated)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // -------------------------------------------------------------------------
  // "Create Requirement from Selection"
  // -------------------------------------------------------------------------

  const handleCreateFromSelection = () => {
    if (!documentId) return
    const selection = window.getSelection()?.toString().trim() ?? ''
    onCreateRequirement(documentId, selection)
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        Loading…
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0 flex-wrap">
        <button onClick={onCancel} className="text-sm text-blue-600 hover:underline">
          ← Documents
        </button>
        <span className="text-gray-400">/</span>
        <span className="text-sm font-medium text-gray-700">
          {isNew ? 'Register Document' : (doc?.document_id ?? documentId)}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Body: metadata form on left, PDF/text panel on right */}
      <div className="flex-1 overflow-hidden flex">

        {/* ---------------------------------------------------------------- */}
        {/* Left: metadata form                                               */}
        {/* ---------------------------------------------------------------- */}
        <div className="w-80 shrink-0 border-r border-gray-200 overflow-y-auto bg-white px-5 py-5 space-y-4">
          <Field label="Document ID *">
            {isNew ? (
              <input
                type="text"
                value={form.document_id}
                onChange={(e) => set('document_id', e.target.value)}
                placeholder="ASME B31.3, API 661 7th Ed, etc."
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            ) : (
              <p className="px-3 py-2 text-sm font-mono text-gray-700 bg-gray-50 border border-gray-200 rounded">
                {form.document_id}
              </p>
            )}
            <p className="text-xs text-gray-400 mt-1">
              {isNew
                ? 'The canonical identifier for this document — must be unique.'
                : 'Document ID cannot be changed after creation.'}
            </p>
          </Field>

          <Field label="Title *">
            <input
              type="text"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="Air-Cooled Heat Exchangers for General Refinery Service"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </Field>

          <Field label="Document Type">
            <select
              value={form.document_type}
              onChange={(e) => set('document_type', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
            >
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>

          <Field label="Revision">
            <input
              type="text"
              value={form.revision}
              onChange={(e) => set('revision', e.target.value)}
              placeholder="7th Edition, Rev 2, etc."
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </Field>

          <Field label="Issuing Organization">
            <input
              type="text"
              value={form.issuing_organization}
              onChange={(e) => set('issuing_organization', e.target.value)}
              placeholder="API, ASME, Client, etc."
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </Field>

          <Field label="Disciplines">
            <div className="border border-gray-300 rounded overflow-hidden">
              {DISCIPLINES.map((d) => (
                <label
                  key={d}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-0"
                >
                  <input
                    type="checkbox"
                    checked={form.disciplines.includes(d)}
                    onChange={() => toggleDiscipline(d)}
                    className="rounded"
                  />
                  <span className="text-sm text-gray-700">{d}</span>
                </label>
              ))}
            </div>
          </Field>

          {/* PDF upload — only available after the document is saved */}
          {!isNew && (
            <div className="pt-2 border-t border-gray-100">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                PDF File
              </p>
              {doc?.has_file ? (
                <p className="text-xs text-green-700 mb-2">
                  PDF uploaded — {doc.document_id}.pdf
                </p>
              ) : (
                <p className="text-xs text-gray-400 italic mb-2">No file uploaded yet.</p>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => void handleUpload(e)}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-full px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-50"
              >
                {uploading ? 'Uploading…' : (doc?.has_file ? 'Replace PDF' : 'Upload PDF')}
              </button>
            </div>
          )}

          {/* Linked requirements list */}
          {!isNew && doc && doc.linked_requirements.length > 0 && (
            <div className="pt-2 border-t border-gray-100">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                Derived Requirements ({doc.linked_requirements.length})
              </p>
              <div className="space-y-1">
                {doc.linked_requirements.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => onOpenRequirement(r.id)}
                    className="w-full text-left px-2 py-1.5 bg-gray-50 border border-gray-200 rounded hover:border-blue-300 hover:bg-blue-50 transition-colors"
                  >
                    <span className="font-mono text-xs font-semibold text-blue-700 block">
                      {r.requirement_id}
                    </span>
                    <span className="text-xs text-gray-600 line-clamp-1">{r.title}</span>
                    {r.source_clause && (
                      <span className="text-xs text-gray-400">§ {r.source_clause}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Right: PDF viewer / extracted text (only for existing docs)       */}
        {/* ---------------------------------------------------------------- */}
        {!isNew && (
          <div className="flex-1 flex flex-col overflow-hidden bg-gray-100">
            {/* Panel switcher tabs */}
            <div className="flex border-b border-gray-200 bg-white shrink-0">
              <button
                onClick={() => setActivePanel('viewer')}
                className={`px-4 py-2 text-sm border-b-2 transition-colors ${
                  activePanel === 'viewer'
                    ? 'border-blue-500 text-blue-600 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                PDF Viewer
              </button>
              <button
                onClick={() => setActivePanel('text')}
                className={`px-4 py-2 text-sm border-b-2 transition-colors ${
                  activePanel === 'text'
                    ? 'border-blue-500 text-blue-600 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                Extracted Text
              </button>
              {activePanel === 'text' && doc?.extracted_text && (
                <button
                  onClick={handleCreateFromSelection}
                  className="ml-auto mr-3 my-1.5 px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  title="Highlight text above, then click to pre-populate a new requirement's statement"
                >
                  Create Requirement from Selection
                </button>
              )}
            </div>

            {/* Panel content */}
            <div className="flex-1 overflow-hidden">
              {activePanel === 'viewer' ? (
                doc?.has_file ? (
                  <iframe
                    src={pdfDownloadUrl(documentId!)}
                    className="w-full h-full border-0"
                    title={`${doc.document_id} PDF`}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                    No PDF uploaded yet. Use "Upload PDF" in the panel on the left.
                  </div>
                )
              ) : (
                /* Extracted text panel */
                doc?.extracted_text ? (
                  <div className="h-full overflow-y-auto p-4">
                    <pre className="whitespace-pre-wrap text-xs text-gray-700 font-mono leading-relaxed select-text">
                      {doc.extracted_text}
                    </pre>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                    {doc?.has_file
                      ? 'No text could be extracted from this PDF (it may be a scanned image).'
                      : 'Upload a PDF to extract its text.'}
                  </div>
                )
              )}
            </div>
          </div>
        )}

        {/* For a new document that hasn't been saved yet, show a prompt */}
        {isNew && (
          <div className="flex-1 flex items-center justify-center bg-gray-50 text-gray-400 text-sm">
            Fill in the metadata and save — then you can upload a PDF.
          </div>
        )}
      </div>
    </div>
  )
}
