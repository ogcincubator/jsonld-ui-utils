import type * as N3 from 'n3';
export type SendQuery = (query: string) => Promise<N3.Store | null>;
/** Tracks the lookup stages that run before SPARQL, and can therefore still feed a batch */
export declare function trackLookup<T>(lookup: () => Promise<T>): Promise<T>;
export declare const isQueryableIri: (uri: string) => boolean;
/** Resolves with the response to the query that included this URI */
export declare function describeInBatch(endpoint: string, uri: string, batchSize: number, sendQuery: SendQuery): Promise<N3.Store | null>;
