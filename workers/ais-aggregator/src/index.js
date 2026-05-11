// Cloudflare Worker — Hormuz AIS aggregator (Durable Object)
// Single DO instance subscribes to AISStream once, computes gate-crossings
// authoritatively, persists state. All dashboard browsers read this state
// via HTTP — every user sees the same numbers.

const GATE_LNG = 56.45;
const GATE_LAT_MIN = 26.20;
const GATE_LAT_MAX = 26.70;
const CORRIDOR = { latMin: 26.0, latMax: 26.7, lngMin: 55.5, lngMax: 57.5 };
const STATE_TTL_MS = 30 * 60 * 1000;
const TRANSIT_WINDOW = 24 * 3600 * 1000;
const RECONNECT_DELAY_MS = 15 * 1000;
const SAVE_INTERVAL_MS = 30 * 1000;
const KEEPALIVE_MS = 5 * 60 * 1000;

export class AISAggregator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.connectAttempt = 0;
    this.transits24h = [];
    this.vesselState = {};
    this.lastMsgTs = 0;
    this.lastSaveTs = 0;
    this.dirty = false;
    state.blockConcurrencyWhile(async () => {
      this.transits24h = (await state.storage.get("transits24h")) || [];
      this.vesselState = (await state.storage.get("vesselState")) || {};
      this.lastMsgTs   = (await state.storage.get("lastMsgTs"))   || 0;
      // Ensure an alarm is scheduled so we wake up periodically
      const existing = await state.storage.getAlarm();
      if (!existing) await state.storage.setAlarm(Date.now() + 30 * 1000);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Lazy-connect WebSocket on first request (don't block the response)
    if (!this.ws) this.connectWs().catch(e => console.error("ws connect:", e?.message));

    if (url.pathname === "/state") {
      return this.respondState();
    }
    if (url.pathname === "/transits") {
      return this.respondTransits(url);
    }
    if (url.pathname === "/__ping") {
      const tok = request.headers.get("X-Token");
      if (!this.env.SNAPSHOT_TOKEN || tok !== this.env.SNAPSHOT_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      await this.connectWs();
      return json({ ok: true, wsState: this.ws ? this.ws.readyState : null });
    }
    return new Response("not found", { status: 404 });
  }

  async connectWs() {
    if (this.ws && this.ws.readyState <= 1) return; // CONNECTING or OPEN
    if (!this.env.AIS_KEY) {
      console.error("AIS_KEY missing — cannot connect");
      return;
    }
    try {
      this.connectAttempt++;
      // Cloudflare Workers outbound WebSocket pattern via fetch + Upgrade header
      const resp = await fetch("https://stream.aisstream.io/v0/stream", {
        headers: { "Upgrade": "websocket" },
      });
      const ws = resp.webSocket;
      if (!ws) {
        console.error("ws upgrade failed, status:", resp.status);
        await this.state.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
        return;
      }
      ws.accept();
      this.ws = ws;
      this.connectAttempt = 0;

      ws.addEventListener("message", (e) => this.onMessage(e));
      ws.addEventListener("close", () => {
        this.ws = null;
        this.state.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS).catch(() => {});
      });
      ws.addEventListener("error", () => {
        try { ws.close(); } catch (e) {}
        this.ws = null;
        this.state.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS).catch(() => {});
      });

      // Subscribe to Hormuz bounding box
      ws.send(JSON.stringify({
        APIKey: this.env.AIS_KEY,
        BoundingBoxes: [[[24.0, 52.0], [28.5, 59.5]]],
        FilterMessageTypes: ["PositionReport", "ShipStaticData"],
      }));
    } catch (e) {
      console.error("connectWs error:", e?.message);
      await this.state.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
    }
  }

  onMessage(e) {
    try {
      const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
      const msg = JSON.parse(text);
      const meta = msg.MetaData || {};
      const mmsi = meta.MMSI;
      if (!mmsi) return;
      const name = (meta.ShipName || "").trim();
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

      // Gate crossing detection
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

      // Categorize
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

      // Periodic flush
      if (Date.now() - this.lastSaveTs > SAVE_INTERVAL_MS) {
        this.persist().catch(() => {});
      }
    } catch (err) {
      console.error("msg parse:", err?.message);
    }
  }

  prune() {
    const transitCutoff = Date.now() - TRANSIT_WINDOW;
    this.transits24h = this.transits24h.filter(t => t.time > transitCutoff);
    const stateCutoff = Date.now() - STATE_TTL_MS;
    Object.keys(this.vesselState).forEach(m => {
      if (this.vesselState[m].lastSeen < stateCutoff) delete this.vesselState[m];
    });
  }

  async persist() {
    this.prune();
    this.lastSaveTs = Date.now();
    await Promise.all([
      this.state.storage.put("transits24h", this.transits24h),
      this.state.storage.put("vesselState", this.vesselState),
      this.state.storage.put("lastMsgTs", this.lastMsgTs),
    ]);
    this.dirty = false;
  }

  async alarm() {
    // Wake-up: persist + ensure connection alive
    if (this.dirty) await this.persist();
    if (!this.ws || this.ws.readyState !== 1) {
      await this.connectWs();
    }
    // Always re-schedule keepalive
    await this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  respondState() {
    this.prune();
    const categories = { transit: 0, anchored: 0, approach: 0 };
    Object.values(this.vesselState).forEach(v => {
      if (categories[v.category] !== undefined) categories[v.category]++;
    });
    return json({
      transits24h: this.transits24h.length,
      eastbound24h: this.transits24h.filter(t => t.dir === "eastbound").length,
      westbound24h: this.transits24h.filter(t => t.dir === "westbound").length,
      categories,
      vesselCount: Object.keys(this.vesselState).length,
      lastMsgAgeSec: this.lastMsgTs ? Math.floor((Date.now() - this.lastMsgTs) / 1000) : null,
      wsConnected: !!(this.ws && this.ws.readyState === 1),
      wsState: this.ws ? this.ws.readyState : -1,
    });
  }

  respondTransits(url) {
    const range = url.searchParams.get("range") || "24h";
    const m = range.match(/^(\d+)([hd])$/);
    const n = m ? parseInt(m[1], 10) : 24;
    const unit = m && m[2] === "d" ? 86400000 : 3600000;
    const cutoff = Date.now() - n * unit;
    const list = this.transits24h.filter(t => t.time > cutoff).slice(-200);
    return json({ count: list.length, transits: list });
  }
}

export default {
  async fetch(request, env) {
    const id = env.AIS.idFromName("hormuz-singleton");
    const obj = env.AIS.get(id);
    return obj.fetch(request);
  },
  async scheduled(event, env) {
    // Cron warm-up keeps DO alive
    const id = env.AIS.idFromName("hormuz-singleton");
    const obj = env.AIS.get(id);
    return obj.fetch(new Request("https://internal/__warm"));
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}
