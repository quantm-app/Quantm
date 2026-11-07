// Trending: the charts (soundcloud.com/charts), overall or per genre
import * as api from '../api.js';
import { h } from '../dom.js';
import { player } from '../player.js';
import { pageHeader, trackList, button } from '../ui.js';

const slugOf = api.genreSlug;
const GENRES = api.GENRES;

export async function render(page, params) {
  const genre = params.genre ? GENRES.find(g => slugOf(g) === slugOf(params.genre)) : null;
  const title = genre || 'All music';
  const context = { label: genre ? `Trending: ${genre}` : 'Trending', href: '#/trending' + (genre ? '/' + slugOf(genre) : '') };

  const pager = genre ? api.popularByGenre(genre) : api.trending();
  const list = trackList(pager, { number: true, context, empty: 'No tracks found for this genre' });

  // make sure at least the first page is loaded before using list.tracks
  const tracksReady = async () => {
    if (!list.tracks.length && !pager.done) await list.loadMore();
    return list.tracks;
  };
  const playAll = async () => {
    const tracks = await tracksReady();
    if (tracks.length) player.playList(tracks, 0, list.context);
  };
  const shuffle = async () => {
    const tracks = await tracksReady();
    if (tracks.length) player.shufflePlay(tracks, list.context);
  };

  const chip = (label, href, active) => h('a.chip' + (active ? '.active' : ''), { href }, label);
  const chips = h('div.chips.trending-chips',
    chip('All', '#/trending', !genre),
    GENRES.map(g => chip(g, '#/trending/' + slugOf(g), g === genre))
  );

  page.append(
    pageHeader('Trending', {
      subtitle: genre ? `The most popular ${genre} tracks right now` : 'The most played tracks on SoundCloud this week',
      actions: [button('Play all', playAll, 'btn-primary', 'play'), button('Shuffle', shuffle, 'btn-outline', 'shuffle')]
    }),
    chips,
    h('h2.trending-heading', title),
    h('div.trending-list', list)
  );

  // keep the active chip in view when the chip row overflows
  const active = chips.querySelector('.chip.active');
  if (active && active.scrollIntoView) requestAnimationFrame(() => active.scrollIntoView({ block: 'nearest' }));
}
