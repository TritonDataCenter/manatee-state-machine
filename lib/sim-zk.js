/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * sim-zk.js: simulates a simple ZooKeeper cluster and ZK clients
 */

var mod_assertplus = require('assert-plus');
var mod_events = require('events');
var mod_jsprim = require('jsprim');
var mod_util = require('util');
var EventEmitter = mod_events.EventEmitter;

/* Public interface */
module.exports = createSimZkState;

function createSimZkState(args)
{
	return (new SimZkState(args));
}

/*
 * The SimZkState represents a simulated ZooKeeper cluster that keeps track of
 * the Manatee cluster state and the list of active nodes.  There's one ZkState
 * per simulated Manatee cluster.  We then instantiate a SimZkClient for each
 * peer in the cluster.  The SimZkClient interface implements the interface that
 * the ManateePeer expects (which supports updating cluster state and being
 * notified about changes), backed by the simulated ZK cluster state.
 *
 * Like the manatee peer and postgres client interfaces, this object emits
 * 'rest' when it has come to rest after responding to a change.  See atRest().
 */
function SimZkState(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.log, 'args.log');

	EventEmitter.call(this);

	this.mzk_log = args.log;
	this.mzk_state = null;
	this.mzk_peerspresent = [];
	this.mzk_clients = [];
	this.mzk_busy = 0;
}

mod_util.inherits(SimZkState, EventEmitter);

SimZkState.prototype.atRest = function ()
{
	mod_assertplus.ok(this.mzk_busy >= 0);
	return (this.mzk_busy === 0);
};

SimZkState.prototype.moving = function ()
{
	mod_assertplus.ok(this.mzk_busy >= 0);
	this.mzk_busy++;
};

SimZkState.prototype.rest = function ()
{
	mod_assertplus.ok(this.mzk_busy > 0);
	this.mzk_busy--;
	if (this.mzk_busy === 0)
		this.emit('rest');
};

/*
 * Returns an object implementing the ZK state machine interface.
 */
SimZkState.prototype.createZkClient = function (ident)
{
	var zkclient = new SimZkClient(this, ident);
	this.mzk_clients.push(zkclient);
	this.mzk_peerspresent.push(ident);
	return (zkclient);
};

SimZkState.prototype.findPeer = function (ident)
{
	var i;

	for (i = 0; i < this.mzk_peerspresent.length; i++) {
		if (this.mzk_peerspresent[i].id == ident.id)
			return (i);
	}

	return (-1);
};

/*
 * Simulator interface: act like a new peer joined.
 */
SimZkState.prototype.peerJoined = function (ident)
{
	var zk = this;

	if (this.findPeer(ident) != -1)
		return (false);

	this.mzk_peerspresent.push(ident);
	this.moving();
	setImmediate(function () {
		zk.mzk_clients.forEach(
		    function (c) { return (c.notifyPeersChanged()); });
		zk.rest();
	});
	return (true);
};

/*
 * Simulator interface: act like a peer was removed.
 */
SimZkState.prototype.peerRemoved = function (name)
{
	var zk = this;
	var i = this.findPeer({ 'id': name });

	if (i == -1)
		return (false);

	this.mzk_peerspresent.splice(i, 1);
	this.moving();
	setImmediate(function () {
		zk.mzk_clients.forEach(
		    function (c) { return (c.notifyPeersChanged()); });
		zk.rest();
	});
	return (true);
};

/*
 * Simulator interface: modify the cluster state.
 */
SimZkState.prototype.setClusterState = function (newstate)
{
	var zk = this;
	this.mzk_state = newstate;
	this.moving();
	setImmediate(function () {
		zk.mzk_clients.forEach(
		    function (c) { return (c.notifyStateChanged()); });
		zk.rest();
	});
};

SimZkState.prototype.currentActiveNodes = function ()
{
	return (mod_jsprim.deepCopy(this.mzk_peerspresent));
};

SimZkState.prototype.currentClusterState = function ()
{
	return (mod_jsprim.deepCopy(this.mzk_state));
};

/*
 * Per-peer client interface.  This is separated from the SimZkState object so
 * that we can simulate different peers receiving notifications at different
 * times.
 */
function SimZkClient(zkstate, ident)
{
	mod_assertplus.object(zkstate, 'zkstate');
	mod_assertplus.ok(zkstate instanceof SimZkState);
	mod_assertplus.object(ident, 'ident');
	mod_assertplus.string(ident.id, 'ident.id');

	EventEmitter.call(this);
	this.szc_zk = zkstate;
	this.szc_ident = ident;
	this.szc_init = false;
}

mod_util.inherits(SimZkClient, EventEmitter);

SimZkClient.prototype.startSimulation = function ()
{
	var client = this;

	/*
	 * Simulate initial client connection.
	 */
	client.szc_zk.moving();
	setTimeout(function () {
		client.szc_zk.rest();
		client.szc_init = true;
		client.emit('init', {
		    'clusterState': client.szc_zk.currentClusterState(),
		    'active': client.szc_zk.currentActiveNodes()
		});
	}, 100);
};

SimZkClient.prototype.putClusterState = function (newstate, callback)
{
	var zk = this.szc_zk;

	setTimeout(function () {
		zk.setClusterState(newstate);
		callback();
	}, 100);
};

SimZkClient.prototype.notifyStateChanged = function ()
{
	if (!this.szc_init)
		return;

	this.emit('clusterStateChange', this.szc_zk.currentClusterState());
};

SimZkClient.prototype.notifyPeersChanged = function ()
{
	if (!this.szc_init)
		return;

	this.emit('activeChange', this.szc_zk.currentActiveNodes());
};
