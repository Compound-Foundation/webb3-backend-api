import type { NotServed } from '../../lib/json-rpc.js';

/*
 * Typed HTTP errors with one JSON envelope.
 *
 * A handler throws one of these; the router turns it into a response. An
 * error the handler did not anticipate becomes a sanitized 500 instead of the
 * message it carried, so an upstream body, a D1 error, or a secret cannot
 * reach a client through an unhandled throw.
 */
type ApiErrorCode = (
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'REGISTRY_NOT_ACTIVE'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL'
);

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST:          400,
  UNAUTHORIZED:         401,
  FORBIDDEN:            403,
  NOT_FOUND:            404,
  METHOD_NOT_ALLOWED:   405,
  CONFLICT:             409,
  PAYLOAD_TOO_LARGE:    413,
  UNPROCESSABLE:        422,
  RATE_LIMITED:         429,
  REGISTRY_NOT_ACTIVE:  503,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL:             500,
};

class ApiError extends Error {
  readonly code:    ApiErrorCode;
  readonly status:  number;
  readonly details: Record<string, unknown> | undefined;
  /*
   * Headers the response must carry for this error to mean what it says. A
   * 405 without `Allow` tells a client the verb is wrong but not which verb
   * is right, which is half an answer.
   */
  readonly headers: Record<string, string>;
  /*
   * What the line logged about this answer says besides, and the client is
   * never told: which entry of a setting is wrong, or whose token was
   * refused. Never a token, its digest or a secret.
   */
  readonly logged:  Record<string, unknown> | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
    headers: Record<string, string> = {},
    logged?: Record<string, unknown>,
  ) {
    super(message);
    this.name    = 'ApiError';
    this.code    = code;
    this.status  = STATUS[code];
    this.details = details;
    this.headers = headers;
    this.logged  = logged;
  }
}

function methodNotAllowed(method: string, pathname: string, allowed: string[]): ApiError {
  const allow = allowed.join(', ');
  return new ApiError(
    'METHOD_NOT_ALLOWED',
    `${method} is not allowed on ${pathname}`,
    { allowed },
    { 'Allow': allow },
  );
}

/*
 * The answer to a request a node provider did not serve, on every route of the
 * registry: worth trying again, after as long as the node provider proxy
 * asked, when it said.
 */
function nodeUnavailable(error: NotServed): ApiError {
  const retryAfter: Record<string, string> = error.retryAfter === null ? {} : { 'Retry-After': String(error.retryAfter) };
  return new ApiError('UPSTREAM_UNAVAILABLE', `a node provider did not answer`, undefined, retryAfter);
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/*
 * The error envelope. `requestId` lets an operator correlate a client report
 * with the logs; `details` appears only when a handler chose to explain the
 * failure, never from an error it did not construct.
 */
function errorBody(error: ApiError, requestId: string): Record<string, unknown> {
  return {
    error: {
      code:      error.code,
      message:   error.message,
      requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

/*
 * The one shape every error answer of the registry takes, whichever of its
 * routers answers it: the envelope as JSON, with the headers the error needs
 * to mean what it says.
 */
function errorResponse(error: ApiError, requestId: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(errorBody(error, requestId)), {
    status:  error.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers, ...error.headers },
  });
}

type FailureLog = {
  error: (...parameters: unknown[]) => unknown,
  warn:  (...parameters: unknown[]) => unknown,
};

/*
 * The answer to a request that failed, and the log line an operator finds it
 * by, under the same request id.
 *
 * `answer` is what the route decided to say, or null when it raised something
 * it did not anticipate: the client is then told INTERNAL and the request id,
 * never the message the failure carried, and the log has the whole of it.
 *
 * What is logged is what somebody has to act on: an answer the API could not
 * give, and a request refused for its credentials, which may be somebody
 * probing. A client's own mistake is the client's to read in the answer.
 */
function failureResponse(
  answer: ApiError | null,
  failure: unknown,
  { requestId, pathname, debug, label, headers = {} }: {
    requestId: string,
    pathname:  string,
    debug:     FailureLog,
    // what the log line says failed, such as the router that answered
    label:     string,
    headers?:  Record<string, string>,
  },
): Response {
  const error = answer ?? new ApiError('INTERNAL', `the request could not be completed`);
  if (error.status >= 500) {
    debug.error(`${label} failed`, { requestId, pathname, status: error.status, code: error.code, ...error.logged, error: failure });
  } else if (error.status === 401 || error.status === 403) {
    debug.warn(`${label} refused`, { requestId, pathname, status: error.status, code: error.code, ...error.logged });
  }
  return errorResponse(error, requestId, headers);
}

export type { ApiErrorCode, FailureLog };
export { ApiError, failureResponse, isApiError, methodNotAllowed, nodeUnavailable };
