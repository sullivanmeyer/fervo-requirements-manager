/**
 * RequirementDetail
 *
 * Full create / edit form for a single requirement, now including
 * parent/child traceability link management (Stage 3).
 *
 * Pass requirementId=null to create a new requirement.
 * Pass initialParentIds to pre-populate parents (used by "Add Child").
 */
import { useEffect, useState } from 'react'
import {
  addLink,
  createRequirement,
  fetchAllRequirements,
  fetchRequirement,
  fetchSites,
  fetchUnits,
  removeLink,
  updateRequirement,
} from '../api/requirements'
import type {
  HierarchyNode,
  RequirementDetail as ReqDetail,
  RequirementListItem,
  RequirementStub,
  Site,
  Unit,
} from '../types'
import HierarchyNodePicker from '../components/HierarchyNodePicker'
import RequirementSearch from '../components/RequirementSearch'
import TagInput from '../components/TagInput'

// ---------------------------------------------------------------------------
// Enum values (must match api/schemas.py)
// ---------------------------------------------------------------------------

const CLASSIFICATIONS = ['Requirement', 'Guideline']
const SOURCE_TYPES = ['Manual Entry', 'Derived from Document']
const STATUSES = ['Draft', 'Under Review', 'Approved', 'Superseded', 'Withdrawn']
const DISCIPLINES = [
  'Mechanical',
  'Electrical',
  'I&C',
  'Civil/Structural',
  'Process',
  'Fire Protection',
  'General',
]
const VERIFICATION_METHODS = [
  'Analysis',
  'Inspection',
  'Test',
  'Demonstration',
  'Review of Record',
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  requirementId: string | null        // null = creating new
  hierarchyNodes: HierarchyNode[]
  userName: string
  initialParentIds?: string[]         // pre-link parents (used by "Add Child")
  onSaved: (savedId: string) => void
  onCancel: () => void
  onViewInTree: (id: string) => void  // navigate to derivation tree tab
  onAddChild: (parentId: string) => void
}

interface FormState {
  title: string
  statement: string
  classification: string
  owner: string
  source_type: string
  status: string
  discipline: string
  created_by: string
  created_date: string
  last_modified_by: string
  last_modified_date: string
  change_history: string
  rationale: string
  verification_method: string
  tags: string[]
  hierarchy_node_ids: string[]
  site_ids: string[]
  unit_ids: string[]
}

const today = () => new Date().toISOString().slice(0, 10)

function emptyForm(userName: string): FormState {
  return {
    title: '',
    statement: '',
    classification: 'Requirement',
    owner: userName,
    source_type: 'Manual Entry',
    status: 'Draft',
    discipline: 'Mechanical',
    created_by: userName,
    created_date: today(),
    last_modified_by: '',
    last_modified_date: '',
    change_history: '',
    rationale: '',
    verification_method: '',
    tags: [],
    hierarchy_node_ids: [],
    site_ids: [],
    unit_ids: [],
  }
}

function formFromDetail(req: ReqDetail): FormState {
  return {
    title: req.title,
    statement: req.statement,
    classification: req.classification,
    owner: req.owner,
    source_type: req.source_type,
    status: req.status,
    discipline: req.discipline,
    created_by: req.created_by,
    created_date: req.created_date,
    last_modified_by: req.last_modified_by ?? '',
    last_modified_date: req.last_modified_date ?? '',
    change_history: req.change_history ?? '',
    rationale: req.rationale ?? '',
    verification_method: req.verification_method ?? '',
    tags: req.tags ?? [],
    hierarchy_node_ids: req.hierarchy_nodes.map((n) => n.id),
    site_ids: req.sites.map((s) => s.id),
    unit_ids: req.units.map((u) => u.id),
  }
}

// ---------------------------------------------------------------------------
// Small layout helpers
// ---------------------------------------------------------------------------

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
    </div>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
    />
  )
}

function SelectInput({
  value,
  options,
  onChange,
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

function MultiSelectInput({
  label,
  options,
  selectedIds,
  onChange,
}: {
  label: string
  options: { id: string; name: string }[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}) {
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((s) => s !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  return (
    <div className="border border-gray-300 rounded overflow-hidden">
      {options.length === 0 ? (
        <p className="px-3 py-2 text-sm text-gray-400">No {label} available</p>
      ) : (
        options.map((opt) => (
          <label
            key={opt.id}
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-0"
          >
            <input
              type="checkbox"
              checked={selectedIds.includes(opt.id)}
              onChange={() => toggle(opt.id)}
              className="rounded"
            />
            <span className="text-sm text-gray-700">{opt.name}</span>
          </label>
        ))
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sync helper: given original and desired parent ID sets, fire add/remove
// API calls for the diff.  Returns an error string if any call fails.
// ---------------------------------------------------------------------------

async function syncParentLinks(
  childId: string,
  originalParentIds: string[],
  desiredParentIds: string[],
): Promise<string | null> {
  const toAdd = desiredParentIds.filter((id) => !originalParentIds.includes(id))
  const toRemove = originalParentIds.filter((id) => !desiredParentIds.includes(id))

  try {
    for (const parentId of toRemove) {
      await removeLink(parentId, childId)
    }
    for (const parentId of toAdd) {
      await addLink(parentId, childId)
    }
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Link update failed'
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function RequirementDetail({
  requirementId,
  hierarchyNodes,
  userName,
  initialParentIds = [],
  onSaved,
  onCancel,
  onViewInTree,
  onAddChild,
}: Props) {
  const isNew = requirementId === null

  const [form, setForm] = useState<FormState>(emptyForm(userName))
  const [existingReqId, setExistingReqId] = useState<string | null>(null)
  const [savedDbId, setSavedDbId] = useState<string | null>(null)

  // Parent link state: what the DB currently has vs what the user selected
  const [originalParentIds, setOriginalParentIds] = useState<string[]>(initialParentIds)
  const [selectedParentIds, setSelectedParentIds] = useState<string[]>(initialParentIds)
  const [childRequirements, setChildRequirements] = useState<RequirementStub[]>([])

  const [allRequirements, setAllRequirements] = useState<RequirementListItem[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // -------------------------------------------------------------------------
  // Load on mount
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (isNew) {
      // For a new requirement: just fetch reference data in parallel
      void Promise.all([fetchAllRequirements(), fetchSites(), fetchUnits()]).then(
        ([reqs, s, u]) => {
          setAllRequirements(reqs)
          setSites(s)
          setUnits(u)
        },
      )
    } else {
      const loadAll = async () => {
        try {
          const [req, reqs, s, u] = await Promise.all([
            fetchRequirement(requirementId!),
            fetchAllRequirements(),
            fetchSites(),
            fetchUnits(),
          ])
          setForm(formFromDetail(req))
          setExistingReqId(req.requirement_id)
          setSavedDbId(req.id)

          const parentIds = req.parent_requirements.map((p) => p.id)
          setOriginalParentIds(parentIds)
          setSelectedParentIds(parentIds)
          setChildRequirements(req.child_requirements)

          setAllRequirements(reqs)
          setSites(s)
          setUnits(u)
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Failed to load requirement')
        } finally {
          setLoading(false)
        }
      }
      void loadAll()
    }
  }, [isNew, requirementId])

  // -------------------------------------------------------------------------
  // Field updater
  // -------------------------------------------------------------------------

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  // -------------------------------------------------------------------------
  // Save: scalar fields first, then sync parent links
  // -------------------------------------------------------------------------

  const handleSave = async () => {
    if (!form.title.trim() || !form.statement.trim()) {
      setError('Title and Statement are required.')
      return
    }

    setSaving(true)
    setError(null)

    const payload = {
      ...form,
      last_modified_by: form.last_modified_by || undefined,
      last_modified_date: form.last_modified_date || undefined,
      change_history: form.change_history || undefined,
      rationale: form.rationale || undefined,
      verification_method: form.verification_method || undefined,
    }

    try {
      let savedId: string
      if (isNew) {
        const created = await createRequirement(payload)
        savedId = created.id
      } else {
        const updated = await updateRequirement(requirementId!, payload)
        savedId = updated.id
      }

      // Sync parent links against what was in the DB before this save
      const linkError = await syncParentLinks(
        savedId,
        originalParentIds,
        selectedParentIds,
      )
      if (linkError) {
        setError(`Requirement saved, but link update failed: ${linkError}`)
        setSaving(false)
        return
      }

      onSaved(savedId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      setSaving(false)
    }
  }

  // -------------------------------------------------------------------------
  // Build the options list for the parent search — exclude self and SELF-000
  // (SELF-000 is already filtered out of allRequirements by the list endpoint)
  // -------------------------------------------------------------------------

  const parentOptions: RequirementStub[] = allRequirements
    .filter((r) => r.id !== savedDbId)
    .map((r) => ({ id: r.id, requirement_id: r.requirement_id, title: r.title }))

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

  return (
    <div className="flex flex-col h-full">
      {/* Header / breadcrumb */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0 flex-wrap">
        <button onClick={onCancel} className="text-sm text-blue-600 hover:underline">
          ← Requirements
        </button>
        <span className="text-gray-400">/</span>
        <span className="text-sm font-medium text-gray-700">
          {isNew ? 'New Requirement' : (existingReqId ?? requirementId)}
        </span>

        <div className="ml-auto flex gap-2 flex-wrap">
          {/* "View in Tree" only makes sense for saved requirements */}
          {!isNew && savedDbId && (
            <button
              onClick={() => onViewInTree(savedDbId)}
              className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
            >
              View in Tree
            </button>
          )}
          {!isNew && savedDbId && (
            <button
              onClick={() => onAddChild(savedDbId)}
              className="px-3 py-1.5 text-sm border border-blue-300 text-blue-600 rounded hover:bg-blue-50"
            >
              + Add Child
            </button>
          )}
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Form body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-4xl space-y-6">

          {/* Identity */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Identity
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Field label="Title" required>
                  <TextInput
                    value={form.title}
                    onChange={(v) => set('title', v)}
                    placeholder="Short descriptive title"
                  />
                </Field>
              </div>
              <Field label="Classification" required>
                <SelectInput
                  value={form.classification}
                  options={CLASSIFICATIONS}
                  onChange={(v) => set('classification', v)}
                />
              </Field>
              <Field label="Discipline" required>
                <SelectInput
                  value={form.discipline}
                  options={DISCIPLINES}
                  onChange={(v) => set('discipline', v)}
                />
              </Field>
              <Field label="Status" required>
                <SelectInput
                  value={form.status}
                  options={STATUSES}
                  onChange={(v) => set('status', v)}
                />
              </Field>
              <Field label="Source Type" required>
                <SelectInput
                  value={form.source_type}
                  options={SOURCE_TYPES}
                  onChange={(v) => set('source_type', v)}
                />
              </Field>
            </div>
          </section>

          {/* Traceability */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Traceability
            </h2>
            <div className="space-y-4">
              <Field label="Parent Requirement(s)">
                <p className="text-xs text-gray-400 mb-1.5">
                  Leave blank to imply Self-Derived (no upstream source).
                </p>
                <RequirementSearch
                  options={parentOptions}
                  selectedIds={selectedParentIds}
                  onChange={setSelectedParentIds}
                  placeholder="Search requirements to set as parents…"
                />
              </Field>

              {/* Child requirements: read-only list populated from the API */}
              {childRequirements.length > 0 && (
                <Field label="Child Requirements">
                  <div className="flex flex-wrap gap-2">
                    {childRequirements.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        onClick={() => onSaved(child.id)}
                        className="px-2.5 py-1 bg-indigo-50 text-indigo-700 text-xs rounded border border-indigo-200 font-mono hover:bg-indigo-100 transition-colors"
                        title={child.title}
                      >
                        {child.requirement_id}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400 mt-1.5">
                    Click a child to open it. Use "Add Child" in the header to create a new one.
                  </p>
                </Field>
              )}
            </div>
          </section>

          {/* Statement */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Requirement Statement
            </h2>
            <Field label="Statement" required>
              <textarea
                value={form.statement}
                onChange={(e) => set('statement', e.target.value)}
                rows={5}
                placeholder="The system shall…"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
              />
            </Field>
            <div className="mt-4">
              <Field label="Rationale">
                <textarea
                  value={form.rationale}
                  onChange={(e) => set('rationale', e.target.value)}
                  rows={3}
                  placeholder="Why does this requirement exist?"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
                />
              </Field>
            </div>
          </section>

          {/* Verification */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Verification
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Verification Method">
                <select
                  value={form.verification_method}
                  onChange={(e) => set('verification_method', e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                >
                  <option value="">— Not specified —</option>
                  {VERIFICATION_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </section>

          {/* Applicability */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Applicability
            </h2>
            <div className="grid grid-cols-2 gap-6">
              <div className="col-span-2">
                <Field label="Hierarchy Nodes">
                  <HierarchyNodePicker
                    nodes={hierarchyNodes}
                    selectedIds={form.hierarchy_node_ids}
                    onChange={(ids) => set('hierarchy_node_ids', ids)}
                  />
                </Field>
              </div>
              <Field label="Sites">
                <MultiSelectInput
                  label="sites"
                  options={sites}
                  selectedIds={form.site_ids}
                  onChange={(ids) => set('site_ids', ids)}
                />
              </Field>
              <Field label="Applicable Units">
                <MultiSelectInput
                  label="units"
                  options={units}
                  selectedIds={form.unit_ids}
                  onChange={(ids) => set('unit_ids', ids)}
                />
              </Field>
            </div>
          </section>

          {/* Ownership */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Ownership &amp; Dates
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Owner" required>
                <TextInput value={form.owner} onChange={(v) => set('owner', v)} />
              </Field>
              <Field label="Created By" required>
                <TextInput value={form.created_by} onChange={(v) => set('created_by', v)} />
              </Field>
              <Field label="Created Date" required>
                <input
                  type="date"
                  value={form.created_date}
                  onChange={(e) => set('created_date', e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </Field>
              <Field label="Last Modified By">
                <TextInput
                  value={form.last_modified_by}
                  onChange={(v) => set('last_modified_by', v)}
                />
              </Field>
              <Field label="Last Modified Date">
                <input
                  type="date"
                  value={form.last_modified_date}
                  onChange={(e) => set('last_modified_date', e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
              </Field>
            </div>
          </section>

          {/* Additional */}
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 pb-1 border-b border-gray-100">
              Additional
            </h2>
            <div className="space-y-4">
              <Field label="Tags">
                <TagInput tags={form.tags} onChange={(t) => set('tags', t)} />
              </Field>
              <Field label="Change History">
                <textarea
                  value={form.change_history}
                  onChange={(e) => set('change_history', e.target.value)}
                  rows={3}
                  placeholder="Rev A — initial release; Rev B — updated to reflect P&ID rev 4"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 resize-y"
                />
              </Field>
            </div>
          </section>

        </div>
      </div>
    </div>
  )
}
