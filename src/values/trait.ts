/**
 * Re-exports the ValueAdapter trait surface in one place. Adapter
 * implementations import from here so the trait shape is single-source-of-
 * truth even if `types.ts` is reorganized later.
 */

export {
  type AdapterContext,
  type AdapterError,
  type AdapterErrorCode,
  type Pointer,
  type ResolvedValue,
  type Scheme,
  type ValueAdapter,
} from "./types.js";
