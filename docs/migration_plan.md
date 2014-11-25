# We need a migration plan

Manatee and dependent services (moray) work by assuming the leader is the first
node when listing the election path, for example:

```
[zk: localhost:2181(CONNECTED) 20] ls /manatee/1.moray.coal.joyent.us/election
[10.77.77.8:5432:12345-0000000007, 10.77.77.7:5432:12345-0000000006]
```

With the above, 10.77.77.7 is the primary (the sequence number is '6') and
10.77.77.8 is the secondary (the sequence number is 7).  This needs to change
to having each decide on the topology by looking at the /state path, which is
the location of the cluster state json blob.

The migration presents a few problems, the first of which being in the mixed
state situation when some number of Manatees have been upgraded and others have
not.

This doc presents some options for migration, along the following axis:

1. Whether the migration can be done with no downtime over and above the
   necessary number of DB flips.
2. Whether the migration can be done with no manual operator steps.

In an ideal world, we would have a new Manatee be completely compatible with two
other, non-upgraded Manatees.  I think this is a non-goal and we'll need to
strike the right balance between downtime, backward compatibility, and time
spent writing and maintaining migration code.

# How Deployments Work Today

Manatee upgrades are currently done by updating the async, then sync, then
primary.  This causes a brief write outage while the primary hasn't picked up
that the sync is last in line and a read/write outage while the sync waits
to detect that the primary is gone.  It may help to show the different
configurations that occur during "normal" deployments:

```
         Initial  Update-C  Update-B  Update-A
Primary  A        A         A         C'
         |        |         |         |
Sync     B        B         C'        B'
         |        |         |         |
Async    C        C'        B'        A'

Notes   --------------------^
        Small write outage while C' is promoted to Sync

        ------------------------------^
        Read/write outage while A is gone and C' hasn't taken over as master.
```

# A Migration Plan

Knowing how components work today, we can see how old manatees and newly
upgraded manatees can work together.  In order for it to work we need to make
sure that during migration the cluster state accurately reflects the
election ordering.  **As long as election ordering and and cluster state are in
agreement during the whole process, we can safely upgrade components
(Manatees and Morays) independently.**

Walking through the deployment order and the cluster state it can be made to
work if something preemptively puts the [A, C', B'] after updating C'.  Then
this is what a migration deployment would look like:

```
         Init  Update-C  Manual State  Update-B  Update-A  A-rejoins
Primary  A     A         A             A         C'        C'
         |     |         |\            |         |         |
Sync     B     B         B C'          C'        B'        B'
         |                             |                   |
Async    C     C'                      B'                  A'

Notes    ^
         Initial Cluster State

         ------^
         C' is reprovisioned.  The new Manatee sees that the DB is already
         inited, and so stops and waits for a cluster state update.

         ---------------^
         An operator manually writes the topology: [A, C, B], even though that
         is a lie at this point.  C' sees it is the Sync based on the topology.
         It doesn't know any better that B is still the actual sync (and doesn't
         need to).

         -----------------------------^
         B is reprovisioned...
         A sees B drop out, reconfigures C' as sync.
         C' stays where it was.
         B' takes its place where the cluster state says it should.

         ---------------------------------------^
         C' sees that A has failed, writes cluster state [C, B].
         C' is the first in /election, morays connect to C' as primary.
         B' sees the cluster state change, reconfigures itself as sync.

         --------------------------------------------------^
         C' sees that A' has joined, writes [C, B, A]
         A' sees the cluster state change, configures itself as an async.
```

Since replication works by the downstream making a connection to the upstream,
this should work from a topology perspective.  Also note that when C' is
promoted to primary, it is also the "first" entry in the /election, meaning that
new Morays can be deployed at any point after the initial cluster state is
written.

Also, the downtime is no worse that regular deployments.  The important thing
for an operator to do is to make sure they are:

1. Reprovisioned in order.
2. A doesn't fail while in the [A, [B, C']] topology.  If that does happen,
   both B and C' will think they are the primary.  If this does happen, C
   *must* be rolled back since it is an async that believes it is a sync (this
   is dangerous).

# Rollout

1. Something determines that this is a migration, "manually" writes cluster
   state [A, C, B]
2. Deploy C
3. Deploy B
4. Deploy A
5. Deploy new Morays

Note that it is safe to deploy new morays at any time after step 1.  There are
risks in deploying them either too soon or too late.  I've opted for the
later because chances of failure doesn't outweigh the need for "easier"
rollback.

# Rollback

Steps work in reverse from deployment:

1. If step 5 was done, deploy old Morays
2. If step 4 was done, rollback A
3. If step 3 was done, rollback B
4. If step 2 was done, rollback C
5. Delete /state manually from zookeeper

# Appendix

## Backward compatible node-manatee

node-manatee is the repository that Moray uses to connect to Manatee.  It
currently figures out which host is primary by looking at the order of ephemeral
nodes.  This needs to change with the new cluster state zookeeper node.

In order to make node-manatee backward compatible it would need to detect if
the state node is present and, if so, use it.  If it isn't there it would need to
set a watch on the creation and fall back to using the order to determine
which is primary.  If the state creation watch ever fires, it would need to
transition to using that.

Also, for completeness it would need to watch for the deletion of the state
node in case the rollout of new manatees fail.

It is an open question whether we should do this work first and make sure
morays are rolled out before manatees.

## Closed Questions

1. Can we confirm [A, [B, C']] topology work?  Yes, I recreated by setting up a
   3-node manatee cluster, disabling the manatee-sitter on the async, updating
   the async's /manatee/pg/data/recovery.conf to point to the primary, and
   starting up the async "manually" (with
   sudo -u postgres /opt/local/bin/postgres -D /manatee/pg/data).  Then putting
   data into te primary, I could see the data show up on the async.  Also, the
   primary's pg_stat_replication table showed it as an async.
1. Is it safe if morays are attempting to write to an old sync or async?  Will
   those happily accept writes?  Tried by manually hacking a moray instance to
   connect to the sync and then the async.  Both responded with the same error:
   "InternalError: unable to create bucket; caused by error: cannot execute
   INSERT in a read-only transaction" So the answer is "yes", morays talking to
   either an old sync or an old async is safe.
1. Should we attempt to automate putting the preemptive cluster state there by
   a newly deployed C'?  No.
1. Should we make Morays backward compatible (as described above)?  Yes.
1. What should the init_WAL be when initial cluster state is written?  0/0000000
