// muchu.app — tiny, dependency-free.

// Scroll reveals (skipped when the user prefers reduced motion).
if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
} else {
  document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
}

// Copy-to-clipboard for the token address.
const copyBtn = document.getElementById('copy-token');
if (copyBtn) {
  copyBtn.addEventListener('click', async () => {
    const hint = document.getElementById('copy-hint');
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.address);
      hint.textContent = 'copied ✓';
    } catch {
      hint.textContent = 'select & copy';
    }
    setTimeout(() => { hint.textContent = 'copy'; }, 2000);
  });
}

// Live cluster badge — degrades to hidden if the game host is unreachable.
fetch('https://web.muchu.app/api/token/status', { signal: AbortSignal.timeout(4000) })
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => {
    if (!s?.cluster) return;
    const b = document.getElementById('cluster-badge');
    b.textContent = s.cluster;
    b.hidden = false;
  })
  .catch(() => {});
