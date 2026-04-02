const std = @import("std");
const protocol = @import("protocol.zig");
const CdpClient = @import("client.zig").CdpClient;

/// Action kinds supported by the /action endpoint
pub const ActionKind = enum {
    click,
    @"type",
    fill,
    press,
    focus,
    hover,
    select,
    scroll,
    dblclick,
    check,
    uncheck,
    blur,

    pub fn fromString(s: []const u8) ?ActionKind {
        const map = std.StaticStringMap(ActionKind).initComptime(.{
            .{ "click", .click },
            .{ "type", .@"type" },
            .{ "fill", .fill },
            .{ "press", .press },
            .{ "focus", .focus },
            .{ "hover", .hover },
            .{ "select", .select },
            .{ "scroll", .scroll },
            .{ "dblclick", .dblclick },
            .{ "check", .check },
            .{ "uncheck", .uncheck },
            .{ "blur", .blur },
        });
        return map.get(s);
    }
};

test "ActionKind fromString" {
    try std.testing.expectEqual(ActionKind.click, ActionKind.fromString("click").?);
    try std.testing.expectEqual(ActionKind.scroll, ActionKind.fromString("scroll").?);
    try std.testing.expectEqual(@as(?ActionKind, null), ActionKind.fromString("invalid"));
}

test "ActionKind new types" {
    try std.testing.expectEqual(ActionKind.dblclick, ActionKind.fromString("dblclick").?);
    try std.testing.expectEqual(ActionKind.check, ActionKind.fromString("check").?);
    try std.testing.expectEqual(ActionKind.uncheck, ActionKind.fromString("uncheck").?);
    try std.testing.expectEqual(ActionKind.blur, ActionKind.fromString("blur").?);
}
