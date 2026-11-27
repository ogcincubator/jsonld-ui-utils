// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import jsonld from 'jsonld';
import {augment, createPropertiesTable} from '../src/augment';

const V = 'http://v.test/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// Documents served to context requests; label lookups get a 404
let remote: Record<string, any>;
let contextRequests: string[];

beforeEach(() => {
  remote = {};
  contextRequests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url in remote) {
      contextRequests.push(url);
      return {ok: true, json: async () => remote[url]};
    }
    return {ok: false, status: 404};
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(data: any, context: any = {}, options: Record<string, any> = {}, propertiesField: string | null = null) {
  const container = document.createElement('div');
  createPropertiesTable(data, container, {propertiesField});
  await augment(container, context, options);
  return container;
}

const uris = (el: Element) => new Set(Array.from(el.querySelectorAll('[data-uri]'), e => e.getAttribute('data-uri')!));

async function expandedIris(doc: any, base?: string) {
  const found = new Set<string>();
  const walk = (node: any) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (!k.startsWith('@')) {
          found.add(k);
        }
        if (k === '@id') {
          found.add(v as string);
        } else if (k === '@type' && !('@value' in node)) {
          found.add(RDF_TYPE);
          ([] as string[]).concat(v as any).forEach(t => found.add(t));
        }
        walk(v);
      }
    }
  };
  const documentLoader = async (url: string) => ({documentUrl: url, document: remote[url], contextUrl: undefined});
  walk(await jsonld.expand(structuredClone(doc), {base, documentLoader} as any));
  return found;
}

async function expectSameAsJsonLd(doc: any, base?: string) {
  const el = await run(structuredClone(doc), {}, {baseUrl: base});
  expect(uris(el)).toEqual(await expandedIris(doc, base));
}

describe('embedded contexts match JSON-LD expansion', () => {
  it('override outer terms for the object and its descendants, not its siblings', async () => {
    await expectSameAsJsonLd({
      '@context': {'@vocab': V, name: `${V}outer`},
      a: {'@context': {name: `${V}inner`}, name: 'x', deeper: {name: 'y'}},
      b: {name: 'z'},
    });
  });

  it('apply inside arrays, each entry on its own', async () => {
    await expectSameAsJsonLd({
      '@context': {'@vocab': V},
      list: [{'@context': {name: `${V}one`}, name: 'x'}, {name: 'y'}, [{'@context': {name: `${V}two`}, name: 'z'}]],
    });
  });

  it('can define keyword aliases and @id coercion', async () => {
    await expectSameAsJsonLd({
      '@context': {'@vocab': V},
      a: {
        '@context': {id: '@id', kind: '@type', link: {'@id': `${V}link`, '@type': '@id'}, ex: 'http://ex.test/'},
        id: 'ex:1', kind: 'ex:A', link: 'ex:2',
      },
    });
  });

  it('are applied before type-scoped contexts', async () => {
    await expectSameAsJsonLd({
      '@context': {'@vocab': V},
      a: {
        '@context': {T: {'@id': `${V}T`, '@context': {name: `${V}scoped`}}, name: `${V}embedded`},
        '@type': 'T', name: 'x', child: {name: 'y'},
      },
    });
  });

  it('are applied after property-scoped contexts', async () => {
    await expectSameAsJsonLd({
      '@context': {p: {'@id': `${V}p`, '@context': {name: `${V}scoped`, other: `${V}other`}}},
      p: {'@context': {name: `${V}embedded`}, name: 'x', other: 'y'},
    });
  });

  it('reset everything with null', async () => {
    await expectSameAsJsonLd({
      '@context': {'@vocab': V, name: `${V}outer`},
      a: {'@context': null, name: 'x', other: 'y'},
    });
  });

  it('reset before applying the rest of an array', async () => {
    await expectSameAsJsonLd({
      '@context': {'@vocab': V, name: `${V}outer`},
      a: {'@context': [null, {other: `${V}new`}], name: 'x', other: 'y'},
    });
  });

  it('reset through a null property-scoped context', async () => {
    await expectSameAsJsonLd({
      '@context': {p: {'@id': `${V}p`, '@context': {q: {'@id': `${V}q`, '@context': null}, name: `${V}name`}}},
      p: {'@context': {}, q: {name: 'x'}},
    });
  });

  it('resolve a relative @base against the outer one', async () => {
    await expectSameAsJsonLd({
      '@context': {'@base': 'dir/', '@vocab': V},
      a: {'@context': {'@base': 'sub/'}, '@id': 'x'},
    }, 'http://base.test/doc.json');
  });

  it('are remote, with relative URLs resolved against the base', async () => {
    remote['http://base.test/ctx/a.json'] = {'@context': ['b.json', {a: `${V}a`}]};
    remote['http://base.test/ctx/b.json'] = {'@context': {b: `${V}b`}};
    await expectSameAsJsonLd({
      '@context': {'@vocab': V},
      child: {'@context': 'ctx/a.json', a: 1, b: 2},
    }, 'http://base.test/doc.json');
  });

  it('are an array mixing remote and inline entries', async () => {
    remote['http://ctx.test/a.json'] = {'@context': {a: `${V}a`, b: `${V}remote`}};
    await expectSameAsJsonLd({
      '@context': {'@vocab': V},
      child: {'@context': ['http://ctx.test/a.json', {b: `${V}inline`}], a: 1, b: 2},
    });
  });
});

describe('embedded context handling', () => {
  it('applies to objects below the properties field', async () => {
    const el = await run({properties: {'@context': {name: `${V}name`}, name: 'x'}}, {}, {}, 'properties');
    expect(uris(el)).toEqual(new Set([`${V}name`]));
  });

  it('does not modify the data', async () => {
    remote['http://ctx.test/a.json'] = {'@context': {a: `${V}a`}};
    const data = {
      child: {
        '@context': {p: {'@id': `${V}p`, '@context': 'http://ctx.test/a.json'}},
        p: {a: 1},
      },
    };
    const original = structuredClone(data);
    const el = await run(data);
    expect(uris(el)).toEqual(new Set([`${V}p`, `${V}a`]));
    expect(data).toEqual(original);
  });

  it('keeps the outer context if one cannot be loaded, and retries it later', async () => {
    const data = {child: {'@context': 'http://ctx.test/later.json', name: 'x', other: 'y'}};
    const context = {child: `${V}child`, name: `${V}name`};

    const failed = await run(data, context);
    expect(uris(failed)).toEqual(new Set([`${V}child`, `${V}name`]));
    expect(console.warn).toHaveBeenCalled();

    remote['http://ctx.test/later.json'] = {'@context': {other: `${V}other`}};
    const retried = await run(data, context);
    expect(uris(retried)).toContain(`${V}other`);
  });

  it('gives up on a context that does not answer', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => url.includes('hang')
      ? new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
      : Promise.resolve({ok: false, status: 404})));
    const el = await run({child: {'@context': 'http://ctx.test/hang.json', name: 'x'}},
      {name: `${V}name`}, {requestTimeout: 20});
    expect(uris(el)).toEqual(new Set([`${V}name`]));
  });

  it('does not make other branches wait for a slow context', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('slow')) {
        await gate;
        return {ok: true, json: async () => ({'@context': {a: `${V}a`}})};
      }
      return {ok: false, status: 404};
    }));
    const container = document.createElement('div');
    createPropertiesTable({slow: {'@context': 'http://ctx.test/slow.json', a: 1}, fast: {b: 2}}, container,
      {propertiesField: null});
    const done = augment(container, {'@vocab': V});
    expect(uris(container)).toContain(`${V}b`);
    expect(uris(container)).not.toContain(`${V}a`);
    release();
    await done;
    expect(uris(container)).toContain(`${V}a`);
  });

  it('requests a shared remote context once', async () => {
    remote['http://ctx.test/shared.json'] = {'@context': {a: `${V}a`}};
    const entry = {'@context': 'http://ctx.test/shared.json', a: 1};
    await run({list: [entry, entry, entry]}, {'@vocab': V});
    expect(contextRequests).toEqual(['http://ctx.test/shared.json']);
  });
});
