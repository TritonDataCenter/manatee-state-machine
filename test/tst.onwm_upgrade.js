/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.onwm_upgrade.js: tests upgrading one-node-write mode to normal mode
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds, state1, state2, state3;
var node1url = 'tcp://postgres@10.0.0.1:5432/postgres';
var node2url = 'tcp://postgres@10.0.0.2:5432/postgres';
var node3url = 'tcp://postgres@10.0.0.3:5432/postgres';

sim = mod_test.createTestSimulator();
state1 = {
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

state2 = mod_jsprim.deepCopy(state1);
delete (state2.zkstate.freeze);

state3 = {
	'id': 'node1',
	'role': 'primary',
	'zkstate': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node2',
	    'initWal': '0/0000000a',
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
};

/* BEGIN JSSTYLED */
cmds = [
    /* Test starting up in ONWM. */
    { 'cmd': 'echo', 'args': [ 'test: start up as primary in ONWM cluster' ] },
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
    { 'cmd': 'peer', 'check': state1 },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* Unfreeze the cluster and make sure we still hold off. */
    { 'cmd': 'echo', 'args': [ 'test: unfreeze' ] },
    { 'cmd': 'unfreeze', 'wait': 1000 },
    { 'cmd': 'peer', 'wait': 0, 'check': state2 },
    { 'cmd': 'echo', 'wait': 0, 'args': [ '' ] },

    /* Now add another peer and see that we transition to normal mode. */
    { 'cmd': 'echo', 'wait': 0, 'args': [ 'test: transition to normal mode' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'peer', 'check': {
	'id': 'node1',
	'role': 'primary',
	'zkstate': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node2',
	    'initWal': '0/0000000a',
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
    } },
    { 'cmd': 'echo', 'args': [ '' ] },

    /*
     * Add another peer, fail the sync, and make sure we reconfigure
     * appropriately.
     */
    { 'cmd': 'echo', 'args': [ 'test: reconfiguration in normal mode' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'rmpeer', 'args': [ 'node2' ] },
    { 'cmd': 'addpeer', 'args': [ 'node2' ] },
    { 'cmd': 'peer', 'check': {
	'id': 'node1',
	'role': 'primary',
	'zkstate': {
	    'generation': 3,
	    'primary': 'node1',
	    'sync': 'node3',
	    'initWal': '0/00000014',
	    'async': [ 'node2' ]
	},
	'zkpeers': [ 'node1', 'node3', 'node2' ],
	'pg': {
	    'online': true,
	    'config': {
		'role': 'primary',
		'upstream': null,
		'downstream': node3url
	    }
	}
    } },
    { 'cmd': 'echo', 'args': [ '' ] }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
