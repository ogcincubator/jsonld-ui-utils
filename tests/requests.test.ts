import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type Resource = typeof import('../src/resource');
let fetchResource: Resource['fetchResource'];

const SPARQL = 'http://sparql.test/query';
const label = (uri: string) => `<${uri}> <http://www.w3.org/2000/01/rdf-schema#label> "label of ${uri}" .`;
const turtle = (body: string) => new Response(body, {headers: {'Content-Type': 'text/turtle'}});
const notFound = () => new Response('', {status: 404});
const described = (init: RequestInit) =>
  Array.from(new URLSearchParams(init.body as string).get('query')!.matchAll(/<([^>]*)>/g), m => m[1]);
const urns = (count: number) => Array.from({length: count}, (_, i) => `urn:x:${i}`);

let calls: { url: string, init: RequestInit }[];
const sparqlCalls = () => calls.filter(c => c.init.method === 'POST');

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({url, init});
    return handler(url, init);
  }));
}

const answerAll = (_: string, init: RequestInit) =>
  init.method === 'POST' ? turtle(described(init).map(label).join('\n')) : notFound();

beforeEach(async () => {
  calls = [];
  // Fresh caches and queues for every test
  vi.resetModules();
  ({fetchResource} = await import('../src/resource'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('concurrency', () => {
  it('runs at most 6 requests at a time by default', async () => {
    let active = 0;
    let peak = 0;
    stubFetch(async url => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return turtle(label(url));
    });
    await Promise.all(Array.from({length: 20}, (_, i) => fetchResource(`http://a.test/${i}`)));
    expect(calls).toHaveLength(20);
    expect(peak).toBe(6);
  });

  it('gives up on hanging requests so that others can proceed', async () => {
    stubFetch((url, init) => url.includes('hang')
      ? new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
      : turtle(label(url)));
    const options = {maxConcurrentRequests: 1, requestTimeout: 20};
    const hanging = fetchResource('http://a.test/hang', options);
    const next = fetchResource('http://a.test/ok', options);
    await expect(hanging).rejects.toThrow('No label data');
    expect((await next).label).toBe('label of http://a.test/ok');
  });
});

describe('SPARQL batching', () => {
  it('skips the direct request for non-HTTP URIs and sends a single query', async () => {
    stubFetch(answerAll);
    const results = await Promise.all(urns(10).map(u => fetchResource(u, {fallbackSparqlEndpoints: SPARQL})));
    expect(results.map(r => r.label)).toEqual(urns(10).map(u => `label of ${u}`));
    expect(calls).toHaveLength(1);
    expect(described(calls[0].init)).toEqual(urns(10));
  });

  it('splits into batches of sparqlBatchSize and sends the leftovers', async () => {
    stubFetch(answerAll);
    await Promise.all(urns(12).map(u => fetchResource(u, {fallbackSparqlEndpoints: SPARQL, sparqlBatchSize: 5})));
    expect(sparqlCalls().map(c => described(c.init).length)).toEqual([5, 5, 2]);
  });

  it('waits for pending direct lookups before sending', async () => {
    stubFetch(async (url, init) => {
      await new Promise(resolve => setTimeout(resolve, url.endsWith('slow') ? 40 : 1));
      return answerAll(url, init);
    });
    await Promise.all(['http://a.test/fast', 'http://a.test/slow'].map(
      u => fetchResource(u, {fallbackSparqlEndpoints: SPARQL})));
    expect(sparqlCalls()).toHaveLength(1);
  });

  it('does not let a hanging direct lookup stall the batch', async () => {
    vi.useFakeTimers();
    stubFetch((url, init) => init.method === 'POST' ? answerAll(url, init) : new Promise(() => {}));
    fetchResource('http://a.test/hang', {fallbackSparqlEndpoints: SPARQL});
    const result = fetchResource('urn:x:1', {fallbackSparqlEndpoints: SPARQL});
    await vi.advanceTimersByTimeAsync(499);
    expect(sparqlCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).label).toBe('label of urn:x:1');
  });

  it('sends a due batch ahead of queued direct lookups', async () => {
    stubFetch(async (url, init) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return answerAll(url, init);
    });
    const options = {fallbackSparqlEndpoints: SPARQL, maxConcurrentRequests: 1, sparqlBatchSize: 1};
    await Promise.allSettled(['urn:x:1', 'http://a.test/1', 'http://a.test/2', 'http://a.test/3']
      .reverse().map(u => fetchResource(u, options)));
    expect(calls.map(c => c.init.method ?? 'GET').slice(0, 2)).toEqual(['GET', 'POST']);
  });

  it('keeps waiting batches in the order they were sent', async () => {
    stubFetch(async (url, init) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return answerAll(url, init);
    });
    const options = {fallbackSparqlEndpoints: SPARQL, maxConcurrentRequests: 1, sparqlBatchSize: 1};
    await Promise.all(urns(3).map(u => fetchResource(u, options)));
    expect(sparqlCalls().map(c => described(c.init)[0])).toEqual(urns(3));
  });

  it('moves unresolved URIs, or a whole failed batch, to the next endpoint', async () => {
    stubFetch((url, init) => {
      if (url === 'http://first.test/') {
        return turtle(label('urn:x:0'));
      }
      return url === 'http://broken.test/' ? new Response('', {status: 500}) : answerAll(url, init);
    });
    const options = {fallbackSparqlEndpoints: ['http://first.test/', 'http://broken.test/', SPARQL]};
    await Promise.all(urns(3).map(u => fetchResource(u, options)));
    expect(calls.map(c => [c.url, described(c.init).length])).toEqual([
      ['http://first.test/', 3], ['http://broken.test/', 2], [SPARQL, 2],
    ]);
  });

  it('keeps invalid IRIs out of the query', async () => {
    stubFetch(answerAll);
    const results = await Promise.allSettled(['urn:x:ok', 'urn:x:a b', 'urn:x:a>b'].map(
      u => fetchResource(u, {fallbackSparqlEndpoints: SPARQL})));
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(described(calls[0].init)).toEqual(['urn:x:ok']);
  });

  it('reads labels from JSON-LD responses', async () => {
    stubFetch(url => new Response(
      JSON.stringify({'@id': url, 'http://www.w3.org/2000/01/rdf-schema#label': 'from JSON-LD'}),
      {headers: {'Content-Type': 'application/ld+json'}}));
    expect((await fetchResource('http://a.test/jsonld')).label).toBe('from JSON-LD');
  });

  it('falls back when a response cannot be parsed', async () => {
    stubFetch((url, init) => init.method === 'POST' ? answerAll(url, init) : turtle('<<< not turtle'));
    const result = await fetchResource('http://a.test/bad', {fallbackSparqlEndpoints: SPARQL});
    expect(result.label).toBe('label of http://a.test/bad');
  });
});
