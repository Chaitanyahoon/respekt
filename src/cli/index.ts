/**
 * @module cli
 * CLI entry point for respekt.
 *
 * Commands:
 *  - `respekt lock`   — traffic log → locked *.schema.json contracts
 *  - `respekt diff`   — current traffic vs locked schemas → violations
 *  - `respekt report` — summary table of all routes + drift score
 */

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RespektTrafficLog, RespektLockedContract } from '../types.js';
import { fromSerializableShape } from '../types.js';
import { generateZodSchema, generateJsonSchema } from '../schema/infer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routeToFilename(route: string): string {
  return route.replace(/\s+/g, '_').replace(/\//g, '_').replace(/[^a-zA-Z0-9_-]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function readTrafficLog(dir: string): RespektTrafficLog | null {
  const logFile = path.join(dir, '.respekt-traffic.json');
  if (!fs.existsSync(logFile)) return null;
  try { return JSON.parse(fs.readFileSync(logFile, 'utf-8')) as RespektTrafficLog; }
  catch { return null; }
}

function readContracts(dir: string): Map<string, RespektLockedContract> {
  const map = new Map<string, RespektLockedContract>();
  if (!fs.existsSync(dir)) return map;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.schema.json'))) {
    try {
      const contract = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as RespektLockedContract;
      if (contract.route) map.set(contract.route, contract);
    } catch { /* skip */ }
  }
  return map;
}

// ---------------------------------------------------------------------------
// LOCK
// ---------------------------------------------------------------------------

function lockCommand(contractsDir: string): void {
  const log = readTrafficLog(contractsDir);
  if (!log || Object.keys(log.routes).length === 0) {
    console.error('❌ No traffic log found. Run your app with respekt.observe() first.');
    process.exit(1);
  }
  if (!fs.existsSync(contractsDir)) fs.mkdirSync(contractsDir, { recursive: true });

  let count = 0;
  for (const [routeKey, serialised] of Object.entries(log.routes)) {
    const shape = fromSerializableShape(serialised);
    const contract: RespektLockedContract = {
      route: routeKey,
      lockedAt: new Date().toISOString(),
      zodSchema: generateZodSchema(shape),
      jsonSchema: generateJsonSchema(shape),
      shape: serialised,
    };
    const filename = `${routeToFilename(routeKey)}.schema.json`;
    fs.writeFileSync(path.join(contractsDir, filename), JSON.stringify(contract, null, 2), 'utf-8');
    count++;
    console.log(`  🔒 Locked: ${routeKey} → ${filename}`);
  }
  console.log(`\n✅ ${count} contract(s) locked in ${contractsDir}/`);
}

// ---------------------------------------------------------------------------
// DIFF
// ---------------------------------------------------------------------------

function compareSchemas(
  locked: Record<string, unknown>,
  current: Record<string, unknown>,
  prefix: string,
): Array<{ field: string; expected: string; received: string }> {
  const drifts: Array<{ field: string; expected: string; received: string }> = [];
  const lType = locked['type'] as string | undefined;
  const cType = current['type'] as string | undefined;

  if (lType !== cType) {
    drifts.push({ field: prefix || '(root)', expected: lType ?? 'unknown', received: cType ?? 'unknown' });
    return drifts;
  }
  if (lType === 'object') {
    const lProps = (locked['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    const cProps = (current['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    const lReq = new Set((locked['required'] ?? []) as string[]);
    const cReq = new Set((current['required'] ?? []) as string[]);
    for (const key of Object.keys(lProps)) {
      const fp = prefix ? `${prefix}.${key}` : key;
      if (!(key in cProps)) { drifts.push({ field: fp, expected: 'present', received: 'missing (no longer observed)' }); continue; }
      drifts.push(...compareSchemas(lProps[key]!, cProps[key]!, fp));
    }
    for (const key of Object.keys(cProps)) {
      if (!(key in lProps)) drifts.push({ field: prefix ? `${prefix}.${key}` : key, expected: 'absent', received: 'new field appeared' });
    }
    for (const key of lReq) {
      if (!cReq.has(key) && key in cProps) drifts.push({ field: prefix ? `${prefix}.${key}` : key, expected: 'required', received: 'optional' });
    }
  }
  if (lType === 'array') {
    drifts.push(...compareSchemas(
      (locked['items'] ?? {}) as Record<string, unknown>,
      (current['items'] ?? {}) as Record<string, unknown>,
      `${prefix}[]`,
    ));
  }
  return drifts;
}

function diffCommand(contractsDir: string): void {
  const log = readTrafficLog(contractsDir);
  const contracts = readContracts(contractsDir);
  if (contracts.size === 0) { console.error('❌ No locked contracts found. Run `respekt lock` first.'); process.exit(1); }
  if (!log || Object.keys(log.routes).length === 0) { console.warn('⚠ No traffic log found. Nothing to diff.'); return; }

  let total = 0;
  for (const [routeKey, serialised] of Object.entries(log.routes)) {
    const contract = contracts.get(routeKey);
    if (!contract) { console.warn(`  ⚠ No contract for ${routeKey} — skipping`); continue; }
    const currentJson = generateJsonSchema(fromSerializableShape(serialised));
    const drifts = compareSchemas(contract.jsonSchema, currentJson, '');
    if (drifts.length > 0) {
      console.log(`\n  ❌ ${routeKey} — ${drifts.length} violation(s):`);
      for (const d of drifts) console.log(`     • ${d.field}: was ${d.expected}, now ${d.received}`);
      total += drifts.length;
    } else {
      console.log(`  ✅ ${routeKey} — no drift`);
    }
  }
  if (total > 0) { console.log(`\n❌ ${total} total violation(s) found.`); process.exit(1); }
  else { console.log(`\n✅ All contracts match current traffic.`); }
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------

function reportCommand(contractsDir: string): void {
  const log = readTrafficLog(contractsDir);
  const contracts = readContracts(contractsDir);

  console.log('\n📊 respekt — Route Report\n');
  console.log('┌─────────────────────────────────┬─────────┬────────┬──────────┬────────────┐');
  console.log('│ Route                           │ Samples │ Fields │ Locked?  │ Drift      │');
  console.log('├─────────────────────────────────┼─────────┼────────┼──────────┼────────────┤');

  const allRoutes = new Set<string>();
  if (log) for (const r of Object.keys(log.routes)) allRoutes.add(r);
  for (const r of contracts.keys()) allRoutes.add(r);

  for (const routeKey of [...allRoutes].sort()) {
    const traffic = log?.routes[routeKey];
    const contract = contracts.get(routeKey);
    const samples = traffic ? String(traffic.totalSamples) : '-';
    const fields = traffic ? String(Object.keys(traffic.fields).length) : '-';
    const locked = contract ? '✅ Yes' : '❌ No';
    let drift = '-';
    if (contract && traffic) {
      const drifts = compareSchemas(contract.jsonSchema, generateJsonSchema(fromSerializableShape(traffic)), '');
      drift = drifts.length === 0 ? '✅ None' : `⚠ ${drifts.length} issue(s)`;
    }
    const r = routeKey.padEnd(31).slice(0, 31);
    console.log(`│ ${r} │ ${samples.padStart(7)} │ ${fields.padStart(6)} │ ${locked.padEnd(8).slice(0,8)} │ ${drift.padEnd(10).slice(0,10)} │`);
  }
  console.log('└─────────────────────────────────┴─────────┴────────┴──────────┴────────────┘');
  if (allRoutes.size === 0) console.log('\n  No routes found. Run your app with respekt.observe() first.');
  console.log('');
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();
program.name('respekt').description('Your API responses, locked and respected.').version('0.1.0');

program.command('lock').description('Lock observed traffic into *.schema.json contracts')
  .option('-d, --dir <path>', 'contracts directory', './contracts')
  .action((opts: { dir: string }) => lockCommand(opts.dir));

program.command('diff').description('Compare current traffic against locked schemas')
  .option('-d, --dir <path>', 'contracts directory', './contracts')
  .action((opts: { dir: string }) => diffCommand(opts.dir));

program.command('report').description('Summary table of all monitored routes')
  .option('-d, --dir <path>', 'contracts directory', './contracts')
  .action((opts: { dir: string }) => reportCommand(opts.dir));

program.parse();
