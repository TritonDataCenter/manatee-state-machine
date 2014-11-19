/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
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
	'sync': host,
	'async': {
	    'type': 'array',
	    'required': true,
	    'items': host
	},
	'initWal': sStringRequired
    }
};

exports.pgStatus = {
    'type': 'object',
    'required': true,
    'properties': {
	'role': {
	    'type': 'string',
	    'required': true,
	    'enum': [ 'primary', 'standby', 'none' ]
	},
	'upstream': {
	    'type': [ 'null', 'string' ],
	    'required': true
	},
	'downstream': {
	    'type': [ 'null', 'string' ],
	    'required': true
	}
    }
};
