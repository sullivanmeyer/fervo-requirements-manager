import type { HierarchyNode } from '../types'

interface Props {
  node: HierarchyNode
  depth: number
  selectedId: string | null
  expandedIds: Set<string>
  onToggle: (id: string) => void
  onSelect: (node: HierarchyNode) => void
}

// Short label + color for each discipline
const DISC_BADGES: Record<string, string> = {
  'Mechanical':        'bg-blue-100 text-blue-700',
  'Electrical':        'bg-amber-100 text-amber-700',
  'I&C':               'bg-purple-100 text-purple-700',
  'Civil/Structural':  'bg-orange-100 text-orange-700',
  'Process':           'bg-green-100 text-green-700',
  'Fire Protection':   'bg-red-100 text-red-700',
  'General':           'bg-gray-100 text-gray-500',
}

const DISC_SHORT: Record<string, string> = {
  'Mechanical':        'MECH',
  'Electrical':        'ELEC',
  'I&C':               'I&C',
  'Civil/Structural':  'CIVIL',
  'Process':           'PROC',
  'Fire Protection':   'FIRE',
  'General':           'GEN',
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
  const isArchived = node.archived
  const disciplines = node.applicable_disciplines ?? []

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 pr-2 select-none rounded mx-1 group ${
          isArchived
            ? 'cursor-default opacity-40'
            : isSelected
              ? 'bg-blue-50 text-blue-700 cursor-pointer'
              : 'text-gray-700 hover:bg-gray-100 cursor-pointer'
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => { if (!isArchived) onSelect(node) }}
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
        <span className={`text-sm truncate flex-1 ${isArchived ? 'italic' : ''}`}>{node.name}</span>

        {/* Discipline badges */}
        {disciplines.length > 0 && (
          <span className="flex gap-0.5 shrink-0">
            {disciplines.map((d) => (
              <span
                key={d}
                className={`text-[9px] font-semibold px-1 py-0.5 rounded ${DISC_BADGES[d] ?? 'bg-gray-100 text-gray-500'}`}
                title={d}
              >
                {DISC_SHORT[d] ?? d.slice(0, 4).toUpperCase()}
              </span>
            ))}
          </span>
        )}

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
