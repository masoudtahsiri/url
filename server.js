/**
 * URL Checker - Server Component
 * Copyright © 2025 Refact, LLC
 * MIT License - See LICENSE file for details
 */

const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const compression = require('compression');

const app = express();

// Enable CORS and compression
app.use(cors());
app.use(compression());

// Configure body-parser with increased limit
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Increase response size limit
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Transfer-Encoding', 'chunked');
    next();
});

// Serve static files from frontend directory
app.use(express.static(path.join(__dirname, 'frontend')));

// Configure multer for file uploads with increased limits
const storage = multer.memoryStorage(); // Use memory storage for Vercel
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
    }
});

// Get temp directory based on environment
const getTempDir = () => {
    const baseDir = process.env.VERCEL ? '/tmp' : process.cwd();
    const tempDir = path.join(baseDir, 'temp');
    
    // Ensure temp directory exists with proper permissions
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
        fs.chmodSync(tempDir, '777');
    }
    return tempDir;
};

// Ensure required directories exist
const ensureDirectories = () => {
    const tempDir = getTempDir();
    ['uploads', 'results'].forEach(dir => {
        const dirPath = path.join(tempDir, dir);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            fs.chmodSync(dirPath, '777');
        }
    });
};

// Create directories at startup
ensureDirectories();

// Handle file upload and URL checking
app.post('/api/check-urls', upload.single('urls'), async (req, res) => {
    console.log('Received request to /api/check-urls');
    console.log('Request body:', req.body);
    console.log('File:', req.file);
    
    let phpProcess = null;
    
    try {
        // Ensure directories exist before processing
        ensureDirectories();

        // Set request timeout
        req.setTimeout(600000); // 10 minutes
        res.setTimeout(600000); // 10 minutes

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

        // Set up response headers for streaming
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.flushHeaders();

        // Send initial progress
        res.write(JSON.stringify({
            progress: {
                current: 0,
                total: urls.length
            }
        }) + '\n');

        // Start PHP process with environment variables
        console.log('Starting PHP process');
        const phpPath = process.env.VERCEL ? '/var/task/backend/api.php' : 'backend/api.php';
        phpProcess = spawn('php', [phpPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                VERCEL: process.env.VERCEL ? 'true' : '',
                TEMP_DIR: getTempDir()
            }
        });

        let phpOutput = '';
        let phpError = '';

        // Write URLs to PHP process stdin
        phpProcess.stdin.write(JSON.stringify({ urls: urls }));
        phpProcess.stdin.end();

        phpProcess.stdout.on('data', (data) => {
            phpOutput += data.toString();
            console.log('PHP stdout:', data.toString());
        });

        phpProcess.stderr.on('data', (data) => {
            phpError += data.toString();
            console.log('PHP stderr:', data.toString());
        });

        // Wait for PHP process to complete
        await new Promise((resolve, reject) => {
            phpProcess.on('close', (code) => {
                console.log('PHP process closed with code', code);
                if (code === 0 && phpOutput) {
                    resolve();
                } else {
                    reject(new Error(`PHP process failed with code ${code}\nOutput: ${phpOutput}\nError: ${phpError}`));
                }
            });
        });

        // Parse PHP output
        try {
            const output = JSON.parse(phpOutput);
            console.log('PHP output:', output);

            // Generate CSV file
            const csvRows = [
                'Original URL,Final URL,Status Codes,Redirect Count'
            ];

            output.results.forEach(result => {
                const statusCodes = [];
                
                // Add all statuses from redirect chain
                if (result.redirect_chain) {
                    result.redirect_chain.forEach((redirect, index) => {
                        if (redirect.status) {
                            statusCodes.push(redirect.status);
                        }
                        // Only add final status for the last redirect
                        if (redirect.final_status && index === result.redirect_chain.length - 1) {
                            statusCodes.push(redirect.final_status);
                        }
                    });
                }

                csvRows.push([
                    result.source_url,
                    result.target_url,
                    statusCodes.join(' → '),
                    result.redirect_chain ? result.redirect_chain.length : 0
                ].join(','));
            });

            // Create CSV content without the header row
            const csvContent = csvRows.slice(1).join('\n');
            
            // Generate unique filename
            const filename = `results_${Date.now()}.csv`;
            const filePath = path.join(getTempDir(), 'results', filename);
            
            // Ensure results directory exists
            const resultsDir = path.join(getTempDir(), 'results');
            if (!fs.existsSync(resultsDir)) {
                fs.mkdirSync(resultsDir, { recursive: true });
            }
            
            // Write CSV file
            fs.writeFileSync(filePath, csvContent);

            // Send final progress with results and file link
            res.write(JSON.stringify({
                progress: {
                    current: urls.length,
                    total: urls.length
                },
                results: output.results,
                file: `/results/${filename}`
            }) + '\n');

            // End the response
            res.end();
        } catch (error) {
            throw new Error(`Failed to parse PHP output: ${error.message}\nOutput: ${phpOutput}\nError: ${phpError}`);
        }

    } catch (error) {
        console.error('Error processing URLs:', error);
        if (phpProcess) {
            phpProcess.kill();
        }
        res.status(500).json({ error: error.message });
    }
});

// Handle OPTIONS requests
app.options('/api/check-urls', (req, res) => {
    res.sendStatus(200);
});

// Serve results files
app.get('/results/:filename', (req, res) => {
    const filePath = path.join(getTempDir(), 'results', req.params.filename);
    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
        res.sendFile(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Export for Vercel
module.exports = app;

// Only listen if not running on Vercel
if (process.env.NODE_ENV !== 'production') {
    const port = process.env.PORT || 3001;
    app.listen(port, (err) => {
        if (err) {
            if (err.code === 'EADDRINUSE') {
                console.error(`Port ${port} is already in use. Please try these steps:`);
                console.error('1. Kill any existing Node.js processes: pkill -f node');
                console.error('2. Wait a few seconds');
                console.error('3. Try starting the server again');
            } else {
                console.error('Error starting server:', err);
            }
            process.exit(1);
        }
        console.log(`Server running on port ${port}`);
    });
}

// Handle process termination
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Cleaning up...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received. Cleaning up...');
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
}); 