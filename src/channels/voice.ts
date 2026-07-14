import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { logger } from '../logger.js';

const DEFAULT_BRIDGE_URL = 'ws://localhost:3500/nanoclaw';

/** Maximum reconnect delay in milliseconds (30 seconds). */
const MAX_RECONNECT_DELAY_MS = 30_000;

interface BridgeUserMessage {
  type: 'user_message';
  text: string;
  session_id: string;
}

interface BridgeAgentResponse {
  type: 'agent_response';
  text: string;
  session_id: string;
}

interface BridgeAgentTyping {
  type: 'agent_typing';
  session_id: string;
  typing: boolean;
}

interface BridgeAgentError {
  type: 'agent_error';
  session_id: string;
  error: string;
}

type BridgeOutbound =
  | BridgeAgentResponse
  | BridgeAgentTyping
  | BridgeAgentError;

export class VoiceChannel implements Channel {
  name = 'voice';

  private ws: WebSocket | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private bridgeUrl: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    this.bridgeUrl = process.env.BRIDGE_WS_URL || DEFAULT_BRIDGE_URL;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.shouldReconnect = true;
      this.connectInternal(resolve);
    });
  }

  private connectInternal(onFirstOpen?: () => void): void {
    logger.info({ url: this.bridgeUrl }, 'Voice channel connecting to bridge');

    const ws = new WebSocket(this.bridgeUrl);

    ws.addEventListener('open', () => {
      this.ws = ws;
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info('Voice channel connected to bridge');

      if (onFirstOpen) {
        onFirstOpen();
      }
    });

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(
          typeof event.data === 'string' ? event.data : String(event.data),
        ) as BridgeUserMessage;

        if (data.type !== 'user_message') {
          logger.debug(
            { type: data.type },
            'Voice channel ignoring non-user message',
          );
          return;
        }

        if (!data.text) {
          logger.debug('Voice channel ignoring empty message');
          return;
        }

        const sessionId = data.session_id || 'main';
        const jid = `voice:${sessionId}`;
        const timestamp = new Date().toISOString();

        // Notify NanoClaw about this chat
        this.opts.onChatMetadata(
          jid,
          timestamp,
          'Voice Session',
          'voice',
          false,
        );

        // Deliver the message into NanoClaw's message loop
        const message: NewMessage = {
          id: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: jid,
          sender: 'voice-user',
          sender_name: 'Chris',
          content: data.text,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        };

        this.opts.onMessage(jid, message);
        logger.info(
          { jid, length: data.text.length },
          'Voice message delivered to NanoClaw',
        );
      } catch (err) {
        logger.error({ err }, 'Voice channel failed to parse bridge message');
      }
    });

    ws.addEventListener('close', (event) => {
      this.connected = false;
      this.ws = null;
      logger.info(
        { code: event.code, reason: event.reason },
        'Voice channel disconnected from bridge',
      );

      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });

    ws.addEventListener('error', (event) => {
      // The error event fires before close on connection failure.
      // Avoid noisy logs — close handler will trigger reconnect.
      logger.debug({ event }, 'Voice channel WebSocket error');
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const sessionId = jid.replace('voice:', '') || 'main';
    const payload: BridgeAgentResponse = {
      type: 'agent_response',
      text,
      session_id: sessionId,
    };

    this.sendToBridge(payload);
    logger.info({ jid, length: text.length }, 'Voice response sent to bridge');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('voice:');
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    logger.info('Voice channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const sessionId = jid.replace('voice:', '') || 'main';
    const payload: BridgeAgentTyping = {
      type: 'agent_typing',
      session_id: sessionId,
      typing: isTyping,
    };
    this.sendToBridge(payload);
  }

  private sendToBridge(payload: BridgeOutbound): void {
    if (!this.ws || !this.connected) {
      logger.warn('Voice channel not connected, dropping outbound message');
      return;
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      logger.error({ err }, 'Voice channel failed to send to bridge');
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at MAX_RECONNECT_DELAY_MS
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts++;

    logger.info(
      { delay, attempt: this.reconnectAttempts },
      'Voice channel scheduling reconnect',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectInternal();
    }, delay);
  }
}

registerChannel('voice', (opts: ChannelOpts) => {
  if (process.env.VOICE_CHANNEL_ENABLED !== 'true') return null;
  return new VoiceChannel(opts);
});
