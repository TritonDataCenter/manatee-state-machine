/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * tst.promote_sync.js: promotion tests where the sync is responsible.
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var ignoredState, sim, cmds;

sim = mod_test.createTestSimulator();

cmds = [
    { 'cmd': 'addpeer', 'args': [ 'node1' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'bootstrap', 'args': [ 'node2' ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 1,
	    'primary': 'node2',
	    'sync': 'node1',
	    'async': [ ],
	    'initWal': '0/00000000'
	},
	'activeNodes': [ 'node1', 'node2' ]
    } },
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': {
	'role': 'sync',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node2',
	    'sync': 'node1',
	    'async': [ ],
	    'initWal': '0/00000000'
	},
	'zkpeers': [ 'node1', 'node2' ],
	'pg': {
	    'online': true,
	    'config': {
		'role': 'sync',
		'upstream': 'tcp://postgres@10.0.0.2:5432/postgres',
		'downstream': null
	    }
	}
    } },
    { 'cmd': 'catchUp' },
    { 'cmd': 'echo', 'args': [ 'test: ignored (no asyncs)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node1',
	'role': 'sync',
	'generation': 1,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 1,
	    'primary': 'node2',
	    'sync': 'node1',
	    'async': [ ],
	    'initWal': '0/00000000'
	}
    }, 'wait': 300 },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'peer', 'check': {
	'role': 'sync',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node2',
	    'sync': 'node1',
	    'async': [ 'node3', 'node4', 'node5' ],
	    'initWal': '0/00000000'
	},
	'zkpeers': [ 'node1', 'node2', 'node3', 'node4', 'node5' ],
	'pg': {
	    'online': true,
	    'config': {
		'role': 'sync',
		'upstream': 'tcp://postgres@10.0.0.2:5432/postgres',
		'downstream': null
	    }
	}
    } },
    { 'cmd': 'echo', 'args': [ 'test: promote sync' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node1',
	'role': 'sync',
	'generation': 1,
	'expireIn': 200
    } ], 'wait': 300 },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ 'node4', 'node5' ],
	    'deposed': [ 'node2' ],
	    'initWal': '0/0000000a'
	},
	'activeNodes': [ 'node1', 'node2', 'node3', 'node4', 'node5' ]
    } }
];

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
