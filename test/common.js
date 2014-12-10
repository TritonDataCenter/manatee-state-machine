/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * test/common.js: library functions for testing the state machine
 */

var mod_path = require('path');
var mod_util = require('util');
var mod_vasync = require('vasync');
var createSimulator = require('../lib/sim');
var VError = require('verror');

exports.createTestSimulator = createTestSimulator;
exports.runTestCommands = runTestCommands;
exports.deepCheckSubset = deepCheckSubset;

/*
 * Instantiates a one-node Manatee simulator for automated testing.
 */
function createTestSimulator(options)
{
	var args, sim, key;

	args = {
	    'progName': mod_path.basename(process.argv[1]),
	    'logLevel': 'debug',
	    'input': process.stdin,
	    'output': process.stdout,
	    'error': process.stderr
	};

	for (key in options)
		args[key] = options[key];

	sim = createSimulator(args);

	sim.on('error', function (err) {
		console.error('TEST FAILED: ', err.message);
		console.error(err.stack);
		process.exit(1);
	});

	return (sim);
}

/*
 * Runs a sequence of commands within the simulator.  Commands are objects with
 * properties:
 *
 *     cmd		the name of the command to run.  These correspond to
 *     			commands available in the simulator REPL.
 *
 *     [args]		array of arguments to pass to the command function
 *
 *     check		If present, the return value is compared against
 *     			this object.  This is a deep equality test, except that
 *     			properties missing from this object are ignored.
 *
 * Failures are fatal to the process.
 */
function runTestCommands(sim, cmds, verbose)
{
	var which = 0;

	mod_vasync.forEachPipeline({
	    'inputs': cmds,
	    'func': function runCommandsWorker(cmd, callback) {
		var label = mod_util.format('command %d', which++);
		runOneTestCommand(sim, label, cmd, verbose, callback);
	    }
	}, function (err) {
		if (err)
			sim.abort(err, false);
	});
}

function runOneTestCommand(sim, label, cmd, verbose, callback)
{
	var wait = cmd.hasOwnProperty('wait') ? cmd.wait : null;
	if (cmd.cmd != 'echo' && verbose)
		console.error('running command: ', cmd.cmd,
		    cmd.hasOwnProperty('args') ? cmd.args : '');
	sim.runCmd(cmd.cmd, wait, 6000, cmd.args, function (err, result) {
		if (!err && cmd.check) {
			if (verbose)
				console.error('checking result: ', result);
			err = deepCheckSubset('result', result, cmd.check);
		}

		if (err) {
			err = new VError(err, 'processing %s', label);
			callback(err);
		} else {
			callback();
		}
	});
}

function specificType(obj)
{
	return (Array.isArray(obj) ? 'array' : typeof (obj));
}

/*
 * Compares "actual" to "expected" much like the Node API's deepEqual()
 * function, except that:
 *
 *     o Errors are returned rather than thrown
 *
 *     o Errors explicitly say what's wrong (e.g., property foo.bar.baz differs,
 *       rather than just saying the whole object differs)
 *
 *     o It is allowed (i.e., not an error) for the "actual" object to have
 *       extra properties that the "expected" object does not have (and ditto
 *       for sub-objects within each one).  The intended use case is for tests
 *       where some properties may vary and you only want to check the ones that
 *       you've explicitly included in "expected".
 */
function deepCheckSubset(label, actual, expected)
{
	var type_expected, type_actual;
	var sublabel, i;
	var err;

	type_expected = specificType(expected);
	type_actual = specificType(actual);

	if (type_expected != type_actual) {
		return (new VError('%s: expected type "%s", but found "%s"',
		    label, type_expected, type_actual));
	}

	if (Array.isArray(expected)) {
		for (i = 0; i < expected.length; i++) {
			/*
			 * We could check this outside the loop, but it's
			 * generally more helpful to report problems in the
			 * first N elements before missing elements M > N.
			 */
			if (actual.length <= i) {
				return (new VError('%s: expected array of ' +
				    'at least %d elements, but found only %d',
				    label, expected.length, actual.length));
			}

			sublabel = mod_util.format('%s[%d]', label, i);
			err = deepCheckSubset(sublabel, actual[i], expected[i]);
			if (err)
				return (err);
		}
	} else if (type_expected == 'object') {
		if (actual === null && expected !== null)
			return (new VError('%s: expected non-null', label));
		if (actual !== null && expected === null)
			return (new VError('%s: expected null', label));

		for (i in expected) {
			if (!actual.hasOwnProperty(i)) {
				return (new VError('%s: missing property "%s"',
				    label, i));
			}

			sublabel = mod_util.format('%s.%s', label, i);
			err = deepCheckSubset(sublabel, actual[i], expected[i]);
			if (err)
				return (err);
		}
	} else if (actual != expected) {
		return (new VError('%s: expected "%s", but found "%s"',
		    label, expected, actual));
	}

	return (null);
}
