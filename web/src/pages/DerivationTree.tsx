/**
 * DerivationTree — Layered DAG Layout (Stage 19)
 *
 * Replaces the force-directed graph with a deterministic left-to-right
 * layered DAG (phylogenetic-style). Each independent derivation chain is
 * laid out as its own tree stacked vertically. SELF-000 is hidden.
 *
 * Layout algorithm:
 *   1. Filter to Performance + Derived Requirements (non-archived)
 *   2. Remove SELF-000 from parent lists; roots = nodes with no real parents
 *   3. Find connected components (undirected BFS)
 *   4. Within each component: assign layers by longest-path (Kahn topo sort)
 *   5. Sort rows within each layer by barycenter heuristic (3 passes)
 *   6. Assign x = layer × COL_WIDTH, y = cumulative row position
 *   7. Stack components vertically with TREE_GAP between them
 *
 * Edges are three-segment elbow connectors (orthogonal routing).
 * Cross-tree edges (child has multiple parents) are drawn in green.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchAllLinks,
  fetchAllRequirements,
  fetchSelfDerived,
} from '../api/requirements'
import type { RequirementLink, RequirementListItem } from '../types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_W = 180
const NODE_H = 52
const COL_WIDTH = 220   // spacing between column left edges
const ROW_GAP = 20      // vertical gap between nodes in the same layer
const TREE_GAP = 48     // vertical gap between independent trees
const PADDING = 40      // canvas padding

const ALL_STATUSES = ['Draft', 'Under Review', 'Approved', 'Superseded', 'Withdrawn']

const STATUS_DOT: Record<string, string> = {
  Draft: '#9ca3af',
  'Under Review': '#f59e0b',
  Approved: '#22c55e',
  Superseded: '#f97316',
  Withdrawn: '#ef4444',
}

// Card background and border by discipline (inline styles — dynamic values)
const DISC_STYLE: Record<string, { bg: string; border: string; idColor: string }> = {
  Mechanical:        { bg: '#eff6ff', border: '#bfdbfe', idColor: '#1d4ed8' },
  Electrical:        { bg: '#fefce8', border: '#fde68a', idColor: '#78350f' },
  'I&C':             { bg: '#f0fdfa', border: '#99f6e4', idColor: '#0f766e' },
  'Civil/Structural':{ bg: '#fafaf9', border: '#e7e5e4', idColor: '#57534e' },
  Process:           { bg: '#f0fdf4', border: '#bbf7d0', idColor: '#15803d' },
  'Fire Protection': { bg: '#fff1f2', border: '#fecdd3', idColor: '#b91c1c' },
  General:           { bg: '#f9fafb', border: '#e5e7eb', idColor: '#374151' },
  Build:             { bg: '#fff7ed', border: '#fed7aa', idColor: '#c2410c' },
  Operations:        { bg: '#faf5ff', border: '#e9d5ff', idColor: '#6b21a8' },
}
const DEFAULT_DISC_STYLE = { bg: '#f9fafb', border: '#e5e7eb', idColor: '#374151' }

const DISCIPLINE_ORDER = [
  'Mechanical', 'Electrical', 'I&C', 'Civil/Structural',
  'Process', 'Fire Protection', 'General', 'Build', 'Operations',
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DagNode {
  id: string
  req: RequirementListItem
  x: number
  y: number
  layer: number
}

interface DagEdge {
  fromId: string
  toId: string
  isCrossTree: boolean  // child has multiple real parents
}

interface DagLayout {
  nodes: DagNode[]
  edges: DagEdge[]
  canvasW: number
  canvasH: number
}

// ---------------------------------------------------------------------------
// Layout algorithm
// ---------------------------------------------------------------------------

function computeDagLayout(
  reqs: RequirementListItem[],
  links: RequirementLink[],
  selfDerivedId: string,
): DagLayout {
  if (reqs.length === 0) {
    return { nodes: [], edges: [], canvasW: PADDING * 4, canvasH: PADDING * 4 }
  }

  const nodeMap = new Map(reqs.map((r) => [r.id, r]))

  // Build parent/child adjacency (SELF-000 excluded; both endpoints must be visible)
  const parentOf = new Map<string, string[]>()
  const childOf  = new Map<string, string[]>()
  for (const lnk of links) {
    const { parent_requirement_id: pid, child_requirement_id: cid } = lnk
    if (pid === selfDerivedId) continue
    if (!nodeMap.has(pid) || !nodeMap.has(cid)) continue
    parentOf.set(cid, [...(parentOf.get(cid) ?? []), pid])
    childOf.set(pid, [...(childOf.get(pid)  ?? []), cid])
  }

  // Roots = nodes with no visible real parents
  const roots = reqs.filter((r) => (parentOf.get(r.id) ?? []).length === 0)

  // Connected components (undirected BFS from each root)
  const compOf = new Map<string, number>()
  let nComp = 0
  for (const root of roots) {
    if (compOf.has(root.id)) continue
    const comp = nComp++
    const q = [root.id]
    while (q.length) {
      const nid = q.shift()!
      if (compOf.has(nid)) continue
      compOf.set(nid, comp)
      for (const nb of [...(parentOf.get(nid) ?? []), ...(childOf.get(nid) ?? [])]) {
        if (!compOf.has(nb)) q.push(nb)
      }
    }
  }
  for (const r of reqs) {
    if (!compOf.has(r.id)) compOf.set(r.id, nComp++)
  }

  // Group by component; sort components: largest first, then alphabetical
  const compNodes = new Map<number, string[]>()
  for (const [nid, c] of compOf) {
    compNodes.set(c, [...(compNodes.get(c) ?? []), nid])
  }
  const sortedComps = [...compNodes.keys()].sort((a, b) => {
    const sa = compNodes.get(a)!.length
    const sb = compNodes.get(b)!.length
    if (sb !== sa) return sb - sa
    const firstA = compNodes.get(a)!.map((id) => nodeMap.get(id)!.requirement_id).sort()[0] ?? ''
    const firstB = compNodes.get(b)!.map((id) => nodeMap.get(id)!.requirement_id).sort()[0] ?? ''
    return firstA.localeCompare(firstB)
  })

  const allNodes: DagNode[] = []
  let currentY = PADDING
  let globalMaxLayer = 0

  for (const comp of sortedComps) {
    const cIds = compNodes.get(comp)!

    // ── Layer assignment (longest-path via Kahn topological sort) ─────────
    const layerOf = new Map<string, number>()
    const inDeg   = new Map<string, number>()

    for (const nid of cIds) {
      const ps = (parentOf.get(nid) ?? []).filter((p) => compOf.get(p) === comp)
      inDeg.set(nid, ps.length)
      if (ps.length === 0) layerOf.set(nid, 0)
    }

    const topoQ = cIds.filter((nid) => inDeg.get(nid) === 0)
    while (topoQ.length) {
      const nid = topoQ.shift()!
      const nLayer = layerOf.get(nid) ?? 0
      for (const cid of (childOf.get(nid) ?? []).filter((c) => compOf.get(c) === comp)) {
        const newL = Math.max(layerOf.get(cid) ?? 0, nLayer + 1)
        layerOf.set(cid, newL)
        const rem = (inDeg.get(cid) ?? 1) - 1
        inDeg.set(cid, rem)
        if (rem <= 0) topoQ.push(cid)
      }
    }

    const maxLayer = Math.max(...[...layerOf.values()], 0)
    globalMaxLayer = Math.max(globalMaxLayer, maxLayer)

    // ── Group by layer ─────────────────────────────────────────────────────
    const layerGroups = new Map<number, string[]>()
    for (const nid of cIds) {
      const l = layerOf.get(nid) ?? 0
      layerGroups.set(l, [...(layerGroups.get(l) ?? []), nid])
    }

    // Sort layer 0 alphabetically
    layerGroups.set(
      0,
      (layerGroups.get(0) ?? []).sort((a, b) =>
        (nodeMap.get(a)?.requirement_id ?? '').localeCompare(nodeMap.get(b)?.requirement_id ?? '')
      ),
    )

    // ── Barycenter crossing minimisation (3 passes) ────────────────────────
    const yEst = new Map<string, number>()
    for (const [, nids] of layerGroups) nids.forEach((nid, i) => yEst.set(nid, i))

    const medY = (nid: string, useParents: boolean): number => {
      const nb = useParents
        ? (parentOf.get(nid) ?? []).filter((p) => compOf.get(p) === comp)
        : (childOf.get(nid)  ?? []).filter((c) => compOf.get(c) === comp)
      if (!nb.length) return yEst.get(nid) ?? 0
      const ys = nb.map((n) => yEst.get(n) ?? 0).sort((a, b) => a - b)
      return ys[Math.floor(ys.length / 2)]
    }

    for (let pass = 0; pass < 3; pass++) {
      const fwd = pass % 2 === 0
      const range = fwd
        ? Array.from({ length: maxLayer }, (_, i) => i + 1)
        : Array.from({ length: maxLayer }, (_, i) => maxLayer - 1 - i)
      for (const l of range) {
        const nids = layerGroups.get(l) ?? []
        const sorted = [...nids].sort((a, b) => medY(a, fwd) - medY(b, fwd))
        sorted.forEach((nid, i) => yEst.set(nid, i))
        layerGroups.set(l, sorted)
      }
    }

    // ── Coordinate assignment ──────────────────────────────────────────────
    const maxRows = Math.max(...[...layerGroups.values()].map((v) => v.length), 1)
    const compH = maxRows * (NODE_H + ROW_GAP) - ROW_GAP

    for (const [l, nids] of layerGroups) {
      nids.forEach((nid, i) => {
        allNodes.push({
          id: nid,
          req: nodeMap.get(nid)!,
          x: PADDING + l * COL_WIDTH,
          y: currentY + i * (NODE_H + ROW_GAP),
          layer: l,
        })
      })
    }

    currentY += compH + TREE_GAP
  }

  // ── Build edge list ────────────────────────────────────────────────────────
  const allEdges: DagEdge[] = []
  const seenEdges = new Set<string>()
  for (const lnk of links) {
    const { parent_requirement_id: pid, child_requirement_id: cid } = lnk
    if (pid === selfDerivedId) continue
    if (!nodeMap.has(pid) || !nodeMap.has(cid)) continue
    const key = `${pid}→${cid}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    allEdges.push({
      fromId: pid,
      toId: cid,
      isCrossTree: (parentOf.get(cid) ?? []).length > 1,
    })
  }

  const canvasW = PADDING * 2 + globalMaxLayer * COL_WIDTH + NODE_W
  const canvasH = Math.max(currentY - TREE_GAP + PADDING, PADDING * 4)
  return { nodes: allNodes, edges: allEdges, canvasW, canvasH }
}

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

function elbowPath(x1: number, y1: number, x2: number, y2: number): string {
  const xm = (x1 + x2) / 2
  return `M ${x1} ${y1} L ${xm} ${y1} L ${xm} ${y2} L ${x2} ${y2}`
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
  // ── Raw data ───────────────────────────────────────────────────────────────
  const [rawReqs, setRawReqs]     = useState<RequirementListItem[]>([])
  const [rawLinks, setRawLinks]   = useState<RequirementLink[]>([])
  const [selfId, setSelfId]       = useState<string | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)

  // ── Filter state ───────────────────────────────────────────────────────────
  const [disciplineFilter, setDisciplineFilter] = useState('All')
  const [statusFilter, setStatusFilter]         = useState<Set<string>>(new Set(ALL_STATUSES))
  const [highlight, setHighlight]               = useState('')

  // ── Tooltip state ─────────────────────────────────────────────────────────
  const [tooltip, setTooltip] = useState<{ node: DagNode; sx: number; sy: number } | null>(null)

  // ── Pan/zoom state ─────────────────────────────────────────────────────────
  const [isDragging, setIsDragging] = useState(false)
  const transformRef = useRef({ tx: 0, ty: 0, scale: 1 })
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef    = useRef<HTMLDivElement>(null)
  const dragRef      = useRef<{ startX: number; startY: number; startTx: number; startTy: number } | null>(null)
  const didPanRef    = useRef(false)

  function applyTransform() {
    if (!canvasRef.current) return
    const { tx, ty, scale } = transformRef.current
    canvasRef.current.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }

  // ── Layout (recomputed whenever data or filters change) ────────────────────
  const layout = useMemo<DagLayout | null>(() => {
    if (!selfId) return null
    const filtered = rawReqs.filter(
      (r) =>
        (r.classification_subtype === 'Performance Requirement' ||
          r.classification_subtype === 'Derived Requirement') &&
        !r.archived &&
        (disciplineFilter === 'All' || r.discipline === disciplineFilter) &&
        statusFilter.has(r.status),
    )
    return computeDagLayout(filtered, rawLinks, selfId)
  }, [rawReqs, rawLinks, selfId, disciplineFilter, statusFilter])

  // Available disciplines for the filter dropdown
  const availableDisciplines = useMemo(() => {
    const ds = new Set(
      rawReqs
        .filter(
          (r) =>
            r.classification_subtype === 'Performance Requirement' ||
            r.classification_subtype === 'Derived Requirement',
        )
        .map((r) => r.discipline),
    )
    return ['All', ...DISCIPLINE_ORDER.filter((d) => ds.has(d))]
  }, [rawReqs])

  // ── Data loading ───────────────────────────────────────────────────────────
  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [reqs, links, self] = await Promise.all([
        fetchAllRequirements(),
        fetchAllLinks(),
        fetchSelfDerived(),
      ])
      setRawReqs(reqs)
      setRawLinks(links)
      setSelfId(self.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load derivation tree')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Wheel zoom ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (loading) return
    const container = containerRef.current
    if (!container) return
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = container.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const { tx, ty, scale } = transformRef.current
      const factor = e.deltaY < 0 ? 1.1 : 0.91
      const newScale = Math.min(Math.max(scale * factor, 0.1), 5)
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

  // ── Focus centering ───────────────────────────────────────────────────────
  useEffect(() => {
    if (loading || !layout || !focusId) return
    const container = containerRef.current
    if (!container) return
    const node = layout.nodes.find((n) => n.id === focusId)
    if (!node) return
    transformRef.current = {
      tx: container.clientWidth  / 2 - (node.x + NODE_W / 2),
      ty: container.clientHeight / 2 - (node.y + NODE_H / 2),
      scale: 1,
    }
    applyTransform()
  }, [layout, focusId, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mouse handlers ─────────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    didPanRef.current = false
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      startTx: transformRef.current.tx, startTy: transformRef.current.ty,
    }
    setIsDragging(true)
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didPanRef.current = true
    transformRef.current = {
      ...transformRef.current,
      tx: dragRef.current.startTx + dx,
      ty: dragRef.current.startTy + dy,
    }
    applyTransform()
  }

  const handleMouseUp   = () => { dragRef.current = null; setIsDragging(false) }
  const handleMouseLeave = () => { dragRef.current = null; setIsDragging(false) }

  // ── Early returns ──────────────────────────────────────────────────────────
  if (loading) {
    return <div className="flex items-center justify-center h-full text-gray-400 text-sm">Loading…</div>
  }
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-sm text-red-600">{error}</p>
        <button onClick={() => void load()} className="text-xs text-blue-600 underline">Retry</button>
      </div>
    )
  }
  if (!layout) return null

  const { nodes, edges, canvasW, canvasH } = layout
  const posById = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]))
  const hlower  = highlight.trim().toLowerCase()

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* ── Header + filters ──────────────────────────────────────────── */}
      <div className="px-4 py-2.5 bg-white border-b border-gray-200 shrink-0 flex items-center gap-3 flex-wrap">
        <div className="shrink-0">
          <h2 className="text-sm font-semibold text-gray-700 leading-tight">Requirement Derivation Tree</h2>
          <p className="text-[10px] text-gray-400 leading-tight mt-0.5">
            Scroll to zoom · drag to pan · click node to open
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap ml-4">
          {/* Discipline filter */}
          <select
            value={disciplineFilter}
            onChange={(e) => setDisciplineFilter(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
          >
            {availableDisciplines.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>

          {/* Status filter — pill toggles */}
          <div className="flex items-center gap-1 flex-wrap">
            {ALL_STATUSES.map((s) => {
              const active = statusFilter.has(s)
              return (
                <button
                  key={s}
                  onClick={() =>
                    setStatusFilter((prev) => {
                      const next = new Set(prev)
                      next.has(s) ? next.delete(s) : next.add(s)
                      return next
                    })
                  }
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors ${
                    active
                      ? 'bg-gray-100 border-gray-300 text-gray-700'
                      : 'bg-white border-gray-200 text-gray-300'
                  }`}
                  title={active ? `Hide ${s}` : `Show ${s}`}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: active ? STATUS_DOT[s] : '#d1d5db' }}
                  />
                  {s}
                </button>
              )
            })}
          </div>

          {/* Highlight search */}
          <input
            type="text"
            value={highlight}
            onChange={(e) => setHighlight(e.target.value)}
            placeholder="Highlight…"
            className="border border-gray-300 rounded px-2 py-1 text-xs w-28 focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
        </div>

        <div className="ml-auto shrink-0">
          <button
            onClick={() => void load()}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* ── Canvas container ──────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden bg-gray-50 relative"
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      >

        {/* Inner canvas — receives CSS transform for pan/zoom */}
        <div
          ref={canvasRef}
          className="relative"
          style={{ width: canvasW, height: canvasH, transformOrigin: '0 0', willChange: 'transform' }}
        >

          {/* ── SVG: arrowhead markers + elbow edges ────────────────── */}
          <svg
            className="absolute inset-0 pointer-events-none"
            width={canvasW}
            height={canvasH}
            style={{ zIndex: 0 }}
          >
            <defs>
              <marker id="arrow-gray"  markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
                <polygon points="0 0, 7 2.5, 0 5" fill="#94a3b8" />
              </marker>
              <marker id="arrow-green" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
                <polygon points="0 0, 7 2.5, 0 5" fill="#16a34a" />
              </marker>
              <marker id="arrow-blue"  markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
                <polygon points="0 0, 7 2.5, 0 5" fill="#3b82f6" />
              </marker>
            </defs>

            {edges.map(({ fromId, toId, isCrossTree }) => {
              const from = posById.get(fromId)
              const to   = posById.get(toId)
              if (!from || !to) return null

              const x1 = from.x + NODE_W
              const y1 = from.y + NODE_H / 2
              const x2 = to.x
              const y2 = to.y + NODE_H / 2

              const color  = isCrossTree ? '#16a34a' : '#94a3b8'
              const width  = isCrossTree ? 1 : 0.5
              const marker = isCrossTree ? 'url(#arrow-green)' : 'url(#arrow-gray)'

              return (
                <path
                  key={`${fromId}-${toId}`}
                  d={elbowPath(x1, y1, x2, y2)}
                  fill="none"
                  stroke={color}
                  strokeWidth={width}
                  markerEnd={marker}
                />
              )
            })}
          </svg>

          {/* ── Node cards ──────────────────────────────────────────── */}
          {nodes.map((node) => {
            const isFocused = node.id === focusId
            const dStyle    = DISC_STYLE[node.req.discipline] ?? DEFAULT_DISC_STYLE
            const dotColor  = STATUS_DOT[node.req.status] ?? '#9ca3af'
            const isHighlighted =
              hlower.length > 0 &&
              (node.req.requirement_id.toLowerCase().includes(hlower) ||
               node.req.title.toLowerCase().includes(hlower))

            return (
              <div
                key={node.id}
                style={{
                  position: 'absolute',
                  left: node.x,
                  top: node.y,
                  width: NODE_W,
                  height: NODE_H,
                  zIndex: 10,
                  backgroundColor: dStyle.bg,
                  border: `1px solid ${isHighlighted ? '#d97706' : isFocused ? '#3b82f6' : dStyle.border}`,
                  boxShadow: isHighlighted
                    ? '0 0 0 2px #fbbf24'
                    : isFocused
                    ? '0 0 0 2px #93c5fd'
                    : undefined,
                  borderRadius: 8,
                  padding: '6px 8px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
                onClick={() => { if (!didPanRef.current) onSelect(node.id) }}
                onMouseEnter={() => {
                  const container = containerRef.current
                  if (!container) return
                  const { tx, ty, scale } = transformRef.current
                  setTooltip({
                    node,
                    sx: node.x * scale + tx + NODE_W * scale + 6,
                    sy: node.y * scale + ty,
                  })
                }}
                onMouseLeave={() => setTooltip(null)}
              >
                {/* Row 1: ID + status dot */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: dStyle.idColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {node.req.requirement_id}
                  </span>
                  <span
                    style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: dotColor, flexShrink: 0 }}
                    title={node.req.status}
                  />
                </div>
                {/* Row 2: Title */}
                <p style={{ fontSize: 11, color: '#374151', lineHeight: '1.3', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {node.req.title}
                </p>
              </div>
            )
          })}
        </div>

        {/* ── Tooltip (outside canvas div — stays in screen-space) ─── */}
        {tooltip && (
          <div
            style={{
              position: 'absolute',
              left: Math.min(tooltip.sx, (containerRef.current?.clientWidth ?? 600) - 220),
              top: Math.max(tooltip.sy, 4),
              zIndex: 50,
              pointerEvents: 'none',
            }}
            className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 w-52 text-xs"
          >
            <p className="font-mono font-bold text-blue-700 mb-1">{tooltip.node.req.requirement_id}</p>
            <p className="text-gray-800 mb-1.5 leading-snug">{tooltip.node.req.title}</p>
            <div className="space-y-0.5 text-gray-500">
              {tooltip.node.req.classification && (
                <p><span className="font-medium">Type:</span> {tooltip.node.req.classification}{tooltip.node.req.classification_subtype ? ` · ${tooltip.node.req.classification_subtype}` : ''}</p>
              )}
              <p><span className="font-medium">Discipline:</span> {tooltip.node.req.discipline}</p>
              <p><span className="font-medium">Owner:</span> {tooltip.node.req.owner}</p>
              <p><span className="font-medium">Status:</span> {tooltip.node.req.status}</p>
              {(tooltip.node.req.hierarchy_nodes?.length ?? 0) > 0 && (
                <p>
                  <span className="font-medium">Nodes:</span>{' '}
                  {tooltip.node.req.hierarchy_nodes!.map((n: { name: string }) => n.name).join(', ')}
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── Empty state ───────────────────────────────────────────── */}
        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-sm text-gray-400 text-center max-w-xs leading-relaxed">
              No derivation chains yet — create Performance or Derived Requirements and link them as parent/child to see the tree.
            </p>
          </div>
        )}

        {/* ── Hints overlay ─────────────────────────────────────────── */}
        <div
          className="absolute bottom-4 right-4 text-gray-400 text-[10px] text-right space-y-0.5 pointer-events-none select-none"
          style={{ zIndex: 20 }}
        >
          {edges.some((e) => e.isCrossTree) && (
            <p className="text-green-600">Green edges = cross-tree derivation</p>
          )}
          <p>Scroll — zoom</p>
          <p>Drag — pan</p>
          <p>Click node — open</p>
        </div>

      </div>
    </div>
  )
}
