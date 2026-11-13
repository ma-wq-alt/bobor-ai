const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const upload = multer({ storage: multer.memoryStorage() });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const JWT_SECRET = process.env.JWT_SECRET || 'bobor-super-secret-key-123';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || '', 
    pass: process.env.EMAIL_PASS || '' 
  }
});

async function initDB() {
  try {
    // Авто-обновление старой базы
    try { await db.execute('SELECT theme FROM users LIMIT 1'); } 
    catch (e) {
      if (e.message.includes('no such column') || e.message.includes('no such table')) {
        console.log('⚠️ Обновляем структуру базы для настроек...');
        await db.execute('DROP TABLE IF EXISTS users');
      }
    }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password_hash TEXT,
        role TEXT DEFAULT 'user',
        otp_code TEXT,
        otp_expires DATETIME,
        theme TEXT DEFAULT 'dark',
        language TEXT DEFAULT 'ru',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        image_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(chat_id) REFERENCES chats(id)
      )
    `);
    
    const adminEmail = 'mar.maks999@gmail.com';
    const adminCheck = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [adminEmail] });
    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash('1495', 10);
      await db.execute({
        sql: 'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
        args: ['hank', adminEmail, hash, 'admin']
      });
      console.log('✅ Админский аккаунт (hank) создан автоматически');
    }
    console.log('✅ База данных инициализирована');
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
  }
}
initDB();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Неверный токен' });
  }
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ? OR email = ?',
      args: [username, username]
    });
    const user = result.rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Неверный логин или пароль' });
    
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный логин или пароль' });
    
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, theme: user.theme, language: user.language }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role, theme: user.theme || 'dark', language: user.language || 'ru' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Введите почту' });

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60000).toISOString(); 

    let userRes = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    let user = userRes.rows[0];

    if (!user) {
      const baseUsername = email.split('@')[0] + Math.floor(Math.random() * 100);
      await db.execute({
        sql: 'INSERT INTO users (email, username, role, otp_code, otp_expires) VALUES (?, ?, ?, ?, ?)',
        args: [email, baseUsername, 'user', otp, expires]
      });
    } else {
      await db.execute({
        sql: 'UPDATE users SET otp_code = ?, otp_expires = ? WHERE email = ?',
        args: [otp, expires, email]
      });
    }

    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      await transporter.sendMail({
        from: '"БОБОР ПРОДАКШН" <' + process.env.EMAIL_USER + '>',
        to: email,
        subject: 'БОБОР ПРОДАКШН: Ваш код доступа',
        text: `В начале ваш код: ${otp}. Это ваш код от Бобор Продакшн. Никому его не говорите!`,
        html: `
          <div style="font-family: Arial, sans-serif; background: #0f0c29; color: #fff; padding: 20px; border-radius: 10px;">
            <h2 style="color: #a78bfa;">🦫 БОБОР ПРОДАКШН</h2>
            <p style="font-size: 16px;">Привет! Ты запросил код для входа.</p>
            <p style="font-size: 16px;">В начале ваш код: <b style="font-size: 24px; color: #c4b5fd;">${otp}</b></p>
            <p style="font-size: 14px; color: #999;">Никому его не говорите. Код действует 10 минут.</p>
          </div>
        `
      });
      res.json({ success: true, message: 'Код отправлен на почту!' });
    } else {
      console.log(`\n\n========================================`);
      console.log(`🚀 БОБОР ПРОДАКШН: НОВЫЙ ВХОД!`);
      console.log(`📧 Почта: ${email}`);
      console.log(`🔑 ВАШ КОД: ${otp}`);
      console.log(`========================================\n\n`);
      res.json({ success: true, message: 'Код сгенерирован! Смотрите логи Render.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Ошибка: ' + err.message });
  }
});

app.post('/api/verify-code', async (req, res) => {
  const { email, code } = req.body;
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    const user = result.rows[0];
    
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    if (user.otp_code !== code) return res.status(401).json({ error: 'Неверный код' });
    
    const now = new Date().toISOString();
    if (now > user.otp_expires) return res.status(401).json({ error: 'Код истек' });

    await db.execute({ sql: 'UPDATE users SET otp_code = NULL, otp_expires = NULL WHERE id = ?', args: [user.id] });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, theme: user.theme, language: user.language }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role, theme: user.theme || 'dark', language: user.language || 'ru' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- СОХРАНЕНИЕ НАСТРОЕК (ТЕМА, ЯЗЫК, НИК) ---
app.post('/api/user/settings', authMiddleware, async (req, res) => {
  const { username, theme, language } = req.body;
  try {
    await db.execute({
      sql: 'UPDATE users SET username = ?, theme = ?, language = ? WHERE id = ?',
      args: [username, theme, language, req.user.id]
    });
    
    // Обновляем токен, так как изменился ник
    const newToken = jwt.sign({ id: req.user.id, username, role: req.user.role, theme, language }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token: newToken, username, theme, language });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Этот ник уже занят' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM chats WHERE user_id = ? ORDER BY created_at DESC',
      args: [req.user.id]
    });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'INSERT INTO chats (user_id, title) VALUES (?, ?) RETURNING id',
      args: [req.user.id, 'Новый чат']
    });
    res.json({ chatId: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  try {
    const chatCheck = await db.execute({
      sql: 'SELECT id FROM chats WHERE id = ? AND user_id = ?',
      args: [chatId, req.user.id]
    });
    if (chatCheck.rows.length === 0) return res.status(403).json({ error: 'Доступ запрещён' });
    const result = await db.execute({
      sql: 'SELECT role, content, image_url FROM messages WHERE chat_id = ? ORDER BY id ASC',
      args: [chatId]
    });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chats/:chatId/message', authMiddleware, upload.single('image'), async (req, res) => {
  const { chatId } = req.params;
  const { message, mode } = req.body; 
  const imageFile = req.file;

  try {
    let imageUrlInDB = null;
    let imageBase64 = null;

    if (imageFile) {
      imageBase64 = `data:${imageFile.mimetype};base64,${imageFile.buffer.toString('base64')}`;
      imageUrlInDB = "Прикреплено фото";
    }

    await db.execute({
      sql: 'INSERT INTO messages (chat_id, role, content, image_url) VALUES (?, ?, ?, ?)',
      args: [chatId, 'user', message || 'Отправил(а) фото', imageUrlInDB]
    });

    const countMsg = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM messages WHERE chat_id = ?',
      args: [chatId]
    });
    if (countMsg.rows[0].count === 1) {
      const title = (message || 'Фото').slice(0, 30) + ((message || 'Фото').length > 30 ? '...' : '');
      await db.execute({ sql: 'UPDATE chats SET title = ? WHERE id = ?', args: [title, chatId] });
    }

    const isDrawRequest = /нарисуй|сгенерируй|покажи картинку|создай изображение/i.test(message || '');
    if (isDrawRequest && !imageFile) {
      const prompt = message.replace(/нарисуй|сгенерируй|покажи картинку|создай изображение/gi, '').trim();
      const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
      const replyText = `🎨 Вот твоя картинка по запросу: "${prompt}"`;
      await db.execute({
        sql: 'INSERT INTO messages (chat_id, role, content, image_url) VALUES (?, ?, ?, ?)',
        args: [chatId, 'assistant', replyText, pollUrl]
      });
      return res.json({ reply: replyText, imageUrl: pollUrl });
    }

    const historyResult = await db.execute({
      sql: 'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 20',
      args: [chatId]
    });
    const history = historyResult.rows.reverse().map(row => ({ role: row.role, content: row.content }));

    const userContent = imageBase64 
      ? [ { type: "text", text: message || "Что на этой картинке?" }, { type: "image_url", image_url: { url: imageBase64 } } ]
      : message;

    history[history.length - 1] = { role: 'user', content: userContent };
    const messagesForAI = [ { role: 'system', content: 'Ты — БОБОР-AI, умный и дружелюбный ассистент. Отвечай на русском.' }, ...history ];

    let model = imageFile ? 'glm-4.6v-flash' : 'glm-4.5-flash'; 
    
    const aiResponse = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.ZAI_API_KEY}` },
      body: JSON.stringify({ model: model, messages: messagesForAI, temperature: 0.7 })
    });

    if (!aiResponse.ok) throw new Error(`Ошибка API: ${aiResponse.status}`);
    const aiData = await aiResponse.json();
    const replyText = aiData.choices[0].message.content;

    await db.execute({
      sql: 'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
      args: [chatId, 'assistant', replyText]
    });

    res.json({ reply: replyText });

  } catch (error) {
    res.status(500).json({ error: 'Ошибка: ' + error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🦫 Бобор-AI запущен на порту ${PORT}`));
