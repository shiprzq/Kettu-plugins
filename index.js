(function (vd) {
  "use strict";

  // Kettu evals plugin bundles as `vendetta => { return <this file> }`,
  // so the shim arrives as the outer parameter.
  var V = vd || (typeof window !== "undefined" ? (window.vendetta || window.bunny || window.pyoncord) : undefined);
  if (!V) throw new Error("[HiddenChannels] mod runtime shim not found");

  var metro = V.metro;
  var patcher = V.patcher;
  var logger = V.logger || console;

  var VERSION = "2.0.0";
  var DEFAULTS = {
    reveal: true,        // force VIEW_CHANNEL through the local permission store
    attemptSend: true,   // force SEND_MESSAGES so the composer opens (server still decides)
    probeOnOpen: false,
    debug: false
  };

  /* ---------------------------------------------------------------- storage
     Kettu hands plugins a proxied storage object (storage.cfg = {...}),
     not a get/set pair. */

  function storage() {
    try {
      if (V.plugin && V.plugin.storage) return V.plugin.storage;
    } catch (e) { /* no storage */ }
    return null;
  }

  function readCfg() {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var s = storage();
      var stored = s && s.cfg;
      if (stored && typeof stored === "object") for (var k2 in stored) out[k2] = stored[k2];
    } catch (e) { /* first run */ }
    return out;
  }

  function writeCfg() {
    try {
      var s = storage();
      if (s) s.cfg = cfg;
    } catch (e) { logger.warn("[HiddenChannels] config write failed", e); }
  }

  var cfg = readCfg();

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[HiddenChannels]");
    logger.log.apply(logger, args);
  }

  function dbg() {
    if (!cfg.debug) return;
    log.apply(null, arguments);
  }

  function toast(message) {
    try {
      if (V.ui && V.ui.toasts && V.ui.toasts.showToast) V.ui.toasts.showToast(String(message));
    } catch (e) { /* toast is best-effort */ }
  }

  /* ------------------------------------------------------------ metro find */

  function attempt(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  function byProps() {
    var args = Array.prototype.slice.call(arguments);
    return attempt(function () { return metro.findByProps.apply(metro, args); });
  }

  function findModule(filter) {
    return attempt(function () { return metro.find(filter); });
  }

  function byName(name) {
    return attempt(function () { return metro.findByStoreName(name); }) ||
           attempt(function () { return metro.findByDisplayName(name); });
  }

  var stores = {};

  function resolveStores() {
    stores.Channel = byName("ChannelStore") ||
      (attempt(function () { return metro.findByProps("getChannel", "hasChannel"); })) ||
      byProps("getChannel", "getChannels");
    stores.Guild = byName("GuildStore") || byProps("getGuild", "getGuilds");
    stores.User = byName("UserStore") || byProps("getUser", "getCurrentUser");
    stores.Member = byName("GuildMemberStore") || byProps("getMember", "getMembers");
    stores.Role = byName("GuildRoleStore") || byProps("getRoles", "getSortedRoles");
    stores.Permission = byName("PermissionStore") || byProps("computePermissions", "can");
    stores.GuildChannel = byName("GuildChannelStore") || byProps("getSortedChannels");

    stores.Rest = findModule(function (m) {
      return m && typeof m === "object" &&
        typeof m.get === "function" && typeof m.post === "function" &&
        typeof m.del === "function";
    }) || byProps("get", "post", "put", "patch", "del");

    stores.Alerts = findModule(function (m) {
      return m && typeof m === "object" && typeof m.openLazy === "function" &&
        typeof m.close === "function";
    }) || byProps("openLazy", "close");

    stores.LazySheet = findModule(function (m) {
      return m && typeof m === "object" && typeof m.openLazy === "function" &&
        typeof m.hideActionSheet === "function" &&
        !Object.getOwnPropertyDescriptor(m, "openLazy").get;
    }) || byProps("openLazy", "hideActionSheet");

    stores.SimpleSheet = findModule(function (m) {
      return m && typeof m === "object" && typeof m.showSimpleActionSheet === "function" &&
        !Object.getOwnPropertyDescriptor(m, "showSimpleActionSheet").get;
    }) || byProps("showSimpleActionSheet");

    dbg("stores", Object.keys(stores).filter(function (k) { return !!stores[k]; }).join(", "));
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
    for (var k in m) if ((value & m[k]) !== 0n) out.push(k);
    return out.sort();
  }

  var ALL_PERMS = (1n << 64n) - 1n;

  /* ------------------------------------------------------------- store glue */

  function currentUser() {
    return stores.User && stores.User.getCurrentUser ? attempt(function () {
      return stores.User.getCurrentUser();
    }) : null;
  }

  function allGuilds() {
    var g = stores.Guild && stores.Guild.getGuilds ? attempt(function () {
      return stores.Guild.getGuilds();
    }) : null;
    var out = [];
    if (!g) return out;
    for (var id in g) if (g[id]) out.push(g[id]);
    return out;
  }

  function guildById(id) {
    if (!id) return null;
    if (stores.Guild && stores.Guild.getGuild) return attempt(function () {
      return stores.Guild.getGuild(id);
    });
    return null;
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

    var sources = [
      function () { return stores.Channel && stores.Channel.getChannels ? stores.Channel.getChannels(guildId) : null; },
      function () { return stores.GuildChannel && stores.GuildChannel.getChannels ? stores.GuildChannel.getChannels(guildId) : null; },
      function () { return stores.Channel && stores.Channel.getSortedChannels ? stores.Channel.getSortedChannels(guildId) : null; },
      function () { return stores.GuildChannel && stores.GuildChannel.getSortedChannels ? stores.GuildChannel.getSortedChannels(guildId) : null; },
      function () { return stores.Channel && stores.Channel.getMutableGuildChannelsForGuild ? stores.Channel.getMutableGuildChannelsForGuild(guildId) : null; }
    ];

    for (var i = 0; i < sources.length; i++) {
      var raw = attempt(sources[i]);
      if (!raw) continue;
      if (Array.isArray(raw)) { raw.forEach(push); continue; }
      if (typeof raw !== "object") continue;
      if (Array.isArray(raw.selectable)) raw.selectable.forEach(push);
      if (Array.isArray(raw.vocal)) raw.vocal.forEach(push);
      for (var k in raw) if (raw[k] && raw[k].id && raw[k].guild_id) push(raw[k]);
    }
    return out;
  }

  function channelById(id) {
    return stores.Channel && stores.Channel.getChannel ? attempt(function () {
      return stores.Channel.getChannel(id);
    }) : null;
  }

  function guildName(guild) {
    return (guild && (guild.name || (guild.properties && guild.properties.name))) || "Unknown server";
  }

  /* --------------------------------------------------------- permission math
     Computed locally, never through the store we may have patched. */

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
        var u = stores.User && stores.User.getUser ? attempt(function (id) {
          return stores.User.getUser(id);
        }) : null;
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

  function hiddenInGuild(guild) {
    var me = currentUser();
    if (!me || !guild) return [];
    var view = bit("VIEW_CHANNEL");
    var chans = channelsOf(guild.id);
    var mine = [];
    for (var i = 0; i < chans.length; i++) {
      var c = chans[i];
      if (c.type === 4 || c.type === 1 || c.type === 3) continue;
      var perms = computePerms(guild, c, me.id);
      if ((perms & view) === 0n) mine.push({ channel: c, perms: perms });
    }
    return mine;
  }

  function hiddenChannels() {
    var out = [];
    var guilds = allGuilds();
    for (var i = 0; i < guilds.length; i++) {
      var mine = hiddenInGuild(guilds[i]);
      if (mine.length) out.push({ guild: guilds[i], channels: mine });
    }
    out.sort(function (a, b) { return guildName(a.guild).localeCompare(guildName(b.guild)); });
    return out;
  }

  /* ------------------------------------------------------------ REST probe */

  function probeChannel(channelId, onDone) {
    var rest = stores.Rest || byProps("get", "post", "put", "patch", "del");
    if (!rest || typeof rest.get !== "function") {
      onDone({ ok: false, error: "REST module not found (Discord internals moved)" });
      return;
    }
    var req;
    try {
      req = rest.get({ url: "/channels/" + channelId + "/messages", query: { limit: 1 }, retries: 0 });
    } catch (e) {
      onDone({ ok: false, error: String((e && e.message) || e) });
      return;
    }
    Promise.resolve(req).then(function (res) {
      var body = res && res.body !== undefined ? res.body : res;
      var count = Array.isArray(body) ? body.length : 0;
      onDone({ ok: true, count: count, note: count ? "server returned history" : "server returned an empty page" });
    }).catch(function (err) {
      var body = (err && err.body) || {};
      onDone({
        ok: false,
        status: body.code || (err && err.status) || "?",
        error: body.message || String((err && err.message) || err)
      });
    });
  }

  /* ------------------------------------------------------------------- UI */

  var C = {
    bg: "#1e1f22", card: "#2b2d31", border: "#3f4147", text: "#f2f3f5",
    dim: "#b5bac1", accent: "#5865f2", warn: "#f0b232", bad: "#f23f43", good: "#3ba55d"
  };

  var uiCache = null;

  function buildUI() {
    if (uiCache) return uiCache;

    var React = attempt(function () { return metro.common.React; }) ||
                byProps("createElement", "useState") ||
                byProps("createElement", "Component");
    var RN = attempt(function () { return metro.common.ReactNative; }) ||
             byProps("View", "Text", "ScrollView") ||
             byProps("ScrollView", "TouchableOpacity");
    if (!React || !RN) throw new Error("React / ReactNative not found");

    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

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
          borderRadius: 6, paddingVertical: 9, paddingHorizontal: 12,
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
            width: 20, height: 20, borderRadius: 4, borderWidth: 1,
            borderColor: props.value ? C.accent : C.border,
            backgroundColor: props.value ? C.accent : "transparent", marginRight: 10,
            alignItems: "center", justifyContent: "center"
          }
        }, props.value ? h(RN.Text, { key: "tick", style: { color: "#fff", fontSize: 13 } }, "\u2713") : null),
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
      }, h(RN.Text, {
        style: { color: props.tone === "bad" ? "#ff9ba0" : props.tone === "good" ? "#8fe0ac" : C.dim, fontSize: 11 }
      }, props.label));
    }

    function Row(props) {
      return h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap", marginTop: 6 } }, props.children);
    }

    function closePanel() {
      var alerts = stores.Alerts || byProps("openLazy", "close");
      attempt(function () { return alerts && alerts.close && alerts.close(); });
    }

    function Detail(props) {
      var entry = props.entry;
      var guild = props.guild;
      var ch = entry.channel;
      var probeState = useState(null);
      var probe = probeState[0], setProbe = probeState[1];
      var busyState = useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var me = currentUser();
      var overwrites = resolveOverwrites(guild, ch);
      var effective = computePerms(guild, ch, me ? me.id : "0");
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
          channel: {
            id: ch.id, name: ch.name, type: ch.type, topic: ch.topic || null,
            parent_id: ch.parent_id || null, nsfw: !!ch.nsfw
          },
          my_effective_permissions: bitNames(effective),
          overwrites: overwrites
        };
        if (clip && clip.setString) {
          clip.setString(JSON.stringify(payload, null, 2));
          toast("Channel intel copied");
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
          h(Row, { key: "row" }, [
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
          return h(RN.View, {
            key: "owr" + idx,
            style: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border }
          }, [
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

        h(Btn, { key: "copy", label: "copy intel as json", flat: true, onPress: copyJson }),
        h(Btn, { key: "close", label: "close", flat: true, onPress: closePanel })
      ]);
    }

    function List(props) {
      var openState = useState(null);
      var open = openState[0], setOpen = openState[1];
      var scope = props.guildId ? guildById(props.guildId) : null;
      var data = scope
        ? (function () {
            var mine = hiddenInGuild(scope);
            return mine.length ? [{ guild: scope, channels: mine }] : [];
          })()
        : hiddenChannels();
      var total = data.reduce(function (n, g) { return n + g.channels.length; }, 0);

      if (open) {
        return h(Detail, {
          entry: open.entry,
          guild: open.guild,
          onBack: function () { setOpen(null); }
        });
      }

      return h(RN.ScrollView, { style: { flex: 1, backgroundColor: C.bg }, contentContainerStyle: { padding: 12 } }, [
        h(Card, { key: "top" }, [
          h(RN.Text, { key: "t", style: { color: C.text, fontSize: 16, fontWeight: "700" } },
            total + " hidden channel" + (total === 1 ? "" : "s")),
          h(RN.Text, { key: "s", style: { color: C.dim, fontSize: 12, marginTop: 4 } },
            scope ? guildName(scope) : "all servers you're in"),
          props.guildId ? h(Btn, { key: "all", label: "show every server", flat: true, onPress: props.onShowAll }) : null
        ])
      ].concat(data.length === 0 ? [h(Card, { key: "empty" }, [
        h(RN.Text, { key: "e", style: { color: C.dim, fontSize: 13 } },
          "Nothing hidden here, or the stores haven't loaded yet. Open a server first, then retry.")
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
      })), [
        h(Btn, { key: "close", label: "close", flat: true, onPress: closePanel })
      ]);
    }

    function Panel(props) {
      return h(RN.View, { style: { flex: 1, backgroundColor: C.bg, paddingTop: 24 } }, [
        h(RN.View, { key: "bar", style: { paddingHorizontal: 12, paddingBottom: 4 } }, [
          h(RN.Text, { key: "title", style: { color: C.text, fontSize: 18, fontWeight: "700" } }, "Hidden Channels"),
          h(RN.Text, { key: "sub", style: { color: C.dim, fontSize: 11, marginTop: 2 } }, "v" + VERSION)
        ]),
        h(List, { key: "list", guildId: props.guildId, onShowAll: props.onShowAll })
      ]);
    }

    function Settings() {
      var tickState = useState(0);
      var tick = tickState[0], setTick = tickState[1];

      function flip(key) {
        cfg[key] = !cfg[key];
        writeCfg();
        applyPatches();
        setTick(tick + 1);
        toast("Hidden Channels: " + key + " " + (cfg[key] ? "on" : "off"));
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
        h(Card, { key: "summary" }, [
          h(RN.Text, { key: "h", style: { color: C.dim, fontSize: 11, marginBottom: 4 } }, "SURFACES"),
          h(RN.Text, { key: "b", style: { color: C.text, fontSize: 13 } },
            "Server menu: " + (entryPoints.sheet ? "armed" : "not found")),
          h(RN.Text, { key: "c", style: { color: C.text, fontSize: 13, marginTop: 2 } },
            "Lazy sheet: " + (entryPoints.lazy ? "armed" : "not found")),
          h(RN.Text, { key: "p", style: { color: C.text, fontSize: 13, marginTop: 2 } },
            "Permission store: " + (stores.Permission ? "found" : "missing")),
          h(RN.Text, { key: "s", style: { color: C.text, fontSize: 13, marginTop: 2 } },
            "Channel store: " + (stores.Channel ? "found" : "missing"))
        ]),
        h(List, { key: "list" + tick })
      ]);
    }

    uiCache = { React: React, RN: RN, Panel: Panel, Settings: Settings, List: List, Detail: Detail };
    return uiCache;
  }

  function getUI() {
    try {
      return buildUI();
    } catch (e) {
      logger.error("[HiddenChannels] UI build failed", e);
      return null;
    }
  }

  /* ----------------------------------------------------------- panel launch */

  function openPanel(guildId) {
    var ui = getUI();
    if (!ui) {
      toast("Hidden Channels: UI unavailable, check console");
      return;
    }
    var showCustomAlert = V.ui && V.ui.alerts && V.ui.alerts.showCustomAlert;
    if (!showCustomAlert) {
      toast("Hidden Channels: alerts module missing");
      return;
    }
    attempt(function () {
      showCustomAlert(ui.Panel, {
        guildId: guildId || null,
        onShowAll: function () { closePanel(); setTimeout(function () { openPanel(null); }, 250); }
      });
    });
  }

  /* --------------------------------------------------------- guild detection
     Mobile sheets hand us props we don't control, so we look for anything that
     walks and talks like a guild rather than trusting one key path. */

  var GUILD_MARKERS = ["ownerId", "roles", "icon", "memberCount", "premiumTier",
    "features", "afkTimeout", "emojis", "verificationLevel", "premiumSubscriptionCount"];

  function guildLike(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    if (typeof o.id !== "string" || typeof o.name !== "string") return null;
    for (var i = 0; i < GUILD_MARKERS.length; i++) if (GUILD_MARKERS[i] in o) return o;
    return null;
  }

  function deepGuild(node, depth, seen) {
    if (!node || typeof node !== "object" || depth > 5) return null;
    if (seen.indexOf(node) !== -1) return null;
    seen.push(node);

    var direct = guildLike(node);
    if (direct) return direct;

    if (typeof node.guildId === "string" || typeof node.guild_id === "string") {
      var byKey = guildById(node.guildId || node.guild_id);
      if (byKey) return byKey;
    }

    var keys = Object.keys(node);
    for (var i = 0; i < keys.length && i < 40; i++) {
      var v = node[keys[i]];
      if (!v || typeof v !== "object") continue;
      var found = deepGuild(v, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  function channelFrom(payload, depth, seen) {
    if (!payload || typeof payload !== "object" || depth > 5) return null;
    if (seen.indexOf(payload) !== -1) return null;
    seen.push(payload);

    if (typeof payload.id === "string" && typeof payload.type === "number" &&
        (payload.guild_id || payload.permissionOverwrites)) {
      var direct = channelById(payload.id) || payload;
      if (direct && direct.guild_id) return direct;
    }

    var byKey = typeof payload.channelId === "string" ? channelById(payload.channelId) : null;
    if (byKey) return byKey;

    var keys = Object.keys(payload);
    for (var i = 0; i < keys.length && i < 40; i++) {
      var v = payload[keys[i]];
      if (!v || typeof v !== "object") continue;
      var found = channelFrom(v, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  // A sheet earns the row only if it actually points at a server: either the
  // guild object is in the payload, or a channel is, and that channel knows
  // its guild. Anything else (message actions, generic prompts) stays clean.
  function guildFrom(payload) {
    var g = deepGuild(payload, 0, []);
    if (g) return g;
    var ch = channelFrom(payload, 0, []);
    return ch && ch.guild_id ? guildById(ch.guild_id) : null;
  }

  /* --------------------------------------------------------------- patches */

  var unpatchPerms = [];
  var unpatchMenus = [];
  var entryPoints = { sheet: false, lazy: false };

  function pushPerm(fn) { if (typeof fn === "function") unpatchPerms.push(fn); }
  function pushMenu(fn) { if (typeof fn === "function") unpatchMenus.push(fn); }

  function dropPermPatches() {
    while (unpatchPerms.length) {
      try { unpatchPerms.pop()(); } catch (e) { /* already gone */ }
    }
  }

  function applyPatches() {
    dropPermPatches();
    if (!cfg.reveal && !cfg.attemptSend) return;

    var storeObj = stores.Permission;
    if (!storeObj) {
      logger.warn("[HiddenChannels] PermissionStore not found, sidebar reveal skipped");
      return;
    }

    var forceBits = 0n;
    if (cfg.reveal) forceBits |= bit("VIEW_CHANNEL");
    if (cfg.attemptSend) forceBits |= bit("SEND_MESSAGES");
    if (forceBits === 0n) return;

    var targets = [];
    for (var key in storeObj) {
      if (typeof storeObj[key] !== "function") continue;
      if (!/^(can|compute|getUserPermissions|getChannelPermissions)/i.test(key)) continue;
      targets.push(key);
    }
    dbg("patching permission methods:", targets.join(", "));

    targets.forEach(function (name) {
      var kind = /^can/i.test(name) ? "bool" : "bits";
      pushPerm(patcher.instead(name, storeObj, function (args, orig) {
        var result = orig.apply(this, args);
        var target = null;
        for (var i = 0; i < args.length; i++) {
          var a = args[i];
          if (a && typeof a === "object" && a.guild_id && a.id && a.type !== undefined) { target = a; break; }
        }
        if (!target) return result;

        if (kind === "bool") {
          if (result === false) {
            var permArg = args.find(function (a) {
              return typeof a === "number" || typeof a === "bigint" || typeof a === "string";
            });
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

  function hideSheet() {
    var sheet = stores.LazySheet;
    attempt(function () { return sheet && sheet.hideActionSheet && sheet.hideActionSheet(); });
  }

  var ROW_LABEL = "Hidden channels";

  /* 1. plain option-list sheets (server long-press, channel long-press) */
  function patchSimpleSheets() {
    var simple = stores.SimpleSheet;
    if (!simple || typeof simple.showSimpleActionSheet !== "function") {
      entryPoints.sheet = false;
      return;
    }
    entryPoints.sheet = true;

    pushMenu(patcher.after("showSimpleActionSheet", simple, function (args) {
      var payload = args && args[0];
      if (!payload || typeof payload !== "object") return;
      var options = payload.options;
      if (!Array.isArray(options)) return;
      if (options.some(function (o) { return o && o.label === ROW_LABEL; })) return;

      var guild = guildFrom(payload);
      if (!guild) return;

      options.push({
        label: ROW_LABEL,
        onPress: function () {
          hideSheet();
          setTimeout(function () { openPanel(guild.id); }, 180);
        }
      });
      dbg("injected row into simple sheet for", guildName(guild));
    }));
  }

  /* 2. lazily-imported sheets (newer Discord server/channel sheets) */
  function injectRowIntoTree(tree, guild) {
    var utils = V.utils || {};
    if (typeof utils.findInReactTree !== "function") return tree;
    try {
      var rows = utils.findInReactTree(tree, function (node) {
        return Array.isArray(node) && node.length > 0 && node.every(function (r) {
          return r && typeof r === "object" && r.props && typeof r.props.label === "string" &&
            typeof r.props.onPress === "function";
        });
      });
      if (!rows || !Array.isArray(rows)) return tree;
      var dupe = rows.some(function (r) { return r.props.label === ROW_LABEL; });
      if (dupe) return tree;

      var template = rows[0];
      var rowType = template && template.type;
      if (!rowType) return tree;

      rows.push(h0(rowType, {
        key: "hidden-channels-row",
        label: ROW_LABEL,
        onPress: function () {
          hideSheet();
          setTimeout(function () { openPanel(guild.id); }, 180);
        },
        leading: undefined
      }, template.props && template.props.label ? template.props.label : ROW_LABEL));
      dbg("injected row into lazy sheet for", guildName(guild));
    } catch (e) {
      dbg("lazy row injection failed", e);
    }
    return tree;
  }

  function h0(type, props, child) {
    var ui = getUI();
    if (!ui) return null;
    return child === undefined
      ? ui.React.createElement(type, props)
      : ui.React.createElement(type, props, child);
  }

  function patchLazySheets() {
    var lazy = stores.LazySheet;
    if (!lazy || typeof lazy.openLazy !== "function") {
      entryPoints.lazy = false;
      return;
    }
    entryPoints.lazy = true;

    pushMenu(patcher.before("openLazy", lazy, function (args) {
      try {
        var component = args[0];
        var key = args[1];
        var context = args[2];
        if (typeof key !== "string") return;
        if (!/guild|Guild|channel|Channel/.test(key)) return;

        var guild = guildFrom(context);
        if (!guild) return;

        if (!component || typeof component.then !== "function") return;
        component.then(function (instance) {
          if (!instance || !instance.default) return;
          pushMenu(patcher.after("default", instance, function (props, tree) {
            return injectRowIntoTree(tree, guild);
          }));
        });
      } catch (e) {
        dbg("lazy sheet hook failed", e);
      }
    }));
  }

  function armMenus() {
    while (unpatchMenus.length) {
      try { unpatchMenus.pop()(); } catch (e) { /* already gone */ }
    }
    entryPoints.sheet = false;
    entryPoints.lazy = false;
    patchSimpleSheets();
    patchLazySheets();
    dbg("entry points", JSON.stringify(entryPoints));
  }

  /* ------------------------------------------------------------ lifecycle */

  function onLoad() {
    try {
      resolveStores();
      permMap();
      applyPatches();
      armMenus();
      getUI();
      log("v" + VERSION + " loaded", JSON.stringify(entryPoints));
      toast("Hidden Channels v" + VERSION + " ready \u2014 hold a server \u2192 Hidden channels");
    } catch (e) {
      logger.error("[HiddenChannels] load failed", e);
      toast("Hidden Channels failed: " + ((e && e.message) || e));
    }
  }

  function onUnload() {
    dropPermPatches();
    while (unpatchMenus.length) {
      try { unpatchMenus.pop()(); } catch (e) { /* already gone */ }
    }
    uiCache = null;
  }

  // Kettu reads `pluginInstance[id].settings` (lowercase). Vendetta proper
  // used `settings` too. Export both so either reader finds the page.
  function SettingsPage(props) {
    var ui = getUI();
    if (!ui) {
      return null;
    }
    return ui.React.createElement(ui.Settings, props || {});
  }

  return {
    onLoad: onLoad,
    onUnload: onUnload,
    settings: SettingsPage,
    Settings: SettingsPage,
    __internals: {
      stores: stores,
      entryPoints: entryPoints,
      resolveStores: resolveStores,
      hiddenChannels: hiddenChannels,
      hiddenInGuild: hiddenInGuild,
      computePerms: computePerms,
      resolveOverwrites: resolveOverwrites,
      guildFrom: guildFrom,
      bitNames: bitNames,
      bit: bit,
      probeChannel: probeChannel,
      openPanel: openPanel,
      cfg: cfg
    }
  };
})(typeof vendetta !== "undefined" ? vendetta : undefined)
