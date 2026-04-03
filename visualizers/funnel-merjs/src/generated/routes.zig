// GENERATED — do not edit by hand.
// Re-run `zig build codegen` to regenerate.

const Route = @import("mer").Route;

const api_esm = @import("api/esm");
const api_snapshot = @import("api/snapshot");
const api_viz = @import("api/viz");
const app_index = @import("app/index");
const app_json_render = @import("app/json-render");
const app_viz = @import("app/viz");

pub const routes: []const Route = &.{
    .{ .path = "/api/esm", .render = api_esm.render, .render_stream = if (@hasDecl(api_esm, "renderStream")) api_esm.renderStream else null, .meta = if (@hasDecl(api_esm, "meta")) api_esm.meta else .{}, .prerender = if (@hasDecl(api_esm, "prerender")) api_esm.prerender else false },
    .{ .path = "/api/snapshot", .render = api_snapshot.render, .render_stream = if (@hasDecl(api_snapshot, "renderStream")) api_snapshot.renderStream else null, .meta = if (@hasDecl(api_snapshot, "meta")) api_snapshot.meta else .{}, .prerender = if (@hasDecl(api_snapshot, "prerender")) api_snapshot.prerender else false },
    .{ .path = "/api/viz", .render = api_viz.render, .render_stream = if (@hasDecl(api_viz, "renderStream")) api_viz.renderStream else null, .meta = if (@hasDecl(api_viz, "meta")) api_viz.meta else .{}, .prerender = if (@hasDecl(api_viz, "prerender")) api_viz.prerender else false },
    .{ .path = "/", .render = app_index.render, .render_stream = if (@hasDecl(app_index, "renderStream")) app_index.renderStream else null, .meta = if (@hasDecl(app_index, "meta")) app_index.meta else .{}, .prerender = if (@hasDecl(app_index, "prerender")) app_index.prerender else false },
    .{ .path = "/json-render", .render = app_json_render.render, .render_stream = if (@hasDecl(app_json_render, "renderStream")) app_json_render.renderStream else null, .meta = if (@hasDecl(app_json_render, "meta")) app_json_render.meta else .{}, .prerender = if (@hasDecl(app_json_render, "prerender")) app_json_render.prerender else false },
    .{ .path = "/viz", .render = app_viz.render, .render_stream = if (@hasDecl(app_viz, "renderStream")) app_viz.renderStream else null, .meta = if (@hasDecl(app_viz, "meta")) app_viz.meta else .{}, .prerender = if (@hasDecl(app_viz, "prerender")) app_viz.prerender else false },
};

comptime {
    if (!@hasDecl(app_index, "meta")) @compileError("app/index.zig must export pub const meta: mer.Meta");
    if (!@hasDecl(app_json_render, "meta")) @compileError("app/json-render.zig must export pub const meta: mer.Meta");
    if (!@hasDecl(app_viz, "meta")) @compileError("app/viz.zig must export pub const meta: mer.Meta");
}

const app_layout = @import("app/layout");
pub const layout = app_layout.wrap;
pub const streamLayout = if (@hasDecl(app_layout, "streamWrap")) app_layout.streamWrap else null;
