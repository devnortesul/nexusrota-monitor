// Minimal Telegram sender for the GitHub Actions monitors.
// Sends an HTML message to the configured chat. Throws on API failure so the
// workflow step records the error (and the run shows red in Actions).

export async function sendTelegram(html) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID not set");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`telegram sendMessage HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
}

// Sends a file (e.g. the monthly PDF report) as a Telegram document.
export async function sendTelegramDocument(buffer, filename, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID not set");

  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  form.append("document", new Blob([buffer], { type: "application/pdf" }), filename);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`telegram sendDocument HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
}
