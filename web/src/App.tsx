import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchHierarchy } from './api/hierarchy'
import type { FlatNode, HierarchyNode } from './types'
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
  | { page: 'requirements' }
  | { page: 'requirement-detail'; requirementId: string | null; initialParentIds?: string[]; initialStatement?: string; initialSourceDocumentId?: string; backFrom?: 'document-detail'; backDocumentId?: string }
  | { page: 'derivation-tree'; focusId: string | null }
  | { page: 'documents' }
  | { page: 'document-detail'; documentId: string | null }
  | { page: 'document-network'; focusDocumentId?: string | null }

export default function App() {
  const [view, setView] = useState<AppView>({ page: 'hierarchy' })

  const [nodes, setNodes] = useState<HierarchyNode[]>([])
  const [selectedNode, setSelectedNode] = useState<HierarchyNode | null>(null)
  const [hierarchyLoading, setHierarchyLoading] = useState(true)
  const [hierarchyError, setHierarchyError] = useState<string | null>(null)

  const [userName, setUserName] = useState<string>(
    () => localStorage.getItem('userName') ?? '',
  )

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
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                if (tab.id === 'hierarchy') setView({ page: 'hierarchy' })
                else if (tab.id === 'requirements') setView({ page: 'requirements' })
                else if (tab.id === 'documents') setView({ page: 'documents' })
                else if (tab.id === 'document-network') setView({ page: 'document-network' })
                else setView({ page: 'derivation-tree', focusId: null })
              }}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                activeTab === tab.id
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

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
              />
            </section>

            {/* Right: node detail / edit panel — slides in when a node is selected */}
            {selectedNode && (
              <aside className="w-72 bg-white border-l border-gray-200 flex flex-col overflow-hidden shrink-0">
                <SidePanel
                  node={selectedNode}
                  flatNodes={flatNodes}
                  onRefresh={() => void loadHierarchy()}
                  onSelect={setSelectedNode}
                />
              </aside>
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
              backLabel={view.backFrom === 'document-detail' ? 'Document' : 'Requirements'}
              onSaved={(savedId) => {
                setView({ page: 'requirement-detail', requirementId: savedId })
              }}
              onCancel={() =>
                view.backFrom === 'document-detail' && view.backDocumentId
                  ? setView({ page: 'document-detail', documentId: view.backDocumentId })
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
              onOpenDocument={(docId) =>
                setView({ page: 'document-detail', documentId: docId })
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

      </main>
    </div>
  )
}
