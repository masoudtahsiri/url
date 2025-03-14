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

// Create Express app
const app = express();

// Configure multer for memory storage with limits
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1
  }
});

// Enable CORS and compression with proper options
app.use(cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
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
    let originalUrl = url; // Store the original URL exactly as provided
    let currentUrl = url;
    if (!url.match(/^https?:\/\//i)) {
      currentUrl = 'https://' + url;
      originalUrl = 'https://' + url; // Also update originalUrl to include the prefix
    }

    const redirectChain = [];
    let redirectCount = 0;
    const startTime = Date.now();
    const TIMEOUT = 30000; // 30 seconds timeout

    function makeRequest(url, protocol) {
      if (Date.now() - startTime > TIMEOUT) {
        resolve({
          source_url: originalUrl, // Use original URL
          initial_status: 0,
          target_url: url,
          redirect_chain: redirectChain,
          error: 'Request timeout after 30 seconds'
        });
        return;
      }

      const options = {
        method: 'HEAD',
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

          if ([301, 302, 303, 307, 308].includes(status) && location && redirectCount < 10) {
            redirectCount++;
            redirectChain.push({
              status: status,
              url: location
            });

            try {
              const nextUrl = new URL(location, url).href;
              currentUrl = nextUrl;
              const nextProtocol = nextUrl.startsWith('https:') ? https : http;
              makeRequest(nextUrl, nextProtocol);
            } catch (error) {
              resolve({
                source_url: originalUrl, // Use original URL
                initial_status: status,
                target_url: currentUrl,
                redirect_chain: redirectChain,
                error: `Invalid redirect URL: ${error.message}`
              });
            }
          } else {
            if (redirectChain.length > 0) {
              redirectChain[redirectChain.length - 1].final_status = status;
            }
            resolve({
              source_url: originalUrl, // Use original URL
              initial_status: redirectChain.length > 0 ? redirectChain[0].status : status,
              target_url: currentUrl,
              redirect_chain: redirectChain,
              error: ''
            });
          }
        });

        req.on('error', (error) => {
          resolve({
            source_url: originalUrl, // Use original URL
            initial_status: 0,
            target_url: url,
            redirect_chain: redirectChain,
            error: error.message
          });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({
            source_url: originalUrl, // Use original URL
            initial_status: 0,
            target_url: url,
            redirect_chain: redirectChain,
            error: 'Request timed out'
          });
        });

        req.end();
      } catch (error) {
        resolve({
          source_url: originalUrl, // Use original URL
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
        source_url: originalUrl, // Use original URL
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

// Handle URL checking
app.post('/api/check-urls', upload.single('urls'), async (req, res) => {
  try {
    let urls = [];
    
    // Handle file upload
    if (req.file) {
      const content = req.file.buffer.toString('utf8');
      urls = content.split('\n')
        .map(line => line.trim())
        .filter((line, index) => line && !line.startsWith('#') && index > 0); // Skip header row
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

    // Process URLs
    const results = await Promise.all(urls.map(url => checkUrl(url)));

    // Generate CSV content
    const csvContent = [
      ['Source URL', 'Target URL', 'Status Code Chain', 'Redirect Count', 'Error'].join(','),
      ...results.map(result => {
        // Build complete status chain including final status
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
          result.source_url,
          result.target_url,
          statusChain.join(' → '),
          result.redirect_chain.length,
          result.error
        ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
      })
    ].join('\n');

    // Send response
    res.json({
      success: true,
      message: 'URLs processed successfully',
      results: results,
      csv: csvContent
    });

  } catch (error) {
    console.error('Error processing URLs:', error);
    res.status(500).json({ 
      error: 'Internal Server Error',
      message: error.message
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

// Handle errors
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: err.message
  });
});

// Export for Vercel
module.exports = app; 