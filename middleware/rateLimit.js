const config = require('../config');

class RateLimiter {
  constructor() {
    this.ipBandwidth = new Map();
    this.ipFileCount = new Map();
  }

  checkIpBandwidth(ip, bytes) {
    const now = Date.now();
    const windowMs = config.rateLimit.ip.windowMs;
    const maxBytes = config.rateLimit.ip.maxBytesPerSecond;

    let entry = this.ipBandwidth.get(ip);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { windowStart: now, bytesUsed: 0 };
      this.ipBandwidth.set(ip, entry);
    }

    if (entry.bytesUsed + bytes > maxBytes) {
      const retryAfter = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.bytesUsed += bytes;
    return { allowed: true };
  }

  checkFileCount(ip) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxFiles = config.rateLimit.filesPerMinute;

    let entry = this.ipFileCount.get(ip);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { windowStart: now, count: 0 };
      this.ipFileCount.set(ip, entry);
    }

    if (entry.count >= maxFiles) {
      const retryAfter = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.count++;
    return { allowed: true };
  }

  createBandwidthMiddleware() {
    return (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress;
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);

      if (contentLength > 0) {
        const result = this.checkIpBandwidth(ip, contentLength);
        if (!result.allowed) {
          res.set('Retry-After', String(result.retryAfter));
          return res.status(429).json({
            error: 'Rate limit exceeded',
            message: 'Too much upload bandwidth. Please slow down.',
            retryAfter: result.retryAfter
          });
        }
      }

      next();
    };
  }

  createFileCountMiddleware() {
    return (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress;
      const result = this.checkFileCount(ip);

      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfter));
        return res.status(429).json({
          error: 'Rate limit exceeded',
          message: 'Too many file uploads. Please try again later.',
          retryAfter: result.retryAfter
        });
      }

      next();
    };
  }
}

const rateLimiter = new RateLimiter();

module.exports = {
  rateLimiter,
  bandwidthMiddleware: rateLimiter.createBandwidthMiddleware(),
  fileCountMiddleware: rateLimiter.createFileCountMiddleware()
};
