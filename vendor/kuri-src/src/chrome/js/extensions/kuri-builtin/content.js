// Kuri builtin content script — runs at document_start in MAIN world
// before any page JavaScript executes.

// ── 1. Stealth: hide automation indicators ──

Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true,
});

Object.defineProperty(navigator, 'plugins', {
    get: () => {
        const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
    },
    configurable: true,
});

Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
});

if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) {
    window.chrome.runtime = {
        connect: () => {},
        sendMessage: () => {},
        id: undefined,
    };
}

const originalQuery = window.navigator.permissions?.query;
if (originalQuery) {
    window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery(parameters);
    };
}

try {
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (desc) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
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
