// Cloudflare Worker — Hormuz AIS aggregator
// Single Durable Object holds one persistent WebSocket to AISStream.
// All dashboard browsers read its state via HTTP, so every user sees the same
// authoritative transit counts. Replaces per-browser AIS clients (P0.5 fix).
//
// Endpoints:
//   GET  /state              → current vessel state + 24h transit count
//   GET  /transits?range=24h → recent gate crossings
//   POST /__ping             → manual restart / health probe (token-gated)
//
// State persisted in Durable Object storage:
//   transits24h: [{mmsi, name, dir, time, lat, lng}, ...]   (rolling 24h)
//   vesselState: {mmsi: {lat, lng, sog, heading, side, lastSeen, category, name}, ...}
//   lastMsgTs:   unix ms of most recent AIS message

const GATE_LNG = 56.45;
const GATE_LAT_MIN = 26.20;
const GATE_LAT_MAX = 26.70;
const CORRIDOR = { latMin: 26.0, latMax: 26.7, lngMin: 55.5, lngMax: 57.5 };
const STATE_TTL_MS = 30 * 60 * 1000;       // drop vessel state after 30 min idle
const TRANSIT_WINDOW = 24 * 3600 * 1000;   // rolling 24h
const RECONNECT_DELAY_MS = 15 * 1000;
const SAVE_INTERVAL_MS = 30 * 1000;        // flush to durable storage every 30s

export class AISAggregator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.transits24h = [];
    this.vesselState = {};
    this.lastMsgTs = 0;
    this.connecting = false;
    this.lastSaveTs = 0;
    this.dirty = false;
    // Restore from durable storage on cold start
    this.state.blockConcurrencyWhile(async () => {
      this.transits24h = (await this.state.storage.get("transits24h")) || [];
      this.vesselState = (await this.state.storage.get("vesselState")) || {};
      this.lastMsgTs = (await this.state.storage.get("lastMsgTs")) || 0;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.ensureWebSocket();

    if (url.pathname === "/state") {
      return this.respondState();
    }
    if (url.pathname === "/transits") {
      return this.respondTransits(url);
    }
    if (url.pathname === "/__ping") {
      const tok = request.headers.get("X-Token");
      if (tok !== this.env.SNAPSHOT_TOKEN) return new Response("unauthorized", { status: 401 });
      this.reconnect();
      return json({ ok: true, reconnect: true });
    }
    return new Response("not found", { status: 404 });
  }

  async ensureWebSocket() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return;
    this.connecting = true;
    try {
      const pair = new WebSocketPair();
      // Actually open outbound connection to AISStream
      const upstream = await fetch("https://stream.aisstream.io/v0/stream", {
        headers: { Upgrade: "websocket" },
      }).catch(() => null);
      if (!upstream || !upstream.webSocket) {
        // fetch-based ws not available in this environment; use the WebSocket constructor
        this.openClient();
        return;
      }
      upstream.webSocket.accept();
      this.ws = upstream.webSocket;
      this.bindHandlers();
      this.sendSubscribe();
    } catch (e) {
      console.error("ws open failed:", e?.message);
      this.connecting = false;
      this.state.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
    }
  }

  openClient() {
    // Constructor-style WebSocket — works in Workers for outbound WS
    const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.connecting = false;
      this.sendSubscribe();
    });
    ws.addEventListener("message", (e) => this.onMessage(e));
    ws.addEventListener("close", () => this.scheduleReconnect());
    ws.addEventListener("error", () => this.scheduleReconnect());
  }

  bindHandlers() {
    this.ws.addEventListener("message", (e) => this.onMessage(e));
    this.ws.addEventListener("close", () => this.scheduleReconnect());
    this.ws.addEventListener("error", () => this.scheduleReconnect());
  }

  sendSubscribe() {
    if (!this.env.AIS_KEY) {
      console.error("AIS_KEY env var missing");
      return;
    }
    this.ws.send(JSON.stringify({
      APIKey: this.env.AIS_KEY,
      BoundingBoxes: [[[24.0, 52.0], [28.5, 59.5]]],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"]
    }));
  }

  scheduleReconnect() {
    this.connecting = false;
    this.ws = null;
    this.state.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
  }

  reconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.connecting = false;
    this.ensureWebSocket();
  }

  onMessage(e) {
    try {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
      const meta = msg.MetaData || {};
      const mmsi = meta.MMSI;
      const name = (meta.ShipName || "").trim();
      if (!mmsi) return;
      this.lastMsgTs = Date.now();

      if (msg.MessageType === "ShipStaticData") {
        const sd = (msg.Message && msg.Message.ShipStaticData) || {};
        if (this.vesselState[mmsi]) {
          if (sd.Type) this.vesselState[mmsi].type = sd.Type;
          if (sd.Destination) this.vesselState[mmsi].dest = sd.Destination.trim();
        }
        return;
      }
      if (msg.MessageType !== "PositionReport") return;

      const pos = (msg.Message && msg.Message.PositionReport) || {};
      const lat = meta.latitude;
      const lng = meta.longitude;
      if (!lat || !lng || (lat === 0 && lng === 0)) return;
      const heading = (pos.TrueHeading && pos.TrueHeading < 360) ? pos.TrueHeading : (pos.Cog || 0);
      const sog = pos.Sog || 0;

      // Gate crossing detection (use previous longitude)
      const prev = this.vesselState[mmsi];
      if (prev && lat >= GATE_LAT_MIN && lat <= GATE_LAT_MAX) {
        const prevSide = prev.lng > GATE_LNG ? "east" : "west";
        const currSide = lng > GATE_LNG ? "east" : "west";
        if (prevSide !== currSide) {
          this.transits24h.push({
            mmsi,
            name: name || prev.name || ("MMSI " + mmsi),
            dir: currSide === "east" ? "eastbound" : "westbound",
            time: Date.now(),
            lat, lng,
          });
          this.dirty = true;
        }
      }

      // Categorize vessel
      let category = "approach";
      if (sog < 0.5) category = "anchored";
      else if (sog >= 5 &&
        lat >= CORRIDOR.latMin && lat <= CORRIDOR.latMax &&
        lng >= CORRIDOR.lngMin && lng <= CORRIDOR.lngMax &&
        ((heading >= 250 && heading <= 320) || (heading >= 70 && heading <= 140))) {
        category = "transit";
      }

      this.vesselState[mmsi] = {
        ...(prev || {}),
        lat, lng, sog, heading,
        side: lng > GATE_LNG ? "east" : "west",
        lastSeen: Date.now(),
        category,
        name: name || (prev && prev.name) || ("MMSI " + mmsi),
      };
      this.dirty = true;

      // Periodic flush to durable storage (avoid hot-path write per message)
      if (Date.now() - this.lastSaveTs > SAVE_INTERVAL_MS) {
        this.persist();
      }
    } catch (e) {
      console.error("msg parse:", e?.message);
    }
  }

  async persist() {
    // Prune before save
    this.prune();
    this.lastSaveTs = Date.now();
    await Promise.all([
      this.state.storage.put("transits24h", this.transits24h),
      this.state.storage.put("vesselState", this.vesselState),
      this.state.storage.put("lastMsgTs", this.lastMsgTs),
    ]);
    this.dirty = false;
  }

  prune() {
    const transitCutoff = Date.now() - TRANSIT_WINDOW;
    this.transits24h = this.transits24h.filter(t => t.time > transitCutoff);
    const stateCutoff = Date.now() - STATE_TTL_MS;
    Object.keys(this.vesselState).forEach(m => {
      if (this.vesselState[m].lastSeen < stateCutoff) delete this.vesselState[m];
    });
  }

  async alarm() {
    // Triggered on schedule for reconnection
    if (this.dirty) await this.persist();
    await this.ensureWebSocket();
    // Re-schedule periodic alarm for housekeeping
    this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }

  respondState() {
    this.prune();
    const categories = { transit: 0, anchored: 0, approach: 0 };
    Object.values(this.vesselState).forEach(v => { if (categories[v.category] !== undefined) categories[v.category]++; });
    return json({
      transits24h: this.transits24h.length,
      eastbound24h: this.transits24h.filter(t => t.dir === "eastbound").length,
      westbound24h: this.transits24h.filter(t => t.dir === "westbound").length,
      categories,
      vesselCount: Object.keys(this.vesselState).length,
      lastMsgAgeSec: this.lastMsgTs ? Math.floor((Date.now() - this.lastMsgTs) / 1000) : null,
      wsConnected: !!(this.ws && this.ws.readyState === WebSocket.OPEN),
    });
  }

  respondTransits(url) {
    const range = url.searchParams.get("range") || "24h";
    const m = range.match(/^(\d+)([hd])$/);
    const n = m ? parseInt(m[1], 10) : 24;
    const unit = m && m[2] === "d" ? 86400000 : 3600000;
    const cutoff = Date.now() - n * unit;
    const list = this.transits24h.filter(t => t.time > cutoff).slice(-100);
    return json({ count: list.length, transits: list });
  }
}

export default {
  async fetch(request, env) {
    const id = env.AIS.idFromName("hormuz-singleton");
    const obj = env.AIS.get(id);
    return obj.fetch(request);
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" },
  });
}
