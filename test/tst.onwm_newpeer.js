/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.onwm_newpeer.js: tests what happens when a new peer shows up for a
 * one-node-write mode where the primary peer is not itself
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds, state1, state2;
var node1url = 'tcp://postgres@10.0.0.1:5432/postgres';
var node2url = 'tcp://postgres@10.0.0.2:5432/postgres';
var node3url = 'tcp://postgres@10.0.0.3:5432/postgres';

sim = mod_test.createTestSimulator({ 'singleton': true });
state1 = {
	'id': 'node1',
	'role': 'unassigned',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node2',
	    'sync': null,
	    'initWal': '0/00000000',
	    'async': [],
	    'freeze': true,
	    'oneNodeWriteMode': true
	},
	'zkpeers': [ 'node2', 'node1' ],
	'pg': {
	    'online': false,
	    'config': {
		'role': 'none',
		'upstream': null,
		'downstream': null
	    }
	}
};
state2 = mod_jsprim.deepCopy(state1);
state2.zkpeers = [ 'node1' ];

/* BEGIN JSSTYLED */
cmds = [
    /*
     * Test that we don't do anything if we start up in ONWM when another peer
     * is the primary.
     */
    { 'cmd': 'echo', 'args': [ 'test: start up in ONWM' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'setClusterState', 'args': [ {
	'generation': 1,
	'primary': {
	    'id': 'node2',
	    'ip': '10.0.0.2',
	    'pgUrl': node2url,
	    'zoneId': 'node2'
	},
	'sync': null,
	'async': [],
	'deposed': [],
	'initWal': '0/00000000',
	'freeze': true,
	'oneNodeWriteMode': true
    } ] },
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': state1 },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* Check that we don't do anything even if that primary fails. */
    { 'cmd': 'echo', 'args': [ 'test: do nothing even if primary fails' ] },
    { 'cmd': 'rmpeer', 'args': [ 'node2' ] },
    { 'cmd': 'peer', 'check': state2 }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
