import '@testing-library/jest-dom/vitest';
import { errorLog } from '../src/server/logging.js';

// Discarded rather than printed. Many tests deliberately drive failure paths - a
// closed database, a provider that errors - and those now log, so letting them
// reach stderr would bury a real failure in noise from intentional ones. Tests
// that assert on logging replace this sink themselves.
errorLog.sink = () => {};

