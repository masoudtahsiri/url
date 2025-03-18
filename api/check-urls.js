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
const BATCH_SIZE = 10; // Process 10 URLs at a time
const URL_TIMEOUT = 8000; // 8 seconds per URL
const MAX_REDIRECTS = 10;
const MAX_CONCURRENT_BATCHES = 3; // Maximum number of concurrent batches
const URLS_PER_INVOCATION = 110; // Number of URLs to process per invocation

// Shared counter for progress tracking
let globalProcessedCount = 0;

// Function to check a single URL with retry
async function checkUrl(url, retryCount = 0) {
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
                if (retryCount < 2) {
                    return resolve(checkUrl(originalUrl, retryCount + 1));
                }
                resolve({
                    source_url: originalUrl,
                    initial_status: 0,
                    target_url: url,
                    redirect_chain: redirectChain,
                    error: 'Request timeout after retries',
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
                if (retryCount < 2) {
                    return resolve(checkUrl(originalUrl, retryCount + 1));
                }
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
                if (retryCount < 2) {
                    return resolve(checkUrl(originalUrl, retryCount + 1));
                }
                resolve({
                    source_url: originalUrl,
                    initial_status: 0,
                    target_url: url,
                    redirect_chain: redirectChain,
                    error: 'Request timed out after retries',
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

// Process URLs in smaller batches with controlled concurrency
async function processBatch(urls, startIndex, res, totalUrls, processedSoFar = 0) {
    const batch = urls.slice(startIndex, startIndex + BATCH_SIZE);
    const results = [];
    let localProcessed = 0;
    
    // Process URLs one by one with a small delay between them
    for (const url of batch) {
        try {
            const result = await checkUrl(url);
            results.push(result);
            
            // Update progress after each URL
            localProcessed++;
            const progress = {
                type: 'progress',
                processed: processedSoFar + localProcessed,
                total: totalUrls,
                percent: Math.round(((processedSoFar + localProcessed) / totalUrls) * 100)
            };
            res.write(JSON.stringify(progress) + '\n');
            
            // Add a small delay between requests (100ms)
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error(`Error processing URL ${url}:`, error);
            results.push({
                source_url: url,
                initial_status: 0,
                target_url: url,
                redirect_chain: [],
                error: 'Processing failed'
            });
            localProcessed++;
        }
    }
    
    return results;
}

// Process URLs in chunks to avoid timeouts
async function processUrlsInChunks(urls, res, startIndex = 0) {
    const results = [];
    const totalUrls = urls.length;
    const endIndex = Math.min(startIndex + URLS_PER_INVOCATION, totalUrls);
    const currentBatch = urls.slice(startIndex, endIndex);
    
    // Process current batch of URLs
    for (let i = 0; i < currentBatch.length; i += BATCH_SIZE * MAX_CONCURRENT_BATCHES) {
        const chunk = currentBatch.slice(i, Math.min(i + BATCH_SIZE * MAX_CONCURRENT_BATCHES, currentBatch.length));
        const chunkPromises = [];
        
        for (let j = 0; j < chunk.length; j += BATCH_SIZE) {
            chunkPromises.push(
                processBatch(chunk, j, res, totalUrls, startIndex + i + j)
            );
        }
        
        try {
            const chunkResults = await Promise.all(chunkPromises);
            results.push(...chunkResults.flat());
        } catch (error) {
            console.error('Error processing chunk:', error);
            continue;
        }
    }

    // Return results and continuation info
    return {
        results,
        continuation: endIndex < totalUrls ? {
            remainingUrls: urls.slice(endIndex),
            startIndex: endIndex,
            totalUrls: totalUrls
        } : null
    };
}

app.post('/api/check-urls', async (req, res) => {
    try {
        let urls = [];
        let startIndex = 0;
        let totalUrls = 0;

        // Set headers for streaming response
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Check if this is a continuation of previous processing
        if (req.body.continuation) {
            urls = req.body.continuation.remainingUrls;
            startIndex = req.body.continuation.startIndex;
            totalUrls = req.body.continuation.totalUrls;
            
            // Send continuation start message
            res.write(JSON.stringify({
                type: 'continuation_start',
                start_index: startIndex,
                total_urls: totalUrls
            }) + '\n');
        } else {
            // Handle initial request (file upload or URL input)
            if (req.headers['content-type']?.includes('multipart/form-data')) {
                const busboy = Busboy({ headers: req.headers });
                const filePromise = new Promise((resolve, reject) => {
                    busboy.on('file', (name, file, info) => {
                        if (name === 'urls') {
                            let buffer = '';
                            let urlsToProcess = [];
                            
                            const processBuffer = () => {
                                try {
                                    const results = Papa.parse(buffer, {
                                        header: true,
                                        skipEmptyLines: true,
                                        delimiter: ','
                                    });
                                    
                                    const newUrls = results.data
                                        .map(row => Object.values(row)[0]?.trim())
                                        .filter(Boolean);
                                    
                                    if (newUrls.length > 0) {
                                        urlsToProcess.push(...newUrls);
                                    }
                                    buffer = '';
                                } catch (error) {
                                    console.error('Error parsing CSV:', error);
                                }
                            };

                            file.on('data', chunk => {
                                buffer += chunk.toString('utf8');
                                if (buffer.length > 1024 * 10) {
                                    processBuffer();
                                }
                            });

                            file.on('end', () => {
                                if (buffer.length > 0) {
                                    processBuffer();
                                }
                                if (urlsToProcess.length === 0) {
                                    reject(new Error('No valid URLs found in CSV file'));
                                    return;
                                }
                                resolve(urlsToProcess);
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

            totalUrls = urls.length;
            
            // Send initial response with total URLs
            res.write(JSON.stringify({
                type: 'start',
                total_urls: totalUrls,
                estimated_invocations: Math.ceil(totalUrls / URLS_PER_INVOCATION)
            }) + '\n');
        }

        // Process URLs for this invocation
        const { results, continuation } = await processUrlsInChunks(urls, res, startIndex);
        
        // For testing with small URL sets - always consider these complete
        if (results.length <= 5) {
            // Just process everything and send the complete response
            const csvContent = generateCsvContent(results);
            res.write(JSON.stringify({
                type: 'complete',
                success: true,
                results: results,
                csv: csvContent,
                total_processed: results.length,
                total_urls: totalUrls
            }));
            return res.end();
        }

        // Send response based on whether there's more to process
        if (continuation) {
            res.write(JSON.stringify({
                type: 'batch_complete',
                success: true,
                results: results,
                processed: startIndex + results.length,
                total: totalUrls,
                continuation: continuation
            }));
            return res.end();
        } else {
            const csvContent = generateCsvContent(results);
            res.write(JSON.stringify({
                type: 'complete',
                success: true,
                results: results,
                csv: csvContent,
                total_processed: results.length,
                total_urls: totalUrls
            }));
            return res.end();
        }

    } catch (error) {
        console.error('Error processing URLs:', error);
        try {
            if (!res.headersSent) {
                res.status(500).json({
                    error: 'Internal Server Error',
                    message: error.message
                });
            } else {
                res.write(JSON.stringify({
                    type: 'error',
                    error: error.message,
                    recoverable: true,
                    processed: startIndex
                }));
                res.end();
            }
        } catch (e) {
            console.error('Error sending error response:', e);
        }
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
    const headers = ['Original URL', 'Final URL', 'Status Chain', 'Number of Redirects', 'Error', 'Processing Time (ms)'];
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
            result.redirect_chain ? result.redirect_chain.length : 0,
            result.error || '',
            result.processing_time || ''
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