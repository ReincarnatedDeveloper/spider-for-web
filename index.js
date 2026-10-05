const express = require('express');
const puppeteer = require('puppeteer');
const { chromium: playwrightChromium } = require('playwright');
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const app = express();
const PORT = process.env.PORT || 3000;

// Shared Chromium executable path inside the Playwright Docker image
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/ms-playwright/chromium-1124/chrome-linux/chrome';

// --- 🥇 Primary Engine: Puppeteer ---
async function scrapeWithPuppeteer(targetUrl) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: CHROMIUM_PATH,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        const page = await browser.newPage();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return await page.content();
    } finally {
        if (browser) await browser.close();
    }
}

// --- 🥈 Secondary Engine: Playwright ---
async function scrapeWithPlaywright(targetUrl) {
    let browser;
    try {
        browser = await playwrightChromium.launch({
            headless: true,
            executablePath: CHROMIUM_PATH
        });
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return await page.content();
    } finally {
        if (browser) await browser.close();
    }
}

// --- 🥉 Tertiary Engine: Selenium ---
async function scrapeWithSelenium(targetUrl) {
    let driver;
    try {
        let options = new chrome.Options();
        options.setChromeBinaryPath(CHROMIUM_PATH);
        options.addArguments('--headless');
        options.addArguments('--no-sandbox');
        options.addArguments('--disable-dev-shm-usage');
        options.addArguments('--disable-gpu');

        driver = await new Builder()
            .forBrowser(Browser.CHROME)
            .setChromeOptions(options)
            .build();

        await driver.get(targetUrl);
        return await driver.getPageSource();
    } finally {
        if (driver) await driver.quit();
    }
}

// Express Route Handler with Sequential Fallback Chain
app.get('/', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('Error: Please provide a URL using the ?url= query parameter. Example: ?url=https://example.com');
    }

    let errors = [];

    // 1. Try Puppeteer
    try {
        console.log(`[1/3] Attempting Puppeteer: ${targetUrl}`);
        const html = await scrapeWithPuppeteer(targetUrl);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (err) {
        console.warn(`Puppeteer failed: ${err.message}`);
        errors.push(`Puppeteer: ${err.message}`);
    }

    // 2. Try Playwright
    try {
        console.log(`[2/3] Falling back to Playwright: ${targetUrl}`);
        const html = await scrapeWithPlaywright(targetUrl);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (err) {
        console.warn(`Playwright failed: ${err.message}`);
        errors.push(`Playwright: ${err.message}`);
    }

    // 3. Try Selenium
    try {
        console.log(`[3/3] Falling back to Selenium: ${targetUrl}`);
        const html = await scrapeWithSelenium(targetUrl);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (err) {
        console.error(`Selenium failed: ${err.message}`);
        errors.push(`Selenium: ${err.message}`);

        // If all three fail, return a clean error report
        return res.status(500).send(`All scraping engines failed.<br><br>Errors:<br>- ${errors.join('<br>- ')}`);
    }
});

app.listen(PORT, () => {
    console.log(`Multi-engine scraper running on port ${PORT}`);
});