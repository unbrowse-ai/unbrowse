import { describe, test } from "bun:test";

// Day 3 (Land) seed test for Unbrowse MCP audit Phase 0b.
//
// Mustard-seed: every case below is `test.todo(...)`. Todos always pass and
// report as pending. Day 5 (Luminaries) flips these to real failing tests
// against the projection-bypass contract.
//
// Contract (Phase 0b):
//   `unbrowse_execute` accepts `path`, `extract`, and `limit` flags that
//   project the response BEFORE the 25KB wire-budget diet fires. A 565KB
//   fixture with `limit:297` should return all 297 items unmodified (no
//   `truncated:true`); without projection the diet trims and marks the
//   payload. Projection substitutes for the diet, it does not exempt the
//   final wire size from the 25KB budget.

describe("MCP payload projection bypass (Phase 0b)", () => {
  test.todo(
    "execute with limit:297 against a 565KB fixture returns 297 items and no truncated marker",
  );
  test.todo(
    "execute with no projection on same fixture DOES truncate (diet fires, truncated:true present)",
  );
  test.todo(
    "execute with path:\"data.items[*].id\" projects only scalars and stays under wire budget",
  );
  test.todo(
    "projected result body stays under 25KB wire size (projection substitutes for diet, not exempts)",
  );
});
