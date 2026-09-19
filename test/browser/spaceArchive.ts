/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * A vite-servable door onto `@interop/space-archive`, for the browser spec's
 * dynamic import. The script Playwright evaluates in the page has no import
 * map, so it cannot resolve a bare package specifier on its own; importing
 * this module by its dev-server URL instead lets Vite's own transform resolve
 * the bare specifier below, the same way it already resolves this package's
 * other dependencies.
 */
export {
  collectBytes,
  packSpaceArchive,
  readSpaceArchive
} from '@interop/space-archive'
