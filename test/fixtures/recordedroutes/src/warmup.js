const { ResponseCache } = require('./ResponseCache');

const cache = new ResponseCache();

cache.remember('GET', '/cached/home', 'home');
cache.remember('GET', '/cached/about', 'about');

module.exports = { cache };
