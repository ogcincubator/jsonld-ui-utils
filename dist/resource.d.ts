import * as N3 from 'n3';
export interface FetchResourceOptions {
    labelPredicates: string[];
    descriptionPredicates: string[];
    fallbackRainbowInstance?: string;
    fallbackRainbowInstances?: string | string[];
    fallbackSparqlEndpoint?: string;
    fallbackSparqlEndpoints?: string | string[];
}
export declare const defaultFetchResourceOptions: FetchResourceOptions;
export interface CreatePropertiesTableOptions {
    propertiesField?: string | null;
}
export interface ResourceData {
    uri: string;
    label: string | null;
    description?: string | null;
}
export declare function findInStore(store: N3.Store, subjectUri: string, predicates: string[], userLangs?: string[]): string | null;
export declare function fetchResource(uri: string, options?: Partial<FetchResourceOptions>): Promise<ResourceData>;
export declare function loadFeature(url: string): Promise<{
    feature: any;
    context: import("jsonld").ContextDefinition;
}>;
