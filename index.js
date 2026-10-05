const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
// Logging
// ---------------------------------------------------------

function log(level, message, meta = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...meta
    };

    const logger =
        level === 'error'
            ? console.error
            : level === 'warn'
                ? console.warn
                : console.log;

    logger(JSON.stringify(entry));
}

function getErrorDetails(err) {
    return {
        error: err?.message || 'Unknown error',
        stack: err?.stack,
        name: err?.name
    };
}

// ---------------------------------------------------------
// Request ID Middleware
// ---------------------------------------------------------

app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    const start = Date.now();

    req.requestId = requestId;

    res.setHeader('X-Request-ID', requestId);

    log('info', 'Request started', {
        requestId,
        method: req.method,
        path: req.path
    });

    res.on('finish', () => {
        log('info', 'Request completed', {
            requestId,
            statusCode: res.statusCode,
            durationMs: Date.now() - start
        });
    });

    next();
});

// ---------------------------------------------------------
// Health Check
// ---------------------------------------------------------

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'spider-for-web',
        timestamp: new Date().toISOString()
    });
});

// ---------------------------------------------------------
// URL Validation
// ---------------------------------------------------------

function validateTargetUrl(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') {
        throw new Error('Missing URL');
    }

    let parsedUrl;

    try {
        parsedUrl = new URL(targetUrl);
    } catch {
        throw new Error('Invalid URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only HTTP and HTTPS URLs are supported');
    }

    return parsedUrl;
}

// ---------------------------------------------------------
// Basic SSRF Protection
// ---------------------------------------------------------

function isPrivateHostname(hostname) {
    const host = hostname.toLowerCase();

    // Localhost
    if (
        host === 'localhost' ||
        host === 'localhost.localdomain' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0' ||
        host === '::1'
    ) {
        return true;
    }

    // Local domains
    if (
        host.endsWith('.local') ||
        host.endsWith('.localhost') ||
        host.endsWith('.internal')
    ) {
        return true;
    }

    // IPv4 private/reserved ranges
    const privateIpv4Patterns = [
        /^10\./,
        /^127\./,
        /^169\.254\./,
        /^192\.168\./,
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./
    ];

    return privateIpv4Patterns.some((pattern) =>
        pattern.test(host)
    );
}

// ---------------------------------------------------------
// Cloudflare / Challenge Detection
// ---------------------------------------------------------

async function getPageInfo(page) {
    let html = '';
    let title = '';

    try {
        html = await page.content();
    } catch (_) {
        // Ignore
    }

    try {
        title = await page.title();
    } catch (_) {
        // Ignore
    }

    return {
        html,
        title
    };
}

async function isCloudflareActive(page) {
    const { html, title } = await getPageInfo(page);

    const normalizedTitle = title.toLowerCase();

    const challengeTitle =
        title === 'Just a moment...' ||
        normalizedTitle.includes('attention required') ||
        normalizedTitle.includes('checking your browser');

    const challengeContent =
        html.includes('Just a moment...') ||
        html.includes('cf-browser-verification') ||
        html.includes('cf-chl-') ||
        html.includes('challenge-platform');

    return challengeTitle || challengeContent;
}

// ---------------------------------------------------------
// Playwright Scraper
// ---------------------------------------------------------

async function scrapeWithPlaywright(targetUrl, requestId) {
    let browser;

    const start = Date.now();

    log('info', 'Playwright started', {
        requestId,
        targetUrl
    });

    try {
        // IMPORTANT:
        // Do not specify executablePath.
        //
        // The official Playwright Docker image already contains
        // the matching Chromium browser.
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });

        log('info', 'Chromium launched', {
            requestId
        });

        const context = await browser.newContext({
            viewport: {
                width: 1920,
                height: 1080
            },
            locale: 'en-US',
            timezoneId: 'UTC'
        });

        const page = await context.newPage();

        page.setDefaultNavigationTimeout(30000);
        page.setDefaultTimeout(30000);

        log('info', 'Navigating to target', {
            requestId,
            targetUrl
        });

        const response = await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        const statusCode = response
            ? response.status()
            : null;

        log('info', 'Navigation completed', {
            requestId,
            targetUrl,
            statusCode,
            finalUrl: page.url()
        });

        // Give normal client-side JavaScript a short opportunity
        // to finish rendering.
        await page.waitForTimeout(1000);

        // Detect challenge rather than pretending that it was
        // successfully bypassed.
        if (await isCloudflareActive(page)) {
            const { title } = await getPageInfo(page);

            log('warn', 'Target returned a Cloudflare challenge', {
                requestId,
                targetUrl,
                title,
                finalUrl: page.url()
            });

            throw new Error(
                'Target returned a Cloudflare challenge or verification page'
            );
        }

        const html = await page.content();

        log('info', 'Playwright succeeded', {
            requestId,
            targetUrl,
            finalUrl: page.url(),
            statusCode,
            htmlLength: html.length,
            durationMs: Date.now() - start
        });

        return html;

    } catch (err) {
        log('error', 'Playwright failed', {
            requestId,
            targetUrl,
            durationMs: Date.now() - start,
            ...getErrorDetails(err)
        });

        throw err;

    } finally {
        if (browser) {
            await browser.close().catch((closeError) => {
                log('warn', 'Failed to close browser', {
                    requestId,
                    error: closeError.message
                });
            });
        }
    }
}

// ---------------------------------------------------------
// Main Scrape Endpoint
// ---------------------------------------------------------

app.get('/', async (req, res) => {
    const { requestId } = req;
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({
            error: 'Please provide a URL using the ?url= query parameter.',
            example: '/?url=https%3A%2F%2Fexample.com',
            requestId
        });
    }

    let parsedUrl;

    try {
        parsedUrl = validateTargetUrl(targetUrl);
    } catch (err) {
        return res.status(400).json({
            error: err.message,
            requestId
        });
    }

    // Basic SSRF protection
    if (isPrivateHostname(parsedUrl.hostname)) {
        log('warn', 'Blocked private/internal target', {
            requestId,
            hostname: parsedUrl.hostname
        });

        return res.status(403).json({
            error: 'Private or internal destinations are not allowed.',
            requestId
        });
    }

    const normalizedUrl = parsedUrl.toString();

    log('info', 'Scrape request accepted', {
        requestId,
        targetUrl: normalizedUrl
    });

    try {
        const html = await scrapeWithPlaywright(
            normalizedUrl,
            requestId
        );

        res.status(200);
        res.setHeader(
            'Content-Type',
            'text/html; charset=utf-8'
        );

        return res.send(html);

    } catch (err) {
        log('error', 'Scrape request failed', {
            requestId,
            targetUrl: normalizedUrl,
            ...getErrorDetails(err)
        });

        return res.status(500).json({
            error: 'Scraping failed',
            message: err.message,
            requestId
        });
    }
});

// ---------------------------------------------------------
// 404 Handler
// ---------------------------------------------------------

app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        requestId: req.requestId
    });
});

// ---------------------------------------------------------
// Global Error Handler
// ---------------------------------------------------------

app.use((err, req, res, next) => {
    log('error', 'Unhandled Express error', {
        requestId: req.requestId,
        ...getErrorDetails(err)
    });

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        error: 'Internal server error',
        requestId: req.requestId
    });
});

// ---------------------------------------------------------
// Server
// ---------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
    log('info', 'Scraper service started', {
        port: PORT,
        playwrightVersion: '1.63.0'
    });
});
