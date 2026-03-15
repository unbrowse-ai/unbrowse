const std = @import("std");

/// CDP JSON-RPC message envelope
pub const CdpMessage = struct {
    id: u32,
    method: []const u8,
};

/// CDP response
pub const CdpResponse = struct {
    id: u32,
    result: ?std.json.Value = null,
    @"error": ?CdpError = null,
};

pub const CdpError = struct {
    code: i32,
    message: []const u8,
};

/// CDP Target info
pub const TargetInfo = struct {
    targetId: []const u8,
    type: []const u8,
    title: []const u8,
    url: []const u8,
    attached: bool = false,
};

/// Accessibility node from CDP
pub const RawA11yNode = struct {
    nodeId: []const u8,
    role: ?RoleValue = null,
    name: ?NameValue = null,
    backendDOMNodeId: ?u32 = null,
    childIds: ?[]const []const u8 = null,
    parentId: ?[]const u8 = null,
};

pub const RoleValue = struct {
    type: []const u8 = "role",
    value: []const u8 = "",
};

pub const NameValue = struct {
    type: []const u8 = "string",
    value: []const u8 = "",
};

/// CDP methods we use
pub const Methods = struct {
    pub const target_get_targets = "Target.getTargets";
    pub const target_create_target = "Target.createTarget";
    pub const target_close_target = "Target.closeTarget";
    pub const target_attach_to_target = "Target.attachToTarget";
    pub const page_navigate = "Page.navigate";
    pub const page_add_script = "Page.addScriptToEvaluateOnNewDocument";
    pub const page_reload = "Page.reload";
    pub const page_get_layout_metrics = "Page.getLayoutMetrics";
    pub const runtime_evaluate = "Runtime.evaluate";
    pub const runtime_call_function_on = "Runtime.callFunctionOn";
    pub const dom_get_document = "DOM.getDocument";
    pub const dom_resolve_node = "DOM.resolveNode";
    pub const dom_describe_node = "DOM.describeNode";
    pub const dom_set_file_input_files = "DOM.setFileInputFiles";
    pub const accessibility_get_full_tree = "Accessibility.getFullAXTree";
    pub const page_capture_screenshot = "Page.captureScreenshot";
    pub const emulation_set_device_metrics = "Emulation.setDeviceMetricsOverride";
    pub const emulation_set_user_agent = "Emulation.setUserAgentOverride";
    pub const emulation_set_geolocation = "Emulation.setGeolocationOverride";
    pub const dom_highlight_node = "Overlay.highlightNode";
    pub const dom_hide_highlight = "Overlay.hideHighlight";
    pub const overlay_highlight_node = "Overlay.highlightNode";
    pub const overlay_hide_highlight = "Overlay.hideHighlight";
    pub const page_start_screencast = "Page.startScreencast";
    pub const page_stop_screencast = "Page.stopScreencast";
    pub const page_screencast_frame_ack = "Page.screencastFrameAck";

    // Runtime domain
    pub const runtime_console_api_called = "Runtime.consoleAPICalled";
    pub const runtime_enable = "Runtime.enable";

    // Fetch domain (network interception)
    pub const fetch_enable = "Fetch.enable";
    pub const fetch_disable = "Fetch.disable";
    pub const fetch_continue_request = "Fetch.continueRequest";
    pub const fetch_fulfill_request = "Fetch.fulfillRequest";

    // Network domain (cookies, headers)
    pub const network_get_cookies = "Network.getCookies";
    pub const network_set_cookies = "Network.setCookies";
    pub const network_delete_cookies = "Network.deleteCookies";
    pub const network_set_extra_http_headers = "Network.setExtraHTTPHeaders";
    pub const network_enable = "Network.enable";
    pub const network_disable = "Network.disable";

    // Page domain (PDF, stop, script injection)
    pub const page_print_to_pdf = "Page.printToPDF";
    pub const page_stop_loading = "Page.stopLoading";

    // DOM domain (query, HTML)
    pub const dom_query_selector = "DOM.querySelector";
    pub const dom_query_selector_all = "DOM.querySelectorAll";
    pub const dom_get_outer_html = "DOM.getOuterHTML";

    // Input domain (keyboard, mouse)
    pub const input_dispatch_key_event = "Input.dispatchKeyEvent";
    pub const input_insert_text = "Input.insertText";
    pub const input_dispatch_mouse_event = "Input.dispatchMouseEvent";

    // DOM domain (scroll into view)
    pub const dom_scroll_into_view = "DOM.scrollIntoViewIfNeeded";

    // Emulation domain (media, offline)
    pub const emulation_set_emulated_media = "Emulation.setEmulatedMedia";

    // Network domain (offline mode)
    pub const network_emulate_conditions = "Network.emulateNetworkConditions";

    // Page domain (JavaScript dialog)
    pub const page_handle_dialog = "Page.handleJavaScriptDialog";

    // Runtime domain (exceptions)
    pub const runtime_exception_thrown = "Runtime.exceptionThrown";

    // Tracing domain
    pub const tracing_start = "Tracing.start";
    pub const tracing_end = "Tracing.end";

    // Profiler domain
    pub const profiler_enable = "Profiler.enable";
    pub const profiler_disable = "Profiler.disable";
    pub const profiler_start = "Profiler.start";
    pub const profiler_stop = "Profiler.stop";

    // Inspector domain
    pub const inspector_enable = "Inspector.enable";

    // Target domain (new tab/window)
    pub const target_create_browser_context = "Target.createBrowserContext";

    // Page domain (frame/dialog)
    pub const page_get_frame_tree = "Page.getFrameTree";
    pub const page_enable = "Page.enable";
};

test "methods are valid strings" {
    try std.testing.expectEqualStrings("Page.navigate", Methods.page_navigate);
    try std.testing.expectEqualStrings("Accessibility.getFullAXTree", Methods.accessibility_get_full_tree);
}

test "lightpanda parity CDP methods" {
    try std.testing.expectEqualStrings("Network.getCookies", Methods.network_get_cookies);
    try std.testing.expectEqualStrings("Network.setCookies", Methods.network_set_cookies);
    try std.testing.expectEqualStrings("Network.deleteCookies", Methods.network_delete_cookies);
    try std.testing.expectEqualStrings("Network.setExtraHTTPHeaders", Methods.network_set_extra_http_headers);
    try std.testing.expectEqualStrings("Network.enable", Methods.network_enable);
    try std.testing.expectEqualStrings("Network.disable", Methods.network_disable);
    try std.testing.expectEqualStrings("Page.printToPDF", Methods.page_print_to_pdf);
    try std.testing.expectEqualStrings("Page.stopLoading", Methods.page_stop_loading);
    try std.testing.expectEqualStrings("DOM.querySelector", Methods.dom_query_selector);
    try std.testing.expectEqualStrings("DOM.querySelectorAll", Methods.dom_query_selector_all);
    try std.testing.expectEqualStrings("DOM.getOuterHTML", Methods.dom_get_outer_html);
}

test "tier 1 parity CDP methods" {
    try std.testing.expectEqualStrings("Input.dispatchKeyEvent", Methods.input_dispatch_key_event);
    try std.testing.expectEqualStrings("Input.insertText", Methods.input_insert_text);
    try std.testing.expectEqualStrings("Input.dispatchMouseEvent", Methods.input_dispatch_mouse_event);
    try std.testing.expectEqualStrings("DOM.scrollIntoViewIfNeeded", Methods.dom_scroll_into_view);
    try std.testing.expectEqualStrings("Emulation.setEmulatedMedia", Methods.emulation_set_emulated_media);
    try std.testing.expectEqualStrings("Network.emulateNetworkConditions", Methods.network_emulate_conditions);
}
