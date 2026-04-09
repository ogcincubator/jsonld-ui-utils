import {loadContext} from "./jsonld";
import {descriptionPredicates, labelPredicates} from "./constants";
import * as N3 from 'n3';
import {RdfXmlParser} from 'rdfxml-streaming-parser';

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

const fetchResourceCache: { [uri: string]: Promise<ResourceData> } = {};
const requestCache: { [url: string]: Promise<N3.Store | null> } = {};

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

function getUserLanguages(): string[] {
  if (typeof navigator !== 'undefined' && navigator.languages?.length) {
    return Array.from(navigator.languages);
  }
  try {
    return [Intl.DateTimeFormat().resolvedOptions().locale];
  } catch {
    return [];
  }
}

export function findInStore(store: N3.Store, subjectUri: string, predicates: string[], userLangs = getUserLanguages()): string | null {
  const subj = N3.DataFactory.namedNode(subjectUri);
  for (const predUri of predicates) {
    const quads = store
      .getQuads(subj, N3.DataFactory.namedNode(predUri), null, null)
      .filter(q => q.object.termType === 'Literal');
    if (!quads.length) {
      continue;
    }
    for (const lang of userLangs) {
      const base = lang.split('-')[0].toLowerCase();
      const match = quads.find(q => {
        const qLang = (q.object as N3.Literal).language?.toLowerCase();
        return qLang === lang.toLowerCase() || qLang?.split('-')[0] === base;
      });
      if (match) {
        return match.object.value;
      }
    }
    const noLang = quads.find(q => !(q.object as N3.Literal).language);
    if (noLang) {
      return noLang.object.value;
    }
    const en = quads.find(q => (q.object as N3.Literal).language?.toLowerCase() === 'en');
    return (en ?? quads[0]).object.value;
  }
  return null;
}

function parseTurtle(text: string, baseIRI: string, contentType: string): Promise<N3.Store> {
  const store = new N3.Store();
  const format = contentType === 'text/anot+turtle' ? 'text/turtle' : contentType as any;
  const parser = new N3.Parser({baseIRI, format});
  return new Promise((resolve, reject) => {
    parser.parse(text, (err, quad) => {
      if (err) {
        return reject(err);
      }
      if (quad) {
        store.addQuad(quad);
      }
      else {
        resolve(store);
      }
    });
  });
}

async function parseJsonLd(text: string, baseIRI: string): Promise<N3.Store> {
  const jsonldMod = await import('jsonld') as any;
  if (!jsonldMod) {
    throw new Error('jsonld peer dependency is not available');
  }
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

const fetchAndParse = async (fetchFn: () => Promise<Response>, baseIRI: string): Promise<N3.Store | null> => {
  let response: Response;
  try {
    response = await fetchFn();
    if (!response.ok) {
      return null;
    }
  } catch {
    return null;
  }
  const contentType = response.headers.get('content-type')?.split(';')[0].trim() || 'text/turtle';
  const text = await response.text();
  try {
    if (N3_CONTENT_TYPES.has(contentType)) {
      return parseTurtle(text, baseIRI, contentType);
    }
    if (contentType === 'application/ld+json') {
      return parseJsonLd(text, baseIRI);
    }
    if (contentType === 'application/rdf+xml') {
      return parseRdfXml(text, baseIRI);
    }
  } catch {
  }
  return null;
};

const fetchAndParseDocument = (docUrl: string, fetchFn: () => Promise<Response>): Promise<N3.Store | null> => {
  if (!(docUrl in requestCache)) {
    requestCache[docUrl] = fetchAndParse(fetchFn, docUrl);
  }
  return requestCache[docUrl];
};

const findResourceInStore = async (storePromise: Promise<N3.Store | null>, uri: string, options: FetchResourceOptions): Promise<ResourceData | null> => {
  const store = await storePromise;
  if (!store) {
    return null;
  }
  const label = findInStore(store, uri, options.labelPredicates);
  if (!label) {
    return null;
  }
  return {uri, label, description: findInStore(store, uri, options.descriptionPredicates)};
};

const actualFetchResource = async (uri: string, options: FetchResourceOptions): Promise<ResourceData> => {
  const docUrl = uri.includes('#') ? uri.split('#')[0] : uri;

  // 1. Direct (cached by document URL so hash siblings share one request)
  let result = await findResourceInStore(
    fetchAndParseDocument(docUrl, () => fetch(docUrl, {headers: {'Accept': ACCEPT_HEADER}})),
    uri, options,
  );

  // 2. Rainbow proxies (in order) — not supported for hash URIs
  const isHashUri = uri.includes('#');
  for (const instance of [...toArray(options.fallbackRainbowInstances), ...toArray(options.fallbackRainbowInstance)]) {
    if (result || isHashUri) {
      break;
    }
    const rainbowURL = new URL(instance);
    rainbowURL.searchParams.set('uri', uri);
    const rainbowUrlStr = rainbowURL.toString();
    result = await findResourceInStore(
      fetchAndParseDocument(rainbowUrlStr, () => fetch(rainbowUrlStr, {headers: {'Accept': ACCEPT_HEADER}})),
      uri, options,
    );
  }

  // 3. SPARQL endpoints (in order) — each DESCRIBE is unique per URI, no request cache
  for (const endpoint of [...toArray(options.fallbackSparqlEndpoints), ...toArray(options.fallbackSparqlEndpoint)]) {
    if (result) {
      break;
    }
    const formBody = new URLSearchParams({query: getSparqlQuery(uri)});
    result = await findResourceInStore(
      fetchAndParse(() => fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/turtle, application/n-triples'},
        body: formBody.toString(),
      }), uri),
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