# Manatee Using Only Ephemeral Nodes

***Update:***: The current version of Manatee actually does use persistent ZK
state to make decisions.  So parts of this document are incorrect.  The exercise
is still useful, though.

When assessing different options for fixing Manatee, one consideration was
whether we should store persistent data in Zookeeper (zk).  The current version
of Manatee uses only ephemeral nodes in zk + state that each Manatee knows when
reconfiguring a Manatee cluster.  In SDC today, the only place persistent data
is kept is the SDC config stored on the Headnode and Manatee.  In Manta data is
only persisted in Manatee and on storage nodes.  Ideally for SDC and Manta, we
don't want to introduce another system with persistent data.  In going with a
solution using non-ephemeral nodes, we'd be giving up the ability to completely
lose zk.

It may help the reader to understand how Manatee is broken today.  Shards
typically have three databases, arranged as primary, synchronous slave (sync)
and asynchronous slave (async) in a replication chain. This topology is managed
by Zookeeper. Zookeeper is a system for strongly consistent data. When a primary
"fails" (we'll get to what that means later), Manatee will reconfigure the
remaining databases into a new topology (sync becomes primary, async becomes
sync). The way Zookeeper determines which is primary, sync and async is the
order in which those dbs connect to Zookeeper. The dbs then send regular
heartbeats back to Zookeeper. Zookeeper detects failure when the servers fail to
send heartbeats.

Normal synchronous writes follow this pattern:

1. Primary writes transaction to log
2. Log is streamed to sync
3. Sync writes transaction log
4. Sync acks to primary
5. Primary commits transaction

If the cluster is reconfiguring itself and Postgres hasn't finished flushing
transactions from the primary to the sync, the cluster may enter an error state.
In the above example, it would be a reconfiguration during step 2 and the async
joins Zookeeper before the primary does (promoting the sync to primary). If the
sync becomes primary, there's a divergence in the transaction log, causing
reconfiguration of the shard to fail and the shard goes into error mode.

The question is can Manatee be made to work without persisting data in zk (i.e.
using persistent rather than ephemeral nodes).

# Can it Work?

The constraints on the problem are:

1. State can only be kept on the Manatees and as ephemeral nodes in zk.
1. Manatee clusters can have any number of nodes.
1. Given any single failures or partitions, Manatee must eventually converge
   to data-write.
1. Only a fully caught up sync can be promoted to primary.
1. Postgres X-logs can only diverge when a sync has promoted itself to primary.
1. Data must always be consistent.

# State

## On-host Cookies

What goes in zk ephemeral nodes can only come from what each of the Manatees
"know".  Since we know it is unsafe to reconfigure a Manatee cluster based only
on the order of arrival (see the introduction), we have to rely on some pieces
of state persisted on disk.  Today Manatee uses a "sync_state_cookie" that
has the role and the last recognized upstream.  After multiple iterations of
trying to make an algorithm work, these are the pieces of state that go into
a cookie:

1. ***G*** - The last recognized generation of the Manatee cluster (how many
   times the leader has changed).
2. ***S*** - The last state, one of primary (P), sync (S), pending sync (S'),
   or async (A).
3. ***U*** - The previous upstream peer.
4. ***I*** - The IP address of this Manatee.
5. ***Z*** - The zonename of this Manatee.

## Ephemeral Nodes

When a Manatee instance comes online it reads the cookie and sets it as an
ephemeral node in zk.

# Why this doesn't work

The crux is that under certain conditions it is impossible for a previous
primary to know that the sync has promoted itself and taken writes, causing
split brain and violating data consistency guarantees.  In the following example
there are 3 datacenters (DC 1, 2, 3).  There is a set of 5 zookeeper nodes (o),
and a set of 4 Manatees, designated by letters (A-D).  Each Manatee has a state
(p for primary, s for sync, a for async), replicated transaction log position
(@#).  Transaction log divergences are designated by (').  Network partitons are
designated with (|).

For example:
```
Ba@5   => Manatee B is an async at xlog position 5
Cp@10' => Manatee C is a primary at diverged position 10
```

Here is the initial configuration:
```
  DC 1     DC 2     DC 3
  ----     ----     ----
  Bs@8     Da@6     Ap@10
  Ca@7

  oo       o        oo
```

All hosts are currently replicating, and the primary is taking writes.  The
primary has some outstanding requests written to its xlog, but the sync hasn't
written and acked them yet (meaning they can be lost since they haven't been
acked to the client).  Both asyncs are a little behind their upstreams as well
(this is normal).  Suddenly the network goes bad and DC 3 is partioned:
```
  DC 1     DC 2  |  DC 3
  ----     ----  |  ----
  Bs@8     Da@6  |  Ap@10
  Ca@7           |
                 |
  oo       o     |  oo
```

Since there are a sufficient number of zk nodes to form a quorum and the sync
was "up to date", B takes over as primary, C is chosen as sync and B starts
taking writes.  The network is still flaky, though, so D isn't able to notice
that B has taken over as primary, and tries in vain to keep slaving from C:
```
  DC 1     DC 2  |  DC 3
  ----     ----  |  ----
  Bp@9'    Da@6  |  Ap@10
  Cs@8'          |
                 |
  oo       o     |  oo
```

The network partition then flips:
```
  DC 1  |  DC 2     DC 3
  ----  |  ----     ----
  Bp@9' |  Da@6     Ap@10
  Cs@8' |
        |
  oo    |  o        oo
```

Since there are a sufficient number of zk nodes to form a quorum, the old
primary catches D up, D can become sync because its xlog never diverged, and A
starts taking writes again:
```
  DC 1  |  DC 2     DC 3
  ----  |  ----     ----
  Bp@9' |  Da@11     Ap@12
  Cs@8' |
        |
  oo    |  o        oo
```

Once the network partition goes away B will see that there is a new primary, but
the xlogs have diverged, meaning that data consistency is violated.  Clients
attempting to read data that was written to B will not be found.

# Fin

While a very contrived example, it shows that any old primary must somehow find
out that it has been declared "dead" or there is a possibility of split-brain.
The root of why this won't work is because the old primary should never be
allowed to accept writes after the sync has been promoted.  This is a classic
consensus problem (a quorum of something needs to record that the sync is
ascending before it can), and requires persistent data.  This could be done in a
couple ways:

1. Use an embedded consensus engine (paxos, raft, etc) between the Manatees to
   record and propagate cluster configuration.
2. Use an external consensus service (zk, etc).

We'll almost certainly go with #2 since we don't have #1 and zk is already a
part of SDC and Manta.
