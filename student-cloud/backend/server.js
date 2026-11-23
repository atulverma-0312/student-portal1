require('dotenv').config();

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const store = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 5000);

app.use(helmet());
app.use(express.json({ limit: '100kb' }));
morgan.token('path', (req) => req.path);
app.use(morgan(':method :path :status :response-time ms'));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

/* ---------- helpers ---------- */

const GENDERS = ['male', 'female', 'other'];
const STATUSES = ['active', 'inactive'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Reads the EC2 instance id (IMDSv2). Falls back to hostname outside AWS.
let cachedInstance = null;
async function getInstanceInfo() {
  if (cachedInstance) return cachedInstance;
  const info = { instanceId: 'local', az: 'local', hostname: os.hostname() };
  try {
    const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
      signal: AbortSignal.timeout(800),
    });
    const token = await tokenRes.text();
    const headers = { 'X-aws-ec2-metadata-token': token };
    const get = async (path) =>
      (await fetch(`http://169.254.169.254/latest/meta-data/${path}`, {
        headers,
        signal: AbortSignal.timeout(800),
      })).text();
    info.instanceId = await get('instance-id');
    info.az = await get('placement/availability-zone');
  } catch (_) {
    /* not running on EC2 */
  }
  cachedInstance = info;
  return info;
}

// Validates a student payload. partial=true is used for updates.
function validateStudent(body, partial = false) {
  const errors = [];
  const data = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    body = {};
  }
  const has = (k) => body[k] !== undefined;
  const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());

  if (!partial || has('roll_no')) {
    const v = clean(body.roll_no);
    if (!v) errors.push('Roll number is required');
    else if (v.length > 20) errors.push('Roll number must be 20 characters or less');
    else data.roll_no = v;
  }
  if (!partial || has('name')) {
    const v = clean(body.name);
    if (!v) errors.push('Name is required');
    else if (v.length > 100) errors.push('Name must be 100 characters or less');
    else data.name = v;
  }
  if (!partial || has('email')) {
    const v = clean(body.email);
    if (!v || !EMAIL_RE.test(v)) errors.push('A valid email is required');
    else data.email = v.toLowerCase();
  }
  if (!partial || has('course')) {
    const v = clean(body.course);
    if (!v) errors.push('Course is required');
    else if (v.length > 60) errors.push('Course must be 60 characters or less');
    else data.course = v;
  }
  if (has('phone')) {
    const v = clean(body.phone);
    if (v && !/^[0-9+\-\s]{7,15}$/.test(v)) errors.push('Phone must be 7-15 digits');
    else data.phone = v || null;
  }
  if (has('gender')) {
    if (body.gender === '' || body.gender === null) data.gender = null;
    else if (!GENDERS.includes(body.gender)) errors.push('Gender must be male, female or other');
    else data.gender = body.gender;
  }
  if (has('dob')) {
    if (!body.dob) data.dob = null;
    else if (!isValidDate(body.dob)) errors.push('Date of birth must be a valid date in YYYY-MM-DD format');
    else data.dob = body.dob;
  }
  if (has('semester')) {
    const n = Number(body.semester);
    if (!Number.isInteger(n) || n < 1 || n > 8) errors.push('Semester must be between 1 and 8');
    else data.semester = n;
  }
  if (has('address')) {
    const v = clean(body.address);
    if (v && v.length > 255) errors.push('Address must be 255 characters or less');
    else data.address = v || null;
  }
  if (has('status')) {
    if (!STATUSES.includes(body.status)) errors.push('Status must be active or inactive');
    else data.status = body.status;
  }
  return { errors, data };
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cookieName = 'studentcloud_session';
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const getId = (id) => store.ObjectId && store.ObjectId.isValid(String(id)) ? new store.ObjectId(String(id)) : null;
const sanitizeUser = ({ _id, passwordHash, ...user }) => ({ ...user, id: String(_id) });
const getCookie = (req, name) => {
  const cookies = String(req.headers.cookie || '').split(';');
  const entry = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : '';
};
const setSessionCookie = (res, token) => res.cookie(cookieName, token, {
  httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
  maxAge: sessionDurationMs, path: '/',
});
const clearSessionCookie = (res) => res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });

const requireAuth = asyncHandler(async (req, res, next) => {
  if (!store.supportsPortal) return res.status(503).json({ error: 'The selected database does not support portal authentication.' });
  const token = getCookie(req, cookieName);
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(401).json({ error: 'Sign in required' });
  const session = await store.collection('sessions').findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
  if (!session) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Session expired; please sign in again' });
  }
  const user = await store.collection('users').findOne({ _id: session.userId, status: 'active' });
  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Account is unavailable' });
  }
  req.user = user;
  next();
});
const requirePortalStore = (req, res, next) => {
  if (!store.supportsPortal) return res.status(503).json({ error: 'SQLite is required for portal features.' });
  next();
};
const allowRoles = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission to perform this action' });
  next();
};
const serializeDoc = (doc) => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { ...rest, id: String(_id) };
};
const validationError = (message) => Object.assign(new Error(message), { status: 400, expose: true });

async function createSession(user, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  await store.collection('sessions').insertOne({
    tokenHash: hashToken(token), userId: user._id,
    expiresAt: new Date(now.getTime() + sessionDurationMs), createdAt: now,
  });
  setSessionCookie(res, token);
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/* ---------- health checks (used by the Load Balancer) ---------- */

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get(
  '/health/db',
  asyncHandler(async (req, res) => {
    await store.check();
    res.json({ status: 'ok', database: 'connected' });
  })
);

/* ---------- info: shows which server handled the request ---------- */

app.get(
  '/api/info',
  asyncHandler(async (req, res) => {
    const info = await getInstanceInfo();
    res.json({
      ...info,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      time: new Date().toISOString(),
    });
  })
);

/* ---------- authentication ---------- */

app.get('/api/auth/me', requireAuth, (req, res) => res.json(sanitizeUser(req.user)));

app.post('/api/auth/login', requirePortalStore, asyncHandler(async (req, res) => {
  const email = String(req.body && req.body.email || '').trim().toLowerCase();
  const password = String(req.body && req.body.password || '');
  if (!email || email.length > 120 || !password || password.length > 200) {
    return res.status(400).json({ error: 'Provide a valid email and password' });
  }
  const user = await store.collection('users').findOne({ email });
  if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  await createSession(user, res);
  res.json(sanitizeUser(user));
}));

app.post('/api/auth/logout', asyncHandler(async (req, res) => {
  const token = getCookie(req, cookieName);
  if (token && store.supportsPortal) {
    await store.collection('sessions').deleteOne({ tokenHash: hashToken(token) });
  }
  clearSessionCookie(res);
  res.json({ message: 'Signed out' });
}));

app.post('/api/auth/password', requireAuth, asyncHandler(async (req, res) => {
  const password = String(req.body && req.body.password || '');
  if (password.length < 12 || password.length > 200) return res.status(400).json({ error: 'Password must be 12-200 characters' });
  await store.collection('users').updateOne({ _id: req.user._id }, { $set: { passwordHash: await bcrypt.hash(password, 12), mustChangePassword: false } });
  res.json({ message: 'Password updated' });
}));

/* ---------- student attendance ---------- */

app.get('/api/attendance', requireAuth, asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.date) filter.date = String(req.query.date);
  if (req.user.role === 'student') filter.studentId = req.user.studentId;
  else if (req.query.studentId) {
    filter.studentId = getId(req.query.studentId);
    if (!filter.studentId) throw validationError('Invalid student id');
  }
  const rows = await store.collection('attendance').find(filter).sort({ date: -1 }).limit(500).toArray();
  res.json(rows.map(serializeDoc));
}));

function attendanceInput(body) {
  const studentId = getId(body && body.studentId);
  const date = String(body && body.date || '');
  const status = body && body.status;
  const note = String(body && body.note || '').trim();
  if (!studentId || !isValidDate(date) || !['present', 'absent', 'late'].includes(status)) {
    throw validationError('Valid studentId, date and present/absent/late status are required');
  }
  if (note.length > 255) throw validationError('Attendance note must be 255 characters or less');
  return { studentId, date, status, note };
}

app.post('/api/attendance', requireAuth, allowRoles('admin', 'teacher'), asyncHandler(async (req, res) => {
  const values = attendanceInput(req.body);
  if (!(await store.collection('students').findOne({ _id: values.studentId }))) return res.status(404).json({ error: 'Student not found' });
  const now = new Date().toISOString();
  await store.collection('attendance').updateOne(
    { studentId: values.studentId, date: values.date },
    { $set: { ...values, markedBy: req.user._id, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
  res.status(201).json({ message: 'Attendance saved' });
}));

app.put('/api/attendance/:id', requireAuth, allowRoles('admin', 'teacher'), asyncHandler(async (req, res) => {
  const _id = getId(req.params.id);
  if (!_id) throw validationError('Invalid attendance id');
  const attendance = store.collection('attendance');
  if (!(await attendance.findOne({ _id }))) return res.status(404).json({ error: 'Attendance record not found' });
  const values = attendanceInput(req.body);
  if (!(await store.collection('students').findOne({ _id: values.studentId }))) return res.status(404).json({ error: 'Student not found' });
  await attendance.updateOne(
    { _id },
    { $set: { ...values, markedBy: req.user._id, updatedAt: new Date().toISOString() } }
  );
  res.json({ message: 'Attendance updated' });
}));

app.delete('/api/attendance/:id', requireAuth, allowRoles('admin', 'teacher'), asyncHandler(async (req, res) => {
  const _id = getId(req.params.id);
  if (!_id) throw validationError('Invalid attendance id');
  const result = await store.collection('attendance').deleteOne({ _id });
  if (!result.deletedCount) return res.status(404).json({ error: 'Attendance record not found' });
  res.json({ message: 'Attendance deleted' });
}));

/* ---------- fee management ---------- */

app.get('/api/invoices', requireAuth, asyncHandler(async (req, res) => {
  if (!['admin', 'student'].includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission to view fee invoices' });
  const filter = req.user.role === 'student' ? { studentId: req.user.studentId } : {};
  const invoices = await store.collection('invoices').find(filter).sort({ createdAt: -1 }).limit(500).toArray();
  res.json(invoices.map(serializeDoc));
}));

function invoiceInput(body, partial = false) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const has = (key) => input[key] !== undefined;
  const values = {};
  if (!partial || has('studentId')) {
    values.studentId = getId(input.studentId);
    if (!values.studentId) throw validationError('A valid student is required');
  }
  if (!partial || has('title')) {
    values.title = String(input.title || '').trim();
    if (!values.title || values.title.length > 100) throw validationError('Invoice title must be 1-100 characters');
  }
  if (!partial || has('amountInr')) {
    values.amountInr = Number(input.amountInr);
    if (!Number.isSafeInteger(values.amountInr) || values.amountInr < 1 || values.amountInr > 10000000) {
      throw validationError('Invoice amount must be a whole number from 1 to 10000000 INR');
    }
  }
  if (!partial || has('dueDate')) {
    const dueDate = String(input.dueDate || '');
    if (dueDate && !isValidDate(dueDate)) throw validationError('Due date must be a valid date in YYYY-MM-DD format');
    values.dueDate = dueDate || null;
  }
  if (has('status')) {
    if (!['unpaid', 'paid'].includes(input.status)) throw validationError('Invoice status must be paid or unpaid');
    values.status = input.status;
  }
  return values;
}

app.post('/api/invoices', requireAuth, allowRoles('admin'), asyncHandler(async (req, res) => {
  const values = invoiceInput(req.body);
  if (!(await store.collection('students').findOne({ _id: values.studentId }))) return res.status(404).json({ error: 'Student not found' });
  const invoice = { ...values, currency: 'INR', status: 'unpaid', createdAt: new Date().toISOString(), createdBy: req.user._id };
  const result = await store.collection('invoices').insertOne(invoice);
  res.status(201).json({ ...invoice, id: String(result.insertedId) });
}));

app.patch('/api/invoices/:id', requireAuth, allowRoles('admin'), asyncHandler(async (req, res) => {
  const _id = getId(req.params.id);
  if (!_id) throw validationError('Invalid invoice id');
  const invoices = store.collection('invoices');
  const current = await invoices.findOne({ _id });
  if (!current) return res.status(404).json({ error: 'Invoice not found' });
  const values = invoiceInput(req.body, true);
  if (!Object.keys(values).length) throw validationError('Nothing to update');
  if (values.studentId && !(await store.collection('students').findOne({ _id: values.studentId }))) {
    return res.status(404).json({ error: 'Student not found' });
  }
  const now = new Date().toISOString();
  values.updatedAt = now;
  values.updatedBy = req.user._id;
  const update = { $set: values };
  if (values.status === 'paid' && current.status !== 'paid') values.paidAt = now;
  if (values.status === 'unpaid') update.$unset = { paidAt: '' };
  await invoices.updateOne({ _id }, update);
  res.json({ message: 'Fee record updated' });
}));

app.delete('/api/invoices/:id', requireAuth, allowRoles('admin'), asyncHandler(async (req, res) => {
  const _id = getId(req.params.id);
  if (!_id) throw validationError('Invalid invoice id');
  const invoices = store.collection('invoices');
  const invoice = await invoices.findOne({ _id });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'paid') return res.status(409).json({ error: 'Paid invoices cannot be deleted; keep them for fee history' });
  if (await store.collection('payments').countDocuments({ invoiceId: String(_id) })) {
    return res.status(409).json({ error: 'Invoices with recorded payments cannot be deleted' });
  }
  await invoices.deleteOne({ _id });
  res.json({ message: 'Fee record deleted' });
}));

/* ---------- students CRUD ---------- */

app.get(
  '/api/students/stats',
  requireAuth,
  allowRoles('admin', 'teacher'),
  asyncHandler(async (req, res) => {
    res.json(await store.stats());
  })
);

app.get(
  '/api/students',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role === 'student') {
      const student = req.user.studentId ? await store.get(String(req.user.studentId)) : null;
      return res.json(student ? [student] : []);
    }
    if (!['admin', 'teacher'].includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission to view students' });
    const filters = {
      search: String(req.query.search || '').slice(0, 100),
      course: String(req.query.course || '').slice(0, 60),
      status: STATUSES.includes(req.query.status) ? req.query.status : '',
    };
    res.json(await store.list(filters));
  })
);

app.get(
  '/api/students/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role === 'student' && String(req.user.studentId) !== req.params.id) return res.status(403).json({ error: 'You can only view your own student record' });
    if (!['admin', 'teacher', 'student'].includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission to view students' });
    const student = await store.get(req.params.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    res.json(student);
  })
);

app.post(
  '/api/students',
  requireAuth,
  allowRoles('admin'),
  asyncHandler(async (req, res) => {
    const { errors, data } = validateStudent(req.body);
    if (errors.length) return res.status(400).json({ errors });
    res.status(201).json(await store.create(data));
  })
);

app.put(
  '/api/students/:id',
  requireAuth,
  allowRoles('admin'),
  asyncHandler(async (req, res) => {
    const { errors, data } = validateStudent(req.body, true);
    if (errors.length) return res.status(400).json({ errors });
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update' });
    const student = await store.update(req.params.id, data);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    res.json(student);
  })
);

app.delete(
  '/api/students/:id',
  requireAuth,
  allowRoles('admin'),
  asyncHandler(async (req, res) => {
    const student = await store.get(req.params.id);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (store.supportsPortal) {
      const studentId = getId(req.params.id);
      const [linkedUser, attendanceCount, resultCount, invoiceCount] = await Promise.all([
        store.collection('users').findOne({ studentId }),
        store.collection('attendance').countDocuments({ studentId }),
        store.collection('results').countDocuments({ studentId }),
        store.collection('invoices').countDocuments({ studentId }),
      ]);
      if (linkedUser || attendanceCount || resultCount || invoiceCount) {
        return res.status(409).json({ error: 'Students with linked accounts or attendance, fee, or historical records cannot be deleted; mark the record inactive instead' });
      }
    }
    if (!(await store.remove(req.params.id))) return res.status(404).json({ error: 'Student not found' });
    res.json({ message: 'Student deleted' });
  })
);

/* ---------- errors ---------- */

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((err, req, res, next) => {
  if (err && (err.code === 'ER_DUP_ENTRY' || err.code === 11000)) {
    if (err.code === 11000 && err.keyPattern && err.keyPattern.email) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    if (err.code === 11000 && err.keyPattern && err.keyPattern.roll_no) {
      return res.status(409).json({ error: 'Roll number already exists' });
    }
    if (err.code === 11000 && err.keyPattern && err.keyPattern.studentId) {
      return res.status(409).json({ error: 'An attendance record already exists for this student and date' });
    }
    const field = /roll_no/.test(err.sqlMessage) ? 'Roll number' : /email/.test(err.sqlMessage) ? 'Email' : 'Value';
    return res.status(409).json({ error: `${field} already exists` });
  }
  if (err && err.status >= 400 && err.status < 500) {
    const message = err.status === 413 ? 'Request body too large' : err.expose ? err.message : 'Invalid request';
    return res.status(err.status).json({ error: message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

/* ---------- start ---------- */

(async () => {
  if (process.env.NODE_ENV === 'production' && store.driver !== 'sqlite') {
    throw new Error('Production deployments must use DB_DRIVER=sqlite.');
  }
  if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required to bootstrap the first admin account.');
  }
  await store.initialize();
  if (store.supportsPortal) {
    const email = String(process.env.ADMIN_EMAIL || (['json', 'sqlite'].includes(store.driver) ? 'admin@example.com' : '')).trim().toLowerCase();
    const existingAdmin = email ? await store.collection('users').findOne({ email }) : null;
    if (existingAdmin && existingAdmin.role !== 'admin') {
    throw new Error('ADMIN_EMAIL is already assigned to a non-admin account.');
    }
    if (existingAdmin && process.env.NODE_ENV !== 'production') {
      console.log('Existing admin password is unchanged; to reset it, set ADMIN_PASSWORD in backend/.env and run npm run admin:reset.');
    }
    if (!existingAdmin && email) {
    let password = process.env.ADMIN_PASSWORD;
    let generatedPassword = false;
    if (!password && ['json', 'sqlite'].includes(store.driver)) {
      password = crypto.randomBytes(24).toString('base64url');
      generatedPassword = true;
    }
    if (password && (!EMAIL_RE.test(email) || password.length < 12 || /replace|change.?me/i.test(password))) {
      throw new Error('Set a valid ADMIN_EMAIL and a unique ADMIN_PASSWORD of at least 12 characters.');
    }
    if (password) {
      await store.collection('users').insertOne({
        email,
        name: process.env.ADMIN_NAME || 'System Administrator',
        role: 'admin',
        status: 'active',
        passwordHash: await bcrypt.hash(password, 12),
        mustChangePassword: false,
        createdAt: new Date().toISOString(),
      });
      if (generatedPassword) {
        console.log(`Local development admin created. Email: ${email}; temporary password: ${password}`);
      }
    }
    }
  }
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(PORT, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  console.log(`Student Management app running at http://localhost:${PORT} (${store.driver} database)`);
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received; shutting down`);
      server.close(async (err) => {
        if (err) {
          console.error('HTTP server shutdown failed:', err.message);
          process.exitCode = 1;
        }
        try {
          await store.close();
        } catch (closeError) {
          console.error('Database shutdown failed:', closeError.message);
          process.exitCode = 1;
        }
      });
    });
  }
})().catch((err) => {
  console.error('Application startup failed:', err.message);
  process.exitCode = 1;
});
