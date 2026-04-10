export interface CrsInfo {
    epsgCode: number;
    epoch?: number;
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
export declare function detectCrs(data: unknown): CrsInfo | null;
/**
 * Returns a proj4 converter from the given EPSG CRS to WGS84.
 * Fetches the projection definition from epsg.io if not already registered.
 */
export declare function getProjectionConverter(crsInfo: CrsInfo, proj4Instance: any): Promise<any>;
/**
 * Deep-clones and transforms all geometries in a FeatureCollection or Feature
 * from the given CRS to WGS84. Per the JSON-FG scoping rules, individual features
 * may carry their own `coordRefSys` that overrides the collection-level one.
 */
export declare function transformFeatureCollection(data: any, collectionCrs: CrsInfo, proj4Instance: any): Promise<any>;
