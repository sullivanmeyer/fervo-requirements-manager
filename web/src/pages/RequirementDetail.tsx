/**
 * RequirementDetail
 *
 * Full create / edit form for a single requirement, now including
 * parent/child traceability link management (Stage 3).
 *
 * Pass requirementId=null to create a new requirement.
 * Pass initialParentIds to pre-populate parents (used by "Add Child").
 */
import { type ChangeEvent, useEffect, useRef, useState, useCallback } from 'react'
import {
  addLink,
  archiveRequirement,
  createRequirement,
  fetchAllRequirements,
  fetchRequirement,
  fetchSites,
  fetchUnits,
  removeLink,
  transferDiscipline,
  updateRequirement,
} from '../api/requirements'
import { fetchSourceDocuments } from '../api/sourceDocuments'
import {
  attachmentDownloadUrl,
  deleteAttachment,
  fetchAttachments,
  uploadAttachment,
} from '../api/attachments'
import {
  createConflictRecord,
  deleteConflictRecord,
  updateConflictRecord,
} from '../api/conflictRecords'
import { fetchGapAnalysis } from '../api/search'
import type {
  Attachment,
  ConflictRecord,
  DocumentBlock,
  GapAnalysisResult,
  GapNodeStub,
  HierarchyNode,
  LinkedBlock,
  RequirementDetail as ReqDetail,
  RequirementListItem,
  RequirementStub,
  Site,
  SourceDocumentListItem,
  TableData,
  Unit,
} from '../types'
import { addRequirementBlock, removeRequirementBlock, updateBlock } from '../api/extraction'
import { fetchBlocks } from '../api/extraction'
import HierarchyNodePicker from '../components/HierarchyNodePicker'
import RequirementSearch from '../components/RequirementSearch'
import TagInput from '../components/TagInput'

// ---------------------------------------------------------------------------
// Enum values (must match api/schemas.py)
// ---------------------------------------------------------------------------

const CLASSIFICATIONS = ['Requirement', 'Guideline']
const CLASSIFICATION_SUBTYPES: Record<string, string[]> = {
  Requirement: ['Performance Requirement', 'Design Requirement', 'Derived Requirement'],
  Guideline: ['Lesson Learned', 'Procedure', 'Code'],
}
const SOURCE_TYPES = ['Manual Entry', 'Derived from Document']
const STATUSES = ['Draft', 'Under Review', 'Approved', 'Superseded', 'Withdrawn']
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
const VERIFICATION_METHODS = [
  'Analysis',
  'Inspection',
  'Test',
  'Demonstration',
  'Review of Record',
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  requirementId: string | null        // null = creating new
  hierarchyNodes: HierarchyNode[]
  userName: string
  initialParentIds?: string[]         // pre-link parents (used by "Add Child")
  initialStatement?: string           // pre-populate statement (from doc selection)
  initialSourceDocumentId?: string    // pre-link source document (from doc detail)
  backLabel?: string                  // label for the back button (default: "Requirements")
  onSaved: (savedId: string) => void
  onCancel: () => void
  onViewInTree: (id: string) => void  // navigate to derivation tree tab
  onAddChild: (parentId: string) => void
  onOpenDocument?: (docId: string, blockIds?: string[]) => void
  onCreateChildForGap?: (parentId: string, hierarchyNodeId: string) => void
}

interface FormState {
  title: string
  statement: string
  classification: string
  classification_subtype: string
  owner: string
  source_type: string
  status: string
  discipline: string
  created_by: string
  created_date: string
  last_modified_by: string
  last_modified_date: string
  change_history: string
  rationale: string
  comments: string
  verification_method: string
  tags: string[]
  source_document_id: string
  source_clause: string
  hierarchy_node_ids: string[]
  site_ids: string[]
  unit_ids: string[]
}

const today = () => new Date().toISOString().slice(0, 10)

function emptyForm(userName: string, initialStatement = '', initialSourceDocumentId = ''): FormState {
  return {
    title: '',
    statement: initialStatement,
    classification: 'Requirement',
    classification_subtype: '',
    owner: userName,
    source_type: initialSourceDocumentId ? 'Derived from Document' : 'Manual Entry',
    status: 'Draft',
    discipline: 'Mechanical',
    created_by: userName,
    created_date: today(),
    last_modified_by: '',
    last_modified_date: '',
    change_history: '',
    rationale: '',
    comments: '',
    verification_method: '',
    tags: [],
    source_document_id: initialSourceDocumentId,
    source_clause: '',
    hierarchy_node_ids: [],
    site_ids: [],
    unit_ids: [],
  }
}

function formFromDetail(req: ReqDetail): FormState {
  return {
    title: req.title,
    statement: req.statement,
    classification: req.classification,
    classification_subtype: req.classification_subtype ?? '',
    owner: req.owner,
    source_type: req.source_type,
    status: req.status,
    discipline: req.discipline,
    created_by: req.created_by,
    created_date: req.created_date,
    last_modified_by: req.last_modified_by ?? '',
    last_modified_date: req.last_modified_date ?? '',
    change_history: req.change_history ?? '',
    rationale: req.rationale ?? '',
    comments: req.comments ?? '',
    verification_method: req.verification_method ?? '',
    tags: req.tags ?? [],
    source_document_id: req.source_document_id ?? '',
    source_clause: req.source_clause ?? '',
    hierarchy_node_ids: req.hierarchy_nodes.map((n) => n.id),
    site_ids: req.sites.map((s) => s.id),
    unit_ids: req.units.map((u) => u.id),
  }
}

// ---------------------------------------------------------------------------
// Block renderer — renders linked source blocks in the requirement body
// ---------------------------------------------------------------------------

/** Normalise headers to string[][] for uniform rendering. */
function normalizeHeaders(headers: string[] | string[][]): string[][] {
  if (!headers.length) return []
  return typeof headers[0] === 'string'
    ? [headers as string[]]
    : (headers as string[][])
}

/** Compress consecutive identical non-empty cells into colspan groups. */
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

/**
 * Regenerate Markdown table text from structured table_data.
 * Uses the last (leaf) header row as the column names so the plain-text
 * search-index fallback is as useful as possible.
 */
function tableDataToMarkdown(td: TableData): string {
  const headerRows = normalizeHeaders(td.headers)
  const leafHeaders = headerRows[headerRows.length - 1] ?? []
  const header = '| ' + leafHeaders.join(' | ') + ' |'
  const sep = '| ' + leafHeaders.map(() => '---').join(' | ') + ' |'
  const rows = td.rows.map((row) => '| ' + row.join(' | ') + ' |')
  return [header, sep, ...rows].join('\n')
}

function BlockRenderer({
  blocks,
  onBlockSaved,
  onBlockRemoved,
}: {
  blocks: LinkedBlock[]
  onBlockSaved: (blockId: string, content: string, tableData: TableData | null) => void
  onBlockRemoved: (blockId: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editTableData, setEditTableData] = useState<TableData | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const startEdit = (block: LinkedBlock) => {
    setEditingId(block.id)
    setEditContent(block.content)
    if (block.table_data) {
      // Deep-copy so edits don't mutate the display state before saving.
      // Flatten multi-level headers to the leaf row (last row) for the edit
      // inputs — multi-level header restructuring isn't supported inline.
      const td: TableData = JSON.parse(JSON.stringify(block.table_data))
      const rows = normalizeHeaders(td.headers)
      td.headers = rows[rows.length - 1] ?? []
      setEditTableData(td)
    } else {
      setEditTableData(null)
    }
    setSaveError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setSaveError(null)
  }

  const saveEdit = async (block: LinkedBlock) => {
    setSaving(true)
    setSaveError(null)
    try {
      const isTable = block.block_type === 'table_block' && editTableData
      const content = isTable ? tableDataToMarkdown(editTableData!) : editContent
      const tableData = isTable ? editTableData : null
      await updateBlock(block.id, { content, table_data: tableData })
      onBlockSaved(block.id, content, tableData)
      setEditingId(null)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (blocks.length === 0) {
    return <p className="text-xs text-gray-400 italic">No source blocks linked.</p>
  }

  return (
    <div className="space-y-4">
      {/* Warning: edits propagate to the source document viewer */}
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
        Edits here update the block in the source document viewer too — the block is shared, not copied.
      </p>

      {blocks.map((block) => {
        const isEditing = editingId === block.id
        const isRemoving = removingId === block.id
        const prefix = block.clause_number
          ? <span className="text-xs font-mono text-gray-400 shrink-0">{block.clause_number}</span>
          : null

        const removeBtn = (
          <button
            onClick={async () => {
              setRemovingId(block.id)
              await onBlockRemoved(block.id)
              setRemovingId(null)
            }}
            disabled={isRemoving || saving}
            title="Unlink this block from the requirement"
            className="ml-auto px-1.5 py-0.5 text-xs text-red-500 border border-red-200 rounded hover:bg-red-50 disabled:opacity-40 shrink-0"
          >
            {isRemoving ? '…' : '× Remove'}
          </button>
        )

        // ── Heading — structural, not editable ──────────────────────────────
        if (block.block_type === 'heading') {
          return (
            <div key={block.id} className="flex items-baseline gap-2">
              {prefix}
              <p className="text-sm font-semibold text-gray-700 flex-1">{block.heading || block.content}</p>
              {removeBtn}
            </div>
          )
        }

        // ── Table block ──────────────────────────────────────────────────────
        if (block.block_type === 'table_block') {
          const td = isEditing ? editTableData : block.table_data
          if (!td) return null
          const headerRows = normalizeHeaders(td.headers)
          const isMultiLevel = headerRows.length > 1
          const isFallback = td.table_parse_quality === 'fallback'
          return (
            <div key={block.id}>
              {prefix && <div className="mb-1">{prefix}</div>}
              {isFallback && (
                <p className="text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5 mb-1">
                  Table parsed with reduced accuracy — review for errors
                </p>
              )}
              {td.caption && (
                <p className="text-xs text-gray-500 italic mb-1">{td.caption}</p>
              )}
              <div className={`overflow-x-auto ${isFallback ? 'border-l-2 border-l-amber-400 pl-1' : ''}`}>
                <table className="text-xs border-collapse w-full">
                  <thead>
                    {headerRows.map((row, rowIdx) => (
                      <tr key={rowIdx} className={rowIdx === 0 && isMultiLevel ? 'bg-purple-100' : 'bg-purple-50'}>
                        {isEditing && !isMultiLevel
                          /* Edit mode: flat single-row headers become inputs */
                          ? row.map((h, ci) => (
                              <th key={ci} className="border border-purple-200 px-1 py-1">
                                <input
                                  value={h}
                                  onChange={(e) => {
                                    // editTableData.headers is always string[] in edit mode
                                    const nh = [...(editTableData!.headers as string[])]
                                    nh[ci] = e.target.value
                                    setEditTableData({ ...editTableData!, headers: nh })
                                  }}
                                  className="w-full min-w-[80px] bg-white border border-purple-300 rounded px-1 py-0.5 text-xs font-semibold text-purple-800 focus:outline-none focus:ring-1 focus:ring-purple-400"
                                />
                              </th>
                            ))
                          /* Display mode or multi-level: render with colspan */
                          : colspanGroups(row).map(({ value, colspan }, ci) => (
                              <th
                                key={ci}
                                colSpan={colspan}
                                className={`border border-purple-200 px-2 py-1 text-left text-purple-800 whitespace-nowrap ${
                                  rowIdx === 0 && isMultiLevel ? 'font-bold' : 'font-semibold'
                                }`}
                              >
                                {value || '—'}
                              </th>
                            ))
                        }
                      </tr>
                    ))}
                    {isEditing && isMultiLevel && (
                      <tr>
                        <td
                          colSpan={headerRows[headerRows.length - 1]?.length ?? 1}
                          className="px-2 py-1 text-xs text-amber-600 bg-amber-50 border border-amber-200"
                        >
                          Multi-level headers are read-only — edit body cells below
                        </td>
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {td.rows.map((row, ri) => (
                      <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        {row.map((cell, ci) =>
                          isEditing ? (
                            <td key={ci} className="border border-gray-200 px-1 py-1">
                              <input
                                value={cell}
                                onChange={(e) => {
                                  const nr = editTableData!.rows.map((r, ridx) =>
                                    ridx === ri ? r.map((c, cidx) => cidx === ci ? e.target.value : c) : r
                                  )
                                  setEditTableData({ ...editTableData!, rows: nr })
                                }}
                                className="w-full min-w-[60px] border border-gray-200 rounded px-1 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                              />
                            </td>
                          ) : (
                            <td key={ci} className="border border-gray-200 px-2 py-1 text-gray-700">
                              {cell || ''}
                            </td>
                          )
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {td.footnotes && (
                <p className="text-xs text-gray-500 italic mt-1">{td.footnotes}</p>
              )}
              {/* Edit / remove controls */}
              <div className="mt-1 flex items-center gap-2">
                {isEditing ? (
                  <>
                    {saveError && <span className="text-xs text-red-600">{saveError}</span>}
                    <button
                      onClick={() => void saveEdit(block)}
                      disabled={saving}
                      className="px-2 py-0.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={cancelEdit}
                      disabled={saving}
                      className="px-2 py-0.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => startEdit(block)}
                    className="px-2 py-0.5 text-xs border border-gray-300 text-gray-500 rounded hover:bg-gray-50"
                  >
                    Edit table
                  </button>
                )}
                {!isEditing && removeBtn}
              </div>
            </div>
          )
        }

        // ── Prose block (requirement_clause, informational, etc.) ────────────
        return (
          <div key={block.id}>
            <div className="flex items-start gap-2">
              {prefix}
              {isEditing ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={Math.max(3, editContent.split('\n').length + 1)}
                  className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
                  autoFocus
                />
              ) : (
                <p
                  className="flex-1 text-sm text-gray-700 leading-relaxed whitespace-pre-wrap cursor-text hover:bg-gray-50 rounded px-1 -mx-1 transition-colors"
                  title="Click to edit"
                  onClick={() => startEdit(block)}
                >
                  {block.content}
                </p>
              )}
              {!isEditing && removeBtn}
            </div>
            {isEditing && (
              <div className="mt-1 flex items-center gap-2 ml-auto">
                {saveError && <span className="text-xs text-red-600">{saveError}</span>}
                <button
                  onClick={() => void saveEdit(block)}
                  disabled={saving}
                  className="px-2 py-0.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={cancelEdit}
                  disabled={saving}
                  className="px-2 py-0.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// AddBlockPicker — lets user link additional blocks from the source document
// ---------------------------------------------------------------------------

function AddBlockPicker({
  requirementId,
  sourceDocumentId,
  linkedBlockIds,
  onBlockAdded,
}: {
  requirementId: string
  sourceDocumentId: string
  linkedBlockIds: string[]
  onBlockAdded: (result: { content_source: 'manual' | 'block_linked'; linked_blocks: LinkedBlock[] }) => void
}) {
  const [open, setOpen] = useState(false)
  const [allBlocks, setAllBlocks] = useState<DocumentBlock[]>([])
  const [loadingBlocks, setLoadingBlocks] = useState(false)
  const [addingId, setAddingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleOpen = async () => {
    setOpen(true)
    if (allBlocks.length === 0) {
      setLoadingBlocks(true)
      try {
        const blocks = await fetchBlocks(sourceDocumentId)
        setAllBlocks(blocks)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load blocks')
      } finally {
        setLoadingBlocks(false)
      }
    }
  }

  const handleAdd = async (blockId: string) => {
    setAddingId(blockId)
    setError(null)
    try {
      const result = await addRequirementBlock(requirementId, blockId)
      onBlockAdded(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add block')
    } finally {
      setAddingId(null)
    }
  }

  const linkedSet = new Set(linkedBlockIds)

  return (
    <div className="mt-2">
      {!open ? (
        <button
          type="button"
          onClick={() => void handleOpen()}
          className="text-xs text-purple-700 border border-purple-200 rounded px-2 py-1 hover:bg-purple-50"
        >
          + Add source block
        </button>
      ) : (
        <div className="border border-purple-200 rounded bg-white mt-1">
          <div className="flex items-center justify-between px-3 py-2 border-b border-purple-100">
            <span className="text-xs font-semibold text-purple-800">Add a block from the source document</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Close
            </button>
          </div>
          {error && <p className="text-xs text-red-600 px-3 py-2">{error}</p>}
          {loadingBlocks ? (
            <p className="text-xs text-gray-400 px-3 py-3">Loading blocks…</p>
          ) : (
            <div className="max-h-64 overflow-y-auto divide-y divide-gray-100">
              {allBlocks.length === 0 && (
                <p className="text-xs text-gray-400 px-3 py-3">No blocks found in this document.</p>
              )}
              {allBlocks.map((block) => {
                const isLinked = linkedSet.has(block.id)
                const isAdding = addingId === block.id
                return (
                  <div
                    key={block.id}
                    className={`flex items-start gap-2 px-3 py-2 ${isLinked ? 'bg-purple-50' : 'hover:bg-gray-50'}`}
                  >
                    <div className="flex-1 min-w-0">
                      {block.clause_number && (
                        <span className="text-xs font-mono text-gray-400 mr-1">{block.clause_number}</span>
                      )}
                      <span className="text-xs text-gray-700 line-clamp-2">
                        {block.heading || block.content}
                      </span>
                    </div>
                    {isLinked ? (
                      <span className="text-xs text-purple-600 shrink-0">Linked</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleAdd(block.id)}
                        disabled={isAdding}
                        className="text-xs text-blue-600 border border-blue-200 rounded px-1.5 py-0.5 hover:bg-blue-50 disabled:opacity-40 shrink-0"
                      >
                        {isAdding ? '…' : 'Add'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small layout helpers
// ---------------------------------------------------------------------------

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
    </div>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
    />
  )
}

function SelectInput({
  value,
  options,
  onChange,
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

function MultiSelectInput({
  label,
  options,
  selectedIds,
  onChange,
}: {
  label: string
  options: { id: string; name: string }[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}) {
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((s) => s !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  return (
    <div className="border border-gray-300 rounded overflow-hidden">
      {options.length === 0 ? (
        <p className="px-3 py-2 text-sm text-gray-400">No {label} available</p>
      ) : (
        options.map((opt) => (
          <label
            key={opt.id}
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-0"
          >
            <input
              type="checkbox"
              checked={selectedIds.includes(opt.id)}
              onChange={() => toggle(opt.id)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">{opt.name}</span>
          </label>
        ))
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sync helper: given original and desired parent ID sets, fire add/remove
// API calls for the diff.  Returns an error string if any call fails.
// ---------------------------------------------------------------------------

async function syncParentLinks(
  childId: string,
  originalParentIds: string[],
  desiredParentIds: string[],
): Promise<string | null> {
  const toAdd = desiredParentIds.filter((id) => !originalParentIds.includes(id))
  const toRemove = originalParentIds.filter((id) => !desiredParentIds.includes(id))

  try {
    for (const parentId of toRemove) {
      await removeLink(parentId, childId)
    }
    for (const parentId of toAdd) {
      await addLink(parentId, childId)
    }
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Link update failed'
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function RequirementDetail({
  requirementId,
  hierarchyNodes,
  userName,
  initialParentIds = [],
  initialStatement = '',
  initialSourceDocumentId = '',
  backLabel = 'Requirements',
  onSaved,
  onCancel,
  onViewInTree,
  onAddChild,
  onOpenDocument,
  onCreateChildForGap,
}: Props) {
  const isNew = requirementId === null

  const [form, setForm] = useState<FormState>(emptyForm(userName, initialStatement, initialSourceDocumentId))
  const [existingReqId, setExistingReqId] = useState<string | null>(null)
  const [savedDbId, setSavedDbId] = useState<string | null>(null)

  // Parent link state: what the DB currently has vs what the user selected
  const [originalParentIds, setOriginalParentIds] = useState<string[]>(initialParentIds)
  const [selectedParentIds, setSelectedParentIds] = useState<string[]>(initialParentIds)
  const [childRequirements, setChildRequirements] = useState<RequirementStub[]>([])

  const [allRequirements, setAllRequirements] = useState<RequirementListItem[]>([])
  const [sourceDocs, setSourceDocs] = useState<SourceDocumentListItem[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Attachments (only available on saved requirements)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)

  // "Add Child" dropdown state
  const [showChildMenu, setShowChildMenu] = useState(false)
  const childMenuRef = useRef<HTMLDivElement>(null)
  // "Link Existing" inline picker state
  const [linkingExisting, setLinkingExisting] = useState(false)
  const [linkingIds, setLinkingIds] = useState<string[]>([])
  const [linkingSaving, setLinkingSaving] = useState(false)

  // Conflict records state
  const [conflictRecords, setConflictRecords] = useState<ConflictRecord[]>([])
  const [showFlagConflict, setShowFlagConflict] = useState(false)
  const [conflictForm, setConflictForm] = useState({ description: '', requirement_ids: [] as string[] })
  const [conflictSaving, setConflictSaving] = useState(false)
  const [conflictError, setConflictError] = useState<string | null>(null)

  // Stale flag (separate from form state — not editable by users directly)
  const [reqStale, setReqStale] = useState(false)

  // Block-linked body (Stage 15)
  const [contentSource, setContentSource] = useState<'manual' | 'block_linked'>('manual')
  const [linkedBlocks, setLinkedBlocks] = useState<LinkedBlock[]>([])

  // Archive state
  const [isArchived, setIsArchived] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  // Gap analysis state
  const [gapAnalysis, setGapAnalysis] = useState<GapAnalysisResult | null>(null)
  const [gapLoading, setGapLoading] = useState(false)
  const [gapError, setGapError] = useState<string | null>(null)
  const [showGaps, setShowGaps] = useState(false)

  // Discipline transfer dialog
  const [showTransfer, setShowTransfer] = useState(false)
  const [transferTarget, setTransferTarget] = useState('')
  const [transferring, setTransferring] = useState(false)
  const [transferError, setTransferError] = useState<string | null>(null)

  // Superseded-by banner (populated when loading an existing superseded requirement)
  const [supersededByReqId, setSupersededByReqId] = useState<string | null>(null)
  const [supersededById, setSupersededById] = useState<string | null>(null)

  // -------------------------------------------------------------------------
  // Load on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (isNew) {
      void Promise.all([fetchAllRequirements(), fetchSourceDocuments({ includeArchived: true }), fetchSites(), fetchUnits()]).then(
        ([reqs, docs, s, u]) => {
          setAllRequirements(reqs)
          setSourceDocs(docs)
          setSites(s)
          setUnits(u)
        },
      )
    } else {
      const loadAll = async () => {
        try {
          const [req, reqs, docs, s, u, atts] = await Promise.all([
            fetchRequirement(requirementId!),
            fetchAllRequirements(),
            fetchSourceDocuments({ includeArchived: true }),
            fetchSites(),
            fetchUnits(),
            fetchAttachments(requirementId!),
          ])
          setForm(formFromDetail(req))
          setReqStale(req.stale ?? false)
          setExistingReqId(req.requirement_id)
          setSavedDbId(req.id)

          const parentIds = req.parent_requirements.map((p) => p.id)
          setOriginalParentIds(parentIds)
          setSelectedParentIds(parentIds)
          setChildRequirements(req.child_requirements)

          setAllRequirements(reqs)
          setSourceDocs(docs)
          setSites(s)
          setUnits(u)
          setAttachments(atts)
          setConflictRecords(req.conflict_records ?? [])
          setSupersededByReqId(req.superseded_by_req_id ?? null)
          setSupersededById(req.superseded_by_id ?? null)
          setContentSource(req.content_source ?? 'manual')
          setLinkedBlocks(req.linked_blocks ?? [])
          setIsArchived(req.archived ?? false)
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Failed to load requirement')
        } finally {
          setLoading(false)
        }
      }
      void loadAll()
    }
  }, [isNew, requirementId])

  // -------------------------------------------------------------------------
  // Field updater
  // -------------------------------------------------------------------------

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  // -------------------------------------------------------------------------
  // Save: scalar fields first, then sync parent links
  // -------------------------------------------------------------------------

  const handleSave = async () => {
    if (!form.title.trim()) {
      setError('Title is required.')
      return
    }
    if (contentSource === 'manual' && !form.statement.trim()) {
      setError('Statement is required.')
      return
    }
    if (form.source_type === 'Derived from Document' && !form.source_document_id) {
      setError('Source Document is required when Source Type is "Derived from Document".')
      return
    }

    setSaving(true)
    setError(null)

    const payload = {
      ...form,
      // Optional UUID fields — send undefined (omitted) rather than '' so
      // Pydantic doesn't try to parse an empty string as a UUID.
      source_document_id: form.source_document_id || undefined,
      source_clause: form.source_clause || undefined,
      last_modified_by: form.last_modified_by || undefined,
      last_modified_date: form.last_modified_date || undefined,
      change_history: form.change_history || undefined,
      rationale: form.rationale || undefined,
      comments: form.comments || undefined,
      verification_method: form.verification_method || undefined,
      // Empty string means "no subtype" — send null so the DB stores NULL
      classification_subtype: form.classification_subtype || null,
    }

    try {
      let savedId: string
      if (isNew) {
        const created = await createRequirement(payload)
        savedId = created.id
      } else {
        const updated = await updateRequirement(requirementId!, payload)
        savedId = updated.id
      }

      // Sync parent links against what was in the DB before this save
      const linkError = await syncParentLinks(
        savedId,
        originalParentIds,
        selectedParentIds,
      )
      if (linkError) {
        setError(`Requirement saved, but link update failed: ${linkError}`)
        setSaving(false)
        return
      }

      setSaving(false)
      onSaved(savedId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      setSaving(false)
    }
  }

  // Close the "Add Child" dropdown when the user clicks anywhere outside it
  useEffect(() => {
    if (!showChildMenu) return
    const handler = (e: MouseEvent) => {
      if (childMenuRef.current && !childMenuRef.current.contains(e.target as Node)) {
        setShowChildMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showChildMenu])

  // -------------------------------------------------------------------------
  // Link an existing requirement as a child of the current one
  // -------------------------------------------------------------------------

  const handleLinkExisting = async () => {
    if (!savedDbId || linkingIds.length === 0) return
    setLinkingSaving(true)
    setError(null)
    try {
      for (const childId of linkingIds) {
        await addLink(savedDbId, childId)
      }
      // Re-fetch just the detail to refresh the child list without a full reload
      const updated = await fetchRequirement(requirementId!)
      setChildRequirements(updated.child_requirements)
      setLinkingExisting(false)
      setLinkingIds([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to link requirement')
    } finally {
      setLinkingSaving(false)
    }
  }

  // -------------------------------------------------------------------------
  // Build the options list for the parent search — exclude self and SELF-000
  // (SELF-000 is already filtered out of allRequirements by the list endpoint)
  // -------------------------------------------------------------------------

  const parentOptions: RequirementStub[] = allRequirements
    .filter((r) => r.id !== savedDbId)
    .map((r) => ({ id: r.id, requirement_id: r.requirement_id, title: r.title }))

  // Options for "Link Existing" child picker — exclude self and already-linked children
  // -------------------------------------------------------------------------
  // Attachment handlers
  // -------------------------------------------------------------------------

  const handleUploadAttachment = async (file: File) => {
    if (!savedDbId) return
    setUploadingAttachment(true)
    setAttachmentError(null)
    try {
      const att = await uploadAttachment(savedDbId, file, userName || undefined)
      setAttachments((prev) => [...prev, att])
    } catch (e) {
      setAttachmentError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploadingAttachment(false)
    }
  }

  const handleDeleteAttachment = async (id: string) => {
    setAttachmentError(null)
    try {
      await deleteAttachment(id)
      setAttachments((prev) => prev.filter((a) => a.id !== id))
    } catch (e) {
      setAttachmentError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  const linkedChildIds = new Set(childRequirements.map((c: RequirementStub) => c.id))
  const childLinkOptions: RequirementStub[] = allRequirements
    .filter((r) => r.id !== savedDbId && !linkedChildIds.has(r.id))
    .map((r) => ({ id: r.id, requirement_id: r.requirement_id, title: r.title }))

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
      {/* Header / breadcrumb */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0 flex-wrap">
        <button onClick={onCancel} className="text-sm text-blue-600 hover:underline">
          ← {backLabel}
        </button>
        <span className="text-gray-400">/</span>
        <span className="text-sm font-medium text-gray-700">
          {isNew ? 'New Requirement' : (existingReqId ?? requirementId)}
        </span>

        <div className="ml-auto flex gap-2 flex-wrap">
          {/* "View in Tree" only makes sense for saved requirements */}
          {!isNew && savedDbId && (
            <button
              onClick={() => onViewInTree(savedDbId)}
              className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
            >
              View in Tree
            </button>
          )}
          {!isNew && savedDbId && (
            <div ref={childMenuRef} className="relative">
              <button
                onClick={() => setShowChildMenu((v: boolean) => !v)}
                className="px-3 py-1.5 text-sm border border-blue-300 text-blue-600 rounded hover:bg-blue-50 flex items-center gap-1"
              >
                + Add Child
                <span className="text-blue-400 text-xs">▾</span>
              </button>
              {showChildMenu && (
                <div className="absolute right-0 top-9 z-30 bg-white border border-gray-200 rounded shadow-lg min-w-48 py-1">
                  <button
                    onClick={() => { setShowChildMenu(false); onAddChild(savedDbId) }}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <span className="font-medium">Create New</span>
                    <span className="block text-xs text-gray-400 mt-0.5">
                      Open a blank form pre-linked to this requirement
                    </span>
                  </button>
                  <div className="border-t border-gray-100" />
                  <button
                    onClick={() => { setShowChildMenu(false); setLinkingExisting(true) }}
                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <span className="font-medium">Link Existing</span>
                    <span className="block text-xs text-gray-400 mt-0.5">
                      Assign an existing requirement as a child
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
          {!isNew && (
            <button
              onClick={() => { setTransferTarget(''); setTransferError(null); setShowTransfer(true) }}
              className="px-3 py-1.5 text-sm border border-orange-200 text-orange-700 rounded hover:bg-orange-50"
              title="Transfer this requirement to a different discipline (creates a new ID)"
            >
              Transfer Discipline
            </button>
          )}
          {!isNew && (
            <button
              onClick={async () => {
                if (!savedDbId) return
                setArchiving(true)
                setArchiveError(null)
                try {
                  await archiveRequirement(savedDbId, !isArchived)
                  if (!isArchived) {
                    // Archiving — navigate away (requirement disappears from list)
                    onCancel()
                  } else {
                    // Restoring — stay on the page, update badge
                    setIsArchived(false)
                  }
                } catch (e) {
                  setArchiveError(e instanceof Error ? e.message : 'Archive failed')
                } finally {
                  setArchiving(false)
                }
              }}
              disabled={archiving}
              className={
                isArchived
                  ? 'px-3 py-1.5 text-sm border border-green-300 text-green-700 rounded hover:bg-green-50 disabled:opacity-50'
                  : 'px-3 py-1.5 text-sm border border-red-200 text-red-600 rounded hover:bg-red-50 disabled:opacity-50'
              }
              title={isArchived ? 'Restore this requirement to active workflows' : 'Archive this requirement (soft delete)'}
            >
              {archiving ? '…' : isArchived ? 'Restore' : 'Archive'}
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

      {/* Stale banner */}
      {reqStale && (
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-sm text-amber-800 flex items-center gap-2 shrink-0">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span className="flex-1">
            <strong>Stale requirement</strong> — the source document this was derived from has been revised.
            Review this requirement against the new revision and update or re-approve as needed.
          </span>
          <button
            onClick={async () => {
              if (!savedDbId) return
              try {
                await updateRequirement(savedDbId, { stale: false })
                setReqStale(false)
              } catch { /* ignore — non-critical */ }
            }}
            className="ml-2 px-2.5 py-1 text-xs bg-amber-100 border border-amber-300 text-amber-800 rounded hover:bg-amber-200 shrink-0"
          >
            Mark as Reviewed
          </button>
        </div>
      )}

      {/* Superseded banner */}
      {supersededByReqId && (
        <div className="px-4 py-2 bg-orange-50 border-b border-orange-200 text-sm text-orange-800 flex items-center gap-2 shrink-0">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 110 20A10 10 0 0112 2z" />
          </svg>
          <span className="flex-1">
            This requirement was transferred to{' '}
            <button
              onClick={() => supersededById && onSaved(supersededById)}
              className="font-mono font-semibold underline hover:text-orange-900"
            >
              {supersededByReqId}
            </button>
            {' '}— it is now <strong>Superseded</strong>.
          </span>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}
      {archiveError && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {archiveError}
        </div>
      )}

      {/* Archived banner */}
      {isArchived && (
        <div className="px-4 py-2 bg-gray-100 border-b border-gray-300 text-sm text-gray-600 flex items-center gap-2 shrink-0">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8" />
          </svg>
          <span>This requirement is <strong>archived</strong> — it is hidden from the requirements table and exports. Use the Restore button to make it active again.</span>
        </div>
      )}

      {/* Form body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-4xl space-y-6">

          {/* Identity */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Identity
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Field label="Title" required>
                  <TextInput
                    value={form.title}
                    onChange={(v) => set('title', v)}
                    placeholder="Short descriptive title"
                  />
                </Field>
              </div>
              <Field label="Classification" required>
                <SelectInput
                  value={form.classification}
                  options={CLASSIFICATIONS}
                  onChange={(v) => {
                    set('classification', v)
                    set('classification_subtype', '')  // clear subtype when classification changes
                  }}
                />
              </Field>
              <Field label="Classification Subtype">
                <select
                  value={form.classification_subtype}
                  onChange={(e) => set('classification_subtype', e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                >
                  <option value="">— None —</option>
                  {(CLASSIFICATION_SUBTYPES[form.classification] ?? []).map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </Field>
              <Field label="Discipline" required>
                <SelectInput
                  value={form.discipline}
                  options={DISCIPLINES}
                  onChange={(v) => set('discipline', v)}
                />
              </Field>
              <Field label="Status" required>
                <SelectInput
                  value={form.status}
                  options={STATUSES}
                  onChange={(v) => set('status', v)}
                />
              </Field>
              <Field label="Source Type" required>
                <SelectInput
                  value={form.source_type}
                  options={SOURCE_TYPES}
                  onChange={(v) => set('source_type', v)}
                />
              </Field>

              {/* Source document fields — shown for all requirements but
                  required when source_type = "Derived from Document" */}
              <div className="col-span-2">
                <Field label={`Source Document${form.source_type === 'Derived from Document' ? ' *' : ''}`}>
                  <div className="flex gap-2">
                    <select
                      value={form.source_document_id}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => set('source_document_id', e.target.value)}
                      className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                    >
                      <option value="">— None —</option>
                      {sourceDocs
                        .filter((d) => !d.archived || d.id === form.source_document_id)
                        .map((d: SourceDocumentListItem) => (
                          <option key={d.id} value={d.id}>
                            {d.document_id} — {d.title}{d.archived ? ' [Archived]' : ''}
                          </option>
                        ))}
                    </select>
                    {form.source_document_id && onOpenDocument && (
                      <button
                        type="button"
                        onClick={() => onOpenDocument(form.source_document_id)}
                        className="px-3 py-2 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50 shrink-0"
                        title="Open document"
                      >
                        Open
                      </button>
                    )}
                    {form.source_document_id && sourceDocs.find((d) => d.id === form.source_document_id)?.archived && (
                      <span className="px-2 py-1 text-xs bg-gray-100 text-gray-500 border border-gray-300 rounded shrink-0">
                        Archived
                      </span>
                    )}
                  </div>
                </Field>
              </div>
              <div className="col-span-2">
                <Field label="Source Clause">
                  <TextInput
                    value={form.source_clause}
                    onChange={(v) => set('source_clause', v)}
                    placeholder="§ 4.3.1, Table 2, etc."
                  />
                </Field>
              </div>
            </div>
          </section>

          {/* Traceability */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Traceability
            </h2>
            <div className="space-y-4">
              <Field label="Parent Requirement(s)">
                <p className="text-xs text-gray-400 mb-1.5">
                  Leave blank to imply Self-Derived (no upstream source).
                </p>
                <RequirementSearch
                  options={parentOptions}
                  selectedIds={selectedParentIds}
                  onChange={setSelectedParentIds}
                  placeholder="Search requirements to set as parents…"
                />
              </Field>

              {/* Child requirements: read-only list + optional "Link Existing" picker */}
              <Field label="Child Requirements">
                {childRequirements.length === 0 && !linkingExisting ? (
                  <p className="text-sm text-gray-400 italic">
                    No child requirements yet. Use "+ Add Child" above to add one.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {childRequirements.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        onClick={() => onSaved(child.id)}
                        className="px-2.5 py-1 bg-indigo-50 text-indigo-700 text-xs rounded border border-indigo-200 font-mono hover:bg-indigo-100 transition-colors"
                        title={child.title}
                      >
                        {child.requirement_id}
                      </button>
                    ))}
                  </div>
                )}

                {/* Inline picker — shown when user chose "Link Existing" */}
                {linkingExisting && (
                  <div className="mt-2 p-3 border border-blue-200 rounded bg-blue-50 space-y-2">
                    <p className="text-xs font-semibold text-blue-700">
                      Select one or more requirements to link as children:
                    </p>
                    <RequirementSearch
                      options={childLinkOptions}
                      selectedIds={linkingIds}
                      onChange={setLinkingIds}
                      placeholder="Search by ID or title…"
                    />
                    <div className="flex gap-2 justify-end pt-1">
                      <button
                        type="button"
                        onClick={() => { setLinkingExisting(false); setLinkingIds([]) }}
                        className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded hover:bg-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleLinkExisting()}
                        disabled={linkingIds.length === 0 || linkingSaving}
                        className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                      >
                        {linkingSaving ? 'Linking…' : `Link ${linkingIds.length > 0 ? `(${linkingIds.length})` : ''}`}
                      </button>
                    </div>
                  </div>
                )}
              </Field>
            </div>
          </section>

          {/* Statement */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Requirement Statement
            </h2>
            {contentSource === 'block_linked' ? (
              <div>
                {/* Badge row */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">
                    Linked to source document
                  </span>
                  {form.source_document_id && onOpenDocument && (
                    <button
                      type="button"
                      onClick={() => onOpenDocument(form.source_document_id, linkedBlocks.map((b) => b.id))}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      View source document →
                    </button>
                  )}
                </div>
                {/* Block content rendered from linked blocks — editable inline */}
                <div className="border border-purple-200 rounded p-3 bg-purple-50/40">
                  <BlockRenderer
                    blocks={linkedBlocks}
                    onBlockSaved={(blockId, content, tableData) => {
                      setLinkedBlocks((prev) =>
                        prev.map((b) =>
                          b.id === blockId ? { ...b, content, table_data: tableData } : b
                        )
                      )
                    }}
                    onBlockRemoved={async (blockId) => {
                      if (!savedDbId) return
                      const result = await removeRequirementBlock(savedDbId, blockId)
                      setLinkedBlocks(result.linked_blocks)
                      setContentSource(result.content_source)
                    }}
                  />
                </div>
                {/* Add block picker */}
                {savedDbId && form.source_document_id && (
                  <AddBlockPicker
                    requirementId={savedDbId}
                    sourceDocumentId={form.source_document_id}
                    linkedBlockIds={linkedBlocks.map((b) => b.id)}
                    onBlockAdded={(result) => {
                      setLinkedBlocks(result.linked_blocks)
                      setContentSource(result.content_source)
                    }}
                  />
                )}
              </div>
            ) : (
              <Field label="Statement" required>
                <textarea
                  value={form.statement}
                  onChange={(e) => set('statement', e.target.value)}
                  rows={5}
                  placeholder="The system shall…"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
                />
              </Field>
            )}
            <div className="mt-4">
              <Field label="Rationale">
                <textarea
                  value={form.rationale}
                  onChange={(e) => set('rationale', e.target.value)}
                  rows={3}
                  placeholder="Why does this requirement exist?"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
                />
              </Field>
            </div>
            <div className="mt-4">
              <Field label="Comments">
                <p className="text-xs text-gray-400 mb-1">Notes, discussion, or context — not included in formal exports</p>
                <textarea
                  value={form.comments}
                  onChange={(e) => set('comments', e.target.value)}
                  rows={3}
                  placeholder="Working notes, open questions, reviewer feedback…"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
                />
              </Field>
            </div>
          </section>

          {/* Verification */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Verification
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Verification Method">
                <select
                  value={form.verification_method}
                  onChange={(e) => set('verification_method', e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                >
                  <option value="">— Not specified —</option>
                  {VERIFICATION_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </section>

          {/* Applicability */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Applicability
            </h2>
            <div className="grid grid-cols-2 gap-6">
              <div className="col-span-2">
                <Field label="Hierarchy Nodes">
                  <HierarchyNodePicker
                    nodes={hierarchyNodes}
                    selectedIds={form.hierarchy_node_ids}
                    onChange={(ids) => set('hierarchy_node_ids', ids)}
                  />
                </Field>
              </div>
              <Field label="Sites">
                <MultiSelectInput
                  label="sites"
                  options={sites}
                  selectedIds={form.site_ids}
                  onChange={(ids) => set('site_ids', ids)}
                />
              </Field>
              <Field label="Applicable Units">
                <MultiSelectInput
                  label="units"
                  options={units}
                  selectedIds={form.unit_ids}
                  onChange={(ids) => set('unit_ids', ids)}
                />
              </Field>
            </div>
          </section>

          {/* Ownership */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Ownership &amp; Dates
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Owner" required>
                <TextInput value={form.owner} onChange={(v) => set('owner', v)} />
              </Field>
              <Field label="Created By" required>
                <TextInput value={form.created_by} onChange={(v) => set('created_by', v)} />
              </Field>
              <Field label="Created Date" required>
                <input
                  type="date"
                  value={form.created_date}
                  onChange={(e) => set('created_date', e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </Field>
              <Field label="Last Modified By">
                <TextInput
                  value={form.last_modified_by}
                  onChange={(v) => set('last_modified_by', v)}
                />
              </Field>
              <Field label="Last Modified Date">
                <input
                  type="date"
                  value={form.last_modified_date}
                  onChange={(e) => set('last_modified_date', e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </Field>
            </div>
          </section>

          {/* Additional */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Additional
            </h2>
            <div className="space-y-4">
              <Field label="Tags">
                <TagInput tags={form.tags} onChange={(t) => set('tags', t)} />
              </Field>
              <Field label="Change History">
                <textarea
                  value={form.change_history}
                  onChange={(e) => set('change_history', e.target.value)}
                  rows={3}
                  placeholder="Rev A — initial release; Rev B — updated to reflect P&ID rev 4"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
                />
              </Field>
            </div>
          </section>

          {/* Gap Analysis — only for saved requirements */}
          {savedDbId && (
            <section>
              <div className="flex items-center justify-between mb-4 pb-1 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  Flow-Down Gap Analysis
                </h2>
                <button
                  type="button"
                  onClick={async () => {
                    if (showGaps) { setShowGaps(false); return }
                    setGapLoading(true)
                    setGapError(null)
                    try {
                      const result = await fetchGapAnalysis(savedDbId)
                      setGapAnalysis(result)
                      setShowGaps(true)
                    } catch (e) {
                      setGapError(e instanceof Error ? e.message : 'Gap analysis failed')
                    } finally {
                      setGapLoading(false)
                    }
                  }}
                  disabled={gapLoading}
                  className="px-3 py-1 text-xs border border-indigo-300 text-indigo-600 rounded hover:bg-indigo-50 disabled:opacity-50"
                >
                  {gapLoading ? 'Analyzing…' : showGaps ? 'Hide' : 'Analyze Flow-Down Gaps'}
                </button>
              </div>

              {gapError && <p className="text-sm text-red-600 mb-3">{gapError}</p>}

              {showGaps && gapAnalysis && (
                <div className="space-y-4">
                  <p className="text-xs text-gray-400">
                    Showing hierarchy nodes tagged with <strong>{gapAnalysis.requirement.discipline}</strong> discipline (or universal).
                    {gapAnalysis.requirement.classification_subtype && (
                      <> Requirement type: <strong>{gapAnalysis.requirement.classification_subtype}</strong>.</>
                    )}
                    {' '}Covered = at least one direct child requirement assigned to that node.
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    {/* Covered */}
                    <div>
                      <p className="text-xs font-semibold text-green-700 mb-2 flex items-center gap-1">
                        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                        Covered ({gapAnalysis.covered.length})
                      </p>
                      {gapAnalysis.covered.length === 0 ? (
                        <p className="text-xs text-gray-400 italic">None</p>
                      ) : (
                        <div className="space-y-1">
                          {gapAnalysis.covered.map((n) => (
                            <GapNodeRow key={n.id} node={n} covered />
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Gaps */}
                    <div>
                      <p className="text-xs font-semibold text-amber-700 mb-2 flex items-center gap-1">
                        <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
                        Gaps ({gapAnalysis.gaps.length})
                      </p>
                      {gapAnalysis.gaps.length === 0 ? (
                        <p className="text-xs text-gray-400 italic">No gaps — full coverage!</p>
                      ) : (
                        <div className="space-y-1">
                          {gapAnalysis.gaps.map((n) => (
                            <GapNodeRow
                              key={n.id}
                              node={n}
                              covered={false}
                              onCreateChild={
                                onCreateChildForGap
                                  ? () => onCreateChildForGap(savedDbId!, n.id)
                                  : undefined
                              }
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Conflict Records — only available on saved requirements */}
          {savedDbId && (
            <section>
              <div className="flex items-center justify-between mb-4 pb-1 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                  Conflict Records
                  {conflictRecords.filter((c) => c.status === 'Open').length > 0 && (
                    <span className="ml-2 px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded-full font-medium">
                      {conflictRecords.filter((c) => c.status === 'Open').length} open
                    </span>
                  )}
                </h2>
                {!showFlagConflict && (
                  <button
                    type="button"
                    onClick={() => { setShowFlagConflict(true); setConflictError(null) }}
                    className="px-3 py-1 text-xs border border-red-300 text-red-600 rounded hover:bg-red-50"
                  >
                    + Flag Conflict
                  </button>
                )}
              </div>

              {conflictError && (
                <p className="text-sm text-red-600 mb-3">{conflictError}</p>
              )}

              {/* Flag conflict form */}
              {showFlagConflict && (
                <div className="mb-4 p-4 border border-red-200 rounded bg-red-50 space-y-3">
                  <p className="text-xs font-semibold text-red-700">
                    Describe the conflict and select the other requirement(s) involved:
                  </p>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Description *</label>
                    <textarea
                      value={conflictForm.description}
                      onChange={(e) => setConflictForm((f) => ({ ...f, description: e.target.value }))}
                      rows={3}
                      placeholder="e.g. MECH-003 specifies 120 psig design pressure but PROC-007 specifies 150 psig for the same equipment."
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 resize-y"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Other conflicting requirement(s) *</label>
                    <RequirementSearch
                      options={allRequirements.filter((r) => r.id !== savedDbId)}
                      selectedIds={conflictForm.requirement_ids}
                      onChange={(ids) => setConflictForm((f) => ({ ...f, requirement_ids: ids }))}
                      placeholder="Search by ID or title…"
                    />
                  </div>
                  <div className="flex gap-2 justify-end pt-1">
                    <button
                      type="button"
                      onClick={() => { setShowFlagConflict(false); setConflictForm({ description: '', requirement_ids: [] }); setConflictError(null) }}
                      className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded hover:bg-white"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={conflictSaving || !conflictForm.description.trim() || conflictForm.requirement_ids.length === 0}
                      onClick={async () => {
                        setConflictSaving(true)
                        setConflictError(null)
                        try {
                          const cr = await createConflictRecord({
                            description: conflictForm.description.trim(),
                            requirement_ids: [savedDbId!, ...conflictForm.requirement_ids],
                            created_by: form.created_by || userName,
                          })
                          setConflictRecords((prev) => [cr, ...prev])
                          setShowFlagConflict(false)
                          setConflictForm({ description: '', requirement_ids: [] })
                        } catch (e) {
                          setConflictError(e instanceof Error ? e.message : 'Failed to create conflict record')
                        } finally {
                          setConflictSaving(false)
                        }
                      }}
                      className="px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                    >
                      {conflictSaving ? 'Saving…' : 'Save Conflict'}
                    </button>
                  </div>
                </div>
              )}

              {/* Conflict list */}
              {conflictRecords.length === 0 && !showFlagConflict && (
                <p className="text-sm text-gray-400 italic">No conflicts flagged.</p>
              )}
              <div className="space-y-3">
                {conflictRecords.map((cr) => (
                  <ConflictRecordCard
                    key={cr.id}
                    record={cr}
                    currentRequirementId={savedDbId!}
                    onNavigate={onSaved}
                    onUpdate={async (update) => {
                      try {
                        const updated = await updateConflictRecord(cr.id, update)
                        setConflictRecords((prev) => prev.map((r) => r.id === cr.id ? updated : r))
                      } catch (e) {
                        setConflictError(e instanceof Error ? e.message : 'Update failed')
                      }
                    }}
                    onDelete={async () => {
                      try {
                        await deleteConflictRecord(cr.id)
                        setConflictRecords((prev) => prev.filter((r) => r.id !== cr.id))
                      } catch (e) {
                        setConflictError(e instanceof Error ? e.message : 'Delete failed')
                      }
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Attachments — only available on saved requirements */}
          {savedDbId && (
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
                Attachments
              </h2>

              {attachmentError && (
                <p className="text-sm text-red-600 mb-3">{attachmentError}</p>
              )}

              {attachments.length === 0 && !uploadingAttachment && (
                <p className="text-sm text-gray-400 italic mb-3">No attachments yet.</p>
              )}

              {attachments.length > 0 && (
                <ul className="divide-y divide-gray-100 border border-gray-200 rounded mb-3">
                  {attachments.map((att: Attachment) => (
                    <li key={att.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50">
                      <span className="text-gray-400 text-base">📎</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-800 truncate font-medium">{att.file_name}</p>
                        <p className="text-xs text-gray-400">
                          {att.file_size != null ? formatBytes(att.file_size) : ''}
                          {att.uploaded_by ? ` · ${att.uploaded_by}` : ''}
                          {att.uploaded_at ? ` · ${new Date(att.uploaded_at).toLocaleDateString()}` : ''}
                        </p>
                      </div>
                      <a
                        href={attachmentDownloadUrl(att.id)}
                        download={att.file_name}
                        className="px-2.5 py-1 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50 shrink-0"
                      >
                        Download
                      </a>
                      <button
                        type="button"
                        onClick={() => void handleDeleteAttachment(att.id)}
                        className="px-2 py-1 text-xs text-red-400 hover:text-red-600 shrink-0"
                        title="Remove attachment"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <label className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm border rounded cursor-pointer ${
                uploadingAttachment
                  ? 'border-gray-200 text-gray-400 bg-gray-50 cursor-not-allowed'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}>
                <input
                  type="file"
                  className="sr-only"
                  disabled={uploadingAttachment}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void handleUploadAttachment(f)
                    e.target.value = ''
                  }}
                />
                {uploadingAttachment ? 'Uploading…' : '+ Attach File'}
              </label>
            </section>
          )}

        </div>
      </div>

      {/* ---- Transfer Discipline modal ---- */}
      {showTransfer && savedDbId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">Transfer Discipline</h2>
            <p className="text-sm text-gray-600">
              Select the target discipline. A new requirement will be created under the new discipline prefix,
              and <strong>{existingReqId}</strong> will be marked as <strong>Superseded</strong>.
              All traceability links, conflict records, and attachments will be carried over.
            </p>

            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                New Discipline
              </label>
              <select
                value={transferTarget}
                onChange={(e) => setTransferTarget(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
              >
                <option value="">— Select discipline —</option>
                {DISCIPLINES.filter((d) => d !== form.discipline).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>

            {transferTarget && (
              <div className="bg-orange-50 border border-orange-200 rounded px-3 py-2 text-sm text-orange-800">
                <strong>{existingReqId}</strong> → new ID under <strong>{transferTarget}</strong>
                {' '}(auto-assigned on save)
              </div>
            )}

            {transferError && (
              <p className="text-sm text-red-600">{transferError}</p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowTransfer(false)}
                className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                disabled={!transferTarget || transferring}
                onClick={async () => {
                  if (!transferTarget || !savedDbId) return
                  setTransferring(true)
                  setTransferError(null)
                  try {
                    const newReq = await transferDiscipline(savedDbId, transferTarget)
                    setShowTransfer(false)
                    onSaved(newReq.id)
                  } catch (e) {
                    setTransferError(e instanceof Error ? e.message : 'Transfer failed')
                  } finally {
                    setTransferring(false)
                  }
                }}
                className="px-4 py-1.5 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
              >
                {transferring ? 'Transferring…' : 'Confirm Transfer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Gap analysis node row
// ---------------------------------------------------------------------------

const DISC_BADGE_COLORS: Record<string, string> = {
  'Mechanical':        'bg-blue-100 text-blue-700',
  'Electrical':        'bg-amber-100 text-amber-700',
  'I&C':               'bg-purple-100 text-purple-700',
  'Civil/Structural':  'bg-orange-100 text-orange-700',
  'Process':           'bg-green-100 text-green-700',
  'Fire Protection':   'bg-red-100 text-red-700',
  'General':           'bg-gray-100 text-gray-500',
}

function GapNodeRow({
  node,
  covered,
  onCreateChild,
}: {
  node: GapNodeStub
  covered: boolean
  onCreateChild?: () => void
}) {
  return (
    <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs ${
      covered
        ? 'border-green-200 bg-green-50'
        : 'border-amber-200 bg-amber-50'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${covered ? 'bg-green-500' : 'bg-amber-400'}`} />
      <span className="flex-1 text-gray-800 leading-tight">{node.name}</span>
      {node.applicable_disciplines.length > 0 && (
        <span className="flex gap-0.5 shrink-0">
          {node.applicable_disciplines.map((d) => (
            <span
              key={d}
              className={`text-[9px] font-semibold px-1 py-0.5 rounded ${DISC_BADGE_COLORS[d] ?? 'bg-gray-100 text-gray-500'}`}
            >
              {d.slice(0, 4).toUpperCase()}
            </span>
          ))}
        </span>
      )}
      {!covered && onCreateChild && (
        <button
          type="button"
          onClick={onCreateChild}
          className="ml-1 px-2 py-0.5 text-[10px] bg-indigo-600 text-white rounded hover:bg-indigo-700 shrink-0"
        >
          + Child
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Conflict record card
// ---------------------------------------------------------------------------

const CONFLICT_STATUS_CLASSES: Record<string, string> = {
  Open: 'bg-red-100 text-red-700',
  'Under Discussion': 'bg-yellow-100 text-yellow-800',
  Resolved: 'bg-green-100 text-green-800',
  Deferred: 'bg-gray-100 text-gray-600',
}

const CONFLICT_STATUSES = ['Open', 'Under Discussion', 'Resolved', 'Deferred']

function ConflictRecordCard({
  record,
  currentRequirementId,
  onNavigate,
  onUpdate,
  onDelete,
}: {
  record: ConflictRecord
  currentRequirementId: string
  onNavigate: (id: string) => void
  onUpdate: (update: { status?: string; resolution_notes?: string }) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [editingNotes, setEditingNotes] = useState(false)
  const [notes, setNotes] = useState(record.resolution_notes ?? '')
  const [saving, setSaving] = useState(false)

  const showNotes = record.status === 'Resolved' || record.status === 'Deferred'
  const otherReqs = record.requirements.filter((r) => r.id !== currentRequirementId)

  return (
    <div className="border border-gray-200 rounded p-3 space-y-2 bg-white">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-gray-800 flex-1">{record.description}</p>
        <button
          type="button"
          onClick={async () => {
            if (confirm('Remove this conflict record?')) await onDelete()
          }}
          className="text-xs text-gray-400 hover:text-red-500 shrink-0 mt-0.5"
          title="Remove"
        >
          ×
        </button>
      </div>

      {/* Linked requirements */}
      {otherReqs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {otherReqs.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onNavigate(r.id)}
              className="px-2 py-0.5 bg-indigo-50 text-indigo-700 text-xs rounded border border-indigo-200 font-mono hover:bg-indigo-100"
              title={r.title}
            >
              {r.requirement_id}
            </button>
          ))}
        </div>
      )}

      {/* Status selector */}
      <div className="flex items-center gap-2">
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${CONFLICT_STATUS_CLASSES[record.status] ?? 'bg-gray-100 text-gray-600'}`}>
          {record.status}
        </span>
        <select
          value={record.status}
          onChange={async (e) => {
            setSaving(true)
            await onUpdate({ status: e.target.value })
            setSaving(false)
          }}
          disabled={saving}
          className="text-xs border border-gray-300 rounded px-2 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
        >
          {CONFLICT_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span className="text-xs text-gray-400 ml-auto">by {record.created_by}</span>
      </div>

      {/* Resolution notes — shown when Resolved or Deferred */}
      {showNotes && (
        <div>
          {editingNotes ? (
            <div className="space-y-1">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Describe how this conflict was resolved…"
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
              />
              <div className="flex gap-1 justify-end">
                <button
                  type="button"
                  onClick={() => { setEditingNotes(false); setNotes(record.resolution_notes ?? '') }}
                  className="px-2 py-1 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
                >Cancel</button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true)
                    await onUpdate({ resolution_notes: notes })
                    setEditingNotes(false)
                    setSaving(false)
                  }}
                  className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >Save</button>
              </div>
            </div>
          ) : (
            <div
              className="text-xs text-gray-600 cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5 -mx-1"
              onClick={() => setEditingNotes(true)}
              title="Click to edit resolution notes"
            >
              {record.resolution_notes
                ? record.resolution_notes
                : <span className="text-gray-400 italic">Add resolution notes…</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
