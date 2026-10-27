/**
 * Contract check (runs in CI): the OpenAPI document must be valid AND describe exactly the routes the server registers.
 *   npx tsx scripts/check-openapi.ts
 */
import '../test/setup-env';
import { readFileSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import YAML from 'yaml';
import { loadConfig } from '../src/config/env';
import { buildContainer } from '../src/container';
import { buildApp } from '../src/http/app';
import { createLogger } from '../src/shared/logger';

async function main() {
  const file = 'docs/openapi.yaml';
  await SwaggerParser.validate(file);
  const spec = YAML.parse(readFileSync(file, 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  const documented = new Set<string>();
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const m of Object.keys(ops)) documented.add(`${m.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ':$1')}`);
  }
  const cfg = loadConfig({ ...process.env, DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x' });
  const c = await buildContainer(cfg, createLogger({ level: 'silent', service: 'check' }), 'api');
  const app = await buildApp(c);
  await app.ready();
  const implemented = new Set(app.routeTable);
  const undocumented = [...implemented].filter((r) => !documented.has(r));
  const unimplemented = [...documented].filter((r) => !implemented.has(r));
  await app.close();
  await c.db.close();
  if (undocumented.length || unimplemented.length) {
    console.error('OpenAPI drift detected.\n  implemented but undocumented:', undocumented, '\n  documented but not implemented:', unimplemented);
    process.exit(1);
  }
  console.log(`OpenAPI valid; ${documented.size} operations match the implemented routes`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
