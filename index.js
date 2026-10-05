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

async function isCloudflareActive(pageOrSource, isPuppeteerOrPlaywright = true) {
    let html = '';
    let title = '';

    if (isPuppeteerOrPlaywright) {
        html = await pageOrSource.content();
        title = await pageOrSource.title().catch(() => '');
    } else {
        html = pageOrSource; // Selenium page source
    }

    const isChallengedTitle = title === 'Just a moment...' || title.includes('Attention Required');
    const hasChallengeContent = html.includes('Just a moment...') || html.includes('cf-browser-verification');

    return isChallengedTitle || hasChallengeContent;
}

// Wait for Cloudflare's background JS challenge to auto-solve (up to 15s)
async function waitForCloudflareClear(page, requestId) {
    const deadline = Date.now() + 15000;
    
    while (Date.now() < deadline) {
        if (!(await isCloudflareActive(page, true))) {
            log('info', 'Cloudflare challenge cleared successfully', { requestId });
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
}

// Request ID Middleware
app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    const start = Date.now();

    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);

    log('info', 'Request started', { requestId, method: req.method, path: req.path });

    res.on('finish', () => {
        log('info', 'Request completed', { requestId, statusCode: res.statusCode, durationMs: Date.now() - start });
    });

    next();
});

// ---------------------------------------------------------
// Puppeteer (Evasion Enabled)
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
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        
        // Hide automation variables from Cloudflare
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.navigator.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        });

        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait out the Cloudflare interstitial if present
        if (await isCloudflareActive(page, true)) {
            log('info', 'Cloudflare challenge detected, waiting for resolution...', { requestId });
            const cleared = await waitForCloudflareClear(page, requestId);
            if (!cleared) {
                throw new Error('Cloudflare challenge persisted / interactive verification required');
            }
        }

        const html = await page.content();
        log('info', 'Puppeteer succeeded', { requestId, targetUrl, durationMs: Date.now() - start });
        return html;
    } catch (err) {
        log('error', 'Puppeteer failed', { requestId, targetUrl, ...getErrorDetails(err) });
        throw err;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// ---------------------------------------------------------
// Playwright (Evasion Enabled)
// ---------------------------------------------------------
async function scrapeWithPlaywright(targetUrl, requestId) {
    let browser;
    const start = Date.now();
    log('info', 'Playwright started', { requestId, targetUrl });

    try {
        browser = await playwrightChromium.launch({
            headless: true,
            executablePath: CHROMIUM_PATH,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox'
            ]
        });

        const context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        });

        // Inject stealth scripts before every page load
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.navigator.chrome = { runtime: {} };
        });

        const page = await context.newPage();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        if (await isCloudflareActive(page, true)) {
            log('info', 'Cloudflare challenge detected, waiting for resolution...', { requestId });
            const cleared = await waitForCloudflareClear(page, requestId);
            if (!cleared) {
                throw new Error('Cloudflare challenge persisted / interactive verification required');
            }
        }

        const html = await page.content();
        log('info', 'Playwright succeeded', { requestId, targetUrl, durationMs: Date.now() - start });
        return html;
    } catch (err) {
        log('error', 'Playwright failed', { requestId, targetUrl, ...getErrorDetails(err) });
        throw err;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// ---------------------------------------------------------
// Selenium (Evasion Enabled)
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
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        );
        options.excludeSwitches('enable-automation');
        options.setExperimentalOption('useAutomationExtension', false);

        driver = await new Builder()
            .forBrowser(Browser.CHROME)
            .setChromeOptions(options)
            .build();

        await driver.get(targetUrl);

        let html = await driver.getPageSource();
        if (html.includes('Just a moment...')) {
            log('info', 'Cloudflare challenge detected in Selenium, waiting...', { requestId });
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                html = await driver.getPageSource();
                if (!html.includes('Just a moment...')) break;
                await new Promise((r) => setTimeout(r, 1000));
            }
        }

        if (html.includes('Just a moment...')) {
            throw new Error('Cloudflare challenge persisted in Selenium');
        }

        log('info', 'Selenium succeeded', { requestId, targetUrl, durationMs: Date.now() - start });
        return html;
    } catch (err) {
        log('error', 'Selenium failed', { requestId, targetUrl, ...getErrorDetails(err) });
        throw err;
    } finally {
        if (driver) await driver.quit().catch(() => {});
    }
}

// ---------------------------------------------------------
// Route Handler (Waterfall Fallback)
// ---------------------------------------------------------
app.get('/', async (req, res) => {
    const { requestId } = req;
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('Error: Please provide a URL using the ?url= query parameter.');
    }

    const errors = [];
    const engines = [
        { name: 'puppeteer', fn: scrapeWithPuppeteer },
        { name: 'playwright', fn: scrapeWithPlaywright },
        { name: 'selenium', fn: scrapeWithSelenium }
    ];

    for (const [index, engine] of engines.entries()) {
        try {
            log('info', 'Trying scraping engine', { requestId, engine: engine.name, attempt: index + 1, totalAttempts: engines.length });
            const html = await engine.fn(targetUrl, requestId);

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        } catch (err) {
            errors.push(`${engine.name}: ${err.message}`);
            log('warn', 'Moving to next scraping engine', { requestId, failedEngine: engine.name });
        }
    }

    log('error', 'All scraping engines failed', { requestId, targetUrl, errors });
    return res.status(500).send(
        `All scraping engines failed due to Cloudflare protection.<br><br>` +
        `Request ID: ${requestId}<br><br>` +
        `Errors:<br>- ${errors.join('<br>- ')}`
    );
});

// ---------------------------------------------------------
// Server
// ---------------------------------------------------------
app.listen(PORT, () => {
    log('info', 'Stealth multi-engine scraper started', { port: PORT, chromiumPath: CHROMIUM_PATH });
});