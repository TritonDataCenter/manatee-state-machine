/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * tst.freeze.js: tests cluster freeze/unfreeze
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds;

sim = mod_test.createTestSimulator();
/* BEGIN JSSTYLED */
cmds = [
    { 'cmd': 'echo', 'args': [ 'test setup' ] },
    { 'cmd': 'addpeer', 'args': [ 'node1' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'startPeer' },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 1,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [ 'node3' ],
	    'initWal': '0/00000000'
	},
	'activeNodes': [ 'node1', 'node2', 'node3' ]
    } },
    { 'cmd': 'freeze' },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'freeze': { 'note': 'frozen by simulator' },
	    'generation': 1,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [ 'node3' ],
	    'initWal': '0/00000000'
	},
	'activeNodes': [ 'node1', 'node2', 'node3' ]
    } },

    /*
     * Make sure we have no takeover if the sync leaves.
     */
    { 'cmd': 'echo', 'args': [ 'test: no takeover while cluster frozen' ] },
    { 'cmd': 'rmpeer', 'wait': 2000, 'args': [ 'node2' ] },
    { 'cmd': 'addpeer', 'args': [ 'node2' ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'freeze': { 'note': 'frozen by simulator' },
	    'generation': 1,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [ 'node3' ],
	    'initWal': '0/00000000'
	},
	'activeNodes': [ 'node1', 'node3', 'node2' ]
    } },
    { 'cmd': 'echo', 'args': [ '' ] },

    /*
     * Make sure the cluster remains frozen even when the peer writes an updated
     * cluster state to reflect an async peer being removed or added.
     */
    { 'cmd': 'echo', 'args': [ 'test: remains frozen across async removal' ] },
    { 'cmd': 'rmpeer', 'args': [ 'node3' ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'freeze': { 'note': 'frozen by simulator' },
	    'generation': 1,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [],
	    'initWal': '0/00000000'
	},
	'activeNodes': [ 'node1', 'node2' ]
    } },
    { 'cmd': 'addpeer', 'args': [ 'node3' ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'freeze': { 'note': 'frozen by simulator' },
	    'generation': 1,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [ 'node3' ],
	    'initWal': '0/00000000'
	},
	'activeNodes': [ 'node1', 'node2', 'node3' ]
    } },
    { 'cmd': 'echo', 'args': [ '' ] },

    /*
     * Now unfreeze the cluster and make sure a takeover can happen as normal.
     */
    { 'cmd': 'echo', 'args': [ 'test: takeover works after unfreeze' ] },
    { 'cmd': 'unfreeze' },
    { 'cmd': 'rmpeer', 'args': [ 'node2' ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [],
	    'initWal': '0/0000000a'
	},
	'activeNodes': [ 'node1', 'node3' ]
    } }

];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
