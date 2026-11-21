(function () {
  var f = document.getElementById('quote'); if (!f || !window.QuoteCalc) return;
  var steps = {}; f.querySelectorAll('.q-step').forEach(function (el) { steps[el.dataset.step] = el; });
  var FLOWS = {
    roof:   ['project', 'home', 'size', 'roof', 'contact', 'result'],
    siding: ['project', 'home', 'size', 'contact', 'result'],
    repair: ['project', 'repair', 'contact', 'result']
  };
  var flow = ['project', 'home', 'size', 'contact', 'result'], i = 0;
  var next = document.getElementById('q-next'), back = document.getElementById('q-back'), err = document.getElementById('q-err');
  var prog = f.querySelector('.q-progress');
  var val = function (n) { var el = f.elements[n]; return el ? (el.value || '') : ''; };
  var radio = function (n) { var el = f.querySelector('input[name="' + n + '"]:checked'); return el ? el.value : ''; };
  function track(ev, p) { if (window.gtag) gtag('event', ev, p || {}); }

  function show() {
    var cur = flow[i];
    Object.keys(steps).forEach(function (k) { steps[k].classList.toggle('active', k === cur); });
    prog.innerHTML = flow.map(function (_, n) { return '<span class="' + (n <= i ? 'on' : '') + '"></span>'; }).join('');
    back.hidden = i === 0 || cur === 'result';
    next.style.display = cur === 'result' ? 'none' : '';
    next.textContent = cur === 'contact' ? 'Show My Estimate →' : 'Next →';
    err.textContent = '';
    var first = steps[cur].querySelector('input:not([type=hidden]),select');
    if (i > 0 && first && cur !== 'result') setTimeout(function () { try { first.focus({ preventScroll: true }); } catch (e) {} }, 50);
    if (shown) f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    shown = true;
  }
  var shown = false;

  function valid() {
    var cur = flow[i];
    if (cur === 'project' && !radio('project')) return 'Pick one to get started.';
    if (cur === 'repair' && !radio('repair')) return 'Choose the closest option (or "Not sure").';
    if (cur === 'home' && !radio('home')) return 'Choose your type of home.';
    if (cur === 'contact') {
      if (!val('name').trim()) return 'Please add your name.';
      if (val('phone').replace(/\D/g, '').length < 10) return 'Please add a 10-digit phone number.';
      if (!val('town')) return 'Please choose your town.';
      var e = val('email').trim(); if (e && !/^\S+@\S+\.\S+$/.test(e)) return 'That email doesn\'t look right.';
    }
    return '';
  }

  function inputs() {
    return { project: radio('project'), repair: radio('repair'), home: radio('home'), sqft: val('sqft'),
      pitch: radio('pitch'), layers: val('layers'), chimneys: val('chimneys'), skylights: val('skylights') };
  }

  function submit() {
    var q = inputs(), est = QuoteCalc.estimate(q);
    f.elements.service.value = { roof: 'Roof Replacement', siding: 'Vinyl Siding Installation', repair: 'Roof Repair' }[est.project];
    next.disabled = true; next.textContent = 'Working…';
    var data = new URLSearchParams(new FormData(f));
    fetch(f.action, { method: 'POST', headers: { 'Accept': 'application/json' }, body: data })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Error'); return j; }); })
      .then(function (j) {
        var e = j.estimate || est;
        document.getElementById('q-price').innerHTML = QuoteCalc.money(e.low) + ' <span>–</span> ' + QuoteCalc.money(e.high);
        document.getElementById('q-summary').innerHTML = e.details.map(function (d) { return '<span>' + d.replace(/</g, '&lt;') + '</span>'; }).join('');
        track('generate_lead', { form: 'instant_quote', value: Math.round((e.low + e.high) / 2), currency: 'USD' });
        i = flow.indexOf('result'); show();
      })
      .catch(function (e) {
        err.textContent = e.message && e.message !== 'Error' ? e.message : 'Something went wrong — please call us and we\'ll quote you by phone.';
      })
      .then(function () { next.disabled = false; if (flow[i] !== 'result') next.textContent = 'Show My Estimate →'; });
  }

  next.addEventListener('click', function () {
    var m = valid(); if (m) { err.textContent = m; return; }
    if (flow[i] === 'project') { flow = FLOWS[radio('project')]; track('quote_start', { project: radio('project') }); }
    if (flow[i] === 'contact') return submit();
    i++; show();
  });
  back.addEventListener('click', function () { if (i > 0) { i--; show(); } });
  // Auto-advance on single-choice steps
  f.addEventListener('change', function (e) {
    var cur = flow[i];
    if (e.target.type === 'radio' && (cur === 'project' || cur === 'repair' || cur === 'home')) setTimeout(function () { next.click(); }, 180);
  });
  f.addEventListener('submit', function (e) { e.preventDefault(); next.click(); });
  var s = document.getElementById('sqft'), o = document.getElementById('sqft-out');
  s.addEventListener('input', function () { o.textContent = Number(s.value).toLocaleString('en-US') + (s.value >= 6000 ? '+' : ''); });
  show();
})();
