import {loadContext} from "./jsonld";
import {descriptionPredicates, labelPredicates} from "./constants";
import {withRequestSlot} from "./requests";
import {describeInBatch, isQueryableIri, trackLookup} from "./sparql-batch";
import * as N3 from 'n3';
import {RdfXmlParser} from 'rdfxml-streaming-parser';

export interface FetchResourceOptions {
  labelPredicates: string[],
  descriptionPredicates: string[],
  fallbackRainbowInstance?: string,   // deprecated: use fallbackRainbowInstances
  fallbackRainbowInstances?: string | string[],
  fallbackSparqlEndpoint?: string,    // deprecated: use fallbackSparqlEndpoints
  fallbackSparqlEndpoints?: string | string[],
  /** Maximum simultaneous HTTP requests. Default: 6 */
  maxConcurrentRequests?: number,
  /** Maximum URIs per SPARQL query. Default: 50 */
  sparqlBatchSize?: number,
  /** Milliseconds after which a request is abandoned. Default: 10000 */
  requestTimeout?: number,
}

export const defaultFetchResourceOptions: FetchResourceOptions = {
  labelPredicates,
  descriptionPredicates,
  maxConcurrentRequests: 6,
  sparqlBatchSize: 50,
  requestTimeout: 10000,
};

export interface CreatePropertiesTableOptions {
  propertiesField?: string | null,
  /** Maximum nesting levels (objects and arrays) to render. Default: 15 */
  maxDepth?: number,
  /** Maximum entries to render per array or object. Default: 100 */
  maxElements?: number,
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
  // jsonld is CommonJS: a dynamic import usually exposes it as the default export
  const imported = await import('jsonld') as any;
  const jsonldMod = imported.default ?? imported;
  if (!jsonldMod?.toRDF) {
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

const fetchAndParse = async (url: string, init: RequestInit, baseIRI: string, options: FetchResourceOptions,
                             priority = false): Promise<N3.Store | null> => {
  try {
    // The slot covers reading the body, but not parsing it
    const received = await withRequestSlot(async signal => {
      const response = await fetch(url, {...init, signal});
      if (!response.ok) {
        return null;
      }
      return {
        contentType: response.headers.get('content-type')?.split(';')[0].trim() || 'text/turtle',
        text: await response.text(),
      };
    }, {limit: options.maxConcurrentRequests!, timeout: options.requestTimeout!, priority});
    if (!received) {
      return null;
    }
    const {contentType, text} = received;
    if (N3_CONTENT_TYPES.has(contentType)) {
      return await parseTurtle(text, baseIRI, contentType);
    }
    if (contentType === 'application/ld+json') {
      return await parseJsonLd(text, baseIRI);
    }
    if (contentType === 'application/rdf+xml') {
      return await parseRdfXml(text, baseIRI);
    }
  } catch {
  }
  return null;
};

const fetchAndParseDocument = (docUrl: string, options: FetchResourceOptions, baseIRI = docUrl): Promise<N3.Store | null> => {
  if (!(docUrl in requestCache)) {
    requestCache[docUrl] = fetchAndParse(docUrl, {headers: {'Accept': ACCEPT_HEADER}}, baseIRI, options);
  }
  return requestCache[docUrl];
};

// When running on an https:// page, browsers block http:// requests (mixed content),
// so the https:// variant of an http:// URI is worth trying first.
const toHttpsIfMixedContent = (url: string): string | null => {
  if (typeof location !== 'undefined' && location.protocol === 'https:' && url.startsWith('http://')) {
    return 'https://' + url.slice('http://'.length);
  }
  return null;
};

const findResourceInStore = async (storePromise: Promise<N3.Store | null>, uri: string, options: FetchResourceOptions): Promise<ResourceData | null> => {
  const store = await storePromise;
  if (!store) {
    return null;
  }
  // The https:// document may identify its subject with either scheme
  const httpsUri = toHttpsIfMixedContent(uri);
  for (const subject of httpsUri ? [uri, httpsUri] : [uri]) {
    const label = findInStore(store, subject, options.labelPredicates);
    if (label) {
      return {uri, label, description: findInStore(store, subject, options.descriptionPredicates)};
    }
  }
  return null;
};

// Direct dereferencing and RAINBOW proxies: one request per URI (or per document)
const lookupByRequest = async (uri: string, options: FetchResourceOptions): Promise<ResourceData | null> => {
  const docUrl = uri.includes('#') ? uri.split('#')[0] : uri;

  // 1. Direct, only for HTTP(S) URIs (cached by document URL so hash siblings share one request).
  // On an https:// page, an http:// URI is tried as https:// first (the http:// request would be blocked).
  let result: ResourceData | null = null;
  if (/^https?:/i.test(uri)) {
    const httpsDocUrl = toHttpsIfMixedContent(docUrl);
    if (httpsDocUrl) {
      result = await findResourceInStore(fetchAndParseDocument(httpsDocUrl, options, docUrl), uri, options);
    }
    if (!result) {
      result = await findResourceInStore(fetchAndParseDocument(docUrl, options), uri, options);
    }
  }

  // 2. Rainbow proxies (in order) — not supported for hash URIs
  const isHashUri = uri.includes('#');
  for (const instance of [...toArray(options.fallbackRainbowInstances), ...toArray(options.fallbackRainbowInstance)]) {
    if (result || isHashUri) {
      break;
    }
    const rainbowURL = new URL(instance);
    rainbowURL.searchParams.set('uri', uri);
    result = await findResourceInStore(fetchAndParseDocument(rainbowURL.toString(), options), uri, options);
  }

  return result;
};

const sparqlQuery = (endpoint: string, options: FetchResourceOptions) => (query: string) =>
  fetchAndParse(endpoint, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/turtle, application/n-triples'},
    body: new URLSearchParams({query}).toString(),
  }, endpoint, options, true);

const actualFetchResource = async (uri: string, options: FetchResourceOptions): Promise<ResourceData> => {
  let result = await trackLookup(() => lookupByRequest(uri, options));

  // 3. SPARQL endpoints (in order), batching URIs into shared DESCRIBE queries
  for (const endpoint of [...toArray(options.fallbackSparqlEndpoints), ...toArray(options.fallbackSparqlEndpoint)]) {
    if (result || !isQueryableIri(uri)) {
      break;
    }
    result = await findResourceInStore(
      describeInBatch(endpoint, uri, options.sparqlBatchSize!, sparqlQuery(endpoint, options)),
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
  const context = await loadContext(feature, {baseUrl: response.url || url});
  return {
    feature,
    context,
  };
}