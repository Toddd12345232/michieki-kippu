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

  const validateBackup = obj => !!obj && obj.app === "kippu" && obj.v >= 1 && Array.isArray(obj.ticks);
  const validData = d => !!d && d.v === 1 && Array.isArray(d.stations) && d.stations.length > 0;
  const pickData = (fresh, cached) => (validData(fresh) ? fresh : validData(cached) ? cached : null);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  window.K = { PREFS, BLOCKS, REGIONS_SHITEI, REGIONS_CARD, blockOf, prefCode, jst, openState, selling,
    indexStations, resolveStation, orphanTicks, tickKey, addTick, removeTick, progress, addDays, specialWindow,
    upcomingSpecials, mergeBackup, canonicalTicks, uncoveredTicks, validateBackup, pickData, newId };
})();
