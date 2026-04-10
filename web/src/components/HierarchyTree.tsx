import { useEffect, useRef, useState } from 'react'
import type { HierarchyNode } from '../types'
import AddNodeModal from './AddNodeModal'
import TreeNode from './TreeNode'

interface Props {
  nodes: HierarchyNode[]
  selectedId: string | null
  onSelect: (node: HierarchyNode) => void
  onRefresh: () => void
}

function collectExpandableIds(nodes: HierarchyNode[]): Set<string> {
  const ids = new Set<string>()
  const walk = (ns: HierarchyNode[]) => {
    for (const n of ns) {
      if (n.children.length > 0) {
        ids.add(n.id)
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return ids
}

function findById(nodes: HierarchyNode[], id: string): HierarchyNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    const found = findById(n.children, id)
    if (found) return found
  }
  return null
}

export default function HierarchyTree({
  nodes,
  selectedId,
  onSelect,
  onRefresh,
}: Props) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [showAddModal, setShowAddModal] = useState(false)
  const initialized = useRef(false)

  // Auto-expand all nodes on first load only; preserve user state after that
  useEffect(() => {
    if (!initialized.current && nodes.length > 0) {
      setExpandedIds(collectExpandableIds(nodes))
      initialized.current = true
    }
  }, [nodes])

  const handleToggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedNode = selectedId ? findById(nodes, selectedId) : null

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 shrink-0">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          System Hierarchy
        </span>
        <button
          onClick={() => setShowAddModal(true)}
          title={
            selectedId
              ? `Add child to "${selectedNode?.name ?? ''}"`
              : 'Add root node'
          }
          className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          + Add Node
        </button>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {nodes.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-400">
            No nodes yet.
            <br />
            Click "Add Node" to get started.
          </div>
        ) : (
          nodes.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              selectedId={selectedId}
              expandedIds={expandedIds}
              onToggle={handleToggle}
              onSelect={onSelect}
            />
          ))
        )}
      </div>

      {/* Add Node Modal */}
      {showAddModal && (
        <AddNodeModal
          parentId={selectedId}
          parentName={selectedNode?.name ?? ''}
          parentDisciplines={selectedNode?.applicable_disciplines ?? []}
          onCreated={() => {
            setShowAddModal(false)
            onRefresh()
          }}
          onCancel={() => setShowAddModal(false)}
        />
      )}
    </div>
  )
}
