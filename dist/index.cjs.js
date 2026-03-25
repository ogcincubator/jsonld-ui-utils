'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var N3 = require('n3');
var rdfxmlStreamingParser = require('rdfxml-streaming-parser');

function _interopNamespaceDefault(e) {
    var n = Object.create(null);
    if (e) {
        Object.keys(e).forEach(function (k) {
            if (k !== 'default') {
                var d = Object.getOwnPropertyDescriptor(e, k);
                Object.defineProperty(n, k, d.get ? d : {
                    enumerable: true,
                    get: function () { return e[k]; }
                });
            }
        });
    }
    n.default = e;
    return Object.freeze(n);
}

var N3__namespace = /*#__PURE__*/_interopNamespaceDefault(N3);

const jsonFetch = async (url) => {
    const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
    });
    return await response.json();
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
async function loadContext(context) {
    const loadedUrls = new Map();
    const walk = async (definition, refChain) => {
        for (const [key, value] of Object.entries(definition)) {
            if (key === '@context') {
                // @ts-ignore
                definition[key] = await load(value, refChain);
            }
            else if (typeof value === 'object' && value !== null) {
                await walk(value, refChain);
            }
        }
    };
    const load = async (context, refChain) => {
        if (context === null || typeof context === 'undefined') {
            return {};
        }
        if (Array.isArray(context)) {
            // fetch and merge
            const contextEntries = await Promise.all(context.map(e => load(e, refChain)));
            return mergeContexts(contextEntries);
        }
        else if (typeof context === 'object') {
            await walk(context, refChain);
            return context;
        }
        else {
            if (refChain === null || refChain === void 0 ? void 0 : refChain.includes(context)) {
                throw new Error('Circular dependencies found: ' + refChain.join(' -> ') + ' -> ' + context);
            }
            const newRefChain = Array.isArray(refChain) ? refChain === null || refChain === void 0 ? void 0 : refChain.slice() : [];
            newRefChain.push(context);
            let newContext;
            if (!loadedUrls.has(context)) {
                newContext = await jsonFetch(context);
                loadedUrls.set(context, newContext);
            }
            else {
                newContext = loadedUrls.get(context);
            }
            return load(newContext['@context'], newRefChain);
        }
    };
    if (typeof context === 'object' && context !== null && '@context' in context) {
        return load(context['@context']);
    }
    else {
        return load(context);
    }
}

var jsonld = /*#__PURE__*/Object.freeze({
    __proto__: null,
    loadContext: loadContext
});

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

const defaultFetchResourceOptions = {
    labelPredicates,
    descriptionPredicates,
};
const fetchResourceCache = {};
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
function findInStore(store, subjectUri, predicates) {
    var _a;
    const subj = N3__namespace.DataFactory.namedNode(subjectUri);
    for (const predUri of predicates) {
        const quads = store
            .getQuads(subj, N3__namespace.DataFactory.namedNode(predUri), null, null)
            .filter(q => q.object.termType === 'Literal');
        if (!quads.length)
            continue;
        const en = quads.find(q => q.object.language === 'en');
        const noLang = quads.find(q => !q.object.language);
        return ((_a = en !== null && en !== void 0 ? en : noLang) !== null && _a !== void 0 ? _a : quads[0]).object.value;
    }
    return null;
}
function parseTurtle(text, baseIRI, contentType) {
    const store = new N3__namespace.Store();
    const format = contentType === 'text/anot+turtle' ? 'text/turtle' : contentType;
    const parser = new N3__namespace.Parser({ baseIRI, format });
    return new Promise((resolve, reject) => {
        parser.parse(text, (err, quad) => {
            if (err)
                return reject(err);
            if (quad)
                store.addQuad(quad);
            else
                resolve(store);
        });
    });
}
async function parseJsonLd(text, baseIRI) {
    const jsonldMod = await import('jsonld');
    if (!jsonldMod)
        throw new Error('jsonld peer dependency is not available');
    const doc = JSON.parse(text);
    const nquads = await jsonldMod.toRDF(doc, { format: 'application/n-quads', base: baseIRI });
    return parseTurtle(nquads, baseIRI, 'application/n-quads');
}
async function parseRdfXml(text, baseIRI) {
    const store = new N3__namespace.Store();
    return new Promise((resolve, reject) => {
        const parser = new rdfxmlStreamingParser.RdfXmlParser({ baseIRI });
        parser.on('data', (quad) => store.addQuad(quad));
        parser.on('error', reject);
        parser.on('end', () => resolve(store));
        parser.write(text);
        parser.end();
    });
}
const toArray = (val) => !val ? [] : Array.isArray(val) ? val : [val];
const getSparqlQuery = (uri) => `DESCRIBE <${uri}>`;
const tryFetchAndParse = async (fetchFn, uri, options) => {
    var _a;
    let response;
    try {
        response = await fetchFn();
        if (!response.ok)
            return null;
    }
    catch (_b) {
        return null;
    }
    const contentType = ((_a = response.headers.get('content-type')) === null || _a === void 0 ? void 0 : _a.split(';')[0].trim()) || 'text/turtle';
    const text = await response.text();
    let store;
    try {
        if (N3_CONTENT_TYPES.has(contentType)) {
            store = await parseTurtle(text, uri, contentType);
        }
        else if (contentType === 'application/ld+json') {
            store = await parseJsonLd(text, uri);
        }
        else if (contentType === 'application/rdf+xml') {
            store = await parseRdfXml(text, uri);
        }
        else {
            return null;
        }
    }
    catch (_c) {
        return null;
    }
    const label = findInStore(store, uri, options.labelPredicates);
    if (!label)
        return null;
    return {
        uri,
        label,
        description: findInStore(store, uri, options.descriptionPredicates),
    };
};
const actualFetchResource = async (uri, options) => {
    // 1. Direct
    let result = await tryFetchAndParse(() => fetch(uri, { headers: { 'Accept': ACCEPT_HEADER } }), uri, options);
    // 2. Rainbow proxies (in order)
    for (const instance of [...toArray(options.fallbackRainbowInstances), ...toArray(options.fallbackRainbowInstance)]) {
        if (result)
            break;
        const rainbowURL = new URL(instance);
        rainbowURL.searchParams.set('uri', uri);
        result = await tryFetchAndParse(() => fetch(rainbowURL.toString(), { headers: { 'Accept': ACCEPT_HEADER } }), uri, options);
    }
    // 3. SPARQL endpoints (in order)
    for (const endpoint of [...toArray(options.fallbackSparqlEndpoints), ...toArray(options.fallbackSparqlEndpoint)]) {
        if (result)
            break;
        const formBody = new URLSearchParams({ query: getSparqlQuery(uri) });
        result = await tryFetchAndParse(() => fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/turtle, application/n-triples' },
            body: formBody.toString(),
        }), uri, options);
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
async function loadFeature(url) {
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

var resource = /*#__PURE__*/Object.freeze({
    __proto__: null,
    defaultFetchResourceOptions: defaultFetchResourceOptions,
    fetchResource: fetchResource,
    loadFeature: loadFeature
});

const defaultAugmentOptions = {
    replaceElements: true,
    ...defaultFetchResourceOptions,
};
function createPropertiesTable(feature, container, options = {
    propertiesField: 'properties',
}) {
    const createLevel = (parent, value, addHeaders = false) => {
        if (Array.isArray(value)) {
            for (const entry of value) {
                const newElem = createLevel(parent, entry);
                newElem.classList.add('array-entry');
            }
            return parent;
        }
        else if (value === null || typeof value === 'undefined' || typeof value !== 'object') {
            const span = document.createElement('span');
            span.classList.add('literal-value');
            span.textContent = '' + value;
            parent.appendChild(span);
            return span;
        }
        else {
            const table = document.createElement('table');
            table.classList.add('object-table');
            if (addHeaders) {
                table.innerHTML = '<thead><tr><th>Property</th><th>Value</th></tr></thead>';
            }
            const tbody = document.createElement('tbody');
            Object.entries(value).forEach(([k, v]) => {
                const row = document.createElement('tr');
                const keyCell = document.createElement('td');
                keyCell.classList.add('object-property');
                keyCell.setAttribute('data-property', k);
                keyCell.textContent = k;
                row.appendChild(keyCell);
                const valueCell = document.createElement('td');
                valueCell.classList.add('object-value');
                createLevel(valueCell, v);
                row.appendChild(valueCell);
                tbody.appendChild(row);
            });
            table.appendChild(tbody);
            parent.appendChild(table);
            return table;
        }
    };
    const wrapper = document.createElement('div');
    wrapper.classList.add('object-properties');
    container.appendChild(wrapper);
    if (options.propertiesField) {
        createLevel(wrapper, feature[options.propertiesField], true);
    }
    else {
        createLevel(wrapper, feature, true);
    }
}
async function augment(rootElem, context, options = {}) {
    const mergedOptions = { ...defaultAugmentOptions, ...options };
    const resolveTerm = (term, contextStack, useVocab = true, useBase = false) => {
        if (term.indexOf('://') !== -1) {
            return { '@id': term };
        }
        let closestVocab = null;
        let closestBase = null;
        for (let i = contextStack.length - 1; i >= 0; i--) {
            if (term in contextStack[i]) {
                let resolvedTerm = contextStack[i][term];
                let resolvedId;
                if (resolvedTerm === null || typeof resolvedTerm === 'undefined' || typeof resolvedTerm === 'boolean'
                    || Array.isArray(resolvedTerm)) {
                    continue;
                }
                if (typeof resolvedTerm === 'string') {
                    if (resolvedTerm === '@type') {
                        return { '@id': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' };
                    }
                    resolvedId = resolvedTerm;
                    resolvedTerm = { '@id': resolvedTerm };
                }
                else if (typeof resolvedTerm === 'object' && '@id' in resolvedTerm && typeof resolvedTerm['@id'] === 'string') {
                    resolvedId = resolvedTerm['@id'];
                }
                else {
                    continue;
                }
                const idx = resolvedId.indexOf(':');
                if (idx > -1) {
                    const prefix = resolvedId.substring(0, idx);
                    const localPart = resolvedId.substring(idx + 1);
                    if (localPart.startsWith('//')) {
                        // Full URI -> return
                        return resolvedTerm;
                    }
                    const resolvedPrefix = resolveTerm(prefix, contextStack);
                    if (resolvedPrefix !== null && '@id' in resolvedPrefix && typeof resolvedPrefix['@id'] === 'string') {
                        // Prefix found and resolved
                        resolvedTerm['@id'] = `${resolvedPrefix['@id']}${localPart}`;
                    }
                    return resolvedTerm;
                }
            }
            if (closestVocab === null && contextStack[i]['@vocab']) {
                closestVocab = contextStack[i]['@vocab'];
            }
            if (closestBase === null && contextStack[i]['@base']) {
                closestBase = contextStack[i]['@base'];
            }
        }
        if (term.indexOf(':') === -1) {
            if (useVocab && closestVocab) {
                return { '@id': `${closestVocab}${term}` };
            }
            if (useBase && closestBase) {
                return { '@id': `${closestBase}${term}` };
            }
        }
        return null;
    };
    const findPropertyChildren = (elem) => {
        const walker = document.createTreeWalker(elem, NodeFilter.SHOW_ELEMENT, {
            acceptNode(node) {
                const nodeElem = node;
                if (node !== elem && nodeElem.classList.contains('object-value')) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (nodeElem.classList.contains('object-property')) {
                    return NodeFilter.FILTER_ACCEPT;
                }
                return NodeFilter.FILTER_SKIP;
            },
        });
        const result = [];
        let cur;
        while ((cur = walker.nextNode())) {
            result.push(cur);
        }
        return result;
    };
    const findLiteralChildren = (elem) => {
        const result = [];
        const walker = document.createTreeWalker(elem, NodeFilter.SHOW_ELEMENT, {
            acceptNode(node) {
                const nodeElem = node;
                if (nodeElem.classList.contains('object-property') || nodeElem.classList.contains('object-value')) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (nodeElem.classList.contains('literal-value')) {
                    result.push(nodeElem);
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_SKIP;
            },
        });
        while (walker.nextNode()) {
        }
        return result;
    };
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
    const augmentInner = (elem, contextStack) => {
        var _a;
        const propElems = findPropertyChildren(elem);
        for (const propElem of propElems) {
            let propertyName = null;
            propertyName = propElem.getAttribute('data-property');
            if (!propertyName) {
                propertyName = propElem.textContent.trim();
            }
            const resolvedProperty = resolveTerm(propertyName, contextStack);
            let newContextStack = contextStack;
            const valueElem = (_a = propElem.parentElement) === null || _a === void 0 ? void 0 : _a.querySelector('.object-value');
            if (resolvedProperty && '@id' in resolvedProperty && typeof resolvedProperty['@id'] === 'string') {
                const propertyUri = resolvedProperty['@id'];
                updateElement(propElem, propertyUri, mergedOptions.replaceElements);
                if ('@context' in resolvedProperty) {
                    newContextStack = [...contextStack, resolvedProperty['@context']];
                }
                if (resolvedProperty['@type'] === '@id' && valueElem) {
                    const literalElems = findLiteralChildren(valueElem);
                    literalElems.forEach(literalElem => {
                        const resolvedLiteral = resolveTerm(literalElem.textContent.trim(), newContextStack, false, true);
                        if (resolvedLiteral && '@id' in resolvedLiteral && typeof resolvedLiteral['@id'] === 'string') {
                            const resourceUri = resolvedLiteral['@id'];
                            updateElement(literalElem, resourceUri, mergedOptions.replaceElements);
                        }
                    });
                }
            }
            if (valueElem) {
                augmentInner(valueElem, newContextStack);
            }
        }
    };
    augmentInner(rootElem, [context]);
}

var augment$1 = /*#__PURE__*/Object.freeze({
    __proto__: null,
    augment: augment,
    createPropertiesTable: createPropertiesTable
});

var index = {
    ...resource,
    ...jsonld,
    ...augment$1,
};

exports.augment = augment;
exports.createPropertiesTable = createPropertiesTable;
exports.default = index;
exports.defaultFetchResourceOptions = defaultFetchResourceOptions;
exports.fetchResource = fetchResource;
exports.loadContext = loadContext;
exports.loadFeature = loadFeature;
//# sourceMappingURL=index.cjs.js.map
