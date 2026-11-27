// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import jsonld from 'jsonld';
import {augment, createPropertiesTable} from '../src/augment';
import {loadContext} from '../src/jsonld';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ok: false})));
  console.error = () => {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run(data: any, context: any, options: Record<string, any> = {}) {
  const container = document.createElement('div');
  createPropertiesTable(data, container, {propertiesField: null});
  await augment(container, context, options);
  return container;
}

const uris = (el: Element) => Array.from(el.querySelectorAll('[data-uri]'), e => e.getAttribute('data-uri')!);

// Every IRI that jsonld.js produces for a document, as a reference for our own resolution
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
          found.add('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
          ([] as string[]).concat(v as any).forEach(t => found.add(t));
        }
        walk(v);
      }
    }
  };
  walk(await jsonld.expand(doc, {base}));
  return found;
}

async function expectSameAsJsonLd(context: any, data: any, base?: string) {
  const el = await run(data, structuredClone(context), {baseUrl: base});
  expect(new Set(uris(el))).toEqual(await expandedIris({'@context': context, ...data}, base));
}

describe('augment matches JSON-LD expansion', () => {
  it('@id and @type keywords with a vocabulary', async () => {
    await expectSameAsJsonLd(
      {'@vocab': 'http://v.test/', ex: 'http://ex.test/'},
      {'@id': 'ex:thing', '@type': ['ex:A', 'B'], name: 'x'},
    );
  });

  it('keyword aliases and relative identifiers', async () => {
    await expectSameAsJsonLd(
      {id: '@id', type: '@type', Thing: 'http://v.test/Thing', link: {'@id': 'http://v.test/link', '@type': '@id'}},
      {id: 'items/1', type: 'Thing', link: ['../2', 'http://other.test/3']},
      'http://base.test/a/doc.json',
    );
  });

  it('@base in the context wins over baseUrl', async () => {
    await expectSameAsJsonLd({'@base': 'http://ctx.test/', '@vocab': 'http://v.test/'}, {'@id': 'x', name: 'a'}, 'http://base.test/doc.json');
  });

  it('@vocab-coerced values', async () => {
    await expectSameAsJsonLd(
      {'@vocab': 'http://v.test/', kind: {'@id': 'http://v.test/kind', '@type': '@vocab'}},
      {kind: 'Big'},
    );
  });

  it('type-scoped contexts, which do not propagate to nested nodes', async () => {
    await expectSameAsJsonLd(
      {
        '@vocab': 'http://v.test/',
        T: {'@id': 'http://v.test/T', '@context': {name: 'http://scoped.test/name'}},
      },
      {'@type': 'T', name: 'a', child: {name: 'b'}},
    );
  });

  it('property-scoped contexts and @graph', async () => {
    await expectSameAsJsonLd(
      {p: {'@id': 'http://v.test/p', '@context': {name: 'http://scoped.test/name'}}, name: 'http://v.test/name'},
      {'@graph': [{p: [{name: 'a'}]}, {name: 'b'}]},
    );
  });
});

describe('augment keyword cells', () => {
  it('does not link the @id key or other keywords', async () => {
    const el = await run({'@id': 'http://ex.test/1', '@graph': []}, {'@vocab': 'http://v.test/'});
    expect(el.querySelectorAll('.object-property[data-uri]')).toHaveLength(0);
  });

  it('leaves blank nodes and unresolvable relative identifiers alone', async () => {
    const el = await run({'@id': '_:b0', other: {'@id': 'relative'}}, {});
    expect(uris(el)).toEqual([]);
  });
});

describe('loadContext baseUrl', () => {
  it('resolves relative references against the base, then against each remote context', async () => {
    const docs: Record<string, any> = {
      'http://base.test/ctx/a.json': {'@context': ['b.json', {'@base': 'http://ignored.test/', a: 'x:a'}]},
      'http://base.test/ctx/b.json': {'@context': {b: 'x:b'}},
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({json: async () => docs[url]})));
    const context = await loadContext('ctx/a.json', {baseUrl: 'http://base.test/doc.json'});
    expect(context).toEqual({a: 'x:a', b: 'x:b'});
  });
});
