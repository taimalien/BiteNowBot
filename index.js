const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || "6408550462";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// In-memory stores
const sessions = {};
const users = {};

const STAGE = {
  IDLE: "idle",
  WAITING_CART: "waiting_cart",
  WAITING_ADDRESS: "waiting_address",
  WAITING_PHONE: "waiting_phone",
  WAITING_EMAIL: "waiting_email",
  DONE: "done",
};

const CREDITS_PER_REFERRAL = 3;
const CREDITS_FOR_FREE_ORDER = 6;

function getUser(chatId) {
  if (!users[chatId]) {
    users[chatId] = {
      credits: 0,
      referredBy: null,
      hasOrdered: false,
      refCode: `REF${chatId}`,
    };
  }
  return users[chatId];
}

function findUserByRefCode(code) {
  return Object.entries(users).find(([, u]) => u.refCode === code);
}

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      stage: STAGE.IDLE,
      cartFileId: null,
      address: null,
      addressLine2: null,
      city: null,
      state: null,
      zip: null,
      fullAddress: null,
      phone: null,
      email: null,
      username: null,
      addressStep: "street",
    };
  }
  return sessions[chatId];
}

function resetSession(session) {
  session.stage = STAGE.WAITING_CART;
  session.cartFileId = null;
  session.address = null;
  session.addressLine2 = null;
  session.city = null;
  session.state = null;
  session.zip = null;
  session.fullAddress = null;
  session.phone = null;
  session.email = null;
  session.addressStep = "street";
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

async function send(chatId, text, ms = 1000) {
  await typing(chatId);
  await delay(ms);
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  }).catch(e => console.error("sendMessage error:", e?.response?.data));
}

async function forwardToOwner(session, chatId, user) {
  const freeNote = user.credits >= CREDITS_FOR_FREE_ORDER
    ? "\nFREE ORDER - customer has enough credits!\n" : "";
  const caption =
    `NEW ORDER - @BiteNowBot\n\n` +
    `Customer: ${session.username || chatId}\n` +
    `Address: ${session.fullAddress || session.address}\n` +
    `Phone: ${session.phone}\n` +
    `Email: ${session.email}\n` +
    `Credits: ${user.credits}${freeNote}\n\n` +
    `They are saving 65% off!\n\n` +
    `Reply: t.me/${session.username?.replace("@", "") || chatId}`;

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

const FAQ = [
  { keys: ["how", "work", "works"], reply: "simple — you send your cart screenshot, we place the order, you pay 65% less. that is it." },
  { keys: ["save", "65", "percent"], reply: "we got the plug. do not worry about how, just know it works every time." },
  { keys: ["pay", "payment", "cost", "price"], reply: "you pay after we confirm your order. we accept CashApp, Apple Pay, Zelle, or any crypto." },
  { keys: ["restaurant", "restaurants", "where", "place"], reply: "we do Domino's, Papa John's, Subway, Church's Chicken, Five Guys, Jersey Mike's, Panda Express, Auntie Anne's, Insomnia Cookies, Panera, Applebee's, Olive Garden, Jack in the Box, CAVA and more." },
  { keys: ["long", "fast", "time", "quick"], reply: "once you submit your order we move fast. Munchy gets on it immediately." },
  { keys: ["real", "legit", "scam", "trust", "safe"], reply: "100% legit. Munchy been doing this. your order gets placed and you save real money every time." },
  { keys: ["refer", "referral", "invite", "link", "credits", "credit"], reply: "type /referral to get your personal invite link. you get 3 credits every time someone orders using your link. 6 credits = free order." },
  { keys: ["hi", "hey", "hello", "sup", "yo"], reply: "yooo welcome. send your cart screenshot to get started." },
];

function getScriptedReply(text) {
  const lower = text.toLowerCase();
  for (const faq of FAQ) {
    if (faq.keys.some(k => lower.includes(k))) return faq.reply;
  }
  return "send your cart screenshot and we will get you that 65% off.";
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  const photo = msg.photo;
  const session = getSession(chatId);
  const user = getUser(chatId);

  session.username = msg.from?.username
    ? `@${msg.from.username}`
    : msg.from?.first_name || chatId;

  try {

    // /start with optional referral code
    if (text.startsWith("/start")) {
      const refCode = text.split(" ")[1] || null;
      if (refCode && refCode !== user.refCode && !user.referredBy) {
        const referrer = findUserByRefCode(refCode);
        if (referrer) user.referredBy = referrer[0];
      }
      resetSession(session);
      await send(chatId, "yooo welcome to 65% OFF EATS", 800);
      await send(chatId, "we place your order and you save 65% off no cap", 1200);
      await send(chatId, "send your cart screenshot to get started", 1400);
      return;
    }

    // /referral
    if (text === "/referral") {
      const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
      await send(
        chatId,
        `your referral link:\nt.me/BiteNowBot?start=${user.refCode}\n\nshare this with friends. when they place an order you get 3 credits.\n\nyour credits: ${user.credits}\ncredits needed for a free order: ${needed}`,
        800
      );
      return;
    }

    // /credits
    if (text === "/credits") {
      const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
      if (user.credits >= CREDITS_FOR_FREE_ORDER) {
        await send(chatId, `you have ${user.credits} credits — you have a FREE ORDER ready! place your order and Munchy will apply it.`, 800);
      } else {
        await send(chatId, `you have ${user.credits} credits. you need ${needed} more for a free order.\n\nget your referral link: /referral`, 800);
      }
      return;
    }

    // Cart photo
    if (photo && session.stage === STAGE.WAITING_CART) {
      session.cartFileId = photo[photo.length - 1].file_id;
      session.stage = STAGE.WAITING_ADDRESS;
      session.addressStep = "street";
      await send(chatId, "got your cart, let's get this rolling", 800);
      await send(chatId, "Street Address:", 1000);
      return;
    }

    // Address steps
    if (session.stage === STAGE.WAITING_ADDRESS && text) {
      if (session.addressStep === "street") {
        session.address = text;
        session.addressStep = "apt";
        await send(chatId, "Apt / Unit # (type N/A if none):", 800);
        return;
      }
      if (session.addressStep === "apt") {
        session.addressLine2 = text;
        session.addressStep = "city";
        await send(chatId, "City:", 800);
        return;
      }
      if (session.addressStep === "city") {
        session.city = text;
        session.addressStep = "state";
        await send(chatId, "State:", 800);
        return;
      }
      if (session.addressStep === "state") {
        session.state = text;
        session.addressStep = "zip";
        await send(chatId, "ZIP Code:", 800);
        return;
      }
      if (session.addressStep === "zip") {
        if (!/^\d{5}$/.test(text)) {
          await send(chatId, "Please enter a valid 5-digit ZIP code:", 800);
          return;
        }
        session.zip = text;
        const apt = session.addressLine2 && session.addressLine2.toUpperCase() !== "N/A"
          ? `, ${session.addressLine2}` : "";
        session.fullAddress = `${session.address}${apt}, ${session.city}, ${session.state} ${session.zip}`;
        session.stage = STAGE.WAITING_PHONE;
        await send(chatId, "got it", 700);
        await send(chatId, "Phone Number:", 1000);
        return;
      }
    }

    // Phone
    if (session.stage === STAGE.WAITING_PHONE && text) {
      session.phone = text;
      session.stage = STAGE.WAITING_EMAIL;
      await send(chatId, "got it", 700);
      await send(chatId, "Email Address:", 1000);
      return;
    }

    // Email — complete order
    if (session.stage === STAGE.WAITING_EMAIL && text) {
      session.email = text;
      session.stage = STAGE.DONE;

      const isFreeOrder = user.credits >= CREDITS_FOR_FREE_ORDER;

      // Award referral credits to referrer on first order
      if (!user.hasOrdered && user.referredBy) {
        const referrer = getUser(user.referredBy);
        referrer.credits += CREDITS_PER_REFERRAL;
        const refNeeded = Math.max(0, CREDITS_FOR_FREE_ORDER - referrer.credits);
        await send(
          user.referredBy,
          `someone just ordered using your referral link!\n\nyou earned 3 credits. your total: ${referrer.credits} credits.\n\n${referrer.credits >= CREDITS_FOR_FREE_ORDER ? "you now have a FREE ORDER ready! place your next order to use it." : `${refNeeded} more credits until your free order.`}`,
          500
        );
      }

      user.hasOrdered = true;
      if (isFreeOrder) user.credits -= CREDITS_FOR_FREE_ORDER;

      await send(chatId, "you are all set", 700);
      await send(chatId, "connecting you to Munchy right now...", 1200);
      await delay(2000);
      await send(chatId, "Munchy accepted your order", 1500);
      await delay(800);
      await send(chatId, `you are now connected with Munchy\n\nDM him directly to confirm your order and sort payment\nt.me/Imunchy`, 1200);

      if (isFreeOrder) {
        await send(chatId, "this order is on the house — your 6 credits have been applied. enjoy your free order!", 1000);
      } else {
        await send(chatId, `you are saving 65% on this order\n\nearn free orders by referring friends:\nt.me/BiteNowBot?start=${user.refCode}`, 1200);
      }

      await forwardToOwner(session, chatId, user);
      resetSession(session);
      return;
    }

    // Photo at wrong stage
    if (photo) {
      await send(chatId, "type /start first to begin your order", 800);
      return;
    }

    // Free chat
    if (text && [STAGE.IDLE, STAGE.WAITING_CART].includes(session.stage)) {
      await send(chatId, getScriptedReply(text), 1000);
      return;
    }

    // Nudge
    if (session.stage === STAGE.WAITING_CART) {
      await send(chatId, "send your cart screenshot to get started", 900);
    }

  } catch (err) {
    console.error("Webhook error:", err?.message);
  }
});

app.get("/", (req, res) => res.send("@BiteNowBot is live"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`@BiteNowBot running on port ${PORT}`));
