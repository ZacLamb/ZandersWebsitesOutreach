(function () {
  var cfg = JSON.parse(document.getElementById('est-config').textContent);
  var $ = function (id) { return document.getElementById(id); };
  var size = $('est-size'), range = $('est-range'), option = $('est-option'), access = $('est-access');
  var addon = $('est-addon'), addonWrap = $('est-addon-wrap');
  var used = false;

  function project() {
    var id = document.querySelector('input[name="est-project"]:checked').value;
    return cfg.projects.filter(function (p) { return p.id === id; })[0];
  }
  function money(n) {
    var r = n >= 10000 ? 500 : n >= 2000 ? 100 : 50;
    return '$' + (Math.round(n / r) * r).toLocaleString('en-US');
  }
  function load() {
    var p = project();
    $('est-size-label').textContent = p.sizeLabel;
    $('est-unit').textContent = p.unit;
    $('est-hint').textContent = p.hint;
    [size, range].forEach(function (el) { el.min = p.min; el.max = p.max; el.step = p.step; el.value = p.start; });
    $('est-option-label').textContent = p.options.label;
    option.innerHTML = '';
    p.options.choices.forEach(function (c) { var o = document.createElement('option'); o.value = c.id; o.textContent = c.label; option.appendChild(o); });
    addonWrap.hidden = !p.addon;
    addon.checked = false;
    if (p.addon) $('est-addon-label').textContent = p.addon.label;
    calc();
  }
  function calc() {
    var p = project();
    var qty = Math.min(p.max, Math.max(p.min, parseFloat(size.value) || p.min));
    var c = p.options.choices.filter(function (x) { return x.id === option.value; })[0] || p.options.choices[0];
    var a = cfg.access.filter(function (x) { return x.id === access.value; })[0] || cfg.access[0];
    var low = qty * c.low, high = qty * c.high;
    if (p.addon && addon.checked) { low += qty * p.addon.low; high += qty * p.addon.high; }
    low = Math.max(p.minimum, low * a.factor);
    high = Math.max(low * 1.25, high * a.factor);
    $('est-low').textContent = money(low);
    $('est-high').textContent = money(high);
    $('estbar-range').textContent = money(low) + ' to ' + money(high);
    var summary = p.name + ': ' + qty.toLocaleString('en-US') + ' ' + p.unit + ', ' + c.label.toLowerCase() +
      (p.addon && addon.checked ? ', ' + p.addon.label.toLowerCase() : '') + ', access ' + a.id;
    $('est-summary').textContent = summary;
    $('est-service').value = p.service;
    $('est-hidden').value = summary + '. Ballpark shown: ' + money(low) + ' to ' + money(high);
  }
  function touched() {
    if (used) return;
    used = true;
    var body = JSON.stringify({ type: 'estimate_used', path: location.pathname, label: project().id, ref: '' });
    if (navigator.sendBeacon) navigator.sendBeacon('/t', body);
  }
  document.querySelectorAll('input[name="est-project"]').forEach(function (r) { r.addEventListener('change', function () { load(); touched(); }); });
  size.addEventListener('input', function () { range.value = size.value; calc(); touched(); });
  range.addEventListener('input', function () { size.value = range.value; calc(); touched(); });
  [option, access, addon].forEach(function (el) { el.addEventListener('change', function () { calc(); touched(); }); });
  load();
})();
