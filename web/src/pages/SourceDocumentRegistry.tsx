/**
 * SourceDocumentRegistry
 *
 * Table view of all registered source documents.
 * Each row is clickable to open the document detail/edit view.
 * A "Register Document" button opens a creation form.
 */
import { useEffect, useMemo, useState } from 'react'
import { fetchSourceDocuments } from '../api/sourceDocuments'
import type { SourceDocumentListItem } from '../types'

const DOC_TYPE_CLASSES: Record<string, string> = {
  'Code/Standard': 'bg-blue-50 text-blue-700',
  'Specification': 'bg-indigo-50 text-indigo-700',
  'Technical Report': 'bg-purple-50 text-purple-700',
  'Drawing': 'bg-teal-50 text-teal-700',
  'Datasheet': 'bg-cyan-50 text-cyan-700',
  'Other': 'bg-gray-100 text-gray-600',
}

const ALL_TYPES = ['Code/Standard', 'Specification', 'Technical Report', 'Drawing', 'Datasheet', 'Other']

interface Props {
  onOpenDetail: (id: string) => void
  onCreateNew: () => void
}

export default function SourceDocumentRegistry({ onOpenDetail, onCreateNew }: Props) {
  const [items, setItems] = useState<SourceDocumentListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [hideStubs, setHideStubs] = useState(true)
  const [hideArchived, setHideArchived] = useState(true)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      // Always fetch all (including archived) so the toggle works client-side
      // without a round-trip.  The list is never large enough to matter.
      setItems(await fetchSourceDocuments({ includeArchived: true }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load documents')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const stubCount = items.filter((d) => d.is_stub).length
  const archivedCount = items.filter((d) => d.archived).length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((d) => {
      if (hideStubs && d.is_stub) return false
      if (hideArchived && d.archived) return false
      if (typeFilter && d.document_type !== typeFilter) return false
      if (q && !d.document_id.toLowerCase().includes(q) && !d.title.toLowerCase().includes(q)) return false
      return true
    })
  }, [items, search, typeFilter, hideStubs, hideArchived])

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0 flex-wrap">

        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ID or title…"
          className="px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 w-52"
        />

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
        >
          <option value="">All types</option>
          {ALL_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        {/* Stub toggle */}
        <button
          onClick={() => setHideStubs((v) => !v)}
          className={`px-3 py-1.5 text-sm rounded border transition-colors ${
            hideStubs
              ? 'bg-amber-100 border-amber-300 text-amber-800'
              : 'border-gray-300 text-gray-600 hover:bg-gray-50'
          }`}
          title={hideStubs ? 'Showing registered documents only — click to show stubs' : 'Click to hide auto-detected stub documents'}
        >
          {hideStubs ? `Stubs hidden (${stubCount})` : `Stubs: ${stubCount}`}
        </button>

        {/* Archived toggle */}
        <button
          onClick={() => setHideArchived((v) => !v)}
          className={`px-3 py-1.5 text-sm rounded border transition-colors ${
            !hideArchived
              ? 'bg-gray-200 border-gray-400 text-gray-700'
              : 'border-gray-300 text-gray-600 hover:bg-gray-50'
          }`}
          title={hideArchived ? 'Click to show archived documents' : 'Click to hide archived documents'}
        >
          {hideArchived ? `Archived hidden (${archivedCount})` : `Archived: ${archivedCount}`}
        </button>

        {/* Count */}
        <span className="text-sm text-gray-400">
          {filtered.length}{filtered.length !== items.length ? ` / ${items.length}` : ''} doc{filtered.length !== 1 ? 's' : ''}
        </span>

        <div className="ml-auto flex gap-2">
          <button
            onClick={() => void load()}
            className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
          >
            Refresh
          </button>
          <button
            onClick={onCreateNew}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            + Register Document
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700 flex items-center gap-3">
          {error}
          <button onClick={() => void load()} className="underline text-red-600">Retry</button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-400 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400">
            {items.length === 0 ? (
              <>
                <p className="text-base font-medium">No documents yet</p>
                <p className="text-sm mt-1">Click "Register Document" to add the first one.</p>
              </>
            ) : (
              <>
                <p className="text-base font-medium">No documents match the current filters</p>
                <button
                  onClick={() => { setSearch(''); setTypeFilter(''); setHideStubs(false); setHideArchived(false) }}
                  className="text-sm mt-2 text-blue-600 underline"
                >
                  Clear filters
                </button>
              </>
            )}
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 sticky top-0">
                {['Document ID', 'Title', 'Type', 'Revision', 'Issuing Org', 'File'].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((doc, i) => {
                const typeCls = DOC_TYPE_CLASSES[doc.document_type] ?? 'bg-gray-100 text-gray-600'
                return (
                  <tr
                    key={doc.id}
                    onClick={() => onOpenDetail(doc.id)}
                    className={`border-b border-gray-100 cursor-pointer hover:bg-blue-50 transition-colors ${
                      doc.archived ? 'opacity-50' : i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
                    }`}
                  >
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs font-semibold text-blue-700">{doc.document_id}</span>
                      {doc.is_stub && (
                        <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700 border border-amber-200 rounded font-medium">
                          Stub
                        </span>
                      )}
                      {doc.archived && (
                        <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-gray-100 text-gray-500 border border-gray-300 rounded font-medium">
                          Archived
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-2 text-sm max-w-xs truncate ${doc.is_stub || doc.archived ? 'text-gray-400 italic' : 'text-gray-800'}`}>{doc.title}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${typeCls}`}>
                        {doc.document_type}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-600">{doc.revision ?? '—'}</td>
                    <td className="px-3 py-2 text-sm text-gray-600">{doc.issuing_organization ?? '—'}</td>
                    <td className="px-3 py-2">
                      {doc.has_file ? (
                        <span className="px-1.5 py-0.5 bg-green-50 text-green-700 text-xs rounded border border-green-200">PDF</span>
                      ) : (
                        <span className="text-xs text-gray-400 italic">No file</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
