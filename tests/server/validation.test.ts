import { expect, test } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('rejects malformed channel mutation without corrupting persisted state', async () => {
  const dir = await mkdtemp(`${tmpdir()}/marktv-`); const app = await buildApp({ dataDir: dir });
  const before = await app.inject('/api/v1/channels/marktv-laughs');
  const bad = await app.inject({ method: 'PUT', url: '/api/v1/channels/marktv-laughs', payload: { id: 'marktv-laughs', name: '' } });
  expect(bad.statusCode).toBe(422); expect(bad.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  const after = await app.inject('/api/v1/channels/marktv-laughs'); expect(after.json()).toEqual(before.json()); await app.close();
});
