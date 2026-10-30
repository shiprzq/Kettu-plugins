# Hidden Channels — Kettu plugin

Reveals the channels your roles can't see, gives you a **Hidden channels** button on every server, and opens a full intel panel on each one: name, topic, channel id, type, creation date, resolved permission-overwrite matrix with role and member names, your effective permission bits, and a live API probe that reports exactly what Discord's servers hand back.

Written against Kettu's Vendetta-compat plugin loader. Single file, no build step, no runtime deps.

```
HiddenChannels/
├── manifest.json
├── index.js          ← the whole plugin
├── package.json      ← test harness only
└── test/
    ├── fixture.js    ← fake Discord client
    ├── harness.js    ← logic + entry-point tests
    └── render.js     ← renders both screens with real React
```

## Install

```
https://shiprzq.github.io/Kettu-plugins/
```

Settings → Plugins → **+** → paste (trailing slash) → Install → enable → restart.

## The button

Two entry points, armed at load:

| Surface | How it lands |
| --- | --- |
| Plain option sheets (`showSimpleActionSheet`) | a **Hidden channels** row appended to whatever row array the payload carries — `options`, `items`, or anything else that looks like a row list |
| Lazily-imported sheets (`openLazy`) | a row cloned from the sheet's own first row type and appended to the same array |
| `/` command | `/hidden` opens the panel from the composer |
| Settings page | **open panel now** button, plus the full list |

The row opens a modal panel scoped to that server. Sheets that aren't about a server — message actions, generic prompts — are left untouched: the hook only fires when the payload carries a guild object, or a channel that resolves to one.

If a hook finds its module but no row appears, the **Sheet Watch** card records what the sheet actually handed over on the last open — payload shape, whether a guild was detected, how many rows were found. Copy it and it names the exact mismatch.

If no hook finds its module, the settings page says so under **Surfaces** instead of failing silently. `settings` is the export Kettu actually reads (`pluginInstance[id]?.settings`); `Settings` is exported too for Vendetta-proper compatibility. Both render the same page.

## What the panel shows

- Every channel in scope where your computed permissions lack `VIEW_CHANNEL`, grouped by server.
- Tap one:
  - name, type, category, creation date, nsfw, slowmode, ids
  - your effective permission bits, plus granted/denied pills for `VIEW_CHANNEL`, `SEND_MESSAGES`, `READ_MESSAGE_HISTORY`
  - every overwrite resolved: `@everyone`, roles by name, member overwrites by username, each with readable allow/deny lists
  - **probe now** — one REST call for the channel's history, and the server's answer printed verbatim
  - **copy intel as json**

Two live overrides, toggleable in settings:

| Toggle | What it does |
| --- | --- |
| Reveal locked channels in the sidebar | forces `VIEW_CHANNEL` through the local permission store |
| Open the composer in locked channels | forces `SEND_MESSAGES` so the composer isn't disabled |

## The wall, stated once

Discord computes permissions server-side.

1. **Channel metadata is yours.** `GUILD_CREATE` sends every channel — ids, names, topics, types, positions, full `permission_overwrites` — whether you can view it or not. The client filters it out of the UI. That's why this works: it re-reads the cache the gateway already holds and does its own overwrite math.
2. **Message content and sends are not.** Your client only receives `MESSAGE_CREATE` for channels its gateway subscription covers, and that's computed server-side from `VIEW_CHANNEL`. `GET /channels/{:id}/messages` answers `403 {"code": 50001, "message": "Missing Access"}`. No client patch changes that — there's no message data in the process to un-hide. Sending is the same shape: the composer opening is local, the `POST` is judged remotely.

So the panel gives you everything that exists locally and surfaces the server's verdict for the rest, rather than leaving you guessing.

## How the patches work

```
PermissionStore.can*                → wrapped, returns true when the asked bit is one we force
PermissionStore.compute*            → wrapped, ORs the forced bits into the bitfield
PermissionStore.getUserPermissions* → same treatment
```

Discovery is name-driven: the plugin walks the permission store for `/^(can|compute|getUserPermissions|getChannelPermissions)/i`, detects boolean vs bitfield by return type, and registers every wrapper through `patcher.instead`, all dropped in `onUnload`.

The permission math in the panel is computed locally and never routed through the patched store, so the numbers you see are the truth rather than the override:

```
base = @everyone role bits ∪ every role the member holds
owner or ADMINISTRATOR → all bits
apply @everyone overwrite, then role overwrites, then member overwrite
```

Bitfields are `BigInt` — Discord is past 32 bits and JS bitwise ops truncate.

## No toasts, on purpose

Kettu's toast helper builds its payload without a `position` field, and Discord's `ToastContainer` reads that field at render:

```
TypeError: Cannot read property 'position' of undefined
    at useToastContainer
```

Any `showToast` call on this build takes the whole app down, so this plugin never makes one. Feedback goes to the log and to the **Last load** card on the settings page — version, timestamp, surface status, and the last few events.

## Troubleshooting

- **App crash-loops after enabling** → the served bundle is refetched before it's started, so shipping a fix to the same URL clears it on next launch. If it won't boot, disable Kettu's bundle from the loader app or clear Discord's data.
- **No row in the server menu** → settings → **Surfaces**. If both say *not found*, turn on **Debug logging**, reload, and check the console for the store list.
- **Panel empty** → open a server first so the guild list populates, then reopen.
- **Probe says `REST module not found`** → the REST client signature moved; update the predicate in `resolveStores`.
- **Channels appear, messages don't** → expected, see *The wall*.

## Tests

```
npm install
npm test
```

`harness.js` loads `index.js` the identical way Kettu does — `vendetta => { return <bundle> }` — against a fake shim: export shape (`settings` + `Settings`), entry-point arming, row injection into a server sheet, duplicate suppression, non-guild sheets left clean, permission math across three visibility cases, and clean unload.

`render.js` mounts both screens with a real React renderer: settings page, channel row tap, detail panel, probe, back navigation, the server-scoped panel launched the way a tap launches it, and the toggle→patch→unpatch contract.
