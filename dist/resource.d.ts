import * as N3 from 'n3';
export interface FetchResourceOptions {
    labelPredicates: string[];
    descriptionPredicates: string[];
    fallbackRainbowInstance?: string;
    fallbackRainbowInstances?: string | string[];
    fallbackSparqlEndpoint?: string;
    fallbackSparqlEndpoints?: string | string[];
    /** Maximum simultaneous HTTP requests. Default: 6 */
    maxConcurrentRequests?: number;
    /** Maximum URIs per SPARQL query. Default: 50 */
    sparqlBatchSize?: number;
    /** Milliseconds after which a request is abandoned. Default: 10000 */
    requestTimeout?: number;
}
export declare const defaultFetchResourceOptions: FetchResourceOptions;
export interface CreatePropertiesTableOptions {
    propertiesField?: string | null;
    /** Maximum nesting levels (objects and arrays) to render. Default: 15 */
    maxDepth?: number;
    /** Maximum entries to render per array or object. Default: 100 */
    maxElements?: number;
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
