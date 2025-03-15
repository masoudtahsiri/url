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

// Create Express app
const app = express();

// Enable CORS and compression with proper options
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  maxAge: 86400 // 24 hours
}));
app.use(compression());

// Configure body-parser with higher limits for large CSV files
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Store progress information
const progressMap = new Map();

// Function to check URL redirects with improved error handling and timeout
async function checkUrl(url, progressKey, index, total) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const originalUrl = url;
    
    // Update progress at the start
    updateProgress(progressKey, {
      status: 'processing',
      url: originalUrl,
      index,
      total,
      startTime
    });

    // Normalize URL internally
    let currentUrl = url;
    if (!url.match(/^https?:\/\//i)) {
      currentUrl = 'https://' + url;
    }
    
    // Extract domain without www for comparison
    const getDomain = (url) => {
      try {
        const urlObj = new URL(url);
        return urlObj.hostname.replace(/^www\./, '');
      } catch (e) {
        return url;
      }
    };

    const redirectChain = [];
    let redirectCount = 0;
    const PER_URL_TIMEOUT = 15000; // 15 seconds timeout per URL
    const MAX_REDIRECTS = 15; // Increased for thorough checking

    function makeRequest(url, protocol) {
      if (Date.now() - startTime > PER_URL_TIMEOUT) {
        const result = {
          source_url: originalUrl,
          initial_status: 0,
          target_url: url,
          redirect_chain: redirectChain,
          error: 'Request timeout after 15 seconds',
          processing_time: Date.now() - startTime
        };

        updateProgress(progressKey, {
          status: 'timeout',
          url: originalUrl,
          index,
          total,
          result
        });

        resolve(result);
        return;
      }

      const options = {
        method: 'GET',
        timeout: 5000, // Shorter individual request timeout
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; URLChecker/1.0)',
          'Accept': '*/*'
        }
      };

      try {
        const req = protocol.request(url, options, (res) => {
          const status = res.statusCode;
          const location = res.headers.location;

          // Handle redirects
          if ([301, 302, 303, 307, 308].includes(status) && location && redirectCount < MAX_REDIRECTS) {
            redirectCount++;
            const redirectInfo = {
              status: status,
              url: location,
              timestamp: Date.now(),
              redirect_number: redirectCount
            };
            redirectChain.push(redirectInfo);

            // Update progress for each redirect
            updateProgress(progressKey, {
              status: 'redirecting',
              url: originalUrl,
              index,
              total,
              redirect_count: redirectCount,
              current_url: location
            });

            try {
              const nextUrl = new URL(location, url).href;
              const nextProtocol = nextUrl.startsWith('https:') ? https : http;
              makeRequest(nextUrl, nextProtocol);
            } catch (error) {
              const result = {
                source_url: originalUrl,
                initial_status: status,
                target_url: url,
                redirect_chain: redirectChain,
                error: `Invalid redirect URL: ${error.message}`,
                processing_time: Date.now() - startTime
              };

              updateProgress(progressKey, {
                status: 'error',
                url: originalUrl,
                index,
                total,
                result
              });

              resolve(result);
            }
          } else {
            // Final response
            if (redirectChain.length > 0) {
              redirectChain[redirectChain.length - 1].final_status = status;
            }

            const result = {
              source_url: originalUrl,
              initial_status: redirectChain.length > 0 ? redirectChain[0].status : status,
              target_url: url,
              redirect_chain: redirectChain,
              final_status: status,
              processing_time: Date.now() - startTime,
              error: ''
            };

            updateProgress(progressKey, {
              status: 'complete',
              url: originalUrl,
              index,
              total,
              result
            });

            resolve(result);
          }
        });

        req.on('error', (error) => {
          const result = {
            source_url: originalUrl,
            initial_status: 0,
            target_url: url,
            redirect_chain: redirectChain,
            error: error.message,
            processing_time: Date.now() - startTime
          };

          updateProgress(progressKey, {
            status: 'error',
            url: originalUrl,
            index,
            total,
            result
          });

          resolve(result);
        });

        req.on('timeout', () => {
          req.destroy();
          const result = {
            source_url: originalUrl,
            initial_status: 0,
            target_url: url,
            redirect_chain: redirectChain,
            error: 'Request timed out',
            processing_time: Date.now() - startTime
          };

          updateProgress(progressKey, {
            status: 'timeout',
            url: originalUrl,
            index,
            total,
            result
          });

          resolve(result);
        });

        req.end();
      } catch (error) {
        const result = {
          source_url: originalUrl,
          initial_status: 0,
          target_url: url,
          redirect_chain: [],
          error: `Invalid URL: ${error.message}`,
          processing_time: Date.now() - startTime
        };

        updateProgress(progressKey, {
          status: 'error',
          url: originalUrl,
          index,
          total,
          result
        });

        resolve(result);
      }
    }

    try {
      const protocol = currentUrl.startsWith('https:') ? https : http;
      makeRequest(currentUrl, protocol);
    } catch (error) {
      const result = {
        source_url: originalUrl,
        initial_status: 0,
        target_url: url,
        redirect_chain: [],
        error: `Invalid URL: ${error.message}`,
        processing_time: Date.now() - startTime
      };

      updateProgress(progressKey, {
        status: 'error',
        url: originalUrl,
        index,
        total,
        result
      });

      resolve(result);
    }
  });
}

// Function to update progress
function updateProgress(key, data) {
  if (!progressMap.has(key)) {
    progressMap.set(key, {
      startTime: Date.now(),
      total: data.total,
      processed: 0,
      successful: 0,
      failed: 0,
      results: [],
      status: 'processing'
    });
  }

  const progress = progressMap.get(key);

  if (data.status === 'complete') {
    progress.processed++;
    progress.successful++;
    progress.results[data.index] = data.result;
  } else if (data.status === 'error' || data.status === 'timeout') {
    progress.processed++;
    progress.failed++;
    progress.results[data.index] = data.result;
  }

  progress.percent_complete = Math.round((progress.processed / progress.total) * 100);
  progress.estimated_time_remaining = estimateTimeRemaining(progress);

  // Clean up old progress data after 1 hour
  setTimeout(() => {
    progressMap.delete(key);
  }, 3600000);
}

// Function to estimate remaining time
function estimateTimeRemaining(progress) {
  if (progress.processed === 0) return 'Calculating...';
  
  const elapsed = Date.now() - progress.startTime;
  const timePerUrl = elapsed / progress.processed;
  const remaining = progress.total - progress.processed;
  const estimatedMs = timePerUrl * remaining;
  
  if (estimatedMs < 60000) return Math.round(estimatedMs / 1000) + ' seconds';
  return Math.round(estimatedMs / 60000) + ' minutes';
}

// Handle URL checking with improved CSV handling
app.post('/api/check-urls', async (req, res) => {
  try {
    let urls = [];
    const progressKey = Date.now().toString();

    // Handle file upload
    if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
      const busboy = Busboy({ headers: req.headers });
      const filePromise = new Promise((resolve, reject) => {
        busboy.on('file', (name, file, info) => {
          if (name === 'urls') {
            const chunks = [];
            file.on('data', chunk => chunks.push(chunk));
            file.on('end', () => {
              const content = Buffer.concat(chunks).toString('utf8');
              
              // Flexible CSV parsing
              const results = Papa.parse(content, {
                header: false,
                skipEmptyLines: true,
                delimiter: '',
                preview: 2 // Check first two rows to better determine structure
              });

              if (results.data.length === 0) {
                reject(new Error('No data found in CSV file'));
                return;
              }

              // Smart URL extraction
              let fileUrls;
              if (results.data[0].length === 1) {
                // Single column
                fileUrls = results.data.map(row => row[0]);
              } else {
                // Find URL column
                const urlColumnIndex = findUrlColumn(results.data[0], results.data[1]);
                if (urlColumnIndex === -1) {
                  // Try finding URLs in any column
                  fileUrls = results.data.map(row => {
                    const urlCell = row.find(cell => 
                      cell && 
                      typeof cell === 'string' && 
                      (cell.includes('http') || cell.includes('www') || !cell.includes(','))
                    );
                    return urlCell || '';
                  });
                } else {
                  fileUrls = results.data.map(row => row[urlColumnIndex]);
                }
              }

              // Clean and validate URLs
              fileUrls = fileUrls
                .filter(url => url && url.trim())
                .map(url => url.trim());

              if (fileUrls.length === 0) {
                reject(new Error('No valid URLs found in the CSV file'));
                return;
              }

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

      try {
        urls = await filePromise;
      } catch (error) {
        return res.status(400).json({ error: 'Error processing uploaded file: ' + error.message });
      }
    } else if (req.body.urls) {
      if (!Array.isArray(req.body.urls)) {
        return res.status(400).json({ error: 'URLs must be provided as an array' });
      }
      urls = req.body.urls.filter(url => url && url.trim());
    } else if (req.body.url) {
      urls = [req.body.url];
    }

    // Clean and validate URLs
    urls = urls.filter(url => url && url.trim());

    if (urls.length === 0) {
      return res.status(400).json({ error: 'No valid URLs provided' });
    }

    // Initialize progress tracking
    progressMap.set(progressKey, {
      startTime: Date.now(),
      total: urls.length,
      processed: 0,
      successful: 0,
      failed: 0,
      results: new Array(urls.length),
      status: 'processing'
    });

    // Send initial response with progress key
    res.json({
      success: true,
      message: 'Processing started',
      progress_key: progressKey,
      total_urls: urls.length
    });

    // Process URLs in parallel with controlled concurrency
    const BATCH_SIZE = 50; // Process 50 URLs concurrently
    const results = [];
    
    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      const batch = urls.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((url, batchIndex) => 
          checkUrl(url, progressKey, i + batchIndex, urls.length)
        )
      );
      results.push(...batchResults);
    }

    // Update final progress
    const progress = progressMap.get(progressKey);
    progress.status = 'complete';
    progress.results = results;

  } catch (error) {
    console.error('Error processing URLs:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error.message || 'An unexpected error occurred while processing URLs'
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