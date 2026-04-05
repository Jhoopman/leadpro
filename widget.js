/* LeadPro embeddable widget — paste before </body> on any website */
(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var widgetId = script.getAttribute('data-id') || '';
  var BASE = 'https://leadpro-1d5l.onrender.com';

  // Don't double-initialize
  if (document.getElementById('_lp_root')) return;

  // ── Styles ──
  var style = document.createElement('style');
  style.textContent = [
    '#_lp_btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:#1a4d2e;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 24px rgba(0,0,0,0.28);z-index:2147483646;transition:transform .25s,box-shadow .25s;border:none;outline:none;}',
    '#_lp_btn:hover{transform:scale(1.08);box-shadow:0 6px 32px rgba(0,0,0,0.35);}',
    '#_lp_btn._lp_open{transform:rotate(45deg);}',
    '#_lp_frame_wrap{position:fixed;bottom:96px;right:24px;width:380px;height:580px;border-radius:16px;overflow:hidden;box-shadow:0 8px 48px rgba(0,0,0,0.22);z-index:2147483645;display:none;transform:translateY(12px) scale(0.97);opacity:0;transition:transform .25s,opacity .25s;}',
    '#_lp_frame_wrap._lp_open{display:block;transform:translateY(0) scale(1);opacity:1;}',
    '#_lp_frame{width:100%;height:100%;border:none;display:block;}',
    '@media(max-width:440px){#_lp_frame_wrap{width:calc(100vw - 24px);right:12px;bottom:88px;height:70vh;}}'
  ].join('');
  document.head.appendChild(style);

  // ── Button ──
  var btn = document.createElement('button');
  btn.id = '_lp_btn';
  btn.setAttribute('aria-label', 'Open chat');
  btn.innerHTML = [
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="#e8f5ec">',
    '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>',
    '</svg>'
  ].join('');

  // ── Frame wrapper ──
  var wrap = document.createElement('div');
  wrap.id = '_lp_frame_wrap';

  var iframe = document.createElement('iframe');
  iframe.id = '_lp_frame';
  iframe.src = BASE + '/widget-chat?id=' + encodeURIComponent(widgetId);
  iframe.setAttribute('allow', 'clipboard-write');
  iframe.setAttribute('title', 'LeadPro chat');
  wrap.appendChild(iframe);

  // ── Toggle ──
  var isOpen = false;
  btn.addEventListener('click', function () {
    isOpen = !isOpen;
    if (isOpen) {
      wrap.style.display = 'block';
      // Force reflow so transition fires
      wrap.offsetHeight; // eslint-disable-line
      wrap.classList.add('_lp_open');
      btn.classList.add('_lp_open');
      btn.setAttribute('aria-label', 'Close chat');
    } else {
      wrap.classList.remove('_lp_open');
      btn.classList.remove('_lp_open');
      btn.setAttribute('aria-label', 'Open chat');
      setTimeout(function () { wrap.style.display = 'none'; }, 250);
    }
  });

  // ── Unread badge (shown when iframe posts a message) ──
  var badge = document.createElement('span');
  badge.id = '_lp_badge';
  badge.style.cssText = 'position:absolute;top:-3px;right:-3px;width:16px;height:16px;border-radius:50%;background:#e85d3a;color:#fff;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center;font-family:sans-serif;';
  badge.textContent = '1';
  btn.style.position = 'fixed'; // already set above but needed for badge positioning
  btn.appendChild(badge);

  window.addEventListener('message', function (e) {
    if (e.data === 'lp:new_lead' && !isOpen) {
      badge.style.display = 'flex';
    }
    if (e.data === 'lp:opened') {
      badge.style.display = 'none';
    }
  });

  document.body.appendChild(btn);
  document.body.appendChild(wrap);
})();
