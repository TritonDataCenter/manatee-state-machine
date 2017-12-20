/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * tst.promote_primary.js: promotion tests where the primary is responsible.
 */

var mod_jsprim = require('jsprim');
var mod_test = require('./common');
var activeNodes, ignoredState, sim, cmds;

activeNodes = [ 'node1', 'node2', 'node3', 'node4', 'node5', 'node6' ];
ignoredState = {
    'clusterState': {
	'generation': 2,
	'primary': 'node1',
	'sync': 'node3',
	'async': [ 'node5', 'node2', 'node6', 'node4' ],
	'initWal': '0/0000000a'
    },
    'activeNodes': activeNodes
};

sim = mod_test.createTestSimulator();

cmds = [
    { 'cmd': 'addpeer', 'args': [ 'node1' ] },
    { 'cmd': 'addpeer' },
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
	    'async': [ 'node3', 'node4', 'node5', 'node6' ],
	    'initWal': '0/00000000'
	},
	'activeNodes': activeNodes
    } },
    { 'cmd': 'echo', 'args': [ 'test: promote first async' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node3',
	'role': 'async',
	'asyncIndex': 0,
	'generation': 1,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ 'node4', 'node5', 'node6', 'node2' ],
	    'initWal': '0/0000000a'
	},
	'activeNodes': activeNodes
    } },
    { 'cmd': 'echo', 'args': [ 'test: promote last async' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 3,
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'log', 'args': [ 10 ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ 'node4', 'node5', 'node2', 'node6' ],
	    'initWal': '0/0000000a'
	},
	'activeNodes': activeNodes
    } },
    { 'cmd': 'echo', 'args': [ 'test: promote second async' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node5',
	'role': 'async',
	'asyncIndex': 1,
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': {
	'clusterState': {
	    'generation': 2,
	    'primary': 'node1',
	    'sync': 'node3',
	    'async': [ 'node5', 'node2', 'node6', 'node4' ],
	    'initWal': '0/0000000a'
	},
	'activeNodes': activeNodes
    } },
    { 'cmd': 'echo', 'args': [ 'test: ignore (promote primary)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node1',
	'role': 'primary',
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (deadline missed)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node5',
	'role': 'async',
	'asyncIndex': 2,
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date())
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (invalid id/role)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node4',
	'role': 'sync',
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (asyncIndex/id mismatch)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 2,
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [
	'test: ignore (asyncIndex out of upper range)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 999,
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [
	'test: ignore (asyncIndex out of lower range)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': -1,
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [
	'test: ignore (generation out of lower range)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 1,
	'generation': -1,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (generation incorrect)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 1,
	'generation': 1,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (generation is a string)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 1,
	'generation': 'test',
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (bad expireTime)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node2',
	'role': 'async',
	'asyncIndex': 1,
	'generation': 2,
	'expireTime': 'test'
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (nonexistent id)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node999',
	'role': 'sync',
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (id missing)' ] },
    { 'cmd': 'promote', 'args': [ {
	'role': 'async',
	'asyncIndex': 1,
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState },
    { 'cmd': 'echo', 'args': [ 'test: ignore (invalid role)' ] },
    { 'cmd': 'promote', 'args': [ {
	'id': 'node1',
	'role': 'test',
	'generation': 2,
	'expireTime': mod_jsprim.iso8601(new Date('2017-12-31T10:00:00Z'))
    } ] },
    { 'cmd': 'zk', 'check': ignoredState }
];

mod_test.runTestCommands(sim, cmds, process.argv[2] == '-v');
