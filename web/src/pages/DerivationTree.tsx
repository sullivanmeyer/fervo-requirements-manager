/**
 * DerivationTree — Graph View
 *
 * Renders the requirement derivation hierarchy as a directed graph with
 * nodes (cards) and curved arrows, flowing top-to-bottom.
 *
 * Layout algorithm: BFS from SELF-000 assigns each node to a depth level,
 * then nodes are distributed evenly across the width of that level.
 * Edges are drawn as SVG cubic-bezier curves with arrowheads.
 *
 * All data loading and tree-building logic is unchanged from the list view.
 */
import { useEffect, useRef, useState } from 'react'
import {
  fetchAllLinks,
  fetchAllRequirements,
  fetchSelfDerived,
} from '../api/requirements'
import type { RequirementLink, RequirementListItem } from '../types'

// ---------------------------------------------------------------------------
// Tree data model (same as before)
// ---------------------------------------------------------------------------

interface TreeNode {
  req: RequirementListItem
  children: TreeNode[]
}

function buildTree(
  requirements: RequirementListItem[],
  links: RequirementLink[],
  selfDerived: RequirementListItem,
): TreeNode {
  const allReqs = [selfDerived, ...requirements]
  const byId = new Map(allReqs.map((r) => [r.id, r]))

  const parentToChildren = new Map<string, string[]>()
  for (const lnk of links) {
    const existing = parentToChildren.get(lnk.parent_requirement_id) ?? []
    existing.push(lnk.child_requirement_id)
    parentToChildren.set(lnk.parent_requirement_id, existing)
  }

  const linkedChildIds = new Set(links.map((l) => l.child_requirement_id))
  const implicitRootIds = requirements
    .filter((r) => !linkedChildIds.has(r.id))
    .map((r) => r.id)

  const selfChildren = [
    ...(parentToChildren.get(selfDerived.id) ?? []),
    ...implicitRootIds,
  ]
  parentToChildren.set(selfDerived.id, selfChildren)

  function buildNode(reqId: string, visited: Set<string>): TreeNode | null {
    if (visited.has(reqId)) return null
    const req = byId.get(reqId)
    if (!req) return null
    const nextVisited = new Set(visited).add(reqId)
    const childIds = parentToChildren.get(reqId) ?? []
    const children = childIds
      .map((cid) => buildNode(cid, nextVisited))
      .filter((n): n is TreeNode => n !== null)
      .sort((a, b) => a.req.requirement_id.localeCompare(b.req.requirement_id))
    return { req, children }
  }

  return buildNode(selfDerived.id, new Set()) ?? { req: selfDerived, children: [] }
}

// ---------------------------------------------------------------------------
// Graph layout
// ---------------------------------------------------------------------------

const NODE_W = 230   // card width
const NODE_H = 80    // card height
const H_GAP = 40     // horizontal gap between cards on the same level
const V_GAP = 90     // vertical gap between levels
const PADDING = 48   // canvas padding on all sides

interface LayoutNode {
  id: string
  req: RequirementListItem
  x: number   // left edge of card
  y: number   // top edge of card
}

interface LayoutEdge {
  fromId: string
  toId: string
}

interface GraphLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  canvasW: number
  canvasH: number
}

function computeLayout(root: TreeNode): GraphLayout {
  // BFS to assign each node to a depth level.
  // A node visited at multiple depths (shared parents) keeps its
  // maximum depth so it always renders below all its parents.
  const depthMap = new Map<string, number>()
  const queue: [TreeNode, number][] = [[root, 0]]
  while (queue.length > 0) {
    const [node, depth] = queue.shift()!
    const prev = depthMap.get(node.req.id) ?? -1
    if (depth <= prev) continue   // already placed at same or deeper level
    depthMap.set(node.req.id, depth)
    for (const child of node.children) {
      queue.push([child, depth + 1])
    }
  }

  // Group nodes by level
  const levels: TreeNode[][] = []
  const visited = new Set<string>()
  const bfsQueue: [TreeNode, number][] = [[root, 0]]
  while (bfsQueue.length > 0) {
    const [node, depth] = bfsQueue.shift()!
    if (visited.has(node.req.id)) continue
    visited.add(node.req.id)
    const level = depthMap.get(node.req.id) ?? depth
    if (!levels[level]) levels[level] = []
    levels[level].push(node)
    for (const child of node.children) {
      bfsQueue.push([child, level + 1])
    }
  }

  // Compute canvas width from the widest level
  const maxCount = Math.max(...levels.map((l) => l.length), 1)
  const canvasW = PADDING * 2 + maxCount * NODE_W + (maxCount - 1) * H_GAP

  // Position each node
  const posMap = new Map<string, { x: number; y: number }>()
  levels.forEach((levelNodes, levelIndex) => {
    const count = levelNodes.length
    const rowW = count * NODE_W + (count - 1) * H_GAP
    const startX = (canvasW - rowW) / 2
    levelNodes.forEach((node, i) => {
      posMap.set(node.req.id, {
        x: startX + i * (NODE_W + H_GAP),
        y: PADDING + levelIndex * (NODE_H + V_GAP),
      })
    })
  })

  // Collect nodes and edges
  const nodes: LayoutNode[] = []
  const edges: LayoutEdge[] = []
  const seenEdges = new Set<string>()

  visited.clear()
  const walkQueue: TreeNode[] = [root]
  while (walkQueue.length > 0) {
    const node = walkQueue.shift()!
    if (visited.has(node.req.id)) continue
    visited.add(node.req.id)
    const pos = posMap.get(node.req.id)
    if (pos) {
      nodes.push({ id: node.req.id, req: node.req, x: pos.x, y: pos.y })
    }
    for (const child of node.children) {
      const key = `${node.req.id}→${child.req.id}`
      if (!seenEdges.has(key)) {
        seenEdges.add(key)
        edges.push({ fromId: node.req.id, toId: child.req.id })
      }
      walkQueue.push(child)
    }
  }

  const canvasH = PADDING * 2 + levels.length * NODE_H + (levels.length - 1) * V_GAP

  return { nodes, edges, canvasW, canvasH }
}

// ---------------------------------------------------------------------------
// SVG edge path: cubic bezier from bottom-center of parent to top-center of child
// ---------------------------------------------------------------------------

function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const x1 = from.x + NODE_W / 2
  const y1 = from.y + NODE_H
  const x2 = to.x + NODE_W / 2
  const y2 = to.y
  const midY = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
}

// ---------------------------------------------------------------------------
// Status badge colours
// ---------------------------------------------------------------------------

const STATUS_CLASSES: Record<string, string> = {
  Draft: 'bg-gray-100 text-gray-600',
  'Under Review': 'bg-yellow-100 text-yellow-800',
  Approved: 'bg-green-100 text-green-800',
  Superseded: 'bg-orange-100 text-orange-800',
  Withdrawn: 'bg-red-100 text-red-800',
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  focusId: string | null
  onSelect: (id: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DerivationTree({ focusId, onSelect }: Props) {
  const [layout, setLayout] = useState<GraphLayout | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // We scroll the focused node into view after the canvas renders
  const focusRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [reqs, links, self] = await Promise.all([
        fetchAllRequirements(),
        fetchAllLinks(),
        fetchSelfDerived(),
      ])

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

      const tree = buildTree(reqs, links, selfDerived)
      setLayout(computeLayout(tree))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load derivation tree')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll the focused node into view when the layout is ready
  useEffect(() => {
    if (focusRef.current) {
      focusRef.current.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
    }
  }, [layout, focusId])

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

  if (!layout) return null

  const { nodes, edges, canvasW, canvasH } = layout

  // Build a quick id→position lookup for edge rendering
  const posById = new Map(nodes.map((n: LayoutNode) => [n.id, { x: n.x, y: n.y }]))

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 bg-white border-b border-gray-200 shrink-0 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">
            Requirement Derivation Tree
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Click a node to open its detail view. Arrows show derivation flow (parent → child).
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="text-xs text-gray-400 hover:text-gray-600 underline"
        >
          Refresh
        </button>
      </div>

      {/* Scrollable canvas */}
      <div className="flex-1 overflow-auto bg-gray-50">
        {/*
          The canvas uses position:relative so we can absolutely position
          node cards on top of it.  The SVG sits behind the cards (z-index 0)
          and the cards sit on top (z-index 10).
        */}
        <div
          className="relative"
          style={{ width: canvasW, height: canvasH, minWidth: '100%' }}
        >
          {/* ---------------------------------------------------------------- */}
          {/* SVG layer: arrowhead marker + edge curves                         */}
          {/* ---------------------------------------------------------------- */}
          <svg
            className="absolute inset-0 pointer-events-none"
            width={canvasW}
            height={canvasH}
            style={{ zIndex: 0 }}
          >
            <defs>
              <marker
                id="arrowhead"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill="#94a3b8" />
              </marker>
            </defs>

            {edges.map(({ fromId, toId }) => {
              const from = posById.get(fromId)
              const to = posById.get(toId)
              if (!from || !to) return null
              return (
                <path
                  key={`${fromId}-${toId}`}
                  d={edgePath(from, to)}
                  fill="none"
                  stroke="#94a3b8"
                  strokeWidth={1.5}
                  markerEnd="url(#arrowhead)"
                />
              )
            })}
          </svg>

          {/* ---------------------------------------------------------------- */}
          {/* Node cards                                                        */}
          {/* ---------------------------------------------------------------- */}
          {nodes.map((node) => {
            const isFocused = node.id === focusId
            const isSelf = node.req.requirement_id === 'SELF-000'
            const statusCls = STATUS_CLASSES[node.req.status] ?? 'bg-gray-100 text-gray-600'

            return (
              <div
                key={node.id}
                ref={isFocused ? focusRef : undefined}
                onClick={() => { if (!isSelf) onSelect(node.id) }}
                style={{
                  position: 'absolute',
                  left: node.x,
                  top: node.y,
                  width: NODE_W,
                  height: NODE_H,
                  zIndex: 10,
                }}
                className={[
                  'rounded-lg border bg-white p-3 flex flex-col justify-between select-none',
                  isSelf
                    ? 'border-dashed border-gray-300 cursor-default opacity-60'
                    : 'border-gray-200 cursor-pointer hover:border-blue-400 hover:shadow-md transition-all',
                  isFocused ? 'ring-2 ring-blue-500 border-blue-400 shadow-md' : '',
                ].join(' ')}
              >
                {/* Top row: ID + status badge */}
                <div className="flex items-center justify-between gap-1">
                  <span className={`font-mono text-xs font-semibold truncate ${isSelf ? 'text-gray-400' : 'text-blue-700'}`}>
                    {node.req.requirement_id}
                  </span>
                  {!isSelf && (
                    <span className={`px-1.5 py-0.5 rounded-full text-xs font-medium shrink-0 ${statusCls}`}>
                      {node.req.status}
                    </span>
                  )}
                </div>

                {/* Title */}
                <p
                  className={`text-xs leading-snug line-clamp-2 ${isSelf ? 'text-gray-400 italic' : 'text-gray-700'}`}
                  title={node.req.title}
                >
                  {node.req.title}
                </p>

                {/* Bottom row: owner (only for real requirements) */}
                {!isSelf && (
                  <p className="text-xs text-gray-400 truncate">{node.req.owner}</p>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
