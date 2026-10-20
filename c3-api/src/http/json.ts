import { ApiError } from './errors.js';

/*
 * Bounded JSON request and response handling.
 *
 * Every administrative body is small, so the reader refuses anything larger
 * rather than buffering whatever a client sends, and answers that with 413:
 * the body is not malformed, there is too much of it. It accepts only a JSON
 * object: an array or a bare value is never a valid command.
 */
const MAX_BODY_BYTES = 64 * 1024;

const DECODER = new TextDecoder();

function tooLarge(maxBytes: number): ApiError {
  return new ApiError('PAYLOAD_TOO_LARGE', `the request body exceeds ${maxBytes} bytes`);
}

/*
 * The body as text, read no further than the bound. A chunked body declares
 * no length, so its bytes are counted as they arrive and the read stops at
 * the first chunk past the bound, rather than buffering whatever was sent and
 * measuring it afterwards.
 */
async function boundedText(request: Request, maxBytes: number): Promise<string> {
  if (request.body === null) {
    return '';
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value as Uint8Array;
    received += chunk.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(maxBytes);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return DECODER.decode(bytes);
}

/*
 * A media type with the +json suffix (RFC 6839): a type and a subtype, each a
 * token (RFC 9110), with a name in the subtype before the suffix.
 */
const JSON_SUFFIXED = /^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+\+json$/;

async function readJsonObject(
  request: Request,
  { maxBytes = MAX_BODY_BYTES }: { maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  /*
   * A media type is compared in any case (RFC 9110). JSON is application/json
   * or a type with the +json suffix (RFC 6839), and a body without a type is
   * read as JSON too.
   */
  const contentType = request.headers.get('content-type') ?? '';
  const mediaType   = contentType.split(';')[0]!.trim().toLowerCase();
  if (contentType !== '' && mediaType !== 'application/json' && !JSON_SUFFIXED.test(mediaType)) {
    throw new ApiError('BAD_REQUEST', `the request body must be JSON`);
  }

  // a declared length past the bound is refused before a byte of it is read
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(maxBytes);
  }

  const body = await boundedText(request, maxBytes);
  // an absent body is an empty command, which several admin routes accept
  if (body.trim().length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApiError('BAD_REQUEST', `the request body is not valid JSON`);
  }
  if (typeof(parsed) !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError('BAD_REQUEST', `the request body must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function jsonResponse(
  body: unknown,
  { status = 200, headers = {} }: { status?: number, headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export { MAX_BODY_BYTES, jsonResponse, readJsonObject };
