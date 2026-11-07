// Last.fm counts only time spent listening, not seeks or pauses.
export function createScrobbler({ nowPlaying, scrobble }) {
  let current = null, listened = 0, sent = false, lastTime = null, lastWall = null, started = 0, announced = false;
  const reset = track => { current = track; listened = 0; sent = false; lastTime = lastWall = null; started = 0; announced = false; };
  const metadata = duration => ({ artist: current?.user?.username, track: current?.title, duration, timestamp: started });
  return {
    track(track) {
      if (!track || !current || track.id !== current.id) reset(track);
      else current = track;
    },
    state(playing, duration, now = Date.now()) {
      lastTime = lastWall = null;
      if (playing && current && !announced) { started = Math.floor(now / 1000); announced = true; nowPlaying(metadata(duration)); }
    },
    time(position, duration, playing, now = Date.now()) {
      if (!current) return;
      if (!playing) { lastTime = lastWall = null; return; }
      if (!announced) { started = Math.floor(now / 1000); announced = true; nowPlaying(metadata(duration)); }
      if (lastTime !== null && position < 3 && lastTime - position > 5) reset(current);
      if (lastWall !== null && lastTime !== null) {
        const wall = (now - lastWall) / 1000, media = position - lastTime;
        // Ignore discontinuities, buffering and delayed updates.
        if (wall > 0 && wall <= 5 && media > 0 && media <= 5) listened += wall;
      }
      const length = duration > 0 ? duration : (current.duration || 0) / 1000;
      if (!sent && length > 30 && listened >= Math.min(length / 2, 240)) {
        sent = true;
        scrobble(metadata(length));
      }
      lastTime = position; lastWall = now;
    }
  };
}

export function initLastfm(player) {
  const submit = (method, track) => window.native.lastfm.submit(method, track).catch(() => {});
  const tracker = createScrobbler({
    nowPlaying: track => submit('track.updateNowPlaying', track),
    scrobble: track => submit('track.scrobble', track)
  });
  tracker.track(player.current);
  player.on('track', track => tracker.track(track));
  player.on('state', () => tracker.state(player.playing, player.duration));
  player.on('time', (time, duration) => tracker.time(time, duration, player.playing));
}
