import { ContextDefinition } from 'jsonld';
type OrArray<T> = T | T[];
export type Context = OrArray<null | string | ContextDefinition>;
export type ContextObject = {
    "@context": Context;
};
/** Loaded context definitions in order of application; null resets the ones before it */
export type ContextEntries = (ContextDefinition | null)[];
export interface LoadContextOptions {
    /** Base URL for resolving relative context references */
    baseUrl?: string;
    /** Timeout in milliseconds for each remote context. Default: 10000 */
    requestTimeout?: number;
}
/**
 * Loads a context without merging its entries. Remote references are replaced by their contents,
 * including the scoped contexts of term definitions, which are modified in place.
 */
export declare function loadContextEntries(context: Context | undefined, options?: LoadContextOptions): Promise<ContextEntries>;
export declare function loadContext(context: Context | ContextObject, options?: LoadContextOptions): Promise<ContextDefinition>;
export {};
