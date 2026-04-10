export interface CrsInfo {
  epsgCode: number;
  epoch?: number;
}

const WGS84_EPSG_CODES = new Set([4326, 4979]);

const proj4DefCache = new Map<number, string>();

function extractEpsgCode(uri: string): number | null {
  // http(s)://www.opengis.net/def/crs/EPSG/0/5514
  let m = uri.match(/\/crs\/EPSG\/[^/]+\/(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  // urn:ogc:def:crs:EPSG::5514
  m = uri.match(/urn:ogc:def:crs:EPSG::(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  // EPSG:5514
  m = uri.match(/^EPSG:(\d+)$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function isWgs84(uri: string): boolean {
  const code = extractEpsgCode(uri);
  if (code !== null) return WGS84_EPSG_CODES.has(code);
  return /\/OGC\/[^/]+\/CRS84h?$/i.test(uri) || /urn:ogc:def:crs:OGC:[^:]*:CRS84h?$/i.test(uri);
}

function parseSingleCrs(value: unknown): CrsInfo | null {
  if (typeof value === 'string') {
    if (isWgs84(value)) return null;
    const code = extractEpsgCode(value);
    return code !== null ? {epsgCode: code} : null;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj['type'] === 'Reference' && typeof obj['href'] === 'string') {
      if (isWgs84(obj['href'])) return null;
      const code = extractEpsgCode(obj['href']);
      if (code === null) return null;
      return {
        epsgCode: code,
        epoch: typeof obj['epoch'] === 'number' ? obj['epoch'] : undefined,
      };
    }
  }
  return null;
}

function parseCoordRefSys(coordRefSys: unknown): CrsInfo | null {
  if (Array.isArray(coordRefSys)) {
    for (const item of coordRefSys) {
      const result = parseSingleCrs(item);
      if (result !== null) return result;
    }
    return null;
  }
  return parseSingleCrs(coordRefSys);
}

function parseLegacyCrs(crs: unknown): CrsInfo | null {
  if (!crs || typeof crs !== 'object') return null;
  const obj = crs as Record<string, unknown>;
  if (obj['type'] !== 'name') return null;
  const props = obj['properties'];
  if (!props || typeof props !== 'object') return null;
  const name = (props as Record<string, unknown>)['name'];
  if (typeof name !== 'string') return null;
  if (isWgs84(name)) return null;
  const code = extractEpsgCode(name);
  return code !== null ? {epsgCode: code} : null;
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
export function detectCrs(data: unknown): CrsInfo | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  if ('coordRefSys' in obj) {
    const result = parseCoordRefSys(obj['coordRefSys']);
    if (result !== null) return result;
  }
  if ('crs' in obj) {
    const result = parseLegacyCrs(obj['crs']);
    if (result !== null) return result;
  }
  return null;
}

/**
 * Returns a proj4 converter from the given EPSG CRS to WGS84.
 * Fetches the projection definition from epsg.io if not already registered.
 */
export async function getProjectionConverter(crsInfo: CrsInfo, proj4Instance: any): Promise<any> {
  const key = `EPSG:${crsInfo.epsgCode}`;

  if (crsInfo.epoch !== undefined) {
    console.warn(`CRS epoch ${crsInfo.epoch} ignored — proj4js does not support coordinate epochs.`);
  }

  if (!proj4Instance.defs(key)) {
    let defStr = proj4DefCache.get(crsInfo.epsgCode);
    if (!defStr) {
      const response = await fetch(`https://epsg.io/${crsInfo.epsgCode}.proj4`);
      if (!response.ok) {
        throw new Error(
          `Unknown CRS EPSG:${crsInfo.epsgCode} — could not retrieve a definition from epsg.io (HTTP ${response.status})`
        );
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

function transformCoords(coords: number[], converter: any): number[] {
  const projected: number[] = converter.forward(coords.slice(0, 2));
  return coords.length > 2 ? [projected[0], projected[1], coords[2]] : [projected[0], projected[1]];
}

function transformGeometry(geometry: any, converter: any): any {
  if (!geometry) return geometry;
  switch (geometry.type) {
    case 'Point':
      return {...geometry, coordinates: transformCoords(geometry.coordinates, converter)};
    case 'MultiPoint':
    case 'LineString':
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((c: number[]) => transformCoords(c, converter)),
      };
    case 'MultiLineString':
    case 'Polygon':
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((r: number[][]) =>
          r.map((c: number[]) => transformCoords(c, converter))
        ),
      };
    case 'MultiPolygon':
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((p: number[][][]) =>
          p.map((r: number[][]) => r.map((c: number[]) => transformCoords(c, converter)))
        ),
      };
    case 'GeometryCollection':
      return {
        ...geometry,
        geometries: geometry.geometries.map((g: any) => transformGeometry(g, converter)),
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
export async function transformFeatureCollection(
  data: any,
  collectionCrs: CrsInfo,
  proj4Instance: any,
): Promise<any> {
  const collectionConverter = await getProjectionConverter(collectionCrs, proj4Instance);

  const transformFeature = async (feature: any): Promise<any> => {
    const featureCrs = detectCrs(feature);
    let converter = collectionConverter;
    if (featureCrs !== null && featureCrs.epsgCode !== collectionCrs.epsgCode) {
      converter = await getProjectionConverter(featureCrs, proj4Instance);
    }
    return {...feature, geometry: transformGeometry(feature.geometry, converter)};
  };

  if (data.type === 'FeatureCollection') {
    return {...data, features: await Promise.all((data.features ?? []).map(transformFeature))};
  }
  if (data.type === 'Feature') {
    return transformFeature(data);
  }
  return data;
}
