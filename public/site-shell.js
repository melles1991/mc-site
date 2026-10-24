/* One shared navigation / page-shell behaviour for all HomeCraft pages. */
(() => {
  'use strict';
  const nav = document.getElementById('primary-navigation');
  const toggle = document.querySelector('.mobile-toggle');
  if (!nav || !toggle) return;
  document.documentElement.classList.add('site-js');
  const path = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  const grouped = ['/profile', '/login', '/register', '/forgot-password', '/reset-password'];
  for (const anchor of nav.querySelectorAll('a[href]')) {
    const href = new URL(anchor.href).pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
    const active = (href === path) || (href === '/login' && grouped.includes(path));
    anchor.classList.toggle('active', active);
    if (active) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  const setOpen = open => {
    const active = Boolean(open);
    document.documentElement.classList.toggle('nav-open', active);
    toggle.setAttribute('aria-expanded', String(active));
    toggle.setAttribute('aria-label', active ? 'Закрити навігацію' : 'Відкрити навігацію');
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', event => { if (event.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setOpen(false); toggle.focus(); }
  });
  window.matchMedia('(min-width: 1101px)').addEventListener('change', event => { if (event.matches) setOpen(false); });
})();
