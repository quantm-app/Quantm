// User profile (soundcloud.com/{user}): All, Popular tracks, Tracks, Albums, Playlists, Reposts, Likes, Followers, Following
import * as api from '../api.js';
import { h, onNearBottom, coverOf, artwork, compact, linkify, timeAgo } from '../dom.js';
import { icon } from '../icons.js';
import { player } from '../player.js';
import {
  hero, tabs, feedItem, trackList, staticTrackList, cardGrid, userList, shelf, spinner, emptyState, errorState,
  button, iconButton, followButton, likeButton, repostButton, playButton, avatar, link, toast, userHref, playlistHref, applyPlaylistCover } from '../ui.js';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'popular', label: 'Popular tracks' },
  { id: 'tracks', label: 'Tracks' },
  { id: 'albums', label: 'Albums' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'reposts', label: 'Reposts' },
  { id: 'likes', label: 'Likes' },
  { id: 'followers', label: 'Followers' },
  { id: 'following', label: 'Following' }
];

export async function render(page, params) {
  const id = params.id;
  const user = await api.user(id);
  const tab = TABS.find(t => t.id === params.tab) ? params.tab : 'all';
  const base = userHref(user);
  const tabHref = (tid) => tid === 'all' ? base : `${base}/${tid}`;
  const context = (tid, label) => ({ label: `${user.username}${label ? ' · ' + label : ''}`, href: tabHref(tid) });

  page.append(
    profileHero(user, context('all')),
    tabs(TABS.map(t => ({ id: t.id, label: t.label, href: tabHref(t.id) })), tab)
  );

  const cleanups = [];
  const scroller = document.getElementById('view');
  const name = user.username;

  if (tab === 'all') {
    cleanups.push(await renderAll(page, user, tabHref, context));
  } else if (tab === 'popular') {
    page.append(trackList(api.userTopTracks(id), { context: context('popular', 'Popular tracks'), number: true, empty: `${name} has no popular tracks yet` }));
  } else if (tab === 'tracks') {
    const feed = trackFeed(api.userTracks(id), { context: context('tracks', 'Tracks'), empty: `${name} hasn't uploaded any tracks yet` });
    page.append(feed.el);
    await feed.first;
    cleanups.push(onNearBottom(scroller, feed.loadMore));
  } else if (tab === 'albums') {
    page.append(cardGrid(api.userAlbums(id), { empty: `${name} has no albums yet` }));
  } else if (tab === 'playlists') {
    page.append(cardGrid(api.userPlaylists(id), { empty: `${name} has no playlists yet` }));
  } else if (tab === 'reposts') {
    const feed = trackFeed(api.userReposts(id), { context: context('reposts', 'Reposts'), empty: `${name} hasn't reposted anything yet` });
    page.append(feed.el);
    await feed.first;
    cleanups.push(onNearBottom(scroller, feed.loadMore));
  } else if (tab === 'likes') {
    page.append(cardGrid(api.userLikes(id), { context: context('likes', 'Likes'), empty: `${name} hasn't liked anything yet` }));
  } else if (tab === 'followers') {
    page.append(userList(api.userFollowers(id), { empty: `${name} has no followers yet` }));
  } else if (tab === 'following') {
    page.append(userList(api.userFollowings(id), { empty: `${name} isn't following anyone yet` }));
  }

  return () => cleanups.forEach(fn => typeof fn === 'function' && fn());
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function profileHero(user, playContext) {
  const banner = user.visuals && user.visuals.visuals && user.visuals.visuals[0] && user.visuals.visuals[0].visual_url;
  const place = [user.city, user.country_code || user.country].filter(Boolean).join(', ');
  const subtitle = [user.full_name && user.full_name !== user.username ? user.full_name : null, place].filter(Boolean).join(' · ');

  // "Play" starts their popular tracks (or latest uploads when they have none)
  let queue = null;
  let fetching = false;
  const play = async () => {
    if (player.context && player.context.href === playContext.href && player.current) return player.toggle();
    if (fetching) return; // a second click while the songs are still loading
    if (!queue) {
      fetching = true;
      try {
        let list = await api.userTopTracks(user.id).next();
        if (!list.length) list = await api.userTracks(user.id).next();
        queue = list.filter(t => t.kind === 'track');
      } catch (error) {
        return toast('Couldn\'t load tracks', 'error');
      } finally {
        fetching = false;
      }
    }
    if (!queue.length) return toast(`${user.username} has no tracks to play`);
    player.playList(queue, 0, playContext);
  };

  const el = hero({
    image: artwork(user.avatar_url, 't500x500'),
    round: true,
    banner: banner || null,
    eyebrow: 'Artist',
    title: [user.username, user.verified ? h('span.user-verified', icon('verified', 28)) : null],
    subtitle: subtitle || null,
    meta: [
      h('span', icon('users', 14), ' ', compact(user.followers_count), ' followers'),
      h('span', compact(user.followings_count), ' following'),
      h('span', icon('feed', 14), ' ', compact(user.track_count), ' tracks')
    ],
    actions: [
      button('Play', play, 'btn-primary', 'play'),
      user.station_urn ? button('Station', () => { location.hash = '#/station/' + encodeURIComponent(user.station_urn); }, 'btn-outline', 'station') : null,
      followButton(user),
      iconButton('link', 'Copy link', () => { window.native.copy(user.permalink_url); toast('Link copied'); }),
      iconButton('external', 'Open on SoundCloud', () => window.native.openExternal(user.permalink_url))
    ]
  });
  el.classList.add('user-hero');
  if (banner) el.classList.add('banner');
  return el;
}

// ---------------------------------------------------------------------------
// "All" tab
// ---------------------------------------------------------------------------

async function renderAll(page, user, tabHref, context) {
  const id = user.id;
  const safe = (promise, fallback) => promise.catch(() => fallback);

  const recent = trackFeed(api.userTracks(id), { context: context('tracks', 'Tracks'), empty: `${user.username} hasn't uploaded any tracks yet` });
  const [popular, spotlight] = await Promise.all([
    safe(api.userTopTracks(id).next(), []),
    safe(api.get(`users/${id}/spotlight`).then(data => (data.collection || []).map(i => i.track || i.playlist || i).filter(i => i && i.kind)), []),
    recent.first
  ]);

  const main = h('div.user-main');

  if (spotlight.length) {
    main.append(shelf('Spotlight', spotlight, { context: context('all', 'Spotlight') }));
  }

  if (popular.length) {
    const top = popular.slice(0, 5);
    main.append(h('section.user-section',
      h('div.section-title', h('span', 'Popular tracks'), popular.length > 5 ? h('a.small', { href: tabHref('popular') }, 'See all') : null),
      staticTrackList(top, { number: true, context: context('popular', 'Popular tracks') })
    ));
  }

  main.append(h('section.user-section',
    h('div.section-title', h('span', 'Recent tracks'), h('a.small', { href: tabHref('tracks') }, 'See all')),
    recent.el
  ));

  page.append(h('div.with-sidebar', main, sidebar(user, tabHref, context)));
  return onNearBottom(document.getElementById('view'), recent.loadMore);
}

function sidebar(user, tabHref, context) {
  const stat = (label, value, href) => h('a.user-stat', { href },
    h('div.user-stat-label', label),
    h('div.user-stat-value', compact(value || 0)));

  const box = h('aside.sidebar.user-sidebar',
    h('div.user-stats',
      stat('Followers', user.followers_count, tabHref('followers')),
      stat('Following', user.followings_count, tabHref('following')),
      stat('Tracks', user.track_count, tabHref('tracks'))
    ),
    bioSection(user),
    linksSection(user),
    likesSection(user, tabHref, context),
    followingSection(user, tabHref)
  );
  return box;
}

/** Bio with a Show more toggle */
function bioSection(user) {
  if (!user.description || !user.description.trim()) return h('div.hidden');
  const text = user.description.trim();
  const long = text.length > 280 || text.split('\n').length > 5;
  const body = h('div.description.selectable' + (long ? '.clamped' : ''), { html: linkify(text) });
  // external links go to the system browser
  body.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a) { e.preventDefault(); window.native.openExternal(a.href); }
  });
  const toggle = long ? h('button.link-btn.user-more', {
    onclick: () => { toggle.textContent = body.classList.toggle('clamped') ? 'Show more' : 'Show less'; }
  }, 'Show more') : null;
  return h('section', h('div.sidebar-title', h('span', 'About')), body, toggle);
}

/** Links the user added to their profile (instagram, website...) */
function linksSection(user) {
  const box = h('section.hidden', h('div.sidebar-title', h('span', 'Links')));
  const list = h('div.user-links');
  box.append(list);
  api.get(`users/${user.id}/web-profiles`).then((profiles) => {
    const shown = (Array.isArray(profiles) ? profiles : []).filter(p => p && p.url).slice(0, 8);
    shown.forEach((p) => {
      list.append(h('a.user-ext', {
        href: p.url,
        onclick: (e) => { e.preventDefault(); window.native.openExternal(p.url); }
      }, icon('link', 14), h('span', p.title || p.network || p.url)));
    });
    if (shown.length) box.classList.remove('hidden');
  }).catch(() => {});
  return box;
}

function likesSection(user, tabHref, context) {
  const box = h('section.hidden', h('div.sidebar-title', h('span', 'Likes'), h('a', { href: tabHref('likes') }, 'View all')));
  const list = h('div');
  box.append(list);
  api.userLikes(user.id).next().then((items) => {
    const tracks = items.filter(i => i.kind === 'track');
    tracks.slice(0, 3).forEach((t, i) => list.append(miniTrack(tracks, i, context('likes', 'Likes'))));
    if (tracks.length) box.classList.remove('hidden');
  }).catch(() => {});
  return box;
}

function followingSection(user, tabHref) {
  const box = h('section.hidden', h('div.sidebar-title', h('span', 'Following'), h('a', { href: tabHref('following') }, 'View all')));
  const grid = h('div.user-following');
  box.append(grid);
  api.userFollowings(user.id).next().then((users) => {
    users.slice(0, 12).forEach((u) => {
      grid.append(h('a.user-following-item', { href: userHref(u), title: u.username }, avatar(u, 52)));
    });
    if (users.length) box.classList.remove('hidden');
  }).catch(() => {});
  return box;
}

/** Compact track line for the sidebar */
function miniTrack(tracks, index, context) {
  const track = tracks[index];
  const art = coverOf(track, 't67x67');
  const row = h('div.mini-user.user-mini', { style: { cursor: 'pointer' } },
    h('div.track-art', { style: { width: '44px', height: '44px', backgroundImage: art ? `url("${art}")` : '' } }),
    h('div', { style: { minWidth: 0, flex: 1 } },
      h('div.muted.small', track.user ? track.user.username : ''),
      h('a.mini-user-name', { href: '#/track/' + track.id, style: { display: 'block' }, onclick: (e) => e.stopPropagation() }, track.title)
    )
  );
  row.addEventListener('click', () => player.toggleOrPlay(tracks, index, context));
  return row;
}

// ---------------------------------------------------------------------------
// Infinite track feed (big waveform cards). Handles plain tracks and stream items (reposts)
// ---------------------------------------------------------------------------

function trackFeed(pager, { context, empty }) {
  const feed = h('div.feed');
  const spin = spinner();
  const tracks = [];  // every track so far, in order: the play queue
  const items = [];   // stream items matching `tracks` (null for plain tracks)

  const loadMore = async () => {
    if (pager.done) return;
    try {
      const batch = await pager.next();
      for (const entry of batch) {
        const track = entry.kind === 'track' ? entry : entry.track;
        if (track) {
          tracks.push(track);
          items.push(entry.kind === 'track' ? null : entry);
          feed.append(feedItem(tracks, tracks.length - 1, { items, context }));
        } else if (entry.playlist) {
          feed.append(playlistFeedCard(entry));
        }
      }
      if (!feed.children.length && pager.done) feed.append(emptyState(empty));
    } catch (error) {
      feed.append(errorState(error));
      pager.done = true;
    }
    if (pager.done) spin.remove();
  };

  const first = loadMore().then(async () => {
    // a short first page might not fill the screen
    if (!pager.done && feed.children.length < 6) await loadMore();
  });
  return { el: h('div', feed, spin), loadMore, first };
}

/** A playlist or album reposted/posted on a profile */
function playlistFeedCard(item) {
  const playlist = item.playlist;
  const href = playlistHref(playlist);
  const reposted = item.type && item.type.endsWith('repost');
  const cover = coverOf(playlist);
  let full = null;
  const getTracks = async () => {
    if (!full) full = await api.playlist(playlist.id);
    return full.tracks;
  };

  const card = h('article.feed-card',
    h('div.feed-header',
      reposted ? icon('repost', 14) : null,
      item.user ? link(userHref(item.user), item.user.username) : null,
      reposted ? ' reposted a ' : ' posted a ',
      playlist.is_album ? 'album' : 'playlist',
      item.created_at ? h('span.muted', ' · ' + timeAgo(item.created_at)) : null
    ),
    h('div.feed-body',
      h('a.feed-art', { href, style: { backgroundImage: cover ? `url("${cover}")` : '' } }),
      h('div.feed-content',
        h('div.feed-top',
          playButton(() => full ? full.tracks : getTracks(), 0, { label: playlist.title, href }, 'play-btn.play-btn-lg'),
          h('div.feed-titles',
            playlist.user ? link(userHref(playlist.user), playlist.user.username, 'muted') : null,
            h('a.feed-title', { href }, playlist.title)
          ),
          h('div.feed-right', h('span.tag-pill', `${playlist.track_count} tracks`))
        ),
        h('div.feed-actions',
          likeButton(playlist, { withCount: true }),
          repostButton(playlist, { withCount: true }),
          h('div.spacer'),
          button('View all', () => { location.hash = href; }, 'btn-ghost.btn-sm')
        )
      )
    )
  );
  applyPlaylistCover(card.querySelector('.feed-art'), playlist);
  return card;
}
