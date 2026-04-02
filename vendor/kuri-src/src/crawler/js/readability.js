// Readability extraction script — injected via Runtime.evaluate
// Simplified version of Mozilla Readability for extracting article content

(function() {
    'use strict';

    function extractContent() {
        // Clone document to avoid modifying the live DOM
        const doc = document.cloneNode(true);

        // Remove scripts, styles, and non-content elements
        const removeTags = ['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'aside'];
        removeTags.forEach(tag => {
            const elements = doc.querySelectorAll(tag);
            elements.forEach(el => el.remove());
        });

        // Try to find the main content area
        const contentSelectors = [
            'article',
            '[role="main"]',
            'main',
            '.post-content',
            '.article-content',
            '.entry-content',
            '.content',
            '#content',
            '.post',
            '.article',
        ];

        let contentEl = null;
        for (const selector of contentSelectors) {
            contentEl = doc.querySelector(selector);
            if (contentEl && contentEl.textContent.trim().length > 200) {
                break;
            }
            contentEl = null;
        }

        // Fallback to body
        if (!contentEl) {
            contentEl = doc.body;
        }

        if (!contentEl) {
            return {
                title: document.title || '',
                content: document.body ? document.body.innerHTML : '',
                textContent: document.body ? document.body.innerText : '',
                excerpt: '',
            };
        }

        // Extract title
        const title = document.title ||
            (doc.querySelector('h1') ? doc.querySelector('h1').textContent : '');

        // Extract excerpt from meta description
        const metaDesc = doc.querySelector('meta[name="description"]');
        const excerpt = metaDesc ? metaDesc.getAttribute('content') || '' : '';

        return {
            title: title.trim(),
            content: contentEl.innerHTML,
            textContent: contentEl.innerText || contentEl.textContent,
            excerpt: excerpt.trim(),
        };
    }

    return JSON.stringify(extractContent());
})();
