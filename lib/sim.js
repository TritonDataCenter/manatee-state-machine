/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * sim.js: simulator for the Manatee state machine
 */

var mod_assertplus = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_events = require('events');
var mod_extsprintf = require('extsprintf');
var mod_jsprim = require('jsprim');
var mod_repl = require('repl');
var mod_util = require('util');

var mod_validation = require('./validation');
var mod_xlog = require('./xlog');

var createBunyanPrettyPrinter = require('./stream-bunyan-prettyprint');
var createManateePeer = require('./manatee-peer');
var createSimZkState = require('./sim-zk');
var createSimPgState = require('./sim-pg');
var sprintf = mod_extsprintf.sprintf;
var VError = require('verror');

module.exports = createSimulator;

function fprintf(stream)
{
	var args = Array.prototype.slice.call(arguments, 1);
	var str = sprintf.apply(null, args);
	stream.write(str);
}

function createSimulator(args)
{
	return (new Simulator(args));
}

function Simulator(args)
{
	var self = this;

	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.progName, 'args.progName');
	mod_assertplus.string(args.logLevel, 'args.logLevel');
	mod_assertplus.object(args.input, 'args.input');
	mod_assertplus.object(args.output, 'args.output');
	mod_assertplus.object(args.error, 'args.error');

	mod_events.EventEmitter.call(this);

	this.ms_logbuffer = new mod_bunyan.RingBuffer({ 'limit': 100000 });
	this.ms_log = new mod_bunyan({
	    'name': args.progName,
	    'level': args.logLevel,
	    'streams': [ {
		'type': 'raw',
		'stream': this.ms_logbuffer
	    } ]
	});

	this.ms_arg0 = args.progName;
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
	this.ms_allidents = {};
	this.ms_singleton = args.singleton || false;
	this.ms_peer = this.createSimPeer();
	this.ms_cmds_byname = {};
	this.ms_pending_cmd = null;

	this.ms_cmds = [
	    [ 'addpeer', this.cmdAddPeer, 'addpeer([ident])',
	        'simulate a new peer joining the ZK cluster' ],
	    [ 'bootstrap', this.cmdBootstrap, 'bootstrap([primary[, sync]])',
	        'simulate initial setup' ],
	    [ 'catchUp', this.cmdCatchUp, 'catchUp',
	        'simulate peer\'s postgres catching up to primary' ],
	    [ 'depose', this.cmdDepose, 'depose()',
	        'simulate a takeover from the current configuration' ],
	    [ 'rebuild', this.cmdRebuild, 'rebuild()',
	        'simulate rebuilding a deposed peer' ],
	    [ 'echo', this.cmdEcho, 'echo(str)', 'emit the string to stdout' ],
	    [ 'freeze', this.cmdFreeze, 'freeze()', 'freeze cluster' ],
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
	    [ 'unfreeze', this.cmdUnfreeze, 'unfreeze()', 'unfreeze cluster' ],
	    [ 'zk', this.cmdZk, 'zk([raw])', 'print simulated ZooKeeper state' ]
	];

	this.ms_cmds.forEach(function (c) {
		self.ms_cmds_byname[c[0]] = c[1];
	});

	/*
	 * Monitor when the peer, postgres backend, and zookeeper backend come
	 * to rest after responding to a change.  See runCmd() and onRest()
	 * below.
	 */
	this.ms_zk.on('rest', this.onRest.bind(this));
	this.ms_peer.sp_pg.on('rest', this.onRest.bind(this));
	this.ms_peer.sp_impl.on('rest', this.onRest.bind(this));
}

mod_util.inherits(Simulator, mod_events.EventEmitter);

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

	this.ms_allidents[nodename] = ident;
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
	    'self': ident,
	    'singleton': this.ms_singleton
	});

	impl.on('error', this.onFatalError.bind(this));

	return ({
	    'sp_ident': ident,
	    'sp_impl': impl,
	    'sp_zk': zk,
	    'sp_pg': pg
	});
};

Simulator.prototype.onFatalError = function (err)
{
	this.abort(err, true);
};

Simulator.prototype.abort = function (err, verbose)
{
	var self = this;
	if (verbose) {
		this.ms_error.write('\nsimulator abort!\n');
		this.cmdLog();
		this.ms_error.write(mod_util.inspect(
		    this.cmdPeer()) + '\n');
	}
	setImmediate(function () {
		self.emit('error', err);
	});
};

Simulator.prototype.start = function ()
{
	this.ms_zk.peerJoined(this.ms_peer.sp_ident);
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

Simulator.prototype.cmdEcho = function (str)
{
	fprintf(this.ms_output, '%s\n', str);
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
	fprintf(this.ms_error, '%s: %s\n', this.ms_arg0, err.message);
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
	    zkstate.sync !== null && zkstate.sync.id != peer.id) {
		zkstate.async.push(peer);
		this.ms_zk.setClusterState(zkstate);
	}

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
	    ((zkstate.primary.id != this.ms_peer.sp_ident.id &&
	    !zkstate.oneNodeWriteMode && zkstate.sync.id == name) ||
	    (!zkstate.oneNodeWriteMode &&
	    zkstate.sync.id != this.ms_peer.sp_ident.id &&
	    zkstate.primary.id == name))) {
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
	 * What's really annoying here is that "newstate" was constructed in a
	 * different JavaScript context.  As a result, even if newstate is a
	 * valid Object, it's constructor is not Object in our global scope.
	 * Similarly, its contained Array's constructor is not Array.  This
	 * breaks all kinds of things, including validation and deepCopy().  To
	 * avoid this, we create a native object from it here.
	 */
	newstate = makeNative(newstate);
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
	this.ms_peer.sp_impl.moving(); /* XXX */
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
	    'deposed': [],
	    'initWal': mod_xlog.initialXlog
	};

	this.ms_zk.setClusterState(newclusterstate);
	return (this.simpleZkState(this.ms_zk.currentClusterState()));
};

Simulator.prototype.cmdCatchUp = function ()
{
	var error = this.ms_peer.sp_pg.catchUp();
	if (error instanceof Error)
		this.error(error);
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
	    'deposed': zkstate.deposed.concat(zkstate.primary),
	    'primary': zkstate.sync,
	    'sync': zkstate.async[0],
	    'async': zkstate.async.slice(1),
	    'initWal': mod_xlog.xlogIncrementSim(zkstate.initWal, 10)
	};

	this.ms_zk.setClusterState(newstate);
	return (this.simpleZkState(this.ms_zk.currentClusterState()));
};

Simulator.prototype.cmdRebuild = function (name)
{
	var zkstate, peerid, newstate, i;

	zkstate = this.ms_zk.currentClusterState();
	if (zkstate === null) {
		this.error(new VError('cluster is not yet configured ' +
		    '(see "bootstrap")'));
		return (undefined);
	}

	if (name == this.ms_peer.sp_ident.id) {
		this.error(new VError('cannot simulate rebuild of peer ' +
		    'under test'));
		return (undefined);
	}

	for (i = 0; i < zkstate.deposed.length; i++) {
		peerid = zkstate.deposed[i];
		if (peerid.id == name)
			break;
	}

	if (i == zkstate.deposed.length) {
		this.error(new VError('peer "%s" is not deposed', name));
		return (undefined);
	}

	newstate = {
	    'generation': zkstate.generation,
	    'primary': zkstate.primary,
	    'sync': zkstate.sync,
	    'async': zkstate.async,
	    'deposed': zkstate.deposed.filter(
	        function (_, j) { return (i != j); }),
	    'initWal': zkstate.initWal
	};

	/*
	 * If we're simulating the current primary, make the newly rebuild peer
	 * an async now.
	 */
	if (zkstate.primary.id != this.ms_peer.sp_ident.id)
		newstate.async.push(peerid);

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
	var rv = this.ms_peer.sp_impl.debugState();
	rv.pg = this.ms_peer.sp_pg.debugState();

	if (!raw) {
		rv.zkstate = this.simpleZkState(rv.zkstate);
		rv.zkpeers = this.simpleZkPeers(rv.zkpeers);
	}

	return (rv);
};

Simulator.prototype.cmdFreeze = function (frozen)
{
	var zkstate;

	if (typeof (frozen) !== 'boolean')
		frozen = true;

	zkstate = this.ms_zk.currentClusterState();
	if (frozen)
		zkstate.freeze = { 'note': 'frozen by simulator' };
	else
		delete (zkstate.freeze);
	this.ms_zk.setClusterState(zkstate);
	return (this.simpleZkState(this.ms_zk.currentClusterState()));
};

Simulator.prototype.cmdUnfreeze = function ()
{
	return (this.cmdFreeze(false));
};

Simulator.prototype.simpleZkState = function (zkstate, raw)
{
	if (zkstate === null)
		return (null);

	if (raw)
		return (zkstate);

	var rv = mod_jsprim.deepCopy(zkstate);
	rv.primary = rv.primary.id;
	if (rv.sync !== null)
		rv.sync = rv.sync.id;
	rv.async = rv.async.map(function (p) { return (p.id); });
	rv.deposed = rv.deposed.map(function (p) { return (p.id); });
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

/*
 * Programmatically runs a simulator command and wait for the system to come to
 * rest again unless "wait" is specified (see below).  Always invokes "callback"
 * exactly once, upon completion as "callback(err, result)".  The only possible
 * error is a timeout error (see "timeout" below), in which case "result" is
 * null.  Upon success, "result" is the return value of the command.
 *
 * Arguments:
 *
 *     cmd	the name of the command (see help() output)
 *
 *     wait	If non-null, then waits for "wait" milliseconds and then invokes
 *     		"callback" as a success with the return value of the command.
 *     		Otherwise if "wait" is null (which is the common case), then
 *     		waits until either the timeout has elapsed (see "timeout") or
 *     		for the system to come to rest and then invokes "callback".
 *
 *     timeout	If non-null, then if the system has not come to rest before
 *     		"timeout" milliseconds, invokes "callback" with an error
 *     		indicating such.  If null, waits until the system does come to
 *     		rest before invoking "callback".  If "timeout" is not specified,
 *     		a bug in the state machine or simulator can cause this call to
 *     		block forever.
 *
 *     args	arguments to pass to the command function
 *
 *     callback	callback invoked upon completion.
 */
Simulator.prototype.runCmd = function (cmd, wait, timeout, args, callback)
{
	var self = this;
	var zk = this.ms_zk;
	var pg = this.ms_peer.sp_pg;
	var peer = this.ms_peer.sp_impl;
	var func, rv;

	mod_assertplus.ok(this.ms_cmds_byname.hasOwnProperty(cmd),
	    'command "' + cmd + '" does not exist');
	mod_assertplus.ok(this.ms_pending_cmd === null,
	    'last command is still running');

	func = this.ms_cmds_byname[cmd];
	rv = func.apply(this, args);

	if (wait !== null) {
		/*
		 * The "wait" behavior takes precedence.  It's intended for
		 * cases where we expect the system will not come to rest
		 * without additional outside intervention.  One example of this
		 * is when we're the sync, the primary has failed, but we're not
		 * caught up yet and so can't take over.  We will not make
		 * forward progress until the primary comes back or we catch up.
		 */
		setTimeout(function () { callback(null, rv); }, wait);
	} else if (!peer.atRest() || !zk.atRest() || !pg.atRest()) {
		/*
		 * If the system is not at rest, wait for it to come to rest.
		 * We have 'rest' handlers for the peer, ZK backend, and
		 * postgres backend that will wake up the caller when all three
		 * have come to rest.  See onRest() below.
		 */
		this.ms_pending_cmd = {
		    'cmd': cmd,
		    'args': args,
		    'timeout': timeout,
		    'callback': callback,
		    'rv': rv,
		    'toid': timeout === null ? null :
		        setTimeout(function () {
				self.ms_pending_cmd = null;
				callback(new VError(
				    'command "%s" timed out', cmd));
			}, timeout)
		};
	} else {
		/*
		 * If the system is already at rest, invoke the callback
		 * immediately (but asynchronously).
		 */
		setImmediate(callback, null, rv);
	}
};

/*
 * Handler for the event that the peer, ZK backend, or postgres backend have
 * come to rest.  If all three have come to rest and there's a pending command,
 * complete the command.
 */
Simulator.prototype.onRest = function ()
{
	if (this.ms_pending_cmd === null ||
	    !this.ms_zk.atRest() ||
	    !this.ms_peer.sp_pg.atRest() ||
	    !this.ms_peer.sp_impl.atRest())
		return;

	var cmd = this.ms_pending_cmd;
	this.ms_pending_cmd = null;
	if (cmd.toid !== null)
		clearTimeout(cmd.toid);
	cmd.callback(null, cmd.rv);
};

/*
 * Given an acyclic, plain-old JavaScript object constructed from another
 * context that contains nothing but Objects, Arrays, and booleans, construct an
 * identical object using our native Object and Array constructors.
 */
function makeNative(obj)
{
	var rv, i;

	if (typeof (obj) != 'object')
		return (obj);

	if (obj === null)
		return (null);

	if (obj.constructor.name == 'Array') {
		rv = new Array(obj.length);
		for (i = 0; i < rv.length; i++)
			rv[i] = makeNative(obj[i]);
		return (rv);
	}

	mod_assertplus.equal(obj.constructor.name, 'Object');
	rv = {};
	for (i in obj)
		rv[i] = makeNative(obj[i]);
	return (rv);
}
