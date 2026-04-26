/* LeadPro embeddable chat widget
 * Usage: <script src="https://app.useleadpro.net/widget.js" data-id="WIDGET_ID"></script>
 * All CSS is scoped under #lp-btn and #lp-panel — no host-page conflicts.
 */
(function () {
  'use strict';

  // ── Prevent double-init ──
  if (window.__lpLoaded) return;
  window.__lpLoaded = true;

  // ── Config ──
  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();
  var WIDGET_ID = (script.getAttribute('data-id') || '').trim();
  // Derive host from wherever this script was loaded from.
  // Moving the deployment = one-line change here, nothing else breaks.
  var LEADPRO_HOST = (script.src || '').replace(/\/widget\.js.*$/, '') || 'https://app.useleadpro.net';
  var BASE = LEADPRO_HOST;
  var CHAT_URL = BASE + '/widget-chat.html?id=' + encodeURIComponent(WIDGET_ID);

  // ── Inject scoped CSS ──
  var styleEl = document.createElement('style');
  styleEl.id = 'lp-styles';
  styleEl.textContent = [

    /* Button */
    '#lp-btn{',
      'position:fixed;bottom:24px;right:24px;',
      'width:56px;height:56px;border-radius:50%;',
      'background:#1a4d2e;border:none;outline:none;cursor:pointer;',
      'display:flex;align-items:center;justify-content:center;',
      'box-shadow:0 4px 24px rgba(26,77,46,0.45),0 2px 8px rgba(0,0,0,0.18);',
      'z-index:2147483646;',
      'animation:lp-pop-in 0.45s cubic-bezier(0.34,1.56,0.64,1) both;',
      'transition:transform 0.22s cubic-bezier(0.34,1.56,0.64,1),',
        'box-shadow 0.22s,background 0.2s;',
      'will-change:transform;',
    '}',

    '#lp-btn:hover{',
      'transform:scale(1.1);',
      'box-shadow:0 8px 32px rgba(26,77,46,0.55),0 4px 16px rgba(0,0,0,0.22);',
    '}',

    '#lp-btn:active{transform:scale(0.96);}',

    /* Pop-in on page load */
    '@keyframes lp-pop-in{',
      '0%{opacity:0;transform:scale(0.4) translateY(16px);}',
      '100%{opacity:1;transform:scale(1) translateY(0);}',
    '}',

    /* Wiggle to grab attention (fires after delay) */
    '@keyframes lp-wiggle{',
      '0%,100%{transform:scale(1) rotate(0deg);}',
      '15%{transform:scale(1.12) rotate(-9deg);}',
      '30%{transform:scale(1.12) rotate(9deg);}',
      '45%{transform:scale(1.08) rotate(-5deg);}',
      '60%{transform:scale(1.06) rotate(3deg);}',
      '75%{transform:scale(1.03) rotate(-1deg);}',
    '}',

    '#lp-btn.lp-wiggle{animation:lp-wiggle 0.75s ease-in-out;}',

    /* Chat icon — hidden when open */
    '#lp-btn .lp-ico-chat{display:flex;transition:opacity 0.18s,transform 0.22s;}',
    '#lp-btn.lp-open .lp-ico-chat{opacity:0;transform:scale(0.6) rotate(-30deg);pointer-events:none;}',

    /* Close icon — hidden when closed */
    '#lp-btn .lp-ico-close{',
      'position:absolute;display:flex;',
      'opacity:0;transform:scale(0.6) rotate(30deg);',
      'transition:opacity 0.18s,transform 0.22s;',
    '}',
    '#lp-btn.lp-open .lp-ico-close{opacity:1;transform:scale(1) rotate(0);}',

    /* Tooltip */
    '#lp-tooltip{',
      'position:absolute;right:64px;top:50%;transform:translateY(-50%);',
      'background:rgba(10,10,10,0.82);',
      'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);',
      'color:#fff;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
      'font-size:12px;font-weight:500;letter-spacing:0.01em;',
      'padding:6px 11px;border-radius:7px;white-space:nowrap;',
      'pointer-events:none;opacity:0;',
      'transition:opacity 0.15s;',
    '}',
    '#lp-tooltip::after{',
      'content:"";position:absolute;left:100%;top:50%;transform:translateY(-50%);',
      'border:5px solid transparent;border-left-color:rgba(10,10,10,0.82);',
    '}',
    '#lp-btn:hover #lp-tooltip{opacity:1;}',
    '#lp-btn.lp-open #lp-tooltip{display:none;}',

    /* Unread badge */
    '#lp-badge{',
      'position:absolute;top:-5px;right:-5px;',
      'min-width:18px;height:18px;border-radius:999px;',
      'background:#e85d3a;color:#fff;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'font-size:10px;font-weight:700;line-height:1;',
      'display:none;align-items:center;justify-content:center;',
      'padding:0 4px;',
      'border:2px solid #fff;',
      'animation:lp-badge-pulse 2s ease-in-out infinite;',
    '}',
    '@keyframes lp-badge-pulse{',
      '0%,100%{box-shadow:0 0 0 0 rgba(232,93,58,0.7);}',
      '50%{box-shadow:0 0 0 7px rgba(232,93,58,0);}',
    '}',

    /* Chat panel */
    '#lp-panel{',
      'position:fixed;bottom:92px;right:24px;',
      'width:380px;height:580px;',
      'border-radius:16px;overflow:hidden;',
      'box-shadow:0 12px 56px rgba(0,0,0,0.22),0 2px 10px rgba(0,0,0,0.08);',
      'border:1px solid rgba(0,0,0,0.07);',
      'z-index:2147483645;',
      'transform-origin:bottom right;',
      'transform:scale(0.88) translateY(20px);',
      'opacity:0;pointer-events:none;',
      'transition:',
        'transform 0.3s cubic-bezier(0.34,1.15,0.64,1),',
        'opacity 0.22s ease;',
      'will-change:transform,opacity;',
    '}',
    '#lp-panel.lp-open{',
      'transform:scale(1) translateY(0);',
      'opacity:1;pointer-events:auto;',
    '}',
    '#lp-iframe{width:100%;height:100%;border:none;display:block;}',

    /* Mobile */
    '@media(max-width:480px){',
      '#lp-panel{',
        'width:calc(100vw - 16px);',
        'height:calc(100dvh - 96px);',
        'right:8px;bottom:76px;',
        'border-radius:14px;',
      '}',
      '#lp-btn{bottom:16px;right:16px;}',
    '}',

    /* Reduced motion */
    '@media(prefers-reduced-motion:reduce){',
      '#lp-btn,#lp-panel,#lp-btn .lp-ico-chat,#lp-btn .lp-ico-close{',
        'animation:none!important;transition:none!important;',
      '}',
      '#lp-badge{animation:none!important;}',
    '}',

  ].join('');

  document.head.appendChild(styleEl);

  // ── DOM: button ──
  var btn = document.createElement('button');
  btn.id = 'lp-btn';
  btn.setAttribute('type', 'button');
  btn.setAttribute('aria-label', 'Chat with us');
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML =
    '<div class="lp-ico-chat">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path fill="rgba(255,255,255,0.95)" d="M20 2H4C2.9 2 2 2.9 2 4v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>' +
      '</svg>' +
    '</div>' +
    '<div class="lp-ico-close">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"' +
        ' stroke="rgba(255,255,255,0.95)" stroke-width="2.5" stroke-linecap="round">' +
        '<line x1="18" y1="6" x2="6" y2="18"/>' +
        '<line x1="6" y1="6" x2="18" y2="18"/>' +
      '</svg>' +
    '</div>' +
    '<div id="lp-badge" role="status" aria-live="polite" aria-label="unread messages"></div>' +
    '<div id="lp-tooltip" aria-hidden="true">Chat with us</div>';

  // ── DOM: panel + iframe ──
  var panel = document.createElement('div');
  panel.id = 'lp-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'LeadPro live chat');
  panel.setAttribute('aria-modal', 'true');

  var iframe = document.createElement('iframe');
  iframe.id = 'lp-iframe';
  iframe.setAttribute('title', 'LeadPro chat');
  iframe.setAttribute('allow', 'clipboard-write');
  iframe.setAttribute('loading', 'lazy');
  iframe.src = CHAT_URL;
  panel.appendChild(iframe);

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var badge    = document.getElementById('lp-badge');
  var isOpen   = false;
  var unread   = 0;
  var loaded   = false;   // true once iframe has been shown at least once

  // ── Open ──
  function open() {
    if (isOpen) return;
    isOpen = true;
    loaded = true;

    panel.classList.add('lp-open');
    btn.classList.add('lp-open');
    btn.setAttribute('aria-label', 'Close chat');
    btn.setAttribute('aria-expanded', 'true');

    // Clear badge
    unread = 0;
    badge.style.display = 'none';
    badge.textContent  = '';

    // Tell iframe it's visible
    safePM('lp:opened');
  }

  // ── Close ──
  function close() {
    if (!isOpen) return;
    isOpen = false;

    panel.classList.remove('lp-open');
    btn.classList.remove('lp-open');
    btn.setAttribute('aria-label', 'Chat with us');
    btn.setAttribute('aria-expanded', 'false');
  }

  // ── Toggle ──
  btn.addEventListener('click', function () {
    isOpen ? close() : open();
  });

  // ── Keyboard: Escape closes ──
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) close();
  });

  // ── postMessage relay ──
  function safePM(msg) {
    try { iframe.contentWindow.postMessage(msg, '*'); } catch (_) {}
  }

  window.addEventListener('message', function (e) {
    if (!e.data || typeof e.data !== 'string') return;

    // New lead captured inside chat
    if (e.data === 'lp:new_lead') {
      if (!isOpen) {
        unread = Math.min(unread + 1, 99);
        badge.textContent  = unread > 9 ? '9+' : String(unread);
        badge.style.display = 'flex';
        // Wiggle the button to call attention
        triggerWiggle();
      }
    }

    // Lead fully submitted — auto-open to show success card
    if (e.data === 'lp:lead_captured' && !isOpen) {
      open();
    }

    // Iframe signals it's ready
    if (e.data === 'lp:ready') {
      // Nothing needed for now; hook for future handshake
    }
  });

  // ── Attention wiggle (fires once after 5 s if not yet opened) ──
  var wiggleTimer = setTimeout(function () {
    if (!isOpen) triggerWiggle();
  }, 5000);

  function triggerWiggle() {
    btn.classList.remove('lp-wiggle');
    // Force reflow to restart animation
    void btn.offsetWidth;  // eslint-disable-line
    btn.classList.add('lp-wiggle');
    btn.addEventListener('animationend', function onEnd() {
      btn.classList.remove('lp-wiggle');
      btn.removeEventListener('animationend', onEnd);
    }, { once: true });
  }

  // ── Cleanup if script is removed ──
  if (script.parentNode) {
    var observer = new MutationObserver(function () {
      if (!document.getElementById('lp-btn')) {
        clearTimeout(wiggleTimer);
        observer.disconnect();
        delete window.__lpLoaded;
      }
    });
    observer.observe(document.body, { childList: true, subtree: false });
  }

})();
