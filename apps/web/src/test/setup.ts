import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

/**
 * Browser APIs jsdom does not implement.
 *
 * Every one of these is used by something real — the theme provider reads `matchMedia`,
 * Ark's ScrollArea observes its viewport, the console and the mod grid measure and scroll.
 * Without the stubs the tests still pass but leak uncaught exceptions from inside library
 * code, which buries the failure you actually care about in noise.
 *
 * They live here rather than in individual test files so a new test that happens to render
 * a dialog does not have to rediscover them.
 */

if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/* Ark's ScrollArea and the mod grid's infinite-scroll sentinel both construct one. */
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    disconnect() {}
    observe() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    unobserve() {}
  } as unknown as typeof IntersectionObserver;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

/* jsdom has no layout engine, so `scrollTo` throws "Not implemented" on every route change
 * and floods the output. The scroll-restoration behaviour it stands in for is a browser
 * concern verified in the Playwright specs, not here. */
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
