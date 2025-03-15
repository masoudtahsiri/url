# Amazon Crawler

A robust, asynchronous web crawler for Amazon.com built with Python and Playwright. This crawler is designed to be respectful of Amazon's servers while efficiently gathering product data.

## Features

- Asynchronous operation for improved performance
- User-agent rotation to avoid detection
- Proxy support for IP rotation
- Automatic retry mechanism for failed requests
- Incremental data saving
- Comprehensive error handling and logging
- Respects robots.txt and implements rate limiting

## Prerequisites

- Python 3.8+
- pip (Python package manager)

## Installation

1. Create a virtual environment (recommended):
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Install Playwright browsers:
```bash
playwright install
```

## Usage

1. (Optional) Configure proxies by adding them to the `proxy_list` in `main()`.

2. Run the crawler:
```bash
python amazon_crawler.py
```

## Configuration

The crawler can be configured with the following parameters:

- `base_url`: The base Amazon URL (default: "https://www.amazon.com")
- `output_dir`: Directory to save crawled data (default: "data")
- `delay_range`: Range for random delays between requests (default: (2, 5) seconds)
- `max_retries`: Maximum number of retry attempts for failed requests (default: 3)
- `proxy_list`: List of proxy servers to rotate through (optional)

## Data Output

The crawler saves data in CSV format with the following information for each product:

- Title
- Price
- Rating
- Review count
- Product features
- URL
- Timestamp

## Best Practices

1. Use appropriate delays between requests (configured in `delay_range`)
2. Implement proxy rotation to avoid IP bans
3. Monitor the logs in the `data` directory for any issues
4. Start with small `max_pages` values and gradually increase as needed

## Legal Considerations

Ensure you comply with Amazon's robots.txt and terms of service when using this crawler. The crawler implements reasonable delays and respects common crawling etiquette, but you should verify compliance with current Amazon policies before use.

## Error Handling

The crawler implements comprehensive error handling:

- Automatic retries for failed requests
- Logging of all errors to `crawler.log`
- Graceful degradation when data can't be extracted
- Incremental saving to prevent data loss

## Contributing

Feel free to submit issues and enhancement requests! 