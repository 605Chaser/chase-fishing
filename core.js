/* Fishing Outlook — data + scoring core (no DOM). Works in the browser and in Node for testing. */
(function (root) {
  'use strict';

  const CARD = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const card = d => CARD[Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
  const card8 = d => ['N','NE','E','SE','S','SW','W','NW'][Math.round((((d % 360) + 360) % 360) / 45) % 8];
  const hPa2in = h => h * 0.0295300;
  const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dayStart = (unix, off) => Math.floor((unix + off) / 86400) * 86400 - off;
  const localHour = (unix, off) => { const d = new Date((unix + off) * 1000); return d.getUTCHours() + d.getUTCMinutes() / 60; };

  function haversineMi(lat1, lon1, lat2, lon2) {
    const R = 3958.8, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  async function getJSON(url, opts, ms) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms || 12000);
    try {
      const r = await fetch(url, Object.assign({}, opts || {}, { signal: ac.signal }));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  /* ---------- Live data sources ---------- */

  // Open-Meteo: hourly forecast + last 24 h, in °F / mph, unix timestamps.
  async function getForecast(lat, lon) {
    const vars = 'temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation_probability,weather_code';
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&hourly=' + vars +
      '&current=temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,weather_code' +
      '&daily=temperature_2m_max,temperature_2m_min' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&timeformat=unixtime&past_days=1&forecast_days=3';
    const j = await getJSON(url);
    return normalizeForecast(j);
  }

  function normalizeForecast(j) {
    const h = j.hourly;
    return {
      tz: j.timezone, off: j.utc_offset_seconds,
      t: h.time, temp: h.temperature_2m,
      p: h.pressure_msl.map(v => v == null ? null : hPa2in(v)),
      ws: h.wind_speed_10m, wd: h.wind_direction_10m, wg: h.wind_gusts_10m,
      cc: h.cloud_cover, pp: h.precipitation_probability, wc: h.weather_code,
      cur: j.current || null,
      daily: j.daily ? { t: j.daily.time, max: j.daily.temperature_2m_max, min: j.daily.temperature_2m_min } : null,
      fetched: Date.now() / 1000
    };
  }

  // National Weather Service active alerts for a point (US only).
  async function getAlerts(lat, lon) {
    const j = await getJSON('https://api.weather.gov/alerts/active?point=' + lat.toFixed(4) + ',' + lon.toFixed(4),
      { headers: { Accept: 'application/geo+json' } });
    return (j.features || []).map(f => ({
      event: f.properties.event, headline: f.properties.headline,
      severity: f.properties.severity, ends: f.properties.ends || f.properties.expires
    }));
  }

  // USGS water temperature (parameter 00010) at the nearest live gauge.
  // Tries the new Water Data APIs first, then the legacy service (retiring Feb 2027).
  async function getWater(lat, lon) {
    for (const d of [0.5, 1.5]) {
      const bbox = [lon - d, lat - d, lon + d, lat + d].map(v => v.toFixed(4));
      let sites = [];
      for (const v of ['v0', 'v1']) {
        try {
          const j = await getJSON('https://api.waterdata.usgs.gov/ogcapi/' + v + '/collections/latest-continuous/items?f=json&parameter_code=00010&limit=200&bbox=' + bbox.join(','), null, 10000);
          sites = (j.features || []).filter(f => f.geometry && f.properties && f.properties.value != null).map(f => ({
            id: f.properties.monitoring_location_id,
            lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
            value: parseFloat(f.properties.value), unit: f.properties.unit_of_measure || 'degC',
            time: f.properties.time, name: null
          }));
          if (sites.length) break;
        } catch (e) { /* try next */ }
      }
      if (!sites.length) {
        try {
          const j = await getJSON('https://waterservices.usgs.gov/nwis/iv/?format=json&parameterCd=00010&siteStatus=active&bBox=' + bbox.join(','), null, 10000);
          sites = ((j.value && j.value.timeSeries) || []).map(ts => {
            const vals = (ts.values && ts.values[0] && ts.values[0].value) || [];
            const last = vals[vals.length - 1];
            const g = ts.sourceInfo.geoLocation.geogLocation;
            return last ? { id: ts.sourceInfo.siteCode[0].value, lat: g.latitude, lon: g.longitude,
              value: parseFloat(last.value), unit: 'degC', time: last.dateTime, name: ts.sourceInfo.siteName } : null;
          }).filter(s => s && isFinite(s.value) && s.value > -50);
        } catch (e) { /* none */ }
      }
      const fresh = sites.filter(s => !s.time || (Date.now() - Date.parse(s.time)) < 3 * 86400 * 1000);
      if (fresh.length) {
        fresh.forEach(s => { s.dist = haversineMi(lat, lon, s.lat, s.lon); });
        fresh.sort((a, b) => a.dist - b.dist);
        const s = fresh[0];
        const f = /f/i.test(s.unit) && !/c/i.test(s.unit) ? s.value : s.value * 9 / 5 + 32;
        if (!s.name && s.id) {
          try {
            const m = await getJSON('https://api.waterdata.usgs.gov/ogcapi/v0/collections/monitoring-locations/items/' + encodeURIComponent(s.id) + '?f=json', null, 6000);
            s.name = (m.properties && m.properties.monitoring_location_name) || null;
          } catch (e) { /* name optional */ }
        }
        return { f: f, name: s.name || 'USGS gauge', distMi: s.dist, time: s.time };
      }
    }
    return null;
  }

  // Place name for a coordinate (OpenStreetMap Nominatim, best effort).
  async function getPlaceName(lat, lon) {
    const j = await getJSON('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=' + lat.toFixed(4) + '&lon=' + lon.toFixed(4), null, 8000);
    const a = j.address || {};
    const town = a.city || a.town || a.village || a.hamlet || a.county;
    const iso = a['ISO3166-2-lvl4'] || '';
    const st = /^US-[A-Z]{2}$/.test(iso) ? iso.slice(3) : a.state;
    return town ? (town + (st ? ', ' + st : '')) : null;
  }

  /* ---------- Shorelines and wind (OpenStreetMap water polygons) ---------- */

  const samePt = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

  // Join open way pieces (multipolygon members) into closed rings of [lat, lon].
  function joinRings(parts) {
    const rings = [], open = [];
    parts.forEach(p => {
      if (p.length < 2) return;
      if (samePt(p[0], p[p.length - 1])) { if (p.length > 3) rings.push(p); } else open.push(p.slice());
    });
    while (open.length) {
      let cur = open.shift(), grew = true;
      while (!samePt(cur[0], cur[cur.length - 1]) && grew) {
        grew = false;
        for (let k = 0; k < open.length; k++) {
          const o = open[k], end = cur[cur.length - 1];
          if (samePt(end, o[0])) cur = cur.concat(o.slice(1));
          else if (samePt(end, o[o.length - 1])) cur = cur.concat(o.slice().reverse().slice(1));
          else continue;
          open.splice(k, 1); grew = true; break;
        }
      }
      if (samePt(cur[0], cur[cur.length - 1]) && cur.length > 3) rings.push(cur);
    }
    return rings;
  }

  function ringAreaKm2(r) {
    const k = Math.cos(r[0][0] * Math.PI / 180) * 111.32, ky = 110.57;
    let s = 0;
    for (let i = 0; i < r.length - 1; i++) s += (r[i][1] * k) * (r[i + 1][0] * ky) - (r[i + 1][1] * k) * (r[i][0] * ky);
    return Math.abs(s / 2);
  }

  // Even-odd test, so islands (inner rings) count as land.
  function insideRings(pt, rings) {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const yi = r[i][0], xi = r[i][1], yj = r[j][0], xj = r[j][1];
        if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  function waterBodiesFrom(elements, minKm2) {
    const out = [];
    (elements || []).forEach(el => {
      let parts = [];
      if (el.type === 'way' && el.geometry) parts = [el.geometry.map(p => [p.lat, p.lon])];
      else if (el.type === 'relation' && el.members) {
        parts = el.members.filter(m => m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === 'inner' || !m.role))
          .map(m => m.geometry.map(p => [p.lat, p.lon]));
      }
      const rings = joinRings(parts);
      if (!rings.length) return;
      const size = Math.max.apply(null, rings.map(ringAreaKm2));
      if (size < (minKm2 == null ? 0.1 : minKm2)) return; // skip ponds and small sloughs
      out.push({ name: (el.tags && el.tags.name) || null, rings: rings, km2: size });
    });
    return out;
  }

  // Lakes, reservoirs and river polygons inside a box (south, west, north, east).
  async function getWaterBodies(s, w, n, e) {
    const bb = [s, w, n, e].map(v => v.toFixed(4)).join(',');
    const q = '[out:json][timeout:25];(way["natural"="water"](' + bb + ');relation["natural"="water"](' + bb + ');way["landuse"="reservoir"](' + bb + '););out geom;';
    const j = await getJSON('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, 30000);
    return waterBodiesFrom(j.elements);
  }

  // Split every shoreline into runs: 'wind' = wind blowing onto this shore (bait gets pushed here),
  // 'calm' = sheltered side. Within 60° of straight on counts.
  function classifyShores(bodies, windFromDeg, lat0) {
    const toward = ((windFromDeg + 180) % 360) * Math.PI / 180;
    const T = [Math.sin(toward), Math.cos(toward)]; // x = east, y = north
    const k = Math.cos(lat0 * Math.PI / 180);
    const runs = [];
    bodies.forEach(b => {
      b.rings.forEach(r => {
        let cur = null;
        for (let i = 0; i < r.length - 1; i++) {
          const A = r[i], B = r[i + 1];
          const dx = (B[1] - A[1]) * k, dy = B[0] - A[0], L = Math.hypot(dx, dy);
          if (L < 1e-6) continue;
          const nl = [-dy / L, dx / L]; // left-hand normal
          const off = Math.min(Math.max(L * 0.3, 0.00003), 0.0005);
          const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
          const leftIsWater = insideRings([mid[0] + nl[1] * off, mid[1] + nl[0] * off / k], b.rings);
          const out = leftIsWater ? [-nl[0], -nl[1]] : nl; // points from water to land
          const a = out[0] * T[0] + out[1] * T[1];
          const cls = a >= 0.5 ? 'wind' : a <= -0.5 ? 'calm' : null;
          if (cls && cur && cur.cls === cls) cur.pts.push(B);
          else { if (cur) runs.push(cur); cur = cls ? { cls: cls, pts: [A, B], body: b.name } : null; }
        }
        if (cur) runs.push(cur);
      });
    });
    return runs;
  }

  /* ---------- Sun, moon and solunar ---------- */

  function phaseName(p) {
    if (p < 0.03 || p > 0.97) return 'New moon';
    if (p < 0.22) return 'Waxing crescent';
    if (p < 0.28) return 'First quarter';
    if (p < 0.47) return 'Waxing gibbous';
    if (p < 0.53) return 'Full moon';
    if (p < 0.72) return 'Waning gibbous';
    if (p < 0.78) return 'Last quarter';
    return 'Waning crescent';
  }

  // One local day (ds = local midnight, unix seconds).
  function astroDay(ds, lat, lon) {
    const SC = root.SunCalc;
    if (!SC) return { ds: ds, rise: null, set: null, majors: [], minors: [], ill: null, phase: null };
    const noon = new Date((ds + 43200) * 1000);
    const st = SC.getTimes(noon, lat, lon);
    const valid = d => d && !isNaN(d.getTime()) ? d.getTime() / 1000 : null;
    let maxA = -9, minA = 9, transit = null, underfoot = null, moonrise = null, moonset = null, prev = null;
    const TH = 0.00233; // ~0.13° horizon for the moon
    for (let s = ds; s <= ds + 86400; s += 300) {
      const a = SC.getMoonPosition(new Date(s * 1000), lat, lon).altitude;
      if (a > maxA) { maxA = a; transit = s; }
      if (a < minA) { minA = a; underfoot = s; }
      if (prev != null) {
        if (prev < TH && a >= TH && moonrise == null) moonrise = s;
        if (prev >= TH && a < TH && moonset == null) moonset = s;
      }
      prev = a;
    }
    const ill = SC.getMoonIllumination(noon);
    return {
      ds: ds, rise: valid(st.sunrise), set: valid(st.sunset),
      moonrise: moonrise, moonset: moonset, transit: transit, underfoot: underfoot,
      ill: ill.fraction, phase: ill.phase,
      majors: [[transit - 3600, transit + 3600], [underfoot - 3600, underfoot + 3600]],
      minors: [moonrise, moonset].filter(x => x != null).map(x => [x - 1800, x + 1800])
    };
  }

  /* ---------- Scoring ---------- */

  function trendOf(F, i) {
    const p = F.p[i], p3 = F.p[i - 3];
    if (p == null || p3 == null) return { d: 0, label: 'Steady' };
    const d = p - p3;
    let label = 'Steady';
    if (d <= -0.06) label = 'Falling fast'; else if (d <= -0.02) label = 'Falling';
    else if (d >= 0.06) label = 'Rising fast'; else if (d >= 0.02) label = 'Rising';
    return { d: d, label: label };
  }

  function scoreAt(F, i, ctx) {
    const t = F.t[i], f = [];
    const tr = trendOf(F, i), p = F.p[i];
    if (p != null) {
      if (tr.label === 'Falling fast') f.push([18, 'pressure dropping fast ahead of a system']);
      else if (tr.label === 'Falling') f.push([10, 'pressure falling']);
      else if (tr.label === 'Rising fast') f.push([-15, 'pressure climbing fast behind a front']);
      else if (tr.label === 'Rising') f.push([-7, 'pressure rising']);
      else if (p > 30.2) f.push([-3, 'high, steady pressure']);
      else f.push([2, 'steady pressure']);
    }
    const ws = F.ws[i], wg = F.wg[i] || ws;
    if (ws != null) {
      if (ws > 22 || wg > 32) f.push([-16, 'rough wind with gusts to ' + Math.round(wg) + ' mph']);
      else if (ws > 15) f.push([-5, 'a stiff ' + card(F.wd[i]) + ' wind']);
      else if (ws >= 4) f.push([8, 'a light ' + card(F.wd[i]) + ' wind putting a chop on the water']);
      else f.push([0, 'calm water']);
    }
    const a = ctx.astro(t);
    const mid = t + 1800;
    const isDay = a.rise && a.set ? (mid >= a.rise && mid <= a.set) : true;
    const cc = F.cc[i];
    if (cc != null && isDay) {
      if (cc >= 70) f.push([8, 'overcast skies']);
      else if (cc >= 40) f.push([4, 'some cloud cover']);
      else f.push([-4, 'bright, clear sky']);
    }
    if (a.rise && a.set) {
      const dr = Math.abs(mid - a.rise) / 3600, dsn = Math.abs(mid - a.set) / 3600;
      if (mid < a.rise - 3600 || mid > a.set + 3600) f.push([-12, 'darkness']);
      else if (Math.min(dr, dsn) <= 1) f.push([12, dr < dsn ? 'the low-light bite after sunrise' : 'the low-light bite around sunset']);
      else if (Math.min(dr, dsn) <= 2) f.push([5, 'light getting low']);
    }
    const inP = kind => ctx.periods.some(pr => pr[2] === kind && pr[0] < t + 3600 && pr[1] > t);
    if (inP('major')) f.push([10, 'a solunar major period']);
    else if (inP('minor')) f.push([5, 'a solunar minor period']);
    if (F.pp[i] != null && F.pp[i] >= 60) f.push([-5, 'rain likely']);
    if (F.wc[i] >= 95) f.push([-30, 'thunderstorms possible']);
    const s = clamp(Math.round(50 + f.reduce((sum, x) => sum + x[0], 0)), 0, 100);
    return { s: s, f: f };
  }

  function labelFor(s) { return s >= 80 ? 'Great' : s >= 65 ? 'Good' : s >= 50 ? 'Fair' : 'Poor'; }

  function idxAt(F, unix) {
    const i = F.t.findIndex(x => x > unix);
    return i === -1 ? F.t.length - 1 : Math.max(0, i - 1);
  }

  function outlook(F, lat, lon, nowUnix) {
    const now = nowUnix || Date.now() / 1000, off = F.off;
    const d0 = dayStart(now, off);
    const astros = [-1, 0, 1, 2].map(k => astroDay(d0 + k * 86400, lat, lon));
    const ctx = {
      astro: t => astros.find(a => t >= a.ds && t < a.ds + 86400) || astros[1],
      periods: astros.flatMap(a => a.majors.map(p => [p[0], p[1], 'major']).concat(a.minors.map(p => [p[0], p[1], 'minor'])))
    };
    const scores = F.t.map((t, i) => i < 3 ? null : scoreAt(F, i, ctx));
    const i0 = idxAt(F, now);
    const cand = [];
    for (let i = i0; i < F.t.length && F.t[i] < now + 20 * 3600; i++) {
      const h = localHour(F.t[i], off);
      if (h >= 5 && h < 21 && scores[i]) cand.push(i);
    }
    if (!cand.length && scores[i0]) cand.push(i0);
    const has = i => cand.indexOf(i) !== -1;
    let bi = cand[0], bavg = -1;
    cand.forEach(i => {
      const avg = has(i + 1) ? (scores[i].s + scores[i + 1].s) / 2 : scores[i].s;
      if (avg > bavg) { bavg = avg; bi = i; }
    });
    let st = bi, en = has(bi + 1) ? bi + 1 : bi;
    while (en - st < 3 && has(en + 1) && scores[en + 1].s >= bavg - 4) en++;
    while (en - st < 3 && has(st - 1) && scores[st - 1].s >= bavg - 4) st--;
    const winStart = Math.max(F.t[st], Math.ceil(now / 600) * 600);
    const winEnd = F.t[en] + 3600;
    const mean = cand.reduce((s, i) => s + scores[i].s, 0) / cand.length;
    const overall = Math.round(0.65 * bavg + 0.35 * mean);

    const why = scores[bi].f.slice().filter(x => x[0] !== 0)
      .sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])).slice(0, 3).map(x => x[1]);

    // Front / storm detection in the next ~30 h
    let front = null;
    for (let i = Math.max(i0, 3); i < Math.min(F.t.length, i0 + 30); i++) {
      if (F.wd[i] == null || F.wd[i - 3] == null || F.p[i] == null || F.p[i - 3] == null) continue;
      if (angDiff(F.wd[i], F.wd[i - 3]) >= 70 && F.ws[i] >= 8 && F.p[i] - F.p[i - 3] >= 0.02) {
        const g = F.wg.slice(i, i + 6).filter(x => x != null);
        front = { t: F.t[i - 2], to: card(F.wd[i]), gust: g.length ? Math.round(Math.max.apply(null, g)) : null };
        break;
      }
    }
    let storm = null;
    for (let i = i0; i < Math.min(F.t.length, i0 + 18); i++) { if (F.wc[i] >= 95) { storm = F.t[i]; break; } }

    return {
      now: now, i0: i0, d0: d0, astros: astros, today: ctx.astro(now), scores: scores, bestIdx: bi,
      overall: overall, label: labelFor(overall), why: why,
      window: { start: winStart, end: winEnd, avg: Math.round(bavg) },
      trend: trendOf(F, i0), front: front, storm: storm
    };
  }

  root.FishCore = {
    card: card, card8: card8, hPa2in: hPa2in, angDiff: angDiff, dayStart: dayStart, localHour: localHour,
    haversineMi: haversineMi, getForecast: getForecast, normalizeForecast: normalizeForecast,
    getAlerts: getAlerts, getWater: getWater, getPlaceName: getPlaceName,
    getWaterBodies: getWaterBodies, waterBodiesFrom: waterBodiesFrom, classifyShores: classifyShores,
    joinRings: joinRings, insideRings: insideRings,
    phaseName: phaseName, astroDay: astroDay, trendOf: trendOf, scoreAt: scoreAt,
    outlook: outlook, labelFor: labelFor, idxAt: idxAt
  };
})(typeof window !== 'undefined' ? window : globalThis);
