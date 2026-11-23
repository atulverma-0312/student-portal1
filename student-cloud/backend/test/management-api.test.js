const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');

async function findAvailablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForReady(child, url, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before becoming ready:\n${output.join('')}`);
    try {
      const response = await fetch(`${url}/health/db`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready:\n${output.join('')}`);
}

test('admin can perform student, attendance, and fee CRUD in SQLite', async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'student-management-api-'));
  const databasePath = path.join(temporaryDirectory, 'portal.sqlite');
  const port = await findAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  const backendDirectory = path.join(__dirname, '..');
  const adminPassword = crypto.randomBytes(24).toString('base64url');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DB_DRIVER: 'sqlite',
      PORT: String(port),
      SQLITE_DB_PATH: databasePath,
      PORTAL_DB_PATH: path.join(temporaryDirectory, 'missing-portal.json'),
      JSON_DB_PATH: path.join(temporaryDirectory, 'missing-students.json'),
      ADMIN_EMAIL: 'management-test@example.test',
      ADMIN_PASSWORD: adminPassword,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  await waitForReady(child, url, output);
  const call = (route, { method = 'GET', body, cookie } = {}) => fetch(`${url}/api${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  assert.equal((await call('/students')).status, 401);
  const login = await call('/auth/login', {
    method: 'POST',
    body: { email: 'management-test@example.test', password: adminPassword },
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(cookie, /^studentcloud_session=/);

  assert.equal((await call('/auth/me', { cookie })).status, 200);
  assert.equal((await call('/admissions', { cookie })).status, 404);
  assert.equal((await call('/exams', { cookie })).status, 404);

  const studentResponse = await call('/students', {
    method: 'POST',
    cookie,
    body: {
      roll_no: 'MGT001',
      name: 'Management Test',
      email: 'management-student@example.test',
      course: 'BCA',
      semester: 1,
      status: 'active',
    },
  });
  assert.equal(studentResponse.status, 201);
  const student = await studentResponse.json();
  assert.equal(student.name, 'Management Test');

  const updatedStudentResponse = await call(`/students/${student.id}`, {
    method: 'PUT',
    cookie,
    body: { name: 'Updated Student', course: 'MCA' },
  });
  assert.equal(updatedStudentResponse.status, 200);
  const updatedStudent = await updatedStudentResponse.json();
  assert.equal(updatedStudent.name, 'Updated Student');
  assert.equal(updatedStudent.course, 'MCA');

  const attendanceResponse = await call('/attendance', {
    method: 'POST',
    cookie,
    body: { studentId: student.id, date: '2026-11-17', status: 'present', note: 'On time' },
  });
  assert.equal(attendanceResponse.status, 201);
  let attendance = await call('/attendance', { cookie }).then((response) => response.json());
  assert.equal(attendance.length, 1);
  assert.equal(attendance[0].status, 'present');
  const attendanceId = attendance[0].id;

  const updatedAttendance = await call(`/attendance/${attendanceId}`, {
    method: 'PUT',
    cookie,
    body: { studentId: student.id, date: '2026-11-17', status: 'late', note: 'Updated note' },
  });
  assert.equal(updatedAttendance.status, 200);
  attendance = await call('/attendance', { cookie }).then((response) => response.json());
  assert.equal(attendance[0].status, 'late');
  assert.equal(attendance[0].note, 'Updated note');

  assert.equal((await call(`/attendance/${attendanceId}`, { method: 'DELETE', cookie })).status, 200);
  assert.deepEqual(await call('/attendance', { cookie }).then((response) => response.json()), []);

  const invoiceResponse = await call('/invoices', {
    method: 'POST',
    cookie,
    body: { studentId: student.id, title: 'Tuition fee', amountInr: 12000, dueDate: '2026-12-01' },
  });
  assert.equal(invoiceResponse.status, 201);
  const invoice = await invoiceResponse.json();

  assert.equal((await call(`/invoices/${invoice.id}`, {
    method: 'PATCH',
    cookie,
    body: { status: 'paid', amountInr: 12500 },
  })).status, 200);
  assert.equal((await call(`/invoices/${invoice.id}`, { method: 'DELETE', cookie })).status, 409);

  const feeRows = await call('/invoices', { cookie }).then((response) => response.json());
  assert.equal(feeRows.length, 1);
  assert.equal(feeRows[0].status, 'paid');
  assert.equal(feeRows[0].amountInr, 12500);

  assert.equal((await call(`/invoices/${invoice.id}`, {
    method: 'PATCH',
    cookie,
    body: { status: 'unpaid', title: 'Revised tuition fee' },
  })).status, 200);
  assert.equal((await call(`/invoices/${invoice.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.deepEqual(await call('/invoices', { cookie }).then((response) => response.json()), []);

  assert.equal((await call(`/students/${student.id}`, { method: 'DELETE', cookie })).status, 200);
  assert.deepEqual(await call('/students', { cookie }).then((response) => response.json()), []);
});
