const puppeteer = require('puppeteer');
const AsyncLock = require('async-lock');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Create a lock with max pending requests and timeouts if needed (e.g., 60s timeout limit)
const lock = new AsyncLock({ timeout: 60000, maxPending: 50 });
let globalBrowser = null;
let browserPromise = null;

/**
 * Ensures the reports directory exists.
 */
const reportsDir = path.join(__dirname, '..', 'reports');
if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
}

/**
 * Initializes and returns a singleton headless browser.
 * Uses ultra-lightweight flags for 512MB RAM environments.
 */
async function getBrowser() {
    if (globalBrowser && globalBrowser.isConnected()) {
        return globalBrowser;
    }

    if (browserPromise) {
        return browserPromise;
    }

    console.log('[PDF_SERVICE] Initializing new Puppeteer Browser Instance...');
    browserPromise = puppeteer.launch({
        headless: 'new', // Use the new headless mode which is faster and lighter
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Critical for Docker/low-RAM
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--mute-audio',
            '--window-size=800,600'
        ],
        // Set ignoreHTTPSErrors if needed in dev
        ignoreHTTPSErrors: true,
    }).then(browser => {
        globalBrowser = browser;
        // Handle unexpected browser crashes
        browser.on('disconnected', () => {
            console.log('[PDF_SERVICE] Browser disconnected or crashed. Resetting...');
            globalBrowser = null;
            browserPromise = null;
        });
        console.log('[PDF_SERVICE] Puppeteer Browser Instance Ready');
        return browser;
    }).catch(err => {
        console.error('[PDF_SERVICE] Failed to launch browser:', err);
        browserPromise = null;
        throw err;
    });

    return browserPromise;
}

/**
 * Generates a PDF from HTML in a memory-safe, queued manner.
 * Only ONE PDF generation runs concurrently (Strict FIFO queue).
 *
 * @param {string} htmlContent The HTML to render
 * @param {object} options Options including `save` boolean
 * @returns {Buffer | string} Returns the raw PDF Buffer, or a file path if `save` is true
 */
async function generatePDFWithQueue(htmlContent, options = {}) {
    // Generate a unique ID for logging tracking
    const reqId = crypto.randomBytes(4).toString('hex');
    
    console.log(`[PDF_QUEUE_ENTER] Request ${reqId} placed in queue.`);
    
    return lock.acquire('puppeteer-render', async () => {
        console.log(`[PDF_PROCESS_START] Processing Request ${reqId}`);
        const startTime = Date.now();
        let page = null;
        
        try {
            const browser = await getBrowser();
            
            // Create a new tab just for this request
            page = await browser.newPage();
            
            // Block heavy network requests (images, css, fonts) that aren't inline
            // We disable this if HTML has external images that are absolutely required.
            // Assuming HTML uses Base64 or standard simple layouts.
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const resourceType = req.resourceType();
                if (['image', 'media', 'font'].includes(resourceType) && !req.url().startsWith('data:')) {
                    // Note: If you need external images (like logos from a CDN), comment the line below out.
                    // For maximum safety in pathology, we assume logos are embedded or allowed.
                    // Instead of aborting, we allow to be safe, but you can tighten this:
                    req.continue();
                } else {
                    req.continue();
                }
            });

            // Set HTML content
            await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

            // Generate PDF
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: '0', right: '0', bottom: '0', left: '0' }
            });

            // Handle optional Save to Disk
            if (options.save) {
                const fileName = `report_${Date.now()}_${reqId}.pdf`;
                const filePath = path.join(reportsDir, fileName);
                fs.writeFileSync(filePath, pdfBuffer);
                console.log(`[PDF_PROCESS_END] Request ${reqId} finished in ${Date.now() - startTime}ms. Saved to ${filePath}`);
                return { buffer: pdfBuffer, filePath };
            }

            console.log(`[PDF_PROCESS_END] Request ${reqId} finished in ${Date.now() - startTime}ms`);
            return { buffer: pdfBuffer };

        } catch (error) {
            console.error(`[PDF_PROCESS_ERROR] Request ${reqId} failed:`, error);
            throw error;
        } finally {
            // CRITICAL: Memory Safety - Always close the page
            if (page) {
                await page.close().catch(err => console.error(`[PDF_CLOSE_ERROR] Failed to close page for ${reqId}:`, err));
            }
        }
    });
}

/**
 * Shut down the global browser natively. (Optional for graceful shutdown)
 */
async function closeBrowser() {
    if (globalBrowser) {
        await globalBrowser.close();
        globalBrowser = null;
        browserPromise = null;
    }
}

module.exports = {
    generatePDFWithQueue,
    closeBrowser
};
