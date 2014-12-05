/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.basic.js: tests the basic flow of unassigned -> async -> sync -> primary
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var sim, cmds;
var node1url = 'tcp://postgres@10.0.0.1:5432/postgres';
var node2url = 'tcp://postgres@10.0.0.2:5432/postgres';
var node3url = 'tcp://postgres@10.0.0.3:5432/postgres';
var asyncState, syncState;
var primState1, primState2, primState3, primState4;

asyncState = {
	'role': 'async',
	'zkstate': {
	    'generation': 1,
	    'primary': 'node2',
	    'sync': 'node3',
	    'async': [ 'node1' ],
	    'initWal': '0/00000000'
	},
	'zkpeers': [ 'node1', 'node2', 'node3' ],
	'pg': {
	    'online': true,
	    'config': {
	        'role': 'async',
		'upstream': node3url,
		'downstream': null
	    }
	}
};

syncState = {
	'role': 'sync',
	'zkstate': {
	    'generation': 2,
	    'primary': 'node3',
	    'sync': 'node1',
	    'async': [ 'node2' ],
	    'initWal': '0/0000000a'
	},
	'zkpeers': [ 'node1', 'node2', 'node3' ],
	'pg': {
	    'online': true,
	    'config': {
	        'role': 'sync',
		'upstream': node3url,
		'downstream': null
	    }
	}
};

primState1 = {
	'role': 'primary',
	'zkstate': {
	    'generation': 3,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [ ],
	    'initWal': '0/00000014'
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

primState2 = mod_jsprim.deepCopy(primState1);
primState2.zkpeers.push('node3');
primState2.zkstate.async.push('node3');

primState3 = {
	'role': 'primary',
	'zkstate': {
	    'generation': 4,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ ],
	    'initWal': '0/0000001e'
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

primState4 = mod_jsprim.deepCopy(primState3);
primState4.zkpeers.push('node2');
primState4.zkstate.async.push('node2');

sim = mod_test.createTestSimulator();
/* BEGIN JSSTYLED */
cmds = [
    /* validate initial ZK state */
    { 'cmd': 'echo', 'args': [ 'test: validating initial zk state' ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': null,
	'activeNodes': [ 'node1' ]
    } },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* validate results of addpeer */
    { 'cmd': 'echo', 'args': [ 'test: addpeer()' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'zk', 'args': [ true ], 'check': {
	'clusterState': null,
	'activeNodes': [ {
	    'id': 'node1',
	    'ip': '10.0.0.1',
	    'pgUrl': node1url,
	    'zoneId': 'node1'
	}, {
	    'id': 'node2',
	    'ip': '10.0.0.2',
	    'pgUrl': node2url,
	    'zoneId': 'node2'
	}, {
	    'id': 'node3',
	    'ip': '10.0.0.3',
	    'pgUrl': node3url,
	    'zoneId': 'node3'
	} ]
    } },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* validate bootstrap with args */
    { 'cmd': 'echo', 'args': [ 'test: bootstrap()' ] },
    { 'cmd': 'bootstrap', 'args': [ 'node2', 'node3' ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 1,
	    'primary': 'node2',
	    'sync': 'node3',
	    'async': [ 'node1' ],
	    'initWal': '0/00000000'
	},
	'activeNodes': [ 'node1', 'node2', 'node3' ]
    } },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* validate initial peer state */
    { 'cmd': 'echo', 'args': [ 'test: initial peer state' ] },
    { 'cmd': 'peer', 'check': {
	'role': 'unknown',
	'zkstate': null,
	'zkpeers': null,
	'pg': {
	    'config': null
	}
    } },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* bring up the peer as an async */
    { 'cmd': 'echo', 'args': [ 'test: start up as async' ] },
    { 'cmd': 'startPeer' },
    { 'cmd': 'peer', 'check': asyncState },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* Now depose the primary and make sure that our peer comes up as a sync. */
    { 'cmd': 'echo', 'args': [ 'test: depose()' ] },
    { 'cmd': 'depose' },
    { 'cmd': 'peer', 'check': syncState },
    { 'cmd': 'echo', 'args': [ '' ] },

    /*
     * At this point, if the primary fails, our peer should not take over
     * because it has not caught up.  Note that the peer will not come to rest
     * after this command, so we just wait an arbitrary period here.
     */
    { 'cmd': 'echo', 'args': [ 'test: no catch up and remove primary' ] },
    { 'cmd': 'rmpeer', 'wait': 1000, 'args': [ 'node3' ] },
    { 'cmd': 'peer', 'wait': 0, 'check': {
	'role': 'sync',
	'zkstate': {
	    'generation': 2,
	    'primary': 'node3',
	    'sync': 'node1',
	    'async': [ 'node2' ],
	    'initWal': '0/0000000a'
	},
	'zkpeers': [ 'node1', 'node2' ],
	'pg': {
	    'online': true,
	    'config': {
	        'role': 'sync',
		'upstream': node3url,
		'downstream': null
	    }
	}
    } },
    { 'cmd': 'addpeer', 'args': [ 'node3' ] },
    { 'cmd': 'peer', 'check': syncState },
    { 'cmd': 'echo', 'args': [ '' ] },

    /*
     * Now if we issue a catchUp() and do the same thing, our peer should
     * become primary.
     */
    { 'cmd': 'echo', 'args': [ 'test: catch up and remove primary' ] },
    { 'cmd': 'catchUp' },
    { 'cmd': 'rmpeer', 'args': [ 'node3' ] },
    { 'cmd': 'peer', 'check': primState1 },
    { 'cmd': 'addpeer', 'args': [ 'node3' ] },
    { 'cmd': 'peer', 'check': primState2 },
    { 'cmd': 'echo', 'args': [ '' ] },

    /* Now have the sync fail.  Our peer should promote the async. */
    { 'cmd': 'echo', 'args': [ 'test: test: sync fail' ] },
    { 'cmd': 'rmpeer', 'args': [ 'node2' ] },
    { 'cmd': 'peer', 'check': primState3 },
    { 'cmd': 'addpeer', 'args': [ 'node2' ] },
    { 'cmd': 'peer', 'check': primState4 },
    { 'cmd': 'echo', 'args': [ '' ] }
];
/* END JSSTYLED */

mod_test.runTestCommands(sim, cmds);
