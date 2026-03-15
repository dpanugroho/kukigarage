import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join, extname } from "path";

const app = new Hono();
const db = new Database("kukigarage.db");
const UPLOADS_DIR = join(import.meta.dir, "uploads");
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR);

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};
const ALLOWED_EXTS = new Set(Object.keys(MIME_TYPES));
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// ─── Init DB ───
db.run(`CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price REAL DEFAULT 0,
  category TEXT DEFAULT 'Other',
  condition TEXT DEFAULT 'Good',
  imageUrl TEXT DEFAULT '',
  sold INTEGER DEFAULT 0,
  createdAt TEXT DEFAULT (datetime('now')),
  updatedAt TEXT DEFAULT (datetime('now'))
)`);

// Migration: add updatedAt if missing (for DBs created before this column existed)
try { db.run("ALTER TABLE items ADD COLUMN updatedAt TEXT DEFAULT (datetime('now'))"); } catch {}

db.run(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS reservations (
  itemId TEXT PRIMARY KEY,
  reservedBy TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  waitlist TEXT DEFAULT '[]'
)`);

// Init default settings if empty
const settingsCount = db.query("SELECT COUNT(*) as c FROM settings").get() as any;
if (settingsCount.c === 0) {
  db.run(`INSERT INTO settings (key, value) VALUES ('saleTitle', 'Kuki''s Garage Sale')`);
  db.run(`INSERT INTO settings (key, value) VALUES ('whatsappNumber', '')`);
  db.run(`INSERT INTO settings (key, value) VALUES ('adminPassword', '')`);
}

// ─── Helpers ───
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getSetting(key: string): string {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row?.value || "";
}

function setSetting(key: string, value: string) {
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, value]);
}

function getAllSettings() {
  return {
    saleTitle: getSetting("saleTitle"),
    whatsappNumber: getSetting("whatsappNumber"),
  };
}

// Session tokens (in-memory, simple)
const sessions = new Set<string>();

function genSession(): string {
  const token = crypto.randomUUID();
  sessions.add(token);
  return token;
}

function isAuthed(c: any): boolean {
  const token = getCookie(c, "session");
  return !!token && sessions.has(token);
}

// Clean expired reservations
function cleanReservations() {
  const now = Date.now();
  const rows = db.query("SELECT * FROM reservations").all() as any[];
  for (const r of rows) {
    if (r.expiresAt <= now) {
      const waitlist = JSON.parse(r.waitlist || "[]");
      if (waitlist.length > 0) {
        const next = waitlist.shift();
        db.run("UPDATE reservations SET reservedBy = ?, expiresAt = ?, waitlist = ? WHERE itemId = ?", [
          next, now + 20 * 60 * 1000, JSON.stringify(waitlist), r.itemId,
        ]);
      } else {
        db.run("DELETE FROM reservations WHERE itemId = ?", [r.itemId]);
      }
    }
  }
}

// ─── Public API ───

// Get all items + settings (public)
app.get("/api/items", (c) => {
  cleanReservations();
  const items = db.query("SELECT * FROM items ORDER BY createdAt DESC").all() as any[];
  const reservations = db.query("SELECT * FROM reservations").all() as any[];
  const resMap: Record<string, any> = {};
  for (const r of reservations) {
    resMap[r.itemId] = { reservedBy: r.reservedBy, expiresAt: r.expiresAt, waitlist: JSON.parse(r.waitlist || "[]") };
  }
  return c.json({
    items: items.map((i) => ({ ...i, sold: !!i.sold })),
    settings: getAllSettings(),
    reservations: resMap,
  });
});

// Reserve an item
app.post("/api/reserve/:id", async (c) => {
  cleanReservations();
  const id = c.req.param("id");
  const { name } = await c.req.json();
  if (!name) return c.json({ error: "Name required" }, 400);

  const existing = db.query("SELECT * FROM reservations WHERE itemId = ?").get(id) as any;
  if (existing) {
    return c.json({ error: "Already reserved" }, 409);
  }
  db.run("INSERT INTO reservations (itemId, reservedBy, expiresAt, waitlist) VALUES (?, ?, ?, '[]')", [
    id, name, Date.now() + 20 * 60 * 1000,
  ]);
  return c.json({ ok: true });
});

// Join waitlist
app.post("/api/waitlist/:id", async (c) => {
  cleanReservations();
  const id = c.req.param("id");
  const { name } = await c.req.json();
  if (!name) return c.json({ error: "Name required" }, 400);

  const existing = db.query("SELECT * FROM reservations WHERE itemId = ?").get(id) as any;
  if (!existing) return c.json({ error: "Not reserved" }, 404);

  const waitlist = JSON.parse(existing.waitlist || "[]");
  waitlist.push(name);
  db.run("UPDATE reservations SET waitlist = ? WHERE itemId = ?", [JSON.stringify(waitlist), id]);
  return c.json({ ok: true });
});

// ─── Auth ───
app.post("/api/auth/setup", async (c) => {
  const currentPass = getSetting("adminPassword");
  if (currentPass) return c.json({ error: "Password already set" }, 400);

  const { password } = await c.req.json();
  if (!password) return c.json({ error: "Password required" }, 400);

  const hashed = await hashPassword(password);
  setSetting("adminPassword", hashed);
  const token = genSession();
  setCookie(c, "session", token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 });
  return c.json({ ok: true });
});

app.post("/api/auth/login", async (c) => {
  const { password } = await c.req.json();
  const stored = getSetting("adminPassword");
  if (!stored) return c.json({ error: "No password set", needsSetup: true }, 400);

  const hashed = await hashPassword(password);
  if (hashed !== stored) return c.json({ error: "Wrong password" }, 401);

  const token = genSession();
  setCookie(c, "session", token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 });
  return c.json({ ok: true });
});

app.post("/api/auth/logout", (c) => {
  const token = getCookie(c, "session");
  if (token) sessions.delete(token);
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/auth/check", (c) => {
  const needsSetup = !getSetting("adminPassword");
  return c.json({ authenticated: isAuthed(c), needsSetup });
});

// ─── Admin API (protected) ───
app.use("/api/admin/*", async (c, next) => {
  if (!isAuthed(c)) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

app.get("/api/admin/items", (c) => {
  cleanReservations();
  const items = db.query("SELECT * FROM items ORDER BY createdAt DESC").all() as any[];
  const reservations = db.query("SELECT * FROM reservations").all() as any[];
  const resMap: Record<string, any> = {};
  for (const r of reservations) {
    resMap[r.itemId] = { reservedBy: r.reservedBy, expiresAt: r.expiresAt, waitlist: JSON.parse(r.waitlist || "[]") };
  }
  return c.json({
    items: items.map((i) => ({ ...i, sold: !!i.sold })),
    settings: { ...getAllSettings(), adminPassword: "set" },
    reservations: resMap,
  });
});

app.post("/api/admin/items", async (c) => {
  const body = await c.req.json();
  const id = genId();
  db.run(
    "INSERT INTO items (id, name, description, price, category, condition, imageUrl, sold) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [id, body.name, body.description || "", body.price || 0, body.category || "Other", body.condition || "Good", body.imageUrl || "", body.sold ? 1 : 0]
  );
  return c.json({ ok: true, id });
});

app.put("/api/admin/items/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  db.run(
    "UPDATE items SET name=?, description=?, price=?, category=?, condition=?, imageUrl=?, sold=?, updatedAt=datetime('now') WHERE id=?",
    [body.name, body.description || "", body.price || 0, body.category || "Other", body.condition || "Good", body.imageUrl || "", body.sold ? 1 : 0, id]
  );
  return c.json({ ok: true });
});

app.delete("/api/admin/items/:id", (c) => {
  const id = c.req.param("id");
  db.run("DELETE FROM items WHERE id = ?", [id]);
  db.run("DELETE FROM reservations WHERE itemId = ?", [id]);
  return c.json({ ok: true });
});

app.put("/api/admin/settings", async (c) => {
  const body = await c.req.json();
  if (body.saleTitle !== undefined) setSetting("saleTitle", body.saleTitle);
  if (body.whatsappNumber !== undefined) setSetting("whatsappNumber", body.whatsappNumber.replace(/[^0-9]/g, ""));
  if (body.password) {
    const hashed = await hashPassword(body.password);
    setSetting("adminPassword", hashed);
  }
  return c.json({ ok: true });
});

app.get("/api/admin/export", (c) => {
  const items = db.query("SELECT * FROM items").all() as any[];
  const settings = getAllSettings();
  return c.json({ items: items.map((i) => ({ ...i, sold: !!i.sold })), settings });
});

app.post("/api/admin/import", async (c) => {
  const body = await c.req.json();
  if (!body.items || !body.settings) return c.json({ error: "Invalid format" }, 400);

  db.run("DELETE FROM items");
  db.run("DELETE FROM reservations");
  for (const item of body.items) {
    db.run(
      "INSERT INTO items (id, name, description, price, category, condition, imageUrl, sold, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [item.id || genId(), item.name, item.description || "", item.price || 0, item.category || "Other", item.condition || "Good", item.imageUrl || "", item.sold ? 1 : 0, item.createdAt || new Date().toISOString(), item.updatedAt || new Date().toISOString()]
    );
  }
  if (body.settings.saleTitle) setSetting("saleTitle", body.settings.saleTitle);
  if (body.settings.whatsappNumber) setSetting("whatsappNumber", body.settings.whatsappNumber);
  return c.json({ ok: true });
});

// ─── Image Upload (admin only) ───
app.post("/api/admin/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  if (!file) return c.json({ error: "No file provided" }, 400);

  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) return c.json({ error: "Invalid file type. Allowed: jpg, png, gif, webp, svg" }, 400);
  if (file.size > MAX_FILE_SIZE) return c.json({ error: "File too large. Max 5MB" }, 400);

  const filename = genId() + ext;
  const filepath = join(UPLOADS_DIR, filename);
  const buffer = await file.arrayBuffer();
  await Bun.write(filepath, buffer);

  return c.json({ ok: true, url: `/uploads/${filename}` });
});

// ─── Serve uploaded images ───
app.get("/uploads/:filename", (c) => {
  const filename = c.req.param("filename");
  // Sanitize: only allow alphanumeric, dash, underscore, dot
  if (!/^[a-zA-Z0-9_\-]+\.[a-z]+$/.test(filename)) return c.text("Not found", 404);
  const filepath = join(UPLOADS_DIR, filename);
  if (!existsSync(filepath)) return c.text("Not found", 404);
  const ext = extname(filename).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  const data = readFileSync(filepath);
  return new Response(data, { headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" } });
});

// ─── Serve index.html ───
app.get("*", (c) => {
  const html = readFileSync(join(import.meta.dir, "index.html"), "utf-8");
  return c.html(html);
});

export default {
  port: 3000,
  fetch: app.fetch,
};

console.log("Kuki's Garage Sale running at http://localhost:3000");
