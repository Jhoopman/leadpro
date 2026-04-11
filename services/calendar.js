// services/calendar.js
// Google Calendar OAuth + availability + booking.
// Centralises all googleapis calls so routes stay thin.

const { google } = require('googleapis');
const cfg        = require('../config');
const supabase   = require('./supabase');

// ── OAUTH CLIENT FACTORY ────────────────────────────────────────────────────

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    cfg.google.clientId,
    cfg.google.clientSecret,
    cfg.google.redirectUri
  );
}

// Shared instance for generating auth URLs (no contractor-specific credentials needed)
const oauth2Client = makeOAuth2Client();

function getAuthUrl(contractorId) {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       ['https://www.googleapis.com/auth/calendar'],
    state:       contractorId,
  });
}

// ── PER-CONTRACTOR CLIENT ───────────────────────────────────────────────────

async function getCalendarClient(contractorId) {
  const { data } = await supabase
    .from('contractors')
    .select('google_access_token, google_refresh_token')
    .eq('id', contractorId)
    .single();

  if (!data?.google_access_token) return null;

  const client = makeOAuth2Client();
  client.setCredentials({
    access_token:  data.google_access_token,
    refresh_token: data.google_refresh_token,
  });

  // Persist refreshed tokens automatically
  client.on('tokens', async tokens => {
    if (tokens.access_token) {
      await supabase
        .from('contractors')
        .update({ google_access_token: tokens.access_token })
        .eq('id', contractorId);
    }
  });

  return client;
}

// ── TOKEN EXCHANGE ──────────────────────────────────────────────────────────

async function exchangeCodeForTokens(code, contractorId) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const cal      = google.calendar({ version: 'v3', auth: oauth2Client });
  const calInfo  = await cal.calendars.get({ calendarId: 'primary' });
  const calId    = calInfo.data.id;

  await supabase.from('contractors').update({
    google_access_token:  tokens.access_token,
    google_refresh_token: tokens.refresh_token || undefined,
    google_calendar_id:   calId,
    google_connected:     true,
  }).eq('id', contractorId);

  return { calendarId: calId };
}

// ── AVAILABILITY ────────────────────────────────────────────────────────────

/**
 * Returns free 1-hour slots between 8am–6pm UTC on a given date.
 * @param {string} contractorId
 * @param {string} date  YYYY-MM-DD
 */
async function getAvailableSlots(contractorId, date) {
  const auth = await getCalendarClient(contractorId);
  if (!auth) return { date, slots: [], error: 'Calendar not connected' };

  const cal     = google.calendar({ version: 'v3', auth });
  const timeMin = new Date(date + 'T08:00:00Z');
  const timeMax = new Date(date + 'T18:00:00Z');

  const { data } = await cal.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items:   [{ id: 'primary' }],
    },
  });

  const busy  = data.calendars?.primary?.busy || [];
  const slots = [];

  for (let h = 8; h < 18; h++) {
    const slotStart = new Date(date + `T${h.toString().padStart(2, '0')}:00:00Z`);
    const slotEnd   = new Date(date + `T${(h + 1).toString().padStart(2, '0')}:00:00Z`);
    const isBusy    = busy.some(b => slotStart < new Date(b.end) && slotEnd > new Date(b.start));
    if (!isBusy) {
      const hour = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      slots.push({
        label: `${hour}:00 ${h >= 12 ? 'PM' : 'AM'}`,
        start: slotStart.toISOString(),
        end:   slotEnd.toISOString(),
      });
    }
  }

  return { date, slots };
}

// ── BOOKING ─────────────────────────────────────────────────────────────────

async function bookAppointment({ contractorId, leadName, leadEmail, leadPhone, service, start, end, notes }) {
  const auth = await getCalendarClient(contractorId);
  if (!auth) throw new Error('Google Calendar not connected for this contractor');

  const cal       = google.calendar({ version: 'v3', auth });
  const attendees = leadEmail ? [{ email: leadEmail }] : [];

  const event = {
    summary:     `${service || 'Appointment'} — ${leadName || 'New Lead'}`,
    description: [`Service: ${service || '—'}`, `Lead phone: ${leadPhone || '—'}`, notes ? `Notes: ${notes}` : '']
                  .filter(Boolean).join('\n'),
    start:       { dateTime: start },
    end:         { dateTime: end },
    attendees,
    reminders:   {
      useDefault: false,
      overrides:  [
        { method: 'email',  minutes: 24 * 60 },
        { method: 'popup',  minutes: 30 },
      ],
    },
  };

  const created = await cal.events.insert({
    calendarId:   'primary',
    sendUpdates:  attendees.length ? 'all' : 'none',
    requestBody:  event,
  });

  return { eventId: created.data.id, eventLink: created.data.htmlLink };
}

// ── SLOT FORMATTER (used in widget system prompt) ───────────────────────────

function formatSlotsForPrompt(availableSlots) {
  if (!availableSlots?.length) return null;
  return availableSlots.map(day => {
    const d        = new Date(day.date + 'T12:00:00Z');
    const dayLabel = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });
    return `${dayLabel}: ${day.slots.map(s => s.label).join(', ')}`;
  }).join('\n');
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  getAvailableSlots,
  bookAppointment,
  formatSlotsForPrompt,
};
