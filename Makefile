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

JS_FILES	:= $(shell find lib -name '*.js')
JSON_FILES	 = package.json
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)

include Makefile.defs

all:
	$(NPM) install

manatee.png: manatee.dot
	dot -Tpng $^ -o $@

include Makefile.targ
