/**
 * URL Checker - Server Component
 * Copyright © 2025 Refact, LLC
 * MIT License - See LICENSE file for details
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const https = require('https');
const http = require('http');
const multer = require('multer');
const path = require('path');

const app = express();

// Configure multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Enable CORS and compression
app.use(cors());
app.use(compression());

// Configure body-parser with increased limit
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Function to check URL redirects
async function checkUrl(url) {
    // Add http:// if no protocol is specified
    if (!url.match(/^https?:\/\//i)) {
        url = 'http://' + url;
    }

    return new Promise((resolve) => {
        const redirectChain = [];
        let currentUrl = url;
        let redirectCount = 0;

        function makeRequest(url, protocol) {
            const options = {
                method: 'GET',
                timeout: 10000, // 10 second timeout
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            };

            const req = protocol.get(url, options, (res) => {
                const status = res.statusCode;
                const location = res.headers.location;

                if ([301, 302, 303, 307, 308].includes(status) && location && redirectCount < 10) {
                    redirectCount++;
                    redirectChain.push({
                        status: status,
                        url: location
                    });

                    // Handle relative URLs
                    const nextUrl = new URL(location, url).href;
                    currentUrl = nextUrl;
                    
                    // Follow the redirect
                    const nextProtocol = nextUrl.startsWith('https:') ? https : http;
                    makeRequest(nextUrl, nextProtocol);
                } else {
                    // Add final status to last redirect in chain
                    if (redirectChain.length > 0) {
                        redirectChain[redirectChain.length - 1].final_status = status;
                    }

                    resolve({
                        source_url: url,
                        initial_status: redirectChain.length > 0 ? redirectChain[0].status : status,
                        target_url: currentUrl,
                        redirect_chain: redirectChain,
                        error: ''
                    });
                }
            });

            req.on('error', (error) => {
                resolve({
                    source_url: url,
                    initial_status: 0,
                    target_url: url,
                    redirect_chain: [],
                    error: error.message
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({
                    source_url: url,
                    initial_status: 0,
                    target_url: url,
                    redirect_chain: [],
                    error: 'Request timed out'
                });
            });

            req.end();
        }

        const protocol = url.startsWith('https:') ? https : http;
        makeRequest(url, protocol);
    });
}

// Handle root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle URL checking
app.post('/api/check-urls', upload.single('urls'), async (req, res) => {
    try {
        console.log('Received request to /api/check-urls');
        console.log('Request body:', req.body);
        console.log('File:', req.file);

        let urls = [];
        
        // Handle file upload
        if (req.file) {
            console.log('Processing uploaded file');
            const content = req.file.buffer.toString('utf8');
            console.log('File content:', content);
            const lines = content.split('\n');
            // Skip the first row (headers) and filter out empty lines
            urls = lines.slice(1).filter(url => url.trim());
            console.log(`Found ${urls.length} URLs in file`);
        }
        
        // Handle URLs from form data
        if (req.body.urls_text) {
            console.log('Processing URLs from text:', req.body.urls_text);
            const textUrls = req.body.urls_text.split('\n').filter(url => url.trim());
            urls = urls.concat(textUrls);
        }

        // Handle URLs from JSON data
        const jsonData = req.body.urls;
        if (jsonData && Array.isArray(jsonData)) {
            console.log('Processing URLs from JSON:', jsonData);
            urls = urls.concat(jsonData);
        }

        if (urls.length === 0) {
            console.log('No URLs provided');
            return res.status(400).json({ error: 'No URLs provided' });
        }

        console.log('Final URLs to process:', urls);

        // Process URLs with timeout
        const timeout = 30000; // 30 seconds timeout
        const results = await Promise.all(
            urls.map(url => 
                Promise.race([
                    checkUrl(url),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Timeout')), timeout)
                    )
                ]).catch(error => ({
                    source_url: url,
                    initial_status: 0,
                    target_url: url,
                    redirect_chain: [],
                    error: error.message
                }))
            )
        );

        // Generate CSV content
        const csvContent = [
            ['Source URL', 'Target URL', 'Status Codes', 'Redirect Count'].join(','),
            ...results.map(result => {
                const statusCodes = [];
                if (result.redirect_chain) {
                    result.redirect_chain.forEach((redirect, index) => {
                        if (redirect.status) statusCodes.push(redirect.status);
                        if (redirect.final_status && index === result.redirect_chain.length - 1) {
                            statusCodes.push(redirect.final_status);
                        }
                    });
                }
                return [
                    result.source_url,
                    result.target_url,
                    statusCodes.join(' → '),
                    result.redirect_chain ? result.redirect_chain.length : 0
                ].join(',');
            })
        ].join('\n');

        // Send response with results and CSV content
        res.json({
            success: true,
            message: 'URLs processed successfully',
            results: results,
            csv: csvContent
        });

    } catch (error) {
        console.error('Error processing URLs:', error);
        res.status(500).json({ error: error.message });
    }
});

// Handle OPTIONS requests
app.options('/api/check-urls', (req, res) => {
    res.sendStatus(200);
});

// Handle 404 errors
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// Handle errors
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Export for Vercel
module.exports = app;

// Only listen if not running on Vercel
if (process.env.NODE_ENV !== 'production') {
    const port = process.env.PORT || 3001;
    app.listen(port, (err) => {
        if (err) {
            console.error('Error starting server:', err);
            process.exit(1);
        }
        console.log(`Server running on port ${port}`);
    });
}

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Don't exit in production
    if (process.env.NODE_ENV !== 'production') {
        process.exit(1);
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit in production
    if (process.env.NODE_ENV !== 'production') {
        process.exit(1);
    }
});