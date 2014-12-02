# Performing a Migration

The overall steps to migrating a manatee cluster from using the election as the
topology to using a persisted cluster state as the topology are as follows:

1. Upgrade Morays
1. Reprovision Async
1. Backfill Cluster State (`async$ manatee-adm state-backfill`)
1. Reprovision Sync
1. Unfreeze Cluster State (`async$ manatee-adm unfreeze`)
1. Reprovision Primary

Details for each step are below, specifically things you can check to make sure
your migration is running smoothly.  It is assumed that:

1. You are running a shard with three nodes
2. You are familiar with running the `manatee-adm` command
3. You are familiar with reprovisioning zones
4. You are familiar with where to find logs

## Upgrade Morays

Newer versions of Morays are forward-compatible with either way of determining
topology (either via the `/election` or `/state` path) and can switch between
using either method as the `/state` appears and disappears.  First make sure
that the Morays have been upgraded to a version that is compatible.

To verify:

***TODO***

## Reprovision Async

First take note of your current topology:

```
async$ manatee-adm status | json
```

As an example, this is the topology we'll be using as an example:

```
f29499ea-b50c-431e-9975-e4bf760fb5e1 primary
4afba482-7670-4cfe-b11f-9df7f558106a sync
d0c715ab-1d55-43cd-88f2-f6bfe3960683 async
```

Verify that all members of your shard are up and operational.  Take note of the
topology, specifically which zone is the primary, the sync and the async.
Reprovision the async to a manatee version that uses a persisted state object
for the topology.

When the async zone is provisioned, you can look at the logs and verify that
it thinks it is in 'migration':

```
[2014-12-02T18:27:15.984Z] DEBUG: manatee-sitter/cluster/99642 on d0c715ab-1d55-
43cd-88f2-f6bfe3960683 (/opt/smartdc/manatee/node_modules/manatee/node_modules/m
anatee-state-machine/lib/manatee-peer.js:385 in ManateePeer.evalClusterState): c
luster not yet setup
[2014-12-02T18:27:15.984Z]  INFO: manatee-sitter/cluster/99642 on d0c715ab-1d55-
43cd-88f2-f6bfe3960683 (/opt/smartdc/manatee/node_modules/manatee/node_modules/m
anatee-state-machine/lib/manatee-peer.js:306 in ManateePeer.assumeUnassigned): a
ssuming role (role=unassigned)
```

The newly upgraded async will remain in this state until the cluster state is
backfilled.

## Backfill Cluster State

Run the backfill from the async.  Before accepting the configuration, verify:

1. The primary is listed as the primary
1. The original async is listed as the *sync*
1. The original sync is listed as the *async*
1. That there is a "freeze" member to the configuration.

```
[root@d0c715ab (postgres) ~]$ manatee-adm state-backfill
Computed new cluster state:
{ primary:
   { zoneId: 'f29499ea-b50c-431e-9975-e4bf760fb5e1',
     ip: '10.77.77.47',
     pgUrl: 'tcp://postgres@10.77.77.47:5432/postgres',
     backupUrl: 'http://10.77.77.47:12345',
     id: '10.77.77.47:5432:12345' },
  sync:
   { zoneId: 'd0c715ab-1d55-43cd-88f2-f6bfe3960683',
     ip: '10.77.77.49',
     pgUrl: 'tcp://postgres@10.77.77.49:5432/postgres',
     backupUrl: 'http://10.77.77.49:12345',
     id: '10.77.77.49:5432:12345' },
  async:
   [ { zoneId: '4afba482-7670-4cfe-b11f-9df7f558106a',
       ip: '10.77.77.48',
       pgUrl: 'tcp://postgres@10.77.77.48:5432/postgres',
       backupUrl: 'http://10.77.77.48:12345',
       id: '10.77.77.48:5432:12345' } ],
  generation: 0,
  initWal: '0/0000000',
  freeze:
   { date: '2014-12-02T18:31:35.394Z',
     reason: 'manatee-adm state-backfill' } }
is this correct(y/n)
prompt: yes:  yes
Ok.
```

When you accept the backfill, the original async will reconfigure itself as a
sync to the original primary.  You can see this in the logs of the original
async:

```
[2014-12-02T18:35:38.863Z]  INFO: manatee-sitter/cluster/99642 on d0c715ab-1d55-
43cd-88f2-f6bfe3960683 (/opt/smartdc/manatee/node_modules/manatee/node_modules/m
anatee-state-machine/lib/manatee-peer.js:889): (nretries=0)
    pg: applied config { role: 'sync',
      upstream:
       { zoneId: 'f29499ea-b50c-431e-9975-e4bf760fb5e1',
         ip: '10.77.77.47',
         pgUrl: 'tcp://postgres@10.77.77.47:5432/postgres',
         backupUrl: 'http://10.77.77.47:12345',
         id: '10.77.77.47:5432:12345' },
      downstream: null }
```

The cluster is now in a configuration where the the original sync and async are
both slaving from the original primary.  You can check that the cluster state
is correct by running `async$ manatee-adm state | json`.

Note that since this is a non-standard configuration `manatee-adm status` will
not look like a "healthy" manatee shard from an non-upgraded zone:

```
[root@4afba482 (postgres) ~]$ manatee-adm status | json
{
  "1.moray.coal.joyent.us": {
    "primary": {
      "zoneId": "f29499ea-b50c-431e-9975-e4bf760fb5e1",
      "ip": "10.77.77.47",
      "pgUrl": "tcp://postgres@10.77.77.47:5432/postgres",
      "repl": {
        "pid": 96837,
        "usesysid": 10,
        "usename": "postgres",
        "application_name": "tcp://postgres@10.77.77.48:5432/postgres",
        "client_addr": "10.77.77.48",
        "client_hostname": "",
        "client_port": 45461,
        "backend_start": "2014-12-02T18:08:12.582Z",
        "state": "streaming",
        "sent_location": "0/174A270",
        "write_location": "0/174A270",
        "flush_location": "0/174A270",
        "replay_location": "0/174A270",
        "sync_priority": 1,
        "sync_state": "sync"
      }
    },
    "sync": {
      "zoneId": "4afba482-7670-4cfe-b11f-9df7f558106a",
      "ip": "10.77.77.48",
      "pgUrl": "tcp://postgres@10.77.77.48:5432/postgres",
      "repl": {}
    },
    "async": {
      "zoneId": "d0c715ab-1d55-43cd-88f2-f6bfe3960683",
      "ip": "10.77.77.49",
      "pgUrl": "tcp://postgres@10.77.77.49:5432/postgres",
      "backupUrl": "http://10.77.77.49:12345",
      "repl": {},
      "lag": {
        "time_lag": null
      }
    }
  }
}
```

## Reprovision Sync

Now reprovision the sync to the same version of software that the original async
was upgraded to.  Now that the state has been backfilled, the sync will take its
place as the async, slaving from the original async (now the sync).  You can see
this in the original sync's logs:

```
[2014-12-02T18:47:39.927Z]  INFO: manatee-sitter/cluster/629 on 4afba482-7670-4c
fe-b11f-9df7f558106a (/opt/smartdc/manatee/node_modules/manatee/node_modules/man
atee-state-machine/lib/manatee-peer.js:287 in ManateePeer.assumeAsync): assuming
 role (role=async, which=0)
[2014-12-02T18:47:39.929Z] DEBUG: manatee-sitter/cluster/629 on 4afba482-7670-4c
fe-b11f-9df7f558106a (/opt/smartdc/manatee/node_modules/manatee/node_modules/man
atee-state-machine/lib/manatee-peer.js:837 in pgReconfig):
    pg.reconfigure { role: 'async',
      upstream:
       { zoneId: 'd0c715ab-1d55-43cd-88f2-f6bfe3960683',
         ip: '10.77.77.49',
         pgUrl: 'tcp://postgres@10.77.77.49:5432/postgres',
         backupUrl: 'http://10.77.77.49:12345',
         id: '10.77.77.49:5432:12345' },
      downstream: null }
```

At this point `manatee-adm status should look "normal".  From an upgraded
manatee, the "__FROZEN__" property will be present.  From an older manatee
(only the primary at this point), that property wouldn't exist:

```
[root@d0c715ab (postgres) ~]$ manatee-adm status | json
{
  "1.moray.coal.joyent.us": {
    "__FROZEN__": "2014-12-02T18:31:35.394Z: manatee-adm state-backfill",
    "primary": {
      "zoneId": "f29499ea-b50c-431e-9975-e4bf760fb5e1",
      "ip": "10.77.77.47",
      "pgUrl": "tcp://postgres@10.77.77.47:5432/postgres",
      "backupUrl": "http://10.77.77.47:12345",
      "id": "10.77.77.47:5432:12345",
      "online": true,
      "repl": {
        "pid": 30,
        "usesysid": 10,
        "usename": "postgres",
        "application_name": "tcp://postgres@10.77.77.49:5432/postgres",
        "client_addr": "10.77.77.49",
        "client_hostname": "",
        "client_port": 38457,
        "backend_start": "2014-12-02T18:35:37.928Z",
        "state": "streaming",
        "sent_location": "0/174A438",
        "write_location": "0/174A438",
        "flush_location": "0/174A438",
        "replay_location": "0/174A438",
        "sync_priority": 1,
        "sync_state": "sync"
      }
    },
    "sync": {
      "zoneId": "d0c715ab-1d55-43cd-88f2-f6bfe3960683",
      "ip": "10.77.77.49",
      "pgUrl": "tcp://postgres@10.77.77.49:5432/postgres",
      "backupUrl": "http://10.77.77.49:12345",
      "id": "10.77.77.49:5432:12345",
      "online": true,
      "repl": {
        "pid": 644,
        "usesysid": 10,
        "usename": "postgres",
        "application_name": "tcp://postgres@10.77.77.48:5432/postgres",
        "client_addr": "10.77.77.48",
        "client_hostname": "",
        "client_port": 40786,
        "backend_start": "2014-12-02T18:47:40.335Z",
        "state": "streaming",
        "sent_location": "0/174A438",
        "write_location": "0/174A438",
        "flush_location": "0/174A438",
        "replay_location": "0/174A438",
        "sync_priority": 0,
        "sync_state": "async"
      }
    },
    "async": {
      "zoneId": "4afba482-7670-4cfe-b11f-9df7f558106a",
      "ip": "10.77.77.48",
      "pgUrl": "tcp://postgres@10.77.77.48:5432/postgres",
      "backupUrl": "http://10.77.77.48:12345",
      "id": "10.77.77.48:5432:12345",
      "online": true,
      "repl": {},
      "lag": {
        "time_lag": null
      }
    }
  }
}
```

## Unfreeze Cluster State

Unfreezing the cluster state allows the new sync to take over as the primary
when the primary is reprovisioned.  This is done by:

```
async$ manatee-adm unfreeze
```

If you forget this step, when the primary is reprovisioned the sync will emit
warnings that it should have taken over, but couldn't due to the cluster being
frozen.  For example:

```
[2014-12-02T19:00:24.173Z] DEBUG: manatee-sitter/cluster/99642 on d0c715ab-1d55-
43cd-88f2-f6bfe3960683 (/opt/smartdc/manatee/node_modules/manatee/node_modules/m
anatee-state-machine/lib/manatee-peer.js:576 in ManateePeer.startTakeover): prep
aring for new generation (primary gone)
[2014-12-02T19:00:24.173Z]  WARN: manatee-sitter/cluster/99642 on d0c715ab-1d55-
43cd-88f2-f6bfe3960683 (/opt/smartdc/manatee/node_modules/manatee/node_modules/m
anatee-state-machine/lib/manatee-peer.js:673): backing off
    ClusterFrozenError: cluster is frozen
        at Array.takeoverCheckFrozen [as 0] (/opt/smartdc/manatee/node_modules/m
        at Object.waterfall (/opt/smartdc/manatee/node_modules/manatee/node_modu
        at ManateePeer.startTakeover (/opt/smartdc/manatee/node_modules/manatee/
        at ManateePeer.evalClusterState (/opt/smartdc/manatee/node_modules/manat
        at null._onTimeout (/opt/smartdc/manatee/node_modules/manatee/node_modul
        at Timer.listOnTimeout [as ontimeout] (timers.js:110:15)
```

## Reprovision Primary

Now reprovision the primary.  At this point one of two things will happen.  If
the reprovision tool longer than the zookeeper node timeout, the sync will take
over.  If the primary reprovisioned before the timeout, the primary will remain
the primary.  In our case, the reprovision took longer, so we can see the
original async taking over as the primary:

```
[2014-12-02T19:01:52.451Z]  INFO: manatee-sitter/cluster/99642 on d0c715ab-1d55-
43cd-88f2-f6bfe3960683 (/opt/smartdc/manatee/node_modules/manatee/node_modules/m
anatee-state-machine/lib/manatee-peer.js:693): declared new generation
[2014-12-02T19:01:52.451Z]  INFO: manatee-sitter/cluster/99642 on d0c715ab-1d55-
43cd-88f2-f6bfe3960683 (/opt/smartdc/manatee/node_modules/manatee/node_modules/m
anatee-state-machine/lib/manatee-peer.js:250 in ManateePeer.assumePrimary): assu
ming role (role=primary)
[2014-12-02T19:01:52.452Z] DEBUG: manatee-sitter/cluster/99642 on d0c715ab-1d55-
43cd-88f2-f6bfe3960683 (/opt/smartdc/manatee/node_modules/manatee/node_modules/m
anatee-state-machine/lib/manatee-peer.js:837 in pgReconfig):
    pg.reconfigure { role: 'primary',
      upstream: null,
      downstream:
       { zoneId: '4afba482-7670-4cfe-b11f-9df7f558106a',
         ip: '10.77.77.48',
         pgUrl: 'tcp://postgres@10.77.77.48:5432/postgres',
         backupUrl: 'http://10.77.77.48:12345',
         id: '10.77.77.48:5432:12345' } }
```

In this case you can see that the cluster state has declared a new generation
(generation 1):

```
[root@d0c715ab (postgres) ~]$ manatee-adm state | json
{
  "generation": 1,
  "primary": {
    "id": "10.77.77.49:5432:12345",
    "ip": "10.77.77.49",
    "pgUrl": "tcp://postgres@10.77.77.49:5432/postgres",
    "zoneId": "d0c715ab-1d55-43cd-88f2-f6bfe3960683",
    "backupUrl": "http://10.77.77.49:12345"
  },
  "sync": {
    "zoneId": "4afba482-7670-4cfe-b11f-9df7f558106a",
    "ip": "10.77.77.48",
    "pgUrl": "tcp://postgres@10.77.77.48:5432/postgres",
    "backupUrl": "http://10.77.77.48:12345",
    "id": "10.77.77.48:5432:12345"
  },
  "async": [
    {
      "id": "10.77.77.47:5432:12345",
      "zoneId": "f29499ea-b50c-431e-9975-e4bf760fb5e1",
      "ip": "10.77.77.47",
      "pgUrl": "tcp://postgres@10.77.77.47:5432/postgres",
      "backupUrl": "http://10.77.77.47:12345"
    }
  ],
  "initWal": "0/174A4D0"
}
```

You can also see that `manatee-adm history` reflects the progression of changes:

```
[root@d0c715ab (postgres) ~]$ manatee-adm history
{"time":"1417543665280","date":"2014-12-02T18:07:45.280Z","ip":"10.77.77.47:5432","action":"AssumeLeader","role":"Leader","master":"","slave":"","zkSeq":"0000000000"}
{"time":"1417543693514","date":"2014-12-02T18:08:13.514Z","ip":"10.77.77.47:5432","action":"NewStandby","role":"leader","master":"","slave":"10.77.77.48:5432","zkSeq":"0000000001"}
{"time":"1417543693593","date":"2014-12-02T18:08:13.593Z","ip":"10.77.77.48:5432","action":"NewLeader","role":"Standby","master":"10.77.77.47:5432","slave":"","zkSeq":"0000000002"}
{"time":"1417544064976","date":"2014-12-02T18:14:24.976Z","ip":"10.77.77.49:5432","action":"NewLeader","role":"Standby","master":"10.77.77.48:5432","slave":"","zkSeq":"0000000003"}
{"time":"1417545337553","date":"2014-12-02T18:35:37.553Z","state":{"primary":{"zoneId":"f29499ea-b50c-431e-9975-e4bf760fb5e1","ip":"10.77.77.47","pgUrl":"tcp://postgres@10.77.77.47:5432/postgres","backupUrl":"http://10.77.77.47:12345","id":"10.77.77.47:5432:12345"},"sync":{"zoneId":"d0c715ab-1d55-43cd-88f2-f6bfe3960683","ip":"10.77.77.49","pgUrl":"tcp://postgres@10.77.77.49:5432/postgres","backupUrl":"http://10.77.77.49:12345","id":"10.77.77.49:5432:12345"},"async":[{"zoneId":"4afba482-7670-4cfe-b11f-9df7f558106a","ip":"10.77.77.48","pgUrl":"tcp://postgres@10.77.77.48:5432/postgres","backupUrl":"http://10.77.77.48:12345","id":"10.77.77.48:5432:12345"}],"generation":0,"initWal":"0/0000000","freeze":{"date":"2014-12-02T18:31:35.394Z","reason":"manatee-adm state-backfill"}},"zkSeq":"0000000004"}
{"time":"1417546098034","date":"2014-12-02T18:48:18.034Z","ip":"10.77.77.47:5432","action":"NewStandby","role":"leader","master":"","slave":"10.77.77.49:5432","zkSeq":"0000000005"}
{"time":"1417546912449","date":"2014-12-02T19:01:52.449Z","state":{"generation":1,"primary":{"id":"10.77.77.49:5432:12345","ip":"10.77.77.49","pgUrl":"tcp://postgres@10.77.77.49:5432/postgres","zoneId":"d0c715ab-1d55-43cd-88f2-f6bfe3960683","backupUrl":"http://10.77.77.49:12345"},"sync":{"zoneId":"4afba482-7670-4cfe-b11f-9df7f558106a","ip":"10.77.77.48","pgUrl":"tcp://postgres@10.77.77.48:5432/postgres","backupUrl":"http://10.77.77.48:12345","id":"10.77.77.48:5432:12345"},"async":[],"initWal":"0/174A4D0"},"zkSeq":"0000000006"}
{"time":"1417547498986","date":"2014-12-02T19:11:38.986Z","state":{"generation":1,"primary":{"id":"10.77.77.49:5432:12345","ip":"10.77.77.49","pgUrl":"tcp://postgres@10.77.77.49:5432/postgres","zoneId":"d0c715ab-1d55-43cd-88f2-f6bfe3960683","backupUrl":"http://10.77.77.49:12345"},"sync":{"zoneId":"4afba482-7670-4cfe-b11f-9df7f558106a","ip":"10.77.77.48","pgUrl":"tcp://postgres@10.77.77.48:5432/postgres","backupUrl":"http://10.77.77.48:12345","id":"10.77.77.48:5432:12345"},"async":[{"id":"10.77.77.47:5432:12345","zoneId":"f29499ea-b50c-431e-9975-e4bf760fb5e1","ip":"10.77.77.47","pgUrl":"tcp://postgres@10.77.77.47:5432/postgres","backupUrl":"http://10.77.77.47:12345"}],"initWal":"0/174A4D0"},"zkSeq":"0000000007"}
```

At this point your cluster is upgraded.  Notes below on two node and single-node
updates as well as rollback.

## Rollback

At any point before the primary is reprovisioned:

1. Roll back current async.
1. Roll back current sync.
1. Delete the state in zookeeper by logging onto one of the binder zones and:

```
[root@9a5bcf34 (nameservice) ~]$ zkCli.sh
Connecting to localhost:2181
Welcome to ZooKeeper!
JLine support is enabled

WATCHER::

WatchedEvent state:SyncConnected type:None path:null
[zk: localhost:2181(CONNECTED) 0] ls /manatee
[1.moray.coal.joyent.us]
[zk: localhost:2181(CONNECTED) 1] ls /manatee/1.moray.coal.joyent.us
[state, history, election]
[zk: localhost:2181(CONNECTED) 2] delete /manatee/1.moray.coal.joyent.us/state
```

After the primary is reprovisioned:

1. Take note of the current topology.
1. Disable all manatee-sitters in the shard.
1. Delete the state object (as above)
1. Roll back the primary.
1. Roll back the sync.
1. Roll back the async.

## One-node shard upgrade

1. Reprovision the primary
2. Backfill the cluster state: `primary$ manatee-adm state-backfill`

## Two-node shard upgrade

1. Reprovision the sync
2. Backfill the cluster state: `sync$ manatee-adm state-backfill`
3. Reprovision the primary

# Design

## We need a migration plan

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

## How Deployments Work Today

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

## A Migration Plan

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

## Rollout

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

## Rollback

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
