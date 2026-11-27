import * as N3 from 'n3';
import { RdfXmlParser } from 'rdfxml-streaming-parser';
import proj4Lib from 'proj4';

const jsonFetch = async (url, timeout) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status} loading context ${url}`);
        }
        return await response.json();
    }
    finally {
        clearTimeout(timer);
    }
};
const mergeContexts = (definitions) => {
    const mergePair = (a, b) => {
        if (!a || !Object.keys(a).length) {
            return b;
        }
        const result = { ...a };
        for (const [k, v] of Object.entries(b)) {
            result[k] = v;
        }
        return result;
    };
    if (!definitions.length) {
        return {};
    }
    if (definitions.length === 1) {
        return definitions[0];
    }
    let currentContext = definitions[0];
    for (let i = 1; i < definitions.length; i++) {
        currentContext = mergePair(currentContext, definitions[i]);
    }
    return currentContext;
};
const urlCache = new Map();
const resolveUrl = (url, baseUrl) => {
    try {
        return new URL(url, baseUrl).toString();
    }
    catch (_a) {
        return url;
    }
};
/**
 * Loads a context without merging its entries. Remote references are replaced by their contents,
 * including the scoped contexts of term definitions, which are modified in place.
 */
async function loadContextEntries(context, options = {}) {
    const { requestTimeout = 10000 } = options;
    const walk = async (definition, refChain, baseUrl) => {
        for (const [key, value] of Object.entries(definition)) {
            if (key === '@context') {
                const entries = await load(value, refChain, baseUrl);
                // @ts-ignore
                definition[key] = entries.length === 1 ? entries[0] : entries;
            }
            else if (typeof value === 'object' && value !== null) {
                await walk(value, refChain, baseUrl);
            }
        }
    };
    const load = async (context, refChain, baseUrl) => {
        if (context === undefined) {
            return [];
        }
        if (context === null) {
            return [null];
        }
        if (Array.isArray(context)) {
            return (await Promise.all(context.map(e => load(e, refChain, baseUrl)))).flat();
        }
        if (typeof context === 'object') {
            await walk(context, refChain, baseUrl);
            return [context];
        }
        const url = resolveUrl(context, baseUrl);
        if (refChain === null || refChain === void 0 ? void 0 : refChain.includes(url)) {
            throw new Error('Circular dependencies found: ' + refChain.join(' -> ') + ' -> ' + url);
        }
        const newRefChain = [...(refChain !== null && refChain !== void 0 ? refChain : []), url];
        if (!urlCache.has(url)) {
            // Relative references inside a remote context are resolved against that context's own URL
            const request = jsonFetch(url, requestTimeout).then(async (obj) => {
                const entries = await load(obj['@context'], newRefChain, url);
                // @base is ignored in remote contexts
                return entries.map(entry => {
                    if (!entry) {
                        return entry;
                    }
                    const { '@base': _, ...loaded } = entry;
                    return loaded;
                });
            });
            // Failures are not cached, so that they can be retried
            request.catch(() => urlCache.delete(url));
            urlCache.set(url, request);
        }
        return urlCache.get(url);
    };
    return load(context, undefined, options.baseUrl);
}
async function loadContext(context, options = {}) {
    const unwrapped = typeof context === 'object' && context !== null && '@context' in context
        ? context['@context']
        : context;
    const entries = await loadContextEntries(unwrapped, options);
    return mergeContexts(entries.map(entry => entry !== null && entry !== void 0 ? entry : {}));
}

const ns = (base) => (local) => `${base}${local}`;
const SKOS = ns('http://www.w3.org/2004/02/skos/core#');
const RDFS = ns('http://www.w3.org/2000/01/rdf-schema#');
const DCT = ns('http://purl.org/dc/terms/');
const DC = ns('http://purl.org/dc/elements/1.1/');
const SDO = ns('https://schema.org/');
const FOAF = ns('http://xmlns.com/foaf/0.1/');
const labelPredicates = [
    SKOS('prefLabel'),
    DCT('title'),
    DC('title'),
    SDO('name'),
    FOAF('name'),
    RDFS('label'),
];
const descriptionPredicates = [
    SKOS('definition'),
    DCT('description'),
    DC('description'),
    RDFS('comment'),
];

// Limits how many HTTP requests run at once, across all lookups
let active = 0;
const waiting = [];
function startWaiting() {
    while (waiting.length && active < waiting[0].limit) {
        active++;
        waiting.shift().start();
    }
}
/**
 * Runs a task holding one request slot. The task must pass the signal to fetch() and include reading
 * the response body, so that the slot is held (and the timeout applies) until the request is done.
 */
async function withRequestSlot(task, { limit, timeout, priority = false }) {
    await new Promise(start => {
        // Priority requests queue up behind earlier priority ones, ahead of everything else
        const firstNormal = priority ? waiting.findIndex(entry => !entry.priority) : -1;
        waiting.splice(firstNormal < 0 ? waiting.length : firstNormal, 0, { limit: Math.max(1, limit), priority, start });
        startWaiting();
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        return await task(controller.signal);
    }
    finally {
        clearTimeout(timer);
        active--;
        startWaiting();
    }
}

// Collects URIs into one DESCRIBE query per endpoint. A batch is sent when the first of these happens:
// it is full, no earlier lookup is pending (so nothing else can join soon), or MAX_WAIT has passed.
const MAX_WAIT = 500;
const batches = {};
let pendingLookups = 0;
let idleCheckScheduled = false;
// Deferred, so that URIs arriving in the same burst end up in the same batch
function scheduleIdleCheck() {
    if (idleCheckScheduled) {
        return;
    }
    idleCheckScheduled = true;
    setTimeout(() => {
        idleCheckScheduled = false;
        if (!pendingLookups) {
            Object.values(batches).forEach(batch => batch.send());
        }
    }, 0);
}
/** Tracks the lookup stages that run before SPARQL, and can therefore still feed a batch */
async function trackLookup(lookup) {
    pendingLookups++;
    try {
        return await lookup();
    }
    finally {
        pendingLookups--;
        scheduleIdleCheck();
    }
}
// Characters not allowed inside <...> in SPARQL: one such URI would break the query for its whole batch
const isQueryableIri = (uri) => /^[a-z][a-z0-9+.-]*:[^\u0000- <>"{}|^`\\]*$/i.test(uri);
function createBatch(endpoint, sendQuery) {
    const uris = [];
    let resolve;
    const result = new Promise(r => resolve = r);
    const batch = {
        uris,
        result,
        send() {
            clearTimeout(timer);
            delete batches[endpoint];
            resolve(sendQuery(`DESCRIBE ${uris.map(uri => `<${uri}>`).join(' ')}`));
        },
    };
    const timer = setTimeout(batch.send, MAX_WAIT);
    return batch;
}
/** Resolves with the response to the query that included this URI */
function describeInBatch(endpoint, uri, batchSize, sendQuery) {
    var _a;
    const batch = (_a = batches[endpoint]) !== null && _a !== void 0 ? _a : (batches[endpoint] = createBatch(endpoint, sendQuery));
    batch.uris.push(uri);
    if (batch.uris.length >= batchSize) {
        batch.send();
    }
    else {
        scheduleIdleCheck();
    }
    return batch.result;
}

const defaultFetchResourceOptions = {
    labelPredicates,
    descriptionPredicates,
    maxConcurrentRequests: 6,
    sparqlBatchSize: 50,
    requestTimeout: 10000,
};
const fetchResourceCache = {};
const requestCache = {};
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
function getUserLanguages() {
    var _a;
    if (typeof navigator !== 'undefined' && ((_a = navigator.languages) === null || _a === void 0 ? void 0 : _a.length)) {
        return Array.from(navigator.languages);
    }
    try {
        return [Intl.DateTimeFormat().resolvedOptions().locale];
    }
    catch (_b) {
        return [];
    }
}
function findInStore(store, subjectUri, predicates, userLangs = getUserLanguages()) {
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
                var _a;
                const qLang = (_a = q.object.language) === null || _a === void 0 ? void 0 : _a.toLowerCase();
                return qLang === lang.toLowerCase() || (qLang === null || qLang === void 0 ? void 0 : qLang.split('-')[0]) === base;
            });
            if (match) {
                return match.object.value;
            }
        }
        const noLang = quads.find(q => !q.object.language);
        if (noLang) {
            return noLang.object.value;
        }
        const en = quads.find(q => { var _a; return ((_a = q.object.language) === null || _a === void 0 ? void 0 : _a.toLowerCase()) === 'en'; });
        return (en !== null && en !== void 0 ? en : quads[0]).object.value;
    }
    return null;
}
function parseTurtle(text, baseIRI, contentType) {
    const store = new N3.Store();
    const format = contentType === 'text/anot+turtle' ? 'text/turtle' : contentType;
    const parser = new N3.Parser({ baseIRI, format });
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
async function parseJsonLd(text, baseIRI) {
    var _a;
    // jsonld is CommonJS: a dynamic import usually exposes it as the default export
    const imported = await import('jsonld');
    const jsonldMod = (_a = imported.default) !== null && _a !== void 0 ? _a : imported;
    if (!(jsonldMod === null || jsonldMod === void 0 ? void 0 : jsonldMod.toRDF)) {
        throw new Error('jsonld peer dependency is not available');
    }
    const doc = JSON.parse(text);
    const nquads = await jsonldMod.toRDF(doc, { format: 'application/n-quads', base: baseIRI });
    return parseTurtle(nquads, baseIRI, 'application/n-quads');
}
async function parseRdfXml(text, baseIRI) {
    const store = new N3.Store();
    return new Promise((resolve, reject) => {
        const parser = new RdfXmlParser({ baseIRI });
        parser.on('data', (quad) => store.addQuad(quad));
        parser.on('error', reject);
        parser.on('end', () => resolve(store));
        parser.write(text);
        parser.end();
    });
}
const toArray = (val) => !val ? [] : Array.isArray(val) ? val : [val];
const fetchAndParse = async (url, init, baseIRI, options, priority = false) => {
    try {
        // The slot covers reading the body, but not parsing it
        const received = await withRequestSlot(async (signal) => {
            var _a;
            const response = await fetch(url, { ...init, signal });
            if (!response.ok) {
                return null;
            }
            return {
                contentType: ((_a = response.headers.get('content-type')) === null || _a === void 0 ? void 0 : _a.split(';')[0].trim()) || 'text/turtle',
                text: await response.text(),
            };
        }, { limit: options.maxConcurrentRequests, timeout: options.requestTimeout, priority });
        if (!received) {
            return null;
        }
        const { contentType, text } = received;
        if (N3_CONTENT_TYPES.has(contentType)) {
            return await parseTurtle(text, baseIRI, contentType);
        }
        if (contentType === 'application/ld+json') {
            return await parseJsonLd(text, baseIRI);
        }
        if (contentType === 'application/rdf+xml') {
            return await parseRdfXml(text, baseIRI);
        }
    }
    catch (_a) {
    }
    return null;
};
const fetchAndParseDocument = (docUrl, options, baseIRI = docUrl) => {
    if (!(docUrl in requestCache)) {
        requestCache[docUrl] = fetchAndParse(docUrl, { headers: { 'Accept': ACCEPT_HEADER } }, baseIRI, options);
    }
    return requestCache[docUrl];
};
// When running on an https:// page, browsers block http:// requests (mixed content),
// so the https:// variant of an http:// URI is worth trying first.
const toHttpsIfMixedContent = (url) => {
    if (typeof location !== 'undefined' && location.protocol === 'https:' && url.startsWith('http://')) {
        return 'https://' + url.slice('http://'.length);
    }
    return null;
};
const findResourceInStore = async (storePromise, uri, options) => {
    const store = await storePromise;
    if (!store) {
        return null;
    }
    // The https:// document may identify its subject with either scheme
    const httpsUri = toHttpsIfMixedContent(uri);
    for (const subject of httpsUri ? [uri, httpsUri] : [uri]) {
        const label = findInStore(store, subject, options.labelPredicates);
        if (label) {
            return { uri, label, description: findInStore(store, subject, options.descriptionPredicates) };
        }
    }
    return null;
};
// Direct dereferencing and RAINBOW proxies: one request per URI (or per document)
const lookupByRequest = async (uri, options) => {
    const docUrl = uri.includes('#') ? uri.split('#')[0] : uri;
    // 1. Direct, only for HTTP(S) URIs (cached by document URL so hash siblings share one request).
    // On an https:// page, an http:// URI is tried as https:// first (the http:// request would be blocked).
    let result = null;
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
const sparqlQuery = (endpoint, options) => (query) => fetchAndParse(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/turtle, application/n-triples' },
    body: new URLSearchParams({ query }).toString(),
}, endpoint, options, true);
const actualFetchResource = async (uri, options) => {
    let result = await trackLookup(() => lookupByRequest(uri, options));
    // 3. SPARQL endpoints (in order), batching URIs into shared DESCRIBE queries
    for (const endpoint of [...toArray(options.fallbackSparqlEndpoints), ...toArray(options.fallbackSparqlEndpoint)]) {
        if (result || !isQueryableIri(uri)) {
            break;
        }
        result = await findResourceInStore(describeInBatch(endpoint, uri, options.sparqlBatchSize, sparqlQuery(endpoint, options)), uri, options);
    }
    if (!result) {
        throw new Error(`No label data found for <${uri}>`);
    }
    return result;
};
async function fetchResource(uri, options = {}) {
    const mergedOptions = { ...defaultFetchResourceOptions, ...options };
    if (!(uri in fetchResourceCache)) {
        fetchResourceCache[uri] = actualFetchResource(uri, mergedOptions);
    }
    return fetchResourceCache[uri];
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function pushContext(stack, context) {
    if (Array.isArray(context)) {
        return context.reduce(pushContext, stack);
    }
    if (context === null) {
        return [];
    }
    return typeof context === 'object' ? [...stack, context] : stack;
}
// Each @base is resolved against the previous one, starting at the document's base URL
function resolveBase(stack, baseUrl) {
    return stack.reduce((base, context) => {
        if (!has(context, '@base')) {
            return base;
        }
        const value = context['@base'];
        if (value === null) {
            return null;
        }
        try {
            return new URL(value, base !== null && base !== void 0 ? base : undefined).toString();
        }
        catch (_a) {
            return null;
        }
    }, baseUrl);
}
// Innermost value of a context entry; undefined if no context in the stack declares it
function findEntry(stack, key) {
    for (let i = stack.length - 1; i >= 0; i--) {
        if (has(stack[i], key)) {
            return stack[i][key];
        }
    }
    return undefined;
}
/** Term definition in object form; null if the term is explicitly unmapped, undefined if unknown */
function findTerm(term, stack) {
    const entry = findEntry(stack, term);
    if (typeof entry === 'string') {
        return { '@id': entry };
    }
    if (entry && typeof entry === 'object') {
        return entry['@id'] === null ? null : entry;
    }
    return entry === null ? null : undefined;
}
/** The keyword (`@id`, `@type`...) that a key stands for, either directly or through an alias */
function asKeyword(key, stack) {
    var _a;
    if (key.startsWith('@')) {
        return key;
    }
    const id = (_a = findTerm(key, stack)) === null || _a === void 0 ? void 0 : _a['@id'];
    return (id === null || id === void 0 ? void 0 : id.startsWith('@')) ? id : null;
}
function expandIri(value, stack, options, seen = new Set()) {
    var _a, _b, _c;
    if (value.startsWith('@')) {
        return value;
    }
    const expandTerm = (term) => expandIri(term, stack, { vocab: true }, seen);
    if (options.vocab && !seen.has(value)) {
        const definition = findTerm(value, stack);
        if (definition === null) {
            return null;
        }
        const id = (_a = definition === null || definition === void 0 ? void 0 : definition['@reverse']) !== null && _a !== void 0 ? _a : definition === null || definition === void 0 ? void 0 : definition['@id'];
        if (id && id !== value) {
            seen.add(value);
            return expandTerm(id);
        }
    }
    const colon = value.indexOf(':');
    if (colon > -1) {
        const prefix = value.substring(0, colon);
        const localPart = value.substring(colon + 1);
        if (prefix === '_') {
            return null;
        }
        if (!localPart.startsWith('//') && !seen.has(prefix) && findTerm(prefix, stack)) {
            const expandedPrefix = expandIri(prefix, stack, { vocab: true }, new Set(seen));
            if (expandedPrefix) {
                return `${expandedPrefix}${localPart}`;
            }
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
            return value;
        }
    }
    if (options.vocab) {
        const vocab = findEntry(stack, '@vocab');
        if (vocab) {
            const expandedVocab = vocab.includes(':') ? vocab : ((_c = (_b = findTerm(vocab, stack)) === null || _b === void 0 ? void 0 : _b['@id']) !== null && _c !== void 0 ? _c : vocab);
            return `${expandedVocab}${value}`;
        }
    }
    if (options.base) {
        const base = resolveBase(stack, options.baseUrl);
        try {
            return base ? new URL(value, base).toString() : null;
        }
        catch (_d) {
            return null;
        }
    }
    return null;
}

const defaultAugmentOptions = {
    replaceElements: true,
    ...defaultFetchResourceOptions,
};
const defaultTableOptions = {
    propertiesField: 'properties',
    maxDepth: 15,
    maxElements: 100,
};
// Never cut by maxElements, since augment() needs them (e.g. for type-scoped contexts). Contexts are
// not known when rendering, so only the usual aliases of @id and @type can be recognized.
const ALWAYS_SHOWN = new Set(['@id', '@type', 'id', 'type']);
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const plural = (count, singular, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// {"@list": [...]} and {"@set": [...]} are displayed as plain arrays
const unwrapContainer = (value) => {
    if (isObject(value)) {
        const keys = Object.keys(value);
        if (keys.length === 1 && (keys[0] === '@list' || keys[0] === '@set')) {
            return value[keys[0]];
        }
    }
    return value;
};
const appendSpan = (parent, className, text) => {
    const span = document.createElement('span');
    span.classList.add(className);
    span.textContent = text;
    parent.appendChild(span);
    return span;
};
// @context entries found in the data, kept out of the DOM for augment() to apply
const embeddedContexts = new WeakMap();
function createPropertiesTable(feature, container, options = {}) {
    const { propertiesField, maxDepth, maxElements } = { ...defaultTableOptions, ...options };
    const createLevel = (parent, rawValue, depth, addHeaders = false) => {
        const value = unwrapContainer(rawValue);
        if (isObject(value) && '@value' in value) {
            // Value object: a single literal, plus its language or datatype
            createLevel(parent, value['@value'], depth);
            for (const [keyword, className] of [['@language', 'literal-language'], ['@type', 'literal-datatype']]) {
                if (keyword in value) {
                    appendSpan(parent, className, String(value[keyword]));
                }
            }
            return;
        }
        if (value === null || typeof value !== 'object') {
            appendSpan(parent, 'literal-value', '' + value);
            return;
        }
        const isArray = Array.isArray(value);
        const entries = isArray
            ? value.map((v, i) => [String(i), v])
            : Object.entries(value).filter(([k]) => k !== '@context');
        if (isArray && !entries.length) {
            return;
        }
        if (depth > maxDepth && entries.length) {
            appendSpan(parent, 'truncated-value', isArray ? plural(entries.length, 'item') : plural(entries.length, 'property', 'properties'));
            return;
        }
        const table = document.createElement('table');
        table.classList.add(isArray ? 'array-table' : 'object-table');
        if (!isArray && '@context' in value) {
            embeddedContexts.set(table, value['@context']);
        }
        if (addHeaders && !isArray) {
            table.innerHTML = '<thead><tr><th>Property</th><th>Value</th></tr></thead>';
        }
        const tbody = document.createElement('tbody');
        const addCell = (row, ...classNames) => {
            const cell = document.createElement('td');
            cell.classList.add(...classNames);
            row.appendChild(cell);
            return cell;
        };
        let remaining = maxElements - (isArray ? 0 : entries.filter(([k]) => ALWAYS_SHOWN.has(k)).length);
        const shown = entries.filter(([k]) => (!isArray && ALWAYS_SHOWN.has(k)) || remaining-- > 0);
        for (const [k, v] of shown) {
            const row = document.createElement('tr');
            if (isArray) {
                createLevel(addCell(row, 'array-value', 'array-entry'), v, depth + 1);
            }
            else {
                const keyCell = addCell(row, 'object-property');
                keyCell.setAttribute('data-property', k);
                keyCell.textContent = k;
                createLevel(addCell(row, 'object-value'), v, depth + 1);
            }
            tbody.appendChild(row);
        }
        const hidden = entries.length - shown.length;
        if (hidden) {
            const row = document.createElement('tr');
            const cell = addCell(row, isArray ? 'array-value' : 'truncated-cell');
            if (!isArray) {
                cell.colSpan = 2;
            }
            appendSpan(cell, 'truncated-value', isArray
                ? plural(hidden, 'more item')
                : plural(hidden, 'more property', 'more properties'));
            tbody.appendChild(row);
        }
        table.appendChild(tbody);
        parent.appendChild(table);
    };
    const wrapper = document.createElement('div');
    wrapper.classList.add('object-properties');
    container.appendChild(wrapper);
    createLevel(wrapper, propertiesField ? feature[propertiesField] : feature, 1, true);
}
async function augment(rootElem, context, options = {}) {
    const mergedOptions = { ...defaultAugmentOptions, ...options };
    const { baseUrl } = mergedOptions;
    // Outermost object tables below an element (looking through arrays and wrappers)
    const findTables = (elem) => Array.from(elem.children).flatMap(child => child.classList.contains('object-table') ? [child] : findTables(child));
    // Literal values of a cell, not including those that belong to nested objects
    const findLiterals = (elem) => Array.from(elem.children).flatMap(child => {
        if (child.classList.contains('literal-value')) {
            return [child];
        }
        return child.classList.contains('object-table') ? [] : findLiterals(child);
    });
    const updateElement = (elem, resourceUri, replaceElements = true) => {
        elem.setAttribute('data-uri', resourceUri);
        elem.classList.add('resource-loading');
        fetchResource(resourceUri, mergedOptions)
            .then(resourceData => {
            let elemToUpdate = elem.querySelector('.resource-link') || elem;
            if (resourceData.label) {
                elem.setAttribute('data-label', resourceData.label);
                if (mergedOptions.replaceElements) {
                    elemToUpdate.textContent = resourceData.label;
                }
            }
            if (resourceData.description) {
                elem.setAttribute('data-description', resourceData.description);
                if (mergedOptions.replaceElements) {
                    elemToUpdate.title = resourceData.description;
                }
            }
            elem.classList.add('resource-resolved');
        })
            .catch(e => {
            console.error(`Error resolving URI ${resourceUri}: ${e}`, { cause: e });
            elem.classList.add('resource-error');
        })
            .finally(() => {
            elem.classList.remove('resource-loading');
        });
        if (replaceElements) {
            const link = document.createElement("a");
            link.href = resourceUri;
            link.target = '_blank';
            link.classList.add('resource-link');
            while (elem.firstChild) {
                link.appendChild(elem.firstChild);
            }
            elem.appendChild(link);
        }
    };
    const linkLiterals = (valueElem, stack, expandOptions) => {
        for (const literalElem of findLiterals(valueElem)) {
            const iri = expandIri(literalElem.textContent.trim(), stack, { ...expandOptions, baseUrl });
            if (iri && !iri.startsWith('@')) {
                updateElement(literalElem, iri, mergedOptions.replaceElements);
            }
        }
    };
    // The stack with the object's own context on top, if it has a loadable one
    const pushEmbedded = async (stack, context) => {
        try {
            // Loading modifies the context, which belongs to the caller's data
            const copy = JSON.parse(JSON.stringify(context));
            const entries = await loadContextEntries(copy, { baseUrl, requestTimeout: mergedOptions.requestTimeout });
            return entries.reduce(pushContext, stack);
        }
        catch (e) {
            console.warn(`Error loading embedded context: ${e}`, { cause: e });
            return stack;
        }
    };
    const augmentNode = async (table, inheritedStack) => {
        const embedded = embeddedContexts.get(table);
        // Only wait when there is something to load
        const stack = embedded === undefined ? inheritedStack : await pushEmbedded(inheritedStack, embedded);
        const children = [];
        const rows = Array.from(table.querySelectorAll(':scope > tbody > tr')).flatMap(row => {
            const propElem = row.querySelector(':scope > .object-property');
            if (!propElem) {
                return [];
            }
            return [{
                    propElem,
                    valueElem: row.querySelector(':scope > .object-value'),
                    name: propElem.getAttribute('data-property') || propElem.textContent.trim(),
                }];
        });
        // Type-scoped contexts apply to this node only, in lexicographical order of the types
        const types = rows
            .filter(({ name }) => asKeyword(name, stack) === '@type')
            .flatMap(({ valueElem }) => valueElem ? findLiterals(valueElem) : [])
            .map(elem => elem.textContent.trim())
            .sort();
        const nodeStack = types.reduce((result, type) => {
            var _a;
            const scoped = (_a = findTerm(type, stack)) === null || _a === void 0 ? void 0 : _a['@context'];
            return scoped === undefined ? result : pushContext(result, scoped);
        }, stack);
        for (const { propElem, valueElem, name } of rows) {
            const keyword = asKeyword(name, nodeStack);
            let childStack = stack;
            if (keyword === '@type') {
                // Types are resolved before applying their scoped contexts
                if (valueElem) {
                    linkLiterals(valueElem, stack, { vocab: true, base: true });
                }
                updateElement(propElem, RDF_TYPE, mergedOptions.replaceElements);
            }
            else if (keyword === '@id') {
                if (valueElem) {
                    linkLiterals(valueElem, nodeStack, { base: true });
                }
            }
            else if (keyword) {
                // Other keywords (@graph, @reverse, @nest...) keep the current context
                childStack = nodeStack;
            }
            else {
                const definition = findTerm(name, nodeStack);
                const propertyUri = expandIri(name, nodeStack, { vocab: true });
                if (propertyUri) {
                    updateElement(propElem, propertyUri, mergedOptions.replaceElements);
                }
                if ((definition === null || definition === void 0 ? void 0 : definition['@context']) !== undefined) {
                    childStack = pushContext(stack, definition['@context']);
                }
                const coercion = definition === null || definition === void 0 ? void 0 : definition['@type'];
                if (valueElem && (coercion === '@id' || coercion === '@vocab')) {
                    const valueStack = (definition === null || definition === void 0 ? void 0 : definition['@context']) === undefined
                        ? nodeStack : pushContext(nodeStack, definition['@context']);
                    linkLiterals(valueElem, valueStack, { vocab: coercion === '@vocab', base: true });
                }
            }
            if (valueElem) {
                children.push(...findTables(valueElem).map(child => augmentNode(child, childStack)));
            }
        }
        await Promise.all(children);
    };
    const rootStack = pushContext([], context !== null && context !== void 0 ? context : {});
    const rootTables = rootElem.classList.contains('object-table')
        ? [rootElem] : findTables(rootElem);
    await Promise.all(rootTables.map(table => augmentNode(table, rootStack)));
}

const WGS84_EPSG_CODES = new Set([4326, 4979]);
const proj4DefCache = new Map();
function extractEpsgCode(uri) {
    // http(s)://www.opengis.net/def/crs/EPSG/0/5514
    let m = uri.match(/\/crs\/EPSG\/[^/]+\/(\d+)$/i);
    if (m)
        return parseInt(m[1], 10);
    // urn:ogc:def:crs:EPSG::5514
    m = uri.match(/urn:ogc:def:crs:EPSG::(\d+)$/i);
    if (m)
        return parseInt(m[1], 10);
    // EPSG:5514
    m = uri.match(/^EPSG:(\d+)$/);
    if (m)
        return parseInt(m[1], 10);
    return null;
}
function isWgs84(uri) {
    const code = extractEpsgCode(uri);
    if (code !== null)
        return WGS84_EPSG_CODES.has(code);
    return /\/OGC\/[^/]+\/CRS84h?$/i.test(uri) || /urn:ogc:def:crs:OGC:[^:]*:CRS84h?$/i.test(uri);
}
function parseSingleCrs(value) {
    if (typeof value === 'string') {
        if (isWgs84(value))
            return null;
        const code = extractEpsgCode(value);
        return code !== null ? { epsgCode: code } : null;
    }
    if (value !== null && typeof value === 'object') {
        const obj = value;
        if (obj['type'] === 'Reference' && typeof obj['href'] === 'string') {
            if (isWgs84(obj['href']))
                return null;
            const code = extractEpsgCode(obj['href']);
            if (code === null)
                return null;
            return {
                epsgCode: code,
                epoch: typeof obj['epoch'] === 'number' ? obj['epoch'] : undefined,
            };
        }
    }
    return null;
}
function parseCoordRefSys(coordRefSys) {
    if (Array.isArray(coordRefSys)) {
        for (const item of coordRefSys) {
            const result = parseSingleCrs(item);
            if (result !== null)
                return result;
        }
        return null;
    }
    return parseSingleCrs(coordRefSys);
}
function parseLegacyCrs(crs) {
    if (!crs || typeof crs !== 'object')
        return null;
    const obj = crs;
    if (obj['type'] !== 'name')
        return null;
    const props = obj['properties'];
    if (!props || typeof props !== 'object')
        return null;
    const name = props['name'];
    if (typeof name !== 'string')
        return null;
    if (isWgs84(name))
        return null;
    const code = extractEpsgCode(name);
    return code !== null ? { epsgCode: code } : null;
}
/**
 * Detects the CRS from a GeoJSON/JSON-FG object.
 *
 * Checks in priority order:
 *   1. JSON-FG `coordRefSys` (URI string, Reference object, or compound array)
 *   2. Legacy GeoJSON `crs` with type "name"
 *
 * Returns null if the CRS is WGS84 or cannot be determined (no transform needed).
 */
function detectCrs(data) {
    if (!data || typeof data !== 'object')
        return null;
    const obj = data;
    if ('coordRefSys' in obj) {
        const result = parseCoordRefSys(obj['coordRefSys']);
        if (result !== null)
            return result;
    }
    if ('crs' in obj) {
        const result = parseLegacyCrs(obj['crs']);
        if (result !== null)
            return result;
    }
    return null;
}
/**
 * Returns a proj4 converter from the given EPSG CRS to WGS84.
 * Fetches the projection definition from epsg.io if not already registered.
 */
async function getProjectionConverter(crsInfo, proj4Instance) {
    const key = `EPSG:${crsInfo.epsgCode}`;
    if (crsInfo.epoch !== undefined) {
        console.warn(`CRS epoch ${crsInfo.epoch} ignored — proj4js does not support coordinate epochs.`);
    }
    if (!proj4Instance.defs(key)) {
        let defStr = proj4DefCache.get(crsInfo.epsgCode);
        if (!defStr) {
            const response = await fetch(`https://epsg.io/${crsInfo.epsgCode}.proj4`);
            if (!response.ok) {
                throw new Error(`Unknown CRS EPSG:${crsInfo.epsgCode} — could not retrieve a definition from epsg.io (HTTP ${response.status})`);
            }
            defStr = (await response.text()).trim();
            if (!defStr) {
                throw new Error(`Unknown CRS EPSG:${crsInfo.epsgCode} — epsg.io returned an empty definition`);
            }
            proj4DefCache.set(crsInfo.epsgCode, defStr);
        }
        proj4Instance.defs(key, defStr);
    }
    return proj4Instance(key, 'WGS84');
}
function transformCoords(coords, converter) {
    const projected = converter.forward(coords.slice(0, 2));
    return coords.length > 2 ? [projected[0], projected[1], coords[2]] : [projected[0], projected[1]];
}
function transformGeometry(geometry, converter) {
    if (!geometry)
        return geometry;
    switch (geometry.type) {
        case 'Point':
            return { ...geometry, coordinates: transformCoords(geometry.coordinates, converter) };
        case 'MultiPoint':
        case 'LineString':
            return {
                ...geometry,
                coordinates: geometry.coordinates.map((c) => transformCoords(c, converter)),
            };
        case 'MultiLineString':
        case 'Polygon':
            return {
                ...geometry,
                coordinates: geometry.coordinates.map((r) => r.map((c) => transformCoords(c, converter))),
            };
        case 'MultiPolygon':
            return {
                ...geometry,
                coordinates: geometry.coordinates.map((p) => p.map((r) => r.map((c) => transformCoords(c, converter)))),
            };
        case 'GeometryCollection':
            return {
                ...geometry,
                geometries: geometry.geometries.map((g) => transformGeometry(g, converter)),
            };
        default:
            return geometry;
    }
}
/**
 * Deep-clones and transforms all geometries in a FeatureCollection or Feature
 * from the given CRS to WGS84. Per the JSON-FG scoping rules, individual features
 * may carry their own `coordRefSys` that overrides the collection-level one.
 */
async function transformFeatureCollection(data, collectionCrs, proj4Instance) {
    var _a;
    const collectionConverter = await getProjectionConverter(collectionCrs, proj4Instance);
    const transformFeature = async (feature) => {
        const featureCrs = detectCrs(feature);
        let converter = collectionConverter;
        if (featureCrs !== null && featureCrs.epsgCode !== collectionCrs.epsgCode) {
            converter = await getProjectionConverter(featureCrs, proj4Instance);
        }
        return { ...feature, geometry: transformGeometry(feature.geometry, converter) };
    };
    if (data.type === 'FeatureCollection') {
        return { ...data, features: await Promise.all(((_a = data.features) !== null && _a !== void 0 ? _a : []).map(transformFeature)) };
    }
    if (data.type === 'Feature') {
        return transformFeature(data);
    }
    return data;
}

const POPUP_CLASS = 'jsonld-ui-popup';
// Leaflet sets inline width/max-width/max-height on the popup content element, hence !important
// so that the user-resized inline size wins over those caps.
const POPUP_CSS = `
.${POPUP_CLASS} .leaflet-popup-content {
  overflow: auto;
  resize: both;
  box-sizing: border-box;
  min-width: 150px;
  min-height: 60px;
  max-width: var(--jsonld-popup-max-width, 90vw) !important;
  max-height: var(--jsonld-popup-max-height, 80vh) !important;
}
/* Keep cells readable: property names (often links once resolved) never wrap. Width limits apply
   to leaf text only, never to cells that hold nested tables (those must be free to grow, or the
   nested table overflows its cell). Selectors are deliberately specific to win over host page
   styles for the same classes (e.g. max-width / word-break: break-all on .object-value). */
.${POPUP_CLASS} .leaflet-popup-content .object-property {
  white-space: nowrap;
  word-break: normal;
  overflow-wrap: normal;
}
.${POPUP_CLASS} .leaflet-popup-content .object-value,
.${POPUP_CLASS} .leaflet-popup-content .array-value {
  min-width: 0;
  max-width: none;
  word-break: normal;
  overflow-wrap: normal;
}
.${POPUP_CLASS} .leaflet-popup-content .literal-value {
  display: inline-block;
  vertical-align: top;
  min-width: 10em;
  max-width: 30em;
  overflow-wrap: anywhere;
}
/* Let the popup content be the single scroll container (otherwise the table's own
   horizontal scrollbar ends up at the very bottom of a tall popup). */
.${POPUP_CLASS} .object-properties {
  overflow: visible;
  width: 100%;
}
`;
let popupCssInjected = false;
function injectPopupCss() {
    if (popupCssInjected || typeof document === 'undefined') {
        return;
    }
    popupCssInjected = true;
    const style = document.createElement('style');
    style.setAttribute('data-jsonld-ui-utils', 'popup');
    style.textContent = POPUP_CSS;
    document.head.appendChild(style);
}
// Keeps the popup centered over its anchor (and its tip aligned) when the user drags the resize
// handle: Leaflet only computes the container offset when the popup is (re)laid out.
// Uses private Leaflet 1.x fields, hence the defensive guards.
function recenterOnResize(popup) {
    if (typeof ResizeObserver === 'undefined') {
        return;
    }
    let observer = null;
    popup.on('add', () => {
        var _a, _b;
        const content = popup._contentNode;
        if (!content) {
            return;
        }
        // A drag that starts inside the popup (resize handle, text selection) but is released outside
        // makes the browser dispatch a `click` on the map, which would close the popup. Swallow it.
        content.addEventListener('mousedown', () => {
            const swallowClick = (e) => {
                var _a;
                if (!((_a = popup._container) === null || _a === void 0 ? void 0 : _a.contains(e.target))) {
                    e.stopPropagation();
                }
            };
            document.addEventListener('click', swallowClick, true);
            document.addEventListener('mouseup', () => {
                setTimeout(() => document.removeEventListener('click', swallowClick, true), 0);
            }, { once: true, capture: true });
        });
        // Cap the popup to the map's own size (e.g. a small inline map): at most 60% of its width and 70% of its height, and
        // never more than what is left after the popup chrome, tip and marker offset.
        const map = popup._map;
        const updateMaxSize = () => {
            var _a;
            const size = (_a = map === null || map === void 0 ? void 0 : map.getSize) === null || _a === void 0 ? void 0 : _a.call(map);
            if (size && popup._container) {
                popup._container.style.setProperty('--jsonld-popup-max-width', `${Math.max(150, Math.min(size.x * 0.6, size.x - 60))}px`);
                popup._container.style.setProperty('--jsonld-popup-max-height', `${Math.max(100, Math.min(size.y * 0.7, size.y - 110))}px`);
            }
        };
        updateMaxSize();
        // Leaflet already measured the popup (and autopanned) before the caps existed: lay it out again.
        popup.update();
        map === null || map === void 0 ? void 0 : map.on('resize', updateMaxSize);
        popup.once('remove', () => map === null || map === void 0 ? void 0 : map.off('resize', updateMaxSize));
        // Labels resolved asynchronously change the table's natural width after Leaflet sized the
        // popup: re-layout, unless the user already sized it by hand (which sets an inline height).
        const table = (_a = popup.getContent()) === null || _a === void 0 ? void 0 : _a.firstElementChild;
        let lastTableWidth = (_b = table === null || table === void 0 ? void 0 : table.offsetWidth) !== null && _b !== void 0 ? _b : 0;
        let relayoutQueued = false;
        const tableObserver = table ? new ResizeObserver(() => {
            if (relayoutQueued || Math.abs(table.offsetWidth - lastTableWidth) < 2) {
                return;
            }
            lastTableWidth = table.offsetWidth;
            relayoutQueued = true;
            requestAnimationFrame(() => {
                relayoutQueued = false;
                if (popup._container && !content.style.height) {
                    popup.update();
                    lastTableWidth = table.offsetWidth;
                }
            });
        }) : null;
        if (table && tableObserver) {
            tableObserver.observe(table);
            popup.once('remove', () => tableObserver.disconnect());
        }
        observer = new ResizeObserver(() => {
            if (popup._container && typeof popup._updatePosition === 'function') {
                popup._containerWidth = popup._container.offsetWidth;
                popup._updatePosition();
            }
        });
        observer.observe(content);
    });
    popup.on('remove', () => {
        observer === null || observer === void 0 ? void 0 : observer.disconnect();
        observer = null;
    });
}
async function createJsonLDGeoJSONLayer(L, data, options = {}) {
    const { ldContext, popupOptions = {}, augmentOptions = {}, baseUrl, maxDepth, maxElements, onEachFeature: userOnEachFeature, coordRefSys: coordRefSysOverride, proj4: proj4Override, crsAttribution = true, ...geoJSONOptions } = options;
    let geoData = data;
    const crsInfo = coordRefSysOverride
        ? detectCrs({ coordRefSys: coordRefSysOverride })
        : detectCrs(data);
    if (crsInfo !== null) {
        const proj4Instance = proj4Override !== null && proj4Override !== void 0 ? proj4Override : proj4Lib;
        if (!proj4Instance) {
            throw new Error('proj4js is required for CRS transformation — include it via <script src="..."> or install it as a dependency');
        }
        geoData = await transformFeatureCollection(data, crsInfo, proj4Instance);
    }
    const crsAttributionText = crsAttribution && crsInfo !== null
        ? `Original CRS: EPSG:${crsInfo.epsgCode}`
        : null;
    const mergedAttribution = [geoJSONOptions.attribution, crsAttributionText]
        .filter(Boolean)
        .join(' | ') || undefined;
    return L.geoJSON(geoData, {
        ...geoJSONOptions,
        ...(mergedAttribution !== undefined ? { attribution: mergedAttribution } : {}),
        onEachFeature(feature, layer) {
            if (userOnEachFeature)
                userOnEachFeature(feature, layer);
            if (feature.id != null) {
                layer.bindTooltip(String(feature.id), { permanent: false });
            }
            if (!feature.properties || Object.keys(feature.properties).length === 0)
                return;
            const container = document.createElement('div');
            createPropertiesTable(feature, container, {
                ...(maxDepth !== undefined ? { maxDepth } : {}),
                ...(maxElements !== undefined ? { maxElements } : {}),
            });
            injectPopupCss();
            const className = [POPUP_CLASS, popupOptions.className].filter(Boolean).join(' ');
            // Large default maxWidth: the popup adapts to the table's natural width; the CSS cap (a share
            // of the map size, see recenterOnResize) is what actually bounds it.
            layer.bindPopup(container, { maxWidth: 10000, ...popupOptions, className });
            recenterOnResize(layer.getPopup());
            const dataContext = data != null && typeof data === 'object' && '@context' in data
                ? data['@context']
                : null;
            const contextsToMerge = [dataContext, ldContext].filter(v => v != null);
            if (contextsToMerge.length > 0) {
                const contextArg = contextsToMerge.length === 1 ? contextsToMerge[0] : contextsToMerge;
                loadContext(contextArg, { baseUrl }).then((resolvedContext) => {
                    augment(container, resolvedContext, { baseUrl, ...augmentOptions });
                });
            }
        },
    });
}

export { createJsonLDGeoJSONLayer };
//# sourceMappingURL=leaflet.esm.js.map
