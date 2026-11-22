// W SHOP server - Express + SQLite + local file storage.
// All secrets come from environment variables or data/ files; nothing is hard-coded.

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const multer = require('multer');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://wshop.onrender.com'; // Your public domain for QR codes
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// ---------- Database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'wshop.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1,
  image_path TEXT DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  variant TEXT DEFAULT '',
  variant_price2 INTEGER DEFAULT 0,
  special_stock INTEGER DEFAULT 0,
  drawing_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  admin_notes TEXT DEFAULT '',
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  product_name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  drawing_path TEXT DEFAULT '',
  variant TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
`);

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}
function getJSON(key, fallback) {
  try { return JSON.parse(getSetting(key, '')); } catch { return fallback; }
}
function setJSON(key, value) { setSetting(key, JSON.stringify(value)); }

// ---------- Defaults / seed ----------
const DEFAULT_PALETTE = ['#1a1a1a', '#c0392b', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#e84393', '#ffffff'];
const DEFAULT_LOCATIONS = ['Hauptfenster (Schaufenster)', 'Abholpunkt 2', 'Abholpunkt 3', 'Abholpunkt 4'];
const DEFAULT_TEMPLATES = {
  order_received: 'Vielen Dank für Ihre Bestellung! Wir melden uns in Kürze.',
  order_admin: 'Neue Bestellung #{{order_id}} von {{customer_name}} ({{phone}}). Gesamt: {{total}}.',
};
const DEFAULT_INTRO = 'Willkommen bei W SHOP – entdecke Produkte aus unserem Schaufenster. Scanne einen QR-Code, wähle ein Produkt und bestelle online. Der Erlös geht an wohltätige Zwecke.';

if (!getSetting('palette')) setJSON('palette', DEFAULT_PALETTE);
if (!getSetting('locations')) setJSON('locations', DEFAULT_LOCATIONS);
if (!getSetting('templates')) setJSON('templates', DEFAULT_TEMPLATES);
if (!getSetting('store_name')) setSetting('store_name', 'W SHOP');
if (!getSetting('intro_text')) setSetting('intro_text', DEFAULT_INTRO);

// Re-seed if seed_version changed
const SEED_VERSION = 2;
if (getSetting('seed_version', '0') !== String(SEED_VERSION)) {
  db.exec('DELETE FROM products');
  db.exec('DELETE FROM order_items');
  db.exec('DELETE FROM orders');
  const seed = db.prepare(`INSERT INTO products(slug,name,description,price_cents,stock,available,image_path,sort,variant,variant_price2,special_stock,drawing_enabled)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const items = [
    ['ei', 'Handbemaltes Ei', 'Verziere dein eigenes Ei mit unserem Zeicheneditor.', 1200, 50, 1, '/img/egg-placeholder.svg', 1, '', 0, 0, 1],
    ['banane', 'Banane', 'Frische Banane aus dem Schaufenster.', 500, 50, 1, '/img/banane-placeholder.svg', 2, 'banana', 10000, 1, 0],
    ['produkt-3', 'Produkt 3', 'Platzhalter – Name, Foto und Beschreibung im Admin-Panel ändern.', 0, 0, 1, '/img/placeholder.svg', 3, '', 0, 0, 0],
    ['produkt-4', 'Produkt 4', 'Platzhalter – Name, Foto und Beschreibung im Admin-Panel ändern.', 0, 0, 1, '/img/placeholder.svg', 4, '', 0, 0, 0],
  ];
  for (const it of items) seed.run(...it);
  setSetting('seed_version', String(SEED_VERSION));
}

// ---------- Admin credentials ----------
function hashPass(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPass(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const test = crypto.scryptSync(String(pw), salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return test.length === orig.length && crypto.timingSafeEqual(test, orig);
}

function ensureAdmin() {
  let user = process.env.ADMIN_USER || getSetting('admin_user');
  let passHash = process.env.ADMIN_PASS ? hashPass(process.env.ADMIN_PASS) : getSetting('admin_pass_hash');
  if (!user || !passHash) {
    user = user || 'admin';
    const pass = crypto.randomBytes(9).toString('base64url');
    passHash = hashPass(pass);
    setSetting('admin_user', user);
    setSetting('admin_pass_hash', passHash);
    fs.writeFileSync(path.join(DATA_DIR, 'admin-credentials.txt'),
      `W SHOP admin login\nusername: ${user}\npassword: ${pass}\n(change it in Admin > Settings)\n`);
    console.log(`[wshop] Admin credentials written to data/admin-credentials.txt (user: ${user})`);
  }
  return { user, passHash };
}
const admin = ensureAdmin();

// Rate limiting
const loginAttempts = new Map();
function loginLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (rec.until > now) return true;
  if (rec.count > 0 && now - (rec.last || 0) > 10 * 60 * 1000) rec.count = 0;
  return false;
}
function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  rec.count++; rec.last = Date.now();
  if (rec.count >= 8) { rec.until = Date.now() + 10 * 60 * 1000; rec.count = 0; }
  loginAttempts.set(ip, rec);
}

// ---------- Email ----------
function mailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}
async function sendMail(to, subject, text) {
  const t = mailer();
  if (!t) return { sent: false, reason: 'SMTP not configured' };
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

// ---------- Express app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(ROOT, 'public')));

function clientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ---------- Auth middleware ----------
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const row = db.prepare('SELECT created_at FROM sessions WHERE token = ?').get(token);
  if (!row || Date.now() - row.created_at > SESSION_TTL_MS) {
    if (row) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.adminToken = token;
  next();
}

// ---------- Public API ----------
app.get('/api/products', (req, res) => {
  const rows = db.prepare('SELECT id,slug,name,description,price_cents,stock,available,image_path,variant,variant_price2,special_stock,drawing_enabled FROM products WHERE available=1 ORDER BY sort,id').all();
  res.json(rows.map(p => ({ ...p, in_stock: p.stock !== 0, special_available: p.special_stock > 0 })));
});

app.get('/api/products/:slug', (req, res) => {
  const p = db.prepare('SELECT id,slug,name,description,price_cents,stock,available,image_path,variant,variant_price2,special_stock,drawing_enabled FROM products WHERE slug=?').get(req.params.slug);
  if (!p || !p.available) return res.status(404).json({ error: 'Not found' });
  res.json({ ...p, in_stock: p.stock !== 0, special_available: p.special_stock > 0 });
});

app.get('/api/public/settings', (req, res) => {
  res.json({
    store_name: getSetting('store_name', 'W SHOP'),
    intro_text: getSetting('intro_text', DEFAULT_INTRO),
    palette: getJSON('palette', DEFAULT_PALETTE),
    locations: getJSON('locations', DEFAULT_LOCATIONS),
  });
});

// Drawings
app.post('/api/drawings', (req, res) => {
  const { dataUrl } = req.body || {};
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return res.status(400).json({ error: 'Invalid image data' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image too large' });
  const id = crypto.randomUUID();
  const filename = `${id}.${m[1] === 'png' ? 'png' : m[1] === 'jpeg' ? 'jpg' : 'webp'}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, 'drawings', filename), buf, { flag: 'wx' });
  res.json({ id, filename });
});

// Orders
app.post('/api/orders', (req, res) => {
  const { customer_name, email, phone, items } = req.body || {};
  if (!customer_name || !String(customer_name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !String(email).trim()) return res.status(400).json({ error: 'E-Mail is required' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });
  if (items.length > 100) return res.status(400).json({ error: 'Too many items' });

  const lines = [];
  let total = 0;
  for (const it of items) {
    const qty = Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) return res.status(400).json({ error: 'Invalid quantity' });
    const p = db.prepare('SELECT * FROM products WHERE id=? AND available=1').get(Number(it.product_id));
    if (!p) return res.status(400).json({ error: 'Product unavailable' });
    const isSpecial = it.variant === 'special';
    if (isSpecial) {
      if (p.special_stock < qty) return res.status(400).json({ error: `Schaufenster-Banane nicht verfügbar (nur ${p.special_stock} Stück)` });
    } else {
      if (p.stock !== -1 && p.stock < qty) return res.status(400).json({ error: `Nicht genug Bestand für ${p.name}: nur ${p.stock} verfügbar` });
    }
    let drawingPath = '';
    if (it.drawing_id) {
      const safe = /^[a-zA-Z0-9-]+\.(png|jpg|webp)$/.test(String(it.drawing_id));
      const fname = safe ? String(it.drawing_id).replace(/^.*\//, '') : '';
      if (!fname || !fs.existsSync(path.join(UPLOAD_DIR, 'drawings', fname))) {
        return res.status(400).json({ error: 'Invalid drawing' });
      }
      drawingPath = `drawings/${fname}`;
    }
    const price = isSpecial ? (p.variant_price2 || p.price_cents) : p.price_cents;
    lines.push({ product: p, qty, drawingPath, isSpecial, price });
    total += price * qty;
  }

  const insertOrder = db.prepare(`INSERT INTO orders(customer_name,email,phone,status) VALUES(?,?,?,?,'new')`);
  const insertItem = db.prepare(`INSERT INTO order_items(order_id,product_id,product_name,price_cents,qty,drawing_path,variant) VALUES(?,?,?,?,?,?,?,?)`);
  const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock != -1');
  const decSpecial = db.prepare('UPDATE products SET special_stock = special_stock - ? WHERE id = ? AND special_stock > 0');

  let orderId;
  db.exec('BEGIN');
  try {
    const r = insertOrder.run(String(customer_name).slice(0, 200), String(email || '').slice(0, 200), String(phone || '').slice(0, 50));
    orderId = Number(r.lastInsertRowid);
    for (const l of lines) {
      insertItem.run(orderId, l.product.id, l.product.name, l.price, l.qty, l.drawingPath, l.isSpecial ? 'special' : '');
      if (l.isSpecial) decSpecial.run(l.qty, l.product.id);
      else decStock.run(l.qty, l.product.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Notifications
  const templates = getJSON('templates', DEFAULT_TEMPLATES);
  const vars = { order_id: orderId, customer_name, phone, total: (total / 100).toFixed(2) };
  const adminMail = process.env.ADMIN_EMAIL;
  if (adminMail) {
    sendMail(adminMail, `New order #${orderId} - ${customer_name}`, renderTemplate(templates.order_admin, vars));
  }
  if (email) {
    sendMail(email, `Order #${orderId} received - ${getSetting('store_name', 'W SHOP')}`,
      renderTemplate(templates.order_received, vars) + `\nTotal: ${(total / 100).toFixed(2)} EUR`);
  }

  res.json({ ok: true, order_id: orderId });
});

// QR codes - IMPORTANT: Uses PUBLIC_URL env var for QR generation
function productUrl(req, slug) {
  const protocol = req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  return `${protocol}://${host}/p/${slug}`;
}
app.get('/qr/:slug.svg', async (req, res) => {
  const p = db.prepare('SELECT slug FROM products WHERE slug=?').get(req.params.slug);
  if (!p) return res.status(404).send('Not found');
  try {
    const svg = await QRCode.toString(productUrl(req, p.slug), { type: 'svg', margin: 1, width: 400 });
    res.type('svg').send(svg);
  } catch (e) {
    res.status(500).send('QR generation failed');
  }
});

// ---------- Admin API ----------
app.post('/api/admin/login', (req, res) => {
  const ip = clientIP(req);
  if (loginLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { username, password } = req.body || {};
  const envUser = process.env.ADMIN_USER || admin.user;
  const envHash = process.env.ADMIN_PASS ? hashPass(process.env.ADMIN_PASS) : admin.passHash;
  const dbUser = getSetting('admin_user', envUser);
  const dbHash = getSetting('admin_pass_hash', envHash);
  if (username !== dbUser || !verifyPass(password || '', dbHash)) {
    recordLoginFail(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,created_at) VALUES(?,?)').run(token, Date.now());
  res.json({ ok: true, token });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(req.adminToken);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const unread = db.prepare('SELECT COUNT(*) c FROM orders WHERE read_at IS NULL').get().c;
  const ordersToday = db.prepare("SELECT COUNT(*) c FROM orders WHERE date(created_at)=date('now')").get().c;
  res.json({ unread_orders: unread, orders_today: ordersToday, email_configured: !!mailer() });
});

// Products CRUD
app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY sort,id').all());
});

function validateProduct(body, partial = false) {
  const out = {};
  if (!partial || body.slug !== undefined) {
    const slug = String(body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return { error: 'Slug is required (a-z, 0-9, dashes)' };
    out.slug = slug;
  }
  if (!partial || body.name !== undefined) {
    if (!String(body.name || '').trim()) return { error: 'Name is required' };
    out.name = String(body.name).slice(0, 200);
  }
  if (body.description !== undefined) out.description = String(body.description).slice(0, 2000);
  if (!partial || body.price_cents !== undefined) {
    const cents = Math.round(Number(body.price_cents));
    if (!Number.isFinite(cents) || cents < 0 || cents > 10000000) return { error: 'Invalid price' };
    out.price_cents = cents;
  }
  if (body.stock !== undefined) {
    const s = Math.floor(Number(body.stock));
    if (!Number.isFinite(s) || s < -1) return { error: 'Invalid stock (-1 = unlimited)' };
    out.stock = s;
  }
  if (body.available !== undefined) out.available = body.available ? 1 : 0;
  if (body.sort !== undefined) out.sort = Math.floor(Number(body.sort) || 0);
  if (body.variant !== undefined) out.variant = String(body.variant).slice(0, 20);
  if (body.variant_price2 !== undefined) {
    const c = Math.round(Number(body.variant_price2));
    if (!Number.isFinite(c) || c < 0 || c > 10000000) return { error: 'Invalid variant price' };
    out.variant_price2 = c;
  }
  if (body.special_stock !== undefined) {
    const s = Math.floor(Number(body.special_stock));
    if (!Number.isFinite(s) || s < 0) return { error: 'Invalid special stock' };
    out.special_stock = s;
  }
  if (body.drawing_enabled !== undefined) out.drawing_enabled = body.drawing_enabled ? 1 : 0;
  return { out };
}

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { out, error } = validateProduct(req.body || {});
  if (error) return res.status(400).json({ error });
  const dup = db.prepare('SELECT id FROM products WHERE slug=?').get(out.slug);
  if (dup) return res.status(400).json({ error: 'Slug already exists' });
  const r = db.prepare(`INSERT INTO products(slug,name,description,price_cents,stock,available,image_path,sort,variant,variant_price2,special_stock,drawing_enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(out.slug, out.name, out.description || '', out.price_cents, out.stock ?? 0, out.available || 1, out.image_path || '', out.sort ?? 0, out.variant || '', out.variant_price2 || 0, out.special_stock || 0, out.drawing_enabled || 0);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  const { out, error } = validateProduct(req.body || {}, true);
  if (error) return res.status(400).json({ error });
  if (out.slug) {
    const dup = db.prepare('SELECT id FROM products WHERE slug=? AND id!=?').get(out.slug, id);
    if (dup) return res.status(400).json({ error: 'Slug already exists' });
  }
  const fields = Object.keys(out);
  if (fields.length) {
    db.prepare(`UPDATE products SET ${fields.map(f => `${f}=?`).join(',')} WHERE id=?`).run(...fields.map(f => out[f]), id);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = (file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg');
      cb(null, `prod-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

app.post('/api/admin/products/:id/image', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.imagePath) {
    const oldFile = path.join(UPLOAD_DIR, path.basename(p.imagePath));
    if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
  }
  db.prepare('UPDATE products SET image_path=? WHERE id=?').run(`/uploads/${req.file.filename}`, p.id);
  res.json({ ok: true, image_path: `/uploads/${req.file.filename}` });
});

// Orders
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const status = String(req.query.status || '');
  const rows = status
    ? db.prepare('SELECT * FROM orders WHERE status=? ORDER BY id DESC LIMIT 500').all(status)
    : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 500').all();
  res.json(rows);
});

app.get('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
  if (!order.readAt) db.prepare("UPDATE orders SET read_at=datetime('now') WHERE id=?").run(order.id);
  res.json({ ...order, items });
});

const ORDER_STATUSES = ['new', 'processing', 'ready', 'completed', 'cancelled'];
app.put('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const { status, admin_notes } = req.body || {};
  if (status !== undefined) {
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, id);
  }
  if (admin_notes !== undefined) db.prepare('UPDATE orders SET admin_notes=? WHERE id=?').run(String(admin_notes).slice(0, 2000), id);
  res.json({ ok: true });
});

app.get('/api/admin/drawings/:file', requireAdmin, (req, res) => {
  const fname = path.basename(req.params.file);
  const f = path.join(UPLOAD_DIR, 'drawings', fname);
  if (!fs.existsSync(f)) return res.status(404).send('Not found');
  res.sendFile(f);
});

// Settings
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const host = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    store_name: getSetting('store_name', 'W SHOP'),
    intro_text: getSetting('intro_text', DEFAULT_INTRO),
    palette: getJSON('palette', DEFAULT_PALETTE),
    locations: getJSON('locations', DEFAULT_LOCATIONS),
    templates: getJSON('templates', DEFAULT_TEMPLATES),
    email_configured: !!mailer(),
    public_url: getSetting('public_url', host),
    version: '1.0.0',
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (b.store_name !== undefined) setSetting('store_name', String(b.store_name).slice(0, 100));
  if (b.public_url !== undefined) setSetting('public_url', String(b.public_url).slice(0, 200));
  if (b.intro_text !== undefined) setSetting('intro_text', String(b.intro_text).slice(0, 500));
  if (b.palette !== undefined) {
    if (!Array.isArray(b.palette) || b.palette.length > 30 || b.palette.some(c => !/^#[0-9a-fA-F]{6}$/.test(c)))
      return res.status(400).json({ error: 'Palette must be up to 30 hex colors like #ff0000' });
    setJSON('palette', b.palette);
  }
  if (b.locations !== undefined) {
    if (!Array.isArray(b.locations) || b.locations.length > 20 || b.locations.some(l => !String(l).trim() || String(l).length > 100))
      return res.status(400).json({ error: 'Invalid locations list' });
    setJSON('locations', b.locations.map(String));
  }
  if (b.templates !== undefined) {
    if (typeof b.templates !== 'object' || b.templates === null) return res.status(400).json({ error: 'Invalid templates' });
    const clean = {};
    for (const k of Object.keys(DEFAULT_TEMPLATES)) clean[k] = String(b.templates[k] ?? '').slice(0, 2000);
    setJSON('templates', clean);
  }
  res.json({ ok: true });
});

app.post('/api/admin/password', requireAdmin, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const stored = getSetting('admin_pass_hash', admin.passHash);
  if (!verifyPass(current_password || '', stored)) return res.status(400).json({ error: 'Current password incorrect' });
  if (!new_password || String(new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  setSetting('admin_pass_hash', hashPass(new_password));
  res.json({ ok: true });
});

// Admin QR codes
app.get('/api/admin/qr/:id.svg', async (req, res) => {
  const p = db.prepare('SELECT slug,name FROM products WHERE id=?').get(Number(req.params.id));
  if (!p) return res.status(404).send('Not found');
  const svg = await QRCode.toString(productUrl(req, p.slug), { type: 'svg', margin: 1, width: 400 });
  res.type('svg').send(svg);
});

// Product page SSR
app.get('/p/:slug', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE slug=? AND available=1').get(req.params.slug);
  if (!p) return res.status(404).sendFile(path.join(ROOT, 'public', 'index.html'));
  const escaped = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = (c) => (c / 100).toFixed(2);
  const soldOut = p.stock === 0;
  const isBanana = p.variant === 'banana';
  const drawingEnabled = p.drawing_enabled === 1;

  let buyButtons = '';
  if (isBanana) {
    buyButtons = '<button class="btn" id="btn-cart"' + (soldOut ? ' disabled' : '') + '>4er-Bananenbund kaufen</button>' +
      '<button class="btn" id="btn-special"' + (p.special_stock < 1 ? ' disabled' : '') + '>Die Banane aus dem Schaufenster kaufen (' + money(p.variant_price2 || p.price_cents) + ' EUR)</button>';
  } else {
    buyButtons = '<button class="btn" id="btn-cart"' + (soldOut ? ' disabled' : '') + '>In den Warenkorb</button>' +
      '<button class="btn ghost" id="btn-buy"' + (soldOut ? ' disabled' : '') + '>Jetzt kaufen</button>';
  }

  let drawButton = drawingEnabled ? '<button class="btn ghost" id="btn-draw" type="button">Auf Ei zeichnen</button>' : '';

  const productHtml = `
    <div class="imgbox"><img src="${p.image_path || '/img/egg-placeholder.svg'}" alt="${escaped(p.name)}"></div>
    <div>
      <h1>${escaped(p.name)}</h1>
      <div class="price" style="font-size:22px;margin:6px 0">${money(p.price_cents)} <small>EUR</small></div>
      <div class="desc">${escaped(p.description || '')}</div>
      <div class="hint" style="margin:8px 0">${soldOut ? 'Ausverkauft' : (p.stock === -1 ? 'Verfügbar' : p.stock + ' verfügbar')}</div>
      ${isBanana && p.special_stock > 0 ? '<div class="hint" style="margin:4px 0">Schaufenster-Banane: ' + p.special_stock + ' verfügbar</div>' : ''}
      <div class="actions">
        <div class="qty">
          <button type="button" onclick="stepQty(-1)">-</button>
          <input id="qty" type="number" min="1" max="99" value="1">
          <button type="button" onclick="stepQty(1)">+</button>
        </div>
      </div>
      <div class="actions">${buyButtons}${drawButton}</div>
      <div id="custom-note"></div>
    </div>`;

  const html = fs.readFileSync(path.join(ROOT, 'public', 'product.html'), 'utf8');
  const finalHtml = html.replace('<section id="product" class="product"><div class="empty">Laden…</div></section>', '<section id="product" class="product">' + productHtml + '</section>');
  const ssrData = {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    stock: p.stock,
    imagePath: p.imagePath,
    variant: p.variant || '',
    variantPrice2: p.variantPrice2 || 0,
    specialStock: p.specialStock || 0,
    drawingEnabled: p.drawingEnabled || 0,
  };
  const injected = '<script>window.__PRODUCT_DATA = ' + JSON.stringify(ssrData) + ';</script>';
  const finalHtml2 = finalHtml.replace('</head>', injected + '</head>');
  res.send(finalHtml2);
});

app.get('/admin', (req, res) => res.redirect('/admin.html'));

for (const page of ['cart', 'checkout']) {
  app.get(`/${page}`, (req, res) => res.sendFile(path.join(ROOT, 'public', `${page}.html`)));
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[wshop] W SHOP running at http://localhost:${PORT}`);
  console.log(`[wshop] Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`[wshop] IMPORTANT: Set PUBLIC_URL env var to your public domain for QR codes to work outside your network`);
});
