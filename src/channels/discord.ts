import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getLastMessageTime?: (chatJid: string) => string | undefined;
}

// Discord snowflake IDs embed a millisecond timestamp relative to this epoch
const DISCORD_EPOCH_MS = 1420070400000n;
const BACKFILL_PAGE_SIZE = 100;
const BACKFILL_MAX_PAGES = 3;

function snowflakeFromTimestamp(ms: number): string {
  return ((BigInt(ms) - DISCORD_EPOCH_MS) << 22n).toString();
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private initialBackfillDone = false;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, (message: Message) =>
      this.handleMessage(message).catch((err) =>
        logger.error({ err }, 'Failed to handle Discord message'),
      ),
    );

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    // Gateway connection state — a resume replays missed events, but a fresh
    // identify does not, so messages sent during the gap must be fetched.
    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      logger.warn(
        { code: event.code, shardId },
        'Discord gateway disconnected',
      );
    });
    this.client.on(Events.ShardReconnecting, (shardId) => {
      logger.info({ shardId }, 'Discord gateway reconnecting');
    });
    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      logger.info({ shardId, replayedEvents }, 'Discord gateway resumed');
    });
    this.client.on(Events.ShardReady, (shardId) => {
      // The first identify is covered by the ClientReady backfill below
      if (!this.initialBackfillDone) return;
      logger.info({ shardId }, 'Discord gateway re-identified');
      this.backfillMissedMessages().catch((err) =>
        logger.warn({ err }, 'Discord backfill failed'),
      );
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        // Recover messages posted while the bot was offline before resolving,
        // so startup recovery sees them.
        try {
          await this.backfillMissedMessages();
        } catch (err) {
          logger.warn({ err }, 'Discord backfill failed');
        }
        this.initialBackfillDone = true;
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  /**
   * Fetch messages posted to registered channels since the last one we stored.
   * The gateway only delivers live events, so anything sent while the bot was
   * down or between gateway sessions would otherwise never be seen.
   */
  private async backfillMissedMessages(): Promise<void> {
    if (!this.client || !this.opts.getLastMessageTime) return;

    for (const jid of Object.keys(this.opts.registeredGroups())) {
      if (!this.ownsJid(jid)) continue;

      // No stored history means there is no gap to fill
      const lastTime = this.opts.getLastMessageTime(jid);
      const lastMs = lastTime ? Date.parse(lastTime) : NaN;
      if (Number.isNaN(lastMs)) continue;

      try {
        const channel = await this.client.channels.fetch(
          jid.replace(/^dc:/, ''),
        );
        if (!channel || !('messages' in channel)) continue;

        let after = snowflakeFromTimestamp(lastMs);
        let recovered = 0;
        let truncated = false;

        for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
          const batch = await (channel as TextChannel).messages.fetch({
            after,
            limit: BACKFILL_PAGE_SIZE,
          });
          const ordered = [...batch.values()].sort(
            (a, b) => a.createdTimestamp - b.createdTimestamp,
          );
          for (const missed of ordered) {
            if (missed.createdTimestamp <= lastMs || missed.author.bot) {
              continue;
            }
            await this.handleMessage(missed);
            recovered++;
          }
          if (batch.size < BACKFILL_PAGE_SIZE) break;
          after = ordered[ordered.length - 1].id;
          truncated = page === BACKFILL_MAX_PAGES - 1;
        }

        if (recovered > 0) {
          logger.info(
            { jid, recovered, truncated },
            'Discord backfill recovered missed messages',
          );
        }
      } catch (err) {
        logger.warn({ jid, err }, 'Discord backfill failed for channel');
      }
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages (including own)
    if (message.author.bot) return;

    const channelId = message.channelId;
    const chatJid = `dc:${channelId}`;
    let content = message.content;
    const timestamp = message.createdAt.toISOString();
    const senderName =
      message.member?.displayName ||
      message.author.displayName ||
      message.author.username;
    const sender = message.author.id;
    const msgId = message.id;

    // Determine chat name
    let chatName: string;
    if (message.guild) {
      const textChannel = message.channel as TextChannel;
      chatName = `${message.guild.name} #${textChannel.name}`;
    } else {
      chatName = senderName;
    }

    // Translate Discord @bot mentions into TRIGGER_PATTERN format.
    // Discord mentions look like <@botUserId> — these won't match
    // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
    // when the bot is @mentioned.
    let isBotMentioned = false;
    if (this.client?.user) {
      const botId = this.client.user.id;
      isBotMentioned =
        message.mentions.users.has(botId) ||
        content.includes(`<@${botId}>`) ||
        content.includes(`<@!${botId}>`);

      if (isBotMentioned) {
        // Strip the <@botId> mention to avoid visual clutter
        content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
      }
    }

    // Handle attachments — store placeholders so the agent knows something was sent
    if (message.attachments.size > 0) {
      const attachmentDescriptions = [...message.attachments.values()].map(
        (att) => {
          const contentType = att.contentType || '';
          if (contentType.startsWith('image/')) {
            return `[Image: ${att.name || 'image'}]`;
          } else if (contentType.startsWith('video/')) {
            return `[Video: ${att.name || 'video'}]`;
          } else if (contentType.startsWith('audio/')) {
            return `[Audio: ${att.name || 'audio'}]`;
          } else {
            return `[File: ${att.name || 'file'}]`;
          }
        },
      );
      if (content) {
        content = `${content}\n${attachmentDescriptions.join('\n')}`;
      } else {
        content = attachmentDescriptions.join('\n');
      }
    }

    // Handle reply context — include who the user is replying to
    if (message.reference?.messageId) {
      try {
        const repliedTo = await message.channel.messages.fetch(
          message.reference.messageId,
        );
        const replyAuthor =
          repliedTo.member?.displayName ||
          repliedTo.author.displayName ||
          repliedTo.author.username;
        content = `[Reply to ${replyAuthor}] ${content}`;
      } catch {
        // Referenced message may have been deleted
      }
    }

    // Prepend the trigger last so it stays at the start of the content —
    // the reply prefix above would otherwise push it out of TRIGGER_PATTERN.
    if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Store chat metadata for discovery
    const isGroup = message.guild !== null;
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'discord', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Discord channel',
      );
      return;
    }

    // Deliver message — startMessageLoop() will pick it up
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Discord message stored',
    );
  }

  private wrapMarkdownTables(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    let tableLines: string[] = [];

    const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);

    for (const line of lines) {
      if (isTableRow(line)) {
        tableLines.push(line);
      } else {
        if (tableLines.length > 0) {
          result.push('```');
          result.push(...tableLines);
          result.push('```');
          tableLines = [];
        }
        result.push(line);
      }
    }

    if (tableLines.length > 0) {
      result.push('```');
      result.push(...tableLines);
      result.push('```');
    }

    return result.join('\n');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Wrap markdown tables in code blocks for proper Discord rendering
      const formatted = this.wrapMarkdownTables(text);

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (formatted.length <= MAX_LENGTH) {
        await textChannel.send(formatted);
      } else {
        for (let i = 0; i < formatted.length; i += MAX_LENGTH) {
          await textChannel.send(formatted.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
