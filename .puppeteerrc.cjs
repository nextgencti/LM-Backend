const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer.
  // This ensures that the browser is downloaded into a local folder that Render can cache/access.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
