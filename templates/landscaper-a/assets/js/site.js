(function () {
  // Mobile menu
  var burger = document.querySelector('.burger'), nav = document.getElementById('nav');
  if (burger) burger.addEventListener('click', function () {
    var open = nav.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', open);
  });

  // Traffic tracking: page views plus taps on call, email and quote buttons.
  function send(type, label) {
    var body = JSON.stringify({ type: type, path: location.pathname, label: label || '', ref: document.referrer || '' });
    if (navigator.sendBeacon) navigator.sendBeacon('/t', body);
    else fetch('/t', { method: 'POST', body: body, keepalive: true });
  }
  if (!/^\/admin/.test(location.pathname)) send('pageview');
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-track], a[href^="tel:"], a[href^="mailto:"]');
    if (!el) return;
    var type = el.getAttribute('data-track') || (el.href.indexOf('tel:') === 0 ? 'call_click' : 'email_click');
    send(type, el.getAttribute('data-label') || '');
  });
  var started = false;
  document.querySelectorAll('[data-quote]').forEach(function (f) {
    f.addEventListener('focusin', function () { if (!started) { started = true; send('form_start'); } });
  });

  // Reveal sections as they scroll in
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.08 });
    document.querySelectorAll('.sec, .cta').forEach(function (s) { s.classList.add('rv'); io.observe(s); });
  }
})();
