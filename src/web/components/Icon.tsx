// Evenly's icon set (DESIGN.md 6, restyled for design/PICTUREBOOK.md): line icons on a 24 px
// grid, 2.2 px stroke by default so they sit at home next to the 3 px ink outlines (CSS can go
// heavier for tiny glyphs), round caps and joins, currentColor, no fills except dots. Note:
// `home` is the house (居家, the category); `groups` is three people (群組), `friends` two (朋友).
// The tab bar and the desktop sidebar draw colored tab art instead (TabIcon.tsx). Every entry is
// static SVG child markup (no user data), so it can be inlined safely.

import type { CSSProperties, SVGProps } from 'react';

const ICONS = {
  // ---- navigation and actions ----
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5.5 12h13"/>',
  check: '<path d="M5 12.6l4.4 4.4L19 7.4"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
  chevronDown: '<path d="m7 10 5 5 5-5"/>',
  chevronUp: '<path d="m7 14 5-5 5 5"/>',
  arrowRight: '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19.5 12h-15M10.5 6l-6 6 6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  settings: '<path d="M10.46 5.58L10.71 3.4A8.7 8.7 0 0 1 13.29 3.4L13.54 5.58A6.6 6.6 0 0 1 15.45 6.37L17.17 5.01A8.7 8.7 0 0 1 18.99 6.83L17.63 8.55A6.6 6.6 0 0 1 18.42 10.46L20.6 10.71A8.7 8.7 0 0 1 20.6 13.29L18.42 13.54A6.6 6.6 0 0 1 17.63 15.45L18.99 17.17A8.7 8.7 0 0 1 17.17 18.99L15.45 17.63A6.6 6.6 0 0 1 13.54 18.42L13.29 20.6A8.7 8.7 0 0 1 10.71 20.6L10.46 18.42A6.6 6.6 0 0 1 8.55 17.63L6.83 18.99A8.7 8.7 0 0 1 5.01 17.17L6.37 15.45A6.6 6.6 0 0 1 5.58 13.54L3.4 13.29A8.7 8.7 0 0 1 3.4 10.71L5.58 10.46A6.6 6.6 0 0 1 6.37 8.55L5.01 6.83A8.7 8.7 0 0 1 6.83 5.01L8.55 6.37A6.6 6.6 0 0 1 10.46 5.58Z"/><circle cx="12" cy="12" r="2.6"/>',
  share: '<path d="M12 3.8v11M8 7.6l4-3.8 4 3.8"/><path d="M6.5 11H5.5v9h13v-9h-1"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="1.5"/><path d="M15.5 8.5V5.5a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx=".8"/><rect x="14" y="4" width="6" height="6" rx=".8"/><rect x="4" y="14" width="6" height="6" rx=".8"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h1M20 14v1"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7"/><path d="M6.5 7l.85 11.6a1.5 1.5 0 0 0 1.5 1.4h6.3a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10 11v5.5M14 11v5.5"/>',
  edit: '<path d="M5 19l.9-4.1 9.8-9.8a1.6 1.6 0 0 1 2.3 0l.9.9a1.6 1.6 0 0 1 0 2.3l-9.8 9.8z"/><path d="M14.2 6.6l3.2 3.2"/>',
  undo: '<path d="M9 7.5H5V3.5"/><path d="M5.3 7.4A7.5 7.5 0 1 1 4.5 12"/>',
  restore: '<path d="M9 7.5H5V3.5"/><path d="M5.3 7.4A7.5 7.5 0 1 1 4.5 12"/>',
  comment: '<path d="M5 5.5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5v-3.5H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/>',
  repeat: '<path d="M5 11V9.5a2.5 2.5 0 0 1 2.5-2.5H18M15.5 4.5 18 7l-2.5 2.5"/><path d="M19 13v1.5a2.5 2.5 0 0 1-2.5 2.5H6M8.5 19.5 6 17l2.5-2.5"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14" rx="1.5"/><path d="M4 9.5h16M8.5 3.5v3.5M15.5 3.5v3.5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  note: '<path d="M5.5 4.5h13v15h-13z"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>',
  backspace: '<path d="M9.2 5.5H19a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H9.2L3.5 12z"/><path d="M11.5 9.3l5 5.4M16.5 9.3l-5 5.4"/>',
  more: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  swap: '<path d="M4.5 8.5h12.5M14 5.5l3 3-3 3"/><path d="M19.5 15.5H7M10 12.5l-3 3 3 3"/>',
  filter: '<path d="M4 6.5h16M7 12h10M10 17.5h4"/>',
  external: '<path d="M13.5 4.5h6v6M19.5 4.5 11 13"/><path d="M17 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V9a1.5 1.5 0 0 1 1.5-1.5H11"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  upload: '<path d="M12 15.5v-11M7.5 9 12 4.5 16.5 9M5 19.5h14"/>',
  /** 封存群組: a box with its lid. */
  archive: '<rect x="3.5" y="4.5" width="17" height="5" rx="1.4"/><path d="M5 9.5v8.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V9.5"/><path d="M10 13.5h4"/>',
  /** 分享結算圖卡: a picture (a frame, the sun and a hill). */
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m4.5 17.5 4.8-4.8 3.7 3.7 2.4-2.4 4.1 4.1"/>',
  logout: '<path d="M13.5 4.5h-7A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5h7"/><path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5"/>',

  // ---- the shell ----
  receipt: '<path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
  groups: '<circle cx="12" cy="8.3" r="3.2"/><path d="M6.4 19.6c.5-3.3 2.7-5.3 5.6-5.3s5.1 2 5.6 5.3"/><path d="M6.2 11.7a2.6 2.6 0 1 1 .3-5.1"/><path d="M2.6 17.8c.3-2.1 1.5-3.5 3.2-4"/><path d="M17.8 11.7a2.6 2.6 0 1 0-.3-5.1"/><path d="M21.4 17.8c-.3-2.1-1.5-3.5-3.2-4"/>',
  friends: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.3c1.6.7 2.7 2.3 3 4.7"/>',
  activity: '<path d="M6 9.5a6 6 0 0 1 12 0c0 4.5 1.8 6 1.8 6H4.2S6 14 6 9.5"/><path d="M10 19a2.1 2.1 0 0 0 4 0"/>',
  bell: '<path d="M6 9.5a6 6 0 0 1 12 0c0 4.5 1.8 6 1.8 6H4.2S6 14 6 9.5"/><path d="M10 19a2.1 2.1 0 0 0 4 0"/><path d="M3.4 7.2c.4-1.5 1.2-2.6 2.3-3.4M20.6 7.2c-.4-1.5-1.2-2.6-2.3-3.4"/>',
  user: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 19.5c.8-3.6 3.6-5.8 7-5.8s6.2 2.2 7 5.8"/>',
  users: '<circle cx="12" cy="8.6" r="3"/><path d="M6.8 19.4c.5-3.1 2.5-5 5.2-5s4.7 1.9 5.2 5"/><path d="M6.4 11.6a2.5 2.5 0 1 1 .2-4.9"/><path d="M2.8 17.6c.3-2 1.4-3.3 3.1-3.8"/><path d="M17.6 11.6a2.5 2.5 0 1 0-.2-4.9"/><path d="M21.2 17.6c-.3-2-1.4-3.3-3.1-3.8"/>',
  userPlus: '<circle cx="10" cy="8.5" r="3.4"/><path d="M3.5 19.5c.7-3.4 3.2-5.3 6.5-5.3 1.5 0 2.8.4 3.9 1.1"/><path d="M18 13.5v6M15 16.5h6"/>',
  wallet: '<rect x="3.5" y="6.5" width="17" height="12.5" rx="2"/><path d="M20.5 10.5h-3.8a2.25 2.25 0 0 0 0 4.5h3.8"/><path d="M6.5 6.5 15.4 4a1 1 0 0 1 1.3 1v1.5"/>',
  chart: '<path d="M4 20h16M7 16.5V12M12 16.5V6M17 16.5v-7"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.1"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.7M12 17v.1"/>',
  warning: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  offline: '<path d="M7.5 18.5H17a4 4 0 0 0 .9-7.9 5.5 5.5 0 0 0-9.6-2.2"/><path d="M5.6 10.3A4.2 4.2 0 0 0 7.5 18.5"/><path d="M4 4l16 16"/>',
  sync: '<path d="M4.5 12a7.5 7.5 0 0 1 13.2-4.9M19.5 12a7.5 7.5 0 0 1-13.2 4.9"/><path d="M18.2 3.6v3.9h-3.9M5.8 20.4v-3.9h3.9"/>',
  language: '<path d="M3.5 6h9M8 4.2V6M10.8 6c-.7 3.5-2.9 6.3-6.3 8"/><path d="M5.8 9.2c1.1 2 2.8 3.6 5 4.5"/><path d="M12.5 20.5 16.2 11h.6l3.7 9.5M13.9 17.3h5.2"/>',
  currency: '<circle cx="9.5" cy="9.5" r="5.5"/><path d="M14.98 9.02A5.5 5.5 0 1 1 9.02 14.98"/>',
  device: '<rect x="7" y="3.5" width="10" height="17" rx="2.2"/><path d="M11 17.6h2"/>',
  link: '<path d="M10.6 13.4a3.6 3.6 0 0 0 5.1 0l2.8-2.8a3.6 3.6 0 0 0-5.1-5.1l-.9.9"/><path d="M13.4 10.6a3.6 3.6 0 0 0-5.1 0l-2.8 2.8a3.6 3.6 0 0 0 5.1 5.1l.9-.9"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="1.8"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.2v2.4"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="M10.9 12.6 19 4.5M16.2 7.3l2.3 2.3M13.9 9.6l1.8 1.8"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.8"/><path d="m4.5 7 7.5 6 7.5-6"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.3"/>',
  eye: '<path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.8"/><path d="M4.5 4.5l15 15"/>',
  star: '<path d="M12 4L14.29 9.44L20.18 9.94L15.71 13.81L17.05 19.56L12 16.5L6.95 19.56L8.29 13.81L3.82 9.94L9.71 9.44Z"/>',
  sparkle: '<path d="M10.4 3.8Q11.24 9.56 17 10.4Q11.24 11.24 10.4 17Q9.56 11.24 3.8 10.4Q9.56 9.56 10.4 3.8Z"/><path d="M18.2 15.1Q18.61 17.59 21.1 18Q18.61 18.41 18.2 20.9Q17.79 18.41 15.3 18Q17.79 17.59 18.2 15.1Z"/>',
  heart: '<path d="M12 19.5s-7.5-4.4-7.5-9.6A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.3c0 5.2-7.5 9.6-7.5 9.6z"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="1.8"/><path d="M3 9.5h18M6.5 15h3"/>',
  pin: '<path d="M12 20.5s6-5.3 6-10.3a6 6 0 0 0-12 0c0 5 6 10.3 6 10.3z"/><circle cx="12" cy="10.2" r="2.2"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M18.2 12L20.4 12M16.38 16.38L17.94 17.94M12 18.2L12 20.4M7.62 16.38L6.06 17.94M5.8 12L3.6 12M7.62 7.62L6.06 6.06M12 5.8L12 3.6M16.38 7.62L17.94 6.06"/>',
  moon: '<path d="M19 14.6A7.6 7.6 0 1 1 9.4 5a6 6 0 0 0 9.6 9.6z"/>',

  // ---- group ticket art (GroupAvatar) ----
  mountain: '<path d="M2.8 19.5 10.1 7a.9.9 0 0 1 1.6 0l7.5 12.5z"/><path d="M7.6 11.3l1.6 1.3 1.7-1.6 1.6 1.6 1.4-1.2"/><path d="M15.1 12.6l1.6-2.5 4.5 9.4"/>',
  island: '<circle cx="16.6" cy="7" r="2.3"/><path d="M5.5 16.4c1.8-2.4 4-3.6 6.5-3.6s4.7 1.2 6.5 3.6"/><path d="M3 19.6c1.3 0 1.9-.9 3-.9s1.7.9 3 .9 1.9-.9 3-.9 1.7.9 3 .9 1.9-.9 3-.9 1.7.9 3 .9"/>',
  pine: '<path d="M12 3.4l5.1 6.8h-2.7l4 5.6H5.6l4-5.6H6.9z"/><path d="M12 15.8v4.7"/>',
  city: '<path d="M3.5 20h17"/><path d="M5 20V9.5h5V20M10 20V4.5h6V20M16 20v-7.5h3.5V20"/><path d="M12.2 8h1.6M12.2 11h1.6M12.2 14h1.6"/>',

  // ---- categories (src/shared/categories.ts icon names) ----
  dining: '<path d="M3.5 11.5h17M4.6 11.5a7.4 7 0 0 0 14.8 0"/><path d="M9.5 20.2h5"/><path d="M6.5 8.8 20.5 3.6M9.4 9.6l11.3-3.8"/>',
  groceries: '<path d="M3.5 4.5h2.2l2.1 10.2a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.5-1.1l1.6-6.3H6.6"/><circle cx="10" cy="19.3" r="1.2"/><circle cx="17" cy="19.3" r="1.2"/>',
  coffee: '<path d="M5 10h11v4.5a4.5 4.5 0 0 1-4.5 4.5h-2A4.5 4.5 0 0 1 5 14.5z"/><path d="M16 11.5h1.5a2.25 2.25 0 0 1 0 4.5H16"/><path d="M8.5 4.5c-.6.8-.6 1.7 0 2.5M12.5 4.5c-.6.8-.6 1.7 0 2.5"/>',
  liquor: '<path d="M7.8 3.5h8.4l.5 4.8a4.7 4.7 0 0 1-9.4 0z"/><path d="M7.6 8h8.8"/><path d="M12 13v7.5M8.5 20.5h7"/>',
  food: '<rect x="3.5" y="6" width="17" height="12.5" rx="2"/><path d="M12.5 6v12.5M12.5 12.2h8"/><circle cx="8" cy="12.2" r="2.2"/>',
  plane: '<path transform="rotate(45 12 12)" d="M12 3c.9 0 1.5.9 1.5 2v4.6l6.5 3.9v1.8l-6.5-2v4.2l2 1.6V21L12 20l-3.5 1v-1.9l2-1.6v-4.2l-6.5 2v-1.8l6.5-3.9V5c0-1.1.6-2 1.5-2z"/>',
  train: '<rect x="5.5" y="3.5" width="13" height="14" rx="3"/><rect x="8" y="6.2" width="8" height="5" rx="1"/><path d="M8.7 14.6h.1M15.2 14.6h.1"/><path d="M8.5 17.5 6.5 20.5M15.5 17.5l2 3"/>',
  taxi: '<path d="M5 16.5V12l1.8-4.6A1.5 1.5 0 0 1 8.2 6.5h7.6a1.5 1.5 0 0 1 1.4.9L19 12v4.5"/><path d="M3.5 16.5h17M5 12h14"/><path d="M6.5 16.5v2M17.5 16.5v2"/><path d="M10 6.5V5.2a.7.7 0 0 1 .7-.7h2.6a.7.7 0 0 1 .7.7v1.3"/><circle cx="8" cy="14.2" r=".6"/><circle cx="16" cy="14.2" r=".6"/>',
  car: '<path d="M5 16.5V12l1.8-4.6A1.5 1.5 0 0 1 8.2 6.5h7.6a1.5 1.5 0 0 1 1.4.9L19 12v4.5"/><path d="M3.5 16.5h17M5 12h14"/><path d="M6.5 16.5v2M17.5 16.5v2"/><circle cx="8" cy="14.2" r=".6"/><circle cx="16" cy="14.2" r=".6"/>',
  fuel: '<path d="M5.5 20V5.5A1.5 1.5 0 0 1 7 4h5.5A1.5 1.5 0 0 1 14 5.5V20M4 20h11.5"/><path d="M7.5 7.5h4.5V11H7.5z"/><path d="M14 10.5h1.5a1.5 1.5 0 0 1 1.5 1.5v4.3a1.3 1.3 0 0 0 2.6 0V8.8L17.3 6.5"/>',
  parking: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M10 16.5v-9h2.9a2.6 2.6 0 0 1 0 5.2H10"/>',
  bicycle: '<circle cx="6.3" cy="15.5" r="3.6"/><circle cx="17.7" cy="15.5" r="3.6"/><path d="M6.3 15.5 9.6 9h5.6l2.5 6.5M12.2 15.5 8.9 7.2M7.4 7.2h3M6.3 15.5h5.9l3-6.5M15.2 9l-.7-2.5h2.2"/>',
  transport: '<rect x="5" y="3.5" width="14" height="15" rx="2.5"/><path d="M5 7.5h14M5 12.5h14"/><path d="M8.5 15.5h.1M15.4 15.5h.1"/><path d="M7.5 18.5v2M16.5 18.5v2"/>',
  hotel: '<path d="M3.5 18.5V6.5M3.5 15h17v3.5M20.5 15v-3a2.5 2.5 0 0 0-2.5-2.5h-7.5V15"/><circle cx="7" cy="11.5" r="1.8"/>',
  ticket: '<g transform="rotate(-20 12 12)"><path d="M4 8a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2a2 2 0 0 0 0 4v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a2 2 0 0 0 0-4z"/><path d="M8.5 10.5h7M8.5 13.5h4.5"/></g>',
  ski: '<path d="M12 3.4L12 20.6M19.45 7.7L4.55 16.3M19.45 16.3L4.55 7.7"/><path d="M13.63 6.05L12 4.42L10.37 6.05M17.97 10.43L18.57 8.21L16.35 7.61M16.35 16.39L18.57 15.79L17.97 13.57M10.37 17.96L12 19.59L13.63 17.96M6.03 13.57L5.43 15.79L7.65 16.39M7.65 7.61L5.43 8.21L6.03 10.43"/>',
  gift: '<rect x="4" y="8.5" width="16" height="4" rx="1"/><path d="M5.5 12.5V19a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5M12 8.5V20"/><path d="M12 8.5C10.6 5 7 4.4 7 6.6 7 8 9 8.5 12 8.5zM12 8.5c1.4-3.5 5-4.1 5-1.9 0 1.4-2 1.9-5 1.9z"/>',
  luggage: '<rect x="5" y="7" width="14" height="12.5" rx="2"/><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M9 10.5v5.5M15 10.5v5.5M8 19.5v1M16 19.5v1"/>',
  movie: '<path d="M4 10.5h16v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M4 10.5 3.5 8.3a1 1 0 0 1 .75-1.2l13.6-3.1a1 1 0 0 1 1.2.75l.5 2.15z"/><path d="M8.2 6.9l2 2.1M13.1 5.45l2 2.45"/>',
  music: '<path d="M9 17.5V6.2l10-2.2v11.5M9 9.6l10-2.2"/><circle cx="6.75" cy="17.5" r="2.25"/><circle cx="16.75" cy="15.5" r="2.25"/>',
  games: '<path d="M8 7.5h8a4.5 4.5 0 0 1 4.4 3.6l.9 4.3a2.2 2.2 0 0 1-3.8 1.9L15.8 15.5H8.2l-1.7 1.8a2.2 2.2 0 0 1-3.8-1.9l.9-4.3A4.5 4.5 0 0 1 8 7.5z"/><path d="M8.5 9.8v3.4M6.8 11.5h3.4"/><path d="M15.3 11.2h.1M17.3 12.4h.1"/>',
  sports: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5v17"/><path d="M6 6a8.5 8.5 0 0 1 0 12M18 6a8.5 8.5 0 0 0 0 12"/>',
  party: '<path d="M4.5 19.5 8 9.5l6.5 6.5z"/><path d="M13 3.5c.5 1.7 0 3.2-1.5 4.3M20.5 11c-1.7-.5-3.2 0-4.3 1.5"/><path d="M16 4.5v.1M19.5 7v.1M17.5 8.5l2.5-2.5M15 8.5v.1"/>',
  rent: '<circle cx="8" cy="15.5" r="4"/><path d="M10.9 12.6 19 4.5M16.2 7.3l2.3 2.3M13.9 9.6l1.8 1.8"/>',
  mortgage: '<path d="M4 9.5 12 4.5l8 5"/><path d="M5 9.5h14"/><path d="M6.5 9.5v8M10 9.5v8M14 9.5v8M17.5 9.5v8"/><path d="M4 20h16M4.5 17.5h15"/>',
  furniture: '<path d="M5.5 10.5v-2A2.5 2.5 0 0 1 8 6h8a2.5 2.5 0 0 1 2.5 2.5v2"/><path d="M3.5 12.5a1.75 1.75 0 0 1 3.5 0v2h10v-2a1.75 1.75 0 0 1 3.5 0v5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M6 19v1.5M18 19v1.5"/>',
  electronics: '<rect x="3.5" y="5" width="17" height="11.5" rx="1.8"/><path d="M9 20h6M12 16.5V20"/>',
  supplies: '<path d="M4 8l8-4 8 4v8.5l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8.5"/><path d="M8 6l8 4"/>',
  tools: '<path transform="rotate(45 12 12)" d="M10.6 3.25V6h2.8V3.25A4 4 0 0 1 13.6 10.67V19a1.6 1.6 0 0 1-3.2 0v-8.33A4 4 0 0 1 10.6 3.25z"/>',
  services: '<path d="M19.5 3.5 13 11"/><path d="M10.6 9.4l5 4.2-2.2 5a1.4 1.4 0 0 1-2 .6l-6.6-4.4a1.4 1.4 0 0 1-.3-2z"/><path d="M8.5 17.3l1.8-3M6.3 15.8l1.8-3"/>',
  pets: '<circle cx="6.5" cy="11.2" r="1.6"/><circle cx="9.6" cy="7.4" r="1.6"/><circle cx="14.4" cy="7.4" r="1.6"/><circle cx="17.5" cy="11.2" r="1.6"/><path d="M12 12.2c-2.4 0-4.8 2.9-4.8 5 0 1.4 1 2.3 2.3 2.3.9 0 1.6-.5 2.5-.5s1.6.5 2.5.5c1.3 0 2.3-.9 2.3-2.3 0-2.1-2.4-5-4.8-5z"/>',
  home: '<path d="M3.8 11.2 12 4.6l8.2 6.6"/><path d="M6 9.6v9.9h12V9.6"/><path d="M10 19.5v-5h4v5"/>',
  electricity: '<path d="M9.2 16.5c0-1.9-2.7-3.4-2.7-6.8a5.5 5.5 0 0 1 11 0c0 3.4-2.7 4.9-2.7 6.8z"/><path d="M9.5 19.2h5M10.5 21.4h3"/>',
  water: '<path d="M12 3.8s6 6.4 6 10.6a6 6 0 0 1-12 0c0-4.2 6-10.6 6-10.6z"/><path d="M9.2 14.6a2.9 2.9 0 0 0 2.6 2.7"/>',
  heat: '<path d="M12 20.5c3.3 0 6-2.3 6-5.8 0-4.4-3.8-6.2-4.6-10.2-2.8 1.7-3.9 4.3-3.6 6.9-1-.5-1.7-1.5-1.9-2.6C6.8 10.2 6 12.4 6 14.7c0 3.5 2.7 5.8 6 5.8z"/>',
  wifi: '<path d="M3.6 9.6a12 12 0 0 1 16.8 0M6.6 12.8a7.7 7.7 0 0 1 10.8 0M9.5 15.9a3.6 3.6 0 0 1 5 0"/><path d="M12 19.2v.1"/>',
  cleaning: '<path d="M8 10h6.5l1 3V19a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 19v-6z"/><path d="M9 10V7.5h4V10"/><path d="M8 7.5V5h6l2 1.5"/><path d="M18.5 4.5h.1M20 7h.1M18.5 9.5h.1"/>',
  bill: '<path d="M6 3.5h8.5L18 7v13.5H6z"/><path d="M14.5 3.5V7H18"/><path d="M9 11h6M9 14.5h6M9 18h3.5"/>',
  shopping: '<path d="M5.5 8.5h13l-1 11.5h-11z"/><path d="M9 8.5V7a3 3 0 0 1 6 0v1.5"/>',
  clothing: '<path d="M9 4.5 4 7l1.6 4.2 2.4-.9V20h8v-9.7l2.4.9L20 7l-5-2.5c-.4 1.3-1.6 2.2-3 2.2S9.4 5.8 9 4.5z"/>',
  medical: '<rect x="3.6" y="8.6" width="16.8" height="6.8" rx="3.4" transform="rotate(-45 12 12)"/><path d="M9.6 9.6l4.8 4.8"/>',
  education: '<path d="M4 5.5h5a3 3 0 0 1 3 3v11a2.2 2.2 0 0 0-2.2-2.2H4z"/><path d="M20 5.5h-5a3 3 0 0 0-3 3v11a2.2 2.2 0 0 1 2.2-2.2H20z"/>',
  childcare: '<path d="M10.4 7a1.6 1.6 0 0 1 3.2 0v1h-3.2z"/><path d="M8.5 8h7v2.2h-7z"/><path d="M9 10.2h6l.6 1.6V19a1.5 1.5 0 0 1-1.5 1.5H9.9A1.5 1.5 0 0 1 8.4 19v-7.2z"/><path d="M10.8 13.8h2.4M10.8 16.8h2.4"/>',
  insurance: '<path d="M12 3.5l7 2.6v5.3c0 4.3-2.9 7.6-7 9.1-4.1-1.5-7-4.8-7-9.1V6.1z"/><path d="M9 12l2.2 2.2L15.2 10"/>',
  taxes: '<circle cx="12" cy="12" r="8.5"/><path d="M8.8 15.2l6.4-6.4"/><circle cx="9.2" cy="9.2" r="1.1"/><circle cx="14.8" cy="14.8" r="1.1"/>',
  life: '<path d="M5 19c0-8 5-13.5 14-14 .5 9-5 14-13 14z"/><path d="M5 19c3-4 6-6.5 9.5-8.5"/>',
  general: '<path d="M7 3.5h10v17l-1.7-1.2-1.6 1.2-1.7-1.2-1.7 1.2-1.6-1.2L7 20.5z"/><path d="M9.5 8h5M9.5 11.5h5M9.5 15h3"/>',
  payment: '<rect x="3" y="6.5" width="18" height="11" rx="1.6"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 10v4M17.5 10v4"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** Every icon name, for pickers and tests. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

const KNOWN: Record<string, string> = ICONS;

/** True when `name` is drawn in this set (category icons come in as plain strings). */
export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(KNOWN, name);
}

/** A neutral dot for names the set does not have. */
const UNKNOWN = '<circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'ref'> {
  name: IconName;
  /** Rendered width and height in px (default 24). */
  size?: number;
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  title?: string;
  /** Overrides the 2.2 px line (CSS stroke-width wins over this too). */
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 24, title, strokeWidth = 2.2, className, style, ...rest }: IconProps) {
  const body = KNOWN[name as string] ?? UNKNOWN;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className={className}
      style={style}
      data-icon={name}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <g dangerouslySetInnerHTML={{ __html: body }} />
    </svg>
  );
}
