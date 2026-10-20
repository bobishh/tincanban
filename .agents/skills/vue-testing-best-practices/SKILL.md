---
name: vue-testing-best-practices
version: 1.0.0
license: MIT
author: github.com/vuejs-ai
description: Use for Vue.js testing. Covers Vitest, Vue Test Utils, component testing, mocking, testing patterns, and Playwright for E2E testing.
---

Vue.js testing best practices, patterns, and common gotchas.

### Testing
- Setting up test infrastructure for Vue 3 projects → See [testing-vitest-recommended-for-vue](reference/testing-vitest-recommended-for-vue.md)
- Tests keep breaking when refactoring component internals → See [testing-component-blackbox-approach](reference/testing-component-blackbox-approach.md)
- Tests fail intermittently with race conditions → See [testing-async-await-flushpromises](reference/testing-async-await-flushpromises.md)
- Composables using lifecycle hooks or inject fail to test → See [testing-composables-helper-wrapper](reference/testing-composables-helper-wrapper.md)
- Getting "injection Symbol(pinia) not found" errors in tests → See [testing-pinia-store-setup](reference/testing-pinia-store-setup.md)
- Components with async setup won't render in tests → See [testing-suspense-async-components](reference/testing-suspense-async-components.md)
- Snapshot tests keep passing despite broken functionality → See [testing-no-snapshot-only](reference/testing-no-snapshot-only.md)
- Choosing end-to-end testing framework for Vue apps → See [testing-e2e-playwright-recommended](reference/testing-e2e-playwright-recommended.md)
- Tests need to verify computed styles or real DOM events → See [testing-browser-vs-node-runners](reference/testing-browser-vs-node-runners.md)
- Testing components created with defineAsyncComponent fails → See [async-component-testing](reference/async-component-testing.md)
- Teleported modal content can't be found in wrapper queries → See [teleport-testing-complexity](reference/teleport-testing-complexity.md)

## Reference

- [Vue.js Testing Guide](https://vuejs.org/guide/scaling-up/testing)
- [Vue Test Utils](https://test-utils.vuejs.org/)
- [Vitest Documentation](https://vitest.dev/)
- [Playwright Documentation](https://playwright.dev/)


## Local repository integration

This installation is pinned and adapted for this repository. Follow user instructions and applicable AGENTS.md before this skill.

- Preserve existing changes and processes. Inspect baselines with git show, git diff, and git blame at explicit refs; never switch the user's checkout for an audit.
- Commit, stage, push, publish, deploy, send external messages, or alter infrastructure only when the user explicitly requests that action. An audit request authorizes findings, not automatic fixes.
- Preserve meaningful test coverage; never delete tests merely because an extraction or example workflow suggests it.
- Do not assume Claude plugin agents, hooks, commands, or allowed-tools metadata are registered or grant access in Codex. Use available host tools; optional plugin roles require explicit adaptation.
- Do not run unpinned downloaded CLIs. Check the project's versions, inspect dependencies, and use an explicitly pinned version when a tool is needed. Do not pass secrets or private source to external services without authorization.
- Follow the host's subagent policy. Invoke additional design/refactoring workflows only within the requested scope.
