"use strict";

// Loading index.js starts the whole app, so the modules it talks to are stubbed out.
// Each case gets its own copy of index.js in its own directory, because a different
// path is a different module instance - the only way to run the config check twice.

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const fs = require("fs");
const os = require("os");
const path = require("path");

function FakeRoonApi() {}
FakeRoonApi.prototype.init_services = () => {};
FakeRoonApi.prototype.start_discovery = () => {};

function FakeRoonApiStatus() {}
FakeRoonApiStatus.prototype.set_status = () => {};

const fakes = {
    "node-roon-api": FakeRoonApi,
    "node-roon-api-status": FakeRoonApiStatus,
    "node-roon-api-transport": "TRANSPORT",
    "node-roon-api-image": "IMAGE",
    "@xhayper/discord-rpc": {
        Client: class {
            on() {}
            login() {
                return Promise.resolve();
            }
        },
    },
    "discord-api-types/v10": { ActivityType: { Listening: 2 } },
    http: { createServer: () => ({ listen() {}, on() {} }) },
    child_process: {
        spawn: () => ({ stdout: { on() {} }, stderr: { on() {} }, on() {} }),
    },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(fakes, request)) return fakes[request];
    return origLoad.call(this, request, ...rest);
};

function launch(configText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roon-discord-config-"));
    fs.copyFileSync(path.join(__dirname, "..", "index.js"), path.join(dir, "index.js"));
    if (configText !== null) fs.writeFileSync(path.join(dir, "config.json"), configText);

    const messages = [];
    const realLog = console.log;
    const realError = console.error;
    const realExit = process.exit;
    console.log = () => {};
    console.error = (...args) => messages.push(args.join(" "));
    process.exit = (code) => {
        const stop = new Error("process.exit");
        stop.exitCode = code;
        throw stop;
    };

    let exitCode = null;
    try {
        require(path.join(dir, "index.js"));
    } catch (err) {
        if (err.exitCode === undefined) throw err;
        exitCode = err.exitCode;
    } finally {
        console.log = realLog;
        console.error = realError;
        process.exit = realExit;
    }
    return { exitCode, output: messages.join("\n") };
}

test("a missing config.json is reported, not thrown as a stack trace", () => {
    const { exitCode, output } = launch(null);
    assert.strictEqual(exitCode, 1);
    assert.match(output, /Could not read .*config\.json/);
    assert.match(output, /Discord Application ID/);
});

test("an unparseable config.json is reported, not thrown as a stack trace", () => {
    const { exitCode, output } = launch("{ not json");
    assert.strictEqual(exitCode, 1);
    assert.match(output, /Could not read .*config\.json/);
});

test("a config.json saved with a BOM still loads", () => {
    const { exitCode, output } = launch("﻿" + JSON.stringify({ discordClientId: "123" }));
    assert.strictEqual(exitCode, null, "rejected a config file Notepad would happily produce: " + output);
});

test("the placeholder Discord ID gets its own message", () => {
    const { exitCode, output } = launch(JSON.stringify({ discordClientId: "YOUR_DISCORD_APPLICATION_ID" }));
    assert.strictEqual(exitCode, 1);
    assert.match(output, /Set discordClientId/);
});
