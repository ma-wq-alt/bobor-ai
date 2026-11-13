const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Чтобы отдавать index.html

// --- НАСТРОЙКА TURSO ---
// Эти переменные вы добавите в Render (Environment Variables)
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db', // Локально для теста
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Инициализация таблицы истории
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
initDB();

// --- API ЧАТА ---
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  try {
    // 1. Сохраняем сообщение пользователя в Turso
    await db.execute({
      sql: "INSERT INTO messages (role, content) VALUES (?, ?)",
      args: ['user', message]
    });

    // 2. Достаем последние 20 сообщений для контекста (память)
    const historyResult = await db.execute(
      "SELECT role, content FROM messages ORDER BY id DESC LIMIT 20"
    );
    // Переворачиваем, чтобы было от старых к новым
    const history = historyResult.rows.reverse().map(row => ({
      role: row.role,
      content: row.content
    }));

    // Добавляем системный промпт, чтобы бот знал, кто он
    const messagesForAI = [
      { role: 'system', content: 'Ты — БОБОР-AI, дружелюбный и немного юморной ассистент. Отвечай на русском.' },
      ...history
    ];

    // 3. Отправляем запрос в нейросеть (Pollinations, бесплатно)
    const aiResponse = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: messagesForAI,
        temperature: 0.7
      })
    });

    if (!aiResponse.ok) throw new Error(`AI Error: ${aiResponse.status}`);
    const aiData = await aiResponse.json();
    const replyText = aiData.choices[0].message.content;

    // 4. Сохраняем ответ бота в Turso
    await db.execute({
      sql: "INSERT INTO messages (role, content) VALUES (?, ?)",
      args: ['assistant', replyText]
    });

    res.json({ reply: replyText });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Бобор задумался или произошла ошибка памяти.' });
  }
});

// Эндпоинт для загрузки истории при старте
app.get('/api/history', async (req, res) => {
  try {
    const result = await db.execute("SELECT role, content FROM messages ORDER BY id ASC");
    res.json(result.rows);
  } catch (e) {
    res.json([]);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Бобор-AI сервер запущен на порту ${PORT}`));
