# Quantm | SoundCloud Desktop Client

> A successor to [Soundnode](https://github.com/Soundnode/soundnode-app), rebuilt from scratch.

A sleek, themeable SoundCloud desktop client for Windows, macOS and Linux.

**🚫 No ads.** No audio ads between songs, no banners, and no promoted tracks in your feed. Free and open source.


[**Download Quantm**](https://github.com/quantm-app/Quantm/releases/latest)

📱 **On Android?** Get [**Quantm for Android**](https://github.com/quantm-app/Quantm-Android/releases/latest), a native phone app with background playback, the same themes and Quantm playlists you can move between phone and desktop.

🎚️ **New: Auto mix.** Quantm can blend your songs like a DJ, beat-matched and bass-swapped, and it learns your songs and your taste as it goes. Off by default, find it in Settings → Auto mix.

![Quantm SoundCloud desktop client showing the glass theme, music library, and playback controls](docs/images/quantm-home.png)

![Quantm switching between themes, a track page and Album Match](docs/images/quantm-demo.gif)

## Features

**Listening**

- **Auto mix.** DJ-style transitions, off by default (Settings → Auto mix). Quantm finds each song's tempo and beat, starts the next song on the beat, matches tempos (half and double time too), and hands over the bass, mids and highs like a DJ with a mixer. Once a song has been heard, mixes start and end on whole phrases (8, 16 or 32 bars). Songs without a clear beat get a normal blend.
- **Smarter endings.** Quantm also reads each song's key (clashing keys get a shorter blend), keeps two singers from overlapping, and when a song ends abruptly it loops the last clean bars or adds an echo so the next song can come in. These work best once Quantm has heard a song before.
- **Genre-aware transitions.** Set Settings → Auto mix → Transition style to Auto and Quantm picks one to fit the pair: a quick cut for hip-hop, a double drop for drum and bass or dubstep, a slow filter fade for deep house and ambient, or a drop cut for energetic electronic songs. Smooth blend stays the default.
- **Auto mix learns.** It remembers every song it plays (tempo, beat, where the drums come in, where the outro starts) so later mixes go over the real outro. It also learns your taste: keeping a song nudges future mixes toward that style, and the thumbs up or down that appears after a mix teaches it what you liked, separately for each genre family and tempo range. Reset it any time in Settings → Auto mix.
- **Live Auto mix page.** Settings → Auto mix shows what it hears, the planned mix and a countdown, the beat lock in milliseconds, what it has learned per tempo range, and an activity feed.
- **Mix order.** With Auto mix on, the shuffle button (or S) cycles off, shuffle and Mix order, which sorts your queue like a DJ set so each song blends into the next, scoring tempo, key and how your past mixes went. Right-click a track and choose "Mix from here" to start a set from it. Autoplay picks the related songs that blend best, and the queue shows each blend ("122 → 124 BPM").
- **Offline downloads.** Tracks whose artist allows downloads can be saved in the artist's original format and played without internet from Library → Offline. Other tracks can't be downloaded.
- **Listening stats.** See your hours, plays, streaks, top tracks, artists and genres by week, month or year, earn badges, and save a shareable stats card as an image. Everything is counted on your computer and never uploaded.
- **No ads, ever.** No audio ads, banners or promoted posts. Just your music.
- **Sign in inside the app.** Log in with your SoundCloud account in a built-in sign-in window, or enter your oauth_token manually if that doesn't work (the client_id is optional, Quantm finds one). Your token is stored encrypted on your computer.
- **Home with personalized shelves.** Recently played, mixes, "more of what you like", stations and trending picks, all picked for you.
- **Feed.** New posts and reposts from the people you follow.
- **Library.** Your likes, playlists, albums, stations, listening history and who you follow.
- **Trending charts.** See what's popular across all music, or browse 30 genres.
- **Full search.** Find tracks, people, albums and playlists, with suggestions as you type. Paste any soundcloud.com link to jump straight to it.
- **Artist profiles.** Popular tracks, tracks, albums, playlists, reposts, likes, followers and following, plus the artist's bio. Start a station of the artist's sound in one click.
- **Track pages.** Full waveform, timed comments (post and delete your own), related tracks, and who liked or reposted. Click the cover art to see it at its original size.
- **Quantm playlists.** Playlists saved on this computer with instant adds and removes, drag to reorder, and JSON export/import to move them between computers. Copy any SoundCloud playlist into Quantm with one click. Not synced to SoundCloud.
- **Import from Spotify.** In Library → Quantm, paste the link to a public Spotify playlist (its first 100 songs) and Quantm saves it as a Quantm playlist. It can't play from Spotify: it finds each song on SoundCloud first, then Audius, then Bandcamp (Bandcamp ones only open on Bandcamp). Some SoundCloud copies are 30-second previews or copy-protected, and those are listed instead of added.
- **Playlist editing.** Create, rename, make private or public, delete, drag to reorder, and remove tracks.
- **Stations.** Start a station based on any track or artist.
- **Notifications.** Likes, reposts, comments and new followers.
- **Like, repost and follow from anywhere.** No need to visit the artist's page first.

**Player**

- **High-quality HLS streaming.** Smooth, high-quality playback of SoundCloud's streams.
- **Add to playlist from the player bar.** Save the track that's playing in one click.
- **Queue.** See what's next, drag tracks to reorder them, play next, or add to the queue.
- **Shuffle and repeat.** Shuffle loads your whole collection first, so even a 1,000-song Likes list shuffles from all of it. Repeat all or repeat one.
- **Autoplay.** Related tracks keep playing when your queue runs out.
- **Crossfade.** Blend from one song into the next, from 0 to 12 seconds.
- **Cue points and custom transitions.** Press C to bookmark a moment and 1–9 to jump to a cue. Set mix-in and mix-out with I and O, or right-click a waveform. Edit and rename markers from the track menu, or choose exact leave/start times and a fade for each pair in the queue. Custom transitions work even with crossfade off.
- **Playback speed.** Nightcore and Slowed modes, or a custom speed with optional pitch keeping. Change it with the speed button in the player bar.
- **Volume normalization.** Loud and quiet tracks play at a similar level. Each song keeps its own level during a crossfade, songs Quantm hasn't heard yet start at your usual level, and small corrections glide instead of jumping.
- **Equalizer.** Five bands plus preamp, with presets like Bass boost, Vocal, Electronic and Late night (Settings → Playback, or the EQ button in the player bar).
- **Sleep timer.** Stop after 15 to 90 minutes or at the end of the song, with a gentle fade out (moon button in the player bar).
- **Resume where you left off.** Reopen the app to your last song, queue and position, paused.
- **Automatic updates.** The installer version downloads new releases in the background and installs them when you restart or close Quantm. The portable and Linux .deb versions tell you when a new version is out. Turn automatic downloads off in Settings → About.
- **Media keys and system controls.** Use your keyboard's media keys and the Windows and macOS media controls. Desktop notifications show when a new track starts.
- **Keyboard shortcuts.** Space to play or pause, arrows to seek, Ctrl+arrows to skip or change volume, M to mute, L to like, S to shuffle, R to repeat, Ctrl+F or Ctrl+K to search, Alt+arrows, Ctrl/Cmd+[ and ], your mouse's side buttons or a Mac trackpad swipe to go back and forward, and `Shift+<` / `Shift+>` for speed.

**Make it yours**

- **Theme presets.** Color-only themes: SoundCloud Dark, SoundCloud Light, Midnight, Synthwave, Forest and Mono, plus color families with several flavors on one card: Tokyo Night (Night, Storm, Day), Rosé Pine (Main, Moon, Dawn), Gruvbox (Dark, Light), Sodium (Underpass, Blue Hour, Last Tram), Nord (Dark, Light) and Catppuccin (Latte, Frappé, Macchiato and Mocha). Full style makeovers that also change shapes, fonts and textures: Y2K (Windows XP and early iTunes), Glass, Neon, Pixel, Minimal, Liquid Glass, Liquid Glass Dark, Hextech, OLED (pure black), E-ink, Industrial, Frutiger Aero, Terminal, Windows 98, Vinyl, Brutalist, Risograph, Chrome, Rave Flyer, Blueprint, Ink Wash, LED Board, Tiling, Glitch, Vapor Mall, Felt and Album Match (the whole palette follows the playing song's artwork). The theme gallery groups them into Colors, Makeovers and Theme packs.
- **Overhaul themes.** Themes that change the whole experience, not just the look: **Listening Room** turns Home into a stage with giant artwork and soft light from the cover that breathes with the music; **Pocket Quantm** is a retro handheld player with a working click wheel; **Terminal Multiplexer** is a workstation of resizable panes, an ASCII spectrum, an event log and a `:` command prompt. Newer theme packs react to the music, and most reshape Home: **Twin Deck** (two turntables that show Auto mix at work), **Cassette**, **Holo Card**, **Sunrise**, **Signal Route** (your queue as a transit map), **Sampler** (a pad grid of your queue), **Patchbay**, **Contour** (a terrain map unique to each song), **Spectral Ledger** (a scrolling spectrogram) and **Warehouse** (a rave spectrum wall). Themes can follow Auto mix too: the beat, the mix progress and the bass swap. Motion and music-reactive lighting follow Settings → Appearance → Theme effects (Auto, On or Off) and stay off in Performance mode.
- **Custom themes.** Edit every color and the corner roundness, copy a theme to share it or import one, or try the random theme generator.
- **Day and night schedule.** Switch between a day theme and a night theme automatically.
- **See-through window.** With Liquid Glass, your desktop shows through the app, blurred, on Windows and macOS. On Windows 11 you can also try the native Acrylic or Mica styles (Settings → Appearance → Window). Drag the see-through window to a screen edge to snap it: top to maximize, sides for half the screen, corners for a quarter.
- **Layout.** Top bar or sidebar navigation, player bar at the top or bottom, compact density, and the option to hide play counts and genre tags.
- **Backgrounds.** Use your own picture or the playing song's artwork, with dimming and blur.
- **Matching accent color.** The accent color follows the artwork of the song that's playing.
- **Font and zoom.** Pick a font and zoom the app from 70% to 150%.
- **Waveform styles.** Bars, mirrored, smooth line or blocks, with adjustable thickness.
- **Player-bar visualizer.** Six styles: bars, mirrored bars, wave, line, circle and dots. Colors can come from the theme, your accent, a rainbow or your own pair. Adjust the bar count, size, sensitivity, smoothness, falling peaks, glow and left, center or right position.
- **Exact values.** Every slider has a number box, so you can type in the precise value you want.

**Extras**

- **Discord status.** Show "Listening to Quantm" with the song, artist, artwork and a progress bar, plus a "Listen on SoundCloud" button. While nothing is playing, your status stays up as "Playing Quantm" (Browsing, or Paused and the song) with a Get Quantm button; turn that off with Settings → Playback → Discord status while not playing. Needs the Discord desktop app, and you can turn it off.
- **Crash logs.** If Quantm crashes, Settings → About → Open crash logs shows what happened. Logs stay on your computer, and you can attach crash.log to a GitHub issue.
- **Performance page.** Live CPU and memory readouts, Performance mode (no blur or animations, and on by itself while a game is fullscreen on Windows), visuals paused while minimized, and a hardware acceleration switch. Light enough to leave running while you game.
- **Remembers your setup.** Your themes and settings carry over every time you restart, and survive updates: Quantm keeps a backup and restores anything that went missing.
- **Installers for every platform.** Windows Setup (recommended) and a portable version, plus macOS `.dmg` for Apple Silicon and Intel, and Linux AppImage and `.deb` packages.

## Download

Grab the latest build from the [**Releases** page](https://github.com/quantm-app/Quantm/releases/latest):

- **Windows:** `Quantm-Setup-x.y.z.exe` ⭐ **recommended**: installs Quantm with Start Menu and Desktop shortcuts, starts fastest, and can be uninstalled from Windows Settings.
  - `Quantm-x.y.z-Portable.exe`: runs without installing, handy for trying it out or on PCs where you can't install apps. It starts a little slower, and your settings are still saved on that PC.
- **macOS:** `.dmg` disk image — `-arm64.dmg` for Apple Silicon (M1 and newer) or `-x64.dmg` for Intel Macs.
- **Linux:** the `AppImage` (runs anywhere) or the `.deb` package (Debian and Ubuntu).
- **Android:** `Quantm-x.y.z.apk` from the [Quantm for Android releases](https://github.com/quantm-app/Quantm-Android/releases/latest). Open it on your phone and allow installs when Android asks.

Or install with a package manager on Windows:

```powershell
scoop bucket add quantm https://github.com/quantm-app/Quantm
scoop install quantm/quantm
```

`winget install drumplayer1234.Quantm` will work once Quantm is approved in the winget catalog.

### "Windows protected your PC"?

Quantm's installer isn't digitally signed yet, so Windows SmartScreen may warn you the first time you run it. This is normal for new open-source apps. To continue:

1. Click **More info** in the blue window.
2. Click **Run anyway**.

You only need to do this once. On macOS, if you see "Quantm can't be opened because it is from an unidentified developer", right-click the app, choose **Open**, then click **Open** again.

## Signing in

1. Click **Sign in with SoundCloud**.
2. Log in the way you normally would, including with Google, Apple or Facebook if you use those.
3. Quantm closes the sign-in window once it's connected.

Your login token is stored on your computer, encrypted with Electron's `safeStorage` where your operating system supports it. It is only ever sent to SoundCloud.

If the sign-in window doesn't work for you, choose **Enter a token manually** on the sign-in screen. You'll need two values from your browser's developer tools while signed in at soundcloud.com:

- The value of the `oauth_token` cookie.
- The `client_id`, a 32-character string that appears in SoundCloud's API requests.

## Build from source

You'll need [Node.js](https://nodejs.org/) 18 or newer (Node 20 is what the release builds use).

```bash
npm install        # install dependencies
npm start          # run Quantm from source
```

To create installers:

```bash
npm run dist         # build for the current operating system
npm run dist:win     # Windows installer and portable build
npm run dist:mac     # macOS .dmg
npm run dist:linux   # Linux AppImage and .deb
```

Output goes to the `dist/` folder.

## Project structure

```
main.js                 Electron main process: windows, sign-in, token storage, API proxy
preload.js              The only bridge between the app page and the main process
src/
  index.html            App shell
  vendor/hls.min.js     hls.js, for HLS streams (Apache-2.0)
  js/
    app.js              Startup, login screen, app shell, keyboard shortcuts
    api.js              SoundCloud api-v2 client
    player.js           Audio playback, queue and HLS streams
    playerbar.js        The player bar at the bottom of the window
    store.js            App state: likes, playlists, following and more
    theme.js            Theme engine: presets, custom colors, import and export
    router.js           Hash-based router
    ui.js               Shared UI components
    dom.js              Small DOM helpers
    icons.js            Icon set
    views/              One module per page (home, feed, library, search, ...)
  styles/
    app.css             Base styles, layout and theme variables
    views/              Styles for each page
```

## Limitations

- **Some label songs can't play in Quantm.** A number of major-label songs on SoundCloud are copy-protected (DRM) and only play in SoundCloud's official app and website. Quantm can't play them, even if you pay for SoundCloud Go. They're marked with a lock icon, are skipped in the queue, and have an **Open in SoundCloud** button so you can play them there.

## Code signing

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org). See the [code signing policy](CODE_SIGNING.md) for what is signed, who approves it, and the privacy policy.

## Disclaimer

Quantm is an unofficial project. It is not affiliated with, endorsed by, or sponsored by SoundCloud.

Quantm uses SoundCloud's web API, which SoundCloud can change or restrict at any time. If that happens, parts of the app may stop working until it's updated.

Please respect the artists whose music you listen to, and follow SoundCloud's terms of use.

The Hextech theme is fan-made and inspired by League of Legends. It is not endorsed by Riot Games. League of Legends and Riot Games are trademarks of Riot Games, Inc.

## Credits

- The original **Soundnode** was created by Michael Lancaster and contributors. This project is a fork and rewrite of [soundnode-app](https://github.com/Soundnode/soundnode-app).
- [hls.js](https://github.com/video-dev/hls.js) by Dailymotion, licensed under Apache-2.0, plays HLS streams.
- Built on [Electron](https://www.electronjs.org/).

## Contributing

Bug reports, feature ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

Quantm is free software licensed under the [GNU General Public License v3.0](LICENSE). You can redistribute it and/or modify it under the terms of that license.
