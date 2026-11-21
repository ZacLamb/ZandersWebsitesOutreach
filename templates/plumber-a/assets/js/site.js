(function () {
  // Mobile nav
  var t = document.querySelector('.nav-toggle'), n = document.getElementById('nav');
  if (t && n) t.addEventListener('click', function () {
    var o = n.classList.toggle('open'); t.setAttribute('aria-expanded', o);
  });

  // Call click tracking
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="tel:"]');
    if (a && window.gtag) gtag('event', 'phone_call_click', { link_url: a.href, page_path: location.pathname });
  });

  // Lead forms: submit via fetch, fall back to normal POST if JS fails
  document.querySelectorAll('[data-lead-form]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.fetch) return;
      e.preventDefault();
      var btn = f.querySelector('button[type=submit]'), msg = f.querySelector('.lf-msg');
      btn.disabled = true; btn.textContent = 'Sending…'; msg.className = 'lf-msg'; msg.textContent = '';
      fetch(f.action, { method: 'POST', headers: { 'Accept': 'application/json' }, body: new URLSearchParams(new FormData(f)) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Error'); return j; }); })
        .then(function () { location.href = '/thank-you'; })
        .catch(function (err) {
          btn.disabled = false; btn.textContent = 'Get My Free Estimate';
          msg.className = 'lf-msg err';
          msg.textContent = err.message && err.message !== 'Error' ? err.message : 'Something went wrong — please call us instead.';
        });
    });
  });
})();
