---------------- MODULE GossipTimerShutdown ----------------
EXTENDS TLC
CONSTANT CancelClosedTimer
VARIABLES timer, sendPending, closed, timerRan, unhandled
vars == <<timer, sendPending, closed, timerRan, unhandled>>
Init == /\ timer = "armed" /\ sendPending = TRUE /\ closed = FALSE
        /\ timerRan = FALSE /\ unhandled = FALSE
Tick == /\ timer = "armed" /\ ~closed /\ timer' = "queued"
        /\ UNCHANGED <<sendPending, closed, timerRan, unhandled>>
Close == /\ ~closed /\ closed' = TRUE
         /\ timer' = IF timer = "armed" THEN "cancelled" ELSE timer
         /\ UNCHANGED <<sendPending, timerRan, unhandled>>
FinishSend == /\ sendPending /\ sendPending' = FALSE
              /\ UNCHANGED <<timer, closed, timerRan, unhandled>>
ExecuteTimer ==
  /\ timer = "queued" /\ ~sendPending /\ timer' = "done"
  /\ timerRan' = ~closed
  /\ unhandled' = (closed /\ ~CancelClosedTimer)
  /\ UNCHANGED <<sendPending, closed>>
Next == Tick \/ Close \/ FinishSend \/ ExecuteTimer
Spec == Init /\ [][Next]_vars
TypeOK == /\ timer \in {"armed", "queued", "cancelled", "done"}
          /\ sendPending \in BOOLEAN /\ closed \in BOOLEAN
          /\ timerRan \in BOOLEAN /\ unhandled \in BOOLEAN
TimerCancellationIsSilent == ~unhandled
=========================================================
