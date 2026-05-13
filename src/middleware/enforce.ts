/**
 * @module enforce
 * Express/Fastify-compatible middleware that validates live JSON responses
 * against locked contract schemas produced by `respekt lock`.
 *
 * @example
 * ```ts
 * import respekt from 'respekt';
 * app.use(respekt.enforce({ contractsDir: './contracts', onViolation: 'warn' }));
 * ```
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import micromatch from 'micromatch';
import type {
  RespektEnforceConfig,
  RespektViolationReport,
  RespektLockedContract,
  RespektViolationAction,
} from '../types.js';
import { diffAgainstSchema } from '../schema/diff.js';

// ---------------------------------------------------------------------------
// Contract cache
// ---------------------------------------------------------------------------

const contractCache = new Map<string, RespektLockedContract>();

/**
 * Resets the contract cache. Used in tests.
 * @internal
 */
export function _resetContractCache(): void {
  contractCache.clear();
}

/** Loads all `*.schema.json` files from the contracts dir into memory. */
function loadContracts(contractsDir: string): void {
  if (!fs.existsSync(contractsDir)) return;
  const files = fs.readdirSync(contractsDir).filter((f) => f.endsWith('.schema.json'));
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(contractsDir, file), 'utf-8');
      const contract = JSON.parse(raw) as RespektLockedContract;
      if (contract.route) contractCache.set(contract.route, contract);
    } catch {
      // Skip malformed files
    }
  }
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

function routeKey(method: string, url: string): string {
  const clean = url.split('?')[0]!.split('#')[0]!;
  return `${method.toUpperCase()} ${clean}`;
}

function findContract(key: string): RespektLockedContract | undefined {
  const exact = contractCache.get(key);
  if (exact) return exact;
  for (const [contractRoute, contract] of contractCache) {
    const [cMethod, ...cPathParts] = contractRoute.split(' ');
    const cPath = cPathParts.join(' ');
    const [kMethod, ...kPathParts] = key.split(' ');
    const kPath = kPathParts.join(' ');
    if (cMethod === kMethod && micromatch.isMatch(kPath, [cPath])) return contract;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// RespektViolation error class
// ---------------------------------------------------------------------------

/**
 * Custom error class thrown when `onViolation` is `'throw'`.
 * Extends `Error` with a full {@link RespektViolationReport}.
 */
export class RespektViolation extends Error {
  /** The full violation report. */
  public readonly violation: RespektViolationReport;

  constructor(violation: RespektViolationReport) {
    const summary = violation.violations
      .map((v) => `  ${v.field}: expected ${v.expected}, got ${v.received}`)
      .join('\n');
    super(`RespektViolation on ${violation.route}:\n${summary}`);
    this.name = 'RespektViolation';
    this.violation = violation;
  }
}

function handleViolation(violation: RespektViolationReport, action: RespektViolationAction): void {
  switch (action) {
    case 'throw': throw new RespektViolation(violation);
    case 'warn':
      console.warn(`[respekt] ⚠ Contract violation on ${violation.route}:`, JSON.stringify(violation.violations, null, 2));
      break;
    case 'log':
      console.log(`[respekt] Contract violation on ${violation.route}:`, JSON.stringify(violation.violations, null, 2));
      break;
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an enforce middleware that validates live JSON responses
 * against locked contract schemas.
 *
 * Works with **Express 4+**, **Express 5**, and **Fastify 4+**.
 *
 * @param config - Enforcement configuration.
 * @returns A standard `(req, res, next)` middleware function.
 */
export function enforce(config: RespektEnforceConfig = {}): (req: any, res: any, next: any) => void {
  const { contractsDir = './contracts', onViolation = 'warn', strict = false } = config;

  loadContracts(contractsDir);

  return function respektEnforce(req: any, res: any, next: any): void {
    const url: string = req.originalUrl ?? req.url ?? '';
    const method: string = req.method ?? 'GET';
    const key = routeKey(method, url);

    const contract = findContract(key);
    if (!contract) { next(); return; }

    const originalJson = res.json?.bind(res);
    if (typeof originalJson === 'function') {
      res.json = function interceptedJson(body: unknown): any {
        if (body !== null && body !== undefined && typeof body === 'object') {
          try {
            const violations = diffAgainstSchema(body, contract.jsonSchema, strict);
            if (violations.length > 0) {
              handleViolation({ route: key, violatedAt: new Date().toISOString(), violations }, onViolation);
            }
          } catch (err) {
            if (err instanceof RespektViolation) throw err;
            // Other errors — don't break the pipeline
          }
        }
        return originalJson(body);
      };
    }
    next();
  };
}
