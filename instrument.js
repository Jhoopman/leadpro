const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: false,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0,
    profilesSampleRate: 0,
  });
  console.log('✅ Sentry error monitoring enabled');
} else {
  console.log('⚠️  Sentry not configured (SENTRY_DSN missing)');
}

module.exports = Sentry;
