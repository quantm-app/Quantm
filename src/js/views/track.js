// Track page: hero with waveform, artist, description, comments and a related sidebar
// (soundcloud.com/artist/track). Sub-routes: #/track/:id/likes and #/track/:id/reposts
import * as api from '../api.js';
import { h, onNearBottom, coverOf, artwork, compact, duration, timeAgo, linkify } from '../dom.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { player } from '../player.js';
import {
  hero, spinner, emptyState, errorState, link, userHref, playlistHref, pageHeader, avatar, button,
  iconButton, likeButton, repostButton, followButton, playButton, waveform, userList, trackMenu,
  addToPlaylistDialog, toast, confirmDialog, go, downloadButton
} from '../ui.js';

const fmtDate = (date) => date
  ? new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  : '';

/** 'techno "deep house" ambient' -> ['techno', 'deep house', 'ambient'] */
function parseTags(text) {
  const tags = [];
  String(text || '').replace(/"([^"]+)"|(\S+)/g, (m, quoted, single) => { tags.push(quoted || single); return m; });
  return tags;
}

export async function render(page, params) {
  const id = params.id;
  const track = await api.track(id);
  if (params.tab === 'likes' || params.tab === 'reposts') return renderPeople(page, track, params.tab);

  const href = '#/track/' + track.id;
  const context = { label: track.title, href };
  const isMine = !!(store.me && track.user && track.user.id === store.me.id);

  // --- hero with waveform
  const wave = waveform(track, { height: 90, onPlay: () => player.playList([track], 0, context) });
  const heroEl = hero({
    image: artwork(coverOf(track, 't500x500'), 't500x500'),
    eyebrow: track.genre ? '# ' + track.genre : 'Track',
    title: track.title,
    subtitle: track.user ? link(userHref(track.user), track.user.username) : null,
    meta: [
      track.display_date || track.created_at ? h('span', fmtDate(track.display_date || track.created_at)) : null,
      track.playback_count != null ? h('span.stat', { title: 'Plays' }, icon('play', 13), compact(track.playback_count)) : null,
      track.likes_count != null ? h('span.stat', { title: 'Likes' }, icon('heart', 13), compact(track.likes_count)) : null,
      track.reposts_count != null ? h('span.stat', { title: 'Reposts' }, icon('repost', 13), compact(track.reposts_count)) : null,
      track.comment_count != null ? h('span.stat', { title: 'Comments' }, icon('comment', 13), compact(track.comment_count)) : null,
      h('span', duration(track.full_duration || track.duration))
    ],
    actions: [
      playButton(() => [track], 0, context, 'play-btn.play-btn-xl'),
      downloadButton(track, { labeled: true }),
      likeButton(track, { withCount: true }),
      repostButton(track, { withCount: true }),
      button('Add to playlist', () => addToPlaylistDialog(track), 'btn-sm', 'addToPlaylist'),
      track.station_urn ? button('Start station', () => go('#/station/' + encodeURIComponent(track.station_urn)), 'btn-sm', 'station') : null,
      iconButton('link', 'Copy link', () => { window.native.copy(track.permalink_url); toast('Link copied'); }),
      iconButton('external', 'Open on SoundCloud', () => window.native.openExternal(track.permalink_url)),
      iconButton('more', 'More', (e) => trackMenu(track, e, {}))
    ]
  });
  heroEl.append(h('div.track-hero-wave', wave));

  // --- main column
  const commentsSection = commentsBlock(track, wave, context, isMine);
  const main = h('div.track-main-col',
    track.user ? artistCard(track.user) : null,
    descriptionBlock(track),
    tagsBlock(track),
    licenseBlock(track),
    commentsSection.el
  );
  const sidebar = h('aside.sidebar', relatedSection(track), playlistsSection(track), peopleSection(track, 'likes'), peopleSection(track, 'reposts'));

  page.append(heroEl, h('div.with-sidebar', main, sidebar));
  return commentsSection.start();
}

// ---------------------------------------------------------------------------
// Likes / reposts sub-pages
// ---------------------------------------------------------------------------

function renderPeople(page, track, tab) {
  const likes = tab === 'likes';
  page.append(
    h('a.btn.btn-ghost.btn-sm.track-back', { href: '#/track/' + track.id }, icon('back', 16), h('span', 'Back to track')),
    pageHeader(likes ? 'Likes' : 'Reposts', { subtitle: track.title }),
    userList(likes ? api.trackLikers(track.id) : api.trackReposters(track.id), { empty: likes ? 'No likes yet' : 'No reposts yet' })
  );
}

// ---------------------------------------------------------------------------
// Main column blocks
// ---------------------------------------------------------------------------

function artistCard(user) {
  return h('div.track-artist',
    h('a', { href: userHref(user) }, avatar(user, 72)),
    h('div.track-artist-meta',
      h('a.track-artist-name', { href: userHref(user) }, user.username, user.verified ? icon('verified', 14) : null),
      h('div.muted.small', icon('users', 12), ' ', compact(user.followers_count), ' followers')
    ),
    followButton(user)
  );
}

function descriptionBlock(track) {
  if (!track.description || !track.description.trim()) return null;
  const long = track.description.length > 400 || track.description.split('\n').length > 6;
  const text = h('div.description' + (long ? '.clamped' : ''), { html: linkify(track.description) });
  const toggle = long ? h('button.track-more', {
    onclick: () => {
      const clamped = text.classList.toggle('clamped');
      toggle.textContent = clamped ? 'Show more' : 'Show less';
    }
  }, 'Show more') : null;
  return h('section.track-section', text, toggle);
}

function tagsBlock(track) {
  const tags = parseTags(track.tag_list);
  if (track.genre && !tags.some(t => t.toLowerCase() === track.genre.toLowerCase())) tags.unshift(track.genre);
  if (!tags.length) return null;
  return h('section.track-section.track-tags',
    tags.map(tag => h('a.tag-pill', { href: '#/search?q=' + encodeURIComponent(tag) + '&tab=tracks' }, '#' + tag)));
}

function licenseBlock(track) {
  if (!track.license || track.license === 'all-rights-reserved') return null;
  const label = track.license.replace(/^cc-/, 'CC ').replace(/-/g, ' ').toUpperCase();
  return h('div.track-license.muted.small', 'License: ', label);
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function commentsBlock(track, wave, context, isMine) {
  const pager = api.trackComments(track.id);
  const list = h('div.comments');
  const spin = spinner();
  const loaded = [];
  let total = track.comment_count || 0;
  const heading = h('h2.track-comments-title');
  const setHeading = () => { heading.textContent = total === 1 ? '1 comment' : `${compact(total)} comments`; };
  setHeading();

  const isThis = () => player.current && player.current.id === track.id;

  const commentEl = (comment) => {
    const mine = store.me && comment.user && (comment.user.id === store.me.id || isMine);
    const row = h('div.comment',
      comment.user ? h('a', { href: userHref(comment.user) }, avatar(comment.user, 40)) : avatar(null, 40),
      h('div.comment-body',
        h('div.comment-head',
          comment.user ? h('a', { href: userHref(comment.user) }, comment.user.username) : null,
          comment.timestamp != null
            ? h('span', { class: 'muted' }, 'at ', h('span.comment-time', { title: 'Play from here', onclick: () => seekTo(comment.timestamp) }, duration(comment.timestamp)))
            : null,
          h('span.muted', timeAgo(comment.created_at))
        ),
        h('div.comment-text', { html: linkify(comment.body) })
      ),
      mine ? iconButton('trash', 'Delete comment', async () => {
        if (!(await confirmDialog('Delete comment', 'This comment will be removed permanently.', 'Delete', true))) return;
        try {
          await api.deleteComment(track.id, comment.id);
          row.remove();
          const at = loaded.indexOf(comment);
          if (at > -1) loaded.splice(at, 1);
          wave.setComments(loaded);
          total = Math.max(0, total - 1);
          setHeading();
        } catch (e) {
          toast("Couldn't delete the comment", 'error');
        }
      }, 'track-comment-delete') : null
    );
    return row;
  };

  // click on a comment time: seek if this track is playing, otherwise start it there
  const seekTo = async (ms) => {
    const seconds = ms / 1000;
    if (isThis()) {
      player.seek(seconds);
      player.play();
      return;
    }
    await player.playTrack(track, context);
    if (player.audio.readyState >= 1) player.seek(seconds);
    else player.audio.addEventListener('loadedmetadata', () => { if (isThis()) player.seek(seconds); }, { once: true });
  };

  // comment box
  let box = null;
  if (track.commentable === false) {
    box = h('div.muted.small.track-comments-off', 'Comments are turned off for this track.');
  } else if (store.me) {
    const input = h('input.input', { placeholder: 'Write a comment', maxLength: 300 });
    const post = button('Post', async () => {
      const body = input.value.trim();
      if (!body) return input.focus();
      post.disabled = true;
      const ms = isThis() ? player.audio.currentTime * 1000 : 0;
      try {
        const created = await api.postComment(track.id, body, ms);
        if (!created.user) created.user = store.me;
        if (created.timestamp == null) created.timestamp = Math.round(ms);
        if (!created.created_at) created.created_at = new Date().toISOString();
        loaded.unshift(created);
        list.prepend(commentEl(created));
        wave.setComments(loaded);
        total++;
        setHeading();
        input.value = '';
      } catch (e) {
        toast("Couldn't post your comment", 'error');
      }
      post.disabled = false;
    }, 'btn-primary');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') post.click(); });
    box = h('div.comment-box', avatar(store.me, 40), input, post);
  }

  const loadMore = async () => {
    if (pager.done) return;
    try {
      const batch = await pager.next();
      batch.forEach((comment) => { loaded.push(comment); list.append(commentEl(comment)); });
      wave.setComments(loaded);
      if (!loaded.length && pager.done) list.append(emptyState('Be the first to comment', 'comment'));
    } catch (error) {
      list.append(errorState(error));
      pager.done = true;
    }
    if (pager.done) spin.remove();
  };

  return {
    el: h('section.track-section.track-comments', heading, box, list, spin),
    start: async () => {
      await loadMore();
      return onNearBottom(document.getElementById('view'), loadMore);
    }
  };
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function sidebarBox(title, hrefAll) {
  const body = h('div');
  const box = h('section.hidden',
    h('div.sidebar-title', h('span', title), hrefAll ? h('a', { href: hrefAll }, 'View all') : null),
    body
  );
  return { box, body };
}

function relatedSection(track) {
  const { box, body } = sidebarBox('Related tracks');
  const context = { label: 'Related tracks', href: '#/track/' + track.id };
  api.relatedTracks(track.id).next().then((tracks) => {
    if (!tracks.length) return;
    tracks.slice(0, 5).forEach((t, i) => body.append(miniTrack(tracks, i, context)));
    box.classList.remove('hidden');
  }).catch(() => {});
  return box;
}

function miniTrack(tracks, index, context) {
  const t = tracks[index];
  const cover = coverOf(t, 't67x67');
  const row = h('div.track-mini',
    h('div.track-mini-art', { style: { backgroundImage: cover ? `url("${cover}")` : '' } }, h('div.track-mini-play', icon('play', 16))),
    h('div.track-mini-meta',
      link(userHref(t.user), t.user ? t.user.username : '', 'muted small'),
      h('a.track-mini-title', { href: '#/track/' + t.id, onclick: (e) => e.stopPropagation() }, t.title),
      h('div.track-mini-stats', t.playback_count != null ? h('span.stat', icon('play', 11), compact(t.playback_count)) : null,
        t.likes_count != null ? h('span.stat', icon('heart', 11), compact(t.likes_count)) : null)
    )
  );
  row.addEventListener('click', () => player.toggleOrPlay(tracks, index, context));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(t, e, {}); });
  return row;
}

function playlistsSection(track) {
  const { box, body } = sidebarBox('In playlists');
  api.trackInPlaylists(track.id).next().then((playlists) => {
    if (!playlists.length) return;
    playlists.slice(0, 3).forEach((pl) => {
      const cover = coverOf(pl, 't67x67');
      body.append(h('a.track-mini', { href: playlistHref(pl) },
        h('div.track-mini-art', { style: { backgroundImage: cover ? `url("${cover}")` : '' } }, cover ? null : icon('playlist', 20)),
        h('div.track-mini-meta',
          h('div.muted.small', pl.user ? pl.user.username : ''),
          h('div.track-mini-title', pl.title),
          h('div.muted.small', `${pl.track_count} tracks`)
        )
      ));
    });
    box.classList.remove('hidden');
  }).catch(() => {});
  return box;
}

function peopleSection(track, kind) {
  const likes = kind === 'likes';
  const count = likes ? track.likes_count : track.reposts_count;
  const { box, body } = sidebarBox(likes ? 'Likes' : 'Reposts', '#/track/' + track.id + '/' + kind);
  box.querySelector('.sidebar-title span').textContent = count ? `${likes ? 'Likes' : 'Reposts'} · ${compact(count)}` : (likes ? 'Likes' : 'Reposts');
  const pager = likes ? api.trackLikers(track.id) : api.trackReposters(track.id);
  pager.next().then((users) => {
    if (!users.length) return;
    body.append(h('div.track-faces', users.slice(0, 9).map(u =>
      h('a.track-face', { href: userHref(u), title: u.username }, avatar(u, 40)))));
    box.classList.remove('hidden');
  }).catch(() => {});
  return box;
}
