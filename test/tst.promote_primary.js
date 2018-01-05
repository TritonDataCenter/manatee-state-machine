/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * tst.promote_primary.js: promotion tests where the primary is responsible.
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var activeNodes, ignoredState, sim, cmds;

activeNodes = [ 'node1', 'node2', 'node3', 'node4', 'node5', 'node6' ];
ignoredState = {
    'clusterState': {
	'generation': 2,
	'primary': 'node1',
	'sync': 'node3',
	'async': [ 'node5', 'node2', 'node6', 'node4' ],
	'initWal': '0/0000000a'
    },
    'activeNodes': activeNodes
};

sim = mod_test.createTestSimulator();

cmds = [
    { 'cmd': 'addpeer', 'args': [ 'node1' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'startPeer' },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 1,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [ 'node3', 'node4', 'node5', 'node6' ],
	    'initWal': '0/00000000'
	},
	'activeNodes': activeNodes
    } },
    { 'cmd': 'echo', 'args': [ 'test: promote first async' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node3',
	'role': 'async',
	'asyncIndex': 0,
	'generation': 1,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ 'node4', 'node5', 'node6', 'node2' ],
	    'initWal': '0/0000000a'
	},
	'activeNodes': activeNodes
    } },

    { 'cmd': 'echo', 'args': [ 'test: promote last async' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 3,
	'generation': 2,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ 'node4', 'node5', 'node2', 'node6' ],
	    'initWal': '0/0000000a'
	},
	'activeNodes': activeNodes
    } },

    { 'cmd': 'echo', 'args': [ 'test: promote second async' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node5',
	'role': 'async',
	'asyncIndex': 1,
	'generation': 2,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ 'node5', 'node2', 'node6', 'node4' ],
	    'initWal': '0/0000000a'
	},
	'activeNodes': activeNodes
    } },

    { 'cmd': 'echo', 'args': [ 'test: ignore (promotePrimary)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node1',
	'role': 'primary',
	'generation': 2,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (expireTimePassed)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node5',
	'role': 'async',
	'asyncIndex': 2,
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date())
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (invalidIdAtRole)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node4',
	'role': 'sync',
	'generation': 2,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (invalidIdAtAsyncIndex)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 2,
	'generation': 2,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (asyncIndexUpperOOR)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 999,
	'generation': 2,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (asyncIndexLowerOOR)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': -1,
	'generation': 2,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (generationLowerOOR)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 1,
	'generation': 100,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (generationMismatch)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 1,
	'generation': 1,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (generationInvalid)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 1,
	'generation': 'test',
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (expireTimeInvalid)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 1,
	'generation': 2,
	'expireTime': 'test'
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (nonexistentId)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node999',
	'role': 'sync',
	'generation': 2,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (idMissing)' ] },
    { 'cmd': 'promote', 'args': [ {
	'role': 'async',
	'asyncIndex': 1,
	'generation': 2,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 },

    { 'cmd': 'echo', 'args': [ 'test: ignore (invalidRole)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node1',
	'role': 'test',
	'generation': 2,
	'expireIn': 200
    } ] },
    { 'cmd': 'zk', 'check': ignoredState, 'wait': 300 }
];

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
