import { AugmentOptions } from './augment';
import { type Context, type ContextObject } from './jsonld';
export interface JsonLDGeoJSONOptions {
    ldContext?: Context | ContextObject;
    popupOptions?: Record<string, any>;
    augmentOptions?: Partial<AugmentOptions>;
    onEachFeature?: (feature: any, layer: any) => void;
    [key: string]: any;
}
export declare function createJsonLDGeoJSONLayer(L: any, data: any, options?: JsonLDGeoJSONOptions): any;
