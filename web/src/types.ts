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
