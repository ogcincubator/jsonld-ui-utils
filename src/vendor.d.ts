// Ambient type shims for optional peer dependencies that are not installed
// in this repo but must be importable from TypeScript source.

declare module 'proj4' {
  const proj4: any;
  export default proj4;
}