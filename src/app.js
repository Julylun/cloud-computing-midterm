import express from 'express';
import { engine } from 'express-handlebars';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { student } from './config/student.js';

const viewsPath = fileURLToPath(new URL('../views/', import.meta.url));
const publicPath = fileURLToPath(new URL('../public/', import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.engine('hbs', engine({ extname: '.hbs', defaultLayout: 'main' }));
  app.set('view engine', 'hbs');
  app.set('views', viewsPath);
  app.locals.student = student;
  app.use(express.static(publicPath));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', stage: 'init' });
  });
  app.get('/', (_req, res) => {
    res.render('home', { title: 'Quản lý sách' });
  });
  app.use((_req, res) => {
    res.status(404).render('error', {
      title: 'Không tìm thấy trang',
      message: 'Trang bạn yêu cầu không tồn tại.',
    });
  });
  app.use((_error, _req, res, next) => {
    if (res.headersSent) return next(_error);
    res.status(500).render('error', {
      title: 'Không thể xử lý yêu cầu',
      message: 'Vui lòng thử lại sau.',
    });
  });
  return app;
}
