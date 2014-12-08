/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.start_primary.js: tests starting as the primary peer
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds;
var node1url = 'tcp://postgres@10.0.0.1:5432/postgres';
var node2url = 'tcp://postgres@10.0.0.2:5432/postgres';
var node3url = 'tcp://postgres@10.0.0.3:5432/postgres';
var primState1, primState2, primState3;

primState1 = {
	'role': 'primary',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [ 'node3' ],
	    'initWal': '0/00000000'
	},
	'zkpeers': [ 'node1', 'node2', 'node3' ],
	'pg': {
	    'online': true,
	    'config': {
	        'role': 'primary',
		'upstream': null,
		'downstream': node2url
	    }
	}
};

primState2 = {
	'role': 'primary',
	'zkstate': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ ],
	    'initWal': '0/0000000a'
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

primState3 = mod_jsprim.deepCopy(primState2);
primState3.zkpeers.push('node2');
primState3.zkstate.async.push('node2');

sim = mod_test.createTestSimulator();
/* BEGIN JSSTYLED */
cmds = [
    /* Test starting as the primary. */
    { 'cmd': 'echo', 'args': [ 'test: start as primary' ] },
    { 'cmd': 'addpeer', 'args': [ 'node1' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'bootstrap', 'args': [] },
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
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': primState1 },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* Now have the sync fail.  Our peer should promote the async. */
    { 'cmd': 'echo', 'args': [ 'test: sync fail' ] },
    { 'cmd': 'rmpeer', 'args': [ 'node2' ] },
    { 'cmd': 'peer', 'check': primState2 },
    { 'cmd': 'addpeer', 'args': [ 'node2' ] },
    { 'cmd': 'peer', 'check': primState3 },
    { 'cmd': 'echo', 'args': [ '' ] }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
