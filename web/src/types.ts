export interface HierarchyNode {
  id: string
  parent_id: string | null
  name: string
  description: string | null
  archived: boolean
  sort_order: number
  created_at: string
  updated_at: string
  children: HierarchyNode[]
}

export interface FlatNode {
  node: HierarchyNode
  depth: number
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export interface Site {
  id: string
  name: string
}

export interface Unit {
  id: string
  name: string
  sort_order: number
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

/** Minimal record returned in the paginated list view */
export interface RequirementListItem {
  id: string
  requirement_id: string
  title: string
  classification: string
  owner: string
  status: string
  discipline: string
  created_by: string
  created_date: string
  hierarchy_nodes: { id: string; name: string }[]
  sites: { id: string; name: string }[]
  units: { id: string; name: string }[]
}

/** Minimal stub used in parent/child link lists */
export interface RequirementStub {
  id: string
  requirement_id: string
  title: string
}

/** Full record returned by the detail endpoint */
export interface RequirementDetail extends RequirementListItem {
  statement: string
  source_type: string
  last_modified_by: string | null
  last_modified_date: string | null
  change_history: string | null
  rationale: string | null
  verification_method: string | null
  tags: string[]
  created_at: string
  updated_at: string
  parent_requirements: RequirementStub[]
  child_requirements: RequirementStub[]
}

// ---------------------------------------------------------------------------
// Traceability links
// ---------------------------------------------------------------------------

export interface RequirementLink {
  parent_requirement_id: string
  child_requirement_id: string
}

export interface RequirementListResponse {
  total: number
  page: number
  page_size: number
  items: RequirementListItem[]
}

export interface RequirementCreatePayload {
  title: string
  statement: string
  classification: string
  owner: string
  source_type: string
  status: string
  discipline: string
  created_by: string
  created_date: string
  last_modified_by?: string
  last_modified_date?: string
  change_history?: string
  rationale?: string
  verification_method?: string
  tags?: string[]
  hierarchy_node_ids: string[]
  site_ids: string[]
  unit_ids: string[]
}

export type RequirementUpdatePayload = Partial<RequirementCreatePayload>
