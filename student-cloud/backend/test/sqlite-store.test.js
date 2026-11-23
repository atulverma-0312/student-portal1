const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');

const temporaryDirectory = fsSync.mkdtempSync(path.join(os.tmpdir(), 'student-sqlite-store-'));
const databasePath = path.join(temporaryDirectory, 'portal.sqlite');
const legacyPath = path.join(temporaryDirectory, 'portal.json');
process.env.SQLITE_DB_PATH = databasePath;
process.env.PORTAL_DB_PATH = legacyPath;
process.env.JSON_DB_PATH = path.join(temporaryDirectory, 'students.json');
const store = require('../sqlite-store');

test('SQLite imports existing portal data and persists transactional portal records', async (t) => {
  const legacyData = {
    students: [{
      _id: '000000000000000000000001',
      roll_no: 'OLD001',
      name: 'Legacy Student',
      email: 'legacy@example.test',
      course: 'BCA',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    }],
    users: [{
      _id: '000000000000000000000002',
      email: 'admin@example.test',
      role: 'admin',
      status: 'active',
      createdAt: '2024-01-01T00:00:00.000Z',
      passwordHash: 'test-hash',
    }],
  };
  await fs.writeFile(legacyPath, JSON.stringify(legacyData));
  t.after(async () => {
    await store.close();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  await store.initialize();
  const importedStudent = await store.collection('students').findOne({ roll_no: 'OLD001' });
  assert.equal(importedStudent.name, 'Legacy Student');
  assert.equal(String(importedStudent._id), '000000000000000000000001');
  assert.equal(await store.collection('users').countDocuments({ role: 'admin' }), 1);

  const application = {
    name: 'New Applicant',
    email: 'new@example.test',
    course: 'BCA',
    passwordHash: 'hashed-test-password',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  const inserted = await store.collection('admissions').insertOne(application);
  const saved = await store.collection('admissions').findOne({ _id: inserted.insertedId });
  assert.equal(saved.email, application.email);
  assert.equal(saved.passwordHash, application.passwordHash);

  const rows = await store.collection('admissions').find({ status: 'pending' }).sort({ createdAt: 1 }).limit(10).toArray();
  assert.equal(rows.length, 1);
  await assert.rejects(store.collection('users').insertOne({
    email: 'orphan@example.test',
    role: 'student',
    status: 'active',
    studentId: new store.ObjectId('000000000000000000000099'),
  }), /FOREIGN KEY constraint failed/);

  const session = store.client.startSession();
  try {
    await assert.rejects(session.withTransaction(async () => {
      await store.collection('students').insertOne({
        roll_no: 'ROLLBACK',
        name: 'Temporary',
        email: 'temporary@example.test',
        course: 'BCA',
        status: 'active',
      }, { session });
      throw new Error('force rollback');
    }), /force rollback/);
  } finally {
    await session.endSession();
  }
  assert.equal(await store.collection('students').countDocuments({ roll_no: 'ROLLBACK' }), 0);

  const connection = new DatabaseSync(databasePath);
  try {
    const row = connection.prepare('SELECT document FROM admissions WHERE email = ?').get(application.email);
    assert.equal(JSON.parse(row.document).status, 'pending');
  } finally {
    connection.close();
  }
});

test('SQLite query builder binds values and rejects unknown filters', () => {
  const id = new store.ObjectId('a0b1c2d3e4f546789012abcd');
  const params = [];
  const where = store.whereClause('users', {
    _id: id,
    status: 'active',
    $or: [{ role: 'admin' }, { role: 'teacher' }],
  }, params);

  assert.match(where, /id = \?/);
  assert.match(where, /OR/);
  assert.deepEqual(params, [id.toString(), 'active', 'admin', 'teacher']);
  assert.throws(() => store.whereClause('users', { arbitrary: 'value' }), /Unsupported users filter field/);
});
