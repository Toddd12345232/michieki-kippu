// The app's rules, kept apart from the screens so they can be tested (tools/app-tests.html).
// Nothing here touches the page or browser storage.
(function () {
  "use strict";

  const PREFS = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
    "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
    "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"];

  // Same table as scraper/regions.py BLOCK_OF. Keep the two in step.
  const BLOCKS = [
    { key: "hokkaido", label: "北海道", prefs: [1] },
    { key: "tohoku", label: "東北", prefs: [2, 3, 4, 5, 6, 7] },
    { key: "kanto", label: "関東", prefs: [8, 9, 10, 11, 12, 13, 14, 19, 20] },
    { key: "hokuriku", label: "北陸", prefs: [15, 16, 17] },
    { key: "chubu", label: "中部", prefs: [21, 22, 23, 24] },
    { key: "kinki", label: "近畿", prefs: [18, 25, 26, 27, 28, 29, 30] },
    { key: "chugoku", label: "中国", prefs: [31, 32, 33, 34, 35] },
    { key: "shikoku", label: "四国", prefs: [36, 37, 38, 39] },
    { key: "kyushu", label: "九州・沖縄", prefs: [40, 41, 42, 43, 44, 45, 46, 47] },
  ];
  const REGIONS_SHITEI = [
    { key: "kyushu", label: "九州・沖縄" }, { key: "nagano", label: "長野" }, { key: "aichi", label: "愛知" },
    { key: "mie", label: "三重" }, { key: "shizuoka", label: "静岡" }];
  const REGIONS_CARD = [
    { key: "nagano", label: "長野" }, { key: "aichi", label: "愛知" }, { key: "mie", label: "三重" },
    { key: "shizuoka", label: "静岡" }, { key: "shikoku", label: "四国" }];

  const blockOf = pref => (BLOCKS.find(b => b.prefs.includes(pref)) || {}).key || null;
  const prefCode = name => {
    if (!name) return null;
    const i = PREFS.findIndex(p => p === name || (name.length >= 2 && p.startsWith(name)));
    return i < 0 ? null : i + 1;
  };

  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });

  // Today's date and time in Japan, whatever time zone the phone is set to.
  function jst(date) {
    const p = {};
    for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
    const m = +p.month, d = +p.day;
    return { ymd: `${p.year}-${p.month}-${p.day}`, md: `${p.month}-${p.day}`, y: +p.year, m, d,
      dow: DOW[p.weekday], min: (+p.hour % 24) * 60 + +p.minute };
  }
  const toMin = hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
  const inRange = (md, [a, b]) => (a <= b ? md >= a && md <= b : md >= a || md <= b);

  function openState(sched, date) {
    if (!sched) return null;
    const j = jst(date), c = sched.closed || {};
    if ((c.fuzzy || []).some(r => inRange(j.md, r))) return null;
    if ((c.dates || []).some(r => inRange(j.md, r))) return "closed";
    if ((c.dow || []).includes(j.dow)) return "closed";
    const n = Math.ceil(j.d / 7);
    if ((c.nth || []).some(([k, w]) => k === n && w === j.dow)) return "closed";
    const h = (sched.seasons || []).find(s => s.months.includes(j.m)) || sched;
    return j.min >= toMin(h.open) && j.min < toMin(h.close) ? "open" : "closed";
  }

  const selling = st => !!(st && st.apt && st.apt.status === "selling");

  function indexStations(stations) {
    const byId = new Map(), alias = new Map();
    for (const s of stations || []) {
      byId.set(s.id, s);
      for (const a of s.alias || []) alias.set(a, s);
    }
    return { byId, alias };
  }
  const resolveStation = (idx, id) => idx.byId.get(id) || idx.alias.get(id) || null;
  const orphanTicks = (idx, ticks) => ticks.filter(t => !resolveStation(idx, t.st));

  // One 記念きっぷ, one 指定券 per region and one card per region at each station. Specials are each their own.
  const tickKey = t => (t.k === "special" ? `${t.st}|special|${t.sp}` : `${t.st}|${t.k}|${t.r || ""}`);
  function addTick(ticks, t) {
    const key = tickKey(t);
    return ticks.some(x => tickKey(x) === key) ? ticks.slice() : ticks.concat([t]);
  }
  const removeTick = (ticks, id) => ticks.filter(t => t.id !== id);

  function progress(data, ticks, opts) {
    const stations = (data && data.stations) || [];
    const idx = indexStations(stations);
    const notSold = new Set((opts && opts.notSold) || []);
    const sid = t => { const s = resolveStation(idx, t.st); return s ? s.id : t.st; };
    const stOf = id => idx.byId.get(id) || null;
    const tickedIds = (k, r) => new Set(ticks.filter(t => t.k === k && (r === undefined || t.r === r)).map(sid));

    const kippuHave = tickedIds("kippu");
    const kippuAll = new Set(stations.filter(selling).map(s => s.id));
    kippuHave.forEach(id => kippuAll.add(id));

    const regionCount = (k, field, list) => {
      const out = {};
      for (const { key } of list) {
        const have = tickedIds(k, key);
        const all = new Set(stations.filter(s => (s[field] || []).includes(key) && !notSold.has(`${s.id}:${key}`)).map(s => s.id));
        have.forEach(id => all.add(id));
        out[key] = { have: have.size, total: all.size };
      }
      return out;
    };

    const year = String(jst(new Date()).y);
    const blocks = {}, perPref = {};
    for (const b of BLOCKS) blocks[b.key] = { have: 0, total: 0 };
    for (const id of kippuAll) {
      const s = stOf(id);
      if (!s) continue;
      const b = blockOf(s.pref);
      if (b) { blocks[b].total++; if (kippuHave.has(id)) blocks[b].have++; }
    }
    for (const s of stations) {
      const p = perPref[s.pref] || (perPref[s.pref] = { selling: 0, have: 0 });
      if (selling(s)) p.selling++;
      if (kippuHave.has(s.id)) p.have++;
    }
    const prefs = new Set([...kippuHave].map(id => (stOf(id) || {}).pref).filter(Boolean));
    return {
      kippu: { have: kippuHave.size, total: kippuAll.size },
      shitei: regionCount("shitei", "shitei", REGIONS_SHITEI),
      cards: regionCount("card", "cards", REGIONS_CARD),
      specials: ticks.filter(t => t.k === "special").length,
      year: ticks.filter(t => (t.d || "").startsWith(year)).length,
      prefs: prefs.size, blocks, perPref,
    };
  }

  function addDays(ymd, n) {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function specialWindow(sp, ymd) {
    if (sp.ended) return "ended";
    if (!sp.start) return "past";
    if (sp.start > ymd) return "upcoming";
    if (sp.end) return ymd <= sp.end ? "on" : "past";
    return ymd <= addDays(sp.start, 2) ? "on" : "past";
  }

  function upcomingSpecials(specials, ymd, opts) {
    const days = (opts && opts.days) || 30, block = opts && opts.block;
    const limit = addDays(ymd, days);
    return (specials || [])
      .filter(sp => !block || blockOf(prefCode(sp.pref)) === block)
      .map(sp => ({ sp, w: specialWindow(sp, ymd) }))
      .filter(({ sp, w }) => w === "on" || (w === "upcoming" && sp.start <= limit))
      .sort((a, b) => (a.w === b.w ? (a.sp.start < b.sp.start ? -1 : a.sp.start > b.sp.start ? 1 : 0) : a.w === "on" ? -1 : 1))
      .map(x => x.sp);
  }

  function mergeBackup(cur, inc) {
    const ticks = (cur.ticks || []).map(t => Object.assign({}, t));
    const ids = new Set(ticks.map(t => t.id));
    let added = 0;
    for (const t of (inc && inc.ticks) || []) {
      const e = ticks.find(x => tickKey(x) === tickKey(t));
      if (e) {
        if (!e.d || (t.d && t.d < e.d)) e.d = t.d || e.d;
        if (!e.no && t.no) e.no = t.no;
        if (!e.note && t.note) e.note = t.note;
      } else {
        const copy = Object.assign({}, t);
        if (ids.has(copy.id)) copy.id = newId();
        ids.add(copy.id);
        ticks.push(copy);
        added++;
      }
    }
    const custom = (cur.custom || []).slice();
    for (const c of (inc && inc.custom) || []) if (!custom.some(x => x.id === c.id)) custom.push(c);
    return { ticks, custom, added };
  }

  // Ticks saved against an old station id (an a-pt-only station that michieki.jp later listed)
  // are moved to the station's current id, merging any duplicate that creates.
  function canonicalTicks(idx, ticks) {
    const moved = ticks.map(t => {
      const s = resolveStation(idx, t.st);
      return s && s.id !== t.st ? Object.assign({}, t, { st: s.id }) : t;
    });
    return mergeBackup({ ticks: [], custom: [] }, { ticks: moved }).ticks;
  }
  // Ticks at a station that the station page has no box for (a special or region no longer listed).
  const uncoveredTicks = (ticks, stationId, shownKeys) => ticks.filter(t => t.st === stationId && !shownKeys.has(tickKey(t)));

  // ---------- where am I ----------
  function distanceKm(lat1, lng1, lat2, lng2) {
    const r = Math.PI / 180, R = 6371.0088;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  const nearestStations = (stations, lat, lng, n) => (stations || [])
    .filter(s => s.lat != null && s.lng != null && !s.gone)
    .map(st => ({ st, km: distanceKm(lat, lng, st.lat, st.lng) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, n || 3);

  // What Home shows about location: the station you're at, the nearest one, or why there's no location.
  // `error` is the browser's code: 1 = not allowed, 2 = unavailable, 3 = timed out.
  function hereView(stations, here, error) {
    if (!here) return { kind: error === 1 ? "denied" : error ? "unavailable" : "waiting" };
    const [a, b] = nearestStations(stations, here.lat, here.lng, 2);
    if (!a) return { kind: "unavailable" };
    return a.km <= 1 ? { kind: "here", a, b } : { kind: "nearest", a };
  }

  // ---------- reading ticket text (from iPhone Live Text or Scan Text) ----------
  const normName = s => String(s || "").normalize("NFKC").replace(/^\s*道の駅\s*/, "").replace(/[\s・･\/／\-ー〜~★☆]/g, "");
  function bigrams(s) {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    if (!out.size && s) out.add(s);
    return out;
  }
  function similarity(a, b) {
    const A = bigrams(a), B = bigrams(b);
    let both = 0;
    A.forEach(x => { if (B.has(x)) both++; });
    return A.size + B.size ? 2 * both / (A.size + B.size) : 0;
  }
  // Printed text that is never a station name.
  const NOT_A_NAME = /記念きっぷ|配念|指定券|道の駅|道駅|発券|登録|号車|番.?席|^No|円|税込|永久|ブロック|プロック|連絡線|^KO|^[\d.'*\s]+$|\d{2}\.\s?\d/;
  const PREF_SHORT = PREFS.map(p => (p === "北海道" ? p : p.replace(/[都府県]$/, "")));
  const prefsIn = text => PREF_SHORT.map((p, i) => (text.includes(p) ? i + 1 : 0)).filter(Boolean);
  const isAddress = line => PREF_SHORT.some(p => line.startsWith(p)) && line.length > 5;
  function readDate(text) {
    const m = String(text).normalize("NFKC").match(/(?:^|[^\d])(?:20)?(\d{2})\s*[.]\s*(\d{1,2})\s*[.、]\s*(\d{1,2})(?!\d)/);
    if (!m) return "";
    const mo = +m[2], d = +m[3];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `20${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : "";
  }

  // Finds the stations printed on one or more tickets. Returns
  // [{st, k: "kippu"|"shitei"|"special", r?, sp?, nm?, no, d}] in the order they appear.
  function readTickets(text, data) {
    const stations = (data && data.stations) || [], specials = (data && data.specials) || [];
    const raw = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const lines = [];
    for (let i = 0; i < raw.length; i++) {  // a name printed with wide spacing can come out one letter per line
      if (normName(raw[i]).length === 1 && i + 1 < raw.length && normName(raw[i + 1]).length === 1) { lines.push(raw[i] + raw[i + 1]); i++; }
      else lines.push(raw[i]);
    }
    const found = [];
    lines.forEach((line, i) => {
      const n = normName(line);
      if (n.length < 2 || NOT_A_NAME.test(line) || NOT_A_NAME.test(n) || isAddress(n)) return;
      const hint = prefsIn(lines.slice(i + 1, i + 4).join(""));
      const cands = hint.length ? stations.filter(s => hint.includes(s.pref)) : stations;
      let best = null, score = 0;
      for (const s of cands) { const v = similarity(n, normName(s.name)); if (v > score) { score = v; best = s; } }
      if (best && score >= 0.5) found.push({ i, st: best });
    });
    const out = [];
    found.forEach((f, j) => {
      const until = j + 1 < found.length ? found[j + 1].i : lines.length;
      const before = lines.slice(Math.max(0, f.i - 4), f.i).join(" "), after = lines.slice(f.i + 1, f.i + 3);
      const block = lines.slice(f.i + 1, until).join("\n");
      const t = { st: f.st.id, k: "kippu", no: "", d: "" };
      const specialLine = after.find(l => /特別|非売品/.test(l));
      if (/指定券|連絡線/.test(before)) {
        t.k = "shitei"; t.r = (f.st.shitei || [])[0] || "kyushu";
        const no = block.match(/No\.?\s*(\d{3,7})/);
        if (no) t.no = no[1];
        t.d = readDate(block.split("\n").filter(l => !/登録|開|閉/.test(l)).join("\n"));
      } else if (specialLine) {
        t.k = "special";
        t.nm = specialLine.normalize("NFKC").replace(/\(非売品\)|（非売品）/g, "").trim();
        let sp = null, best = 0;
        for (const x of specials.filter(x => x.st === f.st.id)) { const v = similarity(normName(t.nm), normName(x.name || "")); if (v > best) { best = v; sp = x; } }
        if (sp && best >= 0.6) t.sp = sp.id;
      }
      if (!out.some(o => o.st === t.st && o.k === t.k && (o.sp || o.nm) === (t.sp || t.nm))) out.push(t);
    });
    // On a single ticket the stamp belongs to it; with several, the dates can't be paired reliably.
    if (out.length === 1 && out[0].k !== "shitei") out[0].d = readDate(raw.filter(l => !/登録/.test(l)).join("\n"));
    return out;
  }

  // A special ticket's text in the chosen language, falling back to a-pt's Japanese field by field.
  function spText(sp, lang) {
    const tr = lang && lang !== "ja" && sp.tr && sp.tr[lang];
    const pick = k => (tr && tr[k] ? tr[k] : sp[k]);
    return { name: pick("name"), when: pick("when"), cond: pick("cond"), limit: pick("limit"), mail: pick("mail"),
      phone: pick("phone"), extra: tr && tr.extra ? tr.extra : sp.extra || [], translated: !!tr };
  }

  const validateBackup = obj => !!obj && obj.app === "kippu" && obj.v >= 1 && Array.isArray(obj.ticks);
  const validData = d => !!d && d.v === 1 && Array.isArray(d.stations) && d.stations.length > 0;
  const pickData = (fresh, cached) => (validData(fresh) ? fresh : validData(cached) ? cached : null);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  window.K = { PREFS, BLOCKS, REGIONS_SHITEI, REGIONS_CARD, blockOf, prefCode, jst, openState, selling,
    indexStations, resolveStation, orphanTicks, tickKey, addTick, removeTick, progress, addDays, specialWindow,
    upcomingSpecials, mergeBackup, canonicalTicks, uncoveredTicks, distanceKm, nearestStations, hereView, readTickets, readDate, spText, validateBackup, pickData, newId };
})();
