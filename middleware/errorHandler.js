// middleware/errorHandler.js
// (1) catchAsync — wraps async route handlers so you never need try/catch in routes.
// (2) notFound — 404 handler for undefined routes.
// (3) globalError — last-resort Express error handler.
//
// Usage in routes:
//   const { catchAsync } = require('../middleware/errorHandler');
//   router.get('/foo', catchAsync(async (req, res) => { ... }));

/**
 * Wraps an async Express handler and forwards thrown errors to next().
 * Eliminates boilerplate try/catch blocks in every route.
 */
function catchAsync(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 handler — mount AFTER all routes.
 */
function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

/**
 * Global error handler — mount LAST, after notFound.
 * Express recognises this as an error handler because it takes 4 args.
 */
// eslint-disable-next-line no-unused-vars
function globalError(err, req, res, next) {
  const status  = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  console.error(`[ERROR] ${req.method} ${req.path} → ${status}: ${message}`);
  if (status === 500) console.error(err.stack);

  res.status(status).json({ error: message });
}

module.exports = { catchAsync, notFound, globalError };
