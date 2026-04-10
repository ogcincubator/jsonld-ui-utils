import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import babel from "@rollup/plugin-babel";
import json from '@rollup/plugin-json';
import polyfillNode from 'rollup-plugin-polyfill-node';
import {terser} from "rollup-plugin-terser";

const DIST = process.env.BUILD_DIR ?? 'dist-local';

// IIFE bundles everything; ESM/CJS leaves runtime deps external so consumers' bundlers can deduplicate
const MODULE_EXTERNALS = ['n3', 'jsonld', 'rdfxml-streaming-parser'];
const LEAFLET_MODULE_EXTERNALS = ['leaflet', 'proj4', ...MODULE_EXTERNALS];

// Shims for the IIFE browser build.
//  - 'node:*': rdfxml-streaming-parser uses node:-prefixed builtins; strip the prefix so
//    polyfillNode can handle them (polyfillNode only recognises unprefixed names).
//  - 'readable-stream': n3 imports Readable for its streaming match() API, which we don't use.
//  - 'util/types', 'stream/web': provide minimal browser-compatible implementations.
//  - 'jsonld': optional peer dep — resolved from window.jsonld if present, otherwise undefined.
const browserShims = {
  name: 'browser-shims',
  async resolveId(id, importer) {
    if (id.startsWith('node:')) return this.resolve(id.slice(5), importer, {skipSelf: true});
    if (id === 'readable-stream') return '\0shim:readable-stream';
    if (id === 'util/types') return '\0shim:util-types';
    if (id === 'stream/web') return '\0shim:stream-web';
    if (id === 'jsonld') return '\0shim:jsonld';
    if (id === 'proj4') return '\0shim:proj4';
  },
  load(id) {
    if (id === '\0shim:jsonld') return `export default typeof jsonld !== 'undefined' ? jsonld : undefined;`;
    if (id === '\0shim:proj4') return `export default typeof proj4 !== 'undefined' ? proj4 : undefined;`;
    if (id === '\0shim:util-types') return `
export function isUint8Array(v) { return v instanceof Uint8Array; }
export function isAnyArrayBuffer(v) { return v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer); }
export default { isUint8Array, isAnyArrayBuffer };
`;
    if (id === '\0shim:stream-web') return `
export const ReadableStream = globalThis.ReadableStream;
export const WritableStream = globalThis.WritableStream;
export const TransformStream = globalThis.TransformStream;
export default { ReadableStream, WritableStream, TransformStream };
`;
    if (id === '\0shim:readable-stream') return `
export class Readable {
  constructor() {}
  on() { return this; }
  once() { return this; }
  emit() { return this; }
  pipe() { return this; }
  push() { return false; }
  destroy() {}
  _read() {}
}
export class Writable {
  constructor() {}
  on() { return this; }
  write() {}
  end() {}
}
export class Transform extends Readable {}
export class PassThrough extends Transform {}
export default { Readable, Writable, Transform, PassThrough };
`;
  },
};

function onwarn(warning, warn) {
  // Expected and harmless: Rollup rewrites top-level `this` to undefined in ESM modules
  if (warning.code === 'THIS_IS_UNDEFINED') return;
  // Expected: circular refs inside rollup-plugin-polyfill-node's own shims
  if (warning.code === 'CIRCULAR_DEPENDENCY' && warning.ids?.some(id => id.includes('polyfill-node'))) return;
  warn(warning);
}

const iifePlugins = [
  browserShims,
  polyfillNode(),
  resolve(),
  json({preferConst: true, compact: true}),
  commonjs({include: /node_modules/, transformMixedEsModules: true}),
  typescript({tsconfig: "./tsconfig.json", outDir: DIST, sourceMap: true, inlineSources: true}),
  babel({
    babelHelpers: "bundled",
    presets: [["@babel/preset-env", {targets: "> 0.5%, not dead", useBuiltIns: false}]],
  }),
  terser(),
];

const modulePlugins = [
  resolve({browser: true, preferBuiltins: false}),
  json({preferConst: true, compact: true}),
  commonjs({include: /node_modules/, transformMixedEsModules: true}),
  typescript({tsconfig: "./tsconfig.json", outDir: DIST, sourceMap: true, inlineSources: true}),
];

export default [{
  input: "src/index.ts",
  onwarn,
  output: [{
    file: `${DIST}/jsonld-ui-utils.min.js`,
    format: "iife",
    name: "jsonldUIUtils",
    inlineDynamicImports: true,
    exports: "named",
    sourcemap: true,
  }],
  plugins: iifePlugins,
}, {
  input: "src/index.ts",
  external: MODULE_EXTERNALS,
  output: [
    {file: `${DIST}/index.esm.js`, format: "esm", sourcemap: true},
    {file: `${DIST}/index.cjs.js`, format: "cjs", exports: "named", sourcemap: true},
  ],
  plugins: modulePlugins,
}, {
  // Leaflet plugin — IIFE (self-contained; leaflet is external via window.L)
  input: "src/leaflet.ts",
  onwarn,
  external: ["leaflet"],
  output: [{
    file: `${DIST}/jsonld-ui-utils-leaflet.min.js`,
    format: "iife",
    name: "jsonldUIUtilsLeaflet",
    globals: {leaflet: "L"},
    inlineDynamicImports: true,
    exports: "named",
    sourcemap: true,
  }],
  plugins: iifePlugins,
}, {
  // Leaflet plugin — ESM/CJS (leaflet + runtime deps are external)
  input: "src/leaflet.ts",
  external: LEAFLET_MODULE_EXTERNALS,
  output: [
    {file: `${DIST}/leaflet.esm.js`, format: "esm", sourcemap: true},
    {file: `${DIST}/leaflet.cjs.js`, format: "cjs", exports: "named", sourcemap: true},
  ],
  plugins: modulePlugins,
}];
