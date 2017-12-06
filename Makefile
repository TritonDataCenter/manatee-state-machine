#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

JSL		 = jsl
JSSTYLE		 = jsstyle
JSL_CONF_NODE	 = jsl.node.conf
NPM		 = npm

JS_FILES	:= bin/msim $(shell find lib test -name '*.js')
JSON_FILES	 = package.json
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)

include Makefile.defs

all:
	$(NPM) install

manatee.png: manatee.dot
	dot -Tpng $^ -o $@

test:
	node test/tst.test.js
	node test/tst.basic.js
	node test/tst.start_primary.js
	node test/tst.start_sync.js
	node test/tst.start_deposed.js
	node test/tst.start_primary_async.js
	node test/tst.start_sync_async.js
	node test/tst.cluster_setup_immed.js
	node test/tst.cluster_setup_delay.js
	node test/tst.cluster_setup_passive.js
	node test/tst.noflap.js
	node test/tst.onwm.js
	node test/tst.onwm_upgrade.js
	node test/tst.onwm_newpeer.js
	node test/tst.cluster_setup_onwm.js
	node test/tst.freeze.js
	node test/tst.promote.js
	@echo all tests passed

include Makefile.targ
