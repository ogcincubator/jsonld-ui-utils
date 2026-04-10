# @opengeospatial/jsonld-ui-utils

A JavaScript/TypeScript library that renders JSON-LD feature data as interactive HTML tables and enriches them with semantic metadata (labels, descriptions) fetched from RDF sources.

## Features

- Render JSON-LD objects as nested HTML tables
- Resolve property names and values to their full URIs using JSON-LD contexts
- Fetch RDF metadata (labels, descriptions) for resolved URIs
- Multiple fallback mechanisms: direct fetch, [RAINBOW](https://github.com/ogcincubator/rainbow) proxy, SPARQL endpoint
- Built-in caching to avoid redundant network requests
- [Leaflet](https://leafletjs.com/) plugin for GeoJSON layers with automatic popup tables

## Installation

```bash
npm install @opengeospatial/jsonld-ui-utils
# or
yarn add @opengeospatial/jsonld-ui-utils
```

### Optional peer dependencies

[`jsonld`](https://www.npmjs.com/package/jsonld) is an optional peer dependency. Install it if you need to fetch and resolve JSON-LD contexts by URL:

```bash
npm install jsonld
```

[`proj4`](https://www.npmjs.com/package/proj4) is an optional peer dependency required only when using the Leaflet plugin with non-WGS84 data:

```bash
npm install proj4
```

### Browser (IIFE)

```html
<!-- optional: library-provided styles -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@opengeospatial/jsonld-ui-utils@latest/dist/jsonld-ui-utils.css"/>

<!-- optional: jsonld peer dep (needed for context URL resolution) -->
<script src="https://cdn.jsdelivr.net/npm/jsonld@8/dist/jsonld.min.js"></script>

<script src="https://cdn.jsdelivr.net/npm/@opengeospatial/jsonld-ui-utils@latest/dist/jsonld-ui-utils.min.js"></script>
```

This exposes `jsonldUIUtils` as a global variable.

## Usage

### Quick start

```javascript
import { loadFeature, createPropertiesTable, augment } from '@opengeospatial/jsonld-ui-utils';

const { feature, context } = await loadFeature('https://example.org/features/my-feature.json');

const container = document.getElementById('feature');
createPropertiesTable(feature, container);
await augment(container, context);
```

### Step by step

#### 1. Load a JSON-LD feature

```javascript
const { feature, context } = await loadFeature(featureUrl);
```

`loadFeature` fetches the document at `featureUrl`, extracts its `@context`, recursively loads and merges any referenced context URLs, and returns both the raw feature object and the resolved context.

#### 2. Render the feature as an HTML table

```javascript
const container = document.getElementById('feature');
createPropertiesTable(feature, container);
```

This builds a nested HTML table structure inside `container`. By default it reads from the `properties` field of the feature object. Pass `propertiesField: null` to use the entire feature object instead:

```javascript
createPropertiesTable(feature, container, { propertiesField: null });
```

The generated elements carry CSS classes you can style:

| Class | Applied to |
|---|---|
| `.object-properties` | Wrapper `<div>` around the top-level table |
| `.object-table` | `<table>` elements |
| `.object-property` | Property name cells |
| `.object-value` | Property value cells |
| `.literal-value` | Scalar (non-object) values |
| `.array-entry` | Entries within an array value |

Include `dist/jsonld-ui-utils.css` (or the CDN link above) for default styling of these classes.

#### 3. Augment with semantic metadata

```javascript
await augment(container, context, {
  fallbackSparqlEndpoints: 'https://example.org/sparql',
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
| `propertiesField` | `string` or `null` | `'properties'` | Property on `feature` to use as the root object. Set to `null` to use the entire feature. |

#### `augment(rootElem, context, options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `replaceElements` | `boolean` | `true` | Replace element text with the resolved label. |
| `labelPredicates` | `string[]` | SKOS prefLabel, DCT/DC title, SDO/FOAF name, RDFS label | RDF predicates checked when extracting a label. |
| `descriptionPredicates` | `string[]` | SKOS definition, DCT/DC description, RDFS comment | RDF predicates checked when extracting a description. |
| `fallbackRainbowInstances` | `string` or `string[]` | — | One or more RAINBOW proxy base URLs tried in order when a direct fetch returns no label. |
| `fallbackSparqlEndpoints` | `string` or `string[]` | — | One or more SPARQL endpoint URLs tried in order as a last resort (`DESCRIBE <uri>`). |

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
const data = await fetchResource('https://example.org/vocab/MyTerm', {
  fallbackSparqlEndpoints: 'https://example.org/sparql',
});
console.log(data.label); // e.g. "My Term"
```

#### `loadContext(context)`

Load and merge one or more JSON-LD contexts. Accepts a context object, a URL string, or an array of either:

```javascript
const merged = await loadContext([
  'https://example.org/context1.json',
  'https://example.org/context2.json',
]);
```

---

## Leaflet plugin

The Leaflet plugin creates a `L.GeoJSON` layer that automatically renders popup tables for each feature and augments them with RDF metadata.

Same package as above — no separate install needed. Import the plugin entry point:

```javascript
import { createJsonLDGeoJSONLayer } from '@opengeospatial/jsonld-ui-utils/leaflet';
```

### Browser (IIFE)

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@opengeospatial/jsonld-ui-utils@latest/dist/jsonld-ui-utils.css"/>

<!-- optional: required only for non-WGS84 data (must come before the plugin) -->
<script src="https://unpkg.com/proj4@latest/dist/proj4.js"></script>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@opengeospatial/jsonld-ui-utils@latest/dist/jsonld-ui-utils-leaflet.min.js"></script>
```

This exposes `jsonldUIUtilsLeaflet` as a global variable.

### Usage

`createJsonLDGeoJSONLayer` returns a `Promise<L.GeoJSON>`:

```javascript
const layer = await createJsonLDGeoJSONLayer(L, geojsonData, {
  ldContext: 'https://example.org/context.jsonld',
  popupOptions: { maxWidth: 420 },
  augmentOptions: {
    fallbackSparqlEndpoints: 'https://example.org/sparql',
  },
});

layer.addTo(map);
```

Or with `.then()`:

```javascript
createJsonLDGeoJSONLayer(L, geojsonData, options).then(layer => {
  layer.addTo(map);
  map.fitBounds(layer.getBounds());
});
```

### Behaviour

- Each feature with a non-empty `properties` object gets a popup with a rendered table.
- If the feature has an `id`, it is shown as a hover tooltip automatically.
- The popup table is augmented with RDF labels/descriptions when `ldContext` is provided.
- For WGS84 data the function resolves immediately with no additional network requests.

### CRS support (beta)

The plugin can render data in coordinate reference systems other than WGS84 by transforming geometries to WGS84 before passing them to Leaflet.

The CRS is detected automatically from the input data in priority order:

1. **JSON-FG `coordRefSys`** — a URI string, a `{ "type": "Reference", "href": "...", "epoch": ... }` object, or an array of these (compound CRS; the first EPSG entry is used)
2. **Legacy GeoJSON `crs`** — `{ "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::XXXX" } }`

If the detected CRS is not already registered with proj4, the plugin fetches its definition from [epsg.io](https://epsg.io) on first use and caches it for the lifetime of the page.

**Requirements:** [proj4js](https://proj4js.org/) must be available. In ESM/CJS projects install it as a peer dependency (`npm install proj4`). In browser IIFE usage, load the proj4 script before the plugin (see snippet above) so that `window.proj4` is present.

```javascript
// CRS is read automatically from data.crs or data.coordRefSys
const layer = await createJsonLDGeoJSONLayer(L, dataInEpsg5514, options);

// Or supply a CRS explicitly, bypassing auto-detection:
const layer = await createJsonLDGeoJSONLayer(L, data, {
  ...options,
  coordRefSys: 'EPSG:5514',
});
```

Per the JSON-FG scoping rules, a `coordRefSys` on an individual feature overrides the collection-level value for that feature's geometry.

> **Note:** Coordinate epochs (present on some dynamic CRS references) are not supported by proj4js and are silently ignored with a console warning.

### Options (`JsonLDGeoJSONOptions`)

| Option | Type | Default | Description |
|---|---|---|---|
| `ldContext` | `string`, `object`, or `array` | — | JSON-LD context (URL, object, or array) used to resolve property URIs. |
| `popupOptions` | `object` | `{ maxWidth: 400 }` | Options passed to Leaflet's `bindPopup`. |
| `augmentOptions` | `object` | `{}` | Options passed to `augment()` (see above). |
| `onEachFeature` | `function` | — | Called for every feature before the plugin's own logic, matching Leaflet's `onEachFeature` signature. |
| `coordRefSys` | `string` | — | Override CRS detection with an explicit URI (e.g. `"EPSG:5514"`). |
| `proj4` | `object` | — | Inject a specific proj4 instance instead of using the auto-resolved one. |

Any other options are forwarded to `L.geoJSON`.

---

## Demos

- [Basic demo](https://ogcincubator.github.io/jsonld-ui-utils/demo/index.html) — renders a JSON-LD feature as an augmented properties table
- [Leaflet demo](https://ogcincubator.github.io/jsonld-ui-utils/demo/leaflet.html) — GeoJSON layer with popup tables and RDF augmentation
- [Leaflet CRS demo](https://ogcincubator.github.io/jsonld-ui-utils/demo/leaflet-crs.html) — GeoJSON layer in EPSG:5514 (Czech S-JTSK), auto-detected and reprojected to WGS84

## Building from source

```bash
yarn install
yarn build      # produces dist/
yarn dev        # start dev server with live reload
```

## License

See [LICENSE](LICENSE).
