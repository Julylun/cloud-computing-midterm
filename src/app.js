import express from 'express';
import { engine } from 'express-handlebars';
import helmet from 'helmet';
import session from 'express-session';
import { fileURLToPath } from 'node:url';
import { student } from './config/student.js';
import { BookValidationError, buildBook } from './domain/book.js';
import { readSessionConfig } from './config/session.js';
import { MongoSessionStore } from './session/mongo-store.js';

const viewsPath = fileURLToPath(new URL('../views/', import.meta.url));
const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
const currency = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });

function formValues(body = {}) {
  return Object.fromEntries(['code', 'title', 'author', 'basePrice'].map((field) => [
    field, typeof body[field] === 'string' ? body[field] : '',
  ]));
}
function databaseUnavailable() {
  return Object.assign(new Error('Database unavailable'), { status: 503 });
}

export function createApp({ database, sessionSecret, sessionStore, production = process.env.NODE_ENV === 'production' } = {}) {
  if (!database) throw new Error('Database chưa được cấu hình.');
  const { secret, ttlMs } = readSessionConfig({ SESSION_SECRET: sessionSecret });
  const store = sessionStore || new MongoSessionStore({ readDb: database.readDb, writeDb: database.writeDb, ttlMs });
  // Renew explicitly before headers are sent so a failed write can return 503.
  // The middleware adapter omits touch to avoid a second, asynchronous renewal at res.end.
  const middlewareStore = new session.Store();
  for (const method of ['get', 'set', 'destroy']) middlewareStore[method] = store[method].bind(store);
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': production ? [] : null } },
  }));
  app.engine('hbs', engine({
    extname: '.hbs', defaultLayout: 'main',
    helpers: { formatMoney: (value) => currency.format(value) },
  }));
  app.set('view engine', 'hbs');
  app.set('views', viewsPath);
  app.locals.student = student;
  app.use(express.static(publicPath));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  app.get('/healthz', async (_req, res) => {
    try {
      await database.health();
      res.json({ status: 'ok', database: 'connected' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  if (production) app.set('trust proxy', 1);
  app.use(session({
    name: 'book.sid',
    secret,
    store: middlewareStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { maxAge: ttlMs, httpOnly: true, sameSite: 'lax', secure: production },
  }));
  app.use(async (req, _res, next) => {
    if (req.session.lastAddedBookCode) {
      req.session.touch();
      try {
        await new Promise((resolve, reject) => {
          store.touch(req.sessionID, req.session, (error) => error ? reject(error) : resolve());
        });
      } catch (error) {
        req.session = null;
        throw error;
      }
    }
    next();
  });
  app.get('/', (_req, res) => res.redirect('/books'));

  async function renderBooks(res, { status = 200, errors = {}, values = {} } = {}) {
    let books;
    try {
      books = await database.books.list();
    } catch {
      throw databaseUnavailable();
    }
    return res.status(status).render('books', { title: 'Danh mục sách', books, errors, values });
  }
  const saveSession = (req) => new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) {
        // Keep the stored document intact and prevent an automatic touch after the failed save.
        req.session = null;
        reject(error);
      } else {
        resolve();
      }
    });
  });

  app.get('/books', async (req, res) => {
    let books;
    try {
      books = await database.books.list();
    } catch {
      throw databaseUnavailable();
    }
    const notice = req.session.notice;
    if (notice) {
      delete req.session.notice;
      await saveSession(req);
    }
    res.render('books', { title: 'Danh mục sách', books, notice, lastAddedBookCode: req.session.lastAddedBookCode });
  });
  app.post('/books', async (req, res) => {
    let book;
    try {
      book = buildBook(req.body);
    } catch (error) {
      if (!(error instanceof BookValidationError)) throw error;
      return renderBooks(res, { status: 400, errors: error.errors, values: formValues(req.body) });
    }
    try {
      await database.books.insert(book);
    } catch (error) {
      if (error.code === 11000) {
        return renderBooks(res, {
          status: 409,
          errors: { code: 'Mã sách đã tồn tại. Vui lòng chọn mã khác.' },
          values: formValues(req.body),
        });
      }
      throw databaseUnavailable();
    }
    req.session.notice = 'Đã thêm sách thành công.';
    req.session.lastAddedBookCode = book.code;
    try {
      await saveSession(req);
    } catch {
      // The book insert already succeeded; make this visible before the user retries.
      return res.status(503).render('error', {
        title: 'Không thể lưu phiên',
        message: 'Sách đã được lưu, nhưng không thể lưu phiên. Không cần thêm lại sách này.',
      });
    }
    return res.redirect(303, '/books');
  });
  app.use((_req, res) => {
    res.status(404).render('error', {
      title: 'Không tìm thấy trang', message: 'Trang bạn yêu cầu không tồn tại.',
    });
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const messages = {
      400: 'Yêu cầu không hợp lệ. Vui lòng kiểm tra dữ liệu.',
      413: 'Dữ liệu gửi lên quá lớn.',
      503: 'Không thể kết nối cơ sở dữ liệu. Vui lòng thử lại sau.',
      500: 'Không thể xử lý yêu cầu. Vui lòng thử lại sau.',
    };
    const status = Object.hasOwn(messages, error.status) ? error.status : 500;
    res.status(status).render('error', { title: 'Không thể xử lý yêu cầu', message: messages[status] });
  });
  return app;
}
