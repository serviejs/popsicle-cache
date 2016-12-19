import catbox = require('catbox')
import { PassThrough, Readable } from 'stream'
import { Request, Response, ResponseOptions } from 'popsicle'

/**
 * The singular entry serialized to the cache.
 */
export interface CacheItem {
  body: string
  rawHeaders: string[]
  url: string
  status: number
  statusText: string
  varyHeaders: Array<[string, string]>
}

/**
 * The cached response instance options.
 */
export interface CachedResponseOptions extends ResponseOptions {
  ttl: number
  stored: number
  varyHeaders: Array<[string, string]>
}

/**
 * The cached response object.
 */
export class CachedResponse extends Response {

  ttl: number
  stored: number
  varyHeaders: Array<[string, string]>

  constructor (options: CachedResponseOptions) {
    super(options)

    this.ttl = options.ttl
    this.stored = options.stored
    this.varyHeaders = options.varyHeaders
  }
}

/**
 * Cache configuration options.
 */
export interface Options {
  engine: catbox.Client.Engine<CacheItem>
  cacheable?: Cacheable
  ttl?: Ttl
  serializer?: Serializer<any>
  handler?: Handler
  staleFallback?: boolean
  getId?: GetId
  catchCacheError?: (err: Error) => void
  waitForCache?: boolean
  segment?: string
}

/**
 * Interfaces for implementing configuration options.
 */
export type Ttl = (req: Request, res: Response) => number
export type GetId = (serialize: Serializer<any>, req: Request) => string
export type Cacheable = (req: Request, res: Response) => boolean

/**
 * Implementation interface for handling cached responses.
 */
export interface Handler {
  (req: Request, cache: CachedResponse, next: () => Promise<Response>): Response | Promise<Response>
}

/**
 * Interface for implementing the parser/serializer of response bodies.
 */
export interface Serializer <T> {
  name: string
  parse (value: string): T
  stringify (value: T, cache: (err: Error | null, value?: string | null) => void): T
}

/**
 * The default methods for deciding if a response should be cached.
 */
export const cacheables = {
  standard (): Cacheable {
    return function (req: Request, res: Response) {
      return res.status === 200 && req.method === 'GET'
    }
  },
  always (): Cacheable {
    return function () {
      return true
    }
  }
}

/**
 * The default methods for deciding cache TTL.
 */
export const ttls = {
  standard (minTtl: number, maxTtl: number): Ttl {
    return function (req: Request, res: Response) {
      let freshness = 0

      const cacheControl = getCacheControl(res)
      const expiresIn = getExpiresIn(res)
      const lastModified = getLastModifiedExpiration(res)

      if (cacheControl.maxAge != null) {
        freshness = cacheControl.maxAge
      } else if (expiresIn != null) {
        freshness = expiresIn
      } else if (lastModified != null) {
        freshness = lastModified
      }

      return minTtl + Math.min(maxTtl, freshness)
    }
  },
  forever () {
    return function () {
      return Infinity
    }
  }
}

/**
 * The default handlers for processing cache data.
 */
export const handlers = {
  standard (): Handler {
    // Reference: https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching
    return async function (req: Request, cache: CachedResponse, next: () => Promise<Response>) {
      const now = Date.now()
      const cacheControl = getCacheControl(cache)
      const expiresIn = getExpiresIn(cache)
      const lastModified = getLastModifiedExpiration(cache)
      let novalidate = cacheControl.immutable || !cacheControl.noCache

      // We can avoid revalidation when using `max-age` or `expires`.
      if (novalidate) {
        if (cacheControl.maxAge != null) {
          novalidate = (now < (cache.stored + cacheControl.maxAge)) && !cacheControl.mustRevalidate
        } else if (expiresIn != null) {
          novalidate = (now < (cache.stored + expiresIn))
        } else if (lastModified != null) {
          novalidate = (now < (cache.stored + lastModified))
        } else {
          novalidate = !cacheControl.mustRevalidate
        }
      }

      if (novalidate) {
        const varies = cache.varyHeaders.some(([key, value]) => {
          if (value == null) {
            return req.get(key) != null
          }

          return req.get(key) !== value
        })

        if (!varies) {
          return cache
        }
      }

      if (cache.get('ETag')) {
        req.set('If-None-Match', cache.get('ETag'))
      }

      if (cache.get('Last-Modified')) {
        req.set('If-Modified-Since', cache.get('Last-Modified'))
      }

      const res = await next()

      // Return the cached response in case of "304 Not Modified".
      if (res.status === 304) {
        // But override the cached response status from server.
        cache.status = res.status
        cache.statusText = res.statusText

        return cache
      }

      return res
    }
  },
  always (): Handler {
    return function (req: Request, cache: CachedResponse, next: () => Promise<Response>) {
      return cache
    }
  }
}

/**
 * The default approaches to cache ids.
 */
export const getIds = {
  standard (): GetId {
    return function (serializer: Serializer<any>, req: Request) {
      return `${serializer.name}~${req.method}~${req.url}`
    }
  }
}

/**
 * Built-in response body handlers.
 */
export const serializers = {
  standard (): Serializer<any> {
    return {
      name: 'json',
      parse: (value: string) => JSON.parse(value),
      stringify: (value, cache) => {
        cache(null, JSON.stringify(value))

        return value
      }
    }
  },
  stream (maxBufferLength: number = 1000 * 1000): Serializer<Readable | PassThrough> {
    return {
      name: 'stream',
      parse: (value) => {
        let o: Buffer | null = new Buffer(value, 'base64')

        return new Readable({
          read (this: Readable) {
            this.push(o)
            o = null
          }
        })
      },
      stringify: (stream, cache) => {
        const s = new PassThrough()

        if (typeof stream.pipe !== 'function') {
          throw new TypeError('The stream serializer only works for readable `stream` instances')
        }

        let length = 0
        const strings: Buffer[] = []

        stream.on('data', (chunk: Buffer) => {
          if (length > maxBufferLength) {
            return
          }

          length += chunk.length

          if (length <= maxBufferLength) {
            strings.push(chunk)
          }
        })

        stream.on('error', (err) => cache(err))

        stream.on('end', () => {
          cache(null, length > maxBufferLength ? null : Buffer.concat(strings).toString('base64'))
        })

        return stream.pipe(s)
      }
    }
  }
}

/**
 * The plugin function.
 */
export function plugin (options: Options) {
  const serializer = options.serializer || serializers.standard()
  const cacheable = options.cacheable || cacheables.standard()
  const ttl = options.ttl || ttls.standard(0, 1000 * 60 * 60 * 24 * 365)
  const handler = options.handler || handlers.standard()
  const catchCacheError = options.catchCacheError || (() => undefined)
  const getId = options.getId || getIds.standard()
  const staleFallback = options.staleFallback !== false
  const waitForCache = !!options.waitForCache
  const segment = options.segment || 'popsicle-cache'
  const pending = startYourEngine(options.engine, segment)

  // Attempt to persist the response into the cache.
  function shouldCache (cache: Cache, id: string, req: Request, res: Response) {
    if (!cacheable(req, res)) {
      return res
    }

    // Wrap the cache/serializer into a promise to support `waitForCache` option.
    return new Promise<void>((resolve, reject) => {
      function setCache (err: Error | null, contents: string | null) {
        if (err) {
          return resolve(catchCacheError(err))
        }

        // Skip the cache.
        if (contents == null) {
          return resolve()
        }

        const item: CacheItem = {
          body: contents,
          rawHeaders: res.rawHeaders,
          url: res.url,
          status: res.status,
          statusText: res.statusText,
          varyHeaders: getVary(res).map(key => [key, res.get(key)] as [string, string])
        }

        return resolve(cache.set(id, item, ttl(req, res)).catch(catchCacheError))
      }

      // Handle caching out-of-band with the response.
      res.body = serializer.stringify(res.body, setCache)

      if (!waitForCache) {
        return resolve()
      }
    }).then(() => res)
  }

  return {
    async handle (req: Request, next: () => Promise<Response>) {
      const id = getId(serializer, req)

      const cache = await pending
      const result = await cache.get(id)
      let res: Response

      if (!result) {
        res = await next()
      } else {
        const { item } = result

        // Return a cached response instance.
        const response = new CachedResponse({
          ttl: result.ttl,
          stored: result.stored,
          varyHeaders: item.varyHeaders,
          url: item.url,
          body: serializer.parse(item.body),
          rawHeaders: item.rawHeaders,
          status: item.status,
          statusText: item.statusText
        })

        try {
          res = await handler(req, response, next)
        } catch (err) {
          if (err.code === 'EUNAVAILABLE' && staleFallback) {
            return response
          }

          throw err
        }

        // Skip the cache attempt when using stale data.
        if (staleFallback && res.statusType() === 5) {
          return response
        }

        // Skip the "should cache" step when using a cached response.
        if (res instanceof CachedResponse) {
          return res
        }
      }

      return await shouldCache(cache, id, req, res)
    },
    async forceUpdate (req: Request, next: () => Promise<Response>) {
      return await shouldCache(await pending, getId(serializer, req), req, await next())
    },
    async stop () {
      const cache = await pending

      return cache.isReady() ? cache.stop() : null
    },
    async stats () {
      const cache = await pending

      return cache.stats()
    }
  }
}

/**
 * Promise instance of the `catbox` client interface.
 */
interface Cache {
  stop (): void
  isReady (): boolean
  stats (): any
  get (id: string): Promise<catbox.Client.Result<CacheItem> | null>
  set (id: string, item: CacheItem, ttl: number): Promise<void>
}

/**
 * Retrieve the engine when ready.
 */
function startYourEngine (engine: catbox.Client.Engine<CacheItem>, segment: string) {
  const cache = new catbox.Client(engine)

  return new Promise<Cache>((resolve, reject) => {
    cache.start(function (err) {
      if (err) {
        return reject(err)
      }

      const policy = new catbox.Policy<CacheItem>({}, cache, segment)

      return resolve({
        stop: () => cache.stop(),
        isReady: () => cache.isReady(),
        stats: () => policy.stats,
        get (id: string) {
          return new Promise<catbox.Client.Result<CacheItem> | null>((resolve, reject) => {
            policy.get(id, (err, result, cached) => {
              return err ? reject(err) : resolve(cached)
            })
          })
        },
        set (id: string, value: CacheItem, ttl: number) {
          return new Promise<void>((resolve, reject) => {
            policy.set(id, value, ttl, (err) => {
              return err ? reject(err) : resolve()
            })
          })
        }
      })
    })
  })
}

/**
 * Get the response max age.
 */
function getCacheControl (res: Response) {
  const cacheControl = res.get('Cache-Control')
  const age = cacheControl ? /\bmax-age=(\d+)\b/i.exec(cacheControl) : undefined
  const mustRevalidate = cacheControl ? /\bmust-revalidate\b/i.test(cacheControl) : undefined
  const noCache = cacheControl ? /\bno-cache\b/i.test(cacheControl) : undefined
  const immutable = cacheControl ? /\bimmutable\b/i.test(cacheControl) : undefined
  const maxAge = age ? parseInt(age[1], 10) * 1000 : null

  return { maxAge, noCache, immutable, mustRevalidate }
}

/**
 * Get the response expiration.
 */
function getExpiresIn (res: Response) {
  const expires = res.get('Expires')
  const date = res.get('Date')

  if (!expires || !date) {
    return null
  }

  return Date.parse(expires) - Date.parse(date)
}

/**
 * Get the last modified expiration.
 */
function getLastModifiedExpiration (res: Response) {
  const lastModified = res.get('Last-Modified')
  const date = res.get('Date')

  if (!lastModified || !date) {
    return null
  }

  return (Date.parse(date) - Date.parse(lastModified)) / 10
}

/**
 * Retreive the `Vary` headers.
 */
function getVary (res: Response) {
  const vary = res.get('Vary')

  return vary ? vary.split(/ *, */) : []
}
