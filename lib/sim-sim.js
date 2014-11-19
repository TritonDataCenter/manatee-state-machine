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
	var sim;

	sim = createSimulator({
	    'logName': arg0,
	    'logLevel': process.env['LOG_LEVEL'] || 'debug',
	    'input': process.stdin,
	    'output': process.stdout
	});

	sim.startRepl();
}

function createSimulator(args)
{
	return (new Simulator(args));
}

function Simulator(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.logName, 'args.logName');
	mod_assertplus.string(args.logLevel, 'args.logLevel');
	mod_assertplus.object(args.input, 'args.input');
	mod_assertplus.object(args.output, 'args.output');

	this.ms_logbuffer = new mod_bunyan.RingBuffer({ 'limit': 100000 });
	this.ms_log = new mod_bunyan({
	    'name': args.logName,
	    'level': args.logLevel,
	    'streams': [ {
		'type': 'raw',
		'stream': this.ms_logbuffer
	    } ]
	});

	this.ms_input = args.input;
	this.ms_output = args.output;

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
	    [ 'log', this.cmdLog, 'log()', 'dump peer\'s bunyan log' ],
	    [ 'lspeers', this.cmdLsPeers, 'lspeers()',
	        'list simulated peers' ],
	    [ 'addpeer', this.cmdAddPeer, 'addpeer([ident])',
	        'simulate a new peer joining the ZK cluster' ],
	    [ 'rmpeer', this.cmdRmPeer, 'rmpeer(id)',
	        'simulate a peer being removed from the ZK cluster' ],
	    [ 'bootstrap', this.cmdBootstrap, 'bootstrap([primary])',
	        'simulate initial setup' ],
	    [ 'setClusterState', this.cmdSetClusterState,
	        'setClusterState(clusterState)',
		'simulate a write to the cluster state stored in ZK' ],
	    [ 'startPeer', this.cmdStartPeer, 'startPeer()',
	        'start the peer state machine' ]
	];
}

Simulator.prototype.createSimPeer = function ()
{
	var zk, pg;
	var nodename, ip, ident, impl;
	var which = this.ms_nextpeer++;

	nodename = 'node' + which;
	ip = '10.0.0.' + (which + 1);
	ident = {
	    'zonename': nodename,
	    'ip': ip
	};
	zk = this.ms_zk.createZkClient(ident);
	pg = this.ms_pg.createPgClient(ident);

	impl = createManateePeer({
	    'log': this.ms_log.child({ 'component': 'peer'}),
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

Simulator.prototype.startRepl = function ()
{
	var out, repl, sim;

	out = this.ms_output;
	fprintf(out, 'Welcome to the Manatee single-node simulator!\n');
	fprintf(out, 'For help, type "help()".\n');

	sim = this;
	repl = mod_repl.start({
	    'prompt': 'msim> ',
	    'ignoreUndefined': true,
	    'input': this.ms_input,
	    'output': this.ms_output
	});

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
		    'ip': '10.0.0.0'
		};
	} else {
		peer = {
		    'zonename': 'node' + (this.ms_nextpeer++),
		    'ip': '10.0.0.0'
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

Simulator.prototype.cmdStartPeer = function ()
{
	this.start();
};

Simulator.prototype.cmdBootstrap = function (primarywanted)
{
	var peers, i;
	var primary, sync, asyncs, newclusterstate;

	if (this.ms_zk.currentClusterState() !== null) {
		this.error(new VError('cluster is already set up'));
		return (undefined);
	}

	peers = this.ms_zk.currentActiveNodes();
	if (peers.length < 2) {
		this.error(new VError('need at least two nodes for setup'));
		return (undefined);
	}

	if (primarywanted !== undefined) {
		asyncs = [];
		for (i = 0; i < peers.length; i++) {
			if (peers[i].zonename == primarywanted)
				primary = i;
			else if (sync === undefined)
				sync = i;
			else
				asyncs.push(peers[i]);
		}

		if (primary === undefined) {
			this.error(new VError('requested primary "%s" ' +
			    'not found', primarywanted));
			return (undefined);
		}

		mod_assertplus.ok(sync !== undefined);
	} else {
		primary = 0;
		sync = 1;
		asyncs = peers.slice(2);
		fprintf(this.ms_output, 'bootstrap: selected "%s" as primary\n',
		    peers[primary].zonename);
	}

	newclusterstate = {
	    'generation': 1,
	    'primary': peers[primary],
	    'sync': peers[sync],
	    'async': asyncs,
	    'initWal': '0'
	};

	this.ms_zk.setClusterState(newclusterstate);
	return (undefined);
};

Simulator.prototype.cmdLog = function (nlines)
{
	var records, logstream;

	records = this.ms_logbuffer.records;
	if (typeof (nlines) == 'number')
		records = records.slice(records.length - nlines);

	logstream = createBunyanPrettyPrinter();
	logstream.pipe(this.ms_output);
	records.forEach(function (r) { logstream.write(r); });
};

main();
