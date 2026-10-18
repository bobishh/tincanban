## 1. Contract and acceptance
- [x] 1.1 Specify generic card configuration and literal text behavior; author outside-in acceptance cases.
- [x] 1.2 Add failing unit coverage for explicit formats and removal of hidden source parsing.

## 2. Apply
- [x] 2.1 Replace jobs-specific card/form/detail paths with generic configured fields.
- [x] 2.2 Roundtrip explicit presentation and text-format metadata through creation, editing and publication.
- [x] 2.3 Remove source JSON envelope and jobs-only priority/UI/state contracts; isolate declarative template data.

## 3. Verify and release
- [x] 3.1 Verify create/edit/reload and relevant failure/public/mobile flows; run required quality and size checks.
- [x] 3.2 Commit and push; fix CI failures and confirm successful production deployment.

## Release evidence — 2026-10-18

- Application `725c09daa6743c610180146960153597b58eaec6`: all 15 jobs passed in [Verify](https://github.com/bobishh/tincanban/actions/runs/39084819409), including configured-field create/edit/reload, failure handling, mobile layouts, recovery and native/WebKit publication.
- [Frontend deployment](https://github.com/bobishh/tincanban/actions/runs/39085558662) and [Worker deployment](https://github.com/bobishh/tincanban/actions/runs/39085558640) succeeded. Both production health endpoints confirmed this application SHA and SDK `0af200292beb37dc16b5430ef2c52c9e6864def7`.
- Runtime [image build](https://github.com/bobishh/tincanban/actions/runs/39085868973) and [Reflux activation](https://github.com/bobishh/acidreflux/actions/runs/39086505314) succeeded. Reaction 1 now uses `ghcr.io/bobishh/tincanban-reaction@sha256:e8eca89c670b21c96311b3939d9d6ad8578094dcbd8e40a4ecb21e1e70fe25a7`; retained participant identity was verified after activation.
- Rusty `18748057b34c939d3af41fed8f6f9743808ea0b4` passed [CI](https://github.com/bobishh/rusty/actions/runs/39084805829) and [deployment](https://github.com/bobishh/rusty/actions/runs/39085083360); production health confirmed the SHA. Signed policy content hashes prevent repeated publication caused by randomized Ed25519 signatures without changing exact command signatures.
- No local tests were run during CI remediation. External Automation connection UI and TinSink permission/root-key changes are outside this completed change.
