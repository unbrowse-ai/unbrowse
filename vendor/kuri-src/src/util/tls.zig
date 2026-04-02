const std = @import("std");

pub const TlsStrategy = enum {
    std_tls,
    system,
    none,
};

pub fn detectStrategy() TlsStrategy {
    return .std_tls;
}

pub const TlsConfig = struct {
    verify_certs: bool = true,
    ca_bundle_path: ?[]const u8 = null,
    strategy: TlsStrategy = .std_tls,
};

test "detectStrategy returns std_tls" {
    try std.testing.expectEqual(TlsStrategy.std_tls, detectStrategy());
}

test "TlsConfig defaults" {
    const cfg = TlsConfig{};
    try std.testing.expect(cfg.verify_certs);
    try std.testing.expect(cfg.ca_bundle_path == null);
    try std.testing.expectEqual(TlsStrategy.std_tls, cfg.strategy);
}
