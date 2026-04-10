import { useEffect, useState } from 'react'
import { fetchOrphans } from '../api/search'
import type { OrphanRequirement } from '../types'

const DISCIPLINES = [
  'Mechanical',
  'Electrical',
  'I&C',
  'Civil/Structural',
  'Process',
  'Fire Protection',
  'General',
]

const STATUSES = ['Draft', 'Under Review', 'Approved']

interface Props {
  onOpenRequirement: (id: string) => void
}

export default function OrphanReport({ onOpenRequirement }: Props) {
  const [orphans, setOrphans] = useState<OrphanRequirement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [disciplineFilter, setDisciplineFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchOrphans({
        discipline: disciplineFilter || undefined,
        status: statusFilter || undefined,
      })
      setOrphans(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load orphan report')
    } finally {
      setLoading(false)
    }
  }

  // Reload whenever filters change
  useEffect(() => { void load() }, [disciplineFilter, statusFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 bg-white shrink-0">
        <div>
          <span className="text-sm font-semibold text-gray-700">Orphan Report</span>
          <span className="ml-2 text-xs text-gray-400">
            Requirements with no real parent (Self-Derived only) assigned to a system node
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Discipline filter */}
          <select
            value={disciplineFilter}
            onChange={(e) => setDisciplineFilter(e.target.value)}
            className="border border-gray-300 rounded px-2.5 py-1.5 text-xs bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
          >
            <option value="">All disciplines</option>
            {DISCIPLINES.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-gray-300 rounded px-2.5 py-1.5 text-xs bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
          >
            <option value="">Active statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <button
            onClick={() => void load()}
            className="px-3 py-1.5 text-xs bg-gray-100 text-gray-600 border border-gray-300 rounded hover:bg-gray-200"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
            Loading…
          </div>
        ) : error ? (
          <div className="p-6 text-sm text-red-600">{error}</div>
        ) : orphans.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400">
            <svg className="w-10 h-10 mb-3 text-green-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-gray-500">No orphan requirements found</p>
            <p className="text-xs text-gray-400 mt-1">All requirements have real upstream parents — traceability looks healthy.</p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 sticky top-0">
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-28">ID</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Title</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-28">Classification</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-36">Subtype</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-24">Discipline</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-24">Status</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider w-32">Owner</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Hierarchy Nodes</th>
              </tr>
            </thead>
            <tbody>
              {orphans.map((req) => (
                <tr
                  key={req.id}
                  className="border-b border-gray-100 hover:bg-amber-50 cursor-pointer"
                  onClick={() => onOpenRequirement(req.id)}
                >
                  <td className="px-4 py-2.5 font-mono text-xs text-blue-600 font-semibold">
                    {req.requirement_id}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-800">{req.title}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">{req.classification}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 italic">
                    {req.classification_subtype ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">{req.discipline}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      req.status === 'Approved' ? 'bg-green-100 text-green-700'
                      : req.status === 'Under Review' ? 'bg-yellow-100 text-yellow-700'
                      : 'bg-gray-100 text-gray-600'
                    }`}>
                      {req.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">{req.owner}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {req.hierarchy_nodes.map((n) => (
                        <span key={n.id} className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 rounded border border-blue-100">
                          {n.name}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer count */}
      {!loading && !error && orphans.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-200 bg-gray-50 shrink-0">
          <span className="text-xs text-amber-600 font-medium">
            {orphans.length} orphan{orphans.length !== 1 ? 's' : ''} found — click a row to open the requirement and add a parent.
          </span>
        </div>
      )}
    </div>
  )
}
