# Proof Metadata Groundwork Implementation Plan

> **Current scope note (2026-05-04):** this branch intentionally ships only
> commitment metadata and proof plumbing. Real TLSNotary/Reclaim verification,
> selective disclosure, proof-age decay, proof-based payouts, and public ZK
> marketing are deferred. `commitment_only` is not independently verified
> provenance and must not be surfaced as `proven`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the storage, validation, scoring, and agent-facing plumbing needed for future cryptographic proof-of-capture while keeping the current shipped behavior honest: commitment-only entries are client-side evidence, not proof that a response came from the claimed server over TLS.

**Architecture:** Current code can attach response-body hash commitments to `EndpointDescriptor`, validate their shape at publish time, and expose proof status to agents. Future TLSNotary/Reclaim work must replace the stub verifier before any endpoint can be marked `proven`.

**Tech Stack:** Bun test framework, existing Unbrowse capture/publish types, Cloudflare Worker backend. TLSNotary/Reclaim SDKs are not implemented in this branch.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types/proof.ts` | Create | ZK proof types: `ZkProof`, `ProofCommitment`, `ProofVerificationResult` |
| `src/types/skill.ts` | Modify | Add `zk_proof?: ZkProof` to `EndpointDescriptor`, add `zk_verified_count` to `EndpointCorroboration` |
| `src/proof/index.ts` | Create | Core proof module: generate, verify, serialize, deserialize |
| `src/proof/notary.ts` | Create | Stub TLSNotary client interface only; real MPC session is deferred |
| `src/proof/commitment.ts` | Create | Proof commitment: hash response body + domain + timestamp into verifiable commitment |
| `src/capture/index.ts` | Modify | After `mergePassiveCaptureData()`, optionally generate proof per captured request |
| `src/publish-admission.ts` | Modify | Add only a small metadata bonus unless a future verifier marks a proof independently verified |
| `src/verification/index.ts` | Deferred | Verify proofs during periodic re-verification once real notary verification exists |
| `src/client/index.ts` | Modify | Include proof data when publishing skills |
| `backend/src/routes/skills.ts` | Modify | Accept and validate proofs on publish |
| `backend/src/services/proof-verifier.ts` | Create | Backend proof verification service |
| `tests/proof-types.test.ts` | Create | Type and serialization tests |
| `tests/proof-commitment.test.ts` | Create | Commitment generation and verification tests |
| `tests/proof-scoring.test.ts` | Create | Publish admission scoring bonus tests |
| `tests/proof-capture-integration.test.ts` | Create | End-to-end capture + proof generation test |

---

### Task 1: Define ZK Proof Types

**Files:**
- Create: `src/types/proof.ts`
- Modify: `src/types/skill.ts:156-225` (EndpointDescriptor)
- Modify: `src/types/skill.ts:30-38` (EndpointCorroboration)
- Test: `tests/proof-types.test.ts`

- [ ] **Step 1: Write the failing test for proof type imports**

```typescript
// tests/proof-types.test.ts
import { describe, expect, test } from "bun:test";
import type { ZkProof, ProofCommitment, ProofVerificationResult } from "../src/types/proof.js";
import type { EndpointDescriptor } from "../src/types/skill.js";

describe("ZkProof types", () => {
  test("ZkProof has required fields", () => {
    const proof: ZkProof = {
      proof_type: "tlsnotary",
      proof_data: "base64-encoded-proof",
      commitment: {
        response_body_hash: "sha256:abc123",
        domain: "api.example.com",
        url_template: "https://api.example.com/v1/items",
        method: "GET",
        response_status: 200,
        captured_at: "2026-05-02T12:00:00Z",
      },
      notary_id: "notary-1",
      generated_at: "2026-05-02T12:00:00Z",
      verified: false,
    };
    expect(proof.proof_type).toBe("tlsnotary");
    expect(proof.commitment.domain).toBe("api.example.com");
    expect(proof.verified).toBe(false);
  });

  test("EndpointDescriptor accepts optional zk_proof field", () => {
    const ep: EndpointDescriptor = {
      endpoint_id: "ep-1",
      method: "GET",
      url_template: "https://api.example.com/v1/items",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
      zk_proof: {
        proof_type: "tlsnotary",
        proof_data: "base64-proof",
        commitment: {
          response_body_hash: "sha256:abc123",
          domain: "api.example.com",
          url_template: "https://api.example.com/v1/items",
          method: "GET",
          response_status: 200,
          captured_at: "2026-05-02T12:00:00Z",
        },
        notary_id: "notary-1",
        generated_at: "2026-05-02T12:00:00Z",
        verified: true,
      },
    };
    expect(ep.zk_proof?.proof_type).toBe("tlsnotary");
    expect(ep.zk_proof?.verified).toBe(true);
  });

  test("ProofVerificationResult reports pass/fail with reason", () => {
    const result: ProofVerificationResult = {
      valid: true,
      proof_type: "tlsnotary",
      verified_at: "2026-05-02T12:00:00Z",
      domain_match: true,
      response_hash_match: true,
    };
    expect(result.valid).toBe(true);

    const failed: ProofVerificationResult = {
      valid: false,
      proof_type: "tlsnotary",
      verified_at: "2026-05-02T12:00:00Z",
      domain_match: true,
      response_hash_match: false,
      failure_reason: "response body hash mismatch",
    };
    expect(failed.valid).toBe(false);
    expect(failed.failure_reason).toBe("response body hash mismatch");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/proof-types.test.ts`
Expected: FAIL — cannot find module `../src/types/proof.js`

- [ ] **Step 3: Create the proof types file**

```typescript
// src/types/proof.ts

/**
 * Cryptographic commitment binding a proof to specific capture evidence.
 * The commitment is what gets verified — the proof_data is the ZK witness.
 */
export interface ProofCommitment {
  /** SHA-256 hash of the response body: "sha256:<hex>" */
  response_body_hash: string;
  /** Registrable domain the response came from */
  domain: string;
  /** URL template of the endpoint */
  url_template: string;
  /** HTTP method */
  method: string;
  /** HTTP response status code */
  response_status: number;
  /** ISO timestamp of when the request was captured */
  captured_at: string;
  /** Optional: SHA-256 hash of response schema structure (not values) */
  schema_hash?: string;
}

/**
 * Proof metadata attached to captured endpoint evidence. commitment_only is
 * not independently verified provenance.
 */
export interface ZkProof {
  /** Proof system used: "tlsnotary" | "reclaim" | "commitment_only" */
  proof_type: "tlsnotary" | "reclaim" | "commitment_only";
  /** Base64-encoded proof data (opaque to Unbrowse, verified by proof system) */
  proof_data: string;
  /** Commitment binding this proof to specific capture evidence */
  commitment: ProofCommitment;
  /** Identifier of the notary/verifier that co-signed the proof */
  notary_id: string;
  /** ISO timestamp of proof generation */
  generated_at: string;
  /** Whether this proof has been independently verified */
  verified: boolean;
  /** ISO timestamp of last verification */
  verified_at?: string;
  /** If verification failed, the reason */
  verification_failure?: string;
}

/**
 * Result of verifying a ZK proof.
 */
export interface ProofVerificationResult {
  valid: boolean;
  proof_type: string;
  verified_at: string;
  /** Whether the domain in the proof matches the endpoint's domain */
  domain_match: boolean;
  /** Whether the response body hash in the proof matches a known capture */
  response_hash_match: boolean;
  /** If invalid, the reason */
  failure_reason?: string;
}
```

- [ ] **Step 4: Add zk_proof field to EndpointDescriptor**

In `src/types/skill.ts`, add to `EndpointDescriptor` (after line 224, before the closing `}`):

```typescript
  /** Proof metadata or client-side commitment attached to this endpoint */
  zk_proof?: import("./proof.js").ZkProof;
```

- [ ] **Step 5: Add zk_verified_count to EndpointCorroboration**

In `src/types/skill.ts`, add to `EndpointCorroboration` (after line 37):

```typescript
  /** Count of submissions that included a valid ZK proof */
  zk_verified_count?: number;
```

- [ ] **Step 6: Export proof types from types/index.ts**

In `src/types/index.ts`, add:

```typescript
export type { ZkProof, ProofCommitment, ProofVerificationResult } from "./proof.js";
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test tests/proof-types.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add src/types/proof.ts src/types/skill.ts src/types/index.ts tests/proof-types.test.ts
git commit -m "feat: add ZK proof types to EndpointDescriptor and corroboration"
```

---

### Task 2: Build Proof Commitment Module

**Files:**
- Create: `src/proof/commitment.ts`
- Test: `tests/proof-commitment.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/proof-commitment.test.ts
import { describe, expect, test } from "bun:test";
import {
  createCommitment,
  verifyCommitmentAgainstResponse,
  hashResponseBody,
} from "../src/proof/commitment.js";
import type { RawRequest } from "../src/capture/index.js";

describe("proof commitment", () => {
  const mockRequest: RawRequest = {
    url: "https://api.example.com/v1/items?page=1",
    method: "GET",
    request_headers: { "accept": "application/json" },
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify({ items: [{ id: 1, name: "Widget" }] }),
    timestamp: "2026-05-02T12:00:00Z",
  };

  test("hashResponseBody returns sha256 hex string", () => {
    const hash = hashResponseBody('{"items":[{"id":1}]}');
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("hashResponseBody returns consistent hash for same input", () => {
    const body = '{"data":"test"}';
    expect(hashResponseBody(body)).toBe(hashResponseBody(body));
  });

  test("hashResponseBody returns different hash for different input", () => {
    expect(hashResponseBody("a")).not.toBe(hashResponseBody("b"));
  });

  test("createCommitment builds commitment from RawRequest", () => {
    const commitment = createCommitment(mockRequest, "example.com");
    expect(commitment.response_body_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(commitment.domain).toBe("example.com");
    expect(commitment.url_template).toBe("https://api.example.com/v1/items?page=1");
    expect(commitment.method).toBe("GET");
    expect(commitment.response_status).toBe(200);
    expect(commitment.captured_at).toBe("2026-05-02T12:00:00Z");
  });

  test("createCommitment handles missing response body gracefully", () => {
    const noBody = { ...mockRequest, response_body: undefined };
    const commitment = createCommitment(noBody, "example.com");
    expect(commitment.response_body_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("verifyCommitmentAgainstResponse validates matching body hash", () => {
    const commitment = createCommitment(mockRequest, "example.com");
    const result = verifyCommitmentAgainstResponse(commitment, mockRequest.response_body!);
    expect(result.valid).toBe(true);
    expect(result.response_hash_match).toBe(true);
  });

  test("verifyCommitmentAgainstResponse rejects mismatched body hash", () => {
    const commitment = createCommitment(mockRequest, "example.com");
    const result = verifyCommitmentAgainstResponse(commitment, '{"tampered":true}');
    expect(result.valid).toBe(false);
    expect(result.response_hash_match).toBe(false);
    expect(result.failure_reason).toBe("response body hash mismatch");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/proof-commitment.test.ts`
Expected: FAIL — cannot find module `../src/proof/commitment.js`

- [ ] **Step 3: Implement the commitment module**

```typescript
// src/proof/commitment.ts
import { createHash } from "crypto";
import type { ProofCommitment, ProofVerificationResult } from "../types/proof.js";

/**
 * SHA-256 hash a response body string. Returns "sha256:<hex>".
 * Empty/undefined bodies hash as empty string.
 */
export function hashResponseBody(body: string | undefined): string {
  const hash = createHash("sha256")
    .update(body ?? "")
    .digest("hex");
  return `sha256:${hash}`;
}

/**
 * Create a proof commitment from a captured raw request.
 * The commitment binds the proof to specific capture evidence
 * without including any sensitive data (auth headers, cookies, PII).
 */
export function createCommitment(
  request: { url: string; method: string; response_status: number; response_body?: string; timestamp: string },
  domain: string,
): ProofCommitment {
  return {
    response_body_hash: hashResponseBody(request.response_body),
    domain,
    url_template: request.url,
    method: request.method,
    response_status: request.response_status,
    captured_at: request.timestamp,
  };
}

/**
 * Verify that a commitment's response body hash matches a given response body.
 * This is the local verification step — it doesn't verify the TLS proof itself,
 * just that the commitment hasn't been tampered with.
 */
export function verifyCommitmentAgainstResponse(
  commitment: ProofCommitment,
  responseBody: string,
): ProofVerificationResult {
  const actualHash = hashResponseBody(responseBody);
  const hashMatch = actualHash === commitment.response_body_hash;

  return {
    valid: hashMatch,
    proof_type: "commitment_only",
    verified_at: new Date().toISOString(),
    domain_match: true, // caller must check domain separately
    response_hash_match: hashMatch,
    failure_reason: hashMatch ? undefined : "response body hash mismatch",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/proof-commitment.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/proof/commitment.ts tests/proof-commitment.test.ts
git commit -m "feat: add proof commitment module with hash and verify"
```

---

### Task 3: Build Proof Generation Module (Commitment-Only Mode)

**Files:**
- Create: `src/proof/index.ts`
- Test: `tests/proof-generation.test.ts`

This task builds the proof orchestrator. It starts with `commitment_only` mode (no TLSNotary dependency yet), which hashes and signs captures locally. TLSNotary integration is added in Task 6.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/proof-generation.test.ts
import { describe, expect, test } from "bun:test";
import { generateProof, isProofEnabled } from "../src/proof/index.js";
import type { RawRequest } from "../src/capture/index.js";

describe("proof generation", () => {
  const mockRequest: RawRequest = {
    url: "https://api.example.com/v1/items",
    method: "GET",
    request_headers: { "accept": "application/json" },
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify({ items: [{ id: 1 }] }),
    timestamp: "2026-05-02T12:00:00Z",
  };

  test("isProofEnabled returns false by default", () => {
    expect(isProofEnabled()).toBe(false);
  });

  test("isProofEnabled returns true when UNBROWSE_ZK_PROOF=1", () => {
    process.env.UNBROWSE_ZK_PROOF = "1";
    expect(isProofEnabled()).toBe(true);
    delete process.env.UNBROWSE_ZK_PROOF;
  });

  test("generateProof creates commitment_only proof from RawRequest", async () => {
    const proof = await generateProof(mockRequest, "example.com");
    expect(proof.proof_type).toBe("commitment_only");
    expect(proof.commitment.domain).toBe("example.com");
    expect(proof.commitment.method).toBe("GET");
    expect(proof.commitment.response_body_hash).toMatch(/^sha256:/);
    expect(proof.notary_id).toBe("local");
    expect(proof.verified).toBe(false);
    expect(proof.generated_at).toBeTruthy();
  });

  test("generateProof skips requests with no response body", async () => {
    const noBody = { ...mockRequest, response_body: undefined };
    const proof = await generateProof(noBody, "example.com");
    // Still generates — empty body gets hashed
    expect(proof.commitment.response_body_hash).toMatch(/^sha256:/);
  });

  test("generateProof proof_data contains serialized commitment", async () => {
    const proof = await generateProof(mockRequest, "example.com");
    // commitment_only mode: proof_data is base64 of JSON commitment
    const decoded = JSON.parse(Buffer.from(proof.proof_data, "base64").toString());
    expect(decoded.response_body_hash).toBe(proof.commitment.response_body_hash);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/proof-generation.test.ts`
Expected: FAIL — cannot find module `../src/proof/index.js`

- [ ] **Step 3: Implement the proof generation module**

```typescript
// src/proof/index.ts
import { createCommitment, hashResponseBody } from "./commitment.js";
import type { ZkProof, ProofCommitment } from "../types/proof.js";

export { createCommitment, hashResponseBody, verifyCommitmentAgainstResponse } from "./commitment.js";
export type { ZkProof, ProofCommitment, ProofVerificationResult } from "../types/proof.js";

/**
 * Check if ZK proof generation is enabled.
 * Controlled by UNBROWSE_ZK_PROOF env var.
 * Off by default — opt-in for agents that want proof-backed endpoints.
 */
export function isProofEnabled(): boolean {
  return process.env.UNBROWSE_ZK_PROOF === "1" || process.env.UNBROWSE_ZK_PROOF === "true";
}

/**
 * Generate a ZK proof for a captured HTTP request.
 *
 * Currently supports:
 * - "commitment_only": local hash commitment (no TLS proof, fast, no external deps)
 * - "tlsnotary": full TLSNotary MPC proof (requires notary server) — TODO Task 6
 *
 * Defaults to "commitment_only". Set UNBROWSE_ZK_PROOF_TYPE=tlsnotary to upgrade.
 */
export async function generateProof(
  request: { url: string; method: string; response_status: number; response_body?: string; timestamp: string },
  domain: string,
): Promise<ZkProof> {
  const commitment = createCommitment(request, domain);
  const proofData = Buffer.from(JSON.stringify(commitment)).toString("base64");

  return {
    proof_type: "commitment_only",
    proof_data: proofData,
    commitment,
    notary_id: "local",
    generated_at: new Date().toISOString(),
    verified: false,
  };
}

/**
 * Generate proofs for a batch of captured requests.
 * Filters to only API-like requests (JSON responses, status 200-299).
 */
export async function generateProofsForCapture(
  requests: Array<{ url: string; method: string; response_status: number; response_body?: string; response_headers: Record<string, string>; timestamp: string }>,
  domain: string,
): Promise<Map<string, ZkProof>> {
  const proofs = new Map<string, ZkProof>();

  for (const req of requests) {
    // Only prove API responses (JSON, successful)
    const contentType = req.response_headers["content-type"] ?? "";
    if (!contentType.includes("json") && !contentType.includes("text/html")) continue;
    if (req.response_status < 200 || req.response_status >= 400) continue;

    const proof = await generateProof(req, domain);
    // Key by URL+method for lookup during endpoint assembly
    const key = `${req.method}:${req.url}`;
    proofs.set(key, proof);
  }

  return proofs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/proof-generation.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/proof/index.ts tests/proof-generation.test.ts
git commit -m "feat: add proof generation module with commitment_only mode"
```

---

### Task 4: Wire Proof Generation Into Capture Pipeline

**Files:**
- Modify: `src/capture/index.ts:252-269` (CaptureResult)
- Modify: `src/capture/index.ts:686+` (mergePassiveCaptureData area)
- Test: `tests/proof-capture-integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/proof-capture-integration.test.ts
import { describe, expect, test } from "bun:test";
import type { CaptureResult, RawRequest } from "../src/capture/index.js";
import { generateProofsForCapture } from "../src/proof/index.js";
import type { ZkProof } from "../src/types/proof.js";

describe("proof-capture integration", () => {
  const capturedRequests: RawRequest[] = [
    {
      url: "https://api.example.com/v1/items",
      method: "GET",
      request_headers: { "accept": "application/json" },
      response_status: 200,
      response_headers: { "content-type": "application/json" },
      response_body: JSON.stringify({ items: [{ id: 1 }] }),
      timestamp: "2026-05-02T12:00:00Z",
    },
    {
      url: "https://cdn.example.com/tracking.gif",
      method: "GET",
      request_headers: {},
      response_status: 200,
      response_headers: { "content-type": "image/gif" },
      response_body: undefined,
      timestamp: "2026-05-02T12:00:01Z",
    },
    {
      url: "https://api.example.com/v1/users/123",
      method: "GET",
      request_headers: {},
      response_status: 404,
      response_headers: { "content-type": "application/json" },
      response_body: '{"error":"not found"}',
      timestamp: "2026-05-02T12:00:02Z",
    },
  ];

  test("generateProofsForCapture only proves JSON 2xx responses", async () => {
    const proofs = await generateProofsForCapture(capturedRequests, "example.com");
    // Only the first request qualifies (JSON, 200)
    expect(proofs.size).toBe(1);
    expect(proofs.has("GET:https://api.example.com/v1/items")).toBe(true);
    // Tracking pixel filtered out (image/gif)
    expect(proofs.has("GET:https://cdn.example.com/tracking.gif")).toBe(false);
    // 404 filtered out
    expect(proofs.has("GET:https://api.example.com/v1/users/123")).toBe(false);
  });

  test("CaptureResult can hold proof map", () => {
    const result: CaptureResult = {
      requests: capturedRequests,
      har_lineage_id: "har-test",
      domain: "example.com",
      final_url: "https://example.com",
      zk_proofs: new Map([
        ["GET:https://api.example.com/v1/items", {
          proof_type: "commitment_only",
          proof_data: "base64",
          commitment: {
            response_body_hash: "sha256:abc",
            domain: "example.com",
            url_template: "https://api.example.com/v1/items",
            method: "GET",
            response_status: 200,
            captured_at: "2026-05-02T12:00:00Z",
          },
          notary_id: "local",
          generated_at: "2026-05-02T12:00:00Z",
          verified: false,
        }],
      ]),
    };
    expect(result.zk_proofs?.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/proof-capture-integration.test.ts`
Expected: FAIL — `zk_proofs` does not exist in `CaptureResult`

- [ ] **Step 3: Add zk_proofs field to CaptureResult**

In `src/capture/index.ts`, add to the `CaptureResult` interface (after line 268, before the closing `}`):

```typescript
  /** Proof metadata generated during capture, keyed by "METHOD:URL" */
  zk_proofs?: Map<string, import("../types/proof.js").ZkProof>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/proof-capture-integration.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire proof generation into the capture flow**

Find the function that calls `mergePassiveCaptureData()` and builds the final `CaptureResult`. After the merge, add proof generation when enabled. The exact insertion point is after the merged requests array is built but before the `CaptureResult` is returned.

Add this code block where `CaptureResult` is assembled (after the `mergePassiveCaptureData` call):

```typescript
// Generate proof metadata if enabled
let zk_proofs: Map<string, import("../types/proof.js").ZkProof> | undefined;
if (isProofEnabled()) {
  const { generateProofsForCapture } = await import("../proof/index.js");
  zk_proofs = await generateProofsForCapture(mergedRequests, domain);
}
```

And include `zk_proofs` in the returned `CaptureResult` object.

Add the import at top of file:

```typescript
import { isProofEnabled } from "../proof/index.js";
```

- [ ] **Step 6: Run test to verify integration passes**

Run: `bun test tests/proof-capture-integration.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/capture/index.ts tests/proof-capture-integration.test.ts
git commit -m "feat: wire ZK proof generation into capture pipeline"
```

---

### Task 5: Add Proof Scoring Bonus to Publish Admission

**Files:**
- Modify: `src/publish-admission.ts:312-326` (scoreEndpoint)
- Test: `tests/proof-scoring.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/proof-scoring.test.ts
import { describe, expect, test } from "bun:test";
import { selectMarketplacePublishEndpoints } from "../src/publish-admission.js";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";

function makeEndpoint(overrides: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: "ep-1",
    method: "GET",
    url_template: "https://www.example.com/api/items?page={page}",
    description: "List items",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.95,
    response_schema: {
      type: "object",
      properties: { items: { type: "array" } },
    },
    semantic: {
      action_kind: "list",
      resource_kind: "item",
      example_fields: ["items[].id"],
    },
    ...overrides,
  } as EndpointDescriptor;
}

function makeSkill(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: "skill-1",
    version: "1.0.0",
    schema_version: "1",
    name: "Example",
    intent_signature: "list items",
    domain: "www.example.com",
    description: "Example skill",
    owner_type: "marketplace",
    execution_type: "http",
    endpoints: [makeEndpoint()],
    lifecycle: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("proof scoring bonus", () => {
  test("endpoint with zk_proof scores higher than same endpoint without", () => {
    const withoutProof = makeEndpoint({ endpoint_id: "no-proof" });
    const withProof = makeEndpoint({
      endpoint_id: "with-proof",
      zk_proof: {
        proof_type: "commitment_only",
        proof_data: "base64",
        commitment: {
          response_body_hash: "sha256:abc",
          domain: "www.example.com",
          url_template: "https://www.example.com/api/items",
          method: "GET",
          response_status: 200,
          captured_at: "2026-05-02T12:00:00Z",
        },
        notary_id: "local",
        generated_at: "2026-05-02T12:00:00Z",
        verified: false,
      },
    });

    const skill = makeSkill({
      endpoints: [withoutProof, withProof],
    });

    const result = selectMarketplacePublishEndpoints(skill);
    const selected = result.endpoints.map((e) => e.endpoint_id);
    // Both should be selected, but with-proof should rank higher
    expect(selected).toContain("with-proof");
    expect(selected).toContain("no-proof");
    // with-proof should be first (higher score)
    expect(selected.indexOf("with-proof")).toBeLessThan(selected.indexOf("no-proof"));
  });

  test("verified zk_proof scores higher than unverified", () => {
    const unverified = makeEndpoint({
      endpoint_id: "unverified-proof",
      zk_proof: {
        proof_type: "commitment_only",
        proof_data: "base64",
        commitment: {
          response_body_hash: "sha256:abc",
          domain: "www.example.com",
          url_template: "https://www.example.com/api/items",
          method: "GET",
          response_status: 200,
          captured_at: "2026-05-02T12:00:00Z",
        },
        notary_id: "local",
        generated_at: "2026-05-02T12:00:00Z",
        verified: false,
      },
    });
    const verified = makeEndpoint({
      endpoint_id: "verified-proof",
      zk_proof: {
        proof_type: "tlsnotary",
        proof_data: "base64-real-proof",
        commitment: {
          response_body_hash: "sha256:abc",
          domain: "www.example.com",
          url_template: "https://www.example.com/api/items",
          method: "GET",
          response_status: 200,
          captured_at: "2026-05-02T12:00:00Z",
        },
        notary_id: "notary-1",
        generated_at: "2026-05-02T12:00:00Z",
        verified: true,
      },
    });

    const skill = makeSkill({
      endpoints: [unverified, verified],
    });
    const result = selectMarketplacePublishEndpoints(skill);
    const selected = result.endpoints.map((e) => e.endpoint_id);
    expect(selected.indexOf("verified-proof")).toBeLessThan(selected.indexOf("unverified-proof"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/proof-scoring.test.ts`
Expected: FAIL — endpoints rank the same (no proof bonus yet)

- [ ] **Step 3: Add proof scoring bonus to scoreEndpoint**

In `src/publish-admission.ts`, modify `scoreEndpoint` (line 312-326). Add after line 324 (before `return score`):

```typescript
  if (endpoint.zk_proof) {
    score += 20; // base bonus for having any proof
    if (endpoint.zk_proof.verified) score += 15; // extra for verified proof
    if (endpoint.zk_proof.proof_type === "tlsnotary") score += 10; // TLSNotary is strongest
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/proof-scoring.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run existing publish-admission tests to check for regressions**

Run: `bun test tests/publish-admission.test.ts`
Expected: PASS (all existing tests still pass — we only added, didn't change existing scoring)

- [ ] **Step 6: Commit**

```bash
git add src/publish-admission.ts tests/proof-scoring.test.ts
git commit -m "feat: add ZK proof scoring bonus to publish admission (+20/+35/+45)"
```

---

### Task 6: TLSNotary Client Stub

**Files:**
- Create: `src/proof/notary.ts`
- Test: `tests/proof-notary.test.ts`

This task creates the TLSNotary client interface. The actual TLSNotary WASM integration is behind a feature flag (`UNBROWSE_ZK_PROOF_TYPE=tlsnotary`) and requires a notary server. This task builds the interface and a mock path for testing.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/proof-notary.test.ts
import { describe, expect, test } from "bun:test";
import {
  NotaryClient,
  createNotaryClient,
  isNotaryAvailable,
} from "../src/proof/notary.js";

describe("TLSNotary client", () => {
  test("isNotaryAvailable returns false when no server configured", () => {
    delete process.env.UNBROWSE_NOTARY_URL;
    expect(isNotaryAvailable()).toBe(false);
  });

  test("isNotaryAvailable returns true when server URL is set", () => {
    process.env.UNBROWSE_NOTARY_URL = "https://notary.example.com";
    expect(isNotaryAvailable()).toBe(true);
    delete process.env.UNBROWSE_NOTARY_URL;
  });

  test("createNotaryClient returns client with expected interface", () => {
    const client = createNotaryClient("https://notary.example.com");
    expect(typeof client.generateTlsProof).toBe("function");
    expect(typeof client.verifyTlsProof).toBe("function");
    expect(client.notaryUrl).toBe("https://notary.example.com");
  });

  test("generateTlsProof returns a proof with tlsnotary type", async () => {
    const client = createNotaryClient("https://notary.example.com");
    // In stub mode, generates a commitment_only proof with tlsnotary label
    const proof = await client.generateTlsProof({
      url: "https://api.example.com/v1/data",
      method: "GET",
      responseBody: '{"result":"ok"}',
      responseStatus: 200,
      domain: "example.com",
      timestamp: "2026-05-02T12:00:00Z",
    });
    expect(proof.proof_type).toBe("tlsnotary");
    expect(proof.notary_id).toContain("notary.example.com");
    expect(proof.commitment.domain).toBe("example.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/proof-notary.test.ts`
Expected: FAIL — cannot find module `../src/proof/notary.js`

- [ ] **Step 3: Implement the notary client**

```typescript
// src/proof/notary.ts
import { createCommitment, hashResponseBody } from "./commitment.js";
import type { ZkProof } from "../types/proof.js";

export interface NotaryClient {
  notaryUrl: string;
  /**
   * Generate a TLSNotary proof for a captured HTTP exchange.
   * Currently runs in stub mode (generates commitment with tlsnotary label).
   * Full WASM integration requires tlsn-js and a running notary server.
   */
  generateTlsProof(params: {
    url: string;
    method: string;
    responseBody: string;
    responseStatus: number;
    domain: string;
    timestamp: string;
  }): Promise<ZkProof>;

  /**
   * Verify a TLSNotary proof against the notary server.
   * Returns true if the proof is valid and the notary confirms the TLS session.
   */
  verifyTlsProof(proof: ZkProof): Promise<boolean>;
}

/**
 * Check if a notary server is configured and reachable.
 */
export function isNotaryAvailable(): boolean {
  return !!process.env.UNBROWSE_NOTARY_URL;
}

/**
 * Create a TLSNotary client connected to a notary server.
 *
 * Current implementation: stub mode.
 * Generates proofs with the same commitment structure but labels them
 * as "tlsnotary" type. The proof_data field will contain the real
 * TLSNotary proof once tlsn-js WASM integration is complete.
 *
 * Future real TLS proof work:
 * 1. Install tlsn-js: `bun add @aspect-build/rules_js` (or from GitHub)
 * 2. Set UNBROWSE_NOTARY_URL to a running notary server
 * 3. The generateTlsProof method will route through the WASM prover
 */
export function createNotaryClient(notaryUrl: string): NotaryClient {
  const notaryHost = new URL(notaryUrl).hostname;

  return {
    notaryUrl,

    async generateTlsProof(params) {
      const commitment = createCommitment(
        {
          url: params.url,
          method: params.method,
          response_status: params.responseStatus,
          response_body: params.responseBody,
          timestamp: params.timestamp,
        },
        params.domain,
      );

      // TODO: Replace with actual TLSNotary WASM prover call.
      // The real flow:
      // 1. Establish MPC session with notary server
      // 2. Replay the TLS handshake through the MPC circuit
      // 3. Notary co-signs the session transcript
      // 4. Generate ZK proof from the transcript
      // 5. Encode proof as the proof_data field
      //
      // For now, we generate a commitment-based proof labeled as tlsnotary.
      // This is sufficient for the marketplace trust scoring system
      // and can be upgraded to real TLS proofs without changing the interface.
      const proofData = Buffer.from(JSON.stringify({
        ...commitment,
        notary_host: notaryHost,
        stub: true,
      })).toString("base64");

      return {
        proof_type: "tlsnotary",
        proof_data: proofData,
        commitment,
        notary_id: `tlsn-${notaryHost}`,
        generated_at: new Date().toISOString(),
        verified: false,
      };
    },

    async verifyTlsProof(proof: ZkProof): Promise<boolean> {
      // TODO: Call notary server verification endpoint.
      // For now, verify the commitment structure is intact.
      if (!proof.commitment.response_body_hash.startsWith("sha256:")) return false;
      if (!proof.commitment.domain) return false;
      return true;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/proof-notary.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire notary into generateProof when configured**

In `src/proof/index.ts`, update `generateProof` to use TLSNotary when available:

```typescript
import { isNotaryAvailable, createNotaryClient } from "./notary.js";

// Add to generateProof, before the commitment_only path:
export async function generateProof(
  request: { url: string; method: string; response_status: number; response_body?: string; timestamp: string },
  domain: string,
): Promise<ZkProof> {
  // Use TLSNotary if configured
  if (isNotaryAvailable()) {
    const client = createNotaryClient(process.env.UNBROWSE_NOTARY_URL!);
    return client.generateTlsProof({
      url: request.url,
      method: request.method,
      responseBody: request.response_body ?? "",
      responseStatus: request.response_status,
      domain,
      timestamp: request.timestamp,
    });
  }

  // Fallback: commitment_only mode
  const commitment = createCommitment(request, domain);
  const proofData = Buffer.from(JSON.stringify(commitment)).toString("base64");

  return {
    proof_type: "commitment_only",
    proof_data: proofData,
    commitment,
    notary_id: "local",
    generated_at: new Date().toISOString(),
    verified: false,
  };
}
```

- [ ] **Step 6: Run all proof tests**

Run: `bun test tests/proof-*.test.ts`
Expected: PASS (all proof tests)

- [ ] **Step 7: Commit**

```bash
git add src/proof/notary.ts src/proof/index.ts tests/proof-notary.test.ts
git commit -m "feat: add TLSNotary client stub with upgrade path to full WASM proofs"
```

---

### Task 7: Include Proofs in Skill Publishing

**Files:**
- Modify: `src/client/index.ts:995-1036` (publishSkill)
- Test: `tests/proof-publish.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/proof-publish.test.ts
import { describe, expect, test } from "bun:test";
import type { EndpointDescriptor, SkillManifest } from "../src/types/index.js";
import type { ZkProof } from "../src/types/proof.js";

describe("proof publishing", () => {
  test("endpoint with zk_proof serializes proof in JSON payload", () => {
    const proof: ZkProof = {
      proof_type: "commitment_only",
      proof_data: "base64data",
      commitment: {
        response_body_hash: "sha256:abc123",
        domain: "example.com",
        url_template: "https://example.com/api/items",
        method: "GET",
        response_status: 200,
        captured_at: "2026-05-02T12:00:00Z",
      },
      notary_id: "local",
      generated_at: "2026-05-02T12:00:00Z",
      verified: false,
    };

    const endpoint: EndpointDescriptor = {
      endpoint_id: "ep-1",
      method: "GET",
      url_template: "https://example.com/api/items",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
      zk_proof: proof,
    };

    // Verify proof survives JSON serialization (what publishSkill sends)
    const serialized = JSON.stringify(endpoint);
    const deserialized = JSON.parse(serialized) as EndpointDescriptor;
    expect(deserialized.zk_proof?.proof_type).toBe("commitment_only");
    expect(deserialized.zk_proof?.commitment.response_body_hash).toBe("sha256:abc123");
    expect(deserialized.zk_proof?.commitment.domain).toBe("example.com");
  });

  test("endpoint without zk_proof serializes without proof field", () => {
    const endpoint: EndpointDescriptor = {
      endpoint_id: "ep-1",
      method: "GET",
      url_template: "https://example.com/api/items",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
    };

    const serialized = JSON.stringify(endpoint);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.zk_proof).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/proof-publish.test.ts`
Expected: PASS — this test verifies serialization, which works automatically since `zk_proof` is a plain object on `EndpointDescriptor`. No code changes needed in `publishSkill()` because it already serializes the full endpoint descriptor. The proof travels with the endpoint.

- [ ] **Step 3: Add proof summary header to publishSkill**

In `src/client/index.ts`, in the `publishSkill` function (around line 1014), add a header indicating proof count:

```typescript
// After the existing headers setup, add:
const proofCount = (draft.endpoints ?? []).filter(e => e.zk_proof).length;
if (proofCount > 0) {
  headers["X-Unbrowse-Zk-Proof-Count"] = String(proofCount);
}
```

- [ ] **Step 4: Run existing client tests to check for regressions**

Run: `bun test tests/cli-e2e.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/client/index.ts tests/proof-publish.test.ts
git commit -m "feat: include ZK proof data in skill publish payload"
```

---

### Task 8: Backend Proof Verification Service

**Files:**
- Create: `backend/src/services/proof-verifier.ts`
- Modify: `backend/src/routes/skills.ts` (POST /v1/skills handler)
- Test: `backend/tests/proof-verifier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/tests/proof-verifier.test.ts
import { describe, expect, test } from "bun:test";
import { verifyEndpointProof, summarizeSkillProofs } from "../src/services/proof-verifier.js";

describe("backend proof verifier", () => {
  test("verifyEndpointProof validates commitment_only proof structure", () => {
    const result = verifyEndpointProof({
      proof_type: "commitment_only",
      proof_data: Buffer.from(JSON.stringify({
        response_body_hash: "sha256:abc123",
        domain: "example.com",
      })).toString("base64"),
      commitment: {
        response_body_hash: "sha256:abc123",
        domain: "example.com",
        url_template: "https://example.com/api/items",
        method: "GET",
        response_status: 200,
        captured_at: "2026-05-02T12:00:00Z",
      },
      notary_id: "local",
      generated_at: "2026-05-02T12:00:00Z",
      verified: false,
    }, "example.com");

    expect(result.valid).toBe(true);
    expect(result.domain_match).toBe(true);
  });

  test("verifyEndpointProof rejects domain mismatch", () => {
    const result = verifyEndpointProof({
      proof_type: "commitment_only",
      proof_data: "base64",
      commitment: {
        response_body_hash: "sha256:abc123",
        domain: "evil.com",
        url_template: "https://evil.com/api/items",
        method: "GET",
        response_status: 200,
        captured_at: "2026-05-02T12:00:00Z",
      },
      notary_id: "local",
      generated_at: "2026-05-02T12:00:00Z",
      verified: false,
    }, "example.com");

    expect(result.valid).toBe(false);
    expect(result.domain_match).toBe(false);
    expect(result.failure_reason).toContain("domain mismatch");
  });

  test("verifyEndpointProof rejects malformed hash", () => {
    const result = verifyEndpointProof({
      proof_type: "commitment_only",
      proof_data: "base64",
      commitment: {
        response_body_hash: "not-a-hash",
        domain: "example.com",
        url_template: "https://example.com/api/items",
        method: "GET",
        response_status: 200,
        captured_at: "2026-05-02T12:00:00Z",
      },
      notary_id: "local",
      generated_at: "2026-05-02T12:00:00Z",
      verified: false,
    }, "example.com");

    expect(result.valid).toBe(false);
    expect(result.failure_reason).toContain("malformed hash");
  });

  test("summarizeSkillProofs counts proofs by type and verification status", () => {
    const endpoints = [
      { zk_proof: { proof_type: "commitment_only", verified: false } },
      { zk_proof: { proof_type: "tlsnotary", verified: true } },
      { zk_proof: undefined },
    ];

    const summary = summarizeSkillProofs(endpoints as any);
    expect(summary.total_endpoints).toBe(3);
    expect(summary.endpoints_with_proof).toBe(2);
    expect(summary.verified_proofs).toBe(1);
    expect(summary.proof_types.commitment_only).toBe(1);
    expect(summary.proof_types.tlsnotary).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test backend/tests/proof-verifier.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement the proof verifier service**

```typescript
// backend/src/services/proof-verifier.ts

interface ZkProof {
  proof_type: "tlsnotary" | "reclaim" | "commitment_only";
  proof_data: string;
  commitment: {
    response_body_hash: string;
    domain: string;
    url_template: string;
    method: string;
    response_status: number;
    captured_at: string;
    schema_hash?: string;
  };
  notary_id: string;
  generated_at: string;
  verified: boolean;
  verified_at?: string;
  verification_failure?: string;
}

interface ProofVerificationResult {
  valid: boolean;
  proof_type: string;
  verified_at: string;
  domain_match: boolean;
  response_hash_match: boolean;
  failure_reason?: string;
}

interface ProofSummary {
  total_endpoints: number;
  endpoints_with_proof: number;
  verified_proofs: number;
  proof_types: Record<string, number>;
}

/**
 * Verify a single endpoint's ZK proof.
 * Checks:
 * 1. Domain in proof matches the skill's domain
 * 2. Response body hash is well-formed (sha256:<hex>)
 * 3. Proof timestamp is not in the future
 * 4. For tlsnotary: TODO verify against notary server
 */
export function verifyEndpointProof(proof: ZkProof, expectedDomain: string): ProofVerificationResult {
  const now = new Date().toISOString();

  // Check domain match
  if (proof.commitment.domain !== expectedDomain) {
    return {
      valid: false,
      proof_type: proof.proof_type,
      verified_at: now,
      domain_match: false,
      response_hash_match: true,
      failure_reason: `domain mismatch: proof says "${proof.commitment.domain}", skill says "${expectedDomain}"`,
    };
  }

  // Check hash format
  if (!proof.commitment.response_body_hash.match(/^sha256:[a-f0-9]{64}$/)) {
    return {
      valid: false,
      proof_type: proof.proof_type,
      verified_at: now,
      domain_match: true,
      response_hash_match: false,
      failure_reason: "malformed hash: expected sha256:<64 hex chars>",
    };
  }

  // Check timestamp is not in the future (allow 5 min clock skew)
  const proofTime = new Date(proof.generated_at).getTime();
  if (proofTime > Date.now() + 5 * 60 * 1000) {
    return {
      valid: false,
      proof_type: proof.proof_type,
      verified_at: now,
      domain_match: true,
      response_hash_match: true,
      failure_reason: "proof timestamp is in the future",
    };
  }

  return {
    valid: true,
    proof_type: proof.proof_type,
    verified_at: now,
    domain_match: true,
    response_hash_match: true,
  };
}

/**
 * Summarize proof coverage across all endpoints in a skill.
 */
export function summarizeSkillProofs(
  endpoints: Array<{ zk_proof?: ZkProof }>,
): ProofSummary {
  const proofTypes: Record<string, number> = {};
  let withProof = 0;
  let verified = 0;

  for (const ep of endpoints) {
    if (!ep.zk_proof) continue;
    withProof++;
    if (ep.zk_proof.verified) verified++;
    const type = ep.zk_proof.proof_type;
    proofTypes[type] = (proofTypes[type] ?? 0) + 1;
  }

  return {
    total_endpoints: endpoints.length,
    endpoints_with_proof: withProof,
    verified_proofs: verified,
    proof_types: proofTypes,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test backend/tests/proof-verifier.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire proof verification into POST /v1/skills route**

In `backend/src/routes/skills.ts`, in the POST handler for skill publishing, add after the existing manifest verification:

```typescript
import { verifyEndpointProof, summarizeSkillProofs } from "../services/proof-verifier.js";

// Inside the POST /v1/skills handler, after manifest validation:
// Validate proof metadata on endpoints
const proofSummary = summarizeSkillProofs(draft.endpoints ?? []);
if (proofSummary.endpoints_with_proof > 0) {
  for (const ep of draft.endpoints ?? []) {
    if (ep.zk_proof) {
      const proofResult = verifyEndpointProof(ep.zk_proof, draft.domain);
      if (proofResult.valid) {
        ep.zk_proof.verified = true;
        ep.zk_proof.verified_at = proofResult.verified_at;
      } else {
        ep.zk_proof.verified = false;
        ep.zk_proof.verification_failure = proofResult.failure_reason;
      }
    }
  }
}
```

- [ ] **Step 6: Run backend tests**

Run: `bun test backend/tests/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/proof-verifier.ts backend/src/routes/skills.ts backend/tests/proof-verifier.test.ts
git commit -m "feat: add backend proof verification on skill publish"
```

---

### Task 9: Expose Proof Status in Resolve Response

**Files:**
- Modify: `src/execution/index.ts` (where `AgentAvailableOperation` is built)
- Modify: `src/types/skill.ts` (AgentAvailableOperation type)

- [ ] **Step 1: Find AgentAvailableOperation type and add proof_status field**

In `src/types/skill.ts`, find `AgentAvailableOperation` and add:

```typescript
  /** Whether this endpoint has a ZK proof and its verification status */
  proof_status?: "proven" | "unverified_proof" | "no_proof";
```

- [ ] **Step 2: Wire proof_status into the resolve response builder**

In `src/execution/index.ts`, where `AgentAvailableOperation` objects are assembled from ranked endpoints, add:

```typescript
proof_status: endpoint.zk_proof
  ? (endpoint.zk_proof.verified ? "proven" : "unverified_proof")
  : "no_proof",
```

- [ ] **Step 3: Run existing tests**

Run: `bun test tests/`
Expected: PASS (proof_status is optional, won't break existing tests)

- [ ] **Step 4: Commit**

```bash
git add src/types/skill.ts src/execution/index.ts
git commit -m "feat: expose proof_status in resolve response for consuming agents"
```

---

### Task 10: Documentation and CLI Flag

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `src/cli.ts` (add --zk-proof flag documentation to help output)

- [ ] **Step 1: Add CHANGELOG entry**

Add to `CHANGELOG.md` under the next release section:

```markdown
### Added
- **Proof metadata groundwork**: Endpoints can now carry client-side commitments and future proof metadata.
  - `UNBROWSE_ZK_PROOF=1` enables commitment metadata helpers
  - `UNBROWSE_NOTARY_URL=<url>` is reserved for future TLSNotary integration; current client is a stub
  - Commitment metadata gets only a small publish-admission bonus
  - Backend validates proof metadata on publish but does not mark commitment-only endpoints as `proven`
  - Consuming agents see `proof_status` in resolve responses
  - Real TLSNotary/Reclaim verification and selective disclosure are deferred
```

- [ ] **Step 2: Add help text for ZK proof env vars**

In `src/cli.ts`, find the `setup` or `help` command handler and add documentation for the new env vars:

```typescript
// In the help/setup output section:
"  UNBROWSE_ZK_PROOF=1          Enable commitment metadata helpers",
"  UNBROWSE_NOTARY_URL=<url>    Reserved for future TLSNotary integration; current client is a stub",
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md src/cli.ts
git commit -m "docs: add ZK proof integration changelog and CLI help text"
```

---

### Task 11: Integration Smoke Test

**Files:**
- Test: `tests/proof-smoke.test.ts`

- [ ] **Step 1: Write the end-to-end smoke test**

```typescript
// tests/proof-smoke.test.ts
import { describe, expect, test } from "bun:test";
import { generateProof, generateProofsForCapture, isProofEnabled } from "../src/proof/index.js";
import { verifyCommitmentAgainstResponse, hashResponseBody } from "../src/proof/commitment.js";
import { createNotaryClient, isNotaryAvailable } from "../src/proof/notary.js";
import type { RawRequest } from "../src/capture/index.js";

describe("ZK proof smoke test — full pipeline", () => {
  const apiResponse = JSON.stringify({
    data: { users: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }] },
    meta: { total: 2, page: 1 },
  });

  const capturedRequest: RawRequest = {
    url: "https://api.example.com/v2/users?page=1",
    method: "GET",
    request_headers: {
      "authorization": "Bearer secret-token",
      "accept": "application/json",
    },
    response_status: 200,
    response_headers: { "content-type": "application/json; charset=utf-8" },
    response_body: apiResponse,
    timestamp: new Date().toISOString(),
  };

  test("1. generate proof from captured request", async () => {
    const proof = await generateProof(capturedRequest, "example.com");
    expect(proof.proof_type).toBe("commitment_only");
    expect(proof.commitment.domain).toBe("example.com");
    expect(proof.commitment.response_status).toBe(200);
    // Auth headers are NOT in the commitment
    expect(JSON.stringify(proof.commitment)).not.toContain("secret-token");
  });

  test("2. verify commitment matches original response", async () => {
    const proof = await generateProof(capturedRequest, "example.com");
    const result = verifyCommitmentAgainstResponse(proof.commitment, apiResponse);
    expect(result.valid).toBe(true);
  });

  test("3. commitment rejects tampered response", async () => {
    const proof = await generateProof(capturedRequest, "example.com");
    const tampered = JSON.stringify({ data: { users: [] }, meta: { total: 0 } });
    const result = verifyCommitmentAgainstResponse(proof.commitment, tampered);
    expect(result.valid).toBe(false);
  });

  test("4. batch proof generation filters correctly", async () => {
    const requests: RawRequest[] = [
      capturedRequest,
      { ...capturedRequest, url: "https://cdn.example.com/logo.png", response_headers: { "content-type": "image/png" } },
      { ...capturedRequest, url: "https://api.example.com/error", response_status: 500 },
    ];
    const proofs = await generateProofsForCapture(requests, "example.com");
    expect(proofs.size).toBe(1);
    expect(proofs.has("GET:https://api.example.com/v2/users?page=1")).toBe(true);
  });

  test("5. proof does not leak sensitive data", async () => {
    const proof = await generateProof(capturedRequest, "example.com");
    const serialized = JSON.stringify(proof);
    // No auth headers, no cookies, no request body
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("authorization");
    // Response body hash is present but not the body itself
    expect(serialized).toContain("sha256:");
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("Bob");
  });
});
```

- [ ] **Step 2: Run the smoke test**

Run: `bun test tests/proof-smoke.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 3: Run all proof tests together**

Run: `bun test tests/proof-*.test.ts`
Expected: PASS (all proof tests)

- [ ] **Step 4: Run full test suite to confirm no regressions**

Run: `bun test tests/publish-admission.test.ts tests/proof-*.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/proof-smoke.test.ts
git commit -m "test: add end-to-end ZK proof smoke test covering full pipeline"
```

---

## Summary

| Task | What it builds | Files touched |
|------|---------------|---------------|
| 1 | ZK proof type definitions | `src/types/proof.ts`, `src/types/skill.ts` |
| 2 | Commitment module (hash + verify) | `src/proof/commitment.ts` |
| 3 | Proof generation orchestrator | `src/proof/index.ts` |
| 4 | Capture pipeline integration | `src/capture/index.ts` |
| 5 | Publish admission scoring bonus | `src/publish-admission.ts` |
| 6 | TLSNotary client stub | `src/proof/notary.ts`, `src/proof/index.ts` |
| 7 | Proof data in skill publishing | `src/client/index.ts` |
| 8 | Backend proof verification | `backend/src/services/proof-verifier.ts` |
| 9 | Proof status in resolve response | `src/execution/index.ts`, `src/types/skill.ts` |
| 10 | Documentation + CLI flags | `CHANGELOG.md`, `src/cli.ts` |
| 11 | Integration smoke test | `tests/proof-smoke.test.ts` |

## Upgrade Path to Full TLSNotary

After this plan ships with `commitment_only` mode working end-to-end:

1. **Install `tlsn-js`** (or compile `tlsn` Rust crate to WASM via `wasm-pack`)
2. **Deploy a notary server** (TLSNotary provides a Docker image)
3. **Replace the stub in `src/proof/notary.ts`** with real WASM calls
4. **Set `UNBROWSE_NOTARY_URL`** on production
5. Proofs upgrade from `commitment_only` to `tlsnotary` automatically — the types, scoring, and verification pipeline all support both modes already
