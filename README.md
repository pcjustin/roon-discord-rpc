# Roon Discord Presence

Connects to your Roon Core and mirrors the currently playing track (title, artist, a live progress bar, and album art) to your Discord Rich Presence, shown as a "Listening to" status on your Discord profile.

## Prerequisites

- Windows
- [Node.js 20 or later](https://nodejs.org/) installed
- [Git](https://git-scm.com/download/win) installed (needed by `npm install` to fetch Roon's SDK packages from GitHub)
- Roon Core reachable on the same network
- Discord desktop app installed

## One-time setup

1. Get a Discord Application ID:
   - Go to https://discord.com/developers/applications and log in with your Discord account.
   - Click **New Application**, give it a name (this name is shown in the Rich Presence branding), and create it.
   - On the **General Information** page, copy the **Application ID** (a long number).
   - No OAuth, bot, or verification setup is needed - just the ID.
   - Open `config.json` and paste it in place of `YOUR_DISCORD_APPLICATION_ID`.
2. Double-click `install.bat`. It installs dependencies, downloads `cloudflared.exe` (used for album art, see below), and sets the app to start automatically every time you log into Windows.
3. Open the Roon desktop app, go to **Settings > Extensions**, and enable **Discord Rich Presence** the first time it appears. This one-time pairing step is required by Roon's own extension security model and can't be skipped or automated.

That's it. After this setup, you never need to run anything manually again. The app starts silently in the background whenever you log into Windows, and it picks up automatically as soon as both Roon and Discord happen to be running - the order doesn't matter.

## About album art

Discord fetches the Rich Presence image from a **public URL** (Discord's own servers fetch it, not the viewer's client), but Roon's cover art only exists on your own Roon Core with no public URL. So this app:

1. Fetches the current track's cover image from Roon.
2. Serves it from a small local web server.
3. Uses [cloudflared](https://github.com/cloudflare/cloudflared) (Cloudflare's own tool, downloaded automatically by `install.bat`, no account needed) to open a free temporary tunnel, turning that local address into a public `https://xxxx.trycloudflare.com` URL that Discord can fetch.

This URL is randomly generated and changes every time the app restarts. Anyone who knows the URL can see your currently playing track's cover art while the app is running (just the image itself, nothing else is exposed). If you'd rather not do this, delete `cloudflared.exe` from the folder - title/artist/elapsed time keep working, you just won't get cover art.

## Checking it's working / troubleshooting

Look at `roon-discord.log` in this folder. It logs pairing status, Discord connection state, and retry attempts (e.g. Discord IPC retries every 15s if Discord isn't running yet, cloudflared retries every 3s if it drops).

## Uninstalling

Run `uninstall.bat`. This removes the startup launcher only.

Optionally also:
- Remove the extension from Roon's **Settings > Extensions** list.
- Delete this project folder.
