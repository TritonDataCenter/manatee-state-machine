/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * validation.js: common functions for validating objects
 */

var mod_jsprim = require('jsprim');
var mod_xlog = require('./xlog');
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

	copy = validateAndCopy(schemas.zkState, clusterState);
	if (copy instanceof Error)
		return (copy);

	if (copy === null)
		return (null);

	error = mod_xlog.xlogValidate(clusterState.initWal);
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
