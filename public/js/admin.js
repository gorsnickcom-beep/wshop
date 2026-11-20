// W SHOP admin panel - single page app.
const Admin = (() => {
  const app = document.getElementById('app');
  let products = [];
  let orderStatusFilter = '';
  let currentOrder = null;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  async function api(path, opts = {}) {
    const token = localStorage.getItem('wshop_admin_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(path, {
      headers,
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin(); throw new Error('auth'); }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  // ---------- Login ----------
  function showLogin() {
    app.innerHTML = `
      <div style="max-width:380px;margin:80px auto;padding:0 20px">
        <div class="panel">
          <h2>W SHOP Admin</h2>
          <div id="login-msg"></div>
          <form id="login-form">
            <label class="field"><span>Username</span><input type="text" name="username" required autocomplete="username"></label>
            <label class="field"><span>Password</span><input type="password" name="password" required autocomplete="current-password"></label>
            <button class="btn" type="submit" style="width:100%">Sign in</button>
          </form>
          <p class="hint" style="margin-top:14px">First login credentials are in <span class="mono">data/admin-credentials.txt</span></p>
        </div>
      </div>`;
    document.getElementById('login-form').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const res = await api('/api/admin/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
        localStorage.setItem('wshop_admin_token', res.token);
        boot();
      } catch (err) {
        document.getElementById('login-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
      }
    };
  }

  // ---------- Shell ----------
  const NAV = [
    ['dashboard', 'Dashboard'],
    ['products', 'Products'],
    ['orders', 'Orders'],
    ['qr', 'QR Codes'],
    ['settings', 'Settings'],
  ];
  function shell(section, content) {
    app.innerHTML = `
      <div class="admin-layout">
        <nav class="admin-nav">
          <div class="brand" style="padding:0 12px 14px"><span>W</span> SHOP <span style="font-weight:400;font-size:12px;opacity:.7">admin</span></div>
          ${NAV.map(([k, label]) => `<a href="#/${k}" class="${k === section ? 'active' : ''}">${label}<span class="badge" id="nav-badge-${k}" style="display:none"></span></a>`).join('')}
          <a href="#" class="logout" id="nav-logout">Log out</a>
        </nav>
        <main class="admin-main" id="admin-content">${content}</main>
      </div>`;
    document.getElementById('nav-logout').onclick = async e => {
      e.preventDefault();
      await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
      showLogin();
    };
    refreshBadge();
  }

  async function refreshBadge() {
    try {
      const o = await api('/api/admin/overview');
      const b = document.getElementById('nav-badge-orders');
      if (b) {
        b.textContent = o.unread_orders;
        b.style.display = o.unread_orders ? 'inline-block' : 'none';
      }
    } catch { /* logged out */ }
  }

  // ---------- Dashboard ----------
  async function renderDashboard() {
    shell('dashboard', '<div class="empty">Loading…</div>');
    try {
      const o = await api('/api/admin/overview');
      const recent = await api('/api/admin/orders');
      document.getElementById('admin-content').innerHTML = `
        <h2 style="margin-top:0">Dashboard</h2>
        <div class="grid-2">
          <div class="panel"><h2>New orders</h2><div style="font-size:34px;font-weight:800">${o.unread_orders}</div><p class="hint">Unread notifications</p></div>
          <div class="panel"><h2>Orders today</h2><div style="font-size:34px;font-weight:800">${o.orders_today}</div><p class="hint">${o.email_configured ? 'Email notifications: configured' : 'Email notifications: not configured (SMTP env vars missing)'}</p></div>
        </div>
        <div class="panel">
          <h2>Recent orders</h2>
          ${recent.length ? `<div class="table-wrap"><table>
            <tr><th>#</th><th>Date</th><th>Customer</th><th>Status</th></tr>
            ${recent.slice(0, 8).map(r => orderRow(r)).join('')}
          </table></div>` : '<p class="hint">No orders yet.</p>'}
        </div>`;
      bindOrderRows();
    } catch (e) { /* auth handled */ }
  }

  function orderRow(r) {
    return `<tr data-order="${r.id}" style="cursor:pointer">
      <td class="mono">#${r.id}</td>
      <td>${esc(r.created_at)}</td>
      <td>${esc(r.customer_name)}${r.read_at ? '' : ' <span class="badge">new</span>'}</td>
      <td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td>
    </tr>`;
  }
  function bindOrderRows() {
    document.querySelectorAll('tr[data-order]').forEach(tr => {
      tr.onclick = () => { location.hash = '#/orders'; openOrder(Number(tr.dataset.order)); };
    });
  }

  // ---------- Products ----------
  async function renderProducts() {
    shell('products', '<div class="empty">Loading…</div>');
    try {
      products = await api('/api/admin/products');
      document.getElementById('admin-content').innerHTML = `
        <h2 style="margin-top:0">Products</h2>
        <div class="panel">
          <h3 id="product-form-title">Add product</h3>
          <form id="product-form">
            <input type="hidden" name="id">
            <label class="field"><span>Name *</span><input type="text" name="name" required></label>
            <label class="field"><span>Slug (URL) *</span><input type="text" name="slug" required placeholder="my-egg"></label>
            <label class="field"><span>Description</span><textarea name="description" rows="2"></textarea></label>
            <label class="field"><span>Price (EUR)</span><input type="number" name="price" step="0.01" min="0" required></label>
            <label class="field"><span>Stock (-1 = unlimited)</span><input type="number" name="stock" value="0"></label>
            <label class="field"><span>Sort order</span><input type="number" name="sort" value="0"></label>
            <label class="field" style="display:flex;align-items:flex-end;gap:8px;padding-bottom:12px">
              <input type="checkbox" name="available" checked style="width:auto"> <span style="margin:0">Available for purchase</span>
            </label>
            <label class="field"><span>Variant type (empty=none, banana=banana)</span><input type="text" name="variant" value=""></label>
            <label class="field"><span>Variant price 2 (EUR) - special item</span><input type="number" name="variant_price2" step="0.01" min="0" value="0"></label>
            <label class="field"><span>Special stock (0=none)</span><input type="number" name="special_stock" min="0" value="0"></label>
            <label class="field" style="display:flex;align-items:flex-end;gap:8px;padding-bottom:12px">
              <input type="checkbox" name="drawing_enabled" style="width:auto"> <span style="margin:0">Enable drawing editor</span>
            </label>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn" type="submit">Save product</button>
              <button class="btn ghost" type="button" id="product-cancel" style="display:none">Cancel edit</button>
            </div>
          </form>
          <div id="product-msg"></div>
        </div>
        <div class="panel">
          <h3>All products</h3>
          <div class="table-wrap"><table>
            <tr><th></th><th>Name</th><th>Price</th><th>Stock</th><th>Available</th><th>QR</th><th></th></tr>
            ${products.map(p => `
              <tr>
                <td><img class="thumb-sm" src="${esc(p.image_path) || '/img/egg-placeholder.svg'}" alt=""></td>
                <td><a href="/p/${encodeURIComponent(p.slug)}" target="_blank">${esc(p.name)}</a><br><span class="hint mono">/p/${esc(p.slug)}</span></td>
                <td>${(p.price_cents / 100).toFixed(2)} EUR</td>
                <td>${p.stock === -1 ? '∞' : p.stock}</td>
                <td>${p.available ? 'Yes' : 'No'}</td>
                <td><a class="hint mono" href="/qr/${encodeURIComponent(p.slug)}.svg" target="_blank">QR</a></td>
                <td style="white-space:normal">
                  <button class="btn small ghost" data-edit="${p.id}" type="button">Edit</button>
                  <label class="btn small ghost" style="display:inline-block;cursor:pointer">Photo
                    <input type="file" accept="image/*" data-upload="${p.id}" style="display:none">
                  </label>
                  <button class="btn small danger" data-del="${p.id}" type="button">Delete</button>
                </td>
              </tr>`).join('')}
          </table></div>
        </div>`;

      const form = document.getElementById('product-form');
      form.onsubmit = async e => {
        e.preventDefault();
        const f = new FormData(form);
        const id = f.get('id');
        const body = {
          name: f.get('name'), slug: f.get('slug'), description: f.get('description'),
          price_cents: Math.round(Number(f.get('price')) * 100),
          stock: Number(f.get('stock')),
          sort: Number(f.get('sort')) || 0,
          available: !!f.get('available'),
          variant: f.get('variant'),
          variant_price2: Math.round(Number(f.get('variant_price2')) * 100),
          special_stock: Number(f.get('special_stock')),
          drawing_enabled: !!f.get('drawing_enabled'),
        };
        try {
          if (id) await api(`/api/admin/products/${id}`, { method: 'PUT', body });
          else await api('/api/admin/products', { method: 'POST', body });
          document.getElementById('product-msg').innerHTML = '<div class="msg ok">Saved.</div>';
          renderProducts();
        } catch (err) {
          document.getElementById('product-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
        }
      };
      document.getElementById('product-cancel').onclick = () => { form.reset(); form.elements.id.value = ''; document.getElementById('product-form-title').textContent = 'Add product'; document.getElementById('product-cancel').style.display = 'none'; };

      document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
        const p = products.find(x => x.id === Number(b.dataset.edit));
        if (!p) return;
        form.elements.id.value = p.id;
        form.elements.name.value = p.name;
        form.elements.slug.value = p.slug;
        form.elements.description.value = p.description || '';
        form.elements.price.value = (p.price_cents / 100).toFixed(2);
        form.elements.stock.value = p.stock;
        form.elements.sort.value = p.sort || 0;
        form.elements.available.checked = !!p.available;
        form.elements.variant.value = p.variant || '';
        form.elements.variant_price2.value = (p.variant_price2 / 100).toFixed(2);
        form.elements.special_stock.value = p.special_stock || 0;
        form.elements.drawing_enabled.checked = !!p.drawing_enabled;
        document.getElementById('product-form-title').textContent = `Edit: ${p.name}`;
        document.getElementById('product-cancel').style.display = 'inline-block';
        form.scrollIntoView({ behavior: 'smooth' });
      });
      document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm('Delete this product? Existing orders keep their data.')) return;
        await api(`/api/admin/products/${b.dataset.del}`, { method: 'DELETE' });
        renderProducts();
      });
      document.querySelectorAll('[data-upload]').forEach(inp => inp.onchange = async () => {
        if (!inp.files[0]) return;
        const fd = new FormData();
        fd.append('image', inp.files[0]);
        const res = await fetch(`/api/admin/products/${inp.dataset.upload}/image`, { method: 'POST', body: fd, credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok) alert(data.error || 'Upload failed');
        else renderProducts();
      });
    } catch (e) { /* auth */ }
  }

  // ---------- Orders ----------
  async function renderOrders() {
    shell('orders', '<div class="empty">Loading…</div>');
    const filter = orderStatusFilter;
    try {
      const orders = await api('/api/admin/orders' + (filter ? `?status=${filter}` : ''));
      document.getElementById('admin-content').innerHTML = `
        <h2 style="margin-top:0">Orders</h2>
        <div class="panel">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
            ${['', 'new', 'processing', 'ready', 'completed', 'cancelled'].map(s =>
              `<button class="btn small ${filter === s ? '' : 'ghost'}" data-f="${s}" type="button">${s || 'All'}</button>`).join('')}
          </div>
          <div id="order-detail"></div>
          <div class="table-wrap"><table>
            <tr><th>#</th><th>Date</th><th>Customer</th><th>Pickup</th><th>Status</th><th></th></tr>
            ${orders.length ? orders.map(r => `
              <tr data-order="${r.id}" style="cursor:pointer">
                <td class="mono">#${r.id}</td>
                <td>${esc(r.created_at)}</td>
                <td>${esc(r.customer_name)}${r.read_at ? '' : ' <span class="badge">new</span>'}</td>
                <td>${esc(r.pickup_location)}</td>
                <td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td>
                <td><button class="btn small ghost" data-view="${r.id}" type="button">View</button></td>
              </tr>`).join('') : '<tr><td colspan="6" class="hint">No orders.</td></tr>'}
          </table></div>
        </div>`;
      document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { orderStatusFilter = b.dataset.f; renderOrders(); });
      document.querySelectorAll('[data-view],[data-order]').forEach(el => {
        el.onclick = ev => { if (ev.target.closest('button')) return; openOrder(Number(el.dataset.view || el.dataset.order)); };
      });
    } catch (e) { /* auth */ }
  }

  async function openOrder(id) {
    const detail = document.getElementById('order-detail');
    if (!detail) return;
    try {
      const o = await api(`/api/admin/orders/${id}`);
      currentOrder = o;
      const total = o.items.reduce((s, i) => s + i.price_cents * i.qty, 0);
      const phoneDigits = String(o.phone || '').replace(/[^\d+]/g, '');
      const waPhone = phoneDigits.replace(/^\+/, '');
      const waText = encodeURIComponent(`Hello ${o.customer_name}, regarding your W SHOP order #${o.id}.`);
      detail.innerHTML = `
        <div class="panel" style="border-color:var(--accent)">
          <h3>Order #${o.id} — ${esc(o.status)} <button class="btn small ghost" id="order-close" type="button" style="float:right">Close</button></h3>
          <div class="grid-2">
            <div>
              <p><strong>Customer:</strong> ${esc(o.customer_name)}<br>
              <strong>Email:</strong> ${o.email ? `<a href="mailto:${esc(o.email)}?subject=Order%20%23${o.id}">${esc(o.email)}</a>` : '<span class="hint">not provided</span>'}<br>
              <strong>Phone:</strong> ${esc(o.phone) || '<span class="hint">not provided</span>'}<br>
              <strong>Pickup:</strong> ${esc(o.pickup_location)}<br>
              <strong>Date:</strong> ${esc(o.created_at)}<br>
              <strong>Total:</strong> ${(total / 100).toFixed(2)} EUR</p>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                ${o.email ? `<a class="btn small" href="mailto:${esc(o.email)}?subject=Order%20%23${o.id} - W%20SHOP">Email customer</a>` : ''}
                ${waPhone ? `<a class="btn small" target="_blank" rel="noopener" href="https://wa.me/${esc(waPhone)}?text=${waText}">WhatsApp customer</a>` : ''}
                ${!o.email && !waPhone ? '<span class="hint">No email or phone provided.</span>' : ''}
              </div>
              <p class="hint">WhatsApp/email links open your own apps — messages are sent by you, not automatically.</p>
            </div>
            <div>
              <label class="field"><span>Status</span>
                <select id="order-status">${['new','processing','ready','completed','cancelled'].map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
              </label>
              <label class="field"><span>Admin notes</span><textarea id="order-notes" rows="3">${esc(o.admin_notes)}</textarea></label>
              <button class="btn small" id="order-save" type="button">Save changes</button>
            </div>
          </div>
          <h4>Items</h4>
          ${o.items.map(i => `
            <div class="line-item">
              <div class="info">
                <div class="nm">${esc(i.product_name)} × ${i.qty}</div>
                <div class="sub">${(i.price_cents / 100).toFixed(2)} EUR each</div>
                ${i.drawing_path ? `<div class="sub">Custom drawing: <a href="/api/admin/drawings/${encodeURIComponent(i.drawing_path.split('/').pop())}" target="_blank">view full image</a>
                  <a href="/api/admin/drawings/${encodeURIComponent(i.drawing_path.split('/').pop())}" download="order-${o.id}-item-${i.id}.png"><button class="btn small ghost" type="button">Download</button></a></div>
                  <img src="/api/admin/drawings/${encodeURIComponent(i.drawing_path.split('/').pop())}" style="width:72px;height:72px;border-radius:8px;margin-top:6px">` : ''}
              </div>
              <div style="font-weight:600">${((i.price_cents * i.qty) / 100).toFixed(2)} EUR</div>
            </div>`).join('')}
          <div class="totals">Total: ${(total / 100).toFixed(2)} EUR</div>
        </div>`;
      document.getElementById('order-close').onclick = () => { detail.innerHTML = ''; };
      document.getElementById('order-save').onclick = async () => {
        await api(`/api/admin/orders/${o.id}`, { method: 'PUT', body: { status: document.getElementById('order-status').value, admin_notes: document.getElementById('order-notes').value } });
        renderOrders(); refreshBadge();
      };
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { detail.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  }

  // ---------- QR codes ----------
  async function renderQR() {
    shell('qr', '<div class="empty">Loading…</div>');
    try {
      products = await api('/api/admin/products');
      const s = await api('/api/admin/settings');
      document.getElementById('admin-content').innerHTML = `
        <h2 style="margin-top:0">QR codes</h2>
        <p class="hint">Permanent product links (base: ${esc(s.public_url)}). Print these and place them in your windows. They keep working as long as this site stays online at the same address.</p>
        <div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
          ${products.map(p => `
            <div class="qr-box">
              <img src="/api/admin/qr/${p.id}.svg" alt="QR for ${esc(p.name)}">
              <div style="font-weight:600;margin:8px 0">${esc(p.name)}</div>
              <div class="hint mono" style="word-break:break-all">${esc(location.origin)}/p/${esc(p.slug)}</div>
              <a class="btn small" href="/api/admin/qr/${p.id}.svg" download="wshop-qr-${esc(p.slug)}.svg" type="button" style="margin-top:8px;display:inline-block">Download SVG</a>
            </div>`).join('')}
        </div>`;
    } catch (e) { /* auth */ }
  }

  // ---------- Settings ----------
  async function renderSettings() {
    shell('settings', '<div class="empty">Loading…</div>');
    try {
      const s = await api('/api/admin/settings');
      document.getElementById('admin-content').innerHTML = `
        <h2 style="margin-top:0">Settings</h2>
        <div class="grid-2">
          <div class="panel">
            <h3>Store</h3>
            <label class="field"><span>Store name</span><input type="text" id="set-name" value="${esc(s.store_name)}"></label>
            <label class="field"><span>Public URL (for QR codes)</span><input type="text" id="set-public-url" value="${esc(s.public_url)}" placeholder="https://your-site.com"></label>
            <label class="field" style="grid-column:1/-1"><span>Intro text (homepage welcome message)</span><textarea id="set-intro" rows="3">${esc(s.intro_text)}</textarea></label>
            <button class="btn small" id="set-store" type="button">Save</button>
            <div id="set-store-msg"></div>
            <hr style="border:none;border-top:1px solid var(--line);margin:18px 0">
            <h3>Egg color palette</h3>
            <p class="hint">Colors shown in the drawing editor. Up to 30.</p>
            <div id="palette-list" style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0"></div>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="color" id="palette-new" value="#ff0000" style="width:48px;height:38px;padding:2px">
              <button class="btn small ghost" id="palette-add" type="button">Add color</button>
            </div>
            <button class="btn small" id="palette-save" type="button" style="margin-top:10px">Save palette</button>
            <div id="palette-msg"></div>
          </div>
          <div class="panel">
            <h3>Pickup locations</h3>
            <p class="hint">Your main window is the showcase; other windows are pickup points. One per line.</p>
            <textarea id="set-locations" rows="6">${esc(s.locations.join('\n'))}</textarea>
            <button class="btn small" id="set-loc-save" type="button" style="margin-top:8px">Save locations</button>
            <div id="loc-msg"></div>
            <hr style="border:none;border-top:1px solid var(--line);margin:18px 0">
            <h3>Message templates</h3>
            <p class="hint">Variables: {{order_id}}, {{customer_name}}, {{phone}}, {{total}}. Used for emails when SMTP is configured.</p>
            <label class="field"><span>Order received (customer)</span><textarea id="tpl-received" rows="3">${esc(s.templates.order_received)}</textarea></label>
            <label class="field"><span>New order alert (admin)</span><textarea id="tpl-admin" rows="3">${esc(s.templates.order_admin)}</textarea></label>
            <button class="btn small" id="tpl-save" type="button">Save templates</button>
            <div id="tpl-msg"></div>
          </div>
        </div>
        <div class="grid-2">
          <div class="panel">
            <h3>Email notifications</h3>
            <p class="${s.email_configured ? 'msg ok' : 'msg info'}" style="margin:0">${s.email_configured
              ? 'SMTP is configured — order emails will be sent automatically.'
              : 'Email is NOT configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM and ADMIN_EMAIL environment variables to enable automatic emails (e.g. free Brevo/SMTP2GO tier). Until then, use the Email/WhatsApp buttons in Orders to contact customers yourself.'}</p>
          </div>
          <div class="panel">
            <h3>Change admin password</h3>
            <label class="field"><span>Current password</span><input type="password" id="pw-cur"></label>
            <label class="field"><span>New password (min 8 chars)</span><input type="password" id="pw-new"></label>
            <button class="btn small" id="pw-save" type="button">Change password</button>
            <div id="pw-msg"></div>
          </div>
        </div>`;

      let palette = [...s.palette];
      const palList = document.getElementById('palette-list');
      function renderPalette() {
        palList.innerHTML = palette.map((c, i) => `
          <span style="position:relative;display:inline-block">
            <span style="display:block;width:34px;height:34px;border-radius:8px;background:${esc(c)};border:1px solid var(--line)"></span>
            <button type="button" data-pal-del="${i}" style="position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;border:none;background:var(--danger);color:#fff;font-size:11px;line-height:18px;cursor:pointer">×</button>
          </span>`).join('');
        palList.querySelectorAll('[data-pal-del]').forEach(b => b.onclick = () => { palette.splice(Number(b.dataset.palDel), 1); renderPalette(); });
      }
      renderPalette();

      document.getElementById('palette-add').onclick = () => {
        const c = document.getElementById('palette-new').value;
        if (palette.length < 30 && !palette.includes(c)) { palette.push(c); renderPalette(); }
      };
      document.getElementById('palette-save').onclick = async () => {
        try { await api('/api/admin/settings', { method: 'PUT', body: { palette } }); document.getElementById('palette-msg').innerHTML = '<div class="msg ok">Saved.</div>'; }
        catch (e) { document.getElementById('palette-msg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      };
      document.getElementById('set-store').onclick = async () => {
        try { await api('/api/admin/settings', { method: 'PUT', body: { store_name: document.getElementById('set-name').value, public_url: document.getElementById('set-public-url').value, intro_text: document.getElementById('set-intro').value } }); document.getElementById('set-store-msg').innerHTML = '<div class="msg ok">Saved.</div>'; }
        catch (e) { document.getElementById('set-store-msg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      };
      document.getElementById('set-loc-save').onclick = async () => {
        const locations = document.getElementById('set-locations').value.split('\n').map(s => s.trim()).filter(Boolean);
        try { await api('/api/admin/settings', { method: 'PUT', body: { locations } }); document.getElementById('loc-msg').innerHTML = '<div class="msg ok">Saved.</div>'; }
        catch (e) { document.getElementById('loc-msg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      };
      document.getElementById('tpl-save').onclick = async () => {
        try {
          await api('/api/admin/settings', { method: 'PUT', body: { templates: { order_received: document.getElementById('tpl-received').value, order_admin: document.getElementById('tpl-admin').value } } });
          document.getElementById('tpl-msg').innerHTML = '<div class="msg ok">Saved.</div>';
        } catch (e) { document.getElementById('tpl-msg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      };
      document.getElementById('pw-save').onclick = async () => {
        try {
          await api('/api/admin/password', { method: 'POST', body: { current_password: document.getElementById('pw-cur').value, new_password: document.getElementById('pw-new').value } });
          document.getElementById('pw-msg').innerHTML = '<div class="msg ok">Password changed.</div>';
        } catch (e) { document.getElementById('pw-msg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      };
    } catch (e) { /* auth */ }
  }

  // ---------- Router ----------
  function route() {
    const hash = location.hash.replace(/^#\//, '') || 'dashboard';
    ({ dashboard: renderDashboard, products: renderProducts, orders: renderOrders, qr: renderQR, settings: renderSettings })[hash]?.() ?? renderDashboard();
  }

  async function boot() {
    try { await api('/api/admin/me'); } catch { return showLogin(); }
    route();
  }
  window.addEventListener('hashchange', route);
  boot();
})();
