import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';
import { logSink } from '../src/server/logging.js';

/*
 * Register the jest-dom matchers explicitly rather than importing
 * `@testing-library/jest-dom/vitest`. Under the installed vitest the package's
 * own entry does not take effect (every `toBeVisible`/`toHaveTextContent` throws
 * "Invalid Chai property"), while calling `expect.extend` with the matchers
 * directly does. This keeps the whole web suite green.
 */
expect.extend(jestDomMatchers as never);

// Discarded rather than printed. Many tests deliberately drive failure paths - a
// closed database, a provider that errors - and those now log, so letting them
// reach stderr would bury a real failure in noise from intentional ones. Tests
// that assert on logging replace this sink themselves.
logSink.sink = () => {};

