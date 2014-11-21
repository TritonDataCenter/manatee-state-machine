/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * xlog.js: constants and functions for working with postgres xlog positions.
 * This file makes a number of assumptions about the format of xlog positions.
 * It's not totally clear that this is a committed Postgres interface, but it
 * seems to be true.
 *
 * We assume that postgres xlog positions are represented as strings of the
 * form:
 *
 *     filepart/offset		e.g., "0/17BB660"
 *
 * where both "filepart" and "offset" are hexadecimal numbers.  xlog position
 * F1/O1 is at least as new as F2/O2 if (F1 > F2) or (F1 == F2 and O1 >= O2).
 * We try to avoid assuming that they're zero-padded (i.e., that a simple string
 * comparison might do the right thing).  We also don't make any assumptions
 * about the size of each file, which means we can't compute the actual
 * difference between two positions.
 */

var sprintf = require('extsprintf').sprintf;
var VError = require('verror');

exports.initialXlog = xlogMakePosition(0, 0);
exports.xlogIncrementSim = xlogIncrementSim;
exports.xlogCompare = xlogCompare;
exports.xlogValidate = xlogValidate;

/*
 * Given a numeric file part and offset, construct the xlog position.
 */
function xlogMakePosition(filepart, offset)
{
	return (sprintf('%x/%08x', filepart, offset));
}

/*
 * Given an xlog position, increment it by the given number.  This is used for
 * simulation only, and it's illegal for the xlog to be invalid.
 */
function xlogIncrementSim(xlog, increment)
{
	var parts = xlogParse(xlog);
	if (parts instanceof Error)
		throw (parts);

	return (xlogMakePosition(parts[0], parts[1] + increment));
}

/*
 * Compare two xlog positions, returning -1 if xlog1 < xlog2, 0 if xlog1 ==
 * xlog2, and 1 if xlog1 > xlog2.  It's illegal to attempt to compare malformed
 * xlog positions.
 */
function xlogCompare(xlog1, xlog2)
{
	var p1, p2;

	p1 = xlogParse(xlog1);
	p2 = xlogParse(xlog2);
	if (p1 instanceof Error || p2 instanceof Error)
		throw (new VError('cannot compare "%s" to "%s"', xlog1, xlog2));

	return ((p1[0] > p2[0] || (p1[0] == p2[0] && p1[1] > p2[1])) ? 1 :
	    (p1[0] < p2[0] || (p1[0] == p2[0] && p1[1] < p2[1])) ? -1 : 0);
}

/*
 * Given a string xlog position as emitted by postgres, return an array of two
 * integers representing the two components of the xlog position.  This is an
 * internal representation and should not be exposed outside this file.  Returns
 * an error if the position cannot be parsed, though some callers consider that
 * an unrecoverable error.
 */
function xlogParse(xlog)
{
	var parts = xlog.split('/');

	if (parts.length != 2)
		return (new VError('malformed xlog position: "%s"', xlog));

	parts[0] = parseInt(parts[0], 16);
	if (isNaN(parts[0]))
		return (new VError('expected hex integer in first part ' +
		    'of xlog position: "%s"', xlog));

	parts[1] = parseInt(parts[1], 16);
	if (isNaN(parts[1]))
		return (new VError('expected hex integer in second part ' +
		    'of xlog position: "%s"', xlog));

	return (parts);
}

/*
 * Public version of xlogParse that just validates that the xlog is valid.
 */
function xlogValidate(xlog)
{
	var error = xlogParse(xlog);
	return (error instanceof Error ? error : null);
}
