/**
 * Tests for src/schema/infer.ts — 40 tests covering all spec edge cases:
 *  - Nullable fields (string | null)
 *  - Optional keys (missing in some samples)
 *  - Arrays (element type inference)
 *  - Nested objects (recursive inference)
 *  - Empty arrays (z.unknown())
 *  - Date strings (ISO 8601 → z.string().datetime())
 *  - Mixed types (z.union([...]))
 */

import { describe, it, expect } from 'vitest';
import {
  createObservedShape,
  observeBody,
  generateZodSchema,
  generateJsonSchema,
  isDatetimeString,
  getPrimitiveType,
  mergeValueIntoField,
  fieldToZod,
} from '../src/schema/infer.js';
import type { RespektFieldShape, RespektObservedShape } from '../src/types.js';

// Helpers
function makeShape(route = 'GET /api/test'): RespektObservedShape {
  return createObservedShape(route);
}
function observeAll(shape: RespektObservedShape, bodies: unknown[]): void {
  for (const body of bodies) observeBody(shape, body);
}

// ---------------------------------------------------------------------------
// isDatetimeString (6 tests)
// ---------------------------------------------------------------------------
describe('isDatetimeString', () => {
  it('accepts a UTC datetime', () => {
    expect(isDatetimeString('2026-05-13T10:22:00Z')).toBe(true);
  });
  it('accepts a datetime with milliseconds', () => {
    expect(isDatetimeString('2026-05-13T10:22:00.123Z')).toBe(true);
  });
  it('accepts a datetime with timezone offset', () => {
    expect(isDatetimeString('2026-05-13T10:22:00+05:30')).toBe(true);
  });
  it('rejects a plain date string', () => {
    expect(isDatetimeString('2026-05-13')).toBe(false);
  });
  it('rejects a plain string', () => {
    expect(isDatetimeString('hello')).toBe(false);
  });
  it('rejects an empty string', () => {
    expect(isDatetimeString('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPrimitiveType (7 tests)
// ---------------------------------------------------------------------------
describe('getPrimitiveType', () => {
  it('detects null', () => expect(getPrimitiveType(null)).toBe('null'));
  it('detects boolean', () => expect(getPrimitiveType(true)).toBe('boolean'));
  it('detects number', () => expect(getPrimitiveType(42)).toBe('number'));
  it('detects string', () => expect(getPrimitiveType('hello')).toBe('string'));
  it('detects datetime string', () =>
    expect(getPrimitiveType('2026-05-13T10:22:00Z')).toBe('datetime'));
  it('returns null for object', () => expect(getPrimitiveType({})).toBeNull());
  it('returns null for array', () => expect(getPrimitiveType([])).toBeNull());
});

// ---------------------------------------------------------------------------
// observeBody — non-object root (2 tests)
// ---------------------------------------------------------------------------
describe('observeBody — non-object root', () => {
  it('silently skips null root', () => {
    const shape = makeShape();
    observeBody(shape, null);
    expect(shape.totalSamples).toBe(0);
    expect(shape.fields).toEqual({});
  });
  it('silently skips primitive root', () => {
    const shape = makeShape();
    observeBody(shape, 'just a string');
    expect(shape.fields).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Nullable fields (2 tests)
// ---------------------------------------------------------------------------
describe('Nullable fields', () => {
  it('marks a field as nullable when null is observed alongside another type', () => {
    const shape = makeShape();
    observeAll(shape, [
      { name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' },
      { name: 'Dave' }, { name: 'Eve' }, { name: 'Frank' },
      { name: 'Grace' }, { name: 'Heidi' }, { name: 'Ivan' },
      { name: null },
    ]);
    const zod = generateZodSchema(shape);
    expect(zod).toContain('z.string().nullable()');
  });
  it('generates anyOf with null in JSON schema', () => {
    const shape = makeShape();
    observeAll(shape, [{ age: 30 }, { age: null }]);
    const json = generateJsonSchema(shape);
    const ageProp = (json['properties'] as Record<string, unknown>)['age'] as Record<string, unknown>;
    expect(ageProp).toHaveProperty('anyOf');
  });
});

// ---------------------------------------------------------------------------
// Optional keys (2 tests)
// ---------------------------------------------------------------------------
describe('Optional keys', () => {
  it('marks a key as optional when absent in some samples', () => {
    const shape = makeShape();
    observeAll(shape, [{ id: 1, role: 'admin' }, { id: 2 }, { id: 3 }]);
    const zod = generateZodSchema(shape);
    expect(zod).toContain('"role":');
    expect(zod).toContain('.optional()');
    expect(zod).toMatch(/"id": z\.number\(\)[^.]/);
  });
  it('tracks seenCount correctly', () => {
    const shape = makeShape();
    observeAll(shape, [{ x: 1 }, { x: 2 }, {}]);
    expect(shape.fields['x']!.seenCount).toBe(2);
    expect(shape.totalSamples).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Arrays (4 tests)
// ---------------------------------------------------------------------------
describe('Arrays', () => {
  it('infers element type for a string array', () => {
    const shape = makeShape();
    observeAll(shape, [{ tags: ['a', 'b', 'c'] }, { tags: ['x', 'y'] }]);
    expect(generateZodSchema(shape)).toContain('z.array(z.string())');
  });
  it('infers element type for a number array', () => {
    const shape = makeShape();
    observeAll(shape, [{ scores: [1, 2, 3] }]);
    expect(generateZodSchema(shape)).toContain('z.array(z.number())');
  });
  it('infers mixed-type array elements as a union', () => {
    const shape = makeShape();
    observeAll(shape, [{ vals: [1, 'two', 3] }]);
    const zod = generateZodSchema(shape);
    expect(zod).toContain('z.array(');
    expect(zod).toContain('z.union(');
  });
  it('handles root-level array bodies', () => {
    const shape = makeShape();
    observeAll(shape, [[{ id: 1 }, { id: 2 }]]);
    expect(shape.isArray).toBe(true);
    expect(generateZodSchema(shape)).toContain('z.array(');
  });
});

// ---------------------------------------------------------------------------
// Empty arrays (2 tests)
// ---------------------------------------------------------------------------
describe('Empty arrays', () => {
  it('marks element type as z.unknown() for an empty array', () => {
    const shape = makeShape();
    observeAll(shape, [{ items: [] }]);
    const zod = generateZodSchema(shape);
    expect(zod).toContain('z.array(z.unknown()');
    expect(zod).toContain('empty array');
  });
  it('resolves to typed array once a non-empty array is later observed', () => {
    const shape = makeShape();
    observeAll(shape, [{ items: [] }, { items: [1, 2, 3] }]);
    const zod = generateZodSchema(shape);
    expect(zod).toContain('z.array(z.number())');
    expect(zod).not.toContain('empty array');
  });
});

// ---------------------------------------------------------------------------
// Nested objects (2 tests)
// ---------------------------------------------------------------------------
describe('Nested objects', () => {
  it('recursively infers nested object shapes', () => {
    const shape = makeShape();
    observeAll(shape, [
      { user: { id: 1, name: 'Alice', active: true } },
      { user: { id: 2, name: 'Bob', active: false } },
    ]);
    const zod = generateZodSchema(shape);
    expect(zod).toContain('"user": z.object(');
    expect(zod).toContain('"id": z.number()');
    expect(zod).toContain('"name": z.string()');
    expect(zod).toContain('"active": z.boolean()');
  });
  it('marks nested key as optional when missing in some samples', () => {
    const shape = makeShape();
    observeAll(shape, [
      { user: { id: 1, email: 'a@b.com' } },
      { user: { id: 2 } },
    ]);
    const zod = generateZodSchema(shape);
    expect(zod).toContain('"email":');
    expect(zod).toContain('.optional()');
  });
});

// ---------------------------------------------------------------------------
// Date strings (3 tests)
// ---------------------------------------------------------------------------
describe('Date strings', () => {
  it('marks ISO 8601 strings as z.string().datetime()', () => {
    const shape = makeShape();
    observeAll(shape, [
      { createdAt: '2026-05-13T10:22:00Z' },
      { createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(generateZodSchema(shape)).toContain('z.string().datetime()');
  });
  it('uses plain z.string() for non-datetime strings', () => {
    const shape = makeShape();
    observeAll(shape, [{ name: 'Alice' }, { name: 'Bob' }]);
    const zod = generateZodSchema(shape);
    expect(zod).toContain('"name": z.string()');
    expect(zod).not.toContain('datetime');
  });
  it('marks datetime as nullable when null also observed', () => {
    const shape = makeShape();
    observeAll(shape, [{ deletedAt: '2026-05-13T10:22:00Z' }, { deletedAt: null }]);
    expect(generateZodSchema(shape)).toContain('z.string().datetime().nullable()');
  });
});

// ---------------------------------------------------------------------------
// generateZodSchema output format (2 tests)
// ---------------------------------------------------------------------------
describe('generateZodSchema output format', () => {
  it('includes import and export statements', () => {
    const shape = makeShape();
    observeAll(shape, [{ id: 1 }]);
    const zod = generateZodSchema(shape);
    expect(zod).toContain("import { z } from 'zod'");
    expect(zod).toContain('export const schema =');
    expect(zod).toContain('export type Schema =');
  });
  it('includes the route and sample count in a comment', () => {
    const shape = makeShape('GET /api/users');
    observeAll(shape, [{ id: 1 }, { id: 2 }]);
    const zod = generateZodSchema(shape);
    expect(zod).toContain('Route: GET /api/users');
    expect(zod).toContain('Samples: 2');
  });
});

// ---------------------------------------------------------------------------
// generateJsonSchema (3 tests)
// ---------------------------------------------------------------------------
describe('generateJsonSchema', () => {
  it('produces a valid JSON Schema envelope', () => {
    const shape = makeShape('GET /api/items');
    observeAll(shape, [{ id: 1, label: 'x' }]);
    const json = generateJsonSchema(shape);
    expect(json['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    expect(json['title']).toBe('GET /api/items');
    expect(json['type']).toBe('object');
    expect(json['x-generator']).toBe('respekt');
  });
  it('lists always-present fields in required array', () => {
    const shape = makeShape();
    observeAll(shape, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect((json(shape)['required'] as string[])).toContain('id');
  });
  it('omits optional fields from required array', () => {
    const shape = makeShape();
    observeAll(shape, [{ id: 1, extra: 'x' }, { id: 2 }]);
    const j = json(shape);
    expect((j['required'] as string[])).toContain('id');
    expect((j['required'] as string[])).not.toContain('extra');
  });
});
function json(shape: RespektObservedShape) { return generateJsonSchema(shape); }

// ---------------------------------------------------------------------------
// mergeValueIntoField (3 tests)
// ---------------------------------------------------------------------------
describe('mergeValueIntoField', () => {
  it('accumulates multiple primitive types', () => {
    const field: RespektFieldShape = { types: new Set(), seenCount: 2 };
    mergeValueIntoField(field, 'hello');
    mergeValueIntoField(field, 42);
    expect(field.types.has('string')).toBe(true);
    expect(field.types.has('number')).toBe(true);
  });
  it('creates children for nested objects', () => {
    const field: RespektFieldShape = { types: new Set(), seenCount: 1 };
    mergeValueIntoField(field, { x: 1 });
    expect(field.children).toBeDefined();
    expect(field.children!['x']).toBeDefined();
  });
  it('handles deeply nested objects', () => {
    const field: RespektFieldShape = { types: new Set(), seenCount: 1 };
    mergeValueIntoField(field, { a: { b: { c: true } } });
    const c = field.children!['a']!.children!['b']!.children!['c']!;
    expect(c.types.has('boolean')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fieldToZod (2 tests)
// ---------------------------------------------------------------------------
describe('fieldToZod', () => {
  it('returns z.unknown() for a field with no types and no children', () => {
    const field: RespektFieldShape = { types: new Set(), seenCount: 3 };
    expect(fieldToZod(field, 3)).toBe('z.unknown()');
  });
  it('returns z.unknown().optional() when seenCount < totalSamples', () => {
    const field: RespektFieldShape = { types: new Set(), seenCount: 1 };
    expect(fieldToZod(field, 3)).toBe('z.unknown().optional()');
  });
});
