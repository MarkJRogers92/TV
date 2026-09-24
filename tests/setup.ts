// The type-only import registers the jest-dom matcher TYPES (toBeVisible, ...).
import '@testing-library/jest-dom/vitest';
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';
import { logSink } from '../src/server/logging.js';

/*
 * ...but under the installed vitest that entry does NOT register them at runtime
 * (every toBeVisible/toHaveTextContent throws "Invalid Chai property"), while
 * calling `expect.extend` with the matchers directly does. Do both: the import
 * for the types, this for the behaviour.
 */
expect.extend(jestDomMatchers as never);

// Discarded rather than printed. Many tests deliberately drive failure paths - a
// closed database, a provider that errors - and those now log, so letting them
// reach stderr would bury a real failure in noise from intentional ones. Tests
// that assert on logging replace this sink themselves.
logSink.sink = () => {};

