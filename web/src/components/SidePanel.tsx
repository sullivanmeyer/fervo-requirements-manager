import { useEffect, useState } from 'react'
import { archiveNode, updateNode } from '../api/hierarchy'
import type { FlatNode, HierarchyNode } from '../types'
import AddNodeModal from './AddNodeModal'

interface Props {
  node: HierarchyNode | null
  flatNodes: FlatNode[]
  onRefresh: () => void
  onSelect: (node: HierarchyNode | null) => void
}

function getDescendantIds(node: HierarchyNode): Set<string> {
  const ids = new Set<string>()
  const walk = (n: HierarchyNode) => {
    for (const child of n.children) {
      ids.add(child.id)
      walk(child)
    }
  }
  walk(node)
  return ids
}

export default function SidePanel({ node, flatNodes, onRefresh, onSelect }: Props) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [moveToId, setMoveToId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)
  const [showAddChildModal, setShowAddChildModal] = useState(false)

  // Reset all local state when selected node changes
  useEffect(() => {
    setIsEditing(false)
    setError(null)
    setShowArchiveConfirm(false)
    setShowAddChildModal(false)
    if (node) {
      setEditName(node.name)
      setEditDescription(node.description ?? '')
      setMoveToId(node.parent_id ?? '')
    }
  }, [node?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!node) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-300 select-none">
        <svg
          className="w-12 h-12 mb-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M3 7h4l2 3H21M3 7v10m0-10l2-3m-2 3h4m0 0l2 3m0 0h12m-12 0v7m12-7v7"
          />
        </svg>
        <p className="text-sm">Select a node to view details</p>
      </div>
    )
  }

  const handleSave = async () => {
    if (!editName.trim()) return
    setSaving(true)
    setError(null)
    try {
      await updateNode(node.id, {
        name: editName.trim(),
        description: editDescription.trim() || null,
      })
      setIsEditing(false)
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setEditName(node.name)
    setEditDescription(node.description ?? '')
    setError(null)
  }

  const handleMove = async () => {
    const newParentId = moveToId === '' ? null : moveToId
    if (newParentId === (node.parent_id ?? null)) return
    setSaving(true)
    setError(null)
    try {
      await updateNode(node.id, { parent_id: newParentId })
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Move failed')
    } finally {
      setSaving(false)
    }
  }

  const handleArchive = async () => {
    setSaving(true)
    setError(null)
    try {
      await archiveNode(node.id)
      onSelect(null)
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Archive failed')
      setSaving(false)
    } finally {
      setShowArchiveConfirm(false)
    }
  }

  const descendantIds = getDescendantIds(node)
  const moveOptions = flatNodes.filter(
    ({ node: n }) => n.id !== node.id && !descendantIds.has(n.id),
  )
  const currentParentName =
    flatNodes.find(({ node: n }) => n.id === node.parent_id)?.node.name ?? 'Root'

  return (
    <div className="max-w-2xl">
      {/* Name row */}
      <div className="flex items-start justify-between gap-4 mb-6">
        {isEditing ? (
          <input
            autoFocus
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="text-xl font-semibold text-gray-800 border-b-2 border-blue-400 outline-none bg-transparent flex-1"
          />
        ) : (
          <h2 className="text-xl font-semibold text-gray-800 flex-1 leading-tight">
            {node.name}
          </h2>
        )}

        <div className="flex gap-2 shrink-0">
          {isEditing ? (
            <>
              <button
                onClick={() => void handleSave()}
                disabled={saving || !editName.trim()}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={handleCancelEdit}
                className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setIsEditing(true)}
                className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
              >
                Edit
              </button>
              <button
                onClick={() => setShowAddChildModal(true)}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                + Add Child
              </button>
              <button
                onClick={() => setShowArchiveConfirm(true)}
                className="px-3 py-1.5 text-sm bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100"
              >
                Archive
              </button>
            </>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 px-3 py-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Description */}
      <div className="mb-6">
        <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
          Description
        </label>
        {isEditing ? (
          <textarea
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            rows={4}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none"
            placeholder="Optional description for this node"
          />
        ) : (
          <p className="text-sm text-gray-600 leading-relaxed">
            {node.description ?? (
              <span className="italic text-gray-400">No description set</span>
            )}
          </p>
        )}
      </div>

      {/* Metadata grid */}
      <div className="mb-6 grid grid-cols-3 gap-4 text-sm border-t border-gray-100 pt-4">
        <div>
          <span className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-0.5">
            Parent
          </span>
          <span className="text-gray-700">{currentParentName}</span>
        </div>
        <div>
          <span className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-0.5">
            Direct children
          </span>
          <span className="text-gray-700">{node.children.length}</span>
        </div>
        <div>
          <span className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-0.5">
            Last updated
          </span>
          <span className="text-gray-700">
            {new Date(node.updated_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      {/* Move To */}
      {!isEditing && (
        <div className="border-t border-gray-100 pt-4">
          <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Move To
          </label>
          <div className="flex gap-2">
            <select
              value={moveToId}
              onChange={(e) => setMoveToId(e.target.value)}
              className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
            >
              <option value="">— Root (no parent) —</option>
              {moveOptions.map(({ node: n, depth }) => (
                <option key={n.id} value={n.id}>
                  {'\u00a0'.repeat(depth * 3)}
                  {depth > 0 ? '└ ' : ''}
                  {n.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => void handleMove()}
              disabled={saving}
              className="px-4 py-2 text-sm bg-gray-700 text-white rounded hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Move
            </button>
          </div>
        </div>
      )}

      {/* Archive confirmation dialog */}
      {showArchiveConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h3 className="text-base font-semibold text-gray-800 mb-2">
              Archive "{node.name}"?
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              This hides the node from the hierarchy. Any requirements assigned
              to it are preserved. Archived nodes can be viewed in an admin
              context but will not appear in normal navigation.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowArchiveConfirm(false)}
                className="px-4 py-2 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleArchive()}
                disabled={saving}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {saving ? 'Archiving…' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add child modal */}
      {showAddChildModal && (
        <AddNodeModal
          parentId={node.id}
          parentName={node.name}
          onCreated={() => {
            setShowAddChildModal(false)
            onRefresh()
          }}
          onCancel={() => setShowAddChildModal(false)}
        />
      )}
    </div>
  )
}
