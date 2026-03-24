#!/usr/bin/env npx tsx
/**
 * Google Chat Channel Plugin for Claude Code
 *
 * MCP server that bridges Google Chat <-> Claude Code via Cloud Pub/Sub.
 * This is a communication layer only — all business logic lives in Claude Code.
 *
 * Features:
 * - Two-way messaging via Google Chat API + Cloud Pub/Sub
 * - Sender gating with access.json (allowlist + pairing flow)
 * - Triple-format message parser (Workspace Events / Workspace Add-ons / Traditional)
 * - Automatic message splitting for 4096-char limit
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PubSub, type Message } from "@google-cloud/pubsub";
import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

// =============================================================================
// Config
// =============================================================================

const CONFIG_DIR =
  process.env.GOOGLECHAT_CONFIG_DIR ||
  join(process.env.HOME || "~", ".claude", "channels", "googlechat");

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "";
const PUBSUB_SUBSCRIPTION = process.env.PUBSUB_SUBSCRIPTION || "";
const GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || "";

const MAX_MESSAGE_LENGTH = 4096;
const CONTINUATION_RESERVE = 30;
const CHUNK_DELAY_MS = 500;

// =============================================================================
// Types
// =============================================================================

interface ParsedChatEvent {
  messageName: string;
  senderName: string;
  senderEmail: string;
  text: string;
  threadName: string | null;
  spaceName: string;
  eventType: string;
  eventTime: string;
}

interface AccessConfig {
  policy: "allowlist" | "pairing" | "open";
  allowFrom: string[];
  pendingPairings: Record<string, { code: string; expires: number }>;
}

// =============================================================================
// Access Control (access.json)
// =============================================================================

const ACCESS_FILE = join(CONFIG_DIR, "access.json");

function loadAccessConfig(): AccessConfig {
  const defaults: AccessConfig = {
    policy: "allowlist",
    allowFrom: [],
    pendingPairings: {},
  };

  if (!existsSync(ACCESS_FILE)) {
    return defaults;
  }

  try {
    const raw = readFileSync(ACCESS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    console.error(`[googlechat] Warning: Failed to parse ${ACCESS_FILE}, using defaults`);
    return defaults;
  }
}

function saveAccessConfig(config: AccessConfig): void {
  const dir = dirname(ACCESS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(ACCESS_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function generatePairingCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

function checkAccess(
  email: string,
  config: AccessConfig,
): { allowed: boolean; reason: string; pairingCode?: string } {
  // Clean up expired pairings
  const now = Date.now();
  for (const [key, val] of Object.entries(config.pendingPairings)) {
    if (val.expires < now) {
      delete config.pendingPairings[key];
    }
  }

  switch (config.policy) {
    case "open":
      return { allowed: true, reason: "open policy" };

    case "allowlist":
      if (config.allowFrom.length === 0) {
        return {
          allowed: false,
          reason: "No users in allowlist. Run /googlechat:access allow <email> to add users.",
        };
      }
      if (config.allowFrom.includes(email)) {
        return { allowed: true, reason: "allowlisted" };
      }
      return { allowed: false, reason: `${email} is not in the allowlist` };

    case "pairing": {
      if (config.allowFrom.includes(email)) {
        return { allowed: true, reason: "previously paired" };
      }
      // Check if there's a pending pairing for this email
      const pending = config.pendingPairings[email];
      if (pending && pending.expires > now) {
        return {
          allowed: false,
          reason: "pairing_pending",
          pairingCode: pending.code,
        };
      }
      // Generate new pairing code
      const code = generatePairingCode();
      config.pendingPairings[email] = {
        code,
        expires: now + 10 * 60 * 1000, // 10 minutes
      };
      saveAccessConfig(config);
      return {
        allowed: false,
        reason: "pairing_new",
        pairingCode: code,
      };
    }

    default:
      return { allowed: false, reason: "unknown policy" };
  }
}

// =============================================================================
// Startup Validation
// =============================================================================

function validateConfig(): void {
  const errors: string[] = [];

  if (!GCP_PROJECT_ID) {
    errors.push("GCP_PROJECT_ID is not set");
  }
  if (!PUBSUB_SUBSCRIPTION) {
    errors.push("PUBSUB_SUBSCRIPTION is not set");
  }
  if (!GOOGLE_APPLICATION_CREDENTIALS) {
    errors.push("GOOGLE_APPLICATION_CREDENTIALS is not set");
  } else if (!existsSync(GOOGLE_APPLICATION_CREDENTIALS)) {
    errors.push(
      `Service account key not found: ${GOOGLE_APPLICATION_CREDENTIALS}`,
    );
  }

  if (errors.length > 0) {
    console.error("[googlechat] Configuration errors:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    console.error(
      "\nRun /googlechat:configure to set up the plugin, or set environment variables manually.",
    );
    console.error("See README.md for details.");
    process.exit(1);
  }

  // Validate access config
  const access = loadAccessConfig();
  if (access.policy === "allowlist" && access.allowFrom.length === 0) {
    console.error(
      "[googlechat] WARNING: No users in allowlist. All messages will be rejected.",
    );
    console.error(
      '  Run /googlechat:access allow <email> to add authorized users, or set policy to "pairing".',
    );
  }
}

// =============================================================================
// Message Parser (triple format)
// =============================================================================

/**
 * Detect and parse a Pub/Sub message.
 *
 * Format 1: Workspace Events API (CloudEvents envelope)
 *   - Pub/Sub attributes contain "ce-type"
 *   - data contains MessageCreatedEventData
 *
 * Format 2: Workspace Add-ons (Cloud Function)
 *   - data.chat exists with messagePayload, etc.
 *
 * Format 3: Traditional (Cloud Function direct)
 *   - data.type = "MESSAGE" with data.message, data.space, etc.
 */
function parsePubSubMessage(
  data: Record<string, unknown>,
  attributes: Record<string, string>,
): ParsedChatEvent | null {
  const ceType = attributes["ce-type"];
  if (ceType) {
    return parseWorkspaceEventsFormat(data, attributes, ceType);
  }
  return parseChatEvent(data);
}

function parseWorkspaceEventsFormat(
  data: Record<string, unknown>,
  attributes: Record<string, string>,
  ceType: string,
): ParsedChatEvent | null {
  if (ceType !== "google.workspace.chat.message.v1.created") {
    console.error(
      `[googlechat] Workspace Events: ignoring event type: ${ceType}`,
    );
    return null;
  }

  const msg = (data.message || data) as Record<string, unknown>;
  if (!msg) return null;

  const sender = (msg.sender || {}) as Record<string, unknown>;
  const senderType = (sender.type as string) || "";
  const space = (msg.space || {}) as Record<string, unknown>;
  const thread = msg.thread as Record<string, unknown> | undefined;

  // Filter BOT messages (including our own)
  if (senderType === "BOT") {
    console.error("[googlechat] Workspace Events: ignoring BOT message");
    return null;
  }

  let text = (
    (msg.argumentText as string) ||
    (msg.text as string) ||
    ""
  ).trim();

  // Filter @mentions not directed at our bot
  const annotations = msg.annotations as
    | Array<Record<string, unknown>>
    | undefined;
  if (annotations && annotations.length > 0) {
    const mentionAnnotations = annotations.filter(
      (a) => (a.type as string) === "USER_MENTION",
    );
    if (mentionAnnotations.length > 0) {
      const mentionsBotSelf = mentionAnnotations.some((a) => {
        const mentionedUser = a.userMention as
          | Record<string, unknown>
          | undefined;
        if (!mentionedUser) return false;
        const user = mentionedUser.user as
          | Record<string, unknown>
          | undefined;
        if (!user) return false;
        return (user.type as string) === "BOT";
      });
      if (!mentionsBotSelf) {
        console.error(
          "[googlechat] Workspace Events: ignoring message with non-bot @mentions",
        );
        return null;
      }
    }
  }

  const senderName =
    (sender.displayName as string) ||
    (sender.name as string) ||
    "unknown";
  const senderEmail = (sender.email as string) || "";

  let spaceName = (space.name as string) || "";
  if (!spaceName) {
    const ceSubject = attributes["ce-subject"] || "";
    const subjectMatch = ceSubject.match(
      /\/\/chat\.googleapis\.com\/(spaces\/[^/]+)/,
    );
    if (subjectMatch) {
      spaceName = subjectMatch[1];
    }
  }

  return {
    messageName: (msg.name as string) || "",
    senderName,
    senderEmail,
    text,
    threadName: (thread?.name as string) || null,
    spaceName,
    eventType: "MESSAGE",
    eventTime: attributes["ce-time"] || "",
  };
}

function parseChatEvent(
  data: Record<string, unknown>,
): ParsedChatEvent | null {
  const chatData = data.chat as Record<string, unknown> | undefined;
  if (chatData) {
    return parseWorkspaceAddonsFormat(chatData);
  }
  return parseTraditionalFormat(data);
}

function parseWorkspaceAddonsFormat(
  chatData: Record<string, unknown>,
): ParsedChatEvent | null {
  const payloadTypeMap: Record<string, string> = {
    messagePayload: "MESSAGE",
    addedToSpacePayload: "ADDED_TO_SPACE",
    removedFromSpacePayload: "REMOVED_FROM_SPACE",
    buttonClickedPayload: "CARD_CLICKED",
  };

  let eventType = "UNKNOWN";
  let payload: Record<string, unknown> = {};

  for (const [key, type] of Object.entries(payloadTypeMap)) {
    if (chatData[key]) {
      eventType = type;
      payload = chatData[key] as Record<string, unknown>;
      break;
    }
  }

  if (eventType !== "MESSAGE") return null;

  const msg = (payload.message || {}) as Record<string, unknown>;
  const user = (chatData.user || msg.sender || {}) as Record<string, unknown>;
  const space = (payload.space || {}) as Record<string, unknown>;
  const thread = msg.thread as Record<string, unknown> | undefined;

  return {
    messageName: (msg.name as string) || "",
    senderName: (user.displayName as string) || "",
    senderEmail: (user.email as string) || "",
    text: ((msg.argumentText as string) || (msg.text as string) || "").trim(),
    threadName: (thread?.name as string) || null,
    spaceName: (space.name as string) || "",
    eventType,
    eventTime: (chatData.eventTime as string) || "",
  };
}

function parseTraditionalFormat(
  data: Record<string, unknown>,
): ParsedChatEvent | null {
  const eventType = (data.type as string) || "UNKNOWN";
  if (eventType !== "MESSAGE") return null;

  const msg = (data.message || {}) as Record<string, unknown>;
  const sender = (msg.sender || data.user || {}) as Record<string, unknown>;
  const space = (data.space || {}) as Record<string, unknown>;
  const thread = msg.thread as Record<string, unknown> | undefined;

  return {
    messageName: (msg.name as string) || "",
    senderName: (sender.displayName as string) || "",
    senderEmail: (sender.email as string) || "",
    text: ((msg.argumentText as string) || (msg.text as string) || "").trim(),
    threadName: (thread?.name as string) || null,
    spaceName: (space.name as string) || "",
    eventType,
    eventTime: (data.eventTime as string) || "",
  };
}

// =============================================================================
// Message Splitting
// =============================================================================

function splitMessage(
  text: string,
  maxLength = MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];

  const effectiveMax = maxLength - CONTINUATION_RESERVE;
  const chunks: string[] = [];
  let remaining = text;

  while (remaining) {
    if (remaining.length <= effectiveMax) {
      chunks.push(remaining);
      break;
    }
    const splitPos = findSplitPosition(remaining, effectiveMax);
    const chunk = remaining.slice(0, splitPos).trimEnd();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitPos).replace(/^\n+/, "");
  }

  const filtered = chunks.filter((c) => c.trim());

  if (filtered.length > 1) {
    return filtered.map((chunk, i) => {
      if (i < filtered.length - 1) {
        return `${chunk}\n\n(continued... ${i + 1}/${filtered.length})`;
      }
      return `(part ${i + 1}/${filtered.length})\n\n${chunk}`;
    });
  }

  return filtered;
}

function findSplitPosition(text: string, maxPos: number): number {
  const region = text.slice(0, maxPos);
  const hrPos = region.lastIndexOf("\n---\n");
  if (hrPos > 0) return hrPos + 1;
  const dnPos = region.lastIndexOf("\n\n");
  if (dnPos > 0) return dnPos + 1;
  const snPos = region.lastIndexOf("\n");
  if (snPos > 0) return snPos + 1;
  return maxPos;
}

// =============================================================================
// Retry with exponential backoff
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const err = error as { response?: { status?: number }; code?: number };
      const status = err?.response?.status || err?.code;

      if (
        status &&
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 429
      ) {
        throw error;
      }

      if (attempt === maxRetries) throw error;

      const delay =
        baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      console.error(
        `[googlechat] Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms (status: ${status})`,
      );
      await sleep(delay);
    }
  }
  throw new Error("Unreachable");
}

// =============================================================================
// Google Chat API
// =============================================================================

type ChatAPI = ReturnType<typeof google.chat>;
let chatApi: ChatAPI;

function initChatApi(): void {
  const auth = new GoogleAuth({
    keyFile: GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/chat.bot"],
  });
  chatApi = google.chat({ version: "v1", auth });
}

async function sendMessage(
  spaceName: string,
  text: string,
  threadName?: string | null,
  threadKey?: string | null,
): Promise<{ chunks: number; threadName?: string }> {
  const chunks = splitMessage(text);
  let resolvedThreadName: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const requestBody: {
      text: string;
      thread?: { name?: string; threadKey?: string };
    } = {
      text: chunks[i],
    };

    const useThread = !!(threadName || threadKey);
    if (threadName) {
      requestBody.thread = { name: threadName };
    } else if (threadKey) {
      requestBody.thread = { threadKey };
    }
    if (i > 0 && resolvedThreadName && !threadName) {
      requestBody.thread = { name: resolvedThreadName };
    }

    await retryWithBackoff(async () => {
      const res = await chatApi.spaces.messages.create({
        parent: spaceName,
        requestBody,
        ...(useThread
          ? {
              messageReplyOption:
                "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" as const,
            }
          : {}),
      });
      if (i === 0 && res.data?.thread?.name) {
        resolvedThreadName = res.data.thread.name;
      }
    });

    if (chunks.length > 1 && i < chunks.length - 1) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  return { chunks: chunks.length, threadName: resolvedThreadName };
}

// =============================================================================
// MCP Server
// =============================================================================

const server = new Server(
  { name: "googlechat", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: [
      "You are connected to Google Chat via the googlechat channel plugin.",
      "Messages from Google Chat users will appear as channel notifications.",
      "Use the 'reply' tool to send messages back to Google Chat.",
      "",
      "Important:",
      "- meta.chat_id contains the Google Chat space name (e.g., spaces/XXXXXXXXX)",
      "- meta.thread contains the thread name (if replying in a thread)",
      "- Always reply using the same chat_id from the incoming message",
      "- When your task is complete, always send a completion report via reply",
      "- Messages over 4096 characters are automatically split",
      "- To create a new thread, use thread_key with a unique identifier",
      "- The response includes the thread name for subsequent replies in the same thread",
    ].join("\n"),
  },
);

// =============================================================================
// Tool Definitions
// =============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a message to Google Chat. Use this to respond to users or report task completion.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description:
              "The Google Chat space name (e.g., \"spaces/XXXXXXXXX\"). Use meta.chat_id from the incoming message.",
          },
          text: {
            type: "string",
            description:
              "The message text to send. Messages over 4096 characters are automatically split.",
          },
          thread: {
            type: "string",
            description:
              "Optional thread name to reply in the same thread. Use meta.thread from the incoming message.",
          },
          thread_key: {
            type: "string",
            description:
              "Optional client-assigned thread key to create a new thread or reply to an existing one. Use a unique identifier. The response includes the thread name for subsequent replies.",
          },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

// =============================================================================
// Tool Handlers
// =============================================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "reply") {
    const chatId = (args as Record<string, unknown>).chat_id as string;
    const text = (args as Record<string, unknown>).text as string;
    const thread = (args as Record<string, unknown>).thread as
      | string
      | undefined;
    const threadKey = (args as Record<string, unknown>).thread_key as
      | string
      | undefined;

    if (!chatId || !text) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: chat_id and text are required",
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await sendMessage(chatId, text, thread, threadKey);
      const responseParts = [`Sent ${result.chunks} message(s) to ${chatId}`];
      if (result.threadName) {
        responseParts.push(`thread: ${result.threadName}`);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: responseParts.join("\n"),
          },
        ],
      };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text" as const,
            text: `Error sending message: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [
      { type: "text" as const, text: `Unknown tool: ${name}` },
    ],
    isError: true,
  };
});

// =============================================================================
// Pub/Sub Listener
// =============================================================================

function startPubSubListener(): void {
  const pubsub = new PubSub({ projectId: GCP_PROJECT_ID });
  const subscription = pubsub.subscription(PUBSUB_SUBSCRIPTION);

  subscription.on("message", (message: Message) => {
    try {
      const raw = message.data.toString("utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const attributes = (message.attributes || {}) as Record<string, string>;

      if (attributes["ce-type"]) {
        console.error(
          `[googlechat] Workspace Events format: ${attributes["ce-type"]}`,
        );
      }

      const parsed = parsePubSubMessage(data, attributes);

      if (!parsed) {
        message.ack();
        return;
      }

      if (!parsed.text) {
        message.ack();
        return;
      }

      // Access control
      const accessConfig = loadAccessConfig();
      const senderEmail = parsed.senderEmail;

      // If sender email is unavailable, reject unless policy is "open".
      // This prevents access control bypass when Workspace Events omits email.
      if (!senderEmail && accessConfig.policy !== "open") {
        console.error(
          "[googlechat] Access denied: sender email unavailable",
        );
        message.ack();
        return;
      }

      const accessResult = checkAccess(senderEmail, accessConfig);

      if (!accessResult.allowed) {
        if (
          accessResult.reason === "pairing_new" &&
          accessResult.pairingCode
        ) {
          // Send pairing code to the user via Google Chat
          console.error(
            `[googlechat] Pairing request from ${senderEmail}, code: ${accessResult.pairingCode}`,
          );
          sendMessage(
            parsed.spaceName,
            `To connect, run the following command in Claude Code:\n/googlechat:access pair ${accessResult.pairingCode}`,
            parsed.threadName,
          ).catch((err) =>
            console.error(
              `[googlechat] Failed to send pairing message: ${err}`,
            ),
          );
        } else if (accessResult.reason !== "pairing_pending") {
          console.error(
            `[googlechat] Access denied for ${senderEmail}: ${accessResult.reason}`,
          );
        }
        message.ack();
        return;
      }

      console.error(
        `[googlechat] ${parsed.senderName} (${parsed.senderEmail}): ${parsed.text.slice(0, 100)}`,
      );

      server.notification({
        method: "notifications/claude/channel" as const,
        params: {
          content: parsed.text,
          meta: {
            chat_id: parsed.spaceName,
            message_id: parsed.messageName,
            user: parsed.senderName,
            user_id: parsed.senderEmail,
            thread: parsed.threadName,
            ts: parsed.eventTime,
          },
        },
      });

      message.ack();
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : String(error);
      console.error(`[googlechat] Parse error: ${msg}`);
      message.nack();
    }
  });

  subscription.on("error", (error: Error) => {
    console.error(`[googlechat] Pub/Sub error: ${error.message}`);
  });

  subscription.on("close", () => {
    console.error("[googlechat] Pub/Sub subscription CLOSED");
  });

  // Periodic health check
  setInterval(() => {
    console.error(`[googlechat] heartbeat: isOpen=${subscription.isOpen}`);
  }, 30000);

  console.error(
    `[googlechat] Listening on ${GCP_PROJECT_ID}/${PUBSUB_SUBSCRIPTION}`,
  );
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  validateConfig();
  initChatApi();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[googlechat] Channel plugin started");

  // Start Pub/Sub listener by default (disable with DISABLE_PUBSUB=1)
  if (process.env.DISABLE_PUBSUB !== "1") {
    startPubSubListener();
  } else {
    console.error(
      "[googlechat] Pub/Sub listener disabled (DISABLE_PUBSUB=1)",
    );
  }
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[googlechat] Fatal: ${msg}`);
  process.exit(1);
});
