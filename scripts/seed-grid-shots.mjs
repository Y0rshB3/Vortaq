/* global process, console, Buffer, URL */
/**
 * Seeds a scratch profile and the throwaway test MySQL for the grid editor
 * screenshots (steps 51* of src/main/screenshots.ts): «Elegir de <tabla>» on a
 * foreign key and the list of an ENUM column; and the `shots_diagram` database
 * of the relationship diagram and visual query (steps 52*), with a few customers and
 * orders for the editable JOIN results (steps 53*). Synthetic names only.
 *
 *   node scripts/seed-grid-shots.mjs
 *   npm run build
 *   VORTAQ_USER_DATA=$TMPDIR/vortaq-grid-shots/profile VORTAQ_PLAIN_SECRETS=1 \
 *   VORTAQ_SCREENSHOTS=$TMPDIR/vortaq-grid-shots VORTAQ_SHOTS_ONLY=51 npx electron .
 *
 * Env: VORTAQ_SHOTS_GRID_PROFILE (scratch profile, wiped; must end in /profile),
 * VORTAQ_SHOTS_MYSQL (default: the test container on 33306, never 3306/3307).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import mysql from 'mysql2/promise'

const PROFILE = resolve(
  process.env.VORTAQ_SHOTS_GRID_PROFILE ||
    join(process.env.TMPDIR || '/tmp', 'vortaq-grid-shots', 'profile')
)
if (basename(PROFILE) !== 'profile') {
  console.error(
    `Refusing to wipe ${PROFILE}: the scratch profile directory must be named "profile".`
  )
  process.exit(1)
}
const url = new URL(
  process.env.VORTAQ_SHOTS_MYSQL || 'mysql://root:navidog@127.0.0.1:33306/navidog_test'
)
const DB = {
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, '') || 'navidog_test'
}
if ([3306, 3307].includes(DB.port)) {
  console.error('Refusing to seed MySQL on 3306/3307: use the throwaway test container.')
  process.exit(1)
}

const conn = await mysql.createConnection({ ...DB, multipleStatements: true })
await conn.query(`
  DROP TABLE IF EXISTS shot_grid_members;
  DROP TABLE IF EXISTS shot_grid_persons;
  CREATE TABLE shot_grid_persons (
    personID VARCHAR(22) PRIMARY KEY,
    name VARCHAR(60) NOT NULL,
    email VARCHAR(80) NOT NULL,
    created DATETIME NOT NULL
  );
  CREATE TABLE shot_grid_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    status ENUM('Active','Archived','Suspended') NOT NULL DEFAULT 'Active',
    personID VARCHAR(22) NULL,
    joined DATETIME NOT NULL,
    CONSTRAINT fk_shot_grid_person FOREIGN KEY (personID) REFERENCES shot_grid_persons (personID)
  );
`)
const names = [
  'Ana Pérez',
  'Luis Gómez',
  'Eva Martín',
  'Raúl Ortega',
  'Sara Molina',
  'Iván Ruiz',
  'Nora Vidal',
  'Hugo Serrano'
]
const persons = names.map((name, i) => [
  `c-${(1000 + i * 37).toString(36)}${'XyZ'.repeat(5)}`.slice(0, 22),
  name,
  `${name
    .split(' ')[0]
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()}@example.com`,
  `2025-0${(i % 9) + 1}-1${i % 9} 09:${10 + i}:00`
])
await conn.query('INSERT INTO shot_grid_persons VALUES ?', [persons])
const statuses = ['Active', 'Active', 'Archived', 'Active', 'Suspended', 'Active']
await conn.query('INSERT INTO shot_grid_members (status, personID, joined) VALUES ?', [
  statuses.map((s, i) => [s, persons[i % persons.length][0], `2026-0${i + 1}-0${i + 1} 10:00:00`])
])
// Relationship diagram and visual query (steps 52*): a small shop in its own database.
await conn.query(`
  CREATE DATABASE IF NOT EXISTS shots_diagram;
  USE shots_diagram;
  DROP TABLE IF EXISTS payments, order_items, orders, products, categories, coupons, customers, audit_log;
  CREATE TABLE customers (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL, email VARCHAR(120) NOT NULL,
    country CHAR(2) NOT NULL, created_at DATETIME NOT NULL
  );
  CREATE TABLE categories (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL, parent_id INT NULL,
    FOREIGN KEY (parent_id) REFERENCES categories (id)
  );
  CREATE TABLE products (
    id INT AUTO_INCREMENT PRIMARY KEY, sku VARCHAR(20) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL,
    price DECIMAL(10,2) NOT NULL, category_id INT NOT NULL,
    FOREIGN KEY (category_id) REFERENCES categories (id)
  );
  CREATE TABLE coupons (code VARCHAR(20) PRIMARY KEY, discount DECIMAL(5,2) NOT NULL, expires_at DATE NULL);
  CREATE TABLE orders (
    id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT NOT NULL, coupon_code VARCHAR(20) NULL,
    status ENUM('pending','paid','shipped','cancelled') NOT NULL DEFAULT 'pending',
    created_at DATETIME NOT NULL, total DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers (id),
    FOREIGN KEY (coupon_code) REFERENCES coupons (code)
  );
  CREATE TABLE order_items (
    order_id INT NOT NULL, product_id INT NOT NULL, quantity INT NOT NULL, unit_price DECIMAL(10,2) NOT NULL,
    PRIMARY KEY (order_id, product_id),
    FOREIGN KEY (order_id) REFERENCES orders (id),
    FOREIGN KEY (product_id) REFERENCES products (id)
  );
  CREATE TABLE payments (
    id INT AUTO_INCREMENT PRIMARY KEY, order_id INT NOT NULL, method ENUM('card','transfer') NOT NULL,
    amount DECIMAL(10,2) NOT NULL, paid_at DATETIME NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );
  CREATE TABLE audit_log (id BIGINT AUTO_INCREMENT PRIMARY KEY, action VARCHAR(40) NOT NULL, at DATETIME NOT NULL);
`)
// Editable JOIN results (steps 53*): a few customers and their orders.
const countries = ['ES', 'MX', 'ES', 'AR', 'MX', 'CO']
await conn.query('INSERT INTO customers (name, email, country, created_at) VALUES ?', [
  countries.map((country, i) => [names[i], persons[i][2], country, `2025-0${i + 1}-15 10:00:00`])
])
const orderRows = [
  [1, 'paid', '84.50'],
  [2, 'pending', '120.00'],
  [1, 'shipped', '39.90'],
  [3, 'paid', '215.75'],
  [5, 'cancelled', '18.00'],
  [4, 'paid', '64.20'],
  [6, 'pending', '99.99'],
  [2, 'paid', '45.10']
]
await conn.query('INSERT INTO orders (customer_id, status, created_at, total) VALUES ?', [
  orderRows.map(([customer, status, total], i) => [
    customer,
    status,
    `2026-0${(i % 9) + 1}-1${i % 9} 1${i % 9}:30:00`,
    total
  ])
])
await conn.end()

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })
const iso = new Date().toISOString()
const connection = {
  id: 'shot-grid-mysql',
  name: 'Local MySQL',
  color: '#69f0ae',
  environment: 'local',
  engine: 'mysql',
  host: DB.host,
  port: DB.port,
  username: DB.user,
  authMode: 'password',
  savePassword: true,
  customDatabases: [DB.database, 'shots_diagram'],
  initialQueries: '',
  ssh: {
    enabled: false,
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    savePassword: false
  },
  ssl: { enabled: false, verifyServer: true },
  backupDir: '',
  extraBackupDirs: [],
  createdAt: iso,
  updatedAt: iso
}
const write = (name, data) =>
  writeFileSync(join(PROFILE, name), JSON.stringify(data, null, 2), { mode: 0o600 })
write('connections.json', { version: 1, items: [connection] })
write('credentials.json', {
  version: 1,
  codec: 'plain',
  items: { [`mysql:${connection.id}`]: Buffer.from(DB.password, 'utf8').toString('base64') }
})
write('settings.json', { theme: 'dark', checkUpdatesOnStartup: false })
console.log(`Seeded ${PROFILE} and ${DB.database}.shot_grid_* on ${DB.host}:${DB.port}`)
