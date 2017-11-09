/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * validation.js: common functions for validating objects
 */

var mod_jsprim = require('jsprim');
var VError = require('verror');

var mod_lsn = require('pg-lsn');
var schemas = require('./schemas');


/*
 * Interface validators.  These validate the ZK and Postgres state reported to
 * us to make sure they look sane.  The current implementations copy the
 * incoming object, but it would be better if they actually filtered out fields
 * that were not present in the schema in order to enforce that new fields are
 * added to the schema.
 */
exports.validateZkState = validateZkState;
exports.validateZkPeers = validateZkPeers;
exports.validatePgStatus = validatePgStatus;

function validateZkState(clusterState)
{
	var copy, error;

	/*
	 * We want consumers to be able to assume that "deposed" is present, so
	 * it's required in the schema.  But we don't want a flag day for its
	 * introduction, so we insert it here (into our private copy).  Recall
	 * that the caller is supposed to use the value returned by this
	 * validator, not assume that just because we don't return an error that
	 * they can use the original copy.
	 */
	copy = mod_jsprim.deepCopy(clusterState);
	if (copy !== null && !copy.hasOwnProperty('deposed'))
		copy['deposed'] = [];

	error = mod_jsprim.validateJsonObject(schemas.zkState, copy);
	if (error instanceof Error)
		return (error);

	if (copy === null)
		return (null);

	if (copy.sync === null &&
	    (copy.oneNodeWriteMode === undefined ||
	    !copy.oneNodeWriteMode)) {
		return (new VError('"sync" may not be null outside of ' +
		    'one-node-write mode'));
	}

	error = mod_lsn.xlogValidate(clusterState.initWal);
	return (error instanceof Error ? error : copy);
}

function validateZkPeers(peers)
{
	return (validateAndCopy(schemas.zkPeers, peers));
}

function validatePgStatus(status)
{
	return (validateAndCopy(schemas.pgStatus, status));
}

function validateAndCopy(schema, obj)
{
	var error;
	error = mod_jsprim.validateJsonObject(schema, obj);
	if (error !== null)
		return (error);
	return (mod_jsprim.deepCopy(obj));
}
