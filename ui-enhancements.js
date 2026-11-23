(function () {
  'use strict';
  const doc = document;
  const shell = doc.getElementById('appShell');
  const topbar = doc.getElementById('topbar');
  const environment = doc.getElementById('environmentBanner');
  const connection = doc.getElementById('connectionBanner');
  const tabs = doc.getElementById('tabs');
  if (!shell || !topbar || !tabs) return;

  let scheduled = false;
  function measureHeaders() {
    const height = element => element ? Math.ceil(element.getBoundingClientRect().height) : 0;
    const top = height(topbar), env = height(environment), offline = height(connection);
    const style = doc.documentElement.style;
    style.setProperty('--topbar-height', top + 'px');
    style.setProperty('--environment-height', env + 'px');
    style.setProperty('--connection-height', offline + 'px');
    style.setProperty('--sticky-header-height', (top + env + offline + height(tabs)) + 'px');
  }
  function associateLabels() {
    // Solo el control hermano inmediato: no adivinar entre grupos de campos.
    for (const label of shell.querySelectorAll('label:not([for])')) {
      if (label.querySelector('input,select,textarea')) continue;
      const control = label.nextElementSibling;
      if (!control || !control.matches('input:not([type=hidden]),select,textarea') || !control.id) continue;
      if (doc.getElementById(control.id) !== control || (control.labels && control.labels.length)) continue;
      label.htmlFor = control.id;
    }
  }
  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      measureHeaders();
      associateLabels();
    });
  }
  function updateConnection() {
    if (!connection) return;
    const offline = navigator.onLine === false;
    connection.hidden = !offline;
    connection.textContent = offline
      ? 'Sin conexión. Podés consultar lo ya cargado; los cambios necesitan conexión para guardarse.'
      : '';
    scheduleUpdate();
  }
  function revealCurrentSection() {
    const active = tabs.querySelector('[aria-current="page"]');
    if (!active) return;
    const bar = tabs.getBoundingClientRect(), item = active.getBoundingClientRect();
    if (item.left < bar.left) tabs.scrollLeft += item.left - bar.left - 8;
    else if (item.right > bar.right) tabs.scrollLeft += item.right - bar.right + 8;
  }
  window.ZondaUi = Object.freeze({
    viewChanged() { scheduleUpdate(); revealCurrentSection(); }
  });
  window.addEventListener('resize', scheduleUpdate, {passive: true});
  window.addEventListener('online', updateConnection);
  window.addEventListener('offline', updateConnection);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(scheduleUpdate);
    for (const element of [topbar, environment, connection, tabs]) if (element) observer.observe(element);
  }
  if (typeof MutationObserver === 'function') {
    const contents = new MutationObserver(scheduleUpdate);
    contents.observe(shell, {childList: true, subtree: true});
    const visibility = new MutationObserver(scheduleUpdate);
    for (const element of [shell, environment, connection]) {
      if (element) visibility.observe(element, {attributes: true, attributeFilter: ['class', 'hidden']});
    }
  }
  updateConnection();
  scheduleUpdate();
}());
