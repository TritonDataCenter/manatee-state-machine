/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.cluster_setup_passive.js: tests holding off on cluster setup for the
 * first peer.
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
     * Test that when the peer comes up with other peers present but we're not
     * first, we wait on cluster setup.
     */
    { 'cmd': 'echo', 'args': [ 'test: start up with other peers' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': {
	'id': 'node1',
	'role': 'unassigned',
	'zkstate': null,
	'zkpeers': [ 'node2', 'node1' ],
	'pg': {
	    'online': false,
	    'config': {
		'role': 'none',
		'upstream': null,
		'downstream': null
	    }
	}
    } },

    /*
     * Now simulate the other peer setting up the cluster.
     */
    { 'cmd': 'bootstrap' },
    { 'cmd': 'peer', 'check': {
	'id': 'node1',
	'role': 'sync',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node2',
	    'sync': 'node1',
	    'initWal': '0/00000000',
	    'async': []
	},
	'zkpeers': [ 'node2', 'node1' ],
	'pg': {
	    'online': true,
	    'config': {
	        'role': 'sync',
		'upstream': node2url,
		'downstream': null
	    }
	}
    } }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds);
