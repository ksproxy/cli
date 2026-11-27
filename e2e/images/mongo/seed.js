// The seed of the shop database, which the mongo image runs once with mongosh, as root, when the data folder is new.
// The passwords of the two users are made per run by the service make-secrets. Orders 1 to 60: order N belongs to
// customer N mod 7 (7 when that is 0), has the status open, paid, shipped or cancelled by N mod 4, and the total
// N * 7.25. Order 42 is open. Customers 1 to 7. order_notes starts empty. The driver computes the same values.
const fs = require('fs');

const read = (name) => fs.readFileSync(`/secrets/${name}`, 'utf8').trim();
const shop = db.getSiblingDB('shop');
const STATUSES = ['open', 'paid', 'shipped', 'cancelled'];

const orders = [];
for (let n = 1; n <= 60; n += 1) {
  orders.push({
    _id: n, customer: n % 7 === 0 ? 7 : n % 7, status: n === 42 ? 'open' : STATUSES[n % 4], total: n * 7.25,
  });
}
shop.orders.insertMany(orders);
shop.customers.insertMany([1, 2, 3, 4, 5, 6, 7].map((n) => ({ _id: n, name: `Customer ${n}` })));
shop.createCollection('order_notes');

// "Use a database user with read rights only", and for orders-rw "write rights on these two collections only".
shop.createRole({
  role: 'ordersWriter',
  privileges: [
    { resource: { db: 'shop', collection: 'orders' }, actions: ['find', 'update'] },
    { resource: { db: 'shop', collection: 'order_notes' }, actions: ['find', 'insert'] },
  ],
  roles: [],
});
shop.createUser({ user: 'agent_ro', pwd: read('agent_ro_password'), roles: [{ role: 'read', db: 'shop' }] });
shop.createUser({ user: 'agent_rw', pwd: read('agent_rw_password'), roles: [{ role: 'ordersWriter', db: 'shop' }] });
