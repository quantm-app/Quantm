'use strict';

// electron-builder's afterSign hook.
module.exports = require('./vmp-sign').onlyFor(['win32']);
