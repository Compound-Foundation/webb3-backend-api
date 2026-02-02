declare var global: typeof globalThis & { self: typeof globalThis };
global.self = global;
export {};
