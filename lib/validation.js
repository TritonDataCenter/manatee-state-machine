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
var schemas = require('./schemas');


/*
 * Interface validators.  These validate the ZK and Postgres state reported to
 * us to make sure they look sane.  Validation failures are fatal, since they're
 * programming errors.
 */
exports.validateZkState = validateZkState;
exports.validatePgStatus = validatePgStatus;

function validateZkState(clusterState)
{
	var error;

	error = mod_jsprim.validateJsonObject(schemas.zkState, clusterState);
	if (error !== null)
		return (error);
	return (mod_jsprim.deepCopy(clusterState));
}

function validatePgStatus(status)
{
	var error;
	error = mod_jsprim.validateJsonObject(schemas.pgStatus, status);
	if (error !== null)
		return (error);
	return (mod_jsprim.deepCopy(status));
}
