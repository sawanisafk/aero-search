import { describe, expect, it } from 'vitest';
import { CORE_LAYER_VERSION, PROJECT_NAME } from '../src/core/index.js';

describe('repository smoke test', () => {
  it('toolchain runs tests against src/', () => {
    expect(PROJECT_NAME).toBe('aero-search');
    expect(CORE_LAYER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
