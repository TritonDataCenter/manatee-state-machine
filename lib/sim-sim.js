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
	    'output': process.stdout,
	    'error': process.stderr
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
	mod_assertplus.object(args.error, 'args.error');

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
	this.ms_error = args.error;

	this.ms_zk = createSimZkState({
	    'log': this.ms_log.child({ 'component': 'zk' })
	});

	this.ms_pg = createSimPgState({
	    'log': this.ms_log.child({ 'component': 'pg' }),
	    'zk': this.ms_zk
	});

	this.ms_nextpeer = 1;
	this.ms_peer = this.createSimPeer();
	this.ms_allidents = {};

	this.ms_cmds = [
	    [ 'addpeer', this.cmdAddPeer, 'addpeer([ident])',
	        'simulate a new peer joining the ZK cluster' ],
	    [ 'bootstrap', this.cmdBootstrap, 'bootstrap([primary[, sync]])',
	        'simulate initial setup' ],
	    [ 'depose', this.cmdDepose, 'depose()',
	        'simulate a takeover from the current configuration' ],
	    [ 'help', this.cmdHelp, 'help()', 'show help output' ],
	    [ 'ident', this.cmdIdent, 'ident()',
	        'print identity of the peer being tested' ],
	    [ 'log', this.cmdLog, 'log()', 'dump peer\'s bunyan log' ],
	    [ 'lspeers', this.cmdLsPeers, 'lspeers([raw])',
	        'list simulated peers' ],
	    [ 'peer', this.cmdPeer, 'peer([raw])',
	        'dump peer\'s current state' ],
	    [ 'rmpeer', this.cmdRmPeer, 'rmpeer(id)',
	        'simulate a peer being removed from the ZK cluster' ],
	    [ 'setClusterState', this.cmdSetClusterState,
	        'setClusterState(clusterState)',
		'simulate a write to the cluster state stored in ZK' ],
	    [ 'startPeer', this.cmdStartPeer, 'startPeer()',
	        'start the peer state machine' ],
	    [ 'zk', this.cmdZk, 'zk([raw])', 'print simulated ZooKeeper state' ]
	];
}

Simulator.prototype.createPeerIdent = function (nameoverride)
{
	var which, nodename, ip, ident;

	which = this.ms_nextpeer++;
	nodename = nameoverride !== undefined ? nameoverride : 'node' + which;
	ip = '10.0.0.' + which;
	ident = {
	    'id': nodename,
	    'ip': ip,
	    'pgUrl': 'tcp://postgres@' + ip + ':5432/postgres',
	    'zoneId': nodename
	};
	return (ident);
};

Simulator.prototype.createSimPeer = function ()
{
	var zk, pg;
	var ident, impl;

	ident = this.createPeerIdent();
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
	fprintf(this.ms_error, '%s: %s\n', arg0, err.message);
};

Simulator.prototype.cmdIdent = function ()
{
	return (this.ms_peer.sp_ident);
};

Simulator.prototype.cmdZk = function (raw)
{
	return ({
	    'clusterState': this.simpleZkState(
	        this.ms_zk.currentClusterState(), raw),
	    'activeNodes': this.simpleZkPeers(
	        this.ms_zk.currentActiveNodes(), raw)
	});
};

Simulator.prototype.cmdAddPeer = function (ident)
{
	var peer, zkstate;

	/*
	 * If this is the name of a peer we had added before (and presumably
	 * removed), then reuse the other identifying details (the IP address,
	 * postgres URL, and so on).
	 */
	if (ident !== undefined && this.ms_allidents.hasOwnProperty(ident))
		peer = this.ms_allidents[ident];
	else
		peer = this.createPeerIdent(
		    typeof (ident) == 'string' ? ident : undefined);

	if (!this.ms_zk.peerJoined(peer)) {
		this.error(new VError('peer already exists: "%s"', peer.id));
		return (undefined);
	}

	/*
	 * If the primary is one of the simulated peers, then simulate the
	 * behavior where the primary adds new peers to the async list.
	 */
	zkstate = this.ms_zk.currentClusterState();
	if (zkstate !== null &&
	    zkstate.primary.id != this.ms_peer.sp_ident.id &&
	    zkstate.primary.id != peer.id &&
	    zkstate.sync.id != peer.id) {
		zkstate.async.push(peer);
		this.ms_zk.setClusterState(zkstate);
	}

	this.ms_allidents[peer.id] = peer;
	return (this.simpleZkPeers(this.ms_zk.currentActiveNodes()));
};

Simulator.prototype.cmdRmPeer = function (name)
{
	var zkstate;

	if (typeof (name) != 'string') {
		this.error(new VError('expected peer name'));
		return (undefined);
	}

	if (name == this.ms_peer.sp_ident.id) {
		this.error(new VError('cannot remove peer under test'));
		return (undefined);
	}

	/*
	 * Don't allow the user to a peer that will require us to simulate a new
	 * cluster state.  This means removing the sync when we're simulating
	 * the primary or removing the primary when we're simulating the sync.
	 */
	zkstate = this.ms_zk.currentClusterState();
	if (zkstate !== null &&
	    (zkstate.primary.id != this.ms_peer.sp_ident.id &&
	    zkstate.sync.id == name) ||
	    (zkstate.sync.id != this.ms_peer.sp_ident.id &&
	    zkstate.primary.id == name)) {
		this.error(new VError('cannot remove simulated peer when ' +
		    'another simulated peer would have to takeover ' +
		    '(try "depose")'));
		return (undefined);
	}

	if (!this.ms_zk.peerRemoved(name)) {
		this.error(new VError('peer not present: "%s"', name));
		return (undefined);
	}

	return (this.simpleZkPeers(this.ms_zk.currentActiveNodes()));
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

Simulator.prototype.cmdLsPeers = function (raw)
{
	return (this.simpleZkPeers(this.ms_zk.currentActiveNodes(), raw));
};

Simulator.prototype.cmdStartPeer = function ()
{
	this.start();
};

Simulator.prototype.cmdBootstrap = function (primarywanted, syncwanted)
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
			if (peers[i].id == primarywanted)
				primary = i;
			else if (syncwanted !== undefined &&
			    peers[i].id == syncwanted)
				sync = i;
			else if (syncwanted === undefined &&
			    sync === undefined)
				sync = i;
			else
				asyncs.push(peers[i]);
		}

		if (primary === undefined) {
			this.error(new VError('requested primary "%s" ' +
			    'not found', primarywanted));
			return (undefined);
		}

		if (sync === undefined) {
			this.error(new VError('requested sync "%s" ' +
			    'not found', syncwanted));
			return (undefined);
		}
	} else {
		primary = 0;
		sync = 1;
		asyncs = peers.slice(2);
		fprintf(this.ms_output, 'bootstrap: selected "%s" as primary\n',
		    peers[primary].id);
	}

	newclusterstate = {
	    'generation': 1,
	    'primary': peers[primary],
	    'sync': peers[sync],
	    'async': asyncs,
	    'initWal': '0'
	};

	this.ms_zk.setClusterState(newclusterstate);
	return (this.simpleZkState(this.ms_zk.currentClusterState()));
};

Simulator.prototype.cmdDepose = function (force)
{
	var zkstate, newstate;

	zkstate = this.ms_zk.currentClusterState();
	if (zkstate === null) {
		this.error(new VError('cluster is not yet configured ' +
		    '(see "bootstrap")'));
		return (undefined);
	}

	if (zkstate.async.length === 0) {
		this.error(new VError('cannot depose with no asyncs'));
		return (undefined);
	}

	newstate = {
	    'generation': zkstate.generation + 1,
	    'primary': zkstate.sync,
	    'sync': zkstate.async[0],
	    'async': zkstate.async.slice(1),
	    'initWal': zkstate.initWal
	};

	this.ms_zk.setClusterState(newstate);
	return (this.simpleZkState(this.ms_zk.currentClusterState()));
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

Simulator.prototype.cmdPeer = function (raw)
{
	var rv = this.ms_peer.sp_impl.debugState(raw);
	rv.pg = this.ms_peer.sp_pg.debugState();

	if (!raw) {
		rv.zkstate = this.simpleZkState(rv.zkstate);
		rv.zkpeers = this.simpleZkPeers(rv.zkpeers);
	}

	return (rv);
};

Simulator.prototype.simpleZkState = function (zkstate, raw)
{
	if (zkstate === null)
		return (null);

	if (raw)
		return (zkstate);

	var rv = mod_jsprim.deepCopy(zkstate);
	rv.primary = rv.primary.id;
	rv.sync = rv.sync.id;
	rv.async = rv.async.map(function (p) { return (p.id); });
	return (rv);
};

Simulator.prototype.simpleZkPeers = function (zkpeers, raw)
{
	if (zkpeers === null)
		return (null);

	if (raw)
		return (zkpeers);

	/* JSSTYLED */
	return (zkpeers.map(function (p) { return (p.id); }));
};

main();
