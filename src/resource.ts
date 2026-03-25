import {loadContext} from "./jsonld";
import {descriptionPredicates, labelPredicates} from "./constants";
import * as N3 from 'n3';
import { RdfXmlParser } from 'rdfxml-streaming-parser';

export interface FetchResourceOptions {
  labelPredicates: string[],
  descriptionPredicates: string[],
  fallbackRainbowInstance?: string,   // deprecated: use fallbackRainbowInstances
  fallbackRainbowInstances?: string | string[],
  fallbackSparqlEndpoint?: string,    // deprecated: use fallbackSparqlEndpoints
  fallbackSparqlEndpoints?: string | string[],
}

export const defaultFetchResourceOptions: FetchResourceOptions = {
  labelPredicates,
  descriptionPredicates,
};

export interface CreatePropertiesTableOptions {
  propertiesField?: string | null,
}

export interface ResourceData {
  uri: string,
  label: string | null,
  description?: string | null,
}

const fetchResourceCache: { [url: string]: Promise<ResourceData> } = {};

const N3_CONTENT_TYPES = new Set([
  'text/turtle',
  'text/n3',
  'application/n-triples',
  'application/n-quads',
  'application/trig',
  'text/anot+turtle',
]);

const ACCEPT_HEADER = [
  'text/turtle',
  'application/n-triples',
  'application/n-quads',
  'application/trig',
  'application/ld+json',
  'application/rdf+xml',
].join(', ');

function findInStore(store: N3.Store, subjectUri: string, predicates: string[]): string | null {
  const subj = N3.DataFactory.namedNode(subjectUri);
  for (const predUri of predicates) {
    const quads = store
      .getQuads(subj, N3.DataFactory.namedNode(predUri), null, null)
      .filter(q => q.object.termType === 'Literal');
    if (!quads.length) continue;
    const en = quads.find(q => (q.object as N3.Literal).language === 'en');
    const noLang = quads.find(q => !(q.object as N3.Literal).language);
    return (en ?? noLang ?? quads[0]).object.value;
  }
  return null;
}

function parseTurtle(text: string, baseIRI: string, contentType: string): Promise<N3.Store> {
  const store = new N3.Store();
  const format = contentType === 'text/anot+turtle' ? 'text/turtle' : contentType as any;
  const parser = new N3.Parser({baseIRI, format});
  return new Promise((resolve, reject) => {
    parser.parse(text, (err, quad) => {
      if (err) return reject(err);
      if (quad) store.addQuad(quad);
      else resolve(store);
    });
  });
}

async function parseJsonLd(text: string, baseIRI: string): Promise<N3.Store> {
  const jsonldMod = await import('jsonld') as any;
  if (!jsonldMod) throw new Error('jsonld peer dependency is not available');
  const doc = JSON.parse(text);
  const nquads = await jsonldMod.toRDF(doc, {format: 'application/n-quads', base: baseIRI});
  return parseTurtle(nquads, baseIRI, 'application/n-quads');
}

async function parseRdfXml(text: string, baseIRI: string): Promise<N3.Store> {
  const store = new N3.Store();
  return new Promise((resolve, reject) => {
    const parser = new RdfXmlParser({baseIRI});
    parser.on('data', (quad: any) => store.addQuad(quad));
    parser.on('error', reject);
    parser.on('end', () => resolve(store));
    parser.write(text);
    parser.end();
  });
}

const toArray = (val?: string | string[]): string[] =>
  !val ? [] : Array.isArray(val) ? val : [val];

const getSparqlQuery = (uri: string) => `DESCRIBE <${uri}>`;

const tryFetchAndParse = async (fetchFn: () => Promise<Response>, uri: string, options: FetchResourceOptions): Promise<ResourceData | null> => {
  let response: Response;
  try {
    response = await fetchFn();
    if (!response.ok) return null;
  } catch {
    return null;
  }
  const contentType = response.headers.get('content-type')?.split(';')[0].trim() || 'text/turtle';
  const text = await response.text();
  let store: N3.Store;
  try {
    if (N3_CONTENT_TYPES.has(contentType)) {
      store = await parseTurtle(text, uri, contentType);
    } else if (contentType === 'application/ld+json') {
      store = await parseJsonLd(text, uri);
    } else if (contentType === 'application/rdf+xml') {
      store = await parseRdfXml(text, uri);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const label = findInStore(store, uri, options.labelPredicates);
  if (!label) return null;
  return {
    uri,
    label,
    description: findInStore(store, uri, options.descriptionPredicates),
  };
};

const actualFetchResource = async (uri: string, options: FetchResourceOptions): Promise<ResourceData> => {
  // 1. Direct
  let result = await tryFetchAndParse(
    () => fetch(uri, {headers: {'Accept': ACCEPT_HEADER}}),
    uri, options,
  );

  // 2. Rainbow proxies (in order)
  for (const instance of [...toArray(options.fallbackRainbowInstances), ...toArray(options.fallbackRainbowInstance)]) {
    if (result) break;
    const rainbowURL = new URL(instance);
    rainbowURL.searchParams.set('uri', uri);
    result = await tryFetchAndParse(
      () => fetch(rainbowURL.toString(), {headers: {'Accept': ACCEPT_HEADER}}),
      uri, options,
    );
  }

  // 3. SPARQL endpoints (in order)
  for (const endpoint of [...toArray(options.fallbackSparqlEndpoints), ...toArray(options.fallbackSparqlEndpoint)]) {
    if (result) break;
    const formBody = new URLSearchParams({query: getSparqlQuery(uri)});
    result = await tryFetchAndParse(
      () => fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/turtle, application/n-triples'},
        body: formBody.toString(),
      }),
      uri, options,
    );
  }

  if (!result) {
    throw new Error(`No label data found for <${uri}>`);
  }
  return result;
};

export async function fetchResource(uri: string, options: Partial<FetchResourceOptions> = {}) {
  const mergedOptions: FetchResourceOptions = {...defaultFetchResourceOptions, ...options};
  if (!(uri in fetchResourceCache)) {
    fetchResourceCache[uri] = actualFetchResource(uri, mergedOptions);
  }
  return fetchResourceCache[uri];
}

export async function loadFeature(url: string) {
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/ld+json, application/json;q=0.9, */*;q=0.1',
    },
  });
  if (!response.ok) {
    throw new Error(`Could not load feature ${url}: ${response.status} - ${response.statusText}`);
  }
  const feature = await response.json();
  const context = await loadContext(feature);
  return {
    feature,
    context,
  };
}