**🚫 No ads**: no audio ads, banners or promoted tracks. Free and open source.

## What's new in 1.2.3

- **Import a Spotify playlist.** In Library → Quantm, press "Import from Spotify", paste the link to a public Spotify playlist, and Quantm saves it as a Quantm playlist on your computer. Quantm can't play from Spotify, so it looks for each song on SoundCloud first, then Audius, then Bandcamp. You get a summary of what it found where, and a Search button for the songs it couldn't find. Some limits: Spotify only shares the first 100 songs of a playlist, Bandcamp matches only open on Bandcamp (Quantm can't play them), and some SoundCloud copies are only 30-second previews or copy-protected, so those are listed separately instead of being added. Audius and Bandcamp songs get a small tag wherever they show up.
- **Mix order sorts by how well songs blend.** Mix order (the shuffle button, or S, with Auto mix on) now scores each possible transition instead of just matching tempos. Songs in the same key blend better and clashing keys count against a pair, and so does a pair you rated badly before. "Mix from here" in the right-click menu and Autoplay pick songs the same way.
- **Auto mix swaps bass, mids and highs.** A blend now hands over all three, like a DJ with a mixer: the new song's bass and highs stay out until it is time, the bass swaps halfway, and the two songs never play their mids (singing, lead sounds) at full level at the same time.
- **Mixes land on the phrase.** Once Quantm has heard where a song's first drums come in, a mix starts on a whole phrase of the old song (8 bars) and lasts 8, 16 or 32 bars, and the new song enters on its own first bar, so the two line up the way a DJ counts them.
- **Key matching.** Quantm now works out each song's key while it plays. When two songs clash, the blend is shorter and the bass and mids hand over earlier, so the clash is over quickly.
- **No two singers at once.** If both songs have vocals where they would overlap, Quantm starts the blend later, or keeps the new song's mids down until the old singer is done.
- **Better endings.** When a song stops dead or its drums stop early, Auto mix can repeat the last clean bars of the song to make room for the blend (up to four times), or add an echo to the last phrase and bring the next song in under it.
- **Genre-aware Auto mix.** With Settings → Auto mix → Transition style set to Auto, Quantm picks a transition to fit the pair: a quick cut on the first beat for hip-hop, a double drop for drum and bass or dubstep when both songs' drops are known and the tempos match, a slow filter fade for deep house, ambient and other slow, quiet music, and a drop cut for energetic electronic songs with a clear drop. Everything else stays a smooth blend. Smooth blend is still the default. The vocal, key and echo handling above works best once Quantm has heard a song before; it learns each song the first time it plays.
- **Performance mode while gaming.** On Windows, Quantm turns Performance mode on by itself while a game (or any other app) is fullscreen, and off again afterwards. Turn it off in Settings → Performance → Performance mode while gaming.
- **Twin Deck shows the new transitions.** The Twin Deck theme pack now labels quick cuts, drop cuts, double drops and filter fades.
- **Fixes.** SoundCloud's "prove you're human" check now opens in a small window and Quantm carries on once you pass it, instead of just failing. Plus a round of smaller bug fixes.

## What's new in 1.2.2

- **Side player.** A new player position puts the whole player in a panel on the right: big artwork, the song and artist, the waveform, all the controls, likes, reposts, tags and the description. Turn it on in Settings → Appearance → Player position → Side. It works in every theme, and in windows narrower than 980 pixels the normal bar comes back.
- **Drop cut transitions for Auto mix.** A club-style transition next to the smooth blend: the old song's bass gets filtered out over its last few bars, a loop roll speeds up on the beat with an echo tail, then the next song slams in right on its drop. Quantm finds each song's drop from its waveform, checks it on the real audio before the mix, and remembers it. Pick it in Settings → Auto mix → Transition style: Smooth blend (the default), Auto (drop cuts for energetic electronic songs with a clear drop) or Drop cut. Pressing Next during the build cuts straight to the drop. Drop cuts skip the next song's intro, which is why Smooth blend stays the default.
- **More reliable smooth blends.** Beat detection at the end of a song now looks for the part with drums instead of one fixed stretch, so fewer mixes fall back to "no clear beat". Fewer songs are read at half or double their tempo.
- **Support Quantm.** Settings → About has a link to Quantm's Ko-fi, if you'd like to chip in. Quantm stays free.

## What's new in 1.2.1

- **Smoother on high refresh rate screens.** With Auto mix on, Quantm could drop frames and stutter, especially with the queue open on Liquid Glass and other glass themes. Fixed: it now does far less work per frame, and the visualizer draws at up to 60 frames a second.

## What's new in 1.2.0

- **Auto mix.** Quantm can now blend your songs like a DJ. It's off by default: turn it on in Settings → Auto mix, or in Settings → Playback → Crossfade.
- **Beat-matched transitions.** Quantm listens to each song's kick and snare to find its tempo and beat, quietly pre-plays the next song for a few seconds to learn it, then starts it on the beat. It matches tempos up to 8% apart (half and double time too, like 87 into 174 BPM) and keeps the beats locked through the mix.
- **The blend.** The next song comes up with its bass cut, the bass swaps over one bar in the middle, then the old song fades out. Mixes last 16, 32 or 64 beats, up to 24 seconds. Songs without a clear beat get a normal blend.
- **It learns your songs.** Every song it plays is remembered: tempo, beat, where the drums come in and where the outro starts. Later mixes go over the real outro and land the next song's drums on the bass swap. Until a song has been heard, Quantm guesses its tempo from SoundCloud's BPM field, the title, tags or description, or failing those, its waveform.
- **It learns your taste.** Each mix tries a small variation of length, blend style and tempo stretch, separately for slow, mid, fast and very fast music. Keep the song and it nudges toward that. Skip during or right after the mix and it nudges away. It's slow by design, and Settings → Auto mix has a reset.
- **Watch it work.** Settings → Auto mix shows it live: what it hears, the planned mix and a countdown, the beat lock in milliseconds, what it has learned per tempo range, and an activity feed.
- **Mix order.** With Auto mix on, the shuffle button (or S) cycles off, shuffle and Mix order. Mix order sorts your queue like a DJ set, so each song blends into the next. "Mix from here" in a track's right-click menu starts a set from that song, Autoplay picks the related songs that blend best, and the queue shows each blend ("122 → 124 BPM").
- **Smoother volume between songs.** Each song keeps its own loudness during a crossfade, so the old song no longer gets louder or quieter as it fades. Songs Quantm hasn't heard before start at your usual level instead of full volume, and small corrections glide instead of jumping.
- **New color themes.** Tokyo Night (Night, Storm, Day), Rosé Pine (Main, Moon, Dawn), Gruvbox (Dark, Light), Sodium (Underpass, Blue Hour, Last Tram), Nord (Dark, Light) and Catppuccin (Latte, Frappé, Macchiato, Mocha). Each family is one card, and you pick the flavor with swatches.
- **New makeovers.** Risograph (two-color zine print), Chrome (hyperpop liquid chrome), Rave Flyer (photocopied 90s flyer), Blueprint (engineering drawing), Ink Wash (Paper and Night), LED Board (dot-matrix display in Amber, Green or Red), Tiling (tiling-window desktop), Glitch (datamosh), Vapor Mall (vaporwave) and Felt (soft and tactile, in Moss or Burgundy).
- **New theme packs.** They go beyond colors and react to the music, and most reshape Home: Twin Deck (two turntables that show Auto mix at work), Cassette, Holo Card, Sunrise, Signal Route (your queue as a transit map), Sampler (a 4x4 pad grid of your queue), Patchbay, Contour (a terrain map unique to each song), Spectral Ledger (a scrolling spectrogram) and Warehouse (a rave spectrum wall).
- **Themes react to Auto mix.** Themes can follow the beat, the mix progress and the bass swap. The theme gallery is also tidier, with sections for Colors, Makeovers and Theme packs.
- **Discord status while idle.** "Playing Quantm" stays up while the app is open, showing Browsing, or Paused and the song, plus a Get Quantm button. Turn it off in Settings → Playback → Discord status while not playing.
- **Crash logs.** If Quantm crashes, Settings → About → Open crash logs shows what happened. Logs stay on your computer, and you can attach crash.log to a GitHub issue.
- **The player bar fits narrow and zoomed-in windows.**
- **Tip:** if animated themes stand still, Windows animations are probably off. Settings → Appearance → Theme effects → On turns them on for Quantm.

## What's new in 1.1.7

- **Easier manual sign-in.** If the normal sign-in doesn't work for you, "Enter a token manually" now only needs your oauth_token. Leave the client_id empty and Quantm finds one itself.

## What's new in 1.1.6

- **See-through window on Windows 11** stays see-through after you minimize Quantm and bring it back, instead of turning black.

## What's new in 1.1.5

- **Player bar buttons work in smaller windows.** In windows narrower than about 1180 pixels (common on laptops with display scaling), the speed, EQ and more buttons didn't respond to clicks. Fixed for every theme.
- **See-through window on Windows 11** no longer turns black after maximizing.
- **Snap to screen edges in see-through mode.** Drag Quantm to the top of the screen to maximize it, to a side for half the screen, or to a corner for a quarter.

## What's new in 1.1.4

- **Shuffle really covers everything.** Shuffling Likes or a big playlist now loads the whole list first, so even the first song can come from anywhere in it.
- **Artist stations.** Start a station from any artist page.
- **Back and forward on Mac.** Cmd+[ and Cmd+], trackpad swipes, and mouse side-button tools like Sensible Side Buttons now work.
- **Full-size artwork.** Click the big cover on a track, playlist or artist page to see it at its original size.

## What's new in 1.1.3

- **Quantm has a new home:** https://github.com/quantm-app/Quantm. Old links still work, and updates keep arriving automatically.

## What's new in 1.1.2

- **Your settings stay put through updates.** If Quantm was still open when an update installed, recent changes to your theme and settings could be lost. Quantm now keeps a backup of them and restores anything that went missing.

## What's new in 1.1.1

- **Quantm playlists.** Playlists saved on your computer with instant adds and removes, drag to reorder, and export/import. Copy any SoundCloud playlist into Quantm with one click.
- **Equalizer and sleep timer.** A 5-band equalizer with presets, and a sleep timer that fades out after a set time or at the end of the song.
- **Listening stats.** Hours, plays, streaks, top tracks, artists and genres, badges, and a shareable stats card. Counted on your computer only.
- **Overhaul themes:** Listening Room, Pocket Quantm and Terminal Multiplexer, plus Theme effects (Auto/On/Off) in Settings → Appearance.
- **New makeover themes:** Brutalist, Vinyl, Frutiger Aero, Terminal and Windows 98.
- **Intel Macs** get their own download next to Apple Silicon.
- Quantm can no longer open off-screen or invisible, and copy-protected songs show a lock with **Open in SoundCloud** everywhere.

## What's new in 1.1

- **Automatic updates.** From now on Quantm updates itself (Settings → About). Coming from 1.0.x? Install this version once with the Setup file below; after that, updates arrive on their own.
- **Cue points and custom DJ transitions.** Press **O** where a song should mix out and **I** where the next one should come in, or edit any transition from the queue. Press **C** to add cue points and **1–9** to jump to them.
- **Offline downloads.** Tracks whose artist allows downloads can be saved in the original quality and played with no internet (Library → Offline).
- **New themes:** Hextech, OLED, E-ink, Industrial and Album Match (the whole app takes its colors from the song's artwork).
- **Windows 11:** the see-through Liquid Glass window now works, with Acrylic and Mica options and rounded corners.
- **Copy-protected label songs** are marked with a lock and have an **Open in SoundCloud** button (Quantm can't play those).
- Queue fixes, better security, starting without internet no longer signs you out, and lower memory use.

## Which file should I download?

- **Windows:** `Quantm-Setup-VERSION.exe` ⭐ **recommended** — installs Quantm with shortcuts and an uninstaller.
  - `Quantm-VERSION-Portable.exe` — runs without installing (starts a little slower).
- **macOS:** the `.dmg` disk image: `Quantm-VERSION-arm64.dmg` for Apple Silicon (M1 and newer) or `Quantm-VERSION-x64.dmg` for Intel Macs.
- **Linux:** the `.AppImage` (runs anywhere) or the `.deb` (Debian/Ubuntu)

Windows may show "Windows protected your PC" because the installer isn't signed yet: click **More info → Run anyway**.
