import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const workflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "deploy.yml"), "utf8");
const releaseWorkflow = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
const primitive = readFileSync(join(import.meta.dir, "..", "scripts", "publish-npm-via-public-oidc.sh"), "utf8");

describe("preview npm publication truth", () => {
  test("dispatches the named public OIDC workflow without an npm publish token", () => {
    const job = workflow.slice(workflow.indexOf("  publish-preview-cli:"));
    expect(job).toContain('bash scripts/publish-npm-via-public-oidc.sh "$TARBALL" "$TAG"');
    expect(job).not.toContain("NODE_AUTH_TOKEN:");
    expect(job).not.toContain("npm publish \"$TARBALL\"");
    expect(releaseWorkflow).toContain('bash scripts/publish-npm-via-public-oidc.sh "$TARBALL" "${GITHUB_REF_NAME}"');
    expect(releaseWorkflow).not.toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
  });

  test("settles only after both the exact version and preview dist-tag exist", () => {
    expect(primitive).toContain('npm view "${PACKAGE_NAME}@${VERSION}" version');
    expect(primitive).toContain('npm view "$PACKAGE_NAME" "dist-tags.${NPM_TAG}"');
    expect(primitive).toContain('if [ "$ACTUAL_TAG" != "$VERSION" ]');
    expect(primitive).toContain("dispatch alone is not release evidence");
  });

  test("fails closed with the exact external trusted-publisher contract", () => {
    expect(primitive).toContain("workflow filename=release.yml (filename only)");
    expect(primitive).toContain("environment=prod");
    expect(primitive).toContain("allowed action=npm publish");
    expect(primitive).toContain("No repository token can repair this account-side trust row.");
  });
});
