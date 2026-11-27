export interface RequestOptions {
    limit: number;
    timeout: number;
    /** Go ahead of the non-priority requests already waiting */
    priority?: boolean;
}
/**
 * Runs a task holding one request slot. The task must pass the signal to fetch() and include reading
 * the response body, so that the slot is held (and the timeout applies) until the request is done.
 */
export declare function withRequestSlot<T>(task: (signal: AbortSignal) => Promise<T>, { limit, timeout, priority }: RequestOptions): Promise<T>;
