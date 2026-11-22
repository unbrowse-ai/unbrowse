const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const nanoui = b.dependency("nanoui", .{ .target = target, .optimize = optimize }).module("nanoui");

    const exe = b.addExecutable(.{ .name = "unbrowse-window", .root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "nanoui", .module = nanoui }},
    }) });
    // A window of its own on Windows, without a console window beside it.
    if (target.result.os.tag == .windows) exe.subsystem = .windows;
    // The U-magnet (app/icons, drawn by make.sh): the Dock's icon while the window runs.
    exe.root_module.addAnonymousImport("app_icon", .{ .root_source_file = b.path("../app/icons/icon.png") });
    art(b, exe.root_module);
    b.installArtifact(exe);

    // `zig build app`: Unbrowse.app in zig-out, for the Dock and Finder: the window and its icon.
    // `-Dversion=1.2.3` stamps the bundle; the release workflow passes the tag's version.
    const version = b.option([]const u8, "version", "The version Unbrowse.app reports (default 0.1.0)") orelse "0.1.0";
    const bundle = b.addWriteFiles();
    _ = bundle.addCopyFile(exe.getEmittedBin(), "Contents/MacOS/unbrowse-window");
    _ = bundle.addCopyFile(b.path("../app/icons/AppIcon.icns"), "Contents/Resources/AppIcon.icns");
    _ = bundle.add("Contents/Info.plist", b.fmt(
        \\<?xml version="1.0" encoding="UTF-8"?>
        \\<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        \\<plist version="1.0">
        \\<dict>
        \\  <key>CFBundleName</key><string>Unbrowse</string>
        \\  <key>CFBundleDisplayName</key><string>Unbrowse</string>
        \\  <key>CFBundleIdentifier</key><string>network.unbrowse.window</string>
        \\  <key>CFBundleExecutable</key><string>unbrowse-window</string>
        \\  <key>CFBundleIconFile</key><string>AppIcon</string>
        \\  <key>CFBundlePackageType</key><string>APPL</string>
        \\  <key>CFBundleShortVersionString</key><string>{s}</string>
        \\  <key>CFBundleVersion</key><string>{s}</string>
        \\  <key>LSMinimumSystemVersion</key><string>13.0</string>
        \\  <key>NSHighResolutionCapable</key><true/>
        \\  <key>CFBundleURLTypes</key>
        \\  <array><dict>
        \\    <key>CFBundleURLName</key><string>network.unbrowse.link</string>
        \\    <key>CFBundleURLSchemes</key><array><string>unbrowse</string></array>
        \\  </dict></array>
        \\</dict>
        \\</plist>
        \\
    , .{ version, version }));
    const app = b.addInstallDirectory(.{ .source_dir = bundle.getDirectory(), .install_dir = .prefix, .install_subdir = "Unbrowse.app" });
    b.step("app", "Build Unbrowse.app (the window with its icon) into zig-out").dependOn(&app.step);
    const run = b.addRunArtifact(exe);
    run.addPassthruArgs();
    b.step("run", "Run the Unbrowse window (opens its window)").dependOn(&run.step);

    // Tests render the view offscreen with ui.Tester: no window opens.
    const tests = b.addTest(.{ .root_module = b.createModule(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "nanoui", .module = nanoui }},
    }) });
    art(b, tests.root_module);
    const run_tests = b.addRunArtifact(tests);
    // With UNB_SNAP_DIR the run writes each test's frame there: the point of it, so it always runs.
    if (b.graph.environ_map.get("UNB_SNAP_DIR") != null) run_tests.has_side_effects = true;
    b.step("test", "Run the tests").dependOn(&run_tests.step);
    // `zig build test-bin`: the same tests as zig-out/bin/window-tests, unrun, for a coverage tool to run (coverage.yml).
    // Built by LLVM: kcov reads its line tables, not the ones Zig's own x86 backend writes.
    const tests_llvm = b.addTest(.{ .use_llvm = true, .root_module = b.createModule(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{.{ .name = "nanoui", .module = nanoui }},
    }) });
    art(b, tests_llvm.root_module);
    const tests_bin = b.addInstallArtifact(tests_llvm, .{ .dest_sub_path = "window-tests" });
    b.step("test-bin", "Build the tests into zig-out/bin/window-tests without running them").dependOn(&tests_bin.step);
}

/// The window's art (src/art): the U mark and Uni in each of the film's moods, as `art_mark` and `uni_<mood>`
/// (src/art.zig).
fn art(b: *std.Build, m: *std.Build.Module) void {
    m.addAnonymousImport("art_mark", .{ .root_source_file = b.path("src/art/mark.png") });
    inline for (.{ "neutral", "happy", "sleepy", "nervous", "surprised", "idea", "thinking", "proud", "determined" }) |mood| {
        m.addAnonymousImport("uni_" ++ mood, .{ .root_source_file = b.path("src/art/uni-" ++ mood ++ ".png") });
    }
}
