import { AugmentOptions } from './augment';
import { type Context, type ContextObject } from './jsonld';
export interface JsonLDGeoJSONOptions {
    ldContext?: Context | ContextObject;
    popupOptions?: Record<string, any>;
    augmentOptions?: Partial<AugmentOptions>;
    onEachFeature?: (feature: any, layer: any) => void;
    /** Override the auto-detected CRS with an explicit URI (e.g. "EPSG:5514"). */
    coordRefSys?: string;
    /** Inject a proj4 instance. Useful in environments where window.proj4 is not available. */
    proj4?: any;
    [key: string]: any;
}
export declare function createJsonLDGeoJSONLayer(L: any, data: any, options?: JsonLDGeoJSONOptions): Promise<any>;
