import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// RTL auto-cleanup needs vitest globals; register it explicitly instead.
afterEach(() => {
  cleanup();
});
