# New Manatee state machine

This repo contains documentation and initial implementation pieces of the new
Manatee state machine.

## Introduction

This document attempts to describe the upcoming Manatee changes relatively
formally to help us understand the various cases that need to be considered for
the implementation.

Recall that Manatee is a cluster of three or more postgres instances such that:

* One member of the cluster, the *primary*, serves all reads and writes
* The primary uses synchronous replication to a postgres instance called the
  *sync peer*, meaning that transactions are not committed to the client until
  they've been committed to the sync's transaction log
* Attached to the synchronous peer is a daisy chain of one or more *async
  peers*, which replicate changes from the previous link in the chain.  They're
  asynchronous because it's not necessary for this replication to complete
  before transactions are committed.
* If possible, the system automatically reconfigures itself after any
  combination of failures (of peers, the ZK cluster, or the underlying network)
  to maximize uptime and to never lose data.

Any configuration of three or more peers can use the algorithm described here.
Manatee can be operated in single-peer mode, but that's uninteresting because it
cannot survive any failures and the state machine is trivial: always behave as
primary.  Two-peer mode is analogous to two manatee nodes with no async (a
degraded state).  Operationally this mode does not make sense with this
algorithm since it will never failover (the sync will never attempt a takeover
without an async).

There are two state machines here.  There's an overall cluster state, which is
ultimately "unavailable", "read-only", or "read-write", and has an additional
property of "requires operator attention" (which can be true even when
read-write).  This is ultimately what we care about.  But being a distributed
system, this state machine is actually determined by a different state machine
executed independently by each peer.  The point is to design the individual
state machine such that the resulting cluster state machine does what we want
(maximizes availability without ever losing data).


## Cluster state

In this model, *all* state related to the configuration of the cluster is stored
inside ZooKeeper.  There are two kinds of state stored in ZooKeeper:

**Ephemeral state**: when each node establishes its ZK session, it creates an
ephemeral node that identifies itself.  These nodes are implicitly ordered by
ZK.  When the node's session is expired by ZK (e.g., as a result of prolonged
disconnection), the ephemeral node is removed, and all peers with established
ZK sessions are notified.  In implementation, this means that for each manatee
cluster, there will be a single directory containing the ephemeral nodes for
each peer.  These nodes are created when each peer's session is established, and
node's will watch this directory to be notified of peers coming and going.

**Cluster state**: the cluster state is a single, non-ephemeral object whose
contents are a JSON object that includes:

* **G**, a generation number
* **P**, the hostname (or other identifier) for the current primary peer
* **S**, the hostname (or other identifier) for the current sync peer.  Note
  that this is the peer *assigned* to be the sync, but in general it may not
  be caught up to the primary (P) when the generation begins.
* **A[]**, an ordered list of async peers, where the order defines the
  replication order
* **init_wal**, the current position (a monotonically increasing integer) in P's
  WAL when the current generation began

Notes on cluster state:

* The cluster moves atomically from one generation to the next, though obviously
  not all peers discover the change atomically.
* When a new generation is **declared**, the primary for that generation writes
  out a complete cluster state that contains G, P, S, A[], and init\_wal.  All
  of these fields except for "A[]" will be immutable for the duration of this
  generation.
* The first generation is declared when there is no previous generation and there
  are at least two peers' ephemeral nodes present.  This generation is declared
  by the peer whose ephemeral node is "first" according to ZK.  The ordering
  here doesn't matter, since all peers are equivalent at this point.
* Subsequent generations may be declared in exactly two situations:
    * The primary for generation G may declare a new generation G+1 if it
      determines that S has failed (because S's ephemeral node disappears) *and*
      at least one async from A[] is still present.  P will select a new S from
      the head of A[] and declare a new generation.  If the old S comes back, it
      will see that it is no longer S.
    * The secondary for generation G may declare a new generation G+1 if it
      determines that P has failed (because P's ephemeral node disappears) *and*
      at least one async from A[] is still present *and* its own WAL log
      position is at least as large as "init_wal".  If S's WAL position is less
      than "init_wal", then S was never fully caught up to P and the system
      cannot proceed until P returns or an operator intervenes.
* When a generation is initially declared, S is usually not yet caught up to P.
  The cluster may be made available read-only, but it's not until S establishes
  synchronous replication and fully catches up to P that the cluster can be made
  available read-write.

As a result of these rules, we can say that:

* Exactly one peer will successfully write the initial cluster state.
* In generation G, the only peer that can write a new cluster state G+1 is the
  primary assigned for G+1.  The only two nodes that could attempt to do this
  are the P or S from generation G.  It would be extremely unlikely for them to
  do this at the same time, since both of them will only do this when
  determining that the other's ZK session has expired, but we will use a
  test-and-set operation to make sure that only one of them can successfully do
  this.
* Additionally, every new generation of cluster state includes a valid
  assignment of P, S, and A[] such that:
    * P can replicate to S
    * S can replicate to A0
    * Ai can replicate to A(i+1)
  which also means that P is at least as far ahead as any other peer, which
  means that we never lose data.

## Algorithm overview

<img src="manatee.png">


## Algorithm

1. On startup, connect to the ZK cluster, establish a session, and create the
   ephemeral node that represents this peer.  Set a watch on the cluster state
   object.
2. If at any point the ZK session expires, go back to step 1.
3. If at any point the cluster state changes, reread it.  If G has changed, go
   back to step 1.
4. Read the current cluster state.
    1. If there is no current state, then the cluster has never been set up yet.
        1.  If there are other ephemeral nodes in the cluster, and our ephemeral
            node is the first one according to the ZK-defined order, then go to
            "Declaring a generation" below.
        2. Otherwise, wait a few seconds and go to step 1.
    2. If the current state indicates that we are the primary, then go to
       "Assume the role of primary" below.
    3. If the current state indicates that we are the sync, then go to "Assume
       the role of sync" below.
    4. If the current state indicates that we are an async, then go to "Assume
       the role of async" below.
    5. Otherwise, we must be a newly-provisioned node.  We will become an async,
       but we will wait for the current primary to assign our upstream.  Wait a
       few seconds and go to step 1.


### Declaring a generation

A new generation is declared in one of three cases:

* during initial cluster setup (when there's no cluster state), by the peer with
  the lowest-numbered ephemeral node, when there's at least one other peer
  present;
* when a sync S in generation G declares that P has failed, and S has caught up
  to where P was at the start of generation G, and there's another async A0
  available to become the new S;
* when a primary P in generation G declares that S has failed and selects an
  async A0 to become the new S

In all of these cases, the generation is declared by the node that will be P in
the new generation, and it only does so when there's a node present that can be
assigned as S.  As a result, the new cluster state is derived as:

* **G**: one more than the previous generation
* **P**: the peer declaring the new generation
* **S**: at initial setup, this is any other available node.  Afterwards, this
  is A0, the first async peer.
* **A**: the ordered list from the previous generation with A0 (the head of the
  list) removed
* **init_wal**: the current position in P's WAL

This state is written with a test-and-set operation over the original state.  If
that fails, go to step 1 of the algorithm above.  If this operation succeeds,
proceed to "Assume the role of primary" below.

### Assume the role of primary

1. Start postgres as primary, meaning that it's configured for synchronous
   replication.  When postgres starts, it will become read-only.
2. Wait for the synchronous peer to attach.  When it attaches and catches up,
   postgres will become read-write.
3. If it's detected that G has changed (which can only happen if S has declared
   a new generation), stop postgres and proceed to step 1 in the main algorithm
   above.  This will likely require a rollback, which is currently a manual
   step.
4. If S's ephemeral node goes away, declare a new generation (see above).


### Assume the role of secondary

1. Start postgres as the secondary, meaning that it's configured for async
   replication, and it's configured to replicate synchronously from the primary.
   When postgres starts, it will connect to the primary and begin replication.
2. When replication catches up to the primary, postgres on the primary will
   become read-write (see above).
3. If it's detected that G has changed (which can only happen if P has declared
   a new generation), stop postgres and proceed to step 1 in the main algorithm
   above.
4. If P's ephemeral node goes away, declare a new generation (see above).


### Assume the role of async

1. Find our entry in the list A[] of async peers.  The previous entry (or S, if
   we're the first entry in A[]) is our upstream source.  Begin replicating from
   the upstream source.
2. If A[] changes, then go to step 1.
3. If G changes, then go to step 1 in the main algorithm above.


### Async peer management

The primary has to maintain the list of async peers, and it must try to avoid
shuffling the order, since the reversal of two peers in this list will break
replication down the chain and requires rolling back changes on one of them in
order to resume replication.

When a new async joins, it creates its ephemeral node.  When the primary sees
that, it appends the async to A[] in the cluster state.  When the async sees
that, it begins replicating from the previous A, or from S if it's at the head
of A[].  If the async goes away, the primary removes it from A[].  The peer
behind the peer that failed must notice this and begin replicating from the next
upstream peer.


## ZK sessions

From each peer's perspective, the only events related to ZK are:

* **connected**/**disconnected**: These are both nops.  ZK is based around
  sessions to avoid transient TCP failures triggering cluster reconfigurations.
* **session established**: Client should re-read cluster state and proceed as
  during initial startup.
* **session expired**: Client should attempt to establish a new session (and
  then see "session established").
* **client timeout** (client has failed to heartbeat in too long): This is a
  nop.  It will eventually result in a session expiration or a normal
  reconnection.
