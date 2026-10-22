# Delivery tasks

## Shared identity and independent portal

- [ ] Extend the existing MetaMesh identity package with versioned common login, explicit device authority and independent Identity replication; share browser/native protocol vectors and preserve existing consumers.
- [ ] Complete the portal as a separate static project using existing UI/CSS. Implement profile creation, portal/app bootstrap, explicit 12/24-word encrypted recovery and replacement consent.
- [ ] Verify same-browser cross-origin login, new-device enrollment, offline local use and recovery without requiring a board mesh or an open Tincanban instance.

## Application adoption

- [ ] Add common login to TinSink, then Reflux, preserving existing supported entry points and product-owned operator/resource permissions.
- [ ] Integrate Rusty user-facing management where applicable without changing current object-storage authorization or requiring portal sessions for storage operations.
- [ ] Add adjacent sign-in/create actions to Tincanban. Keep immediate local editing; create a profile for the existing local identity; resume device/participant invitation or first publication approval after onboarding; preserve data on cancellation and failed connection.
- [ ] Support the existing-user fresh-profile `.tincanban` export/import route and clearly distinguish it from same-person recovery. Retire ordinary Tincanban identity recovery UI only after replacement works.

## Separate authority and publication changes

- [ ] Implement fresh exact authorization IDs, permanent withdrawal, bounded delegation and causal historical admission without old-rights restoration.
- [ ] Introduce scoped Rusty generation continuity and current authorization checks for newly created scopes. Preserve independent owners and offline-owner participant access.
- [ ] Persist publication intent, exact approved projection and verified receipt independently of copy availability. Prevent missing-copy auto-publication and stale withdrawal reversal.

## Acceptance

- [ ] Start behavior changes with the capability scenarios; demonstrate intended logic-test failure before implementation. Run isolated browser checks after implementation and the required project checks.
- [ ] Verify content export/import into fresh boards and same-person recovery independently. Verify failed or cancelled flows retain original data and permissions are never inferred from import or login.
- [ ] Complete personal user verification before marking delivery complete. Do not bundle deployment, publishing or destructive cleanup into implementation.
