export type ArchiveColumnLike = {
  archive?: true
  id?: string
  collapsible?: boolean
}

export function isArchiveColumn(column: ArchiveColumnLike, board?: { archiveColumnId?: string | null }): boolean {
  if (board && board.archiveColumnId !== undefined) return board.archiveColumnId === column.id
  return column.archive === true
}
