/**
 * DerivationTree
 *
 * Navigable collapsible tree of all requirements organised by parent/child
 * traceability links.  The root is the system-seeded SELF-000 record; any
 * requirement with no parent links is shown directly beneath it.
 *
 * Think of this view the same way you'd read a functional decomposition
 * diagram: top-level plant requirements fan out into system requirements,
 * which fan out into component requirements.
 */
import { useEffect, useRef, useState } from 'react'
import {
  fetchAllLinks,
  fetchAllRequirements,
  fetchSelfDerived,
} from '../api/requirements'
import type { RequirementLink, RequirementListItem } from '../types'

// ---------------------------------------------------------------------------
// Tree node type — built client-side from flat requirements + links lists
// ---------------------------------------------------------------------------

interface TreeNode {
  req: RequirementListItem
  children: TreeNode[]
}

// ---------------------------------------------------------------------------
// Build the tree from flat data
// ---------------------------------------------------------------------------

function buildTree(
  requirements: RequirementListItem[],
  links: RequirementLink[],
  selfDerived: RequirementListItem,
): TreeNode {
  // Include SELF-000 in the lookup so the recursive builder can find it
  const allReqs = [selfDerived, ...requirements]
  const byId = new Map(allReqs.map((r) => [r.id, r]))

  // parent → [child, child, ...] adjacency list
  const parentToChildren = new Map<string, string[]>()
  for (const lnk of links) {
    const existing = parentToChildren.get(lnk.parent_requirement_id) ?? []
    existing.push(lnk.child_requirement_id)
    parentToChildren.set(lnk.parent_requirement_id, existing)
  }

  // Requirements with NO incoming link edges are implicit children of SELF-000
  const linkedChildIds = new Set(links.map((l) => l.child_requirement_id))
  const implicitRootIds = requirements
    .filter((r) => !linkedChildIds.has(r.id))
    .map((r) => r.id)

  // Merge explicit + implicit children of SELF-000
  const selfChildren = [
    ...(parentToChildren.get(selfDerived.id) ?? []),
    ...implicitRootIds,
  ]
  parentToChildren.set(selfDerived.id, selfChildren)

  // Recursive builder — visited set prevents infinite loops if any cycle
  // slipped through (shouldn't happen, but safe > sorry)
  function buildNode(reqId: string, visited: Set<string>): TreeNode | null {
    if (visited.has(reqId)) return null
    const req = byId.get(reqId)
    if (!req) return null

    const nextVisited = new Set(visited).add(reqId)
    const childIds = parentToChildren.get(reqId) ?? []
    const children = childIds
      .map((cid) => buildNode(cid, nextVisited))
      .filter((n): n is TreeNode => n !== null)
      .sort((a, b) =>
        a.req.requirement_id.localeCompare(b.req.requirement_id),
      )

    return { req, children }
  }

  return buildNode(selfDerived.id, new Set()) ?? { req: selfDerived, children: [] }
}

// ---------------------------------------------------------------------------
// Status badge colours (same palette as RequirementsTable)
// ---------------------------------------------------------------------------

const STATUS_CLASSES: Record<string, string> = {
  Draft: 'bg-gray-100 text-gray-600',
  'Under Review': 'bg-yellow-100 text-yellow-800',
  Approved: 'bg-green-100 text-green-800',
  Superseded: 'bg-orange-100 text-orange-800',
  Withdrawn: 'bg-red-100 text-red-800',
}

// ---------------------------------------------------------------------------
// Individual tree row
// ---------------------------------------------------------------------------

function TreeRow({
  node,
  depth,
  focusId,
  onSelect,
}: {
  node: TreeNode
  depth: number
  focusId: string | null
  onSelect: (id: string) => void
}) {
  const isFocused = node.req.id === focusId
  const [open, setOpen] = useState(depth < 3 || isFocused)
  const rowRef = useRef<HTMLDivElement>(null)

  // Auto-scroll the focused node into view after the tree renders
  useEffect(() => {
    if (isFocused) {
      rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [isFocused])

  const isSelfDerived = node.req.requirement_id === 'SELF-000'
  const statusCls = STATUS_CLASSES[node.req.status] ?? 'bg-gray-100 text-gray-600'
  const hasChildren = node.children.length > 0

  return (
    <div>
      <div
        ref={rowRef}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        className={`flex items-start gap-2 py-2 pr-3 rounded cursor-pointer transition-colors ${
          isFocused
            ? 'bg-blue-50 ring-1 ring-blue-300'
            : 'hover:bg-gray-50'
        } ${isSelfDerived ? 'opacity-60 cursor-default' : ''}`}
        onClick={() => {
          if (!isSelfDerived) onSelect(node.req.id)
        }}
      >
        {/* Expand / collapse */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            if (hasChildren) setOpen((v) => !v)
          }}
          className="w-4 h-4 mt-0.5 flex items-center justify-center text-gray-400 shrink-0 text-xs"
        >
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </button>

        {/* Node content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`font-mono text-xs font-semibold shrink-0 ${
                isSelfDerived ? 'text-gray-400' : 'text-blue-700'
              }`}
            >
              {node.req.requirement_id}
            </span>
            {!isSelfDerived && (
              <>
                <span className={`px-1.5 py-0.5 rounded-full text-xs font-medium shrink-0 ${statusCls}`}>
                  {node.req.status}
                </span>
                <span className="text-xs text-gray-400 shrink-0">
                  {node.req.classification}
                </span>
              </>
            )}
          </div>
          <p
            className={`text-sm mt-0.5 leading-snug ${
              isSelfDerived ? 'text-gray-400 italic' : 'text-gray-800'
            }`}
          >
            {node.req.title}
          </p>
          {!isSelfDerived && (
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs text-gray-400">{node.req.owner}</span>
              {node.req.hierarchy_nodes.map((n) => (
                <span
                  key={n.id}
                  className="px-1.5 py-0.5 bg-blue-50 text-blue-600 text-xs rounded"
                >
                  {n.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {open &&
        hasChildren &&
        node.children.map((child) => (
          <TreeRow
            key={child.req.id}
            node={child}
            depth={depth + 1}
            focusId={focusId}
            onSelect={onSelect}
          />
        ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Props and main component
// ---------------------------------------------------------------------------

interface Props {
  /** If set, scroll to and highlight this requirement UUID */
  focusId: string | null
  /** Called when the user clicks a node — navigate to its detail view */
  onSelect: (id: string) => void
}

export default function DerivationTree({ focusId, onSelect }: Props) {
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      // Fetch all three pieces in parallel — Promise.all fires them simultaneously
      const [reqs, links, self] = await Promise.all([
        fetchAllRequirements(),
        fetchAllLinks(),
        fetchSelfDerived(),
      ])

      // Build a full RequirementListItem-shaped object for SELF-000 so it
      // fits cleanly into the same tree structure as every other node
      const selfDerived: RequirementListItem = {
        id: self.id,
        requirement_id: self.requirement_id,
        title: self.title,
        classification: 'Requirement',
        owner: 'System',
        status: 'Approved',
        discipline: 'General',
        created_by: 'System',
        created_date: '',
        hierarchy_nodes: [],
        sites: [],
        units: [],
      }

      setTree(buildTree(reqs, links, selfDerived))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load derivation tree')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-sm text-red-600">{error}</p>
        <button onClick={() => void load()} className="text-xs text-blue-600 underline">
          Retry
        </button>
      </div>
    )
  }

  if (!tree) return null

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 bg-white border-b border-gray-200 shrink-0">
        <h2 className="text-sm font-semibold text-gray-700">
          Requirement Derivation Tree
        </h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Click a node to open its detail view. Requirements with no parent
          link appear directly under Self-Derived.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <TreeRow
          node={tree}
          depth={0}
          focusId={focusId}
          onSelect={onSelect}
        />
      </div>
    </div>
  )
}
