---------------- MODULE SavedAdmission ----------------
EXTENDS Naturals, TLC
CONSTANTS IgnoreAuthority, IgnoreRace, TrustRemoteMarker, PublishMarker
Fields == {"raw", "proofs", "authority", "heads", "decisions", "policy"}
InitialContext == [f \in Fields |-> 0]
VARIABLES context, marker, localMarker, stage, checked, reused, trustedReuse, sharedEvents
vars == <<context, marker, localMarker, stage, checked, reused, trustedReuse, sharedEvents>>
Init == /\ context = InitialContext /\ marker = InitialContext /\ localMarker = TRUE
        /\ stage = "idle" /\ checked = InitialContext /\ reused = FALSE
        /\ trustedReuse = FALSE /\ sharedEvents = 0
Modify(f) ==
  /\ stage \in {"idle", "checking", "checked"} /\ context[f] = 0
  /\ context' = [context EXCEPT ![f] = 1]
  /\ UNCHANGED <<marker, localMarker, stage, checked, reused, trustedReuse, sharedEvents>>
RemoteClaim ==
  /\ stage = "idle" /\ context["raw"] = 0
  /\ context' = [context EXCEPT !["raw"] = 1]
  /\ marker' = context' /\ localMarker' = FALSE
  /\ UNCHANGED <<stage, checked, reused, trustedReuse, sharedEvents>>
Start == /\ stage = "idle" /\ stage' = "checking"
         /\ UNCHANGED <<context, marker, localMarker, checked, reused, trustedReuse, sharedEvents>>
MarkerMatches == \A f \in Fields : (IgnoreAuthority /\ f = "authority") \/ marker[f] = context[f]
Check ==
  /\ stage = "checking" /\ stage' = "checked" /\ checked' = context
  /\ reused' = (MarkerMatches /\ (localMarker \/ TrustRemoteMarker))
  /\ trustedReuse' = (localMarker /\ marker = context)
  /\ UNCHANGED <<context, marker, localMarker, sharedEvents>>
Retry ==
  /\ stage = "checked" /\ checked # context /\ ~IgnoreRace /\ stage' = "checking"
  /\ UNCHANGED <<context, marker, localMarker, checked, reused, trustedReuse, sharedEvents>>
Commit ==
  /\ stage = "checked" /\ (checked = context \/ IgnoreRace)
  /\ stage' = "ready" /\ marker' = checked /\ localMarker' = TRUE
  /\ sharedEvents' = IF PublishMarker /\ marker # checked THEN 1 ELSE sharedEvents
  /\ UNCHANGED <<context, checked, reused, trustedReuse>>
Next == (\E f \in Fields : Modify(f)) \/ RemoteClaim \/ Start \/ Check \/ Retry \/ Commit
TypeOK == /\ context \in [Fields -> {0, 1}] /\ marker \in [Fields -> {0, 1}]
          /\ checked \in [Fields -> {0, 1}] /\ stage \in {"idle", "checking", "checked", "ready"}
          /\ localMarker \in BOOLEAN /\ reused \in BOOLEAN /\ trustedReuse \in BOOLEAN
          /\ sharedEvents \in {0, 1}
Spec == Init /\ [][Next]_vars
ReadyUsesCurrentContext == stage = "ready" => checked = context
ReuseRequiresLocalExactAdmission == stage = "ready" /\ reused => trustedReuse
MarkerRenewalIsSilent == sharedEvents = 0
UnchangedReloadDoesNotReplay == stage = "ready" /\ context = InitialContext => reused
=========================================================
