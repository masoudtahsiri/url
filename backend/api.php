<?php
/**
 * URL Checker - Backend API Component
 * Copyright © 2025 Refact, LLC
 * MIT License - See LICENSE file for details
 */

// Enable error reporting
error_reporting(E_ALL);
ini_set('display_errors', 1);

// Log function for debugging
function debug_log($message, $data = null) {
    $log = date('Y-m-d H:i:s') . " - " . $message;
    if ($data !== null) {
        $log .= "\n" . print_r($data, true);
    }
    error_log($log);
}

debug_log("PHP script started");

// Set up headers for web requests
if (php_sapi_name() !== 'cli') {
    header('Content-Type: application/json');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');

    // Handle preflight requests
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        debug_log("Handling OPTIONS request");
        exit(0);
    }
}

// Set up temp directory for Vercel
$tempDir = getenv('VERCEL') ? '/tmp' : (getenv('TEMP_DIR') ?: (is_dir('/tmp') ? '/tmp' : sys_get_temp_dir()));
$tempDir = rtrim($tempDir, '/') . '/temp';

debug_log("Using temp directory: " . $tempDir);

// Ensure temp directory exists with proper permissions
if (!is_dir($tempDir)) {
    mkdir($tempDir, 0777, true);
    chmod($tempDir, 0777);
}

// Create subdirectories with proper permissions
foreach (['uploads', 'results'] as $dir) {
    $dirPath = $tempDir . '/' . $dir;
    if (!is_dir($dirPath)) {
        mkdir($dirPath, 0777, true);
        chmod($dirPath, 0777);
    }
}

// Check if running from command line
$isCli = php_sapi_name() === 'cli';
debug_log("Running in CLI mode: " . ($isCli ? "yes" : "no"));

try {
    // Read input data
    if (php_sapi_name() === 'cli') {
        debug_log("Reading from stdin");
        $input = file_get_contents('php://stdin');
    } else {
        debug_log("Reading from HTTP input");
        $input = file_get_contents('php://input');
    }
    
    debug_log("Raw input:", $input);
    
    // Parse JSON input
    $data = json_decode($input, true);
    debug_log("Parsed input:", $data);
    
    if (!$data || !isset($data['urls']) || !is_array($data['urls'])) {
        throw new Exception("Invalid or missing JSON data");
    }
    
    // Process URLs
    $results = [];
    foreach ($data['urls'] as $url) {
        $result = checkUrl($url);
        $results[] = $result;
    }
    
    // Prepare output
    $output = [
        'success' => true,
        'message' => 'URLs processed successfully',
        'results' => $results
    ];
    
    // Send output
    echo json_encode($output);
    debug_log("Results sent");
    
} catch (Exception $e) {
    debug_log("Error: " . $e->getMessage());
    $error = [
        'success' => false,
        'error' => $e->getMessage()
    ];
    
    if (php_sapi_name() !== 'cli') {
        http_response_code(400);
    }
    echo json_encode($error);
    exit(1);
}

// Function to validate URL
function isValidUrl($url) {
    // Clean the URL first
    $url = trim($url);
    
    // Add http:// if no protocol is specified
    if (!preg_match("~^(?:f|ht)tps?://~i", $url) && !preg_match("~^http://~i", $url)) {
        $url = "http://" . $url;
    }
    
    // Validate the URL
    return filter_var($url, FILTER_VALIDATE_URL) !== false;
}

// Function to check URL redirects
function checkUrl($url) {
    // Clean and validate URL
    $url = trim($url);
    if (!preg_match("~^(?:f|ht)tps?://~i", $url)) {
        $url = "http://" . $url;
    }

    // First request to get initial status
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_HEADER => true,
        CURLOPT_NOBODY => false,
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
        CURLOPT_HTTPHEADER => [
            'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language: en-US,en;q=0.9',
            'Accept-Encoding: gzip, deflate, br',
            'Connection: keep-alive',
            'Cache-Control: no-cache',
            'Pragma: no-cache',
            'Sec-Ch-Ua: "Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            'Sec-Ch-Ua-Mobile: ?0',
            'Sec-Ch-Ua-Platform: "macOS"',
            'Sec-Fetch-Dest: document',
            'Sec-Fetch-Mode: navigate',
            'Sec-Fetch-Site: none',
            'Sec-Fetch-User: ?1',
            'Upgrade-Insecure-Requests: 1'
        ],
        CURLOPT_ENCODING => '',  // Accept all encodings
        CURLOPT_REFERER => 'https://www.google.com/'  // Add a common referrer
    ]);

    $response = curl_exec($ch);
    $initialStatus = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    // Now follow redirects with the same browser-like settings
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 10,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => false,
        CURLOPT_HEADER => true,
        CURLOPT_NOBODY => false,
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
        CURLOPT_HTTPHEADER => [
            'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language: en-US,en;q=0.9',
            'Accept-Encoding: gzip, deflate, br',
            'Connection: keep-alive',
            'Cache-Control: no-cache',
            'Pragma: no-cache',
            'Sec-Ch-Ua: "Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            'Sec-Ch-Ua-Mobile: ?0',
            'Sec-Ch-Ua-Platform: "macOS"',
            'Sec-Fetch-Dest: document',
            'Sec-Fetch-Mode: navigate',
            'Sec-Fetch-Site: none',
            'Sec-Fetch-User: ?1',
            'Upgrade-Insecure-Requests: 1'
        ],
        CURLOPT_ENCODING => '',  // Accept all encodings
        CURLOPT_REFERER => 'https://www.google.com/'  // Add a common referrer
    ]);

    $response = curl_exec($ch);
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $headers = substr($response, 0, $headerSize);
    $finalUrl = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    $redirectCount = curl_getinfo($ch, CURLINFO_REDIRECT_COUNT);
    $error = curl_error($ch);

    $redirectChain = [];
    
    // Parse headers to get redirect chain
    $headerGroups = explode("\r\n\r\n", $headers);
    $currentStatus = null;
    $currentUrl = $url;
    $allStatuses = [];
    $finalStatus = null;

    foreach ($headerGroups as $headerGroup) {
        if (empty(trim($headerGroup))) continue;
        
        $headerLines = explode("\r\n", $headerGroup);
        foreach ($headerLines as $line) {
            if (preg_match('/^HTTP\/\d\.\d\s+(\d{3})/', $line, $matches)) {
                $currentStatus = intval($matches[1]);
                $allStatuses[] = $currentStatus;
            } elseif (preg_match('/^Location:\s*(.+)$/i', $line, $matches) && $currentStatus) {
                $location = trim($matches[1]);
                // Handle relative URLs
                if (strpos($location, 'http') !== 0) {
                    if (strpos($location, '/') === 0) {
                        $parsedUrl = parse_url($currentUrl);
                        $location = $parsedUrl['scheme'] . '://' . $parsedUrl['host'] . $location;
                    } else {
                        $location = rtrim($currentUrl, '/') . '/' . ltrim($location, '/');
                    }
                }
                $redirectChain[] = [
                    'status' => $currentStatus,
                    'url' => $location
                ];
                $currentUrl = $location;
            }
        }
    }

    // Get the final status code (last status in the chain)
    $finalStatus = end($allStatuses);
    
    // If we have redirects and a final status
    if (!empty($redirectChain) && $finalStatus) {
        // Add the final status to the last redirect entry
        $lastIndex = count($redirectChain) - 1;
        $redirectChain[$lastIndex] = [
            'status' => $redirectChain[$lastIndex]['status'],
            'url' => $redirectChain[$lastIndex]['url'],
            'final_status' => $finalStatus
        ];
    }

    curl_close($ch);

    // Debug information
    error_log("URL Check Debug: " . print_r([
        'url' => $url,
        'initial_status' => $initialStatus,
        'final_url' => $finalUrl,
        'redirect_count' => $redirectCount,
        'redirect_chain' => $redirectChain,
        'all_statuses' => $allStatuses,
        'final_status' => $finalStatus,
        'headers' => $headers
    ], true));

    return [
        'source_url' => $url,
        'initial_status' => $initialStatus,
        'target_url' => $finalUrl,
        'redirect_chain' => $redirectChain,
        'error' => $error
    ];
} 