/**
 * SourceDocumentRegistry
 *
 * Table view of all registered source documents.
 * Each row is clickable to open the document detail/edit view.
 * A "Register Document" button opens a creation form.
 */
import { useEffect, useState } from 'react'
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

interface Props {
  onOpenDetail: (id: string) => void
  onCreateNew: () => void
}

export default function SourceDocumentRegistry({ onOpenDetail, onCreateNew }: Props) {
  const [items, setItems] = useState<SourceDocumentListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await fetchSourceDocuments())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load documents')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0">
        <span className="text-sm text-gray-500">
          {items.length} document{items.length !== 1 ? 's' : ''}
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
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400">
            <p className="text-base font-medium">No documents yet</p>
            <p className="text-sm mt-1">Click "Register Document" to add the first one.</p>
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
              {items.map((doc, i) => {
                const typeCls = DOC_TYPE_CLASSES[doc.document_type] ?? 'bg-gray-100 text-gray-600'
                return (
                  <tr
                    key={doc.id}
                    onClick={() => onOpenDetail(doc.id)}
                    className={`border-b border-gray-100 cursor-pointer hover:bg-blue-50 transition-colors ${
                      i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'
                    }`}
                  >
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs font-semibold text-blue-700">{doc.document_id}</span>
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-800 max-w-xs truncate">{doc.title}</td>
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
