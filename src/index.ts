import catbox = require('catbox')
import { PassThrough, Readable } from 'stream'
import { Request, Response } from 'popsicle'

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
 * The cached response object.
 */
export interface CachedResponse {
  ttl: number
  stored: number
  response: Response
  varyHeaders: Array<[string, string]>
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
      const cacheControl = getCacheControl(cache.response)
      const expiresIn = getExpiresIn(cache.response)
      const lastModified = getLastModifiedExpiration(cache.response)
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
          return cache.response
        }
      }

      if (cache.response.get('ETag')) {
        req.set('If-None-Match', cache.response.get('ETag'))
      }

      if (cache.response.get('Last-Modified')) {
        req.set('If-Modified-Since', cache.response.get('Last-Modified'))
      }

      const res = await next()

      // Merge the response with the cached response.
      if (res.status === 304) {
        res.body = cache.response.body
        res.rawHeaders = cache.response.rawHeaders
        res.url = cache.response.url
      }

      return res
    }
  },
  always (): Handler {
    return function (req: Request, cache: CachedResponse, next: () => Promise<Response>) {
      return cache.response
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
        const s = new Readable()
        s.push(value)
        s.push(null)
        return s
      },
      stringify: (stream, cache) => {
        const s = new PassThrough({ encoding: 'utf8' })

        if (typeof stream.pipe !== 'function') {
          throw new TypeError('The stream serializer only works for readable `stream` instances')
        }

        let value = ''
        let length = 0

        s.on('data', (chunk) => {
          if (length > maxBufferLength) {
            return
          }

          length += Buffer.byteLength(chunk)

          if (length > maxBufferLength) {
            value = ''
          } else {
            value += chunk
          }
        })

        s.on('error', (err) => cache(err))

        s.on('end', () => {
          cache(null, length > maxBufferLength ? null : value)
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
  function shouldCache (client: ClientPromisified, id: string, req: Request, res: Response) {
    if (!cacheable(req, res)) {
      return res
    }

    // Wrap the cache/serializer into a promise to support `waitForCache` option.
    return new Promise<void>((resolve, reject) => {
      function cache (err: Error | null, contents: string | null) {
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

        return resolve(client.set(id, item, ttl(req, res)).catch(catchCacheError))
      }

      // Handle caching out-of-band with the response.
      res.body = serializer.stringify(res.body, cache)

      if (!waitForCache) {
        return resolve()
      }
    }).then(() => res)
  }

  return {
    async handle (req: Request, next: () => Promise<Response>) {
      const id = getId(serializer, req)

      const client = await pending
      const result = await client.get(id)
      let res: Response

      if (!result) {
        res = await next()
      } else {
        const { ttl, stored, item } = result
        const { varyHeaders } = item

        // Return a cached response instance.
        const response = new Response({
          url: item.url,
          body: serializer.parse(item.body),
          rawHeaders: item.rawHeaders,
          status: item.status,
          statusText: item.statusText
        })

        // Set the age of the response.
        response.set('Age', String(Math.floor((Date.now() - stored) / 1000)))

        try {
          res = await handler(req, { response, ttl, stored, varyHeaders }, next)
        } catch (err) {
          if (err.code === 'EUNAVAILABLE' && staleFallback) {
            return response
          }

          throw err
        }

        if (res && res.statusType() === 5 && staleFallback) {
          return response
        }
      }

      return await shouldCache(client, id, req, res)
    },
    async forceUpdate (req: Request, next: () => Promise<Response>) {
      return await shouldCache(await pending, getId(serializer, req), req, await next())
    },
    async stop () {
      const client = await pending

      return client.isReady() ? client.stop() : null
    }
  }
}

/**
 * Promise instance of the `catbox` client interface.
 */
interface ClientPromisified {
  stop (): void
  isReady (): boolean
  get (id: string): Promise<catbox.Client.Result<CacheItem> | null>
  set (id: string, item: CacheItem, ttl: number): Promise<void>
}

/**
 * Retrieve the engine when ready.
 */
function startYourEngine (engine: catbox.Client.Engine<CacheItem>, segment: string) {
  const client = new catbox.Client(engine)

  return new Promise<ClientPromisified>((resolve, reject) => {
    client.start(function (err) {
      if (err) {
        return reject(err)
      }

      return resolve({
        stop: () => client.stop(),
        isReady: () => client.isReady(),
        get (id: string) {
          return new Promise<catbox.Client.Result<CacheItem> | null>((resolve, reject) => {
            client.get({ segment, id }, (err, result) => {
              return err ? reject(err) : resolve(result)
            })
          })
        },
        set (id: string, value: CacheItem, ttl: number) {
          return new Promise<void>((resolve, reject) => {
            client.set({ segment, id }, value, ttl, (err) => {
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
  const age = /\bmax-age=(\d+)\b/i.exec(cacheControl)
  const mustRevalidate = /\bmust-revalidate\b/i.test(cacheControl)
  const noCache = /\bno-cache\b/i.test(cacheControl)
  const immutable = /\bimmutable\b/i.test(cacheControl)
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
