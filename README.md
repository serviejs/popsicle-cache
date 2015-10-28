# Popsicle Cache

[![NPM version][npm-image]][npm-url]
[![NPM downloads][downloads-image]][downloads-url]
[![Build status][travis-image]][travis-url]
[![Test coverage][coveralls-image]][coveralls-url]

> Override the Popsicle transport mechanism with HTTP caching.

## Installation

```sh
npm install popsicle-cache --save
```

## Usage

```js
var popsicle = require('popsicle')
var cache = require('popsicle-cache')

popsicle('http://example.com')
  .use(cache())
  .then(function (res) {
    console.log(res) //=> If fresh, the cached response, otherwise makes a new request.
  })
```

**Options**

* **store** Create a custom store option for request data (default: `FileSystemMemoryStore`)
* **staleFallback** Fallback to the stale response when network is unavailable (default: `true`)

**Please note:** Streaming response bodies skip the cache.

## License

MIT license

[npm-image]: https://img.shields.io/npm/v/popsicle-cache.svg?style=flat
[npm-url]: https://npmjs.org/package/popsicle-cache
[downloads-image]: https://img.shields.io/npm/dm/popsicle-cache.svg?style=flat
[downloads-url]: https://npmjs.org/package/popsicle-cache
[travis-image]: https://img.shields.io/travis/blakeembrey/popsicle-cache.svg?style=flat
[travis-url]: https://travis-ci.org/blakeembrey/popsicle-cache
[coveralls-image]: https://img.shields.io/coveralls/blakeembrey/popsicle-cache.svg?style=flat
[coveralls-url]: https://coveralls.io/r/blakeembrey/popsicle-cache?branch=master
