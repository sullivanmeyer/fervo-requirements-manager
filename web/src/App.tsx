import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchHierarchy } from './api/hierarchy'
import type { FlatNode, HierarchyNode } from './types'
import HierarchyTree from './components/HierarchyTree'
import SidePanel from './components/SidePanel'
import UserIdentity from './components/UserIdentity'
import RequirementsTable from './pages/RequirementsTable'

export function flattenTree(nodes: HierarchyNode[], depth = 0): FlatNode[] {
  const result: FlatNode[] = []
  for (const node of nodes) {
    result.push({ node, depth })
    result.push(...flattenTree(node.children, depth + 1))
  }
  return result
}

type Tab = 'hierarchy' | 'requirements'

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('hierarchy')
  const [nodes, setNodes] = useState<HierarchyNode[]>([])
  const [selectedNode, setSelectedNode] = useState<HierarchyNode | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [userName, setUserName] = useState<string>(
    () => localStorage.getItem('userName') ?? '',
  )

  // Track selected ID separately so we can re-sync after a refresh
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedNode?.id ?? null

  const loadHierarchy = useCallback(async () => {
    try {
      setError(null)
      const data = await fetchHierarchy()
      setNodes(data)
      // Keep the selected node in sync after mutations
      if (selectedIdRef.current) {
        const flat = flattenTree(data)
        const updated = flat.find((f) => f.node.id === selectedIdRef.current)
        setSelectedNode(updated?.node ?? null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load hierarchy')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHierarchy()
  }, [loadHierarchy])

  const handleUserNameChange = (name: string) => {
    setUserName(name)
    localStorage.setItem('userName', name)
  }

  const flatNodes = flattenTree(nodes)

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-4 shrink-0 shadow-sm">
        <h1 className="text-base font-semibold text-gray-800">
          Requirements Manager
        </h1>
        <div className="w-px h-5 bg-gray-200" />
        {/* Tab navigation */}
        <nav className="flex gap-1">
          <button
            onClick={() => setActiveTab('hierarchy')}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              activeTab === 'hierarchy'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            System Hierarchy
          </button>
          <button
            onClick={() => setActiveTab('requirements')}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              activeTab === 'requirements'
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Requirements
          </button>
        </nav>
        <div className="ml-auto">
          <UserIdentity userName={userName} onChange={handleUserNameChange} />
        </div>
      </header>

      {/* Body */}
      <main className="flex flex-1 overflow-hidden">
        {activeTab === 'hierarchy' ? (
          <>
            {/* Left: system hierarchy tree */}
            <aside className="w-72 bg-white border-r border-gray-200 flex flex-col overflow-hidden shrink-0">
              {loading ? (
                <div className="flex items-center justify-center flex-1 text-gray-400 text-sm">
                  Loading…
                </div>
              ) : error ? (
                <div className="p-4 text-sm">
                  <p className="font-medium text-red-600">
                    Failed to load hierarchy
                  </p>
                  <p className="mt-1 text-xs text-red-500">{error}</p>
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

            {/* Right: detail / side panel */}
            <section className="flex-1 overflow-y-auto p-6">
              <SidePanel
                node={selectedNode}
                flatNodes={flatNodes}
                onRefresh={() => void loadHierarchy()}
                onSelect={setSelectedNode}
              />
            </section>
          </>
        ) : (
          <RequirementsTable
            hierarchyNodes={nodes}
            userName={userName}
          />
        )}
      </main>
    </div>
  )
}
