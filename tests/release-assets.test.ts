import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const GITMODULES = path.join(ROOT, ".gitmodules");
const RELEASE_WORKFLOW = path.join(ROOT, ".github", "workflows", "release.yml");
const BUILD_SCRIPT = path.join(ROOT, "scripts", "build-binaries.sh");
const ROOT_INSTALLER = path.join(ROOT, "install.sh");
const PUBLIC_INSTALLER = path.join(ROOT, "frontend", "public", "install.sh");

describe("release asset wiring", () => {
  it("tracks the Kuri submodule against the Windows-port branch", () => {
    const gitmodules = readFileSync(GITMODULES, "utf8");

    expect(gitmodules).toContain('[submodule "submodules/kuri"]');
    expect(gitmodules).toContain("branch = feat/windows-port-wave-1");
  });

  it("uploads compiled CLI binaries to the GitHub release", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf8");
    const buildScript = readFileSync(BUILD_SCRIPT, "utf8");

    expect(workflow).toContain("name: Upload CLI Release Assets");
    expect(workflow).toContain("name: Verify CLI Release Assets");
    expect(workflow).toContain("name: Build Kuri Windows Broker (windows-gnu)");
    expect(workflow).toContain("zig build -Dtarget=x86_64-windows-gnu");
    expect(workflow).not.toContain("zig build -Dtarget=x86_64-windows-gnu -Doptimize=ReleaseSafe");
    expect(workflow).toContain("name: kuri-win-x64");
    expect(workflow).toContain("needs: build-kuri-win-x64");
    expect(workflow).toContain("matrix:");
    expect(workflow).toContain("target: [darwin-arm64, darwin-x64, linux-arm64, linux-x64, win-x64]");
    expect(workflow).toContain("bash scripts/build-binaries.sh ${{ matrix.target }}");
    expect(workflow).toContain("TARGET_REPO=\"unbrowse-ai/unbrowse\"");
    expect(workflow).toContain("ASSETS=(");
    expect(workflow).toContain('"dist/unbrowse-v${VERSION}-win-x64.tar.gz"');
    expect(workflow).toContain('gh release upload "$TAG" --repo "$TARGET_REPO" "${ASSETS[@]}" --clobber');
    expect(workflow).toContain("UNBROWSE_RELEASE_REPO: unbrowse-ai/unbrowse");
    expect(workflow).toContain("run: node scripts/verify-release-assets.mjs");
    expect(workflow).toContain("needs: [verify-release-assets]");
    expect(workflow).toContain("UNBROWSE_RELEASE_MANIFEST_SIGNING_SECRET: ${{ secrets.UNBROWSE_RELEASE_MANIFEST_SIGNING_SECRET }}");
    expect(workflow).toContain("bash scripts/ensure-submodules.sh submodules/kuri");
    expect(buildScript).toContain('VERSION_TAG="${UNBROWSE_RELEASE_TAG:-v$(grep -m1');
    expect(buildScript).toContain('local archive="$DIST_DIR/unbrowse-$VERSION_TAG-$target.tar.gz"');
  });

  it("keeps the repo and public installers on the release-tarball flow", () => {
    const rootInstaller = readFileSync(ROOT_INSTALLER, "utf8");
    const publicInstaller = readFileSync(PUBLIC_INSTALLER, "utf8");

    expect(rootInstaller).toBe(publicInstaller);
    expect(rootInstaller).toContain('https://api.github.com/repos/${REPO}/releases/latest');
    expect(rootInstaller).toContain('unbrowse-${VERSION}-${TARGET}.tar.gz');
    expect(rootInstaller).toContain('SETUP_ARGS="$SETUP_ARGS --non-interactive --skip-wallet-setup"');
    expect(rootInstaller).toContain('SETUP_ARGS="$SETUP_ARGS --accept-tos"');
    expect(rootInstaller).toContain('SETUP_ARGS="$SETUP_ARGS --agent-email $UNBROWSE_AGENT_EMAIL"');
    expect(rootInstaller).toContain('Skipping interactive setup: non-interactive install requires UNBROWSE_TOS_ACCEPTED=1.');
    expect(rootInstaller).toContain('npx -y skills add unbrowse-ai/unbrowse --yes');
    expect(rootInstaller).toContain('UNBROWSE_SKIP_SKILLS_REGISTRY');
  });
});
