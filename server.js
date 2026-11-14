const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const WebSocket = require('ws');

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
const BANK_WS_URL = process.env.BANK_URL || 'wss://bobor-bank.onrender.com';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER || '', pass: process.env.EMAIL_PASS || '' }
});

async function fetchWithRetry(url, options, retries = 3, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    console.log(`⚠️ 429 лимит, ждем ${delay}мс...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error('Превышен лимит запросов к Z.ai. Подожди минуту.');
}

async function initDB() {
  try {
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
    
    try { await db.execute('SELECT memory_facts FROM users LIMIT 1'); } 
    catch (e) { if (e.message.includes('no such column')) await db.execute('ALTER TABLE users ADD COLUMN memory_facts TEXT DEFAULT ""'); }

    try { await db.execute('SELECT ai_free_left FROM users LIMIT 1'); } 
    catch (e) { 
      if (e.message.includes('no such column')) {
        console.log('⚠️ Создаю колонку ai_free_left...');
        await db.execute('ALTER TABLE users ADD COLUMN ai_free_left INTEGER DEFAULT 20');
      } 
    }

    try { await db.execute('SELECT ai_sub_until FROM users LIMIT 1'); } 
    catch (e) { 
      if (e.message.includes('no such column')) {
        console.log('⚠️ Создаю колонку ai_sub_until...');
        await db.execute('ALTER TABLE users ADD COLUMN ai_sub_until DATETIME DEFAULT NULL');
      } 
    }

    await db.execute(`CREATE TABLE IF NOT EXISTS bot_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt_text TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT, pinned INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id))`);
    try { await db.execute('SELECT pinned FROM chats LIMIT 1'); } 
    catch (e) { if (e.message.includes('no such column')) await db.execute('ALTER TABLE chats ADD COLUMN pinned INTEGER DEFAULT 0'); }
    await db.execute(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, image_url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(chat_id) REFERENCES chats(id))`);
    
    const adminEmail = 'mar.maks999@gmail.com';
    const adminCheck = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [adminEmail] });
    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash('1495', 10);
      await db.execute({ sql: 'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)', args: ['hank', adminEmail, hash, 'admin'] });
    }
    console.log('✅ База данных готова');
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

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ? OR email = ?', args: [username, username] });
    const user = result.rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const token = jwt.sign({ id: user.id, email: user.email, username: user.username, role: user.role, theme: user.theme, language: user.language }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role, theme: user.theme || 'dark', language: user.language || 'ru' });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
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
      await db.execute({ sql: 'INSERT INTO users (email, username, role, otp_code, otp_expires) VALUES (?, ?, ?, ?, ?)', args: [email, baseUsername, 'user', otp, expires] });
    } else {
      await db.execute({ sql: 'UPDATE users SET otp_code = ?, otp_expires = ? WHERE email = ?', args: [otp, expires, email] });
    }

    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      await transporter.sendMail({
        from: '"БОБОР ПРОДАКШН" <' + process.env.EMAIL_USER + '>',
        to: email, subject: 'БОБОР: Ваш код доступа',
        html: `<div style="font-family: Arial; background: #0f0c29; color: #fff; padding: 20px; border-radius: 10px;"><h2>Ваш код: <b style="font-size: 24px; color: #a78bfa;">${otp}</b></h2></div>`
      });
      res.json({ success: true, message: 'Код отправлен на почту!' });
    } else {
      console.log(`\n========================================\n🚀 КОД ДЛЯ ${email}: ${otp}\n========================================\n`);
      res.json({ success: true, message: 'Код в логах Render (почта не настроена).' });
    }
  } catch (err) { res.status(500).json({ error: 'Ошибка отправки' }); }
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
    const token = jwt.sign({ id: user.id, email: user.email, username: user.username, role: user.role, theme: user.theme, language: user.language }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role, theme: user.theme || 'dark', language: user.language || 'ru' });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/user/settings', authMiddleware, async (req, res) => {
  const { username, theme, language } = req.body;
  try {
    await db.execute({ sql: 'UPDATE users SET username = ?, theme = ?, language = ? WHERE id = ?', args: [username, theme, language, req.user.id] });
    const newToken = jwt.sign({ id: req.user.id, email: req.user.email, username, role: req.user.role, theme, language }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token: newToken, username, theme, language });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Этот ник уже занят' });
    res.status(500).json({ error: err.message });
  }
});

// --- API ДЛЯ БАНКА (ВЫДАЧА ПОДПИСКИ) ---
app.post('/api/vip/activate', async (req, res) => {
  const { bankUserId, token } = req.body;
  try {
    const decoded = jwt.verify(token, 'secret-bank-key');
    if (decoded.userId !== bankUserId) return res.status(403).json({ error: 'Неверный токен банка' });
    
    const userRes = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [decoded.email || ''] });
    if (userRes.rows.length > 0) {
       const baseDate = new Date();
       baseDate.setDate(baseDate.getDate() + 30);
       await db.execute({ sql: 'UPDATE users SET ai_sub_until = ? WHERE email = ?', args: [baseDate.toISOString(), decoded.email] });
    }
    res.json({ success: true });
  } catch (e) { res.status(401).json({ error: 'Неверный токен' }); }
});

app.get('/api/user/limits', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT ai_free_left, ai_sub_until FROM users WHERE email = ?', args: [req.user.email] });
    const data = result.rows[0];
    res.json({ ai_free_left: data?.ai_free_left ?? 20, ai_sub_until: data?.ai_sub_until || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bot/knowledge', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только для админа' });
  try {
    const result = await db.execute('SELECT prompt_text FROM bot_knowledge ORDER BY id DESC LIMIT 1');
    res.json({ prompt: result.rows.length > 0 ? result.rows[0].prompt_text : '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bot/knowledge', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только для админа' });
  const { prompt } = req.body;
  try {
    await db.execute('DELETE FROM bot_knowledge');
    await db.execute({ sql: 'INSERT INTO bot_knowledge (prompt_text) VALUES (?)', args: [prompt] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM chats WHERE user_id = ? ORDER BY pinned DESC, created_at DESC', args: [req.user.id] });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'INSERT INTO chats (user_id, title) VALUES (?, ?) RETURNING id', args: [req.user.id, 'Новый чат'] });
    res.json({ chatId: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/chats/:chatId', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  try {
    await db.execute({ sql: 'DELETE FROM messages WHERE chat_id = ?', args: [chatId] });
    await db.execute({ sql: 'DELETE FROM chats WHERE id = ? AND user_id = ?', args: [chatId, req.user.id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/chats/:chatId', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  const { title } = req.body;
  try {
    await db.execute({ sql: 'UPDATE chats SET title = ? WHERE id = ? AND user_id = ?', args: [title, chatId, req.user.id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/chats/:chatId/pin', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  try {
    const check = await db.execute({ sql: 'SELECT pinned FROM chats WHERE id = ? AND user_id = ?', args: [chatId, req.user.id] });
    const newPinned = check.rows[0].pinned === 1 ? 0 : 1;
    await db.execute({ sql: 'UPDATE chats SET pinned = ? WHERE id = ?', args: [newPinned, chatId] });
    res.json({ success: true, pinned: newPinned });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  try {
    const result = await db.execute({ sql: 'SELECT role, content, image_url FROM messages WHERE chat_id = ? ORDER BY id ASC', args: [chatId] });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chats/:chatId/message', authMiddleware, upload.single('image'), async (req, res) => {
  const { chatId } = req.params;
  const { message, mode } = req.body; 
  const imageFile = req.file;

  try {
    // ПРОВЕРКА ЛИМИТА (Админ не тратит лимиты)
    const userCheck = await db.execute({ sql: 'SELECT ai_free_left, ai_sub_until, role FROM users WHERE email = ?', args: [req.user.email] });
    const userData = userCheck.rows[0];
    
    if (userData) {
      const isAdmin = req.user.role === 'admin' || userData.role === 'admin';
      const hasSub = userData.ai_sub_until && new Date(userData.ai_sub_until) > new Date();
      
      if (!isAdmin && !hasSub) {
        if ((userData.ai_free_left ?? 0) <= 0) {
          return res.status(403).json({ error: 'Лимит бесплатных запросов исчерпан. Оплатите подписку!' });
        }
        await db.execute({ sql: 'UPDATE users SET ai_free_left = ai_free_left - 1 WHERE email = ?', args: [req.user.email] });
      }
    }

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

    // 1. ГЕНЕРАЦИЯ КАРТИНКИ (С ПРОВЕРКОЙ ЛИМИТА POLLINATIONS)
    const isDrawRequest = /нарисуй|сгенерируй|сделай|покажи|создай|картинку|изображение/i.test(message || '');
    if (isDrawRequest && !imageFile) {
      const prompt = message.replace(/нарисуй|сгенерируй|сделай|покажи|создай|картинку|изображение|мне|пожалуйста/gi, '').trim();
      
      try {
        const checkUrl = `https://image.pollinations.ai/prompt/test?width=1280&height=1280&nologo=true&enhance=true&nofeed=true`;
        const checkRes = await fetch(checkUrl, { method: 'HEAD' });
        
        if (checkRes.status === 402 || checkRes.status === 429) {
           return res.json({ reply: '🎨 Лимит генерации картинок исчерпан. Подожди 45 секунд и попробуй снова (это ограничение бесплатного тарифа Pollinations).' });
        }

        const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1280&height=1280&nologo=true&enhance=true&nofeed=true`;
        const replyText = `🎨 Вот твоя картинка: "${prompt}"`;
        await db.execute({ sql: 'INSERT INTO messages (chat_id, role, content, image_url) VALUES (?, ?, ?, ?)', args: [chatId, 'assistant', replyText, pollUrl] });
        return res.json({ reply: replyText, imageUrl: pollUrl });
      } catch (e) {
        return res.json({ reply: '🎨 Не удалось связаться с сервисом картинок. Попробуй позже.' });
      }
    }

    // 2. ГЕНЕРАЦИЯ ВИДЕО
    if (/видео|video|сделай/i.test(message || '')) {
      const prompt = message.replace(/видео|video|сгенерируй|создай|сделай|про/gi, '').trim();
      if (!prompt) return res.json({ reply: 'Напиши, какое видео ты хочешь сгенерировать.' });

      if (!process.env.AGNES_API_KEY) {
         return res.json({ reply: '🎬 Ошибка: API-ключ для видео (AGNES_API_KEY) не настроен в Render.' });
      }

      try {
        const agnesRes = await fetch('https://apihub.agnes-ai.com/v1/videos', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.AGNES_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'agnes-video-2.5-flash', prompt: prompt, seconds: '5', mode: 'text', size: '720P', aspect_ratio: '16:9' })
        });
        
        if (!agnesRes.ok) {
           const errText = await agnesRes.text();
           throw new Error(`Agnes API вернул ${agnesRes.status}: ${errText}`);
        }
        
        const agnesData = await agnesRes.json();
        const videoId = agnesData.video_id || agnesData.id;
        if (!videoId) throw new Error('Agnes не вернул ID видео');

        let videoUrl = null;
        let attempts = 0;
        while (attempts < 90) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const statusRes = await fetch(`https://apihub.agnes-ai.com/agnesapi?video_id=${videoId}&model_name=agnes-video-2.5-flash`, { headers: { 'Authorization': `Bearer ${process.env.AGNES_API_KEY}` } });
          if (!statusRes.ok) { attempts++; continue; }
          const statusData = await statusRes.json();
          
          if (statusData.status === 'completed') { videoUrl = statusData.url; break; }
          else if (statusData.status === 'failed') throw new Error('Agnes AI не смог сгенерировать видео');
          attempts++;
        }
        
        if (!videoUrl) {
           return res.json({ reply: `🎬 Видео все еще генерируется. Проверь позже: https://apihub.agnes-ai.com/agnesapi?video_id=${videoId}&model_name=agnes-video-2.5-flash` });
        }
        
        const replyText = `🎬 Вот твое видео: "${prompt}"`;
        await db.execute({ sql: 'INSERT INTO messages (chat_id, role, content, image_url) VALUES (?, ?, ?, ?)', args: [chatId, 'assistant', replyText, videoUrl] });
        return res.json({ reply: replyText, imageUrl: videoUrl });

      } catch (videoErr) { 
        console.error('Ошибка видео:', videoErr);
        return res.json({ reply: '🎬 Ошибка генерации видео: ' + videoErr.message }); 
      }
    }

    // 3. ПАМЯТЬ (RAG)
    if (message && !imageFile && message.length > 10) {
      try {
        const memoryCheck = await fetchWithRetry('https://api.z.ai/api/paas/v4/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.ZAI_API_KEY}` },
          body: JSON.stringify({
            model: 'glm-4.5-flash',
            messages: [
              { role: 'system', content: 'Выдели из сообщения факты о пользователе (имя, хобби, предпочтения). Кратко. Если нет — "НЕТ".' },
              { role: 'user', content: message }
            ],
            max_tokens: 100, temperature: 0
          })
        });
        const memData = await memoryCheck.json();
        let fact = memData.choices[0].message.content.trim();
        
        if (fact !== "НЕТ" && fact.length > 3) {
          const userRes = await db.execute({ sql: 'SELECT memory_facts FROM users WHERE id = ?', args: [req.user.id] });
          let currentFacts = userRes.rows[0].memory_facts || '';
          if (!currentFacts.includes(fact)) {
            const newFacts = currentFacts ? currentFacts + '. ' + fact : fact;
            await db.execute({ sql: 'UPDATE users SET memory_facts = ? WHERE id = ?', args: [newFacts, req.user.id] });
            console.log('🧠 Запомнил факт:', fact);
          }
        }
      } catch (e) { console.log('Ошибка памяти:', e.message); }
    }

    // --- БЕСПЛАТНЫЙ ПОИСК В ИНТЕРНЕТЕ (ai-first-search) ---
    let externalInfo = "";
    if (/погода|новости|курс|доллар|евро|что случилось|найди|погугли|актуальн/i.test(message || '')) {
      try {
        const searchQuery = encodeURIComponent(message);
        const searchRes = await fetch(`https://ai-first-search.onrender.com/search?q=${searchQuery}&k=3&max_tokens=800`);
        
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          if (searchData.results && searchData.results.length > 0) {
            const texts = searchData.results
              .filter(r => r.ok && r.markdown)
              .map(r => `Источник: ${r.title}\n${r.markdown}`)
              .join('\n\n');
            
            if (texts) {
              externalInfo = texts;
              console.log('🌐 Найдена инфа в интернете для:', message);
            }
          }
        }
      } catch (e) { console.log('Ошибка бесплатного поиска:', e.message); }
    }

    const historyResult = await db.execute({ sql: 'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 20', args: [chatId] });
    const history = historyResult.rows.reverse().map(row => ({ role: row.role, content: row.content }));

    const userContent = imageBase64 ? [ { type: "text", text: message || "Что на картинке?" }, { type: "image_url", image_url: { url: imageBase64 } } ] : message;
    history[history.length - 1] = { role: 'user', content: userContent };
    
    const knowledgeRes = await db.execute('SELECT prompt_text FROM bot_knowledge ORDER BY id DESC LIMIT 1');
    const adminPrompt = knowledgeRes.rows.length > 0 ? knowledgeRes.rows[0].prompt_text : '';
    const userMemoryRes = await db.execute({ sql: 'SELECT memory_facts FROM users WHERE id = ?', args: [req.user.id] });
    const userMemory = userMemoryRes.rows[0]?.memory_facts || '';

    let systemPrompt = adminPrompt.trim() !== '' ? adminPrompt : 'Ты — БОБОР-AI, умный и дружелюбный ассистент. Отвечай на русском.';
    if (userMemory) systemPrompt += `\n\nТы знаешь о пользователе: ${userMemory}`;
    
    if (externalInfo) {
      systemPrompt += `\n\n--- СВЕЖАЯ ИНФОРМАЦИЯ ИЗ ИНТЕРНЕТА ---\n${externalInfo}\n--- КОНЕЦ ИНФОРМАЦИИ ---\n\nИспользуй эту информацию, чтобы ответить пользователю. Если информация не по теме, просто проигнорируй её.`;
    }

    const messagesForAI = [ { role: 'system', content: systemPrompt }, ...history ];
    let model = imageFile ? 'glm-4.6v-flash' : 'glm-4.5-flash'; 
    
    const aiResponse = await fetchWithRetry('https://api.z.ai/api/paas/v4/chat/completions', {
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
