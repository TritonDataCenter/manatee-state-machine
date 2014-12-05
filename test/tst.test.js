/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * tst.test.js: tests parts of the test library
 */

var mod_assert = require('assert');
var mod_test = require('./common');

var testcases = [ {
    'name': 'simple different numeric values',
    'args': [ 'value', 1, 2 ],
    'error': 'value: expected "2", but found "1"'
}, {
    'name': 'simple same numeric values',
    'args': [ 'value', 3, 3 ],
    'error': null
}, {
    'name': 'simple different types',
    'args': [ 'value', true, 5 ],
    'error': 'value: expected type "number", but found "boolean"'
}, {
    'name': 'null vs. empty object',
    'args': [ 'value', null, {} ],
    'error': 'value: expected non-null'
}, {
    'name': 'empty object vs. null',
    'args': [ 'value', {}, null ],
    'error': 'value: expected null'
}, {
    'name': 'basic array comparison',
    'args': [ 'value', [ 1, 2, 3, 4 ], [ 1, 2, 3, 4 ] ],
    'error': null
}, {
    'name': 'arrays differing at element 2',
    'args': [ 'value', [ 1, 2, 7, 4 ], [ 1, 2, 3, 4 ] ],
    'error': 'value[2]: expected "3", but found "7"'
}, {
    'name': 'basic object comparison',
    'args': [ 'value', {
	'one': 'two',
	'three': 4
    }, {
	'one': 'two',
	'three': 4
    } ],
    'error': null
}, {
    'name': 'subset object comparison',
    'args': [ 'value', {
	'one': 'two',
	'three': 4,
	'extra': 'property'
    }, {
	'one': 'two',
	'three': 4
    } ],
    'error': null
}, {
    'name': 'subset object comparison fails',
    'args': [ 'value', {
	'one': 'two',
	'three': 4
    }, {
	'one': 'two',
	'three': 4,
	'extra': 'property'
    } ],
    'error': 'value: missing property "extra"'
}, {
    'name': 'complex nested object',
    'args': [ 'value', {
	'somestuff': [ 'one', 'two', [
	    'three', { 'five': 'SIX', 'seven': 'eight' }, 'four' ] ]
    }, {
	'somestuff': [ 'one', 'two', [
	    'three', { 'five': 'six', 'seven': 'eight' }, 'four' ] ]
    } ],
    'error': 'value.somestuff[2][1].five: expected "six", but found "SIX"'
} ];

testcases.forEach(function (tc) {
	var err;

	process.stderr.write('test case: ' + tc.name);
	err = mod_test.deepCheckSubset.apply(null, tc.args);
	if (err === null)
		console.error(': no error');
	else
		console.error('\n    message: %s', err.message);
	if (tc.error === null)
		mod_assert.ok(err === null, 'expected no error');
	else {
		mod_assert.ok(err !== null, 'expected error');
		mod_assert.equal(err.message, tc.error);
	}
});

console.log('test passed');
