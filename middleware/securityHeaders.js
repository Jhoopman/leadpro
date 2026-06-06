// middleware/securityHeaders.js
// Adds security response headers to every reply.
// Mount early in server.js, before route modules.

module.exports = function securityHeaders(req, res, next) {
  // Strict-Transport-Security: force HTTPS for 1 year, include subdomains
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // widget-chat.html must be embeddable in contractor sites via <iframe>.
  // Everything else should block framing.
  if (req.path === '/widget-chat.html') {
    res.setHeader('X-Frame-Options', 'ALLOWALL');
  } else {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }

  // Reduce referrer leakage
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Legacy XSS filter (belt-and-suspenders for old browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Prevent the browser from guessing the content type
  res.setHeader('X-Download-Options', 'noopen');

  next();
};
