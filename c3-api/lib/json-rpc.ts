import fetch        from './request-counting-fetch.js';
import * as JsonRpc from './json-rpc/json-rpc.js';

export const { post, postBatch } = JsonRpc.configure({ fetch });
export * from './json-rpc/json-rpc.js';
