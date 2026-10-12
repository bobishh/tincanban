---------------- MODULE ScopeShutdown ----------------
EXTENDS TLC
CONSTANTS SelfDrain, LockDrain
VARIABLES receiver, revoker, lock, closing, freed
vars == <<receiver, revoker, lock, closing, freed>>
Init == /\ receiver = "queued" /\ revoker = "idle" /\ lock = "none"
        /\ closing = FALSE /\ freed = FALSE
BeginReceive ==
  /\ receiver = "queued" /\ lock = "none" /\ ~closing
  /\ receiver' = "control" /\ lock' = "receiver"
  /\ UNCHANGED <<revoker, closing, freed>>
ReceiveEviction ==
  /\ receiver = "control" /\ closing' = TRUE
  /\ receiver' = IF SelfDrain THEN "wait-drain" ELSE "done"
  /\ lock' = "none" /\ UNCHANGED <<revoker, freed>>
BeginRevoke ==
  /\ revoker = "idle" /\ lock = "none" /\ receiver = "queued"
  /\ revoker' = "holding" /\ lock' = "revoker"
  /\ UNCHANGED <<receiver, closing, freed>>
RevokeEviction ==
  /\ revoker = "holding" /\ closing' = TRUE
  /\ revoker' = IF LockDrain THEN "wait-drain" ELSE "done"
  /\ lock' = IF LockDrain THEN "revoker" ELSE "none"
  /\ UNCHANGED <<receiver, freed>>
FinishQueued ==
  /\ closing /\ receiver = "queued" /\ lock = "none"
  /\ receiver' = "done" /\ UNCHANGED <<revoker, lock, closing, freed>>
Drain ==
  /\ closing /\ receiver = "done" /\ ~freed /\ freed' = TRUE
  /\ revoker' = IF revoker = "wait-drain" THEN "done" ELSE revoker
  /\ lock' = "none" /\ UNCHANGED <<receiver, closing>>
Next == BeginReceive \/ ReceiveEviction \/ BeginRevoke \/ RevokeEviction \/ FinishQueued \/ Drain
TypeOK == /\ receiver \in {"queued", "control", "wait-drain", "done"}
          /\ revoker \in {"idle", "holding", "wait-drain", "done"}
          /\ lock \in {"none", "receiver", "revoker"} /\ closing \in BOOLEAN /\ freed \in BOOLEAN
Spec == Init /\ [][Next]_vars /\ WF_vars(ReceiveEviction) /\ WF_vars(RevokeEviction)
        /\ WF_vars(FinishQueued) /\ WF_vars(Drain)
FreeAfterReceive == freed => receiver = "done"
ShutdownEventuallyDrains == closing ~> freed
=========================================================
