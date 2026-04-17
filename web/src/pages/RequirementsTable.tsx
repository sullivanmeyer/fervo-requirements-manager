import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import {
  bulkUpdateRequirements,
  exportRequirementsDocument,
  fetchRequirementsFiltered,
  fetchSites,
  fetchUnits,
  updateRequirement,
  type FilterConfig,
} from '../api/requirements'
import { fetchSourceDocuments } from '../api/sourceDocuments'
import {
  createSavedFilter,
  deleteSavedFilter,
  fetchSavedFilters,
  type SavedFilter,
} from '../api/savedFilters'
import type { HierarchyNode, RequirementListItem, RequirementUpdatePayload, Site, Unit, SourceDocumentListItem } from '../types'

// ---------------------------------------------------------------------------
// Column definition
// ---------------------------------------------------------------------------

interface Column {
  key: string
  label: string
  visible: boolean
  width: number
}

const DEFAULT_COLUMNS: Column[] = [
  { key: 'requirement_id', label: 'ID', visible: true, width: 100 },
  { key: 'title', label: 'Title', visible: true, width: 260 },
  { key: 'classification', label: 'Classification', visible: true, width: 120 },
  { key: 'owner', label: 'Owner', visible: true, width: 120 },
  { key: 'status', label: 'Status', visible: true, width: 120 },
  { key: 'discipline', label: 'Discipline', visible: true, width: 130 },
  { key: 'hierarchy_nodes', label: 'Hierarchy Nodes', visible: true, width: 200 },
  { key: 'sites', label: 'Site', visible: true, width: 120 },
  { key: 'units', label: 'Applicable Units', visible: true, width: 150 },
  { key: 'open_conflict_count', label: 'Conflicts', visible: true, width: 90 },
  { key: 'classification_subtype', label: 'Subtype', visible: false, width: 160 },
  { key: 'verification_method', label: 'Verification', visible: false, width: 150 },
  { key: 'tags', label: 'Tags', visible: false, width: 180 },
  { key: 'stale', label: 'Stale', visible: false, width: 70 },
  { key: 'created_by', label: 'Created By', visible: true, width: 120 },
  { key: 'created_date', label: 'Created Date', visible: true, width: 110 },
]

const COLUMNS_STORAGE_KEY = 'req_table_columns_v1'

function loadColumns(): Column[] {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as { key: string; visible: boolean; width: number }[]
      const result: Column[] = []
      for (const s of saved) {
        const def = DEFAULT_COLUMNS.find((d) => d.key === s.key)
        if (def) result.push({ ...def, visible: s.visible, width: s.width })
      }
      for (const def of DEFAULT_COLUMNS) {
        if (!result.find((c) => c.key === def.key)) result.push(def)
      }
      return result
    }
  } catch { /* ignore */ }
  return DEFAULT_COLUMNS
}

function saveColumns(cols: Column[]) {
  localStorage.setItem(
    COLUMNS_STORAGE_KEY,
    JSON.stringify(cols.map((c) => ({ key: c.key, visible: c.visible, width: c.width }))),
  )
}

// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------

const STATUS_CLASSES: Record<string, string> = {
  Draft: 'bg-gray-100 text-gray-700',
  'Under Review': 'bg-yellow-100 text-yellow-800',
  Approved: 'bg-green-100 text-green-800',
  Superseded: 'bg-orange-100 text-orange-800',
  Withdrawn: 'bg-red-100 text-red-800',
}

const STATUSES = ['Draft', 'Under Review', 'Approved', 'Superseded', 'Withdrawn']
const CLASSIFICATIONS = ['Requirement', 'Guideline']
const SOURCE_TYPES = ['Manual Entry', 'Derived from Document']
const DISCIPLINES = ['Mechanical', 'Electrical', 'I&C', 'Civil/Structural', 'Process', 'Fire Protection', 'General', 'Build', 'Operations']
const VERIFICATION_METHODS = ['Analysis', 'Inspection', 'Test', 'Demonstration', 'Review of Record']

const SUBTYPES_BY_CLASSIFICATION: Record<string, string[]> = {
  Requirement: ['Performance Requirement', 'Design Requirement', 'Derived Requirement', 'System Interface'],
  Guideline: ['Lesson Learned', 'Procedure', 'Code', 'Technology Selection'],
}

const ALL_SUBTYPES = [
  ...SUBTYPES_BY_CLASSIFICATION.Requirement,
  ...SUBTYPES_BY_CLASSIFICATION.Guideline,
]

// Columns that support inline editing in Edit Mode
const EDITABLE_COLS = new Set([
  'status', 'classification', 'classification_subtype',
  'owner', 'verification_method', 'tags',
  'hierarchy_nodes', 'sites', 'units',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function hasActiveFilters(f: FilterConfig): boolean {
  return !!(
    f.status?.length || f.classification || f.discipline?.length || f.owner ||
    f.source_type || f.source_document_id || f.hierarchy_node_id || f.site_id?.length ||
    f.unit_id?.length || f.tags?.length || f.created_date_from || f.created_date_to ||
    f.modified_date_from || f.modified_date_to || f.has_open_conflicts !== undefined ||
    f.classification_subtype || f.stale !== undefined || f.archived_only
  )
}

const DEFAULT_FILTERS: FilterConfig = { status: ['Draft', 'Under Review', 'Approved'] }

/** Build the PUT payload for a single inline cell save. */
function buildCellPayload(colKey: string, value: unknown): RequirementUpdatePayload {
  switch (colKey) {
    case 'status': return { status: String(value) }
    case 'classification': return { classification: String(value), classification_subtype: null }
    case 'classification_subtype': return { classification_subtype: value as string | null }
    case 'owner': return { owner: String(value) }
    case 'verification_method': return { verification_method: value as string | null }
    case 'tags': return { tags: value as string[] }
    case 'hierarchy_nodes': return { hierarchy_node_ids: value as string[] }
    case 'sites': return { site_ids: value as string[] }
    case 'units': return { unit_ids: value as string[] }
    default: return {}
  }
}

/** Read the current value for a cell from a list item (for edit initial state). */
function getCellValue(colKey: string, req: RequirementListItem): unknown {
  switch (colKey) {
    case 'hierarchy_nodes': return req.hierarchy_nodes.map((n) => n.id)
    case 'sites': return req.sites.map((s) => s.id)
    case 'units': return req.units.map((u) => u.id)
    case 'tags': return [...(req.tags ?? [])]
    case 'classification_subtype': return req.classification_subtype
    case 'verification_method': return req.verification_method
    default: return req[colKey as keyof RequirementListItem] ?? null
  }
}

// ---------------------------------------------------------------------------
// Cell renderer (display mode — unchanged from before, plus new tag/vm cases)
// ---------------------------------------------------------------------------

function renderCell(col: string, req: RequirementListItem): React.ReactNode {
  switch (col) {
    case 'requirement_id':
      return (
        <span className="flex items-center gap-1">
          {req.stale && (
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Stale — source document has been revised" />
          )}
          <span className="font-mono text-xs font-medium text-blue-700">{req.requirement_id}</span>
        </span>
      )
    case 'status': {
      const cls = STATUS_CLASSES[req.status] ?? 'bg-gray-100 text-gray-700'
      return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{req.status}</span>
    }
    case 'hierarchy_nodes':
      return req.hierarchy_nodes.length === 0 ? (
        <span className="text-gray-400 italic text-xs">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {req.hierarchy_nodes.map((n) => (
            <span key={n.id} className="px-1.5 py-0.5 bg-blue-50 text-blue-700 text-xs rounded">{n.name}</span>
          ))}
        </div>
      )
    case 'sites':
      return req.sites.length === 0 ? (
        <span className="text-gray-400 italic text-xs">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {req.sites.map((s) => (
            <span key={s.id} className="px-1.5 py-0.5 bg-purple-50 text-purple-700 text-xs rounded">{s.name}</span>
          ))}
        </div>
      )
    case 'units':
      return req.units.length === 0 ? (
        <span className="text-gray-400 italic text-xs">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {req.units.map((u) => (
            <span key={u.id} className="px-1.5 py-0.5 bg-teal-50 text-teal-700 text-xs rounded">{u.name}</span>
          ))}
        </div>
      )
    case 'open_conflict_count': {
      const count = req.open_conflict_count ?? 0
      if (count === 0) return <span className="text-gray-400 text-xs">—</span>
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
          {count} active
        </span>
      )
    }
    case 'classification_subtype':
      return req.classification_subtype
        ? <span className="text-xs text-gray-600 italic">{req.classification_subtype}</span>
        : <span className="text-gray-400 text-xs">—</span>
    case 'verification_method':
      return req.verification_method
        ? <span className="text-xs text-gray-700">{req.verification_method}</span>
        : <span className="text-gray-400 text-xs">—</span>
    case 'tags':
      return !req.tags || req.tags.length === 0 ? (
        <span className="text-gray-400 italic text-xs">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {req.tags.map((t) => (
            <span key={t} className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">{t}</span>
          ))}
        </div>
      )
    case 'stale':
      return req.stale
        ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Stale</span>
        : <span className="text-gray-400 text-xs">—</span>
    default:
      return <span className="text-sm text-gray-700">{String(req[col as keyof RequirementListItem] ?? '—')}</span>
  }
}

// ---------------------------------------------------------------------------
// Inline edit cell widget — rendered in place of the display cell
// ---------------------------------------------------------------------------

function InlineDropdown({
  value, options, nullable, onChange, onKeyDown,
}: {
  value: string | null
  options: string[]
  nullable?: boolean
  onChange: (v: string | null) => void
  onKeyDown: (e: React.KeyboardEvent) => void
}) {
  return (
    <select
      autoFocus
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      onKeyDown={onKeyDown}
      className="w-full text-xs border border-blue-400 rounded px-1 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
    >
      {nullable && <option value="">— None —</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

function InlineText({
  value, onSave, onCancel,
}: {
  value: string
  onSave: (v: string) => void
  onCancel: () => void
}) {
  const [local, setLocal] = useState(value)
  // Guard against double-save (Enter key fires save, then unmount triggers blur)
  const submitted = useRef(false)
  const submit = (v: string) => {
    if (submitted.current) return
    submitted.current = true
    onSave(v)
  }
  return (
    <input
      autoFocus
      type="text"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => submit(local)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        if (e.key === 'Enter') { e.preventDefault(); submit(local) }
        // Tab: browser moves focus → blur fires → triggers save automatically
      }}
      className="w-full text-xs border border-blue-400 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
    />
  )
}

/** Tag chip editor: chips with × + text input to add. */
function InlineTagEditor({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string[]
  onChange: (v: string[]) => void
  onSave: () => void
  onCancel: () => void
}) {
  const [input, setInput] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onSave()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onSave])

  const add = () => {
    const t = input.trim()
    if (t && !value.includes(t)) onChange([...value, t])
    setInput('')
  }

  return (
    <div ref={ref} className="flex flex-col gap-1 min-w-44 bg-white border border-blue-400 rounded p-1.5 shadow-sm">
      <div className="flex flex-wrap gap-1">
        {value.map((t) => (
          <span key={t} className="flex items-center gap-0.5 px-1.5 py-0.5 bg-gray-100 text-gray-700 text-xs rounded">
            {t}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} className="text-gray-400 hover:text-red-500 ml-0.5 leading-none">×</button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <input
          autoFocus
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add() }
            if (e.key === 'Escape') { e.preventDefault(); onCancel() }
          }}
          placeholder="Add tag…"
          className="flex-1 text-xs border border-gray-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <button type="button" onClick={add} className="text-xs px-1.5 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700">+</button>
        <button type="button" onClick={onSave} className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 border border-gray-300 rounded hover:bg-gray-200">✓</button>
      </div>
    </div>
  )
}

/** Multi-select checkbox list, rendered in a fixed portal to escape table overflow. */
function InlineMultiPicker({
  anchorRect,
  options,
  selectedIds,
  onChange,
  onClose,
}: {
  anchorRect: DOMRect
  options: { id: string; name: string; depth?: number }[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // Slight delay so the initial click that opened this doesn't immediately close it
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  const toggle = (id: string) =>
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id])

  const style: React.CSSProperties = {
    position: 'fixed',
    top: anchorRect.bottom + 2,
    left: anchorRect.left,
    zIndex: 9999,
    minWidth: 200,
    maxWidth: 320,
    maxHeight: 240,
  }

  return createPortal(
    <div ref={ref} style={style} className="bg-white border border-gray-300 rounded shadow-lg overflow-y-auto py-1">
      {options.length === 0 && <div className="px-3 py-2 text-xs text-gray-400 italic">No options</div>}
      {options.map((opt) => (
        <label
          key={opt.id}
          className="flex items-center gap-2 px-3 py-1.5 hover:bg-blue-50 cursor-pointer"
          style={opt.depth !== undefined ? { paddingLeft: `${12 + opt.depth * 14}px` } : undefined}
        >
          <input type="checkbox" checked={selectedIds.includes(opt.id)} onChange={() => toggle(opt.id)} className="rounded" />
          <span className="text-xs text-gray-700">{opt.name}</span>
        </label>
      ))}
      <div className="border-t border-gray-100 px-3 py-1.5 flex justify-end gap-1.5 bg-gray-50">
        <button type="button" onClick={onClose} className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700">Done</button>
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Multi-checkbox dropdown (reusable for filter bar)
// ---------------------------------------------------------------------------

function MultiCheckDropdown({
  label, options, selected, onChange,
}: {
  label: string
  options: string[]
  selected: string[]
  onChange: (v: string[]) => void
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

  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  const active = selected.length > 0

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((x) => !x)}
        className={`px-2.5 py-1.5 text-xs border rounded flex items-center gap-1 whitespace-nowrap ${
          active ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
        }`}
      >
        {label}
        {active && <span className="bg-blue-500 text-white rounded-full px-1.5 text-xs">{selected.length}</span>}
        <span className="text-gray-400 text-xs">▾</span>
      </button>
      {open && (
        <div className="absolute top-9 left-0 z-30 bg-white border border-gray-200 rounded shadow-lg min-w-44 py-1 max-h-64 overflow-y-auto">
          {options.map((opt) => (
            <label key={opt} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={selected.includes(opt)} onChange={() => toggle(opt)} className="rounded" />
              <span className="text-sm text-gray-700">{opt}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hierarchy node picker for filter bar
// ---------------------------------------------------------------------------

function HierarchyFilterPicker({
  nodes, selectedId, includeDescendants, onChangeId, onChangeDescendants,
}: {
  nodes: HierarchyNode[]
  selectedId: string
  includeDescendants: boolean
  onChangeId: (id: string) => void
  onChangeDescendants: (v: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const flat = flattenHierarchy(nodes)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const selected = flat.find((n) => n.id === selectedId)
  const active = !!selectedId

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((x) => !x)}
        className={`px-2.5 py-1.5 text-xs border rounded flex items-center gap-1 whitespace-nowrap ${
          active ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'
        }`}
      >
        {selected ? selected.name : 'Hierarchy Node'}
        <span className="text-gray-400 text-xs">▾</span>
      </button>
      {open && (
        <div className="absolute top-9 left-0 z-30 bg-white border border-gray-200 rounded shadow-lg w-64 flex flex-col max-h-72">
          <div className="overflow-y-auto flex-1 py-1">
            <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer border-b border-gray-100">
              <input type="radio" checked={!selectedId} onChange={() => onChangeId('')} />
              <span className="text-sm text-gray-500 italic">Any node</span>
            </label>
            {flat.map((n) => (
              <label key={n.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer" style={{ paddingLeft: `${12 + n.depth * 14}px` }}>
                <input type="radio" checked={selectedId === n.id} onChange={() => onChangeId(n.id)} />
                <span className="text-sm text-gray-700">{n.name}</span>
              </label>
            ))}
          </div>
          {selectedId && (
            <div className="border-t border-gray-100 px-3 py-2 shrink-0 bg-white">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={includeDescendants} onChange={(e) => onChangeDescendants(e.target.checked)} className="rounded" />
                <span className="text-xs text-gray-600">Include sub-components</span>
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  hierarchyNodes: HierarchyNode[]
  userName: string
  onOpenDetail: (id: string) => void
  onCreateNew: () => void
  initialHierarchyNodeId?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RequirementsTable({
  hierarchyNodes,
  userName,
  onOpenDetail,
  onCreateNew,
  initialHierarchyNodeId,
}: Props) {
  const [items, setItems] = useState<RequirementListItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 50

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [columns, setColumns] = useState<Column[]>(loadColumns)
  const [showColMenu, setShowColMenu] = useState(false)

  const [dragColKey, setDragColKey] = useState<string | null>(null)
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null)

  const resizingRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null)

  const [sortKey, setSortKey] = useState<string>('requirement_id')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const [filters, setFilters] = useState<FilterConfig>(
    initialHierarchyNodeId
      ? { ...DEFAULT_FILTERS, hierarchy_node_id: initialHierarchyNodeId, include_descendants: true }
      : DEFAULT_FILTERS
  )
  const [ownerInput, setOwnerInput] = useState('')
  const [showFilterBar, setShowFilterBar] = useState(!!initialHierarchyNodeId)

  const [sites, setSites] = useState<Site[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [sourceDocs, setSourceDocs] = useState<SourceDocumentListItem[]>([])

  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const [showSavePrompt, setShowSavePrompt] = useState(false)
  const [saveFilterName, setSaveFilterName] = useState('')

  // ── Edit Mode ──────────────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false)

  // Row selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null)

  // Active inline cell edit
  const [editCell, setEditCell] = useState<{ rowId: string; colKey: string } | null>(null)
  const [editValue, setEditValue] = useState<unknown>(null)
  const [cellSaving, setCellSaving] = useState(false)
  const [cellError, setCellError] = useState<string | null>(null)
  /** "rowId:colKey" of the last successfully saved cell — drives the green flash */
  const [flashCell, setFlashCell] = useState<string | null>(null)
  /** Ref to the <td> being edited, used to anchor the InlineMultiPicker portal */
  const editCellRef = useRef<HTMLTableCellElement | null>(null)

  // Bulk toolbar
  const [bulkField, setBulkField] = useState<string>('status')
  const [bulkValue, setBulkValue] = useState<unknown>('')
  const [bulkPending, setBulkPending] = useState<{ field: string; value: unknown; label: string } | null>(null)
  const [bulkApplying, setBulkApplying] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)

  // ── Reference data ─────────────────────────────────────────────────────────
  useEffect(() => {
    void Promise.all([fetchSites(), fetchUnits(), fetchSourceDocuments(), fetchSavedFilters()])
      .then(([s, u, docs, sf]) => {
        setSites(s)
        setUnits(u)
        setSourceDocs(docs)
        setSavedFilters(sf)
      })
  }, [])

  // ── Load requirements ──────────────────────────────────────────────────────
  const load = async (p = page, f = filters) => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchRequirementsFiltered(p, PAGE_SIZE, f)
      setItems(data.items)
      setTotal(data.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load requirements')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(page, filters)
  }, [page, filters]) // eslint-disable-line react-hooks/exhaustive-deps

  // Clear selection when filters or page change (selection is scoped to visible rows)
  useEffect(() => {
    setSelectedIds(new Set())
    setLastSelectedIdx(null)
    setEditCell(null)
  }, [filters, page])

  // ── Filter helpers ─────────────────────────────────────────────────────────
  const setFilter = <K extends keyof FilterConfig>(key: K, value: FilterConfig[K]) => {
    setPage(1)
    setFilters((f) => ({ ...f, [key]: value }))
  }

  const clearFilters = () => {
    setPage(1)
    setFilters(DEFAULT_FILTERS)
    setOwnerInput('')
  }

  const active = hasActiveFilters(filters)

  // ── Saved filters ──────────────────────────────────────────────────────────
  const handleSaveFilter = async () => {
    if (!saveFilterName.trim()) return
    try {
      const sf = await createSavedFilter(saveFilterName.trim(), filters, userName || undefined)
      setSavedFilters((prev) => [...prev, sf].sort((a, b) => a.name.localeCompare(b.name)))
      setSaveFilterName('')
      setShowSavePrompt(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save filter')
    }
  }

  const handleDeleteSavedFilter = async (id: string) => {
    try {
      await deleteSavedFilter(id)
      setSavedFilters((prev) => prev.filter((f) => f.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete filter')
    }
  }

  const applysaved = (sf: SavedFilter) => {
    setPage(1)
    setFilters(sf.filter_config)
    setOwnerInput(sf.filter_config.owner ?? '')
  }

  // ── Sort ───────────────────────────────────────────────────────────────────
  const handleSort = (key: string) => {
    if (editMode) return // ignore sort clicks in edit mode to avoid accidental trigger
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const sorted = [...items].sort((a, b) => {
    const av = String(a[sortKey as keyof RequirementListItem] ?? '')
    const bv = String(b[sortKey as keyof RequirementListItem] ?? '')
    return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
  })

  const toggleColumn = (key: string) => {
    setColumns((cols) => cols.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))
  }

  useEffect(() => { saveColumns(columns) }, [columns])

  // ── Column drag-and-drop ───────────────────────────────────────────────────
  const handleColDragStart = (key: string) => setDragColKey(key)
  const handleColDragOver = (e: React.DragEvent, key: string) => {
    e.preventDefault()
    if (key !== dragColKey) setDropTargetKey(key)
  }
  const handleColDrop = (targetKey: string) => {
    if (!dragColKey || dragColKey === targetKey) return
    setColumns((cols) => {
      const next = [...cols]
      const from = next.findIndex((c) => c.key === dragColKey)
      const to = next.findIndex((c) => c.key === targetKey)
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    setDragColKey(null)
    setDropTargetKey(null)
  }
  const handleColDragEnd = () => { setDragColKey(null); setDropTargetKey(null) }

  // ── Column resize ──────────────────────────────────────────────────────────
  const handleResizeMouseDown = (e: React.MouseEvent, key: string, currentWidth: number) => {
    e.stopPropagation()
    e.preventDefault()
    resizingRef.current = { key, startX: e.clientX, startWidth: currentWidth }

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      const delta = ev.clientX - resizingRef.current.startX
      const newWidth = Math.max(60, resizingRef.current.startWidth + delta)
      setColumns((cols) =>
        cols.map((c) => (c.key === resizingRef.current!.key ? { ...c, width: newWidth } : c)),
      )
    }
    const onMouseUp = () => {
      resizingRef.current = null
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  // ── Edit Mode toggle ───────────────────────────────────────────────────────
  const toggleEditMode = () => {
    setEditMode((prev) => {
      if (prev) {
        // Turning off — clear all edit state
        setSelectedIds(new Set())
        setLastSelectedIdx(null)
        setEditCell(null)
        setBulkPending(null)
        setBulkError(null)
      }
      return !prev
    })
  }

  // ── Row selection ──────────────────────────────────────────────────────────
  const handleCheckboxClick = (req: RequirementListItem, idx: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (e.shiftKey && lastSelectedIdx !== null) {
      const [from, to] = [Math.min(lastSelectedIdx, idx), Math.max(lastSelectedIdx, idx)]
      const rangeIds = sorted.slice(from, to + 1).map((r) => r.id)
      setSelectedIds((prev) => {
        const next = new Set(prev)
        rangeIds.forEach((id) => next.add(id))
        return next
      })
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(req.id)) next.delete(req.id)
        else next.add(req.id)
        return next
      })
      setLastSelectedIdx(idx)
    }
  }

  const allSelected = sorted.length > 0 && sorted.every((r) => selectedIds.has(r.id))
  const someSelected = sorted.some((r) => selectedIds.has(r.id))

  const handleSelectAll = () => {
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        sorted.forEach((r) => next.delete(r.id))
        return next
      })
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        sorted.forEach((r) => next.add(r.id))
        return next
      })
    }
  }

  // ── Inline cell edit ───────────────────────────────────────────────────────
  const startEdit = (rowId: string, colKey: string, tdEl: HTMLTableCellElement) => {
    if (!EDITABLE_COLS.has(colKey)) return
    const req = items.find((r) => r.id === rowId)
    if (!req) return
    editCellRef.current = tdEl
    setEditCell({ rowId, colKey })
    setEditValue(getCellValue(colKey, req))
    setCellError(null)
  }

  const cancelEdit = () => {
    setEditCell(null)
    setEditValue(null)
    setCellError(null)
    editCellRef.current = null
  }

  const saveCell = async (rowId: string, colKey: string, value: unknown) => {
    setCellSaving(true)
    setCellError(null)
    try {
      const payload = buildCellPayload(colKey, value)
      const updated = await updateRequirement(rowId, payload)
      // Merge the returned detail fields back into the list item
      setItems((prev) =>
        prev.map((r) =>
          r.id === rowId
            ? {
                ...r,
                status: updated.status,
                classification: updated.classification,
                classification_subtype: updated.classification_subtype,
                owner: updated.owner,
                verification_method: updated.verification_method,
                tags: updated.tags,
                hierarchy_nodes: updated.hierarchy_nodes,
                sites: updated.sites,
                units: updated.units,
              }
            : r,
        ),
      )
      setEditCell(null)
      setEditValue(null)
      editCellRef.current = null
      const flashKey = `${rowId}:${colKey}`
      setFlashCell(flashKey)
      setTimeout(() => setFlashCell(null), 900)
    } catch (e) {
      setCellError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setCellSaving(false)
    }
  }

  const handleCellKeyDown = (e: React.KeyboardEvent, rowId: string, colKey: string) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveCell(rowId, colKey, editValue)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      void saveCell(rowId, colKey, editValue)
      // Move to next/prev editable visible column in same row
      const editableCols = visibleColumns.filter((c) => EDITABLE_COLS.has(c.key))
      const idx = editableCols.findIndex((c) => c.key === colKey)
      const next = editableCols[e.shiftKey ? idx - 1 : idx + 1]
      if (next) {
        const tdEl = editCellRef.current?.closest('tr')?.querySelector<HTMLTableCellElement>(`[data-col="${next.key}"]`)
        if (tdEl) startEdit(rowId, next.key, tdEl)
      }
    }
  }

  // ── Bulk actions ───────────────────────────────────────────────────────────
  const selectedCount = selectedIds.size

  const confirmBulkAction = (field: string, value: unknown, label: string) => {
    if (selectedCount === 0) return
    setBulkPending({ field, value, label })
    setBulkError(null)
  }

  const applyBulkAction = async () => {
    if (!bulkPending || bulkApplying) return
    const { field, value } = bulkPending
    setBulkApplying(true)
    setBulkError(null)

    try {
      const ids = [...selectedIds]

      if (field === 'add_hierarchy_node') {
        // Append semantics: compute merged node IDs per requirement client-side
        const newNodeIds = value as string[]
        const results = await Promise.allSettled(
          ids.map((id) => {
            const req = items.find((r) => r.id === id)
            const existing = req ? req.hierarchy_nodes.map((n) => n.id) : []
            const merged = [...new Set([...existing, ...newNodeIds])]
            return updateRequirement(id, { hierarchy_node_ids: merged })
          })
        )
        // Refresh to get updated data
        await load(page, filters)
        const failed = results.filter((r) => r.status === 'rejected').length
        if (failed > 0) throw new Error(`${failed} requirement(s) failed to update`)
      } else if (field === 'add_tag') {
        // Append semantics for tags
        const newTag = String(value)
        const results = await Promise.allSettled(
          ids.map((id) => {
            const req = items.find((r) => r.id === id)
            const existing = req?.tags ?? []
            const merged = existing.includes(newTag) ? existing : [...existing, newTag]
            return updateRequirement(id, { tags: merged })
          })
        )
        await load(page, filters)
        const failed = results.filter((r) => r.status === 'rejected').length
        if (failed > 0) throw new Error(`${failed} requirement(s) failed to update`)
      } else {
        // Set semantics: use bulk PATCH endpoint
        const updates: Record<string, unknown> = {}
        if (field === 'status') updates.status = value
        else if (field === 'owner') updates.owner = value
        else if (field === 'classification') updates.classification = value
        else if (field === 'classification_subtype') updates.classification_subtype = value || null
        else if (field === 'verification_method') updates.verification_method = value || null
        else updates[field] = value

        await bulkUpdateRequirements({
          requirement_ids: ids,
          updates,
          user_name: userName || undefined,
        })
        await load(page, filters)
      }

      setSelectedIds(new Set())
      setLastSelectedIdx(null)
      setBulkPending(null)
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : 'Bulk update failed')
    } finally {
      setBulkApplying(false)
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const visibleColumns = columns.filter((c) => c.visible)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const flatHierarchy = flattenHierarchy(hierarchyNodes)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* Saved filter quick-access bar */}
      {savedFilters.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200 overflow-x-auto shrink-0">
          <span className="text-xs text-gray-400 shrink-0">Saved:</span>
          {savedFilters.map((sf) => (
            <div key={sf.id} className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => applysaved(sf)}
                className="px-2.5 py-1 text-xs bg-white border border-gray-300 rounded-l hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 transition-colors"
              >
                {sf.name}
              </button>
              <button
                onClick={() => void handleDeleteSavedFilter(sf.id)}
                className="px-1.5 py-1 text-xs bg-white border border-l-0 border-gray-300 rounded-r text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                title="Delete saved filter"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 bg-white border-b border-gray-200 shrink-0 flex-wrap">
        <span className="text-sm text-gray-500">
          {total} requirement{total !== 1 ? 's' : ''}
          {active && <span className="ml-1 text-blue-600 font-medium">(filtered)</span>}
        </span>

        {editMode && selectedIds.size > 0 && (
          <span className="px-2 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 rounded-full">
            {selectedIds.size} selected
          </span>
        )}

        <button
          onClick={() => setShowFilterBar((v) => !v)}
          className={`px-2.5 py-1.5 text-xs border rounded flex items-center gap-1 ${
            active || showFilterBar
              ? 'border-blue-400 bg-blue-50 text-blue-700'
              : 'border-gray-300 text-gray-600 hover:bg-gray-50'
          }`}
        >
          Filters
          {active && <span className="w-2 h-2 bg-blue-500 rounded-full" />}
        </button>

        {active && (
          <>
            <button onClick={clearFilters} className="px-2.5 py-1.5 text-xs border border-gray-300 text-gray-500 rounded hover:bg-gray-50">
              Clear filters
            </button>
            {!showSavePrompt && (
              <button onClick={() => setShowSavePrompt(true)} className="px-2.5 py-1.5 text-xs border border-indigo-300 text-indigo-600 rounded hover:bg-indigo-50">
                Save filter…
              </button>
            )}
            {showSavePrompt && (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={saveFilterName}
                  onChange={(e) => setSaveFilterName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveFilter() }}
                  placeholder="Filter name"
                  autoFocus
                  className="border border-gray-300 rounded px-2 py-1 text-xs w-36 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
                <button onClick={() => void handleSaveFilter()} className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700">Save</button>
                <button onClick={() => { setShowSavePrompt(false); setSaveFilterName('') }} className="px-2 py-1 text-xs border border-gray-300 text-gray-500 rounded hover:bg-gray-50">Cancel</button>
              </div>
            )}
          </>
        )}

        <div className="ml-auto flex gap-2 relative items-center">
          {/* Edit Mode toggle */}
          <button
            onClick={toggleEditMode}
            title={editMode ? 'Exit Edit Mode' : 'Enter Edit Mode — enables inline cell editing and bulk actions'}
            className={`px-3 py-1.5 text-sm border rounded flex items-center gap-1.5 transition-colors ${
              editMode
                ? 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
            {editMode ? 'Editing' : 'Edit Mode'}
          </button>

          <button
            onClick={() => setShowColMenu((v) => !v)}
            className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
          >
            Columns
          </button>
          {showColMenu && (
            <div className="absolute right-20 top-9 z-30 bg-white border border-gray-200 rounded shadow-lg p-3 min-w-48">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Visible columns</p>
              {columns.map((col) => (
                <label key={col.key} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-50 px-1 rounded">
                  <input type="checkbox" checked={col.visible} onChange={() => toggleColumn(col.key)} className="rounded" />
                  <span className="text-sm text-gray-700">{col.label}</span>
                </label>
              ))}
            </div>
          )}
          <button
            onClick={() => exportRequirementsDocument({ ...filters, doc_title: 'Requirements Document' })}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 border border-gray-300 rounded hover:bg-gray-200 flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export
          </button>
          <button onClick={onCreateNew} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
            + Create Requirement
          </button>
        </div>
      </div>

      {/* ── Bulk Action Toolbar ── shown when editMode + selection */}
      {editMode && selectedIds.size > 0 && (
        <div className="px-4 py-2.5 bg-indigo-50 border-b border-indigo-200 shrink-0">
          {bulkPending ? (
            /* Confirmation row */
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-indigo-800 font-medium">
                {bulkPending.label} on <strong>{selectedCount}</strong> requirement{selectedCount !== 1 ? 's' : ''}?
              </span>
              {bulkError && <span className="text-xs text-red-600">{bulkError}</span>}
              <div className="flex gap-2 ml-auto">
                <button
                  onClick={() => { setBulkPending(null); setBulkError(null) }}
                  disabled={bulkApplying}
                  className="px-3 py-1 text-xs border border-gray-300 bg-white text-gray-600 rounded hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void applyBulkAction()}
                  disabled={bulkApplying}
                  className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1"
                >
                  {bulkApplying && <span className="animate-spin">↻</span>}
                  Confirm
                </button>
              </div>
            </div>
          ) : (
            /* Action controls */
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-indigo-600 font-medium shrink-0">Bulk actions:</span>

              {/* Set Status */}
              <div className="flex items-center gap-1">
                <select
                  value={bulkField === 'status' ? String(bulkValue) : ''}
                  onFocus={() => { setBulkField('status'); setBulkValue(STATUSES[0]) }}
                  onChange={(e) => { setBulkField('status'); setBulkValue(e.target.value) }}
                  className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white"
                >
                  <option value="" disabled>Set Status…</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {bulkField === 'status' && bulkValue && (
                  <button
                    onClick={() => confirmBulkAction('status', bulkValue, `Set Status → "${String(bulkValue)}"`)}
                    className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  >Apply</button>
                )}
              </div>

              {/* Set Owner */}
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  placeholder="Set Owner…"
                  onFocus={() => setBulkField('owner')}
                  onChange={(e) => { setBulkField('owner'); setBulkValue(e.target.value) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && bulkField === 'owner' && bulkValue) confirmBulkAction('owner', bulkValue, `Set Owner → "${String(bulkValue)}"`) }}
                  className="text-xs border border-gray-300 rounded px-1.5 py-1 w-28 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
                {bulkField === 'owner' && bulkValue && (
                  <button
                    onClick={() => confirmBulkAction('owner', bulkValue, `Set Owner → "${String(bulkValue)}"`)}
                    className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  >Apply</button>
                )}
              </div>

              {/* Set Classification */}
              <div className="flex items-center gap-1">
                <select
                  onFocus={() => { setBulkField('classification'); setBulkValue(CLASSIFICATIONS[0]) }}
                  onChange={(e) => { setBulkField('classification'); setBulkValue(e.target.value) }}
                  className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white"
                >
                  <option value="" disabled>Set Classification…</option>
                  {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                {bulkField === 'classification' && bulkValue && (
                  <button
                    onClick={() => confirmBulkAction('classification', bulkValue, `Set Classification → "${String(bulkValue)}" (clears subtype)`)}
                    className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  >Apply</button>
                )}
              </div>

              {/* Set Subtype */}
              <div className="flex items-center gap-1">
                <select
                  onFocus={() => setBulkField('classification_subtype')}
                  onChange={(e) => { setBulkField('classification_subtype'); setBulkValue(e.target.value || null) }}
                  className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white"
                >
                  <option value="" disabled>Set Subtype…</option>
                  <option value="">— Clear subtype —</option>
                  {ALL_SUBTYPES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {bulkField === 'classification_subtype' && (
                  <button
                    onClick={() => confirmBulkAction('classification_subtype', bulkValue, bulkValue ? `Set Subtype → "${String(bulkValue)}"` : 'Clear Subtype')}
                    className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  >Apply</button>
                )}
              </div>

              {/* Set Verification Method */}
              <div className="flex items-center gap-1">
                <select
                  onFocus={() => { setBulkField('verification_method'); setBulkValue(VERIFICATION_METHODS[0]) }}
                  onChange={(e) => { setBulkField('verification_method'); setBulkValue(e.target.value) }}
                  className="text-xs border border-gray-300 rounded px-1.5 py-1 bg-white"
                >
                  <option value="" disabled>Set Verification…</option>
                  {VERIFICATION_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                {bulkField === 'verification_method' && bulkValue && (
                  <button
                    onClick={() => confirmBulkAction('verification_method', bulkValue, `Set Verification → "${String(bulkValue)}"`)}
                    className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  >Apply</button>
                )}
              </div>

              {/* Add Hierarchy Node */}
              <AddHierarchyNodeBulk
                flatNodes={flatHierarchy}
                onApply={(nodeIds, names) =>
                  confirmBulkAction('add_hierarchy_node', nodeIds, `Add Hierarchy Node(s): ${names.join(', ')}`)
                }
              />

              {/* Add Tag */}
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  placeholder="Add Tag…"
                  onFocus={() => setBulkField('add_tag')}
                  onChange={(e) => { setBulkField('add_tag'); setBulkValue(e.target.value) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && bulkField === 'add_tag' && bulkValue) confirmBulkAction('add_tag', bulkValue, `Add Tag "${String(bulkValue)}"`) }}
                  className="text-xs border border-gray-300 rounded px-1.5 py-1 w-24 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
                {bulkField === 'add_tag' && bulkValue && (
                  <button
                    onClick={() => confirmBulkAction('add_tag', bulkValue, `Add Tag "${String(bulkValue)}"`)}
                    className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  >Apply</button>
                )}
              </div>

              <button
                onClick={() => { setSelectedIds(new Set()); setLastSelectedIdx(null) }}
                className="ml-auto text-xs text-indigo-500 hover:text-indigo-700 px-2 py-1 rounded hover:bg-indigo-100 shrink-0"
              >
                Clear selection
              </button>
            </div>
          )}
        </div>
      )}

      {/* Filter bar */}
      {showFilterBar && (
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 shrink-0">
          <div className="flex flex-wrap gap-2 items-center">
            <MultiCheckDropdown label="Status" options={STATUSES} selected={filters.status ?? []} onChange={(v) => setFilter('status', v.length ? v : undefined)} />
            <MultiCheckDropdown label="Discipline" options={DISCIPLINES} selected={filters.discipline ?? []} onChange={(v) => setFilter('discipline', v.length ? v : undefined)} />
            <select value={filters.classification ?? ''} onChange={(e) => setFilter('classification', e.target.value || undefined)} className={`px-2.5 py-1.5 text-xs border rounded bg-white ${filters.classification ? 'border-blue-400 text-blue-700' : 'border-gray-300 text-gray-600'}`}>
              <option value="">Classification</option>
              {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filters.source_type ?? ''} onChange={(e) => setFilter('source_type', e.target.value || undefined)} className={`px-2.5 py-1.5 text-xs border rounded bg-white ${filters.source_type ? 'border-blue-400 text-blue-700' : 'border-gray-300 text-gray-600'}`}>
              <option value="">Source Type</option>
              {SOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={filters.source_document_id ?? ''} onChange={(e) => setFilter('source_document_id', e.target.value || undefined)} className={`px-2.5 py-1.5 text-xs border rounded bg-white max-w-48 ${filters.source_document_id ? 'border-blue-400 text-blue-700' : 'border-gray-300 text-gray-600'}`}>
              <option value="">Source Document</option>
              {sourceDocs.map((d) => <option key={d.id} value={d.id}>{d.document_id}</option>)}
            </select>
            <MultiCheckDropdown
              label="Site"
              options={sites.map((s) => s.name)}
              selected={(filters.site_id ?? []).map((id) => sites.find((s) => s.id === id)?.name ?? id)}
              onChange={(names) => setFilter('site_id', names.length ? names.map((n) => sites.find((s) => s.name === n)!.id) : undefined)}
            />
            <MultiCheckDropdown
              label="Unit"
              options={units.map((u) => u.name)}
              selected={(filters.unit_id ?? []).map((id) => units.find((u) => u.id === id)?.name ?? id)}
              onChange={(names) => setFilter('unit_id', names.length ? names.map((n) => units.find((u) => u.name === n)!.id) : undefined)}
            />
            <HierarchyFilterPicker
              nodes={hierarchyNodes}
              selectedId={filters.hierarchy_node_id ?? ''}
              includeDescendants={filters.include_descendants ?? false}
              onChangeId={(id) => setFilter('hierarchy_node_id', id || undefined)}
              onChangeDescendants={(v) => setFilter('include_descendants', v)}
            />
            <input
              type="text"
              value={ownerInput}
              onChange={(e) => { setOwnerInput(e.target.value); setFilter('owner', e.target.value || undefined) }}
              placeholder="Owner…"
              className={`px-2.5 py-1.5 text-xs border rounded w-28 focus:outline-none focus:ring-1 focus:ring-blue-400 ${filters.owner ? 'border-blue-400' : 'border-gray-300'}`}
            />
            <div className="flex items-center gap-1 text-xs text-gray-500">
              <span>Created</span>
              <input type="date" value={filters.created_date_from ?? ''} onChange={(e) => setFilter('created_date_from', e.target.value || undefined)} className={`px-1.5 py-1 text-xs border rounded ${filters.created_date_from ? 'border-blue-400' : 'border-gray-300'}`} />
              <span>–</span>
              <input type="date" value={filters.created_date_to ?? ''} onChange={(e) => setFilter('created_date_to', e.target.value || undefined)} className={`px-1.5 py-1 text-xs border rounded ${filters.created_date_to ? 'border-blue-400' : 'border-gray-300'}`} />
            </div>
            <label className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded cursor-pointer ${filters.has_open_conflicts !== undefined ? 'border-red-400 bg-red-50 text-red-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              <input type="checkbox" checked={filters.has_open_conflicts === true} onChange={(e) => setFilter('has_open_conflicts', e.target.checked ? true : undefined)} className="rounded" />
              Has active conflicts
            </label>
            <label className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded cursor-pointer ${filters.stale !== undefined ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              <input type="checkbox" checked={filters.stale === true} onChange={(e) => setFilter('stale', e.target.checked ? true : undefined)} className="rounded" />
              Stale only
            </label>
            <label className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded cursor-pointer ${filters.archived_only ? 'border-red-400 bg-red-50 text-red-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              <input type="checkbox" checked={filters.archived_only === true} onChange={(e) => setFilter('archived_only', e.target.checked ? true : undefined)} className="rounded" />
              Archived
            </label>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700 flex items-center gap-3">
          {error}
          <button onClick={() => void load(page, filters)} className="underline text-red-600">Retry</button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">Loading…</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400">
            {active ? (
              <>
                <p className="text-base font-medium">No requirements match these filters</p>
                <button onClick={clearFilters} className="mt-2 text-sm text-blue-600 underline">Clear filters</button>
              </>
            ) : (
              <>
                <p className="text-base font-medium">No requirements yet</p>
                <p className="text-sm mt-1">Click "Create Requirement" to add the first one.</p>
              </>
            )}
          </div>
        ) : (
          <table
            className="text-left border-collapse"
            style={{
              tableLayout: 'fixed',
              width: `${(editMode ? 36 : 0) + visibleColumns.reduce((s, c) => s + c.width, 0)}px`,
              minWidth: '100%',
            }}
          >
            <colgroup>
              {editMode && <col style={{ width: '36px' }} />}
              {visibleColumns.map((col) => (
                <col key={col.key} style={{ width: `${col.width}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 sticky top-0">
                {editMode && (
                  <th className="px-2 py-2.5 text-center w-9">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected }}
                      onChange={handleSelectAll}
                      className="rounded cursor-pointer"
                      title="Select / deselect all visible rows"
                    />
                  </th>
                )}
                {visibleColumns.map((col) => (
                  <th
                    key={col.key}
                    draggable={!editMode}
                    onDragStart={() => handleColDragStart(col.key)}
                    onDragOver={(e) => handleColDragOver(e, col.key)}
                    onDrop={() => handleColDrop(col.key)}
                    onDragEnd={handleColDragEnd}
                    onClick={() => handleSort(col.key)}
                    className={`px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider select-none whitespace-nowrap relative ${
                      editMode ? 'cursor-default' : 'cursor-pointer hover:bg-gray-100'
                    } ${dropTargetKey === col.key ? 'border-l-2 border-blue-400' : ''} ${dragColKey === col.key ? 'opacity-50' : ''}`}
                    style={{ width: `${col.width}px` }}
                  >
                    {col.label}
                    {sortKey === col.key && !editMode && (
                      <span className="ml-1 text-blue-500">{sortDir === 'asc' ? '↑' : '↓'}</span>
                    )}
                    {editMode && EDITABLE_COLS.has(col.key) && (
                      <span className="ml-1 text-indigo-300" title="Editable — double-click a cell">✎</span>
                    )}
                    <div
                      onMouseDown={(e) => handleResizeMouseDown(e, col.key, col.width)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-300 opacity-0 hover:opacity-100"
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((req, i) => (
                <tr
                  key={req.id}
                  onClick={editMode ? undefined : () => onOpenDetail(req.id)}
                  className={`border-b border-gray-100 transition-colors ${
                    editMode
                      ? selectedIds.has(req.id)
                        ? 'bg-indigo-50'
                        : i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
                      : `cursor-pointer hover:bg-blue-50 ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`
                  }`}
                >
                  {editMode && (
                    <td className="px-2 py-2 text-center w-9 align-middle">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(req.id)}
                        onClick={(e) => handleCheckboxClick(req, i, e)}
                        onChange={() => {/* controlled via onClick */}}
                        className="rounded cursor-pointer"
                      />
                    </td>
                  )}
                  {visibleColumns.map((col) => {
                    const isEditing = editCell?.rowId === req.id && editCell?.colKey === col.key
                    const isEditable = editMode && EDITABLE_COLS.has(col.key)
                    const flashKey = `${req.id}:${col.key}`
                    const isFlashing = flashCell === flashKey

                    return (
                      <td
                        key={col.key}
                        data-col={col.key}
                        onDoubleClick={isEditable ? (e) => startEdit(req.id, col.key, e.currentTarget) : undefined}
                        className={`px-3 py-2 align-top overflow-hidden transition-colors ${
                          isFlashing ? 'bg-green-50' : ''
                        } ${isEditing ? 'p-1' : ''} ${isEditable && !isEditing ? 'cursor-cell hover:bg-indigo-50/60' : ''}`}
                        style={{ maxWidth: `${col.width}px` }}
                      >
                        {isEditing ? (
                          <EditCellWidget
                            colKey={col.key}
                            req={req}
                            value={editValue}
                            onChange={setEditValue}
                            onSave={() => void saveCell(req.id, col.key, editValue)}
                            onSaveWithValue={(v) => void saveCell(req.id, col.key, v)}
                            onCancel={cancelEdit}
                            onKeyDown={(e) => handleCellKeyDown(e, req.id, col.key)}
                            saving={cellSaving}
                            error={cellError}
                            hierarchyNodes={flatHierarchy}
                            sites={sites}
                            units={units}
                            anchorEl={editCellRef.current}
                          />
                        ) : (
                          renderCell(col.key, req)
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 px-4 py-3 bg-white border-t border-gray-200 shrink-0 text-sm">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1 border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50">← Prev</button>
          <span className="text-gray-600">Page {page} of {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-3 py-1 border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50">Next →</button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// EditCellWidget — renders the appropriate edit control for a cell
// ---------------------------------------------------------------------------

function EditCellWidget({
  colKey,
  req,
  value,
  onChange,
  onSave,
  onCancel,
  onKeyDown,
  saving,
  error,
  hierarchyNodes,
  sites,
  units,
  anchorEl,
}: {
  colKey: string
  req: RequirementListItem
  value: unknown
  onChange: (v: unknown) => void
  onSave: () => void
  onCancel: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onSaveWithValue: (v: unknown) => void
  saving: boolean
  error: string | null
  hierarchyNodes: { id: string; name: string; depth: number }[]
  sites: Site[]
  units: Unit[]
  anchorEl: HTMLTableCellElement | null
}) {
  // Save immediately with the just-selected value.
  // We bypass editValue state here because React state updates are async —
  // the closure in `onSave` would still see the old value if we used setTimeout.
  const handleSaveImmediately = (v: unknown) => {
    onSaveWithValue(v)
  }

  switch (colKey) {
    case 'status':
      return (
        <div>
          <InlineDropdown value={String(value)} options={STATUSES} onChange={handleSaveImmediately} onKeyDown={onKeyDown} />
          {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
          {saving && <div className="text-xs text-gray-400 mt-0.5">Saving…</div>}
        </div>
      )

    case 'classification':
      return (
        <div>
          <InlineDropdown value={String(value)} options={CLASSIFICATIONS} onChange={handleSaveImmediately} onKeyDown={onKeyDown} />
          {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
        </div>
      )

    case 'classification_subtype': {
      const opts = SUBTYPES_BY_CLASSIFICATION[req.classification] ?? []
      return (
        <div>
          <InlineDropdown value={value as string | null} options={opts} nullable onChange={handleSaveImmediately} onKeyDown={onKeyDown} />
          {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
        </div>
      )
    }

    case 'verification_method':
      return (
        <div>
          <InlineDropdown value={value as string | null} options={VERIFICATION_METHODS} nullable onChange={handleSaveImmediately} onKeyDown={onKeyDown} />
          {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
        </div>
      )

    case 'owner':
      return (
        <div>
          <InlineText
            value={String(value ?? '')}
            onSave={(v) => onSaveWithValue(v)}
            onCancel={onCancel}
          />
          {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
        </div>
      )

    case 'tags':
      return (
        <div>
          <InlineTagEditor
            value={value as string[]}
            onChange={onChange}
            onSave={onSave}
            onCancel={onCancel}
          />
          {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
        </div>
      )

    case 'hierarchy_nodes': {
      const rect = anchorEl?.getBoundingClientRect()
      return rect ? (
        <div>
          <div className="text-xs text-indigo-600 italic px-1">Selecting…</div>
          <InlineMultiPicker
            anchorRect={rect}
            options={flatHierarchy}
            selectedIds={value as string[]}
            onChange={onChange}
            onClose={onSave}
          />
          {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
        </div>
      ) : null
    }

    case 'sites': {
      const rect = anchorEl?.getBoundingClientRect()
      return rect ? (
        <div>
          <div className="text-xs text-indigo-600 italic px-1">Selecting…</div>
          <InlineMultiPicker
            anchorRect={rect}
            options={sites}
            selectedIds={value as string[]}
            onChange={onChange}
            onClose={onSave}
          />
          {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
        </div>
      ) : null
    }

    case 'units': {
      const rect = anchorEl?.getBoundingClientRect()
      return rect ? (
        <div>
          <div className="text-xs text-indigo-600 italic px-1">Selecting…</div>
          <InlineMultiPicker
            anchorRect={rect}
            options={units}
            selectedIds={value as string[]}
            onChange={onChange}
            onClose={onSave}
          />
          {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
        </div>
      ) : null
    }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// AddHierarchyNodeBulk — standalone inline picker for the bulk toolbar
// ---------------------------------------------------------------------------

function AddHierarchyNodeBulk({
  flatNodes,
  onApply,
}: {
  flatNodes: { id: string; name: string; depth: number }[]
  onApply: (ids: string[], names: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
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
    setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`text-xs border rounded px-1.5 py-1 whitespace-nowrap ${
          selectedIds.length > 0
            ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
            : 'border-gray-300 text-gray-600 bg-white hover:bg-gray-50'
        }`}
      >
        Add Node{selectedIds.length > 0 ? ` (${selectedIds.length})` : '…'}
      </button>
      {selectedIds.length > 0 && (
        <button
          onClick={() => {
            const names = selectedIds.map((id) => flatNodes.find((n) => n.id === id)?.name ?? id)
            onApply(selectedIds, names)
            setSelectedIds([])
            setOpen(false)
          }}
          className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700"
        >
          Apply
        </button>
      )}
      {open && (
        <div className="absolute top-8 left-0 z-30 bg-white border border-gray-300 rounded shadow-lg max-h-48 overflow-y-auto min-w-48 py-1">
          {flatNodes.map((n) => (
            <label
              key={n.id}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-blue-50 cursor-pointer"
              style={{ paddingLeft: `${12 + n.depth * 14}px` }}
            >
              <input type="checkbox" checked={selectedIds.includes(n.id)} onChange={() => toggle(n.id)} className="rounded" />
              <span className="text-xs text-gray-700">{n.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
