const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const kill = require('tree-kill');

const app = express();
const port = 3000;

app.use(cors());

let browser;

const launchBrowser = async () => {
    try {
        console.log('Launching headless browser...');
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        console.log('Browser launched successfully.');
    } catch (error) {
        console.error('Failed to launch browser:', error);
        process.exit(1);
    }
};

app.get('/check-url', async (req, res) => {
    const { url } = req.query;
    console.log(`[${new Date().toISOString()}] Received request for URL: ${url}`);

    if (!url) return res.status(400).json({ finalStatus: 'No URL' });
    if (!browser) return res.status(503).json({ finalStatus: 'Service Unavailable' });

    let page;
    try {
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36');

        const finalResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

        if (!finalResponse) {
            throw new Error('Navigation failed, no response received.');
        }
        
        const redirectChain = finalResponse.request().redirectChain();
        const finalStatus = finalResponse.status();
        let initialStatus = finalStatus;
        
        if (redirectChain.length > 0) {
            const initialResponse = redirectChain[0].response();
            if(initialResponse) {
                initialStatus = initialResponse.status();
            }
        }

        const result = {
            initialStatus: initialStatus,
            finalStatus: finalStatus,
            isRedirect: redirectChain.length > 0 && initialStatus !== finalStatus
        };

        console.log(`-> Responded for ${url} with result:`, result);
        res.json(result);

    } catch (error) {
        console.error(`-> Error for ${url}: ${error.message}`);
        let status = 'ERROR';
        if (error.message.includes('net::ERR_NAME_NOT_RESOLVED')) status = 'DNS Error';
        else if (error.message.includes('timeout')) status = 'Timeout';
        else if (error.message.includes('net::ERR_CONNECTION_REFUSED')) status = 'Refused';
        res.json({ initialStatus: status, finalStatus: status, isRedirect: false });
    } finally {
        if (page) await page.close();
    }
});

app.listen(port, async () => {
    await launchBrowser();
    console.log(`Puppeteer proxy server listening at http://localhost:${port}`);
});

const cleanup = async () => {
    if (browser) {
        const pid = browser.process()?.pid;
        if (pid) {
            console.log(`Closing browser (PID: ${pid})...`);
            await new Promise(resolve => kill(pid, 'SIGKILL', resolve));
            console.log('Browser process terminated.');
        } else {
            await browser.close();
        }
    }
    process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);