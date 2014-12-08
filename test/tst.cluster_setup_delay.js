/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.cluster_setup_delay.js: tests cluster setup when no peers are initially
 * present.
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds;
var node1url = 'tcp://postgres@10.0.0.1:5432/postgres';
var node2url = 'tcp://postgres@10.0.0.2:5432/postgres';
var node3url = 'tcp://postgres@10.0.0.3:5432/postgres';

sim = mod_test.createTestSimulator();
/* BEGIN JSSTYLED */
cmds = [
    /*
     * Test that when the peer comes up with no other peers, we wait on cluster
     * setup.
     */
    { 'cmd': 'echo', 'args': [ 'test: start up with no peers' ] },
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': {
	'id': 'node1',
	'role': 'unassigned',
	'zkstate': null,
	'zkpeers': [ 'node1' ],
	'pg': {
	    'config': { 'role': 'none', 'upstream': null, 'downstream': null },
	    'online': false
	}
    } },

    /*
     * Now test that when we add a peer, we create the cluster.
     */
    { 'cmd': 'addpeer' },
    { 'cmd': 'peer', 'check': {
	'id': 'node1',
	'role': 'primary',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node1',
	    'sync': 'node2',
	    'initWal': '0/00000000',
	    'async': []
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
    } }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
