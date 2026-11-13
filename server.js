const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Раздает index.html

// Настройка Turso (База данных памяти)
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Создаем таблицу при старте
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
    // 1. Сохраняем сообщение пользователя
    await db.execute({
      sql: "INSERT INTO messages (role, content) VALUES (?, ?)",
      args: ['user', message]
    });

    // 2. Достаем последние 20 сообщений (чтобы бот помнил контекст)
    const historyResult = await db.execute(
      "SELECT role, content FROM messages ORDER BY id DESC LIMIT 20"
    );
    const history = historyResult.rows.reverse().map(row => ({
      role: row.role,
      content: row.content
    }));

    // 3. Добавляем характер Бобора
    const messagesForAI = [
      { role: 'system', content: 'Ты — БОБОР-AI, умный, дружелюбный и немного юморной ассистент. Отвечай на русском языке, кратко и по делу.' },
      ...history
    ];

    // 4. Стучимся в DeepSeek API
    const aiResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` // Ключ из настроек Render
      },
      body: JSON.stringify({
        model: 'deepseek-chat', // Модель DeepSeek V3
        messages: messagesForAI,
        temperature: 0.7,
        max_tokens: 1000
      })
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      throw new Error(`DeepSeek API вернул ошибку: ${aiResponse.status} - ${errText}`);
    }

    const aiData = await aiResponse.json();
    const replyText = aiData.choices[0].message.content;

    // 5. Сохраняем ответ бота в память
    await db.execute({
      sql: "INSERT INTO messages (role, content) VALUES (?, ?)",
      args: ['assistant', replyText]
    });

    res.json({ reply: replyText });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Бобор задумался: ' + error.message });
  }
});

// Загрузка истории при открытии сайта
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
