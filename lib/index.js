var join = require('path').join
var isStream = require('is-stream')
var stream = require('stream')
var tmpdir = require('os').tmpdir()
var fs = require('fs')
var mkdirp = require('mkdirp')

/**
 * Cache into the filesystem.
 */
var TMP_PATH = join(tmpdir, 'popsicle-cache')

/**
 * Create a static not modified response object.
 */
var NOT_MODIFIED_RESPONSE = {
  status: 304,
  body: emptyStream(),
  headers: {}
}

/**
 * Expose `popsicleCache`.
 */
module.exports = popsicleCache
module.exports.TMP_PATH = TMP_PATH
module.exports.Store = Store

/**
 * Create a popsicle cache instance, using a fs store by default.
 *
 * @param  {Object}   [options]
 * @return {Function}
 */
function popsicleCache (options) {
  options = options || {}

  var store = options.store || new Store({ path: TMP_PATH })

  return function (request) {
    var open = request.transport.open

    // Disable cache in browsers, it already works there.
    if (request.browser) {
      return
    }

    // Override the open mechanism to look up the cache first.
    request.transport.open = function (request) {
      var url = request.fullUrl()

      if (!isMethod(request.method)) {
        return open(request)
      }

      return new Promise(function (resolve, reject) {
        store.get(url, function (err, _cache) {
          if (err) {
            return reject(err)
          }

          if (!_cache) {
            return resolve(open(request))
          }

          // Store the cached response data.
          request._cache = _cache

          // Handle fresh data as a server `304`.
          if (isFresh(_cache)) {
            return resolve(NOT_MODIFIED_RESPONSE)
          }

          // Set the `If-None-Match` header.
          if (_cache.headers.etag) {
            request.set('If-None-Match', _cache.headers.etag)
          }

          // Set the `If-Modified-Since` header.
          if (_cache.headers['last-modified']) {
            request.set('If-Modified-Since', _cache.headers['last-modified'])
          }

          var _open = open(request)

          // Serve stale data when network is unreachable by default.
          if (options.staleFallback !== false) {
            return resolve(_open.catch(function (err) {
              return err.type === 'EUNAVAILABLE' ? NOT_MODIFIED_RESPONSE : Promise.reject(err)
            }))
          }

          return resolve(_open)
        })
      })
    }

    request.after(function (response) {
      var request = response.request
      var _cache = request._cache

      // Handle content that is already up to date.
      if (response.status === 304) {
        response.set(_cache.headers)
        response.url = _cache.url
        response.status = _cache.status
        response.body = _cache.body

        return
      }

      // Disable caching with certain responses.
      if (!isCacheable(response)) {
        // Delete old cache references.
        if (_cache) {
          return store.del(request.fullUrl())
        }

        return
      }

      return new Promise(function (resolve, reject) {
        store.set(request.fullUrl(), response.toJSON(), function (err) {
          return err ? reject(err) : resolve()
        })
      })
    })
  }
}

/**
 * Check if response data is still fresh.
 *
 * @param  {Object}  data
 * @return {Boolean}
 */
function isFresh (data) {
  return Date.parse(data.headers.expires) > Date.now()
}

/**
 * Check if a request can be cached.
 *
 * @param  {Object}  request
 * @return {Boolean}
 */
function isCacheable (response) {
  // Ignore invalid responses.
  if (isStream(response.body) || response.statusType() !== 2) {
    return false
  }

  // Check whether the body is cacheable, according to headers we use.
  if (isMethod(response.request.method)) {
    return isFresh(response) || !!response.get('Last-Modified') || !!response.get('ETag')
  }

  return false
}

/**
 * Convert a url into a cache-able path.
 *
 * @param  {String}
 * @return {String}
 */
function escapeKey (key) {
  return encodeURIComponent(key).replace(/%/g, '_')
}

/**
 * Create an empty stream instance for compatibility.
 *
 * @return {Object}
 */
function emptyStream () {
  var p = stream.PassThrough()
  p.end()
  return p
}

/**
 * Check if the method is cacheable.
 *
 * @param  {String}
 * @return {Boolean}
 */
function isMethod (method) {
  return method === 'GET' || method === 'HEAD'
}

/**
 * In-memory and file store.
 *
 * TODO: Use an LRU cache for in-memory.
 */
function Store (options) {
  this.path = options.path
  this.stringify = options.stringify || JSON.stringify
  this.parse = options.parse || JSON.parse
  this.memoryCache = {}
}

/**
 * Get the path to storage.
 *
 * @param  {string} key
 * @return {string}
 */
Store.prototype.getPath = function (key) {
  return join(this.path, escapeKey(key))
}

/**
 * Get data from the filesystem, or memory cache.
 *
 * @param {string}   key
 * @param {Function} cb
 */
Store.prototype.get = function (key, cb) {
  var parse = this.parse
  var memoryCache = this.memoryCache

  if (memoryCache.hasOwnProperty(key)) {
    return process.nextTick(function () {
      cb(null, parse(memoryCache[key]))
    })
  }

  fs.readFile(this.getPath(key), 'utf8', function (err, contents) {
    if (err) {
      if (err.code === 'ENOENT') {
        return cb(null)
      }

      return cb(err)
    }

    var value

    try {
      value = parse(contents)
    } catch (error) {
      error.message = 'Failed to parse "' + key + '": ' + error.message
      return cb(error)
    }

    // Cache it as the raw string.
    memoryCache[key] = contents

    cb(null, value)
  })
}

/**
 * Set data into the filesystem and memory cache.
 *
 * @param {string}   key
 * @param {*}   value
 * @param {Function} cb
 */
Store.prototype.set = function (key, value, cb) {
  var stringify = this.stringify
  var path = this.getPath(key)
  var memoryCache = this.memoryCache

  mkdirp(this.path, function (err) {
    if (err) {
      return cb(err)
    }

    var contents

    try {
      contents = stringify(value)
    } catch (error) {
      error.message = 'Failed to stringify "' + key + '": ' + error.message
      return cb(error)
    }

    memoryCache[key] = contents

    fs.writeFile(path, contents, cb)
  })
}
