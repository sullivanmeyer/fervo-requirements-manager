import React, { useCallback, useEffect, useRef, useState } from 'react'
import { fetchHierarchy } from './api/hierarchy'
import { globalSearch } from './api/search'
import type { FlatNode, HierarchyNode, SearchResults } from './types'
import HierarchyTree from './components/HierarchyTree'
import SidePanel from './components/SidePanel'
import UserIdentity from './components/UserIdentity'
import RequirementsTable from './pages/RequirementsTable'
import RequirementDetail from './pages/RequirementDetail'
import DerivationTree from './pages/DerivationTree'
import BlockDiagram from './pages/BlockDiagram'
import SourceDocumentRegistry from './pages/SourceDocumentRegistry'
import SourceDocumentDetail from './pages/SourceDocumentDetail'
import DocumentNetwork from './pages/DocumentNetwork'
import OrphanReport from './pages/OrphanReport'

export function flattenTree(nodes: HierarchyNode[], depth = 0): FlatNode[] {
  const result: FlatNode[] = []
  for (const node of nodes) {
    result.push({ node, depth })
    result.push(...flattenTree(node.children, depth + 1))
  }
  return result
}

// ---------------------------------------------------------------------------
// Navigation state
// ---------------------------------------------------------------------------

type AppView =
  | { page: 'hierarchy' }
  | { page: 'requirements'; initialHierarchyNodeId?: string }
  | { page: 'requirement-detail'; requirementId: string | null; initialParentIds?: string[]; initialStatement?: string; initialSourceDocumentId?: string; backFrom?: 'document-detail' | 'orphan-report'; backDocumentId?: string }
  | { page: 'derivation-tree'; focusId: string | null }
  | { page: 'documents' }
  | { page: 'document-detail'; documentId: string | null; highlightBlockIds?: string[] }
  | { page: 'document-network'; focusDocumentId?: string | null }
  | { page: 'orphan-report' }

// ---------------------------------------------------------------------------
// Hash-based URL routing
// ---------------------------------------------------------------------------

function viewToHash(view: AppView): string {
  switch (view.page) {
    case 'hierarchy':        return '#/hierarchy'
    case 'requirements':     return '#/requirements'
    case 'documents':        return '#/documents'
    case 'document-network': return '#/document-network'
    case 'derivation-tree':  return '#/derivation-tree'
    case 'orphan-report':    return '#/orphan-report'
    case 'requirement-detail':
      return view.requirementId ? `#/requirement/${view.requirementId}` : '#/requirement/new'
    case 'document-detail':
      return view.documentId ? `#/document/${view.documentId}` : '#/document/new'
  }
}

function hashToView(hash: string): AppView {
  const path = hash.replace(/^#\//, '')
  const [seg0, seg1] = path.split('/')

  if (seg0 === 'requirement') {
    const id = seg1 && seg1 !== 'new' ? seg1 : null
    return { page: 'requirement-detail', requirementId: id }
  }
  if (seg0 === 'document') {
    const id = seg1 && seg1 !== 'new' ? seg1 : null
    return { page: 'document-detail', documentId: id }
  }
  switch (seg0) {
    case 'requirements':     return { page: 'requirements' }
    case 'documents':        return { page: 'documents' }
    case 'document-network': return { page: 'document-network' }
    case 'derivation-tree':  return { page: 'derivation-tree', focusId: null }
    case 'orphan-report':    return { page: 'orphan-report' }
    default:                 return { page: 'hierarchy' }
  }
}

// ---------------------------------------------------------------------------
// Global search bar
// ---------------------------------------------------------------------------

function SearchBar({ onOpenRequirement, onOpenDocument }: {
  onOpenRequirement: (id: string) => void
  onOpenDocument: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (query.length < 3) {
      setResults(null)
      setOpen(false)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const r = await globalSearch(query)
        setResults(r)
        setOpen(true)
      } catch {
        // silently ignore
      } finally {
        setLoading(false)
      }
    }, 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const totalResults = (results?.requirements.length ?? 0) + (results?.source_documents.length ?? 0)

  return (
    <div ref={containerRef} className="relative w-64">
      <div className="relative">
        <svg
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { if (results && totalResults > 0) setOpen(true) }}
          placeholder="Search requirements & docs…"
          className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
        />
        {loading && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">…</span>
        )}
      </div>

      {open && results && (
        <div className="absolute top-full mt-1 left-0 w-96 bg-white border border-gray-200 rounded shadow-xl z-50 max-h-96 overflow-y-auto">
          {totalResults === 0 ? (
            <p className="px-4 py-3 text-xs text-gray-400">No results for "{query}"</p>
          ) : (
            <>
              {results.requirements.length > 0 && (
                <div>
                  <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 bg-gray-50">
                    Requirements ({results.requirements.length})
                  </p>
                  {results.requirements.map((r) => (
                    <button
                      key={r.id}
                      className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-start gap-2 border-b border-gray-50"
                      onClick={() => {
                        setOpen(false)
                        setQuery('')
                        onOpenRequirement(r.id)
                      }}
                    >
                      <span className="font-mono text-xs text-blue-600 shrink-0 pt-0.5">{r.requirement_id}</span>
                      <span className="text-xs text-gray-800 leading-tight line-clamp-2">{r.title}</span>
                      <span className="ml-auto text-[10px] text-gray-400 shrink-0 pt-0.5">{r.discipline}</span>
                    </button>
                  ))}
                </div>
              )}
              {results.source_documents.length > 0 && (
                <div>
                  <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider border-b border-gray-100 bg-gray-50">
                    Source Documents ({results.source_documents.length})
                  </p>
                  {results.source_documents.map((d) => (
                    <button
                      key={d.id}
                      className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-start gap-2"
                      onClick={() => {
                        setOpen(false)
                        setQuery('')
                        onOpenDocument(d.id)
                      }}
                    >
                      <span className="font-mono text-xs text-indigo-600 shrink-0 pt-0.5">{d.document_id}</span>
                      <span className="text-xs text-gray-800 leading-tight line-clamp-2">{d.title}</span>
                      <span className="ml-auto text-[10px] text-gray-400 shrink-0 pt-0.5">{d.document_type}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [view, setView] = useState<AppView>(() => hashToView(window.location.hash))

  const [nodes, setNodes] = useState<HierarchyNode[]>([])
  const [selectedNode, setSelectedNode] = useState<HierarchyNode | null>(null)
  const [hierarchyLoading, setHierarchyLoading] = useState(true)
  const [hierarchyError, setHierarchyError] = useState<string | null>(null)

  const [userName, setUserName] = useState<string>(
    () => localStorage.getItem('userName') ?? '',
  )

  // Right detail panel width — user-draggable
  const [detailWidth, setDetailWidth] = useState(288)

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = detailWidth
    const onMove = (me: MouseEvent) => {
      const newW = Math.max(240, Math.min(600, startW + startX - me.clientX))
      setDetailWidth(newW)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedNode?.id ?? null

  const loadHierarchy = useCallback(async () => {
    try {
      setHierarchyError(null)
      const data = await fetchHierarchy()
      setNodes(data)
      if (selectedIdRef.current) {
        const flat = flattenTree(data)
        const updated = flat.find((f) => f.node.id === selectedIdRef.current)
        setSelectedNode(updated?.node ?? null)
      }
    } catch (e) {
      setHierarchyError(e instanceof Error ? e.message : 'Failed to load hierarchy')
    } finally {
      setHierarchyLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHierarchy()
  }, [loadHierarchy])

  // Sync view → URL hash whenever view changes
  useEffect(() => {
    window.location.hash = viewToHash(view)
  }, [view])

  // Sync browser Back/Forward → view state
  useEffect(() => {
    const handler = () => setView(hashToView(window.location.hash))
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  // Ctrl+N — create a new requirement from anywhere in the app
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault()
        setView({ page: 'requirement-detail', requirementId: null })
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const handleUserNameChange = (name: string) => {
    setUserName(name)
    localStorage.setItem('userName', name)
  }

  const flatNodes = flattenTree(nodes)

  const activeTab =
    view.page === 'hierarchy'
      ? 'hierarchy'
      : view.page === 'derivation-tree'
        ? 'derivation-tree'
        : view.page === 'documents' || view.page === 'document-detail'
          ? 'documents'
          : view.page === 'document-network'
            ? 'document-network'
            : view.page === 'orphan-report'
              ? 'orphan-report'
              : 'requirements'

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-4 shrink-0 shadow-sm">
        <h1 className="text-base font-semibold text-gray-800">
          Requirements Manager
        </h1>
        <div className="w-px h-5 bg-gray-200" />

        <nav className="flex gap-1">
          {(
            [
              { id: 'hierarchy', label: 'System Hierarchy' },
              { id: 'requirements', label: 'Requirements' },
              { id: 'documents', label: 'Documents' },
              { id: 'document-network', label: 'Doc Network' },
              { id: 'derivation-tree', label: 'Derivation Tree' },
              { id: 'orphan-report', label: 'Orphan Report' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                if (tab.id === 'hierarchy') setView({ page: 'hierarchy' })
                else if (tab.id === 'requirements') setView({ page: 'requirements' })
                else if (tab.id === 'documents') setView({ page: 'documents' })
                else if (tab.id === 'document-network') setView({ page: 'document-network' })
                else if (tab.id === 'orphan-report') setView({ page: 'orphan-report' })
                else setView({ page: 'derivation-tree', focusId: null })
              }}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                activeTab === tab.id
                  ? tab.id === 'orphan-report'
                    ? 'bg-amber-500 text-white'
                    : 'bg-blue-600 text-white'
                  : tab.id === 'orphan-report'
                    ? 'text-amber-700 hover:bg-amber-50'
                    : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Global search */}
        <SearchBar
          onOpenRequirement={(id) => setView({ page: 'requirement-detail', requirementId: id })}
          onOpenDocument={(id) => setView({ page: 'document-detail', documentId: id })}
        />

        <div className="ml-auto">
          <UserIdentity userName={userName} onChange={handleUserNameChange} />
        </div>
      </header>

      {/* Body */}
      <main className="flex flex-1 overflow-hidden">

        {/* ------------------------------------------------------------------ */}
        {/* Hierarchy tab                                                        */}
        {/* ------------------------------------------------------------------ */}
        {view.page === 'hierarchy' && (
          <>
            {/* Left: tree navigator */}
            <aside className="w-64 bg-white border-r border-gray-200 flex flex-col overflow-hidden shrink-0">
              {hierarchyLoading ? (
                <div className="flex items-center justify-center flex-1 text-gray-400 text-sm">
                  Loading…
                </div>
              ) : hierarchyError ? (
                <div className="p-4 text-sm">
                  <p className="font-medium text-red-600">Failed to load hierarchy</p>
                  <p className="mt-1 text-xs text-red-500">{hierarchyError}</p>
                  <button
                    onClick={() => void loadHierarchy()}
                    className="mt-2 text-xs text-blue-600 underline"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <HierarchyTree
                  nodes={nodes}
                  selectedId={selectedNode?.id ?? null}
                  onSelect={setSelectedNode}
                  onRefresh={() => void loadHierarchy()}
                />
              )}
            </aside>

            {/* Centre: block diagram — always visible */}
            <section className="flex-1 overflow-hidden flex flex-col min-w-0">
              <BlockDiagram
                hierarchyNodes={nodes}
                onOpenDetail={(id) =>
                  setView({ page: 'requirement-detail', requirementId: id })
                }
                onViewAllRequirements={(nodeId) =>
                  setView({ page: 'requirements', initialHierarchyNodeId: nodeId })
                }
                onSelectNode={(nodeId) => {
                  const found = flatNodes.find((f) => f.node.id === nodeId)?.node
                  if (found) setSelectedNode(found)
                }}
              />
            </section>

            {/* Right: node detail / edit panel — slides in when a node is selected */}
            {selectedNode && (
              <>
                {/* Drag-resize handle — the thin bar the user grabs */}
                <div
                  className="w-1 shrink-0 bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors cursor-col-resize"
                  onMouseDown={handleResizeStart}
                />
                <aside
                  className="bg-white border-l border-gray-200 flex flex-col overflow-hidden shrink-0 overflow-y-auto p-4"
                  style={{ width: detailWidth }}
                >
                  <SidePanel
                    node={selectedNode}
                    flatNodes={flatNodes}
                    onRefresh={() => void loadHierarchy()}
                    onSelect={setSelectedNode}
                  />
                </aside>
              </>
            )}
          </>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Requirements table                                                   */}
        {/* ------------------------------------------------------------------ */}
        {view.page === 'requirements' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <RequirementsTable
              hierarchyNodes={nodes}
              userName={userName}
              initialHierarchyNodeId={view.page === 'requirements' ? view.initialHierarchyNodeId : undefined}
              onOpenDetail={(id) =>
                setView({ page: 'requirement-detail', requirementId: id })
              }
              onCreateNew={() =>
                setView({ page: 'requirement-detail', requirementId: null })
              }
            />
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Requirement detail / create                                          */}
        {/* ------------------------------------------------------------------ */}
        {view.page === 'requirement-detail' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <RequirementDetail
              key={
                view.requirementId
                  ?? `new-${(view.initialParentIds ?? []).join('-')}-${view.initialSourceDocumentId ?? ''}`
              }
              requirementId={view.requirementId}
              hierarchyNodes={nodes}
              userName={userName}
              initialParentIds={view.initialParentIds}
              initialStatement={view.initialStatement}
              initialSourceDocumentId={view.initialSourceDocumentId}
              backLabel={
                view.backFrom === 'document-detail' ? 'Document'
                : view.backFrom === 'orphan-report' ? 'Orphan Report'
                : 'Requirements'
              }
              onSaved={(savedId) => {
                setView({ page: 'requirement-detail', requirementId: savedId })
              }}
              onCancel={() =>
                view.backFrom === 'document-detail' && view.backDocumentId
                  ? setView({ page: 'document-detail', documentId: view.backDocumentId })
                  : view.backFrom === 'orphan-report'
                    ? setView({ page: 'orphan-report' })
                    : setView({ page: 'requirements' })
              }
              onViewInTree={(id) =>
                setView({ page: 'derivation-tree', focusId: id })
              }
              onAddChild={(parentId) =>
                setView({
                  page: 'requirement-detail',
                  requirementId: null,
                  initialParentIds: [parentId],
                })
              }
              onOpenDocument={(docId, blockIds) =>
                setView({ page: 'document-detail', documentId: docId, highlightBlockIds: blockIds })
              }
              onCreateChildForGap={(parentId, hierarchyNodeId) =>
                setView({
                  page: 'requirement-detail',
                  requirementId: null,
                  initialParentIds: [parentId],
                })
              }
            />
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Derivation tree                                                      */}
        {/* ------------------------------------------------------------------ */}
        {view.page === 'derivation-tree' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <DerivationTree
              focusId={view.focusId}
              onSelect={(id) =>
                setView({ page: 'requirement-detail', requirementId: id })
              }
            />
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Document network graph                                               */}
        {/* ------------------------------------------------------------------ */}
        {view.page === 'document-network' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <DocumentNetwork
              focusDocumentId={view.focusDocumentId ?? null}
              onOpenDocument={(docId) =>
                setView({ page: 'document-detail', documentId: docId })
              }
            />
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Source document registry                                             */}
        {/* ------------------------------------------------------------------ */}
        {view.page === 'documents' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <SourceDocumentRegistry
              onOpenDetail={(id) =>
                setView({ page: 'document-detail', documentId: id })
              }
              onCreateNew={() =>
                setView({ page: 'document-detail', documentId: null })
              }
            />
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Source document detail / create                                      */}
        {/* ------------------------------------------------------------------ */}
        {view.page === 'document-detail' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <SourceDocumentDetail
              key={view.documentId ?? 'new-document'}
              documentId={view.documentId}
              initialHighlightBlockIds={view.highlightBlockIds}
              onSaved={(savedId) =>
                setView({ page: 'document-detail', documentId: savedId })
              }
              onCancel={() => setView({ page: 'documents' })}
              onCreateRequirement={(sourceDocumentId, initialStatement) =>
                setView({
                  page: 'requirement-detail',
                  requirementId: null,
                  initialStatement,
                  initialSourceDocumentId: sourceDocumentId,
                  backFrom: 'document-detail',
                  backDocumentId: view.documentId ?? undefined,
                })
              }
              onOpenRequirement={(id) =>
                setView({
                  page: 'requirement-detail',
                  requirementId: id,
                  backFrom: 'document-detail',
                  backDocumentId: view.documentId ?? undefined,
                })
              }
              onViewInNetwork={(docId) =>
                setView({ page: 'document-network', focusDocumentId: docId })
              }
              userName={userName}
            />
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Orphan report                                                        */}
        {/* ------------------------------------------------------------------ */}
        {view.page === 'orphan-report' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <OrphanReport
              onOpenRequirement={(id) =>
                setView({
                  page: 'requirement-detail',
                  requirementId: id,
                  backFrom: 'orphan-report',
                })
              }
            />
          </div>
        )}

      </main>
    </div>
  )
}
