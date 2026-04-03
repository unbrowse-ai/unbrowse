const std = @import("std");

const SharedModules = struct {
    snapshot_data: *std.Build.Module,
    viz_store: *std.Build.Module,
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const merjs_dep = b.dependency("merjs", .{});
    const mer_mod = merjs_dep.module("mer");
    const shared = createSharedModules(b, mer_mod);

    const main_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .strip = if (optimize != .Debug) true else null,
    });
    main_mod.addImport("mer", mer_mod);
    addSharedModules(main_mod, shared);
    addDirModules(b, main_mod, mer_mod, shared, "app");
    addDirModules(b, main_mod, mer_mod, shared, "api");
    addRoutesModule(b, main_mod, mer_mod, shared);

    const exe = b.addExecutable(.{ .name = "funnel-merjs", .root_module = main_mod });
    b.installArtifact(exe);

    const codegen_exe = b.addExecutable(.{
        .name = "codegen",
        .root_module = b.createModule(.{
            .root_source_file = merjs_dep.path("tools/codegen.zig"),
            .target = b.graph.host,
            .optimize = .Debug,
        }),
    });
    const run_codegen = b.addRunArtifact(codegen_exe);
    run_codegen.setCwd(b.path("."));
    b.step("codegen", "Regenerate src/generated/routes.zig").dependOn(&run_codegen.step);

    exe.step.dependOn(&run_codegen.step);

    const run_exe = b.addRunArtifact(exe);
    run_exe.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_exe.addArgs(args);
    b.step("serve", "Start the dev server").dependOn(&run_exe.step);

    if (target.result.os.tag == .macos) {
        const desktop_mod = b.createModule(.{
            .root_source_file = b.path("src/desktop.zig"),
            .target = target,
            .optimize = optimize,
            .strip = if (optimize != .Debug) true else null,
        });
        desktop_mod.addImport("mer", mer_mod);
        addSharedModules(desktop_mod, shared);
        addDirModules(b, desktop_mod, mer_mod, shared, "app");
        addDirModules(b, desktop_mod, mer_mod, shared, "api");
        addRoutesModule(b, desktop_mod, mer_mod, shared);

        const desktop_exe = b.addExecutable(.{ .name = "unbrowse-visual-lab", .root_module = desktop_mod });
        desktop_exe.linkFramework("AppKit");
        desktop_exe.linkFramework("WebKit");
        desktop_exe.linkFramework("Foundation");
        desktop_exe.linkLibC();
        desktop_exe.step.dependOn(&run_codegen.step);

        const desktop_install = b.addInstallArtifact(desktop_exe, .{});
        const desktop_step = b.step("desktop", "Build native macOS desktop app bundle");
        desktop_step.dependOn(&desktop_install.step);

        const plist = b.addWriteFile("UnbrowseVisualLab.app/Contents/Info.plist",
            \\<?xml version="1.0" encoding="UTF-8"?>
            \\<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            \\<plist version="1.0">
            \\<dict>
            \\  <key>CFBundleExecutable</key>    <string>unbrowse-visual-lab</string>
            \\  <key>CFBundleIdentifier</key>    <string>ai.unbrowse.visual-lab</string>
            \\  <key>CFBundleName</key>          <string>UnbrowseVisualLab</string>
            \\  <key>CFBundleVersion</key>       <string>0.1.0</string>
            \\  <key>NSHighResolutionCapable</key><true/>
            \\  <key>NSPrincipalClass</key>      <string>NSApplication</string>
            \\</dict>
            \\</plist>
        );
        const bundle_bin = b.addInstallFile(
            desktop_exe.getEmittedBin(),
            "UnbrowseVisualLab.app/Contents/MacOS/unbrowse-visual-lab",
        );
        bundle_bin.step.dependOn(&desktop_install.step);
        const bundle_plist = b.addInstallDirectory(.{
            .source_dir = plist.getDirectory(),
            .install_dir = .prefix,
            .install_subdir = "",
        });
        desktop_step.dependOn(&bundle_bin.step);
        desktop_step.dependOn(&bundle_plist.step);
    }
}

fn createSharedModules(b: *std.Build, mer_mod: *std.Build.Module) SharedModules {
    const snapshot_data = b.createModule(.{ .root_source_file = b.path("src/snapshot_data.zig") });
    snapshot_data.addImport("mer", mer_mod);

    const viz_store = b.createModule(.{ .root_source_file = b.path("src/viz_store.zig") });

    return .{
        .snapshot_data = snapshot_data,
        .viz_store = viz_store,
    };
}

fn addRoutesModule(b: *std.Build, mod: *std.Build.Module, mer_mod: *std.Build.Module, shared: SharedModules) void {
    const routes_mod = b.createModule(.{
        .root_source_file = b.path("src/generated/routes.zig"),
    });
    routes_mod.addImport("mer", mer_mod);
    addSharedModules(routes_mod, shared);
    addDirModules(b, routes_mod, mer_mod, shared, "app");
    addDirModules(b, routes_mod, mer_mod, shared, "api");
    mod.addImport("routes", routes_mod);
}

fn addSharedModules(mod: *std.Build.Module, shared: SharedModules) void {
    mod.addImport("snapshot_data", shared.snapshot_data);
    mod.addImport("viz_store", shared.viz_store);
}

fn addDirModules(b: *std.Build, mod: *std.Build.Module, mer_mod: *std.Build.Module, shared: SharedModules, dir: []const u8) void {
    const layout_path = b.fmt("{s}/layout.zig", .{dir});
    const layout_mod: ?*std.Build.Module = blk: {
        std.fs.cwd().access(layout_path, .{}) catch break :blk null;
        const m = b.createModule(.{ .root_source_file = b.path(layout_path) });
        m.addImport("mer", mer_mod);
        mod.addImport(b.fmt("{s}/layout", .{dir}), m);
        break :blk m;
    };

    var d = std.fs.cwd().openDir(dir, .{ .iterate = true }) catch return;
    defer d.close();
    var walker = d.walk(b.allocator) catch return;
    defer walker.deinit();

    while (walker.next() catch null) |entry| {
        if (entry.kind != .file) continue;
        if (!std.mem.endsWith(u8, entry.path, ".zig")) continue;
        if (std.mem.eql(u8, entry.path, "layout.zig")) continue;

        const file_path = b.fmt("{s}/{s}", .{ dir, entry.path });
        const import_name = b.fmt("{s}/{s}", .{ dir, entry.path[0 .. entry.path.len - 4] });
        const route_mod = b.createModule(.{ .root_source_file = b.path(file_path) });
        route_mod.addImport("mer", mer_mod);
        addSharedModules(route_mod, shared);
        if (layout_mod) |lm| route_mod.addImport(b.fmt("{s}/layout", .{dir}), lm);
        mod.addImport(import_name, route_mod);
    }
}
