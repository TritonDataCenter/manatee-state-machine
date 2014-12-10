/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.start_deposed.js: tests starting as the deposed peer
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds;
var node1url = 'tcp://postgres@10.0.0.1:5432/postgres';
var node2url = 'tcp://postgres@10.0.0.2:5432/postgres';
var node3url = 'tcp://postgres@10.0.0.3:5432/postgres';
var deposedState;

deposedState = {
	'role': 'deposed',
	'zkstate': {
	    'generation': 2,
	    'primary': 'node2',
	    'sync': 'node3',
	    'async': [],
	    'deposed': [ 'node1' ],
	    'initWal': '0/0000000a'
	},
	'zkpeers': [ 'node1', 'node2', 'node3' ],
	'pg': {
	    'online': false,
	    'config': {
	        'role': 'none',
		'upstream': null,
		'downstream': null
	    }
	}
};

sim = mod_test.createTestSimulator();
/* BEGIN JSSTYLED */
cmds = [
    /* Test starting as the deposed peer. */
    { 'cmd': 'echo', 'args': [ 'test: start as deposed' ] },
    { 'cmd': 'addpeer', 'args': [ 'node1' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'bootstrap', 'args': [] },
    { 'cmd': 'depose', 'args': [] },
    { 'cmd': 'zk', 'check': {
	'clusterState': deposedState.zkstate,
	'activeNodes': deposedState.zkpeers
    } },
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': deposedState },
    { 'cmd': 'echo', 'args': [ '' ] }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
