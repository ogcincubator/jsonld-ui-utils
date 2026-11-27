import { ContextDefinition } from "jsonld";
export type ContextStack = ContextDefinition[];
export interface TermDefinition {
    '@id'?: string | null;
    '@reverse'?: string;
    '@type'?: string;
    '@context'?: any;
}
export interface ExpandOptions {
    /** Resolve as a vocabulary term (property names, types): term definitions and @vocab apply */
    vocab?: boolean;
    /** Resolve as a document-relative reference (@id values): @base / baseUrl apply */
    base?: boolean;
    baseUrl?: string;
}
export declare function pushContext(stack: ContextStack, context: any): ContextStack;
/** Term definition in object form; null if the term is explicitly unmapped, undefined if unknown */
export declare function findTerm(term: string, stack: ContextStack): TermDefinition | null | undefined;
/** The keyword (`@id`, `@type`...) that a key stands for, either directly or through an alias */
export declare function asKeyword(key: string, stack: ContextStack): string | null;
export declare function expandIri(value: string, stack: ContextStack, options: ExpandOptions, seen?: Set<string>): string | null;
