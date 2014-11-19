/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * stream-bunyan-prettyprint.js: bunyan "raw" stream that pretty-prints output
 */

var mod_assertplus = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_jsprim = require('jsprim');
var mod_stream = require('stream');
var mod_util = require('util');
var sprintf = require('extsprintf').sprintf;

module.exports = createBunyanPrettyPrinter;

var bunyanStdKeys = {
    'name': true,
    'hostname': true,
    'pid': true,
    'level': true,
    'msg': true,
    'time': true,
    'component': true,
    'v': true
};

function createBunyanPrettyPrinter()
{
	return (new BunyanPrettyPrinter());
}


function BunyanPrettyPrinter()
{
	mod_stream.Transform.call(this,
	    { 'objectMode': true, 'highWaterMark': 1024 });
}

mod_util.inherits(BunyanPrettyPrinter, mod_stream.Transform);

BunyanPrettyPrinter.prototype._transform = function (chunk, _, callback)
{
	var component = chunk.component || chunk.name;
	var message = chunk.msg;
	var stream = this;
	var level;

	switch (chunk.level) {
	case mod_bunyan.TRACE:		level = 'TRACE'; break;
	case mod_bunyan.DEBUG:		level = 'DEBUG'; break;
	case mod_bunyan.INFO:		level = 'INFO';  break;
	case mod_bunyan.WARN:		level = 'WARN';  break;
	case mod_bunyan.ERROR:		level = 'ERROR'; break;
	case mod_bunyan.FATAL:		level = 'FATAL'; break;
	default:			level = '?????'; break;
	}

	this.push(sprintf('[%5s] %s: %s\n', level, component, message));

	mod_jsprim.forEachKey(chunk, function (key, value) {
		if (bunyanStdKeys.hasOwnProperty(key))
			return;
		stream.push(sprintf('  %10s: %j\n', key, value));
	});

	callback();
};
