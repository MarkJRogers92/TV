import { expect, test } from 'vitest';
import { buildApp } from '../../src/server/app.js';
test('reports a healthy local service', async () => { const app=await buildApp(); const r=await app.inject({method:'GET',url:'/api/v1/health'}); expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({status:'ok'}); await app.close(); });
