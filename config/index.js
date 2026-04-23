// config/index.js
// Single source of truth for all environment variables.
// Import this everywhere — never read process.env directly in route files.

const required = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`\n❌  Missing required env var: ${key}\n`);
    process.exit(1);
  }
}

module.exports = {
  port:               process.env.PORT || 3000,

  anthropicApiKey:    process.env.ANTHROPIC_API_KEY,

  supabaseUrl:        process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  supabaseAnonKey:    process.env.SUPABASE_ANON_KEY || '',

  resendApiKey:       process.env.RESEND_API_KEY || '',
  alertEmail:         process.env.ALERT_EMAIL || 'hstratigies@gmail.com',
  fromEmail:          'LeadPro <onboarding@resend.dev>',

  stripe: {
    secretKey:       process.env.STRIPE_SECRET_KEY || '',
    webhookSecret:   process.env.STRIPE_WEBHOOK_SECRET || '',
    starterPriceId:  process.env.STRIPE_STARTER_PRICE_ID || '',
    proPriceId:      process.env.STRIPE_PRO_PRICE_ID || '',
    setupFeePriceId: process.env.STRIPE_SETUP_FEE_PRICE_ID || '',
  },

  alertPhone: process.env.ALERT_PHONE || '',

  google: {
    placesApiKey:  process.env.GOOGLE_PLACES_API_KEY || '',
    clientId:      process.env.GOOGLE_CLIENT_ID || '',
    clientSecret:  process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri:   process.env.GOOGLE_REDIRECT_URI || 'https://leadpro-1d5l.onrender.com/auth/google/callback',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID  || '',
    authToken:  process.env.TWILIO_AUTH_TOKEN   || '',
    phone:      process.env.TWILIO_PHONE        || '+13026647594',
  },

  appUrl: process.env.APP_URL || 'https://leadpro-1d5l.onrender.com',
};
