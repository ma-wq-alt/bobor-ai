const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Увеличили лимит для фото
app.use(express.static(__dirname));

// --- НАСТРОЙКА TURSO ---
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const JWT_SECRET = process.env.JWT_SECRET || 'bobor-super-secret-key-123';

// --- АВТОМАТИЧЕСКОЕ СОЗДАНИЕ ТАБЛИЦ (Вместо ручного SQL) ---
async function initDB() {
  try {
    // 1. Пользователи
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Чаты
    await db.execute(`
      CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )
    `);

    // 3. Сообщения
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
    
    console.log('✅ База данных инициализирована (таблицы созданы)');
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
  }
}
initDB();

// --- MIDDLEWARE ДЛЯ ПРОВЕРКИ ТОКЕНА ---
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

// --- РЕГИСТРАЦИЯ ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });

  try {
    const hash = await bcrypt.hash(password, 10);
    // Первый пользователь автоматически становится админом
    const countRes = await db.execute('SELECT COUNT(*) as count FROM users');
    const isFirst = countRes.rows[0].count === 0;
    const role = isFirst ? 'admin' : 'user';

    await db.execute({
      sql: 'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      args: [username, hash, role]
    });

    res.json({ success: true, role });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Логин занят' });
    res.status(500).json({ error: err.message });
  }
});

// --- ЛОГИН ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username]
    });
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный логин или пароль' });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ПОЛУЧИТЬ СПИСОК ЧАТОВ ПОЛЬЗОВАТЕЛЯ ---
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM chats WHERE user_id = ? ORDER BY created_at DESC',
      args: [req.user.id]
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- СОЗДАТЬ НОВЫЙ ЧАТ ---
app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'INSERT INTO chats (user_id, title) VALUES (?, ?) RETURNING id',
      args: [req.user.id, 'Новый чат']
    });
    res.json({ chatId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ПОЛУЧИТЬ ИСТОРИЮ КОНКРЕТНОГО ЧАТА ---
app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  try {
    // Проверяем, что чат принадлежит пользователю
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ОТПРАВИТЬ СООБЩЕНИЕ В ЧАТ (С ВЫБОРОМ РЕЖИМА) ---
app.post('/api/chats/:chatId/message', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  const { message, mode } = req.body; // mode: 'weak', 'normal', 'strong'

  try {
    // 1. Сохраняем сообщение пользователя
    await db.execute({
      sql: 'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
      args: [chatId, 'user', message]
    });

    // 2. Если это первое сообщение, обновляем название чата
    const countMsg = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM messages WHERE chat_id = ?',
      args: [chatId]
    });
    if (countMsg.rows[0].count === 1) {
      const title = message.slice(0, 30) + (message.length > 30 ? '...' : '');
      await db.execute({
        sql: 'UPDATE chats SET title = ? WHERE id = ?',
        args: [title, chatId]
      });
    }

    // 3. Достаем историю (последние 20 сообщений)
    const historyResult = await db.execute({
      sql: 'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 20',
      args: [chatId]
    });
    const history = historyResult.rows.reverse().map(row => ({
      role: row.role,
      content: row.content
    }));

    // 4. Настройка режима
    let model = 'deepseek-chat';
    let maxTokens = 1000;
    if (mode === 'weak') { maxTokens = 300; }
    if (mode === 'strong') { model = 'deepseek-reasoner'; maxTokens = 2000; } // Если у DeepSeek есть reasoning модель

    const messagesForAI = [
      { role: 'system', content: 'Ты — БОБОР-AI, умный и дружелюбный ассистент. Отвечай на русском.' },
      ...history
    ];

    // 5. Запрос к DeepSeek
    const aiResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: model,
        messages: messagesForAI,
        temperature: mode === 'weak' ? 0.3 : 0.7,
        max_tokens: maxTokens
      })
    });

    if (!aiResponse.ok) throw new Error(`DeepSeek: ${aiResponse.status}`);
    const aiData = await aiResponse.json();
    const replyText = aiData.choices[0].message.content;

    // 6. Сохраняем ответ
    await db.execute({
      sql: 'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
      args: [chatId, 'assistant', replyText]
    });

    res.json({ reply: replyText });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка: ' + error.message });
  }
});

// --- АДМИН: СТАТИСТИКА ---
app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только для админа' });
  try {
    const users = await db.execute('SELECT COUNT(*) as c FROM users');
    const chats = await db.execute('SELECT COUNT(*) as c FROM chats');
    res.json({ users: users.rows[0].c, chats: chats.rows[0].c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🦫 Бобор-AI запущен на порту ${PORT}`));
