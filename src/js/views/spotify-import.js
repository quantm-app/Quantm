// The "Import from Spotify" dialog: paste a link, watch the matching, then see what was found.
import * as api from '../api.js';
import * as local from '../local-playlists.js';
import { h, clear } from '../dom.js';
import { button, modal, toast } from '../ui.js';
import { matchSongs, playlistTitle, SPOTIFY_LIMIT } from '../spotify-import.js';

const lookups = {
  soundcloud: async (query) => (await api.search(query, 'tracks').next()).filter(t => t && t.kind === 'track'),
  audius: (query) => window.native.sources.audiusSearch(query),
  bandcamp: (query) => window.native.sources.bandcampSearch(query)
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function openSpotifyImport() {
  let cancelled = false;
  let running = false;
  const body = h('div.spotify-import');
  const dialog = modal('Import from Spotify', body, { onClose: () => { cancelled = true; } });

  const form = (message = '') => {
    const input = h('input.input', { placeholder: 'https://open.spotify.com/playlist/…', 'aria-label': 'Spotify playlist link' });
    const start = () => {
      if (running) return;
      run(input.value);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
    clear(body).append(
      h('p.muted', 'Paste the link to a public Spotify playlist. Quantm looks for each song on SoundCloud first, then Audius, then Bandcamp, and saves the result as a Quantm playlist on this PC.'),
      input,
      message ? h('p.import-error', message) : null,
      h('div.modal-actions', button('Cancel', () => dialog.close(), 'btn-ghost'), button('Import', start, 'btn-primary'))
    );
    setTimeout(() => input.focus(), 50);
  };

  const run = async (link) => {
    running = true;
    clear(body).append(h('p.muted', 'Reading the playlist from Spotify…'));
    let playlist;
    try {
      playlist = await window.native.sources.spotifyPlaylist(link);
    } catch (error) {
      playlist = { error: 'Couldn\'t reach Spotify. Check your internet connection and try again.' };
    }
    if (cancelled) return;
    if (!playlist || playlist.error) {
      running = false;
      return form(playlist?.error || 'Something went wrong reading that playlist.');
    }

    const status = h('div.import-status', 'Starting…');
    const song = h('div.muted.small.import-song');
    const counts = h('div.muted.small');
    const fill = h('div.import-bar-fill');
    clear(body).append(
      h('p.strong', playlist.name),
      status, h('div.import-bar', fill), song, counts,
      h('div.modal-actions', button('Cancel', () => dialog.close(), 'btn-ghost'))
    );

    const countsText = (c) => `SoundCloud ${c.soundcloud} · Audius ${c.audius} · Bandcamp ${c.bandcamp} · Not found ${c.unmatched}`;
    let result;
    try {
      result = await matchSongs(playlist.tracks, lookups, {
        cancelled: () => cancelled,
        onProgress: ({ done, total, song: current, counts: c }) => {
          status.textContent = done < total ? `Matching ${done + 1} of ${total}…` : 'Saving the playlist…';
          fill.style.width = Math.round(done / total * 100) + '%';
          song.textContent = current ? `${current.title} — ${current.artists}` : '';
          counts.textContent = countsText(c);
        }
      });
    } catch (error) {
      running = false;
      if (cancelled) return;
      return form(error.message || 'Something went wrong while matching songs.');
    }
    running = false;
    if (result.cancelled) return toast('Import cancelled');

    const saved = result.items.filter(item => item.track);
    if (!saved.length) return summary(playlist, result, null);
    try {
      const created = local.create(playlistTitle(playlist.name, local.list().map(p => p.title)), saved.map(item => item.track));
      summary(playlist, result, created);
    } catch (error) {
      form(error.message || 'Could not save the playlist.');
    }
  };

  const missingList = (heading, note, items) => items.length ? h('div.import-missing',
    h('h3', heading),
    note ? h('p.muted.small', note) : null,
    items.map(({ wanted }) => h('div.import-missing-row',
      h('span.import-missing-title', `${wanted.title} — ${wanted.artists}`),
      button('Search', () => {
        dialog.close();
        location.hash = '#/search?q=' + encodeURIComponent(`${wanted.artists.split(',')[0]} ${wanted.title}`.trim()) + '&tab=tracks';
      }, 'btn-sm')
    ))) : null;

  const summary = (playlist, result, created) => {
    const { counts } = result;
    const missing = result.items.filter(item => item.status === 'unmatched');
    const lines = [
      `${plural(counts.soundcloud, 'song', 'songs')} from SoundCloud`,
      `${plural(counts.audius, 'song', 'songs')} from Audius`,
      `${plural(counts.bandcamp, 'Bandcamp link', 'Bandcamp links')} (these open on Bandcamp, Quantm can't play them)`
    ];
    const notes = [];
    if (playlist.tracks.length >= SPOTIFY_LIMIT) notes.push(`Spotify only shares the first ${SPOTIFY_LIMIT} songs of a playlist, so only those were imported.`);
    if (result.trouble.audius) notes.push('Some Audius searches didn\'t work, so a few songs may have copies there that were missed.');
    if (result.trouble.bandcamp) notes.push('Some Bandcamp searches didn\'t work, so a few songs may have links there that were missed.');
    clear(body).append(
      h('p.strong', created ? `Saved "${created.title}" with ${plural(created.tracks.length, 'song', 'songs')}` : 'None of the songs could be found'),
      h('ul.import-summary', lines.map(line => h('li', line))),
      ...notes.map(note => h('p.muted.small', note)),
      missingList(`Couldn't find ${missing.filter(item => !item.locked).length}`, null, missing.filter(item => !item.locked)),
      missingList(`On SoundCloud, but Quantm can't play it: ${missing.filter(item => item.locked).length}`,
        'The label copy-protected these, or SoundCloud only has a 30-second preview, and no other copy turned up.',
        missing.filter(item => item.locked)),
      h('div.modal-actions',
        button('Close', () => dialog.close(), 'btn-ghost'),
        created ? button('Open playlist', () => { dialog.close(); location.hash = '#/qplaylist/' + created.id; }, 'btn-primary') : null)
    );
  };

  form();
  return dialog;
}
