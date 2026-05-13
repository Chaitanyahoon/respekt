/**
 * @module infer
 * Core algorithm: infers JSON shapes from observed API response bodies
 * and generates Zod schema strings + JSON Schema objects from those shapes.
 */

import type {
  RespektFieldShape,
  RespektObservedShape,
  RespektPrimitiveType,
  RespektSerializableShape,
} from '../types.js';
import { fromSerializableShape } from '../types.js';

// ---------------------------------------------------------------------------
// ISO 8601 detection
// ---------------------------------------------------------------------------

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Returns `true` if the string matches an ISO 8601 datetime pattern.
 * @param value - String to test.
 */
export function isDatetimeString(value: string): boolean {
  return ISO_8601_RE.test(value);
}

// ---------------------------------------------------------------------------
// Primitive type detection
// ---------------------------------------------------------------------------

/**
 * Determines the {@link RespektPrimitiveType} of a scalar JSON value.
 * Strings matching ISO 8601 are classified as `'datetime'`.
 * Returns `null` for objects and arrays.
 *
 * @param value - The raw JSON value.
 */
export function getPrimitiveType(value: unknown): RespektPrimitiveType | null {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return isDatetimeString(value) ? 'datetime' : 'string';
  return null;
}

// ---------------------------------------------------------------------------
// FieldShape helpers
// ---------------------------------------------------------------------------

function emptyField(): RespektFieldShape {
  return { types: new Set(), seenCount: 0 };
}

/**
 * Merges one observed JSON value into an existing {@link RespektFieldShape}.
 * Mutates `field` in-place.
 *
 * @param field - Shape descriptor to update.
 * @param value - Raw JSON value for this field.
 */
export function mergeValueIntoField(field: RespektFieldShape, value: unknown): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      field.emptyArray = true;
    } else {
      if (!field.arrayElement) field.arrayElement = emptyField();
      for (const item of value) {
        field.arrayElement.seenCount += 1;
        mergeValueIntoField(field.arrayElement, item);
      }
      field.emptyArray = false;
    }
  } else if (value !== null && typeof value === 'object') {
    if (!field.children) field.children = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!(k in field.children)) field.children[k] = emptyField();
      field.children[k]!.seenCount += 1;
      mergeValueIntoField(field.children[k]!, v);
    }
  } else {
    const prim = getPrimitiveType(value);
    if (prim !== null) field.types.add(prim);
  }
}

// ---------------------------------------------------------------------------
// Top-level observation
// ---------------------------------------------------------------------------

/**
 * Creates a fresh {@link RespektObservedShape} for the given route key.
 * @param route - Route key, e.g. `'GET /api/users'`.
 */
export function createObservedShape(route: string): RespektObservedShape {
  return { route, totalSamples: 0, fields: {} };
}

/**
 * Records a single JSON response body into a {@link RespektObservedShape}.
 * Mutates `shape` in-place. Silently skips primitives/null/undefined at root.
 *
 * @param shape - The accumulated shape for this route.
 * @param body  - The raw parsed JSON body to observe.
 */
export function observeBody(shape: RespektObservedShape, body: unknown): void {
  if (body === null || body === undefined) return;
  shape.totalSamples += 1;

  if (Array.isArray(body)) {
    shape.isArray = true;
    if (!shape.arrayElement) shape.arrayElement = emptyField();
    for (const item of body) {
      shape.arrayElement.seenCount += 1;
      mergeValueIntoField(shape.arrayElement, item);
    }
  } else if (typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (!(k in shape.fields)) shape.fields[k] = emptyField();
      shape.fields[k]!.seenCount += 1;
      mergeValueIntoField(shape.fields[k]!, v);
    }
  }
}

// ---------------------------------------------------------------------------
// Zod schema codegen
// ---------------------------------------------------------------------------

function zodPrimitive(types: Set<RespektPrimitiveType>, isOptional: boolean): string {
  const hasNull = types.has('null');
  const nonNull = [...types].filter((t) => t !== 'null');

  let base: string;
  if (nonNull.length === 0) {
    base = 'z.null()';
  } else if (nonNull.length === 1) {
    const t = nonNull[0]!;
    base =
      t === 'datetime' ? 'z.string().datetime()' :
      t === 'string'   ? 'z.string()' :
      t === 'number'   ? 'z.number()' :
                         'z.boolean()';
  } else {
    const members = nonNull.map((t) =>
      t === 'datetime' ? 'z.string().datetime()' :
      t === 'string'   ? 'z.string()' :
      t === 'number'   ? 'z.number()' :
                         'z.boolean()',
    );
    base = `z.union([${members.join(', ')}])`;
  }

  if (hasNull) base = `${base}.nullable()`;
  if (isOptional) base = `${base}.optional()`;
  return base;
}

/**
 * Recursively generates a Zod schema expression for a {@link RespektFieldShape}.
 *
 * @param field        - The shape descriptor.
 * @param totalSamples - Parent-level sample count for optionality check.
 * @param indent       - Current indentation level.
 */
export function fieldToZod(
  field: RespektFieldShape,
  totalSamples: number,
  indent = 1,
): string {
  const pad = '  '.repeat(indent);
  const isOptional = field.seenCount < totalSamples;

  // Array
  if (field.arrayElement !== undefined || field.emptyArray) {
    const elementExpr =
      field.emptyArray && !field.arrayElement
        ? 'z.unknown() /* empty array observed */'
        : fieldToZod(field.arrayElement!, field.arrayElement!.seenCount, indent);
    let expr = `z.array(${elementExpr})`;
    if (isOptional) expr += '.optional()';
    return expr;
  }

  // Object
  if (field.children && Object.keys(field.children).length > 0) {
    const entries = Object.entries(field.children)
      .map(([k, child]) => `${pad}  ${JSON.stringify(k)}: ${fieldToZod(child, field.seenCount, indent + 1)}`)
      .join(',\n');
    let expr = `z.object({\n${entries},\n${pad}})`;
    if (isOptional) expr += '.optional()';
    return expr;
  }

  // Primitive
  if (field.types.size > 0) return zodPrimitive(field.types, isOptional);

  return isOptional ? 'z.unknown().optional()' : 'z.unknown()';
}

/**
 * Generates a complete Zod schema TypeScript string from a {@link RespektObservedShape}.
 *
 * @param shape - The observed shape for a route.
 */
export function generateZodSchema(shape: RespektObservedShape): string {
  const lines = [
    `// Auto-generated by respekt — DO NOT EDIT`,
    `// Route: ${shape.route}`,
    `// Samples: ${shape.totalSamples}`,
    `import { z } from 'zod';`,
    ``,
  ];

  let schemaExpr: string;
  if (shape.isArray && shape.arrayElement) {
    schemaExpr = `z.array(${fieldToZod(shape.arrayElement, shape.arrayElement.seenCount, 1)})`;
  } else if (shape.isArray) {
    schemaExpr = `z.array(z.unknown()) /* empty root array observed */`;
  } else {
    const entries = Object.entries(shape.fields)
      .map(([k, f]) => `  ${JSON.stringify(k)}: ${fieldToZod(f, shape.totalSamples, 1)}`)
      .join(',\n');
    schemaExpr = `z.object({\n${entries},\n})`;
  }

  lines.push(`export const schema = ${schemaExpr};`);
  lines.push(`export type Schema = z.infer<typeof schema>;`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON Schema generation
// ---------------------------------------------------------------------------

function fieldToJsonSchema(
  field: RespektFieldShape,
  totalSamples: number,
): Record<string, unknown> {
  const isOptional = field.seenCount < totalSamples;

  // Array
  if (field.arrayElement !== undefined || field.emptyArray) {
    const items =
      field.emptyArray && !field.arrayElement
        ? {}
        : fieldToJsonSchema(field.arrayElement!, field.arrayElement!.seenCount);
    const node: Record<string, unknown> = { type: 'array', items };
    if (isOptional) node['x-optional'] = true;
    return node;
  }

  // Object
  if (field.children && Object.keys(field.children).length > 0) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, child] of Object.entries(field.children)) {
      properties[k] = fieldToJsonSchema(child, field.seenCount);
      if (child.seenCount >= field.seenCount) required.push(k);
    }
    const node: Record<string, unknown> = { type: 'object', properties };
    if (required.length > 0) node['required'] = required;
    if (isOptional) node['x-optional'] = true;
    return node;
  }

  // Primitive
  const primitiveTypes = [...field.types];
  const hasNull = primitiveTypes.includes('null');
  const nonNull = primitiveTypes.filter((t) => t !== 'null');

  const toNode = (t: RespektPrimitiveType): Record<string, unknown> =>
    t === 'datetime' ? { type: 'string', format: 'date-time' } :
    t === 'number'   ? { type: 'number' } :
    t === 'boolean'  ? { type: 'boolean' } :
                       { type: 'string' };

  let node: Record<string, unknown> =
    nonNull.length === 0 ? { type: 'null' } :
    nonNull.length === 1 ? toNode(nonNull[0]!) :
                           { oneOf: nonNull.map(toNode) };

  if (hasNull) node = { anyOf: [node, { type: 'null' }] };
  if (isOptional) node['x-optional'] = true;
  return node;
}

/**
 * Generates a JSON Schema (draft-07) object from a {@link RespektObservedShape}.
 *
 * @param shape - The observed shape for a route.
 */
export function generateJsonSchema(shape: RespektObservedShape): Record<string, unknown> {
  const base: Record<string, unknown> = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: shape.route,
    'x-samples': shape.totalSamples,
    'x-generator': 'respekt',
  };

  if (shape.isArray && shape.arrayElement) {
    return { ...base, type: 'array', items: fieldToJsonSchema(shape.arrayElement, shape.arrayElement.seenCount) };
  }
  if (shape.isArray) {
    return { ...base, type: 'array', items: {} };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, field] of Object.entries(shape.fields)) {
    properties[k] = fieldToJsonSchema(field, shape.totalSamples);
    if (field.seenCount >= shape.totalSamples) required.push(k);
  }

  return {
    ...base,
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Generates Zod + JSON Schema from a serialised on-disk shape.
 * Primary entry-point for the CLI `lock` command.
 *
 * @param serialised - The JSON-parsed shape from the traffic log.
 */
export function inferFromSerialised(serialised: RespektSerializableShape): {
  zodSchema: string;
  jsonSchema: Record<string, unknown>;
} {
  const shape = fromSerializableShape(serialised);
  return { zodSchema: generateZodSchema(shape), jsonSchema: generateJsonSchema(shape) };
}
