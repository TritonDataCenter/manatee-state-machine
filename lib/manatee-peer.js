/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * manatee-peer.js: implementation of the core Manatee peer state machine
 */

var mod_assertplus = require('assert-plus');
var mod_events = require('events');
var mod_jsprim = require('jsprim');
var mod_util = require('util');
var mod_vasync = require('vasync');
var VError = require('verror');

var mod_validation = require('./validation');
var mod_xlog = require('./xlog');
var EventEmitter = mod_events.EventEmitter;

/* Public interface */
module.exports = createPeer;

/*
 * Predefined roles
 */
var MP_ROLE_PRIMARY    = 'primary';
var MP_ROLE_SYNC       = 'sync';
var MP_ROLE_ASYNC      = 'async';
var MP_ROLE_UNASSIGNED = 'unassigned';
var MP_ROLE_DEPOSED    = 'deposed';
var MP_ROLE_UNKNOWN    = 'unknown';

/*
 * State transition handlers.  These are tightly coupled to the ManateePeer
 * class, and may as well be methods of that class, except that separating them
 * out is a little cleaner.  Each of these has the signature:
 *
 *     func(peer, eventname[, eventarg1, ...])
 *
 * where "peer" is a ManateePeer object.
 */
var manateeStateHandlers = {
    'pg': {
	'init': manateeOnPgInit
    },
    'zk': {
	'init': manateeOnZkInit,
	'activeChange': manateeOnZkActiveChange,
	'clusterStateChange': manateeOnZkClusterStateChange
    }
};


/*
 * Manatee peer implementation
 *
 * As described in the README, there are really two state machines here: the
 * peer state machine, which is implemented by software and executed
 * independently on each Manatee peer, and the overall cluster state machine,
 * which determines the operational status of the Manatee cluster.  The cluster
 * state machine is not directly executed by software; it's just what results
 * from the independent execution of the peer state machines.
 *
 * This component implements the peer state machine in terms of a relatively
 * narrow interface that can be implemented either by an actual backend (as when
 * deployed in production) or a simulator.
 *
 * Arguments:
 *
 *     log		bunyan-style logger
 *
 *     zkinterface	implements the Peer ZooKeeper interface (see below)
 *
 *     pginterface	implements the Peer Postgres interface (see below)
 *
 *     self		identifier for this node, which includes "id", "zoneId",
 *     			"ip", and "pgUrl".  See the schemas.
 *
 *     singleton	indicates that this peer is the only peer in the cluster
 *     (aka "one-node-
 *     "write-mode")
 *
 * The interfaces (including methods, events, and data types) are described in
 * the README.
 *
 * For testing purposes, this object emits "rest" events when a sequence of
 * transitions has completed.  This is used by the test suite to know when the
 * peer has finished responding to something.
 */
function createPeer(args)
{
	return (new ManateePeer(args));
}

function ManateePeer(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.log, 'args.log');
	mod_assertplus.object(args.self, 'args.self');
	mod_assertplus.string(args.self.id, 'args.self.id');
	mod_assertplus.string(args.self.ip, 'args.self.ip');
	mod_assertplus.string(args.self.pgUrl, 'args.self.pgUrl');
	mod_assertplus.string(args.self.zoneId, 'args.self.zoneId');
	mod_assertplus.object(args.zkinterface, 'args.zkinterface');
	mod_assertplus.object(args.pginterface, 'args.pginterface');
	mod_assertplus.optionalBool(args.singleton, 'args.singleton');

	EventEmitter.call(this);

	/* configuration */
	this.mp_id = args.self.id;
	this.mp_ident = mod_jsprim.deepCopy(args.self);
	this.mp_singleton = args.singleton ? true : false;

	/* helpers */
	this.mp_log = args.log;
	this.mp_zk = args.zkinterface;
	this.mp_pg = args.pginterface;

	/* dynamic state */
	this.mp_role = MP_ROLE_UNKNOWN;	/* current role */
	this.mp_gen = -1;		/* last generation update processed */
	this.mp_updating = false;	/* currently updating ZK state */
	this.mp_updating_state = null;	/* new state object */

	this.mp_zkstate = null;		/* last received cluster state */
	this.mp_zkpeers = null;		/* last received list of peers */
	this.mp_pg_online = null;	/* null for unknown; else boolean */
	this.mp_pg_setup = null;	/* whether db existed at start */
	this.mp_pg_applied = null;	/* last configuration applied */
	this.mp_pg_transitioning = false;	/* boolean */
	this.mp_pg_retrypending = null;
	this.mp_pg_nretries = 0;	/* consecutive failed retries */
	this.mp_pg_upstream = null;	/* upstream replication target */

	/*
	 * Moving vs. at-rest state: see atRest() for how this is used.  To
	 * modify this, use the moving() or rest() methods.  We use a nullable
	 * timestamp instead of a boolean to facilitate debugging.
	 */
	this.mp_moving = null;

	this.bindHandlers(this.mp_pg, 'pg', manateeStateHandlers['pg']);
	this.bindHandlers(this.mp_zk, 'zk', manateeStateHandlers['zk']);
}

mod_util.inherits(ManateePeer, EventEmitter);

ManateePeer.prototype.debugState = function ()
{
	var rv, pending;

	rv = {};
	pending = [];
	rv.id = this.mp_id;
	rv.role = this.mp_role;
	if (this.mp_pg_transitioning)
		pending.push('postgres transition');
	if (this.mp_pg_retrypending)
		pending.push('pg retry');
	if (this.mp_updating)
		pending.push('cluster write or wait');
	if (pending.length > 0)
		rv.pending = pending;
	rv.zkstate = mod_jsprim.deepCopy(this.mp_zkstate);
	rv.zkpeers = mod_jsprim.deepCopy(this.mp_zkpeers);

	return (rv);
};

/*
 * Helper function used during initialization to bind each of the "handlers" to
 * events on "emitter".
 */
ManateePeer.prototype.bindHandlers = function (emitter, source, handlers)
{
	var peer = this;
	mod_jsprim.forEachKey(handlers, function (eventname, handler) {
		emitter.on(eventname, function handleEvent() {
			var args = Array.prototype.slice.call(arguments);
			peer.handleEvent(handler, source, eventname, args);
		});
	});
};

/*
 * Returns false if this peer is currently attempting to change state (either
 * writing to ZK, reconfiguring postgres, or the like).  This is used primarily
 * by the test suite to determine whether the state machine is currently
 * transitioning or has come to rest at the current state.
 */
ManateePeer.prototype.atRest = function ()
{
	return (this.mp_moving === null);
};

ManateePeer.prototype.moving = function ()
{
	if (this.mp_moving === null) {
		this.mp_log.trace('started moving');
		this.mp_moving = new Date();
	} else {
		this.mp_log.trace('moving (already moving)');
	}
};

ManateePeer.prototype.rest = function ()
{
	/*
	 * This is admittedly goofy, but it's possible to see cluster state
	 * change events that would normally cause us to come to rest, but if
	 * there's still a postgres transitioning happening, we're still moving.
	 * Similarly, if we're in the middle of an update and we come to rest
	 * because a postgres transition completed, then wait for the update to
	 * finish.
	 */
	if (this.mp_pg_transitioning || this.mp_updating)
		return;

	this.mp_moving = null;
	this.mp_log.trace('coming to rest');
	this.emit('rest');
};

/*
 * Common code for handling all events.  Currently we just log the event and
 * pass it off to the more specific handler, but this could also be used to
 * add DTrace probes.
 */
ManateePeer.prototype.handleEvent = function (handler, source, eventname, args)
{
	var handlerargs;

	this.mp_log.info({
	    'source': source,
	    'event': eventname,
	    'args': args
	}, 'incoming event');

	if (this.mp_role == MP_ROLE_DEPOSED) {
		this.mp_log.info('dropping event (already deposed)');
		return;
	}

	handlerargs = [ this, eventname ].concat(args);
	handler.apply(null, handlerargs);
};

/*
 * Report a fatal error.  This emits "error", after which our consumer should
 * assume this peer has died.
 */
ManateePeer.prototype.fatal = function (error)
{
	error = new VError(error, 'fatal error');
	this.mp_log.fatal(error);
	this.emit('error', error);
};

/*
 * Report a validation error (which are always fatal).
 */
ManateePeer.prototype.validationFailed = function (source, error, state)
{
	this.mp_log.error({
	    'source': source,
	    'state': state
	}, error, 'fatal validation error');

	this.fatal(error);
};

/*
 * Returns true if the given other peer (represented as an object, the way it
 * appears as the "primary" or "sync" properties) appears to be present in the
 * most recently received list of present peers.
 */
ManateePeer.prototype.peerIsPresent = function (otherpeer)
{
	var i;

	/*
	 * We should never even be asking whether we're present.  If we need to
	 * do this at some point in the future, we need to consider we should
	 * always consider ourselves present or whether we should check the
	 * list.
	 */
	mod_assertplus.ok(otherpeer.hasOwnProperty('id'));
	mod_assertplus.ok(otherpeer.id != this.mp_id);
	for (i = 0; i < this.mp_zkpeers.length; i++) {
		if (this.mp_zkpeers[i].id == otherpeer.id)
			return (true);
	}

	return (false);
};

ManateePeer.prototype.assumePrimary = function ()
{
	this.mp_log.info({ 'role': MP_ROLE_PRIMARY }, 'assuming role');
	this.mp_role = MP_ROLE_PRIMARY;
	this.mp_pg_upstream = null;

	/*
	 * It simplifies things to say that evalClusterState() only deals with
	 * one change at a time.  Now that we've handled the change to become
	 * primary, check for other changes.
	 *
	 * For example, we may have just read the initial state that identifies
	 * us as the primary, and we may also discover that the synchronous peer
	 * is not present.  The first call to evalClusterState() will get us
	 * here, and we call it again to check for the presence of the
	 * synchronous peer.
	 *
	 * We invoke pgApplyConfig() after evalClusterState(), though it may
	 * well turn out that evalClusterState() kicked off an operation that
	 * will change the desired postgres configuration.  In that case, we'll
	 * end up calling pgApplyConfig() again.
	 */
	this.evalClusterState(true);
	this.pgApplyConfig();
};

ManateePeer.prototype.assumeSync = function ()
{
	mod_assertplus.ok(!this.mp_singleton);
	this.mp_log.info({ 'role': MP_ROLE_SYNC }, 'assuming role');
	this.mp_role = MP_ROLE_SYNC;
	this.mp_pg_upstream = this.mp_zkstate.primary;

	/* See assumePrimary(). */
	this.evalClusterState(true);
	this.pgApplyConfig();
};

ManateePeer.prototype.assumeAsync = function (i)
{
	mod_assertplus.ok(!this.mp_singleton);
	this.mp_log.info({ 'role': MP_ROLE_ASYNC, 'which': i },
	    'assuming role');
	this.mp_role = MP_ROLE_ASYNC;

	mod_assertplus.ok(i >= 0 && i < this.mp_zkstate.async.length);
	mod_assertplus.equal(this.mp_zkstate.async[i].id, this.mp_id);
	this.mp_pg_upstream = this.upstream(i);

	/*
	 * See assumePrimary().  We don't need to check the cluster state here
	 * because there's never more than one thing to do when becoming the
	 * async peer.
	 */
	this.pgApplyConfig();
};

ManateePeer.prototype.assumeUnassigned = function ()
{
	this.mp_log.info({ 'role': MP_ROLE_UNASSIGNED }, 'assuming role');
	this.mp_role = MP_ROLE_UNASSIGNED;
	this.mp_upstream = null;

	/*
	 * See assumeAsync().
	 */
	this.pgApplyConfig();
};

ManateePeer.prototype.assumeDeposed = function ()
{
	mod_assertplus.ok(!this.mp_singleton);
	this.mp_log.info({ 'role': MP_ROLE_DEPOSED }, 'assuming role');
	this.mp_role = MP_ROLE_DEPOSED;
	this.mp_upstream = null;

	/*
	 * See assumeAsync().
	 */
	this.pgApplyConfig();
	/* TODO fire alarm */
};

/*
 * Determine our index in the async peer list.  -1 means not present.
 */
ManateePeer.prototype.whichAsync = function ()
{
	var i, async;

	for (i = 0; i < this.mp_zkstate.async.length; i++) {
		async = this.mp_zkstate.async[i];
		if (async.id == this.mp_id)
			return (i);
	}

	return (-1);
};

/*
 * Return the upstream peer (as an object) for a given one of the async peers.
 */
ManateePeer.prototype.upstream = function (whichasync)
{
	mod_assertplus.ok(whichasync >= 0);
	mod_assertplus.ok(whichasync < this.mp_zkstate.async.length);

	return (whichasync === 0 ? this.mp_zkstate.sync :
	    (this.mp_zkstate.async[whichasync - 1]));
};

/*
 * Examine the current ZK cluster state and determine if new actions need to be
 * taken.  For example, if we're the primary, and there's no sync present, then
 * we need to declare a new generation.
 *
 * If "norest" is true, then the state machine will be moving even if there's no
 * more work to do here, so we should not issue a rest().  This is needed to
 * avoid having callers think that we're coming to rest when we know we're not.
 */
ManateePeer.prototype.evalClusterState = function (norest)
{
	var zkstate = this.mp_zkstate;
	var whichasync, upstream;
	var i, newpeers, presentpeers, nchanges;

	mod_assertplus.ok(!this.atRest());

	/*
	 * Ignore changes to the cluster state while we're in the middle of
	 * updating it.  When we finish updating the state (successfully or
	 * otherwise), we'll check whether there was something important that we
	 * missed.
	 */
	if (this.mp_updating) {
		this.mp_log.debug('deferring state check ' +
		    '(writing cluster state)');
		return;
	}

	/*
	 * If there's no cluster state, check whether we should set up the
	 * cluster.  If not, wait for something else to happen.
	 */
	if (zkstate === null) {
		this.mp_log.debug('cluster not yet setup');
		mod_assertplus.ok(this.mp_role == MP_ROLE_UNASSIGNED ||
		    this.mp_role == MP_ROLE_UNKNOWN);

		/*
		 * We avoid starting cluster setup if there was already a
		 * postgres database here.  This should only happen during
		 * the initial cluster upgrade to this version of Manatee.
		 */
		if (!this.mp_pg_setup &&
		    this.mp_zkpeers[0].id == this.mp_id &&
		    (this.mp_singleton || this.mp_zkpeers.length > 1)) {
			this.startInitialSetup();
		} else if (this.mp_role != MP_ROLE_UNASSIGNED) {
			this.assumeUnassigned();
		} else if (!norest) {
			this.rest();
		}

		return;
	}

	/*
	 * Bail out if we're configured for one-node-write mode but the cluster
	 * is not.
	 */
	if (this.mp_singleton && !zkstate.oneNodeWriteMode) {
		this.fatal(new VError('configured for one-node-write mode, ' +
		    'but found cluster in normal mode'));
		return;
	}

	/*
	 * If the generation has changed, then go back to square one (unless
	 * we think we're the primary but no longer are, in which case it's game
	 * over).  This may cause us to update our role and then trigger another
	 * call to evalClusterState() to deal with any other changes required.
	 * We update mp_gen so that we know that we've handled the generation
	 * change already.
	 */
	if (this.mp_gen != zkstate.generation) {
		this.mp_gen = zkstate.generation;

		if (this.mp_role == MP_ROLE_PRIMARY) {
			if (zkstate.primary.id != this.mp_id)
				this.assumeDeposed();
			else if (!norest)
				this.rest();
		} else {
			this.evalInitClusterState();
		}

		return;
	}

	/*
	 * Unassigned peers and async peers only need to watch their position in
	 * the async peer list and reconfigure themseles as needed.
	 */
	if (this.mp_role == MP_ROLE_UNASSIGNED) {
		whichasync = this.whichAsync();
		if (whichasync != -1)
			this.assumeAsync(whichasync);
		else if (!norest)
			this.rest();
		return;
	}

	if (this.mp_role == MP_ROLE_ASYNC) {
		whichasync = this.whichAsync();
		if (whichasync == -1) {
			this.assumeUnassigned();
		} else {
			upstream = this.upstream(whichasync);
			if (upstream.id != this.mp_pg_upstream.id)
				this.assumeAsync(whichasync);
			else if (!norest)
				this.rest();
		}
		return;
	}

	/*
	 * The synchronous peer only needs to check the takeover condition,
	 * which is that the primary has disappeared and the sync's WAL has
	 * caught up enough to takeover as primary.
	 */
	if (this.mp_role == MP_ROLE_SYNC) {
		if (!this.peerIsPresent(zkstate.primary))
			this.startTakeover('primary gone', zkstate.initWal);
		else if (!norest)
			this.rest();

		return;
	}

	mod_assertplus.equal(this.mp_role, MP_ROLE_PRIMARY);
	if (!this.mp_singleton && zkstate.oneNodeWriteMode) {
		this.mp_log.info('configured for normal mode, but found ' +
		    'cluster in one-node-write mode');
		mod_assertplus.equal(zkstate.primary.id, this.mp_id);
		this.startTransitionToNormalMode();
		return;
	}

	/*
	 * The primary peer needs to check not just for liveness of the
	 * synchronous peer, but also for other new or removed peers.  We only
	 * do this in normal mode, not one-node-write mode.
	 */
	if (this.mp_singleton) {
		if (!norest)
			this.rest();
		return;
	}

	/*
	 * TODO It would be nice to process the async peers showing up and
	 * disappearing as part of the same cluster state change update as our
	 * takeover attempt.  As long as we're not, though, we must handle the
	 * case that we go to start a takeover, but we cannot proceed because
	 * there are no asyncs.  In that case, we want to go ahead and process
	 * the asyncs, then consider a takeover the next time around.  If we
	 * update this to handle both operations at once, we can get rid of the
	 * goofy boolean returned by startTakeover.
	 */
	if (!this.peerIsPresent(zkstate.sync) &&
	    this.startTakeover('sync gone')) {
		return;
	}

	presentpeers = {};
	presentpeers[zkstate.primary.id] = true;
	presentpeers[zkstate.sync.id] = true;
	newpeers = [];
	nchanges = 0;
	for (i = 0; i < zkstate.async.length; i++) {
		if (this.peerIsPresent(zkstate.async[i])) {
			presentpeers[zkstate.async[i].id] = true;
			newpeers.push(zkstate.async[i]);
		} else {
			this.mp_log.debug(zkstate.async[i], 'peer missing');
			nchanges++;
		}
	}

	/*
	 * Deposed peers should not be assigned as asyncs.
	 */
	for (i = 0; i < zkstate.deposed.length; i++)
		presentpeers[zkstate.deposed[i].id] = true;

	for (i = 0; i < this.mp_zkpeers.length; i++) {
		if (presentpeers.hasOwnProperty(this.mp_zkpeers[i].id))
			continue;

		this.mp_log.debug(this.mp_zkpeers[i], 'new peer found');
		newpeers.push(this.mp_zkpeers[i]);
		nchanges++;
	}

	if (nchanges === 0) {
		mod_assertplus.deepEqual(newpeers, zkstate.async);
		if (!norest)
			this.rest();
		return;
	}

	this.startUpdateAsyncs(newpeers);
};

/*
 * Like evalClusterState(), but assumes that there's a generation change in the
 * cluster state.
 */
ManateePeer.prototype.evalInitClusterState = function ()
{
	var i;

	mod_assertplus.ok(!this.mp_updating);

	/*
	 * If we're the new primary or sync, assume that role.  The assume*
	 * family of functions record our internal state and kick off a postgres
	 * reconfiguration to match.
	 */
	if (this.mp_zkstate.primary.id == this.mp_id) {
		this.assumePrimary();
		return;
	}

	if (this.mp_zkstate.oneNodeWriteMode) {
		this.assumeUnassigned();
		return;
	}

	if (this.mp_zkstate.sync.id == this.mp_id) {
		this.assumeSync();
		return;
	}

	for (i = 0; i < this.mp_zkstate.deposed.length; i++) {
		if (this.mp_zkstate.deposed[i].id == this.mp_id) {
			this.assumeDeposed();
			return;
		}
	}

	/*
	 * If we're an async, figure out which one we are.
	 */
	i = this.whichAsync();
	if (i != -1)
		this.assumeAsync(i);
	else
		this.assumeUnassigned();
};

/*
 * As the primary, converts the current cluster to normal mode (from
 * one-node-write mode).
 */
ManateePeer.prototype.startTransitionToNormalMode = function ()
{
	var i;
	var peer = this;

	mod_assertplus.equal(this.mp_zkstate.primary.id, this.mp_id);
	mod_assertplus.equal(this.mp_role, MP_ROLE_PRIMARY);

	/*
	 * In the normal takeover case, we'd pick an async.  In this case, we
	 * take any other peer because we know none of them has anything
	 * replicated.
	 */
	for (i = 0; i < this.mp_zkpeers.length; i++) {
		if (this.mp_zkpeers[i].id != this.mp_id)
			break;
	}

	if (i == this.mp_zkpeers.length) {
		this.mp_log.warn('would takeover (transitioning to normal ' +
		    'mode), but no other peers present');
		return;
	}

	this.startTakeoverWithPeer('transitioning to normal mode', undefined, {
	    'deposed': [],
	    'sync': this.mp_zkpeers[i],
	    'async': this.mp_zkpeers.filter(function (p) {
		if (p.id == peer.mp_id)
			/* self: the primary */
			return (false);
		if (p.id == peer.mp_zkpeers[i].id)
			/* the newly-chosen sync */
			return (false);
		return (true);
	    })
	});
};

ManateePeer.prototype.startTakeover = function (reason, minwal)
{
	var peer = this;
	var i, whichasync, newsync, newasyncs, newdeposed;

	/*
	 * Select the first present async peer to be the next sync.
	 */
	for (i = 0; i < this.mp_zkstate.async.length; i++) {
		if (this.peerIsPresent(this.mp_zkstate.async[i]))
			break;
	}

	if (i == this.mp_zkstate.async.length) {
		this.mp_log.warn('would takeover (%s), but ' +
		    'no async peers present', reason);
		return (false);
	}

	whichasync = i;
	this.mp_log.debug('preparing for new generation (%s)', reason);
	newsync = this.mp_zkstate.async[whichasync];
	newasyncs = this.mp_zkstate.async.filter(function (async, j) {
		if (j == whichasync)
			return (false);
		return (peer.peerIsPresent(async));
	});

	/*
	 * If we're not already the primary, then we're deposing the current
	 * primary.
	 */
	newdeposed = mod_jsprim.deepCopy(this.mp_zkstate.deposed);
	if (this.mp_zkstate.primary.id != this.mp_id)
		newdeposed.push(this.mp_zkstate.primary);

	this.startTakeoverWithPeer(reason, minwal, {
	    'sync': newsync,
	    'async': newasyncs,
	    'deposed': newdeposed
	});
	return (true);
};

ManateePeer.prototype.startTakeoverWithPeer = function (reason, minwal, roles)
{
	var peer = this;

	mod_assertplus.string(reason, 'reason');
	mod_assertplus.object(roles, 'roles');
	mod_assertplus.object(roles.sync, 'roles.sync');
	mod_assertplus.arrayOfObject(roles.async, 'roles.async');
	mod_assertplus.arrayOfObject(roles.deposed, 'roles.deposed');
	mod_assertplus.ok(!this.atRest());

	/*
	 * mp_updating acts as a guard to prevent us from trying to make any
	 * other changes while we're trying to write the new cluster state.  If
	 * any state change comes in while this is ongoing, we'll just record it
	 * and examine it after this operation has completed (successfully or
	 * not).
	 */
	mod_assertplus.ok(!this.mp_updating);
	mod_assertplus.ok(this.mp_updating_state === null);
	this.mp_updating = true;
	this.mp_updating_state = {
	    'generation': this.mp_zkstate.generation + 1,
	    'primary': this.mp_ident,
	    'sync': roles.sync,
	    'async': roles.async,
	    'deposed': roles.deposed,
	    'initWal': null
	};

	if (this.mp_updating_state.primary.id != this.mp_zkstate.primary.id)
		mod_assertplus.ok(this.mp_updating_state.deposed.length > 0);

	mod_vasync.waterfall([
	    function takeoverCheckFrozen(callback) {
		/*
		 * We could have checked this above, but we want to take
		 * advantage of the code below that backs off for a second or
		 * two in this case and keeps mp_updating set.
		 */
		if (peer.mp_zkstate.freeze &&
		    peer.mp_zkstate.freeze !== null &&
		    peer.mp_zkstate.freeze !== false) {
			var err = new VError('cluster is frozen');
			err.name = 'ClusterFrozenError';
			callback(err);
		} else {
			callback();
		}
	    },
	    function takeoverFetchXlog(callback) {
		/*
		 * In order to declare a new generation, we'll need to fetch our
		 * current transaction log position, which requires that postres
		 * be online.  In most cases, it will be, since we only declare
		 * a new generation as a primary or a caught-up sync.  During
		 * initial startup, however, we may find out simultaneously that
		 * we're the primary or sync AND that the other is gone, so we
		 * may attempt to declare a new generation before we've started
		 * postgres.  In this case, this step will fail, but we'll just
		 * skip the takeover attempt until postgres is running.
		 * (Postgres coming online will trigger another check of the
		 * cluster state that will trigger us to issue another takeover
		 * if appropriate.)
		 */
		if (!peer.mp_pg_online || peer.mp_pg_transitioning) {
			var err = new VError('postgres is offline');
			err.name = 'PostgresOfflineError';
			callback(err);
		} else {
			peer.mp_pg.getXLogLocation(callback);
		}
	    },
	    function takeoverWriteState(wal, callback) {
		var error;

		if (minwal !== undefined &&
		    mod_xlog.xlogCompare(wal, minwal) < 0) {
			var err = new VError('would attempt takeover, but ' +
			    'not caught up to primary yet (want "%s", ' +
			    'found "%s"', minwal, wal);
			err.name = 'PeerNotCaughtUpError';
			callback(err);
			return;
		}

		peer.mp_updating_state.initWal = wal;
		error = mod_validation.validateZkState(peer.mp_updating_state);
		if (error instanceof Error)
			peer.fatal(error);
		peer.mp_log.info(peer.mp_updating_state,
		    'declaring new generation (%s)', reason);
		peer.mp_zk.putClusterState(
		    peer.mp_updating_state, callback);
	    }
	], function (err) {
		mod_assertplus.ok(!peer.atRest());

		/*
		 * In the event of an error, back off a bit and check state
		 * again in a few seconds.  There are several transient failure
		 * modes that will resolve themselves (e.g., postgres not yet
		 * online, postgres synchronous replication not yet caught up).
		 */
		if (err) {
			if (err.name == 'PeerNotCaughtUpError' ||
			    err.name == 'PostgresOfflineError' ||
			    err.name == 'ClusterFrozenError') {
				peer.mp_log.warn(err, 'backing off');
			} else {
				err = new VError('failed to declare ' +
				    'new generation');
				peer.mp_log.error(err, 'backing off');
			}

			setTimeout(function () {
				peer.moving();
				peer.mp_updating = false;
				peer.mp_updating_state = null;
				peer.evalClusterState();
			}, 1000);

			return;
		}

		peer.mp_zkstate = peer.mp_updating_state;
		peer.mp_updating_state = null;
		peer.mp_updating = false;
		peer.mp_gen = peer.mp_zkstate.generation;
		peer.mp_log.info('declared new generation');

		/*
		 * assumePrimary() calls evalClusterState() to catch any
		 * changes we missed while we were updating.
		 */
		peer.assumePrimary();
	});
};

ManateePeer.prototype.startUpdateAsyncs = function (newasyncs)
{
	var peer = this;

	/*
	 * See startTakeover().
	 */
	mod_assertplus.ok(!this.mp_updating);
	mod_assertplus.ok(this.mp_updating_state === null);
	this.mp_updating = true;
	this.mp_updating_state = {
	    'generation': this.mp_zkstate.generation,
	    'primary': this.mp_zkstate.primary,
	    'sync': this.mp_zkstate.sync,
	    'async': newasyncs,
	    'deposed': this.mp_zkstate.deposed,
	    'initWal': this.mp_zkstate.initWal
	};
	if (this.mp_zkstate.freeze)
		this.mp_updating_state.freeze = this.mp_zkstate.freeze;

	this.mp_log.info(peer.mp_updating_state, 'updating list of asyncs');
	this.mp_zk.putClusterState(this.mp_updating_state, function (err) {
		peer.mp_updating = false;

		if (err) {
			err = new VError(err, 'failed to update cluster state');
			peer.mp_log.warn(err);
		} else {
			peer.mp_zkstate = peer.mp_updating_state;
			peer.mp_log.info('updated cluster state');
		}

		peer.mp_updating_state = null;
		peer.evalClusterState();
	});
};

ManateePeer.prototype.startInitialSetup = function ()
{
	var peer = this;

	/*
	 * See startTakeover().
	 */
	mod_assertplus.ok(!this.mp_updating);
	mod_assertplus.ok(this.mp_updating_state === null);
	this.mp_updating = true;
	this.mp_updating_state = {
	    'generation': 1,
	    'primary': this.mp_ident,
	    'initWal': mod_xlog.initialXlog,
	    'deposed': []
	};

	if (this.mp_singleton) {
		this.mp_updating_state.sync = null;
		this.mp_updating_state.async = [];
		this.mp_updating_state.oneNodeWriteMode = true;
		this.mp_updating_state.freeze = {
			'date': new Date().toISOString(),
			'reason': 'manatee setup: one node write mode'
		};
	} else {
		this.mp_updating_state.sync = this.mp_zkpeers[1];
		this.mp_updating_state.async = this.mp_zkpeers.slice(2);
	}

	this.mp_log.info(peer.mp_updating_state,
	    'creating initial cluster state');
	this.mp_zk.putClusterState(this.mp_updating_state, function (err) {
		peer.mp_updating = false;

		if (err) {
			err = new VError(err, 'failed to create cluster state');
			peer.mp_log.warn(err);
		} else {
			peer.mp_zkstate = peer.mp_updating_state;
			peer.mp_log.info('created cluster state');
		}

		peer.mp_updating_state = null;
		peer.evalClusterState();
	});
};

/*
 * Return the desired postgres configuration for the current cluster state.
 */
ManateePeer.prototype.pgConfig = function ()
{
	var config = {};

	if (this.mp_role == MP_ROLE_PRIMARY) {
		config.role = 'primary';
		config.upstream = null;
		config.downstream = this.mp_zkstate.sync;
	} else if (this.mp_role == MP_ROLE_SYNC ||
	    this.mp_role == MP_ROLE_ASYNC) {
		config.role = this.mp_role == MP_ROLE_SYNC ?
		    'sync' : 'async';
		config.upstream = this.mp_pg_upstream;
		config.downstream = null;
	} else {
		mod_assertplus.ok(this.mp_role == MP_ROLE_UNASSIGNED ||
		    this.mp_role == MP_ROLE_DEPOSED);
		config.role = 'none';
		config.upstream = null;
		config.downstream = null;
	}

	return (config);
};

/*
 * Reconfigure postgres based on the current configuration.  During
 * reconfiguration, new requests to reconfigure will be ignored, and incoming
 * cluster state changes will be recorded but otherwise ignored.  When
 * reconfiguration completes, if the desired configuration has changed, we'll
 * take another lap to apply the updated configuration.
 */
ManateePeer.prototype.pgApplyConfig = function ()
{
	var peer = this;
	var config, error;

	this.moving();

	mod_assertplus.ok(this.mp_pg_online !== null);
	if (this.mp_pg_transitioning) {
		this.mp_log.info('skipping pgApplyConfig ' +
		    '(already transitioning)');
		return;
	}

	config = this.pgConfig();
	if (this.mp_pg_applied !== null &&
	    mod_jsprim.deepEqual(config, this.mp_pg_applied)) {
		this.mp_log.info('skipping pgApplyConfig ' +
		    '(no changes)');
		this.rest();
		return;
	}

	error = mod_validation.validatePgStatus(config);
	if (error instanceof Error)
		this.fatal(error);
	peer.mp_pg_transitioning = true;

	mod_vasync.waterfall([
	    function pgReconfig(callback) {
		peer.mp_log.debug('pg.reconfigure', config);
		peer.mp_pg.reconfigure(config,
		    function (err) { callback(err); });
	    },

	    function pgMaybeStartStop(callback) {
		var expected = config.role != 'none';
		var actual = peer.mp_pg_online;

		if (expected) {
			if (actual) {
				peer.mp_log.debug('pg: skipping enable ' +
				    '(already online)');
				callback();
			} else {
				peer.mp_log.debug('pg: enabling');
				peer.mp_pg.start(callback);
			}
		} else {
			if (!actual) {
				peer.mp_log.debug('pg: skipping disable ' +
				    '(already offline)');
				callback();
			} else {
				peer.mp_log.debug('pg: disabling');
				peer.mp_pg.stop(callback);
			}
		}
	    }
	], function finishPgApply(err) {
		peer.mp_pg_transitioning = false;

		if (err) {
			/*
			 * This is a very unexpected error, and it's very
			 * unclear how to deal with it.  If we're the primary or
			 * sync, we might be tempted to abdicate our position.
			 * But without understanding the failure mode, there's
			 * no reason to believe any other peer is in a better
			 * position to deal with this, and we don't want to flap
			 * unnecessarily.  So just log an error and try again
			 * shortly.
			 */
			err = new VError(err, 'applying pg config');
			peer.mp_log.error(err);
			peer.mp_pg_retrypending = new Date();
			setTimeout(function retryPgApplyConfig() {
				peer.pgApplyConfig();
			}, 1000);
			return;
		}

		peer.mp_log.info({ 'nretries': peer.mp_pg_nretries },
		    'pg: applied config', config);
		peer.mp_pg_nretries = 0;
		peer.mp_pg_retrypending = null;
		peer.mp_pg_applied = config;
		if (config.role != 'none')
			peer.mp_pg_online = true;
		else
			peer.mp_pg_online = false;

		/*
		 * Try applying the configuration again in case anything's
		 * changed.  If not, this will be a no-op.
		 */
		peer.pgApplyConfig();
	});
};


/*
 * State transition handlers
 */

function manateeOnZkInit(peer, _, state)
{
	var clusterState, newstate, newpeers;

	mod_assertplus.ok(peer.mp_zkstate === null,
	    'received ZK "init" event after already initialized');

	clusterState = state.clusterState;
	if (clusterState === null) {
		newstate = null;
	} else {
		newstate = mod_validation.validateZkState(clusterState);
		if (newstate instanceof Error) {
			peer.validationFailed('zk', newstate, clusterState);
			return;
		}
	}

	newpeers = mod_validation.validateZkPeers(state.active);
	if (newpeers instanceof Error) {
		peer.validationFailed('zk', newpeers, state.active);
		return;
	}

	peer.mp_zkstate = newstate;
	peer.mp_zkpeers = newpeers;
	if (peer.mp_pg_online !== null) {
		peer.moving();
		peer.evalClusterState();
	}
}

function manateeOnZkActiveChange(peer, _, activeNodes)
{
	var newpeers;

	mod_assertplus.ok(peer.mp_zkpeers !== null,
	    'received ZK "activeChange" event before initialization');
	mod_assertplus.ok(peer.mp_role != MP_ROLE_UNKNOWN);

	newpeers = mod_validation.validateZkPeers(activeNodes);
	if (newpeers instanceof Error) {
		peer.validationFailed('zk', newpeers, activeNodes);
		return;
	}

	peer.mp_zkpeers = newpeers;
	peer.moving();
	peer.evalClusterState();
}

function manateeOnZkClusterStateChange(peer, _, clusterState)
{
	var newstate;

	mod_assertplus.ok(peer.mp_zkpeers !== null,
	    'received ZK "clusterStateChange" event before initialization');

	newstate = mod_validation.validateZkState(clusterState);
	if (newstate instanceof Error) {
		peer.validationFailed('zk', newstate, clusterState);
		return;
	}

	peer.mp_zkstate = newstate;
	peer.moving();
	peer.evalClusterState();
}

function manateeOnPgInit(peer, _, status)
{
	mod_assertplus.object(status, 'status');
	mod_assertplus.bool(status.online, 'status.online');
	mod_assertplus.bool(status.setup, 'status.setup');

	mod_assertplus.ok(peer.mp_pg_online === null,
	    'received PG "init" event after already initialized');

	peer.mp_pg_online = status.online;
	peer.mp_pg_setup = status.setup;

	if (peer.mp_zkpeers !== null) {
		peer.moving();
		peer.evalClusterState();
	}
}
