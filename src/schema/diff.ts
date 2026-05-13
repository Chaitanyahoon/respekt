/**
 * @module diff
 * Compares a live JSON response body against a locked JSON Schema contract
 * and returns structured {@link RespektFieldViolation} objects.
 */

import type { RespektFieldViolation } from '../types.js';

type JsonSchemaNode = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeType(node: JsonSchemaNode): string {
  if ('anyOf' in node) return (node['anyOf'] as JsonSchemaNode[]).map(describeType).join(' | ');
  if ('oneOf' in node) return (node['oneOf'] as JsonSchemaNode[]).map(describeType).join(' | ');
  const fmt = node['format'];
  if (typeof node['type'] === 'string') return fmt ? `${node['type']}(${fmt})` : node['type'];
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Core diff
// ---------------------------------------------------------------------------

/**
 * Recursively walks a JSON value against a JSON Schema node and collects violations.
 *
 * @param value      - Live JSON value to check.
 * @param schema     - JSON Schema node to check against.
 * @param path       - Dot-path prefix for reporting.
 * @param violations - Accumulator.
 * @param strict     - Extra keys count as violations if true.
 */
export function diffValueAgainstSchema(
  value: unknown,
  schema: JsonSchemaNode,
  path: string,
  violations: RespektFieldViolation[],
  strict: boolean,
): void {
  // anyOf — nullable support
  if ('anyOf' in schema) {
    const branches = schema['anyOf'] as JsonSchemaNode[];
    const branchV: RespektFieldViolation[][] = branches.map(() => []);
    for (let i = 0; i < branches.length; i++) {
      diffValueAgainstSchema(value, branches[i]!, path, branchV[i]!, strict);
    }
    if (!branchV.some((v) => v.length === 0)) {
      violations.push({ field: path || '(root)', expected: describeType(schema), received: jsonType(value) });
    }
    return;
  }

  // oneOf — union of non-null types
  if ('oneOf' in schema) {
    const anyMatch = (schema['oneOf'] as JsonSchemaNode[]).some((branch) => {
      const tmp: RespektFieldViolation[] = [];
      diffValueAgainstSchema(value, branch, path, tmp, strict);
      return tmp.length === 0;
    });
    if (!anyMatch) {
      violations.push({ field: path || '(root)', expected: describeType(schema), received: jsonType(value) });
    }
    return;
  }

  const expectedType = schema['type'] as string | undefined;

  // Object
  if (expectedType === 'object') {
    if (jsonType(value) !== 'object') {
      violations.push({ field: path || '(root)', expected: 'object', received: jsonType(value) });
      return;
    }
    const obj = value as Record<string, unknown>;
    const properties = (schema['properties'] ?? {}) as Record<string, JsonSchemaNode>;
    const required = (schema['required'] ?? []) as string[];

    for (const key of required) {
      if (!(key in obj)) {
        violations.push({ field: path ? `${path}.${key}` : key, expected: 'present', received: 'missing' });
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in obj)) {
        if (childSchema['x-optional'] !== true) {
          violations.push({ field: path ? `${path}.${key}` : key, expected: 'present', received: 'missing' });
        }
        continue;
      }
      diffValueAgainstSchema(obj[key], childSchema, path ? `${path}.${key}` : key, violations, strict);
    }
    if (strict) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          violations.push({ field: path ? `${path}.${key}` : key, expected: 'absent (strict mode)', received: 'present' });
        }
      }
    }
    return;
  }

  // Array
  if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      violations.push({ field: path || '(root)', expected: 'array', received: jsonType(value) });
      return;
    }
    const itemSchema = schema['items'] as JsonSchemaNode | undefined;
    if (itemSchema && Object.keys(itemSchema).length > 0) {
      value.forEach((item, idx) => {
        diffValueAgainstSchema(item, itemSchema, `${path}[${idx}]`, violations, strict);
      });
    }
    return;
  }

  // Primitive
  if (expectedType !== undefined) {
    const normalise = (t: string) => (t === 'integer' ? 'number' : t);
    if (normalise(jsonType(value)) !== normalise(expectedType)) {
      violations.push({ field: path || '(root)', expected: describeType(schema), received: jsonType(value) });
      return;
    }
    // date-time format check
    if (expectedType === 'string' && schema['format'] === 'date-time' && typeof value === 'string') {
      const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
      if (!ISO_RE.test(value)) {
        violations.push({ field: path || '(root)', expected: 'string(date-time)', received: 'string (non-datetime)' });
      }
    }
  }
}

/**
 * Compares a live response body against a locked JSON Schema contract.
 *
 * @param body   - The live JSON response body.
 * @param schema - The locked JSON Schema from `*.schema.json`.
 * @param strict - Whether extra keys count as violations.
 * @returns Array of violations. Empty means no drift.
 */
export function diffAgainstSchema(
  body: unknown,
  schema: JsonSchemaNode,
  strict = false,
): RespektFieldViolation[] {
  const violations: RespektFieldViolation[] = [];
  diffValueAgainstSchema(body, schema, '', violations, strict);
  return violations;
}
