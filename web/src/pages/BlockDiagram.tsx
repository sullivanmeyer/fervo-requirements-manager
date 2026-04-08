/**
 * BlockDiagram — Nested System Hierarchy Block View
 *
 * Renders the system as a two-level nested block diagram:
 *
 *   ┌─────────────────────────────────────────┐
 *   │  GEOBLOCK PLANT (root node)             │
 *   │  [plant-level requirements as cards]    │
 *   │                                         │
 *   │  ┌───────┐  ┌───────┐  ┌───────┐       │
 *   │  │ Mod A │  │ Mod B │  │ Mod C │       │
 *   │  │ reqs  │  │ reqs  │  │ reqs  │       │
 *   │  └───────┘  └───────┘  └───────┘       │
 *   └─────────────────────────────────────────┘
 *
 * Arrows:
 *   - Root requirement → module block: when a plant-level req has a child
 *     requirement that lives in that module.
 *   - Module → module: when a requirement in module A has a child requirement
 *     in module B.
 *
 * Layout is absolute-positioned inside a scrollable canvas.
 */
import { useEffect, useRef, useState } from 'react'
import { fetchAllLinks, fetchAllRequirements } from '../api/requirements'
import type { HierarchyNode, RequirementLink, RequirementListItem } from '../types'

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const BLOCK_W = 260          // module block width
const BLOCK_H_MIN = 200      // minimum module block height
const COL_GAP = 48           // gap between module columns
const ROW_GAP = 56           // gap between module rows
const COLS = 3               // columns of module blocks

const CANVAS_PAD = 40        // space around the outer container on the canvas
const OUTER_PAD_H = 28       // horizontal padding inside outer container
const OUTER_PAD_B = 28       // bottom padding inside outer container
const ROOT_HEADER_H = 44     // root name bar height
const ROOT_REQS_SECTION_H = 76  // height of the root-req card strip (when non-empty)
const MODULE_AREA_TOP = 16   // gap between root area bottom edge and module blocks

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

function findRoot(nodes: HierarchyNode[]): HierarchyNode | null {
  return nodes.find((n) => n.parent_id === null) ?? null
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface BlockData {
  module: HierarchyNode
  subComponents: HierarchyNode[]
  requirements: RequirementListItem[]
  col: number
  row: number
  x: number   // absolute canvas position
  y: number
  height: number
}

interface Arrow {
  fromModuleId: string | '__root__'
  toModuleId: string
}

interface DiagramData {
  root: HierarchyNode
  rootReqs: RequirementListItem[]
  blocks: BlockData[]
  arrows: Arrow[]
  // Absolute canvas coords of the outer container
  outerX: number
  outerY: number
  outerW: number
  outerH: number
  // Y coordinate of the bottom edge of the root-requirements area
  // (= where root→module arrows originate)
  rootAreaBottomY: number
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

  useEffect(() => { void load() }, []) // eslint-disable-line

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

    // Which module does each hierarchy node belong to?
    const moduleSubtrees = new Map<string, Set<string>>()
    for (const mod of modules) moduleSubtrees.set(mod.id, subtreeIds(mod))

    const nodeToModule = new Map<string, string>()
    for (const [moduleId, ids] of moduleSubtrees) {
      for (const id of ids) nodeToModule.set(id, moduleId)
    }

    // Requirements on the root node itself (plant-level)
    const rootReqs = allRequirements.filter((req) =>
      req.hierarchy_nodes.some((hn) => hn.id === root.id)
    )
    const rootReqIds = new Set(rootReqs.map((r) => r.id))

    // Map each req → set of modules it belongs to
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

    // Group module requirements by module
    const blockReqs = new Map<string, RequirementListItem[]>()
    for (const mod of modules) blockReqs.set(mod.id, [])
    for (const req of allRequirements) {
      if (rootReqIds.has(req.id)) continue   // root reqs shown separately
      const modIds = reqToModules.get(req.id)
      if (modIds) {
        for (const modId of modIds) {
          if (blockReqs.has(modId)) blockReqs.get(modId)!.push(req)
        }
      }
    }

    // Arrows
    const arrowSet = new Set<string>()
    const arrows: Arrow[] = []

    // Root req → module: when root req has a child in module M
    for (const link of allLinks) {
      if (rootReqIds.has(link.parent_requirement_id)) {
        const toMods = reqToModules.get(link.child_requirement_id) ?? new Set<string>()
        for (const toMod of toMods) {
          const key = `__root__→${toMod}`
          if (!arrowSet.has(key)) {
            arrowSet.add(key)
            arrows.push({ fromModuleId: '__root__', toModuleId: toMod })
          }
        }
      }
    }

    // Module → module
    for (const link of allLinks) {
      if (rootReqIds.has(link.parent_requirement_id)) continue
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

    // ---- Layout ----

    // Outer container horizontal size
    const gridW = COLS * BLOCK_W + (COLS - 1) * COL_GAP
    const outerW = 2 * OUTER_PAD_H + gridW

    // Root area height: header bar + optional req strip
    const rootAreaH = ROOT_HEADER_H + (rootReqs.length > 0 ? ROOT_REQS_SECTION_H : 0)

    // Module blocks Y offset from top of outer container
    const moduleOffsetY = rootAreaH + MODULE_AREA_TOP

    // Outer container position on canvas
    const outerX = CANVAS_PAD
    const outerY = CANVAS_PAD

    // Module block layout
    const numRows = Math.ceil(modules.length / COLS)
    const rowMaxHeights: number[] = Array(numRows).fill(BLOCK_H_MIN)

    const blocks: BlockData[] = modules.map((mod, i) => {
      const col = i % COLS
      const row = Math.floor(i / COLS)
      const height = blockHeights.get(mod.id) ?? BLOCK_H_MIN
      if (height > rowMaxHeights[row]) rowMaxHeights[row] = height
      return {
        module: mod,
        subComponents: mod.children.filter((c) => !c.archived),
        requirements: blockReqs.get(mod.id) ?? [],
        col,
        row,
        x: 0, // will be set below
        y: 0,
        height,
      }
    })

    // Recompute per-row y offsets using measured heights
    let currentRowY = moduleOffsetY
    const rowStartY: number[] = []
    for (let r = 0; r < numRows; r++) {
      rowStartY.push(currentRowY)
      currentRowY += rowMaxHeights[r] + ROW_GAP
    }

    for (const b of blocks) {
      b.x = outerX + OUTER_PAD_H + b.col * (BLOCK_W + COL_GAP)
      b.y = outerY + rowStartY[b.row]
    }

    // Outer container height: top of last row + max height of last row + bottom padding
    const lastRowMaxH = rowMaxHeights[numRows - 1] ?? BLOCK_H_MIN
    const outerH =
      moduleOffsetY +
      rowStartY[numRows - 1] - moduleOffsetY +
      lastRowMaxH +
      OUTER_PAD_B

    const canvasW = CANVAS_PAD * 2 + outerW
    const canvasH = CANVAS_PAD * 2 + outerH

    // Y where root→module arrows originate (bottom of root area)
    const rootAreaBottomY = outerY + rootAreaH + MODULE_AREA_TOP / 2

    return {
      root,
      rootReqs,
      blocks,
      arrows,
      outerX,
      outerY,
      outerW,
      outerH,
      rootAreaBottomY,
      canvasW,
      canvasH,
    }
  })()

  // -------------------------------------------------------------------------
  // Arrow paths
  // -------------------------------------------------------------------------

  function arrowPath(
    from: BlockData | null,
    to: BlockData,
    fromRootY?: number,
  ): string {
    if (!from && fromRootY !== undefined) {
      // Root → module: straight down from root area bottom to module top
      const x1 = to.x + BLOCK_W / 2
      const y1 = fromRootY
      const x2 = to.x + BLOCK_W / 2
      const y2 = to.y
      const midY = (y1 + y2) / 2
      return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
    }

    if (!from) return ''

    const fromCX = from.x + BLOCK_W / 2
    const fromCY = from.y + from.height / 2
    const toCX = to.x + BLOCK_W / 2
    const toCY = to.y + to.height / 2

    if (from.row === to.row) {
      const [x1, y1, x2, y2] =
        from.col < to.col
          ? [from.x + BLOCK_W, fromCY, to.x, toCY]
          : [from.x, fromCY, to.x + BLOCK_W, toCY]
      const midX = (x1 + x2) / 2
      return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
    } else if (from.row < to.row) {
      const x1 = fromCX, y1 = from.y + from.height
      const x2 = toCX, y2 = to.y
      const midY = (y1 + y2) / 2
      return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
    } else {
      const x1 = fromCX, y1 = from.y
      const x2 = toCX, y2 = to.y + to.height
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
        <button onClick={() => void load()} className="text-xs text-blue-600 underline">Retry</button>
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

  const {
    root, rootReqs, blocks, arrows,
    outerX, outerY, outerW, outerH,
    rootAreaBottomY, canvasW, canvasH,
  } = diagram
  const blockById = new Map(blocks.map((b) => [b.module.id, b]))

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Refresh hint */}
      <div className="px-3 py-1.5 bg-white border-b border-gray-200 shrink-0 flex items-center justify-between">
        <p className="text-xs text-gray-400">
          System block diagram — each module is a child of <span className="font-medium text-gray-600">{root.name}</span>. Arrows show requirement derivation across levels.
        </p>
        <button
          onClick={() => void load()}
          className="text-xs text-gray-400 hover:text-gray-600 underline shrink-0 ml-4"
        >
          Refresh
        </button>
      </div>

      {/* Scrollable canvas */}
      <div className="flex-1 overflow-auto bg-gray-100">
        <div className="relative" style={{ width: canvasW, height: canvasH, minWidth: '100%' }}>

          {/* SVG layer for arrows — drawn over everything */}
          <svg
            className="absolute inset-0 pointer-events-none"
            width={canvasW}
            height={canvasH}
            style={{ zIndex: 20 }}
          >
            <defs>
              <marker id="block-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#6366f1" />
              </marker>
              <marker id="root-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#0ea5e9" />
              </marker>
            </defs>

            {arrows.map(({ fromModuleId, toModuleId }) => {
              const to = blockById.get(toModuleId)
              if (!to) return null

              if (fromModuleId === '__root__') {
                return (
                  <path
                    key={`root→${toModuleId}`}
                    d={arrowPath(null, to, rootAreaBottomY)}
                    fill="none"
                    stroke="#0ea5e9"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    markerEnd="url(#root-arrow)"
                  />
                )
              }

              const from = blockById.get(fromModuleId)
              if (!from) return null
              return (
                <path
                  key={`${fromModuleId}→${toModuleId}`}
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

          {/* ---- Outer container: the root node ---- */}
          <div
            style={{
              position: 'absolute',
              left: outerX,
              top: outerY,
              width: outerW,
              height: outerH,
              zIndex: 1,
            }}
            className="rounded-2xl border-2 border-indigo-300 bg-indigo-50/40"
          >
            {/* Root name bar */}
            <div className="px-4 flex items-center gap-2 border-b border-indigo-200 bg-indigo-100/60 rounded-t-2xl"
                 style={{ height: ROOT_HEADER_H }}>
              <div className="w-2.5 h-2.5 rounded-sm bg-indigo-500 shrink-0" />
              <span className="text-sm font-bold text-indigo-900 tracking-wide">
                {root.name}
              </span>
              {rootReqs.length > 0 && (
                <span className="ml-2 text-xs text-indigo-500">
                  {rootReqs.length} plant-level requirement{rootReqs.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Root-level requirement strip */}
            {rootReqs.length > 0 && (
              <div
                className="px-3 flex items-center gap-2 overflow-x-auto"
                style={{ height: ROOT_REQS_SECTION_H }}
              >
                {rootReqs
                  .sort((a, b) => a.requirement_id.localeCompare(b.requirement_id))
                  .map((req) => {
                    const statusCls = STATUS_CLASSES[req.status] ?? 'bg-gray-100 text-gray-600'
                    return (
                      <div
                        key={req.id}
                        onClick={() => onOpenDetail(req.id)}
                        className="shrink-0 bg-white border border-sky-200 rounded-lg px-2 py-1.5 cursor-pointer hover:border-sky-400 hover:shadow-sm transition-all"
                        style={{ width: 200 }}
                      >
                        <div className="flex items-center justify-between gap-1 mb-0.5">
                          <span className="font-mono text-xs font-semibold text-sky-700 truncate">
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
                  })}
              </div>
            )}
          </div>

          {/* ---- Module blocks ---- */}
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

                {/* Sub-component chips */}
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
