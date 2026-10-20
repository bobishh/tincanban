# Command and migration contract

All names here are logical domain operations; WebMCP uses snake_case equivalents. Commands are scoped to an explicit `workspaceId`. UI and WebMCP call the same validator/store. Identity/root operations use their own explicit scope. Never accept a caller-supplied CRDT document, actor ID, author identity, or arbitrary mutation callback through WebMCP.

## Write boundary

1. Resolve current committed document and authenticated context; allocate/reuse transaction UUID.
2. Validate command shape with unknown-key rejection. Resolve all IDs in that workspace.
3. Compute proposed changes and check kind-specific invariants against the whole proposed result.
4. Apply one `Automerge.change` to a candidate, with `TransactionMetadataV1` JSON as its message.
5. Obtain the native change hash; sign proof after change creation.
6. Commit bytes + proof + transaction-ID receipt in one IndexedDB transaction.
7. Publish document, update derived indexes, notify views and replication, return `TransactionReceipt`.

If steps 1-6 fail, the previously committed state remains authoritative. Retrying a committed transaction UUID returns its stored receipt; retrying an uncommitted candidate must not apply the domain action twice. Same UUID with different command data is `invalid_input`.

## Operations

| Operation | Input | Required behavior |
| --- | --- | --- |
| createWorkspace | title, preset (`job-search` or `blank`) | Allocate new UUID and initial document once; create owner genesis/grant; durably register reference |
| renameWorkspace | title | Patch title only |
| setWorkspaceArchived | archived | Set or clear workspace `archivedAt`; owner only |
| createBoard | title, preset | Seed board/columns/fields in one workspace transaction |
| createColumn | boardId, title, archive?, beforeId or null | Create column under board; permit at most one active `archive: true` column |
| createItem | parentId, title, body?, values? | Parent column/item on a valid live board; validate board fields |
| patchItem | entityId, title?, body?, values? | Patch supplied fields only; omitted values unchanged; null clears |
| moveEntity | entityId, parentId, beforeId or null | Column reorder within same board; item move/nesting within same board; replace placement atomically |
| renameEntity | entityId, title | Rename existing entity without changing ID or links |
| setEntityArchived | entityId, archived | Set or clear own `archivedAt`; restore may report hidden ancestor without moving |
| restoreAndMove | entityId, parentId, beforeId or null | Restore and assign valid live placement in one transaction |
| createField | boardId, title, valueType, required, options?/bounds? | Create field and UUID options; type immutable after creation |
| patchField | fieldId, title?, required?, min?, max? | Keep stored values; newly invalid existing values show validation issues |
| createFieldOption | fieldId, title, beforeId or null | Select field only; stable UUID option |
| patchFieldOption | fieldId, optionId, title?, archived? | Preserve existing selected option IDs; archived choice no longer selectable |
| addDocument / patchDocument | itemId or entityId, typed document fields | Preserve old attached notes/files; parent must be item |
| createTemplate / patchTemplate | typed template fields | Workspace-root entity; archiving template preserves artifacts |
| updateWorkspaceSettings | settings, expectedHeads? | Validate full typed configuration; patch title/board/columns/fields/templates in one change; omissions archive |
| recordArtifact | itemId, templateId, title, artifactKind, pdf, sourceMarkdown? | tincanban active template kind when creating; retain reference after later template archiving |

Only `moveEntity`, `restoreAndMove`, and creation write placement. Item creation and moves into the Archive column are rejected; `setEntityArchived` changes archive state without placement. `patchItem` cannot alter kind, ID, creation time, parent, or `archivedAt`. `renameEntity` requires non-empty title after trim. Schema-derived fields are validated only against the containing board; unknown field IDs fail.

New select values store option UUIDs, never option labels. New URL values require http/https; dates use `YYYY-MM-DD`; numbers must be finite and within optional bounds; booleans are true/false. Missing/null optional fields are empty. Required fields reject empty/null on create/update. Archived fields no longer participate in required validation, but their values remain. Previously stored invalid values caused by a changed definition are displayed with an issue, not coerced or erased. Field type changes return `field_type_change`; create a replacement field explicitly instead. Existing select values whose options were archived display the retained option label plus an unavailable marker.

Structural or field-definition edits by editors are allowed. Identity, grants, signatures, and catalog membership are never writable through these content commands. `setWorkspaceArchived` is owner-only; entity archiving is available to editors.

## Read boundary

- `getWorkspace`, `listWorkspaces`: explicit catalog scope; forgotten references excluded by default.
- `getEntity(id)`: raw typed entity for authorized callers, including `archivedAt` and computed visibility reason.
- `children(parentId)`: direct children including archived records; deterministic rank/ID ordering.
- `visibleChildren(parentId)`: apply workspace/ancestor/own archive state and placement validity.
- `descendants(parentId)`: bounded traversal with visited set; no infinite recursion.
- `listArchived`: archived entities and workspace header; identify any archived ancestor.
- `listPlacementIssues`: recovery entries, including hidden descendants affected by invalid ancestry.
- `history(entityId?)`: native changes and verified author/device mapping; legacy changes explicitly unattributed.
- `getGenerationContext(itemId, templateId)`: current item context + Markdown template; no artifact created.
- `getWorkspaceSettings`: full editable configuration projection plus current heads; no items, identity, trust, sync state, or history payloads.

## Legacy migration table

| Legacy source | v2 target |
| --- | --- |
| Workspace without ID | New UUID allocated once in durable migration plan |
| `lead.id` | Same entity ID; item recognized structurally by body, values, and placement |
| company + role | Initial item title `${company} — ${role}` plus separate text fields preserving original strings |
| `lead.status` | Item placement referencing seeded column through bindings `status.lead`, `status.applied`, etc. |
| `archived`, `rejected`, `bin` | Single live column with `archive: true`; collapsed presentation is derived |
| unknown status | Live "Unsorted" column, created once in plan; preserve original status in a legacy-status text field |
| url, location, notes, sourceText | Corresponding optional URL/text fields, exact stored strings preserved |
| description | Item body |
| workMode | Select option UUID mapped from remote/hybrid/onsite/unknown |
| priority | Select option UUID mapped from p0/p1/p2/p3 |
| fitScore | Number field, optional; preset bounds 0..10 |
| document.id / leadId | Same document ID; parent item ID unchanged |
| template.id / name / kind | Same template ID; title/name mapping; root placement; typed templateKind |
| artifact.id / leadId / templateId | Same artifact ID; parent item and template provenance links unchanged |
| localPath / pdfPath / sourceMarkdownPath | Device-local file location plus portable fileId reference; no claim that bytes are embedded |
| createdAt / updatedAt | Exact original values |

Missing optional values stay empty; do not synthesize content. Migration preserves out-of-range/unknown legacy values as validation issues rather than silently normalizing them away; add a dedicated legacy text field for an unknown select value and leave the new select empty. Source arrays remain readable as immutable legacy data. Pre-existing dangling references enter Needs placement or missing-template display states; they do not abort otherwise recoverable migration.

The plan lists every new seed UUID and local file-reference UUID before applying changes. Keep relative source array ordering within each target column. Reject duplicate legacy IDs across collections with a precise migration-conflict report before applying the plan; never overwrite one record in the new entity map or silently reassign an old ID. Migration failure leaves old bytes and JSON available and no partial catalog entry. Publish catalog reference only after the workspace exists durably; interruption between these documents resumes registration idempotently. This is a recoverable workflow, not a cross-document transaction.

## Bundle v2 layout

```text
manifest.json                 format="match", version=2, workspaceId, heads,
                              includedBlobHashes, missingBlobHashes, proofFormatVersion=1
workspace.automerge            canonical history and state
workspace.json                readable snapshot, not an authority
proofs.json                    public genesis/grants/certificates/actor bindings/change proofs
blobs/<sha256>                 optional verified file bytes
```

Manifest ID must match the document. With canonical bytes present, snapshot disagreement is reported and the canonical bytes remain authoritative. Validate supported versions, unique paths, bounded archive entries, hashes, proof completeness, and authorizations before publishing imported content. Never downgrade an invalid signed v2 file to unsigned legacy import. Owner-signed legacy checkpoint permits the preserved pre-upgrade history while retaining its legacy label.

Possessing an exported file does not issue a workspace grant. A valid foreign v2 bundle without a grant for the local person can be opened as a read-only local archive after proof verification; it is not added to the writable/sync catalog. Joining its mesh requires an owner invitation. Do not silently adopt ownership or reuse its workspace ID for a new writable copy. A JSON-only snapshot import explicitly creates a new owned workspace instead.

Migration's original file paths remain inside preserved historical v0 bytes when those bytes are exported; warn in export details that legacy history can contain paths. Do not promise redaction while preserving that history. Newly created v2 local file paths stay only in the device-local store. Imported paths are not automatically opened or treated as accessible on this device.
