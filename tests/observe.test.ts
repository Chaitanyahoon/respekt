/**
 * Tests for src/middleware/observe.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { observe, _getShapeStore, _resetShapeStore } from '../src/middleware/observe.js';

// Minimal Express-like req/res/next mocks
function mockReq(method: string, url: string): any {
  return { method, url, originalUrl: url };
}
function mockRes(): any {
  const res: any = {
    _body: undefined as unknown,
    json(body: unknown) { res._body = body; return res; },
  };
  return res;
}
function noop() {}

const tmpDir = path.join(process.cwd(), 'tests', '.tmp-observe');

beforeEach(() => {
  _resetShapeStore();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
});
afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
});

describe('observe middleware', () => {
  it('calls next() for every request', () => {
    const mw = observe({ routes: ['/api/*'], outputDir: tmpDir });
    const nextSpy = vi.fn();
    mw(mockReq('GET', '/api/users'), mockRes(), nextSpy);
    expect(nextSpy).toHaveBeenCalledTimes(1);
  });

  it('records a shape when res.json() is called on a matching route', () => {
    const mw = observe({ routes: ['/api/*'], outputDir: tmpDir });
    const res = mockRes();
    mw(mockReq('GET', '/api/users'), res, noop);
    res.json({ id: 1, name: 'Alice' });
    const store = _getShapeStore();
    expect(store.has('GET /api/users')).toBe(true);
    expect(store.get('GET /api/users')!.totalSamples).toBe(1);
  });

  it('does NOT record shapes for non-matching routes', () => {
    const mw = observe({ routes: ['/api/*'], outputDir: tmpDir });
    const res = mockRes();
    mw(mockReq('GET', '/health'), res, noop);
    res.json({ status: 'ok' });
    expect(_getShapeStore().size).toBe(0);
  });

  it('does NOT break when res.json() receives a primitive', () => {
    const mw = observe({ routes: ['/api/*'], outputDir: tmpDir });
    const res = mockRes();
    mw(mockReq('GET', '/api/ping'), res, noop);
    expect(() => res.json('pong')).not.toThrow();
    expect(() => res.json(42)).not.toThrow();
    expect(() => res.json(null)).not.toThrow();
    expect(_getShapeStore().size).toBe(0);
  });

  it('still returns the original body from res.json()', () => {
    const mw = observe({ routes: ['/api/*'], outputDir: tmpDir });
    const res = mockRes();
    mw(mockReq('GET', '/api/users'), res, noop);
    res.json({ id: 1 });
    expect(res._body).toEqual({ id: 1 });
  });

  it('stops observing after sampleSize is reached', () => {
    const mw = observe({ routes: ['/api/*'], sampleSize: 3, outputDir: tmpDir });
    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      mw(mockReq('GET', '/api/users'), res, noop);
      res.json({ id: i });
    }
    expect(_getShapeStore().get('GET /api/users')!.totalSamples).toBe(3);
  });

  it('strips query strings from the route key', () => {
    const mw = observe({ routes: ['/api/*'], outputDir: tmpDir });
    const res = mockRes();
    mw(mockReq('GET', '/api/users?page=1&limit=10'), res, noop);
    res.json({ id: 1 });
    expect(_getShapeStore().has('GET /api/users')).toBe(true);
  });

  it('handles requests where res.json does not exist', () => {
    const mw = observe({ routes: ['/api/*'], outputDir: tmpDir });
    const nextSpy = vi.fn();
    expect(() => mw(mockReq('GET', '/api/data'), {}, nextSpy)).not.toThrow();
    expect(nextSpy).toHaveBeenCalledTimes(1);
  });
});
