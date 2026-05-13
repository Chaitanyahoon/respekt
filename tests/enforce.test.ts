/**
 * Tests for src/middleware/enforce.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { enforce, RespektViolation, _resetContractCache } from '../src/middleware/enforce.js';
import type { RespektLockedContract } from '../src/types.js';

function mockReq(method: string, url: string): any {
  return { method, url, originalUrl: url };
}
function mockRes(): any {
  const res: any = { _body: undefined as unknown, json(body: unknown) { res._body = body; return res; } };
  return res;
}
function noop() {}

const tmpDir = path.join(process.cwd(), 'tests', '.tmp-enforce');

function writeContract(contract: RespektLockedContract): void {
  const safeName = contract.route.replace(/[^a-zA-Z0-9]/g, '_');
  fs.writeFileSync(path.join(tmpDir, `${safeName}.schema.json`), JSON.stringify(contract, null, 2), 'utf-8');
}

function makeContract(overrides: Partial<RespektLockedContract> = {}): RespektLockedContract {
  return {
    route: 'GET /api/users',
    lockedAt: new Date().toISOString(),
    zodSchema: '',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'number' }, name: { type: 'string' } },
      required: ['id', 'name'],
    },
    shape: { route: 'GET /api/users', totalSamples: 10, fields: {} },
    ...overrides,
  };
}

beforeEach(() => {
  _resetContractCache();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});
afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
});

describe('enforce middleware', () => {
  it('calls next() for every request', () => {
    writeContract(makeContract());
    const mw = enforce({ contractsDir: tmpDir });
    const nextSpy = vi.fn();
    mw(mockReq('GET', '/api/users'), mockRes(), nextSpy);
    expect(nextSpy).toHaveBeenCalledTimes(1);
  });

  it('passes through when response matches the contract', () => {
    writeContract(makeContract());
    const mw = enforce({ contractsDir: tmpDir, onViolation: 'throw' });
    const res = mockRes();
    mw(mockReq('GET', '/api/users'), res, noop);
    expect(() => res.json({ id: 1, name: 'Alice' })).not.toThrow();
  });

  it('throws RespektViolation when response drifts (onViolation: throw)', () => {
    writeContract(makeContract());
    const mw = enforce({ contractsDir: tmpDir, onViolation: 'throw' });
    const res = mockRes();
    mw(mockReq('GET', '/api/users'), res, noop);
    expect(() => res.json({ id: 'bad', name: 'Alice' })).toThrow(RespektViolation);
  });

  it('warns without throwing (onViolation: warn)', () => {
    writeContract(makeContract());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mw = enforce({ contractsDir: tmpDir, onViolation: 'warn' });
    const res = mockRes();
    mw(mockReq('GET', '/api/users'), res, noop);
    expect(() => res.json({ id: 'bad', name: 'Alice' })).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs without throwing (onViolation: log)', () => {
    writeContract(makeContract());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mw = enforce({ contractsDir: tmpDir, onViolation: 'log' });
    const res = mockRes();
    mw(mockReq('GET', '/api/users'), res, noop);
    expect(() => res.json({ id: 'bad', name: 'Alice' })).not.toThrow();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('detects missing required fields', () => {
    writeContract(makeContract());
    const mw = enforce({ contractsDir: tmpDir, onViolation: 'throw' });
    const res = mockRes();
    mw(mockReq('GET', '/api/users'), res, noop);
    try {
      res.json({ id: 1 });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RespektViolation);
      expect((err as RespektViolation).violation.violations).toContainEqual(
        expect.objectContaining({ field: 'name', expected: 'present', received: 'missing' }),
      );
    }
  });

  it('detects extra keys in strict mode', () => {
    writeContract(makeContract());
    const mw = enforce({ contractsDir: tmpDir, onViolation: 'throw', strict: true });
    const res = mockRes();
    mw(mockReq('GET', '/api/users'), res, noop);
    try {
      res.json({ id: 1, name: 'Alice', extra: true });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RespektViolation);
      expect((err as RespektViolation).violation.violations).toContainEqual(
        expect.objectContaining({ field: 'extra', expected: 'absent (strict mode)', received: 'present' }),
      );
    }
  });

  it('allows extra keys in non-strict mode', () => {
    writeContract(makeContract());
    const mw = enforce({ contractsDir: tmpDir, onViolation: 'throw', strict: false });
    const res = mockRes();
    mw(mockReq('GET', '/api/users'), res, noop);
    expect(() => res.json({ id: 1, name: 'Alice', bonus: true })).not.toThrow();
  });

  it('passes through for routes with no contract', () => {
    writeContract(makeContract());
    const mw = enforce({ contractsDir: tmpDir, onViolation: 'throw' });
    const res = mockRes();
    mw(mockReq('GET', '/other/route'), res, noop);
    expect(() => res.json({ anything: 'goes' })).not.toThrow();
  });

  it('handles requests where res.json does not exist', () => {
    writeContract(makeContract());
    const mw = enforce({ contractsDir: tmpDir });
    const nextSpy = vi.fn();
    expect(() => mw(mockReq('GET', '/api/users'), {}, nextSpy)).not.toThrow();
    expect(nextSpy).toHaveBeenCalledTimes(1);
  });

  it('still returns the original body from res.json()', () => {
    writeContract(makeContract());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mw = enforce({ contractsDir: tmpDir, onViolation: 'log' });
    const res = mockRes();
    mw(mockReq('GET', '/api/users'), res, noop);
    res.json({ id: 1, name: 'Bob' });
    expect(res._body).toEqual({ id: 1, name: 'Bob' });
    logSpy.mockRestore();
  });
});
