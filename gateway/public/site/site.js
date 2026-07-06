// site.js — MuchuCraft marketing site. Vanilla JS, no frameworks, no CDNs.
// Progressive enhancement only: the page is fully usable with this file blocked.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------ cluster badge
   * Honest network badge for the MUCHU section, sourced live from the gateway.
   * GET /api/token/status is fetched WITHOUT credentials — we only ever read the
   * public `cluster` field. 401 (endpoint requires a session), 404 (token module
   * not configured) or any network error simply keeps the badge hidden. */
  async function loadClusterBadge() {
    const badge = $('cluster-badge');
    if (!badge) return;
    let cluster = '';
    try {
      const res = await fetch('/api/token/status', { headers: { accept: 'application/json' } });
      if (!res.ok) return; // 401/404/5xx → badge stays hidden
      const status = await res.json();
      if (typeof status?.cluster === 'string') cluster = status.cluster.trim();
    } catch {
      return; // gateway unreachable → badge stays hidden
    }
    if (!cluster) return;

    const isMainnet = /^mainnet/i.test(cluster);
    badge.textContent = isMainnet ? 'live on mainnet' : `${cluster} beta`;
    badge.classList.toggle('cluster-beta', !isMainnet);
    badge.classList.remove('hidden');

    // Devnet play-money disclaimer only when the live cluster really is devnet.
    const note = $('devnet-note');
    if (note && /^devnet$/i.test(cluster)) note.classList.remove('hidden');
  }

  /* ------------------------------------------------------------ sticky nav */
  function initNav() {
    const nav = $('site-nav');
    if (!nav) return;
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    // Highlight the nav link of the section in view.
    const links = Array.from(nav.querySelectorAll('.nav-links a[href^="#"]'));
    if (!links.length || !('IntersectionObserver' in window)) return;
    const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          links.forEach((a) => a.classList.remove('active'));
          byId.get(entry.target.id)?.classList.add('active');
        }
      },
      { rootMargin: '-30% 0px -60% 0px' },
    );
    for (const id of byId.keys()) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
  }

  /* ------------------------------------------------------------ reveal cards
   * CSS only hides .reveal elements under <html class="js-reveal"> and when the
   * user allows motion — so a JS failure can never blank the page. */
  function initReveal() {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const items = Array.from(document.querySelectorAll('.reveal'));
    if (reduced || !items.length || !('IntersectionObserver' in window)) return;
    document.documentElement.classList.add('js-reveal');
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -5% 0px' },
    );
    items.forEach((el) => observer.observe(el));
  }

  /* ------------------------------------------------------------ footer year */
  function initYear() {
    const el = $('footer-year');
    if (el) el.textContent = `© ${new Date().getFullYear()}`;
  }

  initNav();
  initReveal();
  initYear();
  loadClusterBadge();
})();
