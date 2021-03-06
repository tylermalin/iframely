var events = require('events');
var request = require('request');
var zlib = require('zlib');
var iconv = require('iconv-lite');
var async = require('async');
var imagesize = require('imagesize');
var moment = require('moment');
var cache = require('./cache');

GLOBAL.CONFIG = require('../config');

/**
 * @private
 * Do HTTP GET request and handle redirects
 * @param url Request uri (parsed object or string)
 * @param {Object} options
 * @param {Number} [options.maxRedirects]
 * @param {Boolean} [options.fullResponse] True if need load full page response. Default: false.
 * @param {Function} [callback] The completion callback function or events.EventEmitter object
 * @returns {events.EventEmitter} The emitter object which emit error or response event
 */
var getUrl = exports.getUrl = function(url, options) {

    var req = new events.EventEmitter();

    var options = options || {};

    // Store cookies between redirects and requests.
    var jar = options.jar;
    if (!jar) {
        jar = request.jar();
    }

    process.nextTick(function() {
        try {

            var supportGzip = !process.version.match(/^v0\.8/);

            var r = request({
                uri: url,
                method: 'GET',
                headers: {
                    'User-Agent': CONFIG.USER_AGENT,
                    'Connection': 'close',
                    'Accept-Encoding': supportGzip ? 'gzip,deflate' : ''
                },
                maxRedirects: options.maxRedirects || 3,
                timeout: options.timeout || CONFIG.RESPONSE_TIMEOUT,
                followRedirect: options.followRedirect,
                jar: jar
            })
                .on('error', function(error) {
                    req.emit('error', error);
                })
                .on('response', function(res) {

                    if (supportGzip && ['gzip', 'deflate'].indexOf(res.headers['content-encoding']) > -1) {

                        var gunzip = zlib.createUnzip();
                        gunzip.request = res.request;
                        gunzip.statusCode = res.statusCode;
                        gunzip.headers = res.headers;

                        if (!options.asBuffer) {
                            gunzip.setEncoding("binary");
                        }

                        req.emit('response', gunzip);

                        res.pipe(gunzip);

                    } else {

                        if (!options.asBuffer) {
                            res.setEncoding("binary");
                        }

                        req.emit('response', res);
                    }
                });

            req.emit('request', r);

        } catch (ex) {
            console.error('Error on getUrl for', url, '.\n Error:' + ex);
            req.emit('error', ex);
        }
    });
    return req;
};

exports.getCharset = function(string, doNotParse) {
    var charset;

    if (doNotParse) {
        charset = string.toUpperCase();
    } else if (string) {
        var m = string && string.match(/charset\s*=\s*([\w_-]+)/i);
        charset = m && m[1].toUpperCase();
    }

    if (charset && charset === 'UTF-8')
        charset = null;

    return charset;
};

exports.encodeText = function(charset, text) {
    try {
        var b = iconv.encode(text, "ISO8859-1");
        return iconv.decode(b, charset || "UTF-8");
    } catch(e) {
        return text;
    }
};

/**
 * @public
 * Get image size and type.
 * @param {String} uri Image uri.
 * @param {Object} [options] Options.
 * @param {Boolean} [options.cache] False to disable cache. Default: true.
 * @param {Function} callback Completion callback function. The callback gets two arguments (error, result) where result has:
 *  - result.format
 *  - result.width
 *  - result.height
 *
 *  error == 404 if not found.
 * */
exports.getImageMetadata = function(uri, options, callback){

    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    options = options || {};

    var loadImageHead, imageResponseStarted, totalTime, timeout;
    var requestInstance = null;

    function finish(error, data) {

        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        } else {
            return;
        }

        // We don't need more data. Abort causes error. timeout === null here so error will be skipped.
        requestInstance && requestInstance.abort();

        if (!error && !data) {
            error = 404;
        }

        data = data || {};

        if (options.debug) {
            data._time = {
                imageResponseStarted: imageResponseStarted || totalTime(),
                loadImageHead: loadImageHead && loadImageHead() || 0,
                total: totalTime()
            };
        }

        if (error && error.message) {
            error = error.message;
        }

        if ((typeof error === 'string' && error.indexOf('ENOTFOUND') > -1) ||
            error === 500) {
            error = 404;
        }

        callback(error, data);
    }

    timeout = setTimeout(function() {
        finish("timeout");
    }, options.timeout || CONFIG.RESPONSE_TIMEOUT);

    if (options.debug) {
        totalTime = createTimer();
    }

    async.waterfall([
        function(cb){

            getUrl(uri, {
                timeout: options.timeout || CONFIG.RESPONSE_TIMEOUT,
                maxRedirects: 5,
                asBuffer: true
            })
                .on('request', function(req) {
                    requestInstance = req;
                })
                .on('response', function(res) {
                    if (res.statusCode == 200) {
                        if (options.debug) {
                            imageResponseStarted = totalTime();
                        }
                        imagesize(res, cb);
                    } else {
                        cb(res.statusCode);
                    }
                })
                .on('error', function(error) {
                    cb(error);
                });
        },
        function(data, cb){

            if (options.debug) {
                loadImageHead = createTimer();
            }

            cb(null, data);
        }
    ], finish);
};

exports.getUriStatus = function(uri, options, callback) {

    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    options = options || {};

    cache.withCache("status:" + uri, function(cb) {

        var time, timeout;

        function finish(error, data) {

            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            } else {
                return;
            }

            data = data || {};

            if (error) {
                data.error = error;
            }

            if (options.debug) {
                data._time = time();
            }

            cb(null, data);
        }

        timeout = setTimeout(function() {
            finish("timeout");
        }, options.timeout || CONFIG.RESPONSE_TIMEOUT);

        if (options.debug) {
            time = createTimer();
        }

        getUriStatus(uri, options, finish);

    }, callback, options.disableCache);
};

exports.unifyDate = function(date) {

    if (typeof date === "number") {
        var parsedDate = moment(date);
        if (parsedDate.isValid()) {
            return parsedDate.toJSON();
        }
    }

    // TODO: time in format 'Mon, 29 October 2012 18:15:00' parsed as local timezone anyway.
    var parsedDate = moment.utc(date);
    if (parsedDate.isValid()) {
        return parsedDate.toJSON();
    }
    return date;
};


var lowerCaseKeys = exports.lowerCaseKeys = function(obj) {
    for (var k in obj) {
        var lowerCaseKey = k.toLowerCase();
        if (lowerCaseKey != k) {
            obj[lowerCaseKey] = obj[k];
            delete obj[k];
            k = lowerCaseKey;
        }
        if (typeof obj[k] == "object") {
            lowerCaseKeys(obj[k]);
        }
    }
};

//====================================================================================
// Private
//====================================================================================

var getUriStatus = function(uri, options, cb) {

    // TODO: add timeout.

    var r = request({
        uri: uri,
        method: 'GET',
        headers: {
            'User-Agent': CONFIG.USER_AGENT
        },
        maxRedirects: 5,
        timeout: options.timeout || CONFIG.RESPONSE_TIMEOUT,
        jar: request.jar()   //Enable cookies, uses new jar
    })
        .on('error', cb)
        .on('response', function(res) {
            r.abort();
            cb(null, {
                code: res.statusCode
            });
        });
};

var createTimer = exports.createTimer = function() {

    var timer = new Date().getTime();

    return function() {
        return new Date().getTime() - timer;
    };
};