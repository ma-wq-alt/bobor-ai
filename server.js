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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const JWT_SECRET = process.env.JWT_SECRET || 'bobor-super-secret-key-123';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER || '', pass: process.env.EMAIL_PASS || '' }
});

async function initDB() {
  try {
    try { await db.execute('SELECT theme FROM users LIMIT 1'); } 
    catch (e) {
      if (e.message.includes('no such column') || e.message.includes('no such table')) {
        await db.execute('DROP TABLE IF EXISTS users');
      }
    }
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT UNIQUE, password_hash TEXT, role TEXT DEFAULT 'user', otp_code TEXT, otp_expires DATETIME, theme TEXT DEFAULT 'dark', language TEXT DEFAULT 'ru', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS bot_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt_text TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, image_url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(chat_id) REFERENCES chats(id))`);
    
    const adminEmail = 'mar.maks999@gmail.com';
    const adminCheck = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [adminEmail] });
    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash('1495', 10);
      await db.execute({ sql: 'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)', args: ['hank', adminEmail, hash, 'admin'] });
    }
  } catch (err) { console.error('❌ Ошибка БД:', err.message); }
}
initDB();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  const token = authHeader.split(' ')[1];
  try { req.user = jwt.verify(token, JWT_SECRET); next(); } 
  catch (err) { res.status(401).json({ error: 'Неверный токен' }); }
}

// ... (Маршруты login, send-code, verify-code, settings, knowledge, chats остаются БЕЗ ИЗМЕНЕНИЙ, они были в прошлом сообщении) ...

// Я сокращаю их здесь для экономии места, но в твоем файле они ДОЛЖНЫ БЫТЬ. 
// Вставляй те же самые маршруты, что были в предыдущем ответе, до маршрута отправки сообщения.

// Отправка сообщения (с анимацией для картинок)
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

    await db.execute({ sql: 'INSERT INTO messages (chat_id, role, content, image_url) VALUES (?, ?, ?, ?)', args: [chatId, 'user', message || 'Отправил(а) фото', imageUrlInDB] });

    const countMsg = await db.execute({ sql: 'SELECT COUNT(*) as count FROM messages WHERE chat_id = ?', args: [chatId] });
    if (countMsg.rows[0].count === 1) {
      const title = (message || 'Фото').slice(0, 30) + ((message || 'Фото').length > 30 ? '...' : '');
      await db.execute({ sql: 'UPDATE chats SET title = ? WHERE id = ?', args: [title, chatId] });
    }

    const isDrawRequest = /нарисуй|сгенерируй|покажи картинку|создай изображение/i.test(message || '');
    if (isDrawRequest && !imageFile) {
      const prompt = message.replace(/нарисуй|сгенерируй|покажи картинку|создай изображение/gi, '').trim();
      const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
      const replyText = `🎨 Вот твоя картинка по запросу: "${prompt}"`;
      await db.execute({ sql: 'INSERT INTO messages (chat_id, role, content, image_url) VALUES (?, ?, ?, ?)', args: [chatId, 'assistant', replyText, pollUrl] });
      return res.json({ reply: replyText, imageUrl: pollUrl });
    }

    // Если просят видео, пока возвращаем заглушку (чтобы не ломалось)
    if (/видео|video/i.test(message || '')) {
       const replyText = "🎬 Генерация видео находится в разработке. Пока я умею только рисовать картинки!";
       await db.execute({ sql: 'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)', args: [chatId, 'assistant', replyText] });
       return res.json({ reply: replyText });
    }

    const historyResult = await db.execute({ sql: 'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 20', args: [chatId] });
    const history = historyResult.rows.reverse().map(row => ({ role: row.role, content: row.content }));

    const userContent = imageBase64 ? [ { type: "text", text: message || "Что на этой картинке?" }, { type: "image_url", image_url: { url: imageBase64 } } ] : message;
    history[history.length - 1] = { role: 'user', content: userContent };
    
    const knowledgeRes = await db.execute('SELECT prompt_text FROM bot_knowledge ORDER BY id DESC LIMIT 1');
    const adminPrompt = knowledgeRes.rows.length > 0 ? knowledgeRes.rows[0].prompt_text : '';
    const systemPrompt = adminPrompt.trim() !== '' ? adminPrompt : 'Ты — БОБОР-AI, умный и дружелюбный ассистент. Отвечай на русском.';

    const messagesForAI = [ { role: 'system', content: systemPrompt }, ...history ];
    let model = imageFile ? 'glm-4.6v-flash' : 'glm-4.5-flash'; 
    
    const aiResponse = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.ZAI_API_KEY}` },
      body: JSON.stringify({ model: model, messages: messagesForAI, temperature: 0.7 })
    });

    if (!aiResponse.ok) throw new Error(`API вернул ${aiResponse.status}`);
    const aiData = await aiResponse.json();
    const replyText = aiData.choices[0].message.content;

    await db.execute({ sql: 'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)', args: [chatId, 'assistant', replyText] });
    res.json({ reply: replyText });

  } catch (error) { res.status(500).json({ error: 'Ошибка: ' + error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🦫 Бобор-AI запущен на порту ${PORT}`));
