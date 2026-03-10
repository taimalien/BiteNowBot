const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || "6408550462";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

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

const crown = `<tg-emoji emoji-id="5368324170671202286">👑</tg-emoji>`;
const fire  = `<tg-emoji emoji-id="5370870672667374515">🔥</tg-emoji>`;
const money = `<tg-emoji emoji-id="5373141891321699086">💵</tg-emoji>`;
const check = `<tg-emoji emoji-id="5368324170671202286">✅</tg-emoji>`;
const star  = `<tg-emoji emoji-id="5370399154727416166">⭐</tg-emoji>`;
const bolt  = `<tg-emoji emoji-id="5371168276122820957">⚡</tg-emoji>`;
const lock  = `<tg-emoji emoji-id="5364240322202782916">🔒</tg-emoji>`;
const gift  = `<tg-emoji emoji-id="5372981976804366741">🎁</tg-emoji>`;

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
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTyping(chatId) {
  await axios.post(`${TELEGRAM_API}/sendChatAction`, {
    chat_id: chatId,
    action: "typing",
  }).catch(() => {});
}

async function send(chatId, text, pauseBefore = 800) {
  await delay(pauseBefore);
  await sendTyping(chatId);
  await delay(1000);
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  }).catch((e) => console.error("sendMessage error:", e?.response?.data));
}

async function forwardToOwner(session, chatId, user) {
  const freeNote = user.credits >= CREDITS_FOR_FREE_ORDER
    ? "\nFREE ORDER — credits applied\n" : "";

  const caption =
    `NEW ORDER — @BiteNowBot\n\n` +
    `Customer: ${session.username || chatId}\n` +
    `Address: ${session.fullAddress}\n` +
    `Phone: ${session.phone}\n` +
    `Email: ${session.email}\n` +
    `Credits: ${user.credits}${freeNote}\n\n` +
    `Saving 65%\n\n` +
    `Reply: t.me/${session.username?.replace("@", "") || chatId}`;

  if (session.cartFileId) {
    await axios.post(`${TELEGRAM_API}/sendPhoto`, {
      chat_id: OWNER_CHAT_ID,
      photo: session.cartFileId,
      caption,
      parse_mode: "HTML",
    }).catch((e) => console.error("sendPhoto error:", e?.response?.data));
  } else {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: OWNER_CHAT_ID,
      text: caption,
      parse_mode: "HTML",
    }).catch((e) => console.error("forwardToOwner error:", e?.response?.data));
  }
}

const FAQ = [
  {
    keys: ["how", "work", "works"],
    reply: `${bolt} Simple. You send your cart, we place the order. You pay 65% less. Every time.`,
  },
  {
    keys: ["save", "65", "percent", "discount"],
    reply: `${lock} We have access you don't. Don't worry about how — just know it works.`,
  },
  {
    keys: ["pay", "payment", "cost", "price"],
    reply: `${money} You pay after your order is confirmed. We accept CashApp, Apple Pay, Zelle, and crypto.`,
  },
  {
    keys: ["restaurant", "restaurants", "where", "place", "which"],
    reply: `${fire} We cover Dominos, Papa Johns, Subway, Churchs Chicken, Five Guys, Jersey Mikes, Panda Express, Auntie Annes, Insomnia Cookies, Panera, Applebees, Olive Garden, Jack in the Box, CAVA and more.`,
  },
  {
    keys: ["long", "fast", "time", "quick", "wait"],
    reply: `${bolt} Once your order is in, we move immediately. No delays on our end.`,
  },
  {
    keys: ["real", "legit", "scam", "trust", "safe", "fake"],
    reply: `${check} BiteNow is the real deal. Every order gets placed. Every customer saves. We don't play games.`,
  },
  {
    keys: ["refer", "referral", "invite", "link", "credits", "credit", "free"],
    reply: `${gift} Type /referral to get your personal invite link.\n\nEvery person you bring in who places an order earns you 3 credits.\n${crown} 6 credits = your next order is completely free.`,
  },
  {
    keys: ["hi", "hey", "hello", "sup", "yo", "hii", "heyy", "helo"],
    reply: `${crown} Welcome to BiteNow. Send your cart screenshot and we'll handle the rest.`,
  },
];

function getScriptedReply(text) {
  const lower = text.toLowerCase();
  for (const faq of FAQ) {
    if (faq.keys.some((k) => lower.includes(k))) return faq.reply;
  }
  return `${bolt} Send your cart screenshot and we'll get you 65% off.`;
}

app.get("/setup", async (req, res) => {
  try {
    await axios.post(`${TELEGRAM_API}/setMyCommands`, {
      commands: [
        { command: "start",    description: "Place an order — save 65%" },
        { command: "referral", description: "Get your referral link" },
        { command: "credits",  description: "Check your credit balance" },
      ],
    });
    await axios.post(`${TELEGRAM_API}/setChatMenuButton`, {
      menu_button: { type: "commands" },
    });
    res.send("Setup complete. Menu and commands registered.");
  } catch (e) {
    console.error(e?.response?.data);
    res.status(500).send("Setup failed.");
  }
});

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
    : msg.from?.first_name || String(chatId);

  try {
    if (text.startsWith("/start")) {
      const parts = text.split(" ");
      const refCode = parts[1] || null;

      if (refCode && refCode !== user.refCode && !user.referredBy) {
        const referrer = findUserByRefCode(refCode);
        if (referrer) user.referredBy = referrer[0];
      }

      resetSession(session);
      session.stage = STAGE.WAITING_CART;

      await send(chatId, `${crown} Welcome to BiteNow.`, 300);
      await send(chatId, `${fire} We place your food order and you pay 65% less. Every single time.`, 0);
      await send(chatId, `${bolt} Send your cart screenshot to get started.`, 0);
      return;
    }

    if (["/referral", "/refer", "/getlink"].includes(text)) {
      const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
      await send(
        chatId,
        `${gift} Your referral link:\nt.me/BiteNowBot?start=${user.refCode}\n\n${star} Every person you invite who places an order earns you 3 credits.\n${crown} 6 credits = your next order is completely free.\n\nYour credits: ${user.credits}\nCredits until free order: ${needed}`,
        300
      );
      return;
    }

    if (text === "/credits") {
      const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
      if (user.credits >= CREDITS_FOR_FREE_ORDER) {
        await send(chatId, `${gift} You have ${user.credits} credits — your next order is free. Place your order and it will be applied automatically.`, 300);
      } else {
        await send(chatId, `${star} You have ${user.credits} credits. You need ${needed} more for a free order.\n\nGet your referral link: /referral`, 300);
      }
      return;
    }

    if (photo && session.stage === STAGE.WAITING_CART) {
      session.cartFileId = photo[photo.length - 1].file_id;
      session.stage = STAGE.WAITING_ADDRESS;
      session.addressStep = "street";
      await send(chatId, `${check} Cart received. Let's get your details.`, 300);
      await send(chatId, `Street Address:`, 0);
      return;
    }

    if (session.stage === STAGE.WAITING_ADDRESS && text) {
      if (session.addressStep === "street") {
        session.address = text;
        session.addressStep = "apt";
        await send(chatId, `Apt or Unit number (type - to skip):`, 300);
        return;
      }
      if (session.addressStep === "apt") {
        const skip = ["-", "--", "none", "skip", "na", "n/a", "no"];
        session.addressLine2 = skip.includes(text.toLowerCase()) ? null : text;
        session.addressStep = "city";
        await send(chatId, `City:`, 300);
        return;
      }
      if (session.addressStep === "city") {
        session.city = text;
        session.addressStep = "state";
        await send(chatId, `State:`, 300);
        return;
      }
      if (session.addressStep === "state") {
        session.state = text;
        session.addressStep = "zip";
        await send(chatId, `ZIP Code:`, 300);
        return;
      }
      if (session.addressStep === "zip") {
        if (!/^\d{5}$/.test(text)) {
          await send(chatId, `Please enter a valid 5-digit ZIP code:`, 300);
          return;
        }
        session.zip = text;
        const apt = session.addressLine2 ? `, ${session.addressLine2}` : "";
        session.fullAddress = `${session.address}${apt}, ${session.city}, ${session.state} ${session.zip}`;
        session.stage = STAGE.WAITING_PHONE;
        await send(chatId, `${check} Got it.`, 300);
        await send(chatId, `Phone Number:`, 0);
        return;
      }
    }

    if (session.stage === STAGE.WAITING_PHONE && text) {
      session.phone = text;
      session.stage = STAGE.WAITING_EMAIL;
      await send(chatId, `${check} Got it.`, 300);
      await send(chatId, `Email Address:`, 0);
      return;
    }

    if (session.stage === STAGE.WAITING_EMAIL && text) {
      session.email = text;
      session.stage = STAGE.DONE;

      const isFreeOrder = user.credits >= CREDITS_FOR_FREE_ORDER;

      if (!user.hasOrdered && user.referredBy) {
        const referrer = getUser(user.referredBy);
        referrer.credits += CREDITS_PER_REFERRAL;
        const refNeeded = Math.max(0, CREDITS_FOR_FREE_ORDER - referrer.credits);
        await send(
          user.referredBy,
          `${star} Someone you referred just placed their first order.\n\n${gift} You earned 3 credits. Total: ${referrer.credits} credits.\n\n${
            referrer.credits >= CREDITS_FOR_FREE_ORDER
              ? `${crown} You now have a free order ready. Use it on your next order.`
              : `${bolt} ${refNeeded} more credits and your next order is free.`
          }`,
          300
        );
      }

      user.hasOrdered = true;
      if (isFreeOrder) user.credits -= CREDITS_FOR_FREE_ORDER;

      await send(chatId, `${check} You're all set.`, 300);
      await send(chatId, `${bolt} Connecting you to your order handler now...`, 0);
      await delay(2000);
      await send(chatId, `${crown} You're connected.\n\nDM directly to confirm your order and handle payment:\nt.me/Imunchy`, 0);

      if (isFreeOrder) {
        await send(chatId, `${gift} This one's on the house. Your 6 credits have been applied. Enjoy.`, 0);
      } else {
        await send(
          chatId,
          `${fire} You're saving 65% on this order.\n\n${star} Want your next one free?\nInvite people to BiteNow. Every person who orders through your link = 3 credits. 6 credits = free order.\n\nYour link:\nt.me/BiteNowBot?start=${user.refCode}`,
          0
        );
      }

      await forwardToOwner(session, chatId, user);
      resetSession(session);
      return;
    }

    if (photo) {
      await send(chatId, `Type /start to begin your order.`, 300);
      return;
    }

    if (text && [STAGE.IDLE, STAGE.WAITING_CART].includes(session.stage)) {
      await send(chatId, getScriptedReply(text), 300);
      return;
    }

    if (session.stage === STAGE.WAITING_CART) {
      await send(chatId, `${bolt} Send your cart screenshot to get started.`, 300);
    }

  } catch (err) {
    console.error("Webhook error:", err?.message);
  }
});

app.get("/", (req, res) => res.send("@BiteNowBot is live"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`@BiteNowBot running on port ${PORT}`));
