# Volt live-shared-session — formal (TLA+) specification

## In plain terms

Volt's hardest bugs aren't in any one function — they're in *who owns a
conversation* as it moves between the desktop terminal, the background daemon,
and the phone, and in *what order* things get closed and handed off. Those are
exactly the bugs ordinary tests miss, because they only show up in a specific
interleaving of events across three programs.

This directory holds a formal model of that behavior. A model is a precise,
executable description of the rules; a checker (TLC) then explores **every**
reachable interleaving and reports the first one that breaks a rule. It's a way
to test the *design* exhaustively before trusting it in code.

All six modules are now written and model-checked green with TLC. The suite spans
the daemon, the TUI, and the phone; each module is checkable on its own in seconds
via `./check.sh <Module>`.

> Keep these files beside the RFC (`docs/live-shared-session-daemon-design.md`).
> When the design changes, change the model first, watch the check break, then
> change the code. If they drift, the model stops meaning anything.

---

## Status

| Module | What it covers (plain) | State |
|--------|------------------------|-------|
| **`LeaseBroker`** | Who holds a conversation (daemon vs terminal) and how it hands off. | **Verified green** (40,804 states). `LeaseBroker.tla` / `.cfg` |
| **`TuiSessionReplacement`** | Whether a prepared desktop session replacement keeps lease, disk refresh, recovery, and relay ingress in one safe order. | **Verified green** (68 states, depth 8). `TuiSessionReplacement.tla` / `.cfg` |
| **`RelayViewer`** | The relay token + the "watch the turn finish" viewer feed during a hand-off. | **Verified green** (207,025 states). `RelayViewer.tla` / `.cfg` |
| **`SessionTarget`** | Picking the right session on connect, so a phone never pins the wrong one. | **Verified green** (28 states). `SessionTarget.tla` / `.cfg` |
| **`ClientAuth`** | Pairing, revoking, and re-pairing a phone. | **Verified green** (9,678 states). `ClientAuth.tla` / `.cfg` |
| **`ClientConn`** | The phone's own connect / reconnect / detach / abort behavior. | **Verified green** (176 states). `ClientConn.tla` / `.cfg` |

**Running the checker.** `./check.sh` runs TLC on `LeaseBroker`; pass a module name
to check another model (it auto-downloads `tla2tools.jar` on first run and needs a
JDK 17+ via `JAVA_HOME` or `java` on PATH). The lease baseline has been **verified
green with TLC** at 40,804 distinct states/depth 27. `TuiSessionReplacement` is
green at 68 distinct states/depth 8. See [How to run](#how-to-run).

---

## What we already found

Modeling `LeaseBroker` surfaced **two real issues** in `lease-broker.ts`, each
reproduced by TLC as a concrete trace (both invariants ship in `LeaseBroker.tla`,
off by default so the baseline stays green; add either to the `.cfg` to see it):

**1 — `streamCount` leak (fixed).**
In `runDrain`'s disposal-error recovery (~L388–408), the cancelled branch dropped
the lease to `unowned` but **never zeroed `record.streamCount`** — unlike the
success path (L409). Since `dropIfUnowned` requires `streamCount === 0`, the
record could never be dropped: a leaked `unowned` ghost that handed a phantom
stream count to the next acquirer. TLC trace: `CommitDaemonAttach →
PhoneStreamAttach → RuntimeStartTurn → AcquireDrainStart → DrainRuntimeIdle →
DrainCancelDisposing → DrainDisposeError`, ending in `unowned` with
`streamCount = 1`. **Fixed** in `lease-broker.ts` (zero `streamCount` in that catch
branch) with a regression test; `NoStreamLeak` is now in the baseline `.cfg` so it
stays fixed.

**2 — turn killed on TUI open after the phone walks away (resolved: intended).**
`acquireForTui` only *drains* when the state is `daemon-active` (L296). A turn
keeps running after the last phone detaches (RFC: "the prompt continues on the
host"), leaving a `daemon-detached` runtime that is still mid-turn; opening the TUI
then disposes it, killing that turn instead of draining it. The model surfaced this
(`IdleAcquireOnlyWhenIdle`, TLC trace `RuntimeStartTurn → PhoneStreamDetach →
AcquireIdleFlip`), and the decision came back: **this is intended** — once no
device is receiving the turn there is nothing to watch, so it is abandonable (the
same as closing a TUI mid-turn). Documented in the RFC §4.2 and the
`lease-broker.ts` comment; `IdleAcquireOnlyWhenIdle` stays off in the baseline as a
marker of that deliberate choice.

---

## The `LeaseBroker` module

### The five states (who holds the conversation)

`unowned` · `daemon-active` · `daemon-detached` · `daemon-draining` · `tui-owned`,
keyed on `(workspaceName, sessionId)` — `clientNodeId` is deliberately dropped, so
two phones are the *same* conversation, not two. See the header comment in
`LeaseBroker.tla` for the plain-English description of each.

### The one design decision that makes the check meaningful

The RFC's headline invariant is "one live runtime per conversation, and a daemon
runtime exists **iff** the state is `daemon-*`." The tempting way to model that —
define "runtime alive" as "state is `daemon-*`" — makes the invariant `X ⇔ X`: it
passes while proving nothing. (The first draft did exactly this; the review
caught it.)

The real code flips the lease to `tui-owned` **before** it finishes disposing the
daemon runtime, so there's a genuine window where the lease says `tui-owned`
while the daemon runtime is still alive. That window *is* the split-brain the
invariant is meant to rule out. So the model tracks `runtimeEntry` as an
**independent** variable (set on attach, cleared only when disposal *completes*)
and splits the idle-acquire into `flip → disposeDone / disposeFail`. Now the
window is a reachable state and the invariants can actually fail — which is the
whole point.

### Invariants checked (safety)

Each maps to a real prose invariant or a §4.8 race row. Names match
`LeaseBroker.tla` exactly.

| Invariant | Plain meaning |
|-----------|---------------|
| `OwnershipUnique` (I1) | The daemon runtime and a serving terminal never both exist for one conversation — no split-brain. |
| `RuntimeIffDaemon` (I2) | A daemon runtime exists exactly in the daemon states, plus the brief disposal window. |
| `TuiOwnerWellFormed` (I3a) | A terminal connection is recorded exactly when a terminal holds or is acquiring the lease. |
| `DisposePendingOnlyTui` | The disposal window only exists under `tui-owned`. |
| `RelaysOnlyWhenTui` (I3b) | Relays exist only while a terminal holds the lease. |
| `DrainHasAcquirer` (I4) | A draining conversation always has a waiting acquirer and a live pump. |
| `StreamingCoherent` | A turn only runs while the daemon owns a live runtime. |
| `DrainNoNewTurn` (I6) | Once a hand-off is disposing, no new turn can start (the `lease_draining` rejection). |
| `NoStreamLeak` | a stream count implies a live runtime — guards the finding-1 fix (in the baseline). |
| `IdleAcquireOnlyWhenIdle` | *(off by default)* an idle-acquire never disposes a mid-turn runtime — intentionally does **not** hold; detached turns are abandonable (RFC §4.2). |

### Properties checked (liveness, needs fairness)

| Property | Plain meaning |
|----------|---------------|
| `DrainConverges` (I5) | A hand-off never wedges: a draining conversation always leaves that state. |
| `EventualSettle` (I4) | The acquirer's grant is always settled (granted, cancelled, or errored) — nobody waits forever. |

Both rely on weak fairness on the drain pump, applied **per key** so one
conversation's hand-off can't starve another's. The adversarial branches
(cancel, disposal error) get *no* fairness, so they can't manufacture a fake
liveness violation.

### What the model deliberately simplifies

A turn is a boolean (`runtimeStreaming`) with a nondeterministic end, not
token-by-token streaming. The byte relay is a count, not a pump. Time/TTL is a
fireable event, not a clock. Counts are bounded (`MaxStreams`, `MaxRelays=2`,
`MaxPending=1`) so the state space is finite. These are the standard
abstractions; the ownership logic itself is kept exact.

---

## The `TuiSessionReplacement` module

`TuiSessionReplacement.tla` composes the TUI-visible ownership facts that the
broker-only model deliberately abstracts away: a stable target reservation or
preacquired lease, authoritative disk reopen, source invalidation, target runtime
publication, recovered durable input, and post-lifecycle relay activation.

Its green configuration rejects a connection-generation change before commit.
`TuiSessionReplacement.deferred.cfg` intentionally enables the reviewed behavior
that commits after such a change and defers acquisition; TLC reaches
`ConnectedRecoveryHasTargetLease` in nine steps through prepare, reopen,
disconnect/reconnect, commit, publish, and recovery. Keep the failing config as a
counterexample witness rather than a CI baseline.

Checked safety invariants:

- `ConnectedRecoveryHasTargetLease`
- `RelayIngressRequiresPublishedTarget`
- `ReopenFollowsTargetStability`
- `StaleConnectionCannotCommit`
- `PreInvalidationFailureRetainsSource`
- `PostInvalidationFailureIsTerminal`

`PreparedHandoffEventuallySettles` checks liveness under weak fairness on the
transaction progress action.

---

## How to run

```bash
./check.sh                                # LeaseBroker baseline
./check.sh TuiSessionReplacement          # generation-fenced replacement baseline
./check.sh TuiSessionReplacement TuiSessionReplacement.deferred.cfg  # expected counterexample
./check.sh RelayViewer                    # relay + viewer-feed module
```

`check.sh` needs a JDK 17+ (via `JAVA_HOME` or `java` on PATH). Equivalently, by hand:

```bash
java -XX:+UseParallelGC -jar tla2tools.jar -workers auto \
     -config LeaseBroker.cfg LeaseBroker.tla
```

A clean run prints `Model checking completed. No error has been found.` To see a
bug trace instead, uncomment `NoStreamLeak` in `LeaseBroker.cfg` and re-run: TLC
prints the shortest sequence of states + action names that reaches the leak.

**Reading a counterexample as a Volt bug.** TLC gives you an ordered list of
states with the action name between each. Translate directly: an
`OwnershipUnique` trace ending in `tui-owned ∧ runtimeEntry = TRUE` after an
`AcquireIdleFlip → AcquireIdleDisposeFail` sequence would be a split-brain in the
idle-acquire revert path; a `NoStreamLeak` trace ending after
`AcquireDrainStart → DrainRuntimeIdle → DrainCancelDisposing → DrainDisposeError`
is the stream-count leak, and points at the exact `lease-broker.ts` catch branch.

---

## What a green check does and does not prove

A green run proves that **the model**, at these bounds and abstractions, cannot
reach a state that breaks the listed invariants and satisfies the liveness
properties under the stated fairness. That's strong evidence the *design* of the
hand-off is internally consistent and free of the specific race classes encoded.

It does **not** prove:

- **That the code matches the model.** The TS/Swift isn't generated from the
  spec; a correct model over a buggy implementation still checks green. The spec
  is a design artifact — it found the `streamCount` leak because we modeled the
  code's *intent* and asserted more than the code guarantees, not automatically.
- **Correctness beyond the bounds.** 2 keys / 2 terminals / small counts is
  strong evidence via symmetry and small-model reasoning, not a proof for all N.
- **Anything abstracted away** — byte-level relay framing, real timers, transcript
  content, full async scheduling beyond the modeled windows.
- **Freedom from drift.** The biggest risk is the spec rotting as the RFC and code
  evolve. Cross-reference invariant names both ways (RFC I1–I7 ↔ the names above)
  and re-run whenever a lease / handshake / close-reason change lands.

---

## Build order for the remaining modules

`LeaseBroker` first (done) — it's the spine, and it mints the close reasons
(`lease_transferred`, `session_rekeyed_reconnect`) the others consume.
Then `RelayViewer` (shares the connection-drop trigger; where "lost turn" and
"stuck drain" actually manifest) → `SessionTarget` (small, high value: the
wrong-pin class) → `ClientAuth` (self-contained, security-critical) → `ClientConn`
(largest state space; consumes the close reasons above as inputs). Model one at a
time; only compose `LeaseBroker` + `RelayViewer` once each is green solo.

Full module scope, per-module invariant/property catalogs, and the shared
abstraction strategy live in [`PLAN.md`](PLAN.md).
