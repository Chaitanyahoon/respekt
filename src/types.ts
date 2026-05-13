// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the observe middleware. */
export interface RespektObserveConfig {
  /** Glob patterns for routes to watch (e.g. `['/api/*']`). */
  routes: string[];
  /** Number of responses to observe before the schema is considered stable. Default: `50`. */
  sampleSize?: number;
  /** Directory to write observed traffic logs. Default: `'./contracts'`. */
  outputDir?: string;
}

/** Behaviour when a contract violation is detected. */
export type RespektViolationAction = 'throw' | 'warn' | 'log';

/** Configuration for the enforce middleware. */
export interface RespektEnforceConfig {
  /** Directory containing the locked `*.schema.json` contract files. Default: `'./contracts'`. */
  contractsDir?: string;
  /** What to do when a violation is detected. Default: `'warn'`. */
  onViolation?: RespektViolationAction;
  /** If `true`, extra keys not in the schema also count as violations. Default: `false`. */
  strict?: boolean;
}

/** Top-level configuration (optional `respekt.config.json`). */
export interface RespektConfig {
  routes: string[];
  sampleSize: number;
  outputDir: string;
  contractsDir: string;
  onViolation: RespektViolationAction;
  strict: boolean;
}

// ---------------------------------------------------------------------------
// Observed shapes
// ---------------------------------------------------------------------------

/**
 * Primitive type tags used during shape inference.
 * `'datetime'` is a refinement of `'string'` for ISO 8601 values.
 */
export type RespektPrimitiveType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'datetime';

/** A descriptor for a single inferred field. */
export interface RespektFieldShape {
  /** Set of primitive types observed for this field across all samples. */
  types: Set<RespektPrimitiveType>;
  /** If the field is an object, its nested children. */
  children?: Record<string, RespektFieldShape>;
  /** If the field is an array, the inferred shape of its elements. */
  arrayElement?: RespektFieldShape;
  /** Total number of samples where this key was present. */
  seenCount: number;
  /** Whether an empty array was observed (element type unknown). */
  emptyArray?: boolean;
}

/** Top-level observed shape for a single route. */
export interface RespektObservedShape {
  /** Route key, e.g. `'GET /api/users'`. */
  route: string;
  /** Total number of response bodies observed so far. */
  totalSamples: number;
  /** Root-level field shapes (the response body is assumed to be an object or array). */
  fields: Record<string, RespektFieldShape>;
  /** Whether the root response is an array. */
  isArray?: boolean;
  /** Element shape when the root is an array. */
  arrayElement?: RespektFieldShape;
}

/** The on-disk traffic log format (JSON-serialisable). */
export interface RespektTrafficLog {
  /** Timestamp of the last observation. */
  updatedAt: string;
  /** Map of route key → serialisable shape. */
  routes: Record<string, RespektSerializableShape>;
}

/** JSON-safe variant of {@link RespektFieldShape} (uses `string[]` instead of `Set`). */
export interface RespektSerializableFieldShape {
  types: RespektPrimitiveType[];
  children?: Record<string, RespektSerializableFieldShape>;
  arrayElement?: RespektSerializableFieldShape;
  seenCount: number;
  emptyArray?: boolean;
}

/** JSON-safe variant of {@link RespektObservedShape}. */
export interface RespektSerializableShape {
  route: string;
  totalSamples: number;
  fields: Record<string, RespektSerializableFieldShape>;
  isArray?: boolean;
  arrayElement?: RespektSerializableFieldShape;
}

// ---------------------------------------------------------------------------
// Contract & violations
// ---------------------------------------------------------------------------

/** A single field-level violation. */
export interface RespektFieldViolation {
  /** Dot-path to the field, e.g. `'user.age'`. */
  field: string;
  /** What the contract expected. */
  expected: string;
  /** What was actually received. */
  received: string;
}

/** A contract violation event emitted by the enforce middleware. */
export interface RespektViolationReport {
  /** Route key, e.g. `'GET /api/users'`. */
  route: string;
  /** ISO 8601 timestamp of when the violation was detected. */
  violatedAt: string;
  /** List of individual field violations. */
  violations: RespektFieldViolation[];
}

/** The locked contract file written by `respekt lock`. */
export interface RespektLockedContract {
  /** Route key. */
  route: string;
  /** ISO 8601 timestamp of when the contract was locked. */
  lockedAt: string;
  /** The generated Zod schema as a string (for display / codegen). */
  zodSchema: string;
  /** Standard JSON Schema representation. */
  jsonSchema: Record<string, unknown>;
  /** The serialised observed shape at lock time. */
  shape: RespektSerializableShape;
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

/** Convert a {@link RespektFieldShape} to its JSON-serialisable form. */
export function toSerializableField(field: RespektFieldShape): RespektSerializableFieldShape {
  const result: RespektSerializableFieldShape = {
    types: [...field.types],
    seenCount: field.seenCount,
  };
  if (field.children) {
    result.children = Object.fromEntries(
      Object.entries(field.children).map(([k, v]) => [k, toSerializableField(v)]),
    );
  }
  if (field.arrayElement) {
    result.arrayElement = toSerializableField(field.arrayElement);
  }
  if (field.emptyArray) {
    result.emptyArray = true;
  }
  return result;
}

/** Convert a {@link RespektSerializableFieldShape} back to a live {@link RespektFieldShape}. */
export function fromSerializableField(field: RespektSerializableFieldShape): RespektFieldShape {
  const result: RespektFieldShape = {
    types: new Set(field.types),
    seenCount: field.seenCount,
  };
  if (field.children) {
    result.children = Object.fromEntries(
      Object.entries(field.children).map(([k, v]) => [k, fromSerializableField(v)]),
    );
  }
  if (field.arrayElement) {
    result.arrayElement = fromSerializableField(field.arrayElement);
  }
  if (field.emptyArray) {
    result.emptyArray = true;
  }
  return result;
}

/** Convert a {@link RespektObservedShape} to its serialisable form. */
export function toSerializableShape(shape: RespektObservedShape): RespektSerializableShape {
  const result: RespektSerializableShape = {
    route: shape.route,
    totalSamples: shape.totalSamples,
    fields: Object.fromEntries(
      Object.entries(shape.fields).map(([k, v]) => [k, toSerializableField(v)]),
    ),
  };
  if (shape.isArray) {
    result.isArray = true;
  }
  if (shape.arrayElement) {
    result.arrayElement = toSerializableField(shape.arrayElement);
  }
  return result;
}

/** Convert a {@link RespektSerializableShape} back to a live {@link RespektObservedShape}. */
export function fromSerializableShape(shape: RespektSerializableShape): RespektObservedShape {
  const result: RespektObservedShape = {
    route: shape.route,
    totalSamples: shape.totalSamples,
    fields: Object.fromEntries(
      Object.entries(shape.fields).map(([k, v]) => [k, fromSerializableField(v)]),
    ),
  };
  if (shape.isArray) {
    result.isArray = true;
  }
  if (shape.arrayElement) {
    result.arrayElement = fromSerializableField(shape.arrayElement);
  }
  return result;
}
