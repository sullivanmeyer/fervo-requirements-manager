/**
 * DocumentNetwork — Stage 8
 *
 * Interactive force-directed graph of all source documents and their
 * reference relationships.  No external graph library — built on an HTML5
 * Canvas with a hand-rolled physics simulation:
 *
 *   Forces:  repulsion (all pairs) + spring (edges) + centering
 *   Interactions: pan (drag background), zoom (wheel), drag nodes,
 *                 hover (tooltip), click (select + detail panel)
 *
 * Node size reflects total connection count (in + out).
 * Node color reflects document type.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchDocumentGraph } from '../api/documentReferences'
import type { DocumentGraph, GraphNode, GraphEdge } from '../types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const K_REPEL = 6000    // repulsion strength (node-pair)
const K_SPRING = 0.04   // spring constant for edges
const SPRING_REST = 130 // rest length of edge springs (px)
const K_CENTER = 0.003  // centering pull strength
const DAMPING = 0.86    // velocity decay per tick
const MIN_DIST = 30     // minimum distance for repulsion (avoids infinity)
const TICKS_PER_FRAME = 3  // physics steps per animation frame

const NODE_TYPE_COLORS: Record<string, string> = {
  'Code/Standard': '#3B82F6',      // blue
  'Specification': '#10B981',       // green
  'Technical Report': '#8B5CF6',   // purple
  'Drawing': '#F59E0B',            // amber
  'Datasheet': '#EC4899',          // pink
  'Other': '#6B7280',              // gray
}

const DEFAULT_NODE_COLOR = '#6B7280'

function nodeColor(type: string, isStub: boolean): string {
  if (isStub) return '#D1D5DB'  // always gray for stubs — not-yet-registered
  return NODE_TYPE_COLORS[type] ?? DEFAULT_NODE_COLOR
}

function nodeRadius(connectionCount: number): number {
  return 12 + 3 * Math.sqrt(connectionCount)
}

// ---------------------------------------------------------------------------
// Physics state (kept in ref, not React state — never triggers re-renders)
// ---------------------------------------------------------------------------

interface SimNodeState {
  id: string
  x: number
  y: number
  vx: number
  vy: number
}

// ---------------------------------------------------------------------------
// Hit-test: is point (px, py) inside a node? Returns node id or null.
// ---------------------------------------------------------------------------

function hitTest(
  px: number,
  py: number,
  nodes: GraphNode[],
  positions: Map<string, SimNodeState>,
): string | null {
  for (const n of nodes) {
    const s = positions.get(n.id)
    if (!s) continue
    const r = nodeRadius(n.in_count + n.out_count)
    const dx = px - s.x
    const dy = py - s.y
    if (dx * dx + dy * dy <= r * r) return n.id
  }
  return null
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  focusDocumentId?: string | null
  onOpenDocument?: (documentId: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DocumentNetwork({ focusDocumentId, onOpenDocument }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Graph data
  const [graph, setGraph] = useState<DocumentGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Selected node (React state — drives the side panel)
  const [selectedId, setSelectedId] = useState<string | null>(focusDocumentId ?? null)

  // Physics + render state stored in refs (mutated without triggering renders)
  const positionsRef = useRef<Map<string, SimNodeState>>(new Map())
  const transformRef = useRef({ tx: 0, ty: 0, scale: 1 })
  const hoveredIdRef = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(focusDocumentId ?? null)
  const rafRef = useRef<number>(0)
  const graphRef = useRef<DocumentGraph | null>(null)

  // Pan / drag state
  const dragRef = useRef<{
    type: 'pan' | 'node'
    nodeId?: string
    startX: number
    startY: number
    startTx?: number
    startTy?: number
    startNx?: number
    startNy?: number
    moved: boolean
  } | null>(null)

  // Canvas size in React state — drives the width/height attributes on the canvas element
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 })

  // ---------------------------------------------------------------------------
  // Load graph data
  // ---------------------------------------------------------------------------

  useEffect(() => {
    void (async () => {
      try {
        const g = await fetchDocumentGraph()
        setGraph(g)
        graphRef.current = g
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Failed to load graph')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // ---------------------------------------------------------------------------
  // Initialize positions when graph loads
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!graph) return
    const w = canvasRef.current?.width ?? 800
    const h = canvasRef.current?.height ?? 600
    const cx = w / 2
    const cy = h / 2
    const positions = new Map<string, SimNodeState>()

    graph.nodes.forEach((n, i) => {
      // Spread nodes in a circle with a bit of jitter
      const angle = (i / graph.nodes.length) * 2 * Math.PI
      const radius = 150 + Math.random() * 80
      positions.set(n.id, {
        id: n.id,
        x: cx + Math.cos(angle) * radius + (Math.random() - 0.5) * 20,
        y: cy + Math.sin(angle) * radius + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
      })
    })
    positionsRef.current = positions

    // If a focus node was requested, we'll center on it after simulation warms up
    // (handled in the draw loop after ~80 ticks)
  }, [graph])

  // ---------------------------------------------------------------------------
  // Canvas sizing — keep the drawing buffer matched to the container.
  // A ResizeObserver drives the state; a one-shot effect seeds the initial
  // size from the actual container dimensions so there is no 800×600 flash.
  // ---------------------------------------------------------------------------

  // NOTE: `loading` is a dependency here on purpose.
  // The canvas container div is only mounted after loading completes (the
  // early loading-spinner return replaces the full JSX).  Running with []
  // means this effect fires while containerRef.current is still null, the
  // guard bails out, and the ResizeObserver is never installed.  Including
  // `loading` re-runs the effect the moment the container appears in the DOM.
  useEffect(() => {
    if (loading) return   // container not yet in DOM
    const container = containerRef.current
    if (!container) return

    // Seed canvas size from the real container dimensions now that it's mounted
    const { clientWidth: w, clientHeight: h } = container
    if (w > 0 && h > 0) setCanvasSize({ w, h })

    // Keep in sync when the container is resized (e.g. browser window resize)
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setCanvasSize({ w: Math.floor(width), h: Math.floor(height) })
      }
    })
    obs.observe(container)
    return () => obs.disconnect()
  }, [loading])

  // ---------------------------------------------------------------------------
  // Physics step
  // ---------------------------------------------------------------------------

  const tickPhysics = useCallback((nodes: GraphNode[], edges: GraphEdge[]) => {
    const pos = positionsRef.current
    const cx = (canvasRef.current?.width ?? 800) / 2
    const cy = (canvasRef.current?.height ?? 600) / 2

    // Repulsion — every pair
    for (let i = 0; i < nodes.length; i++) {
      const a = pos.get(nodes[i].id)
      if (!a) continue
      for (let j = i + 1; j < nodes.length; j++) {
        const b = pos.get(nodes[j].id)
        if (!b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), MIN_DIST)
        const force = K_REPEL / (dist * dist)
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx -= fx
        a.vy -= fy
        b.vx += fx
        b.vy += fy
      }
    }

    // Spring attraction — edges
    for (const edge of edges) {
      const a = pos.get(edge.source_id)
      const b = pos.get(edge.target_id)
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
      const displacement = dist - SPRING_REST
      const force = K_SPRING * displacement
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }

    // Centering + integrate
    for (const n of nodes) {
      const s = pos.get(n.id)
      if (!s) continue
      s.vx += (cx - s.x) * K_CENTER
      s.vy += (cy - s.y) * K_CENTER
      s.vx *= DAMPING
      s.vy *= DAMPING
      s.x += s.vx
      s.y += s.vy
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Draw
  // ---------------------------------------------------------------------------

  const draw = useCallback((nodes: GraphNode[], edges: GraphEdge[]) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { tx, ty, scale } = transformRef.current
    const pos = positionsRef.current
    const hovId = hoveredIdRef.current
    const selId = selectedIdRef.current

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.translate(tx, ty)
    ctx.scale(scale, scale)

    // Dim non-connected nodes when hovering
    const connectedIds = new Set<string>()
    if (hovId) {
      connectedIds.add(hovId)
      for (const e of edges) {
        if (e.source_id === hovId) connectedIds.add(e.target_id)
        if (e.target_id === hovId) connectedIds.add(e.source_id)
      }
    }

    // Draw edges
    for (const edge of edges) {
      const a = pos.get(edge.source_id)
      const b = pos.get(edge.target_id)
      if (!a || !b) continue

      const isHighlighted = hovId
        ? connectedIds.has(edge.source_id) && connectedIds.has(edge.target_id)
        : true

      ctx.globalAlpha = isHighlighted ? 0.75 : 0.12
      ctx.strokeStyle = isHighlighted ? '#94A3B8' : '#CBD5E1'
      ctx.lineWidth = 1.5

      // Draw line
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()

      // Draw arrowhead at target end (offset by node radius)
      const tgtNode = nodes.find((n) => n.id === edge.target_id)
      const r = tgtNode ? nodeRadius(tgtNode.in_count + tgtNode.out_count) : 14
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < 1) continue
      const ux = dx / len
      const uy = dy / len
      // Arrowhead tip at node circumference
      const tipX = b.x - ux * (r + 2)
      const tipY = b.y - uy * (r + 2)
      const arrowLen = 10
      const arrowWidth = 4
      const perpX = -uy * arrowWidth
      const perpY = ux * arrowWidth
      ctx.beginPath()
      ctx.moveTo(tipX, tipY)
      ctx.lineTo(tipX - ux * arrowLen + perpX, tipY - uy * arrowLen + perpY)
      ctx.lineTo(tipX - ux * arrowLen - perpX, tipY - uy * arrowLen - perpY)
      ctx.closePath()
      ctx.fillStyle = isHighlighted ? '#94A3B8' : '#CBD5E1'
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // Draw nodes
    for (const n of nodes) {
      const s = pos.get(n.id)
      if (!s) continue
      const r = nodeRadius(n.in_count + n.out_count)
      const isHovered = n.id === hovId
      const isSelected = n.id === selId
      const isDimmed = hovId && !connectedIds.has(n.id)

      ctx.globalAlpha = isDimmed ? 0.2 : 1
      const color = nodeColor(n.document_type, n.is_stub)

      // Shadow / glow for selected
      if (isSelected) {
        ctx.shadowColor = color
        ctx.shadowBlur = 14
      }

      // Fill
      ctx.beginPath()
      ctx.arc(s.x, s.y, r, 0, 2 * Math.PI)
      ctx.fillStyle = color
      ctx.fill()

      // Stroke — stubs get a dashed border to signal "not yet registered"
      ctx.lineWidth = isSelected ? 3 : isHovered ? 2 : 1.5
      ctx.strokeStyle = isSelected ? '#fff' : isHovered ? '#fff' : n.is_stub ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)'
      if (n.is_stub) ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.setLineDash([])

      ctx.shadowBlur = 0

      // Label — document_id (short ID like "API 661")
      const fontSize = Math.max(9, Math.min(12, r * 0.7))
      ctx.font = `${isSelected ? 'bold ' : ''}${fontSize}px system-ui, sans-serif`
      ctx.fillStyle = isDimmed ? 'rgba(255,255,255,0.4)' : '#fff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      // Truncate label to fit inside node
      let label = n.document_id
      const maxWidth = r * 1.7
      while (ctx.measureText(label).width > maxWidth && label.length > 4) {
        label = label.slice(0, -1)
      }
      if (label !== n.document_id) label += '…'
      ctx.fillText(label, s.x, s.y)
    }
    ctx.globalAlpha = 1

    ctx.restore()

    // Tooltip for hovered node (drawn in screen-space, outside transform)
    if (hovId) {
      const s = pos.get(hovId)
      const n = nodes.find((x) => x.id === hovId)
      if (s && n) {
        const sx = s.x * scale + tx
        const sy = s.y * scale + ty
        const lines = [
          n.title.length > 40 ? n.title.slice(0, 37) + '…' : n.title,
          n.is_stub ? '⚠ Not yet registered' : (n.document_type + (n.revision ? ` · ${n.revision}` : '')),
          n.is_stub ? 'Auto-detected reference — click to register' : (n.issuing_organization ?? ''),
          `${n.out_count} refs out · ${n.in_count} refs in`,
        ].filter(Boolean)

        const pad = 8
        const lineH = 16
        const boxW = 220
        const boxH = lines.length * lineH + pad * 2

        let bx = sx + 14
        let by = sy - boxH / 2
        if (bx + boxW > canvas.width) bx = sx - boxW - 14
        if (by < 4) by = 4
        if (by + boxH > canvas.height - 4) by = canvas.height - boxH - 4

        ctx.fillStyle = 'rgba(15, 23, 42, 0.92)'
        ctx.beginPath()
        ctx.roundRect(bx, by, boxW, boxH, 6)
        ctx.fill()

        ctx.font = '12px system-ui, sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        lines.forEach((line, i) => {
          ctx.fillStyle = i === 0 ? '#F1F5F9' : '#94A3B8'
          if (i === 0) ctx.font = 'bold 12px system-ui, sans-serif'
          else ctx.font = '11px system-ui, sans-serif'
          ctx.fillText(line, bx + pad, by + pad + i * lineH)
        })
      }
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Animation loop
  // ---------------------------------------------------------------------------

  const tickCountRef = useRef(0)
  const centeredOnFocusRef = useRef(false)

  const loop = useCallback(() => {
    const g = graphRef.current
    if (!g) {
      rafRef.current = requestAnimationFrame(loop)
      return
    }

    for (let i = 0; i < TICKS_PER_FRAME; i++) {
      tickPhysics(g.nodes, g.edges)
    }
    tickCountRef.current += TICKS_PER_FRAME

    // After ~80 ticks (simulation has calmed), if a focus node was requested,
    // pan so it's centered on screen.
    if (
      focusDocumentId &&
      !centeredOnFocusRef.current &&
      tickCountRef.current >= 80
    ) {
      const s = positionsRef.current.get(focusDocumentId)
      const canvas = canvasRef.current
      if (s && canvas) {
        transformRef.current = {
          tx: canvas.width / 2 - s.x,
          ty: canvas.height / 2 - s.y,
          scale: 1,
        }
        centeredOnFocusRef.current = true
      }
    }

    draw(g.nodes, g.edges)
    rafRef.current = requestAnimationFrame(loop)
  }, [tickPhysics, draw, focusDocumentId])

  // Start / stop loop
  useEffect(() => {
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [loop])

  // ---------------------------------------------------------------------------
  // Mouse event helpers — canvas coords → world coords
  // ---------------------------------------------------------------------------

  function canvasToWorld(cx: number, cy: number) {
    const { tx, ty, scale } = transformRef.current
    return { x: (cx - tx) / scale, y: (cy - ty) / scale }
  }

  function getCanvasXY(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { cx: e.clientX - rect.left, cy: e.clientY - rect.top }
  }

  // ---------------------------------------------------------------------------
  // Mouse events
  // ---------------------------------------------------------------------------

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const { cx, cy } = getCanvasXY(e)
    const { tx, ty, scale } = transformRef.current
    const factor = e.deltaY < 0 ? 1.1 : 0.91
    const newScale = Math.min(Math.max(scale * factor, 0.15), 8)
    // Keep point under cursor fixed in world-space
    transformRef.current = {
      tx: cx - (cx - tx) * (newScale / scale),
      ty: cy - (cy - ty) * (newScale / scale),
      scale: newScale,
    }
  }

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    const { cx, cy } = getCanvasXY(e)
    const world = canvasToWorld(cx, cy)
    const g = graphRef.current
    if (!g) return

    const hit = hitTest(world.x, world.y, g.nodes, positionsRef.current)
    if (hit) {
      const s = positionsRef.current.get(hit)!
      dragRef.current = {
        type: 'node',
        nodeId: hit,
        startX: cx,
        startY: cy,
        startNx: s.x,
        startNy: s.y,
        moved: false,
      }
    } else {
      const { tx, ty } = transformRef.current
      dragRef.current = {
        type: 'pan',
        startX: cx,
        startY: cy,
        startTx: tx,
        startTy: ty,
        moved: false,
      }
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { cx, cy } = getCanvasXY(e)
    const world = canvasToWorld(cx, cy)
    const g = graphRef.current

    if (dragRef.current) {
      const dx = cx - dragRef.current.startX
      const dy = cy - dragRef.current.startY
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true

      if (dragRef.current.type === 'pan') {
        transformRef.current = {
          ...transformRef.current,
          tx: (dragRef.current.startTx ?? 0) + dx,
          ty: (dragRef.current.startTy ?? 0) + dy,
        }
      } else if (dragRef.current.type === 'node' && dragRef.current.nodeId) {
        const { scale } = transformRef.current
        const s = positionsRef.current.get(dragRef.current.nodeId)
        if (s) {
          s.x = (dragRef.current.startNx ?? 0) + dx / scale
          s.y = (dragRef.current.startNy ?? 0) + dy / scale
          s.vx = 0
          s.vy = 0
        }
      }
    } else if (g) {
      // Hover detection
      const hit = hitTest(world.x, world.y, g.nodes, positionsRef.current)
      hoveredIdRef.current = hit
      if (canvasRef.current) {
        canvasRef.current.style.cursor = hit ? 'pointer' : 'default'
      }
    }
  }

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.moved) return
    // It was a click (no significant movement)
    if (drag.type === 'node' && drag.nodeId) {
      const newSel = drag.nodeId === selectedIdRef.current ? null : drag.nodeId
      selectedIdRef.current = newSel
      setSelectedId(newSel)
    } else if (drag.type === 'pan') {
      // Click on background — deselect
      selectedIdRef.current = null
      setSelectedId(null)
    }
  }

  const handleMouseLeave = () => {
    hoveredIdRef.current = null
    dragRef.current = null
    if (canvasRef.current) canvasRef.current.style.cursor = 'default'
  }

  // ---------------------------------------------------------------------------
  // Selected node detail
  // ---------------------------------------------------------------------------

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId) ?? null
  const outEdges = graph?.edges.filter((e) => e.source_id === selectedId) ?? []
  const inEdges = graph?.edges.filter((e) => e.target_id === selectedId) ?? []

  // ---------------------------------------------------------------------------
  // Legend data
  // ---------------------------------------------------------------------------

  const legendTypes = Object.entries(NODE_TYPE_COLORS)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        Loading document network…
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center h-full text-sm">
        <div className="text-center">
          <p className="text-red-600 font-medium">Failed to load graph</p>
          <p className="text-gray-400 mt-1">{loadError}</p>
        </div>
      </div>
    )
  }

  const nodeCount = graph?.nodes.length ?? 0

  return (
    <div className="flex h-full overflow-hidden">

      {/* ------------------------------------------------------------------ */}
      {/* Graph canvas area                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden bg-slate-950">

        {nodeCount === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-slate-400">
              <p className="text-lg font-medium">No documents yet</p>
              <p className="text-sm mt-1">Register source documents, then add references between them.</p>
            </div>
          </div>
        )}

        <canvas
          ref={canvasRef}
          width={canvasSize.w}
          height={canvasSize.h}
          className="block"
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        />

        {/* Legend (bottom-left corner) */}
        <div className="absolute bottom-4 left-4 bg-slate-900/90 rounded-lg px-3 py-2 text-xs space-y-1">
          <p className="text-slate-400 font-semibold uppercase tracking-wider text-[10px] mb-1.5">
            Document Type
          </p>
          {legendTypes.map(([type, color]) => (
            <div key={type} className="flex items-center gap-2">
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="text-slate-300">{type}</span>
            </div>
          ))}
        </div>

        {/* Controls hint (bottom-right) */}
        <div className="absolute bottom-4 right-4 text-slate-500 text-[10px] text-right space-y-0.5 pointer-events-none">
          <p>Scroll — zoom</p>
          <p>Drag background — pan</p>
          <p>Drag node — reposition</p>
          <p>Click node — details</p>
        </div>

        {/* Node count (top-left) */}
        <div className="absolute top-4 left-4 text-slate-400 text-xs">
          {nodeCount} document{nodeCount !== 1 ? 's' : ''} · {graph?.edges.length ?? 0} reference{(graph?.edges.length ?? 0) !== 1 ? 's' : ''}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Side panel — selected node detail                                   */}
      {/* ------------------------------------------------------------------ */}
      {selectedNode && (
        <div className="w-72 shrink-0 bg-white border-l border-gray-200 flex flex-col overflow-hidden">

          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-200 flex items-start gap-2">
            <span
              className="w-3 h-3 rounded-full mt-0.5 shrink-0"
              style={{ backgroundColor: nodeColor(selectedNode.document_type) }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-800 break-words leading-tight">
                {selectedNode.title}
              </p>
              <p className="text-xs font-mono text-blue-600 mt-0.5">{selectedNode.document_id}</p>
            </div>
            <button
              onClick={() => { setSelectedId(null); selectedIdRef.current = null }}
              className="text-gray-400 hover:text-gray-600 text-lg leading-none shrink-0"
              title="Close"
            >
              ×
            </button>
          </div>

          {/* Stub notice */}
          {selectedNode.is_stub && (
            <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800">
              <span className="font-semibold">Not yet registered.</span> This document was auto-detected as a reference. Open it to fill in the full metadata.
            </div>
          )}

          {/* Metadata */}
          <div className="px-4 py-3 border-b border-gray-200 space-y-1 text-xs text-gray-500">
            <p><span className="font-medium text-gray-700">Type:</span> {selectedNode.document_type}</p>
            {selectedNode.issuing_organization && (
              <p><span className="font-medium text-gray-700">Org:</span> {selectedNode.issuing_organization}</p>
            )}
            {selectedNode.revision && (
              <p><span className="font-medium text-gray-700">Revision:</span> {selectedNode.revision}</p>
            )}
            {selectedNode.disciplines.length > 0 && (
              <p><span className="font-medium text-gray-700">Disciplines:</span> {selectedNode.disciplines.join(', ')}</p>
            )}
            <div className="flex gap-4 mt-1">
              <span className="text-blue-600 font-medium">{selectedNode.out_count} out</span>
              <span className="text-purple-600 font-medium">{selectedNode.in_count} in</span>
            </div>
          </div>

          {/* Outgoing references */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs">
            {outEdges.length > 0 && (
              <div>
                <p className="font-semibold text-gray-500 uppercase tracking-wider text-[10px] mb-2">
                  Cites ({outEdges.length})
                </p>
                <div className="space-y-1.5">
                  {outEdges.map((e) => {
                    const target = graph!.nodes.find((n) => n.id === e.target_id)
                    if (!target) return null
                    return (
                      <button
                        key={e.id}
                        onClick={() => { setSelectedId(target.id); selectedIdRef.current = target.id }}
                        className="w-full text-left px-2 py-1.5 rounded bg-blue-50 border border-blue-100 hover:border-blue-300 transition-colors"
                      >
                        <span className="font-mono font-semibold text-blue-700 block">{target.document_id}</span>
                        <span className="text-gray-600 line-clamp-1">{target.title}</span>
                        {e.reference_context && (
                          <span className="text-gray-400 italic">{e.reference_context}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {inEdges.length > 0 && (
              <div>
                <p className="font-semibold text-gray-500 uppercase tracking-wider text-[10px] mb-2">
                  Referenced By ({inEdges.length})
                </p>
                <div className="space-y-1.5">
                  {inEdges.map((e) => {
                    const source = graph!.nodes.find((n) => n.id === e.source_id)
                    if (!source) return null
                    return (
                      <button
                        key={e.id}
                        onClick={() => { setSelectedId(source.id); selectedIdRef.current = source.id }}
                        className="w-full text-left px-2 py-1.5 rounded bg-purple-50 border border-purple-100 hover:border-purple-300 transition-colors"
                      >
                        <span className="font-mono font-semibold text-purple-700 block">{source.document_id}</span>
                        <span className="text-gray-600 line-clamp-1">{source.title}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {outEdges.length === 0 && inEdges.length === 0 && (
              <p className="text-gray-400 italic">No references recorded for this document.</p>
            )}
          </div>

          {/* Open document button */}
          {onOpenDocument && (
            <div className="px-4 py-3 border-t border-gray-200">
              <button
                onClick={() => onOpenDocument(selectedNode.id)}
                className="w-full px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Open Document
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
