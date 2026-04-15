import { useState } from 'react'
import { createNode } from '../api/hierarchy'

interface Props {
  parentId: string | null
  parentName: string
  parentDisciplines?: string[]  // pre-populate from parent node
  onCreated: () => void
  onCancel: () => void
}

const ALL_DISCIPLINES = [
  'Mechanical',
  'Electrical',
  'I&C',
  'Civil/Structural',
  'Process',
  'Fire Protection',
  'General',
]

const DISC_COLORS: Record<string, string> = {
  'Mechanical':        'bg-blue-100 text-blue-700 border-blue-200',
  'Electrical':        'bg-amber-100 text-amber-700 border-amber-200',
  'I&C':               'bg-purple-100 text-purple-700 border-purple-200',
  'Civil/Structural':  'bg-orange-100 text-orange-700 border-orange-200',
  'Process':           'bg-green-100 text-green-700 border-green-200',
  'Fire Protection':   'bg-red-100 text-red-700 border-red-200',
  'General':           'bg-gray-100 text-gray-500 border-gray-200',
}

export default function AddNodeModal({
  parentId,
  parentName,
  parentDisciplines = [],
  onCreated,
  onCancel,
}: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // Default to parent's disciplines so the tree inherits discipline context automatically
  const [disciplines, setDisciplines] = useState<string[]>(parentDisciplines)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleDiscipline = (d: string) => {
    setDisciplines((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await createNode({
        name: name.trim(),
        description: description.trim() || undefined,
        parent_id: parentId,
        applicable_disciplines: disciplines.length > 0 ? disciplines : undefined,
      })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create node')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-4">
          Add node under{' '}
          <span className="text-blue-600">{parentName || 'Root'}</span>
        </h2>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              placeholder="e.g., Secondary Heat Exchanger"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none"
              placeholder="Brief description of this node"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">
              Applicable Disciplines
              <span className="ml-1 font-normal text-gray-400">
                {parentDisciplines.length > 0 ? '(inherited from parent)' : '(leave empty = universal)'}
              </span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_DISCIPLINES.map((d) => {
                const active = disciplines.includes(d)
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDiscipline(d)}
                    className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                      active
                        ? (DISC_COLORS[d] ?? 'bg-blue-100 text-blue-700 border-blue-200')
                        : 'bg-white text-gray-400 border-gray-200 hover:border-gray-400'
                    }`}
                  >
                    {d}
                  </button>
                )
              })}
              {disciplines.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDisciplines([])}
                  className="px-2.5 py-1 text-xs rounded border border-dashed border-gray-300 text-gray-400 hover:text-gray-600"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2 justify-end pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
