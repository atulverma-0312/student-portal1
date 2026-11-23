const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const backendDirectory = path.join(__dirname, '..');

async function createDatabase(directory, { email, role = 'admin', status = 'active' }) {
  const databasePath = path.join(directory, 'portal.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(await fs.readFile(path.join(backendDirectory, 'sqlite-schema.sql'), 'utf8'));
  const document = { email, role, status, passwordHash: await bcrypt.hash('Old-password-1234', 4) };
  database.prepare(
    'INSERT INTO users (id, email, role, status, document, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('000000000000000000000001', email, role, status, JSON.stringify(document), new Date().toISOString());
  database.close();
  return databasePath;
}

function runReset(databasePath, email, password) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['reset-admin-password.js'], {
      cwd: backendDirectory,
      env: {
        ...process.env,
        DB_DRIVER: 'sqlite',
        SQLITE_DB_PATH: databasePath,
        PORTAL_DB_PATH: path.join(path.dirname(databasePath), 'missing-portal.json'),
        JSON_DB_PATH: path.join(path.dirname(databasePath), 'missing-students.json'),
        ADMIN_EMAIL: email,
        ADMIN_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

test('admin reset updates only the existing active admin and never prints the password', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'student-admin-reset-'));
  const email = 'admin@example.test';
  const password = 'New-admin-password-2026';
  const databasePath = await createDatabase(directory, { email });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const result = await runReset(databasePath, email, password);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Admin password reset for admin@example\.test/);
  assert.equal(result.output.includes(password), false);

  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare('SELECT document FROM users WHERE email = ?').get(email);
    const user = JSON.parse(row.document);
    assert.equal(await bcrypt.compare(password, user.passwordHash), true);
    assert.equal(user.mustChangePassword, false);
  } finally {
    database.close();
  }
});

test('admin reset fails closed for non-admin accounts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'student-admin-reset-'));
  const email = 'teacher@example.test';
  const databasePath = await createDatabase(directory, { email, role: 'teacher' });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const result = await runReset(databasePath, email, 'New-teacher-password-2026');
  assert.equal(result.code, 1);
  assert.match(result.output, /No admin account exists/);
});
