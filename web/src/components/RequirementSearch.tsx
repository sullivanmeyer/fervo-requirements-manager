/**
 * RequirementSearch
 *
 * A searchable multi-select for picking requirements by ID or title.
 * Selected requirements are shown as removable chips on the trigger.
 *
 * The caller passes in the full list of candidates (fetched once at the
 * page level) rather than fetching inside this component — keeps network
 * calls predictable and makes it easy to exclude the current requirement
 * from its own parent list.
 */
import { useEffect, useRef, useState } from 'react'
import type { RequirementStub } from '../types'

interface Props {
  /** All requirements the user may pick from */
  options: RequirementStub[]
  /** Currently selected requirement IDs */
  selectedIds: string[]
  onChange: (ids: string[]) => void
  placeholder?: string
}

export default function RequirementSearch({
  options,
  selectedIds,
  onChange,
  placeholder = 'Search by ID or title…',
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Focus the search input whenever the dropdown opens
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const filtered = options.filter((o) => {
    if (!query) return true
    const q = query.toLowerCase()
    return (
      o.requirement_id.toLowerCase().includes(q) ||
      o.title.toLowerCase().includes(q)
    )
  })

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((s) => s !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  // Build a lookup so chip labels are fast
  const nameMap = Object.fromEntries(
    options.map((o) => [o.id, `${o.requirement_id} — ${o.title}`]),
  )

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger: shows chips for selected items */}
      <div
        onClick={() => setOpen((v) => !v)}
        className="min-h-9 border border-gray-300 rounded px-2 py-1.5 flex flex-wrap gap-1 cursor-pointer hover:border-blue-400 bg-white"
      >
        {selectedIds.length === 0 ? (
          <span className="text-sm text-gray-400 py-0.5">{placeholder}</span>
        ) : (
          selectedIds.map((id) => (
            <span
              key={id}
              className="flex items-center gap-1 px-2 py-0.5 bg-indigo-50 text-indigo-700 text-xs rounded-full border border-indigo-200 font-mono"
            >
              {nameMap[id] ?? id}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(selectedIds.filter((s) => s !== id))
                }}
                className="text-indigo-400 hover:text-indigo-700 leading-none"
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-40 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg flex flex-col max-h-72">
          {/* Search input inside the dropdown */}
          <div className="p-2 border-b border-gray-100">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to filter…"
              className="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          <div className="overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-gray-400">No matches</p>
            ) : (
              filtered.map((opt) => (
                <label
                  key={opt.id}
                  className="flex items-start gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-50 last:border-0"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(opt.id)}
                    onChange={() => toggle(opt.id)}
                    className="mt-0.5 rounded shrink-0"
                  />
                  <span className="text-sm">
                    <span className="font-mono text-blue-700 mr-1.5">
                      {opt.requirement_id}
                    </span>
                    <span className="text-gray-700">{opt.title}</span>
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
