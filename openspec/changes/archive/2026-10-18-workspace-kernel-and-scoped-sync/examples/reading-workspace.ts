import type { WorkspaceDocumentV2 } from "../contracts/model"

/** Shape fixture only. Identity is a placeholder; no authorization is implied. */
const boardId = "10000000-0000-4000-8000-000000000001"
const todoId = "10000000-0000-4000-8000-000000000002"
const doingId = "10000000-0000-4000-8000-000000000003"
const doneId = "10000000-0000-4000-8000-000000000004"
const authorId = "10000000-0000-4000-8000-000000000005"
const itemId = "10000000-0000-4000-8000-000000000006"
const subitemId = "10000000-0000-4000-8000-000000000007"
const timestamps = {
  createdAt: "2026-09-09T12:00:00.000Z",
  updatedAt: "2026-09-09T12:00:00.000Z",
}

export const readingWorkspace = {
  kind: "workspace",
  formatVersion: 2,
  id: "10000000-0000-4000-8000-000000000000",
  title: "Reading",
  ownerPersonId: "fixture-person-not-a-real-key-fingerprint",
  archivedAt: null,
  migration: null,
  entities: {
    [boardId]: {
      id: boardId, kind: "board", title: "Reading", archivedAt: null,
      placement: { parentId: null, rank: "0/1" }, ...timestamps,
      preset: { key: "blank", version: 1, bindings: {} },
    },
    [todoId]: {
      id: todoId, kind: "column", title: "To read", archivedAt: null,
      placement: { parentId: boardId, rank: "0/1" }, ...timestamps,
    },
    [doingId]: {
      id: doingId, kind: "column", title: "Reading", archivedAt: null,
      placement: { parentId: boardId, rank: "1/1" }, ...timestamps,
    },
    [doneId]: {
      id: doneId, kind: "column", title: "Finished", archivedAt: null,
      placement: { parentId: boardId, rank: "2/1" }, ...timestamps,
    },
    [authorId]: {
      id: authorId, kind: "field", title: "Author", archivedAt: null,
      placement: { parentId: boardId, rank: "0/1" }, ...timestamps,
      valueType: "text", required: false,
    },
    [itemId]: {
      id: itemId, title: "Designing Data-Intensive Applications",
      placement: { parentId: doingId, rank: "0/1" }, ...timestamps,
      archivedAt: null, body: "Read and record useful ideas.",
      values: { [authorId]: "Martin Kleppmann" },
    },
    [subitemId]: {
      id: subitemId, title: "Notes on replication",
      placement: { parentId: itemId, rank: "0/1" }, ...timestamps,
      archivedAt: null, body: "", values: {},
    },
  },
} satisfies WorkspaceDocumentV2

// Archiving doingId changes only that column.s archivedAt timestamp.
// Both items then disappear from normal views; their timestamps and placements stay.
// Restoring doingId reveals both unless either was independently archived.
// Renaming Author changes one field record; item values remain keyed by authorId.
