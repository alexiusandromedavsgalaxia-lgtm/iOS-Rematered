// src/apps/Safari.jsx
// iOS Remastered — Safari.app
// Navegador simulado: barra de direcciones, pestañas, historial, favoritos,
// lector, búsqueda, y descarga de .ipa a /Downloads con el flujo de instalación
// conectado a IPAInstaller.
// Sin dependencias externas.

import React, {
  useState, useEffect, useRef, useMemo, useCallback, useReducer,
} from 'react';

import { useOS } from '../context/OSContext.jsx';
import { toast } from '../ui/Toast.jsx';
import { alert } from '../ui/Alert.jsx';
import { Icon } from '../ui/Icon.jsx';
import { Blur } from '../ui/Blur.jsx';
import { TapHandler, useGesture, Swipeable } from '../ui/GestureHandler.jsx';

/* ============================================================================
 * CONSTANTES
 * ========================================================================== */

const SAFARI_DB = '/private/var/mobile/Library/Safari/Safari.json';

const DOWNLOADS_DIR = '/private/var/mobile/Downloads';

const START_PAGE = 'safari://start';

const BOOKMARKS_DEFAULT = [
  { id: 'bm_apple',   title: 'Apple',          url: 'https://www.apple.com' },
  { id: 'bm_icloud',  title: 'iCloud',         url: 'https://www.icloud.com' },
  { id: 'bm_dev',     title: 'Developer',      url: 'https://developer.apple.com' },
  { id: 'bm_store',   title: 'App Store',      url: 'https://apps.apple.com' },
];

/* ============================================================================
 * SITIOS SIMULADOS
 * Cada sitio tiene contenido generado para que el navegador se sienta real.
 * ========================================================================== */

const SITES = {
  'apple.com': {
    title: 'Apple',
    theme: { bg: '#000', fg: '#fff', accent: '#0a84ff' },
    body: (url) => `
      <header class="site-nav">
        <span class="site-logo"></span>
        <nav>
          <a>Store</a><a>Mac</a><a>iPad</a><a>iPhone</a><a>Watch</a><a>AirPods</a>
          <a>TV & Casa</a><a>Entretenimiento</a><a>Accesorios</a><a>Soporte</a>
        </nav>
      </header>
      <section class="site-hero">
        <h1>iPhone 17 Pro</h1>
        <p class="sub">Titanio. Tan potente. Tan ligero.</p>
        <a class="site-cta">Más información ›</a>
      </section>
      <section class="site-grid">
        <div class="site-card dark"><h3>iPhone 17</h3><p>Un nuevo nivel.</p></div>
        <div class="site-card light"><h3>Apple Watch</h3><p>Salud a tu muñeca.</p></div>
        <div class="site-card dark"><h3>MacBook Pro</h3><p>Más M. Más Pro.</p></div>
        <div class="site-card light"><h3>AirPods Pro</h3><p>Sonido adaptativo.</p></div>
      </section>
    `,
  },

  'apps.apple.com': {
    title: 'App Store',
    theme: { bg: '#000', fg: '#fff', accent: '#0a84ff' },
    body: () => `
      <div class="site-appstore">
        <div class="site-appstore-hero">
          <div class="site-appstore-icon" style="background:linear-gradient(135deg,#0a84ff,#5e5ce6)"></div>
          <div class="site-appstore-meta">
            <h2>iOS Remastered</h2>
            <p>Developer Tools · Gratis</p>
            <button class="site-appstore-btn">OBTENER</button>
          </div>
        </div>
        <h3>Novedades</h3>
        <p class="site-p">Versión 1.0.0 · Hace 1 semana</p>
        <p class="site-p">El OS simulado completo en tu navegador. Kernel, drivers, loader Mach-O, apps nativas. Todo a mano, sin librerías externas.</p>
        <h3>Vista previa</h3>
        <div class="site-appstore-screens">
          <div class="site-appstore-shot"></div>
          <div class="site-appstore-shot"></div>
          <div class="site-appstore-shot"></div>
        </div>
      </div>
    `,
  },

  'developer.apple.com': {
    title: 'Apple Developer',
    theme: { bg: '#1d1d1f', fg: '#f5f5f7', accent: '#0a84ff' },
    body: () => `
      <div class="site-dev">
        <h1>Developer</h1>
        <div class="site-dev-grid">
          <div class="site-dev-card">
            <h3>Xcode 16</h3>
            <p>Compila, prueba y distribuye apps para todas las plataformas Apple.</p>
          </div>
          <div class="site-dev-card">
            <h3>Human Interface Guidelines</h3>
            <p>Diseña apps que se sientan nativas en iOS, iPadOS, macOS.</p>
          </div>
          <div class="site-dev-card">
            <h3>Notarización</h3>
            <p>Envía apps firmadas y verificadas a los usuarios.</p>
          </div>
          <div class="site-dev-card">
            <h3>TestFlight</h3>
            <p>Distribuye betas a miles de testers con un solo clic.</p>
          </div>
        </div>
      </div>
    `,
  },

  'wikipedia.org': {
    title: 'Wikipedia',
    theme: { bg: '#fff', fg: '#202122', accent: '#3366cc' },
    body: (url) => {
      const q = extractQuery(url) || 'iOS';
      return `
        <div class="site-wiki">
          <h1 class="site-wiki-title">${escapeHtml(q)}</h1>
          <p class="site-wiki-lead">
            <strong>${escapeHtml(q)}</strong> es un tema de interés general.
            Este artículo forma parte de la enciclopedia libre que cualquiera puede editar.
          </p>
          <h2>Historia</h2>
          <p>El concepto ha evolucionado a lo largo del tiempo, con aportaciones de múltiples
          disciplinas y comunidades. Los primeros registros documentados datan del siglo pasado
          y su desarrollo ha sido continuo desde entonces.</p>
          <h2>Características</h2>
          <ul>
            <li>Interdisciplinario</li>
            <li>Ampliamente documentado</li>
            <li>Objeto de estudio académico</li>
            <li>Con aplicaciones prácticas</li>
          </ul>
          <h2>Véase también</h2>
          <p>Otros artículos relacionados: <a>Portal de ciencia</a>, <a>Portal de tecnología</a>.</p>
        </div>
      `;
    },
  },

  'news.ycombinator.com': {
    title: 'Hacker News',
    theme: { bg: '#f6f6ef', fg: '#000', accent: '#ff6600' },
    body: () => {
      const stories = [
        ['Show HN: Construí un OS en React, sin librerías externas', '312', '184'],
        ['Mach-O, explicado desde el kernel hasta el usuario', '201', '94'],
        ['Por qué los schedulers de tiempo real son difíciles', '188', '72'],
        ['Face ID: cómo funciona de verdad', '156', '41'],
        ['El FileSystem virtual que nunca pensaste que necesitabas', '142', '33'],
        ['Drivers simulados: 21 módulos V* en un iPhone falso', '128', '27'],
        ['La elegancia de UIKit en 2026', '114', '19'],
      ];
      return `
        <div class="site-hn">
          <header><span class="site-hn-logo">Y</span> <strong>Hacker News</strong>
            <span class="site-hn-nav">new | past | comments | ask | show | jobs</span>
          </header>
          <ol>
            ${stories.map(([t, p, c]) => `
              <li>
                <a class="site-hn-title">${escapeHtml(t)}</a>
                <span class="site-hn-meta">${p} points · ${c} comments</span>
              </li>
            `).join('')}
          </ol>
        </div>
      `;
    },
  },

  'github.com': {
    title: 'GitHub',
    theme: { bg: '#0d1117', fg: '#c9d1d9', accent: '#58a6ff' },
    body: () => `
      <div class="site-gh">
        <div class="site-gh-header">
          <h1>iOS-Remastered</h1>
          <p class="site-gh-desc">Un OS completo simulado en React. Kernel, drivers, loader, apps. Sin librerías externas.</p>
          <div class="site-gh-meta">
            <span>⭐ 12.4k</span>
            <span>🍴 1.2k</span>
            <span>👀 234</span>
          </div>
        </div>
        <div class="site-gh-files">
          <div class="site-gh-file">📁 system/</div>
          <div class="site-gh-file">📁 kernel/</div>
          <div class="site-gh-file">📁 drivers/</div>
          <div class="site-gh-file">📁 loader/</div>
          <div class="site-gh-file">📁 ui/</div>
          <div class="site-gh-file">📁 apps/</div>
          <div class="site-gh-file">📄 README.md</div>
          <div class="site-gh-file">📄 package.json</div>
        </div>
      </div>
    `,
  },

  'stackoverflow.com': {
    title: 'Stack Overflow',
    theme: { bg: '#fff', fg: '#232629', accent: '#f48024' },
    body: () => `
      <div class="site-so">
        <h1>¿Cómo implemento un scheduler sin dependencias?</h1>
        <div class="site-so-votes">
          <span>▲</span><strong>142</strong><span>▼</span>
        </div>
        <p class="site-so-q">Estoy construyendo un OS simulado en JavaScript y necesito
        un scheduler round-robin con quantum configurable. ¿Alguna idea?</p>
        <h2>3 respuestas</h2>
        <div class="site-so-a">
          <p>Usa una cola de procesos y un timer con <code>requestAnimationFrame</code>.
          El quantum lo controlas con contadores.</p>
        </div>
        <div class="site-so-a">
          <p>Alternativamente, una máquina de estados con yield cooperativo.</p>
        </div>
      </div>
    `,
  },

  'download.example.com': {
    title: 'Descarga IPA',
    theme: { bg: '#1a1a1a', fg: '#fff', accent: '#30d158' },
    body: () => `
      <div class="site-dl">
        <h1>Descarga de aplicación</h1>
        <p>iOS Remastered Demo · v1.0.0</p>
        <button class="site-dl-btn" data-action="download-ipa">
          ⬇️ Descargar .ipa (2.4 MB)
        </button>
        <p class="site-dl-note">
          Este archivo se guardará en <code>/private/var/mobile/Downloads</code>
          y podrás instalarlo desde Archivos o Safari.
        </p>
      </div>
    `,
  },
};

/* ============================================================================
 * PARSER DE URL / BÚSQUEDA
 * ========================================================================== */

function looksLikeUrl(s) {
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^safari:\/\//i.test(s)) return true;
  // Contiene un punto y no contiene espacios → probablemente URL
  return /\.[a-z]{2,}/i.test(s) && !/\s/.test(s);
}

function normalizeUrl(input) {
  const s = (input || '').trim();
  if (!s) return START_PAGE;
  if (s === 'start' || s === 'inicio' || s === START_PAGE) return START_PAGE;
  if (/^safari:\/\//i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (looksLikeUrl(s)) return `https://${s}`;
  // Búsqueda
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

function parseUrl(url) {
  if (url === START_PAGE) return { host: 'Inicio', path: '', full: url, isStart: true };
  try {
    const u = new URL(url);
    return {
      protocol: u.protocol,
      host: u.hostname.replace(/^www\./, ''),
      fullHost: u.hostname,
      path: u.pathname,
      query: u.searchParams,
      hash: u.hash,
      full: url,
    };
  } catch {
    return { host: url, path: '', full: url };
  }
}

function extractQuery(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('q');
  } catch { return null; }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveSite(url) {
  const p = parseUrl(url);
  if (p.isStart) return { type: 'start', host: 'Inicio' };
  const host = p.fullHost || '';
  for (const key of Object.keys(SITES)) {
    if (host.endsWith(key)) return { type: 'site', host, site: SITES[key], siteKey: key, url };
  }
  if (host.includes('google.') && p.path.startsWith('/search')) {
    return { type: 'search', host, query: p.query.get('q') || '', url };
  }
  return { type: 'unknown', host, url };
}

/* ============================================================================
 * PERSISTENCIA
 * ========================================================================== */

async function persist(os, state) {
  try {
    if (!os?.fs) return;
    await os.fs.mkdir('/private/var/mobile/Library/Safari', { recursive: true }).catch(() => {});
    await os.fs.writeFile(SAFARI_DB, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      tabs: state.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
      activeTabIdx: state.activeTabIdx,
      bookmarks: state.bookmarks,
      history: state.history.slice(0, 200),
      privateMode: state.privateMode,
      readerMode: state.readerMode,
    }));
  } catch {}
}

async function hydrate(os) {
  try {
    if (!os?.fs) return null;
    const raw = await os.fs.readFile(SAFARI_DB);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

/* ============================================================================
 * REDUCER
 * ========================================================================== */

let _tabSeq = 0;
const newTabId = () => `tab_${Date.now().toString(36)}_${(++_tabSeq).toString(36)}`;

const initialState = {
  ready: false,
  tabs: [
    { id: newTabId(), url: START_PAGE, title: 'Inicio', loading: false, canGoBack: false, canGoForward: false, history: [START_PAGE], historyIdx: 0 },
  ],
  activeTabIdx: 0,
  bookmarks: BOOKMARKS_DEFAULT,
  history: [],
  privateMode: false,
  readerMode: false,
  showTabsOverview: false,
  downloads: [],
  readerContent: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE': {
      const merged = { ...state, ...action.state, ready: true };
      // Aseguramos al menos una pestaña
      if (!merged.tabs || !merged.tabs.length) {
        merged.tabs = initialState.tabs;
        merged.activeTabIdx = 0;
      }
      // Rehidratamos el historial interno de cada pestaña
      merged.tabs = merged.tabs.map((t) => ({
        ...t,
        loading: false,
        history: [t.url || START_PAGE],
        historyIdx: 0,
        canGoBack: false,
        canGoForward: false,
      }));
      return merged;
    }

    case 'NEW_TAB': {
      const tabs = [...state.tabs, {
        id: newTabId(),
        url: action.url || START_PAGE,
        title: action.url ? '' : 'Inicio',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        history: [action.url || START_PAGE],
        historyIdx: 0,
      }];
      return { ...state, tabs, activeTabIdx: tabs.length - 1 };
    }

    case 'CLOSE_TAB': {
      if (state.tabs.length <= 1) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      const activeTabIdx = Math.min(state.activeTabIdx, tabs.length - 1);
      return { ...state, tabs, activeTabIdx };
    }

    case 'SET_ACTIVE_TAB': {
      const idx = Math.max(0, Math.min(state.tabs.length - 1, action.idx));
      return { ...state, activeTabIdx: idx };
    }

    case 'NAVIGATE': {
      const tab = state.tabs[state.activeTabIdx];
      const newHist = [...tab.history.slice(0, tab.historyIdx + 1), action.url];
      const updated = {
        ...tab,
        url: action.url,
        title: action.title || '',
        loading: true,
        history: newHist,
        historyIdx: newHist.length - 1,
        canGoBack: newHist.length > 1,
        canGoForward: false,
      };
      const tabs = state.tabs.map((t, i) => i === state.activeTabIdx ? updated : t);
      const history = action.skipHistory ? state.history : [
        { url: action.url, title: action.title || action.url, ts: Date.now() },
        ...state.history.filter((h) => h.url !== action.url),
      ].slice(0, 200);
      return { ...state, tabs, history };
    }

    case 'NAV_DONE': {
      const tab = state.tabs[state.activeTabIdx];
      const updated = { ...tab, loading: false, title: action.title || tab.title };
      const tabs = state.tabs.map((t, i) => i === state.activeTabIdx ? updated : t);
      return { ...state, tabs };
    }

    case 'BACK': {
      const tab = state.tabs[state.activeTabIdx];
      if (tab.historyIdx <= 0) return state;
      const idx = tab.historyIdx - 1;
      const url = tab.history[idx];
      const updated = {
        ...tab, url, historyIdx: idx,
        canGoBack: idx > 0, canGoForward: idx < tab.history.length - 1,
      };
      const tabs = state.tabs.map((t, i) => i === state.activeTabIdx ? updated : t);
      return { ...state, tabs };
    }

    case 'FORWARD': {
      const tab = state.tabs[state.activeTabIdx];
      if (tab.historyIdx >= tab.history.length - 1) return state;
      const idx = tab.historyIdx + 1;
      const url = tab.history[idx];
      const updated = {
        ...tab, url, historyIdx: idx,
        canGoBack: idx > 0, canGoForward: idx < tab.history.length - 1,
      };
      const tabs = state.tabs.map((t, i) => i === state.activeTabIdx ? updated : t);
      return { ...state, tabs };
    }

    case 'RELOAD':
      return { ...state, tabs: state.tabs.map((t, i) => i === state.activeTabIdx ? { ...t, loading: true } : t) };

    case 'ADD_BOOKMARK': {
      const exists = state.bookmarks.some((b) => b.url === action.bookmark.url);
      if (exists) return state;
      return { ...state, bookmarks: [...state.bookmarks, action.bookmark] };
    }

    case 'REMOVE_BOOKMARK':
      return { ...state, bookmarks: state.bookmarks.filter((b) => b.id !== action.id) };

    case 'CLEAR_HISTORY':
      return { ...state, history: [] };

    case 'TOGGLE_PRIVATE':
      return { ...state, privateMode: !state.privateMode };

    case 'TOGGLE_READER':
      return { ...state, readerMode: !state.readerMode };

    case 'SET_READER_CONTENT':
      return { ...state, readerContent: action.content };

    case 'TOGGLE_TABS_OVERVIEW':
      return { ...state, showTabsOverview: !state.showTabsOverview, privateMode: false };

    case 'ADD_DOWNLOAD':
      return { ...state, downloads: [action.download, ...state.downloads].slice(0, 50) };

    case 'UPDATE_DOWNLOAD':
      return {
        ...state,
        downloads: state.downloads.map((d) => d.id === action.id ? { ...d, ...action.patch } : d),
      };

    default:
      return state;
  }
}

/* ============================================================================
 * HOOK PRINCIPAL
 * ========================================================================== */

function useSafari(os) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const saveRef = useRef(null);

  useEffect(() => {
    (async () => {
      const db = await hydrate(os);
      if (db) {
        dispatch({
          type: 'HYDRATE',
          state: {
            tabs: db.tabs?.length ? db.tabs : initialState.tabs,
            activeTabIdx: db.activeTabIdx || 0,
            bookmarks: db.bookmarks || BOOKMARKS_DEFAULT,
            history: db.history || [],
            privateMode: false,
            readerMode: db.readerMode || false,
          },
        });
      } else {
        dispatch({ type: 'HYDRATE', state: {} });
      }
    })();
  }, [os]);

  useEffect(() => {
    if (!state.ready) return;
    if (state.privateMode) return;
    clearTimeout(saveRef.current);
    saveRef.current = setTimeout(() => persist(os, state), 900);
    return () => clearTimeout(saveRef.current);
  }, [state, os]);

  return [state, dispatch];
}

/* ============================================================================
 * LÓGICA DE NAVEGACIÓN
 * ========================================================================== */

function useNavigate(os, dispatch) {
  return useCallback((input, { skipHistory = false } = {}) => {
    const url = normalizeUrl(input);
    const r = resolveSite(url);
    const title = r.site?.title || r.host || 'Nueva pestaña';
    dispatch({ type: 'NAVIGATE', url, title, skipHistory });
    // Simulamos latencia de carga
    setTimeout(() => {
      dispatch({ type: 'NAV_DONE', title });
    }, 300 + Math.random() * 400);
  }, [dispatch]);
}

/* ============================================================================
 * DESCARGA DE IPA
 * ========================================================================== */

function useIpaDownload(os, dispatch) {
  return useCallback(async (suggestedName = 'App.ipa', size = 2.4 * 1024 * 1024) => {
    const filename = uniqueName(suggestedName, os);
    const id = `dl_${Date.now().toString(36)}`;
    const download = {
      id, filename,
      url: `${DOWNLOADS_DIR}/${filename}`,
      size,
      progress: 0,
      status: 'downloading',
      startedAt: Date.now(),
    };
    dispatch({ type: 'ADD_DOWNLOAD', download });

    // Simulamos descarga progresiva
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await sleep(90 + Math.random() * 80);
      dispatch({
        type: 'UPDATE_DOWNLOAD',
        id,
        patch: { progress: i / steps },
      });
    }

    // Escribimos el archivo simulado en el FS
    try {
      await os.fs.mkdir(DOWNLOADS_DIR, { recursive: true }).catch(() => {});
      await os.fs.writeFile(download.url, `# Simulated IPA\n# ${filename}\n# size=${size}\n`);
    } catch { /* seguimos */ }

    dispatch({
      type: 'UPDATE_DOWNLOAD',
      id,
      patch: { status: 'done', progress: 1 },
    });

    toast.success(`Descargado: ${filename}`);

    // Preguntamos si instalar
    setTimeout(() => {
      promptInstall(os, download);
    }, 400);

    return download;
  }, [os, dispatch]);
}

function uniqueName(name, os) {
  // Evitamos colisiones simples con timestamp
  const base = name.replace(/\.ipa$/i, '');
  return `${base}-${Date.now().toString(36).slice(-4)}.ipa`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function promptInstall(os, download) {
  const ok = await alert.confirm({
    title: '¿Instalar aplicación?',
    message: `${download.filename}\n${formatBytes(download.size)}`,
    confirmText: 'Instalar',
    cancelText: 'Ahora no',
  });
  if (!ok) return;

  if (!os?.ipaInstaller) {
    toast.error('IPAInstaller no disponible');
    return;
  }

  const tid = toast.loading?.('Instalando…') ?? null;
  try {
    await os.ipaInstaller.install(download.url);
    if (tid) toast.dismiss?.(tid);
    toast.success(`${download.filename} instalada`);
    os.notificationCenter?.post?.({
      bundleId: 'com.apple.installer',
      title: 'App instalada',
      body: download.filename,
    });
  } catch (e) {
    if (tid) toast.dismiss?.(tid);
    toast.error(`Fallo al instalar: ${e.message}`);
  }
}

function formatBytes(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  const v = b / Math.pow(1024, i);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

/* ============================================================================
 * VISTA: PÁGINA DE INICIO
 * ========================================================================== */

function StartPage({ state, onNavigate, onBookmarkTap }) {
  const sections = [
    { title: 'Favoritos', items: state.bookmarks.slice(0, 6) },
    { title: 'Frecuentes', items: topFrequent(state.history, 6) },
    { title: 'Recientes', items: state.history.slice(0, 6) },
  ].filter((s) => s.items.length > 0);

  if (sections.length === 0) {
    return (
      <div className="sf-start">
        <div className="sf-start-empty">
          <Icon name="safari" size={64} color="#0a84ff" />
          <h2>Inicio</h2>
          <p>Escribe una dirección o busca en la web</p>
          <div className="sf-start-suggestions">
            {BOOKMARKS_DEFAULT.map((b) => (
              <button
                key={b.id}
                className="sf-start-chip"
                onClick={() => onNavigate(b.url)}
              >
                <Icon name="globe" size={14} color="#0a84ff" />
                <span>{b.title}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sf-start">
      <div className="sf-start-search">
        <Icon name="magnifyingglass" size={16} color="#8e8e93" />
        <input
          readOnly
          value=""
          placeholder="Buscar o introducir dirección"
          onFocus={(e) => e.target.blur()}
          onClick={() => window.dispatchEvent(new CustomEvent('sf:focusurl'))}
        />
      </div>

      {sections.map((sec) => (
        <div key={sec.title} className="sf-start-section">
          <h3 className="sf-start-title">{sec.title}</h3>
          <div className="sf-start-grid">
            {sec.items.map((item, i) => (
              <TapHandler key={item.id || item.url + i} onTap={() => onBookmarkTap(item)}>
                <div className="sf-start-card">
                  <div className="sf-start-favicon">
                    <Icon name="globe" size={22} color="#0a84ff" />
                  </div>
                  <span className="sf-start-name">{item.title || hostOf(item.url)}</span>
                  <span className="sf-start-url">{hostOf(item.url)}</span>
                </div>
              </TapHandler>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function topFrequent(history, n) {
  const counts = new Map();
  for (const h of history) {
    const host = hostOf(h.url);
    if (!host) continue;
    const cur = counts.get(host) || { host, count: 0, title: h.title, url: h.url };
    cur.count++;
    counts.set(host, cur);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, n)
    .map((x, i) => ({ id: `freq_${i}`, title: x.title || x.host, url: x.url }));
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url || ''; }
}

/* ============================================================================
 * VISTA: PÁGINA SIMULADA
 * ========================================================================== */

function SitePage({ url, onNavigate, os, onDownloadIpa, readerMode }) {
  const resolved = useMemo(() => resolveSite(url), [url]);

  const html = useMemo(() => {
    if (resolved.type === 'start') return '';
    if (resolved.type === 'site') return resolved.site.body(url);
    if (resolved.type === 'search') return searchPage(resolved.query);
    return unknownPage(resolved.host, url);
  }, [resolved, url]);

  const theme = useMemo(() => {
    if (resolved.type === 'site') return resolved.site.theme || { bg: '#fff', fg: '#000', accent: '#0a84ff' };
    return { bg: '#fff', fg: '#000', accent: '#0a84ff' };
  }, [resolved]);

  // Interceptamos clics en botones con data-action
  const handleClick = useCallback((e) => {
    const btn = e.target.closest?.('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'download-ipa') {
      onDownloadIpa('iOSRemastered-Demo.ipa', 2.4 * 1024 * 1024);
    }
  }, [onDownloadIpa]);

  if (readerMode && resolved.type === 'site') {
    return (
      <div className="sf-reader">
        <h1>{resolved.site.title}</h1>
        <div className="sf-reader-body" dangerouslySetInnerHTML={{ __html: stripHtml(html) }} />
      </div>
    );
  }

  return (
    <div
      className="sf-page"
      style={{ background: theme.bg, color: theme.fg }}
      onClick={handleClick}
    >
      <div
        className="sf-page-content"
        dangerouslySetInnerHTML={{ __html: injectBaseStyles(html, theme) }}
      />
    </div>
  );
}

function searchPage(q) {
  const results = [
    { title: `${q} — Wikipedia`, url: `https://es.wikipedia.org/wiki/${encodeURIComponent(q)}` },
    { title: `${q} — Documentación oficial`, url: `https://developer.apple.com/search?q=${encodeURIComponent(q)}` },
    { title: `Todo sobre ${q}`, url: `https://example.com/${encodeURIComponent(q)}` },
    { title: `${q} · Hacker News`, url: `https://news.ycombinator.com/search?q=${encodeURIComponent(q)}` },
    { title: `Preguntas frecuentes: ${q}`, url: `https://stackoverflow.com/search?q=${encodeURIComponent(q)}` },
  ];
  return `
    <div class="site-search">
      <div class="site-search-bar">
        <span class="site-search-logo">G</span>
        <input readonly value="${escapeHtml(q)}" />
      </div>
      <div class="site-search-stats">Cerca de 1.240.000 resultados (0,42 segundos)</div>
      <div class="site-search-results">
        ${results.map((r) => `
          <div class="site-search-result">
            <div class="site-search-url">${escapeHtml(hostOf(r.url))}</div>
            <a class="site-search-title">${escapeHtml(r.title)}</a>
            <div class="site-search-snippet">
              ${escapeHtml(q)} es un tema que aparece en múltiples contextos.
              Esta página contiene información relevante y recursos relacionados.
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function unknownPage(host, url) {
  return `
    <div class="site-unknown">
      <h1>Safari no puede abrir la página</h1>
      <p>Safari no puede abrir la página porque no encuentra el servidor <strong>${escapeHtml(host)}</strong>.</p>
      <p class="site-unknown-url">${escapeHtml(url)}</p>
      <p>Comprueba la dirección e inténtalo de nuevo.</p>
    </div>
  `;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function injectBaseStyles(html, theme) {
  const css = `
    <style>
      .sf-page-content * { box-sizing: border-box; }
      .sf-page-content { font-family: -apple-system, system-ui, sans-serif; font-size: 15px; line-height: 1.5; }
      .sf-page-content h1 { font-size: 30px; margin: 12px 0; }
      .sf-page-content h2 { font-size: 22px; margin: 16px 0 8px; }
      .sf-page-content h3 { font-size: 18px; margin: 12px 0 6px; }
      .sf-page-content p  { margin: 8px 0; }
      .sf-page-content a  { color: ${theme.accent}; cursor: pointer; text-decoration: none; }
      .sf-page-content ul { padding-left: 20px; }

      .site-nav { display: flex; align-items: center; gap: 20px; padding: 12px 24px;
        border-bottom: 1px solid rgba(255,255,255,.1); }
      .site-logo { width: 24px; height: 24px;
        background: url("data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff"><path d="M17.05 12.54c-.02-2.1 1.72-3.1 1.8-3.15-.98-1.44-2.5-1.63-3.04-1.65-1.3-.13-2.53.76-3.2.76-.66 0-1.67-.74-2.75-.72-1.42.02-2.73.82-3.46 2.09-1.48 2.56-.38 6.34 1.06 8.42.7 1.02 1.54 2.16 2.64 2.12 1.06-.04 1.46-.68 2.74-.68 1.28 0 1.64.68 2.76.66 1.14-.02 1.86-1.04 2.56-2.06.8-1.18 1.14-2.32 1.16-2.38-.03-.01-2.23-.86-2.25-3.4zM15.06 5.63c.58-.7.97-1.68.86-2.65-.83.03-1.84.55-2.44 1.25-.54.62-1 1.62-.88 2.57.93.07 1.88-.47 2.46-1.17z"/></svg>')}") no-repeat center; background-size: contain; }
      .site-nav nav { display: flex; gap: 18px; font-size: 13px; }
      .site-nav nav a { color: rgba(255,255,255,.85); }

      .site-hero { text-align: center; padding: 60px 20px; }
      .site-hero h1 { font-size: 48px; margin: 0 0 8px; font-weight: 600; letter-spacing: -2px; }
      .site-hero .sub { font-size: 20px; opacity: .8; margin: 0 0 20px; }
      .site-cta { color: #0a84ff; font-size: 18px; }

      .site-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 0 16px 24px; }
      .site-card { padding: 32px 20px; border-radius: 16px; text-align: center; }
      .site-card.dark  { background: #1d1d1f; color: #fff; }
      .site-card.light { background: #f5f5f7; color: #1d1d1f; }
      .site-card h3 { margin: 0 0 6px; }
      .site-card p { margin: 0; opacity: .75; font-size: 13px; }

      .site-appstore { padding: 20px; }
      .site-appstore-hero { display: flex; gap: 16px; align-items: center; margin-bottom: 20px; }
      .site-appstore-icon { width: 100px; height: 100px; border-radius: 22px; }
      .site-appstore-meta h2 { margin: 0 0 4px; }
      .site-appstore-meta p { margin: 0 0 12px; color: #8e8e93; font-size: 13px; }
      .site-appstore-btn { padding: 6px 20px; background: #0a84ff; color: #fff;
        border: none; border-radius: 20px; font-weight: 600; cursor: pointer; }
      .site-appstore-screens { display: flex; gap: 8px; overflow-x: auto; }
      .site-appstore-shot { flex: 0 0 auto; width: 140px; height: 250px;
        background: linear-gradient(135deg,#1c1c1e,#2c2c2e); border-radius: 12px; }
      .site-p { color: #8e8e93; font-size: 14px; }

      .site-dev { padding: 24px; }
      .site-dev h1 { font-size: 42px; margin: 0 0 20px; }
      .site-dev-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
      .site-dev-card { padding: 20px; background: #2c2c2e; border-radius: 12px; }
      .site-dev-card h3 { margin: 0 0 6px; }
      .site-dev-card p { margin: 0; color: #8e8e93; font-size: 13px; }

      .site-wiki { padding: 20px; max-width: 720px; }
      .site-wiki-title { border-bottom: 1px solid #a2a9b1; padding-bottom: 6px;
        font-family: Georgia, serif; }
      .site-wiki-lead { font-size: 16px; }

      .site-hn { padding: 12px 16px; }
      .site-hn header { display: flex; gap: 8px; align-items: center; padding-bottom: 8px;
        border-bottom: 1px solid #ff6600; margin-bottom: 8px; font-size: 13px; }
      .site-hn-logo { width: 22px; height: 22px; background: #ff6600; color: #fff;
        display: flex; align-items: center; justify-content: center; font-weight: 700; }
      .site-hn-nav { font-size: 12px; opacity: .7; }
      .site-hn ol { padding-left: 22px; margin: 8px 0; }
      .site-hn li { padding: 6px 0; font-size: 14px; }
      .site-hn-title { color: #000; }
      .site-hn-meta { font-size: 11px; color: #828282; display: block; }

      .site-gh { padding: 20px; }
      .site-gh-header h1 { margin: 0 0 8px; }
      .site-gh-desc { color: #8b949e; font-size: 14px; }
      .site-gh-meta { display: flex; gap: 16px; color: #8b949e; font-size: 12px; margin: 10px 0 16px; }
      .site-gh-files { border: 1px solid #30363d; border-radius: 6px; overflow: hidden; }
      .site-gh-file { padding: 8px 14px; border-bottom: 1px solid #30363d; font-size: 13px; }
      .site-gh-file:last-child { border-bottom: none; }

      .site-so { padding: 20px; }
      .site-so h1 { font-size: 24px; }
      .site-so-votes { display: inline-flex; flex-direction: column; align-items: center;
        margin-right: 12px; vertical-align: top; color: #babfc4; }
      .site-so-votes strong { color: #232629; margin: 4px 0; }
      .site-so-q { display: inline-block; max-width: calc(100% - 60px); }
      .site-so-a { padding: 12px; background: #f8f9f9; border-radius: 6px;
        border-left: 4px solid #f48024; margin: 8px 0; font-size: 14px; }
      .site-so code { background: #eff0f1; padding: 2px 4px; font-family: monospace; }

      .site-search { padding: 16px; }
      .site-search-bar { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
        border: 1px solid #dfe1e5; border-radius: 24px; box-shadow: 0 1px 6px rgba(0,0,0,.08); }
      .site-search-logo { font-size: 22px; font-weight: 700; color: #4285f4; }
      .site-search-bar input { flex: 1; border: none; outline: none; font-size: 16px; }
      .site-search-stats { font-size: 12px; color: #70757a; margin: 12px 0 8px; }
      .site-search-results { display: flex; flex-direction: column; gap: 20px; }
      .site-search-url { font-size: 12px; color: #0d652d; }
      .site-search-title { font-size: 18px; color: #1a0dab; display: block; margin: 2px 0; }
      .site-search-snippet { font-size: 13px; color: #4d5156; line-height: 1.5; }

      .site-unknown { padding: 40px 20px; text-align: center; }
      .site-unknown h1 { font-size: 22px; }
      .site-unknown-url { font-family: monospace; background: #f5f5f7; color: #333;
        padding: 8px; border-radius: 6px; font-size: 12px; word-break: break-all; }

      .site-dl { padding: 40px 20px; text-align: center; }
      .site-dl h1 { font-size: 26px; margin: 0 0 8px; }
      .site-dl-btn { margin: 20px 0; padding: 14px 28px; background: #30d158; color: #000;
        border: none; border-radius: 12px; font-size: 16px; font-weight: 700;
        cursor: pointer; }
      .site-dl-note { font-size: 12px; color: #8e8e93; max-width: 340px; margin: 20px auto 0; }
      .site-dl-note code { background: rgba(255,255,255,.1); padding: 2px 6px; border-radius: 4px; }
    </style>
  `;
  return css + html;
}

/* ============================================================================
 * COMPONENTES UI
 * ========================================================================== */

function BrowserChrome({ state, dispatch, tab, onNavigate, onBack, onForward, onReload, urlFocused, setUrlFocused, urlInput, setUrlInput }) {
  const parsed = parseUrl(tab.url);
  const displayUrl = tab.url === START_PAGE ? '' : (parsed.fullHost || parsed.host || tab.url);

  const commit = () => {
    setUrlFocused(false);
    onNavigate(urlInput);
    setUrlInput('');
  };

  return (
    <div className="sf-chrome">
      <div className="sf-chrome-row">
        <button
          className="sf-iconbtn"
          disabled={!tab.canGoBack}
          onClick={onBack}
        >
          <Icon name="chevron.left" size={20} color={tab.canGoBack ? '#0a84ff' : '#48484a'} />
        </button>
        <button
          className="sf-iconbtn"
          disabled={!tab.canGoForward}
          onClick={onForward}
        >
          <Icon name="chevron.right" size={20} color={tab.canGoForward ? '#0a84ff' : '#48484a'} />
        </button>

        <div className={`sf-urlbar ${state.privateMode ? 'is-private' : ''}`}>
          {state.privateMode ? (
            <Icon name="eye.slash" size={14} color="#bf5af2" />
          ) : tab.url.startsWith('https://') ? (
            <Icon name="lock.fill" size={12} color="#8e8e93" />
          ) : (
            <Icon name="globe" size={14} color="#8e8e93" />
          )}
          <input
            className="sf-urlbar-input"
            value={urlFocused ? urlInput : displayUrl}
            placeholder="Buscar o introducir dirección"
            onFocus={() => { setUrlFocused(true); setUrlInput(tab.url === START_PAGE ? '' : tab.url); }}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
            onBlur={() => setTimeout(() => setUrlFocused(false), 150)}
          />
          {urlFocused ? (
            <button className="sf-iconbtn" onMouseDown={(e) => { e.preventDefault(); setUrlInput(''); }}>
              <Icon name="xmark.circle.fill" size={16} color="#8e8e93" />
            </button>
          ) : (
            <button className="sf-iconbtn" onClick={onReload}>
              <Icon name={tab.loading ? 'xmark' : 'arrow.clockwise'} size={16} color="#0a84ff" />
            </button>
          )}
        </div>

        <button className="sf-iconbtn" onClick={() => dispatch({ type: 'TOGGLE_READER' })}>
          <Icon name="text.alignleft" size={18} color={state.readerMode ? '#0a84ff' : '#8e8e93'} />
        </button>
      </div>

      {tab.loading && <div className="sf-progress"><div className="sf-progress-fill" /></div>}
    </div>
  );
}

function BottomBar({ state, dispatch, onNavigate, onShare, onBookmark, onDownloads }) {
  const tab = state.tabs[state.activeTabIdx];
  const parsed = parseUrl(tab.url);
  const isBookmarked = state.bookmarks.some((b) => b.url === tab.url);

  return (
    <div className="sf-bottom">
      <button className="sf-iconbtn" onClick={() => dispatch({ type: 'BACK' })} disabled={!tab.canGoBack}>
        <Icon name="chevron.left" size={20} color={tab.canGoBack ? '#0a84ff' : '#48484a'} />
      </button>
      <button className="sf-iconbtn" onClick={() => dispatch({ type: 'FORWARD' })} disabled={!tab.canGoForward}>
        <Icon name="chevron.right" size={20} color={tab.canGoForward ? '#0a84ff' : '#48484a'} />
      </button>
      <button className="sf-iconbtn" onClick={onShare}>
        <Icon name="square.and.arrow.up" size={20} color="#0a84ff" />
      </button>
      <button className="sf-iconbtn" onClick={onBookmark}>
        <Icon name={isBookmarked ? 'book.fill' : 'book'} size={20} color="#0a84ff" />
      </button>
      <button className="sf-iconbtn" onClick={onDownloads} style={{ position: 'relative' }}>
        <Icon name="arrow.down.circle" size={20} color="#0a84ff" />
        {state.downloads.some((d) => d.status === 'downloading') && (
          <span className="sf-badge-dot" />
        )}
      </button>
      <button className="sf-iconbtn" onClick={() => dispatch({ type: 'TOGGLE_TABS_OVERVIEW' })}>
        <Icon name="square.on.square" size={20} color="#0a84ff" />
      </button>
    </div>
  );
}

function TabsOverview({ state, dispatch, onNewTab, onClose }) {
  return (
    <div className="sf-tabs-overview">
      <div className="sf-tabs-head">
        <button className="sf-iconbtn" onClick={onClose}>
          <span>Listo</span>
        </button>
        <span>{state.tabs.length} pestaña{state.tabs.length !== 1 ? 's' : ''}</span>
        <button className="sf-iconbtn" onClick={onNewTab}>
          <Icon name="plus" size={20} color="#0a84ff" />
        </button>
      </div>
      <div className="sf-tabs-grid">
        {state.tabs.map((t, i) => {
          const host = hostOf(t.url);
          return (
            <TapHandler
              key={t.id}
              onTap={() => {
                dispatch({ type: 'SET_ACTIVE_TAB', idx: i });
                onClose();
              }}
            >
              <div className={`sf-tab-card ${i === state.activeTabIdx ? 'is-active' : ''}`}>
                <div className="sf-tab-header">
                  <span className="sf-tab-host">{host || 'Inicio'}</span>
                  <button
                    className="sf-tab-close"
                    onClick={(e) => { e.stopPropagation(); dispatch({ type: 'CLOSE_TAB', id: t.id }); }}
                  >
                    <Icon name="xmark" size={12} color="#fff" />
                  </button>
                </div>
                <div className="sf-tab-preview">
                  <Icon name="globe" size={32} color="rgba(255,255,255,.3)" />
                </div>
              </div>
            </TapHandler>
          );
        })}
        <button className="sf-tab-new" onClick={onNewTab}>
          <Icon name="plus" size={26} color="#0a84ff" />
          <span>Nueva pestaña</span>
        </button>
      </div>
    </div>
  );
}

function ShareSheet({ url, onClose, onAddBookmark, isBookmarked, onCopyLink }) {
  return (
    <div className="sf-sheet">
      <div className="sf-sheet-backdrop" onClick={onClose} />
      <div className="sf-sheet-panel">
        <div className="sf-sheet-header">
          <span className="sf-sheet-url">{shortHost(url)}</span>
          <button className="sf-iconbtn" onClick={onClose}>Cerrar</button>
        </div>
        <div className="sf-sheet-actions">
          <button className="sf-sheet-action" onClick={onCopyLink}>
            <Icon name="doc.on.doc" size={26} color="#0a84ff" />
            <span>Copiar</span>
          </button>
          <button className="sf-sheet-action" onClick={onAddBookmark}>
            <Icon name={isBookmarked ? 'book.fill' : 'book'} size={26} color="#0a84ff" />
            <span>{isBookmarked ? 'En Favoritos' : 'Añadir favorito'}</span>
          </button>
          <button className="sf-sheet-action">
            <Icon name="square.and.arrow.up" size={26} color="#0a84ff" />
            <span>Compartir</span>
          </button>
          <button className="sf-sheet-action">
            <Icon name="plus.square.on.square" size={26} color="#0a84ff" />
            <span>Añadir a inicio</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function DownloadsSheet({ state, onClose, onOpenDownloads }) {
  return (
    <div className="sf-sheet">
      <div className="sf-sheet-backdrop" onClick={onClose} />
      <div className="sf-sheet-panel">
        <div className="sf-sheet-header">
          <span>Descargas</span>
          <button className="sf-iconbtn" onClick={onClose}>Cerrar</button>
        </div>
        <div className="sf-downloads">
          {state.downloads.length === 0 ? (
            <div className="sf-dl-empty">Sin descargas</div>
          ) : (
            state.downloads.map((d) => (
              <div key={d.id} className="sf-dl-row">
                <Icon name="shippingbox" size={26} color="#0a84ff" />
                <div className="sf-dl-meta">
                  <span className="sf-dl-name">{d.filename}</span>
                  <span className="sf-dl-sub">
                    {d.status === 'downloading' ? `${Math.round(d.progress * 100)}%` : formatBytes(d.size)}
                  </span>
                </div>
                {d.status === 'downloading' ? (
                  <div className="sf-dl-progress"><div style={{ width: `${d.progress * 100}%` }} /></div>
                ) : (
                  <Icon name="checkmark.circle.fill" size={20} color="#30d158" />
                )}
              </div>
            ))
          )}
        </div>
        <button className="sf-sheet-footer" onClick={onOpenDownloads}>
          Abrir carpeta Descargas
        </button>
      </div>
    </div>
  );
}

function shortHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

/* ============================================================================
 * COMPONENTE PRINCIPAL
 * ========================================================================== */

export default function SafariApp({ appWindowId, instanceId }) {
  const os = useOS();
  const [state, dispatch] = useSafari(os);
  const navigate = useNavigate(os, dispatch);
  const downloadIpa = useIpaDownload(os, dispatch);

  const [urlFocused, setUrlFocused] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);

  const tab = state.tabs[state.activeTabIdx];

  // Escuchar focus programático desde la StartPage
  useEffect(() => {
    const handler = () => setUrlFocused(true);
    window.addEventListener('sf:focusurl', handler);
    return () => window.removeEventListener('sf:focusurl', handler);
  }, []);

  // Atajo: Cmd/Ctrl + T para nueva pestaña
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 't') {
        e.preventDefault();
        dispatch({ type: 'NEW_TAB' });
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault();
        dispatch({ type: 'CLOSE_TAB', id: tab.id });
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
        e.preventDefault();
        setUrlFocused(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab.id, dispatch]);

  const handleBack = useCallback(() => dispatch({ type: 'BACK' }), [dispatch]);
  const handleForward = useCallback(() => dispatch({ type: 'FORWARD' }), [dispatch]);
  const handleReload = useCallback(() => {
    if (tab.loading) return;
    dispatch({ type: 'RELOAD' });
    setTimeout(() => dispatch({ type: 'NAV_DONE', title: tab.title }), 300);
  }, [tab.loading, tab.title, dispatch]);

  const handleAddBookmark = useCallback(() => {
    const isBookmarked = state.bookmarks.some((b) => b.url === tab.url);
    if (isBookmarked) {
      const bm = state.bookmarks.find((b) => b.url === tab.url);
      dispatch({ type: 'REMOVE_BOOKMARK', id: bm.id });
      toast.info('Eliminado de Favoritos');
    } else {
      dispatch({
        type: 'ADD_BOOKMARK',
        bookmark: { id: `bm_${Date.now().toString(36)}`, title: tab.title || shortHost(tab.url), url: tab.url },
      });
      toast.success('Añadido a Favoritos');
    }
    setShowShare(false);
  }, [state.bookmarks, tab.url, tab.title, dispatch]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(tab.url);
      toast.success('Enlace copiado');
    } catch {
      toast.info(`Enlace: ${tab.url}`);
    }
    setShowShare(false);
  }, [tab.url]);

  const handleNewTab = useCallback(() => {
    dispatch({ type: 'NEW_TAB' });
  }, [dispatch]);

  if (!state.ready) {
    return (
      <div className="sf-root sf-loading">
        <div className="sf-spinner" />
      </div>
    );
  }

  return (
    <div className={`sf-root ${state.privateMode ? 'is-private' : ''}`}>
      {state.showTabsOverview ? (
        <TabsOverview
          state={state}
          dispatch={dispatch}
          onNewTab={() => { handleNewTab(); }}
          onClose={() => dispatch({ type: 'TOGGLE_TABS_OVERVIEW' })}
        />
      ) : (
        <>
          <BrowserChrome
            state={state}
            dispatch={dispatch}
            tab={tab}
            onNavigate={navigate}
            onBack={handleBack}
            onForward={handleForward}
            onReload={handleReload}
            urlFocused={urlFocused}
            setUrlFocused={setUrlFocused}
            urlInput={urlInput}
            setUrlInput={setUrlInput}
          />

          <div className="sf-content">
            {tab.url === START_PAGE ? (
              <StartPage
                state={state}
                onNavigate={navigate}
                onBookmarkTap={(item) => navigate(item.url)}
              />
            ) : (
              <SitePage
                url={tab.url}
                onNavigate={navigate}
                os={os}
                readerMode={state.readerMode}
                onDownloadIpa={(name, size) => downloadIpa(name, size)}
              />
            )}
          </div>

          <BottomBar
            state={state}
            dispatch={dispatch}
            onNavigate={navigate}
            onShare={() => setShowShare(true)}
            onBookmark={handleAddBookmark}
            onDownloads={() => setShowDownloads(true)}
          />
        </>
      )}

      {showShare && (
        <ShareSheet
          url={tab.url}
          onClose={() => setShowShare(false)}
          onAddBookmark={handleAddBookmark}
          isBookmarked={state.bookmarks.some((b) => b.url === tab.url)}
          onCopyLink={handleCopyLink}
        />
      )}

      {showDownloads && (
        <DownloadsSheet
          state={state}
          onClose={() => setShowDownloads(false)}
          onOpenDownloads={() => {
            setShowDownloads(false);
            // El usuario puede ir a Archivos manualmente
            toast.info('Descargas están en Archivos → Descargas');
          }}
        />
      )}
    </div>
  );
}

/* ============================================================================
 * ESTILOS
 * ========================================================================== */

if (typeof document !== 'undefined' && !document.getElementById('sf-styles')) {
  const s = document.createElement('style');
  s.id = 'sf-styles';
  s.textContent = `
  .sf-root { display:flex; flex-direction:column; height:100%; background:#000; color:#fff;
    font-family:-apple-system, system-ui, sans-serif; -webkit-user-select:none; user-select:none; }
  .sf-root.is-private { background:#1c1c1e; }
  .sf-loading { align-items:center; justify-content:center; }
  .sf-spinner { width:32px; height:32px; border-radius:50%;
    border:3px solid rgba(255,255,255,.15); border-top-color:#0a84ff;
    animation:sf-spin .8s linear infinite; }
  @keyframes sf-spin { to { transform:rotate(360deg); } }

  .sf-chrome { background:#1c1c1e; border-bottom:.5px solid rgba(255,255,255,.08); position:relative; }
  .sf-root.is-private .sf-chrome { background:#2c2c2e; }
  .sf-chrome-row { display:flex; align-items:center; gap:6px; padding:8px; }
  .sf-iconbtn { background:none; border:none; padding:6px; cursor:pointer;
    display:inline-flex; align-items:center; justify-content:center; color:#0a84ff; font-size:14px; }
  .sf-iconbtn:disabled { cursor:default; }

  .sf-urlbar { flex:1; display:flex; align-items:center; gap:6px; padding:8px 12px;
    background:#2c2c2e; border-radius:10px; }
  .sf-root.is-private .sf-urlbar { background:#3a3a3c; }
  .sf-urlbar.is-private { box-shadow:inset 0 0 0 1px rgba(191,90,242,.4); }
  .sf-urlbar-input { flex:1; background:none; border:none; outline:none; color:#fff;
    font-size:14px; text-align:center; }
  .sf-urlbar-input:focus { text-align:left; }

  .sf-progress { height:2px; background:rgba(10,132,255,.2); overflow:hidden; }
  .sf-progress-fill { height:100%; width:40%; background:#0a84ff;
    animation:sf-progress 1.2s ease-in-out infinite; }
  @keyframes sf-progress {
    0%   { transform:translateX(-100%); }
    100% { transform:translateX(300%); }
  }

  .sf-content { flex:1; overflow:hidden; background:#fff; color:#000;
    position:relative; }
  .sf-root.is-private .sf-content { background:#1c1c1e; color:#fff; }

  .sf-page { height:100%; overflow-y:auto; -webkit-overflow-scrolling:touch; }

  .sf-reader { padding:24px; max-width:640px; margin:0 auto; }
  .sf-reader h1 { font-size:28px; margin:0 0 16px; }
  .sf-reader-body { font-size:17px; line-height:1.6; }

  .sf-bottom { display:flex; justify-content:space-around; align-items:center;
    padding:8px 12px; background:#1c1c1e; border-top:.5px solid rgba(255,255,255,.08); }
  .sf-root.is-private .sf-bottom { background:#2c2c2e; }
  .sf-badge-dot { position:absolute; top:4px; right:4px; width:6px; height:6px;
    border-radius:50%; background:#0a84ff; }

  /* Start Page */
  .sf-start { padding:20px; height:100%; overflow-y:auto;
    background:#1c1c1e; color:#fff; }
  .sf-start-empty { display:flex; flex-direction:column; align-items:center;
    justify-content:center; height:80%; text-align:center; color:#8e8e93; }
  .sf-start-empty h2 { margin:14px 0 4px; color:#fff; }
  .sf-start-empty p { margin:0; font-size:14px; }
  .sf-start-suggestions { display:flex; flex-wrap:wrap; gap:8px;
    justify-content:center; margin-top:22px; max-width:340px; }
  .sf-start-chip { display:inline-flex; align-items:center; gap:6px; padding:8px 14px;
    background:#2c2c2e; border:none; border-radius:18px; color:#fff; font-size:13px;
    cursor:pointer; }
  .sf-start-search { display:flex; align-items:center; gap:8px; padding:10px 14px;
    background:#2c2c2e; border-radius:12px; margin-bottom:20px; }
  .sf-start-search input { flex:1; background:none; border:none; outline:none;
    color:#fff; font-size:15px; cursor:pointer; }
  .sf-start-section { margin-bottom:22px; }
  .sf-start-title { font-size:15px; font-weight:600; margin:0 0 10px; }
  .sf-start-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; }
  .sf-start-card { display:flex; flex-direction:column; align-items:center;
    gap:6px; padding:8px; border-radius:10px; cursor:pointer; }
  .sf-start-card:active { background:rgba(255,255,255,.05); }
  .sf-start-favicon { width:52px; height:52px; border-radius:12px;
    background:#2c2c2e; display:flex; align-items:center; justify-content:center; }
  .sf-start-name { font-size:11px; text-align:center; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
  .sf-start-url { font-size:10px; color:#8e8e93; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; max-width:100%; }

  /* Tabs Overview */
  .sf-tabs-overview { flex:1; display:flex; flex-direction:column; background:#000; }
  .sf-tabs-head { display:flex; align-items:center; justify-content:space-between;
    padding:14px 16px; border-bottom:.5px solid rgba(255,255,255,.08); }
  .sf-tabs-head span { font-size:15px; font-weight:600; }
  .sf-tabs-grid { flex:1; overflow-y:auto; padding:16px;
    display:grid; grid-template-columns:repeat(2, 1fr); gap:14px; align-content:start; }
  .sf-tab-card { background:#1c1c1e; border-radius:12px; overflow:hidden;
    box-shadow:0 4px 12px rgba(0,0,0,.4); cursor:pointer; height:180px;
    display:flex; flex-direction:column; }
  .sf-tab-card.is-active { outline:2px solid #0a84ff; outline-offset:2px; }
  .sf-tab-header { display:flex; align-items:center; justify-content:space-between;
    padding:6px 10px; background:#2c2c2e; }
  .sf-tab-host { font-size:11px; color:#fff; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap; max-width:120px; }
  .sf-tab-close { background:rgba(255,255,255,.1); border:none;
    width:20px; height:20px; border-radius:50%; cursor:pointer;
    display:flex; align-items:center; justify-content:center; }
  .sf-tab-preview { flex:1; display:flex; align-items:center; justify-content:center;
    background:linear-gradient(180deg,#1c1c1e,#0d0d0d); }
  .sf-tab-new { display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:8px; height:180px; background:#1c1c1e;
    border:1px dashed rgba(10,132,255,.4); border-radius:12px; cursor:pointer;
    color:#0a84ff; font-size:12px; }

  /* Sheets */
  .sf-sheet { position:absolute; inset:0; z-index:60; }
  .sf-sheet-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.55);
    backdrop-filter:blur(8px); }
  .sf-sheet-panel { position:absolute; bottom:0; left:0; right:0;
    background:#1c1c1e; border-top-left-radius:18px; border-top-right-radius:18px;
    overflow:hidden; animation:sf-up .25s cubic-bezier(.25,.85,.3,1); }
  @keyframes sf-up { from { transform:translateY(100%); } to { transform:translateY(0); } }
  .sf-sheet-header { display:flex; justify-content:space-between; align-items:center;
    padding:14px 16px; border-bottom:.5px solid rgba(255,255,255,.08); }
  .sf-sheet-url { font-size:13px; color:#8e8e93;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%; }

  .sf-sheet-actions { display:grid; grid-template-columns:repeat(4, 1fr);
    gap:4px; padding:16px; }
  .sf-sheet-action { display:flex; flex-direction:column; align-items:center;
    gap:8px; padding:12px 4px; background:none; border:none; color:#0a84ff;
    font-size:11px; cursor:pointer; border-radius:10px; }
  .sf-sheet-action:hover { background:rgba(255,255,255,.04); }

  .sf-downloads { padding:8px 0 8px; max-height:340px; overflow-y:auto; }
  .sf-dl-empty { padding:40px 20px; text-align:center; color:#8e8e93;
    font-size:14px; }
  .sf-dl-row { display:flex; align-items:center; gap:12px; padding:12px 16px;
    border-bottom:.5px solid rgba(255,255,255,.06); position:relative; }
  .sf-dl-meta { flex:1; display:flex; flex-direction:column; gap:2px; }
  .sf-dl-name { font-size:14px; }
  .sf-dl-sub { font-size:11px; color:#8e8e93; }
  .sf-dl-progress { width:60px; height:4px; background:rgba(255,255,255,.15);
    border-radius:2px; overflow:hidden; }
  .sf-dl-progress > div { height:100%; background:#0a84ff; border-radius:2px;
    transition:width .2s; }
  .sf-sheet-footer { width:100%; padding:14px; background:none; border:none;
    border-top:.5px solid rgba(255,255,255,.08); color:#0a84ff; font-size:15px;
    cursor:pointer; }
  `;
  document.head.appendChild(s);
}

export {
  SafariApp,
  normalizeUrl, parseUrl, resolveSite,
  SITES, BOOKMARKS_DEFAULT,
  formatBytes,
};
