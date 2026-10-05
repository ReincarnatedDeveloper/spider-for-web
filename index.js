const express = require('express');
const { Builder, Browser } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { chromium: playwrightChromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Primary Engine: Selenium ---
async function scrapeWithSelenium(targetUrl) {
    let driver;
    try {
        let options = new chrome.Options();
        options.addArguments('--headless');
        options.addArguments('--no-sandbox');
        options.addArguments('--disable-dev-shm-usage');
        options.addArguments('--disable-gpu');

        driver = await new Builder()
            .forBrowser(Browser.CHROME)
            .setChromeOptions(options)
            .build();

        await driver.get(targetUrl);
        const html = await driver.getPageSource();
        return html;
    } finally {
        if (driver) {
            await driver.quit();
        }
    }
}

// --- Fallback Engine: Playwright ---
async function scrapeWithPlaywright(targetUrl) {
    let browser;
    try {
        // Explicitly point to the system Chromium binary inside the Playwright Docker image
        browser = await playwrightChromium.launch({ 
            headless: true,
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/ms-playwright/chromium-1124/chrome-linux/chrome'
        });
        
        const context = await browser.newContext();
        const page = await context.newPage();
        
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        const html = await page.content();
        return html;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Express Route handler
app.get('/', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('Error: Please provide a URL using the ?url= query parameter. Example: ?url=https://example.com');
    }

    try {
        console.log(`Attempting to scrape via Selenium: ${targetUrl}`);
        const html = await scrapeWithSelenium(targetUrl);
        
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);

    } catch (seleniumError) {
        console.warn(`Selenium failed (${seleniumError.message}). Switching to Playwright fallback...`);

        try {
            const htmlFallback = await scrapeWithPlaywright(targetUrl);
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(htmlFallback);

        } catch (playwrightError) {
            console.error('Both Selenium and Playwright failed:', playwrightError);
            return res.status(500).send(`Scraping failed on both engines. Selenium Error: ${seleniumError.message} | Playwright Error: ${playwrightError.message}`);
        }
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});