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
 *
 * Interactions: scroll to zoom, drag to pan, hover to highlight connected
 * nodes, click to open detail — matching the feel of DocumentNetwork.tsx.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
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

  // Layout flows LEFT → RIGHT: depth level = column (x-axis),
  // siblings within a level are distributed vertically (y-axis).
  const maxCount = Math.max(...levels.map((l) => l.length), 1)
  const canvasW = PADDING * 2 + levels.length * NODE_W + (levels.length - 1) * V_GAP
  const canvasH = PADDING * 2 + maxCount * NODE_H + (maxCount - 1) * H_GAP

  // Position each node
  const posMap = new Map<string, { x: number; y: number }>()
  levels.forEach((levelNodes, levelIndex) => {
    const count = levelNodes.length
    const colH = count * NODE_H + (count - 1) * H_GAP
    const startY = (canvasH - colH) / 2
    levelNodes.forEach((node, i) => {
      posMap.set(node.req.id, {
        x: PADDING + levelIndex * (NODE_W + V_GAP),
        y: startY + i * (NODE_H + H_GAP),
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

  return { nodes, edges, canvasW, canvasH }
}

// ---------------------------------------------------------------------------
// SVG edge path: cubic bezier from right-center of parent to left-center of child
// ---------------------------------------------------------------------------

function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const x1 = from.x + NODE_W        // right edge of parent card
  const y1 = from.y + NODE_H / 2    // vertical center of parent card
  const x2 = to.x                   // left edge of child card
  const y2 = to.y + NODE_H / 2      // vertical center of child card
  const midX = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
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

  // Hover highlighting state (drives React re-renders for dimming/highlighting)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // Cursor state — refs alone won't trigger re-renders, so we use a boolean state
  const [isDragging, setIsDragging] = useState(false)

  // Pan/zoom state — stored in a ref so mutations don't trigger re-renders
  const transformRef = useRef({ tx: 0, ty: 0, scale: 1 })

  // DOM refs for the outer container and the inner canvas div
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)

  // Pan drag tracking
  const dragRef = useRef<{
    startX: number
    startY: number
    startTx: number
    startTy: number
  } | null>(null)

  // Set to true once the mouse has moved >3px during a drag — prevents
  // a pan gesture from also firing a node click
  const didPanRef = useRef(false)

  // ---------------------------------------------------------------------------
  // applyTransform — directly mutates the inner canvas div's CSS transform.
  // Bypasses React's render cycle entirely (same pattern as DocumentNetwork).
  // ---------------------------------------------------------------------------

  function applyTransform() {
    if (!canvasRef.current) return
    const { tx, ty, scale } = transformRef.current
    canvasRef.current.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

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

      const filteredReqs = reqs.filter((r) =>
        (r.classification_subtype === 'Performance Requirement' ||
          r.classification_subtype === 'Derived Requirement') &&
        !r.archived &&
        r.status !== 'Withdrawn' &&
        r.status !== 'Superseded'
      )
      const tree = buildTree(filteredReqs, links, selfDerived)
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

  // ---------------------------------------------------------------------------
  // Wheel zoom — must be registered as a non-passive listener so we can call
  // preventDefault() and stop the page from scrolling while zooming.
  //
  // NOTE: `loading` is a dependency here on purpose.  The container div is
  // only in the DOM after loading completes (early returns replace the JSX).
  // Running with [] means this effect fires while containerRef.current is
  // still null, the guard bails, and the listener is never attached.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (loading) return
    const container = containerRef.current
    if (!container) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()

      const rect = container.getBoundingClientRect()
      // Cursor position relative to the container
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top

      const { tx, ty, scale } = transformRef.current
      const factor = e.deltaY < 0 ? 1.1 : 0.91
      const newScale = Math.min(Math.max(scale * factor, 0.1), 5)

      // Keep the world point under the cursor fixed in screen space
      transformRef.current = {
        tx: cx - (cx - tx) * (newScale / scale),
        ty: cy - (cy - ty) * (newScale / scale),
        scale: newScale,
      }
      applyTransform()
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Focus centering — when layout is ready and a focusId is set, pan so that
  // the focused node is centered in the container.
  //
  // Replaces the old scrollIntoView approach. Same `loading` dep note applies.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (loading || !layout || !focusId) return
    const container = containerRef.current
    if (!container) return

    const node = layout.nodes.find((n) => n.id === focusId)
    if (!node) return

    const containerW = container.clientWidth
    const containerH = container.clientHeight

    // Center of the focused card in canvas-space
    const nodeCx = node.x + NODE_W / 2
    const nodeCy = node.y + NODE_H / 2

    // Translate so that canvas-space point (nodeCx, nodeCy) maps to the
    // center of the container in screen-space
    transformRef.current = {
      tx: containerW / 2 - nodeCx,
      ty: containerH / 2 - nodeCy,
      scale: 1,
    }
    applyTransform()
  }, [layout, focusId, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Hover highlighting — compute the set of ids that are "connected" to the
  // hovered node (the node itself + all direct edge neighbours in either
  // direction). When nothing is hovered, returns null (nothing is dimmed).
  // ---------------------------------------------------------------------------

  const connectedIds = useMemo<Set<string> | null>(() => {
    if (!hoveredId || !layout) return null
    const ids = new Set<string>()
    ids.add(hoveredId)
    for (const edge of layout.edges) {
      if (edge.fromId === hoveredId) ids.add(edge.toId)
      if (edge.toId === hoveredId) ids.add(edge.fromId)
    }
    return ids
  }, [hoveredId, layout])

  // ---------------------------------------------------------------------------
  // Mouse event handlers
  // ---------------------------------------------------------------------------

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    didPanRef.current = false
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTx: transformRef.current.tx,
      startTy: transformRef.current.ty,
    }
    setIsDragging(true)
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      didPanRef.current = true
    }

    transformRef.current = {
      ...transformRef.current,
      tx: dragRef.current.startTx + dx,
      ty: dragRef.current.startTy + dy,
    }
    applyTransform()
  }

  const handleMouseUp = () => {
    dragRef.current = null
    setIsDragging(false)
  }

  const handleMouseLeave = () => {
    dragRef.current = null
    setIsDragging(false)
  }

  // ---------------------------------------------------------------------------
  // Early returns for loading / error states
  // ---------------------------------------------------------------------------

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
            Scroll to zoom · drag to pan · click a node to open it. Arrows show derivation flow (parent → child).
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="text-xs text-gray-400 hover:text-gray-600 underline"
        >
          Refresh
        </button>
      </div>

      {/* Pan/zoom canvas container — overflow-hidden clips the canvas during pan */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden bg-gray-50 relative"
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      >
        {/*
          The inner div is the actual "canvas" that gets CSS-transformed.
          transformOrigin: '0 0' means translations and scales are anchored
          to the top-left corner of this div, which matches the math in
          applyTransform() and the wheel zoom calculation.
          willChange: 'transform' hints to the browser to promote this layer
          to the GPU for smooth animation.
        */}
        <div
          ref={canvasRef}
          className="relative"
          style={{
            width: canvasW,
            height: canvasH,
            transformOrigin: '0 0',
            willChange: 'transform',
          }}
        >
          {/* ---------------------------------------------------------------- */}
          {/* SVG layer: arrowhead markers + edge curves                        */}
          {/* ---------------------------------------------------------------- */}
          <svg
            className="absolute inset-0 pointer-events-none"
            width={canvasW}
            height={canvasH}
            style={{ zIndex: 0 }}
          >
            <defs>
              {/* Default arrowhead — slate gray */}
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
              {/* Highlighted arrowhead — blue, used when both endpoints are in the hover set */}
              <marker
                id="arrowhead-active"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill="#3b82f6" />
              </marker>
            </defs>

            {edges.map(({ fromId, toId }) => {
              const from = posById.get(fromId)
              const to = posById.get(toId)
              if (!from || !to) return null

              // Determine edge visual state:
              //   - connectedIds null  → no hover active, render at default style
              //   - both endpoints in connectedIds → highlighted (blue)
              //   - otherwise → dimmed
              const isHighlighted =
                connectedIds !== null &&
                connectedIds.has(fromId) &&
                connectedIds.has(toId)
              const isDimmed =
                connectedIds !== null && (!connectedIds.has(fromId) || !connectedIds.has(toId))

              return (
                <path
                  key={`${fromId}-${toId}`}
                  d={edgePath(from, to)}
                  fill="none"
                  stroke={isHighlighted ? '#3b82f6' : '#94a3b8'}
                  strokeWidth={isHighlighted ? 2 : 1.5}
                  opacity={isDimmed ? 0.15 : 1}
                  markerEnd={isHighlighted ? 'url(#arrowhead-active)' : 'url(#arrowhead)'}
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

            // Dim this card if something is hovered AND this node is not in
            // the connected set. SELF-000 retains its existing reduced opacity.
            const isDimmedByHover =
              connectedIds !== null && !connectedIds.has(node.id)

            return (
              <div
                key={node.id}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => {
                  // Guard: if the mouse moved during this press it was a pan,
                  // not a click — don't navigate
                  if (didPanRef.current) return
                  if (!isSelf) onSelect(node.id)
                }}
                style={{
                  position: 'absolute',
                  left: node.x,
                  top: node.y,
                  width: NODE_W,
                  height: NODE_H,
                  zIndex: 10,
                }}
                className={[
                  'rounded-lg border bg-white p-3 flex flex-col justify-between select-none transition-opacity',
                  isSelf
                    ? 'border-dashed border-gray-300 cursor-default opacity-60'
                    : 'border-gray-200 cursor-pointer hover:border-blue-400 hover:shadow-md transition-all',
                  isFocused ? 'ring-2 ring-blue-500 border-blue-400 shadow-md' : '',
                  // Apply hover-dim only to non-SELF nodes (SELF is already opacity-60)
                  !isSelf && isDimmedByHover ? 'opacity-20' : '',
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

        {/* Controls hint overlay — sits in screen-space (outside the transformed
            canvas div) so it doesn't move or scale with pan/zoom */}
        <div
          className="absolute bottom-4 right-4 text-gray-400 text-[10px] text-right space-y-0.5 pointer-events-none select-none"
          style={{ zIndex: 20 }}
        >
          <p>Scroll — zoom</p>
          <p>Drag — pan</p>
          <p>Click node — open detail</p>
        </div>
      </div>
    </div>
  )
}
