const std = @import("std");

pub const Row = struct {
    label: []const u8,
    value: []const u8,
    sub: ?[]const u8 = null,
};

pub const LaneItem = struct {
    label: []const u8,
    value: f64,
    rate: ?f64 = null,
};

pub const TableRow = struct {
    primary: []const u8,
    secondary: ?[]const u8 = null,
    statA: []const u8,
    statB: []const u8,
    statC: []const u8,
};

pub fn buildSpecStream(allocator: std.mem.Allocator, prompt: []const u8, source: []const u8, payload: std.json.Value) ![]u8 {
    var out: std.io.Writer.Allocating = .init(allocator);

    var root_children = std.ArrayList([]const u8){};
    defer root_children.deinit(allocator);

    var left_children = std.ArrayList([]const u8){};
    defer left_children.deinit(allocator);

    var right_children = std.ArrayList([]const u8){};
    defer right_children.deinit(allocator);

    try writeElementPatch(allocator, &out, "prompt", "PromptDeck", .{
        .prompt = if (prompt.len > 0) prompt else "show me what matters in this data",
        .source = if (source.len > 0) source else "manual",
    }, &.{});
    try root_children.append(allocator, "prompt");

    const top_metrics = try collectTopMetrics(allocator, payload, 8);
    defer allocator.free(top_metrics);
    if (top_metrics.len > 0) {
        try writeElementPatch(allocator, &out, "metrics", "MetricGrid", .{ .items = top_metrics }, &.{});
        try root_children.append(allocator, "metrics");
    }

    const funnel = try findBestFunnel(allocator, payload);
    defer if (funnel.items.len > 0) allocator.free(funnel.items);
    if (funnel.items.len > 0) {
        try writeElementPatch(allocator, &out, "funnel-focus", "FunnelChart", .{
            .title = funnel.title,
            .note = "auto-selected from payload",
            .items = funnel.items,
        }, &.{});
        try writeElementPatch(allocator, &out, "funnel-card", "Card", .{
            .title = funnel.title,
            .eyebrow = "funnel focus",
            .tone = "accent",
        }, &.{"funnel-focus"});
        try root_children.append(allocator, "funnel-card");
    }

    const sections = try collectSections(allocator, payload);
    defer {
        for (sections) |section| allocator.free(section.title());
        allocator.free(sections);
    }

    var section_index: usize = 0;
    for (sections) |section| {
        const body_id = try std.fmt.allocPrint(allocator, "body-{d}", .{section_index});
        defer allocator.free(body_id);
        const card_id = try std.fmt.allocPrint(allocator, "card-{d}", .{section_index});
        defer allocator.free(card_id);

        switch (section.kind()) {
            .metric_grid => {
                defer allocator.free(section.rows());
                try writeElementPatch(allocator, &out, body_id, "MetricGrid", .{ .items = section.rows() }, &.{});
            },
            .funnel_chart => {
                defer allocator.free(section.items());
                try writeElementPatch(allocator, &out, body_id, "FunnelChart", .{
                    .title = section.title(),
                    .note = section.note(),
                    .items = section.items(),
                }, &.{});
            },
            .data_table => {
                defer allocator.free(section.table_rows());
                try writeElementPatch(allocator, &out, body_id, "DataTable", .{
                    .title = section.title(),
                    .rows = section.table_rows(),
                }, &.{});
            },
            .json_preview => {
                defer allocator.free(section.preview());
                try writeElementPatch(allocator, &out, body_id, "JsonPreview", .{ .content = section.preview() }, &.{});
            },
        }

        try writeElementPatch(allocator, &out, card_id, "Card", .{
            .title = section.title(),
            .eyebrow = section.eyebrow(),
            .tone = section.tone(),
        }, &.{body_id});

        if (section_index % 2 == 0) {
            try left_children.append(allocator, try allocator.dupe(u8, card_id));
        } else {
            try right_children.append(allocator, try allocator.dupe(u8, card_id));
        }
        section_index += 1;
    }

    try writeElementPatch(allocator, &out, "left", "Stack", .{ .gap = "md", .columns = @as(?u8, null) }, left_children.items);
    try writeElementPatch(allocator, &out, "right", "Stack", .{ .gap = "md", .columns = @as(?u8, null) }, right_children.items);
    try writeElementPatch(allocator, &out, "grid", "Stack", .{ .gap = "lg", .columns = @as(?u8, 2) }, &.{"left", "right"});
    try root_children.append(allocator, "grid");
    try writeElementPatch(allocator, &out, "root-stack", "Stack", .{ .gap = "lg", .columns = @as(?u8, null) }, root_children.items);
    try writePatch(&out, "/root", "root-stack");

    return out.toOwnedSlice();
}

const FunnelSection = struct {
    title: []const u8,
    items: []LaneItem,
};

const SectionKind = enum {
    metric_grid,
    funnel_chart,
    data_table,
    json_preview,
};

const Section = union(SectionKind) {
    metric_grid: struct {
        title: []const u8,
        eyebrow: []const u8,
        tone: []const u8,
        rows: []Row,
    },
    funnel_chart: struct {
        title: []const u8,
        eyebrow: []const u8,
        tone: []const u8,
        note: []const u8,
        items: []LaneItem,
    },
    data_table: struct {
        title: []const u8,
        eyebrow: []const u8,
        tone: []const u8,
        table_rows: []TableRow,
    },
    json_preview: struct {
        title: []const u8,
        eyebrow: []const u8,
        tone: []const u8,
        preview: []const u8,
    },

    fn kind(self: Section) SectionKind {
        return std.meta.activeTag(self);
    }

    fn title(self: Section) []const u8 {
        return switch (self) {
            inline else => |value| value.title,
        };
    }

    fn eyebrow(self: Section) []const u8 {
        return switch (self) {
            inline else => |value| value.eyebrow,
        };
    }

    fn tone(self: Section) []const u8 {
        return switch (self) {
            inline else => |value| value.tone,
        };
    }

    fn note(self: Section) []const u8 {
        return switch (self) {
            .funnel_chart => |value| value.note,
            else => "",
        };
    }

    fn rows(self: Section) []Row {
        return switch (self) {
            .metric_grid => |value| value.rows,
            else => &.{},
        };
    }

    fn items(self: Section) []LaneItem {
        return switch (self) {
            .funnel_chart => |value| value.items,
            else => &.{},
        };
    }

    fn table_rows(self: Section) []TableRow {
        return switch (self) {
            .data_table => |value| value.table_rows,
            else => &.{},
        };
    }

    fn preview(self: Section) []const u8 {
        return switch (self) {
            .json_preview => |value| value.preview,
            else => "",
        };
    }
};

fn collectSections(allocator: std.mem.Allocator, payload: std.json.Value) ![]Section {
    var sections = std.ArrayList(Section){};
    defer sections.deinit(allocator);

    switch (payload) {
        .object => |object| {
            var it = object.iterator();
            while (it.next()) |entry| {
                const title = try titleize(allocator, entry.key_ptr.*);
                const value = entry.value_ptr.*;

                switch (value) {
                    .object => {
                        const rows = try collectPrimitiveRows(allocator, value, 8);
                        if (rows.len > 0) {
                            try sections.append(allocator, .{ .metric_grid = .{
                                .title = title,
                                .eyebrow = "object",
                                .tone = "default",
                                .rows = rows,
                            } });
                        } else {
                            const preview = try stringifyValue(allocator, value, 1400);
                            try sections.append(allocator, .{ .json_preview = .{
                                .title = title,
                                .eyebrow = "object",
                                .tone = "default",
                                .preview = preview,
                            } });
                        }
                    },
                    .array => {
                        if (try maybeLaneItems(allocator, title, value)) |items| {
                            if (looksLikeFunnel(title, items)) {
                                try sections.append(allocator, .{ .funnel_chart = .{
                                    .title = title,
                                    .eyebrow = "array",
                                    .tone = "accent",
                                    .note = "derived from structured rows",
                                    .items = items,
                                } });
                            } else {
                                const rows = try laneItemsToRows(allocator, items);
                                allocator.free(items);
                                try sections.append(allocator, .{ .metric_grid = .{
                                    .title = title,
                                    .eyebrow = "array",
                                    .tone = "default",
                                    .rows = rows,
                                } });
                            }
                        } else if (try maybeTableRows(allocator, value)) |rows| {
                            try sections.append(allocator, .{ .data_table = .{
                                .title = title,
                                .eyebrow = "array",
                                .tone = "default",
                                .table_rows = rows,
                            } });
                        } else {
                            const preview = try stringifyValue(allocator, value, 1400);
                            try sections.append(allocator, .{ .json_preview = .{
                                .title = title,
                                .eyebrow = "array",
                                .tone = "default",
                                .preview = preview,
                            } });
                        }
                    },
                    else => {},
                }
                if (sections.items.len >= 8) break;
            }
        },
        .array => {
            const title = try allocator.dupe(u8, "Input");
            if (try maybeLaneItems(allocator, title, payload)) |items| {
                try sections.append(allocator, .{ .funnel_chart = .{
                    .title = title,
                    .eyebrow = "array",
                    .tone = "accent",
                    .note = "derived from payload",
                    .items = items,
                } });
            } else if (try maybeTableRows(allocator, payload)) |rows| {
                try sections.append(allocator, .{ .data_table = .{
                    .title = title,
                    .eyebrow = "array",
                    .tone = "default",
                    .table_rows = rows,
                } });
            } else {
                const preview = try stringifyValue(allocator, payload, 1400);
                try sections.append(allocator, .{ .json_preview = .{
                    .title = title,
                    .eyebrow = "array",
                    .tone = "default",
                    .preview = preview,
                } });
            }
        },
        else => {},
    }

    return sections.toOwnedSlice(allocator);
}

fn collectTopMetrics(allocator: std.mem.Allocator, payload: std.json.Value, limit: usize) ![]Row {
    return collectPrimitiveRows(allocator, payload, limit);
}

fn collectPrimitiveRows(allocator: std.mem.Allocator, payload: std.json.Value, limit: usize) ![]Row {
    var rows = std.ArrayList(Row){};
    defer rows.deinit(allocator);

    if (payload != .object) return allocator.alloc(Row, 0);
    var it = payload.object.iterator();
    while (it.next()) |entry| {
        if (rows.items.len >= limit) break;
        const child = entry.value_ptr.*;
        if (!isPrimitive(child)) continue;
        try rows.append(allocator, .{
            .label = try titleize(allocator, entry.key_ptr.*),
            .value = try formatValue(allocator, child),
            .sub = if (child == .integer or child == .float) "number" else null,
        });
    }
    return rows.toOwnedSlice(allocator);
}

fn findBestFunnel(allocator: std.mem.Allocator, payload: std.json.Value) !FunnelSection {
    if (payload == .object) {
        var it = payload.object.iterator();
        while (it.next()) |entry| {
            if (entry.value_ptr.* != .array) continue;
            const title = try titleize(allocator, entry.key_ptr.*);
            if (try maybeLaneItems(allocator, title, entry.value_ptr.*)) |items| {
                if (looksLikeFunnel(title, items)) return .{ .title = title, .items = items };
                allocator.free(items);
            }
        }
    }
    return .{ .title = "", .items = &.{} };
}

fn maybeLaneItems(allocator: std.mem.Allocator, title: []const u8, payload: std.json.Value) !?[]LaneItem {
    if (payload != .array or payload.array.items.len == 0) return null;
    const items = payload.array.items;

    if (allNumbers(items)) {
        var out = std.ArrayList(LaneItem){};
        defer out.deinit(allocator);
        for (items, 0..) |item, i| {
            try out.append(allocator, .{
                .label = try std.fmt.allocPrint(allocator, "{s} {d}", .{ title, i + 1 }),
                .value = numberValue(item),
                .rate = null,
            });
        }
        return @as(?[]LaneItem, try out.toOwnedSlice(allocator));
    }

    if (!allObjects(items)) return null;
    var out = std.ArrayList(LaneItem){};
    defer out.deinit(allocator);
    for (items) |item| {
        const object = item.object;
        const label = firstString(object, &.{ "label", "name", "stage", "key", "title", "date" }) orelse return null;
        const value = firstNumber(object, &.{ "value", "count", "users", "sessions", "active", "installs", "revenue" }) orelse return null;
        try out.append(allocator, .{
            .label = try titleize(allocator, label),
            .value = value,
            .rate = firstNumber(object, &.{ "rate", "share", "conversion_from_previous", "install_copy_rate_after_view" }),
        });
    }
    return @as(?[]LaneItem, try out.toOwnedSlice(allocator));
}

fn maybeTableRows(allocator: std.mem.Allocator, payload: std.json.Value) !?[]TableRow {
    if (payload != .array or payload.array.items.len == 0 or !allObjects(payload.array.items)) return null;
    var rows = std.ArrayList(TableRow){};
    defer rows.deinit(allocator);

    for (payload.array.items[0..@min(payload.array.items.len, 8)]) |item| {
        const object = item.object;
        const primary_key = preferredKey(object, &.{ "name", "label", "title", "campaign_id", "key", "date", "id" }) orelse blk: {
            var it = object.iterator();
            break :blk if (it.next()) |entry| entry.key_ptr.* else "row";
        };
        const primary_value = if (object.get(primary_key)) |value| try formatValue(allocator, value) else try allocator.dupe(u8, primary_key);

        var stat_values = [_][]const u8{ "—", "—", "—" };
        var stat_index: usize = 0;
        var extra_fields: usize = 0;
        var it = object.iterator();
        while (it.next()) |entry| {
            if (std.mem.eql(u8, entry.key_ptr.*, primary_key)) continue;
            if (stat_index < stat_values.len) {
                stat_values[stat_index] = try std.fmt.allocPrint(allocator, "{s}: {s}", .{
                    try titleize(allocator, entry.key_ptr.*),
                    try formatValue(allocator, entry.value_ptr.*),
                });
            } else {
                extra_fields += 1;
            }
            stat_index += 1;
        }

        try rows.append(allocator, .{
            .primary = primary_value,
            .secondary = if (extra_fields > 0) try std.fmt.allocPrint(allocator, "{d} more fields", .{extra_fields}) else null,
            .statA = stat_values[0],
            .statB = stat_values[1],
            .statC = stat_values[2],
        });
    }

    return @as(?[]TableRow, try rows.toOwnedSlice(allocator));
}

fn laneItemsToRows(allocator: std.mem.Allocator, items: []LaneItem) ![]Row {
    var rows = std.ArrayList(Row){};
    defer rows.deinit(allocator);
    for (items[0..@min(items.len, 8)]) |item| {
        try rows.append(allocator, .{
            .label = item.label,
            .value = try std.fmt.allocPrint(allocator, "{d}", .{@as(i64, @intFromFloat(item.value))}),
            .sub = if (item.rate) |rate| try std.fmt.allocPrint(allocator, "{d}%", .{@as(i64, @intFromFloat(rate * 100.0))}) else null,
        });
    }
    return rows.toOwnedSlice(allocator);
}

fn looksLikeFunnel(title: []const u8, items: []LaneItem) bool {
    if (items.len < 3) return false;
    const lower = std.ascii.allocLowerString(std.heap.page_allocator, title) catch return false;
    defer std.heap.page_allocator.free(lower);
    if (std.mem.indexOf(u8, lower, "funnel") != null) return true;
    if (std.mem.indexOf(u8, lower, "stage") != null) return true;
    if (std.mem.indexOf(u8, lower, "drop") != null) return true;
    if (std.mem.indexOf(u8, lower, "install") != null) return true;
    if (std.mem.indexOf(u8, lower, "retention") != null) return true;
    if (std.mem.indexOf(u8, lower, "activation") != null) return true;
    var previous = items[0].value;
    for (items[1..]) |item| {
        if (item.value > previous) return false;
        previous = item.value;
    }
    return true;
}

fn titleize(allocator: std.mem.Allocator, input: []const u8) ![]u8 {
    var out = std.ArrayList(u8){};
    defer out.deinit(allocator);
    var wrote_space = false;
    for (input, 0..) |char, i| {
        const normalized = switch (char) {
            '_', '-' => ' ',
            else => char,
        };
        if (normalized == ' ') {
            if (!wrote_space and out.items.len > 0) {
                try out.append(allocator, ' ');
                wrote_space = true;
            }
            continue;
        }
        wrote_space = false;
        try out.append(allocator, if (i == 0) std.ascii.toUpper(normalized) else normalized);
    }
    return out.toOwnedSlice(allocator);
}

fn formatValue(allocator: std.mem.Allocator, value: std.json.Value) ![]const u8 {
    return switch (value) {
        .integer => |v| std.fmt.allocPrint(allocator, "{d}", .{v}),
        .float => |v| std.fmt.allocPrint(allocator, "{d:.2}", .{v}),
        .string => |v| allocator.dupe(u8, v),
        .bool => |v| allocator.dupe(u8, if (v) "true" else "false"),
        .null => allocator.dupe(u8, "null"),
        else => stringifyValue(allocator, value, 240),
    };
}

fn stringifyValue(allocator: std.mem.Allocator, value: std.json.Value, max_len: usize) ![]u8 {
    var out: std.io.Writer.Allocating = .init(allocator);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.write(value);
    const raw = try out.toOwnedSlice();
    if (raw.len <= max_len) return raw;
    return allocator.dupe(u8, raw[0..max_len]);
}

fn writePatch(out: *std.io.Writer.Allocating, path: []const u8, value: anytype) !void {
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.beginObject();
    try jw.objectField("op");
    try jw.write("add");
    try jw.objectField("path");
    try jw.write(path);
    try jw.objectField("value");
    try jw.write(value);
    try jw.endObject();
    try out.writer.writeByte('\n');
}

fn writeElementPatch(allocator: std.mem.Allocator, out: *std.io.Writer.Allocating, id: []const u8, element_type: []const u8, props: anytype, children: []const []const u8) !void {
    const path = try std.fmt.allocPrint(allocator, "/elements/{s}", .{id});
    defer allocator.free(path);
    try writePatch(out, path, .{
        .type = element_type,
        .props = props,
        .children = children,
    });
}

fn isPrimitive(value: std.json.Value) bool {
    return switch (value) {
        .null, .bool, .integer, .float, .string => true,
        else => false,
    };
}

fn allNumbers(items: []const std.json.Value) bool {
    for (items) |item| {
        if (!(item == .integer or item == .float)) return false;
    }
    return true;
}

fn allObjects(items: []const std.json.Value) bool {
    for (items) |item| {
        if (item != .object) return false;
    }
    return true;
}

fn numberValue(value: std.json.Value) f64 {
    return switch (value) {
        .integer => |v| @floatFromInt(v),
        .float => |v| v,
        else => 0,
    };
}

fn preferredKey(object: std.json.ObjectMap, preferred: []const []const u8) ?[]const u8 {
    for (preferred) |key| {
        if (object.get(key) != null) return key;
    }
    return null;
}

fn firstString(object: std.json.ObjectMap, preferred: []const []const u8) ?[]const u8 {
    for (preferred) |key| {
        if (object.get(key)) |value| {
            if (value == .string and value.string.len > 0) return value.string;
        }
    }
    return null;
}

fn firstNumber(object: std.json.ObjectMap, preferred: []const []const u8) ?f64 {
    for (preferred) |key| {
        if (object.get(key)) |value| {
            if (value == .integer or value == .float) return numberValue(value);
        }
    }
    return null;
}
