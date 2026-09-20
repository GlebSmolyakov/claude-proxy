// Errors in the shapes OpenAI and Anthropic return them.

/** A failed turn; `status` is the HTTP status to answer with. */
export interface TurnError {
  status: number;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }

  static badRequest(message: string): AppError {
    return new AppError(400, message);
  }

  static notFound(message: string): AppError {
    return new AppError(404, message, "not_found");
  }

  static tooLarge(message: string): AppError {
    return new AppError(413, message);
  }

  static internal(message: string): AppError {
    return new AppError(500, message);
  }

  /** The CLI or the API behind it failed. A status that is not one falls back to 502. */
  static upstream(error: TurnError): AppError {
    const valid = Number.isInteger(error.status) && error.status >= 100 && error.status <= 999;
    return new AppError(valid ? error.status : 502, error.message);
  }

  /** `{"error": {"message", "type", "code"}}`, as OpenAI returns it. */
  openaiBody(): object {
    const s = this.status;
    const type =
      s === 429
        ? "rate_limit_error"
        : s === 401 || s === 403
          ? "authentication_error"
          : s === 504
            ? "timeout"
            : s >= 400 && s <= 499
              ? "invalid_request_error"
              : "server_error";
    return { error: { message: this.message, type, code: this.code } };
  }

  /** `{"type": "error", "error": {"type", "message"}}`, as Anthropic returns it. */
  anthropicBody(): object {
    const named: Record<number, string> = {
      401: "authentication_error",
      403: "permission_error",
      404: "not_found_error",
      413: "request_too_large",
      429: "rate_limit_error",
      529: "overloaded_error",
    };
    const s = this.status;
    const type = named[s] ?? (s >= 400 && s <= 499 ? "invalid_request_error" : "api_error");
    return { type: "error", error: { type, message: this.message } };
  }
}
