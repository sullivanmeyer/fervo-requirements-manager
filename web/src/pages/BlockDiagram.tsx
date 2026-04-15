/**
 * BlockDiagram — Navigable System Block Diagram
 *
 * Drill-down block view of the system hierarchy. Shows one level at a time:
 *   - The current node as a styled header (with its direct Performance Requirements)
 *   - Its direct children as a responsive card grid (each with sub-component tags
 *     and their own Performance Requirements)
 *   - A breadcrumb trail and Back button for navigation
 *
 * Only Performance Requirements (classification_subtype = 'Performance Requirement')
 * are shown. All other classification types are hidden to keep density manageable.
 * Users who need all requirement types can click "View all requirements" to open
 * the requirements table pre-filtered to that node.
 *
 * Data comes from two new API endpoints:
 *   GET /api/hierarchy/{id}/block-view  — single-level payload
 *   GET /api/hierarchy/{id}/ancestors   — breadcrumb chain
 */
import { useEffect, useState } from 'react'
import { fetchAncestors, fetchBlockView } from '../api/hierarchy'
import type { AncestorNode, BlockView, HierarchyNode } from '../types'

const STATUS_CLASSES: Record<string, string> = {
  Draft: 'bg-gray-100 text-gray-600',
  'Under Review': 'bg-yellow-100 text-yellow-800',
  Approved: 'bg-green-100 text-green-800',
  Superseded: 'bg-orange-100 text-orange-800',
  Withdrawn: 'bg-red-100 text-red-800',
}

interface Props {
  hierarchyNodes: HierarchyNode[]
  onOpenDetail: (id: string) => void
  onViewAllRequirements: (nodeId: string) => void
  onSelectNode?: (nodeId: string) => void
}

export default function BlockDiagram({ hierarchyNodes, onOpenDetail, onViewAllRequirements, onSelectNode }: Props) {
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null)
  const [blockView, setBlockView] = useState<BlockView | null>(null)
  const [ancestors, setAncestors] = useState<AncestorNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Incrementing this forces a re-fetch without changing currentNodeId
  const [refreshKey, setRefreshKey] = useState(0)

  // Set initial node to root when hierarchy tree loads
  useEffect(() => {
    if (hierarchyNodes.length > 0 && !currentNodeId) {
      const root = hierarchyNodes.find((n) => n.parent_id === null)
      if (root) setCurrentNodeId(root.id)
    }
  }, [hierarchyNodes, currentNodeId])

  // Fetch block-view + ancestors whenever the current node or refreshKey changes
  useEffect(() => {
    if (!currentNodeId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([fetchBlockView(currentNodeId), fetchAncestors(currentNodeId)])
      .then(([view, ancs]) => {
        if (!cancelled) {
          setBlockView(view)
          setAncestors(ancs)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load diagram')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentNodeId, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const navigateTo = (nodeId: string) => {
    setBlockView(null)
    setCurrentNodeId(nodeId)
  }

  const navigateBack = () => {
    if (ancestors.length >= 2) navigateTo(ancestors[ancestors.length - 2].id)
  }

  // ---- Loading / error / empty states ----

  if (!currentNodeId || (loading && !blockView)) {
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
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          className="text-xs text-blue-600 underline"
        >
          Retry
        </button>
      </div>
    )
  }

  if (!blockView) return null

  const isRoot = ancestors.length <= 1
  const isLeaf = blockView.children.length === 0

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ---- Toolbar: breadcrumb + back + refresh ---- */}
      <div className="px-3 py-2 bg-white border-b border-gray-200 shrink-0 flex items-center gap-2 flex-wrap min-h-[40px]">

        {/* Back button */}
        {!isRoot && (
          <button
            onClick={navigateBack}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 shrink-0 mr-1"
          >
            ← Back
          </button>
        )}

        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 text-xs flex-wrap min-w-0">
          {ancestors.map((anc, i) => (
            <span key={anc.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300 select-none">›</span>}
              {i < ancestors.length - 1 ? (
                <button
                  onClick={() => navigateTo(anc.id)}
                  className="text-blue-600 hover:underline"
                >
                  {anc.name}
                </button>
              ) : (
                <span className="font-semibold text-gray-700">{anc.name}</span>
              )}
            </span>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3 shrink-0">
          <span className="text-xs text-gray-400 hidden sm:inline">Performance Requirements only</span>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* ---- Main scrollable area ---- */}
      <div className="flex-1 overflow-auto bg-gray-50 p-5">

        {/* Parent node header card */}
        <div className="mb-5 rounded-xl border-2 border-indigo-200 bg-indigo-50/60 overflow-hidden">
          <div
            className="px-4 py-3 bg-indigo-100/80 flex items-center justify-between gap-3 flex-wrap cursor-pointer hover:bg-indigo-200/80 transition-colors"
            onClick={() => onSelectNode?.(blockView.node.id)}
            title="Click to open node details"
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-2.5 h-2.5 rounded-sm bg-indigo-500 shrink-0" />
              <span className="text-sm font-bold text-indigo-900">{blockView.node.name}</span>
              {blockView.node.description && (
                <span className="text-xs text-indigo-500 truncate hidden md:inline">
                  {blockView.node.description}
                </span>
              )}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onViewAllRequirements(blockView.node.id) }}
              className="text-xs text-indigo-600 hover:text-indigo-800 underline shrink-0"
              title="Open requirements table filtered to this node (all types, with descendants)"
            >
              View all requirements →
            </button>
          </div>

          {/* Parent's Performance Requirements */}
          {blockView.performance_requirements.length > 0 ? (
            <div className="px-4 py-3 flex flex-wrap gap-2">
              {blockView.performance_requirements.map((req) => {
                const statusCls = STATUS_CLASSES[req.status] ?? 'bg-gray-100 text-gray-600'
                return (
                  <div
                    key={req.id}
                    onClick={() => onOpenDetail(req.id)}
                    className="bg-white border border-sky-200 rounded-lg px-2.5 py-1.5 cursor-pointer hover:border-sky-400 hover:shadow-sm transition-all"
                    style={{ maxWidth: 240 }}
                  >
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span className="font-mono text-xs font-semibold text-sky-700 truncate">
                        {req.requirement_id}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded-full text-xs font-medium shrink-0 ${statusCls}`}>
                        {req.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 leading-snug line-clamp-2">{req.title}</p>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="px-4 py-2">
              <p className="text-xs text-indigo-400 italic">No performance requirements at this level</p>
            </div>
          )}
        </div>

        {/* Leaf node: no children */}
        {isLeaf && (
          <div className="text-center py-10 text-gray-400">
            <p className="text-sm font-medium text-gray-500 mb-1">
              This is a leaf component — no sub-systems to display
            </p>
            {!isRoot && (
              <button
                onClick={navigateBack}
                className="text-xs text-blue-600 underline mt-1"
              >
                ← Back to parent
              </button>
            )}
          </div>
        )}

        {/* Child cards — responsive auto-fill grid */}
        {!isLeaf && (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
          >
            {blockView.children.map((child) => (
              <div
                key={child.id}
                className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden flex flex-col"
              >
                {/* Card header — clicking the background selects the node for the detail panel */}
                <div
                  className="px-3 py-2.5 bg-indigo-50 border-b border-indigo-100 flex items-center justify-between gap-2 cursor-pointer hover:bg-indigo-100/70 transition-colors"
                  onClick={() => onSelectNode?.(child.id)}
                  title="Click to open node details"
                >
                  <div className="min-w-0 flex-1">
                    {child.has_children ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); navigateTo(child.id) }}
                        className="text-xs font-bold text-indigo-800 hover:text-indigo-600 hover:underline truncate text-left w-full block"
                        title="Drill into this sub-system"
                      >
                        {child.name} ›
                      </button>
                    ) : (
                      <span className="text-xs font-bold text-indigo-800 truncate block">
                        {child.name}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); onViewAllRequirements(child.id) }}
                    className="text-xs text-indigo-400 hover:text-indigo-700 shrink-0 ml-1"
                    title="View all requirements for this node"
                  >
                    All req's →
                  </button>
                </div>

                {/* Sub-component tags (grandchildren) */}
                {child.children_preview.length > 0 && (
                  <div className="px-3 pt-2 pb-1 flex flex-wrap gap-1">
                    {child.children_preview.map((name) => (
                      <span
                        key={name}
                        className="px-1.5 py-0.5 bg-gray-100 text-gray-500 text-xs rounded border border-gray-200"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                )}

                {/* Performance Requirement cards */}
                <div className="px-2 py-2 flex flex-col gap-1.5 flex-1">
                  {child.performance_requirements.length === 0 ? (
                    <p className="text-xs text-gray-300 italic px-1">No performance requirements</p>
                  ) : (
                    child.performance_requirements.map((req) => {
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
                          <p className="text-xs text-gray-600 leading-snug line-clamp-2">{req.title}</p>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
