# Implementation disposition

This map supports the [target specification](design.md). Source paths are relative
to Tincanban; `MetaMesh:` denotes its vendored SDK, `Rusty:` the separate storage
repository. The observations concern existing checked-in paths; partial working-tree
replacements do not establish a release or change the required invariants.

## Replace or relocate at an explicit seam

| Existing coupling and source | Target owner and change | Safe removal condition |
| --- | --- | --- |
| Person/device removal is reversed through named old removal signatures: `src/sync/workspaceDeviceRestoration.ts`; `MetaMesh: crates/meta-mesh-core/src/authority.rs::restored_device_revocations` | Identity/access issue fresh exact rights; withdrawal of old rights stays final | Retire current-format restoration writers when replaced by fresh exact rights; preserve historical evidence and replay fences |
| Routine own-device withdrawal depends on owning every origin-connected workspace: `src/sync/rustyCredentialTransition.ts::prepareTransitionPhase` | Person controls own device rights; board governance and compromise rotation remain scoped operations | Remove unrelated ownership/Worker rotation prerequisites after current private routes enforce scoped authority |
| Profile/catalog/devices, integration references and pending effects share `PersonalRootDocumentV1`; `src/sync/identityDeviceActivation.ts` activates recovered components together | Identity owns profile/devices; personal library owns board references; each integration owns its effects | Replace mandatory all-or-nothing activation without deleting data whose remote access is pending |
| Reset reconciliation uses policy revisions, `resetOrigins` and external authority-selection callbacks: `src/sync/rustyManagementRepository.ts`, `enrollmentManagementReconciliation.ts`, `rustyManagementReconciliation.ts` | Connection owns accepted generation; relevant person/board authority approves continuity | Simplify new-scope continuity around explicit generation decisions; retain original evidence for pending work |
| Reset inspects other operations' private journal formats: `src/sync/rustyLocalReset.ts::pendingRecords` | Each operation owner provides its own valid retained transition | Remove journal introspection once explicit coordination preserves unresolved effects |
| Generic automation grants encode job stages: `src/domain/model.ts::AutomationGrantScope`, `automationApproval.ts`; `MetaMesh: crates/meta-mesh-core/src/authorization.rs::AutomationGrantColumns` | Product workflow maps job stages to bounded resource/operation rights | Keep scope/expiry enforcement and old signed readers while moving product mapping out of generic access |
| Generic causal admission knows application-source card/title/message/ATS shape: `MetaMesh: crates/meta-mesh-core/src/causal_admission.rs::validate_application_source_entity`; `src/domain/applicationSourceData.ts`, `commandApplicationSource.ts` | Product owns source immutability and card/source consistency; SDK owns generic proof mechanics | Relocate through an explicit policy contract with equivalent browser/native/automation fixtures; never add unchecked fallback |
| Portable board storage contract is derived from local config by omission: `src/domain/boardStorageAccess.ts::BoardStorageConnection`; `src/sync/workspaceRustyAccess.ts` | Connection owns an explicit signed portable contract; local cursors/progress stay local | Replace wire mapping without losing scope, generation, key epoch, recipient rights or signatures |
| Product login approval imports workspace evidence: `src/app/ServiceLoginApp.vue`, `serviceLoginApproval.ts`; identity/device recovery carries Tincanban components: `src/sync/identityDeviceRecoveryCodec.ts` | Generic identity approval belongs in SDK/portal; scoped log rights and board/private-storage data remain application-owned | Replace ordinary product identity UI after portal integration; keep supported scoped log access separate |

These are separate seams. Common login does not wait for new board authorization,
Rusty generations or product-policy relocation. Replacing one fact owner must not
create a second independently mutable authority for the same fact.

## Reuse existing behavior and mechanisms

| Keep | Existing implementation and invariant |
| --- | --- |
| Random-root identity and encrypted recovery | `MetaMesh: packages/mesh-identity/src/index.ts`; words wrap the existing root; each device retains its own key |
| Signed causal profile state | `src/domain/identityProfileState.ts`, `identityProfileRoot.ts`; board/chat copies are projections, not competing authorities |
| Board commands and source consistency | `src/domain/commands.ts`, `commandHandlers.ts`, `commandApplicationSource.ts`; retain validated commands and atomic original-source/card creation |
| Board governance | `src/domain/permissions.ts`, `src/sync/changeAuthorization.ts`; owner, membership, device restrictions and quorum are distinct from identity login |
| Archive/workflow and local catalog semantics | `src/domain/itemLifecycle.ts`, `archive.ts`, `personalRoot.ts`; archive, last stage and forgetting are different facts |
| Attachment integrity and locations | `src/domain/entitySchemas.ts`, `src/product-replica/attachmentLocator.ts`, `src/sync/attachmentAccess.ts`; missing replica does not delete a logical file |
| Public projection and withdrawal checks | `src/public/publicProjection.ts`, `publicDeliveryPolicy.ts`, `publicationClient.ts`; retain approved disclosure, bounded writers and signed tombstones |
| Automation lifecycle | `src/domain/automationLifecycle.ts`, `automationApproval.ts`, `workers/automation/src/executionCoordinator.ts`; paused, revoked, offline and uncertain execution are distinct |
| Raw/admitted history and replication | `src/product-replica/workspaceAdmission.ts`, `src/stateCausalAdmission.ts`, `MetaMesh: packages/mesh-replication`; retain originals, causal admission, bounded delivery, encryption and archive verification |
| Encrypted replica storage | `Rusty: src/blind.rs`, `checkpoint.rs`, `blobs.rs`, `archives.rs`; retain object integrity, durable acknowledgment and independent owners |
| Content-preserving board export/import | `src/app/workspaceFiles.ts` uses `importWorkspaceAsNew`; `.tincanban` import creates new boards and does not transfer old identity/service authority |

## Retirement needs a separate decision

Legacy Keeper participant integration (`src/sync/ownerKeeper.ts`, `keeperPairing.ts`,
`src/app/keeperApi.ts`) may still have retained grants and pending withdrawals.
Retire it after supported consumers and unresolved effects are accounted for.

Workspace and board IDs currently have different scopes in membership, automation
and publication. Do not merge them without a product invariant establishing that
they are interchangeable. Likewise, do not remove old attachment/history/recovery
readers merely because a newer schema exists.

## Deletion boundary

Replace obsolete current orchestration only behind working domain contracts and
new callers/scopes using the target rules. Retain original data, required readers,
withdrawal evidence and pending operations. Do not rewrite board content, crypto,
transport or history just because they share a large record with access state.
A shorter implementation is an outcome to measure, not a correctness criterion or
reason to delete the application.
