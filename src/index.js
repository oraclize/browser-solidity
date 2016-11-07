'use strict'

require('es6-shim')
var app = require('./app.js')
var oraclize = require('./oraclize.js')
var $ = require('jquery')

$(document).ready(function () { app.run() })
