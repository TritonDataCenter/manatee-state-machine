/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * sim-sim.js: simulator for the Manatee state machine
 */

var mod_assertplus = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_extsprintf = require('extsprintf');
var mod_jsprim = require('jsprim');
var mod_path = require('path');
var mod_repl = require('repl');
var mod_validation = require('./validation');

var createBunyanPrettyPrinter = require('./stream-bunyan-prettyprint');
var createManateePeer = require('./manatee-peer');
var createSimZkState = require('./sim-zk');
var createSimPgState = require('./sim-pg');
var arg0 = mod_path.basename(process.argv[1]);
var sprintf = mod_extsprintf.sprintf;
var VError = require('verror');

function fprintf(stream)
{
	var args = Array.prototype.slice.call(arguments, 1);
	var str = sprintf.apply(null, args);
	stream.write(str);
}

function usage()
{
	console.error('node %s [NPEERS]', arg0);
	process.exit(2);
}

function fatal(err)
{
	console.error('%s: %s', arg0, err.message);
	process.exit(1);
}

function main()
{
	var logstream, log, sim;

	logstream = createBunyanPrettyPrinter();
	logstream.pipe(process.stdout);
	log = new mod_bunyan({
	    'name': arg0,
	    'level': process.env['LOG_LEVEL'] || 'debug',
	    'streams': [ { 'type': 'raw', 'stream': logstream } ]
	});

	sim = createSimulator({ 'log': log });

	sim.startRepl({
	    'input': process.stdin,
	    'output': process.stdout
	});
}

function createSimulator(args)
{
	return (new Simulator(args));
}

function Simulator(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.log, 'args.log');

	this.ms_log = args.log;
	this.ms_output = null;

	this.ms_zk = createSimZkState({
	    'log': this.ms_log.child({ 'component': 'zk' })
	});

	this.ms_pg = createSimPgState({
	    'log': this.ms_log.child({ 'component': 'pg' })
	});

	this.ms_nextpeer = 0;
	this.ms_peer = this.createSimPeer();

	this.ms_cmds = [
	    [ 'help', this.cmdHelp, 'help()', 'show help output' ],
	    [ 'ident', this.cmdIdent, 'ident()',
	        'print identity of the peer being tested' ],

	    [ 'zk', this.cmdZk, 'zk()', 'print simulated ZooKeeper state' ],
	    [ 'lspeers', this.cmdLsPeers, 'lspeers()',
	        'list simulated peers' ],
	    [ 'addpeer', this.cmdAddPeer, 'addPeer(ident)',
	        'simulate a new peer joining the ZK cluster' ],
	    [ 'rmpeer', this.cmdRmPeer, 'addPeer(id)',
	        'simulate a peer being removed from the ZK cluster' ],
	    [ 'setClusterState', this.cmdSetClusterState,
	        'setClusterState(clusterState)',
		'simulate a write to the cluster state stored in ZK' ],
	    [ 'startSimulation', this.cmdStartSimulation,
	        'startSimulation()', 'start the peer state machine' ]
	];
}

Simulator.prototype.createSimPeer = function ()
{
	var zk, pg;
	var nodename, ip4addr, ident, impl;
	var which = this.ms_nextpeer++;

	nodename = 'node' + which;
	ip4addr = '10.0.0.' + (which + 1);
	ident = {
	    'zonename': nodename,
	    'ip4addr': ip4addr
	};
	zk = this.ms_zk.createZkClient(ident);
	pg = this.ms_pg.createPgClient(ident);

	impl = createManateePeer({
	    'log': this.ms_log,
	    'zkinterface': zk,
	    'pginterface': pg,
	    'self': ident
	});

	return ({
	    'sp_ident': ident,
	    'sp_impl': impl,
	    'sp_zk': zk,
	    'sp_pg': pg
	});
};

Simulator.prototype.start = function ()
{
	this.ms_peer.sp_zk.startSimulation();
	this.ms_peer.sp_pg.startSimulation();
};

Simulator.prototype.startRepl = function (args)
{
	var repl, sim;

	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.input, 'args.input');
	mod_assertplus.object(args.output, 'args.output');

	fprintf(args.output, 'Welcome to the Manatee single-node simulator!\n');
	fprintf(args.output, 'For help, type "help()".\n');

	sim = this;
	repl = mod_repl.start({
	    'prompt': 'msim> ',
	    'ignoreUndefined': true,
	    'input': args.input,
	    'output': args.output
	});

	this.ms_output = args.output;
	this.ms_cmds.forEach(function (funcinfo) {
		var funcname = funcinfo[0];
		var method = funcinfo[1];
		mod_assertplus.ok(method,
		    'missing built-in method "' + funcname + '"');
		repl.context[funcname] = method.bind(sim);
	});
};

Simulator.prototype.cmdHelp = function ()
{
	var output = this.ms_output;

	fprintf(output, '%s\n', [
	    'This program plugs the Manatee peer implementation into a ',
	    'simulated ZooKeeper cluster.  Commands are provided for ',
	    'inspecting and manipulating the ZooKeeper state and for ',
	    'inspecting the peer state.  The prompt accepts input in ',
	    'JavaScript syntax, and functions are used to invoke commands.',
	    'Available commands include:\n'
	].join('\n'));

	this.ms_cmds.forEach(function (funcinfo) {
		fprintf(output, '    %-s\n\n        %s\n\n',
		    funcinfo[2], funcinfo[3]);
	});

	return (undefined);
};

Simulator.prototype.error = function (err)
{
	/* XXX shouldn't hardcode stderr */
	fprintf(process.stderr, '%s: %s\n', arg0, err.message);
};

Simulator.prototype.cmdIdent = function ()
{
	return (this.ms_peer.sp_ident);
};

Simulator.prototype.cmdZk = function ()
{
	return ({
	    'clusterState': this.ms_zk.currentClusterState(),
	    'activeNodes': this.ms_zk.currentActiveNodes()
	});
};

Simulator.prototype.cmdAddPeer = function (ident)
{
	var peer;

	if (typeof (ident) == 'string') {
		peer = {
		    'zonename': ident,
		    'ip4addr': '10.0.0.0'
		};
	} else {
		peer = {
		    'zonename': 'node' + (this.ms_nextpeer++),
		    'ip4addr': '10.0.0.0'
		};
	}

	if (!this.ms_zk.peerJoined(peer))
		this.error(new VError('peer already exists: "%s"',
		    peer.zonename));
	return (undefined);
};

Simulator.prototype.cmdRmPeer = function (name)
{
	if (typeof (name) != 'string') {
		this.error(new VError('expected peer name'));
		return (undefined);
	}

	if (!this.ms_zk.peerRemoved(name))
		this.error(new VError('peer not present: "%s"', name));
	return (undefined);
};

Simulator.prototype.cmdSetClusterState = function (newstate)
{
	var validated;

	/*
	 * This is really annoying.  The problem is that validateZkState
	 * validates that "async" is an array, but because it was created in a
	 * different context, Array.isArray() returns false.  So we patch it up
	 * here.
	 */
	if (newstate && newstate.async &&
	    newstate.async.constructor.name == 'Array') {
		var async, i;
		async = new Array(newstate.async.length);
		for (i = 0; i < async.length; i++)
			async[i] = newstate.async[i];
		newstate.async = async;
	}

	validated = mod_validation.validateZkState(newstate);
	if (validated instanceof Error)
		this.error(validated);
	else
		this.ms_zk.setClusterState(newstate);
	return (undefined);
};

Simulator.prototype.cmdLsPeers = function ()
{
	return (this.ms_zk.currentActiveNodes());
};

Simulator.prototype.cmdStartSimulation = function ()
{
	this.start();
};

main();
