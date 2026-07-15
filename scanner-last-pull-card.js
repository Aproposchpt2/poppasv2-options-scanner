document.addEventListener('DOMContentLoaded', function () {
  var metrics = document.querySelector('#scanner .metrics');
  if (!metrics) return;
  var card = document.createElement('div');
  card.className = 'metric';
  card.innerHTML = '<span>Last File Pull</span><strong id="lastFilePullValue">Loading...</strong>';
  metrics.appendChild(card);
  function syncLastPull() {
    var source = document.getElementById('truthLastScan');
    var target = document.getElementById('lastFilePullValue');
    if (source && target) target.textContent = source.textContent || 'Unavailable';
  }
  syncLastPull();
  window.setInterval(syncLastPull, 2000);
});
