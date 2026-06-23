/**
 * Manage user roles by email address.
 *
 * Usage:
 *   npm run set-role <email> <action> <role>
 *
 * Actions:
 *   add     - Add a role to the user
 *   remove  - Remove a role from the user
 *   set     - Replace all roles with the specified role(s)
 *   list    - Show all roles for the user
 *
 * Examples:
 *   npm run set-role user@example.com add admin
 *   npm run set-role user@example.com add project_lead
 *   npm run set-role user@example.com add runner
 *   npm run set-role user@example.com remove runner
 *   npm run set-role user@example.com set admin     # gives admin + all lower roles
 *   npm run set-role user@example.com list
 *
 * Valid roles: user, project_lead, runner, admin
 *
 * Shortcut (backwards compatible):
 *   npm run set-role <email> admin        # same as "set admin"
 *   npm run set-role <email> user         # same as "set user"
 */

import { pool } from '../config/database';

const VALID_ROLES = ['user', 'project_lead', 'runner', 'admin'];
const ADMIN_ROLES = ['user', 'project_lead', 'runner', 'admin']; // admin gets all

async function main() {
  const args = process.argv.slice(2);
  const email = args[0];
  let action = args[1];
  let role = args[2];

  if (!email) {
    printUsage();
    process.exit(1);
  }

  // Backwards compatible: "npm run set-role user@example.com admin"
  if (action && VALID_ROLES.includes(action) && !role) {
    role = action;
    action = 'set';
  }

  if (!action) {
    action = 'list';
  }

  try {
    // Find user
    const check = await pool.query(
      'SELECT pk_user_account, user_email_address, user_role_name FROM user_account WHERE user_email_address = $1 AND is_deleted = false',
      [email]
    );

    if (check.rows.length === 0) {
      console.error(`No user found with email: ${email}`);
      console.log('\nRegistered users:');
      const all = await pool.query(
        `SELECT ua.user_email_address, ua.user_role_name,
                COALESCE(string_agg(ur.role_name, ', ' ORDER BY ur.role_name), 'none') AS roles
         FROM user_account ua
         LEFT JOIN user_role ur ON ur.fk_ur_user = ua.pk_user_account
         WHERE ua.is_deleted = false
         GROUP BY ua.pk_user_account
         ORDER BY ua.created_at`
      );
      all.rows.forEach(u => console.log(`  ${u.user_email_address} [${u.roles}]`));
      process.exit(1);
    }

    const user = check.rows[0];
    const userId = user.pk_user_account;

    // Load current roles
    const rolesRes = await pool.query(
      'SELECT role_name FROM user_role WHERE fk_ur_user = $1 ORDER BY role_name',
      [userId]
    );
    const currentRoles = rolesRes.rows.map((r: { role_name: string }) => r.role_name);

    switch (action) {
      case 'list': {
        console.log(`User: ${email}`);
        console.log(`Primary role: ${user.user_role_name}`);
        console.log(`All roles: ${currentRoles.length > 0 ? currentRoles.join(', ') : 'none'}`);
        break;
      }

      case 'add': {
        if (!role || !VALID_ROLES.includes(role)) {
          console.error(`Invalid role "${role}". Valid: ${VALID_ROLES.join(', ')}`);
          process.exit(1);
        }
        if (currentRoles.includes(role)) {
          console.log(`User ${email} already has role "${role}".`);
          break;
        }
        await pool.query(
          'INSERT INTO user_role (fk_ur_user, role_name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userId, role]
        );
        console.log(`Added role "${role}" to ${email}`);
        console.log(`Roles: ${[...currentRoles, role].sort().join(', ')}`);
        break;
      }

      case 'remove': {
        if (!role || !VALID_ROLES.includes(role)) {
          console.error(`Invalid role "${role}". Valid: ${VALID_ROLES.join(', ')}`);
          process.exit(1);
        }
        await pool.query(
          'DELETE FROM user_role WHERE fk_ur_user = $1 AND role_name = $2',
          [userId, role]
        );
        console.log(`Removed role "${role}" from ${email}`);
        const remaining = currentRoles.filter((r: string) => r !== role);
        console.log(`Roles: ${remaining.length > 0 ? remaining.join(', ') : 'none'}`);
        break;
      }

      case 'set': {
        if (!role || !VALID_ROLES.includes(role)) {
          console.error(`Invalid role "${role}". Valid: ${VALID_ROLES.join(', ')}`);
          process.exit(1);
        }
        // Determine which roles to assign
        // Each role includes all lower roles for additive access
        const ROLE_BUNDLES: Record<string, string[]> = {
          user: ['user'],
          runner: ['user', 'runner'],
          project_lead: ['user', 'runner', 'project_lead'],
          admin: ['user', 'runner', 'project_lead', 'admin'],
        };
        const rolesToSet = ROLE_BUNDLES[role] || [role, 'user'];

        // Clear existing and insert new
        await pool.query('DELETE FROM user_role WHERE fk_ur_user = $1', [userId]);
        for (const r of rolesToSet) {
          await pool.query(
            'INSERT INTO user_role (fk_ur_user, role_name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [userId, r]
          );
        }

        // Update primary role in user_account
        const primaryRole = role === 'admin' ? 'admin' : role;
        await pool.query(
          'UPDATE user_account SET user_role_name = $1 WHERE pk_user_account = $2',
          [primaryRole, userId]
        );

        console.log(`Set ${email} to: ${rolesToSet.join(', ')}`);
        console.log(`Primary role: ${primaryRole}`);
        break;
      }

      default:
        console.error(`Unknown action "${action}". Use: add, remove, set, list`);
        process.exit(1);
    }

    console.log('\nNote: User must log out and back in for role changes to take effect.');
  } catch (err) {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

function printUsage() {
  console.log('Usage: npm run set-role <email> [action] [role]');
  console.log('');
  console.log('Actions:');
  console.log('  add <role>     Add a role');
  console.log('  remove <role>  Remove a role');
  console.log('  set <role>     Replace all roles (admin gets all roles)');
  console.log('  list           Show current roles');
  console.log('');
  console.log('Roles: user, project_lead, runner, admin');
  console.log('');
  console.log('Shortcut: npm run set-role user@example.com admin');
}

main();
