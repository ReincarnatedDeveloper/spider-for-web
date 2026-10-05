const express = require('express');
const puppeteer = require('puppeteer');
const { chromium: playwrightChromium } = require('playwright');
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const CHROMIUM_PATH =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    '/ms-playwright/chromium-1124/chrome-linux/chrome';

// ---------------------------------------------------------
// Logging & Helpers
// ---------------------------------------------------------

function log(level, message, meta = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...meta
    };

    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
        JSON.stringify(entry)
    );
}

function getErrorDetails(err) {
    return {
        error: err?.message,
        stack: err?.stack,
        name: err?.name
    };
}

function detectCloudflare(html) {
    // Checks for common Cloudflare challenge indicators
    return html.includes('Just a moment...') || html.includes('cf-browser-verification');
}

// Add request ID to every request
app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    const start = Date.now();

    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);

    log('info', 'Request started', {
        requestId,
        method: req.method,
        path: req.path,
        url: req.originalUrl
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
// Puppeteer
// ---------------------------------------------------------

async function scrapeWithPuppeteer(targetUrl, requestId) {
    let browser;
    const start = Date.now();

    log('info', 'Puppeteer started', { requestId, targetUrl });

    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: CHROMIUM_PATH,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();

        await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        const html = await page.content();

        if (detectCloudflare(html)) {
            throw new Error('Cloudflare challenge detected ("Just a moment...")');
        }

        log('info', 'Puppeteer succeeded', {
            requestId,
            targetUrl,
            durationMs: Date.now() - start,
            htmlBytes: Buffer.byteLength(html)
        });

        return html;
    } catch (err) {
        log('error', 'Puppeteer failed', {
            requestId,
            targetUrl,
            durationMs: Date.now() - start,
            ...getErrorDetails(err)
        });

        throw err;
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (err) {
                log('warn', 'Failed to close Puppeteer browser', { requestId, ...getErrorDetails(err) });
            }
        }
    }
}

// ---------------------------------------------------------
// Playwright
// ---------------------------------------------------------

async function scrapeWithPlaywright(targetUrl, requestId) {
    let browser;
    const start = Date.now();

    log('info', 'Playwright started', { requestId, targetUrl });

    try {
        browser = await playwrightChromium.launch({
            headless: true,
            executablePath: CHROMIUM_PATH
        });

        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        const html = await page.content();

        if (detectCloudflare(html)) {
            throw new Error('Cloudflare challenge detected ("Just a moment...")');
        }

        log('info', 'Playwright succeeded', {
            requestId,
            targetUrl,
            durationMs: Date.now() - start,
            htmlBytes: Buffer.byteLength(html)
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
            try {
                await browser.close();
            } catch (err) {
                log('warn', 'Failed to close Playwright browser', { requestId, ...getErrorDetails(err) });
            }
        }
    }
}

// ---------------------------------------------------------
// Selenium
// ---------------------------------------------------------

async function scrapeWithSelenium(targetUrl, requestId) {
    let driver;
    const start = Date.now();

    log('info', 'Selenium started', { requestId, targetUrl });

    try {
        const options = new chrome.Options();

        options.setChromeBinaryPath(CHROMIUM_PATH);
        options.addArguments(
            '--headless',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        );

        driver = await new Builder()
            .forBrowser(Browser.CHROME)
            .setChromeOptions(options)
            .build();

        await driver.get(targetUrl);

        const html = await driver.getPageSource();

        if (detectCloudflare(html)) {
            throw new Error('Cloudflare challenge detected ("Just a moment...")');
        }

        log('info', 'Selenium succeeded', {
            requestId,
            targetUrl,
            durationMs: Date.now() - start,
            htmlBytes: Buffer.byteLength(html)
        });

        return html;
    } catch (err) {
        log('error', 'Selenium failed', {
            requestId,
            targetUrl,
            durationMs: Date.now() - start,
            ...getErrorDetails(err)
        });

        throw err;
    } finally {
        if (driver) {
            try {
                await driver.quit();
            } catch (err) {
                log('warn', 'Failed to close Selenium driver', { requestId, ...getErrorDetails(err) });
            }
        }
    }
}

// ---------------------------------------------------------
// Route
// ---------------------------------------------------------

app.get('/', async (req, res) => {
    const { requestId } = req;
    const targetUrl = req.query.url;

    if (!targetUrl) {
        log('warn', 'Request rejected: missing URL', { requestId });
        return res.status(400).send('Error: Please provide a URL using the ?url= query parameter.');
    }

    const errors = [];

    // 1. Puppeteer
    try {
        log('info', 'Trying scraping engine', { requestId, engine: 'puppeteer', attempt: 1, totalAttempts: 3 });
        const html = await scrapeWithPuppeteer(targetUrl, requestId);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (err) {
        errors.push(`Puppeteer: ${err.message}`);
        log('warn', 'Moving to next scraping engine', { requestId, failedEngine: 'puppeteer', nextEngine: 'playwright' });
    }

    // 2. Playwright
    try {
        log('info', 'Trying scraping engine', { requestId, engine: 'playwright', attempt: 2, totalAttempts: 3 });
        const html = await scrapeWithPlaywright(targetUrl, requestId);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (err) {
        errors.push(`Playwright: ${err.message}`);
        log('warn', 'Moving to next scraping engine', { requestId, failedEngine: 'playwright', nextEngine: 'selenium' });
    }

    // 3. Selenium
    try {
        log('info', 'Trying scraping engine', { requestId, engine: 'selenium', attempt: 3, totalAttempts: 3 });
        const html = await scrapeWithSelenium(targetUrl, requestId);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (err) {
        errors.push(`Selenium: ${err.message}`);
        log('error', 'All scraping engines failed', { requestId, targetUrl, errors });

        return res.status(500).send(
            `All scraping engines failed.<br><br>` +
            `Request ID: ${requestId}<br><br>` +
            `Errors:<br>- ${errors.join('<br>- ')}`
        );
    }
});

// ---------------------------------------------------------
// Server
// ---------------------------------------------------------

app.listen(PORT, () => {
    log('info', 'Multi-engine scraper started', {
        port: PORT,
        chromiumPath: CHROMIUM_PATH,
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || 'development'
    });
});