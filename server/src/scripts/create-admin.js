// Bootstraps (or resets) an administrator account. Usage:
//   npm run create-admin -- <username> "<Display Name>"
// Prints a temporary password that must be changed at first sign-in.
import { query, pool } from '../db.js';
import { migrate } from '../migrate.js';
import { generateTempPassword, hashPassword } from '../services/auth.js';

const [username, displayName = 'Administrator'] = process.argv.slice(2);
if (!username || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
  console.error('Usage: npm run create-admin -- <username> "<Display Name>"');
  process.exit(1);
}

await migrate();
const password = generateTempPassword();
const hash = await hashPassword(password);
const existing = await query('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
let id;
if (existing.rows[0]) {
  id = existing.rows[0].id;
  await query(
    `UPDATE users SET role = 'admin', password_hash = $2, must_change_password = TRUE, status = 'active',
            removed_at = NULL, can_create_groups = TRUE WHERE id = $1`,
    [id, hash],
  );
  await query('DELETE FROM sessions WHERE user_id = $1', [id]);
} else {
  ({ rows: [{ id }] } = await query(
    `INSERT INTO users (username, display_name, role, password_hash, must_change_password, can_create_groups)
     VALUES ($1, $2, 'admin', $3, TRUE, TRUE) RETURNING id`,
    [username, displayName, hash],
  ));
}
console.log(`\nAdministrator "${username}" (id ${id}) is ready.\nTemporary password: ${password}\nYou will be asked to change it at first sign-in.\n`);
await pool.end();
