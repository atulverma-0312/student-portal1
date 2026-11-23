const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.env.SQLITE_DB_PATH || path.join(__dirname, 'data', 'portal.sqlite');
if (databasePath !== ':memory:') {
  require('fs').mkdirSync(path.dirname(databasePath), { recursive: true });
}

const databaseConnection = new DatabaseSync(databasePath);
databaseConnection.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
databaseConnection.function('REGEXP', (pattern, value) => {
  if (value === null || value === undefined) return 0;
  return new RegExp(String(pattern), 'i').test(String(value)) ? 1 : 0;
});

const definitions = {
  students: {
    table: 'students',
    fields: ['roll_no', 'email', 'name', 'course', 'status', 'created_at', 'updated_at'],
    columns: { roll_no: 'roll_no', email: 'email', course: 'course', status: 'status', created_at: 'created_at', updated_at: 'updated_at' },
  },
  users: {
    table: 'users',
    fields: ['email', 'role', 'status', 'studentId', 'createdAt'],
    columns: { email: 'email', role: 'role', status: 'status', studentId: 'student_id', createdAt: 'created_at' },
  },
  admissions: {
    table: 'admissions',
    fields: ['email', 'status', 'createdAt', 'reviewedBy'],
    columns: { email: 'email', status: 'status', createdAt: 'created_at', reviewedBy: 'reviewed_by' },
  },
  attendance: {
    table: 'attendance',
    fields: ['studentId', 'date', 'status'],
    columns: { studentId: 'student_id', date: 'attendance_date', status: 'status' },
  },
  exams: {
    table: 'exams',
    fields: ['name', 'course', 'date', 'maxMarks', 'createdAt'],
    columns: { name: 'name', course: 'course', date: 'exam_date', maxMarks: 'max_marks', createdAt: 'created_at' },
  },
  results: {
    table: 'results',
    fields: ['studentId', 'examId', 'marks', 'maxMarks', 'grade', 'createdAt'],
    columns: { studentId: 'student_id', examId: 'exam_id', marks: 'marks', maxMarks: 'max_marks', grade: 'grade', createdAt: 'created_at' },
  },
  invoices: {
    table: 'invoices',
    fields: ['studentId', 'title', 'amountInr', 'currency', 'dueDate', 'status', 'createdAt'],
    columns: { studentId: 'student_id', title: 'title', amountInr: 'amount_inr', currency: 'currency', dueDate: 'due_date', status: 'status', createdAt: 'created_at' },
  },
  payments: {
    table: 'payments',
    fields: ['eventId', 'invoiceId', 'paidAt'],
    columns: { eventId: 'event_id', invoiceId: 'invoice_id', paidAt: 'paid_at' },
  },
  sessions: {
    table: 'sessions',
    fields: ['tokenHash', 'userId', 'expiresAt', 'createdAt'],
    columns: { tokenHash: 'token_hash', userId: 'user_id', expiresAt: 'expires_at', createdAt: 'created_at' },
  },
};

const collectionNames = Object.keys(definitions);
let initialized = false;
let lockTail = Promise.resolve();

class SQLiteObjectId {
  constructor(value = crypto.randomBytes(12).toString('hex')) {
    if (!SQLiteObjectId.isValid(value)) throw new TypeError('Invalid database ID');
    this.value = String(value).toLowerCase();
  }

  static isValid(value) {
    return /^[a-f\d]{24}$/i.test(String(value)) ||
      /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(String(value));
  }

  toString() {
    return this.value;
  }

  toJSON() {
    return this.value;
  }
}

function normalize(value) {
  if (value instanceof SQLiteObjectId) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function sqlError(error) {
  if (error && /UNIQUE constraint failed:/i.test(error.message || '')) {
    const message = error.message || '';
    const fields = [
      [/students\.roll_no/, 'roll_no'],
      [/students\.email|users\.email|admissions\.email/, 'email'],
      [/attendance\.student_id/, 'studentId'],
      [/results\.student_id/, 'studentId'],
      [/sessions\.token_hash/, 'tokenHash'],
      [/payments\.event_id/, 'eventId'],
    ];
    const field = (fields.find(([pattern]) => pattern.test(message)) || [null, 'value'])[1];
    const duplicate = new Error(`Duplicate ${field}`);
    duplicate.code = 11000;
    duplicate.keyPattern = { [field]: 1 };
    return duplicate;
  }
  return error;
}

async function acquireLock() {
  let release;
  const previous = lockTail;
  lockTail = new Promise((resolve) => { release = resolve; });
  await previous;
  return release;
}

async function withDatabase(session, operation) {
  if (session && session.active) {
    try {
      return operation();
    } catch (error) {
      throw sqlError(error);
    }
  }
  const release = await acquireLock();
  try {
    return operation();
  } catch (error) {
    throw sqlError(error);
  } finally {
    release();
  }
}

function expressionFor(name, field) {
  const definition = definitions[name];
  if (field === '_id' || field === 'id') return 'id';
  if (!definition.fields.includes(field)) throw new Error(`Unsupported ${name} filter field "${field}".`);
  return `json_extract(document, '$."${field}"')`;
}

function whereClause(name, filter = {}, params = []) {
  const clauses = [];
  for (const [field, condition] of Object.entries(filter)) {
    if (field === '$or' || field === '$and') {
      if (!Array.isArray(condition) || !condition.length) {
        clauses.push(field === '$or' ? 'FALSE' : 'TRUE');
        continue;
      }
      const nested = condition.map((part) => `(${whereClause(name, part, params)})`);
      clauses.push(`(${nested.join(field === '$or' ? ' OR ' : ' AND ')})`);
      continue;
    }

    const expression = expressionFor(name, field);
    const append = (value) => {
      params.push(normalize(value));
      return '?';
    };

    if (condition && typeof condition === 'object' && !(condition instanceof Date) && !(condition instanceof SQLiteObjectId)) {
      if ('$regex' in condition) {
        clauses.push(`${expression} REGEXP ${append(String(condition.$regex))}`);
      } else {
        for (const [operator, value] of Object.entries(condition)) {
          if (operator === '$gt' || operator === '$gte' || operator === '$lt' || operator === '$lte') {
            const sqlOperator = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[operator];
            clauses.push(`${expression} ${sqlOperator} ${append(value)}`);
          } else if (operator === '$ne') {
            clauses.push(`${expression} IS NOT ${append(value)}`);
          } else if (operator === '$in') {
            if (!Array.isArray(value)) throw new Error('$in filters require an array.');
            if (!value.length) clauses.push('FALSE');
            else clauses.push(`${expression} IN (${value.map(append).join(', ')})`);
          } else if (operator === '$exists') {
            params.push(`$."${field}"`);
            clauses.push(`json_type(document, ?) IS ${value ? 'NOT ' : ''}NULL`);
          } else {
            throw new Error(`Unsupported filter operator "${operator}".`);
          }
        }
      }
    } else if (field === '_id' || field === 'id') {
      clauses.push(`id = ${append(condition)}`);
    } else if (condition === null || condition === undefined) {
      clauses.push(`${expression} IS NULL`);
    } else {
      clauses.push(`${expression} = ${append(condition)}`);
    }
  }
  return clauses.join(' AND ') || 'TRUE';
}

function project(document, projection) {
  if (!projection) return document;
  const included = Object.keys(projection).filter((key) => projection[key] === 1);
  if (included.length) {
    const result = {};
    for (const key of included) if (document[key] !== undefined) result[key] = document[key];
    if (projection._id !== 0) result._id = document._id;
    return result;
  }
  const result = { ...document };
  for (const [key, value] of Object.entries(projection)) if (value === 0) delete result[key];
  return result;
}

function rowToDocument(row) {
  return row ? { ...JSON.parse(row.document), _id: new SQLiteObjectId(row.id) } : null;
}

function applyUpdate(document, update, inserting = false) {
  const result = { ...document };
  if (inserting && update.$setOnInsert) Object.assign(result, normalize(update.$setOnInsert));
  if (update.$set) Object.assign(result, normalize(update.$set));
  if (update.$unset) for (const field of Object.keys(update.$unset)) delete result[field];
  return result;
}

function baseDocument(filter) {
  const document = {};
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith('$') && (!value || typeof value !== 'object' || value instanceof SQLiteObjectId || value instanceof Date)) {
      document[key] = normalize(value);
    }
  }
  return document;
}

function columnEntries(name, document) {
  return Object.entries(definitions[name].columns)
    .filter(([field]) => document[field] !== undefined)
    .map(([field, column]) => [field, column, normalize(document[field])]);
}

function findOneSync(name, filter = {}, projection) {
  const params = [];
  const where = whereClause(name, filter, params);
  const row = databaseConnection.prepare(
    `SELECT id, document FROM ${definitions[name].table} WHERE ${where} LIMIT 1`
  ).get(...params);
  const document = rowToDocument(row);
  return document ? project(document, projection) : null;
}

function insertDocumentSync(name, source) {
  const document = normalize(source);
  const id = document._id ? new SQLiteObjectId(document._id) : new SQLiteObjectId();
  delete document._id;
  const entries = columnEntries(name, document);
  const fields = ['id', 'document', ...entries.map(([, column]) => column)];
  const values = [id.toString(), JSON.stringify(document), ...entries.map(([, , value]) => value)];
  databaseConnection.prepare(
    `INSERT INTO ${definitions[name].table} (${fields.join(', ')}) VALUES (${values.map(() => '?').join(', ')})`
  ).run(...values);
  return id;
}

function updateDocumentSync(name, id, document, unsetFields = []) {
  const entries = Object.entries(definitions[name].columns)
    .filter(([field]) => document[field] !== undefined || unsetFields.includes(field));
  const assignments = ['document = ?', ...entries.map(([, column]) => `${column} = ?`)];
  const values = [
    JSON.stringify(document),
    ...entries.map(([field]) => document[field] === undefined ? null : normalize(document[field])),
    String(id),
  ];
  return databaseConnection.prepare(
    `UPDATE ${definitions[name].table} SET ${assignments.join(', ')} WHERE id = ?`
  ).run(...values).changes > 0;
}

class SQLiteCursor {
  constructor(name, filter = {}, options = {}) {
    this.name = name;
    this.filter = filter;
    this.options = options;
    this.sortOrder = {};
    this.maxResults = 0;
  }

  sort(order = {}) {
    this.sortOrder = order;
    return this;
  }

  limit(count) {
    this.maxResults = Math.max(0, Math.trunc(Number(count) || 0));
    return this;
  }

  async toArray() {
    return withDatabase(this.options.session, () => {
      const params = [];
      const where = whereClause(this.name, this.filter, params);
      const order = Object.entries(this.sortOrder).map(([field, direction]) => {
        if (direction !== 1 && direction !== -1) throw new Error('Sort direction must be 1 or -1.');
        return `${expressionFor(this.name, field)} ${direction === -1 ? 'DESC' : 'ASC'}`;
      });
      const orderBy = order.length ? ` ORDER BY ${order.join(', ')}` : '';
      let limit = '';
      if (this.maxResults > 0) {
        params.push(this.maxResults);
        limit = ' LIMIT ?';
      }
      const rows = databaseConnection.prepare(
        `SELECT id, document FROM ${definitions[this.name].table} WHERE ${where}${orderBy}${limit}`
      ).all(...params);
      return rows.map(rowToDocument).map((document) => project(document, this.options.projection));
    });
  }
}

class SQLiteSession {
  constructor() {
    this.active = false;
  }

  async withTransaction(callback) {
    if (this.active) throw new Error('A SQLite transaction is already active for this session.');
    const release = await acquireLock();
    try {
      databaseConnection.exec('BEGIN IMMEDIATE');
      this.active = true;
      const result = await callback();
      databaseConnection.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.active) {
        try {
          databaseConnection.exec('ROLLBACK');
        } catch (rollbackError) {
          error.rollbackError = rollbackError.message;
        }
      }
      throw sqlError(error);
    } finally {
      this.active = false;
      release();
    }
  }

  async endSession() {}
}

function collection(name) {
  if (!definitions[name]) throw new Error(`Unknown SQLite collection "${name}".`);
  return {
    async createIndex(fields) {
      return Object.keys(fields).join('_');
    },

    find(filter = {}, options = {}) {
      return new SQLiteCursor(name, filter, options);
    },

    async findOne(filter = {}, options = {}) {
      return withDatabase(options.session, () => findOneSync(name, filter, options.projection));
    },

    async countDocuments(filter = {}, options = {}) {
      return withDatabase(options.session, () => {
        const params = [];
        const where = whereClause(name, filter, params);
        return databaseConnection.prepare(
          `SELECT COUNT(*) AS count FROM ${definitions[name].table} WHERE ${where}`
        ).get(...params).count;
      });
    },

    async insertOne(source, options = {}) {
      return withDatabase(options.session, () => ({
        acknowledged: true,
        insertedId: insertDocumentSync(name, source),
      }));
    },

    async updateOne(filter, update, options = {}) {
      return withDatabase(options.session, () => {
        const current = findOneSync(name, filter);
        if (current) {
          const updated = applyUpdate(current, update);
          const matched = updateDocumentSync(name, current._id, updated, Object.keys(update.$unset || {}));
          return { acknowledged: true, matchedCount: matched ? 1 : 0, modifiedCount: matched ? 1 : 0, upsertedCount: 0 };
        }
        if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        const insertedId = insertDocumentSync(name, applyUpdate(baseDocument(filter), update, true));
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: insertedId };
      });
    },

    async findOneAndUpdate(filter, update, options = {}) {
      return withDatabase(options.session, () => {
        const current = findOneSync(name, filter);
        if (!current) return null;
        const updated = applyUpdate(current, update);
        if (!updateDocumentSync(name, current._id, updated, Object.keys(update.$unset || {}))) return null;
        return options.returnDocument === 'before' ? current : updated;
      });
    },

    async deleteOne(filter, options = {}) {
      return withDatabase(options.session, () => {
        const params = [];
        const where = whereClause(name, filter, params);
        const result = databaseConnection.prepare(
          `DELETE FROM ${definitions[name].table} WHERE id IN (SELECT id FROM ${definitions[name].table} WHERE ${where} LIMIT 1)`
        ).run(...params);
        return { acknowledged: true, deletedCount: result.changes };
      });
    },

    aggregate(pipeline = []) {
      return {
        toArray: async () => {
          let records = await new SQLiteCursor(name).toArray();
          for (const stage of pipeline) {
            if (stage.$group) {
              const { _id: idExpression, ...accumulators } = stage.$group;
              const groups = new Map();
              for (const record of records) {
                const field = typeof idExpression === 'string' && idExpression.startsWith('$') ? idExpression.slice(1) : null;
                const id = field ? record[field] : null;
                const key = String(id);
                if (!groups.has(key)) {
                  groups.set(key, { _id: id });
                  for (const [keyName, expression] of Object.entries(accumulators)) {
                    if (expression.$sum !== undefined) groups.get(key)[keyName] = 0;
                  }
                }
                for (const [keyName, expression] of Object.entries(accumulators)) {
                  if (expression.$sum !== undefined) groups.get(key)[keyName] += Number(expression.$sum) || 0;
                }
              }
              records = [...groups.values()];
            } else if (stage.$sort) {
              const order = Object.entries(stage.$sort);
              records.sort((left, right) => {
                for (const [field, direction] of order) {
                  const result = String(left[field] ?? '').localeCompare(String(right[field] ?? ''), undefined, { numeric: true });
                  if (result) return result * direction;
                }
                return 0;
              });
            } else if (stage.$project) {
              records = records.map((record) => {
                const projected = {};
                for (const [key, expression] of Object.entries(stage.$project)) {
                  if (expression === 0) continue;
                  if (expression === 1) projected[key] = record[key];
                  else if (typeof expression === 'string' && expression.startsWith('$')) projected[key] = record[expression.slice(1)];
                  else projected[key] = expression;
                }
                return projected;
              });
            }
          }
          return records;
        },
      };
    },
  };
}

async function readLegacyData() {
  const portalPath = process.env.PORTAL_DB_PATH || path.join(__dirname, 'data', 'portal.json');
  try {
    const data = JSON.parse(await fs.readFile(portalPath, 'utf8'));
    if (Array.isArray(data)) return { students: data.map((record) => ({ ...record, _id: record._id || new SQLiteObjectId() })) };
    if (!data || typeof data !== 'object') throw new Error('Existing portal database must be a JSON object.');
    return data;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const studentsPath = process.env.JSON_DB_PATH || path.join(__dirname, 'data', 'students.json');
  try {
    const records = JSON.parse(await fs.readFile(studentsPath, 'utf8'));
    if (!Array.isArray(records)) throw new Error('Legacy student data must be a JSON array.');
    return {
      students: records.map((record) => {
        const { id, ...fields } = record;
        return { ...fields, legacyId: id, _id: new SQLiteObjectId() };
      }),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {};
}

async function initialize() {
  if (initialized) return;
  const schema = await fs.readFile(path.join(__dirname, 'sqlite-schema.sql'), 'utf8');
  databaseConnection.exec(schema);
  if (!databaseConnection.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()) {
    const legacy = await readLegacyData();
    databaseConnection.exec('BEGIN IMMEDIATE');
    try {
      for (const name of collectionNames) {
        const records = legacy[name] || [];
        if (!Array.isArray(records)) throw new Error(`Existing "${name}" data must be an array.`);
        for (const record of records) insertDocumentSync(name, record);
      }
      databaseConnection.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
      databaseConnection.exec('COMMIT');
    } catch (error) {
      databaseConnection.exec('ROLLBACK');
      throw error;
    }
  }
  initialized = true;
}

async function close() {
  databaseConnection.close();
}

async function check() {
  return withDatabase(null, () => databaseConnection.prepare('SELECT 1').get());
}

async function stats() {
  return withDatabase(null, () => {
    const total = databaseConnection.prepare(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) AS inactive
       FROM students`
    ).get();
    const byCourse = databaseConnection.prepare(
      'SELECT course, COUNT(*) AS count FROM students GROUP BY course ORDER BY count DESC, course'
    ).all();
    return { total: total.total, active: total.active || 0, inactive: total.inactive || 0, byCourse };
  });
}

async function list({ search, course, status }) {
  return withDatabase(null, () => {
    const conditions = [];
    const params = [];
    if (search) {
      const expression = `instr(lower(coalesce(json_extract(document, '$.name'), '')), lower(?)) > 0
        OR instr(lower(roll_no), lower(?)) > 0 OR instr(lower(email), lower(?)) > 0`;
      conditions.push(`(${expression})`);
      params.push(search, search, search);
    }
    if (course) {
      conditions.push('course = ?');
      params.push(course);
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    const rows = databaseConnection.prepare(
      `SELECT id, document FROM students ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT 500`
    ).all(...params);
    return rows.map(rowToDocument).map((student) => {
      const { _id, ...data } = student;
      return { ...data, id: String(_id) };
    });
  });
}

async function get(id) {
  if (!SQLiteObjectId.isValid(id)) return null;
  const student = await collection('students').findOne({ _id: new SQLiteObjectId(id) });
  if (!student) return null;
  const { _id, ...data } = student;
  return { ...data, id: String(_id) };
}

async function create(data) {
  const now = new Date().toISOString();
  const student = { phone: null, gender: null, dob: null, semester: 1, address: null, status: 'active', ...data, created_at: now, updated_at: now };
  const result = await collection('students').insertOne(student);
  return { ...student, id: String(result.insertedId) };
}

async function update(id, data) {
  if (!SQLiteObjectId.isValid(id)) return null;
  const result = await collection('students').findOneAndUpdate(
    { _id: new SQLiteObjectId(id) },
    { $set: { ...data, updated_at: new Date().toISOString() } },
    { returnDocument: 'after' }
  );
  if (!result) return null;
  const { _id, ...student } = result;
  return { ...student, id: String(_id) };
}

async function remove(id) {
  if (!SQLiteObjectId.isValid(id)) return false;
  return (await collection('students').deleteOne({ _id: new SQLiteObjectId(id) })).deletedCount > 0;
}

const client = { startSession: () => new SQLiteSession() };
const database = {
  collection,
  command: async () => withDatabase(null, () => databaseConnection.prepare('SELECT sqlite_version() AS version').get()),
};

module.exports = {
  driver: 'sqlite',
  supportsPortal: true,
  initialize,
  close,
  check,
  stats,
  list,
  get,
  create,
  update,
  remove,
  db: database,
  client,
  collection,
  ObjectId: SQLiteObjectId,
  whereClause,
};
