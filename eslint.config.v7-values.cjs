/**
 * v7 value-store lint rule: no-tostring-on-secret.
 *
 * Substrate:
 *   .planning/v7-rip/VALUE_STORE_ADAPTERS.md §"Security invariants" #5
 *   "v7 forbids `.toString()` on a resolved value Buffer in the fill path;
 *    the linter rule `no-tostring-on-secret` enforces it."
 *
 * Rationale: a `Uint8Array.toString()` on a secret buffer triggers V8 to
 * intern the cleartext as a JS string, which (a) defeats the memzero pass
 * in `src/values/memzero.ts` and (b) leaks the value into stack traces /
 * any subsequent string concatenation. The type system makes the call
 * useless (`Uint8Array.toString()` returns `"0,1,2,..."`, not cleartext)
 * but the lint rule keeps developer intent visible.
 *
 * Scope: identifiers ending in `Value`, `Resolved`, or `Secret`. Matches
 *   resolvedValue.toString()
 *   await using v = await resolve(...); v.value.toString();
 *   const mySecret = ...; mySecret.toString();
 *
 * Allow-list: the ONE CDP-boundary site documented in
 *   .planning/v7-rip/VALUE_STORE_ADAPTERS.md §"Fill-time flow" step 7
 * uses:
 *   // eslint-disable-next-line no-tostring-on-secret -- CDP boundary
 *
 * This file is a STANDALONE config (no full eslint pipeline yet) since the
 * project's `.eslintrc.json` is currently a placeholder ("# ESLint Config").
 * When the broader eslint pipeline lands, fold this rule into the main
 * config via `extends`. Until then: `npx eslint -c eslint.config.v7-values.cjs src/values src/cdp src/cli-v7`.
 */

"use strict";

/** @type {import('eslint').Linter.FlatConfig[]} */
module.exports = [
  {
    files: ["src/values/**/*.ts", "src/cdp/**/*.ts", "src/cli-v7/**/*.ts"],
    rules: {
      // Forbids `<ident-ending-in-Value|Resolved|Secret>.toString()`. Use
      // `no-restricted-syntax` with an AST selector — robust under TS via
      // @typescript-eslint/parser when available, falls back to acorn for
      // .js. The selector matches MemberExpression where `object.name`
      // ends in Value/Resolved/Secret and `property.name === 'toString'`,
      // OR ChainExpression (resolvedValue?.toString()).
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='toString'][callee.object.name=/.*(Value|Resolved|Secret)$/]",
          message:
            "no-tostring-on-secret: do not call .toString() on a resolved secret buffer (VALUE_STORE_ADAPTERS §Security invariants #5). Pass the Uint8Array to the CDP primitive instead. Allow-list at the single CDP-boundary site with `// eslint-disable-next-line no-tostring-on-secret -- CDP boundary`.",
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='toString'][callee.object.type='MemberExpression'][callee.object.property.name=/^(value|signature|walletPubkey)$/]",
          message:
            "no-tostring-on-secret: do not call .toString() on ResolvedValue.value / .signature / .walletPubkey (VALUE_STORE_ADAPTERS §Security invariants #5). Single allow-list site at the CDP boundary; see fill-time flow step 7.",
        },
      ],
    },
  },
];
