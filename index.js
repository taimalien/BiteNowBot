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
  WAITING_PAYMENT: "waiting_payment",
  DONE: "done",
};

const CREDITS_PER_REFERRAL = 3;
const CREDITS_FOR_FREE_ORDER = 6;

let orderCounter = 1487;

function generateOrderId() {
  orderCounter++;
  return `ORD-${orderCounter}`;
}

function getUser(chatId) {
  if (!users[chatId]) {
    users[chatId] = { credits: 0, referredBy: null, hasOrdered: false, refCode: `REF${chatId}` };
  }
  return users[chatId];
}

function findUserByRefCode(code) {
  return Object.entries(users).find(([, u]) => u.refCode === code);
}

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      stage: STAGE.IDLE, cartFileId: null, address: null, addressLine2: null,
      city: null, state: null, zip: null, fullAddress: null,
      phone: null, email: null, username: null, addressStep: "street",
      paymentMethod: null, orderId: null, selectedRestaurant: null,
    };
  }
  return sessions[chatId];
}

function resetSession(session) {
  session.stage = STAGE.WAITING_CART;
  session.cartFileId = null; session.address = null; session.addressLine2 = null;
  session.city = null; session.state = null; session.zip = null;
  session.fullAddress = null; session.phone = null; session.email = null;
  session.addressStep = "street"; session.paymentMethod = null;
  session.orderId = null; session.selectedRestaurant = null;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function sendTyping(chatId) {
  await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" }).catch(() => {});
}

async function send(chatId, text) {
  await sendTyping(chatId);
  await delay(1500);
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
  }).catch((e) => console.error("sendMessage error:", e?.response?.data));
  await delay(500);
}

async function sendPaymentButtons(chatId) {
  await sendTyping(chatId);
  await delay(1500);
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: `◆ Select your payment method:`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "CashApp", callback_data: "pay_cashapp" }, { text: "Apple Pay", callback_data: "pay_applepay" }],
        [{ text: "Zelle", callback_data: "pay_zelle" }, { text: "Crypto", callback_data: "pay_crypto" }],
      ],
    },
  }).catch((e) => console.error("sendPaymentButtons error:", e?.response?.data));
  await delay(500);
}

async function sendRestaurantMenu(chatId) {
  await sendTyping(chatId);
  await delay(1500);
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: `◆ Select a restaurant or just send your cart screenshot:`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Dominos", callback_data: "rest_dominos" }, { text: "Papa Johns", callback_data: "rest_papajohns" }],
        [{ text: "Subway", callback_data: "rest_subway" }, { text: "Five Guys", callback_data: "rest_fiveguys" }],
        [{ text: "Jersey Mikes", callback_data: "rest_jerseymikes" }, { text: "Jack in the Box", callback_data: "rest_jackinthebox" }],
        [{ text: "Churchs Chicken", callback_data: "rest_churchs" }, { text: "Panda Express", callback_data: "rest_panda" }],
        [{ text: "85C Bakery", callback_data: "rest_85c" }, { text: "Panera", callback_data: "rest_panera" }],
        [{ text: "Applebees", callback_data: "rest_applebees" }, { text: "Olive Garden", callback_data: "rest_olivegarden" }],
        [{ text: "CAVA", callback_data: "rest_cava" }, { text: "Insomnia Cookies", callback_data: "rest_insomnia" }],
        [{ text: "Auntie Annes", callback_data: "rest_auntie" }, { text: "Shipleys Do-Nuts", callback_data: "rest_shipleys" }],
        [{ text: "Main Bird Hot Chicken", callback_data: "rest_mainbird" }],
        [{ text: "Urban Bird Hot Chicken", callback_data: "rest_urbanbird" }],
        [{ text: "Gyro Hut", callback_data: "rest_gyrohut" }],
      ],
    },
  }).catch((e) => console.error("sendRestaurantMenu error:", e?.response?.data));
  await delay(500);
}

async function forwardMsgToOwner(chatId, username, label, content) {
  if (chatId === OWNER_CHAT_ID) return;
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: OWNER_CHAT_ID,
    text: `— ${username} (${chatId})\n[${label}]: ${content}\n\n/reply ${chatId} your message`,
    parse_mode: "HTML", disable_web_page_preview: true,
  }).catch(() => {});
}

async function forwardPhotoToOwner(chatId, username, fileId, label) {
  if (chatId === OWNER_CHAT_ID) return;
  await axios.post(`${TELEGRAM_API}/sendPhoto`, {
    chat_id: OWNER_CHAT_ID,
    photo: fileId,
    caption: `— ${username} (${chatId})\n[${label}]\n\n/reply ${chatId} your message`,
  }).catch(() => {});
}

async function forwardToOwner(session, chatId, user) {
  const freeNote = user.credits >= CREDITS_FOR_FREE_ORDER ? "\nFREE ORDER — credits applied\n" : "";
  const firstOrder = !user.hasOrdered ? "\n◆ FIRST ORDER — 70% off\n" : "";
  const caption =
    `— NEW ORDER —\n\n` +
    `Order ID: ${session.orderId}\n` +
    `Customer: ${session.username || chatId}\n` +
    `Restaurant: ${session.selectedRestaurant || "Not selected"}\n` +
    `Address: ${session.fullAddress}\n` +
    `Phone: ${session.phone}\n` +
    `Email: ${session.email}\n` +
    `Payment: ${session.paymentMethod}\n` +
    `Credits: ${user.credits}${freeNote}${firstOrder}\n\n` +
    `t.me/${session.username?.replace("@", "") || chatId}\n` +
    `/reply ${chatId} your message`;

  if (session.cartFileId) {
    await axios.post(`${TELEGRAM_API}/sendPhoto`, {
      chat_id: OWNER_CHAT_ID, photo: session.cartFileId, caption,
    }).catch((e) => console.error("sendPhoto error:", e?.response?.data));
  } else {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: OWNER_CHAT_ID, text: caption,
    }).catch((e) => console.error("forwardToOwner error:", e?.response?.data));
  }
}

const MENU_TEXT =
`◆ BiteNow — Restaurant Menu

━━━━━━━━━━━━━━━━━━
◇ PIZZA
━━━━━━━━━━━━━━━━━━
◦ Dominos
◦ Papa Johns

━━━━━━━━━━━━━━━━━━
◇ FAST FOOD
━━━━━━━━━━━━━━━━━━
◦ Subway
◦ Five Guys
◦ Jersey Mikes
◦ Jack in the Box
◦ Churchs Chicken

━━━━━━━━━━━━━━━━━━
◇ ASIAN
━━━━━━━━━━━━━━━━━━
◦ Panda Express
◦ 85C Bakery Cafe

━━━━━━━━━━━━━━━━━━
◇ HOT CHICKEN
━━━━━━━━━━━━━━━━━━
◦ Main Bird Hot Chicken
◦ Urban Bird Hot Chicken

━━━━━━━━━━━━━━━━━━
◇ CASUAL DINING
━━━━━━━━━━━━━━━━━━
◦ Applebees
◦ Olive Garden
◦ Panera
◦ CAVA

━━━━━━━━━━━━━━━━━━
◇ DESSERTS & SNACKS
━━━━━━━━━━━━━━━━━━
◦ Insomnia Cookies
◦ Auntie Annes
◦ Shipleys Do-Nuts

━━━━━━━━━━━━━━━━━━
◇ OTHER
━━━━━━━━━━━━━━━━━━
◦ Gyro Hut
◦ + more added regularly

━━━━━━━━━━━━━━━━━━
◆ First order → 70% off
◆ Every order after → 65% off
◆ 6 referral credits → free order
━━━━━━━━━━━━━━━━━━

Ready? Send your cart screenshot.`;

const FAQ = [
  { keys: ["how", "work", "works"], reply: `◆ You send the cart. We place the order. You pay less.\n\nFirst order is 70% off. No catch.` },
  { keys: ["save", "65", "70", "percent", "discount"], reply: `◆ First order — 70% off.\n◆ Every order after — 65% off.` },
  { keys: ["pay", "payment", "cost", "price"], reply: `◆ You pay after the order is confirmed.\n\nCashApp ◇ Apple Pay ◇ Zelle ◇ Crypto` },
  { keys: ["restaurant", "restaurants", "where", "place", "which", "menu"], reply: `◆ Type /menu to see every restaurant we cover.` },
  { keys: ["long", "fast", "time", "quick", "wait"], reply: `◆ Order goes in, we move. No delays on our end.` },
  { keys: ["real", "legit", "scam", "trust", "safe", "fake"], reply: `◆ BiteNow doesn't miss.\n\nEvery order placed. Every customer saves.` },
  { keys: ["refer", "referral", "invite", "link", "credits", "credit", "free"], reply: `◆ Type /referral to get your link.\n\nEvery person you bring in who orders → 3 credits.\n6 credits → free order.` },
  { keys: ["hi", "hey", "hello", "sup", "yo", "hii", "heyy", "helo", "wsg", "wsp"], reply: `◆ Welcome to BiteNow.\n\nFirst order is 70% off. Send your cart screenshot and we handle the rest.` },
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
        { command: "start",    description: "Place an order — 70% off first order" },
        { command: "menu",     description: "See all restaurants we cover" },
        { command: "referral", description: "Get your referral link" },
        { command: "credits",  description: "Check your credit balance" },
      ],
    });
    await axios.post(`${TELEGRAM_API}/setChatMenuButton`, { menu_button: { type: "commands" } });
    res.send("Setup complete.");
  } catch (e) {
    res.status(500).send("Setup failed.");
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  const msg = body?.message;
  const callbackQuery = body?.callback_query;

  if (callbackQuery) {
    const chatId = String(callbackQuery.message.chat.id);
    const data = callbackQuery.data;
    const session = getSession(chatId);
    const user = getUser(chatId);
    const username = callbackQuery.from?.username ? `@${callbackQuery.from.username}` : callbackQuery.from?.first_name || chatId;

    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callbackQuery.id }).catch(() => {});

    if (data.startsWith("rest_")) {
      const names = {
        rest_dominos: "Dominos", rest_papajohns: "Papa Johns", rest_subway: "Subway",
        rest_fiveguys: "Five Guys", rest_jerseymikes: "Jersey Mikes", rest_jackinthebox: "Jack in the Box",
        rest_churchs: "Churchs Chicken", rest_panda: "Panda Express", rest_85c: "85C Bakery Cafe",
        rest_panera: "Panera", rest_applebees: "Applebees", rest_olivegarden: "Olive Garden",
        rest_cava: "CAVA", rest_insomnia: "Insomnia Cookies", rest_auntie: "Auntie Annes",
        rest_shipleys: "Shipleys Do-Nuts", rest_mainbird: "Main Bird Hot Chicken",
        rest_urbanbird: "Urban Bird Hot Chicken", rest_gyrohut: "Gyro Hut",
      };
      const chosen = names[data] || "Unknown";
      session.selectedRestaurant = chosen;
      await forwardMsgToOwner(chatId, username, "SELECTED RESTAURANT", chosen);
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: OWNER_CHAT_ID,
        text: `— ${username} (${chatId})\n[WAITING FOR CART]: ${chosen}\n\nThey are about to send their cart screenshot.`,
        parse_mode: "HTML",
      }).catch(() => {});
      if (session.stage === STAGE.WAITING_CART) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `◆ ${chosen} — noted.\n\nNow send your cart screenshot to continue.`,
          parse_mode: "HTML",
        }).catch(() => {});
      }
    }

    if (data.startsWith("pay_")) {
      const methods = {
        pay_cashapp: "CashApp", pay_applepay: "Apple Pay",
        pay_zelle: "Zelle", pay_crypto: "Crypto",
      };
      const chosen = methods[data] || "Unknown";
      session.paymentMethod = chosen;

      const isFreeOrder = user.credits >= CREDITS_FOR_FREE_ORDER;
      const isFirstOrder = !user.hasOrdered;
      const orderId = generateOrderId();
      session.orderId = orderId;

      await forwardMsgToOwner(chatId, username, "PAYMENT METHOD", chosen);

      if (isFirstOrder && user.referredBy) {
        const referrer = getUser(user.referredBy);
        referrer.credits += CREDITS_PER_REFERRAL;
        const refNeeded = Math.max(0, CREDITS_FOR_FREE_ORDER - referrer.credits);
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: user.referredBy,
          text: `◆ Someone you brought in just placed their first order.\n\n◇ +3 credits. Total: ${referrer.credits}\n\n${referrer.credits >= CREDITS_FOR_FREE_ORDER ? `Your next order is free. Use it whenever.` : `${refNeeded} more credits until your free order.`}`,
          parse_mode: "HTML",
        }).catch(() => {});
      }

      user.hasOrdered = true;
      if (isFreeOrder) user.credits -= CREDITS_FOR_FREE_ORDER;

      const discountLine = isFreeOrder
        ? `◇ This one is on us — credits applied.`
        : isFirstOrder
        ? `◇ First order bonus — 70% off applied.\n◇ Every order after this is 65% off.`
        : `◇ 65% off applied.`;

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text:
          `◆ Order Submitted\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Order ID: ${orderId}\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `Restaurant: ${session.selectedRestaurant || "Not selected"}\n` +
          `Name: ${username}\n` +
          `Address: ${session.fullAddress}\n` +
          `Phone: ${session.phone}\n` +
          `Payment: ${chosen}\n\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `${discountLine}\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `We will reach out shortly with payment details.\n\n` +
          `◆ Refer friends and stack free orders:\nt.me/BiteNowBot?start=${user.refCode}`,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }).catch(() => {});

      await forwardToOwner(session, chatId, user);
      resetSession(session);
    }

    return;
  }

  if (!msg) return;

  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  const photo = msg.photo;
  const session = getSession(chatId);
  const user = getUser(chatId);

  session.username = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || String(chatId);

  if (chatId === OWNER_CHAT_ID && text.startsWith("/reply ")) {
    const parts = text.split(" ");
    const targetId = parts[1];
    const replyText = parts.slice(2).join(" ");
    if (targetId && replyText) {
      await send(targetId, replyText);
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: OWNER_CHAT_ID, text: `◆ Sent to ${targetId}.`,
      }).catch(() => {});
    }
    return;
  }

  if (chatId === OWNER_CHAT_ID) return;

  try {
    if (text.startsWith("/start")) {
      const parts = text.split(" ");
      const refCode = parts[1] || null;
      if (refCode && !user.referredBy) {
        const referrer = findUserByRefCode(refCode);
        if (referrer && referrer[0] !== chatId) user.referredBy = referrer[0];
      }
      resetSession(session);
      session.stage = STAGE.WAITING_CART;
      await forwardMsgToOwner(chatId, session.username, "SESSION STARTED", "/start");
      const discount = user.hasOrdered ? "65%" : "70%";
      await send(chatId, `◆ Welcome to BiteNow.`);
      await send(chatId, `We place your order. You pay ${discount} less.\n\nEvery. Single. Time.`);
      await sendRestaurantMenu(chatId);
      return;
    }

    if (text === "/menu") {
      await forwardMsgToOwner(chatId, session.username, "COMMAND", "/menu");
      await send(chatId, MENU_TEXT);
      await sendRestaurantMenu(chatId);
      return;
    }

    if (["/referral", "/refer", "/getlink"].includes(text)) {
      const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
      await forwardMsgToOwner(chatId, session.username, "COMMAND", "/referral");
      await send(chatId, `◆ Your referral link:\nt.me/BiteNowBot?start=${user.refCode}\n\n◇ Every person you bring in who orders → 3 credits\n◇ 6 credits → your next order is free\n\nCredits: ${user.credits}\nNeeded: ${needed}`);
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

    if (text) await forwardMsgToOwner(chatId, session.username, "MSG", text);

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
      if (session.addressStep === "street") { session.address = text; session.addressStep = "apt"; await send(chatId, `Apt or Unit # (type - to skip):`); return; }
      if (session.addressStep === "apt") {
        const skip = ["-", "--", "none", "skip", "na", "n/a", "no"];
        session.addressLine2 = skip.includes(text.toLowerCase()) ? null : text;
        session.addressStep = "city"; await send(chatId, `City:`); return;
      }
      if (session.addressStep === "city") { session.city = text; session.addressStep = "state"; await send(chatId, `State:`); return; }
      if (session.addressStep === "state") { session.state = text; session.addressStep = "zip"; await send(chatId, `ZIP Code:`); return; }
      if (session.addressStep === "zip") {
        if (!/^\d{5,6}$/.test(text)) { await send(chatId, `Enter a valid ZIP code:`); return; }
        session.zip = text;
        const apt = session.addressLine2 ? `, ${session.addressLine2}` : "";
        session.fullAddress = `${session.address}${apt}, ${session.city}, ${session.state} ${session.zip}`;
        session.stage = STAGE.WAITING_PHONE;
        await send(chatId, `◆ Got it.\n\nPhone Number:`); return;
      }
    }

    if (session.stage === STAGE.WAITING_PHONE && text) {
      session.phone = text; session.stage = STAGE.WAITING_EMAIL;
      await send(chatId, `◆ Got it.\n\nEmail Address:`); return;
    }

    if (session.stage === STAGE.WAITING_EMAIL && text) {
      session.email = text;
      session.stage = STAGE.WAITING_PAYMENT;
      await send(chatId, `◆ Almost done.`);
      await sendPaymentButtons(chatId);
      return;
    }

    if (photo) {
      await forwardPhotoToOwner(chatId, session.username, photo[photo.length - 1].file_id, "PHOTO");
      if (session.stage !== STAGE.WAITING_CART) await send(chatId, `Type /start to begin your order.`);
      return;
    }

    if (text && [STAGE.IDLE, STAGE.WAITING_CART].includes(session.stage)) {
      await send(chatId, getScriptedReply(text)); return;
    }

    if (session.stage === STAGE.WAITING_CART) await send(chatId, `◇ Send your cart screenshot.`);

  } catch (err) {
    console.error("Webhook error:", err?.message);
  }
});

app.get("/", (req, res) => res.send("@BiteNowBot is live"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`@BiteNowBot running on port ${PORT}`));
