import { ZodError } from "zod";
import { ApiError } from "../utils/ApiError.js";

// Postgres SQLSTATE -> HTTP. Raw database messages never reach the client.
const PG_ERRORS = {
  23505: [409, "Already exists"],
  23503: [400, "Referenced record does not exist"],
  23514: [400, "Value not allowed"],
  "22P02": [400, "Invalid identifier or value"],
  42501: [403, "Not allowed"],
};

const toApiError = (err) => {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    const issues = err.issues.map(({ path, message }) => ({
      field: path.join("."),
      message,
    }));
    return new ApiError(400, "Validation failed", issues);
  }
  if (PG_ERRORS[err.code]) return new ApiError(...PG_ERRORS[err.code]);
  if (err.status >= 400 && err.status < 500)
    return new ApiError(err.status, err.expose ? err.message : "Bad request");

  console.error(err);
  return new ApiError(500, "Internal server error");
};

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
const errorHandler = (err, req, res, next) => {
  const { statusCode, message, errors } = toApiError(err);
  res.status(statusCode).json({ statusCode, success: false, message, errors });
};

export { errorHandler };
