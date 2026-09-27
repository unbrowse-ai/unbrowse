// Type-level guard (never bundled): the hand-written public declarations in types/index.d.ts match src/index.ts.
import type * as Declared from "../types/index.d.ts";
import * as impl from "./index.ts";

export const declaredMatchesImplementation: typeof Declared = impl;
