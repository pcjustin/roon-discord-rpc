"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const RoonApi = require("node-roon-api");
const RoonApiStatus = require("node-roon-api-status");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiImage = require("node-roon-api-image");
const { Client: DiscordClient } = require("@xhayper/discord-rpc");
const { ActivityType } = require("discord-api-types/v10");

const origLog = console.log;
const origError = console.error;
console.log = (...args) => origLog(new Date().toISOString(), ...args);
console.error = (...args) => origError(new Date().toISOString(), ...args);

console.log("Roon Discord Presence starting, pid " + process.pid);

const CONFIG_FILE = path.join(__dirname, "config.json");

let config;
try {
    // The BOM strip is for Notepad, which saves UTF-8 with one and makes JSON.parse
    // throw on a file the user has no reason to think is wrong. The catch matters
    // because the launcher restarts this process every 15s: an unhandled read error
    // fills the log with the same stack trace instead of saying what to do about it.
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
} catch (err) {
    console.error("Could not read " + CONFIG_FILE + " - " + err.message);
    console.error("It must sit next to index.js and hold your Discord Application ID (see README.md).");
    process.exit(1);
}

// The Roon SDK's default persisted-state store is a relative "config.json" in the
// process's working directory - i.e. our own config file. It rewrites that file on
// every pairing, so any hiccup reading it (a BOM, a partial write) drops
// discordClientId and the next launch exits at the check below. Own state file,
// absolute path, no overlap.
const STATE_FILE = path.join(__dirname, "roonstate.json");

if (!config.discordClientId || config.discordClientId === "YOUR_DISCORD_APPLICATION_ID") {
    console.error("Set discordClientId in config.json first (see README.md).");
    process.exit(1);
}

let zones = {};
// Tracked independently of zones[id].now_playing.seek_position: the Roon SDK's own
// internal zone cache aliases the same objects our `zones` map stores (both are built
// from the same message), and the SDK mutates seek_position into that shared object
// before our subscribe_zones callback runs - so comparing against zones[id]'s own
// seek_position would always read the already-updated value, never a real "previous".
let lastKnownSeek = {};
let roonCore = null;
let discordReady = false;
let rpc;

// discord-rpc clients (this one included) cache their connect() promise forever
// (even on failure/close), so reusing one Client across retries would make every
// retry after the first a no-op. Recreating the Client each attempt gives each
// attempt a fresh connect() promise.
function connectDiscord() {
    rpc = new DiscordClient({ clientId: config.discordClientId, transport: "ipc" });

    rpc.on("ready", () => {
        discordReady = true;
        console.log("Connected to Discord.");
        schedulePresence();
    });

    rpc.on("disconnected", () => {
        discordReady = false;
        console.log("Discord connection closed, reconnecting in 15s...");
        setTimeout(connectDiscord, 15000);
    });

    rpc.login().catch((err) => {
        console.error("Discord connect failed, retrying in 15s:", err.message);
        setTimeout(connectDiscord, 15000);
    });
}

connectDiscord();

// --- Cover art: fetch the current track's image from Roon and serve it locally,
// then tunnel that local server out to a public HTTPS URL via cloudflared, since
// Discord's client fetches largeImageKey URLs itself and needs a public address.
const IMAGE_PORT = 47121;
// Keyed by image_key instead of a single "current image" slot: Discord fetches the
// URL on its own schedule, long after setActivity returns, so a mutable slot serves
// it whatever cover happens to be loaded at fetch time - which is how skipping
// tracks ended up pairing one track's art with another track's title.
const IMAGE_CACHE_MAX = 10;
const images = new Map(); // image_key -> { buffer, contentType }
let fetchingImageKey = null;
let fetchTimer = null;
let tunnelUrl = null;

const imageServer = http.createServer((req, res) => {
    const key = new URL(req.url, "http://127.0.0.1").searchParams.get("k");
    const img = key && images.get(key);
    if (!img) {
        res.writeHead(404);
        res.end();
        return;
    }
    res.writeHead(200, { "Content-Type": img.contentType, "Cache-Control": "no-store" });
    res.end(img.buffer);
});
imageServer.on("error", (err) => {
    // Doubles as a single-instance check: the launcher restarts this process, so a
    // second copy would otherwise respawn forever fighting the first over Discord.
    console.error("Image server could not listen on port " + IMAGE_PORT + " (already running?):", err.message);
    process.exit(1);
});
imageServer.listen(IMAGE_PORT, "127.0.0.1");

function startTunnel() {
    const cloudflaredPath = path.join(__dirname, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    const cloudflared = spawn(cloudflaredPath, ["tunnel", "--url", `http://127.0.0.1:${IMAGE_PORT}`]);
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    let spawnFailed = false;

    const onOutput = (data) => {
        const match = data.toString().match(urlRegex);
        if (match && !tunnelUrl) {
            tunnelUrl = match[0];
            console.log("Cover art tunnel ready:", tunnelUrl);
            schedulePresence();
        }
    };
    cloudflared.stdout.on("data", onOutput);
    cloudflared.stderr.on("data", onOutput);

    cloudflared.on("error", (err) => {
        spawnFailed = true;
        console.error("cloudflared failed to start (cover art will be unavailable):", err.message);
    });
    cloudflared.on("exit", (code) => {
        tunnelUrl = null;
        // Whether 'exit' fires after a failed spawn (missing binary) is unspecified by
        // Node and varies by platform/version, so spawnFailed makes the no-retry
        // decision explicit instead of relying on 'exit' simply not firing.
        if (spawnFailed) return;
        console.error("cloudflared exited (code " + code + "), restarting in 3s...");
        setTimeout(startTunnel, 3000);
    });
}
startTunnel();

// A null result is remembered as deliberately as a real image: updatePresence waits
// on the cover, so every failure path has to record an answer for the key. Leaving it
// unrecorded means the next updatePresence starts the same doomed fetch again and the
// presence never leaves the previous track.
function rememberImage(imageKey, value) {
    images.set(imageKey, value);
    if (images.size > IMAGE_CACHE_MAX) images.delete(images.keys().next().value);
}

function maybeFetchImage(imageKey) {
    if (!imageKey || !roonCore) return;
    if (fetchingImageKey === imageKey || images.has(imageKey)) return;
    fetchingImageKey = imageKey;
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(() => {
        if (fetchingImageKey !== imageKey) return;
        console.error("Cover image fetch timed out, showing track without art.");
        fetchingImageKey = null;
        rememberImage(imageKey, null);
        schedulePresence();
    }, 5000);
    roonCore.services.RoonApiImage.get_image(
        imageKey,
        { scale: "fit", width: 512, height: 512, format: "image/jpeg" },
        (err, contentType, image) => {
            // Only disarm our own timer: a late callback for a track already skipped
            // past would otherwise remove the safety net of the fetch that is currently
            // holding the presence back.
            if (fetchingImageKey === imageKey) {
                clearTimeout(fetchTimer);
                fetchingImageKey = null;
            }
            if (err) {
                console.error("Failed to fetch cover image:", err);
                rememberImage(imageKey, null);
            } else {
                rememberImage(imageKey, { buffer: image, contentType });
            }
            schedulePresence();
        }
    );
}

const roon = new RoonApi({
    extension_id: "com.pcjustin.roon_discord_presence",
    display_name: "Discord Rich Presence",
    display_version: "1.0.0",
    publisher: "Justin Lu",
    email: "pcjustin@icloud.com",
    get_persisted_state: () => {
        try {
            return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        } catch (e) {
            // Falls back to the SDK's old home so an existing pairing survives the move.
            return config.roonstate || {};
        }
    },
    set_persisted_state: (state) => {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 4));
    },
    core_paired: (core) => {
        console.log("Paired with Roon Core:", core.display_name);
        roonCore = core;
        core.services.RoonApiTransport.subscribe_zones((response, msg) => {
            if (response === "Subscribed") {
                zones = msg.zones.reduce((acc, z) => ((acc[z.zone_id] = z), acc), {});
                lastKnownSeek = msg.zones.reduce(
                    (acc, z) => ((acc[z.zone_id] = z.now_playing ? z.now_playing.seek_position : undefined), acc),
                    {}
                );
                schedulePresence();
            } else if (response === "Changed") {
                // A real track/state change resets what "expected" seek looks like for this
                // zone, so reset our tracking here rather than letting the next seek tick
                // compare against a stale pre-change value (which would look like a big jump).
                if (msg.zones_added) {
                    msg.zones_added.forEach((z) => {
                        zones[z.zone_id] = z;
                        lastKnownSeek[z.zone_id] = z.now_playing ? z.now_playing.seek_position : undefined;
                    });
                }
                if (msg.zones_changed) {
                    msg.zones_changed.forEach((z) => {
                        zones[z.zone_id] = z;
                        lastKnownSeek[z.zone_id] = z.now_playing ? z.now_playing.seek_position : undefined;
                    });
                }
                if (msg.zones_removed) {
                    msg.zones_removed.forEach((id) => {
                        delete zones[id];
                        delete lastKnownSeek[id];
                    });
                }

                // Roon also sends seek-only "Changed" messages (zones_seek_changed) roughly
                // once a second during normal playback - resending setActivity for every one
                // of those would waste Discord's RPC rate budget for no visible benefit, since
                // startTimestamp already lets Discord tick the elapsed time client-side. But a
                // manual seek (dragging the timeline) also arrives as zones_seek_changed, and
                // that DOES need to reach Discord so the elapsed time jumps to match. Tell the
                // two apart by how big the jump is: natural playback advances in small steps
                // (~1s per tick); a manual seek jumps by much more (or goes backward).
                let manualSeek = false;
                if (msg.zones_seek_changed) {
                    msg.zones_seek_changed.forEach((e) => {
                        const zone = zones[e.zone_id];
                        if (!zone || !zone.now_playing) {
                            console.log("Seek tick for unknown/non-playing zone:", e.zone_id, e.seek_position);
                            return;
                        }
                        const prevSeek = lastKnownSeek[e.zone_id] != null ? lastKnownSeek[e.zone_id] : e.seek_position;
                        const delta = Math.abs(e.seek_position - prevSeek);
                        const flagged = delta > 5;
                        if (flagged) {
                            manualSeek = true;
                            console.log(
                                "Manual seek detected:", zone.display_name,
                                "prev=" + prevSeek, "new=" + e.seek_position, "delta=" + delta
                            );
                        }
                        lastKnownSeek[e.zone_id] = e.seek_position;
                    });
                }

                if (msg.zones_added || msg.zones_changed || msg.zones_removed || manualSeek) {
                    schedulePresence();
                }
            }
        });
    },
    core_unpaired: (core) => {
        console.log("Unpaired from Roon Core:", core.display_name);
        roonCore = null;
        zones = {};
        lastKnownSeek = {};
        clearPresence();
    },
});

const svcStatus = new RoonApiStatus(roon);
roon.init_services({
    required_services: [RoonApiTransport, RoonApiImage],
    provided_services: [svcStatus],
});
svcStatus.set_status("Waiting for Roon Core...", false);

// Roon can emit a burst of closely-spaced zone-change events around a track
// transition (e.g. an intermediate state during a gapless/crossfade handoff,
// then the real new-track state). Sending setActivity for each one risks
// tripping Discord's RPC rate limit and losing the update that actually
// matters. Debouncing collapses a burst into a single call carrying the
// final state a moment later.
let presenceTimer = null;
function schedulePresence() {
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(updatePresence, 300);
}

// Discord rejects the whole SET_ACTIVITY payload if details/state/largeImageText is
// 1 character or longer than 128 - the update is dropped and the track never appears.
// Both ends occur in a real library: single-character CJK titles, and classical track
// names that run well past 128 characters.
function formatLine(line) {
    if (!line) return undefined;
    if (line.length === 1) return line + " ";
    return line.slice(0, 128);
}

function updatePresence() {
    // rpc.user is set from the READY dispatch's data.user, which is normally always
    // present for a local IPC login, but the library only sets it conditionally - so
    // guard against the rare case where it's absent, since rpc.user.setActivity would
    // otherwise throw synchronously (before .catch can attach) and crash the process.
    if (!discordReady || !rpc.user) return;

    const playing = Object.values(zones).find((z) => z.state === "playing" && z.now_playing);
    if (!playing) {
        clearPresence();
        return;
    }

    const imageKey = playing.now_playing.image_key;
    maybeFetchImage(imageKey);
    // Wait for the cover rather than sending an art-less update first: Discord
    // rate-limits setActivity, and two calls per track change means the second one -
    // the one carrying the new art - is the one that gets dropped.
    if (fetchingImageKey === imageKey) return;

    const line = playing.now_playing.three_line;
    const seek = playing.now_playing.seek_position || 0;

    const hasArt = Boolean(tunnelUrl && images.get(imageKey));
    console.log(
        "Presence update:", line.line1,
        "| image_key=" + imageKey,
        "| tunnelUrl=" + (tunnelUrl || "none"),
        "| hasArt=" + hasArt
    );

    const length = playing.now_playing.length;
    const start = Date.now() - seek * 1000;

    // type: Listening is what makes Discord render the Spotify-style progress bar
    // (elapsed/remaining with a slider) instead of plain "Playing" text - the old
    // discord-rpc package didn't expose an activity type at all, which is why this
    // wasn't achievable before switching to @xhayper/discord-rpc.
    rpc.user.setActivity({
        type: ActivityType.Listening,
        details: formatLine(line.line1),
        state: formatLine(line.line2),
        startTimestamp: start,
        endTimestamp: length ? start + length * 1000 : undefined,
        largeImageKey: hasArt ? `${tunnelUrl}/?k=${encodeURIComponent(imageKey)}` : undefined,
        largeImageText: formatLine(line.line3),
        instance: false,
    }).catch((err) => console.error("Failed to set Discord activity:", err.message));
}

function clearPresence() {
    if (!discordReady || !rpc.user) return;
    rpc.user.clearActivity().catch(() => {});
}

roon.start_discovery();
