import { useEffect, useRef, useState } from 'react'
import { exportRequirementsDocument, fetchRequirementsFiltered, type FilterConfig } from '../api/requirements'
import { fetchSites, fetchUnits } from '../api/requirements'
import { fetchSourceDocuments } from '../api/sourceDocuments'
import {
  createSavedFilter,
  deleteSavedFilter,
  fetchSavedFilters,
  type SavedFilter,
} from '../api/savedFilters'
import type { HierarchyNode, RequirementListItem, Site, Unit, SourceDocumentListItem } from '../types'

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
      // Restore saved order + settings, add any new columns at the end
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

const STATUS_CLASSES: Record<string, string> = {
  Draft: 'bg-gray-100 text-gray-700',
  'Under Review': 'bg-yellow-100 text-yellow-800',
  Approved: 'bg-green-100 text-green-800',
  Superseded: 'bg-orange-100 text-orange-800',
  Withdrawn: 'bg-red-100 text-red-800',
}

// Enum options matching the backend
const STATUSES = ['Draft', 'Under Review', 'Approved', 'Superseded', 'Withdrawn']
const CLASSIFICATIONS = ['Requirement', 'Guideline']
const SOURCE_TYPES = ['Manual Entry', 'Derived from Document']
const DISCIPLINES = ['Mechanical', 'Electrical', 'I&C', 'Civil/Structural', 'Process', 'Fire Protection', 'General']

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
    f.status?.length ||
    f.classification ||
    f.discipline?.length ||
    f.owner ||
    f.source_type ||
    f.source_document_id ||
    f.hierarchy_node_id ||
    f.site_id?.length ||
    f.unit_id?.length ||
    f.tags?.length ||
    f.created_date_from ||
    f.created_date_to ||
    f.modified_date_from ||
    f.modified_date_to ||
    f.has_open_conflicts !== undefined ||
    f.classification_subtype ||
    f.stale !== undefined
  )
}

const EMPTY_FILTERS: FilterConfig = {}
// On first load, hide terminal statuses — users can clear this to see everything.
const DEFAULT_FILTERS: FilterConfig = { status: ['Draft', 'Under Review', 'Approved'] }

// ---------------------------------------------------------------------------
// Cell renderer
// ---------------------------------------------------------------------------

function renderCell(col: string, req: RequirementListItem): React.ReactNode {
  switch (col) {
    case 'requirement_id':
      return (
        <span className="flex items-center gap-1">
          {req.stale && (
            <span
              className="inline-block w-2 h-2 rounded-full bg-amber-400 shrink-0"
              title="Stale — source document has been revised"
            />
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
    case 'stale':
      return req.stale
        ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Stale</span>
        : <span className="text-gray-400 text-xs">—</span>
    default:
      return <span className="text-sm text-gray-700">{String(req[col as keyof RequirementListItem] ?? '—')}</span>
  }
}

// ---------------------------------------------------------------------------
// Multi-checkbox dropdown (reusable for status, discipline, etc.)
// ---------------------------------------------------------------------------

function MultiCheckDropdown({
  label,
  options,
  selected,
  onChange,
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
  nodes,
  selectedId,
  includeDescendants,
  onChangeId,
  onChangeDescendants,
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
              <input
                type="radio"
                checked={!selectedId}
                onChange={() => onChangeId('')}
              />
              <span className="text-sm text-gray-500 italic">Any node</span>
            </label>
            {flat.map((n) => (
              <label
                key={n.id}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer"
                style={{ paddingLeft: `${12 + n.depth * 14}px` }}
              >
                <input
                  type="radio"
                  checked={selectedId === n.id}
                  onChange={() => onChangeId(n.id)}
                />
                <span className="text-sm text-gray-700">{n.name}</span>
              </label>
            ))}
          </div>
          {selectedId && (
            <div className="border-t border-gray-100 px-3 py-2 shrink-0 bg-white">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeDescendants}
                  onChange={(e) => onChangeDescendants(e.target.checked)}
                  className="rounded"
                />
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
  /** Pre-seed the hierarchy filter and open the filter bar (used by Block Diagram "View all requirements" links) */
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

  // Drag-and-drop column reorder state
  const [dragColKey, setDragColKey] = useState<string | null>(null)
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null)

  // Resize tracking ref (avoids re-render per pixel)
  const resizingRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null)

  const [sortKey, setSortKey] = useState<string>('requirement_id')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  // Filter state — pre-seed hierarchy filter when navigated from the block diagram
  const [filters, setFilters] = useState<FilterConfig>(
    initialHierarchyNodeId
      ? { ...DEFAULT_FILTERS, hierarchy_node_id: initialHierarchyNodeId, include_descendants: true }
      : DEFAULT_FILTERS
  )
  const [ownerInput, setOwnerInput] = useState('')
  const [showFilterBar, setShowFilterBar] = useState(!!initialHierarchyNodeId)

  // Reference data for filter dropdowns
  const [sites, setSites] = useState<Site[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [sourceDocs, setSourceDocs] = useState<SourceDocumentListItem[]>([])

  // Saved filters
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const [showSavePrompt, setShowSavePrompt] = useState(false)
  const [saveFilterName, setSaveFilterName] = useState('')

  // Export menu
  const [showExportMenu, setShowExportMenu] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  // -------------------------------------------------------------------------
  // Load reference data on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    void Promise.all([fetchSites(), fetchUnits(), fetchSourceDocuments(), fetchSavedFilters()])
      .then(([s, u, docs, sf]) => {
        setSites(s)
        setUnits(u)
        setSourceDocs(docs)
        setSavedFilters(sf)
      })
  }, [])

  // -------------------------------------------------------------------------
  // Load requirements when page or filters change
  // -------------------------------------------------------------------------

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

  // Close export menu when clicking outside
  useEffect(() => {
    if (!showExportMenu) return
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showExportMenu])

  // -------------------------------------------------------------------------
  // Filter helpers
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Saved filter actions
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Sort
  // -------------------------------------------------------------------------

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sorted = [...items].sort((a, b) => {
    const av = String(a[sortKey as keyof RequirementListItem] ?? '')
    const bv = String(b[sortKey as keyof RequirementListItem] ?? '')
    return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
  })

  const toggleColumn = (key: string) => {
    setColumns((cols) => cols.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))
  }

  // Persist column state whenever it changes
  useEffect(() => {
    saveColumns(columns)
  }, [columns])

  // -------------------------------------------------------------------------
  // Column drag-and-drop reorder
  // -------------------------------------------------------------------------

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
  const handleColDragEnd = () => {
    setDragColKey(null)
    setDropTargetKey(null)
  }

  // -------------------------------------------------------------------------
  // Column resize
  // -------------------------------------------------------------------------

  const handleResizeMouseDown = (e: React.MouseEvent, key: string, currentWidth: number) => {
    e.stopPropagation()  // don't trigger sort
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

  const visibleColumns = columns.filter((c) => c.visible)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-full">

      {/* ------------------------------------------------------------------ */}
      {/* Saved filter quick-access bar                                        */}
      {/* ------------------------------------------------------------------ */}
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

      {/* ------------------------------------------------------------------ */}
      {/* Toolbar                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex items-center gap-2 px-4 py-3 bg-white border-b border-gray-200 shrink-0 flex-wrap">
        <span className="text-sm text-gray-500">
          {total} requirement{total !== 1 ? 's' : ''}
          {active && <span className="ml-1 text-blue-600 font-medium">(filtered)</span>}
        </span>

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
            <button
              onClick={clearFilters}
              className="px-2.5 py-1.5 text-xs border border-gray-300 text-gray-500 rounded hover:bg-gray-50"
            >
              Clear filters
            </button>
            {!showSavePrompt && (
              <button
                onClick={() => setShowSavePrompt(true)}
                className="px-2.5 py-1.5 text-xs border border-indigo-300 text-indigo-600 rounded hover:bg-indigo-50"
              >
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
                <button
                  onClick={() => void handleSaveFilter()}
                  className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
                >
                  Save
                </button>
                <button
                  onClick={() => { setShowSavePrompt(false); setSaveFilterName('') }}
                  className="px-2 py-1 text-xs border border-gray-300 text-gray-500 rounded hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}

        <div className="ml-auto flex gap-2 relative">
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
          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setShowExportMenu((v) => !v)}
              className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 border border-gray-300 rounded hover:bg-gray-200 flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export
            </button>
            {showExportMenu && (
              <div className="absolute right-0 top-full mt-1 w-40 bg-white border border-gray-200 rounded shadow-lg z-50">
                <button
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => {
                    setShowExportMenu(false)
                    exportRequirementsDocument({ ...filters, format: 'word', doc_title: 'Requirements Document' })
                  }}
                >
                  Download Word (.docx)
                </button>
                <button
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={() => {
                    setShowExportMenu(false)
                    exportRequirementsDocument({ ...filters, format: 'pdf', doc_title: 'Requirements Document' })
                  }}
                >
                  Download PDF
                </button>
              </div>
            )}
          </div>
          <button
            onClick={onCreateNew}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            + Create Requirement
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Filter bar — shown when toggled open                                 */}
      {/* ------------------------------------------------------------------ */}
      {showFilterBar && (
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 shrink-0">
          <div className="flex flex-wrap gap-2 items-center">

            <MultiCheckDropdown
              label="Status"
              options={STATUSES}
              selected={filters.status ?? []}
              onChange={(v) => setFilter('status', v.length ? v : undefined)}
            />

            <MultiCheckDropdown
              label="Discipline"
              options={DISCIPLINES}
              selected={filters.discipline ?? []}
              onChange={(v) => setFilter('discipline', v.length ? v : undefined)}
            />

            {/* Classification single-select */}
            <select
              value={filters.classification ?? ''}
              onChange={(e) => setFilter('classification', e.target.value || undefined)}
              className={`px-2.5 py-1.5 text-xs border rounded bg-white ${
                filters.classification ? 'border-blue-400 text-blue-700' : 'border-gray-300 text-gray-600'
              }`}
            >
              <option value="">Classification</option>
              {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>

            {/* Source type single-select */}
            <select
              value={filters.source_type ?? ''}
              onChange={(e) => setFilter('source_type', e.target.value || undefined)}
              className={`px-2.5 py-1.5 text-xs border rounded bg-white ${
                filters.source_type ? 'border-blue-400 text-blue-700' : 'border-gray-300 text-gray-600'
              }`}
            >
              <option value="">Source Type</option>
              {SOURCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>

            {/* Source document single-select */}
            <select
              value={filters.source_document_id ?? ''}
              onChange={(e) => setFilter('source_document_id', e.target.value || undefined)}
              className={`px-2.5 py-1.5 text-xs border rounded bg-white max-w-48 ${
                filters.source_document_id ? 'border-blue-400 text-blue-700' : 'border-gray-300 text-gray-600'
              }`}
            >
              <option value="">Source Document</option>
              {sourceDocs.map((d) => (
                <option key={d.id} value={d.id}>{d.document_id}</option>
              ))}
            </select>

            {/* Sites multi-check */}
            <MultiCheckDropdown
              label="Site"
              options={sites.map((s) => s.name)}
              selected={(filters.site_id ?? []).map((id) => sites.find((s) => s.id === id)?.name ?? id)}
              onChange={(names) => setFilter('site_id', names.length ? names.map((n) => sites.find((s) => s.name === n)!.id) : undefined)}
            />

            {/* Units multi-check */}
            <MultiCheckDropdown
              label="Unit"
              options={units.map((u) => u.name)}
              selected={(filters.unit_id ?? []).map((id) => units.find((u) => u.id === id)?.name ?? id)}
              onChange={(names) => setFilter('unit_id', names.length ? names.map((n) => units.find((u) => u.name === n)!.id) : undefined)}
            />

            {/* Hierarchy node picker */}
            <HierarchyFilterPicker
              nodes={hierarchyNodes}
              selectedId={filters.hierarchy_node_id ?? ''}
              includeDescendants={filters.include_descendants ?? false}
              onChangeId={(id) => setFilter('hierarchy_node_id', id || undefined)}
              onChangeDescendants={(v) => setFilter('include_descendants', v)}
            />

            {/* Owner text search */}
            <input
              type="text"
              value={ownerInput}
              onChange={(e) => {
                setOwnerInput(e.target.value)
                setFilter('owner', e.target.value || undefined)
              }}
              placeholder="Owner…"
              className={`px-2.5 py-1.5 text-xs border rounded w-28 focus:outline-none focus:ring-1 focus:ring-blue-400 ${
                filters.owner ? 'border-blue-400' : 'border-gray-300'
              }`}
            />

            {/* Date range filters */}
            <div className="flex items-center gap-1 text-xs text-gray-500">
              <span>Created</span>
              <input
                type="date"
                value={filters.created_date_from ?? ''}
                onChange={(e) => setFilter('created_date_from', e.target.value || undefined)}
                className={`px-1.5 py-1 text-xs border rounded ${filters.created_date_from ? 'border-blue-400' : 'border-gray-300'}`}
              />
              <span>–</span>
              <input
                type="date"
                value={filters.created_date_to ?? ''}
                onChange={(e) => setFilter('created_date_to', e.target.value || undefined)}
                className={`px-1.5 py-1 text-xs border rounded ${filters.created_date_to ? 'border-blue-400' : 'border-gray-300'}`}
              />
            </div>

            {/* Open conflicts filter */}
            <label className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded cursor-pointer ${
              filters.has_open_conflicts !== undefined
                ? 'border-red-400 bg-red-50 text-red-700'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}>
              <input
                type="checkbox"
                checked={filters.has_open_conflicts === true}
                onChange={(e) => setFilter('has_open_conflicts', e.target.checked ? true : undefined)}
                className="rounded"
              />
              Has active conflicts
            </label>

            {/* Stale filter */}
            <label className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded cursor-pointer ${
              filters.stale !== undefined
                ? 'border-amber-400 bg-amber-50 text-amber-700'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}>
              <input
                type="checkbox"
                checked={filters.stale === true}
                onChange={(e) => setFilter('stale', e.target.checked ? true : undefined)}
                className="rounded"
              />
              Stale only
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

      {/* ------------------------------------------------------------------ */}
      {/* Table                                                                */}
      {/* ------------------------------------------------------------------ */}
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
          <table className="text-left border-collapse" style={{ tableLayout: 'fixed', width: `${visibleColumns.reduce((s, c) => s + c.width, 0)}px`, minWidth: '100%' }}>
            <colgroup>
              {visibleColumns.map((col) => (
                <col key={col.key} style={{ width: `${col.width}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 sticky top-0">
                {visibleColumns.map((col) => (
                  <th
                    key={col.key}
                    draggable
                    onDragStart={() => handleColDragStart(col.key)}
                    onDragOver={(e) => handleColDragOver(e, col.key)}
                    onDrop={() => handleColDrop(col.key)}
                    onDragEnd={handleColDragEnd}
                    onClick={() => handleSort(col.key)}
                    className={`px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none whitespace-nowrap hover:bg-gray-100 relative ${
                      dropTargetKey === col.key ? 'border-l-2 border-blue-400' : ''
                    } ${dragColKey === col.key ? 'opacity-50' : ''}`}
                    style={{ width: `${col.width}px` }}
                  >
                    {col.label}
                    {sortKey === col.key && (
                      <span className="ml-1 text-blue-500">{sortDir === 'asc' ? '↑' : '↓'}</span>
                    )}
                    {/* Resize handle */}
                    <div
                      onMouseDown={(e) => handleResizeMouseDown(e, col.key, col.width)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-300 opacity-0 hover:opacity-100"
                      title="Drag to resize"
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((req, i) => (
                <tr
                  key={req.id}
                  onClick={() => onOpenDetail(req.id)}
                  className={`border-b border-gray-100 cursor-pointer hover:bg-blue-50 transition-colors ${
                    i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
                  }`}
                >
                  {visibleColumns.map((col) => (
                    <td key={col.key} className="px-3 py-2 align-top overflow-hidden" style={{ maxWidth: `${col.width}px` }}>{renderCell(col.key, req)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 px-4 py-3 bg-white border-t border-gray-200 shrink-0 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1 border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50"
          >
            ← Prev
          </button>
          <span className="text-gray-600">Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1 border border-gray-300 rounded disabled:opacity-40 hover:bg-gray-50"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}
