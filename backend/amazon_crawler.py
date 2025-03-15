import asyncio
import random
import time
import json
import signal
from typing import List, Dict, Optional
from datetime import datetime
from pathlib import Path

from playwright.async_api import async_playwright, Browser, Page, TimeoutError as PlaywrightTimeoutError
from fake_useragent import UserAgent
from loguru import logger
from retry import retry
import pandas as pd
from dotenv import load_dotenv
import os

load_dotenv()

class GracefulExit(Exception):
    pass

class AmazonCrawler:
    def __init__(self, 
                 base_url: str = "https://www.amazon.com",
                 output_dir: str = "data",
                 delay_range: tuple = (5, 10),
                 max_retries: int = 3,
                 proxy_urls: List[str] = None):
        """
        Initialize the Amazon crawler
        
        Args:
            base_url: The base Amazon URL
            output_dir: Directory to save crawled data
            delay_range: Range for random delays between requests
            max_retries: Maximum number of retry attempts for failed requests
            proxy_urls: List of complete proxy URLs for rotation
        """
        self.base_url = base_url
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
        self.delay_range = delay_range
        self.max_retries = max_retries
        self.proxy_urls = proxy_urls or []
        self.user_agent = UserAgent()
        self.browser = None
        self.context = None
        self.current_page = None
        self.is_shutting_down = False
        
        # Setup logging
        log_file = self.output_dir / "crawler.log"
        logger.add(
            log_file,
            rotation="500 MB",
            level="INFO",
            backtrace=True,
            diagnose=True
        )
        logger.info(f"Initializing crawler. Log file: {log_file}")

    def _get_random_headers(self) -> Dict[str, str]:
        """Generate random headers for requests"""
        user_agent = self.user_agent.random
        return {
            'User-Agent': user_agent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0',
        }

    async def init_browser(self):
        """Initialize the browser with appropriate settings"""
        try:
            playwright = await async_playwright().start()
            self.browser = await playwright.chromium.launch(
                headless=True,
                args=[
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-infobars',
                    '--disable-notifications',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-extensions',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-default-apps',
                    '--disable-features=TranslateUI',
                    '--disable-popup-blocking',
                    '--disable-background-networking',
                    '--disable-sync',
                    '--metrics-recording-only',
                    '--no-default-browser-check',
                    '--no-first-run',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-background-timer-throttling',
                    '--disable-ipc-flooding-protection'
                ]
            )
            logger.info("Browser initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize browser: {str(e)}")
            raise

    async def _setup_page(self, page: Page):
        """Setup page with anti-detection measures"""
        try:
            # Override JavaScript properties that could reveal automation
            await page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
                
                // Override permissions
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
                );
                
                // Add some randomization to fingerprinting
                Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
                Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
                Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
            """)
            
            # Emulate human-like behavior
            await page.mouse.move(
                random.randint(100, 500),
                random.randint(100, 500)
            )
            
            # Set random viewport size
            await page.set_viewport_size({
                "width": random.randint(1024, 1920),
                "height": random.randint(768, 1080)
            })
            
            logger.debug("Page setup completed successfully")
        except Exception as e:
            logger.error(f"Error in page setup: {str(e)}")
            raise

    def _get_random_proxy(self) -> Optional[Dict[str, str]]:
        """Get a random proxy configuration"""
        if not self.proxy_urls:
            return None
            
        proxy_url = random.choice(self.proxy_urls)
        
        try:
            auth, host_port = proxy_url.split('@')
            username, password = auth.split(':')
            host, port = host_port.split(':')
            
            return {
                'server': f'http://{host}:{port}',
                'username': username,
                'password': password
            }
        except Exception as e:
            logger.error(f"Error parsing proxy URL: {str(e)}")
            return None

    async def _create_page(self) -> Page:
        """Create a new page with randomized settings"""
        if not self.browser:
            await self.init_browser()
            
        try:
            proxy_config = self._get_random_proxy()
            context = await self.browser.new_context(
                user_agent=self.user_agent.random,
                proxy=proxy_config if proxy_config else None,
                viewport={
                    "width": random.randint(1024, 1920),
                    "height": random.randint(768, 1080)
                },
                locale='en-US',
                timezone_id='America/New_York',
                permissions=['geolocation'],
                geolocation={
                    'latitude': random.uniform(25, 48),
                    'longitude': random.uniform(-123, -71),
                    'accuracy': 100
                },
                extra_http_headers=self._get_random_headers()
            )
            
            # Enable JavaScript
            await context.set_extra_http_headers(self._get_random_headers())
            
            page = await context.new_page()
            self.current_page = page
            await self._setup_page(page)
            
            # Increase timeout
            page.set_default_timeout(60000)
            
            logger.info(f"Created new page with proxy: {proxy_config['server'] if proxy_config else 'None'}")
            return page
            
        except Exception as e:
            logger.error(f"Error creating page: {str(e)}")
            raise

    @retry(tries=3, delay=2, backoff=2)
    async def _safe_get(self, url: str, page: Page) -> str:
        """Safely get a page with retry logic"""
        if self.is_shutting_down:
            raise GracefulExit("Crawler is shutting down")
            
        try:
            # Random delay before request
            await asyncio.sleep(random.uniform(*self.delay_range))
            
            # Add random scroll behavior
            async def scroll_randomly():
                for _ in range(random.randint(2, 5)):
                    await page.evaluate("window.scrollBy(0, window.innerHeight * Math.random())")
                    await asyncio.sleep(random.uniform(0.5, 2))
                    
                    # Sometimes move mouse while scrolling
                    if random.random() > 0.5:
                        await page.mouse.move(
                            random.randint(100, 500),
                            random.randint(100, 500)
                        )
            
            response = await page.goto(
                url,
                wait_until='networkidle',
                timeout=60000
            )
            
            if not response:
                raise Exception("No response received")
                
            if response.status == 503 or response.status == 429:
                logger.warning(f"Rate limited on {url}. Waiting longer...")
                await asyncio.sleep(random.uniform(20, 30))
                raise Exception("Rate limited")
            
            # Check for CAPTCHA
            if await page.locator('form[action*="/errors/validateCaptcha"]').count() > 0:
                logger.warning("CAPTCHA detected. Waiting and retrying...")
                await asyncio.sleep(random.uniform(30, 45))
                raise Exception("CAPTCHA encountered")
                
            # Check for robot check
            if "robot check" in (await page.title()).lower():
                logger.warning("Robot check detected. Waiting and retrying...")
                await asyncio.sleep(random.uniform(30, 45))
                raise Exception("Robot check encountered")
                
            # Scroll randomly
            await scroll_randomly()
            
            return await page.content()
            
        except PlaywrightTimeoutError:
            logger.warning(f"Timeout on {url}. Retrying...")
            raise
        except Exception as e:
            logger.error(f"Error fetching {url}: {str(e)}")
            raise

    async def extract_product_data(self, page: Page) -> Dict:
        """Extract product information from a product page"""
        if self.is_shutting_down:
            raise GracefulExit("Crawler is shutting down")
            
        try:
            # Wait for key elements with increased timeout
            await page.wait_for_selector('span#productTitle', timeout=15000)
            
            title = await page.locator('span#productTitle').inner_text()
            
            price_selectors = [
                'span.a-price-whole',
                'span.a-offscreen',
                '#priceblock_ourprice',
                '#priceblock_dealprice',
                '.a-price .a-offscreen',
                '#price_inside_buybox',
                '#corePrice_feature_div .a-price .a-offscreen'
            ]
            
            price = None
            for selector in price_selectors:
                try:
                    price_element = await page.wait_for_selector(selector, timeout=5000)
                    if price_element:
                        price = await price_element.inner_text()
                        break
                except:
                    continue
                    
            try:
                rating = await page.locator('span#acrPopover').get_attribute('title', timeout=5000)
            except:
                rating = None
                
            try:
                reviews_count = await page.locator('span#acrCustomerReviewText').inner_text(timeout=5000)
            except:
                reviews_count = None
            
            try:
                features = await page.locator('div#feature-bullets li').all()
                features_text = [await f.inner_text() for f in features]
            except:
                features_text = []
                
            # Add more product details
            details = {}
            try:
                details_table = await page.locator('table#productDetails_techSpec_section_1 tr').all()
                for row in details_table:
                    try:
                        label = await row.locator('th').inner_text()
                        value = await row.locator('td').inner_text()
                        details[label.strip()] = value.strip()
                    except:
                        continue
            except:
                pass
            
            product_data = {
                'title': title,
                'price': price,
                'rating': rating,
                'reviews_count': reviews_count,
                'features': features_text,
                'details': details,
                'url': page.url,
                'timestamp': datetime.now().isoformat()
            }
            
            logger.info(f"Successfully extracted data for product: {title[:50]}...")
            return product_data
            
        except Exception as e:
            logger.error(f"Error extracting product data: {str(e)}")
            return {}

    async def crawl_category(self, category_url: str, max_pages: int = 20):
        """Crawl a specific category of products"""
        if self.is_shutting_down:
            raise GracefulExit("Crawler is shutting down")
            
        page = await self._create_page()
        products_data = []
        
        try:
            for page_num in range(1, max_pages + 1):
                if self.is_shutting_down:
                    break
                    
                url = f"{category_url}&page={page_num}"
                logger.info(f"Processing category page {page_num} of {max_pages}")
                
                try:
                    await self._safe_get(url, page)
                    
                    # Wait for product grid
                    await page.wait_for_selector('div.s-main-slot', timeout=15000)
                    
                    # Get all product links
                    product_links = await page.locator('a.a-link-normal.s-no-outline').all()
                    product_urls = [await link.get_attribute('href') for link in product_links]
                    
                    logger.info(f"Found {len(product_urls)} products on page {page_num}")
                    
                    # Visit each product page
                    for product_url in product_urls:
                        if self.is_shutting_down:
                            break
                            
                        if not product_url:
                            continue
                            
                        full_url = f"{self.base_url}{product_url}" if not product_url.startswith('http') else product_url
                        
                        try:
                            await self._safe_get(full_url, page)
                            product_data = await self.extract_product_data(page)
                            if product_data:
                                products_data.append(product_data)
                                logger.info(f"Successfully scraped product: {product_data.get('title', 'Unknown')[:50]}...")
                                
                            # Save incrementally
                            if len(products_data) % 5 == 0:  # Save more frequently
                                self._save_data(products_data, f"products_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv")
                                
                            # Random longer delay occasionally
                            if random.random() > 0.8:
                                await asyncio.sleep(random.uniform(15, 25))
                                
                        except Exception as e:
                            logger.error(f"Error processing product {full_url}: {str(e)}")
                            continue
                    
                    logger.info(f"Completed page {page_num} of {max_pages}")
                    
                except Exception as e:
                    logger.error(f"Error processing category page {page_num}: {str(e)}")
                    continue
                    
        except Exception as e:
            logger.error(f"Error in category crawl: {str(e)}")
        finally:
            await page.close()
            
        return products_data

    def _save_data(self, data: List[Dict], filename: str):
        """Save crawled data to CSV"""
        try:
            df = pd.DataFrame(data)
            output_path = self.output_dir / filename
            df.to_csv(output_path, index=False)
            logger.info(f"Saved {len(data)} records to {output_path}")
        except Exception as e:
            logger.error(f"Error saving data to {filename}: {str(e)}")

    async def close(self):
        """Clean up resources"""
        try:
            if self.current_page:
                await self.current_page.close()
            if self.browser:
                await self.browser.close()
            logger.info("Crawler resources cleaned up successfully")
        except Exception as e:
            logger.error(f"Error closing crawler resources: {str(e)}")

    def initiate_shutdown(self):
        """Initiate graceful shutdown"""
        logger.info("Initiating graceful shutdown...")
        self.is_shutting_down = True

async def main():
    # Configure Oxylabs residential proxies
    proxy_urls = [
        "customer-pooya_0nA3q-sessid-0425052490-sesstime-10:123456@pr.oxylabs.io:7777",
        "customer-pooya_0nA3q-sessid-0425052491-sesstime-10:123456@pr.oxylabs.io:7777",
        "customer-pooya_0nA3q-sessid-0425052492-sesstime-10:123456@pr.oxylabs.io:7777",
        "customer-pooya_0nA3q-sessid-0425052493-sesstime-10:123456@pr.oxylabs.io:7777",
        "customer-pooya_0nA3q-sessid-0425052494-sesstime-10:123456@pr.oxylabs.io:7777"
    ]
    
    crawler = AmazonCrawler(
        delay_range=(8, 15),  # Conservative delays
        proxy_urls=proxy_urls
    )
    
    def handle_shutdown(signum, frame):
        logger.info("Received shutdown signal")
        crawler.initiate_shutdown()
    
    # Register signal handlers
    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)
    
    try:
        # Example: Crawl electronics category
        category_url = "https://www.amazon.com/s?k=electronics"
        products = await crawler.crawl_category(category_url, max_pages=2)  # Start with fewer pages
        
        # Save final results
        if products:
            crawler._save_data(products, f"electronics_products_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv")
            
    except GracefulExit:
        logger.info("Crawler shutting down gracefully...")
    except Exception as e:
        logger.error(f"Error in main execution: {str(e)}")
    finally:
        await crawler.close()

if __name__ == "__main__":
    asyncio.run(main()) 