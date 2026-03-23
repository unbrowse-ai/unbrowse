const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Main executable
    const exe = b.addExecutable(.{
        .name = "kuri",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    b.installArtifact(exe);

    // Run step
    const run_exe = b.addRunArtifact(exe);
    run_exe.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_exe.addArgs(args);
    }
    const run_step = b.step("run", "Run the application");
    run_step.dependOn(&run_exe.step);

    // Tests
    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);


    // merjs E2E test binary
    const merjs_e2e = b.addExecutable(.{
        .name = "merjs-e2e",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/test/merjs_e2e.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(merjs_e2e);
    const run_merjs_e2e = b.addRunArtifact(merjs_e2e);
    const merjs_e2e_step = b.step("merjs-e2e", "Run merjs E2E tests (requires merjs + kuri + Chrome live)");
    merjs_e2e_step.dependOn(&run_merjs_e2e.step);

    // QuickJS dependency
    const quickjs_dep = b.dependency("quickjs", .{
        .target = target,
        .optimize = optimize,
    });

    // kuri-fetch standalone CLI (no Chrome dependency)
    const fetch_mod = b.createModule(.{
        .root_source_file = b.path("src/fetch_main.zig"),
        .target = target,
        .optimize = optimize,
    });
    fetch_mod.addImport("quickjs", quickjs_dep.module("quickjs"));
    const fetch_exe = b.addExecutable(.{
        .name = "kuri-fetch",
        .root_module = fetch_mod,
    });
    fetch_exe.linkLibrary(quickjs_dep.artifact("quickjs-ng"));
    b.installArtifact(fetch_exe);
    const run_fetch = b.addRunArtifact(fetch_exe);
    run_fetch.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_fetch.addArgs(args);
    }
    const fetch_step = b.step("fetch", "Run kuri-fetch standalone CLI");
    fetch_step.dependOn(&run_fetch.step);

    // kuri-fetch tests
    const fetch_test_mod = b.createModule(.{
        .root_source_file = b.path("src/fetch_main.zig"),
        .target = target,
        .optimize = optimize,
    });
    fetch_test_mod.addImport("quickjs", quickjs_dep.module("quickjs"));
    const fetch_tests = b.addTest(.{
        .root_module = fetch_test_mod,
    });
    fetch_tests.linkLibrary(quickjs_dep.artifact("quickjs-ng"));
    const run_fetch_tests = b.addRunArtifact(fetch_tests);
    const fetch_test_step = b.step("test-fetch", "Run kuri-fetch unit tests");
    fetch_test_step.dependOn(&run_fetch_tests.step);

    // kuri-browse interactive terminal browser
    const browse_exe = b.addExecutable(.{
        .name = "kuri-browse",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/browse_main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(browse_exe);
    const run_browse = b.addRunArtifact(browse_exe);
    run_browse.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_browse.addArgs(args);
    }
    const browse_step = b.step("browse", "Run kuri-browse interactive terminal browser");
    browse_step.dependOn(&run_browse.step);

    // kuri-browse tests
    const browse_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/browse_main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_browse_tests = b.addRunArtifact(browse_tests);
    const browse_test_step = b.step("test-browse", "Run kuri-browse unit tests");
    browse_test_step.dependOn(&run_browse_tests.step);

    // Benchmarks
    const bench = b.addExecutable(.{
        .name = "kuri-bench",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/bench.zig"),
            .target = target,
            .optimize = .ReleaseFast,
        }),
    });
    const run_bench = b.addRunArtifact(bench);
    const bench_step = b.step("bench", "Run benchmarks");
    bench_step.dependOn(&run_bench.step);

    // kuri-agent: scriptable agentic CLI (no HTTP server)
    const agent_exe = b.addExecutable(.{
        .name = "kuri-agent",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/agent_main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(agent_exe);
    const run_agent = b.addRunArtifact(agent_exe);
    run_agent.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_agent.addArgs(args);
    }
    const agent_step = b.step("agent", "Run kuri-agent scriptable CLI");
    agent_step.dependOn(&run_agent.step);
}
