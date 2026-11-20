import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core';

export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').default(''),
  priceCents: integer('price_cents').notNull().default(0),
  stock: integer('stock').notNull().default(0),
  available: integer('available').notNull().default(1),
  imagePath: text('image_path').default(''),
  sort: integer('sort').notNull().default(0),
  variant: text('variant').default(''),
  variantPrice2: integer('variant_price2').default(0),
  specialStock: integer('special_stock').default(0),
  drawingEnabled: integer('drawing_enabled').notNull().default(0),
  createdAt: text('created_at').default('NOW()'),
});

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  customerName: text('customer_name').notNull(),
  email: text('email').default(''),
  phone: text('phone').default(''),
  status: text('status').notNull().default('new'),
  adminNotes: text('admin_notes').default(''),
  readAt: text('read_at'),
  createdAt: text('created_at').default('NOW()'),
});

export const orderItems = pgTable('order_items', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').references(() => orders.id).onDeleteCascade(),
  productId: integer('product_id'),
  productName: text('product_name').notNull(),
  priceCents: integer('price_cents').notNull(),
  qty: integer('qty').notNull().default(1),
  drawingPath: text('drawing_path').default(''),
  variant: text('variant').default(''),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const sessions = pgTable('sessions', {
  token: text('token').primaryKey(),
  createdAt: integer('created_at').notNull(),
});
