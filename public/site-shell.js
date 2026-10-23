/* HomeCraft accessible navigation enhancement: works without external libraries. */
(() => {
  'use strict';
  const nav = document.getElementById('primary-navigation');
  const toggle = document.querySelector('.mobile-toggle');
  if (!nav || !toggle) return;
  document.documentElement.classList.add('site-js');
  const setOpen = open => {
    const active = Boolean(open);
    document.documentElement.classList.toggle('nav-open', active);
    toggle.setAttribute('aria-expanded', String(active));
    toggle.setAttribute('aria-label', active ? 'Закрити навігацію' : 'Відкрити навігацію');
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', event => { if (event.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setOpen(false); toggle.focus(); } });
  window.matchMedia('(min-width: 901px)').addEventListener('change', event => { if (event.matches) setOpen(false); });
})();
