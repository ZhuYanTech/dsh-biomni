/**
 * The fenced /biomni/api route: the settings seam that routes around DSH's
 * settings-RPC allowlist, and the fence that keeps it from being a cross-site
 * hole.
 *
 * These are the assertions that would catch a regression nobody sees until a
 * user opens the Settings page: a fence that stops fencing, a revision guard
 * that silently stops guarding, an unknown method answering 200.
 */
import { describe, expect, it } from 'vitest'
import { apply, Config } from '../src/index.ts'
import type { BiomniConfig } from '../src/config.ts'
import { isTrustedApiRequest } from '../src/trust-fence.ts'
import { buildApi } from '../src/api.ts'
import { BiomniError } from '../src/wire.ts'
import { fakeRequest, fakeResponse, stubContext } from './stubs.ts'

/** Mount the plugin and hand back the route handler plus the recorder. */
function mount() {
  const { ctx, rec } = stubContext()
  apply(ctx, new Config({ python: 'python3' }) as unknown as BiomniConfig)
  const route = rec.routes.find(candidate => candidate.path === '/biomni/api')!
  return { rec, handler: route.handler }
}

describe('trust fence', () => {
  it('accepts loopback authorities', () => {
    for (const host of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080', '127.10.0.9']) {
      expect(isTrustedApiRequest({ headers: { host } }, [])).toBe(true)
    }
  })

  it('refuses a non-loopback authority that is not configured', () => {
    expect(isTrustedApiRequest({ headers: { host: 'evil.example.com' } }, [])).toBe(false)
    expect(isTrustedApiRequest({ headers: { host: '192.168.1.10:3080' } }, [])).toBe(false)
  })

  it('accepts a configured trusted authority', () => {
    expect(isTrustedApiRequest({ headers: { host: '192.168.1.10:3080' } }, ['192.168.1.10:3080'])).toBe(true)
    // A port-less entry trusts the hostname on any port.
    expect(isTrustedApiRequest({ headers: { host: 'dev.box:9999' } }, ['dev.box'])).toBe(true)
  })

  it('refuses a request with no Host header', () => {
    // Nothing to compare against; refuse rather than guess.
    expect(isTrustedApiRequest({ headers: {} }, [])).toBe(false)
  })
})

describe('the route', () => {
  it('refuses an untrusted origin with 403', async () => {
    const { handler } = mount()
    const res = fakeResponse()
    await handler(fakeRequest('/biomni/api/settings.get', {}, { host: 'evil.example.com' }), res)
    expect(res.status).toBe(403)
  })

  it('refuses a non-POST with 405', async () => {
    const { handler } = mount()
    const res = fakeResponse()
    const req = { ...fakeRequest('/biomni/api/settings.get', {}), method: 'GET' }
    await handler(req as never, res)
    expect(res.status).toBe(405)
  })

  it('404s an unknown method', async () => {
    const { handler } = mount()
    const res = fakeResponse()
    await handler(fakeRequest('/biomni/api/nope', {}), res)
    expect(res.status).toBe(404)
  })

  it('404s a nested path rather than treating it as a method', async () => {
    const { handler } = mount()
    const res = fakeResponse()
    await handler(fakeRequest('/biomni/api/a/b', {}), res)
    expect(res.status).toBe(404)
  })

  it('serves the resolved settings with a revision', async () => {
    const { handler } = mount()
    const res = fakeResponse()
    await handler(fakeRequest('/biomni/api/settings.get', {}), res)
    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; value: { value: { python: string }; revision: number } }
    expect(body.ok).toBe(true)
    expect(body.value.value.python).toBe('python3')
    expect(typeof body.value.revision).toBe('number')
  })

  it('applies a patch and returns the fresh view', async () => {
    const { handler, rec } = mount()
    const res = fakeResponse()
    await handler(fakeRequest('/biomni/api/settings.update', {
      patch: { python: '/venv/bin/python' },
      expectedRevision: rec.revision,
    }), res)
    expect(res.status).toBe(200)
    const body = res.body as { value: { value: { python: string } } }
    expect(body.value.value.python).toBe('/venv/bin/python')
  })

  it('refuses a stale writer with 409', async () => {
    const { handler, rec } = mount()
    const res = fakeResponse()
    await handler(fakeRequest('/biomni/api/settings.update', {
      patch: { python: '/venv/bin/python' },
      expectedRevision: rec.revision - 1,
    }), res)
    expect(res.status).toBe(409)
    expect((res.body as { error: { code: string } }).error.code).toBe('settings-conflict')
  })

  it('rejects a malformed patch', async () => {
    const { handler } = mount()
    const res = fakeResponse()
    await handler(fakeRequest('/biomni/api/settings.update', { patch: 'nope' }), res)
    expect(res.status).toBe(400)
  })

  it('rejects a body that is not JSON', async () => {
    const { handler } = mount()
    const res = fakeResponse()
    const req = {
      url: '/biomni/api/settings.get',
      method: 'POST',
      headers: { host: '127.0.0.1:3080' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{not json') },
    }
    await handler(req as never, res)
    expect(res.status).toBe(400)
  })
})

describe('the method table', () => {
  it('degrades to 503 when the deployment has no settings service', async () => {
    const api = buildApi({
      settings: () => undefined,
      python: () => 'python3',
      probe: async () => { throw new Error('unused') },
      datasets: async () => { throw new Error('unused') },
      fetch: async () => { throw new Error('unused') },
      artifacts: async () => { throw new Error('unused') },
    })
    expect(api['settings.get']!({})).toEqual({ value: undefined, revision: undefined })
    await expect(api['settings.update']!({ patch: {} }))
      .rejects.toMatchObject({ code: 'settings-rejected', status: 503 })
  })

  it('reports a probe that cannot run as data, not as a transport failure', async () => {
    // "your interpreter path is wrong" is the single most common answer here,
    // and it deserves to reach the panel rather than surfacing as a 500.
    const api = buildApi({
      settings: () => undefined,
      python: () => '/no/such/python',
      probe: async () => { throw new Error('ENOENT') },
      datasets: async () => { throw new Error('unused') },
      fetch: async () => { throw new Error('unused') },
      artifacts: async () => { throw new Error('unused') },
    })
    await expect(api['env.probe']!({})).resolves.toEqual({
      python: '/no/such/python',
      report: null,
      error: 'ENOENT',
    })
  })

  it('maps a non-conflict settings rejection to 400', async () => {
    const api = buildApi({
      settings: () => ({
        get: () => ({}),
        update: async () => { throw new Error('schema violation: timeoutMs') },
      }),
      python: () => 'python3',
      probe: async () => { throw new Error('unused') },
      datasets: async () => { throw new Error('unused') },
      fetch: async () => { throw new Error('unused') },
      artifacts: async () => { throw new Error('unused') },
    })
    await expect(api['settings.update']!({ patch: { timeoutMs: -1 } }))
      .rejects.toMatchObject({ code: 'settings-rejected', status: 400 })
  })
})

describe('BiomniError', () => {
  it('defaults to 400', () => {
    expect(new BiomniError('bad-request', 'x').status).toBe(400)
  })
})

describe('the dataset methods', () => {
  /** A table whose fetch records what it was asked for. */
  function withFetch() {
    const calls: { names: string[]; accept: boolean }[] = []
    const api = buildApi({
      settings: () => undefined,
      python: () => 'python3',
      probe: async () => { throw new Error('unused') },
      datasets: async () => { throw new Error('helper exited 1: ENOENT') },
      fetch: async (names, acceptNonCommercial) => {
        calls.push({ names, accept: acceptNonCommercial })
        return { path: '/data', results: names.map(name => ({ name, status: 'fetched' as const })) }
      },
      artifacts: async () => ({ path: '/ws/biomni-out', exists: false, totalBytes: 0, entries: [] }),
    })
    return { api, calls }
  }

  it('reports a catalog that cannot be read as data, not as a failure', async () => {
    // Same reasoning as env.probe: a wrong interpreter path is the common case
    // and belongs in the panel, not in a 500.
    const { api } = withFetch()
    await expect(api['datasets.list']!({})).resolves.toMatchObject({
      catalog: null,
      error: expect.stringContaining('ENOENT'),
    })
  })

  it.each([
    ['no payload', null],
    ['no names', {}],
    ['an empty list', { names: [] }],
    ['a bare string', { names: 'DepMap_Model.csv' }],
    ['a non-string entry', { names: [42] }],
    ['an empty name', { names: [''] }],
  ])('refuses %s', async (_label, payload) => {
    // A write, so it is strict where the reads are forgiving.
    const { api } = withFetch()
    await expect(api['datasets.fetch']!(payload)).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('passes the licence acknowledgement only when it is exactly true', async () => {
    // Anything truthy-but-not-true would make a deliberate legal choice
    // implicit. It is the one action here that deleting a file does not undo.
    const { api, calls } = withFetch()
    await api['datasets.fetch']!({ names: ['a'] })
    await api['datasets.fetch']!({ names: ['b'], acceptNonCommercial: false })
    await api['datasets.fetch']!({ names: ['c'], acceptNonCommercial: 'yes' })
    await api['datasets.fetch']!({ names: ['d'], acceptNonCommercial: 1 })
    await api['datasets.fetch']!({ names: ['e'], acceptNonCommercial: true })
    expect(calls.map(call => call.accept)).toEqual([false, false, false, false, true])
  })
})
