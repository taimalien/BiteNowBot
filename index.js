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
    reply: `You send the cart. We place the order. You pay 65% less. That's it.`,
  },
  {
    keys: ["save", "65", "percent", "discount"],
    reply: `We have access you don't. That's all you need to know.`,
  },
  {
    keys: ["pay", "payment", "cost", "price"],
    reply: `You pay after the order is confirmed. CashApp, Apple Pay, Zelle, crypto. Your call.`,
  },
  {
    keys: ["restaurant", "restaurants", "where", "place", "which"],
    reply: `Dominos, Papa Johns, Subway, Churchs Chicken, Five Guys, Jersey Mikes, Panda Express, Auntie Annes, Insomnia Cookies, Panera, Applebees, Olive Garden, Jack in the Box, CAVA and more.`,
  },
  {
    keys: ["long", "fast", "time", "quick", "wait"],
    reply: `Order goes in, we move. No waiting around on our end.`,
  },
  {
    keys: ["real", "legit", "scam", "trust", "safe", "fake"],
    reply: `BiteNow doesn't miss. Every order placed. Every customer saves. We don't operate any other way.`,
  },
  {
    keys: ["refer", "referral", "invite", "link", "credits", "credit", "free"],
    reply: `Type /referral. Every person you bring in who orders puts 3 credits in your account. 6 credits and your next order is on us. Free.`,
  },
  {
    keys: ["hi", "hey", "hello", "sup", "yo", "hii", "heyy", "helo"],
    reply: `BiteNow. Send your cart and we handle the rest.`,
  },
];

function getScriptedReply(text) {
  const lower = text.toLowerCase();
  for (const faq of FAQ) {
    if (faq.keys.some((k) => lower.includes(k))) return faq.reply;
  }
  return `Send your cart screenshot. We'll take it from there.`;
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
      await send(targetId, `${replyText}`);
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: OWNER_CHAT_ID,
        text: `Sent to ${targetId}.`,
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

      await send(chatId, `BiteNow.`);
      await send(chatId, `We place your order. You pay 65% less. Every time.`);
      await send(chatId, `Send your cart screenshot to get started.`);
      return;
    }

    if (["/referral", "/refer", "/getlink"].includes(text)) {
      const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
      await forwardMsgToOwner(chatId, session.username, "COMMAND", "/referral");
      await send(
        chatId,
        `Your referral link:\nt.me/BiteNowBot?start=${user.refCode}\n\nEvery person you bring in who orders earns you 3 credits.\n6 credits and your next order is completely free.\n\nCredits: ${user.credits}\nNeeded: ${needed}`
      );
      return;
    }

    if (text === "/credits") {
      const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
      await forwardMsgToOwner(chatId, session.username, "COMMAND", "/credits");
      if (user.credits >= CREDITS_FOR_FREE_ORDER) {
        await send(chatId, `You have ${user.credits} credits. Your next order is free. Place it and we'll apply them.`);
      } else {
        await send(chatId, `You have ${user.credits} credits. ${needed} more and your next order is free.\n\n/referral`);
      }
      return;
    }

    // Forward every text message to owner
    if (text && chatId !== OWNER_CHAT_ID) {
      await forwardMsgToOwner(chatId, session.username, "MSG", text);
    }

    if (photo && session.stage === STAGE.WAITING_CART) {
      session.cartFileId = photo[photo.length - 1].file_id;
      session.stage = STAGE.WAITING_ADDRESS;
      session.addressStep = "street";

      await forwardPhotoToOwner(chatId, session.username, session.cartFileId, "CART SCREENSHOT");

      await send(chatId, `Received. Let's get your details.`);
      await send(chatId, `Street Address:`);
      return;
    }

    if (session.stage === STAGE.WAITING_ADDRESS && text) {
      if (session.addressStep === "street") {
        session.address = text;
        session.addressStep = "apt";
        await send(chatId, `Apt or Unit number (type - to skip):`);
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
        await send(chatId, `Phone Number:`);
        return;
      }
    }

    if (session.stage === STAGE.WAITING_PHONE && text) {
      session.phone = text;
      session.stage = STAGE.WAITING_EMAIL;
      await send(chatId, `Email Address:`);
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
          `Someone you brought in just placed their first order.\n\nYou earned 3 credits. Total: ${referrer.credits}.\n\n${
            referrer.credits >= CREDITS_FOR_FREE_ORDER
              ? `Your next order is free. Use it whenever you're ready.`
              : `${refNeeded} more credits until your free order.`
          }`
        );
      }

      user.hasOrdered = true;
      if (isFreeOrder) user.credits -= CREDITS_FOR_FREE_ORDER;

      await send(chatId, `You're locked in.`);
      await send(chatId, `Connecting you now...`);
      await delay(2000);
      await send(chatId, `You're in.\n\nHandle the rest directly:\nt.me/Imunchy`);

      if (isFreeOrder) {
        await send(chatId, `This one's free. Your credits have been applied.`);
      } else {
        await send(chatId, `You're saving 65% on this order.\n\nWant your next one free? Bring people in.\nEvery person who orders through your link = 3 credits.\n6 credits = free order.\n\nt.me/BiteNowBot?start=${user.refCode}`);
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
      await send(chatId, `Send your cart screenshot.`);
    }

  } catch (err) {
    console.error("Webhook error:", err?.message);
  }
});

app.get("/", (req, res) => res.send("@BiteNowBot is live"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`@BiteNowBot running on port ${PORT}`));
