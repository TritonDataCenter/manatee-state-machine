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
	'init': manateeOnPgInit,
    	'caughtUp': manateeOnPgCaughtUp
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
 * The interfaces (including methods, events, and data types) are described in
 * the README.
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

	EventEmitter.call(this);

	/* configuration */
	this.mp_id = args.self.id;
	this.mp_ident = mod_jsprim.deepCopy(args.self);

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
	this.mp_pg_status = null;	/* last received pg status */
	this.mp_pg_online = null;	/* null for unknown; else boolean */
	this.mp_pg_caughtup = null;	/* null for unknown; else boolean */
	this.mp_pg_applied = null;	/* last configuration applied */
	this.mp_pg_transitioning = false;	/* boolean */
	this.mp_pg_retrypending = null;
	this.mp_pg_nretries = 0;	/* consecutive failed retries */
	this.mp_pg_upstream = null;	/* upstream replication target */

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
		pending.push('postgres');
	if (this.mp_pg_retrypending)
		pending.push('pg retry');
	if (this.mp_updating)
		pending.push('updating');
	if (pending.length > 0)
		rv.pending = pending;
	rv.pg_applied = this.mp_pg_applied;
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
	this.evalClusterState();
	this.pgApplyConfig();
};

ManateePeer.prototype.assumeSync = function ()
{
	this.mp_log.info({ 'role': MP_ROLE_SYNC }, 'assuming role');
	this.mp_role = MP_ROLE_SYNC;
	this.mp_pg_upstream = this.mp_zkstate.primary;
	this.mp_pg_caughtup = false;

	/* See assumePrimary(). */
	this.evalClusterState();
	this.pgApplyConfig();
};

ManateePeer.prototype.assumeAsync = function (i)
{
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
	this.evalClusterState();
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
 * There are lots of things we have to look out for, depending on our state:
 *
 *     o PRIMARY	new generation declared
 *     			sync peer disappeared
 *			async peer disappeared
 *			unassigned peer found
 *
 *     o SYNC		new generation declared
 *     			primary peer disappeared (and WAL up to date)
 *     			our downstream changed
 *
 *     o ASYNC		new generation declared
 *     			our upstream changed
 *
 *     o UNASSIGNED	new generation declared
 */
ManateePeer.prototype.evalClusterState = function ()
{
	var zkstate = this.mp_zkstate;
	var whichasync, upstream;
	var i, newpeers, presentpeers, nchanges;

	/*
	 * XXX implement initial setup.
	 */
	if (zkstate === null) {
		this.mp_log.debug('cluster not yet setup');
		if (this.mp_role != MP_ROLE_UNASSIGNED) {
			mod_assertplus.equal(this.mp_role, MP_ROLE_UNKNOWN);
			this.assumeUnassigned();
		}
		return;
	}

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
		}
		return;
	}

	/*
	 * The synchronous peer only needs to check the takeover condition,
	 * which is that the primary has disappeared and the sync's WAL has
	 * caught up enough to takeover as primary.
	 */
	if (this.mp_role == MP_ROLE_SYNC) {
		if (!this.peerIsPresent(zkstate.primary)) {
			if (this.mp_pg_caughtup)
				this.startTakeover('primary gone');
			else
				this.mp_log.warn('would takeover ' +
				    '(primary gone), but not caught up');
		}

		/* TODO do we care if our downstream has changed? */
		return;
	}

	/*
	 * The primary peer needs to check not just for liveness of the
	 * synchronous peer, but also for other new or removed peers.
	 */
	mod_assertplus.equal(this.mp_role, MP_ROLE_PRIMARY);
	if (!this.peerIsPresent(zkstate.sync)) {
		/*
		 * TODO it would be nice to process the async peers showing up
		 * and disappearing as part of the same cluster state change
		 * update.
		 */
		this.startTakeover('sync gone');
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

	for (i = 0; i < this.mp_zkpeers.length; i++) {
		if (presentpeers.hasOwnProperty(this.mp_zkpeers[i].id))
			continue;

		this.mp_log.debug(this.mp_zkpeers[i], 'new peer found');
		newpeers.push(this.mp_zkpeers[i]);
		nchanges++;
	}

	if (nchanges === 0) {
		mod_assertplus.deepEqual(newpeers, zkstate.async);
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

	if (this.mp_zkstate.sync.id == this.mp_id) {
		this.assumeSync();
		return;
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

ManateePeer.prototype.startTakeover = function (reason)
{
	var peer = this;
	var i, whichasync, newsync, newasyncs, error;

	/*
	 * Select the first present async peer to be the next sync.
	 */
	for (i = 0; i < peer.mp_zkstate.async.length; i++) {
		if (peer.peerIsPresent(peer.mp_zkstate.async[i]))
			break;
	}

	if (i == peer.mp_zkstate.async.length) {
		peer.mp_log.warn('would takeover (%s), but ' +
		    'no async peers present', reason);
		return;
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
	 * mp_updating acts as a guard to prevent us from trying to make any
	 * other changes while we're trying to write the new cluster state.  If
	 * any state change comes in while this is ongoing, we'll just record it
	 * and examine it after this operation has completed (successfully or
	 * not).
	 */
	this.mp_updating = true;
	this.mp_updating_state = {
	    'generation': this.mp_zkstate.generation + 1,
	    'primary': this.mp_ident,
	    'sync': newsync,
	    'async': newasyncs,
	    'initWal': null
	};
	error = mod_validation.validateZkState(this.mp_updating_state);
	if (error instanceof Error)
		this.fatal(error);

	mod_vasync.waterfall([
	    function takeoverFetchXlog(callback) {
		peer.mp_pg.getXLogLocation(callback);
	    },
	    function takeoverWriteState(wal, callback) {
		peer.mp_updating_state.initWal = wal;
		peer.mp_log.info(peer.mp_updating_state,
		    'declaring new generation (%s)', reason);
		peer.mp_zk.putClusterState(
		    peer.mp_updating_state, callback);
	    }
	], function (err) {
		peer.mp_updating = false;

		if (err) {
			err = new VError(err,
			    'failed to declare new generation');
			peer.mp_log.error(err);
		} else {
			peer.mp_zkstate = peer.mp_updating_state;
			peer.mp_gen = peer.mp_zkstate.generation;
			peer.mp_log.info('declared new generation');
			peer.assumePrimary();
		}

		peer.mp_updating_state = null;
		peer.evalClusterState();
	});
};

ManateePeer.prototype.startUpdateAsyncs = function (newasyncs)
{
	var peer = this;

	/*
	 * See startTakeover().
	 */
	this.mp_updating = true;
	this.mp_updating_state = {
	    'generation': this.mp_zkstate.generation,
	    'primary': this.mp_zkstate.primary,
	    'sync': this.mp_zkstate.sync,
	    'async': newasyncs,
	    'initWal': this.mp_zkstate.initWal
	};

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

/*
 * Return the desired postgres configuration for the current cluster state.
 */
ManateePeer.prototype.pgConfig = function ()
{
	var config = {};

	if (this.mp_role == MP_ROLE_PRIMARY) {
		config.role = 'primary';
		config.upstream = null;
		config.downstream = this.mp_zkstate.sync.pgUrl;
	} else if (this.mp_role == MP_ROLE_SYNC ||
	    this.mp_role == MP_ROLE_ASYNC) {
		config.role = 'standby';
		config.upstream = null;
		config.downstream = null;
	} else if (this.mp_role == MP_ROLE_ASYNC) {
		config.role = 'standby';
		config.upstream = this.mp_pg_upstream.pgUrl;
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
	], function (err) {
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
	var clusterState, newstate;

	mod_assertplus.ok(peer.mp_zkstate === null,
	    'received ZK "init" event after already initialized');

	clusterState = state.clusterState;
	if (clusterState === null) {
		newstate = null;
	} else {
		newstate = mod_validation.validateZkState(clusterState);
		if (newstate instanceof Error)
			peer.validationFailed('zk', newstate, clusterState);
	}

	peer.mp_zkstate = newstate;

	/* XXX validate */
	peer.mp_zkpeers = mod_jsprim.deepCopy(state.active);

	if (peer.mp_pg_status !== null)
		peer.evalClusterState();
}

function manateeOnZkActiveChange(peer, _, activeNodes)
{
	mod_assertplus.ok(peer.mp_zkpeers !== null,
	    'received ZK "activeChange" event before initialization');
	mod_assertplus.ok(peer.mp_role != MP_ROLE_UNKNOWN);
	/* XXX validate */
	peer.mp_zkpeers = activeNodes;
	peer.evalClusterState();
}

function manateeOnZkClusterStateChange(peer, _, clusterState)
{
	var newstate;

	mod_assertplus.ok(peer.mp_zkpeers !== null,
	    'received ZK "clusterStateChange" event before initialization');

	newstate = mod_validation.validateZkState(clusterState);
	if (newstate instanceof Error)
		peer.validationFailed('zk', newstate, clusterState);

	peer.mp_zkstate = newstate;
	peer.evalClusterState();
}

function manateeOnPgInit(peer, _, status)
{
	var newstatus;

	mod_assertplus.ok(peer.mp_pg_status === null,
	    'received PG "init" event after already initialized');

	newstatus = mod_validation.validatePgStatus(status);
	if (newstatus instanceof Error)
		peer.validationFailed('pg', newstatus, status);

	peer.mp_pg_status = newstatus;
	peer.mp_pg_online = false;	/* XXX */
	/* XXX update mp_pg_caughtup? */

	if (peer.mp_zkpeers !== null)
		peer.evalClusterState();
}

function manateeOnPgCaughtUp(peer, _)
{
	mod_assertplus.ok(peer.mp_pg_status !== null,
	    'received PG "caughtUp" event before initialization');
	peer.mp_pg_caughtup = true;
}
