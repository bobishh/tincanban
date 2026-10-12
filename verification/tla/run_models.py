#!/usr/bin/env python3
"""Check safety, fair liveness, and specifically expected counterexamples."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile

MODELS = [
    ("GossipTimerShutdown", "GossipTimerShutdown", None),
    ("GossipTimerShutdownRejectsQueued", "GossipTimerShutdown", "Invariant TimerCancellationIsSilent is violated"),
    ("SavedAdmission", "SavedAdmission", None),
    ("SavedAdmissionIgnoresAuthority", "SavedAdmission", "Invariant ReuseRequiresLocalExactAdmission is violated"),
    ("SavedAdmissionIgnoresRace", "SavedAdmission", "Invariant ReadyUsesCurrentContext is violated"),
    ("SavedAdmissionTrustsRemote", "SavedAdmission", "Invariant ReuseRequiresLocalExactAdmission is violated"),
    ("SavedAdmissionPublishesMarker", "SavedAdmission", "Invariant MarkerRenewalIsSilent is violated"),
    ("ScopeShutdown", "ScopeShutdown", None),
    ("ScopeShutdownSelfDrain", "ScopeShutdown", "Temporal properties were violated"),
    ("ScopeShutdownLockDrain", "ScopeShutdown", "Temporal properties were violated"),
    ("WorkspaceFixed", "WorkspaceCommit", None),
    ("WorkspaceBaselineBranches", "WorkspaceCommit", "Invariant SuccessfulCommitRetained is violated"),
    ("WorkspaceBaselineProof", "WorkspaceCommit", "Invariant ProofCoverage is violated"),
    ("WorkspaceBaselineAbort", "WorkspaceCommit", "Invariant AbortedSilent is violated"),
    ("ProofBaselineCount", "ProofTransfer", "Temporal properties were violated"),
    ("ProofBaselineBytes", "ProofTransfer", "Temporal properties were violated"),
    ("ProofPaged", "ProofTransfer", None),
    ("TransportSafety", "DurableTransport", None),
    ("TransportFair", "DurableTransport", None),
    ("TransportUnfair", "DurableTransport", "Temporal properties were violated"),
    ("TransportReconnectOnly", "DurableTransport", "Temporal properties were violated"),
    ("TransportEarlyAck", "DurableTransport", "Invariant AckDurable is violated"),
    ("TransportConnection", "DurableTransport", "Invariant ConnectionImpliesCoverage is violated"),
    ("ItemTransitions", "ItemTransitions", None),
    ("IdentityCatalog", "IdentityCatalog", None),
    ("WorkerLifecycle", "WorkerLifecycle", None),
    ("WorkerLifecycleStaleFatal", "WorkerLifecycle", "Invariant StaleFatalIsolated is violated"),
    ("WorkerLifecycleQueuedTimeout", "WorkerLifecycle", "Invariant QueuedTimeoutIsolated is violated"),
    ("RevocationGeneration", "RevocationGeneration", None),
    ("RevocationGenerationPersonOnly", "RevocationGeneration", "Invariant CompletedRevokeCoversCurrentGrant is violated"),
    ("KeeperIntegrationSettings", "KeeperIntegrationSettings", None),
    ("KeeperIntegrationSettingsNoDualConsent", "KeeperIntegrationSettings", "Invariant ExpansionRequiresTwoApprovals is violated"),
    ("KeeperIntegrationSettingsPersonOnlyCAS", "KeeperIntegrationSettings", "Invariant StaleExpansionRejected is violated"),
    ("KeeperIntegrationSettingsReaddRemoved", "KeeperIntegrationSettings", "Invariant RemovedBoardCannotAutoReadd is violated"),
    ("KeeperGrantRecovery", "KeeperGrantRecovery", None),
    ("KeeperGrantRecoveryTamperedStatus", "KeeperGrantRecovery", None),
    ("KeeperPairingStatusOrdering", "KeeperPairingStatusOrdering", None),
    ("KeeperPairingStatusOrderingIgnoreFence", "KeeperPairingStatusOrdering", "Invariant CommittedProvisionStaysActive is violated"),
    ("KeeperHostInstanceNode", "KeeperHostInstanceNode", None),
    ("KeeperHostInstanceNodeLegacyHost", "KeeperHostInstanceNode", "Invariant AdoptedHostUsesLeasedInstanceKey is violated"),
    ("OwnerRevocationPersistence", "OwnerRevocationPersistence", None),
    ("OwnerRevocationPersistenceNonAtomic", "OwnerRevocationPersistence", "Invariant OwnerAccessSurvivesOtherKeeperRemoval is violated"),
    ("OwnerAuthorityRecovery", "OwnerAuthorityRecovery", None),
    ("OwnerAuthorityRecoveryUnauthorized", "OwnerAuthorityRecovery", "Invariant OnlyCurrentOwnerRepairs is violated"),
    ("OwnerAuthorityRecoveryRevokedDevice", "OwnerAuthorityRecovery", "Invariant OnlyAuthorizedOwnerDeviceRepairs is violated"),
    ("KeeperOrphanResolution", "KeeperOrphanResolution", None),
    ("KeeperOrphanResolutionNoGrant", "KeeperOrphanResolution", None),
    ("KeeperOrphanResolutionNoLocalRevoke", "KeeperOrphanResolution", "Invariant ResolvedHasServiceAndLocalGrantEvidence is violated"),
    ("KeeperOrphanResolutionStaleEpoch", "KeeperOrphanResolution", "Invariant ResolvedHasServiceAndLocalGrantEvidence is violated"),
    ("KeeperOrphanResolutionDismissErases", "KeeperOrphanResolution", "Invariant DismissPreservesOutbox is violated"),
    ("KeeperOrphanResolutionIgnoreCleanupGate", "KeeperOrphanResolution", "Invariant SameTargetStartNeedsCleanupResolution is violated"),
    ("KeeperOrphanResolutionGlobalOutboxGate", "KeeperOrphanResolution", "Invariant OutboxDoesNotBlockDiscovery is violated"),
    ("KeeperOrphanResolutionIgnoreFlowGeneration", "KeeperOrphanResolution", "Invariant DismissHidesRequest is violated"),
    ("KeeperOrphanResolutionResurrectOnReload", "KeeperOrphanResolution", "Invariant DismissHidesRequest is violated"),
    ("ReviewLifecycle", "ReviewLifecycle", None),
    ("ReviewLifecycleDuplicateApply", "ReviewLifecycle", "Invariant AtMostOneAuthorizedCommand is violated"),
    ("ReviewLifecycleDismissErasesHistory", "ReviewLifecycle", "Invariant DismissalPreservesProof is violated"),
    ("ReviewedWorkspaceBootstrap", "ReviewedWorkspaceBootstrap", None),
    ("ReviewedWorkspaceBootstrapRejectsQuarantine", "ReviewedWorkspaceBootstrap", "Invariant ResolvedWorkspaceCanBootstrap is violated"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--java", default=os.environ.get("JAVA", "java"))
    parser.add_argument("--jar", default=os.environ.get("TLC_JAR"))
    parser.add_argument("--logs", type=Path)
    args = parser.parse_args()
    if not args.jar or not Path(args.jar).is_file():
        parser.error("Supply --jar PATH or TLC_JAR pointing to official tla2tools.jar")
    jar = str(Path(args.jar).resolve())
    logs = args.logs or Path(tempfile.mkdtemp(prefix="match-tlc-"))
    logs.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parent
    failed = False
    for config, module, expected in MODELS:
        with tempfile.TemporaryDirectory(prefix="match-tlc-states-") as state_dir:
            result = subprocess.run(
                [args.java, "-XX:+UseParallelGC", "-Xmx1g", "-cp", jar, "tlc2.TLC",
                 "-workers", "1", "-config", f"{config}.cfg", "-metadir", state_dir,
                 f"{module}.tla"],
                cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                timeout=60,
            )
        (logs / f"{config}.log").write_text(result.stdout)
        if expected:
            ok = result.returncode != 0 and f"Error: {expected}" in result.stdout
        else:
            ok = result.returncode == 0 and "Model checking completed. No error has been found." in result.stdout
        counts = re.search(r"(\d+) states generated, (\d+) distinct states found", result.stdout)
        detail = f"{counts[1]} generated / {counts[2]} distinct" if counts else "no state counts"
        outcome = "expected counterexample" if expected else "checked"
        print(f"{'PASS' if ok else 'FAIL'} {config}: {outcome}; {detail}")
        if not ok:
            failed = True
            print(result.stdout[-3000:])
    print(f"Full TLC logs: {logs.resolve()}")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
