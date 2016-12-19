# Popsicle Cache

[![NPM version][npm-image]][npm-url]
[![NPM downloads][downloads-image]][downloads-url]
[![Build status][travis-image]][travis-url]
[![Test coverage][coveralls-image]][coveralls-url]

> Cache HTTP responses using `popsicle`.

## Installation

```sh
npm install popsicle-cache --save
```

## Usage

```js
import { request } from 'popsicle'
import { plugin, cacheables, ttls } from 'popsicle-cache'

const cache = plugin({ engine: require('catbox-fs'), ttl: ttls.forever() })

popsicle('http://example.com')
  .use(cache.handle)
  .then(function (res) {
    console.log(res) //=> If still fresh, the cached response, otherwise it makes a new request.
  })
```

Use `popsicleCache.plugin(options)` to initialize the cache middleware. It returns an object with three methods:

* `handle` - Regular Popsicle middleware for handling the cache.
* `forceUpdate` - Force a refresh of the cache on every request (**does not** read from cache, only sets it).
* `stop` - Stop the underlying `catbox` engine.

## Options

**Popsicle Cache** does not include any external caching strategy by default. Instead, it is compatible with [`catbox`](https://github.com/hapijs/catbox#installation) strategies.

### `engine` (Object | Function)

An engine instance from [`catbox`](https://github.com/hapijs/catbox#installation).

### `cacheable` (Function, Default = `cacheables.standard()`)

```ts
(req: Request, res: Response) => boolean
```

A function that determines whether a request/response should be cacheable.

Built-in cacheable implementations:

* `cacheables.standard()` - Caches on `res.status === 200 && req.method === 'GET' && !res.get('Cache-Control').contains('no-cache')` only.
* `cacheables.always()` - Always caches the response (`return true`).

### `ttl` (Function, Default = `ttls.standard(0, 1000 * 60 * 60 * 24 * 365)`)

```ts
(req: Request, res: Response) => number
```

A function that determines the TTL of the cached response.

Built-in TTL implementations:

* `ttls.standard(minTtl, maxTtl)` - Calculates the [freshness](https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching#Freshness) from the `Cache-Control`, `Expires` and/or `Last-Modified` headers. Returns `minTtl + Math.min(maxTtl, freshness)`.
* `ttls.forever()` - Caches forever (`return Infinity`).

### `serializer` (Object, Default = `serializers.standard()`)

```ts
interface Serializer <T> {
  name: string
  parse (value: string): T
  stringify (value: T, cache: (err: Error | null, value?: string | null) => void): T
}
```

An object that represents a serializer instance. Must have a name and implement `parse` and `stringify` methods. Some serializations are asynchronous in nature, or require the response body to be augmented, so a callback must be used to cache the actual value. Pass `null` or `undefined` as the `cache` value to skip the cache (E.g. `cache()` or `cache(null, null)`).

Built-in serializer implementations:

* `serializers.standard()` - Simple implementation using `JSON.parse` and `JSON.stringify`.
* `stream(maxBufferLength?: number)` - Buffers the response body from a stream, skipping the cache if the buffer exceeds `maxBufferLength` (defaults to `1mb`)

### `handler` (Function, Default = `handlers.standard()`)

```ts
class CachedResponse extends popsicle.Response {
  ttl: number
  stored: number
  response: Response
  varyHeaders: Array<[string, string]>
}

(req: Request, cache: CachedResponse, next: () => Promise<Response>): Response | CachedResponse | Promise<Response | CachedResponse>
```

The request handler that decides whether to use the existing cache, regular response or a combination of both (E.g. by setting `If-None-Match` or `If-Modified-Since`).

Built-in handler implmentations:

* `handlers.standard()` - Based on [freshness](https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching#Freshness), it will decide whether to use the cache directly or validate the cache by sending the request with `If-None-Match` or `If-Modified-Since`. If it responds with `304` (not modified), it will use the cached response body and headers.
* `handlers.always()` - Always return the cached resource, even if expired or stale (`return cache.response`).

### `catchCacheError` (Function, Default = `undefined`)

```ts
(err: Error) => void
```

Handler for catching cache errors. Useful for debugging errors with setting the cache engine or serializer errors which would otherwise be swallowed.

### `staleFallback` (Boolean, Default = `true`)

When the network is down or the server responds with `5xx`, we always default to the cached entry (instead of passing the error onward).

### `getId` (Function, Default = `getIds.standard()`)

The ID for the cache entry. The default is `${serializer.name}~${req.method}~${req.url}`.

### `waitForCache` (Boolean, Default = `false`)

Usually persisting to cache occurs in parallel with the response. This overrides that behaviour by waiting for the cache to finish before responding.

### `segment` (String, Default = `'popsicle-cache'`)

The `catbox` segment name.

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
