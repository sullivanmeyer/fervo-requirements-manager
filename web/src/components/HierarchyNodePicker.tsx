/**
 * HierarchyNodePicker
 *
 * A popover that renders the system hierarchy as a tree with checkboxes.
 * The user can check any combination of nodes. Selected nodes are shown
 * as removable chips on the trigger button.
 */
import { useEffect, useRef, useState } from 'react'
import type { HierarchyNode } from '../types'

interface Props {
  nodes: HierarchyNode[]         // root nodes of the hierarchy tree
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

function TreeRow({
  node,
  depth,
  selectedIds,
  onToggle,
}: {
  node: HierarchyNode
  depth: number
  selectedIds: string[]
  onToggle: (id: string) => void
}) {
  const [open, setOpen] = useState(depth < 2) // auto-expand top two levels

  const checked = selectedIds.includes(node.id)

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 cursor-pointer select-none"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {/* Expand/collapse toggle — only shown when there are children */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          className="w-4 h-4 flex items-center justify-center text-gray-400 shrink-0"
        >
          {node.children.length > 0 ? (open ? '▾' : '▸') : ' '}
        </button>

        {/* Checkbox + label */}
        <label className="flex items-center gap-1.5 flex-1 cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onToggle(node.id)}
            className="rounded"
          />
          <span className="text-sm text-gray-800">{node.name}</span>
        </label>
      </div>

      {open &&
        node.children.map((child) => (
          <TreeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedIds={selectedIds}
            onToggle={onToggle}
          />
        ))}
    </div>
  )
}

export default function HierarchyNodePicker({
  nodes,
  selectedIds,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close the popover when the user clicks outside it
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((s) => s !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  // Build a flat lookup so we can display chip names quickly
  const nameMap: Record<string, string> = {}
  const walk = (ns: HierarchyNode[]) => {
    for (const n of ns) {
      nameMap[n.id] = n.name
      walk(n.children)
    }
  }
  walk(nodes)

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger area: shows selected chips + open button */}
      <div
        onClick={() => setOpen((v) => !v)}
        className="min-h-9 border border-gray-300 rounded px-2 py-1.5 flex flex-wrap gap-1 cursor-pointer hover:border-blue-400 bg-white"
      >
        {selectedIds.length === 0 ? (
          <span className="text-sm text-gray-400 py-0.5">
            Select hierarchy nodes…
          </span>
        ) : (
          selectedIds.map((id) => (
            <span
              key={id}
              className="flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full border border-blue-200"
            >
              {nameMap[id] ?? id}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(selectedIds.filter((s) => s !== id))
                }}
                className="text-blue-400 hover:text-blue-700 leading-none"
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      {/* Dropdown tree */}
      {open && (
        <div className="absolute z-40 mt-1 w-full max-h-72 overflow-y-auto bg-white border border-gray-200 rounded shadow-lg py-1">
          {nodes.length === 0 ? (
            <p className="px-3 py-2 text-sm text-gray-400">
              No hierarchy nodes available
            </p>
          ) : (
            nodes.map((n) => (
              <TreeRow
                key={n.id}
                node={n}
                depth={0}
                selectedIds={selectedIds}
                onToggle={handleToggle}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
