import { CreatePropertiesTableOptions, FetchResourceOptions } from "./resource";
import { ContextDefinition } from "jsonld";
export interface AugmentOptions extends FetchResourceOptions {
    replaceElements: boolean;
    /** Base URL for resolving relative identifiers (overridden by @base in the context) */
    baseUrl?: string;
}
export declare function createPropertiesTable(feature: {
    [index: string]: any;
}, container: HTMLElement, options?: CreatePropertiesTableOptions): void;
export declare function augment(rootElem: HTMLElement, context: ContextDefinition, options?: Partial<AugmentOptions>): Promise<void>;
