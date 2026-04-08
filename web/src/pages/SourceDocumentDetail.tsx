/**
 * SourceDocumentDetail — Stage 7 update
 *
 * Right-panel tabs:
 *   PDF Viewer     — iframe, unchanged from Phase 1
 *   Document Blocks — LLM-decomposed clause tree with extract controls
 *   Extracted Text  — legacy raw text panel (kept for reference)
 *
 * Document Blocks tab:
 *   • "Decompose Document" triggers Gemini decomposition and stores blocks in DB
 *   • Each block shows clause number, type badge, and content
 *   • Blocks can be checked for selective extraction
 *   • "Extract from Selected" / "Extract All" trigger LLM requirement extraction
 *
 * Extraction Candidates panel (below blocks):
 *   • Lists all LLM-proposed requirements for this document
 *   • Accept (one-click), Edit & Accept (inline form), Reject
 *   • Accepted candidates display a link to the created requirement
 */
import { useEffect, useRef, useState } from 'react'
import {
  createSourceDocument,
  fetchSourceDocument,
  fetchSourceDocuments,
  pdfDownloadUrl,
  updateSourceDocument,
  uploadPdf,
} from '../api/sourceDocuments'
import {
  acceptCandidate,
  decomposeDocument,
  extractRequirements,
  fetchBlocks,
  fetchCandidates,
  updateCandidate,
} from '../api/extraction'
import {
  addDocumentReference,
  deleteDocumentReference,
  detectDocumentReferences,
  fetchIncomingReferences,
  fetchOutgoingReferences,
} from '../api/documentReferences'
import type {
  DocumentBlock,
  DocumentReferenceListItem,
  ExtractionCandidate,
  SourceDocumentDetail as DocDetail,
  SourceDocumentListItem,
} from '../types'

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

const BLOCK_TYPE_STYLES: Record<string, string> = {
  heading: 'bg-blue-100 text-blue-700',
  requirement_clause: 'bg-green-100 text-green-700',
  table_row: 'bg-purple-100 text-purple-700',
  informational: 'bg-gray-100 text-gray-600',
  boilerplate: 'bg-gray-50 text-gray-400',
}

const BLOCK_TYPE_LABELS: Record<string, string> = {
  heading: 'Heading',
  requirement_clause: 'Requirement',
  table_row: 'Table',
  informational: 'Info',
  boilerplate: 'Boilerplate',
}

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

function BlockTypeBadge({ type }: { type: string }) {
  const cls = BLOCK_TYPE_STYLES[type] ?? 'bg-gray-100 text-gray-500'
  const label = BLOCK_TYPE_LABELS[type] ?? type
  return (
    <span className={`text-xs font-medium px-1.5 py-0.5 rounded shrink-0 ${cls}`}>
      {label}
    </span>
  )
}

// Candidate status colours
function candidateBorderClass(status: string): string {
  if (status === 'Accepted') return 'border-l-4 border-l-green-400'
  if (status === 'Rejected') return 'border-l-4 border-l-gray-300'
  return 'border-l-4 border-l-blue-300'
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  documentId: string | null
  userName?: string
  onSaved: (savedId: string) => void
  onCancel: () => void
  onCreateRequirement: (sourceDocumentId: string, initialStatement: string) => void
  onOpenRequirement: (requirementId: string) => void
  onViewInNetwork?: (documentId: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SourceDocumentDetail({
  documentId,
  userName = '',
  onSaved,
  onCancel,
  onCreateRequirement,
  onOpenRequirement,
  onViewInNetwork,
}: Props) {
  const isNew = documentId === null

  // Core document state
  const [doc, setDoc] = useState<DocDetail | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // PDF upload
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  // Panel
  const [activePanel, setActivePanel] = useState<'viewer' | 'blocks' | 'text' | 'references'>('viewer')

  // Document blocks
  const [blocks, setBlocks] = useState<DocumentBlock[]>([])
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set())
  const [decomposing, setDecomposing] = useState(false)
  const [blockError, setBlockError] = useState<string | null>(null)
  const [highlightedBlockId, setHighlightedBlockId] = useState<string | null>(null)
  const blockListRef = useRef<HTMLDivElement>(null)

  // Extraction candidates
  const [candidates, setCandidates] = useState<ExtractionCandidate[]>([])
  const [extracting, setExtracting] = useState(false)
  const [candidateError, setCandidateError] = useState<string | null>(null)

  // Document references
  const [outRefs, setOutRefs] = useState<DocumentReferenceListItem[]>([])
  const [inRefs, setInRefs] = useState<DocumentReferenceListItem[]>([])
  const [refError, setRefError] = useState<string | null>(null)
  const [allDocs, setAllDocs] = useState<SourceDocumentListItem[]>([])
  const [addingRef, setAddingRef] = useState(false)
  const [addRefTargetId, setAddRefTargetId] = useState('')
  const [addRefContext, setAddRefContext] = useState('')
  const [savingRef, setSavingRef] = useState(false)
  const [detectingRefs, setDetectingRefs] = useState(false)

  // Inline edit state for "Edit & Accept"
  const [editingCandidateId, setEditingCandidateId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{
    title: string
    statement: string
    classification: string
    discipline: string
  } | null>(null)

  // -------------------------------------------------------------------------
  // Load on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (isNew) return
    const doLoad = async () => {
      try {
        const [d, blks, cands, outgoing, incoming, docs] = await Promise.all([
          fetchSourceDocument(documentId!),
          fetchBlocks(documentId!).catch(() => [] as DocumentBlock[]),
          fetchCandidates(documentId!).catch(() => [] as ExtractionCandidate[]),
          fetchOutgoingReferences(documentId!).catch(() => [] as DocumentReferenceListItem[]),
          fetchIncomingReferences(documentId!).catch(() => [] as DocumentReferenceListItem[]),
          fetchSourceDocuments().catch(() => [] as SourceDocumentListItem[]),
        ])
        setDoc(d)
        setForm(formFromDetail(d))
        setBlocks(blks)
        setCandidates(cands)
        setOutRefs(outgoing)
        setInRefs(incoming)
        setAllDocs(docs)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load document')
      } finally {
        setLoading(false)
      }
    }
    void doLoad()
  }, [isNew, documentId])

  // -------------------------------------------------------------------------
  // Form helpers
  // -------------------------------------------------------------------------

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const toggleDiscipline = (d: string) =>
    setForm((f) => ({
      ...f,
      disciplines: f.disciplines.includes(d)
        ? f.disciplines.filter((x) => x !== d)
        : [...f.disciplines, d],
    }))

  // -------------------------------------------------------------------------
  // Save metadata
  // -------------------------------------------------------------------------

  const handleSave = async () => {
    if (!form.document_id.trim()) { setError('Document ID is required.'); return }
    if (!form.title.trim()) { setError('Title is required.'); return }
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
      const saved = isNew
        ? await createSourceDocument(payload)
        : await updateSourceDocument(documentId!, payload)
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
  // Decomposition
  // -------------------------------------------------------------------------

  const handleDecompose = async () => {
    if (!documentId) return
    setDecomposing(true)
    setBlockError(null)
    try {
      // Kick off decomposition — returns 202 immediately, work runs in background
      await decomposeDocument(documentId)

      // Poll GET /blocks every 5s until blocks appear (Gemini takes 60–120s).
      // Times out after 5 minutes (60 attempts × 5s).
      let attempts = 0
      const MAX_ATTEMPTS = 60
      const poll = async (): Promise<void> => {
        attempts++
        if (attempts > MAX_ATTEMPTS) {
          setBlockError('Decomposition timed out after 5 minutes. Check the server logs and try again.')
          setDecomposing(false)
          return
        }
        const blks = await fetchBlocks(documentId)
        if (blks.length > 0) {
          setBlocks(blks)
          setSelectedBlockIds(new Set())
          setDecomposing(false)
        } else {
          setTimeout(() => void poll(), 5000)
        }
      }
      setTimeout(() => void poll(), 5000)
    } catch (e) {
      setBlockError(e instanceof Error ? e.message : 'Decomposition failed')
      setDecomposing(false)
    }
  }

  // -------------------------------------------------------------------------
  // Block selection
  // -------------------------------------------------------------------------

  const toggleBlock = (id: string) =>
    setSelectedBlockIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const selectAllBlocks = () =>
    setSelectedBlockIds(new Set(blocks.map((b) => b.id)))

  const clearSelection = () => setSelectedBlockIds(new Set())

  const scrollToBlock = (blockId: string) => {
    setActivePanel('blocks')
    setHighlightedBlockId(blockId)
    // Wait a tick for the panel to render, then scroll the block into view
    setTimeout(() => {
      const el = blockListRef.current?.querySelector(`[data-block-id="${blockId}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Clear highlight after 2 seconds
      setTimeout(() => setHighlightedBlockId(null), 2000)
    }, 50)
  }

  // -------------------------------------------------------------------------
  // Extraction
  // -------------------------------------------------------------------------

  const handleExtract = async (selectedOnly: boolean) => {
    if (!documentId) return
    setExtracting(true)
    setCandidateError(null)
    try {
      const blockIds = selectedOnly ? Array.from(selectedBlockIds) : undefined
      const newCands = await extractRequirements(documentId, blockIds)
      setCandidates((prev) => [...prev, ...newCands])
    } catch (e) {
      setCandidateError(e instanceof Error ? e.message : 'Extraction failed')
    } finally {
      setExtracting(false)
    }
  }

  // -------------------------------------------------------------------------
  // Candidate actions
  // -------------------------------------------------------------------------

  const handleReject = async (id: string) => {
    setCandidateError(null)
    try {
      const updated = await updateCandidate(id, { status: 'Rejected' })
      setCandidates((prev) => prev.map((c) => (c.id === id ? updated : c)))
    } catch (e) {
      setCandidateError(e instanceof Error ? e.message : 'Failed to reject')
    }
  }

  const handleRestorePending = async (id: string) => {
    setCandidateError(null)
    try {
      const updated = await updateCandidate(id, { status: 'Pending' })
      setCandidates((prev) => prev.map((c) => (c.id === id ? updated : c)))
    } catch (e) {
      setCandidateError(e instanceof Error ? e.message : 'Failed to restore')
    }
  }

  const startEdit = (c: ExtractionCandidate) => {
    setEditingCandidateId(c.id)
    setEditForm({
      title: c.title,
      statement: c.statement,
      classification: c.suggested_classification ?? 'Requirement',
      discipline: c.suggested_discipline ?? 'General',
    })
  }

  const handleAccept = async (c: ExtractionCandidate, overrides?: {
    title?: string; statement?: string; classification?: string; discipline?: string
  }) => {
    setCandidateError(null)
    try {
      const result = await acceptCandidate(c.id, {
        owner: userName || 'Unknown',
        title: overrides?.title,
        statement: overrides?.statement,
        classification: overrides?.classification,
        discipline: overrides?.discipline,
      })
      setCandidates((prev) =>
        prev.map((x) => (x.id === c.id ? result.candidate : x))
      )
      setEditingCandidateId(null)
      setEditForm(null)
      // Refresh linked requirements list
      if (documentId) {
        fetchSourceDocument(documentId)
          .then(setDoc)
          .catch(() => null)
      }
    } catch (e) {
      setCandidateError(e instanceof Error ? e.message : 'Failed to accept')
    }
  }

  // -------------------------------------------------------------------------
  // Merge selected blocks into a new requirement form
  // -------------------------------------------------------------------------

  const handleMergeBlocks = () => {
    if (!documentId || selectedBlockIds.size < 2) return
    // Preserve document order by sorting by sort_order, not selection order
    const selected = blocks
      .filter((b) => selectedBlockIds.has(b.id))
      .sort((a, b) => a.sort_order - b.sort_order)
    const merged = selected.map((b) => b.content.trim()).join('\n\n')
    onCreateRequirement(documentId, merged)
  }

  // -------------------------------------------------------------------------
  // Legacy: "Create Requirement from Selection"
  // -------------------------------------------------------------------------

  const handleCreateFromSelection = () => {
    if (!documentId) return
    const selection = window.getSelection()?.toString().trim() ?? ''
    onCreateRequirement(documentId, selection)
  }

  // -------------------------------------------------------------------------
  // Document reference actions
  // -------------------------------------------------------------------------

  const handleAddRef = async () => {
    if (!documentId || !addRefTargetId) return
    setSavingRef(true)
    setRefError(null)
    try {
      await addDocumentReference(documentId, addRefTargetId, addRefContext || undefined)
      const [outgoing, incoming] = await Promise.all([
        fetchOutgoingReferences(documentId),
        fetchIncomingReferences(documentId),
      ])
      setOutRefs(outgoing)
      setInRefs(incoming)
      setAddingRef(false)
      setAddRefTargetId('')
      setAddRefContext('')
    } catch (e) {
      setRefError(e instanceof Error ? e.message : 'Failed to add reference')
    } finally {
      setSavingRef(false)
    }
  }

  const handleRemoveRef = async (refRowId: string) => {
    if (!documentId) return
    setRefError(null)
    try {
      await deleteDocumentReference(refRowId)
      setOutRefs((prev) => prev.filter((r) => r.ref_row_id !== refRowId))
    } catch (e) {
      setRefError(e instanceof Error ? e.message : 'Failed to remove reference')
    }
  }

  const handleDetectRefs = async () => {
    if (!documentId) return
    setDetectingRefs(true)
    setRefError(null)
    try {
      const result = await detectDocumentReferences(documentId)
      // Reload outgoing references to show newly detected ones
      const [outgoing, incoming] = await Promise.all([
        fetchOutgoingReferences(documentId),
        fetchIncomingReferences(documentId),
      ])
      setOutRefs(outgoing)
      setInRefs(incoming)
      if (result.edges_added === 0 && result.stubs_created === 0) {
        setRefError(`Detection complete — no new references found (${result.detected} already known).`)
      }
    } catch (e) {
      setRefError(e instanceof Error ? e.message : 'Reference detection failed')
    } finally {
      setDetectingRefs(false)
    }
  }

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const pendingCount = candidates.filter((c) => c.status === 'Pending').length
  const acceptedCount = candidates.filter((c) => c.status === 'Accepted').length
  const rejectedCount = candidates.filter((c) => c.status === 'Rejected').length

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

      {doc?.is_stub && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-sm text-amber-800 flex items-center gap-2">
          <span className="font-semibold">Auto-detected stub.</span>
          This document was detected as a reference but hasn't been fully registered.
          Fill in the metadata below and save to promote it to a full entry.
        </div>
      )}

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Body */}
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
              {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
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

          {/* PDF upload */}
          {!isNew && (
            <div className="pt-2 border-t border-gray-100">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                PDF File
              </p>
              {doc?.has_file ? (
                <p className="text-xs text-green-700 mb-2">PDF uploaded</p>
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
        {/* Right: tab panel (existing docs only)                             */}
        {/* ---------------------------------------------------------------- */}
        {!isNew && (
          <div className="flex-1 flex flex-col overflow-hidden bg-gray-100">

            {/* Tab bar */}
            <div className="flex border-b border-gray-200 bg-white shrink-0">
              {(['viewer', 'blocks', 'text', 'references'] as const).map((panel) => {
                const labels = { viewer: 'PDF Viewer', blocks: 'Document Blocks', text: 'Extracted Text', references: 'References' }
                return (
                  <button
                    key={panel}
                    onClick={() => setActivePanel(panel)}
                    className={`px-4 py-2 text-sm border-b-2 transition-colors ${
                      activePanel === panel
                        ? 'border-blue-500 text-blue-600 font-medium'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {labels[panel]}
                    {panel === 'blocks' && blocks.length > 0 && (
                      <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full">
                        {blocks.length}
                      </span>
                    )}
                    {panel === 'blocks' && candidates.length > 0 && (
                      <span className="ml-1 px-1.5 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">
                        {acceptedCount}/{candidates.length}
                      </span>
                    )}
                    {panel === 'references' && (outRefs.length + inRefs.length) > 0 && (
                      <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-indigo-100 text-indigo-700 rounded-full">
                        {outRefs.length + inRefs.length}
                      </span>
                    )}
                  </button>
                )
              })}
              {/* Legacy quick action on Extracted Text tab */}
              {activePanel === 'text' && doc?.extracted_text && (
                <button
                  onClick={handleCreateFromSelection}
                  className="ml-auto mr-3 my-1.5 px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  title="Highlight text above, then click"
                >
                  Create from Selection
                </button>
              )}
            </div>

            {/* ---- PDF Viewer ---- */}
            {activePanel === 'viewer' && (
              <div className="flex-1 overflow-hidden">
                {doc?.has_file ? (
                  <iframe
                    src={pdfDownloadUrl(documentId!)}
                    className="w-full h-full border-0"
                    title={`${doc.document_id} PDF`}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                    No PDF uploaded yet. Use "Upload PDF" in the panel on the left.
                  </div>
                )}
              </div>
            )}

            {/* ---- Document Blocks ---- */}
            {activePanel === 'blocks' && (
              <div className="flex-1 flex flex-col overflow-hidden">

                {/* Blocks section */}
                <div className={`flex flex-col overflow-hidden ${candidates.length > 0 ? 'flex-[3]' : 'flex-1'}`}>

                  {/* Blocks toolbar */}
                  <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2 shrink-0 flex-wrap">
                    {blocks.length === 0 ? (
                      <>
                        <p className="text-sm text-gray-500 flex-1">
                          {doc?.has_file
                            ? 'Decompose this document into structured blocks for AI extraction.'
                            : 'Upload a PDF first, then decompose it into blocks.'}
                        </p>
                        <button
                          onClick={() => void handleDecompose()}
                          disabled={decomposing || !doc?.has_file}
                          className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                        >
                          {decomposing ? 'Decomposing…' : 'Decompose Document'}
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="text-xs text-gray-500">
                          {blocks.length} blocks
                          {selectedBlockIds.size > 0 && ` · ${selectedBlockIds.size} selected`}
                        </span>
                        <button
                          onClick={selectedBlockIds.size > 0 ? clearSelection : selectAllBlocks}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          {selectedBlockIds.size > 0 ? 'Clear selection' : 'Select all'}
                        </button>
                        <div className="flex-1" />
                        {selectedBlockIds.size >= 2 && (
                          <button
                            onClick={handleMergeBlocks}
                            className="px-3 py-1.5 text-xs border border-purple-300 text-purple-700 rounded hover:bg-purple-50"
                            title="Concatenate selected blocks into a single requirement form"
                          >
                            Merge to Requirement ({selectedBlockIds.size})
                          </button>
                        )}
                        <button
                          onClick={() => void handleExtract(true)}
                          disabled={extracting || selectedBlockIds.size === 0}
                          className="px-3 py-1.5 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-40"
                        >
                          {extracting ? 'Extracting…' : `Extract from Selected (${selectedBlockIds.size})`}
                        </button>
                        <button
                          onClick={() => void handleExtract(false)}
                          disabled={extracting}
                          className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
                        >
                          {extracting ? 'Extracting…' : 'Extract All'}
                        </button>
                        <button
                          onClick={() => void handleDecompose()}
                          disabled={decomposing}
                          className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-40"
                          title="Re-run decomposition (replaces existing blocks)"
                        >
                          {decomposing ? 'Decomposing…' : 'Re-decompose'}
                        </button>
                      </>
                    )}
                  </div>

                  {blockError && (
                    <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 shrink-0">
                      {blockError}
                    </div>
                  )}

                  {/* Block list */}
                  <div className="flex-1 overflow-y-auto" ref={blockListRef}>
                    {decomposing ? (
                      <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm gap-2">
                        <svg className="animate-spin h-5 w-5 text-blue-500" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                        <span>Sending PDF to Gemini for decomposition…</span>
                        <span className="text-xs text-gray-400">This may take 30–90 seconds.</span>
                      </div>
                    ) : blocks.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                        {doc?.has_file
                          ? 'Click "Decompose Document" to begin.'
                          : 'Upload a PDF first.'}
                      </div>
                    ) : (
                      <div className="divide-y divide-gray-100">
                        {blocks.map((block) => {
                          const isSelected = selectedBlockIds.has(block.id)
                          const isBoilerplate = block.block_type === 'boilerplate'
                          return (
                            <div
                              key={block.id}
                              data-block-id={block.id}
                              className={`flex items-start gap-2 px-3 py-2 hover:bg-white cursor-pointer transition-colors ${
                                highlightedBlockId === block.id
                                  ? 'bg-yellow-100 ring-2 ring-inset ring-yellow-400'
                                  : isSelected ? 'bg-blue-50' : ''
                              } ${isBoilerplate ? 'opacity-50' : ''}`}
                              style={{ paddingLeft: `${12 + block.depth * 16}px` }}
                              onClick={() => toggleBlock(block.id)}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleBlock(block.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="mt-0.5 shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                                  {block.clause_number && (
                                    <span className="text-xs font-mono text-gray-500 shrink-0">
                                      {block.clause_number}
                                    </span>
                                  )}
                                  <BlockTypeBadge type={block.block_type} />
                                </div>
                                <p className={`text-xs leading-relaxed line-clamp-2 ${
                                  block.block_type === 'heading'
                                    ? 'font-semibold text-gray-800'
                                    : 'text-gray-700'
                                }`}>
                                  {block.heading ?? block.content}
                                </p>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* ---- Extraction Candidates panel ---- */}
                {candidates.length > 0 && (
                  <div className="flex-[2] flex flex-col overflow-hidden border-t-2 border-gray-300">
                    {/* Candidates header */}
                    <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-3 shrink-0 flex-wrap">
                      <span className="text-sm font-semibold text-gray-700">
                        Extraction Candidates
                      </span>
                      <span className="text-xs text-gray-500">
                        {acceptedCount} accepted · {rejectedCount} rejected · {pendingCount} pending
                      </span>
                      {candidateError && (
                        <span className="text-xs text-red-600 ml-2">{candidateError}</span>
                      )}
                    </div>

                    {/* Candidates list */}
                    <div className="flex-1 overflow-y-auto divide-y divide-gray-100 bg-gray-50">
                      {candidates.map((c) => {
                        const isEditing = editingCandidateId === c.id
                        return (
                          <div
                            key={c.id}
                            className={`bg-white p-3 ${candidateBorderClass(c.status)} ${
                              c.status === 'Rejected' ? 'opacity-50' : ''
                            }`}
                          >
                            {/* Accepted state */}
                            {c.status === 'Accepted' && (
                              <div className="flex items-center gap-2">
                                <span className="text-green-600 text-sm">✓</span>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-semibold text-gray-800 truncate">{c.title}</p>
                                  <p className="text-xs text-gray-500">{c.source_clause && `§${c.source_clause} · `}{c.suggested_discipline}</p>
                                </div>
                                {c.accepted_requirement_id && (
                                  <button
                                    onClick={() => onOpenRequirement(c.accepted_requirement_id!)}
                                    className="text-xs text-blue-600 hover:underline shrink-0"
                                  >
                                    Open →
                                  </button>
                                )}
                              </div>
                            )}

                            {/* Rejected state */}
                            {c.status === 'Rejected' && (
                              <div className="flex items-center gap-2">
                                <span className="text-gray-400 text-sm">✕</span>
                                <p className="text-xs text-gray-500 flex-1 truncate">{c.title}</p>
                                <button
                                  onClick={() => void handleRestorePending(c.id)}
                                  className="text-xs text-blue-500 hover:underline shrink-0"
                                >
                                  Restore
                                </button>
                              </div>
                            )}

                            {/* Pending / Edited state */}
                            {(c.status === 'Pending' || c.status === 'Edited') && !isEditing && (
                              <>
                                <div className="flex items-start gap-2 mb-2">
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-semibold text-gray-800 mb-0.5">{c.title}</p>
                                    <p className="text-xs text-gray-600 line-clamp-2">{c.statement}</p>
                                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                      {c.source_clause && (
                                        <button
                                          onClick={() => c.source_block_id && scrollToBlock(c.source_block_id)}
                                          disabled={!c.source_block_id}
                                          className="text-xs font-mono bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded hover:bg-yellow-200 disabled:cursor-default disabled:hover:bg-yellow-100 transition-colors"
                                          title={c.source_block_id ? 'Click to highlight source block' : 'No block reference'}
                                        >
                                          §{c.source_clause}
                                        </button>
                                      )}
                                      {c.suggested_classification && (
                                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                                          c.suggested_classification === 'Requirement'
                                            ? 'bg-green-100 text-green-700'
                                            : 'bg-yellow-100 text-yellow-700'
                                        }`}>
                                          {c.suggested_classification}
                                        </span>
                                      )}
                                      {c.suggested_discipline && (
                                        <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                                          {c.suggested_discipline}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex gap-1.5">
                                  <button
                                    onClick={() => void handleAccept(c)}
                                    className="px-2.5 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                                  >
                                    Accept
                                  </button>
                                  <button
                                    onClick={() => startEdit(c)}
                                    className="px-2.5 py-1 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50"
                                  >
                                    Edit & Accept
                                  </button>
                                  <button
                                    onClick={() => void handleReject(c.id)}
                                    className="px-2.5 py-1 text-xs border border-gray-300 text-gray-500 rounded hover:bg-gray-50"
                                  >
                                    Reject
                                  </button>
                                </div>
                              </>
                            )}

                            {/* Edit & Accept inline form */}
                            {isEditing && editForm && (
                              <div className="space-y-2">
                                <input
                                  type="text"
                                  value={editForm.title}
                                  onChange={(e) => setEditForm((f) => f ? { ...f, title: e.target.value } : f)}
                                  placeholder="Title"
                                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                                />
                                <textarea
                                  value={editForm.statement}
                                  onChange={(e) => setEditForm((f) => f ? { ...f, statement: e.target.value } : f)}
                                  placeholder="Statement"
                                  rows={3}
                                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none"
                                />
                                <div className="flex gap-2">
                                  <select
                                    value={editForm.classification}
                                    onChange={(e) => setEditForm((f) => f ? { ...f, classification: e.target.value } : f)}
                                    className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                                  >
                                    <option>Requirement</option>
                                    <option>Guideline</option>
                                  </select>
                                  <select
                                    value={editForm.discipline}
                                    onChange={(e) => setEditForm((f) => f ? { ...f, discipline: e.target.value } : f)}
                                    className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                                  >
                                    {DISCIPLINES.map((d) => <option key={d}>{d}</option>)}
                                  </select>
                                </div>
                                <div className="flex gap-1.5">
                                  <button
                                    onClick={() => void handleAccept(c, editForm)}
                                    className="px-2.5 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                                  >
                                    Accept
                                  </button>
                                  <button
                                    onClick={() => { setEditingCandidateId(null); setEditForm(null) }}
                                    className="px-2.5 py-1 text-xs border border-gray-300 text-gray-500 rounded hover:bg-gray-50"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ---- Extracted Text (legacy) ---- */}
            {activePanel === 'text' && (
              <div className="flex-1 overflow-hidden">
                {doc?.extracted_text ? (
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
                )}
              </div>
            )}

            {/* ---- References ---- */}
            {activePanel === 'references' && (
              <div className="flex-1 overflow-y-auto p-4 space-y-5">

                {/* Error */}
                {refError && (
                  <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                    {refError}
                  </div>
                )}

                {/* Header row */}
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-gray-700 flex-1">
                    Document References
                  </h3>
                  {onViewInNetwork && documentId && (
                    <button
                      onClick={() => onViewInNetwork(documentId)}
                      className="px-3 py-1.5 text-xs border border-indigo-300 text-indigo-700 rounded hover:bg-indigo-50"
                    >
                      View in Network
                    </button>
                  )}
                  {blocks.length > 0 && (
                    <button
                      onClick={() => void handleDetectRefs()}
                      disabled={detectingRefs}
                      className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-50"
                      title="Re-run Gemini reference detection on existing document blocks"
                    >
                      {detectingRefs ? 'Detecting…' : 'Detect References'}
                    </button>
                  )}
                  <button
                    onClick={() => { setAddingRef(true); setRefError(null) }}
                    className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  >
                    + Add Reference
                  </button>
                </div>

                {/* Add reference inline form */}
                {addingRef && (
                  <div className="border border-indigo-200 rounded-lg p-3 space-y-2 bg-indigo-50">
                    <p className="text-xs font-semibold text-indigo-800">
                      This document cites:
                    </p>
                    <select
                      value={addRefTargetId}
                      onChange={(e) => setAddRefTargetId(e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    >
                      <option value="">— select a document —</option>
                      {allDocs
                        .filter((d) => d.id !== documentId)
                        .filter((d) => !outRefs.some((r) => r.id === d.id))
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.document_id} — {d.title}
                          </option>
                        ))
                      }
                    </select>
                    <input
                      type="text"
                      value={addRefContext}
                      onChange={(e) => setAddRefContext(e.target.value)}
                      placeholder="Context (optional) — e.g. per §5.1"
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => void handleAddRef()}
                        disabled={savingRef || !addRefTargetId}
                        className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {savingRef ? 'Saving…' : 'Add'}
                      </button>
                      <button
                        onClick={() => { setAddingRef(false); setAddRefTargetId(''); setAddRefContext('') }}
                        className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Outgoing references (this doc cites) */}
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    This document cites ({outRefs.length})
                  </p>
                  {outRefs.length === 0 ? (
                    <p className="text-xs text-gray-400 italic">None recorded.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {outRefs.map((r) => (
                        <div
                          key={r.ref_row_id}
                          className="flex items-start gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg"
                        >
                          <div className="flex-1 min-w-0">
                            <span className="font-mono text-xs font-semibold text-blue-700 block">
                              {r.document_id}
                            </span>
                            <span className="text-xs text-gray-600 block">{r.title}</span>
                            {r.reference_context && (
                              <span className="text-xs text-gray-400 italic">{r.reference_context}</span>
                            )}
                          </div>
                          <button
                            onClick={() => void handleRemoveRef(r.ref_row_id)}
                            className="text-gray-400 hover:text-red-500 text-sm leading-none shrink-0 mt-0.5"
                            title="Remove reference"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Incoming references (who cites this doc) */}
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    Referenced by ({inRefs.length})
                  </p>
                  {inRefs.length === 0 ? (
                    <p className="text-xs text-gray-400 italic">No other documents reference this one.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {inRefs.map((r) => (
                        <div
                          key={r.ref_row_id}
                          className="px-3 py-2 bg-purple-50 border border-purple-100 rounded-lg"
                        >
                          <span className="font-mono text-xs font-semibold text-purple-700 block">
                            {r.document_id}
                          </span>
                          <span className="text-xs text-gray-600 block">{r.title}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>
            )}

          </div>
        )}

        {/* For new documents not yet saved */}
        {isNew && (
          <div className="flex-1 flex items-center justify-center bg-gray-50 text-gray-400 text-sm">
            Fill in the metadata and save — then you can upload a PDF.
          </div>
        )}
      </div>
    </div>
  )
}
