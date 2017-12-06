var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var ignoredState, sim, cmds;

ignoredState = {
    'clusterState': {
	'generation': 2,
	'primary': 'node1',
	'sync': 'node3',
	'async': [ 'node4', 'node2', 'node5' ],
	'initWal': '0/0000000a'
    },
    'activeNodes': [ 'node1', 'node2', 'node3', 'node4', 'node5' ]
};

sim = mod_test.createTestSimulator();

cmds = [
    { 'cmd': 'addpeer', 'args': [ 'node1' ] },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'addpeer' },
    { 'cmd': 'startPeer' },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 1,
	    'primary': 'node1',
	    'sync': 'node2',
	    'async': [ 'node3', 'node4', 'node5' ],
	    'initWal': '0/00000000'
	},
	'activeNodes': [ 'node1', 'node2', 'node3', 'node4', 'node5' ]
    } },
    { 'cmd': 'echo', 'args': [ 'test: promote first async' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node3',
	'role': 'async',
	'asyncIndex': 0,
	'generation': 1,
	'time': new Date().getTime() + (5 * 1000)
    } ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ 'node4', 'node5', 'node2' ],
	    'initWal': '0/0000000a'
	},
	'activeNodes': [ 'node1', 'node2', 'node3', 'node4', 'node5' ]
    } },
    { 'cmd': 'echo', 'args': [ 'test: promote last async' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 2,
	'generation': 2,
	'time': new Date().getTime() + (5 * 1000)
    } ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ 'node4', 'node2', 'node5' ],
	    'initWal': '0/0000000a'
	},
	'activeNodes': [ 'node1', 'node2', 'node3', 'node4', 'node5' ]
    } },
    { 'cmd': 'echo', 'args': [ 'test: ignore (promote primary)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node1',
	'role': 'primary',
	'generation': 2,
	'time': new Date().getTime() + (5 * 1000)
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (deadline missed)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node5',
	'role': 'async',
	'asyncIndex': 2,
	'generation': 2,
	'time': new Date().getTime() - 1000
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (invalid id/role)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node4',
	'role': 'sync',
	'generation': 2,
	'time': new Date().getTime(),
	'force': true
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (invalid asyncIndex)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 2,
	'generation': 2,
	'time': new Date().getTime() + (5 * 1000)
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (promote sync, no asyncs)' ] },
    { 'cmd': 'echo', 'args': [ 'test: ignore (invalid role)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node1',
	'role': 'test',
	'generation': 2,
	'time': new Date().getTime() + (5 * 1000)
    } ] },
    { 'cmd': 'echo', 'args': [ 'test: promote sync' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node3',
	'role': 'sync',
	'generation': 1,
	'time': new Date().getTime() + (5 * 1000)
    } ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 3,
	    'primary': 'node3',
	    'sync': 'node4',
	    'async': [ 'node2', 'node5' ],
	    'deposed': [ 'node1' ],
	    'initWal': '0/00000014'
	},
	'activeNodes': [ 'node1', 'node2', 'node3', 'node4', 'node5' ]
    } }
];

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
