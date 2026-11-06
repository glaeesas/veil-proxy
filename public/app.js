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

// Plain-HTML engines only: a JavaScript-only results page renders blank through
// a rewriting proxy, which is exactly why duckduckgo.com/?q= came up black.
const ENGINES = [
  { id: 'ddg-html', name: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=' },
  { id: 'ddg-lite', name: 'DuckDuckGo Lite', url: 'https://lite.duckduckgo.com/lite/?q=' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=' },
  { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
];

const STORE = {
  theme: 'veil.theme',
  recent: 'veil.recent',
  engine: 'veil.engine',
  title: 'veil.title',
  wisp: 'veil.wisp',
};
const DEFAULT_TITLE = 'Veil — browse through the veil';

const root = document.documentElement;
const panel = document.getElementById('theme-panel');
const scrim = document.getElementById('scrim');
const grid = document.getElementById('theme-grid');
const address = document.getElementById('address');
const omnibox = document.getElementById('omnibox');
const recentWrap = document.getElementById('recent');
const recentList = document.getElementById('recent-list');
const guardBtn = document.getElementById('guard-toggle');
const guardState = document.getElementById('guard-state');
const engineSelect = document.getElementById('engine-select');
const titleInput = document.getElementById('title-input');
const wispInput = document.getElementById('wisp-input');
const brandName = document.getElementById('brand-name');

/* --------------------------------------------------------------- storage */

function readSetting(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage may be blocked */ }
}

/* ---------------------------------------------------- opaque proxy paths */

// Destinations are base64url-encoded into the path, so the address bar and the
// browser's hover preview never spell out where a link goes.
function encodeTarget(url) {
  const bytes = new TextEncoder().encode(url);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function proxyHref(url) {
  return `/__p/${encodeTarget(url)}`;
}

// Static markup carries readable /__p/https://… links for source readability;
// swap them for opaque ones before the user can hover anything.
function encodeLinks() {
  for (const link of document.querySelectorAll('a[href^="/__p/"]')) {
    const raw = link.getAttribute('href').slice('/__p/'.length);
    if (!/^https?:\/\//i.test(raw)) continue;
    link.dataset.target = raw;
    link.setAttribute('href', proxyHref(raw));
  }
}

/* ------------------------------------------------------------ anti-close */

const GUARD_KEY = 'veil.anticlose';
let internalNav = false;

function guardEnabled() {
  try { return localStorage.getItem(GUARD_KEY) !== 'off'; } catch { return true; }
}

function setGuard(enabled) {
  try { localStorage.setItem(GUARD_KEY, enabled ? 'on' : 'off'); } catch { /* ignore */ }
}

function renderGuard() {
  const on = guardEnabled();
  guardBtn.setAttribute('aria-pressed', String(on));
  guardState.textContent = on ? 'On' : 'Off';
}

window.addEventListener('beforeunload', (event) => {
  if (!guardEnabled() || internalNav) return undefined;
  event.preventDefault();
  event.returnValue = 'Leave site?';
  return 'Leave site?';
});

document.addEventListener(
  'click',
  (event) => {
    const link = event.target.closest ? event.target.closest('a[href]') : null;
    if (link && link.origin === location.origin) internalNav = true;
  },
  true,
);

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
  if (persist) writeSetting(STORE.theme, theme.id);
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

function labelFor(target) {
  try {
    return new URL(target).hostname.replace(/^www\./, '');
  } catch {
    return 'recent';
  }
}

function renderRecent() {
  const items = readRecent();
  recentList.textContent = '';
  recentWrap.hidden = items.length === 0;
  for (const item of items) {
    const link = document.createElement('a');
    link.className = 'recent-item';
    link.href = proxyHref(item);
    link.dataset.target = item;
    link.textContent = labelFor(item);
    recentList.appendChild(link);
  }
}

/* ------------------------------------------------------------- settings */

function engineTemplate() {
  const id = readSetting(STORE.engine, ENGINES[0].id);
  return (ENGINES.find((engine) => engine.id === id) || ENGINES[0]).url;
}

function applyTitle(value) {
  const title = String(value || '').trim();
  document.title = title || DEFAULT_TITLE;
  brandName.textContent = (title.split(/[—–|]/)[0] || 'Veil').trim() || 'Veil';
}

function buildSettings() {
  const fragment = document.createDocumentFragment();
  for (const engine of ENGINES) {
    const option = document.createElement('option');
    option.value = engine.id;
    option.textContent = engine.name;
    fragment.appendChild(option);
  }
  engineSelect.appendChild(fragment);

  engineSelect.value = readSetting(STORE.engine, ENGINES[0].id);
  titleInput.value = readSetting(STORE.title, '');
  wispInput.value = readSetting(STORE.wisp, '');
  applyTitle(titleInput.value);

  engineSelect.addEventListener('change', () => writeSetting(STORE.engine, engineSelect.value));
  titleInput.addEventListener('input', () => {
    writeSetting(STORE.title, titleInput.value);
    applyTitle(titleInput.value);
  });
  wispInput.addEventListener('input', () => writeSetting(STORE.wisp, wispInput.value.trim()));
}

/* ------------------------------------------------------------- resolve */

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;

function resolve(input) {
  const value = input.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z]+:\/\//i.test(value)) return null;
  if (DOMAIN.test(value) || /^localhost(?::\d+)?(\/|$)/.test(value)) return `https://${value}`;
  return engineTemplate() + encodeURIComponent(value);
}

omnibox.addEventListener('submit', (event) => {
  event.preventDefault();
  const target = resolve(address.value);
  if (!target) {
    address.focus();
    return;
  }
  remember(target);
  internalNav = true;
  location.href = proxyHref(target);
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

guardBtn.addEventListener('click', () => {
  setGuard(!guardEnabled());
  renderGuard();
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    if (chip.dataset.target) remember(chip.dataset.target);
  });
});

fetch('/healthz')
  .then((response) => {
    document.getElementById('status-text').textContent = response.ok ? 'online' : 'degraded';
  })
  .catch(() => {
    document.getElementById('status-text').textContent = 'offline';
  });

encodeLinks();
buildThemeGrid();
buildSettings();
applyTheme(readSetting(STORE.theme, 'midnight'), false);
renderGuard();
renderRecent();
address.focus({ preventScroll: true });
