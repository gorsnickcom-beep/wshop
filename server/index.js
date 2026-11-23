// W SHOP server - Express + PostgreSQL (Railway) + persistent storage.
// Works from any network with Railway free tier.

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOAD_DIR, 'drawings'), { recursive: true });

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // Set to Railway domain for QR codes
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// ---------- PostgreSQL ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('rds.amazonaws.com') ? { rejectUnauthorized: false } : false,
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
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
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      admin_notes TEXT DEFAULT '',
      read_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      drawing_path TEXT DEFAULT '',
      variant TEXT DEFAULT ''
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at BIGINT NOT NULL
    );
  `);
}

const dbReady = initDB().catch(err => { console.error(err); process.exit(1); });

function getSetting(key, fallback = null) {
  return query('SELECT value FROM settings WHERE key = $1', [key]).then(rows => rows[0]?.value || fallback);
}
function setSetting(key, value) {
  return query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
}
function getJSON(key, fallback) {
  return getSetting(key, '').then(v => {
    try { return JSON.parse(v); } catch { return fallback; }
  });
}
function setJSON(key, value) { return setSetting(key, JSON.stringify(value)); }

// ---------- Defaults / seed ----------
const DEFAULT_PALETTE = ['#1a1a1a', '#c0392b', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#e84393', '#ffffff'];
const DEFAULT_LOCATIONS = ['Hauptfenster (Schaufenster)', 'Abholpunkt 2', 'Abholpunkt 3', 'Abholpunkt 4'];
const DEFAULT_TEMPLATES = {
  order_received: 'Vielen Dank für Ihre Bestellung! Wir melden uns in Kürze.',
  order_admin: 'Neue Bestellung #{{order_id}} von {{customer_name}} ({{phone}}). Gesamt: {{total}}.',
};
const DEFAULT_INTRO = 'Willkommen bei W SHOP – entdecke Produkte aus unserem Schaufenster. Scanne einen QR-Code, wähle ein Produkt und bestelle online. Der Erlös geht an wohltätige Zwecke.';

// Initialize defaults
(async () => {
  await dbReady;
  const palette = await getSetting('palette');
  if (!palette) await setJSON('palette', DEFAULT_PALETTE);
  const locations = await getSetting('locations');
  if (!locations) await setJSON('locations', DEFAULT_LOCATIONS);
  const templates = await getSetting('templates');
  if (!templates) await setJSON('templates', DEFAULT_TEMPLATES);
  const storeName = await getSetting('store_name');
  if (!storeName) await setSetting('store_name', 'W SHOP');
  const introText = await getSetting('intro_text');
  if (!introText) await setSetting('intro_text', DEFAULT_INTRO);

  const seedVersion = await getSetting('seed_version', '0');
  if (seedVersion !== '2') {
    await query('DELETE FROM order_items');
    await query('DELETE FROM orders');
    await query('DELETE FROM products');
    const items = [
  ['ei', 'Handbemaltes Ei', 'Verziere dein eigenes Ei mit unserem Zeicheneditor.', 1200, 50, 1, '/img/eier.jpg', 1, '', 0, 0, 1],
  ['banane', 'Banane', 'Frische Banane aus dem Schaufenster.', 500, 50, 1, '/img/banane.jpg', 2, 'banana', 10000, 1, 0],
  ['produkt-3', 'Produkt 3', 'Platzhalter – Name, Foto und Beschreibung im Admin-Panel ändern.', 0, 0, 1, '/img/produkt3.jpg', 3, '', 0, 0, 0],
  ['produkt-4', 'Produkt 4', 'Platzhalter – Name, Foto und Beschreibung im Admin-Panel ändern.', 0, 0, 1, '/img/produkt4.jpg', 4, '', 0, 0, 0],
];
    for (const it of items) {
      await query(`INSERT INTO products(slug,name,description,price_cents,stock,available,image_path,sort,variant,variant_price2,special_stock,drawing_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, it);
    }
    await setSetting('seed_version', '2');
  }
})();

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

let admin = { user: 'admin', passHash: null };
(async () => {
  await dbReady;
  let user = process.env.ADMIN_USER || await getSetting('admin_user');
  let passHash = process.env.ADMIN_PASS ? hashPass(process.env.ADMIN_PASS) : await getSetting('admin_pass_hash');
  if (!user || !passHash) {
    user = user || 'admin';
    const pass = crypto.randomBytes(9).toString('base64url');
    passHash = hashPass(pass);
    await setSetting('admin_user', user);
    await setSetting('admin_pass_hash', passHash);
    fs.writeFileSync(path.join(DATA_DIR, 'admin-credentials.txt'),
      `W SHOP admin login\nusername: ${user}\npassword: ${pass}\n(change it in Admin > Settings)\n`);
    console.log(`[wshop] Admin credentials written to data/admin-credentials.txt (user: ${user})`);
  }
  admin = { user, passHash };
})();

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
async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const rows = await query('SELECT created_at FROM sessions WHERE token = $1', [token]);
  const row = rows[0];
  if (!row || Date.now() - row.created_at > SESSION_TTL_MS) {
    if (row) await query('DELETE FROM sessions WHERE token = $1', [token]);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.adminToken = token;
  next();
}

// ---------- Public API ----------
app.get('/api/products', async (req, res) => {
  const rows = await query('SELECT id,slug,name,description,price_cents,stock,available,image_path,variant,variant_price2,special_stock,drawing_enabled FROM products WHERE available=1 ORDER BY sort,id');
  res.json(rows.map(p => ({ ...p, in_stock: p.stock !== 0, special_available: p.special_stock > 0 })));
});

app.get('/api/products/:slug', async (req, res) => {
  const rows = await query('SELECT id,slug,name,description,price_cents,stock,available,image_path,variant,variant_price2,special_stock,drawing_enabled FROM products WHERE slug=$1', [req.params.slug]);
  const p = rows[0];
  if (!p || !p.available) return res.status(404).json({ error: 'Not found' });
  res.json({ ...p, in_stock: p.stock !== 0, special_available: p.special_stock > 0 });
});

app.get('/api/public/settings', async (req, res) => {
  res.json({
    store_name: await getSetting('store_name', 'W SHOP'),
    intro_text: await getSetting('intro_text', DEFAULT_INTRO),
    palette: await getJSON('palette', DEFAULT_PALETTE),
    locations: await getJSON('locations', DEFAULT_LOCATIONS),
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
app.post('/api/orders', async (req, res) => {
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
    const prows = await query('SELECT * FROM products WHERE id=$1 AND available=1', [Number(it.product_id)]);
    const p = prows[0];
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query('INSERT INTO orders(customer_name,email,phone,status) VALUES($1,$2,$3,$4) RETURNING id', [String(customer_name).slice(0, 200), String(email || '').slice(0, 200), String(phone || '').slice(0, 50), 'new']);
    const orderId = orderResult.rows[0].id;
    for (const l of lines) {
      await client.query('INSERT INTO order_items(order_id,product_id,product_name,price_cents,qty,drawing_path,variant) VALUES($1,$2,$3,$4,$5,$6,$7)', [orderId, l.product.id, l.product.name, l.price, l.qty, l.drawingPath, l.isSpecial ? 'special' : '']);
      if (l.isSpecial) {
        await client.query('UPDATE products SET special_stock = special_stock - $1 WHERE id = $2 AND special_stock > 0', [l.qty, l.product.id]);
      } else {
        await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock != -1', [l.qty, l.product.id]);
      }
    }
    await client.query('COMMIT');

    // Notifications
    const templates = await getJSON('templates', DEFAULT_TEMPLATES);
    const vars = { order_id: orderId, customer_name, phone, total: (total / 100).toFixed(2) };
    const adminMail = process.env.ADMIN_EMAIL;
    if (adminMail) {
      sendMail(adminMail, `New order #${orderId} - ${customer_name}`, renderTemplate(templates.order_admin, vars));
    }
    if (email) {
      sendMail(email, `Order #${orderId} received - ${await getSetting('store_name', 'W SHOP')}`,
        renderTemplate(templates.order_received, vars) + `\nTotal: ${(total / 100).toFixed(2)} EUR`);
    }

    res.json({ ok: true, order_id: orderId });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// QR codes
async function productUrl(req, slug) {
  let base = await getSetting('public_url', '') || PUBLIC_URL;
  if (!base) {
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
    base = `${protocol}://${req.get('host') || 'localhost:3000'}`;
  }
  return `${base.replace(/\/+$/, '')}/p/${slug}`;
}
app.get('/qr/:slug.svg', async (req, res) => {
  const rows = await query('SELECT slug FROM products WHERE slug=$1', [req.params.slug]);
  const p = rows[0];
  if (!p) return res.status(404).send('Not found');
  try {
    const svg = await QRCode.toString(await productUrl(req, p.slug), { type: 'svg', margin: 1, width: 400 });
    res.type('svg').send(svg);
  } catch (e) {
    res.status(500).send('QR generation failed');
  }
});

// ---------- Admin API ----------
app.post('/api/admin/login', async (req, res) => {
  const ip = clientIP(req);
  if (loginLimited(ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const { username, password } = req.body || {};
  const envUser = process.env.ADMIN_USER || admin.user;
  const envHash = process.env.ADMIN_PASS ? hashPass(process.env.ADMIN_PASS) : admin.passHash;
  // ADMIN_USER / ADMIN_PASS env vars win over values stored in the DB.
  const dbUser = process.env.ADMIN_USER || await getSetting('admin_user', envUser);
  const dbHash = process.env.ADMIN_PASS ? envHash : await getSetting('admin_pass_hash', envHash);
  if (username !== dbUser || !verifyPass(password || '', dbHash)) {
    recordLoginFail(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  await query('INSERT INTO sessions(token,created_at) VALUES($1,$2)', [token, Date.now()]);
  res.json({ ok: true, token });
});

app.post('/api/admin/logout', requireAdmin, async (req, res) => {
  await query('DELETE FROM sessions WHERE token=$1', [req.adminToken]);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, async (req, res) => res.json({ ok: true }));

app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  const unread = (await query('SELECT COUNT(*) c FROM orders WHERE read_at IS NULL'))[0].c;
  const ordersToday = (await query("SELECT COUNT(*) c FROM orders WHERE DATE(created_at)=CURRENT_DATE"))[0].c;
  res.json({ unread_orders: unread, orders_today: ordersToday, email_configured: !!mailer() });
});

// Products CRUD
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  res.json(await query('SELECT * FROM products ORDER BY sort,id'));
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

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const { out, error } = validateProduct(req.body || {});
  if (error) return res.status(400).json({ error });
  const dup = (await query('SELECT id FROM products WHERE slug=$1', [out.slug]))[0];
  if (dup) return res.status(400).json({ error: 'Slug already exists' });
  const r = await query(`INSERT INTO products(slug,name,description,price_cents,stock,available,image_path,sort,variant,variant_price2,special_stock,drawing_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [out.slug, out.name, out.description || '', out.price_cents, out.stock ?? 0, out.available || 1, out.image_path || '', out.sort ?? 0, out.variant || '', out.variant_price2 || 0, out.special_stock || 0, out.drawing_enabled || 0]);
  res.json({ ok: true, id: r[0].id });
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const exists = (await query('SELECT * FROM products WHERE id=$1', [id]))[0];
  if (!exists) return res.status(404).json({ error: 'Not found' });
  const { out, error } = validateProduct(req.body || {}, true);
  if (error) return res.status(400).json({ error });
  if (out.slug) {
    const dup = (await query('SELECT id FROM products WHERE slug=$1 AND id!=$2', [out.slug, id]))[0];
    if (dup) return res.status(400).json({ error: 'Slug already exists' });
  }
  const fields = Object.keys(out);
  if (fields.length) {
    const setClause = fields.map((f, i) => `${f}=$${i + 2}`).join(',');
    await query(`UPDATE products SET ${setClause} WHERE id=$1`, [id, ...fields.map(f => out[f])]);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  await query('DELETE FROM products WHERE id=$1', [Number(req.params.id)]);
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

app.post('/api/admin/products/:id/image', requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const p = (await query('SELECT * FROM products WHERE id=$1', [Number(req.params.id)]))[0];
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.image_path) {
    const oldFile = path.join(UPLOAD_DIR, path.basename(p.image_path));
    if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
  }
  await query('UPDATE products SET image_path=$1 WHERE id=$2', [`/uploads/${req.file.filename}`, p.id]);
  res.json({ ok: true, image_path: `/uploads/${req.file.filename}` });
});

// Orders
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const status = String(req.query.status || '');
  const rows = status
    ? await query('SELECT * FROM orders WHERE status=$1 ORDER BY id DESC LIMIT 500', [status])
    : await query('SELECT * FROM orders ORDER BY id DESC LIMIT 500');
  res.json(rows);
});

app.get('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const order = (await query('SELECT * FROM orders WHERE id=$1', [Number(req.params.id)]))[0];
  if (!order) return res.status(404).json({ error: 'Not found' });
  const items = await query('SELECT * FROM order_items WHERE order_id=$1', [order.id]);
  if (!order.read_at) {
    await query('UPDATE orders SET read_at=NOW() WHERE id=$1', [order.id]);
  }
  res.json({ ...order, items });
});

const ORDER_STATUSES = ['new', 'processing', 'ready', 'completed', 'cancelled'];
app.put('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const order = (await query('SELECT * FROM orders WHERE id=$1', [id]))[0];
  if (!order) return res.status(404).json({ error: 'Not found' });
  const { status, admin_notes } = req.body || {};
  if (status !== undefined) {
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await query('UPDATE orders SET status=$1 WHERE id=$2', [status, id]);
  }
  if (admin_notes !== undefined) await query('UPDATE orders SET admin_notes=$1 WHERE id=$2', [String(admin_notes).slice(0, 2000), id]);
  res.json({ ok: true });
});

app.get('/api/admin/drawings/:file', requireAdmin, (req, res) => {
  const fname = path.basename(req.params.file);
  const f = path.join(UPLOAD_DIR, 'drawings', fname);
  if (!fs.existsSync(f)) return res.status(404).send('Not found');
  res.sendFile(f);
});

// Settings
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const host = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    store_name: await getSetting('store_name', 'W SHOP'),
    intro_text: await getSetting('intro_text', DEFAULT_INTRO),
    palette: await getJSON('palette', DEFAULT_PALETTE),
    locations: await getJSON('locations', DEFAULT_LOCATIONS),
    templates: await getJSON('templates', DEFAULT_TEMPLATES),
    email_configured: !!mailer(),
    public_url: await getSetting('public_url', host),
    version: '1.0.0',
  });
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (b.store_name !== undefined) await setSetting('store_name', String(b.store_name).slice(0, 100));
  if (b.public_url !== undefined) await setSetting('public_url', String(b.public_url).slice(0, 200));
  if (b.intro_text !== undefined) await setSetting('intro_text', String(b.intro_text).slice(0, 500));
  if (b.palette !== undefined) {
    if (!Array.isArray(b.palette) || b.palette.length > 30 || b.palette.some(c => !/^#[0-9a-fA-F]{6}$/.test(c)))
      return res.status(400).json({ error: 'Palette must be up to 30 hex colors like #ff0000' });
    await setJSON('palette', b.palette);
  }
  if (b.locations !== undefined) {
    if (!Array.isArray(b.locations) || b.locations.length > 20 || b.locations.some(l => !String(l).trim() || String(l).length > 100))
      return res.status(400).json({ error: 'Invalid locations list' });
    await setJSON('locations', b.locations.map(String));
  }
  if (b.templates !== undefined) {
    if (typeof b.templates !== 'object' || b.templates === null) return res.status(400).json({ error: 'Invalid templates' });
    const clean = {};
    for (const k of Object.keys(DEFAULT_TEMPLATES)) clean[k] = String(b.templates[k] ?? '').slice(0, 2000);
    await setJSON('templates', clean);
  }
  res.json({ ok: true });
});

app.post('/api/admin/password', requireAdmin, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const stored = await getSetting('admin_pass_hash', admin.passHash);
  if (!verifyPass(current_password || '', stored)) return res.status(400).json({ error: 'Current password incorrect' });
  if (!new_password || String(new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  await setSetting('admin_pass_hash', hashPass(new_password));
  res.json({ ok: true });
});

// Admin QR codes
app.get('/api/admin/qr/:id.svg', async (req, res) => {
  const p = (await query('SELECT slug,name FROM products WHERE id=$1', [Number(req.params.id)]))[0];
  if (!p) return res.status(404).send('Not found');
  const svg = await QRCode.toString(await productUrl(req, p.slug), { type: 'svg', margin: 1, width: 400 });
  res.type('svg').send(svg);
});

// Product page SSR
app.get('/p/:slug', async (req, res) => {
  const rows = await query('SELECT * FROM products WHERE slug=$1 AND available=1', [req.params.slug]);
  const p = rows[0];
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
    priceCents: p.price_cents,
    stock: p.stock,
    imagePath: p.image_path,
    variant: p.variant || '',
    variantPrice2: p.variant_price2 || 0,
    specialStock: p.special_stock || 0,
    drawingEnabled: p.drawing_enabled || 0,
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
  console.log(`[wshop] PostgreSQL connected`);
});
