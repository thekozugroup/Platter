/// <reference types="vite/client" />

/**
 * Vitest's config lives inside `vite.config.ts` — one config file, one set of aliases, one
 * dev server. A separate `vitest.config.ts` drifts from it the first time an alias changes.
 *
 * Vite's own `UserConfig` has no `test` key, so that config only typechecks once Vitest's
 * module augmentation is part of the program. Referencing it from a `.d.ts` applies it
 * app-wide instead of leaving a build-tool reference comment at the top of `vite.config.ts`.
 */
/// <reference types="vitest/config" />
