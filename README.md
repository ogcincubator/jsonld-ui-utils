# jsonld-ui-utils

A JavaScript/TypeScript library that renders JSON-LD feature data as interactive HTML tables and enriches them with semantic metadata (labels, descriptions) fetched from RDF sources.

## Features

- Render JSON-LD objects as nested HTML tables
- Resolve property names and values to their full URIs using JSON-LD contexts
- Fetch RDF metadata (labels, descriptions) for resolved URIs
- Multiple fallback mechanisms: direct fetch, [RAINBOW](https://github.com/ogcincubator/rainbow) proxy, SPARQL endpoint
- Built-in caching to avoid redundant network requests

## Installation

This package is not published to npm. Install the latest release directly from GitHub:

```bash
npm install https://github.com/avillar/jsonld-ui-utils/releases/latest/download/jsonld-ui-utils.tgz
# or
yarn add https://github.com/avillar/jsonld-ui-utils/releases/latest/download/jsonld-ui-utils.tgz
```

To pin to a specific version, replace `latest/download` with `download/v0.1.6`:

```bash
npm install https://github.com/avillar/jsonld-ui-utils/releases/download/v0.1.6/jsonld-ui-utils.tgz
```

> **Note:** [`rdflib`](https://www.npmjs.com/package/rdflib) is a peer dependency and must be installed separately:
> ```bash
> npm install rdflib
> ```

### Browser (CDN)

```html
<script src="https://cdn.jsdelivr.net/npm/rdflib@2.3.0/dist/rdflib.min.js"></script>
<script src="https://github.com/avillar/jsonld-ui-utils/releases/latest/download/jsonld-ui-utils.min.js"></script>
```

This exposes `jsonldUIUtils` as a global variable.

## Usage

### Quick start

```javascript
import jsonldUIUtils from 'jsonld-ui-utils';

const { feature, context } = await jsonldUIUtils.loadFeature(
  'https://example.org/features/my-feature.json'
);

const container = document.getElementById('feature');
jsonldUIUtils.createPropertiesTable(feature, container);
await jsonldUIUtils.augment(container, context);
```

### Step by step

#### 1. Load a JSON-LD feature

```javascript
const { feature, context } = await jsonldUIUtils.loadFeature(featureUrl);
```

`loadFeature` fetches the document at `featureUrl`, extracts its `@context`, recursively loads and merges any referenced context URLs, and returns both the raw feature object and the resolved context.

#### 2. Render the feature as an HTML table

```javascript
const container = document.getElementById('feature');
jsonldUIUtils.createPropertiesTable(feature, container);
```

This builds a nested HTML table structure inside `container`. By default it reads from the `properties` field of the feature object. Pass `propertiesField: null` to use the entire feature object instead:

```javascript
jsonldUIUtils.createPropertiesTable(feature, container, { propertiesField: null });
```

The generated elements carry CSS classes you can style:

| Class | Applied to |
|---|---|
| `.object-table` | `<table>` elements |
| `.object-property` | Property name cells |
| `.object-value` | Property value cells |
| `.literal-value` | Scalar (non-object) values |
| `.array-entry` | Entries within an array value |

#### 3. Augment with semantic metadata

```javascript
await jsonldUIUtils.augment(container, context, {
  fallbackSparqlEndpoint: 'https://example.org/sparql',
});
```

`augment` walks the table, resolves each property name and value to its full URI via the JSON-LD context, fetches RDF data for those URIs, and updates the HTML elements with human-readable labels, descriptions, and links.

During and after augmentation, elements receive additional CSS classes:

| Class | Meaning |
|---|---|
| `.resource-loading` | Fetch in progress |
| `.resource-resolved` | Label successfully retrieved |
| `.resource-error` | Fetch failed |
| `.resource-link` | `<a>` added with the resolved URI |

### Options

#### `createPropertiesTable(feature, container, options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `propertiesField` | `string \| null` | `'properties'` | Property on `feature` to use as the root object. Set to `null` to use the entire feature. |

#### `augment(rootElem, context, options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `replaceElements` | `boolean` | `true` | Replace element text with the resolved label. |
| `labelPredicates` | `(NamedNode \| string)[]` | SKOS prefLabel, DCT/DC title, SDO/FOAF name, RDFS label | RDF predicates checked when extracting a label. |
| `descriptionPredicates` | `(NamedNode \| string)[]` | SKOS definition, DCT/DC description, RDFS comment | RDF predicates checked when extracting a description. |
| `fallbackRainbowInstance` | `string` | — | Base URL of a RAINBOW proxy service used when a direct fetch fails. |
| `fallbackSparqlEndpoint` | `string` | — | SPARQL endpoint URL used as a last resort (`DESCRIBE <uri>`). |
| `acceptedContentTypes` | `object` | Turtle, N-Triples, RDF/XML, anot+Turtle | RDF content types to accept, mapped to `true` or a normalised type string. |

### Lower-level API

#### `fetchResource(uri, options?)`

Fetch RDF metadata for a single URI and return a `ResourceData` object:

```typescript
interface ResourceData {
  uri: string;
  label: string | null;
  description?: string | null;
}
```

```javascript
const data = await jsonldUIUtils.fetchResource('https://example.org/vocab/MyTerm', {
  fallbackSparqlEndpoint: 'https://example.org/sparql',
});
console.log(data.label); // e.g. "My Term"
```

#### `loadContext(context)`

Load and merge one or more JSON-LD contexts. Accepts a context object, a URL string, or an array of either:

```javascript
const merged = await jsonldUIUtils.loadContext([
  'https://example.org/context1.json',
  'https://example.org/context2.json',
]);
```

### Named exports

In addition to the default export you can import individual functions:

```javascript
import {
  createPropertiesTable,
  augment,
  fetchResource,
  loadFeature,
  loadContext,
} from 'jsonld-ui-utils';
```

## Browser example

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    .object-table { border-collapse: collapse; width: 100%; }
    .object-property { font-weight: bold; padding: 4px 8px; vertical-align: top; }
    .object-value { padding: 4px 8px; }
    .resource-resolved { cursor: help; }
  </style>
</head>
<body>
  <div id="feature"></div>

  <script src="https://cdn.jsdelivr.net/npm/rdflib@2.3.0/dist/rdflib.min.js"></script>
  <script src="https://github.com/avillar/jsonld-ui-utils/releases/latest/download/jsonld-ui-utils.min.js"></script>
  <script>
    jsonldUIUtils
      .loadFeature('https://example.org/features/sensor.json')
      .then(({ feature, context }) => {
        const root = document.getElementById('feature');
        jsonldUIUtils.createPropertiesTable(feature, root);
        return jsonldUIUtils.augment(root, context, {
          fallbackSparqlEndpoint: 'https://example.org/sparql',
        });
      });
  </script>
</body>
</html>
```

## Building from source

```bash
yarn install
yarn build      # produces dist/
yarn dev        # start dev server with live reload
```

## License

See [LICENSE](LICENSE).
