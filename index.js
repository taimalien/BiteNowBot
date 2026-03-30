const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || "6408550462";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const CREDITS_PER_REFERRAL = 3;
const CREDITS_FOR_FREE_ORDER = 6;
const FIRST_ORDER_DISCOUNT = "70%";
const REPEAT_ORDER_DISCOUNT = "65%";

const STAGE = Object.freeze({
  IDLE: "idle",
  WAITING_CART: "waiting_cart",
  WAITING_ADDRESS: "waiting_address",
  WAITING_PHONE: "waiting_phone",
  WAITING_EMAIL: "waiting_email",
  WAITING_PAYMENT: "waiting_payment",
  DONE: "done",
});

const ADDRESS_STEP = Object.freeze({
  STREET: "street",
  APT: "apt",
  CITY: "city",
  STATE: "state",
  ZIP: "zip",
});

const SKIP_WORDS = new Set(["-", "--", "none", "skip", "na", "n/a", "no"]);

// ─── In-memory stores (swap with Redis/DB for persistence) ────────────────────

let orderCounter = 1487;
const sessions = {};
const users = {};
const processedUpdates = new Set(); // deduplicate webhook re-deliveries

// ─── Restaurant map ───────────────────────────────────────────────────────────

const RESTAURANT_MAP = {
  rest_dominos:    "Dominos",
  rest_papajohns:  "Papa Johns",
  rest_subway:     "Subway",
  rest_fiveguys:   "Five Guys",
  rest_jerseymikes:"Jersey Mikes",
  rest_jackinthebox:"Jack in the Box",
  rest_churchs:    "Churchs Chicken",
  rest_panda:      "Panda Express",
  rest_85c:        "85C Bakery Cafe",
  rest_panera:     "Panera",
  rest_applebees:  "Applebees",
  rest_olivegarden:"Olive Garden",
  rest_cava:       "CAVA",
  rest_insomnia:   "Insomnia Cookies",
  rest_auntie:     "Auntie Annes",
  rest_shipleys:   "Shipleys Do-Nuts",
  rest_mainbird:   "Main Bird Hot Chicken",
  rest_urbanbird:  "Urban Bird Hot Chicken",
  rest_gyrohut:    "Gyro Hut",
};

const PAYMENT_MAP = {
  pay_cashapp:   "CashApp",
  pay_applepay:  "Apple Pay",
  pay_zelle:     "Zelle",
  pay_crypto:    "Crypto",
};

// ─── User & session helpers ───────────────────────────────────────────────────

function generateOrderId() {
  return `ORD-${++orderCounter}`;
}

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
  const entry = Object.entries(users).find(([, u]) => u.refCode === code);
  return entry ? { chatId: entry[0], user: entry[1] } : null;
}

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = buildFreshSession();
  }
  return sessions[chatId];
}

function buildFreshSession() {
  return {
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
    addressStep: ADDRESS_STEP.STREET,
    paymentMethod: null,
    orderId: null,
    selectedRestaurant: null,
  };
}

function resetSession(chatId) {
  sessions[chatId] = buildFreshSession();
  sessions[chatId].stage = STAGE.WAITING_CART;
  // Preserve username if we already know it
  if (sessions[chatId]) sessions[chatId].username = sessions[chatId]?.username ?? null;
  return sessions[chatId];
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function telegramPost(method, payload, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(`${TELEGRAM_API}/${method}`, payload);
      return res.data;
    } catch (err) {
      const isLast = attempt === retries;
      if (isLast) {
        console.error(`Telegram ${method} failed after ${retries + 1} attempts:`, err?.response?.data ?? err.message);
        return null;
      }
      await delay(600 * (attempt + 1)); // back-off: 600ms, 1200ms
    }
  }
}

async function sendTyping(chatId) {
  await telegramPost("sendChatAction", { chat_id: chatId, action: "typing" });
}

async function send(chatId, text, extra = {}) {
  await sendTyping(chatId);
  await delay(1200);
  await telegramPost("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
  await delay(400);
}

async function sendWithButtons(chatId, text, inline_keyboard) {
  await sendTyping(chatId);
  await delay(1200);
  await telegramPost("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard },
  });
  await delay(400);
}

async function answerCallback(id) {
  await telegramPost("answerCallbackQuery", { callback_query_id: id });
}

// ─── Bot UI components ────────────────────────────────────────────────────────

function sendPaymentButtons(chatId) {
  return sendWithButtons(chatId, "◆ Select your payment method:", [
    [{ text: "CashApp", callback_data: "pay_cashapp" }, { text: "Apple Pay", callback_data: "pay_applepay" }],
    [{ text: "Zelle",   callback_data: "pay_zelle" },   { text: "Crypto",    callback_data: "pay_crypto" }],
  ]);
}

function sendRestaurantMenu(chatId) {
  return sendWithButtons(chatId, "◆ Select a restaurant or just send your cart screenshot:", [
    [{ text: "Dominos",              callback_data: "rest_dominos" },    { text: "Papa Johns",     callback_data: "rest_papajohns" }],
    [{ text: "Subway",               callback_data: "rest_subway" },     { text: "Five Guys",      callback_data: "rest_fiveguys" }],
    [{ text: "Jersey Mikes",         callback_data: "rest_jerseymikes" },{ text: "Jack in the Box",callback_data: "rest_jackinthebox" }],
    [{ text: "Churchs Chicken",      callback_data: "rest_churchs" },    { text: "Panda Express",  callback_data: "rest_panda" }],
    [{ text: "85C Bakery",           callback_data: "rest_85c" },        { text: "Panera",         callback_data: "rest_panera" }],
    [{ text: "Applebees",            callback_data: "rest_applebees" },  { text: "Olive Garden",   callback_data: "rest_olivegarden" }],
    [{ text: "CAVA",                 callback_data: "rest_cava" },       { text: "Insomnia Cookies",callback_data: "rest_insomnia" }],
    [{ text: "Auntie Annes",         callback_data: "rest_auntie" },     { text: "Shipleys Do-Nuts",callback_data: "rest_shipleys" }],
    [{ text: "Main Bird Hot Chicken",callback_data: "rest_mainbird" }],
    [{ text: "Urban Bird Hot Chicken",callback_data: "rest_urbanbird" }],
    [{ text: "Gyro Hut",             callback_data: "rest_gyrohut" }],
  ]);
}

// ─── Owner notifications ──────────────────────────────────────────────────────

async function notifyOwner(chatId, username, label, content) {
  if (chatId === OWNER_CHAT_ID) return;
  await telegramPost("sendMessage", {
    chat_id: OWNER_CHAT_ID,
    text: `— ${username} (${chatId})\n[${label}]: ${content}\n\n/reply ${chatId} your message`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function notifyOwnerPhoto(chatId, username, fileId, label) {
  if (chatId === OWNER_CHAT_ID) return;
  await telegramPost("sendPhoto", {
    chat_id: OWNER_CHAT_ID,
    photo: fileId,
    caption: `— ${username} (${chatId})\n[${label}]\n\n/reply ${chatId} your message`,
  });
}

async function notifyOwnerOrder(session, chatId, user) {
  const freeNote  = user.credits >= CREDITS_FOR_FREE_ORDER ? "\nFREE ORDER — credits applied\n" : "";
  const firstNote = !user.hasOrdered ? "\n◆ FIRST ORDER — 70% off\n" : "";
  const caption =
    `— NEW ORDER —\n\n` +
    `Order ID: ${session.orderId}\n` +
    `Customer: ${session.username || chatId}\n` +
    `Restaurant: ${session.selectedRestaurant || "Not selected"}\n` +
    `Address: ${session.fullAddress}\n` +
    `Phone: ${session.phone}\n` +
    `Email: ${session.email}\n` +
    `Payment: ${session.paymentMethod}\n` +
    `Credits: ${user.credits}${freeNote}${firstNote}\n\n` +
    `t.me/${session.username?.replace("@", "") || chatId}\n` +
    `/reply ${chatId} your message`;

  if (session.cartFileId) {
    await telegramPost("sendPhoto", { chat_id: OWNER_CHAT_ID, photo: session.cartFileId, caption });
  } else {
    await telegramPost("sendMessage", { chat_id: OWNER_CHAT_ID, text: caption });
  }
}

// ─── Static content ───────────────────────────────────────────────────────────

const MENU_TEXT = `◆ BiteNow — Restaurant Menu

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
  { keys: ["how", "work", "works"],
    reply: "◆ You send the cart. We place the order. You pay less.\n\nFirst order is 70% off. No catch." },
  { keys: ["save", "65", "70", "percent", "discount"],
    reply: "◆ First order — 70% off.\n◆ Every order after — 65% off." },
  { keys: ["pay", "payment", "cost", "price"],
    reply: "◆ You pay after the order is confirmed.\n\nCashApp ◇ Apple Pay ◇ Zelle ◇ Crypto" },
  { keys: ["restaurant", "restaurants", "where", "place", "which", "menu"],
    reply: "◆ Type /menu to see every restaurant we cover." },
  { keys: ["long", "fast", "time", "quick", "wait"],
    reply: "◆ Order goes in, we move. No delays on our end." },
  { keys: ["real", "legit", "scam", "trust", "safe", "fake"],
    reply: "◆ BiteNow doesn't miss.\n\nEvery order placed. Every customer saves." },
  { keys: ["refer", "referral", "invite", "link", "credits", "credit", "free"],
    reply: "◆ Type /referral to get your link.\n\nEvery person you bring in who orders → 3 credits.\n6 credits → free order." },
  { keys: ["hi", "hey", "hello", "sup", "yo", "hii", "heyy", "helo", "wsg", "wsp"],
    reply: "◆ Welcome to BiteNow.\n\nFirst order is 70% off. Send your cart screenshot and we handle the rest." },
];

function getScriptedReply(text) {
  const lower = text.toLowerCase();
  for (const faq of FAQ) {
    if (faq.keys.some((k) => lower.includes(k))) return faq.reply;
  }
  return "◆ Send your cart screenshot and we'll take it from there.";
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleStart(chatId, session, user, text) {
  const parts = text.split(" ");
  const refCode = parts[1] || null;

  if (refCode && !user.referredBy) {
    const referrer = findUserByRefCode(refCode);
    if (referrer && referrer.chatId !== chatId) {
      user.referredBy = referrer.chatId;
    }
  }

  resetSession(chatId);
  const freshSession = getSession(chatId);
  freshSession.username = session.username; // carry over username

  await notifyOwner(chatId, session.username, "SESSION STARTED", "/start");

  const discount = user.hasOrdered ? REPEAT_ORDER_DISCOUNT : FIRST_ORDER_DISCOUNT;
  await send(chatId, "◆ Welcome to BiteNow.");
  await send(chatId, `We place your order. You pay ${discount} less.\n\nEvery. Single. Time.`);
  await sendRestaurantMenu(chatId);
}

async function handleMenu(chatId, session) {
  await notifyOwner(chatId, session.username, "COMMAND", "/menu");
  await send(chatId, MENU_TEXT);
  await sendRestaurantMenu(chatId);
}

async function handleReferral(chatId, session, user) {
  const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
  await notifyOwner(chatId, session.username, "COMMAND", "/referral");
  await send(chatId,
    `◆ Your referral link:\nt.me/BiteNowBot?start=${user.refCode}\n\n` +
    `◇ Every person you bring in who orders → 3 credits\n` +
    `◇ 6 credits → your next order is completely free\n\n` +
    `Credits: ${user.credits}\nNeeded: ${needed}`
  );
}

async function handleCredits(chatId, session, user) {
  const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
  await notifyOwner(chatId, session.username, "COMMAND", "/credits");
  if (user.credits >= CREDITS_FOR_FREE_ORDER) {
    await send(chatId, `◆ You have ${user.credits} credits.\n\nYour next order is free. Place it and we'll apply them.`);
  } else {
    await send(chatId, `◆ You have ${user.credits} credits.\n\n${needed} more and your next order is on us.\n\n/referral`);
  }
}

async function handleCartPhoto(chatId, session, fileId) {
  session.cartFileId = fileId;
  session.stage = STAGE.WAITING_ADDRESS;
  session.addressStep = ADDRESS_STEP.STREET;
  await notifyOwnerPhoto(chatId, session.username, fileId, "CART SCREENSHOT");
  await send(chatId, "◆ Received.\n\nLet's get your details locked in.");
  await send(chatId, "Street Address:");
}

async function handleAddress(chatId, session, text) {
  switch (session.addressStep) {
    case ADDRESS_STEP.STREET:
      session.address = text;
      session.addressStep = ADDRESS_STEP.APT;
      await send(chatId, "Apt or Unit # (type - to skip):");
      break;

    case ADDRESS_STEP.APT:
      session.addressLine2 = SKIP_WORDS.has(text.toLowerCase()) ? null : text;
      session.addressStep = ADDRESS_STEP.CITY;
      await send(chatId, "City:");
      break;

    case ADDRESS_STEP.CITY:
      session.city = text;
      session.addressStep = ADDRESS_STEP.STATE;
      await send(chatId, "State:");
      break;

    case ADDRESS_STEP.STATE:
      session.state = text;
      session.addressStep = ADDRESS_STEP.ZIP;
      await send(chatId, "ZIP Code:");
      break;

    case ADDRESS_STEP.ZIP:
      if (!/^\d{5,6}$/.test(text)) {
        await send(chatId, "Enter a valid ZIP code:");
        return;
      }
      session.zip = text;
      const apt = session.addressLine2 ? `, ${session.addressLine2}` : "";
      session.fullAddress = `${session.address}${apt}, ${session.city}, ${session.state} ${session.zip}`;
      session.stage = STAGE.WAITING_PHONE;
      await send(chatId, "◆ Got it.\n\nPhone Number:");
      break;
  }
}

async function handleRestaurantCallback(chatId, session, username, data) {
  const chosen = RESTAURANT_MAP[data];
  if (!chosen) return;

  session.selectedRestaurant = chosen;
  await notifyOwner(chatId, username, "SELECTED RESTAURANT", chosen);
  await telegramPost("sendMessage", {
    chat_id: OWNER_CHAT_ID,
    text: `— ${username} (${chatId})\n[WAITING FOR CART]: ${chosen}\n\nAbout to send cart screenshot.`,
    parse_mode: "HTML",
  });

  if (session.stage === STAGE.WAITING_CART) {
    await send(chatId, `◆ ${chosen} — noted.\n\nNow send your cart screenshot to continue.`);
  }
}

async function handlePaymentCallback(chatId, session, user, username, data) {
  const chosen = PAYMENT_MAP[data];
  if (!chosen) return;

  session.paymentMethod = chosen;

  const isFreeOrder  = user.credits >= CREDITS_FOR_FREE_ORDER;
  const isFirstOrder = !user.hasOrdered;
  session.orderId = generateOrderId();

  await notifyOwner(chatId, username, "PAYMENT METHOD", chosen);

  // Credit referrer on first order
  if (isFirstOrder && user.referredBy) {
    const referrer = getUser(user.referredBy);
    referrer.credits += CREDITS_PER_REFERRAL;
    const refNeeded = Math.max(0, CREDITS_FOR_FREE_ORDER - referrer.credits);
    const refMsg = referrer.credits >= CREDITS_FOR_FREE_ORDER
      ? "Your next order is free. Use it whenever."
      : `${refNeeded} more credits until your free order.`;
    await telegramPost("sendMessage", {
      chat_id: user.referredBy,
      text: `◆ Someone you brought in just placed their first order.\n\n◇ +3 credits. Total: ${referrer.credits}\n\n${refMsg}`,
      parse_mode: "HTML",
    });
  }

  user.hasOrdered = true;
  if (isFreeOrder) user.credits -= CREDITS_FOR_FREE_ORDER;

  const discountLine = isFreeOrder
    ? "◇ This one is on us — credits applied."
    : isFirstOrder
    ? `◇ First order bonus — ${FIRST_ORDER_DISCOUNT} off applied.\n◇ Every order after this is ${REPEAT_ORDER_DISCOUNT} off.`
    : `◇ ${REPEAT_ORDER_DISCOUNT} off applied.`;

  await send(chatId,
    `◆ Order Submitted\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Order ID: ${session.orderId}\n` +
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
    `◆ Refer friends and earn free orders:\n` +
    `Every person you invite who places an order earns you 3 credits.\n` +
    `6 credits = your next order is completely free.\n\n` +
    `Your link:\nt.me/BiteNowBot?start=${user.refCode}`
  );

  await notifyOwnerOrder(session, chatId, user);
  resetSession(chatId);
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // always ack immediately

  const body = req.body;
  const updateId = body?.update_id;

  // Deduplicate re-delivered webhooks
  if (updateId !== undefined) {
    if (processedUpdates.has(updateId)) return;
    processedUpdates.add(updateId);
    if (processedUpdates.size > 5000) {
      // Prune old IDs to avoid unbounded growth
      const oldest = [...processedUpdates].slice(0, 1000);
      oldest.forEach((id) => processedUpdates.delete(id));
    }
  }

  const msg = body?.message;
  const callbackQuery = body?.callback_query;

  try {
    if (callbackQuery) {
      await handleCallbackQuery(callbackQuery);
      return;
    }
    if (msg) {
      await handleMessage(msg);
    }
  } catch (err) {
    console.error("Webhook error:", err?.message, err?.stack);
  }
});

async function handleCallbackQuery(callbackQuery) {
  const chatId   = String(callbackQuery.message.chat.id);
  const data     = callbackQuery.data;
  const session  = getSession(chatId);
  const user     = getUser(chatId);
  const username = callbackQuery.from?.username
    ? `@${callbackQuery.from.username}`
    : callbackQuery.from?.first_name || chatId;

  await answerCallback(callbackQuery.id);

  if (data.startsWith("rest_")) {
    await handleRestaurantCallback(chatId, session, username, data);
  } else if (data.startsWith("pay_")) {
    await handlePaymentCallback(chatId, session, user, username, data);
  }
}

async function handleMessage(msg) {
  const chatId  = String(msg.chat.id);
  const text    = (msg.text || "").trim();
  const photo   = msg.photo;
  const session = getSession(chatId);
  const user    = getUser(chatId);

  session.username = msg.from?.username
    ? `@${msg.from.username}`
    : msg.from?.first_name || chatId;

  // Owner-only: /reply command
  if (chatId === OWNER_CHAT_ID) {
    if (text.startsWith("/reply ")) {
      const parts     = text.split(" ");
      const targetId  = parts[1];
      const replyText = parts.slice(2).join(" ");
      if (targetId && replyText && users[targetId]) {
        await send(targetId, replyText);
        await telegramPost("sendMessage", {
          chat_id: OWNER_CHAT_ID,
          text: `◆ Sent to ${targetId}.`,
        });
      } else if (targetId && !users[targetId]) {
        await telegramPost("sendMessage", {
          chat_id: OWNER_CHAT_ID,
          text: `◆ Unknown user: ${targetId}`,
        });
      }
    }
    return; // never process owner's own messages as customer input
  }

  // Commands
  if (text.startsWith("/start")) {
    await handleStart(chatId, session, user, text);
    return;
  }
  if (text === "/menu") {
    await handleMenu(chatId, session);
    return;
  }
  if (["/referral", "/refer", "/getlink"].includes(text)) {
    await handleReferral(chatId, session, user);
    return;
  }
  if (text === "/credits") {
    await handleCredits(chatId, session, user);
    return;
  }

  // Forward all non-command text to owner
  if (text) await notifyOwner(chatId, session.username, "MSG", text);

  // Photo handling
  if (photo) {
    const fileId = photo[photo.length - 1].file_id;
    if (session.stage === STAGE.WAITING_CART) {
      await handleCartPhoto(chatId, session, fileId);
    } else {
      await notifyOwnerPhoto(chatId, session.username, fileId, "PHOTO");
      if (session.stage !== STAGE.WAITING_CART) {
        await send(chatId, "Type /start to begin your order.");
      }
    }
    return;
  }

  // Flow stages
  if (session.stage === STAGE.WAITING_ADDRESS && text) {
    await handleAddress(chatId, session, text);
    return;
  }
  if (session.stage === STAGE.WAITING_PHONE && text) {
    session.phone = text;
    session.stage = STAGE.WAITING_EMAIL;
    await send(chatId, "◆ Got it.\n\nEmail Address:");
    return;
  }
  if (session.stage === STAGE.WAITING_EMAIL && text) {
    session.email = text;
    session.stage = STAGE.WAITING_PAYMENT;
    await send(chatId, "◆ Almost done.");
    await sendPaymentButtons(chatId);
    return;
  }

  // Idle / waiting-cart fallback
  if ([STAGE.IDLE, STAGE.WAITING_CART].includes(session.stage) && text) {
    await send(chatId, getScriptedReply(text));
    return;
  }
  if (session.stage === STAGE.WAITING_CART) {
    await send(chatId, "◇ Send your cart screenshot.");
  }
}

// ─── Setup & health ───────────────────────────────────────────────────────────

app.get("/setup", async (req, res) => {
  try {
    await telegramPost("setMyCommands", {
      commands: [
        { command: "start",    description: "Place an order — 70% off first order" },
        { command: "menu",     description: "See all restaurants we cover" },
        { command: "referral", description: "Get your referral link" },
        { command: "credits",  description: "Check your credit balance" },
      ],
    });
    await telegramPost("setChatMenuButton", { menu_button: { type: "commands" } });
    res.send("Setup complete.");
  } catch {
    res.status(500).send("Setup failed.");
  }
});

app.get("/", (req, res) => res.send("@BiteNowBot is live"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`@BiteNowBot running on port ${PORT}`));
