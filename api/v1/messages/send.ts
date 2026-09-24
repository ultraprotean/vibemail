import { preflight, route } from '../../../src/http/app';
import { sendMessageHandler } from '../../../src/http/handlers';

/** POST /api/v1/messages/send — send through Gmail (CONTRACT.md §6.4). JWT required. */
export const POST = route(sendMessageHandler);
export const OPTIONS = preflight(['POST']);
