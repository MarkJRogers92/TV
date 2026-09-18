import { expect, test } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { validationError } from '../../src/server/errors.js';
import { errorLog } from '../../src/server/logging.js';

function capturingReply() {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    code(status: number) {
      sent.status = status;
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as Parameters<typeof validationError>[0];
  return { reply, sent };
}

test('rejects malformed channel mutation without corrupting persisted state', async () => {
  const dir = await mkdtemp(`${tmpdir()}/marktv-`); const app = await buildApp({ dataDir: dir });
  const before = await app.inject('/api/v1/channels/marktv-laughs');
  const bad = await app.inject({ method: 'PUT', url: '/api/v1/channels/marktv-laughs', payload: { id: 'marktv-laughs', name: '' } });
  expect(bad.statusCode).toBe(422); expect(bad.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  const after = await app.inject('/api/v1/channels/marktv-laughs'); expect(after.json()).toEqual(before.json()); await app.close();
});

test('answers an unexpected failure with a logged 500 instead of a 422', () => {
  // Every non-Zod throw used to be reported as `422 VALIDATION_ERROR` with an
  // empty issue list: a status that asserted a validation problem while hiding
  // what actually went wrong.
  const lines: string[] = []; const previous = errorLog.sink; errorLog.sink = (line) => lines.push(line);
  try {
    const { reply, sent } = capturingReply();
    validationError(reply, new Error('the database connection is not open'));
    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(lines.join('\n')).toContain('request.validation');
  } finally { errorLog.sink = previous; }
});

test('still answers a genuine validation failure with 422 and its issues', () => {
  const parsed = z.object({ name: z.string().min(1) }).safeParse({ name: '' });
  const { reply, sent } = capturingReply();
  validationError(reply, parsed.success ? new Error('expected failure') : parsed.error);
  expect(sent.status).toBe(422);
  expect(sent.body).toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ path: 'name' }] });
});
