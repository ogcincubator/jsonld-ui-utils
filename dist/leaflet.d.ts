import { AugmentOptions } from './augment';
import { type Context, type ContextObject } from './jsonld';
export interface JsonLDGeoJSONOptions {
    ldContext?: Context | ContextObject;
    popupOptions?: Record<string, any>;
    augmentOptions?: Partial<AugmentOptions>;
    /** Base URL for resolving relative context references and identifiers. */
    baseUrl?: string;
    /** Maximum nesting levels in popup tables. Default: 15 */
    maxDepth?: number;
    /** Maximum entries per array or object in popup tables. Default: 100 */
    maxElements?: number;
    onEachFeature?: (feature: any, layer: any) => void;
    /** Override the auto-detected CRS with an explicit URI (e.g. "EPSG:5514"). */
    coordRefSys?: string;
    /** Inject a proj4 instance. Useful in environments where window.proj4 is not available. */
    proj4?: any;
    /**
     * When true (default), adds a Leaflet layer attribution showing the original CRS
     * whenever coordinates are transformed from a non-WGS84 CRS.
     */
    crsAttribution?: boolean;
    [key: string]: any;
}
export declare function createJsonLDGeoJSONLayer(L: any, data: any, options?: JsonLDGeoJSONOptions): Promise<any>;
