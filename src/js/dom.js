// Small DOM + formatting helpers shared by every view

// Let el.append(a, cond ? b : null) skip empty values instead of printing "null"
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const method of ['append', 'prepend']) {
    const native = proto[method];
    proto[method] = function (...nodes) {
      return native.apply(this, nodes.filter(n => n !== null && n !== undefined && n !== false));
    };
  }
}

/**
 * Create an element.
 *   h('div.card.big', { onclick, title: 'x', style: {...}, dataset: {...} }, child, [children], 'text')
 * Attributes starting with "on" become event listeners. null/false children are skipped.
 */
export function h(tag, attrs, ...children) {
  const [nameAndId, ...classes] = tag.split('.');
  const [name, id] = nameAndId.split('#');
  const el = document.createElement(name || 'div');
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');

  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }

  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'class' || key === 'className') {
      el.className += (el.className ? ' ' : '') + value;
    } else if (key === 'html') {
      el.innerHTML = value;
    } else if (key in el && typeof value !== 'string') {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : value);
    }
  }

  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** 125000 -> "125K" */
export function compact(n) {
  if (n === null || n === undefined) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/** milliseconds -> "3:07" or "1:02:03" */
export function duration(ms) {
  if (!ms && ms !== 0) return '';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** ISO date -> "3 days ago" */
export function timeAgo(date) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    const value = Math.floor(seconds / size);
    if (value >= 1) return `${value} ${unit}${value > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

/** SoundCloud artwork urls end in -large.jpg (100px); pick a bigger size */
export function artwork(url, size = 't500x500') {
  if (!url) return null;
  return url.replace(/-(large|t\d+x\d+|crop|original|badge|small|tiny|mini)\./, `-${size}.`);
}

/** Track or playlist artwork, falling back to the uploader avatar */
export function coverOf(item, size) {
  return artwork(item && (item.artwork_url || (item.user && item.user.avatar_url)), size);
}

export function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Plain text with URLs, @mentions and line breaks turned into safe HTML */
export function linkify(text) {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\n/g, '<br>');
}

/** Run fn when el scrolls near the bottom of its scroll container */
export function onNearBottom(scroller, fn, threshold = 600) {
  let busy = false;
  const check = async () => {
    if (busy) return;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - threshold) {
      busy = true;
      try { await fn(); } finally { busy = false; }
    }
  };
  scroller.addEventListener('scroll', check, { passive: true });
  return () => scroller.removeEventListener('scroll', check);
}

/**
 * Where a slider goes for a key press, or null when the key isn't one it uses: arrows move by step,
 * PageUp / PageDown by page, Home / End to the ends. The result stays within min..max.
 */
export function sliderKey(key, value, min, max, step, page = step * 6) {
  const moves = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -page, PageUp: page };
  let next;
  if (key === 'Home') next = min;
  else if (key === 'End') next = max;
  else if (Object.hasOwn(moves, key)) next = value + moves[key];
  else return null;
  return Math.max(min, Math.min(max, next));
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Tiny event emitter used by the player and store */
export class Emitter {
  constructor() { this.handlers = {}; }
  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    this.handlers[event] = (this.handlers[event] || []).filter(h => h !== fn);
  }
  emit(event, ...args) {
    (this.handlers[event] || []).forEach(fn => fn(...args));
  }
}
