/**
 * pi-ai.ts — single import point for the two test helpers that pi-ai ≥0.80
 * exports only from the `/compat` subpath (both lived on the package root in
 * ≤0.75.x). Upstream deletes `/compat` with its coding-agent ModelManager
 * migration; the replacement then is `fauxProvider()` + `createModels()`.
 */
export { getModel, registerFauxProvider } from "@earendil-works/pi-ai/compat";
