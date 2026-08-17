import { logger } from "./logger.js";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(message, statusCode, errors = null, status = null) {
    super(message);
    this.statusCode = statusCode;
    this.status =
      status || (`${statusCode}`.startsWith("4") ? "fail" : "error");
    this.isOperational = true;
    if (errors) {
      this.errors = errors;
    }

    Error.captureStackTrace(this, this.constructor);
  }
}

export const asyncHandler = (fn) => {
  return (req, res, next) => {
    return fn(req, res, next).catch(next);
  };
};

const handleZodError = (err) => {
  console.log("zod error", err)
  const errors = err.errors.map((e) => ({
    field: e.path.join("."),
    message: e.message,
  }));
  return new AppError(`Validation failed: ${JSON.stringify(errors)}`, 400);
};

const handleCastErrorDB = (err) => {
  const message = `Invalid ${err.path}: ${err.value}.`;
  return new AppError(message, 400);
};

const handleDuplicateFieldsDB = (err) => {
  const value = err.errmsg?.match(/(["'])(\\?.)*?\1/)[0] || "field";
  const message = value.includes("username")
    ? "Username already exists. Please choose another username."
    : value.includes("email")
      ? "Email already exists. Please use another email."
      : `Duplicate field value: ${value}. Please use another value!`;
  return new AppError(message, 400);
};

const handleValidationErrorDB = (err) => {
  const errors = Object.values(err.errors).map((el) => el.message);
  const message = `Invalid input data. ${errors.join(". ")}`;
  return new AppError(message, 400);
};

const handleJWTError = () =>
  new AppError("Invalid token. Please log in again!", 401);

const handleJWTExpiredError = () =>
  new AppError("Your token has expired! Please log in again.", 401);

const sendErrorDev = (err, req, res) => {
  console.error(`❌ [API ERROR ${err.statusCode || 500}] ${req.method} ${req.originalUrl}: ${err.message}`);
  const response = {
    success: false,
    status: err.status,
    message: err.message,
    stack: err.stack,
  };
  if (err.errors) {
    response.errors = err.errors;
  }
  return res.status(err.statusCode).json(response);
};

const sendErrorProd = (err, req, res) => {
  if (err.isOperational) {
    const response = {
      success: false,
      status: err.status,
      message: err.message,
    };
    if (err.errors) {
      response.errors = err.errors;
    }
    return res.status(err.statusCode).json(response);
  }
  // Programming or other unknown error: don't leak details
  logger.error("ERROR 💥", err);
  return res.status(500).json({
    success: false,
    status: "error",
    message: "Something went very wrong!",
  });
};

export const globalErrorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  if (process.env.NODE_ENV === "development") {
    sendErrorDev(err, req, res);
  } else {
    let error = Object.assign(err);
    error.message = err.message;

    if (error instanceof ZodError) error = handleZodError(error);
    if (error.name === "CastError") error = handleCastErrorDB(error);
    if (error.code === 11000) error = handleDuplicateFieldsDB(error);
    if (error.name === "ValidationError")
      error = handleValidationErrorDB(error);
    if (error.name === "JsonWebTokenError") error = handleJWTError();
    if (error.name === "TokenExpiredError") error = handleJWTExpiredError();

    sendErrorProd(error, req, res);
  }
};
