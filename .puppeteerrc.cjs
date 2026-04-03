const { join } = require('path');

/**
 * Puppeteer config — ensures Chrome is installed to a known location
 * that works on cloud hosts (Render, Railway, etc.).
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
