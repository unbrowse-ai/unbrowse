// Kuri builtin content script — runs at document_start in MAIN world
// before any page JavaScript executes.

// ── 1. Stealth: hide automation indicators ──

Object.defineProperty(navigator, "webdriver", {
    get: () => false,
    configurable: true,
});

Object.defineProperty(navigator, "plugins", {
    get: () => {
        const plugins = [
            { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
            { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
            { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
        ];
        plugins.length = 3;
        return plugins;
    },
    configurable: true,
});

Object.defineProperty(navigator, "languages", {
    get: () => ["en-US", "en"],
    configurable: true,
});

Object.defineProperty(navigator, "hardwareConcurrency", {
    get: () => 8,
    configurable: true,
});

Object.defineProperty(navigator, "deviceMemory", {
    get: () => 8,
    configurable: true,
});

Object.defineProperty(navigator, "maxTouchPoints", {
    get: () => 0,
    configurable: true,
});

// Chrome-specific APIs that headless misses
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) {
    window.chrome.runtime = {
        connect: () => {},
        sendMessage: () => {},
        id: undefined,
    };
}
if (!window.chrome.csi) {
    window.chrome.csi = () => ({
        startE: Date.now(),
        onloadT: Date.now() + 100,
        pageT: performance.now(),
        tran: 15,
    });
}
if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = () => ({
        commitLoadTime: Date.now() / 1000,
        connectionInfo: "h2",
        finishDocumentLoadTime: Date.now() / 1000 + 0.1,
        finishLoadTime: Date.now() / 1000 + 0.2,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000 + 0.05,
        navigationType: "Other",
        npnNegotiatedProtocol: "h2",
        requestTime: Date.now() / 1000 - 0.5,
        startLoadTime: Date.now() / 1000 - 0.4,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
    });
}

// Permissions API — return "prompt" for notifications (not "denied" which flags headless)
const originalQuery = window.navigator.permissions?.query;
if (originalQuery) {
    window.navigator.permissions.query = (parameters) => {
        if (parameters.name === "notifications") {
            return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery(parameters);
    };
}

// Canvas fingerprint — add subtle noise so the fingerprint is unique but not blank
try {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (type) {
        if (this.width === 0 && this.height === 0) return origToDataURL.apply(this, arguments);
        const ctx = this.getContext("2d");
        if (ctx) {
            const imageData = ctx.getImageData(0, 0, Math.min(this.width, 2), Math.min(this.height, 2));
            // Add 1 bit of noise to a single pixel to create unique fingerprint
            if (imageData.data.length > 0) imageData.data[0] = imageData.data[0] ^ 1;
            ctx.putImageData(imageData, 0, 0);
        }
        return origToDataURL.apply(this, arguments);
    };
} catch (_) {}

// WebGL — mask the renderer to look like a real GPU
try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
        if (param === 37445) return "Google Inc. (Apple)"; // UNMASKED_VENDOR
        if (param === 37446) return "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)"; // UNMASKED_RENDERER
        return getParameter.apply(this, arguments);
    };
    if (typeof WebGL2RenderingContext !== "undefined") {
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return "Google Inc. (Apple)";
            if (param === 37446) return "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)";
            return getParameter2.apply(this, arguments);
        };
    }
} catch (_) {}

// Connection API — look like real broadband
if (navigator.connection) {
    try {
        Object.defineProperty(navigator.connection, "rtt", { get: () => 50, configurable: true });
        Object.defineProperty(navigator.connection, "downlink", { get: () => 10, configurable: true });
        Object.defineProperty(navigator.connection, "effectiveType", { get: () => "4g", configurable: true });
    } catch (_) {}
}

// Iframe contentWindow
try {
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
    if (desc) {
        Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
            get: function () { return desc.get.call(this); },
        });
    }
} catch (_) {}

// ── 2. Agent bridge: window.__kuri for CDP-free comms ──

window.__kuri = {
    version: '1.0.0',
    ready: true,
    _listeners: {},

    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
    },

    emit(event, data) {
        const handlers = this._listeners[event] || [];
        handlers.forEach(fn => fn(data));
    },

    getPageMeta() {
        return {
            url: location.href,
            title: document.title,
            cookies: document.cookie,
            localStorage: Object.keys(localStorage).length,
            sessionStorage: Object.keys(sessionStorage).length,
        };
    },
};

window.dispatchEvent(new CustomEvent('kuri:ready', { detail: { version: '1.0.0' } }));
