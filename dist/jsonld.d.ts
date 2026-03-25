import { ContextDefinition } from 'jsonld';
type OrArray<T> = T | T[];
export type Context = OrArray<null | string | ContextDefinition>;
export type ContextObject = {
    "@context": Context;
};
export declare function loadContext(context: Context | ContextObject): Promise<ContextDefinition>;
export {};
