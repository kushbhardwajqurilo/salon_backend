/**
 * Sends a standardized API response.
 * @param {Object} res - Express response object
 * @param {Number} statusCode - HTTP status code
 * @param {String} message - Response message
 * @param {Object|Array|null} data - Payload data
 * @param {Object|null} meta - Pagination metadata or additional stats
 */
export const sendResponse = (res, statusCode, message, data = null, meta = null) => {
  const status = `${statusCode}`.startsWith("2") ? "success" : "fail";
  return res.status(statusCode).json({
    status,
    message,
    data,
    meta,
  });
};
