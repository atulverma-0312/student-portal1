const driver = String(process.env.DB_DRIVER || 'sqlite').toLowerCase();
if (driver !== 'sqlite') throw new Error(`Unsupported DB_DRIVER "${driver}". This application uses SQLite.`);

module.exports = require('./sqlite-store');
