import * as store from "./store.js";
import { M100 } from "./m100.js";

const VERSION = "2026.10.20";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ls = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn("ls", e); } },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const COLORS = ["#2F7D4F", "#E8792B", "#2B7FFF", "#C23B8F", "#8A5CF6", "#B8930A", "#16A3A3", "#D9472B"];
const LV = ["", "쉬움", "보통", "어려움"];
const SUMMIT_KM = 0.35;  // GPS within this of the summit point counts as reaching it
const BYN = Object.fromEntries(M100.map((m) => [m.n, m]));

const S = {
  people: [], hikes: [], stamps: [],
  me: ls.get("gs-me", ""), who: "all", smode: "board", prov: "",
  mapStyle: ls.get("gs-map", "topo"),
  pos: null, follow: true, group: { name: "" },
};

/* ---------- formatting ---------- */
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const dateKo = (t) => { const d = new Date(t); return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} (${"일월화수목금토"[d.getDay()]})`; };
const clock = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const hms = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`; };
const durKo = (s) => { const h = Math.floor(s / 3600), m = Math.round(s / 60) % 60; return h ? `${h}시간 ${m}분` : `${m}분`; };
const km = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1);
const person = (id) => S.people.find((p) => p.id === id);
const pname = (id) => person(id)?.name || "알 수 없음";
const pcolor = (id) => person(id)?.color || "#999";

function hav(a1, o1, a2, o2) {
  const R = 6371000, r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r;
  const x = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function nearest(lat, lng) {
  let best = null, bd = Infinity;
  for (const m of M100) { const d = hav(lat, lng, m.lat, m.lng); if (d < bd) { bd = d; best = m; } }
  return { m: best, d: bd };
}

/* Google polyline encoding keeps a 5-hour track around 20KB. */
function encodePoly(pts) {
  let out = "", pl = 0, pg = 0;
  const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [a, o] of pts) { const la = Math.round(a * 1e5), lo = Math.round(o * 1e5); enc(la - pl); enc(lo - pg); pl = la; pg = lo; }
  return out;
}
function decodePoly(s) {
  const pts = []; let i = 0, la = 0, lo = 0;
  const dec = () => { let r = 0, sh = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < s.length) { la += dec(); lo += dec(); pts.push([la / 1e5, lo / 1e5]); }
  return pts;
}
function hikeTrack(h) {
  const ll = decodePoly(h.poly || ""), alts = (h.alts || "").split(","), ts = (h.ts || "").split(",");
  return ll.map(([a, o], i) => [a, o, alts[i] === "" || alts[i] == null ? null : +alts[i], h.start + (+ts[i] || 0) * 1000]);
}

/* ---------- ui utils ---------- */
let toastT;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms);
}
function sheet(html, { locked = false, onClose } = {}) {
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet"><div class="grab"></div>${html}</div>`;
  document.body.append(bg);
  const close = () => { bg.remove(); onClose?.(); };
  if (!locked) bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  return { el: $(".sheet", bg), close };
}
function ask(msg, ok = "확인", danger = false) {
  return new Promise((res) => {
    const s = sheet(`<p style="font-size:16px;margin:6px 0 16px">${esc(msg)}</p>
      <div class="row"><button class="btn ghost" data-a="0">취소</button><button class="btn ${danger ? "rec" : "pri"}" data-a="1">${esc(ok)}</button></div>`,
      { onClose: () => res(false) });
    $$("[data-a]", s.el).forEach((b) => b.onclick = () => { res(b.dataset.a === "1"); s.close(); });
  });
}
function peopleChecks(selected) {
  return S.people.map((p) => `<label class="check"><input type="checkbox" value="${esc(p.id)}" ${selected.includes(p.id) ? "checked" : ""}>
    <span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}${p.id === S.me ? ' <span class="sub">(나)</span>' : ""}</label>`).join("");
}
const checked = (el) => $$("input[type=checkbox]:checked", el).map((i) => i.value);
const stars = (lv) => `<span class="lv">${"★".repeat(lv)}</span><span class="lvoff">${"★".repeat(3 - lv)}</span>`;
function sealHtml(label, sub) { return `<div class="seal"><i><span>${esc(label)}<small>${esc(sub)}</small></span></i></div>`; }

/* ---------- maps ---------- */
const TILES = {
  topo: ["https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { subdomains: "abc", maxNativeZoom: 17, maxZoom: 18, attribution: "© OpenStreetMap · OpenTopoMap" }],
  osm: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }],
};
const TRAILS = ["https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png", { maxNativeZoom: 17, maxZoom: 18, opacity: 0.7 }];
function makeMap(el, opts = {}) {
  const m = L.map(el, { zoomControl: false, ...opts });
  const [u, o] = TILES[S.mapStyle] || TILES.topo;
  L.tileLayer(u, { ...o, crossOrigin: true }).addTo(m);
  L.tileLayer(TRAILS[0], { ...TRAILS[1], crossOrigin: true }).addTo(m);
  m.attributionControl.setPrefix(false);
  return m;
}
const peakIcon = (done) => L.divIcon({ className: "", html: `<div class="pin" style="${done ? "background:var(--seal)" : ""}"></div>`, iconSize: [14, 14] });

/* Pre-cache tiles around a summit so the map works without signal (service worker stores them). */
async function prefetchTiles(m) {
  const lon2x = (lng, z) => Math.floor((lng + 180) / 360 * 2 ** z);
  const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
  const d = 0.035, urls = [];
  for (let z = 11; z <= 15; z++) {
    for (let x = lon2x(m.lng - d, z); x <= lon2x(m.lng + d, z); x++) {
      for (let y = lat2y(m.lat + d, z); y <= lat2y(m.lat - d, z); y++) {
        const sub = "abc"[Math.abs(x + y) % 3];
        urls.push(TILES[S.mapStyle][0].replace("{s}", sub).replace("{z}", z).replace("{x}", x).replace("{y}", y));
        urls.push(TRAILS[0].replace("{z}", z).replace("{x}", x).replace("{y}", y));
      }
    }
  }
  let ok = 0;
  for (let i = 0; i < urls.length; i += 6) {
    const r = await Promise.all(urls.slice(i, i + 6).map((u) => fetch(u, { mode: "cors" }).then((x) => x.ok).catch(() => false)));
    ok += r.filter(Boolean).length;
    toast(`지도 받는 중… ${Math.round((i + 6) / urls.length * 100)}%`, 1500);
  }
  toast(ok > urls.length * 0.8 ? `${m.name} 주변 지도를 저장했어요. 신호가 없어도 보여요.` : "일부 지도를 받지 못했어요. 와이파이에서 다시 해 보세요.", 3500);
}

/* ---------- tabs ---------- */
let curView = "rec";
function show(v) {
  curView = v;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  $$(".view").forEach((s) => s.classList.toggle("hidden", s.id !== "v-" + v));
  if (v === "rec") setTimeout(() => recMap?.invalidateSize(), 0);
  if (v === "stamps") renderStamps();
  if (v === "feed") renderFeed();
  if (v === "fam") renderFam();
}
$$("#tabs button").forEach((b) => b.onclick = () => show(b.dataset.v));

/* ---------- recording ---------- */
let recMap, meMarker, accCircle, recLine, watchId = null, wakeLock = null, timer = null;
let rec = ls.get("gs-rec", null);

function initRecMap() {
  recMap = makeMap("recmap", { center: [36.4, 127.9], zoom: 7 });
  recLine = L.polyline([], { color: "#D9472B", weight: 5, opacity: 0.9 }).addTo(recMap);
  recMap.on("dragstart", () => setFollow(false));
  $("#follow").onclick = () => { setFollow(true); if (S.pos) recMap.setView([S.pos.lat, S.pos.lng], Math.max(recMap.getZoom(), 15)); };
  M100.forEach((m) => L.marker([m.lat, m.lng], { icon: peakIcon(false) }).addTo(recMap).bindTooltip(`${m.name} ${m.h}m`));
  setFollow(true);
}
function setFollow(on) { S.follow = on; $("#follow").classList.toggle("on", on); }

function startWatch() {
  if (!("geolocation" in navigator)) { $("#gpstxt").textContent = "이 브라우저는 위치를 지원하지 않아요"; return; }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(onPos, (e) => {
    $("#gps").className = "gps bad";
    $("#gpstxt").textContent = e.code === 1 ? "위치 권한이 꺼져 있어요. 브라우저 설정에서 허용해 주세요." : "GPS 신호를 찾는 중…";
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

let firstFix = true;
function onPos(p) {
  const c = { lat: p.coords.latitude, lng: p.coords.longitude, alt: p.coords.altitude, acc: p.coords.accuracy, t: p.timestamp || Date.now() };
  S.pos = c;
  $("#gps").className = "gps " + (c.acc <= 30 ? "ok" : "bad");
  $("#gpstxt").textContent = `GPS 정확도 ±${Math.round(c.acc)}m` + (c.alt == null ? " · 고도 없음" : "");
  const ll = [c.lat, c.lng];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18] }), zIndexOffset: 1000 }).addTo(recMap);
    accCircle = L.circle(ll, { radius: c.acc, weight: 0, fillOpacity: 0.12 }).addTo(recMap);
  } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(c.acc); }
  if (S.follow) recMap.setView(ll, firstFix ? 15 : recMap.getZoom(), { animate: !firstFix });
  firstFix = false;
  if (rec && !rec.paused) addPoint(c);
  showNear();
}

function showNear() {
  const c = S.pos; if (!c) return;
  const { m, d } = nearest(c.lat, c.lng);
  const el = $("#near");
  if (d > 30000) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const done = rec?.summits?.includes(m.n);
  const up = c.alt != null && !done ? ` · 고도차 ${Math.max(0, Math.round(m.h - c.alt))}m` : "";
  el.innerHTML = done ? `🎉 <b>${esc(m.name)}</b> 정상 도장 획득!`
    : `⛰️ <span><b>${esc(m.name)}</b> ${esc(m.peak === "정상" ? "정상" : m.peak)}까지 ${d < 1000 ? Math.round(d) + "m" : (d / 1000).toFixed(1) + "km"}${up}</span>`;
}

function addPoint(c) {
  const pts = rec.points, prev = pts[pts.length - 1];
  if (c.acc > (pts.length ? 35 : 100)) return;
  if (prev) {
    const d = hav(prev[0], prev[1], c.lat, c.lng), dt = (c.t - prev[3]) / 1000;
    if (d < 8 && dt < 60) return;
    if (dt > 0 && d / dt > 12 && dt < 60) return;   // GPS jump
    rec.dist += d;
  }
  let alt = null;
  if (c.alt != null) {
    rec.altS = rec.altS == null ? c.alt : rec.altS * 0.7 + c.alt * 0.3;
    alt = Math.round(rec.altS);
    if (rec.ref == null) rec.ref = rec.altS;
    if (rec.altS - rec.ref >= 4) { rec.gain += rec.altS - rec.ref; rec.ref = rec.altS; }
    else if (rec.ref - rec.altS >= 4) { rec.loss += rec.ref - rec.altS; rec.ref = rec.altS; }
    rec.maxAlt = Math.max(rec.maxAlt ?? -1e9, alt); rec.minAlt = Math.min(rec.minAlt ?? 1e9, alt);
  }
  pts.push([+c.lat.toFixed(6), +c.lng.toFixed(6), alt, c.t]);
  recLine.addLatLng([c.lat, c.lng]);
  for (const m of M100) {
    if (!rec.summits.includes(m.n) && hav(c.lat, c.lng, m.lat, m.lng) < SUMMIT_KM * 1000) {
      rec.summits.push(m.n);
      navigator.vibrate?.([200, 100, 200]);
      toast(`🎉 ${m.name} 정상 도착! 도장 쾅`, 4000);
    }
  }
  saveRec();
  paintStats();
}
function saveRec() { ls.set("gs-rec", rec); }

const elapsed = () => rec ? (Date.now() - rec.start - rec.pausedMs - (rec.paused ? Date.now() - rec.pauseStart : 0)) / 1000 : 0;
function paintStats() {
  if (!rec) return;
  $("#s-time").textContent = hms(elapsed());
  $("#s-dist").textContent = km(rec.dist);
  const last = rec.points[rec.points.length - 1];
  $("#s-alt").textContent = last && last[2] != null ? last[2] : (S.pos?.alt != null ? Math.round(S.pos.alt) : "–");
  $("#s-gain").textContent = Math.round(rec.gain);
}
function paintRec() {
  $("#idle").classList.toggle("hidden", !!rec);
  $("#running").classList.toggle("hidden", !rec);
  if (!rec) return;
  $("#pause").textContent = rec.paused ? "▶ 다시 걷기" : "⏸ 쉬기";
  paintStats();
}

async function lockScreen() {
  try { if ("wakeLock" in navigator && rec) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { console.warn("wakelock", e); }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && rec) lockScreen(); });

function beginTimer() { clearInterval(timer); timer = setInterval(() => { paintStats(); }, 1000); }

$("#start").onclick = () => {
  if (!S.me) return toast("가족 탭에서 '나'를 먼저 정해 주세요");
  rec = { id: store.newId(), start: Date.now(), points: [], paused: false, pauseStart: 0, pausedMs: 0, dist: 0, gain: 0, loss: 0, altS: null, ref: null, summits: [], photos: 0 };
  recLine.setLatLngs([]);
  saveRec(); paintRec(); beginTimer(); lockScreen(); setFollow(true);
  if (S.pos) addPoint({ ...S.pos, t: Date.now() });
  toast("기록을 시작했어요. 화면을 켜 두세요.");
};
$("#pause").onclick = () => {
  if (rec.paused) { rec.pausedMs += Date.now() - rec.pauseStart; rec.paused = false; }
  else { rec.paused = true; rec.pauseStart = Date.now(); }
  saveRec(); paintRec();
};
$("#stop").onclick = async () => { if (await ask("산행을 끝낼까요?", "끝내기")) finishSheet(); };
$("#photo").onclick = () => $("#photoin").click();
$("#photoin").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f || !rec) return;
  try {
    const img = await shrink(f);
    const c = S.pos || {};
    await store.put("photos", store.newId(), { hike: rec.id, by: S.me, t: Date.now(), lat: c.lat ?? null, lng: c.lng ?? null, img });
    rec.photos++; saveRec();
    if (c.lat != null) L.marker([c.lat, c.lng], { icon: L.divIcon({ className: "", html: `<div class="pic-pin" style="background-image:url(${img})"></div>`, iconSize: [30, 30] }) }).addTo(recMap);
    toast("사진을 저장했어요");
  } catch (err) { console.warn(err); toast("사진을 저장하지 못했어요"); }
};

async function shrink(file, max = 1080) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
    const cv = document.createElement("canvas");
    cv.width = Math.round(im.naturalWidth * k); cv.height = Math.round(im.naturalHeight * k);
    cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height);
    let out = cv.toDataURL("image/jpeg", 0.72);
    if (out.length > 700000) out = cv.toDataURL("image/jpeg", 0.5);
    return out;
  } finally { URL.revokeObjectURL(url); }
}

function guessTitle(r) {
  if (r.summits.length) return r.summits.map((n) => BYN[n].name.replace(/ \(.+\)$/, "")).join(" · ") + " 산행";
  const pts = r.points;
  if (pts.length) {
    const hi = pts.reduce((a, p) => (p[2] ?? -1e9) > (a[2] ?? -1e9) ? p : a, pts[0]);
    const { m, d } = nearest(hi[0], hi[1]);
    if (d < 5000) return `${m.name.replace(/ \(.+\)$/, "")} 산행`;
  }
  const d = new Date(r.start);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 산행`;
}

function finishSheet() {
  // Re-check every point against summits in case a fix arrived while the page was hidden.
  for (const p of rec.points) for (const m of M100) if (!rec.summits.includes(m.n) && hav(p[0], p[1], m.lat, m.lng) < SUMMIT_KM * 1000) rec.summits.push(m.n);
  const secs = elapsed();
  const s = sheet(`
    <h2>산행 저장</h2>
    <label class="field">제목</label><input id="f-title" value="${esc(guessTitle(rec))}" maxlength="40">
    <div class="kv">
      <div><b>${km(rec.dist)}</b><span>거리 km</span></div>
      <div><b>${durKo(secs)}</b><span>걸은 시간</span></div>
      <div><b>${Math.round(rec.gain)}</b><span>오른 높이 m</span></div>
    </div>
    ${rec.summits.length ? `<div class="card" style="margin-bottom:12px"><b>🎉 도장 획득</b><div class="people" style="margin-top:8px">${rec.summits.map((n) => `<span class="chip">${esc(BYN[n].name)} ${BYN[n].h}m</span>`).join("")}</div></div>` : ""}
    <label class="field">함께한 사람 ${rec.summits.length ? "(모두 도장을 받아요)" : ""}</label>
    <div class="list" id="f-people">${peopleChecks([S.me])}</div>
    <div class="list" style="margin-top:16px">
      <button class="btn pri block" id="f-save">저장하기</button>
      <button class="btn ghost block" id="f-back">계속 기록하기</button>
      <button class="btn danger block" id="f-drop">기록 버리기</button>
    </div>`, { locked: true });
  $("#f-back", s.el).onclick = () => s.close();
  $("#f-drop", s.el).onclick = async () => {
    if (!(await ask("이 산행 기록과 사진을 지울까요? 되돌릴 수 없어요.", "버리기", true))) return;
    for (const p of await store.photosOf(rec.id).catch(() => [])) await store.del("photos", p.id);
    s.close(); endRec();
  };
  $("#f-save", s.el).onclick = async (e) => {
    e.target.disabled = true;
    const people = checked($("#f-people", s.el));
    if (!people.length) { e.target.disabled = false; return toast("함께한 사람을 한 명 이상 골라 주세요"); }
    const id = await saveHike(rec, $("#f-title", s.el).value.trim() || guessTitle(rec), people, secs);
    s.close(); endRec();
    show("feed"); openHike(id);
  };
}

async function saveHike(r, title, people, secs) {
  const pts = r.points;
  const h = {
    title, by: S.me, people, start: r.start, end: Date.now(), moving: Math.round(secs),
    dist: Math.round(r.dist), gain: Math.round(r.gain), loss: Math.round(r.loss),
    maxAlt: r.maxAlt ?? null, minAlt: r.minAlt ?? null, summits: r.summits, photos: r.photos,
    poly: encodePoly(pts), alts: pts.map((p) => p[2] ?? "").join(","), ts: pts.map((p) => Math.round((p[3] - r.start) / 1000)).join(","),
  };
  await store.put("hikes", r.id, h);
  for (const pid of people) for (const n of r.summits) {
    const sid = `${pid}_${n}`;
    if (!S.stamps.some((x) => x.id === sid)) await store.put("stamps", sid, { pid, n, date: ymd(r.start), hike: r.id });
  }
  toast(r.summits.length ? `저장 완료! 도장 ${r.summits.length * people.length}개를 찍었어요` : "산행을 저장했어요");
  return r.id;
}

function endRec() {
  rec = null; ls.del("gs-rec"); clearInterval(timer);
  wakeLock?.release().catch(() => {}); wakeLock = null;
  recLine.setLatLngs([]);
  paintRec(); showNear();
}

/* ---------- stamps ---------- */
let stampMap = null;
function doneSet() {
  const st = S.who === "all" ? S.stamps : S.stamps.filter((s) => s.pid === S.who);
  const by = new Map();
  for (const s of st) { const cur = by.get(s.n); if (!cur || s.date < cur.date) by.set(s.n, s); }
  return by;
}
function renderStamps() {
  const done = doneSet();
  const n = done.size, C = 2 * Math.PI * 15.5;
  $("#ring").innerHTML = `<circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--line)" stroke-width="4"/>
    <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--seal)" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C * n / 100} ${C}" transform="rotate(-90 18 18)"/>
    <text x="18" y="21.5" text-anchor="middle" font-size="9" font-weight="700" fill="var(--ink)">${n}%</text>`;
  $("#progn").textContent = `${n} / 100`;
  $("#progsub").textContent = S.who === "all" ? "가족 모두 합친 100대 명산" : `${pname(S.who)}의 100대 명산`;
  $("#whochips").innerHTML = [`<button class="chip ${S.who === "all" ? "on" : ""}" data-w="all">가족 전체</button>`]
    .concat(S.people.map((p) => `<button class="chip ${S.who === p.id ? "on" : ""}" data-w="${esc(p.id)}"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)} ${new Set(S.stamps.filter((s) => s.pid === p.id).map((s) => s.n)).size}</button>`)).join("");
  $$("#whochips [data-w]").forEach((b) => b.onclick = () => { S.who = b.dataset.w; renderStamps(); });
  const provs = [...new Set(M100.map((m) => m.prov))].sort();
  $("#prov").innerHTML = `<option value="">전체 지역</option>` + provs.map((p) => `<option ${S.prov === p ? "selected" : ""}>${esc(p)}</option>`).join("");
  $("#prov").onchange = (e) => { S.prov = e.target.value; renderStamps(); };
  $$("#smode button").forEach((b) => { b.classList.toggle("on", b.dataset.m === S.smode); b.onclick = () => { S.smode = b.dataset.m; renderStamps(); }; });
  const list = M100.filter((m) => !S.prov || m.prov === S.prov);
  $("#board").classList.toggle("hidden", S.smode !== "board");
  $("#stampmap").classList.toggle("hidden", S.smode !== "map");
  if (S.smode === "board") {
    $("#board").innerHTML = list.map((m) => {
      const s = done.get(m.n);
      return `<button class="cell ${s ? "done" : ""}" data-n="${m.n}"><div class="no">${m.n}</div><div class="nm">${esc(m.name.replace(" (", "\n("))}</div><div class="ht">${m.h}m</div>${s ? sealHtml("완등", s.date.slice(2).replace(/-/g, ".")) : ""}</button>`;
    }).join("");
    $$("#board .cell").forEach((c) => c.onclick = () => openMountain(+c.dataset.n));
  } else {
    if (!stampMap) { stampMap = makeMap("stampmap", { center: [36.3, 127.8], zoom: 7 }); stampMap._marks = L.layerGroup().addTo(stampMap); }
    stampMap._marks.clearLayers();
    for (const m of list) L.marker([m.lat, m.lng], { icon: peakIcon(done.has(m.n)) }).addTo(stampMap._marks).bindTooltip(`${m.name} ${m.h}m`).on("click", () => openMountain(m.n));
    setTimeout(() => stampMap.invalidateSize(), 0);
  }
}

function openMountain(n) {
  const m = BYN[n];
  const rows = S.people.map((p) => {
    const st = S.stamps.filter((s) => s.pid === p.id && s.n === n).sort((a, b) => a.date.localeCompare(b.date))[0];
    return `<div class="check"><span class="dot" style="background:${esc(p.color)}"></span><span style="flex:1">${esc(p.name)}</span>
      ${st ? `<span style="color:var(--seal);font-weight:700">완등 ${esc(st.date.replace(/-/g, "."))}</span><button class="sub" data-un="${esc(st.id)}">취소</button>` : `<span class="sub">아직</span>`}</div>`;
  }).join("");
  const hikes = S.hikes.filter((h) => (h.summits || []).includes(n)).sort((a, b) => b.start - a.start);
  const s = sheet(`
    <div class="sub">100대 명산 ${m.n}번 · ${esc(m.region)}</div>
    <h2>${esc(m.name)} <span class="sub" style="font-size:16px">${m.h}m</span></h2>
    <div id="mmap" class="map"></div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center"><b>대표 코스</b><span>${stars(m.lv)} <span class="sub">${LV[m.lv]}</span></span></div>
      <p style="margin:8px 0 4px">${esc(m.course)}</p>
      <div class="sub">약 ${m.hours}시간 · 도장 지점: ${esc(m.peak)} · 코스와 시간은 참고용이에요. 출발 전에 통제 구간을 확인하세요.</div>
    </div>
    <div class="row" style="margin-top:10px">
      <a class="btn" href="https://map.kakao.com/link/map/${encodeURIComponent(m.name + " " + m.peak)},${m.lat},${m.lng}" target="_blank" rel="noopener">카카오맵</a>
      <button class="btn" id="m-dl">지도 미리 받기</button>
    </div>
    <label class="field">가족 도장</label>
    <div class="list" id="m-rows">${rows || '<div class="sub">가족 탭에서 사람을 추가하세요</div>'}</div>
    <button class="btn pri block" id="m-manual" style="margin-top:12px">다녀왔어요 (직접 도장 찍기)</button>
    <div id="m-form" class="hidden" style="margin-top:12px">
      <label class="field">다녀온 날</label><input type="date" id="m-date" value="${ymd(Date.now())}" max="${ymd(Date.now())}">
      <label class="field">누가 다녀왔나요?</label><div class="list" id="m-people">${peopleChecks([S.me])}</div>
      <button class="btn pri block" id="m-ok" style="margin-top:12px">도장 찍기</button>
    </div>
    ${hikes.length ? `<label class="field">이 산 산행 기록</label><div class="list">${hikes.map(hikeCard).join("")}</div>` : ""}`);
  const mm = makeMap($("#mmap", s.el), { center: [m.lat, m.lng], zoom: 13 });
  L.marker([m.lat, m.lng], { icon: peakIcon(doneSet().has(n)) }).addTo(mm).bindTooltip(m.peak, { permanent: true, direction: "top", offset: [0, -6] });
  setTimeout(() => mm.invalidateSize(), 50);
  $("#m-dl", s.el).onclick = () => prefetchTiles(m);
  $("#m-manual", s.el).onclick = (e) => { e.target.classList.add("hidden"); $("#m-form", s.el).classList.remove("hidden"); };
  $("#m-ok", s.el).onclick = async () => {
    const date = $("#m-date", s.el).value || ymd(Date.now()), who = checked($("#m-people", s.el));
    if (!who.length) return toast("누가 다녀왔는지 골라 주세요");
    for (const pid of who) await store.put("stamps", `${pid}_${n}`, { pid, n, date, manual: true });
    toast(`${m.name} 도장 쾅!`); s.close();
  };
  $$("[data-un]", s.el).forEach((b) => b.onclick = async () => {
    if (!(await ask("이 도장을 지울까요?", "지우기", true))) return;
    await store.del("stamps", b.dataset.un); s.close(); openMountain(n);
  });
  bindHikeCards(s.el, s.close);
}

/* ---------- feed ---------- */
function thumb(h) {
  const pts = decodePoly(h.poly || "");
  if (pts.length < 2) return `<svg class="thumb" viewBox="0 0 64 64"><text x="32" y="38" text-anchor="middle" font-size="22">⛰️</text></svg>`;
  const la = pts.map((p) => p[0]), lo = pts.map((p) => p[1]);
  const [a0, a1, o0, o1] = [Math.min(...la), Math.max(...la), Math.min(...lo), Math.max(...lo)];
  const k = Math.cos(a0 * Math.PI / 180), span = Math.max(a1 - a0, (o1 - o0) * k) || 1e-4;
  const step = Math.ceil(pts.length / 150);
  const d = pts.filter((_, i) => i % step === 0 || i === pts.length - 1)
    .map((p) => `${(8 + ((p[1] - o0) * k + (span - (o1 - o0) * k) / 2) / span * 48).toFixed(1)},${(56 - ((p[0] - a0) + (span - (a1 - a0)) / 2) / span * 48).toFixed(1)}`).join(" ");
  return `<svg class="thumb" viewBox="0 0 64 64"><polyline points="${d}" fill="none" stroke="var(--rec)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function hikeCard(h) {
  return `<button class="card hike" data-h="${esc(h.id)}">${thumb(h)}<div style="min-width:0;flex:1">
    <div class="t">${esc(h.title)}</div>
    <div class="sub">${dateKo(h.start)} · ${km(h.dist)}km · ${durKo(h.moving)} · ↑${h.gain}m</div>
    <div class="people" style="margin-top:4px">${(h.people || []).map((p) => `<span class="sub" style="display:inline-flex;align-items:center;gap:4px"><span class="dot" style="background:${esc(pcolor(p))}"></span>${esc(pname(p))}</span>`).join("")}
    ${(h.summits || []).length ? `<span style="color:var(--seal);font-size:13px;font-weight:700">· 도장 ${h.summits.length}</span>` : ""}</div></div></button>`;
}
function bindHikeCards(root, before) { $$("[data-h]", root).forEach((b) => b.onclick = () => { before?.(); openHike(b.dataset.h); }); }
function renderFeed() {
  const hs = [...S.hikes].sort((a, b) => b.start - a.start);
  $("#feed").innerHTML = hs.length ? hs.map(hikeCard).join("") : `<div class="empty">아직 산행 기록이 없어요.<br>기록 탭에서 <b>산행 시작</b>을 눌러 보세요.</div>`;
  bindHikeCards($("#feed"));
}

function profileSvg(track) {
  const pts = track.filter((p) => p[2] != null);
  if (pts.length < 3) return "";
  let d = 0; const xs = [0];
  for (let i = 1; i < pts.length; i++) { d += hav(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); xs.push(d); }
  const alts = pts.map((p) => p[2]), lo = Math.min(...alts), hi = Math.max(...alts), rng = Math.max(hi - lo, 30);
  const W = 320, H = 100, step = Math.ceil(pts.length / 300);
  const line = pts.map((p, i) => [xs[i], p[2]]).filter((_, i) => i % step === 0 || i === pts.length - 1)
    .map(([x, a]) => `${(x / (d || 1) * W).toFixed(1)},${(H - 6 - (a - lo) / rng * (H - 22)).toFixed(1)}`).join(" ");
  return `<svg class="prof" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polygon points="0,${H} ${line} ${W},${H}" fill="var(--pri-soft)"/><polyline points="${line}" fill="none" stroke="var(--pri)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <text x="4" y="12" font-size="10" fill="var(--sub)">최고 ${hi}m</text><text x="${W - 4}" y="${H - 4}" font-size="10" fill="var(--sub)" text-anchor="end">${km(d)}km</text></svg>`;
}

async function openHike(id) {
  const h = S.hikes.find((x) => x.id === id);
  if (!h) return;
  const track = hikeTrack(h);
  const spd = h.moving ? (h.dist / 1000) / (h.moving / 3600) : 0;
  const s = sheet(`
    <div class="sub">${dateKo(h.start)} ${clock(h.start)}–${clock(h.end)}</div>
    <h2 id="h-title">${esc(h.title)}</h2>
    <div class="people" style="margin-top:8px">${(h.people || []).map((p) => `<span class="chip"><span class="dot" style="background:${esc(pcolor(p))}"></span>${esc(pname(p))}</span>`).join("")}</div>
    ${track.length > 1 ? `<div id="hmap" class="map"></div>` : `<p class="sub">저장된 경로가 없어요.</p>`}
    <div class="kv">
      <div><b>${km(h.dist)}</b><span>거리 km</span></div>
      <div><b>${durKo(h.moving)}</b><span>걸은 시간</span></div>
      <div><b>${h.gain}</b><span>오른 높이 m</span></div>
      <div><b>${h.maxAlt ?? "–"}</b><span>최고 고도 m</span></div>
      <div><b>${spd.toFixed(1)}</b><span>평균 km/h</span></div>
      <div><b>${(h.summits || []).length}</b><span>획득 도장</span></div>
    </div>
    ${(h.summits || []).length ? `<div class="people">${h.summits.map((n) => `<button class="chip" data-m="${n}" style="color:var(--seal);border-color:var(--seal)">🔴 ${esc(BYN[n].name)}</button>`).join("")}</div>` : ""}
    ${profileSvg(track)}
    <div class="photos" id="h-photos">${h.photos ? '<span class="sub">사진 불러오는 중…</span>' : ""}</div>
    <div class="list" style="margin-top:12px">
      <button class="btn pri block" id="h-share">이미지로 공유하기</button>
      <div class="row"><button class="btn ghost" id="h-rename">제목 바꾸기</button><button class="btn danger" id="h-del">삭제</button></div>
    </div>`);
  let hm = null;
  if (track.length > 1) {
    hm = makeMap($("#hmap", s.el), { center: [track[0][0], track[0][1]], zoom: 13 });
    const line = L.polyline(track.map((p) => [p[0], p[1]]), { color: "#D9472B", weight: 5 }).addTo(hm);
    L.circleMarker(track[0].slice(0, 2), { radius: 6, color: "#fff", weight: 2, fillColor: "#2DB55D", fillOpacity: 1 }).addTo(hm).bindTooltip("출발");
    L.circleMarker(track[track.length - 1].slice(0, 2), { radius: 6, color: "#fff", weight: 2, fillColor: "#D9472B", fillOpacity: 1 }).addTo(hm).bindTooltip("도착");
    for (const n of h.summits || []) L.marker([BYN[n].lat, BYN[n].lng], { icon: peakIcon(true) }).addTo(hm).bindTooltip(BYN[n].name);
    setTimeout(() => { hm.invalidateSize(); hm.fitBounds(line.getBounds(), { padding: [20, 20] }); }, 50);
  }
  $$("[data-m]", s.el).forEach((b) => b.onclick = () => { s.close(); openMountain(+b.dataset.m); });
  $("#h-rename", s.el).onclick = async () => {
    const t = $("#h-title", s.el);
    t.innerHTML = `<div class="row"><input id="h-t" value="${esc(h.title)}" maxlength="40"><button class="btn pri" style="flex:0 0 auto" id="h-tok">저장</button></div>`;
    $("#h-tok", s.el).onclick = async () => { const v = $("#h-t", s.el).value.trim(); if (v) { await store.put("hikes", h.id, { ...h, title: v }); s.close(); openHike(h.id); } };
  };
  $("#h-del", s.el).onclick = async () => {
    if (!(await ask("이 산행을 삭제할까요? 이 산행으로 찍은 도장과 사진도 지워져요.", "삭제", true))) return;
    for (const p of await store.photosOf(h.id).catch(() => [])) await store.del("photos", p.id);
    for (const st of S.stamps.filter((x) => x.hike === h.id)) await store.del("stamps", st.id);
    await store.del("hikes", h.id);
    s.close(); toast("삭제했어요");
  };
  let photos = [];
  $("#h-share", s.el).onclick = () => shareHike(h, track, photos);
  if (h.photos) {
    photos = await store.photosOf(h.id).catch(() => []);
    const box = $("#h-photos", s.el);
    if (!box) return;
    box.innerHTML = photos.map((p, i) => `<img src="${p.img}" data-i="${i}" alt="">`).join("") || '<span class="sub">사진을 불러오지 못했어요.</span>';
    $$("img", box).forEach((im) => im.onclick = () => {
      const v = document.createElement("div"); v.className = "photoview"; v.innerHTML = `<img src="${photos[im.dataset.i].img}" alt="">`;
      v.onclick = () => v.remove(); document.body.append(v);
    });
    if (hm) for (const p of photos) if (p.lat != null) L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html: `<div class="pic-pin" style="background-image:url(${p.img})"></div>`, iconSize: [30, 30] }) }).addTo(hm);
  }
}

async function shareHike(h, track, photos) {
  const W = 1080, H = 1350, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const font = (w, px) => `${w} ${px}px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif`;
  g.fillStyle = "#F3F5F1"; g.fillRect(0, 0, W, H);
  const box = { x: 60, y: 60, w: 960, h: 760 };
  const photo = photos.find((p) => p.img);
  if (photo) {
    const im = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = photo.img; });
    if (im) {
      const k = Math.max(box.w / im.width, box.h / im.height);
      g.save(); g.beginPath(); g.roundRect(box.x, box.y, box.w, box.h, 36); g.clip();
      g.drawImage(im, box.x + (box.w - im.width * k) / 2, box.y + (box.h - im.height * k) / 2, im.width * k, im.height * k);
      g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(box.x, box.y, box.w, box.h); g.restore();
    }
  } else { g.fillStyle = "#E3F0E7"; g.beginPath(); g.roundRect(box.x, box.y, box.w, box.h, 36); g.fill(); }
  if (track.length > 1) {
    const la = track.map((p) => p[0]), lo = track.map((p) => p[1]);
    const a0 = Math.min(...la), a1 = Math.max(...la), o0 = Math.min(...lo), o1 = Math.max(...lo), k = Math.cos(a0 * Math.PI / 180);
    const span = Math.max(a1 - a0, (o1 - o0) * k) || 1e-4, sz = 620, ox = box.x + (box.w - sz) / 2, oy = box.y + (box.h - sz) / 2;
    const X = (p) => ox + ((p[1] - o0) * k + (span - (o1 - o0) * k) / 2) / span * sz, Y = (p) => oy + sz - ((p[0] - a0) + (span - (a1 - a0)) / 2) / span * sz;
    g.lineJoin = g.lineCap = "round";
    for (const [w, c] of [[22, "rgba(255,255,255,.9)"], [12, "#D9472B"]]) {
      g.strokeStyle = c; g.lineWidth = w; g.beginPath(); track.forEach((p, i) => i ? g.lineTo(X(p), Y(p)) : g.moveTo(X(p), Y(p))); g.stroke();
    }
  }
  g.fillStyle = "#1C2A21"; g.font = font(800, 64); g.fillText(h.title.slice(0, 18), 60, 920);
  g.fillStyle = "#64716A"; g.font = font(500, 34);
  g.fillText(`${dateKo(h.start)} · ${(h.people || []).map(pname).join(", ")}`.slice(0, 40), 60, 975);
  const stats = [[km(h.dist), "거리 km"], [durKo(h.moving), "걸은 시간"], [String(h.gain), "오른 높이 m"]];
  stats.forEach(([v, l], i) => {
    const x = 60 + i * 330;
    g.fillStyle = "#1C2A21"; g.font = font(800, 58); g.fillText(v, x, 1100);
    g.fillStyle = "#64716A"; g.font = font(500, 30); g.fillText(l, x, 1145);
  });
  if ((h.summits || []).length) {
    g.save(); g.translate(890, 190); g.rotate(-0.25); g.fillStyle = "rgba(255,255,255,.85)"; g.beginPath(); g.arc(0, 0, 95, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#C23B2A"; g.lineWidth = 8; g.beginPath(); g.arc(0, 0, 95, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#C23B2A"; g.textAlign = "center"; g.font = font(900, 40); g.fillText(BYN[h.summits[0]].name.replace(/ \(.+\)$/, "").slice(0, 4), 0, -2);
    g.font = font(700, 26); g.fillText("완등", 0, 38); g.restore();
  }
  g.fillStyle = "#2F7D4F"; g.font = font(800, 34); g.textAlign = "left"; g.fillText("⛰️ 같이산", 60, 1290);
  const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
  const file = new File([blob], `${h.title}.png`, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: h.title }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("이미지를 저장했어요");
}

/* ---------- family ---------- */
function renderFam() {
  const inviteUrl = location.origin + location.pathname + "?join=" + store.groupId();
  const counts = (pid) => [new Set(S.stamps.filter((s) => s.pid === pid).map((s) => s.n)).size, S.hikes.filter((h) => (h.people || []).includes(pid)).length];
  $("#fam").innerHTML = `
    ${store.shared ? `<div class="card">
      <div class="sub">우리 가족</div>
      <div class="row" style="align-items:center;margin-top:4px"><h2 style="font-size:20px" id="g-name">${esc(S.group.name)}</h2><button class="btn ghost" style="flex:0 0 auto;padding:6px 12px" id="g-ren">이름 바꾸기</button></div>
      <label class="field">초대 코드 (가족에게 보내 주세요)</label>
      <div class="code">${esc(store.groupId())}</div>
      <button class="btn pri block" id="g-inv">초대 링크 보내기</button>
    </div>` : `<div class="note">아직 <b>혼자 모드</b>예요. 기록이 이 폰에만 저장돼요. 가족 공유(Firebase)를 연결하면 모두의 폰에 함께 보여요.</div>`}
    <div class="card">
      <h3 style="font-size:17px">사람</h3>
      <p class="sub" style="margin:4px 0 10px">폰이 없는 아이도 추가해 두면 함께 간 산행에 도장을 받을 수 있어요.</p>
      <div class="list">${S.people.map((p) => { const [st, hk] = counts(p.id); return `<div class="check">
        <span class="dot" style="background:${esc(p.color)};width:14px;height:14px"></span>
        <span style="flex:1"><b>${esc(p.name)}</b>${p.id === S.me ? ' <span class="chip on" style="padding:1px 8px;font-size:11px">나</span>' : ""}<br><span class="sub">도장 ${st} · 산행 ${hk}</span></span>
        ${p.id === S.me ? "" : `<button class="btn ghost" style="padding:6px 10px;font-size:13px" data-me="${esc(p.id)}">이 사람이 나</button>`}
        <button class="btn ghost" style="padding:6px 10px;font-size:13px" data-ed="${esc(p.id)}">수정</button></div>`; }).join("")}</div>
      <div class="row" style="margin-top:10px"><input id="p-new" placeholder="이름 (예: 엄마, 첫째)" maxlength="12"><button class="btn pri" style="flex:0 0 auto" id="p-add">추가</button></div>
    </div>
    <div class="card">
      <h3 style="font-size:17px">지도 종류</h3>
      <div class="seg" id="mapstyle" style="margin-top:10px"><button data-s="topo">등산지도 (등고선)</button><button data-s="osm">일반지도</button></div>
      <p class="sub" style="margin:8px 0 0">등산로는 두 지도 모두 반투명 선으로 겹쳐 보여요. 바꾸면 앱을 다시 불러와요.</p>
    </div>
    <div class="card">
      <h3 style="font-size:17px">홈 화면에 앱으로 설치</h3>
      <p class="sub" style="margin:6px 0 0"><b>아이폰</b>: 사파리에서 열고 공유 버튼 → 홈 화면에 추가<br><b>안드로이드</b>: 크롬에서 열고 ⋮ 메뉴 → 홈 화면에 추가<br>카카오톡 안에서 열었다면 오른쪽 위 메뉴에서 '다른 브라우저로 열기'를 먼저 누르세요.</p>
    </div>
    <p class="sub" style="text-align:center">같이산 ${VERSION} · 지도 © OpenStreetMap 기여자, OpenTopoMap, Waymarked Trails</p>`;
  $$("#mapstyle button").forEach((b) => { b.classList.toggle("on", b.dataset.s === S.mapStyle); b.onclick = () => { if (b.dataset.s !== S.mapStyle) { ls.set("gs-map", b.dataset.s); location.reload(); } }; });
  $("#p-add").onclick = async () => {
    const name = $("#p-new").value.trim(); if (!name) return;
    await addPerson(name); toast(`${name}님을 추가했어요`);
  };
  $$("[data-me]").forEach((b) => b.onclick = () => { setMe(b.dataset.me); renderFam(); toast(`이 폰은 이제 ${pname(S.me)}님이에요`); });
  $$("[data-ed]").forEach((b) => b.onclick = () => editPerson(b.dataset.ed));
  if (store.shared) {
    $("#g-inv").onclick = async () => {
      const text = `같이산 가족 초대: 아래 링크를 열고 참여하세요 (초대 코드 ${store.groupId()})\n${inviteUrl}`;
      if (navigator.share) { try { await navigator.share({ title: "같이산 초대", text }); return; } catch (e) { if (e.name === "AbortError") return; } }
      try { await navigator.clipboard.writeText(text); toast("초대 링크를 복사했어요. 카톡에 붙여 넣으세요."); } catch { toast(inviteUrl, 6000); }
    };
    $("#g-ren").onclick = () => {
      $("#g-name").outerHTML = `<input id="g-in" value="${esc(S.group.name)}" maxlength="20">`;
      $("#g-ren").textContent = "저장";
      $("#g-ren").onclick = async () => { const v = $("#g-in").value.trim(); if (v) { await store.renameGroup(v); S.group.name = v; paintHeader(); } renderFam(); };
    };
  }
}

function editPerson(id) {
  const p = person(id);
  const s = sheet(`<h2>사람 정보</h2>
    <label class="field">이름</label><input id="e-name" value="${esc(p.name)}" maxlength="12">
    <label class="field">색깔</label><div class="chips" id="e-col">${COLORS.map((c) => `<button class="chip ${c === p.color ? "on" : ""}" data-c="${c}" style="padding:6px"><span class="dot" style="background:${c};width:22px;height:22px"></span></button>`).join("")}</div>
    <div class="list" style="margin-top:16px"><button class="btn pri block" id="e-ok">저장</button>
    ${S.hikes.some((h) => (h.people || []).includes(id)) || S.stamps.some((x) => x.pid === id) ? "" : '<button class="btn danger block" id="e-del">삭제</button>'}</div>`);
  let color = p.color;
  $$("[data-c]", s.el).forEach((b) => b.onclick = () => { color = b.dataset.c; $$("[data-c]", s.el).forEach((x) => x.classList.toggle("on", x === b)); });
  $("#e-ok", s.el).onclick = async () => { await store.put("people", id, { ...p, name: $("#e-name", s.el).value.trim() || p.name, color }); s.close(); };
  const d = $("#e-del", s.el);
  if (d) d.onclick = async () => { if (await ask(`${p.name}님을 지울까요?`, "지우기", true)) { await store.del("people", id); s.close(); } };
}

async function addPerson(name) {
  const id = store.newId();
  const used = new Set(S.people.map((p) => p.color));
  await store.put("people", id, { name, color: COLORS.find((c) => !used.has(c)) || COLORS[S.people.length % COLORS.length], createdAt: Date.now() });
  return id;
}
function setMe(id) { S.me = id; ls.set("gs-me", id); }

/* ---------- onboarding (shared mode) ---------- */
function onboarding(prefill) {
  return new Promise((done) => {
    const s = sheet(`
      <h2>같이산 시작하기</h2>
      <p class="sub" style="margin:6px 0 14px">가족이 함께 산행을 기록하고 100대 명산 도장을 모아요.</p>
      <div class="seg" id="o-tab"><button data-t="join" class="${prefill ? "on" : ""}">초대 코드로 참여</button><button data-t="new" class="${prefill ? "" : "on"}">새 가족 만들기</button></div>
      <div id="o-new" class="${prefill ? "hidden" : ""}">
        <label class="field">가족 이름</label><input id="o-gname" placeholder="예: 김씨네 산악회" maxlength="20">
        <label class="field">내 이름</label><input id="o-me" placeholder="예: 아빠" maxlength="12">
        <button class="btn pri block" id="o-create" style="margin-top:16px">만들기</button>
      </div>
      <div id="o-join" class="${prefill ? "" : "hidden"}">
        <label class="field">초대 코드 8자리</label><input id="o-code" value="${esc(prefill || "")}" placeholder="예: K7M2PQ9X" maxlength="12" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:2px">
        <button class="btn pri block" id="o-go" style="margin-top:16px">참여하기</button>
      </div>`, { locked: true });
    $$("#o-tab button", s.el).forEach((b) => b.onclick = () => {
      $$("#o-tab button", s.el).forEach((x) => x.classList.toggle("on", x === b));
      $("#o-new", s.el).classList.toggle("hidden", b.dataset.t !== "new");
      $("#o-join", s.el).classList.toggle("hidden", b.dataset.t !== "join");
    });
    $("#o-create", s.el).onclick = async (e) => {
      const g = $("#o-gname", s.el).value.trim() || "우리 가족", me = $("#o-me", s.el).value.trim();
      if (!me) return toast("내 이름을 적어 주세요");
      e.target.disabled = true;
      try { await store.createGroup(g); s.close(); done({ created: true, me }); }
      catch (err) { console.warn(err); e.target.disabled = false; toast("만들지 못했어요. 인터넷 연결을 확인해 주세요."); }
    };
    $("#o-go", s.el).onclick = async (e) => {
      e.target.disabled = true;
      try {
        if (await store.joinGroup($("#o-code", s.el).value)) { s.close(); done({ created: false }); }
        else { toast("그런 초대 코드가 없어요. 다시 확인해 주세요."); e.target.disabled = false; }
      } catch (err) { console.warn(err); e.target.disabled = false; toast("참여하지 못했어요. 인터넷 연결을 확인해 주세요."); }
    };
  });
}

function pickMe() {
  return new Promise((done) => {
    const s = sheet(`<h2>누구세요?</h2><p class="sub" style="margin:6px 0 12px">이 폰을 쓰는 사람을 골라 주세요.</p>
      <div class="list">${S.people.map((p) => `<button class="check" style="width:100%" data-p="${esc(p.id)}"><span class="dot" style="background:${esc(p.color)};width:14px;height:14px"></span><b>${esc(p.name)}</b></button>`).join("")}</div>
      <label class="field">목록에 없으면 새로 추가</label>
      <div class="row"><input id="pm-name" placeholder="내 이름" maxlength="12"><button class="btn pri" style="flex:0 0 auto" id="pm-add">추가</button></div>`, { locked: true });
    $$("[data-p]", s.el).forEach((b) => b.onclick = () => { setMe(b.dataset.p); s.close(); done(); });
    $("#pm-add", s.el).onclick = async () => {
      const n = $("#pm-name", s.el).value.trim(); if (!n) return;
      setMe(await addPerson(n)); s.close(); done();
    };
  });
}

/* ---------- boot ---------- */
function paintHeader() { $("#grpname").textContent = store.shared ? S.group.name : "혼자 모드"; }
let firstData;
function startWatches() {
  let pending = 3;
  firstData = new Promise((res) => {
    for (const col of ["people", "hikes", "stamps"]) {
      let first = true;
      store.watch(col, (rows) => {
        S[col] = rows;
        if (first) { first = false; if (--pending === 0) res(); }
        if (curView === "stamps") renderStamps();
        if (curView === "feed") renderFeed();
        if (curView === "fam" && !document.activeElement?.matches("input")) renderFam();
      });
    }
  });
  return firstData;
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const join = params.get("join");
  if (join) history.replaceState(null, "", location.pathname);
  initRecMap();
  startWatch();
  paintRec();
  if (rec) { beginTimer(); lockScreen(); recLine.setLatLngs(rec.points.map((p) => [p[0], p[1]])); toast("진행 중이던 산행을 이어서 기록해요"); }
  try { await store.init(); }
  catch (e) {
    console.error(e);
    $("#boot").innerHTML = `<div style="padding:24px;text-align:center">연결하지 못했어요.<br><span class="sub">인터넷 연결을 확인하고 다시 열어 주세요.</span><br><br><button class="btn pri" onclick="location.reload()">다시 시도</button></div>`;
    return;
  }
  $("#boot").remove();
  let created = null;
  if (store.shared) {
    if (join && store.groupId() && join.toUpperCase() !== store.groupId()) {
      if (await ask("다른 가족의 초대 링크예요. 지금 가족에서 나와 새 가족에 참여할까요?", "참여하기")) { store.leaveGroup(); setMe(""); }
    }
    if (!store.groupId()) created = await onboarding(join && join.toUpperCase());
    S.group = await store.groupInfo();
  }
  paintHeader();
  await startWatches();
  if (created?.created) setMe(await addPerson(created.me));
  else if (!store.shared && !S.people.length) setMe(await addPerson("나"));
  else if (!person(S.me)) {
    if (!store.shared && S.people.length) setMe(S.people[0].id); else await pickMe();
  }
  if (curView !== "rec") show(curView);
}
boot();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("sw", e));
