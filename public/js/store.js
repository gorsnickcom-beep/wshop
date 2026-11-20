// Shared storefront helpers: API, formatting, cart (localStorage).
const WSHOP = (() => {
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const money = cents => `${(cents / 100).toFixed(2)}`;

  const CART_KEY = 'wshop_cart_v2';
  function getCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
    catch { return []; }
  }
  function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateCartBadge();
  }
  function addToCart(item) {
    const cart = getCart();
    const idx = cart.findIndex(c => c.product_id === item.product_id && (c.drawing_id || '') === (item.drawing_id || '') && (c.variant || '') === (item.variant || ''));
    if (idx >= 0) cart[idx].qty += item.qty || 1;
    else cart.push({ product_id: item.product_id, qty: item.qty || 1, drawing_id: item.drawing_id || '', drawing_thumb: item.drawing_thumb || '', variant: item.variant || '' });
    saveCart(cart);
  }
  function setQty(product_id, drawing_id, variant, qty) {
    const cart = getCart().map(c =>
      c.product_id === product_id && (c.drawing_id || '') === (drawing_id || '') && (c.variant || '') === (variant || '') ? { ...c, qty } : c);
    saveCart(cart.filter(c => c.qty > 0));
  }
  function removeItem(product_id, drawing_id, variant) {
    saveCart(getCart().filter(c => !(c.product_id === product_id && (c.drawing_id || '') === (drawing_id || '') && (c.variant || '') === (variant || ''))));
  }
  function clearCart() { saveCart([]); }
  function cartCount() { return getCart().reduce((s, c) => s + c.qty, 0); }

  function updateCartBadge() {
    document.querySelectorAll('.cart-count').forEach(el => {
      const n = cartCount();
      el.textContent = n;
      el.style.display = n ? 'inline-block' : 'none';
    });
  }

  function header(active) {
    const name = document.getElementById('store-name');
    if (name) api('/api/public/settings').then(s => { name.textContent = s.store_name; }).catch(() => {});
    updateCartBadge();
  }

  return { api, money, getCart, addToCart, setQty, removeItem, clearCart, cartCount, header, updateCartBadge };
})();
