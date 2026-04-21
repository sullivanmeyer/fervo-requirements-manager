/**
 * SourceDocumentDetail — Stage 18 update
 *
 * Single-pass extraction workflow. The two-pass LLM candidate pipeline
 * has been retired. Users now work directly with decomposed clauses:
 *
 *   1. Decompose Document → clauses appear in the Document Blocks tab
 *   2. Check one or more clauses → "Extract to Requirement" button enables
 *   3. Fill in metadata (Title, Classification, Discipline, etc.) in the
 *      inline extraction form and click "Create Requirement"
 *   4. The clause(s) show a green left border + requirement ID badge
 *   5. Click the badge to navigate to the requirement detail view
 *   6. Click "×" on the badge to unlink the block from the requirement
 *
 * Stage 15 block-linked requirement infrastructure is preserved — the
 * requirement detail view still renders linked blocks via BlockRenderer.
 */
import { useEffect, useRef, useState, useMemo } from 'react'
import {
  archiveSourceDocument,
  createSourceDocument,
  fetchSourceDocument,
  fetchSourceDocuments,
  pdfDownloadUrl,
  updateSourceDocument,
  uploadPdf,
} from '../api/sourceDocuments'
import {
  decomposeDocument,
  extractToRequirement,
  fetchBlocks,
  unlinkBlock,
} from '../api/extraction'
import {
  addDocumentReference,
  deleteDocumentReference,
  detectDocumentReferences,
  fetchIncomingReferences,
  fetchOutgoingReferences,
} from '../api/documentReferences'
import { fetchSites, fetchUnits } from '../api/requirements'
import type {
  DocumentBlock,
  DocumentReferenceListItem,
  HierarchyNode,
  Site,
  SourceDocumentDetail as DocDetail,
  SourceDocumentListItem,
  TableData,
  Unit,
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
  'Build',
  'Operations',
]

const SUBTYPES_BY_CLASSIFICATION: Record<string, string[]> = {
  Requirement: ['Performance Requirement', 'Design Requirement', 'Derived Requirement', 'System Interface'],
  Guideline: ['Lesson Learned', 'Procedure', 'Code', 'Technology Selection'],
}

function flattenHierarchy(nodes: HierarchyNode[], depth = 0): { id: string; name: string; depth: number }[] {
  const result: { id: string; name: string; depth: number }[] = []
  for (const node of nodes) {
    if (!node.archived) {
      result.push({ id: node.id, name: node.name, depth })
      result.push(...flattenHierarchy(node.children, depth + 1))
    }
  }
  return result
}

const BLOCK_TYPE_STYLES: Record<string, string> = {
  heading: 'bg-blue-100 text-blue-700',
  requirement_clause: 'bg-green-100 text-green-700',
  table_block: 'bg-purple-100 text-purple-700',
  informational: 'bg-gray-100 text-gray-600',
  boilerplate: 'bg-gray-50 text-gray-400',
}

const BLOCK_TYPE_LABELS: Record<string, string> = {
  heading: 'Heading',
  requirement_clause: 'Requirement',
  table_block: 'Table',
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

interface ExtractFormState {
  title: string
  classification: string
  classification_subtype: string | null
  discipline: string
  hierarchy_node_ids: string[]
  site_ids: string[]
  unit_ids: string[]
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

function emptyExtractForm(): ExtractFormState {
  return {
    title: '',
    classification: 'Requirement',
    classification_subtype: null,
    discipline: 'General',
    hierarchy_node_ids: [],
    site_ids: [],
    unit_ids: [],
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

function normalizeHeaders(headers: string[] | string[][]): string[][] {
  if (!headers.length) return []
  return typeof headers[0] === 'string'
    ? [headers as string[]]
    : (headers as string[][])
}

function colspanGroups(row: string[]): { value: string; colspan: number }[] {
  const result: { value: string; colspan: number }[] = []
  for (const cell of row) {
    if (
      result.length > 0 &&
      cell !== '' &&
      result[result.length - 1].value === cell
    ) {
      result[result.length - 1].colspan++
    } else {
      result.push({ value: cell, colspan: 1 })
    }
  }
  return result
}

function TablePreview({ data, compact = false }: { data: TableData; compact?: boolean }) {
  const headerRows = normalizeHeaders(data.headers)
  const isFallback = data.table_parse_quality === 'fallback'

  return (
    <div className={`overflow-x-auto ${compact ? 'max-h-32' : 'max-h-64'} overflow-y-auto`}>
      {isFallback && (
        <p className="text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5 mb-1">
          Table parsed with reduced accuracy — review for errors
        </p>
      )}
      {data.caption && (
        <p className="text-xs text-gray-500 italic mb-1">{data.caption}</p>
      )}
      <table className={`text-xs border-collapse w-full ${isFallback ? 'border-l-2 border-l-amber-400' : ''}`}>
        <thead>
          {headerRows.map((row, rowIdx) => (
            <tr key={rowIdx} className={rowIdx === 0 && headerRows.length > 1 ? 'bg-purple-100' : 'bg-purple-50'}>
              {colspanGroups(row).map(({ value, colspan }, ci) => (
                <th
                  key={ci}
                  colSpan={colspan}
                  className={`border border-purple-200 px-2 py-1 text-left text-purple-800 whitespace-nowrap ${
                    rowIdx === 0 && headerRows.length > 1 ? 'font-bold' : 'font-semibold'
                  }`}
                >
                  {value || '—'}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {data.rows.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="border border-gray-200 px-2 py-1 text-gray-700"
                >
                  {cell || ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.footnotes && (
        <p className="text-xs text-gray-500 italic mt-1">{data.footnotes}</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  documentId: string | null
  userName?: string
  hierarchyNodes?: HierarchyNode[]
  onSaved: (savedId: string) => void
  onCancel: () => void
  onCreateRequirement: (sourceDocumentId: string, initialStatement: string) => void
  onOpenRequirement: (requirementId: string) => void
  onViewInNetwork?: (documentId: string) => void
  initialHighlightBlockIds?: string[]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SourceDocumentDetail({
  documentId,
  userName = '',
  hierarchyNodes = [],
  onSaved,
  onCancel,
  onCreateRequirement,
  onOpenRequirement,
  onViewInNetwork,
  initialHighlightBlockIds,
}: Props) {
  const isNew = documentId === null

  const [pinnedBlockIds, setPinnedBlockIds] = useState<Set<string>>(
    new Set(initialHighlightBlockIds ?? [])
  )

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

  // Inline extraction form
  const [extractForm, setExtractForm] = useState<ExtractFormState | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState<string | null>(null)

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

  // Reference data for extraction form pickers
  const [sites, setSites] = useState<Site[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const flatHierarchy = useMemo(() => flattenHierarchy(hierarchyNodes), [hierarchyNodes])

  // -------------------------------------------------------------------------
  // Load on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    void Promise.all([fetchSites(), fetchUnits()]).then(([s, u]) => { setSites(s); setUnits(u) })
  }, [])

  useEffect(() => {
    if (isNew) return
    const doLoad = async () => {
      try {
        const [d, blks, outgoing, incoming, docs] = await Promise.all([
          fetchSourceDocument(documentId!),
          fetchBlocks(documentId!).catch(() => [] as DocumentBlock[]),
          fetchOutgoingReferences(documentId!).catch(() => [] as DocumentReferenceListItem[]),
          fetchIncomingReferences(documentId!).catch(() => [] as DocumentReferenceListItem[]),
          fetchSourceDocuments().catch(() => [] as SourceDocumentListItem[]),
        ])
        setDoc(d)
        setForm(formFromDetail(d))
        setBlocks(blks)
        setOutRefs(outgoing)
        setInRefs(incoming)
        setAllDocs(docs)

        if (initialHighlightBlockIds && initialHighlightBlockIds.length > 0) {
          setActivePanel('blocks')
          setTimeout(() => scrollToBlock(initialHighlightBlockIds[0]), 150)
        }
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
      await decomposeDocument(documentId)
      const poll = async (): Promise<void> => {
        const d = await fetchSourceDocument(documentId)
        if (d.decomposition_status === 'complete') {
          const blks = await fetchBlocks(documentId)
          setBlocks(blks)
          setSelectedBlockIds(new Set())
          setDecomposing(false)
        } else if (d.decomposition_status === 'failed') {
          setBlockError(d.decomposition_error ?? 'Decomposition failed. Check the server logs.')
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

  const selectAllUnlinkedBlocks = () =>
    setSelectedBlockIds(new Set(blocks.filter((b) => !b.linked_requirement_id).map((b) => b.id)))

  const clearSelection = () => setSelectedBlockIds(new Set())

  const scrollToBlock = (blockId: string) => {
    setActivePanel('blocks')
    setHighlightedBlockId(blockId)
    setTimeout(() => {
      const el = blockListRef.current?.querySelector(`[data-block-id="${blockId}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => setHighlightedBlockId(null), 2000)
    }, 50)
  }

  // -------------------------------------------------------------------------
  // Extract to requirement
  // -------------------------------------------------------------------------

  const handleOpenExtractForm = () => {
    setExtractForm(emptyExtractForm())
    setExtractError(null)
  }

  const handleExtractToRequirement = async () => {
    if (!documentId || selectedBlockIds.size === 0 || !extractForm) return
    setExtracting(true)
    setExtractError(null)
    try {
      await extractToRequirement({
        block_ids: Array.from(selectedBlockIds),
        owner: userName || 'Unknown',
        title: extractForm.title || undefined,
        classification: extractForm.classification,
        classification_subtype: extractForm.classification_subtype,
        discipline: extractForm.discipline,
        hierarchy_node_ids: extractForm.hierarchy_node_ids,
        site_ids: extractForm.site_ids,
        unit_ids: extractForm.unit_ids,
      })
      // Refresh blocks to show green borders + linked badges
      const updatedBlocks = await fetchBlocks(documentId)
      setBlocks(updatedBlocks)
      setSelectedBlockIds(new Set())
      setExtractForm(null)
      // Refresh linked requirements count in the left panel
      fetchSourceDocument(documentId).then(setDoc).catch(() => null)
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Extraction failed')
    } finally {
      setExtracting(false)
    }
  }

  const handleUnlinkBlock = async (blockId: string) => {
    setBlockError(null)
    try {
      await unlinkBlock(blockId)
      setBlocks((prev) =>
        prev.map((b) =>
          b.id === blockId
            ? { ...b, linked_requirement_id: null, linked_requirement_summary: null }
            : b
        )
      )
    } catch (e) {
      setBlockError(e instanceof Error ? e.message : 'Failed to unlink block')
    }
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

  const linkedBlockCount = blocks.filter((b) => b.linked_requirement_id).length
  const selectedLinkedCount = blocks.filter(
    (b) => selectedBlockIds.has(b.id) && b.linked_requirement_id
  ).length
  const canExtract = selectedBlockIds.size > 0 && selectedLinkedCount === 0

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
          {!isNew && doc && (
            <button
              onClick={async () => {
                try {
                  const updated = await archiveSourceDocument(doc.id, !doc.archived)
                  setDoc(updated)
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Failed to update archive status')
                }
              }}
              className={`px-3 py-1.5 text-sm border rounded ${
                doc.archived
                  ? 'border-gray-300 text-gray-600 hover:bg-gray-50'
                  : 'border-red-200 text-red-600 hover:bg-red-50'
              }`}
            >
              {doc.archived ? 'Restore Document' : 'Archive Document'}
            </button>
          )}
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

      {doc?.archived && (
        <div className="px-4 py-2 bg-gray-100 border-b border-gray-300 text-sm text-gray-600 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 12a2 2 0 002 2h8a2 2 0 002-2L19 8" />
          </svg>
          <span>
            <strong>Archived document.</strong> This document is hidden from active workflows.
            Existing requirement links are preserved. Use "Restore Document" to make it active again.
          </span>
        </div>
      )}

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
            {!isNew && doc && form.revision && form.revision !== (doc.revision ?? '') && (
              <p className="mt-1 text-xs text-amber-600">
                Saving a new revision value will flag all derived requirements as stale.
              </p>
            )}
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
                    {panel === 'blocks' && linkedBlockCount > 0 && (
                      <span className="ml-1 px-1.5 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">
                        {linkedBlockCount}
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

                {/* Blocks section — shrinks to make room for extract form */}
                <div className={`flex flex-col overflow-hidden ${extractForm ? 'flex-[3]' : 'flex-1'}`}>

                  {/* Blocks toolbar */}
                  <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2 shrink-0 flex-wrap">
                    {blocks.length === 0 ? (
                      <>
                        <p className="text-sm text-gray-500 flex-1">
                          {doc?.has_file
                            ? 'Decompose this document into structured blocks for extraction.'
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
                          {linkedBlockCount > 0 && ` · ${linkedBlockCount} extracted`}
                        </span>
                        <button
                          onClick={selectedBlockIds.size > 0 ? clearSelection : selectAllUnlinkedBlocks}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          {selectedBlockIds.size > 0 ? 'Clear selection' : 'Select all'}
                        </button>
                        <div className="flex-1" />
                        <button
                          onClick={handleOpenExtractForm}
                          disabled={!canExtract || !!extractForm}
                          className="px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-40"
                          title={
                            selectedLinkedCount > 0
                              ? 'Some selected blocks are already linked to a requirement — unlink them first'
                              : selectedBlockIds.size === 0
                              ? 'Select one or more blocks first'
                              : 'Extract selected blocks to a new requirement'
                          }
                        >
                          Extract to Requirement ({selectedBlockIds.size})
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
                          const isPinned = pinnedBlockIds.has(block.id)
                          const isLinked = !!block.linked_requirement_id
                          return (
                            <div
                              key={block.id}
                              data-block-id={block.id}
                              className={`flex items-start gap-2 px-3 py-2 transition-colors ${
                                highlightedBlockId === block.id
                                  ? 'bg-yellow-100 ring-2 ring-inset ring-yellow-400'
                                  : isPinned
                                  ? 'bg-blue-50 ring-2 ring-inset ring-blue-300'
                                  : isLinked
                                  ? 'border-l-4 border-l-green-400 bg-green-50/40'
                                  : isSelected
                                  ? 'bg-blue-50 hover:bg-blue-100 cursor-pointer'
                                  : 'hover:bg-white cursor-pointer'
                              } ${isBoilerplate ? 'opacity-50' : ''}`}
                              style={{ paddingLeft: `${12 + block.depth * 16}px` }}
                              onClick={() => !isLinked && toggleBlock(block.id)}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                disabled={isLinked}
                                onChange={() => !isLinked && toggleBlock(block.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="mt-0.5 shrink-0 disabled:opacity-40"
                                title={
                                  isLinked
                                    ? `Already extracted to ${block.linked_requirement_summary?.requirement_id ?? 'a requirement'} — click × to unlink`
                                    : undefined
                                }
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                                  {block.clause_number && (
                                    <span className="text-xs font-mono text-gray-500 shrink-0">
                                      {block.clause_number}
                                    </span>
                                  )}
                                  <BlockTypeBadge type={block.block_type} />
                                  {isLinked && block.linked_requirement_summary && (
                                    <span className="flex items-center gap-0.5 shrink-0">
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          onOpenRequirement(block.linked_requirement_id!)
                                        }}
                                        className="text-xs font-mono bg-green-100 text-green-800 px-1.5 py-0.5 rounded hover:bg-green-200 transition-colors"
                                        title="Open linked requirement"
                                      >
                                        {block.linked_requirement_summary.requirement_id}
                                      </button>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          void handleUnlinkBlock(block.id)
                                        }}
                                        className="text-gray-400 hover:text-red-500 text-xs px-0.5 leading-none transition-colors"
                                        title="Unlink this block from the requirement"
                                      >
                                        ×
                                      </button>
                                    </span>
                                  )}
                                </div>
                                {block.block_type === 'table_block' && block.table_data ? (
                                  <TablePreview data={block.table_data} compact />
                                ) : (
                                  <p className={`text-xs leading-relaxed line-clamp-2 ${
                                    block.block_type === 'heading'
                                      ? 'font-semibold text-gray-800'
                                      : 'text-gray-700'
                                  }`}>
                                    {block.heading ?? block.content}
                                  </p>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* ---- Extraction form panel ---- */}
                {extractForm && (
                  <div className="flex-[2] flex flex-col overflow-hidden border-t-2 border-green-300">
                    <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-3 shrink-0">
                      <span className="text-sm font-semibold text-gray-700">
                        Extract to Requirement
                      </span>
                      <span className="text-xs text-gray-500">
                        {selectedBlockIds.size} block{selectedBlockIds.size !== 1 ? 's' : ''} selected
                        {(() => {
                          const clauseNums = blocks
                            .filter((b) => selectedBlockIds.has(b.id) && b.clause_number)
                            .sort((a, b) => a.sort_order - b.sort_order)
                            .map((b) => b.clause_number!)
                          return clauseNums.length > 0 ? ` · ${clauseNums.join(', ')}` : ''
                        })()}
                      </span>
                      {extractError && (
                        <span className="text-xs text-red-600 ml-2">{extractError}</span>
                      )}
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
                      {/* Title */}
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                          Title
                        </label>
                        <input
                          type="text"
                          value={extractForm.title}
                          onChange={(e) => setExtractForm((f) => f ? { ...f, title: e.target.value } : f)}
                          placeholder="Requirement title (leave blank to auto-generate)"
                          className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400"
                          autoFocus
                        />
                      </div>

                      {/* Classification + Subtype + Discipline */}
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                            Classification
                          </label>
                          <select
                            value={extractForm.classification}
                            onChange={(e) =>
                              setExtractForm((f) =>
                                f ? { ...f, classification: e.target.value, classification_subtype: null } : f
                              )
                            }
                            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-green-400"
                          >
                            <option>Requirement</option>
                            <option>Guideline</option>
                          </select>
                        </div>
                        <div className="flex-1">
                          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                            Subtype
                          </label>
                          <select
                            value={extractForm.classification_subtype ?? ''}
                            onChange={(e) =>
                              setExtractForm((f) =>
                                f ? { ...f, classification_subtype: e.target.value || null } : f
                              )
                            }
                            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-green-400"
                          >
                            <option value="">— Subtype —</option>
                            {(SUBTYPES_BY_CLASSIFICATION[extractForm.classification] ?? []).map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex-1">
                          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                            Discipline
                          </label>
                          <select
                            value={extractForm.discipline}
                            onChange={(e) =>
                              setExtractForm((f) => f ? { ...f, discipline: e.target.value } : f)
                            }
                            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-green-400"
                          >
                            {DISCIPLINES.map((d) => <option key={d}>{d}</option>)}
                          </select>
                        </div>
                      </div>

                      {/* Hierarchy / Site / Units */}
                      <div className="flex gap-2">
                        <MiniMultiPicker
                          label="Hierarchy Nodes"
                          options={flatHierarchy}
                          selectedIds={extractForm.hierarchy_node_ids}
                          onChange={(ids) =>
                            setExtractForm((f) => f ? { ...f, hierarchy_node_ids: ids } : f)
                          }
                        />
                        <MiniMultiPicker
                          label="Site"
                          options={sites}
                          selectedIds={extractForm.site_ids}
                          onChange={(ids) =>
                            setExtractForm((f) => f ? { ...f, site_ids: ids } : f)
                          }
                        />
                        <MiniMultiPicker
                          label="Units"
                          options={units}
                          selectedIds={extractForm.unit_ids}
                          onChange={(ids) =>
                            setExtractForm((f) => f ? { ...f, unit_ids: ids } : f)
                          }
                        />
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={() => void handleExtractToRequirement()}
                          disabled={extracting}
                          className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                        >
                          {extracting ? 'Creating…' : 'Create Requirement'}
                        </button>
                        <button
                          onClick={() => { setExtractForm(null); setExtractError(null) }}
                          disabled={extracting}
                          className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
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

                {refError && (
                  <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                    {refError}
                  </div>
                )}

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

// ---------------------------------------------------------------------------
// MiniMultiPicker — compact inline checkbox dropdown
// ---------------------------------------------------------------------------

function MiniMultiPicker({
  label,
  options,
  selectedIds,
  onChange,
}: {
  label: string
  options: { id: string; name: string; depth?: number }[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const toggle = (id: string) =>
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id])

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full border rounded px-2 py-1.5 text-xs bg-white text-left flex items-center justify-between gap-1 ${
          selectedIds.length > 0 ? 'border-green-400 text-green-700' : 'border-gray-300 text-gray-500'
        }`}
      >
        <span className="truncate">
          {selectedIds.length > 0 ? `${label} (${selectedIds.length})` : label}
        </span>
        <span className="text-gray-400 shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 top-full mt-0.5 left-0 right-0 bg-white border border-gray-300 rounded shadow-lg max-h-44 overflow-y-auto py-1 min-w-36">
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-400 italic">No options</div>
          )}
          {options.map((opt) => (
            <label
              key={opt.id}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-green-50 cursor-pointer"
              style={opt.depth !== undefined ? { paddingLeft: `${12 + opt.depth * 12}px` } : undefined}
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(opt.id)}
                onChange={() => toggle(opt.id)}
                className="rounded"
              />
              <span className="text-xs text-gray-700">{opt.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
