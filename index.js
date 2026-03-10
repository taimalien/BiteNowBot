const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || "6408550462";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const sessions = {};

const STAGE = {
  IDLE: "idle",
  WAITING_CART: "waiting_cart",
  WAITING_ADDRESS: "waiting_address",
  WAITING_PHONE: "waiting_phone",
  WAITING_EMAIL: "waiting_email",
  DONE: "done",
};

const FAQ = [
  {
    keys: ["how", "work", "works"],
    reply: "simple 🔥 you send me your cart screenshot, i place the order, you pay 65% less than normal. that's it 💸"
  },
  {
    keys: ["save", "65", "percent"],
    reply: "we got the plug 🔌 don't worry about how, just know it works every time 😤"
  },
  {
    keys: ["pay", "payment", "cost", "price"],
    reply: "you pay after we confirm your order 🤝 we accept CashApp, Apple Pay, Zelle, or any crypto 💰"
  },
  {
    keys: ["restaurant", "restaurants", "where", "place", "places"],
    reply: "we do Domino's, Papa John's, Subway, Church's Chicken, Five Guys, Jersey Mike's, Panda Express, Auntie Anne's, Insomnia Cookies, Panera, Applebee's, Olive Garden, Jack in the Box, CAVA + more 🍕🍔🥡"
  },
  {
    keys: ["long", "fast", "time", "quick"],
    reply: "once you submit your order we move fast ⚡ Munchy gets on it immediately"
  },
  {
    keys: ["real", "legit", "scam", "trust", "safe"],
    reply: "100% legit no cap 🤞 Munchy been doing this, your order gets placed and you save real money every time"
  },
  {
    keys: ["hi", "hey", "hello", "sup", "yo", "hii", "heyy", "start"],
    reply: "yooo 👋 ready to save you some money today — send me your cart screenshot when you're ready 📸"
  },
];

function getScriptedReply(text) {
  const lower = text.toLowerCase();
  for (const faq of FAQ) {
    if (faq.keys.some(k => lower.includes(k))) {
      return faq.reply;
    }
  }
  return "send me your cart screenshot and let's get you that 65% off 📸🔥";
}

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      stage: STAGE.IDLE,
      cartFileId: null,
      address: null,
      phone: null,
      email: null,
      username: null,
    };
  }
  return sessions[chatId];
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function typing(chatId) {
  await axios.post(`${TELEGRAM_API}/sendChatAction`, {
    chat_id: chatId,
    action: "typing",
  }).catch(() => {});
}

async function send(chatId, text, ms = 1000, extra = {}) {
  await typing(chatId);
  await delay(ms);
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  }).catch(e => console.error("sendMessage error:", e?.response?.data));
}

async function forwardToOwner(session, chatId) {
  const caption =
    `🔥 <b>NEW ORDER — @BiteNowBot</b>\n\n` +
    `👤 Customer: ${session.username || chatId}\n` +
    `📍 Address: ${session.address}\n` +
    `📱 Phone: ${session.phone}\n` +
    `📧 Email: ${session.email}\n\n` +
    `💸 They're saving 65% off!\n\n` +
    `👉 Reply to them: t.me/${session.username?.replace("@", "") || chatId}`;

  if (session.cartFileId) {
    await axios.post(`${TELEGRAM_API}/sendPhoto`, {
      chat_id: OWNER_CHAT_ID,
      photo: session.cartFileId,
      caption,
      parse_mode: "HTML",
    }).catch(e => console.error("sendPhoto error:", e?.response?.data));
  } else {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: OWNER_CHAT_ID,
      text: caption,
      parse_mode: "HTML",
    }).catch(e => console.error("forwardToOwner error:", e?.response?.data));
  }
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const photo = msg.photo;
  const session = getSession(chatId);
  session.username = msg.from?.username
    ? `@${msg.from.username}`
    : msg.from?.first_name || String(chatId);

  try {

    // /start
    if (text === "/start") {
      session.stage = STAGE.WAITING_CART;
      session.cartFileId = null;
      session.address = null;
      session.phone = null;
      session.email = null;
      await send(chatId, "yooo 👋 welcome to 65% OFF EATS", 800);
      await send(chatId, "we place your order and you save 65% off 🔥 no cap", 1200);
      await send(chatId, "got questions? ask away — or just send your cart screenshot to get started 📸", 1400);
      return;
    }

    // Cart photo
    if (photo && session.stage === STAGE.WAITING_CART) {
      session.cartFileId = photo[photo.length - 1].file_id;
      session.stage = STAGE.WAITING_ADDRESS;
      await send(chatId, "oooh okay I see you 👀🔥", 700);
      await send(chatId, "got your cart, let's get this rolling", 1000);
      await send(chatId, "what's the delivery address? 📍", 1200);
      return;
    }

    // Address
    if (session.stage === STAGE.WAITING_ADDRESS && text) {
      session.address = text;
      session.stage = STAGE.WAITING_PHONE;
      await send(chatId, "bet 📌", 700);
      await send(chatId, "drop your phone number so we can update you 📱", 1000);
      return;
    }

    // Phone
    if (session.stage === STAGE.WAITING_PHONE && text) {
      session.phone = text;
      session.stage = STAGE.WAITING_EMAIL;
      await send(chatId, "perfect 📱", 700);
      await send(chatId, "last thing — your email for the confirmation 📧", 1000);
      return;
    }

    // Email
    if (session.stage === STAGE.WAITING_EMAIL && text) {
      session.email = text;
      session.stage = STAGE.DONE;

      await send(chatId, "you're all set! 🙌", 700);
      await send(chatId, "connecting you to Munchy right now... 🔌", 1200);
      await delay(2000);
      await send(chatId, "✅ Munchy accepted your order!", 1500);
      await delay(800);
      await send(
        chatId,
        `you're now connected with <b>Munchy</b> 👨‍🍳\n\nDM him directly to confirm your order and sort payment 👇\nt.me/Imunchy`,
        1200
      );
      await send(chatId, `he'll get you sorted and you're saving 65% 💸🔥`, 1000);

      // Forward to owner
      await forwardToOwner(session, chatId);

      // Reset
      session.stage = STAGE.WAITING_CART;
      session.cartFileId = null;
      session.address = null;
      session.phone = null;
      session.email = null;
      return;
    }

    // Photo at wrong time
    if (photo) {
      await send(chatId, "send /start first to kick off your order 👇", 800);
      return;
    }

    // Free chat
    if (text && [STAGE.IDLE, STAGE.WAITING_CART].includes(session.stage)) {
      const reply = getScriptedReply(text);
      await send(chatId, reply, 1000);
      return;
    }

    // Nudge
    if (session.stage === STAGE.WAITING_CART) {
      await send(chatId, "send me your cart screenshot to get started 📸", 900);
    }

  } catch (err) {
    console.error("Webhook error:", err?.message);
  }
});

app.get("/", (req, res) => res.send("@BiteNowBot is live 🔥"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`@BiteNowBot running on port ${PORT}`));
