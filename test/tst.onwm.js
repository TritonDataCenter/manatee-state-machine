/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.onwm.js: tests operation in one-node-write mode
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds, state;
var node1url = 'tcp://postgres@10.0.0.1:5432/postgres';
var node2url = 'tcp://postgres@10.0.0.2:5432/postgres';
var node3url = 'tcp://postgres@10.0.0.3:5432/postgres';

sim = mod_test.createTestSimulator({ 'singleton': true });
state = {
	'id': 'node1',
	'role': 'primary',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node1',
	    'sync': null,
	    'initWal': '0/00000000',
	    'async': [],
	    'freeze': true,
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
};

/* BEGIN JSSTYLED */
cmds = [
    /* Test starting up in ONWM. */
    { 'cmd': 'echo', 'args': [ 'test: start up as primary in ONWM' ] },
    { 'cmd': 'setClusterState', 'args': [ {
	'generation': 1,
	'primary': {
	    'id': 'node1',
	    'ip': '10.0.0.1',
	    'pgUrl': node1url,
	    'zoneId': 'node1'
	},
	'sync': null,
	'async': [],
	'initWal': '0/00000000',
	'freeze': true,
	'oneNodeWriteMode': true
    } ] },
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': state },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* Test not doing anything when another peer shows up. */
    { 'cmd': 'echo', 'args': [ 'test: do nothing with new peers' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'peer', 'check': state },
    { 'cmd': 'rmpeer', 'args': [ 'node2' ] },
    { 'cmd': 'peer', 'check': state }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds);
