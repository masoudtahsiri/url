const express = require('express');
const app = express();

app.get('/api/test', (req, res) => {
    res.json({
        success: true,
        message: 'API is working',
        timestamp: new Date().toISOString(),
        env: {
            NODE_ENV: process.env.NODE_ENV,
            VERCEL_ENV: process.env.VERCEL_ENV,
            VERCEL_URL: process.env.VERCEL_URL,
        }
    });
});

app.post('/api/test-url', (req, res) => {
    try {
        // Set headers for streaming response
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        // Send test messages
        res.write(JSON.stringify({ type: 'start', message: 'Starting test' }) + '\n');
        
        // Wait 1 second
        setTimeout(() => {
            res.write(JSON.stringify({ type: 'progress', progress: 50 }) + '\n');
            
            // Wait another second
            setTimeout(() => {
                res.write(JSON.stringify({ type: 'progress', progress: 100 }) + '\n');
                
                // Complete
                res.end(JSON.stringify({ 
                    type: 'complete', 
                    success: true,
                    results: [
                        {
                            source_url: 'example.com',
                            target_url: 'https://example.com',
                            initial_status: 301,
                            redirect_chain: [
                                { status: 301, url: 'https://example.com' }
                            ],
                            final_status: 200
                        }
                    ]
                }));
            }, 1000);
        }, 1000);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = app; 