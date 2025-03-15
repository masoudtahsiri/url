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
const path = require('path');
const Busboy = require('busboy');
const Papa = require('papaparse');
const bodyParser = require('body-parser');

// Create Express app
const app = express();

// Enable CORS and compression with proper options
app.use(cors());
app.use(compression());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Constants
const BATCH_SIZE = 50; // Process 50 URLs at a time
const URL_TIMEOUT = 10000; // 10 seconds per URL
const MAX_REDIRECTS = 10;

// Function to check a single URL
async function checkUrl(url) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const originalUrl = url;
        let currentUrl = url;

        if (!url.match(/^https?:\/\//i)) {
            currentUrl = 'https://' + url;
        }

        const redirectChain = [];
        let redirectCount = 0;

        function makeRequest(url, protocol) {
            if (Date.now() - startTime > URL_TIMEOUT) {
                resolve({
                    source_url: originalUrl,
                    initial_status: 0,
                    target_url: url,
                    redirect_chain: redirectChain,
                    error: 'Request timeout',
                    processing_time: Date.now() - startTime
                });
                return;
            }

            const options = {
                method: 'HEAD',
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; URLChecker/1.0)',
                    'Accept': '*/*'
                }
            };

            const req = protocol.request(url, options, (res) => {
                const status = res.statusCode;
                const location = res.headers.location;

                if ([301, 302, 303, 307, 308].includes(status) && location && redirectCount < MAX_REDIRECTS) {
                    redirectCount++;
                    redirectChain.push({
                        status: status,
                        url: location
                    });

                    try {
                        const nextUrl = new URL(location, url).href;
                        const nextProtocol = nextUrl.startsWith('https:') ? https : http;
                        makeRequest(nextUrl, nextProtocol);
                    } catch (error) {
                        resolve({
                            source_url: originalUrl,
                            initial_status: status,
                            target_url: url,
                            redirect_chain: redirectChain,
                            error: `Invalid redirect URL: ${error.message}`,
                            processing_time: Date.now() - startTime
                        });
                    }
                } else {
                    if (redirectChain.length > 0) {
                        redirectChain[redirectChain.length - 1].final_status = status;
                    }
                    resolve({
                        source_url: originalUrl,
                        initial_status: redirectChain.length > 0 ? redirectChain[0].status : status,
                        target_url: url,
                        redirect_chain: redirectChain,
                        final_status: status,
                        processing_time: Date.now() - startTime
                    });
                }
            });

            req.on('error', (error) => {
                resolve({
                    source_url: originalUrl,
                    initial_status: 0,
                    target_url: url,
                    redirect_chain: redirectChain,
                    error: error.message,
                    processing_time: Date.now() - startTime
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({
                    source_url: originalUrl,
                    initial_status: 0,
                    target_url: url,
                    redirect_chain: redirectChain,
                    error: 'Request timed out',
                    processing_time: Date.now() - startTime
                });
            });

            req.end();
        }

        try {
            const protocol = currentUrl.startsWith('https:') ? https : http;
            makeRequest(currentUrl, protocol);
        } catch (error) {
            resolve({
                source_url: originalUrl,
                initial_status: 0,
                target_url: url,
                redirect_chain: [],
                error: `Invalid URL: ${error.message}`,
                processing_time: Date.now() - startTime
            });
        }
    });
}

// Process URLs in batches
async function processBatch(urls, startIndex) {
    const batch = urls.slice(startIndex, startIndex + BATCH_SIZE);
    return Promise.all(batch.map(url => checkUrl(url)));
}

app.post('/api/check-urls', async (req, res) => {
    // Set a longer timeout for the response
    req.setTimeout(300000); // 5 minutes
    res.setTimeout(300000); // 5 minutes

    try {
        let urls = [];

        if (req.headers['content-type']?.includes('multipart/form-data')) {
            const busboy = Busboy({ headers: req.headers });
            const filePromise = new Promise((resolve, reject) => {
                busboy.on('file', (name, file, info) => {
                    if (name === 'urls') {
                        const chunks = [];
                        file.on('data', chunk => chunks.push(chunk));
                        file.on('end', () => {
                            const content = Buffer.concat(chunks).toString('utf8');
                            const results = Papa.parse(content, {
                                header: false,
                                skipEmptyLines: true,
                                delimiter: ''
                            });
                            
                            if (results.data.length === 0) {
                                reject(new Error('No data found in CSV file'));
                                return;
                            }

                            const fileUrls = results.data.map(row => row[0]?.trim()).filter(Boolean);
                            resolve(fileUrls);
                        });
                        file.on('error', reject);
                    } else {
                        file.resume();
                    }
                });
                busboy.on('error', reject);
                req.pipe(busboy);
            });

            urls = await filePromise;
        } else if (req.body.urls) {
            urls = Array.isArray(req.body.urls) ? req.body.urls : [req.body.urls];
            urls = urls.filter(url => url && url.trim());
        }

        if (urls.length === 0) {
            return res.status(400).json({ error: 'No valid URLs provided' });
        }

        const results = [];
        const totalBatches = Math.ceil(urls.length / BATCH_SIZE);
        
        for (let i = 0; i < urls.length; i += BATCH_SIZE) {
            const batchResults = await processBatch(urls, i);
            results.push(...batchResults);
            
            // Send progress update
            if ((i + BATCH_SIZE) % 100 === 0 || (i + BATCH_SIZE) >= urls.length) {
                const progress = {
                    processed: Math.min(i + BATCH_SIZE, urls.length),
                    total: urls.length,
                    percent: Math.round((Math.min(i + BATCH_SIZE, urls.length) / urls.length) * 100)
                };
                console.log(`Progress: ${progress.processed}/${progress.total} (${progress.percent}%)`);
            }
        }

        // Generate CSV content
        const csvContent = generateCsvContent(results);

        res.json({
            success: true,
            results: results,
            csv: csvContent,
            total_processed: urls.length
        });

    } catch (error) {
        console.error('Error processing URLs:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: error.message
        });
    }
});

// Add progress checking endpoint
app.get('/api/check-progress/:key', (req, res) => {
  const progress = progressMap.get(req.params.key);
  if (!progress) {
    return res.status(404).json({ error: 'Progress not found' });
  }
  res.json(progress);
});

// Helper function to find URL column in CSV
function findUrlColumn(headerRow, dataRow) {
  const urlIndicators = ['url', 'link', 'website', 'address'];
  
  // Try to find by header name
  const headerIndex = headerRow.findIndex(header => 
    header && 
    typeof header === 'string' && 
    urlIndicators.some(indicator => 
      header.toLowerCase().includes(indicator)
    )
  );
  
  if (headerIndex !== -1) return headerIndex;
  
  // Try to find by content pattern
  return dataRow.findIndex(cell => 
    cell && 
    typeof cell === 'string' && 
    (cell.includes('http') || cell.includes('www.'))
  );
}

function generateCsvContent(results) {
    const headers = ['Original URL', 'Final URL', 'Status Chain', 'Number of Redirects'];
    const rows = results.map(result => {
        let statusChain = [];
        if (result.redirect_chain && result.redirect_chain.length > 0) {
            statusChain = result.redirect_chain.map(r => r.status);
            if (result.redirect_chain[result.redirect_chain.length - 1].final_status) {
                statusChain.push(result.redirect_chain[result.redirect_chain.length - 1].final_status);
            }
        } else if (result.initial_status) {
            statusChain = [result.initial_status];
        }
        
        return [
            result.source_url || '',
            result.target_url || '',
            statusChain.join(' → '),
            result.redirect_chain ? result.redirect_chain.length : 0
        ];
    });
    
    return [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`)
        .join(','))
        .join('\n');
}

// Handle OPTIONS requests
app.options('/api/check-urls', (req, res) => {
  res.sendStatus(200);
});

// Handle 404 errors
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Add proper error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred'
  });
});

// Export for Vercel
module.exports = app; 