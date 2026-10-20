# Design

The active personal root is the local catalog scope. Its non-forgotten workspace references include owner-created boards and explicit memberships, including visitor invitations. Local IndexedDB records outside that set remain stored but do not enter available/archived workspace lists or startup fallback selection.

Enrollment installs the receiving identity's root and workspace set. The old identity's root remains separately stored; its local documents are not deleted or rebound. On startup, repair legacy root pollution narrowly: remove a `genesis` reference only when the matching local document exists and its `ownerPersonId` differs from the root identity. Preserve `import` references and references whose document is not yet downloaded.

New local creation, imports, validated workspace joins, and approved enrollment write explicit root references. Startup no longer treats every local storage row as an entitlement. Role resolution remains a separate authorization check: catalog visibility does not grant owner/editor capability, and owner absence does not change ownership.

The finite `IdentityCatalog` TLA model abstracts root references as entitlement sets and holds ownership constant. It does not model cryptographic grants, IndexedDB, network transport, or application code execution.
