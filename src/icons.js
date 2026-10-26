// Inline SVG icons (static strings, safe for innerHTML).

const svg = (body, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  repo: svg('<path d="M3 13.5V3a1.5 1.5 0 0 1 1.5-1.5H13v10H4.5A1.5 1.5 0 0 0 3 13a1.5 1.5 0 0 0 1.5 1.5H13"/><path d="M6 14.5v1.2l1-.6 1 .6v-1.2"/>'),
  lock: svg('<rect x="3" y="7" width="10" height="7.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  branch: svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5"/>'),
  sync: svg('<path d="M13.5 8a5.5 5.5 0 0 1-9.6 3.7M2.5 8a5.5 5.5 0 0 1 9.6-3.7"/><path d="M12.5 1.5v3h-3M3.5 14.5v-3h3"/>'),
  up: svg('<path d="M8 13.5v-11M3.5 7 8 2.5 12.5 7"/>'),
  down: svg('<path d="M8 2.5v11M3.5 9 8 13.5 12.5 9"/>'),
  upload: svg('<path d="M8 10V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/>'),
  caret: svg('<path d="m4 6 4 4 4-4"/>'),
  server: svg('<rect x="2" y="2.5" width="12" height="4.5" rx="1"/><rect x="2" y="9" width="12" height="4.5" rx="1"/><path d="M4.5 4.75h.01M4.5 11.25h.01"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  x: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  gear: svg('<circle cx="8" cy="8" r="2"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4"/>'),
  check: svg('<path d="m3 8.5 3 3 7-7"/>'),
  terminal: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="m4.5 6 2 2-2 2M8.5 10.5h3"/>'),
  external: svg('<path d="M9.5 2.5h4v4M13.5 2.5 7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>'),
  code: svg('<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>'),
  folder: svg('<path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>'),
  alert: svg('<path d="M8 1.8 15 14H1z"/><path d="M8 6.5v3M8 11.8h.01"/>'),
  commit: svg('<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
  undo: svg('<path d="M4.5 6.5h6a3 3 0 0 1 0 6h-3"/><path d="m7 4-2.5 2.5L7 9"/>'),
  spinner: `<svg class="spin" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M14 8a6 6 0 1 1-6-6" stroke-linecap="round"/></svg>`,
};

const statusGlyph = {
  modified: '<circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>',
  new: '<path d="M8 5v6M5 8h6"/>',
  deleted: '<path d="M5 8h6"/>',
  renamed: '<path d="M5 8h6M8.5 5.5 11 8l-2.5 2.5"/>',
  conflicted: '<path d="M8 4.8v3.7M8 11h.01"/>',
};

export const fileIcon = (kind) =>
  svg(`<rect x="2" y="2" width="12" height="12" rx="2.5"/>${statusGlyph[kind] || statusGlyph.modified}`);
