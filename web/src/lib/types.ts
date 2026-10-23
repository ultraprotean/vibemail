/** Mirrors CONTRACT.md §6. Nothing here is invented: see docs/DESIGN_SPEC.md "Contract names". */

/** One message as returned by `GET /api/v1/messages` (§6.3). */
export interface Message {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string | null;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  isRead: boolean;
  /** ISO 8601 timestamp. */
  receivedAt: string;
}

export interface MessagePage {
  messages: Message[];
  nextCursor: string | null;
}

export interface ListParams {
  cursor?: string | null;
  limit?: number;
  unreadOnly?: boolean;
}

/** `POST /api/v1/messages/send` request body (§6.4). No attachments. */
export interface SendRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  threadId?: string;
}

export interface SendResponse {
  id: string;
  threadId: string;
  status: 'sent';
}

/** `PATCH /api/v1/messages/:id/read` response (§6.5). */
export interface ReadResponse {
  id: string;
  isRead: boolean;
}

export interface ApiClient {
  listMessages(params: ListParams): Promise<MessagePage>;
  sendMessage(request: SendRequest): Promise<SendResponse>;
  setReadState(id: string, isRead: boolean): Promise<ReadResponse>;
}
