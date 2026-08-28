------------------------- MODULE TuiSessionReplacement -------------------------
(***************************************************************************)
(* TUI-side session replacement across AgentSessionRuntime, daemon-attach, *)
(* and InteractiveMode. The daemon broker's internal ownership machine is  *)
(* modeled by the abstract "server reservation" and "preacquired target" *)
(* preparation kinds; LeaseBroker.tla checks those broker transitions.     *)
(*                                                                         *)
(* The important cross-layer order is:                                    *)
(*                                                                         *)
(*   prepare stable target -> reopen authoritative bytes -> invalidate     *)
(*   source/stage target -> commit exact connection generation -> publish  *)
(*   -> recover durable input -> activate relay ingress                    *)
(*                                                                         *)
(* A connection generation change before commit invalidates a connected   *)
(* preparation. An offline preparation may commit only while still        *)
(* offline. Failure before source invalidation rolls back; failure after   *)
(* invalidation disposes the partial target.                               *)
(*                                                                         *)
(* Set AllowDeferredAcquisition = TRUE to model the reviewed implementation*)
(* that committed selected-session state after a connection change and    *)
(* deferred target acquisition until activation. The deferred config      *)
(* produces a ConnectedRecoveryHasTargetLease counterexample.              *)
(***************************************************************************)

EXTENDS TLC

CONSTANT AllowDeferredAcquisition
ASSUME AllowDeferredAcquisition \in BOOLEAN

Phases == {
    "source", "prepared", "reopened", "invalidated", "committed",
    "published", "recovered", "active", "rolled_back", "disposed"
}
Connections == {"offline", "connected", "changed"}
Preparations == {"none", "server_reservation", "preacquired_target", "offline"}
TargetRuntimes == {"none", "staged", "published", "terminal"}
TerminalPhases == {"active", "rolled_back", "disposed"}
PendingPhases == {
    "prepared", "reopened", "invalidated", "committed", "published", "recovered"
}

VARIABLES
    phase,
    connection,
    preparation,
    targetStable,
    reopened,
    reopenWasStable,
    sourceUsable,
    targetRuntime,
    targetLease,
    commitGenerationCurrent,
    recoveryStarted,
    ingressOpen,
    settled

vars == <<
    phase, connection, preparation, targetStable, reopened, reopenWasStable,
    sourceUsable, targetRuntime, targetLease, commitGenerationCurrent,
    recoveryStarted, ingressOpen, settled
>>

TypeOK ==
    /\ phase \in Phases
    /\ connection \in Connections
    /\ preparation \in Preparations
    /\ targetStable \in BOOLEAN
    /\ reopened \in BOOLEAN
    /\ reopenWasStable \in BOOLEAN
    /\ sourceUsable \in BOOLEAN
    /\ targetRuntime \in TargetRuntimes
    /\ targetLease \in BOOLEAN
    /\ commitGenerationCurrent \in BOOLEAN
    /\ recoveryStarted \in BOOLEAN
    /\ ingressOpen \in BOOLEAN
    /\ settled \in BOOLEAN

Init ==
    /\ phase = "source"
    /\ connection \in {"offline", "connected"}
    /\ preparation = "none"
    /\ targetStable = FALSE
    /\ reopened = FALSE
    /\ reopenWasStable = FALSE
    /\ sourceUsable = TRUE
    /\ targetRuntime = "none"
    /\ targetLease = FALSE
    /\ commitGenerationCurrent = FALSE
    /\ recoveryStarted = FALSE
    /\ ingressOpen = FALSE
    /\ settled = FALSE

PrepareServerReservation ==
    /\ phase = "source"
    /\ connection = "connected"
    /\ phase' = "prepared"
    /\ preparation' = "server_reservation"
    /\ targetStable' = TRUE
    /\ UNCHANGED << connection, reopened, reopenWasStable, sourceUsable,
                    targetRuntime, targetLease, commitGenerationCurrent,
                    recoveryStarted, ingressOpen, settled >>

PreparePreacquiredTarget ==
    /\ phase = "source"
    /\ connection = "connected"
    /\ phase' = "prepared"
    /\ preparation' = "preacquired_target"
    /\ targetStable' = TRUE
    /\ targetLease' = TRUE
    /\ UNCHANGED << connection, reopened, reopenWasStable, sourceUsable,
                    targetRuntime, commitGenerationCurrent, recoveryStarted,
                    ingressOpen, settled >>

PrepareOffline ==
    /\ phase = "source"
    /\ connection = "offline"
    /\ phase' = "prepared"
    /\ preparation' = "offline"
    /\ targetStable' = TRUE
    /\ UNCHANGED << connection, reopened, reopenWasStable, sourceUsable,
                    targetRuntime, targetLease, commitGenerationCurrent,
                    recoveryStarted, ingressOpen, settled >>

ReopenTarget ==
    /\ phase = "prepared"
    /\ targetStable
    /\ phase' = "reopened"
    /\ reopened' = TRUE
    /\ reopenWasStable' = TRUE
    /\ UNCHANGED << connection, preparation, targetStable, sourceUsable,
                    targetRuntime, targetLease, commitGenerationCurrent,
                    recoveryStarted, ingressOpen, settled >>

ConnectionLostBeforeCommit ==
    /\ phase \in {"prepared", "reopened", "invalidated"}
    /\ connection = "connected"
    /\ connection' = "offline"
    /\ targetStable' = FALSE
    /\ targetLease' = FALSE
    /\ UNCHANGED << phase, preparation, reopened, reopenWasStable, sourceUsable,
                    targetRuntime, commitGenerationCurrent, recoveryStarted,
                    ingressOpen, settled >>

ReconnectBeforeCommit ==
    /\ phase \in {"prepared", "reopened", "invalidated"}
    /\ connection = "offline"
    /\ connection' = "changed"
    /\ targetStable' = FALSE
    /\ targetLease' = FALSE
    /\ UNCHANGED << phase, preparation, reopened, reopenWasStable, sourceUsable,
                    targetRuntime, commitGenerationCurrent, recoveryStarted,
                    ingressOpen, settled >>

InvalidateSource ==
    /\ phase = "reopened"
    /\ phase' = "invalidated"
    /\ sourceUsable' = FALSE
    /\ targetRuntime' = "staged"
    /\ UNCHANGED << connection, preparation, targetStable, reopened,
                    reopenWasStable, targetLease, commitGenerationCurrent,
                    recoveryStarted, ingressOpen, settled >>

PreparedGenerationIsCurrent ==
    \/ /\ preparation \in {"server_reservation", "preacquired_target"}
       /\ connection = "connected"
       /\ targetStable
    \/ /\ preparation = "offline"
       /\ connection = "offline"

CommitCurrentGeneration ==
    /\ phase = "invalidated"
    /\ PreparedGenerationIsCurrent
    /\ phase' = "committed"
    /\ commitGenerationCurrent' = TRUE
    /\ targetLease' = IF connection = "connected" THEN TRUE ELSE targetLease
    /\ UNCHANGED << connection, preparation, targetStable, reopened,
                    reopenWasStable, sourceUsable, targetRuntime,
                    recoveryStarted, ingressOpen, settled >>

CommitWithDeferredAcquisition ==
    /\ AllowDeferredAcquisition
    /\ phase = "invalidated"
    /\ ~PreparedGenerationIsCurrent
    /\ phase' = "committed"
    /\ commitGenerationCurrent' = FALSE
    /\ UNCHANGED << connection, preparation, targetStable, reopened,
                    reopenWasStable, sourceUsable, targetRuntime, targetLease,
                    recoveryStarted, ingressOpen, settled >>

PublishTarget ==
    /\ phase = "committed"
    /\ phase' = "published"
    /\ targetRuntime' = "published"
    /\ UNCHANGED << connection, preparation, targetStable, reopened,
                    reopenWasStable, sourceUsable, targetLease,
                    commitGenerationCurrent, recoveryStarted, ingressOpen, settled >>

RecoverDurableInput ==
    /\ phase = "published"
    /\ phase' = "recovered"
    /\ recoveryStarted' = TRUE
    /\ UNCHANGED << connection, preparation, targetStable, reopened,
                    reopenWasStable, sourceUsable, targetRuntime, targetLease,
                    commitGenerationCurrent, ingressOpen, settled >>

ActivateRelayIngress ==
    /\ phase = "recovered"
    /\ phase' = "active"
    /\ ingressOpen' = TRUE
    /\ settled' = TRUE
    /\ UNCHANGED << connection, preparation, targetStable, reopened,
                    reopenWasStable, sourceUsable, targetRuntime, targetLease,
                    commitGenerationCurrent, recoveryStarted >>

RollbackBeforeInvalidation ==
    /\ phase \in {"prepared", "reopened"}
    /\ phase' = "rolled_back"
    /\ sourceUsable' = TRUE
    /\ targetRuntime' = "none"
    /\ targetLease' = FALSE
    /\ settled' = TRUE
    /\ UNCHANGED << connection, preparation, targetStable, reopened,
                    reopenWasStable, commitGenerationCurrent, recoveryStarted,
                    ingressOpen >>

DisposeAfterInvalidation ==
    /\ phase \in {"invalidated", "committed", "published", "recovered"}
    /\ phase' = "disposed"
    /\ sourceUsable' = FALSE
    /\ targetRuntime' = "terminal"
    /\ targetLease' = FALSE
    /\ ingressOpen' = FALSE
    /\ settled' = TRUE
    /\ UNCHANGED << connection, preparation, targetStable, reopened,
                    reopenWasStable, commitGenerationCurrent, recoveryStarted >>

Progress ==
    \/ PrepareServerReservation
    \/ PreparePreacquiredTarget
    \/ PrepareOffline
    \/ ReopenTarget
    \/ InvalidateSource
    \/ CommitCurrentGeneration
    \/ CommitWithDeferredAcquisition
    \/ PublishTarget
    \/ RecoverDurableInput
    \/ ActivateRelayIngress
    \/ RollbackBeforeInvalidation
    \/ DisposeAfterInvalidation

Next ==
    \/ Progress
    \/ ConnectionLostBeforeCommit
    \/ ReconnectBeforeCommit

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(Progress)

ConnectedRecoveryHasTargetLease ==
    (recoveryStarted /\ phase \in {"recovered", "active"} /\ connection # "offline") => targetLease

RelayIngressRequiresPublishedTarget ==
    ingressOpen =>
        /\ targetRuntime = "published"
        /\ recoveryStarted
        /\ settled

ReopenFollowsTargetStability ==
    reopened => reopenWasStable

StaleConnectionCannotCommit ==
    (phase \in {"committed", "published", "recovered", "active"}) => commitGenerationCurrent

PreInvalidationFailureRetainsSource ==
    (phase = "rolled_back") => sourceUsable

PostInvalidationFailureIsTerminal ==
    (phase = "disposed") =>
        /\ ~sourceUsable
        /\ targetRuntime = "terminal"
        /\ ~ingressOpen
        /\ settled

PreparedHandoffEventuallySettles ==
    (phase \in PendingPhases) ~> settled

=============================================================================
