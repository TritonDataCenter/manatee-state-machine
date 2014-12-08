/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.cluster_setup_onwm.js: tests cluster setup in one-node-write mode
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds;
var node1url = 'tcp://postgres@10.0.0.1:5432/postgres';
var node2url = 'tcp://postgres@10.0.0.2:5432/postgres';
var node3url = 'tcp://postgres@10.0.0.3:5432/postgres';

sim = mod_test.createTestSimulator({ 'singleton': true });

/* BEGIN JSSTYLED */
cmds = [
    { 'cmd': 'echo', 'args': [ 'test: start up in ONWM' ] },
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': {
	'id': 'node1',
	'role': 'primary',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node1',
	    'sync': null,
	    'initWal': '0/00000000',
	    'async': [],
	    'freeze': {},
	    'oneNodeWriteMode': true
	},
	'zkpeers': [ 'node1' ],
	'pg': {
	    'online': true,
	    'config': {
		'role': 'primary',
		'upstream': null,
		'downstream': null
	    }
	}
    } }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
