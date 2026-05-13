/**
 * @module observe
 * Express/Fastify-compatible middleware that intercepts `res.json()` calls,
 * records the response shape, and persists observations to a traffic log.
 *
 * @example
 * ```ts
 * import respekt from 'respekt';
 * app.use(respekt.observe({ routes: ['/api/*'], sampleSize: 50 }));
 * ```
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import micromatch from 'micromatch';
import type {
  RespektObserveConfig,
  RespektObservedShape,
  RespektTrafficLog,
  RespektSerializableShape,
} from '../types.js';
import { toSerializableShape, fromSerializableShape } from '../types.js';
import { createObservedShape, observeBody } from '../schema/infer.js';

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const shapeStore = new Map<string, RespektObservedShape>();

/**
 * Returns the current in-memory shape store. Exposed for testing only.
 * @internal
 */
export function _getShapeStore(): Map<string, RespektObservedShape> {
  return shapeStore;
}

/**
 * Resets the in-memory store. Used in tests.
 * @internal
 */
export function _resetShapeStore(): void {
  shapeStore.clear();
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

function trafficLogPath(outputDir: string): string {
  return path.join(outputDir, '.respekt-traffic.json');
}

/** Loads existing traffic log from disk to resume observations across restarts. */
function loadExistingLog(outputDir: string): void {
  const logFile = trafficLogPath(outputDir);
  if (!fs.existsSync(logFile)) return;
  try {
    const raw = fs.readFileSync(logFile, 'utf-8');
    const log = JSON.parse(raw) as RespektTrafficLog;
    for (const [routeKey, serialised] of Object.entries(log.routes)) {
      if (!shapeStore.has(routeKey)) {
        shapeStore.set(routeKey, fromSerializableShape(serialised));
      }
    }
  } catch {
    // Corrupted log — start fresh
  }
}

/** Persists store to disk atomically (write-to-tmp + rename). */
function flushToDisk(outputDir: string): void {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const routes: Record<string, RespektSerializableShape> = {};
  for (const [key, shape] of shapeStore) {
    routes[key] = toSerializableShape(shape);
  }
  const log: RespektTrafficLog = { updatedAt: new Date().toISOString(), routes };
  const logFile = trafficLogPath(outputDir);
  const tmpFile = `${logFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(log, null, 2), 'utf-8');
  fs.renameSync(tmpFile, logFile);
}

// ---------------------------------------------------------------------------
// Debounced flush
// ---------------------------------------------------------------------------

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(outputDir: string): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToDisk(outputDir);
  }, 2_000);
  if (flushTimer && typeof flushTimer === 'object' && 'unref' in flushTimer) {
    flushTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

function routeKey(method: string, url: string): string {
  const clean = url.split('?')[0]!.split('#')[0]!;
  return `${method.toUpperCase()} ${clean}`;
}

function matchesRoutes(url: string, patterns: string[]): boolean {
  const cleanUrl = url.split('?')[0]!.split('#')[0]!;
  return micromatch.isMatch(cleanUrl, patterns);
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an observe middleware that intercepts JSON responses and records
 * their shapes for later schema inference.
 *
 * Works with **Express 4+**, **Express 5**, and **Fastify 4+** (via `@fastify/middie`).
 *
 * @param config - Observation configuration.
 * @returns A standard `(req, res, next)` middleware function.
 */
export function observe(config: RespektObserveConfig): (req: any, res: any, next: any) => void {
  const { routes, sampleSize = 50, outputDir = './contracts' } = config;

  loadExistingLog(outputDir);

  return function respektObserve(req: any, res: any, next: any): void {
    const url: string = req.originalUrl ?? req.url ?? '';
    const method: string = req.method ?? 'GET';

    if (!matchesRoutes(url, routes)) {
      next();
      return;
    }

    const key = routeKey(method, url);

    // Already collected enough samples for this route
    const existing = shapeStore.get(key);
    if (existing && existing.totalSamples >= sampleSize) {
      next();
      return;
    }

    // Intercept res.json()
    const originalJson = res.json?.bind(res);
    if (typeof originalJson === 'function') {
      res.json = function interceptedJson(body: unknown): any {
        // Only observe objects and arrays — skip primitives silently
        if (body !== null && body !== undefined && typeof body === 'object') {
          try {
            let shape = shapeStore.get(key);
            if (!shape) {
              shape = createObservedShape(key);
              shapeStore.set(key, shape);
            }
            observeBody(shape, body);
            scheduleFlush(outputDir);
          } catch {
            // Never break the response pipeline
          }
        }
        return originalJson(body);
      };
    }

    next();
  };
}
