// services/email.js
// All email sending and HTML templates live here.

const https = require('https');
const cfg   = require('../config');

// ── LOW-LEVEL SEND ──────────────────────────────────────────────────────────

function send(to, subject, html) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from:    cfg.fromEmail,
      to:      Array.isArray(to) ? to : [to],
      subject,
      html,
    });
    const req = https.request({
      hostname: 'api.resend.com',
      port:     443,
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization':  `Bearer ${cfg.resendApiKey}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── TEMPLATES ───────────────────────────────────────────────────────────────

function leadAlertHTML(lead, source) {
  return `
<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <div style="background:#1a4d2e;border-radius:12px;padding:20px 24px;margin-bottom:20px">
    <h1 style="color:#e8f5ec;font-size:18px;margin:0">New lead — ${source}</h1>
    <p style="color:#7db896;font-size:13px;margin:6px 0 0">LeadPro AI alert</p>
  </div>
  <div style="background:#f5f5f3;border-radius:8px;padding:16px">
    <table style="width:100%;font-size:13px;color:#2c2c2a">
      <tr><td style="color:#888;padding:5px 0;width:110px">Name</td>    <td style="font-weight:500">${lead.name    || '—'}</td></tr>
      <tr><td style="color:#888;padding:5px 0">Phone</td>               <td style="font-weight:500">${lead.phone   || '—'}</td></tr>
      <tr><td style="color:#888;padding:5px 0">Email</td>               <td style="font-weight:500">${lead.email   || '—'}</td></tr>
      <tr><td style="color:#888;padding:5px 0">Service</td>             <td style="font-weight:500">${lead.service || '—'}</td></tr>
      <tr><td style="color:#888;padding:5px 0">Address</td>             <td style="font-weight:500">${lead.address || '—'}</td></tr>
      <tr><td style="color:#888;padding:5px 0">Requested</td>           <td style="font-weight:500">${lead.datetime|| '—'}</td></tr>
    </table>
  </div>
  <p style="color:#888;font-size:12px;margin-top:16px">
    View dashboard: <a href="${cfg.appUrl}/app" style="color:#2d7a4e">${cfg.appUrl}/app</a>
  </p>
</div>`;
}

function confirmHTML(lead) {
  const firstName = (lead.name || '').split(' ')[0] || 'there';
  return `
<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <div style="background:#1a4d2e;border-radius:12px;padding:20px 24px;margin-bottom:20px">
    <h1 style="color:#e8f5ec;font-size:20px;margin:0">You're all set, ${firstName}!</h1>
  </div>
  <p style="color:#2c2c2a;font-size:14px;line-height:1.7">
    Thanks for reaching out. Here's a summary of your request:
  </p>
  <div style="background:#f5f5f3;border-radius:8px;padding:16px;margin:16px 0">
    <table style="width:100%;font-size:13px;color:#2c2c2a">
      <tr><td style="color:#888;padding:4px 0;width:120px">Service</td>        <td style="font-weight:500">${lead.service  || '—'}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Address</td>                    <td style="font-weight:500">${lead.address  || '—'}</td></tr>
      <tr><td style="color:#888;padding:4px 0">Requested time</td>             <td style="font-weight:500">${lead.datetime || '—'}</td></tr>
    </table>
  </div>
  <p style="color:#2c2c2a;font-size:14px;line-height:1.7">
    Our team will be in touch soon to lock in your exact time. Reply to this email if anything changes.
  </p>
  <p style="color:#2c2c2a;font-size:14px;margin-top:20px">
    Talk soon,<br><strong>${lead.bizName || 'Our Team'}</strong>
  </p>
</div>`;
}

// ── CONVENIENCE SENDERS ─────────────────────────────────────────────────────

async function sendLeadAlert(lead, source) {
  return send(cfg.alertEmail, `New ${source} lead: ${lead.name} — ${lead.service}`, leadAlertHTML(lead, source));
}

async function sendLeadAlertWithTranscript(lead, source, transcript) {
  const transcriptBlock = `
<div style="margin-top:16px;background:#f5f5f3;border-radius:8px;padding:14px">
  <div style="font-size:11px;color:#888;margin-bottom:8px">CALL TRANSCRIPT</div>
  <div style="font-size:12px;color:#2c2c2a;line-height:1.7;white-space:pre-wrap">${(transcript || '').slice(0, 1000)}</div>
</div>`;
  return send(
    cfg.alertEmail,
    `New ${source} lead: ${lead.name} — ${lead.service}`,
    leadAlertHTML(lead, source) + transcriptBlock
  );
}

async function sendConfirmation(lead) {
  if (!lead.email) return;
  return send(
    lead.email,
    `You're booked — ${lead.service} estimate confirmed`,
    confirmHTML(lead)
  );
}

// ── ROI EMAIL ────────────────────────────────────────────────────────────────

function roiEmailHTML({ leadsThisWeek, leadsLastWeek, percentChange, estimatedValue, roiMultiple, topLeads }) {
  const changeIsFirst = percentChange === 'first week';
  const changeNum     = typeof percentChange === 'number' ? percentChange : 0;
  const arrow         = changeNum >= 0 ? '▲' : '▼';
  const arrowColor    = changeNum >= 0 ? '#2d7a4e' : '#c0392b';
  const absChange     = Math.abs(changeNum);

  const vsLastWeekLine = changeIsFirst
    ? `<p style="font-size:14px;color:#888;margin:6px 0 0">First week on LeadPro</p>`
    : `<p style="font-size:14px;color:${arrowColor};margin:6px 0 0">${arrow} ${absChange}% vs last week (${leadsLastWeek} lead${leadsLastWeek !== 1 ? 's' : ''})</p>`;

  const roiLine = roiMultiple >= 1
    ? `<p style="font-size:14px;color:#2c2c2a;margin:10px 0 0">LeadPro paid for itself <strong>${roiMultiple}x</strong> this week</p>`
    : '';

  const topLeadsRows = topLeads.map(l => `
      <tr>
        <td style="padding:9px 12px;font-size:13px;color:#2c2c2a;border-bottom:1px solid #ebebea">${l.name || '—'}</td>
        <td style="padding:9px 12px;font-size:13px;color:#2c2c2a;border-bottom:1px solid #ebebea">${l.service || '—'}</td>
        <td style="padding:9px 12px;font-size:13px;color:#888;border-bottom:1px solid #ebebea;white-space:nowrap">${l.timeAgo}</td>
      </tr>`).join('');

  const topLeadsSection = topLeads.length ? `
  <div style="margin-top:28px">
    <p style="font-size:11px;font-weight:600;color:#888;letter-spacing:0.06em;text-transform:uppercase;margin:0 0 8px">Top leads this week</p>
    <table style="width:100%;border-collapse:collapse;background:#f9f9f8;border-radius:8px;overflow:hidden">
      <thead>
        <tr>
          <th style="padding:8px 12px;font-size:11px;color:#aaa;text-align:left;font-weight:500;border-bottom:1px solid #ebebea">Name</th>
          <th style="padding:8px 12px;font-size:11px;color:#aaa;text-align:left;font-weight:500;border-bottom:1px solid #ebebea">Service</th>
          <th style="padding:8px 12px;font-size:11px;color:#aaa;text-align:left;font-weight:500;border-bottom:1px solid #ebebea">When</th>
        </tr>
      </thead>
      <tbody>${topLeadsRows}</tbody>
    </table>
  </div>` : '';

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:36px 24px;background:#ffffff">

  <p style="font-size:11px;font-weight:600;color:#aaa;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 28px">LeadPro &nbsp;·&nbsp; Weekly Report</p>

  <div style="text-align:center;margin-bottom:32px">
    <p style="font-size:72px;font-weight:700;color:#2d7a4e;margin:0;line-height:1;letter-spacing:-2px">${leadsThisWeek}</p>
    <p style="font-size:15px;color:#888;margin:8px 0 0">leads recovered this week</p>
  </div>

  <div style="background:#f9f9f8;border-radius:10px;padding:20px 22px">
    <p style="font-size:15px;color:#2c2c2a;margin:0">Worth an estimated <strong>$${estimatedValue.toLocaleString()}</strong> to your business</p>
    ${vsLastWeekLine}
    ${roiLine}
  </div>

  ${topLeadsSection}

  <p style="font-size:12px;color:#ccc;margin-top:36px;text-align:center;line-height:1.8">
    <a href="${cfg.appUrl}/app" style="color:#2d7a4e;text-decoration:none">View dashboard</a>
    &nbsp;·&nbsp; LeadPro
  </p>

</div>`;
}

async function sendROIEmail(contractorEmail, data) {
  const n        = data.leadsThisWeek;
  const est      = (n * 450).toLocaleString();
  const subject  = `LeadPro: You recovered ${n} lead${n !== 1 ? 's' : ''} this week (~$${est})`;
  return send(contractorEmail, subject, roiEmailHTML(data));
}

module.exports = { send, sendLeadAlert, sendLeadAlertWithTranscript, sendConfirmation, sendROIEmail };
