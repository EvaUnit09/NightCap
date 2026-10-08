/**
 * Test setup: shim server-only to allow tests to run in Node.
 * This hooks into the module system before tests load.
 */
import { Module } from "node:module";

const originalResolveFilename = Module._resolveFilename;

// @ts-expect-error - hooking into Module internals
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") {
    // Return path to our shim
    return new URL("./shims/server-only.ts", import.meta.url).pathname;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
