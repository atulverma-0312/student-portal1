# Student Management System

A role-protected management portal focused on three areas:

- **Students:** create, view, edit, deactivate, and delete student records.
- **Attendance:** record, view, edit, and delete daily attendance.
- **Fees:** create and edit fee records, mark them paid/unpaid, and remove unpaid records.

There is no public admission, exam/results, staff-management, or online-payment workflow. Admins sign in before accessing student and fee data. Existing SQLite records from removed sections are retained for data safety, but their old APIs and UI are no longer available.

## Run locally

1. Install Node.js 22.13 or newer.
2. From `backend`, run `npm install`.
3. Optionally copy `backend/.env.example` to `backend/.env` and set admin credentials.
4. In VS Code, run **Run Local Student Portal** and open `http://localhost:5002`. Or run `npm start` from `backend` and open `http://localhost:5000`.
5. Check `http://localhost:5002/health/db` to confirm SQLite is connected.

SQLite is the only supported database. By default, data is stored in `backend/data/portal.sqlite`; set `SQLITE_DB_PATH` to choose another file. No database server is needed.

On first startup, a local admin account is created if one does not already exist. If `ADMIN_PASSWORD` is blank in development, the server prints a temporary password once. Save it securely. To set a new password for an existing active admin, put the matching `ADMIN_EMAIL` and a new unique 12+ character `ADMIN_PASSWORD` in `backend/.env`, then run `npm run admin:reset` from `backend`. The reset command will not create or promote accounts and never prints the password.

## Data safety

On the first SQLite startup, existing `backend/data/portal.json` records are imported. If it is absent, `backend/data/students.json` is imported. Source files are not changed or removed. Existing SQLite records are never cleared by the app.

Student records with attendance, fee, linked-account, or legacy history cannot be deleted; mark them inactive instead. Paid fee records cannot be deleted. These safeguards preserve records needed for history.

The database schema is in `backend/sqlite-schema.sql`. SQLite is intended for local development or a single application instance with a persistent disk. Do not share one SQLite file between horizontally scaled servers. For AWS, use encrypted persistent storage and tested backups, and keep the management portal behind HTTPS and sign-in.

Never commit `backend/.env`, passwords, or student records.

## API

All management APIs require an authenticated session cookie.

| Area | Endpoints |
|---|---|
| Sign-in | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password` |
| Students | `GET /api/students`, `GET /api/students/stats`, `GET /api/students/:id`, `POST /api/students`, `PUT /api/students/:id`, `DELETE /api/students/:id` |
| Attendance | `GET /api/attendance`, `POST /api/attendance`, `PUT /api/attendance/:id`, `DELETE /api/attendance/:id` |
| Fees | `GET /api/invoices`, `POST /api/invoices`, `PATCH /api/invoices/:id`, `DELETE /api/invoices/:id` |
| Health | `GET /health`, `GET /health/db` |

Run `npm test` and `npm run check` from `backend` to validate the application.
