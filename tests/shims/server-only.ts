/**
 * Test shim for server-only package.
 * This empty module allows config.ts to be imported in Node test environments.
 * Production builds still enforce server-only correctly since Next.js resolution is unaffected.
 */
export {};
