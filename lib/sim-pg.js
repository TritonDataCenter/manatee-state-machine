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
 * Right now, this is super simple and basically stateless.  In principle, this
 * interface could support simulating more complex postgres semantics, like the
 * inability to replicate to a postgres peer that's logically ahead of the
 * source.
 */
function SimPgState(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.log, 'args.log');

	this.mpg_log = args.log;
}

SimPgState.prototype.createPgClient = function (ident)
{
	return (new SimPgClient(ident, this.mpg_log.child(
	    { 'nodename': ident.zonename })));
};

function SimPgClient(ident, log)
{
	mod_assertplus.object(ident, 'ident');
	mod_assertplus.string(ident.zonename, 'ident.zonename');
	mod_assertplus.object(log, 'log');

	this.spg_ident = ident;
	this.spg_log = log;
	this.spg_init = false;
	this.spg_config = null;
	this.spg_config_next = null;
	this.spg_online = false;
	this.spg_transitioning = false;
	this.spg_xlog = '0';	/* TODO simulate this better */

	EventEmitter.call(this);
}

mod_util.inherits(SimPgClient, EventEmitter);

SimPgClient.prototype.startSimulation = function ()
{
	var client = this;

	setTimeout(function () {
		client.spg_init = true;
		client.emit('init', null);
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
	this.spg_transitioning = true;
	log.info('starting postgres');
	setTimeout(function () {
		log.info('postgres started');
		client.spg_transitioning = false;
		client.spg_online = true;
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
	this.spg_transitioning = true;
	log.info('reconfiguring postgres');
	setTimeout(function () {
		log.info('postgres reconfigured');
		client.spg_transitioning = false;
		client.spg_config = config;
		callback();
	}, 1000);
};

SimPgClient.prototype.getXLogLocation = function (callback)
{
	setTimeout(callback, 10, null, this.spg_xlog);
};
