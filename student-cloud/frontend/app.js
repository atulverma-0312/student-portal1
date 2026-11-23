const $ = (selector, root = document) => root.querySelector(selector);
const authView = $('#authView');
const portalView = $('#portalView');
const portalNav = $('#portalNav');
const portalContent = $('#portalContent');
const accountBar = $('#accountBar');
const toast = $('#toast');
let currentUser = null;
let currentSection = 'students';
let editingStudentId = null;
let editingAttendanceId = null;
let editingInvoiceId = null;
let studentsCache = [];
let attendanceCache = [];
let invoiceCache = [];
let toastTimer;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function showToast(message, error = false) {
  toast.textContent = message;
  toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

async function api(url, options = {}) {
  const response = await fetch(url.startsWith('/health') ? url : `/api${url}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || (data.errors && data.errors.join(', ')) || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const formData = (form) => Object.fromEntries(new FormData(form).entries());
const send = (url, body, method = 'POST') => api(url, { method, body: JSON.stringify(body) });
const eyeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle><path class="eye-slash" d="M3 3l18 18"></path></svg>';

function passwordField(label, autocomplete) {
  return `<label>${label}
    <span class="password-control">
      <input name="password" type="password" minlength="12" required autocomplete="${autocomplete}" />
      <button class="password-toggle" type="button" data-toggle-password aria-label="Show password" aria-pressed="false">${eyeIcon}</button>
    </span>
  </label>`;
}

function showAuth() {
  currentUser = null;
  accountBar.hidden = true;
  portalView.hidden = true;
  authView.hidden = false;
}

function availableSections() {
  if (currentUser.role === 'student') {
    return [['students', 'My profile'], ['attendance', 'Attendance'], ['fees', 'Fees']];
  }
  const sections = [['students', 'Students'], ['attendance', 'Attendance']];
  if (currentUser.role === 'admin') sections.push(['fees', 'Fees']);
  return sections;
}

function renderPortal() {
  authView.hidden = true;
  portalView.hidden = false;
  accountBar.hidden = false;
  $('#accountName').textContent = `${currentUser.name} · ${currentUser.role}`;
  if (currentUser.mustChangePassword) {
    portalNav.innerHTML = '';
    portalContent.innerHTML = `
      <section class="card narrow">
        <h2>Change your temporary password</h2>
        <p class="muted">Choose a new password with at least 12 characters to continue.</p>
        <form id="passwordForm" class="stack">
          ${passwordField('New password', 'new-password')}
          <button class="btn primary">Update password</button>
        </form>
      </section>`;
    return;
  }
  const sections = availableSections();
  if (!sections.some(([key]) => key === currentSection)) currentSection = sections[0][0];
  portalNav.innerHTML = sections.map(([key, label]) => `
    <button class="nav-button${currentSection === key ? ' selected' : ''}" data-section="${key}" aria-current="${currentSection === key ? 'page' : 'false'}">${label}</button>
  `).join('');
  loadSection().catch((error) => showToast(error.message, true));
}

function table(headers, rows, emptyText) {
  if (!rows.length) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function studentSelect(students, selectedId = '') {
  return `<label>Student<select name="studentId" required>
    <option value="">Select student</option>
    ${students.map((student) => `<option value="${escapeHtml(student.id)}" ${String(student.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(student.roll_no)} · ${escapeHtml(student.name)}</option>`).join('')}
  </select></label>`;
}

async function loadSection() {
  if (currentUser.mustChangePassword) return;
  if (currentSection === 'students') return renderStudents();
  if (currentSection === 'attendance') return renderAttendance();
  if (currentSection === 'fees') return renderFees();
}

async function renderStudents() {
  const students = await api('/students');
  studentsCache = students;
  if (currentUser.role === 'student') {
    const student = students[0];
    portalContent.innerHTML = `<section class="card"><h2>My student profile</h2>${student ? table(
      ['Roll number', 'Name', 'Course', 'Semester', 'Email', 'Status'],
      [`<tr><td>${escapeHtml(student.roll_no)}</td><td>${escapeHtml(student.name)}</td><td>${escapeHtml(student.course)}</td><td>${escapeHtml(student.semester)}</td><td>${escapeHtml(student.email)}</td><td>${escapeHtml(student.status)}</td></tr>`],
      'No student record is linked to your account.',
    ) : '<p class="empty">No student record is linked to your account.</p>'}</section>`;
    return;
  }

  const stats = currentUser.role === 'admin' ? await api('/students/stats') : null;
  const editing = students.find((student) => student.id === editingStudentId);
  portalContent.innerHTML = `
    ${stats ? `<section class="stats">
      <div class="stat"><span>${stats.total}</span><label>Total students</label></div>
      <div class="stat active"><span>${stats.active}</span><label>Active</label></div>
      <div class="stat inactive"><span>${stats.inactive}</span><label>Inactive</label></div>
      <div class="stat courses"><span>${stats.byCourse.length}</span><label>Courses</label></div>
    </section>` : ''}
    ${currentUser.role === 'admin' ? `<section class="card">
      <h2>${editing ? 'Edit student' : 'Add student'}</h2>
      <form id="studentForm" class="form-grid">
        <label>Roll number<input name="roll_no" maxlength="20" required value="${escapeHtml(editing?.roll_no || '')}" /></label>
        <label>Full name<input name="name" maxlength="100" required value="${escapeHtml(editing?.name || '')}" /></label>
        <label>Email<input name="email" type="email" maxlength="120" required value="${escapeHtml(editing?.email || '')}" /></label>
        <label>Course<input name="course" maxlength="60" required value="${escapeHtml(editing?.course || '')}" /></label>
        <label>Semester<input name="semester" type="number" min="1" max="8" value="${escapeHtml(editing?.semester || 1)}" required /></label>
        <label>Phone<input name="phone" type="tel" maxlength="15" value="${escapeHtml(editing?.phone || '')}" /></label>
        <label>Date of birth<input name="dob" type="date" value="${escapeHtml(editing?.dob || '')}" /></label>
        <label>Gender<select name="gender">
          <option value="">Not specified</option>
          <option value="male" ${editing?.gender === 'male' ? 'selected' : ''}>Male</option>
          <option value="female" ${editing?.gender === 'female' ? 'selected' : ''}>Female</option>
          <option value="other" ${editing?.gender === 'other' ? 'selected' : ''}>Other</option>
        </select></label>
        <label>Status<select name="status">
          <option value="active" ${!editing || editing.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="inactive" ${editing?.status === 'inactive' ? 'selected' : ''}>Inactive</option>
        </select></label>
        <label class="field full">Address<input name="address" maxlength="255" value="${escapeHtml(editing?.address || '')}" /></label>
        <div class="actions field full">
          <button class="btn primary">${editing ? 'Save changes' : 'Add student'}</button>
          ${editing ? '<button class="btn" type="button" data-cancel-student>Edit cancelled</button>' : ''}
        </div>
      </form>
    </section>` : ''}
    <section class="card"><div class="toolbar"><h2>Student records</h2><span class="muted">${students.length} shown</span></div>${table(
      ['Roll number', 'Name', 'Course', 'Semester', 'Email', 'Status', ...(currentUser.role === 'admin' ? ['Actions'] : [])],
      students.map((student) => `<tr>
        <td>${escapeHtml(student.roll_no)}</td><td>${escapeHtml(student.name)}</td><td>${escapeHtml(student.course)}</td>
        <td>${escapeHtml(student.semester)}</td><td>${escapeHtml(student.email)}</td>
        <td><span class="tag ${student.status === 'active' ? 'active' : 'inactive'}">${escapeHtml(student.status)}</span></td>
        ${currentUser.role === 'admin' ? `<td class="row-actions">
          <button class="btn small" data-edit-student="${escapeHtml(student.id)}">Edit</button>
          <button class="btn small danger" data-delete-student="${escapeHtml(student.id)}">Delete</button>
        </td>` : ''}
      </tr>`),
      'No students found. Add the first student above.',
    )}</section>`;
}

async function renderAttendance() {
  const canManage = ['admin', 'teacher'].includes(currentUser.role);
  const [records, students] = await Promise.all([
    api('/attendance'),
    api('/students'),
  ]);
  attendanceCache = records;
  studentsCache = students;
  const editing = records.find((record) => record.id === editingAttendanceId);
  const studentNames = new Map(students.map((student) => [String(student.id), `${student.roll_no} · ${student.name}`]));
  portalContent.innerHTML = `
    ${canManage ? `<section class="card">
      <h2>${editing ? 'Edit attendance' : 'Record attendance'}</h2>
      <form id="attendanceForm" class="form-grid">
        ${studentSelect(students, editing?.studentId)}
        <label>Date<input type="date" name="date" required value="${escapeHtml(editing?.date || '')}" /></label>
        <label>Status<select name="status">
          <option value="present" ${editing?.status === 'present' ? 'selected' : ''}>Present</option>
          <option value="absent" ${editing?.status === 'absent' ? 'selected' : ''}>Absent</option>
          <option value="late" ${editing?.status === 'late' ? 'selected' : ''}>Late</option>
        </select></label>
        <label>Note<input name="note" maxlength="255" value="${escapeHtml(editing?.note || '')}" /></label>
        <div class="actions"><button class="btn primary">${editing ? 'Save changes' : 'Save attendance'}</button>
          ${editing ? '<button class="btn" type="button" data-cancel-attendance>Cancel</button>' : ''}
        </div>
      </form>
    </section>` : ''}
    <section class="card"><div class="toolbar"><h2>${currentUser.role === 'student' ? 'My attendance' : 'Attendance records'}</h2><span class="muted">${records.length} shown</span></div>${table(
      ['Date', 'Student', 'Status', 'Note', ...(canManage ? ['Actions'] : [])],
      records.map((record) => `<tr>
        <td>${escapeHtml(record.date)}</td><td>${escapeHtml(studentNames.get(String(record.studentId)) || 'Student record')}</td>
        <td><span class="tag ${record.status === 'present' ? 'active' : 'inactive'}">${escapeHtml(record.status)}</span></td>
        <td>${escapeHtml(record.note || '')}</td>
        ${canManage ? `<td class="row-actions">
          <button class="btn small" data-edit-attendance="${escapeHtml(record.id)}">Edit</button>
          <button class="btn small danger" data-delete-attendance="${escapeHtml(record.id)}">Delete</button>
        </td>` : ''}
      </tr>`),
      'No attendance records.',
    )}</section>`;
}

async function renderFees() {
  const isAdmin = currentUser.role === 'admin';
  const [invoices, students] = await Promise.all([
    api('/invoices'),
    api('/students'),
  ]);
  invoiceCache = invoices;
  studentsCache = students;
  const editing = invoices.find((invoice) => invoice.id === editingInvoiceId);
  const studentNames = new Map(students.map((student) => [String(student.id), `${student.roll_no} · ${student.name}`]));
  portalContent.innerHTML = `
    ${isAdmin ? `<section class="card">
      <h2>${editing ? 'Edit fee record' : 'Add fee record'}</h2>
      <form id="invoiceForm" class="form-grid">
        ${studentSelect(students, editing?.studentId)}
        <label>Fee description<input name="title" maxlength="100" required value="${escapeHtml(editing?.title || '')}" /></label>
        <label>Amount (INR)<input name="amountInr" type="number" min="1" max="10000000" step="1" required value="${escapeHtml(editing?.amountInr || '')}" /></label>
        <label>Due date<input name="dueDate" type="date" value="${escapeHtml(editing?.dueDate || '')}" /></label>
        <div class="actions"><button class="btn primary">${editing ? 'Save changes' : 'Add fee'}</button>
          ${editing ? '<button class="btn" type="button" data-cancel-invoice>Cancel</button>' : ''}
        </div>
      </form>
    </section>` : ''}
    <section class="card"><div class="toolbar"><h2>${isAdmin ? 'Fee records' : 'My fees'}</h2><span class="muted">${invoices.length} shown</span></div>${table(
      ['Student', 'Description', 'Amount', 'Due date', 'Status', ...(isAdmin ? ['Actions'] : [])],
      invoices.map((invoice) => `<tr>
        <td>${escapeHtml(studentNames.get(String(invoice.studentId)) || 'Student record')}</td>
        <td>${escapeHtml(invoice.title)}</td><td>₹${escapeHtml(invoice.amountInr)}</td>
        <td>${escapeHtml(invoice.dueDate || '—')}</td>
        <td><span class="tag ${invoice.status === 'paid' ? 'active' : 'inactive'}">${escapeHtml(invoice.status)}</span></td>
        ${isAdmin ? `<td class="row-actions">
          <button class="btn small" data-edit-invoice="${escapeHtml(invoice.id)}">Edit</button>
          <button class="btn small" data-toggle-invoice="${escapeHtml(invoice.id)}">${invoice.status === 'paid' ? 'Mark unpaid' : 'Mark paid'}</button>
          <button class="btn small danger" data-delete-invoice="${escapeHtml(invoice.id)}" ${invoice.status === 'paid' ? 'disabled title="Paid fees are retained for history"' : ''}>Delete</button>
        </td>` : ''}
      </tr>`),
      'No fee records.',
    )}</section>`;
}

function clearEditing() {
  editingStudentId = null;
  editingAttendanceId = null;
  editingInvoiceId = null;
}

async function submitForm(form) {
  const values = formData(form);
  if (form.id === 'passwordForm') {
    await send('/auth/password', values);
    currentUser.mustChangePassword = false;
    showToast('Password updated');
    return renderPortal();
  }
  if (form.id === 'studentForm') {
    values.semester = Number(values.semester);
    const url = editingStudentId ? `/students/${encodeURIComponent(editingStudentId)}` : '/students';
    await send(url, values, editingStudentId ? 'PUT' : 'POST');
    showToast(editingStudentId ? 'Student updated' : 'Student added');
  } else if (form.id === 'attendanceForm') {
    const url = editingAttendanceId ? `/attendance/${encodeURIComponent(editingAttendanceId)}` : '/attendance';
    await send(url, values, editingAttendanceId ? 'PUT' : 'POST');
    showToast(editingAttendanceId ? 'Attendance updated' : 'Attendance saved');
  } else if (form.id === 'invoiceForm') {
    values.amountInr = Number(values.amountInr);
    const url = editingInvoiceId ? `/invoices/${encodeURIComponent(editingInvoiceId)}` : '/invoices';
    await send(url, values, editingInvoiceId ? 'PATCH' : 'POST');
    showToast(editingInvoiceId ? 'Fee record updated' : 'Fee record added');
  } else {
    return;
  }
  clearEditing();
  await loadSection();
}

async function handleRecordAction(button) {
  if (button.dataset.cancelStudent !== undefined) editingStudentId = null;
  else if (button.dataset.cancelAttendance !== undefined) editingAttendanceId = null;
  else if (button.dataset.cancelInvoice !== undefined) editingInvoiceId = null;
  else if (button.dataset.editStudent) editingStudentId = button.dataset.editStudent;
  else if (button.dataset.editAttendance) editingAttendanceId = button.dataset.editAttendance;
  else if (button.dataset.editInvoice) editingInvoiceId = button.dataset.editInvoice;
  else if (button.dataset.deleteStudent) {
    const student = studentsCache.find((item) => item.id === button.dataset.deleteStudent);
    if (!window.confirm(`Delete student ${student?.name || ''}? Records with attendance or fee history cannot be deleted.`)) return;
    await api(`/students/${encodeURIComponent(button.dataset.deleteStudent)}`, { method: 'DELETE' });
    showToast('Student deleted');
  } else if (button.dataset.deleteAttendance) {
    if (!window.confirm('Delete this attendance record?')) return;
    await api(`/attendance/${encodeURIComponent(button.dataset.deleteAttendance)}`, { method: 'DELETE' });
    showToast('Attendance deleted');
  } else if (button.dataset.deleteInvoice) {
    if (!window.confirm('Delete this unpaid fee record?')) return;
    await api(`/invoices/${encodeURIComponent(button.dataset.deleteInvoice)}`, { method: 'DELETE' });
    showToast('Fee record deleted');
  } else if (button.dataset.toggleInvoice) {
    const invoice = invoiceCache.find((item) => item.id === button.dataset.toggleInvoice);
    if (!invoice) return;
    const status = invoice.status === 'paid' ? 'unpaid' : 'paid';
    await send(`/invoices/${encodeURIComponent(invoice.id)}`, { status }, 'PATCH');
    showToast(`Fee marked ${status}`);
  } else {
    return;
  }
  await loadSection();
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    await send('/auth/login', formData(event.currentTarget));
    currentUser = await api('/auth/me');
    currentSection = 'students';
    renderPortal();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await send('/auth/logout', {});
  } catch (error) {
    showToast(error.message, true);
  }
  showAuth();
});

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-toggle-password]');
  if (!toggle) return;
  const input = toggle.parentElement.querySelector('input[type="password"], input[type="text"]');
  if (!input) return;
  const isVisible = input.type === 'password';
  input.type = isVisible ? 'text' : 'password';
  toggle.classList.toggle('visible', isVisible);
  toggle.setAttribute('aria-label', isVisible ? 'Hide password' : 'Show password');
  toggle.setAttribute('aria-pressed', String(isVisible));
  input.focus();
});

portalNav.addEventListener('click', (event) => {
  const button = event.target.closest('[data-section]');
  if (!button) return;
  currentSection = button.dataset.section;
  renderPortal();
});

portalContent.addEventListener('submit', async (event) => {
  const form = event.target.closest('form');
  if (!form) return;
  event.preventDefault();
  try {
    await submitForm(form);
  } catch (error) {
    showToast(error.message, true);
  }
});

portalContent.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    await handleRecordAction(button);
  } catch (error) {
    showToast(error.message, true);
  }
});

async function start() {
  try {
    currentUser = await api('/auth/me');
    renderPortal();
  } catch (error) {
    if (error.status !== 401 && error.status !== 503) showToast(error.message, true);
    showAuth();
  }
}

start();
