// Server-Sent Events, both directions: the server encodes events, the page parses them from a
// fetch() body. (The browser's EventSource can't send an Authorization header, so the page reads
// the stream itself.) No Node or DOM imports: this file runs on the server and in the browser.

export interface SseEvent {
  event: string;
  data: string;
}

/** One event on the wire. JSON never contains a raw newline, so the data fits on one line. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A comment line. Clients ignore it; it keeps proxies from closing a quiet connection. */
export const SSE_PING = ': ping\n\n';

/**
 * Parses a text/event-stream fed in arbitrary chunks. Call `push` with each decoded chunk;
 * `onEvent` fires once per complete event. Handles events split across chunks, \r\n line
 * ends, multi-line data, and comment lines.
 */
export function createSseParser(onEvent: (event: SseEvent) => void) {
  let buffer = '';
  let event = '';
  let data: string[] = [];

  function line(text: string) {
    if (text === '') {
      // A blank line ends the event. Events without data (only comments) are dropped.
      if (data.length) onEvent({ event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return; // comment
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end === -1) break;
        let text = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (text.endsWith('\r')) text = text.slice(0, -1);
        line(text);
      }
    },
  };
}
