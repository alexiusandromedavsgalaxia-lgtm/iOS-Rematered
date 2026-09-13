// src/ui/Icon.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — Icon
//
// Sistema de iconos unificado estilo SF Symbols. En vez de importar SVG sueltos
// por todo el código, se centraliza aquí una biblioteca de ~90 iconos con una
// API consistente:
//
//   <Icon name="wifi" size={20} color="#fff" weight={2} filled />
//
// Categorías:
//   • Sistema: wifi, bluetooth, cellular, battery, airplane, location
//   • Media: play, pause, next, prev, volume, mute, speaker
//   • UI: chevron-*, arrow-*, close, check, plus, minus, search
//   • Apps: phone, messages, mail, safari, camera, photos, music, notes…
//   • Dispositivo: lock, unlock, faceid, touchid, flashlight, timer
//   • Comunicación: reply, share, heart, bookmark, flag, trash
//   • Info: info, warning, error, success, question
//
// Todos los paths son trazos (stroke) por defecto; `filled` alterna a relleno.
// Sin librerías externas.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Biblioteca de iconos
// Cada entrada es { paths: [...], viewBox?: '0 0 24 24', filled?: boolean }
// Los paths se renderizan con stroke por defecto salvo que `filled` sea true.
// ─────────────────────────────────────────────────────────────────────────────

const ICONS = {
  // ── Sistema / Conectividad ────────────────────────────────────────────────
  wifi: {
    paths: [
      'M3 9 a13 13 0 0 1 18 0',
      'M6 12.5 a9 9 0 0 1 12 0',
      'M9 16 a5 5 0 0 1 6 0',
      { d: 'M12 19 m-1.6 0 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0', filled: true },
    ],
  },
  'wifi-off': {
    paths: [
      'M3 9 a13 13 0 0 1 18 0',
      'M6 12.5 a9 9 0 0 1 12 0',
      'M9 16 a5 5 0 0 1 6 0',
      { d: 'M12 19 m-1.6 0 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0', filled: true },
      'M3 3 L21 21',
    ],
  },
  bluetooth: {
    paths: ['M7 7 L17 17 L12 21 V3 L17 7 L7 17'],
  },
  cellular: {
    paths: [
      { d: 'M4 18 h2 v3 h-2 z', filled: true },
      { d: 'M9 14 h2 v7 h-2 z', filled: true },
      { d: 'M14 10 h2 v11 h-2 z', filled: true },
      { d: 'M19 6 h2 v15 h-2 z', filled: true },
    ],
  },
  'cellular-off': {
    paths: [
      { d: 'M4 18 h2 v3 h-2 z', filled: true, opacity: 0.35 },
      { d: 'M9 14 h2 v7 h-2 z', filled: true, opacity: 0.35 },
      { d: 'M14 10 h2 v11 h-2 z', filled: true, opacity: 0.35 },
      { d: 'M19 6 h2 v15 h-2 z', filled: true, opacity: 0.35 },
      'M3 3 L21 21',
    ],
  },
  airplane: {
    paths: ['M12 2 L13 9 L21 13 V15 L13 13 L13 19 L16 21 V22 L12 21 L8 22 V21 L11 19 L11 13 L3 15 V13 L11 9 Z'],
  },
  location: {
    paths: ['M12 2 L4 20 L12 16 L20 20 Z'],
  },
  'location-fill': {
    paths: [{ d: 'M12 2 L4 20 L12 16 L20 20 Z', filled: true }],
  },
  'location-off': {
    paths: [
      'M12 2 L4 20 L12 16 L20 20 Z',
      'M3 3 L21 21',
    ],
  },
  hotspot: {
    paths: [
      { d: 'M12 12 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0', filled: true },
      'M8 8 a6 6 0 0 0 0 8',
      'M16 8 a6 6 0 0 1 0 8',
      'M5 5 a10 10 0 0 0 0 14',
      'M19 5 a10 10 0 0 1 0 14',
    ],
  },
  vpn: {
    paths: [{ d: 'M12 2 L20 5 V12 C20 17 16 21 12 22 C8 21 4 17 4 12 V5 Z', filled: true }],
  },

  // ── Batería ───────────────────────────────────────────────────────────────
  battery: {
    paths: [
      { d: 'M3 8 h16 v8 h-16 z', filled: false },
      'M19 11 v2',
    ],
    viewBox: '0 0 24 24',
  },
  'battery-full': {
    paths: [
      { d: 'M3 8 h16 v8 h-16 z', filled: false },
      { d: 'M4 9 h14 v6 h-14 z', filled: true },
      'M19 11 v2',
    ],
  },
  'battery-charging': {
    paths: [
      { d: 'M3 8 h16 v8 h-16 z', filled: false },
      { d: 'M11 9 L9 12 h2.5 l-1.5 3 4 -4 h-2.5 l1.5 -2 z', filled: true },
      'M19 11 v2',
    ],
  },

  // ── Media / Audio ─────────────────────────────────────────────────────────
  play: {
    paths: [{ d: 'M7 5 L19 12 L7 19 Z', filled: true }],
  },
  pause: {
    paths: [
      { d: 'M6 5 h4 v14 h-4 z', filled: true },
      { d: 'M14 5 h4 v14 h-4 z', filled: true },
    ],
  },
  stop: {
    paths: [{ d: 'M6 6 h12 v12 h-12 z', filled: true }],
  },
  next: {
    paths: [
      { d: 'M6 5 L16 12 L6 19 Z', filled: true },
      { d: 'M17 5 h2 v14 h-2 z', filled: true },
    ],
  },
  prev: {
    paths: [
      { d: 'M18 5 L8 12 L18 19 Z', filled: true },
      { d: 'M5 5 h2 v14 h-2 z', filled: true },
    ],
  },
  volume: {
    paths: [
      { d: 'M4 9 h4 l4 -4 v14 l-4 -4 h-4 z', filled: true },
      'M15 8 a5 5 0 0 1 0 8',
      'M18 5 a9 9 0 0 1 0 14',
    ],
  },
  'volume-low': {
    paths: [
      { d: 'M4 9 h4 l4 -4 v14 l-4 -4 h-4 z', filled: true },
      'M15 8 a5 5 0 0 1 0 8',
    ],
  },
  mute: {
    paths: [
      { d: 'M4 9 h4 l4 -4 v14 l-4 -4 h-4 z', filled: true },
      'M16 9 L21 14',
      'M21 9 L16 14',
    ],
  },
  speaker: {
    paths: [
      { d: 'M4 9 h4 l4 -4 v14 l-4 -4 h-4 z', filled: true },
      'M15 8 a5 5 0 0 1 0 8',
      'M18 5 a9 9 0 0 1 0 14',
    ],
  },
  shuffle: {
    paths: [
      'M3 7 h4 l3 5 l3 -5 h4',
      'M3 17 h4 l3 -5 l3 5 h4',
      'M17 4 l4 3 l-4 3',
      'M17 14 l4 3 l-4 3',
    ],
  },
  repeat: {
    paths: [
      'M17 2 l4 4 l-4 4',
      'M3 11 v-3 a2 2 0 0 1 2 -2 h16',
      'M7 22 l-4 -4 l4 -4',
      'M21 13 v3 a2 2 0 0 1 -2 2 h-16',
    ],
  },

  // ── UI: Chevrons y arrows ─────────────────────────────────────────────────
  'chevron-up':    { paths: ['M6 15 L12 9 L18 15'] },
  'chevron-down':  { paths: ['M6 9 L12 15 L18 9'] },
  'chevron-left':  { paths: ['M15 6 L9 12 L15 18'] },
  'chevron-right': { paths: ['M9 6 L15 12 L9 18'] },
  'chevron-up-down': { paths: ['M8 10 L12 6 L16 10', 'M8 14 L12 18 L16 14'] },
  'arrow-up':    { paths: ['M12 19 V5', 'M5 12 L12 5 L19 12'] },
  'arrow-down':  { paths: ['M12 5 V19', 'M5 12 L12 19 L19 12'] },
  'arrow-left':  { paths: ['M19 12 H5', 'M12 5 L5 12 L12 19'] },
  'arrow-right': { paths: ['M5 12 H19', 'M12 5 L19 12 L12 19'] },
  'arrow-up-right': { paths: ['M7 17 L17 7', 'M8 7 H17 V16'] },
  'arrow-down-left': { paths: ['M17 7 L7 17', 'M16 17 H7 V8'] },

  // ── UI: básicos ───────────────────────────────────────────────────────────
  close:  { paths: ['M6 6 L18 18', 'M18 6 L6 18'] },
  check:  { paths: ['M4 12 L9 17 L20 6'] },
  plus:   { paths: ['M12 5 V19', 'M5 12 H19'] },
  minus:  { paths: ['M5 12 H19'] },
  search: {
    paths: [
      { d: 'M11 11 m-7 0 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0', filled: false },
      'M16 16 L21 21',
    ],
  },
  menu:     { paths: ['M4 7 H20', 'M4 12 H20', 'M4 17 H20'] },
  'more-h': { paths: [
    { d: 'M6 12 m-1.6 0 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0', filled: true },
    { d: 'M12 12 m-1.6 0 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0', filled: true },
    { d: 'M18 12 m-1.6 0 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0', filled: true },
  ]},
  'more-v': { paths: [
    { d: 'M12 6 m-1.6 0 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0', filled: true },
    { d: 'M12 12 m-1.6 0 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0', filled: true },
    { d: 'M12 18 m-1.6 0 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0', filled: true },
  ]},

  // ── Apps del sistema ──────────────────────────────────────────────────────
  phone: {
    paths: ['M5 4 h4 l2 5 -2.5 1.5 a12 12 0 0 0 5 5 L15 13 l5 2 v4 a2 2 0 0 1 -2 2 A16 16 0 0 1 3 6 a2 2 0 0 1 2 -2 z'],
  },
  messages: {
    paths: [
      'M4 5 h16 a2 2 0 0 1 2 2 v9 a2 2 0 0 1 -2 2 h-9 l-5 4 v-4 h-2 a2 2 0 0 1 -2 -2 v-9 a2 2 0 0 1 2 -2 z',
    ],
  },
  mail: {
    paths: [
      'M3 6 h18 v12 h-18 z',
      'M3 7 L12 13 L21 7',
    ],
  },
  safari: {
    paths: [
      { d: 'M12 12 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0', filled: false },
      'M16 8 L14 14 L8 16 L10 10 Z',
    ],
  },
  camera: {
    paths: [
      'M3 7 h18 v13 h-18 z',
      { d: 'M12 13.5 m-3.4 0 a3.4 3.4 0 1 0 6.8 0 a3.4 3.4 0 1 0 -6.8 0', filled: false },
      'M8 7 v-2 h4 v2',
    ],
  },
  photos: {
    paths: [
      'M3 5 h18 v14 h-18 z',
      'M3 16 L9 10 L13 14 L17 10 L21 14',
      { d: 'M16 8 m-1.5 0 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0', filled: true },
    ],
  },
  music: {
    paths: [
      'M9 18 V6 L20 4 V16',
      { d: 'M9 18 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0', filled: false },
      { d: 'M20 16 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0', filled: false },
    ],
  },
  notes: {
    paths: [
      'M5 3 h14 a2 2 0 0 1 2 2 v14 a2 2 0 0 1 -2 2 h-14 a2 2 0 0 1 -2 -2 v-14 a2 2 0 0 1 2 -2 z',
      'M7 8 h10',
      'M7 12 h10',
      'M7 16 h6',
    ],
  },
  clock: {
    paths: [
      { d: 'M12 12 m-9 0 a9 9 0 1 0 18 0 a9 9 0 1 0 -18 0', filled: false },
      'M12 7 v5 l3 2',
    ],
  },
  calculator: {
    paths: [
      'M6 3 h12 v18 h-12 z',
      'M7 5 h10 v3 h-10 z',
      { d: 'M9 12 h.01', filled: true },
      { d: 'M12 12 h.01', filled: true },
      { d: 'M15 12 h.01', filled: true },
      { d: 'M9 16 h.01', filled: true },
      { d: 'M12 16 h.01', filled: true },
      { d: 'M15 16 h.01', filled: true },
    ],
  },
  settings: {
    paths: [
      { d: 'M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0', filled: false },
      'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    ],
  },
  terminal: {
    paths: [
      'M4 4 h16 v16 h-16 z',
      'M7 10 L10 13 L7 16',
      'M12 16 h5',
    ],
  },
  compass: {
    paths: [
      { d: 'M12 12 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0', filled: false },
      'M15 9 L9 15 L13 15 L15 9 Z',
    ],
  },
  weather: {
    paths: [
      { d: 'M12 12 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0', filled: false },
      'M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3',
      'M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5',
    ],
  },
  maps: {
    paths: [
      'M3 6 L9 3 L15 6 L21 3 V18 L15 21 L9 18 L3 21 Z',
      'M9 3 V18',
      'M15 6 V21',
    ],
  },
  reminders: {
    paths: [
      'M6 4 h12 v16 h-12 z',
      'M9 8 h6',
      'M9 12 h6',
      'M9 16 h4',
    ],
  },
  'app-store': {
    paths: [
      'M12 2 v20',
      'M2 12 h20',
      'M6 6 L18 18',
      'M6 18 L18 6',
    ],
  },
  files: {
    paths: [
      'M3 6 h6 l2 2 h10 v11 h-18 z',
    ],
  },
  health: {
    paths: [
      'M12 21 C8 17 3 13 3 8.5 A4.5 4.5 0 0 1 12 6 A4.5 4.5 0 0 1 21 8.5 C21 13 16 17 12 21 Z',
    ],
  },
  wallet: {
    paths: [
      'M3 7 h18 v12 h-18 z',
      'M3 7 v-2 a2 2 0 0 1 2 -2 h12 v4',
      { d: 'M16 13 h2', filled: false },
    ],
  },
  'app-store-fill': {
    paths: [
      { d: 'M12 2 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0', filled: true, opacity: 0.15 },
      'M12 6 v12',
      'M6 12 h12',
      'M8 8 L16 16',
      'M8 16 L16 8',
    ],
  },
  shortcuts: {
    paths: [
      'M6 4 h12 v16 h-12 z',
      'M9 9 h6',
      'M9 13 h6',
      'M9 17 h4',
    ],
  },
  podcasts: {
    paths: [
      { d: 'M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0', filled: false },
      { d: 'M12 15 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0', filled: true },
      'M9 18 L10 21',
      'M15 18 L14 21',
      'M12 3 v6',
    ],
  },
  books: {
    paths: [
      'M4 4 h7 v16 h-7 z',
      'M13 4 h7 v16 h-7 z',
      'M7 8 h1',
      'M16 8 h1',
    ],
  },
  tv: {
    paths: [
      'M3 7 h18 v12 h-18 z',
      'M8 3 L12 7 L16 3',
    ],
  },

  // ── Dispositivo / Seguridad ───────────────────────────────────────────────
  lock: {
    paths: [
      { d: 'M5 11 h14 v10 h-14 z', filled: true },
      'M8 11 V7 a4 4 0 1 1 8 0 v4',
    ],
  },
  unlock: {
    paths: [
      { d: 'M5 11 h14 v10 h-14 z', filled: true },
      'M8 11 V7 a4 4 0 0 1 7.5 -2',
    ],
  },
  faceid: {
    paths: [
      'M4 8 V5 a1 1 0 0 1 1 -1 h3',
      'M20 8 V5 a1 1 0 0 0 -1 -1 h-3',
      'M4 16 v3 a1 1 0 0 0 1 1 h3',
      'M20 16 v3 a1 1 0 0 1 -1 1 h-3',
      'M9 10 v2',
      'M15 10 v2',
      'M12 13 v3',
      'M9 17 q3 2 6 0',
    ],
  },
  touchid: {
    paths: [
      { d: 'M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0', filled: false },
      'M12 5 a7 7 0 0 1 7 7',
      'M12 5 a7 7 0 0 0 -7 7',
      'M12 8 a4 4 0 0 1 4 4',
      'M12 8 a4 4 0 0 0 -4 4',
    ],
  },
  flashlight: {
    paths: [
      { d: 'M9 3 h6 l-1 6 h-4 z', filled: true },
      { d: 'M10 9 h4 v10 a2 2 0 0 1 -2 2 2 2 0 0 1 -2 -2 z', filled: true },
    ],
  },
  timer: {
    paths: [
      { d: 'M12 13 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0', filled: false },
      'M12 9 v4 l3 2',
      'M9 2 h6',
    ],
  },
  alarm: {
    paths: [
      { d: 'M12 13 m-7 0 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0', filled: false },
      'M12 10 v3 l2 2',
      'M5 4 L8 6',
      'M19 4 L16 6',
    ],
  },
  rotate: {
    paths: [
      'M7 3 h10 v14 h-10 z',
      'M18 12 a4 4 0 1 0 -4 4',
    ],
  },
  'rotate-lock': {
    paths: [
      'M7 3 h10 v14 h-10 z',
      'M18 12 a4 4 0 1 0 -4 4',
      'M9 6 v4',
      'M6 8 h6',
    ],
  },

  // ── Comunicación / Social ─────────────────────────────────────────────────
  reply: {
    paths: ['M9 10 L4 15 L9 20', 'M4 15 H14 a6 6 0 0 0 6 -6 V7'],
  },
  forward: {
    paths: ['M15 10 L20 15 L15 20', 'M20 15 H10 a6 6 0 0 1 -6 -6 V7'],
  },
  share: {
    paths: [
      'M12 3 v12',
      'M8 7 L12 3 L16 7',
      'M5 12 v8 h14 v-8',
    ],
  },
  heart: {
    paths: ['M12 21 C8 17 3 13 3 8.5 A4.5 4.5 0 0 1 12 6 A4.5 4.5 0 0 1 21 8.5 C21 13 16 17 12 21 Z'],
  },
  'heart-fill': {
    paths: [{ d: 'M12 21 C8 17 3 13 3 8.5 A4.5 4.5 0 0 1 12 6 A4.5 4.5 0 0 1 21 8.5 C21 13 16 17 12 21 Z', filled: true }],
  },
  bookmark: {
    paths: ['M6 3 h12 v18 L12 16 L6 21 Z'],
  },
  'bookmark-fill': {
    paths: [{ d: 'M6 3 h12 v18 L12 16 L6 21 Z', filled: true }],
  },
  flag: {
    paths: ['M5 3 v18', 'M5 4 h14 l-3 4 l3 4 h-14'],
  },
  star: {
    paths: ['M12 2 L15 9 L22 9.5 L17 14.5 L18.5 21.5 L12 18 L5.5 21.5 L7 14.5 L2 9.5 L9 9 Z'],
  },
  'star-fill': {
    paths: [{ d: 'M12 2 L15 9 L22 9.5 L17 14.5 L18.5 21.5 L12 18 L5.5 21.5 L7 14.5 L2 9.5 L9 9 Z', filled: true }],
  },
  bell: {
    paths: ['M18 16 v-5 a6 6 0 1 0 -12 0 v5 l-2 2 h16 z', 'M10 20 a2 2 0 0 0 4 0'],
  },
  'bell-off': {
    paths: [
      'M18 16 v-5 a6 6 0 0 0 -9 -5',
      'M6 11 v5 l-2 2 h14',
      'M10 20 a2 2 0 0 0 4 0',
      'M3 3 L21 21',
    ],
  },
  trash: {
    paths: [
      'M4 7 H20',
      'M9 7 V5 a1 1 0 0 1 1 -1 h4 a1 1 0 0 1 1 1 V7',
      'M6 7 l1 12 a2 2 0 0 0 2 2 h6 a2 2 0 0 0 2 -2 l1 -12',
    ],
  },
  edit: {
    paths: [
      'M4 20 h4 L20 8 L16 4 L4 16 Z',
      'M14 6 L18 10',
    ],
  },
  copy: {
    paths: [
      'M8 4 h10 a2 2 0 0 1 2 2 v10',
      'M6 8 h10 a2 2 0 0 1 2 2 v10 a2 2 0 0 1 -2 2 h-10 a2 2 0 0 1 -2 -2 v-10 a2 2 0 0 1 2 -2 z',
    ],
  },
  download: {
    paths: [
      'M12 3 v12',
      'M7 11 L12 16 L17 11',
      'M5 20 h14',
    ],
  },
  upload: {
    paths: [
      'M12 20 v-12',
      'M7 13 L12 8 L17 13',
      'M5 4 h14',
    ],
  },
  refresh: {
    paths: [
      'M20 5 v5 h-5',
      'M4 19 v-5 h5',
      'M19 10 a7 7 0 0 0 -13 -3 L4 10',
      'M5 14 a7 7 0 0 0 13 3 L20 14',
    ],
  },
  filter: {
    paths: ['M4 4 h16 l-6 8 v7 l-4 2 v-9 z'],
  },
  sort: {
    paths: ['M6 4 v16', 'M3 7 L6 4 L9 7', 'M18 20 v-16', 'M15 17 L18 20 L21 17'],
  },

  // ── Info / Estado ─────────────────────────────────────────────────────────
  info: {
    paths: [
      { d: 'M12 12 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0', filled: false },
      'M12 8 v.01',
      'M11 12 h1 v5',
    ],
  },
  warning: {
    paths: [
      'M12 3 L22 20 H2 Z',
      'M12 10 v5',
      'M12 18 v.01',
    ],
  },
  error: {
    paths: [
      { d: 'M12 12 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0', filled: false },
      'M12 7 v6',
      'M12 17 v.01',
    ],
  },
  success: {
    paths: [
      { d: 'M12 12 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0', filled: false },
      'M8 12 L11 15 L16 9',
    ],
  },
  question: {
    paths: [
      { d: 'M12 12 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0', filled: false },
      'M9.5 9 a2.5 2.5 0 1 1 3 2.5 V14',
      'M12 17 v.01',
    ],
  },
  'plus-circle': {
    paths: [
      { d: 'M12 12 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0', filled: false },
      'M12 7 v10',
      'M7 12 h10',
    ],
  },
  'minus-circle': {
    paths: [
      { d: 'M12 12 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0', filled: false },
      'M7 12 h10',
    ],
  },
  'check-circle': {
    paths: [
      { d: 'M12 12 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0', filled: false },
      'M8 12 L11 15 L16 9',
    ],
  },

  // ── Focus / Estado del usuario ────────────────────────────────────────────
  moon: {
    paths: [{ d: 'M20 14 a9 9 0 1 1 -10 -10 7 7 0 0 0 10 10 z', filled: true }],
  },
  sun: {
    paths: [
      { d: 'M12 12 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0', filled: true },
      'M12 2 v3 M12 19 v3 M2 12 h3 M19 12 h3',
      'M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5',
    ],
  },
  focus: {
    paths: [
      { d: 'M12 12 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0', filled: false },
      { d: 'M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0', filled: true },
    ],
  },
  user: {
    paths: [
      { d: 'M12 12 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0', filled: false },
      'M4 21 a8 8 0 0 1 16 0',
    ],
  },
  'user-fill': {
    paths: [
      { d: 'M12 12 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0', filled: true },
      { d: 'M4 21 a8 8 0 0 1 16 0 z', filled: true },
    ],
  },

  // ── Otros ─────────────────────────────────────────────────────────────────
  home: {
    paths: ['M3 11 L12 3 L21 11 V21 H15 V15 H9 V21 H3 Z'],
  },
  grid: {
    paths: [
      'M4 4 h6 v6 h-6 z',
      'M14 4 h6 v6 h-6 z',
      'M4 14 h6 v6 h-6 z',
      'M14 14 h6 v6 h-6 z',
    ],
  },
  list: {
    paths: [
      { d: 'M4 7 h.01', filled: true },
      { d: 'M4 12 h.01', filled: true },
      { d: 'M4 17 h.01', filled: true },
      'M9 7 h11',
      'M9 12 h11',
      'M9 17 h11',
    ],
  },
  eye: {
    paths: [
      'M1 12 s4 -7 11 -7 11 7 11 7 -4 7 -11 7S1 12 1 12z',
      { d: 'M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0', filled: false },
    ],
  },
  'eye-off': {
    paths: [
      'M1 12 s4 -7 11 -7 11 7 11 7 -4 7 -11 7S1 12 1 12z',
      { d: 'M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0', filled: false },
      'M3 3 L21 21',
    ],
  },
  link: {
    paths: [
      'M10 14 a5 5 0 0 0 7 0 l3 -3 a5 5 0 0 0 -7 -7 l-1 1',
      'M14 10 a5 5 0 0 0 -7 0 l-3 3 a5 5 0 0 0 7 7 l1 -1',
    ],
  },
  qr: {
    paths: [
      'M3 3 h6 v6 h-6 z',
      'M15 3 h6 v6 h-6 z',
      'M3 15 h6 v6 h-6 z',
      { d: 'M15 15 h.01', filled: true },
      { d: 'M18 15 h.01', filled: true },
      { d: 'M15 18 h.01', filled: true },
      { d: 'M21 15 v6 h-3', filled: false },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Componente
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Icon
 *
 * @param {Object} props
 * @param {string}  props.name                Clave del icono (ver ICONS)
 * @param {number}  [props.size=24]           Tamaño en px
 * @param {string}  [props.color='currentColor']
 * @param {number}  [props.weight=1.8]        Grosor de trazo (strokeWidth)
 * @param {boolean} [props.filled=false]      Fuerza relleno en paths que lo soporten
 * @param {string}  [props.className]
 * @param {Object}  [props.style]
 * @param {string}  [props.title]             aria-label
 * @param {'round'|'butt'|'square'} [props.linecap='round']
 * @param {'round'|'miter'|'bevel'} [props.linejoin='round']
 */
export default function Icon({
  name,
  size = 24,
  color = 'currentColor',
  weight = 1.8,
  filled = false,
  className,
  style,
  title,
  linecap = 'round',
  linejoin = 'round',
  ...rest
}) {
  const def = ICONS[name];
  if (!def) {
    // Icono desconocido: dibuja un cuadrado con "?" para depurar visualmente
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className={className}
        style={{ display: 'inline-block', verticalAlign: 'middle', ...style }}
        aria-label={title || `icono-${name}-desconocido`}
        {...rest}
      >
        <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke={color} strokeWidth={weight} strokeDasharray="2 2" />
        <text x="12" y="16" textAnchor="middle" fill={color} fontSize="10" fontFamily="sans-serif">?</text>
      </svg>
    );
  }

  const viewBox = def.viewBox || '0 0 24 24';

  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      className={className}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        flexShrink: 0,
        ...style,
      }}
      aria-label={title || name}
      role={title ? 'img' : 'presentation'}
      {...rest}
    >
      {def.paths.map((p, i) => {
        // Forma 1: string (path de trazo)
        if (typeof p === 'string') {
          return (
            <path
              key={i}
              d={p}
              fill="none"
              stroke={color}
              strokeWidth={weight}
              strokeLinecap={linecap}
              strokeLinejoin={linejoin}
            />
          );
        }
        // Forma 2: objeto { d, filled, opacity }
        const shouldFill = p.filled ?? filled;
        return (
          <path
            key={i}
            d={p.d}
            fill={shouldFill ? color : 'none'}
            stroke={shouldFill ? 'none' : color}
            strokeWidth={shouldFill ? 0 : weight}
            strokeLinecap={linecap}
            strokeLinejoin={linejoin}
            opacity={p.opacity != null ? p.opacity : 1}
          />
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// API auxiliar
// ─────────────────────────────────────────────────────────────────────────────

/** Lista todas las claves de iconos disponibles. */
export function listIcons() {
  return Object.keys(ICONS);
}

/** Comprueba si un nombre de icono existe. */
export function hasIcon(name) {
  return !!ICONS[name];
}

/** Icono dentro de un contenedor circular con fondo (estilo iOS badge). */
export function IconBadge({
  name,
  size = 22,
  padding = 8,
  background = 'rgba(120,120,128,0.32)',
  color = '#fff',
  weight = 1.8,
  filled = false,
  style,
}) {
  return (
    <div
      style={{
        width: size + padding * 2,
        height: size + padding * 2,
        borderRadius: (size + padding * 2) / 2,
        background,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        ...style,
      }}
    >
      <Icon name={name} size={size} color={color} weight={weight} filled={filled} />
    </div>
  );
}

/** Icono con etiqueta debajo (estilo tab bar). */
export function IconTab({
  name,
  label,
  active = false,
  color = '#fff',
  inactiveColor = 'rgba(255,255,255,0.55)',
  size = 24,
  weight = 1.8,
  onTap,
}) {
  const c = active ? color : inactiveColor;
  return (
    <button
      onClick={onTap}
      style={{
        background: 'transparent',
        border: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        cursor: 'pointer',
        padding: 6,
        color: c,
      }}
    >
      <Icon name={name} size={size} color={c} weight={weight} filled={active} />
      {label && (
        <span style={{ fontSize: 10, fontWeight: 500, color: c }}>{label}</span>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Iconos de app compuestos (para el Springboard)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renderiza el icono interno de una app con un gradiente si se desea.
 * Se usa dentro de <AppIcon> del Springboard cuando la app no trae emoji.
 */
export function AppGlyphIcon({ name, size = 28, color = '#fff', weight = 1.8, gradient }) {
  if (gradient) {
    return (
      <div
        style={{
          width: size * 1.6,
          height: size * 1.6,
          borderRadius: size * 0.36,
          background: gradient,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={name} size={size} color={color} weight={weight} />
      </div>
    );
  }
  return <Icon name={name} size={size} color={color} weight={weight} />;
}
