/**
 * Core module boundary.
 *
 * Everything under src/core is pure information-retrieval logic:
 * no filesystem, no network, no database, no framework imports.
 * This is what makes the retrieval system unit-testable and independently
 * benchmarkable (see docs/ARCHITECTURE.md, module dependency rules).
 */
export const PROJECT_NAME = 'aero-search';
export const CORE_LAYER_VERSION = '0.1.0';
