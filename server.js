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

// Configure body-parser with limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Function to check URL redirects with proper error handling
async function checkUrl(url) {
  return new Promise((resolve) => {
    const originalUrl = url; // Store the original URL exactly as provided
    
    // Normalize URL internally without counting as redirect
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
    
    const originalDomain = getDomain(originalUrl);
    const currentDomain = getDomain(currentUrl);

    const redirectChain = [];
    let redirectCount = 0;
    const startTime = Date.now();
    const TIMEOUT = 30000; // 30 seconds timeout

    function makeRequest(url, protocol) {
      if (Date.now() - startTime > TIMEOUT) {
        resolve({
          source_url: originalUrl,
          initial_status: 0,
          target_url: url,
          redirect_chain: redirectChain,
          error: 'Request timeout after 30 seconds'
        });
        return;
      }

      const options = {
        method: 'GET',
        timeout: 10000,
        headers: {
          'User-Agent': 'URLChecker/1.0',
          'Accept': '*/*'
        }
      };

      try {
        const req = protocol.request(url, options, (res) => {
          const status = res.statusCode;
          const location = res.headers.location;

          // Check if this is a redirect
          if ([301, 302, 303, 307, 308].includes(status) && location && redirectCount < 10) {
            const redirectDomain = getDomain(location);
            const currentPath = new URL(url).pathname;
            const redirectPath = new URL(location, url).pathname;
            
            // Add to redirect chain if it's a real redirect (different path) or different domain
            if (redirectPath !== currentPath || redirectDomain !== originalDomain) {
              redirectCount++;
              redirectChain.push({
                status: status,
                url: location,
                is_normalization: false
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
                  error: `Invalid redirect URL: ${error.message}`
                });
              }
            } else {
              // This is just a protocol/www normalization
              redirectCount++;
              redirectChain.push({
                status: status,
                url: location,
                is_normalization: true
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
                  error: `Invalid redirect URL: ${error.message}`
                });
              }
            }
          } else {
            if (redirectChain.length > 0) {
              redirectChain[redirectChain.length - 1].final_status = status;
            }
            if (status === 405) {
              resolve({
                source_url: originalUrl,
                initial_status: status,
                target_url: url,
                redirect_chain: redirectChain,
                error: 'Server does not allow this request method'
              });
              return;
            }
            resolve({
              source_url: originalUrl,
              initial_status: redirectChain.length > 0 ? redirectChain[0].status : status,
              target_url: url,
              redirect_chain: redirectChain,
              error: ''
            });
          }
        });

        req.on('error', (error) => {
          resolve({
            source_url: originalUrl,
            initial_status: 0,
            target_url: url,
            redirect_chain: redirectChain,
            error: error.message
          });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({
            source_url: originalUrl,
            initial_status: 0,
            target_url: url,
            redirect_chain: redirectChain,
            error: 'Request timed out'
          });
        });

        req.end();
      } catch (error) {
        resolve({
          source_url: originalUrl,
          initial_status: 0,
          target_url: url,
          redirect_chain: [],
          error: `Invalid URL: ${error.message}`
        });
      }
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
        error: `Invalid URL: ${error.message}`
      });
    }
  });
}

// Handle root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle URL checking with better error handling
app.post('/api/check-urls', async (req, res) => {
  try {
    let urls = [];
    
    // Handle file upload using busboy
    if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
      const busboy = Busboy({ headers: req.headers });
      const filePromise = new Promise((resolve, reject) => {
        busboy.on('file', (name, file, info) => {
          if (name === 'urls') {
            const chunks = [];
            file.on('data', chunk => chunks.push(chunk));
            file.on('end', () => {
              const content = Buffer.concat(chunks).toString('utf8');
              const fileUrls = content.split('\n')
                .map(line => line.trim())
                .filter((line, index) => line && !line.startsWith('#') && index > 0); // Skip header row
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
        const fileUrls = await filePromise;
        urls = urls.concat(fileUrls);
      } catch (error) {
        console.error('Error processing file:', error);
        return res.status(400).json({ error: 'Error processing uploaded file' });
      }
    }
    
    // Handle URLs from form data
    if (req.body.urls_text) {
      const textUrls = req.body.urls_text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line);
      urls = urls.concat(textUrls);
    }

    // Handle URLs from JSON data
    if (req.body.urls && Array.isArray(req.body.urls)) {
      urls = urls.concat(req.body.urls.filter(url => url && typeof url === 'string'));
    }

    // Validate input
    if (urls.length === 0) {
      return res.status(400).json({ error: 'No valid URLs provided' });
    }

    // Limit number of URLs
    const maxUrls = 50;
    if (urls.length > maxUrls) {
      return res.status(400).json({ 
        error: `Too many URLs. Maximum allowed is ${maxUrls}` 
      });
    }

    // Process URLs with timeout handling
    const results = await Promise.all(
      urls.map(url => 
        Promise.race([
          checkUrl(url),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timeout')), 30000)
          )
        ])
      )
    );

    // Send response
    res.json({
      success: true,
      message: 'URLs processed successfully',
      results: results
    });

  } catch (error) {
    console.error('Error processing URLs:', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      message: error.message || 'An unexpected error occurred while processing URLs'
    });
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