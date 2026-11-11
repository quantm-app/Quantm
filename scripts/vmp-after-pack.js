'use strict';

// electron-builder's afterPack hook.
module.exports = require('./vmp-sign').onlyFor(['darwin', 'mas']);
