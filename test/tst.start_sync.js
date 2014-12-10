/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.start_sync.js: tests starting as the sync peer
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds;
var node1url = 'tcp://postgres@10.0.0.1:5432/postgres';
var node2url = 'tcp://postgres@10.0.0.2:5432/postgres';
var node3url = 'tcp://postgres@10.0.0.3:5432/postgres';
var syncState, primState1, primState2, primState3, primState4;

syncState = {
	'role': 'sync',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node3',
	    'sync': 'node1',
	    'async': [ 'node2' ],
	    'initWal': '0/00000000'
	},
	'zkpeers': [ 'node1', 'node2', 'node3' ],
	'pg': {
	    'online': true,
	    'config': {
	        'role': 'sync',
		'upstream': node3url,
		'downstream': null
	    }
	}
};

primState1 = {
	'role': 'primary',
	'zkstate': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [ ],
	    'initWal': '0/0000000a'
	},
	'zkpeers': [ 'node1', 'node2' ],
	'pg': {
	    'online': true,
	    'config': {
	        'role': 'primary',
		'upstream': null,
		'downstream': node2url
	    }
	}
};

primState2 = mod_jsprim.deepCopy(primState1);
primState2.zkpeers.push('node3');
primState2.zkstate.async.push('node3');

primState3 = {
	'role': 'primary',
	'zkstate': {
	    'generation': 3,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ ],
	    'initWal': '0/00000014'
	},
	'zkpeers': [ 'node1', 'node3' ],
	'pg': {
	    'online': true,
	    'config': {
	        'role': 'primary',
		'upstream': null,
		'downstream': node3url
	    }
	}
};

primState4 = mod_jsprim.deepCopy(primState3);
primState4.zkpeers.push('node2');
primState4.zkstate.async.push('node2');

sim = mod_test.createTestSimulator();
/* BEGIN JSSTYLED */
cmds = [
    /* Validate bootstrap with args. */
    { 'cmd': 'echo', 'args': [ 'test: bootstrap()' ] },
    { 'cmd': 'addpeer', 'args': [ 'node1' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'bootstrap', 'args': [ 'node3' ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 1,
	    'primary': 'node3',
	    'sync': 'node1',
	    'async': [ 'node2' ],
	    'initWal': '0/00000000'
	},
	'activeNodes': [ 'node1', 'node2', 'node3' ]
    } },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* Validate initial peer state. */
    { 'cmd': 'echo', 'args': [ 'test: initial peer state' ] },
    { 'cmd': 'peer', 'check': {
	'role': 'unknown',
	'zkstate': null,
	'zkpeers': null,
	'pg': {
	    'config': null
	}
    } },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* Bring up the peer as the sync. */
    { 'cmd': 'echo', 'args': [ 'test: start up as sync' ] },
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': syncState },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* Catch up, kill the primary, and our peer should become primary. */
    { 'cmd': 'echo', 'args': [ 'test: catch up and remove primary' ] },
    { 'cmd': 'catchUp' },
    { 'cmd': 'rmpeer', 'args': [ 'node3' ] },
    { 'cmd': 'rebuild', 'args': [ 'node3' ] },
    { 'cmd': 'peer', 'check': primState1 },
    { 'cmd': 'addpeer', 'args': [ 'node3' ] },
    { 'cmd': 'peer', 'check': primState2 },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* Now have the sync fail.  Our peer should promote the async. */
    { 'cmd': 'echo', 'args': [ 'test: sync fail' ] },
    { 'cmd': 'rmpeer', 'args': [ 'node2' ] },
    { 'cmd': 'peer', 'check': primState3 },
    { 'cmd': 'addpeer', 'args': [ 'node2' ] },
    { 'cmd': 'peer', 'check': primState4 },
    { 'cmd': 'echo', 'args': [ '' ] }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
