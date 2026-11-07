// The queue panel's list. Handoff (the next song starting) moves only the current index, so the rows,
// transition buttons and their handlers are kept and just re-marked; the list is rebuilt only when the
// queue's contents (or what a row shows) change. Rebuild requests in one tick are one rebuild.
import { h, clear, duration, coverOf } from './dom.js';
import { iconButton, emptyState } from './ui.js';
import { transitionFor } from './cues.js';
import { formatCueTime } from './cue-time.js';
import { transitionDialog } from './transition-editor.js';

/** Rows drawn after the current song; "Show more" adds this many again, so a queue of hundreds stays cheap */
export const UPCOMING = 100;
const HISTORY = 3; // a little history stays visible

const rowKey = track => `${track.id}|${track.title}|${track.user ? track.user.username : ''}|${track.duration}|${coverOf(track, 't67x67')}`;

export function createQueuePanel(panel, { player, close }) {
  const isOpen = () => panel.classList.contains('open');
  const stats = { builds: 0, rowsBuilt: 0, moves: 0 };
  let shown = UPCOMING;   // upcoming rows currently drawn
  let drawn = null;       // { tracks, context, list, rows: Map(i -> record), index }
  let pending = false;

  // what the transition button between song i and the next shows
  function transitionSpec(i) {
    const track = player.queue[i], next = player.queue[i + 1];
    if (!next) return null;
    const transition = transitionFor(track.id, next.id, player.crossfadeSeconds());
    // in mix order, say how this song blends into the next
    const blend = player.blendNote(i);
    const label = (transition.custom
      ? `↘ ${transition.out == null ? 'end' : formatCueTime(transition.out)} → ${formatCueTime(transition.in)} · ${transition.fade}s`
      : 'Transition') + (blend ? ` · ${blend.text}` : '');
    return {
      cls: 'queue-transition' + (transition.custom ? ' custom' : '') + (blend && blend.ok === true ? ' blend-ok' : blend && blend.ok === false ? ' blend-warn' : ''),
      title: `Edit transition: ${track.title} → ${next.title}`, label
    };
  }

  function transitionButton(i) {
    const spec = transitionSpec(i);
    if (!spec) return null;
    const track = player.queue[i], next = player.queue[i + 1];
    const button = h('button', { className: spec.cls, title: spec.title, onclick: () => transitionDialog(track, next, { player }) }, spec.label);
    button.spec = spec;
    return button;
  }

  /** Blend notes change as songs are analysed while the order stays put: re-read them, touching the DOM only where the text differs */
  function updateTransitions() {
    if (!drawn) return;
    for (const rec of drawn.rows.values()) {
      const button = rec.transition;
      if (!button) continue;
      const spec = transitionSpec(rec.i);
      if (!spec) continue;
      const old = button.spec;
      if (spec.label !== old.label) button.textContent = spec.label;
      if (spec.cls !== old.cls) button.className = spec.cls;
      if (spec.title !== old.title) button.title = spec.title;
      button.spec = spec;
    }
  }

  function makeRow(i) {
    const track = player.queue[i];
    const row = h('div.queue-row',
      { draggable: true, dataset: { index: i }, tabindex: '0', role: 'button', 'aria-label': `Play ${track.title}` },
      h('div.queue-art', { style: { backgroundImage: coverOf(track, 't67x67') ? `url("${coverOf(track, 't67x67')}")` : '' } }),
      h('div.queue-meta', h('div.queue-title', track.title), h('div.muted.small', track.user ? track.user.username : '')),
      h('span.muted.small', duration(track.duration))
    );
    row.addEventListener('dblclick', () => player.jump(i));
    // Enter / Space on the row itself (not on its Remove button) plays it, like a double-click
    row.addEventListener('keydown', (e) => {
      if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      e.stopPropagation(); // Space would also pause through the global shortcut
      player.jump(i);
    });
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-quantm-queue', String(i)); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      // only a row dragged from this list counts (a file dropped from outside carries no index)
      const raw = e.dataTransfer.getData('application/x-quantm-queue');
      const from = raw === '' ? NaN : Number(raw);
      if (!isNaN(from) && from !== i) player.moveInQueue(from, i);
    });
    stats.rowsBuilt++;
    return { i, row, key: rowKey(track), remove: null, transition: transitionButton(i) };
  }

  /** Bring the drawn rows in line with player.index: add what came into range, drop what left, re-mark, re-order */
  function sync() {
    const d = drawn, queue = player.queue, index = player.index;
    const lo = Math.max(0, index - HISTORY);
    const hi = Math.min(queue.length, Math.max(index, 0) + 1 + shown);
    for (const i of [...d.rows.keys()]) if (i < lo || i >= hi) d.rows.delete(i);
    const nodes = [];
    for (let i = lo; i < hi; i++) {
      let rec = d.rows.get(i);
      if (!rec) { rec = makeRow(i); d.rows.set(i, rec); }
      const current = i === index;
      rec.row.classList.toggle('current', current);
      rec.row.classList.toggle('past', i < index);
      if (current && rec.remove) { rec.remove.remove(); rec.remove = null; }
      else if (!current && !rec.remove) {
        const at = i;
        rec.remove = iconButton('close', 'Remove', () => player.removeFromQueue(at), 'queue-remove');
        rec.row.append(rec.remove);
      }
      if (i === index) nodes.push(h('div.queue-label', 'Now playing'));
      if (i === index + 1) nodes.push(h('div.queue-label', 'Next up'));
      nodes.push(rec.row);
      if (rec.transition) nodes.push(rec.transition);
    }
    if (hi < queue.length) {
      const left = queue.length - hi;
      nodes.push(h('button.btn.btn-ghost.btn-sm.queue-more', { onclick: () => { shown += UPCOMING; if (drawn) sync(); } },
        `Show ${Math.min(UPCOMING, left)} more (${left} not shown)`));
    }
    clear(d.list).append(...nodes);
    d.index = index;
    return d.rows.get(index);
  }

  /** Throw the list away and draw it again (opening the panel, or something a row shows has changed) */
  function build() {
    pending = false;
    if (!isOpen()) return;
    stats.builds++;
    clear(panel);
    panel.append(h('div.queue-head',
      h('h2', 'Queue'),
      h('div.queue-head-actions',
        h('button.btn.btn-ghost.btn-sm', { onclick: () => player.clearQueue() }, 'Clear'),
        iconButton('close', 'Close', close)
      )
    ));
    if (!player.queue.length) {
      drawn = null;
      panel.append(emptyState('Your queue is empty. Play something!', 'queue'));
      return;
    }
    if (player.context) panel.append(h('div.queue-context.muted.small', 'Playing from ', h('a', { href: player.context.href }, player.context.label)));
    const list = h('div.queue-list');
    drawn = { tracks: player.queue.slice(), context: player.context, list, rows: new Map(), index: player.index };
    shown = UPCOMING;
    const current = sync();
    panel.append(list);
    current?.row.scrollIntoView?.({ block: 'nearest' });
  }

  /** Ask for a rebuild; any number of asks in the same tick make one */
  function rebuild() {
    if (!isOpen() || pending) return;
    pending = true;
    queueMicrotask(build);
  }

  /** The queue or the current song may have changed (events 'queue' and 'track'): rebuild only if contents did */
  function refresh() {
    if (!isOpen() || pending) return;
    const d = drawn, queue = player.queue;
    if (!d || d.context !== player.context || d.tracks.length !== queue.length || queue.some((t, i) => t !== d.tracks[i])) return rebuild();
    for (const rec of d.rows.values()) if (rowKey(queue[rec.i]) !== rec.key) return rebuild();
    updateTransitions();
    if (d.index === player.index) return; // nothing moved: the second event of a handoff lands here
    stats.moves++;
    sync()?.row.scrollIntoView?.({ block: 'nearest' });
  }

  return { build, rebuild, refresh, stats };
}
