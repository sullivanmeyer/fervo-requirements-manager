/**
 * BlockDiagram — System Hierarchy Block View
 *
 * Renders the top-level system modules (direct children of the root hierarchy
 * node) as labelled blocks arranged in a grid.  Inside each block:
 *   - Sub-component names (direct children of the module)
 *   - Compact requirement cards for every requirement linked to the module
 *     or any of its sub-components
 *
 * SVG overlay draws arrows between blocks whenever a requirement in block A
 * has a child requirement (via requirement_links) that lives in block B.
 *
 * Layout: 3-column grid.  Each block is a fixed-width card; the overall
 * canvas is sized to fit all blocks plus inter-block arrows.
 */
import { useEffect, useRef, useState } from 'react'
import { fetchAllLinks, fetchAllRequirements } from '../api/requirements'
import type { HierarchyNode, RequirementLink, RequirementListItem } from '../types'

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const BLOCK_W = 300
const BLOCK_H_MIN = 240   // minimum block height — grows to fit content
const COL_GAP = 70
const ROW_GAP = 80
const COLS = 3
const PADDING = 48

const STATUS_CLASSES: Record<string, string> = {
  Draft: 'bg-gray-100 text-gray-600',
  'Under Review': 'bg-yellow-100 text-yellow-800',
  Approved: 'bg-green-100 text-green-800',
  Superseded: 'bg-orange-100 text-orange-800',
  Withdrawn: 'bg-red-100 text-red-800',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all node IDs in a subtree (including the root). */
function subtreeIds(node: HierarchyNode): Set<string> {
  const ids = new Set<string>()
  const queue: HierarchyNode[] = [node]
  while (queue.length > 0) {
    const n = queue.shift()!
    ids.add(n.id)
    for (const child of n.children) queue.push(child)
  }
  return ids
}

/** Find the root of the hierarchy (the node with no parent). */
function findRoot(nodes: HierarchyNode[]): HierarchyNode | null {
  return nodes.find((n) => n.parent_id === null) ?? null
}

// ---------------------------------------------------------------------------
// Data model assembled from props + fetched data
// ---------------------------------------------------------------------------

interface BlockData {
  module: HierarchyNode           // top-level module node
  subComponents: HierarchyNode[]  // direct children of the module
  requirements: RequirementListItem[]
  col: number                     // 0-based grid column
  row: number                     // 0-based grid row
  x: number                       // left edge (px)
  y: number                       // top edge (px)
  height: number                  // computed height
}

interface Arrow {
  fromModuleId: string
  toModuleId: string
}

interface DiagramData {
  blocks: BlockData[]
  arrows: Arrow[]
  canvasW: number
  canvasH: number
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  hierarchyNodes: HierarchyNode[]
  onOpenDetail: (id: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BlockDiagram({ hierarchyNodes, onOpenDetail }: Props) {
  const [allRequirements, setAllRequirements] = useState<RequirementListItem[]>([])
  const [allLinks, setAllLinks] = useState<RequirementLink[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // We need to measure block heights after render to position arrows correctly.
  // Key: module node id → DOM element
  const blockRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [blockHeights, setBlockHeights] = useState<Map<string, number>>(new Map())

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [reqs, links] = await Promise.all([
        fetchAllRequirements(),
        fetchAllLinks(),
      ])
      setAllRequirements(reqs)
      setAllLinks(links)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load diagram data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // After layout renders, measure actual block heights via the DOM
  useEffect(() => {
    if (loading) return
    const measured = new Map<string, number>()
    blockRefs.current.forEach((el, id) => {
      measured.set(id, el.getBoundingClientRect().height)
    })
    setBlockHeights(measured)
  }, [loading, allRequirements, allLinks, hierarchyNodes])

  // -------------------------------------------------------------------------
  // Build diagram data
  // -------------------------------------------------------------------------

  const diagram: DiagramData | null = (() => {
    if (loading || hierarchyNodes.length === 0) return null

    const root = findRoot(hierarchyNodes)
    if (!root) return null

    const modules = root.children.filter((n) => !n.archived)
    if (modules.length === 0) return null

    // For each module, compute which hierarchy-node IDs belong to its subtree
    const moduleSubtrees = new Map<string, Set<string>>()
    for (const mod of modules) {
      moduleSubtrees.set(mod.id, subtreeIds(mod))
    }

    // Map each hierarchy-node ID → which module it belongs to
    const nodeToModule = new Map<string, string>()
    for (const [moduleId, ids] of moduleSubtrees) {
      for (const id of ids) nodeToModule.set(id, moduleId)
    }

    // Map each requirement ID → all modules it belongs to
    // (a req linked to nodes in multiple modules appears in each of them)
    const reqToModules = new Map<string, Set<string>>()
    for (const req of allRequirements) {
      for (const hn of req.hierarchy_nodes) {
        const modId = nodeToModule.get(hn.id)
        if (modId) {
          if (!reqToModules.has(req.id)) reqToModules.set(req.id, new Set())
          reqToModules.get(req.id)!.add(modId)
        }
      }
    }

    // Group requirements by module — a req can appear in multiple blocks
    const blockReqs = new Map<string, RequirementListItem[]>()
    for (const mod of modules) blockReqs.set(mod.id, [])
    for (const req of allRequirements) {
      const modIds = reqToModules.get(req.id)
      if (modIds) {
        for (const modId of modIds) {
          if (blockReqs.has(modId)) blockReqs.get(modId)!.push(req)
        }
      }
    }

    // Compute inter-block arrows: link parent in module A → child in module B
    // A req in multiple modules can generate arrows from each of those modules
    const arrowSet = new Set<string>()
    const arrows: Arrow[] = []
    for (const link of allLinks) {
      const fromMods = reqToModules.get(link.parent_requirement_id) ?? new Set<string>()
      const toMods = reqToModules.get(link.child_requirement_id) ?? new Set<string>()
      for (const fromMod of fromMods) {
        for (const toMod of toMods) {
          if (fromMod !== toMod) {
            const key = `${fromMod}→${toMod}`
            if (!arrowSet.has(key)) {
              arrowSet.add(key)
              arrows.push({ fromModuleId: fromMod, toModuleId: toMod })
            }
          }
        }
      }
    }

    // Grid layout
    const blocks: BlockData[] = modules.map((mod, i) => {
      const col = i % COLS
      const row = Math.floor(i / COLS)
      const x = PADDING + col * (BLOCK_W + COL_GAP)
      const y = PADDING + row * (BLOCK_H_MIN + ROW_GAP)
      // Use measured height if available, otherwise fall back to minimum
      const height = blockHeights.get(mod.id) ?? BLOCK_H_MIN

      return {
        module: mod,
        subComponents: mod.children.filter((c) => !c.archived),
        requirements: blockReqs.get(mod.id) ?? [],
        col,
        row,
        x,
        y,
        height,
      }
    })

    const numRows = Math.ceil(modules.length / COLS)
    const canvasW = PADDING * 2 + COLS * BLOCK_W + (COLS - 1) * COL_GAP
    // For canvas height, use the max measured block height per row
    const rowMaxHeights: number[] = Array(numRows).fill(BLOCK_H_MIN)
    for (const b of blocks) {
      rowMaxHeights[b.row] = Math.max(rowMaxHeights[b.row], b.height)
    }
    const canvasH =
      PADDING * 2 +
      rowMaxHeights.reduce((sum, h) => sum + h, 0) +
      (numRows - 1) * ROW_GAP

    // Recompute block y positions using actual row heights
    let currentY = PADDING
    const rowStartY: number[] = []
    for (let r = 0; r < numRows; r++) {
      rowStartY.push(currentY)
      currentY += rowMaxHeights[r] + ROW_GAP
    }
    for (const b of blocks) {
      b.y = rowStartY[b.row]
    }

    return { blocks, arrows, canvasW, canvasH }
  })()

  // -------------------------------------------------------------------------
  // Arrow path between two blocks
  // -------------------------------------------------------------------------

  function arrowPath(from: BlockData, to: BlockData): string {
    const fromCenterX = from.x + BLOCK_W / 2
    const fromCenterY = from.y + from.height / 2
    const toCenterX = to.x + BLOCK_W / 2
    const toCenterY = to.y + to.height / 2

    if (from.row === to.row) {
      // Same row: straight horizontal line from right edge to left edge
      if (from.col < to.col) {
        // From → right edge, To → left edge
        const x1 = from.x + BLOCK_W
        const y1 = fromCenterY
        const x2 = to.x
        const y2 = toCenterY
        const midX = (x1 + x2) / 2
        return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
      } else {
        const x1 = from.x
        const y1 = fromCenterY
        const x2 = to.x + BLOCK_W
        const y2 = toCenterY
        const midX = (x1 + x2) / 2
        return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
      }
    } else if (from.row < to.row) {
      // From is above To: bottom edge → top edge
      const x1 = fromCenterX
      const y1 = from.y + from.height
      const x2 = toCenterX
      const y2 = to.y
      const midY = (y1 + y2) / 2
      return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
    } else {
      // From is below To: top edge → bottom edge
      const x1 = fromCenterX
      const y1 = from.y
      const x2 = toCenterX
      const y2 = to.y + to.height
      const midY = (y1 + y2) / 2
      return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

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

  if (!diagram) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        No hierarchy data available.
      </div>
    )
  }

  const { blocks, arrows, canvasW, canvasH } = diagram
  const blockById = new Map(blocks.map((b) => [b.module.id, b]))

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 bg-white border-b border-gray-200 shrink-0 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">System Block Diagram</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Each block is a top-level module. Cards inside show linked requirements. Arrows show cross-module requirement dependencies.
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
      <div className="flex-1 overflow-auto bg-gray-100">
        <div className="relative" style={{ width: canvasW, height: canvasH, minWidth: '100%' }}>

          {/* SVG arrow layer — sits on top of blocks */}
          <svg
            className="absolute inset-0 pointer-events-none"
            width={canvasW}
            height={canvasH}
            style={{ zIndex: 20 }}
          >
            <defs>
              <marker
                id="block-arrow"
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill="#6366f1" />
              </marker>
            </defs>
            {arrows.map(({ fromModuleId, toModuleId }) => {
              const from = blockById.get(fromModuleId)
              const to = blockById.get(toModuleId)
              if (!from || !to) return null
              return (
                <path
                  key={`${fromModuleId}-${toModuleId}`}
                  d={arrowPath(from, to)}
                  fill="none"
                  stroke="#6366f1"
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  markerEnd="url(#block-arrow)"
                />
              )
            })}
          </svg>

          {/* Block cards */}
          {blocks.map((block) => {
            const { module, subComponents, requirements } = block
            return (
              <div
                key={module.id}
                ref={(el) => {
                  if (el) blockRefs.current.set(module.id, el)
                  else blockRefs.current.delete(module.id)
                }}
                style={{
                  position: 'absolute',
                  left: block.x,
                  top: block.y,
                  width: BLOCK_W,
                  zIndex: 10,
                }}
                className="bg-white border border-gray-300 rounded-xl shadow-sm overflow-hidden"
              >
                {/* Module header */}
                <div className="px-3 py-2 bg-indigo-50 border-b border-indigo-100">
                  <p className="text-xs font-bold text-indigo-800 truncate">{module.name}</p>
                </div>

                {/* Sub-component labels */}
                {subComponents.length > 0 && (
                  <div className="px-3 pt-2 pb-1 flex flex-wrap gap-1">
                    {subComponents.map((sc) => (
                      <span
                        key={sc.id}
                        className="px-1.5 py-0.5 bg-gray-100 text-gray-500 text-xs rounded border border-gray-200"
                      >
                        {sc.name}
                      </span>
                    ))}
                  </div>
                )}

                {/* Requirement cards */}
                <div className="px-2 py-2 flex flex-col gap-1.5">
                  {requirements.length === 0 ? (
                    <p className="text-xs text-gray-300 italic px-1">No requirements linked</p>
                  ) : (
                    requirements
                      .sort((a, b) => a.requirement_id.localeCompare(b.requirement_id))
                      .map((req) => {
                        const statusCls = STATUS_CLASSES[req.status] ?? 'bg-gray-100 text-gray-600'
                        return (
                          <div
                            key={req.id}
                            onClick={() => onOpenDetail(req.id)}
                            className="bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 cursor-pointer hover:border-blue-400 hover:shadow-sm transition-all"
                          >
                            <div className="flex items-center justify-between gap-1 mb-0.5">
                              <span className="font-mono text-xs font-semibold text-blue-700 truncate">
                                {req.requirement_id}
                              </span>
                              <span className={`px-1.5 py-0.5 rounded-full text-xs font-medium shrink-0 ${statusCls}`}>
                                {req.status}
                              </span>
                            </div>
                            <p className="text-xs text-gray-600 leading-snug line-clamp-2" title={req.title}>
                              {req.title}
                            </p>
                          </div>
                        )
                      })
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
