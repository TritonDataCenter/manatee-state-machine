/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * schemas.js: json-schema definitions for interfaces
 */

var sStringRequired = { 'type': 'string', 'required': true };

var host = {
    'type': 'object',
    'required': true,
    'properties': {
	'id': sStringRequired,
	'ip': sStringRequired,
	'pgUrl': sStringRequired,
	'zoneId': sStringRequired
    }
};

exports.zkState = {
    'type': 'object',
    'required': true,
    'properties': {
	'generation': { 'type': 'number', 'required': true },
	'primary': host,
	/* "sync" may only be null when oneNodeWriteMode is true. */
	'sync': {
	    'type': [ 'null', host ]
	},
	'async': {
	    'type': 'array',
	    'required': true,
	    'items': host
	},
	'deposed': {
	    'type': 'array',
	    'required': true,
	    'items': host
	},
	'initWal': sStringRequired,
	'freeze': {
	    'type': [ 'null', 'boolean', 'object' ]
	},
	'oneNodeWriteMode': { 'type': 'boolean' }
    }
};

exports.zkPeers = {
    'type': 'array',
    'required': true,
    'items': host
};

exports.pgStatus = {
    'type': 'object',
    'required': true,
    'properties': {
	'role': {
	    'type': 'string',
	    'required': true,
	    'enum': [ 'primary', 'sync', 'async', 'none' ]
	},
	'upstream': {
	    'type': [ 'null', host ],
	    'required': true
	},
	'downstream': {
	    'type': [ 'null', host ],
	    'required': true
	}
    }
};

exports.promote = {
    'type': 'object',
    'properties': {
	'id': sStringRequired,
	'role': {
	    'enum': [ 'sync', 'async' ],
	    'required': true
	},
	/*
	 * "asyncIndex" can only be null if "role" is not "async", validated in
	 * lib/validation.js
	 */
	'asyncIndex': {
	    'type': [ 'null', 'integer' ]
	},
	'generation': {
	    'type': 'integer',
	    'required': true
	},
	'expireTime': {
	    'type': 'string',
	    'required': true
	}
    }
};
