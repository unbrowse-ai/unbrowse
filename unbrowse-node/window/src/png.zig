//! The node's pictures off the Mac: Chrome's PNGs (8-bit gray, RGB or RGBA,
//! with or without alpha, not interlaced: what `Page.startScreencast` and
//! `Page.captureScreenshot` write) to premultiplied BGRA, as the view draws.
//! The Mac's window decodes with ImageIO instead (picture.zig).
const std = @import("std");

pub const Decoded = struct { bgra: []u8, w: u32, h: u32 };

pub const Error = error{ NotImage, Unsupported, Corrupt, Size, OutOfMemory };

const signature = "\x89PNG\r\n\x1a\n";
/// The widest or tallest picture taken: the node sends at most 1280.
const max_side = 2048;

fn be32(b: []const u8) u32 {
    return std.mem.readInt(u32, b[0..4], .big);
}

pub fn decode(gpa: std.mem.Allocator, bytes: []const u8) Error!Decoded {
    if (!std.mem.startsWith(u8, bytes, signature)) return error.NotImage;
    var pos: usize = signature.len;
    var w: u32 = 0;
    var h: u32 = 0;
    var color: u8 = 0;
    var idat: std.ArrayList(u8) = .empty;
    defer idat.deinit(gpa);
    while (pos + 12 <= bytes.len) {
        const len = be32(bytes[pos..]);
        if (len > bytes.len - pos - 12) return error.Corrupt;
        const kind = bytes[pos + 4 .. pos + 8];
        const data = bytes[pos + 8 .. pos + 8 + len];
        pos += 12 + len;
        if (std.mem.eql(u8, kind, "IHDR")) {
            if (len < 13) return error.Corrupt;
            w = be32(data);
            h = be32(data[4..]);
            color = data[9];
            // 8 bits a sample, deflate, adaptive filters, no interlacing: all Chrome writes.
            if (data[8] != 8 or data[10] != 0 or data[11] != 0 or data[12] != 0) return error.Unsupported;
            if (w == 0 or h == 0 or w > max_side or h > max_side) return error.Size;
        } else if (std.mem.eql(u8, kind, "IDAT")) {
            try idat.appendSlice(gpa, data);
        } else if (std.mem.eql(u8, kind, "IEND")) break;
    }
    if (w == 0) return error.Corrupt;
    const channels: usize = switch (color) {
        0 => 1, // gray
        2 => 3, // RGB
        4 => 2, // gray and alpha
        6 => 4, // RGBA
        else => return error.Unsupported,
    };
    const stride = w * channels;
    const want = (stride + 1) * h;

    var input: std.Io.Reader = .fixed(idat.items);
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var z: std.compress.flate.Decompress = .init(&input, .zlib, &window);
    const raw = z.reader.allocRemaining(gpa, .limited(want + 1)) catch return error.Corrupt;
    defer gpa.free(raw);
    if (raw.len < want) return error.Corrupt;

    // Undo each row's filter in place: a row's bytes become the samples themselves.
    var row: usize = 0;
    while (row < h) : (row += 1) {
        const at = row * (stride + 1);
        const filter = raw[at];
        const cur = raw[at + 1 .. at + 1 + stride];
        const prev: ?[]const u8 = if (row == 0) null else raw[at - stride .. at];
        for (cur, 0..) |*x, i| {
            const a: u8 = if (i >= channels) cur[i - channels] else 0;
            const b: u8 = if (prev) |p| p[i] else 0;
            const c: u8 = if (prev != null and i >= channels) prev.?[i - channels] else 0;
            x.* +%= switch (filter) {
                0 => 0,
                1 => a,
                2 => b,
                3 => @intCast((@as(u16, a) + b) / 2),
                4 => paeth(a, b, c),
                else => return error.Corrupt,
            };
        }
    }

    const out = try gpa.alloc(u8, @as(usize, w) * h * 4);
    errdefer gpa.free(out);
    for (0..h) |y| {
        const src = raw[y * (stride + 1) + 1 ..][0..stride];
        for (0..w) |x| {
            const s = src[x * channels ..][0..channels];
            const r, const g, const bl, const al = switch (channels) {
                1 => .{ s[0], s[0], s[0], 255 },
                2 => .{ s[0], s[0], s[0], s[1] },
                3 => .{ s[0], s[1], s[2], 255 },
                else => .{ s[0], s[1], s[2], s[3] },
            };
            const d = out[(y * w + x) * 4 ..][0..4];
            d[0] = premultiply(bl, al);
            d[1] = premultiply(g, al);
            d[2] = premultiply(r, al);
            d[3] = al;
        }
    }
    return .{ .bgra = out, .w = w, .h = h };
}

fn paeth(a: u8, b: u8, c: u8) u8 {
    const p: i16 = @as(i16, a) + b - c;
    const pa = @abs(p - a);
    const pb = @abs(p - b);
    const pc = @abs(p - c);
    if (pa <= pb and pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

fn premultiply(v: u8, a: u8) u8 {
    return @intCast((@as(u16, v) * a + 127) / 255);
}

test "a PNG from Chrome decodes to its pixels" {
    const d = try decode(std.testing.allocator, @embedFile("testdata/frame.png"));
    defer std.testing.allocator.free(d.bgra);
    try std.testing.expectEqual(@as(u32, 640), d.w);
    try std.testing.expectEqual(@as(usize, d.w * d.h * 4), d.bgra.len);
    // The page's background (#f4f1ea) at its top-left corner, as BGRA.
    try std.testing.expectEqualSlices(u8, &.{ 0xea, 0xf1, 0xf4, 0xff }, d.bgra[0..4]);
    try std.testing.expectError(error.NotImage, decode(std.testing.allocator, "not a picture"));
}
