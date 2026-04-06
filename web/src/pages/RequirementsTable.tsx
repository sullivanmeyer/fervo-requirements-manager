import { useEffect, useState } from 'react'
import { fetchRequirements } from '../api/requirements'
import type { HierarchyNode, RequirementListItem } from '../types'
import RequirementDetail from './RequirementDetail'

// ---------------------------------------------------------------------------
// Column definition
// ---------------------------------------------------------------------------

interface Column {
  key: string
  label: string
  visible: boolean
}

const DEFAULT_COLUMNS: Column[] = [
  { key: 'requirement_id', label: 'ID', visible: true },
  { key: 'title', label: 'Title', visible: true },
  { key: 'classification', label: 'Classification', visible: true },
  { key: 'owner', label: 'Owner', visible: true },
  { key: 'status', label: 'Status', visible: true },
  { key: 'discipline', label: 'Discipline', visible: true },
  { key: 'hierarchy_nodes', label: 'Hierarchy Nodes', visible: true },
  { key: 'sites', label: 'Site', visible: true },
  { key: 'units', label: 'Applicable Units', visible: true },
  { key: 'created_by', label: 'Created By', visible: true },
  { key: 'created_date', label: 'Created Date', visible: true },
]

// ---------------------------------------------------------------------------
// Status badge colors
// (Each status gets a distinct color so a reviewer can scan the table fast)
// ---------------------------------------------------------------------------

const STATUS_CLASSES: Record<string, string> = {
  Draft: 'bg-gray-100 text-gray-700',
  'Under Review': 'bg-yellow-100 text-yellow-800',
  Approved: 'bg-green-100 text-green-800',
  Superseded: 'bg-orange-100 text-orange-800',
  Withdrawn: 'bg-red-100 text-red-800',
}

// ---------------------------------------------------------------------------
// Cell renderer
// ---------------------------------------------------------------------------

function renderCell(col: string, req: RequirementListItem): React.ReactNode {
  switch (col) {
    case 'requirement_id':
      return (
        <span className="font-mono text-xs font-medium text-blue-700">
          {req.requirement_id}
        </span>
      )
    case 'status': {
      const cls = STATUS_CLASSES[req.status] ?? 'bg-gray-100 text-gray-700'
      return (
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
          {req.status}
        </span>
      )
    }
    case 'hierarchy_nodes':
      return req.hierarchy_nodes.length === 0 ? (
        <span className="text-gray-400 italic text-xs">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {req.hierarchy_nodes.map((n) => (
            <span
              key={n.id}
              className="px-1.5 py-0.5 bg-blue-50 text-blue-700 text-xs rounded"
            >
              {n.name}
            </span>
          ))}
        </div>
      )
    case 'sites':
      return req.sites.length === 0 ? (
        <span className="text-gray-400 italic text-xs">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {req.sites.map((s) => (
            <span
              key={s.id}
              className="px-1.5 py-0.5 bg-purple-50 text-purple-700 text-xs rounded"
            >
              {s.name}
            </span>
          ))}
        </div>
      )
    case 'units':
      return req.units.length === 0 ? (
        <span className="text-gray-400 italic text-xs">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {req.units.map((u) => (
            <span
              key={u.id}
              className="px-1.5 py-0.5 bg-teal-50 text-teal-700 text-xs rounded"
            >
              {u.name}
            </span>
          ))}
        </div>
      )
    default:
      return (
        <span className="text-sm text-gray-700">
          {String(req[col as keyof RequirementListItem] ?? '—')}
        </span>
      )
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  hierarchyNodes: HierarchyNode[]
  userName: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RequirementsTable({ hierarchyNodes, userName }: Props) {
  const [items, setItems] = useState<RequirementListItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 50

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [columns, setColumns] = useState<Column[]>(DEFAULT_COLUMNS)
  const [showColMenu, setShowColMenu] = useState(false)

  // Sort state: key is a column key, direction is asc or desc
  const [sortKey, setSortKey] = useState<string>('requirement_id')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  // Detail view: null = table, string = requirement id being viewed/created
  const [detailId, setDetailId] = useState<string | null>(null)
  // 'new' is used as a sentinel when creating a new requirement
  const [isCreating, setIsCreating] = useState(false)

  const load = async (p = page) => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchRequirements(p, PAGE_SIZE)
      setItems(data.items)
      setTotal(data.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load requirements')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(page)
  }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // -------------------------------------------------------------------------
  // Column visibility toggle
  // -------------------------------------------------------------------------

  const toggleColumn = (key: string) => {
    setColumns((cols) =>
      cols.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)),
    )
  }

  const visibleColumns = columns.filter((c) => c.visible)

  // -------------------------------------------------------------------------
  // Detail view
  // -------------------------------------------------------------------------

  if (detailId !== null || isCreating) {
    return (
      <RequirementDetail
        requirementId={isCreating ? null : detailId}
        hierarchyNodes={hierarchyNodes}
        userName={userName}
        onSaved={() => {
          setDetailId(null)
          setIsCreating(false)
          void load(page)
        }}
        onCancel={() => {
          setDetailId(null)
          setIsCreating(false)
        }}
      />
    )
  }

  // -------------------------------------------------------------------------
  // Table view
  // -------------------------------------------------------------------------

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0">
        <span className="text-sm text-gray-500">
          {total} requirement{total !== 1 ? 's' : ''}
        </span>
        <div className="ml-auto flex gap-2 relative">
          {/* Column toggle */}
          <button
            onClick={() => setShowColMenu((v) => !v)}
            className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
          >
            Columns
          </button>
          {showColMenu && (
            <div className="absolute right-20 top-9 z-30 bg-white border border-gray-200 rounded shadow-lg p-3 min-w-48">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                Visible columns
              </p>
              {columns.map((col) => (
                <label
                  key={col.key}
                  className="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-50 px-1 rounded"
                >
                  <input
                    type="checkbox"
                    checked={col.visible}
                    onChange={() => toggleColumn(col.key)}
                    className="rounded"
                  />
                  <span className="text-sm text-gray-700">{col.label}</span>
                </label>
              ))}
            </div>
          )}
          {/* Create */}
          <button
            onClick={() => setIsCreating(true)}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            + Create Requirement
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700 flex items-center gap-3">
          {error}
          <button
            onClick={() => void load(page)}
            className="underline text-red-600"
          >
            Retry
          </button>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400">
            <p className="text-base font-medium">No requirements yet</p>
            <p className="text-sm mt-1">
              Click "Create Requirement" to add the first one.
            </p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 sticky top-0">
                {visibleColumns.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className="px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer select-none whitespace-nowrap hover:bg-gray-100"
                  >
                    {col.label}
                    {sortKey === col.key && (
                      <span className="ml-1 text-blue-500">
                        {sortDir === 'asc' ? '↑' : '↓'}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((req, i) => (
                <tr
                  key={req.id}
                  onClick={() => setDetailId(req.id)}
                  className={`border-b border-gray-100 cursor-pointer hover:bg-blue-50 transition-colors ${
                    i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
                  }`}
                >
                  {visibleColumns.map((col) => (
                    <td key={col.key} className="px-3 py-2 align-top">
                      {renderCell(col.key, req)}
                    </td>
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
          <span className="text-gray-600">
            Page {page} of {totalPages}
          </span>
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
