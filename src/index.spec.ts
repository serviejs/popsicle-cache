import { request, plugins, createTransport } from 'popsicle'
import { plugin, serializers, ttls } from './index'
import nock = require('nock')

describe('popsicle-cache', () => {
  const cache = plugin({
    engine: require('catbox-memory')
  })

  afterAll(() => {
    cache.stop()
  })

  describe('uncacheable', () => {
    beforeAll(() => {
      nock('http://example.com')
        .get('/no')
        .reply(200, 'success', {
          'ETag': '123'
        })

      nock('http://example.com')
        .get('/no')
        .reply(404)

      nock('http://example.com')
        .post('/no')
        .reply(201)
    })

    it('should make fresh http call', () => {
      return request('http://example.com/no')
        .use(cache.handle)
        .then(function (res) {
          expect(res.body).toEqual('success')
        })
    })

    it('should not use the cache for the second call', () => {
      return request('http://example.com/no')
        .use(cache.handle)
        .then(function (res) {
          expect(res.status).toEqual(404)
        })
    })

    it('non-cached method', () => {
      return request({ url: 'http://example.com/no', method: 'post' })
        .use(cache.handle)
        .then(function (res) {
          expect(res.status).toEqual(201)
        })
    })
  })

  describe('expires header', () => {
    beforeAll(() => {
      const date = new Date()
      const expires = new Date()

      expires.setDate(expires.getDate() + 1)

      nock('http://example.com')
        .get('/expires')
        .reply(200, 'success', {
          'Date': date.toUTCString(),
          'Expires': expires.toUTCString()
        })
    })

    it('should make fresh http call', () => {
      return request('http://example.com/expires')
        .use(cache.handle)
        .then(function (res) {
          expect(res.body).toEqual('success')
        })
    })

    it('should ensure the second call is cached', () => {
      return request('http://example.com/expires')
        .use(cache.handle)
        .then(function (res) {
          expect(res.body).toEqual('success')
        })
    })
  })

  describe('cache control header', () => {
    beforeAll(() => {
      nock('http://example.com')
        .get('/cache-control')
        .reply(200, '{"success":true}', {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300'
        })
    })

    it('should make fresh http call', () => {
      return request('http://example.com/cache-control')
        .use(cache.handle)
        .use(plugins.parse('json'))
        .then(function (res) {
          expect(res.body).toEqual({ success: true })
        })
    })

    it('should ensure the second call is cached', () => {
      return request('http://example.com/cache-control')
        .use(cache.handle)
        .use(plugins.parse('json'))
        .then(function (res) {
          expect(res.body).toEqual({ success: true })
        })
    })
  })

  describe('last modified', () => {
    const cache = plugin({
      engine: require('catbox-memory'),
      ttl: ttls.standard(10 * 1000, 10 * 60 * 1000)
    })

    beforeAll(() => {
      const date = new Date()
      const lastModified = new Date()

      nock('http://example.com')
        .get('/modified')
        .reply(200, '{"success":true}', {
          'Content-Type': 'application/json',
          'Date': date.toUTCString(),
          'Last-Modified': lastModified.toUTCString()
        })

      nock('http://example.com')
        .get('/modified')
        .reply(304)
    })

    it('should make fresh http call', () => {
      return request('http://example.com/modified')
        .use(cache.handle)
        .use(plugins.parse('json'))
        .then(function (res) {
          expect(res.body).toEqual({ success: true })
        })
    })

    it('should ensure the second call is cached (but validated)', () => {
      return request('http://example.com/modified')
        .use(cache.handle)
        .use(plugins.parse('json'))
        .then(function (res) {
          expect(res.body).toEqual({ success: true })
        })
    })
  })

  describe('etag', () => {
    beforeAll(() => {
      const etag = '123abc'

      nock('http://example.com')
        .get('/etag')
        .reply(200, 'success', {
          'Cache-Control': 'no-cache, max-age=100',
          'ETag': etag
        })

      nock('http://example.com')
        .get('/etag')
        .reply(304)
    })

    it('make fresh http call', () => {
      return request('http://example.com/etag')
        .use(cache.handle)
        .then(function (res) {
          expect(res.body).toEqual('success')
        })
    })

    it('should ensure the second call is cached (but validated)', () => {
      return request('http://example.com/etag')
        .use(cache.handle)
        .then(function (res) {
          expect(res.body).toEqual('success')
        })
    })
  })

  describe('unavailable', () => {
    beforeAll(() => {
      nock('http://example.com')
        .get('/unavailable')
        .reply(200, 'success', {
          'Cache-Control': 'no-cache, max-age=100'
        })

      nock('http://example.com')
        .get('/unavailable')
        .reply(502)
    })

    it('should make fresh http call', () => {
      return request('http://example.com/unavailable')
        .use(cache.handle)
        .then(function (res) {
          expect(res.body).toEqual('success')
        })
    })

    it('should ensure the second call is cached', () => {
      return request('http://example.com/unavailable')
        .use(cache.handle)
        .then(function (res) {
          expect(res.body).toEqual('success')
        })
    })
  })

  describe('stream', () => {
    const cache = plugin({
      engine: require('catbox-memory'),
      serializer: serializers.stream(),
      waitForCache: true
    })

    beforeAll(() => {
      nock('http://example.com')
        .get('/stream')
        .reply(200, 'success', {
          'Cache-Control': 'max-age=100'
        })
    })

    afterAll(() => {
      cache.stop()
    })

    it('should make fresh http call', () => {
      return request({
        url: 'http://example.com/stream',
        transport: createTransport({ type: 'stream' })
      })
        .use(cache.handle)
        .then(function (res) {
          expect(typeof res.body.pipe).toEqual('function')

          res.body.resume()
        })
    })

    it('should ensure the second call is cached', () => {
      return request({
        url: 'http://example.com/stream',
        transport: createTransport({ type: 'stream' })
      })
        .use(cache.handle)
        .then(function (res) {
          expect(typeof res.body.pipe).toEqual('function')

          res.body.resume()
        })
    })
  })

  it('run all mocks', () => {
    expect(nock.pendingMocks()).toEqual([])
  })
})
