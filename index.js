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

async function send(chatId, text) {
  await sendTyping(chatId);
  await delay(1500);
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  }).catch((e) => console.error("sendMessage error:", e?.response?.data));
  await delay(500);
}

async function forwardMsgToOwner(chatId, username, label, content) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: OWNER_CHAT_ID,
    text: `— ${username} (${chatId})\n[${label}]: ${content}\n\n/reply ${chatId} your message`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  }).catch(() => {});
}

async function forwardPhotoToOwner(chatId, username, fileId, label) {
  await axios.post(`${TELEGRAM_API}/sendPhoto`, {
    chat_id: OWNER_CHAT_ID,
    photo: fileId,
    caption: `— ${username} (${chatId})\n[${label}]\n\n/reply ${chatId} your message`,
  }).catch(() => {});
}

async function forwardToOwner(session, chatId, user) {
  const freeNote = user.credits >= CREDITS_FOR_FREE_ORDER
    ? "\nFREE ORDER — credits applied\n" : "";

  const caption =
    `— NEW ORDER —\n\n` +
    `Customer: ${session.username || chatId}\n` +
    `Address: ${session.fullAddress}\n` +
    `Phone: ${session.phone}\n` +
    `Email: ${session.email}\n` +
    `Credits: ${user.credits}${freeNote}\n\n` +
    `Saving 65%\n\n` +
    `t.me/${session.username?.replace("@", "") || chatId}\n` +
    `/reply ${chatId} your message`;

  if (session.cartFileId) {
    await axios.post(`${TELEGRAM_API}/sendPhoto`, {
      chat_id: OWNER_CHAT_ID,
      photo: session.cartFileId,
      caption,
    }).catch((e) => console.error("sendPhoto error:", e?.response?.data));
  } else {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: OWNER_CHAT_ID,
      text: caption,
    }).catch((e) => console.error("forwardToOwner error:", e?.response?.data));
  }
}

const FAQ = [
  {
    keys: ["how", "work", "works"],
    reply: `◆ You send the cart. We place the order. You pay 65% less.\n\nNo catch. No gimmick. Just results.`,
  },
  {
    keys: ["save", "65", "percent", "discount"],
    reply: `◆ We have access you don't.\n\nDon't worry about how — just know it works every time.`,
  },
  {
    keys: ["pay", "payment", "cost", "price"],
    reply: `◆ You pay after the order is confirmed.\n\nCashApp ◇ Apple Pay ◇ Zelle ◇ Crypto`,
  },
  {
    keys: ["restaurant", "restaurants", "where", "place", "which"],
    reply: `◆ We cover:\n\nDominos ◇ Papa Johns ◇ Subway ◇ Churchs Chicken ◇ Five Guys ◇ Jersey Mikes ◇ Panda Express ◇ Auntie Annes ◇ Insomnia Cookies ◇ Panera ◇ Applebees ◇ Olive Garden ◇ Jack in the Box ◇ CAVA ◇ Shipleys Do-Nuts ◇ 85C Bakery Cafe ◇ Gyro Hut ◇ Main Bird Hot Chicken ◇ Urban Bird Hot Chicken\n\n◇ and more.`,
  },
  {
    keys: ["long", "fast", "time", "quick", "wait"],
    reply: `◆ Order goes in, we move. No delays on our end.`,
  },
  {
    keys: ["real", "legit", "scam", "trust", "safe", "fake"],
    reply: `◆ BiteNow doesn't miss.\n\nEvery order placed. Every customer saves. We don't operate any other way.`,
  },
  {
    keys: ["refer", "referral", "invite", "link", "credits", "credit", "free"],
    reply: `◆ Type /referral to get your link.\n\nEvery person you bring in who orders → 3 credits.\n6 credits → your next order is free.`,
  },
  {
    keys: ["hi", "hey", "hello", "sup", "yo", "hii", "heyy", "helo", "wsg", "wsp"],
    reply: `◆ Welcome to BiteNow.\n\nSend your cart screenshot and we handle the rest.`,
  },
];

function getScriptedReply(text) {
  const lower = text.toLowerCase();
  for (const faq of FAQ) {
    if (faq.keys.some((k) => lower.includes(k))) return faq.reply;
  }
  return `◆ Send your cart screenshot and we'll take it from there.`;
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
    res.send("Setup complete.");
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

  // Owner /reply command
  if (chatId === OWNER_CHAT_ID && text.startsWith("/reply ")) {
    const parts = text.split(" ");
    const targetId = parts[1];
    const replyText = parts.slice(2).join(" ");
    if (targetId && replyText) {
      await send(targetId, replyText);
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: OWNER_CHAT_ID,
        text: `◆ Sent to ${targetId}.`,
      }).catch(() => {});
    }
    return;
  }

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

      await forwardMsgToOwner(chatId, session.username, "SESSION STARTED", "/start");

      await send(chatId, `◆ Welcome to BiteNow.`);
      await send(chatId, `We place your order. You pay 65% less.\n\nEvery. Single. Time.`);
      await send(chatId, `◇ Send your cart screenshot to get started.`);
      return;
    }

    if (["/referral", "/refer", "/getlink"].includes(text)) {
      const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
      await forwardMsgToOwner(chatId, session.username, "COMMAND", "/referral");
      await send(
        chatId,
        `◆ Your referral link:\nt.me/BiteNowBot?start=${user.refCode}\n\n◇ Every person you bring in who orders → 3 credits\n◇ 6 credits → your next order is free\n\nCredits: ${user.credits}\nNeeded: ${needed}`
      );
      return;
    }

    if (text === "/credits") {
      const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
      await forwardMsgToOwner(chatId, session.username, "COMMAND", "/credits");
      if (user.credits >= CREDITS_FOR_FREE_ORDER) {
        await send(chatId, `◆ You have ${user.credits} credits.\n\nYour next order is free. Place it and we'll apply them.`);
      } else {
        await send(chatId, `◆ You have ${user.credits} credits.\n\n${needed} more and your next order is on us.\n\n/referral`);
      }
      return;
    }

    // Forward every customer message to owner
    if (text && chatId !== OWNER_CHAT_ID) {
      await forwardMsgToOwner(chatId, session.username, "MSG", text);
    }

    if (photo && session.stage === STAGE.WAITING_CART) {
      session.cartFileId = photo[photo.length - 1].file_id;
      session.stage = STAGE.WAITING_ADDRESS;
      session.addressStep = "street";

      await forwardPhotoToOwner(chatId, session.username, session.cartFileId, "CART SCREENSHOT");

      await send(chatId, `◆ Received.\n\nLet's get your details locked in.`);
      await send(chatId, `Street Address:`);
      return;
    }

    if (session.stage === STAGE.WAITING_ADDRESS && text) {
      if (session.addressStep === "street") {
        session.address = text;
        session.addressStep = "apt";
        await send(chatId, `Apt or Unit # (type - to skip):`);
        return;
      }
      if (session.addressStep === "apt") {
        const skip = ["-", "--", "none", "skip", "na", "n/a", "no"];
        session.addressLine2 = skip.includes(text.toLowerCase()) ? null : text;
        session.addressStep = "city";
        await send(chatId, `City:`);
        return;
      }
      if (session.addressStep === "city") {
        session.city = text;
        session.addressStep = "state";
        await send(chatId, `State:`);
        return;
      }
      if (session.addressStep === "state") {
        session.state = text;
        session.addressStep = "zip";
        await send(chatId, `ZIP Code:`);
        return;
      }
      if (session.addressStep === "zip") {
        if (!/^\d{5,6}$/.test(text)) {
          await send(chatId, `Enter a valid ZIP code:`);
          return;
        }
        session.zip = text;
        const apt = session.addressLine2 ? `, ${session.addressLine2}` : "";
        session.fullAddress = `${session.address}${apt}, ${session.city}, ${session.state} ${session.zip}`;
        session.stage = STAGE.WAITING_PHONE;
        await send(chatId, `◆ Got it.\n\nPhone Number:`);
        return;
      }
    }

    if (session.stage === STAGE.WAITING_PHONE && text) {
      session.phone = text;
      session.stage = STAGE.WAITING_EMAIL;
      await send(chatId, `◆ Got it.\n\nEmail Address:`);
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
          `◆ Someone you brought in just placed their first order.\n\n◇ +3 credits. Total: ${referrer.credits}\n\n${
            referrer.credits >= CREDITS_FOR_FREE_ORDER
              ? `Your next order is free. Use it whenever.`
              : `${refNeeded} more credits until your free order.`
          }`
        );
      }

      user.hasOrdered = true;
      if (isFreeOrder) user.credits -= CREDITS_FOR_FREE_ORDER;

      await send(chatId, `◆ You're locked in.`);
      await send(chatId, `Connecting you now...`);
      await delay(2000);
      await send(chatId, `◆ You're in.\n\nFinish up directly here:\nt.me/lovedtimo`);

      if (isFreeOrder) {
        await send(chatId, `◇ This one's free. Credits applied. Enjoy.`);
      } else {
        await send(chatId, `◇ You're saving 65% on this order.\n\nWant your next one free?\nBring people in. Every order through your link = 3 credits. 6 credits = free order.\n\nt.me/BiteNowBot?start=${user.refCode}`);
      }

      await forwardToOwner(session, chatId, user);
      resetSession(session);
      return;
    }

    if (photo && chatId !== OWNER_CHAT_ID) {
      await forwardPhotoToOwner(chatId, session.username, photo[photo.length - 1].file_id, "PHOTO");
      await send(chatId, `Type /start to begin your order.`);
      return;
    }

    if (text && [STAGE.IDLE, STAGE.WAITING_CART].includes(session.stage)) {
      await send(chatId, getScriptedReply(text));
      return;
    }

    if (session.stage === STAGE.WAITING_CART) {
      await send(chatId, `◇ Send your cart screenshot.`);
    }

  } catch (err) {
    console.error("Webhook error:", err?.message);
  }
});

app.get("/", (req, res) => res.send("@BiteNowBot is live"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`@BiteNowBot running on port ${PORT}`));
