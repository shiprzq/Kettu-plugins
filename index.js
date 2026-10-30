(function (vd) {
  "use strict";

  // Kettu evals plugin bundles as `vendetta => { return <this file> }`,
  // so the shim arrives as the outer parameter.
  var V = vd || (typeof window !== "undefined" ? (window.vendetta || window.bunny || window.pyoncord) : undefined);
  if (!V) throw new Error("[HiddenChannels] mod runtime shim not found");

  var metro = V.metro;
  var patcher = V.patcher;
  var logger = V.logger || console;

  var DEFAULTS = {
    reveal: true,        // override VIEW_CHANNEL so the sidebar renders locked channels
    attemptSend: true,   // override SEND_MESSAGES so the composer opens (server still decides)
    probeOnOpen: false,  // REST-probe a channel the moment its intel panel opens
    debug: false
  };

  /* ---------------------------------------------------------------- storage */

  function readCfg() {
    var raw = null;
    try {
      if (V.plugin && V.plugin.storage && typeof V.plugin.storage.get === "function") raw = V.plugin.storage.get();
      else if (V.plugin && V.plugin.store && typeof V.plugin.store.get === "function") raw = V.plugin.store.get();
      else if (V.plugin && V.plugin.storage && typeof V.plugin.storage.getItem === "function") raw = V.plugin.storage.getItem();
    } catch (e) {
      logger.warn("[HiddenChannels] config read failed", e);
    }
    var cfg = {};
    for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];
    if (raw && typeof raw === "object") for (var k2 in raw) cfg[k2] = raw[k2];
    return cfg;
  }

  function writeCfg(cfg) {
    try {
      if (V.plugin && V.plugin.storage && typeof V.plugin.storage.set === "function") V.plugin.storage.set(cfg);
      else if (V.plugin && V.plugin.store && typeof V.plugin.store.set === "function") V.plugin.store.set(cfg);
      else if (V.plugin && V.plugin.storage && typeof V.plugin.storage.setItem === "function") V.plugin.storage.setItem(cfg);
    } catch (e) {
      logger.warn("[HiddenChannels] config write failed", e);
    }
  }

  var cfg = readCfg();

  function dbg() {
    if (!cfg.debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[HiddenChannels]");
    logger.log.apply(logger, args);
  }

  /* ------------------------------------------------------------ metro find */

  function attempt(fn) {
    try {
      return fn();
    } catch (e) {
      return undefined;
    }
  }

  function byProps() {
    var args = Array.prototype.slice.call(arguments);
    return attempt(function () { return metro.findByProps.apply(metro, args); });
  }

  function byName(name) {
    return attempt(function () { return metro.findByStoreName(name); }) ||
           attempt(function () { return metro.findByDisplayName(name); });
  }

  var stores = {};

  function resolveStores() {
    stores.Channel = byName("ChannelStore") || byProps("getChannel", "getChannels");
    stores.Guild = byName("GuildStore") || byProps("getGuild", "getGuilds");
    stores.User = byName("UserStore") || byProps("getCurrentUser", "getUser");
    stores.Member = byName("GuildMemberStore") || byProps("getMember", "getMembers");
    stores.Role = byName("GuildRoleStore") || byProps("getRoles", "getSortedRoles");
    stores.Permission = byName("PermissionStore") || byProps("computePermissions", "can");
    stores.Rest = byProps("get", "post", "put", "patch", "del") || byProps("get", "post");
    return stores;
  }

  /* -------------------------------------------------------- permission bits */

  var PERM = null;

  function permMap() {
    if (PERM) return PERM;
    var src = byProps("VIEW_CHANNEL", "SEND_MESSAGES") || byProps("VIEW_CHANNEL");
    var map = {};
    if (src) {
      for (var k in src) {
        var v = src[k];
        if (typeof v === "number" && v >= 0 && isFinite(v)) map[k] = BigInt(v);
        else if (typeof v === "string" && /^\d+$/.test(v)) map[k] = BigInt(v);
        else if (typeof v === "bigint") map[k] = v;
      }
    }
    if (!map.VIEW_CHANNEL) {
      // Discord's documented bit positions, used only if the constants module moved.
      map = {
        CREATE_INSTANT_INVITE: 1n << 0n, KICK_MEMBERS: 1n << 1n, BAN_MEMBERS: 1n << 2n,
        ADMINISTRATOR: 1n << 3n, MANAGE_CHANNELS: 1n << 4n, MANAGE_GUILD: 1n << 5n,
        ADD_REACTIONS: 1n << 6n, VIEW_AUDIT_LOG: 1n << 7n, PRIORITY_SPEAKER: 1n << 8n,
        STREAM: 1n << 9n, VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n,
        SEND_TTS_MESSAGES: 1n << 12n, MANAGE_MESSAGES: 1n << 13n, EMBED_LINKS: 1n << 14n,
        ATTACH_FILES: 1n << 15n, READ_MESSAGE_HISTORY: 1n << 16n, MENTION_EVERYONE: 1n << 17n,
        USE_EXTERNAL_EMOJIS: 1n << 18n, VIEW_GUILD_INSIGHTS: 1n << 19n, CONNECT: 1n << 20n,
        SPEAK: 1n << 21n, MUTE_MEMBERS: 1n << 22n, DEAFEN_MEMBERS: 1n << 23n, MOVE_MEMBERS: 1n << 24n,
        USE_VAD: 1n << 25n, CHANGE_NICKNAME: 1n << 26n, MANAGE_NICKNAMES: 1n << 27n,
        MANAGE_ROLES: 1n << 28n, MANAGE_WEBHOOKS: 1n << 29n, MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
        USE_APPLICATION_COMMANDS: 1n << 31n, REQUEST_TO_SPEAK: 1n << 32n, MANAGE_EVENTS: 1n << 33n,
        MANAGE_THREADS: 1n << 34n, CREATE_PUBLIC_THREADS: 1n << 35n, CREATE_PRIVATE_THREADS: 1n << 36n,
        USE_EXTERNAL_STICKERS: 1n << 37n, SEND_MESSAGES_IN_THREADS: 1n << 38n,
        USE_EMBEDDED_ACTIVITIES: 1n << 39n, MODERATE_MEMBERS: 1n << 40n
      };
    }
    PERM = map;
    return map;
  }

  function bit(name) {
    var m = permMap();
    return m[name] === undefined ? 0n : m[name];
  }

  function bitNames(value) {
    var m = permMap();
    var out = [];
    for (var k in m) if ((value & m[k]) !== 0n && k !== "ALL") out.push(k);
    return out.sort();
  }

  var ALL_PERMS = (1n << 64n) - 1n;

  /* ------------------------------------------------------------- store glue */

  function currentUser() {
    return stores.User && stores.User.getCurrentUser ? stores.User.getCurrentUser() : null;
  }

  function allGuilds() {
    var g = stores.Guild && stores.Guild.getGuilds ? stores.Guild.getGuilds() : {};
    var out = [];
    for (var id in g) if (g[id]) out.push(g[id]);
    return out;
  }

  function roleTable(guildId) {
    if (!stores.Role) return {};
    var r = attempt(function () { return stores.Role.getRoles(guildId); }) ||
            attempt(function () { return stores.Role.getSortedRoles(guildId); });
    if (!r) return {};
    if (Array.isArray(r)) {
      var o = {};
      for (var i = 0; i < r.length; i++) o[r[i].id] = r[i];
      return o;
    }
    return r;
  }

  function memberOf(guildId, userId) {
    if (!stores.Member) return null;
    return attempt(function () { return stores.Member.getMember(guildId, userId); }) ||
           attempt(function () { return stores.Member.getTrueMember(guildId, userId); });
  }

  function channelsOf(guildId) {
    var seen = {};
    var out = [];
    function push(c) {
      if (!c || !c.id || seen[c.id]) return;
      if (c.guild_id && c.guild_id !== guildId) return;
      seen[c.id] = true;
      out.push(c);
    }
    var raw = stores.Channel && stores.Channel.getChannels ? attempt(function () {
      return stores.Channel.getChannels(guildId);
    }) : null;
    if (Array.isArray(raw)) raw.forEach(push);
    else if (raw && typeof raw === "object") {
      if (Array.isArray(raw.selectable)) raw.selectable.forEach(push);
      if (Array.isArray(raw.vocal)) raw.vocal.forEach(push);
      for (var k in raw) if (raw[k] && raw[k].id && raw[k].guild_id) push(raw[k]);
    }
    var sorted = stores.Channel && stores.Channel.getSortedChannels ? attempt(function () {
      return stores.Channel.getSortedChannels(guildId);
    }) : null;
    if (Array.isArray(sorted)) sorted.forEach(push);
    return out;
  }

  function channelById(id) {
    return stores.Channel && stores.Channel.getChannel ? stores.Channel.getChannel(id) : null;
  }

  function guildName(guild) {
    return (guild && (guild.name || guild.properties && guild.properties.name)) || "Unknown server";
  }

  /* --------------------------------------------------------- the permission
     math, kept local so it never runs through a store we already patched. */

  function computePerms(guild, channel, userId) {
    var roles = roleTable(guild.id);
    var everyone = roles[guild.id];
    var perms = everyone && everyone.permissions ? BigInt(everyone.permissions) : 0n;

    var member = memberOf(guild.id, userId);
    var memberRoles = (member && member.roles) || [];
    for (var i = 0; i < memberRoles.length; i++) {
      var r = roles[memberRoles[i]];
      if (r && r.permissions) perms |= BigInt(r.permissions);
    }

    if (guild.ownerId === userId) perms = ALL_PERMS;
    if ((perms & bit("ADMINISTRATOR")) !== 0n) perms = ALL_PERMS;

    var ows = channel.permissionOverwrites || {};
    var list = Array.isArray(ows) ? ows : Object.keys(ows).map(function (k) { return ows[k]; });
    var everyoneOw = null, roleAllow = 0n, roleDeny = 0n, memberOw = null;

    for (var j = 0; j < list.length; j++) {
      var ow = list[j];
      if (!ow || !ow.id) continue;
      var allow = BigInt(ow.allow || 0);
      var deny = BigInt(ow.deny || 0);
      if (ow.id === guild.id) everyoneOw = { allow: allow, deny: deny };
      else if (memberRoles.indexOf(ow.id) !== -1) { roleAllow |= allow; roleDeny |= deny; }
      if (ow.id === userId) memberOw = { allow: allow, deny: deny };
    }

    if (everyoneOw) perms = (perms & ~everyoneOw.deny) | everyoneOw.allow;
    perms = (perms & ~roleDeny) | roleAllow;
    if (memberOw) perms = (perms & ~memberOw.deny) | memberOw.allow;

    return perms;
  }

  function resolveOverwrites(guild, channel) {
    var roles = roleTable(guild.id);
    var ows = channel.permissionOverwrites || {};
    var list = Array.isArray(ows) ? ows : Object.keys(ows).map(function (k) { return ows[k]; });
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var ow = list[i];
      if (!ow || !ow.id) continue;
      var allow = BigInt(ow.allow || 0);
      var deny = BigInt(ow.deny || 0);
      var kind, label;
      if (ow.id === guild.id) { kind = "everyone"; label = "@everyone"; }
      else if (ow.type === 1 || (ow.type === undefined && !roles[ow.id])) {
        kind = "member";
        var u = stores.User && stores.User.getUser
          ? attempt(function () { return stores.User.getUser(ow.id); })
          : null;
        label = u ? (u.globalName || u.username || u.id) : "user " + ow.id;
      } else {
        kind = "role";
        label = roles[ow.id] ? (roles[ow.id].name || "role " + ow.id) : "deleted role " + ow.id;
      }
      rows.push({ id: ow.id, kind: kind, label: label, allow: bitNames(allow), deny: bitNames(deny) });
    }
    rows.sort(function (a, b) {
      var rank = { everyone: 0, role: 1, member: 2 };
      return rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label);
    });
    return rows;
  }

  var CHANNEL_TYPES = {
    0: "text", 1: "dm", 2: "voice", 3: "group dm", 4: "category", 5: "announcement",
    10: "announcement thread", 11: "public thread", 12: "private thread", 13: "stage",
    14: "directory", 15: "forum", 16: "media"
  };

  function channelTypeName(t) {
    return CHANNEL_TYPES[t] || "type " + t;
  }

  function snowflakeDate(id) {
    try {
      return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString().slice(0, 10);
    } catch (e) {
      return "?";
    }
  }

  /* -------------------------------------------------------------- collection */

  function hiddenChannels() {
    var me = currentUser();
    if (!me) return [];
    var view = bit("VIEW_CHANNEL");
    var result = [];
    var guilds = allGuilds();
    for (var i = 0; i < guilds.length; i++) {
      var guild = guilds[i];
      var chans = channelsOf(guild.id);
      var mine = [];
      for (var j = 0; j < chans.length; j++) {
        var c = chans[j];
        if (c.type === 4 || c.type === 1 || c.type === 3) continue; // categories and DMs
        var perms = computePerms(guild, c, me.id);
        if ((perms & view) === 0n) {
          mine.push({ channel: c, perms: perms });
        }
      }
      if (mine.length) result.push({ guild: guild, channels: mine });
    }
    result.sort(function (a, b) { return guildName(a.guild).localeCompare(guildName(b.guild)); });
    return result;
  }

  /* ------------------------------------------------------------ REST probe */

  function probeChannel(channelId, onDone) {
    var rest = stores.Rest || byProps("get", "post", "put", "patch", "del") || byProps("get", "post");
    if (!rest || typeof rest.get !== "function") {
      onDone({ ok: false, error: "REST module not found (Discord internals moved)" });
      return;
    }
    var req;
    try {
      req = rest.get({ url: "/channels/" + channelId + "/messages", query: { limit: 1 }, retries: 0 });
    } catch (e) {
      onDone({ ok: false, error: String(e && e.message || e) });
      return;
    }
    Promise.resolve(req).then(function (res) {
      var count = Array.isArray(res) ? res.length : 0;
      onDone({ ok: true, count: count, note: count ? "server returned history" : "server returned an empty page" });
    }).catch(function (err) {
      var body = err && err.body || {};
      onDone({
        ok: false,
        status: body.code || (err && err.status) || "?",
        error: body.message || String(err && err.message || err)
      });
    });
  }

  /* ------------------------------------------------------------- UI layer */

  function resolveReact() {
    var r = attempt(function () { return metro.common.React; }) ||
            byProps("createElement", "useState") ||
            byProps("createElement", "Component");
    if (!r) throw new Error("[HiddenChannels] React not found");
    return r;
  }

  function resolveRN() {
    var rn = attempt(function () { return metro.common.ReactNative; }) ||
             byProps("View", "Text", "ScrollView") ||
             byProps("ScrollView", "TouchableOpacity");
    if (!rn) throw new Error("[HiddenChannels] React Native components not found");
    return rn;
  }

  var C = {
    bg: "#1e1f22", card: "#2b2d31", border: "#3f4147", text: "#f2f3f5",
    dim: "#b5bac1", accent: "#5865f2", warn: "#f0b232", bad: "#f23f43", good: "#3ba55c"
  };

  function buildUI() {
    var React = resolveReact();
    var RN = resolveRN();
    var h = React.createElement, useState = React.useState, useEffect = React.useEffect;

    function T(props) {
      return h(RN.Text, { style: [{ color: C.text, fontSize: 14 }, props.style] }, props.children);
    }

    function Card(props) {
      return h(RN.View, {
        style: [{
          backgroundColor: C.card, borderRadius: 8, padding: 12, marginBottom: 8,
          borderWidth: 1, borderColor: C.border
        }, props.style]
      }, props.children);
    }

    function Btn(props) {
      return h(RN.TouchableOpacity, {
        onPress: props.onPress,
        style: [{
          backgroundColor: props.danger ? C.bad : props.flat ? "transparent" : C.accent,
          borderWidth: props.flat ? 1 : 0, borderColor: C.border,
          borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12,
          alignSelf: "flex-start", marginTop: 8, marginRight: 8
        }, props.style]
      }, h(RN.Text, { style: { color: C.text, fontSize: 13, fontWeight: "600" } }, props.label));
    }

    function Toggle(props) {
      return h(RN.TouchableOpacity, {
        onPress: props.onChange,
        style: { flexDirection: "row", alignItems: "center", paddingVertical: 10 }
      }, [
        h(RN.View, {
          key: "box",
          style: {
            width: 20, height: 20, borderRadius: 4, borderWidth: 1, borderColor: props.value ? C.accent : C.border,
            backgroundColor: props.value ? C.accent : "transparent", marginRight: 10,
            alignItems: "center", justifyContent: "center"
          }
        }, props.value ? h(RN.Text, { style: { color: "#fff", fontSize: 13 } }, "\u2713") : null),
        h(RN.View, { key: "lbl", style: { flex: 1 } }, [
          h(RN.Text, { key: "t", style: { color: C.text, fontSize: 14 } }, props.label),
          props.note ? h(RN.Text, { key: "n", style: { color: C.dim, fontSize: 12, marginTop: 2 } }, props.note) : null
        ])
      ]);
    }

    function Pill(props) {
      return h(RN.View, {
        style: {
          backgroundColor: props.tone === "bad" ? "#4a1f22" : props.tone === "good" ? "#1f3d2b" : "#313338",
          borderWidth: 1, borderColor: C.border, borderRadius: 4,
          paddingHorizontal: 6, paddingVertical: 2, marginRight: 6, marginBottom: 6
        }
      }, h(RN.Text, { style: { color: props.tone === "bad" ? "#ff9ba0" : props.tone === "good" ? "#8fe0ac" : C.dim, fontSize: 11 } }, props.label));
    }

    function Row(props) {
      return h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap", marginTop: 6 } }, props.children);
    }

    function Detail(props) {
      var entry = props.entry;
      var ch = entry.channel, guild = props.guild;
      var [probe, setProbe] = useState(null);
      var [busy, setBusy] = useState(false);
      var me = currentUser();
      var overwrites = resolveOverwrites(guild, ch);
      var effective = computePerms(guild, ch, me.id);
      var has = function (name) { return (effective & bit(name)) !== 0n; };

      function runProbe() {
        setBusy(true);
        setProbe(null);
        probeChannel(ch.id, function (res) { setProbe(res); setBusy(false); });
      }

      useEffect(function () {
        if (cfg.probeOnOpen) runProbe();
      }, []);

      function copyJson() {
        var clip = attempt(function () { return metro.common.clipboard; }) || byProps("setString", "getString");
        var payload = {
          guild: { id: guild.id, name: guildName(guild) },
          channel: { id: ch.id, name: ch.name, type: ch.type, topic: ch.topic || null, parent_id: ch.parent_id || null, nsfw: !!ch.nsfw },
          my_effective_permissions: bitNames(effective),
          overwrites: overwrites
        };
        if (clip && clip.setString) {
          clip.setString(JSON.stringify(payload, null, 2));
          if (V.ui && V.ui.toasts) V.ui.toasts.showToast({ content: "Channel intel copied" });
        }
      }

      return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { padding: 12 } }, [
        h(Btn, { key: "back", label: "\u2190 back", flat: true, onPress: props.onBack }),

        h(Card, { key: "head", style: { marginTop: 8 } }, [
          h(RN.Text, { key: "name", style: { color: C.text, fontSize: 18, fontWeight: "700" } }, "# " + (ch.name || ch.id)),
          h(RN.Text, { key: "sub", style: { color: C.dim, fontSize: 12, marginTop: 4 } },
            guildName(guild) + " \u00b7 " + channelTypeName(ch.type) + " \u00b7 created " + snowflakeDate(ch.id))
        ]),

        ch.topic ? h(Card, { key: "topic" }, [
          h(RN.Text, { key: "h", style: { color: C.dim, fontSize: 11, marginBottom: 4 } }, "TOPIC"),
          h(RN.Text, { key: "t", style: { color: C.text, fontSize: 14 } }, ch.topic)
        ]) : null,

        h(Card, { key: "ids" }, [
          h(RN.Text, { key: "h", style: { color: C.dim, fontSize: 11, marginBottom: 4 } }, "IDENTIFIERS"),
          h(RN.Text, { key: "c", style: { color: C.text, fontSize: 12, fontFamily: "monospace" } }, "channel " + ch.id),
          h(RN.Text, { key: "p", style: { color: C.text, fontSize: 12, fontFamily: "monospace", marginTop: 2 } },
            "parent  " + (ch.parent_id || "none")),
          h(RN.Text, { key: "f", style: { color: C.text, fontSize: 12, marginTop: 4 } },
            "nsfw " + (ch.nsfw ? "yes" : "no") + " \u00b7 slowmode " + (ch.rateLimitPerUser || 0) + "s")
        ]),

        h(Card, { key: "perms" }, [
          h(RN.Text, { key: "h", style: { color: C.dim, fontSize: 11, marginBottom: 6 } }, "YOUR EFFECTIVE PERMISSIONS HERE"),
          h(Row, { key: "deny" }, [
            h(Pill, { key: "v", label: "VIEW_CHANNEL " + (has("VIEW_CHANNEL") ? "granted" : "denied"), tone: has("VIEW_CHANNEL") ? "good" : "bad" }),
            h(Pill, { key: "s", label: "SEND_MESSAGES " + (has("SEND_MESSAGES") ? "granted" : "denied"), tone: has("SEND_MESSAGES") ? "good" : "bad" }),
            h(Pill, { key: "r", label: "READ_HISTORY " + (has("READ_MESSAGE_HISTORY") ? "granted" : "denied"), tone: has("READ_MESSAGE_HISTORY") ? "good" : "bad" })
          ]),
          h(RN.Text, { key: "rest", style: { color: C.dim, fontSize: 11, marginTop: 4 } },
            bitNames(effective).join(" \u00b7 ") || "no bits set")
        ]),

        h(Card, { key: "ow" }, [
          h(RN.Text, { key: "h", style: { color: C.dim, fontSize: 11, marginBottom: 6 } },
            "PERMISSION OVERWRITES (" + overwrites.length + ")"),
          overwrites.length === 0 ? h(RN.Text, { key: "none", style: { color: C.dim, fontSize: 13 } }, "inherits everything") : null
        ].concat(overwrites.map(function (ow, idx) {
          return h(RN.View, { key: "ow" + idx, style: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border } }, [
            h(RN.Text, { key: "l", style: { color: C.text, fontSize: 13, fontWeight: "600" } },
              (ow.kind === "role" ? "@" : ow.kind === "member" ? "\u25cf " : "@") + ow.label + "  (" + ow.kind + ")"),
            ow.allow.length ? h(RN.Text, { key: "a", style: { color: "#8fe0ac", fontSize: 11, marginTop: 3 } }, "+ " + ow.allow.join(", ")) : null,
            ow.deny.length ? h(RN.Text, { key: "d", style: { color: "#ff9ba0", fontSize: 11, marginTop: 2 } }, "\u2212 " + ow.deny.join(", ")) : null
          ]);
        }))),

        h(Card, { key: "probe" }, [
          h(RN.Text, { key: "h", style: { color: C.dim, fontSize: 11, marginBottom: 4 } }, "SERVER VERDICT"),
          h(RN.Text, { key: "n", style: { color: C.dim, fontSize: 12 } },
            "asks Discord for one message from this channel and reports what the API answers"),
          busy ? h(RN.ActivityIndicator, { key: "sp", style: { marginTop: 10 } }) : null,
          probe ? h(RN.View, { key: "res", style: { marginTop: 8 } }, [
            h(RN.Text, { key: "s", style: { color: probe.ok ? C.good : C.bad, fontSize: 13, fontWeight: "600" } },
              probe.ok ? "granted" : "refused \u00b7 " + (probe.status || "")),
            h(RN.Text, { key: "m", style: { color: C.dim, fontSize: 12, marginTop: 2 } },
              probe.ok ? probe.note : probe.error)
          ]) : null,
          probe ? null : h(Btn, { key: "go", label: "probe now", onPress: runProbe })
        ]),

        h(Btn, { key: "copy", label: "copy intel as json", flat: true, onPress: copyJson })
      ]);
    }

    function List(props) {
      var [open, setOpen] = useState(null);
      var data = hiddenChannels();
      var total = data.reduce(function (n, g) { return n + g.channels.length; }, 0);

      if (open) return h(Detail, { entry: open.entry, guild: open.guild, onBack: function () { setOpen(null); } });

      return h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { padding: 12 } }, [
        h(Card, { key: "top" }, [
          h(RN.Text, { key: "t", style: { color: C.text, fontSize: 16, fontWeight: "700" } },
            total + " hidden channel" + (total === 1 ? "" : "s")),
          h(RN.Text, { key: "s", style: { color: C.dim, fontSize: 12, marginTop: 4 } },
            "read from the local channel cache \u2014 names, topics and overwrites Discord already sent your client")
        ])
      ].concat(data.length === 0 ? [h(Card, { key: "empty" }, [
        h(RN.Text, { key: "e", style: { color: C.dim, fontSize: 13 } },
          "Nothing hidden in the servers you're in, or the stores haven't loaded yet. Pull this page again after opening a server.")
      ])] : data.map(function (g, gi) {
        return h(Card, { key: "g" + gi }, [
          h(RN.Text, { key: "gn", style: { color: C.text, fontSize: 14, fontWeight: "700", marginBottom: 6 } },
            guildName(g.guild) + "  (" + g.channels.length + ")")
        ].concat(g.channels.map(function (entry, ci) {
          var ch = entry.channel;
          return h(RN.TouchableOpacity, {
            key: "c" + ci,
            onPress: function () { setOpen({ entry: entry, guild: g.guild }); },
            style: {
              flexDirection: "row", alignItems: "center", paddingVertical: 9,
              borderTopWidth: ci === 0 ? 0 : 1, borderTopColor: C.border
            }
          }, [
            h(RN.Text, { key: "lock", style: { color: C.warn, fontSize: 13, marginRight: 8 } }, "\ud83d\udd12"),
            h(RN.View, { key: "body", style: { flex: 1 } }, [
              h(RN.Text, { key: "n", style: { color: C.text, fontSize: 14 } }, ch.name || ch.id),
              h(RN.Text, { key: "t", style: { color: C.dim, fontSize: 11, marginTop: 2 } },
                channelTypeName(ch.type) + (ch.topic ? " \u00b7 " + String(ch.topic).slice(0, 70) : ""))
            ]),
            h(RN.Text, { key: "chev", style: { color: C.dim, fontSize: 16 } }, "\u203a")
          ]);
        })));
      })));
    }

    function Settings() {
      var [tick, setTick] = useState(0);
      function flip(key) {
        cfg[key] = !cfg[key];
        writeCfg(cfg);
        applyPatches();
        setTick(tick + 1);
      }
      return h(RN.ScrollView, { style: { flex: 1, backgroundColor: C.bg }, contentContainerStyle: { padding: 12 } }, [
        h(Card, { key: "flags" }, [
          h(Toggle, {
            key: "reveal", label: "Reveal locked channels in the sidebar",
            note: "overrides VIEW_CHANNEL locally so the channel list renders them",
            value: cfg.reveal, onChange: function () { flip("reveal"); }
          }),
          h(Toggle, {
            key: "send", label: "Open the composer in locked channels",
            note: "overrides SEND_MESSAGES locally; Discord still answers each send",
            value: cfg.attemptSend, onChange: function () { flip("attemptSend"); }
          }),
          h(Toggle, {
            key: "probe", label: "Probe on open",
            note: "hit the REST API as soon as a channel's intel panel opens",
            value: cfg.probeOnOpen, onChange: function () { flip("probeOnOpen"); }
          }),
          h(Toggle, {
            key: "debug", label: "Debug logging",
            note: "write store lookups and patch results to the console",
            value: cfg.debug, onChange: function () { flip("debug"); }
          })
        ]),
        h(List, { key: "list" + tick })
      ]);
    }

    return Settings;
  }

  /* --------------------------------------------------------------- patches */

  var unpatch = [];

  function pushUnpatch(fn) {
    if (typeof fn === "function") unpatch.push(fn);
  }

  function applyPatches() {
    while (unpatch.length) {
      try { unpatch.pop()(); } catch (e) { dbg("unpatch failed", e); }
    }
    if (!cfg.reveal && !cfg.attemptSend) return;

    var storeObj = stores.Permission;
    if (!storeObj) {
      logger.warn("[HiddenChannels] PermissionStore not found \u2014 sidebar reveal skipped");
      return;
    }

    var viewBit = bit("VIEW_CHANNEL");
    var sendBit = bit("SEND_MESSAGES");
    var forceBits = 0n;
    if (cfg.reveal) forceBits |= viewBit;
    if (cfg.attemptSend) forceBits |= sendBit;
    if (forceBits === 0n) return;

    var targets = [];
    for (var key in storeObj) {
      if (typeof storeObj[key] !== "function") continue;
      if (!/^(can|compute|getUserPermissions|getChannelPermissions)/i.test(key)) continue;
      targets.push(key);
    }
    dbg("patching permission methods:", targets);

    targets.forEach(function (name) {
      var kind = /^can/i.test(name) ? "bool" : "bits";
      pushUnpatch(patcher.instead(name, storeObj, function (args, orig) {
        var result = orig.apply(this, args);
        var target = null;
        for (var i = 0; i < args.length; i++) {
          var a = args[i];
          if (a && typeof a === "object" && a.guild_id && a.id && a.type !== undefined) { target = a; break; }
        }
        if (!target) return result;

        if (kind === "bool") {
          if (typeof result === "boolean" && result === false) {
            var permArg = args.find(function (a) { return typeof a === "number" || typeof a === "bigint" || typeof a === "string"; });
            var asked = permArg === undefined ? 0n : BigInt(permArg);
            if ((asked & forceBits) !== 0n) return true;
          }
          return result;
        }
        if (typeof result === "number") return Number(BigInt(result) | forceBits);
        if (typeof result === "bigint") return result | forceBits;
        if (typeof result === "string" && /^\d+$/.test(result)) return (BigInt(result) | forceBits).toString();
        return result;
      }));
    });
  }

  /* ------------------------------------------------------------ lifecycle */

  function onLoad() {
    resolveStores();
    permMap();
    applyPatches();
    dbg("loaded", Object.keys(stores).filter(function (k) { return !!stores[k]; }));
    if (V.ui && V.ui.toasts && cfg.debug) {
      V.ui.toasts.showToast({ content: "Hidden Channels armed \u2014 Settings \u2192 Plugins \u2192 Hidden Channels" });
    }
  }

  function onUnload() {
    while (unpatch.length) {
      try { unpatch.pop()(); } catch (e) { /* patch already gone */ }
    }
  }

  var Settings = null;
  try {
    Settings = buildUI();
  } catch (e) {
    logger.error("[HiddenChannels] settings UI failed to build", e);
    Settings = null;
  }

  return {
    onLoad: onLoad,
    onUnload: onUnload,
    Settings: Settings,
    __internals: {
      stores: stores,
      resolveStores: resolveStores,
      hiddenChannels: hiddenChannels,
      computePerms: computePerms,
      resolveOverwrites: resolveOverwrites,
      bitNames: bitNames,
      bit: bit,
      probeChannel: probeChannel,
      cfg: cfg
    }
  };
})(typeof vendetta !== "undefined" ? vendetta : undefined)
