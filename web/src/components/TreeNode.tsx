import type { HierarchyNode } from '../types'

interface Props {
  node: HierarchyNode
  depth: number
  selectedId: string | null
  expandedIds: Set<string>
  onToggle: (id: string) => void
  onSelect: (node: HierarchyNode) => void
}

export default function TreeNode({
  node,
  depth,
  selectedId,
  expandedIds,
  onToggle,
  onSelect,
}: Props) {
  const isExpanded = expandedIds.has(node.id)
  const isSelected = node.id === selectedId
  const hasChildren = node.children.length > 0

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 pr-2 cursor-pointer select-none rounded mx-1 group ${
          isSelected
            ? 'bg-blue-50 text-blue-700'
            : 'text-gray-700 hover:bg-gray-100'
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => onSelect(node)}
      >
        {/* Expand / collapse toggle */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (hasChildren) onToggle(node.id)
          }}
          className={`w-4 h-4 flex items-center justify-center text-xs shrink-0 rounded ${
            hasChildren
              ? isSelected
                ? 'text-blue-400 hover:text-blue-600'
                : 'text-gray-400 hover:text-gray-600'
              : 'invisible pointer-events-none'
          }`}
          tabIndex={-1}
        >
          {isExpanded ? '▾' : '▸'}
        </button>

        {/* Node name */}
        <span className="text-sm truncate flex-1">{node.name}</span>

        {/* Child count pill */}
        {hasChildren && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${
              isSelected
                ? 'bg-blue-100 text-blue-500'
                : 'bg-gray-100 text-gray-400 group-hover:bg-gray-200'
            }`}
          >
            {node.children.length}
          </span>
        )}
      </div>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expandedIds={expandedIds}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}
