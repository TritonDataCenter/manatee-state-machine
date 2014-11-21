/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * sim-pg.js: simulates a simple postgres cluster and postgres clients
 */

var mod_assertplus = require('assert-plus');
var mod_events = require('events');
var mod_jsprim = require('jsprim');
var mod_util = require('util');
var EventEmitter = mod_events.EventEmitter;
var VError = require('verror');

/* Public interface */
module.exports = createSimPgState;

function createSimPgState(args)
{
	return (new SimPgState(args));
}

/*
 * The SimPgState represents a simulated Postgres cluster that keeps track of
 * the Postgres cluster state and the list of active nodes.  As with the ZK
 * simulation, there's one simulated state per Manatee cluster and we
 * instantiate different clients for each peer to allow us to support delivering
 * notifications at different times.
 *
 * This is a single-client simulator.  It uses the underlying ZK state to figure
 * out if the caller is primary, sync, or async, and to simulate the transaction
 * log position accordingly.
 */
function SimPgState(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.log, 'args.log');
	mod_assertplus.object(args.zk, 'args.zk');

	this.mpg_log = args.log;
	this.mpg_zk = args.zk;
}

SimPgState.prototype.createPgClient = function (ident)
{
	return (new SimPgClient(this, ident, this.mpg_log.child(
	    { 'nodename': ident.id })));
};

function SimPgClient(pgstate, ident, log)
{
	mod_assertplus.object(ident, 'ident');
	mod_assertplus.string(ident.id, 'ident.id');
	mod_assertplus.object(log, 'log');

	this.spg_ident = ident;
	this.spg_pgstate = pgstate;
	this.spg_log = log;
	this.spg_init = false;
	this.spg_config = null;
	this.spg_config_next = null;
	this.spg_online = false;
	this.spg_transitioning = false;
	this.spg_xlog = 0;
	this.spg_xlog_waiting = null;

	EventEmitter.call(this);
}

mod_util.inherits(SimPgClient, EventEmitter);

SimPgClient.prototype.debugState = function ()
{
	var rv = {};
	var notes = [];

	rv.config = mod_jsprim.deepCopy(this.spg_config);

	if (this.spg_transitioning)
		notes.push('transitioning');
	if (this.spg_xlog_waiting !== null)
		notes.push('catching up');

	if (notes.length > 0)
		rv.notes = notes;

	rv.online = this.spg_online;
	rv.xlog = this.spg_xlog.toString();
	return (rv);
};

SimPgClient.prototype.startSimulation = function ()
{
	var client = this;

	setTimeout(function () {
		client.spg_init = true;
		client.emit('init', false);
	}, 100);
};

SimPgClient.prototype.start = function (callback)
{
	mod_assertplus.ok(this.spg_config !== null,
	    'cannot call start() before configured');
	mod_assertplus.ok(!this.spg_transitioning,
	    'cannot call start() while transitioning');
	mod_assertplus.ok(!this.spg_online,
	    'cannot call start() after started');

	var client = this;
	var log = this.spg_log;
	var zkstate = this.spg_pgstate.mpg_zk.currentClusterState();

	mod_assertplus.ok(this.spg_xlog_waiting === null);
	this.spg_transitioning = true;
	log.info('starting postgres');
	setTimeout(function () {
		log.info('postgres started');
		client.spg_transitioning = false;
		client.spg_online = true;
		mod_assertplus.ok(client.spg_xlog_waiting === null);
		client.updateXlog(zkstate);
		callback();
	}, 1000);
};

SimPgClient.prototype.stop = function (callback)
{
	mod_assertplus.ok(!this.spg_transitioning,
	    'cannot call stop() while transitioning');
	mod_assertplus.ok(this.spg_online,
	    'cannot call stop() while stopped');

	var client = this;
	var log = this.spg_log;

	this.spg_xlog_waiting = null;
	this.spg_transitioning = true;
	log.info('stopping postgres');
	setTimeout(function () {
		log.info('postgres stopped');
		client.spg_transitioning = false;
		client.spg_online = false;
		callback();
	}, 1000);
};

SimPgClient.prototype.reconfigure = function (config, callback)
{
	mod_assertplus.ok(!this.spg_transitioning,
	    'cannot call reconfigure() while transitioning');

	config = mod_jsprim.deepCopy(config);

	var client = this;
	var log = this.spg_log;
	var zkstate;

	/*
	 * Although this state could change by the time we finish configuration,
	 * we want to act on the current state and allow the caller to
	 * reconfigure as needed.
	 */
	zkstate = client.spg_pgstate.mpg_zk.currentClusterState();
	if (zkstate === null) {
		mod_assertplus.equal(config.role, 'none',
		    'attempted to configure postgres with no ZK state');
	}

	this.spg_xlog_waiting = null;
	this.spg_transitioning = true;
	log.info('reconfiguring postgres');
	setTimeout(function () {
		log.info('postgres reconfigured');
		client.spg_transitioning = false;
		client.spg_config = config;
		mod_assertplus.ok(client.spg_xlog_waiting === null);
		client.updateXlog(zkstate);
		callback();
	}, 1000);
};

/*
 * Given the current zookeeper state, figure out our current role and update our
 * xlog position accordingly.  This is used when we assume a new role or when
 * postgres comes online in order to simulate client writes to the primary,
 * synchronous replication (and catch-up) on the sync, and asynchronous
 * replication on the other peers.
 */
SimPgClient.prototype.updateXlog = function (zkstate)
{
	var pgurl, genxlog, role;

	if (zkstate === null || !this.spg_online || this.spg_config === null)
		/* Don't do anything while Postgres is offline. */
		return;

	pgurl = this.spg_ident.pgUrl;
	genxlog = parseInt(zkstate.initWal, 10);

	if (zkstate.primary.pgUrl == pgurl)
		role = 'primary';
	else if (zkstate.sync.pgUrl == pgurl) {
		mod_assertplus.equal(this.spg_config.role, 'sync');
		role = 'sync';
	} else if (this.spg_config.role == 'async')
		role = 'async';
	else
		role = 'none';

	/*
	 * If the peer we're testing is an async or unassigned, we don't modify
	 * the transaction log position at all.  We act as though these are
	 * getting arbitrarily far behind (since that should be fine).
	 */
	if (role == 'async' || role == 'none')
		return;

	/*
	 * If the peer we're testing is a primary, we act as though the sync
	 * instantly connected and caught up, and we start taking writes
	 * immediately and bump the transaction log position.
	 */
	if (role == 'primary') {
		mod_assertplus.ok(genxlog <= this.spg_xlog,
		    'primary is behind the generation\'s initial xlog');
		this.spg_xlog += 10;
		return;
	}

	/*
	 * The most complicated case is the sync, for which we need to schedule
	 * the wal position to catch up to the primary's.
	 */
	mod_assertplus.equal(role, 'sync');
	mod_assertplus.ok(genxlog >= this.spg_xlog,
	    'sync is ahead of the primary!');
	this.spg_xlog_waiting = genxlog;
};

SimPgClient.prototype.getXLogLocation = function (callback)
{
	var error, result;

	if (!this.spg_online) {
		error = new VError('postgres is offline');
		result = null;
	} else {
		error = null;
		result = this.spg_xlog.toString();
	}

	setTimeout(callback, 10, error, result);
};

SimPgClient.prototype.catchUp = function ()
{
	if (this.spg_xlog_waiting === null)
		return (new VError('not sync or not currently waiting'));

	/*
	 * Act like not only did we catch up, but we received additional
	 * writes from the primary.
	 */
	this.spg_xlog = this.spg_xlog_waiting + 10;
	this.spg_xlog_waiting = null;
	return (null);
};
