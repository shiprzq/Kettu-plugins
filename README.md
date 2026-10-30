# Hidden Channels — Kettu plugin

Reveals the channels your roles can't see, renders them in the server list, and gives you a full intel panel on every one: name, topic, channel id, type, creation date, resolved permission-overwrite matrix with role and member names, your effective permission bits, and a live API probe that reports exactly what Discord's servers hand back.

Written against Kettu's Vendetta-compat plugin loader (the same surface Bunny and Revenge expose). Single file, no build step, no bundling, no npm deps at runtime.

```
HiddenChannels/
├── manifest.json
├── index.js          ← the whole plugin
├── package.json      ← test harness only
└── test/
    ├── fixture.js    ← fake Discord client
    ├── harness.js    ← logic tests
    └── render.js     ← renders the settings UI with real React
```

## Install

1. Serve this folder over HTTP on the same network as the phone:

   ```
   npx --yes http-server . -p 4040 -c-1
   ```

2. On the phone: **Settings → General → Developer Settings** (enable it).
3. **Settings → Plugins → +** and paste the folder URL, trailing slash included:

   ```
   http://192.168.x.x:4040/
   ```

4. Accept the loader warning, enable **Hidden Channels**, restart Discord.

If the plugin list shows a hash error, the manifest hash doesn't match `index.js`. Recompute:

```
sha256sum index.js
```

## What you get

**Settings → Plugins → Hidden Channels** opens the panel.

- A list of every channel in every server you're in where your computed permissions lack `VIEW_CHANNEL`. Sorted by server, with type and a topic preview.
- Tap one for the intel panel:
  - channel name, type, category, creation date, nsfw flag, slowmode, ids
  - your effective permission bits, plus explicit granted/denied pills for `VIEW_CHANNEL`, `SEND_MESSAGES`, `READ_MESSAGE_HISTORY`
  - every permission overwrite, resolved: `@everyone`, then roles by name, then member overwrites by username, each with its allow and deny bit lists in readable form
  - **probe now** — one REST call for the channel's history, and the server's answer printed verbatim
  - **copy intel as json**

Two live overrides, toggleable:

| Toggle | What it does |
| --- | --- |
| Reveal locked channels in the sidebar | forces `VIEW_CHANNEL` through the local permission store so the channel list renders locked channels |
| Open the composer in locked channels | forces `SEND_MESSAGES` locally so the composer isn't disabled |

## The wall, stated once

Discord computes permissions on the server. Two consequences you should design around:

1. **Channel metadata is yours.** `GUILD_CREATE` sends every channel in a server — ids, names, topics, types, positions, and the full `permission_overwrites` bitfields — regardless of whether you can view it. The client just filters it out of the UI. That's the whole reason this plugin works: it re-reads the cache your gateway connection already holds and does its own overwrite math instead of trusting the filtered view.
2. **Message content and sends are not.** Your client only receives `MESSAGE_CREATE` for channels its gateway subscription covers, and that subscription is computed server-side from `VIEW_CHANNEL`. `GET /channels/{:id}/messages` answers `403 {"code": 50001, "message": "Missing Access"}`. No client patch changes that — there is no message data in the process to un-hide. Same for sending: the composer opening is local, the `POST` is judged remotely.

So the plugin gives you everything that exists locally (which is a lot — names, topics, and the complete access map of every private channel in the server) and surfaces the server's verdict honestly for the rest, rather than leaving you staring at a blank screen guessing whether it broke.

## How the patches work

```
PermissionStore.can*                → wrapped, returns true when the asked bit is one we force
PermissionStore.compute*            → wrapped, ORs the forced bits into the returned bitfield
PermissionStore.getUserPermissions* → same treatment
```

Discovery is name-driven, not hardcoded: at load the plugin walks the permission store and wraps every function matching `/^(can|compute|getUserPermissions|getChannelPermissions)/i`, then detects which style it is by return type (`boolean` vs bitfield) so both old and new Discord builds work. All wrappers are registered through `patcher.instead` and dropped in `onUnload`, so disabling the plugin restores the client to stock.

Store resolution tries `findByStoreName` first, then `findByProps` on the store's method signature, so a renamed store or a reshuffled internals build degrades to "reveal skipped, intel panel still works" instead of a crash. Every lookup is wrapped; a missing store logs a warning and the rest of the plugin keeps running.

The permission math in the panel is computed locally and never routed through the patched store, so the numbers you see are the truth and not the override:

```
base = @everyone role bits ∪ every role the member holds
owner or ADMINISTRATOR → all bits
apply @everyone overwrite, then role overwrites, then member overwrite
```

Bitfields are `BigInt` throughout — Discord is past 32 bits and JS bitwise ops truncate.

## Troubleshooting

- **Nothing listed** → enable **Debug logging**, reload, check the console for `loaded [...]`. If stores are missing, Discord moved them; the log names exactly which ones.
- **Sidebar unchanged but the panel works** → `PermissionStore` renames. The panel's own detection is independent of the patch layer, which is why it still finds channels.
- **Probe says `REST module not found`** → the REST client signature changed; update the `byProps("get","post",...)` probe list in `resolveStores`.
- **Channels appear but messages are empty** → expected, see *The wall* above.

## Tests

```
npm install
npm test
```

`harness.js` loads `index.js` the identical way Kettu does — `vendetta => { return <bundle> }` — against a fake client with three visibility cases (deny at `@everyone`, deny overridden by a role, deny overridden by a member overwrite) and asserts the patch layer installs and cleanly uninstalls.

`render.js` mounts the settings screen with a real React renderer, walks the tree, taps a locked channel, checks every section renders, fires the probe, taps back, and flips both overrides — including verifying that disabling them restores the stock permission check.

This is the part that catches the regressions you'd otherwise only see on the phone.
