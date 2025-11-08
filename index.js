require('dotenv').config();


const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const session = require('express-session');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 7000;


// ======= DATABASE CONFIG =======
const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
};


// ======= MIDDLEWARE =======
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'rentdrive_secret_key',
  resave: false,
  saveUninitialized: true
}));

// Make user session available globally
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// Auth middleware
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// ======= DATABASE CONNECTION =======
let pool;
(async () => {
  try {
    pool = await mysql.createPool({ ...DB_CONFIG, connectionLimit: 10 });
    console.log("✅ Connected to MySQL database.");
  } catch (err) {
    console.error("❌ Database connection failed:", err);
  }
})();

// ======= FILE UPLOADS (Driver License) =======
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + '-' + file.originalname.replace(/\s+/g, '-'));
  }
});
const upload = multer({ storage });

// ======= ROUTES =======
// Public Pages
app.get('/', (req, res) => res.redirect('/index'));
app.get('/index', (req, res) => res.render('index'));
app.get('/about', (req, res) => res.render('about'));
app.get('/car-list', (req, res) => res.render('car-list'));
app.get('/contact', (req, res) => res.render('contact'));
app.get('/registration', (req, res) => res.render('registration'));
app.get('/driver-registration', (req, res) => res.render('driver-registration'));
app.get('/organization-registration', (req, res) => res.render('organization-registration'));
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login');
});

// ======= ROLE-BASED DASHBOARDS =======
app.get('/dashboard', requireLogin, async (req, res) => {
  const user = req.session.user;
  try {
    if (user.role === 'user') {
      const [bookings] = await pool.query(
        `SELECT b.*, d.fullname AS driver_name 
         FROM bookings b 
         LEFT JOIN drivers d ON b.driver_id = d.id 
         WHERE b.user_id = ? ORDER BY b.created_at DESC`,
        [user.id]
      );
      const [drivers] = await pool.query('SELECT id, fullname, city FROM drivers');
      return res.render('dashboard', { user, bookings, drivers });
    }

    if (user.role === 'driver') {
      const [rides] = await pool.query(
        `SELECT b.*, u.fullname AS user_name 
         FROM bookings b 
         LEFT JOIN users u ON b.user_id = u.id 
         WHERE b.driver_id = ? ORDER BY b.created_at DESC`,
        [user.id]
      );
      return res.render('dashboard-driver', { user, rides });
    }

    if (user.role === 'organization') {
      const [drivers] = await pool.query(
        'SELECT * FROM drivers WHERE organization_id = ? ORDER BY fullname ASC',
        [user.id]
      );
      return res.render('dashboard-org', { user, drivers });
    }

    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading dashboard');
  }
});

// ======= REGISTRATION =======
app.post('/register', async (req, res) => {
  try {
    const { fullname, email, password, phone, city } = req.body;
    await pool.query('INSERT INTO users (fullname, email, password, phone, city) VALUES (?, ?, ?, ?, ?)',
      [fullname, email, password, phone, city]);
    res.send(`<script>alert('Registration Successful! Redirecting...'); window.location='/login';</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error registering user.");
  }
});

app.post('/driver-register', upload.single('driver_license'), async (req, res) => {
  try {
    const { fullname, email, password, phone, city, orgOpt, orgId } = req.body;
    const license_file = req.file ? `/uploads/${req.file.filename}` : null;
    await pool.query(
      `INSERT INTO drivers (fullname, email, password, phone, city, org_type, organization_id, license_file) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [fullname, email, password, phone, city, orgOpt, orgId || null, license_file]
    );
    res.send(`<script>alert('Driver registration successful!'); window.location='/login';</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error registering driver.");
  }
});

app.post('/org-register', async (req, res) => {
  try {
    const { companyName, regNumber, email, phone, password } = req.body;
    await pool.query(
      'INSERT INTO organizations (company_name, reg_number, email, phone, password) VALUES (?, ?, ?, ?, ?)',
      [companyName, regNumber, email, phone, password]
    );
    res.send(`<script>alert('Organization registered successfully!'); window.location='/login';</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error registering organization.");
  }
});

// ======= LOGIN =======
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [userRows] = await pool.query('SELECT * FROM users WHERE email=? AND password=?', [email, password]);
    if (userRows.length > 0) {
      req.session.user = { id: userRows[0].id, role: 'user', name: userRows[0].fullname };
      return res.redirect('/dashboard');
    }

    const [driverRows] = await pool.query('SELECT * FROM drivers WHERE email=? AND password=?', [email, password]);
    if (driverRows.length > 0) {
      req.session.user = { id: driverRows[0].id, role: 'driver', name: driverRows[0].fullname };
      return res.redirect('/dashboard');
    }

    const [orgRows] = await pool.query('SELECT * FROM organizations WHERE email=? AND password=?', [email, password]);
    if (orgRows.length > 0) {
      req.session.user = { id: orgRows[0].id, role: 'organization', name: orgRows[0].company_name };
      return res.redirect('/dashboard');
    }

    res.send(`<script>alert('Invalid credentials!'); window.location='/login';</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error during login.");
  }
});

// ======= BOOKING CREATION =======
app.post('/book', requireLogin, async (req, res) => {
  try {
    const { pickup_address, drop_address, pickup_time, start_date, end_date } = req.body;
    const user_id = req.session.user.id;

    // get first available driver (simplified)
    const [driverRows] = await pool.query('SELECT id FROM drivers LIMIT 1');
    const driver_id = driverRows.length ? driverRows[0].id : null;

    await pool.query(
      `INSERT INTO bookings (user_id, driver_id, pickup_address, drop_address, pickup_time, start_date, end_date, status, confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [user_id, driver_id, pickup_address, drop_address, pickup_time, start_date, end_date, 'Scheduled']
    );

    res.send(`<script>alert('Ride booked successfully!'); window.location='/dashboard';</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error creating booking.");
  }
});


// ======= DRIVER CONFIRMATION =======
app.post('/confirm-ride', requireLogin, async (req, res) => {
  try {
    const { booking_id } = req.body;
    await pool.query('UPDATE bookings SET confirmed=1, status="Confirmed" WHERE id=?', [booking_id]);
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send("Error confirming ride.");
  }
});

// ======= CONTACT FORM =======
app.post('/contact-submit', async (req, res) => {
  const { name, email, phone, message } = req.body;
  console.log("Contact form:", { name, email, phone, message });
  res.send(`<script>alert('Message received!'); window.location='/index';</script>`);
});


// ======= DRIVER CONFIRM RIDE =======
app.post('/confirm-ride', requireLogin, async (req, res) => {
  try {
    const { booking_id } = req.body;
    const driver_id = req.session.user.id;

    await pool.query(
      `UPDATE bookings 
       SET confirmed = 1, status = 'Confirmed', driver_id = ? 
       WHERE id = ?`,
      [driver_id, booking_id]
    );

    res.send(`<script>alert('Ride confirmed successfully!'); window.location.href='/dashboard';</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error confirming ride.');
  }
});

// ======= USER CANCEL RIDE =======
app.post('/cancel-ride', requireLogin, async (req, res) => {
  try {
    const { booking_id } = req.body;
    const user_id = req.session.user.id;

    await pool.query(
      `UPDATE bookings 
       SET status = 'Cancelled', confirmed = 0 
       WHERE id = ? AND user_id = ?`,
      [booking_id, user_id]
    );

    res.send(`<script>alert('Ride cancelled successfully.'); window.location.href='/dashboard';</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error cancelling ride.');
  }
});

// ======= ORG ADD DRIVER =======
app.post('/org/add-driver', requireLogin, async (req, res) => {
  try {
    const { fullname, email, phone, city, password } = req.body;
    const orgId = req.session.user.id;

    await pool.query(
      `INSERT INTO drivers (fullname, email, password, phone, city, org_type, organization_id)
       VALUES (?, ?, ?, ?, ?, 'Organization', ?)`,
      [fullname, email, password, phone, city, orgId]
    );

    res.send(`<script>alert('Driver added successfully!'); window.location.href='/dashboard';</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error adding driver.');
  }
});

// ======= ORG UPDATE DRIVER =======
app.post('/org/update-driver', requireLogin, async (req, res) => {
  try {
    const { id, fullname, email, phone, city } = req.body;
    const orgId = req.session.user.id;

    await pool.query(
      `UPDATE drivers SET fullname=?, email=?, phone=?, city=?
       WHERE id=? AND organization_id=?`,
      [fullname, email, phone, city, id, orgId]
    );

    res.send(`<script>alert('Driver updated successfully!'); window.location.href='/dashboard';</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating driver.');
  }
});

// ======= ORG DELETE DRIVER =======
app.post('/org/delete-driver', requireLogin, async (req, res) => {
  try {
    const { id } = req.body;
    const orgId = req.session.user.id;

    await pool.query(`DELETE FROM drivers WHERE id=? AND organization_id=?`, [id, orgId]);

    res.send(`<script>alert('Driver deleted successfully!'); window.location.href='/dashboard';</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting driver.');
  }
});


// ======= LOGOUT =======
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ======= SERVER =======
app.listen(port, () => console.log(`🚗 RentDrive running at http://localhost:${port}`));
