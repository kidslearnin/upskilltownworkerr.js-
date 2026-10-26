/* Upskilltown Agency backend: ONE-FILE Cloudflare Worker (free plan, no hosting needed).
   Paste into Cloudflare > Workers > Create > Edit code. Settings > Variables:
   FIREBASE_PROJECT_ID, FIREBASE_API_KEY, FIREBASE_SERVICE_ACCOUNT (secret, the JSON key), ADMIN_EMAIL,
   TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_SECRET, PAYSTACK_SECRET_KEY,
   SITE_URL (where your site opens), ALLOWED_ORIGIN (your site origin, or * while testing),
   GOOGLE_CHAT_WEBHOOK_URL (optional, needs Google Workspace). */

/* ---- Edit these to match your site ---- */
const PRICES = { landing: { sub: 20000, com: 45000, net: 45000, online: 35000 }, multi: { none: 50000, com: 67000, net: 67000, online: 55000 }, port: { none: 20000, online: 25000, com: 35000, net: 35000 } };
const PAY = { multi: 10000, landing: 5000, port: 3000 };          // per paid client
const TEAM = { t1: 150, p1: 0.20, t2: 300, p2: 0.25 };            // sales team tiers
const MIN_WITHDRAW_USD = 20;                                       // minimum withdrawal, in dollars
const FX_MARGIN_PCT = 3;                                           // buffer added to the foreign amounts we SHOW (dollar, shilling, cedi)
const FX_FALLBACK = { NGN: 1365, KES: 129, GHS: 11.3 };            // used only if the live rate service is down
const FEE_PCT = 0, FEE_FLAT = 100;                                 // withdrawal fee = percent of amount + flat naira (set your own)
const fee = amt => Math.min(amt - 1, Math.round(amt * FEE_PCT / 100) + FEE_FLAT);
const MAX_AFFILIATES = 50, LINK_PREFIX = "Upskilltown";
/* Withdrawals are paid every Thursday and Friday (Nigeria time). */
function nextPayday() {
  const d = new Date(Date.now() + 3600e3);
  for (let i = 0; i < 8; i++) {
    const x = new Date(d.getTime() + i * 864e5), w = x.getUTCDay();
    if (w === 4 || w === 5) return x.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  }
}

const enc = new TextEncoder();
const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const digits = s => String(s || "").replace(/\D/g, "").slice(-10);
const clip = (s, n = 2000) => String(s == null ? "" : s).slice(0, n);
const naira = n => "₦" + Number(n).toLocaleString("en-US");

/* ---- Live exchange rates (free, no key, updates daily, cached 6 hours) ---- */
let fxc = { at: 0, r: null, asOf: "" };
async function liveRates() {
  if (fxc.r && Date.now() - fxc.at < 6 * 3600e3) return fxc;
  const before = fxc.at;
  try {
    const j = await (await fetch("https://open.er-api.com/v6/latest/USD")).json();
    if (j.result === "success" && j.rates && j.rates.NGN && j.rates.KES && j.rates.GHS) fxc = { at: Date.now(), r: { NGN: j.rates.NGN, KES: j.rates.KES, GHS: j.rates.GHS }, asOf: j.time_last_update_utc || "" };
  } catch (e) { /* keep the last good rate */ }
  if (fxc.at === before) { if (!fxc.r) fxc.r = FX_FALLBACK, fxc.asOf = "fallback"; fxc.at = Date.now() - 5 * 3600e3; }   // retry within the hour
  return fxc;
}
async function getRates() {
  const { r, asOf } = await liveRates(), m = FX_MARGIN_PCT / 100;
  return {
    asOf, marginPct: FX_MARGIN_PCT, marketUsdNgn: r.NGN,
    usdPerNgn: 1 / (r.NGN * (1 - m)),        // shown dollar price = naira x this (a little above market)
    kesPerNgn: (r.KES / r.NGN) * (1 + m),
    ghsPerNgn: (r.GHS / r.NGN) * (1 + m),
    attribution: "Rates By Exchange Rate API (exchangerate-api.com)"
  };
}
const minNaira = async () => Math.ceil((await liveRates()).r.NGN * MIN_WITHDRAW_USD / 100) * 100;

/* ---- Google auth for Firestore (service account JWT, works on Workers) ---- */
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let tok = { v: null, exp: 0 };
async function gToken(env) {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT), now = Math.floor(Date.now() / 1000);
  const head = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64u(enc.encode(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })));
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(head + "." + body));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + head + "." + body + "." + b64u(sig) });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google sign-in for the backend failed");
  tok = { v: j.access_token, exp: Date.now() + 3300e3 };
  return tok.v;
}

/* ---- Firestore REST helpers ---- */
function tv(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(tv) } };
  return { mapValue: { fields: fo(v) } };
}
const fo = o => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined).map(([k, x]) => [k, tv(x)]));
function fv(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fv);
  if ("mapValue" in v) return ff(v.mapValue.fields || {});
  return null;
}
const ff = f => Object.fromEntries(Object.entries(f).map(([k, x]) => [k, fv(x)]));
const dec = d => d && d.name ? { id: d.name.split("/").pop(), _t: d.updateTime, ...ff(d.fields || {}) } : null;
const root = env => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const nm = (env, c, id) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${c}/${id}`;
async function fsx(env, path, opt = {}) {
  const r = await fetch(root(env) + path, { ...opt, headers: { Authorization: "Bearer " + await gToken(env), "Content-Type": "application/json" } });
  const j = await r.json();
  if (!r.ok) { const e = new Error((j.error && j.error.message) || "database error"); e.code = r.status; throw e; }
  return j;
}
const getDoc = async (env, c, id) => { try { return dec(await fsx(env, `/${c}/${id}`)); } catch (e) { if (e.code === 404) return null; throw e; } };
async function query(env, c, field, val, limit = 100) {
  const r = await fsx(env, ":runQuery", { method: "POST", body: JSON.stringify({ structuredQuery: { from: [{ collectionId: c }], where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: tv(val) } }, limit } }) });
  return r.filter(x => x.document).map(x => dec(x.document));
}
/* write builders: create (fails if exists), patch (merge fields, optional atomic increments and precondition) */
const W = {
  create: (env, c, id, o) => ({ update: { name: nm(env, c, id), fields: fo(o) }, currentDocument: { exists: false } }),
  patch: (env, c, id, o, incs, pre) => {
    const w = { update: { name: nm(env, c, id), fields: fo(o) }, updateMask: { fieldPaths: Object.keys(o).filter(k => o[k] !== undefined) } };
    if (incs) w.updateTransforms = Object.entries(incs).map(([k, n]) => ({ fieldPath: k, increment: { integerValue: String(n) } }));
    if (pre) w.currentDocument = { updateTime: pre };
    return w;
  },
  inc: (env, c, id, o, pre) => W.patch(env, c, id, {}, o, pre)
};
const commit = (env, writes) => fsx(env, ":commit", { method: "POST", body: JSON.stringify({ writes }) });
const clash = e => e.code === 409 || e.code === 400 || e.code === 412;

/* ---- Telegram, Google Chat, sign-in checks ---- */
async function tg(env, text, buttons) {
  for (let i = 0; i < text.length || i === 0; i += 3800) {
    const b = { chat_id: env.TELEGRAM_ADMIN_CHAT_ID, text: text.slice(i, i + 3800) };
    if (buttons && i + 3800 >= text.length) b.reply_markup = { inline_keyboard: buttons };
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  }
}
const gchat = async (env, text) => { if (env.GOOGLE_CHAT_WEBHOOK_URL) await fetch(env.GOOGLE_CHAT_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 4000) }) }); };
async function who(env, idToken) {
  const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + env.FIREBASE_API_KEY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
  const u = ((await r.json()).users || [])[0];
  if (!u) throw new Error("Please sign in again");
  return { uid: u.localId, email: String(u.email || "").toLowerCase() };
}
async function needAdmin(env, t) { const u = await who(env, t); if (u.email !== String(env.ADMIN_EMAIL).toLowerCase()) throw new Error("Admin only"); return u; }

/* ---- Approvals and referral codes ---- */
async function setStatus(env, kind, id, status) {
  const col = kind === "teams" ? "teams" : "users", d = await getDoc(env, col, id);
  if (!d) throw new Error("Not found");
  if (status !== "approved") { await commit(env, [W.patch(env, col, id, { status })]); return `Marked ${status}: ${d.name}`; }
  if (d.status === "approved") return `Already approved: ${d.name}`;
  if (col === "teams") {
    const inviteCode = d.inviteCode || rid().slice(0, 6).toUpperCase();
    await commit(env, [W.patch(env, "teams", id, { status, inviteCode })]);
    return `✅ Team approved: ${d.name}. Invite code ${inviteCode}`;
  }
  if ((d.role || "affiliate") === "affiliate") {
    const n = (await query(env, "users", "status", "approved", 300)).filter(x => (x.role || "affiliate") === "affiliate").length;
    if (n >= MAX_AFFILIATES) throw new Error(`The ${MAX_AFFILIATES} affiliate slots are full`);
  }
  let code = d.refCode;
  if (!code) {
    let n = ((await getDoc(env, "counters", "refCode")) || { n: 100 }).n;
    for (let i = 0; i < 25 && !code; i++) {
      n++;
      const c = `${LINK_PREFIX}-Uts${n}`;
      try { await commit(env, [W.create(env, "refCodes", c, { uid: id }), W.patch(env, "counters", "refCode", { n })]); code = c; } catch (e) { if (!clash(e)) throw e; }
    }
    if (!code) throw new Error("Could not make a referral code");
  }
  await commit(env, [W.patch(env, "users", id, { status, refCode: code, approvedAt: new Date() }), W.inc(env, "balances", id, { clientsBrought: 0, clientsPaid: 0, totalEarned: 0, totalWithdrawn: 0, pendingWithdrawal: 0, available: 0 })]);
  return `✅ Approved: ${d.name}. Link code ${code}`;
}

/* ---- Money: mark a client paid (idempotent), manual entries, withdrawals ---- */
async function markPaid(env, clientId, sale, by) {
  const c = await getDoc(env, "clients", clientId);
  if (!c) throw new Error("Client not found");
  const amt = Number(sale) || 0, pay = PAY[c.service] || 0, now = new Date(), w = [], notes = [];
  w.push(W.create(env, "paidMarkers", clientId, { at: now }));
  w.push(W.patch(env, "clients", clientId, { status: "paid", saleAmountNGN: amt, paidAt: now }));
  if (c.affiliateUid && pay) {
    w.push(W.create(env, "ledger", rid(), { uid: c.affiliateUid, type: "earning", amountNGN: pay, clientId, note: "Client paid: " + c.service, createdAt: now, createdBy: by }));
    w.push(W.inc(env, "balances", c.affiliateUid, { clientsPaid: 1, totalEarned: pay, available: pay }));
    notes.push(`${naira(pay)} to affiliate`);
  }
  if (c.teamId) {
    const t = await getDoc(env, "teams", c.teamId);
    if (t && t.leadUid) {
      const cnt = (t.paidClients || 0) + 1, sales = (t.paidSales || 0) + amt;
      const p = cnt >= TEAM.t2 ? TEAM.p2 : cnt >= TEAM.t1 ? TEAM.p1 : 0;   // rule: tier % applies to ALL team sales once reached
      const credited = t.commissionCredited || 0, due = Math.max(Math.round(sales * p) - credited, 0);
      w.push(W.patch(env, "teams", c.teamId, { commissionCredited: credited + due }, { paidClients: 1, paidSales: amt }, t._t));
      if (due > 0) {
        w.push(W.create(env, "ledger", rid(), { uid: t.leadUid, type: "earning", amountNGN: due, clientId, note: `Team commission ${Math.round(p * 100)}%`, createdAt: now, createdBy: by }));
        w.push(W.inc(env, "balances", t.leadUid, { totalEarned: due, available: due }));
        notes.push(`${naira(due)} team commission`);
      }
    }
  }
  try { await commit(env, w); } catch (e) { if (clash(e)) return "Already marked paid (or just changed). Nothing duplicated."; throw e; }
  return `✅ Client ${c.clientName || clientId} marked paid (${naira(amt)}). ${notes.join(", ")}`;
}
async function addManual(env, d, by) {
  const amt = Math.round(Number(d.amountNGN) || 0), cd = Math.round(Number(d.clientsDelta) || 0);
  if (!d.uid || (!amt && !cd)) throw new Error("Enter a person and an amount or client count");
  const w = [W.inc(env, "balances", d.uid, { available: amt, totalEarned: Math.max(amt, 0), clientsPaid: cd, clientsBrought: cd })];
  if (amt) w.push(W.create(env, "ledger", rid(), { uid: d.uid, type: "adjustment", amountNGN: amt, note: clip(d.note || "Manual entry", 200), createdAt: new Date(), createdBy: by }));
  await commit(env, w);
  return `Manual entry saved: ${naira(amt)}, ${cd} clients`;
}
async function reqWithdraw(env, u, d) {
  const amt = Math.floor(Number(d.amount)), us = await getDoc(env, "users", u.uid), b = (await getDoc(env, "balances", u.uid)) || {};
  if (!us || us.status !== "approved") throw new Error("Your account is not approved yet");
  const min = await minNaira();
  if (!(amt >= min)) throw new Error(`Minimum withdrawal is $${MIN_WITHDRAW_USD} (${naira(min)})`);
  if (amt > (b.available || 0)) throw new Error("That is more than your available balance");
  if (!d.bank || !d.accountNumber || !d.accountName) throw new Error("Enter bank, account number and account name");
  const id = rid(), fe = fee(amt), net = amt - fe;
  await commit(env, [W.create(env, "withdrawals", id, { uid: u.uid, name: us.name, amountNGN: amt, feeNGN: fe, netNGN: net, bank: clip(d.bank, 60), accountNumber: clip(d.accountNumber, 20), accountName: clip(d.accountName, 80), status: "pending", createdAt: new Date() }), W.inc(env, "balances", u.uid, { available: -amt, pendingWithdrawal: amt }, b._t)]);
  await tg(env, `💸 Withdrawal request (pay on ${nextPayday()})\n${us.name}: ${naira(amt)} requested. SEND ${naira(net)} (fee ${naira(fe)})\n${d.bank} · ${d.accountNumber} · ${d.accountName}`, [[{ text: "✅ Mark paid", callback_data: "wp:" + id }, { text: "❌ Reject", callback_data: "wr:" + id }]]);
  return { id, payday: nextPayday(), fee: fe, net };
}
async function procWd(env, id, decision, ref) {
  const w = await getDoc(env, "withdrawals", id);
  if (!w || w.status !== "pending") throw new Error("Already handled");
  const amt = w.amountNGN, now = new Date();
  if (decision === "paid") {
    await commit(env, [W.patch(env, "withdrawals", id, { status: "paid", paidAt: now, paymentRef: clip(ref || "", 80) }, null, w._t), W.create(env, "ledger", rid(), { uid: w.uid, type: "withdrawal", amountNGN: -amt, note: `Withdrawal paid (fee ${naira(w.feeNGN || 0)}, sent ${naira(w.netNGN || amt)})`, createdAt: now, createdBy: "admin" }), W.inc(env, "balances", w.uid, { pendingWithdrawal: -amt, totalWithdrawn: amt }), W.inc(env, "stats", "fees", { totalNGN: w.feeNGN || 0, count: 1 })]);
    return `✅ Withdrawal paid: ${w.name}, sent ${naira(w.netNGN || amt)} (fee ${naira(w.feeNGN || 0)})`;
  }
  await commit(env, [W.patch(env, "withdrawals", id, { status: "rejected" }, null, w._t), W.inc(env, "balances", w.uid, { pendingWithdrawal: -amt, available: amt })]);
  return `Withdrawal rejected and returned to balance: ${w.name} ${naira(amt)}`;
}

/* ---- Orders, Paystack, website-details form ---- */
async function newOrder(env, d, status) {
  const amt = (PRICES[d.service] || {})[d.domain];
  if (!amt) throw new Error("Choose a service and domain option");
  if (!clip(d.name, 80) || digits(d.phone).length < 10) throw new Error("Enter your name and phone number");
  const id = rid();
  await commit(env, [W.create(env, "orders", id, { status, service: d.service, domain: d.domain, amountNGN: amt, name: clip(d.name, 80), phone: clip(d.phone, 20), email: clip(d.email, 100), refCode: clip(d.refCode, 40), createdAt: new Date() })]);
  return { id, amt };
}
async function paystackInit(env, d) {
  if (!/^\S+@\S+\.\S+$/.test(d.email || "")) throw new Error("A valid email is needed for Paystack");
  const { id, amt } = await newOrder(env, d, "awaiting_payment");
  const r = await fetch("https://api.paystack.co/transaction/initialize", { method: "POST", headers: { Authorization: "Bearer " + env.PAYSTACK_SECRET_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email: d.email, amount: amt * 100, reference: id, callback_url: env.SITE_URL + (env.SITE_URL.includes("?") ? "&" : "?") + "paid=" + id, metadata: { orderId: id } }) });
  const j = await r.json();
  if (!j.status) throw new Error("Paystack: " + j.message);
  return { orderId: id, url: j.data.authorization_url };
}
async function proofOrder(env, d) {
  const { id, amt } = await newOrder(env, d, "awaiting_proof");
  await tg(env, `🧾 Bank-transfer order awaiting proof\n${d.name} · ${d.phone}\n${d.service}/${d.domain} · ${naira(amt)}\nOrder ${id}`, [[{ text: "✅ Confirm paid", callback_data: "pc:" + id }]]);
  return { orderId: id };
}
async function finish(env, id, via) {
  const o = await getDoc(env, "orders", id);
  if (!o) throw new Error("Order not found");
  try { await commit(env, [W.create(env, "orderMarkers", id, { at: new Date() })]); } catch (e) { if (clash(e)) return o; throw e; }
  const token = rid() + rid().slice(0, 8);
  await commit(env, [W.patch(env, "orders", id, { status: "paid", paidAt: new Date(), intakeToken: token, intakeUsed: false, paidVia: via })]);
  let note = "";
  if (o.refCode) {
    const rc = await getDoc(env, "refCodes", o.refCode);
    if (rc) {
      const u = await getDoc(env, "users", rc.uid);
      await commit(env, [W.patch(env, "clients", id, { clientName: o.name, clientPhone: digits(o.phone), service: o.service, refCode: o.refCode, affiliateUid: rc.uid, teamId: (u && u.teamId) || "", status: "registered", registeredAt: new Date() }), W.inc(env, "balances", rc.uid, { clientsBrought: 1 })]);
      note = await markPaid(env, id, o.amountNGN, via);
    }
  }
  await tg(env, `💰 PAID ${naira(o.amountNGN)} by ${o.name} (${o.service}, ${o.domain}) via ${via}\nOrder ${id}${o.refCode ? "\nRef " + o.refCode : ""}\n${note}\nWebsite-details link: ${env.SITE_URL}#intake-${token}`);
  return { ...o, status: "paid", intakeToken: token };
}
async function hmac512(secret, body) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(body)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function paystackHook(env, raw, sig) {
  if (!sig || (await hmac512(env.PAYSTACK_SECRET_KEY, raw)) !== sig) throw new Error("bad signature");
  const ev = JSON.parse(raw);
  if (ev.event !== "charge.success") return;
  const ref = ev.data.reference, o = await getDoc(env, "orders", ref);
  if (!o) return;
  const v = await (await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(ref), { headers: { Authorization: "Bearer " + env.PAYSTACK_SECRET_KEY } })).json();
  if (!v.status || v.data.status !== "success" || v.data.amount !== o.amountNGN * 100 || v.data.currency !== "NGN") { await tg(env, `⚠️ Paystack payment did not match order ${ref}. Check it by hand.`); return; }
  await finish(env, ref, "paystack");
}
async function orderStatus(env, id) {
  const o = await getDoc(env, "orders", clip(id, 40));
  if (!o) return { status: "missing" };
  return { status: o.status, intakeToken: o.status === "paid" && !o.intakeUsed ? o.intakeToken : null };
}
const INTAKE = ["businessName", "whatItDoes", "services", "colors", "logo", "pages", "content", "social", "domain", "contact", "references", "deadline", "state", "city", "lat", "lng", "locationConsent"];
const r2 = n => Math.round(Number(n) * 100) / 100;     // coordinates are rounded to about 1 km for privacy
async function submitIntake(env, d) {
  const [o] = await query(env, "orders", "intakeToken", clip(d.token, 60), 1);
  if (!o || o.status !== "paid" || o.intakeUsed) throw new Error("This link is not valid or was already used");
  const data = Object.fromEntries(INTAKE.map(k => [k, clip((d.data || {})[k], 2000)]));
  const la = Number(data.lat), ln = Number(data.lng);
  const loc = data.locationConsent === "yes" && data.lat !== "" && data.lng !== "" && Math.abs(la) <= 90 && Math.abs(ln) <= 180;
  data.lat = loc ? String(r2(la)) : ""; data.lng = loc ? String(r2(ln)) : ""; if (!loc) data.locationConsent = "no";
  const w = [W.patch(env, "orders", o.id, { intakeUsed: true }, null, o._t), W.create(env, "intakes", rid(), { orderId: o.id, data, createdAt: new Date() })];
  if (loc) w.push(W.create(env, "locations", rid(), { kind: "client", orderId: o.id, state: data.state, city: data.city, lat: r2(la), lng: r2(ln), createdAt: new Date() }));
  await commit(env, w);
  const text = `📝 Website details received\nOrder ${o.id} · ${o.name} · ${o.phone} · ${o.service}/${o.domain}\n\n` + INTAKE.filter(k => !["lat", "lng", "locationConsent"].includes(k)).map(k => `${k}: ${data[k]}`).join("\n");
  await tg(env, text); await gchat(env, text);
  return { orderId: o.id };
}

/* ---- Notifications from the site and Telegram buttons ---- */
async function notify(env, d) {
  const col = d.collection === "teams" ? "teams" : d.collection === "users" ? "users" : null;
  if (!col) throw new Error("bad collection");
  const x = await getDoc(env, col, clip(d.docId, 60));
  if (!x || x.notified === true) return { sent: false };
  await commit(env, [W.patch(env, col, x.id, { notified: true }, null, x._t)]);
  const k = col === "teams" ? "t" : "u";
  await tg(env, col === "teams" ? `🆕 Sales team application\n${x.name} · lead ${x.leadName || ""} · ${x.phone || ""}` : `🆕 ${x.role || "affiliate"} application\n${x.name} · ${x.phone || ""} · ${x.email || ""}`, [[{ text: "✅ Approve", callback_data: `ap:${k}:${x.id}` }, { text: "❌ Reject", callback_data: `rj:${k}:${x.id}` }]]);
  return { sent: true };
}
async function onTelegram(env, u) {
  const cb = u.callback_query, m = u.message, chat = cb ? cb.message.chat.id : m && m.chat.id;
  if (String(chat) !== String(env.TELEGRAM_ADMIN_CHAT_ID)) return;
  let out = "";
  try {
    if (cb) {
      const [k, a, b] = cb.data.split(":");
      if (k === "ap" || k === "rj") out = await setStatus(env, a === "t" ? "teams" : "users", b, k === "ap" ? "approved" : "rejected");
      else if (k === "wp") out = await procWd(env, a, "paid", "Telegram");
      else if (k === "wr") out = await procWd(env, a, "rejected", "");
      else if (k === "pc") { await finish(env, a, "transfer"); out = "✅ Confirmed paid"; }
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: cb.id }) });
    } else if (m && /^\/paid\s+\S+/.test(m.text || "")) {
      const [, id, amt] = m.text.trim().split(/\s+/);
      out = await markPaid(env, id, amt, "telegram");
    }
  } catch (e) { out = "⚠️ " + e.message; }
  if (out) await tg(env, out);
}

/* ---- Router ---- */
async function act(env, b) {
  switch (b.action) {
    case "rates": return getRates();
    case "withdrawalQuote": { const a = Math.floor(Number(b.amount)) || 0; return { min: await minNaira(), minUSD: MIN_WITHDRAW_USD, fee: fee(a), net: a - fee(a), payday: nextPayday() }; }
    case "notify": return notify(env, b);
    case "paystackInit": return paystackInit(env, b);
    case "proofOrder": return proofOrder(env, b);
    case "orderStatus": return orderStatus(env, b.orderId);
    case "submitIntake": return submitIntake(env, b);
    case "requestWithdrawal": return reqWithdraw(env, await who(env, b.idToken), b);
    case "adminSetStatus": await needAdmin(env, b.idToken); return { message: await setStatus(env, b.kind, b.id, b.status) };
    case "adminMarkPaid": await needAdmin(env, b.idToken); return { message: await markPaid(env, b.clientId, b.saleAmountNGN, "admin") };
    case "adminManual": await needAdmin(env, b.idToken); return { message: await addManual(env, b, "admin") };
    case "adminWithdrawal": await needAdmin(env, b.idToken); return { message: await procWd(env, b.id, b.decision, b.ref) };
    case "adminConfirmOrder": await needAdmin(env, b.idToken); { const o = await finish(env, b.orderId, "transfer"); return { status: o.status }; }
    default: throw new Error("Unknown action");
  }
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST,GET,OPTIONS" };
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (req.method === "POST" && url.pathname === "/paystack") { await paystackHook(env, await req.text(), req.headers.get("x-paystack-signature")); return J({ ok: true }); }
      if (req.method === "POST" && url.pathname === "/telegram") {
        if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_SECRET) return J({ ok: false }, 403);
        await onTelegram(env, await req.json()); return J({ ok: true });
      }
      if (req.method === "GET" && url.pathname === "/rates") return J({ ok: true, ...(await getRates()) });
      if (req.method === "POST") return J({ ok: true, ...(await act(env, await req.json())) });
      return J({ ok: true, name: "Upskilltown backend" });
    } catch (e) { return J({ ok: false, error: e.message }, 400); }
  }
};
