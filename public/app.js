const THEMES = [
  { id: 'midnight', name: 'Midnight', tag: 'dark', colors: ['#0a0712', '#a855f7', '#22d3ee'] },
  { id: 'obsidian', name: 'Obsidian', tag: 'dark', colors: ['#060607', '#d9f99d', '#a3e635'] },
  { id: 'nord', name: 'Nord', tag: 'dark', colors: ['#141b23', '#88c0d0', '#b48ead'] },
  { id: 'sakura', name: 'Sakura', tag: 'light', colors: ['#fff5f8', '#e8618c', '#f59e0b'] },
  { id: 'sunset', name: 'Sunset', tag: 'dark', colors: ['#180e14', '#fb923c', '#f43f5e'] },
  { id: 'emerald', name: 'Emerald', tag: 'dark', colors: ['#06120f', '#34d399', '#22d3ee'] },
  { id: 'cyberpunk', name: 'Cyberpunk', tag: 'dark', colors: ['#08040f', '#ff2fb3', '#00f5ff'] },
  { id: 'mocha', name: 'Mocha', tag: 'light', colors: ['#f6efe6', '#a16207', '#0f766e'] },
  { id: 'paper', name: 'Paper', tag: 'light', colors: ['#fbfbfa', '#2563eb', '#7c3aed'] },
  { id: 'ocean', name: 'Ocean', tag: 'dark', colors: ['#04121f', '#38bdf8', '#818cf8'] },
  { id: 'amethyst', name: 'Amethyst', tag: 'dark', colors: ['#120a1c', '#c084fc', '#f472b6'] },
  { id: 'terminal', name: 'Terminal', tag: 'dark', colors: ['#020602', '#4ade80', '#86efac'] },
];

const STORE = { theme: 'veil.theme', recent: 'veil.recent' };
const root = document.documentElement;
const panel = document.getElementById('theme-panel');
const scrim = document.getElementById('scrim');
const grid = document.getElementById('theme-grid');
const address = document.getElementById('address');
const omnibox = document.getElementById('omnibox');
const recentWrap = document.getElementById('recent');
const recentList = document.getElementById('recent-list');

/* ---------------------------------------------------------------- theme */

function applyTheme(id, persist = true) {
  const theme = THEMES.find((item) => item.id === id) || THEMES[0];
  root.setAttribute('data-theme', theme.id);
  root.style.colorScheme = theme.tag;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.colors[0]);
  for (const card of grid.children) {
    card.setAttribute('aria-pressed', String(card.dataset.theme === theme.id));
  }
  if (persist) {
    try { localStorage.setItem(STORE.theme, theme.id); } catch { /* storage may be blocked */ }
  }
  return theme.id;
}

function buildThemeGrid() {
  const fragment = document.createDocumentFragment();
  for (const theme of THEMES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card';
    card.dataset.theme = theme.id;
    card.setAttribute('aria-pressed', 'false');
    card.setAttribute('aria-label', `${theme.name} theme`);
    card.innerHTML = `
      <span class="theme-swatch" aria-hidden="true">
        ${theme.colors.map((color) => `<span style="background:${color}"></span>`).join('')}
      </span>
      <span class="theme-meta">
        <span class="theme-name">${theme.name}</span>
        <span class="theme-tag">${theme.tag}</span>
      </span>`;
    card.addEventListener('click', () => applyTheme(theme.id));
    fragment.appendChild(card);
  }
  grid.appendChild(fragment);
}

function openPanel() {
  panel.hidden = false;
  scrim.hidden = false;
  panel.querySelector('button, [href]')?.focus();
}

function closePanel() {
  panel.hidden = true;
  scrim.hidden = true;
  document.getElementById('theme-open')?.focus();
}

/* -------------------------------------------------------------- history */

function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE.recent) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

function remember(target) {
  const next = [target, ...readRecent().filter((item) => item !== target)].slice(0, 5);
  try { localStorage.setItem(STORE.recent, JSON.stringify(next)); } catch { /* ignore */ }
}

function renderRecent() {
  const items = readRecent();
  recentList.textContent = '';
  recentWrap.hidden = items.length === 0;
  for (const item of items) {
    const link = document.createElement('a');
    link.className = 'recent-item';
    link.href = `/__p/${item}`;
    link.textContent = item.replace(/^https?:\/\//, '').replace(/\/$/, '');
    link.title = item;
    recentList.appendChild(link);
  }
}

/* ------------------------------------------------------------- resolve */

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;
const SEARCH = 'https://duckduckgo.com/?q=';

function resolve(input) {
  const value = input.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z]+:\/\//i.test(value)) return null;
  if (DOMAIN.test(value) || /^localhost(?::\d+)?(\/|$)/.test(value)) return `https://${value}`;
  return SEARCH + encodeURIComponent(value);
}

omnibox.addEventListener('submit', (event) => {
  event.preventDefault();
  const target = resolve(address.value);
  if (!target) {
    address.focus();
    return;
  }
  remember(target);
  location.href = `/__p/${target}`;
});

/* ---------------------------------------------------------------- wiring */

document.getElementById('theme-open').addEventListener('click', openPanel);
document.getElementById('theme-close').addEventListener('click', closePanel);
scrim.addEventListener('click', closePanel);
panel.addEventListener('click', (event) => event.stopPropagation());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !panel.hidden) closePanel();
  if (event.key === '/' && document.activeElement !== address) {
    event.preventDefault();
    address.focus();
    address.select();
  }
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => remember(chip.href.replace('/__p/', '')));
});

fetch('/healthz')
  .then((response) => {
    document.getElementById('status-text').textContent = response.ok ? 'online' : 'degraded';
  })
  .catch(() => {
    document.getElementById('status-text').textContent = 'offline';
  });

let saved = null;
try { saved = localStorage.getItem(STORE.theme); } catch { /* ignore */ }
buildThemeGrid();
applyTheme(saved || 'midnight', false);
renderRecent();
address.focus({ preventScroll: true });
