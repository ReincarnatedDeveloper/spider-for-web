'use strict';

const express = require('express');
const crypto = require('crypto');
const { chromium } = require('playwright');

const app = express();

const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------
// Configuration
// ---------------------------------------------------------

const NAVIGATION_TIMEOUT = 30_000;
const CHALLENGE_WAIT_TIMEOUT = 120_000;
const POST_NAVIGATION_WAIT = 1_000;

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

    if (level === 'error') {
        console.error(JSON.stringify(entry));
    } else if (level === 'warn') {
        console.warn(JSON.stringify(entry));
    } else {
        console.log(JSON.stringify(entry));
    }
}

function getErrorDetails(err) {
    return {
        error: err?.message || 'Unknown error',
        name: err?.name,
        stack: err?.stack
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
        path: req.path,
        query: req.query
    });

    res.on('finish', () => {
        log('info', 'Request completed', {
            requestId,
            method: req.method,
            path: req.path,
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

    if (targetUrl.length > 2048) {
        throw new Error('URL is too long');
    }

    let parsedUrl;

    try {
        parsedUrl = new URL(targetUrl);
    } catch {
        throw new Error('Invalid URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error(
            'Only HTTP and HTTPS URLs are supported'
        );
    }

    if (!parsedUrl.hostname) {
        throw new Error('URL must contain a hostname');
    }

    return parsedUrl;
}

// ---------------------------------------------------------
// Basic SSRF Protection
// ---------------------------------------------------------

function isPrivateHostname(hostname) {
    const host = String(hostname || '').toLowerCase();

    // Localhost / loopback
    if (
        host === 'localhost' ||
        host === 'localhost.localdomain' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0' ||
        host === '::1'
    ) {
        return true;
    }

    // Local/internal domains
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

    return privateIpv4Patterns.some((pattern) => {
        return pattern.test(host);
    });
}

// ---------------------------------------------------------
// Cloudflare / Verification Detection
// ---------------------------------------------------------

async function getPageInfo(page) {
    let html = '';
    let title = '';

    try {
        html = await page.content();
    } catch (err) {
        log('warn', 'Unable to read page content', {
            requestId: page.__requestId,
            error: err.message
        });
    }

    try {
        title = await page.title();
    } catch (err) {
        log('warn', 'Unable to read page title', {
            requestId: page.__requestId,
            error: err.message
        });
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
        html.includes('cf-chl-');

    return challengeTitle || challengeContent;
}

// ---------------------------------------------------------
// Wait for an automatically resolving challenge
// ---------------------------------------------------------

async function waitForChallengeToFinish(
    page,
    requestId,
    timeoutMs = CHALLENGE_WAIT_TIMEOUT
) {
    const deadline = Date.now() + timeoutMs;

    log('info', 'Waiting for verification page to clear', {
        requestId,
        timeoutMs
    });

    while (Date.now() < deadline) {
        const active = await isCloudflareActive(page);

        if (!active) {
            log('info', 'Verification page cleared', {
                requestId,
                finalUrl: page.url()
            });

            return true;
        }

        await page.waitForTimeout(1000);
    }

    return false;
}

// ---------------------------------------------------------
// Playwright Scraper
// ---------------------------------------------------------

async function scrapeWithPlaywright(
    targetUrl,
    requestId
) {
    let browser = null;
    let context = null;

    const start = Date.now();

    log('info', 'Playwright started', {
        requestId,
        targetUrl
    });

    try {
        // -------------------------------------------------
        // IMPORTANT
        //
        // No executablePath is specified.
        //
        // The official Playwright Docker image:
        //
        // mcr.microsoft.com/playwright:v1.63.0-noble
        //
        // already contains the matching Chromium.
        // -------------------------------------------------

        browser = await chromium.launch({
            headless: true,

            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        log('info', 'Chromium launched', {
            requestId
        });

        // -------------------------------------------------
        // Browser Context
        // -------------------------------------------------

        context = await browser.newContext({
            viewport: {
                width: 1920,
                height: 1080
            },

            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',

            locale: 'en-US',

            timezoneId: 'UTC'
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
        });

        // -------------------------------------------------
        // Page
        // -------------------------------------------------

        const page = await context.newPage();

        // Store request ID for logging helpers
        page.__requestId = requestId;

        page.setDefaultNavigationTimeout(
            NAVIGATION_TIMEOUT
        );

        page.setDefaultTimeout(
            NAVIGATION_TIMEOUT
        );

        // -------------------------------------------------
        // Navigation
        // -------------------------------------------------

        log('info', 'Navigating to target', {
            requestId,
            targetUrl
        });

        const response = await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT
        });

        const statusCode = response
            ? response.status()
            : null;

        const finalUrl = page.url();

        log('info', 'Navigation completed', {
            requestId,
            targetUrl,
            finalUrl,
            statusCode
        });

        // -------------------------------------------------
        // Give normal page JavaScript some time
        // -------------------------------------------------

        await page.waitForTimeout(
            POST_NAVIGATION_WAIT
        );

        // -------------------------------------------------
        // Check for verification/challenge page
        // -------------------------------------------------

        if (await isCloudflareActive(page)) {
            const { title } = await getPageInfo(page);

            log('warn', 'Verification challenge detected', {
                requestId,
                targetUrl,
                finalUrl: page.url(),
                statusCode,
                title
            });

            // Allow an ordinary automatically-resolving
            // challenge some time to finish.
            const cleared =
                await waitForChallengeToFinish(
                    page,
                    requestId,
                    CHALLENGE_WAIT_TIMEOUT
                );

            if (!cleared) {
                throw new Error(
                    'Target returned a Cloudflare or verification challenge that did not clear automatically'
                );
            }
        }

        // -------------------------------------------------
        // Get final HTML
        // -------------------------------------------------

        const html = await page.content();

        if (!html || html.length === 0) {
            throw new Error(
                'Target returned an empty HTML document'
            );
        }

        log('info', 'Playwright succeeded', {
            requestId,
            targetUrl,
            finalUrl: page.url(),
            statusCode,
            htmlLength: html.length,
            durationMs: Date.now() - start
        });

        return {
            html,
            statusCode,
            finalUrl: page.url()
        };

    } catch (err) {
        log('error', 'Playwright failed', {
            requestId,
            targetUrl,
            durationMs: Date.now() - start,
            ...getErrorDetails(err)
        });

        throw err;

    } finally {
        // -------------------------------------------------
        // Close context first
        // -------------------------------------------------

        if (context) {
            try {
                await context.close();
            } catch (err) {
                log('warn', 'Failed to close browser context', {
                    requestId,
                    error: err.message
                });
            }
        }

        // -------------------------------------------------
        // Then close browser
        // -------------------------------------------------

        if (browser) {
            try {
                await browser.close();
            } catch (err) {
                log('warn', 'Failed to close browser', {
                    requestId,
                    error: err.message
                });
            }
        }
    }
}

// ---------------------------------------------------------
// Main Scrape Endpoint
// ---------------------------------------------------------

app.get('/', async (req, res) => {
    const { requestId } = req;

    const targetUrl = req.query.url;

    // -----------------------------------------------------
    // Check URL exists
    // -----------------------------------------------------

    if (!targetUrl) {
        return res.status(400).json({
            error:
                'Please provide a URL using the ?url= query parameter.',

            example:
                '/?url=https%3A%2F%2Fexample.com',

            requestId
        });
    }

    // -----------------------------------------------------
    // Validate URL
    // -----------------------------------------------------

    let parsedUrl;

    try {
        parsedUrl =
            validateTargetUrl(targetUrl);

    } catch (err) {
        return res.status(400).json({
            error: err.message,
            requestId
        });
    }

    // -----------------------------------------------------
    // SSRF protection
    // -----------------------------------------------------

    if (
        isPrivateHostname(
            parsedUrl.hostname
        )
    ) {
        log('warn', 'Blocked private/internal target', {
            requestId,
            hostname: parsedUrl.hostname
        });

        return res.status(403).json({
            error:
                'Private or internal destinations are not allowed.',

            requestId
        });
    }

    const normalizedUrl =
        parsedUrl.toString();

    log('info', 'Scrape request accepted', {
        requestId,
        targetUrl: normalizedUrl
    });

    // -----------------------------------------------------
    // Scrape
    // -----------------------------------------------------

    try {
        const result =
            await scrapeWithPlaywright(
                normalizedUrl,
                requestId
            );

        res.status(200);

        res.setHeader(
            'Content-Type',
            'text/html; charset=utf-8'
        );

        return res.send(result.html);

    } catch (err) {
        log('error', 'Scrape request failed', {
            requestId,
            targetUrl: normalizedUrl,
            ...getErrorDetails(err)
        });

        return res.status(502).json({
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
        path: req.path,
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

    return res.status(500).json({
        error: 'Internal server error',
        requestId: req.requestId
    });
});

// ---------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------

function shutdown(signal) {
    log('info', 'Shutdown signal received', {
        signal
    });

    server.close(() => {
        log('info', 'HTTP server closed');

        process.exit(0);
    });

    // Don't wait forever for connections to close.
    setTimeout(() => {
        log('warn', 'Forced shutdown');

        process.exit(1);
    }, 10_000).unref();
}

// ---------------------------------------------------------
// Start Server
// ---------------------------------------------------------

const server = app.listen(
    PORT,
    '0.0.0.0',
    () => {
        log('info', 'Scraper service started', {
            port: PORT,
            playwrightVersion: '1.63.0',
            healthEndpoint: '/health'
        });
    }
);

process.on('SIGTERM', () => {
    shutdown('SIGTERM');
});

process.on('SIGINT', () => {
    shutdown('SIGINT');
});
