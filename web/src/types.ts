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
  source_document_id: string | null
  source_document: SourceDocumentStub | null
  source_clause: string | null
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

// ---------------------------------------------------------------------------
// Source documents
// ---------------------------------------------------------------------------

export interface SourceDocumentListItem {
  id: string
  document_id: string
  title: string
  document_type: string
  revision: string | null
  issuing_organization: string | null
  disciplines: string[]
  has_file: boolean
  created_at: string
  updated_at: string
}

export interface LinkedRequirementStub {
  id: string
  requirement_id: string
  title: string
  status: string
  source_clause: string | null
}

export interface SourceDocumentDetail extends SourceDocumentListItem {
  extracted_text: string | null
  linked_requirements: LinkedRequirementStub[]
}

export interface SourceDocumentStub {
  id: string
  document_id: string
  title: string
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

// ---------------------------------------------------------------------------
// Hierarchy node picker helper (flat list with depth for indentation)
// ---------------------------------------------------------------------------

export interface FlatHierarchyOption {
  id: string
  name: string
  depth: number
}

// ---------------------------------------------------------------------------
// Requirement attachments
// ---------------------------------------------------------------------------

export interface Attachment {
  id: string
  file_name: string
  file_size: number | null
  content_type: string | null
  uploaded_by: string | null
  uploaded_at: string | null
}

// ---------------------------------------------------------------------------
// Document blocks (LLM decomposition)
// ---------------------------------------------------------------------------

export interface DocumentBlock {
  id: string
  source_document_id: string
  parent_block_id: string | null
  clause_number: string | null
  heading: string | null
  content: string
  block_type: 'heading' | 'requirement_clause' | 'table_row' | 'informational' | 'boilerplate'
  sort_order: number
  depth: number
  children: DocumentBlock[]
}

// ---------------------------------------------------------------------------
// Extraction candidates
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Document references (dependency graph)
// ---------------------------------------------------------------------------

export interface DocumentReferenceListItem {
  id: string            // the other document's UUID
  document_id: string   // human-readable ID (e.g. "API 661")
  title: string
  document_type: string
  reference_context: string | null
  ref_row_id: string    // the document_references table PK — used for deletion
}

export interface GraphNode {
  id: string
  document_id: string
  title: string
  document_type: string
  issuing_organization: string | null
  revision: string | null
  disciplines: string[]
  out_count: number   // edges going out (this doc cites)
  in_count: number    // edges coming in (others cite this doc)
}

export interface GraphEdge {
  id: string
  source_id: string
  target_id: string
  reference_context: string | null
}

export interface DocumentGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface ExtractionCandidate {
  id: string
  source_document_id: string
  source_block_id: string | null
  title: string
  statement: string
  source_clause: string | null
  suggested_classification: string | null
  suggested_discipline: string | null
  status: 'Pending' | 'Accepted' | 'Rejected' | 'Edited'
  accepted_requirement_id: string | null
  created_at: string
}
