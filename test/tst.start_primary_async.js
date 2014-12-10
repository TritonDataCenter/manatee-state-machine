/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.start_primary_async.js: test starting the primary when the sync is not
 * up, but the async is.  This simulates a cluster reboot where the sync comes
 * up last.
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds;
var node1url = 'tcp://postgres@10.0.0.1:5432/postgres';
var node2url = 'tcp://postgres@10.0.0.2:5432/postgres';
var node3url = 'tcp://postgres@10.0.0.3:5432/postgres';

var stateAfter = {
	'id': 'node1',
	'role': 'primary',
	'zkstate': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'initWal': '0/0000000a',
	    'async': []
	},
	'zkpeers': [ 'node3', 'node1' ],
	'pg': {
	    'online': true,
	    'config': {
	        'role': 'primary',
	        'upstream': null,
	        'downstream': node3url
	    }
	}
};

sim = mod_test.createTestSimulator();
/* BEGIN JSSTYLED */
cmds = [
    /* Test starting as the primary. */
    { 'cmd': 'echo', 'args': [ 'test: start primary, no sync' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer', 'args': [ 'node1' ] },
    { 'cmd': 'bootstrap', 'args': [ 'node1', 'node2' ] },
    { 'cmd': 'zk', 'check': { 'clusterState': {
	'generation': 1,
	'primary': 'node1',
	'sync': 'node2',
	'async': [ 'node3' ],
	'initWal': '0/00000000'
    } } },
    { 'cmd': 'rmpeer', 'args': [ 'node2' ] },
    { 'cmd': 'startPeer' },

    /* Verify that the primary has moved the async to sync */
    { 'cmd': 'peer', 'check': stateAfter }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
