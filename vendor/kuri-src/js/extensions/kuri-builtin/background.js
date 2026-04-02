// Kuri builtin background service worker
// Observes network requests for HAR-quality recording without CDP async gaps.

const requests = new Map();

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        requests.set(details.requestId, {
            url: details.url,
            method: details.method,
            type: details.type,
            timeStamp: details.timeStamp,
            tabId: details.tabId,
        });
    },
    { urls: ['<all_urls>'] },
    ['requestBody']
);

chrome.webRequest.onSendHeaders.addListener(
    (details) => {
        const entry = requests.get(details.requestId);
        if (entry) {
            entry.requestHeaders = details.requestHeaders;
        }
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        const entry = requests.get(details.requestId);
        if (entry) {
            entry.statusCode = details.statusCode;
            entry.responseHeaders = details.responseHeaders;
        }
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
);

chrome.webRequest.onCompleted.addListener(
    (details) => {
        const entry = requests.get(details.requestId);
        if (entry) {
            entry.completed = true;
            entry.completedAt = details.timeStamp;
        }
    },
    { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
        const entry = requests.get(details.requestId);
        if (entry) {
            entry.error = details.error;
        }
    },
    { urls: ['<all_urls>'] }
);

// Expose request log to kuri via chrome.runtime messaging
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'kuri:getRequests') {
        const tabId = msg.tabId;
        const entries = [];
        for (const [id, entry] of requests) {
            if (!tabId || entry.tabId === tabId) {
                entries.push({ requestId: id, ...entry });
            }
        }
        sendResponse({ entries });
        return true;
    }
    if (msg.type === 'kuri:clearRequests') {
        requests.clear();
        sendResponse({ ok: true });
        return true;
    }
});

// Cap memory — evict completed entries older than 5 minutes
setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, entry] of requests) {
        if (entry.completed && entry.completedAt < cutoff) {
            requests.delete(id);
        }
    }
}, 60_000);
