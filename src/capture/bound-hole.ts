/**
 * bound-hole shim — wallet-binding was removed in the harness isolation.
 * These stubs keep the hole-template surface compiling until the next
 * wallet-bound design lands. At runtime they are inert (no bindings minted,
 * no proofs verified — holes are plain placeholders). The behavior is honest:
 * holes exist, wallet attestation is unavailable.
 */
import type { Hole } from "./hole-template.js";
export type Binding = { y: string; root: string; sig: string };
export type BindingMap = Record<string, Binding>;
export type Proof = unknown;
export type HoleProofs = Record<string, Proof>;
export function boundTag(_b: Binding): string { return `[bound:stub]`; }
export function parseBoundTag(_tag: string | undefined): Binding | null { return null; }
export async function bindHole(hole: Hole, _secret: Uint8Array): Promise<Hole> { return hole; }
export async function bindKnownSecrets(_secrets: string[], _pubkey: string): Promise<BindingMap> { return {}; }
export function verifyHoleAttested(_hole: Hole): boolean { return false; }
export function proveHoles(_holes: Hole[], _fills: Record<string, string>): HoleProofs { return {}; }
export function verifyHoleProofs(_holes: Hole[], _proofs: HoleProofs): boolean { return false; }
export function prove(_secret: Uint8Array): Proof { return {}; }
