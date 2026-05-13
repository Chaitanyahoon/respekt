/**
 * @module respekt
 * Main entry point for the respekt library.
 *
 * @example
 * ```ts
 * import respekt from 'respekt';
 *
 * // Dev — observe traffic
 * app.use(respekt.observe({ routes: ['/api/*'] }));
 *
 * // Production — enforce contracts
 * app.use(respekt.enforce({ contractsDir: './contracts', onViolation: 'warn' }));
 * ```
 */

import { observe } from './middleware/observe.js';
import { enforce } from './middleware/enforce.js';

// Re-export middleware factories
export { observe } from './middleware/observe.js';
export { enforce, RespektViolation } from './middleware/enforce.js';

// Re-export schema utilities
export { createObservedShape, observeBody, generateZodSchema, generateJsonSchema, inferFromSerialised } from './schema/infer.js';
export { diffAgainstSchema } from './schema/diff.js';

// Re-export all types
export type {
  RespektObserveConfig, RespektEnforceConfig, RespektViolationAction, RespektConfig,
  RespektPrimitiveType, RespektFieldShape, RespektObservedShape, RespektTrafficLog,
  RespektSerializableFieldShape, RespektSerializableShape,
  RespektFieldViolation, RespektViolationReport, RespektLockedContract,
} from './types.js';
export { toSerializableField, fromSerializableField, toSerializableShape, fromSerializableShape } from './types.js';

/** Default export for `import respekt from 'respekt'` usage. */
const respekt = { observe, enforce };
export default respekt;
