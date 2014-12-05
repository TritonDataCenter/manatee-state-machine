/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.noflap.js: tests several cases where we shouldn't takeover
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
     * Bring up our peer as a sync and make sure it doesn't take over when there
     * are no asyncs available.
     */
    { 'cmd': 'echo', 'args': [ 'test: no takeover without asyncs (as sync)' ] },
    { 'cmd': 'addpeer', 'args': [ 'node1' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'bootstrap', 'args': [ 'node2', 'node1' ] },
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': {
	'role': 'sync',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node2',
	    'sync': 'node1',
	    'async': [],
	    'initWal': '0/00000000'
	},
	'zkpeers': [ 'node1', 'node2' ],
	'pg': {
	    'online': true,
	    'config': {
		'role': 'sync',
		'upstream': node2url,
		'downstream': null
	    }
	}
    } },
    { 'cmd': 'rmpeer', 'args': [ 'node2' ], 'wait': 1000 },
    { 'cmd': 'peer', 'wait': 0, 'check': {
	'role': 'sync',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node2',
	    'sync': 'node1',
	    'async': [],
	    'initWal': '0/00000000'
	},
	'zkpeers': [ 'node1' ],
	'pg': {
	    'online': true,
	    'config': {
		'role': 'sync',
		'upstream': node2url,
		'downstream': null
	    }
	}
    } },

    /*
     * Now allow the peer to takeover by adding a new async.
     */
    { 'cmd': 'addpeer' },
    { 'cmd': 'peer', 'check': {
	'role': 'primary',
	'zkstate': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [],
	    'initWal': '0/00000000'
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
    } },

    /*
     * Now make sure we don't declare a new generation when the sync fails
     * because there's no async.
     */
    { 'cmd': 'rmpeer', 'args': [ 'node3' ], 'wait': 1000 },
    { 'cmd': 'peer', 'wait': 0, 'check': {
	'role': 'primary',
	'zkstate': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [],
	    'initWal': '0/00000000'
	},
	'zkpeers': [ 'node1' ],
	'pg': {
	    'online': true,
	    'config': {
		'role': 'primary',
		'upstream': null,
		'downstream': node3url
	    }
	}
    } },

    /*
     * Now allow it declare a new generation by re-adding node2 as an async.
     */
    { 'cmd': 'addpeer', 'args': [ 'node2' ] },
    { 'cmd': 'peer', 'check': {
	'role': 'primary',
	'zkstate': {
	    'generation': 3,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [],
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
    } }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds);
