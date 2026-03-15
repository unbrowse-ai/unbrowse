const std = @import("std");
const net = std.net;
const Io = std.Io;
const crypto = std.crypto;

/// Pure Zig WebSocket client for CDP communication.
/// Implements RFC 6455: HTTP upgrade handshake, masked client frames, unmasked server reads.
pub const WebSocketClient = struct {
    allocator: std.mem.Allocator,
    stream: net.Stream,
    connected: bool,

    // Buffers owned by caller (stack or heap)
    read_buf: []u8,
    write_buf: []u8,

    pub const Error = error{
        ConnectionFailed,
        HandshakeFailed,
        WriteFailed,
        ReadFailed,
        MessageTooLarge,
        ConnectionClosed,
        InvalidFrame,
    };

    /// Connect to a WebSocket endpoint. url must be like "ws://host:port/path".
    pub fn connect(allocator: std.mem.Allocator, url: []const u8, read_buf: []u8, write_buf: []u8) !WebSocketClient {
        const parsed = try parseWsUrl(url);

        // Resolve localhost to 127.0.0.1 — resolveIp fails on some systems
        const resolved_host = if (std.mem.eql(u8, parsed.host, "localhost")) "127.0.0.1" else parsed.host;
        const address = net.Address.parseIp4(resolved_host, parsed.port) catch return Error.ConnectionFailed;
        const stream = net.tcpConnectToAddress(address) catch return Error.ConnectionFailed;
        errdefer stream.close();

        // Set read timeout so we don't block forever
        const timeout = std.posix.timeval{ .sec = 10, .usec = 0 };
        std.posix.setsockopt(stream.handle, std.posix.SOL.SOCKET, std.posix.SO.RCVTIMEO, std.mem.asBytes(&timeout)) catch {};

        var ws = WebSocketClient{
            .allocator = allocator,
            .stream = stream,
            .connected = false,
            .read_buf = read_buf,
            .write_buf = write_buf,
        };

        try ws.doHandshake(parsed.host, parsed.port, parsed.path);
        ws.connected = true;

        return ws;
    }

    /// Send a text message (masked, as required for WebSocket clients).
    pub fn sendText(self: *WebSocketClient, data: []const u8) !void {
        if (!self.connected) return Error.ConnectionFailed;
        try self.writeFrame(0x1, data); // opcode 1 = text
    }

    /// Receive the next text message. Returns slice into internal read_buf.
    /// Caller must copy if they need the data to persist across calls.
    pub fn receiveMessage(self: *WebSocketClient) ![]u8 {
        if (!self.connected) return Error.ConnectionFailed;
        return self.readFrame();
    }

    /// Receive a large message that may exceed read_buf. Allocates result.
    pub fn receiveMessageAlloc(self: *WebSocketClient, allocator: std.mem.Allocator, max_size: usize) ![]u8 {
        if (!self.connected) return Error.ConnectionFailed;
        return self.readFrameAlloc(allocator, max_size);
    }

    pub fn close(self: *WebSocketClient) void {
        if (self.connected) {
            // Send close frame (opcode 8), best effort
            self.writeFrame(0x8, &.{}) catch {};
            self.connected = false;
        }
        self.stream.close();
    }

    // --- Internal ---

    const WsUrl = struct {
        host: []const u8,
        port: u16,
        path: []const u8,
    };

    fn parseWsUrl(url: []const u8) !WsUrl {
        // Strip "ws://"
        const after_scheme = if (std.mem.startsWith(u8, url, "ws://"))
            url[5..]
        else
            return error.InvalidCharacter;

        // Find path separator
        const path_start = std.mem.indexOfScalar(u8, after_scheme, '/') orelse after_scheme.len;
        const host_port = after_scheme[0..path_start];
        const path = if (path_start < after_scheme.len) after_scheme[path_start..] else "/";

        // Split host:port
        if (std.mem.indexOfScalar(u8, host_port, ':')) |colon| {
            const host = host_port[0..colon];
            const port = std.fmt.parseInt(u16, host_port[colon + 1 ..], 10) catch return error.InvalidCharacter;
            return .{ .host = host, .port = port, .path = path };
        } else {
            return .{ .host = host_port, .port = 80, .path = path };
        }
    }

    fn doHandshake(self: *WebSocketClient, host: []const u8, port: u16, path: []const u8) !void {
        // Generate random key for Sec-WebSocket-Key
        var key_bytes: [16]u8 = undefined;
        crypto.random.bytes(&key_bytes);
        var key_buf: [24]u8 = undefined;
        const key = std.base64.standard.Encoder.encode(&key_buf, &key_bytes);

        // Build HTTP upgrade request
        var req_buf: [2048]u8 = undefined;
        const req = std.fmt.bufPrint(&req_buf,
            "GET {s} HTTP/1.1\r\n" ++
            "Host: {s}:{d}\r\n" ++
            "Upgrade: websocket\r\n" ++
            "Connection: Upgrade\r\n" ++
            "Sec-WebSocket-Key: {s}\r\n" ++
            "Sec-WebSocket-Version: 13\r\n" ++
            "\r\n", .{ path, host, port, key }) catch return Error.HandshakeFailed;

        // Send upgrade request via raw write
        self.stream.writeAll(req) catch return Error.WriteFailed;

        // Read response - look for "101 Switching Protocols"
        const n = self.stream.read(self.read_buf) catch return Error.ReadFailed;
        if (n == 0) return Error.HandshakeFailed;

        const response = self.read_buf[0..n];
        if (std.mem.indexOf(u8, response, "101") == null) {
            return Error.HandshakeFailed;
        }
    }

    fn writeFrame(self: *WebSocketClient, opcode: u8, data: []const u8) !void {
        var frame_buf: [14]u8 = undefined; // max header size
        var header_len: usize = 2;

        // Byte 0: FIN + opcode
        frame_buf[0] = 0x80 | opcode; // FIN=1

        // Byte 1: MASK=1 + payload length
        if (data.len <= 125) {
            frame_buf[1] = 0x80 | @as(u8, @intCast(data.len));
        } else if (data.len <= 65535) {
            frame_buf[1] = 0x80 | 126;
            frame_buf[2] = @intCast(data.len >> 8);
            frame_buf[3] = @intCast(data.len & 0xFF);
            header_len = 4;
        } else {
            frame_buf[1] = 0x80 | 127;
            const len64: u64 = data.len;
            inline for (0..8) |i| {
                frame_buf[2 + i] = @intCast((len64 >> @intCast(56 - i * 8)) & 0xFF);
            }
            header_len = 10;
        }

        // Generate masking key
        var mask_key: [4]u8 = undefined;
        crypto.random.bytes(&mask_key);
        @memcpy(frame_buf[header_len .. header_len + 4], &mask_key);
        header_len += 4;

        // Send header
        self.stream.writeAll(frame_buf[0..header_len]) catch return Error.WriteFailed;

        // Send masked payload in chunks to avoid allocating
        var chunk: [4096]u8 = undefined;
        var offset: usize = 0;
        while (offset < data.len) {
            const remaining = data.len - offset;
            const chunk_size = @min(remaining, chunk.len);
            @memcpy(chunk[0..chunk_size], data[offset .. offset + chunk_size]);
            // Apply mask
            for (0..chunk_size) |i| {
                chunk[i] ^= mask_key[(offset + i) % 4];
            }
            self.stream.writeAll(chunk[0..chunk_size]) catch return Error.WriteFailed;
            offset += chunk_size;
        }
    }

    fn readFrame(self: *WebSocketClient) ![]u8 {
        // Read frame header (2 bytes minimum)
        var header: [2]u8 = undefined;
        self.readExact(&header) catch return Error.ReadFailed;

        const opcode = header[0] & 0x0F;
        const masked = (header[1] & 0x80) != 0;
        var payload_len: u64 = header[1] & 0x7F;

        if (payload_len == 126) {
            var ext: [2]u8 = undefined;
            self.readExact(&ext) catch return Error.ReadFailed;
            payload_len = @as(u64, ext[0]) << 8 | ext[1];
        } else if (payload_len == 127) {
            var ext: [8]u8 = undefined;
            self.readExact(&ext) catch return Error.ReadFailed;
            payload_len = 0;
            inline for (0..8) |i| {
                payload_len |= @as(u64, ext[i]) << @intCast(56 - i * 8);
            }
        }

        // Handle close frame
        if (opcode == 0x8) {
            self.connected = false;
            return Error.ConnectionClosed;
        }

        // Handle ping - send pong
        if (opcode == 0x9) {
            if (payload_len <= self.read_buf.len) {
                const len: usize = @intCast(payload_len);
                self.readExact(self.read_buf[0..len]) catch return Error.ReadFailed;
                self.writeFrame(0xA, self.read_buf[0..len]) catch {};
            }
            return self.readFrame(); // recurse for next real message
        }

        // Skip pong
        if (opcode == 0xA) {
            if (payload_len > 0) {
                const len: usize = @intCast(payload_len);
                if (len <= self.read_buf.len) {
                    self.readExact(self.read_buf[0..len]) catch return Error.ReadFailed;
                }
            }
            return self.readFrame();
        }

        if (payload_len > self.read_buf.len) return Error.MessageTooLarge;
        const len: usize = @intCast(payload_len);

        // Read mask key if present (server shouldn't mask, but handle it)
        var mask_key: [4]u8 = undefined;
        if (masked) {
            self.readExact(&mask_key) catch return Error.ReadFailed;
        }

        // Read payload
        self.readExact(self.read_buf[0..len]) catch return Error.ReadFailed;

        // Unmask if needed
        if (masked) {
            for (0..len) |i| {
                self.read_buf[i] ^= mask_key[i % 4];
            }
        }

        return self.read_buf[0..len];
    }

    fn readFrameAlloc(self: *WebSocketClient, allocator: std.mem.Allocator, max_size: usize) ![]u8 {
        // Read frame header
        var header: [2]u8 = undefined;
        self.readExact(&header) catch return Error.ReadFailed;

        const opcode = header[0] & 0x0F;
        const masked = (header[1] & 0x80) != 0;
        var payload_len: u64 = header[1] & 0x7F;

        if (payload_len == 126) {
            var ext: [2]u8 = undefined;
            self.readExact(&ext) catch return Error.ReadFailed;
            payload_len = @as(u64, ext[0]) << 8 | ext[1];
        } else if (payload_len == 127) {
            var ext: [8]u8 = undefined;
            self.readExact(&ext) catch return Error.ReadFailed;
            payload_len = 0;
            inline for (0..8) |i| {
                payload_len |= @as(u64, ext[i]) << @intCast(56 - i * 8);
            }
        }

        if (opcode == 0x8) {
            self.connected = false;
            return Error.ConnectionClosed;
        }
        if (opcode == 0x9 or opcode == 0xA) {
            // Skip ping/pong payload
            if (payload_len > 0 and payload_len <= self.read_buf.len) {
                const len: usize = @intCast(payload_len);
                self.readExact(self.read_buf[0..len]) catch return Error.ReadFailed;
                if (opcode == 0x9) self.writeFrame(0xA, self.read_buf[0..len]) catch {};
            }
            return self.readFrameAlloc(allocator, max_size);
        }

        if (payload_len > max_size) return Error.MessageTooLarge;
        const len: usize = @intCast(payload_len);

        var mask_key: [4]u8 = undefined;
        if (masked) {
            self.readExact(&mask_key) catch return Error.ReadFailed;
        }

        const buf = try allocator.alloc(u8, len);
        errdefer allocator.free(buf);

        self.readExact(buf) catch return Error.ReadFailed;

        if (masked) {
            for (0..len) |i| {
                buf[i] ^= mask_key[i % 4];
            }
        }

        return buf;
    }

    fn readExact(self: *WebSocketClient, buf: []u8) !void {
        var total: usize = 0;
        while (total < buf.len) {
            const n = self.stream.read(buf[total..]) catch return Error.ReadFailed;
            if (n == 0) return Error.ConnectionClosed;
            total += n;
        }
    }
};

test "parseWsUrl basic" {
    const parsed = try WebSocketClient.parseWsUrl("ws://localhost:9222/devtools/page/ABC123");
    try std.testing.expectEqualStrings("localhost", parsed.host);
    try std.testing.expectEqual(@as(u16, 9222), parsed.port);
    try std.testing.expectEqualStrings("/devtools/page/ABC123", parsed.path);
}

test "parseWsUrl default port" {
    const parsed = try WebSocketClient.parseWsUrl("ws://example.com/path");
    try std.testing.expectEqualStrings("example.com", parsed.host);
    try std.testing.expectEqual(@as(u16, 80), parsed.port);
    try std.testing.expectEqualStrings("/path", parsed.path);
}

test "parseWsUrl invalid scheme" {
    const result = WebSocketClient.parseWsUrl("http://localhost:9222");
    try std.testing.expectError(error.InvalidCharacter, result);
}
