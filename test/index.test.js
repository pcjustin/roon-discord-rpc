"use strict";

// index.js is a daemon with no exports: it connects to Discord, spawns cloudflared and
// opens a port the moment it is required. So it is loaded once here against fake
// modules and a fake clock, and driven through the same callbacks Roon and Discord
// would call. Everything stays synchronous - tick() is the only way time passes.

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const fs = require("fs");
const os = require("os");
const path = require("path");

let now = 0;
let nextTimerId = 1;
const timers = new Map();
globalThis.setTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + (ms || 0), fn });
    return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);

function tick(ms) {
    const target = now + ms;
    for (;;) {
        let due = null;
        for (const [id, t] of timers) {
            if (t.at <= target && (!due || t.at < due.timer.at)) due = { id, timer: t };
        }
        if (!due) break;
        now = due.timer.at;
        timers.delete(due.id);
        due.timer.fn();
    }
    now = target;
}

const captured = {
    roonOpts: null,
    requestHandler: null,
    discord: null,
    activities: [],
    clears: 0,
    imageRequests: [],
    tunnelOutput: null,
    zonesCb: null,
};

function FakeRoonApi(opts) {
    captured.roonOpts = opts;
}
FakeRoonApi.prototype.init_services = () => {};
FakeRoonApi.prototype.start_discovery = () => {};

function FakeRoonApiStatus() {}
FakeRoonApiStatus.prototype.set_status = () => {};

class FakeDiscordClient {
    constructor() {
        this.handlers = {};
        this.user = {
            setActivity: (activity) => {
                captured.activities.push(activity);
                return Promise.resolve();
            },
            clearActivity: () => {
                captured.clears += 1;
                return Promise.resolve();
            },
        };
        captured.discord = this;
    }
    on(event, fn) {
        this.handlers[event] = fn;
    }
    login() {
        return Promise.resolve();
    }
}

const fakes = {
    "node-roon-api": FakeRoonApi,
    "node-roon-api-status": FakeRoonApiStatus,
    "node-roon-api-transport": "TRANSPORT",
    "node-roon-api-image": "IMAGE",
    "@xhayper/discord-rpc": { Client: FakeDiscordClient },
    "discord-api-types/v10": { ActivityType: { Listening: 2 } },
    http: {
        createServer(handler) {
            captured.requestHandler = handler;
            return { listen() {}, on() {} };
        },
    },
    child_process: {
        spawn() {
            return {
                stdout: { on: (_e, fn) => (captured.tunnelOutput = fn) },
                stderr: { on() {} },
                on() {},
            };
        },
    },
};

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "roon-discord-test-"));
const CONFIG = { discordClientId: "1234567890" };
fs.copyFileSync(path.join(__dirname, "..", "index.js"), path.join(appDir, "index.js"));
fs.writeFileSync(path.join(appDir, "config.json"), JSON.stringify(CONFIG, null, 2));

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return origLoad.call(this, request, ...rest);
};
console.log = () => {};
console.error = () => {};
require(path.join(appDir, "index.js"));
Module._load = origLoad;

const TUNNEL = "https://test-tunnel.trycloudflare.com";
const core = {
    display_name: "Test Core",
    services: {
        RoonApiTransport: { subscribe_zones: (cb) => (captured.zonesCb = cb) },
        RoonApiImage: {
            get_image: (key, opts, cb) => captured.imageRequests.push({ key, cb, done: false }),
        },
    },
};

captured.discord.handlers.ready();
captured.tunnelOutput(Buffer.from("INF |  " + TUNNEL + "  |"));
captured.roonOpts.core_paired(core);
captured.zonesCb("Subscribed", { zones: [] });
tick(1000);

function playing(zoneId, imageKey, title, artist) {
    return {
        zone_id: zoneId,
        display_name: "Living Room",
        state: "playing",
        now_playing: {
            image_key: imageKey,
            seek_position: 0,
            length: 240,
            three_line: { line1: title, line2: artist, line3: "Some Album" },
        },
    };
}

function playTrack(zone) {
    captured.zonesCb("Changed", { zones_changed: [zone] });
    tick(300);
}

function pendingFetch(imageKey) {
    return captured.imageRequests.find((r) => r.key === imageKey && !r.done);
}

function fetchCount(imageKey) {
    return captured.imageRequests.filter((r) => r.key === imageKey).length;
}

function deliverImage(imageKey, body) {
    const req = pendingFetch(imageKey);
    assert.ok(req, "expected a pending image fetch for " + imageKey);
    req.done = true;
    req.cb(null, "image/jpeg", Buffer.from(body));
    tick(300);
}

function failImage(imageKey) {
    const req = pendingFetch(imageKey);
    assert.ok(req, "expected a pending image fetch for " + imageKey);
    req.done = true;
    req.cb("image fetch failed");
    tick(300);
}

function serve(url) {
    const res = { status: 0, headers: null, body: null };
    captured.requestHandler(
        { url },
        {
            writeHead: (status, headers) => {
                res.status = status;
                res.headers = headers;
            },
            end: (body) => (res.body = body),
        }
    );
    return res;
}

function fetchArt(activity) {
    assert.ok(activity.largeImageKey, "activity carries no cover art URL");
    assert.ok(activity.largeImageKey.startsWith(TUNNEL), "cover art URL is not the tunnel URL");
    return serve(activity.largeImageKey.slice(TUNNEL.length));
}

function lastActivity() {
    return captured.activities[captured.activities.length - 1];
}

function reset() {
    captured.activities.length = 0;
    captured.clears = 0;
}

// Every test uses fresh image keys: the app caches covers by key for the process's
// lifetime, and it is loaded once for the whole file.

test("cover art is served per image key, never whichever cover was fetched last", () => {
    reset();
    playTrack(playing("z1", "art-1", "Track One", "Artist One"));
    deliverImage("art-1", "COVER-ONE");
    playTrack(playing("z1", "art-2", "Track Two", "Artist Two"));
    deliverImage("art-2", "COVER-TWO");

    assert.strictEqual(serve("/?k=art-1").body.toString(), "COVER-ONE");
    assert.strictEqual(serve("/?k=art-2").body.toString(), "COVER-TWO");
    assert.strictEqual(serve("/?k=never-fetched").status, 404);
    assert.strictEqual(serve("/").status, 404);
});

test("a track change sends one activity, and it already carries the cover", () => {
    reset();
    playTrack(playing("z1", "art-3", "Track Three", "Artist Three"));
    assert.strictEqual(captured.activities.length, 0, "sent an art-less activity before the cover arrived");

    deliverImage("art-3", "COVER-THREE");
    assert.strictEqual(captured.activities.length, 1, "sent more than one activity for one track change");
    assert.strictEqual(lastActivity().details, "Track Three");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-THREE");
});

test("a failed cover fetch still updates the track, without art, and is not retried", () => {
    reset();
    playTrack(playing("z1", "art-4", "Track Four", "Artist Four"));
    failImage("art-4");

    assert.strictEqual(lastActivity().details, "Track Four");
    assert.strictEqual(lastActivity().largeImageKey, undefined);
    assert.strictEqual(fetchCount("art-4"), 1, "retried a cover fetch that had already failed");
});

test("a cover fetch that never answers times out and the track still reaches Discord", () => {
    reset();
    playTrack(playing("z1", "art-5", "Track Five", "Artist Five"));
    assert.strictEqual(captured.activities.length, 0);

    tick(5000);
    tick(300);
    assert.strictEqual(lastActivity().details, "Track Five");
    assert.strictEqual(lastActivity().largeImageKey, undefined);
    assert.strictEqual(fetchCount("art-5"), 1, "restarted the timed-out fetch instead of giving up");
});

test("a late cover from a skipped-past track leaves the current track's timeout armed", () => {
    reset();
    playTrack(playing("z1", "art-6", "Track Six", "Artist Six"));
    playTrack(playing("z1", "art-7", "Track Seven", "Artist Seven"));
    deliverImage("art-6", "COVER-SIX");

    assert.strictEqual(captured.activities.length, 0, "showed a skipped-past track");

    tick(5000);
    tick(300);
    assert.strictEqual(lastActivity().details, "Track Seven", "presence stuck waiting on a fetch with no timeout");
    assert.strictEqual(lastActivity().largeImageKey, undefined);
});

test("skipping back shows the previous track's own title and cover together", () => {
    reset();
    const trackA = playing("z1", "art-8", "Track Eight", "Artist Eight");
    const trackB = playing("z1", "art-9", "Track Nine", "Artist Nine");

    playTrack(trackA);
    deliverImage("art-8", "COVER-EIGHT");
    playTrack(trackB);
    deliverImage("art-9", "COVER-NINE");

    playTrack(trackA);
    assert.strictEqual(lastActivity().details, "Track Eight");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-EIGHT");
});

test("a cover arriving after a skip back does not replace the shown cover", () => {
    reset();
    const trackA = playing("z1", "art-10", "Track Ten", "Artist Ten");
    const trackB = playing("z1", "art-11", "Track Eleven", "Artist Eleven");

    playTrack(trackA);
    deliverImage("art-10", "COVER-TEN");
    playTrack(trackB);
    playTrack(trackA);
    deliverImage("art-11", "COVER-ELEVEN");

    assert.strictEqual(lastActivity().details, "Track Ten");
    assert.strictEqual(fetchArt(lastActivity()).body.toString(), "COVER-TEN");
});

test("pausing every zone clears the presence", () => {
    reset();
    const stopped = playing("z1", "art-12", "Track Twelve", "Artist Twelve");
    stopped.state = "paused";
    playTrack(stopped);
    assert.strictEqual(captured.clears, 1);
    assert.strictEqual(captured.activities.length, 0);
});

test("Roon's pairing state is kept out of config.json", () => {
    captured.roonOpts.set_persisted_state({ tokens: { core: "abc" } });

    const stateFile = path.join(appDir, "roonstate.json");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), { tokens: { core: "abc" } });
    assert.deepStrictEqual(captured.roonOpts.get_persisted_state(), { tokens: { core: "abc" } });
    assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(path.join(appDir, "config.json"), "utf8")),
        CONFIG,
        "the Roon SDK's state landed in the app's own config file"
    );
});
