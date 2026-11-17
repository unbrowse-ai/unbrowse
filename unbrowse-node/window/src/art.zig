//! The window's art: the U mark and Uni, the film's robot, in its moods
//! (src/art, embedded by build.zig). Uni is the
//! face of what the node is doing; the word beside it carries the meaning.
const std = @import("std");
const nanoui = @import("nanoui");
const ui = nanoui.ui;

pub const Mood = enum { neutral, happy, sleepy, nervous, surprised, idea, thinking, proud, determined };

const moods = [_][]const u8{
    @embedFile("uni_neutral"),
    @embedFile("uni_happy"),
    @embedFile("uni_sleepy"),
    @embedFile("uni_nervous"),
    @embedFile("uni_surprised"),
    @embedFile("uni_idea"),
    @embedFile("uni_thinking"),
    @embedFile("uni_proud"),
    @embedFile("uni_determined"),
};

const keys = blk: {
    var k: [moods.len][]const u8 = undefined;
    for (std.enums.values(Mood), 0..) |m, i| k[i] = "uni-" ++ @tagName(m);
    break :blk k;
};

const mark_png = @embedFile("art_mark");

/// Uni in `mood`, `width` points wide (its height follows the picture).
pub fn uni(c: *ui.Context, mood: Mood, width: f32) void {
    _ = ui.image(c, .{ .key = keys[@intFromEnum(mood)], .bytes = moods[@intFromEnum(mood)], .max_width = width, .max_height = width * 2, .radius = 0, .scale = 1 });
}

/// The U mark, `size` points square.
pub fn mark(c: *ui.Context, size: f32) void {
    _ = ui.image(c, .{ .key = "mark", .bytes = mark_png, .max_width = size, .max_height = size, .radius = 0, .scale = 1 });
}
