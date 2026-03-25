export * from './resource';
export * from './jsonld';
export * from './augment';
import * as resource from './resource';
import * as jsonld from './jsonld';
import * as augment from './augment';
declare const _default: {
    createPropertiesTable(feature: {
        [index: string]: any;
    }, container: HTMLElement, options?: resource.CreatePropertiesTableOptions): void;
    augment(rootElem: HTMLElement, context: import("jsonld").ContextDefinition, options?: Partial<augment.AugmentOptions>): Promise<void>;
    loadContext(context: jsonld.Context | jsonld.ContextObject): Promise<import("jsonld").ContextDefinition>;
    fetchResource(uri: string, options?: Partial<resource.FetchResourceOptions>): Promise<resource.ResourceData>;
    loadFeature(url: string): Promise<{
        feature: any;
        context: import("jsonld").ContextDefinition;
    }>;
    defaultFetchResourceOptions: resource.FetchResourceOptions;
};
export default _default;
